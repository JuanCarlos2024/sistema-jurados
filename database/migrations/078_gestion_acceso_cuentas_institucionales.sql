-- ═════════════════════════════════════════════════════════════════════════
-- 078_gestion_acceso_cuentas_institucionales.sql
-- Nuevo módulo administrativo: crear asociaciones/cuentas institucionales,
-- suspender/reactivar el acceso, y restablecer contraseñas con invalidación
-- real de sesiones — sin depender de modificar nada manualmente en Supabase.
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — pendiente de autorización.
-- Depende de 057 (asociaciones/asociacion_alias), 061 (cuentas_institucionales),
-- 069 (auditoria.actor_tipo incluye 'cuenta_institucional'), 071 (hardening).
--
-- ═════════════════════════════════════════════════════════════════════════
-- DATOS REALES CONFIRMADOS (solo lectura, antes de diseñar esta migración):
-- 56 asociaciones en catálogo (55 ordinarias activas + 1 especial), 55
-- cuentas institucionales (todas activas, 0 suspendidas), ninguna asociación
-- ordinaria con más de una cuenta. Esta migración NUNCA toca esos datos —
-- solo agrega columnas/funciones nuevas.
--
-- 1) INVALIDACIÓN REAL DE SESIONES — hoy ningún tipo de usuario del sistema
--    tiene un mecanismo de versión de sesión; cambiar `password_hash` nunca
--    invalida un JWT ya emitido (sigue funcionando hasta que expire por
--    tiempo, hasta 8h). Se agrega `password_version INTEGER NOT NULL
--    DEFAULT 1` — el JWT institucional ahora la incluye como claim, y el
--    middleware `soloCuentaInstitucional` (backend, sin cambios en esta
--    migración SQL) la revalida contra la BD en cada request, igual que ya
--    hace con `activo`. Un JWT sin el claim (emitido antes de esta
--    migración) se trata como versión 1 por el middleware — igual al
--    DEFAULT — para no cortar sesiones legítimas ya activas al desplegar.
--
--    IMPORTANTE (revisión posterior): a pesar del nombre de la columna,
--    `password_version` NO es exclusivamente "versión de la contraseña" —
--    es, de forma más general, la VERSIÓN DE CREDENCIAL/SESIÓN vigente de
--    la cuenta, y se incrementa ante CUALQUIER evento que deba invalidar
--    permanentemente las sesiones anteriores:
--      a) un restablecimiento administrativo de contraseña, o un cambio
--         propio de contraseña (el motivo original de esta columna).
--      b) una SUSPENSIÓN administrativa (riesgo real corregido — ver más
--         abajo: "RIESGO 1 — SESIÓN SOBREVIVE A UNA REACTIVACIÓN").
--    Reutiliza el mismo mecanismo ya construido (no se crea una
--    infraestructura paralela de tokens/sesiones) — solo se ampliÓ CUÁNDO
--    se incrementa, no CÓMO se revalida.
--
-- RIESGO 1 (revisión posterior) — UNA SESIÓN PUEDE SOBREVIVIR A UNA
-- REACTIVACIÓN: la versión original de suspender_cuenta_institucional_con_
-- auditoria() solo cambiaba `activo` a false, sin tocar `password_version`.
-- Mientras la cuenta estaba suspendida, un JWT emitido ANTES ya era
-- rechazado (el middleware revalida `activo` en cada request) — pero al
-- reactivar (`activo` vuelve a true), ESE MISMO JWT viejo, si todavía no
-- había expirado por tiempo (hasta 8h), volvía a ser válido de nuevo: la
-- reactivación "revivía" sin querer cualquier sesión previa a la
-- suspensión, incluida una potencialmente comprometida (motivo real por el
-- que un administrador suspende una cuenta). Corregido: suspender_cuenta_
-- institucional_con_auditoria() ahora TAMBIÉN incrementa `password_version`
-- — la invalidación de esas sesiones queda PERMANENTE (el valor nunca
-- vuelve a coincidir con el de un JWT emitido antes de la suspensión,
-- incluso después de reactivar) — sin tocar `password_hash` ni forzar
-- `primer_login=true` solo por suspender/reactivar (la cuenta sigue
-- utilizable con su misma contraseña vigente). reactivar_cuenta_
-- institucional_con_auditoria() no necesita un incremento propio: el que ya
-- aplicó suspender es permanente y acumulativo.
--
-- RIESGO 2 (revisión posterior) — crear_cuenta_institucional_con_auditoria
-- SOLO VALIDABA QUE LA ASOCIACIÓN EXISTIERA, nunca que estuviera activa ni
-- que no fuera una asociación especial (caso real de referencia: FEDERACIÓN
-- DEL RODEO CHILENO, es_especial=true en el catálogo) — un administrador
-- podría, por error o a través de una llamada directa al backend (sin pasar
-- por el selector del frontend, que SÍ ya filtra por activa=true AND
-- es_especial=false al construir sus opciones), terminar creando una cuenta
-- institucional ordinaria para una entidad que no corresponde. Corregido:
-- dentro de la MISMA transacción, bajo el mismo lock FOR UPDATE que ya
-- existía (ahora se usa para leer `activa`/`es_especial`, no solo para
-- comprobar existencia), se rechaza con ASOCIACION_INACTIVA o ASOCIACION_
-- ESPECIAL_SIN_CUENTA según corresponda — nunca se modifica el registro real
-- de ninguna asociación (tampoco el de la Federación). El backend (route)
-- también traduce estos dos códigos nuevos a una respuesta HTTP clara —
-- nunca se depende únicamente del filtro del frontend.
--
-- REVISIÓN COMPLEMENTARIA (sin ampliar alcance): se detectó además que
-- POST /institucional/auth/cambiar-password (fuera de esta migración SQL,
-- en institucional/auth.js) no comprobaba el `error` devuelto por el UPDATE
-- de password_hash antes de responder éxito — un fallo real de base de
-- datos habría quedado reportado como "Contraseña actualizada
-- correctamente" sin haber cambiado nada. Corregido en el backend (no
-- requiere cambios en esta migración SQL).
--
-- 2) UNICIDAD REAL CUENTA↔ASOCIACIÓN — el esquema de la migración 061 nunca
--    impuso "una cuenta por asociación" a nivel de base de datos (solo por
--    convención de aplicación); hoy los datos reales ya cumplen 1:1 en las
--    55 cuentas existentes, así que agregar la restricción no rompe nada.
--    Se agrega `UNIQUE (asociacion_id)` — además de servir como protección
--    real contra duplicados, es el backstop de concurrencia: dos solicitudes
--    simultáneas de "crear cuenta para la misma asociación" nunca pueden
--    terminar ambas con éxito, sin importar el orden de ejecución.
--
-- 3) CUATRO RPC NUEVAS, mismo patrón que la migración 073 (escritura +
--    auditoría atómicas, lock FOR UPDATE donde corresponde para cerrar
--    condiciones de carrera reales, nunca devuelven password_hash — tipo de
--    retorno compuesto propio, sin esa columna, así que es estructuralmente
--    imposible filtrarlo desde estas funciones) y endurecidas desde el
--    primer momento con el criterio de la migración 071 (REVOKE de PUBLIC/
--    anon/authenticated, GRANT solo a service_role, search_path fijo):
--      - crear_cuenta_institucional_con_auditoria: Opción A del pedido
--        (asociación YA existe en el catálogo, sin cuenta todavía).
--      - crear_asociacion_institucional_con_auditoria: Opción B (asociación
--        realmente nueva) — crea la fila en `asociaciones` Y su cuenta en la
--        MISMA transacción (si la cuenta fallara por cualquier motivo, la
--        asociación tampoco queda creada: nunca una asociación "huérfana"
--        sin cuenta por una falla a mitad de camino).
--      - suspender_cuenta_institucional_con_auditoria / reactivar_...: tocan
--        EXCLUSIVAMENTE `cuentas_institucionales.activo` — nunca
--        `asociaciones.activa` (son conceptos distintos, en tablas
--        distintas; la asociación del catálogo deportivo permanece intacta
--        sin importar el estado de acceso institucional).
--      - resetear_password_cuenta_institucional_con_auditoria: recibe el
--        hash YA calculado por el backend (bcryptjs, costo 12 — igual que
--        el resto del sistema; esta función nunca hashea ni genera nada),
--        fuerza `primer_login = true` e incrementa `password_version`.
--
-- 4) DUPLICADOS: la dedup de asociaciones por NOMBRE (incluyendo alias
--    equivalentes) se resuelve en el backend ANTES de llamar a la RPC,
--    reutilizando `resolverAsociacion()`/`construirIndiceCatalogo()`
--    (services/informeGestion/asociaciones.js) — la ÚNICA forma ya
--    establecida en el proyecto de comparar un nombre contra el catálogo+
--    alias (match exacto normalizado, nunca ILIKE/difuso). La UNIQUE real
--    en `asociaciones.nombre_normalizado` (migración 057) sigue siendo el
--    backstop a nivel de base de datos contra una carrera entre dos altas
--    simultáneas con el mismo nombre exacto (un alias equivalente pero con
--    nombre_normalizado distinto no lo detectaría la UNIQUE por sí sola —
--    por eso el chequeo de alias en el backend es necesario, no redundante).
--    La dedup de correo y de cuenta-por-asociación es 100% a nivel de base
--    de datos (constraints reales, puntos 2 arriba y esquema 061).
--
-- No se crean delegados, rodeos, cartillas ni asignaciones automáticamente
-- al crear una asociación nueva — ninguna de estas RPC toca esas tablas.
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE cuentas_institucionales
    ADD COLUMN IF NOT EXISTS password_version INTEGER NOT NULL DEFAULT 1;

COMMENT ON COLUMN cuentas_institucionales.password_version IS
    'Gestión de acceso (078): a pesar del nombre, es la versión de CREDENCIAL/SESIÓN vigente de la cuenta — se incrementa en cada cambio de contraseña (propio o administrativo) Y en cada suspensión administrativa (revisión posterior: evita que una sesión emitida antes de suspender vuelva a ser válida después de reactivar). El JWT institucional la lleva como claim; soloCuentaInstitucional la revalida en cada request — un valor distinto al real invalida esa sesión de inmediato, sin esperar su expiración.';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'cuentas_institucionales'::regclass AND conname = 'uq_cuentas_institucionales_asociacion_id'
    ) THEN
        ALTER TABLE cuentas_institucionales
            ADD CONSTRAINT uq_cuentas_institucionales_asociacion_id UNIQUE (asociacion_id);
    END IF;
END $$;

COMMENT ON CONSTRAINT uq_cuentas_institucionales_asociacion_id ON cuentas_institucionales IS
    'Gestión de acceso (078): una sola cuenta institucional por asociación — nunca solo por convención de aplicación. Backstop real de concurrencia para la creación de cuentas.';

-- Tipo de retorno propio para las 5 RPC de este módulo: NUNCA incluye
-- password_hash — estructuralmente imposible que estas funciones lo filtren.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cuenta_institucional_publica') THEN
        CREATE TYPE cuenta_institucional_publica AS (
            id UUID, email TEXT, asociacion_id UUID, rol_institucional TEXT,
            activo BOOLEAN, primer_login BOOLEAN, password_version INTEGER,
            created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, ultimo_acceso_en TIMESTAMPTZ
        );
    END IF;
END $$;

-- ─── Opción A: cuenta para una asociación YA existente en el catálogo ─────
CREATE OR REPLACE FUNCTION crear_cuenta_institucional_con_auditoria(
    p_asociacion_id UUID,
    p_email TEXT,
    p_password_hash TEXT,
    p_administrador_id UUID
) RETURNS cuenta_institucional_publica AS $$
DECLARE
    v_activa BOOLEAN;
    v_es_especial BOOLEAN;
    v_resultado cuenta_institucional_publica;
    v_constraint TEXT;
BEGIN
    -- Lock sobre la fila de la asociación: serializa dos altas simultáneas
    -- de cuenta para la MISMA asociación (la segunda espera, y al continuar
    -- ve el UNIQUE de abajo o, si prefiere chequeo explícito, lo detecta acá).
    -- Riesgo 2 (revisión posterior): el MISMO lock ahora también sirve para
    -- leer activa/es_especial de forma consistente — nunca solo existencia.
    SELECT activa, es_especial INTO v_activa, v_es_especial
        FROM asociaciones WHERE id = p_asociacion_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ASOCIACION_NO_ENCONTRADA';
    END IF;
    IF NOT v_activa THEN
        RAISE EXCEPTION 'ASOCIACION_INACTIVA';
    END IF;
    IF v_es_especial THEN
        RAISE EXCEPTION 'ASOCIACION_ESPECIAL_SIN_CUENTA';
    END IF;

    IF EXISTS(SELECT 1 FROM cuentas_institucionales WHERE asociacion_id = p_asociacion_id) THEN
        RAISE EXCEPTION 'CUENTA_YA_EXISTE_PARA_ASOCIACION';
    END IF;

    BEGIN
        INSERT INTO cuentas_institucionales (
            email, password_hash, asociacion_id, rol_institucional,
            activo, primer_login, password_version, created_by
        ) VALUES (
            p_email, p_password_hash, p_asociacion_id, 'delegado_asociacion',
            true, true, 1, p_administrador_id
        )
        RETURNING id, email, asociacion_id, rol_institucional, activo, primer_login,
                  password_version, created_at, updated_at, ultimo_acceso_en
        INTO v_resultado;
    EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_constraint = 'cuentas_institucionales_email_key' THEN
            RAISE EXCEPTION 'CORREO_YA_REGISTRADO';
        ELSIF v_constraint = 'uq_cuentas_institucionales_asociacion_id' THEN
            RAISE EXCEPTION 'CUENTA_YA_EXISTE_PARA_ASOCIACION';
        END IF;
        RAISE;
    END;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES ('cuentas_institucionales', v_resultado.id::text, 'crear',
        jsonb_build_object('email', v_resultado.email, 'asociacion_id', p_asociacion_id),
        p_administrador_id::text, 'administrador',
        format('Alta de cuenta institucional para asociación existente: %s', v_resultado.email));

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION crear_cuenta_institucional_con_auditoria IS
    'Gestión de acceso (078), Opción A: alta de cuenta institucional para una asociación YA existente en el catálogo, sin cuenta previa, activa y no especial (ASOCIACION_INACTIVA / ASOCIACION_ESPECIAL_SIN_CUENTA — riesgo real corregido, caso de referencia: Federación del Rodeo Chileno). Nunca devuelve password_hash (tipo de retorno propio). Auditoría atómica en la misma transacción.';

-- ─── Opción B: asociación realmente NUEVA + su cuenta, atómico ───────────
CREATE OR REPLACE FUNCTION crear_asociacion_institucional_con_auditoria(
    p_nombre TEXT,
    p_nombre_normalizado TEXT,
    p_zona TEXT,
    p_email TEXT,
    p_password_hash TEXT,
    p_administrador_id UUID
) RETURNS cuenta_institucional_publica AS $$
DECLARE
    v_asociacion_id UUID;
    v_resultado cuenta_institucional_publica;
    v_constraint TEXT;
BEGIN
    BEGIN
        INSERT INTO asociaciones (nombre, nombre_normalizado, zona, activa, es_especial)
        VALUES (p_nombre, p_nombre_normalizado, p_zona, true, false)
        RETURNING id INTO v_asociacion_id;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'ASOCIACION_YA_EXISTE';
    END;

    BEGIN
        INSERT INTO cuentas_institucionales (
            email, password_hash, asociacion_id, rol_institucional,
            activo, primer_login, password_version, created_by
        ) VALUES (
            p_email, p_password_hash, v_asociacion_id, 'delegado_asociacion',
            true, true, 1, p_administrador_id
        )
        RETURNING id, email, asociacion_id, rol_institucional, activo, primer_login,
                  password_version, created_at, updated_at, ultimo_acceso_en
        INTO v_resultado;
    EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_constraint = 'cuentas_institucionales_email_key' THEN
            RAISE EXCEPTION 'CORREO_YA_REGISTRADO';
        END IF;
        RAISE;
    END;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES ('asociaciones', v_asociacion_id::text, 'crear',
        jsonb_build_object('nombre', p_nombre, 'zona', p_zona),
        p_administrador_id::text, 'administrador',
        format('Alta de asociación nueva: %s', p_nombre));

    INSERT INTO auditoria (tabla, registro_id, accion, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES ('cuentas_institucionales', v_resultado.id::text, 'crear',
        jsonb_build_object('email', v_resultado.email, 'asociacion_id', v_asociacion_id),
        p_administrador_id::text, 'administrador',
        format('Alta de cuenta institucional para asociación nueva: %s', v_resultado.email));

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION crear_asociacion_institucional_con_auditoria IS
    'Gestión de acceso (078), Opción B: crea una asociación realmente nueva en el catálogo oficial Y su cuenta institucional en UNA sola transacción — si la cuenta fallara, la asociación tampoco queda creada (nunca una asociación huérfana sin cuenta). Nunca crea delegados, rodeos ni asignaciones. Nunca devuelve password_hash. Dos eventos de auditoría (asociaciones + cuentas_institucionales), ambos en la misma transacción.';

-- ─── Suspender / reactivar: tocan EXCLUSIVAMENTE cuentas_institucionales.activo ──
CREATE OR REPLACE FUNCTION suspender_cuenta_institucional_con_auditoria(
    p_cuenta_id UUID,
    p_administrador_id UUID,
    p_descripcion TEXT
) RETURNS cuenta_institucional_publica AS $$
DECLARE
    v_version_anterior INTEGER;
    v_resultado cuenta_institucional_publica;
BEGIN
    -- Riesgo 1 (revisión posterior): también incrementa password_version —
    -- invalida PERMANENTEMENTE cualquier JWT emitido antes de esta
    -- suspensión, incluso después de una reactivación posterior (antes,
    -- solo `activo` cambiaba: un JWT viejo sin expirar por tiempo volvía a
    -- ser válido apenas se reactivaba la cuenta). Nunca toca password_hash
    -- ni fuerza primer_login — la cuenta sigue utilizable con su misma
    -- contraseña vigente, solo se cierran las sesiones previas.
    UPDATE cuentas_institucionales
        SET activo = false, password_version = password_version + 1, updated_at = now()
        WHERE id = p_cuenta_id AND activo = true
        RETURNING id, email, asociacion_id, rol_institucional, activo, primer_login,
                  password_version, created_at, updated_at, ultimo_acceso_en
        INTO v_resultado;

    IF v_resultado IS NULL THEN
        IF EXISTS(SELECT 1 FROM cuentas_institucionales WHERE id = p_cuenta_id) THEN
            RAISE EXCEPTION 'CUENTA_YA_SUSPENDIDA';
        END IF;
        RAISE EXCEPTION 'CUENTA_NO_ENCONTRADA';
    END IF;

    v_version_anterior := v_resultado.password_version - 1;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES ('cuentas_institucionales', p_cuenta_id::text, 'suspender',
        jsonb_build_object('activo', true, 'password_version', v_version_anterior),
        jsonb_build_object('activo', false, 'password_version', v_resultado.password_version),
        p_administrador_id::text, 'administrador', p_descripcion);

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION suspender_cuenta_institucional_con_auditoria IS
    'Gestión de acceso (078): suspende EXCLUSIVAMENTE el acceso institucional (cuentas_institucionales.activo) — nunca toca asociaciones.activa, delegados_asociacion, cartillas ni designaciones. También incrementa password_version (riesgo real corregido en revisión posterior: sin esto, un JWT emitido antes de suspender podía volver a ser válido después de reactivar, antes de expirar por tiempo) — nunca cambia password_hash ni fuerza primer_login. El middleware soloCuentaInstitucional ya revalida activo Y password_version en cada request: el efecto es inmediato y permanente sobre cualquier sesión abierta, sin código adicional. Auditoría atómica, incluye el cambio de versión.';

CREATE OR REPLACE FUNCTION reactivar_cuenta_institucional_con_auditoria(
    p_cuenta_id UUID,
    p_administrador_id UUID
) RETURNS cuenta_institucional_publica AS $$
DECLARE
    v_resultado cuenta_institucional_publica;
BEGIN
    UPDATE cuentas_institucionales
        SET activo = true, updated_at = now()
        WHERE id = p_cuenta_id AND activo = false
        RETURNING id, email, asociacion_id, rol_institucional, activo, primer_login,
                  password_version, created_at, updated_at, ultimo_acceso_en
        INTO v_resultado;

    IF v_resultado IS NULL THEN
        IF EXISTS(SELECT 1 FROM cuentas_institucionales WHERE id = p_cuenta_id) THEN
            RAISE EXCEPTION 'CUENTA_YA_ACTIVA';
        END IF;
        RAISE EXCEPTION 'CUENTA_NO_ENCONTRADA';
    END IF;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES ('cuentas_institucionales', p_cuenta_id::text, 'reactivar',
        jsonb_build_object('activo', false), jsonb_build_object('activo', true),
        p_administrador_id::text, 'administrador',
        format('Reactivación de cuenta institucional: %s', v_resultado.email));

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION reactivar_cuenta_institucional_con_auditoria IS
    'Gestión de acceso (078): reactiva EXCLUSIVAMENTE cuentas_institucionales.activo. Nunca cambia password_hash ni password_version — no necesita incrementarla ella misma: el incremento ya ocurrió en suspender_cuenta_institucional_con_auditoria() y es permanente/acumulativo, así que un JWT emitido antes de la suspensión sigue invalidado también después de reactivar. La cuenta sigue con su contraseña vigente, salvo un restablecimiento aparte. Auditoría atómica.';

-- ─── Restablecer contraseña: recibe el hash ya calculado por el backend ──
CREATE OR REPLACE FUNCTION resetear_password_cuenta_institucional_con_auditoria(
    p_cuenta_id UUID,
    p_password_hash TEXT,
    p_administrador_id UUID,
    p_descripcion TEXT
) RETURNS cuenta_institucional_publica AS $$
DECLARE
    v_resultado cuenta_institucional_publica;
BEGIN
    UPDATE cuentas_institucionales
        SET password_hash = p_password_hash,
            primer_login = true,
            password_version = password_version + 1,
            updated_at = now()
        WHERE id = p_cuenta_id
        RETURNING id, email, asociacion_id, rol_institucional, activo, primer_login,
                  password_version, created_at, updated_at, ultimo_acceso_en
        INTO v_resultado;

    IF v_resultado IS NULL THEN
        RAISE EXCEPTION 'CUENTA_NO_ENCONTRADA';
    END IF;

    -- Nunca el hash ni la contraseña en texto plano en la auditoría —
    -- solo metadatos de la operación.
    INSERT INTO auditoria (tabla, registro_id, accion, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES ('cuentas_institucionales', p_cuenta_id::text, 'resetear_password',
        jsonb_build_object('primer_login', true, 'password_version', v_resultado.password_version),
        p_administrador_id::text, 'administrador', p_descripcion);

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION resetear_password_cuenta_institucional_con_auditoria IS
    'Gestión de acceso (078): restablece la contraseña (hash ya calculado por el backend con bcryptjs, costo 12 — esta función nunca hashea ni genera nada), fuerza primer_login=true e incrementa password_version (invalida de inmediato cualquier sesión anterior, vía soloCuentaInstitucional). Nunca registra el hash ni la contraseña en auditoria. Auditoría atómica.';

-- ─── Endurecimiento de privilegios (mismo criterio que 071/073, desde el
-- primer momento) ──────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION crear_cuenta_institucional_con_auditoria(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION crear_asociacion_institucional_con_auditoria(TEXT, TEXT, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION suspender_cuenta_institucional_con_auditoria(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reactivar_cuenta_institucional_con_auditoria(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION resetear_password_cuenta_institucional_con_auditoria(UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION crear_cuenta_institucional_con_auditoria(UUID, TEXT, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION crear_asociacion_institucional_con_auditoria(TEXT, TEXT, TEXT, TEXT, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION suspender_cuenta_institucional_con_auditoria(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION reactivar_cuenta_institucional_con_auditoria(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION resetear_password_cuenta_institucional_con_auditoria(UUID, TEXT, UUID, TEXT) TO service_role;

ALTER FUNCTION crear_cuenta_institucional_con_auditoria(UUID, TEXT, TEXT, UUID) SET search_path = public, pg_temp;
ALTER FUNCTION crear_asociacion_institucional_con_auditoria(TEXT, TEXT, TEXT, TEXT, TEXT, UUID) SET search_path = public, pg_temp;
ALTER FUNCTION suspender_cuenta_institucional_con_auditoria(UUID, UUID, TEXT) SET search_path = public, pg_temp;
ALTER FUNCTION reactivar_cuenta_institucional_con_auditoria(UUID, UUID) SET search_path = public, pg_temp;
ALTER FUNCTION resetear_password_cuenta_institucional_con_auditoria(UUID, TEXT, UUID, TEXT) SET search_path = public, pg_temp;

-- Reversible:
--   DROP FUNCTION IF EXISTS crear_cuenta_institucional_con_auditoria(UUID, TEXT, TEXT, UUID);
--   DROP FUNCTION IF EXISTS crear_asociacion_institucional_con_auditoria(TEXT, TEXT, TEXT, TEXT, TEXT, UUID);
--   DROP FUNCTION IF EXISTS suspender_cuenta_institucional_con_auditoria(UUID, UUID, TEXT);
--   DROP FUNCTION IF EXISTS reactivar_cuenta_institucional_con_auditoria(UUID, UUID);
--   DROP FUNCTION IF EXISTS resetear_password_cuenta_institucional_con_auditoria(UUID, TEXT, UUID, TEXT);
--   DROP TYPE IF EXISTS cuenta_institucional_publica;
--   ALTER TABLE cuentas_institucionales DROP CONSTRAINT IF EXISTS uq_cuentas_institucionales_asociacion_id;
--   ALTER TABLE cuentas_institucionales DROP COLUMN IF EXISTS password_version;
--   -- (quitar password_version reabre el Riesgo 1 del encabezado — no
--   --  recomendado; se documenta solo por completitud del procedimiento).
