// ─────────────────────────────────────────────────────────────────────────
// Informe Ejecutivo de Gestión Deportiva — API backend (Fase 2: solo datos).
//
// GET /datos?desde=YYYY-MM-DD&hasta=YYYY-MM-DD → UNA respuesta agregada para
// la previsualización (sin endpoints por tarjeta).
//
// Permisos (propuesta; el informe incluye desempeño individual de jurados):
//   · Lectura (/datos, /catalogo): administrador pleno, 'director' (solo lectura,
//     ya impuesto globalmente en admin/index.js) y 'jefe_area'.
//   · Importaciones/históricos (preview y confirmar): SOLO administrador pleno.
// Todo /admin ya pasa por soloAdmin (admin/index.js).
// ─────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const multer = require('multer');
const supabase = require('../../config/supabase');
const { soloRolEvaluacion } = require('../../middleware/auth');
const { generarInforme } = require('../../services/informeGestion/informe');
const { previewAsociaciones, confirmarAsociaciones } = require('../../services/informeGestion/importAsociaciones');
const { previewHistoricoRodeos, contextoDeImportacion, confirmarHistoricoRodeos } = require('../../services/informeGestion/importHistoricoRodeos');
const { previewHistoricoColleras, confirmarHistoricoColleras } = require('../../services/informeGestion/importHistoricoColleras');
const { registrarSnapshot } = require('../../services/informeGestion/collerasSnapshot');
const { rangosRapidos } = require('../../services/informeGestion/rangosRapidos');
const { hoyChile } = require('../../services/informeGestion/fechasEquivalentes');

const lectura = soloRolEvaluacion('director', 'jefe_area');
const soloAdminPleno = soloRolEvaluacion(); // sin roles: únicamente rol_evaluacion === null

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            || file.mimetype === 'application/vnd.ms-excel'
            || file.originalname.match(/\.xlsx?$/i)) cb(null, true);
        else cb(new Error('Solo se permiten archivos Excel (.xlsx, .xls)'));
    }
});

function responderError(res, e) {
    return res.status(e.status || 500).json({ error: e.message });
}
function jsonBody(valor, porDefecto) {
    if (valor === undefined || valor === '') return porDefecto;
    try { return JSON.parse(valor); } catch { return undefined; }
}
async function leerTabla(tabla, columnas) {
    const { data, error } = await supabase.from(tabla).select(columnas).limit(5000);
    return error ? null : data;
}

// Accesos rápidos de fechas (último fin de semana = bloque de rodeo de services/feriados.js)
router.get('/rangos-rapidos', lectura, (req, res) => {
    try { res.json(rangosRapidos(hoyChile())); } catch (e) { responderError(res, e); }
});

router.get('/datos', lectura, async (req, res) => {
    try {
        res.json(await generarInforme({ desde: req.query.desde, hasta: req.query.hasta }));
    } catch (e) { responderError(res, e); }
});

// ── Snapshot de colleras completas (operación explícita, solo administrador pleno) ──
// No se guarda al refrescar el informe; el cron (si se decide) llamará a esta misma operación.
router.post('/colleras/snapshot', soloAdminPleno, async (req, res) => {
    try {
        res.json(await registrarSnapshot());
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Catálogo de asociaciones ─────────────────────────────────────────────
router.get('/catalogo/asociaciones', lectura, async (req, res) => {
    const catalogo = await leerTabla('asociaciones', 'id, nombre, nombre_normalizado, zona, activa, es_especial, incluir_en_alertas');
    const alias = await leerTabla('asociacion_alias', 'id, asociacion_id, alias, alias_normalizado');
    res.json({ disponible: catalogo !== null, catalogo: catalogo || [], alias: alias || [] });
});

router.post('/catalogo/asociaciones/preview', soloAdminPleno, upload.single('archivo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Debe adjuntar el archivo Excel (campo "archivo")' });
        const [catalogo, alias, rodeos] = await Promise.all([
            leerTabla('asociaciones', 'id, nombre, nombre_normalizado'),
            leerTabla('asociacion_alias', 'asociacion_id, alias, alias_normalizado'),
            leerTabla('rodeos', 'asociacion')
        ]);
        res.json(previewAsociaciones(req.file.buffer, {
            catalogo: catalogo || [], alias: alias || [],
            nombresEnUso: [...new Set((rodeos || []).map(r => r.asociacion).filter(Boolean))]
        }));
    } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/catalogo/asociaciones/confirmar', soloAdminPleno, upload.single('archivo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Debe adjuntar el archivo Excel (campo "archivo")' });
        const decisiones = jsonBody(req.body.decisiones, []);
        if (!Array.isArray(decisiones)) return res.status(400).json({ error: '"decisiones" debe ser un arreglo JSON' });
        const rodeos = await leerTabla('rodeos', 'asociacion');
        res.json(await confirmarAsociaciones(req.file.buffer, decisiones, {
            nombreArchivo: req.file.originalname, actorId: req.usuario.id,
            nombresEnUso: [...new Set((rodeos || []).map(x => x.asociacion).filter(Boolean))]
        }));
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Históricos ───────────────────────────────────────────────────────────
router.post('/historico/rodeos/preview', soloAdminPleno, upload.single('archivo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Debe adjuntar el archivo Excel (campo "archivo")' });
        const ctx = await contextoDeImportacion();
        res.json(previewHistoricoRodeos(req.file.buffer, { ...ctx, temporadaEsperada: req.body.temporada || null }));
    } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/historico/rodeos/confirmar', soloAdminPleno, upload.single('archivo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Debe adjuntar el archivo Excel (campo "archivo")' });
        res.json(await confirmarHistoricoRodeos(req.file.buffer, { temporadaEsperada: req.body.temporada || null }, { nombreArchivo: req.file.originalname, actorId: req.usuario.id }));
    } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/historico/colleras/preview', soloAdminPleno, upload.single('archivo'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Debe adjuntar el archivo Excel (campo "archivo")' });
        const confirmaciones = jsonBody(req.body.confirmaciones, []);
        if (!Array.isArray(confirmaciones)) return res.status(400).json({ error: '"confirmaciones" debe ser un arreglo JSON' });
        res.json(previewHistoricoColleras(req.file.buffer, { confirmaciones }));
    } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/historico/colleras/confirmar', soloAdminPleno, upload.single('archivo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Debe adjuntar el archivo Excel (campo "archivo")' });
        const confirmaciones = jsonBody(req.body.confirmaciones, []);
        if (!Array.isArray(confirmaciones)) return res.status(400).json({ error: '"confirmaciones" debe ser un arreglo JSON' });
        res.json(await confirmarHistoricoColleras(req.file.buffer, confirmaciones, { nombreArchivo: req.file.originalname, actorId: req.usuario.id }));
    } catch (e) { res.status(400).json({ error: e.message }); }
});

router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'El archivo es demasiado grande (máximo 10 MB)' });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
});

module.exports = router;
