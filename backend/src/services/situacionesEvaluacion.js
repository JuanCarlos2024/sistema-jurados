// ═════════════════════════════════════════════════════════════════════════
// situacionesEvaluacion.js — fuente única del desglose de "Situaciones"
// (evaluacion_casos por tipo_caso) para cualquier consumidor del sistema.
//
// Extraído tal cual de admin/hojavida.js (sin cambiar su lógica ni su
// resultado) para que el Portal del Jurado ("Mi historial de evaluaciones")
// reutilice EXACTAMENTE el mismo cálculo que ya ve el administrador en la
// Hoja de Vida — nunca un cálculo paralelo que pueda divergir.
//
// Cantidad de "situaciones" = casos reales (evaluacion_casos) de la
// evaluación técnica de cada rodeo — no depende de si el jurado respondió
// ni del estado de la evaluación. 1 caso = 1 situación (sin pasar por
// evaluacion_respuestas_jurado, que evitaba duplicar por múltiples
// respuestas pero también causaba falsos "0").
// ═════════════════════════════════════════════════════════════════════════
const supabase = require('../config/supabase');

const PAGINA_SITUACIONES = 900; // paginación defensiva — mismo criterio que hojavida.js

// Mismo mapeo de tipo_caso → etiqueta/sigla usado en todo el sistema
// (frontend/js/utils.js, admin/hojavida.html, reporte-deportivo.js).
const TIPO_SITUACION_LABEL = { interpretativa: 'Apreciación', reglamentaria: 'Reglamentaria', informativo: 'Conceptual/Informativo' };
const TIPO_SITUACION_SIGLA = { reglamentaria: 'R', interpretativa: 'A', informativo: 'C' };
const ORDEN_TIPOS_SITUACION = ['reglamentaria', 'interpretativa', 'informativo'];

// Devuelve { porRodeo: {rodeo_id: cantidad}, porTipoPorRodeo: {rodeo_id: {tipo_caso: cantidad}} }.
async function calcularSituacionesPorRodeo(rodeoIds) {
    const resultado = { porRodeo: {}, porTipoPorRodeo: {} };
    if (!rodeoIds.length) return resultado;

    const { data: evals } = await supabase
        .from('evaluaciones')
        .select('id, rodeo_id')
        .in('rodeo_id', rodeoIds);
    if (!evals || evals.length === 0) return resultado;

    const evalToRodeo = {};
    evals.forEach(e => { evalToRodeo[e.id] = e.rodeo_id; });
    const evaluacionIds = evals.map(e => e.id);

    let casos = [];
    {
        let offset = 0;
        while (true) {
            const { data: pagina, error } = await supabase
                .from('evaluacion_casos')
                .select('evaluacion_id, tipo_caso')
                .in('evaluacion_id', evaluacionIds)
                .eq('anulado', false)
                .range(offset, offset + PAGINA_SITUACIONES - 1);
            if (error) break;
            const filas = pagina || [];
            casos = casos.concat(filas);
            if (filas.length < PAGINA_SITUACIONES) break;
            offset += PAGINA_SITUACIONES;
        }
    }

    for (const c of casos) {
        const rodeoId = evalToRodeo[c.evaluacion_id];
        if (!rodeoId) continue;
        resultado.porRodeo[rodeoId] = (resultado.porRodeo[rodeoId] || 0) + 1;
        if (!resultado.porTipoPorRodeo[rodeoId]) resultado.porTipoPorRodeo[rodeoId] = {};
        resultado.porTipoPorRodeo[rodeoId][c.tipo_caso] = (resultado.porTipoPorRodeo[rodeoId][c.tipo_caso] || 0) + 1;
    }
    return resultado;
}

// Suma el desglose por tipo y el total sobre un conjunto de filas (una por
// asignación/rodeo), a partir de porTipoPorRodeo — así el total siempre
// coincide con la suma de la columna realmente mostrada en pantalla/Excel.
function acumularResumenSituaciones(filas, porTipoPorRodeo, obtenerRodeoId) {
    const porTipo = {};
    let total = 0;
    for (const fila of filas) {
        const rodeoId = obtenerRodeoId(fila);
        const tipos = porTipoPorRodeo[rodeoId];
        if (!tipos) continue;
        for (const [tipo, cant] of Object.entries(tipos)) {
            porTipo[tipo] = (porTipo[tipo] || 0) + cant;
            total += cant;
        }
    }
    return { porTipo, total };
}

module.exports = {
    calcularSituacionesPorRodeo,
    acumularResumenSituaciones,
    TIPO_SITUACION_LABEL,
    TIPO_SITUACION_SIGLA,
    ORDEN_TIPOS_SITUACION
};
