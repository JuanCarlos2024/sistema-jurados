// Importación de rodeos históricos.
//   POST /preview   → FASE 1: vista previa (solo lectura, no escribe).
//   POST /confirmar → FASE 2: revalida TODO desde el archivo y escribe con la RPC transaccional importar_rodeos_historicos.
// Permisos: solo administrador pleno (rol_evaluacion null). soloRolEvaluacion() sin roles rechaza a cualquier rol de evaluación
// (analista, jefe de área, monitor, comisión técnica, director y capacitador reciben 403).
const express = require('express');
const multer = require('multer');
const supabase = require('../../config/supabase');
const { soloRolEvaluacion } = require('../../middleware/auth');
const { generarPreview, temporadasHabilitadas, ErrorArchivo } = require('../../services/importacionHistorica');
const { confirmarImportacion, ErrorEscritura } = require('../../services/importacionHistoricaEscritura');

const router = express.Router();
router.use(soloRolEvaluacion());

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/\.(xlsx|xls)$/i.test(file.originalname || '')) cb(null, true);
        else cb(new ErrorArchivo('EXTENSION_INVALIDA', 'Solo se permiten archivos Excel (.xlsx, .xls)'));
    }
});

function subirArchivo(req, res, next) {
    upload.single('archivo')(req, res, (err) => {
        if (!err) return next();
        if (err instanceof ErrorArchivo) return res.status(400).json({ error: err.message, codigo: err.codigo });
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'El archivo supera el máximo de 10 MB', codigo: 'ARCHIVO_MUY_GRANDE' });
        return res.status(400).json({ error: err.message || 'Archivo inválido', codigo: 'ARCHIVO_INVALIDO' });
    });
}

function responderError(res, err) {
    if (err instanceof ErrorArchivo) return res.status(err.status).json({ error: err.message, codigo: err.codigo, info: err.detalle });
    if (err instanceof ErrorEscritura) return res.status(err.status).json({ error: err.message, codigo: err.codigo });
    console.error('[IMPORTACION-HISTORICA]', err);
    return res.status(500).json({ error: 'Error en la importación histórica: ' + err.message });
}

// GET /api/admin/importacion/historicos/temporadas — temporadas existentes habilitadas para el selector
router.get('/temporadas', async (req, res) => {
    try { res.json(await temporadasHabilitadas(supabase)); }
    catch (err) { console.error('[IMPORTACION-HISTORICA]', err); res.status(500).json({ error: 'No se pudieron cargar las temporadas' }); }
});

// POST /api/admin/importacion/historicos/preview — multipart: archivo + temporada_id. SOLO LECTURA.
router.post('/preview', subirArchivo, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo', codigo: 'SIN_ARCHIVO' });
    try {
        res.json(await generarPreview({ buffer: req.file.buffer, nombreArchivo: req.file.originalname, temporadaId: req.body && req.body.temporada_id }, supabase));
    } catch (err) { responderError(res, err); }
});

// POST /api/admin/importacion/historicos/confirmar — multipart: archivo + temporada_id + sha256 (el de la vista previa).
// El servidor NO usa nada de la vista previa del navegador: recalcula hash, parseo, validación, matching y plan.
router.post('/confirmar', subirArchivo, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo', codigo: 'SIN_ARCHIVO' });
    try {
        const resultado = await confirmarImportacion({
            buffer: req.file.buffer,
            nombreArchivo: req.file.originalname,
            temporadaId: req.body && req.body.temporada_id,
            sha256Esperado: req.body && req.body.sha256,
            adminId: req.usuario.id,
            ip: req.ip
        }, supabase);
        res.json(resultado);
    } catch (err) { responderError(res, err); }
});

module.exports = router;
