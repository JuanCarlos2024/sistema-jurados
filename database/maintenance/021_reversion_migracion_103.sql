-- ═════════════════════════════════════════════════════════════════════════
-- 021: REVERSIÓN de la migración 103. NO EJECUTAR salvo decisión expresa.
--
-- NIVEL 1 — NO DESTRUCTIVO (devuelve el comportamiento previo a la 103):
--   · publicar_evaluacion vuelve EXACTAMENTE al cuerpo de producción previo
--     (md5 LF 896ff04c54abc50096f24e1070530efe). Sus privilegios NO vuelven
--     al estado previo: antes de la 103 era ejecutable por PUBLIC, anon y
--     authenticated (SECURITY DEFINER expuesta vía Data API). La reversión
--     mantiene EXECUTE SOLO para service_role, que es el único rol que usa el
--     backend (cliente con SUPABASE_SERVICE_KEY): compatible con b8e9c30 y
--     posteriores. Nunca se reabre ese acceso.
--   · Se quitan los 3 triggers de la 103.
--   · NO borra tablas, columnas, funciones ni datos nuevos: el backend previo
--     no los usa y quedan como historial. No toca notas ni evaluaciones.
--   Pensado para usarse con el backend PREVIO (b8e9c30) desplegado.
--
-- NIVEL 2 — LIMPIEZA (opcional, solo tras el nivel 1): elimina los objetos
--   de la 103. Se NIEGA a ejecutar si existe cualquier revisión, cierre
--   excepcional o decisión administrativa registrada (no destruye historial).
--
-- Tras cualquiera de los niveles, verificar con la consulta del final.
-- ═════════════════════════════════════════════════════════════════════════

-- ── NIVEL 1 ──────────────────────────────────────────────────────────────
BEGIN;

CREATE OR REPLACE FUNCTION public.publicar_evaluacion(
    p_evaluacion_id UUID,
    p_jefe_id       UUID,
    p_comentario    TEXT DEFAULT NULL,
    p_ip            TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

    IF EXISTS (
        SELECT 1 FROM evaluacion_casos
        WHERE evaluacion_id = p_evaluacion_id
          AND estado <> 'resuelto'
          AND (anulado IS FALSE OR anulado IS NULL)
    ) THEN
        RAISE EXCEPTION 'casos_pendientes: existen casos aún no resueltos, no se puede publicar';
    END IF;

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

    SELECT nota INTO v_nota_final
    FROM evaluacion_escala_puntaje_nota
    WHERE puntaje = v_puntaje_final AND activo = TRUE
    LIMIT 1;

    IF v_nota_final IS NULL THEN
        v_nota_final := 1.0;
    END IF;

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

    FOR v_asig IN
        SELECT
            a.id                 AS asignacion_id,
            up.categoria         AS categoria,
            a.usuario_pagado_id  AS usuario_pagado_id,
            COALESCE(up.nombre_completo, a.nombre_importado) AS nombre_evaluado
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
            fuente, puntaje_evaluacion, calificacion_cualitativa, evaluacion_id,
            usuario_pagado_id_evaluado_snapshot, nombre_evaluado_snapshot
        ) VALUES (
            v_asig.asignacion_id, v_nota_final, NULL,
            NOW(), NOW(), p_jefe_id::TEXT,
            'evaluacion_tecnica', v_puntaje_final, v_calificacion, p_evaluacion_id,
            v_asig.usuario_pagado_id, v_asig.nombre_evaluado
        )
        ON CONFLICT (asignacion_id) DO UPDATE SET
            nota                     = EXCLUDED.nota,
            evaluado_en              = EXCLUDED.evaluado_en,
            updated_at               = EXCLUDED.updated_at,
            updated_by               = EXCLUDED.updated_by,
            fuente                   = EXCLUDED.fuente,
            puntaje_evaluacion       = EXCLUDED.puntaje_evaluacion,
            calificacion_cualitativa = EXCLUDED.calificacion_cualitativa,
            evaluacion_id            = EXCLUDED.evaluacion_id,
            usuario_pagado_id_evaluado_snapshot = EXCLUDED.usuario_pagado_id_evaluado_snapshot,
            nombre_evaluado_snapshot            = EXCLUDED.nombre_evaluado_snapshot;

        v_jurados_count := v_jurados_count + 1;
    END LOOP;

    IF v_jurados_count = 0 THEN
        RAISE EXCEPTION 'sin_jurados: no se encontró ningún jurado activo para este rodeo, no se puede publicar';
    END IF;

    UPDATE evaluaciones SET
        estado         = 'publicado',
        nota_publicada = TRUE,
        updated_at     = NOW()
    WHERE id = p_evaluacion_id;

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
$$;

-- Privilegios: idénticos a los de la 103 (CREATE OR REPLACE ya los conserva;
-- se reafirman explícitamente). NUNCA se vuelve a otorgar a PUBLIC/anon/authenticated.
REVOKE ALL ON FUNCTION public.publicar_evaluacion(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publicar_evaluacion(UUID, UUID, TEXT, TEXT) TO service_role;

DROP TRIGGER IF EXISTS trg_proteger_caso_derivado_comision ON public.evaluacion_casos;
DROP TRIGGER IF EXISTS trg_proteger_alteracion_revisada   ON public.evaluaciones;
DROP TRIGGER IF EXISTS trg_proteger_revision_comision     ON public.evaluacion_revisiones_comision;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- ── NIVEL 2 (opcional) ───────────────────────────────────────────────────
-- BEGIN;
-- DO $$
-- BEGIN
--     IF EXISTS (SELECT 1 FROM public.evaluacion_revisiones_comision)
--        OR EXISTS (SELECT 1 FROM public.evaluacion_cierres_excepcionales)
--        OR EXISTS (SELECT 1 FROM public.evaluacion_casos
--                   WHERE decision_admin_excepcional IS NOT NULL OR cierre_excepcional_id IS NOT NULL) THEN
--         RAISE EXCEPTION 'REVERSION_NIVEL_2_RECHAZADA: existen datos de la 103; se conservan como historial';
--     END IF;
-- END $$;
-- DROP FUNCTION IF EXISTS public.cierre_excepcional_comision_admin(UUID, UUID, TEXT, JSONB);
-- DROP FUNCTION IF EXISTS public.resolver_caso_derivado_comision(UUID, TEXT, TEXT, UUID);
-- DROP FUNCTION IF EXISTS public.anular_revision_resultado_alterado(UUID, UUID, TEXT);
-- DROP FUNCTION IF EXISTS public.resolver_revision_resultado_alterado(UUID, TEXT, TEXT, UUID);
-- DROP FUNCTION IF EXISTS public.generar_revision_resultado_alterado(UUID, UUID, TEXT);
-- DROP FUNCTION IF EXISTS public._pendientes_comision_evaluacion(UUID);
-- DROP FUNCTION IF EXISTS public.fn_proteger_revision_comision();
-- DROP FUNCTION IF EXISTS public.fn_proteger_alteracion_revisada();
-- DROP FUNCTION IF EXISTS public.fn_proteger_caso_derivado_comision();
-- DROP FUNCTION IF EXISTS public._en_cierre_excepcional_admin();
-- ALTER TABLE public.evaluacion_casos DROP CONSTRAINT IF EXISTS chk_caso_decision_admin_excepcional;
-- ALTER TABLE public.evaluacion_casos
--     DROP COLUMN IF EXISTS cierre_excepcional_id, DROP COLUMN IF EXISTS motivo_admin_excepcional,
--     DROP COLUMN IF EXISTS admin_excepcional_en, DROP COLUMN IF EXISTS admin_excepcional_por,
--     DROP COLUMN IF EXISTS decision_admin_excepcional;
-- DROP TABLE IF EXISTS public.evaluacion_revisiones_comision;
-- DROP TABLE IF EXISTS public.evaluacion_cierres_excepcionales;
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;

-- ── VERIFICACIÓN tras la reversión (solo lectura) ───────────────────────
-- (Cada columna es un booleano no nulo; todas deben ser true.)
-- SELECT COALESCE(md5(replace(prosrc, E'\r\n', E'\n')) = '896ff04c54abc50096f24e1070530efe', false) AS publicar_igual_a_previa,
--        COALESCE(prosecdef AND proconfig = ARRAY['search_path=public'], false) AS publicar_security_definer_search_path,
--        COALESCE(has_function_privilege('service_role', oid, 'EXECUTE'), false) AS service_role_execute,
--        COALESCE(NOT has_function_privilege('public', oid, 'EXECUTE')
--                 AND NOT has_function_privilege('anon', oid, 'EXECUTE')
--                 AND NOT has_function_privilege('authenticated', oid, 'EXECUTE'), false) AS sin_execute_public_anon_authenticated,
--        (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('trg_proteger_caso_derivado_comision',
--            'trg_proteger_alteracion_revisada', 'trg_proteger_revision_comision')) = 0 AS sin_triggers_103
-- FROM pg_proc WHERE oid = 'public.publicar_evaluacion(uuid,uuid,text,text)'::regprocedure;
