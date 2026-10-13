-- ═════════════════════════════════════════════════════════════════════════
-- 080_notas_decimales_comision.sql
-- Comisión de Asociación (079): permitir notas con UN decimal (1.0–7.0) en
-- los cinco criterios individuales — Apiñadero, Cancha, Atajadas, Cuarta
-- Carrera y Movimiento a la Rienda —, hoy restringidos a enteros 1–7.
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — preparada localmente, pendiente de
-- autorización explícita para ejecutarse. La migración 079 (ya aplicada)
-- NO se modifica ni se repite: esta 080 solo ALTERA columnas/funciones ya
-- creadas por ella.
--
-- DECISIÓN 1 — Alcance exclusivo de Comisión de Asociación: solo se tocan
-- comision_evaluaciones_jurado.{nota_apinadero,nota_cancha,nota_atajadas,
-- nota_cuarta_carrera,nota_rienda} y las 3 funciones que los usan
-- (fn_calcular_nota_individual_comision, enviar_evaluacion_comision_jurado_
-- con_auditoria, corregir_evaluacion_individual_comision_con_auditoria).
-- Nunca se toca evaluaciones.* (Área Deportiva/Evaluación Técnica),
-- rodeo_notas_secundarias.{nota_comision,nota_delegado} (ya eran NUMERIC,
-- sin cambios) ni ninguna otra tabla — Nota Delegado y Nota Evaluación
-- Técnica quedan exactamente igual que antes.
--
-- DECISIÓN 2 — NUMERIC(2,1) (1 dígito entero + 1 decimal, rango real hasta
-- 9.9) en vez de NUMERIC(3,1): el CHECK existente (BETWEEN 1 AND 7, ya
-- presente desde 079 y que NO se recrea — sigue siendo válido sobre
-- NUMERIC sin cambios) seguirá acotando el rango real a 1.0–7.0; NUMERIC(2,1)
-- alcanza para esto sin margen de más dígitos enteros de los necesarios.
-- ALTER COLUMN ... TYPE usa USING columna::NUMERIC(2,1) — cast directo,
-- sin pérdida para los 40+ valores enteros 1–7 ya existentes (p.ej. 6 pasa
-- a almacenarse como 6.0, mismo valor).
--
-- DECISIÓN 3 — Redondeo/rechazo de más de 1 decimal NUNCA ocurre a nivel de
-- columna: NUMERIC(2,1) REDONDEA silenciosamente un valor con más
-- precisión (p.ej. 6.55 -> 6.6) en vez de rechazarlo, y eso NO es lo que se
-- pide (el pedido exige RECHAZAR, no redondear, un valor con más de un
-- decimal). Por eso esa validación vive exclusivamente en Express (ver
-- routes/institucional/comision.js y routes/admin/comisiones-asociacion.js)
-- ANTES de llamar a estas RPC — igual criterio que el resto del proyecto,
-- que nunca duplica en SQL lo que ya audita el backend (p.ej. rodeoDeMiAsociacion).
-- El CHECK de rango (1–7) sigue siendo responsabilidad de la base de datos,
-- como backstop real de concurrencia/integridad, igual que siempre.
--
-- DECISIÓN 4 — Mismo criterio de "sin sobrecargas" ya usado en 077/079: se
-- hace DROP FUNCTION IF EXISTS de la firma EXACTA anterior (con INTEGER)
-- antes de CREATE OR REPLACE con la firma nueva (con NUMERIC(2,1)) para las
-- 3 funciones afectadas — en todo momento existe EXACTAMENTE una función
-- con cada nombre. El hardening de privilegios (REVOKE/GRANT/ALTER
-- FUNCTION SET search_path) se reaplica explícitamente después de cada
-- DROP, igual que en 079 (un DROP limpia los GRANT anteriores). Los
-- CUERPOS de las 3 funciones quedan IDÉNTICOS a los de 079 — ningún
-- hallazgo de seguridad/concurrencia/permisos de esas rondas se reabre ni
-- se modifica, solo cambian los tipos de parámetro de las notas.
--
-- DECISIÓN 5 — Ponderaciones y redondeo final de fn_calcular_nota_
-- individual_comision NO cambian: la fórmula ya opera en aritmética NUMERIC
-- (los literales 0.16/0.24/etc. ya son NUMERIC), así que recibir los 5
-- criterios como NUMERIC(2,1) en vez de INTEGER no altera el resultado para
-- ningún valor entero ya evaluado (6 entero === 6.0 numeric en la fórmula).
-- Se mantiene el único round() final a 1 decimal, sin redondeos intermedios.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1) comision_evaluaciones_jurado — ancho de los 5 criterios, INTEGER -> NUMERIC(2,1).
--    Los CHECK existentes (BETWEEN 1 AND 7, y el de consistencia hubo_
--    movimiento_rienda/nota_rienda) NO se tocan — siguen siendo válidos tal
--    cual sobre el nuevo tipo, sin necesidad de recrearlos.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE comision_evaluaciones_jurado
    ALTER COLUMN nota_apinadero      TYPE NUMERIC(2,1) USING nota_apinadero::NUMERIC(2,1),
    ALTER COLUMN nota_cancha         TYPE NUMERIC(2,1) USING nota_cancha::NUMERIC(2,1),
    ALTER COLUMN nota_atajadas       TYPE NUMERIC(2,1) USING nota_atajadas::NUMERIC(2,1),
    ALTER COLUMN nota_cuarta_carrera TYPE NUMERIC(2,1) USING nota_cuarta_carrera::NUMERIC(2,1),
    ALTER COLUMN nota_rienda         TYPE NUMERIC(2,1) USING nota_rienda::NUMERIC(2,1);

COMMENT ON COLUMN comision_evaluaciones_jurado.nota_apinadero IS
    'Comisión de Asociación (080): nota 1.0-7.0 con un decimal (antes entero 1-7). Rango real acotado por el CHECK existente (BETWEEN 1 AND 7), sin cambios.';
COMMENT ON COLUMN comision_evaluaciones_jurado.nota_rienda IS
    'Comisión de Asociación (080): nota 1.0-7.0 con un decimal (antes entero 1-7), solo cuando hubo_movimiento_rienda=true (CHECK de consistencia existente, sin cambios).';

-- ─────────────────────────────────────────────────────────────────────────
-- 2) fn_calcular_nota_individual_comision — misma fórmula, parámetros ahora
--    NUMERIC(2,1). Cuerpo idéntico a 079: ningún cambio de ponderaciones ni
--    de redondeo.
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS fn_calcular_nota_individual_comision(INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, INTEGER);
CREATE OR REPLACE FUNCTION fn_calcular_nota_individual_comision(
    p_apinadero NUMERIC(2,1), p_cancha NUMERIC(2,1), p_atajadas NUMERIC(2,1), p_cuarta NUMERIC(2,1),
    p_hubo_rienda BOOLEAN, p_rienda NUMERIC(2,1)
) RETURNS NUMERIC(3,1) AS $$
BEGIN
    IF p_hubo_rienda THEN
        RETURN round((p_apinadero * 0.16 + p_cancha * 0.24 + p_atajadas * 0.32 + p_cuarta * 0.08 + p_rienda * 0.20)::numeric, 1);
    END IF;
    RETURN round((p_apinadero * 0.20 + p_cancha * 0.30 + p_atajadas * 0.40 + p_cuarta * 0.10)::numeric, 1);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ─────────────────────────────────────────────────────────────────────────
-- 3) enviar_evaluacion_comision_jurado_con_auditoria — misma lógica de 079
--    (candados, verificación de asociación/designación/autorización,
--    consolidación, trazabilidad), parámetros de notas ahora NUMERIC(2,1).
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS enviar_evaluacion_comision_jurado_con_auditoria(UUID, UUID, UUID, UUID, UUID, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, INTEGER, BOOLEAN, TEXT);
CREATE OR REPLACE FUNCTION enviar_evaluacion_comision_jurado_con_auditoria(
    p_rodeo_id UUID,
    p_asignacion_id UUID,
    p_asociacion_id UUID,
    p_evaluador_id UUID,
    p_cuenta_institucional_id UUID,
    p_nota_apinadero NUMERIC(2,1),
    p_nota_cancha NUMERIC(2,1),
    p_nota_atajadas NUMERIC(2,1),
    p_nota_cuarta_carrera NUMERIC(2,1),
    p_hubo_movimiento_rienda BOOLEAN,
    p_nota_rienda NUMERIC(2,1),
    p_afecto_resultado_final BOOLEAN,
    p_comentario TEXT
) RETURNS comision_evaluacion_jurado_publica AS $$
DECLARE
    v_cuenta_asociacion UUID;
    v_cuenta_rol TEXT;
    v_evaluador_asociacion UUID;
    v_evaluador_activo BOOLEAN;
    v_asignacion RECORD;
    v_estado_nota TEXT;
    v_requiere_revision BOOLEAN;
    v_autorizacion_id UUID;
    v_nota_individual NUMERIC(3,1);
    v_resultado comision_evaluacion_jurado_publica;
BEGIN
    SELECT asociacion_id, rol_institucional INTO v_cuenta_asociacion, v_cuenta_rol
        FROM cuentas_institucionales WHERE id = p_cuenta_institucional_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'CUENTA_NO_ENCONTRADA'; END IF;
    IF v_cuenta_rol <> 'comision_asociacion' THEN RAISE EXCEPTION 'CUENTA_NO_ES_COMISION'; END IF;
    IF v_cuenta_asociacion IS DISTINCT FROM p_asociacion_id THEN RAISE EXCEPTION 'ASOCIACION_NO_COINCIDE'; END IF;

    SELECT asociacion_id, activo INTO v_evaluador_asociacion, v_evaluador_activo
        FROM evaluadores_comision WHERE id = p_evaluador_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'EVALUADOR_NO_ENCONTRADO'; END IF;
    IF NOT v_evaluador_activo THEN RAISE EXCEPTION 'EVALUADOR_SUSPENDIDO'; END IF;
    IF v_evaluador_asociacion IS DISTINCT FROM p_asociacion_id THEN RAISE EXCEPTION 'EVALUADOR_DE_OTRA_ASOCIACION'; END IF;

    IF EXISTS (
        SELECT 1 FROM comision_evaluaciones_jurado
        WHERE rodeo_id = p_rodeo_id AND asociacion_id <> p_asociacion_id
    ) THEN
        RAISE EXCEPTION 'ASOCIACION_NO_COINCIDE';
    END IF;

    PERFORM 1 FROM rodeos WHERE id = p_rodeo_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'RODEO_NO_ENCONTRADO'; END IF;

    SELECT estado_nota_comision, requiere_revision_admin INTO v_estado_nota, v_requiere_revision
        FROM rodeo_notas_secundarias WHERE rodeo_id = p_rodeo_id;
    IF v_estado_nota = 'historica_sin_desglose' THEN
        RAISE EXCEPTION 'NOTA_COMISION_HISTORICA_PROTEGIDA';
    END IF;

    SELECT a.id, a.usuario_pagado_id, a.tipo_persona, a.estado, a.publicado, a.estado_designacion,
           COALESCE(up.nombre_completo, a.nombre_importado) AS nombre_resuelto
        INTO v_asignacion
        FROM asignaciones a
        LEFT JOIN usuarios_pagados up ON up.id = a.usuario_pagado_id
        WHERE a.id = p_asignacion_id AND a.rodeo_id = p_rodeo_id
        FOR UPDATE OF a;
    IF NOT FOUND THEN RAISE EXCEPTION 'ASIGNACION_NO_ENCONTRADA'; END IF;
    IF v_asignacion.tipo_persona <> 'jurado' THEN RAISE EXCEPTION 'ASIGNACION_NO_ES_JURADO'; END IF;
    IF v_asignacion.estado <> 'activo' OR v_asignacion.publicado IS NOT TRUE
       OR COALESCE(v_asignacion.estado_designacion, 'pendiente') = 'rechazado' THEN
        RAISE EXCEPTION 'DESIGNACION_NO_VIGENTE';
    END IF;

    SELECT id INTO v_autorizacion_id FROM comision_autorizaciones_evaluacion
        WHERE rodeo_id = p_rodeo_id AND asignacion_id = p_asignacion_id AND estado = 'pendiente'
          AND usuario_pagado_id_autorizado IS NOT DISTINCT FROM v_asignacion.usuario_pagado_id
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE;

    IF v_autorizacion_id IS NULL THEN
        IF v_requiere_revision IS TRUE THEN
            RAISE EXCEPTION 'REQUIERE_RESOLUCION_ADMINISTRATIVA_PRIMERO';
        END IF;
        IF v_estado_nota IN ('completa', 'corregida_admin') THEN
            RAISE EXCEPTION 'NOTA_COMISION_CERRADA';
        END IF;
    END IF;

    IF p_hubo_movimiento_rienda AND p_nota_rienda IS NULL THEN RAISE EXCEPTION 'NOTA_RIENDA_REQUERIDA'; END IF;
    IF NOT p_hubo_movimiento_rienda AND p_nota_rienda IS NOT NULL THEN RAISE EXCEPTION 'NOTA_RIENDA_NO_CORRESPONDE'; END IF;

    v_nota_individual := fn_calcular_nota_individual_comision(
        p_nota_apinadero, p_nota_cancha, p_nota_atajadas, p_nota_cuarta_carrera, p_hubo_movimiento_rienda, p_nota_rienda
    );

    BEGIN
        INSERT INTO comision_evaluaciones_jurado (
            rodeo_id, asignacion_id, asociacion_id, usuario_pagado_id_evaluado_snapshot, nombre_evaluado_snapshot,
            evaluador_id, cuenta_institucional_id, nota_apinadero, nota_cancha, nota_atajadas, nota_cuarta_carrera,
            hubo_movimiento_rienda, nota_rienda, nota_individual_calculada, afecto_resultado_final, comentario,
            estado, enviada_en
        ) VALUES (
            p_rodeo_id, p_asignacion_id, p_asociacion_id, v_asignacion.usuario_pagado_id, v_asignacion.nombre_resuelto,
            p_evaluador_id, p_cuenta_institucional_id, p_nota_apinadero, p_nota_cancha, p_nota_atajadas, p_nota_cuarta_carrera,
            p_hubo_movimiento_rienda, p_nota_rienda, v_nota_individual, p_afecto_resultado_final, p_comentario,
            'enviada', now()
        )
        RETURNING id, rodeo_id, asignacion_id, nombre_evaluado_snapshot, nota_individual_calculada, estado, enviada_en
        INTO v_resultado;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'EVALUACION_YA_ENVIADA';
    END;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES ('comision_evaluaciones_jurado', v_resultado.id::text, 'crear',
        jsonb_build_object('rodeo_id', p_rodeo_id, 'asignacion_id', p_asignacion_id, 'nota_individual', v_nota_individual, 'evaluador_id', p_evaluador_id, 'autorizacion_id', v_autorizacion_id),
        p_cuenta_institucional_id::text, 'cuenta_institucional',
        format('Evaluación de Comisión de Asociación enviada para %s', v_asignacion.nombre_resuelto));

    IF v_autorizacion_id IS NOT NULL THEN
        UPDATE comision_autorizaciones_evaluacion SET estado = 'usada', usada_en = now() WHERE id = v_autorizacion_id;
    END IF;

    PERFORM fn_recalcular_consolidacion_comision_rodeo(p_rodeo_id, p_cuenta_institucional_id);

    IF v_autorizacion_id IS NOT NULL THEN
        PERFORM fn_marcar_revision_admin_si_corresponde(p_rodeo_id, format(
            'Evaluación autorizada registrada para %s (autorización %s). La Nota Comisión general oficial se conserva sin cambios — pendiente de decisión administrativa.',
            v_asignacion.nombre_resuelto, v_autorizacion_id));
    END IF;

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION enviar_evaluacion_comision_jurado_con_auditoria IS
    'Comisión de Asociación (079/080): evaluación individual y DEFINITIVA de un jurado (sin borradores). Candado sobre rodeos primero, luego sobre la asignación. UNIQUE(rodeo_id, asignacion_id) impide duplicados (409 en el backend). Calcula la nota server-side, nunca confía en el frontend. Consolida automáticamente al final (fn_recalcular_consolidacion_comision_rodeo). Notas con un decimal (080).';

-- ─────────────────────────────────────────────────────────────────────────
-- 4) corregir_evaluacion_individual_comision_con_auditoria — misma lógica de
--    079 (bloqueo de evaluaciones desvinculadas, recálculo server-side,
--    historial de correcciones, aviso de revisión administrativa),
--    parámetros de notas ahora NUMERIC(2,1).
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS corregir_evaluacion_individual_comision_con_auditoria(UUID, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, INTEGER, TEXT, UUID);
CREATE OR REPLACE FUNCTION corregir_evaluacion_individual_comision_con_auditoria(
    p_evaluacion_id UUID,
    p_nota_apinadero NUMERIC(2,1),
    p_nota_cancha NUMERIC(2,1),
    p_nota_atajadas NUMERIC(2,1),
    p_nota_cuarta_carrera NUMERIC(2,1),
    p_hubo_movimiento_rienda BOOLEAN,
    p_nota_rienda NUMERIC(2,1),
    p_motivo TEXT,
    p_administrador_id UUID
) RETURNS comision_evaluacion_jurado_publica AS $$
DECLARE
    v_rodeo_id UUID;
    v_anterior RECORD;
    v_nota_individual NUMERIC(3,1);
    v_resultado comision_evaluacion_jurado_publica;
BEGIN
    IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_OBLIGATORIO'; END IF;
    IF p_hubo_movimiento_rienda AND p_nota_rienda IS NULL THEN RAISE EXCEPTION 'NOTA_RIENDA_REQUERIDA'; END IF;
    IF NOT p_hubo_movimiento_rienda AND p_nota_rienda IS NOT NULL THEN RAISE EXCEPTION 'NOTA_RIENDA_NO_CORRESPONDE'; END IF;

    SELECT rodeo_id INTO v_rodeo_id FROM comision_evaluaciones_jurado WHERE id = p_evaluacion_id;
    IF v_rodeo_id IS NULL THEN RAISE EXCEPTION 'EVALUACION_NO_ENCONTRADA'; END IF;

    PERFORM 1 FROM rodeos WHERE id = v_rodeo_id FOR UPDATE;

    SELECT * INTO v_anterior FROM comision_evaluaciones_jurado WHERE id = p_evaluacion_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'EVALUACION_NO_ENCONTRADA'; END IF;

    IF v_anterior.estado = 'desvinculada_por_cambio_designacion' THEN
        RAISE EXCEPTION 'EVALUACION_DESVINCULADA_NO_CORREGIBLE';
    END IF;

    v_nota_individual := fn_calcular_nota_individual_comision(
        p_nota_apinadero, p_nota_cancha, p_nota_atajadas, p_nota_cuarta_carrera, p_hubo_movimiento_rienda, p_nota_rienda
    );

    UPDATE comision_evaluaciones_jurado SET
        nota_apinadero = p_nota_apinadero, nota_cancha = p_nota_cancha, nota_atajadas = p_nota_atajadas,
        nota_cuarta_carrera = p_nota_cuarta_carrera, hubo_movimiento_rienda = p_hubo_movimiento_rienda,
        nota_rienda = p_nota_rienda, nota_individual_calculada = v_nota_individual,
        estado = 'corregida_admin', updated_at = now()
        WHERE id = p_evaluacion_id
        RETURNING id, rodeo_id, asignacion_id, nombre_evaluado_snapshot, nota_individual_calculada, estado, enviada_en
        INTO v_resultado;

    INSERT INTO comision_evaluaciones_correcciones (rodeo_id, evaluacion_id, motivo, datos_anteriores, datos_nuevos, administrador_id)
    VALUES (v_anterior.rodeo_id, p_evaluacion_id, p_motivo, to_jsonb(v_anterior), to_jsonb(v_resultado), p_administrador_id);

    IF v_anterior.nota_individual_calculada IS DISTINCT FROM v_nota_individual THEN
        PERFORM fn_marcar_revision_admin_si_corresponde(v_anterior.rodeo_id, format(
            'Corrección administrativa de la evaluación %s cambió la nota individual (%s -> %s) después de publicada/corregida la Nota Comisión general — existe una diferencia pendiente de resolución administrativa.',
            p_evaluacion_id, v_anterior.nota_individual_calculada, v_nota_individual));
    END IF;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES ('comision_evaluaciones_jurado', p_evaluacion_id::text, 'corregir',
        jsonb_build_object('nota_individual_calculada', v_anterior.nota_individual_calculada),
        jsonb_build_object('nota_individual_calculada', v_nota_individual),
        p_administrador_id::text, 'administrador', p_motivo);

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION corregir_evaluacion_individual_comision_con_auditoria IS
    'Comisión de Asociación (079/080): único camino para corregir los criterios de una evaluación individual ya enviada (administrador pleno, motivo obligatorio). Recalcula server-side y deja historial completo. Nunca recalcula sola la Nota Comisión general. Notas con un decimal (080).';

-- ─────────────────────────────────────────────────────────────────────────
-- 5) Endurecimiento de privilegios — mismo criterio que 079: se reaplica
--    explícitamente para las 3 funciones con firma cambiada, porque el DROP
--    de arriba limpió sus GRANT anteriores.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION fn_calcular_nota_individual_comision(NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), BOOLEAN, NUMERIC(2,1)) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION enviar_evaluacion_comision_jurado_con_auditoria(UUID, UUID, UUID, UUID, UUID, NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), BOOLEAN, NUMERIC(2,1), BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION corregir_evaluacion_individual_comision_con_auditoria(UUID, NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), BOOLEAN, NUMERIC(2,1), TEXT, UUID) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION fn_calcular_nota_individual_comision(NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), BOOLEAN, NUMERIC(2,1)) TO service_role;
GRANT EXECUTE ON FUNCTION enviar_evaluacion_comision_jurado_con_auditoria(UUID, UUID, UUID, UUID, UUID, NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), BOOLEAN, NUMERIC(2,1), BOOLEAN, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION corregir_evaluacion_individual_comision_con_auditoria(UUID, NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), BOOLEAN, NUMERIC(2,1), TEXT, UUID) TO service_role;

ALTER FUNCTION fn_calcular_nota_individual_comision(NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), BOOLEAN, NUMERIC(2,1)) SET search_path = public, pg_temp;
ALTER FUNCTION enviar_evaluacion_comision_jurado_con_auditoria(UUID, UUID, UUID, UUID, UUID, NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), BOOLEAN, NUMERIC(2,1), BOOLEAN, TEXT) SET search_path = public, pg_temp;
ALTER FUNCTION corregir_evaluacion_individual_comision_con_auditoria(UUID, NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), BOOLEAN, NUMERIC(2,1), TEXT, UUID) SET search_path = public, pg_temp;

COMMIT;

-- Reversible (requiere decidir primero qué hacer con evaluaciones que ya
-- tengan un decimal real — un rollback a INTEGER truncaría esos valores):
--   BEGIN;
--   DROP FUNCTION IF EXISTS corregir_evaluacion_individual_comision_con_auditoria(UUID, NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), BOOLEAN, NUMERIC(2,1), TEXT, UUID);
--   DROP FUNCTION IF EXISTS enviar_evaluacion_comision_jurado_con_auditoria(UUID, UUID, UUID, UUID, UUID, NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), BOOLEAN, NUMERIC(2,1), BOOLEAN, TEXT);
--   DROP FUNCTION IF EXISTS fn_calcular_nota_individual_comision(NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), NUMERIC(2,1), BOOLEAN, NUMERIC(2,1));
--   -- (recrear las 3 funciones y las 5 columnas con los tipos INTEGER de 079 si fuera necesario)
--   COMMIT;
