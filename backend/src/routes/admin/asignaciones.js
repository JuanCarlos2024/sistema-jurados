const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');
const { obtenerTarifas, calcularPagoBase } = require('../../services/calculo');

// POST /api/admin/asignaciones — crear una o varias asignaciones para un rodeo
router.post('/', async (req, res) => {
    const { rodeo_id, personas } = req.body;
    // personas: [{ usuario_pagado_id, tipo_persona }]

    if (!rodeo_id || !personas || !Array.isArray(personas) || personas.length === 0) {
        return res.status(400).json({ error: 'rodeo_id y al menos una persona son requeridos' });
    }

    const { data: rodeo } = await supabase
        .from('rodeos')
        .select('id, duracion_dias, estado')
        .eq('id', rodeo_id)
        .single();

    if (!rodeo || rodeo.estado !== 'activo') {
        return res.status(400).json({ error: 'Rodeo no encontrado o anulado' });
    }

    const tarifas = await obtenerTarifas();
    const creadas = [];
    const erroresCreacion = [];

    for (const p of personas) {
        const { usuario_pagado_id, tipo_persona } = p;

        if (!usuario_pagado_id || !tipo_persona) {
            erroresCreacion.push({ error: 'usuario_pagado_id y tipo_persona son requeridos', data: p });
            continue;
        }

        const { data: usuario } = await supabase
            .from('usuarios_pagados')
            .select('id, nombre_completo, tipo_persona, categoria, activo')
            .eq('id', usuario_pagado_id)
            .single();

        if (!usuario || !usuario.activo) {
            erroresCreacion.push({ error: 'Usuario no encontrado o inactivo', usuario_pagado_id });
            continue;
        }

        // Validar que delegado rentado no sea jurado y viceversa
        if (tipo_persona !== usuario.tipo_persona) {
            erroresCreacion.push({
                error: `El usuario es ${usuario.tipo_persona}, no se puede asignar como ${tipo_persona}`,
                usuario_pagado_id
            });
            continue;
        }

        try {
            const calculo = calcularPagoBase(
                tipo_persona,
                usuario.categoria,
                rodeo.duracion_dias,
                tarifas
            );

            const { data: asignacion, error: errA } = await supabase
                .from('asignaciones')
                .insert({
                    rodeo_id,
                    usuario_pagado_id,
                    tipo_persona,
                    nombre_importado: usuario.nombre_completo,
                    categoria_aplicada: calculo.categoria_aplicada,
                    valor_diario_aplicado: calculo.valor_diario_aplicado,
                    duracion_dias_aplicada: rodeo.duracion_dias,
                    pago_base_calculado: calculo.pago_base_calculado,
                    estado: 'activo',
                    created_by: req.usuario.id
                })
                .select()
                .single();

            if (errA) {
                erroresCreacion.push({ error: errA.message, usuario_pagado_id });
                continue;
            }

            creadas.push(asignacion);

            await auditoria.registrar({
                tabla: 'asignaciones',
                registro_id: asignacion.id,
                accion: 'crear',
                datos_nuevos: { rodeo_id, usuario_pagado_id, tipo_persona, pago_base_calculado: calculo.pago_base_calculado },
                actor_id: req.usuario.id,
                actor_tipo: 'administrador',
                descripcion: `Asignación creada: ${usuario.nombre_completo} a rodeo ${rodeo_id}`,
                ip_address: req.ip
            });
        } catch (calcErr) {
            erroresCreacion.push({ error: calcErr.message, usuario_pagado_id });
        }
    }

    res.status(201).json({
        creadas,
        errores: erroresCreacion,
        mensaje: `${creadas.length} asignación(es) creada(s)${erroresCreacion.length > 0 ? `, ${erroresCreacion.length} con error` : ''}`
    });
});

// PATCH /api/admin/asignaciones/:id — editar una asignación
router.patch('/:id', async (req, res) => {
    const { observacion, estado } = req.body;

    const { data: anterior } = await supabase
        .from('asignaciones')
        .select('*')
        .eq('id', req.params.id)
        .single();

    if (!anterior) return res.status(404).json({ error: 'Asignación no encontrada' });

    const cambios = { updated_at: new Date().toISOString() };
    if (observacion !== undefined) cambios.observacion = observacion;
    if (estado) cambios.estado = estado;

    const { data, error } = await supabase
        .from('asignaciones')
        .update(cambios)
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'asignaciones',
        registro_id: req.params.id,
        accion: 'editar',
        datos_anteriores: anterior,
        datos_nuevos: cambios,
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: 'Asignación editada',
        ip_address: req.ip
    });

    res.json(data);
});

// POST /api/admin/asignaciones/:id/recalcular
router.post('/:id/recalcular', async (req, res) => {
    const { data: asig } = await supabase
        .from('asignaciones')
        .select('*, rodeos(duracion_dias), usuarios_pagados(categoria, tipo_persona)')
        .eq('id', req.params.id)
        .single();

    if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });

    const tarifas = await obtenerTarifas();
    const calculo = calcularPagoBase(
        asig.tipo_persona,
        asig.usuarios_pagados?.categoria,
        asig.rodeos?.duracion_dias || asig.duracion_dias_aplicada,
        tarifas
    );

    const { data, error } = await supabase
        .from('asignaciones')
        .update({
            categoria_aplicada: calculo.categoria_aplicada,
            valor_diario_aplicado: calculo.valor_diario_aplicado,
            pago_base_calculado: calculo.pago_base_calculado,
            updated_at: new Date().toISOString()
        })
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'asignaciones',
        registro_id: req.params.id,
        accion: 'editar',
        datos_anteriores: { valor_diario_aplicado: asig.valor_diario_aplicado, pago_base_calculado: asig.pago_base_calculado },
        datos_nuevos: { valor_diario_aplicado: calculo.valor_diario_aplicado, pago_base_calculado: calculo.pago_base_calculado },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: 'Asignación recalculada con tarifas actuales',
        ip_address: req.ip
    });

    res.json(data);
});

// DELETE /api/admin/asignaciones/:id
router.delete('/:id', async (req, res) => {
    const { data: asig } = await supabase
        .from('asignaciones')
        .select('rodeo_id, usuario_pagado_id, tipo_persona')
        .eq('id', req.params.id)
        .single();

    if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });

    await supabase
        .from('asignaciones')
        .update({ estado: 'anulado', updated_at: new Date().toISOString() })
        .eq('id', req.params.id);

    await auditoria.registrar({
        tabla: 'asignaciones',
        registro_id: req.params.id,
        accion: 'eliminar',
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: 'Asignación anulada',
        ip_address: req.ip
    });

    res.json({ mensaje: 'Asignación anulada' });
});

// GET /api/admin/asignaciones/pendientes/sugerencias?q=texto
// Búsqueda en tiempo real de jurados por nombre (para el modal de resolver)
router.get('/pendientes/sugerencias', async (req, res) => {
    const { q = '' } = req.query;
    if (q.trim().length < 2) return res.json({ data: [] });

    const { data, error } = await supabase
        .from('usuarios_pagados')
        .select('id, nombre_completo, codigo_interno, categoria, tipo_persona')
        .eq('activo', true)
        .eq('tipo_persona', 'jurado')
        .ilike('nombre_completo', `%${q.trim()}%`)
        .order('nombre_completo')
        .limit(8);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ data: data || [] });
});

// GET /api/admin/asignaciones/pendientes
router.get('/pendientes/lista', async (req, res) => {
    const { page = 1, limit = 50, problema } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
        .from('importaciones_pendientes')
        .select(`
            id, datos_originales, problema, estado, created_at,
            importaciones(nombre_archivo, created_at)
        `, { count: 'exact' })
        .eq('estado', 'pendiente')
        .order('created_at', { ascending: false })
        .range(offset, offset + parseInt(limit) - 1);

    if (problema) query = query.eq('problema', problema);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ data, total: count });
});

// POST /api/admin/asignaciones/pendientes/:id/resolver
router.post('/pendientes/:id/resolver', async (req, res) => {
    const { usuario_pagado_id, tipo_rodeo_id, club, asociacion, fecha, accion } = req.body;
    // accion: 'insertar' | 'descartar'

    const { data: pendiente } = await supabase
        .from('importaciones_pendientes')
        .select('*')
        .eq('id', req.params.id)
        .single();

    if (!pendiente) return res.status(404).json({ error: 'Registro pendiente no encontrado' });
    if (pendiente.estado !== 'pendiente') {
        return res.status(400).json({ error: 'Este registro ya fue resuelto' });
    }

    if (accion === 'descartar') {
        await supabase
            .from('importaciones_pendientes')
            .update({ estado: 'descartado', resuelto_por: req.usuario.id, resuelto_at: new Date().toISOString() })
            .eq('id', req.params.id);

        return res.json({ mensaje: 'Registro descartado' });
    }

    if (accion === 'insertar') {
        if (!usuario_pagado_id || !tipo_rodeo_id) {
            return res.status(400).json({ error: 'usuario_pagado_id y tipo_rodeo_id son requeridos para insertar' });
        }

        const { data: usuario } = await supabase
            .from('usuarios_pagados')
            .select('id, nombre_completo, tipo_persona, categoria')
            .eq('id', usuario_pagado_id)
            .single();

        const { data: tipo } = await supabase
            .from('tipos_rodeo')
            .select('id, nombre, duracion_dias')
            .eq('id', tipo_rodeo_id)
            .single();

        if (!usuario || !tipo) {
            return res.status(400).json({ error: 'Usuario o tipo de rodeo inválido' });
        }

        const tarifas = await obtenerTarifas();
        const calculo = calcularPagoBase('jurado', usuario.categoria, tipo.duracion_dias, tarifas);
        const fechaFinal = fecha || pendiente.datos_originales?.Fecha || pendiente.datos_originales?.fecha;
        const clubFinal = club || pendiente.datos_originales?.Club || pendiente.datos_originales?.club || '';
        const asocFinal = asociacion || pendiente.datos_originales?.Asociacion || '';

        // Crear rodeo si no existe
        let rodeoId;
        const { data: rodeoExistente } = await supabase
            .from('rodeos')
            .select('id')
            .eq('fecha', fechaFinal)
            .ilike('club', clubFinal)
            .eq('tipo_rodeo_id', tipo_rodeo_id)
            .limit(1);

        if (rodeoExistente && rodeoExistente.length > 0) {
            rodeoId = rodeoExistente[0].id;
        } else {
            const { data: nuevoRodeo } = await supabase
                .from('rodeos')
                .insert({
                    club: clubFinal,
                    asociacion: asocFinal,
                    fecha: fechaFinal,
                    tipo_rodeo_id,
                    tipo_rodeo_nombre: tipo.nombre,
                    duracion_dias: tipo.duracion_dias,
                    origen: 'importado',
                    importacion_id: pendiente.importacion_id,
                    created_by: req.usuario.id
                })
                .select()
                .single();
            rodeoId = nuevoRodeo.id;
        }

        const { data: asignacion } = await supabase
            .from('asignaciones')
            .insert({
                rodeo_id: rodeoId,
                usuario_pagado_id,
                tipo_persona: 'jurado',
                nombre_importado: usuario.nombre_completo,
                categoria_aplicada: calculo.categoria_aplicada,
                valor_diario_aplicado: calculo.valor_diario_aplicado,
                duracion_dias_aplicada: tipo.duracion_dias,
                pago_base_calculado: calculo.pago_base_calculado,
                estado: 'activo',
                created_by: req.usuario.id
            })
            .select()
            .single();

        await supabase
            .from('importaciones_pendientes')
            .update({
                estado: 'resuelto',
                asignacion_id: asignacion.id,
                rodeo_id: rodeoId,
                resuelto_por: req.usuario.id,
                resuelto_at: new Date().toISOString()
            })
            .eq('id', req.params.id);

        return res.json({ mensaje: 'Registro resuelto e insertado', asignacion });
    }

    res.status(400).json({ error: 'accion debe ser insertar o descartar' });
});

module.exports = router;
