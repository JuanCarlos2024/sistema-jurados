-- ═════════════════════════════════════════════════════════════════════════
-- 093_prioridad_deportiva_designacion.sql
-- Configuración de Propuesta de Designación — nuevo schema_version=4:
-- "PRIORIDAD DEPORTIVA + NOTA TÉCNICA + REPETICIÓN DE ASOCIACIÓN POR
-- INTERVALO" (pedido "Motor Global con Prioridad de Rodeos, Categorías y
-- Calidad Técnica", Etapa C, sección 2 — "Prepara la migración necesaria
-- para persistir la configuración v4 y permitir gestionarla desde la
-- interfaz administrativa").
--
-- ⚠️ NO APLICADA EN PRODUCCIÓN TODAVÍA. Preparada junto con el código de
--    backend/frontend correspondiente (configuracionDesignacion.js,
--    configuracionDesignacionRepositorio.js, motorPropuestaDesignacion*.js,
--    frontend/admin/configuracion-designacion.html), que YA soporta leer y
--    construir schema_version=4 en memoria — pero NO puede persistirlo en
--    Supabase hasta que esta migración se aplique (igual disciplina que
--    052→Equidad de Traslados y 053→Zonas Extremas: código preparado antes,
--    migración después, activación real recién al final).
--    NO EJECUTAR EN PRODUCCIÓN sin autorización explícita.
--
-- QUÉ ES schema_version=4 (ver informe de diseño "Motor Global...", Etapa
-- B/C): tres piezas NUEVAS, independientes entre sí y de todo lo anterior:
--   1. PRIORIDAD DEPORTIVA — orden configurable de las 6 clasificaciones de
--      rodeo (zonal/interasociaciones/provincial/interclubes/clasificatorio/
--      nacional) que el objetivo secundario del motor global usa para
--      decidir qué clasificación "reserva" primero a los mejores jurados
--      disponibles, SIN sacrificar nunca la cobertura máxima ya probada.
--   2. NOTA_TECNICA — nuevo criterio de RANKING (como MENOR_DISTANCIA o
--      PRIORIDAD_CATEGORIA desde siempre): sin regla booleana propia, su
--      presencia/ausencia en el orden de criterios ES la activación. Decide
--      ENTRE candidatos de la misma categoría para el MISMO rodeo según la
--      nota técnica oficial (evaluación de desempeño ya existente,
--      migración 081) — nunca compite con la prioridad deportiva entre
--      rodeos distintos.
--   3. REPETICIÓN DE ASOCIACIÓN POR INTERVALO — intervalo mínimo (meses,
--      configurable, default 6) entre designaciones de la MISMA asociación
--      para un jurado, mirando el HISTORIAL REAL completo (no solo la
--      temporada vigente) — totalmente independiente de regla_no_repetir_
--      asociacion_activa (esa sigue siendo exclusivamente "temporada
--      vigente", sin cambios) y de regla_asociacion_organizadora_activa
--      (prohibición de auto-juzgarse, conflicto de interés real, siempre
--      obligatoria, nunca se relaja — tampoco cambia). A diferencia de las
--      demás piezas de schema_version=4, el motor NUNCA la relaja
--      automáticamente para ganar cobertura (ver motorPropuestaDesignacion
--      Global.js, CAUSAS_OBLIGATORIAS) — si bloquea un rodeo, queda
--      SIN_PROPUESTA con el motivo explícito, nunca se fuerza.
--
-- POR QUÉ schema_version=4 (no reutilizar 1/2/3) — mismo análisis que 053:
--   - Agrega un CONTRATO ESTRUCTURAL nuevo (tabla hija de prioridad de
--     clasificaciones + 2 columnas de regla nuevas) — no es solo un
--     parámetro nuevo de un criterio ya existente.
--   - schema_version=4 SIGUE ADMITIENDO TODO schema_version=3 (Zonas
--     Extremas incluida, que a su vez admite TODO schema_version=2 —
--     EQUIDAD_TRASLADOS) — las 3 piezas de esta migración son ORTOGONALES
--     a Equidad de Traslados y a Zonas Extremas; todas pueden convivir
--     activas en la misma versión.
--   - numero_version (visible en UI) y schema_version (técnico) NO son lo
--     mismo — la próxima versión real puede mostrarse como "v3" o "v4" en
--     la UI mientras internamente es schema_version=4.
--
-- ESTRATEGIA: EXPAND, igual que 051→052→053. NINGUNA firma/función/tabla
-- existente se modifica de forma incompatible:
--   - crear_configuracion_designacion_version(...)    (schema 1, 10 params) — INTACTA.
--   - crear_configuracion_designacion_version_v2(...) (schema 2, 12 params) — INTACTA.
--   - crear_configuracion_designacion_version_v3(...) (schema 3, 15 params) — INTACTA.
--   - Se agrega crear_configuracion_designacion_version_v4(...) (schema 4,
--     19 params = los 15 de v3 + 4 nuevos de Prioridad Deportiva/Repetición
--     por Intervalo), EXCLUSIVA para crear versiones schema_version=4.
--   - activar_configuracion_designacion(UUID) mantiene su firma UUID exacta
--     — ahora también valida versiones schema_version=4, delegando en el
--     helper estructural actualizado (mismo patrón que 052/053).
--   - _validar_estructura_configuracion_designacion(UUID) — CREATE OR
--     REPLACE, bifurca una vez más: schema 1/2/3 quedan EXACTAMENTE como los
--     dejó 053 (comportamiento histórico intacto, no reinterpretado);
--     schema 4 admite hasta 5 criterios de ranking (los 4 de schema 2/3 +
--     NOTA_TECNICA) y agrega las condiciones nuevas de Prioridad Deportiva/
--     Repetición por Intervalo.
--
-- Aplicar esta migración, POR SÍ SOLA, es funcionalmente transparente para
-- producción: 0 filas modificadas (los DEFAULT dejan toda fila existente en
-- regla_prioridad_deportiva_activa=false / regla_repeticion_asociacion_
-- intervalo_activa=false / repeticion_asociacion_meses=NULL, sin ningún
-- UPDATE), 0 comportamiento distinto para nada de lo que ya existe (V1,
-- cualquier versión schema_version=2 y cualquier versión schema_version=3
-- ya creada siguen funcionando idénticas). El backend actualmente
-- desplegado puede seguir corriendo sin ningún cambio de código después de
-- aplicarla — el código que la USA se despliega en un momento posterior,
-- después de aplicar esta migración (mismo orden que 052/053: 1) migración,
-- 2) código).
--
-- QUÉ HACE (todo aditivo; 0 DROP de datos ni de funciones existentes):
--   1. configuracion_designacion_versiones — agrega 3 columnas nuevas:
--        regla_prioridad_deportiva_activa             BOOLEAN NOT NULL DEFAULT false
--        regla_repeticion_asociacion_intervalo_activa BOOLEAN NOT NULL DEFAULT false
--        repeticion_asociacion_meses                  INTEGER (NULL por defecto)
--   2. chk_config_designacion_schema_version — CHECK (schema_version IN (1,2,3,4)).
--   3. chk_config_designacion_equidad_requiere_schema_2_3_o_4 — reemplaza a
--      chk_config_designacion_equidad_requiere_schema_2_o_3 (054): EQUIDAD_
--      TRASLADOS ahora también admite schema_version=4 (heredada).
--   4. chk_config_designacion_zonas_extremas_requiere_schema_3_o_4 —
--      reemplaza a chk_config_designacion_zonas_extremas_requiere_schema3
--      (053): Zonas Extremas ahora también admite schema_version=4 (heredada
--      — MISMA corrección ya aplicada en configuracionDesignacion.js,
--      Etapa C: "esquema < 3", nunca "distinto de 3").
--   5. chk_config_designacion_prioridad_requiere_schema4 — regla_prioridad_
--      deportiva_activa=true EXIGE schema_version=4, estructuralmente.
--   6. chk_config_designacion_intervalo_requiere_schema4 — regla_repeticion_
--      asociacion_intervalo_activa=true EXIGE schema_version=4.
--   7. chk_config_designacion_intervalo_meses — repeticion_asociacion_meses
--      obligatorio (NOT NULL, 1..60) SOLO mientras la regla esté activa.
--   8. configuracion_designacion_prioridad_clasificaciones — tabla NUEVA:
--      orden de prioridad deportiva entre las 6 clasificaciones, por
--      versión — mismo modelo que configuracion_designacion_matriz (todas
--      las filas conocidas, orden secuencial sin huecos), pero sin columna
--      de categoría: una permutación completa de las 6 clasificaciones, no
--      una por categoría.
--   8b. Corrección de seguridad (hallazgo ya documentado en 085/087): se
--      revoca ALL de PUBLIC/anon/authenticated/service_role sobre la tabla
--      nueva (el default de esquema otorgaría acceso amplio automático) y
--      se otorga explícitamente solo SELECT a service_role — el único
--      acceso directo real (configuracionDesignacionRepositorio.js). El
--      INSERT ocurre exclusivamente dentro de la RPC SECURITY DEFINER
--      (punto 12), que no necesita ningún GRANT de tabla para escribir.
--   9. criterio_codigo — agregar 'NOTA_TECNICA' al CHECK existente (nombre
--      del constraint localizado dinámicamente, mismo mecanismo que 052).
--  10. _validar_estructura_configuracion_designacion(p_version_id) — CREATE
--      OR REPLACE, bifurca una vez más (ver arriba).
--  11. activar_configuracion_designacion(UUID) — CREATE OR REPLACE,
--      comportamiento externo idéntico, delega en el punto 10.
--  12. crear_configuracion_designacion_version_v4(...) — RPC NUEVA.
--  13. RLS en la tabla nueva (sin políticas — segunda capa, ver 8b).
--  14. NOTIFY pgrst, 'reload schema' — mismo patrón ya establecido en la
--      migración 088, necesario porque esta migración agrega una función Y
--      una tabla nuevas que PostgREST debe poder resolver de inmediato.
--
-- QUÉ NO HACE (deliberadamente):
--   - NO toca ni elimina las RPC/tablas de 050/051/052/053 — todo intacto.
--   - NO modifica ninguna fila existente — las columnas nuevas solo agregan
--     su DEFAULT (false/NULL).
--   - NO crea ninguna versión nueva (schema_version=4 real) — la creará el
--     administrador desde la interfaz DESPUÉS de aplicar esta migración y
--     el código correspondiente (ya preparado, NO desplegado en este mismo
--     commit).
--   - NO activa nada.
--   - NO toca rodeos, asignaciones, evaluaciones, notas_rodeo ni temporadas
--     — exclusivamente configuración.
--   - NO hardcodea el orden de prioridad deportiva en ningún lugar del
--     backend/motor — esta migración NO siembra ninguna fila en la tabla
--     nueva; el orden "zonal > interasociaciones > provincial > interclubes
--     > clasificatorio/nacional" documentado en el pedido vive EXCLUSIVAMENTE
--     como `prioridad_clasificaciones_default` en obtenerCapacidadesSoportadas()
--     (configuracionDesignacion.js, JS puro) — el PAYLOAD que el frontend
--     ofrece al activar la regla por primera vez, nunca un seed automático
--     de esta migración.
--
-- COMPATIBILIDAD DE CÓDIGO: igual disciplina que 052/053 — el código que lee
-- estas columnas/tablas (ya preparado, NO desplegado todavía) falla con un
-- error claro de Postgres si se despliega ANTES de aplicar esta migración
-- (columna/tabla/función inexistente), nunca un fallback silencioso. Orden
-- correcto: 1) aplicar 093, 2) desplegar código.
--
-- Reversible: DROP de las 3 columnas nuevas (con CASCADE de sus CHECK); DROP
-- de la tabla nueva; revertir el CHECK de criterio_codigo (quitar
-- 'NOTA_TECNICA'); revertir chk_config_designacion_schema_version a
-- "IN (1,2,3)"; revertir chk_config_designacion_equidad_requiere_schema_2_
-- 3_o_4 a "...schema_2_o_3" (IN (2,3)); revertir chk_config_designacion_
-- zonas_extremas_requiere_schema_3_o_4 a "...requiere_schema3" (= 3); DROP
-- de crear_configuracion_designacion_version_v4; CREATE OR REPLACE de
-- _validar_estructura_configuracion_designacion/activar_configuracion_
-- designacion con el cuerpo de la migración 053. Las RPC legacy (v1/v2/v3)
-- nunca se tocan, no requieren reversión. Después de cualquier reversión,
-- repetir NOTIFY pgrst, 'reload schema' para que PostgREST deje de ofrecer
-- la función/tabla eliminadas.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Columnas nuevas — aditivas, DEFAULT deja intacta toda fila existente.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE configuracion_designacion_versiones
    ADD COLUMN IF NOT EXISTS regla_prioridad_deportiva_activa BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE configuracion_designacion_versiones
    ADD COLUMN IF NOT EXISTS regla_repeticion_asociacion_intervalo_activa BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE configuracion_designacion_versiones
    ADD COLUMN IF NOT EXISTS repeticion_asociacion_meses INTEGER;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. schema_version soportado: 1, 2, 3 o 4 (antes: 1, 2 o 3).
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE configuracion_designacion_versiones
    DROP CONSTRAINT IF EXISTS chk_config_designacion_schema_version;
ALTER TABLE configuracion_designacion_versiones
    ADD CONSTRAINT chk_config_designacion_schema_version CHECK (schema_version IN (1, 2, 3, 4));

-- ─────────────────────────────────────────────────────────────────────────
-- 3. EQUIDAD_TRASLADOS ahora también admite schema_version=4 (heredada —
--    mismo patrón de la migración 054, que ya extendió esto de "solo 2" a
--    "2 o 3"). Se reemplaza el CHECK anterior por uno con nombre claro.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE configuracion_designacion_versiones
    DROP CONSTRAINT IF EXISTS chk_config_designacion_equidad_requiere_schema_2_o_3;
ALTER TABLE configuracion_designacion_versiones
    ADD CONSTRAINT chk_config_designacion_equidad_requiere_schema_2_3_o_4 CHECK (
        regla_equidad_traslados_activa = false OR schema_version IN (2, 3, 4)
    );

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Zonas Extremas ahora también admite schema_version=4 (heredada — MISMA
--    corrección ya aplicada en configuracionDesignacion.js/Etapa C: "antes
--    de que existiera la regla" (schema < 3), nunca "distinto de 3").
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE configuracion_designacion_versiones
    DROP CONSTRAINT IF EXISTS chk_config_designacion_zonas_extremas_requiere_schema3;
ALTER TABLE configuracion_designacion_versiones
    ADD CONSTRAINT chk_config_designacion_zonas_extremas_requiere_schema_3_o_4 CHECK (
        regla_zonas_extremas_activa = false OR schema_version IN (3, 4)
    );

-- ─────────────────────────────────────────────────────────────────────────
-- 5/6. Prioridad Deportiva / Repetición por Intervalo — EXIGEN
--    schema_version=4, estructuralmente (piezas NUEVAS en esta migración,
--    sin equivalente histórico que heredar).
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE configuracion_designacion_versiones
    ADD CONSTRAINT chk_config_designacion_prioridad_requiere_schema4 CHECK (
        regla_prioridad_deportiva_activa = false OR schema_version = 4
    );
ALTER TABLE configuracion_designacion_versiones
    ADD CONSTRAINT chk_config_designacion_intervalo_requiere_schema4 CHECK (
        regla_repeticion_asociacion_intervalo_activa = false OR schema_version = 4
    );

-- ─────────────────────────────────────────────────────────────────────────
-- 7. repeticion_asociacion_meses — obligatorio y en rango (1..60, mismo
--    tope técnico que REPETICION_ASOCIACION_MESES_TECNICO_MAX en el backend)
--    SOLO mientras la regla esté activa. Con la regla OFF, NULL o cualquier
--    valor previamente guardado se conserva sin exigir nada (mismo patrón
--    "recordar" que distancia_maxima_km/umbral_lejania_km).
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE configuracion_designacion_versiones
    ADD CONSTRAINT chk_config_designacion_intervalo_meses CHECK (
        regla_repeticion_asociacion_intervalo_activa = false
        OR (repeticion_asociacion_meses IS NOT NULL AND repeticion_asociacion_meses > 0 AND repeticion_asociacion_meses <= 60)
    );

-- ─────────────────────────────────────────────────────────────────────────
-- 8. Orden de prioridad deportiva entre clasificaciones, por versión — MISMO
--    modelo que configuracion_designacion_matriz (todas las filas conocidas
--    siempre explícitas), sin columna de categoría: UNA permutación
--    completa de las 6 clasificaciones (orden=1 = MÁXIMA prioridad
--    deportiva), no una matriz por categoría.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS configuracion_designacion_prioridad_clasificaciones (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id          UUID        NOT NULL REFERENCES configuracion_designacion_versiones(id) ON DELETE CASCADE,
    clasificacion_codigo TEXT       NOT NULL CHECK (clasificacion_codigo IN (
        'interclubes', 'provincial', 'interasociaciones', 'zonal', 'clasificatorio', 'nacional'
    )),
    orden               INTEGER     NOT NULL CHECK (orden > 0),

    CONSTRAINT uq_prioridad_clasif_version_codigo UNIQUE (version_id, clasificacion_codigo),
    CONSTRAINT uq_prioridad_clasif_version_orden  UNIQUE (version_id, orden)
);

CREATE INDEX IF NOT EXISTS idx_prioridad_clasificaciones_version ON configuracion_designacion_prioridad_clasificaciones(version_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 8b. Corrección de seguridad (mismo hallazgo ya documentado en 085/087):
--     el proyecto tiene ALTER DEFAULT PRIVILEGES a nivel de esquema que
--     otorga privilegios de tabla completos a anon/authenticated/
--     service_role en todo objeto NUEVO de forma automática — sin este
--     bloque, la tabla nueva heredaría ese default amplio. Se revoca TODO
--     primero (de las tres, más PUBLIC) antes de otorgar explícitamente
--     solo lo mínimo que el backend necesita: SELECT, para la lectura
--     directa vía supabase-js en configuracionDesignacionRepositorio.js
--     (cargarComponentesYValidar). El INSERT real ocurre exclusivamente
--     dentro de crear_configuracion_designacion_version_v4 (SECURITY
--     DEFINER, más abajo) — esa función corre con los privilegios de su
--     PROPIETARIO (quien aplica esta migración), nunca con los de quien la
--     invoca, así que service_role no necesita INSERT/UPDATE/DELETE
--     directo sobre esta tabla. RLS (punto 13 más abajo) es la segunda
--     capa: sin políticas, ningún rol de cliente final (anon/authenticated)
--     podría ver ninguna fila aunque alguna vez tuviera un GRANT de tabla.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON TABLE configuracion_designacion_prioridad_clasificaciones FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE configuracion_designacion_prioridad_clasificaciones TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 9. criterio_codigo — agregar 'NOTA_TECNICA'. Nombre del constraint
--    localizado dinámicamente (no se asume el autogenerado por Postgres) —
--    mismo mecanismo exacto que la migración 052.
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
        RAISE EXCEPTION 'Migración 093 abortada: no se encontró el CHECK de criterio_codigo en configuracion_designacion_orden_criterios — revise manualmente antes de reintentar. No se modificó nada.';
    END IF;

    EXECUTE format('ALTER TABLE configuracion_designacion_orden_criterios DROP CONSTRAINT %I', v_constraint_name);
END $$;

ALTER TABLE configuracion_designacion_orden_criterios
    ADD CONSTRAINT chk_orden_criterios_codigo CHECK (criterio_codigo IN (
        'PRIORIDAD_CATEGORIA', 'MENOS_DESIGNACIONES_TEMPORADA', 'MENOR_DISTANCIA', 'EQUIDAD_TRASLADOS', 'NOTA_TECNICA'
    ));

-- ─────────────────────────────────────────────────────────────────────────
-- 10. Validación estructural compartida — CREATE OR REPLACE. Bifurca una
--     vez más: schema 1/2/3 quedan EXACTAMENTE como los dejó 053 (nunca
--     reinterpretados); schema 4 admite hasta 5 criterios (los 4 de schema
--     2/3 + NOTA_TECNICA, sin regla booleana propia) y agrega las
--     condiciones nuevas de Prioridad Deportiva/Repetición por Intervalo.
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
    v_regla_prioridad_activa BOOLEAN;
    v_regla_intervalo_activa BOOLEAN;
    v_max_criterios          INTEGER;
    v_count_criterios        INTEGER;
    v_max_orden_crit         INTEGER;
    v_count_matriz           INTEGER;
    v_count_clasif           INTEGER;
    v_clasif                 TEXT;
    v_count_elegibles        INTEGER;
    v_max_orden_eleg         INTEGER;
    v_orden_equidad          INTEGER;
    v_orden_nota_tecnica     INTEGER;
    v_count_zonas_asoc       INTEGER;
    v_count_zonas_cat        INTEGER;
    v_count_zonas_cat_eleg   INTEGER;
    v_max_orden_zonas_cat    INTEGER;
    v_count_prioridad        INTEGER;
    v_max_orden_prioridad    INTEGER;
BEGIN
    -- A. La versión debe existir.
    SELECT schema_version, regla_equidad_traslados_activa, regla_zonas_extremas_activa,
           regla_prioridad_deportiva_activa, regla_repeticion_asociacion_intervalo_activa
    INTO v_schema_version, v_regla_equidad_activa, v_regla_zonas_activa,
         v_regla_prioridad_activa, v_regla_intervalo_activa
    FROM public.configuracion_designacion_versiones
    WHERE id = p_version_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Versión de configuración de designación no encontrada: % — no se activa ninguna versión, la actual permanece igual.', p_version_id;
    END IF;

    -- B. schema_version soportado: 1 (histórico), 2 (equidad de traslados),
    --    3 (zonas extremas) o 4 (prioridad deportiva/nota técnica/
    --    repetición por intervalo — incluye todo lo de 2 y 3).
    IF v_schema_version NOT IN (1, 2, 3, 4) THEN
        RAISE EXCEPTION 'Versión % tiene schema_version % no soportado (se requiere 1, 2, 3 o 4) — no se activa, la configuración actual permanece igual.', p_version_id, v_schema_version;
    END IF;

    IF v_schema_version = 1 AND v_regla_equidad_activa THEN
        RAISE EXCEPTION 'Versión %: schema_version=1 no puede tener regla_equidad_traslados_activa=true — no se activa.', p_version_id;
    END IF;

    IF v_schema_version IN (1, 2) AND v_regla_zonas_activa THEN
        RAISE EXCEPTION 'Versión %: schema_version=% no puede tener regla_zonas_extremas_activa=true (requiere schema_version 3 o 4) — no se activa.', p_version_id, v_schema_version;
    END IF;

    -- NUEVO — schema_version 1/2/3 NUNCA deben tener Prioridad Deportiva ni
    -- Repetición por Intervalo activas (ya lo garantizan los CHECK
    -- chk_config_designacion_prioridad_requiere_schema4/chk_config_
    -- designacion_intervalo_requiere_schema4 estructuralmente; se revalida
    -- acá como defensa en profundidad).
    IF v_schema_version <> 4 AND v_regla_prioridad_activa THEN
        RAISE EXCEPTION 'Versión %: schema_version=% no puede tener regla_prioridad_deportiva_activa=true (requiere schema_version=4) — no se activa.', p_version_id, v_schema_version;
    END IF;
    IF v_schema_version <> 4 AND v_regla_intervalo_activa THEN
        RAISE EXCEPTION 'Versión %: schema_version=% no puede tener regla_repeticion_asociacion_intervalo_activa=true (requiere schema_version=4) — no se activa.', p_version_id, v_schema_version;
    END IF;

    -- C/D/E/F/G. Orden de criterios: 1..N sin huecos. El máximo de criterios
    -- conocidos depende del schema (3 para schema 1; 4 para schema 2/3,
    -- EQUIDAD_TRASLADOS; 5 para schema 4, que suma NOTA_TECNICA).
    v_max_criterios := CASE WHEN v_schema_version = 4 THEN 5 WHEN v_schema_version IN (2, 3) THEN 4 ELSE 3 END;

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

    -- EQUIDAD_TRASLADOS — ahora válido desde schema 2, 3 o 4 (heredada).
    SELECT orden INTO v_orden_equidad
    FROM public.configuracion_designacion_orden_criterios
    WHERE version_id = p_version_id AND criterio_codigo = 'EQUIDAD_TRASLADOS';

    IF v_orden_equidad IS NOT NULL THEN
        IF v_schema_version NOT IN (2, 3, 4) THEN
            RAISE EXCEPTION 'Versión %: EQUIDAD_TRASLADOS en el orden de criterios requiere schema_version 2, 3 o 4 (tiene %) — no se activa.', p_version_id, v_schema_version;
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

    -- NUEVO — NOTA_TECNICA: sin regla booleana propia (su presencia en el
    -- orden ES la activación, igual que MENOR_DISTANCIA/PRIORIDAD_CATEGORIA
    -- desde schema 1) — SOLO válido desde schema_version=4, y SIN posición
    -- fija (a diferencia de EQUIDAD_TRASLADOS, es libremente reordenable).
    SELECT orden INTO v_orden_nota_tecnica
    FROM public.configuracion_designacion_orden_criterios
    WHERE version_id = p_version_id AND criterio_codigo = 'NOTA_TECNICA';

    IF v_orden_nota_tecnica IS NOT NULL AND v_schema_version <> 4 THEN
        RAISE EXCEPTION 'Versión %: NOTA_TECNICA en el orden de criterios requiere schema_version=4 (tiene %) — no se activa.', p_version_id, v_schema_version;
    END IF;

    -- H/I. Matriz completa: exactamente 18 filas (6 clasificaciones × 3
    -- categorías) — MISMA condición para los 4 schemas, sin cambios.
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

    -- Zonas Extremas — MISMA validación de 053 (estructural SIEMPRE desde
    -- schema>=3; mínimos solo si la regla está activa), ahora también para
    -- schema_version=4 (heredada).
    IF v_schema_version IN (3, 4) THEN
        SELECT count(*) INTO v_count_zonas_asoc
        FROM public.configuracion_designacion_zonas_extremas
        WHERE version_id = p_version_id;

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

        IF v_count_zonas_cat NOT IN (0, 3) THEN
            RAISE EXCEPTION 'Versión %: si existen categorías de Zonas Extremas, deben ser exactamente 3 (A, B, C); tiene % — no se activa.', p_version_id, v_count_zonas_cat;
        END IF;

        IF v_count_zonas_cat = 3 THEN
            SELECT count(*), max(orden_preferencia) INTO v_count_zonas_cat_eleg, v_max_orden_zonas_cat
            FROM public.configuracion_designacion_zona_extrema_categorias
            WHERE version_id = p_version_id AND elegible = true;

            IF v_count_zonas_cat_eleg IS NULL OR v_count_zonas_cat_eleg < 1 THEN
                RAISE EXCEPTION 'Versión %: la matriz de categorías de Zonas Extremas no tiene ninguna categoría elegible — no se activa.', p_version_id;
            END IF;
            IF v_max_orden_zonas_cat IS DISTINCT FROM v_count_zonas_cat_eleg THEN
                RAISE EXCEPTION 'Versión %: el orden de preferencia de categorías de Zonas Extremas no es secuencial sin huecos (máximo=%, elegibles=%) — no se activa.', p_version_id, v_max_orden_zonas_cat, v_count_zonas_cat_eleg;
            END IF;
        END IF;

        IF v_regla_zonas_activa THEN
            IF v_count_zonas_asoc IS NULL OR v_count_zonas_asoc < 1 THEN
                RAISE EXCEPTION 'Versión %: regla_zonas_extremas_activa está activa pero no tiene ninguna asociación incluida (mínimo 1 requerida) — no se activa.', p_version_id;
            END IF;
            IF v_count_zonas_cat <> 3 THEN
                RAISE EXCEPTION 'Versión %: regla_zonas_extremas_activa está activa pero no tiene categorías configuradas (se requieren las 3: A, B, C) — no se activa.', p_version_id;
            END IF;
        END IF;
    END IF;

    -- NUEVO — Prioridad Deportiva (schema_version=4): mismo criterio
    -- "estructural SIEMPRE, mínimos solo si la regla está activa" que Zonas
    -- Extremas. Al ser una PERMUTACIÓN completa (nunca un subconjunto — a
    -- diferencia de la matriz de categorías, que admite "al menos 1
    -- elegible"), estructuralmente válido significa 0 filas o EXACTAMENTE
    -- las 6 clasificaciones con orden 1..6 sin huecos — nunca un conjunto
    -- parcial, tenga la regla el estado que tenga.
    IF v_schema_version = 4 THEN
        SELECT count(*), max(orden) INTO v_count_prioridad, v_max_orden_prioridad
        FROM public.configuracion_designacion_prioridad_clasificaciones
        WHERE version_id = p_version_id;

        IF v_count_prioridad NOT IN (0, 6) THEN
            RAISE EXCEPTION 'Versión %: si existe prioridad deportiva configurada, debe tener exactamente las 6 clasificaciones; tiene % — no se activa.', p_version_id, v_count_prioridad;
        END IF;
        IF v_count_prioridad = 6 AND v_max_orden_prioridad IS DISTINCT FROM 6 THEN
            RAISE EXCEPTION 'Versión %: el orden de prioridad deportiva no es secuencial sin huecos (máximo=%, debe ser 6) — no se activa.', p_version_id, v_max_orden_prioridad;
        END IF;

        IF v_regla_prioridad_activa AND v_count_prioridad = 0 THEN
            RAISE EXCEPTION 'Versión %: regla_prioridad_deportiva_activa está activa pero no hay ningún orden de prioridad configurado — no se activa.', p_version_id;
        END IF;
    END IF;

    -- Repetición por Intervalo — totalmente garantizada por los CHECK de la
    -- tabla (chk_config_designacion_intervalo_requiere_schema4/chk_config_
    -- designacion_intervalo_meses): no requiere validación adicional acá
    -- (a diferencia de Zonas Extremas/Prioridad Deportiva, es un único
    -- valor escalar, no una cardinalidad entre filas).
END;
$$;

REVOKE ALL ON FUNCTION public._validar_estructura_configuracion_designacion(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._validar_estructura_configuracion_designacion(UUID) FROM anon;
REVOKE ALL ON FUNCTION public._validar_estructura_configuracion_designacion(UUID) FROM authenticated;
REVOKE ALL ON FUNCTION public._validar_estructura_configuracion_designacion(UUID) FROM service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 11. activar_configuracion_designacion — CREATE OR REPLACE, misma firma
--     UUID exacta, comportamiento externo idéntico — delega en el punto 10.
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
-- 12. crear_configuracion_designacion_version_v4 — RPC NUEVA (no reemplaza
--     nada). Exclusiva para crear versiones schema_version=4 con Prioridad
--     Deportiva + Nota Técnica (vía p_orden_criterios) + Repetición por
--     Intervalo. Las RPC v1/v2/v3 siguen existiendo sin cambios.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.crear_configuracion_designacion_version_v4(
    p_regla_distancia_maxima_activa              BOOLEAN,
    p_distancia_maxima_km                        NUMERIC,
    p_regla_no_repetir_asociacion_activa          BOOLEAN,
    p_regla_un_rodeo_por_finde_activa             BOOLEAN,
    p_regla_finde_consecutivo_activa              BOOLEAN,
    p_regla_asociacion_organizadora_activa        BOOLEAN,
    p_regla_equidad_traslados_activa              BOOLEAN,
    p_umbral_lejania_km                           NUMERIC,
    p_regla_zonas_extremas_activa                 BOOLEAN,
    p_descripcion                                 TEXT,
    p_creado_por                                  UUID,
    -- [{"criterio_codigo":"NOTA_TECNICA","orden":1}, ...] — SOLO los criterios ACTIVOS.
    p_orden_criterios                             JSONB,
    -- [{"clasificacion_codigo":"provincial","categoria":"A","elegible":true,"orden_preferencia":1}, ...] — EXACTAMENTE 18 filas.
    p_matriz                                      JSONB,
    -- ["MAGALLANES","AYSEN",...] — asociaciones incluidas en Zonas Extremas.
    p_zonas_extremas_asociaciones                 JSONB,
    -- [{"categoria":"A","elegible":false,"orden_preferencia":null}, ...] — EXACTAMENTE 3 filas.
    p_zonas_extremas_categorias                   JSONB,
    p_regla_prioridad_deportiva_activa            BOOLEAN,
    -- [{"clasificacion_codigo":"zonal","orden":1}, ...] — EXACTAMENTE 6 filas (permutación completa).
    p_prioridad_clasificaciones                   JSONB,
    p_regla_repeticion_asociacion_intervalo_activa BOOLEAN,
    p_repeticion_asociacion_meses                 INTEGER
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
    -- schema_version fijo a 4 — esta RPC NUNCA crea otro schema. activa=false
    -- SIEMPRE — activar sigue siendo un paso separado y explícito.
    INSERT INTO public.configuracion_designacion_versiones (
        schema_version, activa,
        regla_distancia_maxima_activa, distancia_maxima_km,
        regla_no_repetir_asociacion_activa, regla_un_rodeo_por_finde_activa,
        regla_finde_consecutivo_activa, regla_asociacion_organizadora_activa,
        regla_equidad_traslados_activa, umbral_lejania_km,
        regla_zonas_extremas_activa,
        regla_prioridad_deportiva_activa,
        regla_repeticion_asociacion_intervalo_activa, repeticion_asociacion_meses,
        descripcion, creado_por
    ) VALUES (
        4, false,
        p_regla_distancia_maxima_activa, p_distancia_maxima_km,
        p_regla_no_repetir_asociacion_activa, p_regla_un_rodeo_por_finde_activa,
        p_regla_finde_consecutivo_activa, p_regla_asociacion_organizadora_activa,
        p_regla_equidad_traslados_activa, p_umbral_lejania_km,
        p_regla_zonas_extremas_activa,
        p_regla_prioridad_deportiva_activa,
        p_regla_repeticion_asociacion_intervalo_activa, p_repeticion_asociacion_meses,
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

    -- Zonas Extremas — se insertan SIEMPRE que vengan en el payload, activa
    -- o no la regla (mismo motivo que v3: permite guardar/editar un draft
    -- antes de activarla, y conservarla si se apaga el toggle).
    INSERT INTO public.configuracion_designacion_zonas_extremas (version_id, asociacion)
    SELECT v_version_id, x.value
    FROM jsonb_array_elements_text(COALESCE(p_zonas_extremas_asociaciones, '[]'::jsonb)) AS x(value);

    INSERT INTO public.configuracion_designacion_zona_extrema_categorias (version_id, categoria, elegible, orden_preferencia)
    SELECT v_version_id, x.categoria, x.elegible, x.orden_preferencia
    FROM jsonb_to_recordset(COALESCE(p_zonas_extremas_categorias, '[]'::jsonb)) AS x(categoria TEXT, elegible BOOLEAN, orden_preferencia INTEGER);

    -- Prioridad Deportiva — misma política: se inserta SIEMPRE que venga en
    -- el payload, activa o no la regla.
    INSERT INTO public.configuracion_designacion_prioridad_clasificaciones (version_id, clasificacion_codigo, orden)
    SELECT v_version_id, x.clasificacion_codigo, x.orden
    FROM jsonb_to_recordset(COALESCE(p_prioridad_clasificaciones, '[]'::jsonb)) AS x(clasificacion_codigo TEXT, orden INTEGER);

    -- Misma validación estructural que exige activar_configuracion_
    -- designacion (punto 10) — incluye Zonas Extremas/Prioridad Deportiva/
    -- Repetición por Intervalo si están activas. Si falla, PostgreSQL
    -- revierte los 4 INSERT de arriba como una sola unidad — nunca queda
    -- una cabecera huérfana.
    PERFORM public._validar_estructura_configuracion_designacion(v_version_id);

    RETURN QUERY SELECT v_version_id, v_numero_version;
END;
$$;

REVOKE ALL ON FUNCTION public.crear_configuracion_designacion_version_v4(
    BOOLEAN, NUMERIC, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, NUMERIC, BOOLEAN, TEXT, UUID, JSONB, JSONB, JSONB, JSONB, BOOLEAN, JSONB, BOOLEAN, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crear_configuracion_designacion_version_v4(
    BOOLEAN, NUMERIC, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, NUMERIC, BOOLEAN, TEXT, UUID, JSONB, JSONB, JSONB, JSONB, BOOLEAN, JSONB, BOOLEAN, INTEGER
) FROM anon;
REVOKE ALL ON FUNCTION public.crear_configuracion_designacion_version_v4(
    BOOLEAN, NUMERIC, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, NUMERIC, BOOLEAN, TEXT, UUID, JSONB, JSONB, JSONB, JSONB, BOOLEAN, JSONB, BOOLEAN, INTEGER
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.crear_configuracion_designacion_version_v4(
    BOOLEAN, NUMERIC, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, NUMERIC, BOOLEAN, TEXT, UUID, JSONB, JSONB, JSONB, JSONB, BOOLEAN, JSONB, BOOLEAN, INTEGER
) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 13. RLS — administrativa, sin políticas públicas (mismo patrón que 050/053).
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE configuracion_designacion_prioridad_clasificaciones ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────
-- 14. NOTIFY pgrst, 'reload schema' — mecanismo estándar de Supabase/
--     PostgREST (mismo patrón ya establecido en la migración 088): esta
--     migración agrega una función NUEVA (crear_configuracion_designacion_
--     version_v4) y una tabla NUEVA — sin este reload, PostgREST podría
--     seguir usando su caché de esquema anterior y devolver "could not
--     find function"/"relation does not exist" a través de supabase-js
--     hasta su próximo reload automático (periódico, no inmediato).
--     Deliberadamente FUERA del BEGIN/COMMIT (es una notificación, no una
--     operación transaccional) — idempotente, seguro de repetir.
-- ─────────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- ── Verificación sugerida post-aplicación (no destructiva) ─────────────────
--
-- ESTADO 1 — backend actualmente desplegado sigue funcionando SIN cambios:
-- SELECT proname, pronargs FROM pg_proc WHERE proname IN
--   ('crear_configuracion_designacion_version', 'crear_configuracion_designacion_version_v2', 'crear_configuracion_designacion_version_v3');
--   -- deben existir con pronargs=10, 12 y 15 respectivamente (intactas).
--
-- SELECT numero_version, schema_version, regla_prioridad_deportiva_activa,
--        regla_repeticion_asociacion_intervalo_activa, repeticion_asociacion_meses
--   FROM configuracion_designacion_versiones ORDER BY numero_version;
--   -- toda fila existente debe seguir mostrando regla_prioridad_deportiva_activa=false,
--   -- regla_repeticion_asociacion_intervalo_activa=false, repeticion_asociacion_meses=NULL.
--   -- (0 filas nuevas — esta migración no crea ninguna versión.)
--
-- ESTADO 2 — la RPC nueva existe y es utilizable (solo lectura/prueba):
-- SELECT proname, pronargs FROM pg_proc WHERE proname = 'crear_configuracion_designacion_version_v4';
--   -- debe existir con pronargs=19.
--
-- SELECT table_name FROM information_schema.tables
--   WHERE table_name = 'configuracion_designacion_prioridad_clasificaciones';
--   -- debe existir.
--
-- SELECT grantee, privilege_type FROM information_schema.table_privileges
--   WHERE table_name = 'configuracion_designacion_prioridad_clasificaciones'
--   ORDER BY grantee, privilege_type;
--   -- debe mostrar ÚNICAMENTE service_role con SELECT — ninguna fila para
--   -- PUBLIC, anon ni authenticated, y ningún otro privilegio (INSERT/
--   -- UPDATE/DELETE) para service_role.
--
-- SELECT grantee, privilege_type FROM information_schema.routine_privileges
--   WHERE routine_name = 'crear_configuracion_designacion_version_v4';
--   -- debe incluir service_role con EXECUTE, y NO incluir PUBLIC/anon/authenticated.
--
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'configuracion_designacion_versiones'::regclass AND contype = 'c'
--   ORDER BY conname;
--   -- debe incluir chk_config_designacion_schema_version con "IN (1,2,3,4)",
--   -- chk_config_designacion_equidad_requiere_schema_2_3_o_4, chk_config_
--   -- designacion_zonas_extremas_requiere_schema_3_o_4, chk_config_designacion_
--   -- prioridad_requiere_schema4, chk_config_designacion_intervalo_requiere_schema4,
--   -- chk_config_designacion_intervalo_meses — y NO debe seguir apareciendo
--   -- chk_config_designacion_equidad_requiere_schema_2_o_3 ni chk_config_
--   -- designacion_zonas_extremas_requiere_schema3.
--
-- -- Prueba conceptual de integridad (transaccional, con ROLLBACK explícito
-- -- — nunca persiste nada):
-- -- BEGIN;
-- --   SELECT * FROM crear_configuracion_designacion_version_v4(
-- --     false, NULL, true, true, true, true, false, NULL, false,
-- --     'prueba de integridad — nunca persistida', NULL,
-- --     '[{"criterio_codigo":"PRIORIDAD_CATEGORIA","orden":1},{"criterio_codigo":"MENOS_DESIGNACIONES_TEMPORADA","orden":2},{"criterio_codigo":"MENOR_DISTANCIA","orden":3},{"criterio_codigo":"NOTA_TECNICA","orden":4}]'::jsonb,
-- --     '[]'::jsonb, -- matriz incompleta a propósito: debe fallar la validación estructural (18 filas requeridas)
-- --     '[]'::jsonb, '[]'::jsonb,
-- --     true,
-- --     '[{"clasificacion_codigo":"zonal","orden":1},{"clasificacion_codigo":"interasociaciones","orden":2},{"clasificacion_codigo":"provincial","orden":3},{"clasificacion_codigo":"interclubes","orden":4},{"clasificacion_codigo":"clasificatorio","orden":5},{"clasificacion_codigo":"nacional","orden":6}]'::jsonb,
-- --     true, 6
-- --   );
-- --   -- debe fallar con el mensaje de "la matriz debe tener exactamente 18 filas".
-- -- ROLLBACK;
