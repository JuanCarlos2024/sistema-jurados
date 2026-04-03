const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');
const { obtenerTarifas, calcularPagoBase } = require('../../services/calculo');

// GET /api/admin/rodeos?mes=&año=&asociacion=&tipo=&estado=&buscar=&page=&limit=
router.get('/', async (req, res) => {
    const { mes, año, asociacion, tipo, estado, buscar, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Query base: sin join a tipos_rodeo (usamos snapshot tipo_rodeo_nombre)
    let query = supabase
        .from('rodeos')
        .select('id, club, asociacion, fecha, tipo_rodeo_nombre, duracion_dias, origen, estado, created_at', { count: 'exact' })
        .order('fecha', { ascending: false })
        .range(offset, offset + parseInt(limit) - 1);

    if (estado) query = query.eq('estado', estado);
    else        query = query.eq('estado', 'activo');

    if (asociacion) query = query.ilike('asociacion', `%${asociacion}%`);
    if (tipo)       query = query.eq('tipo_rodeo_id', tipo);
    if (buscar)     query = query.or(`club.ilike.%${buscar}%,asociacion.ilike.%${buscar}%`);

    // Filtro de fechas — solo aplicar si los valores son numéricos válidos
    const añoNum = parseInt(año);
    const mesNum = parseInt(mes);
    if (!isNaN(añoNum) && !isNaN(mesNum) && mesNum >= 1 && mesNum <= 12) {
        const inicio = `${añoNum}-${String(mesNum).padStart(2, '0')}-01`;
        const fin = new Date(añoNum, mesNum, 0).toISOString().split('T')[0];
        query = query.gte('fecha', inicio).lte('fecha', fin);
    } else if (!isNaN(añoNum)) {
        query = query.gte('fecha', `${añoNum}-01-01`).lte('fecha', `${añoNum}-12-31`);
    }

    const { data: rodeos, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Agregar totales de asignaciones en una segunda query (evitar N+1)
    if (rodeos && rodeos.length > 0) {
        const ids = rodeos.map(r => r.id);
        const { data: asigs } = await supabase
            .from('asignaciones')
            .select('rodeo_id, pago_base_calculado')
            .in('rodeo_id', ids)
            .eq('estado', 'activo');

        const statsPorRodeo = {};
        (asigs || []).forEach(a => {
            if (!statsPorRodeo[a.rodeo_id]) statsPorRodeo[a.rodeo_id] = { total_asignaciones: 0, total_pago_base: 0 };
            statsPorRodeo[a.rodeo_id].total_asignaciones++;
            statsPorRodeo[a.rodeo_id].total_pago_base += (a.pago_base_calculado || 0);
        });

        rodeos.forEach(r => {
            const s = statsPorRodeo[r.id] || { total_asignaciones: 0, total_pago_base: 0 };
            r.total_asignaciones = s.total_asignaciones;
            r.total_pago_base    = s.total_pago_base;
        });
    }

    res.json({ data: rodeos, total: count, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/admin/rodeos/:id (con asignaciones)
router.get('/:id', async (req, res) => {
    const { data: rodeo, error } = await supabase
        .from('rodeos')
        .select('*, tipos_rodeo(nombre, duracion_dias)')
        .eq('id', req.params.id)
        .single();

    if (error) return res.status(404).json({ error: 'Rodeo no encontrado' });

    const { data: asignaciones } = await supabase
        .from('asignaciones')
        .select(`
            id, tipo_persona, nombre_importado, categoria_aplicada,
            valor_diario_aplicado, duracion_dias_aplicada, pago_base_calculado,
            estado, observacion, created_at,
            usuarios_pagados(id, codigo_interno, nombre_completo, tipo_persona, categoria)
        `)
        .eq('rodeo_id', req.params.id)
        .neq('estado', 'anulado');

    res.json({ ...rodeo, asignaciones: asignaciones || [] });
});

// POST /api/admin/rodeos
router.post('/', async (req, res) => {
    const { club, asociacion, fecha, tipo_rodeo_id, observacion } = req.body;

    if (!club || !asociacion || !fecha || !tipo_rodeo_id) {
        return res.status(400).json({ error: 'club, asociacion, fecha y tipo_rodeo_id son requeridos' });
    }

    const { data: tipo } = await supabase
        .from('tipos_rodeo')
        .select('id, nombre, duracion_dias')
        .eq('id', tipo_rodeo_id)
        .eq('activo', true)
        .single();

    if (!tipo) return res.status(400).json({ error: 'Tipo de rodeo no encontrado o inactivo' });

    const { data, error } = await supabase
        .from('rodeos')
        .insert({
            club: club.trim(),
            asociacion: asociacion.trim(),
            fecha,
            tipo_rodeo_id,
            tipo_rodeo_nombre: tipo.nombre,
            duracion_dias: tipo.duracion_dias,
            observacion,
            origen: 'manual',
            created_by: req.usuario.id
        })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'rodeos',
        registro_id: data.id,
        accion: 'crear',
        datos_nuevos: { club, asociacion, fecha, tipo_rodeo_nombre: tipo.nombre },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Rodeo creado: ${club} - ${tipo.nombre} - ${fecha}`,
        ip_address: req.ip
    });

    res.status(201).json(data);
});

// PATCH /api/admin/rodeos/:id
router.patch('/:id', async (req, res) => {
    const { club, asociacion, fecha, tipo_rodeo_id, observacion, estado } = req.body;

    const { data: anterior } = await supabase
        .from('rodeos')
        .select('*')
        .eq('id', req.params.id)
        .single();

    if (!anterior) return res.status(404).json({ error: 'Rodeo no encontrado' });

    const cambios = { updated_at: new Date().toISOString() };
    if (club) cambios.club = club.trim();
    if (asociacion) cambios.asociacion = asociacion.trim();
    if (fecha) cambios.fecha = fecha;
    if (observacion !== undefined) cambios.observacion = observacion;
    if (estado) cambios.estado = estado;

    if (tipo_rodeo_id && tipo_rodeo_id !== anterior.tipo_rodeo_id) {
        const { data: tipo } = await supabase
            .from('tipos_rodeo')
            .select('nombre, duracion_dias')
            .eq('id', tipo_rodeo_id)
            .single();

        if (!tipo) return res.status(400).json({ error: 'Tipo de rodeo no encontrado' });
        cambios.tipo_rodeo_id = tipo_rodeo_id;
        cambios.tipo_rodeo_nombre = tipo.nombre;
        cambios.duracion_dias = tipo.duracion_dias;
    }

    const { data, error } = await supabase
        .from('rodeos')
        .update(cambios)
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'rodeos',
        registro_id: req.params.id,
        accion: 'editar',
        datos_anteriores: anterior,
        datos_nuevos: cambios,
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Rodeo editado: ${anterior.club}`,
        ip_address: req.ip
    });

    res.json(data);
});

// DELETE /api/admin/rodeos/:id (anular)
router.delete('/:id', async (req, res) => {
    const { data: r } = await supabase
        .from('rodeos')
        .select('club, fecha')
        .eq('id', req.params.id)
        .single();

    if (!r) return res.status(404).json({ error: 'Rodeo no encontrado' });

    await supabase
        .from('rodeos')
        .update({ estado: 'anulado', updated_at: new Date().toISOString() })
        .eq('id', req.params.id);

    // Anular también las asignaciones
    await supabase
        .from('asignaciones')
        .update({ estado: 'anulado', updated_at: new Date().toISOString() })
        .eq('rodeo_id', req.params.id);

    await auditoria.registrar({
        tabla: 'rodeos',
        registro_id: req.params.id,
        accion: 'eliminar',
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Rodeo anulado: ${r.club} - ${r.fecha}`,
        ip_address: req.ip
    });

    res.json({ mensaje: 'Rodeo anulado correctamente' });
});

// ─────────────────────────────────────────────
// TIPOS DE RODEO
// ─────────────────────────────────────────────

// GET /api/admin/rodeos/tipos/lista
router.get('/tipos/lista', async (req, res) => {
    const { activo } = req.query;
    let query = supabase
        .from('tipos_rodeo')
        .select('*')
        .order('nombre', { ascending: true });

    if (activo !== undefined) query = query.eq('activo', activo === 'true');

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// POST /api/admin/rodeos/tipos
router.post('/tipos', async (req, res) => {
    const { nombre, duracion_dias, observacion } = req.body;

    if (!nombre || !duracion_dias) {
        return res.status(400).json({ error: 'nombre y duracion_dias son requeridos' });
    }
    if (duracion_dias < 1 || duracion_dias > 5) {
        return res.status(400).json({ error: 'La duración debe ser entre 1 y 5 días' });
    }

    const { data, error } = await supabase
        .from('tipos_rodeo')
        .insert({ nombre: nombre.trim(), duracion_dias: parseInt(duracion_dias), observacion })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});

// PATCH /api/admin/rodeos/tipos/:id
router.patch('/tipos/:id', async (req, res) => {
    const { nombre, duracion_dias, observacion, activo } = req.body;
    const cambios = { updated_at: new Date().toISOString() };

    if (nombre) cambios.nombre = nombre.trim();
    if (duracion_dias) cambios.duracion_dias = parseInt(duracion_dias);
    if (observacion !== undefined) cambios.observacion = observacion;
    if (activo !== undefined) cambios.activo = !!activo;

    const { data, error } = await supabase
        .from('tipos_rodeo')
        .update(cambios)
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// DELETE /api/admin/rodeos/tipos/:id
router.delete('/tipos/:id', async (req, res) => {
    const { count } = await supabase
        .from('rodeos')
        .select('id', { count: 'exact', head: true })
        .eq('tipo_rodeo_id', req.params.id);

    if (count > 0) {
        return res.status(400).json({
            error: `No se puede eliminar: hay ${count} rodeo(s) con este tipo. Desactívelo en su lugar.`
        });
    }

    await supabase.from('tipos_rodeo').delete().eq('id', req.params.id);
    res.json({ mensaje: 'Tipo de rodeo eliminado' });
});

module.exports = router;
