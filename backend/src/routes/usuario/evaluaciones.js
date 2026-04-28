const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');

// GET / — evaluaciones activas y con resultado para el jurado
router.get('/', async (req, res) => {
    const uid = req.usuario.id;
    console.log(`[eval-usuario] GET / uid=${uid}`);

    const { data: usuario } = await supabase
        .from('usuarios_pagados')
        .select('tipo_persona, nombre_completo')
        .eq('id', uid)
        .single();

    console.log(`[eval-usuario] usuario:`, usuario);
    if (!usuario || usuario.tipo_persona !== 'jurado') {
        return res.json({ activas: [], resultados: [] });
    }

    const { data: asignaciones } = await supabase
        .from('asignaciones')
        .select('id, rodeo_id')
        .eq('usuario_pagado_id', uid)
        .eq('estado', 'activo')
        .neq('estado_designacion', 'rechazado');

    console.log(`[eval-usuario] asignaciones: ${asignaciones?.length || 0}`, asignaciones?.map(a => a.rodeo_id));
    if (!asignaciones?.length) {
        return res.json({ activas: [], resultados: [] });
    }

    const rodeoIds = [...new Set(asignaciones.map(a => a.rodeo_id))];

    const { data: evaluaciones } = await supabase
        .from('evaluaciones')
        .select(`
            id, estado, nota_final, puntaje_final, created_at,
            rodeo:rodeos(id, club, fecha, asociacion, tipo_rodeo_nombre)
        `)
        .in('rodeo_id', rodeoIds)
        .order('created_at', { ascending: false });

    console.log(`[eval-usuario] evaluaciones encontradas: ${evaluaciones?.length || 0}`, evaluaciones?.map(e => ({ id: e.id, estado: e.estado })));

    const evs = evaluaciones || [];
    const resultados = evs.filter(e => ['publicado', 'cerrado'].includes(e.estado));
    const noPublicadas = evs.filter(e => !['publicado', 'cerrado'].includes(e.estado));

    if (!noPublicadas.length) {
        console.log(`[eval-usuario] sin evaluaciones no publicadas → activas=0`);
        return res.json({ activas: [], resultados });
    }

    // Para cada evaluación no publicada, buscar ciclo abierto con casos visible_jurado
    const evalIds = noPublicadas.map(e => e.id);

    const { data: ciclosAbiertos } = await supabase
        .from('evaluacion_ciclos')
        .select('id, evaluacion_id, numero_ciclo, estado')
        .in('evaluacion_id', evalIds)
        .eq('estado', 'abierto');

    console.log(`[eval-usuario] ciclos abiertos: ${ciclosAbiertos?.length || 0}`, ciclosAbiertos?.map(c => ({ id: c.id, eval: c.evaluacion_id, num: c.numero_ciclo })));

    if (!ciclosAbiertos?.length) {
        return res.json({ activas: [], resultados });
    }

    const cicloIds = ciclosAbiertos.map(c => c.id);

    const { data: casosVisibles } = await supabase
        .from('evaluacion_casos')
        .select('ciclo_id')
        .in('ciclo_id', cicloIds)
        .eq('estado', 'visible_jurado');

    console.log(`[eval-usuario] casos visible_jurado: ${casosVisibles?.length || 0}`);

    const ciclosConCasos = new Set((casosVisibles || []).map(c => c.ciclo_id));

    // Mapa evaluacion_id → ciclo abierto (uno por evaluación)
    const cicloMap = {};
    ciclosAbiertos.forEach(c => { cicloMap[c.evaluacion_id] = c; });

    const activas = noPublicadas
        .filter(e => {
            const ciclo = cicloMap[e.id];
            return ciclo && ciclosConCasos.has(ciclo.id);
        })
        .map(e => ({ ...e, ciclo_abierto: cicloMap[e.id] }));

    console.log(`[eval-usuario] activas finales: ${activas.length}`);
    res.json({ activas, resultados });
});

// GET /:id/casos — casos del ciclo abierto con mi respuesta
router.get('/:id/casos', async (req, res) => {
    const evalId = req.params.id;

    const { data: ev } = await supabase
        .from('evaluaciones')
        .select('id, rodeo_id')
        .eq('id', evalId)
        .single();

    if (!ev) return res.status(404).json({ error: 'Evaluación no encontrada' });

    const { data: asignacion } = await supabase
        .from('asignaciones')
        .select('id')
        .eq('usuario_pagado_id', req.usuario.id)
        .eq('rodeo_id', ev.rodeo_id)
        .eq('estado', 'activo')
        .neq('estado_designacion', 'rechazado')
        .limit(1)
        .single();

    if (!asignacion) return res.status(403).json({ error: 'No tienes asignación activa en este rodeo' });

    const { data: cicloAbierto } = await supabase
        .from('evaluacion_ciclos')
        .select('*')
        .eq('evaluacion_id', evalId)
        .eq('estado', 'abierto')
        .order('numero_ciclo')
        .limit(1)
        .single();

    if (!cicloAbierto) {
        return res.json({ ciclo: null, casos: [], mensaje: 'No hay ciclo disponible en este momento' });
    }

    const { data: casos } = await supabase
        .from('evaluacion_casos')
        .select('id, numero_caso, tipo_caso, descripcion, video_url, descuento_puntos')
        .eq('ciclo_id', cicloAbierto.id)
        .eq('estado', 'visible_jurado')
        .order('numero_caso');

    const casosConRespuesta = await Promise.all((casos || []).map(async (caso) => {
        const { data: respuesta } = await supabase
            .from('evaluacion_respuestas_jurado')
            .select('id, decision, comentario')
            .eq('caso_id', caso.id)
            .eq('asignacion_id', asignacion.id)
            .single();
        return { ...caso, mi_respuesta: respuesta || null };
    }));

    res.json({ ciclo: cicloAbierto, casos: casosConRespuesta });
});

// POST /:id/casos/:casoId/responder
router.post('/:id/casos/:casoId/responder', async (req, res) => {
    const { decision, comentario } = req.body;
    const evalId = req.params.id;
    const casoId = req.params.casoId;

    if (!decision || !['acepta', 'rechaza'].includes(decision)) {
        return res.status(400).json({ error: 'decision debe ser acepta o rechaza' });
    }
    if (decision === 'rechaza' && (!comentario || !comentario.trim())) {
        return res.status(400).json({ error: 'comentario es obligatorio cuando se rechaza' });
    }

    const { data: caso } = await supabase
        .from('evaluacion_casos')
        .select('id, tipo_caso, estado, evaluacion_id, descuento_puntos')
        .eq('id', casoId)
        .single();

    if (!caso) return res.status(404).json({ error: 'Caso no encontrado' });
    if (caso.estado !== 'visible_jurado') {
        return res.status(409).json({ error: 'El caso no está disponible para responder' });
    }

    const { data: ev } = await supabase
        .from('evaluaciones')
        .select('rodeo_id')
        .eq('id', evalId)
        .single();

    if (!ev) return res.status(404).json({ error: 'Evaluación no encontrada' });

    const { data: asignacion } = await supabase
        .from('asignaciones')
        .select('id')
        .eq('usuario_pagado_id', req.usuario.id)
        .eq('rodeo_id', ev.rodeo_id)
        .eq('estado', 'activo')
        .neq('estado_designacion', 'rechazado')
        .limit(1)
        .single();

    if (!asignacion) return res.status(403).json({ error: 'No tienes asignación activa en este rodeo' });

    // Casos informativos siempre acepta
    const decisionFinal   = caso.tipo_caso === 'informativo' ? 'acepta' : decision;
    const comentarioFinal = decisionFinal === 'rechaza' ? (comentario || '').trim() : (comentario || null);
    const now = new Date().toISOString();

    const upsertPayload = {
        caso_id:       casoId,
        asignacion_id: asignacion.id,
        decision:      decisionFinal,
        comentario:    comentarioFinal,
        updated_at:    now,
        // Reset comité fields on re-answer
        decision_comite:     null,
        comentario_comite:   null,
        decidido_comite_por: null,
        decidido_comite_en:  null
    };

    if (decisionFinal === 'acepta') {
        upsertPayload.decision_analista    = 'aprobada_auto';
        upsertPayload.comentario_analista  = 'Aprobada automáticamente por aceptación del jurado';
        upsertPayload.decidido_analista_en = now;
        upsertPayload.decidido_analista_por = null;
        upsertPayload.descuento_final      = caso.descuento_puntos ?? 0;
    } else {
        upsertPayload.decision_analista    = null;
        upsertPayload.comentario_analista  = null;
        upsertPayload.decidido_analista_en = null;
        upsertPayload.decidido_analista_por = null;
        upsertPayload.descuento_final      = null;
    }

    const { data, error } = await supabase
        .from('evaluacion_respuestas_jurado')
        .upsert(upsertPayload, { onConflict: 'caso_id,asignacion_id' })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// GET /:id/resultado
router.get('/:id/resultado', async (req, res) => {
    const { data: ev } = await supabase
        .from('evaluaciones')
        .select(`
            id, estado, nota_final, puntaje_final, observacion_general, created_at,
            rodeo:rodeos(id, club, fecha, asociacion)
        `)
        .eq('id', req.params.id)
        .single();

    if (!ev) return res.status(404).json({ error: 'Evaluación no encontrada' });
    if (!['publicado', 'cerrado'].includes(ev.estado)) {
        return res.status(403).json({ error: 'La evaluación aún no ha sido publicada' });
    }

    const { data: asignacion } = await supabase
        .from('asignaciones')
        .select('id')
        .eq('usuario_pagado_id', req.usuario.id)
        .eq('rodeo_id', ev.rodeo?.id || '')
        .limit(1)
        .single();

    let nota_personal = null;
    let mi_comentario = null;

    if (asignacion) {
        const { data: nota } = await supabase
            .from('notas_rodeo')
            .select('nota, puntaje_evaluacion, calificacion_cualitativa, fuente')
            .eq('asignacion_id', asignacion.id)
            .single();
        nota_personal = nota || null;

        const { data: cf } = await supabase
            .from('evaluacion_comentarios_finales')
            .select('comentario, created_at')
            .eq('evaluacion_id', req.params.id)
            .eq('asignacion_id', asignacion.id)
            .single();
        mi_comentario = cf || null;
    }

    res.json({ ...ev, nota_personal, mi_comentario });
});

// POST /:id/comentario-final
router.post('/:id/comentario-final', async (req, res) => {
    const { comentario } = req.body;
    if (!comentario || !comentario.trim()) {
        return res.status(400).json({ error: 'comentario es requerido' });
    }

    const { data: ev } = await supabase
        .from('evaluaciones')
        .select('id, estado, rodeo_id')
        .eq('id', req.params.id)
        .single();

    if (!ev) return res.status(404).json({ error: 'Evaluación no encontrada' });
    if (!['publicado', 'cerrado'].includes(ev.estado)) {
        return res.status(403).json({ error: 'Solo se puede comentar evaluaciones publicadas o cerradas' });
    }

    const { data: asignacion } = await supabase
        .from('asignaciones')
        .select('id')
        .eq('usuario_pagado_id', req.usuario.id)
        .eq('rodeo_id', ev.rodeo_id)
        .limit(1)
        .single();

    if (!asignacion) return res.status(403).json({ error: 'No tienes asignación en este rodeo' });

    const { data, error } = await supabase
        .from('evaluacion_comentarios_finales')
        .upsert(
            {
                evaluacion_id:  req.params.id,
                asignacion_id:  asignacion.id,
                comentario:     comentario.trim()
            },
            { onConflict: 'evaluacion_id,asignacion_id' }
        )
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: req.params.id,
        accion:        'comentario_final',
        detalle:       { asignacion_id: asignacion.id },
        actor_id:      req.usuario.id,
        actor_tipo:    'usuario_pagado',
        actor_nombre:  req.usuario.nombre,
        ip_address:    req.ip
    });

    res.json(data);
});

module.exports = router;
