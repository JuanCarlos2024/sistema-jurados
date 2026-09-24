// ═════════════════════════════════════════════════════════════════════════
// ¿Las situaciones están DISTRIBUIDAS o CONCENTRADAS? — por ASOCIACIÓN del rodeo.
//
//   · Faltas reglamentarias: rodeos con al menos un caso reglamentario vigente (mismo criterio de
//     agregados.agregarFaltas: casos anulados no cuentan), agrupados por asociación.
//   · Resultados alterados: solo evaluaciones PUBLICADAS con dato (mismo criterio de agregarAlterados),
//     por asociación; se informa la cobertura de publicadas y si la lectura es referencial.
//
// NO se agrupa por jurado: la base no permite atribuir un resultado alterado a un jurado individual.
// Universo: rodeos realizados del acumulado de temporada al corte (los rodeos de prueba ya vienen excluidos).
// ═════════════════════════════════════════════════════════════════════════
const CONFIG = require('./config');
const { construirIndiceCatalogo, resolverAsociacion } = require('./asociaciones');
const { esPublicada, porcentaje } = require('./agregados');

function nombreAsociacion(rodeo, indice) {
    if (indice) { const a = resolverAsociacion(rodeo.asociacion, indice); if (a) return a.nombre; }
    return rodeo.asociacion || 'Sin asociación';
}

function top(mapa, n, comparar) {
    return [...mapa.values()].sort(comparar).slice(0, n);
}

function concentracionSituaciones({ realizados, evalPorRodeo, casosPorEval, catalogo = null, alias = [], coberturaPublicadas = null }, cfg = CONFIG) {
    const N = cfg.EJECUTIVO.TOP_CONCENTRACION;
    const indice = Array.isArray(catalogo) && catalogo.length ? construirIndiceCatalogo(catalogo, alias) : null;

    const faltas = new Map();      // asociación → { asociacion, rodeos_afectados }
    const alterados = new Map();   // asociación → { asociacion, alterados, publicadas }
    let totalFaltas = 0, totalAlterados = 0, totalPublicadas = 0;

    for (const r of realizados) {
        const ev = evalPorRodeo[r.id];
        if (!ev) continue;
        const asoc = nombreAsociacion(r, indice);
        if ((casosPorEval[ev.id] || []).some(c => c.anulado !== true && c.tipo_caso === 'reglamentaria')) {
            if (!faltas.has(asoc)) faltas.set(asoc, { asociacion: asoc, rodeos_afectados: 0 });
            faltas.get(asoc).rodeos_afectados++; totalFaltas++;
        }
        if (esPublicada(ev, cfg) && typeof ev.resultados_alterados === 'boolean') {
            if (!alterados.has(asoc)) alterados.set(asoc, { asociacion: asoc, alterados: 0, publicadas: 0 });
            const x = alterados.get(asoc);
            x.publicadas++; totalPublicadas++;
            if (ev.resultados_alterados) { x.alterados++; totalAlterados++; }
        }
    }

    const porNombre = (a, b) => a.asociacion.localeCompare(b.asociacion, 'es');
    const topFaltas = top(faltas, N, (a, b) => b.rodeos_afectados - a.rodeos_afectados || porNombre(a, b))
        .map(x => ({ ...x, porcentaje_del_total: porcentaje(x.rodeos_afectados, totalFaltas) }));
    const conAlterados = new Map([...alterados].filter(([, v]) => v.alterados > 0));
    const topAlterados = top(conAlterados, N, (a, b) => b.alterados - a.alterados || (b.alterados / b.publicadas) - (a.alterados / a.publicadas) || porNombre(a, b))
        .map(x => ({ ...x, porcentaje_de_publicadas: porcentaje(x.alterados, x.publicadas), porcentaje_del_total: porcentaje(x.alterados, totalAlterados) }));
    const suma = (lista, k) => lista.reduce((s, x) => s + x[k], 0);
    const interpretable = coberturaPublicadas ? coberturaPublicadas.interpretable !== false : true;

    return {
        criterio: 'Por asociación del rodeo; acumulado de temporada al corte. No se atribuye a jurados.',
        top_n: N,
        faltas_reglamentarias: {
            total_rodeos_afectados: totalFaltas,
            asociaciones_con_rodeos_afectados: faltas.size,
            top: topFaltas,
            rodeos_en_top: suma(topFaltas, 'rodeos_afectados'),
            porcentaje_en_top: totalFaltas ? porcentaje(suma(topFaltas, 'rodeos_afectados'), totalFaltas) : null
        },
        resultados_alterados: {
            total_alterados: totalAlterados,
            total_publicadas: totalPublicadas,
            porcentaje_alterados: totalPublicadas ? porcentaje(totalAlterados, totalPublicadas) : null,   // SIN DATOS si no hay publicadas
            asociaciones_con_alterados: conAlterados.size,
            top: topAlterados,
            rodeos_en_top: suma(topAlterados, 'alterados'),
            porcentaje_en_top: totalAlterados ? porcentaje(suma(topAlterados, 'alterados'), totalAlterados) : null,
            cobertura_publicadas: coberturaPublicadas ? { numerador: coberturaPublicadas.numerador, denominador: coberturaPublicadas.denominador, porcentaje: coberturaPublicadas.porcentaje, interpretable } : null,
            lectura_referencial: !interpretable
        }
    };
}

module.exports = { concentracionSituaciones };
