const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_in_prod';

// Middleware: verificar cualquier token válido
// Nota: `return next()` (no solo `next()`) para que, cuando `next` es una
// función async (ej. soloCuentaInstitucional, que revalida contra la BD),
// la promesa se propague hacia quien llamó a verificarToken — así se puede
// hacer `await soloCuentaInstitucional(...)` en tests y confiar en que ya
// terminó. No cambia nada para los callers síncronos existentes (soloAdmin,
// soloUsuario, adminOPropioUsuario): `return undefined` es idéntico a no
// retornar nada.
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
        return next();
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

// Middleware: solo cuentas institucionales (Delegado de Asociación, Fase 1).
// Mismo patrón que soloAdmin/soloUsuario: un tipo de token, sin mezclar con
// `usuario_pagado` ni `administrador` — un token institucional nunca pasa
// soloAdmin/soloUsuario, y viceversa (namespace de autorización separado).
//
// Fase 2 (Caso F de seguridad): a diferencia de soloAdmin/soloUsuario, acá SÍ
// se revalida contra la BD en cada request — no basta con que el JWT diga
// tipo="cuenta_institucional". Si la cuenta se desactiva (o su asociación se
// deshabilita) DESPUÉS de emitido el token, debe perder acceso de inmediato,
// no recién cuando el token expire por tiempo.
async function soloCuentaInstitucional(req, res, next) {
    return verificarToken(req, res, async () => {
        if (req.usuario.tipo !== 'cuenta_institucional') {
            return res.status(403).json({ error: 'Acceso restringido a cuentas institucionales' });
        }
        try {
            const { data: cuenta, error } = await supabase
                .from('cuentas_institucionales')
                .select('activo, asociaciones(activa)')
                .eq('id', req.usuario.id)
                .single();
            if (error || !cuenta || !cuenta.activo || !cuenta.asociaciones || cuenta.asociaciones.activa === false) {
                console.warn(`[AUTH] 401 cuenta institucional ya no válida id="${req.usuario.id}": ${req.method} ${req.path}`);
                return res.status(401).json({ error: 'Sesión inválida: la cuenta institucional ya no está activa' });
            }
        } catch (e) {
            console.error('[AUTH] error revalidando cuenta institucional:', e.message);
            return res.status(401).json({ error: 'No fue posible validar la sesión' });
        }
        return next();
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

// Middleware: bloquea al rol 'monitor' de operaciones que no le corresponden.
function soloNoMonitor(req, res, next) {
    if (req.usuario.rol_evaluacion === 'monitor') {
        return res.status(403).json({ error: 'El rol Monitor no tiene permiso para esta acción' });
    }
    next();
}

// Middleware: bloquea al rol 'director' de cualquier mutación.
function soloNoDirector(req, res, next) {
    if (req.usuario.rol_evaluacion === 'director') {
        return res.status(403).json({ error: 'El rol Director solo tiene acceso de lectura' });
    }
    next();
}

// Middleware: bloquea al rol 'analista' de acciones que no le corresponden.
function soloNoAnalista(req, res, next) {
    if (req.usuario.rol_evaluacion === 'analista') {
        return res.status(403).json({ error: 'El rol Analista no tiene permiso para esta acción' });
    }
    next();
}

// Middleware: bloquea al rol 'comision_tecnica' de acciones que no le corresponden.
function soloNoComisionTecnica(req, res, next) {
    if (req.usuario.rol_evaluacion === 'comision_tecnica') {
        return res.status(403).json({ error: 'El rol Comisión Técnica no tiene permiso para esta acción' });
    }
    next();
}

module.exports = { verificarToken, soloAdmin, soloUsuario, soloCuentaInstitucional, adminOPropioUsuario, generarToken, soloRolEvaluacion, soloNoMonitor, soloNoDirector, soloNoAnalista, soloNoComisionTecnica };
