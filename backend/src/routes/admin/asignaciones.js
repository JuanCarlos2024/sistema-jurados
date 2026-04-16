const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');
const { obtenerTarifas, calcularPagoBase, obtenerBonoParaDistancia } = require('../../services/calculo');

// ─── Helper: crea o actualiza bono de distancia (flujo admin) ──────────────────
// Siempre deja el bono en estado 'pendiente' (el admin debe aprobarlo manualmente).
// Si no hay tramo configurado, crea bono con $0 para que el admin revise el monto.
// Maneja 4 casos: sin bono previo | bono pendiente | bono aprobado/modificado | bono rechazado.
async function upsertBonoDistanciaAdmin(asigId, usuarioPagadoId, km, ahora) {
    if (!km || km <= 0) return { mensajeBono: '', bonoCreado: null };

    let config;
    try { config = await obtenerBonoParaDistancia(km); }
    catch (e) {
        console.error(`[BONO-ADMIN] Error obteniendo config para ${km} km: ${e.message}`);
        return { mensajeBono: 'No se pudo calcular bono (error interno).', bonoCreado: null };
    }

    // Buscar bono activo (no rechazado) más reciente para esta asignación
    const { data: bonosExist } = await supabase
        .from('bonos_solicitados')
        .select('id, estado, monto_solicitado')
        .eq('asignacion_id', asigId)
        .neq('estado', 'rechazado')
        .order('created_at', { ascending: false })
        .limit(1);
    const existing = bonosExist?.[0];

    const monto = config ? config.monto : 0;
    const payload = {
        distancia_declarada: km,
        monto_solicitado:    monto,
        bono_config_id:      config ? config.id : null,
        estado:              'pendiente',
        monto_aprobado:      null,
        observacion_admin:   null,
        revisado_por:        null,
        revisado_at:         null,
        updated_at:          ahora
    };

    let bonoCreado = null;
    let mensajeBono = '';

    if (existing) {
        const prevEstado = existing.estado;
        const { data: b, error } = await supabase
            .from('bonos_solicitados').update(payload).eq('id', existing.id).select().single();
        if (error) {
            console.error(`[BONO-ADMIN] Error actualizando bono ${existing.id}: ${error.message}`);
            return { mensajeBono: 'No se pudo actualizar solicitud de bono.', bonoCreado: null };
        }
        bonoCreado = b;
        mensajeBono = prevEstado === 'pendiente'
            ? `Solicitud de bono actualizada ($${monto.toLocaleString('es-CL')}).`
            : `Bono reabierto a revisión — $${monto.toLocaleString('es-CL')}.`;
    } else {
        const { data: b, error } = await supabase
            .from('bonos_solicitados')
            .insert({ asignacion_id: asigId, usuario_pagado_id: usuarioPagadoId, ...payload })
            .select().single();
        if (error) {
            console.error(`[BONO-ADMIN] Error creando bono: ${error.message}`);
            return { mensajeBono: 'No se pudo crear solicitud de bono.', bonoCreado: null };
        }
        bonoCreado = b;
        mensajeBono = `Bono de $${monto.toLocaleString('es-CL')} creado (pendiente de aprobación).`;
    }

    if (config === null && bonoCreado) {
        mensajeBono = `${km} km registrado. Sin tramo configurado — bono en $0 para revisión manual del monto.`;
    }

    console.log(`[BONO-ADMIN] asig=${asigId} km=${km} config=${config ? config.nombre + ' $' + config.monto : 'null'} bono=${bonoCreado?.id} estado=pendiente`);
    return { mensajeBono, bonoCreado };
}

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
                    estado_designacion: 'pendiente',
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
// Acepta: usuario_pagado_id (cambio de persona), observacion, valor_diario_aplicado (override manual),
//         distancia_km (genera/actualiza bono pendiente)
router.patch('/:id', async (req, res) => {
    const { usuario_pagado_id, observacion, valor_diario_aplicado, distancia_km } = req.body;

    const { data: anterior } = await supabase
        .from('asignaciones')
        .select('*, rodeos(duracion_dias)')
        .eq('id', req.params.id)
        .single();

    if (!anterior) return res.status(404).json({ error: 'Asignación no encontrada' });
    if (anterior.estado === 'anulado') return res.status(400).json({ error: 'No se puede editar una asignación anulada' });

    const cambios = { updated_at: new Date().toISOString() };
    if (observacion !== undefined) cambios.observacion = observacion;

    // Cambio de persona asignada
    if (usuario_pagado_id && usuario_pagado_id !== anterior.usuario_pagado_id) {
        const { data: usuario } = await supabase
            .from('usuarios_pagados')
            .select('id, nombre_completo, tipo_persona, categoria, activo')
            .eq('id', usuario_pagado_id)
            .single();

        if (!usuario || !usuario.activo) {
            return res.status(400).json({ error: 'Usuario no encontrado o inactivo' });
        }

        const tarifas = await obtenerTarifas();
        const duracion = anterior.rodeos?.duracion_dias || anterior.duracion_dias_aplicada;
        const calculo = calcularPagoBase(usuario.tipo_persona, usuario.categoria, duracion, tarifas);

        cambios.usuario_pagado_id = usuario_pagado_id;
        cambios.tipo_persona = usuario.tipo_persona;
        cambios.nombre_importado = usuario.nombre_completo;
        cambios.categoria_aplicada = calculo.categoria_aplicada;
        cambios.valor_diario_aplicado = calculo.valor_diario_aplicado;
        cambios.pago_base_calculado = calculo.pago_base_calculado;
    } else if (valor_diario_aplicado !== undefined) {
        // Override manual del valor diario (sin cambiar persona)
        const vd = parseFloat(valor_diario_aplicado);
        if (isNaN(vd) || vd < 0) return res.status(400).json({ error: 'valor_diario_aplicado inválido' });
        cambios.valor_diario_aplicado = vd;
        cambios.pago_base_calculado = Math.round(vd * anterior.duracion_dias_aplicada);
    }

    // Kilometraje — genera o actualiza bono de distancia (siempre queda pendiente)
    let mensajeKm = '';
    if (distancia_km !== undefined) {
        const km = parseInt(distancia_km);
        if (isNaN(km) || km <= 0) return res.status(400).json({ error: 'distancia_km debe ser un número positivo' });
        cambios.distancia_km = km;
        // Si se cambió la persona, usar el nuevo usuario_pagado_id para el bono
        const uidParaBono = (usuario_pagado_id && usuario_pagado_id !== anterior.usuario_pagado_id)
            ? usuario_pagado_id
            : anterior.usuario_pagado_id;
        const ahora = new Date().toISOString();
        const { mensajeBono } = await upsertBonoDistanciaAdmin(req.params.id, uidParaBono, km, ahora);
        mensajeKm = mensajeBono;
    }

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
        datos_anteriores: { usuario_pagado_id: anterior.usuario_pagado_id, pago_base_calculado: anterior.pago_base_calculado },
        datos_nuevos: cambios,
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: usuario_pagado_id && usuario_pagado_id !== anterior.usuario_pagado_id
            ? `Persona reasignada en rodeo ${anterior.rodeo_id}`
            : 'Asignación editada',
        ip_address: req.ip
    });

    res.json({ ...data, mensaje_bono: mensajeKm || undefined });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/asignaciones/:id/estado
// Cambia estado_designacion sin restricción de fecha (solo admin).
// body: { accion: 'aceptar'|'rechazar'|'pendiente', distancia_km?: number, motivo?: string }
//
// Política de bonos al cambiar estado:
//   aceptar  → upsert bono si hay km + config (igual que usuario, pero sin fecha check)
//   rechazar → rechaza bonos pendientes de esa asignación (no puede cobrar si no asistió)
//   pendiente→ sin cambios en bonos (reabre la designación para que el usuario responda)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/estado', async (req, res) => {
    const { accion, distancia_km, motivo } = req.body;

    if (!['aceptar', 'rechazar', 'pendiente'].includes(accion)) {
        return res.status(400).json({ error: 'accion debe ser aceptar, rechazar o pendiente' });
    }

    const { data: asig } = await supabase
        .from('asignaciones')
        .select('id, rodeo_id, usuario_pagado_id, tipo_persona, estado, estado_designacion, distancia_km, rodeos(club, asociacion, fecha)')
        .eq('id', req.params.id)
        .single();

    if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });
    if (asig.estado === 'anulado') return res.status(400).json({ error: 'No se puede cambiar el estado de una asignación anulada' });

    const ahora        = new Date().toISOString();
    const estadoAntes  = asig.estado_designacion;
    const campos       = { updated_at: ahora };
    let mensajeBono    = '';
    let bonoCreado     = null;

    if (accion === 'aceptar') {
        campos.estado_designacion      = 'aceptado';
        campos.aceptado_en             = ahora;
        campos.observacion_designacion = null;

        // Km (opcional al aceptar desde admin; puede no tener km en rodeos pasados)
        const km = distancia_km ? parseInt(distancia_km) : null;
        if (km && km > 0) {
            campos.distancia_km = km;
            const { mensajeBono: mb, bonoCreado: b } = await upsertBonoDistanciaAdmin(
                req.params.id, asig.usuario_pagado_id, km, ahora
            );
            mensajeBono = mb;
            bonoCreado  = b;
        }

    } else if (accion === 'rechazar') {
        campos.estado_designacion = 'rechazado';
        if (motivo) campos.observacion_designacion = motivo.trim();

        // Rechazar bonos pendientes de esta asignación (no puede cobrar si no asistió)
        const { data: bonosRechazados } = await supabase
            .from('bonos_solicitados')
            .update({ estado: 'rechazado', observacion_admin: 'Designación rechazada por admin', updated_at: ahora })
            .eq('asignacion_id', req.params.id)
            .eq('estado', 'pendiente')
            .select('id');
        if (bonosRechazados?.length > 0) {
            mensajeBono = `${bonosRechazados.length} bono(s) pendiente(s) rechazado(s).`;
        }

    } else {
        // pendiente → reabre designación
        campos.estado_designacion       = 'pendiente';
        campos.aceptado_en              = null;
        campos.observacion_designacion  = null;
    }

    const { data: actualizado, error: errUpd } = await supabase
        .from('asignaciones')
        .update(campos)
        .eq('id', req.params.id)
        .select()
        .single();

    if (errUpd) return res.status(500).json({ error: errUpd.message });

    const descripcionMap = {
        aceptar:   `Designación aceptada por admin: ${asig.rodeos?.club} (${asig.rodeos?.fecha})${distancia_km ? ` — ${distancia_km} km` : ''}`,
        rechazar:  `Designación rechazada por admin: ${asig.rodeos?.club} (${asig.rodeos?.fecha})${motivo ? ` — motivo: ${motivo}` : ''}`,
        pendiente: `Designación reabierta a pendiente por admin: ${asig.rodeos?.club} (${asig.rodeos?.fecha})`
    };

    await auditoria.registrar({
        tabla:            'asignaciones',
        registro_id:      req.params.id,
        accion:           'editar',
        datos_anteriores: { estado_designacion: estadoAntes },
        datos_nuevos:     { estado_designacion: campos.estado_designacion, distancia_km: distancia_km || undefined },
        actor_id:         req.usuario.id,
        actor_tipo:       'administrador',
        descripcion:      descripcionMap[accion],
        ip_address:       req.ip
    });

    console.log(`[ADMIN-ESTADO] asig=${req.params.id} accion=${accion} antes=${estadoAntes} ahora=${campos.estado_designacion} admin=${req.usuario.id} rodeo=${asig.rodeos?.fecha} club="${asig.rodeos?.club}"`);

    return res.json({
        mensaje:      `Designación ${accion === 'aceptar' ? 'aceptada' : accion === 'rechazar' ? 'rechazada' : 'reabierta'} correctamente. ${mensajeBono}`.trim(),
        estado_nuevo: campos.estado_designacion,
        bono_creado:  !!bonoCreado
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/asignaciones/:id/km
// Admin actualiza kilómetros de una asignación y crea/actualiza bono pendiente.
// Sin restricción de fecha (admin puede editar rodeos históricos).
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/km', async (req, res) => {
    const km = parseInt(req.body.distancia_km);
    if (!req.body.distancia_km || isNaN(km) || km <= 0) {
        return res.status(400).json({ error: 'distancia_km es requerida (número positivo)' });
    }

    const { data: asig } = await supabase
        .from('asignaciones')
        .select('id, usuario_pagado_id, estado, distancia_km')
        .eq('id', req.params.id)
        .single();

    if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });
    if (asig.estado === 'anulado') return res.status(400).json({ error: 'La asignación está anulada' });

    const ahora = new Date().toISOString();

    const { error: errUpd } = await supabase
        .from('asignaciones')
        .update({ distancia_km: km, updated_at: ahora })
        .eq('id', req.params.id);
    if (errUpd) return res.status(500).json({ error: errUpd.message });

    const { mensajeBono, bonoCreado } = await upsertBonoDistanciaAdmin(
        req.params.id, asig.usuario_pagado_id, km, ahora
    );

    await auditoria.registrar({
        tabla: 'asignaciones',
        registro_id: req.params.id,
        accion: 'editar',
        datos_anteriores: { distancia_km: asig.distancia_km },
        datos_nuevos: { distancia_km: km },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Km actualizados por admin: ${km} km`,
        ip_address: req.ip
    });

    return res.json({
        mensaje: `Kilómetros actualizados: ${km} km. ${mensajeBono}`.trim(),
        bono_creado: !!bonoCreado
    });
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

// DELETE /api/admin/asignaciones/:id — anula asignación y rechaza sus bonos pendientes
router.delete('/:id', async (req, res) => {
    const { data: asig } = await supabase
        .from('asignaciones')
        .select('rodeo_id, usuario_pagado_id, tipo_persona, nombre_importado')
        .eq('id', req.params.id)
        .single();

    if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });

    const ahora = new Date().toISOString();

    // 1. Rechazar bonos pendientes de esta asignación
    await supabase
        .from('bonos_solicitados')
        .update({ estado: 'rechazado', updated_at: ahora })
        .eq('asignacion_id', req.params.id)
        .eq('estado', 'pendiente');

    // 2. Anular la asignación
    await supabase
        .from('asignaciones')
        .update({ estado: 'anulado', updated_at: ahora })
        .eq('id', req.params.id);

    await auditoria.registrar({
        tabla: 'asignaciones',
        registro_id: req.params.id,
        accion: 'eliminar',
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Asignación eliminada: ${asig.nombre_importado || asig.usuario_pagado_id} del rodeo ${asig.rodeo_id}`,
        ip_address: req.ip
    });

    res.json({ mensaje: 'Asignación eliminada y bonos pendientes rechazados' });
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
                estado_designacion: 'pendiente',
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
