const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const { soloRolEvaluacion } = require('../../middleware/auth');

// GET / — lista paginada con filtros
router.get('/', async (req, res) => {
    const { estado, analista_id, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
        .from('evaluaciones')
        .select(`
            id, estado, created_at, analista_id, rodeo_id,
            rodeo:rodeos(id, club, sede, fecha, asociacion),
            analista:analista_id(id, nombre_completo)
        `, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + parseInt(limit) - 1);

    if (estado)      query = query.eq('estado', estado);
    if (analista_id) query = query.eq('analista_id', analista_id);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ evaluaciones: data || [], total: count || 0 });
});

// POST / — crear evaluación (solo jefe_area o admin pleno)
router.post('/', soloRolEvaluacion('jefe_area'), async (req, res) => {
    const { rodeo_id, analista_id } = req.body;
    if (!rodeo_id)    return res.status(400).json({ error: 'rodeo_id requerido' });
    if (!analista_id) return res.status(400).json({ error: 'analista_id requerido' });

    const { data: config } = await supabase
        .from('evaluacion_configuracion')
        .select('*')
        .eq('activo', true)
        .single();

    const cfg = config || { puntaje_base: 80, min_casos_ciclo1: 0, max_casos_ciclo1: 10, min_casos_ciclo2: 8, max_casos_ciclo2: 8 };

    const { data: ev, error: evErr } = await supabase
        .from('evaluaciones')
        .insert({
            rodeo_id,
            analista_id,
            puntaje_base: cfg.puntaje_base,
            creado_por: req.usuario.id
        })
        .select()
        .single();

    if (evErr) {
        if (evErr.code === '23505') return res.status(409).json({ error: 'Ya existe una evaluación para este rodeo' });
        return res.status(500).json({ error: evErr.message });
    }

    await supabase.from('evaluacion_ciclos').insert([
        { evaluacion_id: ev.id, numero_ciclo: 1, min_casos: cfg.min_casos_ciclo1, max_casos: cfg.max_casos_ciclo1 },
        { evaluacion_id: ev.id, numero_ciclo: 2, min_casos: cfg.min_casos_ciclo2, max_casos: cfg.max_casos_ciclo2 }
    ]);

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: ev.id,
        accion: 'crear_evaluacion',
        detalle: { rodeo_id, analista_id },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        actor_nombre: req.usuario.nombre,
        ip_address: req.ip
    });

    res.status(201).json(ev);
});

// GET /:id — detalle con rodeo, analista, jefe, ciclos
router.get('/:id', async (req, res) => {
    const { data: ev, error } = await supabase
        .from('evaluaciones')
        .select(`
            *,
            rodeo:rodeos(id, club, sede, fecha, asociacion, tipo_rodeo_nombre),
            analista:analista_id(id, nombre_completo),
            jefe:jefe_id(id, nombre_completo),
            ciclos:evaluacion_ciclos(*)
        `)
        .eq('id', req.params.id)
        .single();

    if (error) return res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message });
    res.json(ev);
});

// PATCH /:id/analista — reasignar analista (solo jefe_area o admin pleno)
router.patch('/:id/analista', soloRolEvaluacion('jefe_area'), async (req, res) => {
    const { analista_id } = req.body;
    if (!analista_id) return res.status(400).json({ error: 'analista_id requerido' });

    const { data, error } = await supabase
        .from('evaluaciones')
        .update({ analista_id, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: req.params.id,
        accion: 'reasignar_analista',
        detalle: { analista_id },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        actor_nombre: req.usuario.nombre,
        ip_address: req.ip
    });

    res.json(data);
});

// POST /:id/enviar-aprobacion
router.post('/:id/enviar-aprobacion', async (req, res) => {
    const { data: ev, error: evErr } = await supabase
        .from('evaluaciones')
        .select('id, estado')
        .eq('id', req.params.id)
        .single();

    if (evErr) return res.status(404).json({ error: 'Evaluación no encontrada' });

    const estadosValidos = ['en_proceso', 'devuelto', 'pendiente_comision'];
    if (!estadosValidos.includes(ev.estado)) {
        return res.status(409).json({ error: `No se puede enviar desde estado: ${ev.estado}` });
    }

    const { data, error } = await supabase
        .from('evaluaciones')
        .update({ estado: 'pendiente_aprobacion', updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: req.params.id,
        accion: 'enviar_a_jefe',
        detalle: { estado_anterior: ev.estado },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        actor_nombre: req.usuario.nombre,
        ip_address: req.ip
    });

    res.json(data);
});

// POST /:id/aprobar — publicar vía RPC (solo jefe_area o admin pleno)
router.post('/:id/aprobar', soloRolEvaluacion('jefe_area'), async (req, res) => {
    const { comentario_jefe } = req.body;

    const { data, error } = await supabase.rpc('publicar_evaluacion', {
        p_evaluacion_id: req.params.id,
        p_jefe_id:       req.usuario.id,
        p_comentario:    comentario_jefe || null,
        p_ip:            req.ip || null
    });

    if (error) {
        const msg = error.message || '';
        if (msg.includes('evaluacion_no_encontrada')) return res.status(404).json({ error: 'Evaluación no encontrada' });
        if (msg.includes('estado_invalido'))          return res.status(409).json({ error: 'La evaluación no está en estado pendiente_aprobacion' });
        if (msg.includes('casos_pendientes'))         return res.status(409).json({ error: 'Existen casos sin resolver' });
        if (msg.includes('sin_jurados'))              return res.status(409).json({ error: 'No hay jurados activos para este rodeo' });
        return res.status(500).json({ error: error.message });
    }

    res.json(data);
});

// POST /:id/devolver — devolver al analista (solo jefe_area o admin pleno)
router.post('/:id/devolver', soloRolEvaluacion('jefe_area'), async (req, res) => {
    const { comentario_jefe } = req.body;
    if (!comentario_jefe || !comentario_jefe.trim()) {
        return res.status(400).json({ error: 'comentario_jefe es obligatorio al devolver' });
    }

    const { data: ev } = await supabase
        .from('evaluaciones')
        .select('estado')
        .eq('id', req.params.id)
        .single();

    if (!ev || ev.estado !== 'pendiente_aprobacion') {
        return res.status(409).json({ error: 'Solo se puede devolver desde estado pendiente_aprobacion' });
    }

    const { data, error } = await supabase
        .from('evaluaciones')
        .update({
            estado:             'devuelto',
            decision_jefe:      'devuelto',
            comentario_jefe:    comentario_jefe.trim(),
            fecha_decision_jefe: new Date().toISOString(),
            jefe_id:            req.usuario.id,
            updated_at:         new Date().toISOString()
        })
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: req.params.id,
        accion: 'devolver_jefe',
        detalle: { comentario_jefe: comentario_jefe.trim() },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        actor_nombre: req.usuario.nombre,
        ip_address: req.ip
    });

    res.json(data);
});

// GET /:id/revision?estado= — bandeja de revisión del analista
router.get('/:id/revision', async (req, res) => {
    const { estado = 'pendiente_analista' } = req.query;

    const { data: ev, error: evErr } = await supabase
        .from('evaluaciones')
        .select('id, estado, rodeo:rodeos(id, club, sede, fecha, asociacion, tipo_rodeo_nombre)')
        .eq('id', req.params.id)
        .single();

    if (evErr) return res.status(404).json({ error: 'Evaluación no encontrada' });

    const { data: ciclos } = await supabase
        .from('evaluacion_ciclos')
        .select('id, numero_ciclo, estado')
        .eq('evaluacion_id', req.params.id)
        .order('numero_ciclo');

    const ciclosConCasos = await Promise.all((ciclos || []).map(async (ciclo) => {
        const { data: casos } = await supabase
            .from('evaluacion_casos')
            .select('*')
            .eq('ciclo_id', ciclo.id)
            .eq('estado', estado)
            .order('numero_caso');
        return { ...ciclo, casos: casos || [] };
    }));

    const totalCasos = ciclosConCasos.reduce((s, c) => s + c.casos.length, 0);

    res.json({
        id:          ev.id,
        estado:      ev.estado,
        rodeo:       ev.rodeo,
        ciclos:      ciclosConCasos,
        total_casos: totalCasos
    });
});

// GET /:id/comision?estado= — bandeja de comisión técnica
router.get('/:id/comision', async (req, res) => {
    const { estado = 'derivado_comision' } = req.query;

    const { data: ev, error: evErr } = await supabase
        .from('evaluaciones')
        .select('id, estado, rodeo:rodeos(id, club, sede, fecha, asociacion, tipo_rodeo_nombre)')
        .eq('id', req.params.id)
        .single();

    if (evErr) return res.status(404).json({ error: 'Evaluación no encontrada' });

    const { data: ciclos } = await supabase
        .from('evaluacion_ciclos')
        .select('id, numero_ciclo, estado')
        .eq('evaluacion_id', req.params.id)
        .order('numero_ciclo');

    const ciclosConCasos = await Promise.all((ciclos || []).map(async (ciclo) => {
        const { data: casos } = await supabase
            .from('evaluacion_casos')
            .select('*')
            .eq('ciclo_id', ciclo.id)
            .eq('estado', estado)
            .order('numero_caso');
        return { ...ciclo, casos: casos || [] };
    }));

    const totalCasos = ciclosConCasos.reduce((s, c) => s + c.casos.length, 0);

    res.json({
        id:          ev.id,
        estado:      ev.estado,
        rodeo:       ev.rodeo,
        ciclos:      ciclosConCasos,
        total_casos: totalCasos
    });
});

module.exports = router;
