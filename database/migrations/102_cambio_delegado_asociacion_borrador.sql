-- ═════════════════════════════════════════════════════════════════════════
-- 102: Cambio de Delegado de Asociación en cartillas en BORRADOR
--      (Admin → Rodeos → Informe del Delegado Oficial del Rodeo →
--      "Cambiar delegado").
--
-- ADITIVA: crea UNA función nueva. No modifica ninguna tabla, columna,
-- índice, CHECK ni la RPC 069 (reemplazar_delegado_institucional_rodeo), que
-- queda tal cual en producción.
--
-- Por qué no basta la RPC 069 (verificado en producción el 2026-11-17):
--   1. Solo bloquea enviada/reenviada/aprobada/cerrada: deja pasar
--      observada y reabierta, y el backend solo podía bloquearlas ANTES de
--      llamarla (ventana de carrera entre la validación y la RPC).
--   2. No recibe el responsable ni la versión que vio el administrador: dos
--      administradores con información desactualizada podían pisarse sin
--      aviso (el segundo sobrescribía al primero).
--   3. No valida al nuevo delegado (activo/certificado/asociación) dentro
--      de la transacción, y su auditoría guarda el delegado anterior solo
--      por id.
--
-- Esta función hace TODO en una sola transacción, con bloqueos de fila:
--   - rodeo (rodeos) FOR SHARE: su asociación organizadora no puede
--     cambiar mientras se valida y se aplica el cambio;
--   - asociación resuelta (asociaciones) y alias coincidentes
--     (asociacion_alias) FOR SHARE: no pueden renombrarse ni borrarse
--     durante la transacción;
--   - designación (rodeos_delegado_institucional) FOR UPDATE;
--   - cartilla institucional del rodeo (a lo sumo una: índice único
--     uq_cartillas_delegado_rodeo_institucional) FOR UPDATE;
--   - nuevo delegado (delegados_asociacion) FOR SHARE — no puede ser
--     suspendido ni descertificado mientras se confirma el cambio.
-- Valida: motivo; asociación REAL del rodeo resuelta DENTRO de PostgreSQL y
-- = p_asociacion_id (nunca se confía solo en el id que envía el backend);
-- designación existente; responsable vigente = el visto; nuevo ≠ vigente;
-- nuevo activo, certificado y de esa asociación; cartilla en 'borrador'
-- (cualquier otro estado → CARTILLA_NO_BORRADOR); versión de la cartilla =
-- la vista.
--
-- Resolución de la asociación del rodeo (misma regla que el backend,
-- resolverAsociacion() de services/informeGestion/asociaciones.js):
--   rodeos.asociacion (texto) → public._normalizar_asociacion_designacion()
--   (migración 053: réplica exacta de normalizarAsociacion() — minúsculas,
--   sin tildes vía extensions.unaccent, guiones→espacio, espacios
--   colapsados, sin prefijo "asociacion ") → coincidencia EXACTA contra
--   asociaciones.nombre_normalizado O asociacion_alias.alias_normalizado.
--   Nunca ILIKE ni coincidencia parcial: "BIO BIO" y "RIO BIO BIO", o
--   "MAIPO" y "MAIPO NORTE", siguen siendo asociaciones distintas.
--   - 0 asociaciones coincidentes        → ASOCIACION_NO_RESUELTA
--   - más de 1 (nombre de una = alias de
--     otra)                               → ASOCIACION_AMBIGUA (el backend
--     tomaría la del nombre; aquí se rechaza: "inequívocamente")
--   - 1 pero distinta de p_asociacion_id → ASOCIACION_NO_COINCIDE
--
-- Privilegios de los normalizadores de la 053: hoy NADIE puede ejecutarlos
-- directamente (REVOKE incluso de service_role, porque solo los usaban
-- funciones SECURITY DEFINER). Esta función es SECURITY INVOKER (se ejecuta
-- con los privilegios de service_role), así que se les otorga EXECUTE
-- SOLO a service_role. Son funciones puras de texto (no leen ni escriben
-- ninguna tabla): el otorgamiento no expone datos. anon/authenticated/
-- PUBLIC siguen sin acceso.
-- Escribe EXACTAMENTE lo mismo que la 069 (designación + delegado_
-- asociacion_id/delegado_nombre/version/updated_at de la cartilla — el
-- resto del borrador nunca se toca) y UN solo evento de auditoría, con los
-- nombres anterior y nuevo, en la misma transacción. Usa la misma tabla/
-- acción que la 069 ('rodeos_delegado_institucional' /
-- 'reemplazar_responsable_institucional'), así el Historial de Responsables
-- existente (services/historialResponsableInstitucional.js) lo muestra sin
-- cambios y sin duplicados.
--
-- Seguridad: SECURITY INVOKER, search_path fijo, EXECUTE solo service_role
-- (mismo criterio que 071). El backend exige Administrador pleno.
-- Idempotente: CREATE OR REPLACE.
--
-- Depende de: 053 (normalizadores + extensión unaccent en el esquema
-- extensions), 057 (asociaciones/asociacion_alias), 062/064
-- (delegados_asociacion), 065 (cartillas institucionales), 068
-- (rodeos_delegado_institucional), 069 (auditoria.actor_tipo).
--
-- Reversible:
--   DROP FUNCTION IF EXISTS public.cambiar_delegado_asociacion_borrador(UUID, UUID, UUID, UUID, INTEGER, UUID, TEXT);
--   REVOKE EXECUTE ON FUNCTION public._normalizar_asociacion_designacion(TEXT) FROM service_role;
--   REVOKE EXECUTE ON FUNCTION public._normalizar_texto_designacion(TEXT) FROM service_role;
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.cambiar_delegado_asociacion_borrador(
    p_rodeo_id                      UUID,
    p_asociacion_id                 UUID,
    p_delegado_actual_id            UUID,
    p_nuevo_delegado_asociacion_id  UUID,
    p_cartilla_version              INTEGER,
    p_administrador_id              UUID,
    p_motivo                        TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_motivo          TEXT := btrim(COALESCE(p_motivo, ''));
    v_rodeo_asociacion TEXT;
    v_asoc_normalizada TEXT;
    v_asociaciones    UUID[];
    v_designacion     rodeos_delegado_institucional%ROWTYPE;
    v_cartilla        cartillas_delegado%ROWTYPE;
    v_hay_cartilla    BOOLEAN;
    v_nuevo           delegados_asociacion%ROWTYPE;
    v_nombre_anterior TEXT;
    v_version_nueva   INTEGER;
BEGIN
    IF p_administrador_id IS NULL THEN RAISE EXCEPTION 'ADMINISTRADOR_REQUERIDO'; END IF;
    IF v_motivo = '' THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;
    IF length(v_motivo) > 1000 THEN RAISE EXCEPTION 'MOTIVO_DEMASIADO_LARGO'; END IF;
    IF p_nuevo_delegado_asociacion_id IS NULL OR p_delegado_actual_id IS NULL OR p_asociacion_id IS NULL THEN
        RAISE EXCEPTION 'PARAMETROS_INCOMPLETOS';
    END IF;

    -- 0) Asociación REAL del rodeo, resuelta y comparada DENTRO de la
    --    transacción. FOR SHARE: nadie puede cambiar rodeos.asociacion (ni
    --    renombrar/borrar la asociación o el alias que coincidieron) hasta
    --    que esta transacción termine.
    SELECT asociacion INTO v_rodeo_asociacion FROM rodeos WHERE id = p_rodeo_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'RODEO_NO_ENCONTRADO'; END IF;

    v_asoc_normalizada := public._normalizar_asociacion_designacion(v_rodeo_asociacion);
    IF v_asoc_normalizada IS NULL OR v_asoc_normalizada = '' THEN
        RAISE EXCEPTION 'ASOCIACION_NO_RESUELTA';
    END IF;

    PERFORM 1 FROM asociaciones WHERE nombre_normalizado = v_asoc_normalizada FOR SHARE;
    PERFORM 1 FROM asociacion_alias WHERE alias_normalizado = v_asoc_normalizada FOR SHARE;

    SELECT array_agg(DISTINCT x.asociacion_id) INTO v_asociaciones FROM (
        SELECT id AS asociacion_id FROM asociaciones WHERE nombre_normalizado = v_asoc_normalizada
        UNION
        SELECT asociacion_id FROM asociacion_alias WHERE alias_normalizado = v_asoc_normalizada
    ) x;

    IF v_asociaciones IS NULL OR cardinality(v_asociaciones) = 0 THEN
        RAISE EXCEPTION 'ASOCIACION_NO_RESUELTA';
    END IF;
    IF cardinality(v_asociaciones) > 1 THEN
        RAISE EXCEPTION 'ASOCIACION_AMBIGUA';
    END IF;
    IF v_asociaciones[1] IS DISTINCT FROM p_asociacion_id THEN
        RAISE EXCEPTION 'ASOCIACION_NO_COINCIDE';
    END IF;

    -- 1) Designación vigente (mismo orden de bloqueo que la 069:
    --    designación → cartilla).
    SELECT * INTO v_designacion FROM rodeos_delegado_institucional
        WHERE rodeo_id = p_rodeo_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'SIN_DESIGNACION_PREVIA'; END IF;

    IF v_designacion.delegado_asociacion_id IS DISTINCT FROM p_delegado_actual_id THEN
        RAISE EXCEPTION 'RESPONSABLE_CAMBIO_CONCURRENTE';
    END IF;
    IF p_nuevo_delegado_asociacion_id = v_designacion.delegado_asociacion_id THEN
        RAISE EXCEPTION 'MISMO_DELEGADO';
    END IF;

    -- 2) Cartilla institucional del rodeo (las de Delegado Rentado tienen
    --    delegado_asociacion_id NULL y nunca se leen ni se tocan).
    SELECT * INTO v_cartilla FROM cartillas_delegado
        WHERE rodeo_id = p_rodeo_id AND delegado_asociacion_id IS NOT NULL
        FOR UPDATE;
    v_hay_cartilla := FOUND;

    IF v_hay_cartilla THEN
        IF v_cartilla.estado IS DISTINCT FROM 'borrador' THEN
            RAISE EXCEPTION 'CARTILLA_NO_BORRADOR: %', v_cartilla.estado;
        END IF;
        IF p_cartilla_version IS NULL OR v_cartilla.version IS DISTINCT FROM p_cartilla_version THEN
            RAISE EXCEPTION 'VERSION_DESACTUALIZADA';
        END IF;
    ELSIF p_cartilla_version IS NOT NULL THEN
        -- El administrador vio una cartilla que ya no existe: información
        -- desactualizada, nunca se asume nada.
        RAISE EXCEPTION 'VERSION_DESACTUALIZADA';
    END IF;

    -- 3) Nuevo delegado: activo, certificado y de la asociación real del
    --    rodeo. FOR SHARE: nadie puede suspenderlo/descertificarlo hasta
    --    que esta transacción termine.
    SELECT * INTO v_nuevo FROM delegados_asociacion
        WHERE id = p_nuevo_delegado_asociacion_id FOR SHARE;
    IF NOT FOUND OR NOT v_nuevo.activo OR NOT v_nuevo.certificado
       OR v_nuevo.asociacion_id IS DISTINCT FROM p_asociacion_id THEN
        RAISE EXCEPTION 'DELEGADO_NO_VALIDO';
    END IF;

    -- Nombre del responsable anterior: snapshot de la cartilla o catálogo.
    v_nombre_anterior := CASE WHEN v_hay_cartilla THEN v_cartilla.delegado_nombre END;
    IF v_nombre_anterior IS NULL THEN
        SELECT nombre INTO v_nombre_anterior FROM delegados_asociacion
            WHERE id = v_designacion.delegado_asociacion_id;
    END IF;

    -- 4) Escritura: idéntica a la 069 (nunca otras columnas del borrador).
    UPDATE rodeos_delegado_institucional
        SET delegado_asociacion_id = v_nuevo.id, updated_at = now()
        WHERE id = v_designacion.id;

    IF v_hay_cartilla THEN
        UPDATE cartillas_delegado
            SET delegado_asociacion_id = v_nuevo.id,
                delegado_nombre        = v_nuevo.nombre,
                version                = version + 1,
                updated_at             = now()
            WHERE id = v_cartilla.id
            RETURNING version INTO v_version_nueva;
    END IF;

    -- 5) Un único evento de auditoría, completo y en la misma transacción.
    INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES (
        'rodeos_delegado_institucional', v_designacion.id::text, 'reemplazar_responsable_institucional',
        jsonb_build_object(
            'delegado_asociacion_id', v_designacion.delegado_asociacion_id,
            'delegado_nombre',        v_nombre_anterior,
            'cartilla_version',       CASE WHEN v_hay_cartilla THEN v_cartilla.version END
        ),
        jsonb_build_object(
            'delegado_asociacion_id', v_nuevo.id,
            'delegado_nombre',        v_nuevo.nombre,
            'motivo',                 v_motivo,
            'rodeo_id',               p_rodeo_id,
            'cartilla_id',            CASE WHEN v_hay_cartilla THEN v_cartilla.id END,
            'cartilla_estado',        CASE WHEN v_hay_cartilla THEN v_cartilla.estado END,
            'cartilla_version',       v_version_nueva,
            'flujo',                  'cambio_delegado_borrador'
        ),
        p_administrador_id::text, 'administrador',
        format('Cambio de Delegado de Asociación: %s → %s — motivo: %s',
               COALESCE(v_nombre_anterior, '—'), v_nuevo.nombre, v_motivo)
    );

    RETURN jsonb_build_object(
        'designacion_id',    v_designacion.id,
        'rodeo_id',          p_rodeo_id,
        'cartilla_id',       CASE WHEN v_hay_cartilla THEN v_cartilla.id END,
        'cartilla_version',  v_version_nueva,
        'delegado_anterior', jsonb_build_object('id', v_designacion.delegado_asociacion_id, 'nombre', v_nombre_anterior),
        'delegado_nuevo',    jsonb_build_object('id', v_nuevo.id, 'nombre', v_nuevo.nombre)
    );
END;
$$;

COMMENT ON FUNCTION public.cambiar_delegado_asociacion_borrador(UUID, UUID, UUID, UUID, INTEGER, UUID, TEXT) IS
    'Migración 102: cambio administrativo del Delegado de Asociación SOLO para cartillas en borrador (o rodeos sin cartilla). Valida responsable y versión vistos (concurrencia), delegado activo/certificado/de la asociación, y audita con nombres anterior y nuevo en la misma transacción. No modifica la RPC 069.';

REVOKE ALL ON FUNCTION public.cambiar_delegado_asociacion_borrador(UUID, UUID, UUID, UUID, INTEGER, UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cambiar_delegado_asociacion_borrador(UUID, UUID, UUID, UUID, INTEGER, UUID, TEXT)
    TO service_role;

-- Normalizadores de la 053 (funciones puras de texto, sin acceso a datos):
-- EXECUTE solo para service_role, necesario porque la función de arriba es
-- SECURITY INVOKER. PUBLIC/anon/authenticated siguen revocados (053).
GRANT EXECUTE ON FUNCTION public._normalizar_texto_designacion(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public._normalizar_asociacion_designacion(TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
