// ═════════════════════════════════════════════════════════════════════════
// Configuración de Propuesta de Designación — Etapa 3: cargador único desde
// BD (capa de acceso a datos). configuracionDesignacion.js se mantiene 100%
// puro (sin Supabase) — este archivo aparte hace las consultas reales y
// llama a sus funciones puras (reconstruirConfiguracionDesdeFilas +
// validarConfiguracion) para devolver un objeto ya validado, listo para
// pasarle directamente al motor. Ninguna ruta debe consultar estas 3 tablas
// por su cuenta — siempre a través de este único cargador (sección 3 del
// pedido: "no duplicar consultas dentro de cada endpoint").
//
// FALLA CERRADO SIEMPRE (sección 6): si la configuración no existe, está
// incompleta, tiene schema_version no soportado, matriz/criterios inválidos,
// o hay 0 o más de 1 fila "activa", NUNCA se recurre a
// construirConfiguracionDefaultV1() como respaldo productivo — eso queda
// reservado a tests/fixtures/futuro "Restaurar defaults" (sección 30). Se
// devuelve { error, detalle } y quien llama decide cómo responder (nunca
// ejecuta el motor con eso).
// ═════════════════════════════════════════════════════════════════════════
const supabase = require('../config/supabase');
const { reconstruirConfiguracionDesdeFilas, validarConfiguracion } = require('./configuracionDesignacion');

const SELECT_VERSION =
    'id, numero_version, schema_version, regla_distancia_maxima_activa, distancia_maxima_km, ' +
    'regla_no_repetir_asociacion_activa, regla_un_rodeo_por_finde_activa, regla_finde_consecutivo_activa, ' +
    'regla_asociacion_organizadora_activa';

// ─── Dado un versionRow ya resuelto, carga sus componentes (2 queries fijas
// en paralelo, nunca una por criterio/categoría) y reconstruye+valida. ─────
async function cargarComponentesYValidar(versionRow) {
    const [{ data: criterios, error: errC }, { data: matrizRows, error: errM }] = await Promise.all([
        supabase.from('configuracion_designacion_orden_criterios').select('criterio_codigo, orden').eq('version_id', versionRow.id),
        supabase.from('configuracion_designacion_matriz').select('clasificacion_codigo, categoria, elegible, orden_preferencia').eq('version_id', versionRow.id)
    ]);
    if (errC) throw new Error('No se pudo cargar el orden de criterios de la configuración de designación: ' + errC.message);
    if (errM) throw new Error('No se pudo cargar la matriz de la configuración de designación: ' + errM.message);

    const configuracion = reconstruirConfiguracionDesdeFilas(versionRow, criterios || [], matrizRows || []);
    const val = validarConfiguracion(configuracion);
    if (!val.valido) {
        return { error: 'CONFIGURACION_DESIGNACION_INVALIDA', detalle: val.error };
    }
    return {
        configuracion,
        meta: { id: versionRow.id, numero_version: versionRow.numero_version, schema_version: versionRow.schema_version }
    };
}

// ─── Configuración ACTIVA — la única fuente para NUEVAS simulaciones ──────
// (dry-run). Exige EXACTAMENTE 1 fila con activa=true — 0 o más de 1 (esto
// último no debería ocurrir nunca, ya lo impide el índice único parcial de
// la migración 050, pero se revalida en la aplicación como defensa en
// profundidad) fallan cerrado, nunca se elige arbitrariamente.
// @returns { configuracion, meta:{id,numero_version,schema_version} } | { error, detalle }
async function cargarConfiguracionDesignacionActiva() {
    const { data: versiones, error } = await supabase
        .from('configuracion_designacion_versiones')
        .select(SELECT_VERSION)
        .eq('activa', true);
    if (error) throw new Error('No se pudo cargar la configuración de designación activa: ' + error.message);

    if (!versiones || versiones.length !== 1) {
        return {
            error: 'CONFIGURACION_DESIGNACION_NO_RESUELTA',
            detalle: `Se esperaba exactamente 1 configuración de designación activa; se encontraron ${versiones?.length || 0}.`
        };
    }
    return cargarComponentesYValidar(versiones[0]);
}

// ─── Configuración por ID — para PREVIEW/borrador ya vinculados a una ─────
// versión histórica específica. NO exige activa=true (sección 24): una
// versión que dejó de estar activa sigue siendo perfectamente válida para
// todo lo que ya la referencia (preview_token firmado, propuesta guardada).
// @returns { configuracion, meta } | { error, detalle }
async function cargarConfiguracionDesignacionPorId(versionId) {
    if (!versionId || typeof versionId !== 'string') {
        return { error: 'CONFIGURACION_DESIGNACION_NO_RESUELTA', detalle: 'configuracion_version_id ausente o inválido' };
    }
    const { data: versiones, error } = await supabase
        .from('configuracion_designacion_versiones')
        .select(SELECT_VERSION)
        .eq('id', versionId);
    if (error) throw new Error('No se pudo cargar la configuración de designación: ' + error.message);

    if (!versiones || versiones.length !== 1) {
        return {
            error: 'CONFIGURACION_DESIGNACION_NO_RESUELTA',
            detalle: `No existe la configuración de designación con id ${versionId}.`
        };
    }
    return cargarComponentesYValidar(versiones[0]);
}

module.exports = { cargarConfiguracionDesignacionActiva, cargarConfiguracionDesignacionPorId };
