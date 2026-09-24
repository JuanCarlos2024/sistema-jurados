// ═════════════════════════════════════════════════════════════════════════
// Proyecciones REFERENCIALES de cierre de temporada.
//
// Método (genérico, por temporada histórica h):
//     avance_h      = equivalente_h / final_h      (ritmo histórico a la fecha equivalente)
//     estimacion_h  = actual / avance_h
// Con varias temporadas: escenario central = MEDIANA de las estimaciones,
// rango = mínimo/máximo de las estimaciones individuales.
//
// Reglas de muestra:
//   · Una temporada con avance_h < AVANCE_MINIMO (25 %) se DESCARTA.
//   · Sin ninguna temporada válida → PROYECCION_NO_DISPONIBLE (con motivo).
//
// Confianza = etiqueta DESCRIPTIVA, NO un intervalo estadístico ni una
// probabilidad:  1 temporada → REFERENCIAL · 2 → LIMITADA · 3+ →
// MAYOR_BASE_HISTORICA solo si sus estimaciones son consistentes
// (dispersión (máx-mín)/mediana <= CONSISTENCIA_MAX_DISPERSION); si no, LIMITADA.
// ═════════════════════════════════════════════════════════════════════════
const CONFIG = require('./config');
const { redondear, aNumero } = require('./agregados');
const { buscarMedicionEquivalente, SIN_DATO_HISTORICO_COMPARABLE } = require('./fechasEquivalentes');

const AVISO = 'Estimación referencial según ritmo actual e histórico. No es una certeza ni un intervalo estadístico.';

function mediana(valores) {
    const v = [...valores].sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function etiquetaConfianza(estimaciones, cfg = CONFIG) {
    const n = estimaciones.length;
    if (n <= 1) return 'REFERENCIAL';
    if (n === 2) return 'LIMITADA';
    const med = mediana(estimaciones);
    const disp = med > 0 ? (Math.max(...estimaciones) - Math.min(...estimaciones)) / med : Infinity;
    return disp <= cfg.PROYECCION.CONSISTENCIA_MAX_DISPERSION ? 'MAYOR_BASE_HISTORICA' : 'LIMITADA';
}

// historicos: [{ temporada, equivalente, final }] — equivalente/final pueden ser null.
function proyectarSerie({ actual, historicos, metodo = 'razon_ritmo_historico' }, cfg = CONFIG) {
    const noDisp = (motivo, extra = {}) => ({
        estado: 'PROYECCION_NO_DISPONIBLE', estimacion: null, rango: null, metodo,
        temporadas_comparables: 0, confianza: null, motivo,
        datos_base: { actual: aNumero(actual), comparables: [], descartadas: [], ...extra }, aviso: AVISO
    });
    const act = aNumero(actual);
    if (act === null) return noDisp('SIN_DATO_ACTUAL');
    if (!historicos || !historicos.length) return noDisp('SIN_HISTORICO');

    const comparables = [], descartadas = [];
    for (const h of historicos) {
        const eq = aNumero(h.equivalente), fin = aNumero(h.final);
        if (eq === null || fin === null || fin <= 0) { descartadas.push({ temporada: h.temporada, motivo: 'HISTORICO_INCOMPLETO' }); continue; }
        const avance = eq / fin;
        if (avance < cfg.PROYECCION.AVANCE_MINIMO) {
            descartadas.push({ temporada: h.temporada, motivo: `AVANCE_HISTORICO_BAJO_${Math.round(cfg.PROYECCION.AVANCE_MINIMO * 100)}%`, avance_historico: redondear(avance, 3) });
            continue;
        }
        comparables.push({ temporada: h.temporada, equivalente: eq, final: fin, avance_historico: redondear(avance, 3), estimacion: act / avance });
    }
    if (!comparables.length) return noDisp('SIN_TEMPORADA_COMPARABLE_CON_AVANCE_SUFICIENTE', { descartadas });

    const est = comparables.map(c => c.estimacion);
    return {
        estado: 'PROYECCION_DISPONIBLE',
        estimacion: Math.round(mediana(est)),
        rango: { minimo: Math.round(Math.min(...est)), maximo: Math.round(Math.max(...est)) },
        metodo,
        temporadas_comparables: comparables.length,
        confianza: etiquetaConfianza(est, cfg),
        motivo: null,
        datos_base: {
            actual: act,
            comparables: comparables.map(c => ({ ...c, estimacion: Math.round(c.estimacion) })),
            descartadas
        },
        aviso: AVISO
    };
}

// Rodeos: además informa el piso conocido (realizados + programados ya cargados).
function proyectarRodeos({ actual, programados = 0, historicos }, cfg = CONFIG) {
    const p = proyectarSerie({ actual, historicos }, cfg);
    p.datos_base.piso_calendario_conocido = (aNumero(actual) ?? 0) + (aNumero(programados) ?? 0);
    return p;
}

// Colleras: por cada temporada histórica toma la medición CONFIRMADA más cercana
// a la fecha objetivo (±tolerancia). El "final" de referencia es la ÚLTIMA
// medición confirmada de esa temporada (no necesariamente el cierre real).
function proyectarColleras({ actual, historicosPorTemporada }, cfg = CONFIG) {
    const historicos = [];
    const sinDato = [];
    for (const h of (historicosPorTemporada || [])) {
        const eq = buscarMedicionEquivalente(h.mediciones, h.fechaObjetivo, {}, cfg);
        const confirmadas = (h.mediciones || []).filter(m => m.fecha_confirmada === true && typeof m.total_colleras === 'number')
            .sort((a, b) => a.fecha_medicion.localeCompare(b.fecha_medicion));
        if (eq.estado === SIN_DATO_HISTORICO_COMPARABLE || !confirmadas.length) {
            sinDato.push({ temporada: h.temporada, motivo: SIN_DATO_HISTORICO_COMPARABLE });
            historicos.push({ temporada: h.temporada, equivalente: null, final: null });
            continue;
        }
        historicos.push({ temporada: h.temporada, equivalente: eq.medicion.total_colleras, final: confirmadas[confirmadas.length - 1].total_colleras });
    }
    const p = proyectarSerie({ actual, historicos, metodo: 'razon_ritmo_historico_colleras' }, cfg);
    p.datos_base.sin_dato_historico_comparable = sinDato;
    p.datos_base.nota_final_referencia = 'El final histórico es la última medición confirmada de cada temporada, no necesariamente su cierre real.';
    return p;
}

module.exports = { AVISO, mediana, etiquetaConfianza, proyectarSerie, proyectarRodeos, proyectarColleras };
