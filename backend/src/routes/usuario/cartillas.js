const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');
const { generarCartillaPDF } = require('../../services/cartilla-pdf');

// ─── GET /api/usuario/cartillas/:asignacion_id ───────────────────
// Retorna el estado de la cartilla + datos del rodeo + perfil jurado
router.get('/:asignacion_id', async (req, res) => {
    const uid   = req.usuario.id;
    const asigId = req.params.asignacion_id;

    // Verificar que la asignación pertenece al usuario
    const { data: asig, error: asigErr } = await supabase
        .from('asignaciones')
        .select('id, rodeo_id, estado, estado_designacion, usuario_pagado_id')
        .eq('id', asigId)
        .eq('usuario_pagado_id', uid)
        .eq('estado', 'activo')
        .single();

    if (asigErr || !asig) return res.status(404).json({ error: 'Asignación no encontrada' });
    if (asig.estado_designacion === 'rechazado') {
        return res.status(403).json({ error: 'No disponible para designación rechazada' });
    }

    // Rodeo
    const { data: rodeo } = await supabase
        .from('rodeos')
        .select('id, club, asociacion, fecha, duracion_dias, tipo_rodeo_nombre')
        .eq('id', asig.rodeo_id)
        .single();

    // Perfil usuario
    const { data: perfil } = await supabase
        .from('usuarios_pagados')
        .select('nombre_completo, rut, categoria, tipo_persona')
        .eq('id', uid)
        .single();

    // Buscar delegado rentado asignado al mismo rodeo (puede no existir)
    let delegado = null;
    const { data: asigsDelegado } = await supabase
        .from('asignaciones')
        .select('usuario_pagado_id')
        .eq('rodeo_id', asig.rodeo_id)
        .eq('estado', 'activo')
        .neq('usuario_pagado_id', uid);

    if (asigsDelegado && asigsDelegado.length > 0) {
        const ids = asigsDelegado.map(a => a.usuario_pagado_id);
        const { data: delPerfil } = await supabase
            .from('usuarios_pagados')
            .select('nombre_completo, telefono')
            .eq('tipo_persona', 'delegado_rentado')
            .in('id', ids)
            .limit(1)
            .maybeSingle();
        if (delPerfil) delegado = delPerfil;
    }

    // Cartilla existente (puede no existir aún)
    const { data: cartilla } = await supabase
        .from('cartillas_jurado')
        .select('*')
        .eq('asignacion_id', asigId)
        .maybeSingle();

    res.json({
        asignacion_id: asigId,
        rodeo,
        perfil,
        delegado,
        cartilla: cartilla || null
    });
});

// ─── PUT /api/usuario/cartillas/:asignacion_id ───────────────────
// Guarda borrador (upsert). Solo disponible si estado != 'enviada'
router.put('/:asignacion_id', async (req, res) => {
    const uid    = req.usuario.id;
    const asigId = req.params.asignacion_id;
    const datos  = req.body.datos || {};

    // Verificar asignación
    const { data: asig } = await supabase
        .from('asignaciones')
        .select('id, rodeo_id, estado_designacion')
        .eq('id', asigId)
        .eq('usuario_pagado_id', uid)
        .eq('estado', 'activo')
        .single();

    if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });
    if (asig.estado_designacion === 'rechazado') {
        return res.status(403).json({ error: 'Sin permiso' });
    }

    // Verificar que no esté ya enviada
    const { data: existente } = await supabase
        .from('cartillas_jurado')
        .select('id, estado')
        .eq('asignacion_id', asigId)
        .maybeSingle();

    if (existente?.estado === 'enviada') {
        return res.status(409).json({ error: 'La cartilla ya fue enviada y no puede modificarse' });
    }

    const payload = {
        asignacion_id:     asigId,
        rodeo_id:          asig.rodeo_id,
        usuario_pagado_id: uid,
        estado:            'borrador',
        datos,
        updated_at:        new Date().toISOString()
    };

    let result;
    if (existente) {
        const { data, error } = await supabase
            .from('cartillas_jurado')
            .update(payload)
            .eq('id', existente.id)
            .select().single();
        if (error) return res.status(500).json({ error: error.message });
        result = data;
    } else {
        const { data, error } = await supabase
            .from('cartillas_jurado')
            .insert(payload)
            .select().single();
        if (error) return res.status(500).json({ error: error.message });
        result = data;
    }

    res.json({ mensaje: 'Borrador guardado', cartilla: result });
});

// ─── POST /api/usuario/cartillas/:asignacion_id/enviar ───────────
// Valida, genera PDF, sube a Storage, inserta en rodeo_adjuntos, marca enviada
router.post('/:asignacion_id/enviar', async (req, res) => {
    const uid    = req.usuario.id;
    const asigId = req.params.asignacion_id;

    // Verificar asignación
    const { data: asig } = await supabase
        .from('asignaciones')
        .select('id, rodeo_id, estado_designacion')
        .eq('id', asigId)
        .eq('usuario_pagado_id', uid)
        .eq('estado', 'activo')
        .single();

    if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });
    if (asig.estado_designacion === 'rechazado') {
        return res.status(403).json({ error: 'Sin permiso' });
    }

    // Verificar que no esté ya enviada
    const { data: cartilla } = await supabase
        .from('cartillas_jurado')
        .select('*')
        .eq('asignacion_id', asigId)
        .maybeSingle();

    if (cartilla?.estado === 'enviada') {
        return res.status(409).json({ error: 'La cartilla ya fue enviada' });
    }

    // Si se envía con datos nuevos (puede venir en body), guardarlos primero
    const datosEnvio = req.body.datos || cartilla?.datos || {};

    // Validación campos siempre requeridos
    const siempre = ['hora_inicio', 'serie_campeones_2_vueltas', 'hubo_faltas', 'hubo_ganado_fuera_peso', 'hubo_movimiento_rienda', 'caseta_adecuada'];
    const faltantes = siempre.filter(k => datosEnvio[k] === undefined || datosEnvio[k] === null || datosEnvio[k] === '');
    if (faltantes.length > 0) {
        return res.status(422).json({ error: `Faltan campos requeridos: ${faltantes.join(', ')}`, faltantes });
    }

    // Validaciones condicionales
    if (datosEnvio.hubo_ganado_fuera_peso === 'si') {
        if (!datosEnvio.clasificacion_peso) {
            return res.status(422).json({ error: 'Debe seleccionar la clasificación de ganado fuera de peso.' });
        }
        if (!datosEnvio.filas_ganado || datosEnvio.filas_ganado.length === 0) {
            return res.status(422).json({ error: 'Debe registrar al menos una serie en la tabla de ganado fuera de peso.' });
        }
    }
    if (datosEnvio.hubo_faltas === 'si' && !datosEnvio.descripcion_faltas?.trim()) {
        return res.status(422).json({ error: 'Debe describir las faltas disciplinarias o reglamentarias.' });
    }
    if (datosEnvio.hubo_movimiento_rienda === 'si') {
        const registros = datosEnvio.registros_rienda || [];
        if (registros.length === 0) {
            return res.status(422).json({ error: 'Debe registrar al menos un movimiento a la rienda.' });
        }
        const incompleto = registros.find(r => !r.nombre_socio?.trim() || !r.nombre_equino?.trim());
        if (incompleto) {
            return res.status(422).json({ error: 'Todos los registros de movimiento a la rienda deben tener nombre del socio y nombre del equino.' });
        }
    }

    // Cargar rodeo y perfil para el PDF
    const [{ data: rodeo }, { data: perfil }] = await Promise.all([
        supabase.from('rodeos').select('id, club, asociacion, fecha, duracion_dias, tipo_rodeo_nombre').eq('id', asig.rodeo_id).single(),
        supabase.from('usuarios_pagados').select('nombre_completo, rut, categoria, tipo_persona').eq('id', uid).single()
    ]);

    const ahora = new Date().toISOString();
    const cartillaParaPDF = { datos: datosEnvio, enviada_en: ahora };

    // Generar PDF
    let pdfBuffer;
    try {
        pdfBuffer = await generarCartillaPDF(cartillaParaPDF, rodeo || {}, perfil || {});
    } catch (err) {
        console.error('[cartillas/enviar] PDF error:', err.message);
        return res.status(500).json({ error: 'Error al generar el PDF: ' + err.message });
    }

    // Subir PDF a Supabase Storage
    const fechaStr = (rodeo?.fecha || ahora.slice(0, 10)).replace(/-/g, '');
    const storagePath = `${asig.rodeo_id}/${uid}/cartilla_${fechaStr}_${Date.now()}.pdf`;

    const { error: storageErr } = await supabase.storage
        .from('rodeo-adjuntos')
        .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: false });

    if (storageErr) {
        console.error('[cartillas/enviar] Storage error:', storageErr.message);
        return res.status(500).json({ error: 'Error al subir el PDF: ' + storageErr.message });
    }

    // Insertar en rodeo_adjuntos con tipo_adjunto='cartilla_jurado' → activa ticket CJ
    const { data: adjunto, error: adjErr } = await supabase
        .from('rodeo_adjuntos')
        .insert({
            rodeo_id:          asig.rodeo_id,
            asignacion_id:     asigId,
            usuario_pagado_id: uid,
            subido_por_admin:  false,
            tipo_adjunto:      'cartilla_jurado',
            nombre_archivo:    `Cartilla_${perfil?.nombre_completo || uid}_${fechaStr}.pdf`,
            storage_path:      storagePath,
            mime_type:         'application/pdf',
            tamano_bytes:      pdfBuffer.length,
            created_by:        uid
        })
        .select('id').single();

    if (adjErr) {
        console.error('[cartillas/enviar] rodeo_adjuntos error:', adjErr.message);
        return res.status(500).json({ error: 'Error al registrar adjunto: ' + adjErr.message });
    }

    // Upsert cartilla como 'enviada'
    const cartillaPayload = {
        asignacion_id:     asigId,
        rodeo_id:          asig.rodeo_id,
        usuario_pagado_id: uid,
        estado:            'enviada',
        datos:             datosEnvio,
        adjunto_id:        adjunto.id,
        storage_path_pdf:  storagePath,
        updated_at:        ahora,
        enviada_en:        ahora
    };

    let cartillaFinal;
    if (cartilla) {
        const { data } = await supabase
            .from('cartillas_jurado')
            .update(cartillaPayload)
            .eq('id', cartilla.id)
            .select().single();
        cartillaFinal = data;
    } else {
        const { data } = await supabase
            .from('cartillas_jurado')
            .insert(cartillaPayload)
            .select().single();
        cartillaFinal = data;
    }

    res.json({
        mensaje: 'Cartilla enviada correctamente. El ticket CJ ha sido activado.',
        cartilla: cartillaFinal,
        adjunto_id: adjunto.id
    });
});

// ─── GET /api/usuario/cartillas/:asignacion_id/pdf ───────────────
// Descarga el PDF de una cartilla ya enviada
router.get('/:asignacion_id/pdf', async (req, res) => {
    const uid    = req.usuario.id;
    const asigId = req.params.asignacion_id;

    const { data: cartilla } = await supabase
        .from('cartillas_jurado')
        .select('storage_path_pdf, estado, usuario_pagado_id')
        .eq('asignacion_id', asigId)
        .maybeSingle();

    if (!cartilla) return res.status(404).json({ error: 'Cartilla no encontrada' });
    if (cartilla.usuario_pagado_id !== uid) return res.status(403).json({ error: 'Sin permiso' });
    if (cartilla.estado !== 'enviada' || !cartilla.storage_path_pdf) {
        return res.status(404).json({ error: 'La cartilla aún no fue enviada' });
    }

    const { data, error } = await supabase.storage
        .from('rodeo-adjuntos')
        .createSignedUrl(cartilla.storage_path_pdf, 3600);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ url: data.signedUrl });
});

module.exports = router;
