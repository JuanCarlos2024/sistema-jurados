const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');
const { procesarRutInput } = require('../../services/rut');

const PASS_INICIAL = 'jurados';

// Genera código interno incremental USR-0001
async function generarCodigo() {
    const { data } = await supabase
        .from('usuarios_pagados')
        .select('codigo_interno')
        .order('created_at', { ascending: false })
        .limit(1);

    if (!data || data.length === 0) return 'USR-0001';

    const ultimo = data[0].codigo_interno;
    const num = parseInt(ultimo.replace('USR-', ''), 10) + 1;
    return 'USR-' + String(num).padStart(4, '0');
}

// GET /api/admin/usuarios?tipo=&activo=&buscar=&page=&limit=
router.get('/', async (req, res) => {
    const { tipo, activo, buscar, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
        .from('usuarios_pagados')
        .select('id, codigo_interno, tipo_persona, nombre_completo, rut, categoria, email, telefono, ciudad, perfil_completo, activo, created_at, updated_at', { count: 'exact' })
        .order('nombre_completo', { ascending: true })
        .range(offset, offset + parseInt(limit) - 1);

    if (tipo) query = query.eq('tipo_persona', tipo);
    if (activo !== undefined) query = query.eq('activo', activo === 'true');
    if (buscar) query = query.or(`nombre_completo.ilike.%${buscar}%,codigo_interno.ilike.%${buscar}%,rut.ilike.%${buscar}%`);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ data, total: count, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/admin/usuarios/:id
router.get('/:id', async (req, res) => {
    const { data, error } = await supabase
        .from('usuarios_pagados')
        .select('id, codigo_interno, tipo_persona, nombre_completo, rut, categoria, direccion, comuna, ciudad, telefono, email, perfil_completo, primer_login, activo, created_at, updated_at')
        .eq('id', req.params.id)
        .single();

    if (error) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(data);
});

// POST /api/admin/usuarios
router.post('/', async (req, res) => {
    const { tipo_persona, nombre_completo, categoria } = req.body;

    if (!tipo_persona || !nombre_completo) {
        return res.status(400).json({ error: 'tipo_persona y nombre_completo son requeridos' });
    }
    if (!['jurado', 'delegado_rentado'].includes(tipo_persona)) {
        return res.status(400).json({ error: 'tipo_persona debe ser jurado o delegado_rentado' });
    }
    if (tipo_persona === 'jurado' && !['A', 'B', 'C'].includes(categoria)) {
        return res.status(400).json({ error: 'Los jurados requieren categoría A, B o C' });
    }

    const codigo_interno = await generarCodigo();
    const password_hash = await bcrypt.hash(PASS_INICIAL, 12);

    const { data, error } = await supabase
        .from('usuarios_pagados')
        .insert({
            codigo_interno,
            tipo_persona,
            nombre_completo: nombre_completo.trim(),
            categoria: tipo_persona === 'jurado' ? categoria : null,
            password_hash,
            created_by: req.usuario.id
        })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'usuarios_pagados',
        registro_id: data.id,
        accion: 'crear',
        datos_nuevos: { codigo_interno, tipo_persona, nombre_completo, categoria },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Usuario creado: ${nombre_completo} (${codigo_interno})`,
        ip_address: req.ip
    });

    res.status(201).json(data);
});

// PATCH /api/admin/usuarios/:id
router.patch('/:id', async (req, res) => {
    const { nombre_completo, email, telefono, direccion, comuna, ciudad } = req.body;

    const { data: anterior } = await supabase
        .from('usuarios_pagados')
        .select('*')
        .eq('id', req.params.id)
        .single();

    if (!anterior) return res.status(404).json({ error: 'Usuario no encontrado' });

    const cambios = {};
    if (nombre_completo) cambios.nombre_completo = nombre_completo.trim();
    if (email) cambios.email = email.trim().toLowerCase();
    if (telefono) cambios.telefono = telefono.trim();
    if (direccion !== undefined) cambios.direccion = direccion;
    if (comuna !== undefined) cambios.comuna = comuna;
    if (ciudad !== undefined) cambios.ciudad = ciudad;
    cambios.updated_at = new Date().toISOString();

    const { data, error } = await supabase
        .from('usuarios_pagados')
        .update(cambios)
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'usuarios_pagados',
        registro_id: req.params.id,
        accion: 'editar',
        datos_anteriores: anterior,
        datos_nuevos: cambios,
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Usuario editado: ${anterior.nombre_completo}`,
        ip_address: req.ip
    });

    res.json(data);
});

// PATCH /api/admin/usuarios/:id/categoria
router.patch('/:id/categoria', async (req, res) => {
    const { categoria } = req.body;

    if (!['A', 'B', 'C'].includes(categoria)) {
        return res.status(400).json({ error: 'Categoría debe ser A, B o C' });
    }

    const { data: anterior } = await supabase
        .from('usuarios_pagados')
        .select('nombre_completo, categoria, tipo_persona')
        .eq('id', req.params.id)
        .single();

    if (!anterior) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (anterior.tipo_persona !== 'jurado') {
        return res.status(400).json({ error: 'Solo los jurados tienen categoría' });
    }

    await supabase
        .from('usuarios_pagados')
        .update({ categoria, updated_at: new Date().toISOString() })
        .eq('id', req.params.id);

    await auditoria.registrar({
        tabla: 'usuarios_pagados',
        registro_id: req.params.id,
        accion: 'cambiar_categoria',
        datos_anteriores: { categoria: anterior.categoria },
        datos_nuevos: { categoria },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Categoría de ${anterior.nombre_completo} cambiada de ${anterior.categoria} a ${categoria}`,
        ip_address: req.ip
    });

    res.json({ mensaje: `Categoría actualizada a ${categoria}` });
});

// PATCH /api/admin/usuarios/:id/activar
router.patch('/:id/activar', async (req, res) => {
    const { activo } = req.body;

    const { data: u } = await supabase
        .from('usuarios_pagados')
        .select('nombre_completo, activo')
        .eq('id', req.params.id)
        .single();

    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });

    await supabase
        .from('usuarios_pagados')
        .update({ activo: !!activo, updated_at: new Date().toISOString() })
        .eq('id', req.params.id);

    await auditoria.registrar({
        tabla: 'usuarios_pagados',
        registro_id: req.params.id,
        accion: activo ? 'activar' : 'desactivar',
        datos_anteriores: { activo: u.activo },
        datos_nuevos: { activo: !!activo },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Usuario ${u.nombre_completo} ${activo ? 'activado' : 'desactivado'}`,
        ip_address: req.ip
    });

    res.json({ mensaje: `Usuario ${activo ? 'activado' : 'desactivado'}` });
});

// POST /api/admin/usuarios/:id/resetear-password
router.post('/:id/resetear-password', async (req, res) => {
    const { data: u } = await supabase
        .from('usuarios_pagados')
        .select('nombre_completo, codigo_interno')
        .eq('id', req.params.id)
        .single();

    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });

    const nuevo_hash = await bcrypt.hash(PASS_INICIAL, 12);

    await supabase
        .from('usuarios_pagados')
        .update({
            password_hash: nuevo_hash,
            primer_login: true,
            updated_at: new Date().toISOString()
        })
        .eq('id', req.params.id);

    await auditoria.registrar({
        tabla: 'usuarios_pagados',
        registro_id: req.params.id,
        accion: 'resetear_clave',
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Contraseña de ${u.nombre_completo} reseteada a contraseña inicial`,
        ip_address: req.ip
    });

    res.json({ mensaje: `Contraseña reseteada. El usuario deberá usar "${PASS_INICIAL}" en su próximo ingreso.` });
});

// DELETE /api/admin/usuarios/:id (soft delete = desactivar)
router.delete('/:id', async (req, res) => {
    const { data: u } = await supabase
        .from('usuarios_pagados')
        .select('nombre_completo')
        .eq('id', req.params.id)
        .single();

    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Verificar si tiene asignaciones activas
    const { count } = await supabase
        .from('asignaciones')
        .select('id', { count: 'exact', head: true })
        .eq('usuario_pagado_id', req.params.id)
        .eq('estado', 'activo');

    if (count > 0) {
        return res.status(400).json({
            error: `No se puede eliminar: el usuario tiene ${count} asignaciones activas. Desactívelo en su lugar.`
        });
    }

    await supabase
        .from('usuarios_pagados')
        .update({ activo: false, updated_at: new Date().toISOString() })
        .eq('id', req.params.id);

    await auditoria.registrar({
        tabla: 'usuarios_pagados',
        registro_id: req.params.id,
        accion: 'eliminar',
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Usuario ${u.nombre_completo} desactivado (eliminación lógica)`,
        ip_address: req.ip
    });

    res.json({ mensaje: 'Usuario desactivado correctamente' });
});

// GET /api/admin/usuarios/:id/historial
router.get('/:id/historial', async (req, res) => {
    const { data, error } = await supabase
        .from('asignaciones')
        .select(`
            id, tipo_persona, categoria_aplicada, valor_diario_aplicado,
            duracion_dias_aplicada, pago_base_calculado, estado, created_at,
            rodeos(club, asociacion, fecha, tipo_rodeo_nombre, duracion_dias)
        `)
        .eq('usuario_pagado_id', req.params.id)
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

module.exports = router;
