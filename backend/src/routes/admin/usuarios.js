const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');
const { procesarRutInput } = require('../../services/rut');
const ExcelJS = require('exceljs');

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

// GET /api/admin/usuarios?tipo=&activo=&estado=&buscar=&categoria=&page=&limit=
router.get('/', async (req, res) => {
    const { tipo, activo, estado, buscar, categoria, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
        .from('usuarios_pagados')
        .select('id, codigo_interno, tipo_persona, nombre_completo, rut, categoria, email, telefono, ciudad, asociacion, perfil_completo, activo, estado_usuario, suspension_desde, suspension_hasta, suspension_motivo, created_at, updated_at', { count: 'exact' })
        .order('nombre_completo', { ascending: true })
        .range(offset, offset + parseInt(limit) - 1);

    if (tipo) query = query.eq('tipo_persona', tipo);
    // estado toma precedencia sobre activo (legacy)
    const ESTADOS_VALIDOS = ['activo', 'inactivo', 'receso', 'suspendido'];
    if (estado && ESTADOS_VALIDOS.includes(estado)) query = query.eq('estado_usuario', estado);
    else if (activo !== undefined && activo !== '') query = query.eq('activo', activo === 'true');
    if (buscar)    query = query.or(`nombre_completo.ilike.%${buscar}%,codigo_interno.ilike.%${buscar}%,rut.ilike.%${buscar}%`);
    if (categoria) query = query.eq('categoria', categoria);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ data, total: count, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/admin/usuarios/exportar?tipo=&activo=&buscar=&categoria=
// Exporta los registros filtrados como Excel (igual que el listado, sin paginación)
router.get('/exportar', async (req, res) => {
    const { tipo, activo, buscar, categoria } = req.query;

    let query = supabase
        .from('usuarios_pagados')
        .select('codigo_interno, tipo_persona, nombre_completo, rut, categoria, email, telefono, ciudad, asociacion, activo')
        .order('nombre_completo', { ascending: true });

    if (tipo)                        query = query.eq('tipo_persona', tipo);
    if (activo !== undefined && activo !== '') query = query.eq('activo', activo === 'true');
    if (buscar)                      query = query.or(`nombre_completo.ilike.%${buscar}%,codigo_interno.ilike.%${buscar}%,rut.ilike.%${buscar}%`);
    if (categoria)                   query = query.eq('categoria', categoria);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const TIPO_LABEL = { jurado: 'Jurado', delegado_rentado: 'Delegado Rentado' };
    const HEADER_STYLE = {
        font: { bold: true, color: { argb: 'FFFFFFFF' } },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a5f' } },
        alignment: { horizontal: 'center' },
        border: {
            top: { style: 'thin' }, bottom: { style: 'thin' },
            left: { style: 'thin' }, right: { style: 'thin' }
        }
    };

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Sistema Jurados - Rodeo Chileno';
    const ws = wb.addWorksheet('Jurados y Delegados');

    ws.columns = [
        { header: 'Código',     key: 'codigo',    width: 12 },
        { header: 'Nombre',     key: 'nombre',    width: 35 },
        { header: 'Tipo',       key: 'tipo',      width: 20 },
        { header: 'Categoría',  key: 'cat',       width: 10 },
        { header: 'RUT',        key: 'rut',       width: 14 },
        { header: 'Ciudad',     key: 'ciudad',    width: 18 },
        { header: 'Asociación', key: 'asoc',      width: 24 },
        { header: 'Teléfono',   key: 'telefono',  width: 16 },
        { header: 'Correo',     key: 'email',     width: 32 },
        { header: 'Estado',     key: 'estado',    width: 10 },
    ];
    ws.getRow(1).eachCell(cell => { Object.assign(cell, HEADER_STYLE); });

    (data || []).forEach(u => {
        ws.addRow({
            codigo:   u.codigo_interno || '',
            nombre:   u.nombre_completo || '',
            tipo:     TIPO_LABEL[u.tipo_persona] || u.tipo_persona || '',
            cat:      u.categoria || '',
            rut:      u.rut || '',
            ciudad:   u.ciudad || '',
            asoc:     u.asociacion || '',
            telefono: u.telefono || '',
            email:    u.email || '',
            estado:   u.activo ? 'Activo' : 'Inactivo',
        });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="jurados_delegados.xlsx"');
    await wb.xlsx.write(res);
    res.end();
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
    const { categoria, observacion } = req.body;

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

    await supabase.from('usuario_historial_cambios').insert({
        usuario_pagado_id:   req.params.id,
        tipo_cambio:         'categoria',
        valor_anterior:      anterior.categoria || null,
        valor_nuevo:         categoria,
        cambiado_por:        req.usuario.id,
        cambiado_por_nombre: req.usuario.nombre,
        observacion:         observacion || null
    });

    res.json({ mensaje: `Categoría actualizada a ${categoria}` });
});

// PATCH /api/admin/usuarios/:id/activar  (legacy — mantiene compatibilidad)
router.patch('/:id/activar', async (req, res) => {
    const { activo, observacion } = req.body;
    const nuevoEstado = activo ? 'activo' : 'inactivo';

    const { data: u } = await supabase
        .from('usuarios_pagados')
        .select('nombre_completo, activo, estado_usuario')
        .eq('id', req.params.id)
        .single();

    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });

    const estadoAnterior = u.estado_usuario || (u.activo ? 'activo' : 'inactivo');

    await supabase
        .from('usuarios_pagados')
        .update({ activo: !!activo, estado_usuario: nuevoEstado, updated_at: new Date().toISOString() })
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

    await supabase.from('usuario_historial_cambios').insert({
        usuario_pagado_id:   req.params.id,
        tipo_cambio:         'estado',
        valor_anterior:      estadoAnterior,
        valor_nuevo:         nuevoEstado,
        cambiado_por:        req.usuario.id,
        cambiado_por_nombre: req.usuario.nombre,
        observacion:         observacion || null
    });

    res.json({ mensaje: `Usuario ${activo ? 'activado' : 'desactivado'}` });
});

// PATCH /api/admin/usuarios/:id/estado — activo | inactivo | receso
router.patch('/:id/estado', async (req, res) => {
    const { estado, observacion } = req.body;
    const ESTADOS = ['activo', 'inactivo', 'receso'];

    if (!ESTADOS.includes(estado)) {
        return res.status(400).json({ error: `estado debe ser uno de: ${ESTADOS.join(', ')}` });
    }

    const { data: u } = await supabase
        .from('usuarios_pagados')
        .select('nombre_completo, activo, estado_usuario')
        .eq('id', req.params.id)
        .single();

    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });

    const estadoAnterior = u.estado_usuario || (u.activo ? 'activo' : 'inactivo');
    const activoBool = estado === 'activo';

    const updatePayload = { estado_usuario: estado, activo: activoBool, updated_at: new Date().toISOString() };
    // Al reactivar desde suspensión, limpiar campos de suspensión
    if (estado === 'activo' && estadoAnterior === 'suspendido') {
        updatePayload.suspension_desde  = null;
        updatePayload.suspension_hasta  = null;
        updatePayload.suspension_motivo = null;
    }

    await supabase
        .from('usuarios_pagados')
        .update(updatePayload)
        .eq('id', req.params.id);

    await auditoria.registrar({
        tabla: 'usuarios_pagados',
        registro_id: req.params.id,
        accion: `cambiar_estado_${estado}`,
        datos_anteriores: { estado_usuario: estadoAnterior },
        datos_nuevos:     { estado_usuario: estado },
        actor_id:   req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Estado de ${u.nombre_completo} cambiado de ${estadoAnterior} a ${estado}`,
        ip_address: req.ip
    });

    await supabase.from('usuario_historial_cambios').insert({
        usuario_pagado_id:   req.params.id,
        tipo_cambio:         'estado',
        valor_anterior:      estadoAnterior,
        valor_nuevo:         estado,
        cambiado_por:        req.usuario.id,
        cambiado_por_nombre: req.usuario.nombre,
        observacion:         observacion || null
    });

    res.json({ mensaje: `Estado actualizado a ${estado}` });
});

// PATCH /api/admin/usuarios/:id/suspender
router.patch('/:id/suspender', async (req, res) => {
    const { fecha_desde, fecha_hasta, motivo } = req.body;

    if (!fecha_desde) return res.status(400).json({ error: 'fecha_desde es obligatoria' });
    if (!fecha_hasta) return res.status(400).json({ error: 'fecha_hasta es obligatoria' });
    if (!motivo || !motivo.trim()) return res.status(400).json({ error: 'El motivo es obligatorio' });
    if (fecha_hasta < fecha_desde) return res.status(400).json({ error: 'fecha_hasta debe ser igual o posterior a fecha_desde' });

    const { data: u } = await supabase
        .from('usuarios_pagados')
        .select('nombre_completo, activo, estado_usuario')
        .eq('id', req.params.id)
        .single();

    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });

    const estadoAnterior = u.estado_usuario || (u.activo ? 'activo' : 'inactivo');
    const ahora = new Date().toISOString();

    await supabase
        .from('usuarios_pagados')
        .update({
            estado_usuario:     'suspendido',
            suspension_desde:   fecha_desde,
            suspension_hasta:   fecha_hasta,
            suspension_motivo:  motivo.trim(),
            updated_at:         ahora
        })
        .eq('id', req.params.id);

    await auditoria.registrar({
        tabla: 'usuarios_pagados',
        registro_id: req.params.id,
        accion: 'suspender',
        datos_anteriores: { estado_usuario: estadoAnterior },
        datos_nuevos:     { estado_usuario: 'suspendido', suspension_desde: fecha_desde, suspension_hasta: fecha_hasta },
        actor_id:   req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `${u.nombre_completo} suspendido del ${fecha_desde} al ${fecha_hasta}: ${motivo.trim()}`,
        ip_address: req.ip
    });

    await supabase.from('usuario_historial_cambios').insert({
        usuario_pagado_id:   req.params.id,
        tipo_cambio:         'suspension',
        valor_anterior:      estadoAnterior,
        valor_nuevo:         'suspendido',
        fecha_desde:         fecha_desde,
        fecha_hasta:         fecha_hasta,
        cambiado_por:        req.usuario.id,
        cambiado_por_nombre: req.usuario.nombre,
        observacion:         motivo.trim()
    });

    res.json({ mensaje: `Usuario suspendido del ${fecha_desde} al ${fecha_hasta}` });
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

// DELETE /api/admin/usuarios/:id — eliminación física (solo admin pleno)
router.delete('/:id', async (req, res) => {
    if (req.usuario.rol_evaluacion !== null && req.usuario.rol_evaluacion !== undefined) {
        return res.status(403).json({ error: 'Solo el administrador pleno puede eliminar usuarios' });
    }

    const { data: u } = await supabase
        .from('usuarios_pagados')
        .select('nombre_completo')
        .eq('id', req.params.id)
        .single();

    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });

    const { count: cAsig } = await supabase
        .from('asignaciones')
        .select('id', { count: 'exact', head: true })
        .eq('usuario_pagado_id', req.params.id);

    if (cAsig > 0) {
        return res.status(409).json({
            error: `No se puede eliminar: el usuario tiene ${cAsig} asignación${cAsig > 1 ? 'es' : ''} registrada${cAsig > 1 ? 's' : ''}. Desactívelo en su lugar si ya no debe usarse.`
        });
    }

    await supabase.from('usuarios_pagados').delete().eq('id', req.params.id);

    await auditoria.registrar({
        tabla: 'usuarios_pagados',
        registro_id: req.params.id,
        accion: 'eliminar_fisico',
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Usuario ${u.nombre_completo} eliminado permanentemente`,
        ip_address: req.ip
    });

    res.json({ mensaje: `Usuario ${u.nombre_completo} eliminado correctamente` });
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
