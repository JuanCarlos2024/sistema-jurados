const express = require('express');
const router = express.Router();
const { soloUsuario, revalidarTipoPersonaUsuario } = require('../../middleware/auth');

// Aplicar middleware de usuario pagado a todas las rutas de este grupo
router.use(soloUsuario);
// La función vigente (Jurado / Delegado Rentado) se revalida contra la BD:
// un token emitido antes de un cambio de función no conserva los permisos
// de la función anterior (migración 100).
router.use(revalidarTipoPersonaUsuario);

router.use('/perfil', require('./perfil'));
router.use('/resumen', require('./resumen'));
router.use('/bonos', require('./bonos'));
router.use('/asignaciones', require('./asignaciones'));
router.use('/adjuntos', require('./adjuntos'));
router.use('/links', require('./links'));
router.use('/disponibilidad', require('./disponibilidad'));
router.use('/cartillas', require('./cartillas'));
router.use('/cartilla-delegado', require('./cartilla-delegado'));
router.use('/evaluaciones', require('./evaluaciones'));
router.use('/capacitaciones', require('./capacitaciones'));
router.use('/material-complementario', require('./material-complementario'));

module.exports = router;
