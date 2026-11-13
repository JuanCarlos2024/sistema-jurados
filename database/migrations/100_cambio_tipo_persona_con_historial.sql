-- ═════════════════════════════════════════════════════════════════════════
-- 100: Cambio de función Jurado <-> Delegado Rentado, con historial atómico.
--
-- Caso que la origina: ROBERTO RIVAS GONZALEZ (USR-0300), Jurado C que pasa
-- a desempeñarse como Delegado Rentado. Hasta ahora no existía forma de
-- cambiar usuarios_pagados.tipo_persona sin crear una cuenta nueva.
--
-- Qué hace:
--   A. Amplía el CHECK de usuario_historial_cambios.tipo_cambio con
--      'tipo_persona' (conserva TODOS los valores vigentes en producción,
--      incluido 'asociacion' de la migración 089).
--   B. RPC cambiar_tipo_persona_usuario_con_historial: en UNA transacción
--      bloquea la fila del usuario, valida, actualiza tipo_persona/categoria
--      y registra el movimiento en usuario_historial_cambios.
--
-- Qué NO hace (preservación histórica):
--   - Nunca modifica asignaciones, rodeos, notas_rodeo, evaluaciones,
--     cartillas_jurado, cartillas_delegado, bonos ni pagos. Cada designación
--     conserva su propio tipo_persona, categoria_aplicada y
--     pago_base_calculado (snapshot tomado al designar).
--   - Nunca crea una persona nueva: mismo id, codigo_interno, RUT,
--     contraseña e historial.
--
-- Bloqueos (la persona debe regularizarse antes del cambio):
--   - Designaciones vigentes o futuras: asignación activa, no rechazada, de
--     un rodeo no anulado cuyo último día es >= hoy (hora de Chile).
--   - Cartillas pendientes de la función que deja:
--       Jurado -> DR: cartillas_jurado actuales en borrador/reabierta.
--       DR -> Jurado: cartillas_delegado propias en borrador/observada/
--       reabierta (requieren acción del delegado).
--     Tras el cambio el portal ya no le permitiría completarlas.
--
-- Seguridad: SECURITY INVOKER, search_path fijo, EXECUTE solo service_role
-- (el backend valida administrador pleno / Jefe Deportivo).
-- Idempotente: puede re-ejecutarse sin efectos adicionales.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- A) Historial: nuevo tipo de cambio
ALTER TABLE public.usuario_historial_cambios
    DROP CONSTRAINT IF EXISTS usuario_historial_cambios_tipo_cambio_check;
ALTER TABLE public.usuario_historial_cambios
    ADD CONSTRAINT usuario_historial_cambios_tipo_cambio_check
    CHECK (tipo_cambio IN ('estado', 'categoria', 'suspension', 'no_certificado',
                           'en_retiro', 'asociacion', 'tipo_persona'));

-- B) RPC transaccional
CREATE OR REPLACE FUNCTION public.cambiar_tipo_persona_usuario_con_historial(
    p_usuario_id      UUID,
    p_tipo_nuevo      TEXT,
    p_categoria_nueva TEXT,
    p_actor_id        UUID,
    p_actor_nombre    TEXT,
    p_motivo          TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_anterior   public.usuarios_pagados%ROWTYPE;
    v_actual     public.usuarios_pagados%ROWTYPE;
    v_hoy        DATE := (now() AT TIME ZONE 'America/Santiago')::date;
    v_motivo     TEXT := NULLIF(btrim(COALESCE(p_motivo, '')), '');
    v_cat_ant    TEXT;
    v_cat_nueva  TEXT;
    v_bloqueos   INTEGER;
BEGIN
    IF p_actor_id IS NULL THEN RAISE EXCEPTION 'ACTOR_REQUERIDO'; END IF;
    IF p_tipo_nuevo IS NULL OR p_tipo_nuevo NOT IN ('jurado', 'delegado_rentado') THEN
        RAISE EXCEPTION 'TIPO_PERSONA_INVALIDO';
    END IF;
    IF v_motivo IS NULL THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;
    IF length(v_motivo) > 1000 THEN RAISE EXCEPTION 'MOTIVO_DEMASIADO_LARGO'; END IF;
    IF p_tipo_nuevo = 'jurado' AND (p_categoria_nueva IS NULL OR p_categoria_nueva NOT IN ('A', 'B', 'C')) THEN
        RAISE EXCEPTION 'CATEGORIA_INVALIDA';
    END IF;
    IF p_tipo_nuevo = 'delegado_rentado' AND p_categoria_nueva IS NOT NULL THEN
        RAISE EXCEPTION 'CATEGORIA_INVALIDA';
    END IF;

    -- Serializa cambios concurrentes sobre la misma persona.
    SELECT * INTO v_anterior FROM public.usuarios_pagados WHERE id = p_usuario_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'USUARIO_INEXISTENTE'; END IF;
    IF v_anterior.tipo_persona = p_tipo_nuevo THEN RAISE EXCEPTION 'TIPO_PERSONA_SIN_CAMBIOS'; END IF;

    SELECT count(*) INTO v_bloqueos
    FROM public.asignaciones a
    JOIN public.rodeos r ON r.id = a.rodeo_id
    WHERE a.usuario_pagado_id = p_usuario_id
      AND a.estado = 'activo'
      AND a.estado_designacion IS DISTINCT FROM 'rechazado'
      AND r.estado IS DISTINCT FROM 'anulado'
      AND (r.fecha::date + (GREATEST(COALESCE(r.duracion_dias, 1), 1) - 1)) >= v_hoy;
    IF v_bloqueos > 0 THEN
        RAISE EXCEPTION 'DESIGNACIONES_VIGENTES_O_FUTURAS: %', v_bloqueos;
    END IF;

    IF v_anterior.tipo_persona = 'jurado' THEN
        SELECT count(*) INTO v_bloqueos FROM public.cartillas_jurado
        WHERE usuario_pagado_id = p_usuario_id
          AND es_actual IS TRUE
          AND estado IN ('borrador', 'reabierta');
    ELSE
        SELECT count(*) INTO v_bloqueos FROM public.cartillas_delegado
        WHERE delegado_id = p_usuario_id
          AND estado IN ('borrador', 'observada', 'reabierta');
    END IF;
    IF v_bloqueos > 0 THEN
        RAISE EXCEPTION 'CARTILLAS_PENDIENTES: %', v_bloqueos;
    END IF;

    v_cat_ant   := CASE WHEN v_anterior.tipo_persona = 'delegado_rentado' THEN 'DR' ELSE v_anterior.categoria END;
    v_cat_nueva := CASE WHEN p_tipo_nuevo = 'jurado' THEN p_categoria_nueva ELSE 'DR' END;

    UPDATE public.usuarios_pagados
    SET tipo_persona = p_tipo_nuevo,
        categoria    = CASE WHEN p_tipo_nuevo = 'jurado' THEN p_categoria_nueva ELSE NULL END,
        updated_at   = now()
    WHERE id = p_usuario_id
    RETURNING * INTO v_actual;

    -- Movimiento principal (Historial Administrativo de la Hoja de Vida).
    INSERT INTO public.usuario_historial_cambios (
        usuario_pagado_id, tipo_cambio, valor_anterior, valor_nuevo,
        cambiado_por, cambiado_por_nombre, observacion, fecha_efectiva
    ) VALUES (
        p_usuario_id, 'tipo_persona', v_anterior.tipo_persona, p_tipo_nuevo,
        p_actor_id, p_actor_nombre, v_motivo, v_hoy
    );

    -- Movimiento de categoría asociado (misma convención que
    -- asignaciones.categoria_aplicada: 'DR' para Delegado Rentado).
    INSERT INTO public.usuario_historial_cambios (
        usuario_pagado_id, tipo_cambio, valor_anterior, valor_nuevo,
        cambiado_por, cambiado_por_nombre, observacion, fecha_efectiva
    ) VALUES (
        p_usuario_id, 'categoria', v_cat_ant, v_cat_nueva,
        p_actor_id, p_actor_nombre,
        'Por cambio de función: ' || v_motivo, v_hoy
    );

    RETURN jsonb_build_object(
        'usuario', jsonb_build_object(
            'id', v_actual.id,
            'codigo_interno', v_actual.codigo_interno,
            'nombre_completo', v_actual.nombre_completo,
            'tipo_persona', v_actual.tipo_persona,
            'categoria', v_actual.categoria
        ),
        'tipo_anterior', v_anterior.tipo_persona,
        'categoria_anterior', v_anterior.categoria,
        'fecha_efectiva', v_hoy
    );
END;
$$;

COMMENT ON FUNCTION public.cambiar_tipo_persona_usuario_con_historial(UUID, TEXT, TEXT, UUID, TEXT, TEXT) IS
    'Migración 100: cambia la función (jurado <-> delegado_rentado) de una persona existente y registra el movimiento en usuario_historial_cambios en la misma transacción. Bloquea si hay designaciones vigentes/futuras o cartillas pendientes de la función que deja. Nunca modifica designaciones, cartillas, notas ni pagos históricos.';

REVOKE ALL ON FUNCTION public.cambiar_tipo_persona_usuario_con_historial(UUID, TEXT, TEXT, UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cambiar_tipo_persona_usuario_con_historial(UUID, TEXT, TEXT, UUID, TEXT, TEXT)
    TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
