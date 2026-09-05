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
//
// ─── HISTÓRICO vs EFECTIVO (corrección post-revisión) ──────────────────────
// jurado_id_propuesto es un registro HISTÓRICO: lo que el motor sugirió al
// generar la propuesta. NUNCA se modifica ni se borra, pase lo que pase
// después (secciones 2/7/15 del pedido).
//
// Pero una fila puede llegar a un punto donde ese jurado histórico YA NO está
// vigente en ella (porque el administrador lo movió a otro rodeo de la misma
// propuesta) — en ese caso la fila necesita un estado que lo diga
// explícitamente: SIN_JURADO_ACTUAL. Sin este estado, "jurado_id_propuesto
// no nulo + jurado_id_seleccionado nulo" sería ambiguo entre "el motor lo
// propuso y sigue siendo la sugerencia vigente" (PENDIENTE) y "el motor lo
// propuso pero ya se movió a otra fila" — dos situaciones que deben tratarse
// distinto en TODAS partes (indicadores, conflictos, resumen). Por eso existe
// el estado SIN_JURADO_ACTUAL (ver migración 048, preparada, no aplicada).
//
// obtenerJuradoEfectivo() es la ÚNICA función que decide "quién está
// actualmente en uso en esta fila" — todo el resto del módulo (indicador
// "propuesto en otro rodeo", detección de conflictos, mover jurado, resumen)
// pasa por ella. Nunca se reimplementa ese fallback en otro lado.
// ═════════════════════════════════════════════════════════════════════════
const { bloquesSeSuperponen, bloquesSonConsecutivos } = require('./motorPropuestaDesignacion');
const { mismaAsociacion } = require('./asociaciones');

const ESTADOS_REVISION = ['PENDIENTE', 'ACEPTADO', 'MODIFICADO', 'SIN_PROPUESTA', 'NO_EVALUABLE', 'SIN_JURADO_ACTUAL'];
const ORIGENES_SELECCION = ['MOTOR', 'MANUAL', 'MANUAL_CON_ADVERTENCIA'];

// ─── Jurado EFECTIVO de una fila — fuente única de verdad ─────────────────
// ACEPTADO/MODIFICADO       → jurado_id_seleccionado (el administrador actuó)
// PENDIENTE                 → jurado_id_propuesto (sugerencia del motor, vigente)
// SIN_JURADO_ACTUAL         → null (el jurado histórico fue movido a otra fila)
// SIN_PROPUESTA/NO_EVALUABLE → null (nunca hubo/no se puede evaluar)
//
// @param detalle { estado_revision, jurado_id_seleccionado, jurado_id_propuesto }
// @returns jurado_id efectivo, o null
function obtenerJuradoEfectivo(detalle) {
    if (!detalle) return null;
    switch (detalle.estado_revision) {
        case 'ACEPTADO':
        case 'MODIFICADO':
            return detalle.jurado_id_seleccionado || null;
        case 'PENDIENTE':
            return detalle.jurado_id_propuesto || null;
        case 'SIN_JURADO_ACTUAL':
        case 'SIN_PROPUESTA':
        case 'NO_EVALUABLE':
        default:
            return null;
    }
}

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
// las DEMÁS filas de la MISMA propuesta (no contra la base de datos general
// — eso ya lo hace el motor). Reutiliza los mismos helpers de bloque/
// asociación que usa el motor, sin reimplementarlos.
//
// El jurado de cada otra fila que cuenta para este chequeo es su jurado
// EFECTIVO (obtenerJuradoEfectivo) — nunca jurado_id_propuesto en bruto, para
// que una fila SIN_JURADO_ACTUAL (jurado movido a otra parte) deje de
// disparar el indicador aunque su campo histórico siga apuntando al mismo
// jurado.
//
// Si el jurado coincide en otra fila pero ninguna regla específica aplica
// (fechas lejanas, asociación distinta), igual se reporta como
// YA_USADO_EN_PROPUESTA — es informativo, no bloqueante: permite que el
// administrador mueva conscientemente a un jurado de un rodeo a otro dentro
// del mismo borrador en vez de duplicarlo silenciosamente.
//
// @param rodeoActual {id, club, fecha, asociacion, bloque:{inicio,fin}}
// @param juradoId - candidato que se evalúa para rodeoActual
// @param otrasFilas [{ detalle_id, estado_revision, jurado_id_seleccionado, jurado_id_propuesto, rodeo:{id,club,fecha,asociacion,tipo_rodeo_nombre,bloque} }]
// @returns [{ tipo:'MISMO_FINDE'|'FINDE_CONSECUTIVO'|'ASOCIACION_REPETIDA_EN_PROPUESTA'|'YA_USADO_EN_PROPUESTA', rodeo_id, club, fecha, asociacion, tipo_rodeo_nombre }]
function detectarConflictoInterno(rodeoActual, juradoId, otrasFilas) {
    const conflictos = [];
    for (const fila of (otrasFilas || [])) {
        const juradoEfectivoFila = obtenerJuradoEfectivo(fila);
        if (!juradoEfectivoFila || juradoEfectivoFila !== juradoId) continue;
        if (fila.rodeo.id === rodeoActual.id) continue; // no compararse consigo misma

        const base = { rodeo_id: fila.rodeo.id, club: fila.rodeo.club, fecha: fila.rodeo.fecha, asociacion: fila.rodeo.asociacion, tipo_rodeo_nombre: fila.rodeo.tipo_rodeo_nombre || null };
        let tipoPorFecha = null;
        if (bloquesSeSuperponen(fila.rodeo.bloque, rodeoActual.bloque)) {
            tipoPorFecha = 'MISMO_FINDE';
        } else if (bloquesSonConsecutivos(fila.rodeo.bloque, rodeoActual.bloque)) {
            tipoPorFecha = 'FINDE_CONSECUTIVO';
        }
        if (tipoPorFecha) conflictos.push({ tipo: tipoPorFecha, ...base });

        const mismaAsoc = mismaAsociacion(fila.rodeo.asociacion, rodeoActual.asociacion);
        if (mismaAsoc) {
            conflictos.push({ tipo: 'ASOCIACION_REPETIDA_EN_PROPUESTA', ...base });
        }

        // Reutilización sin conflicto de regla — informativo, para "mover jurado"
        if (!tipoPorFecha && !mismaAsoc) {
            conflictos.push({ tipo: 'YA_USADO_EN_PROPUESTA', ...base });
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

// ─── Resolver qué fila anterior liberar al "mover" un jurado ─────────────
// Si el jurado que se está por seleccionar en una fila nueva ya es el jurado
// EFECTIVO (obtenerJuradoEfectivo) de OTRA fila de la MISMA propuesta —ya sea
// porque estaba ACEPTADO/MODIFICADO o porque estaba PENDIENTE con esa
// propuesta del motor vigente— esa fila anterior debe liberarse para que el
// jurado nunca quede vigente simultáneamente en dos rodeos.
//
// CORRECCIÓN: el nuevo_estado NO depende de qué estado_revision tenía la fila
// (ACEPTADO/MODIFICADO/PENDIENTE) — depende de si jurado_id_propuesto (el
// histórico, que NUNCA se toca) es o no el MISMO jurado que se está moviendo:
//
//   - jurado_id_propuesto === juradoQueSeMueve → el motor había propuesto
//     justo al que se está yendo; no hay a quién "volver" → SIN_JURADO_ACTUAL.
//     (Este es el caso que antes se resolvía mal: una fila ACEPTADA donde
//     jurado_id_propuesto == jurado_id_seleccionado == el que se mueve
//     volvía a PENDIENTE, y como PENDIENTE usa jurado_id_propuesto como
//     efectivo, el mismo jurado quedaba "vigente" en el origen Y en el
//     destino a la vez.)
//   - jurado_id_propuesto existe y es OTRO jurado distinto → esa propuesta
//     original del motor (para otra persona) vuelve a quedar vigente → PENDIENTE.
//   - no hay jurado_id_propuesto (selección 100% manual, sin sugerencia del
//     motor) → SIN_PROPUESTA, igual que /revertir.
//
// jurado_id_propuesto de la fila liberada NUNCA se toca en ningún caso.
// NO se autoasigna ningún reemplazo — queda pendiente de decisión administrativa.
//
// @param otrasFilas [{ detalle_id, estado_revision, jurado_id_seleccionado, jurado_id_propuesto }]
// @param juradoId - jurado que se está moviendo/seleccionando en la fila nueva
// @returns { detalle_id, nuevo_estado: 'PENDIENTE'|'SIN_PROPUESTA'|'SIN_JURADO_ACTUAL' } | null
function resolverFilaALiberar(otrasFilas, juradoId) {
    const fila = (otrasFilas || []).find(f => obtenerJuradoEfectivo(f) === juradoId);
    if (!fila) return null;

    let nuevoEstado;
    if (fila.jurado_id_propuesto === juradoId) {
        nuevoEstado = 'SIN_JURADO_ACTUAL';
    } else if (fila.jurado_id_propuesto) {
        nuevoEstado = 'PENDIENTE';
    } else {
        nuevoEstado = 'SIN_PROPUESTA';
    }
    return { detalle_id: fila.detalle_id, nuevo_estado: nuevoEstado };
}

// ─── Identidad MATERIAL de una advertencia (fingerprint) ─────────────────
// NO usa el texto visual (puede cambiar por redacción sin que cambie la
// regla) ni solo `tipo` (610 km y 950 km de exceso son ambas
// DISTANCIA_EXCEDIDA, pero son un cambio material distinto). Compara según
// el tipo, usando ÚNICAMENTE los campos estructurados que el motor ya
// entrega — no se inventa ningún dato que el motor no calcule:
//
//   CONFLICTO_INTERNO_PROPUESTA (MISMO_FINDE / FINDE_CONSECUTIVO /
//   ASOCIACION_REPETIDA_EN_PROPUESTA / YA_USADO_EN_PROPUESTA):
//     tipo + rodeo_id del OTRO rodeo involucrado en el conflicto — ya es la
//     identidad material real (detectarConflictoInterno ya lo entrega): si
//     el rodeo conflictivo cambia, es un conflicto distinto.
//
//   REGLA_MOTOR (causas de evaluarCandidato() sobre el jurado en este rodeo):
//     DISTANCIA_EXCEDIDA            → tipo + distancia_km redondeada a la
//                                      decena (610→610, 611→610, 950→950 —
//                                      no trata <10km de diferencia como
//                                      material, pero sí un salto real).
//     CATEGORIA_INCOMPATIBLE        → tipo + categoría del jurado.
//     MISMA_ASOCIACION,
//     ASOCIACION_REPETIDA_TEMPORADA → tipo + asociación relevante.
//     resto (DISPONIBILIDAD, MISMO_FINDE/FINDE_CONSECUTIVO contra BD,
//     JURADO_SIN_COMUNA_RESOLVIBLE) → solo el tipo — evaluarCandidato() no
//     expone hoy ningún dato estructurado adicional para estas causas; no
//     se inventa ninguno. Si el motor llega a exponerlo en el futuro, este
//     es el único lugar que necesitaría ampliarse.
//
// @param a advertencia { tipo, origen, rodeo_id?, distancia_km?, categoria?, asociacion? }
function fingerprintAdvertencia(a) {
    if (a.origen === 'CONFLICTO_INTERNO_PROPUESTA') {
        return `${a.tipo}:${a.rodeo_id || ''}`;
    }
    switch (a.tipo) {
        case 'DISTANCIA_EXCEDIDA':
            return `DISTANCIA_EXCEDIDA:${a.distancia_km != null ? Math.round(a.distancia_km / 10) * 10 : ''}`;
        case 'CATEGORIA_INCOMPATIBLE':
            return `CATEGORIA_INCOMPATIBLE:${a.categoria || ''}`;
        case 'MISMA_ASOCIACION':
        case 'ASOCIACION_REPETIDA_TEMPORADA':
            return `${a.tipo}:${a.asociacion || ''}`;
        default:
            return a.tipo;
    }
}

// ─── Revalidación al GUARDAR — ¿hay algo NUEVO que revisar? ──────────────
// Compara las advertencias FRESCAS (recalculadas en vivo al guardar: causas
// de regla + conflictos internos) contra las que ya estaban aceptadas
// cuando se hizo la selección durante el preview, usando fingerprintAdvertencia()
// (identidad MATERIAL, no solo tipo+rodeo). Solo una advertencia NUEVA
// bloquea el guardado — una que ya se revisó y sigue igual, o que
// desapareció, NO genera una revisión innecesaria (sección 2: A. misma
// advertencia y mismas condiciones → ya aceptada; B. nueva → revisión;
// C. mismo tipo pero cambió materialmente → revisión; D. desapareció → no
// bloquea). Nunca oculta una advertencia nueva.
//
// @param advertenciasFrescas - recalculadas ahora mismo
// @param advertenciasPrevias - ya aceptadas durante el preview (metricas_json.advertencias_aceptadas)
// @returns { requiereRevision: boolean, advertenciasNuevas: [...] }
function evaluarCambiosParaGuardar(advertenciasFrescas, advertenciasPrevias) {
    const firmasPrevias = new Set((advertenciasPrevias || []).map(fingerprintAdvertencia));
    const advertenciasNuevas = (advertenciasFrescas || []).filter(a => !firmasPrevias.has(fingerprintAdvertencia(a)));
    return { requiereRevision: advertenciasNuevas.length > 0, advertenciasNuevas };
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
        no_evaluables: contar('NO_EVALUABLE'),
        sin_jurado_actual: contar('SIN_JURADO_ACTUAL')
    };
}

module.exports = {
    ESTADOS_REVISION, ORIGENES_SELECCION,
    obtenerJuradoEfectivo,
    construirDetalleDesdeResultado, detectarConflictoInterno, decidirEstadoSeleccion, resumenPropuesta,
    resolverFilaALiberar,
    fingerprintAdvertencia, evaluarCambiosParaGuardar
};
