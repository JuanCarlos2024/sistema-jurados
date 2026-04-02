const express = require('express');
const router = express.Router();
const multer = require('multer');
const { procesarImportacion } = require('../../services/importacion');

// Multer en memoria (no guarda en disco)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB máximo
    fileFilter: (req, file, cb) => {
        if (
            file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
            file.mimetype === 'application/vnd.ms-excel' ||
            file.originalname.match(/\.(xlsx|xls)$/)
        ) {
            cb(null, true);
        } else {
            cb(new Error('Solo se permiten archivos Excel (.xlsx, .xls)'));
        }
    }
});

// POST /api/admin/importacion/excel
router.post('/excel', upload.single('archivo'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No se recibió ningún archivo' });
    }

    try {
        const resultado = await procesarImportacion(
            req.file.buffer,
            req.file.originalname,
            req.usuario.id,
            req.ip
        );

        res.json({
            mensaje: 'Importación completada',
            ...resultado
        });
    } catch (err) {
        console.error('[IMPORTACION]', err);
        res.status(500).json({ error: 'Error durante la importación: ' + err.message });
    }
});

// GET /api/admin/importacion/historial
router.get('/historial', async (req, res) => {
    const supabase = require('../../config/supabase');
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { data, error, count } = await supabase
        .from('importaciones')
        .select(`
            id, nombre_archivo, total_filas, insertadas, pendientes,
            duplicadas, rechazadas, errores, created_at,
            administradores(nombre_completo)
        `, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + parseInt(limit) - 1);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ data, total: count });
});

// Error handler de multer
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
