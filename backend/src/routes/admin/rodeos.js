const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');
const { obtenerTarifas, calcularPagoBase } = require('../../services/calculo');

// ─── Helper: intersectar arrays de IDs para filtros complejos ───
function intersectIds(current, newIds) {
    const s = new Set(newIds);
    if (current === null) return [...s];
    return current.filter(id => s.has(id));
}

// ─── Helper: resolver filtros que requieren pre-queries ─────────
async function resolverFiltrosComplejos(q) {
    const { jurado_id, delegado_id, estado_jurado, estado_delegado,
            cartilla_jurado, cartilla_delegado, video } = q;

    const ninguno = !jurado_id && !delegado_id && !estado_jurado &&
                    !estado_delegado && !cartilla_jurado && !cartilla_delegado && !video;
    if (ninguno) return { incluir: null, excluir: [] };

    let incluir = null;
    const excluirSet = new Set();

    if (jurado_id) {
        const { data } = await supabase.from('asignaciones').select('rodeo_id')
            .eq('usuario_pagado_id', jurado_id).eq('tipo_persona', 'jurado').eq('estado', 'activo');
        incluir = intersectIds(incluir, (data||[]).map(r => r.rodeo_id));
    }
    if (delegado_id) {
        const { data } = await supabase.from('asignaciones').select('rodeo_id')
            .eq('usuario_pagado_id', delegado_id).eq('tipo_persona', 'delegado_rentado').eq('estado', 'activo');
        incluir = intersectIds(incluir, (data||[]).map(r => r.rodeo_id));
    }
    if (estado_jurado) {
        let sq = supabase.from('asignaciones').select('rodeo_id')
            .eq('tipo_persona', 'jurado').eq('estado', 'activo');
        sq = estado_jurado === 'aceptado'
            ? sq.or('estado_designacion.eq.aceptado,estado_designacion.is.null')
            : sq.eq('estado_designacion', estado_jurado);
        const { data } = await sq;
        incluir = intersectIds(incluir, (data||[]).map(r => r.rodeo_id));
    }
    if (estado_delegado) {
        let sq = supabase.from('asignaciones').select('rodeo_id')
            .eq('tipo_persona', 'delegado_rentado').eq('estado', 'activo');
        sq = estado_delegado === 'aceptado'
            ? sq.or('estado_designacion.eq.aceptado,estado_designacion.is.null')
            : sq.eq('estado_designacion', estado_delegado);
        const { data } = await sq;
        incluir = intersectIds(incluir, (data||[]).map(r => r.rodeo_id));
    }
    if (cartilla_jurado) {
        const { data } = await supabase.from('rodeo_adjuntos').select('rodeo_id')
            .in('tipo_adjunto', ['cartilla_jurado', 'cartilla']);
        const ids = [...new Set((data||[]).map(r => r.rodeo_id))];
        if (cartilla_jurado === 'con') incluir = intersectIds(incluir, ids);
        else ids.forEach(id => excluirSet.add(id));
    }
    if (cartilla_delegado) {
        const { data } = await supabase.from('rodeo_adjuntos').select('rodeo_id')
            .eq('tipo_adjunto', 'cartilla_delegado');
        const ids = [...new Set((data||[]).map(r => r.rodeo_id))];
        if (cartilla_delegado === 'con') incluir = intersectIds(incluir, ids);
        else ids.forEach(id => excluirSet.add(id));
    }
    if (video) {
        const { data } = await supabase.from('rodeo_links').select('rodeo_id');
        const ids = [...new Set((data||[]).map(r => r.rodeo_id))];
        if (video === 'con') incluir = intersectIds(incluir, ids);
        else ids.forEach(id => excluirSet.add(id));
    }

    const excluir = [...excluirSet];
    if (incluir !== null && excluir.length > 0)
        incluir = incluir.filter(id => !excluirSet.has(id));

    return { incluir, excluir };
}

// GET /api/admin/rodeos — filtros avanzados
router.get('/', async (req, res) => {
    const {
        mes, año, buscar, club, asociacion,
        tipo_rodeo_id, tipo, categoria_rodeo_id, origen, estado,
        fecha_desde, fecha_hasta,
        jurado_id, delegado_id, estado_jurado, estado_delegado,
        cartilla_jurado, cartilla_delegado, video,
        page = 1, limit = 50
    } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Resolver filtros complejos (pre-queries)
    const { incluir, excluir } = await resolverFiltrosComplejos(req.query);
    if (Array.isArray(incluir) && incluir.length === 0)
        return res.json({ data: [], total: 0, page: parseInt(page), limit: parseInt(limit) });

    // Pre-query para búsqueda por nombre de jurado/delegado
    let buscarRodeoIds = [];
    if (buscar) {
        // 1. Por nombre_importado en asignaciones
        const { data: byImp } = await supabase
            .from('asignaciones')
            .select('rodeo_id')
            .eq('estado', 'activo')
            .ilike('nombre_importado', `%${buscar}%`);

        // 2. Por nombre_completo en usuarios_pagados → asignaciones
        const { data: usuariosMatch } = await supabase
            .from('usuarios_pagados')
            .select('id')
            .ilike('nombre_completo', `%${buscar}%`);

        const idSet = new Set((byImp || []).map(a => a.rodeo_id));

        if (usuariosMatch && usuariosMatch.length > 0) {
            const uids = usuariosMatch.map(u => u.id);
            const { data: byUser } = await supabase
                .from('asignaciones')
                .select('rodeo_id')
                .eq('estado', 'activo')
                .in('usuario_pagado_id', uids);
            (byUser || []).forEach(a => idSet.add(a.rodeo_id));
        }

        buscarRodeoIds = [...idSet];
    }

    let query = supabase
        .from('rodeos')
        .select(`
            id, club, asociacion, fecha, tipo_rodeo_nombre, tipo_rodeo_id,
            categoria_rodeo_id, categoria_rodeo_nombre, duracion_dias, origen, estado, created_at,
            tipos_rodeo(categoria_rodeo_id, categorias_rodeo(nombre))
        `, { count: 'exact' })
        .order('fecha', { ascending: false })
        .range(offset, offset + parseInt(limit) - 1);

    if (estado) query = query.eq('estado', estado);
    else        query = query.eq('estado', 'activo');

    if (categoria_rodeo_id) {
        // Categoría directa en el rodeo OR heredada desde tipos_rodeo
        const { data: tiposConCat } = await supabase
            .from('tipos_rodeo')
            .select('id')
            .eq('categoria_rodeo_id', categoria_rodeo_id);
        const tipoIds = (tiposConCat || []).map(t => t.id);
        if (tipoIds.length > 0) {
            query = query.or(
                `categoria_rodeo_id.eq.${categoria_rodeo_id},and(categoria_rodeo_id.is.null,tipo_rodeo_id.in.(${tipoIds.join(',')}))`
            );
        } else {
            query = query.eq('categoria_rodeo_id', categoria_rodeo_id);
        }
    }
    if (tipo_rodeo_id || tipo) query = query.eq('tipo_rodeo_id', tipo_rodeo_id || tipo);
    if (origen) query = query.eq('origen', origen);
    if (buscar) {
        const orBase = `club.ilike.%${buscar}%,asociacion.ilike.%${buscar}%`;
        if (buscarRodeoIds.length > 0) {
            query = query.or(`${orBase},id.in.(${buscarRodeoIds.join(',')})`);
        } else {
            query = query.or(orBase);
        }
    }
    if (club && !buscar)       query = query.ilike('club', `%${club}%`);
    if (asociacion && !buscar) query = query.ilike('asociacion', `%${asociacion}%`);

    if (fecha_desde) query = query.gte('fecha', fecha_desde);
    if (fecha_hasta) query = query.lte('fecha', fecha_hasta);

    if (!fecha_desde && !fecha_hasta) {
        const añoNum = parseInt(año), mesNum = parseInt(mes);
        if (!isNaN(añoNum) && !isNaN(mesNum) && mesNum >= 1 && mesNum <= 12) {
            const inicio = `${añoNum}-${String(mesNum).padStart(2,'0')}-01`;
            const fin    = new Date(añoNum, mesNum, 0).toISOString().split('T')[0];
            query = query.gte('fecha', inicio).lte('fecha', fin);
        } else if (!isNaN(añoNum)) {
            query = query.gte('fecha', `${añoNum}-01-01`).lte('fecha', `${añoNum}-12-31`);
        }
    }

    if (incluir !== null) query = query.in('id', incluir);
    else if (excluir.length > 0) query = query.not('id', 'in', `(${excluir.join(',')})`);

    const { data: rodeos, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Herencia de categoría desde tipo_rodeo si el rodeo no tiene categoría propia
    if (rodeos) {
        rodeos.forEach(r => {
            if (!r.categoria_rodeo_nombre) {
                const catNombre = r.tipos_rodeo?.categorias_rodeo?.nombre;
                if (catNombre) {
                    r.categoria_rodeo_nombre = catNombre;
                    r.categoria_heredada = true; // flag para el frontend si se necesita
                }
            }
            // Limpiar el join auxiliar de la respuesta
            delete r.tipos_rodeo;
        });
    }

    // Stats de asignaciones split por J/D y estado
    if (rodeos && rodeos.length > 0) {
        const ids = rodeos.map(r => r.id);
        const { data: asigs } = await supabase
            .from('asignaciones')
            .select('rodeo_id, tipo_persona, pago_base_calculado, estado_designacion, nombre_importado, usuarios_pagados(nombre_completo)')
            .in('rodeo_id', ids).eq('estado', 'activo');

        const emptyStats = () => ({
            total_asignaciones: 0, jurados: 0, delegados: 0, total_pago_base: 0,
            j_acept: 0, j_rech: 0, j_pend: 0,
            d_acept: 0, d_rech: 0, d_pend: 0,
            jurados_nombres: [],
            delegado_nombre: null
        });
        const sp = {};
        (asigs || []).forEach(a => {
            if (!sp[a.rodeo_id]) sp[a.rodeo_id] = emptyStats();
            const s = sp[a.rodeo_id];
            s.total_asignaciones++;
            s.total_pago_base += (a.pago_base_calculado || 0);
            const ed = a.estado_designacion;
            const acept = ed === 'aceptado' || ed === null; // null = legacy = aceptado
            const rech  = ed === 'rechazado';
            const nombre = a.usuarios_pagados?.nombre_completo || a.nombre_importado || null;
            if (a.tipo_persona === 'jurado') {
                s.jurados++;
                if (rech) s.j_rech++; else if (acept) s.j_acept++; else s.j_pend++;
                if (nombre) s.jurados_nombres.push(nombre);
            } else {
                s.delegados++;
                if (rech) s.d_rech++; else if (acept) s.d_acept++; else s.d_pend++;
                if (nombre && !s.delegado_nombre) s.delegado_nombre = nombre;
            }
        });
        rodeos.forEach(r => Object.assign(r, sp[r.id] || emptyStats()));
    }

    res.json({ data: rodeos, total: count, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/admin/rodeos/:id (con asignaciones)
router.get('/:id', async (req, res) => {
    const { data: rodeo, error } = await supabase
        .from('rodeos')
        .select('*, tipos_rodeo(nombre, duracion_dias, categoria_rodeo_id, categorias_rodeo(nombre))')
        .eq('id', req.params.id)
        .single();

    if (error) return res.status(404).json({ error: 'Rodeo no encontrado' });

    // Herencia de categoría desde tipo_rodeo si el rodeo no tiene categoría propia
    if (rodeo && !rodeo.categoria_rodeo_nombre) {
        const catNombre = rodeo.tipos_rodeo?.categorias_rodeo?.nombre;
        if (catNombre) {
            rodeo.categoria_rodeo_nombre = catNombre;
            rodeo.categoria_heredada = true;
        }
    }

    const { data: asignaciones } = await supabase
        .from('asignaciones')
        .select(`
            id, tipo_persona, nombre_importado, categoria_aplicada,
            valor_diario_aplicado, duracion_dias_aplicada, pago_base_calculado,
            estado, estado_designacion, distancia_km, aceptado_en, observacion, comentario_admin, created_at,
            usuarios_pagados(id, codigo_interno, nombre_completo, tipo_persona, categoria)
        `)
        .eq('rodeo_id', req.params.id)
        .neq('estado', 'anulado');

    res.json({ ...rodeo, asignaciones: asignaciones || [] });
});

// POST /api/admin/rodeos
router.post('/', async (req, res) => {
    const { club, asociacion, fecha, tipo_rodeo_id, categoria_rodeo_id, observacion } = req.body;

    if (!club || !asociacion || !fecha || !tipo_rodeo_id) {
        return res.status(400).json({ error: 'club, asociacion, fecha y tipo_rodeo_id son requeridos' });
    }

    const { data: tipo } = await supabase
        .from('tipos_rodeo')
        .select('id, nombre, duracion_dias')
        .eq('id', tipo_rodeo_id)
        .eq('activo', true)
        .single();

    if (!tipo) return res.status(400).json({ error: 'Tipo de rodeo no encontrado o inactivo' });

    // Snapshot del nombre de categoría
    let categoria_rodeo_nombre = null;
    if (categoria_rodeo_id) {
        const { data: cat } = await supabase.from('categorias_rodeo').select('nombre').eq('id', categoria_rodeo_id).single();
        if (cat) categoria_rodeo_nombre = cat.nombre;
    }

    const { data, error } = await supabase
        .from('rodeos')
        .insert({
            club: club.trim(),
            asociacion: asociacion.trim(),
            fecha,
            tipo_rodeo_id,
            tipo_rodeo_nombre: tipo.nombre,
            duracion_dias: tipo.duracion_dias,
            categoria_rodeo_id: categoria_rodeo_id || null,
            categoria_rodeo_nombre,
            observacion,
            origen: 'manual',
            created_by: req.usuario.id
        })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'rodeos',
        registro_id: data.id,
        accion: 'crear',
        datos_nuevos: { club, asociacion, fecha, tipo_rodeo_nombre: tipo.nombre },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Rodeo creado: ${club} - ${tipo.nombre} - ${fecha}`,
        ip_address: req.ip
    });

    res.status(201).json(data);
});

// PATCH /api/admin/rodeos/:id
router.patch('/:id', async (req, res) => {
    const { club, asociacion, fecha, tipo_rodeo_id, categoria_rodeo_id, observacion, estado } = req.body;

    const { data: anterior } = await supabase
        .from('rodeos')
        .select('*')
        .eq('id', req.params.id)
        .single();

    if (!anterior) return res.status(404).json({ error: 'Rodeo no encontrado' });

    const cambios = { updated_at: new Date().toISOString() };
    if (club) cambios.club = club.trim();
    if (asociacion) cambios.asociacion = asociacion.trim();
    if (fecha) cambios.fecha = fecha;
    if (observacion !== undefined) cambios.observacion = observacion;
    if (estado) cambios.estado = estado;

    if (tipo_rodeo_id && tipo_rodeo_id !== anterior.tipo_rodeo_id) {
        const { data: tipo } = await supabase
            .from('tipos_rodeo')
            .select('nombre, duracion_dias')
            .eq('id', tipo_rodeo_id)
            .single();

        if (!tipo) return res.status(400).json({ error: 'Tipo de rodeo no encontrado' });
        cambios.tipo_rodeo_id = tipo_rodeo_id;
        cambios.tipo_rodeo_nombre = tipo.nombre;
        cambios.duracion_dias = tipo.duracion_dias;
    }

    if (categoria_rodeo_id !== undefined) {
        if (categoria_rodeo_id) {
            const { data: cat } = await supabase.from('categorias_rodeo').select('nombre').eq('id', categoria_rodeo_id).single();
            cambios.categoria_rodeo_id = categoria_rodeo_id;
            cambios.categoria_rodeo_nombre = cat?.nombre || null;
        } else {
            cambios.categoria_rodeo_id = null;
            cambios.categoria_rodeo_nombre = null;
        }
    }

    const { data, error } = await supabase
        .from('rodeos')
        .update(cambios)
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'rodeos',
        registro_id: req.params.id,
        accion: 'editar',
        datos_anteriores: anterior,
        datos_nuevos: cambios,
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Rodeo editado: ${anterior.club}`,
        ip_address: req.ip
    });

    res.json(data);
});

// DELETE /api/admin/rodeos/:id (eliminar — soft delete en cascada)
router.delete('/:id', async (req, res) => {
    const { data: r } = await supabase
        .from('rodeos')
        .select('club, fecha')
        .eq('id', req.params.id)
        .single();

    if (!r) return res.status(404).json({ error: 'Rodeo no encontrado' });

    const ahora = new Date().toISOString();

    // 1. Obtener asignaciones del rodeo para luego rechazar sus bonos
    const { data: asigs } = await supabase
        .from('asignaciones')
        .select('id')
        .eq('rodeo_id', req.params.id);

    // 2. Rechazar bonos pendientes de esas asignaciones
    if (asigs && asigs.length > 0) {
        const asigIds = asigs.map(a => a.id);
        await supabase
            .from('bonos_solicitados')
            .update({ estado: 'rechazado', updated_at: ahora })
            .in('asignacion_id', asigIds)
            .eq('estado', 'pendiente');
    }

    // 3. Anular asignaciones
    await supabase
        .from('asignaciones')
        .update({ estado: 'anulado', updated_at: ahora })
        .eq('rodeo_id', req.params.id);

    // 4. Anular rodeo
    await supabase
        .from('rodeos')
        .update({ estado: 'anulado', updated_at: ahora })
        .eq('id', req.params.id);

    await auditoria.registrar({
        tabla: 'rodeos',
        registro_id: req.params.id,
        accion: 'eliminar',
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Rodeo eliminado: ${r.club} - ${r.fecha} (${asigs?.length || 0} asignaciones anuladas)`,
        ip_address: req.ip
    });

    res.json({ mensaje: 'Rodeo eliminado correctamente junto con sus asignaciones y bonos pendientes' });
});

// ─────────────────────────────────────────────
// TIPOS DE RODEO
// ─────────────────────────────────────────────

// GET /api/admin/rodeos/tipos/lista
router.get('/tipos/lista', async (req, res) => {
    const { activo } = req.query;
    let query = supabase
        .from('tipos_rodeo')
        .select('*')
        .order('nombre', { ascending: true });

    if (activo !== undefined) query = query.eq('activo', activo === 'true');

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// POST /api/admin/rodeos/tipos
router.post('/tipos', async (req, res) => {
    const { nombre, duracion_dias, observacion, categoria_rodeo_id } = req.body;

    if (!nombre || !duracion_dias) {
        return res.status(400).json({ error: 'nombre y duracion_dias son requeridos' });
    }
    if (duracion_dias < 1 || duracion_dias > 5) {
        return res.status(400).json({ error: 'La duración debe ser entre 1 y 5 días' });
    }

    const { data, error } = await supabase
        .from('tipos_rodeo')
        .insert({
            nombre: nombre.trim(),
            duracion_dias: parseInt(duracion_dias),
            observacion,
            categoria_rodeo_id: categoria_rodeo_id || null
        })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});

// PATCH /api/admin/rodeos/tipos/:id
router.patch('/tipos/:id', async (req, res) => {
    const { nombre, duracion_dias, observacion, activo, categoria_rodeo_id } = req.body;
    const cambios = { updated_at: new Date().toISOString() };

    if (nombre) cambios.nombre = nombre.trim();
    if (duracion_dias) cambios.duracion_dias = parseInt(duracion_dias);
    if (observacion !== undefined) cambios.observacion = observacion;
    if (activo !== undefined) cambios.activo = !!activo;
    if (categoria_rodeo_id !== undefined) cambios.categoria_rodeo_id = categoria_rodeo_id || null;

    const { data, error } = await supabase
        .from('tipos_rodeo')
        .update(cambios)
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// DELETE /api/admin/rodeos/tipos/:id
router.delete('/tipos/:id', async (req, res) => {
    const { count } = await supabase
        .from('rodeos')
        .select('id', { count: 'exact', head: true })
        .eq('tipo_rodeo_id', req.params.id);

    if (count > 0) {
        return res.status(400).json({
            error: `No se puede eliminar: hay ${count} rodeo(s) con este tipo. Desactívelo en su lugar.`
        });
    }

    await supabase.from('tipos_rodeo').delete().eq('id', req.params.id);
    res.json({ mensaje: 'Tipo de rodeo eliminado' });
});

module.exports = router;
