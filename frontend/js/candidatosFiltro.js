// ═════════════════════════════════════════════════════════════════════════
// Filtrado/orden de candidatos — Modal Designar/Modificar Jurado (Etapa 4).
//
// PURO — no decide reglas, no toca reglas del motor, no consulta backend.
// Solo cambia QUÉ candidatos ve el administrador entre los que el backend ya
// evaluó (candidatos_validos/descartados de GET/POST .../candidatos), nunca
// su validez. Vive en un archivo aparte (en vez de inline en el <script> de
// la página) para poder testearse con Jest igual que el resto del proyecto
// — funciona sin cambios tanto cargado por <script src="/js/..."> en el
// navegador (define funciones globales) como por require() en Node (exporta
// module.exports al final, inerte en el navegador porque `module` no existe ahí).
// ═════════════════════════════════════════════════════════════════════════

// Mismo algoritmo que normalizarTextoJurado() en rodeos.html / normalizar()
// en backend/src/services/importacion.js — trim, minúsculas, sin tildes.
function normalizarBusquedaCandidato(str) {
    if (!str) return '';
    return str.toString().trim().toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/\s+/g, ' ');
}

// ─── Asociaciones reales presentes en los candidatos cargados ────────────
// Sin normalizar ni fusionar — BÍO-BÍO ≠ RÍO BÍO-BÍO, LLANQUIHUE ≠ LAGO
// LLANQUIHUE, MAIPO ≠ MAIPO NORTE. Valores tal cual vienen del backend.
function obtenerAsociacionesCandidatos(candidatosValidos, candidatosDescartados) {
    const set = new Set();
    [...(candidatosValidos || []), ...(candidatosDescartados || [])].forEach(c => {
        if (c.asociacion) set.add(c.asociacion);
    });
    return [...set].sort((a, b) => a.localeCompare(b));
}

// ─── Comparador determinístico (nunca random) ─────────────────────────────
// ordenarPor: 'designaciones' (por defecto) | 'distancia' | 'nombre'.
// Cualquiera sea el criterio principal, el desempate sigue siempre la misma
// cadena: designaciones → distancia → nombre (igual criterio que ya usa el
// motor para el desempate final, aplicado acá solo como presentación).
function compararCandidatos(a, b, ordenarPor) {
    const desigA = a.designaciones_antes ?? 0, desigB = b.designaciones_antes ?? 0;
    const distA = a.distancia_km ?? Infinity, distB = b.distancia_km ?? Infinity;
    const nomA = a.nombre || '', nomB = b.nombre || '';

    if (ordenarPor === 'distancia' && distA !== distB) return distA - distB;
    if (ordenarPor === 'nombre') {
        const cmp = nomA.localeCompare(nomB);
        if (cmp !== 0) return cmp;
    }
    // 'designaciones' (por defecto) o desempate de los otros dos criterios
    if (desigA !== desigB) return desigA - desigB;
    if (distA !== distB) return distA - distB;
    return nomA.localeCompare(nomB);
}

// ─── Filtro "ocultar no disponibles" ──────────────────────────────────────
// Únicamente causa DISPONIBILIDAD — no confundir con otras causas.
function esNoDisponible(c) {
    return (c.causas || []).includes('DISPONIBILIDAD');
}

// ─── Filtro "ocultar ya designados" ───────────────────────────────────────
// Conflicto ACTUAL relevante — no designaciones históricas de temporada:
//   a) MISMO_FINDE / FINDE_CONSECUTIVO (REGLA_MOTOR, contra asignaciones
//      reales de BD para ese bloque/fin de semana), o
//   b) actualmente propuesto/seleccionado en OTRO rodeo de esta misma
//      propuesta (uso_en_otra_fila no vacío).
function esYaDesignado(c) {
    const causas = c.causas || [];
    return causas.includes('MISMO_FINDE') || causas.includes('FINDE_CONSECUTIVO') || (c.uso_en_otra_fila && c.uso_en_otra_fila.length > 0);
}

// ─── Filtro "ocultar repetición de asociación" ────────────────────────────
// Únicamente ASOCIACION_REPETIDA_TEMPORADA ("ya trabajó en esta asociación
// durante la temporada") — NUNCA MISMA_ASOCIACION ("pertenece a la
// asociación organizadora"), que es una causa distinta y no se toca con
// este filtro (sección 14 del pedido: no mezclar ambas).
function esRepiteAsociacionTemporada(c) {
    return (c.causas || []).includes('ASOCIACION_REPETIDA_TEMPORADA');
}

// ─── Filtrado + orden completo ────────────────────────────────────────────
// @param candidatosValidos, candidatosDescartados - tal cual devuelve el backend
// @param opciones {
//   busqueda, categoria ('todas'|'A'|'B'|'C'), asociacion ('todas'|valor real),
//   ocultarNoDisponibles, ocultarYaDesignados, ocultarRepeticionAsociacion,
//   ordenarPor ('designaciones'|'distancia'|'nombre')
// }
// @returns { validos: [...], descartados: [...] } — mismos objetos de entrada,
// solo filtrados/reordenados; nunca se les agrega ni quita ningún dato.
function filtrarYOrdenarCandidatos(candidatosValidos, candidatosDescartados, opciones) {
    const opts = {
        busqueda: '', categoria: 'todas', asociacion: 'todas',
        ocultarNoDisponibles: false, ocultarYaDesignados: false, ocultarRepeticionAsociacion: false,
        ordenarPor: 'designaciones',
        ...(opciones || {})
    };
    const busquedaNorm = normalizarBusquedaCandidato(opts.busqueda);

    const pasaFiltros = (c) => {
        if (busquedaNorm && !normalizarBusquedaCandidato(c.nombre).includes(busquedaNorm)) return false;
        if (opts.categoria !== 'todas' && c.categoria !== opts.categoria) return false;
        if (opts.asociacion !== 'todas' && c.asociacion !== opts.asociacion) return false;
        if (opts.ocultarNoDisponibles && esNoDisponible(c)) return false;
        if (opts.ocultarYaDesignados && esYaDesignado(c)) return false;
        if (opts.ocultarRepeticionAsociacion && esRepiteAsociacionTemporada(c)) return false;
        return true;
    };
    const comparador = (a, b) => compararCandidatos(a, b, opts.ordenarPor);

    return {
        validos: (candidatosValidos || []).filter(pasaFiltros).slice().sort(comparador),
        descartados: (candidatosDescartados || []).filter(pasaFiltros).slice().sort(comparador)
    };
}

const _candidatosFiltroExports = {
    normalizarBusquedaCandidato, obtenerAsociacionesCandidatos, compararCandidatos,
    esNoDisponible, esYaDesignado, esRepiteAsociacionTemporada, filtrarYOrdenarCandidatos
};
if (typeof module !== 'undefined' && module.exports) {
    module.exports = _candidatosFiltroExports;
}
if (typeof window !== 'undefined') {
    Object.assign(window, _candidatosFiltroExports);
}
