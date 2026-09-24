// ═════════════════════════════════════════════════════════════════════════
// Rango histórico equivalente de un PERÍODO seleccionado.
//
// Regla general (rangos personalizados, p. ej. varias semanas): el rango se desplaza k×52 semanas
// (fechasEquivalentes.desplazarFechaEquivalente), conservando el día de la semana.
//
// Excepción — el período seleccionado es EXACTAMENTE UN bloque de rodeo (services/feriados.js:
// sábado, domingo y feriados consecutivos, p. ej. Fiestas Patrias 18–20/09/2026): se compara contra
// el BLOQUE HISTÓRICO EQUIVALENTE COMPLETO. Motivo (auditoría Fiestas Patrias): al desplazar 364 días,
// el viernes 18/09/2026 cae en viernes 19/09/2025 y el jueves feriado 18/09/2025 (donde se concentró
// la mayor parte de los rodeos) quedaba fuera de la comparación: 25 vs 10 (+150 %) en lugar de
// 25 vs 25 (0 %).
//
// Las funciones de bloque son las del sistema (feriados.js); no hay otra definición de "fin de semana".
// ═════════════════════════════════════════════════════════════════════════
const feriados = require('../feriados');
const F = require('./fechasEquivalentes');
const CONFIG = require('./config');

const MODO = { BLOQUE: 'BLOQUE_DE_RODEO', RANGO: 'RANGO_DESPLAZADO' };

function esUnSoloBloque(desde, hasta, deps = {}) {
    const bloqueDe = deps.calcularBloqueRodeo || feriados.calcularBloqueRodeo;
    const esDia = deps.esDiaRodeo || feriados.esDiaRodeo;
    if (!esDia(desde)) return false;
    const b = bloqueDe(desde, 1);
    return b.inicio === desde && b.fin === hasta;
}

function rangoHistoricoPeriodo({ desde, hasta, k = 1, cfg = CONFIG, deps = {} }) {
    const bloqueDe = deps.calcularBloqueRodeo || feriados.calcularBloqueRodeo;
    const dDes = F.desplazarFechaEquivalente(desde, k, cfg);
    const dHas = F.desplazarFechaEquivalente(hasta, k, cfg);
    if (esUnSoloBloque(desde, hasta, deps)) {
        const b1 = bloqueDe(dDes, 1), b2 = bloqueDe(dHas, 1);
        return {
            modo: MODO.BLOQUE,
            desde: b1.inicio < b2.inicio ? b1.inicio : b2.inicio,
            hasta: b1.fin > b2.fin ? b1.fin : b2.fin,
            rango_desplazado: { desde: dDes, hasta: dHas }
        };
    }
    return { modo: MODO.RANGO, desde: dDes, hasta: dHas, rango_desplazado: { desde: dDes, hasta: dHas } };
}

module.exports = { MODO, esUnSoloBloque, rangoHistoricoPeriodo };
