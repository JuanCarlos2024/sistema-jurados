const express   = require('express');
const router    = express.Router();
const supabase  = require('../../config/supabase');
const { soloRolEvaluacion } = require('../../middleware/auth');

// ── Helpers internos ──────────────────────────────────────────────────────────

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
        // No interrumpe el flujo principal
        console.warn('[EVAL AUDIT]', err.message);
    }
}

async function validarAdminActivo(id) {
    const { data } = await supabase
        .from('administradores')
        .select('id, nombre_completo')
        .eq('id', id)
        .eq('activo', true)
        .single();
    return data || null;
}

// ── POST /api/admin/evaluaciones ─────────────────────────────────────────────
// Decisión intencional: soloAdmin ya fue aplicado por admin/index.js.
// soloRolEvaluacion es autocontenido (verifica token internamente) para
// reutilizarse fuera del grupo /admin en pasos futuros sin cambios.
router.post('/', soloRolEvaluacion('jefe_area'), async (req, res) => {
    const { rodeo_id, analista_id, observacion_general } = req.body;

    if (!rodeo_id) return res.status(400).json({ error: 'rodeo_id requerido' });

    // 1. Verificar que el rodeo existe
    const { data: rodeo } = await supabase
        .from('rodeos')
        .select('id, club, asociacion, fecha, tipo_rodeo_nombre, duracion_dias, estado')
        .eq('id', rodeo_id)
        .single();

    if (!rodeo) return res.status(404).json({ error: 'Rodeo no encontrado' });

    // 2. Verificar que no existe ya una evaluación para este rodeo
    // maybeSingle() retorna null sin error cuando no hay fila — correcto para check de existencia.
    // single() lanzaría error PGRST116 si no encuentra fila, lo que confundiría el flujo.
    const { data: existente, error: existErr } = await supabase
        .from('evaluaciones')
        .select('id')
        .eq('rodeo_id', rodeo_id)
        .maybeSingle();

    if (existErr) return res.status(500).json({ error: 'Error al verificar evaluación existente: ' + existErr.message });

    if (existente) {
        return res.status(409).json({ error: 'Ya existe una evaluación para este rodeo' });
    }

    // 3. Validar analista si fue proporcionado
    let analistaData = null;
    if (analista_id) {
        analistaData = await validarAdminActivo(analista_id);
        if (!analistaData) {
            return res.status(400).json({ error: 'Analista no encontrado o inactivo' });
        }
    }

    // 4. Leer configuración activa (puntaje_base, límites de ciclos)
    const { data: config } = await supabase
        .from('evaluacion_configuracion')
        .select('puntaje_base, min_casos_ciclo1, max_casos_ciclo1, min_casos_ciclo2, max_casos_ciclo2')
        .eq('activo', true)
        .single();

    if (!config) {
        return res.status(500).json({ error: 'No hay configuración activa del módulo de evaluación' });
    }

    // ── Creación manual: eval + 2 ciclos ─────────────────────────────────────
    // IMPORTANTE: esta secuencia NO es transaccional. No existe rollback automático
    // de base de datos. El rollback manual (DELETEs secuenciales en caso de error)
    // reduce el riesgo de dejar datos huérfanos, pero NO lo elimina: si el proceso
    // Node muere entre pasos o el DELETE de reversión también falla, puede quedar
    // una evaluación sin ciclos. Riesgo aceptado para fase 1; migrar a RPC SQL si
    // en el futuro se requiere garantía transaccional completa.

    // 5. Insertar evaluación
    const { data: evalData, error: evalErr } = await supabase
        .from('evaluaciones')
        .insert({
            rodeo_id,
            analista_id:        analista_id || null,
            estado:             'borrador',
            puntaje_base:       config.puntaje_base,
            observacion_general: observacion_general?.trim() || null,
            creado_por:         req.usuario.id
        })
        .select('id, rodeo_id, analista_id, estado, puntaje_base, observacion_general, created_at')
        .single();

    if (evalErr || !evalData) {
        return res.status(500).json({ error: 'Error al crear evaluación: ' + (evalErr?.message || 'sin datos') });
    }

    const eval_id = evalData.id;

    // 6. Insertar ciclo 1
    const { data: ciclo1, error: c1Err } = await supabase
        .from('evaluacion_ciclos')
        .insert({
            evaluacion_id: eval_id,
            numero_ciclo:  1,
            estado:        'pendiente_carga',
            min_casos:     config.min_casos_ciclo1,
            max_casos:     config.max_casos_ciclo1
        })
        .select('id, numero_ciclo, estado, min_casos, max_casos')
        .single();

    if (c1Err || !ciclo1) {
        // Revertir: borrar evaluación (ciclos aún no existen)
        await supabase.from('evaluaciones').delete().eq('id', eval_id);
        console.error('[EVAL] Error ciclo 1, evaluación revertida:', c1Err?.message);
        return res.status(500).json({ error: 'Error al crear ciclo 1: ' + (c1Err?.message || 'sin datos') });
    }

    // 7. Insertar ciclo 2
    const { data: ciclo2, error: c2Err } = await supabase
        .from('evaluacion_ciclos')
        .insert({
            evaluacion_id: eval_id,
            numero_ciclo:  2,
            estado:        'pendiente_carga',
            min_casos:     config.min_casos_ciclo2,
            max_casos:     config.max_casos_ciclo2
        })
        .select('id, numero_ciclo, estado, min_casos, max_casos')
        .single();

    if (c2Err || !ciclo2) {
        // Revertir: borrar ciclo 1 primero (FK), luego evaluación
        await supabase.from('evaluacion_ciclos').delete().eq('id', ciclo1.id);
        await supabase.from('evaluaciones').delete().eq('id', eval_id);
        console.error('[EVAL] Error ciclo 2, evaluación revertida:', c2Err?.message);
        return res.status(500).json({ error: 'Error al crear ciclo 2: ' + (c2Err?.message || 'sin datos') });
    }

    // 8. Auditoría (solo si los 3 inserts tuvieron éxito)
    await auditarEval(
        eval_id,
        'crear_evaluacion',
        {
            rodeo_id,
            analista_id:  analista_id || null,
            puntaje_base: config.puntaje_base
        },
        req.usuario.id,
        req.usuario.nombre,
        req.ip
    );

    res.status(201).json({
        evaluacion: {
            ...evalData,
            ciclos: [ciclo1, ciclo2]
        }
    });
});

// ── GET /api/admin/evaluaciones ───────────────────────────────────────────────
// Acceso: cualquier administrador (soloAdmin ya aplicado por index.js)
router.get('/', async (req, res) => {
    const { estado, rodeo_id, analista_id, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
        .from('evaluaciones')
        .select(`
            id, estado, puntaje_base, nota_publicada, observacion_general, created_at,
            rodeos!inner(id, club, asociacion, fecha, tipo_rodeo_nombre, duracion_dias, estado),
            analista:administradores!evaluaciones_analista_id_fkey(id, nombre_completo)
        `, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + parseInt(limit) - 1);

    if (estado)     query = query.eq('estado', estado);
    if (rodeo_id)   query = query.eq('rodeo_id', rodeo_id);
    if (analista_id) query = query.eq('analista_id', analista_id);

    const { data, error, count } = await query;

    if (error) return res.status(500).json({ error: error.message });

    res.json({ total: count ?? 0, evaluaciones: data || [] });
});

// ── GET /api/admin/evaluaciones/:id ──────────────────────────────────────────
// Acceso: cualquier administrador (soloAdmin ya aplicado por index.js)
router.get('/:id', async (req, res) => {
    const { data: evalData, error } = await supabase
        .from('evaluaciones')
        .select(`
            id, estado,
            puntaje_base, puntaje_final, nota_final, nota_publicada,
            observacion_general,
            decision_jefe, comentario_jefe, fecha_decision_jefe,
            created_at, updated_at,
            rodeos!inner(id, club, asociacion, fecha, tipo_rodeo_nombre, duracion_dias, estado),
            analista:administradores!evaluaciones_analista_id_fkey(id, nombre_completo),
            creado_por:administradores!evaluaciones_creado_por_fkey(id, nombre_completo),
            jefe:administradores!evaluaciones_jefe_id_fkey(id, nombre_completo)
        `)
        .eq('id', req.params.id)
        .single();

    if (error || !evalData) return res.status(404).json({ error: 'Evaluación no encontrada' });

    // Ciclos
    const { data: ciclos } = await supabase
        .from('evaluacion_ciclos')
        .select(`
            id, numero_ciclo, estado, min_casos, max_casos,
            fecha_apertura, fecha_cierre, motivo_cierre,
            fecha_reapertura, motivo_reapertura
        `)
        .eq('evaluacion_id', req.params.id)
        .order('numero_ciclo', { ascending: true });

    // Auditoría — últimas 20 entradas
    const { data: auditoria } = await supabase
        .from('evaluacion_auditoria')
        .select('accion, detalle, actor_nombre, created_at')
        .eq('evaluacion_id', req.params.id)
        .order('created_at', { ascending: false })
        .limit(20);

    res.json({
        ...evalData,
        ciclos:    ciclos   || [],
        auditoria: auditoria || []
    });
});

// ── GET /api/admin/evaluaciones/:eval_id/revision ────────────────────────────
// Vista del analista: casos pendientes de su decisión (default) o por estado.
// Acceso: analista y jefe_area (+ admin pleno con rol_evaluacion=null).
router.get('/:eval_id/revision', soloRolEvaluacion('analista', 'jefe_area'), async (req, res) => {
    const { eval_id } = req.params;
    const estadoFiltro = req.query.estado || 'pendiente_analista';

    // 1. Cargar evaluación
    const { data: evalData } = await supabase
        .from('evaluaciones')
        .select(`
            id, estado, puntaje_base, observacion_general,
            rodeos(id, club, asociacion, fecha, tipo_rodeo_nombre)
        `)
        .eq('id', eval_id)
        .single();

    if (!evalData) return res.status(404).json({ error: 'Evaluación no encontrada' });

    // 2. Casos filtrados con sus respuestas de jurados
    const { data: casos, error: casosErr } = await supabase
        .from('evaluacion_casos')
        .select(`
            id, numero_caso, tipo_caso, estado, estado_consolidado,
            descripcion, video_url, descuento_puntos,
            decision_analista, comentario_analista, analista_decidio_en,
            evaluacion_ciclos(id, numero_ciclo, estado),
            evaluacion_respuestas_jurado(
                decision, comentario, created_at,
                asignaciones(usuarios_pagados(id, nombre_completo, categoria))
            )
        `)
        .eq('evaluacion_id', eval_id)
        .eq('estado', estadoFiltro)
        .order('numero_caso', { ascending: true });

    if (casosErr) return res.status(500).json({ error: casosErr.message });

    // 3. Agrupar casos por ciclo
    const ciclosMap = {};
    for (const caso of (casos || [])) {
        const ciclo = caso.evaluacion_ciclos;
        if (!ciclosMap[ciclo.id]) {
            ciclosMap[ciclo.id] = {
                id:           ciclo.id,
                numero_ciclo: ciclo.numero_ciclo,
                estado:       ciclo.estado,
                casos:        []
            };
        }
        const { evaluacion_ciclos, evaluacion_respuestas_jurado, ...restCaso } = caso;
        ciclosMap[ciclo.id].casos.push({
            ...restCaso,
            respuestas: (evaluacion_respuestas_jurado || []).map(r => ({
                decision:   r.decision,
                comentario: r.comentario,
                created_at: r.created_at,
                jurado:     r.asignaciones?.usuarios_pagados || null
            }))
        });
    }

    res.json({
        evaluacion_id: eval_id,
        estado:        evalData.estado,
        rodeo:         evalData.rodeos,
        estado_filtro: estadoFiltro,
        total_casos:   (casos || []).length,
        ciclos:        Object.values(ciclosMap).sort((a, b) => a.numero_ciclo - b.numero_ciclo)
    });
});

// ── GET /api/admin/evaluaciones/:eval_id/comision ────────────────────────────
// Bandeja de comisión técnica: casos derivados (default) o por estado.
// Acceso: comision_tecnica y jefe_area (+ admin pleno con rol_evaluacion=null).
router.get('/:eval_id/comision', soloRolEvaluacion('comision_tecnica', 'jefe_area'), async (req, res) => {
    const { eval_id } = req.params;
    const estadoFiltro = req.query.estado || 'derivado_comision';

    // 1. Cargar evaluación
    const { data: evalData } = await supabase
        .from('evaluaciones')
        .select(`
            id, estado, puntaje_base, observacion_general,
            rodeos(id, club, asociacion, fecha, tipo_rodeo_nombre)
        `)
        .eq('id', eval_id)
        .single();

    if (!evalData) return res.status(404).json({ error: 'Evaluación no encontrada' });

    // 2. Casos filtrados con respuestas de jurados y datos de analista/comisión
    const { data: casos, error: casosErr } = await supabase
        .from('evaluacion_casos')
        .select(`
            id, numero_caso, tipo_caso, estado, estado_consolidado,
            descripcion, video_url, descuento_puntos, resolucion_final,
            decision_analista, comentario_analista, analista_decidio_en,
            decision_comision, comentario_comision, comision_decidio_en,
            evaluacion_ciclos(id, numero_ciclo, estado),
            evaluacion_respuestas_jurado(
                decision, comentario, created_at,
                asignaciones(usuarios_pagados(id, nombre_completo, categoria))
            )
        `)
        .eq('evaluacion_id', eval_id)
        .eq('estado', estadoFiltro)
        .order('numero_caso', { ascending: true });

    if (casosErr) return res.status(500).json({ error: casosErr.message });

    // 3. Agrupar casos por ciclo
    const ciclosMap = {};
    for (const caso of (casos || [])) {
        const ciclo = caso.evaluacion_ciclos;
        if (!ciclosMap[ciclo.id]) {
            ciclosMap[ciclo.id] = {
                id:           ciclo.id,
                numero_ciclo: ciclo.numero_ciclo,
                estado:       ciclo.estado,
                casos:        []
            };
        }
        const { evaluacion_ciclos, evaluacion_respuestas_jurado, ...restCaso } = caso;
        ciclosMap[ciclo.id].casos.push({
            ...restCaso,
            respuestas: (evaluacion_respuestas_jurado || []).map(r => ({
                decision:   r.decision,
                comentario: r.comentario,
                created_at: r.created_at,
                jurado:     r.asignaciones?.usuarios_pagados || null
            }))
        });
    }

    res.json({
        evaluacion_id: eval_id,
        estado:        evalData.estado,
        rodeo:         evalData.rodeos,
        estado_filtro: estadoFiltro,
        total_casos:   (casos || []).length,
        ciclos:        Object.values(ciclosMap).sort((a, b) => a.numero_ciclo - b.numero_ciclo)
    });
});

// ── PATCH /api/admin/evaluaciones/:id/analista ────────────────────────────────
// Decisión intencional: soloAdmin ya fue aplicado por admin/index.js.
// soloRolEvaluacion agrega restricción de rol específico (jefe_area + admin pleno).
router.patch('/:id/analista', soloRolEvaluacion('jefe_area'), async (req, res) => {
    const { analista_id } = req.body;

    if (!analista_id) return res.status(400).json({ error: 'analista_id requerido' });

    // 1. Verificar que la evaluación existe
    const { data: evalData } = await supabase
        .from('evaluaciones')
        .select('id, estado, analista_id')
        .eq('id', req.params.id)
        .single();

    if (!evalData) return res.status(404).json({ error: 'Evaluación no encontrada' });

    // 2. Bloquear reasignación en estados donde la evaluación ya está consolidada o terminada
    if (['aprobado', 'publicado', 'cerrado'].includes(evalData.estado)) {
        return res.status(400).json({
            error: `No se puede reasignar analista en estado ${evalData.estado}`
        });
    }

    // 3. Validar que el nuevo analista existe y está activo
    const analistaData = await validarAdminActivo(analista_id);
    if (!analistaData) {
        return res.status(400).json({ error: 'Analista no encontrado o inactivo' });
    }

    // 4. Idempotencia: si el analista ya es el mismo, retornar sin cambios
    if (evalData.analista_id === analista_id) {
        return res.json({
            mensaje:        'Sin cambios (el analista ya era el asignado)',
            evaluacion_id:  req.params.id,
            analista_id,
            analista_nombre: analistaData.nombre_completo
        });
    }

    // 5. Actualizar
    const { error: updateErr } = await supabase
        .from('evaluaciones')
        .update({ analista_id, updated_at: new Date().toISOString() })
        .eq('id', req.params.id);

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // 6. Auditoría diferenciada
    const accion = evalData.analista_id ? 'reasignar_analista' : 'asignar_analista';
    await auditarEval(
        req.params.id,
        accion,
        {
            analista_anterior: evalData.analista_id || null,
            analista_nuevo:    analista_id,
            nombre_nuevo:      analistaData.nombre_completo
        },
        req.usuario.id,
        req.usuario.nombre,
        req.ip
    );

    const mensaje = evalData.analista_id ? 'Analista reasignado' : 'Analista asignado';
    res.json({ mensaje, evaluacion_id: req.params.id, analista_id, analista_nombre: analistaData.nombre_completo });
});

// ── POST /api/admin/evaluaciones/:id/enviar-aprobacion ───────────────────────
// Envía formalmente la evaluación a revisión del jefe.
// Válido desde 'pendiente_aprobacion' (primera vez / re-validación)
// y desde 'devuelto' (re-envío tras devolución del jefe).
// Acceso: analista y jefe_area (+ admin pleno).
router.post('/:id/enviar-aprobacion', soloRolEvaluacion('analista', 'jefe_area'), async (req, res) => {
    const { jefe_id } = req.body;

    // 1. Cargar evaluación
    const { data: evalData } = await supabase
        .from('evaluaciones')
        .select('id, estado, jefe_id')
        .eq('id', req.params.id)
        .single();

    if (!evalData) return res.status(404).json({ error: 'Evaluación no encontrada' });

    // 2. Estado debe ser 'pendiente_aprobacion' o 'devuelto'
    if (!['pendiente_aprobacion', 'devuelto'].includes(evalData.estado)) {
        return res.status(400).json({
            error: `No se puede enviar a aprobación desde estado ${evalData.estado}`
        });
    }

    // 3. Todos los ciclos deben estar cerrados
    const { data: ciclos } = await supabase
        .from('evaluacion_ciclos')
        .select('id, numero_ciclo, estado')
        .eq('evaluacion_id', req.params.id);

    const cicloAbierto = (ciclos || []).find(c => c.estado !== 'cerrado');
    if (cicloAbierto) {
        return res.status(400).json({
            error: `No todos los ciclos están cerrados (ciclo ${cicloAbierto.numero_ciclo}: ${cicloAbierto.estado})`
        });
    }

    // 4. Sin casos pendientes de analista ni comisión en ningún ciclo
    const { count: pendientes } = await supabase
        .from('evaluacion_casos')
        .select('id', { count: 'exact', head: true })
        .eq('evaluacion_id', req.params.id)
        .in('estado', ['pendiente_analista', 'derivado_comision']);

    if ((pendientes ?? 0) > 0) {
        return res.status(400).json({
            error: `Existen ${pendientes} caso(s) pendientes de resolución (analista o comisión)`
        });
    }

    // 5. Validar jefe_id si se proporcionó
    let jefeNombre = null;
    if (jefe_id) {
        const jefe = await validarAdminActivo(jefe_id);
        if (!jefe) return res.status(400).json({ error: 'Jefe no encontrado o inactivo' });
        jefeNombre = jefe.nombre_completo;
    }

    // 6. Actualizar y auditar solo si hay cambios reales:
    //    - re-envío desde 'devuelto' → cambia estado a 'pendiente_aprobacion'
    //    - 'pendiente_aprobacion' + jefe_id distinto → actualiza solo jefe_id
    //    - 'pendiente_aprobacion' sin cambios → idempotente: sin escritura ni auditoría
    const ahora          = new Date().toISOString();
    const debeActualizar = evalData.estado === 'devuelto' || (jefe_id && jefe_id !== evalData.jefe_id);

    if (debeActualizar) {
        const payload = { updated_at: ahora };
        if (evalData.estado === 'devuelto')              payload.estado   = 'pendiente_aprobacion';
        if (jefe_id && jefe_id !== evalData.jefe_id)    payload.jefe_id  = jefe_id;

        const { error: updateErr } = await supabase
            .from('evaluaciones')
            .update(payload)
            .eq('id', req.params.id);

        if (updateErr) return res.status(500).json({ error: updateErr.message });

        // 7. Auditoría — solo cuando hubo cambio real
        await auditarEval(
            req.params.id,
            'enviar_aprobacion',
            {
                estado_anterior: evalData.estado,
                estado_nuevo:    evalData.estado === 'devuelto' ? 'pendiente_aprobacion' : evalData.estado,
                jefe_id:         jefe_id || evalData.jefe_id || null,
                jefe_nombre:     jefeNombre
            },
            req.usuario.id,
            req.usuario.nombre,
            req.ip
        );
    }

    const esReenvio = evalData.estado === 'devuelto';
    res.json({
        mensaje:       esReenvio ? 'Evaluación re-enviada a aprobación del jefe' : 'Evaluación enviada a aprobación del jefe',
        evaluacion_id: req.params.id,
        estado:        esReenvio ? 'pendiente_aprobacion' : evalData.estado,
        jefe_id:       jefe_id || evalData.jefe_id || null
    });
});

// ── POST /api/admin/evaluaciones/:id/aprobar ──────────────────────────────────
// El jefe aprueba y publica la evaluación vía RPC publicar_evaluacion().
// El RPC es transaccional: calcula puntaje/nota, hace UPSERT en notas_rodeo,
// actualiza evaluaciones a 'publicado' y registra auditoría internamente.
// El backend no modifica estado ni audita de forma adicional.
// Acceso: solo jefe_area (+ admin pleno).
router.post('/:id/aprobar', soloRolEvaluacion('jefe_area'), async (req, res) => {
    const { comentario_jefe } = req.body;

    // 1. Verificar estado antes del RPC para dar error claro al usuario
    const { data: evalData } = await supabase
        .from('evaluaciones')
        .select('id, estado')
        .eq('id', req.params.id)
        .single();

    if (!evalData) return res.status(404).json({ error: 'Evaluación no encontrada' });

    if (evalData.estado !== 'pendiente_aprobacion') {
        return res.status(400).json({
            error: `Solo se puede aprobar una evaluación en estado pendiente_aprobacion (actual: ${evalData.estado})`
        });
    }

    // 2. Llamar al RPC. Si falla, revierte automáticamente — no tocar estado manualmente.
    const { data: resultado, error: rpcErr } = await supabase.rpc('publicar_evaluacion', {
        p_evaluacion_id: req.params.id,
        p_jefe_id:       req.usuario.id,
        p_comentario:    comentario_jefe?.trim() || null,
        p_ip:            req.ip || null
    });

    if (rpcErr) {
        const msg = rpcErr.message || rpcErr.details || 'Error al publicar la evaluación';
        return res.status(500).json({ error: msg });
    }

    res.json({
        mensaje:                     'Evaluación aprobada y publicada',
        evaluacion_id:               req.params.id,
        estado:                      'publicado',
        puntaje_final:               resultado.puntaje_final,
        nota_final:                  resultado.nota_final,
        jurados_afectados:           resultado.jurados_afectados,
        sobreescrituras_nota_manual: resultado.sobreescrituras_nota_manual
    });
});

// ── POST /api/admin/evaluaciones/:id/devolver ─────────────────────────────────
// El jefe devuelve la evaluación al analista con comentario obligatorio.
// Acceso: solo jefe_area (+ admin pleno).
router.post('/:id/devolver', soloRolEvaluacion('jefe_area'), async (req, res) => {
    const { comentario_jefe } = req.body;

    if (!comentario_jefe?.trim()) {
        return res.status(400).json({ error: 'comentario_jefe requerido para devolver la evaluación' });
    }

    // 1. Cargar evaluación
    const { data: evalData } = await supabase
        .from('evaluaciones')
        .select('id, estado')
        .eq('id', req.params.id)
        .single();

    if (!evalData) return res.status(404).json({ error: 'Evaluación no encontrada' });

    // 2. Solo se puede devolver desde 'pendiente_aprobacion'
    if (evalData.estado !== 'pendiente_aprobacion') {
        return res.status(400).json({
            error: `Solo se puede devolver una evaluación en estado pendiente_aprobacion (actual: ${evalData.estado})`
        });
    }

    const ahora = new Date().toISOString();

    // 3. Actualizar evaluación
    const { error: updateErr } = await supabase
        .from('evaluaciones')
        .update({
            estado:              'devuelto',
            decision_jefe:       'devuelto',
            comentario_jefe:     comentario_jefe.trim(),
            fecha_decision_jefe: ahora,
            jefe_id:             req.usuario.id,
            updated_at:          ahora
        })
        .eq('id', req.params.id);

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // 4. Auditoría
    await auditarEval(
        req.params.id,
        'devolver_evaluacion',
        { comentario_jefe: comentario_jefe.trim() },
        req.usuario.id,
        req.usuario.nombre,
        req.ip
    );

    res.json({
        mensaje:             'Evaluación devuelta al analista',
        evaluacion_id:       req.params.id,
        estado:              'devuelto',
        decision_jefe:       'devuelto',
        comentario_jefe:     comentario_jefe.trim(),
        fecha_decision_jefe: ahora
    });
});

module.exports = router;
