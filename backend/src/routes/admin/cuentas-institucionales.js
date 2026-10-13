// ─────────────────────────────────────────────────────────────────────────
// Gestión de acceso institucional (migración 078, pendiente de
// autorización): el administrador pleno puede crear asociaciones/cuentas,
// suspender/reactivar el acceso y restablecer contraseñas, sin depender de
// tocar nada manualmente en Supabase.
//
// Permisos: SOLO administrador pleno (rol_evaluacion === null) — mismo
// criterio allowlist que admin/delegados-asociacion.js.
//
// Nunca se expone password_hash en ninguna respuesta de este archivo: las 5
// RPC de la migración 078 usan un tipo de retorno propio (sin esa columna),
// así que es estructuralmente imposible filtrarlo desde aquí.
// ─────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const supabase = require('../../config/supabase');
const { soloRolEvaluacion } = require('../../middleware/auth');
const { normalizarAsociacion } = require('../../services/asociaciones');
const { construirIndiceCatalogo, resolverAsociacion } = require('../../services/informeGestion/asociaciones');

// Allowlist: solo administrador pleno (rol_evaluacion === null) — igual
// criterio que delegados-asociacion.js.
router.use(soloRolEvaluacion());

const COSTO_BCRYPT = 12; // mismo costo que el resto del sistema (ver auth.js, institucional/auth.js, admin/usuarios.js).
const LONGITUD_PASSWORD_GENERADA = 16;
const LONGITUD_MINIMA_PASSWORD_MANUAL = 12; // recomendación de seguridad pedida explícitamente para contraseñas administrativas.

// ─── Generación de contraseña temporal — crypto.randomInt, NUNCA Math.random ──
// Garantiza al menos un carácter de cada clase (minúscula/mayúscula/dígito/
// símbolo) eligiendo cada posición con un índice uniformemente aleatorio
// (sin sesgo de módulo: crypto.randomInt ya evita ese sesgo internamente).
const CLASES_PASSWORD = [
    'abcdefghijkmnpqrstuvwxyz',       // minúsculas (sin l/o, para evitar confusión visual al transcribir)
    'ABCDEFGHJKLMNPQRSTUVWXYZ',       // mayúsculas (sin I/O)
    '23456789',                       // dígitos (sin 0/1)
    '!@#$%&*-_+='                     // símbolos
];
function generarPasswordTemporal(longitud = LONGITUD_PASSWORD_GENERADA) {
    const todasLasClases = CLASES_PASSWORD.join('');
    const caracteres = [];
    // Un carácter garantizado de cada clase primero.
    for (const clase of CLASES_PASSWORD) {
        caracteres.push(clase[crypto.randomInt(0, clase.length)]);
    }
    // El resto, de todo el alfabeto combinado.
    for (let i = caracteres.length; i < longitud; i++) {
        caracteres.push(todasLasClases[crypto.randomInt(0, todasLasClases.length)]);
    }
    // Fisher-Yates con crypto.randomInt — nunca Math.random, ni siquiera para el orden.
    for (let i = caracteres.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [caracteres[i], caracteres[j]] = [caracteres[j], caracteres[i]];
    }
    return caracteres.join('');
}

// ─── Validación de fortaleza — contraseña MANUAL (ingresada por el admin) ──
// Nunca se reduce por debajo de esto; la generada automáticamente siempre
// la cumple por construcción (ver generarPasswordTemporal arriba).
function validarFortalezaPassword(password) {
    if (typeof password !== 'string' || password.length < LONGITUD_MINIMA_PASSWORD_MANUAL) {
        return { ok: false, motivo: `La contraseña debe tener al menos ${LONGITUD_MINIMA_PASSWORD_MANUAL} caracteres.` };
    }
    const clases = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(re => re.test(password)).length;
    if (clases < 3) {
        return { ok: false, motivo: 'La contraseña debe combinar al menos 3 de: minúsculas, mayúsculas, números y símbolos.' };
    }
    return { ok: true };
}

function emailValido(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '');
}

// Resuelve el modo de contraseña del body ({password_mode: 'generar'|'manual', password?})
// a un hash + el valor en texto plano SOLO para devolverlo UNA vez en la
// respuesta (nunca se persiste en ningún lado más que el hash).
// @returns {status, body} si hay un error de validación, o {hash, passwordTextoPlano}
async function resolverPassword({ password_mode, password }) {
    if (password_mode === 'generar') {
        const passwordTextoPlano = generarPasswordTemporal();
        return { hash: await bcrypt.hash(passwordTextoPlano, COSTO_BCRYPT), passwordTextoPlano };
    }
    if (password_mode === 'manual') {
        const validacion = validarFortalezaPassword(password);
        if (!validacion.ok) {
            return { error: { status: 400, body: { error: validacion.motivo, code: 'PASSWORD_DEBIL' } } };
        }
        return { hash: await bcrypt.hash(password, COSTO_BCRYPT), passwordTextoPlano: password };
    }
    return { error: { status: 400, body: { error: 'password_mode debe ser "generar" o "manual".' } } };
}

const ROLES_INSTITUCIONALES_VALIDOS = ['delegado_asociacion', 'comision_asociacion'];
function rolInstitucionalValido(body) {
    const rol = (body?.rol_institucional || 'delegado_asociacion').toString();
    return ROLES_INSTITUCIONALES_VALIDOS.includes(rol) ? rol : null;
}

// ─── POST /para-asociacion-existente — Opción A del pedido. Comisión de
// Asociación (079): mismo endpoint, ahora parametrizado por rol_institucional
// (DEFAULT delegado_asociacion, compatible con cualquier llamador existente
// que no lo envíe) — reutiliza la RPC ya endurecida, nunca duplica rutas. ──
router.post('/para-asociacion-existente', async (req, res) => {
    const asociacionId = req.body?.asociacion_id;
    const email = (req.body?.email || '').toString().trim().toLowerCase();
    const rolInstitucional = rolInstitucionalValido(req.body);

    if (!asociacionId) return res.status(400).json({ error: 'La asociación es obligatoria.' });
    if (!emailValido(email)) return res.status(400).json({ error: 'El correo institucional no es válido.' });
    if (!rolInstitucional) return res.status(400).json({ error: 'rol_institucional debe ser "delegado_asociacion" o "comision_asociacion".' });

    const resolucion = await resolverPassword(req.body || {});
    if (resolucion.error) return res.status(resolucion.error.status).json(resolucion.error.body);

    // crear_cuenta_institucional_con_auditoria (migración 078, parametrizada
    // en 079): valida que la asociación exista, esté activa y no sea
    // especial (caso de referencia: Federación del Rodeo Chileno), que no
    // tenga ya una cuenta del MISMO rol, inserta + audita en una sola
    // transacción. Nunca devuelve password_hash.
    const { data, error } = await supabase.rpc('crear_cuenta_institucional_con_auditoria', {
        p_asociacion_id: asociacionId,
        p_email: email,
        p_password_hash: resolucion.hash,
        p_administrador_id: req.usuario.id,
        p_rol_institucional: rolInstitucional
    });

    if (error) {
        if (error.message?.includes('ASOCIACION_NO_ENCONTRADA')) return res.status(404).json({ error: 'Asociación no encontrada.' });
        // Nunca solo responsabilidad del frontend (que ya filtra estas
        // opciones) — el backend rechaza igual ante una llamada directa.
        if (error.message?.includes('ASOCIACION_INACTIVA')) {
            return res.status(409).json({ error: 'Esta asociación está inactiva en el catálogo. No corresponde crear una cuenta institucional.', code: 'ASOCIACION_INACTIVA' });
        }
        if (error.message?.includes('ASOCIACION_ESPECIAL_SIN_CUENTA')) {
            return res.status(409).json({ error: 'Esta es una asociación especial del catálogo (no una asociación ordinaria). No corresponde crear una cuenta institucional por este módulo.', code: 'ASOCIACION_ESPECIAL' });
        }
        if (error.message?.includes('CUENTA_YA_EXISTE_PARA_ASOCIACION') || error.code === '23505') {
            return res.status(409).json({ error: `Esta asociación ya tiene una cuenta de ${rolInstitucional === 'comision_asociacion' ? 'Comisión de Asociación' : 'Delegado de Asociación'}.`, code: 'CUENTA_YA_EXISTE' });
        }
        if (error.message?.includes('CORREO_YA_REGISTRADO')) {
            return res.status(409).json({ error: 'Ya existe una cuenta institucional con ese correo.', code: 'CORREO_DUPLICADO' });
        }
        return res.status(500).json({ error: error.message });
    }

    res.status(201).json({
        cuenta: { id: data.id, email: data.email, asociacion_id: data.asociacion_id, rol_institucional: data.rol_institucional, estado: 'activa' },
        // Se muestra UNA sola vez — nunca queda accesible por un GET posterior.
        password_temporal: resolucion.passwordTextoPlano
    });
});

// ─── POST /nueva-asociacion — Opción B del pedido ─────────────────────────
router.post('/nueva-asociacion', async (req, res) => {
    const nombre = (req.body?.nombre || '').toString().trim();
    const zona = req.body?.zona ? req.body.zona.toString().trim() : null;
    const email = (req.body?.email || '').toString().trim().toLowerCase();
    const rolInstitucional = rolInstitucionalValido(req.body);

    if (!nombre) return res.status(400).json({ error: 'El nombre de la asociación es obligatorio.' });
    if (!emailValido(email)) return res.status(400).json({ error: 'El correo institucional no es válido.' });
    if (!rolInstitucional) return res.status(400).json({ error: 'rol_institucional debe ser "delegado_asociacion" o "comision_asociacion".' });

    const resolucion = await resolverPassword(req.body || {});
    if (resolucion.error) return res.status(resolucion.error.status).json(resolucion.error.body);

    // Dedup por nombre EQUIVALENTE (incluye alias) — misma fuente que el
    // resto del proyecto usa para resolver nombres de asociación contra el
    // catálogo, nunca ILIKE/difuso. El UNIQUE real de `asociaciones.
    // nombre_normalizado` es el backstop a nivel de base de datos (ver
    // migración 078), pero un alias equivalente con nombre_normalizado
    // distinto no lo detectaría esa UNIQUE por sí sola.
    const [{ data: catalogo, error: errCat }, { data: alias, error: errAlias }] = await Promise.all([
        supabase.from('asociaciones').select('id, nombre, nombre_normalizado'),
        supabase.from('asociacion_alias').select('asociacion_id, alias, alias_normalizado')
    ]);
    if (errCat) return res.status(500).json({ error: errCat.message });
    if (errAlias) return res.status(500).json({ error: errAlias.message });

    const indice = construirIndiceCatalogo(catalogo || [], alias || []);
    const existente = resolverAsociacion(nombre, indice);
    if (existente) {
        return res.status(409).json({
            error: `Ya existe una asociación equivalente en el catálogo: "${existente.nombre}".`,
            code: 'ASOCIACION_YA_EXISTE'
        });
    }

    const nombreNormalizado = normalizarAsociacion(nombre);

    // crear_asociacion_institucional_con_auditoria (migración 078): crea la
    // asociación Y su cuenta en una sola transacción — nunca una asociación
    // huérfana sin cuenta por una falla a mitad de camino. Nunca crea
    // delegados, rodeos ni asignaciones.
    const { data, error } = await supabase.rpc('crear_asociacion_institucional_con_auditoria', {
        p_nombre: nombre,
        p_nombre_normalizado: nombreNormalizado,
        p_zona: zona,
        p_email: email,
        p_password_hash: resolucion.hash,
        p_administrador_id: req.usuario.id,
        p_rol_institucional: rolInstitucional
    });

    if (error) {
        if (error.message?.includes('ASOCIACION_YA_EXISTE') || error.code === '23505') {
            return res.status(409).json({ error: 'Ya existe una asociación con ese nombre.', code: 'ASOCIACION_YA_EXISTE' });
        }
        if (error.message?.includes('CORREO_YA_REGISTRADO')) {
            return res.status(409).json({ error: 'Ya existe una cuenta institucional con ese correo.', code: 'CORREO_DUPLICADO' });
        }
        return res.status(500).json({ error: error.message });
    }

    res.status(201).json({
        cuenta: { id: data.id, email: data.email, asociacion_id: data.asociacion_id, rol_institucional: data.rol_institucional, estado: 'activa' },
        password_temporal: resolucion.passwordTextoPlano
    });
});

// ─── PATCH /:cuentaId/suspender ───────────────────────────────────────────
router.patch('/:cuentaId/suspender', async (req, res) => {
    const descripcion = (req.body?.descripcion || '').toString().trim() || 'Suspensión de cuenta institucional';

    // suspender_cuenta_institucional_con_auditoria (migración 078): toca
    // EXCLUSIVAMENTE cuentas_institucionales.activo — nunca asociaciones.
    // activa. El middleware soloCuentaInstitucional ya revalida activo en
    // cada request: el efecto es inmediato sobre cualquier sesión abierta.
    const { data, error } = await supabase.rpc('suspender_cuenta_institucional_con_auditoria', {
        p_cuenta_id: req.params.cuentaId,
        p_administrador_id: req.usuario.id,
        p_descripcion: descripcion
    });

    if (error) {
        if (error.message?.includes('CUENTA_NO_ENCONTRADA')) return res.status(404).json({ error: 'Cuenta institucional no encontrada.' });
        if (error.message?.includes('CUENTA_YA_SUSPENDIDA')) return res.status(409).json({ error: 'La cuenta ya está suspendida.' });
        return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true, cuenta: { id: data.id, email: data.email, estado: 'suspendida' } });
});

// ─── PATCH /:cuentaId/reactivar ───────────────────────────────────────────
router.patch('/:cuentaId/reactivar', async (req, res) => {
    // reactivar_cuenta_institucional_con_auditoria (migración 078): nunca
    // cambia password_hash ni password_version — la cuenta sigue con su
    // contraseña vigente, salvo un restablecimiento aparte.
    const { data, error } = await supabase.rpc('reactivar_cuenta_institucional_con_auditoria', {
        p_cuenta_id: req.params.cuentaId,
        p_administrador_id: req.usuario.id
    });

    if (error) {
        if (error.message?.includes('CUENTA_NO_ENCONTRADA')) return res.status(404).json({ error: 'Cuenta institucional no encontrada.' });
        if (error.message?.includes('CUENTA_YA_ACTIVA')) return res.status(409).json({ error: 'La cuenta ya está activa.' });
        return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true, cuenta: { id: data.id, email: data.email, estado: 'activa' } });
});

// ─── POST /:cuentaId/resetear-password ────────────────────────────────────
router.post('/:cuentaId/resetear-password', async (req, res) => {
    const resolucion = await resolverPassword(req.body || {});
    if (resolucion.error) return res.status(resolucion.error.status).json(resolucion.error.body);

    const descripcion = (req.body?.descripcion || '').toString().trim() || 'Restablecimiento de contraseña institucional';

    // resetear_password_cuenta_institucional_con_auditoria (migración 078):
    // fuerza primer_login=true e incrementa password_version — invalida de
    // inmediato cualquier sesión anterior (vía soloCuentaInstitucional).
    // Nunca registra el hash ni la contraseña en texto plano en auditoría.
    const { data, error } = await supabase.rpc('resetear_password_cuenta_institucional_con_auditoria', {
        p_cuenta_id: req.params.cuentaId,
        p_password_hash: resolucion.hash,
        p_administrador_id: req.usuario.id,
        p_descripcion: descripcion
    });

    if (error) {
        if (error.message?.includes('CUENTA_NO_ENCONTRADA')) return res.status(404).json({ error: 'Cuenta institucional no encontrada.' });
        return res.status(500).json({ error: error.message });
    }

    res.json({
        ok: true,
        cuenta: { id: data.id, email: data.email, primer_login: data.primer_login },
        // Se muestra UNA sola vez — nunca queda accesible por un GET posterior.
        password_temporal: resolucion.passwordTextoPlano
    });
});

module.exports = router;
