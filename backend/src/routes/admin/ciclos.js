const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');

// POST /:id/abrir — abrir ciclo al jurado
router.post('/:id/abrir', async (req, res) => {
    const { data: ciclo, error: cicloErr } = await supabase
        .from('evaluacion_ciclos')
        .select('*, evaluacion:evaluaciones(id, estado, rodeo_id)')
        .eq('id', req.params.id)
        .single();

    if (cicloErr) return res.status(404).json({ error: 'Ciclo no encontrado' });

    const estadosAbribles = ['pendiente_carga', 'cargado', 'sin_casos'];
    if (!estadosAbribles.includes(ciclo.estado)) {
        return res.status(409).json({ error: `No se puede abrir el ciclo desde estado: ${ciclo.estado}` });
    }

    const now = new Date().toISOString();

    const { data: cicloAct, error: updErr } = await supabase
        .from('evaluacion_ciclos')
        .update({
            estado:         'abierto',
            fecha_apertura: now,
            abierto_por:    req.usuario.id,
            updated_at:     now
        })
        .eq('id', req.params.id)
        .select()
        .single();

    if (updErr) return res.status(500).json({ error: updErr.message });

    // Casos cargados → visible_jurado
    await supabase
        .from('evaluacion_casos')
        .update({ estado: 'visible_jurado', updated_at: now })
        .eq('ciclo_id', req.params.id)
        .eq('estado', 'cargado');

    // Evaluacion borrador → en_proceso
    const ev = ciclo.evaluacion;
    if (ev && ev.estado === 'borrador') {
        await supabase
            .from('evaluaciones')
            .update({ estado: 'en_proceso', updated_at: now })
            .eq('id', ev.id);
    }

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: ciclo.evaluacion_id,
        ciclo_id:      req.params.id,
        accion:        'abrir_ciclo',
        detalle:       { numero_ciclo: ciclo.numero_ciclo },
        actor_id:      req.usuario.id,
        actor_tipo:    'administrador',
        actor_nombre:  req.usuario.nombre,
        ip_address:    req.ip
    });

    res.json(cicloAct);
});

// POST /:id/cerrar — cerrar ciclo manualmente
router.post('/:id/cerrar', async (req, res) => {
    const { motivo_cierre } = req.body;

    const { data: ciclo, error: cicloErr } = await supabase
        .from('evaluacion_ciclos')
        .select('*, evaluacion:evaluaciones(id, rodeo_id)')
        .eq('id', req.params.id)
        .single();

    if (cicloErr) return res.status(404).json({ error: 'Ciclo no encontrado' });
    if (ciclo.estado !== 'abierto') {
        return res.status(409).json({ error: `El ciclo debe estar abierto para cerrarlo (actual: ${ciclo.estado})` });
    }

    const now = new Date().toISOString();

    // Obtener casos aún visible_jurado
    const { data: casosVisibles } = await supabase
        .from('evaluacion_casos')
        .select('id, tipo_caso')
        .eq('ciclo_id', req.params.id)
        .eq('estado', 'visible_jurado');

    if (casosVisibles && casosVisibles.length > 0) {
        // Contar jurados activos del rodeo
        const { data: juradoAsigs } = await supabase
            .from('asignaciones')
            .select('id, usuarios_pagados!inner(tipo_persona)')
            .eq('rodeo_id', ciclo.evaluacion.rodeo_id)
            .eq('estado', 'activo')
            .neq('estado_designacion', 'rechazado')
            .eq('usuarios_pagados.tipo_persona', 'jurado');

        const juradoIds = (juradoAsigs || []).map(a => a.id);
        const totalJurados = juradoIds.length;

        for (const caso of casosVisibles) {
            let estado_consolidado = 'pendiente';

            if (totalJurados > 0) {
                const { data: respuestas } = await supabase
                    .from('evaluacion_respuestas_jurado')
                    .select('decision')
                    .eq('caso_id', caso.id)
                    .in('asignacion_id', juradoIds);

                const r = respuestas || [];
                const acepta  = r.filter(x => x.decision === 'acepta').length;
                const rechaza = r.filter(x => x.decision === 'rechaza').length;

                if (acepta + rechaza < totalJurados) {
                    estado_consolidado = 'incompleto';
                } else if (rechaza > acepta) {
                    estado_consolidado = 'rechazado';
                } else {
                    estado_consolidado = 'aceptado';
                }
            }

            await supabase
                .from('evaluacion_casos')
                .update({ estado: 'pendiente_analista', estado_consolidado, updated_at: now })
                .eq('id', caso.id);
        }
    }

    const { data: cicloAct, error: updErr } = await supabase
        .from('evaluacion_ciclos')
        .update({
            estado:       'en_revision',
            fecha_cierre: now,
            cerrado_por:  req.usuario.id,
            motivo_cierre: motivo_cierre || null,
            updated_at:   now
        })
        .eq('id', req.params.id)
        .select()
        .single();

    if (updErr) return res.status(500).json({ error: updErr.message });

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: ciclo.evaluacion_id,
        ciclo_id:      req.params.id,
        accion:        'cerrar_ciclo_manual',
        detalle:       { numero_ciclo: ciclo.numero_ciclo, motivo_cierre: motivo_cierre || null },
        actor_id:      req.usuario.id,
        actor_tipo:    'administrador',
        actor_nombre:  req.usuario.nombre,
        ip_address:    req.ip
    });

    res.json(cicloAct);
});

// POST /:id/casos — agregar caso al ciclo
router.post('/:id/casos', async (req, res) => {
    const { tipo_caso, descuento_puntos = 0, descripcion, video_url } = req.body;

    if (!tipo_caso || !['interpretativa', 'reglamentaria', 'informativo'].includes(tipo_caso)) {
        return res.status(400).json({ error: 'tipo_caso inválido (interpretativa|reglamentaria|informativo)' });
    }
    if (![0, 1, 2].includes(parseInt(descuento_puntos))) {
        return res.status(400).json({ error: 'descuento_puntos debe ser 0, 1 o 2' });
    }

    const { data: ciclo, error: cicloErr } = await supabase
        .from('evaluacion_ciclos')
        .select('id, numero_ciclo, evaluacion_id, estado, max_casos')
        .eq('id', req.params.id)
        .single();

    if (cicloErr) return res.status(404).json({ error: 'Ciclo no encontrado' });

    if (tipo_caso === 'informativo' && ciclo.numero_ciclo !== 2) {
        return res.status(400).json({ error: 'Los casos informativos solo pueden agregarse al ciclo 2' });
    }

    const { count } = await supabase
        .from('evaluacion_casos')
        .select('id', { count: 'exact', head: true })
        .eq('ciclo_id', req.params.id);

    if (ciclo.max_casos && (count || 0) >= ciclo.max_casos) {
        return res.status(409).json({ error: `El ciclo ya tiene el máximo de casos permitidos (${ciclo.max_casos})` });
    }

    const numero_caso = (count || 0) + 1;

    const { data: caso, error: casoErr } = await supabase
        .from('evaluacion_casos')
        .insert({
            ciclo_id:        req.params.id,
            evaluacion_id:   ciclo.evaluacion_id,
            numero_caso,
            tipo_caso,
            descuento_puntos: parseInt(descuento_puntos),
            descripcion:     descripcion || null,
            video_url:       video_url || null,
            cargado_por:     req.usuario.id,
            estado:          ciclo.estado === 'abierto' ? 'visible_jurado' : 'cargado'
        })
        .select()
        .single();

    if (casoErr) return res.status(500).json({ error: casoErr.message });

    if (['pendiente_carga', 'sin_casos'].includes(ciclo.estado)) {
        await supabase
            .from('evaluacion_ciclos')
            .update({ estado: 'cargado', updated_at: new Date().toISOString() })
            .eq('id', req.params.id);
    }

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: ciclo.evaluacion_id,
        ciclo_id:      req.params.id,
        caso_id:       caso.id,
        accion:        'cargar_caso',
        detalle:       { tipo_caso, numero_caso },
        actor_id:      req.usuario.id,
        actor_tipo:    'administrador',
        actor_nombre:  req.usuario.nombre,
        ip_address:    req.ip
    });

    res.status(201).json(caso);
});

module.exports = router;
