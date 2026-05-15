const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const { soloRolEvaluacion } = require('../../middleware/auth');
const { intentarAutoPublicar } = require('../../services/publicacion');

// GET / — lista de casos por evaluacion_id (con join a ciclo para el frontend)
router.get('/', async (req, res) => {
    const { evaluacion_id } = req.query;
    if (!evaluacion_id) return res.status(400).json({ error: 'evaluacion_id requerido' });

    const { data: casosRaw, error } = await supabase
        .from('evaluacion_casos')
        .select('*, evaluacion_ciclos!ciclo_id(id)')
        .eq('evaluacion_id', evaluacion_id)
        .order('numero_caso');

    if (error) return res.status(500).json({ error: error.message });

    const casos = casosRaw || [];
    if (casos.length === 0) return res.json({ casos: [] });

    // Embeber respuestas_jurado para preview inline en admin
    const casoIds = casos.map(c => c.id);
    const { data: respuestas } = await supabase
        .from('evaluacion_respuestas_jurado')
        .select(`
            id, caso_id, decision, comentario, created_at, asignacion_id,
            decision_analista, comentario_analista, decidido_analista_en,
            decision_comite, comentario_comite, decidido_comite_en,
            descuento_final,
            asignacion:asignaciones(
                id,
                usuario:usuarios_pagados(id, nombre_completo, categoria)
            )
        `)
        .in('caso_id', casoIds);

    const respPorCaso = {};
    for (const r of (respuestas || [])) {
        if (!respPorCaso[r.caso_id]) respPorCaso[r.caso_id] = [];
        respPorCaso[r.caso_id].push({
            id:             r.id,
            jurado_id:      r.asignacion?.usuario?.id              || null,
            jurado_nombre:  r.asignacion?.usuario?.nombre_completo || '—',
            jurado_cat:     r.asignacion?.usuario?.categoria       || null,
            decision:       r.decision,
            comentario:     r.comentario                           || null,
            respondido_en:  r.created_at,
            decision_analista:   r.decision_analista   || null,
            comentario_analista: r.comentario_analista || null,
            decidido_analista_en: r.decidido_analista_en || null,
            decision_comite:     r.decision_comite     || null,
            comentario_comite:   r.comentario_comite   || null,
            decidido_comite_en:  r.decidido_comite_en  || null,
            descuento_final:     r.descuento_final     ?? null
        });
    }

    const { data: enBancoRows } = await supabase
        .from('evaluacion_banco_situaciones')
        .select('caso_id')
        .in('caso_id', casoIds);
    const enBancoSet = new Set((enBancoRows || []).map(x => x.caso_id));

    res.json({ casos: casos.map(c => ({ ...c, respuestas_jurado: respPorCaso[c.id] || [], en_banco: enBancoSet.has(c.id) })) });
});

// GET /:id/respuestas — respuestas de jurados a un caso
router.get('/:id/respuestas', async (req, res) => {
    const { data, error } = await supabase
        .from('evaluacion_respuestas_jurado')
        .select(`
            *,
            asignacion:asignaciones(
                id,
                usuario:usuarios_pagados(id, nombre_completo, rut, categoria)
            )
        `)
        .eq('caso_id', req.params.id)
        .order('created_at');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ respuestas: data || [] });
});

async function getDescuentos() {
    const { data } = await supabase
        .from('evaluacion_configuracion')
        .select('descuento_interpretativa, descuento_reglamentaria, descuento_informativo')
        .eq('activo', true)
        .single();
    return {
        interpretativa: data?.descuento_interpretativa ?? 1,
        reglamentaria:  data?.descuento_reglamentaria  ?? 1,
        informativo:    0   // siempre 0, no descuenta puntos
    };
}

// PATCH /:id — editar datos del caso (solo admin pleno, analista, jefe_area)
router.patch('/:id', soloRolEvaluacion('analista', 'jefe_area'), async (req, res) => {
    const { tipo_caso, descripcion, video_url } = req.body;

    const { data: casoActual, error: fetchErr } = await supabase
        .from('evaluacion_casos')
        .select('id, ciclo_id, evaluacion_id, tipo_caso')
        .eq('id', req.params.id)
        .single();
    if (fetchErr || !casoActual) return res.status(404).json({ error: 'Caso no encontrado' });

    const cambios = { updated_at: new Date().toISOString() };
    const auditDetalle = {};

    if (tipo_caso !== undefined) {
        if (!['interpretativa', 'reglamentaria', 'informativo'].includes(tipo_caso)) {
            return res.status(400).json({ error: 'tipo_caso inválido' });
        }
        if (tipo_caso === 'informativo') {
            const { data: ciclo } = await supabase
                .from('evaluacion_ciclos')
                .select('numero_ciclo')
                .eq('id', casoActual.ciclo_id)
                .single();
            if (!ciclo || ciclo.numero_ciclo !== 2) {
                return res.status(400).json({ error: 'Los casos informativos solo pueden estar en el ciclo 2' });
            }
        }
        const desc = await getDescuentos();
        cambios.tipo_caso        = tipo_caso;
        cambios.descuento_puntos = desc[tipo_caso] ?? 0;
        auditDetalle.tipo_caso   = tipo_caso;
    }
    if (descripcion !== undefined) {
        cambios.descripcion      = descripcion || null;
        auditDetalle.descripcion = descripcion || null;
    }
    if (video_url !== undefined) {
        cambios.video_url      = video_url || null;
        auditDetalle.video_url = video_url || null;
    }

    const { data, error } = await supabase
        .from('evaluacion_casos')
        .update(cambios)
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: casoActual.evaluacion_id,
        ciclo_id:      casoActual.ciclo_id,
        caso_id:       req.params.id,
        accion:        'editar_caso',
        detalle:       auditDetalle,
        actor_id:      req.usuario.id,
        actor_tipo:    'administrador',
        actor_nombre:  req.usuario.nombre,
        ip_address:    req.ip
    });

    res.json(data);
});

// DELETE /:id — eliminar caso con cascade seguro
router.delete('/:id', async (req, res) => {
    const { confirmacion } = req.body || {};

    const { data: caso } = await supabase
        .from('evaluacion_casos')
        .select('id, ciclo_id, evaluacion_id, estado')
        .eq('id', req.params.id)
        .single();

    if (!caso) return res.status(404).json({ error: 'Caso no encontrado' });

    // Bloquear eliminación física si el caso ya fue abierto al jurado
    if (caso.estado !== 'cargado') {
        return res.status(409).json({
            error: 'No se puede eliminar una situación ya abierta al jurado. Use "Revertir situación" para dejarla sin descuento.'
        });
    }

    const { count } = await supabase
        .from('evaluacion_respuestas_jurado')
        .select('id', { count: 'exact', head: true })
        .eq('caso_id', req.params.id);

    if (count > 0 && confirmacion !== 'ELIMINAR') {
        return res.status(409).json({
            requiere_confirmacion: true,
            mensaje: 'El caso tiene respuestas de jurado asociadas. Escribe ELIMINAR para confirmar la eliminación definitiva.'
        });
    }

    // 1. Auditoría (tiene FK a casos — debe ir antes)
    await supabase.from('evaluacion_auditoria').delete().eq('caso_id', req.params.id);
    // 2. Respuestas del jurado
    await supabase.from('evaluacion_respuestas_jurado').delete().eq('caso_id', req.params.id);
    // 3. Caso
    const { error } = await supabase.from('evaluacion_casos').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ mensaje: 'Caso eliminado' });
});

// POST /:id/guardar-en-banco — guardar caso en Banco de Situaciones
router.post('/:id/guardar-en-banco', async (req, res) => {
    const { comentario_banco } = req.body;
    if (!comentario_banco || !comentario_banco.trim()) {
        return res.status(400).json({ error: 'El comentario es obligatorio para guardar en el Banco de Situaciones' });
    }
    if (comentario_banco.trim().length > 500) {
        return res.status(400).json({ error: 'El comentario no puede superar 500 caracteres' });
    }

    const { data: caso, error: casoErr } = await supabase
        .from('evaluacion_casos')
        .select('id, evaluacion_id, ciclo_id, tipo_caso, descripcion, video_url, estado, resolucion_final')
        .eq('id', req.params.id)
        .single();

    if (casoErr || !caso) return res.status(404).json({ error: 'Caso no encontrado' });

    const { data: ciclo } = await supabase
        .from('evaluacion_ciclos')
        .select('numero_ciclo')
        .eq('id', caso.ciclo_id)
        .single();

    const { data: existente } = await supabase
        .from('evaluacion_banco_situaciones')
        .select('id')
        .eq('caso_id', req.params.id)
        .maybeSingle();

    if (existente) {
        return res.status(409).json({ error: 'Esta situación ya existe en el Banco de Situaciones.' });
    }

    const { data, error } = await supabase
        .from('evaluacion_banco_situaciones')
        .insert({
            caso_id:          req.params.id,
            evaluacion_id:    caso.evaluacion_id,
            ciclo_numero:     ciclo?.numero_ciclo ?? null,
            tipo_caso:        caso.tipo_caso,
            descripcion_caso: caso.descripcion    ?? null,
            video_url:        caso.video_url      ?? null,
            estado_caso:      caso.estado,
            resolucion_final: caso.resolucion_final ?? null,
            comentario_banco: comentario_banco.trim(),
            guardado_por:     req.usuario.id
        })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, banco: data });
});

// POST /:id/decision-analista
router.post('/:id/decision-analista', async (req, res) => {
    const { decision, comentario_analista } = req.body;

    if (!decision || !['mantener', 'revertir', 'derivar_comision'].includes(decision)) {
        return res.status(400).json({ error: 'decision inválida (mantener|revertir|derivar_comision)' });
    }
    if (!comentario_analista || !comentario_analista.trim()) {
        return res.status(400).json({ error: 'comentario_analista es obligatorio' });
    }

    const { data: caso, error: casoErr } = await supabase
        .from('evaluacion_casos')
        .select('id, ciclo_id, evaluacion_id, tipo_caso, estado, descuento_puntos, evaluacion:evaluaciones!evaluacion_id(modo_flujo)')
        .eq('id', req.params.id)
        .single();

    if (casoErr) return res.status(404).json({ error: 'Caso no encontrado' });

    const modoFlujo = caso.evaluacion?.modo_flujo || 'apelacion_jurado';
    // En DA, se puede actuar desde visible_jurado además de pendiente_analista
    const estadosPermitidos = modoFlujo === 'descuento_automatico'
        ? ['pendiente_analista', 'visible_jurado']
        : ['pendiente_analista'];
    if (!estadosPermitidos.includes(caso.estado)) {
        return res.status(409).json({ error: `El caso debe estar en ${estadosPermitidos.join(' o ')} (actual: ${caso.estado})` });
    }
    // En DA desde visible_jurado solo se puede revertir o derivar (mantener = default al cierre)
    if (modoFlujo === 'descuento_automatico' && caso.estado === 'visible_jurado' && decision === 'mantener') {
        return res.status(409).json({ error: 'En modo Descuento Automático el descuento se aplica por defecto al cierre. Use Revertir o Derivar a Comisión.' });
    }

    const now = new Date().toISOString();
    let nuevoEstado, resolucion_final;

    if (decision === 'derivar_comision') {
        nuevoEstado      = 'derivado_comision';
        resolucion_final = null;
    } else if (decision === 'revertir') {
        nuevoEstado      = 'resuelto';
        resolucion_final = 'sin_descuento';
    } else {
        // mantener: confirmar con o sin descuento
        nuevoEstado = 'resuelto';
        if (caso.tipo_caso === 'informativo' || caso.descuento_puntos === 0) {
            resolucion_final = 'sin_descuento';
        } else {
            resolucion_final = caso.tipo_caso === 'interpretativa'
                ? 'interpretativa_confirmada'
                : 'reglamentaria_confirmada';
        }
    }

    const { error: updErr } = await supabase
        .from('evaluacion_casos')
        .update({
            decision_analista:   decision,
            comentario_analista: comentario_analista.trim(),
            analista_decidio_en: now,
            analista_id:         req.usuario.id,
            estado:              nuevoEstado,
            resolucion_final,
            updated_at:          now
        })
        .eq('id', req.params.id);

    if (updErr) return res.status(500).json({ error: updErr.message });

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: caso.evaluacion_id,
        ciclo_id:      caso.ciclo_id,
        caso_id:       req.params.id,
        accion:        decision === 'derivar_comision' ? 'derivar_comision' : 'decision_analista',
        detalle:       { decision, resolucion_final },
        actor_id:      req.usuario.id,
        actor_tipo:    'administrador',
        actor_nombre:  req.usuario.nombre,
        ip_address:    req.ip
    });

    let ciclo_cerrado        = false;
    let evaluacion_actualizada = null;

    if (decision === 'derivar_comision') {
        // Mover evaluacion a pendiente_comision si no lo está ya
        const { data: ev } = await supabase
            .from('evaluaciones')
            .select('estado')
            .eq('id', caso.evaluacion_id)
            .single();

        if (ev && !['pendiente_comision', 'pendiente_aprobacion', 'publicado', 'cerrado'].includes(ev.estado)) {
            const { data: evAct } = await supabase
                .from('evaluaciones')
                .update({ estado: 'pendiente_comision', updated_at: now })
                .eq('id', caso.evaluacion_id)
                .select()
                .single();
            evaluacion_actualizada = evAct;
        }
    } else {
        // Auto-cerrar ciclo si todos los casos están resueltos
        const { data: noResueltos } = await supabase
            .from('evaluacion_casos')
            .select('id')
            .eq('ciclo_id', caso.ciclo_id)
            .neq('estado', 'resuelto');

        if (!noResueltos || noResueltos.length === 0) {
            await supabase
                .from('evaluacion_ciclos')
                .update({ estado: 'cerrado', fecha_cierre: now, updated_at: now })
                .eq('id', caso.ciclo_id)
                .neq('estado', 'cerrado');
            ciclo_cerrado = true;

            // Intentar auto-publicar si ambos ciclos quedaron cerrados
            const autoPublicado = await intentarAutoPublicar(
                caso.evaluacion_id, req.usuario.id, req.usuario.nombre, req.ip
            );
            if (autoPublicado && !evaluacion_actualizada) {
                const { data: evAct } = await supabase
                    .from('evaluaciones')
                    .select('id, estado, nota_final, puntaje_final')
                    .eq('id', caso.evaluacion_id)
                    .single();
                evaluacion_actualizada = evAct;
            }
        }
    }

    res.json({ ciclo_cerrado, evaluacion_actualizada });
});

// POST /:id/decision-comision — solo comision_tecnica o jefe_area o admin pleno
router.post('/:id/decision-comision', soloRolEvaluacion('comision_tecnica', 'jefe_area'), async (req, res) => {
    // Acepta 'decision' o 'decision_comision' por compatibilidad con distintos clientes
    const decision = req.body.decision || req.body.decision_comision;
    const { comentario_comision } = req.body;

    if (!decision || !['aprueba_apelacion', 'rechaza_apelacion'].includes(decision)) {
        return res.status(400).json({ error: 'decision inválida (aprueba_apelacion|rechaza_apelacion)' });
    }
    if (!comentario_comision || !comentario_comision.trim()) {
        return res.status(400).json({ error: 'comentario_comision es obligatorio' });
    }

    const { data: caso, error: casoErr } = await supabase
        .from('evaluacion_casos')
        .select('id, ciclo_id, evaluacion_id, estado')
        .eq('id', req.params.id)
        .single();

    if (casoErr) return res.status(404).json({ error: 'Caso no encontrado' });
    if (caso.estado !== 'derivado_comision') {
        return res.status(409).json({ error: `El caso debe estar en derivado_comision (actual: ${caso.estado})` });
    }

    const now             = new Date().toISOString();
    const resolucion_final = decision === 'aprueba_apelacion' ? 'apelacion_acogida' : 'apelacion_rechazada';

    const { error: updErr } = await supabase
        .from('evaluacion_casos')
        .update({
            decision_comision:   decision,
            comentario_comision: comentario_comision.trim(),
            comision_decidio_en: now,
            comision_miembro_id: req.usuario.id,
            estado:              'resuelto',
            resolucion_final,
            updated_at:          now
        })
        .eq('id', req.params.id);

    if (updErr) return res.status(500).json({ error: updErr.message });

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: caso.evaluacion_id,
        ciclo_id:      caso.ciclo_id,
        caso_id:       req.params.id,
        accion:        'decision_comision',
        detalle:       { decision, resolucion_final },
        actor_id:      req.usuario.id,
        actor_tipo:    'administrador',
        actor_nombre:  req.usuario.nombre,
        ip_address:    req.ip
    });

    let ciclo_cerrado        = false;
    let evaluacion_actualizada = null;

    // Auto-cerrar ciclo si todos los casos están resueltos
    const { data: noResueltos } = await supabase
        .from('evaluacion_casos')
        .select('id')
        .eq('ciclo_id', caso.ciclo_id)
        .neq('estado', 'resuelto');

    if (!noResueltos || noResueltos.length === 0) {
        await supabase
            .from('evaluacion_ciclos')
            .update({ estado: 'cerrado', fecha_cierre: now, updated_at: now })
            .eq('id', caso.ciclo_id)
            .neq('estado', 'cerrado');
        ciclo_cerrado = true;

        // Intentar auto-publicar si ambos ciclos quedaron cerrados
        const autoPublicado = await intentarAutoPublicar(
            caso.evaluacion_id, req.usuario.id, req.usuario.nombre, req.ip
        );
        if (autoPublicado && !evaluacion_actualizada) {
            const { data: evAct } = await supabase
                .from('evaluaciones')
                .select('id, estado, nota_final, puntaje_final')
                .eq('id', caso.evaluacion_id)
                .single();
            evaluacion_actualizada = evAct;
        }
    }

    // Si la evaluacion estaba en pendiente_comision y ya no quedan derivados → volver a en_proceso
    const { data: ev } = await supabase
        .from('evaluaciones')
        .select('estado')
        .eq('id', caso.evaluacion_id)
        .single();

    if (ev && ev.estado === 'pendiente_comision') {
        const { count: derivadoCount } = await supabase
            .from('evaluacion_casos')
            .select('id', { count: 'exact', head: true })
            .eq('evaluacion_id', caso.evaluacion_id)
            .eq('estado', 'derivado_comision');

        if (!derivadoCount || derivadoCount === 0) {
            const { data: evAct } = await supabase
                .from('evaluaciones')
                .update({ estado: 'en_proceso', updated_at: now })
                .eq('id', caso.evaluacion_id)
                .select()
                .single();
            evaluacion_actualizada = evAct;
        }
    }

    res.json({ ciclo_cerrado, evaluacion_actualizada });
});

module.exports = router;
