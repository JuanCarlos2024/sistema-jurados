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
    if (!['A', 'B', 'C', 'DR'].includes(cat)) {
        return res.status(400).json({ error: 'Categoría debe ser A, B, C o DR' });
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

// GET /api/admin/configuracion/evaluacion
router.get('/evaluacion', async (req, res) => {
    const { data, error } = await supabase
        .from('evaluacion_configuracion')
        .select('*')
        .eq('activo', true)
        .single();

    if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
    res.json(data || null);
});

const DIAS_VALIDOS = ['lunes','martes','miercoles','jueves','viernes','sabado','domingo'];

// PATCH /api/admin/configuracion/evaluacion
router.patch('/evaluacion', async (req, res) => {
    const {
        puntaje_base, min_casos_ciclo1, max_casos_ciclo1, min_casos_ciclo2, max_casos_ciclo2,
        descuento_interpretativa, descuento_reglamentaria, descuento_informativo,
        usar_plazo_respuesta, ciclo1_dia_limite, ciclo1_hora_limite,
        ciclo2_dia_limite, ciclo2_hora_limite, usar_aceptacion_silencio
    } = req.body;

    const cambios = { updated_at: new Date().toISOString() };
    if (puntaje_base                !== undefined) cambios.puntaje_base                = parseInt(puntaje_base);
    if (min_casos_ciclo1            !== undefined) cambios.min_casos_ciclo1            = parseInt(min_casos_ciclo1);
    if (max_casos_ciclo1            !== undefined) cambios.max_casos_ciclo1            = parseInt(max_casos_ciclo1);
    if (min_casos_ciclo2            !== undefined) cambios.min_casos_ciclo2            = parseInt(min_casos_ciclo2);
    if (max_casos_ciclo2            !== undefined) cambios.max_casos_ciclo2            = parseInt(max_casos_ciclo2);
    if (descuento_interpretativa    !== undefined) cambios.descuento_interpretativa    = parseInt(descuento_interpretativa);
    if (descuento_reglamentaria     !== undefined) cambios.descuento_reglamentaria     = parseInt(descuento_reglamentaria);
    if (descuento_informativo       !== undefined) cambios.descuento_informativo       = parseInt(descuento_informativo);
    if (usar_plazo_respuesta        !== undefined) cambios.usar_plazo_respuesta        = usar_plazo_respuesta === true || usar_plazo_respuesta === 'true';
    if (usar_aceptacion_silencio    !== undefined) cambios.usar_aceptacion_silencio    = usar_aceptacion_silencio === true || usar_aceptacion_silencio === 'true';
    if (ciclo1_dia_limite           !== undefined) {
        if (!DIAS_VALIDOS.includes(ciclo1_dia_limite)) return res.status(400).json({ error: 'ciclo1_dia_limite inválido' });
        cambios.ciclo1_dia_limite = ciclo1_dia_limite;
    }
    if (ciclo2_dia_limite           !== undefined) {
        if (!DIAS_VALIDOS.includes(ciclo2_dia_limite)) return res.status(400).json({ error: 'ciclo2_dia_limite inválido' });
        cambios.ciclo2_dia_limite = ciclo2_dia_limite;
    }
    if (ciclo1_hora_limite          !== undefined) cambios.ciclo1_hora_limite = ciclo1_hora_limite;
    if (ciclo2_hora_limite          !== undefined) cambios.ciclo2_hora_limite = ciclo2_hora_limite;

    if (Object.keys(cambios).length === 1) return res.status(400).json({ error: 'Sin campos a actualizar' });

    // Upsert: si no existe registro activo, lo crea
    const { data: actual } = await supabase
        .from('evaluacion_configuracion')
        .select('id')
        .eq('activo', true)
        .single();

    let data, error;
    if (actual) {
        ({ data, error } = await supabase
            .from('evaluacion_configuracion')
            .update(cambios)
            .eq('id', actual.id)
            .select()
            .single());
    } else {
        ({ data, error } = await supabase
            .from('evaluacion_configuracion')
            .insert({ ...cambios, activo: true })
            .select()
            .single());
    }

    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'evaluacion_configuracion',
        registro_id: data.id,
        accion: 'editar',
        datos_nuevos: cambios,
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: 'Configuración de evaluación técnica actualizada',
        ip_address: req.ip
    });

    res.json(data);
});

// GET /api/admin/configuracion/evaluacion/escala-nota
router.get('/evaluacion/escala-nota', async (req, res) => {
    const { data, error } = await supabase
        .from('evaluacion_escala_puntaje_nota')
        .select('puntaje, nota, activo')
        .order('puntaje');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// PUT /api/admin/configuracion/evaluacion/escala-nota  (reemplaza tabla completa)
router.put('/evaluacion/escala-nota', async (req, res) => {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: 'rows debe ser un arreglo no vacío' });
    }
    for (const r of rows) {
        const p = parseInt(r.puntaje);
        const n = parseFloat(r.nota);
        if (isNaN(p) || p < 0)          return res.status(400).json({ error: `Puntaje inválido: ${r.puntaje}` });
        if (isNaN(n) || n < 1.0 || n > 7.0) return res.status(400).json({ error: `Nota inválida: ${r.nota} (puntaje ${r.puntaje})` });
    }
    const puntajes = rows.map(r => parseInt(r.puntaje));
    if (new Set(puntajes).size !== puntajes.length) {
        return res.status(400).json({ error: 'Existen puntajes duplicados' });
    }

    await supabase.from('evaluacion_escala_puntaje_nota').delete().gte('id', 0);

    const inserts = rows.map(r => ({
        puntaje: parseInt(r.puntaje),
        nota:    parseFloat(r.nota),
        activo:  r.activo !== false
    }));
    const { error } = await supabase.from('evaluacion_escala_puntaje_nota').insert(inserts);
    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'evaluacion_escala_puntaje_nota',
        registro_id: 'all',
        accion: 'reemplazar_tabla',
        datos_nuevos: { total_filas: rows.length },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Tabla puntaje→nota reemplazada (${rows.length} filas)`,
        ip_address: req.ip
    });

    res.json({ mensaje: `Tabla actualizada con ${rows.length} filas` });
});

// GET /api/admin/configuracion/evaluacion/escala-calificacion
router.get('/evaluacion/escala-calificacion', async (req, res) => {
    const { data, error } = await supabase
        .from('evaluacion_escala_calificacion')
        .select('id, categoria, nota_min, nota_max, calificacion, activo')
        .order('nota_min', { ascending: false })
        .order('categoria');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// PUT /api/admin/configuracion/evaluacion/escala-calificacion  (reemplaza tabla completa)
router.put('/evaluacion/escala-calificacion', async (req, res) => {
    const { rows } = req.body;
    const CATS  = ['A', 'B', 'C'];
    const CALS  = ['SOBRESALIENTE', 'BIEN', 'BAJO LO ESPERADO', 'DEFICIENTE'];
    if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: 'rows debe ser un arreglo no vacío' });
    }
    for (const r of rows) {
        if (!CATS.includes(r.categoria))  return res.status(400).json({ error: `categoria inválida: ${r.categoria}` });
        if (!CALS.includes(r.calificacion)) return res.status(400).json({ error: `calificacion inválida: ${r.calificacion}` });
        const mn = parseFloat(r.nota_min), mx = parseFloat(r.nota_max);
        if (isNaN(mn) || mn < 1.0 || mn > 7.0) return res.status(400).json({ error: `nota_min inválida: ${r.nota_min}` });
        if (isNaN(mx) || mx < 1.0 || mx > 7.0) return res.status(400).json({ error: `nota_max inválida: ${r.nota_max}` });
        if (mn >= mx) return res.status(400).json({ error: `nota_min debe ser menor que nota_max (${r.nota_min} ≥ ${r.nota_max})` });
    }

    await supabase.from('evaluacion_escala_calificacion').delete().neq('id', '00000000-0000-0000-0000-000000000000');

    const inserts = rows.map(r => ({
        categoria:    r.categoria,
        nota_min:     parseFloat(r.nota_min),
        nota_max:     parseFloat(r.nota_max),
        calificacion: r.calificacion,
        activo:       r.activo !== false
    }));
    const { error } = await supabase.from('evaluacion_escala_calificacion').insert(inserts);
    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'evaluacion_escala_calificacion',
        registro_id: 'all',
        accion: 'reemplazar_tabla',
        datos_nuevos: { total_filas: rows.length },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Tabla calificación reemplazada (${rows.length} filas)`,
        ip_address: req.ip
    });

    res.json({ mensaje: `Tabla actualizada con ${rows.length} filas` });
});

// GET /api/admin/configuracion/administradores
router.get('/administradores', async (req, res) => {
    const { data, error } = await supabase
        .from('administradores')
        .select('id, nombre_completo, email, activo, created_at, rol_evaluacion')
        .order('nombre_completo');

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// POST /api/admin/configuracion/administradores
router.post('/administradores', async (req, res) => {
    const { nombre_completo, email, password, rol_evaluacion } = req.body;

    if (!nombre_completo || !email || !password) {
        return res.status(400).json({ error: 'nombre_completo, email y password son requeridos' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
    }
    const ROLES_EVAL = ['jefe_area', 'analista', 'comision_tecnica'];
    const rolEval = rol_evaluacion || null;
    if (rolEval && !ROLES_EVAL.includes(rolEval)) {
        return res.status(400).json({ error: 'rol_evaluacion debe ser jefe_area, analista o comision_tecnica' });
    }

    const bcrypt = require('bcryptjs');
    const password_hash = await bcrypt.hash(password, 12);

    const { data, error } = await supabase
        .from('administradores')
        .insert({
            nombre_completo: nombre_completo.trim(),
            email: email.trim().toLowerCase(),
            password_hash,
            rol_evaluacion: rolEval
        })
        .select('id, nombre_completo, email, activo, created_at, rol_evaluacion')
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
    const { nombre_completo, email, activo, rol_evaluacion } = req.body;
    const cambios = { updated_at: new Date().toISOString() };

    if (nombre_completo) cambios.nombre_completo = nombre_completo.trim();
    if (email) cambios.email = email.trim().toLowerCase();
    if (activo !== undefined) cambios.activo = !!activo;

    if ('rol_evaluacion' in req.body) {
        const ROLES_EVAL = ['jefe_area', 'analista', 'comision_tecnica'];
        const rolEval = rol_evaluacion || null;
        if (rolEval && !ROLES_EVAL.includes(rolEval)) {
            return res.status(400).json({ error: 'rol_evaluacion debe ser jefe_area, analista o comision_tecnica' });
        }
        cambios.rol_evaluacion = rolEval;
    }

    const { data, error } = await supabase
        .from('administradores')
        .update(cambios)
        .eq('id', req.params.id)
        .select('id, nombre_completo, email, activo, rol_evaluacion')
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'administradores',
        registro_id: req.params.id,
        accion: 'editar',
        datos_nuevos: cambios,
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Administrador actualizado`,
        ip_address: req.ip
    });

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
