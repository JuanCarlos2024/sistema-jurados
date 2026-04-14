const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');

// GET /api/admin/bonos?estado=&page=&limit=
router.get('/', async (req, res) => {
    const { estado, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
        .from('bonos_solicitados')
        .select(`
            id, distancia_declarada, monto_solicitado, monto_aprobado, estado,
            observacion_usuario, observacion_admin, created_at, revisado_at,
            usuarios_pagados(id, nombre_completo, codigo_interno, tipo_persona),
            asignaciones(id, tipo_persona, categoria_aplicada,
                rodeos(club, asociacion, fecha, tipo_rodeo_nombre))
        `, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + parseInt(limit) - 1);

    if (estado === 'aprobado_auto') {
        // Filtro explícito para bonos auto-aprobados (km < 350, $0)
        query = query.eq('estado', 'aprobado_auto');
    } else if (estado) {
        query = query.eq('estado', estado);
    } else {
        // "Todos" excluye aprobado_auto: no requieren revisión y no suman monto
        query = query.neq('estado', 'aprobado_auto');
    }

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ data, total: count });
});

// PATCH /api/admin/bonos/:id/aprobar
router.patch('/:id/aprobar', async (req, res) => {
    const { data: bono } = await supabase
        .from('bonos_solicitados')
        .select('*, usuarios_pagados(nombre_completo)')
        .eq('id', req.params.id)
        .single();

    if (!bono) return res.status(404).json({ error: 'Bono no encontrado' });
    if (bono.estado !== 'pendiente') {
        return res.status(400).json({ error: `No se puede aprobar un bono en estado: ${bono.estado}` });
    }

    const { data, error } = await supabase
        .from('bonos_solicitados')
        .update({
            estado: 'aprobado',
            monto_aprobado: bono.monto_solicitado,
            revisado_por: req.usuario.id,
            revisado_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        })
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'bonos_solicitados',
        registro_id: req.params.id,
        accion: 'aprobar_bono',
        datos_anteriores: { estado: 'pendiente', monto: bono.monto_solicitado },
        datos_nuevos: { estado: 'aprobado', monto_aprobado: bono.monto_solicitado },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Bono aprobado para ${bono.usuarios_pagados?.nombre_completo}: $${bono.monto_solicitado}`,
        ip_address: req.ip
    });

    res.json(data);
});

// PATCH /api/admin/bonos/:id/rechazar
router.patch('/:id/rechazar', async (req, res) => {
    const { observacion_admin } = req.body;

    if (!observacion_admin) {
        return res.status(400).json({ error: 'Debe indicar el motivo del rechazo' });
    }

    const { data: bono } = await supabase
        .from('bonos_solicitados')
        .select('*, usuarios_pagados(nombre_completo)')
        .eq('id', req.params.id)
        .single();

    if (!bono) return res.status(404).json({ error: 'Bono no encontrado' });
    if (!['pendiente', 'aprobado', 'modificado'].includes(bono.estado)) {
        return res.status(400).json({ error: 'Este bono no puede ser rechazado en su estado actual' });
    }

    const { data, error } = await supabase
        .from('bonos_solicitados')
        .update({
            estado: 'rechazado',
            monto_aprobado: null,
            observacion_admin,
            revisado_por: req.usuario.id,
            revisado_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        })
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'bonos_solicitados',
        registro_id: req.params.id,
        accion: 'rechazar_bono',
        datos_anteriores: { estado: bono.estado },
        datos_nuevos: { estado: 'rechazado', observacion_admin },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Bono rechazado para ${bono.usuarios_pagados?.nombre_completo}. Motivo: ${observacion_admin}`,
        ip_address: req.ip
    });

    res.json(data);
});

// PATCH /api/admin/bonos/:id/modificar
router.patch('/:id/modificar', async (req, res) => {
    const { monto_aprobado, bono_config_id, observacion_admin } = req.body;

    if (!monto_aprobado || monto_aprobado <= 0) {
        return res.status(400).json({ error: 'monto_aprobado debe ser mayor a 0' });
    }

    const { data: bono } = await supabase
        .from('bonos_solicitados')
        .select('*, usuarios_pagados(nombre_completo)')
        .eq('id', req.params.id)
        .single();

    if (!bono) return res.status(404).json({ error: 'Bono no encontrado' });

    const cambios = {
        estado: 'modificado',
        monto_aprobado: parseInt(monto_aprobado),
        observacion_admin,
        revisado_por: req.usuario.id,
        revisado_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };
    if (bono_config_id) cambios.bono_config_id = bono_config_id;

    const { data, error } = await supabase
        .from('bonos_solicitados')
        .update(cambios)
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'bonos_solicitados',
        registro_id: req.params.id,
        accion: 'modificar_bono',
        datos_anteriores: { monto_solicitado: bono.monto_solicitado, estado: bono.estado },
        datos_nuevos: { monto_aprobado: parseInt(monto_aprobado), estado: 'modificado' },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Bono modificado para ${bono.usuarios_pagados?.nombre_completo}: $${monto_aprobado}`,
        ip_address: req.ip
    });

    res.json(data);
});

// POST /api/admin/bonos/manual — admin agrega bono directo sin solicitud del usuario
router.post('/manual', async (req, res) => {
    const { asignacion_id, bono_config_id, distancia_declarada, monto, observacion_admin } = req.body;

    if (!asignacion_id || !distancia_declarada || !monto) {
        return res.status(400).json({ error: 'asignacion_id, distancia_declarada y monto son requeridos' });
    }

    const { data: asig } = await supabase
        .from('asignaciones')
        .select('usuario_pagado_id')
        .eq('id', asignacion_id)
        .single();

    if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });

    const { data, error } = await supabase
        .from('bonos_solicitados')
        .insert({
            asignacion_id,
            usuario_pagado_id: asig.usuario_pagado_id,
            bono_config_id: bono_config_id || null,
            distancia_declarada: parseInt(distancia_declarada),
            monto_solicitado: parseInt(monto),
            monto_aprobado: parseInt(monto),
            estado: 'aprobado',           // manual del admin = aprobado directo
            observacion_admin: observacion_admin || 'Bono agregado por administrador'
        })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'bonos_solicitados',
        registro_id: data.id,
        accion: 'aprobar_bono',
        datos_nuevos: { asignacion_id, monto, tipo: 'manual_admin' },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Bono manual agregado por admin: $${monto}`,
        ip_address: req.ip
    });

    res.status(201).json(data);
});

module.exports = router;
