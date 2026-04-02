const express = require('express');
const router = express.Router();
const { exportarResumenMensual, exportarBonos, exportarPendientes } = require('../../services/exportacion');

// GET /api/admin/exportacion/resumen-mensual?año=&mes=
router.get('/resumen-mensual', async (req, res) => {
    const { año, mes } = req.query;
    const ahora = new Date();
    const añoFinal = año || ahora.getFullYear().toString();
    const mesFinal = mes || String(ahora.getMonth() + 1).padStart(2, '0');

    try {
        await exportarResumenMensual(añoFinal, mesFinal, res);
    } catch (err) {
        res.status(500).json({ error: 'Error al generar exportación: ' + err.message });
    }
});

// GET /api/admin/exportacion/bonos?estado=
router.get('/bonos', async (req, res) => {
    const { estado } = req.query;
    try {
        await exportarBonos(estado || 'todos', res);
    } catch (err) {
        res.status(500).json({ error: 'Error al generar exportación: ' + err.message });
    }
});

// GET /api/admin/exportacion/pendientes
router.get('/pendientes', async (req, res) => {
    try {
        await exportarPendientes(res);
    } catch (err) {
        res.status(500).json({ error: 'Error al generar exportación: ' + err.message });
    }
});

module.exports = router;
