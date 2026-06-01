const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const supabase = require('../../config/supabase');

// ─── Constantes de dominio ───────────────────────────────────────────────────
const TIPOS_MATERIAL   = ['pdf','word','excel','imagen','youtube','link_externo','video_externo','sharepoint','notebooklm'];
const TIPOS_ARCHIVO    = ['pdf','word','excel','imagen']; // requieren upload
const AUDIENCIAS       = ['jurados','delegados','ambos'];
const ESTADOS          = ['borrador','publicado','archivado'];

const MIME_PERMITIDOS  = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/jpeg', 'image/png', 'image/webp', 'image/gif'
];

// Extensiones ejecutables o peligrosas — bloqueadas siempre
const EXT_BLOQUEADAS = /\.(exe|bat|cmd|sh|ps1|msi|vbs|js|jsx|ts|tsx|php|py|rb|dll|com|scr|cpl|jar|pif|wsf|hta|reg)$/i;

const upload = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: 20 * 1024 * 1024 }, // 20 MB
    fileFilter(req, file, cb) {
        if (EXT_BLOQUEADAS.test(file.originalname)) {
            return cb(new Error('Tipo de archivo no permitido'));
        }
        if (!MIME_PERMITIDOS.includes(file.mimetype)) {
            return cb(new Error('Formato no permitido: ' + file.mimetype));
        }
        cb(null, true);
    }
});

// Bucket de Supabase Storage (reutiliza el existente)
const BUCKET = 'rodeo-adjuntos';

// ─── Sanitización de iframes ──────────────────────────────────────────────────
// Dominios permitidos en atributo src de iframes
const DOMINIOS_EMBED_PERMITIDOS = [
    'sharepoint.com',
    'microsoftstream.com',
    'office.com',
    'microsoft.com',
    'onedrive.live.com',
    'youtube.com',
    'youtu.be',
    'notebooklm.google.com',
    'docs.google.com'
];

function _dominioPermitido(src) {
    try {
        const url  = new URL(src);
        const host = url.hostname.toLowerCase();
        return DOMINIOS_EMBED_PERMITIDOS.some(d => host === d || host.endsWith('.' + d));
    } catch {
        return false;
    }
}

/**
 * Valida y sanitiza un código <iframe>.
 * Retorna { html } si pasa, o { error } si falla.
 */
function sanitizarIframe(raw) {
    if (!raw || typeof raw !== 'string') return { error: 'Código embed vacío' };
    const trimmed = raw.trim();
    if (!trimmed)                            return { error: 'Código embed vacío' };

    // Solo se permiten iframes
    if (!/^<iframe[\s>]/i.test(trimmed))     return { error: 'Solo se permiten etiquetas <iframe> como código embed' };

    // Rechazar scripts y javascript:
    if (/<script/i.test(trimmed))            return { error: 'El código contiene etiquetas <script> no permitidas' };
    if (/javascript:/i.test(trimmed))        return { error: 'El código contiene "javascript:" no permitido' };

    // Rechazar manejadores de eventos on*
    if (/\bon\w+\s*=/i.test(trimmed))        return { error: 'El código contiene atributos de evento (on...) no permitidos' };

    // Extraer src
    const srcMatch = trimmed.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!srcMatch)                           return { error: 'El iframe no contiene atributo src válido' };

    const src = srcMatch[1];
    if (!/^https:\/\//i.test(src))           return { error: 'Solo se permiten fuentes con HTTPS en el iframe' };
    if (!_dominioPermitido(src))             return { error: 'Dominio no permitido en el iframe. Use SharePoint, Microsoft Stream, YouTube o Google NotebookLM' };

    // Limpiar eventuales on* que hayan pasado (doble seguridad)
    const cleaned = trimmed.replace(/\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '');
    return { html: cleaned };
}

// ─── GET / — listar materiales ───────────────────────────────────────────────
router.get('/', async (req, res) => {
    const { estado, audiencia } = req.query;

    let q = supabase
        .from('material_complementario')
        .select(`
            id, titulo, descripcion, categoria, tipo_material,
            nombre_archivo, url_externa, video_embed_html, audiencia, obligatorio,
            estado, orden, created_at, updated_at, creado_por,
            administradores(nombre_completo)
        `)
        .is('deleted_at', null)
        .order('orden', { ascending: true })
        .order('created_at', { ascending: false });

    if (estado)    q = q.eq('estado', estado);
    if (audiencia) q = q.eq('audiencia', audiencia);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// ─── GET /:id — obtener uno ──────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
    if (req.params.id === 'descargar') return res.status(400).json({ error: 'ID inválido' });

    const { data, error } = await supabase
        .from('material_complementario')
        .select('*')
        .eq('id', req.params.id)
        .is('deleted_at', null)
        .single();

    if (!data) return res.status(404).json({ error: 'Material no encontrado' });
    if (error)  return res.status(500).json({ error: error.message });
    res.json(data);
});

// ─── GET /:id/descargar — URL firmada ────────────────────────────────────────
router.get('/:id/descargar', async (req, res) => {
    const { data: mat } = await supabase
        .from('material_complementario')
        .select('url_archivo, nombre_archivo')
        .eq('id', req.params.id)
        .is('deleted_at', null)
        .single();

    if (!mat)             return res.status(404).json({ error: 'Material no encontrado' });
    if (!mat.url_archivo) return res.status(400).json({ error: 'Este material no tiene archivo adjunto' });

    const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(mat.url_archivo, 3600);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ url: data.signedUrl, nombre: mat.nombre_archivo });
});

// ─── GET /:id/estadisticas ────────────────────────────────────────────────────
router.get('/:id/estadisticas', async (req, res) => {
    const { data: mat } = await supabase
        .from('material_complementario')
        .select('id, titulo')
        .eq('id', req.params.id)
        .is('deleted_at', null)
        .single();

    if (!mat) return res.status(404).json({ error: 'Material no encontrado' });

    const [visRes, descRes, linkRes, ultRes] = await Promise.all([
        supabase.from('material_complementario_interacciones')
            .select('id', { count: 'exact', head: true })
            .eq('material_id', req.params.id)
            .eq('tipo_interaccion', 'visualizacion'),
        supabase.from('material_complementario_interacciones')
            .select('id', { count: 'exact', head: true })
            .eq('material_id', req.params.id)
            .eq('tipo_interaccion', 'descarga'),
        supabase.from('material_complementario_interacciones')
            .select('id', { count: 'exact', head: true })
            .eq('material_id', req.params.id)
            .eq('tipo_interaccion', 'apertura_link'),
        supabase.from('material_complementario_interacciones')
            .select('tipo_interaccion, rol_usuario, created_at, usuario_id, capacitacion_id')
            .eq('material_id', req.params.id)
            .order('created_at', { ascending: false })
            .limit(10)
    ]);

    res.json({
        material_id:           mat.id,
        titulo:                mat.titulo,
        total_visualizaciones: visRes.count  ?? 0,
        total_descargas:       descRes.count ?? 0,
        total_aperturas_link:  linkRes.count ?? 0,
        ultimas_interacciones: ultRes.data   || []
    });
});

// ─── POST / — crear material ─────────────────────────────────────────────────
router.post('/', upload.single('archivo'), async (req, res) => {
    const {
        titulo, descripcion, categoria, tipo_material,
        url_externa, video_embed_html,
        audiencia = 'jurados', obligatorio, estado = 'borrador', orden = 0
    } = req.body;

    if (!titulo?.trim())                          return res.status(400).json({ error: 'El título es obligatorio' });
    if (!TIPOS_MATERIAL.includes(tipo_material))  return res.status(400).json({ error: 'Tipo de material inválido' });
    if (!AUDIENCIAS.includes(audiencia))          return res.status(400).json({ error: 'Audiencia inválida' });
    if (!ESTADOS.includes(estado))                return res.status(400).json({ error: 'Estado inválido' });

    const esTipoUrl = !TIPOS_ARCHIVO.includes(tipo_material);

    // Validar fuente de contenido según tipo
    if (tipo_material === 'sharepoint') {
        if (!url_externa?.trim() && !video_embed_html?.trim()) {
            return res.status(400).json({ error: 'Para SharePoint/Stream, ingresa la URL del video o el código embed (iframe)' });
        }
    } else if (esTipoUrl && !url_externa?.trim()) {
        return res.status(400).json({ error: 'Se requiere URL para este tipo de material' });
    }

    // Sanitizar iframe si se proporcionó
    let embedHtmlGuardar = null;
    if (video_embed_html?.trim()) {
        const sanitResult = sanitizarIframe(video_embed_html.trim());
        if (sanitResult.error) return res.status(400).json({ error: sanitResult.error });
        embedHtmlGuardar = sanitResult.html;
    }

    let storagePath   = null;
    let nombreArchivo = null;
    let mimeType      = null;
    let tamanoArchivo = null;

    if (req.file) {
        const safeName  = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        storagePath     = `materiales/${Date.now()}_${safeName}`;

        const { error: storageErr } = await supabase.storage
            .from(BUCKET)
            .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

        if (storageErr) return res.status(500).json({ error: 'Error al subir archivo: ' + storageErr.message });

        nombreArchivo = req.file.originalname;
        mimeType      = req.file.mimetype;
        tamanoArchivo = req.file.size;
    }

    const { data, error } = await supabase
        .from('material_complementario')
        .insert({
            titulo:           titulo.trim(),
            descripcion:      descripcion?.trim()    || null,
            categoria:        categoria?.trim()       || null,
            tipo_material,
            url_archivo:      storagePath,
            nombre_archivo:   nombreArchivo,
            mime_type:        mimeType,
            tamano_archivo:   tamanoArchivo,
            url_externa:      url_externa?.trim()     || null,
            video_embed_html: embedHtmlGuardar,
            audiencia,
            obligatorio:      obligatorio === true || obligatorio === 'true',
            estado,
            orden:            parseInt(orden)          || 0,
            creado_por:       req.usuario.id
        })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});

// ─── PUT /:id — actualizar material ─────────────────────────────────────────
router.put('/:id', upload.single('archivo'), async (req, res) => {
    const { data: mat } = await supabase
        .from('material_complementario')
        .select('id, url_archivo, tipo_material')
        .eq('id', req.params.id)
        .is('deleted_at', null)
        .single();

    if (!mat) return res.status(404).json({ error: 'Material no encontrado' });

    const {
        titulo, descripcion, categoria, tipo_material,
        url_externa, video_embed_html, audiencia, obligatorio, estado, orden
    } = req.body;

    const updates = { updated_at: new Date().toISOString() };

    if (titulo !== undefined) {
        if (!titulo.trim()) return res.status(400).json({ error: 'El título no puede estar vacío' });
        updates.titulo = titulo.trim();
    }
    if (descripcion !== undefined) updates.descripcion = descripcion.trim() || null;
    if (categoria   !== undefined) updates.categoria   = categoria.trim()   || null;
    if (tipo_material !== undefined) {
        if (!TIPOS_MATERIAL.includes(tipo_material)) return res.status(400).json({ error: 'Tipo de material inválido' });
        updates.tipo_material = tipo_material;
    }
    if (url_externa !== undefined) updates.url_externa = url_externa.trim() || null;

    // Procesar video_embed_html
    if (video_embed_html !== undefined) {
        if (video_embed_html?.trim()) {
            const sanitResult = sanitizarIframe(video_embed_html.trim());
            if (sanitResult.error) return res.status(400).json({ error: sanitResult.error });
            updates.video_embed_html = sanitResult.html;
        } else {
            updates.video_embed_html = null;
        }
    }

    if (audiencia !== undefined) {
        if (!AUDIENCIAS.includes(audiencia)) return res.status(400).json({ error: 'Audiencia inválida' });
        updates.audiencia = audiencia;
    }
    if (obligatorio !== undefined) updates.obligatorio = obligatorio === true || obligatorio === 'true';
    if (estado      !== undefined) {
        if (!ESTADOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
        updates.estado = estado;
    }
    if (orden !== undefined) updates.orden = parseInt(orden) || 0;

    if (req.file) {
        // Eliminar archivo anterior si existe
        if (mat.url_archivo) {
            await supabase.storage.from(BUCKET).remove([mat.url_archivo]);
        }
        const safeName    = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        const storagePath = `materiales/${Date.now()}_${safeName}`;

        const { error: storageErr } = await supabase.storage
            .from(BUCKET)
            .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

        if (storageErr) return res.status(500).json({ error: 'Error al subir archivo: ' + storageErr.message });

        updates.url_archivo    = storagePath;
        updates.nombre_archivo = req.file.originalname;
        updates.mime_type      = req.file.mimetype;
        updates.tamano_archivo = req.file.size;
    }

    const { data, error } = await supabase
        .from('material_complementario')
        .update(updates)
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ─── PATCH /:id/estado — publicar / despublicar / archivar ──────────────────
router.patch('/:id/estado', async (req, res) => {
    const { estado } = req.body;
    if (!ESTADOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

    const { data, error } = await supabase
        .from('material_complementario')
        .update({ estado, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .is('deleted_at', null)
        .select('id, titulo, estado')
        .single();

    if (!data) return res.status(404).json({ error: 'Material no encontrado' });
    if (error)  return res.status(500).json({ error: error.message });
    res.json(data);
});

// ─── DELETE /:id — borrado lógico ────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
    const { data: mat } = await supabase
        .from('material_complementario')
        .select('id')
        .eq('id', req.params.id)
        .is('deleted_at', null)
        .single();

    if (!mat) return res.status(404).json({ error: 'Material no encontrado' });

    const now = new Date().toISOString();
    const { error } = await supabase
        .from('material_complementario')
        .update({ deleted_at: now, updated_at: now })
        .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ mensaje: 'Material eliminado' });
});

module.exports = router;
