// ═════════════════════════════════════════════════════════════════════════
// CORTE DEPORTIVO ANTERIOR.
//
// Todavía no se guarda un historial de PDFs emitidos, así que "corte anterior" NO es "el informe anterior":
// es el cierre del BLOQUE DE RODEO inmediatamente anterior al bloque del corte actual, con la misma lógica
// deportiva del sistema (services/feriados.js: esDiaRodeo + calcularBloqueRodeo; sábado, domingo y feriados
// consecutivos forman un solo bloque).
//
//   corte actual 24/09/2026 → último día de rodeo ≤ corte = 20/09 → bloque actual 18–20 SEP
//   → bloque anterior 12–13 SEP → corte anterior = 13/09/2026 (acumulado de temporada hasta esa fecha)
//
// Si no existe un bloque anterior dentro de la temporada → SIN CORTE ANTERIOR COMPARABLE (no se inventan fechas).
// ═════════════════════════════════════════════════════════════════════════
const feriados = require('../feriados');
const CONFIG = require('./config');
const { addDays } = require('./fechasEquivalentes');
const { etiquetaBloque } = require('./series');

const SIN_CORTE_ANTERIOR = 'SIN_CORTE_ANTERIOR_COMPARABLE';

function ultimoDiaRodeoHasta(fecha, esDia, limite) {
    let d = fecha;
    for (let i = 0; i < limite; i++) { if (esDia(d)) return d; d = addDays(d, -1); }
    return null;
}

function calcularCorteAnterior({ corte, T, cfg = CONFIG, deps = {} }) {
    const esDia = deps.esDiaRodeo || feriados.esDiaRodeo;
    const bloqueDe = deps.calcularBloqueRodeo || feriados.calcularBloqueRodeo;
    const limite = cfg.EJECUTIVO.MAX_BUSQUEDA_DIAS_BLOQUE;

    const diaActual = ultimoDiaRodeoHasta(corte, esDia, limite);
    if (!diaActual) return { disponible: false, motivo: SIN_CORTE_ANTERIOR, actual: { corte, bloque: null }, anterior: null };
    const bActual = bloqueDe(diaActual, 1);
    const actual = { corte, bloque: { inicio: bActual.inicio, fin: bActual.fin, etiqueta: etiquetaBloque(bActual.inicio, bActual.fin) } };

    const diaPrevio = ultimoDiaRodeoHasta(addDays(bActual.inicio, -1), esDia, limite);
    if (!diaPrevio) return { disponible: false, motivo: SIN_CORTE_ANTERIOR, actual, anterior: null };
    const bPrev = bloqueDe(diaPrevio, 1);
    // El bloque anterior debe estar dentro de la temporada (si no, no hay acumulado comparable).
    if (bPrev.fin < T.inicio) return { disponible: false, motivo: SIN_CORTE_ANTERIOR, actual, anterior: null };
    return {
        disponible: true, motivo: null, actual,
        anterior: { corte: bPrev.fin, bloque: { inicio: bPrev.inicio, fin: bPrev.fin, etiqueta: etiquetaBloque(bPrev.inicio, bPrev.fin) } },
        definicion: 'Corte deportivo anterior = cierre del bloque de rodeo inmediatamente anterior al bloque del corte actual (no es el informe anterior emitido).'
    };
}

module.exports = { SIN_CORTE_ANTERIOR, calcularCorteAnterior };
