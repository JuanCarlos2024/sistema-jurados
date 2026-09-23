// ─────────────────────────────────────────────────────────────────────────
// Importación de Control de Gestión — Excel generado por GPT a partir del
// chat de WhatsApp de los jurados. Flujo: subir → previsualizar (sin
// escribir nada) → decidir acción por rodeo → confirmar (reparsea el mismo
// archivo desde cero, revalida todo, escribe de forma atómica por rodeo).
//
// Permisos: mismo criterio ya auditado para "Datos del monitor" — Monitor
// (rol_evaluacion === 'monitor') o Administrador pleno (rol_evaluacion ===
// null). soloRolEvaluacion('monitor') ya implementa exactamente esa
// allowlist (admin pleno siempre pasa; 'monitor' se agrega explícitamente).
// ─────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { soloRolEvaluacion } = require('../../middleware/auth');
const {
    generarPreview, confirmarImportacion, obtenerSituacionesDeRodeo
} = require('../../services/controlGestion');

router.use(soloRolEvaluacion('monitor'));

// Mismo límite y validación de extensión/mimetype que el importador de
// Rodeos (services/importacion.js vía routes/admin/importacion.js) — no se
// inventa un criterio de seguridad distinto para este archivo.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB máximo
    fileFilter: (req, file, cb) => {
        if (
            file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
            file.mimetype === 'application/vnd.ms-excel' ||
            file.originalname.match(/\.xlsx?$/i)
        ) {
            cb(null, true);
        } else {
            cb(new Error('Solo se permiten archivos Excel (.xlsx, .xls)'));
        }
    }
});

// POST /api/admin/control-gestion/preview — NO escribe nada en la base.
router.post('/preview', upload.single('archivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

    try {
        const { filas, resumen } = await generarPreview(req.file.buffer);
        res.json({ filas, resumen });
    } catch (err) {
        // Errores de estructura del Excel (hoja/encabezado faltante, etc.)
        // son error del usuario (400) — cualquier otro, 500 sin exponer
        // detalles técnicos innecesarios más allá del mensaje ya controlado.
        res.status(400).json({ error: err.message });
    }
});

// POST /api/admin/control-gestion/confirmar — reparsea el MISMO archivo
// desde cero; el body trae únicamente las decisiones (fila_index + acción),
// nunca los datos de la propia fila — el backend nunca confía en eso.
router.post('/confirmar', upload.single('archivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

    let decisiones;
    try {
        decisiones = JSON.parse(req.body.decisiones || '[]');
    } catch {
        return res.status(400).json({ error: 'El campo "decisiones" no es JSON válido.' });
    }
    if (!Array.isArray(decisiones)) {
        return res.status(400).json({ error: 'El campo "decisiones" debe ser un arreglo.' });
    }
    const accionesValidas = ['agregar', 'reemplazar', 'omitir'];
    const decisionesInvalidas = decisiones.filter(d =>
        typeof d?.fila_index !== 'number' || !accionesValidas.includes(d?.accion)
    );
    if (decisionesInvalidas.length > 0) {
        return res.status(400).json({ error: 'Cada decisión debe traer fila_index (número) y accion (agregar|reemplazar|omitir).' });
    }

    try {
        const resultado = await confirmarImportacion(req.file.buffer, decisiones, req.file.originalname, req.usuario.id);
        res.json(resultado);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// GET /api/admin/control-gestion/rodeo/:rodeoId/situaciones — solo lectura,
// usado por el botón "Ver detalle" en Rodeos.
router.get('/rodeo/:rodeoId/situaciones', async (req, res) => {
    try {
        const situaciones = await obtenerSituacionesDeRodeo(req.params.rodeoId);
        res.json({ situaciones });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Error handler de multer (mismo patrón que routes/admin/importacion.js).
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'El archivo es demasiado grande (máximo 10 MB)' });
        }
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
});

module.exports = router;
