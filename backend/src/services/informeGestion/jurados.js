// ═════════════════════════════════════════════════════════════════════════
// Análisis de jurados — indicadores OBJETIVOS, nunca juicios personales.
//
// ATRIBUCIÓN (micro-auditoría Fase 3A, datos reales de producción):
//   · evaluaciones.resultados_alterados es UN booleano por evaluación/rodeo,
//     fijado por el analista junto con un comentario libre. Ni `evaluaciones`
//     ni `evaluacion_casos` tienen columna o FK hacia jurados/asignaciones
//     (evaluacion_respuestas_jurado enlaza caso→asignación pero es la
//     RESPUESTA del jurado —acepta/rechaza—, no la autoría del caso).
//   · 135 de 136 rodeos evaluados tienen 1 jurado y 1 tiene 2 (alterado):
//     asignarle la alteración a "todos" duplicaría; no hay atribución
//     individual demostrable.
//   ⇒ Resultados alterados, situaciones y faltas son indicadores del RODEO.
//     Por jurado solo se informa "en cuántos rodeos en que participó
//     ocurrió", NUNCA "este jurado alteró/causó X". Los campos
//     `*_atribuidos` van explícitamente en null.
//   · La NOTA sí es individual: notas_rodeo.nota por asignación.
//
// Otras reglas:
//   · Categoría A/B/C = categoría APLICADA en la asignación (snapshot).
//   · Cada fila lleva tamano_muestra y nivel_muestra (config).
// ═════════════════════════════════════════════════════════════════════════
const CONFIG = require('./config');
const { redondear, porcentaje, promedio, aNumero, esPublicada } = require('./agregados');

const CATEGORIAS = ['A', 'B', 'C'];
const SIN_CATEGORIA_JURADO = 'SIN_CATEGORIA';
const NO_ATRIBUIBLE = 'NO_ATRIBUIBLE_A_JURADO_INDIVIDUAL';
const MOTIVO_ATRIBUCION = 'Resultado alterado, situaciones y faltas se registran por rodeo/evaluación; el sistema no vincula esos datos a un jurado. Se informa la participación del jurado en rodeos donde ocurrieron, no su autoría.';

function nivelMuestra(n, cfg = CONFIG) {
    if (n >= cfg.JURADO.MUESTRA_SUFICIENTE_DESDE) return 'SUFICIENTE';
    if (n >= cfg.JURADO.MUESTRA_LIMITADA_DESDE) return 'LIMITADA';
    return 'INSUFICIENTE';
}

// Pendiente por mínimos cuadrados sobre el índice de actuación (nota/actuación).
function pendiente(valores) {
    const n = valores.length;
    if (n < 3) return null;
    const mx = (n - 1) / 2;
    const my = valores.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    valores.forEach((y, i) => { num += (i - mx) * (y - my); den += (i - mx) ** 2; });
    return den === 0 ? 0 : num / den;
}

function direccionTendencia(p, cfg = CONFIG) {
    if (p === null) return null;
    if (Math.abs(p) < cfg.JURADO.TENDENCIA_ESTABLE_UMBRAL) return 'ESTABLE';
    return p < 0 ? 'DESCENDENTE' : 'ASCENDENTE';
}

// Rachas sobre las actuaciones más recientes (orden cronológico ascendente).
function rachaFinal(actuaciones, predicado) {
    let n = 0;
    for (let i = actuaciones.length - 1; i >= 0; i--) {
        if (!predicado(actuaciones[i])) break;
        n++;
    }
    return n;
}

function analizarJurados({ realizados, evalPorRodeo, casosPorEval, asignaciones, usuariosPorId, notasPorAsignacion, notasSecPorRodeo, periodo = null }, cfg = CONFIG) {
    const rodeoPorId = {};
    realizados.forEach(r => { rodeoPorId[r.id] = r; });

    const validas = (asignaciones || []).filter(a =>
        a.tipo_persona === 'jurado' && a.estado === 'activo' && a.estado_designacion !== 'rechazado' && a.usuario_pagado_id && rodeoPorId[a.rodeo_id]);
    const juradosPorRodeo = {};
    validas.forEach(a => { (juradosPorRodeo[a.rodeo_id] ||= new Set()).add(a.usuario_pagado_id); });

    const grupos = new Map();
    for (const a of validas) {
        const rodeo = rodeoPorId[a.rodeo_id];
        const cat = a.categoria_aplicada || SIN_CATEGORIA_JURADO;
        const clave = `${a.usuario_pagado_id}|${cat}`;
        if (!grupos.has(clave)) grupos.set(clave, { usuario_id: a.usuario_pagado_id, categoria: cat, actuaciones: new Map() });
        const ev = evalPorRodeo[rodeo.id] || null;
        const casos = ev ? (casosPorEval[ev.id] || []).filter(c => c.anulado !== true) : [];
        const nota = notasPorAsignacion ? aNumero(notasPorAsignacion[a.id]?.nota) : null;
        grupos.get(clave).actuaciones.set(rodeo.id, {
            rodeo_id: rodeo.id, fecha: rodeo.fecha, nota,
            tiene_evaluacion: !!ev,
            publicada: esPublicada(ev, cfg),
            alterado: esPublicada(ev, cfg) && typeof ev.resultados_alterados === 'boolean' ? ev.resultados_alterados : null,
            casos: casos.length,
            reglamentarias: casos.filter(c => c.tipo_caso === 'reglamentaria').length,
            apreciacion: casos.filter(c => c.tipo_caso === 'interpretativa').length,
            compartido: (juradosPorRodeo[rodeo.id]?.size || 0) > 1
        });
    }

    const detalle = [];
    for (const g of grupos.values()) {
        const act = [...g.actuaciones.values()].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.rodeo_id.localeCompare(b.rodeo_id));
        const notas = act.map(a => a.nota).filter(n => n !== null);
        const alterDen = act.filter(a => a.alterado !== null).length;
        const alterNum = act.filter(a => a.alterado === true).length;
        const conEval = act.filter(a => a.tiene_evaluacion);
        const conSit = conEval.filter(a => a.casos > 0).length;
        const ultimas = act.filter(a => a.nota !== null).slice(-cfg.JURADO.ULTIMAS_NOTAS).map(a => ({ fecha: a.fecha, nota: a.nota }));
        const p = pendiente(ultimas.map(u => u.nota));
        const u = usuariosPorId ? usuariosPorId[g.usuario_id] : null;
        detalle.push({
            usuario_id: g.usuario_id,
            jurado: u?.nombre_completo || null,
            categoria: g.categoria,
            activo_actualmente: u ? (u.activo !== false && u.estado_usuario !== 'inactivo') : null,
            estado_usuario: u ? (u.estado_usuario || null) : null,
            rodeos: act.length,
            rodeos_en_periodo: periodo ? act.filter(a => a.fecha >= periodo.desde && a.fecha <= periodo.hasta).length : null,
            rodeos_con_mas_de_un_jurado: act.filter(a => a.compartido).length,
            // NOTA: individual (notas_rodeo por asignación)
            nota_promedio: promedio(notas),
            n_notas: notas.length,
            ultimas_notas: ultimas,
            tendencia: { n: ultimas.length, pendiente_por_actuacion: p === null ? null : redondear(p, 3), direccion: direccionTendencia(p, cfg) },
            // ATRIBUCIÓN: no demostrable → null explícito + participación en rodeos
            atribucion: { resultados_alterados: NO_ATRIBUIBLE, situaciones: NO_ATRIBUIBLE, faltas: NO_ATRIBUIBLE, nota: 'INDIVIDUAL', motivo: MOTIVO_ATRIBUCION },
            resultados_alterados_atribuidos: null,
            rodeos_con_resultado_alterado_en_que_participo: alterNum,
            denominador_rodeos_publicados: alterDen,
            porcentaje_rodeos_con_resultado_alterado_en_que_participo: porcentaje(alterNum, alterDen),
            situaciones_atribuidas: null,
            casos_en_rodeos_en_que_participo: act.reduce((s, a) => s + a.casos, 0),
            rodeos_con_evaluacion: conEval.length,
            rodeos_con_situaciones_en_que_participo: conSit,
            porcentaje_rodeos_con_situaciones_en_que_participo: porcentaje(conSit, conEval.length),
            casos_reglamentarios_en_rodeos_en_que_participo: act.reduce((s, a) => s + a.reglamentarias, 0),
            casos_apreciacion_en_rodeos_en_que_participo: act.reduce((s, a) => s + a.apreciacion, 0),
            ultima_actuacion: act.length ? act[act.length - 1].fecha : null,
            racha_actual_rodeos_con_situaciones: rachaFinal(conEval, a => a.casos > 0),
            racha_actual_rodeos_con_falta_reglamentaria: rachaFinal(conEval, a => a.reglamentarias > 0),
            racha_actual_rodeos_con_resultado_alterado: rachaFinal(act.filter(a => a.alterado !== null), a => a.alterado === true),
            tamano_muestra: act.length,
            nivel_muestra: nivelMuestra(act.length, cfg)
        });
    }
    detalle.sort((a, b) => a.categoria.localeCompare(b.categoria) || (a.jurado || '').localeCompare(b.jurado || '', 'es'));

    const por_categoria = {};
    const categoriasPresentes = [...new Set([...CATEGORIAS, ...detalle.map(d => d.categoria)])];
    for (const cat of categoriasPresentes) {
        const js = detalle.filter(d => d.categoria === cat);
        const delGrupo = [...grupos.values()].filter(g => g.categoria === cat);
        // Conjunto DISTINTO de rodeos: un rodeo con 2 jurados de la categoría cuenta una vez.
        const rodeosCat = [...new Set(delGrupo.flatMap(g => [...g.actuaciones.keys()]))];
        const evsCat = rodeosCat.map(id => evalPorRodeo[id]).filter(Boolean);
        const pub = evsCat.filter(e => esPublicada(e, cfg) && typeof e.resultados_alterados === 'boolean');
        const conSit = evsCat.filter(e => (casosPorEval[e.id] || []).some(c => c.anulado !== true)).length;
        const secs = rodeosCat.map(id => notasSecPorRodeo ? notasSecPorRodeo[id] : null).filter(Boolean);
        const notasCat = delGrupo.flatMap(g => [...g.actuaciones.values()].map(a => a.nota)).filter(n => n !== null);
        const rankeables = js.filter(d => d.nota_promedio !== null && d.tamano_muestra >= cfg.JURADO.RANKING_MUESTRA_MINIMA);
        const orden = (a, b) => b.tamano_muestra - a.tamano_muestra || (a.jurado || '').localeCompare(b.jurado || '', 'es');
        // Prioridad de muestra: primero SUFICIENTE; si no alcanzan TOP_N, se completa con LIMITADA. La muestra
        // INSUFICIENTE nunca ocupa el ranking (queda contada en excluidos_por_muestra).
        const ranking = cmp => [
            ...rankeables.filter(d => d.nivel_muestra === 'SUFICIENTE').sort(cmp),
            ...rankeables.filter(d => d.nivel_muestra === 'LIMITADA').sort(cmp)
        ];
        // Regla de presentación (genérica): con menos de MIN_ELEGIBLES_TOP_BOTTOM elegibles NO hay Top/Bottom
        // (las mismas personas saldrían en ambas listas): una única tabla ordenada de mayor a menor.
        // Con más, Top y Bottom de tamaño k = min(TOP_N, mitad) para que NUNCA compartan personas.
        const elegibles = rankeables.length;
        const modo = elegibles < cfg.JURADO.MIN_ELEGIBLES_TOP_BOTTOM ? 'TABLA_UNICA' : 'TOP_BOTTOM';
        const k = Math.min(cfg.TOP_N, Math.floor(elegibles / 2));
        const mejores = modo === 'TOP_BOTTOM' ? ranking((a, b) => b.nota_promedio - a.nota_promedio || orden(a, b)).slice(0, k) : [];
        const idsMejores = new Set(mejores.map(x => x.usuario_id + '|' + x.categoria));
        const menores = modo === 'TOP_BOTTOM'
            ? ranking((a, b) => a.nota_promedio - b.nota_promedio || orden(a, b)).filter(x => !idsMejores.has(x.usuario_id + '|' + x.categoria)).slice(0, k)
            : [];
        const tablaUnica = modo === 'TABLA_UNICA'
            ? [...rankeables].sort((a, b) => b.nota_promedio - a.nota_promedio || orden(a, b))
            : [];
        por_categoria[cat] = {
            cantidad_jurados: js.length,
            rodeos_realizados: rodeosCat.length,
            actuaciones: js.reduce((s, d) => s + d.rodeos, 0),
            nota_promedio: promedio(notasCat),
            promedio_comision: promedio(secs.map(s => s.nota_comision)),
            promedio_delegado: promedio(secs.map(s => s.nota_delegado)),
            rodeos_con_resultado_alterado: pub.filter(e => e.resultados_alterados).length,
            denominador_rodeos_publicados: pub.length,
            porcentaje_rodeos_con_resultado_alterado: porcentaje(pub.filter(e => e.resultados_alterados).length, pub.length),
            rodeos_con_situaciones: conSit,
            porcentaje_rodeos_con_situaciones: porcentaje(conSit, evsCat.length),
            modo_ranking: modo,
            elegibles_ranking: elegibles,
            tamano_top_bottom: modo === 'TOP_BOTTOM' ? k : null,
            desempeno_categoria: tablaUnica,
            mejor_evaluados: mejores,
            menor_evaluacion: menores,
            excluidos_por_muestra: js.filter(d => d.nota_promedio !== null && d.tamano_muestra < cfg.JURADO.RANKING_MUESTRA_MINIMA).length,
            criterio_muestra: `Solo se rankean jurados con >= ${cfg.JURADO.RANKING_MUESTRA_MINIMA} actuaciones`,
            criterio_ranking: `Con ${cfg.JURADO.MIN_ELEGIBLES_TOP_BOTTOM} o más jurados elegibles (muestra suficiente o limitada) se muestran mayor y menor promedio sin repetir personas; con menos, una tabla única. Se priorizan jurados con muestra SUFICIENTE (>= ${cfg.JURADO.MUESTRA_SUFICIENTE_DESDE} actuaciones) y se completa con LIMITADA (>= ${cfg.JURADO.MUESTRA_LIMITADA_DESDE}). La muestra INSUFICIENTE no se rankea.`,
            nota_atribucion: 'Resultados alterados y situaciones son de los rodeos de la categoría (rodeos distintos), no de un jurado en particular.'
        };
    }
    const distintos = new Set(detalle.map(d => d.usuario_id));
    const porUsuario = {};
    detalle.forEach(d => { (porUsuario[d.usuario_id] ||= new Set()).add(d.categoria); });
    const resumen = {
        universo: 'Jurados con actuaciones en rodeos realizados de la temporada (una fila por jurado y categoría aplicada)',
        filas_jurado_categoria: detalle.length,
        jurados_distintos_con_actuaciones: distintos.size,
        jurados_en_mas_de_una_categoria: Object.values(porUsuario).filter(s => s.size > 1).length,
        con_actuaciones_no_activos: [...distintos].filter(id => detalle.find(d => d.usuario_id === id).activo_actualmente === false).length
    };
    return { resumen, por_categoria, detalle, atribucion: { resultados_alterados: NO_ATRIBUIBLE, situaciones: NO_ATRIBUIBLE, faltas: NO_ATRIBUIBLE, nota: 'INDIVIDUAL', motivo: MOTIVO_ATRIBUCION } };
}

module.exports = { CATEGORIAS, SIN_CATEGORIA_JURADO, NO_ATRIBUIBLE, nivelMuestra, pendiente, direccionTendencia, analizarJurados };
