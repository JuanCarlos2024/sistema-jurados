const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const supabase = require('../../config/supabase');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter(req, file, cb) {
        const permitidos = [
            'application/pdf', 'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'image/jpeg', 'image/png', 'image/webp'
        ];
        if (permitidos.includes(file.mimetype)) cb(null, true);
        else cb(new Error('Tipo no permitido'));
    }
});

function esYouTube(url) {
    return /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)/.test(url);
}

// ─── GET /api/admin/adjuntos?rodeo_id= ──────────────────────
// Devuelve adjuntos + links de un rodeo
router.get('/', async (req, res) => {
    const { rodeo_id } = req.query;
    if (!rodeo_id) return res.status(400).json({ error: 'rodeo_id requerido' });

    const [adjRes, linkRes] = await Promise.all([
        supabase.from('rodeo_adjuntos')
            .select(`id, tipo_adjunto, nombre_archivo, mime_type, tamano_bytes, subido_por_admin, created_at,
                     usuarios_pagados(nombre_completo, tipo_persona)`)
            .eq('rodeo_id', rodeo_id)
            .order('created_at', { ascending: false }),
        supabase.from('rodeo_links')
            .select(`id, url, descripcion, subido_por_admin, created_at,
                     usuarios_pagados(nombre_completo, tipo_persona)`)
            .eq('rodeo_id', rodeo_id)
            .order('created_at', { ascending: false })
    ]);

    res.json({
        adjuntos: adjRes.data || [],
        links:    linkRes.data || []
    });
});

// ─── GET /api/admin/adjuntos/:id/url ────────────────────────
router.get('/:id/url', async (req, res) => {
    const { data: adj } = await supabase
        .from('rodeo_adjuntos')
        .select('storage_path, nombre_archivo')
        .eq('id', req.params.id)
        .single();

    if (!adj) return res.status(404).json({ error: 'Adjunto no encontrado' });

    const { data, error } = await supabase.storage
        .from('rodeo-adjuntos')
        .createSignedUrl(adj.storage_path, 3600);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ url: data.signedUrl, nombre: adj.nombre_archivo });
});

// ─── POST /api/admin/adjuntos — subir archivo ────────────────
router.post('/', upload.single('archivo'), async (req, res) => {
    const { rodeo_id, tipo_adjunto = 'otro', usuario_pagado_id } = req.body;
    if (!rodeo_id) return res.status(400).json({ error: 'rodeo_id requerido' });
    if (!req.file)  return res.status(400).json({ error: 'archivo requerido' });

    const path = `${rodeo_id}/admin/${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    const { error: storageErr } = await supabase.storage
        .from('rodeo-adjuntos')
        .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

    if (storageErr) return res.status(500).json({ error: 'Error al subir: ' + storageErr.message });

    const { data, error } = await supabase
        .from('rodeo_adjuntos')
        .insert({
            rodeo_id,
            usuario_pagado_id: usuario_pagado_id || null,
            subido_por_admin:  true,
            tipo_adjunto,
            nombre_archivo:    req.file.originalname,
            storage_path:      path,
            mime_type:         req.file.mimetype,
            tamano_bytes:      req.file.size,
            created_by:        req.usuario.id
        })
        .select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ mensaje: 'Archivo subido', adjunto: data });
});

// ─── POST /api/admin/adjuntos/link — agregar link ────────────
router.post('/link', async (req, res) => {
    const { rodeo_id, url, descripcion, usuario_pagado_id } = req.body;
    if (!rodeo_id) return res.status(400).json({ error: 'rodeo_id requerido' });
    if (!url)      return res.status(400).json({ error: 'url requerida' });
    if (!esYouTube(url)) return res.status(400).json({ error: 'Solo se permiten links de YouTube' });

    const { data, error } = await supabase
        .from('rodeo_links')
        .insert({
            rodeo_id,
            usuario_pagado_id: usuario_pagado_id || null,
            subido_por_admin:  true,
            url: url.trim(),
            descripcion: descripcion?.trim() || null,
            created_by: req.usuario.id
        })
        .select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ mensaje: 'Link agregado', link: data });
});

// ─── DELETE /api/admin/adjuntos/:id ─────────────────────────
router.delete('/:id', async (req, res) => {
    const { data: adj } = await supabase
        .from('rodeo_adjuntos')
        .select('id, storage_path')
        .eq('id', req.params.id)
        .single();

    if (!adj) return res.status(404).json({ error: 'Adjunto no encontrado' });

    await supabase.storage.from('rodeo-adjuntos').remove([adj.storage_path]);
    await supabase.from('rodeo_adjuntos').delete().eq('id', req.params.id);
    res.json({ mensaje: 'Adjunto eliminado' });
});

// ─── DELETE /api/admin/adjuntos/link/:id ────────────────────
router.delete('/link/:id', async (req, res) => {
    const { data: link } = await supabase
        .from('rodeo_links')
        .select('id')
        .eq('id', req.params.id)
        .single();

    if (!link) return res.status(404).json({ error: 'Link no encontrado' });
    await supabase.from('rodeo_links').delete().eq('id', req.params.id);
    res.json({ mensaje: 'Link eliminado' });
});

module.exports = router;
