const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');

// GET /api/admin/cartillas-jurado/by-rodeo/:rodeo_id
// Devuelve todas las versiones de cartillas_jurado del rodeo, agrupadas por jurado
router.get('/by-rodeo/:rodeo_id', async (req, res) => {
    const { data, error } = await supabase
        .from('cartillas_jurado')
        .select(`
            id, asignacion_id, version, es_actual, estado,
            enviada_en, created_at, adjunto_id, storage_path_pdf,
            motivo_reapertura, reabierta_por, reabierta_en,
            reemplaza_cartilla_id,
            jurado:usuarios_pagados!cartillas_jurado_usuario_pagado_id_fkey(id, nombre_completo, categoria)
        `)
        .eq('rodeo_id', req.params.rodeo_id)
        .order('usuario_pagado_id')
        .order('version', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// GET /api/admin/cartillas-jurado/pdf/:id
// URL firmada del PDF de una versión específica
router.get('/pdf/:id', async (req, res) => {
    const { data: cartilla } = await supabase
        .from('cartillas_jurado')
        .select('storage_path_pdf, estado')
        .eq('id', req.params.id)
        .single();

    if (!cartilla) return res.status(404).json({ error: 'Cartilla no encontrada' });
    if (!cartilla.storage_path_pdf) return res.status(404).json({ error: 'Sin PDF adjunto' });

    const { data, error } = await supabase.storage
        .from('rodeo-adjuntos')
        .createSignedUrl(cartilla.storage_path_pdf, 3600);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ url: data.signedUrl });
});

// POST /api/admin/cartillas-jurado/:id/reabrir
// Actualiza en la misma fila: estado='reabierta', agrega motivo y metadata.
// No crea fila nueva — evita conflictos de índice parcial.
// Cuando el jurado reenvíe, ESE envío crea la nueva versión (version+1).
router.post('/:id/reabrir', async (req, res) => {
    const { motivo } = req.body;
    if (!motivo || !motivo.trim()) {
        return res.status(400).json({ error: 'El motivo de reapertura es obligatorio' });
    }

    const { data: cartilla } = await supabase
        .from('cartillas_jurado')
        .select('id, estado, es_actual, version, asignacion_id')
        .eq('id', req.params.id)
        .single();

    if (!cartilla) return res.status(404).json({ error: 'Cartilla no encontrada' });
    if (cartilla.estado !== 'enviada') {
        return res.status(409).json({ error: 'Solo se puede reabrir una cartilla en estado "enviada"' });
    }
    if (!cartilla.es_actual) {
        return res.status(409).json({ error: 'Solo se puede reabrir la versión actual de la cartilla' });
    }

    const ahora = new Date().toISOString();

    // Actualizar en la misma fila — sin crear fila nueva
    const { data: actualizada, error } = await supabase
        .from('cartillas_jurado')
        .update({
            estado:            'reabierta',
            motivo_reapertura: motivo.trim(),
            reabierta_por:     req.usuario.id,
            reabierta_en:      ahora,
            updated_at:        ahora
        })
        .eq('id', cartilla.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: 'Error al reabrir cartilla: ' + error.message });

    await supabase.from('auditoria').insert({
        tabla:        'cartillas_jurado',
        accion:       'reabrir_cartilla',
        registro_id:  cartilla.id,
        datos_nuevos: { version: cartilla.version, motivo: motivo.trim() },
        actor_id:     req.usuario.id,
        actor_tipo:   'administrador',
        ip_address:   req.ip
    }).catch(() => {});

    res.json({ mensaje: 'Cartilla reabierta. El jurado puede enviar una nueva versión.', cartilla: actualizada });
});

module.exports = router;
