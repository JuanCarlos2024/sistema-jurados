const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');

// ─── GET /api/usuario/disponibilidad?año=&mes= ───────────────
// Devuelve días disponibles del usuario en el mes indicado
router.get('/', async (req, res) => {
    const ahora = new Date();
    const año = parseInt(req.query.año) || ahora.getFullYear();
    const mes  = parseInt(req.query.mes)  || ahora.getMonth() + 1;

    const inicio = `${año}-${String(mes).padStart(2,'0')}-01`;
    const fin    = new Date(año, mes, 0).toISOString().split('T')[0]; // último día del mes

    const { data, error } = await supabase
        .from('disponibilidad_usuarios')
        .select('id, fecha')
        .eq('usuario_pagado_id', req.usuario.id)
        .gte('fecha', inicio)
        .lte('fecha', fin)
        .order('fecha');

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// ─── POST /api/usuario/disponibilidad ───────────────────────
// Marca un día como disponible (idempotente por UNIQUE constraint)
router.post('/', async (req, res) => {
    const { fecha } = req.body;
    if (!fecha) return res.status(400).json({ error: 'fecha requerida (YYYY-MM-DD)' });

    // Validar formato básico
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        return res.status(400).json({ error: 'Formato de fecha inválido. Use YYYY-MM-DD' });
    }

    // Solo permitir fechas del mes actual
    const hoy  = new Date();
    const [añoF, mesF] = fecha.split('-').map(Number);
    if (añoF !== hoy.getFullYear() || mesF !== hoy.getMonth() + 1) {
        return res.status(400).json({ error: 'Solo puede marcar disponibilidad en el mes actual' });
    }

    const { data, error } = await supabase
        .from('disponibilidad_usuarios')
        .upsert(
            { usuario_pagado_id: req.usuario.id, fecha },
            { onConflict: 'usuario_pagado_id,fecha', ignoreDuplicates: true }
        )
        .select()
        .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ mensaje: 'Disponibilidad registrada', fecha });
});

// ─── DELETE /api/usuario/disponibilidad/:fecha ───────────────
// Quita disponibilidad de un día (fecha en formato YYYY-MM-DD)
router.delete('/:fecha', async (req, res) => {
    const { fecha } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        return res.status(400).json({ error: 'Formato de fecha inválido' });
    }

    const { error } = await supabase
        .from('disponibilidad_usuarios')
        .delete()
        .eq('usuario_pagado_id', req.usuario.id)
        .eq('fecha', fecha);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ mensaje: 'Disponibilidad eliminada', fecha });
});

module.exports = router;
