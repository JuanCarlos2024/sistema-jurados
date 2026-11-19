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
const { evaluarCandidatoDirecto, bloquesSeSuperponen, bloquesSonConsecutivos, antecedentesAsociacionIntervalo } = require('./motorPropuestaDesignacion');
const { CAUSAS_OBLIGATORIAS, CAUSAS_RELAJABLES } = require('./motorPropuestaDesignacionGlobal');
const { calcularBloqueRodeo } = require('./feriados');
const { normalizarAsociacion } = require('./asociaciones');

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
// @param opciones.flujo — FLUJO_DESIGNACION_MANUAL ('designacion_manual')
//   SOLO desde Rodeos → "Designar jurado" (listado y guardado): clasifica con
//   evaluarElegibilidadJuradoManual (ver más abajo). Sin opciones, el criterio
//   de siempre (Propuesta, reemplazo, etc.) — nunca cambia por omisión.
// @returns { estado, causas, causas_obligatorias, causas_relajables, distancia_km, zona_extrema, jurado } | { estado:'NO_HABILITADO', error }
function evaluarElegibilidadJurado(contexto, rodeoId, juradoId, configuracion, opciones) {
    if (opciones && opciones.flujo === FLUJO_DESIGNACION_MANUAL) {
        return evaluarElegibilidadJuradoManual(contexto, rodeoId, juradoId, configuracion);
    }
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

// ═════════════════════════════════════════════════════════════════════════
// Designación MANUAL (Rodeos → "Designar jurado") — excepción administrativa
// autorizada (corrección 2026-11-19).
//
// En el flujo administrativo manual, ASOCIACION_REPETIDA_INTERVALO deja de
// ser un bloqueo absoluto: se muestra como advertencia y solo puede
// designarse con confirmación expresa + motivo del catálogo + registro en la
// bitácora. NO se agrega a CAUSAS_RELAJABLES (motorPropuestaDesignacion
// Global.js): el motor automático —local y global— la sigue tratando como
// OBLIGATORIA y nunca la cede. Todo lo demás que el motor considera
// obligatorio (disponibilidad, categoría, misma asociación organizadora,
// mismo fin de semana) sigue bloqueando también aquí; cualquier causa no
// reconocida se trata como obligatoria (nunca se excepciona por omisión).
// ═════════════════════════════════════════════════════════════════════════
const CAUSAS_EXCEPCIONABLES_MANUAL = new Set([...CAUSAS_RELAJABLES, 'ASOCIACION_REPETIDA_INTERVALO']);
const FLUJO_DESIGNACION_MANUAL = 'designacion_manual';

function separarCausasManual(causas) {
    const lista = causas || [];
    return {
        causas_obligatorias: lista.filter(c => !CAUSAS_EXCEPCIONABLES_MANUAL.has(c)),
        causas_relajables: lista.filter(c => CAUSAS_EXCEPCIONABLES_MANUAL.has(c))
    };
}

function clasificarCausasManual(causas) {
    const { causas_obligatorias, causas_relajables } = separarCausasManual(causas);
    if (causas_obligatorias.length > 0) return ESTADOS_ELEGIBILIDAD.NO_HABILITADO;
    return causas_relajables.length > 0 ? ESTADOS_ELEGIBILIDAD.CON_ADVERTENCIAS : ESTADOS_ELEGIBILIDAD.DISPONIBLE_Y_HABILITADO;
}

function _rodeoResumen(r) {
    return { club: r?.club || null, asociacion: r?.asociacion || null, fecha: r?.fecha || null };
}

// Detalle legible de cada advertencia (fechas y asociaciones concretas) —
// solo LEE lo que el motor ya calculó y el contexto ya cargado; nunca
// decide nada (la clasificación la hace clasificarCausasManual).
function construirDetalleAdvertencias(contexto, rodeo, juradoId, evaluacion, configuracion, causasRelajables) {
    const detalle = [];
    const temporada = (contexto.asignacionesTemporada || [])
        .filter(a => a.usuario_pagado_id === juradoId && a.rodeo_id !== rodeo.id && a.rodeos?.fecha);
    for (const causa of causasRelajables) {
        if (causa === 'ASOCIACION_REPETIDA_INTERVALO') {
            const c = evaluacion.conflictoIntervalo || null;
            detalle.push({
                causa, meses: configuracion.repeticion_asociacion_meses ?? null,
                asociacion: rodeo.asociacion || null,
                desde: c?.desde || null, hasta: c?.hasta || null,
                origen: c?.origen || null,
                rodeos: c ? [{ club: c.club || null, asociacion: c.asociacion || rodeo.asociacion || null, fecha: c.fecha }] : []
            });
        } else if (causa === 'FINDE_CONSECUTIVO') {
            const rodeos = temporada
                .filter(a => {
                    const b = calcularBloqueRodeo(a.rodeos.fecha, a.rodeos.duracion_dias || 1);
                    return !bloquesSeSuperponen(b, rodeo.bloque) && bloquesSonConsecutivos(b, rodeo.bloque);
                })
                .map(a => _rodeoResumen(a.rodeos))
                .sort((x, y) => (x.fecha < y.fecha ? -1 : 1));
            detalle.push({ causa, rodeos });
        } else if (causa === 'ASOCIACION_REPETIDA_TEMPORADA') {
            const asoc = normalizarAsociacion(rodeo.asociacion || '');
            const rodeos = temporada
                .filter(a => a.rodeos.asociacion && normalizarAsociacion(a.rodeos.asociacion) === asoc)
                .map(a => _rodeoResumen(a.rodeos))
                .sort((x, y) => (x.fecha < y.fecha ? -1 : 1));
            detalle.push({ causa, asociacion: rodeo.asociacion || null, rodeos });
        } else if (causa === 'DISTANCIA_EXCEDIDA') {
            detalle.push({ causa, distancia_km: evaluacion.distanciaKm ?? null, maxima_km: configuracion.distancia_maxima_km ?? null, rodeos: [] });
        } else {
            detalle.push({ causa, rodeos: [] });
        }
    }
    return detalle;
}

// Aviso INFORMATIVO de repetición de asociación (corrección 2026-11-19):
// antecedentes EFECTIVOS del jurado en la asociación del rodeo (anteriores y
// posteriores; nunca anulados ni rechazados — misma fuente que la regla,
// construirFechasAsociacionPorJurado), cada uno marcado dentro/fuera de la
// ventana ±N meses por antecedentesAsociacionIntervalo(): la MISMA función
// que usa la regla del motor, así el aviso nunca contradice la
// clasificación. Solo informa; no decide nada.
// @returns null (sin antecedentes) | { asociacion, intervalo_activo, meses, desde, hasta, intervalo_cumplido, antecedentes: [{ fecha, club, asociacion, posterior, dentro_intervalo }] }
function describirRepeticionAsociacion(contexto, rodeo, juradoId, configuracion) {
    if (!rodeo || !rodeo.asociacion) return null;
    const meses = configuracion.regla_repeticion_asociacion_intervalo_activa ? configuracion.repeticion_asociacion_meses : null;
    const estado = {
        fechasAsociacionPorJurado: contexto.fechasAsociacionPorJurado,
        ultimaFechaAsociacionPorJurado: contexto.ultimaFechaAsociacionPorJurado
    };
    const r = antecedentesAsociacionIntervalo(juradoId, rodeo, normalizarAsociacion(rodeo.asociacion), meses, estado);
    if (r.antecedentes.length === 0) return null;
    const antecedentes = r.antecedentes
        .map(a => ({ fecha: a.fecha, club: a.club || null, asociacion: a.asociacion || rodeo.asociacion, posterior: a.fecha > rodeo.fecha, dentro_intervalo: a.dentro_intervalo }))
        .sort((x, y) => (x.fecha < y.fecha ? 1 : x.fecha > y.fecha ? -1 : 0));
    return {
        asociacion: rodeo.asociacion, intervalo_activo: !!meses, meses: meses || null, desde: r.desde, hasta: r.hasta,
        intervalo_cumplido: meses ? !antecedentes.some(a => a.dentro_intervalo) : null,
        antecedentes
    };
}

// Misma forma de resultado que evaluarElegibilidadJurado() + detalle_
// advertencias + repeticion_asociacion. Única función que usan "Designar jurado" (listado) y
// POST /admin/asignaciones (revalidación al guardar).
function evaluarElegibilidadJuradoManual(contexto, rodeoId, juradoId, configuracion) {
    const resultado = evaluarCandidatoDirecto(contexto, rodeoId, juradoId, configuracion);
    if (resultado.error) {
        return {
            estado: ESTADOS_ELEGIBILIDAD.NO_HABILITADO, error: resultado.error,
            causas: [], causas_obligatorias: [], causas_relajables: [], detalle_advertencias: [], repeticion_asociacion: null,
            distancia_km: null, zona_extrema: null, jurado: null
        };
    }
    const causas = resultado.evaluacion.causas || [];
    const separadas = separarCausasManual(causas);
    const rodeo = contexto.rodeosPorId.get(rodeoId);
    return {
        estado: clasificarCausasManual(causas),
        causas,
        ...separadas,
        detalle_advertencias: separadas.causas_obligatorias.length === 0
            ? construirDetalleAdvertencias(contexto, rodeo, juradoId, resultado.evaluacion, configuracion, separadas.causas_relajables)
            : [],
        repeticion_asociacion: describirRepeticionAsociacion(contexto, rodeo, juradoId, configuracion),
        distancia_km: resultado.evaluacion.distanciaKm ?? null,
        zona_extrema: resultado.zonaExtrema || null,
        jurado: resultado.evaluacion.jurado || null
    };
}

module.exports = {
    ESTADOS_ELEGIBILIDAD, clasificarCausas, separarCausas, evaluarElegibilidadJurado,
    CAUSAS_EXCEPCIONABLES_MANUAL, FLUJO_DESIGNACION_MANUAL, separarCausasManual, clasificarCausasManual, evaluarElegibilidadJuradoManual,
    describirRepeticionAsociacion
};
