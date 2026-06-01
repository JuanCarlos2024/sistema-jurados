const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');

const BUCKET = 'rodeo-adjuntos';

// Determina la audiencia permitida según tipo_persona del usuario
function audienciaQuery(tipo) {
    if (tipo === 'jurado')           return ['jurados', 'ambos'];
    if (tipo === 'delegado_rentado') return ['delegados', 'ambos'];
    return null; // tipo desconocido — sin acceso
}

// ─── GET /mis-materiales ─────────────────────────────────────────────────────
router.get('/mis-materiales', async (req, res) => {
    const tipo     = req.usuario.tipo_persona;
    const allowed  = audienciaQuery(tipo);
    if (!allowed) return res.status(403).json({ error: 'Tipo de usuario no autorizado' });

    const { data, error } = await supabase
        .from('material_complementario')
        .select('id, titulo, descripcion, categoria, tipo_material, nombre_archivo, url_externa, video_embed_html, audiencia, obligatorio, orden, created_at')
        .eq('estado', 'publicado')
        .is('deleted_at', null)
        .in('audiencia', allowed)
        .order('orden', { ascending: true })
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// ─── GET /:id/abrir ──────────────────────────────────────────────────────────
router.get('/:id/abrir', async (req, res) => {
    const tipo    = req.usuario.tipo_persona;
    const allowed = audienciaQuery(tipo);
    if (!allowed) return res.status(403).json({ error: 'Tipo de usuario no autorizado' });

    const { data: mat, error: matErr } = await supabase
        .from('material_complementario')
        .select('id, tipo_material, url_archivo, nombre_archivo, url_externa, video_embed_html, audiencia, estado')
        .eq('id', req.params.id)
        .is('deleted_at', null)
        .single();

    if (matErr || !mat) return res.status(404).json({ error: 'Material no encontrado' });

    if (mat.estado !== 'publicado') {
        return res.status(403).json({ error: 'Este material no está disponible' });
    }

    if (!allowed.includes(mat.audiencia)) {
        return res.status(403).json({ error: 'No tienes acceso a este material' });
    }

    // Tipo externo (youtube, sharepoint, notebooklm, link_externo, video_externo) — devolver URL y embed
    if (mat.url_externa || mat.video_embed_html) {
        return res.json({
            tipo:             'externo',
            url:              mat.url_externa     || null,
            video_embed_html: mat.video_embed_html || null
        });
    }

    // Tipo archivo — generar URL firmada
    if (!mat.url_archivo) {
        return res.status(400).json({ error: 'Este material no tiene archivo adjunto' });
    }

    const { data: signed, error: signErr } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(mat.url_archivo, 3600);

    if (signErr) return res.status(500).json({ error: signErr.message });

    res.json({ tipo: 'archivo', url: signed.signedUrl, nombre: mat.nombre_archivo });
});

// ─── POST /:id/interaccion ────────────────────────────────────────────────────
router.post('/:id/interaccion', async (req, res) => {
    const tipo    = req.usuario.tipo_persona;
    const allowed = audienciaQuery(tipo);
    if (!allowed) return res.status(403).json({ error: 'Tipo de usuario no autorizado' });

    const { tipo_interaccion, capacitacion_id } = req.body;
    const TIPOS_VALIDOS = ['visualizacion', 'descarga', 'apertura_link'];
    if (!TIPOS_VALIDOS.includes(tipo_interaccion)) {
        return res.status(400).json({ error: 'tipo_interaccion inválido' });
    }

    const { data: mat } = await supabase
        .from('material_complementario')
        .select('id, estado, audiencia')
        .eq('id', req.params.id)
        .is('deleted_at', null)
        .single();

    if (!mat) return res.status(404).json({ error: 'Material no encontrado' });
    if (mat.estado !== 'publicado') return res.status(403).json({ error: 'Material no disponible' });
    if (!allowed.includes(mat.audiencia)) return res.status(403).json({ error: 'Sin acceso a este material' });

    const rol_usuario = tipo === 'jurado' ? 'jurado' : 'delegado';

    // Fire-and-forget — no esperamos para no bloquear la respuesta
    supabase.from('material_complementario_interacciones').insert({
        material_id:     req.params.id,
        usuario_id:      req.usuario.id,
        capacitacion_id: capacitacion_id || null,
        tipo_interaccion,
        rol_usuario
    }).then(() => {});

    res.json({ ok: true });
});

module.exports = router;
