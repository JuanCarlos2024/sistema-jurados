-- ═════════════════════════════════════════════════════════════════════════
-- 094_designacion_manual_con_bitacora_atomica.sql
-- Corrección final de seguridad — Sección 3: cierre de la trazabilidad de
-- excepciones en POST /admin/asignaciones ("Designar jurado").
--
-- ⚠️ NO APLICADA — preparada, incremental e idempotente, pendiente de
-- autorización explícita para ejecutarse en Supabase. No se ejecuta SQL de
-- escritura como parte de esta corrección.
--
-- PROBLEMA CONFIRMADO (revisión de cierre de integridad anterior): cuando un
-- administrador confirma una designación manual con una advertencia de
-- preferencia flexible (confirmar_advertencias=true), la asignación se
-- inserta con un INSERT simple en JavaScript — ni el motivo del catálogo, ni
-- las causas relajables confirmadas, ni el hecho de que hubo una excepción,
-- quedaban registrados en ningún lado. auditoria.datos_nuevos solo guardaba
-- rodeo_id/usuario_pagado_id/tipo_persona/pago_base_calculado (los mismos
-- campos que ya guardaba antes de la Etapa A).
--
-- DECISIÓN DE DISEÑO — se reutiliza la infraestructura existente de la Fase
-- 1A/1B (083/084): bitacora_designaciones, catalogo_motivos_designacion y
-- registrar_movimiento_designacion(). NO se crea ninguna tabla nueva. Se
-- justifica por qué la RPC actual SÍ necesita dos cambios aditivos (nunca
-- una reescritura de su contrato):
--
--   (a) registrar_movimiento_designacion() no tenía ningún lugar donde
--       guardar QUÉ causas relajables concretas (DISTANCIA_EXCEDIDA,
--       ASOCIACION_REPETIDA_TEMPORADA, FINDE_CONSECUTIVO,
--       JURADO_SIN_COMUNA_RESOLVIBLE) fueron las confirmadas — motivo_
--       detalle es texto libre para la justificación humana, no una
--       estructura consultable. Se agrega una columna nueva, nullable,
--       aditiva (causas_confirmadas JSONB) a bitacora_designaciones y un
--       parámetro nuevo opcional (p_causas_confirmadas, con DEFAULT NULL al
--       final de la lista) a la función — ningún llamador existente
--       (reemplazar_jurado_asignacion_con_bitacora, modificar_jurado_
--       propuesta_borrador) se ve afectado: siguen sin pasar ese argumento,
--       y la columna queda NULL para todas sus filas, exactamente como
--       hasta ahora.
--   (b) El CHECK de tipo_movimiento (083) no tenía ningún valor que
--       describiera "designación manual nueva, con una advertencia
--       confirmada" — los 10 valores existentes (propuesta_automatica,
--       modificacion_manual_borrador, aplicacion_propuesta, aceptacion,
--       rechazo, reemplazo, cambio_emergencia, regularizacion_posterior,
--       enroque, rectificacion_administrativa) mantienen EXACTAMENTE su
--       significado histórico — ninguno se renombra, ninguno se reutiliza
--       con un significado nuevo. Se agrega 'designacion_manual_con_
--       advertencia' de forma aditiva al CHECK (DROP CONSTRAINT IF EXISTS +
--       ADD CONSTRAINT, mismo patrón ya usado en 069 para auditoria_
--       actor_tipo_check).
--
-- ATOMICIDAD (requisito explícito) — se agrega UNA función RPC nueva,
-- crear_asignacion_con_bitacora(), que inserta la asignación Y registra la
-- excepción en la bitácora DENTRO DE LA MISMA función de Postgres: si el
-- registro de bitácora falla por cualquier motivo (motivo inválido,
-- violación de CHECK, lo que sea), toda la función revierte y la asignación
-- NUNCA queda creada sin su trazabilidad — nunca dos pasos separados donde
-- el segundo pueda fallar dejando al primero huérfano. Mismo patrón
-- (Decisión 2 de 084) que ya usa reemplazar_jurado_asignacion_con_bitacora
-- para el caso del reemplazo.
--
-- ALCANCE — esta función es de uso EXCLUSIVO para el camino de EXCEPCIÓN
-- (confirmar_advertencias=true, con al menos una causa relajable
-- confirmada): exige motivo_catalogo_id (NUNCA NULL, a diferencia de un
-- INSERT simple) porque su único propósito es registrar una excepción
-- justificada. La creación SIN excepción (el caso común, sin ninguna
-- advertencia) sigue usando el INSERT simple existente en JavaScript — sin
-- cambios, mismo costo que siempre, para no introducir el peso de un
-- advisory lock ni de una llamada RPC donde no hace falta ninguna garantía
-- adicional (sección 6 del pedido: "no introducir bloqueos innecesarios").
--
-- DEFENSA EN PROFUNDIDAD — re-verifica, bajo un advisory lock sobre el
-- jurado candidato (mismo mecanismo que 084/Decisión 13), que no quede ya
-- designado vigente en este mismo rodeo ni en otro con fechas que se
-- cruzan — mismas dos protecciones que ya tiene el reemplazo transaccional,
-- ahora también para la creación. El chequeo de JavaScript (evaluarElegibilidadJurado
-- + validarDisponibilidadYCruceFechas) sigue siendo la única fuente de las
-- causas de negocio (MISMA_ASOCIACION, categoría/matriz, distancia,
-- repetición de asociación, mismo finde) — esta función NUNCA reimplementa
-- esas reglas, solo re-verifica la integridad estructural mínima
-- (disponibilidad/cruce de fechas) bajo lock real, igual que ya hace 084.
--
-- SECURITY INVOKER (igual criterio que 071/083/084): el único rol con
-- EXECUTE es service_role, que ya tiene GRANT directo sobre todas las
-- tablas que esta función toca. p_actor_id SIEMPRE llega desde req.usuario.id
-- en el backend (JWT ya verificado) — nunca de un campo libre del body;
-- verificado en asignaciones.js, sin cambios necesarios.
--
-- Envuelta en una transacción explícita. Idempotente: CREATE OR REPLACE
-- FUNCTION, ADD COLUMN IF NOT EXISTS y DROP CONSTRAINT IF EXISTS son
-- seguros de repetir. Reversible: ver bloque al final.
--
-- REVISIÓN PUNTUAL (antes de autorizar la aplicación) — 5 correcciones
-- sobre la versión original de esta migración, todas dentro de
-- crear_asignacion_con_bitacora() salvo donde se indica:
--   1. Disponibilidad declarada: antes solo se revisaba cruce con OTRAS
--      asignaciones — nunca si el candidato había declarado disponibilidad
--      para las fechas de ESTE rodeo. Se agrega el mismo chequeo que ya
--      hace validarDisponibilidadYCruceFechas() en JavaScript, ahora
--      también bajo lock real.
--   2. Duración/pago: se valida que p_duracion_dias_aplicada coincida con
--      la duración REAL del rodeo (ya bloqueado) y que p_pago_base_calculado
--      sea aritméticamente consistente con valor_diario × duración — nunca
--      recalcula tarifas, solo verifica consistencia estructural (mismo
--      espíritu que 084/Decisión 7: nunca reimplementar calcularPagoBase()
--      en SQL).
--   3. El chequeo de cruce con otro rodeo ahora excluye también
--      estado_designacion='rechazado' (un antecedente que ya no representa
--      una ocupación real) — el chequeo "ya designado en este rodeo" ya lo
--      excluía. Nota: 084 no se modifica (ya aplicada) y mantiene su
--      criterio original solo para el reemplazo — ver riesgos pendientes.
--   4. p_causas_confirmadas ahora es estrictamente obligatorio (array JSON
--      no vacío, con códigos de causas relajables reconocidas) PARA ESTA
--      función — registrar_movimiento_designacion() conserva el parámetro
--      como opcional (DEFAULT NULL), para no romper a sus llamadores
--      existentes (084, 086 ×2, 091), que nunca lo pasan.
--   5. Se agrega NOTIFY pgrst, 'reload schema' (mismo patrón ya usado en
--      088/093) para que PostgREST exponga la función/firma nuevas de
--      inmediato, sin depender de su recarga periódica.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- (a) Columna aditiva, nullable — nunca afecta filas ni llamadores existentes.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE bitacora_designaciones ADD COLUMN IF NOT EXISTS causas_confirmadas JSONB;

COMMENT ON COLUMN bitacora_designaciones.causas_confirmadas IS
    'Corrección final de seguridad (sección 3): array JSON de códigos de causas RELAJABLES confirmadas por el administrador en esta operación (p. ej. ["DISTANCIA_EXCEDIDA"]). NULL para todo movimiento que no provenga de una excepción de preferencia flexible — nunca se infiere, nunca se recalcula.';

-- ─────────────────────────────────────────────────────────────────────────
-- (b) registrar_movimiento_designacion() — MISMO cuerpo y validaciones que
-- 083, con un único parámetro nuevo opcional (p_causas_confirmadas, al
-- final, DEFAULT NULL) y esa misma columna agregada al INSERT. Ningún
-- llamador existente pasa este argumento — para ellos, el comportamiento es
-- idéntico, bit a bit, al de antes de esta migración.
--
-- Postgres trata una lista de parámetros distinta (aunque solo agregue uno
-- opcional al final) como una SOBRECARGA nueva, no como un reemplazo real
-- de la función de 14 parámetros — CREATE OR REPLACE con una firma distinta
-- deja AMBAS versiones viviendo a la vez, y cualquier llamada que use solo
-- parámetros nombrados (como ya hacen reemplazar_jurado_asignacion_con_
-- bitacora y modificar_jurado_propuesta_borrador) se vuelve ambigua
-- ("function name ... is not unique"). Se elimina explícitamente la versión
-- de 14 parámetros antes de crear la de 15 — esto es un verdadero
-- reemplazo, nunca una sobrecarga adicional.
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS registrar_movimiento_designacion(
    TEXT, UUID, UUID, UUID, UUID, UUID, TEXT, UUID, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, UUID
);

CREATE OR REPLACE FUNCTION registrar_movimiento_designacion(
    p_tipo_movimiento             TEXT,
    p_rodeo_id                    UUID,
    p_actor_id                    UUID,
    p_propuesta_detalle_id        UUID DEFAULT NULL,
    p_asignacion_id               UUID DEFAULT NULL,
    p_usuario_pagado_id_anterior  UUID DEFAULT NULL,
    p_nombre_anterior_snapshot    TEXT DEFAULT NULL,
    p_usuario_pagado_id_nuevo     UUID DEFAULT NULL,
    p_nombre_nuevo_snapshot       TEXT DEFAULT NULL,
    p_motivo_catalogo_id          UUID DEFAULT NULL,
    p_motivo_detalle              TEXT DEFAULT NULL,
    p_actor_tipo                  TEXT DEFAULT 'administrador',
    p_fecha_efectiva              TIMESTAMPTZ DEFAULT NULL,
    p_operacion_id                UUID DEFAULT NULL,
    p_causas_confirmadas          JSONB DEFAULT NULL
) RETURNS bitacora_designaciones
LANGUAGE plpgsql
-- SECURITY INVOKER (el valor por defecto de Postgres) — mismo criterio ya
-- documentado en 083, sin cambios.
SET search_path = public
AS $$
DECLARE
    v_resultado bitacora_designaciones;
    v_rodeo_real_propuesta UUID;
    v_rodeo_real_asignacion UUID;
BEGIN
    IF p_propuesta_detalle_id IS NULL AND p_asignacion_id IS NULL THEN
        RAISE EXCEPTION 'REFERENCIA_REQUERIDA: debe indicarse propuesta_detalle_id o asignacion_id (o ambas)';
    END IF;
    IF p_actor_id IS NULL THEN
        RAISE EXCEPTION 'ACTOR_REQUERIDO';
    END IF;

    IF p_propuesta_detalle_id IS NOT NULL THEN
        SELECT rodeo_id INTO v_rodeo_real_propuesta
        FROM propuestas_designacion_detalle WHERE id = p_propuesta_detalle_id;
        IF v_rodeo_real_propuesta IS DISTINCT FROM p_rodeo_id THEN
            RAISE EXCEPTION 'RODEO_INCONSISTENTE_CON_PROPUESTA: la propuesta % pertenece al rodeo %, no a %',
                p_propuesta_detalle_id, v_rodeo_real_propuesta, p_rodeo_id;
        END IF;
    END IF;
    IF p_asignacion_id IS NOT NULL THEN
        SELECT rodeo_id INTO v_rodeo_real_asignacion
        FROM asignaciones WHERE id = p_asignacion_id;
        IF v_rodeo_real_asignacion IS DISTINCT FROM p_rodeo_id THEN
            RAISE EXCEPTION 'RODEO_INCONSISTENTE_CON_ASIGNACION: la asignación % pertenece al rodeo %, no a %',
                p_asignacion_id, v_rodeo_real_asignacion, p_rodeo_id;
        END IF;
    END IF;

    INSERT INTO bitacora_designaciones (
        propuesta_detalle_id, asignacion_id, rodeo_id,
        usuario_pagado_id_anterior, nombre_anterior_snapshot,
        usuario_pagado_id_nuevo, nombre_nuevo_snapshot,
        tipo_movimiento, motivo_catalogo_id, motivo_detalle,
        actor_id, actor_tipo, fecha_efectiva, operacion_id, causas_confirmadas
    ) VALUES (
        p_propuesta_detalle_id, p_asignacion_id, p_rodeo_id,
        p_usuario_pagado_id_anterior, p_nombre_anterior_snapshot,
        p_usuario_pagado_id_nuevo, p_nombre_nuevo_snapshot,
        p_tipo_movimiento, p_motivo_catalogo_id, p_motivo_detalle,
        p_actor_id, p_actor_tipo, COALESCE(p_fecha_efectiva, now()), p_operacion_id, p_causas_confirmadas
    )
    RETURNING * INTO v_resultado;

    RETURN v_resultado;
END;
$$;

-- El REVOKE/GRANT de 083 referenciaba la firma ANTERIOR (14 tipos, sin
-- JSONB) — esa referencia histórica queda intacta en el archivo 083 (ya
-- aplicada), pero a partir de esta migración la función real tiene 15
-- parámetros: se vuelve a otorgar/revocar con la firma COMPLETA nueva, con
-- el mismo criterio de 083/084 (anon/authenticated/PUBLIC explícitos, por
-- el ALTER DEFAULT PRIVILEGES a nivel de esquema ya documentado en 084/
-- Decisión 14).
REVOKE ALL ON FUNCTION registrar_movimiento_designacion(
    TEXT, UUID, UUID, UUID, UUID, UUID, TEXT, UUID, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, UUID, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION registrar_movimiento_designacion(
    TEXT, UUID, UUID, UUID, UUID, UUID, TEXT, UUID, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, UUID, JSONB
) TO service_role;

COMMENT ON FUNCTION registrar_movimiento_designacion IS
    'Fase 1A (ampliada en la Corrección final de seguridad, sección 3): única vía autorizada para escribir en bitacora_designaciones. Exige al menos una de propuesta_detalle_id/asignacion_id y un actor_id. p_causas_confirmadas (JSONB, opcional) registra qué causas relajables fueron confirmadas por el administrador cuando el movimiento proviene de una excepción de preferencia flexible — NULL para cualquier otro origen.';

-- ─────────────────────────────────────────────────────────────────────────
-- Valor nuevo de tipo_movimiento — aditivo, nunca reemplaza ni reinterpreta
-- ninguno de los 10 valores existentes.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE bitacora_designaciones DROP CONSTRAINT IF EXISTS bitacora_designaciones_tipo_movimiento_check;
ALTER TABLE bitacora_designaciones ADD CONSTRAINT bitacora_designaciones_tipo_movimiento_check
    CHECK (tipo_movimiento IN (
        'propuesta_automatica', 'modificacion_manual_borrador', 'aplicacion_propuesta',
        'aceptacion', 'rechazo', 'reemplazo', 'cambio_emergencia', 'regularizacion_posterior',
        'enroque', 'rectificacion_administrativa',
        'designacion_manual_con_advertencia'
    ));

-- ─────────────────────────────────────────────────────────────────────────
-- Nueva función — única vía que conecta una designación manual NUEVA (no un
-- reemplazo, no una propuesta) con bitacora_designaciones, de forma atómica.
-- Uso EXCLUSIVO del camino de excepción (ver "ALCANCE" arriba) — el
-- backend solo la invoca cuando confirmar_advertencias=true y existe al
-- menos una causa relajable confirmada.
-- ─────────────────────────────────────────────────────────────────────────
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
        WHERE causa NOT IN ('DISTANCIA_EXCEDIDA', 'ASOCIACION_REPETIDA_TEMPORADA', 'FINDE_CONSECUTIVO', 'JURADO_SIN_COMUNA_RESOLVIBLE')
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

COMMENT ON FUNCTION crear_asignacion_con_bitacora IS
    'Corrección final de seguridad (sección 3, revisión puntual): única vía que conecta una designación manual NUEVA (nunca un reemplazo) con bitacora_designaciones, de forma atómica. Uso exclusivo del camino de excepción (confirmar_advertencias=true con al menos una causa relajable confirmada y reconocida) — exige motivo_catalogo_id. Revalida disponibilidad declarada para TODOS los días del rodeo, cruce con otro rodeo (excluyendo antecedentes ya no vigentes: anulados o rechazados) y consistencia de duración/pago contra la fila de rodeos bloqueada — todo bajo advisory lock, defensa en profundidad real. Las causas de negocio del motor (MISMA_ASOCIACION, categoría/matriz, distancia) las evalúa exclusivamente el backend (evaluarElegibilidadJurado), nunca se reimplementan en SQL. La creación SIN excepción sigue usando el INSERT simple existente, sin cambios.';

-- Revisión puntual, punto 5 — mecanismo estándar de Supabase/PostgREST
-- (mismo patrón ya establecido en las migraciones 088/093) para forzar la
-- recarga inmediata de su caché de funciones RPC: sin esto, el backend
-- podría no encontrar crear_asignacion_con_bitacora() (o la nueva firma de
-- registrar_movimiento_designacion) hasta la próxima recarga automática
-- periódica de PostgREST. Notificación de sesión (NOTIFY), no una
-- operación transaccional — idempotente, seguro de repetir.
NOTIFY pgrst, 'reload schema';

COMMIT;

-- Reversible:
--   DROP FUNCTION IF EXISTS crear_asignacion_con_bitacora(UUID, UUID, TEXT, INTEGER, INTEGER, INTEGER, UUID, UUID, JSONB, TEXT, UUID);
--   ALTER TABLE bitacora_designaciones DROP CONSTRAINT IF EXISTS bitacora_designaciones_tipo_movimiento_check;
--   ALTER TABLE bitacora_designaciones ADD CONSTRAINT bitacora_designaciones_tipo_movimiento_check CHECK (tipo_movimiento IN ('propuesta_automatica','modificacion_manual_borrador','aplicacion_propuesta','aceptacion','rechazo','reemplazo','cambio_emergencia','regularizacion_posterior','enroque','rectificacion_administrativa'));
--   (ese rollback del CHECK fallaría si ya existen filas 'designacion_manual_con_advertencia' — intencional: no se revierte perdiendo el estado real de datos ya escritos)
--   DROP FUNCTION IF EXISTS registrar_movimiento_designacion(TEXT, UUID, UUID, UUID, UUID, UUID, TEXT, UUID, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, UUID, JSONB); -- y restaurar la versión de 083 (14 parámetros) si se revierte por completo
--   ALTER TABLE bitacora_designaciones DROP COLUMN IF EXISTS causas_confirmadas;
--   NOTIFY pgrst, 'reload schema'; -- repetir después de cualquier reversión, para que PostgREST deje de ofrecer la función/firma eliminadas
