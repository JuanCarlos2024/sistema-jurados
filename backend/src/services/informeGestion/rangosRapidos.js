// ═════════════════════════════════════════════════════════════════════════
// Accesos rápidos de fechas del informe.
//
// "ÚLTIMO FIN DE SEMANA" usa el MISMO concepto de bloque de rodeo que las reglas de
// designación (services/feriados.js: esDiaRodeo + calcularBloqueRodeo): sábado, domingo y
// feriados consecutivos forman un solo bloque (p. ej. viernes 18 + sábado 19 + domingo 20 de
// septiembre). No hay una definición propia de "fin de semana".
//
// Es el bloque más reciente TERMINADO: su último día es anterior a hoy. Así, con hoy = lunes
// se obtiene el fin de semana que acaba de terminar; entre semana, el último completo; y con
// hoy = sábado/domingo (bloque en curso) el anterior.
// ═════════════════════════════════════════════════════════════════════════
const feriados = require('../feriados');
const { addDays, esISO } = require('./fechasEquivalentes');

const MAX_BUSQUEDA_DIAS = 60;

function ultimoFinDeSemana(hoy, deps = {}) {
    if (!esISO(hoy)) throw new Error('hoy debe ser YYYY-MM-DD');
    const esDia = deps.esDiaRodeo || feriados.esDiaRodeo;
    const bloqueDe = deps.calcularBloqueRodeo || feriados.calcularBloqueRodeo;
    let d = addDays(hoy, -1);
    for (let i = 0; i < MAX_BUSQUEDA_DIAS; i++) {
        while (!esDia(d)) d = addDays(d, -1);
        const b = bloqueDe(d, 1);
        if (b.fin < hoy) return { desde: b.inicio, hasta: b.fin };
        d = addDays(b.inicio, -1);   // el bloque aún está en curso: se usa el anterior
    }
    throw new Error('No se encontró un bloque de rodeo reciente');
}

function rangosRapidos(hoy, deps = {}) {
    return {
        hoy,
        ultimo_fin_de_semana: { ...ultimoFinDeSemana(hoy, deps), criterio: 'Bloque de rodeo terminado más reciente (sábado, domingo y feriados consecutivos; services/feriados.js)' },
        ultimos_30_dias: { desde: addDays(hoy, -29), hasta: hoy }
    };
}

module.exports = { ultimoFinDeSemana, rangosRapidos };
