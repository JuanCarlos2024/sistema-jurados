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
        .select('id, rodeo_id, usuario_pagado_id, estado, estado_designacion, rodeos(club, fecha)')
        .eq('id', req.params.id)
        .eq('usuario_pagado_id', req.usuario.id)
        .single();

    if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });
    if (asig.estado === 'anulado') return res.status(400).json({ error: 'La asignación está anulada' });
    if (asig.estado_designacion === 'aceptado') return res.status(400).json({ error: 'Esta designación ya fue aceptada' });
    if (asig.estado_designacion === 'rechazado') return res.status(400).json({ error: 'Esta designación ya fue rechazada' });

    const ahora = new Date().toISOString();

    if (accion === 'aceptar') {
        const km = parseInt(distancia_km);
        if (!distancia_km || isNaN(km) || km < 0) {
            return res.status(400).json({ error: 'distancia_km es requerida al aceptar (número positivo)' });
        }

        await supabase
            .from('asignaciones')
            .update({ estado_designacion: 'aceptado', distancia_km: km, aceptado_en: ahora, updated_at: ahora })
            .eq('id', req.params.id);

        // Auto-crear bono pendiente si hay configuración para esa distancia
        let bonoCreado = null;
        try {
            const config = await obtenerBonoParaDistancia(km);
            if (config) {
                const { data: bono } = await supabase
                    .from('bonos_solicitados')
                    .insert({
                        asignacion_id:    req.params.id,
                        usuario_pagado_id: req.usuario.id,
                        distancia_declarada: km,
                        monto_solicitado: config.monto,
                        bono_config_id:   config.id,
                        estado:           'pendiente',
                        created_by:       req.usuario.id
                    })
                    .select()
                    .single();
                bonoCreado = bono;
            }
        } catch(e) { /* ignorar error de bono — la aceptación ya se guardó */ }

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

        return res.json({
            mensaje: bonoCreado
                ? `Designación aceptada. Bono de $${bonoCreado.monto_solicitado?.toLocaleString('es-CL')} solicitado automáticamente.`
                : 'Designación aceptada correctamente.',
            bono_creado: !!bonoCreado
        });
    }

    // accion === 'rechazar'
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

module.exports = router;
