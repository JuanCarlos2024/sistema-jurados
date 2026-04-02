const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');

// GET /api/admin/configuracion/tarifas
router.get('/tarifas', async (req, res) => {
    const { data, error } = await supabase
        .from('configuracion_tarifas')
        .select('*')
        .order('categoria');

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// PATCH /api/admin/configuracion/tarifas/:categoria
router.patch('/tarifas/:categoria', async (req, res) => {
    const cat = req.params.categoria.toUpperCase();
    if (!['A', 'B', 'C'].includes(cat)) {
        return res.status(400).json({ error: 'Categoría debe ser A, B o C' });
    }

    const { valor_diario, valor_2_dias } = req.body;
    if (!valor_diario || valor_diario <= 0) {
        return res.status(400).json({ error: 'valor_diario debe ser mayor a 0' });
    }

    const { data: anterior } = await supabase
        .from('configuracion_tarifas')
        .select('*')
        .eq('categoria', cat)
        .single();

    const { data, error } = await supabase
        .from('configuracion_tarifas')
        .update({
            valor_diario: parseInt(valor_diario),
            valor_2_dias: parseInt(valor_2_dias || valor_diario * 2),
            updated_at: new Date().toISOString(),
            updated_by: req.usuario.id
        })
        .eq('categoria', cat)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'configuracion_tarifas',
        registro_id: cat,
        accion: 'modificar_tarifa',
        datos_anteriores: anterior,
        datos_nuevos: { categoria: cat, valor_diario: parseInt(valor_diario) },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Tarifa categoría ${cat} actualizada: $${valor_diario}/día`,
        ip_address: req.ip
    });

    res.json(data);
});

// GET /api/admin/configuracion/retencion
router.get('/retencion', async (req, res) => {
    const { data, error } = await supabase
        .from('configuracion_retencion')
        .select('*')
        .limit(1)
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// PATCH /api/admin/configuracion/retencion
router.patch('/retencion', async (req, res) => {
    const { porcentaje } = req.body;

    if (porcentaje === undefined || porcentaje < 0 || porcentaje > 100) {
        return res.status(400).json({ error: 'El porcentaje debe estar entre 0 y 100' });
    }

    const { data: anterior } = await supabase
        .from('configuracion_retencion')
        .select('*')
        .limit(1)
        .single();

    const { data, error } = await supabase
        .from('configuracion_retencion')
        .update({
            porcentaje: parseFloat(porcentaje),
            updated_at: new Date().toISOString(),
            updated_by: req.usuario.id
        })
        .eq('id', anterior.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'configuracion_retencion',
        registro_id: anterior.id,
        accion: 'modificar_retencion',
        datos_anteriores: { porcentaje: anterior.porcentaje },
        datos_nuevos: { porcentaje: parseFloat(porcentaje) },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Retención actualizada de ${anterior.porcentaje}% a ${porcentaje}%`,
        ip_address: req.ip
    });

    res.json(data);
});

// GET /api/admin/configuracion/bonos
router.get('/bonos', async (req, res) => {
    const { data, error } = await supabase
        .from('bonos_config')
        .select('*')
        .order('distancia_minima');

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// POST /api/admin/configuracion/bonos
router.post('/bonos', async (req, res) => {
    const { nombre, distancia_minima, distancia_maxima, monto } = req.body;

    if (!nombre || !distancia_minima || !monto) {
        return res.status(400).json({ error: 'nombre, distancia_minima y monto son requeridos' });
    }
    if (distancia_minima < 0) {
        return res.status(400).json({ error: 'distancia_minima debe ser mayor o igual a 0' });
    }
    if (monto <= 0) {
        return res.status(400).json({ error: 'monto debe ser mayor a 0' });
    }

    const { data, error } = await supabase
        .from('bonos_config')
        .insert({
            nombre: nombre.trim(),
            distancia_minima: parseInt(distancia_minima),
            distancia_maxima: distancia_maxima ? parseInt(distancia_maxima) : null,
            monto: parseInt(monto),
            created_by: req.usuario.id
        })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'bonos_config',
        registro_id: data.id,
        accion: 'crear',
        datos_nuevos: { nombre, distancia_minima, distancia_maxima, monto },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Nuevo bono creado: ${nombre}`,
        ip_address: req.ip
    });

    res.status(201).json(data);
});

// PATCH /api/admin/configuracion/bonos/:id
router.patch('/bonos/:id', async (req, res) => {
    const { nombre, distancia_minima, distancia_maxima, monto, activo } = req.body;
    const cambios = { updated_at: new Date().toISOString() };

    if (nombre) cambios.nombre = nombre.trim();
    if (distancia_minima !== undefined) cambios.distancia_minima = parseInt(distancia_minima);
    if (distancia_maxima !== undefined) cambios.distancia_maxima = distancia_maxima ? parseInt(distancia_maxima) : null;
    if (monto !== undefined) cambios.monto = parseInt(monto);
    if (activo !== undefined) cambios.activo = !!activo;

    const { data, error } = await supabase
        .from('bonos_config')
        .update(cambios)
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'bonos_config',
        registro_id: req.params.id,
        accion: 'editar',
        datos_nuevos: cambios,
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Bono config editado`,
        ip_address: req.ip
    });

    res.json(data);
});

// DELETE /api/admin/configuracion/bonos/:id
router.delete('/bonos/:id', async (req, res) => {
    const { count } = await supabase
        .from('bonos_solicitados')
        .select('id', { count: 'exact', head: true })
        .eq('bono_config_id', req.params.id);

    if (count > 0) {
        // Solo desactivar si tiene bonos asociados
        await supabase
            .from('bonos_config')
            .update({ activo: false, updated_at: new Date().toISOString() })
            .eq('id', req.params.id);
        return res.json({ mensaje: 'Bono desactivado (tiene solicitudes asociadas, no se puede eliminar)' });
    }

    await supabase.from('bonos_config').delete().eq('id', req.params.id);
    res.json({ mensaje: 'Bono eliminado' });
});

// GET /api/admin/configuracion/administradores
router.get('/administradores', async (req, res) => {
    const { data, error } = await supabase
        .from('administradores')
        .select('id, nombre_completo, email, activo, created_at')
        .order('nombre_completo');

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// POST /api/admin/configuracion/administradores
router.post('/administradores', async (req, res) => {
    const { nombre_completo, email, password } = req.body;

    if (!nombre_completo || !email || !password) {
        return res.status(400).json({ error: 'nombre_completo, email y password son requeridos' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
    }

    const bcrypt = require('bcryptjs');
    const password_hash = await bcrypt.hash(password, 12);

    const { data, error } = await supabase
        .from('administradores')
        .insert({
            nombre_completo: nombre_completo.trim(),
            email: email.trim().toLowerCase(),
            password_hash
        })
        .select('id, nombre_completo, email, activo, created_at')
        .single();

    if (error) {
        if (error.code === '23505') return res.status(400).json({ error: 'El email ya está en uso' });
        return res.status(500).json({ error: error.message });
    }

    await auditoria.registrar({
        tabla: 'administradores',
        registro_id: data.id,
        accion: 'crear',
        datos_nuevos: { nombre_completo, email },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Nuevo administrador creado: ${email}`,
        ip_address: req.ip
    });

    res.status(201).json(data);
});

// PATCH /api/admin/configuracion/administradores/:id
router.patch('/administradores/:id', async (req, res) => {
    const { nombre_completo, email, activo } = req.body;
    const cambios = { updated_at: new Date().toISOString() };

    if (nombre_completo) cambios.nombre_completo = nombre_completo.trim();
    if (email) cambios.email = email.trim().toLowerCase();
    if (activo !== undefined) cambios.activo = !!activo;

    const { data, error } = await supabase
        .from('administradores')
        .update(cambios)
        .eq('id', req.params.id)
        .select('id, nombre_completo, email, activo')
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// POST /api/admin/configuracion/administradores/:id/resetear-password
router.post('/administradores/:id/resetear-password', async (req, res) => {
    const { nueva_password } = req.body;

    if (!nueva_password || nueva_password.length < 8) {
        return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
    }

    const bcrypt = require('bcryptjs');
    const password_hash = await bcrypt.hash(nueva_password, 12);

    await supabase
        .from('administradores')
        .update({ password_hash, updated_at: new Date().toISOString() })
        .eq('id', req.params.id);

    await auditoria.registrar({
        tabla: 'administradores',
        registro_id: req.params.id,
        accion: 'resetear_clave',
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: 'Contraseña de administrador reseteada',
        ip_address: req.ip
    });

    res.json({ mensaje: 'Contraseña actualizada' });
});

module.exports = router;
