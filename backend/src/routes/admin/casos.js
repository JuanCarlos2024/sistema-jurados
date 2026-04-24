const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');
const { soloRolEvaluacion } = require('../../middleware/auth');

// ── Helper de auditoría ───────────────────────────────────────────────────────

async function auditarEval(evaluacion_id, accion, detalle, actor_id, actor_nombre, ip) {
    try {
        await supabase.from('evaluacion_auditoria').insert({
            evaluacion_id,
            accion,
            detalle,
            actor_id,
            actor_tipo:   'administrador',
            actor_nombre,
            ip_address:   ip || null
        });
    } catch (err) {
        console.warn('[EVAL AUDIT]', err.message);
    }
}

// ── GET /api/admin/casos?evaluacion_id= ───────────────────────────────────────
// Lista todos los casos de una evaluación (todos sus ciclos)
router.get('/', async (req, res) => {
    const { evaluacion_id } = req.query;
    if (!evaluacion_id) return res.status(400).json({ error: 'evaluacion_id requerido' });

    const { data, error } = await supabase
        .from('evaluacion_casos')
        .select(`
            id, numero_caso, tipo_caso, descuento_puntos, descripcion, video_url, estado, created_at, updated_at,
            evaluacion_ciclos(id, numero_ciclo, estado)
        `)
        .eq('evaluacion_id', evaluacion_id)
        .order('numero_caso', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    res.json({ evaluacion_id, total: (data || []).length, casos: data || [] });
});

// ── PATCH /api/admin/casos/:caso_id ──────────────────────────────────────────
// Editar campos del caso antes de que el ciclo esté abierto.
// Acceso: cualquier administrador (soloAdmin aplicado por index.js — intencional)
router.patch('/:caso_id', async (req, res) => {
    const { tipo_caso, descuento_puntos, descripcion, video_url } = req.body;

    // 1. Cargar caso con su ciclo y evaluación padre
    const { data: caso } = await supabase
        .from('evaluacion_casos')
        .select(`
            id, numero_caso, tipo_caso, descuento_puntos, descripcion, video_url, estado,
            ciclo_id, evaluacion_id,
            evaluacion_ciclos(id, numero_ciclo, estado, evaluaciones(id, estado))
        `)
        .eq('id', req.params.caso_id)
        .single();

    if (!caso) return res.status(404).json({ error: 'Caso no encontrado' });

    const ciclo     = caso.evaluacion_ciclos;
    const evalPadre = ciclo.evaluaciones;

    // 2. Ciclo debe estar en estado editable
    if (!['pendiente_carga', 'cargado'].includes(ciclo.estado)) {
        return res.status(400).json({ error: `No se puede editar un caso con el ciclo en estado ${ciclo.estado}` });
    }

    // 3. Evaluación no puede estar en estado terminal
    if (['publicado', 'cerrado'].includes(evalPadre.estado)) {
        return res.status(400).json({ error: `No se puede editar un caso en una evaluación con estado ${evalPadre.estado}` });
    }

    const payload = { updated_at: new Date().toISOString() };

    // 4. Validar tipo_caso si se modifica
    if (tipo_caso !== undefined) {
        const validos = ciclo.numero_ciclo === 1
            ? ['interpretativa', 'reglamentaria']
            : ['interpretativa', 'reglamentaria', 'informativo'];

        if (!validos.includes(tipo_caso)) {
            return res.status(400).json({
                error: ciclo.numero_ciclo === 1
                    ? 'En ciclo 1 solo se permiten casos: interpretativa o reglamentaria'
                    : 'tipo_caso debe ser: interpretativa, reglamentaria o informativo'
            });
        }
        payload.tipo_caso = tipo_caso;
    }

    // tipo efectivo final para validar descuento
    const tipoCasoFinal = payload.tipo_caso ?? caso.tipo_caso;

    // 5. Validar descuento_puntos si se modifica
    if (descuento_puntos !== undefined) {
        const descuento = parseInt(descuento_puntos);
        if (![0, 1, 2].includes(descuento)) {
            return res.status(400).json({ error: 'descuento_puntos debe ser 0, 1 o 2' });
        }
        if (tipoCasoFinal === 'informativo' && descuento !== 0) {
            return res.status(400).json({ error: 'Los casos informativos no pueden tener descuento de puntos' });
        }
        payload.descuento_puntos = descuento;
    } else if (payload.tipo_caso === 'informativo' && caso.descuento_puntos > 0) {
        // Si se cambia tipo a informativo sin especificar descuento → forzar a 0
        payload.descuento_puntos = 0;
    }

    if (descripcion !== undefined) payload.descripcion = descripcion?.trim() || null;
    if (video_url   !== undefined) payload.video_url   = video_url?.trim()   || null;

    // 6. Actualizar
    const { data: casoActualizado, error: updateErr } = await supabase
        .from('evaluacion_casos')
        .update(payload)
        .eq('id', req.params.caso_id)
        .select('id, numero_caso, tipo_caso, descuento_puntos, descripcion, video_url, estado, updated_at')
        .single();

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // 7. Auditoría
    await auditarEval(
        caso.evaluacion_id,
        'editar_caso',
        {
            caso_id:    caso.id,
            numero_caso: caso.numero_caso,
            cambios:    payload
        },
        req.usuario.id,
        req.usuario.nombre,
        req.ip
    );

    res.json({ mensaje: 'Caso actualizado', caso: casoActualizado });
});

// ── DELETE /api/admin/casos/:caso_id ──────────────────────────────────────────
// Solo posible si el ciclo está en 'pendiente_carga' o 'cargado'.
// Si se elimina el último caso del ciclo, revierte el ciclo a 'pendiente_carga'
// y ese cambio queda auditado de forma independiente antes de auditar la eliminación.
router.delete('/:caso_id', async (req, res) => {
    // 1. Cargar caso con su ciclo y evaluación padre
    const { data: caso } = await supabase
        .from('evaluacion_casos')
        .select(`
            id, numero_caso, ciclo_id, evaluacion_id,
            evaluacion_ciclos(id, numero_ciclo, estado, evaluaciones(id, estado))
        `)
        .eq('id', req.params.caso_id)
        .single();

    if (!caso) return res.status(404).json({ error: 'Caso no encontrado' });

    const ciclo     = caso.evaluacion_ciclos;
    const evalPadre = ciclo.evaluaciones;

    // 2. Ciclo debe estar en estado editable
    if (!['pendiente_carga', 'cargado'].includes(ciclo.estado)) {
        return res.status(400).json({ error: `No se puede eliminar un caso con el ciclo en estado ${ciclo.estado}` });
    }

    // 3. Evaluación no puede estar en estado terminal
    if (['publicado', 'cerrado'].includes(evalPadre.estado)) {
        return res.status(400).json({ error: `No se puede eliminar un caso en una evaluación con estado ${evalPadre.estado}` });
    }

    // 4. Eliminar caso
    const { error: deleteErr } = await supabase
        .from('evaluacion_casos')
        .delete()
        .eq('id', req.params.caso_id);

    if (deleteErr) return res.status(500).json({ error: deleteErr.message });

    // 5. Contar casos restantes en el ciclo
    const { count: restantes } = await supabase
        .from('evaluacion_casos')
        .select('id', { count: 'exact', head: true })
        .eq('ciclo_id', caso.ciclo_id);

    // 6. Si era el último caso → revertir ciclo a 'pendiente_carga' y auditarlo primero
    let cicloRevertido = false;
    if ((restantes ?? 0) === 0 && ciclo.estado === 'cargado') {
        await supabase
            .from('evaluacion_ciclos')
            .update({ estado: 'pendiente_carga', updated_at: new Date().toISOString() })
            .eq('id', caso.ciclo_id);

        cicloRevertido = true;

        // Auditoría de la reversión del ciclo — separada y previa a la del caso
        await auditarEval(
            caso.evaluacion_id,
            'revertir_ciclo_pendiente',
            {
                ciclo_id:      caso.ciclo_id,
                numero_ciclo:  ciclo.numero_ciclo,
                motivo:        'último caso eliminado'
            },
            req.usuario.id,
            req.usuario.nombre,
            req.ip
        );
    }

    // 7. Auditoría de la eliminación del caso
    await auditarEval(
        caso.evaluacion_id,
        'eliminar_caso',
        {
            caso_id:                    caso.id,
            numero_caso:                caso.numero_caso,
            ciclo_id:                   caso.ciclo_id,
            ciclo_revertido_a_pendiente: cicloRevertido
        },
        req.usuario.id,
        req.usuario.nombre,
        req.ip
    );

    res.json({ mensaje: 'Caso eliminado', ciclo_revertido: cicloRevertido });
});

// ── GET /api/admin/casos/:caso_id/respuestas ──────────────────────────────────
// Vista admin: todas las respuestas de jurados a un caso + total jurados del rodeo
router.get('/:caso_id/respuestas', async (req, res) => {
    // 1. Cargar caso con su evaluación y el rodeo_id necesario para contar jurados
    const { data: caso } = await supabase
        .from('evaluacion_casos')
        .select(`
            id, numero_caso, tipo_caso, estado, estado_consolidado, evaluacion_id, ciclo_id,
            evaluacion_ciclos(numero_ciclo),
            evaluaciones(rodeo_id)
        `)
        .eq('id', req.params.caso_id)
        .single();

    if (!caso) return res.status(404).json({ error: 'Caso no encontrado' });

    // 2. Total jurados activos del rodeo
    const { count: totalJurados } = await supabase
        .from('asignaciones')
        .select('id', { count: 'exact', head: true })
        .eq('rodeo_id', caso.evaluaciones.rodeo_id)
        .eq('tipo_persona', 'jurado')
        .eq('estado', 'activo')
        .or('estado_designacion.neq.rechazado,estado_designacion.is.null');

    // 3. Respuestas con datos del jurado (via asignaciones → usuarios_pagados)
    const { data: respuestas, error } = await supabase
        .from('evaluacion_respuestas_jurado')
        .select(`
            id, decision, comentario, created_at, asignacion_id,
            asignaciones(id, usuarios_pagados(id, nombre_completo, categoria))
        `)
        .eq('caso_id', req.params.caso_id)
        .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    const respuestasFormateadas = (respuestas || []).map(r => ({
        asignacion_id: r.asignacion_id,
        jurado:        r.asignaciones?.usuarios_pagados || null,
        decision:      r.decision,
        comentario:    r.comentario,
        created_at:    r.created_at
    }));

    res.json({
        caso_id:             caso.id,
        numero_caso:         caso.numero_caso,
        tipo_caso:           caso.tipo_caso,
        numero_ciclo:        caso.evaluacion_ciclos?.numero_ciclo,
        estado:              caso.estado,
        estado_consolidado:  caso.estado_consolidado,
        total_jurados_rodeo: totalJurados ?? 0,
        respuestas:          respuestasFormateadas
    });
});

// ── POST /api/admin/casos/:caso_id/decision-analista ─────────────────────────
// Registra la decisión del analista sobre un caso rechazado por jurados.
// Acceso: analista y jefe_area (+ admin pleno con rol_evaluacion=null).
router.post('/:caso_id/decision-analista', soloRolEvaluacion('analista', 'jefe_area'), async (req, res) => {
    const { decision, comentario_analista } = req.body;

    // 1. Validar campos de entrada
    if (!decision) {
        return res.status(400).json({ error: 'decision requerida (mantener, revertir o derivar_comision)' });
    }
    if (!['mantener', 'revertir', 'derivar_comision'].includes(decision)) {
        return res.status(400).json({ error: 'decision debe ser: mantener, revertir o derivar_comision' });
    }
    if (!comentario_analista?.trim()) {
        return res.status(400).json({ error: 'comentario_analista requerido' });
    }

    // 2. Cargar caso con ciclo y evaluación padre
    const { data: caso } = await supabase
        .from('evaluacion_casos')
        .select(`
            id, numero_caso, tipo_caso, estado, estado_consolidado, ciclo_id, evaluacion_id,
            evaluacion_ciclos(id, numero_ciclo, estado),
            evaluaciones(id, estado)
        `)
        .eq('id', req.params.caso_id)
        .single();

    if (!caso) return res.status(404).json({ error: 'Caso no encontrado' });

    const ciclo     = caso.evaluacion_ciclos;
    const evalPadre = caso.evaluaciones;

    // 3. Caso debe estar en pendiente_analista
    if (caso.estado !== 'pendiente_analista') {
        return res.status(400).json({
            error: `El caso no está pendiente de decisión del analista (estado: ${caso.estado})`
        });
    }

    // 4. Ciclo debe haber completado la ronda de jurados
    if (!['en_revision', 'cerrado'].includes(ciclo.estado)) {
        return res.status(400).json({
            error: `El ciclo no está en revisión (estado: ${ciclo.estado})`
        });
    }

    // 5. Construir payload según decisión
    const ahora = new Date().toISOString();
    const casoPayload = {
        decision_analista:   decision,
        comentario_analista: comentario_analista.trim(),
        analista_decidio_en: ahora,
        analista_id:         req.usuario.id,
        updated_at:          ahora
    };

    if (decision === 'mantener') {
        // Mantiene la decisión de rechazo de los jurados; estado_consolidado no cambia.
        casoPayload.estado            = 'resuelto';
        casoPayload.resolucion_final  = 'apelacion_rechazada';
    } else if (decision === 'revertir') {
        // Revierte el rechazo. estado_consolidado refleja la votación histórica de jurados
        // y no se modifica; la reversión queda registrada en resolucion_final.
        casoPayload.estado            = 'resuelto';
        casoPayload.resolucion_final  = 'apelacion_acogida';
    } else {
        // derivar_comision: eleva el caso a la comisión técnica para resolución final.
        casoPayload.estado = 'derivado_comision';
    }

    // 6. Actualizar caso
    const { data: casoActualizado, error: updateErr } = await supabase
        .from('evaluacion_casos')
        .update(casoPayload)
        .eq('id', req.params.caso_id)
        .select('id, numero_caso, estado, estado_consolidado, resolucion_final, decision_analista, comentario_analista, analista_decidio_en')
        .single();

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // 7. Auditoría de la decisión
    await auditarEval(
        caso.evaluacion_id,
        'decision_analista',
        {
            caso_id:           caso.id,
            numero_caso:       caso.numero_caso,
            decision,
            ciclo_id:          ciclo.id,
            numero_ciclo:      ciclo.numero_ciclo,
            estado_caso_nuevo: casoPayload.estado
        },
        req.usuario.id,
        req.usuario.nombre,
        req.ip
    );

    // ── Cierre automático del ciclo actual + recálculo del estado global ──────

    // 8. Contar pendientes aún en el ciclo actual — si quedan, no hay nada más que calcular
    const { count: pendientesCiclo } = await supabase
        .from('evaluacion_casos')
        .select('id', { count: 'exact', head: true })
        .eq('ciclo_id', ciclo.id)
        .eq('estado', 'pendiente_analista');

    if ((pendientesCiclo ?? 0) > 0) {
        return res.status(201).json({
            caso:                  casoActualizado,
            ciclo_cerrado:         false,
            evaluacion_actualizada: false
        });
    }

    // 9. El ciclo actual quedó sin pendientes — contar derivados solo en este ciclo
    //    para decidir si se cierra automáticamente.
    const { count: derivadosCiclo } = await supabase
        .from('evaluacion_casos')
        .select('id', { count: 'exact', head: true })
        .eq('ciclo_id', ciclo.id)
        .eq('estado', 'derivado_comision');

    let cicloCerrado          = false;
    let evaluacionActualizada = false;

    // 10. Sin pendientes ni derivados en el ciclo → cerrarlo automáticamente
    if ((derivadosCiclo ?? 0) === 0 && ciclo.estado !== 'cerrado') {
        await supabase
            .from('evaluacion_ciclos')
            .update({
                estado:        'cerrado',
                fecha_cierre:  ahora,
                cerrado_por:   req.usuario.id,
                motivo_cierre: 'Revisión del analista completada sin derivaciones',
                updated_at:    ahora
            })
            .eq('id', ciclo.id);

        await auditarEval(
            caso.evaluacion_id,
            'ciclo_cerrado_por_analista',
            {
                ciclo_id:     ciclo.id,
                numero_ciclo: ciclo.numero_ciclo,
                motivo:       'Revisión completada sin derivaciones a comisión'
            },
            req.usuario.id,
            req.usuario.nombre,
            req.ip
        );

        cicloCerrado = true;
    }

    // 11. Recalcular estado global considerando TODOS los ciclos de la evaluación
    //     Solo se actúa si no quedan pendiente_analista en ningún ciclo.
    const { count: pendientesEval } = await supabase
        .from('evaluacion_casos')
        .select('id', { count: 'exact', head: true })
        .eq('evaluacion_id', caso.evaluacion_id)
        .eq('estado', 'pendiente_analista');

    if ((pendientesEval ?? 0) === 0) {
        const { count: derivadosEval } = await supabase
            .from('evaluacion_casos')
            .select('id', { count: 'exact', head: true })
            .eq('evaluacion_id', caso.evaluacion_id)
            .eq('estado', 'derivado_comision');

        if ((derivadosEval ?? 0) > 0) {
            // 11a. Hay derivaciones en cualquier ciclo → pendiente_comision
            await supabase
                .from('evaluaciones')
                .update({ estado: 'pendiente_comision', updated_at: ahora })
                .eq('id', caso.evaluacion_id);

            await auditarEval(
                caso.evaluacion_id,
                'evaluacion_a_pendiente_comision',
                { derivados_count: derivadosEval },
                req.usuario.id,
                req.usuario.nombre,
                req.ip
            );

            evaluacionActualizada = true;
        } else {
            // 11b. Sin derivaciones — verificar si todos los ciclos de la evaluación
            //      están cerrados para pasar a pendiente_aprobacion.
            const { data: ciclosEval } = await supabase
                .from('evaluacion_ciclos')
                .select('id, numero_ciclo, estado')
                .eq('evaluacion_id', caso.evaluacion_id);

            const todosCerrados = (ciclosEval || []).every(c => c.estado === 'cerrado');

            if (todosCerrados) {
                await supabase
                    .from('evaluaciones')
                    .update({ estado: 'pendiente_aprobacion', updated_at: ahora })
                    .eq('id', caso.evaluacion_id);

                await auditarEval(
                    caso.evaluacion_id,
                    'evaluacion_a_pendiente_aprobacion',
                    {
                        ciclos: (ciclosEval || []).map(c => ({ numero_ciclo: c.numero_ciclo, estado: c.estado }))
                    },
                    req.usuario.id,
                    req.usuario.nombre,
                    req.ip
                );

                evaluacionActualizada = true;
            }
            // else: algún ciclo sigue en curso → evaluación se mantiene en en_proceso
        }
    }

    res.status(201).json({
        caso:                  casoActualizado,
        ciclo_cerrado:         cicloCerrado,
        evaluacion_actualizada: evaluacionActualizada
    });
});

// ── POST /api/admin/casos/:caso_id/decision-comision ─────────────────────────
// Registra la decisión de la comisión técnica sobre un caso derivado.
// Acceso: comision_tecnica y jefe_area (+ admin pleno con rol_evaluacion=null).
router.post('/:caso_id/decision-comision', soloRolEvaluacion('comision_tecnica', 'jefe_area'), async (req, res) => {
    const { decision_comision, comentario_comision } = req.body;

    // 1. Validar campos de entrada
    if (!decision_comision) {
        return res.status(400).json({ error: 'decision_comision requerida (aprueba_apelacion o rechaza_apelacion)' });
    }
    if (!['aprueba_apelacion', 'rechaza_apelacion'].includes(decision_comision)) {
        return res.status(400).json({ error: 'decision_comision debe ser: aprueba_apelacion o rechaza_apelacion' });
    }
    if (!comentario_comision?.trim()) {
        return res.status(400).json({ error: 'comentario_comision requerido' });
    }

    // 2. Cargar caso con ciclo y evaluación padre
    const { data: caso } = await supabase
        .from('evaluacion_casos')
        .select(`
            id, numero_caso, tipo_caso, estado, estado_consolidado, ciclo_id, evaluacion_id,
            evaluacion_ciclos(id, numero_ciclo, estado),
            evaluaciones(id, estado)
        `)
        .eq('id', req.params.caso_id)
        .single();

    if (!caso) return res.status(404).json({ error: 'Caso no encontrado' });

    const ciclo     = caso.evaluacion_ciclos;
    const evalPadre = caso.evaluaciones;

    // 3. Evaluación no puede estar en estado terminal
    if (['aprobado', 'publicado', 'cerrado'].includes(evalPadre.estado)) {
        return res.status(400).json({
            error: `No se puede registrar decisión de comisión en una evaluación con estado ${evalPadre.estado}`
        });
    }

    // 4. Caso debe estar en derivado_comision
    if (caso.estado !== 'derivado_comision') {
        return res.status(400).json({
            error: `El caso no está derivado a comisión (estado: ${caso.estado})`
        });
    }

    // 5. Ciclo debe haber completado la ronda de jurados
    if (!['en_revision', 'cerrado'].includes(ciclo.estado)) {
        return res.status(400).json({
            error: `El ciclo no está en estado válido para decisión de comisión (estado: ${ciclo.estado})`
        });
    }

    // 6. Determinar resolucion_final y construir payload
    const ahora          = new Date().toISOString();
    const resolucionFinal = decision_comision === 'aprueba_apelacion' ? 'apelacion_acogida' : 'apelacion_rechazada';

    // estado_consolidado refleja la votación histórica de jurados y no se modifica.
    const casoPayload = {
        decision_comision:   decision_comision,
        comentario_comision: comentario_comision.trim(),
        comision_decidio_en: ahora,
        comision_miembro_id: req.usuario.id,
        estado:              'resuelto',
        resolucion_final:    resolucionFinal,
        updated_at:          ahora
    };

    // 7. Actualizar caso
    const { data: casoActualizado, error: updateErr } = await supabase
        .from('evaluacion_casos')
        .update(casoPayload)
        .eq('id', req.params.caso_id)
        .select('id, numero_caso, estado, estado_consolidado, resolucion_final, decision_comision, comentario_comision, comision_decidio_en')
        .single();

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // 8. Auditoría de la decisión de comisión por caso
    await auditarEval(
        caso.evaluacion_id,
        'decision_comision',
        {
            caso_id:          caso.id,
            numero_caso:      caso.numero_caso,
            decision_comision,
            resolucion_final:  resolucionFinal,
            ciclo_id:         ciclo.id,
            numero_ciclo:     ciclo.numero_ciclo
        },
        req.usuario.id,
        req.usuario.nombre,
        req.ip
    );

    // ── Cierre automático del ciclo + recálculo del estado global ─────────────

    // 9. El ciclo se cierra automáticamente solo cuando TODOS sus casos están en estado
    //    final para esta etapa: ninguno debe quedar en 'pendiente_analista' ni 'derivado_comision'.
    const { count: pendientesCiclo } = await supabase
        .from('evaluacion_casos')
        .select('id', { count: 'exact', head: true })
        .eq('ciclo_id', ciclo.id)
        .in('estado', ['pendiente_analista', 'derivado_comision']);

    let cicloCerrado          = false;
    let evaluacionActualizada = false;
    let evaluacionEstadoNuevo = null;

    if ((pendientesCiclo ?? 0) === 0 && ciclo.estado !== 'cerrado') {
        // 10. Todos los casos del ciclo en estado final → cerrar ciclo automáticamente
        await supabase
            .from('evaluacion_ciclos')
            .update({
                estado:        'cerrado',
                fecha_cierre:  ahora,
                cerrado_por:   req.usuario.id,
                motivo_cierre: 'Resolución de comisión técnica completada',
                updated_at:    ahora
            })
            .eq('id', ciclo.id);

        await auditarEval(
            caso.evaluacion_id,
            'ciclo_cerrado_por_comision',
            {
                ciclo_id:     ciclo.id,
                numero_ciclo: ciclo.numero_ciclo,
                motivo:       'Resolución de comisión técnica completada'
            },
            req.usuario.id,
            req.usuario.nombre,
            req.ip
        );

        cicloCerrado = true;
    }

    // 11. Recalcular estado global considerando TODOS los ciclos de la evaluación.
    //     Solo se actúa cuando no quedan casos pendiente_analista ni derivado_comision en ningún ciclo.
    const { count: pendientesEval } = await supabase
        .from('evaluacion_casos')
        .select('id', { count: 'exact', head: true })
        .eq('evaluacion_id', caso.evaluacion_id)
        .in('estado', ['pendiente_analista', 'derivado_comision']);

    if ((pendientesEval ?? 0) === 0) {
        const { data: ciclosEval } = await supabase
            .from('evaluacion_ciclos')
            .select('id, numero_ciclo, estado')
            .eq('evaluacion_id', caso.evaluacion_id);

        const todosCerrados = (ciclosEval || []).every(c => c.estado === 'cerrado');

        // Solo avanzar si la evaluación no está ya en un estado igual o posterior.
        const estadosSuperados = ['pendiente_aprobacion', 'aprobado', 'publicado', 'cerrado'];
        if (todosCerrados && !estadosSuperados.includes(evalPadre.estado)) {
            await supabase
                .from('evaluaciones')
                .update({ estado: 'pendiente_aprobacion', updated_at: ahora })
                .eq('id', caso.evaluacion_id);

            await auditarEval(
                caso.evaluacion_id,
                'evaluacion_a_pendiente_aprobacion',
                {
                    ciclos: (ciclosEval || []).map(c => ({ numero_ciclo: c.numero_ciclo, estado: c.estado }))
                },
                req.usuario.id,
                req.usuario.nombre,
                req.ip
            );

            evaluacionActualizada = true;
            evaluacionEstadoNuevo = 'pendiente_aprobacion';
        }
    }

    res.status(201).json({
        caso:                   casoActualizado,
        ciclo_cerrado:          cicloCerrado,
        evaluacion_actualizada: evaluacionActualizada,
        evaluacion_estado_nuevo: evaluacionEstadoNuevo
    });
});

module.exports = router;
