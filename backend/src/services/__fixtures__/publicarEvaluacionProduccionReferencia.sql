CREATE OR REPLACE FUNCTION public.publicar_evaluacion(p_evaluacion_id uuid, p_jefe_id uuid, p_comentario text DEFAULT NULL::text, p_ip text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_eval              evaluaciones%ROWTYPE;
    v_puntaje_base      INTEGER;
    v_descuentos        INTEGER;
    v_puntaje_final     INTEGER;
    v_nota_final        NUMERIC(4,2);
    v_asig              RECORD;
    v_nota_existente    notas_rodeo%ROWTYPE;
    v_calificacion      TEXT;
    v_sobreescrituras   JSONB    := '[]'::JSONB;
    v_jurados_count     INTEGER  := 0;
    v_ip_inet           INET;
BEGIN
    BEGIN
        v_ip_inet := NULLIF(TRIM(p_ip), '')::INET;
    EXCEPTION WHEN OTHERS THEN
        v_ip_inet := NULL;
    END;

    -- 1. Leer y validar evaluación
    SELECT * INTO v_eval
    FROM evaluaciones
    WHERE id = p_evaluacion_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'evaluacion_no_encontrada: %', p_evaluacion_id;
    END IF;

    IF v_eval.estado <> 'pendiente_aprobacion' THEN
        RAISE EXCEPTION 'estado_invalido: se requiere pendiente_aprobacion, estado actual: %', v_eval.estado;
    END IF;

    -- 2. Verificar casos sin resolver (excluye anulados)
    IF EXISTS (
        SELECT 1 FROM evaluacion_casos
        WHERE evaluacion_id = p_evaluacion_id
          AND estado <> 'resuelto'
          AND (anulado IS FALSE OR anulado IS NULL)
    ) THEN
        RAISE EXCEPTION 'casos_pendientes: existen casos aún no resueltos, no se puede publicar';
    END IF;

    -- 3. Calcular puntaje final (excluye anulados)
    v_puntaje_base := v_eval.puntaje_base;

    SELECT COALESCE(SUM(descuento_puntos), 0) INTO v_descuentos
    FROM evaluacion_casos
    WHERE evaluacion_id = p_evaluacion_id
      AND (anulado IS FALSE OR anulado IS NULL)
      AND resolucion_final IN (
          'interpretativa_confirmada',
          'reglamentaria_confirmada',
          'apelacion_rechazada'
      );

    v_puntaje_final := GREATEST(0, LEAST(v_puntaje_base, v_puntaje_base - v_descuentos));

    -- 4. Convertir puntaje → nota (desde tabla configurable)
    SELECT nota INTO v_nota_final
    FROM evaluacion_escala_puntaje_nota
    WHERE puntaje = v_puntaje_final AND activo = TRUE
    LIMIT 1;

    IF v_nota_final IS NULL THEN
        v_nota_final := 1.0;
    END IF;

    -- 5. Marcar evaluación como aprobada
    UPDATE evaluaciones SET
        estado              = 'aprobado',
        puntaje_final       = v_puntaje_final,
        nota_final          = v_nota_final,
        decision_jefe       = 'aprobado',
        comentario_jefe     = p_comentario,
        fecha_decision_jefe = NOW(),
        jefe_id             = p_jefe_id,
        updated_at          = NOW()
    WHERE id = p_evaluacion_id;

    -- 6. UPSERT en notas_rodeo por cada jurado del rodeo
    FOR v_asig IN
        SELECT
            a.id         AS asignacion_id,
            up.categoria AS categoria
        FROM asignaciones a
        JOIN usuarios_pagados up ON up.id = a.usuario_pagado_id
        WHERE a.rodeo_id              = v_eval.rodeo_id
          AND a.estado                = 'activo'
          AND a.estado_designacion IS DISTINCT FROM 'rechazado'
          AND up.tipo_persona         = 'jurado'
    LOOP
        IF v_asig.categoria IS NULL THEN
            v_calificacion := NULL;
        ELSE
            SELECT calificacion INTO v_calificacion
            FROM evaluacion_escala_calificacion
            WHERE categoria    = v_asig.categoria
              AND activo       = TRUE
              AND v_nota_final >= nota_min
              AND v_nota_final <= nota_max
            LIMIT 1;
        END IF;

        SELECT * INTO v_nota_existente
        FROM notas_rodeo
        WHERE asignacion_id = v_asig.asignacion_id;

        IF FOUND AND v_nota_existente.fuente = 'manual' THEN
            v_sobreescrituras := v_sobreescrituras || jsonb_build_object(
                'asignacion_id',        v_asig.asignacion_id,
                'nota_manual_anterior', v_nota_existente.nota,
                'comentario_anterior',  v_nota_existente.comentario
            );
            INSERT INTO evaluacion_auditoria (
                evaluacion_id, accion, detalle, actor_id, actor_tipo, ip_address
            ) VALUES (
                p_evaluacion_id,
                'sobreescritura_nota_manual',
                jsonb_build_object(
                    'asignacion_id',        v_asig.asignacion_id,
                    'nota_manual_anterior', v_nota_existente.nota,
                    'comentario_anterior',  v_nota_existente.comentario,
                    'nota_tecnica_nueva',   v_nota_final,
                    'puntaje_final',        v_puntaje_final
                ),
                p_jefe_id, 'administrador', v_ip_inet
            );
        END IF;

        INSERT INTO notas_rodeo (
            asignacion_id, nota, comentario, evaluado_en, updated_at, updated_by,
            fuente, puntaje_evaluacion, calificacion_cualitativa, evaluacion_id
        ) VALUES (
            v_asig.asignacion_id, v_nota_final, NULL,
            NOW(), NOW(), p_jefe_id::TEXT,
            'evaluacion_tecnica', v_puntaje_final, v_calificacion, p_evaluacion_id
        )
        ON CONFLICT (asignacion_id) DO UPDATE SET
            nota                     = EXCLUDED.nota,
            evaluado_en              = EXCLUDED.evaluado_en,
            updated_at               = EXCLUDED.updated_at,
            updated_by               = EXCLUDED.updated_by,
            fuente                   = EXCLUDED.fuente,
            puntaje_evaluacion       = EXCLUDED.puntaje_evaluacion,
            calificacion_cualitativa = EXCLUDED.calificacion_cualitativa,
            evaluacion_id            = EXCLUDED.evaluacion_id;

        v_jurados_count := v_jurados_count + 1;
    END LOOP;

    -- 7. Validar que haya al menos un jurado
    IF v_jurados_count = 0 THEN
        RAISE EXCEPTION 'sin_jurados: no se encontró ningún jurado activo para este rodeo, no se puede publicar';
    END IF;

    -- 8. Marcar como publicado
    UPDATE evaluaciones SET
        estado         = 'publicado',
        nota_publicada = TRUE,
        updated_at     = NOW()
    WHERE id = p_evaluacion_id;

    -- 9. Auditoría
    INSERT INTO evaluacion_auditoria (
        evaluacion_id, accion, detalle, actor_id, actor_tipo, ip_address
    ) VALUES (
        p_evaluacion_id,
        'publicar_nota',
        jsonb_build_object(
            'puntaje_final',               v_puntaje_final,
            'nota_final',                  v_nota_final,
            'jurados_afectados',           v_jurados_count,
            'sobreescrituras_nota_manual', v_sobreescrituras
        ),
        p_jefe_id, 'administrador', v_ip_inet
    );

    RETURN jsonb_build_object(
        'ok',                          TRUE,
        'puntaje_final',               v_puntaje_final,
        'nota_final',                  v_nota_final,
        'jurados_afectados',           v_jurados_count,
        'sobreescrituras_nota_manual', v_sobreescrituras
    );

EXCEPTION WHEN OTHERS THEN
    RAISE;
END;
$function$
