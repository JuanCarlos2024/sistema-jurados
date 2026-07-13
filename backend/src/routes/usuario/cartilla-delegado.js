const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');

// Middleware: solo delegados pueden usar este módulo
router.use((req, res, next) => {
    if (req.usuario?.tipo_persona !== 'delegado_rentado') {
        return res.status(403).json({ error: 'Solo los delegados pueden acceder a la cartilla del delegado.' });
    }
    next();
});

// ─── Campos permitidos en escritura ──────────────────────────────────────────
const CAMPOS_EDITABLES = [
    'temporada', 'fecha_rodeo', 'delegado_nombre', 'delegado_telefono',
    'secretario_jurado', 'secretario_numero_socio', 'club_asociacion_organizador',
    'tipo_rodeo', 'publico_serie_campeones',
    'serie_campeones_dos_vueltas', 'incluye_informe_disciplinario', 'incluye_informe_ganado_bajo_peso',
    'certificacion_medialuna_comuna', 'certificacion_mas_200_personas',
    'certificacion_mas_250_personas', 'certificacion_vinculacion_comunidad',
    'respuestas_json'
];

const CAMPOS_REQUERIDOS_ENVIO = [
    'temporada', 'fecha_rodeo', 'delegado_nombre',
    'club_asociacion_organizador', 'tipo_rodeo'
];

// ─── GET /api/usuario/cartilla-delegado/rodeo/:rodeo_id ──────────────────────
// Carga datos del rodeo, perfil del delegado y cartilla existente (o null).
router.get('/rodeo/:rodeo_id', async (req, res) => {
    const uid     = req.usuario.id;
    const rodeoId = req.params.rodeo_id;

    // Verificar que el delegado tiene asignación activa en este rodeo
    const { data: asig } = await supabase
        .from('asignaciones')
        .select('id, estado_designacion')
        .eq('rodeo_id', rodeoId)
        .eq('usuario_pagado_id', uid)
        .eq('estado', 'activo')
        .neq('estado_designacion', 'rechazado')
        .maybeSingle();

    if (!asig) {
        return res.status(404).json({ error: 'No tienes asignación activa para este rodeo.' });
    }

    const [{ data: rodeo }, { data: perfil }, { data: cartilla }] = await Promise.all([
        supabase.from('rodeos')
            .select('id, club, asociacion, fecha, tipo_rodeo_nombre, categoria_rodeo_nombre')
            .eq('id', rodeoId).single(),
        supabase.from('usuarios_pagados')
            .select('nombre_completo, telefono')
            .eq('id', uid).single(),
        supabase.from('cartillas_delegado')
            .select('*')
            .eq('rodeo_id', rodeoId)
            .eq('delegado_id', uid)
            .maybeSingle()
    ]);

    res.json({ rodeo, perfil, cartilla: cartilla || null, asignacion_id: asig.id });
});

// ─── POST /api/usuario/cartilla-delegado/rodeo/:rodeo_id ─────────────────────
// Crea la cartilla si no existe; si ya existe la retorna (sin duplicar).
router.post('/rodeo/:rodeo_id', async (req, res) => {
    const uid     = req.usuario.id;
    const rodeoId = req.params.rodeo_id;

    // Verificar asignación activa
    const { data: asig } = await supabase
        .from('asignaciones')
        .select('id, estado_designacion')
        .eq('rodeo_id', rodeoId)
        .eq('usuario_pagado_id', uid)
        .eq('estado', 'activo')
        .neq('estado_designacion', 'rechazado')
        .maybeSingle();

    if (!asig) {
        return res.status(403).json({ error: 'Sin asignación activa para este rodeo.' });
    }

    // Si ya existe, retornar la existente (no duplicar)
    const { data: existente } = await supabase
        .from('cartillas_delegado')
        .select('id, estado')
        .eq('rodeo_id', rodeoId)
        .eq('delegado_id', uid)
        .maybeSingle();

    if (existente) {
        return res.json({ cartilla: existente, creada: false });
    }

    // Precargar datos del rodeo y perfil
    const [{ data: rodeo }, { data: perfil }] = await Promise.all([
        supabase.from('rodeos')
            .select('club, asociacion, fecha, tipo_rodeo_nombre')
            .eq('id', rodeoId).single(),
        supabase.from('usuarios_pagados')
            .select('nombre_completo, telefono')
            .eq('id', uid).single()
    ]);

    const año = rodeo?.fecha ? rodeo.fecha.slice(0, 4) : null;
    const clubAsoc = [rodeo?.club, rodeo?.asociacion].filter(Boolean).join(' — ') || null;

    const { data: nueva, error } = await supabase
        .from('cartillas_delegado')
        .insert({
            rodeo_id:                   rodeoId,
            delegado_id:                uid,
            asignacion_id:              asig.id,
            temporada:                  año,
            fecha_rodeo:                rodeo?.fecha || null,
            delegado_nombre:            perfil?.nombre_completo || null,
            delegado_telefono:          perfil?.telefono        || null,
            club_asociacion_organizador: clubAsoc,
            tipo_rodeo:                 rodeo?.tipo_rodeo_nombre || null,
            creado_por:                 uid
        })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ cartilla: nueva, creada: true });
});

// ─── PATCH /api/usuario/cartilla-delegado/:id ────────────────────────────────
// Guarda borrador. Solo disponible si estado !== 'enviada'.
router.patch('/:id', async (req, res) => {
    const uid = req.usuario.id;

    const { data: cartilla } = await supabase
        .from('cartillas_delegado')
        .select('id, estado, delegado_id')
        .eq('id', req.params.id)
        .maybeSingle();

    if (!cartilla) return res.status(404).json({ error: 'Cartilla no encontrada.' });
    if (cartilla.delegado_id !== uid) return res.status(403).json({ error: 'Sin permiso.' });
    if (['enviada', 'reenviada', 'aprobada'].includes(cartilla.estado)) {
        return res.status(409).json({ error: 'La cartilla ya fue enviada y no puede modificarse.' });
    }

    const updates = { updated_at: new Date().toISOString(), actualizado_por: uid };
    CAMPOS_EDITABLES.forEach(k => {
        if (req.body[k] !== undefined) updates[k] = req.body[k];
    });

    const { data, error } = await supabase
        .from('cartillas_delegado')
        .update(updates)
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ mensaje: 'Borrador guardado correctamente', cartilla: data });
});

// ─── POST /api/usuario/cartilla-delegado/:id/enviar ──────────────────────────
// Valida campos obligatorios y marca la cartilla como enviada.
router.post('/:id/enviar', async (req, res) => {
    const uid = req.usuario.id;

    const { data: cartilla } = await supabase
        .from('cartillas_delegado')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();

    if (!cartilla) return res.status(404).json({ error: 'Cartilla no encontrada.' });
    if (cartilla.delegado_id !== uid) return res.status(403).json({ error: 'Sin permiso.' });
    if (['enviada', 'reenviada', 'aprobada'].includes(cartilla.estado)) {
        return res.status(409).json({ error: 'La cartilla ya fue enviada.' });
    }

    // Combinar datos actuales con posibles datos del body
    const body   = req.body || {};
    const merged = { ...cartilla, ...body };

    // Validar campos mínimos requeridos
    const faltantes = CAMPOS_REQUERIDOS_ENVIO.filter(k => !merged[k] || String(merged[k]).trim() === '');
    if (faltantes.length > 0) {
        return res.status(422).json({
            error: `Faltan campos requeridos antes de enviar: ${faltantes.join(', ')}.`,
            faltantes
        });
    }

    const ahora = new Date().toISOString();
    // Si estaba observada, pasar a reenviada; si no, pasar a enviada
    const esReenvio   = cartilla.estado === 'observada';
    const nuevoEstado = esReenvio ? 'reenviada' : 'enviada';

    // Registrar en historial
    const historial = Array.isArray(cartilla.historial_observaciones) ? [...cartilla.historial_observaciones] : [];
    if (esReenvio) {
        historial.push({ tipo: 'reenvio', fecha: ahora, por: 'delegado' });
    }

    const updates = {
        estado:                  nuevoEstado,
        enviada_en:              cartilla.enviada_en || ahora,
        updated_at:              ahora,
        actualizado_por:         uid,
        historial_observaciones: historial,
        ...(esReenvio ? { reenviada_en: ahora } : {})
    };
    // Guardar también cualquier campo del body enviado simultáneamente
    CAMPOS_EDITABLES.forEach(k => {
        if (body[k] !== undefined) updates[k] = body[k];
    });

    const { data, error } = await supabase
        .from('cartillas_delegado')
        .update(updates)
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    const msg = esReenvio ? 'Cartilla reenviada correctamente.' : 'Cartilla enviada correctamente.';
    res.json({ mensaje: msg, cartilla: data });
});

module.exports = router;
