-- ═════════════════════════════════════════════════════════════════════════
-- 106: La observación de la Comisión Técnica pasa a ser OPCIONAL.
--
-- Sigue siendo obligatoria la decisión ERROR / ACIERTO. Si la Comisión
-- escribe una observación se guarda igual que antes; si la deja vacía se
-- guarda NULL (nunca un texto en blanco).
--
-- Cambia SOLO:
--   1. chk_revision_resuelta (Tipo A, de la 103): ya no exige observación.
--   2. chk_comentario_comision (Tipo B, de la 019): ya no exige comentario
--      cuando hay decisión de la Comisión; sigue prohibiendo textos en blanco.
--   3. resolver_revision_resultado_alterado y resolver_caso_derivado_comision:
--      sin OBSERVACION_REQUERIDA. Resto del cuerpo IDÉNTICO a la 103
--      (bloqueos, validaciones, significado de ERROR/ACIERTO, descuentos,
--      auditoría y retorno).
--
-- NO toca: datos existentes (no hay UPDATE), publicar_evaluacion, cálculo de
-- notas, cierre excepcional del Administrador, motivo obligatorio de
-- anulación (chk_revision_anulada) ni del cierre excepcional, ni los
-- privilegios (CREATE OR REPLACE conserva dueño y ACL; se reafirman abajo
-- igual que en la 103: solo service_role, nunca PUBLIC/anon/authenticated).
--
-- Requiere: 103 aplicada. Idempotente.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ─── 1. Tipo A: la revisión resuelta ya no exige observación ──────────────
ALTER TABLE public.evaluacion_revisiones_comision DROP CONSTRAINT IF EXISTS chk_revision_resuelta;
ALTER TABLE public.evaluacion_revisiones_comision ADD CONSTRAINT chk_revision_resuelta CHECK (
    estado <> 'resuelta' OR (
        decision IS NOT NULL AND resuelto_por IS NOT NULL AND resuelto_en IS NOT NULL
        AND (observacion_comision IS NULL OR length(btrim(observacion_comision)) > 0)
    )
);

-- ─── 2. Tipo B: la decisión de la Comisión ya no exige comentario ─────────
ALTER TABLE public.evaluacion_casos DROP CONSTRAINT IF EXISTS chk_comentario_comision;
ALTER TABLE public.evaluacion_casos ADD CONSTRAINT chk_comentario_comision CHECK (
    comentario_comision IS NULL OR length(trim(comentario_comision)) > 0
);

-- ─── 3. Resolver Tipo A (sin observación obligatoria) ─────────────────────
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
    v_obs     TEXT := NULLIF(btrim(COALESCE(p_observacion, '')), '');   -- 106: opcional
BEGIN
    IF p_actor_id IS NULL THEN RAISE EXCEPTION 'ACTOR_REQUERIDO'; END IF;
    IF p_decision IS NULL OR p_decision NOT IN ('error', 'acierto') THEN RAISE EXCEPTION 'DECISION_INVALIDA'; END IF;

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

-- ─── 4. Resolver Tipo B (sin observación obligatoria) ─────────────────────
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
    v_obs       TEXT := NULLIF(btrim(COALESCE(p_observacion, '')), '');   -- 106: opcional
    v_dec_com   TEXT;
    v_resol     TEXT;
BEGIN
    IF p_actor_id IS NULL THEN RAISE EXCEPTION 'ACTOR_REQUERIDO'; END IF;
    IF p_decision IS NULL OR p_decision NOT IN ('error', 'acierto') THEN RAISE EXCEPTION 'DECISION_INVALIDA'; END IF;

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

-- ─── 5. Privilegios (idénticos a la 103) ──────────────────────────────────
REVOKE ALL ON FUNCTION public.resolver_revision_resultado_alterado(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolver_revision_resultado_alterado(UUID, TEXT, TEXT, UUID) TO service_role;
REVOKE ALL ON FUNCTION public.resolver_caso_derivado_comision(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolver_caso_derivado_comision(UUID, TEXT, TEXT, UUID) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Verificación (solo lectura): ambas funciones sin 'OBSERVACION_REQUERIDA',
-- ACL {postgres=X, service_role=X}, y las dos restricciones con la nueva
-- definición:
--   SELECT proname, position('OBSERVACION_REQUERIDA' in prosrc) = 0 AS opcional, proacl
--     FROM pg_proc WHERE proname IN ('resolver_revision_resultado_alterado', 'resolver_caso_derivado_comision');
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname IN ('chk_revision_resuelta', 'chk_comentario_comision');
--
-- Reversión (solo con autorización; falla si ya existen decisiones sin
-- observación, que habría que completar antes): restaurar ambas funciones
-- desde la 103 y las restricciones originales de la 103 y la 019.
