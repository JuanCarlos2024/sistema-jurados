-- 100: Cambio de función Jurado <-> Delegado Rentado.
-- No crea una persona nueva ni reescribe designaciones, cartillas, notas o pagos históricos.
-- Registra el movimiento administrativo de forma atómica.
ALTER TABLE public.usuario_historial_cambios
    DROP CONSTRAINT IF EXISTS usuario_historial_cambios_tipo_cambio_check;
ALTER TABLE public.usuario_historial_cambios
    ADD CONSTRAINT usuario_historial_cambios_tipo_cambio_check
    CHECK (tipo_cambio IN ('estado', 'categoria', 'suspension', 'no_certificado',
                          'en_retiro', 'asociacion', 'tipo_persona'));

CREATE OR REPLACE FUNCTION public.cambiar_tipo_persona_usuario_con_historial(
    p_usuario_id UUID,
    p_tipo_nuevo TEXT,
    p_categoria_nueva TEXT,
    p_actor_id UUID,
    p_actor_nombre TEXT,
    p_motivo TEXT
) RETURNS public.usuarios_pagados
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_anterior public.usuarios_pagados%ROWTYPE;
    v_actual public.usuarios_pagados%ROWTYPE;
BEGIN
    IF p_tipo_nuevo NOT IN ('jurado', 'delegado_rentado') OR p_tipo_nuevo IS NULL THEN
        RAISE EXCEPTION 'TIPO_PERSONA_INVALIDO';
    END IF;
    IF NULLIF(btrim(p_motivo), '') IS NULL THEN
        RAISE EXCEPTION 'MOTIVO_REQUERIDO';
    END IF;
    IF p_tipo_nuevo = 'jurado' AND (p_categoria_nueva IS NULL OR p_categoria_nueva NOT IN ('A', 'B', 'C')) THEN
        RAISE EXCEPTION 'CATEGORIA_INVALIDA';
    END IF;

    SELECT * INTO v_anterior
    FROM public.usuarios_pagados
    WHERE id = p_usuario_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'USUARIO_INEXISTENTE';
    END IF;
    IF v_anterior.tipo_persona = p_tipo_nuevo THEN
        RAISE EXCEPTION 'TIPO_PERSONA_SIN_CAMBIOS';
    END IF;

    -- No convertir el perfil si conserva designaciones futuras o vigentes.
    -- Las designaciones PASADAS se mantienen intactas con su tipo_persona,
    -- categoria_aplicada y pago_base_calculado originales.
    IF EXISTS (
        SELECT 1
        FROM public.asignaciones a
        INNER JOIN public.rodeos r ON r.id = a.rodeo_id
        WHERE a.usuario_pagado_id = p_usuario_id
          AND a.estado = 'activo'
          AND a.estado_designacion IS DISTINCT FROM 'rechazado'
          AND r.estado = 'activo'
          AND r.fecha::date + (GREATEST(COALESCE(r.duracion_dias, 1), 1) - 1) >= CURRENT_DATE
    ) THEN
        RAISE EXCEPTION 'DESIGNACIONES_VIGENTES_O_FUTURAS';
    END IF;

    UPDATE public.usuarios_pagados
    SET tipo_persona = p_tipo_nuevo,
        categoria = CASE WHEN p_tipo_nuevo = 'jurado' THEN p_categoria_nueva ELSE NULL END,
        updated_at = now()
    WHERE id = p_usuario_id
    RETURNING * INTO v_actual;

    INSERT INTO public.usuario_historial_cambios (
        usuario_pagado_id, tipo_cambio, valor_anterior, valor_nuevo,
        cambiado_por, cambiado_por_nombre, observacion, fecha_efectiva
    ) VALUES (
        p_usuario_id, 'tipo_persona', v_anterior.tipo_persona, p_tipo_nuevo,
        p_actor_id, p_actor_nombre,
        btrim(p_motivo) || CASE
            WHEN v_anterior.categoria IS NOT NULL THEN ' (Categoría anterior: ' || v_anterior.categoria || ')'
            ELSE '' END,
        CURRENT_DATE
    );

    RETURN v_actual;
END;
$$;

-- Solo el backend (SUPABASE_SERVICE_KEY / service_role) debe invocarla;
-- el control de administrador/Jefe Deportivo se valida en Express.
REVOKE ALL ON FUNCTION public.cambiar_tipo_persona_usuario_con_historial(
    UUID, TEXT, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cambiar_tipo_persona_usuario_con_historial(
    UUID, TEXT, TEXT, UUID, TEXT, TEXT
) TO service_role;
