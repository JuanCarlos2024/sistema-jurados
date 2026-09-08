-- ═════════════════════════════════════════════════════════════════════════
-- 052_equidad_traslados_designacion.sql
-- Configuración de Propuesta de Designación — mejora "Equidad de Traslados"
--
-- ✅ APLICADA MANUALMENTE EN PRODUCCIÓN por el administrador del proyecto
--    (vía MCP apply_migration, previa autorización explícita, revisión línea
--    por línea de esta migración y precheck/validación de solo lectura antes
--    y después — mismo criterio que las migraciones 050/051). Se conserva
--    este archivo para dejar el cambio versionado en el repositorio — NO
--    debe volver a ejecutarse: los `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
--    y `CREATE OR REPLACE FUNCTION` son idempotentes y no dañarían nada, pero
--    de todos modos no corresponde correrla de nuevo. Validado en producción:
--    la RPC legacy (10 parámetros) sigue intacta, V1 sigue schema_version=1
--    con regla_equidad_traslados_activa=false/umbral_lejania_km=NULL por
--    DEFAULT (sin UPDATE), 0 versiones schema_version=2 creadas, 0 filas
--    modificadas en asignaciones/evaluaciones/temporadas.
--
-- REVISIÓN 2 (rollout retrocompatible) — reemplaza el diseño anterior de
-- esta migración, que hacía DROP + CREATE de crear_configuracion_designacion_
-- version con una firma incompatible. Ese diseño fue RECHAZADO en revisión:
-- abriría una ventana (BD ya migrada, backend todavía desplegado con el
-- código actual) en la que "Crear nueva versión" —funcionalidad YA EN
-- PRODUCCIÓN— dejaría de resolver la función que el backend actual invoca.
--
-- ESTRATEGIA: EXPAND, no reemplazo incompatible.
--   - La RPC crear_configuracion_designacion_version(...) — LA MISMA FIRMA
--     DE 10 PARÁMETROS de la migración 051 — NO se toca en absoluto. Ni el
--     nombre, ni los parámetros, ni el cuerpo, ni los permisos. Sigue
--     resolviendo exactamente igual para el backend actualmente desplegado,
--     antes y después de aplicar esta migración. Sigue creando
--     schema_version=1, regla_equidad_traslados_activa=false,
--     umbral_lejania_km=NULL — automáticamente, por DEFAULT de columna (su
--     INSERT no necesita mencionar las columnas nuevas).
--   - Se agrega una RPC NUEVA, crear_configuracion_designacion_version_v2(...),
--     exclusivamente para crear versiones schema_version=2 con equidad de
--     traslados. El código futuro de configuracionDesignacionRepositorio.js
--     elegirá explícitamente cuál invocar según configuracion.schema_version
--     — nunca una sobrecarga ambigua resuelta implícitamente por PostgREST.
--   - activar_configuracion_designacion(UUID) mantiene su firma UUID exacta
--     (CREATE OR REPLACE, compatible) — ahora soporta activar versiones de
--     ambos schemas, delegando en el helper estructural actualizado.
--   - _validar_estructura_configuracion_designacion(UUID) — CREATE OR
--     REPLACE, ahora bifurca su validación según version.schema_version:
--     para schema_version=1 aplica EXACTAMENTE las mismas condiciones de
--     antes (comportamiento histórico, sin reinterpretarlo); para
--     schema_version=2 agrega las condiciones nuevas de equidad de
--     traslados, incluyendo que EQUIDAD_TRASLADOS sea SIEMPRE el criterio
--     Nº1 cuando regla_equidad_traslados_activa=true (decisión de negocio:
--     "siempre preferir cercanía" — ver informe de diseño).
--
-- Aplicar esta migración, POR SÍ SOLA, es funcionalmente transparente para
-- producción: 0 filas modificadas, 0 comportamiento distinto para nada de lo
-- que ya existe. El backend actualmente desplegado puede seguir corriendo
-- sin ningún cambio de código después de aplicarla.
--
-- QUÉ HACE (todo aditivo; 0 DROP de datos ni de funciones existentes; 0
-- cambio de comportamiento observable para lo que ya existe):
--   1. configuracion_designacion_versiones — agrega 2 columnas nuevas:
--        regla_equidad_traslados_activa BOOLEAN NOT NULL DEFAULT false
--        umbral_lejania_km              NUMERIC
--      DEFAULT deja automáticamente la Versión 1 (y cualquier fila ya
--      persistida) en regla_equidad_traslados_activa=false / umbral_lejania_
--      km=NULL — sin ningún UPDATE explícito.
--   2. chk_config_designacion_schema_version — CHECK (schema_version IN (1,2))
--      en vez de (schema_version = 1). schema_version=1 sigue significando
--      exactamente lo mismo que hoy (reforzado además por el punto 4).
--   3. chk_config_designacion_equidad — umbral_lejania_km obligatorio/
--      positivo SOLO si regla_equidad_traslados_activa=true (mismo patrón
--      que chk_config_designacion_distancia ya existente).
--   4. chk_config_designacion_equidad_requiere_schema2 — regla_equidad_
--      traslados_activa=true EXIGE schema_version=2, estructuralmente
--      (nunca depende únicamente de la validación de aplicación).
--   5. configuracion_designacion_orden_criterios.criterio_codigo — se
--      amplía el CHECK de códigos conocidos para incluir 'EQUIDAD_TRASLADOS'
--      (localizando el nombre real del constraint dinámicamente).
--   6. _validar_estructura_configuracion_designacion(p_version_id) — CREATE
--      OR REPLACE (ver REVISIÓN 2 arriba): bifurca por schema_version.
--   7. activar_configuracion_designacion(p_version_id) — CREATE OR REPLACE,
--      comportamiento externo idéntico, delega en el punto 6.
--   8. crear_configuracion_designacion_version_v2(...) — RPC NUEVA (no
--      reemplaza nada), crea versiones schema_version=2 con equidad de
--      traslados. SIEMPRE activa=false. Corre la misma validación
--      estructural del punto 6 antes de dejar persistida la versión.
--
-- QUÉ NO HACE (deliberadamente):
--   - NO toca ni elimina crear_configuracion_designacion_version(...) (10
--     parámetros) — sigue existiendo, con el mismo comportamiento exacto.
--   - NO modifica ninguna fila existente — las columnas nuevas solo agregan
--     su DEFAULT.
--   - NO crea ninguna versión nueva (V2 real) — la creará el administrador
--     desde la interfaz DESPUÉS de aplicar esta migración y el cambio de
--     código pendiente en configuracionDesignacionRepositorio.js (preparado
--     en esta misma entrega, ver informe — NO desplegado todavía).
--   - NO activa nada.
--   - NO toca asignaciones, evaluaciones, notas_rodeo ni ninguna tabla de
--     datos operativos — exclusivamente configuración.
--
-- COMPATIBILIDAD DE CÓDIGO:
-- configuracionDesignacionRepositorio.js YA fue actualizado (esta misma
-- entrega, ver informe) para: (a) leer las 2 columnas nuevas en SELECT_
-- VERSION, y (b) elegir explícitamente crear_configuracion_designacion_
-- version (schema 1) o crear_configuracion_designacion_version_v2 (schema 2)
-- según configuracion.schema_version. Ese cambio de código NO se despliega
-- en este commit — cuando se despliegue, requerirá que esta migración ya
-- esté aplicada (leer/escribir columnas y una RPC que no existen antes de
-- 052 falla con un error claro de Postgres — nunca un fallback silencioso).
-- Orden de despliegue: 1) aplicar 052, 2) desplegar el código actualizado
-- del repositorio (en cualquier momento posterior, sin apuro — el backend
-- actual sigue funcionando igual mientras tanto).
--
-- Reversible: DROP de las 2 columnas nuevas (con CASCADE de sus CHECK);
-- revertir chk_config_designacion_schema_version y el CHECK de criterio_
-- codigo a su versión anterior; DROP de crear_configuracion_designacion_
-- version_v2; CREATE OR REPLACE de _validar_estructura_configuracion_
-- designacion/activar_configuracion_designacion con el cuerpo de la
-- migración 051. crear_configuracion_designacion_version (legacy) nunca se
-- tocó, no requiere reversión.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Columnas nuevas — aditivas, DEFAULT deja intacta toda fila existente.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE configuracion_designacion_versiones
    ADD COLUMN IF NOT EXISTS regla_equidad_traslados_activa BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS umbral_lejania_km              NUMERIC;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. schema_version soportado: 1 o 2 (antes: solo 1).
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE configuracion_designacion_versiones
    DROP CONSTRAINT IF EXISTS chk_config_designacion_schema_version;
ALTER TABLE configuracion_designacion_versiones
    ADD CONSTRAINT chk_config_designacion_schema_version CHECK (schema_version IN (1, 2));

-- ─────────────────────────────────────────────────────────────────────────
-- 3. umbral_lejania_km — obligatorio/positivo SOLO si regla_equidad_
--    traslados_activa=true (mismo patrón que chk_config_designacion_distancia).
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE configuracion_designacion_versiones
    ADD CONSTRAINT chk_config_designacion_equidad CHECK (
        (regla_equidad_traslados_activa = false AND (umbral_lejania_km IS NULL OR umbral_lejania_km > 0))
        OR (regla_equidad_traslados_activa = true AND umbral_lejania_km IS NOT NULL AND umbral_lejania_km > 0 AND umbral_lejania_km <= 5000)
    );

-- ─────────────────────────────────────────────────────────────────────────
-- 4. regla_equidad_traslados_activa=true EXIGE schema_version=2 — imposible
--    estructuralmente que V1 (o cualquier fila schema_version=1) la active.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE configuracion_designacion_versiones
    ADD CONSTRAINT chk_config_designacion_equidad_requiere_schema2 CHECK (
        regla_equidad_traslados_activa = false OR schema_version = 2
    );

-- ─────────────────────────────────────────────────────────────────────────
-- 5. criterio_codigo — agregar 'EQUIDAD_TRASLADOS'. Nombre del constraint
--    localizado dinámicamente (no se asume el autogenerado por Postgres).
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_constraint_name TEXT;
BEGIN
    SELECT con.conname INTO v_constraint_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'configuracion_designacion_orden_criterios'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%criterio_codigo%';

    IF v_constraint_name IS NULL THEN
        RAISE EXCEPTION 'Migración 052 abortada: no se encontró el CHECK de criterio_codigo en configuracion_designacion_orden_criterios — revise manualmente antes de reintentar. No se modificó nada.';
    END IF;

    EXECUTE format('ALTER TABLE configuracion_designacion_orden_criterios DROP CONSTRAINT %I', v_constraint_name);
END $$;

ALTER TABLE configuracion_designacion_orden_criterios
    ADD CONSTRAINT chk_orden_criterios_codigo CHECK (criterio_codigo IN (
        'PRIORIDAD_CATEGORIA', 'MENOS_DESIGNACIONES_TEMPORADA', 'MENOR_DISTANCIA', 'EQUIDAD_TRASLADOS'
    ));

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Validación estructural compartida — CREATE OR REPLACE. Bifurca según
--    schema_version de la versión: schema 1 = EXACTAMENTE las mismas
--    condiciones de siempre (nunca reinterpretadas); schema 2 = agrega las
--    condiciones de equidad de traslados, incluyendo que EQUIDAD_TRASLADOS
--    sea SIEMPRE orden=1 cuando la regla está activa (decisión de negocio
--    "siempre preferir cercanía").
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._validar_estructura_configuracion_designacion(p_version_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_schema_version         INTEGER;
    v_regla_equidad_activa   BOOLEAN;
    v_max_criterios          INTEGER;
    v_count_criterios        INTEGER;
    v_max_orden_crit         INTEGER;
    v_count_matriz           INTEGER;
    v_count_clasif           INTEGER;
    v_clasif                 TEXT;
    v_count_elegibles        INTEGER;
    v_max_orden_eleg         INTEGER;
    v_orden_equidad          INTEGER;
BEGIN
    -- A. La versión debe existir.
    SELECT schema_version, regla_equidad_traslados_activa
    INTO v_schema_version, v_regla_equidad_activa
    FROM public.configuracion_designacion_versiones
    WHERE id = p_version_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Versión de configuración de designación no encontrada: % — no se activa ninguna versión, la actual permanece igual.', p_version_id;
    END IF;

    -- B. schema_version soportado: 1 (histórico) o 2 (equidad de traslados).
    IF v_schema_version NOT IN (1, 2) THEN
        RAISE EXCEPTION 'Versión % tiene schema_version % no soportado (se requiere 1 o 2) — no se activa, la configuración actual permanece igual.', p_version_id, v_schema_version;
    END IF;

    -- schema_version=1 NUNCA debe tener la regla de equidad activa — ya lo
    -- garantiza chk_config_designacion_equidad_requiere_schema2 en la tabla
    -- (estructuralmente imposible insertar esa combinación), se revalida acá
    -- como defensa en profundidad explícita, sin reinterpretar schema 1.
    IF v_schema_version = 1 AND v_regla_equidad_activa THEN
        RAISE EXCEPTION 'Versión %: schema_version=1 no puede tener regla_equidad_traslados_activa=true — no se activa.', p_version_id;
    END IF;

    -- C/D/E/F/G. Orden de criterios: 1..N sin huecos. El máximo de criterios
    -- conocidos depende del schema (3 para schema 1, histórico intacto; 4
    -- para schema 2, que suma EQUIDAD_TRASLADOS).
    v_max_criterios := CASE WHEN v_schema_version = 2 THEN 4 ELSE 3 END;

    SELECT count(*), max(orden) INTO v_count_criterios, v_max_orden_crit
    FROM public.configuracion_designacion_orden_criterios
    WHERE version_id = p_version_id;

    IF v_count_criterios IS NULL OR v_count_criterios < 1 THEN
        RAISE EXCEPTION 'Versión % no tiene ningún criterio de ranking activo (mínimo 1 requerido) — no se activa.', p_version_id;
    END IF;
    IF v_count_criterios > v_max_criterios THEN
        RAISE EXCEPTION 'Versión % tiene % criterios de ranking, más de los % conocidos para schema_version=% — no se activa.', p_version_id, v_count_criterios, v_max_criterios, v_schema_version;
    END IF;
    IF v_max_orden_crit IS DISTINCT FROM v_count_criterios THEN
        RAISE EXCEPTION 'Versión %: el orden de criterios no es secuencial sin huecos (máximo=%, cantidad=%) — no se activa.', p_version_id, v_max_orden_crit, v_count_criterios;
    END IF;

    -- NUEVO (schema 2) — EQUIDAD_TRASLADOS, si aparece en el orden, SOLO es
    -- válido para schema_version=2, y SOLO si regla_equidad_traslados_activa
    -- está activa, y SIEMPRE debe ser el criterio Nº1 (decisión de negocio:
    -- "siempre preferir cercanía" — un criterio anterior a equidad podría
    -- decidir entre un candidato CERCA y uno LEJOS antes de que la cercanía
    -- pese, lo cual está prohibido). schema_version=1 JAMÁS puede tener este
    -- criterio en su orden — se revalida acá aunque el CHECK de la tabla ya
    -- lo permitiría a nivel de fila individual (el CHECK no puede saber a
    -- qué versión/schema pertenece esa fila).
    SELECT orden INTO v_orden_equidad
    FROM public.configuracion_designacion_orden_criterios
    WHERE version_id = p_version_id AND criterio_codigo = 'EQUIDAD_TRASLADOS';

    IF v_orden_equidad IS NOT NULL THEN
        IF v_schema_version <> 2 THEN
            RAISE EXCEPTION 'Versión %: EQUIDAD_TRASLADOS en el orden de criterios requiere schema_version=2 (tiene %) — no se activa.', p_version_id, v_schema_version;
        END IF;
        IF NOT v_regla_equidad_activa THEN
            RAISE EXCEPTION 'Versión %: EQUIDAD_TRASLADOS está en el orden de criterios pero regla_equidad_traslados_activa no está activa — estado inconsistente, no se activa.', p_version_id;
        END IF;
        IF v_orden_equidad <> 1 THEN
            RAISE EXCEPTION 'Versión %: EQUIDAD_TRASLADOS debe ser el criterio Nº1 (orden=1) mientras regla_equidad_traslados_activa esté activa (tiene orden=%) — así se garantiza que la cercanía siempre se evalúe antes que cualquier otro criterio. No se activa.', p_version_id, v_orden_equidad;
        END IF;
    ELSIF v_regla_equidad_activa THEN
        RAISE EXCEPTION 'Versión %: regla_equidad_traslados_activa está activa pero EQUIDAD_TRASLADOS no está en el orden de criterios — no se activa.', p_version_id;
    END IF;

    -- H/I. Matriz completa: exactamente 18 filas (6 clasificaciones × 3
    -- categorías) — MISMA condición para ambos schemas, sin cambios.
    SELECT count(*), count(DISTINCT clasificacion_codigo) INTO v_count_matriz, v_count_clasif
    FROM public.configuracion_designacion_matriz
    WHERE version_id = p_version_id;

    IF v_count_matriz <> 18 OR v_count_clasif <> 6 THEN
        RAISE EXCEPTION 'Versión %: la matriz debe tener exactamente 18 filas (6 clasificaciones × 3 categorías); tiene % filas en % clasificaciones — no se activa.', p_version_id, v_count_matriz, v_count_clasif;
    END IF;

    -- J/K/L/M. Por cada clasificación: mínimo 1 elegible, orden_preferencia
    -- secuencial 1..N sin huecos — MISMA condición para ambos schemas.
    FOR v_clasif IN
        SELECT DISTINCT clasificacion_codigo FROM public.configuracion_designacion_matriz WHERE version_id = p_version_id
    LOOP
        SELECT count(*), max(orden_preferencia) INTO v_count_elegibles, v_max_orden_eleg
        FROM public.configuracion_designacion_matriz
        WHERE version_id = p_version_id AND clasificacion_codigo = v_clasif AND elegible = true;

        IF v_count_elegibles IS NULL OR v_count_elegibles < 1 THEN
            RAISE EXCEPTION 'Versión %: la clasificación "%" no tiene ninguna categoría elegible — no se activa.', p_version_id, v_clasif;
        END IF;
        IF v_max_orden_eleg IS DISTINCT FROM v_count_elegibles THEN
            RAISE EXCEPTION 'Versión %: el orden de preferencia de "%" no es secuencial sin huecos (máximo=%, elegibles=%) — no se activa.', p_version_id, v_clasif, v_max_orden_eleg, v_count_elegibles;
        END IF;
    END LOOP;

    -- N. Distancia / equidad: ya garantizadas estructuralmente por
    --    chk_config_designacion_distancia / chk_config_designacion_equidad /
    --    chk_config_designacion_equidad_requiere_schema2 en la tabla.
END;
$$;

REVOKE ALL ON FUNCTION public._validar_estructura_configuracion_designacion(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._validar_estructura_configuracion_designacion(UUID) FROM anon;
REVOKE ALL ON FUNCTION public._validar_estructura_configuracion_designacion(UUID) FROM authenticated;
REVOKE ALL ON FUNCTION public._validar_estructura_configuracion_designacion(UUID) FROM service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. activar_configuracion_designacion — CREATE OR REPLACE, misma firma UUID
--    exacta, comportamiento externo idéntico (mismos mensajes de error para
--    los mismos casos, ahora ampliados a schema 2) — delega en el punto 6.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.activar_configuracion_designacion(p_version_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public._validar_estructura_configuracion_designacion(p_version_id);

    UPDATE public.configuracion_designacion_versiones
        SET activa = false
        WHERE activa = true AND id <> p_version_id;

    UPDATE public.configuracion_designacion_versiones
        SET activa = true
        WHERE id = p_version_id;
END;
$$;

REVOKE ALL ON FUNCTION public.activar_configuracion_designacion(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.activar_configuracion_designacion(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.activar_configuracion_designacion(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.activar_configuracion_designacion(UUID) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 8. crear_configuracion_designacion_version_v2 — RPC NUEVA (no reemplaza
--    nada). Exclusiva para crear versiones schema_version=2 con equidad de
--    traslados. La RPC legacy (10 parámetros, migración 051) sigue existiendo
--    sin cambios — ver nota de ESTRATEGIA al inicio del archivo.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.crear_configuracion_designacion_version_v2(
    p_regla_distancia_maxima_activa        BOOLEAN,
    p_distancia_maxima_km                  NUMERIC,
    p_regla_no_repetir_asociacion_activa   BOOLEAN,
    p_regla_un_rodeo_por_finde_activa      BOOLEAN,
    p_regla_finde_consecutivo_activa       BOOLEAN,
    p_regla_asociacion_organizadora_activa BOOLEAN,
    p_regla_equidad_traslados_activa       BOOLEAN,
    p_umbral_lejania_km                    NUMERIC,
    p_descripcion                          TEXT,
    p_creado_por                           UUID,
    -- [{"criterio_codigo":"EQUIDAD_TRASLADOS","orden":1}, ...] — SOLO los criterios ACTIVOS.
    p_orden_criterios                      JSONB,
    -- [{"clasificacion_codigo":"provincial","categoria":"A","elegible":true,"orden_preferencia":1}, ...] — EXACTAMENTE 18 filas.
    p_matriz                               JSONB
)
RETURNS TABLE(id UUID, numero_version INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_version_id     UUID;
    v_numero_version INTEGER;
BEGIN
    -- schema_version fijo a 2 — esta RPC NUNCA crea otro schema. activa=false
    -- SIEMPRE — activar sigue siendo un paso separado y explícito.
    INSERT INTO public.configuracion_designacion_versiones (
        schema_version, activa,
        regla_distancia_maxima_activa, distancia_maxima_km,
        regla_no_repetir_asociacion_activa, regla_un_rodeo_por_finde_activa,
        regla_finde_consecutivo_activa, regla_asociacion_organizadora_activa,
        regla_equidad_traslados_activa, umbral_lejania_km,
        descripcion, creado_por
    ) VALUES (
        2, false,
        p_regla_distancia_maxima_activa, p_distancia_maxima_km,
        p_regla_no_repetir_asociacion_activa, p_regla_un_rodeo_por_finde_activa,
        p_regla_finde_consecutivo_activa, p_regla_asociacion_organizadora_activa,
        p_regla_equidad_traslados_activa, p_umbral_lejania_km,
        p_descripcion, p_creado_por
    )
    RETURNING configuracion_designacion_versiones.id, configuracion_designacion_versiones.numero_version
    INTO v_version_id, v_numero_version;

    -- Códigos de criterio/clasificación/categoría ya restringidos por los
    -- CHECK de las tablas (punto 5 de esta migración + migración 050) — un
    -- código desconocido aborta el INSERT correspondiente.
    INSERT INTO public.configuracion_designacion_orden_criterios (version_id, criterio_codigo, orden)
    SELECT v_version_id, x.criterio_codigo, x.orden
    FROM jsonb_to_recordset(COALESCE(p_orden_criterios, '[]'::jsonb)) AS x(criterio_codigo TEXT, orden INTEGER);

    INSERT INTO public.configuracion_designacion_matriz (version_id, clasificacion_codigo, categoria, elegible, orden_preferencia)
    SELECT v_version_id, x.clasificacion_codigo, x.categoria, x.elegible, x.orden_preferencia
    FROM jsonb_to_recordset(COALESCE(p_matriz, '[]'::jsonb)) AS x(clasificacion_codigo TEXT, categoria TEXT, elegible BOOLEAN, orden_preferencia INTEGER);

    -- Misma validación estructural que exige activar_configuracion_
    -- designacion (punto 6) — incluye que EQUIDAD_TRASLADOS sea orden=1 si
    -- la regla está activa. Si falla, PostgreSQL revierte los 3 INSERT de
    -- arriba como una sola unidad — nunca queda una cabecera huérfana.
    PERFORM public._validar_estructura_configuracion_designacion(v_version_id);

    RETURN QUERY SELECT v_version_id, v_numero_version;
END;
$$;

REVOKE ALL ON FUNCTION public.crear_configuracion_designacion_version_v2(
    BOOLEAN, NUMERIC, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, NUMERIC, TEXT, UUID, JSONB, JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crear_configuracion_designacion_version_v2(
    BOOLEAN, NUMERIC, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, NUMERIC, TEXT, UUID, JSONB, JSONB
) FROM anon;
REVOKE ALL ON FUNCTION public.crear_configuracion_designacion_version_v2(
    BOOLEAN, NUMERIC, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, NUMERIC, TEXT, UUID, JSONB, JSONB
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.crear_configuracion_designacion_version_v2(
    BOOLEAN, NUMERIC, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, NUMERIC, TEXT, UUID, JSONB, JSONB
) TO service_role;

COMMIT;

-- ── Verificación sugerida post-aplicación (no destructiva) ─────────────────
--
-- ESTADO 1 — backend actualmente desplegado sigue funcionando SIN cambios:
-- SELECT proname, pronargs FROM pg_proc WHERE proname = 'crear_configuracion_designacion_version';
--   -- debe existir CON pronargs=10 (la firma legacy, intacta).
-- -- Prueba NO destructiva de la RPC legacy (mismos 10 parámetros de siempre):
-- -- SELECT * FROM crear_configuracion_designacion_version(
-- --   true, 600, true, true, true, true, 'Prueba post-052 RPC legacy (verificar y considerar no dejarla)', NULL,
-- --   '[{"criterio_codigo":"PRIORIDAD_CATEGORIA","orden":1},{"criterio_codigo":"MENOS_DESIGNACIONES_TEMPORADA","orden":2},{"criterio_codigo":"MENOR_DISTANCIA","orden":3}]'::jsonb,
-- --   '[]'::jsonb -- fallaría a propósito (matriz incompleta) para probar el rollback atómico sin dejar basura
-- -- );
-- -- Debe crear (o fallar en la validación, según la matriz) EXACTAMENTE igual que antes de aplicar esta migración.
--
-- SELECT numero_version, schema_version, regla_equidad_traslados_activa, umbral_lejania_km
--   FROM configuracion_designacion_versiones ORDER BY numero_version;
--   -- La Versión 1 debe seguir mostrando: schema_version=1,
--   -- regla_equidad_traslados_activa=false, umbral_lejania_km=NULL.
--   -- (0 filas nuevas — esta migración no crea ninguna versión.)
--
-- ESTADO 3 — la RPC nueva existe y es utilizable (solo lectura/prueba):
-- SELECT proname, pronargs FROM pg_proc WHERE proname = 'crear_configuracion_designacion_version_v2';
--   -- debe existir con pronargs=12.
--
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'configuracion_designacion_versiones'::regclass AND contype = 'c';
--   -- debe incluir chk_config_designacion_schema_version con "IN (1, 2)",
--   -- chk_config_designacion_equidad, chk_config_designacion_equidad_requiere_schema2.
--
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'configuracion_designacion_orden_criterios'::regclass AND contype = 'c';
--   -- debe incluir 'EQUIDAD_TRASLADOS' en la lista de códigos permitidos.
--
-- SELECT grantee, privilege_type FROM information_schema.routine_privileges
--   WHERE routine_name IN ('crear_configuracion_designacion_version', 'crear_configuracion_designacion_version_v2', 'activar_configuracion_designacion');
--   -- las 3 deben incluir service_role con EXECUTE, y NO incluir PUBLIC/anon/authenticated.
--
-- SELECT count(*) FROM configuracion_designacion_versiones;
--   -- debe seguir en 1 si no se creó ninguna versión de prueba.
