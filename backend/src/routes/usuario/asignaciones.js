const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');
const { obtenerBonoParaDistancia } = require('../../services/calculo');

// POST /api/usuario/asignaciones/:id/responder
// body: { accion: 'aceptar'|'rechazar', distancia_km?: number, observacion_designacion?: string }
router.post('/:id/responder', async (req, res) => {
    const { accion, distancia_km, observacion_designacion } = req.body;

    if (!['aceptar', 'rechazar'].includes(accion)) {
        return res.status(400).json({ error: 'accion debe ser aceptar o rechazar' });
    }

    // Verificar que la asignación pertenece al usuario autenticado
    const { data: asig } = await supabase
        .from('asignaciones')
        .select('id, rodeo_id, usuario_pagado_id, estado, estado_designacion, rodeos(club, asociacion, fecha)')
        .eq('id', req.params.id)
        .eq('usuario_pagado_id', req.usuario.id)
        .single();

    if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });
    if (asig.estado === 'anulado') return res.status(400).json({ error: 'La asignación está anulada' });
    if (asig.estado_designacion === 'aceptado') return res.status(400).json({ error: 'Esta designación ya fue aceptada' });
    if (asig.estado_designacion === 'rechazado') return res.status(400).json({ error: 'Esta designación ya fue rechazada' });

    // Validar que el rodeo es futuro (fecha >= hoy en timezone Chile).
    // "hoy" incluido: el usuario puede responder el mismo día del rodeo.
    // Rodeos pasados son de solo lectura.
    const fechaRodeo = asig.rodeos?.fecha; // 'YYYY-MM-DD'
    const hoyChile = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
    if (!fechaRodeo || fechaRodeo < hoyChile) {
        console.warn(`[ASIG] 400 cambio_estado bloqueado — rodeo pasado: asig=${req.params.id} fecha=${fechaRodeo} hoy_cl=${hoyChile} usuario=${req.usuario.id}`);
        return res.status(400).json({
            error: 'No se puede cambiar el estado de designación de un rodeo pasado. Solo se permite en rodeos de hoy en adelante.'
        });
    }

    const ahora = new Date().toISOString();

    if (accion === 'aceptar') {
        const km = parseInt(distancia_km);
        if (!distancia_km || isNaN(km) || km <= 0) {
            return res.status(400).json({ error: 'distancia_km es requerida al aceptar (número positivo)' });
        }

        console.log(`[ASIG] cambio_estado: usuario=${req.usuario.id} asig=${req.params.id} rodeo=${asig.rodeo_id} fecha=${fechaRodeo} club="${asig.rodeos?.club}" estado_anterior=${asig.estado_designacion||'null'} nuevo=aceptado km=${km}`);

        await supabase
            .from('asignaciones')
            .update({ estado_designacion: 'aceptado', distancia_km: km, aceptado_en: ahora, updated_at: ahora })
            .eq('id', req.params.id);

        // Auto-crear bono pendiente SIEMPRE que hay km (con o sin tramo configurado).
        // Si no hay bonos_config para esa distancia → monto_solicitado=0, admin lo revisa y aprueba con monto manual.
        let bonoCreado = null;
        let bonoError  = null;
        try {
            const config = await obtenerBonoParaDistancia(km);
            console.log(`[BONO-AUTO] asig=${req.params.id} km=${km} config=${config ? config.nombre + ' $' + config.monto : 'null (sin tramo — bono con $0 para revisión admin)'}`);

            const { data: bono, error: errBono } = await supabase
                .from('bonos_solicitados')
                .insert({
                    asignacion_id:       req.params.id,
                    usuario_pagado_id:   req.usuario.id,
                    distancia_declarada: km,
                    monto_solicitado:    config ? config.monto : 0,
                    bono_config_id:      config ? config.id : null,
                    estado:              'pendiente'
                })
                .select()
                .single();
            if (errBono) {
                console.error(`[BONO-AUTO] Error al insertar bono: asig=${req.params.id} km=${km} code=${errBono.code} details=${errBono.details} hint=${errBono.hint} msg=${errBono.message}`);
                bonoError = errBono.message;
            } else {
                bonoCreado = bono;
                console.log(`[BONO-AUTO] Bono creado: id=${bono.id} monto=${bono.monto_solicitado}`);
            }
        } catch(e) {
            console.error(`[BONO-AUTO] Excepción inesperada: asig=${req.params.id} km=${km} err=${e.message}`);
            bonoError = e.message;
        }

        await auditoria.registrar({
            tabla: 'asignaciones',
            registro_id: req.params.id,
            accion: 'editar',
            datos_nuevos: { estado_designacion: 'aceptado', distancia_km: km },
            actor_id: req.usuario.id,
            actor_tipo: 'usuario_pagado',
            descripcion: `Designación aceptada: ${asig.rodeos?.club} (${asig.rodeos?.fecha}), distancia: ${km} km`,
            ip_address: req.ip
        });

        let mensajeRespuesta;
        if (bonoCreado) {
            if (bonoCreado.monto_solicitado > 0) {
                mensajeRespuesta = `Designación aceptada. Bono de $${bonoCreado.monto_solicitado?.toLocaleString('es-CL')} solicitado (pendiente de aprobación).`;
            } else {
                mensajeRespuesta = `Designación aceptada. Declaración de ${km} km enviada al administrador para fijar monto.`;
            }
        } else if (bonoError) {
            mensajeRespuesta = `Designación aceptada. Error al crear solicitud de bono — contacte al administrador.`;
        } else {
            mensajeRespuesta = 'Designación aceptada.';
        }

        return res.json({
            mensaje:     mensajeRespuesta,
            bono_creado: !!bonoCreado,
            bono_error:  bonoError || undefined
        });
    }

    // accion === 'rechazar'
    console.log(`[ASIG] cambio_estado: usuario=${req.usuario.id} asig=${req.params.id} rodeo=${asig.rodeo_id} fecha=${fechaRodeo} club="${asig.rodeos?.club}" estado_anterior=${asig.estado_designacion||'null'} nuevo=rechazado`);
    const cambios = { estado_designacion: 'rechazado', updated_at: ahora };
    if (observacion_designacion) cambios.observacion_designacion = observacion_designacion.trim();

    await supabase
        .from('asignaciones')
        .update(cambios)
        .eq('id', req.params.id);

    await auditoria.registrar({
        tabla: 'asignaciones',
        registro_id: req.params.id,
        accion: 'editar',
        datos_nuevos: { estado_designacion: 'rechazado' },
        actor_id: req.usuario.id,
        actor_tipo: 'usuario_pagado',
        descripcion: `Designación rechazada: ${asig.rodeos?.club} (${asig.rodeos?.fecha})`,
        ip_address: req.ip
    });

    return res.json({ mensaje: 'Designación rechazada.' });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/usuario/asignaciones/:id/km
// Actualiza kilómetros en una designación ya aceptada + upsert del bono.
//
// Política de bono:
//   • Sin bono existente          → crear nuevo bono pendiente (si hay config)
//   • Bono pendiente              → actualizar km y monto_solicitado
//   • Bono aprobado/modificado    → reabrir a pendiente (requiere re-aprobación)
//   • Bono rechazado              → crear nuevo bono pendiente
//   • Solo rodeos futuros (fecha >= hoy Chile) admiten cambio de km
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/km', async (req, res) => {
    const km = parseInt(req.body.distancia_km);
    if (!req.body.distancia_km || isNaN(km) || km <= 0) {
        return res.status(400).json({ error: 'distancia_km es requerida (número positivo)' });
    }

    const { data: asig } = await supabase
        .from('asignaciones')
        .select('id, rodeo_id, usuario_pagado_id, estado, estado_designacion, distancia_km, rodeos(club, fecha)')
        .eq('id', req.params.id)
        .eq('usuario_pagado_id', req.usuario.id)
        .single();

    if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });
    if (asig.estado === 'anulado') return res.status(400).json({ error: 'La asignación está anulada' });
    if (asig.estado_designacion !== 'aceptado') {
        return res.status(400).json({ error: 'Solo se puede actualizar km en designaciones aceptadas' });
    }

    const fechaRodeo = asig.rodeos?.fecha;
    const hoyChile   = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
    if (!fechaRodeo || fechaRodeo < hoyChile) {
        return res.status(400).json({ error: 'No se puede actualizar km de un rodeo pasado' });
    }

    const ahora = new Date().toISOString();

    // Actualizar distancia_km en la asignación
    const { error: errUpd } = await supabase
        .from('asignaciones')
        .update({ distancia_km: km, updated_at: ahora })
        .eq('id', req.params.id);
    if (errUpd) return res.status(500).json({ error: errUpd.message });

    // Obtener config de bono para la nueva distancia
    const config = await obtenerBonoParaDistancia(km);
    console.log(`[BONO-KM] asig=${req.params.id} km=${km} config=${config ? config.nombre : 'null'}`);

    // Buscar bono más reciente para esta asignación
    const { data: bonosExistentes } = await supabase
        .from('bonos_solicitados')
        .select('id, estado, monto_solicitado, monto_aprobado')
        .eq('asignacion_id', req.params.id)
        .order('created_at', { ascending: false })
        .limit(1);

    const existing = bonosExistentes?.[0];
    let bonoResultado = null;
    let mensajeBono   = '';

    if (existing && existing.estado === 'pendiente') {
        // Actualizar bono pendiente con nuevos km y monto
        const campos = { distancia_declarada: km, updated_at: ahora };
        if (config) { campos.monto_solicitado = config.monto; campos.bono_config_id = config.id; }
        const { data: upd, error: errUpd2 } = await supabase
            .from('bonos_solicitados').update(campos).eq('id', existing.id).select().single();
        if (!errUpd2) { bonoResultado = upd; mensajeBono = 'Solicitud de bono actualizada.'; }
        else console.error(`[BONO-KM] Error actualizando bono pendiente: ${errUpd2.message}`);

    } else if (existing && ['aprobado', 'modificado'].includes(existing.estado)) {
        // Reabrir a pendiente — el admin debe re-aprobar
        const campos = {
            estado:          'pendiente',
            distancia_declarada: km,
            monto_aprobado:  null,
            observacion_admin: null,
            revisado_por:    null,
            revisado_at:     null,
            updated_at:      ahora
        };
        if (config) { campos.monto_solicitado = config.monto; campos.bono_config_id = config.id; }
        const { data: upd, error: errUpd3 } = await supabase
            .from('bonos_solicitados').update(campos).eq('id', existing.id).select().single();
        if (!errUpd3) {
            bonoResultado = upd;
            mensajeBono = 'Bono reabierto a revisión (km cambió después de aprobación).';
            console.log(`[BONO-KM] Bono reabierto: id=${existing.id} estado_ant=${existing.estado} km_nuevo=${km}`);
        } else {
            console.error(`[BONO-KM] Error reabriendo bono: ${errUpd3.message}`);
        }

    } else {
        // Sin bono activo o rechazado → crear nuevo (siempre, con o sin tramo configurado)
        const { data: nuevo, error: errNew } = await supabase
            .from('bonos_solicitados')
            .insert({
                asignacion_id:       req.params.id,
                usuario_pagado_id:   req.usuario.id,
                distancia_declarada: km,
                monto_solicitado:    config ? config.monto : 0,
                bono_config_id:      config ? config.id : null,
                estado:              'pendiente'
            })
            .select().single();
        if (errNew) {
            console.error(`[BONO-KM] Error creando bono: code=${errNew.code} details=${errNew.details} hint=${errNew.hint} msg=${errNew.message}`);
            mensajeBono = 'No se pudo crear solicitud de bono. Contacte al administrador.';
        } else {
            bonoResultado = nuevo;
            mensajeBono = config
                ? 'Nueva solicitud de bono creada.'
                : `Declaración de ${km} km enviada al administrador para fijar monto.`;
            console.log(`[BONO-KM] Nuevo bono creado: id=${nuevo.id} monto=${nuevo.monto_solicitado}`);
        }
    }

    await auditoria.registrar({
        tabla:         'asignaciones',
        registro_id:   req.params.id,
        accion:        'editar',
        datos_anteriores: { distancia_km: asig.distancia_km },
        datos_nuevos:     { distancia_km: km },
        actor_id:      req.usuario.id,
        actor_tipo:    'usuario_pagado',
        descripcion:   `Km actualizados: ${asig.rodeos?.club} — ${km} km`,
        ip_address:    req.ip
    });

    return res.json({
        mensaje:         `Kilómetros actualizados: ${km} km. ${mensajeBono}`.trim(),
        bono_actualizado: !!bonoResultado
    });
});

module.exports = router;
