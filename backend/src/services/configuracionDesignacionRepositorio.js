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
const { reconstruirConfiguracionDesdeFilas, validarConfiguracion, aplanarMatriz } = require('./configuracionDesignacion');

// Campos de REGLAS (los que entiende reconstruirConfiguracionDesdeFilas/el
// motor) + campos de METADATA/DISPLAY (Etapa 4: activa, descripcion,
// creado_por, created_at) — estos últimos nunca se usan para decidir nada,
// solo se propagan a `meta` para la UI (historial, cabecera, "Ver reglas").
const SELECT_VERSION =
    'id, numero_version, schema_version, activa, regla_distancia_maxima_activa, distancia_maxima_km, ' +
    'regla_no_repetir_asociacion_activa, regla_un_rodeo_por_finde_activa, regla_finde_consecutivo_activa, ' +
    'regla_asociacion_organizadora_activa, descripcion, creado_por, created_at';

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
        meta: {
            id: versionRow.id, numero_version: versionRow.numero_version, schema_version: versionRow.schema_version,
            // Solo display — nunca leídos por el motor ni firmados en ningún
            // token; ver comentario de SELECT_VERSION arriba.
            activa: versionRow.activa, descripcion: versionRow.descripcion ?? null,
            creado_por: versionRow.creado_por ?? null, created_at: versionRow.created_at
        }
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

// ═════════════════════════════════════════════════════════════════════════
// Etapa 4 — listar, ver detalle, CREAR y ACTIVAR versiones desde la UI.
// Creación/activación pasan EXCLUSIVAMENTE por las RPC de la migración 051
// (crear_configuracion_designacion_version / activar_configuracion_
// designacion) — nunca un INSERT/UPDATE suelto desde JS (sección 2/5 del
// pedido: la atomicidad y la validación estructural viven en Postgres).
// ═════════════════════════════════════════════════════════════════════════

// ─── Historial — cabecera de TODAS las versiones (sin componentes, para no
// pagar 3 queries por fila) + nombre de quien la creó. Orden más reciente
// primero. Solo lectura, para la tabla de Historial de versiones.
async function listarVersionesDesignacion() {
    const { data, error } = await supabase
        .from('configuracion_designacion_versiones')
        .select(SELECT_VERSION + ', administradores(nombre_completo)')
        .order('numero_version', { ascending: false });
    if (error) throw new Error('No se pudo listar las versiones de configuración de designación: ' + error.message);
    return (data || []).map(v => ({
        id: v.id, numero_version: v.numero_version, schema_version: v.schema_version, activa: v.activa,
        descripcion: v.descripcion ?? null, creado_por: v.creado_por ?? null,
        creado_por_nombre: v.administradores?.nombre_completo ?? null, created_at: v.created_at
    }));
}

// ─── Detalle completo (read-only) de UNA versión — reutiliza el mismo
// cargador/validador que usa el motor (cargarConfiguracionDesignacionPorId,
// sin exigir activa=true) + el nombre de quien la creó, para "Ver" una
// versión del historial o la cabecera de la activa.
// @returns { configuracion, meta:{...,creado_por_nombre} } | { error, detalle }
async function obtenerVersionDesignacionDetalle(versionId) {
    const carga = await cargarConfiguracionDesignacionPorId(versionId);
    if (carga.error) return carga;

    let creadoPorNombre = null;
    if (carga.meta.creado_por) {
        const { data: admin, error: errAdmin } = await supabase
            .from('administradores').select('nombre_completo').eq('id', carga.meta.creado_por).maybeSingle();
        if (errAdmin) throw new Error('No se pudo cargar el autor de la versión: ' + errAdmin.message);
        creadoPorNombre = admin?.nombre_completo ?? null;
    }
    return { ...carga, meta: { ...carga.meta, creado_por_nombre: creadoPorNombre } };
}

// ─── Crear una versión nueva — SIEMPRE queda inactiva (sección 4). Valida
// con validarConfiguracion() (JS) ANTES de llamar a la RPC (sección 47:
// "no confiar solo en frontend") — la RPC vuelve a proteger la integridad
// en Postgres como defensa en profundidad, nunca reemplaza esta validación.
// @param configuracion objeto configuracion completo (misma forma que construirConfiguracionDefaultV1())
// @param descripcion texto opcional
// @param creadoPor uuid del administrador (req.usuario.id) | null
// @returns { id, numero_version } | { error, detalle }
async function crearVersionDesignacion({ configuracion, descripcion, creadoPor }) {
    const val = validarConfiguracion(configuracion);
    if (!val.valido) {
        return { error: 'CONFIGURACION_DESIGNACION_INVALIDA', detalle: val.error };
    }

    const { data, error } = await supabase.rpc('crear_configuracion_designacion_version', {
        p_regla_distancia_maxima_activa: configuracion.regla_distancia_maxima_activa,
        p_distancia_maxima_km: configuracion.distancia_maxima_km,
        p_regla_no_repetir_asociacion_activa: configuracion.regla_no_repetir_asociacion_activa,
        p_regla_un_rodeo_por_finde_activa: configuracion.regla_un_rodeo_por_finde_activa,
        p_regla_finde_consecutivo_activa: configuracion.regla_finde_consecutivo_activa,
        p_regla_asociacion_organizadora_activa: configuracion.regla_asociacion_organizadora_activa,
        p_descripcion: descripcion || null,
        p_creado_por: creadoPor || null,
        p_orden_criterios: configuracion.ordenCriterios || [],
        p_matriz: aplanarMatriz(configuracion.matriz)
    });
    // La RPC ya validó estructuralmente (defensa en profundidad) — si de
    // todos modos falló acá habiendo pasado validarConfiguracion() en JS,
    // es una discrepancia inesperada entre las dos capas: se reporta igual
    // como configuración inválida, nunca se oculta ni se reintenta distinto.
    if (error) return { error: 'CONFIGURACION_DESIGNACION_INVALIDA', detalle: error.message };

    const fila = Array.isArray(data) ? data[0] : data;
    if (!fila || !fila.id) throw new Error('crear_configuracion_designacion_version no devolvió la versión creada');
    return { id: fila.id, numero_version: fila.numero_version };
}

// ─── Activar una versión — EXCLUSIVAMENTE vía la RPC ya existente
// (activar_configuracion_designacion, migración 050) — nunca varios UPDATE
// desde JS (sección 5 del pedido). Atomicidad y "nunca 0/2 activas" ya
// garantizadas por la función en Postgres.
// @returns { ok:true } | { error, detalle }
async function activarVersionDesignacion(versionId) {
    const { error } = await supabase.rpc('activar_configuracion_designacion', { p_version_id: versionId });
    if (error) return { error: 'CONFIGURACION_DESIGNACION_INVALIDA', detalle: error.message };
    return { ok: true };
}

module.exports = {
    cargarConfiguracionDesignacionActiva,
    cargarConfiguracionDesignacionPorId,
    listarVersionesDesignacion,
    obtenerVersionDesignacionDetalle,
    crearVersionDesignacion,
    activarVersionDesignacion
};
