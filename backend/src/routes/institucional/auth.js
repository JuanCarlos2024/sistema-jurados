// ─────────────────────────────────────────────────────────────────────────
// Autenticación de cuentas institucionales (Delegado de Asociación, Fase 1).
// Mismo patrón criptográfico que routes/auth.js (bcrypt + JWT vía
// middleware/auth.js) pero en un archivo y tabla totalmente separados —
// routes/auth.js NO se modifica, el login de administrador/usuario_pagado
// queda intacto.
//
// Nota de alcance de Fase 1: esta ruta queda implementada y probada, pero
// no hay ninguna cuenta real en producción (tabla aún no migrada) ni se
// hace commit/push/deploy de este cambio — "preparada, no habilitada".
// ─────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const supabase = require('../../config/supabase');
const { generarToken, soloCuentaInstitucional } = require('../../middleware/auth');
const auditoria = require('../../services/auditoria');

// ─────────────────────────────────────────────
// POST /api/institucional/auth/login
// ─────────────────────────────────────────────
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email y contraseña son requeridos' });
    }

    // select con join embebido vía el FK asociacion_id: la asociación SIEMPRE
    // se resuelve server-side desde la fila real de la cuenta, nunca desde
    // nada que mande el frontend (requisito 7/8 — no confiar en el cliente).
    const { data: cuenta, error } = await supabase
        .from('cuentas_institucionales')
        .select('*, asociaciones(id, nombre, activa)')
        .eq('email', email.trim().toLowerCase())
        .eq('activo', true)
        .single();

    // Mismo mensaje genérico para: email inexistente, cuenta inactiva
    // (excluida por el .eq('activo', true) de arriba, nunca llega acá) y
    // asociación deshabilitada — evita enumeración de cuentas (requisito 9).
    if (error || !cuenta || !cuenta.asociaciones || cuenta.asociaciones.activa === false) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const passwordOk = await bcrypt.compare(password, cuenta.password_hash);
    if (!passwordOk) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = generarToken({
        id: cuenta.id,
        tipo: 'cuenta_institucional',
        rol_institucional: cuenta.rol_institucional,
        asociacion_id: cuenta.asociaciones.id,
        asociacion_nombre: cuenta.asociaciones.nombre,
        primer_login: cuenta.primer_login
    });

    // Registro de último acceso — no interrumpe el login si falla.
    try {
        await supabase.from('cuentas_institucionales')
            .update({ ultimo_acceso_en: new Date().toISOString() })
            .eq('id', cuenta.id);
    } catch (e) {
        console.error('[INSTITUCIONAL] no se pudo actualizar ultimo_acceso_en:', e.message);
    }

    await auditoria.registrar({
        tabla: 'cuentas_institucionales',
        registro_id: cuenta.id,
        accion: 'login',
        actor_id: cuenta.id,
        actor_tipo: 'cuenta_institucional',
        descripcion: `Login institucional: ${cuenta.email}`,
        ip_address: req.ip
    });

    res.json({
        token,
        usuario: {
            id: cuenta.id,
            tipo: 'cuenta_institucional',
            rol_institucional: cuenta.rol_institucional,
            asociacion_id: cuenta.asociaciones.id,
            asociacion_nombre: cuenta.asociaciones.nombre,
            email: cuenta.email,
            primer_login: cuenta.primer_login
        }
    });
});

// ─────────────────────────────────────────────
// POST /api/institucional/auth/cambiar-password
// Requiere token institucional válido (soloCuentaInstitucional).
// ─────────────────────────────────────────────
router.post('/cambiar-password', soloCuentaInstitucional, async (req, res) => {
    const { password_actual, password_nueva } = req.body;

    if (!password_nueva || password_nueva.length < 8) {
        return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
    }

    const { data: cuenta } = await supabase
        .from('cuentas_institucionales')
        .select('password_hash, primer_login')
        .eq('id', req.usuario.id)
        .single();

    if (!cuenta) return res.status(404).json({ error: 'Cuenta no encontrada' });

    // Password actual no requerida solo en el cambio obligatorio del primer login
    // (mismo criterio que routes/auth.js para usuarios_pagados.primer_login).
    if (!cuenta.primer_login) {
        if (!password_actual) {
            return res.status(400).json({ error: 'Contraseña actual requerida' });
        }
        const ok = await bcrypt.compare(password_actual, cuenta.password_hash);
        if (!ok) return res.status(401).json({ error: 'Contraseña actual incorrecta' });
    }

    const nuevo_hash = await bcrypt.hash(password_nueva, 12);
    await supabase
        .from('cuentas_institucionales')
        .update({ password_hash: nuevo_hash, primer_login: false, updated_at: new Date().toISOString() })
        .eq('id', req.usuario.id);

    await auditoria.registrar({
        tabla: 'cuentas_institucionales',
        registro_id: req.usuario.id,
        accion: 'cambiar_clave',
        actor_id: req.usuario.id,
        actor_tipo: 'cuenta_institucional',
        descripcion: 'Cambio de contraseña institucional',
        ip_address: req.ip
    });

    res.json({ mensaje: 'Contraseña actualizada correctamente' });
});

module.exports = router;
