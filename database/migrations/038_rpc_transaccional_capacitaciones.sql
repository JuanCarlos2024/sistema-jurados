-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 038 — ETAPA 2.3: Consistencia transaccional en capacitaciones
--
-- PROBLEMA RESUELTO:
--   Condición de carrera entre POST /responder y POST /finalizar:
--   (1) /finalizar lee N respuestas
--   (2) /responder (tardío) valida estado=en_curso y persiste la respuesta N+1
--   (3) /finalizar calcula el resultado con solo N respuestas
--   → La respuesta N+1 queda en la BD pero no fue incluida en la nota.
--
-- SOLUCIÓN:
--   Ambas funciones toman SELECT ... FOR UPDATE sobre la fila del intento.
--   Solo una puede ejecutarse a la vez. Si /finalizar gana primero, /responder
--   verá estado=completado y rechazará SIN persistir la respuesta.
--   Si /responder gana primero, inserta la respuesta y libera el lock; entonces
--   /finalizar la cuenta en su conteo.
--
-- GARANTÍAS:
--   · Una respuesta guardada SIEMPRE queda incluida en la nota.
--   · Una respuesta no incluida NUNCA queda persistida.
--   · Solo existe una consolidación final (idempotencia por estado).
--   · es_correcta NO se expone al frontend (prevenido en rpc_guardar_respuesta).
--
-- TOTAL DE PREGUNTAS:
--   rpc_finalizar_intento usa jsonb_array_length(orden_preguntas_json) cuando
--   disponible (snapshot del momento en que se inició el intento), lo que
--   hace el total estable ante cambios de admin posteriores al inicio.
--   Si orden_preguntas_json es NULL, usa COUNT actual como fallback.
--
-- PERMISOS:
--   REVOKE de PUBLIC (anon, authenticated) → GRANT solo a service_role (backend).
--
-- REVERSIÓN:
--   DROP FUNCTION IF EXISTS rpc_finalizar_intento(UUID, BOOLEAN);
--   DROP FUNCTION IF EXISTS rpc_guardar_respuesta(UUID, UUID, UUID);
--
-- IDEMPOTENTE: seguro ejecutar varias veces (CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- A. rpc_finalizar_intento
--    Bloquea la fila del intento con FOR UPDATE, cuenta respuestas dentro de la
--    misma transacción y escribe el resultado.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION rpc_finalizar_intento(
    p_intento_id UUID,
    p_por_tiempo BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_intento     RECORD;
    v_prueba_id   UUID;
    v_pmia        NUMERIC;
    v_nota_min    NUMERIC;
    v_nota_max    NUMERIC;
    v_nota_apro   NUMERIC;
    v_total       INTEGER;
    v_correctas   BIGINT;
    v_respondidas BIGINT;
    v_incorr      INTEGER;
    v_no_resp     INTEGER;
    v_puntaje     NUMERIC;
    v_nota        NUMERIC;
    v_aprobado    BOOLEAN;
    v_ahora       TIMESTAMPTZ;
BEGIN
    -- 1. Bloquear fila del intento — serializa con rpc_guardar_respuesta
    SELECT * INTO v_intento
    FROM   capacitacion_intentos
    WHERE  id = p_intento_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('codigo', 'NOT_FOUND', 'error', 'Intento no encontrado');
    END IF;

    -- 2. Idempotente: si ya está completado, devolver el resultado almacenado
    IF v_intento.estado = 'completado' THEN
        RETURN jsonb_build_object(
            'ya_completado',         TRUE,
            'estado',                v_intento.estado,
            'puntaje_obtenido',      v_intento.puntaje_obtenido,
            'nota',                  v_intento.nota,
            'aprobado',              v_intento.aprobado,
            'finalizado_en',         v_intento.finalizado_en,
            'finalizado_por_tiempo', v_intento.finalizado_por_tiempo
        );
    END IF;

    IF v_intento.estado != 'en_curso' THEN
        RETURN jsonb_build_object('codigo', 'ESTADO_INVALIDO', 'error', 'El intento no está en curso');
    END IF;

    -- 3. Obtener prueba_id y configuración de nota
    SELECT ca.prueba_id,
           COALESCE(cp.puntaje_minimo_aprobacion, 60),
           COALESCE(cp.nota_minima,     1.0),
           COALESCE(cp.nota_maxima,     7.0),
           COALESCE(cp.nota_aprobacion, 4.0)
    INTO   v_prueba_id, v_pmia, v_nota_min, v_nota_max, v_nota_apro
    FROM   capacitacion_asignaciones ca
    JOIN   capacitacion_pruebas      cp ON cp.id = ca.prueba_id
    WHERE  ca.id = v_intento.asignacion_id;

    -- 4. Total: snapshot del intento (estable ante cambios de admin posteriores)
    --    Fallback a COUNT si orden_preguntas_json no fue guardado aún.
    IF v_intento.orden_preguntas_json IS NOT NULL THEN
        v_total := jsonb_array_length(v_intento.orden_preguntas_json);
    ELSE
        SELECT COUNT(*) INTO v_total
        FROM   capacitacion_preguntas
        WHERE  prueba_id = v_prueba_id;
    END IF;

    -- 5. Contar respuestas DENTRO de la misma transacción (post-bloqueo).
    --    Ninguna otra respuesta puede insertarse mientras este lock está activo.
    SELECT COUNT(*) FILTER (WHERE es_correcta = TRUE),
           COUNT(*)
    INTO   v_correctas, v_respondidas
    FROM   capacitacion_respuestas
    WHERE  intento_id = p_intento_id;

    v_incorr  := CAST(v_respondidas AS INTEGER) - CAST(v_correctas AS INTEGER);
    v_no_resp := GREATEST(0, v_total - CAST(v_respondidas AS INTEGER));

    -- 6. Calcular puntaje (correctas / total * 100, 1 decimal)
    IF v_total > 0 THEN
        v_puntaje := ROUND((CAST(v_correctas AS NUMERIC) / v_total * 100)::NUMERIC, 1);
    ELSE
        v_puntaje := 0;
    END IF;

    -- 7. Calcular nota (escala chilena 1.0–7.0)
    IF v_pmia > 0 AND v_pmia < 100 THEN
        IF v_puntaje <= v_pmia THEN
            v_nota := v_nota_min + (v_puntaje / v_pmia) * (v_nota_apro - v_nota_min);
        ELSE
            v_nota := v_nota_apro + ((v_puntaje - v_pmia) / (100 - v_pmia)) * (v_nota_max - v_nota_apro);
        END IF;
        v_nota     := ROUND(v_nota::NUMERIC, 1);
        v_aprobado := v_nota >= v_nota_apro;
    ELSE
        v_nota     := NULL;
        v_aprobado := v_puntaje >= v_pmia;
    END IF;

    v_ahora := NOW();

    -- 8. Actualizar el intento (el lock garantiza que solo este proceso escribe)
    UPDATE capacitacion_intentos
    SET    estado                = 'completado',
           finalizado_en         = v_ahora,
           puntaje_obtenido      = v_puntaje,
           nota                  = v_nota,
           aprobado              = v_aprobado,
           finalizado_por_tiempo = CASE WHEN p_por_tiempo THEN TRUE
                                        ELSE finalizado_por_tiempo END
    WHERE  id     = p_intento_id
    AND    estado = 'en_curso';

    -- 9. Devolver resultado consolidado
    RETURN jsonb_build_object(
        'ya_completado',         FALSE,
        'estado',                'completado',
        'puntaje_obtenido',      v_puntaje,
        'nota',                  v_nota,
        'aprobado',              v_aprobado,
        'finalizado_en',         v_ahora,
        'finalizado_por_tiempo', p_por_tiempo,
        'correctas',             v_correctas,
        'incorrectas',           v_incorr,
        'no_respondidas',        v_no_resp,
        'total_preguntas',       v_total
    );
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- B. rpc_guardar_respuesta
--    Bloquea la fila del intento con FOR UPDATE ANTES del upsert.
--    Si /finalizar ya ganó el lock y marcó el intento como completado,
--    esta función devuelve INTENTO_FINALIZADO sin insertar la respuesta.
--    No expone es_correcta en la respuesta (seguridad).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION rpc_guardar_respuesta(
    p_intento_id     UUID,
    p_pregunta_id    UUID,
    p_alternativa_id UUID   -- NULL = pregunta sin respuesta / borrar selección
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_intento     RECORD;
    v_prueba_id   UUID;
    v_fecha_fin   TIMESTAMPTZ;
    v_alt         RECORD;
    v_es_correcta BOOLEAN;
    v_preg_ok     BOOLEAN;
    v_ya_existia  BOOLEAN;
    v_ahora       TIMESTAMPTZ;
BEGIN
    -- 1. Bloquear fila del intento — serializa con rpc_finalizar_intento
    SELECT * INTO v_intento
    FROM   capacitacion_intentos
    WHERE  id = p_intento_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('codigo', 'NOT_FOUND', 'error', 'Intento no encontrado');
    END IF;

    -- 2. Verificar estado
    IF v_intento.estado = 'completado' THEN
        RETURN jsonb_build_object('codigo', 'INTENTO_FINALIZADO',
            'error', 'Este intento ya fue finalizado', 'intento_id', p_intento_id);
    END IF;
    IF v_intento.estado != 'en_curso' THEN
        RETURN jsonb_build_object('codigo', 'ESTADO_INVALIDO',
            'error', 'El intento no está en curso');
    END IF;

    -- 3. Verificar vence_en (tiempo por intento)
    IF v_intento.vence_en IS NOT NULL AND NOW() > v_intento.vence_en THEN
        RETURN jsonb_build_object('codigo', 'TIEMPO_AGOTADO',
            'error', 'Tiempo expirado', 'intento_id', p_intento_id);
    END IF;

    -- 4. Obtener prueba_id y fecha_fin de la prueba
    SELECT ca.prueba_id, cp.fecha_fin
    INTO   v_prueba_id, v_fecha_fin
    FROM   capacitacion_asignaciones ca
    JOIN   capacitacion_pruebas      cp ON cp.id = ca.prueba_id
    WHERE  ca.id = v_intento.asignacion_id;

    -- 5. Verificar fecha de cierre general de la prueba
    IF v_fecha_fin IS NOT NULL AND NOW() > v_fecha_fin THEN
        RETURN jsonb_build_object('codigo', 'TIEMPO_AGOTADO',
            'error', 'El plazo de la prueba ha vencido', 'intento_id', p_intento_id);
    END IF;

    -- 6. Verificar que la pregunta pertenece a la prueba
    SELECT EXISTS(
        SELECT 1 FROM capacitacion_preguntas
        WHERE  id = p_pregunta_id AND prueba_id = v_prueba_id
    ) INTO v_preg_ok;
    IF NOT v_preg_ok THEN
        RETURN jsonb_build_object('codigo', 'PREGUNTA_INVALIDA',
            'error', 'La pregunta no pertenece a esta prueba');
    END IF;

    -- 7. Validar alternativa y obtener es_correcta (no se devuelve al frontend)
    IF p_alternativa_id IS NOT NULL THEN
        SELECT id, es_correcta, pregunta_id INTO v_alt
        FROM   capacitacion_alternativas
        WHERE  id = p_alternativa_id;

        IF NOT FOUND THEN
            RETURN jsonb_build_object('codigo', 'ALTERNATIVA_INVALIDA',
                'error', 'Alternativa no encontrada');
        END IF;
        IF v_alt.pregunta_id != p_pregunta_id THEN
            RETURN jsonb_build_object('codigo', 'ALTERNATIVA_INVALIDA',
                'error', 'La alternativa no corresponde a esta pregunta');
        END IF;
        v_es_correcta := v_alt.es_correcta;
    ELSE
        v_es_correcta := NULL;
    END IF;

    -- 8. Detectar si ya existía una respuesta (para indicar ya_existia al cliente)
    SELECT EXISTS(
        SELECT 1 FROM capacitacion_respuestas
        WHERE  intento_id = p_intento_id AND pregunta_id = p_pregunta_id
    ) INTO v_ya_existia;

    v_ahora := NOW();

    -- 9. Upsert atómico — se ejecuta SOLO si el intento sigue en_curso (pasos 1–7 OK)
    INSERT INTO capacitacion_respuestas
        (intento_id, pregunta_id, alternativa_id, es_correcta, respondida_en)
    VALUES
        (p_intento_id, p_pregunta_id, p_alternativa_id, v_es_correcta, v_ahora)
    ON CONFLICT (intento_id, pregunta_id)
    DO UPDATE SET
        alternativa_id = EXCLUDED.alternativa_id,
        es_correcta    = EXCLUDED.es_correcta,
        respondida_en  = EXCLUDED.respondida_en;

    -- 10. Devolver resultado SIN es_correcta (no exponer respuestas correctas)
    RETURN jsonb_build_object(
        'ok',             TRUE,
        'intento_id',     p_intento_id,
        'pregunta_id',    p_pregunta_id,
        'alternativa_id', p_alternativa_id,
        'respondida_en',  v_ahora,
        'ya_existia',     v_ya_existia,
        'guardada',       TRUE
    );
END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- C. Permisos
--    Revocar acceso de todos los roles (PUBLIC incluye anon y authenticated).
--    Otorgar solo al rol service_role (clave usada por el backend Node.js).
--    Impide que el frontend llame estas funciones directamente.
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION rpc_finalizar_intento(UUID, BOOLEAN)   FROM PUBLIC;
REVOKE ALL ON FUNCTION rpc_guardar_respuesta(UUID, UUID, UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION rpc_finalizar_intento(UUID, BOOLEAN)   TO service_role;
GRANT EXECUTE ON FUNCTION rpc_guardar_respuesta(UUID, UUID, UUID) TO service_role;

COMMIT;


-- ─────────────────────────────────────────────────────────────────────────────
-- Verificación
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    RAISE NOTICE 'rpc_finalizar_intento: %',
        (SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'rpc_finalizar_intento'));
    RAISE NOTICE 'rpc_guardar_respuesta: %',
        (SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'rpc_guardar_respuesta'));
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Reversión (ejecutar en caso de rollback manual):
--   DROP FUNCTION IF EXISTS rpc_finalizar_intento(UUID, BOOLEAN);
--   DROP FUNCTION IF EXISTS rpc_guardar_respuesta(UUID, UUID, UUID);
-- ─────────────────────────────────────────────────────────────────────────────
