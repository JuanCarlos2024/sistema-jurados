-- ═════════════════════════════════════════════════════════════════════════
-- 104_designacion_manual_excepcion_intervalo.sql
-- Designación manual con excepciones autorizadas — Rodeos → "Designar jurado".
--
-- ⚠️ NO APLICADA — preparada para revisión. Requiere autorización explícita.
--
-- PROBLEMA: crear_asignacion_con_bitacora() (094) solo acepta como causas
-- confirmadas las 4 relajables del motor. La designación manual ahora permite
-- excepcionar ASOCIACION_REPETIDA_INTERVALO (con confirmación expresa, motivo
-- del catálogo y registro en bitácora); sin este cambio la RPC rechaza la
-- excepción con CAUSA_CONFIRMADA_DESCONOCIDA y no crea nada (el backend lo
-- informa como MIGRACION_104_PENDIENTE — falla controlada, sin efectos).
--
-- CAMBIO FUNCIONAL ÚNICO: se agrega 'ASOCIACION_REPETIDA_INTERVALO' al
-- allowlist de p_causas_confirmadas de crear_asignacion_con_bitacora(). Dentro
-- del cuerpo solo cambia esa línea más un comentario [104] junto a ella (que
-- corrige la nota previa "espejo de CAUSAS_RELAJABLES"). El resto del cuerpo
-- es IDÉNTICO al de 094 (verificado igual a producción el 2026-11-19, md5 LF
-- cb44d8705ad8ce2e1a8add5337bd4255): mismo advisory lock, misma revalidación
-- de disponibilidad declarada, cruce de fechas, duración/pago, motivo
-- obligatorio y registro atómico en bitacora_designaciones. Antes de aplicar,
-- volver a verificar ese md5 en producción (solo lectura).
--
-- PERMISOS: REVOKE/GRANT idénticos a 094 (EXECUTE solo service_role). El
-- COMMENT ON FUNCTION de 094 se conserva sin cambios (CREATE OR REPLACE
-- mantiene comentario, dueño y privilegios del objeto).
--
-- NO SE TOCA: reemplazar_jurado_asignacion_con_bitacora() (el reemplazo sigue
-- sin permitir esta excepción), registrar_movimiento_designacion(), la tabla
-- bitacora_designaciones ni su CHECK, el motor automático (que sigue tratando
-- el intervalo como OBLIGATORIO) ni datos.
-- Misma firma → CREATE OR REPLACE reemplaza la función, no crea sobrecarga.
-- INDEPENDIENTE de la migración 103 (no comparte objetos, tablas ni permisos):
-- puede aplicarse antes o después de ella.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION crear_asignacion_con_bitacora(
    p_rodeo_id                UUID,
    p_usuario_pagado_id       UUID,
    p_categoria_aplicada      TEXT,
    p_valor_diario_aplicado   INTEGER,
    p_duracion_dias_aplicada  INTEGER,
    p_pago_base_calculado     INTEGER,
    p_motivo_catalogo_id      UUID,
    p_actor_id                UUID,
    p_causas_confirmadas      JSONB DEFAULT NULL,
    p_motivo_detalle          TEXT DEFAULT NULL,
    p_operacion_id            UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
-- SECURITY INVOKER (ver cabecera de esta migración).
SET search_path = public
AS $$
DECLARE
    v_rodeo            rodeos%ROWTYPE;
    v_jurado           usuarios_pagados%ROWTYPE;
    v_motivo           catalogo_motivos_designacion%ROWTYPE;
    v_nueva            asignaciones%ROWTYPE;
    v_bitacora         bitacora_designaciones;
    v_ya_designado     BOOLEAN;
    v_cruce_otro_rodeo BOOLEAN;
    v_disponible_todos_los_dias BOOLEAN;
BEGIN
    IF p_actor_id IS NULL THEN
        RAISE EXCEPTION 'ACTOR_REQUERIDO';
    END IF;
    IF p_usuario_pagado_id IS NULL THEN
        RAISE EXCEPTION 'JURADO_REQUERIDO';
    END IF;
    -- Esta función existe exclusivamente para registrar una excepción
    -- justificada — a diferencia de registrar_movimiento_designacion()
    -- (p_motivo_catalogo_id es opcional ahí para otros orígenes), acá es
    -- SIEMPRE obligatorio.
    IF p_motivo_catalogo_id IS NULL THEN
        RAISE EXCEPTION 'MOTIVO_REQUERIDO: esta función solo registra designaciones manuales con excepción — use el INSERT simple existente cuando no haya ninguna advertencia que justificar';
    END IF;

    -- Decisión 13 de 084, mismo criterio — PRIMERA operación: advisory lock
    -- sobre el jurado candidato, para serializar entre sí a TODAS las
    -- creaciones/reemplazos que compitan por la MISMA persona.
    PERFORM pg_advisory_xact_lock(hashtextextended(p_usuario_pagado_id::text, 0));

    -- Lock de la fila de rodeos (Decisión 9 de 084) antes de cualquier
    -- verificación que dependa de otras asignaciones de este rodeo, para
    -- serializar dos creaciones concurrentes sobre el mismo rodeo.
    SELECT * INTO v_rodeo FROM rodeos WHERE id = p_rodeo_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RODEO_NO_ENCONTRADO';
    END IF;
    IF v_rodeo.estado <> 'activo' THEN
        RAISE EXCEPTION 'RODEO_ANULADO';
    END IF;

    SELECT * INTO v_jurado FROM usuarios_pagados WHERE id = p_usuario_pagado_id;
    IF NOT FOUND OR v_jurado.activo IS NOT TRUE OR v_jurado.tipo_persona <> 'jurado' THEN
        RAISE EXCEPTION 'JURADO_INVALIDO';
    END IF;

    SELECT * INTO v_motivo FROM catalogo_motivos_designacion WHERE id = p_motivo_catalogo_id;
    IF NOT FOUND OR v_motivo.activo IS NOT TRUE THEN
        RAISE EXCEPTION 'MOTIVO_INVALIDO';
    END IF;

    -- Revisión puntual, punto 4 — esta función es exclusivamente para
    -- registrar una excepción: debe declarar al menos una causa relajable
    -- real confirmada, nunca un array vacío ni nulo (eso describiría una
    -- designación sin ninguna advertencia, que debe seguir yendo por el
    -- INSERT simple de JavaScript). El allowlist es un espejo de
    -- CAUSAS_RELAJABLES (motorPropuestaDesignacionGlobal.js) — una
    -- validación de integridad del dato persistido, NUNCA una reevaluación
    -- de reglas de negocio (esas se evalúan exclusivamente en JavaScript,
    -- antes de llegar aquí). Si ese conjunto cambia alguna vez en el motor,
    -- este allowlist debe actualizarse junto con él.
    IF p_causas_confirmadas IS NULL OR jsonb_typeof(p_causas_confirmadas) <> 'array' OR jsonb_array_length(p_causas_confirmadas) = 0 THEN
        RAISE EXCEPTION 'CAUSAS_CONFIRMADAS_REQUERIDAS: esta excepción debe declarar al menos una causa relajable confirmada';
    END IF;
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(p_causas_confirmadas) AS causa
        -- [104] Desde esta migración el allowlist ya NO es espejo exacto de
        -- CAUSAS_RELAJABLES: es CAUSAS_EXCEPCIONABLES_MANUAL (elegibilidadJurado.js)
        -- = relajables + ASOCIACION_REPETIDA_INTERVALO, excepción administrativa
        -- SOLO de la designación manual. El motor automático sigue tratando el
        -- intervalo como obligatorio y el reemplazo no usa esta función.
        WHERE causa NOT IN ('DISTANCIA_EXCEDIDA', 'ASOCIACION_REPETIDA_TEMPORADA', 'FINDE_CONSECUTIVO', 'JURADO_SIN_COMUNA_RESOLVIBLE', 'ASOCIACION_REPETIDA_INTERVALO')
    ) THEN
        RAISE EXCEPTION 'CAUSA_CONFIRMADA_DESCONOCIDA: solo se aceptan causas relajables reconocidas por el motor';
    END IF;

    -- Revisión puntual, punto 2 — mismo criterio de 084: la duración y el
    -- pago nunca se confían a ciegas del llamador. 084 lo logra sin
    -- necesitarlo como parámetro (un reemplazo nunca cambia la duración ya
    -- escrita); esta función SÍ inserta una fila nueva, así que valida
    -- explícitamente contra la fila de rodeos YA BLOQUEADA (v_rodeo, arriba)
    -- — nunca recalcula tarifas ni reimplementa calcularPagoBase() en SQL,
    -- solo verifica la consistencia aritmética/estructural de lo recibido.
    IF p_duracion_dias_aplicada IS DISTINCT FROM v_rodeo.duracion_dias THEN
        RAISE EXCEPTION 'DURACION_INCONSISTENTE_CON_RODEO: % declarada no coincide con % real del rodeo', p_duracion_dias_aplicada, v_rodeo.duracion_dias;
    END IF;
    IF p_pago_base_calculado <> p_valor_diario_aplicado * p_duracion_dias_aplicada THEN
        RAISE EXCEPTION 'PAGO_BASE_INCONSISTENTE: % no corresponde a % x % día(s)', p_pago_base_calculado, p_valor_diario_aplicado, p_duracion_dias_aplicada;
    END IF;

    -- Revisión puntual, punto 1 — defensa en profundidad (igual que 084):
    -- las causas de negocio (MISMA_ASOCIACION, categoría/matriz, distancia,
    -- etc.) ya las evaluó JavaScript antes de llegar aquí y NUNCA se
    -- reevalúan en SQL; esto re-verifica, bajo lock real, lo mismo que ya
    -- verifica validarDisponibilidadYCruceFechas() en JavaScript —
    -- disponibilidad DECLARADA para TODOS los días del rodeo (antes, esta
    -- función solo revisaba cruces con OTRAS asignaciones, nunca si el
    -- candidato había declarado disponibilidad para estas fechas en
    -- absoluto) y cruce con otro rodeo — para que sea una garantía real
    -- ante una carrera genuina, no solo el aviso rápido de JavaScript.
    SELECT (count(DISTINCT fecha) = COALESCE(v_rodeo.duracion_dias, 1)) INTO v_disponible_todos_los_dias
    FROM disponibilidad_usuarios
    WHERE usuario_pagado_id = p_usuario_pagado_id
      AND fecha BETWEEN v_rodeo.fecha AND (v_rodeo.fecha + (COALESCE(v_rodeo.duracion_dias, 1) - 1) * INTERVAL '1 day')::date;
    IF NOT v_disponible_todos_los_dias THEN
        RAISE EXCEPTION 'SIN_DISPONIBILIDAD_DECLARADA: el jurado no tiene disponibilidad declarada para todas las fechas del rodeo';
    END IF;

    -- Revisión puntual, punto 3 — un antecedente YA NO VIGENTE (asignación
    -- anulada, o designación rechazada en otro rodeo — el jurado nunca
    -- llegó a ejercer ahí) no debe bloquear una designación nueva. El
    -- chequeo "ya designado en ESTE rodeo" ya excluía ambos casos (mismo
    -- criterio que 084); el de cruce con OTRO rodeo excluía solo anuladas
    -- — se agrega la misma exclusión de 'rechazado' acá. Nota: 084 no
    -- aplica (aún) este mismo criterio más estricto a su propio chequeo de
    -- cruce — no se modifica esa migración ya aplicada; queda como mejora
    -- de seguimiento documentada en el informe de esta revisión.
    SELECT EXISTS (
        SELECT 1 FROM asignaciones
        WHERE rodeo_id = p_rodeo_id
          AND usuario_pagado_id = p_usuario_pagado_id
          AND estado = 'activo'
          AND COALESCE(estado_designacion, 'pendiente') <> 'rechazado'
    ) INTO v_ya_designado;
    IF v_ya_designado THEN
        RAISE EXCEPTION 'JURADO_YA_DESIGNADO_EN_RODEO';
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM asignaciones a2
        JOIN rodeos r2 ON r2.id = a2.rodeo_id
        WHERE a2.usuario_pagado_id = p_usuario_pagado_id
          AND a2.rodeo_id <> p_rodeo_id
          AND a2.estado <> 'anulado'
          AND COALESCE(a2.estado_designacion, 'pendiente') <> 'rechazado'
          AND (r2.fecha + (COALESCE(r2.duracion_dias, 1) - 1) * INTERVAL '1 day')::date >= v_rodeo.fecha
          AND r2.fecha <= (v_rodeo.fecha + (COALESCE(v_rodeo.duracion_dias, 1) - 1) * INTERVAL '1 day')::date
    ) INTO v_cruce_otro_rodeo;
    IF v_cruce_otro_rodeo THEN
        RAISE EXCEPTION 'CRUCE_DISPONIBILIDAD: el jurado ya está asignado a otro rodeo en fechas que se cruzan';
    END IF;

    INSERT INTO asignaciones (
        rodeo_id, usuario_pagado_id, tipo_persona, nombre_importado,
        categoria_aplicada, valor_diario_aplicado, duracion_dias_aplicada, pago_base_calculado,
        estado, estado_designacion, publicado, created_by
    ) VALUES (
        p_rodeo_id, p_usuario_pagado_id, 'jurado', v_jurado.nombre_completo,
        p_categoria_aplicada, p_valor_diario_aplicado, p_duracion_dias_aplicada, p_pago_base_calculado,
        'activo', 'pendiente', false, p_actor_id
    )
    RETURNING * INTO v_nueva;

    -- Única vía de escritura hacia la bitácora — si esto falla, toda la
    -- función falla y Postgres revierte también el INSERT de arriba: nunca
    -- queda una asignación creada sin su excepción registrada.
    v_bitacora := registrar_movimiento_designacion(
        p_tipo_movimiento        := 'designacion_manual_con_advertencia',
        p_rodeo_id               := p_rodeo_id,
        p_actor_id               := p_actor_id,
        p_asignacion_id          := v_nueva.id,
        p_usuario_pagado_id_nuevo := p_usuario_pagado_id,
        p_nombre_nuevo_snapshot  := v_jurado.nombre_completo,
        p_motivo_catalogo_id     := p_motivo_catalogo_id,
        p_motivo_detalle         := p_motivo_detalle,
        p_actor_tipo             := 'administrador',
        p_operacion_id           := p_operacion_id,
        p_causas_confirmadas     := p_causas_confirmadas
    );

    RETURN jsonb_build_object(
        'asignacion', row_to_json(v_nueva),
        'bitacora_id', v_bitacora.id
    );
END;
$$;

REVOKE ALL ON FUNCTION crear_asignacion_con_bitacora(
    UUID, UUID, TEXT, INTEGER, INTEGER, INTEGER, UUID, UUID, JSONB, TEXT, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION crear_asignacion_con_bitacora(
    UUID, UUID, TEXT, INTEGER, INTEGER, INTEGER, UUID, UUID, JSONB, TEXT, UUID
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Reversión: volver a ejecutar el bloque CREATE OR REPLACE FUNCTION
-- crear_asignacion_con_bitacora(...) de la migración 094 (mismo cuerpo sin
-- 'ASOCIACION_REPETIDA_INTERVALO'). No borra filas: las excepciones ya
-- registradas en bitacora_designaciones quedan como historial.
