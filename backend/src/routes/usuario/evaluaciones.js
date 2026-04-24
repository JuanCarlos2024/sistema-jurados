const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');

// ── Helper de auditoría (actor_tipo variable — jurado es 'usuario_pagado') ────

async function auditarEval(evaluacion_id, caso_id, ciclo_id, accion, detalle, actor_id, actor_nombre, actor_tipo, ip) {
    try {
        await supabase.from('evaluacion_auditoria').insert({
            evaluacion_id,
            caso_id:     caso_id  || null,
            ciclo_id:    ciclo_id || null,
            accion,
            detalle,
            actor_id,
            actor_tipo,
            actor_nombre,
            ip_address:  ip || null
        });
    } catch (err) {
        console.warn('[EVAL AUDIT]', err.message);
    }
}

// ── Helper: asignación activa del jurado en el rodeo ─────────────────────────

async function obtenerAsignacionJurado(rodeo_id, usuario_id) {
    const { data } = await supabase
        .from('asignaciones')
        .select('id')
        .eq('rodeo_id', rodeo_id)
        .eq('usuario_pagado_id', usuario_id)
        .eq('tipo_persona', 'jurado')
        .eq('estado', 'activo')
        .or('estado_designacion.neq.rechazado,estado_designacion.is.null')
        .limit(1);
    return data?.[0] || null;
}

// ── Helper: contar jurados activos en un rodeo ────────────────────────────────

async function contarJuradosRodeo(rodeo_id) {
    const { count } = await supabase
        .from('asignaciones')
        .select('id', { count: 'exact', head: true })
        .eq('rodeo_id', rodeo_id)
        .eq('tipo_persona', 'jurado')
        .eq('estado', 'activo')
        .or('estado_designacion.neq.rechazado,estado_designacion.is.null');
    return count ?? 0;
}

// ── GET /api/usuario/evaluaciones ────────────────────────────────────────────
// Lista evaluaciones con ciclo abierto donde el jurado tiene asignación activa
router.get('/', async (req, res) => {
    if (req.usuario.tipo_persona !== 'jurado') {
        return res.status(403).json({ error: 'Solo disponible para jurados' });
    }

    // 1. Rodeos donde el jurado tiene asignación activa
    const { data: asigs } = await supabase
        .from('asignaciones')
        .select('rodeo_id')
        .eq('usuario_pagado_id', req.usuario.id)
        .eq('tipo_persona', 'jurado')
        .eq('estado', 'activo')
        .or('estado_designacion.neq.rechazado,estado_designacion.is.null');

    const rodeoIds = (asigs || []).map(a => a.rodeo_id);
    if (rodeoIds.length === 0) return res.json({ evaluaciones: [] });

    // 2. Evaluaciones de esos rodeos con sus ciclos
    const { data: evals, error } = await supabase
        .from('evaluaciones')
        .select(`
            id, estado,
            rodeos(id, club, asociacion, fecha, tipo_rodeo_nombre),
            evaluacion_ciclos(id, numero_ciclo, estado)
        `)
        .in('rodeo_id', rodeoIds);

    if (error) return res.status(500).json({ error: error.message });

    // 3. Categorizar evaluaciones visibles para el jurado:
    //    'activo'    → tiene ciclo abierto ahora mismo
    //    'resultado' → evaluación publicada o cerrada
    //    Las demás (borrador, en_proceso, etc. sin ciclo abierto) no son visibles aún.
    const resultado = (evals || [])
        .map(e => {
            const cicloAbierto = (e.evaluacion_ciclos || []).find(c => c.estado === 'abierto') || null;
            let tipo = null;
            if (cicloAbierto) {
                tipo = 'activo';
            } else if (['publicado', 'cerrado'].includes(e.estado)) {
                tipo = 'resultado';
            }
            if (!tipo) return null;
            return {
                id:            e.id,
                estado:        e.estado,
                tipo,
                rodeo:         e.rodeos,
                ciclo_abierto: cicloAbierto
            };
        })
        .filter(Boolean)
        .sort((a, b) => {
            // Activos primero; dentro de cada grupo, más recientes primero
            if (a.tipo !== b.tipo) return a.tipo === 'activo' ? -1 : 1;
            const fa = a.rodeo?.fecha || '';
            const fb = b.rodeo?.fecha || '';
            return fb.localeCompare(fa);
        });

    res.json({ evaluaciones: resultado });
});

// ── GET /api/usuario/evaluaciones/:eval_id/casos ─────────────────────────────
// Casos del ciclo abierto, con la respuesta propia del jurado si ya respondió
router.get('/:eval_id/casos', async (req, res) => {
    if (req.usuario.tipo_persona !== 'jurado') {
        return res.status(403).json({ error: 'Solo disponible para jurados' });
    }

    const { eval_id } = req.params;

    // 1. Cargar evaluación
    const { data: evalData } = await supabase
        .from('evaluaciones')
        .select('id, rodeo_id, estado')
        .eq('id', eval_id)
        .single();

    if (!evalData) return res.status(404).json({ error: 'Evaluación no encontrada' });

    // 2. Verificar asignación activa del jurado en el rodeo
    const asig = await obtenerAsignacionJurado(evalData.rodeo_id, req.usuario.id);
    if (!asig) return res.status(403).json({ error: 'No tienes asignación activa en el rodeo de esta evaluación' });

    // 3. Buscar ciclo abierto de esta evaluación
    const { data: ciclosAbiertos } = await supabase
        .from('evaluacion_ciclos')
        .select('id, numero_ciclo, estado, min_casos, max_casos')
        .eq('evaluacion_id', eval_id)
        .eq('estado', 'abierto')
        .order('numero_ciclo', { ascending: true })
        .limit(1);

    const ciclo = ciclosAbiertos?.[0] || null;

    if (!ciclo) {
        return res.json({
            evaluacion_id: eval_id,
            ciclo:         null,
            mensaje:       'No hay ciclo abierto en este momento',
            casos:         []
        });
    }

    // 4. Casos del ciclo — todos visibles (incluidos informativos)
    const { data: casos, error: casosErr } = await supabase
        .from('evaluacion_casos')
        .select('id, numero_caso, tipo_caso, descuento_puntos, descripcion, video_url, estado')
        .eq('ciclo_id', ciclo.id)
        .order('numero_caso', { ascending: true });

    if (casosErr) return res.status(500).json({ error: casosErr.message });

    // 5. Respuestas ya registradas por este jurado en estos casos
    const casoIds = (casos || []).map(c => c.id);
    let miMap = {};
    if (casoIds.length > 0) {
        const { data: misRespuestas } = await supabase
            .from('evaluacion_respuestas_jurado')
            .select('caso_id, decision, comentario, created_at')
            .eq('asignacion_id', asig.id)
            .in('caso_id', casoIds);
        (misRespuestas || []).forEach(r => { miMap[r.caso_id] = r; });
    }

    // 6. Enriquecer casos con requiere_respuesta y mi_respuesta
    // Casos informativos: visibles, permiten comentario opcional, no requieren acepta/rechaza
    const casosConRespuesta = (casos || []).map(c => ({
        ...c,
        requiere_respuesta: c.tipo_caso !== 'informativo',
        mi_respuesta:       miMap[c.id] || null
    }));

    res.json({ evaluacion_id: eval_id, ciclo, casos: casosConRespuesta });
});

// ── POST /api/usuario/evaluaciones/:eval_id/casos/:caso_id/responder ──────────
// Registra respuesta del jurado a un caso. Manejo especial para informativos.
// Después de registrar, intenta consolidar y verificar si el ciclo pasa a 'en_revision'.
router.post('/:eval_id/casos/:caso_id/responder', async (req, res) => {
    if (req.usuario.tipo_persona !== 'jurado') {
        return res.status(403).json({ error: 'Solo disponible para jurados' });
    }

    const { eval_id, caso_id } = req.params;
    const { decision, comentario } = req.body;

    // 1. Cargar evaluación
    const { data: evalData } = await supabase
        .from('evaluaciones')
        .select('id, rodeo_id, estado')
        .eq('id', eval_id)
        .single();

    if (!evalData) return res.status(404).json({ error: 'Evaluación no encontrada' });

    // 2. Asignación activa del jurado
    const asig = await obtenerAsignacionJurado(evalData.rodeo_id, req.usuario.id);
    if (!asig) return res.status(403).json({ error: 'No tienes asignación activa en el rodeo de esta evaluación' });

    // 3. Contar jurados activos del rodeo — debe ser > 0 antes de aceptar cualquier respuesta
    const totalJurados = await contarJuradosRodeo(evalData.rodeo_id);
    if (totalJurados === 0) {
        return res.status(400).json({ error: 'No existen jurados activos válidos para este rodeo. No se pueden registrar respuestas.' });
    }

    // 4. Cargar caso con su ciclo
    const { data: caso } = await supabase
        .from('evaluacion_casos')
        .select('id, numero_caso, tipo_caso, estado, ciclo_id, evaluacion_ciclos(id, numero_ciclo, estado)')
        .eq('id', caso_id)
        .eq('evaluacion_id', eval_id)
        .single();

    if (!caso) return res.status(404).json({ error: 'Caso no encontrado en esta evaluación' });

    const ciclo = caso.evaluacion_ciclos;

    // 5. Ciclo debe estar abierto
    if (ciclo.estado !== 'abierto') {
        return res.status(400).json({ error: `El ciclo no está abierto (estado: ${ciclo.estado})` });
    }

    // 6. Caso debe estar en visible_jurado
    if (caso.estado !== 'visible_jurado') {
        return res.status(400).json({ error: `El caso no está disponible para respuesta (estado: ${caso.estado})` });
    }

    // 7. Verificar respuesta duplicada (maybeSingle — correcto para check de existencia)
    const { data: yaRespondio, error: dupErr } = await supabase
        .from('evaluacion_respuestas_jurado')
        .select('id')
        .eq('caso_id', caso_id)
        .eq('asignacion_id', asig.id)
        .maybeSingle();

    if (dupErr) return res.status(500).json({ error: dupErr.message });
    if (yaRespondio) return res.status(409).json({ error: 'Ya registraste una respuesta para este caso' });

    // ── Casos informativos — flujo especial ──────────────────────────────────
    // Se muestran al jurado; permiten comentario opcional.
    // No requieren acepta/rechaza. No participan en consolidación.
    // No cuentan para pasar el ciclo a 'en_revision'.
    // Se almacena decision='acepta' como reconocimiento implícito (campo NOT NULL en schema).
    if (caso.tipo_caso === 'informativo') {
        if (decision && decision !== 'acepta') {
            return res.status(400).json({
                error: 'Los casos informativos no admiten acepta/rechaza. Solo puedes agregar un comentario opcional.'
            });
        }

        const { data: respuesta, error: rErr } = await supabase
            .from('evaluacion_respuestas_jurado')
            .insert({
                caso_id,
                asignacion_id: asig.id,
                decision:      'acepta',
                comentario:    comentario?.trim() || null
            })
            .select('id, caso_id, decision, comentario, created_at')
            .single();

        if (rErr) return res.status(500).json({ error: rErr.message });

        await auditarEval(
            eval_id, caso_id, ciclo.id,
            'responder_caso',
            { tipo_caso: 'informativo', es_reconocimiento: true, tiene_comentario: !!comentario?.trim() },
            req.usuario.id, req.usuario.nombre, 'usuario_pagado', req.ip
        );

        return res.status(201).json({
            mensaje:      'Caso informativo reconocido',
            respuesta,
            consolidado:  false
        });
    }

    // ── Caso normal: interpretativa o reglamentaria ───────────────────────────

    // 8. Validar decision
    if (!decision) return res.status(400).json({ error: 'decision requerida (acepta o rechaza)' });
    if (!['acepta', 'rechaza'].includes(decision)) {
        return res.status(400).json({ error: 'decision debe ser acepta o rechaza' });
    }
    if (decision === 'rechaza' && !comentario?.trim()) {
        return res.status(400).json({ error: 'comentario requerido cuando la decisión es rechaza' });
    }

    // 9. Insertar respuesta
    const { data: respuesta, error: rErr } = await supabase
        .from('evaluacion_respuestas_jurado')
        .insert({
            caso_id,
            asignacion_id: asig.id,
            decision,
            comentario:    comentario?.trim() || null
        })
        .select('id, caso_id, decision, comentario, created_at')
        .single();

    if (rErr) return res.status(500).json({ error: rErr.message });

    // Auditoría de respuesta
    await auditarEval(
        eval_id, caso_id, ciclo.id,
        'responder_caso',
        { decision, tiene_comentario: !!comentario?.trim() },
        req.usuario.id, req.usuario.nombre, 'usuario_pagado', req.ip
    );

    // ── Intentar consolidación ────────────────────────────────────────────────

    // 10. ¿Ya respondieron todos los jurados a este caso?
    const { count: totalRespondido } = await supabase
        .from('evaluacion_respuestas_jurado')
        .select('id', { count: 'exact', head: true })
        .eq('caso_id', caso_id);

    if ((totalRespondido ?? 0) < totalJurados) {
        return res.status(201).json({ mensaje: 'Respuesta registrada', respuesta, consolidado: false });
    }

    // 11. Leer todas las respuestas para determinar estado_consolidado
    // Regla: si al menos uno rechaza → 'rechazado'; si todos aceptan → 'aceptado'
    // 'incompleto' queda reservado para cierre manual sin respuestas completas (futuros pasos)
    const { data: todasRespuestas } = await supabase
        .from('evaluacion_respuestas_jurado')
        .select('decision')
        .eq('caso_id', caso_id);

    const hayRechaza       = (todasRespuestas || []).some(r => r.decision === 'rechaza');
    const estadoConsolidado = hayRechaza ? 'rechazado' : 'aceptado';
    const casoEstadoNuevo   = hayRechaza ? 'pendiente_analista' : 'consolidado';

    await supabase
        .from('evaluacion_casos')
        .update({
            estado:             casoEstadoNuevo,
            estado_consolidado: estadoConsolidado,
            updated_at:         new Date().toISOString()
        })
        .eq('id', caso_id);

    // Auditoría de consolidación
    const acepta_count  = (todasRespuestas || []).filter(r => r.decision === 'acepta').length;
    const rechaza_count = (todasRespuestas || []).filter(r => r.decision === 'rechaza').length;

    await auditarEval(
        eval_id, caso_id, ciclo.id,
        'consolidacion_caso',
        { estado_consolidado: estadoConsolidado, total_jurados: totalJurados, acepta_count, rechaza_count },
        req.usuario.id, req.usuario.nombre, 'usuario_pagado', req.ip
    );

    // ── Verificar si el ciclo completa su ronda ───────────────────────────────
    // Solo se cuentan casos no-informativos. Si todos tienen estado 'consolidado' o
    // 'pendiente_analista', el ciclo pasa a 'en_revision' para revisión del analista.
    const { count: casosVisiblesRestantes } = await supabase
        .from('evaluacion_casos')
        .select('id', { count: 'exact', head: true })
        .eq('ciclo_id', ciclo.id)
        .neq('tipo_caso', 'informativo')
        .eq('estado', 'visible_jurado');

    let cicloEnRevision = false;
    if ((casosVisiblesRestantes ?? 0) === 0) {
        await supabase
            .from('evaluacion_ciclos')
            .update({ estado: 'en_revision', updated_at: new Date().toISOString() })
            .eq('id', ciclo.id);

        cicloEnRevision = true;

        // Auditoría del ciclo → en_revision
        await auditarEval(
            eval_id, null, ciclo.id,
            'ciclo_en_revision',
            { numero_ciclo: ciclo.numero_ciclo, acepta_count, rechaza_count },
            req.usuario.id, req.usuario.nombre, 'usuario_pagado', req.ip
        );
    }

    res.status(201).json({
        mensaje:            'Respuesta registrada',
        respuesta,
        consolidado:        true,
        estado_consolidado: estadoConsolidado,
        caso_estado:        casoEstadoNuevo,
        ciclo_en_revision:  cicloEnRevision
    });
});

// ── GET /api/usuario/evaluaciones/:eval_id/resultado ─────────────────────────
// Detalle final de la evaluación publicada para el jurado.
// Fuente principal del resultado: notas_rodeo (registro publicado del jurado).
// evaluaciones aporta estado y estructura; no se expone nota_final global.
router.get('/:eval_id/resultado', async (req, res) => {
    if (req.usuario.tipo_persona !== 'jurado') {
        return res.status(403).json({ error: 'Solo disponible para jurados' });
    }

    const { eval_id } = req.params;

    // 1. Cargar evaluación — rodeos.id necesario para verificar asignación
    const { data: evalData } = await supabase
        .from('evaluaciones')
        .select('id, estado, rodeos(id, club, asociacion, fecha, tipo_rodeo_nombre)')
        .eq('id', eval_id)
        .single();

    if (!evalData) return res.status(404).json({ error: 'Evaluación no encontrada' });

    // 2. Solo accesible cuando está publicada o cerrada
    if (!['publicado', 'cerrado'].includes(evalData.estado)) {
        return res.status(403).json({ error: `La evaluación aún no está publicada (estado: ${evalData.estado})` });
    }

    // 3. Verificar asignación activa del jurado en el rodeo
    const asig = await obtenerAsignacionJurado(evalData.rodeos.id, req.usuario.id);
    if (!asig) return res.status(403).json({ error: 'No tienes asignación activa en el rodeo de esta evaluación' });

    // 4. Resultado personal — fuente principal: notas_rodeo de la asignación del jurado.
    //    comentario de notas_rodeo NO se expone: es campo de uso interno administrativo.
    const { data: miNota } = await supabase
        .from('notas_rodeo')
        .select('nota, puntaje_evaluacion, calificacion_cualitativa')
        .eq('asignacion_id', asig.id)
        .maybeSingle();

    // 5. Ciclos de la evaluación
    const { data: ciclos } = await supabase
        .from('evaluacion_ciclos')
        .select('id, numero_ciclo, estado')
        .eq('evaluacion_id', eval_id)
        .order('numero_ciclo', { ascending: true });

    // 6. Casos — solo campos relevantes para el jurado; campos de deliberación interna excluidos
    const { data: casos, error: casosErr } = await supabase
        .from('evaluacion_casos')
        .select('id, ciclo_id, numero_caso, tipo_caso, descuento_puntos, resolucion_final, decision_comision, comentario_comision')
        .eq('evaluacion_id', eval_id)
        .order('numero_caso', { ascending: true });

    if (casosErr) return res.status(500).json({ error: casosErr.message });

    // 7. Mis respuestas a los casos (solo las propias — votos ajenos son confidenciales)
    const casoIds = (casos || []).map(c => c.id);
    const miMapRespuestas = {};
    if (casoIds.length > 0) {
        const { data: misRespuestas } = await supabase
            .from('evaluacion_respuestas_jurado')
            .select('caso_id, decision, comentario')
            .eq('asignacion_id', asig.id)
            .in('caso_id', casoIds);
        (misRespuestas || []).forEach(r => { miMapRespuestas[r.caso_id] = r; });
    }

    // 8. Comentario final del jurado si ya existe
    const { data: miComentario } = await supabase
        .from('evaluacion_comentarios_finales')
        .select('comentario, created_at')
        .eq('evaluacion_id', eval_id)
        .eq('asignacion_id', asig.id)
        .maybeSingle();

    // 9. Agrupar casos por ciclo y enriquecer con datos del jurado
    const ciclosMap = {};
    for (const ciclo of (ciclos || [])) {
        ciclosMap[ciclo.id] = { numero_ciclo: ciclo.numero_ciclo, estado: ciclo.estado, casos: [] };
    }

    for (const caso of (casos || [])) {
        const esInformativo = caso.tipo_caso === 'informativo';
        const respJurado    = miMapRespuestas[caso.id] || null;

        // Formatear mi_respuesta diferenciando casos informativos de casos con acepta/rechaza.
        // Informativos: no requerían respuesta formal; solo reconocimiento + comentario opcional.
        let miRespuesta = null;
        if (respJurado) {
            miRespuesta = esInformativo
                ? { es_reconocimiento: true,  comentario: respJurado.comentario || null }
                : { decision: respJurado.decision, comentario: respJurado.comentario || null };
        }

        ciclosMap[caso.ciclo_id]?.casos.push({
            numero_caso:         caso.numero_caso,
            tipo_caso:           caso.tipo_caso,
            descuento_puntos:    caso.descuento_puntos,
            requiere_respuesta:  !esInformativo,
            resolucion_final:    caso.resolucion_final,
            // comentario_comision solo visible si la comisión efectivamente actuó sobre el caso
            comentario_comision: caso.decision_comision ? caso.comentario_comision : null,
            mi_respuesta:        miRespuesta
        });
    }

    res.json({
        evaluacion_id:   eval_id,
        estado:          evalData.estado,
        rodeo:           evalData.rodeos,
        mi_resultado:    miNota || null,
        ciclos:          Object.values(ciclosMap).sort((a, b) => a.numero_ciclo - b.numero_ciclo),
        comentario_final: miComentario || null
    });
});

// ── POST /api/usuario/evaluaciones/:eval_id/comentario-final ──────────────────
// Registra el comentario u observación final del jurado post-publicación.
// IMPORTANTE: este endpoint NO modifica nota, puntaje, estados de evaluación,
// ciclos ni casos. Solo inserta en evaluacion_comentarios_finales y audita.
// Un jurado puede registrar un único comentario por evaluación (UNIQUE en schema).
router.post('/:eval_id/comentario-final', async (req, res) => {
    if (req.usuario.tipo_persona !== 'jurado') {
        return res.status(403).json({ error: 'Solo disponible para jurados' });
    }

    const { eval_id } = req.params;
    const { comentario } = req.body;

    if (!comentario?.trim()) {
        return res.status(400).json({ error: 'comentario requerido' });
    }

    // 1. Cargar evaluación
    const { data: evalData } = await supabase
        .from('evaluaciones')
        .select('id, estado, rodeo_id')
        .eq('id', eval_id)
        .single();

    if (!evalData) return res.status(404).json({ error: 'Evaluación no encontrada' });

    // 2. Solo cuando publicada o cerrada
    if (!['publicado', 'cerrado'].includes(evalData.estado)) {
        return res.status(403).json({ error: `La evaluación aún no está publicada (estado: ${evalData.estado})` });
    }

    // 3. Verificar asignación activa del jurado en el rodeo
    const asig = await obtenerAsignacionJurado(evalData.rodeo_id, req.usuario.id);
    if (!asig) return res.status(403).json({ error: 'No tienes asignación activa en el rodeo de esta evaluación' });

    // 4. Verificar que no exista ya un comentario (un comentario por jurado por evaluación)
    const { data: existente, error: checkErr } = await supabase
        .from('evaluacion_comentarios_finales')
        .select('id')
        .eq('evaluacion_id', eval_id)
        .eq('asignacion_id', asig.id)
        .maybeSingle();

    if (checkErr) return res.status(500).json({ error: checkErr.message });
    if (existente) return res.status(409).json({ error: 'Ya registraste un comentario para esta evaluación' });

    // 5. Insertar comentario final
    const { data: nuevo, error: insertErr } = await supabase
        .from('evaluacion_comentarios_finales')
        .insert({
            evaluacion_id: eval_id,
            asignacion_id: asig.id,
            comentario:    comentario.trim()
        })
        .select('comentario, created_at')
        .single();

    if (insertErr) return res.status(500).json({ error: insertErr.message });

    // 6. Auditoría — acción del jurado, sin exponer contenido del comentario
    await auditarEval(
        eval_id, null, null,
        'comentario_final',
        { registrado: true },
        req.usuario.id, req.usuario.nombre, 'usuario_pagado', req.ip
    );

    res.status(201).json({
        mensaje:       'Comentario registrado',
        evaluacion_id: eval_id,
        comentario:    nuevo.comentario,
        created_at:    nuevo.created_at
    });
});

module.exports = router;
