const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');

function esYouTube(url) {
    return /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)/.test(url);
}

// ─── GET /api/usuario/links?rodeo_id= ───────────────────────
router.get('/', async (req, res) => {
    const { rodeo_id } = req.query;
    if (!rodeo_id) return res.status(400).json({ error: 'rodeo_id requerido' });

    const { data: asig } = await supabase
        .from('asignaciones')
        .select('id')
        .eq('rodeo_id', rodeo_id)
        .eq('usuario_pagado_id', req.usuario.id)
        .eq('estado', 'activo')
        .limit(1);

    if (!asig || asig.length === 0) {
        return res.status(403).json({ error: 'Sin asignación en este rodeo' });
    }

    const { data, error } = await supabase
        .from('rodeo_links')
        .select('*')
        .eq('rodeo_id', rodeo_id)
        .eq('usuario_pagado_id', req.usuario.id)
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// ─── POST /api/usuario/links ────────────────────────────────
router.post('/', async (req, res) => {
    const { rodeo_id, url, descripcion } = req.body;
    if (!rodeo_id) return res.status(400).json({ error: 'rodeo_id requerido' });
    if (!url)      return res.status(400).json({ error: 'url requerida' });
    if (!esYouTube(url)) return res.status(400).json({ error: 'Solo se permiten links de YouTube' });

    const { data: asig } = await supabase
        .from('asignaciones')
        .select('id, estado_designacion')
        .eq('rodeo_id', rodeo_id)
        .eq('usuario_pagado_id', req.usuario.id)
        .eq('estado', 'activo')
        .limit(1);

    if (!asig || asig.length === 0) return res.status(403).json({ error: 'Sin asignación activa en este rodeo' });
    if (asig[0].estado_designacion === 'rechazado') return res.status(403).json({ error: 'No puedes agregar links a una designación rechazada' });

    const { data, error } = await supabase
        .from('rodeo_links')
        .insert({
            rodeo_id,
            asignacion_id:    asig[0].id,
            usuario_pagado_id: req.usuario.id,
            subido_por_admin: false,
            url: url.trim(),
            descripcion: descripcion?.trim() || null,
            created_by: req.usuario.id
        })
        .select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ mensaje: 'Link agregado', link: data });
});

// ─── DELETE /api/usuario/links/:id ──────────────────────────
router.delete('/:id', async (req, res) => {
    const { data: link } = await supabase
        .from('rodeo_links')
        .select('id, usuario_pagado_id, subido_por_admin')
        .eq('id', req.params.id)
        .single();

    if (!link) return res.status(404).json({ error: 'Link no encontrado' });
    if (link.usuario_pagado_id !== req.usuario.id || link.subido_por_admin) {
        return res.status(403).json({ error: 'Solo puedes eliminar tus propios links' });
    }

    await supabase.from('rodeo_links').delete().eq('id', req.params.id);
    res.json({ mensaje: 'Link eliminado' });
});

module.exports = router;
