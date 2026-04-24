const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_in_prod';

// Middleware: verificar cualquier token válido
function verificarToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>

    if (!token) {
        console.warn(`[AUTH] 401 sin token: ${req.method} ${req.path}`);
        return res.status(401).json({ error: 'Token requerido' });
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.usuario = payload;
        next();
    } catch (err) {
        console.warn(`[AUTH] 401 token inválido: ${req.method} ${req.path} — ${err.message}`);
        return res.status(401).json({ error: 'Token inválido o expirado' });
    }
}

// Middleware: solo administradores
function soloAdmin(req, res, next) {
    verificarToken(req, res, () => {
        if (req.usuario.tipo !== 'administrador') {
            console.warn(`[AUTH] 403 tipo="${req.usuario.tipo}" id="${req.usuario.id}": ${req.method} ${req.path}`);
            return res.status(403).json({ error: 'Acceso restringido a administradores' });
        }
        next();
    });
}

// Middleware: solo usuarios pagados
function soloUsuario(req, res, next) {
    verificarToken(req, res, () => {
        if (req.usuario.tipo !== 'usuario_pagado') {
            return res.status(403).json({ error: 'Acceso restringido a usuarios pagados' });
        }
        next();
    });
}

// Middleware: admin o el propio usuario
function adminOPropioUsuario(req, res, next) {
    verificarToken(req, res, () => {
        if (req.usuario.tipo === 'administrador') {
            return next();
        }
        if (req.usuario.tipo === 'usuario_pagado' && req.usuario.id === req.params.id) {
            return next();
        }
        return res.status(403).json({ error: 'Sin permisos para este recurso' });
    });
}

function generarToken(payload) {
    return jwt.sign(payload, JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || '8h'
    });
}

// Middleware factory: restringe por rol_evaluacion dentro del módulo de evaluación.
// null rol = admin pleno (acceso total). Llamar después de soloAdmin.
function soloRolEvaluacion(...roles) {
    return function (req, res, next) {
        const rol = req.usuario.rol_evaluacion || null;
        if (rol === null) return next();
        if (roles.includes(rol)) return next();
        return res.status(403).json({ error: 'Sin permisos para esta acción en el módulo de evaluación' });
    };
}

module.exports = { verificarToken, soloAdmin, soloUsuario, adminOPropioUsuario, generarToken, soloRolEvaluacion };
