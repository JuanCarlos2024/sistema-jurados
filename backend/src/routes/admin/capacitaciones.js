/**
 * /api/admin/capacitaciones
 *
 * CRUD de pruebas, preguntas, alternativas, asignaciones y resultados.
 */

const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const supabase = require('../../config/supabase');

const _uploadImagen = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter(req, file, cb) {
        const permitidos = ['image/jpeg', 'image/png', 'image/webp'];
        if (permitidos.includes(file.mimetype)) cb(null, true);
        else cb(new Error('Solo se permiten imágenes JPG, PNG o WEBP'));
    }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtDT = iso => iso ? new Date(iso).toLocaleString('es-CL') : '—';

const fmtTiempo = (ini, fin) => {
    if (!ini || !fin) return null;
    const secs = Math.round((new Date(fin) - new Date(ini)) / 1000);
    if (secs < 0) return null;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
};

const calcularNota = (pct, nMin, nMax, nAprob, exig) => {
    if (!exig || exig <= 0 || exig >= 100) return null;
    const p = Math.max(0, Math.min(100, pct));
    const nota = p <= exig
        ? nMin + (p / exig) * (nAprob - nMin)
        : nAprob + ((p - exig) / (100 - exig)) * (nMax - nAprob);
    return Math.round(nota * 10) / 10;
};

// ─── GET /pruebas ─────────────────────────────────────────────────────────────

router.get('/pruebas', async (req, res) => {
    const { data, error } = await supabase
        .from('capacitacion_pruebas')
        .select(`
            id, titulo, descripcion,
            tiempo_por_pregunta_segundos, puntaje_minimo_aprobacion,
            nota_minima, nota_maxima, nota_aprobacion,
            mezclar_preguntas, mezclar_alternativas,
            intentos_maximos, estado, fecha_inicio, fecha_fin,
            created_at, updated_at
        `)
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const { data: cntRows } = await supabase
        .from('capacitacion_preguntas')
        .select('prueba_id');

    const cntMap = {};
    (cntRows || []).forEach(r => { cntMap[r.prueba_id] = (cntMap[r.prueba_id] || 0) + 1; });

    const result = (data || []).map(p => ({
        ...p,
        total_preguntas: cntMap[p.id] || 0
    }));

    res.json(result);
});

// ─── POST /pruebas ────────────────────────────────────────────────────────────

router.post('/pruebas', async (req, res) => {
    const {
        titulo, descripcion, instrucciones,
        tiempo_por_pregunta_segundos, puntaje_minimo_aprobacion, intentos_maximos,
        nota_minima, nota_maxima, nota_aprobacion,
        mezclar_preguntas, mezclar_alternativas
    } = req.body;

    if (!titulo || !String(titulo).trim()) {
        return res.status(400).json({ error: 'El título es obligatorio' });
    }

    const { data, error } = await supabase
        .from('capacitacion_pruebas')
        .insert({
            titulo: titulo.trim(),
            descripcion: descripcion || null,
            instrucciones: instrucciones || null,
            tiempo_por_pregunta_segundos: tiempo_por_pregunta_segundos ? parseInt(tiempo_por_pregunta_segundos) : null,
            puntaje_minimo_aprobacion: puntaje_minimo_aprobacion !== undefined ? parseFloat(puntaje_minimo_aprobacion) : 60,
            intentos_maximos: intentos_maximos ? parseInt(intentos_maximos) : 1,
            nota_minima:          nota_minima          !== undefined ? parseFloat(nota_minima)          : 1.0,
            nota_maxima:          nota_maxima          !== undefined ? parseFloat(nota_maxima)          : 7.0,
            nota_aprobacion:      nota_aprobacion      !== undefined ? parseFloat(nota_aprobacion)      : 4.0,
            mezclar_preguntas:    mezclar_preguntas    !== undefined ? Boolean(mezclar_preguntas)    : true,
            mezclar_alternativas: mezclar_alternativas !== undefined ? Boolean(mezclar_alternativas) : true,
            estado: 'borrador',
            creado_por: req.usuario.id
        })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});

// ─── GET /pruebas/:id ─────────────────────────────────────────────────────────

router.get('/pruebas/:id', async (req, res) => {
    const { data: prueba, error } = await supabase
        .from('capacitacion_pruebas')
        .select('*')
        .eq('id', req.params.id)
        .single();

    if (error || !prueba) return res.status(404).json({ error: 'Prueba no encontrada' });

    const { data: preguntas } = await supabase
        .from('capacitacion_preguntas')
        .select('*')
        .eq('prueba_id', req.params.id)
        .order('orden', { ascending: true });

    const preguntaIds = (preguntas || []).map(p => p.id);
    let alternativasMap = {};

    if (preguntaIds.length > 0) {
        const { data: alts } = await supabase
            .from('capacitacion_alternativas')
            .select('*')
            .in('pregunta_id', preguntaIds)
            .order('orden', { ascending: true });

        (alts || []).forEach(a => {
            if (!alternativasMap[a.pregunta_id]) alternativasMap[a.pregunta_id] = [];
            alternativasMap[a.pregunta_id].push(a);
        });
    }

    const preguntasConAlts = (preguntas || []).map(p => ({
        ...p,
        alternativas: alternativasMap[p.id] || []
    }));

    res.json({ ...prueba, preguntas: preguntasConAlts });
});

// ─── PUT /pruebas/:id ─────────────────────────────────────────────────────────

router.put('/pruebas/:id', async (req, res) => {
    const {
        titulo, descripcion, instrucciones,
        tiempo_por_pregunta_segundos, puntaje_minimo_aprobacion, intentos_maximos,
        estado, fecha_inicio, fecha_fin,
        nota_minima, nota_maxima, nota_aprobacion,
        mezclar_preguntas, mezclar_alternativas
    } = req.body;

    const updates = { updated_at: new Date().toISOString() };
    if (titulo !== undefined)                        updates.titulo = titulo.trim();
    if (descripcion !== undefined)                   updates.descripcion = descripcion || null;
    if (instrucciones !== undefined)                 updates.instrucciones = instrucciones || null;
    if (tiempo_por_pregunta_segundos !== undefined)  updates.tiempo_por_pregunta_segundos = tiempo_por_pregunta_segundos ? parseInt(tiempo_por_pregunta_segundos) : null;
    if (puntaje_minimo_aprobacion !== undefined)     updates.puntaje_minimo_aprobacion = parseFloat(puntaje_minimo_aprobacion);
    if (intentos_maximos !== undefined)              updates.intentos_maximos = parseInt(intentos_maximos);
    if (estado !== undefined)                        updates.estado = estado;
    if (fecha_inicio !== undefined)                  updates.fecha_inicio = fecha_inicio || null;
    if (fecha_fin !== undefined)                     updates.fecha_fin = fecha_fin || null;
    if (nota_minima !== undefined)                   updates.nota_minima          = parseFloat(nota_minima);
    if (nota_maxima !== undefined)                   updates.nota_maxima          = parseFloat(nota_maxima);
    if (nota_aprobacion !== undefined)               updates.nota_aprobacion      = parseFloat(nota_aprobacion);
    if (mezclar_preguntas !== undefined)             updates.mezclar_preguntas    = Boolean(mezclar_preguntas);
    if (mezclar_alternativas !== undefined)          updates.mezclar_alternativas = Boolean(mezclar_alternativas);

    const { data, error } = await supabase
        .from('capacitacion_pruebas')
        .update(updates)
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ─── DELETE /pruebas/:id ──────────────────────────────────────────────────────

router.delete('/pruebas/:id', async (req, res) => {
    const { error } = await supabase
        .from('capacitacion_pruebas')
        .delete()
        .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
});

// ─── POST /pruebas/:id/replicar ───────────────────────────────────────────────
// Crea una nueva prueba copiando configuración, preguntas, material y/o
// asignaciones según opciones. No copia intentos, respuestas ni resultados.
// Solo Administrador (protegido por la ruta /admin en app.js).

router.post('/pruebas/:id/replicar', async (req, res) => {
    const {
        titulo,
        descripcion,
        copiar_preguntas  = true,
        copiar_material   = false,
        modo_asignaciones = 'none'
    } = req.body;

    if (!titulo || !String(titulo).trim()) {
        return res.status(400).json({ error: 'El título de la nueva prueba es obligatorio' });
    }

    const MODOS_VALIDOS = ['none', 'todos', 'reprobados', 'pendientes', 'reprobados_pendientes'];
    if (!MODOS_VALIDOS.includes(modo_asignaciones)) {
        return res.status(400).json({ error: 'Modo de asignaciones inválido' });
    }

    // 1. Obtener prueba original (validar que existe)
    const { data: original, error: eOrig } = await supabase
        .from('capacitacion_pruebas')
        .select('*')
        .eq('id', req.params.id)
        .single();

    if (eOrig || !original) return res.status(404).json({ error: 'Prueba no encontrada' });

    // 2. Crear nueva prueba como borrador, copiando toda la configuración
    const { data: nueva, error: eNueva } = await supabase
        .from('capacitacion_pruebas')
        .insert({
            titulo:                       String(titulo).trim(),
            descripcion:                  descripcion != null
                                            ? (String(descripcion).trim() || null)
                                            : original.descripcion,
            instrucciones:                original.instrucciones,
            tiempo_por_pregunta_segundos: original.tiempo_por_pregunta_segundos,
            puntaje_minimo_aprobacion:    original.puntaje_minimo_aprobacion,
            intentos_maximos:             original.intentos_maximos,
            nota_minima:                  original.nota_minima,
            nota_maxima:                  original.nota_maxima,
            nota_aprobacion:              original.nota_aprobacion,
            mezclar_preguntas:            original.mezclar_preguntas,
            mezclar_alternativas:         original.mezclar_alternativas,
            estado:                       'borrador',
            creado_por:                   req.usuario.id
            // fecha_inicio y fecha_fin quedan null — la nueva prueba comienza sin fechas
        })
        .select()
        .single();

    if (eNueva) return res.status(500).json({ error: 'Error al crear la prueba: ' + eNueva.message });

    let preguntasCopiadas    = 0;
    let materialCopiado      = 0;
    let asignacionesCopiadas = 0;

    // 3. Copiar preguntas y sus alternativas (snapshots propios de la nueva prueba)
    if (copiar_preguntas !== false && copiar_preguntas !== 'false') {
        const { data: preguntas } = await supabase
            .from('capacitacion_preguntas')
            .select('*')
            .eq('prueba_id', req.params.id)
            .order('orden', { ascending: true });

        for (const p of (preguntas || [])) {
            const { data: nuevaPreg, error: eP } = await supabase
                .from('capacitacion_preguntas')
                .insert({
                    prueba_id:         nueva.id,
                    orden:             p.orden,
                    enunciado:         p.enunciado,
                    tipo:              p.tipo,
                    video_url:         p.video_url        || null,
                    video_sin_audio:   p.video_sin_audio  || false,
                    imagen_url:        p.imagen_url       || null,
                    es_favorita:       p.es_favorita      || false,
                    banco_pregunta_id: p.banco_pregunta_id || null
                })
                .select()
                .single();

            if (eP || !nuevaPreg) continue;

            const { data: alts } = await supabase
                .from('capacitacion_alternativas')
                .select('texto, es_correcta, orden')
                .eq('pregunta_id', p.id)
                .order('orden', { ascending: true });

            if (alts && alts.length > 0) {
                await supabase.from('capacitacion_alternativas').insert(
                    alts.map(a => ({
                        pregunta_id: nuevaPreg.id,
                        texto:       a.texto,
                        es_correcta: a.es_correcta,
                        orden:       a.orden
                    }))
                );
            }
            preguntasCopiadas++;
        }
    }

    // 4. Copiar material (referencias: la nueva prueba apunta al mismo material global)
    if (copiar_material === true || copiar_material === 'true') {
        const { data: mats } = await supabase
            .from('capacitacion_materiales')
            .select('material_id, obligatorio, orden')
            .eq('capacitacion_id', req.params.id);

        if (mats && mats.length > 0) {
            const { error: eMat } = await supabase.from('capacitacion_materiales').insert(
                mats.map(m => ({
                    capacitacion_id: nueva.id,
                    material_id:     m.material_id,
                    obligatorio:     m.obligatorio,
                    orden:           m.orden
                }))
            );
            if (!eMat) materialCopiado = mats.length;
        }
    }

    // 5. Copiar asignaciones según el modo elegido (sin intentos ni respuestas)
    if (modo_asignaciones !== 'none') {
        const { data: asigs } = await supabase
            .from('capacitacion_asignaciones')
            .select('id, usuario_pagado_id')
            .eq('prueba_id', req.params.id);

        if (asigs && asigs.length > 0) {
            let usuariosACopiar = [];

            if (modo_asignaciones === 'todos') {
                usuariosACopiar = asigs.map(a => a.usuario_pagado_id);
            } else {
                const asigIds = asigs.map(a => a.id);
                const { data: intentos } = await supabase
                    .from('capacitacion_intentos')
                    .select('asignacion_id, estado, nota, aprobado, nota_manual, nota_manual_activa')
                    .in('asignacion_id', asigIds);

                const intentosMap = {};
                (intentos || []).forEach(i => {
                    if (!intentosMap[i.asignacion_id]) intentosMap[i.asignacion_id] = [];
                    intentosMap[i.asignacion_id].push(i);
                });

                const notaAprobacion = parseFloat(original.nota_aprobacion ?? 4.0);

                asigs.forEach(a => {
                    const lista      = intentosMap[a.id] || [];
                    const completado = lista.find(i => i.estado === 'completado');

                    if (modo_asignaciones === 'pendientes') {
                        // Pendientes: sin intento completado (nunca terminó la prueba)
                        if (!completado) usuariosACopiar.push(a.usuario_pagado_id);
                    } else {
                        // reprobados o reprobados_pendientes
                        if (completado) {
                            // Usar nota_final (manual si activa, automática si no)
                            const notaFinal = completado.nota_manual_activa === true
                                ? completado.nota_manual
                                : (completado.nota ?? null);
                            const reprobado = notaFinal != null
                                ? notaFinal < notaAprobacion
                                : completado.aprobado === false;
                            if (reprobado) usuariosACopiar.push(a.usuario_pagado_id);
                        } else if (modo_asignaciones === 'reprobados_pendientes') {
                            // Sin completado → pendiente → incluir
                            usuariosACopiar.push(a.usuario_pagado_id);
                        }
                    }
                });
            }

            if (usuariosACopiar.length > 0) {
                const { error: eAsig } = await supabase
                    .from('capacitacion_asignaciones')
                    .insert(usuariosACopiar.map(uid => ({
                        prueba_id:         nueva.id,
                        usuario_pagado_id: uid,
                        fecha_limite:      null,
                        asignado_por:      req.usuario.id
                    })));
                if (!eAsig) asignacionesCopiadas = usuariosACopiar.length;
            }
        }
    }

    res.status(201).json({
        ok:                  true,
        nueva_prueba_id:     nueva.id,
        nueva_prueba_titulo: nueva.titulo,
        stats: {
            preguntas_copiadas:    preguntasCopiadas,
            material_copiado:      materialCopiado,
            asignaciones_copiadas: asignacionesCopiadas
        }
    });
});

// ─── POST /preguntas ──────────────────────────────────────────────────────────

router.post('/pruebas/:id/preguntas', async (req, res) => {
    const { enunciado, tipo, video_url, video_sin_audio, imagen_url, es_favorita } = req.body;

    if (!enunciado || !String(enunciado).trim()) {
        return res.status(400).json({ error: 'El enunciado es obligatorio' });
    }

    const { data: maxRow } = await supabase
        .from('capacitacion_preguntas')
        .select('orden')
        .eq('prueba_id', req.params.id)
        .order('orden', { ascending: false })
        .limit(1)
        .single();

    const orden = maxRow ? (maxRow.orden + 1) : 1;
    const tipoFinal = tipo || 'alternativa_unica';
    const tieneImagen = tipoFinal === 'imagen_alternativas' || tipoFinal === 'verdadero_falso_imagen';
    const tieneVideo  = tipoFinal === 'video_alternativas'  || tipoFinal === 'verdadero_falso_video';

    const { data, error } = await supabase
        .from('capacitacion_preguntas')
        .insert({
            prueba_id: req.params.id,
            orden,
            enunciado: enunciado.trim(),
            tipo: tipoFinal,
            video_url:       tieneVideo  ? (video_url  || null) : null,
            video_sin_audio: tieneVideo  ? (video_sin_audio === true || video_sin_audio === 'true') : false,
            imagen_url:      tieneImagen ? (imagen_url || null) : null,
            es_favorita: es_favorita === true || es_favorita === 'true'
        })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ ...data, alternativas: [] });
});

// ─── PUT /preguntas/:id ───────────────────────────────────────────────────────

router.put('/preguntas/:id', async (req, res) => {
    const { enunciado, tipo, video_url, video_sin_audio, imagen_url, es_favorita, orden } = req.body;

    const updates = { updated_at: new Date().toISOString() };
    if (enunciado !== undefined)       updates.enunciado = enunciado.trim();
    if (tipo !== undefined)            updates.tipo = tipo;
    if (video_url !== undefined)       updates.video_url = video_url || null;
    if (video_sin_audio !== undefined) updates.video_sin_audio = Boolean(video_sin_audio);
    if (imagen_url !== undefined)      updates.imagen_url = imagen_url || null;
    if (es_favorita !== undefined)     updates.es_favorita = Boolean(es_favorita);
    if (orden !== undefined)           updates.orden = parseInt(orden);

    const { data, error } = await supabase
        .from('capacitacion_preguntas')
        .update(updates)
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ─── DELETE /preguntas/:id ────────────────────────────────────────────────────

router.delete('/preguntas/:id', async (req, res) => {
    const { error } = await supabase
        .from('capacitacion_preguntas')
        .delete()
        .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
});

// ─── POST /alternativas ───────────────────────────────────────────────────────

router.post('/preguntas/:id/alternativas', async (req, res) => {
    const { texto, es_correcta } = req.body;

    if (!texto || !String(texto).trim()) {
        return res.status(400).json({ error: 'El texto de la alternativa es obligatorio' });
    }

    const { data: maxRow } = await supabase
        .from('capacitacion_alternativas')
        .select('orden')
        .eq('pregunta_id', req.params.id)
        .order('orden', { ascending: false })
        .limit(1)
        .single();

    const orden = maxRow ? (maxRow.orden + 1) : 1;

    const { data, error } = await supabase
        .from('capacitacion_alternativas')
        .insert({
            pregunta_id: req.params.id,
            texto: texto.trim(),
            es_correcta: es_correcta === true || es_correcta === 'true',
            orden
        })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});

// ─── PUT /alternativas/:id ────────────────────────────────────────────────────

router.put('/alternativas/:id', async (req, res) => {
    const { texto, es_correcta, orden } = req.body;

    const updates = {};
    if (texto !== undefined)       updates.texto = texto.trim();
    if (es_correcta !== undefined) updates.es_correcta = Boolean(es_correcta);
    if (orden !== undefined)       updates.orden = parseInt(orden);

    const { data, error } = await supabase
        .from('capacitacion_alternativas')
        .update(updates)
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ─── DELETE /alternativas/:id ─────────────────────────────────────────────────

router.delete('/alternativas/:id', async (req, res) => {
    const { error } = await supabase
        .from('capacitacion_alternativas')
        .delete()
        .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
});

// ─── GET /pruebas/:id/asignaciones ───────────────────────────────────────────

router.get('/pruebas/:id/asignaciones', async (req, res) => {
    const { data, error } = await supabase
        .from('capacitacion_asignaciones')
        .select(`
            id, fecha_limite, asignado_en,
            jurado:usuarios_pagados!capacitacion_asignaciones_usuario_pagado_id_fkey(id, nombre_completo, rut, categoria, asociacion, tipo_persona)
        `)
        .eq('prueba_id', req.params.id)
        .order('asignado_en', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const asigIds = (data || []).map(a => a.id);
    let intentosMap = {};

    if (asigIds.length > 0) {
        const { data: intentos } = await supabase
            .from('capacitacion_intentos')
            .select('id, asignacion_id, estado, puntaje_obtenido, aprobado, finalizado_en')
            .in('asignacion_id', asigIds)
            .order('numero_intento', { ascending: false });

        (intentos || []).forEach(i => {
            if (!intentosMap[i.asignacion_id]) intentosMap[i.asignacion_id] = [];
            intentosMap[i.asignacion_id].push(i);
        });
    }

    const result = (data || []).map(a => ({
        ...a,
        intentos: intentosMap[a.id] || [],
        ultimo_intento: (intentosMap[a.id] || [])[0] || null
    }));

    res.json(result);
});

// ─── POST /pruebas/:id/asignar ────────────────────────────────────────────────

router.post('/pruebas/:id/asignar', async (req, res) => {
    const { usuario_ids, fecha_limite } = req.body;

    if (!Array.isArray(usuario_ids) || usuario_ids.length === 0) {
        return res.status(400).json({ error: 'Debe enviar al menos un usuario_id' });
    }

    const inserts = usuario_ids.map(uid => ({
        prueba_id: req.params.id,
        usuario_pagado_id: uid,
        fecha_limite: fecha_limite || null,
        asignado_por: req.usuario.id
    }));

    const { data, error } = await supabase
        .from('capacitacion_asignaciones')
        .upsert(inserts, { onConflict: 'prueba_id,usuario_pagado_id', ignoreDuplicates: true })
        .select();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ asignados: (data || []).length, total_enviados: usuario_ids.length });
});

// ─── DELETE /asignaciones/:id ─────────────────────────────────────────────────

router.delete('/asignaciones/:id', async (req, res) => {
    // Verificar si el jurado ya tiene intentos antes de eliminar
    const { count } = await supabase
        .from('capacitacion_intentos')
        .select('id', { count: 'exact', head: true })
        .eq('asignacion_id', req.params.id);

    if (count && count > 0) {
        return res.status(400).json({
            error: 'No se puede quitar la asignación porque el jurado ya inició la prueba.'
        });
    }

    const { error } = await supabase
        .from('capacitacion_asignaciones')
        .delete()
        .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
});

// ─── GET /pruebas/:id/resultados ──────────────────────────────────────────────

router.get('/pruebas/:id/resultados', async (req, res) => {
    const { data: asigs, error } = await supabase
        .from('capacitacion_asignaciones')
        .select(`
            id, fecha_limite, asignado_en,
            jurado:usuarios_pagados!capacitacion_asignaciones_usuario_pagado_id_fkey(id, nombre_completo, rut, categoria, asociacion)
        `)
        .eq('prueba_id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });

    // Total actual de preguntas (base para calcular no_respondidas)
    // nota_aprobacion: necesaria para determinar aprobado_final cuando existe nota_manual
    const [{ count: totalPreguntas }, { data: pruebaConfig }] = await Promise.all([
        supabase.from('capacitacion_preguntas').select('id', { count: 'exact', head: true }).eq('prueba_id', req.params.id),
        supabase.from('capacitacion_pruebas').select('nota_aprobacion').eq('id', req.params.id).single()
    ]);

    const totalP        = totalPreguntas || 0;
    const notaAprobacion = parseFloat(pruebaConfig?.nota_aprobacion ?? 4.0);
    const asigIds = (asigs || []).map(a => a.id);
    let intentosMap   = {};
    let respuestasMap = {};

    if (asigIds.length > 0) {
        const { data: intentos } = await supabase
            .from('capacitacion_intentos')
            .select('id, asignacion_id, estado, numero_intento, iniciado_en, finalizado_en, puntaje_obtenido, nota, aprobado, nota_manual, nota_manual_activa, nota_manual_motivo, nota_manual_por, nota_manual_fecha, reset_motivo, reseteado_en')
            .in('asignacion_id', asigIds)
            .order('numero_intento', { ascending: true });

        (intentos || []).forEach(i => {
            if (!intentosMap[i.asignacion_id]) intentosMap[i.asignacion_id] = [];
            intentosMap[i.asignacion_id].push(i);
        });

        const completadoIds = (intentos || [])
            .filter(i => i.estado === 'completado')
            .map(i => i.id);

        if (completadoIds.length > 0) {
            // .limit(10000) evita la truncación del límite por defecto de Supabase (1000 filas).
            const { data: respuestas } = await supabase
                .from('capacitacion_respuestas')
                .select('intento_id, es_correcta')
                .in('intento_id', completadoIds)
                .limit(10000);

            (respuestas || []).forEach(r => {
                if (!respuestasMap[r.intento_id]) respuestasMap[r.intento_id] = { correctas: 0, incorrectas: 0 };
                if (r.es_correcta === true)       respuestasMap[r.intento_id].correctas++;
                else if (r.es_correcta === false) respuestasMap[r.intento_id].incorrectas++;
            });
        }
    }

    const result = (asigs || []).map(a => {
        const intentos   = intentosMap[a.id] || [];
        const completado = intentos.find(i => i.estado === 'completado');
        const resps      = completado ? (respuestasMap[completado.id] || { correctas: 0, incorrectas: 0 }) : null;

        // nota_final: si existe nota_manual activa, se usa en vez de la automática.
        // El puntaje y los conteos siempre reflejan el resultado real del intento.
        const notaManualActiva = completado?.nota_manual_activa === true;
        const notaFinal   = completado
            ? (notaManualActiva ? completado.nota_manual : (completado.nota ?? null))
            : null;
        const aprobadoFinal = notaFinal != null
            ? notaFinal >= notaAprobacion
            : (completado?.aprobado ?? null);

        return {
            asignacion_id:       a.id,
            jurado:              a.jurado,
            fecha_limite:        a.fecha_limite,
            asignado_en:         a.asignado_en,
            total_intentos:      intentos.length,
            intento_id:          completado ? completado.id              : null,
            // nota y aprobado representan el valor FINAL (manual si existe, si no automático)
            aprobado:            aprobadoFinal,
            puntaje_obtenido:    completado ? completado.puntaje_obtenido : null,
            nota:                notaFinal,
            nota_automatica:     completado ? (completado.nota ?? null)   : null,
            nota_manual:         notaManualActiva ? completado.nota_manual : null,
            nota_manual_activa:  notaManualActiva,
            nota_manual_motivo:  notaManualActiva ? completado.nota_manual_motivo : null,
            nota_manual_por:     notaManualActiva ? completado.nota_manual_por    : null,
            nota_manual_fecha:   notaManualActiva ? completado.nota_manual_fecha  : null,
            iniciado_en:         completado ? completado.iniciado_en      : null,
            finalizado_en:       completado ? completado.finalizado_en    : null,
            tiempo_usado:        completado ? fmtTiempo(completado.iniciado_en, completado.finalizado_en) : null,
            correctas:           resps ? resps.correctas  : null,
            incorrectas:         resps ? resps.incorrectas : null,
            no_respondidas:      resps ? Math.max(0, totalP - resps.correctas - resps.incorrectas) : null,
            total_preguntas:     totalP,
            estado:              completado ? 'completado' : intentos.length > 0 ? 'en_curso' : 'pendiente'
        };
    });

    res.json(result);
});

// ─── GET /pruebas/:id/estadisticas ────────────────────────────────────────────

router.get('/pruebas/:id/estadisticas', async (req, res) => {
    const { data: preguntas } = await supabase
        .from('capacitacion_preguntas')
        .select('id, enunciado, orden')
        .eq('prueba_id', req.params.id)
        .order('orden', { ascending: true });

    if (!preguntas || preguntas.length === 0) return res.json({ preguntas: [] });

    const preguntaIds = preguntas.map(p => p.id);

    const { data: respuestas } = await supabase
        .from('capacitacion_respuestas')
        .select('pregunta_id, es_correcta')
        .in('pregunta_id', preguntaIds);

    const statsMap = {};
    preguntaIds.forEach(id => { statsMap[id] = { total: 0, correctas: 0 }; });
    (respuestas || []).forEach(r => {
        if (!statsMap[r.pregunta_id]) return;
        statsMap[r.pregunta_id].total++;
        if (r.es_correcta) statsMap[r.pregunta_id].correctas++;
    });

    const result = preguntas.map(p => {
        const s = statsMap[p.id] || { total: 0, correctas: 0 };
        const pct = s.total > 0 ? Math.round((s.correctas / s.total) * 100) : null;
        return {
            pregunta_id: p.id,
            enunciado: p.enunciado,
            orden: p.orden,
            total_respuestas: s.total,
            correctas: s.correctas,
            incorrectas: s.total - s.correctas,
            pct_correctas: pct
        };
    });

    const ordenadas = [...result].sort((a, b) => (b.pct_correctas ?? -1) - (a.pct_correctas ?? -1));

    res.json({
        preguntas: result,
        top_correctas: ordenadas.slice(0, 10),
        top_incorrectas: [...ordenadas].reverse().slice(0, 10)
    });
});

// ─── POST /intentos/:id/nota-manual ──────────────────────────────────────────
// Establece o modifica la nota manual de un intento completado.
// Solo Administrador (protegido por la ruta /admin en app.js).

router.post('/intentos/:id/nota-manual', async (req, res) => {
    const { nota, motivo } = req.body;

    if (nota == null || nota === '') {
        return res.status(400).json({ error: 'La nota es obligatoria' });
    }
    if (!motivo || !String(motivo).trim()) {
        return res.status(400).json({ error: 'El motivo es obligatorio' });
    }

    const notaNum = Math.round(parseFloat(nota) * 10) / 10;
    if (isNaN(notaNum)) {
        return res.status(400).json({ error: 'La nota debe ser un número válido' });
    }

    // Obtener intento con datos de prueba para validar rango y calcular aprobado
    const { data: intento } = await supabase
        .from('capacitacion_intentos')
        .select(`
            id, estado, nota, aprobado, nota_manual, nota_manual_activa,
            asignacion_id,
            asignacion:capacitacion_asignaciones!capacitacion_intentos_asignacion_id_fkey(
                prueba_id,
                prueba:capacitacion_pruebas!capacitacion_asignaciones_prueba_id_fkey(
                    nota_minima, nota_maxima, nota_aprobacion
                )
            )
        `)
        .eq('id', req.params.id)
        .single();

    if (!intento) return res.status(404).json({ error: 'Intento no encontrado' });
    if (intento.estado !== 'completado') {
        return res.status(400).json({ error: 'Solo se puede editar la nota de un intento completado' });
    }

    const notaMin  = parseFloat(intento.asignacion?.prueba?.nota_minima    ?? 1.0);
    const notaMax  = parseFloat(intento.asignacion?.prueba?.nota_maxima    ?? 7.0);
    const notaAprob = parseFloat(intento.asignacion?.prueba?.nota_aprobacion ?? 4.0);
    const pruebaId = intento.asignacion?.prueba_id;

    if (notaNum < notaMin || notaNum > notaMax) {
        return res.status(400).json({
            error: `La nota debe estar entre ${notaMin} y ${notaMax}`
        });
    }

    const accion     = intento.nota_manual_activa ? 'modificar' : 'crear';
    const notaManualAnterior = intento.nota_manual_activa ? intento.nota_manual : null;

    const { error: errUpd } = await supabase
        .from('capacitacion_intentos')
        .update({
            nota_manual:        notaNum,
            nota_manual_activa: true,
            nota_manual_motivo: String(motivo).trim(),
            nota_manual_por:    req.usuario.id,
            nota_manual_fecha:  new Date().toISOString()
        })
        .eq('id', req.params.id);

    if (errUpd) return res.status(500).json({ error: errUpd.message });

    await supabase.from('capacitacion_notas_manuales_historial').insert({
        intento_id:           req.params.id,
        prueba_id:            pruebaId,
        nota_automatica:      intento.nota,
        nota_manual_anterior: notaManualAnterior,
        nota_manual_nueva:    notaNum,
        motivo:               String(motivo).trim(),
        accion,
        creado_por:           req.usuario.id
    });

    res.json({
        ok:             true,
        nota_manual:    notaNum,
        nota_automatica: intento.nota,
        aprobado_final: notaNum >= notaAprob
    });
});

// ─── POST /intentos/:id/nota-manual/quitar ────────────────────────────────────
// Quita la nota manual y vuelve al cálculo automático.
// Solo Administrador.

router.post('/intentos/:id/nota-manual/quitar', async (req, res) => {
    const { motivo } = req.body;

    if (!motivo || !String(motivo).trim()) {
        return res.status(400).json({ error: 'El motivo es obligatorio' });
    }

    const { data: intento } = await supabase
        .from('capacitacion_intentos')
        .select(`
            id, estado, nota, aprobado, nota_manual, nota_manual_activa,
            asignacion_id,
            asignacion:capacitacion_asignaciones!capacitacion_intentos_asignacion_id_fkey(prueba_id)
        `)
        .eq('id', req.params.id)
        .single();

    if (!intento) return res.status(404).json({ error: 'Intento no encontrado' });
    if (!intento.nota_manual_activa) {
        return res.status(400).json({ error: 'Este intento no tiene nota manual activa' });
    }

    const { error: errUpd } = await supabase
        .from('capacitacion_intentos')
        .update({
            nota_manual:        null,
            nota_manual_activa: false,
            nota_manual_motivo: null,
            nota_manual_por:    null,
            nota_manual_fecha:  null
        })
        .eq('id', req.params.id);

    if (errUpd) return res.status(500).json({ error: errUpd.message });

    await supabase.from('capacitacion_notas_manuales_historial').insert({
        intento_id:           req.params.id,
        prueba_id:            intento.asignacion?.prueba_id,
        nota_automatica:      intento.nota,
        nota_manual_anterior: intento.nota_manual,
        nota_manual_nueva:    null,
        motivo:               String(motivo).trim(),
        accion:               'quitar',
        creado_por:           req.usuario.id
    });

    res.json({ ok: true, nota_automatica: intento.nota, aprobado: intento.aprobado });
});

// ─── POST /intentos/:id/reset ─────────────────────────────────────────────────

router.post('/intentos/:id/reset', async (req, res) => {
    const { motivo } = req.body;

    if (!motivo || !String(motivo).trim()) {
        return res.status(400).json({ error: 'El motivo del reinicio es obligatorio' });
    }

    const { data: intento } = await supabase
        .from('capacitacion_intentos')
        .select('id, asignacion_id')
        .eq('id', req.params.id)
        .single();

    if (!intento) return res.status(404).json({ error: 'Intento no encontrado' });

    // Las respuestas se conservan para trazabilidad; solo se anula el intento
    const { data, error } = await supabase
        .from('capacitacion_intentos')
        .update({
            estado: 'abandonado',
            reseteado_en: new Date().toISOString(),
            reset_motivo: motivo.trim(),
            reset_por: req.usuario.id
        })
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ...data, mensaje: 'Intento reiniciado. El jurado podrá realizar un nuevo intento.' });
});

// ─── GET /intentos/:id/detalle ────────────────────────────────────────────────

router.get('/intentos/:id/detalle', async (req, res) => {
    const { data: intento, error: eIntento } = await supabase
        .from('capacitacion_intentos')
        .select('id, asignacion_id, estado, numero_intento, iniciado_en, finalizado_en, puntaje_obtenido, nota, aprobado, nota_manual, nota_manual_activa, nota_manual_motivo, nota_manual_por, nota_manual_fecha, orden_preguntas_json, orden_alternativas_json, reset_motivo, reseteado_en')
        .eq('id', req.params.id)
        .single();

    if (eIntento || !intento) return res.status(404).json({ error: 'Intento no encontrado' });

    const { data: asig } = await supabase
        .from('capacitacion_asignaciones')
        .select(`
            id, prueba_id, fecha_limite, asignado_en,
            jurado:usuarios_pagados!capacitacion_asignaciones_usuario_pagado_id_fkey(id, nombre_completo, rut, categoria, asociacion)
        `)
        .eq('id', intento.asignacion_id)
        .single();

    if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });

    const { data: prueba } = await supabase
        .from('capacitacion_pruebas')
        .select('id, titulo')
        .eq('id', asig.prueba_id)
        .single();

    const { data: preguntas } = await supabase
        .from('capacitacion_preguntas')
        .select('id, enunciado, orden')
        .eq('prueba_id', asig.prueba_id)
        .order('orden', { ascending: true });

    const pregIds = (preguntas || []).map(p => p.id);
    const pregMap = {};
    (preguntas || []).forEach(p => { pregMap[p.id] = p; });

    let altsMap = {};
    if (pregIds.length > 0) {
        const { data: alts } = await supabase
            .from('capacitacion_alternativas')
            .select('id, pregunta_id, texto, es_correcta, orden')
            .in('pregunta_id', pregIds)
            .order('orden', { ascending: true });

        (alts || []).forEach(a => {
            if (!altsMap[a.pregunta_id]) altsMap[a.pregunta_id] = [];
            altsMap[a.pregunta_id].push(a);
        });
    }

    const { data: respuestas } = await supabase
        .from('capacitacion_respuestas')
        .select('pregunta_id, alternativa_id, es_correcta, respondida_en')
        .eq('intento_id', req.params.id);

    const respMap = {};
    (respuestas || []).forEach(r => { respMap[r.pregunta_id] = r; });

    const ordenPregIds = (intento.orden_preguntas_json && Array.isArray(intento.orden_preguntas_json) && intento.orden_preguntas_json.length > 0)
        ? intento.orden_preguntas_json : pregIds;
    const ordenAltsMap = intento.orden_alternativas_json || {};

    const detalle = ordenPregIds.map((pid, idx) => {
        const p = pregMap[pid];
        if (!p) return null;
        const resp = respMap[pid];
        const altsBase = altsMap[pid] || [];
        const ordenAlts = ordenAltsMap[pid];
        let altsOrdenadas;
        if (ordenAlts && Array.isArray(ordenAlts) && ordenAlts.length > 0) {
            const altsPorId = {};
            altsBase.forEach(a => { altsPorId[a.id] = a; });
            altsOrdenadas = ordenAlts.map(aid => altsPorId[aid]).filter(Boolean);
        } else {
            altsOrdenadas = altsBase;
        }
        return {
            numero: idx + 1,
            pregunta_id: pid,
            enunciado: p.enunciado,
            alternativas: altsOrdenadas,
            alternativa_elegida: resp ? resp.alternativa_id : null,
            es_correcta: resp ? resp.es_correcta : null,
            respondida_en: resp ? resp.respondida_en : null
        };
    }).filter(Boolean);

    const correctas     = detalle.filter(d => d.es_correcta === true).length;
    const incorrectas   = detalle.filter(d => d.es_correcta === false).length;
    const no_respondidas = detalle.filter(d => d.es_correcta === null).length;

    // nota_final: si existe nota_manual activa, se usa en vez de la automática
    const notaManualActiva = intento.nota_manual_activa === true;
    const notaFinal        = notaManualActiva ? intento.nota_manual : (intento.nota ?? null);

    res.json({
        intento: {
            id:               intento.id,
            numero_intento:   intento.numero_intento,
            estado:           intento.estado,
            iniciado_en:      intento.iniciado_en,
            finalizado_en:    intento.finalizado_en,
            tiempo_usado:     fmtTiempo(intento.iniciado_en, intento.finalizado_en),
            puntaje_obtenido: intento.puntaje_obtenido,
            nota:             notaFinal,
            nota_automatica:  intento.nota ?? null,
            nota_manual:      notaManualActiva ? intento.nota_manual : null,
            nota_manual_activa:  notaManualActiva,
            nota_manual_motivo:  notaManualActiva ? intento.nota_manual_motivo  : null,
            nota_manual_por:     notaManualActiva ? intento.nota_manual_por     : null,
            nota_manual_fecha:   notaManualActiva ? intento.nota_manual_fecha   : null,
            aprobado:         intento.aprobado,
            reset_motivo:     intento.reset_motivo,
            reseteado_en:     intento.reseteado_en
        },
        jurado: asig.jurado,
        prueba: prueba ? { id: prueba.id, titulo: prueba.titulo } : null,
        resumen: { total: detalle.length, correctas, incorrectas, no_respondidas },
        detalle
    });
});

// ─── GET /pruebas/:id/exportar ────────────────────────────────────────────────

router.get('/pruebas/:id/exportar', async (req, res) => {
    const { data: prueba } = await supabase
        .from('capacitacion_pruebas')
        .select('titulo')
        .eq('id', req.params.id)
        .single();

    const { data: asigs } = await supabase
        .from('capacitacion_asignaciones')
        .select(`
            id, asignado_en, fecha_limite,
            jurado:usuarios_pagados!capacitacion_asignaciones_usuario_pagado_id_fkey(nombre_completo, rut, categoria, asociacion)
        `)
        .eq('prueba_id', req.params.id);

    if (!asigs || asigs.length === 0) {
        return res.status(404).json({ error: 'No hay asignaciones para exportar' });
    }

    const { count: totalPreguntas } = await supabase
        .from('capacitacion_preguntas')
        .select('id', { count: 'exact', head: true })
        .eq('prueba_id', req.params.id);

    const asigIds = asigs.map(a => a.id);
    const { data: intentos } = await supabase
        .from('capacitacion_intentos')
        .select('*')
        .in('asignacion_id', asigIds)
        .order('numero_intento', { ascending: true });

    const intentosMap = {};
    (intentos || []).forEach(i => {
        if (!intentosMap[i.asignacion_id]) intentosMap[i.asignacion_id] = [];
        intentosMap[i.asignacion_id].push(i);
    });

    const completadoIds = (intentos || []).filter(i => i.estado === 'completado').map(i => i.id);
    let respuestasMap = {};
    if (completadoIds.length > 0) {
        const { data: respuestas } = await supabase
            .from('capacitacion_respuestas')
            .select('intento_id, es_correcta')
            .in('intento_id', completadoIds);

        (respuestas || []).forEach(r => {
            if (!respuestasMap[r.intento_id]) respuestasMap[r.intento_id] = { correctas: 0, incorrectas: 0 };
            if (r.es_correcta) respuestasMap[r.intento_id].correctas++;
            else respuestasMap[r.intento_id].incorrectas++;
        });
    }

    const totalP = totalPreguntas || 0;
    const COLS = ['Prueba','Jurado','RUT','Categoría','Asociación','Estado','Fecha Inicio','Fecha Término','Tiempo Usado','Total Preguntas','Correctas','Incorrectas','No Respondidas','Porcentaje','Nota','Aprobado','Intentos','Motivo Reinicio'];
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

    const filas = asigs.map(a => {
        const lista = intentosMap[a.id] || [];
        const completado = lista.find(i => i.estado === 'completado');
        const estado = completado ? 'Completado' : lista.length > 0 ? 'En curso' : 'Pendiente';
        const resps = completado ? (respuestasMap[completado.id] || { correctas: 0, incorrectas: 0 }) : null;
        const reiniciado = lista.find(i => i.estado === 'abandonado');
        return [
            prueba?.titulo || '',
            a.jurado?.nombre_completo || '—',
            a.jurado?.rut || '—',
            a.jurado?.categoria || '—',
            a.jurado?.asociacion || '—',
            estado,
            completado ? fmtDT(completado.iniciado_en) : '—',
            completado ? fmtDT(completado.finalizado_en) : '—',
            completado ? (fmtTiempo(completado.iniciado_en, completado.finalizado_en) || '—') : '—',
            totalP,
            resps ? resps.correctas : '—',
            resps ? resps.incorrectas : '—',
            resps ? Math.max(0, totalP - resps.correctas - resps.incorrectas) : '—',
            completado ? (completado.puntaje_obtenido + '%') : '—',
            completado ? (completado.nota ?? '—') : '—',
            completado ? (completado.aprobado ? 'Sí' : 'No') : '—',
            lista.length,
            reiniciado ? (reiniciado.reset_motivo || '') : '—'
        ].map(esc).join(';');
    });

    const ts = new Date().toISOString().slice(0, 10);
    const nombre = (prueba?.titulo || 'prueba').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 40);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="resultados_${nombre}_${ts}.csv"`);
    res.send('﻿' + [COLS.map(esc).join(';'), ...filas].join('\r\n'));
});

// ─── BANCO DE PREGUNTAS ────────────────────────────────────────────────────────

router.get('/banco-preguntas', async (req, res) => {
    const { q, tipo, activa, categoria_tematica, dificultad } = req.query;

    let query = supabase
        .from('capacitacion_banco_preguntas')
        .select('*')
        .order('created_at', { ascending: false });

    if (q)                  query = query.ilike('enunciado', `%${q}%`);
    if (tipo)               query = query.eq('tipo', tipo);
    if (activa !== undefined && activa !== '') query = query.eq('activa', activa === 'true');
    if (categoria_tematica) query = query.eq('categoria_tematica', categoria_tematica);
    if (dificultad)         query = query.eq('dificultad', dificultad);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    if (!data || data.length === 0) return res.json([]);

    const ids = data.map(p => p.id);
    const { data: alts } = await supabase
        .from('capacitacion_banco_alternativas')
        .select('*')
        .in('banco_pregunta_id', ids)
        .order('orden', { ascending: true });

    const altsMap = {};
    (alts || []).forEach(a => {
        if (!altsMap[a.banco_pregunta_id]) altsMap[a.banco_pregunta_id] = [];
        altsMap[a.banco_pregunta_id].push(a);
    });

    res.json(data.map(p => ({ ...p, alternativas: altsMap[p.id] || [] })));
});

router.post('/banco-preguntas', async (req, res) => {
    const { tipo, enunciado, video_url, video_sin_audio, imagen_url, activa, categoria_tematica, dificultad, etiquetas, comentario_banco, alternativas } = req.body;

    if (!enunciado || !String(enunciado).trim())
        return res.status(400).json({ error: 'El enunciado es obligatorio' });
    if (!tipo)
        return res.status(400).json({ error: 'El tipo es obligatorio' });
    if (!Array.isArray(alternativas) || alternativas.length < 2)
        return res.status(400).json({ error: 'Debe tener al menos 2 alternativas' });
    if (!alternativas.some(a => a.es_correcta))
        return res.status(400).json({ error: 'Debe marcar una alternativa como correcta' });

    const tieneImagenB = tipo === 'imagen_alternativas' || tipo === 'verdadero_falso_imagen';
    const tieneVideoB  = tipo === 'video_alternativas'  || tipo === 'verdadero_falso_video';

    const { data: preg, error } = await supabase
        .from('capacitacion_banco_preguntas')
        .insert({
            tipo,
            enunciado: enunciado.trim(),
            video_url:       tieneVideoB  ? (video_url  || null) : null,
            video_sin_audio: tieneVideoB  ? Boolean(video_sin_audio) : false,
            imagen_url:      tieneImagenB ? (imagen_url || null) : null,
            activa: activa !== false,
            categoria_tematica: categoria_tematica || null,
            dificultad: dificultad || null,
            etiquetas: etiquetas || null,
            comentario_banco: comentario_banco ? String(comentario_banco).trim().slice(0, 500) : null
        })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    const altsInsert = alternativas.map((a, i) => ({
        banco_pregunta_id: preg.id,
        texto: String(a.texto).trim(),
        es_correcta: Boolean(a.es_correcta),
        orden: i + 1
    }));

    const { data: altsData, error: eAlts } = await supabase
        .from('capacitacion_banco_alternativas')
        .insert(altsInsert)
        .select();

    if (eAlts) return res.status(500).json({ error: eAlts.message });
    res.status(201).json({ ...preg, alternativas: altsData || [] });
});

// GET /banco-preguntas/exportar — exportar banco a CSV (debe ir ANTES de /:id)
router.get('/banco-preguntas/exportar', async (req, res) => {
    const { q, tipo, activa, categoria_tematica, dificultad } = req.query;

    let query = supabase
        .from('capacitacion_banco_preguntas')
        .select('*')
        .order('created_at', { ascending: false });

    if (q)                  query = query.ilike('enunciado', `%${q}%`);
    if (tipo)               query = query.eq('tipo', tipo);
    if (activa !== undefined && activa !== '') query = query.eq('activa', activa === 'true');
    if (categoria_tematica) query = query.eq('categoria_tematica', categoria_tematica);
    if (dificultad)         query = query.eq('dificultad', dificultad);

    const { data: preguntas, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    if (!preguntas || preguntas.length === 0) {
        return res.status(404).json({ error: 'No hay preguntas para exportar con los filtros aplicados' });
    }

    const ids = preguntas.map(p => p.id);
    const { data: todasAlts } = await supabase
        .from('capacitacion_banco_alternativas')
        .select('*')
        .in('banco_pregunta_id', ids)
        .order('orden', { ascending: true });

    const altsMap = {};
    (todasAlts || []).forEach(a => {
        if (!altsMap[a.banco_pregunta_id]) altsMap[a.banco_pregunta_id] = [];
        altsMap[a.banco_pregunta_id].push(a);
    });

    const LETRAS = ['A','B','C','D','E'];
    const TIPO_LABELS_CSV = {
        alternativa_unica:      'Alternativas',
        video_alternativas:     'Alternativas + video',
        imagen_alternativas:    'Imagen + alternativas',
        verdadero_falso:        'Verdadero/Falso',
        verdadero_falso_video:  'V/F + video',
        verdadero_falso_imagen: 'V/F + imagen',
        sin_video_alternativas: 'Alternativas'
    };
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

    const COLS = [
        'ID', 'Tipo', 'Enunciado', 'Comentario banco',
        'Categoría temática', 'Dificultad', 'Etiquetas',
        'Estado', 'Tiene video', 'Link YouTube', 'Video sin audio',
        'Tiene imagen', 'Link imagen',
        'Fecha creación',
        'Alternativa A', 'Alternativa B', 'Alternativa C', 'Alternativa D', 'Alternativa E',
        'Respuesta correcta (letra)', 'Respuesta correcta (texto)'
    ];

    const filas = preguntas.map(p => {
        const alts   = altsMap[p.id] || [];
        const letras = alts.map((a, i) => LETRAS[i] || (i + 1).toString());
        const correctaIdx = alts.findIndex(a => a.es_correcta);
        const correctaLetra = correctaIdx >= 0 ? (LETRAS[correctaIdx] || '') : '';
        const correctaTexto = correctaIdx >= 0 ? alts[correctaIdx].texto : '';
        const altsArr = LETRAS.map((_, i) => alts[i] ? alts[i].texto : '');
        const tieneVideo  = p.tipo === 'video_alternativas' || p.tipo === 'verdadero_falso_video';
        const tieneImagen = p.tipo === 'imagen_alternativas' || p.tipo === 'verdadero_falso_imagen';
        return [
            p.id,
            TIPO_LABELS_CSV[p.tipo] || p.tipo,
            p.enunciado,
            p.comentario_banco || '',
            p.categoria_tematica || '',
            p.dificultad || '',
            p.etiquetas || '',
            p.activa ? 'Activa' : 'Inactiva',
            tieneVideo  ? 'Sí' : 'No',
            p.video_url || '',
            p.video_sin_audio ? 'Sí' : 'No',
            tieneImagen ? 'Sí' : 'No',
            p.imagen_url || '',
            p.created_at ? new Date(p.created_at).toLocaleDateString('es-CL') : '',
            ...altsArr,
            correctaLetra,
            correctaTexto
        ].map(esc).join(';');
    });

    const ts = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="banco_preguntas_${ts}.csv"`);
    res.send('﻿' + [COLS.map(esc).join(';'), ...filas].join('\r\n'));
});

router.get('/banco-preguntas/:id', async (req, res) => {
    const { data: preg, error } = await supabase
        .from('capacitacion_banco_preguntas')
        .select('*')
        .eq('id', req.params.id)
        .single();

    if (error || !preg) return res.status(404).json({ error: 'Pregunta no encontrada' });

    const { data: alts } = await supabase
        .from('capacitacion_banco_alternativas')
        .select('*')
        .eq('banco_pregunta_id', req.params.id)
        .order('orden', { ascending: true });

    res.json({ ...preg, alternativas: alts || [] });
});

router.put('/banco-preguntas/:id', async (req, res) => {
    const { tipo, enunciado, video_url, video_sin_audio, imagen_url, activa, categoria_tematica, dificultad, etiquetas, comentario_banco, alternativas } = req.body;

    const updates = { updated_at: new Date().toISOString() };
    if (enunciado !== undefined)          updates.enunciado = enunciado.trim();
    if (tipo !== undefined)               updates.tipo = tipo;
    if (video_url !== undefined)          updates.video_url = video_url || null;
    if (video_sin_audio !== undefined)    updates.video_sin_audio = Boolean(video_sin_audio);
    if (imagen_url !== undefined)         updates.imagen_url = imagen_url || null;
    if (activa !== undefined)             updates.activa = Boolean(activa);
    if (categoria_tematica !== undefined) updates.categoria_tematica = categoria_tematica || null;
    if (dificultad !== undefined)         updates.dificultad = dificultad || null;
    if (etiquetas !== undefined)          updates.etiquetas = etiquetas || null;
    if (comentario_banco !== undefined)   updates.comentario_banco = comentario_banco ? String(comentario_banco).trim().slice(0, 500) : null;

    const { data: preg, error } = await supabase
        .from('capacitacion_banco_preguntas')
        .update(updates)
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    if (Array.isArray(alternativas)) {
        await supabase.from('capacitacion_banco_alternativas').delete().eq('banco_pregunta_id', req.params.id);
        if (alternativas.length > 0) {
            await supabase.from('capacitacion_banco_alternativas').insert(
                alternativas.map((a, i) => ({
                    banco_pregunta_id: req.params.id,
                    texto: String(a.texto).trim(),
                    es_correcta: Boolean(a.es_correcta),
                    orden: i + 1
                }))
            );
        }
    }

    const { data: alts } = await supabase
        .from('capacitacion_banco_alternativas')
        .select('*')
        .eq('banco_pregunta_id', req.params.id)
        .order('orden', { ascending: true });

    res.json({ ...preg, alternativas: alts || [] });
});

router.delete('/banco-preguntas/:id', async (req, res) => {
    const { error } = await supabase
        .from('capacitacion_banco_preguntas')
        .update({ activa: false, updated_at: new Date().toISOString() })
        .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
});

// POST /preguntas/:id/guardar-en-banco — copia pregunta de prueba al banco
router.post('/preguntas/:id/guardar-en-banco', async (req, res) => {
    const { comentario_banco } = req.body;

    if (!comentario_banco || !String(comentario_banco).trim()) {
        return res.status(400).json({ error: 'Debe ingresar un comentario o motivo para enviar la pregunta al banco.' });
    }
    if (String(comentario_banco).trim().length > 500) {
        return res.status(400).json({ error: 'El comentario no puede superar los 500 caracteres.' });
    }

    const { data: preg, error: ePreg } = await supabase
        .from('capacitacion_preguntas')
        .select('*')
        .eq('id', req.params.id)
        .single();

    if (ePreg || !preg) return res.status(404).json({ error: 'Pregunta no encontrada' });

    if (preg.banco_pregunta_id) {
        return res.status(409).json({
            error: 'Esta pregunta ya existe en el banco.',
            banco_pregunta_id: preg.banco_pregunta_id
        });
    }

    const { data: alts } = await supabase
        .from('capacitacion_alternativas')
        .select('*')
        .eq('pregunta_id', req.params.id)
        .order('orden', { ascending: true });

    const { data: bancoPrg, error: eBanco } = await supabase
        .from('capacitacion_banco_preguntas')
        .insert({
            tipo:             preg.tipo,
            enunciado:        preg.enunciado,
            video_url:        preg.video_url   || null,
            video_sin_audio:  preg.video_sin_audio || false,
            imagen_url:       preg.imagen_url  || null,
            activa:           true,
            comentario_banco: String(comentario_banco).trim().slice(0, 500)
        })
        .select()
        .single();

    if (eBanco) return res.status(500).json({ error: eBanco.message });

    if (alts && alts.length > 0) {
        await supabase.from('capacitacion_banco_alternativas').insert(
            alts.map((a, i) => ({
                banco_pregunta_id: bancoPrg.id,
                texto:       a.texto,
                es_correcta: a.es_correcta,
                orden:       a.orden || i + 1
            }))
        );
    }

    await supabase
        .from('capacitacion_preguntas')
        .update({ banco_pregunta_id: bancoPrg.id, updated_at: new Date().toISOString() })
        .eq('id', req.params.id);

    res.status(201).json({ ok: true, banco_pregunta_id: bancoPrg.id, mensaje: 'Pregunta guardada en el banco.' });
});

// POST /pruebas/:id/agregar-desde-banco — copia preguntas del banco a la prueba
router.post('/pruebas/:id/agregar-desde-banco', async (req, res) => {
    const { banco_pregunta_ids } = req.body;

    if (!Array.isArray(banco_pregunta_ids) || banco_pregunta_ids.length === 0) {
        return res.status(400).json({ error: 'Debe enviar al menos un banco_pregunta_id' });
    }

    const { data: maxRow } = await supabase
        .from('capacitacion_preguntas')
        .select('orden')
        .eq('prueba_id', req.params.id)
        .order('orden', { ascending: false })
        .limit(1)
        .single();

    let nextOrden = maxRow ? maxRow.orden + 1 : 1;

    const { data: bancoPrgs, error } = await supabase
        .from('capacitacion_banco_preguntas')
        .select('*')
        .in('id', banco_pregunta_ids)
        .eq('activa', true);

    if (error) return res.status(500).json({ error: error.message });
    if (!bancoPrgs || bancoPrgs.length === 0)
        return res.status(404).json({ error: 'No se encontraron preguntas activas en el banco' });

    const { data: bancoAlts } = await supabase
        .from('capacitacion_banco_alternativas')
        .select('*')
        .in('banco_pregunta_id', bancoPrgs.map(p => p.id))
        .order('orden', { ascending: true });

    const bancoAltsMap = {};
    (bancoAlts || []).forEach(a => {
        if (!bancoAltsMap[a.banco_pregunta_id]) bancoAltsMap[a.banco_pregunta_id] = [];
        bancoAltsMap[a.banco_pregunta_id].push(a);
    });

    const creadas = [];
    for (const bp of bancoPrgs) {
        const { data: nuevaPreg, error: eP } = await supabase
            .from('capacitacion_preguntas')
            .insert({
                prueba_id:        req.params.id,
                orden:            nextOrden++,
                enunciado:        bp.enunciado,
                tipo:             bp.tipo,
                video_url:        bp.video_url   || null,
                video_sin_audio:  bp.video_sin_audio || false,
                imagen_url:       bp.imagen_url  || null,
                es_favorita:      false,
                banco_pregunta_id: bp.id
            })
            .select()
            .single();

        if (eP) continue;

        const altsOrigen = bancoAltsMap[bp.id] || [];
        if (altsOrigen.length > 0) {
            await supabase.from('capacitacion_alternativas').insert(
                altsOrigen.map((a, i) => ({
                    pregunta_id: nuevaPreg.id,
                    texto:       a.texto,
                    es_correcta: a.es_correcta,
                    orden:       a.orden || i + 1
                }))
            );
        }
        creadas.push(nuevaPreg.id);
    }

    res.status(201).json({ agregadas: creadas.length, pregunta_ids: creadas });
});

// ─── GET /pruebas/:id/materiales ─────────────────────────────────────────────

router.get('/pruebas/:id/materiales', async (req, res) => {
    const { data, error } = await supabase
        .from('capacitacion_materiales')
        .select(`
            id, obligatorio, orden, created_at,
            material:material_complementario(
                id, titulo, descripcion, categoria, tipo_material,
                nombre_archivo, audiencia, estado, obligatorio
            )
        `)
        .eq('capacitacion_id', req.params.id)
        .order('orden', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// ─── POST /pruebas/:id/materiales ─────────────────────────────────────────────

router.post('/pruebas/:id/materiales', async (req, res) => {
    const { material_id, obligatorio = false, orden } = req.body;
    if (!material_id) return res.status(400).json({ error: 'material_id es obligatorio' });

    const { data: mat } = await supabase
        .from('material_complementario')
        .select('id, estado')
        .eq('id', material_id)
        .is('deleted_at', null)
        .single();

    if (!mat) return res.status(404).json({ error: 'Material no encontrado' });
    if (mat.estado === 'archivado') {
        return res.status(400).json({ error: 'No se puede asociar un material archivado' });
    }

    const { data, error } = await supabase
        .from('capacitacion_materiales')
        .insert({
            capacitacion_id: req.params.id,
            material_id,
            obligatorio: obligatorio === true || obligatorio === 'true',
            orden: orden != null ? parseInt(orden) : null
        })
        .select()
        .single();

    if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'Este material ya está asociado a esta capacitación' });
        return res.status(500).json({ error: error.message });
    }
    res.status(201).json(data);
});

// ─── DELETE /pruebas/:id/materiales/:materialId ───────────────────────────────

router.delete('/pruebas/:id/materiales/:materialId', async (req, res) => {
    const { error } = await supabase
        .from('capacitacion_materiales')
        .delete()
        .eq('capacitacion_id', req.params.id)
        .eq('material_id', req.params.materialId);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
});

// ─── PATCH /pruebas/:id/materiales/:materialId — actualizar obligatorio ────────

router.patch('/pruebas/:id/materiales/:materialId', async (req, res) => {
    const updates = {};
    if (req.body.obligatorio !== undefined) {
        updates.obligatorio = req.body.obligatorio === true || req.body.obligatorio === 'true';
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nada que actualizar' });
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
        .from('capacitacion_materiales')
        .update(updates)
        .eq('capacitacion_id', req.params.id)
        .eq('material_id', req.params.materialId)
        .select()
        .single();

    if (!data) return res.status(404).json({ error: 'Vinculación no encontrada' });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ─── POST /upload-imagen ──────────────────────────────────────────────────────

router.post('/upload-imagen', _uploadImagen.single('imagen'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Imagen requerida' });

    const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
    const ext  = extMap[req.file.mimetype] || 'jpg';
    const path = `preguntas/${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${ext}`;

    const { error: storageErr } = await supabase.storage
        .from('capacitaciones-imagenes')
        .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

    if (storageErr) return res.status(500).json({ error: 'Error al subir imagen: ' + storageErr.message });

    const { data } = supabase.storage.from('capacitaciones-imagenes').getPublicUrl(path);
    res.json({ ok: true, url: data.publicUrl });
});

module.exports = router;
