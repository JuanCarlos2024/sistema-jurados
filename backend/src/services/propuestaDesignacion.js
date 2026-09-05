// ═════════════════════════════════════════════════════════════════════════
// Propuesta de Designación — Etapa 4: reglas puras de la propuesta BORRADOR.
//
// Todo lo de aquí es lógica de ORQUESTACIÓN de la propuesta (qué fila crear,
// qué estado corresponde tras una selección, si hay conflicto con otra fila
// de la MISMA propuesta). NO reimplementa ninguna regla del motor — la
// elegibilidad de un candidato para un rodeo sigue viniendo exclusivamente
// de evaluarCandidato()/ejecutarSimulacion() en motorPropuestaDesignacion.js.
//
// Todas las funciones son puras (no tocan la base de datos) — el router es
// quien las usa junto con las consultas reales.
// ═════════════════════════════════════════════════════════════════════════
const { bloquesSeSuperponen, bloquesSonConsecutivos } = require('./motorPropuestaDesignacion');
const { mismaAsociacion } = require('./asociaciones');

const ESTADOS_REVISION = ['PENDIENTE', 'ACEPTADO', 'MODIFICADO', 'SIN_PROPUESTA', 'NO_EVALUABLE'];
const ORIGENES_SELECCION = ['MOTOR', 'MANUAL', 'MANUAL_CON_ADVERTENCIA'];

// ─── Construye la fila de detalle a partir de UN resultado de ────────────
// ejecutarSimulacion() (el mismo objeto que ya devuelve el dry-run, sin
// transformarlo). Es la única función que traduce "resultado de simulación"
// a "fila de propuestas_designacion_detalle" — así el mapeo es consistente
// sin importar desde dónde se llame.
function construirDetalleDesdeResultado(resultado) {
    if (resultado.estado === 'PROPUESTO') {
        return {
            rodeo_id: resultado.rodeo_id,
            jurado_id_propuesto: resultado.jurado_propuesto.jurado_id,
            jurado_id_seleccionado: null,
            estado_revision: 'PENDIENTE',
            origen_seleccion: null,
            explicacion_json: {
                jurado_propuesto: resultado.jurado_propuesto,
                top_candidatos: resultado.top_candidatos || []
            },
            metricas_json: {
                candidatos_evaluados: resultado.candidatos_evaluados,
                candidatos_potenciales_bd: resultado.candidatos_potenciales_bd,
                descartes: resultado.descartes
            }
        };
    }

    if (resultado.estado === 'SIN_PROPUESTA') {
        return {
            rodeo_id: resultado.rodeo_id,
            jurado_id_propuesto: null,
            jurado_id_seleccionado: null,
            estado_revision: 'SIN_PROPUESTA',
            origen_seleccion: null,
            explicacion_json: { descartados: resultado.descartados || [] },
            metricas_json: {
                candidatos_evaluados: resultado.candidatos_evaluados,
                candidatos_potenciales_bd: resultado.candidatos_potenciales_bd,
                descartes: resultado.descartes
            }
        };
    }

    // NO_EVALUABLE
    return {
        rodeo_id: resultado.rodeo_id,
        jurado_id_propuesto: null,
        jurado_id_seleccionado: null,
        estado_revision: 'NO_EVALUABLE',
        origen_seleccion: null,
        explicacion_json: { causa: resultado.causa || null },
        metricas_json: {}
    };
}

// ─── Conflicto interno de la propuesta ────────────────────────────────────
// Compara el candidato que se está por seleccionar en `rodeoActual` contra
// las DEMÁS filas ya aceptadas/modificadas de la MISMA propuesta (no contra
// la base de datos general — eso ya lo hace el motor). Reutiliza los mismos
// helpers de bloque/asociación que usa el motor, sin reimplementarlos.
//
// @param rodeoActual {id, club, fecha, asociacion, bloque:{inicio,fin}}
// @param juradoId - candidato que se evalúa para rodeoActual
// @param otrasFilas [{ jurado_id_seleccionado, rodeo:{id,club,fecha,asociacion,bloque} }]
// @returns [{ tipo:'MISMO_FINDE'|'FINDE_CONSECUTIVO'|'ASOCIACION_REPETIDA_EN_PROPUESTA', rodeo_id, club, fecha }]
function detectarConflictoInterno(rodeoActual, juradoId, otrasFilas) {
    const conflictos = [];
    for (const fila of (otrasFilas || [])) {
        if (!fila.jurado_id_seleccionado || fila.jurado_id_seleccionado !== juradoId) continue;
        if (fila.rodeo.id === rodeoActual.id) continue; // no compararse consigo misma

        if (bloquesSeSuperponen(fila.rodeo.bloque, rodeoActual.bloque)) {
            conflictos.push({ tipo: 'MISMO_FINDE', rodeo_id: fila.rodeo.id, club: fila.rodeo.club, fecha: fila.rodeo.fecha });
        } else if (bloquesSonConsecutivos(fila.rodeo.bloque, rodeoActual.bloque)) {
            conflictos.push({ tipo: 'FINDE_CONSECUTIVO', rodeo_id: fila.rodeo.id, club: fila.rodeo.club, fecha: fila.rodeo.fecha });
        }

        if (mismaAsociacion(fila.rodeo.asociacion, rodeoActual.asociacion)) {
            conflictos.push({ tipo: 'ASOCIACION_REPETIDA_EN_PROPUESTA', rodeo_id: fila.rodeo.id, club: fila.rodeo.club, fecha: fila.rodeo.fecha });
        }
    }
    return conflictos;
}

// ─── Decide estado_revision/origen_seleccion tras una selección ──────────
// (aceptar el propuesto, modificar por otro válido, o excepción manual con
// advertencias ya confirmadas por el administrador). No decide SI hay
// advertencias — eso ya viene calculado (causas del motor + conflictos
// internos); esta función solo traduce esa información a un estado.
//
// @param juradoId - candidato finalmente seleccionado
// @param juradoIdPropuesto - jurado_id_propuesto original de esta fila (o null)
// @param advertencias - array combinado de causas de regla + conflictos internos
function decidirEstadoSeleccion(juradoId, juradoIdPropuesto, advertencias) {
    if (advertencias && advertencias.length > 0) {
        return { estado_revision: 'MODIFICADO', origen_seleccion: 'MANUAL_CON_ADVERTENCIA' };
    }
    if (juradoIdPropuesto && juradoId === juradoIdPropuesto) {
        return { estado_revision: 'ACEPTADO', origen_seleccion: 'MOTOR' };
    }
    return { estado_revision: 'MODIFICADO', origen_seleccion: 'MANUAL' };
}

// ─── Resumen de una propuesta a partir de sus filas de detalle ───────────
function resumenPropuesta(filasDetalle) {
    const contar = (estado) => (filasDetalle || []).filter(f => f.estado_revision === estado).length;
    return {
        total_rodeos: (filasDetalle || []).length,
        aceptados: contar('ACEPTADO'),
        modificados: contar('MODIFICADO'),
        pendientes: contar('PENDIENTE'),
        sin_propuesta: contar('SIN_PROPUESTA'),
        no_evaluables: contar('NO_EVALUABLE')
    };
}

module.exports = {
    ESTADOS_REVISION, ORIGENES_SELECCION,
    construirDetalleDesdeResultado, detectarConflictoInterno, decidirEstadoSeleccion, resumenPropuesta
};
