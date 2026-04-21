const express = require('express');
const router = express.Router();
const { soloUsuario } = require('../../middleware/auth');

// Aplicar middleware de usuario pagado a todas las rutas de este grupo
router.use(soloUsuario);

router.use('/perfil', require('./perfil'));
router.use('/resumen', require('./resumen'));
router.use('/bonos', require('./bonos'));
router.use('/asignaciones', require('./asignaciones'));
router.use('/adjuntos', require('./adjuntos'));
router.use('/links', require('./links'));
router.use('/disponibilidad', require('./disponibilidad'));
router.use('/cartillas', require('./cartillas'));

module.exports = router;
