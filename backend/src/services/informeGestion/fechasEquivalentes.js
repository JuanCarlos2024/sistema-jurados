// ═════════════════════════════════════════════════════════════════════════
// Motor de fechas equivalentes entre temporadas.
//
// RODEOS: se desplaza en múltiplos de 52 semanas (364 días) para conservar
// el DÍA DE LA SEMANA (los rodeos se concentran en sábado/domingo). Como 364
// días es un día (o dos, en bisiesto) menos que un año calendario, la deriva
// se acumula al retroceder varias temporadas; se corrige sumando/restando
// SEMANAS COMPLETAS hasta quedar lo más cerca posible (≤ 3 días) de la misma
// fecha calendario. Nunca se asume "mismo día/mes" a secas.
//
//   domingo 20/09/2026 → k=1 → domingo 21/09/2025
//   domingo 20/09/2026 → k=3 → domingo 17/09/2023 (24/09 quedaría a 4 días)
//
// COLLERAS: se busca la medición histórica REAL más cercana con tolerancia
// (por defecto ±7 días). Empate de distancia → la medición ANTERIOR a la
// fecha objetivo (regla determinística). Sin medición dentro de la tolerancia
// → SIN_DATO_HISTORICO_COMPARABLE. Nunca se interpola ni se usa 0 por vacío.
// ═════════════════════════════════════════════════════════════════════════
const CONFIG = require('./config');

const MS_DIA = 86400000;
const SIN_DATO_HISTORICO_COMPARABLE = 'SIN_DATO_HISTORICO_COMPARABLE';

function esISO(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

function parseISO(s) {
    if (!esISO(s)) throw new Error(`Fecha inválida (se esperaba YYYY-MM-DD): ${s}`);
    return new Date(s + 'T00:00:00Z');
}

function toISO(d) { return d.toISOString().slice(0, 10); }
function addDays(iso, n) { return toISO(new Date(parseISO(iso).getTime() + n * MS_DIA)); }
function diffDays(a, b) { return Math.round((parseISO(a).getTime() - parseISO(b).getTime()) / MS_DIA); }
function diaSemana(iso) { return parseISO(iso).getUTCDay(); }
function esBisiesto(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function esFinDeSemana(iso) { const d = diaSemana(iso); return d === 0 || d === 6; }

// Misma fecha calendario k años atrás (29/02 → 28/02 si el año destino no es bisiesto).
function mismoDiaCalendarioAnterior(iso, k = 1) {
    const [y, m, d] = iso.split('-').map(Number);
    const yy = y - k;
    const dd = (m === 2 && d === 29 && !esBisiesto(yy)) ? 28 : d;
    return `${String(yy).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

// Fecha equivalente k temporadas atrás, conservando el día de la semana.
function desplazarFechaEquivalente(iso, k = 1, cfg = CONFIG) {
    parseISO(iso);
    const base = addDays(iso, -cfg.FECHAS.DIAS_POR_ANIO_SEMANAL * k);
    const cal = mismoDiaCalendarioAnterior(iso, k);
    const m = -Math.round(diffDays(base, cal) / 7);
    return addDays(base, 7 * m);
}

// Inversa de la anterior: lleva una fecha HISTÓRICA (k temporadas atrás) al punto equivalente de la
// temporada ACTUAL (para superponer curvas de varias temporadas en un mismo eje).
function desplazarFechaHaciaAdelante(iso, k = 1, cfg = CONFIG) {
    parseISO(iso);
    const base = addDays(iso, cfg.FECHAS.DIAS_POR_ANIO_SEMANAL * k);
    const cal = mismoDiaCalendarioAnterior(iso, -k);
    const m = -Math.round(diffDays(base, cal) / 7);
    return addDays(base, 7 * m);
}

// '2026-2027' → '2025-2026' (k=1), '2024-2025' (k=2)…
function temporadaAnterior(nombre, k = 1) {
    const m = /^(\d{4})-(\d{4})$/.exec(String(nombre || '').trim());
    if (!m) return null;
    return `${Number(m[1]) - k}-${Number(m[2]) - k}`;
}

// k = diferencia en temporadas entre dos nombres ('2026-2027' vs '2025-2026' → 1).
function distanciaTemporadas(actual, historica) {
    const a = /^(\d{4})-(\d{4})$/.exec(String(actual || '').trim());
    const h = /^(\d{4})-(\d{4})$/.exec(String(historica || '').trim());
    if (!a || !h) return null;
    const k = Number(a[1]) - Number(h[1]);
    return k >= 1 ? k : null;
}

// Ventana completa equivalente (inicio, corte, fin) k temporadas atrás.
function ventanaEquivalente({ inicio, corte, fin }, k = 1, cfg = CONFIG) {
    return {
        k,
        inicio: desplazarFechaEquivalente(inicio, k, cfg),
        corte: desplazarFechaEquivalente(corte, k, cfg),
        fin: desplazarFechaEquivalente(fin, k, cfg)
    };
}

// Porcentaje de avance de la temporada en `fecha` (0..1, acotado).
function avanceTemporada(fecha, inicio, fin) {
    const total = diffDays(fin, inicio);
    if (total <= 0) return null;
    return Math.min(1, Math.max(0, diffDays(fecha, inicio) / total));
}

// Medición histórica de colleras más cercana a `fechaObjetivo`.
// Solo cuenta mediciones con fecha_confirmada === true y total numérico.
function buscarMedicionEquivalente(mediciones, fechaObjetivo, opciones = {}, cfg = CONFIG) {
    const tolerancia = opciones.toleranciaDias ?? cfg.FECHAS.COLLERAS_TOLERANCIA_DIAS;
    parseISO(fechaObjetivo);
    let mejor = null;
    for (const m of (mediciones || [])) {
        if (m.fecha_confirmada !== true) continue;
        if (!esISO(m.fecha_medicion)) continue;
        if (typeof m.total_colleras !== 'number' || !Number.isFinite(m.total_colleras)) continue;
        const dif = diffDays(m.fecha_medicion, fechaObjetivo);
        const abs = Math.abs(dif);
        if (abs > tolerancia) continue;
        if (!mejor || abs < mejor.abs || (abs === mejor.abs && dif < mejor.dif)) mejor = { m, dif, abs };
    }
    if (!mejor) {
        return { estado: SIN_DATO_HISTORICO_COMPARABLE, medicion: null, diferencia_dias: null, tolerancia_dias: tolerancia };
    }
    return { estado: 'OK', medicion: mejor.m, diferencia_dias: mejor.dif, tolerancia_dias: tolerancia };
}

// Fecha de hoy en Chile (YYYY-MM-DD) a partir de un Date.
function hoyChile(ahora = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora);
}

module.exports = {
    SIN_DATO_HISTORICO_COMPARABLE,
    esISO, parseISO, toISO, addDays, diffDays, diaSemana, esFinDeSemana, esBisiesto,
    mismoDiaCalendarioAnterior, desplazarFechaEquivalente, desplazarFechaHaciaAdelante, temporadaAnterior, distanciaTemporadas,
    ventanaEquivalente, avanceTemporada, buscarMedicionEquivalente, hoyChile
};
