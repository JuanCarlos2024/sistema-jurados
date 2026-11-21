-- ═════════════════════════════════════════════════════════════════════════
-- 103: Revisiones de Comisión Técnica (Tipo A: resultados alterados del
--      Ciclo 1; Tipo B: casos/videos derivados por el analista) y bloqueo
--      transaccional de la publicación de notas mientras existan revisiones
--      pendientes.
--
-- ADITIVA. No modifica ninguna fila existente, no crea revisiones históricas
-- (la regularización de las evaluaciones en curso es un procedimiento
-- separado: database/maintenance/019_regularizar_revisiones_resultado_
-- alterado.sql) y no toca notas publicadas.
--
-- Contenido:
--   1. Tabla evaluacion_revisiones_comision (solo Tipo A). El Tipo B sigue
--      viviendo en evaluacion_casos (decision_analista='derivar_comision',
--      estado 'derivado_comision', decision_comision) — así la decisión sobre
--      el resultado alterado y la resolución de un descuento individual
--      quedan en tablas distintas, sin duplicar nada.
--   2. Trigger en evaluacion_casos: un caso derivado por el analista no
--      puede pasar a otro estado sin decisión de la Comisión (salvo anulación
--      explícita del caso). Cierra el camino por el que /aprobar y /finalizar
--      (sincronización previa de casos) resolvían casos derivados sin
--      Comisión.
--   3. Trigger en evaluaciones: con una revisión Tipo A ya RESUELTA, el
--      indicador y el comentario de alteración no pueden cambiar; con una
--      PENDIENTE, no se puede desmarcar sin anularla primero (vía RPC).
--   4. RPC generar_revision_resultado_alterado (idempotente).
--   5. RPC resolver_revision_resultado_alterado (ERROR / ACIERTO, sin efecto
--      en puntos: no existe regla de descuento para la alteración).
--   6. RPC anular_revision_resultado_alterado (solo pendientes).
--   7. RPC resolver_caso_derivado_comision (ERROR = mantiene el descuento;
--      ACIERTO = lo excluye). Reutiliza las columnas existentes:
--        ERROR   → decision_comision 'rechaza_apelacion', resolucion_final
--                  'apelacion_rechazada' (ya suma en publicar_evaluacion)
--        ACIERTO → decision_comision 'aprueba_apelacion', resolucion_final
--                  'apelacion_acogida' (no suma)
--   8. publicar_evaluacion: MISMO cuerpo que producción (verificado
--      2026-11-18) + un único bloque nuevo que rechaza publicar con
--      revisiones Tipo A pendientes o con resultados alterados sin revisión
--      resuelta. El cálculo de la nota no cambia.
--   8b. CIERRE EXCEPCIONAL — ADMINISTRADOR (cierre_excepcional_comision_admin):
--      salida auditada cuando la Comisión no responde. Trata formalmente los
--      pendientes (Tipo A → 'cierre_excepcional' sin puntos; Tipo B →
--      decisión administrativa expresa por caso, en columnas propias) y deja
--      que el cierre normal de ciclos y publicar_evaluacion sigan su curso.
--      No hay parámetro "force": publicar_evaluacion sigue bloqueando todo
--      pendiente; solo reconoce 'cierre_excepcional' como tratamiento formal
--      de la alteración. Historial: evaluacion_cierres_excepcionales.
--   9. Privilegios: todo EXECUTE solo para service_role. Incluye revocar
--      publicar_evaluacion a anon/authenticated (hoy pueden ejecutarla vía
--      PostgREST y es SECURITY DEFINER).
--
-- Concurrencia: todas las RPC bloquean primero la fila de evaluaciones
-- (FOR UPDATE), igual que publicar_evaluacion — una publicación, una
-- generación y una resolución simultáneas sobre la misma evaluación se
-- serializan.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 0. Cierres excepcionales del Administrador (historial permanente) ─────
-- Una fila por cada CIERRE EXCEPCIONAL — ADMINISTRADOR: quién, cuándo, por
-- qué, qué estaba pendiente de la Comisión, cómo se trató cada revisión,
-- qué descuentos se consideraron y, después del intento de publicación
-- habitual, el resultado (nota, publicación). Nunca se borra.
CREATE TABLE IF NOT EXISTS public.evaluacion_cierres_excepcionales (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    evaluacion_id       UUID        NOT NULL REFERENCES public.evaluaciones(id),
    administrador_id    UUID        NOT NULL REFERENCES public.administradores(id),
    motivo              TEXT        NOT NULL CHECK (length(btrim(motivo)) > 0),
    pendientes          JSONB       NOT NULL,   -- revisiones pendientes al momento de cerrar
    tratamiento         JSONB       NOT NULL,   -- tratamiento de cada una (y descuento considerado)
    ciclos              JSONB       NOT NULL,   -- estado de los ciclos al momento de cerrar
    resultado           JSONB,                  -- completado tras el intento de publicación habitual
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cierres_excepcionales_evaluacion
    ON public.evaluacion_cierres_excepcionales (evaluacion_id, created_at DESC);
ALTER TABLE public.evaluacion_cierres_excepcionales ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.evaluacion_cierres_excepcionales FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.evaluacion_cierres_excepcionales TO service_role;

-- ─── 1. Tabla de revisiones Tipo A ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.evaluacion_revisiones_comision (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    evaluacion_id           UUID        NOT NULL REFERENCES public.evaluaciones(id),
    ciclo_id                UUID        REFERENCES public.evaluacion_ciclos(id),
    tipo                    TEXT        NOT NULL DEFAULT 'resultado_alterado'
        CHECK (tipo IN ('resultado_alterado')),
    -- 'cierre_excepcional': cerrada por el Administrador sin respuesta de la
    -- Comisión (nunca se inventa una decisión ERROR/ACIERTO de la Comisión).
    estado                  TEXT        NOT NULL DEFAULT 'pendiente'
        CHECK (estado IN ('pendiente', 'resuelta', 'anulada', 'cierre_excepcional')),
    -- Antecedentes del analista al momento de derivar (snapshot, nunca se edita)
    analista_id             UUID        REFERENCES public.administradores(id),
    comentario_alteracion   TEXT,
    origen                  TEXT        NOT NULL
        CHECK (origen IN ('cierre_ciclo_1', 'datos_deportivos', 'previo_publicacion', 'regularizacion')),
    creada_por              UUID        NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Decisión de la Comisión
    decision                TEXT        CHECK (decision IN ('error', 'acierto')),
    observacion_comision    TEXT,
    resuelto_por            UUID        REFERENCES public.administradores(id),
    resuelto_en             TIMESTAMPTZ,
    -- Anulación (solo de pendientes)
    anulada_por             UUID,
    anulada_en              TIMESTAMPTZ,
    motivo_anulacion        TEXT,
    -- Cierre excepcional del Administrador (sin respuesta de la Comisión)
    cierre_excepcional_id   UUID        REFERENCES public.evaluacion_cierres_excepcionales(id),
    cierre_admin_por        UUID        REFERENCES public.administradores(id),
    cierre_admin_en         TIMESTAMPTZ,
    cierre_admin_motivo     TEXT,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_revision_resuelta CHECK (
        estado <> 'resuelta' OR (
            decision IS NOT NULL AND resuelto_por IS NOT NULL AND resuelto_en IS NOT NULL
            AND observacion_comision IS NOT NULL AND length(btrim(observacion_comision)) > 0
        )
    ),
    CONSTRAINT chk_revision_pendiente CHECK (
        estado <> 'pendiente' OR (decision IS NULL AND resuelto_por IS NULL AND resuelto_en IS NULL)
    ),
    CONSTRAINT chk_revision_anulada CHECK (
        estado <> 'anulada' OR (
            decision IS NULL AND anulada_por IS NOT NULL AND anulada_en IS NOT NULL
            AND motivo_anulacion IS NOT NULL AND length(btrim(motivo_anulacion)) > 0
        )
    ),
    CONSTRAINT chk_revision_cierre_excepcional CHECK (
        estado <> 'cierre_excepcional' OR (
            decision IS NULL AND resuelto_por IS NULL
            AND cierre_excepcional_id IS NOT NULL AND cierre_admin_por IS NOT NULL AND cierre_admin_en IS NOT NULL
            AND cierre_admin_motivo IS NOT NULL AND length(btrim(cierre_admin_motivo)) > 0
        )
    )
);

-- ─── 1b. Casos derivados: decisión ADMINISTRATIVA separada de la Comisión ──
-- En un cierre excepcional el Administrador decide expresamente cada caso
-- derivado sin respuesta: ERROR (se mantiene el descuento) o ACIERTO (se
-- excluye). Se guarda en columnas propias — decision_comision/comision_
-- miembro_id quedan NULL: nunca se atribuye a la Comisión. El cálculo de la
-- nota reutiliza resolucion_final ('apelacion_rechazada' / 'apelacion_acogida')
-- igual que una decisión de Comisión: una sola fórmula. Columnas nuevas y
-- opcionales: ninguna fila existente cambia.
ALTER TABLE public.evaluacion_casos
    ADD COLUMN IF NOT EXISTS decision_admin_excepcional TEXT
        CHECK (decision_admin_excepcional IN ('error', 'acierto')),
    ADD COLUMN IF NOT EXISTS admin_excepcional_por UUID REFERENCES public.administradores(id),
    ADD COLUMN IF NOT EXISTS admin_excepcional_en  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS motivo_admin_excepcional TEXT,
    ADD COLUMN IF NOT EXISTS cierre_excepcional_id UUID REFERENCES public.evaluacion_cierres_excepcionales(id);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_caso_decision_admin_excepcional') THEN
        ALTER TABLE public.evaluacion_casos ADD CONSTRAINT chk_caso_decision_admin_excepcional CHECK (
            decision_admin_excepcional IS NULL OR (
                admin_excepcional_por IS NOT NULL AND admin_excepcional_en IS NOT NULL
                AND cierre_excepcional_id IS NOT NULL
                AND motivo_admin_excepcional IS NOT NULL AND length(btrim(motivo_admin_excepcional)) > 0
                AND decision_comision IS NULL
            )
        );
    END IF;
END $$;

-- A lo sumo UNA revisión vigente (pendiente o resuelta) por evaluación y
-- tipo: guardar o cerrar de nuevo nunca duplica. Una anulada no cuenta (si
-- el analista vuelve a marcar la alteración, nace una nueva).
CREATE UNIQUE INDEX IF NOT EXISTS uq_revision_comision_vigente
    ON public.evaluacion_revisiones_comision (evaluacion_id, tipo)
    WHERE estado <> 'anulada';
CREATE INDEX IF NOT EXISTS idx_revision_comision_estado
    ON public.evaluacion_revisiones_comision (estado);

ALTER TABLE public.evaluacion_revisiones_comision ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.evaluacion_revisiones_comision FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.evaluacion_revisiones_comision TO service_role;

COMMENT ON TABLE public.evaluacion_revisiones_comision IS
    'Migración 103: revisión obligatoria de la Comisión Técnica sobre resultados alterados (Ciclo 1). ERROR/ACIERTO valida el hallazgo; no aplica descuentos (no existe regla de puntos para la alteración). Los casos derivados (Tipo B) siguen en evaluacion_casos.';

-- ─── 2. Caso derivado: solo la Comisión (o la anulación) lo saca ───────────
-- Marca de transacción que SOLO activa cierre_excepcional_comision_admin
-- (set_config(..., true) = local a la transacción): sin ella, nadie puede
-- escribir una decisión administrativa excepcional ni el estado
-- 'cierre_excepcional', aunque tenga acceso a la tabla.
CREATE OR REPLACE FUNCTION public._en_cierre_excepcional_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(current_setting('app.cierre_excepcional_admin', true), '') = 'on';
$$;

CREATE OR REPLACE FUNCTION public.fn_proteger_caso_derivado_comision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    -- La decisión administrativa excepcional solo la escribe el cierre excepcional.
    IF NEW.decision_admin_excepcional IS DISTINCT FROM OLD.decision_admin_excepcional
       AND NOT public._en_cierre_excepcional_admin() THEN
        RAISE EXCEPTION 'DECISION_ADMIN_SOLO_POR_CIERRE_EXCEPCIONAL';
    END IF;

    IF OLD.estado = 'derivado_comision'
       AND OLD.decision_analista = 'derivar_comision'
       AND NEW.estado IS DISTINCT FROM 'derivado_comision'
       AND NOT COALESCE(NEW.anulado, false)
       AND NEW.decision_comision IS NULL
       AND NOT (NEW.decision_admin_excepcional IS NOT NULL AND public._en_cierre_excepcional_admin()) THEN
        RAISE EXCEPTION 'CASO_DERIVADO_REQUIERE_COMISION: el caso % fue derivado a Comisión y solo puede resolverse con su decisión (o un cierre excepcional del Administrador)', OLD.id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_proteger_caso_derivado_comision ON public.evaluacion_casos;
CREATE TRIGGER trg_proteger_caso_derivado_comision
    BEFORE UPDATE ON public.evaluacion_casos
    FOR EACH ROW EXECUTE FUNCTION public.fn_proteger_caso_derivado_comision();

-- Revisión Tipo A: el estado 'cierre_excepcional' solo lo pone el cierre
-- excepcional, y una vez cerrada (o resuelta) no vuelve atrás.
CREATE OR REPLACE FUNCTION public.fn_proteger_revision_comision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.estado = 'cierre_excepcional' AND OLD.estado IS DISTINCT FROM 'cierre_excepcional'
       AND NOT public._en_cierre_excepcional_admin() THEN
        RAISE EXCEPTION 'CIERRE_EXCEPCIONAL_SOLO_POR_ADMIN';
    END IF;
    IF OLD.estado IN ('resuelta', 'cierre_excepcional', 'anulada') AND NEW.estado IS DISTINCT FROM OLD.estado THEN
        RAISE EXCEPTION 'REVISION_CERRADA: una revisión % no cambia de estado', OLD.estado;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_proteger_revision_comision ON public.evaluacion_revisiones_comision;
CREATE TRIGGER trg_proteger_revision_comision
    BEFORE UPDATE ON public.evaluacion_revisiones_comision
    FOR EACH ROW EXECUTE FUNCTION public.fn_proteger_revision_comision();

-- ─── 3. Alteración ya revisada: no se cambia en silencio ───────────────────
CREATE OR REPLACE FUNCTION public.fn_proteger_alteracion_revisada()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_estado TEXT;
BEGIN
    IF NEW.resultados_alterados IS NOT DISTINCT FROM OLD.resultados_alterados
       AND NEW.comentario_resultados_alterados IS NOT DISTINCT FROM OLD.comentario_resultados_alterados THEN
        RETURN NEW;
    END IF;

    SELECT estado INTO v_estado FROM evaluacion_revisiones_comision
        WHERE evaluacion_id = NEW.id AND tipo = 'resultado_alterado' AND estado <> 'anulada';

    IF v_estado IN ('resuelta', 'cierre_excepcional') THEN
        RAISE EXCEPTION 'ALTERACION_YA_REVISADA: la revisión de resultados alterados de esta evaluación ya fue cerrada (por la Comisión o por cierre excepcional del Administrador)';
    END IF;
    IF v_estado = 'pendiente' AND NOT COALESCE(NEW.resultados_alterados, false) THEN
        RAISE EXCEPTION 'REVISION_PENDIENTE_SIN_ANULAR: anule la revisión pendiente antes de desmarcar los resultados alterados';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_proteger_alteracion_revisada ON public.evaluaciones;
CREATE TRIGGER trg_proteger_alteracion_revisada
    BEFORE UPDATE OF resultados_alterados, comentario_resultados_alterados ON public.evaluaciones
    FOR EACH ROW EXECUTE FUNCTION public.fn_proteger_alteracion_revisada();

-- ─── 4. Generar la revisión Tipo A (idempotente) ───────────────────────────
CREATE OR REPLACE FUNCTION public.generar_revision_resultado_alterado(
    p_evaluacion_id UUID,
    p_actor_id      UUID,
    p_origen        TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_eval      evaluaciones%ROWTYPE;
    v_ciclo     evaluacion_ciclos%ROWTYPE;
    v_existente evaluacion_revisiones_comision%ROWTYPE;
    v_id        UUID;
BEGIN
    IF p_actor_id IS NULL THEN RAISE EXCEPTION 'ACTOR_REQUERIDO'; END IF;

    SELECT * INTO v_eval FROM evaluaciones WHERE id = p_evaluacion_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'EVALUACION_NO_ENCONTRADA'; END IF;

    IF COALESCE(v_eval.anulada, false) OR COALESCE(v_eval.es_historica_importacion, false) THEN
        RETURN jsonb_build_object('creada', false, 'motivo', 'no_aplica');
    END IF;
    -- Nunca retroactivo sobre notas ya aprobadas/publicadas/cerradas.
    IF v_eval.estado IN ('aprobado', 'publicado', 'cerrado') THEN
        RETURN jsonb_build_object('creada', false, 'motivo', 'evaluacion_publicada');
    END IF;
    IF NOT COALESCE(v_eval.resultados_alterados, false) THEN
        RETURN jsonb_build_object('creada', false, 'motivo', 'sin_alteracion');
    END IF;

    SELECT * INTO v_ciclo FROM evaluacion_ciclos
        WHERE evaluacion_id = p_evaluacion_id AND numero_ciclo = 1;
    IF NOT FOUND OR v_ciclo.estado IS DISTINCT FROM 'cerrado' THEN
        RETURN jsonb_build_object('creada', false, 'motivo', 'ciclo_1_no_cerrado');
    END IF;

    SELECT * INTO v_existente FROM evaluacion_revisiones_comision
        WHERE evaluacion_id = p_evaluacion_id AND tipo = 'resultado_alterado' AND estado <> 'anulada';
    IF FOUND THEN
        RETURN jsonb_build_object('creada', false, 'motivo', 'ya_existe', 'revision_id', v_existente.id, 'estado', v_existente.estado);
    END IF;

    INSERT INTO evaluacion_revisiones_comision (
        evaluacion_id, ciclo_id, tipo, estado, analista_id, comentario_alteracion, origen, creada_por
    ) VALUES (
        p_evaluacion_id, v_ciclo.id, 'resultado_alterado', 'pendiente',
        v_eval.analista_id, v_eval.comentario_resultados_alterados, p_origen, p_actor_id
    ) RETURNING id INTO v_id;

    -- Mismo estado que ya usa la derivación de casos (análisis terminado
    -- con revisión de Comisión pendiente).
    IF v_eval.estado IN ('borrador', 'en_proceso', 'devuelto') THEN
        UPDATE evaluaciones SET estado = 'pendiente_comision', updated_at = now() WHERE id = p_evaluacion_id;
    END IF;

    INSERT INTO evaluacion_auditoria (evaluacion_id, ciclo_id, accion, detalle, actor_id, actor_tipo)
    VALUES (p_evaluacion_id, v_ciclo.id, 'derivar_comision_resultado_alterado',
            jsonb_build_object('revision_id', v_id, 'origen', p_origen, 'estado_evaluacion_anterior', v_eval.estado),
            p_actor_id, 'administrador');

    RETURN jsonb_build_object('creada', true, 'revision_id', v_id);
END;
$$;

-- Cuenta revisiones pendientes de una evaluación (Tipo A + Tipo B).
CREATE OR REPLACE FUNCTION public._pendientes_comision_evaluacion(p_evaluacion_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT
        (SELECT count(*) FROM evaluacion_revisiones_comision
            WHERE evaluacion_id = p_evaluacion_id AND estado = 'pendiente')::int
      + (SELECT count(*) FROM evaluacion_casos
            WHERE evaluacion_id = p_evaluacion_id AND estado = 'derivado_comision'
              AND NOT COALESCE(anulado, false))::int;
$$;

-- ─── 5. Resolver la revisión Tipo A ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.resolver_revision_resultado_alterado(
    p_revision_id UUID,
    p_decision    TEXT,
    p_observacion TEXT,
    p_actor_id    UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_eval_id UUID;
    v_eval    evaluaciones%ROWTYPE;
    v_rev     evaluacion_revisiones_comision%ROWTYPE;
    v_obs     TEXT := btrim(COALESCE(p_observacion, ''));
BEGIN
    IF p_actor_id IS NULL THEN RAISE EXCEPTION 'ACTOR_REQUERIDO'; END IF;
    IF p_decision IS NULL OR p_decision NOT IN ('error', 'acierto') THEN RAISE EXCEPTION 'DECISION_INVALIDA'; END IF;
    IF v_obs = '' THEN RAISE EXCEPTION 'OBSERVACION_REQUERIDA'; END IF;

    SELECT evaluacion_id INTO v_eval_id FROM evaluacion_revisiones_comision WHERE id = p_revision_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'REVISION_NO_ENCONTRADA'; END IF;

    -- Mismo orden de bloqueo que publicar_evaluacion: evaluación primero.
    SELECT * INTO v_eval FROM evaluaciones WHERE id = v_eval_id FOR UPDATE;
    SELECT * INTO v_rev FROM evaluacion_revisiones_comision WHERE id = p_revision_id FOR UPDATE;

    IF v_rev.estado = 'resuelta' THEN RAISE EXCEPTION 'REVISION_YA_RESUELTA'; END IF;
    IF v_rev.estado = 'anulada'  THEN RAISE EXCEPTION 'REVISION_ANULADA'; END IF;
    -- Cerrada por el Administrador: una respuesta tardía de la Comisión no
    -- la reabre, no cambia la nota y no dispara otra publicación.
    IF v_rev.estado = 'cierre_excepcional' THEN RAISE EXCEPTION 'REVISION_CERRADA_EXCEPCIONAL'; END IF;
    IF v_eval.estado IN ('aprobado', 'publicado', 'cerrado') THEN RAISE EXCEPTION 'EVALUACION_PUBLICADA'; END IF;

    UPDATE evaluacion_revisiones_comision SET
        estado = 'resuelta', decision = p_decision, observacion_comision = v_obs,
        resuelto_por = p_actor_id, resuelto_en = now(), updated_at = now()
    WHERE id = p_revision_id;

    INSERT INTO evaluacion_auditoria (evaluacion_id, ciclo_id, accion, detalle, actor_id, actor_tipo)
    VALUES (v_eval_id, v_rev.ciclo_id, 'decision_comision_resultado_alterado',
            jsonb_build_object('revision_id', p_revision_id, 'decision', p_decision, 'observacion', v_obs),
            p_actor_id, 'administrador');

    RETURN jsonb_build_object('evaluacion_id', v_eval_id, 'revision_id', p_revision_id,
                              'pendientes_restantes', public._pendientes_comision_evaluacion(v_eval_id));
END;
$$;

-- ─── 6. Anular una revisión Tipo A pendiente (el analista desmarca) ────────
CREATE OR REPLACE FUNCTION public.anular_revision_resultado_alterado(
    p_evaluacion_id UUID,
    p_actor_id      UUID,
    p_motivo        TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_eval   evaluaciones%ROWTYPE;
    v_rev    evaluacion_revisiones_comision%ROWTYPE;
    v_motivo TEXT := btrim(COALESCE(p_motivo, ''));
BEGIN
    IF p_actor_id IS NULL THEN RAISE EXCEPTION 'ACTOR_REQUERIDO'; END IF;
    IF v_motivo = '' THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;

    SELECT * INTO v_eval FROM evaluaciones WHERE id = p_evaluacion_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'EVALUACION_NO_ENCONTRADA'; END IF;

    SELECT * INTO v_rev FROM evaluacion_revisiones_comision
        WHERE evaluacion_id = p_evaluacion_id AND tipo = 'resultado_alterado' AND estado <> 'anulada'
        FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('anulada', false, 'motivo', 'sin_revision'); END IF;
    IF v_rev.estado IN ('resuelta', 'cierre_excepcional') THEN RAISE EXCEPTION 'REVISION_YA_RESUELTA'; END IF;

    UPDATE evaluacion_revisiones_comision SET
        estado = 'anulada', anulada_por = p_actor_id, anulada_en = now(),
        motivo_anulacion = v_motivo, updated_at = now()
    WHERE id = v_rev.id;

    -- Si ya no queda nada pendiente para la Comisión, la evaluación vuelve a
    -- análisis en curso (mismo criterio que la resolución de casos).
    IF v_eval.estado = 'pendiente_comision' AND public._pendientes_comision_evaluacion(p_evaluacion_id) = 0 THEN
        UPDATE evaluaciones SET estado = 'en_proceso', updated_at = now() WHERE id = p_evaluacion_id;
    END IF;

    INSERT INTO evaluacion_auditoria (evaluacion_id, ciclo_id, accion, detalle, actor_id, actor_tipo)
    VALUES (p_evaluacion_id, v_rev.ciclo_id, 'anular_revision_resultado_alterado',
            jsonb_build_object('revision_id', v_rev.id, 'motivo', v_motivo),
            p_actor_id, 'administrador');

    RETURN jsonb_build_object('anulada', true, 'revision_id', v_rev.id);
END;
$$;

-- ─── 7. Resolver un caso derivado (Tipo B) ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.resolver_caso_derivado_comision(
    p_caso_id     UUID,
    p_decision    TEXT,
    p_observacion TEXT,
    p_actor_id    UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_eval_id   UUID;
    v_eval      evaluaciones%ROWTYPE;
    v_caso      evaluacion_casos%ROWTYPE;
    v_obs       TEXT := btrim(COALESCE(p_observacion, ''));
    v_dec_com   TEXT;
    v_resol     TEXT;
BEGIN
    IF p_actor_id IS NULL THEN RAISE EXCEPTION 'ACTOR_REQUERIDO'; END IF;
    IF p_decision IS NULL OR p_decision NOT IN ('error', 'acierto') THEN RAISE EXCEPTION 'DECISION_INVALIDA'; END IF;
    IF v_obs = '' THEN RAISE EXCEPTION 'OBSERVACION_REQUERIDA'; END IF;

    SELECT evaluacion_id INTO v_eval_id FROM evaluacion_casos WHERE id = p_caso_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'CASO_NO_ENCONTRADO'; END IF;

    SELECT * INTO v_eval FROM evaluaciones WHERE id = v_eval_id FOR UPDATE;
    SELECT * INTO v_caso FROM evaluacion_casos WHERE id = p_caso_id FOR UPDATE;

    IF COALESCE(v_caso.anulado, false) THEN RAISE EXCEPTION 'CASO_ANULADO'; END IF;
    IF v_caso.decision_admin_excepcional IS NOT NULL THEN RAISE EXCEPTION 'CASO_CERRADO_EXCEPCIONAL'; END IF;
    IF v_caso.estado IS DISTINCT FROM 'derivado_comision' THEN
        RAISE EXCEPTION 'CASO_NO_DERIVADO: estado actual %', v_caso.estado;
    END IF;
    IF v_eval.estado IN ('aprobado', 'publicado', 'cerrado') THEN RAISE EXCEPTION 'EVALUACION_PUBLICADA'; END IF;

    -- ERROR: hubo error del jurado → se mantiene el descuento.
    -- ACIERTO: el jurado actuó bien → el descuento se excluye.
    IF p_decision = 'error' THEN
        v_dec_com := 'rechaza_apelacion'; v_resol := 'apelacion_rechazada';
    ELSE
        v_dec_com := 'aprueba_apelacion'; v_resol := 'apelacion_acogida';
    END IF;

    UPDATE evaluacion_casos SET
        decision_comision   = v_dec_com,
        comentario_comision = v_obs,
        comision_decidio_en = now(),
        comision_miembro_id = p_actor_id,
        estado              = 'resuelto',
        resolucion_final    = v_resol,
        updated_at          = now()
    WHERE id = p_caso_id;

    INSERT INTO evaluacion_auditoria (evaluacion_id, ciclo_id, caso_id, accion, detalle, actor_id, actor_tipo)
    VALUES (v_eval_id, v_caso.ciclo_id, p_caso_id, 'decision_comision',
            jsonb_build_object('decision', v_dec_com, 'decision_visible', p_decision,
                               'resolucion_final', v_resol, 'descuento_puntos', v_caso.descuento_puntos,
                               'descuento_validado', CASE WHEN p_decision = 'error' THEN v_caso.descuento_puntos ELSE 0 END),
            p_actor_id, 'administrador');

    RETURN jsonb_build_object('evaluacion_id', v_eval_id, 'ciclo_id', v_caso.ciclo_id, 'caso_id', p_caso_id,
                              'resolucion_final', v_resol,
                              'pendientes_restantes', public._pendientes_comision_evaluacion(v_eval_id));
END;
$$;

-- ─── 7b. CIERRE EXCEPCIONAL — ADMINISTRADOR ────────────────────────────────
-- Salida excepcional cuando la Comisión no responde. NO publica ni salta
-- ningún control: trata FORMALMENTE, en una transacción, todas las
-- revisiones de Comisión pendientes de la evaluación —
--   · Tipo A (resultado alterado): estado 'cierre_excepcional', sin decisión
--     ERROR/ACIERTO (nunca se inventa una de la Comisión) y sin puntos;
--     indicador, comentario y videos del analista quedan intactos.
--   · Tipo B (caso derivado): EXIGE una decisión expresa del Administrador
--     por cada caso pendiente (p_decisiones = [{caso_id, decision}]):
--       error   → resolucion_final 'apelacion_rechazada' (se mantiene el descuento)
--       acierto → resolucion_final 'apelacion_acogida'   (se excluye)
--     guardada en decision_admin_excepcional (no en decision_comision).
-- Después, el backend cierra los ciclos con el procedimiento NORMAL y llama a
-- la publicación automática habitual: publicar_evaluacion (mismo cálculo,
-- mismos controles) decide si corresponde publicar.
-- Permiso verificado AQUÍ además de en el backend: p_admin_id debe ser un
-- administrador ACTIVO sin rol_evaluacion (Administrador pleno). EXECUTE solo
-- service_role (nunca anon/authenticated).
CREATE OR REPLACE FUNCTION public.cierre_excepcional_comision_admin(
    p_evaluacion_id UUID,
    p_admin_id      UUID,
    p_motivo        TEXT,
    p_decisiones    JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_motivo      TEXT := btrim(COALESCE(p_motivo, ''));
    v_eval        evaluaciones%ROWTYPE;
    v_ok_admin    BOOLEAN;
    v_pend_a      JSONB;
    v_pend_b      JSONB;
    v_ids_b       UUID[];
    v_dec         JSONB := COALESCE(p_decisiones, '[]'::jsonb);
    v_dec_ids     UUID[];
    v_item        JSONB;
    v_ciclos      JSONB;
    v_trat_a      JSONB;
    v_trat_b      JSONB;
    v_cierre_id   UUID;
    v_desc_total  INTEGER;
BEGIN
    -- 1. Permiso real en la base: Administrador pleno y activo.
    SELECT (rol_evaluacion IS NULL AND COALESCE(activo, false)) INTO v_ok_admin
        FROM administradores WHERE id = p_admin_id;
    IF NOT COALESCE(v_ok_admin, false) THEN RAISE EXCEPTION 'ADMIN_NO_AUTORIZADO'; END IF;
    IF v_motivo = '' THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;
    IF length(v_motivo) > 2000 THEN RAISE EXCEPTION 'MOTIVO_DEMASIADO_LARGO'; END IF;
    IF jsonb_typeof(v_dec) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'DECISIONES_TIPO_B_INVALIDAS'; END IF;

    -- 2. Evaluación bloqueada (mismo orden que publicar y resolver).
    SELECT * INTO v_eval FROM evaluaciones WHERE id = p_evaluacion_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'EVALUACION_NO_ENCONTRADA'; END IF;
    IF COALESCE(v_eval.anulada, false) OR COALESCE(v_eval.es_historica_importacion, false) THEN
        RAISE EXCEPTION 'EVALUACION_NO_APLICA';
    END IF;
    IF v_eval.estado IN ('aprobado', 'publicado', 'cerrado') THEN RAISE EXCEPTION 'EVALUACION_PUBLICADA'; END IF;

    -- 3. Pendientes de la Comisión en este instante (bloqueados).
    PERFORM 1 FROM evaluacion_revisiones_comision
        WHERE evaluacion_id = p_evaluacion_id AND estado = 'pendiente' FOR UPDATE;
    PERFORM 1 FROM evaluacion_casos
        WHERE evaluacion_id = p_evaluacion_id AND estado = 'derivado_comision'
          AND decision_analista = 'derivar_comision' AND NOT COALESCE(anulado, false) FOR UPDATE;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('revision_id', r.id, 'tipo', r.tipo,
                'comentario_alteracion', r.comentario_alteracion, 'derivada_en', r.created_at) ORDER BY r.created_at), '[]'::jsonb)
        INTO v_pend_a
        FROM evaluacion_revisiones_comision r
        WHERE r.evaluacion_id = p_evaluacion_id AND r.estado = 'pendiente';

    SELECT COALESCE(jsonb_agg(jsonb_build_object('caso_id', c.id, 'numero_caso', c.numero_caso,
                'ciclo', cl.numero_ciclo, 'tipo_caso', c.tipo_caso, 'descuento_propuesto', c.descuento_puntos,
                'comentario_analista', c.comentario_analista, 'video_url', c.video_url,
                'derivado_en', c.analista_decidio_en) ORDER BY cl.numero_ciclo, c.numero_caso), '[]'::jsonb),
           COALESCE(array_agg(c.id), ARRAY[]::uuid[])
        INTO v_pend_b, v_ids_b
        FROM evaluacion_casos c JOIN evaluacion_ciclos cl ON cl.id = c.ciclo_id
        WHERE c.evaluacion_id = p_evaluacion_id AND c.estado = 'derivado_comision'
          AND c.decision_analista = 'derivar_comision' AND NOT COALESCE(c.anulado, false);

    IF jsonb_array_length(v_pend_a) = 0 AND jsonb_array_length(v_pend_b) = 0 THEN
        RAISE EXCEPTION 'SIN_PENDIENTES_COMISION';
    END IF;

    -- 4. Una decisión expresa por cada caso derivado pendiente: ni de más
    --    (p. ej. ya resuelto por la Comisión mientras tanto) ni de menos.
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_dec) LOOP
        IF jsonb_typeof(v_item) IS DISTINCT FROM 'object'
           OR (v_item->>'decision') IS NULL OR (v_item->>'decision') NOT IN ('error', 'acierto')
           OR (v_item->>'caso_id') IS NULL
           OR (v_item->>'caso_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'DECISIONES_TIPO_B_INVALIDAS';
        END IF;
    END LOOP;
    SELECT COALESCE(array_agg(DISTINCT (e->>'caso_id')::uuid), ARRAY[]::uuid[]) INTO v_dec_ids FROM jsonb_array_elements(v_dec) e;
    IF cardinality(v_dec_ids) <> jsonb_array_length(v_dec) THEN RAISE EXCEPTION 'DECISIONES_TIPO_B_INVALIDAS'; END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_dec_ids) d WHERE d <> ALL (v_ids_b)) THEN
        RAISE EXCEPTION 'DECISIONES_DESACTUALIZADAS';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_ids_b) b WHERE b <> ALL (v_dec_ids)) THEN
        RAISE EXCEPTION 'DECISIONES_TIPO_B_INCOMPLETAS';
    END IF;

    -- 5. Historial (cabecera) — antes de tocar nada, para referenciarlo.
    SELECT COALESCE(jsonb_agg(jsonb_build_object('ciclo_id', id, 'numero_ciclo', numero_ciclo, 'estado', estado) ORDER BY numero_ciclo), '[]'::jsonb)
        INTO v_ciclos FROM evaluacion_ciclos WHERE evaluacion_id = p_evaluacion_id;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('revision_id', x->>'revision_id', 'tratamiento', 'cierre_excepcional',
                'descuento_considerado', 0)), '[]'::jsonb)
        INTO v_trat_a FROM jsonb_array_elements(v_pend_a) x;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('caso_id', b->>'caso_id', 'decision_administrativa', d->>'decision',
                'descuento_propuesto', (b->>'descuento_propuesto')::int,
                'descuento_considerado', CASE WHEN d->>'decision' = 'error' THEN (b->>'descuento_propuesto')::int ELSE 0 END)), '[]'::jsonb)
        INTO v_trat_b
        FROM jsonb_array_elements(v_pend_b) b JOIN jsonb_array_elements(v_dec) d ON (d->>'caso_id') = (b->>'caso_id');
    SELECT COALESCE(sum((t->>'descuento_considerado')::int), 0) INTO v_desc_total FROM jsonb_array_elements(v_trat_b) t;

    INSERT INTO evaluacion_cierres_excepcionales (evaluacion_id, administrador_id, motivo, pendientes, tratamiento, ciclos)
    VALUES (p_evaluacion_id, p_admin_id, v_motivo,
            jsonb_build_object('resultado_alterado', v_pend_a, 'video_derivado', v_pend_b),
            jsonb_build_object('resultado_alterado', v_trat_a, 'video_derivado', v_trat_b,
                               'descuentos_considerados_total', v_desc_total),
            v_ciclos)
    RETURNING id INTO v_cierre_id;

    -- 6. Tratamiento formal (con la marca que habilitan los triggers).
    PERFORM set_config('app.cierre_excepcional_admin', 'on', true);

    UPDATE evaluacion_revisiones_comision SET
        estado = 'cierre_excepcional', cierre_excepcional_id = v_cierre_id,
        cierre_admin_por = p_admin_id, cierre_admin_en = now(), cierre_admin_motivo = v_motivo, updated_at = now()
    WHERE evaluacion_id = p_evaluacion_id AND estado = 'pendiente';

    UPDATE evaluacion_casos c SET
        estado                     = 'resuelto',
        resolucion_final           = CASE WHEN d.decision = 'error' THEN 'apelacion_rechazada' ELSE 'apelacion_acogida' END,
        decision_admin_excepcional = d.decision,
        admin_excepcional_por      = p_admin_id,
        admin_excepcional_en       = now(),
        motivo_admin_excepcional   = v_motivo,
        cierre_excepcional_id      = v_cierre_id,
        updated_at                 = now()
    FROM (SELECT (e->>'caso_id')::uuid AS caso_id, e->>'decision' AS decision FROM jsonb_array_elements(v_dec) e) d
    WHERE c.id = d.caso_id;

    PERFORM set_config('app.cierre_excepcional_admin', 'off', true);

    -- 7. Sin pendientes de Comisión: vuelve a análisis en curso (desde ahí
    --    sigue el cierre normal de ciclos y la publicación automática).
    IF v_eval.estado = 'pendiente_comision' AND public._pendientes_comision_evaluacion(p_evaluacion_id) = 0 THEN
        UPDATE evaluaciones SET estado = 'en_proceso', updated_at = now() WHERE id = p_evaluacion_id;
    END IF;

    INSERT INTO evaluacion_auditoria (evaluacion_id, accion, detalle, actor_id, actor_tipo)
    VALUES (p_evaluacion_id, 'cierre_excepcional_comision_admin',
            jsonb_build_object('cierre_id', v_cierre_id, 'motivo', v_motivo,
                               'pendientes', jsonb_build_object('resultado_alterado', v_pend_a, 'video_derivado', v_pend_b),
                               'tratamiento', jsonb_build_object('resultado_alterado', v_trat_a, 'video_derivado', v_trat_b),
                               'descuentos_considerados_total', v_desc_total, 'ciclos', v_ciclos,
                               'resuelto_por', 'administracion'),
            p_admin_id, 'administrador');

    RETURN jsonb_build_object('cierre_id', v_cierre_id, 'evaluacion_id', p_evaluacion_id,
                              'revisiones_resultado_alterado', jsonb_array_length(v_pend_a),
                              'casos_derivados', jsonb_array_length(v_pend_b),
                              'descuentos_considerados_total', v_desc_total,
                              'tratamiento', jsonb_build_object('resultado_alterado', v_trat_a, 'video_derivado', v_trat_b));
END;
$$;

-- ─── 8. publicar_evaluacion: mismo cuerpo de producción + bloqueo ──────────
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

    -- [103] Revisiones de Comisión Técnica: ninguna pendiente, y si hay
    -- resultados alterados debe existir su revisión ya resuelta.
    IF EXISTS (
        SELECT 1 FROM evaluacion_revisiones_comision
        WHERE evaluacion_id = p_evaluacion_id AND estado = 'pendiente'
    ) THEN
        RAISE EXCEPTION 'revisiones_comision_pendientes: existen revisiones de Comisión pendientes, no se puede publicar';
    END IF;

    IF COALESCE(v_eval.resultados_alterados, false) AND NOT EXISTS (
        SELECT 1 FROM evaluacion_revisiones_comision
        WHERE evaluacion_id = p_evaluacion_id AND tipo = 'resultado_alterado'
          AND estado IN ('resuelta', 'cierre_excepcional')
    ) THEN
        RAISE EXCEPTION 'revision_resultado_alterado_requerida: los resultados alterados deben ser revisados por la Comisión antes de publicar';
    END IF;
    -- [/103]

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

-- ─── 9. Privilegios ────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.publicar_evaluacion(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publicar_evaluacion(UUID, UUID, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.generar_revision_resultado_alterado(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generar_revision_resultado_alterado(UUID, UUID, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.resolver_revision_resultado_alterado(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolver_revision_resultado_alterado(UUID, TEXT, TEXT, UUID) TO service_role;
REVOKE ALL ON FUNCTION public.anular_revision_resultado_alterado(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anular_revision_resultado_alterado(UUID, UUID, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.resolver_caso_derivado_comision(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolver_caso_derivado_comision(UUID, TEXT, TEXT, UUID) TO service_role;
REVOKE ALL ON FUNCTION public._pendientes_comision_evaluacion(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._pendientes_comision_evaluacion(UUID) TO service_role;
REVOKE ALL ON FUNCTION public.cierre_excepcional_comision_admin(UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cierre_excepcional_comision_admin(UUID, UUID, TEXT, JSONB) TO service_role;
REVOKE ALL ON FUNCTION public._en_cierre_excepcional_admin() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._en_cierre_excepcional_admin() TO service_role;
-- Funciones de trigger: no se invocan directamente.
REVOKE ALL ON FUNCTION public.fn_proteger_caso_derivado_comision() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_proteger_alteracion_revisada() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_proteger_revision_comision() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Reversible (en este orden):
--   DROP FUNCTION IF EXISTS public.cierre_excepcional_comision_admin(UUID, UUID, TEXT, JSONB);
--   DROP TRIGGER IF EXISTS trg_proteger_revision_comision ON public.evaluacion_revisiones_comision;
--   DROP FUNCTION IF EXISTS public.fn_proteger_revision_comision();
--   ALTER TABLE public.evaluacion_casos DROP CONSTRAINT IF EXISTS chk_caso_decision_admin_excepcional;
--   ALTER TABLE public.evaluacion_casos DROP COLUMN IF EXISTS cierre_excepcional_id, DROP COLUMN IF EXISTS motivo_admin_excepcional,
--       DROP COLUMN IF EXISTS admin_excepcional_en, DROP COLUMN IF EXISTS admin_excepcional_por, DROP COLUMN IF EXISTS decision_admin_excepcional;
--       (solo si no hubo cierres excepcionales reales)
--   DROP TRIGGER IF EXISTS trg_proteger_alteracion_revisada ON public.evaluaciones;
--   DROP TRIGGER IF EXISTS trg_proteger_caso_derivado_comision ON public.evaluacion_casos;
--   DROP FUNCTION IF EXISTS public.resolver_caso_derivado_comision(UUID, TEXT, TEXT, UUID);
--   DROP FUNCTION IF EXISTS public.anular_revision_resultado_alterado(UUID, UUID, TEXT);
--   DROP FUNCTION IF EXISTS public.resolver_revision_resultado_alterado(UUID, TEXT, TEXT, UUID);
--   DROP FUNCTION IF EXISTS public.generar_revision_resultado_alterado(UUID, UUID, TEXT);
--   DROP FUNCTION IF EXISTS public._pendientes_comision_evaluacion(UUID);
--   DROP FUNCTION IF EXISTS public.fn_proteger_alteracion_revisada();
--   DROP FUNCTION IF EXISTS public.fn_proteger_caso_derivado_comision();
--   Restaurar publicar_evaluacion con el cuerpo previo (sin el bloque [103]).
--   DROP TABLE IF EXISTS public.evaluacion_revisiones_comision;  -- solo si no hay revisiones reales
