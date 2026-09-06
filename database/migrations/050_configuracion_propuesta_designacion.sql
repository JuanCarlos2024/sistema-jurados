-- ═════════════════════════════════════════════════════════════════════════
-- 050_configuracion_propuesta_designacion.sql
-- Configuración administrable de reglas de Propuesta de Designación — Etapa 1
--
-- ✅ APLICADA MANUALMENTE EN PRODUCCIÓN por el administrador del proyecto
--    (vía MCP apply_migration, previa autorización explícita, revisión línea
--    por línea y validación de solo lectura antes/después). Se conserva este
--    archivo únicamente para dejar el cambio versionado en el repositorio —
--    NO debe volver a ejecutarse: el seed de la Versión 1 (bloque 7) no
--    verifica "¿ya existe una versión?" antes de insertar, así que un
--    segundo intento insertaría una fila nueva con activa=true, lo que
--    violaría idx_config_designacion_una_activa (índice único parcial que
--    impide dos versiones activas) y abortaría toda la migración — inocuo
--    si ocurriera por error, pero de todos modos no corresponde correrla de
--    nuevo.
--
-- CONTEXTO:
-- Hoy el motor (motorPropuestaDesignacion.js) tiene sus reglas y su orden de
-- prioridad HARDCODEADOS en el código (constante DISTANCIA_MAXIMA_KM=600,
-- orden fijo categoría→equidad→distancia, matriz en clasificacion_categoria_
-- matriz sin versionar). Esta migración crea el MODELO DE DATOS versionado
-- que permitirá administrar esas reglas desde Configuración — el motor NO
-- se modifica en esta migración ni en el código que la acompaña: sigue
-- leyendo exactamente las mismas fuentes que hoy (constante JS + tabla
-- clasificacion_categoria_matriz sin tocar). Esta migración crea la
-- infraestructura EN PARALELO, para una futura Etapa 2 que sí conectará el
-- motor, después de tests de equivalencia.
--
-- QUÉ HACE (todo aditivo; sin DROP de datos; sin tocar tablas existentes
-- salvo un ALTER TABLE aditivo sobre propuestas_designacion):
--   1. configuracion_designacion_versiones — cabecera de cada versión de
--      configuración. numero_version se genera con una SEQUENCE dedicada
--      (nextval, atómico a nivel de Postgres) — nunca un MAX(numero_version)+1
--      calculado en la aplicación, que sería vulnerable a condición de
--      carrera entre dos administradores creando una versión a la vez.
--      schema_version queda además restringido por CHECK a 1 (además de
--      revalidarse explícitamente dentro de la función de activación, como
--      defensa en profundidad) — evolucionar a un schema_version nuevo en el
--      futuro requiere una migración explícita que amplíe este CHECK.
--   2. idx_config_designacion_una_activa — índice único parcial sobre
--      (activa) WHERE activa=true, mismo patrón ya usado y probado en
--      temporadas (Etapa Temporadas 1): impide más de una versión activa
--      a nivel de base de datos.
--   3. configuracion_designacion_orden_criterios — el orden global (Nivel 1)
--      de los criterios de ranking. Solo existen filas para criterios
--      ACTIVOS de esa versión; un código ausente = inactivo para esa
--      versión. CHECK de códigos conocidos para schema_version=1.
--   4. configuracion_designacion_matriz — la matriz de categorías por
--      clasificación (Nivel 2), versionada, con las 6 clasificaciones × 3
--      categorías (A/B/C) SIEMPRE representadas explícitamente — una
--      categoría no habilitada existe como fila con elegible=false y
--      orden_preferencia=NULL, nunca como ausencia de fila. Esto deja lista
--      la futura UI (checkbox ☐/☑ por categoría) sin tener que "inventar"
--      una fila nueva cuando el administrador habilite una categoría hoy
--      inactiva — la fila ya existe, solo cambia de versión.
--   5. activar_configuracion_designacion(p_version_id) — función PL/pgSQL
--      ATÓMICA que primero VALIDA ESTRUCTURALMENTE la versión destino por
--      completo (existencia, schema_version, cantidad y secuencia de
--      criterios, matriz completa de 18 filas, mínimo 1 elegible por
--      clasificación con orden secuencial) y SOLO SI TODO es válido recién
--      entonces desactiva la actual y activa la destino — ambos UPDATE
--      dentro de la misma transacción implícita de la función. Si cualquier
--      validación falla, RAISE EXCEPTION aborta la función ANTES de tocar
--      cualquier UPDATE: la configuración actualmente activa queda
--      exactamente igual, nunca hay un estado intermedio con 0 activas.
--      `SET search_path = public, pg_temp` y objetos calificados con
--      `public.` explícitamente — no depende de un search_path manipulable.
--      EXECUTE revocado de PUBLIC/anon/authenticated y otorgado
--      explícitamente a service_role (ver sección de permisos más abajo).
--      NO se conecta todavía a ningún endpoint ni a la UI — queda preparada.
--   6. propuestas_designacion.configuracion_version_id — FK nullable
--      aditiva, sin backfill de propuestas existentes (quedan en NULL). Al
--      no especificar ON DELETE, el comportamiento por defecto de Postgres
--      es RESTRICT: nunca podrá borrarse una versión referenciada por una
--      propuesta. No se crea (ni se planea crear) ningún endpoint DELETE
--      administrativo de versiones — son históricas por diseño.
--   7. RLS habilitado en las 3 tablas nuevas, sin políticas (deny-all para
--      anon/authenticated). Se verificó (igual que en migraciones previas)
--      que ningún archivo de frontend/ usa supabase-js ni una anon key
--      directamente — todo pasa por la API del backend (service_role).
--   8. Seed DEFENSIVO de la Versión 1: antes de insertar, un bloque DO
--      verifica que clasificaciones_designacion tiene exactamente las 6
--      clasificaciones conocidas y que clasificacion_categoria_matriz tiene
--      EXACTAMENTE las 11 filas elegible=true con las prioridades
--      documentadas en el informe. Si algo no coincide, ABORTA con RAISE
--      EXCEPTION en vez de sembrar una Versión 1 potencialmente incorrecta.
--      Las 18 filas de la matriz versionada (6 clasificaciones × 3
--      categorías) se DERIVAN de esa misma tabla ya verificada mediante un
--      CROSS JOIN + LEFT JOIN (nunca se escriben 18 valores literales a
--      mano, para que sea imposible que un copy/paste desalinee el
--      comentario del dato real sembrado) — una categoría sin fila
--      coincidente en la tabla legacy queda como elegible=false/orden=NULL.
--
-- ARQUITECTURA DE VALIDACIÓN — DOS CAPAS, CADA UNA CON UN ROL DISTINTO:
--   - backend/src/services/configuracionDesignacion.js (JS): validación
--     FUNCIONAL COMPLETA para la aplicación/UI — mensajes de error
--     detallados por campo, pensada para guiar al administrador mientras
--     arma una configuración nueva ANTES de guardarla.
--   - activar_configuracion_designacion() (SQL/RPC): defensa ESTRUCTURAL
--     MÍNIMA E INDISPENSABLE en el único punto donde una configuración pasa
--     a tener efecto real (activarse) — protege incluso si, por cualquier
--     motivo, una fila llegó a la tabla sin pasar por la validación de JS
--     (ej. un INSERT manual, un bug futuro en otra capa). NO reimplementa
--     toda la validación de JS con el mismo detalle de mensajes — solo las
--     condiciones que, de fallar, dejarían el motor (Etapa 2) operando con
--     una configuración incompleta o corrupta.
--
-- QUÉ NO HACE (deliberadamente, por instrucción explícita):
--   - NO modifica ni elimina clasificacion_categoria_matriz — sigue siendo
--     la única fuente que usa el motor actual.
--   - NO modifica motorPropuestaDesignacion.js, propuestaDesignacion.js,
--     previewIntegridad.js ni la ruta propuesta-designacion.js.
--   - NO conecta activar_configuracion_designacion() a ningún endpoint.
--   - NO hace backfill de propuestas_designacion.configuracion_version_id
--     en propuestas ya existentes.
--   - NO agrega reglas nuevas: los códigos de criterio están fijos a los 3
--     que el motor ya sabe ejecutar (PRIORIDAD_CATEGORIA,
--     MENOS_DESIGNACIONES_TEMPORADA, MENOR_DISTANCIA).
--   - NO crea ningún trigger — las validaciones de conjunto (cantidad de
--     filas, secuencia sin huecos) viven en la función de activación, que
--     es el único punto donde importan; no se dispara nada en cada INSERT.
--
-- Reversible: las 3 tablas nuevas y la función pueden eliminarse con DROP
-- (nacen sin ningún otro código que las lea todavía); la columna nueva en
-- propuestas_designacion puede eliminarse con DROP COLUMN (queda en NULL en
-- todas las filas existentes).
--
-- Ya aplicada (ver nota al inicio del archivo). Este commit solo versiona el
-- archivo — no vuelve a ejecutarla.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Secuencia y tabla cabecera: configuracion_designacion_versiones
-- ─────────────────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS configuracion_designacion_numero_version_seq;

CREATE TABLE IF NOT EXISTS configuracion_designacion_versiones (
    id                                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    numero_version                          INTEGER     NOT NULL DEFAULT nextval('configuracion_designacion_numero_version_seq'),
    schema_version                          INTEGER     NOT NULL DEFAULT 1,
    activa                                  BOOLEAN     NOT NULL DEFAULT false,

    -- Regla dura DISTANCIA_MAXIMA — independiente del criterio de ranking
    -- MENOR_DISTANCIA (ver configuracion_designacion_orden_criterios).
    regla_distancia_maxima_activa           BOOLEAN     NOT NULL,
    distancia_maxima_km                     NUMERIC,

    -- Reglas booleanas de negocio (todas configurables, ver informe previo).
    regla_no_repetir_asociacion_activa      BOOLEAN     NOT NULL,
    regla_un_rodeo_por_finde_activa         BOOLEAN     NOT NULL,
    regla_finde_consecutivo_activa          BOOLEAN     NOT NULL,
    regla_asociacion_organizadora_activa    BOOLEAN     NOT NULL,

    descripcion                             TEXT,
    creado_por                              UUID        REFERENCES administradores(id),
    created_at                              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_config_designacion_numero_version UNIQUE (numero_version),

    -- schema_version fijo a 1 en esta etapa — evolucionar requiere una
    -- migración explícita que amplíe este CHECK (y el motor que lo lea).
    CONSTRAINT chk_config_designacion_schema_version CHECK (schema_version = 1),

    -- distancia_maxima_km solo es obligatoria/positiva cuando la regla dura
    -- está activa. Si la regla está inactiva, se permite explícitamente
    -- NULL (sección 14 del pedido) — no hay ninguna restricción sobre el
    -- valor mientras la regla no se use. Techo técnico anti-error-de-tipeo
    -- (NO regla de negocio): 5000 km — supera ampliamente cualquier
    -- distancia real dentro de Chile (el largo continental del país, punta
    -- a punta, es del orden de 4300 km en línea recta) dejando margen, pero
    -- sigue atrapando errores evidentes como escribir "6000" en vez de
    -- "600" o un cero de más. Sin mínimo de negocio oculto: un valor
    -- pequeño y legítimo (ej. 5 km) es válido si el administrador lo
    -- configura conscientemente.
    CONSTRAINT chk_config_designacion_distancia CHECK (
        (regla_distancia_maxima_activa = false AND (distancia_maxima_km IS NULL OR distancia_maxima_km > 0))
        OR (regla_distancia_maxima_activa = true AND distancia_maxima_km IS NOT NULL AND distancia_maxima_km > 0 AND distancia_maxima_km <= 5000)
    )
);

-- A lo sumo una versión activa — mismo patrón que idx_temporadas_una_activa.
CREATE UNIQUE INDEX IF NOT EXISTS idx_config_designacion_una_activa
    ON configuracion_designacion_versiones(activa) WHERE activa = true;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Orden global de criterios de ranking (Nivel 1)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS configuracion_designacion_orden_criterios (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id          UUID        NOT NULL REFERENCES configuracion_designacion_versiones(id) ON DELETE CASCADE,
    -- Códigos conocidos para schema_version=1 ÚNICAMENTE. Cualquier regla
    -- nueva futura requiere evolucionar este CHECK + schema_version + motor
    -- explícitamente — nunca aceptar códigos libres.
    criterio_codigo     TEXT        NOT NULL CHECK (criterio_codigo IN (
                            'PRIORIDAD_CATEGORIA', 'MENOS_DESIGNACIONES_TEMPORADA', 'MENOR_DISTANCIA'
                        )),
    orden               INTEGER     NOT NULL CHECK (orden > 0),

    CONSTRAINT uq_orden_criterios_version_codigo UNIQUE (version_id, criterio_codigo),
    CONSTRAINT uq_orden_criterios_version_orden  UNIQUE (version_id, orden)
);

CREATE INDEX IF NOT EXISTS idx_orden_criterios_version ON configuracion_designacion_orden_criterios(version_id);

-- ON DELETE CASCADE nota: razonable porque estas filas son componentes de
-- una versión (no tienen sentido sin ella), PERO no existe ni se planea
-- ningún endpoint administrativo que borre una versión — son históricas e
-- inmutables por diseño (ver sección 15/16 del pedido). El CASCADE protege
-- la integridad si alguna vez se limpia manualmente una versión huérfana en
-- BD, no habilita un flujo de borrado desde la aplicación.

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Matriz de categorías por clasificación, versionada (Nivel 2)
--    SIEMPRE 6 clasificaciones × 3 categorías (A/B/C) = 18 filas por
--    versión — una categoría no habilitada existe como fila explícita con
--    elegible=false / orden_preferencia=NULL, nunca como ausencia de fila.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS configuracion_designacion_matriz (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id              UUID        NOT NULL REFERENCES configuracion_designacion_versiones(id) ON DELETE CASCADE,
    -- Las 6 clasificaciones son taxonomía fija (no una regla) — mismo
    -- alcance que motorPropuestaDesignacion.js/clasificaciones_designacion
    -- hoy. No se agregan clasificaciones nuevas en esta etapa.
    clasificacion_codigo    TEXT        NOT NULL CHECK (clasificacion_codigo IN (
                                'interclubes', 'provincial', 'interasociaciones', 'zonal', 'clasificatorio', 'nacional'
                            )),
    categoria               TEXT        NOT NULL CHECK (categoria IN ('A', 'B', 'C')),
    elegible                BOOLEAN     NOT NULL,
    orden_preferencia       INTEGER,

    CONSTRAINT uq_matriz_version_clasif_categoria UNIQUE (version_id, clasificacion_codigo, categoria),
    -- NULL nunca colisiona consigo mismo en un UNIQUE de Postgres, así que
    -- esta misma constraint ya impide duplicar orden_preferencia entre
    -- categorías elegibles de una misma clasificación/versión, sin bloquear
    -- que varias categorías no-elegibles compartan orden_preferencia=NULL.
    CONSTRAINT uq_matriz_version_clasif_orden UNIQUE (version_id, clasificacion_codigo, orden_preferencia),
    CONSTRAINT chk_matriz_elegible_orden CHECK (
        (elegible = false AND orden_preferencia IS NULL)
        OR (elegible = true AND orden_preferencia IS NOT NULL AND orden_preferencia > 0)
    )
);

CREATE INDEX IF NOT EXISTS idx_matriz_version ON configuracion_designacion_matriz(version_id);
-- (mismo comentario de ON DELETE CASCADE que en la tabla anterior.)

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Vínculo aditivo con propuestas_designacion (sin backfill, sin ON
--    DELETE explícito ⇒ RESTRICT por defecto: nunca se podrá borrar una
--    versión referenciada por una propuesta, aunque de todos modos no se
--    crea ningún endpoint DELETE de versiones)
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE propuestas_designacion
    ADD COLUMN IF NOT EXISTS configuracion_version_id UUID REFERENCES configuracion_designacion_versiones(id);

CREATE INDEX IF NOT EXISTS idx_propdesig_config_version ON propuestas_designacion(configuracion_version_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Activación ATÓMICA de una versión — VALIDA COMPLETO antes de tocar
--    nada. Preparada, NO conectada todavía a ningún endpoint ni UI.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.activar_configuracion_designacion(p_version_id UUID)
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

    -- B. schema_version soportado. Ya lo garantiza chk_config_designacion_
    --    schema_version en la tabla (estructuralmente imposible insertar
    --    otro valor hoy) — se revalida acá explícitamente como defensa en
    --    profundidad, tal como fue pedido.
    IF v_schema_version <> 1 THEN
        RAISE EXCEPTION 'Versión % tiene schema_version % no soportado (se requiere 1) — no se activa, la configuración actual permanece igual.', p_version_id, v_schema_version;
    END IF;

    -- C/D/E/F/G. Orden de criterios: entre 1 y 3 filas. Los códigos
    --    conocidos y la ausencia de duplicados de código/orden YA están
    --    garantizados fila por fila por el CHECK+UNIQUE de la tabla en cada
    --    INSERT — lo que solo puede verificarse en conjunto (y por eso se
    --    revalida acá) es la CANTIDAD mínima/máxima y que la secuencia sea
    --    1..N sin huecos. Dado que `orden` ya es positivo y sin duplicados
    --    por diseño de tabla, "MAX(orden) = COUNT(*)" es equivalente a
    --    "exactamente los valores 1..N sin huecos".
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

    -- H/I. Matriz completa: exactamente 18 filas (6 clasificaciones × 3
    --      categorías) — nunca aceptar una matriz donde una categoría
    --      simplemente "no exista" como fila.
    SELECT count(*), count(DISTINCT clasificacion_codigo) INTO v_count_matriz, v_count_clasif
    FROM public.configuracion_designacion_matriz
    WHERE version_id = p_version_id;

    IF v_count_matriz <> 18 OR v_count_clasif <> 6 THEN
        RAISE EXCEPTION 'Versión %: la matriz debe tener exactamente 18 filas (6 clasificaciones × 3 categorías); tiene % filas en % clasificaciones — no se activa.', p_version_id, v_count_matriz, v_count_clasif;
    END IF;

    -- J/K/L/M. Por cada clasificación: mínimo 1 elegible, y las elegibles
    --    con orden_preferencia secuencial 1..N sin huecos. "Ninguna
    --    categoría no elegible con orden" (L) ya está garantizado fila por
    --    fila por chk_matriz_elegible_orden.
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
    --    chk_config_designacion_distancia en la tabla — ninguna fila
    --    persistida puede violarla, no requiere revalidación aquí.

    -- Todo validado: recién ahora se cambia el estado. Ambos UPDATE quedan
    -- dentro de la misma transacción implícita de esta función — si algo
    -- fallara entre medio (no debería, ya está todo validado), PL/pgSQL
    -- revierte la función completa y la configuración activa anterior
    -- queda intacta.
    UPDATE public.configuracion_designacion_versiones
        SET activa = false
        WHERE activa = true AND id <> p_version_id;

    UPDATE public.configuracion_designacion_versiones
        SET activa = true
        WHERE id = p_version_id;
END;
$$;

-- Permisos: nadie puede invocarla vía API pública (PostgREST/anon/
-- authenticated). Se otorga EXECUTE explícitamente solo a service_role —
-- el rol que usa el backend administrativo — sin asumir privilegios
-- implícitos. Se conectará a un endpoint protegido por soloRolEvaluacion()
-- recién en una etapa futura; hoy queda preparada pero inalcanzable desde
-- fuera del backend.
REVOKE ALL ON FUNCTION public.activar_configuracion_designacion(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.activar_configuracion_designacion(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.activar_configuracion_designacion(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.activar_configuracion_designacion(UUID) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. RLS — administrativas, sin políticas públicas
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE configuracion_designacion_versiones      ENABLE ROW LEVEL SECURITY;
ALTER TABLE configuracion_designacion_orden_criterios ENABLE ROW LEVEL SECURITY;
ALTER TABLE configuracion_designacion_matriz          ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. Seed DEFENSIVO de la Versión 1 — equivalente exacto al motor actual
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    clasif_actuales         INTEGER;
    filas_matriz_esperadas  INTEGER;
    filas_matriz_elegibles  INTEGER;
    v_version_id            UUID;
BEGIN
    -- 7.1 Deben existir exactamente las 6 clasificaciones conocidas.
    SELECT count(*) INTO clasif_actuales
    FROM clasificaciones_designacion
    WHERE codigo IN ('interclubes', 'provincial', 'interasociaciones', 'zonal', 'clasificatorio', 'nacional');

    IF clasif_actuales <> 6 THEN
        RAISE EXCEPTION 'Migración 050 abortada: se esperaban las 6 clasificaciones conocidas y se encontraron %. No se sembró la Versión 1 — revise manualmente antes de reintentar.', clasif_actuales;
    END IF;

    -- 7.2 clasificacion_categoria_matriz debe tener EXACTAMENTE estas 11
    --     filas elegible=true (verificadas en vivo antes de escribir esta
    --     migración) — ni una menos, ni una de más, ni con otra prioridad.
    SELECT count(*) INTO filas_matriz_esperadas
    FROM clasificacion_categoria_matriz m
    JOIN clasificaciones_designacion cd ON cd.id = m.clasificacion_id
    WHERE m.elegible = true AND (
        (cd.codigo = 'interclubes'       AND m.categoria = 'B' AND m.prioridad = 2) OR
        (cd.codigo = 'interclubes'       AND m.categoria = 'C' AND m.prioridad = 1) OR
        (cd.codigo = 'provincial'        AND m.categoria = 'A' AND m.prioridad = 2) OR
        (cd.codigo = 'provincial'        AND m.categoria = 'B' AND m.prioridad = 1) OR
        (cd.codigo = 'interasociaciones' AND m.categoria = 'A' AND m.prioridad = 1) OR
        (cd.codigo = 'interasociaciones' AND m.categoria = 'B' AND m.prioridad = 2) OR
        (cd.codigo = 'zonal'             AND m.categoria = 'A' AND m.prioridad = 1) OR
        (cd.codigo = 'zonal'             AND m.categoria = 'B' AND m.prioridad = 2) OR
        (cd.codigo = 'clasificatorio'    AND m.categoria = 'A' AND m.prioridad = 1) OR
        (cd.codigo = 'clasificatorio'    AND m.categoria = 'B' AND m.prioridad = 2) OR
        (cd.codigo = 'nacional'          AND m.categoria = 'A' AND m.prioridad = 1)
    );

    SELECT count(*) INTO filas_matriz_elegibles
    FROM clasificacion_categoria_matriz WHERE elegible = true;

    IF filas_matriz_esperadas <> 11 OR filas_matriz_elegibles <> 11 THEN
        RAISE EXCEPTION 'Migración 050 abortada: clasificacion_categoria_matriz no coincide con el estado esperado (11 filas elegible=true con las prioridades documentadas). Coincidencias exactas=%, total elegible=true=%. No se sembró la Versión 1 — revise manualmente antes de reintentar. No se inventa ninguna matriz.', filas_matriz_esperadas, filas_matriz_elegibles;
    END IF;

    -- 7.3 Crear Versión 1 (cabecera) — equivalente exacto al motor actual.
    INSERT INTO configuracion_designacion_versiones (
        schema_version, activa,
        regla_distancia_maxima_activa, distancia_maxima_km,
        regla_no_repetir_asociacion_activa, regla_un_rodeo_por_finde_activa,
        regla_finde_consecutivo_activa, regla_asociacion_organizadora_activa,
        descripcion
    ) VALUES (
        1, true,
        true, 600,
        true, true,
        true, true,
        'Versión 1 — equivalente exacto al comportamiento del motor antes de esta funcionalidad (Etapa 1 de Configuración de Propuesta de Designación).'
    ) RETURNING id INTO v_version_id;

    -- 7.4 Orden de criterios — el orden actual real del motor.
    INSERT INTO configuracion_designacion_orden_criterios (version_id, criterio_codigo, orden) VALUES
        (v_version_id, 'PRIORIDAD_CATEGORIA', 1),
        (v_version_id, 'MENOS_DESIGNACIONES_TEMPORADA', 2),
        (v_version_id, 'MENOR_DISTANCIA', 3);

    -- 7.5 Matriz — 18 filas (6 clasificaciones × 3 categorías), DERIVADAS
    --     de clasificacion_categoria_matriz ya verificada arriba (nunca
    --     escritas a mano): para cada combinación (clasificación,
    --     categoría), elegible=true + orden_preferencia=prioridad si existe
    --     una fila coincidente elegible=true en la tabla legacy; si no
    --     existe, elegible=false + orden_preferencia=NULL.
    INSERT INTO configuracion_designacion_matriz (version_id, clasificacion_codigo, categoria, elegible, orden_preferencia)
    SELECT
        v_version_id,
        cd.codigo,
        cat.categoria,
        (m.categoria IS NOT NULL) AS elegible,
        m.prioridad AS orden_preferencia
    FROM clasificaciones_designacion cd
    CROSS JOIN (VALUES ('A'), ('B'), ('C')) AS cat(categoria)
    LEFT JOIN clasificacion_categoria_matriz m
        ON m.clasificacion_id = cd.id AND m.categoria = cat.categoria AND m.elegible = true
    WHERE cd.codigo IN ('interclubes', 'provincial', 'interasociaciones', 'zonal', 'clasificatorio', 'nacional');
END $$;

COMMIT;

-- ── Verificación sugerida post-aplicación (no destructiva) ─────────────────
-- SELECT numero_version, schema_version, activa, distancia_maxima_km
--   FROM configuracion_designacion_versiones;  -- 1 fila, numero_version=1, activa=true
--
-- SELECT criterio_codigo, orden FROM configuracion_designacion_orden_criterios
--   ORDER BY orden;  -- PRIORIDAD_CATEGORIA(1), MENOS_DESIGNACIONES_TEMPORADA(2), MENOR_DISTANCIA(3)
--
-- SELECT count(*) FROM configuracion_designacion_matriz;  -- 18
-- SELECT count(*) FROM configuracion_designacion_matriz WHERE elegible = true;   -- 11
-- SELECT count(*) FROM configuracion_designacion_matriz WHERE elegible = false;  -- 7
--
-- SELECT clasificacion_codigo, categoria, elegible, orden_preferencia
--   FROM configuracion_designacion_matriz ORDER BY clasificacion_codigo, categoria;
--   -- Provincial: A(true,2) B(true,1) C(false,NULL) — no se habilitó C todavía.
--   -- Nacional: A(true,1) B(false,NULL) C(false,NULL).
--
-- SELECT count(*) FROM propuestas_designacion WHERE configuracion_version_id IS NOT NULL;
--   -- debe ser 0 inmediatamente después de aplicar (sin backfill).
--
-- SELECT relrowsecurity FROM pg_class WHERE relname IN
--   ('configuracion_designacion_versiones','configuracion_designacion_orden_criterios','configuracion_designacion_matriz');
--   -- las 3 deben ser true.
--
-- SELECT grantee, privilege_type FROM information_schema.routine_privileges
--   WHERE routine_name = 'activar_configuracion_designacion';
--   -- debe incluir service_role con EXECUTE, y NO incluir PUBLIC/anon/authenticated.
--
-- SELECT proconfig FROM pg_proc WHERE proname = 'activar_configuracion_designacion';
--   -- debe incluir 'search_path=public,pg_temp'.
