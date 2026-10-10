// ─── Preparación del catálogo de Delegados de Asociación (Fase 1) ─────────
// Función PURA: no consulta ni escribe en Supabase. Toma filas crudas (hoy
// provenientes de LISTADELEGADOS.xlsx) + el catálogo real de `asociaciones`
// (y sus alias) ya cargados por quien la invoque, y devuelve una propuesta
// de catálogo lista para revisión humana — nunca una carga masiva.
//
// La auditoría encontró que LISTADELEGADOS.xlsx es en realidad una planilla
// de EVALUACIÓN (columnas BUENAS/%/NOTA) con 7 personas repetidas en
// evaluaciones distintas (misma persona + misma asociación, puntaje
// distinto) — por eso esta función:
//   - Solo usa `nombre` y `asociacion` de cada fila (decisión 5: nunca
//     puntajes/evaluaciones).
//   - Consolida como "mismo registro" únicamente duplicados EXACTOS (mismo
//     nombre tras trim+colapsar espacios+minúsculas, SIN tocar tildes —
//     deliberadamente conservador).
//   - Nunca fusiona automáticamente por similitud: dos nombres que solo
//     difieren en tildes/mayúsculas quedan reportados como "variante
//     sospechosa" en una lista separada, para revisión humana.
//   - Resuelve la asociación de cada fila reutilizando EXACTAMENTE
//     construirIndiceCatalogo()/resolverAsociacion() de
//     services/informeGestion/asociaciones.js (mismo criterio ya usado en
//     producción para el informe de gestión: catálogo + alias, sin ILIKE,
//     sin fuzzy matching) — no se duplica esa lógica.
const { construirIndiceCatalogo, resolverAsociacion } = require('./informeGestion/asociaciones');

// Clave de deduplicación EXACTA: conservadora a propósito (no quita tildes,
// para no confundir "José"/"Jose" como la misma persona automáticamente).
function claveExactaNombre(nombre) {
    return (nombre || '').toString().trim().replace(/\s+/g, ' ').toLowerCase();
}

// Clave AMPLIA (sin tildes, sin mayúsculas) — solo para DETECTAR variantes
// sospechosas entre distintas claves exactas, nunca para fusionar.
function claveAmpliaNombre(nombre) {
    return claveExactaNombre(nombre).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * @param filas          [{ nombre, asociacion }] — filas crudas (ya sin las
 *                       columnas de evaluación, que se descartan antes de
 *                       llegar aquí o simplemente se ignoran si vienen).
 * @param catalogo       filas reales de la tabla `asociaciones`.
 * @param alias          filas reales de la tabla `asociacion_alias` (puede ser []).
 * @returns {
 *   listos: [{ nombre, asociacion_id, asociacion_nombre, ocurrencias }],
 *   pendientes: [{ nombre, asociacion_texto_original, motivo }],
 *   variantes_sospechosas: [[nombreA, nombreB], ...],
 *   duplicados_exactos_consolidados: number,
 *   filas_descartadas_vacias: number
 * }
 */
function prepararCatalogoDelegados(filas, catalogo, alias = []) {
    const indice = construirIndiceCatalogo(catalogo, alias);

    // 1) Agrupar por (clave exacta de nombre, asociación tal cual vino en la fila) —
    //    agrupar por el TEXTO de asociación (no por asociacion_id todavía) para no
    //    perder de vista si la misma persona aparece con variantes de asociación.
    const grupos = new Map(); // clave: `${nombreExacto}__${asociacionTexto}` -> {nombreOriginal, asociacionTexto, ocurrencias}
    let descartadas = 0;
    for (const f of (filas || [])) {
        const nombre = (f.nombre || '').toString().trim();
        const asociacionTexto = (f.asociacion || '').toString().trim();
        if (!nombre || !asociacionTexto) { descartadas++; continue; }
        const clave = `${claveExactaNombre(nombre)}__${claveExactaNombre(asociacionTexto)}`;
        if (!grupos.has(clave)) {
            grupos.set(clave, { nombre, asociacionTexto, ocurrencias: 0 });
        }
        grupos.get(clave).ocurrencias++;
    }
    const duplicadosConsolidados = [...grupos.values()].reduce((acc, g) => acc + (g.ocurrencias > 1 ? g.ocurrencias - 1 : 0), 0);

    // 2) Resolver cada grupo contra el catálogo real (nunca ILIKE/fuzzy).
    const listos = [];
    const pendientes = [];
    for (const g of grupos.values()) {
        const asoc = resolverAsociacion(g.asociacionTexto, indice);
        if (!asoc) {
            pendientes.push({ nombre: g.nombre, asociacion_texto_original: g.asociacionTexto, motivo: 'sin_equivalencia_en_catalogo' });
            continue;
        }
        listos.push({ nombre: g.nombre, asociacion_id: asoc.id, asociacion_nombre: asoc.nombre, ocurrencias: g.ocurrencias });
    }

    // 3) Detectar variantes sospechosas: distintas claves EXACTAS que comparten
    //    la misma clave AMPLIA (mismo nombre salvo tildes/mayúsculas), dentro de
    //    la MISMA asociación resuelta — nunca se fusionan, solo se reportan.
    const porAmpliaYAsociacion = new Map();
    for (const l of listos) {
        const clave = `${claveAmpliaNombre(l.nombre)}__${l.asociacion_id}`;
        if (!porAmpliaYAsociacion.has(clave)) porAmpliaYAsociacion.set(clave, new Set());
        porAmpliaYAsociacion.get(clave).add(l.nombre);
    }
    const variantesSospechosas = [];
    for (const nombres of porAmpliaYAsociacion.values()) {
        if (nombres.size > 1) variantesSospechosas.push([...nombres]);
    }

    return {
        listos,
        pendientes,
        variantes_sospechosas: variantesSospechosas,
        duplicados_exactos_consolidados: duplicadosConsolidados,
        filas_descartadas_vacias: descartadas
    };
}

module.exports = { prepararCatalogoDelegados, claveExactaNombre, claveAmpliaNombre };
