// ═════════════════════════════════════════════════════════════════════════
// Motor de agregados — funciones PURAS sobre datos ya cargados.
//
// El dataset se obtiene UNA sola vez (cargaDatos.js) y aquí se calculan los
// subconjuntos (período, acumulado, período anterior) sin volver a la BD.
// Reglas de negocio (decisiones ya definidas):
//   · RODEO REALIZADO  = estado 'activo' Y fecha <= corte. PROGRAMADO =
//     activo Y fecha > corte (dentro de la temporada). Anulados se excluyen.
//   · CATEGORÍA EFECTIVA = rodeos.categoria_rodeo_nombre, o si es NULL la del
//     tipo (tipos_rodeo.categoria_rodeo_id → categorias_rodeo). Sin UPDATE.
//   · NOTA OFICIAL = evaluaciones.nota_final SOLO con estado 'publicado'.
//     Nota Comisión y Nota Delegado son indicadores separados (sin fórmula).
//   · RESULTADO ALTERADO = evaluaciones PUBLICADAS. NULL no cuenta como NO.
//   · Casos con anulado=true NO se cuentan (no inflan métricas oficiales).
// ═════════════════════════════════════════════════════════════════════════
const CONFIG = require('./config');

// ── utilidades numéricas ────────────────────────────────────────────────
function redondear(n, d = 1) {
    if (n === null || n === undefined || !Number.isFinite(n)) return null;
    const f = 10 ** d;
    return Math.round(n * f) / f;
}
function ratio(num, den) { return den > 0 ? num / den : null; }
function porcentaje(num, den) { const r = ratio(num, den); return r === null ? null : redondear(r * 100, 1); }
function aNumero(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
function promedio(arr, decimales = 2) {
    const v = (arr || []).map(aNumero).filter(x => x !== null);
    return v.length ? redondear(v.reduce((a, b) => a + b, 0) / v.length, decimales) : null;
}
// Normaliza 'si'/'sí'/'no' (valores reales de cartillas) → 'si' | 'no' | null.
function siNo(v) {
    const s = String(v ?? '').trim().toLowerCase();
    if (s === 'si' || s === 'sí' || s === 'true') return 'si';
    if (s === 'no' || s === 'false') return 'no';
    return null;
}

// ── categoría efectiva ──────────────────────────────────────────────────
// categoriaPorTipoId: objeto { [tipo_rodeo_id]: 'Primera'|'Segunda'|... }
function categoriaEfectiva(rodeo, categoriaPorTipoId, cfg = CONFIG) {
    const propia = String(rodeo.categoria_rodeo_nombre ?? '').trim();
    if (propia) return { nombre: propia, origen: 'rodeo' };
    const derivada = rodeo.tipo_rodeo_id && categoriaPorTipoId ? categoriaPorTipoId[rodeo.tipo_rodeo_id] : null;
    if (derivada) return { nombre: derivada, origen: 'tipo' };
    return { nombre: cfg.SIN_CATEGORIA, origen: null };
}

// ── selección de rodeos ─────────────────────────────────────────────────
function seleccionarRodeos(rodeos, { desde, hasta, finVentana = null }, cfg = CONFIG) {
    const activos = rodeos.filter(r => r.estado === cfg.RODEO_ACTIVO);
    return {
        realizados: activos.filter(r => r.fecha >= desde && r.fecha <= hasta),
        programados: finVentana ? activos.filter(r => r.fecha > hasta && r.fecha <= finVentana) : [],
        anulados: rodeos.filter(r => r.estado !== cfg.RODEO_ACTIVO && r.fecha >= desde && r.fecha <= hasta)
    };
}

function agruparConteo(items, claveFn) {
    const m = new Map();
    for (const it of items) { const k = claveFn(it); m.set(k, (m.get(k) || 0) + 1); }
    const total = items.length;
    return [...m.entries()]
        .map(([clave, cantidad]) => ({ clave, cantidad, porcentaje: porcentaje(cantidad, total) }))
        .sort((a, b) => b.cantidad - a.cantidad || String(a.clave).localeCompare(String(b.clave), 'es'));
}

function resumenRodeos(sel, categoriaPorTipoId, cfg = CONFIG) {
    const { realizados, programados, anulados } = sel;
    const cats = realizados.map(r => categoriaEfectiva(r, categoriaPorTipoId, cfg));
    const porCat = new Map();
    cats.forEach(c => porCat.set(c.nombre, (porCat.get(c.nombre) || 0) + 1));
    return {
        total: realizados.length + programados.length,
        realizados: realizados.length,
        programados: programados.length,
        anulados_excluidos: anulados.length,
        por_categoria: [...porCat.entries()]
            .map(([clave, cantidad]) => ({ clave, cantidad, porcentaje: porcentaje(cantidad, realizados.length) }))
            .sort((a, b) => b.cantidad - a.cantidad || a.clave.localeCompare(b.clave, 'es')),
        categoria_derivada_del_tipo: cats.filter(c => c.origen === 'tipo').length,
        por_tipo: agruparConteo(realizados, r => r.tipo_rodeo_nombre || 'Sin tipo'),
        por_asociacion: agruparConteo(realizados, r => r.asociacion || 'Sin asociación'),
        por_club: agruparConteo(realizados, r => `${r.club || 'Sin club'} · ${r.asociacion || 'Sin asociación'}`)
    };
}

// ── índices ─────────────────────────────────────────────────────────────
function indexarEvaluaciones(evaluaciones) {
    const m = {};
    for (const e of (evaluaciones || [])) {
        if (e.anulada === true) continue;
        const previa = m[e.rodeo_id];
        if (!previa || (e.estado === CONFIG.EVALUACION_PUBLICADA && previa.estado !== CONFIG.EVALUACION_PUBLICADA)) m[e.rodeo_id] = e;
    }
    return m;
}
function indexarPorClave(lista, clave) {
    const m = {};
    for (const x of (lista || [])) (m[x[clave]] ||= []).push(x);
    return m;
}
function indexarUnico(lista, clave) {
    const m = {};
    for (const x of (lista || [])) m[x[clave]] = x;
    return m;
}

// ── evaluación ──────────────────────────────────────────────────────────
function esPublicada(ev, cfg = CONFIG) { return !!ev && ev.estado === cfg.EVALUACION_PUBLICADA; }

function agregarEvaluacion(realizados, evalPorRodeo, cfg = CONFIG) {
    const evs = realizados.map(r => evalPorRodeo[r.id]).filter(Boolean);
    const publicadas = evs.filter(e => esPublicada(e, cfg));
    const notas = publicadas.map(e => aNumero(e.nota_final)).filter(n => n !== null);
    return {
        rodeos_realizados: realizados.length,
        evaluaciones_existentes: evs.length,
        evaluaciones_publicadas: publicadas.length,
        evaluaciones_no_publicadas: evs.length - publicadas.length,
        cobertura_evaluacion: redondear(ratio(publicadas.length, realizados.length), 3),
        nota_promedio_publicada: promedio(notas),
        publicadas_con_nota: notas.length
    };
}

function agregarAlterados(realizados, evalPorRodeo, cfg = CONFIG) {
    const publicadas = realizados.map(r => evalPorRodeo[r.id]).filter(e => esPublicada(e, cfg));
    const conDato = publicadas.filter(e => typeof e.resultados_alterados === 'boolean');
    const cantidad = conDato.filter(e => e.resultados_alterados).length;
    return {
        cantidad,
        denominador: conDato.length,
        porcentaje: porcentaje(cantidad, conDato.length),
        publicadas_sin_dato: publicadas.length - conDato.length,
        base: 'evaluaciones publicadas'
    };
}

// ── distribución de notas (solo evaluaciones PUBLICADAS con nota_final) ──
const BANDAS_NOTA = [
    { banda: '1,0–3,9', minimo: 1.0, maximo: 3.9 },
    { banda: '4,0–4,9', minimo: 4.0, maximo: 4.9 },
    { banda: '5,0–5,9', minimo: 5.0, maximo: 5.9 },
    { banda: '6,0–7,0', minimo: 6.0, maximo: 7.0 }
];
function distribucionNotas(realizados, evalPorRodeo, cfg = CONFIG) {
    const notas = realizados.map(r => evalPorRodeo[r.id]).filter(e => esPublicada(e, cfg)).map(e => aNumero(e.nota_final)).filter(n => n !== null);
    const idx = n => (n < 4 ? 0 : n < 5 ? 1 : n < 6 ? 2 : 3);
    const cuentas = BANDAS_NOTA.map(() => 0);
    notas.forEach(n => { cuentas[idx(n)]++; });
    return { n: notas.length, bandas: BANDAS_NOTA.map((b, i) => ({ ...b, cantidad: cuentas[i], porcentaje: porcentaje(cuentas[i], notas.length) })), base: 'evaluaciones publicadas con nota_final' };
}

// ── cartillas ───────────────────────────────────────────────────────────
// Consolida las cartillas ENVIADAS y vigentes de un rodeo (puede haber una
// por jurado): 'si' si ALGUNA lo declara; caseta 'no' si ALGUNA marca "No".
function resumenCartillasRodeo(lista, cfg = CONFIG) {
    const env = (lista || []).filter(c => c.estado === cfg.CARTILLA_ENVIADA);
    if (!env.length) return { recibida: false, ganado: null, caseta: null, faltas: null };
    const datos = env.map(c => c.datos || {});
    const tiene = k => datos.some(d => siNo(d[k]) !== null);
    const alguna = (k, v) => datos.some(d => siNo(d[k]) === v);
    return {
        recibida: true,
        ganado: tiene('hubo_ganado_fuera_peso') ? (alguna('hubo_ganado_fuera_peso', 'si') ? 'si' : 'no') : null,
        faltas: tiene('hubo_faltas') ? (alguna('hubo_faltas', 'si') ? 'si' : 'no') : null,
        caseta: tiene('caseta_adecuada') ? (alguna('caseta_adecuada', 'no') ? 'no' : 'si') : null
    };
}

function agregarCartillas(realizados, cartillasPorRodeo, cfg = CONFIG) {
    const res = realizados.map(r => resumenCartillasRodeo(cartillasPorRodeo[r.id], cfg));
    const recibidas = res.filter(x => x.recibida).length;
    const ganadoDen = res.filter(x => x.ganado !== null).length;
    const ganadoSi = res.filter(x => x.ganado === 'si').length;
    const cumple = res.filter(x => x.caseta === 'si').length;
    const noCumple = res.filter(x => x.caseta === 'no').length;
    const faltasDen = res.filter(x => x.faltas !== null).length;
    const faltasSi = res.filter(x => x.faltas === 'si').length;
    return {
        cartillas: {
            rodeos_realizados: realizados.length,
            cartillas_jurado_recibidas: recibidas,
            cobertura_cartillas: redondear(ratio(recibidas, realizados.length), 3)
        },
        ganado: {
            cantidad_si: ganadoSi,
            denominador_cartillas_con_dato: ganadoDen,
            porcentaje: porcentaje(ganadoSi, ganadoDen)
        },
        caseta: {
            cumple, no_cumple: noCumple,
            sin_dato: realizados.length - cumple - noCumple,
            denominador: cumple + noCumple
        },
        faltas_declaradas_cartilla: {
            cantidad_si: faltasSi,
            denominador_cartillas_con_dato: faltasDen,
            porcentaje: porcentaje(faltasSi, faltasDen)
        }
    };
}

// ── faltas / situaciones (casos de evaluación) ──────────────────────────
// Devuelve CASOS y RODEOS AFECTADOS por tipo: un rodeo con 3 casos
// reglamentarios suma 3 casos pero 1 rodeo con falta reglamentaria. Los casos
// anulados no cuentan. "Disciplinarias" sale de la cartilla (Sí/No de
// "Faltas Disciplinarias/Reglamentarias"): el sistema no las distingue de las
// reglamentarias en los casos.
function agregarFaltas(realizados, evalPorRodeo, casosPorEval, cartillasResumen = null) {
    const TIPOS = { reglamentaria: 'reglamentarias', interpretativa: 'apreciacion', informativo: 'informativos' };
    const casos = { reglamentarias: 0, apreciacion: 0, informativos: 0 };
    const rodeosCon = { reglamentarias: new Set(), apreciacion: new Set(), informativos: new Set() };
    const rodeosAlguno = new Set();
    let anuladosExcluidos = 0, rodeosConEval = 0;
    for (const r of realizados) {
        const ev = evalPorRodeo[r.id];
        if (!ev) continue;
        rodeosConEval++;
        for (const c of (casosPorEval[ev.id] || [])) {
            if (c.anulado === true) { anuladosExcluidos++; continue; }
            const k = TIPOS[c.tipo_caso];
            if (!k) continue;
            casos[k]++;
            rodeosCon[k].add(r.id);
            rodeosAlguno.add(r.id);
        }
    }
    const bloque = k => ({ casos_total: casos[k], rodeos_con_falta: rodeosCon[k].size, porcentaje_rodeos_evaluados: porcentaje(rodeosCon[k].size, rodeosConEval) });
    const total = casos.reglamentarias + casos.apreciacion + casos.informativos;
    const cart = cartillasResumen || { cantidad_si: 0, denominador_cartillas_con_dato: 0 };
    return {
        reglamentarias: bloque('reglamentarias'),
        apreciacion: bloque('apreciacion'),
        informativos: { casos_total: casos.informativos, rodeos_con_caso: rodeosCon.informativos.size, porcentaje_rodeos_evaluados: porcentaje(rodeosCon.informativos.size, rodeosConEval) },
        disciplinarias: {
            rodeos_con_falta: cart.cantidad_si,
            denominador_cartillas: cart.denominador_cartillas_con_dato,
            porcentaje: porcentaje(cart.cantidad_si, cart.denominador_cartillas_con_dato),
            fuente: 'cartillas_jurado.datos.hubo_faltas ("Faltas Disciplinarias/Reglamentarias", Sí/No por rodeo)',
            nota: 'El sistema no separa faltas disciplinarias de reglamentarias en la cartilla; es un indicador de rodeos con faltas declaradas.'
        },
        total_casos: total,
        rodeos_con_algun_caso: rodeosAlguno.size,
        casos_anulados_excluidos: anuladosExcluidos,
        rodeos_con_evaluacion: rodeosConEval,
        por_100_rodeos_evaluados: rodeosConEval ? redondear(total * 100 / rodeosConEval, 1) : null,
        base: 'evaluaciones existentes (no anuladas); casos anulados excluidos'
    };
}

// ── notas secundarias (indicadores separados, sin fórmula combinada) ────
function agregarNotasSecundarias(realizados, evalPorRodeo, notasSecPorRodeo, cfg = CONFIG) {
    const elegibles = realizados.filter(r => esPublicada(evalPorRodeo[r.id], cfg));
    const sec = elegibles.map(r => notasSecPorRodeo[r.id]).filter(Boolean);
    const com = sec.map(s => aNumero(s.nota_comision)).filter(n => n !== null);
    const del = sec.map(s => aNumero(s.nota_delegado)).filter(n => n !== null);
    return {
        rodeos_elegibles: elegibles.length,
        nota_comision: { promedio: promedio(com), n: com.length },
        nota_delegado: { promedio: promedio(del), n: del.length }
    };
}

// ── cobertura / calidad de datos ────────────────────────────────────────
function bloqueCobertura(numerador, denominador, cfg = CONFIG) {
    const c = ratio(numerador, denominador);
    return {
        numerador, denominador,
        cobertura: redondear(c, 3),
        porcentaje: porcentaje(numerador, denominador),
        interpretable: c !== null && c >= cfg.COBERTURA.MINIMA_INTERPRETAR
    };
}

function construirCobertura({ evaluacion, cartillas, notasSec }, cfg = CONFIG) {
    const out = {
        evaluaciones_publicadas: bloqueCobertura(evaluacion.evaluaciones_publicadas, evaluacion.rodeos_realizados, cfg),
        evaluaciones_existentes: bloqueCobertura(evaluacion.evaluaciones_existentes, evaluacion.rodeos_realizados, cfg),
        cartillas_jurado: bloqueCobertura(cartillas.cartillas_jurado_recibidas, cartillas.rodeos_realizados, cfg),
        nota_comision: bloqueCobertura(notasSec.nota_comision.n, notasSec.rodeos_elegibles, cfg),
        nota_delegado: bloqueCobertura(notasSec.nota_delegado.n, notasSec.rodeos_elegibles, cfg)
    };
    const bajo = (b, nombre) => (b.denominador > 0 && !b.interpretable)
        ? `Cobertura baja en ${nombre} (${b.numerador}/${b.denominador}): un valor 0 no debe leerse como ausencia real.` : null;
    out.advertencias = [
        bajo(out.evaluaciones_publicadas, 'evaluaciones publicadas'),
        bajo(out.cartillas_jurado, 'cartillas de jurado recibidas'),
        bajo(out.nota_comision, 'Nota Comisión'),
        bajo(out.nota_delegado, 'Nota Delegado')
    ].filter(Boolean);
    // Qué indicadores dependen de qué cobertura (para no leer "0" como ausencia real).
    out.indicadores_sujetos_a_cobertura = {
        resultados_alterados: { depende_de: 'evaluaciones_publicadas', interpretable: out.evaluaciones_publicadas.interpretable },
        faltas_situaciones: { depende_de: 'evaluaciones_existentes', interpretable: out.evaluaciones_existentes.interpretable },
        ganado_fuera_peso: { depende_de: 'cartillas_jurado', interpretable: out.cartillas_jurado.interpretable },
        caseta: { depende_de: 'cartillas_jurado', interpretable: out.cartillas_jurado.interpretable }
    };
    return out;
}

// ── bloque evaluativo completo para un subconjunto de rodeos ────────────
function bloqueEvaluativo(realizados, ctx, cfg = CONFIG) {
    const evaluacion = agregarEvaluacion(realizados, ctx.evalPorRodeo, cfg);
    const alterados = agregarAlterados(realizados, ctx.evalPorRodeo, cfg);
    const cart = agregarCartillas(realizados, ctx.cartillasPorRodeo, cfg);
    const faltas = agregarFaltas(realizados, ctx.evalPorRodeo, ctx.casosPorEval, cart.faltas_declaradas_cartilla);
    const notasSec = agregarNotasSecundarias(realizados, ctx.evalPorRodeo, ctx.notasSecPorRodeo, cfg);
    const cobertura = construirCobertura({ evaluacion, cartillas: cart.cartillas, notasSec }, cfg);
    const ind = cobertura.indicadores_sujetos_a_cobertura;
    return {
        evaluacion,
        distribucion_notas: distribucionNotas(realizados, ctx.evalPorRodeo, cfg),
        resultados_alterados: { ...alterados, interpretable: ind.resultados_alterados.interpretable },
        cartillas: cart.cartillas,
        ganado: { ...cart.ganado, interpretable: ind.ganado_fuera_peso.interpretable },
        caseta: { ...cart.caseta, interpretable: ind.caseta.interpretable },
        faltas: { ...faltas, interpretable: ind.faltas_situaciones.interpretable },
        notas_secundarias: notasSec,
        cobertura
    };
}

// ── TOP / BOTTOM de rodeos ──────────────────────────────────────────────
// Solo evaluaciones PUBLICADAS con nota_final no NULL. Sin promedio nuevo.
function topBottomRodeos(realizados, ctx, cfg = CONFIG) {
    const n = cfg.TOP_N;
    const elegibles = realizados
        .map(r => ({ r, ev: ctx.evalPorRodeo[r.id] }))
        .filter(x => esPublicada(x.ev, cfg) && aNumero(x.ev.nota_final) !== null);

    const fila = ({ r, ev }) => {
        const sec = ctx.notasSecPorRodeo[r.id] || {};
        return {
            rodeo_id: r.id,
            fecha: r.fecha,
            club: r.club,
            asociacion: r.asociacion,
            tipo: r.tipo_rodeo_nombre || null,
            categoria: categoriaEfectiva(r, ctx.categoriaPorTipoId, cfg).nombre,
            jurados: (ctx.juradosPorRodeo && ctx.juradosPorRodeo[r.id]) || [],
            nota_final: aNumero(ev.nota_final),
            nota_comision: aNumero(sec.nota_comision),
            nota_delegado: aNumero(sec.nota_delegado)
        };
    };
    const desempate = (a, b) => (b.r.fecha.localeCompare(a.r.fecha)) || a.r.id.localeCompare(b.r.id);
    const desc = [...elegibles].sort((a, b) => aNumero(b.ev.nota_final) - aNumero(a.ev.nota_final) || desempate(a, b));
    const asc = [...elegibles].sort((a, b) => aNumero(a.ev.nota_final) - aNumero(b.ev.nota_final) || desempate(a, b));
    const top = desc.slice(0, n).map(fila);
    const bottom = asc.slice(0, n).map(fila);
    const idsTop = new Set(top.map(x => x.rodeo_id));
    return {
        criterio: 'evaluaciones.nota_final de evaluaciones PUBLICADAS (sin promedio nuevo)',
        n_elegibles: elegibles.length,
        top,
        bottom,
        solapamiento: bottom.some(x => idsTop.has(x.rodeo_id))
    };
}

module.exports = {
    redondear, ratio, porcentaje, aNumero, promedio, siNo,
    categoriaEfectiva, seleccionarRodeos, agruparConteo, resumenRodeos,
    indexarEvaluaciones, indexarPorClave, indexarUnico,
    esPublicada, agregarEvaluacion, agregarAlterados,
    resumenCartillasRodeo, agregarCartillas, agregarFaltas, agregarNotasSecundarias,
    bloqueCobertura, construirCobertura, bloqueEvaluativo, topBottomRodeos, distribucionNotas, BANDAS_NOTA
};
