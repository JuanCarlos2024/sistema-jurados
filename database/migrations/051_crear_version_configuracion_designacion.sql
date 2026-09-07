-- ═════════════════════════════════════════════════════════════════════════
-- 051_crear_version_configuracion_designacion.sql
-- Configuración de Propuesta de Designación — Etapa 4 (UI de creación,
-- revisión y activación de versiones)
--
-- ✅ APLICADA MANUALMENTE EN PRODUCCIÓN por el administrador del proyecto
--    (vía MCP apply_migration, previa autorización explícita, revisión línea
--    por línea, precheck y validación de solo lectura antes/después) — mismo
--    criterio que la migración 050. Se conserva este archivo para dejar el
--    cambio versionado en el repositorio. Las 3 funciones son CREATE OR
--    REPLACE (idempotentes) — reaplicar este archivo no dañaría nada, pero
--    de todos modos no corresponde correrla de nuevo sin necesidad.
--    NO se creó ninguna versión (V2) ni se activó nada al aplicar — la
--    migración solo agrega funciones/permisos, cero filas de datos.
--
-- CONTEXTO:
-- Etapa 3 conectó el motor/preview/borradores a la configuración YA
-- PERSISTIDA en BD (configuracion_designacion_versiones/_orden_criterios/
-- _matriz, migración 050), pero no existía ninguna forma de CREAR una
-- versión nueva desde la aplicación — solo el seed manual de la Versión 1.
-- Esta migración agrega exactamente lo que falta para que la Etapa 4 pueda
-- crear versiones nuevas de forma seguridad-atómica, sin tocar nada más.
--
-- QUÉ HACE (todo aditivo; 0 DROP; 0 cambio de comportamiento observable en
-- lo que ya existía):
--   1. public._validar_estructura_configuracion_designacion(p_version_id) —
--      función NUEVA que EXTRAE, sin cambiar una sola condición ni un solo
--      mensaje de error, el bloque de validación estructural que hasta
--      ahora vivía inline dentro de activar_configuracion_designacion
--      (migración 050): existencia de la versión, schema_version soportado,
--      1-3 criterios de ranking con orden secuencial sin huecos, matriz
--      completa de 18 filas (6 clasificaciones × 3 categorías), y por cada
--      clasificación al menos 1 categoría elegible con orden_preferencia
--      secuencial sin huecos. Se extrae para poder reutilizarla también al
--      CREAR una versión (paso 3) sin duplicar la lógica un segundo lugar
--      — un error de las dos veces habría sido fácil de introducir con
--      copy/paste; con una sola función, activar y crear SIEMPRE exigen
--      exactamente la misma estructura mínima.
--   2. public.activar_configuracion_designacion(p_version_id) — CREATE OR
--      REPLACE: comportamiento EXTERNO IDÉNTICO al de la migración 050
--      (mismos parámetros, mismos mensajes de error, mismo efecto: valida
--      todo antes de tocar cualquier UPDATE, nunca dos activas ni cero
--      activas). El único cambio es que ahora delega la validación a la
--      función del punto 1 en vez de tenerla duplicada inline.
--   3. public.crear_configuracion_designacion_version(...) — función NUEVA,
--      ATÓMICA: inserta la cabecera (SIEMPRE con activa=false — activar es
--      un paso EXPLÍCITO y separado que el administrador dispara aparte,
--      nunca implícito al crear, sección 4 del pedido de Etapa 4), inserta
--      el orden de criterios y la matriz completa a partir de dos
--      parámetros JSONB, corre la MISMA validación estructural del punto 1,
--      y devuelve (id, numero_version) de la versión recién creada. Si
--      cualquier INSERT viola un CHECK/UNIQUE de la migración 050, o la
--      validación estructural final falla, la función completa termina en
--      una excepción no capturada — PostgreSQL revierte los 3 INSERT como
--      una sola unidad (una función que no confirma explícitamente hereda
--      la transacción de quien la llama: si termina en excepción, CERO
--      efectos persisten, nunca una cabecera huérfana sin sus criterios o
--      su matriz). No requiere BEGIN/COMMIT explícito dentro de la función
--      por este motivo. numero_version lo sigue asignando la SEQUENCE
--      dedicada ya creada en la migración 050 (DEFAULT nextval(...) de la
--      columna) — nunca un MAX(numero_version)+1 calculado en la
--      aplicación, así que dos administradores creando una versión al mismo
--      tiempo no pueden colisionar en el mismo número (sección 48).
--      schema_version se fija a 1 DENTRO de la función (no es un parámetro
--      recibido) — no existe ninguna forma de crear una versión con un
--      schema distinto al soportado hoy. Los códigos de criterio/
--      clasificación/categoría siguen exclusivamente los ya conocidos: los
--      mismos CHECK de la migración 050 sobre las tablas de criterios/
--      matriz siguen vigentes sin cambios y rechazan cualquier código nuevo
--      (sección "NO permitir crear reglas nuevas todavía" del pedido).
--
-- QUÉ NO HACE (deliberadamente):
--   - NO agrega ningún endpoint DELETE ni PATCH funcional de versiones —
--     siguen siendo históricas e inmutables por diseño (igual que la 050).
--   - NO activa la versión que crea — activar sigue siendo exclusivamente
--     activar_configuracion_designacion(), invocada aparte.
--   - NO modifica ninguna versión existente (V1 incluida) — solo agrega
--     filas nuevas cuando se llama explícitamente.
--   - NO modifica motorPropuestaDesignacion.js, previewIntegridad.js, ni
--     ninguna tabla fuera de las 3 ya creadas por la migración 050.
--   - NO agrega columnas ni tablas nuevas — reutiliza el modelo completo de
--     la migración 050 tal cual.
--
-- Permisos (revisados en la revisión final de Etapa 4 — permiso MÍNIMO, no
-- "el mismo patrón para las 3 por defecto"):
--   - activar_configuracion_designacion / crear_configuracion_designacion_
--     version: EXECUTE revocado de PUBLIC/anon/authenticated, otorgado
--     ÚNICAMENTE a service_role (el rol que usa el backend administrativo)
--     — mismo patrón que la migración 050.
--   - _validar_estructura_configuracion_designacion (helper interno): EXECUTE
--     revocado de PUBLIC/anon/authenticated Y TAMBIÉN de service_role — nadie
--     fuera del propio owner de las funciones puede invocarla ni directa ni
--     indirectamente desde la API; las dos funciones de arriba siguen
--     pudiendo llamarla vía PERFORM porque una función SECURITY DEFINER
--     ejecuta como su owner, y el owner (quien aplica la migración) es
--     también dueño del helper — no necesita que se le otorgue EXECUTE a sí
--     mismo. Ninguna de las 3 funciones es alcanzable desde PostgREST/anon/
--     authenticated.
--
-- Reversible: DROP FUNCTION de crear_configuracion_designacion_version y de
-- _validar_estructura_configuracion_designacion; activar_configuracion_
-- designacion puede recrearse con el CREATE OR REPLACE de la migración 050
-- si se revierte también su reemplazo aquí (mismo comportamiento externo,
-- así que revertir es seguro en cualquier momento).
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Validación estructural compartida — extraída sin cambios de
--    activar_configuracion_designacion (migración 050).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._validar_estructura_configuracion_designacion(p_version_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_schema_version   INTEGER;
    v_count_criterios  INTEGER;
    v_max_orden_crit   INTEGER;
    v_count_matriz     INTEGER;
    v_count_clasif     INTEGER;
    v_clasif           TEXT;
    v_count_elegibles  INTEGER;
    v_max_orden_eleg   INTEGER;
BEGIN
    -- A. La versión debe existir.
    SELECT schema_version INTO v_schema_version
    FROM public.configuracion_designacion_versiones
    WHERE id = p_version_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Versión de configuración de designación no encontrada: % — no se activa ninguna versión, la actual permanece igual.', p_version_id;
    END IF;

    -- B. schema_version soportado.
    IF v_schema_version <> 1 THEN
        RAISE EXCEPTION 'Versión % tiene schema_version % no soportado (se requiere 1) — no se activa, la configuración actual permanece igual.', p_version_id, v_schema_version;
    END IF;

    -- C/D/E/F/G. Orden de criterios: entre 1 y 3 filas, secuencia 1..N sin huecos.
    SELECT count(*), max(orden) INTO v_count_criterios, v_max_orden_crit
    FROM public.configuracion_designacion_orden_criterios
    WHERE version_id = p_version_id;

    IF v_count_criterios IS NULL OR v_count_criterios < 1 THEN
        RAISE EXCEPTION 'Versión % no tiene ningún criterio de ranking activo (mínimo 1 requerido) — no se activa.', p_version_id;
    END IF;
    IF v_count_criterios > 3 THEN
        RAISE EXCEPTION 'Versión % tiene % criterios de ranking, más de los 3 conocidos — no se activa.', p_version_id, v_count_criterios;
    END IF;
    IF v_max_orden_crit IS DISTINCT FROM v_count_criterios THEN
        RAISE EXCEPTION 'Versión %: el orden de criterios no es secuencial sin huecos (máximo=%, cantidad=%) — no se activa.', p_version_id, v_max_orden_crit, v_count_criterios;
    END IF;

    -- H/I. Matriz completa: exactamente 18 filas (6 clasificaciones × 3 categorías).
    SELECT count(*), count(DISTINCT clasificacion_codigo) INTO v_count_matriz, v_count_clasif
    FROM public.configuracion_designacion_matriz
    WHERE version_id = p_version_id;

    IF v_count_matriz <> 18 OR v_count_clasif <> 6 THEN
        RAISE EXCEPTION 'Versión %: la matriz debe tener exactamente 18 filas (6 clasificaciones × 3 categorías); tiene % filas en % clasificaciones — no se activa.', p_version_id, v_count_matriz, v_count_clasif;
    END IF;

    -- J/K/L/M. Por cada clasificación: mínimo 1 elegible, orden_preferencia secuencial 1..N sin huecos.
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

    -- N. Distancia: ya garantizada estructuralmente por
    --    chk_config_designacion_distancia en la tabla — no requiere revalidación aquí.
END;
$$;

-- Permiso MÍNIMO (revisión final, sección 4 del pedido): esta función es un
-- helper interno, invocado EXCLUSIVAMENTE vía PERFORM desde
-- activar_configuracion_designacion y crear_configuracion_designacion_version
-- — ambas SECURITY DEFINER, dueñas del mismo owner que esta función (quien
-- aplica la migración). Una función SECURITY DEFINER ejecuta como su owner;
-- si el owner puede invocar el helper (lo puede, es dueño de ambas), el
-- GRANT a service_role para la llamada INTERNA es innecesario. Se revoca de
-- TODOS los roles de API — ni siquiera service_role puede invocarla
-- directamente — solo las dos funciones de arriba, indirectamente.
REVOKE ALL ON FUNCTION public._validar_estructura_configuracion_designacion(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._validar_estructura_configuracion_designacion(UUID) FROM anon;
REVOKE ALL ON FUNCTION public._validar_estructura_configuracion_designacion(UUID) FROM authenticated;
REVOKE ALL ON FUNCTION public._validar_estructura_configuracion_designacion(UUID) FROM service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. activar_configuracion_designacion — CREATE OR REPLACE. Comportamiento
--    externo IDÉNTICO al de la migración 050 (mismos parámetros, mismos
--    mensajes, mismo efecto) — ahora delega la validación al punto 1.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.activar_configuracion_designacion(p_version_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Valida TODO antes de tocar cualquier UPDATE — si algo falla, la
    -- excepción aborta la función acá mismo y la configuración activa
    -- actual queda exactamente igual (mismo comportamiento que la 050).
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
-- 3. crear_configuracion_designacion_version — creación ATÓMICA de una
--    versión completa (cabecera + criterios + matriz), SIEMPRE inactiva.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.crear_configuracion_designacion_version(
    p_regla_distancia_maxima_activa        BOOLEAN,
    p_distancia_maxima_km                  NUMERIC,
    p_regla_no_repetir_asociacion_activa   BOOLEAN,
    p_regla_un_rodeo_por_finde_activa      BOOLEAN,
    p_regla_finde_consecutivo_activa       BOOLEAN,
    p_regla_asociacion_organizadora_activa BOOLEAN,
    p_descripcion                          TEXT,
    p_creado_por                           UUID,
    -- [{"criterio_codigo":"PRIORIDAD_CATEGORIA","orden":1}, ...] — SOLO los criterios ACTIVOS.
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
    -- schema_version fijo a 1 — no es parámetro, no hay forma de crear una
    -- versión con un schema distinto al soportado hoy. activa=false SIEMPRE
    -- — activar es un paso separado y explícito (sección 4 del pedido).
    INSERT INTO public.configuracion_designacion_versiones (
        schema_version, activa,
        regla_distancia_maxima_activa, distancia_maxima_km,
        regla_no_repetir_asociacion_activa, regla_un_rodeo_por_finde_activa,
        regla_finde_consecutivo_activa, regla_asociacion_organizadora_activa,
        descripcion, creado_por
    ) VALUES (
        1, false,
        p_regla_distancia_maxima_activa, p_distancia_maxima_km,
        p_regla_no_repetir_asociacion_activa, p_regla_un_rodeo_por_finde_activa,
        p_regla_finde_consecutivo_activa, p_regla_asociacion_organizadora_activa,
        p_descripcion, p_creado_por
    )
    RETURNING configuracion_designacion_versiones.id, configuracion_designacion_versiones.numero_version
    INTO v_version_id, v_numero_version;

    -- Códigos de criterio ya restringidos por el CHECK de la tabla (migración
    -- 050) — un código desconocido aborta este INSERT (y por lo tanto toda
    -- la función) sin necesidad de revalidarlo acá.
    INSERT INTO public.configuracion_designacion_orden_criterios (version_id, criterio_codigo, orden)
    SELECT v_version_id, x.criterio_codigo, x.orden
    FROM jsonb_to_recordset(COALESCE(p_orden_criterios, '[]'::jsonb)) AS x(criterio_codigo TEXT, orden INTEGER);

    -- Igual: clasificacion_codigo/categoria ya restringidos por CHECK; la
    -- combinación elegible/orden_preferencia por chk_matriz_elegible_orden.
    INSERT INTO public.configuracion_designacion_matriz (version_id, clasificacion_codigo, categoria, elegible, orden_preferencia)
    SELECT v_version_id, x.clasificacion_codigo, x.categoria, x.elegible, x.orden_preferencia
    FROM jsonb_to_recordset(COALESCE(p_matriz, '[]'::jsonb)) AS x(clasificacion_codigo TEXT, categoria TEXT, elegible BOOLEAN, orden_preferencia INTEGER);

    -- Misma validación estructural que exige activar_configuracion_
    -- designacion — nunca se deja persistir (ni siquiera inactiva) una
    -- versión que jamás podría activarse por estar incompleta o mal
    -- formada. Si falla, PostgreSQL revierte los 3 INSERT de arriba como
    -- una sola unidad — no puede quedar una cabecera huérfana.
    PERFORM public._validar_estructura_configuracion_designacion(v_version_id);

    RETURN QUERY SELECT v_version_id, v_numero_version;
END;
$$;

REVOKE ALL ON FUNCTION public.crear_configuracion_designacion_version(BOOLEAN, NUMERIC, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, TEXT, UUID, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crear_configuracion_designacion_version(BOOLEAN, NUMERIC, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, TEXT, UUID, JSONB, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.crear_configuracion_designacion_version(BOOLEAN, NUMERIC, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, TEXT, UUID, JSONB, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.crear_configuracion_designacion_version(BOOLEAN, NUMERIC, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, TEXT, UUID, JSONB, JSONB) TO service_role;

COMMIT;

-- ── Verificación sugerida post-aplicación (no destructiva) ─────────────────
-- SELECT proname FROM pg_proc WHERE proname IN
--   ('_validar_estructura_configuracion_designacion', 'activar_configuracion_designacion', 'crear_configuracion_designacion_version');
--   -- las 3 deben existir.
--
-- SELECT grantee, privilege_type FROM information_schema.routine_privileges
--   WHERE routine_name = 'crear_configuracion_designacion_version';
--   -- debe incluir service_role con EXECUTE, y NO incluir PUBLIC/anon/authenticated.
--
-- SELECT grantee, privilege_type FROM information_schema.routine_privileges
--   WHERE routine_name = '_validar_estructura_configuracion_designacion';
--   -- debe devolver 0 filas (nadie tiene EXECUTE otorgado explícitamente,
--   -- ni siquiera service_role — el owner la sigue pudiendo invocar).
--
-- -- Prueba funcional NO destructiva (crea y no activa) — ELIMINAR el bloque
-- -- si no se quiere ni siquiera una versión de prueba en BD:
-- -- SELECT * FROM crear_configuracion_designacion_version(
-- --   true, 600, true, true, true, true, 'Prueba post-migración (verificar y considerar no dejarla)', NULL,
-- --   '[{"criterio_codigo":"PRIORIDAD_CATEGORIA","orden":1},{"criterio_codigo":"MENOS_DESIGNACIONES_TEMPORADA","orden":2},{"criterio_codigo":"MENOR_DISTANCIA","orden":3}]'::jsonb,
-- --   '[]'::jsonb  -- fallaría a propósito (matriz incompleta) para probar el rollback atómico sin dejar basura
-- -- );
--
-- SELECT count(*) FROM configuracion_designacion_versiones;  -- debe seguir en 1 si no se creó nada de prueba
