// ═════════════════════════════════════════════════════════════════════════
// Elegibilidad de jurado — mecanismo ÚNICO y COMPARTIDO (Auditoría de
// elegibilidad y gestión de propuestas incompletas, Etapa A).
//
// Causa raíz que este módulo corrige: Rodeos → "Designar jurado" y
// Propuesta de Designación → "Modificar jurado" evaluaban candidatos con
// DOS motores de reglas distintos. Propuesta reutiliza evaluarCandidato()
// completo (categoría/matriz, MISMA_ASOCIACION, distancia, repetición de
// asociación, mismo finde/finde consecutivo, disponibilidad). Rodeos solo
// validaba disponibilidad + cruce de fechas — nunca MISMA_ASOCIACION,
// categoría/matriz ni distancia, ni al listar ni al escribir
// (POST /admin/asignaciones). Caso real verificado: jurados que Propuesta
// descarta correctamente (p. ej. por categoría o distancia) aparecían en
// Rodeos como si no tuvieran ningún problema.
//
// Este módulo NO reimplementa ninguna regla — envuelve evaluarCandidatoDirecto()
// (motorPropuestaDesignacion.js, que a su vez llama a evaluarCandidato(), la
// única fuente de verdad) y clasifica sus causas usando EXACTAMENTE los
// mismos conjuntos que ya usa el motor global para decidir qué puede
// relajarse y qué nunca (CAUSAS_OBLIGATORIAS/CAUSAS_RELAJABLES,
// motorPropuestaDesignacionGlobal.js) — nunca una tercera lista paralela.
//
// 3 estados (el 4º, "YA DESIGNADO O RESERVADO", es informativo y lo arma
// cada endpoint con sus propios datos de ocupación — MISMO_FINDE ya cae
// dentro de NO_HABILITADO porque es una restricción obligatoria real):
//   DISPONIBLE_Y_HABILITADO — 0 causas.
//   CON_ADVERTENCIAS        — solo causas relajables (distancia, repetición
//                              de asociación, finde consecutivo, comuna no
//                              resoluble) — seleccionable con excepción
//                              administrativa justificada, NUNCA automática.
//   NO_HABILITADO           — al menos una causa obligatoria (disponibilidad,
//                              categoría incompatible, misma asociación,
//                              mismo finde, repetición por intervalo si
//                              schema_version=4) — nunca seleccionable.
// ═════════════════════════════════════════════════════════════════════════
const { evaluarCandidatoDirecto } = require('./motorPropuestaDesignacion');
const { CAUSAS_OBLIGATORIAS, CAUSAS_RELAJABLES } = require('./motorPropuestaDesignacionGlobal');

const ESTADOS_ELEGIBILIDAD = {
    DISPONIBLE_Y_HABILITADO: 'DISPONIBLE_Y_HABILITADO',
    CON_ADVERTENCIAS: 'CON_ADVERTENCIAS',
    NO_HABILITADO: 'NO_HABILITADO'
};

// ─── Clasifica un array de causas (evaluarCandidato().causas) en uno de los
// 3 estados — única función que decide esto, para que nunca haya dos
// pantallas con criterios de clasificación distintos.
function clasificarCausas(causas) {
    const lista = causas || [];
    if (lista.length === 0) return ESTADOS_ELEGIBILIDAD.DISPONIBLE_Y_HABILITADO;
    const tieneObligatoria = lista.some(c => CAUSAS_OBLIGATORIAS.has(c));
    return tieneObligatoria ? ESTADOS_ELEGIBILIDAD.NO_HABILITADO : ESTADOS_ELEGIBILIDAD.CON_ADVERTENCIAS;
}

// ─── Separa un array de causas en obligatorias/relajables — única función
// que hace este split, para que evaluarElegibilidadJurado() y cualquier
// enriquecimiento posterior (p. ej. listas de candidatos que ya traen
// `causas` del motor pero todavía no el split) nunca reimplementen el filtro.
function separarCausas(causas) {
    const lista = causas || [];
    return {
        causas_obligatorias: lista.filter(c => CAUSAS_OBLIGATORIAS.has(c)),
        causas_relajables: lista.filter(c => CAUSAS_RELAJABLES.has(c))
    };
}

// ─── Evalúa UN jurado puntual contra UN rodeo — misma forma que usa
// Propuesta de Designación (evaluarCandidatoDirecto), ahora reutilizable
// también desde Rodeos. `contexto` viene de cargarDatosMotor([rodeoId]) (o
// de un contexto ya cargado que incluya ese rodeo) — nunca se repite esa
// consulta por candidato.
// @returns { estado, causas, causas_obligatorias, causas_relajables, distancia_km, zona_extrema, jurado } | { estado:'NO_HABILITADO', error }
function evaluarElegibilidadJurado(contexto, rodeoId, juradoId, configuracion) {
    const resultado = evaluarCandidatoDirecto(contexto, rodeoId, juradoId, configuracion);
    if (resultado.error) {
        return {
            estado: ESTADOS_ELEGIBILIDAD.NO_HABILITADO, error: resultado.error,
            causas: [], causas_obligatorias: [], causas_relajables: [], distancia_km: null, zona_extrema: null, jurado: null
        };
    }
    const causas = resultado.evaluacion.causas || [];
    return {
        estado: clasificarCausas(causas),
        causas,
        ...separarCausas(causas),
        distancia_km: resultado.evaluacion.distanciaKm ?? null,
        zona_extrema: resultado.zonaExtrema || null,
        // Identidad del jurado evaluado (categoría/nombre/asociación) — el
        // mismo objeto que ya resuelve evaluarCandidato() internamente.
        // Corrección final de seguridad (sección 1): evita que cada llamador
        // (p. ej. Propuesta → evaluarSeleccion) tenga que hacer una segunda
        // consulta o un segundo lookup aparte solo para mostrar el nombre.
        jurado: resultado.evaluacion.jurado || null
    };
}

module.exports = { ESTADOS_ELEGIBILIDAD, clasificarCausas, separarCausas, evaluarElegibilidadJurado };
