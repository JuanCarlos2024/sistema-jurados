-- ═════════════════════════════════════════════════════════════════════════
-- 095_correccion_falso_conflicto_rechazado_reemplazo.sql
-- Corrección final de seguridad — decisión explícita del usuario tras la
-- revisión puntual de la migración 094: la misma corrección aplicada ahí a
-- crear_asignacion_con_bitacora() (094, punto 3) se extiende ahora al
-- procedimiento de REEMPLAZO, que hasta hoy mantenía el criterio más laxo.
--
-- ⚠️ NO APLICADA — preparada, incremental e idempotente, pendiente de
-- autorización explícita para ejecutarse en Supabase. No se ejecuta SQL de
-- escritura como parte de esta corrección.
--
-- NO SE MODIFICAN 084, 091 NI 094 — sus archivos quedan intactos como
-- registro histórico de lo que ya se aplicó. Esta migración parte de la
-- definición REAL y actualmente vigente de reemplazar_jurado_asignacion_
-- con_bitacora() — la de la migración 091 (punto 4 de ese archivo:
-- CREATE OR REPLACE sobre 084, que agrega la sincronización de
-- duracion_dias_aplicada y la verificación PAGO_BASE_INCONSISTENTE_CON_
-- DURACION) — copiada aquí TEXTUALMENTE, con un único cambio real.
--
-- PROBLEMA CONFIRMADO — el chequeo de "cruce con otro rodeo" de esta
-- función solo excluía asignaciones con estado='anulado'. Una designación
-- RECHAZADA (estado_designacion='rechazado') en otro rodeo — el jurado
-- nunca llegó a ejercer ahí, la plaza quedó vacante — seguía contando como
-- una ocupación real y podía bloquear un reemplazo legítimo con
-- CRUCE_DISPONIBILIDAD, un falso conflicto. El chequeo hermano ("ya
-- designado vigente en ESTE MISMO rodeo") ya excluía 'rechazado' desde
-- 084/091 — nunca tuvo este problema; la inconsistencia estaba
-- exclusivamente en el chequeo de cruce con OTRO rodeo. Exactamente el
-- mismo hallazgo (punto 3) ya corregido para la creación con excepción en
-- 094/crear_asignacion_con_bitacora(), ahora extendido al reemplazo por
-- decisión explícita del usuario — "no aceptamos que una designación
-- rechazada bloquee indebidamente a un jurado en el procedimiento de
-- reemplazo".
--
-- ALCANCE DEL CAMBIO — ÚNICA línea nueva, dentro de la consulta
-- v_cruce_otro_rodeo: se agrega
--   AND COALESCE(a2.estado_designacion, 'pendiente') <> 'rechazado'
-- Ninguna otra condición, validación, bloqueo, mensaje de error, firma de
-- función, GRANT/REVOKE, ni ninguna otra línea del cuerpo cambia respecto
-- a la versión vigente (091). Las designaciones ANULADAS ya estaban
-- correctamente excluidas desde 084 (estado <> 'anulado') — no había
-- ningún "falso conflicto por anulada" que corregir ahí; el pedido de
-- "anuladas o rechazadas" queda igualmente satisfecho: anuladas ya lo
-- estaban, rechazadas se corrigen ahora.
--
-- PROTECCIONES EXISTENTES, TODAS preservadas intactas (ninguna se tocó):
--   - Advisory lock por jurado candidato (Decisión 13 de 084) — PRIMERA
--     operación de la función, sin cambios.
--   - Orden de locks {rodeos, luego asignaciones} (Decisión 9 de 084) —
--     sin cambios.
--   - PAGO_BASE_INCONSISTENTE_CON_DURACION (091, punto c) — verificación
--     de pago contra la duración vigente del rodeo, bajo lock — sin
--     cambios.
--   - Sincronización de duracion_dias_aplicada con la duración vigente
--     (091, punto 4) — sin cambios.
--   - CONFLICTO_DESIGNACION_MODIFICADA (concurrencia optimista, Decisión 4
--     de 084) — sin cambios.
--   - Motivo del catálogo obligatorio (MOTIVO_INVALIDO) — sin cambios.
--   - Antecedentes sensibles: ANTECEDENTE_SENSIBLE_NOTA/CARTILLA/BONO
--     (notas_rodeo, cartillas_jurado, bonos_solicitados aprobados/
--     modificados) — sin cambios, siguen bloqueando sin excepción.
--   - Compatibilidad con cartillas, evaluaciones (comision_evaluaciones_
--     jurado se desvincula automáticamente vía trigger de 079, nunca
--     bloquea aquí — sin cambios) y pagos (bonos pendientes/aprobado_auto
--     se desvinculan, nunca se borran — sin cambios).
--   - registrar_movimiento_designacion() (bitácora y trazabilidad) — se
--     sigue llamando con los mismos argumentos nombrados exactos; esta
--     migración no depende de si 094 ya está aplicada o no (la llamada por
--     nombre de parámetro es compatible con la firma de 14 O 15
--     parámetros indistintamente — ningún argumento nuevo se pasa aquí).
--
-- NO SE MODIFICAN NI ELIMINAN ASIGNACIONES HISTÓRICAS — este archivo solo
-- redefine una función (CREATE OR REPLACE); no contiene ningún UPDATE/
-- DELETE sobre datos. Cambia únicamente la interpretación, en tiempo de
-- evaluación, de qué cuenta como "ocupación real" al verificar un cruce.
--
-- SECURITY INVOKER (igual criterio que 084/091, sin cambios): el único rol
-- con EXECUTE sigue siendo service_role.
--
-- Misma firma exacta que 084/091 (12 parámetros) — CREATE OR REPLACE es un
-- reemplazo real, no una sobrecarga (a diferencia de 094, que sí necesitó
-- cambiar la cantidad de parámetros de registrar_movimiento_designacion()
-- y por eso requirió un DROP explícito antes).
--
-- Envuelta en una transacción explícita. Idempotente: CREATE OR REPLACE
-- FUNCTION es seguro de repetir. Reversible: ver bloque al final (restaura
-- el cuerpo exacto de 091 con un segundo CREATE OR REPLACE, sin DROP).
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

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
    p_operacion_id                         UUID DEFAULT NULL
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

    -- Decisión 13 (084) — PRIMERA operación de toda la función: advisory
    -- lock sobre el jurado candidato. Sin cambios.
    PERFORM pg_advisory_xact_lock(hashtextextended(p_usuario_pagado_id_nuevo::text, 0));

    -- Punto de serialización por rodeo (Decisión 9 de 084): se bloquea
    -- `rodeos` ANTES que la propia fila de `asignaciones`. Sin cambios.
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

    -- Bloqueo de concurrencia de la fila afectada (Decisión 4 de 084) — en
    -- ESTE orden ({rodeos, luego asignaciones}), nunca en el inverso. Sin cambios.
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

    -- Protección contra dos designaciones vigentes incompatibles.
    -- (a) Mismo rodeo — YA excluía 'rechazado' desde 084/091. Sin cambios.
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

    -- (b) Otro rodeo con fechas que se cruzan — ÚNICO CAMBIO REAL de esta
    -- migración: se agrega la exclusión de 'rechazado' (las anuladas ya
    -- estaban excluidas por `a2.estado <> 'anulado'`, sin cambios). Una
    -- designación rechazada en otro rodeo nunca representó una ocupación
    -- real del jurado — no debe poder bloquear este reemplazo.
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

    -- Única vía de escritura hacia la bitácora. Sin cambios — compatible
    -- con la firma de registrar_movimiento_designacion() de 14 (pre-094) o
    -- 15 parámetros (post-094), por llamada con parámetros nombrados.
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
        p_operacion_id               := p_operacion_id
    );

    RETURN jsonb_build_object(
        'asignacion', row_to_json(v_nueva),
        'bitacora_id', v_bitacora.id,
        'usuario_pagado_id_anterior', v_anterior.usuario_pagado_id,
        'nombre_anterior_snapshot', v_anterior.nombre_importado
    );
END;
$$;

-- Misma firma exacta (12 parámetros) — se repite el mismo REVOKE/GRANT que
-- 084/091, idempotente.
REVOKE ALL ON FUNCTION reemplazar_jurado_asignacion_con_bitacora(
    UUID, UUID, TEXT, INTEGER, INTEGER, UUID, UUID, TEXT, UUID, TEXT, TIMESTAMPTZ, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION reemplazar_jurado_asignacion_con_bitacora(
    UUID, UUID, TEXT, INTEGER, INTEGER, UUID, UUID, TEXT, UUID, TEXT, TIMESTAMPTZ, UUID
) TO service_role;

COMMENT ON FUNCTION reemplazar_jurado_asignacion_con_bitacora IS
    'Fase 1B + 091 + 095: único camino que conecta un cambio de jurado de una asignación con bitacora_designaciones, de forma atómica. Sincroniza duracion_dias_aplicada con la duración vigente del rodeo y rechaza (PAGO_BASE_INCONSISTENTE_CON_DURACION) un pago que no corresponda exactamente a esa duración. El chequeo de cruce con otro rodeo ya NO considera ocupación real una designación anulada o rechazada en ese otro rodeo (095) — solo asignaciones realmente vigentes bloquean. Bloquea si hay antecedentes sensibles, designación incompatible en el MISMO rodeo o cruce real de disponibilidad. Bonos pendientes/aprobado_auto se desvinculan, nunca bloquean.';

COMMIT;

-- Reversible:
--   Volver a aplicar el CREATE OR REPLACE de la migración 091 tal cual está
--   en su archivo original (restaura el chequeo de cruce sin la exclusión
--   de 'rechazado') — nunca hacer DROP de esta función: tiene llamadores
--   activos en producción (POST /api/admin/asignaciones/:id/reemplazar).
