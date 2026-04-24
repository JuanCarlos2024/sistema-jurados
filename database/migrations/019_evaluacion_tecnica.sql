-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 019 — Módulo: Análisis de Casos / Evaluación Técnica de Jurados
-- Fase 1 — Estructura base completa
--
-- CONTENIDO:
--   Parte A: Modificaciones no destructivas a tablas existentes
--             - administradores: columna rol_evaluacion
--             - notas_rodeo:     columnas fuente, puntaje_evaluacion,
--                                calificacion_cualitativa, evaluacion_id
--   Parte B: Tablas nuevas del módulo (7 tablas)
--   Parte C: Índices
--   Parte D: Función transaccional publicar_evaluacion() — RPC
--   Parte E: Fila inicial de configuración
--
-- NOTAS DE DISEÑO:
--   - notas_rodeo.evaluacion_id es referencia lógica SIN FK física.
--     Se valida por aplicación para evitar dependencias cruzadas entre módulos.
--     La trazabilidad se garantiza via evaluacion_auditoria (snapshots jsonb).
--   - La publicación de nota técnica NUNCA sobreescribe notas_rodeo.comentario.
--     Si existe comentario previo (manual o técnico) se conserva siempre.
--     La sobreescritura de una nota manual se detecta y registra en auditoría.
--   - La escala puntaje→nota y la matriz cualitativa son constantes oficiales
--     embebidas en publicar_evaluacion(). Preparadas para externalizar a
--     evaluacion_configuracion.escala_puntaje_nota (JSONB) en una fase posterior.
--   - Aplica SOLO a asignaciones con tipo_persona='jurado'. Delegados excluidos.
--
-- IDEMPOTENTE: usa IF NOT EXISTS — seguro ejecutar varias veces.
-- APLICAR en: Supabase → SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE A: Modificaciones a tablas existentes (no destructivas)
-- ═══════════════════════════════════════════════════════════════════════════════

-- A1. administradores: sub-rol dentro del módulo de evaluación técnica
--     NULL = administrador pleno (acceso total al módulo)
--     Valor = acceso restringido al rol correspondiente
ALTER TABLE administradores
    ADD COLUMN IF NOT EXISTS rol_evaluacion TEXT
        CHECK (rol_evaluacion IN ('analista', 'comision_tecnica', 'jefe_area'));

-- A2. notas_rodeo: campos del módulo de evaluación técnica
--     Todos opcionales (nullable o con DEFAULT) — no rompen filas existentes
ALTER TABLE notas_rodeo
    ADD COLUMN IF NOT EXISTS fuente TEXT NOT NULL DEFAULT 'manual'
        CHECK (fuente IN ('manual', 'evaluacion_tecnica')),
    ADD COLUMN IF NOT EXISTS puntaje_evaluacion INTEGER,
    ADD COLUMN IF NOT EXISTS calificacion_cualitativa TEXT,
    ADD COLUMN IF NOT EXISTS evaluacion_id UUID;
    -- evaluacion_id: referencia lógica SIN FK física.
    -- Sin FK para evitar dependencia circular entre módulos en migraciones.
    -- Integridad garantizada por la aplicación y por evaluacion_auditoria.


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE B: Tablas nuevas del módulo
-- ═══════════════════════════════════════════════════════════════════════════════

-- B1. Configuración del módulo (una sola fila activa)
--     escala_puntaje_nota y matriz_calificacion son JSONB nullable:
--     NULL = el servicio usa las constantes oficiales hardcodeadas (fase 1).
--     Valor = override configurable por admin/jefe (fase futura).
CREATE TABLE IF NOT EXISTS evaluacion_configuracion (
    id                      SERIAL          PRIMARY KEY,
    puntaje_base            INTEGER         NOT NULL DEFAULT 80,
    min_casos_ciclo1        INTEGER         NOT NULL DEFAULT 0,
    max_casos_ciclo1        INTEGER         NOT NULL DEFAULT 10,
    min_casos_ciclo2        INTEGER         NOT NULL DEFAULT 8,
    max_casos_ciclo2        INTEGER         NOT NULL DEFAULT 8,
    escala_puntaje_nota     JSONB,
    matriz_calificacion     JSONB,
    activo                  BOOLEAN         NOT NULL DEFAULT TRUE,
    updated_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_by              TEXT
);

-- B2. Evaluaciones (una por rodeo — UNIQUE en rodeo_id)
CREATE TABLE IF NOT EXISTS evaluaciones (
    id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    rodeo_id                UUID            NOT NULL UNIQUE REFERENCES rodeos(id),
    analista_id             UUID            REFERENCES administradores(id),
    estado                  TEXT            NOT NULL DEFAULT 'borrador'
        CHECK (estado IN (
            'borrador',
            'en_proceso',
            'pendiente_comision',
            'pendiente_aprobacion',
            'devuelto',
            'aprobado',
            'publicado',
            'cerrado'
        )),
    puntaje_base            INTEGER         NOT NULL DEFAULT 80,
    puntaje_final           INTEGER,
    nota_final              NUMERIC(4,2),
    nota_publicada          BOOLEAN         NOT NULL DEFAULT FALSE,
    observacion_general     TEXT,
    -- Puntajes de lugar (cargables por analista, jefe o admin)
    puntaje_oficial_1er     NUMERIC(6,2),
    puntaje_oficial_2do     NUMERIC(6,2),
    puntaje_oficial_3er     NUMERIC(6,2),
    puntaje_analista_1er    NUMERIC(6,2),
    puntaje_analista_2do    NUMERIC(6,2),
    puntaje_analista_3er    NUMERIC(6,2),
    -- Decisión del jefe del área deportiva
    decision_jefe           TEXT            CHECK (decision_jefe IN ('aprobado', 'devuelto')),
    comentario_jefe         TEXT,
    fecha_decision_jefe     TIMESTAMPTZ,
    jefe_id                 UUID            REFERENCES administradores(id),
    -- Metadata
    creado_por              UUID            NOT NULL REFERENCES administradores(id),
    created_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- B3. Ciclos de evaluación (exactamente dos por evaluación: ciclo 1 y ciclo 2)
--     Auditoría de cierre/apertura manual incluida como columnas de primera clase.
CREATE TABLE IF NOT EXISTS evaluacion_ciclos (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    evaluacion_id    UUID        NOT NULL REFERENCES evaluaciones(id),
    numero_ciclo     INTEGER     NOT NULL CHECK (numero_ciclo IN (1, 2)),
    estado           TEXT        NOT NULL DEFAULT 'pendiente_carga'
        CHECK (estado IN (
            'pendiente_carga',
            'sin_casos',
            'cargado',
            'abierto',
            'en_revision',
            'cerrado'
        )),
    min_casos        INTEGER,
    max_casos        INTEGER,
    -- Apertura al jurado
    fecha_apertura   TIMESTAMPTZ,
    abierto_por      UUID        REFERENCES administradores(id),
    -- Cierre (manual o por analista)
    fecha_cierre     TIMESTAMPTZ,
    cerrado_por      UUID        REFERENCES administradores(id),
    motivo_cierre    TEXT,
    -- Reapertura manual (solo administrador)
    fecha_reapertura  TIMESTAMPTZ,
    reabierto_por     UUID        REFERENCES administradores(id),
    motivo_reapertura TEXT,
    -- Metadata
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (evaluacion_id, numero_ciclo)
);

-- B4. Casos de evaluación
CREATE TABLE IF NOT EXISTS evaluacion_casos (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    ciclo_id                UUID        NOT NULL REFERENCES evaluacion_ciclos(id),
    evaluacion_id           UUID        NOT NULL REFERENCES evaluaciones(id),
    numero_caso             INTEGER     NOT NULL,
    tipo_caso               TEXT        NOT NULL
        CHECK (tipo_caso IN ('interpretativa', 'reglamentaria', 'informativo')),
    descripcion             TEXT,
    video_url               TEXT,
    descuento_puntos        INTEGER     NOT NULL DEFAULT 0
        CHECK (descuento_puntos IN (0, 1, 2)),
    -- Estado del caso
    estado                  TEXT        NOT NULL DEFAULT 'cargado'
        CHECK (estado IN (
            'cargado',
            'visible_jurado',
            'consolidado',
            'pendiente_analista',
            'derivado_comision',
            'resuelto'
        )),
    estado_consolidado      TEXT
        CHECK (estado_consolidado IN ('pendiente', 'aceptado', 'rechazado', 'incompleto')),
    resolucion_final        TEXT
        CHECK (resolucion_final IN (
            'sin_descuento',
            'interpretativa_confirmada',
            'reglamentaria_confirmada',
            'apelacion_acogida',
            'apelacion_rechazada'
        )),
    -- Decisión del analista
    decision_analista       TEXT
        CHECK (decision_analista IN ('mantener', 'revertir', 'derivar_comision')),
    comentario_analista     TEXT,
    analista_decidio_en     TIMESTAMPTZ,
    analista_id             UUID        REFERENCES administradores(id),
    -- Decisión de comisión técnica (comentario obligatorio — ver constraint abajo)
    decision_comision       TEXT
        CHECK (decision_comision IN ('aprueba_apelacion', 'rechaza_apelacion')),
    comentario_comision     TEXT,
    comision_decidio_en     TIMESTAMPTZ,
    comision_miembro_id     UUID        REFERENCES administradores(id),
    -- Metadata
    cargado_por             UUID        NOT NULL REFERENCES administradores(id),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (ciclo_id, numero_caso),

    CONSTRAINT chk_comentario_comision
        CHECK (
            decision_comision IS NULL
            OR (comentario_comision IS NOT NULL AND LENGTH(TRIM(comentario_comision)) > 0)
        )
);

-- B5. Respuestas individuales de jurado por caso
CREATE TABLE IF NOT EXISTS evaluacion_respuestas_jurado (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    caso_id       UUID        NOT NULL REFERENCES evaluacion_casos(id),
    asignacion_id UUID        NOT NULL REFERENCES asignaciones(id),
    decision      TEXT        NOT NULL CHECK (decision IN ('acepta', 'rechaza')),
    comentario    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (caso_id, asignacion_id),

    CONSTRAINT chk_comentario_rechazo
        CHECK (
            decision <> 'rechaza'
            OR (comentario IS NOT NULL AND LENGTH(TRIM(comentario)) > 0)
        )
);

-- B6. Comentarios finales del jurado post-cierre (uno por jurado por evaluación)
--     Solo permitidos cuando la evaluación está en estado 'publicado' o 'cerrado'.
--     No alteran la nota. Visibles para admin y jefe de área.
CREATE TABLE IF NOT EXISTS evaluacion_comentarios_finales (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    evaluacion_id UUID        NOT NULL REFERENCES evaluaciones(id),
    asignacion_id UUID        NOT NULL REFERENCES asignaciones(id),
    comentario    TEXT        NOT NULL CHECK (LENGTH(TRIM(comentario)) > 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (evaluacion_id, asignacion_id)
);

-- B7. Auditoría del módulo (log inmutable — sin UPDATE ni DELETE)
--     Registra todas las acciones relevantes con snapshot jsonb antes/después.
--     Incluye acción específica 'sobreescritura_nota_manual' para trazabilidad.
CREATE TABLE IF NOT EXISTS evaluacion_auditoria (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    evaluacion_id UUID        REFERENCES evaluaciones(id),
    caso_id       UUID        REFERENCES evaluacion_casos(id),
    ciclo_id      UUID        REFERENCES evaluacion_ciclos(id),
    accion        TEXT        NOT NULL,
    -- Valores documentados para accion:
    --   crear_evaluacion, asignar_analista, reasignar_analista,
    --   cargar_caso, importar_excel,
    --   abrir_ciclo, cerrar_ciclo_manual, reabrir_ciclo,
    --   responder_caso, consolidar_caso,
    --   decision_analista, derivar_comision, decision_comision,
    --   enviar_a_jefe, aprobar_jefe, devolver_jefe,
    --   publicar_nota, sobreescritura_nota_manual,
    --   comentario_final, correccion_por_devolucion
    detalle       JSONB,
    actor_id      UUID        NOT NULL,
    actor_tipo    TEXT        NOT NULL CHECK (actor_tipo IN ('administrador', 'usuario_pagado')),
    actor_nombre  TEXT,
    ip_address    INET,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE C: Índices
-- ═══════════════════════════════════════════════════════════════════════════════

-- Solo puede existir una fila activa en evaluacion_configuracion a la vez
CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_config_unica_activa
    ON evaluacion_configuracion (activo)
    WHERE activo = TRUE;

CREATE INDEX IF NOT EXISTS idx_evaluaciones_rodeo     ON evaluaciones(rodeo_id);
CREATE INDEX IF NOT EXISTS idx_evaluaciones_estado    ON evaluaciones(estado);
CREATE INDEX IF NOT EXISTS idx_evaluaciones_analista  ON evaluaciones(analista_id);

CREATE INDEX IF NOT EXISTS idx_eval_ciclos_evaluacion ON evaluacion_ciclos(evaluacion_id);

CREATE INDEX IF NOT EXISTS idx_eval_casos_ciclo       ON evaluacion_casos(ciclo_id);
CREATE INDEX IF NOT EXISTS idx_eval_casos_evaluacion  ON evaluacion_casos(evaluacion_id);
CREATE INDEX IF NOT EXISTS idx_eval_casos_estado      ON evaluacion_casos(estado);

CREATE INDEX IF NOT EXISTS idx_eval_respuestas_caso   ON evaluacion_respuestas_jurado(caso_id);
CREATE INDEX IF NOT EXISTS idx_eval_respuestas_asig   ON evaluacion_respuestas_jurado(asignacion_id);

CREATE INDEX IF NOT EXISTS idx_eval_cf_evaluacion     ON evaluacion_comentarios_finales(evaluacion_id);

CREATE INDEX IF NOT EXISTS idx_eval_auditoria_eval    ON evaluacion_auditoria(evaluacion_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_auditoria_accion  ON evaluacion_auditoria(accion);

CREATE INDEX IF NOT EXISTS idx_notas_rodeo_fuente     ON notas_rodeo(fuente);


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE D: Función transaccional de publicación (RPC)
--
-- Diseño:
--   - Toda la operación ocurre en una única transacción PostgreSQL.
--   - Si cualquier paso falla, se hace rollback automático (sin rollback manual).
--   - La función detecta y audita la sobreescritura de notas manuales previas.
--   - La publicación NUNCA escribe en notas_rodeo.comentario:
--       * INSERT nuevo: comentario = NULL (la nota técnica no agrega comentario)
--       * UPDATE sobre fila existente: comentario se conserva siempre
--   - Solo afecta asignaciones tipo_persona='jurado'. Delegados excluidos.
--   - Retorna JSONB con resultado, nota, puntaje y lista de sobreescrituras.
--
-- Escala oficial puntaje→nota (81 entradas, puntaje 0–80):
--   Embebida como CASE. Puede externalizarse a evaluacion_configuracion
--   en una fase posterior sin cambiar la interfaz de la función.
--
-- Llamada desde backend (Node.js):
--   const { data, error } = await supabase.rpc('publicar_evaluacion', {
--     p_evaluacion_id: id,
--     p_jefe_id:       req.usuario.id,
--     p_comentario:    req.body.comentario || null,
--     p_ip:            req.ip || null
--   });
-- ═══════════════════════════════════════════════════════════════════════════════

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
    v_sobreescrituras   JSONB  := '[]'::JSONB;
    v_jurados_count     INTEGER := 0;
    v_ip_inet           INET;
BEGIN
    -- Convertir IP (TEXT → INET, tolerante a NULL o vacío)
    BEGIN
        v_ip_inet := NULLIF(TRIM(p_ip), '')::INET;
    EXCEPTION WHEN OTHERS THEN
        v_ip_inet := NULL;
    END;

    -- ── 1. Leer y validar la evaluación ────────────────────────────────────────
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

    -- ── 2. Verificar que no existan casos sin resolver ──────────────────────────
    IF EXISTS (
        SELECT 1
        FROM evaluacion_casos
        WHERE evaluacion_id = p_evaluacion_id
          AND estado <> 'resuelto'
    ) THEN
        RAISE EXCEPTION 'casos_pendientes: existen casos aún no resueltos, no se puede publicar';
    END IF;

    -- ── 3. Calcular puntaje final ───────────────────────────────────────────────
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

    -- ── 4. Convertir puntaje a nota (tabla oficial exacta, sin fórmula) ─────────
    v_nota_final := CASE v_puntaje_final
        WHEN  0 THEN 1.0  WHEN  1 THEN 1.0  WHEN  2 THEN 1.1  WHEN  3 THEN 1.1
        WHEN  4 THEN 1.2  WHEN  5 THEN 1.2  WHEN  6 THEN 1.3  WHEN  7 THEN 1.3
        WHEN  8 THEN 1.3  WHEN  9 THEN 1.4  WHEN 10 THEN 1.4  WHEN 11 THEN 1.5
        WHEN 12 THEN 1.5  WHEN 13 THEN 1.5  WHEN 14 THEN 1.6  WHEN 15 THEN 1.6
        WHEN 16 THEN 1.7  WHEN 17 THEN 1.7  WHEN 18 THEN 1.8  WHEN 19 THEN 1.8
        WHEN 20 THEN 1.8  WHEN 21 THEN 1.9  WHEN 22 THEN 1.9  WHEN 23 THEN 2.0
        WHEN 24 THEN 2.0  WHEN 25 THEN 2.0  WHEN 26 THEN 2.1  WHEN 27 THEN 2.1
        WHEN 28 THEN 2.2  WHEN 29 THEN 2.2  WHEN 30 THEN 2.3  WHEN 31 THEN 2.3
        WHEN 32 THEN 2.3  WHEN 33 THEN 2.4  WHEN 34 THEN 2.4  WHEN 35 THEN 2.5
        WHEN 36 THEN 2.5  WHEN 37 THEN 2.5  WHEN 38 THEN 2.6  WHEN 39 THEN 2.6
        WHEN 40 THEN 2.7  WHEN 41 THEN 2.7  WHEN 42 THEN 2.8  WHEN 43 THEN 2.8
        WHEN 44 THEN 2.8  WHEN 45 THEN 2.9  WHEN 46 THEN 2.9  WHEN 47 THEN 3.0
        WHEN 48 THEN 3.0  WHEN 49 THEN 3.0  WHEN 50 THEN 3.1  WHEN 51 THEN 3.1
        WHEN 52 THEN 3.2  WHEN 53 THEN 3.2  WHEN 54 THEN 3.3  WHEN 55 THEN 3.3
        WHEN 56 THEN 3.3  WHEN 57 THEN 3.4  WHEN 58 THEN 3.4  WHEN 59 THEN 3.5
        WHEN 60 THEN 3.5  WHEN 61 THEN 3.5  WHEN 62 THEN 3.6  WHEN 63 THEN 3.6
        WHEN 64 THEN 3.7  WHEN 65 THEN 3.7  WHEN 66 THEN 3.8  WHEN 67 THEN 3.8
        WHEN 68 THEN 3.8  WHEN 69 THEN 3.9  WHEN 70 THEN 3.9  WHEN 71 THEN 4.0
        WHEN 72 THEN 4.0  WHEN 73 THEN 4.4  WHEN 74 THEN 4.8  WHEN 75 THEN 5.1
        WHEN 76 THEN 5.5  WHEN 77 THEN 5.9  WHEN 78 THEN 6.3  WHEN 79 THEN 6.6
        WHEN 80 THEN 7.0
        ELSE 1.0
    END;

    -- ── 5. Marcar evaluación como aprobada ─────────────────────────────────────
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

    -- ── 6. UPSERT en notas_rodeo por cada jurado del rodeo ─────────────────────
    --   Filtro obligatorio: tipo_persona='jurado' — delegados excluidos siempre.
    --   Regla de comentario:
    --     * INSERT nuevo → comentario = NULL (publicación técnica no asigna comentario)
    --     * UPDATE sobre fila existente → comentario se conserva (no se sobreescribe)
    FOR v_asig IN
        SELECT
            a.id         AS asignacion_id,
            up.categoria AS categoria
        FROM asignaciones a
        JOIN usuarios_pagados up ON up.id = a.usuario_pagado_id
        WHERE a.rodeo_id          = v_eval.rodeo_id
          AND a.estado            = 'activo'
          AND a.estado_designacion IS DISTINCT FROM 'rechazado'
          AND up.tipo_persona     = 'jurado'
    LOOP
        -- Calcular calificación cualitativa según nota y categoría del jurado
        -- NULL categoria → NULL calificacion (no bloquea la publicación)
        IF v_asig.categoria IS NULL THEN
            v_calificacion := NULL;
        ELSE
            v_calificacion := CASE
                WHEN v_nota_final >= 6.5 THEN 'SOBRESALIENTE'
                WHEN v_nota_final >= 5.5 THEN 'BIEN'
                WHEN v_nota_final >= 5.0 THEN
                    CASE v_asig.categoria
                        WHEN 'A' THEN 'BAJO LO ESPERADO'
                        ELSE 'BIEN'
                    END
                WHEN v_nota_final >= 4.5 THEN
                    CASE v_asig.categoria
                        WHEN 'C' THEN 'BIEN'
                        ELSE 'BAJO LO ESPERADO'
                    END
                WHEN v_nota_final >= 4.0 THEN 'BAJO LO ESPERADO'
                ELSE 'DEFICIENTE'
            END;
        END IF;

        -- Detectar nota manual previa para auditoría y warning
        SELECT * INTO v_nota_existente
        FROM notas_rodeo
        WHERE asignacion_id = v_asig.asignacion_id;

        IF FOUND AND v_nota_existente.fuente = 'manual' THEN
            -- Acumular para retornar al backend (frontend puede mostrar advertencia)
            v_sobreescrituras := v_sobreescrituras || jsonb_build_object(
                'asignacion_id',        v_asig.asignacion_id,
                'nota_manual_anterior', v_nota_existente.nota,
                'comentario_anterior',  v_nota_existente.comentario
            );
            -- Registrar en auditoría DENTRO de la misma transacción
            INSERT INTO evaluacion_auditoria (
                evaluacion_id, accion, detalle,
                actor_id, actor_tipo, ip_address
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

        -- UPSERT: INSERT o UPDATE sin tocar comentario
        INSERT INTO notas_rodeo (
            asignacion_id,
            nota,
            comentario,            -- NULL en insert nuevo; ver ON CONFLICT
            evaluado_en,
            updated_at,
            updated_by,
            fuente,
            puntaje_evaluacion,
            calificacion_cualitativa,
            evaluacion_id
        ) VALUES (
            v_asig.asignacion_id,
            v_nota_final,
            NULL,                  -- insert nuevo: sin comentario
            NOW(),
            NOW(),
            p_jefe_id::TEXT,
            'evaluacion_tecnica',
            v_puntaje_final,
            v_calificacion,
            p_evaluacion_id
        )
        ON CONFLICT (asignacion_id) DO UPDATE SET
            nota                     = EXCLUDED.nota,
            -- comentario NO se incluye: se conserva el valor existente siempre
            evaluado_en              = EXCLUDED.evaluado_en,
            updated_at               = EXCLUDED.updated_at,
            updated_by               = EXCLUDED.updated_by,
            fuente                   = EXCLUDED.fuente,
            puntaje_evaluacion       = EXCLUDED.puntaje_evaluacion,
            calificacion_cualitativa = EXCLUDED.calificacion_cualitativa,
            evaluacion_id            = EXCLUDED.evaluacion_id;

        v_jurados_count := v_jurados_count + 1;
    END LOOP;

    -- ── 7. Validar que haya al menos un jurado afectado ───────────────────────
    IF v_jurados_count = 0 THEN
        RAISE EXCEPTION 'sin_jurados: no se encontró ningún jurado activo para este rodeo, no se puede publicar';
    END IF;

    -- ── 8. Marcar evaluación como publicada ────────────────────────────────────
    UPDATE evaluaciones SET
        estado         = 'publicado',
        nota_publicada = TRUE,
        updated_at     = NOW()
    WHERE id = p_evaluacion_id;

    -- ── 9. Auditoría de publicación ────────────────────────────────────────────
    INSERT INTO evaluacion_auditoria (
        evaluacion_id, accion, detalle,
        actor_id, actor_tipo, ip_address
    ) VALUES (
        p_evaluacion_id,
        'publicar_nota',
        jsonb_build_object(
            'puntaje_final',                v_puntaje_final,
            'nota_final',                   v_nota_final,
            'jurados_afectados',            v_jurados_count,
            'sobreescrituras_nota_manual',  v_sobreescrituras
        ),
        p_jefe_id, 'administrador', v_ip_inet
    );

    -- ── 10. Retornar resultado ─────────────────────────────────────────────────
    RETURN jsonb_build_object(
        'ok',                           TRUE,
        'puntaje_final',                v_puntaje_final,
        'nota_final',                   v_nota_final,
        'jurados_afectados',            v_jurados_count,
        'sobreescrituras_nota_manual',  v_sobreescrituras
    );

EXCEPTION WHEN OTHERS THEN
    -- El bloque plpgsql hace rollback automático al propagar la excepción.
    -- No se necesita rollback manual.
    RAISE;
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE E: Fila inicial de configuración
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO evaluacion_configuracion (
    puntaje_base,
    min_casos_ciclo1, max_casos_ciclo1,
    min_casos_ciclo2, max_casos_ciclo2
)
SELECT 80, 0, 10, 8, 8
WHERE NOT EXISTS (
    SELECT 1 FROM evaluacion_configuracion WHERE activo = TRUE
);


-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
    RAISE NOTICE '=== RESULTADO MIGRACIÓN 019 ===';
    RAISE NOTICE 'evaluacion_configuracion:        %', (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'evaluacion_configuracion'));
    RAISE NOTICE 'evaluaciones:                    %', (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'evaluaciones'));
    RAISE NOTICE 'evaluacion_ciclos:               %', (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'evaluacion_ciclos'));
    RAISE NOTICE 'evaluacion_casos:                %', (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'evaluacion_casos'));
    RAISE NOTICE 'evaluacion_respuestas_jurado:    %', (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'evaluacion_respuestas_jurado'));
    RAISE NOTICE 'evaluacion_comentarios_finales:  %', (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'evaluacion_comentarios_finales'));
    RAISE NOTICE 'evaluacion_auditoria:            %', (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'evaluacion_auditoria'));
    RAISE NOTICE 'Función publicar_evaluacion():   %', (SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'publicar_evaluacion'));
    RAISE NOTICE 'Col. administradores.rol_evaluacion: %', (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'administradores' AND column_name = 'rol_evaluacion'));
    RAISE NOTICE 'Col. notas_rodeo.fuente:             %', (SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'notas_rodeo' AND column_name = 'fuente'));
    RAISE NOTICE '✓ Módulo Evaluación Técnica — Paso 1 (migration 019) completado.';
END $$;

COMMIT;
