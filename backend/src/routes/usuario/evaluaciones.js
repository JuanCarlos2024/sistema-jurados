const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');

// GET / — evaluaciones activas y con resultado para el jurado
router.get('/', async (req, res) => {
    const { data: usuario } = await supabase
        .from('usuarios_pagados')
        .select('tipo_persona')
        .eq('id', req.usuario.id)
        .single();

    if (!usuario || usuario.tipo_persona !== 'jurado') {
        return res.json({ activas: [], resultados: [] });
    }

    const { data: asignaciones } = await supabase
        .from('asignaciones')
        .select('id, rodeo_id')
        .eq('usuario_pagado_id', req.usuario.id)
        .eq('estado', 'activo')
        .neq('estado_designacion', 'rechazado');

    if (!asignaciones || asignaciones.length === 0) {
        return res.json({ activas: [], resultados: [] });
    }

    const rodeoIds = [...new Set(asignaciones.map(a => a.rodeo_id))];

    const { data: evaluaciones } = await supabase
        .from('evaluaciones')
        .select(`
            id, estado, nota_final, puntaje_final, created_at,
            rodeo:rodeos(id, club, sede, fecha, asociacion)
        `)
        .in('rodeo_id', rodeoIds)
        .order('created_at', { ascending: false });

    const evs      = evaluaciones || [];
    const activas   = evs.filter(e => !['publicado', 'cerrado'].includes(e.estado));
    const resultados = evs.filter(e => ['publicado', 'cerrado'].includes(e.estado));

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
        .select('id, tipo_caso, estado, evaluacion_id')
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
    const decisionFinal  = caso.tipo_caso === 'informativo' ? 'acepta' : decision;
    const comentarioFinal = decisionFinal === 'rechaza' ? (comentario || '').trim() : (comentario || null);

    const { data, error } = await supabase
        .from('evaluacion_respuestas_jurado')
        .upsert(
            {
                caso_id:      casoId,
                asignacion_id: asignacion.id,
                decision:     decisionFinal,
                comentario:   comentarioFinal,
                updated_at:   new Date().toISOString()
            },
            { onConflict: 'caso_id,asignacion_id' }
        )
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
            rodeo:rodeos(id, club, sede, fecha, asociacion)
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
