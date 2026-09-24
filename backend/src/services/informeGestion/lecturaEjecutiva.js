// ═════════════════════════════════════════════════════════════════════════
// SITUACIÓN GENERAL DE TEMPORADA — frases 100 % determinísticas (reglas objetivas; sin IA generativa).
//
// Cada frase sale de una regla sobre datos ya calculados. Solo se describen hechos con lenguaje neutro
// (más / menos / sobre / bajo / menor actividad / señal de seguimiento): nunca "mejor", "peor" ni juicios.
// Se muestran como máximo cfg.EJECUTIVO.MAX_FRASES, según cfg.EJECUTIVO.PRIORIDAD_FRASES.
// ═════════════════════════════════════════════════════════════════════════
const CONFIG = require('./config');

const NF1 = new Intl.NumberFormat('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pct = n => `${NF1.format(n)} %`;
const plural = (n, uno, varios) => (n === 1 ? uno : varios);
const get = (o, ruta, def = null) => ruta.split('.').reduce((a, k) => (a === null || a === undefined ? a : a[k]), o) ?? def;

function fraseActividad(inf) {
    const c = get(inf, 'comparacion.rodeos');
    const ref = get(inf, 'comparacion.referencia.temporada');
    if (!c || !c.disponible || !ref) return null;
    const n = Math.abs(c.diferencia);
    const texto = c.diferencia === 0 ? `La actividad acumulada se mantiene igual a ${ref} a fecha equivalente.`
        : `La actividad acumulada registra ${n} ${plural(n, 'rodeo', 'rodeos')} ${c.diferencia > 0 ? 'más' : 'menos'} que ${ref} a fecha equivalente.`;
    return { codigo: 'ACTIVIDAD', etiqueta: 'ACTIVIDAD', texto };
}

function fraseColleras(inf) {
    const filas = get(inf, 'colleras.comparacion.temporadas', []) || [];
    const ok = filas.find(t => t.estado === 'OK');
    if (!ok || ok.variacion_pct === null || ok.variacion_pct === undefined) {
        return { codigo: 'COLLERAS', etiqueta: 'COLLERAS', texto: 'No existe referencia histórica comparable de colleras para esta fecha.' };
    }
    const v = ok.variacion_pct;
    const texto = v === 0 ? `Las colleras completas se encuentran iguales a ${ok.temporada} a fecha equivalente.`
        : `Las colleras completas se encuentran ${pct(Math.abs(v))} ${v > 0 ? 'sobre' : 'bajo'} ${ok.temporada} a fecha equivalente.`;
    return { codigo: 'COLLERAS', etiqueta: 'COLLERAS', texto };
}

function fraseAsociaciones(inf) {
    const a = inf.asociaciones;
    const ref = get(inf, 'comparacion.referencia.temporada');
    if (!a || !a.catalogo_disponible || !a.resumen || !ref) return null;
    // "0 actual / > 0 histórico" se destaca antes que el 0/0 (que no es alerta).
    const sinRel = a.resumen.sin_actividad_con_historico_positivo;
    const caidas = a.resumen.caida_relevante_alertables;
    if (sinRel > 0) {
        const extra = caidas > 0 ? `; ${caidas} ${plural(caidas, 'presenta', 'presentan')} menor actividad` : '';
        return { codigo: 'ASOCIACIONES', etiqueta: 'ASOCIACIONES', texto: `${sinRel} ${plural(sinRel, 'asociación sin rodeos registra', 'asociaciones sin rodeos registran')} rodeos en ${ref} a fecha equivalente${extra}.` };
    }
    if (caidas > 0) return { codigo: 'ASOCIACIONES', etiqueta: 'ASOCIACIONES', texto: `${caidas} ${plural(caidas, 'asociación presenta', 'asociaciones presentan')} menor actividad respecto de ${ref} a fecha equivalente.` };
    return null;
}

function fraseCobertura(inf) {
    const c = get(inf, 'cobertura.acumulado_temporada.evaluaciones_publicadas');
    if (!c || !c.denominador || c.interpretable !== false) return null;
    return { codigo: 'COBERTURA', etiqueta: 'COBERTURA', texto: `La cobertura de evaluaciones publicadas es ${pct(c.porcentaje)}, por lo que los indicadores derivados deben interpretarse con cautela.` };
}

function fraseJurados(inf) {
    const s = (inf.senales || []).find(x => x.codigo === 'JURADO_REINCIDENCIA');
    const n = s && Array.isArray(s.evidencia) ? s.evidencia.length : 0;
    if (!n) return null;
    return { codigo: 'JURADOS', etiqueta: 'JURADOS', texto: `${n} ${plural(n, 'jurado presenta', 'jurados presentan')} señales objetivas de seguimiento.` };
}

const REGLAS = { ACTIVIDAD: fraseActividad, COLLERAS: fraseColleras, ASOCIACIONES: fraseAsociaciones, COBERTURA: fraseCobertura, JURADOS: fraseJurados };

function lecturaEjecutiva(inf, cfg = CONFIG) {
    const frases = [];
    cfg.EJECUTIVO.PRIORIDAD_FRASES.forEach((codigo, i) => {
        const f = REGLAS[codigo] ? REGLAS[codigo](inf) : null;
        if (f) frases.push({ ...f, prioridad: i + 1 });
    });
    return frases.slice(0, cfg.EJECUTIVO.MAX_FRASES);
}

module.exports = { lecturaEjecutiva, REGLAS };
