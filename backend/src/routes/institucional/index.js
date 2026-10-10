// Namespace separado para cuentas institucionales (Delegado de Asociación).
// A propósito NO comparte router con /api/usuario ni /api/admin: así,
// mientras no se registre aquí un módulo financiero (bonos/resumen), una
// cuenta institucional no tiene ninguna forma de alcanzarlo — el aislamiento
// es arquitectónico (rutas inexistentes), no solo un middleware que podría
// olvidarse de aplicarse en algún endpoint nuevo.
const router = require('express').Router();

router.use('/auth', require('./auth'));
router.use('/delegados', require('./delegados'));
router.use('/rodeos', require('./rodeos'));
router.use('/perfil', require('./perfil'));
router.use('/cartilla', require('./cartilla'));

module.exports = router;
