const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const supabase = require('../config/supabase');
const { generarToken } = require('../middleware/auth');
const { procesarRutInput } = require('../services/rut');
const auditoria = require('../services/auditoria');

// ─────────────────────────────────────────────
// POST /api/auth/admin/login
// ─────────────────────────────────────────────
router.post('/admin/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email y contraseña son requeridos' });
    }

    const { data: admin, error } = await supabase
        .from('administradores')
        .select('*')
        .eq('email', email.trim().toLowerCase())
        .eq('activo', true)
        .single();

    if (error || !admin) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const passwordOk = await bcrypt.compare(password, admin.password_hash);
    if (!passwordOk) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = generarToken({
        id: admin.id,
        tipo: 'administrador',
        nombre: admin.nombre_completo,
        email: admin.email,
        rol_evaluacion: admin.rol_evaluacion ?? null
    });

    await auditoria.registrar({
        tabla: 'administradores',
        registro_id: admin.id,
        accion: 'login',
        actor_id: admin.id,
        actor_tipo: 'administrador',
        descripcion: `Login de administrador: ${admin.email}`,
        ip_address: req.ip
    });

    res.json({
        token,
        usuario: {
            id: admin.id,
            tipo: 'administrador',
            nombre: admin.nombre_completo,
            email: admin.email,
            rol_evaluacion: admin.rol_evaluacion ?? null
        }
    });
});

// ─────────────────────────────────────────────
// POST /api/auth/usuario/login
// ─────────────────────────────────────────────
router.post('/usuario/login', async (req, res) => {
    const { identificador, password } = req.body;

    if (!identificador || !password) {
        return res.status(400).json({ error: 'Identificador y contraseña son requeridos' });
    }

    const id = identificador.trim();
    let usuario = null;
    let query;

    // Intentar por código interno (primer login: USR-0001)
    if (/^USR-\d{4,}$/i.test(id)) {
        query = supabase
            .from('usuarios_pagados')
            .select('*')
            .eq('activo', true)
            .ilike('codigo_interno', id);
    } else {
        // Intentar por RUT (login posterior)
        const resultado = procesarRutInput(id);
        if (!resultado.valido) {
            return res.status(400).json({ error: 'Identificador inválido. Use código USR-XXXX o su RUT (12345678-9)' });
        }
        query = supabase
            .from('usuarios_pagados')
            .select('*')
            .eq('activo', true)
            .eq('rut', resultado.rut);
    }

    const { data, error } = await query.limit(1);
    if (error || !data || data.length === 0) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    usuario = data[0];

    // Validar que si intenta con RUT pero aún está en primer login, informar
    if (!/^USR-\d{4,}$/i.test(id) && usuario.primer_login) {
        return res.status(401).json({
            error: 'Debe ingresar primero con su código USR-XXXX para completar su perfil'
        });
    }

    const passwordOk = await bcrypt.compare(password, usuario.password_hash);
    if (!passwordOk) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = generarToken({
        id: usuario.id,
        tipo: 'usuario_pagado',
        tipo_persona: usuario.tipo_persona,
        nombre: usuario.nombre_completo,
        primer_login: usuario.primer_login
    });

    await auditoria.registrar({
        tabla: 'usuarios_pagados',
        registro_id: usuario.id,
        accion: 'login',
        actor_id: usuario.id,
        actor_tipo: 'usuario_pagado',
        descripcion: `Login de usuario: ${usuario.codigo_interno}`,
        ip_address: req.ip
    });

    res.json({
        token,
        usuario: {
            id: usuario.id,
            tipo: 'usuario_pagado',
            tipo_persona: usuario.tipo_persona,
            nombre: usuario.nombre_completo,
            codigo_interno: usuario.codigo_interno,
            primer_login: usuario.primer_login,
            perfil_completo: usuario.perfil_completo
        }
    });
});

// ─────────────────────────────────────────────
// POST /api/auth/cambiar-password
// Requiere token válido (admin o usuario)
// ─────────────────────────────────────────────
router.post('/cambiar-password', async (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Token requerido' });

    let payload;
    try {
        payload = require('jsonwebtoken').verify(token, process.env.JWT_SECRET || 'fallback_secret_change_in_prod');
    } catch {
        return res.status(401).json({ error: 'Token inválido' });
    }

    const { password_actual, password_nueva } = req.body;

    if (!password_nueva || password_nueva.length < 8) {
        return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
    }

    const tabla = payload.tipo === 'administrador' ? 'administradores' : 'usuarios_pagados';
    const { data: registro } = await supabase
        .from(tabla)
        .select('password_hash')
        .eq('id', payload.id)
        .single();

    if (!registro) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Verificar password actual (no requerido en primer login de usuario)
    if (payload.tipo === 'administrador' || !payload.primer_login) {
        if (!password_actual) {
            return res.status(400).json({ error: 'Contraseña actual requerida' });
        }
        const ok = await bcrypt.compare(password_actual, registro.password_hash);
        if (!ok) return res.status(401).json({ error: 'Contraseña actual incorrecta' });
    }

    const nuevo_hash = await bcrypt.hash(password_nueva, 12);
    await supabase
        .from(tabla)
        .update({ password_hash: nuevo_hash, updated_at: new Date().toISOString() })
        .eq('id', payload.id);

    await auditoria.registrar({
        tabla,
        registro_id: payload.id,
        accion: 'cambiar_clave',
        actor_id: payload.id,
        actor_tipo: payload.tipo === 'administrador' ? 'administrador' : 'usuario_pagado',
        descripcion: 'Cambio de contraseña',
        ip_address: req.ip
    });

    res.json({ mensaje: 'Contraseña actualizada correctamente' });
});

module.exports = router;
