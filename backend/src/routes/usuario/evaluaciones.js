const express = require('express');
const router  = express.Router();
const supabase = require('../../config/supabase');

// GET / — tres grupos: para_responder | en_revision | resultados
router.get('/', async (req, res) => {
    const uid = req.usuario.id;

    const { data: usuario } = await supabase
        .from('usuarios_pagados')
        .select('tipo_persona, nombre_completo')
        .eq('id', uid)
        .single();

    if (!usuario || usuario.tipo_persona !== 'jurado') {
        return res.json({ para_responder: [], en_revision: [], resultados: [] });
    }

    const { data: asignaciones } = await supabase
        .from('asignaciones')
        .select('id, rodeo_id')
        .eq('usuario_pagado_id', uid)
        .eq('estado', 'activo')
        .neq('estado_designacion', 'rechazado');

    if (!asignaciones?.length) {
        return res.json({ para_responder: [], en_revision: [], resultados: [] });
    }

    const rodeoIds    = [...new Set(asignaciones.map(a => a.rodeo_id))];
    const asigIds     = asignaciones.map(a => a.id);

    const { data: evaluaciones } = await supabase
        .from('evaluaciones')
        .select(`
            id, estado, nota_final, puntaje_final, rodeo_id, created_at,
            rodeo:rodeos(id, club, fecha, asociacion, tipo_rodeo_nombre)
        `)
        .in('rodeo_id', rodeoIds)
        .order('created_at', { ascending: false });

    const evs          = evaluaciones || [];
    const resultados   = evs.filter(e => ['publicado', 'cerrado'].includes(e.estado));
    const noPublicadas = evs.filter(e => !['publicado', 'cerrado'].includes(e.estado));

    if (!noPublicadas.length) {
        return res.json({ para_responder: [], en_revision: [], resultados });
    }

    const evalIds = noPublicadas.map(e => e.id);

    // Batch: ciclos + casos de todas las evaluaciones no publicadas
    const [{ data: ciclosData }, { data: casosData }] = await Promise.all([
        supabase.from('evaluacion_ciclos')
            .select('id, evaluacion_id, numero_ciclo, estado')
            .in('evaluacion_id', evalIds)
            .order('numero_ciclo'),
        supabase.from('evaluacion_casos')
            .select('id, ciclo_id, evaluacion_id, estado')
            .in('evaluacion_id', evalIds)
    ]);

    // Mapas auxiliares
    const ciclosPorEval = {};
    (ciclosData || []).forEach(c => {
        (ciclosPorEval[c.evaluacion_id] = ciclosPorEval[c.evaluacion_id] || []).push(c);
    });

    const casosPorCiclo = {};
    (casosData || []).forEach(c => {
        (casosPorCiclo[c.ciclo_id] = casosPorCiclo[c.ciclo_id] || []).push(c);
    });

    // Respuestas del jurado para todos los casos
    const casoIds = (casosData || []).map(c => c.id);
    const respMap = {}; // caso_id → respuesta
    if (casoIds.length) {
        const { data: respuestas } = await supabase
            .from('evaluacion_respuestas_jurado')
            .select('id, caso_id, decision, decision_analista, decision_comite')
            .in('caso_id', casoIds)
            .in('asignacion_id', asigIds);
        (respuestas || []).forEach(r => { respMap[r.caso_id] = r; });
    }

    const ORDEN_CICLO = ['abierto', 'en_revision', 'cerrado', 'cargado', 'sin_casos', 'pendiente_carga'];
    const para_responder = [];
    const en_revision    = [];

    for (const ev of noPublicadas) {
        const ciclos = ciclosPorEval[ev.id] || [];
        const rodeo  = ev.rodeo || {};

        // ¿Hay ciclo abierto con casos pendientes del jurado?
        const cicloAbierto = ciclos.find(c => c.estado === 'abierto');
        let addedToParaResponder = false;

        if (cicloAbierto) {
            const casos     = casosPorCiclo[cicloAbierto.id] || [];
            const visibles  = casos.filter(c => c.estado === 'visible_jurado');
            const pendientes = visibles.filter(c => !respMap[c.id]);

            if (pendientes.length > 0) {
                para_responder.push({
                    id:                ev.id,
                    estado:            ev.estado,
                    rodeo,
                    ciclo_abierto:     cicloAbierto,
                    total_casos:       visibles.length,
                    total_respondidos: visibles.length - pendientes.length,
                    total_pendientes:  pendientes.length
                });
                addedToParaResponder = true;
            }
        }

        if (!addedToParaResponder) {
            // ¿El jurado respondió al menos un caso en cualquier ciclo?
            let tieneRespuestas     = false;
            let totalRespondidos    = 0;
            let pendientesAnalista  = 0;
            let pendientesComite    = 0;

            for (const ciclo of ciclos) {
                const casos = casosPorCiclo[ciclo.id] || [];
                for (const caso of casos) {
                    const r = respMap[caso.id];
                    if (r) {
                        tieneRespuestas = true;
                        totalRespondidos++;
                        if (r.decision === 'rechaza' && !r.decision_analista) pendientesAnalista++;
                        if (r.decision_analista === 'derivada_comite' && !r.decision_comite) pendientesComite++;
                    }
                }
            }

            if (tieneRespuestas) {
                const cicloRelevante = [...ciclos].sort((a, b) =>
                    (ORDEN_CICLO.indexOf(a.estado) + 1 || 99) - (ORDEN_CICLO.indexOf(b.estado) + 1 || 99)
                )[0];

                en_revision.push({
                    id:                  ev.id,
                    estado:              ev.estado,
                    rodeo,
                    ciclo_relevante:     cicloRelevante,
                    total_respondidos:   totalRespondidos,
                    pendientes_analista: pendientesAnalista,
                    pendientes_comite:   pendientesComite
                });
            }
        }
    }

    res.json({ para_responder, en_revision, resultados });
});

// GET /:id/casos — casos del ciclo más relevante con mi respuesta y retroalimentación
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

    // Ciclo más relevante: abierto > en_revision > cerrado > otros
    const { data: ciclos } = await supabase
        .from('evaluacion_ciclos')
        .select('*')
        .eq('evaluacion_id', evalId)
        .order('numero_ciclo');

    const ORDEN = ['abierto', 'en_revision', 'cerrado', 'cargado', 'sin_casos', 'pendiente_carga'];
    const cicloRelevante = (ciclos || [])
        .filter(c => c.estado !== 'pendiente_carga')
        .sort((a, b) =>
            (ORDEN.indexOf(a.estado) + 1 || 99) - (ORDEN.indexOf(b.estado) + 1 || 99)
        )[0] || null;

    if (!cicloRelevante) {
        return res.json({ ciclo: null, casos: [], mensaje: 'No hay ciclo disponible en este momento' });
    }

    // Casos del ciclo — todos los estados relevantes
    const ESTADOS_CASO = ['visible_jurado', 'pendiente_analista', 'derivado_comision', 'resuelto', 'consolidado'];

    const { data: casos } = await supabase
        .from('evaluacion_casos')
        .select('id, numero_caso, tipo_caso, estado, descripcion, video_url, descuento_puntos')
        .eq('ciclo_id', cicloRelevante.id)
        .in('estado', ESTADOS_CASO)
        .order('numero_caso');

    if (!casos?.length) {
        return res.json({ ciclo: cicloRelevante, casos: [], mensaje: 'No hay casos en este ciclo' });
    }

    // Respuestas del jurado en batch
    const casoIds = casos.map(c => c.id);
    const { data: respuestasArr } = await supabase
        .from('evaluacion_respuestas_jurado')
        .select(`
            id, caso_id, decision, comentario,
            decision_analista, comentario_analista, decidido_analista_en,
            decision_comite,   comentario_comite,   decidido_comite_en,
            descuento_final
        `)
        .in('caso_id', casoIds)
        .eq('asignacion_id', asignacion.id);

    const respuestasMap = {};
    (respuestasArr || []).forEach(r => { respuestasMap[r.caso_id] = r; });

    const casosConRespuesta = casos.map(caso => {
        const respuesta = respuestasMap[caso.id] || null;
        const puede_responder = cicloRelevante.estado === 'abierto'
            && caso.estado === 'visible_jurado'
            && !respuesta;
        return { ...caso, mi_respuesta: respuesta, puede_responder };
    });

    res.json({ ciclo: cicloRelevante, casos: casosConRespuesta });
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
            { evaluacion_id: req.params.id, asignacion_id: asignacion.id, comentario: comentario.trim() },
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
        caso_id:        casoId,
        asignacion_id:  asignacion.id,
        decision:       decisionFinal,
        comentario:     comentarioFinal,
        updated_at:     now,
        decision_comite:     null,
        comentario_comite:   null,
        decidido_comite_por: null,
        decidido_comite_en:  null
    };

    if (decisionFinal === 'acepta') {
        upsertPayload.decision_analista     = 'aprobada_auto';
        upsertPayload.comentario_analista   = 'Aprobada automáticamente por aceptación del jurado';
        upsertPayload.decidido_analista_en  = now;
        upsertPayload.decidido_analista_por = null;
        upsertPayload.descuento_final       = caso.descuento_puntos ?? 0;
    } else {
        upsertPayload.decision_analista     = null;
        upsertPayload.comentario_analista   = null;
        upsertPayload.decidido_analista_en  = null;
        upsertPayload.decidido_analista_por = null;
        upsertPayload.descuento_final       = null;
    }

    const { data, error } = await supabase
        .from('evaluacion_respuestas_jurado')
        .upsert(upsertPayload, { onConflict: 'caso_id,asignacion_id' })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

module.exports = router;
