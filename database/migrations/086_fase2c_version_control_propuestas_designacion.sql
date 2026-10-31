-- ═════════════════════════════════════════════════════════════════════════
-- 086_fase2c_version_control_propuestas_designacion.sql
-- Fase 2C — Interfaz, versiones, control de cambios y exportaciones.
-- Revisión correctiva (Fase 2C — validación de integridad previa al
-- despliegue): la primera versión de esta migración incluía
-- aplicar_detalle_propuesta_designacion(), que creaba UNA asignación por
-- llamada RPC — cada detalle se confirmaba en su PROPIA transacción
-- independiente. Un mutex a nivel de aplicación (aplicacion_en_curso_desde)
-- NO sustituye una transacción atómica real: con 19 de 20 detalles
-- insertados con éxito y el 20° fallando, las primeras 19 asignaciones
-- quedaban confirmadas igual — aplicación PARCIAL, violando el requisito
-- "la propuesta se aplica íntegramente o no se aplica". Esta revisión
-- reemplaza esa función por aplicar_propuesta_designacion_completa(...)
-- (sección D más abajo), que procesa TODO el lote dentro de UNA sola
-- transacción de Postgres — cualquier error en cualquier fila revierte
-- absolutamente todo lo insertado en esa misma llamada, sin excepción.
-- Verificado en Postgres real (PGlite) con el caso exacto pedido: 20 filas,
-- la 20ª inválida -> 0 asignaciones nuevas, 0 movimientos de bitácora,
-- propuesta intacta en BORRADOR (ver
-- propuestaDesignacionVersionControl.rpc.test.js).
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — preparada y probada localmente (PGlite) por
-- autorización explícita y acotada a "implementación local de Fase 2C".
-- NO ejecutar sobre Supabase sin una autorización separada.
--
-- Verificado contra el esquema REAL de producción (jurados_2026, solo
-- lectura, sin modificar nada): 4 propuestas BORRADOR / 90 filas de detalle
-- existentes hoy, ninguna con columnas que colisionen con las agregadas
-- aquí (motor_usado/fecha_corte_tecnica/resultado_cobertura_json/
-- advertencias_json/aplicacion_en_curso_desde — ninguna existe todavía).
-- 40 de esas 90 filas YA tienen una asignación real vinculada
-- (asignaciones.propuesta_detalle_id IS NOT NULL) — producto del código
-- anterior a esta revisión, que SÍ permitía aplicación parcial fila por
-- fila. Por eso aplicar_propuesta_designacion_completa() (sección D) omite
-- sin error toda fila YA aplicada (nunca la reprocesa ni la duplica) y
-- modificar_jurado_propuesta_borrador() (sección C) ahora bloquea
-- explícitamente cualquier intento de modificar una fila que ya generó una
-- asignación real — ningún dato existente queda inválido ni se pierde.
--
-- NO modifica las migraciones 083/084/085 ya aplicadas — solo las reutiliza
-- (catalogo_motivos_designacion, bitacora_designaciones,
-- registrar_movimiento_designacion). No toca asignaciones existentes, no
-- toca bonos/cartillas/evaluaciones/pagos/portales institucionales.
--
-- ALCANCE:
--   A. propuestas_designacion — 4 columnas aditivas (motor_usado,
--      fecha_corte_tecnica, resultado_cobertura_json, advertencias_json).
--   B. propuestas_designacion — 1 columna aditiva (aplicacion_en_curso_desde)
--      como mutex de aplicación — capa adicional de defensa en profundidad,
--      no la garantía de atomicidad (esa es la transacción de la sección D).
--   C. modificar_jurado_propuesta_borrador(...) — modificación manual de un
--      BORRADOR con motivo obligatorio y trazabilidad atómica en
--      bitacora_designaciones. Orden de bloqueos CORREGIDO en esta revisión:
--      bloquea la cabecera (propuestas_designacion) ANTES que el detalle —
--      mismo orden que usa la sección D — para que ambas RPC nunca puedan
--      formar un ciclo de espera circular entre sí. Bloquea explícitamente
--      la modificación de una fila que ya generó una asignación real.
--   D. aplicar_propuesta_designacion_completa(...) — ÚNICA vía que crea
--      asignaciones reales desde una propuesta: procesa el LOTE COMPLETO de
--      filas pendientes dentro de UNA transacción, revalida cobertura/
--      disponibilidad/habilitación/conflictos de TODAS las filas, usa el
--      MISMO advisory lock por jurado que 084 (orden consistente con
--      reemplazar_jurado_asignacion_con_bitacora), y registra en
--      bitacora_designaciones (tipo_movimiento='aplicacion_propuesta', ya
--      previsto desde 083 y nunca usado hasta ahora) quién autorizó la
--      aplicación de CADA fila — incluidas las PENDIENTE, sin que eso las
--      haga parecer "revisadas individualmente" (ver Decisión 2 más abajo).
--
-- Aditiva y reversible. Sin DROP de nada existente fuera de esta migración.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- A) Metadata V1 de la propuesta — qué motor, cuándo se leyeron los datos,
--    y el resultado de cobertura/advertencias del motor global (NULL para
--    el motor local, que no tiene búsqueda que reportar).
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE propuestas_designacion
    ADD COLUMN IF NOT EXISTS motor_usado TEXT NOT NULL DEFAULT 'local'
        CHECK (motor_usado IN ('local', 'global')),
    ADD COLUMN IF NOT EXISTS fecha_corte_tecnica TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS resultado_cobertura_json JSONB,
    ADD COLUMN IF NOT EXISTS advertencias_json JSONB;

COMMENT ON COLUMN propuestas_designacion.motor_usado IS
    'Fase 2C: motor que generó esta propuesta (local|global). DEFAULT ''local'' para toda fila existente — ninguna propuesta anterior a esta migración usó el motor global (no existía). Verificado: las 4 propuestas BORRADOR reales de producción quedan en ''local'', correcto.';
COMMENT ON COLUMN propuestas_designacion.fecha_corte_tecnica IS
    'Fase 2C: momento en que el motor leyó los datos reales (disponibilidad/asignaciones) para ESTA corrida — distinto de created_at. NULL para toda propuesta guardada antes de esta migración.';
COMMENT ON COLUMN propuestas_designacion.resultado_cobertura_json IS
    'Fase 2C: resumen de cobertura del motor global en esta corrida. NULL cuando motor_usado=''local'' o para propuestas anteriores a esta migración.';
COMMENT ON COLUMN propuestas_designacion.advertencias_json IS
    'Fase 2C: advertencias GLOBALES del motor — nunca las advertencias por fila, que ya viven en propuestas_designacion_detalle.metricas_json.';

-- ─────────────────────────────────────────────────────────────────────────
-- B) Mutex de aplicación — defensa adicional (falla rápido con un 409 claro
--    en vez de esperar bloqueada en la transacción de la sección D), NUNCA
--    el mecanismo de atomicidad en sí — eso lo garantiza exclusivamente la
--    transacción única de aplicar_propuesta_designacion_completa(). Se
--    limpia siempre al terminar la petición (éxito o error). Riesgo
--    residual aceptado y documentado, mismo criterio que 084 (Decisión 13)
--    para su propio advisory lock: una caída del proceso a mitad de camino
--    podría dejarlo pegado.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE propuestas_designacion
    ADD COLUMN IF NOT EXISTS aplicacion_en_curso_desde TIMESTAMPTZ;

COMMENT ON COLUMN propuestas_designacion.aplicacion_en_curso_desde IS
    'Fase 2C: mutex de aplicación (defensa en profundidad, no la garantía de atomicidad — ver aplicar_propuesta_designacion_completa). No NULL mientras POST /propuestas/:id/aplicar está en curso. Se limpia siempre al terminar esa petición.';

-- ─────────────────────────────────────────────────────────────────────────
-- C) Modificación manual de un jurado seleccionado en un BORRADOR, con
--    motivo obligatorio y trazabilidad atómica en bitacora_designaciones.
--
-- DECISIÓN 1 (revisión correctiva) — orden de bloqueos: la cabecera
-- (propuestas_designacion) se bloquea ANTES que el detalle. La versión
-- original de esta función bloqueaba el detalle primero y la propuesta
-- después — el orden INVERSO al que usa aplicar_propuesta_designacion_
-- completa (sección D), que necesariamente bloquea la cabecera primero
-- (para poder contar y recorrer TODOS sus detalles). Dos llamadas
-- concurrentes, una a cada función sobre la MISMA propuesta, podían formar
-- un ciclo de espera circular (deadlock) bajo ese orden inconsistente.
-- Corregido: esta función ahora lee primero, SIN bloqueo, el propuesta_id
-- del detalle (inmutable — ningún código de este proyecto lo actualiza
-- nunca, mismo argumento ya usado en 084 para leer rodeo_id de una
-- asignación antes de bloquear `rodeos`), bloquea la cabecera, y solo
-- entonces bloquea el detalle específico.
--
-- DECISIÓN 2 (revisión correctiva) — bloquea explícitamente la
-- modificación de una fila que YA generó una asignación real
-- (asignaciones.propuesta_detalle_id = este detalle): un borrador ya
-- aplicado no puede seguir editándose como si todavía fuera una simple
-- intención — la asignación real ya es la fuente de verdad operativa, y
-- cualquier corrección posterior debe pasar por el reemplazo transaccional
-- de Fase 1B (084) sobre esa asignación, nunca por esta función. Hallazgo
-- real de esta revisión: 40 de las 90 filas de detalle ya existentes en
-- producción ya tienen una asignación real vinculada.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION modificar_jurado_propuesta_borrador(
    p_detalle_id             UUID,
    p_jurado_id_nuevo        UUID,
    p_estado_revision_nuevo  TEXT,
    p_origen_seleccion_nuevo TEXT,
    p_motivo_catalogo_id     UUID,
    p_actor_id               UUID,
    p_motivo_detalle         TEXT  DEFAULT NULL,
    p_metricas_json_nuevo    JSONB DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
-- SECURITY INVOKER (ver criterio ya documentado en 083/084: el único rol
-- con EXECUTE es service_role, que ya tiene GRANT directo sobre todas las
-- tablas que esta función toca — DEFINER no otorgaría ninguna capacidad
-- adicional, solo ampliaría la superficie de ataque).
SET search_path = public
AS $$
DECLARE
    v_propuesta_id_lookup UUID;
    v_detalle     propuestas_designacion_detalle%ROWTYPE;
    v_propuesta   propuestas_designacion%ROWTYPE;
    v_motivo      catalogo_motivos_designacion%ROWTYPE;
    v_jurado      usuarios_pagados%ROWTYPE;
    v_ya_aplicada BOOLEAN;
    v_bitacora    bitacora_designaciones;
    v_actualizado propuestas_designacion_detalle%ROWTYPE;
BEGIN
    IF p_actor_id IS NULL THEN
        RAISE EXCEPTION 'ACTOR_REQUERIDO';
    END IF;
    IF p_motivo_catalogo_id IS NULL THEN
        RAISE EXCEPTION 'MOTIVO_REQUERIDO';
    END IF;
    IF p_jurado_id_nuevo IS NULL THEN
        RAISE EXCEPTION 'JURADO_NUEVO_REQUERIDO';
    END IF;
    IF p_estado_revision_nuevo NOT IN ('ACEPTADO', 'MODIFICADO') THEN
        RAISE EXCEPTION 'ESTADO_REVISION_INVALIDO: %', p_estado_revision_nuevo;
    END IF;
    IF p_origen_seleccion_nuevo NOT IN ('MANUAL', 'MANUAL_CON_ADVERTENCIA') THEN
        RAISE EXCEPTION 'ORIGEN_SELECCION_INVALIDO: %', p_origen_seleccion_nuevo;
    END IF;

    -- Decisión 1 — lectura SIN bloqueo de propuesta_id (inmutable), luego
    -- se bloquea la cabecera ANTES que el detalle.
    SELECT propuesta_id INTO v_propuesta_id_lookup
    FROM propuestas_designacion_detalle WHERE id = p_detalle_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DETALLE_NO_ENCONTRADO';
    END IF;

    SELECT * INTO v_propuesta FROM propuestas_designacion WHERE id = v_propuesta_id_lookup FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PROPUESTA_NO_ENCONTRADA';
    END IF;
    IF v_propuesta.estado <> 'BORRADOR' THEN
        RAISE EXCEPTION 'PROPUESTA_NO_ES_BORRADOR: solo se puede modificar una propuesta en estado BORRADOR';
    END IF;

    SELECT * INTO v_detalle FROM propuestas_designacion_detalle WHERE id = p_detalle_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DETALLE_NO_ENCONTRADO';
    END IF;

    -- Decisión 2 — una fila ya aplicada (asignación real vinculada) nunca
    -- se modifica desde el borrador.
    SELECT EXISTS (SELECT 1 FROM asignaciones WHERE propuesta_detalle_id = p_detalle_id) INTO v_ya_aplicada;
    IF v_ya_aplicada THEN
        RAISE EXCEPTION 'DETALLE_YA_APLICADO: esta fila ya generó una designación real — use el reemplazo transaccional de Fase 1B sobre esa asignación, no esta función';
    END IF;

    SELECT * INTO v_motivo FROM catalogo_motivos_designacion WHERE id = p_motivo_catalogo_id;
    IF NOT FOUND OR v_motivo.activo IS NOT TRUE THEN
        RAISE EXCEPTION 'MOTIVO_INVALIDO';
    END IF;

    -- Identidad del jurado nuevo SIEMPRE leída de la fuente real (mismo
    -- criterio que 084, Decisión 6) — nunca un nombre de texto libre.
    SELECT * INTO v_jurado FROM usuarios_pagados WHERE id = p_jurado_id_nuevo;
    IF NOT FOUND OR v_jurado.activo IS NOT TRUE OR v_jurado.tipo_persona <> 'jurado' THEN
        RAISE EXCEPTION 'JURADO_NUEVO_INVALIDO';
    END IF;

    -- jurado_id_propuesto (V1) NUNCA se toca en este UPDATE — invariante
    -- central de la Fase 2C, sección 2.
    UPDATE propuestas_designacion_detalle SET
        jurado_id_seleccionado = p_jurado_id_nuevo,
        estado_revision        = p_estado_revision_nuevo,
        origen_seleccion       = p_origen_seleccion_nuevo,
        metricas_json          = COALESCE(p_metricas_json_nuevo, metricas_json),
        updated_at             = now()
    WHERE id = p_detalle_id
    RETURNING * INTO v_actualizado;

    -- Única vía de escritura hacia la bitácora (083) — si esto falla, toda
    -- la función falla y Postgres revierte también el UPDATE de arriba.
    v_bitacora := registrar_movimiento_designacion(
        p_tipo_movimiento            := 'modificacion_manual_borrador',
        p_rodeo_id                   := v_detalle.rodeo_id,
        p_actor_id                   := p_actor_id,
        p_propuesta_detalle_id       := p_detalle_id,
        p_usuario_pagado_id_anterior := v_detalle.jurado_id_seleccionado,
        p_usuario_pagado_id_nuevo    := p_jurado_id_nuevo,
        p_nombre_nuevo_snapshot      := v_jurado.nombre_completo,
        p_motivo_catalogo_id         := p_motivo_catalogo_id,
        p_motivo_detalle             := p_motivo_detalle
    );

    RETURN jsonb_build_object('detalle', row_to_json(v_actualizado), 'bitacora_id', v_bitacora.id);
END;
$$;

REVOKE ALL ON FUNCTION modificar_jurado_propuesta_borrador(
    UUID, UUID, TEXT, TEXT, UUID, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION modificar_jurado_propuesta_borrador(
    UUID, UUID, TEXT, TEXT, UUID, UUID, TEXT, JSONB
) TO service_role;

COMMENT ON FUNCTION modificar_jurado_propuesta_borrador IS
    'Fase 2C (revisión correctiva): única vía que conecta una modificación manual de jurado en un BORRADOR con bitacora_designaciones, de forma atómica. Exige motivo del catálogo, propuesta en estado BORRADOR, y bloquea si la fila ya generó una asignación real. Orden de bloqueos: propuesta antes que detalle (consistente con aplicar_propuesta_designacion_completa). Nunca modifica jurado_id_propuesto.';

-- ─────────────────────────────────────────────────────────────────────────
-- D) Aplicación de una propuesta COMPLETA — única vía que crea asignaciones
--    reales desde un borrador. TODO el lote se procesa en UNA transacción:
--    cualquier error en cualquier fila revierte absolutamente todo lo
--    insertado por esta misma llamada (ninguna asignación, ningún
--    movimiento de bitácora). Reemplaza a aplicar_detalle_propuesta_
--    designacion (eliminada — un RPC por fila es, por definición,
--    incompatible con "todo o nada").
--
-- p_aplicaciones: JSONB array de
--   { detalle_id, usuario_pagado_id, categoria_aplicada,
--     valor_diario_aplicado, pago_base_calculado, duracion_dias_aplicada }
-- — el pago se sigue calculando EXCLUSIVAMENTE en el backend (calcularPagoBase/
-- obtenerTarifas, única función real, nunca reimplementada en SQL) — esta
-- función solo valida seguridad de colocación (cobertura/disponibilidad/
-- habilitación/conflictos) y ejecuta el INSERT, con los montos ya resueltos
-- que el backend le entrega.
--
-- DECISIÓN 1 — orden de bloqueos: cabecera (propuestas_designacion) PRIMERO
-- (necesario para poder contar/recorrer sus detalles), consistente con la
-- sección C. Dentro del lote, cada fila bloquea su propio advisory lock de
-- jurado (MISMO espacio que 084) y luego su fila de `rodeos`, en el orden
-- en que el BACKEND ordenó el arreglo — el backend ordena ascendente por
-- (usuario_pagado_id, rodeo_id) antes de llamar, para que dos lotes
-- concurrentes que compitan por los mismos jurados/rodeos (de propuestas
-- DISTINTAS, o un lote compitiendo con un reemplazo de Fase 1B) siempre
-- intenten adquirir esos recursos compartidos en la MISMA secuencia
-- relativa — evita el ciclo de espera circular que causaría un deadlock.
-- Si el llamador no ordenara (defecto de programación, no de seguridad),
-- el único efecto posible es que Postgres detecte el deadlock y aborte la
-- transacción más joven — nunca una corrupción ni una aplicación parcial.
--
-- DECISIÓN 2 — trazabilidad de la AUTORIZACIÓN DE APLICAR (distinta de una
-- revisión individual explícita): cada fila aplicada, SIN EXCEPCIÓN —
-- incluida una que seguía PENDIENTE (sugerencia del motor nunca aceptada
-- ni modificada por un administrador) — queda registrada en
-- bitacora_designaciones con tipo_movimiento='aplicacion_propuesta' (083,
-- previsto desde el inicio y nunca usado hasta esta revisión) y el
-- actor_id de quien ejecutó la aplicación. Esto NUNCA se confunde con
-- 'modificacion_manual_borrador' (que solo existe cuando SÍ hubo una
-- decisión administrativa por fila) — la distinción de tipo_movimiento es,
-- en sí misma, la prueba de que una fila PENDIENTE jamás se hizo pasar por
-- "revisada individualmente": solo se registra que la aplicación CONJUNTA
-- fue autorizada por ese actor, nunca más que eso.
--
-- DECISIÓN 3 — cobertura completa y "lote completo" se verifican DOS VECES:
-- (a) toda fila de la propuesta debe tener jurado efectivo (si no, aborta
-- antes de tocar cualquier fila); (b) el tamaño de p_aplicaciones debe
-- coincidir EXACTAMENTE con la cantidad de filas con jurado efectivo que
-- AÚN no tienen una asignación real — un lote incompleto (por error del
-- backend, nunca por decisión del administrador) aborta sin aplicar nada,
-- en vez de aplicar solo una parte en silencio.
--
-- DECISIÓN 4 — filas YA aplicadas (asignaciones.propuesta_detalle_id ya
-- existente — 40 casos reales en producción, de código anterior a esta
-- revisión) se OMITEN sin error: no se reprocesan, no se duplican, no
-- bloquean la aplicación del resto. No cuentan en el denominador de la
-- Decisión 3 (el backend tampoco las incluye en p_aplicaciones).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION aplicar_propuesta_designacion_completa(
    p_propuesta_id UUID,
    p_actor_id     UUID,
    p_aplicaciones JSONB
) RETURNS JSONB
LANGUAGE plpgsql
-- SECURITY INVOKER (mismo criterio que el resto de esta migración y de 084).
SET search_path = public
AS $$
DECLARE
    v_propuesta           propuestas_designacion%ROWTYPE;
    v_detalle             propuestas_designacion_detalle%ROWTYPE;
    v_rodeo               rodeos%ROWTYPE;
    v_jurado              usuarios_pagados%ROWTYPE;
    v_aplicacion          JSONB;
    v_detalle_id          UUID;
    v_usuario_pagado_id   UUID;
    v_categoria_aplicada  TEXT;
    v_valor_diario        INTEGER;
    v_pago_base           INTEGER;
    v_duracion_dias       INTEGER;
    v_ya_designado        BOOLEAN;
    v_cruce               BOOLEAN;
    v_ya_aplicada         BOOLEAN;
    v_sin_disponibilidad  BOOLEAN;
    v_asignacion          asignaciones%ROWTYPE;
    v_aplicadas           JSONB := '[]'::JSONB;
    v_bitacora            bitacora_designaciones;
    v_sin_jurado_efectivo INTEGER;
    v_pendientes_reales   INTEGER;
BEGIN
    IF p_actor_id IS NULL THEN
        RAISE EXCEPTION 'ACTOR_REQUERIDO';
    END IF;
    IF p_aplicaciones IS NULL OR jsonb_typeof(p_aplicaciones) <> 'array' OR jsonb_array_length(p_aplicaciones) = 0 THEN
        RAISE EXCEPTION 'APLICACIONES_REQUERIDAS';
    END IF;

    -- Decisión 1 — bloquea la cabecera PRIMERO.
    SELECT * INTO v_propuesta FROM propuestas_designacion WHERE id = p_propuesta_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PROPUESTA_NO_ENCONTRADA';
    END IF;
    IF v_propuesta.estado <> 'BORRADOR' THEN
        RAISE EXCEPTION 'PROPUESTA_NO_ES_BORRADOR';
    END IF;

    -- Decisión 3(a) — cobertura completa: TODA fila debe tener jurado
    -- efectivo (misma semántica que obtenerJuradoEfectivo() del backend).
    SELECT count(*) INTO v_sin_jurado_efectivo
    FROM propuestas_designacion_detalle
    WHERE propuesta_id = p_propuesta_id
      AND (
          (estado_revision IN ('ACEPTADO', 'MODIFICADO') AND jurado_id_seleccionado IS NULL)
          OR (estado_revision = 'PENDIENTE' AND jurado_id_propuesto IS NULL)
          OR estado_revision IN ('SIN_PROPUESTA', 'NO_EVALUABLE', 'SIN_JURADO_ACTUAL')
      );
    IF v_sin_jurado_efectivo > 0 THEN
        RAISE EXCEPTION 'COBERTURA_INCOMPLETA: % rodeo(s) sin jurado asignado', v_sin_jurado_efectivo;
    END IF;

    -- Decisión 3(b) — el lote debe cubrir EXACTAMENTE las filas con jurado
    -- efectivo que aún no tienen una asignación real (Decisión 4: las ya
    -- aplicadas no cuentan).
    SELECT count(*) INTO v_pendientes_reales
    FROM propuestas_designacion_detalle d
    WHERE d.propuesta_id = p_propuesta_id
      AND NOT EXISTS (SELECT 1 FROM asignaciones a WHERE a.propuesta_detalle_id = d.id);
    IF jsonb_array_length(p_aplicaciones) <> v_pendientes_reales THEN
        RAISE EXCEPTION 'LOTE_INCOMPLETO: se recibieron % aplicaciones, se esperaban %', jsonb_array_length(p_aplicaciones), v_pendientes_reales;
    END IF;

    FOR v_aplicacion IN SELECT * FROM jsonb_array_elements(p_aplicaciones)
    LOOP
        v_detalle_id         := (v_aplicacion->>'detalle_id')::UUID;
        v_usuario_pagado_id  := (v_aplicacion->>'usuario_pagado_id')::UUID;
        v_categoria_aplicada := v_aplicacion->>'categoria_aplicada';
        v_valor_diario       := (v_aplicacion->>'valor_diario_aplicado')::INTEGER;
        v_pago_base          := (v_aplicacion->>'pago_base_calculado')::INTEGER;
        v_duracion_dias      := (v_aplicacion->>'duracion_dias_aplicada')::INTEGER;

        IF v_detalle_id IS NULL OR v_usuario_pagado_id IS NULL THEN
            RAISE EXCEPTION 'APLICACION_INVALIDA: detalle_id y usuario_pagado_id son obligatorios';
        END IF;

        SELECT * INTO v_detalle FROM propuestas_designacion_detalle WHERE id = v_detalle_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'DETALLE_NO_ENCONTRADO: %', v_detalle_id;
        END IF;
        IF v_detalle.propuesta_id <> p_propuesta_id THEN
            RAISE EXCEPTION 'DETALLE_AJENO_A_LA_PROPUESTA: %', v_detalle_id;
        END IF;

        -- Decisión 4 — ya aplicada (de una corrida anterior) -> se omite.
        SELECT EXISTS (SELECT 1 FROM asignaciones WHERE propuesta_detalle_id = v_detalle_id) INTO v_ya_aplicada;
        IF v_ya_aplicada THEN
            CONTINUE;
        END IF;

        -- MISMO espacio de advisory lock por jurado que 084 (Decisión 13) —
        -- serializa con cualquier reemplazo transaccional de Fase 1B que
        -- compita por el MISMO jurado. Primera operación sobre este jurado
        -- dentro del loop, antes de cualquier otro lock de esta iteración.
        PERFORM pg_advisory_xact_lock(hashtextextended(v_usuario_pagado_id::text, 0));

        SELECT * INTO v_rodeo FROM rodeos WHERE id = v_detalle.rodeo_id FOR UPDATE;
        IF NOT FOUND OR v_rodeo.estado <> 'activo' THEN
            RAISE EXCEPTION 'RODEO_INVALIDO: %', v_detalle.rodeo_id;
        END IF;

        SELECT * INTO v_jurado FROM usuarios_pagados WHERE id = v_usuario_pagado_id;
        IF NOT FOUND OR v_jurado.activo IS NOT TRUE OR v_jurado.tipo_persona <> 'jurado' THEN
            RAISE EXCEPTION 'JURADO_INVALIDO: %', v_usuario_pagado_id;
        END IF;

        SELECT EXISTS (
            SELECT 1 FROM asignaciones
            WHERE rodeo_id = v_rodeo.id AND tipo_persona = 'jurado' AND estado <> 'anulado'
        ) INTO v_ya_designado;
        IF v_ya_designado THEN
            RAISE EXCEPTION 'RODEO_YA_DESIGNADO: %', v_rodeo.id;
        END IF;

        -- Disponibilidad declarada para TODAS las fechas del rodeo — mismo
        -- chequeo que ya hacía el backend en JavaScript, ahora también
        -- dentro de la transacción (nunca confiar solo en la verificación
        -- previa, sección 1 del pedido de revisión).
        SELECT EXISTS (
            SELECT 1
            FROM generate_series(0, COALESCE(v_rodeo.duracion_dias, 1) - 1) AS offset_dias
            WHERE NOT EXISTS (
                SELECT 1 FROM disponibilidad_usuarios du
                WHERE du.usuario_pagado_id = v_usuario_pagado_id
                  AND du.fecha = (v_rodeo.fecha + offset_dias * INTERVAL '1 day')::date
            )
        ) INTO v_sin_disponibilidad;
        IF v_sin_disponibilidad THEN
            RAISE EXCEPTION 'SIN_DISPONIBILIDAD_DECLARADA: %', v_detalle_id;
        END IF;

        -- Cruce de fechas — ve también las filas YA INSERTADAS por este
        -- mismo lote (misma transacción/sesión), además de las
        -- preexistentes: cubre conflictos intra-lote sin lógica aparte.
        SELECT EXISTS (
            SELECT 1
            FROM asignaciones a2
            JOIN rodeos r2 ON r2.id = a2.rodeo_id
            WHERE a2.usuario_pagado_id = v_usuario_pagado_id
              AND a2.estado <> 'anulado'
              AND (r2.fecha + (COALESCE(r2.duracion_dias, 1) - 1) * INTERVAL '1 day')::date >= v_rodeo.fecha
              AND r2.fecha <= (v_rodeo.fecha + (COALESCE(v_rodeo.duracion_dias, 1) - 1) * INTERVAL '1 day')::date
        ) INTO v_cruce;
        IF v_cruce THEN
            RAISE EXCEPTION 'CRUCE_DISPONIBILIDAD: %', v_detalle_id;
        END IF;

        INSERT INTO asignaciones (
            rodeo_id, usuario_pagado_id, tipo_persona, nombre_importado,
            categoria_aplicada, valor_diario_aplicado, duracion_dias_aplicada,
            pago_base_calculado, estado, estado_designacion, publicado,
            propuesta_detalle_id, created_by
        ) VALUES (
            v_rodeo.id, v_usuario_pagado_id, 'jurado', v_jurado.nombre_completo,
            v_categoria_aplicada, v_valor_diario, v_duracion_dias,
            v_pago_base, 'activo', 'pendiente', false,
            v_detalle_id, p_actor_id
        )
        RETURNING * INTO v_asignacion;

        -- Decisión 2 — trazabilidad de la AUTORIZACIÓN DE APLICAR, para
        -- TODA fila, incluida una PENDIENTE nunca revisada individualmente.
        v_bitacora := registrar_movimiento_designacion(
            p_tipo_movimiento         := 'aplicacion_propuesta',
            p_rodeo_id                := v_rodeo.id,
            p_actor_id                := p_actor_id,
            p_propuesta_detalle_id    := v_detalle_id,
            p_asignacion_id           := v_asignacion.id,
            p_usuario_pagado_id_nuevo := v_usuario_pagado_id,
            p_nombre_nuevo_snapshot   := v_jurado.nombre_completo
        );

        v_aplicadas := v_aplicadas || jsonb_build_object(
            'detalle_id', v_detalle_id, 'asignacion_id', v_asignacion.id,
            'rodeo_id', v_rodeo.id, 'usuario_pagado_id', v_usuario_pagado_id,
            'bitacora_id', v_bitacora.id
        );
    END LOOP;

    RETURN jsonb_build_object('aplicadas', v_aplicadas);
END;
$$;

REVOKE ALL ON FUNCTION aplicar_propuesta_designacion_completa(
    UUID, UUID, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION aplicar_propuesta_designacion_completa(
    UUID, UUID, JSONB
) TO service_role;

COMMENT ON FUNCTION aplicar_propuesta_designacion_completa IS
    'Fase 2C (revisión correctiva): única vía que crea asignaciones reales desde una propuesta — TODO el lote pendiente en UNA transacción, todo o nada. Revalida cobertura/disponibilidad/habilitación/conflictos de cada fila, bajo el mismo advisory lock por jurado que 084. Registra en bitacora_designaciones (aplicacion_propuesta) quién autorizó cada fila aplicada, incluidas las nunca revisadas individualmente (PENDIENTE). Omite sin error las filas ya aplicadas por una corrida anterior.';

COMMIT;

-- Reversible:
--   DROP FUNCTION IF EXISTS aplicar_propuesta_designacion_completa(UUID, UUID, JSONB);
--   DROP FUNCTION IF EXISTS modificar_jurado_propuesta_borrador(UUID, UUID, TEXT, TEXT, UUID, UUID, TEXT, JSONB);
--   ALTER TABLE propuestas_designacion DROP COLUMN IF EXISTS aplicacion_en_curso_desde;
--   ALTER TABLE propuestas_designacion DROP COLUMN IF EXISTS motor_usado, DROP COLUMN IF EXISTS fecha_corte_tecnica, DROP COLUMN IF EXISTS resultado_cobertura_json, DROP COLUMN IF EXISTS advertencias_json;
--   (el rollback de las columnas fallaría si ya existen propuestas guardadas con motor_usado='global' u otros valores no-default — intencional: no se revierte perdiendo el estado real de datos ya escritos)
