const express = require('express');
const router = express.Router();
const { soloAdmin } = require('../../middleware/auth');

// Aplicar middleware de admin a todas las rutas de este grupo
router.use(soloAdmin);

// El rol Director es solo lectura: bloquear cualquier mutación globalmente
router.use((req, res, next) => {
    if (req.usuario.rol_evaluacion === 'director' && req.method !== 'GET') {
        return res.status(403).json({ error: 'El rol Director solo tiene acceso de lectura' });
    }
    next();
});

router.use('/usuarios', require('./usuarios'));
router.use('/rodeos', require('./rodeos'));
router.use('/asignaciones', require('./asignaciones'));
router.use('/bonos', require('./bonos'));
router.use('/configuracion', require('./configuracion'));
router.use('/importacion', require('./importacion'));
router.use('/exportacion', require('./exportacion'));
// Debe ir ANTES de /reportes para que no sea interceptado por el router general
router.use('/reportes/cartillas-jurado', require('./reporte-cartillas'));
router.use('/reportes', require('./reportes'));
router.use('/dashboard', require('./dashboard'));
router.use('/adjuntos', require('./adjuntos'));
router.use('/cartillas-jurado', require('./cartillas-jurado'));
router.use('/disponibilidad', require('./disponibilidad'));
router.use('/hojavida', require('./hojavida'));
router.use('/evaluaciones', require('./evaluaciones'));
router.use('/ciclos', require('./ciclos'));
router.use('/casos', require('./casos'));
router.use('/respuestas-jurado', require('./respuestas-jurado'));
router.use('/reporte-deportivo', require('./reporte-deportivo'));

module.exports = router;
