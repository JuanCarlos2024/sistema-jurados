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
            cartilla_jurado, cartilla_delegado, video,
            cartilla_jurado_estado, cartilla_delegado_estado, modalidad_delegado,
            designacion_estado,
            nota_comision_estado, nota_comision_min, nota_comision_max,
            nota_delegado_estado, nota_delegado_min, nota_delegado_max,
            nota_area_deportiva_estado, nota_area_deportiva_min, nota_area_deportiva_max,
            gestion_general } = q;

    const ninguno = !jurado_id && !delegado_id && !estado_jurado &&
                    !estado_delegado && !cartilla_jurado && !cartilla_delegado && !video &&
                    !cartilla_jurado_estado && !cartilla_delegado_estado && !modalidad_delegado &&
                    !designacion_estado &&
                    !nota_comision_estado && !nota_comision_min && !nota_comision_max &&
                    !nota_delegado_estado && !nota_delegado_min && !nota_delegado_max &&
                    !nota_area_deportiva_estado && !nota_area_deportiva_min && !nota_area_deportiva_max &&
                    !gestion_general;
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
    if (cartilla_jurado || q.cartilla_jurado_estado) {
        const unif = await cargarEstadoCartillaJuradoUnificadoPorRodeo();
        if (cartilla_jurado) {
            const ids = Object.keys(unif).filter(id => unif[id].recibida);
            if (cartilla_jurado === 'con') incluir = intersectIds(incluir, ids);
            else ids.forEach(id => excluirSet.add(id));
        }
        if (q.cartilla_jurado_estado === 'reabierta') {
            const ids = Object.keys(unif).filter(id => unif[id].requiere_correccion);
            incluir = intersectIds(incluir, ids);
        }
    }
    if (cartilla_delegado || q.cartilla_delegado_estado || q.modalidad_delegado) {
        const unif = await cargarEstadoCartillaDelegadoUnificadoPorRodeo();
        if (cartilla_delegado) {
            const ids = Object.keys(unif).filter(id => unif[id].recibida);
            if (cartilla_delegado === 'con') incluir = intersectIds(incluir, ids);
            else ids.forEach(id => excluirSet.add(id));
        }
        if (q.cartilla_delegado_estado) {
            const valor = q.cartilla_delegado_estado;
            // 'sin_iniciar' no es una clave presente en el mapa (sparse — solo
            // contiene rodeos con AL MENOS una fuente de datos, digital o
            // adjunto) — se obtiene por EXCLUSIÓN de todo lo demás, nunca
            // enumerando directamente (evitaría tener que cargar TODOS los
            // rodeos del sistema solo para este filtro).
            if (valor === 'sin_iniciar') {
                Object.keys(unif).forEach(id => excluirSet.add(id));
            } else if (valor === 'pendiente_correccion') {
                incluir = intersectIds(incluir, Object.keys(unif).filter(id => unif[id].requiere_correccion));
            } else {
                incluir = intersectIds(incluir, Object.keys(unif).filter(id => unif[id].estado === valor));
            }
        }
        if (q.modalidad_delegado && q.modalidad_delegado !== 'ambas') {
            const ids = Object.keys(unif).filter(id => unif[id].modalidad === q.modalidad_delegado);
            incluir = intersectIds(incluir, ids);
        }
    }
    if (video) {
        const { data } = await supabase.from('rodeo_links').select('rodeo_id');
        const ids = [...new Set((data||[]).map(r => r.rodeo_id))];
        if (video === 'con') incluir = intersectIds(incluir, ids);
        else ids.forEach(id => excluirSet.add(id));
    }
    // ─── Designaciones (Panel de Gestión Deportiva) — filtro combinado sobre
    // TODAS las asignaciones activas (jurado + delegado), a diferencia de
    // estado_jurado/estado_delegado (arriba) que siguen existiendo separados
    // por rol para quien ya los usa. 'pendientes_publicacion' es una
    // dimensión DISTINTA de estado_designacion (puede estar 'pendiente' de
    // respuesta y a la vez ya publicada, o viceversa) — never combinados en
    // una sola condición.
    if (designacion_estado) {
        const { data } = await supabase.from('asignaciones')
            .select('rodeo_id, publicado, estado_designacion').eq('estado', 'activo');
        const idsSet = new Set();
        (data || []).forEach(a => {
            let match = false;
            if (designacion_estado === 'pendientes_publicacion') match = !a.publicado;
            else if (designacion_estado === 'sin_respuesta')      match = a.estado_designacion === 'pendiente';
            else if (designacion_estado === 'aceptadas')          match = a.estado_designacion === 'aceptado' || a.estado_designacion === null;
            else if (designacion_estado === 'rechazadas')         match = a.estado_designacion === 'rechazado';
            if (match) idsSet.add(a.rodeo_id);
        });
        incluir = intersectIds(incluir, [...idsSet]);
    }
    // ─── Notas (Comisión/Delegado — consolidadas por rodeo, rodeo_notas_
    // secundarias) — 'sin' se resuelve por EXCLUSIÓN (misma razón que
    // 'sin_iniciar' arriba: la tabla es sparse, un rodeo sin nota nunca tiene
    // fila y por lo tanto nunca puede "incluirse" enumerando). ─────────────
    if (nota_comision_estado || nota_comision_min || nota_comision_max ||
        nota_delegado_estado || nota_delegado_min || nota_delegado_max) {
        const { data } = await supabase.from('rodeo_notas_secundarias')
            .select('rodeo_id, nota_comision, nota_delegado');
        const rows = data || [];
        const aplicarNota = (campo, estadoParam, minParam, maxParam) => {
            if (!estadoParam && !minParam && !maxParam) return;
            if (estadoParam === 'sin') {
                rows.filter(r => r[campo] !== null && r[campo] !== undefined)
                    .forEach(r => excluirSet.add(r.rodeo_id));
                return;
            }
            const ids = rows.filter(r => {
                const v = r[campo];
                if (v === null || v === undefined) return false;
                if (estadoParam === 'con') return true;
                if (minParam && v < parseFloat(minParam)) return false;
                if (maxParam && v > parseFloat(maxParam)) return false;
                return true;
            }).map(r => r.rodeo_id);
            incluir = intersectIds(incluir, ids);
        };
        aplicarNota('nota_comision', nota_comision_estado, nota_comision_min, nota_comision_max);
        aplicarNota('nota_delegado', nota_delegado_estado, nota_delegado_min, nota_delegado_max);
    }
    // ─── Nota Área Deportiva — grano POR JURADO (notas_rodeo.nota vía
    // asignacion_id, fuente='evaluacion_tecnica' exclusivamente, MISMO
    // criterio que evaluacionDesempenoJurados.js — nunca fuente='manual').
    // "con"/rango = existe AL MENOS UN jurado del rodeo que la cumple.
    if (nota_area_deportiva_estado || nota_area_deportiva_min || nota_area_deportiva_max) {
        const { data: notasAD } = await supabase.from('notas_rodeo')
            .select('asignacion_id, nota').eq('fuente', 'evaluacion_tecnica');
        const asigIds = [...new Set((notasAD || []).map(n => n.asignacion_id))];
        let asigToRodeo = {};
        if (asigIds.length > 0) {
            const { data: asigs } = await supabase.from('asignaciones').select('id, rodeo_id').in('id', asigIds);
            (asigs || []).forEach(a => { asigToRodeo[a.id] = a.rodeo_id; });
        }
        const conIds = new Set(), matchIds = new Set();
        (notasAD || []).forEach(n => {
            const rodeoId = asigToRodeo[n.asignacion_id];
            if (!rodeoId) return;
            conIds.add(rodeoId);
            const v = parseFloat(n.nota);
            if (nota_area_deportiva_min && v < parseFloat(nota_area_deportiva_min)) return;
            if (nota_area_deportiva_max && v > parseFloat(nota_area_deportiva_max)) return;
            matchIds.add(rodeoId);
        });
        if (nota_area_deportiva_estado === 'sin') conIds.forEach(id => excluirSet.add(id));
        else if (nota_area_deportiva_estado === 'con') incluir = intersectIds(incluir, [...conIds]);
        else incluir = intersectIds(incluir, [...matchIds]);
    }
    // ─── Gestión general — meta-filtro derivado de TODOS los pendientes
    // reales (Prioridad 5), nunca una condición nueva/paralela — delega en
    // calcularPendientesPorRodeo() GLOBAL (mismo criterio "sparse + exclusión"
    // de todo este bloque: 'completos' se resuelve excluyendo los que SÍ
    // tienen pendientes, nunca enumerando "todos los rodeos sin pendientes").
    if (gestion_general && gestion_general !== 'todos') {
        const pendMap = await calcularPendientesPorRodeo();
        const idsConPendientes = Object.keys(pendMap).filter(id => pendMap[id].tiene_pendientes);
        if (gestion_general === 'con_pendientes') incluir = intersectIds(incluir, idsConPendientes);
        else if (gestion_general === 'completos') idsConPendientes.forEach(id => excluirSet.add(id));
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

// ─── Universo COMPLETO de ids filtrados, sin depender del tope de 1000 ────
// filas por página que aplica Supabase/PostgREST cuando no se pide un rango
// explícito (cierre Panel de Gestión Deportiva: los contadores y el orden
// "Priorizar pendientes" deben reflejar TODOS los rodeos que coinciden con
// los filtros, nunca un recorte fijo). Pagina en bloques de 1000 — igual
// patrón ya usado por _historialYDesignaciones (rodeos.js): reconstruye la
// query filtrada en cada vuelta en vez de reutilizar el mismo builder ya
// ejecutado, para no depender de que un PostgrestFilterBuilder admita
// re-ejecutarse tras cambiar `.range()`.
const TAM_PAGINA_IDS = 1000;
async function obtenerTodosLosIdsFiltrados(q) {
    let ids = [];
    let offset = 0;
    while (true) {
        const { query, vacioPorFiltro } = await construirQueryRodeosFiltrada(q, 'id');
        if (vacioPorFiltro) return { ids: [], vacioPorFiltro: true };
        const { data, error } = await query.range(offset, offset + TAM_PAGINA_IDS - 1);
        if (error) throw new Error(error.message);
        const pagina = data || [];
        ids = ids.concat(pagina.map(r => r.id));
        if (pagina.length < TAM_PAGINA_IDS) break;
        offset += TAM_PAGINA_IDS;
    }
    return { ids, vacioPorFiltro: false };
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

// ─── Indicadores de adjuntos (Cartilla Jurado / Cartilla Delegado / Video) —
// MOVIDA acá desde GET /admin/adjuntos/resumen (routes/admin/adjuntos.js),
// que sigue existiendo y ahora delega en esta misma función — fuente única,
// usada por el indicador "CJ/CD/VY" de la tabla de Rodeos Y por la
// exportación a Excel (columnas Cartilla Jurado/Cartilla Delegado/Video).
// Condición EXACTA, sin cambios: CJ = existe rodeo_adjuntos con
// tipo_adjunto IN ('cartilla_jurado','cartilla' [legacy]); CD = existe
// rodeo_adjuntos con tipo_adjunto='cartilla_delegado'; Video = existe
// CUALQUIER fila en rodeo_links para ese rodeo.
// Auditoría (077): `cd` se mantiene EXACTAMENTE igual ("¿existe algún archivo
// tipo_adjunto='cartilla_delegado'?") para no romper el filtro existente ni
// la exportación a Excel (ambos siguen leyendo solo `cd`). Se agrega
// `cd_estado` (no reemplaza nada) para que la tabla principal del
// Administrador pueda distinguir, con un simple tooltip, entre una versión
// oficial confirmada ('vigente'), un archivo histórico aún sin clasificar
// ('pendiente') y archivos que son EXCLUSIVAMENTE documentos complementarios
// ('complementario', confirmados explícitamente — nunca bloquean ni
// cuentan como la cartilla real, pero sí hacen que `cd` sea true).
// Prioridad al combinar varias filas del mismo rodeo: vigente > pendiente >
// complementario.
// Mejoras en Detalle de Rodeos (ítem 3): además del documento adjunto, el
// administrador necesita saber si existe una Cartilla de Delegado DIGITAL
// (tabla `cartillas_delegado`, migraciones 037/065) y de qué modalidad es —
// Delegado Rentado (`delegado_id`) o Delegado de Asociación
// (`delegado_asociacion_id`, mutuamente excluyentes por CHECK). Esto es
// PURAMENTE informativo y ADITIVO (`cd_digital`): `cd`/`cd_estado` (arriba)
// siguen significando exactamente lo mismo de siempre — "¿hay un archivo
// rodeo_adjuntos tipo_adjunto='cartilla_delegado'?" — y el filtro CJ/CD de
// la pantalla y la exportación a Excel siguen leyendo solo esos dos campos,
// sin ningún cambio de semántica.
// Prioridad al combinar varias filas del mismo rodeo (puede haber más de un
// delegado histórico, p.ej. tras un cambio de designación): se muestra
// siempre el estado más avanzado — aprobada > cerrada > reenviada > enviada
// > observada > borrador — nunca se informa "enviada" si en realidad la
// única fila existente sigue en borrador.
// @returns Map rodeo_id -> { cj, cd, vy, cd_estado, cd_digital: {modalidad:'delegado_rentado'|'delegado_asociacion', estado}|null }
async function cargarIndicadoresAdjuntosPorRodeo(rodeoIds) {
    if (!rodeoIds || rodeoIds.length === 0) return {};

    const [adjRes, linkRes, cdDigitalRes] = await Promise.all([
        supabase.from('rodeo_adjuntos').select('rodeo_id, tipo_adjunto, cartilla_clasificacion').in('rodeo_id', rodeoIds),
        supabase.from('rodeo_links').select('rodeo_id').in('rodeo_id', rodeoIds),
        supabase.from('cartillas_delegado').select('rodeo_id, estado, delegado_asociacion_id').in('rodeo_id', rodeoIds)
    ]);

    const result = {};
    rodeoIds.forEach(id => { result[id] = { cj: false, cd: false, vy: false, cd_estado: null, cd_digital: null }; });

    const PRIORIDAD = { vigente: 3, pendiente: 2, complementario: 1 };
    (adjRes.data || []).forEach(a => {
        if (!result[a.rodeo_id]) return;
        if (['cartilla_jurado', 'cartilla'].includes(a.tipo_adjunto)) result[a.rodeo_id].cj = true;
        if (a.tipo_adjunto === 'cartilla_delegado') {
            result[a.rodeo_id].cd = true;
            // cartilla_clasificacion solo existe desde la migración 077 —
            // si todavía no se aplicó, viene undefined y simplemente no se
            // fija ningún cd_estado (cd sigue funcionando igual que siempre).
            const estado = a.cartilla_clasificacion === 'version_cartilla' ? 'vigente' : a.cartilla_clasificacion;
            if (estado && (PRIORIDAD[estado] || 0) > (PRIORIDAD[result[a.rodeo_id].cd_estado] || 0)) {
                result[a.rodeo_id].cd_estado = estado;
            }
        }
    });
    (linkRes.data || []).forEach(l => {
        if (result[l.rodeo_id]) result[l.rodeo_id].vy = true;
    });

    // 092: 'reabierta' se agrega en el mismo nivel que 'observada' — ambos
    // representan "pendiente de corrección del delegado", solo que con
    // origen distinto (Observar vs Reabrir). Nunca debe mostrarse 'enviada'
    // (prioridad 3) cuando en realidad el administrador la reabrió para
    // que se corrija — mismo criterio de "mostrar siempre el estado más
    // avanzado" ya documentado en este mapa.
    const PRIORIDAD_DIGITAL = { aprobada: 6, cerrada: 5, reenviada: 4, enviada: 3, observada: 2, reabierta: 2, borrador: 1 };
    (cdDigitalRes.data || []).forEach(c => {
        if (!result[c.rodeo_id]) return;
        const actual = result[c.rodeo_id].cd_digital;
        if (!actual || (PRIORIDAD_DIGITAL[c.estado] || 0) > (PRIORIDAD_DIGITAL[actual.estado] || 0)) {
            result[c.rodeo_id].cd_digital = {
                modalidad: c.delegado_asociacion_id ? 'delegado_asociacion' : 'delegado_rentado',
                estado: c.estado
            };
        }
    });

    return result;
}

// ─── Cartilla única por rodeo, con versiones y clasificación en tres
// estados (076, endurecida en 077): a diferencia del indicador "CD" de
// arriba (uso administrativo — "¿hay algún archivo de este tipo?", sigue
// contando cualquier fila tipo_adjunto='cartilla_delegado' sin cambios,
// para no alterar el triage del administrador ni la exportación a Excel),
// ESTA función responde la pregunta que SÍ debe bloquear la creación de una
// cartilla digital institucional: ¿existe alguna fila confirmada como
// 'version_cartilla' (oficial — SIN exigir además cartilla_vigente=true:
// auditoría 077 — si la vigente desapareciera por cualquier motivo pero
// sigue existiendo una versión oficial histórica, el rodeo debe seguir
// bloqueado, nunca depender solo de ese booleano), O algún archivo
// histórico todavía SIN CLASIFICAR ("pendiente" — el DEFAULT real para los
// 180 archivos ya existentes en producción, nunca inferido de un NULL)?
// Solo un archivo confirmado EXPLÍCITAMENTE como "complementario" (informe
// médico/paramédico/disciplinario, etc. — hallazgo real: CHACAICO/BÍO-BÍO)
// nunca cuenta acá.
// @returns Map rodeo_id -> 'vigente' | 'pendiente' | null
async function cargarEstadoCartillaDelegadoAdjuntaPorRodeo(rodeoIds) {
    if (!rodeoIds || rodeoIds.length === 0) return {};

    const { data, error } = await supabase
        .from('rodeo_adjuntos')
        .select('rodeo_id, cartilla_clasificacion')
        .in('rodeo_id', rodeoIds)
        .eq('tipo_adjunto', 'cartilla_delegado');
    if (error) throw new Error(error.message);

    const result = {};
    rodeoIds.forEach(id => { result[id] = null; });
    (data || []).forEach(a => {
        if (!(a.rodeo_id in result)) return;
        if (a.cartilla_clasificacion === 'version_cartilla') {
            result[a.rodeo_id] = 'vigente';
        } else if (a.cartilla_clasificacion === 'pendiente' && result[a.rodeo_id] !== 'vigente') {
            result[a.rodeo_id] = 'pendiente';
        }
    });
    return result;
}

// ─── Notas por rodeo (Nota Comisión / Nota Delegado / Nota Final) — usada
// por la exportación a Excel de Rodeos. MISMA fuente exacta que ya usa el
// resto del sistema, sin recalcular ni derivar nada nuevo:
//   - Nota Comisión / Nota Delegado: tabla `rodeo_notas_secundarias`
//     (columnas nota_comision/nota_delegado, NUMERIC(3,1), 1 fila por
//     rodeo — rodeo_id UNIQUE, migración 028) — misma tabla/columnas que
//     lee/escribe GET|PUT /admin/rodeos/:id/notas-secundarias (sección
//     "Notas secundarias" de la pantalla de edición del rodeo).
//   - Nota Final: columna `evaluaciones.nota_final` (NUMERIC(4,2)) — YA
//     CALCULADA Y PERSISTIDA por la RPC de finalización de evaluación
//     (migraciones 019/021/031); acá solo se LEE, nunca se recalcula.
//     Mismo filtro `anulada = false` que ya usan GET /admin/rodeos/:id
//     (detalle del rodeo) y GET /admin/evaluaciones (listado del módulo
//     de evaluaciones) — una evaluación anulada nunca aporta su nota_final
//     como "la" nota del rodeo, igual que en esas dos pantallas.
//     `evaluaciones.rodeo_id` es UNIQUE (migración 019) — a lo sumo 1
//     evaluación por rodeo, sin ambigüedad posible al construir el mapa.
// NULL/ausencia de fila = nota inexistente ("Pendiente" es responsabilidad
// de quien consume este mapa, nunca de esta función — acá se devuelve el
// valor crudo, incluyendo `null` explícito, para no perder la distinción
// entre "0 numérico" (técnicamente imposible por los CHECK de rango, pero
// nunca se asume) y "no existe todavía").
// @returns Map rodeo_id -> { nota_comision: number|null, nota_delegado: number|null, nota_final: number|null }
async function cargarNotasPorRodeo(rodeoIds) {
    if (!rodeoIds || rodeoIds.length === 0) return {};

    const [{ data: notasSec }, { data: evals }] = await Promise.all([
        supabase.from('rodeo_notas_secundarias').select('rodeo_id, nota_comision, nota_delegado').in('rodeo_id', rodeoIds),
        supabase.from('evaluaciones').select('rodeo_id, nota_final').in('rodeo_id', rodeoIds).eq('anulada', false)
    ]);

    const result = {};
    rodeoIds.forEach(id => { result[id] = { nota_comision: null, nota_delegado: null, nota_final: null }; });

    (notasSec || []).forEach(n => {
        if (!result[n.rodeo_id]) return;
        result[n.rodeo_id].nota_comision = n.nota_comision ?? null;
        result[n.rodeo_id].nota_delegado = n.nota_delegado ?? null;
    });
    (evals || []).forEach(e => {
        if (result[e.rodeo_id]) result[e.rodeo_id].nota_final = e.nota_final ?? null;
    });

    return result;
}

// ═════════════════════════════════════════════════════════════════════════
// PANEL CENTRAL DE GESTIÓN DEPORTIVA — Prioridad 1: fuente ÚNICA del estado
// real de Cartilla Delegado/Jurado, reemplazando el chequeo anterior que
// solo miraba `rodeo_adjuntos` (bug: ignoraba por completo las cartillas
// digitales en `cartillas_delegado`/`cartillas_jurado`). Reutilizada por el
// filtro simple con/sin (arriba), el filtro detallado por estado, la tabla
// principal, la exportación a Excel y los contadores de pendientes — nunca
// una lógica paralela (Prioridad 6).
//
// Todas las funciones de esta sección aceptan `rodeoIds` OPCIONAL: un array
// conocido (tabla/exportación, que ya saben qué rodeos les interesan) o
// `null`/omitido (filtros — necesitan resolver qué rodeos califican ANTES de
// poder enumerarlos, mismo patrón ya usado arriba en resolverFiltrosComplejos
// para jurado_id/estado_jurado/video: una consulta SIN `.in('rodeo_id', ...)`
// sobre toda la tabla relevante, exactamente como ya hacía este archivo).
// ═════════════════════════════════════════════════════════════════════════

// ─── Delegado Rentado VIGENTE por rodeo — necesario para no atribuir a un
// rodeo el estado de la cartilla de un delegado YA REEMPLAZADO (hallazgo de
// la auditoría de cierre: `cartillas_delegado` permite una fila por cada
// delegado_id distinto que haya pasado por el rodeo — UNIQUE(rodeo_id,
// delegado_id), nunca UNIQUE(rodeo_id) a solas para esta modalidad — así que
// un delegado reemplazado puede dejar su fila en 'enviada' mientras el
// delegado ACTUAL todavía no inicia la suya). Fuente: `asignaciones`
// activas tipo_persona='delegado_rentado' — en el caso normal hay como
// máximo una (el reemplazo administrativo desactiva la anterior); si por
// algún motivo excepcional coexistieran varias, se prioriza la que no esté
// rechazada y, entre iguales, la más reciente — igual criterio de "estado
// más avanzado/reciente gana" que el resto de este archivo.
// Modalidad Asociación NUNCA pasa por acá: `cartillas_delegado.
// delegado_asociacion_id` tiene como máximo una fila por rodeo por un índice
// único parcial (065) — no existe la ambigüedad que sí existe para Rentado.
// @returns Map rodeo_id -> usuario_pagado_id (delegado vigente) — sparse,
// solo contiene rodeos con al menos una asignación activa de ese tipo.
async function cargarDelegadoRentadoVigentePorRodeo(rodeoIds = null) {
    if (Array.isArray(rodeoIds) && rodeoIds.length === 0) return {};

    let sq = supabase.from('asignaciones')
        .select('rodeo_id, usuario_pagado_id, estado_designacion, created_at')
        .eq('tipo_persona', 'delegado_rentado').eq('estado', 'activo')
        .order('created_at', { ascending: false });
    if (rodeoIds) sq = sq.in('rodeo_id', rodeoIds);
    const { data } = await sq;

    const elegido = {};
    (data || []).forEach(a => {
        const actual = elegido[a.rodeo_id];
        if (!actual) { elegido[a.rodeo_id] = a; return; }
        const rechAct = actual.estado_designacion === 'rechazado';
        const rechNew = a.estado_designacion === 'rechazado';
        if (rechAct && !rechNew) elegido[a.rodeo_id] = a; // el orden descendente ya deja el más reciente por delante
    });

    const result = {};
    Object.keys(elegido).forEach(id => { result[id] = elegido[id].usuario_pagado_id; });
    return result;
}

// ─── Fusión pura (sin I/O): dado el estado digital vigente (o null) y la
// clasificación del adjunto manual/legado (o null), decide el estado único
// a mostrar/filtrar. Comparte esta regla EXACTA tanto el camino "scoped"
// (tabla/exportación) como el "global" (filtros) — nunca dos lógicas de
// prioridad distintas.
// Orden de prioridad:
//   1. Digital en un estado "de recepción" (enviada/reenviada/observada/
//      reabierta/aprobada/cerrada) -> ESE es el estado a mostrar — ya
//      certifica que existió un envío oficial, con o sin corrección
//      pendiente (observada/reabierta NO se excluyen de "recibida": "existió
//      un envío" y "corrección actualmente resuelta" son preguntas
//      distintas — ver `requiere_correccion` para la segunda).
//   2. Si no, adjunto clasificado 'vigente' -> 'adjunta_oficial', recibida.
//   3. Si no, digital en 'borrador' -> 'borrador', NO recibida (regla
//      explícita: un borrador digital nunca cuenta como cartilla oficial).
//   4. Si no, adjunto clasificado 'pendiente' (sin clasificar todavía) ->
//      'adjunta_pendiente', NO recibida.
//   5. Si no, 'sin_iniciar' — ninguna fuente tiene nada para este rodeo.
// 'complementario' nunca aparece aquí como estado propio — por regla
// explícita, un documento complementario nunca certifica la cartilla real
// (si es la ÚNICA fuente, el rodeo cae directo en 'sin_iniciar').
const ESTADOS_RECEPCION_DIGITAL = new Set(['enviada', 'reenviada', 'observada', 'reabierta', 'aprobada', 'cerrada']);
const ESTADOS_CORRECCION_DIGITAL = new Set(['observada', 'reabierta']);

function fusionarEstadoCartillaDelegado(estadoDigital, clasificacionAdjunto) {
    if (estadoDigital && ESTADOS_RECEPCION_DIGITAL.has(estadoDigital)) {
        return { estado: estadoDigital, recibida: true, requiere_correccion: ESTADOS_CORRECCION_DIGITAL.has(estadoDigital) };
    }
    if (clasificacionAdjunto === 'vigente') {
        return { estado: 'adjunta_oficial', recibida: true, requiere_correccion: false };
    }
    if (estadoDigital === 'borrador') {
        return { estado: 'borrador', recibida: false, requiere_correccion: false };
    }
    if (clasificacionAdjunto === 'pendiente') {
        return { estado: 'adjunta_pendiente', recibida: false, requiere_correccion: false };
    }
    return { estado: 'sin_iniciar', recibida: false, requiere_correccion: false };
}

// ─── Estado UNIFICADO de Cartilla Delegado por rodeo (Prioridad 1). Fusiona
// DOS fuentes independientes que JAMÁS se escriben juntas (confirmado por
// auditoría: el flujo digital de cartilla de delegado nunca inserta en
// `rodeo_adjuntos`): la fila digital del delegado VIGENTE (nunca la de un
// delegado ya reemplazado — ver cargarDelegadoRentadoVigentePorRodeo arriba;
// para modalidad Asociación no hay ambigüedad, índice único parcial 065) y
// la clasificación del adjunto manual/legado (cargarIndicadoresAdjuntosPorRodeo,
// que ya resuelve correctamente la prioridad entre varias filas de adjuntos
// del mismo rodeo).
// Sparse en el caso global (rodeoIds=null): solo contiene claves para
// rodeos con al menos una fila en alguna de las dos fuentes — un rodeo
// "sin_iniciar" nunca aparece como clave en ese modo (ver el patrón de
// exclusión ya usado en resolverFiltrosComplejos para resolverlo sin tener
// que enumerar TODOS los rodeos del sistema).
// @returns Map rodeo_id -> { estado, modalidad: 'delegado_rentado'|'delegado_asociacion'|null, recibida, requiere_correccion }
async function cargarEstadoCartillaDelegadoUnificadoPorRodeo(rodeoIds = null) {
    if (Array.isArray(rodeoIds) && rodeoIds.length === 0) return {};

    let dq = supabase.from('cartillas_delegado').select('rodeo_id, estado, delegado_id, delegado_asociacion_id');
    if (rodeoIds) dq = dq.in('rodeo_id', rodeoIds);

    const [{ data: digitalRows }, delegadoVigenteMap] = await Promise.all([
        dq,
        cargarDelegadoRentadoVigentePorRodeo(rodeoIds)
    ]);

    // Clasificación de adjuntos: en modo scoped se reutiliza la función ya
    // existente (fuente única, Prioridad 6); en modo global (filtros) se
    // consulta sin restricción de rodeo_id, igual criterio que el resto de
    // los filtros "globales" de este archivo.
    let adjClasifPorRodeo = {};
    if (rodeoIds) {
        const indic = await cargarIndicadoresAdjuntosPorRodeo(rodeoIds);
        Object.keys(indic).forEach(id => { adjClasifPorRodeo[id] = indic[id].cd_estado; });
    } else {
        const { data: adjRows } = await supabase.from('rodeo_adjuntos')
            .select('rodeo_id, cartilla_clasificacion').eq('tipo_adjunto', 'cartilla_delegado');
        const PRIORIDAD = { vigente: 3, pendiente: 2, complementario: 1 };
        (adjRows || []).forEach(a => {
            const estado = a.cartilla_clasificacion === 'version_cartilla' ? 'vigente' : a.cartilla_clasificacion;
            if (!estado) return;
            if ((PRIORIDAD[estado] || 0) > (PRIORIDAD[adjClasifPorRodeo[a.rodeo_id]] || 0)) {
                adjClasifPorRodeo[a.rodeo_id] = estado;
            }
        });
    }

    // Fila digital VIGENTE por rodeo (descarta la de un delegado rentado ya
    // reemplazado; Asociación no tiene ambigüedad posible).
    const digitalVigentePorRodeo = {};
    (digitalRows || []).forEach(c => {
        if (c.delegado_asociacion_id) {
            digitalVigentePorRodeo[c.rodeo_id] = { estado: c.estado, modalidad: 'delegado_asociacion' };
        } else {
            const vigenteId = delegadoVigenteMap[c.rodeo_id];
            if (vigenteId && c.delegado_id === vigenteId) {
                digitalVigentePorRodeo[c.rodeo_id] = { estado: c.estado, modalidad: 'delegado_rentado' };
            }
            // Si no coincide con el delegado activo, se descarta deliberadamente
            // — nunca se informa el estado de un delegado ya reemplazado.
        }
    });

    const idsRelevantes = rodeoIds
        ? rodeoIds
        : [...new Set([...Object.keys(digitalVigentePorRodeo), ...Object.keys(adjClasifPorRodeo)])];

    const result = {};
    idsRelevantes.forEach(id => {
        const dig = digitalVigentePorRodeo[id];
        const fusion = fusionarEstadoCartillaDelegado(dig?.estado || null, adjClasifPorRodeo[id] || null);
        result[id] = { ...fusion, modalidad: dig?.modalidad || null };
    });
    return result;
}

// ─── Estado UNIFICADO de Cartilla Jurado por rodeo (Prioridad 1). El
// chequeo "con cartilla" de siempre (¿existe rodeo_adjuntos tipo_adjunto=
// 'cartilla_jurado'?) sigue siendo válido tal cual — cada envío/reenvío
// digital (usuario/cartillas.js, POST /:asignacion_id/enviar) inserta su
// propio adjunto en la MISMA operación, así que un adjunto SIEMPRE existe
// si alguna vez se envió. Lo que la fuente de adjuntos sola NO puede decir
// es si la versión ACTUAL (es_actual=true en `cartillas_jurado`) está
// esperando corrección ('reabierta') — eso es lo único que agrega esta
// función, sin cambiar jamás el valor de "con/sin" (Prioridad 1, punto
// final: "distinguir... sin confundir 'existió un envío' con 'corrección
// actualmente resuelta'").
// @returns Map rodeo_id -> { recibida, requiere_correccion } — sparse en
// modo global.
async function cargarEstadoCartillaJuradoUnificadoPorRodeo(rodeoIds = null) {
    if (Array.isArray(rodeoIds) && rodeoIds.length === 0) return {};

    let aq = supabase.from('rodeo_adjuntos').select('rodeo_id').in('tipo_adjunto', ['cartilla_jurado', 'cartilla']);
    let dq = supabase.from('cartillas_jurado').select('rodeo_id, estado').eq('es_actual', true);
    if (rodeoIds) { aq = aq.in('rodeo_id', rodeoIds); dq = dq.in('rodeo_id', rodeoIds); }

    const [{ data: adjData }, { data: digData }] = await Promise.all([aq, dq]);

    const result = {};
    // En modo scoped (rodeoIds conocido) se pre-llena cada id pedido con el
    // default — igual convención que el resto de los loaders "scoped" de
    // este archivo (cargarNotasPorRodeo, cargarIndicadoresAdjuntosPorRodeo).
    // En modo global queda sparse (solo ids con alguna fuente de datos).
    if (rodeoIds) rodeoIds.forEach(id => { result[id] = { recibida: false, requiere_correccion: false }; });
    const marcar = (id) => { if (!result[id]) result[id] = { recibida: false, requiere_correccion: false }; return result[id]; };
    (adjData || []).forEach(a => { marcar(a.rodeo_id).recibida = true; });
    (digData || []).forEach(c => {
        const r = marcar(c.rodeo_id);
        if (c.estado === 'enviada') r.recibida = true;
        if (c.estado === 'reabierta') r.requiere_correccion = true;
    });
    return result;
}

// ─── Nota Área Deportiva por rodeo — grano NATIVO por jurado (notas_rodeo.
// nota vía asignacion_id), MISMA fuente/filtro exactos que el reporte
// Evaluación de Desempeño Jurados (evaluacionDesempenoJurados.js): solo
// fuente='evaluacion_tecnica' certifica una evaluación técnica real. Las
// filas fuente='manual' (valores históricos importados, migración 060) se
// devuelven SEPARADAS en `historicas` — nunca mezcladas en el mismo array,
// para que quien consuma esto pueda rotularlas explícitamente como
// histórico sin presentarlas como una evaluación técnica real. Nunca se usa
// `evaluaciones.nota_final` (concepto distinto — ver cargarNotasPorRodeo).
// @returns Map rodeo_id -> { actuales: [{jurado_nombre, nota}], historicas: [{jurado_nombre, nota}] }
async function cargarNotaAreaDeportivaPorRodeo(rodeoIds) {
    if (!rodeoIds || rodeoIds.length === 0) return {};

    const { data: asigs } = await supabase.from('asignaciones')
        .select('id, rodeo_id, usuario_pagado_id, nombre_importado, usuarios_pagados(nombre_completo)')
        .in('rodeo_id', rodeoIds).eq('tipo_persona', 'jurado').eq('estado', 'activo');

    const result = {};
    rodeoIds.forEach(id => { result[id] = { actuales: [], historicas: [] }; });
    const asigPorId = {};
    (asigs || []).forEach(a => { asigPorId[a.id] = a; });

    const asigIds = (asigs || []).map(a => a.id);
    if (asigIds.length === 0) return result;

    const { data: notas } = await supabase.from('notas_rodeo')
        .select('asignacion_id, nota, fuente').in('asignacion_id', asigIds);

    (notas || []).forEach(n => {
        const asig = asigPorId[n.asignacion_id];
        if (!asig || !result[asig.rodeo_id]) return;
        const nombre = asig.usuarios_pagados?.nombre_completo || asig.nombre_importado || null;
        const entrada = { jurado_nombre: nombre, nota: parseFloat(n.nota) };
        if (n.fuente === 'evaluacion_tecnica') result[asig.rodeo_id].actuales.push(entrada);
        else if (n.fuente === 'manual') result[asig.rodeo_id].historicas.push(entrada);
    });
    return result;
}

// ─── Pendientes por rodeo (Prioridad 2/5) — agrega TODAS las señales de
// "falta algo" en un solo lugar, reutilizando exclusivamente fuentes ya
// existentes (nunca una condición nueva/paralela — Prioridad 6):
//   · designacion_no_publicada   <- cargarStatsAsignacionesPorRodeo (pendientes_publicacion)
//   · jurado_sin_responder       <- cargarStatsAsignacionesPorRodeo (j_pend)
//   · cartilla_jurado_pendiente  <- cargarEstadoCartillaJuradoUnificadoPorRodeo
//   · cartilla_delegado_pendiente<- cargarEstadoCartillaDelegadoUnificadoPorRodeo
//   · cartilla_requiere_correccion <- ambas unificadas (requiere_correccion)
//   · nota_comision_pendiente / nota_delegado_pendiente <- cargarNotasPorRodeo
//   · nota_area_deportiva_pendiente <- cargarNotaAreaDeportivaPorRodeo (ningún
//     jurado activo con nota ACTUAL — una nota histórica sola no la resuelve)
//
// Las cartillas/notas solo se consideran "pendientes" (no simplemente
// "ausentes") si el rodeo YA SE REALIZÓ (`fecha <= hoy`) — un rodeo futuro
// nunca debería mostrarse como atrasado (pedido explícito). La corrección
// de una cartilla observada/reabierta SÍ es accionable de inmediato, sin
// esperar la fecha (ya existió un envío real que corregir).
// rodeoIds=null -> modo global (filtros/contadores): se consulta primero
// `rodeos` sin restricción (solo activos) para tener id+fecha de TODOS,
// igual costo que las demás consultas "globales" ya existentes en este
// archivo.
// @returns Map rodeo_id -> { pendientes: string[], tiene_pendientes: boolean }
async function calcularPendientesPorRodeo(rodeoIds = null) {
    let rq = supabase.from('rodeos').select('id, fecha').eq('estado', 'activo');
    if (rodeoIds) rq = rq.in('id', rodeoIds);
    const { data: rodeosData } = await rq;
    const ids = (rodeosData || []).map(r => r.id);
    if (ids.length === 0) return {};

    const hoy = new Date().toISOString().slice(0, 10);
    const fechaPorRodeo = {};
    (rodeosData || []).forEach(r => { fechaPorRodeo[r.id] = r.fecha; });

    const [statsMap, cdMap, cjMap, notasMap, notaADMap] = await Promise.all([
        cargarStatsAsignacionesPorRodeo(ids),
        cargarEstadoCartillaDelegadoUnificadoPorRodeo(ids),
        cargarEstadoCartillaJuradoUnificadoPorRodeo(ids),
        cargarNotasPorRodeo(ids),
        cargarNotaAreaDeportivaPorRodeo(ids)
    ]);

    const result = {};
    ids.forEach(id => {
        const yaRealizado = fechaPorRodeo[id] && fechaPorRodeo[id] <= hoy;
        const s = statsMap[id] || { pendientes_publicacion: 0, j_pend: 0 };
        const cd = cdMap[id] || { recibida: false, requiere_correccion: false };
        const cj = cjMap[id] || { recibida: false, requiere_correccion: false };
        const notas = notasMap[id] || { nota_comision: null, nota_delegado: null };
        const notaAD = notaADMap[id] || { actuales: [] };

        const pendientes = [];
        if (s.pendientes_publicacion > 0) pendientes.push('designacion_no_publicada');
        if (s.j_pend > 0) pendientes.push('jurado_sin_responder');
        if (yaRealizado && !cj.recibida) pendientes.push('cartilla_jurado_pendiente');
        if (yaRealizado && !cd.recibida) pendientes.push('cartilla_delegado_pendiente');
        if (cd.requiere_correccion || cj.requiere_correccion) pendientes.push('cartilla_requiere_correccion');
        if (yaRealizado && (notas.nota_comision === null || notas.nota_comision === undefined)) pendientes.push('nota_comision_pendiente');
        if (yaRealizado && (notas.nota_delegado === null || notas.nota_delegado === undefined)) pendientes.push('nota_delegado_pendiente');
        if (yaRealizado && notaAD.actuales.length === 0) pendientes.push('nota_area_deportiva_pendiente');

        result[id] = { pendientes, tiene_pendientes: pendientes.length > 0 };
    });
    return result;
}

module.exports = {
    resolverFiltrosComplejos,
    resolverBusquedaJuradoIds,
    construirQueryRodeosFiltrada,
    obtenerTodosLosIdsFiltrados,
    textoEstadoDesignacion,
    cargarStatsAsignacionesPorRodeo,
    cargarIndicadoresAdjuntosPorRodeo,
    cargarEstadoCartillaDelegadoAdjuntaPorRodeo,
    cargarNotasPorRodeo,
    cargarDelegadoRentadoVigentePorRodeo,
    fusionarEstadoCartillaDelegado,
    cargarEstadoCartillaDelegadoUnificadoPorRodeo,
    cargarEstadoCartillaJuradoUnificadoPorRodeo,
    cargarNotaAreaDeportivaPorRodeo,
    calcularPendientesPorRodeo
};
