const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');
const { procesarRutInput } = require('../../services/rut');

// GET /api/usuario/perfil
router.get('/', async (req, res) => {
    const { data, error } = await supabase
        .from('usuarios_pagados')
        .select('id, codigo_interno, tipo_persona, nombre_completo, rut, categoria, asociacion, direccion, comuna, ciudad, telefono, email, perfil_completo, primer_login, activo, created_at')
        .eq('id', req.usuario.id)
        .single();

    if (error) return res.status(404).json({ error: 'Perfil no encontrado' });
    res.json(data);
});

// PATCH /api/usuario/perfil — completar o actualizar perfil
router.patch('/', async (req, res) => {
    const { nombre_completo, rut, asociacion, direccion, comuna, ciudad, telefono, email, nueva_password } = req.body;

    const { data: actual } = await supabase
        .from('usuarios_pagados')
        .select('*')
        .eq('id', req.usuario.id)
        .single();

    if (!actual) return res.status(404).json({ error: 'Usuario no encontrado' });

    const cambios = { updated_at: new Date().toISOString() };

    if (nombre_completo) cambios.nombre_completo = nombre_completo.trim();
    if (telefono) cambios.telefono = telefono.trim();
    if (asociacion !== undefined) cambios.asociacion = asociacion.trim();
    if (direccion !== undefined) cambios.direccion = direccion;
    if (comuna !== undefined) cambios.comuna = comuna;
    if (ciudad !== undefined) cambios.ciudad = ciudad;

    // Email
    if (email) {
        // Verificar que no esté usado
        const { data: emailExiste } = await supabase
            .from('usuarios_pagados')
            .select('id')
            .eq('email', email.trim().toLowerCase())
            .neq('id', req.usuario.id)
            .limit(1);

        if (emailExiste && emailExiste.length > 0) {
            return res.status(400).json({ error: 'Este email ya está registrado por otro usuario' });
        }
        cambios.email = email.trim().toLowerCase();
    }

    // RUT — solo si es primer login o no tiene RUT aún
    if (rut && (!actual.rut || actual.primer_login)) {
        const rutResult = procesarRutInput(rut);
        if (!rutResult.valido) {
            return res.status(400).json({ error: 'RUT inválido: ' + rutResult.error });
        }

        // Verificar unicidad del RUT
        const { data: rutExiste } = await supabase
            .from('usuarios_pagados')
            .select('id')
            .eq('rut', rutResult.rut)
            .neq('id', req.usuario.id)
            .limit(1);

        if (rutExiste && rutExiste.length > 0) {
            return res.status(400).json({ error: 'Este RUT ya está registrado en el sistema' });
        }

        cambios.rut = rutResult.rut;
    }

    // Nueva contraseña — obligatoria en primer login
    if (nueva_password) {
        if (nueva_password.length < 8) {
            return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
        }
        const bcrypt = require('bcryptjs');
        cambios.password_hash = await bcrypt.hash(nueva_password, 12);
    } else if (actual.primer_login) {
        return res.status(400).json({ error: 'Debe establecer una nueva contraseña en el primer ingreso' });
    }

    // Verificar si el perfil quedará completo
    const rutFinal = cambios.rut || actual.rut;
    const nombreFinal = cambios.nombre_completo || actual.nombre_completo;
    const emailFinal = cambios.email || actual.email;

    if (rutFinal && nombreFinal && emailFinal) {
        cambios.perfil_completo = true;
    }

    if (actual.primer_login && cambios.password_hash) {
        cambios.primer_login = false;
    }

    const { data, error } = await supabase
        .from('usuarios_pagados')
        .update(cambios)
        .eq('id', req.usuario.id)
        .select('id, codigo_interno, tipo_persona, nombre_completo, rut, categoria, asociacion, direccion, comuna, ciudad, telefono, email, perfil_completo, primer_login')
        .single();

    if (error) return res.status(500).json({ error: error.message });

    if (actual.primer_login) {
        await auditoria.registrar({
            tabla: 'usuarios_pagados',
            registro_id: req.usuario.id,
            accion: 'primer_login',
            datos_nuevos: { rut: cambios.rut, perfil_completo: cambios.perfil_completo },
            actor_id: req.usuario.id,
            actor_tipo: 'usuario_pagado',
            descripcion: 'Perfil completado en primer ingreso',
            ip_address: req.ip
        });
    } else {
        await auditoria.registrar({
            tabla: 'usuarios_pagados',
            registro_id: req.usuario.id,
            accion: 'editar',
            datos_nuevos: cambios,
            actor_id: req.usuario.id,
            actor_tipo: 'usuario_pagado',
            descripcion: 'Usuario actualizó su perfil',
            ip_address: req.ip
        });
    }

    res.json(data);
});

module.exports = router;
