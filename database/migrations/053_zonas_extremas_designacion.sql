-- ═════════════════════════════════════════════════════════════════════════
-- 053_zonas_extremas_designacion.sql
-- Configuración de Propuesta de Designación — nueva regla "ZONAS EXTREMAS"
--
-- ✅ APLICADA EN PRODUCCIÓN (aplicada vía mcp Supabase apply_migration el
--    2026-09-08, con precheck/postcheck de solo lectura antes y después,
--    mismo protocolo que 050/051/052). NO volver a ejecutarla.
--
-- QUÉ ES "ZONAS EXTREMAS" (ver informe de diseño de esta mejora): para
-- ciertas asociaciones organizadoras (ej. MAGALLANES, AYSÉN, CUYO — lista
-- CONFIGURABLE, nunca hardcodeada en el motor), la prioridad de categoría
-- del jurado NO la decide la matriz normal por clasificación de rodeo
-- (interclubes/provincial/interasociaciones/zonal/clasificatorio/nacional)
-- — la decide una matriz especial versionada, propia de la regla Zona
-- Extrema, que tiene PRECEDENCIA total sobre la matriz normal para esas
-- asociaciones. Ninguna otra regla del motor (disponibilidad, asociación,
-- fin de semana, equidad de designaciones, distancia, EQUIDAD_TRASLADOS...)
-- se ve afectada — Zona Extrema solo sustituye la fuente de elegibilidad/
-- prioridad de CATEGORÍA.
--
-- POR QUÉ schema_version=3 (no reutilizar 1 ni 2) — análisis explícito:
--   - Zonas Extremas agrega un CONTRATO ESTRUCTURAL nuevo a la configuración
--     versionada: dos tablas hijas nuevas (asociaciones + categorías
--     especiales) y una regla de PRECEDENCIA que altera cómo se interpreta
--     la matriz ya existente para un subconjunto de rodeos — no es un
--     parámetro nuevo de un criterio ya existente (a diferencia de
--     EQUIDAD_TRASLADOS, que solo agregó un criterio de RANKING nuevo sin
--     tocar en absoluto cómo se resuelve la matriz de categorías).
--   - Aceptar esto como "schema_version=2 con columnas opcionales" mezclaría
--     dos contratos estructurales independientes (equidad de traslados +
--     zonas extremas) bajo el mismo número de schema, dificultando razonar
--     qué firma de RPC/tablas corresponde a cada combinación real. Un
--     schema_version nuevo, aditivo (NUNCA reemplaza el significado de 1 ni
--     2), mantiene cada contrato estructural identificable sin ambigüedad.
--   - schema_version=3 SIGUE ADMITIENDO TODO schema_version=2 (EQUIDAD_
--     TRASLADOS incluida) — ambas reglas son ortogonales y pueden convivir
--     activas en la misma versión (sección 13 del pedido: "no crear un
--     segundo motor" — EQUIDAD_TRASLADOS, si está activa, sigue siendo
--     SIEMPRE el criterio Nº1 global; Zonas Extremas solo decide qué
--     categorías participan de PRIORIDAD_CATEGORIA).
--   - numero_version (visible en UI) y schema_version (técnico) NO son lo
--     mismo — la próxima versión real que cree el administrador puede
--     mostrarse como "v2" mientras internamente es schema_version=3; la UI
--     no necesita exponer este detalle técnico.
--
-- ESTRATEGIA: EXPAND, igual que 051→052. NINGUNA firma/función/tabla
-- existente se modifica de forma incompatible:
--   - crear_configuracion_designacion_version(...)    (schema 1, 10 params) — INTACTA.
--   - crear_configuracion_designacion_version_v2(...) (schema 2, 12 params) — INTACTA.
--   - Se agrega crear_configuracion_designacion_version_v3(...) (schema 3,
--     15 params = los 12 de v2 + 3 nuevos de Zonas Extremas), EXCLUSIVA para
--     crear versiones schema_version=3.
--   - activar_configuracion_designacion(UUID) mantiene su firma UUID exacta
--     — ahora también valida versiones schema_version=3, delegando en el
--     helper estructural actualizado (mismo patrón que 052).
--   - _validar_estructura_configuracion_designacion(UUID) — CREATE OR
--     REPLACE, bifurca UNA vez más: schema 1 y schema 2 quedan EXACTAMENTE
--     como los dejó 052 (comportamiento histórico intacto, no reinterpretado);
--     schema 3 admite hasta 4 criterios de ranking (los mismos que schema 2)
--     y agrega las condiciones nuevas de Zonas Extremas.
--
-- Aplicar esta migración, POR SÍ SOLA, es funcionalmente transparente para
-- producción: 0 filas modificadas (el DEFAULT deja toda fila existente en
-- regla_zonas_extremas_activa=false, sin ningún UPDATE), 0 comportamiento
-- distinto para nada de lo que ya existe (V1 y cualquier versión
-- schema_version=2 ya creada siguen funcionando idénticas). El backend
-- actualmente desplegado puede seguir corriendo sin ningún cambio de código
-- después de aplicarla — el código que la USA (configuracionDesignacion.js /
-- configuracionDesignacionRepositorio.js / motorPropuestaDesignacion.js) se
-- despliega en un momento posterior, después de aplicar esta migración
-- (mismo orden que 052: 1) migración, 2) código).
--
-- QUÉ HACE (todo aditivo; 0 DROP de datos ni de funciones existentes):
--   0. Extensión `unaccent` — CREATE EXTENSION IF NOT EXISTS, en el esquema
--      `extensions` (mismo patrón que pgcrypto/uuid-ossp ya usados acá).
--   1. configuracion_designacion_versiones — agrega 1 columna nueva:
--        regla_zonas_extremas_activa BOOLEAN NOT NULL DEFAULT false
--   2. chk_config_designacion_schema_version — CHECK (schema_version IN (1,2,3)).
--   3. chk_config_designacion_zonas_extremas_requiere_schema3 — regla_zonas_
--      extremas_activa=true EXIGE schema_version=3, estructuralmente.
--   4. configuracion_designacion_zonas_extremas — tabla NUEVA: asociaciones
--      incluidas en la regla, por versión. Asociación representada como
--      TEXT (ver "ASOCIACIÓN: SIN CATÁLOGO CON ID" más abajo) — NUNCA se
--      inventa una identidad paralela (asociacion_id) que el resto del
--      sistema no tiene.
--   5. configuracion_designacion_zona_extrema_categorias — tabla NUEVA:
--      elegibilidad/prioridad de A/B/C para la regla especial — MISMO
--      modelo que configuracion_designacion_matriz (3 filas siempre
--      presentes, incluida la no-elegible explícita), pero sin
--      clasificacion_codigo (una sola matriz especial por versión, no una
--      por clasificación — la regla ya no depende de clasificación).
--   5b. _normalizar_texto_designacion(TEXT) / _normalizar_asociacion_
--      designacion(TEXT) — funciones SQL NUEVAS, réplica paso a paso de
--      normalizarTexto()/normalizarAsociacion() (JS) usando `unaccent` —
--      cierran a nivel SQL la detección de asociaciones duplicadas
--      NORMALIZADAS (gate final previa a esta migración).
--   6. _validar_estructura_configuracion_designacion(p_version_id) — CREATE
--      OR REPLACE, bifurca una vez más (ver arriba) — ahora también rechaza
--      asociaciones de Zonas Extremas duplicadas después de normalizar.
--   7. activar_configuracion_designacion(p_version_id) — CREATE OR REPLACE,
--      comportamiento externo idéntico, delega en el punto 6.
--   8. crear_configuracion_designacion_version_v3(...) — RPC NUEVA.
--
-- ASOCIACIÓN: SIN CATÁLOGO CON ID (investigado antes de diseñar esta
-- migración — ver informe de esta mejora). El sistema NO tiene una tabla
-- "asociaciones" con id propio: rodeos.asociacion y usuarios_pagados.
-- asociacion son columnas TEXT libres; la única normalización existente es
-- normalizarAsociacion()/mismaAsociacion() (services/asociaciones.js, JS
-- puro, sin BD) para COMPARAR nombres, nunca una identidad canónica nueva.
-- El catálogo administrativo ya existente es GET /admin/propuesta-
-- designacion/asociaciones-existentes — valores DISTINCT ya usados hoy en
-- rodeos/usuarios_pagados activos. Zonas Extremas reutiliza EXACTAMENTE esa
-- misma fuente para el selector "+ Agregar asociación" — nunca texto libre
-- ni una tabla de catálogo paralela. La columna `asociacion` de la tabla
-- nueva guarda el nombre TAL COMO aparece en ese catálogo (misma
-- representación que ya usa el resto del sistema).
-- NORMALIZACIÓN Y DUPLICADOS — CERRADO A NIVEL SQL (gate final previa a
-- aplicar esta migración; ya NO es una limitación aceptada). El UNIQUE
-- (version_id, asociacion) de abajo sigue siendo una comparación LITERAL
-- (defensa en profundidad barata contra el caso obvio) — pero la garantía
-- REAL de "sin duplicados normalizados" vive en
-- _validar_estructura_configuracion_designacion() (punto 6 más abajo),
-- usando las funciones SQL nuevas _normalizar_texto_designacion()/
-- _normalizar_asociacion_designacion() — réplica SQL, paso a paso, de
-- normalizarTexto()/normalizarAsociacion() (geografia.js/asociaciones.js):
-- trim + minúsculas + sin tildes (extensión `unaccent`, activada por esta
-- misma migración) + guiones→espacio + espacios colapsados + sin el
-- prefijo "asociación ". Como esa validación SIEMPRE corre antes de que la
-- RPC v3 termine (schema_version=3, activa o no la regla — ver gate
-- anterior sobre datos latentes), y cualquier excepción revierte el INSERT
-- completo, resulta estructuralmente imposible persistir "AYSÉN" y "AYSEN"
-- (o " Aysén ") como dos asociaciones distintas de la misma configuración,
-- se llame a la RPC desde donde se llame.
--
-- QUÉ NO HACE (deliberadamente):
--   - NO toca ni elimina las RPC/tablas de 050/051/052 — todo intacto.
--   - NO modifica ninguna fila existente — la columna nueva solo agrega su
--     DEFAULT (false).
--   - NO crea ninguna versión nueva (schema_version=3 real) — la creará el
--     administrador desde la interfaz DESPUÉS de aplicar esta migración y
--     el código pendiente (preparado, NO desplegado en este mismo commit).
--   - NO activa nada.
--   - NO toca rodeos, asignaciones, evaluaciones, notas_rodeo ni temporadas
--     — exclusivamente configuración.
--   - NO hardcodea la lista de asociaciones de Zonas Extremas en ningún
--     lugar del backend/motor — solo esta migración documenta la lista
--     INICIAL/DEFAULT (ARICA Y TARAPACA, NORTE GRANDE, MAGALLANES, AYSÉN,
--     CUYO) como referencia de negocio; esa lista vive exclusivamente como
--     PAYLOAD que el frontend envía al crear una versión nueva con la regla
--     activada por primera vez — nunca como seed automático de esta
--     migración (ninguna versión se crea acá).
--
-- COMPATIBILIDAD DE CÓDIGO: igual disciplina que 052 — el código que lee
-- estas columnas/tablas (preparado en esta misma entrega, NO desplegado
-- todavía) falla con un error claro de Postgres si se despliega ANTES de
-- aplicar esta migración (columna/tabla/función inexistente), nunca un
-- fallback silencioso. Orden correcto: 1) aplicar 053, 2) desplegar código.
--
-- Reversible: DROP de la columna nueva (con CASCADE de sus CHECK); DROP de
-- las 2 tablas nuevas; DROP de _normalizar_texto_designacion/_normalizar_
-- asociacion_designacion (nadie más las usa); revertir chk_config_
-- designacion_schema_version a "IN (1,2)"; DROP de crear_configuracion_
-- designacion_version_v3; CREATE OR REPLACE de _validar_estructura_
-- configuracion_designacion/activar_configuracion_designacion con el cuerpo
-- de la migración 052. Las RPC legacy (v1) y v2 nunca se tocan, no
-- requieren reversión. La extensión `unaccent` puede quedar instalada sin
-- riesgo (no la usa nada más en el proyecto, pero DROP EXTENSION unaccent
-- también es seguro si se prefiere una reversión completa).
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 0. Extensión `unaccent` (contrib estándar de PostgreSQL, ya disponible en
--    este proyecto según `list_extensions` — solo no estaba habilitada
--    todavía). Se instala en el esquema `extensions`, mismo patrón que
--    pgcrypto/uuid-ossp/pg_stat_statements ya usados en este proyecto — NUNCA
--    en `public`. Necesaria para _normalizar_texto_designacion() más abajo
--    (gate final previa a esta migración: cerrar la detección de
--    duplicados NORMALIZADOS de asociación a nivel SQL, no solo en JS).
-- ─────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Columna nueva — aditiva, DEFAULT deja intacta toda fila existente.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE configuracion_designacion_versiones
    ADD COLUMN IF NOT EXISTS regla_zonas_extremas_activa BOOLEAN NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. schema_version soportado: 1, 2 o 3 (antes: 1 o 2).
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE configuracion_designacion_versiones
    DROP CONSTRAINT IF EXISTS chk_config_designacion_schema_version;
ALTER TABLE configuracion_designacion_versiones
    ADD CONSTRAINT chk_config_designacion_schema_version CHECK (schema_version IN (1, 2, 3));

-- ─────────────────────────────────────────────────────────────────────────
-- 3. regla_zonas_extremas_activa=true EXIGE schema_version=3 — imposible
--    estructuralmente que schema 1/2 la activen.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE configuracion_designacion_versiones
    ADD CONSTRAINT chk_config_designacion_zonas_extremas_requiere_schema3 CHECK (
        regla_zonas_extremas_activa = false OR schema_version = 3
    );

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Asociaciones incluidas en Zonas Extremas, por versión.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS configuracion_designacion_zonas_extremas (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id          UUID        NOT NULL REFERENCES configuracion_designacion_versiones(id) ON DELETE CASCADE,
    -- TEXT libre — misma representación que rodeos.asociacion/usuarios_
    -- pagados.asociacion (el sistema no tiene una tabla de asociaciones con
    -- id propio). Ver nota "ASOCIACIÓN: SIN CATÁLOGO CON ID" al inicio del
    -- archivo sobre el alcance real de este UNIQUE (comparación literal).
    asociacion          TEXT        NOT NULL CHECK (btrim(asociacion) <> ''),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_zonas_extremas_version_asociacion UNIQUE (version_id, asociacion)
);

CREATE INDEX IF NOT EXISTS idx_zonas_extremas_version ON configuracion_designacion_zonas_extremas(version_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Elegibilidad/prioridad de categoría para la regla Zona Extrema, por
--    versión — MISMO modelo que configuracion_designacion_matriz (siempre
--    las 3 categorías A/B/C explícitas), sin clasificacion_codigo: una sola
--    matriz especial por versión (sustituye a las 6 normales para las
--    asociaciones incluidas, sección 2 del pedido: "no importa el tipo/
--    clasificación del rodeo").
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS configuracion_designacion_zona_extrema_categorias (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id              UUID        NOT NULL REFERENCES configuracion_designacion_versiones(id) ON DELETE CASCADE,
    categoria               TEXT        NOT NULL CHECK (categoria IN ('A', 'B', 'C')),
    elegible                BOOLEAN     NOT NULL,
    orden_preferencia       INTEGER,

    CONSTRAINT uq_zona_extrema_cat_version_categoria UNIQUE (version_id, categoria),
    -- Mismo razonamiento que uq_matriz_version_clasif_orden: NULL nunca
    -- colisiona consigo mismo, así que esto no bloquea que varias categorías
    -- no-elegibles compartan orden_preferencia=NULL.
    CONSTRAINT uq_zona_extrema_cat_version_orden    UNIQUE (version_id, orden_preferencia),
    CONSTRAINT chk_zona_extrema_cat_elegible_orden CHECK (
        (elegible = false AND orden_preferencia IS NULL)
        OR (elegible = true AND orden_preferencia IS NOT NULL AND orden_preferencia > 0)
    )
);

CREATE INDEX IF NOT EXISTS idx_zona_extrema_categorias_version ON configuracion_designacion_zona_extrema_categorias(version_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 5b. Normalización SQL — réplica PASO A PASO de normalizarTexto()/
--     normalizarAsociacion() (backend/src/services/geografia.js /
--     asociaciones.js, JS puro) — gate final previa a esta migración:
--     "no inventar una normalización diferente". MISMA secuencia exacta:
--       normalizarTexto:      trim → minúsculas → sin tildes (NFD+strip) →
--                              guiones/en-dash/em-dash→espacio → espacios
--                              colapsados → trim.
--       normalizarAsociacion: normalizarTexto(...) → quitar prefijo
--                              "asociacion " (ya en minúsculas/sin tilde en
--                              este punto) → trim.
--     STABLE (no IMMUTABLE): unaccent() depende de la configuración de
--     diccionario de texto de la sesión — por eso estas funciones se usan
--     SOLO dentro de la validación (una consulta normal), nunca en un
--     índice de expresión (que exigiría IMMUTABLE). El UNIQUE(version_id,
--     asociacion) de la tabla sigue siendo literal — la garantía
--     normalizada vive acá, ejercida por _validar_estructura_configuracion_
--     designacion() (punto 6 más abajo) en cada creación/activación.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._normalizar_texto_designacion(p_texto TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
    SELECT btrim(
        regexp_replace(
            regexp_replace(
                lower(extensions.unaccent(btrim(coalesce(p_texto, '')))),
                '[-–—]+', ' ', 'g'
            ),
            '\s+', ' ', 'g'
        )
    );
$$;

-- Privilegios: MISMO patrón "interna, callable por nadie directamente" que
-- _validar_estructura_configuracion_designacion (prefijo "_", REVOKE ALL de
-- los 4 roles incluido service_role) — solo se invoca desde dentro de otra
-- función SECURITY DEFINER (ese es el uso real, único, previsto).
REVOKE ALL ON FUNCTION public._normalizar_texto_designacion(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._normalizar_texto_designacion(TEXT) FROM anon;
REVOKE ALL ON FUNCTION public._normalizar_texto_designacion(TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public._normalizar_texto_designacion(TEXT) FROM service_role;

CREATE OR REPLACE FUNCTION public._normalizar_asociacion_designacion(p_texto TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
    SELECT btrim(regexp_replace(public._normalizar_texto_designacion(p_texto), '^asociacion\s+', ''));
$$;

REVOKE ALL ON FUNCTION public._normalizar_asociacion_designacion(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._normalizar_asociacion_designacion(TEXT) FROM anon;
REVOKE ALL ON FUNCTION public._normalizar_asociacion_designacion(TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public._normalizar_asociacion_designacion(TEXT) FROM service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Validación estructural compartida — CREATE OR REPLACE. Bifurca una vez
--    más: schema 1 y schema 2 quedan EXACTAMENTE como las dejó la migración
--    052 (nunca reinterpretadas); schema 3 admite hasta 4 criterios (los
--    mismos que schema 2 — Zonas Extremas no agrega ningún criterio de
--    ranking nuevo, EQUIDAD_TRASLADOS sigue disponible y ortogonal) y agrega
--    las condiciones nuevas de Zonas Extremas.
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
    v_regla_zonas_activa     BOOLEAN;
    v_max_criterios          INTEGER;
    v_count_criterios        INTEGER;
    v_max_orden_crit         INTEGER;
    v_count_matriz           INTEGER;
    v_count_clasif           INTEGER;
    v_clasif                 TEXT;
    v_count_elegibles        INTEGER;
    v_max_orden_eleg         INTEGER;
    v_orden_equidad          INTEGER;
    v_count_zonas_asoc       INTEGER;
    v_count_zonas_cat        INTEGER;
    v_count_zonas_cat_eleg   INTEGER;
    v_max_orden_zonas_cat    INTEGER;
BEGIN
    -- A. La versión debe existir.
    SELECT schema_version, regla_equidad_traslados_activa, regla_zonas_extremas_activa
    INTO v_schema_version, v_regla_equidad_activa, v_regla_zonas_activa
    FROM public.configuracion_designacion_versiones
    WHERE id = p_version_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Versión de configuración de designación no encontrada: % — no se activa ninguna versión, la actual permanece igual.', p_version_id;
    END IF;

    -- B. schema_version soportado: 1 (histórico), 2 (equidad de traslados) o
    --    3 (zonas extremas — incluye todo lo de 2).
    IF v_schema_version NOT IN (1, 2, 3) THEN
        RAISE EXCEPTION 'Versión % tiene schema_version % no soportado (se requiere 1, 2 o 3) — no se activa, la configuración actual permanece igual.', p_version_id, v_schema_version;
    END IF;

    -- schema_version=1 NUNCA debe tener la regla de equidad activa — mismo
    -- comportamiento histórico exacto de la migración 052, sin reinterpretar.
    IF v_schema_version = 1 AND v_regla_equidad_activa THEN
        RAISE EXCEPTION 'Versión %: schema_version=1 no puede tener regla_equidad_traslados_activa=true — no se activa.', p_version_id;
    END IF;

    -- NUEVO — schema_version 1 o 2 NUNCA deben tener Zonas Extremas activa
    -- (ya lo garantiza chk_config_designacion_zonas_extremas_requiere_schema3
    -- estructuralmente; se revalida acá como defensa en profundidad).
    IF v_schema_version IN (1, 2) AND v_regla_zonas_activa THEN
        RAISE EXCEPTION 'Versión %: schema_version=% no puede tener regla_zonas_extremas_activa=true (requiere schema_version=3) — no se activa.', p_version_id, v_schema_version;
    END IF;

    -- C/D/E/F/G. Orden de criterios: 1..N sin huecos. El máximo de criterios
    -- conocidos depende del schema (3 para schema 1, histórico intacto; 4
    -- para schema 2 y 3, que suman EQUIDAD_TRASLADOS — Zonas Extremas NO
    -- agrega ningún criterio de ranking nuevo).
    v_max_criterios := CASE WHEN v_schema_version IN (2, 3) THEN 4 ELSE 3 END;

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

    -- EQUIDAD_TRASLADOS, si aparece en el orden, SOLO es válido desde
    -- schema_version=2 (incluye 3), y SOLO si regla_equidad_traslados_activa
    -- está activa, y SIEMPRE debe ser el criterio Nº1 — MISMA condición
    -- exacta que la migración 052, ahora extendida a schema 3 también.
    SELECT orden INTO v_orden_equidad
    FROM public.configuracion_designacion_orden_criterios
    WHERE version_id = p_version_id AND criterio_codigo = 'EQUIDAD_TRASLADOS';

    IF v_orden_equidad IS NOT NULL THEN
        IF v_schema_version NOT IN (2, 3) THEN
            RAISE EXCEPTION 'Versión %: EQUIDAD_TRASLADOS en el orden de criterios requiere schema_version 2 o 3 (tiene %) — no se activa.', p_version_id, v_schema_version;
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
    -- categorías) — MISMA condición para los 3 schemas, sin cambios. La
    -- matriz normal sigue existiendo siempre, aunque Zonas Extremas la
    -- sustituya para las asociaciones incluidas — nunca se elimina.
    SELECT count(*), count(DISTINCT clasificacion_codigo) INTO v_count_matriz, v_count_clasif
    FROM public.configuracion_designacion_matriz
    WHERE version_id = p_version_id;

    IF v_count_matriz <> 18 OR v_count_clasif <> 6 THEN
        RAISE EXCEPTION 'Versión %: la matriz debe tener exactamente 18 filas (6 clasificaciones × 3 categorías); tiene % filas en % clasificaciones — no se activa.', p_version_id, v_count_matriz, v_count_clasif;
    END IF;

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

    -- CORREGIDO (gate final previa a aplicar 053) — Zonas Extremas: separa
    -- DOS validaciones independientes, para schema_version=3 SIEMPRE (activa
    -- o no la regla — nunca condicionado por v_regla_zonas_activa salvo en
    -- el bloque de MÍNIMOS explícitamente marcado más abajo):
    --   A. ESTRUCTURAL — si existen filas (de asociaciones o de categorías),
    --      deben ser un conjunto COHERENTE: categorías, si las hay, deben
    --      ser exactamente 3 (A/B/C — los CHECK de la tabla ya garantizan
    --      categoría válida y orden NULL/positivo correcto según elegible;
    --      esto agrega lo que un CHECK de fila no puede expresar: "las 3
    --      categorías completas", "al menos 1 elegible" y "orden secuencial
    --      sin huecos" entre las elegibles) — MISMO criterio exacto que ya
    --      exige la matriz normal para CUALQUIER clasificación, sin
    --      excepción. "Datos latentes con la regla OFF" (decisión UX
    --      confirmada: apagar el toggle CONSERVA lo ya configurado) puede
    --      EXISTIR, pero si existe debe ser estructuralmente válido — nunca
    --      basura persistida solo porque no está en uso ahora mismo.
    --   B. MÍNIMOS — SOLO si v_regla_zonas_activa: además de válida, debe
    --      haber >=1 asociación Y las 3 categorías presentes (con lo cual la
    --      condición "A" ya garantiza >=1 elegible). Con la regla OFF, 0
    --      asociaciones/0 categorías (arrays vacíos) sigue siendo válido —
    --      apagar el toggle nunca obliga a vaciar, pero tampoco lo exige.
    IF v_schema_version = 3 THEN
        SELECT count(*) INTO v_count_zonas_asoc
        FROM public.configuracion_designacion_zonas_extremas
        WHERE version_id = p_version_id;

        -- A. ESTRUCTURAL, SIEMPRE (activa o no la regla) — gate final previa
        -- a esta migración: el UNIQUE(version_id, asociacion) de la tabla es
        -- literal, así que "AYSÉN" y "AYSEN" (o " Aysén ") podrían insertarse
        -- como 2 filas distintas sin esto. _normalizar_asociacion_designacion()
        -- reproduce normalizarAsociacion() (JS) paso a paso — nunca una
        -- normalización distinta.
        IF EXISTS (
            SELECT 1 FROM public.configuracion_designacion_zonas_extremas
            WHERE version_id = p_version_id
            GROUP BY public._normalizar_asociacion_designacion(asociacion)
            HAVING count(*) > 1
        ) THEN
            RAISE EXCEPTION 'Versión %: hay asociaciones de Zonas Extremas duplicadas después de normalizar (mayúsculas/tildes/espacios) — no se activa.', p_version_id;
        END IF;

        SELECT count(*) INTO v_count_zonas_cat
        FROM public.configuracion_designacion_zona_extrema_categorias
        WHERE version_id = p_version_id;

        -- A. Si existe AL MENOS 1 fila de categorías, deben ser EXACTAMENTE
        -- 3 (A/B/C explícitas) — nunca un conjunto parcial, sea cual sea el
        -- estado de la regla.
        IF v_count_zonas_cat NOT IN (0, 3) THEN
            RAISE EXCEPTION 'Versión %: si existen categorías de Zonas Extremas, deben ser exactamente 3 (A, B, C); tiene % — no se activa.', p_version_id, v_count_zonas_cat;
        END IF;

        IF v_count_zonas_cat = 3 THEN
            SELECT count(*), max(orden_preferencia) INTO v_count_zonas_cat_eleg, v_max_orden_zonas_cat
            FROM public.configuracion_designacion_zona_extrema_categorias
            WHERE version_id = p_version_id AND elegible = true;

            -- A. Estructural SIEMPRE (igual que la matriz normal: un
            -- conjunto de 3 filas, si existe, debe tener al menos 1
            -- elegible y orden secuencial sin huecos — no depende de
            -- v_regla_zonas_activa, es lo que significa "ser una matriz
            -- válida", tenga la regla el estado que tenga).
            IF v_count_zonas_cat_eleg IS NULL OR v_count_zonas_cat_eleg < 1 THEN
                RAISE EXCEPTION 'Versión %: la matriz de categorías de Zonas Extremas no tiene ninguna categoría elegible — no se activa.', p_version_id;
            END IF;
            IF v_max_orden_zonas_cat IS DISTINCT FROM v_count_zonas_cat_eleg THEN
                RAISE EXCEPTION 'Versión %: el orden de preferencia de categorías de Zonas Extremas no es secuencial sin huecos (máximo=%, elegibles=%) — no se activa.', p_version_id, v_max_orden_zonas_cat, v_count_zonas_cat_eleg;
            END IF;
        END IF;

        -- B. MÍNIMOS — SOLO si la regla está activa.
        IF v_regla_zonas_activa THEN
            IF v_count_zonas_asoc IS NULL OR v_count_zonas_asoc < 1 THEN
                RAISE EXCEPTION 'Versión %: regla_zonas_extremas_activa está activa pero no tiene ninguna asociación incluida (mínimo 1 requerida) — no se activa.', p_version_id;
            END IF;
            IF v_count_zonas_cat <> 3 THEN
                RAISE EXCEPTION 'Versión %: regla_zonas_extremas_activa está activa pero no tiene categorías configuradas (se requieren las 3: A, B, C) — no se activa.', p_version_id;
            END IF;
        END IF;
    END IF;

    -- N. Distancia / equidad: ya garantizadas estructuralmente por los CHECK
    --    de la tabla (defensa en profundidad, sin cambios respecto de 052).
    --    Zonas Extremas — categoría válida (CHECK IN ('A','B','C')), sin
    --    duplicados de categoría/orden (UNIQUE) y NULL/positivo coherente
    --    con `elegible` (CHECK chk_zona_extrema_cat_elegible_orden) también
    --    ya están garantizados SIEMPRE por los CHECK/UNIQUE de la tabla,
    --    independientes de este bloque — lo de acá cubre exclusivamente lo
    --    que un CHECK de una sola fila no puede expresar (cardinalidad
    --    entre filas: "exactamente 3", "al menos 1 elegible", "sin huecos").
    --    La deduplicación NORMALIZADA de asociaciones (case/tilde/guion-
    --    insensible) es responsabilidad exclusiva de la capa de aplicación
    --    (configuracionDesignacion.js validarZonasExtremas(), documentado en
    --    la cabecera de este archivo) — Postgres no puede invocar esa lógica.
END;
$$;

REVOKE ALL ON FUNCTION public._validar_estructura_configuracion_designacion(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._validar_estructura_configuracion_designacion(UUID) FROM anon;
REVOKE ALL ON FUNCTION public._validar_estructura_configuracion_designacion(UUID) FROM authenticated;
REVOKE ALL ON FUNCTION public._validar_estructura_configuracion_designacion(UUID) FROM service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. activar_configuracion_designacion — CREATE OR REPLACE, misma firma UUID
--    exacta, comportamiento externo idéntico — delega en el punto 6.
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
-- 8. crear_configuracion_designacion_version_v3 — RPC NUEVA (no reemplaza
--    nada). Exclusiva para crear versiones schema_version=3 con Zonas
--    Extremas. Las RPC v1/v2 siguen existiendo sin cambios.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.crear_configuracion_designacion_version_v3(
    p_regla_distancia_maxima_activa        BOOLEAN,
    p_distancia_maxima_km                  NUMERIC,
    p_regla_no_repetir_asociacion_activa   BOOLEAN,
    p_regla_un_rodeo_por_finde_activa      BOOLEAN,
    p_regla_finde_consecutivo_activa       BOOLEAN,
    p_regla_asociacion_organizadora_activa BOOLEAN,
    p_regla_equidad_traslados_activa       BOOLEAN,
    p_umbral_lejania_km                    NUMERIC,
    p_regla_zonas_extremas_activa          BOOLEAN,
    p_descripcion                          TEXT,
    p_creado_por                           UUID,
    -- [{"criterio_codigo":"EQUIDAD_TRASLADOS","orden":1}, ...] — SOLO los criterios ACTIVOS.
    p_orden_criterios                      JSONB,
    -- [{"clasificacion_codigo":"provincial","categoria":"A","elegible":true,"orden_preferencia":1}, ...] — EXACTAMENTE 18 filas.
    p_matriz                               JSONB,
    -- ["MAGALLANES","AYSEN",...] — asociaciones incluidas en Zonas Extremas.
    p_zonas_extremas_asociaciones          JSONB,
    -- [{"categoria":"A","elegible":false,"orden_preferencia":null}, ...] — EXACTAMENTE 3 filas.
    p_zonas_extremas_categorias            JSONB
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
    -- schema_version fijo a 3 — esta RPC NUNCA crea otro schema. activa=false
    -- SIEMPRE — activar sigue siendo un paso separado y explícito.
    INSERT INTO public.configuracion_designacion_versiones (
        schema_version, activa,
        regla_distancia_maxima_activa, distancia_maxima_km,
        regla_no_repetir_asociacion_activa, regla_un_rodeo_por_finde_activa,
        regla_finde_consecutivo_activa, regla_asociacion_organizadora_activa,
        regla_equidad_traslados_activa, umbral_lejania_km,
        regla_zonas_extremas_activa,
        descripcion, creado_por
    ) VALUES (
        3, false,
        p_regla_distancia_maxima_activa, p_distancia_maxima_km,
        p_regla_no_repetir_asociacion_activa, p_regla_un_rodeo_por_finde_activa,
        p_regla_finde_consecutivo_activa, p_regla_asociacion_organizadora_activa,
        p_regla_equidad_traslados_activa, p_umbral_lejania_km,
        p_regla_zonas_extremas_activa,
        p_descripcion, p_creado_por
    )
    RETURNING configuracion_designacion_versiones.id, configuracion_designacion_versiones.numero_version
    INTO v_version_id, v_numero_version;

    -- Códigos de criterio/clasificación/categoría ya restringidos por los
    -- CHECK de las tablas — un código desconocido aborta el INSERT.
    INSERT INTO public.configuracion_designacion_orden_criterios (version_id, criterio_codigo, orden)
    SELECT v_version_id, x.criterio_codigo, x.orden
    FROM jsonb_to_recordset(COALESCE(p_orden_criterios, '[]'::jsonb)) AS x(criterio_codigo TEXT, orden INTEGER);

    INSERT INTO public.configuracion_designacion_matriz (version_id, clasificacion_codigo, categoria, elegible, orden_preferencia)
    SELECT v_version_id, x.clasificacion_codigo, x.categoria, x.elegible, x.orden_preferencia
    FROM jsonb_to_recordset(COALESCE(p_matriz, '[]'::jsonb)) AS x(clasificacion_codigo TEXT, categoria TEXT, elegible BOOLEAN, orden_preferencia INTEGER);

    -- Zonas Extremas — asociaciones (array de strings) + categorías (3 filas).
    -- Se insertan SIEMPRE que vengan en el payload, activa o no la regla —
    -- permite guardar/editar la lista en un draft antes de activarla, y
    -- conservarla si se apaga el toggle sin perder lo ya configurado.
    INSERT INTO public.configuracion_designacion_zonas_extremas (version_id, asociacion)
    SELECT v_version_id, x.value
    FROM jsonb_array_elements_text(COALESCE(p_zonas_extremas_asociaciones, '[]'::jsonb)) AS x(value);

    INSERT INTO public.configuracion_designacion_zona_extrema_categorias (version_id, categoria, elegible, orden_preferencia)
    SELECT v_version_id, x.categoria, x.elegible, x.orden_preferencia
    FROM jsonb_to_recordset(COALESCE(p_zonas_extremas_categorias, '[]'::jsonb)) AS x(categoria TEXT, elegible BOOLEAN, orden_preferencia INTEGER);

    -- Misma validación estructural que exige activar_configuracion_
    -- designacion (punto 6) — incluye Zonas Extremas si está activa. Si
    -- falla, PostgreSQL revierte los 5 INSERT de arriba como una sola
    -- unidad — nunca queda una cabecera huérfana.
    PERFORM public._validar_estructura_configuracion_designacion(v_version_id);

    RETURN QUERY SELECT v_version_id, v_numero_version;
END;
$$;

REVOKE ALL ON FUNCTION public.crear_configuracion_designacion_version_v3(
    BOOLEAN, NUMERIC, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, NUMERIC, BOOLEAN, TEXT, UUID, JSONB, JSONB, JSONB, JSONB
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crear_configuracion_designacion_version_v3(
    BOOLEAN, NUMERIC, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, NUMERIC, BOOLEAN, TEXT, UUID, JSONB, JSONB, JSONB, JSONB
) FROM anon;
REVOKE ALL ON FUNCTION public.crear_configuracion_designacion_version_v3(
    BOOLEAN, NUMERIC, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, NUMERIC, BOOLEAN, TEXT, UUID, JSONB, JSONB, JSONB, JSONB
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.crear_configuracion_designacion_version_v3(
    BOOLEAN, NUMERIC, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, NUMERIC, BOOLEAN, TEXT, UUID, JSONB, JSONB, JSONB, JSONB
) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 9. RLS — administrativas, sin políticas públicas (mismo patrón que 050).
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE configuracion_designacion_zonas_extremas          ENABLE ROW LEVEL SECURITY;
ALTER TABLE configuracion_designacion_zona_extrema_categorias ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ── Verificación sugerida post-aplicación (no destructiva) ─────────────────
--
-- ESTADO 1 — backend actualmente desplegado sigue funcionando SIN cambios:
-- SELECT proname, pronargs FROM pg_proc WHERE proname IN
--   ('crear_configuracion_designacion_version', 'crear_configuracion_designacion_version_v2');
--   -- deben existir con pronargs=10 y 12 respectivamente (intactas).
--
-- SELECT numero_version, schema_version, regla_zonas_extremas_activa
--   FROM configuracion_designacion_versiones ORDER BY numero_version;
--   -- toda fila existente debe seguir mostrando regla_zonas_extremas_activa=false.
--   -- (0 filas nuevas — esta migración no crea ninguna versión.)
--
-- ESTADO 3 — la RPC nueva existe y es utilizable (solo lectura/prueba):
-- SELECT proname, pronargs FROM pg_proc WHERE proname = 'crear_configuracion_designacion_version_v3';
--   -- debe existir con pronargs=15.
--
-- SELECT table_name FROM information_schema.tables
--   WHERE table_name IN ('configuracion_designacion_zonas_extremas', 'configuracion_designacion_zona_extrema_categorias');
--   -- ambas deben existir.
--
-- SELECT grantee, privilege_type FROM information_schema.routine_privileges
--   WHERE routine_name = 'crear_configuracion_designacion_version_v3';
--   -- debe incluir service_role con EXECUTE, y NO incluir PUBLIC/anon/authenticated.
--
-- SELECT count(*) FROM configuracion_designacion_versiones;
--   -- debe seguir en 1 si no se creó ninguna versión de prueba (2 si V2 real ya existe).
--
-- ESTADO 4 — normalización SQL (gate final previa a esta migración):
-- SELECT extname, extnamespace::regnamespace FROM pg_extension WHERE extname = 'unaccent';
--   -- debe existir, instalada en el esquema "extensions".
-- SELECT public._normalizar_asociacion_designacion('  Aysén  '), public._normalizar_asociacion_designacion('AYSEN');
--   -- ambas deben devolver el mismo texto ('aysen') — ejecutar como el
--   -- propietario de la función (ej. vía SQL Editor de Supabase), NO desde
--   -- el service_role de la aplicación (ver nota de privilegios siguiente).
-- SELECT grantee, privilege_type FROM information_schema.routine_privileges
--   WHERE routine_name IN ('_normalizar_texto_designacion', '_normalizar_asociacion_designacion');
--   -- NO debe devolver ninguna fila (mismo patrón "interna, sin grants
--   -- directos" que _validar_estructura_configuracion_designacion) — solo
--   -- son invocables desde dentro de otra función SECURITY DEFINER.
