const express = require('express');
const router  = express.Router();
const supabase = require('../../config/supabase');

const ESTADOS_VISIBLES_CASO = ['visible_jurado','pendiente_analista','derivado_comision','resuelto','consolidado'];

// GET / — tres grupos: para_responder | en_revision | resultados
// Retorna por cada evaluación activa: { id, estado, rodeo, ciclo1, ciclo2 }
router.get('/', async (req, res) => {
    const uid = req.usuario.id;

    const { data: usuario } = await supabase
        .from('usuarios_pagados')
        .select('tipo_persona')
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

    const rodeoIds = [...new Set(asignaciones.map(a => a.rodeo_id))];
    const asigIds  = asignaciones.map(a => a.id);

    const { data: evaluaciones } = await supabase
        .from('evaluaciones')
        .select(`
            id, estado, nota_final, puntaje_final, rodeo_id, created_at,
            rodeo:rodeos(id, club, fecha, asociacion, tipo_rodeo_nombre)
        `)
        .in('rodeo_id', rodeoIds)
        .eq('anulada', false)
        .order('created_at', { ascending: false });

    const evs        = evaluaciones || [];
    const resultados = evs.filter(e => ['publicado', 'cerrado'].includes(e.estado));
    const activas    = evs.filter(e => !['publicado', 'cerrado'].includes(e.estado));

    if (!activas.length) {
        return res.json({ para_responder: [], en_revision: [], resultados });
    }

    const evalIds = activas.map(e => e.id);

    // Batch: ciclos y casos
    const [{ data: ciclosData }, { data: casosData }] = await Promise.all([
        supabase.from('evaluacion_ciclos')
            .select('id, evaluacion_id, numero_ciclo, estado, es_ciclo_sin_casos, comentario_sin_casos')
            .in('evaluacion_id', evalIds)
            .order('numero_ciclo'),
        supabase.from('evaluacion_casos')
            .select('id, ciclo_id, evaluacion_id, estado, descuento_puntos')
            .in('evaluacion_id', evalIds)
    ]);

    const casoIds = (casosData || []).map(c => c.id);
    const casosPorCiclo = {};
    for (const c of (casosData || [])) {
        (casosPorCiclo[c.ciclo_id] = casosPorCiclo[c.ciclo_id] || []).push(c);
    }

    // Respuestas del jurado en batch
    const respMap = {};
    if (casoIds.length) {
        const { data: respuestas } = await supabase
            .from('evaluacion_respuestas_jurado')
            .select('caso_id, decision, decision_analista, decision_comite, descuento_final')
            .in('caso_id', casoIds)
            .in('asignacion_id', asigIds);
        for (const r of (respuestas || [])) respMap[r.caso_id] = r;
    }

    // Agrupar ciclos por eval y numero
    const ciclosPorEval = {};
    for (const c of (ciclosData || [])) {
        if (!ciclosPorEval[c.evaluacion_id]) ciclosPorEval[c.evaluacion_id] = {};
        ciclosPorEval[c.evaluacion_id][c.numero_ciclo] = c;
    }

    function buildResumen(ciclo) {
        if (!ciclo || ciclo.estado === 'pendiente_carga') return null;
        const casos = (casosPorCiclo[ciclo.id] || []).filter(c => ESTADOS_VISIBLES_CASO.includes(c.estado));

        let respondidos = 0, sinRespAuto = 0, pendientes = 0;
        let pendientesAnalista = 0, pendientesComite = 0, descuentoAcumulado = 0;

        for (const caso of casos) {
            const r = respMap[caso.id];
            if (!r) {
                if (ciclo.estado === 'abierto') pendientes++;
            } else if (r.decision === 'sin_respuesta') {
                sinRespAuto++;
                descuentoAcumulado += (r.descuento_final ?? caso.descuento_puntos ?? 0);
            } else {
                respondidos++;
                if (r.decision === 'rechaza' && !r.decision_analista) pendientesAnalista++;
                if (r.decision_analista === 'derivada_comite' && !r.decision_comite) pendientesComite++;
                if (r.descuento_final !== null && r.descuento_final !== undefined) {
                    descuentoAcumulado += r.descuento_final;
                }
            }
        }

        return {
            id:                  ciclo.id,
            numero_ciclo:        ciclo.numero_ciclo,
            estado:              ciclo.estado,
            es_ciclo_sin_casos:  !!ciclo.es_ciclo_sin_casos,
            comentario_sin_casos: ciclo.comentario_sin_casos || null,
            total_casos:         casos.length,
            respondidos,
            sin_respuesta:       sinRespAuto,
            pendientes,
            descuento_acumulado: descuentoAcumulado,
            pendientes_analista: pendientesAnalista,
            pendientes_comite:   pendientesComite,
            puede_responder:     ciclo.estado === 'abierto' && pendientes > 0
        };
    }

    const para_responder = [];
    const en_revision    = [];

    for (const ev of activas) {
        const cm     = ciclosPorEval[ev.id] || {};
        const ciclo1 = buildResumen(cm[1]);
        const ciclo2 = buildResumen(cm[2]);

        const card = { id: ev.id, estado: ev.estado, rodeo: ev.rodeo || {}, ciclo1, ciclo2 };

        const tienePendientes = [ciclo1, ciclo2].some(c => c?.puede_responder);
        const tieneRespuestas = [ciclo1, ciclo2].some(c => c && (c.respondidos > 0 || c.sin_respuesta > 0));

        if (tienePendientes) {
            para_responder.push(card);
        } else if (tieneRespuestas) {
            en_revision.push(card);
        }
    }

    res.json({ para_responder, en_revision, resultados });
});

// GET /:id/casos — ambos ciclos con casos y mi_respuesta por caso
router.get('/:id/casos', async (req, res) => {
    const evalId = req.params.id;

    const { data: ev } = await supabase
        .from('evaluaciones')
        .select(`
            id, estado, rodeo_id, modo_flujo,
            rodeo:rodeos(club, fecha, asociacion, tipo_rodeo_nombre)
        `)
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

    const { data: ciclos } = await supabase
        .from('evaluacion_ciclos')
        .select('*')
        .eq('evaluacion_id', evalId)
        .order('numero_ciclo');

    const ciclosMap = {};
    for (const c of (ciclos || [])) ciclosMap[c.numero_ciclo] = c;

    const ciclosValidos = (ciclos || []).filter(c => c.estado !== 'pendiente_carga');
    const cicloIds = ciclosValidos.map(c => c.id);

    // Casos de todos los ciclos válidos en batch
    const casosPorCiclo = {};
    let casoIds = [];

    if (cicloIds.length) {
        const { data: casosData } = await supabase
            .from('evaluacion_casos')
            .select('id, numero_caso, tipo_caso, estado, descripcion, video_url, descuento_puntos, ciclo_id')
            .in('ciclo_id', cicloIds)
            .in('estado', ESTADOS_VISIBLES_CASO)
            .order('numero_caso');

        for (const c of (casosData || [])) {
            (casosPorCiclo[c.ciclo_id] = casosPorCiclo[c.ciclo_id] || []).push(c);
        }
        casoIds = (casosData || []).map(c => c.id);
    }

    // Respuestas del jurado en batch
    const respMap = {};
    if (casoIds.length) {
        const { data: respuestasArr } = await supabase
            .from('evaluacion_respuestas_jurado')
            .select(`
                id, caso_id, decision, comentario,
                decision_analista, comentario_analista, decidido_analista_en,
                decision_comite, comentario_comite, decidido_comite_en,
                descuento_final
            `)
            .in('caso_id', casoIds)
            .eq('asignacion_id', asignacion.id);
        for (const r of (respuestasArr || [])) respMap[r.caso_id] = r;
    }

    // Comentarios del jurado por ciclo (modo descuento_automatico)
    const comentMap = {};
    if (cicloIds.length) {
        const { data: comentsArr } = await supabase
            .from('evaluacion_comentarios_jurado_ciclo')
            .select('ciclo_id, comentario, estado, enviado_en')
            .in('ciclo_id', cicloIds)
            .eq('asignacion_id', asignacion.id);
        for (const c of (comentsArr || [])) comentMap[c.ciclo_id] = c;
    }

    const modoFlujo = ev.modo_flujo || 'apelacion_jurado';

    function buildCicloConCasos(ciclo) {
        if (!ciclo) return null;
        if (ciclo.estado === 'pendiente_carga') return { ...ciclo, casos: [], mi_comentario: null };
        const casos = (casosPorCiclo[ciclo.id] || []).map(caso => {
            const resp = respMap[caso.id] || null;
            const puede_responder = modoFlujo === 'apelacion_jurado'
                && ciclo.estado === 'abierto'
                && caso.estado === 'visible_jurado'
                && !resp;
            return { ...caso, mi_respuesta: resp, puede_responder };
        });
        return { ...ciclo, casos, mi_comentario: comentMap[ciclo.id] || null };
    }

    res.json({
        evaluacion: { id: ev.id, estado: ev.estado, modo_flujo: modoFlujo, rodeo: ev.rodeo || {} },
        ciclo1: buildCicloConCasos(ciclosMap[1] || null),
        ciclo2: buildCicloConCasos(ciclosMap[2] || null)
    });
});

// GET /:id/resultado
router.get('/:id/resultado', async (req, res) => {
    const evalId = req.params.id;

    const { data: ev } = await supabase
        .from('evaluaciones')
        .select(`
            id, estado, nota_final, puntaje_final, observacion_general,
            rodeo:rodeos(id, club, fecha, asociacion, tipo_rodeo_nombre)
        `)
        .eq('id', evalId)
        .single();

    if (!ev) return res.status(404).json({ error: 'Evaluación no encontrada' });
    if (!['publicado', 'cerrado'].includes(ev.estado)) {
        return res.status(403).json({ error: 'La evaluación aún no ha sido publicada' });
    }

    const { data: asignacion } = await supabase
        .from('asignaciones')
        .select('id')
        .eq('usuario_pagado_id', req.usuario.id)
        .eq('rodeo_id', ev.rodeo.id)
        .eq('estado', 'activo')
        .limit(1)
        .single();

    if (!asignacion) return res.status(403).json({ error: 'No tienes asignación activa en este rodeo' });

    const miResultado = ev.nota_final != null
        ? { nota: ev.nota_final, puntaje_evaluacion: ev.puntaje_final, calificacion_cualitativa: null }
        : null;

    const { data: ciclosRaw } = await supabase
        .from('evaluacion_ciclos')
        .select('id, numero_ciclo')
        .eq('evaluacion_id', evalId)
        .order('numero_ciclo');

    const cicloIds = (ciclosRaw || []).map(c => c.id);

    const [casosResult, cicloComentsResult, cfinalResult] = await Promise.all([
        cicloIds.length
            ? supabase.from('evaluacion_casos')
                .select('id, ciclo_id, numero_caso, tipo_caso, descripcion, descuento_puntos, video_url, resolucion_final, estado, decision_analista, comentario_analista, decision_comision, comentario_comision')
                .in('ciclo_id', cicloIds)
                .in('estado', ESTADOS_VISIBLES_CASO)
                .order('numero_caso')
            : Promise.resolve({ data: [] }),
        cicloIds.length
            ? supabase.from('evaluacion_comentarios_jurado_ciclo')
                .select('ciclo_id, comentario, enviado_en')
                .in('ciclo_id', cicloIds)
                .eq('asignacion_id', asignacion.id)
            : Promise.resolve({ data: [] }),
        supabase.from('evaluacion_comentarios_finales')
            .select('comentario, created_at')
            .eq('evaluacion_id', evalId)
            .eq('asignacion_id', asignacion.id)
            .limit(1)
            .maybeSingle()
    ]);

    const casosRaw = casosResult.data || [];
    const casoIds  = casosRaw.map(c => c.id);

    let respMap = {};
    if (casoIds.length) {
        const { data: resps } = await supabase
            .from('evaluacion_respuestas_jurado')
            .select('caso_id, decision, comentario, decision_analista, comentario_analista, decidido_analista_en, decision_comite, comentario_comite, decidido_comite_en, descuento_final')
            .in('caso_id', casoIds)
            .eq('asignacion_id', asignacion.id);
        for (const r of (resps || [])) respMap[r.caso_id] = r;
    }

    const casosPorCiclo = {};
    for (const c of casosRaw) {
        (casosPorCiclo[c.ciclo_id] = casosPorCiclo[c.ciclo_id] || []).push(c);
    }

    const comentCicloMap = {};
    for (const c of (cicloComentsResult.data || [])) comentCicloMap[c.ciclo_id] = c;

    const ciclos = (ciclosRaw || []).map(ciclo => ({
        numero_ciclo:   ciclo.numero_ciclo,
        mi_comentario:  comentCicloMap[ciclo.id] || null,
        casos: (casosPorCiclo[ciclo.id] || []).map(caso => ({
            id:                      caso.id,
            numero_caso:             caso.numero_caso,
            tipo_caso:               caso.tipo_caso,
            descripcion:             caso.descripcion || null,
            descuento_puntos:        caso.descuento_puntos,
            video_url:               caso.video_url || null,
            resolucion_final:        caso.resolucion_final || null,
            estado:                  caso.estado,
            comentario_comision:     caso.comentario_comision || null,
            decision_analista_caso:  caso.decision_analista || null,
            comentario_analista_caso: caso.comentario_analista || null,
            mi_respuesta:            respMap[caso.id] || null,
            requiere_respuesta:      caso.tipo_caso !== 'informativo'
        }))
    }));

    res.json({
        rodeo:              ev.rodeo || {},
        mi_resultado:       miResultado,
        ciclos,
        comentario_final:   cfinalResult.data || null,
        observacion_general: ev.observacion_general || null,
        estado:             ev.estado
    });
});

// POST /:id/comentario-final — comentario post-cierre del jurado (uno por evaluación)
router.post('/:id/comentario-final', async (req, res) => {
    const { comentario } = req.body;
    if (!comentario || !String(comentario).trim()) {
        return res.status(400).json({ error: 'El comentario no puede estar vacío' });
    }
    if (String(comentario).trim().length > 2000) {
        return res.status(400).json({ error: 'El comentario no puede superar 2000 caracteres' });
    }

    const { data: ev } = await supabase
        .from('evaluaciones')
        .select('id, rodeo_id, estado')
        .eq('id', req.params.id)
        .single();

    if (!ev) return res.status(404).json({ error: 'Evaluación no encontrada' });
    if (!['publicado', 'cerrado'].includes(ev.estado)) {
        return res.status(403).json({ error: 'Solo puedes comentar evaluaciones publicadas' });
    }

    const { data: asignacion } = await supabase
        .from('asignaciones')
        .select('id')
        .eq('usuario_pagado_id', req.usuario.id)
        .eq('rodeo_id', ev.rodeo_id)
        .eq('estado', 'activo')
        .limit(1)
        .single();

    if (!asignacion) return res.status(403).json({ error: 'No tienes asignación activa en este rodeo' });

    const { data, error } = await supabase
        .from('evaluacion_comentarios_finales')
        .insert({ evaluacion_id: req.params.id, asignacion_id: asignacion.id, comentario: String(comentario).trim() })
        .select()
        .single();

    if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'Ya enviaste un comentario para esta evaluación' });
        return res.status(500).json({ error: error.message });
    }

    res.status(201).json(data);
});

// POST /:id/casos/:casoId/responder
router.post('/:id/casos/:casoId/responder', async (req, res) => {
    const { decision, comentario } = req.body;
    const evalId  = req.params.id;
    const casoId  = req.params.casoId;

    // Verificar asignación activa
    const { data: ev } = await supabase
        .from('evaluaciones')
        .select('id, rodeo_id, modo_flujo')
        .eq('id', evalId)
        .single();
    if (!ev) return res.status(404).json({ error: 'Evaluación no encontrada' });
    if (ev.modo_flujo === 'descuento_automatico') {
        return res.status(409).json({ error: 'En modo Descuento Automático los casos se resuelven automáticamente al cierre del ciclo' });
    }

    const { data: asignacion } = await supabase
        .from('asignaciones')
        .select('id')
        .eq('usuario_pagado_id', req.usuario.id)
        .eq('rodeo_id', ev.rodeo_id)
        .eq('estado', 'activo')
        .neq('estado_designacion', 'rechazado')
        .limit(1)
        .single();
    if (!asignacion) return res.status(403).json({ error: 'No tienes asignación activa' });

    // Verificar caso
    const { data: caso } = await supabase
        .from('evaluacion_casos')
        .select('id, tipo_caso, estado, ciclo_id, descuento_puntos')
        .eq('id', casoId)
        .eq('evaluacion_id', evalId)
        .single();
    if (!caso) return res.status(404).json({ error: 'Caso no encontrado' });
    if (caso.estado !== 'visible_jurado') return res.status(409).json({ error: 'El caso no está disponible para responder' });

    // Verificar ciclo abierto
    const { data: ciclo } = await supabase
        .from('evaluacion_ciclos')
        .select('estado')
        .eq('id', caso.ciclo_id)
        .single();
    if (!ciclo || ciclo.estado !== 'abierto') return res.status(409).json({ error: 'El ciclo ya no está abierto' });

    const esInformativo = caso.tipo_caso === 'informativo';

    if (!esInformativo) {
        if (!decision || !['acepta', 'rechaza'].includes(decision)) {
            return res.status(400).json({ error: 'decision debe ser acepta o rechaza' });
        }
        if (decision === 'rechaza' && (!comentario || !comentario.trim())) {
            return res.status(400).json({ error: 'comentario es obligatorio cuando rechazas' });
        }
    }

    // Auto-aprobación si acepta
    const decisionAnalista = (!esInformativo && decision === 'acepta') ? 'aprobada_auto' : null;
    const descuentoFinal   = decisionAnalista === 'aprobada_auto' ? caso.descuento_puntos : null;

    const payload = {
        caso_id:          casoId,
        asignacion_id:    asignacion.id,
        decision:         esInformativo ? 'acepta' : decision,
        comentario:       comentario?.trim() || null,
        decision_analista: decisionAnalista,
        descuento_final:  descuentoFinal
    };

    const { data: existing } = await supabase
        .from('evaluacion_respuestas_jurado')
        .select('id')
        .eq('caso_id', casoId)
        .eq('asignacion_id', asignacion.id)
        .single();

    if (existing) return res.status(409).json({ error: 'Ya respondiste este caso' });

    const { data, error } = await supabase
        .from('evaluacion_respuestas_jurado')
        .insert(payload)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    res.status(201).json(data);
});

// POST /:id/ciclos/:cicloId/comentario — enviar comentario de ciclo (modo descuento_automatico)
router.post('/:id/ciclos/:cicloId/comentario', async (req, res) => {
    const { comentario } = req.body;
    const evalId  = req.params.id;
    const cicloId = req.params.cicloId;

    if (!comentario || !comentario.trim()) {
        return res.status(400).json({ error: 'El comentario no puede estar vacío' });
    }
    if (comentario.trim().length > 1000) {
        return res.status(400).json({ error: 'El comentario no puede superar 1000 caracteres' });
    }

    const { data: ev } = await supabase
        .from('evaluaciones')
        .select('id, rodeo_id, modo_flujo')
        .eq('id', evalId)
        .single();
    if (!ev) return res.status(404).json({ error: 'Evaluación no encontrada' });
    if (ev.modo_flujo !== 'descuento_automatico') {
        return res.status(409).json({ error: 'Función solo disponible en modo Descuento Automático' });
    }

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

    const { data: ciclo } = await supabase
        .from('evaluacion_ciclos')
        .select('id, evaluacion_id, estado')
        .eq('id', cicloId)
        .eq('evaluacion_id', evalId)
        .single();
    if (!ciclo) return res.status(404).json({ error: 'Ciclo no encontrado' });
    if (ciclo.estado !== 'abierto') return res.status(409).json({ error: 'El ciclo no está abierto' });

    const now = new Date().toISOString();

    const { data, error } = await supabase
        .from('evaluacion_comentarios_jurado_ciclo')
        .upsert({
            evaluacion_id: evalId,
            ciclo_id:      cicloId,
            asignacion_id: asignacion.id,
            comentario:    comentario.trim(),
            estado:        'enviado',
            enviado_en:    now,
            updated_at:    now
        }, { onConflict: 'ciclo_id,asignacion_id' })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    res.status(201).json(data);
});

module.exports = router;
