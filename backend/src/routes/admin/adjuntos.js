const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const supabase = require('../../config/supabase');
const { soloNoAnalista, soloNoComisionTecnica } = require('../../middleware/auth');
const { cargarIndicadoresAdjuntosPorRodeo } = require('../../services/rodeosListado');

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
    return /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)/.test(url);
}

// ─── GET /api/admin/adjuntos/resumen?rodeo_ids= ─────────────
// Devuelve indicadores CJ/CD/VY por rodeo (para la tabla principal)
router.get('/resumen', async (req, res) => {
    const { rodeo_ids } = req.query;
    if (!rodeo_ids) return res.json({});

    const ids = rodeo_ids.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) return res.json({});

    // Lógica movida a services/rodeosListado.js — fuente ÚNICA, reutilizada
    // también por la exportación a Excel de Rodeos (columnas Cartilla
    // Jurado/Cartilla Delegado/Video). Mismo resultado exacto que antes.
    const result = await cargarIndicadoresAdjuntosPorRodeo(ids);
    res.json(result);
});

// ─── GET /api/admin/adjuntos?rodeo_id= ──────────────────────
// Devuelve adjuntos + links de un rodeo
router.get('/', async (req, res) => {
    const { rodeo_id } = req.query;
    if (!rodeo_id) return res.status(400).json({ error: 'rodeo_id requerido' });

    const [adjRes, linkRes] = await Promise.all([
        supabase.from('rodeo_adjuntos')
            // Cartilla única por rodeo, con versiones (migración 075):
            // cartilla_numero_version/cartilla_vigente para que el historial
            // los muestre. `created_by` no tiene FK a administradores (ver
            // migración 004) — se resuelve aparte abajo, nunca por embed.
            .select(`id, tipo_adjunto, nombre_archivo, mime_type, tamano_bytes, subido_por_admin, created_at, created_by,
                     cartilla_numero_version, cartilla_vigente, cartilla_clasificacion,
                     usuarios_pagados(nombre_completo, tipo_persona)`)
            .eq('rodeo_id', rodeo_id)
            .order('created_at', { ascending: false }),
        supabase.from('rodeo_links')
            .select(`id, url, descripcion, subido_por_admin, created_at,
                     usuarios_pagados(nombre_completo, tipo_persona)`)
            .eq('rodeo_id', rodeo_id)
            .order('created_at', { ascending: false })
    ]);

    // Historial — "Administrador que realizó la operación, si está
    // disponible": created_by es un UUID sin FK, así que se resuelve con una
    // consulta aparte (nunca se inventa un nombre si no se encuentra).
    const adjuntos = adjRes.data || [];
    const idsAdmin = [...new Set(adjuntos.map(a => a.created_by).filter(Boolean))];
    let nombresAdmin = {};
    if (idsAdmin.length > 0) {
        const { data: admins } = await supabase.from('administradores').select('id, nombre_completo').in('id', idsAdmin);
        (admins || []).forEach(a => { nombresAdmin[a.id] = a.nombre_completo; });
    }
    adjuntos.forEach(a => { a.admin_nombre = a.created_by ? (nombresAdmin[a.created_by] || null) : null; });

    res.json({
        adjuntos,
        links: linkRes.data || []
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

// ─── Lógica de alta de un adjunto — extraída a una función plana (sin
// Express ni multer) para que sea testable directamente: Jest no puede
// simular fácilmente el middleware de multer (necesita un stream real de
// Node), así que la ruta solo adapta req/res y delega aquí la lógica real.
// Cartilla única por rodeo, con versiones (migración 075): cuando
// tipo_adjunto='cartilla_delegado', es OBLIGATORIO indicar explícitamente
// si el archivo ES la cartilla oficial (nueva versión) o un documento
// complementario — nunca se asume lo uno ni lo otro por omisión (hallazgo
// real: CHACAICO/BÍO-BÍO tenía informes médico/paramédico/disciplinario
// subidos con este mismo tipo_adjunto, que NUNCA debieron contar como
// versiones de la cartilla). Para cualquier otro tipo_adjunto, el flujo
// sigue exactamente igual que antes (INSERT directo, sin cambios).
// @returns { status, body }
async function subirAdjuntoRodeo({ rodeo_id, tipo_adjunto, usuario_pagado_id, es_version_cartilla, confirma_conflicto_cartilla_digital, file, administradorId }) {
    let esVersionCartilla = null;
    if (tipo_adjunto === 'cartilla_delegado') {
        if (es_version_cartilla !== 'true' && es_version_cartilla !== 'false') {
            return {
                status: 400,
                body: {
                    error: 'Debe indicar si este archivo es la Cartilla de Delegado oficial (nueva versión) o un documento complementario.',
                    code: 'CLASIFICACION_CARTILLA_REQUERIDA'
                }
            };
        }
        esVersionCartilla = es_version_cartilla === 'true';
    }

    const path = `${rodeo_id}/admin/${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    const { error: storageErr } = await supabase.storage
        .from('rodeo-adjuntos')
        .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });

    if (storageErr) return { status: 500, body: { error: 'Error al subir: ' + storageErr.message } };

    let data, error;
    if (tipo_adjunto === 'cartilla_delegado') {
        // Numeración de versión + degradación de la vigente anterior, de
        // forma atómica (lock FOR UPDATE sobre el rodeo) — ver migración 075.
        const rpcRes = await supabase.rpc('registrar_version_cartilla_delegado_adjunta', {
            p_rodeo_id: rodeo_id,
            p_es_version_cartilla: esVersionCartilla,
            p_usuario_pagado_id: usuario_pagado_id || null,
            p_subido_por_admin: true,
            p_nombre_archivo: file.originalname,
            p_storage_path: path,
            p_mime_type: file.mimetype,
            p_tamano_bytes: file.size,
            p_created_by: administradorId,
            // multipart/form-data (multer): llega como string 'true'/'false',
            // mismo criterio que es_version_cartilla arriba.
            p_confirma_conflicto_cartilla_digital: confirma_conflicto_cartilla_digital === true || confirma_conflicto_cartilla_digital === 'true'
        });
        data = Array.isArray(rpcRes.data) ? rpcRes.data[0] : rpcRes.data;
        error = rpcRes.error;
    } else {
        const insRes = await supabase
            .from('rodeo_adjuntos')
            .insert({
                rodeo_id,
                usuario_pagado_id: usuario_pagado_id || null,
                subido_por_admin:  true,
                tipo_adjunto,
                nombre_archivo:    file.originalname,
                storage_path:      path,
                mime_type:         file.mimetype,
                tamano_bytes:      file.size,
                created_by:        administradorId
            })
            .select().single();
        data = insRes.data;
        error = insRes.error;
    }

    if (error) {
        // El archivo YA quedó en Storage pero el registro en Postgres
        // falló: nunca se declara vigente un documento cuya carga falló, y
        // nunca se deja un archivo huérfano sin rastro — se intenta
        // revertir la subida a Storage (compensación best-effort: Storage y
        // Postgres son sistemas separados, sin una transacción real en
        // común). Si la reversión también falla, se deja registrado en el
        // log del servidor para revisión manual — nunca se oculta.
        const { error: rollbackErr } = await supabase.storage.from('rodeo-adjuntos').remove([path]);
        if (rollbackErr) {
            console.error(`[ADJUNTOS] Fallo al revertir Storage tras error de BD. Archivo huérfano: ${path}. Error BD: ${error.message}. Error rollback: ${rollbackErr.message}`);
        }
        // Cartilla digital previa + adjunto oficial posterior (auditoría
        // 076/077): nunca se genera en silencio una segunda cartilla oficial
        // independiente — la RPC exige confirmación explícita cuando ya
        // existe una cartilla digital para este rodeo. Se informa con 409
        // (nunca 500, no es una falla real) para que el Administrador decida
        // conscientemente; si confirma, debe reintentar la subida con
        // confirma_conflicto_cartilla_digital=true (el archivo se revirtió
        // de Storage arriba, así que el reintento vuelve a adjuntarlo).
        if (error.message === 'CARTILLA_DIGITAL_EXISTENTE_REQUIERE_CONFIRMACION') {
            return {
                status: 409,
                body: {
                    error: 'Este rodeo ya tiene una cartilla digital registrada. Si continúa, este archivo quedará como la Cartilla de Delegado oficial de todas formas — confirme para continuar.',
                    code: 'CARTILLA_DIGITAL_EXISTENTE_REQUIERE_CONFIRMACION'
                }
            };
        }
        return { status: 500, body: { error: error.message } };
    }

    return { status: 201, body: { mensaje: 'Archivo subido', adjunto: data } };
}

// ─── POST /api/admin/adjuntos — subir archivo ────────────────
router.post('/', soloNoAnalista, soloNoComisionTecnica, upload.single('archivo'), async (req, res) => {
    const { rodeo_id, tipo_adjunto = 'otro', usuario_pagado_id, es_version_cartilla, confirma_conflicto_cartilla_digital } = req.body;
    if (!rodeo_id) return res.status(400).json({ error: 'rodeo_id requerido' });
    if (!req.file)  return res.status(400).json({ error: 'archivo requerido' });

    const { status, body } = await subirAdjuntoRodeo({
        rodeo_id, tipo_adjunto, usuario_pagado_id, es_version_cartilla, confirma_conflicto_cartilla_digital,
        file: req.file, administradorId: req.usuario.id
    });
    res.status(status).json(body);
});

// ─── Lógica de clasificación de un archivo HISTÓRICO 'pendiente' — extraída
// igual que subirAdjuntoRodeo (misma razón: testable sin pasar por Express).
// Corrección final (076): NUNCA automática ni masiva — resuelve un archivo
// a la vez, siempre por decisión explícita del Administrador. No se ejecuta
// sobre los 180 archivos reales sin autorización separada.
// @returns { status, body }
async function clasificarAdjuntoHistorico({ adjuntoId, esVersionCartilla, administradorId, confirmaConflictoCartillaDigital }) {
    const { data, error } = await supabase.rpc('clasificar_adjunto_cartilla_delegado_historico', {
        p_adjunto_id: adjuntoId,
        p_es_version_cartilla: esVersionCartilla,
        p_administrador_id: administradorId,
        p_confirma_conflicto_cartilla_digital: confirmaConflictoCartillaDigital === true
    });

    if (error) {
        if (error.message === 'ADJUNTO_NO_ENCONTRADO') {
            return { status: 404, body: { error: 'Adjunto no encontrado.', code: 'ADJUNTO_NO_ENCONTRADO' } };
        }
        if (error.message === 'ADJUNTO_YA_CLASIFICADO') {
            return { status: 409, body: { error: 'Este adjunto ya fue clasificado anteriormente.', code: 'ADJUNTO_YA_CLASIFICADO' } };
        }
        // Ver nota equivalente en subirAdjuntoRodeo: cartilla digital previa
        // + clasificación posterior como oficial -> requiere confirmación
        // explícita, nunca una segunda cartilla oficial silenciosa.
        if (error.message === 'CARTILLA_DIGITAL_EXISTENTE_REQUIERE_CONFIRMACION') {
            return {
                status: 409,
                body: {
                    error: 'Este rodeo ya tiene una cartilla digital registrada. Si continúa, este archivo quedará como la Cartilla de Delegado oficial de todas formas — confirme para continuar.',
                    code: 'CARTILLA_DIGITAL_EXISTENTE_REQUIERE_CONFIRMACION'
                }
            };
        }
        return { status: 500, body: { error: error.message } };
    }

    const adjunto = Array.isArray(data) ? data[0] : data;
    return { status: 200, body: { mensaje: 'Adjunto clasificado', adjunto } };
}

// ─── POST /api/admin/adjuntos/:id/clasificar-historico ───────
// Resuelve un archivo histórico 'pendiente' hacia version_cartilla o
// complementario (ver clasificarAdjuntoHistorico arriba).
router.post('/:id/clasificar-historico', soloNoAnalista, soloNoComisionTecnica, async (req, res) => {
    const { es_version_cartilla, confirma_conflicto_cartilla_digital } = req.body;
    if (typeof es_version_cartilla !== 'boolean') {
        return res.status(400).json({ error: 'es_version_cartilla (boolean) requerido', code: 'CLASIFICACION_CARTILLA_REQUERIDA' });
    }
    const { status, body } = await clasificarAdjuntoHistorico({
        adjuntoId: req.params.id, esVersionCartilla: es_version_cartilla, administradorId: req.usuario.id,
        confirmaConflictoCartillaDigital: confirma_conflicto_cartilla_digital === true
    });
    res.status(status).json(body);
});

// ─── POST /api/admin/adjuntos/link — agregar link ────────────
router.post('/link', soloNoAnalista, soloNoComisionTecnica, async (req, res) => {
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
// Auditoría/corrección (077): nunca permitir que una versión de la Cartilla
// de Delegado oficial (cartilla_clasificacion='version_cartilla') desaparezca
// por un DELETE genérico — eso dejaría cartilla_vigente=true sin ninguna fila
// real detrás (o, si era una versión histórica, perdería trazabilidad),
// reabriendo el riesgo de "cartilla oficial sin versión vigente identificable"
// que crear_o_adjuntar_cartilla_institucional ahora bloquea igual (ver 077).
// No existe hoy un flujo administrativo para "desclasificar" una versión ya
// confirmada — hasta que exista, se bloquea la eliminación por completo.
router.delete('/:id', soloNoAnalista, soloNoComisionTecnica, async (req, res) => {
    const { data: adj } = await supabase
        .from('rodeo_adjuntos')
        .select('id, storage_path, tipo_adjunto, cartilla_clasificacion')
        .eq('id', req.params.id)
        .single();

    if (!adj) return res.status(404).json({ error: 'Adjunto no encontrado' });

    if (adj.tipo_adjunto === 'cartilla_delegado' && adj.cartilla_clasificacion === 'version_cartilla') {
        return res.status(409).json({
            error: 'Este archivo es una versión confirmada de la Cartilla de Delegado oficial y no puede eliminarse desde aquí.',
            code: 'CARTILLA_OFICIAL_NO_SE_PUEDE_ELIMINAR'
        });
    }

    await supabase.storage.from('rodeo-adjuntos').remove([adj.storage_path]);
    await supabase.from('rodeo_adjuntos').delete().eq('id', req.params.id);
    res.json({ mensaje: 'Adjunto eliminado' });
});

// ─── DELETE /api/admin/adjuntos/link/:id ────────────────────
router.delete('/link/:id', soloNoAnalista, soloNoComisionTecnica, async (req, res) => {
    const { data: link } = await supabase
        .from('rodeo_links')
        .select('id')
        .eq('id', req.params.id)
        .single();

    if (!link) return res.status(404).json({ error: 'Link no encontrado' });
    await supabase.from('rodeo_links').delete().eq('id', req.params.id);
    res.json({ mensaje: 'Link eliminado' });
});

// Expuesta para pruebas directas (sin pasar por multer, ver su propio
// comentario) — mismo patrón ya usado en institucional/cartilla.js.
router.subirAdjuntoRodeo = subirAdjuntoRodeo;
router.clasificarAdjuntoHistorico = clasificarAdjuntoHistorico;

module.exports = router;
