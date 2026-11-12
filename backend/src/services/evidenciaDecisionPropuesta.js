/**
 * Evidencia de la DECISIÓN ADMINISTRATIVA INDIVIDUAL de una fila de propuesta.
 *
 * Fuente única (pura, sin BD) usada por: la pantalla de Propuesta (GET
 * /propuestas/:id), el Historial Unificado + Excel y el script de
 * regularización 018. Nunca modifica datos: solo interpreta.
 *
 * Por qué existe: hasta el 11/11/2026, guardar un borrador reclasificaba
 * filas PENDIENTE como ACEPTADO/MOTOR o MODIFICADO/MANUAL_CON_ADVERTENCIA sin
 * ninguna acción del administrador. Por eso `estado_revision` por sí solo NO
 * prueba una decisión: hace falta evidencia.
 *
 * Qué cuenta como evidencia de una decisión individual:
 *   - bitácora `modificacion_manual_borrador` de la fila (cambio de jurado);
 *   - auditoría de la fila (tabla propuestas_designacion_detalle) que registra
 *     ACEPTADO/MODIFICADO (Confirmar / Modificar / preview auditado);
 *   - metricas_json.revision_administrativa (marca escrita junto a la acción).
 * Qué NO cuenta (son otros eventos, nunca una confirmación individual):
 *   - bitácora `aplicacion_propuesta` y la auditoría `crear` de la asignación
 *     → APLICACIÓN COLECTIVA de la propuesta;
 *   - publicación, aceptación/rechazo del jurado, anulación;
 *   - auditoría `regularizar` (corrección técnica del estado).
 */

const DECISION = {
    PENDIENTE: 'PENDIENTE',                                    // sin decisión (correcto)
    CONFIRMACION_COMPROBADA: 'CONFIRMACION_COMPROBADA',        // check verde con evidencia
    MODIFICACION_COMPROBADA: 'MODIFICACION_COMPROBADA',        // cambio de jurado con evidencia
    MODIFICACION_SIN_REGISTRO: 'MODIFICACION_SIN_REGISTRO',    // jurado distinto, sin autor/motivo registrado
    CLASIFICACION_AUTOMATICA: 'CLASIFICACION_AUTOMATICA',      // ACEPTADO/MODIFICADO puesto al guardar, sin evidencia
    SIN_JURADO: 'SIN_JURADO',
    NO_EVALUABLE: 'NO_EVALUABLE',
};

const ETIQUETA_DECISION = {
    PENDIENTE: 'Pendiente de revisión (sin decisión individual)',
    CONFIRMACION_COMPROBADA: 'Confirmación individual registrada',
    MODIFICACION_COMPROBADA: 'Modificación administrativa registrada',
    MODIFICACION_SIN_REGISTRO: 'Jurado cambiado sin registro individual (autor y motivo no registrados)',
    CLASIFICACION_AUTOMATICA: 'Clasificación automática al guardar — sin confirmación individual registrada',
    SIN_JURADO: 'Sin jurado',
    NO_EVALUABLE: 'No evaluable',
};

const TIPOS_BITACORA_DECISION = new Set(['modificacion_manual_borrador']);

/**
 * @param detalle  fila de propuestas_designacion_detalle
 * @param ev.bitacora    movimientos de bitácora DE ESTA FILA ({tipo_movimiento, ...})
 * @param ev.auditoria   auditoría DE ESTA FILA (tabla propuestas_designacion_detalle)
 * @param ev.asignaciones asignaciones reales con propuesta_detalle_id = esta fila
 */
function clasificarDecisionFila(detalle, ev = {}) {
    const d = detalle || {};
    const bit = ev.bitacora || [];
    const aud = (ev.auditoria || []).filter(a => a.accion !== 'regularizar');
    const asig = ev.asignaciones || [];

    const fuentes = [];
    const bitDecision = bit.filter(b => TIPOS_BITACORA_DECISION.has(b.tipo_movimiento));
    if (bitDecision.length) fuentes.push('bitacora');
    const audDecision = aud.filter(a => ['ACEPTADO', 'MODIFICADO'].includes(a.datos_nuevos?.estado_revision));
    if (audDecision.length) fuentes.push('auditoria');
    if (d.metricas_json?.revision_administrativa) fuentes.push('revision_administrativa');

    const juradoCambiado = !!(d.jurado_id_seleccionado && d.jurado_id_seleccionado !== d.jurado_id_propuesto);
    let decision;
    if (d.estado_revision === 'NO_EVALUABLE') decision = DECISION.NO_EVALUABLE;
    else if (['SIN_PROPUESTA', 'SIN_JURADO_ACTUAL'].includes(d.estado_revision)) decision = DECISION.SIN_JURADO;
    else if (d.estado_revision === 'PENDIENTE') decision = d.jurado_id_propuesto ? DECISION.PENDIENTE : DECISION.SIN_JURADO;
    else if (['ACEPTADO', 'MODIFICADO'].includes(d.estado_revision)) {
        if (juradoCambiado) decision = fuentes.length ? DECISION.MODIFICACION_COMPROBADA : DECISION.MODIFICACION_SIN_REGISTRO;
        else decision = fuentes.length ? DECISION.CONFIRMACION_COMPROBADA : DECISION.CLASIFICACION_AUTOMATICA;
    } else decision = DECISION.PENDIENTE;

    const activas = asig.filter(a => a.estado !== 'anulado');
    return {
        decision,
        etiqueta: ETIQUETA_DECISION[decision],
        comprobada: decision === DECISION.CONFIRMACION_COMPROBADA || decision === DECISION.MODIFICACION_COMPROBADA,
        fuentes,
        movimientos_modificacion: bitDecision.length,
        aplicacion: {
            aplicada: asig.length > 0,
            asignaciones: asig.length,
            activas: activas.length,
            anuladas: asig.length - activas.length,
            publicadas: activas.filter(a => a.publicado).length,
        },
    };
}

/** Agrupa fuentes por propuesta_detalle_id / registro_id para muchas filas. */
function indexarEvidencia({ bitacora = [], auditoria = [], asignaciones = [] }) {
    const grupo = (filas, clave) => {
        const m = new Map();
        filas.forEach(f => {
            const k = f[clave] == null ? null : String(f[clave]);
            if (!k) return;
            if (!m.has(k)) m.set(k, []);
            m.get(k).push(f);
        });
        return m;
    };
    const bit = grupo(bitacora, 'propuesta_detalle_id');
    const aud = grupo(auditoria.filter(a => a.tabla === 'propuestas_designacion_detalle'), 'registro_id');
    const asig = grupo(asignaciones, 'propuesta_detalle_id');
    return id => ({ bitacora: bit.get(String(id)) || [], auditoria: aud.get(String(id)) || [], asignaciones: asig.get(String(id)) || [] });
}

function contarDecisiones(clasificaciones) {
    const c = Object.fromEntries(Object.values(DECISION).map(k => [k, 0]));
    (clasificaciones || []).forEach(x => { c[x.decision] = (c[x.decision] || 0) + 1; });
    return c;
}

module.exports = { DECISION, ETIQUETA_DECISION, clasificarDecisionFila, indexarEvidencia, contarDecisiones };
