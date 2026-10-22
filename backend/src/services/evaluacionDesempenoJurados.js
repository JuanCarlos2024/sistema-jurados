// ═════════════════════════════════════════════════════════════════════════
// evaluacionDesempenoJurados.js — lógica compartida de "Evaluación de
// Desempeño Jurados". Mismo patrón que matrizParticipacion.js: una única
// función consumida por el endpoint JSON (pantalla) y el endpoint Excel,
// para que nunca diverjan.
//
// FUENTES (todas YA EXISTENTES — nada se duplica ni se recalcula fuera de
// su fuente oficial):
//   - Total rodeos / Altera resultado -> asignaciones (estado='activo',
//     tipo_persona='jurado', estado_designacion != 'rechazado') + rodeos +
//     evaluaciones.resultados_alterados (anulada=false).
//   - Consultas WhatsApp -> evaluaciones.casos_whatsapp (anulada=false).
//     ATRIBUCIÓN CONFIRMADA POR EL USUARIO: evaluaciones.casos_whatsapp es
//     un conteo POR RODEO (no por jurado individual) — se atribuye el total
//     del rodeo a CADA jurado que participó en él, sin dividir. Por eso el
//     total de esta columna para un jurado NO debe sumarse entre jurados
//     para obtener un total global (se duplicaría el conteo de rodeos
//     compartidos) — el reporte nunca expone esa suma global.
//   - Nota Delegado -> rodeo_notas_secundarias.nota_delegado (UNA fila por
//     rodeo, no por jurado — mismo criterio ya confirmado y usado en Matriz
//     de Participación: se atribuye la nota del rodeo a cada jurado que
//     participó en él).
//   - Nota Comisión -> comision_evaluaciones_jurado.nota_individual_calculada
//     (grano NATIVO por jurado vía asignacion_id, estado vigente IN
//     ('enviada','corregida_admin')) — a diferencia de Nota Delegado, esta
//     SÍ es una evaluación individual real, nunca una atribución de un valor
//     de rodeo compartido. NUNCA se usa rodeo_notas_secundarias.nota_comision
//     (esa es la nota consolidada del rodeo completo, un concepto distinto).
//   - Nota Área Deportiva -> notas_rodeo.nota (fuente='evaluacion_tecnica'
//     exclusivamente — se excluye fuente='manual', que es un valor
//     histórico importado sin evaluación técnica real detrás, ver migración
//     060). Grano nativo por jurado vía asignacion_id.
//   - Categoría del jurado -> usuarios_pagados.categoria (A/B/C).
//
// UNIVERSO vs FILAS VISIBLES (mismo criterio que Matriz de Participación):
// el período SÍ acota el universo de cálculo; categoría y búsqueda por
// nombre son filtros de PRESENTACIÓN — se aplican después de calcular los
// promedios por categoría, para que "% alterado por categoría" y "Promedio
// categoría (AD)" sean el mismo valor para TODOS los jurados de esa
// categoría en el período, sin importar qué filas queden visibles.
// ═════════════════════════════════════════════════════════════════════════
const supabase = require('../config/supabase');

function round1(n) {
    return n === null || n === undefined ? null : Math.round(n * 10) / 10;
}
function promedio(arr) {
    return arr.length > 0 ? arr.reduce((s, n) => s + n, 0) / arr.length : null;
}

// ─── Período — desde/hasta explícitos (sin depender del módulo "temporadas",
// que es un concepto distinto y no lo usa ningún otro reporte de este tipo;
// mismo patrón ya usado por Matriz de Participación). ───────────────────────
function calcularPeriodo({ desde, hasta }) {
    if (!desde || !hasta) throw new Error('PERIODO_REQUERIDO');
    if (hasta < desde) throw new Error('PERIODO_INVALIDO');
    return { desde, hasta };
}

// ─── Datos base: todo en consultas batch (nunca N+1). ──────────────────────
async function obtenerDatosBase({ desde, hasta }) {
    const { data: jurados, error: errJurados } = await supabase
        .from('usuarios_pagados')
        .select('id, nombre_completo, categoria')
        .eq('activo', true)
        .eq('tipo_persona', 'jurado');
    if (errJurados) throw new Error('usuarios_pagados: ' + errJurados.message);

    const { data: asigs, error: errAsigs } = await supabase
        .from('asignaciones')
        .select('id, usuario_pagado_id, estado_designacion, rodeos!inner(id, fecha)')
        .eq('estado', 'activo')
        .eq('tipo_persona', 'jurado')
        .gte('rodeos.fecha', desde)
        .lte('rodeos.fecha', hasta);
    if (errAsigs) throw new Error('asignaciones: ' + errAsigs.message);
    const todasAsigs = (asigs || []).filter(a => a.estado_designacion !== 'rechazado' && a.usuario_pagado_id);

    const asignacionIds = todasAsigs.map(a => a.id);
    const rodeoIds = [...new Set(todasAsigs.map(a => a.rodeos?.id).filter(Boolean))];

    // evaluaciones (Altera resultado + Consultas WhatsApp) — por rodeo.
    const evalMap = {};
    if (rodeoIds.length > 0) {
        const { data, error } = await supabase
            .from('evaluaciones')
            .select('rodeo_id, resultados_alterados, casos_whatsapp')
            .in('rodeo_id', rodeoIds)
            .eq('anulada', false)
            .eq('es_historica_importacion', false);
        if (error) throw new Error('evaluaciones: ' + error.message);
        (data || []).forEach(e => { evalMap[e.rodeo_id] = e; });
    }

    // rodeo_notas_secundarias (Nota Delegado) — por rodeo.
    const notaDelegadoMap = {};
    if (rodeoIds.length > 0) {
        const { data, error } = await supabase
            .from('rodeo_notas_secundarias')
            .select('rodeo_id, nota_delegado')
            .in('rodeo_id', rodeoIds);
        if (error) throw new Error('rodeo_notas_secundarias: ' + error.message);
        (data || []).forEach(n => {
            notaDelegadoMap[n.rodeo_id] = n.nota_delegado !== null && n.nota_delegado !== undefined ? parseFloat(n.nota_delegado) : null;
        });
    }

    // comision_evaluaciones_jurado (Nota Comisión, grano por jurado vía asignacion_id).
    const notaComisionMap = {};
    if (asignacionIds.length > 0) {
        const { data, error } = await supabase
            .from('comision_evaluaciones_jurado')
            .select('asignacion_id, nota_individual_calculada')
            .in('asignacion_id', asignacionIds)
            .in('estado', ['enviada', 'corregida_admin']);
        if (error) throw new Error('comision_evaluaciones_jurado: ' + error.message);
        (data || []).forEach(n => { notaComisionMap[n.asignacion_id] = parseFloat(n.nota_individual_calculada); });
    }

    // notas_rodeo (Nota Área Deportiva, grano por jurado vía asignacion_id, solo evaluación técnica real).
    const notaADMap = {};
    if (asignacionIds.length > 0) {
        const { data, error } = await supabase
            .from('notas_rodeo')
            .select('asignacion_id, nota')
            .in('asignacion_id', asignacionIds)
            .eq('fuente', 'evaluacion_tecnica');
        if (error) throw new Error('notas_rodeo: ' + error.message);
        (data || []).forEach(n => { notaADMap[n.asignacion_id] = parseFloat(n.nota); });
    }

    return { jurados: jurados || [], todasAsigs, evalMap, notaDelegadoMap, notaComisionMap, notaADMap };
}

// ─── Construye, para CADA jurado activo (tenga o no rodeos en el período),
// sus indicadores individuales. Deduplica por rodeo distinto (nunca cuenta
// dos veces el mismo rodeo aunque existan asignaciones repetidas). ─────────
function construirFilas({ jurados, todasAsigs, evalMap, notaDelegadoMap, notaComisionMap, notaADMap }) {
    const porJurado = {};
    jurados.forEach(j => {
        porJurado[j.id] = {
            usuario_pagado_id: j.id,
            nombre: j.nombre_completo,
            categoria: j.categoria || null,
            _rodeoIds: new Set(),          // dedupe de "total rodeos del período"
            _asignacionIds: [],            // para Comisión/AD (grano por asignación)
            _alteradoRodeoIds: new Set(),
            _wspTotal: 0,
            _wspRodeoIds: new Set(),
            _delegado: [],
            _comision: [],
            _ad: []
        };
    });

    todasAsigs.forEach(a => {
        const p = porJurado[a.usuario_pagado_id];
        if (!p) return; // asignación de alguien inactivo/no-jurado: fuera del universo del reporte
        const rodeoId = a.rodeos?.id;
        if (!rodeoId) return;
        if (p._rodeoIds.has(rodeoId)) return; // ya contado este rodeo para este jurado (evita duplicados)
        p._rodeoIds.add(rodeoId);
        p._asignacionIds.push(a.id);

        const ev = evalMap[rodeoId];
        if (ev) {
            if (ev.resultados_alterados) p._alteradoRodeoIds.add(rodeoId);
            const wsp = ev.casos_whatsapp || 0;
            p._wspTotal += wsp;
            if (wsp > 0) p._wspRodeoIds.add(rodeoId);
        }

        const nd = notaDelegadoMap[rodeoId];
        if (nd !== null && nd !== undefined) p._delegado.push(nd);

        const nc = notaComisionMap[a.id];
        if (nc !== null && nc !== undefined) p._comision.push(nc);

        const nad = notaADMap[a.id];
        if (nad !== null && nad !== undefined) p._ad.push(nad);
    });

    return Object.values(porJurado).map(p => {
        const total_rodeos = p._rodeoIds.size;
        const altera_resultado = p._alteradoRodeoIds.size;
        const pct_alterado_individual = total_rodeos > 0 ? round1((altera_resultado / total_rodeos) * 100) : null;

        const nota_delegado_promedio = round1(promedio(p._delegado));
        const nota_comision_promedio = round1(promedio(p._comision));
        const nota_ad_promedio       = round1(promedio(p._ad));

        let promedio_d_com = null;
        if (nota_delegado_promedio !== null && nota_comision_promedio !== null) {
            promedio_d_com = round1((nota_delegado_promedio + nota_comision_promedio) / 2);
        } else if (nota_delegado_promedio !== null) {
            promedio_d_com = nota_delegado_promedio;
        } else if (nota_comision_promedio !== null) {
            promedio_d_com = nota_comision_promedio;
        }

        return {
            usuario_pagado_id: p.usuario_pagado_id,
            nombre: p.nombre,
            categoria: p.categoria,
            total_rodeos,
            altera_resultado,
            pct_alterado_individual,
            consultas_wsp_total: p._wspTotal,
            consultas_wsp_rodeos: p._wspRodeoIds.size,
            nota_delegado_promedio,
            nota_comision_promedio,
            promedio_d_com,
            nota_ad_promedio,
            // Crudos, consumidos solo por calcularBenchmarksCategoria — nunca expuestos en el JSON final.
            _crudo: { total_rodeos, altera_resultado, nota_ad_promedio }
        };
    });
}

// ─── Benchmarks de categoría — MISMO valor de referencia para TODOS los
// jurados de la categoría en el período (a diferencia de Matriz de
// Participación, acá NO se excluye a la propia persona: es un indicador de
// categoría completa, no una comparación "yo vs mis pares").
//
// % ALTERADO POR CATEGORÍA: implementado según la hipótesis documentada en
// el pedido original (suma de rodeos alterados de la categoría / suma de
// rodeos de la categoría × 100) — PENDIENTE DE VERIFICACIÓN contra una
// fuente oficial externa, tal como se advirtió explícitamente antes de
// implementar. Se marca en el reporte con metodología visible, nunca como
// un hecho confirmado.
//
// PROMEDIO CATEGORÍA (AD): promedio simple de "Nota AD" entre los jurados de
// la categoría que SÍ tienen valor (los sin nota no cuentan ni en la suma ni
// en el denominador — nunca se tratan como 0). ──────────────────────────────
function calcularBenchmarksCategoria(filas) {
    const grupos = {}; // categoria -> { sumAlterado, sumRodeos, sumAD, countAD }
    filas.forEach(f => {
        if (!f.categoria) return;
        if (!grupos[f.categoria]) grupos[f.categoria] = { sumAlterado: 0, sumRodeos: 0, sumAD: 0, countAD: 0 };
        const g = grupos[f.categoria];
        g.sumAlterado += f._crudo.altera_resultado;
        g.sumRodeos   += f._crudo.total_rodeos;
        if (f._crudo.nota_ad_promedio !== null) { g.sumAD += f._crudo.nota_ad_promedio; g.countAD += 1; }
    });

    return filas.map(f => {
        const { _crudo, ...resto } = f;
        if (!f.categoria || !grupos[f.categoria]) {
            return { ...resto, pct_alterado_categoria: null, promedio_categoria_ad: null };
        }
        const g = grupos[f.categoria];
        return {
            ...resto,
            pct_alterado_categoria: g.sumRodeos > 0 ? round1((g.sumAlterado / g.sumRodeos) * 100) : null,
            promedio_categoria_ad: g.countAD > 0 ? round1(g.sumAD / g.countAD) : null
        };
    });
}

// ─── Manual: Mal jurado / Análisis técnico — merge por (jurado, período EXACTO). ──
async function obtenerManual({ desde, hasta }, usuarioIds) {
    const map = {};
    if (!usuarioIds.length) return map;
    const { data, error } = await supabase
        .from('evaluacion_desempeno_manual')
        .select('usuario_pagado_id, mal_jurado, analisis_tecnico, actualizado_en, actualizado_por')
        .eq('periodo_desde', desde)
        .eq('periodo_hasta', hasta)
        .in('usuario_pagado_id', usuarioIds);
    if (error) throw new Error('evaluacion_desempeno_manual: ' + error.message);
    (data || []).forEach(m => { map[m.usuario_pagado_id] = m; });
    return map;
}

function aplicarFiltrosVisuales(filas, { categoria, search }) {
    let resultado = filas;
    if (categoria) resultado = resultado.filter(f => f.categoria === categoria);
    if (search) {
        const s = search.toLowerCase();
        resultado = resultado.filter(f => f.nombre.toLowerCase().includes(s));
    }
    return resultado;
}

const ORDENES = {
    nombre_az:              (a, b) => a.nombre.localeCompare(b.nombre),
    nombre_za:              (a, b) => b.nombre.localeCompare(a.nombre),
    categoria_az:           (a, b) => (a.categoria || '').localeCompare(b.categoria || ''),
    altera_resultado_desc:  (a, b) => b.altera_resultado - a.altera_resultado,
    altera_resultado_asc:   (a, b) => a.altera_resultado - b.altera_resultado,
    total_rodeos_desc:      (a, b) => b.total_rodeos - a.total_rodeos,
    total_rodeos_asc:       (a, b) => a.total_rodeos - b.total_rodeos,
    pct_alterado_desc:      (a, b) => (b.pct_alterado_individual ?? -1)  - (a.pct_alterado_individual ?? -1),
    pct_alterado_asc:       (a, b) => (a.pct_alterado_individual ?? 999) - (b.pct_alterado_individual ?? 999),
    pct_categoria_desc:     (a, b) => (b.pct_alterado_categoria ?? -1)  - (a.pct_alterado_categoria ?? -1),
    pct_categoria_asc:      (a, b) => (a.pct_alterado_categoria ?? 999) - (b.pct_alterado_categoria ?? 999),
    wsp_total_desc:         (a, b) => b.consultas_wsp_total - a.consultas_wsp_total,
    wsp_total_asc:          (a, b) => a.consultas_wsp_total - b.consultas_wsp_total,
    wsp_rodeos_desc:        (a, b) => b.consultas_wsp_rodeos - a.consultas_wsp_rodeos,
    wsp_rodeos_asc:         (a, b) => a.consultas_wsp_rodeos - b.consultas_wsp_rodeos,
    mal_jurado_desc:        (a, b) => (b.mal_jurado ?? -1)  - (a.mal_jurado ?? -1),
    mal_jurado_asc:         (a, b) => (a.mal_jurado ?? 999) - (b.mal_jurado ?? 999),
    nota_delegado_desc:     (a, b) => (b.nota_delegado_promedio ?? -1)  - (a.nota_delegado_promedio ?? -1),
    nota_delegado_asc:      (a, b) => (a.nota_delegado_promedio ?? 999) - (b.nota_delegado_promedio ?? 999),
    nota_comision_desc:     (a, b) => (b.nota_comision_promedio ?? -1)  - (a.nota_comision_promedio ?? -1),
    nota_comision_asc:      (a, b) => (a.nota_comision_promedio ?? 999) - (b.nota_comision_promedio ?? 999),
    promedio_d_com_desc:    (a, b) => (b.promedio_d_com ?? -1)  - (a.promedio_d_com ?? -1),
    promedio_d_com_asc:     (a, b) => (a.promedio_d_com ?? 999) - (b.promedio_d_com ?? 999),
    nota_ad_desc:           (a, b) => (b.nota_ad_promedio ?? -1)  - (a.nota_ad_promedio ?? -1),
    nota_ad_asc:            (a, b) => (a.nota_ad_promedio ?? 999) - (b.nota_ad_promedio ?? 999),
    promedio_categoria_ad_desc: (a, b) => (b.promedio_categoria_ad ?? -1)  - (a.promedio_categoria_ad ?? -1),
    promedio_categoria_ad_asc:  (a, b) => (a.promedio_categoria_ad ?? 999) - (b.promedio_categoria_ad ?? 999)
};

function ordenar(filas, order) {
    return [...filas].sort(ORDENES[order] || ORDENES.total_rodeos_desc);
}

// ─── Punto de entrada único — consumido por el endpoint JSON y por el Excel ──
async function obtenerEvaluacionDesempeno({ desde, hasta, categoria, search, order }) {
    const periodo = calcularPeriodo({ desde, hasta });
    const datos = await obtenerDatosBase(periodo);

    let filas = construirFilas(datos);
    filas = calcularBenchmarksCategoria(filas);

    const manualMap = await obtenerManual(periodo, filas.map(f => f.usuario_pagado_id));
    filas = filas.map(f => {
        const m = manualMap[f.usuario_pagado_id];
        return {
            ...f,
            mal_jurado: m && m.mal_jurado !== null && m.mal_jurado !== undefined ? m.mal_jurado : null,
            analisis_tecnico: m ? m.analisis_tecnico : null,
            // Token de concurrencia COMPARTIDO por ambos campos manuales (una sola
            // fila por jurado+período) — se reenvía tal cual al guardar cualquiera
            // de los dos, para que la RPC detecte una edición concurrente de CUALQUIERA.
            manual_actualizado_en: m ? m.actualizado_en : null
        };
    });

    filas = aplicarFiltrosVisuales(filas, { categoria, search });
    filas = ordenar(filas, order || 'total_rodeos_desc');

    return { periodo, filas };
}

module.exports = {
    obtenerEvaluacionDesempeno,
    // Exportados para tests unitarios de las piezas internas.
    round1,
    promedio,
    calcularPeriodo,
    construirFilas,
    calcularBenchmarksCategoria,
    aplicarFiltrosVisuales,
    ordenar,
    ORDENES
};
