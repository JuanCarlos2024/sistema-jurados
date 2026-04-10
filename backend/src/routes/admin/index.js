const express = require('express');
const router = express.Router();
const { soloAdmin } = require('../../middleware/auth');

// Aplicar middleware de admin a todas las rutas de este grupo
router.use(soloAdmin);

router.use('/usuarios', require('./usuarios'));
router.use('/rodeos', require('./rodeos'));
router.use('/asignaciones', require('./asignaciones'));
router.use('/bonos', require('./bonos'));
router.use('/configuracion', require('./configuracion'));
router.use('/importacion', require('./importacion'));
router.use('/exportacion', require('./exportacion'));
router.use('/reportes', require('./reportes'));
router.use('/dashboard', require('./dashboard'));
router.use('/adjuntos', require('./adjuntos'));
router.use('/disponibilidad', require('./disponibilidad'));

module.exports = router;
