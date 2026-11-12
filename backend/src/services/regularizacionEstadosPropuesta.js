/**
 * Diagnóstico (y, solo donde es seguro, regularización) de estados
 * administrativos FALSOS en un borrador de propuesta. Causa: hasta el
 * 11/11/2026, POST /propuestas reclasificaba filas PENDIENTE como
 * ACEPTADO/MOTOR o MODIFICADO/MANUAL_CON_ADVERTENCIA al guardar, sin acción
 * administrativa (corregido con decidirEstadoAlGuardar en propuestaDesignacion.js).
 *
 * Clasificación PURA (sin BD). La evidencia de decisión individual la decide
 * evidenciaDecisionPropuesta.js (fuente única compartida con la pantalla y el
 * Historial). Cada fila se separa en categorías INDEPENDIENTES:
 *   - decisión del borrador: clasificación automática potencialmente errónea /
 *     modificación administrativa comprobada / confirmación comprobada /
 *     pendiente / sin jurado;
 *   - aplicación real posterior: asignaciones vinculadas (activas,
 *     publicadas, anuladas).
 *
 * BLOQUEO DE SEGURIDAD (no se salta con ningún parámetro): si CUALQUIER fila
 * de la propuesta ya generó una asignación real (activa o anulada), o la
 * propuesta no está en BORRADOR, NO se corrige ninguna fila. Para esas
 * propuestas la interpretación correcta se hace en la capa de visualización
 * y reportes; modificar sus datos requeriría un procedimiento de
 * regularización histórica distinto, diseñado y aprobado aparte.
 */
const { DECISION, clasificarDecisionFila, indexarEvidencia } = require('./evidenciaDecisionPropuesta');

const CATEGORIA = {
    CLASIFICACION_AUTOMATICA: 'Clasificación automática potencialmente errónea (sin evidencia de decisión individual)',
    MODIFICACION_COMPROBADA: 'Modificación administrativa comprobada',
    MODIFICACION_SIN_REGISTRO: 'Jurado cambiado sin registro individual',
    CONFIRMACION_COMPROBADA: 'Confirmación individual comprobada',
    SIN_DECISION: 'Sin decisión atribuida (estado ya correcto)',
};

function evaluarBloqueoEscritura({ propuesta, asignaciones }) {
    const motivos = [];
    if (propuesta?.estado !== 'BORRADOR') motivos.push(`La propuesta está en estado ${propuesta?.estado || 'desconocido'}, no BORRADOR`);
    const asig = asignaciones || [];
    if (asig.length > 0) {
        const anuladas = asig.filter(a => a.estado === 'anulado').length;
        motivos.push(`La propuesta ya tiene ${asig.length} asignación(es) real(es) vinculada(s) (${asig.length - anuladas} activa(s), ${anuladas} anulada(s)). ` +
            'Sus filas son registro histórico de una aplicación ya consumada: este script no las modifica. ' +
            'Requiere un procedimiento de regularización histórica específico, diseñado y aprobado aparte.');
    }
    return { bloqueada: motivos.length > 0, motivos };
}

function categoriaDe(decision) {
    switch (decision) {
        case DECISION.CLASIFICACION_AUTOMATICA: return 'CLASIFICACION_AUTOMATICA';
        case DECISION.MODIFICACION_COMPROBADA: return 'MODIFICACION_COMPROBADA';
        case DECISION.MODIFICACION_SIN_REGISTRO: return 'MODIFICACION_SIN_REGISTRO';
        case DECISION.CONFIRMACION_COMPROBADA: return 'CONFIRMACION_COMPROBADA';
        default: return 'SIN_DECISION';
    }
}

function clasificarFilasRegularizacion({ propuesta, detalles, bitacora, auditoria, asignaciones }) {
    const evidencia = indexarEvidencia({ bitacora: bitacora || [], auditoria: auditoria || [], asignaciones: asignaciones || [] });
    const bloqueo = evaluarBloqueoEscritura({ propuesta, asignaciones });

    return (detalles || []).map(d => {
        const ev = evidencia(d.id);
        const clas = clasificarDecisionFila(d, ev);
        const antes = {
            estado_revision: d.estado_revision, origen_seleccion: d.origen_seleccion ?? null,
            jurado_id_propuesto: d.jurado_id_propuesto ?? null, jurado_id_seleccionado: d.jurado_id_seleccionado ?? null,
        };
        const categoria = categoriaDe(clas.decision);
        const base = {
            detalle_id: d.id, rodeo_id: d.rodeo_id, antes, despues: { ...antes }, corregir: false,
            categoria, categoria_etiqueta: CATEGORIA[categoria], decision: clas.decision, fuentes_evidencia: clas.fuentes,
            movimientos_modificacion: clas.movimientos_modificacion, aplicacion: clas.aplicacion,
            tratamiento: 'Se conserva tal cual',
        };

        if (categoria === 'MODIFICACION_COMPROBADA') return { ...base, razon: `Cambio real de jurado con evidencia (${clas.fuentes.join(', ')}) — se conserva` };
        if (categoria === 'CONFIRMACION_COMPROBADA') return { ...base, razon: `Confirmación con evidencia (${clas.fuentes.join(', ')}) — se conserva` };
        if (categoria === 'MODIFICACION_SIN_REGISTRO') return { ...base, razon: 'Jurado distinto del propuesto sin registro individual — es un cambio real (el motor no elige otro jurado), se conserva; autor y motivo: sin información registrada' };
        if (categoria === 'SIN_DECISION') return { ...base, razon: 'Estado sin decisión administrativa atribuida — ya correcto' };

        // CLASIFICACION_AUTOMATICA: candidata a corrección solo si nada la bloquea.
        if (clas.aplicacion.aplicada) {
            return { ...base, tratamiento: 'Interpretación corregida en pantalla, Historial y Excel (sin modificar datos)', razon: 'Clasificación automática sin evidencia, pero la fila YA generó una asignación real — no se modifica' };
        }
        if (bloqueo.bloqueada) {
            return { ...base, tratamiento: 'Interpretación corregida en pantalla, Historial y Excel (sin modificar datos)', razon: 'Clasificación automática sin evidencia; la propuesta está bloqueada para escritura — no se modifica' };
        }
        return {
            ...base,
            corregir: true,
            tratamiento: 'Corregir a PENDIENTE (requiere aprobación explícita)',
            razon: `Estado ${d.estado_revision}/${d.origen_seleccion || '—'} asignado al guardar el borrador sin acción administrativa (sin bitácora de modificación, sin auditoría individual, sin marca de revisión)`,
            despues: { estado_revision: 'PENDIENTE', origen_seleccion: null, jurado_id_propuesto: d.jurado_id_propuesto, jurado_id_seleccionado: null },
        };
    });
}

// metricas_json resultante para una fila corregida (conserva todo lo previo).
function metricasRegularizadas(metricas, fila, { actorId, motivo, fecha = new Date().toISOString() }) {
    return {
        ...(metricas || {}),
        regularizacion: {
            fecha, actor_id: actorId, motivo,
            estado_anterior: fila.antes.estado_revision, origen_anterior: fila.antes.origen_seleccion,
            jurado_seleccionado_anterior: fila.antes.jurado_id_seleccionado,
        },
    };
}

function resumenClasificacion(filas, { propuesta, asignaciones } = {}) {
    const corregir = filas.filter(f => f.corregir);
    const porCategoria = Object.fromEntries(Object.keys(CATEGORIA).map(k => [k, filas.filter(f => f.categoria === k).length]));
    const asig = asignaciones || [];
    const activas = asig.filter(a => a.estado !== 'anulado');
    const resumen = {
        total: filas.length,
        por_categoria: porCategoria,
        clasificacion_automatica_aceptado: filas.filter(f => f.categoria === 'CLASIFICACION_AUTOMATICA' && f.antes.estado_revision === 'ACEPTADO').length,
        clasificacion_automatica_modificado: filas.filter(f => f.categoria === 'CLASIFICACION_AUTOMATICA' && f.antes.estado_revision === 'MODIFICADO').length,
        filas_aplicadas: filas.filter(f => f.aplicacion.aplicada).length,
        asignaciones: { total: asig.length, activas: activas.length, publicadas: activas.filter(a => a.publicado).length, anuladas: asig.length - activas.length },
        a_corregir: corregir.length,
        aceptado_a_pendiente: corregir.filter(f => f.antes.estado_revision === 'ACEPTADO').length,
        modificado_a_pendiente: corregir.filter(f => f.antes.estado_revision === 'MODIFICADO').length,
        se_conservan: filas.length - corregir.length,
        jurados_sin_cambio: filas.every(f => f.antes.jurado_id_propuesto === f.despues.jurado_id_propuesto),
    };
    if (propuesta) resumen.bloqueo = evaluarBloqueoEscritura({ propuesta, asignaciones });
    return resumen;
}

module.exports = { CATEGORIA, evaluarBloqueoEscritura, clasificarFilasRegularizacion, metricasRegularizadas, resumenClasificacion };
