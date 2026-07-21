-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 039 — ETAPA 4: Recálculo automático tras anulación / cambio de correcta
--
-- CONTENIDO:
--   A. Tablas de auditoría: capacitacion_recalculos + capacitacion_recalculos_detalle
--   B. Función compartida _cap_calc_resumen — ÚNICA fuente de cálculo
--   C. rpc_finalizar_intento ACTUALIZADA — usa _cap_calc_resumen, filtra anuladas
--   D. rpc_recalcular_intentos_capacitacion — nueva RPC administrativa transaccional
--   E. Índice GIN en orden_preguntas_json para búsquedas eficientes
--   F. Permisos (REVOKE PUBLIC / GRANT service_role)
--
-- REGLAS DE NEGOCIO:
--   · Pregunta anulada → excluida del total, puntaje, nota. No se regala como correcta.
--   · Cambiar alternativa correcta → se desmarca TODAS las de la pregunta, se marca la nueva.
--   · capacitacion_respuestas.es_correcta se sincroniza en el mismo instante (Estrategia A).
--   · Intentos en_curso bloquean el cambio (se debe esperar a que finalicen).
--   · SIN_PREGUNTAS_VALIDAS: si el total válido del intento llega a 0, no se calcula nota.
--   · nota_manual nunca se sobrescribe; solo se actualiza puntaje_obtenido/nota/aprobado.
--
-- IDEMPOTENTE: seguro ejecutar varias veces (CREATE OR REPLACE / IF NOT EXISTS).
-- APLICAR en: Supabase → SQL Editor
--
-- REVERSIÓN:
--   DROP FUNCTION IF EXISTS rpc_recalcular_intentos_capacitacion(UUID,UUID,TEXT,UUID,TEXT,UUID);
--   DROP FUNCTION IF EXISTS _cap_calc_resumen(UUID,JSONB,UUID,NUMERIC,NUMERIC,NUMERIC,NUMERIC);
--   DROP TABLE  IF EXISTS capacitacion_recalculos_detalle;
--   DROP TABLE  IF EXISTS capacitacion_recalculos;
--   (Luego restaurar rpc_finalizar_intento de la migración 038.)
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- A. Tablas de auditoría
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS capacitacion_recalculos (
    id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    prueba_id            UUID         NOT NULL,
    pregunta_id          UUID         NOT NULL,
    tipo_cambio          TEXT         NOT NULL
                             CHECK (tipo_cambio IN ('anular','reactivar','cambiar_correcta')),
    anulada_anterior     BOOLEAN,
    anulada_nueva        BOOLEAN,
    alt_correcta_ant     UUID,        -- solo para cambiar_correcta
    alt_correcta_nva     UUID,        -- solo para cambiar_correcta
    admin_id             UUID         NOT NULL,
    motivo               TEXT         NOT NULL,
    intentos_afectados   INTEGER      NOT NULL DEFAULT 0,
    resultado            TEXT         NOT NULL DEFAULT 'pendiente',
    error_resumen        TEXT,
    creado_en            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS capacitacion_recalculos_detalle (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    recalculo_id     UUID        NOT NULL
                         REFERENCES capacitacion_recalculos(id) ON DELETE CASCADE,
    intento_id       UUID        NOT NULL,
    puntaje_ant      NUMERIC(5,1),
    puntaje_nvo      NUMERIC(5,1),
    nota_ant         NUMERIC(4,1),
    nota_nva         NUMERIC(4,1),
    aprobado_ant     BOOLEAN,
    aprobado_nvo     BOOLEAN,
    total_valido_ant INTEGER,
    total_valido_nvo INTEGER,
    correctas_ant    INTEGER,
    correctas_nvo    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cap_recalculos_prueba
    ON capacitacion_recalculos(prueba_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_cap_recalculos_pregunta
    ON capacitacion_recalculos(pregunta_id);
CREATE INDEX IF NOT EXISTS idx_cap_recalculos_detalle_recalculo
    ON capacitacion_recalculos_detalle(recalculo_id);
CREATE INDEX IF NOT EXISTS idx_cap_recalculos_detalle_intento
    ON capacitacion_recalculos_detalle(intento_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- E. Índice GIN para containment queries sobre el snapshot (orden eficiente)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_cap_intentos_snapshot_gin
    ON capacitacion_intentos USING gin (orden_preguntas_json)
    WHERE orden_preguntas_json IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- B. Función compartida _cap_calc_resumen
--    ÚNICA fuente de cálculo de puntaje/nota para esta prueba.
--    Ambas RPC (finalizar y recalcular) la invocan.
--    No modifica datos. Solo lee y devuelve un registro.
--
--    Parámetros:
--      p_intento_id — intento a calcular
--      p_snapshot   — orden_preguntas_json del intento (NULL = usar preguntas actuales)
--      p_prueba_id  — necesario cuando p_snapshot IS NULL
--      p_pmia       — puntaje_minimo_aprobacion
--      p_nota_min/max/apro — configuración de nota
--
--    Devuelve exactamente una fila con todos los valores calculados.
--    Si total_valido = 0 → codigo_error = 'SIN_PREGUNTAS_VALIDAS'; nota = NULL.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _cap_calc_resumen(
    p_intento_id UUID,
    p_snapshot   JSONB,
    p_prueba_id  UUID,
    p_pmia       NUMERIC,
    p_nota_min   NUMERIC,
    p_nota_max   NUMERIC,
    p_nota_apro  NUMERIC
)
RETURNS TABLE(
    total_snapshot INTEGER,
    total_anuladas INTEGER,
    total_valido   INTEGER,
    correctas      BIGINT,
    incorrectas    BIGINT,
    omitidas       INTEGER,
    puntaje        NUMERIC,
    nota           NUMERIC,
    aprobado       BOOLEAN,
    codigo_error   TEXT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_snap_ids   UUID[];
    v_valid_ids  UUID[];
    v_total_snap INTEGER := 0;
    v_total_val  INTEGER := 0;
    v_correctas  BIGINT  := 0;
    v_respond    BIGINT  := 0;
    v_incorrec   BIGINT  := 0;
    v_omitidas   INTEGER := 0;
    v_puntaje    NUMERIC := 0;
    v_nota       NUMERIC;
    v_aprobado   BOOLEAN;
BEGIN
    IF p_snapshot IS NOT NULL THEN
        -- Extraer IDs del snapshot
        SELECT array_agg(t.elem::UUID)
        INTO   v_snap_ids
        FROM   jsonb_array_elements_text(p_snapshot) AS t(elem);

        v_total_snap := COALESCE(array_length(v_snap_ids, 1), 0);

        -- Preguntas del snapshot que NO están anuladas (estado actual)
        SELECT array_agg(cp.id)
        INTO   v_valid_ids
        FROM   capacitacion_preguntas cp
        WHERE  cp.id      = ANY(v_snap_ids)
        AND    cp.anulada = FALSE;
    ELSE
        -- Sin snapshot: usar todas las preguntas actuales no anuladas de la prueba
        SELECT array_agg(cp.id)
        INTO   v_valid_ids
        FROM   capacitacion_preguntas cp
        WHERE  cp.prueba_id = p_prueba_id
        AND    cp.anulada   = FALSE;

        v_total_snap := COALESCE(array_length(v_valid_ids, 1), 0);
    END IF;

    v_total_val := COALESCE(array_length(v_valid_ids, 1), 0);

    -- Caso especial: sin preguntas válidas → no calcular nota
    IF v_total_val = 0 THEN
        RETURN QUERY SELECT
            v_total_snap,
            v_total_snap,   -- todos los del snapshot eran anulados (o no había)
            0::INTEGER,
            0::BIGINT,
            0::BIGINT,
            0::INTEGER,
            0::NUMERIC,
            NULL::NUMERIC,
            FALSE,
            'SIN_PREGUNTAS_VALIDAS'::TEXT;
        RETURN;
    END IF;

    -- Contar respuestas de este intento, filtradas a preguntas válidas
    SELECT COUNT(*) FILTER (WHERE cr.es_correcta = TRUE),
           COUNT(*)
    INTO   v_correctas, v_respond
    FROM   capacitacion_respuestas cr
    WHERE  cr.intento_id  = p_intento_id
    AND    cr.pregunta_id = ANY(v_valid_ids);

    v_incorrec := v_respond - v_correctas;
    v_omitidas := GREATEST(0, v_total_val - CAST(v_respond AS INTEGER));

    -- Puntaje (correctas / total_válido * 100, 1 decimal)
    v_puntaje := ROUND((CAST(v_correctas AS NUMERIC) / v_total_val * 100)::NUMERIC, 1);

    -- Nota (escala chilena 1.0–7.0)
    IF p_pmia > 0 AND p_pmia < 100 THEN
        IF v_puntaje <= p_pmia THEN
            v_nota := p_nota_min + (v_puntaje / p_pmia) * (p_nota_apro - p_nota_min);
        ELSE
            v_nota := p_nota_apro + ((v_puntaje - p_pmia) / (100 - p_pmia))
                      * (p_nota_max - p_nota_apro);
        END IF;
        v_nota     := ROUND(v_nota::NUMERIC, 1);
        v_aprobado := v_nota >= p_nota_apro;
    ELSE
        v_nota     := NULL;
        v_aprobado := v_puntaje >= p_pmia;
    END IF;

    RETURN QUERY SELECT
        v_total_snap,
        (v_total_snap - v_total_val),
        v_total_val,
        v_correctas,
        v_incorrec,
        v_omitidas,
        v_puntaje,
        v_nota,
        v_aprobado,
        NULL::TEXT;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- C. rpc_finalizar_intento — ACTUALIZADA
--    Usa _cap_calc_resumen para filtrar anuladas.
--    Misma semántica que migración 038 (FOR UPDATE, idempotente).
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
    v_intento   RECORD;
    v_prueba_id UUID;
    v_pmia      NUMERIC;
    v_nota_min  NUMERIC;
    v_nota_max  NUMERIC;
    v_nota_apro NUMERIC;
    v_calc      RECORD;
    v_ahora     TIMESTAMPTZ;
BEGIN
    -- 1. Bloquear fila (serializa con rpc_guardar_respuesta)
    SELECT * INTO v_intento
    FROM   capacitacion_intentos
    WHERE  id = p_intento_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('codigo', 'NOT_FOUND', 'error', 'Intento no encontrado');
    END IF;

    -- 2. Idempotente: si ya está completado, devolver resultado almacenado
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
        RETURN jsonb_build_object('codigo', 'ESTADO_INVALIDO',
            'error', 'El intento no está en curso');
    END IF;

    -- 3. Configuración de nota
    SELECT ca.prueba_id,
           COALESCE(cp.puntaje_minimo_aprobacion, 60),
           COALESCE(cp.nota_minima,     1.0),
           COALESCE(cp.nota_maxima,     7.0),
           COALESCE(cp.nota_aprobacion, 4.0)
    INTO   v_prueba_id, v_pmia, v_nota_min, v_nota_max, v_nota_apro
    FROM   capacitacion_asignaciones ca
    JOIN   capacitacion_pruebas      cp ON cp.id = ca.prueba_id
    WHERE  ca.id = v_intento.asignacion_id;

    -- 4. Calcular con función compartida (filtra anuladas del snapshot)
    SELECT * INTO v_calc
    FROM _cap_calc_resumen(
        p_intento_id,
        v_intento.orden_preguntas_json,
        v_prueba_id,
        v_pmia, v_nota_min, v_nota_max, v_nota_apro
    );

    IF v_calc.codigo_error = 'SIN_PREGUNTAS_VALIDAS' THEN
        RETURN jsonb_build_object(
            'codigo', 'SIN_PREGUNTAS_VALIDAS',
            'error',  'Todas las preguntas del intento están anuladas; contacta al administrador'
        );
    END IF;

    v_ahora := NOW();

    -- 5. Actualizar intento (solo campos derivados; no toca nota_manual)
    UPDATE capacitacion_intentos
    SET    estado                = 'completado',
           finalizado_en         = v_ahora,
           puntaje_obtenido      = v_calc.puntaje,
           nota                  = v_calc.nota,
           aprobado              = v_calc.aprobado,
           finalizado_por_tiempo = CASE WHEN p_por_tiempo THEN TRUE
                                        ELSE finalizado_por_tiempo END
    WHERE  id     = p_intento_id
    AND    estado = 'en_curso';

    -- 6. Devolver resultado
    RETURN jsonb_build_object(
        'ya_completado',         FALSE,
        'estado',                'completado',
        'puntaje_obtenido',      v_calc.puntaje,
        'nota',                  v_calc.nota,
        'aprobado',              v_calc.aprobado,
        'finalizado_en',         v_ahora,
        'finalizado_por_tiempo', p_por_tiempo,
        'correctas',             v_calc.correctas,
        'incorrectas',           v_calc.incorrectas,
        'no_respondidas',        v_calc.omitidas,
        'total_preguntas',       v_calc.total_valido,
        'total_snapshot',        v_calc.total_snapshot,
        'preguntas_anuladas',    v_calc.total_anuladas
    );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- D. rpc_recalcular_intentos_capacitacion — nueva RPC administrativa
--
--    Aplica un cambio de configuración Y recalcula todos los intentos afectados
--    en la misma transacción atómica. Si algo falla, todo se revierte.
--
--    Parámetros:
--      p_prueba_id    — UUID de la prueba
--      p_pregunta_id  — UUID de la pregunta afectada
--      p_tipo_cambio  — 'anular' | 'reactivar' | 'cambiar_correcta'
--      p_admin_id     — UUID del administrador
--      p_motivo       — texto obligatorio (razón del cambio)
--      p_nueva_alt_id — UUID de la nueva alternativa correcta (solo cambiar_correcta)
--
--    Bloqueo: los intentos se bloquean en ORDER BY ci.id (orden estable → sin deadlocks).
--    Solo se afectan intentos 'completado' cuyo snapshot contenga la pregunta (o sin snapshot).
--    Intentos 'en_curso' → bloquean la operación con código INTENTOS_EN_CURSO.
--    Nota manual → NO se toca. Solo puntaje_obtenido, nota, aprobado.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION rpc_recalcular_intentos_capacitacion(
    p_prueba_id    UUID,
    p_pregunta_id  UUID,
    p_tipo_cambio  TEXT,
    p_admin_id     UUID,
    p_motivo       TEXT,
    p_nueva_alt_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_prueba        RECORD;
    v_pregunta      RECORD;
    v_en_curso      INTEGER;
    v_recalculo_id  UUID;
    v_alt_ant       UUID;
    v_anulada_ant   BOOLEAN;
    v_anulada_nva   BOOLEAN;
    v_pmia          NUMERIC;
    v_nota_min      NUMERIC;
    v_nota_max      NUMERIC;
    v_nota_apro     NUMERIC;
    v_intento_row   RECORD;
    v_calc          RECORD;
    v_cnt_afect     INTEGER := 0;
    v_cnt_mayor     INTEGER := 0;
    v_cnt_menor     INTEGER := 0;
    v_cnt_igual     INTEGER := 0;
    v_apro_a_rep    INTEGER := 0;
    v_rep_a_apro    INTEGER := 0;
BEGIN
    -- 1. Validar tipo_cambio
    IF p_tipo_cambio NOT IN ('anular', 'reactivar', 'cambiar_correcta') THEN
        RETURN jsonb_build_object('codigo', 'TIPO_INVALIDO',
            'error', 'tipo_cambio inválido');
    END IF;

    IF p_motivo IS NULL OR trim(p_motivo) = '' THEN
        RETURN jsonb_build_object('codigo', 'MOTIVO_REQUERIDO',
            'error', 'El motivo es obligatorio');
    END IF;

    -- 2. Validar prueba
    SELECT id, puntaje_minimo_aprobacion, nota_minima, nota_maxima, nota_aprobacion
    INTO   v_prueba
    FROM   capacitacion_pruebas
    WHERE  id = p_prueba_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('codigo', 'PRUEBA_NO_ENCONTRADA',
            'error', 'Prueba no encontrada');
    END IF;

    v_pmia      := COALESCE(v_prueba.puntaje_minimo_aprobacion, 60);
    v_nota_min  := COALESCE(v_prueba.nota_minima,     1.0);
    v_nota_max  := COALESCE(v_prueba.nota_maxima,     7.0);
    v_nota_apro := COALESCE(v_prueba.nota_aprobacion, 4.0);

    -- 3. Validar pregunta (debe pertenecer a la prueba)
    SELECT id, anulada
    INTO   v_pregunta
    FROM   capacitacion_preguntas
    WHERE  id = p_pregunta_id AND prueba_id = p_prueba_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('codigo', 'PREGUNTA_NO_ENCONTRADA',
            'error', 'La pregunta no pertenece a esta prueba');
    END IF;

    v_anulada_ant := v_pregunta.anulada;

    -- 4. Verificar que NO haya intentos en_curso
    --    (bloqueo de seguridad: no se puede modificar mientras alguien está respondiendo)
    SELECT COUNT(*) INTO v_en_curso
    FROM   capacitacion_intentos    ci
    JOIN   capacitacion_asignaciones ca ON ca.id = ci.asignacion_id
    WHERE  ca.prueba_id = p_prueba_id
    AND    ci.estado    = 'en_curso';

    IF v_en_curso > 0 THEN
        RETURN jsonb_build_object(
            'codigo',            'INTENTOS_EN_CURSO',
            'error',             'Hay ' || v_en_curso || ' intento(s) en curso. Espera a que finalicen antes de aplicar este cambio.',
            'intentos_en_curso', v_en_curso
        );
    END IF;

    -- 5. Validaciones específicas por tipo
    IF p_tipo_cambio = 'anular' AND v_pregunta.anulada = TRUE THEN
        RETURN jsonb_build_object('codigo', 'YA_ANULADA',
            'error', 'La pregunta ya está anulada');
    END IF;

    IF p_tipo_cambio = 'reactivar' AND v_pregunta.anulada = FALSE THEN
        RETURN jsonb_build_object('codigo', 'YA_ACTIVA',
            'error', 'La pregunta ya está activa (no está anulada)');
    END IF;

    IF p_tipo_cambio = 'cambiar_correcta' THEN
        IF p_nueva_alt_id IS NULL THEN
            RETURN jsonb_build_object('codigo', 'ALT_REQUERIDA',
                'error', 'Se requiere p_nueva_alt_id para cambiar_correcta');
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM capacitacion_alternativas
            WHERE  id = p_nueva_alt_id AND pregunta_id = p_pregunta_id
        ) THEN
            RETURN jsonb_build_object('codigo', 'ALTERNATIVA_INVALIDA',
                'error', 'La alternativa no pertenece a esta pregunta');
        END IF;
        SELECT id INTO v_alt_ant
        FROM   capacitacion_alternativas
        WHERE  pregunta_id = p_pregunta_id AND es_correcta = TRUE
        LIMIT  1;
    END IF;

    -- 6. Calcular estado nuevo de anulada para auditoría
    v_anulada_nva := CASE p_tipo_cambio
        WHEN 'anular'    THEN TRUE
        WHEN 'reactivar' THEN FALSE
        ELSE v_pregunta.anulada
    END;

    -- 7. Crear registro de auditoría (resultado inicial: procesando)
    INSERT INTO capacitacion_recalculos(
        prueba_id, pregunta_id, tipo_cambio,
        anulada_anterior, anulada_nueva,
        alt_correcta_ant, alt_correcta_nva,
        admin_id, motivo, resultado
    ) VALUES (
        p_prueba_id, p_pregunta_id, p_tipo_cambio,
        v_anulada_ant, v_anulada_nva,
        CASE WHEN p_tipo_cambio = 'cambiar_correcta' THEN v_alt_ant   ELSE NULL END,
        CASE WHEN p_tipo_cambio = 'cambiar_correcta' THEN p_nueva_alt_id ELSE NULL END,
        p_admin_id, trim(p_motivo), 'procesando'
    )
    RETURNING id INTO v_recalculo_id;

    -- 8. APLICAR EL CAMBIO DE CONFIGURACIÓN
    IF p_tipo_cambio = 'anular' THEN
        UPDATE capacitacion_preguntas
        SET    anulada = TRUE, updated_at = NOW()
        WHERE  id = p_pregunta_id;

    ELSIF p_tipo_cambio = 'reactivar' THEN
        UPDATE capacitacion_preguntas
        SET    anulada = FALSE, updated_at = NOW()
        WHERE  id = p_pregunta_id;

    ELSIF p_tipo_cambio = 'cambiar_correcta' THEN
        -- Desmarcar TODAS las alternativas de la pregunta
        UPDATE capacitacion_alternativas
        SET    es_correcta = FALSE, updated_at = NOW()
        WHERE  pregunta_id = p_pregunta_id;

        -- Marcar la nueva alternativa correcta
        UPDATE capacitacion_alternativas
        SET    es_correcta = TRUE, updated_at = NOW()
        WHERE  id = p_nueva_alt_id;

        -- Sincronizar capacitacion_respuestas.es_correcta (Estrategia A)
        -- Respuestas con alternativa seleccionada: correcta = (es la nueva)
        UPDATE capacitacion_respuestas cr
        SET    es_correcta = (cr.alternativa_id = p_nueva_alt_id)
        WHERE  cr.pregunta_id     = p_pregunta_id
        AND    cr.alternativa_id  IS NOT NULL;
        -- Respuestas sin selección (NULL) ya tienen es_correcta = NULL — no se tocan
    END IF;

    -- 9. Identificar intentos completados afectados y recalcularlos
    --    Orden: ci.id ASC (estable → evita deadlocks entre transacciones concurrentes)
    --    Afectados: intentos donde la pregunta está en su snapshot, O sin snapshot (usa todas)
    FOR v_intento_row IN
        SELECT ci.id,
               ci.puntaje_obtenido AS puntaje_ant,
               ci.nota             AS nota_ant,
               ci.aprobado         AS aprobado_ant,
               ci.orden_preguntas_json
        FROM   capacitacion_intentos    ci
        JOIN   capacitacion_asignaciones ca ON ca.id = ci.asignacion_id
        WHERE  ca.prueba_id = p_prueba_id
        AND    ci.estado    = 'completado'
        AND    (
            -- Sin snapshot → afectado por cualquier cambio en la prueba
            ci.orden_preguntas_json IS NULL
            OR
            -- Con snapshot → solo si contiene la pregunta
            ci.orden_preguntas_json @> jsonb_build_array(p_pregunta_id::text)
        )
        ORDER BY ci.id   -- orden estable: misma secuencia de bloqueo en toda transacción
        FOR UPDATE
    LOOP
        -- Calcular nuevo resultado usando la función compartida
        SELECT * INTO v_calc
        FROM _cap_calc_resumen(
            v_intento_row.id,
            v_intento_row.orden_preguntas_json,
            p_prueba_id,
            v_pmia, v_nota_min, v_nota_max, v_nota_apro
        );

        -- Si no hay preguntas válidas: registrar pero no tocar la nota almacenada
        IF v_calc.codigo_error = 'SIN_PREGUNTAS_VALIDAS' THEN
            INSERT INTO capacitacion_recalculos_detalle(
                recalculo_id, intento_id,
                puntaje_ant, puntaje_nvo,
                nota_ant,    nota_nva,
                aprobado_ant, aprobado_nvo,
                total_valido_ant, total_valido_nvo,
                correctas_ant, correctas_nvo
            ) VALUES (
                v_recalculo_id, v_intento_row.id,
                v_intento_row.puntaje_ant, NULL,
                v_intento_row.nota_ant,    NULL,
                v_intento_row.aprobado_ant, NULL,
                NULL, 0, NULL, 0
            );
            v_cnt_afect := v_cnt_afect + 1;
            CONTINUE;
        END IF;

        -- Actualizar el intento (solo campos derivados; nota_manual no se toca)
        UPDATE capacitacion_intentos
        SET    puntaje_obtenido = v_calc.puntaje,
               nota             = v_calc.nota,
               aprobado         = v_calc.aprobado
        WHERE  id = v_intento_row.id;

        -- Registrar detalle por intento
        INSERT INTO capacitacion_recalculos_detalle(
            recalculo_id, intento_id,
            puntaje_ant,          puntaje_nvo,
            nota_ant,             nota_nva,
            aprobado_ant,         aprobado_nvo,
            total_valido_ant,     total_valido_nvo,
            correctas_ant,        correctas_nvo
        ) VALUES (
            v_recalculo_id, v_intento_row.id,
            v_intento_row.puntaje_ant, v_calc.puntaje,
            v_intento_row.nota_ant,    v_calc.nota,
            v_intento_row.aprobado_ant, v_calc.aprobado,
            NULL,                       v_calc.total_valido,
            NULL,                       v_calc.correctas::INTEGER
        );

        v_cnt_afect := v_cnt_afect + 1;

        -- Estadísticas de cambio de nota
        IF v_calc.nota IS NOT NULL AND v_intento_row.nota_ant IS NOT NULL THEN
            IF    v_calc.nota > v_intento_row.nota_ant  THEN v_cnt_mayor := v_cnt_mayor + 1;
            ELSIF v_calc.nota < v_intento_row.nota_ant  THEN v_cnt_menor := v_cnt_menor + 1;
            ELSE  v_cnt_igual := v_cnt_igual + 1;
            END IF;
        END IF;
        IF v_intento_row.aprobado_ant = TRUE  AND v_calc.aprobado = FALSE THEN
            v_apro_a_rep := v_apro_a_rep + 1;
        ELSIF v_intento_row.aprobado_ant = FALSE AND v_calc.aprobado = TRUE THEN
            v_rep_a_apro := v_rep_a_apro + 1;
        END IF;
    END LOOP;

    -- 10. Cerrar el registro de auditoría
    UPDATE capacitacion_recalculos
    SET    intentos_afectados = v_cnt_afect,
           resultado          = 'ok'
    WHERE  id = v_recalculo_id;

    -- 11. Devolver resumen
    RETURN jsonb_build_object(
        'ok',                     TRUE,
        'recalculo_id',           v_recalculo_id,
        'tipo_cambio',            p_tipo_cambio,
        'intentos_afectados',     v_cnt_afect,
        'notas_mayores',          v_cnt_mayor,
        'notas_menores',          v_cnt_menor,
        'notas_sin_cambio',       v_cnt_igual,
        'aprobado_a_reprobado',   v_apro_a_rep,
        'reprobado_a_aprobado',   v_rep_a_apro
    );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- F. Permisos
--    · REVOKE ALL de PUBLIC (cubre anon y authenticated)
--    · GRANT EXECUTE solo a service_role (clave usada por el backend Node.js)
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION _cap_calc_resumen(UUID, JSONB, UUID, NUMERIC, NUMERIC, NUMERIC, NUMERIC)
    FROM PUBLIC;
REVOKE ALL ON FUNCTION rpc_finalizar_intento(UUID, BOOLEAN)
    FROM PUBLIC;
REVOKE ALL ON FUNCTION rpc_recalcular_intentos_capacitacion(UUID, UUID, TEXT, UUID, TEXT, UUID)
    FROM PUBLIC;

GRANT EXECUTE ON FUNCTION _cap_calc_resumen(UUID, JSONB, UUID, NUMERIC, NUMERIC, NUMERIC, NUMERIC)
    TO service_role;
GRANT EXECUTE ON FUNCTION rpc_finalizar_intento(UUID, BOOLEAN)
    TO service_role;
GRANT EXECUTE ON FUNCTION rpc_recalcular_intentos_capacitacion(UUID, UUID, TEXT, UUID, TEXT, UUID)
    TO service_role;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verificación
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    RAISE NOTICE '_cap_calc_resumen: %',
        (SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = '_cap_calc_resumen'));
    RAISE NOTICE 'rpc_finalizar_intento (actualizada): %',
        (SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'rpc_finalizar_intento'));
    RAISE NOTICE 'rpc_recalcular_intentos_capacitacion: %',
        (SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'rpc_recalcular_intentos_capacitacion'));
    RAISE NOTICE 'capacitacion_recalculos: %',
        (SELECT EXISTS (SELECT 1 FROM information_schema.tables
            WHERE table_name = 'capacitacion_recalculos'));
    RAISE NOTICE 'capacitacion_recalculos_detalle: %',
        (SELECT EXISTS (SELECT 1 FROM information_schema.tables
            WHERE table_name = 'capacitacion_recalculos_detalle'));
END $$;
