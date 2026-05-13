/**
 * /api/admin/capacitaciones
 *
 * CRUD de pruebas, preguntas, alternativas, asignaciones y resultados.
 */

const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtDT = iso => iso ? new Date(iso).toLocaleString('es-CL') : '—';

// ─── GET /pruebas ─────────────────────────────────────────────────────────────

router.get('/pruebas', async (req, res) => {
    const { data, error } = await supabase
        .from('capacitacion_pruebas')
        .select(`
            id, titulo, descripcion, tiempo_limite_minutos,
            puntaje_minimo_aprobacion, intentos_maximos, activa,
            created_at, updated_at,
            _preguntas:capacitacion_preguntas(count)
        `)
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    // Contar preguntas por prueba
    const { data: cntRows } = await supabase
        .from('capacitacion_preguntas')
        .select('prueba_id');

    const cntMap = {};
    (cntRows || []).forEach(r => { cntMap[r.prueba_id] = (cntMap[r.prueba_id] || 0) + 1; });

    const result = (data || []).map(p => ({
        ...p,
        total_preguntas: cntMap[p.id] || 0,
        _preguntas: undefined
    }));

    res.json(result);
});

// ─── POST /pruebas ────────────────────────────────────────────────────────────

router.post('/pruebas', async (req, res) => {
    const {
        titulo, descripcion, instrucciones, video_url,
        tiempo_limite_minutos, puntaje_minimo_aprobacion, intentos_maximos
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
            video_url: video_url || null,
            tiempo_limite_minutos: tiempo_limite_minutos ? parseInt(tiempo_limite_minutos) : null,
            puntaje_minimo_aprobacion: puntaje_minimo_aprobacion !== undefined ? parseFloat(puntaje_minimo_aprobacion) : 60,
            intentos_maximos: intentos_maximos ? parseInt(intentos_maximos) : 1,
            activa: true,
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
        titulo, descripcion, instrucciones, video_url,
        tiempo_limite_minutos, puntaje_minimo_aprobacion, intentos_maximos, activa
    } = req.body;

    const updates = { updated_at: new Date().toISOString() };
    if (titulo !== undefined)                   updates.titulo = titulo.trim();
    if (descripcion !== undefined)              updates.descripcion = descripcion || null;
    if (instrucciones !== undefined)            updates.instrucciones = instrucciones || null;
    if (video_url !== undefined)                updates.video_url = video_url || null;
    if (tiempo_limite_minutos !== undefined)    updates.tiempo_limite_minutos = tiempo_limite_minutos ? parseInt(tiempo_limite_minutos) : null;
    if (puntaje_minimo_aprobacion !== undefined) updates.puntaje_minimo_aprobacion = parseFloat(puntaje_minimo_aprobacion);
    if (intentos_maximos !== undefined)         updates.intentos_maximos = parseInt(intentos_maximos);
    if (activa !== undefined)                   updates.activa = Boolean(activa);

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

// ─── POST /preguntas (agregar a prueba) ───────────────────────────────────────

router.post('/pruebas/:id/preguntas', async (req, res) => {
    const { enunciado, explicacion, es_favorita } = req.body;

    if (!enunciado || !String(enunciado).trim()) {
        return res.status(400).json({ error: 'El enunciado es obligatorio' });
    }

    // Orden = max actual + 1
    const { data: maxRow } = await supabase
        .from('capacitacion_preguntas')
        .select('orden')
        .eq('prueba_id', req.params.id)
        .order('orden', { ascending: false })
        .limit(1)
        .single();

    const orden = maxRow ? (maxRow.orden + 1) : 1;

    const { data, error } = await supabase
        .from('capacitacion_preguntas')
        .insert({
            prueba_id: req.params.id,
            orden,
            enunciado: enunciado.trim(),
            explicacion: explicacion || null,
            es_favorita: es_favorita === true || es_favorita === 'true'
        })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ ...data, alternativas: [] });
});

// ─── PUT /preguntas/:id ───────────────────────────────────────────────────────

router.put('/preguntas/:id', async (req, res) => {
    const { enunciado, explicacion, es_favorita, orden } = req.body;

    const updates = { updated_at: new Date().toISOString() };
    if (enunciado !== undefined)   updates.enunciado = enunciado.trim();
    if (explicacion !== undefined) updates.explicacion = explicacion || null;
    if (es_favorita !== undefined) updates.es_favorita = Boolean(es_favorita);
    if (orden !== undefined)       updates.orden = parseInt(orden);

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

// ─── POST /alternativas (agregar a pregunta) ──────────────────────────────────

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
            jurado:usuarios_pagados!capacitacion_asignaciones_usuario_pagado_id_fkey(id, nombre_completo, categoria, asociacion)
        `)
        .eq('prueba_id', req.params.id)
        .order('asignado_en', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    // Agregar resumen de intentos
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
            jurado:usuarios_pagados!capacitacion_asignaciones_usuario_pagado_id_fkey(id, nombre_completo, categoria, asociacion)
        `)
        .eq('prueba_id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });

    const asigIds = (asigs || []).map(a => a.id);
    let intentosMap = {};

    if (asigIds.length > 0) {
        const { data: intentos } = await supabase
            .from('capacitacion_intentos')
            .select('*')
            .in('asignacion_id', asigIds)
            .order('numero_intento', { ascending: true });

        (intentos || []).forEach(i => {
            if (!intentosMap[i.asignacion_id]) intentosMap[i.asignacion_id] = [];
            intentosMap[i.asignacion_id].push(i);
        });
    }

    const result = (asigs || []).map(a => {
        const intentos = intentosMap[a.id] || [];
        const completado = intentos.find(i => i.estado === 'completado');
        return {
            asignacion_id: a.id,
            jurado: a.jurado,
            fecha_limite: a.fecha_limite,
            asignado_en: a.asignado_en,
            total_intentos: intentos.length,
            aprobado: completado ? completado.aprobado : null,
            puntaje_obtenido: completado ? completado.puntaje_obtenido : null,
            finalizado_en: completado ? completado.finalizado_en : null,
            estado: completado ? 'completado' : intentos.length > 0 ? 'en_curso' : 'pendiente'
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

    // Eliminar respuestas del intento
    await supabase.from('capacitacion_respuestas').delete().eq('intento_id', req.params.id);

    // Marcar intento como abandonado con registro de reset
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
            jurado:usuarios_pagados!capacitacion_asignaciones_usuario_pagado_id_fkey(nombre_completo, categoria, asociacion)
        `)
        .eq('prueba_id', req.params.id);

    if (!asigs || asigs.length === 0) {
        return res.status(404).json({ error: 'No hay asignaciones para exportar' });
    }

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

    const COLS = ['Jurado', 'Categoría', 'Asociación', 'Estado', 'Intentos', 'Puntaje Obtenido', 'Aprobado', 'Fecha Finalización', 'Fecha Límite'];
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

    const filas = asigs.map(a => {
        const lista = intentosMap[a.id] || [];
        const completado = lista.find(i => i.estado === 'completado');
        const estado = completado ? 'Completado' : lista.length > 0 ? 'En curso' : 'Pendiente';
        return [
            a.jurado?.nombre_completo || '—',
            a.jurado?.categoria || '—',
            a.jurado?.asociacion || '—',
            estado,
            lista.length,
            completado ? completado.puntaje_obtenido : '—',
            completado ? (completado.aprobado ? 'Sí' : 'No') : '—',
            completado ? fmtDT(completado.finalizado_en) : '—',
            a.fecha_limite ? fmtDT(a.fecha_limite) : 'Sin límite'
        ].map(esc).join(';');
    });

    const ts = new Date().toISOString().slice(0, 10);
    const nombre = (prueba?.titulo || 'prueba').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 40);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="resultados_${nombre}_${ts}.csv"`);
    res.send('﻿' + [COLS.map(esc).join(';'), ...filas].join('\r\n'));
});

module.exports = router;
