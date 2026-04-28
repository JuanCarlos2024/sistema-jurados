const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const { soloRolEvaluacion } = require('../../middleware/auth');

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

    res.json({ casos: casos.map(c => ({ ...c, respuestas_jurado: respPorCaso[c.id] || [] })) });
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
        reglamentaria:  data?.descuento_reglamentaria  ?? 2,
        informativo:    data?.descuento_informativo    ?? 0
    };
}

// PATCH /:id — editar datos del caso
router.patch('/:id', async (req, res) => {
    const { tipo_caso, descripcion, video_url } = req.body;
    const cambios = { updated_at: new Date().toISOString() };

    if (tipo_caso !== undefined) {
        if (!['interpretativa', 'reglamentaria', 'informativo'].includes(tipo_caso)) {
            return res.status(400).json({ error: 'tipo_caso inválido' });
        }
        if (tipo_caso === 'informativo') {
            const { data: casoActual } = await supabase
                .from('evaluacion_casos')
                .select('ciclo_id')
                .eq('id', req.params.id)
                .single();
            if (casoActual) {
                const { data: ciclo } = await supabase
                    .from('evaluacion_ciclos')
                    .select('numero_ciclo')
                    .eq('id', casoActual.ciclo_id)
                    .single();
                if (!ciclo || ciclo.numero_ciclo !== 2) {
                    return res.status(400).json({ error: 'Los casos informativos solo pueden estar en el ciclo 2' });
                }
            }
        }
        const desc = await getDescuentos();
        cambios.tipo_caso        = tipo_caso;
        cambios.descuento_puntos = desc[tipo_caso] ?? 0;
    }
    if (descripcion !== undefined) cambios.descripcion = descripcion || null;
    if (video_url   !== undefined) cambios.video_url   = video_url   || null;

    const { data, error } = await supabase
        .from('evaluacion_casos')
        .update(cambios)
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// DELETE /:id — eliminar caso (solo si no tiene respuestas)
router.delete('/:id', async (req, res) => {
    const { count } = await supabase
        .from('evaluacion_respuestas_jurado')
        .select('id', { count: 'exact', head: true })
        .eq('caso_id', req.params.id);

    if (count > 0) {
        return res.status(409).json({ error: 'No se puede eliminar un caso con respuestas de jurado asociadas' });
    }

    const { error } = await supabase
        .from('evaluacion_casos')
        .delete()
        .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ mensaje: 'Caso eliminado' });
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
        .select('id, ciclo_id, evaluacion_id, tipo_caso, estado, descuento_puntos')
        .eq('id', req.params.id)
        .single();

    if (casoErr) return res.status(404).json({ error: 'Caso no encontrado' });
    if (caso.estado !== 'pendiente_analista') {
        return res.status(409).json({ error: `El caso debe estar en pendiente_analista (actual: ${caso.estado})` });
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
        }
    }

    res.json({ ciclo_cerrado, evaluacion_actualizada });
});

// POST /:id/decision-comision — solo comision_tecnica o jefe_area o admin pleno
router.post('/:id/decision-comision', soloRolEvaluacion('comision_tecnica', 'jefe_area'), async (req, res) => {
    const { decision, comentario_comision } = req.body;

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
