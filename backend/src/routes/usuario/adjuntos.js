const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const supabase = require('../../config/supabase');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
    fileFilter(req, file, cb) {
        const permitidos = [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'image/jpeg', 'image/png', 'image/webp'
        ];
        if (permitidos.includes(file.mimetype)) cb(null, true);
        else cb(new Error('Tipo de archivo no permitido. Use PDF, Word o imagen.'));
    }
});

// ─── GET /api/usuario/adjuntos?rodeo_id= ────────────────────
router.get('/', async (req, res) => {
    const { rodeo_id } = req.query;
    if (!rodeo_id) return res.status(400).json({ error: 'rodeo_id requerido' });

    // Verificar que el usuario tiene asignación activa en ese rodeo
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
        .from('rodeo_adjuntos')
        .select('*')
        .eq('rodeo_id', rodeo_id)
        .eq('usuario_pagado_id', req.usuario.id)
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// ─── POST /api/usuario/adjuntos ─────────────────────────────
router.post('/', upload.single('archivo'), async (req, res) => {
    const { rodeo_id, tipo_adjunto = 'otro' } = req.body;
    if (!rodeo_id) return res.status(400).json({ error: 'rodeo_id requerido' });
    if (!req.file)  return res.status(400).json({ error: 'archivo requerido' });

    // Verificar asignación activa y aceptada (no rechazada)
    const { data: asig } = await supabase
        .from('asignaciones')
        .select('id, estado_designacion')
        .eq('rodeo_id', rodeo_id)
        .eq('usuario_pagado_id', req.usuario.id)
        .eq('estado', 'activo')
        .limit(1);

    if (!asig || asig.length === 0) {
        return res.status(403).json({ error: 'Sin asignación activa en este rodeo' });
    }
    if (asig[0].estado_designacion === 'rechazado') {
        return res.status(403).json({ error: 'No puedes subir adjuntos a una designación rechazada' });
    }

    const ext = req.file.originalname.split('.').pop();
    const path = `${rodeo_id}/${req.usuario.id}/${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    const { error: storageErr } = await supabase.storage
        .from('rodeo-adjuntos')
        .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

    if (storageErr) return res.status(500).json({ error: 'Error al subir archivo: ' + storageErr.message });

    const { data, error } = await supabase
        .from('rodeo_adjuntos')
        .insert({
            rodeo_id,
            asignacion_id:    asig[0].id,
            usuario_pagado_id: req.usuario.id,
            subido_por_admin: false,
            tipo_adjunto,
            nombre_archivo:   req.file.originalname,
            storage_path:     path,
            mime_type:        req.file.mimetype,
            tamano_bytes:     req.file.size,
            created_by:       req.usuario.id
        })
        .select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ mensaje: 'Archivo subido correctamente', adjunto: data });
});

// ─── GET /api/usuario/adjuntos/:id/url ──────────────────────
router.get('/:id/url', async (req, res) => {
    const { data: adj } = await supabase
        .from('rodeo_adjuntos')
        .select('storage_path, nombre_archivo, usuario_pagado_id')
        .eq('id', req.params.id)
        .single();

    if (!adj) return res.status(404).json({ error: 'Adjunto no encontrado' });
    if (adj.usuario_pagado_id !== req.usuario.id) {
        return res.status(403).json({ error: 'Sin permiso' });
    }

    const { data, error } = await supabase.storage
        .from('rodeo-adjuntos')
        .createSignedUrl(adj.storage_path, 3600);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ url: data.signedUrl, nombre: adj.nombre_archivo });
});

// ─── DELETE /api/usuario/adjuntos/:id ───────────────────────
router.delete('/:id', async (req, res) => {
    const { data: adj } = await supabase
        .from('rodeo_adjuntos')
        .select('id, storage_path, usuario_pagado_id, subido_por_admin')
        .eq('id', req.params.id)
        .single();

    if (!adj) return res.status(404).json({ error: 'Adjunto no encontrado' });
    if (adj.usuario_pagado_id !== req.usuario.id || adj.subido_por_admin) {
        return res.status(403).json({ error: 'Solo puedes eliminar tus propios adjuntos' });
    }

    await supabase.storage.from('rodeo-adjuntos').remove([adj.storage_path]);
    await supabase.from('rodeo_adjuntos').delete().eq('id', req.params.id);

    res.json({ mensaje: 'Adjunto eliminado' });
});

module.exports = router;
