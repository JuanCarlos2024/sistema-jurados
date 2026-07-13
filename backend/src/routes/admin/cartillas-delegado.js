const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');

// ─── GET /api/admin/cartillas-delegado/by-rodeo/:rodeo_id ────────────────────
// Lista las cartillas de delegado de un rodeo con datos del delegado.
router.get('/by-rodeo/:rodeo_id', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('cartillas_delegado')
            .select(`
                id, estado, enviada_en, created_at, updated_at,
                temporada, fecha_rodeo, tipo_rodeo, club_asociacion_organizador,
                delegado_nombre, delegado_telefono,
                delegado:usuarios_pagados!cartillas_delegado_delegado_id_fkey(
                    id, nombre_completo, tipo_persona
                )
            `)
            .eq('rodeo_id', req.params.rodeo_id)
            .order('created_at', { ascending: false });

        if (error) return res.status(500).json({ error: error.message });
        res.json(data || []);
    } catch (err) {
        console.error('[CARTILLAS-DELEGADO by-rodeo]', err.message);
        res.status(500).json({ error: 'Error interno al cargar cartillas del delegado' });
    }
});

// ─── GET /api/admin/cartillas-delegado/:id ───────────────────────────────────
// Detalle completo de una cartilla del delegado.
router.get('/:id', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('cartillas_delegado')
            .select(`
                *,
                delegado:usuarios_pagados!cartillas_delegado_delegado_id_fkey(
                    id, nombre_completo, telefono, tipo_persona
                ),
                rodeo:rodeos!cartillas_delegado_rodeo_id_fkey(
                    id, club, asociacion, fecha, tipo_rodeo_nombre, categoria_rodeo_nombre
                )
            `)
            .eq('id', req.params.id)
            .single();

        if (error || !data) return res.status(404).json({ error: 'Cartilla no encontrada' });
        res.json(data);
    } catch (err) {
        console.error('[CARTILLAS-DELEGADO detalle]', err.message);
        res.status(500).json({ error: 'Error interno al cargar cartilla del delegado' });
    }
});

module.exports = router;
