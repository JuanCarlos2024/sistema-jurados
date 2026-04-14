const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const { obtenerBonoParaDistancia } = require('../../services/calculo');

// GET /api/usuario/bonos — bonos del usuario
router.get('/', async (req, res) => {
    const { data, error } = await supabase
        .from('bonos_solicitados')
        .select(`
            id, distancia_declarada, monto_solicitado, monto_aprobado,
            estado, observacion_usuario, observacion_admin, created_at,
            bono_config_id, bonos_config(nombre, distancia_minima, distancia_maxima, monto),
            asignaciones(id, tipo_persona, categoria_aplicada,
                rodeos(club, asociacion, fecha, tipo_rodeo_nombre))
        `)
        .eq('usuario_pagado_id', req.usuario.id)
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// POST /api/usuario/bonos — solicitar bono por distancia
router.post('/', async (req, res) => {
    const { asignacion_id, distancia_km, observacion } = req.body;

    if (!asignacion_id || !distancia_km) {
        return res.status(400).json({ error: 'asignacion_id y distancia_km son requeridos' });
    }

    const km = parseInt(distancia_km);
    if (km <= 0) {
        return res.status(400).json({ error: 'La distancia debe ser mayor a 0 km' });
    }

    // Verificar que la asignación pertenezca al usuario
    const { data: asig } = await supabase
        .from('asignaciones')
        .select('id, rodeo_id, estado')
        .eq('id', asignacion_id)
        .eq('usuario_pagado_id', req.usuario.id)
        .single();

    if (!asig) {
        return res.status(403).json({ error: 'Asignación no encontrada o no pertenece a su perfil' });
    }
    if (asig.estado !== 'activo') {
        return res.status(400).json({ error: 'No se puede solicitar bono para una asignación anulada' });
    }

    // Verificar que no tenga ya un bono activo (pendiente o aprobado)
    const { data: bonoExistente } = await supabase
        .from('bonos_solicitados')
        .select('id, estado')
        .eq('asignacion_id', asignacion_id)
        .eq('usuario_pagado_id', req.usuario.id)
        .in('estado', ['pendiente', 'aprobado', 'modificado'])
        .limit(1);

    if (bonoExistente && bonoExistente.length > 0) {
        return res.status(400).json({
            error: `Ya existe un bono en estado "${bonoExistente[0].estado}" para esta asignación`
        });
    }

    // Buscar bono correspondiente a la distancia (puede ser null si no hay tramo configurado)
    // En ese caso se crea igual con monto=0 para que el admin lo revise y fije el monto
    const bonoConfig = await obtenerBonoParaDistancia(km);

    // km < 350 → aprobado_auto ($0, sin revisión admin)
    // km >= 350 → pendiente (requiere revisión admin)
    const esAuto = bonoConfig === null;
    const { data, error } = await supabase
        .from('bonos_solicitados')
        .insert({
            asignacion_id,
            usuario_pagado_id:   req.usuario.id,
            bono_config_id:      bonoConfig ? bonoConfig.id : null,
            distancia_declarada: km,
            monto_solicitado:    bonoConfig ? bonoConfig.monto : 0,
            monto_aprobado:      esAuto ? 0 : null,
            estado:              esAuto ? 'aprobado_auto' : 'pendiente',
            observacion_usuario: observacion || null
        })
        .select(`
            id, distancia_declarada, monto_solicitado, estado,
            bonos_config(nombre, monto)
        `)
        .single();

    if (error) return res.status(500).json({ error: error.message });

    const mensaje = esAuto
        ? `Distancia de ${km} km registrada — sin bono aplicable (< 350 km). No requiere revisión del administrador.`
        : `Bono solicitado: ${bonoConfig.nombre} ($${bonoConfig.monto.toLocaleString('es-CL')}). Queda pendiente de aprobación.`;

    res.status(201).json({ ...data, mensaje });
});

// GET /api/usuario/bonos/config-activos — ver bonos disponibles
router.get('/config-activos', async (req, res) => {
    const { data, error } = await supabase
        .from('bonos_config')
        .select('id, nombre, distancia_minima, distancia_maxima, monto')
        .eq('activo', true)
        .order('distancia_minima');

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

module.exports = router;
