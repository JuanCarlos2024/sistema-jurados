-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 041 — Protección transaccional de creación de intentos
--
-- PROBLEMA:
--   GET /:id/iniciar realiza read-check-write sin transacción atómica.
--   Dos solicitudes concurrentes (dos pestañas, timeout + reintento, etc.)
--   pueden pasar el check de validos.length < intentos_maximos y crear
--   dos filas en capacitacion_intentos con estado='en_curso' para la misma
--   asignacion.
--
-- SOLUCIÓN — dos capas complementarias:
--
--   A. rpc_iniciar_intento:
--      Usa SELECT ... FOR UPDATE sobre capacitacion_asignaciones para
--      serializar solicitudes concurrentes con el mismo asignacion_id.
--      Solo una transacción puede avanzar a la vez; la segunda, al adquirir
--      el lock, ya ve el intento creado por la primera y lo devuelve.
--
--   B. Índice único parcial:
--      CREATE UNIQUE INDEX ON capacitacion_intentos(asignacion_id)
--      WHERE estado = 'en_curso'
--      Garantía de último recurso: incluso si el RPC fallara o se llamara
--      directamente al INSERT, la BD rechaza la segunda fila con un error
--      de constraint que el backend puede capturar y convertir en EN_CURSO.
--
-- ESTADOS QUE CUENTAN PARA intentos_maximos (validos):
--   • en_curso   — cuenta (intento activo, aún no finalizado)
--   • completado — cuenta (incluye finalizado_por_tiempo=true)
--   NO CUENTA:
--   • abandonado — no cuenta (descartado administrativamente o por salida)
--
-- IDEMPOTENTE: seguro ejecutar varias veces (CREATE OR REPLACE / IF NOT EXISTS).
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- A. rpc_iniciar_intento
--    Protección transaccional para crear o reanudar un intento de capacitación.
--
--    Parámetros:
--      p_asignacion_id          — UUID de la asignacion del usuario
--      p_vence_en               — timestamp de vencimiento (NULL si sin límite)
--      p_tiempo_limite_aplicado — minutos (NULL si sin límite)
--
--    Códigos de respuesta:
--      CREADO       — nuevo intento creado
--      EN_CURSO     — intento activo ya existía; devuelve su id y vence_en
--      MAX_ALCANZADO — se alcanzó intentos_maximos; devuelve maximo
--      NOT_FOUND    — asignacion_id no existe
--
--    Garantía de concurrencia:
--      SELECT ... FOR UPDATE en capacitacion_asignaciones serializa todas las
--      solicitudes para la misma (asignacion_id).  La segunda solicitud que
--      adquiere el lock encuentra el EN_CURSO creado por la primera.
--      Dos solicitudes concurrentes NUNCA producen dos filas en_curso.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION rpc_iniciar_intento(
    p_asignacion_id          UUID,
    p_vence_en               TIMESTAMPTZ DEFAULT NULL,
    p_tiempo_limite_aplicado INTEGER     DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_prueba_id    UUID;
    v_intentos_max INTEGER;
    v_en_curso     RECORD;
    v_validos      BIGINT;
    v_total        BIGINT;
    v_numero       INTEGER;
    v_nuevo_id     UUID;
BEGIN
    -- 1. Bloquear fila de asignación — serializa solicitudes concurrentes
    --    para la misma combinación usuario+capacitación.
    SELECT ca.prueba_id INTO v_prueba_id
    FROM   capacitacion_asignaciones ca
    WHERE  ca.id = p_asignacion_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('codigo', 'NOT_FOUND');
    END IF;

    -- 2. Leer intentos_maximos de la prueba (fuente de verdad en BD)
    SELECT cp.intentos_maximos INTO v_intentos_max
    FROM   capacitacion_pruebas cp
    WHERE  cp.id = v_prueba_id;

    -- 3. Buscar intento en_curso existente (dentro del lock — coherente)
    SELECT id, numero_intento, vence_en INTO v_en_curso
    FROM   capacitacion_intentos
    WHERE  asignacion_id = p_asignacion_id
      AND  estado        = 'en_curso'
    ORDER  BY iniciado_en DESC
    LIMIT  1;

    IF FOUND THEN
        -- Intento activo ya existía: devolverlo sin crear otro
        RETURN jsonb_build_object(
            'codigo',         'EN_CURSO',
            'intento_id',     v_en_curso.id,
            'numero_intento', v_en_curso.numero_intento,
            'es_nuevo',       FALSE,
            'vence_en',       v_en_curso.vence_en
        );
    END IF;

    -- 4. Contar intentos válidos (en_curso + completados; abandonados NO cuentan)
    SELECT COUNT(*) INTO v_validos
    FROM   capacitacion_intentos
    WHERE  asignacion_id = p_asignacion_id
      AND  estado        != 'abandonado';

    -- 5. Verificar límite de intentos
    IF v_intentos_max IS NOT NULL AND v_validos >= v_intentos_max THEN
        RETURN jsonb_build_object(
            'codigo', 'MAX_ALCANZADO',
            'maximo', v_intentos_max
        );
    END IF;

    -- 6. numero_intento: total de filas (incluyendo abandonados) + 1
    SELECT COUNT(*) INTO v_total
    FROM   capacitacion_intentos
    WHERE  asignacion_id = p_asignacion_id;

    v_numero := CAST(v_total AS INTEGER) + 1;

    -- 7. Crear nuevo intento
    INSERT INTO capacitacion_intentos (
        asignacion_id,
        numero_intento,
        estado,
        vence_en,
        tiempo_limite_aplicado
    )
    VALUES (
        p_asignacion_id,
        v_numero,
        'en_curso',
        p_vence_en,
        p_tiempo_limite_aplicado
    )
    RETURNING id INTO v_nuevo_id;

    RETURN jsonb_build_object(
        'codigo',         'CREADO',
        'intento_id',     v_nuevo_id,
        'numero_intento', v_numero,
        'es_nuevo',       TRUE,
        'vence_en',       p_vence_en
    );
END;
$$;

-- Permisos: solo service_role (backend) puede invocar esta función
REVOKE ALL ON FUNCTION rpc_iniciar_intento(UUID, TIMESTAMPTZ, INTEGER) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION rpc_iniciar_intento(UUID, TIMESTAMPTZ, INTEGER) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- B. Índice único parcial — segunda capa de protección
--
--    Garantiza a nivel de BD que nunca pueden existir dos filas
--    con estado='en_curso' para la misma asignacion_id.
--
--    Si el INSERT fallara (raro pero posible en caso de error en el RPC),
--    el backend recibirá un error de constraint único y podrá recuperar
--    el intento existente devolviendo EN_CURSO.
--
--    Seguro crear: la auditoría previa confirmó 0 duplicados en_curso
--    en capacitacion_intentos (resultado vacío en la query de auditoría).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS uq_intentos_en_curso_por_asignacion
    ON capacitacion_intentos (asignacion_id)
    WHERE estado = 'en_curso';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verificación
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_fn   BOOLEAN;
    v_idx  BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'rpc_iniciar_intento'
    ) INTO v_fn;

    SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'capacitacion_intentos'
          AND indexname  = 'uq_intentos_en_curso_por_asignacion'
    ) INTO v_idx;

    RAISE NOTICE 'rpc_iniciar_intento creada: % | índice único parcial creado: %', v_fn, v_idx;
END $$;
