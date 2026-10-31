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

    const PRIORIDAD_DIGITAL = { aprobada: 6, cerrada: 5, reenviada: 4, enviada: 3, observada: 2, borrador: 1 };
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

module.exports = {
    resolverFiltrosComplejos,
    resolverBusquedaJuradoIds,
    construirQueryRodeosFiltrada,
    textoEstadoDesignacion,
    cargarStatsAsignacionesPorRodeo,
    cargarIndicadoresAdjuntosPorRodeo,
    cargarEstadoCartillaDelegadoAdjuntaPorRodeo,
    cargarNotasPorRodeo
};
