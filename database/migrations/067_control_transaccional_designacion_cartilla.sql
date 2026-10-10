-- ═════════════════════════════════════════════════════════════════════════
-- 067_control_transaccional_designacion_cartilla.sql
-- Fase 3.1 (cierre) — sección 3: control transaccional compartido entre la
-- designación/reasignación de Delegado Rentado y la creación de la cartilla
-- institucional, para el MISMO rodeo. Hasta ahora cada lado verificaba al
-- otro con una consulta previa desde JavaScript/plpgsql — correcto para
-- secuencias no simultáneas, pero insuficiente si dos operaciones ocurren
-- en una ventana de tiempo solapada (ninguna ve todavía el commit de la otra).
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — pendiente de autorización.
-- Depende de 065/066 (cartillas_delegado.delegado_asociacion_id,
-- crear_o_adjuntar_cartilla_institucional).
--
-- DISEÑO (dos piezas que trabajan juntas; ninguna por sí sola es suficiente):
--
--   1. BLOQUEO DE FILA COMPARTIDO sobre `rodeos` (SELECT ... FOR UPDATE), como
--      punto de serialización ÚNICO para ambos caminos de escritura sobre un
--      mismo rodeo_id. Cualquier transacción que vaya a decidir "¿puedo
--      designar/confirmar un Delegado Rentado?" o "¿puedo crear/adjuntar una
--      cartilla institucional?" para un rodeo primero toma este lock. Si dos
--      transacciones concurrentes apuntan al MISMO rodeo, Postgres obliga a
--      la segunda a esperar a que la primera termine (commit o rollback)
--      antes de continuar — así la segunda SIEMPRE ve el resultado ya
--      confirmado de la primera al hacer su propia verificación, cerrando la
--      ventana de "ambas consultan antes de que la otra confirme".
--      Aplicado en: crear_o_adjuntar_cartilla_institucional (ver más abajo,
--      CREATE OR REPLACE) y en el trigger de asignaciones (punto 2).
--
--   2. TRIGGER a nivel de base de datos sobre `asignaciones` (no un endpoint
--      JS): se dispara en CUALQUIER INSERT/UPDATE que haga que una fila de
--      tipo_persona='delegado_rentado' quede con una designación EFECTIVA
--      (estado='activo' AND publicado=true AND estado_designacion <>
--      'rechazado' — mismo criterio textual reutilizado en toda la Fase 3.1).
--      Si en ese momento ya existe una cartilla institucional con contenido
--      real (delegado_asociacion_id IS NOT NULL) para el mismo rodeo, aborta
--      la operación con RAISE EXCEPTION. Como es un trigger de BASE DE DATOS,
--      protege automáticamente TODOS los caminos de escritura actuales y
--      futuros sobre `asignaciones` (creación, reasignación de persona,
--      aceptar/rechazar/reabrir designación, publicación masiva) SIN requerir
--      cambios en el código JS de esos endpoints — exactamente lo pedido:
--      "no simular seguridad transaccional mediante consultas independientes
--      desde JavaScript".
--
-- PRUEBAS (actualizado en Fase 3.2): la suite de este repositorio usa PGlite
-- (services/__fixtures__/pgliteCliente.js), que es una ÚNICA sesión atendida
-- por una cola secuencial — nunca dos transacciones verdaderamente abiertas y
-- simultáneas. Esa suite prueba la LÓGICA del trigger (qué bloquea, qué
-- permite, con qué mensaje), no el bloqueo de fila en sí. El bloqueo de fila
-- (`SELECT...FOR UPDATE`) SÍ fue validado en la Fase 3.2 con dos conexiones
-- TCP genuinamente concurrentes contra un PostgreSQL real (binario nativo,
-- NO Supabase, base de datos efímera fuera de este repositorio) — incluyendo
-- una prueba que retiene el lock 1.5s a propósito (pg_sleep) y confirma que
-- la segunda conexión solo lo obtiene en el mismo instante en que la primera
-- hace COMMIT. Ese script NO forma parte de la suite automatizada del
-- repositorio (requiere un PostgreSQL real, no PGlite) — ver el informe de
-- la Fase 3.2 para la evidencia completa.
--
-- CRITERIO EXACTO de "cartilla institucional con contenido real" (Fase 3.2,
-- aclaración de terminología): el chequeo es `delegado_asociacion_id IS NOT
-- NULL` — es decir, EXISTENCIA DE LA FILA, no si sus campos de la encuesta
-- ya se completaron. Un borrador recién creado (0 campos llenados) YA cuenta
-- como "cartilla existente" para este bloqueo. Es intencional: el momento en
-- que la asociación crea el borrador es el momento en que reclama la
-- responsabilidad del rodeo — bloquear desde ahí (no solo cuando ya tiene
-- contenido) es lo que impide la doble responsabilidad pedida en la regla
-- oficial. La frase "contenido real" en comentarios de este archivo se
-- refiere a "existe una fila real" (no NULL), nunca a "tiene respuestas
-- completas" — se aclara explícitamente para evitar ambigüedad futura.
--
-- NO modifica `delegado_id`, pagos, bonos, evaluaciones ni cartillas
-- históricas. NO autoriza ni rechaza jurados (tipo_persona='jurado' nunca
-- entra en el alcance del trigger). NO transfiere autoría entre modalidades.
--
-- Idempotente: CREATE OR REPLACE FUNCTION / DROP TRIGGER IF EXISTS + CREATE.
-- Reversible: DROP TRIGGER trg_asignaciones_designacion_vs_cartilla_institucional ON asignaciones;
--             DROP FUNCTION IF EXISTS fn_bloquear_designacion_rentado_si_cartilla_institucional();
--             (crear_o_adjuntar_cartilla_institucional vuelve a su versión anterior re-aplicando 066).
-- ═════════════════════════════════════════════════════════════════════════

-- ─── Pieza 1: el trigger sobre `asignaciones` ──────────────────────────────
CREATE OR REPLACE FUNCTION fn_bloquear_designacion_rentado_si_cartilla_institucional()
RETURNS TRIGGER AS $$
DECLARE
    v_cartilla_institucional_existe BOOLEAN;
BEGIN
    -- Solo nos interesan filas de Delegado Rentado que, tras este INSERT/
    -- UPDATE, queden con una designación EFECTIVA (mismo criterio textual
    -- que usuario/cartilla-delegado.js e institucional/cartilla.js). Si no
    -- es el caso (p.ej. tipo_persona='jurado', o publicado=false, o
    -- estado_designacion='rechazado'), no hay nada que verificar.
    IF NEW.tipo_persona <> 'delegado_rentado'
       OR NEW.estado <> 'activo'
       OR NEW.publicado IS NOT TRUE
       OR NEW.estado_designacion = 'rechazado' THEN
        RETURN NEW;
    END IF;

    -- Punto de serialización: cualquier otra transacción que esté creando o
    -- adjuntando una cartilla institucional para el MISMO rodeo (ver
    -- crear_o_adjuntar_cartilla_institucional) también toma este mismo lock
    -- antes de decidir — así una de las dos transacciones concurrentes
    -- siempre espera a que la otra confirme, y vuelve a ver el estado real.
    PERFORM 1 FROM rodeos WHERE id = NEW.rodeo_id FOR UPDATE;

    SELECT EXISTS(
        SELECT 1 FROM cartillas_delegado
        WHERE rodeo_id = NEW.rodeo_id AND delegado_asociacion_id IS NOT NULL
    ) INTO v_cartilla_institucional_existe;

    IF v_cartilla_institucional_existe THEN
        RAISE EXCEPTION 'DESIGNACION_RENTADO_BLOQUEADA_POR_CARTILLA_INSTITUCIONAL';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION fn_bloquear_designacion_rentado_si_cartilla_institucional IS
    'Fase 3.1 (cierre): impide que una designación de Delegado Rentado quede efectiva (activa+publicada+no rechazada) para un rodeo que ya tiene una cartilla institucional con contenido real — requiere resolución administrativa, nunca transferencia automática.';

DROP TRIGGER IF EXISTS trg_asignaciones_designacion_vs_cartilla_institucional ON asignaciones;
CREATE TRIGGER trg_asignaciones_designacion_vs_cartilla_institucional
    BEFORE INSERT OR UPDATE ON asignaciones
    FOR EACH ROW
    EXECUTE FUNCTION fn_bloquear_designacion_rentado_si_cartilla_institucional();

-- ─── Pieza 2: el mismo lock, del lado de la RPC institucional ──────────────
-- Re-declara la función de 066 agregando el SELECT...FOR UPDATE como PRIMERA
-- acción, antes de cualquier verificación — mismo punto de serialización
-- que usa el trigger de arriba. El resto del comportamiento es IDÉNTICO al
-- de 066 (no se repite esa documentación acá).
CREATE OR REPLACE FUNCTION crear_o_adjuntar_cartilla_institucional(
    p_rodeo_id UUID,
    p_delegado_asociacion_id UUID,
    p_delegado_nombre TEXT,
    p_cuenta_institucional_id UUID,
    p_temporada TEXT,
    p_fecha_rodeo DATE,
    p_tipo_rodeo TEXT
) RETURNS cartillas_delegado AS $$
DECLARE
    v_rentado_designado BOOLEAN;
    v_rentado_cartilla_existe BOOLEAN;
    v_resultado cartillas_delegado;
BEGIN
    -- Fase 3.1 (cierre): mismo bloqueo de fila que toma el trigger de
    -- asignaciones — serializa esta operación contra cualquier designación/
    -- reasignación/publicación de Delegado Rentado concurrente sobre el
    -- MISMO rodeo, para que ninguna de las dos decida con datos obsoletos.
    PERFORM 1 FROM rodeos WHERE id = p_rodeo_id FOR UPDATE;

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
    WHERE cartillas_delegado.estado NOT IN ('enviada', 'reenviada', 'aprobada', 'cerrada')
    RETURNING * INTO v_resultado;

    IF v_resultado IS NULL THEN
        RAISE EXCEPTION 'CARTILLA_BLOQUEADA_PARA_CAMBIO_DE_DELEGADO';
    END IF;

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION crear_o_adjuntar_cartilla_institucional IS
    'Fase 3.1 (cierre): crea o adjunta la cartilla institucional oficial de un rodeo, de forma atómica y serializada (SELECT...FOR UPDATE sobre rodeos) contra cualquier designación concurrente de Delegado Rentado. Nunca crea una segunda fila para el mismo rodeo; nunca toca cartillas ni asignaciones de Delegado Rentado.';
