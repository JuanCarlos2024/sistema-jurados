-- ═════════════════════════════════════════════════════════════════════════
-- 081_evaluacion_desempeno_jurados.sql
-- Nuevo módulo administrativo: Evaluación de Desempeño Jurados. Consolida
-- (en el backend, sin tablas nuevas para eso) fuentes YA EXISTENTES:
--   - evaluaciones.resultados_alterados / evaluaciones.casos_whatsapp
--   - rodeo_notas_secundarias.nota_delegado
--   - comision_evaluaciones_jurado.nota_individual_calculada (grano por jurado)
--   - notas_rodeo.nota (fuente='evaluacion_tecnica', Área Deportiva)
--
-- Esta migración SOLO agrega almacenamiento para los DOS campos que no
-- existen hoy en ningún lado: "Mal jurado" (manual, entero) y "Análisis
-- técnico" (manual, texto), ambos atados a (jurado, período exacto
-- seleccionado) para conservar historial cuando el período cambie.
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — preparada para revisión local, pendiente de
-- autorización explícita para ejecutarse.
--
-- No crea tablas paralelas a las ya existentes, no modifica ninguna tabla ni
-- lógica de evaluación existente (evaluaciones, rodeo_notas_secundarias,
-- comision_evaluaciones_jurado, notas_rodeo quedan intactas).
--
-- Concurrencia: optimista, vía actualizado_en (el caller envía el último
-- valor visto; si no coincide, la RPC aborta con CONFLICTO_CONCURRENCIA en
-- vez de pisar silenciosamente la edición de otro administrador) — mismo
-- espíritu que confirma_sobrescritura_historica en notas-secundarias, pero
-- aplicado a un registro sin estado "protegido", solo con edición
-- concurrente simple.
--
-- Hardening: mismo criterio que la migración 079 (Decisión 6) — RLS
-- habilitado sin políticas + REVOKE de PUBLIC/anon/authenticated + GRANT
-- explícito a service_role. Sin este tratamiento, la tabla nueva sería
-- alcanzable directo vía PostgREST sin pasar por la RPC.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS evaluacion_desempeno_manual (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_pagado_id   UUID        NOT NULL REFERENCES usuarios_pagados(id),
    periodo_desde       DATE        NOT NULL,
    periodo_hasta       DATE        NOT NULL,
    mal_jurado          INTEGER,
    analisis_tecnico    TEXT,
    creado_por          UUID        REFERENCES administradores(id),
    creado_en           TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_por     UUID        REFERENCES administradores(id),
    actualizado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_evaluacion_desempeno_periodo CHECK (periodo_hasta >= periodo_desde),
    CONSTRAINT chk_evaluacion_desempeno_mal_jurado CHECK (mal_jurado IS NULL OR mal_jurado >= 0),
    CONSTRAINT chk_evaluacion_desempeno_analisis_largo CHECK (analisis_tecnico IS NULL OR char_length(analisis_tecnico) <= 8000)
);

-- Unicidad real por (jurado, período exacto) — un período distinto (aunque
-- se traslape con otro) es una fila nueva, a propósito: conserva el valor
-- manual tal como quedó registrado para CADA período histórico distinto.
CREATE UNIQUE INDEX IF NOT EXISTS uq_evaluacion_desempeno_manual_periodo
    ON evaluacion_desempeno_manual(usuario_pagado_id, periodo_desde, periodo_hasta);
CREATE INDEX IF NOT EXISTS idx_evaluacion_desempeno_manual_usuario
    ON evaluacion_desempeno_manual(usuario_pagado_id);

COMMENT ON TABLE evaluacion_desempeno_manual IS
    'Evaluación de Desempeño Jurados (081): únicos dos campos manuales del reporte (Mal jurado, Análisis técnico), atados a (jurado, período exacto) para conservar historial entre períodos distintos. Todo el resto del reporte se calcula en vivo desde fuentes existentes (evaluaciones, rodeo_notas_secundarias, comision_evaluaciones_jurado, notas_rodeo) — nunca se duplica acá.';

ALTER TABLE evaluacion_desempeno_manual ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE evaluacion_desempeno_manual FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE evaluacion_desempeno_manual TO service_role;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'evaluacion_desempeno_manual_publica') THEN
        CREATE TYPE evaluacion_desempeno_manual_publica AS (
            id UUID, usuario_pagado_id UUID, periodo_desde DATE, periodo_hasta DATE,
            mal_jurado INTEGER, analisis_tecnico TEXT,
            creado_por UUID, creado_en TIMESTAMPTZ, actualizado_por UUID, actualizado_en TIMESTAMPTZ
        );
    END IF;
END $$;

DROP FUNCTION IF EXISTS guardar_evaluacion_desempeno_manual_con_auditoria(UUID, DATE, DATE, BOOLEAN, INTEGER, BOOLEAN, TEXT, UUID, TIMESTAMPTZ);
CREATE OR REPLACE FUNCTION guardar_evaluacion_desempeno_manual_con_auditoria(
    p_usuario_pagado_id             UUID,
    p_periodo_desde                 DATE,
    p_periodo_hasta                 DATE,
    p_actualizar_mal_jurado         BOOLEAN,
    p_mal_jurado                    INTEGER,
    p_actualizar_analisis_tecnico   BOOLEAN,
    p_analisis_tecnico              TEXT,
    p_administrador_id              UUID,
    p_actualizado_en_esperado       TIMESTAMPTZ DEFAULT NULL
) RETURNS evaluacion_desempeno_manual_publica AS $$
DECLARE
    v_id                        UUID;
    v_anterior_mal_jurado       INTEGER;
    v_anterior_analisis         TEXT;
    v_anterior_actualizado_en   TIMESTAMPTZ;
    v_existe                    BOOLEAN;
    v_resultado                 evaluacion_desempeno_manual_publica;
BEGIN
    IF p_periodo_hasta < p_periodo_desde THEN
        RAISE EXCEPTION 'PERIODO_INVALIDO';
    END IF;
    IF NOT p_actualizar_mal_jurado AND NOT p_actualizar_analisis_tecnico THEN
        RAISE EXCEPTION 'NINGUN_CAMPO_A_ACTUALIZAR';
    END IF;
    IF p_actualizar_mal_jurado AND p_mal_jurado IS NOT NULL AND p_mal_jurado < 0 THEN
        RAISE EXCEPTION 'MAL_JURADO_INVALIDO';
    END IF;
    IF p_actualizar_analisis_tecnico AND p_analisis_tecnico IS NOT NULL AND char_length(p_analisis_tecnico) > 8000 THEN
        RAISE EXCEPTION 'ANALISIS_TECNICO_DEMASIADO_LARGO';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM usuarios_pagados WHERE id = p_usuario_pagado_id) THEN
        RAISE EXCEPTION 'JURADO_NO_ENCONTRADO';
    END IF;

    SELECT id, mal_jurado, analisis_tecnico, actualizado_en
        INTO v_id, v_anterior_mal_jurado, v_anterior_analisis, v_anterior_actualizado_en
        FROM evaluacion_desempeno_manual
        WHERE usuario_pagado_id = p_usuario_pagado_id
          AND periodo_desde = p_periodo_desde
          AND periodo_hasta = p_periodo_hasta
        FOR UPDATE;
    v_existe := FOUND;

    IF v_existe AND p_actualizado_en_esperado IS NOT NULL
       AND v_anterior_actualizado_en <> p_actualizado_en_esperado THEN
        RAISE EXCEPTION 'CONFLICTO_CONCURRENCIA';
    END IF;

    IF NOT v_existe THEN
        INSERT INTO evaluacion_desempeno_manual (
            usuario_pagado_id, periodo_desde, periodo_hasta, mal_jurado, analisis_tecnico,
            creado_por, actualizado_por
        ) VALUES (
            p_usuario_pagado_id, p_periodo_desde, p_periodo_hasta,
            CASE WHEN p_actualizar_mal_jurado THEN p_mal_jurado ELSE NULL END,
            CASE WHEN p_actualizar_analisis_tecnico THEN p_analisis_tecnico ELSE NULL END,
            p_administrador_id, p_administrador_id
        )
        RETURNING id, usuario_pagado_id, periodo_desde, periodo_hasta, mal_jurado, analisis_tecnico,
                  creado_por, creado_en, actualizado_por, actualizado_en
        INTO v_resultado;
    ELSE
        UPDATE evaluacion_desempeno_manual SET
            mal_jurado       = CASE WHEN p_actualizar_mal_jurado       THEN p_mal_jurado       ELSE v_anterior_mal_jurado END,
            analisis_tecnico = CASE WHEN p_actualizar_analisis_tecnico THEN p_analisis_tecnico ELSE v_anterior_analisis   END,
            actualizado_por  = p_administrador_id,
            actualizado_en   = now()
        WHERE id = v_id
        RETURNING id, usuario_pagado_id, periodo_desde, periodo_hasta, mal_jurado, analisis_tecnico,
                  creado_por, creado_en, actualizado_por, actualizado_en
        INTO v_resultado;
    END IF;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES (
        'evaluacion_desempeno_manual',
        v_resultado.id::text,
        CASE WHEN v_existe THEN 'actualizar' ELSE 'crear' END,
        CASE WHEN v_existe THEN jsonb_build_object('mal_jurado', v_anterior_mal_jurado, 'analisis_tecnico', v_anterior_analisis) ELSE NULL END,
        jsonb_build_object(
            'mal_jurado', v_resultado.mal_jurado, 'analisis_tecnico', v_resultado.analisis_tecnico,
            'periodo_desde', p_periodo_desde, 'periodo_hasta', p_periodo_hasta
        ),
        p_administrador_id::text, 'administrador',
        format('Evaluación de Desempeño Jurados — actualización manual (jurado %s, período %s a %s)',
               p_usuario_pagado_id, p_periodo_desde, p_periodo_hasta)
    );

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION guardar_evaluacion_desempeno_manual_con_auditoria IS
    'Evaluación de Desempeño Jurados (081): único camino de escritura para Mal jurado / Análisis técnico. p_actualizar_* explícitos (nunca inferidos de presencia de claves en el body — mismo criterio que corrigió el bug de notas-secundarias/Comisión de Asociación). Concurrencia optimista vía p_actualizado_en_esperado (NULL = sin verificar, usado solo en la primera carga de un período nunca antes guardado). Auditoría completa en cada escritura (crear/actualizar), con valores anteriores cuando aplica.';

REVOKE ALL ON FUNCTION guardar_evaluacion_desempeno_manual_con_auditoria FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION guardar_evaluacion_desempeno_manual_con_auditoria TO service_role;

COMMIT;
