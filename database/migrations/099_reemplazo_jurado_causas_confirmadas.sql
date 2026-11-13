-- ═════════════════════════════════════════════════════════════════════════
-- 099_reemplazo_jurado_causas_confirmadas.sql
-- Hotfix — reemplazo de jurado con advertencias (preferencias flexibles).
--
-- ⚠️ NO APLICADA — preparada, pendiente de autorización explícita.
--
-- PROBLEMA: POST /admin/asignaciones/:id/reemplazar exige confirmar las
-- advertencias flexibles del jurado nuevo (CON_ADVERTENCIAS), pero
-- reemplazar_jurado_asignacion_con_bitacora() no tenía cómo registrar QUÉ
-- causas aceptó el administrador: bitacora_designaciones.causas_confirmadas
-- (columna creada en 094) quedaba siempre NULL en los reemplazos. Caso real:
-- rodeo VICTORIA/MALLECO 14-15/11/2026, reemplazante con FINDE_CONSECUTIVO.
--
-- CAMBIO ÚNICO: parámetro nuevo opcional p_causas_confirmadas JSONB DEFAULT
-- NULL (al final), validado y reenviado a registrar_movimiento_designacion()
-- (firma de 15 parámetros de 094, que ya lo acepta). El resto del cuerpo es
-- COPIA TEXTUAL de la versión del repositorio más reciente (095): advisory
-- lock, orden de locks, PAGO_BASE_INCONSISTENTE_CON_DURACION, sincronización
-- de duración, CONFLICTO_DESIGNACION_MODIFICADA, MOTIVO_INVALIDO,
-- antecedentes sensibles, JURADO_YA_DESIGNADO_EN_RODEO y CRUCE_DISPONIBILIDAD
-- (excluyendo anuladas y rechazadas) — ninguna garantía se elimina.
--
-- Validación de p_causas_confirmadas (integridad del dato, NUNCA una
-- reevaluación de reglas de negocio — esas se evalúan en JavaScript con el
-- motor y la configuración vigente, justo antes de llamar a esta función):
--   - NULL           → reemplazo sin excepción (comportamiento idéntico al anterior).
--   - no-NULL        → debe ser un array JSON no vacío, solo de strings, sin
--                      duplicados y SOLO con causas relajables reconocidas
--                      (espejo de CAUSAS_RELAJABLES, motorPropuestaDesignacionGlobal.js,
--                      mismo allowlist que 094/crear_asignacion_con_bitacora).
--                      Una causa obligatoria (DISPONIBILIDAD, CATEGORIA_INCOMPATIBLE,
--                      MISMA_ASOCIACION, MISMO_FINDE, ASOCIACION_REPETIDA_INTERVALO)
--                      o desconocida se rechaza: nunca puede "confirmarse".
--
-- FIRMA / SOBRECARGAS: agregar un parámetro cambia la firma; CREATE OR
-- REPLACE dejaría vivas AMBAS versiones (12 y 13 parámetros) y la de 12
-- seguiría siendo invocable sin registrar causas, además de volver ambigua
-- cualquier llamada por nombre. Se hace DROP explícito de la firma de 12
-- parámetros dentro de la MISMA transacción (mismo patrón que 094 con
-- registrar_movimiento_designacion). Dependencias revisadas: ninguna vista
-- ni función SQL llama a esta función; su único llamador es el backend
-- (POST /api/admin/asignaciones/:id/reemplazar) vía PostgREST con argumentos
-- nombrados — un backend anterior que no envía p_causas_confirmadas sigue
-- funcionando (DEFAULT NULL).
--
-- DEPENDENCIAS DE MIGRACIONES: requiere 094 (columna causas_confirmadas y
-- registrar_movimiento_designacion de 15 parámetros). NO depende de 097 ni
-- de 098 (trabajo independiente de acertividad) ni de 089. Si 095 no
-- estuviera aplicada en el entorno destino, esta migración incorpora
-- también su cambio (exclusión de 'rechazado' en el cruce con otro rodeo):
-- verificar antes de aplicar (ver plan de publicación del hotfix).
--
-- No contiene UPDATE/DELETE sobre datos. Transaccional e idempotente.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

DROP FUNCTION IF EXISTS reemplazar_jurado_asignacion_con_bitacora(
    UUID, UUID, TEXT, INTEGER, INTEGER, UUID, UUID, TEXT, UUID, TEXT, TIMESTAMPTZ, UUID
);

CREATE OR REPLACE FUNCTION reemplazar_jurado_asignacion_con_bitacora(
    p_asignacion_id                        UUID,
    p_usuario_pagado_id_nuevo              UUID,
    p_categoria_aplicada_nueva             TEXT,
    p_valor_diario_aplicado_nuevo          INTEGER,
    p_pago_base_calculado_nuevo            INTEGER,
    p_motivo_catalogo_id                   UUID,
    p_actor_id                             UUID,
    p_tipo_movimiento                      TEXT DEFAULT 'reemplazo',
    p_usuario_pagado_id_anterior_esperado  UUID DEFAULT NULL,
    p_motivo_detalle                       TEXT DEFAULT NULL,
    p_fecha_efectiva                       TIMESTAMPTZ DEFAULT NULL,
    p_operacion_id                         UUID DEFAULT NULL,
    p_causas_confirmadas                   JSONB DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
-- SECURITY INVOKER (ver Decisión 8 de 084) — sin cambios.
SET search_path = public
AS $$
DECLARE
    v_rodeo_id         UUID;
    v_rodeo_fecha       DATE;
    v_rodeo_duracion    INTEGER;
    v_anterior         asignaciones%ROWTYPE;
    v_nueva            asignaciones%ROWTYPE;
    v_nuevo_jurado      usuarios_pagados%ROWTYPE;
    v_motivo           catalogo_motivos_designacion%ROWTYPE;
    v_bitacora         bitacora_designaciones;
    v_ya_designado     BOOLEAN;
    v_cruce_otro_rodeo BOOLEAN;
BEGIN
    IF p_tipo_movimiento NOT IN (
        'reemplazo', 'cambio_emergencia', 'regularizacion_posterior',
        'rectificacion_administrativa', 'enroque'
    ) THEN
        RAISE EXCEPTION 'TIPO_MOVIMIENTO_NO_PERMITIDO: % no es válido para un reemplazo transaccional', p_tipo_movimiento;
    END IF;
    IF p_actor_id IS NULL THEN
        RAISE EXCEPTION 'ACTOR_REQUERIDO';
    END IF;
    IF p_usuario_pagado_id_nuevo IS NULL THEN
        RAISE EXCEPTION 'JURADO_NUEVO_REQUERIDO';
    END IF;

    -- 099 — validación estructural de las causas confirmadas (antes de
    -- cualquier lock o escritura). NULL = reemplazo sin excepción.
    IF p_causas_confirmadas IS NOT NULL THEN
        IF jsonb_typeof(p_causas_confirmadas) <> 'array' OR jsonb_array_length(p_causas_confirmadas) = 0 THEN
            RAISE EXCEPTION 'CAUSAS_CONFIRMADAS_INVALIDAS: debe ser un array JSON no vacío de causas relajables';
        END IF;
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_causas_confirmadas) AS e
            WHERE jsonb_typeof(e) <> 'string'
        ) THEN
            RAISE EXCEPTION 'CAUSAS_CONFIRMADAS_INVALIDAS: cada causa debe ser un código de texto';
        END IF;
        IF (SELECT count(*) FROM jsonb_array_elements_text(p_causas_confirmadas))
           <> (SELECT count(DISTINCT c) FROM jsonb_array_elements_text(p_causas_confirmadas) AS c) THEN
            RAISE EXCEPTION 'CAUSAS_CONFIRMADAS_INVALIDAS: causas duplicadas';
        END IF;
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(p_causas_confirmadas) AS causa
            WHERE causa NOT IN ('DISTANCIA_EXCEDIDA', 'ASOCIACION_REPETIDA_TEMPORADA', 'FINDE_CONSECUTIVO', 'JURADO_SIN_COMUNA_RESOLVIBLE')
        ) THEN
            RAISE EXCEPTION 'CAUSA_CONFIRMADA_DESCONOCIDA: solo se aceptan causas relajables reconocidas por el motor';
        END IF;
    END IF;

    -- Decisión 13 (084) — advisory lock sobre el jurado candidato. Sin cambios.
    PERFORM pg_advisory_xact_lock(hashtextextended(p_usuario_pagado_id_nuevo::text, 0));

    -- Punto de serialización por rodeo (Decisión 9 de 084). Sin cambios.
    SELECT rodeo_id INTO v_rodeo_id FROM asignaciones WHERE id = p_asignacion_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ASIGNACION_NO_ENCONTRADA';
    END IF;
    SELECT fecha, duracion_dias INTO v_rodeo_fecha, v_rodeo_duracion FROM rodeos WHERE id = v_rodeo_id FOR UPDATE;

    -- Verificación de pago contra la duración vigente (091, punto c). Sin cambios.
    IF p_pago_base_calculado_nuevo IS DISTINCT FROM round(COALESCE(p_valor_diario_aplicado_nuevo, 0) * COALESCE(v_rodeo_duracion, 1)) THEN
        RAISE EXCEPTION 'PAGO_BASE_INCONSISTENTE_CON_DURACION: el pago recibido (%) no corresponde a valor_diario_aplicado_nuevo (%) × la duración vigente del rodeo (%)',
            p_pago_base_calculado_nuevo, p_valor_diario_aplicado_nuevo, v_rodeo_duracion;
    END IF;

    -- Bloqueo de concurrencia de la fila afectada (Decisión 4 de 084). Sin cambios.
    SELECT * INTO v_anterior FROM asignaciones WHERE id = p_asignacion_id FOR UPDATE;
    IF v_anterior.tipo_persona <> 'jurado' THEN
        RAISE EXCEPTION 'SOLO_JURADO: esta función solo reemplaza asignaciones de tipo_persona = jurado';
    END IF;
    IF v_anterior.estado = 'anulado' THEN
        RAISE EXCEPTION 'ASIGNACION_ANULADA';
    END IF;

    IF p_usuario_pagado_id_anterior_esperado IS NOT NULL
       AND v_anterior.usuario_pagado_id IS DISTINCT FROM p_usuario_pagado_id_anterior_esperado THEN
        RAISE EXCEPTION 'CONFLICTO_DESIGNACION_MODIFICADA: la asignación ya fue modificada por otro administrador';
    END IF;

    SELECT * INTO v_motivo FROM catalogo_motivos_designacion WHERE id = p_motivo_catalogo_id;
    IF NOT FOUND OR v_motivo.activo IS NOT TRUE THEN
        RAISE EXCEPTION 'MOTIVO_INVALIDO';
    END IF;

    -- Identidad del jurado nuevo SIEMPRE leída de la fuente real (Decisión 6 de 084). Sin cambios.
    SELECT * INTO v_nuevo_jurado FROM usuarios_pagados WHERE id = p_usuario_pagado_id_nuevo;
    IF NOT FOUND OR v_nuevo_jurado.activo IS NOT TRUE OR v_nuevo_jurado.tipo_persona <> 'jurado' THEN
        RAISE EXCEPTION 'JURADO_NUEVO_INVALIDO';
    END IF;

    IF v_anterior.usuario_pagado_id IS NOT DISTINCT FROM p_usuario_pagado_id_nuevo THEN
        RAISE EXCEPTION 'JURADO_NUEVO_IGUAL_AL_ANTERIOR';
    END IF;

    -- Antecedentes sensibles — bloquea, nunca reasigna en silencio. Sin cambios.
    IF EXISTS (SELECT 1 FROM notas_rodeo WHERE asignacion_id = p_asignacion_id) THEN
        RAISE EXCEPTION 'ANTECEDENTE_SENSIBLE_NOTA: esta asignación ya tiene una nota de rodeo registrada';
    END IF;
    IF EXISTS (SELECT 1 FROM cartillas_jurado WHERE asignacion_id = p_asignacion_id) THEN
        RAISE EXCEPTION 'ANTECEDENTE_SENSIBLE_CARTILLA: esta asignación ya tiene una cartilla de jurado registrada';
    END IF;
    IF EXISTS (
        SELECT 1 FROM bonos_solicitados
        WHERE asignacion_id = p_asignacion_id AND estado IN ('aprobado', 'modificado')
    ) THEN
        RAISE EXCEPTION 'ANTECEDENTE_SENSIBLE_BONO: esta asignación tiene un bono de distancia aprobado con monto real';
    END IF;

    -- (a) Mismo rodeo. Sin cambios.
    SELECT EXISTS (
        SELECT 1 FROM asignaciones
        WHERE rodeo_id = v_anterior.rodeo_id
          AND usuario_pagado_id = p_usuario_pagado_id_nuevo
          AND id <> p_asignacion_id
          AND estado = 'activo'
          AND COALESCE(estado_designacion, 'pendiente') <> 'rechazado'
    ) INTO v_ya_designado;
    IF v_ya_designado THEN
        RAISE EXCEPTION 'JURADO_YA_DESIGNADO_EN_RODEO';
    END IF;

    -- (b) Otro rodeo con fechas que se cruzan (criterio de 095). Sin cambios.
    SELECT EXISTS (
        SELECT 1
        FROM asignaciones a2
        JOIN rodeos r2 ON r2.id = a2.rodeo_id
        WHERE a2.usuario_pagado_id = p_usuario_pagado_id_nuevo
          AND a2.id <> p_asignacion_id
          AND a2.rodeo_id <> v_rodeo_id
          AND a2.estado <> 'anulado'
          AND COALESCE(a2.estado_designacion, 'pendiente') <> 'rechazado'
          AND (r2.fecha + (COALESCE(r2.duracion_dias, 1) - 1) * INTERVAL '1 day')::date >= v_rodeo_fecha
          AND r2.fecha <= (v_rodeo_fecha + (COALESCE(v_rodeo_duracion, 1) - 1) * INTERVAL '1 day')::date
    ) INTO v_cruce_otro_rodeo;
    IF v_cruce_otro_rodeo THEN
        RAISE EXCEPTION 'CRUCE_DISPONIBILIDAD: el jurado nuevo ya está asignado a otro rodeo en fechas que se cruzan';
    END IF;

    UPDATE bonos_solicitados
        SET estado = 'desvinculado_por_cambio_designacion', updated_at = now()
        WHERE asignacion_id = p_asignacion_id AND estado IN ('pendiente', 'aprobado_auto');

    -- Sincronización de duracion_dias_aplicada (091, punto 4). Sin cambios.
    UPDATE asignaciones SET
        usuario_pagado_id        = p_usuario_pagado_id_nuevo,
        nombre_importado         = v_nuevo_jurado.nombre_completo,
        categoria_aplicada       = p_categoria_aplicada_nueva,
        valor_diario_aplicado    = p_valor_diario_aplicado_nuevo,
        duracion_dias_aplicada   = COALESCE(v_rodeo_duracion, 1),
        pago_base_calculado      = p_pago_base_calculado_nuevo,
        estado_designacion       = 'pendiente',
        aceptado_en              = NULL,
        observacion_designacion  = NULL,
        distancia_km             = NULL,
        updated_at               = now()
    WHERE id = p_asignacion_id
    RETURNING * INTO v_nueva;

    -- Única vía de escritura hacia la bitácora — 099: ahora también con las
    -- causas confirmadas (NULL si el reemplazo no tuvo advertencias).
    v_bitacora := registrar_movimiento_designacion(
        p_tipo_movimiento            := p_tipo_movimiento,
        p_rodeo_id                   := v_anterior.rodeo_id,
        p_actor_id                   := p_actor_id,
        p_propuesta_detalle_id       := v_anterior.propuesta_detalle_id,
        p_asignacion_id              := p_asignacion_id,
        p_usuario_pagado_id_anterior := v_anterior.usuario_pagado_id,
        p_nombre_anterior_snapshot   := v_anterior.nombre_importado,
        p_usuario_pagado_id_nuevo    := p_usuario_pagado_id_nuevo,
        p_nombre_nuevo_snapshot      := v_nuevo_jurado.nombre_completo,
        p_motivo_catalogo_id         := p_motivo_catalogo_id,
        p_motivo_detalle             := p_motivo_detalle,
        p_actor_tipo                 := 'administrador',
        p_fecha_efectiva             := p_fecha_efectiva,
        p_operacion_id               := p_operacion_id,
        p_causas_confirmadas         := p_causas_confirmadas
    );

    RETURN jsonb_build_object(
        'asignacion', row_to_json(v_nueva),
        'bitacora_id', v_bitacora.id,
        'usuario_pagado_id_anterior', v_anterior.usuario_pagado_id,
        'nombre_anterior_snapshot', v_anterior.nombre_importado,
        'causas_confirmadas', p_causas_confirmadas
    );
END;
$$;

REVOKE ALL ON FUNCTION reemplazar_jurado_asignacion_con_bitacora(
    UUID, UUID, TEXT, INTEGER, INTEGER, UUID, UUID, TEXT, UUID, TEXT, TIMESTAMPTZ, UUID, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION reemplazar_jurado_asignacion_con_bitacora(
    UUID, UUID, TEXT, INTEGER, INTEGER, UUID, UUID, TEXT, UUID, TEXT, TIMESTAMPTZ, UUID, JSONB
) TO service_role;

COMMENT ON FUNCTION reemplazar_jurado_asignacion_con_bitacora IS
    'Fase 1B + 091 + 095 + 099: único camino que conecta un cambio de jurado de una asignación con bitacora_designaciones, de forma atómica. 099: p_causas_confirmadas (JSONB, opcional) registra en la bitácora las causas relajables aceptadas expresamente por el administrador; solo admite causas relajables reconocidas, sin duplicados — nunca una causa obligatoria. Conserva todas las garantías previas (locks, pago vs duración, concurrencia optimista, motivo, antecedentes sensibles, cruces).';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Reversión (manual, solo con autorización): DROP de la firma de 13
-- parámetros y volver a ejecutar el CREATE OR REPLACE + REVOKE/GRANT de la
-- migración 095 tal cual está en su archivo. Ambos pasos dentro de una misma
-- transacción, para que la función nunca deje de existir para el backend.
