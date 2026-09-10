// ═════════════════════════════════════════════════════════════════════════
// rodeosListado.js — fuente ÚNICA de la lógica de filtrado de "Rodeos".
//
// Corrección del bug "Exportar no respeta los filtros" (Administrador >
// Rodeos): antes de este archivo, GET /admin/rodeos (la tabla) y
// GET /admin/exportacion/rodeos (el botón "Exportar") tenían DOS
// implementaciones de filtrado completamente independientes — la ruta de
// listado soportaba 18 filtros avanzados (mes, año, buscar, categoría,
// tipo, asociación, club, jurado, delegado, fecha_desde/hasta, estado
// jurado/delegado, cartillas, video, origen, temporada); la exportación
// solo leía año/mes/buscar e ignoraba el resto en silencio. Resultado: el
// Excel descargado nunca coincidía con lo que la pantalla mostraba.
//
// Fix de raíz (no un parche de fechas): se extrae TODA la lógica de
// filtrado (antes duplicada solo parcialmente en la exportación) a este
// módulo, y tanto la ruta de listado como la exportación la llaman
// EXACTAMENTE igual — un único lugar decide "qué rodeos corresponden a
// estos filtros", nunca dos que puedan desincronizarse de nuevo.
// ═════════════════════════════════════════════════════════════════════════
const supabase = require('../config/supabase');
const { resolverFiltroTemporadaRodeos } = require('./temporadas');

// ─── Helper: intersectar arrays de IDs para filtros complejos ─────────────
function intersectIds(current, newIds) {
    const s = new Set(newIds);
    if (current === null) return [...s];
    return current.filter(id => s.has(id));
}

// ─── Filtros que requieren pre-queries antes de tocar `rodeos` ────────────
// (jurado/delegado asignado, estado de respuesta, cartillas, video).
// @returns { incluir: string[]|null, excluir: string[] } — incluir=null
// significa "sin restricción por estos filtros".
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

// ─── Pre-query de "buscar": nombre_importado en asignaciones + nombre_
// completo en usuarios_pagados → ids de rodeo cuyo jurado/delegado calza,
// para incluirlos en el OR de club/asociación de la búsqueda libre. ───────
async function resolverBusquedaJuradoIds(buscar) {
    if (!buscar) return [];
    const { data: byImp } = await supabase
        .from('asignaciones').select('rodeo_id')
        .eq('estado', 'activo').ilike('nombre_importado', `%${buscar}%`);

    const { data: usuariosMatch } = await supabase
        .from('usuarios_pagados').select('id').ilike('nombre_completo', `%${buscar}%`);

    const idSet = new Set((byImp || []).map(a => a.rodeo_id));
    if (usuariosMatch && usuariosMatch.length > 0) {
        const uids = usuariosMatch.map(u => u.id);
        const { data: byUser } = await supabase
            .from('asignaciones').select('rodeo_id')
            .eq('estado', 'activo').in('usuario_pagado_id', uids);
        (byUser || []).forEach(a => idSet.add(a.rodeo_id));
    }
    return [...idSet];
}

// ─── Construye el query de `rodeos` con TODOS los filtros avanzados ya
// aplicados (todo menos paginación) — misma lógica exacta para listado y
// exportación. `selectClause` es lo único que puede variar entre ambos
// consumidores (la tabla necesita joins para mostrar comuna/temporada/
// categoría heredada; la exportación solo necesita columnas planas).
// @returns { query, vacioPorFiltro } — si vacioPorFiltro=true, ya se sabe
// que 0 rodeos corresponden (un filtro complejo no calzó con nada) y NO
// debe ejecutarse ningún query adicional.
async function construirQueryRodeosFiltrada(q, selectClause) {
    const { incluir, excluir } = await resolverFiltrosComplejos(q);
    if (Array.isArray(incluir) && incluir.length === 0) {
        return { query: null, vacioPorFiltro: true };
    }

    const buscarRodeoIds = await resolverBusquedaJuradoIds(q.buscar);

    let query = supabase
        .from('rodeos')
        .select(selectClause, { count: 'exact' })
        .order('fecha', { ascending: false });

    if (q.estado) query = query.eq('estado', q.estado);
    else          query = query.eq('estado', 'activo');

    if (q.categoria_rodeo_id) {
        // Categoría directa en el rodeo OR heredada desde tipos_rodeo.
        const { data: tiposConCat } = await supabase
            .from('tipos_rodeo').select('id').eq('categoria_rodeo_id', q.categoria_rodeo_id);
        const tipoIds = (tiposConCat || []).map(t => t.id);
        if (tipoIds.length > 0) {
            query = query.or(
                `categoria_rodeo_id.eq.${q.categoria_rodeo_id},and(categoria_rodeo_id.is.null,tipo_rodeo_id.in.(${tipoIds.join(',')}))`
            );
        } else {
            query = query.eq('categoria_rodeo_id', q.categoria_rodeo_id);
        }
    }
    if (q.tipo_rodeo_id || q.tipo) query = query.eq('tipo_rodeo_id', q.tipo_rodeo_id || q.tipo);
    if (q.origen) query = query.eq('origen', q.origen);
    if (q.buscar) {
        const orBase = `club.ilike.%${q.buscar}%,asociacion.ilike.%${q.buscar}%`;
        query = buscarRodeoIds.length > 0
            ? query.or(`${orBase},id.in.(${buscarRodeoIds.join(',')})`)
            : query.or(orBase);
    }
    if (q.club && !q.buscar)       query = query.ilike('club', `%${q.club}%`);
    if (q.asociacion && !q.buscar) query = query.ilike('asociacion', `%${q.asociacion}%`);

    const filtroTemporada = resolverFiltroTemporadaRodeos(q.temporada);
    if (filtroTemporada.tipo === 'sin_temporada') query = query.is('temporada_id', null);
    else if (filtroTemporada.tipo === 'especifica') query = query.eq('temporada_id', filtroTemporada.valor);

    // Fechas — límites INCLUSIVOS (gte/lte), sobre una columna DATE (no
    // timestamptz): la comparación es string-a-string contra YYYY-MM-DD, sin
    // ninguna conversión de zona horaria de por medio (mismo formato que ya
    // entrega <input type="date"> del frontend) — así se evita el clásico
    // error de "un día de diferencia" de convertir a Date()/toISOString().
    if (q.fecha_desde) query = query.gte('fecha', q.fecha_desde);
    if (q.fecha_hasta) query = query.lte('fecha', q.fecha_hasta);

    if (!q.fecha_desde && !q.fecha_hasta) {
        const añoNum = parseInt(q.año), mesNum = parseInt(q.mes);
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

    return { query, vacioPorFiltro: false };
}

// ─── Texto legible de "Estado designación" para UN jurado/delegado ────────
// Fuente de verdad: DOS columnas YA existentes en `asignaciones`, conceptos
// distintos (ver migración 043): `publicado` (¿el jurado ya puede verla?) y
// `estado_designacion` (su respuesta: 'pendiente'|'aceptado'|'rechazado'|
// NULL=legacy=aceptado). NUNCA se inventa un estado nuevo — mismo criterio
// acept/rech/pend que ya usa GET /admin/rodeos para los indicadores ●.
function textoEstadoDesignacion(publicado, estadoDesignacion) {
    if (!publicado) return 'No publicado';
    if (estadoDesignacion === 'rechazado') return 'Rechazado';
    if (estadoDesignacion === 'pendiente') return 'Pendiente';
    return 'Confirmado'; // 'aceptado' o NULL (legacy = aceptado)
}

// ─── Stats de asignaciones por rodeo (jurados/delegado, publicación, ──────
// estado de respuesta) — MISMA consulta y agregación que ya usaba GET
// /admin/rodeos, movida acá para que la exportación la reutilice sin
// duplicarla. Único cambio: cada entrada de `jurados_lista` ahora trae
// también `estado_designacion_texto` (campo ADITIVO — no rompe a quien ya
// consumía `{id, nombre}` desde el frontend).
// @returns Map rodeo_id -> stats (mismo shape que antes + el campo nuevo)
async function cargarStatsAsignacionesPorRodeo(rodeoIds) {
    const emptyStats = () => ({
        total_asignaciones: 0, jurados: 0, delegados: 0, total_pago_base: 0,
        j_acept: 0, j_rech: 0, j_pend: 0,
        d_acept: 0, d_rech: 0, d_pend: 0,
        jurados_nombres: [],
        jurados_lista: [], // [{id, nombre, estado_designacion_texto}]
        delegado_nombre: null,
        pendientes_publicacion: 0
    });
    if (!rodeoIds || rodeoIds.length === 0) return {};

    const { data: asigs } = await supabase
        .from('asignaciones')
        .select('rodeo_id, usuario_pagado_id, tipo_persona, pago_base_calculado, estado_designacion, nombre_importado, publicado, usuarios_pagados(nombre_completo)')
        .in('rodeo_id', rodeoIds).eq('estado', 'activo')
        .order('created_at', { ascending: true }); // orden estable (Jurado/Estado quedan alineados posicionalmente)

    // Se pre-llena UNA entrada por cada rodeo pedido (incluso sin ninguna
    // asignación) — así quien llama nunca necesita su propio fallback
    // emptyStats() por separado (fuente única también para "sin jurado").
    const sp = {};
    rodeoIds.forEach(id => { sp[id] = emptyStats(); });
    (asigs || []).forEach(a => {
        if (!sp[a.rodeo_id]) sp[a.rodeo_id] = emptyStats();
        const s = sp[a.rodeo_id];
        s.total_asignaciones++;
        s.total_pago_base += (a.pago_base_calculado || 0);
        if (!a.publicado) s.pendientes_publicacion++;
        const ed = a.estado_designacion;
        const acept = ed === 'aceptado' || ed === null; // null = legacy = aceptado
        const rech  = ed === 'rechazado';
        const nombre = a.usuarios_pagados?.nombre_completo || a.nombre_importado || null;
        if (a.tipo_persona === 'jurado') {
            s.jurados++;
            if (rech) s.j_rech++; else if (acept) s.j_acept++; else s.j_pend++;
            if (nombre) {
                s.jurados_nombres.push(nombre);
                s.jurados_lista.push({
                    id: a.usuario_pagado_id || null, nombre,
                    estado_designacion_texto: textoEstadoDesignacion(a.publicado, ed)
                });
            }
        } else {
            s.delegados++;
            if (rech) s.d_rech++; else if (acept) s.d_acept++; else s.d_pend++;
            if (nombre && !s.delegado_nombre) s.delegado_nombre = nombre;
        }
    });
    return sp;
}

module.exports = {
    resolverFiltrosComplejos,
    resolverBusquedaJuradoIds,
    construirQueryRodeosFiltrada,
    textoEstadoDesignacion,
    cargarStatsAsignacionesPorRodeo
};
