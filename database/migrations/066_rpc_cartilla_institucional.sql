-- ═════════════════════════════════════════════════════════════════════════
-- 066_rpc_cartilla_institucional.sql
-- Fase 3: RPC transaccional para crear o adjuntar la cartilla institucional
-- "oficial" de un rodeo. Resuelve la unicidad y la concurrencia a nivel de
-- base de datos (requisito explícito: "no únicamente con consultas previas
-- desde JavaScript") apoyándose en el índice único parcial creado en
-- 065_cartillas_delegado_institucional.sql.
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — pendiente de autorización.
-- Depende de 065 (requiere delegado_id nullable + columnas nuevas + el
-- índice único parcial uq_cartillas_delegado_rodeo_institucional).
--
-- Comportamiento (una sola transacción, atómica por invocación):
--   1. Fase 3.1 — regla oficial: "cada rodeo tiene un solo delegado
--      responsable". Se verifica la DESIGNACIÓN EFECTIVA de un Delegado
--      Rentado en `asignaciones` (no la mera existencia de una cartilla),
--      reutilizando TEXTUALMENTE el mismo criterio que ya usa el propio
--      Delegado Rentado para su autochequeo en usuario/cartilla-delegado.js
--      (GET y POST /rodeo/:rodeo_id): estado='activo' AND publicado=true AND
--      estado_designacion <> 'rechazado' — sin inventar estados nuevos ni
--      reinterpretar su significado, y sin filtrar por usuario_pagado_id
--      (importa si ALGÚN Rentado tiene designación vigente, no cuál):
--      EXISTS(SELECT 1 FROM asignaciones WHERE rodeo_id = p_rodeo_id AND
--      tipo_persona = 'delegado_rentado' AND estado = 'activo' AND
--      publicado = true AND estado_designacion <> 'rechazado'). Si existe,
--      el rodeo pertenece HOY a la modalidad Rentado: se aborta con RAISE
--      EXCEPTION 'DELEGADO_RENTADO_DESIGNADO'. Una fila histórica con
--      estado='anulado', o aún no publicada, NUNCA cuenta como vigente —
--      igual que para el propio Rentado.
--   2. Si NO hay designación vigente pero YA existe una cartilla de
--      Delegado Rentado con contenido real para ese rodeo (delegado_id IS
--      NOT NULL en cartillas_delegado) — por ejemplo, la designación que la
--      originó fue anulada después — tampoco se crea una institucional en
--      paralelo: eso sería una segunda cartilla sin resolución. Se aborta
--      con 'CARTILLA_RENTADO_EXISTENTE'. Ambos casos (1) y (2) requieren
--      decisión administrativa; esta función nunca la toma por sí sola.
--   3. INSERT ... ON CONFLICT (rodeo_id) WHERE delegado_asociacion_id IS NOT
--      NULL DO UPDATE: si no existía cartilla institucional, la crea
--      (borrador, version=1). Si YA existía una institucional para ese
--      mismo rodeo (de cualquier delegado_asociacion), la ACTUALIZA en el
--      mismo registro (cambia el responsable declarado, version += 1) — así
--      "cambiar de delegado seleccionado" nunca crea un segundo borrador
--      (requisito explícito de la Fase 3, confirmado vigente en la 3.1).
--   4. Si la cartilla institucional existente ya está en un estado
--      bloqueado (enviada/reenviada/aprobada/cerrada), el UPDATE del ON
--      CONFLICT no se aplica (la cláusula WHERE del DO UPDATE lo filtra) y
--      la función aborta con 'CARTILLA_BLOQUEADA_PARA_CAMBIO_DE_DELEGADO'
--      — nunca reabre una cartilla cerrada/enviada por este camino.
--   5. Dos invocaciones CONCURRENTES para el mismo rodeo: Postgres serializa
--      el conflicto sobre el índice único parcial — una gana la inserción,
--      la otra ve el conflicto y aplica el UPDATE (o es bloqueada
--      brevemente por el lock de fila y luego ve la fila ya insertada) —
--      nunca se duplica, nunca se pierde una de las dos silenciosamente.
--      Probado en PGlite con llamadas realmente concurrentes (Promise.all).
--
-- NO modifica `delegado_id` en ninguna fila existente ni nueva. NO toca
-- cartillas de Delegado Rentado. NO modifica `asignaciones`. NO migra datos.
--
-- Idempotente: CREATE OR REPLACE FUNCTION.
-- Reversible: DROP FUNCTION IF EXISTS crear_o_adjuntar_cartilla_institucional(UUID, UUID, TEXT, UUID);
-- ═════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION crear_o_adjuntar_cartilla_institucional(
    p_rodeo_id UUID,
    p_delegado_asociacion_id UUID,
    p_delegado_nombre TEXT,
    p_cuenta_institucional_id UUID,
    -- Mismos 3 campos que el flujo de Delegado Rentado auto-completa UNA
    -- VEZ al crear (ver usuario/cartilla-delegado.js, POST /rodeo/:rodeo_id):
    -- se reciben ya resueltos por el caller (misma fuente: rodeo.temporadas.nombre
    -- con fallback al año de la fecha, rodeo.fecha, rodeo.tipo_rodeo_nombre) en
    -- vez de que esta función vuelva a consultar `rodeos` — mantiene la RPC
    -- enfocada solo en la atomicidad de creación/adjunto, no en reimplementar
    -- esa resolución.
    p_temporada TEXT,
    p_fecha_rodeo DATE,
    p_tipo_rodeo TEXT
) RETURNS cartillas_delegado AS $$
DECLARE
    v_rentado_designado BOOLEAN;
    v_rentado_cartilla_existe BOOLEAN;
    v_resultado cartillas_delegado;
BEGIN
    -- Paso 1 (Fase 3.1): designación EFECTIVA de Delegado Rentado vigente
    -- para este rodeo, independiente de si ya se inició o no una cartilla.
    -- Mismo criterio exacto que el autochequeo del propio Rentado (estado,
    -- publicado y estado_designacion <> 'rechazado'; NULL no matchea <>,
    -- igual que en ese autochequeo). Una fila anulada, no publicada o
    -- 'pendiente_revision' nunca cuenta como vigente.
    SELECT EXISTS(
        SELECT 1 FROM asignaciones
        WHERE rodeo_id = p_rodeo_id
          AND tipo_persona = 'delegado_rentado'
          AND estado = 'activo'
          AND publicado = true
          AND estado_designacion <> 'rechazado'
    ) INTO v_rentado_designado;

    IF v_rentado_designado THEN
        RAISE EXCEPTION 'DELEGADO_RENTADO_DESIGNADO';
    END IF;

    -- Paso 2: aun sin designación vigente, si ya existe contenido real de
    -- una cartilla de Delegado Rentado para este rodeo (p.ej. la
    -- designación que la originó fue anulada después), no se crea una
    -- institucional en paralelo sin resolución administrativa.
    SELECT EXISTS(
        SELECT 1 FROM cartillas_delegado
        WHERE rodeo_id = p_rodeo_id AND delegado_id IS NOT NULL
    ) INTO v_rentado_cartilla_existe;

    IF v_rentado_cartilla_existe THEN
        RAISE EXCEPTION 'CARTILLA_RENTADO_EXISTENTE';
    END IF;

    INSERT INTO cartillas_delegado (
        rodeo_id, delegado_asociacion_id, delegado_nombre,
        creado_por_cuenta_institucional_id, actualizado_por_cuenta_institucional_id,
        temporada, fecha_rodeo, tipo_rodeo,
        estado, version
    ) VALUES (
        p_rodeo_id, p_delegado_asociacion_id, p_delegado_nombre,
        p_cuenta_institucional_id, p_cuenta_institucional_id,
        p_temporada, p_fecha_rodeo, p_tipo_rodeo,
        'borrador', 1
    )
    ON CONFLICT (rodeo_id) WHERE delegado_asociacion_id IS NOT NULL
    DO UPDATE SET
        delegado_asociacion_id = EXCLUDED.delegado_asociacion_id,
        delegado_nombre = EXCLUDED.delegado_nombre,
        actualizado_por_cuenta_institucional_id = EXCLUDED.actualizado_por_cuenta_institucional_id,
        version = cartillas_delegado.version + 1,
        updated_at = now()
        -- temporada/fecha_rodeo/tipo_rodeo NO se vuelven a sobrescribir en el
        -- UPDATE: son del rodeo, no cambian al cambiar de delegado responsable,
        -- y así nunca se pisa un valor ya guardado por una carrera de timing.
    WHERE cartillas_delegado.estado NOT IN ('enviada', 'reenviada', 'aprobada', 'cerrada')
    RETURNING * INTO v_resultado;

    IF v_resultado IS NULL THEN
        RAISE EXCEPTION 'CARTILLA_BLOQUEADA_PARA_CAMBIO_DE_DELEGADO';
    END IF;

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION crear_o_adjuntar_cartilla_institucional IS
    'Fase 3.1: crea o adjunta (cambia el responsable de) la cartilla institucional oficial de un rodeo, de forma atómica, solo si no hay designación vigente de Delegado Rentado ni una cartilla Rentado ya existente para ese rodeo. Nunca crea una segunda fila para el mismo rodeo; nunca toca cartillas ni asignaciones de Delegado Rentado.';
