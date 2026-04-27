-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 021 — Evaluación técnica: escalas configurables + descuentos editables
--
-- CONTENIDO:
--   A. Nuevas columnas en evaluacion_configuracion (descuentos por tipo de caso)
--   B. Tabla evaluacion_escala_puntaje_nota  (puntaje INTEGER → nota NUMERIC)
--   C. Tabla evaluacion_escala_calificacion  (categoria + rango nota → calificacion)
--   D. Datos iniciales (idempotente con ON CONFLICT / WHERE NOT EXISTS)
--   E. publicar_evaluacion() actualizada — lee B y C en vez de CASE hardcodeado
--
-- IDEMPOTENTE: seguro ejecutar varias veces.
-- APLICAR en: Supabase → SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- A. Columnas de descuento en evaluacion_configuracion
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE evaluacion_configuracion
    ADD COLUMN IF NOT EXISTS descuento_interpretativa INTEGER NOT NULL DEFAULT 1
        CHECK (descuento_interpretativa >= 0),
    ADD COLUMN IF NOT EXISTS descuento_reglamentaria  INTEGER NOT NULL DEFAULT 2
        CHECK (descuento_reglamentaria  >= 0),
    ADD COLUMN IF NOT EXISTS descuento_informativo    INTEGER NOT NULL DEFAULT 0
        CHECK (descuento_informativo    >= 0);

-- ─────────────────────────────────────────────────────────────────────────────
-- B. Tabla puntaje → nota
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS evaluacion_escala_puntaje_nota (
    id         SERIAL        PRIMARY KEY,
    puntaje    INTEGER       NOT NULL UNIQUE CHECK (puntaje >= 0),
    nota       NUMERIC(4,2)  NOT NULL CHECK (nota >= 1.0 AND nota <= 7.0),
    activo     BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- C. Tabla calificación cualitativa
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS evaluacion_escala_calificacion (
    id           UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
    categoria    TEXT          NOT NULL CHECK (categoria IN ('A', 'B', 'C')),
    nota_min     NUMERIC(4,2)  NOT NULL,
    nota_max     NUMERIC(4,2)  NOT NULL,
    calificacion TEXT          NOT NULL
        CHECK (calificacion IN ('SOBRESALIENTE', 'BIEN', 'BAJO LO ESPERADO', 'DEFICIENTE')),
    activo       BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_cal_rango CHECK (nota_min < nota_max)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- D1. Datos iniciales puntaje → nota  (tabla oficial)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO evaluacion_escala_puntaje_nota (puntaje, nota) VALUES
    ( 0,1.0),( 1,1.0),( 2,1.1),( 3,1.1),( 4,1.2),( 5,1.2),( 6,1.3),( 7,1.3),( 8,1.3),( 9,1.4),
    (10,1.4),(11,1.5),(12,1.5),(13,1.5),(14,1.6),(15,1.6),(16,1.7),(17,1.7),(18,1.8),(19,1.8),
    (20,1.8),(21,1.9),(22,1.9),(23,2.0),(24,2.0),(25,2.0),(26,2.1),(27,2.1),(28,2.2),(29,2.2),
    (30,2.3),(31,2.3),(32,2.3),(33,2.4),(34,2.4),(35,2.5),(36,2.5),(37,2.5),(38,2.6),(39,2.6),
    (40,2.7),(41,2.7),(42,2.8),(43,2.8),(44,2.8),(45,2.9),(46,2.9),(47,3.0),(48,3.0),(49,3.0),
    (50,3.1),(51,3.1),(52,3.2),(53,3.2),(54,3.3),(55,3.3),(56,3.3),(57,3.4),(58,3.4),(59,3.5),
    (60,3.5),(61,3.5),(62,3.6),(63,3.6),(64,3.7),(65,3.7),(66,3.8),(67,3.8),(68,3.8),(69,3.9),
    (70,3.9),(71,4.0),(72,4.0),(73,4.4),(74,4.8),(75,5.1),(76,5.5),(77,5.9),(78,6.3),(79,6.6),
    (80,7.0)
ON CONFLICT (puntaje) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- D2. Datos iniciales calificación  (matriz oficial)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO evaluacion_escala_calificacion (categoria, nota_min, nota_max, calificacion)
SELECT categoria, nota_min::NUMERIC(4,2), nota_max::NUMERIC(4,2), calificacion
FROM (VALUES
    ('A', '6.5',  '7.0',  'SOBRESALIENTE'),
    ('B', '6.5',  '7.0',  'SOBRESALIENTE'),
    ('C', '6.5',  '7.0',  'SOBRESALIENTE'),
    ('A', '5.5',  '6.49', 'BIEN'),
    ('B', '5.5',  '6.49', 'BIEN'),
    ('C', '5.5',  '6.49', 'BIEN'),
    ('A', '5.0',  '5.49', 'BAJO LO ESPERADO'),
    ('B', '5.0',  '5.49', 'BIEN'),
    ('C', '5.0',  '5.49', 'BIEN'),
    ('A', '4.5',  '4.99', 'BAJO LO ESPERADO'),
    ('B', '4.5',  '4.99', 'BAJO LO ESPERADO'),
    ('C', '4.5',  '4.99', 'BIEN'),
    ('A', '4.0',  '4.49', 'BAJO LO ESPERADO'),
    ('B', '4.0',  '4.49', 'BAJO LO ESPERADO'),
    ('C', '4.0',  '4.49', 'BAJO LO ESPERADO'),
    ('A', '1.0',  '3.99', 'DEFICIENTE'),
    ('B', '1.0',  '3.99', 'DEFICIENTE'),
    ('C', '1.0',  '3.99', 'DEFICIENTE')
) AS t(categoria, nota_min, nota_max, calificacion)
WHERE NOT EXISTS (SELECT 1 FROM evaluacion_escala_calificacion LIMIT 1);

-- ─────────────────────────────────────────────────────────────────────────────
-- E. publicar_evaluacion() — reemplaza CASE hardcodeado con lookups en tablas
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION publicar_evaluacion(
    p_evaluacion_id UUID,
    p_jefe_id       UUID,
    p_comentario    TEXT  DEFAULT NULL,
    p_ip            TEXT  DEFAULT NULL
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

    -- 2. Verificar casos sin resolver
    IF EXISTS (
        SELECT 1 FROM evaluacion_casos
        WHERE evaluacion_id = p_evaluacion_id AND estado <> 'resuelto'
    ) THEN
        RAISE EXCEPTION 'casos_pendientes: existen casos aún no resueltos, no se puede publicar';
    END IF;

    -- 3. Calcular puntaje final
    v_puntaje_base := v_eval.puntaje_base;

    SELECT COALESCE(SUM(descuento_puntos), 0) INTO v_descuentos
    FROM evaluacion_casos
    WHERE evaluacion_id = p_evaluacion_id
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
        v_nota_final := 1.0; -- fallback si el puntaje no existe en la tabla
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
        -- Calificación desde tabla configurable
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
            -- NULL si no hay fila que coincida (no bloquea la publicación)
        END IF;

        -- Detectar nota manual previa para auditoría
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
$$;

COMMIT;
