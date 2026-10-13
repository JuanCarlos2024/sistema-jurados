-- ═════════════════════════════════════════════════════════════════════════
-- 079_comision_asociacion.sql
-- Nuevo módulo: Comisión de Asociación — evaluación individual de jurados
-- por rodeo (ponderación con/sin Movimiento a la Rienda), consolidada en una
-- Nota Comisión general por rodeo. Rol institucional nuevo, independiente
-- del Delegado de Asociación, reutilizando cuentas_institucionales.
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — preparada en Fase 2 local, pendiente de
-- autorización explícita para ejecutarse. Depende de 061/078 (cuentas
-- institucionales), 028 (rodeo_notas_secundarias), 069 (auditoria.actor_tipo
-- incluye 'cuenta_institucional'), 071 (criterio de hardening).
--
-- DATOS REALES CONFIRMADOS (solo lectura, antes de diseñar esta migración):
-- 56 asociaciones (55 ordinarias + 1 especial), 55 cuentas institucionales
-- (todas rol_institucional='delegado_asociacion'), 83 filas en
-- rodeo_notas_secundarias (40 con nota_comision ya cargada — histórico sin
-- desglose por jurado, 71 con nota_delegado). Esta migración NUNCA cambia
-- el valor de esas 40 notas ni crea evaluaciones ficticias para ellas.
--
-- ───────────────────────────────────────────────────────────────────────
-- DECISIÓN 1 — Rol nuevo en cuentas_institucionales, no tabla separada.
-- La propia migración 061 ya dejó anticipado textualmente este camino
-- ("reservado para extender a comision_asociacion en una fase futura sin
-- migrar datos existentes"). Se ampliía el CHECK de rol_institucional y se
-- reemplaza la UNIQUE(asociacion_id) por UNIQUE(asociacion_id,
-- rol_institucional) — permite UNA cuenta de cada rol por asociación, nunca
-- más de una del mismo rol. Las 55 cuentas existentes no se tocan: todas
-- siguen siendo 'delegado_asociacion', ningún UPDATE las modifica.
--
-- DECISIÓN 2 — Sin sobrecargas de función (overloading), siguiendo el
-- precedente YA aplicado en la migración 077 (comentario textual: "se
-- elimina la firma antigua primero para que CREATE OR REPLACE no deje un
-- segundo overload fantasma"). crear_cuenta_institucional_con_auditoria y
-- crear_asociacion_institucional_con_auditoria cambian de firma (se agrega
-- p_rol_institucional al final, con DEFAULT 'delegado_asociacion') — se
-- hace DROP FUNCTION de la firma exacta anterior antes de CREATE OR REPLACE,
-- así en todo momento existe EXACTAMENTE una función con ese nombre. Los
-- llamadores actuales (admin/cuentas-institucionales.js) que no envían el
-- parámetro nuevo obtienen idéntico comportamiento a hoy (DEFAULT). El
-- hardening de privilegios se reaplica explícitamente después del DROP
-- (un DROP limpia los GRANT anteriores).
--
-- DECISIÓN 3 — rodeo_notas_secundarias.nota_comision se preserva como Nota
-- Comisión GENERAL por rodeo (nunca se reinterpreta como nota individual).
-- Las evaluaciones individuales viven en una tabla nueva
-- (comision_evaluaciones_jurado, grano rodeo+asignación), y solo se
-- CONSOLIDAN hacia nota_comision cuando TODOS los jurados vigentes de ese
-- rodeo ya fueron evaluados — nunca antes. Estado explícito nuevo
-- (estado_nota_comision), nunca inferido de NULL.
--
-- DECISIÓN 4 — Identidad del jurado evaluado: snapshot inmutable
-- (usuario_pagado_id_evaluado_snapshot + nombre_evaluado_snapshot) tomado en
-- el momento del envío, además de la referencia a asignacion_id. Confirmado
-- en Fase 1: un reemplazo de jurado (PATCH /admin/asignaciones/:id)
-- sobreescribe usuario_pagado_id EN LA MISMA FILA sin versionar nada — sin
-- este snapshot, una evaluación ya enviada quedaría silenciosamente
-- "re-apuntada" a otra persona.
--
-- DECISIÓN 5 (aprobada explícitamente por el usuario, Opción A) — si la
-- Nota Comisión general YA fue publicada/corregida y la nómina de jurados
-- cambia después (reemplazo, anulación o rechazo sobre una asignación con
-- evaluación ya enviada), la nota consolidada se CONSERVA tal cual, NUNCA
-- se recalcula sola: se marca requiere_revision_admin=true y queda
-- bloqueada toda nueva consolidación automática hasta que un administrador
-- pleno la resuelva explícitamente (resolver_revision_admin_comision_con_
-- auditoria). Detección vía TRIGGER sobre `asignaciones` (no solo un chequeo
-- de pantalla): cubre reemplazo, anulación y rechazo sin importar por qué
-- endpoint administrativo ocurra el cambio.
--
-- No se crean cuentas reales de Comisión, no se recalculan ni se tocan las
-- 40 notas históricas, no se modifica nota_delegado ni evaluaciones.nota_final
-- en ningún punto de esta migración.
--
-- ───────────────────────────────────────────────────────────────────────
-- CORRECCIÓN POSTERIOR (auditoría de seguridad e integridad, antes de
-- cualquier ejecución — la 079 NUNCA llegó a aplicarse):
--
-- DECISIÓN 6 — Tablas nuevas endurecidas con el MISMO criterio de la
-- migración 071 (RLS habilitado SIN políticas + REVOKE de tabla a PUBLIC/
-- anon/authenticated + GRANT explícito a service_role). El REVOKE EXECUTE
-- sobre las RPC nunca fue suficiente por sí solo: una tabla nueva sin este
-- tratamiento puede quedar alcanzable directamente vía PostgREST
-- (GET/POST /rest/v1/<tabla>), sin pasar nunca por ninguna RPC.
--
-- DECISIÓN 7 — Unicidad real por EVALUACIÓN VIGENTE, no por asignación a
-- secas: UNIQUE(rodeo_id, asignacion_id) se sustituye por un índice único
-- PARCIAL, condicionado a estado='enviada'. Permite que, tras un reemplazo
-- de jurado sobre la MISMA asignación, exista una evaluación histórica
-- (ahora 'desvinculada_por_cambio_designacion') Y una nueva evaluación
-- 'enviada' para el reemplazante — nunca dos 'enviada' simultáneas. Se
-- agrega un segundo índice único parcial por (rodeo_id,
-- usuario_pagado_id_evaluado_snapshot) — misma condición — para impedir que
-- la MISMA persona real sea evaluada dos veces en el mismo rodeo a través
-- de dos asignaciones distintas. Limitación documentada: si la identidad
-- nunca se pudo resolver (usuario_pagado_id_evaluado_snapshot NULL, solo
-- nombre_importado), esta segunda protección no aplica — nunca se asume
-- igualdad de persona solo por el nombre.
--
-- DECISIÓN 8 — El trigger ahora hace DOS cosas, separadas explícitamente:
--   (a) DESVINCULAR (estado='desvinculada_por_cambio_designacion') cualquier
--       evaluación 'enviada' cuya asignación dejó de representar a la MISMA
--       persona o dejó de estar vigente (reemplazo/anulación/rechazo) — esto
--       ocurre SIEMPRE, sin importar si la Nota Comisión general ya fue
--       publicada, porque es una corrección de integridad de datos, no una
--       decisión deportiva.
--   (b) MARCAR requiere_revision_admin — SOLO si la Nota Comisión general
--       ya estaba 'completa'/'corregida_admin' cuando ocurrió el cambio.
-- Se agrega además un trigger AFTER INSERT (alta de un jurado vigente nuevo
-- después de publicada la nota) y se ampliía la detección de UPDATE para
-- cubrir transiciones de vigencia en cualquier dirección (no solo cambio de
-- identidad) — nunca solo "cambió el id de la persona".
--
-- DECISIÓN 9 — Toda la lógica nueva usa designación efectiva NULL-segura:
-- COALESCE(estado_designacion, 'pendiente') <> 'rechazado' (nunca la
-- comparación `<>` desnuda, que en Postgres excluye NULL de cualquier
-- resultado). El código YA EXISTENTE en el resto del proyecto (019/021/031/
-- 066-077/rutas institucionales) sigue usando `<> 'rechazado'` sin cambios —
-- esta corrección es exclusiva del código NUEVO de este módulo, nunca se
-- tocó ningún archivo ajeno para no arriesgar una regresión deportiva.
--
-- DECISIÓN 10 — enviar_evaluacion_comision_jurado_con_auditoria ahora
-- rechaza explícitamente CUALQUIER envío mientras estado_nota_comision esté
-- en ('historica_sin_desglose','completa','corregida_admin') o
-- requiere_revision_admin=true — solo 'sin_evaluar'/'parcial' (o ausencia de
-- fila) admiten evaluaciones nuevas. Reabrir un rodeo ya consolidado para
-- evaluar a un reemplazante es, deliberadamente, una decisión administrativa
-- aparte (ver corregir_evaluacion_individual_comision_con_auditoria) — el
-- portal de Comisión nunca la hace por sí solo.
--
-- DECISIÓN 11 — actualizar_notas_secundarias_con_auditoria exige motivo NO
-- vacío y un valor numérico válido (nunca NULL) cuando la Nota Comisión está
-- protegida — ya no existe un motivo por defecto que permita una
-- sobrescritura silenciosa. El endpoint administrativo (fuera de esta
-- migración) exige además administrador PLENO, no monitor/director, para
-- cualquier sobrescritura protegida.
--
-- DECISIÓN 12 — Nueva RPC corregir_evaluacion_individual_comision_con_
-- auditoria: único camino para que un administrador pleno corrija una
-- evaluación individual YA enviada (recalcula server-side, exige motivo,
-- conserva el valor anterior en comision_evaluaciones_correcciones, marca la
-- fila estado='corregida_admin') — nunca recalcula sola la Nota Comisión
-- general.
--
-- DECISIÓN 13 — El evento de auditoría de publicación automática de la Nota
-- Comisión general ya no se atribuye a un actor_id inventado
-- ('sistema_comision'): se atribuye a la cuenta_institucional real cuyo
-- envío completó la nómina — identidad siempre trazable a una persona real.
--
-- ───────────────────────────────────────────────────────────────────────
-- CORRECCIÓN POSTERIOR — RONDA 4 (cierre definitivo de hallazgos, la 079
-- NUNCA llegó a aplicarse):
--
-- DECISIÓN 14 — corregir_evaluacion_individual_comision_con_auditoria
-- rechaza explícitamente cualquier evaluación en estado 'desvinculada_por_
-- cambio_designacion' (EVALUACION_DESVINCULADA_NO_CORREGIBLE). Antes podía
-- "corregirse" de vuelta a 'corregida_admin', reactivándola y atribuyendo
-- una evaluación histórica de una persona a quien ocupa esa asignación
-- AHORA. No existe ninguna vía que reactive una evaluación desvinculada —
-- permanece así para siempre, con su contenido histórico íntegro.
--
-- DECISIÓN 15 — comision_autorizaciones_evaluacion queda LIGADA a la
-- identidad real de la persona autorizada (usuario_pagado_id_autorizado +
-- nombre_autorizado_snapshot, congelados al otorgarla), no solo a rodeo+
-- asignación. estado tri-state (pendiente/usada/invalidada, nunca un
-- booleano) preserva las tres situaciones por separado. El trigger de
-- designación invalida CUALQUIER autorización pendiente de una asignación
-- ante cualquier cambio relevante — nunca queda disponible para evaluar a
-- alguien distinto del expresamente autorizado. Otorgar una nueva
-- autorización invalida automáticamente cualquier pendiente anterior para
-- la misma asignación (índice único real: nunca coexisten dos pendientes).
--
-- DECISIÓN 16 — una evaluación autorizada que se registra sobre un rodeo
-- ya publicado/corregido vuelve a marcar requiere_revision_admin (reutiliza
-- la bandeja YA EXISTENTE, nunca un estado nuevo) — queda visible que
-- existe una evaluación nueva pendiente de decisión administrativa sobre
-- la Nota Comisión general, que se conserva intacta hasta que el
-- administrador decida explícitamente (mantener/corregir).
--
-- DECISIÓN 17 — el trigger de designación ahora: (a) reconoce un cambio de
-- nombre_importado como cambio de identidad CUANDO usuario_pagado_id es
-- NULL en ambos extremos (antes solo miraba usuario_pagado_id, perdiendo
-- reemplazos entre dos personas sin identidad estable); (b) marca
-- requiere_revision_admin incluso cuando NO hay una evaluación previa que
-- desvincular, siempre que algo relevante cambió (identidad y/o vigencia)
-- y la nota general ya está cerrada — antes ese caso caía en silencio.
--
-- DECISIÓN 18 (concurrencia real) — orden de locks unificado: TODAS las
-- RPC de este módulo que tocan un rodeo (incluida ahora corregir_
-- evaluacion_individual_comision_con_auditoria y autorizar_evaluacion_
-- reemplazante_comision_con_auditoria, que antes no bloqueaban `rodeos` en
-- absoluto) lo bloquean PRIMERO, siempre — deadlock estructuralmente
-- imposible por orden consistente, no por suerte. fn_recalcular_
-- consolidacion_comision_rodeo además bloquea las filas de asignaciones de
-- jurado del rodeo ANTES de contarlas, y calcula vigentes+evaluados en UNA
-- sola sentencia (antes eran dos SELECT independientes, con una ventana
-- real bajo READ COMMITTED para que una escritura concurrente produjera un
-- conteo mezclado). Limitación reconocida explícitamente: esto prueba
-- ausencia de deadlock y cierra la ventana DENTRO de cada función — no
-- constituye una prueba de concurrencia real con conexiones físicas
-- independientes (no disponible en este entorno); ver el informe de
-- entrega para el detalle de esta limitación.
--
-- Migración envuelta en una transacción explícita (BEGIN/COMMIT): si
-- cualquier sentencia falla, Postgres revierte TODO — nunca queda una tabla
-- creada sin su hardening, o una función sin su GRANT.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1) cuentas_institucionales — nuevo rol + unicidad compuesta
-- ─────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'cuentas_institucionales'::regclass
          AND conname = 'cuentas_institucionales_rol_institucional_check'
    ) THEN
        ALTER TABLE cuentas_institucionales DROP CONSTRAINT cuentas_institucionales_rol_institucional_check;
    END IF;
    ALTER TABLE cuentas_institucionales ADD CONSTRAINT cuentas_institucionales_rol_institucional_check
        CHECK (rol_institucional IN ('delegado_asociacion', 'comision_asociacion'));
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'cuentas_institucionales'::regclass AND conname = 'uq_cuentas_institucionales_asociacion_id'
    ) THEN
        ALTER TABLE cuentas_institucionales DROP CONSTRAINT uq_cuentas_institucionales_asociacion_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'cuentas_institucionales'::regclass AND conname = 'uq_cuentas_institucionales_asociacion_rol'
    ) THEN
        ALTER TABLE cuentas_institucionales
            ADD CONSTRAINT uq_cuentas_institucionales_asociacion_rol UNIQUE (asociacion_id, rol_institucional);
    END IF;
END $$;

COMMENT ON CONSTRAINT uq_cuentas_institucionales_asociacion_rol ON cuentas_institucionales IS
    'Comisión de Asociación (079): una cuenta por asociación Y rol — permite una de Delegado de Asociación y una de Comisión de Asociación para la misma asociación, nunca dos del mismo rol. Sustituye a uq_cuentas_institucionales_asociacion_id (078).';

-- ─────────────────────────────────────────────────────────────────────────
-- 2) RPC de creación de cuentas — DROP de la firma exacta + CREATE OR REPLACE
--    con p_rol_institucional nuevo (DEFAULT 'delegado_asociacion'), sin dejar
--    overloads. Mismo cuerpo que 078, solo se agrega el parámetro y su
--    validación — ninguna otra garantía de seguridad se reduce.
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS crear_cuenta_institucional_con_auditoria(UUID, TEXT, TEXT, UUID);
CREATE OR REPLACE FUNCTION crear_cuenta_institucional_con_auditoria(
    p_asociacion_id UUID,
    p_email TEXT,
    p_password_hash TEXT,
    p_administrador_id UUID,
    p_rol_institucional TEXT DEFAULT 'delegado_asociacion'
) RETURNS cuenta_institucional_publica AS $$
DECLARE
    v_activa BOOLEAN;
    v_es_especial BOOLEAN;
    v_resultado cuenta_institucional_publica;
    v_constraint TEXT;
BEGIN
    IF p_rol_institucional NOT IN ('delegado_asociacion', 'comision_asociacion') THEN
        RAISE EXCEPTION 'ROL_INSTITUCIONAL_INVALIDO';
    END IF;

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

    IF EXISTS(
        SELECT 1 FROM cuentas_institucionales
        WHERE asociacion_id = p_asociacion_id AND rol_institucional = p_rol_institucional
    ) THEN
        RAISE EXCEPTION 'CUENTA_YA_EXISTE_PARA_ASOCIACION';
    END IF;

    BEGIN
        INSERT INTO cuentas_institucionales (
            email, password_hash, asociacion_id, rol_institucional,
            activo, primer_login, password_version, created_by
        ) VALUES (
            p_email, p_password_hash, p_asociacion_id, p_rol_institucional,
            true, true, 1, p_administrador_id
        )
        RETURNING id, email, asociacion_id, rol_institucional, activo, primer_login,
                  password_version, created_at, updated_at, ultimo_acceso_en
        INTO v_resultado;
    EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_constraint = 'cuentas_institucionales_email_key' THEN
            RAISE EXCEPTION 'CORREO_YA_REGISTRADO';
        ELSIF v_constraint = 'uq_cuentas_institucionales_asociacion_rol' THEN
            RAISE EXCEPTION 'CUENTA_YA_EXISTE_PARA_ASOCIACION';
        END IF;
        RAISE;
    END;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES ('cuentas_institucionales', v_resultado.id::text, 'crear',
        jsonb_build_object('email', v_resultado.email, 'asociacion_id', p_asociacion_id, 'rol_institucional', p_rol_institucional),
        p_administrador_id::text, 'administrador',
        format('Alta de cuenta institucional (%s) para asociación existente: %s', p_rol_institucional, v_resultado.email));

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION crear_cuenta_institucional_con_auditoria IS
    'Gestión de acceso (078) + Comisión de Asociación (079): alta de cuenta institucional para una asociación YA existente, activa y no especial, sin cuenta previa del MISMO rol. p_rol_institucional nuevo (DEFAULT delegado_asociacion, sin romper llamadas existentes). Firma única — sin overload (DROP previo de la firma de 4 parámetros). Nunca devuelve password_hash.';

DROP FUNCTION IF EXISTS crear_asociacion_institucional_con_auditoria(TEXT, TEXT, TEXT, TEXT, TEXT, UUID);
CREATE OR REPLACE FUNCTION crear_asociacion_institucional_con_auditoria(
    p_nombre TEXT,
    p_nombre_normalizado TEXT,
    p_zona TEXT,
    p_email TEXT,
    p_password_hash TEXT,
    p_administrador_id UUID,
    p_rol_institucional TEXT DEFAULT 'delegado_asociacion'
) RETURNS cuenta_institucional_publica AS $$
DECLARE
    v_asociacion_id UUID;
    v_resultado cuenta_institucional_publica;
    v_constraint TEXT;
BEGIN
    IF p_rol_institucional NOT IN ('delegado_asociacion', 'comision_asociacion') THEN
        RAISE EXCEPTION 'ROL_INSTITUCIONAL_INVALIDO';
    END IF;

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
            p_email, p_password_hash, v_asociacion_id, p_rol_institucional,
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
        jsonb_build_object('email', v_resultado.email, 'asociacion_id', v_asociacion_id, 'rol_institucional', p_rol_institucional),
        p_administrador_id::text, 'administrador',
        format('Alta de cuenta institucional (%s) para asociación nueva: %s', p_rol_institucional, v_resultado.email));

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION crear_asociacion_institucional_con_auditoria IS
    'Gestión de acceso (078) + Comisión de Asociación (079): crea una asociación nueva Y su cuenta institucional en una transacción. p_rol_institucional nuevo (DEFAULT delegado_asociacion). Firma única — sin overload (DROP previo de la firma de 6 parámetros).';

-- ─────────────────────────────────────────────────────────────────────────
-- 3) Evaluadores de Comisión — catálogo por asociación, reutilizable.
--    Validación de RUT (checksum incluido) a nivel de aplicación, vía
--    services/rut.js (validarRut/normalizarRut) — YA EXISTENTE en el
--    proyecto, se reutiliza en vez de duplicar la lógica en SQL.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS evaluadores_comision (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    asociacion_id   UUID        NOT NULL REFERENCES asociaciones(id),
    nombre          TEXT        NOT NULL,
    apellidos       TEXT        NOT NULL,
    rut             TEXT        NOT NULL, -- normalizado por services/rut.js: sin puntos, con guión, DV en mayúscula.
    telefono        TEXT,
    email           TEXT,
    activo          BOOLEAN     NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      UUID, -- cuenta_institucional_id o administrador_id (sin FK única: puede ser de cualquiera de las dos tablas).
    CONSTRAINT chk_evaluadores_comision_nombre CHECK (btrim(nombre) <> ''),
    CONSTRAINT chk_evaluadores_comision_apellidos CHECK (btrim(apellidos) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_evaluadores_comision_asociacion_rut ON evaluadores_comision(asociacion_id, rut);
CREATE INDEX IF NOT EXISTS idx_evaluadores_comision_asociacion ON evaluadores_comision(asociacion_id);

COMMENT ON TABLE evaluadores_comision IS
    'Comisión de Asociación (079): catálogo de personas evaluadoras, una por asociación+RUT (reutilizable en múltiples evaluaciones). Nunca se elimina físicamente un evaluador con evaluaciones existentes — solo se suspende (activo=false).';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'evaluador_comision_publico') THEN
        CREATE TYPE evaluador_comision_publico AS (
            id UUID, asociacion_id UUID, nombre TEXT, apellidos TEXT, rut TEXT,
            telefono TEXT, email TEXT, activo BOOLEAN, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
        );
    END IF;
END $$;

CREATE OR REPLACE FUNCTION registrar_evaluador_comision_con_auditoria(
    p_asociacion_id UUID,
    p_nombre TEXT,
    p_apellidos TEXT,
    p_rut TEXT,
    p_telefono TEXT,
    p_email TEXT,
    p_actor_id UUID,
    p_actor_tipo TEXT
) RETURNS evaluador_comision_publico AS $$
DECLARE
    v_resultado evaluador_comision_publico;
BEGIN
    IF p_actor_tipo NOT IN ('cuenta_institucional', 'administrador') THEN
        RAISE EXCEPTION 'ACTOR_TIPO_INVALIDO';
    END IF;

    BEGIN
        INSERT INTO evaluadores_comision (asociacion_id, nombre, apellidos, rut, telefono, email, created_by)
        VALUES (p_asociacion_id, p_nombre, p_apellidos, p_rut, p_telefono, p_email, p_actor_id)
        RETURNING id, asociacion_id, nombre, apellidos, rut, telefono, email, activo, created_at, updated_at
        INTO v_resultado;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'EVALUADOR_YA_REGISTRADO';
    END;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES ('evaluadores_comision', v_resultado.id::text, 'crear',
        jsonb_build_object('asociacion_id', p_asociacion_id, 'nombre', p_nombre, 'apellidos', p_apellidos),
        p_actor_id::text, p_actor_tipo, format('Registro de evaluador de Comisión: %s %s', p_nombre, p_apellidos));

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION suspender_evaluador_comision_con_auditoria(
    p_evaluador_id UUID, p_administrador_id UUID, p_motivo TEXT
) RETURNS evaluador_comision_publico AS $$
DECLARE
    v_resultado evaluador_comision_publico;
BEGIN
    UPDATE evaluadores_comision SET activo = false, updated_at = now()
        WHERE id = p_evaluador_id AND activo = true
        RETURNING id, asociacion_id, nombre, apellidos, rut, telefono, email, activo, created_at, updated_at
        INTO v_resultado;
    IF v_resultado IS NULL THEN
        IF EXISTS(SELECT 1 FROM evaluadores_comision WHERE id = p_evaluador_id) THEN
            RAISE EXCEPTION 'EVALUADOR_YA_SUSPENDIDO';
        END IF;
        RAISE EXCEPTION 'EVALUADOR_NO_ENCONTRADO';
    END IF;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES ('evaluadores_comision', p_evaluador_id::text, 'suspender', jsonb_build_object('activo', false),
        p_administrador_id::text, 'administrador', p_motivo);

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION reactivar_evaluador_comision_con_auditoria(
    p_evaluador_id UUID, p_administrador_id UUID
) RETURNS evaluador_comision_publico AS $$
DECLARE
    v_resultado evaluador_comision_publico;
BEGIN
    UPDATE evaluadores_comision SET activo = true, updated_at = now()
        WHERE id = p_evaluador_id AND activo = false
        RETURNING id, asociacion_id, nombre, apellidos, rut, telefono, email, activo, created_at, updated_at
        INTO v_resultado;
    IF v_resultado IS NULL THEN
        IF EXISTS(SELECT 1 FROM evaluadores_comision WHERE id = p_evaluador_id) THEN
            RAISE EXCEPTION 'EVALUADOR_YA_ACTIVO';
        END IF;
        RAISE EXCEPTION 'EVALUADOR_NO_ENCONTRADO';
    END IF;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES ('evaluadores_comision', p_evaluador_id::text, 'reactivar', jsonb_build_object('activo', true),
        p_administrador_id::text, 'administrador', 'Reactivación de evaluador de Comisión');

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────
-- 4) rodeo_notas_secundarias — estado explícito (nunca inferido de NULL) +
--    mecanismo persistente de "requiere revisión administrativa".
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE rodeo_notas_secundarias
    ADD COLUMN IF NOT EXISTS estado_nota_comision TEXT NOT NULL DEFAULT 'sin_evaluar',
    ADD COLUMN IF NOT EXISTS requiere_revision_admin BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS revision_admin_motivo TEXT,
    ADD COLUMN IF NOT EXISTS revision_admin_detectado_en TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS revision_admin_resuelto_por UUID REFERENCES administradores(id),
    ADD COLUMN IF NOT EXISTS revision_admin_resuelto_en TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_rns_estado_nota_comision') THEN
        ALTER TABLE rodeo_notas_secundarias ADD CONSTRAINT chk_rns_estado_nota_comision
            CHECK (estado_nota_comision IN ('historica_sin_desglose', 'sin_evaluar', 'parcial', 'completa', 'corregida_admin'));
    END IF;
END $$;

-- Backfill EXPLÍCITO y de una sola vez — nunca una regla "inteligente" que
-- se reevalúe en cada corrida: las filas con nota_comision YA cargada
-- (histórico, 40 confirmadas en producción) quedan marcadas de forma fija,
-- SIN tocar su valor numérico. No crea evaluaciones individuales ni
-- evaluadores ficticios para ellas.
UPDATE rodeo_notas_secundarias
    SET estado_nota_comision = 'historica_sin_desglose'
    WHERE nota_comision IS NOT NULL AND estado_nota_comision = 'sin_evaluar';

COMMENT ON COLUMN rodeo_notas_secundarias.estado_nota_comision IS
    'Comisión de Asociación (079): estado EXPLÍCITO de la Nota Comisión general del rodeo — nunca inferido de NULL/valor. historica_sin_desglose = cargada antes de este módulo (protegida, nunca editable desde el portal); sin_evaluar/parcial/completa = ciclo normal de evaluación individual; corregida_admin = ajustada por un administrador pleno con motivo y auditoría.';
COMMENT ON COLUMN rodeo_notas_secundarias.requiere_revision_admin IS
    'Comisión de Asociación (079): true cuando la nómina de jurados cambió (reemplazo/anulación/rechazo) DESPUÉS de publicada/corregida la Nota Comisión general — bloquea toda nueva consolidación automática hasta que un administrador pleno resuelva explícitamente (resolver_revision_admin_comision_con_auditoria). Detectado por trigger sobre asignaciones, no solo por una revisión de pantalla.';

-- ─────────────────────────────────────────────────────────────────────────
-- 5) Evaluaciones individuales por jurado + historial de correcciones.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comision_evaluaciones_jurado (
    id                                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    rodeo_id                                UUID        NOT NULL REFERENCES rodeos(id),
    asignacion_id                           UUID        NOT NULL REFERENCES asignaciones(id),
    asociacion_id                           UUID        NOT NULL REFERENCES asociaciones(id),
    -- Identidad congelada del jurado evaluado al momento del envío — ver
    -- Decisión 4 del encabezado. usuario_pagado_id_evaluado_snapshot puede
    -- ser NULL si la asignación original nunca tuvo usuario_pagado_id
    -- (solo nombre_importado); nombre_evaluado_snapshot SIEMPRE se guarda.
    usuario_pagado_id_evaluado_snapshot     UUID        REFERENCES usuarios_pagados(id),
    nombre_evaluado_snapshot                TEXT        NOT NULL,
    evaluador_id                            UUID        NOT NULL REFERENCES evaluadores_comision(id),
    cuenta_institucional_id                 UUID        NOT NULL REFERENCES cuentas_institucionales(id),
    nota_apinadero                          INTEGER    NOT NULL CHECK (nota_apinadero BETWEEN 1 AND 7),
    nota_cancha                             INTEGER    NOT NULL CHECK (nota_cancha BETWEEN 1 AND 7),
    nota_atajadas                           INTEGER    NOT NULL CHECK (nota_atajadas BETWEEN 1 AND 7),
    nota_cuarta_carrera                     INTEGER    NOT NULL CHECK (nota_cuarta_carrera BETWEEN 1 AND 7),
    hubo_movimiento_rienda                  BOOLEAN     NOT NULL,
    nota_rienda                             INTEGER    CHECK (nota_rienda BETWEEN 1 AND 7),
    nota_individual_calculada               NUMERIC(3,1) NOT NULL CHECK (nota_individual_calculada BETWEEN 1.0 AND 7.0),
    afecto_resultado_final                  BOOLEAN     NOT NULL,
    comentario                              TEXT        CHECK (comentario IS NULL OR char_length(comentario) <= 5000),
    estado                                  TEXT        NOT NULL DEFAULT 'enviada'
                                                         CHECK (estado IN ('enviada', 'desvinculada_por_cambio_designacion', 'corregida_admin')),
    enviada_en                              TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at                              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_comision_eval_rienda CHECK (
        (hubo_movimiento_rienda = false AND nota_rienda IS NULL) OR
        (hubo_movimiento_rienda = true AND nota_rienda IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_comision_eval_rodeo ON comision_evaluaciones_jurado(rodeo_id);
CREATE INDEX IF NOT EXISTS idx_comision_eval_evaluador ON comision_evaluaciones_jurado(evaluador_id);
CREATE INDEX IF NOT EXISTS idx_comision_eval_asociacion ON comision_evaluaciones_jurado(asociacion_id);

-- Decisión 7 (corrección posterior): unicidad real por EVALUACIÓN VIGENTE
-- (es decir, DEFINITIVA — 'enviada' O 'corregida_admin'), no por asignación a
-- secas. Un UNIQUE normal sobre (rodeo_id, asignacion_id) impediría para
-- siempre una nueva evaluación legítima del reemplazante después de que la
-- del jurado original quede 'desvinculada_por_cambio_designacion' (ver el
-- trigger más abajo) — por eso es un índice único PARCIAL.
--
-- Corrección posterior (ronda 3, punto 1): la condición pasó de
-- `estado = 'enviada'` a `estado IN ('enviada','corregida_admin')`. Antes,
-- en cuanto corregir_evaluacion_individual_comision_con_auditoria marcaba
-- una fila 'corregida_admin', ESA fila salía del índice único y un segundo
-- envío para la MISMA asignación ya no violaba nada — podían coexistir dos
-- evaluaciones "válidas" para el mismo lugar. Una corrección administrativa
-- sigue siendo una evaluación DEFINITIVA (nunca deja de proteger el hueco);
-- solo 'desvinculada_por_cambio_designacion' libera el índice, y únicamente
-- porque el trigger la aplicó tras un cambio real de designación.
CREATE UNIQUE INDEX IF NOT EXISTS uq_comision_eval_rodeo_asignacion_enviada
    ON comision_evaluaciones_jurado(rodeo_id, asignacion_id) WHERE estado IN ('enviada', 'corregida_admin');
-- Segunda protección: la MISMA persona real no puede tener dos evaluaciones
-- vigentes (enviada o corregida_admin) en el mismo rodeo a través de dos
-- asignaciones distintas (sección 15/Hallazgo 3: "dos asignaciones
-- diferentes de la misma persona"). Limitación explícita y deliberada: si
-- la identidad nunca se resolvió (snapshot NULL, solo nombre_importado),
-- esta protección no aplica — nunca se asume igualdad de persona solo por
-- el nombre.
CREATE UNIQUE INDEX IF NOT EXISTS uq_comision_eval_rodeo_persona_enviada
    ON comision_evaluaciones_jurado(rodeo_id, usuario_pagado_id_evaluado_snapshot)
    WHERE estado IN ('enviada', 'corregida_admin') AND usuario_pagado_id_evaluado_snapshot IS NOT NULL;

COMMENT ON TABLE comision_evaluaciones_jurado IS
    'Comisión de Asociación (079): evaluación individual y definitiva de UN jurado en UN rodeo. Sin borradores — solo existe tras el envío definitivo. Nunca se mezcla con evaluaciones.nota_final (Área Deportiva) ni con rodeo_notas_secundarias.nota_delegado.';

CREATE TABLE IF NOT EXISTS comision_evaluaciones_correcciones (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    rodeo_id            UUID        NOT NULL REFERENCES rodeos(id),
    evaluacion_id       UUID        REFERENCES comision_evaluaciones_jurado(id),
    motivo              TEXT        NOT NULL,
    datos_anteriores    JSONB,
    datos_nuevos        JSONB,
    administrador_id    UUID        NOT NULL REFERENCES administradores(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE comision_evaluaciones_correcciones IS
    'Comisión de Asociación (079): historial de correcciones administrativas sobre la Nota Comisión general o una evaluación individual — nunca se borran versiones previas.';

-- ─────────────────────────────────────────────────────────────────────────
-- Corrección posterior (ronda 3, punto 4): autorización administrativa
-- ESPECÍFICA para evaluar a un jurado reemplazante después de "mantener"
-- (Decisión 4, ya aprobada y definitiva: "mantener" NUNCA reabre el portal
-- por sí sola). Identifica un rodeo+asignación concretos — nunca reabre el
-- rodeo completo ni otras asignaciones. Exclusiva de administrador pleno
-- (enforced en Express, igual que el resto de admin/comisiones-asociacion.js;
-- la RPC que la otorga está además REVOKE de anon/authenticated/
-- cuenta_institucional-vía-PostgREST, así que una cuenta de Comisión no
-- tiene ningún camino para otorgársela a sí misma).
-- ─────────────────────────────────────────────────────────────────────────
-- Corrección posterior (ronda 4, Hallazgo 2): la autorización ahora queda
-- LIGADA a la identidad real de la persona autorizada (snapshot al momento
-- de otorgarla), no solo al rodeo+asignación. Si la designación cambia de
-- persona DESPUÉS de otorgada y ANTES de usarse, el trigger de abajo la
-- invalida explícitamente — nunca queda disponible para evaluar a quien NO
-- fue expresamente autorizado. estado tri-state (en vez de un booleano
-- "usada") preserva las TRES situaciones por separado: pendiente, usada,
-- invalidada — nunca se borra ni se reescribe una fila existente.
CREATE TABLE IF NOT EXISTS comision_autorizaciones_evaluacion (
    id                              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    rodeo_id                        UUID        NOT NULL REFERENCES rodeos(id),
    asignacion_id                   UUID        NOT NULL REFERENCES asignaciones(id),
    -- Identidad congelada al OTORGAR la autorización — mismo criterio que el
    -- snapshot de comision_evaluaciones_jurado. NULL si la asignación nunca
    -- tuvo usuario_pagado_id (solo nombre_importado) — tratamiento
    -- conservador: la identidad NUNCA se verifica por nombre, se verifica
    -- por igualdad exacta (incluyendo IS NULL) contra la asignación en el
    -- momento de usarla; cualquier cambio la invalida, sin excepción.
    usuario_pagado_id_autorizado    UUID        REFERENCES usuarios_pagados(id),
    nombre_autorizado_snapshot      TEXT        NOT NULL,
    motivo                          TEXT        NOT NULL,
    administrador_id                UUID        NOT NULL REFERENCES administradores(id),
    estado                          TEXT        NOT NULL DEFAULT 'pendiente'
                                                 CHECK (estado IN ('pendiente', 'usada', 'invalidada')),
    usada_en                        TIMESTAMPTZ,
    invalidada_en                   TIMESTAMPTZ,
    invalidada_motivo               TEXT,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_autorizaciones_motivo CHECK (btrim(motivo) <> '')
);
-- Restricción efectiva (Hallazgo 2): nunca más de UNA autorización
-- "pendiente" simultánea para la misma asignación — otorgar una nueva
-- invalida automáticamente cualquier pendiente anterior (ver la RPC de
-- abajo), así que este índice nunca debería violarse en la práctica, pero
-- queda como backstop real de concurrencia, no solo de aplicación.
CREATE UNIQUE INDEX IF NOT EXISTS uq_autorizaciones_pendiente_unica
    ON comision_autorizaciones_evaluacion(rodeo_id, asignacion_id) WHERE estado = 'pendiente';

COMMENT ON TABLE comision_autorizaciones_evaluacion IS
    'Comisión de Asociación (079): autorización administrativa específica (rodeo+asignación+IDENTIDAD) para evaluar a un jurado reemplazante cuando la Nota Comisión general ya está cerrada o el rodeo requiere revisión. Nunca reabre el rodeo completo. Ligada a la identidad congelada al otorgarla — se invalida automáticamente si la designación cambia de persona antes de usarse. estado: pendiente/usada/invalidada, historial completo preservado.';

-- ─────────────────────────────────────────────────────────────────────────
-- Decisión 6 (corrección posterior) — Hallazgo 1: endurecimiento de las 4
-- tablas nuevas, MISMO criterio que la migración 071 (RLS sin políticas +
-- REVOKE de tabla a PUBLIC/anon/authenticated + GRANT explícito a
-- service_role). Contienen RUT, correos, teléfonos y evaluaciones
-- individuales — el REVOKE EXECUTE sobre las RPC nunca bastaba por sí solo,
-- porque una tabla nueva sin este tratamiento queda alcanzable DIRECTO vía
-- PostgREST (GET/POST /rest/v1/<tabla>), sin pasar por ninguna función.
-- service_role tiene BYPASSRLS en Supabase — el backend sigue funcionando
-- exactamente igual; anon/authenticated quedan en cero acceso real, incluso
-- si alguna vez heredaran un GRANT de tabla por "default privileges".
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE evaluadores_comision ENABLE ROW LEVEL SECURITY;
ALTER TABLE comision_evaluaciones_jurado ENABLE ROW LEVEL SECURITY;
ALTER TABLE comision_evaluaciones_correcciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE comision_autorizaciones_evaluacion ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE evaluadores_comision FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE comision_evaluaciones_jurado FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE comision_evaluaciones_correcciones FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE comision_autorizaciones_evaluacion FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE evaluadores_comision TO service_role;
GRANT ALL ON TABLE comision_evaluaciones_jurado TO service_role;
GRANT ALL ON TABLE comision_evaluaciones_correcciones TO service_role;
GRANT ALL ON TABLE comision_autorizaciones_evaluacion TO service_role;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'comision_evaluacion_jurado_publica') THEN
        CREATE TYPE comision_evaluacion_jurado_publica AS (
            id UUID, rodeo_id UUID, asignacion_id UUID, nombre_evaluado_snapshot TEXT,
            nota_individual_calculada NUMERIC(3,1), estado TEXT, enviada_en TIMESTAMPTZ
        );
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 6) Fórmula de cálculo — Movimiento a la Rienda. Backend NUNCA confía en un
--    valor calculado por el frontend: esta función es la única fuente de
--    verdad, llamada SIEMPRE dentro de la RPC de envío. Sin redondeo de
--    componentes intermedios — solo el resultado final, a 1 decimal.
--    Casos de prueba exigidos: (6,5,4,3) sin rienda = 4.6;
--    (6,5,4,3,7) con rienda = 5.1.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_calcular_nota_individual_comision(
    p_apinadero INTEGER, p_cancha INTEGER, p_atajadas INTEGER, p_cuarta INTEGER,
    p_hubo_rienda BOOLEAN, p_rienda INTEGER
) RETURNS NUMERIC(3,1) AS $$
BEGIN
    IF p_hubo_rienda THEN
        RETURN round((p_apinadero * 0.16 + p_cancha * 0.24 + p_atajadas * 0.32 + p_cuarta * 0.08 + p_rienda * 0.20)::numeric, 1);
    END IF;
    RETURN round((p_apinadero * 0.20 + p_cancha * 0.30 + p_atajadas * 0.40 + p_cuarta * 0.10)::numeric, 1);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ─────────────────────────────────────────────────────────────────────────
-- 7) Consolidación de la Nota Comisión general — SOLO publica cuando TODOS
--    los jurados vigentes del rodeo ya tienen evaluación enviada. Nunca
--    toca nota_delegado (no aparece en el payload del UPSERT, igual
--    criterio que cartillaDelegadoNotas.js). Nunca recalcula una fila
--    histórica, ya corregida administrativamente, o con una revisión
--    administrativa pendiente (Decisión 5).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_recalcular_consolidacion_comision_rodeo(
    p_rodeo_id UUID, p_actor_cuenta_institucional_id UUID
) RETURNS VOID AS $$
DECLARE
    v_estado_actual TEXT;
    v_requiere_revision BOOLEAN;
    v_total_vigentes INTEGER;
    v_total_evaluados INTEGER;
    v_promedio NUMERIC(3,1);
BEGIN
    -- Corrección posterior (ronda 5, verificación de concurrencia real —
    -- CRÍTICO): el orden de locks se invierte respecto a versiones
    -- anteriores. ANTES esta función bloqueaba rodeo_notas_secundarias
    -- PRIMERO y las asignaciones DESPUÉS. Eso es el orden EXACTO INVERSO al
    -- que usa cualquier actualización administrativa directa sobre
    -- asignaciones (admin/asignaciones.js — código ajeno, nunca modificado):
    -- esas operaciones bloquean la fila de asignación en el UPDATE mismo
    -- (antes de que el trigger exista siquiera) y SOLO DESPUÉS, dentro del
    -- trigger, intentan tocar rodeo_notas_secundarias. Dos transacciones
    -- adquiriendo el mismo par de recursos en órdenes opuestos es la
    -- definición de un ciclo de deadlock real (demostrado en el informe de
    -- entrega, no solo afirmado): Transacción A (esta función) bloqueaba
    -- rodeo_notas_secundarias y luego quería una asignación ya tomada por
    -- Transacción B; B bloqueaba esa asignación primero y luego, vía su
    -- trigger, quería rodeo_notas_secundarias — ya tomada por A. Ahora el
    -- orden coincide: asignaciones PRIMERO, rodeo_notas_secundarias DESPUÉS,
    -- igual que el camino administrativo. El llamador (enviar_evaluacion_
    -- comision_jurado_con_auditoria) también se ajustó para nunca tocar
    -- rodeo_notas_secundarias antes de llamar a esta función.
    PERFORM 1 FROM asignaciones WHERE rodeo_id = p_rodeo_id AND tipo_persona = 'jurado' FOR UPDATE;

    SELECT estado_nota_comision, requiere_revision_admin INTO v_estado_actual, v_requiere_revision
        FROM rodeo_notas_secundarias WHERE rodeo_id = p_rodeo_id FOR UPDATE;

    -- Corrección posterior (ronda 3, punto 3/9): 'completa' se agrega a la
    -- lista de protegidos. ANTES solo se excluían 'historica_sin_desglose'
    -- y 'corregida_admin' — una vez publicada ('completa'), esta función
    -- podía volver a ejecutarse (p. ej. tras una evaluación autorizada del
    -- reemplazante, sección 10c) y RECALCULAR SOLA la nota ya oficial,
    -- exactamente lo que la Decisión 4 prohíbe ("la nueva evaluación y
    -- cualquier posterior modificación de la nota general deben ser
    -- operaciones diferenciadas"). Una nota 'completa' solo puede volver a
    -- cambiar mediante una resolución administrativa explícita
    -- (resolver_revision_admin_comision_con_auditoria) — nunca automático.
    -- La PRIMERA consolidación nunca se bloquea por esto: en ese momento
    -- estado_nota_comision todavía es NULL/'sin_evaluar'/'parcial'.
    IF v_estado_actual IN ('historica_sin_desglose', 'completa', 'corregida_admin') OR v_requiere_revision IS TRUE THEN
        RETURN;
    END IF;

    -- Hallazgo 5: las filas de asignaciones de jurado de este rodeo YA
    -- quedaron bloqueadas arriba (antes de este punto) — un reemplazo/
    -- anulación concurrente sobre cualquiera de ellas (UPDATE) debe esperar
    -- a que esta consolidación termine (o abortar por deadlock — nunca
    -- posible ahora, dado el orden consistente — nunca producir un conteo
    -- mezclado de antes/después). Esto NO bloquea un INSERT de una fila
    -- todavía inexistente (imposible bloquear lo que no existe) — ese caso
    -- lo cubre el trigger AFTER INSERT (fn_detectar_alta_jurado_post_
    -- evaluacion), que ahora bloquea `rodeos` como primer paso, forzando
    -- serialización real contra esta misma función para el mismo rodeo.
    --
    -- Hallazgo 8 (corrección posterior): designación efectiva NULL-segura —
    -- COALESCE(estado_designacion, 'pendiente') <> 'rechazado', nunca la
    -- comparación `<>` desnuda (en Postgres, NULL <> 'rechazado' no es TRUE,
    -- así que una fila con estado_designacion NULL quedaría excluida aunque
    -- el resto del sistema la trate como vigente). Exclusivo del código
    -- NUEVO de este módulo — el resto del proyecto no se toca.
    --
    -- Corrección posterior (ronda 3, punto 3 / ronda 4, Hallazgo 5): ambos
    -- conteos ahora se calculan en UNA sola sentencia (dos subconsultas
    -- evaluadas sobre el mismo snapshot de estamento) — antes eran dos
    -- SELECT independientes y, bajo READ COMMITTED, una escritura
    -- concurrente podía confirmarse ENTRE ambas, produciendo un conteo
    -- inconsistente. cej.estado IN ('enviada','corregida_admin') — una
    -- corrección administrativa individual SIGUE siendo una evaluación
    -- definitiva válida para la consolidación. Lo que SIEMPRE queda
    -- excluido es 'desvinculada_por_cambio_designacion' (ver el trigger) —
    -- una evaluación vieja NUNCA cuenta para un jurado reemplazante.
    SELECT
        (SELECT count(*) FROM asignaciones
            WHERE rodeo_id = p_rodeo_id AND tipo_persona = 'jurado' AND estado = 'activo'
              AND publicado = true AND COALESCE(estado_designacion, 'pendiente') <> 'rechazado'),
        (SELECT count(*) FROM comision_evaluaciones_jurado cej
            JOIN asignaciones a ON a.id = cej.asignacion_id
            WHERE cej.rodeo_id = p_rodeo_id AND cej.estado IN ('enviada', 'corregida_admin')
              AND a.tipo_persona = 'jurado' AND a.estado = 'activo'
              AND a.publicado = true AND COALESCE(a.estado_designacion, 'pendiente') <> 'rechazado')
        INTO v_total_vigentes, v_total_evaluados;

    IF v_total_vigentes > 0 AND v_total_evaluados = v_total_vigentes THEN
        SELECT round(avg(cej.nota_individual_calculada)::numeric, 1) INTO v_promedio
            FROM comision_evaluaciones_jurado cej
            JOIN asignaciones a ON a.id = cej.asignacion_id
            WHERE cej.rodeo_id = p_rodeo_id AND cej.estado IN ('enviada', 'corregida_admin')
              AND a.tipo_persona = 'jurado' AND a.estado = 'activo'
              AND a.publicado = true AND COALESCE(a.estado_designacion, 'pendiente') <> 'rechazado';

        INSERT INTO rodeo_notas_secundarias (rodeo_id, nota_comision, estado_nota_comision, actualizado_por, actualizado_en, updated_at)
        VALUES (p_rodeo_id, v_promedio, 'completa', p_actor_cuenta_institucional_id::text, now(), now())
        ON CONFLICT (rodeo_id) DO UPDATE SET
            nota_comision = EXCLUDED.nota_comision,
            estado_nota_comision = 'completa',
            actualizado_por = EXCLUDED.actualizado_por,
            actualizado_en = now(),
            updated_at = now();

        -- Decisión 13 (corrección posterior) — Hallazgo 11: la publicación
        -- automática se atribuye a la cuenta_institucional REAL cuyo envío
        -- completó la nómina — nunca a un actor_id inventado ('sistema_...').
        INSERT INTO auditoria (tabla, registro_id, accion, datos_nuevos, actor_id, actor_tipo, descripcion)
        VALUES ('rodeo_notas_secundarias', p_rodeo_id::text, 'publicar_nota_comision',
            jsonb_build_object('nota_comision', v_promedio, 'total_jurados', v_total_vigentes),
            p_actor_cuenta_institucional_id::text, 'cuenta_institucional',
            'Nota Comisión general publicada automáticamente al completarse todas las evaluaciones individuales vigentes.');
    ELSE
        INSERT INTO rodeo_notas_secundarias (rodeo_id, estado_nota_comision, updated_at)
        VALUES (p_rodeo_id, 'parcial', now())
        ON CONFLICT (rodeo_id) DO UPDATE SET
            estado_nota_comision = CASE WHEN rodeo_notas_secundarias.estado_nota_comision = 'sin_evaluar' THEN 'parcial' ELSE rodeo_notas_secundarias.estado_nota_comision END,
            updated_at = now();
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────
-- 8) RPC de envío de evaluación individual — candado sobre `rodeos` primero
--    (mismo orden que 077), valida cuenta=comisión, evaluador y asignación
--    de la MISMA asociación, designación vigente, protege notas históricas,
--    calcula server-side (nunca confía en el frontend) y consolida al final.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION enviar_evaluacion_comision_jurado_con_auditoria(
    p_rodeo_id UUID,
    p_asignacion_id UUID,
    p_asociacion_id UUID,
    p_evaluador_id UUID,
    p_cuenta_institucional_id UUID,
    p_nota_apinadero INTEGER,
    p_nota_cancha INTEGER,
    p_nota_atajadas INTEGER,
    p_nota_cuarta_carrera INTEGER,
    p_hubo_movimiento_rienda BOOLEAN,
    p_nota_rienda INTEGER,
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

    -- Hallazgo 2 (corrección posterior, defensa en profundidad adicional):
    -- la verificación REAL de que el rodeo pertenece a esta asociación vive
    -- en Express (rodeoDeMiAsociacion — resolutor de catálogo/alias real,
    -- nunca ILIKE — mismo patrón que confirmar_delegado_institucional_rodeo
    -- de la migración 069, que tampoco la duplica en SQL), y esta RPC es
    -- inalcanzable sin pasar por ahí (REVOKE EXECUTE de anon/authenticated,
    -- igual que 071). Replicar acá el resolutor de nombre+alias duplicaría
    -- esa lógica (prohibido por INSTRUCCIONES.md). Como defensa adicional
    -- que SÍ es válida en SQL sin duplicar nada: si este rodeo ya tiene
    -- evaluaciones de OTRA asociación, es una corrupción de datos real — se
    -- rechaza, nunca se permite mezclar dos asociaciones en el mismo rodeo.
    IF EXISTS (
        SELECT 1 FROM comision_evaluaciones_jurado
        WHERE rodeo_id = p_rodeo_id AND asociacion_id <> p_asociacion_id
    ) THEN
        RAISE EXCEPTION 'ASOCIACION_NO_COINCIDE';
    END IF;

    -- Orden de locks: rodeo primero, siempre (mismo criterio que 077) — evita
    -- deadlock con actualizar_notas_secundarias_con_auditoria (edición admin),
    -- que también toma este candado antes de tocar rodeo_notas_secundarias.
    PERFORM 1 FROM rodeos WHERE id = p_rodeo_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'RODEO_NO_ENCONTRADO'; END IF;

    SELECT estado_nota_comision, requiere_revision_admin INTO v_estado_nota, v_requiere_revision
        FROM rodeo_notas_secundarias WHERE rodeo_id = p_rodeo_id;
    -- Hallazgo 6 (corrección posterior): matriz EXPLÍCITA de estados que
    -- admiten envío — solo NULL (sin fila todavía)/'sin_evaluar'/'parcial',
    -- y nunca con una revisión administrativa pendiente. Antes solo se
    -- bloqueaba 'historica_sin_desglose', dejando que se pudieran seguir
    -- registrando evaluaciones individuales sobre un rodeo YA consolidado o
    -- YA corregido, generando datos contradictorios con la nota general.
    --
    -- Ronda 3, punto 4: 'historica_sin_desglose' NUNCA tiene excepción (un
    -- rodeo histórico jamás tuvo evaluaciones individuales por diseño — no
    -- corresponde crear la primera a través de una autorización). Para
    -- 'completa'/'corregida_admin'/revisión pendiente, SÍ existe una
    -- excepción puntual: una autorización administrativa específica para
    -- ESTA MISMA asignación (nunca para el rodeo completo).
    IF v_estado_nota = 'historica_sin_desglose' THEN
        RAISE EXCEPTION 'NOTA_COMISION_HISTORICA_PROTEGIDA';
    END IF;

    -- Corrección posterior (ronda 4): la asignación se bloquea y se conoce
    -- su identidad ACTUAL antes de evaluar cualquier autorización — Hallazgo
    -- 2 exige comparar esa identidad contra la que quedó congelada al
    -- otorgar la autorización, así que el orden importa.
    SELECT a.id, a.usuario_pagado_id, a.tipo_persona, a.estado, a.publicado, a.estado_designacion,
           COALESCE(up.nombre_completo, a.nombre_importado) AS nombre_resuelto
        INTO v_asignacion
        FROM asignaciones a
        LEFT JOIN usuarios_pagados up ON up.id = a.usuario_pagado_id
        WHERE a.id = p_asignacion_id AND a.rodeo_id = p_rodeo_id
        FOR UPDATE OF a;
    IF NOT FOUND THEN RAISE EXCEPTION 'ASIGNACION_NO_ENCONTRADA'; END IF;
    IF v_asignacion.tipo_persona <> 'jurado' THEN RAISE EXCEPTION 'ASIGNACION_NO_ES_JURADO'; END IF;
    -- Hallazgo 8: designación efectiva NULL-segura (ver fn_recalcular_...).
    IF v_asignacion.estado <> 'activo' OR v_asignacion.publicado IS NOT TRUE
       OR COALESCE(v_asignacion.estado_designacion, 'pendiente') = 'rechazado' THEN
        RAISE EXCEPTION 'DESIGNACION_NO_VIGENTE';
    END IF;

    -- Hallazgo 2 (corrección posterior): solo cuenta una autorización
    -- 'pendiente' cuya identidad congelada COINCIDA EXACTAMENTE con quien
    -- ocupa la asignación AHORA (IS NOT DISTINCT FROM — compara NULL=NULL
    -- como igual, nunca por nombre). El trigger de abajo ya invalida la
    -- autorización en cuanto la designación cambia, así que en el camino
    -- normal esta comparación es redundante — se mantiene como defensa en
    -- profundidad real, nunca decorativa.
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
    -- Si v_autorizacion_id SÍ existe, se permite continuar — pero
    -- estado_nota_comision/requiere_revision_admin NO se tocan acá todavía:
    -- la publicación/resolución de la nota general sigue siendo una
    -- operación aparte y explícita (Decisión 4), nunca automática. Ver
    -- Hallazgo 3 más abajo para la trazabilidad de "pendiente de decisión".

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

    -- Orden de locks (corrección posterior, ronda 5 — concurrencia real):
    -- fn_recalcular_consolidacion_comision_rodeo SIEMPRE se llama ANTES de
    -- tocar rodeo_notas_secundarias por cualquier otra vía en esta función
    -- (incluido el aviso del Hallazgo 3 de abajo) — esa función bloquea
    -- primero TODAS las asignaciones de jurado del rodeo y SOLO DESPUÉS
    -- rodeo_notas_secundarias. Si el aviso del Hallazgo 3 tocara
    -- rodeo_notas_secundarias ANTES de esta llamada, esta misma función
    -- quedaría bloqueando rodeo_notas_secundarias primero y asignaciones
    -- después para OTRAS filas del mismo rodeo — exactamente el orden
    -- invertido que crea un ciclo de deadlock con cualquier reemplazo
    -- administrativo concurrente de un jurado DISTINTO del evaluado aquí.
    PERFORM fn_recalcular_consolidacion_comision_rodeo(p_rodeo_id, p_cuenta_institucional_id);

    IF v_autorizacion_id IS NOT NULL THEN
        -- Hallazgo 3 (corrección posterior): reutiliza la bandeja de
        -- revisión administrativa YA EXISTENTE (nunca un estado nuevo) para
        -- dejar trazabilidad explícita de que llegó una evaluación
        -- autorizada que todavía no fue incorporada/resuelta respecto de la
        -- Nota Comisión general oficial. fn_marcar_revision_admin_si_
        -- corresponde solo actúa si esa nota ya está 'completa'/
        -- 'corregida_admin' — exactamente el caso en que una autorización
        -- fue necesaria. Nunca recalcula la nota general por sí misma. Se
        -- llama DESPUÉS de fn_recalcular (ver comentario arriba) — el lock
        -- sobre rodeo_notas_secundarias que esa función ya tomó cubre
        -- también esta escritura, dentro de la MISMA transacción.
        PERFORM fn_marcar_revision_admin_si_corresponde(p_rodeo_id, format(
            'Evaluación autorizada registrada para %s (autorización %s). La Nota Comisión general oficial se conserva sin cambios — pendiente de decisión administrativa.',
            v_asignacion.nombre_resuelto, v_autorizacion_id));
    END IF;

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION enviar_evaluacion_comision_jurado_con_auditoria IS
    'Comisión de Asociación (079): evaluación individual y DEFINITIVA de un jurado (sin borradores). Candado sobre rodeos primero, luego sobre la asignación. UNIQUE(rodeo_id, asignacion_id) impide duplicados (409 en el backend). Calcula la nota server-side, nunca confía en el frontend. Consolida automáticamente al final (fn_recalcular_consolidacion_comision_rodeo).';

-- ─────────────────────────────────────────────────────────────────────────
-- 9) Edición administrativa de notas secundarias — reemplaza el upsert
--    directo de admin/rodeos.js. Candado sobre rodeos primero (mismo orden
--    que la RPC de envío, evita deadlock). Actualiza Comisión y Delegado de
--    forma INDEPENDIENTE (flags), nunca una limpia a la otra. Exige
--    confirmación explícita para sobrescribir una nota protegida, y nunca
--    permite editar Comisión mientras exista una revisión administrativa
--    pendiente (debe resolverse primero por el flujo dedicado).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION actualizar_notas_secundarias_con_auditoria(
    p_rodeo_id UUID,
    p_actualizar_comision BOOLEAN,
    p_nota_comision NUMERIC,
    p_actualizar_delegado BOOLEAN,
    p_nota_delegado NUMERIC,
    p_confirma_sobrescritura_historica BOOLEAN,
    p_motivo TEXT,
    p_administrador_id UUID
) RETURNS rodeo_notas_secundarias AS $$
DECLARE
    v_anterior RECORD;
    v_fila rodeo_notas_secundarias;
    v_estado_protegido BOOLEAN;
BEGIN
    PERFORM 1 FROM rodeos WHERE id = p_rodeo_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'RODEO_NO_ENCONTRADO'; END IF;

    SELECT * INTO v_anterior FROM rodeo_notas_secundarias WHERE rodeo_id = p_rodeo_id FOR UPDATE;

    IF p_actualizar_comision THEN
        IF v_anterior.requiere_revision_admin IS TRUE THEN
            RAISE EXCEPTION 'REQUIERE_RESOLUCION_ADMINISTRATIVA_PRIMERO';
        END IF;
        v_estado_protegido := COALESCE(v_anterior.estado_nota_comision, 'sin_evaluar') IN ('historica_sin_desglose', 'completa', 'corregida_admin');
        IF v_estado_protegido THEN
            -- Hallazgo 7 (corrección posterior): la confirmación booleana ya
            -- no basta por sí sola — motivo real obligatorio (nunca un
            -- texto por defecto que permita una sobrescritura silenciosa), y
            -- nunca se permite "vaciar" una nota protegida con NULL — toda
            -- corrección exige un valor numérico válido explícito.
            IF NOT p_confirma_sobrescritura_historica THEN
                RAISE EXCEPTION 'NOTA_COMISION_PROTEGIDA_REQUIERE_CONFIRMACION';
            END IF;
            IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN
                RAISE EXCEPTION 'MOTIVO_OBLIGATORIO';
            END IF;
            IF p_nota_comision IS NULL OR p_nota_comision < 1.0 OR p_nota_comision > 7.0 THEN
                RAISE EXCEPTION 'NOTA_FUERA_DE_RANGO';
            END IF;
        END IF;
    END IF;

    INSERT INTO rodeo_notas_secundarias (rodeo_id, nota_comision, nota_delegado, estado_nota_comision, actualizado_por, actualizado_en, updated_at)
    VALUES (
        p_rodeo_id,
        CASE WHEN p_actualizar_comision THEN p_nota_comision ELSE NULL END,
        CASE WHEN p_actualizar_delegado THEN p_nota_delegado ELSE NULL END,
        CASE WHEN p_actualizar_comision THEN 'corregida_admin' ELSE 'sin_evaluar' END,
        p_administrador_id::text, now(), now()
    )
    ON CONFLICT (rodeo_id) DO UPDATE SET
        nota_comision = CASE WHEN p_actualizar_comision THEN EXCLUDED.nota_comision ELSE rodeo_notas_secundarias.nota_comision END,
        nota_delegado = CASE WHEN p_actualizar_delegado THEN EXCLUDED.nota_delegado ELSE rodeo_notas_secundarias.nota_delegado END,
        estado_nota_comision = CASE WHEN p_actualizar_comision THEN 'corregida_admin' ELSE rodeo_notas_secundarias.estado_nota_comision END,
        actualizado_por = p_administrador_id::text,
        actualizado_en = now(),
        updated_at = now()
    RETURNING * INTO v_fila;

    IF p_actualizar_comision THEN
        INSERT INTO comision_evaluaciones_correcciones (rodeo_id, evaluacion_id, motivo, datos_anteriores, datos_nuevos, administrador_id)
        VALUES (p_rodeo_id, NULL, p_motivo, to_jsonb(v_anterior), to_jsonb(v_fila), p_administrador_id);
    END IF;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES ('rodeo_notas_secundarias', p_rodeo_id::text, 'editar',
        to_jsonb(v_anterior), to_jsonb(v_fila), p_administrador_id::text, 'administrador', p_motivo);

    RETURN v_fila;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION actualizar_notas_secundarias_con_auditoria IS
    'Comisión de Asociación (079): sustituye el UPSERT directo de admin/rodeos.js. Candado FOR UPDATE sobre rodeos y la fila de notas. Comisión y Delegado se actualizan de forma independiente (flags p_actualizar_*) — nunca uno limpia al otro. Exige confirmación explícita para sobrescribir una nota de Comisión protegida (histórica/completa/corregida), y rechaza si hay una revisión administrativa pendiente (debe resolverse primero por resolver_revision_admin_comision_con_auditoria).';

-- ─────────────────────────────────────────────────────────────────────────
-- 10) Resolución administrativa de "requiere revisión" — único camino para
--     tocar una Nota Comisión marcada por el trigger de cambio de nómina.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION resolver_revision_admin_comision_con_auditoria(
    p_rodeo_id UUID,
    p_decision TEXT,
    p_motivo TEXT,
    p_nota_comision_nueva NUMERIC,
    p_administrador_id UUID
) RETURNS rodeo_notas_secundarias AS $$
DECLARE
    v_anterior RECORD;
    v_fila rodeo_notas_secundarias;
BEGIN
    IF p_decision NOT IN ('mantener', 'corregir') THEN RAISE EXCEPTION 'DECISION_INVALIDA'; END IF;
    IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_OBLIGATORIO'; END IF;

    PERFORM 1 FROM rodeos WHERE id = p_rodeo_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'RODEO_NO_ENCONTRADO'; END IF;

    SELECT * INTO v_anterior FROM rodeo_notas_secundarias WHERE rodeo_id = p_rodeo_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOTAS_SECUNDARIAS_NO_ENCONTRADAS'; END IF;
    IF NOT v_anterior.requiere_revision_admin THEN RAISE EXCEPTION 'NO_REQUIERE_REVISION'; END IF;

    IF p_decision = 'mantener' THEN
        UPDATE rodeo_notas_secundarias
            SET requiere_revision_admin = false,
                revision_admin_resuelto_por = p_administrador_id,
                revision_admin_resuelto_en = now(),
                updated_at = now()
            WHERE rodeo_id = p_rodeo_id
            RETURNING * INTO v_fila;
    ELSE
        IF p_nota_comision_nueva IS NULL OR p_nota_comision_nueva < 1.0 OR p_nota_comision_nueva > 7.0 THEN
            RAISE EXCEPTION 'NOTA_FUERA_DE_RANGO';
        END IF;
        UPDATE rodeo_notas_secundarias
            SET nota_comision = p_nota_comision_nueva,
                estado_nota_comision = 'corregida_admin',
                requiere_revision_admin = false,
                revision_admin_resuelto_por = p_administrador_id,
                revision_admin_resuelto_en = now(),
                updated_at = now()
            WHERE rodeo_id = p_rodeo_id
            RETURNING * INTO v_fila;

        INSERT INTO comision_evaluaciones_correcciones (rodeo_id, evaluacion_id, motivo, datos_anteriores, datos_nuevos, administrador_id)
        VALUES (p_rodeo_id, NULL, p_motivo, to_jsonb(v_anterior), to_jsonb(v_fila), p_administrador_id);
    END IF;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES ('rodeo_notas_secundarias', p_rodeo_id::text, 'resolver_revision_admin',
        to_jsonb(v_anterior), to_jsonb(v_fila), p_administrador_id::text, 'administrador', p_motivo);

    RETURN v_fila;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION resolver_revision_admin_comision_con_auditoria IS
    'Comisión de Asociación (079): único camino para resolver un rodeo marcado requiere_revision_admin=true. "mantener" conserva la nota consolidada original sin cambios; "corregir" la reemplaza como corrección administrativa auditada (nunca como recálculo automático), deja historial en comision_evaluaciones_correcciones. Motivo obligatorio.';

-- ─────────────────────────────────────────────────────────────────────────
-- 10b) Corrección administrativa de una EVALUACIÓN INDIVIDUAL — Hallazgo 10:
--      único camino para que un administrador pleno corrija los criterios
--      de una evaluación YA enviada. Recalcula server-side (nunca confía en
--      un valor ya calculado), exige motivo, conserva el valor anterior en
--      comision_evaluaciones_correcciones, marca la fila 'corregida_admin'.
--      NUNCA recalcula sola la Nota Comisión general — eso requiere un paso
--      aparte y explícito (actualizar_notas_secundarias_con_auditoria /
--      resolver_revision_admin_comision_con_auditoria), nunca automático.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION corregir_evaluacion_individual_comision_con_auditoria(
    p_evaluacion_id UUID,
    p_nota_apinadero INTEGER,
    p_nota_cancha INTEGER,
    p_nota_atajadas INTEGER,
    p_nota_cuarta_carrera INTEGER,
    p_hubo_movimiento_rienda BOOLEAN,
    p_nota_rienda INTEGER,
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

    -- Orden de locks: rodeo primero, SIEMPRE (corrección posterior,
    -- Hallazgo 5) — antes esta función no tomaba ningún candado sobre
    -- `rodeos`, quedando sin serializar contra enviar_evaluacion/
    -- fn_recalcular_consolidacion_comision_rodeo para el mismo rodeo.
    PERFORM 1 FROM rodeos WHERE id = v_rodeo_id FOR UPDATE;

    SELECT * INTO v_anterior FROM comision_evaluaciones_jurado WHERE id = p_evaluacion_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'EVALUACION_NO_ENCONTRADA'; END IF;

    -- Hallazgo 1 (corrección posterior, CRÍTICO): una evaluación
    -- 'desvinculada_por_cambio_designacion' NUNCA puede "corregirse" de
    -- vuelta a vigente — eso reactivaría una evaluación histórica de UNA
    -- persona (ej. Jurado A) como si fuera de quien ocupa la asignación
    -- AHORA (ej. Jurado B), exactamente lo que el snapshot de identidad
    -- existe para impedir. Permanece desvinculada para siempre; su
    -- contenido histórico se conserva íntegro, solo ya no es "corregible"
    -- por esta vía (no existe ninguna vía que la reactive).
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

    -- Corrección posterior (ronda 3, punto 3): si el rodeo YA tiene una Nota
    -- Comisión general publicada/corregida y esta corrección individual
    -- cambió el valor, el promedio oficial queda DESACTUALIZADO respecto a
    -- las evaluaciones reales — se marca requiere_revision_admin (reutiliza
    -- la MISMA bandeja ya existente, nunca una nueva) para que quede visible
    -- y el administrador decida explícitamente si actualiza la nota general
    -- (resolver_revision_admin_comision_con_auditoria) — nunca se recalcula
    -- sola. fn_marcar_revision_admin_si_corresponde ya no hace nada si el
    -- rodeo no está publicado/corregido (consulta su propio estado).
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
    'Comisión de Asociación (079): único camino para corregir los criterios de una evaluación individual ya enviada (administrador pleno, motivo obligatorio). Recalcula server-side y deja historial completo. Nunca recalcula sola la Nota Comisión general del rodeo.';

-- ─────────────────────────────────────────────────────────────────────────
-- 10c) Autorización administrativa ESPECÍFICA para evaluar a un jurado
--      reemplazante (ronda 3, punto 4) — único camino para destrabar un
--      envío sobre un rodeo con Nota Comisión cerrada o en revisión, y SOLO
--      para la asignación exacta autorizada. Decisión 4 ya aprobada y
--      definitiva: "mantener" NUNCA reabre el portal — si se necesita
--      evaluar al reemplazante, esta es la única vía.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION autorizar_evaluacion_reemplazante_comision_con_auditoria(
    p_rodeo_id UUID,
    p_asignacion_id UUID,
    p_motivo TEXT,
    p_administrador_id UUID
) RETURNS UUID AS $$
DECLARE
    v_asignacion RECORD;
    v_autorizacion_id UUID;
BEGIN
    IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_OBLIGATORIO'; END IF;

    -- Orden de locks: rodeo primero, SIEMPRE (mismo criterio que el resto
    -- de las RPC de este módulo — corrección posterior, Hallazgo 5) — evita
    -- deadlock con enviar_evaluacion/corregir_evaluacion_individual/
    -- resolver_revision_admin, todas serializadas por el mismo candado.
    PERFORM 1 FROM rodeos WHERE id = p_rodeo_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'RODEO_NO_ENCONTRADO'; END IF;

    -- Consistencia referencial real (FK ya existente, nunca duplica el
    -- resolutor de catálogo/alias): la asignación debe pertenecer a ESTE
    -- rodeo. No valida asociación aquí — el administrador pleno opera sobre
    -- cualquier asociación por diseño (mismo criterio que el resto de este
    -- router administrativo); la asociación de la cuenta que luego USE esta
    -- autorización sigue verificándose en Express (rodeoDeMiAsociacion) y en
    -- la propia RPC de envío, sin excepción.
    --
    -- Hallazgo 2 (corrección posterior): se congela la identidad ACTUAL de
    -- la asignación (usuario_pagado_id + nombre resuelto) en el momento de
    -- otorgar — esta autorización servirá EXCLUSIVAMENTE para esa persona.
    SELECT a.usuario_pagado_id, COALESCE(up.nombre_completo, a.nombre_importado) AS nombre_resuelto
        INTO v_asignacion
        FROM asignaciones a
        LEFT JOIN usuarios_pagados up ON up.id = a.usuario_pagado_id
        WHERE a.id = p_asignacion_id AND a.rodeo_id = p_rodeo_id AND a.tipo_persona = 'jurado'
        FOR UPDATE OF a;
    IF NOT FOUND THEN RAISE EXCEPTION 'ASIGNACION_NO_ENCONTRADA'; END IF;

    -- Nunca coexisten dos autorizaciones "pendiente" para la misma
    -- asignación: otorgar una nueva invalida explícitamente cualquier
    -- pendiente anterior (preserva su historial, nunca la borra).
    UPDATE comision_autorizaciones_evaluacion
        SET estado = 'invalidada', invalidada_en = now(),
            invalidada_motivo = 'Reemplazada por una nueva autorización otorgada para la misma asignación.'
        WHERE rodeo_id = p_rodeo_id AND asignacion_id = p_asignacion_id AND estado = 'pendiente';

    INSERT INTO comision_autorizaciones_evaluacion (
        rodeo_id, asignacion_id, usuario_pagado_id_autorizado, nombre_autorizado_snapshot, motivo, administrador_id
    ) VALUES (
        p_rodeo_id, p_asignacion_id, v_asignacion.usuario_pagado_id, v_asignacion.nombre_resuelto, p_motivo, p_administrador_id
    )
    RETURNING id INTO v_autorizacion_id;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES ('comision_autorizaciones_evaluacion', v_autorizacion_id::text, 'autorizar',
        jsonb_build_object('rodeo_id', p_rodeo_id, 'asignacion_id', p_asignacion_id, 'autorizado_para', v_asignacion.nombre_resuelto),
        p_administrador_id::text, 'administrador',
        format('%s (autorizado para evaluar a: %s)', p_motivo, v_asignacion.nombre_resuelto));

    RETURN v_autorizacion_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION autorizar_evaluacion_reemplazante_comision_con_auditoria IS
    'Comisión de Asociación (079): autorización administrativa específica (rodeo+asignación) para destrabar UN envío sobre un rodeo con Nota Comisión cerrada o en revisión. Administrador pleno, motivo obligatorio. Nunca reabre el rodeo completo, nunca modifica evaluaciones existentes, nunca recalcula la nota general.';

-- ─────────────────────────────────────────────────────────────────────────
-- 11) Trigger de detección — cambio de nómina DESPUÉS de publicada/corregida
--     la Nota Comisión general. Cubre reemplazo, anulación y rechazo, sin
--     importar por qué endpoint administrativo ocurra el cambio (sección
--     17.2 del pedido: "no basta con revisar los datos cuando alguien abre
--     una pantalla"). Nunca bloquea la operación deportiva en sí — solo
--     marca para revisión.
-- ─────────────────────────────────────────────────────────────────────────
-- Designación efectiva de UNA fila (Hallazgo 8: NULL-segura).
CREATE OR REPLACE FUNCTION fn_designacion_vigente(p_tipo_persona TEXT, p_estado TEXT, p_publicado BOOLEAN, p_estado_designacion TEXT) RETURNS BOOLEAN AS $$
BEGIN
    RETURN p_tipo_persona = 'jurado' AND p_estado = 'activo' AND p_publicado IS TRUE
        AND COALESCE(p_estado_designacion, 'pendiente') <> 'rechazado';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Marca requiere_revision_admin SOLO si la Nota Comisión general del rodeo
-- ya estaba 'completa'/'corregida_admin' — un cambio de nómina ANTES de eso
-- es normal y nunca amerita advertencia. Función compartida por los 3
-- triggers (INSERT/UPDATE) para no duplicar este bloque.
CREATE OR REPLACE FUNCTION fn_marcar_revision_admin_si_corresponde(p_rodeo_id UUID, p_motivo TEXT) RETURNS VOID AS $$
DECLARE
    v_estado_nota TEXT;
BEGIN
    SELECT estado_nota_comision INTO v_estado_nota FROM rodeo_notas_secundarias WHERE rodeo_id = p_rodeo_id;
    IF v_estado_nota IN ('completa', 'corregida_admin') THEN
        UPDATE rodeo_notas_secundarias
            SET requiere_revision_admin = true, revision_admin_motivo = p_motivo, revision_admin_detectado_en = now()
            WHERE rodeo_id = p_rodeo_id;

        INSERT INTO auditoria (tabla, registro_id, accion, datos_nuevos, actor_id, actor_tipo, descripcion)
        VALUES ('rodeo_notas_secundarias', p_rodeo_id::text, 'requiere_revision_admin',
            jsonb_build_object('motivo', p_motivo), 'sistema', 'administrador', p_motivo);
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Trigger AFTER UPDATE — Hallazgos 4/5: ahora separa DOS efectos
-- independientes: (a) DESVINCULAR cualquier evaluación 'enviada' que ya no
-- representa a la designación vigente (identidad cambiada, o la asignación
-- dejó/empezó a estar vigente) — ocurre SIEMPRE, sea cual sea el estado de
-- la Nota Comisión general, porque es integridad de datos, no una decisión
-- deportiva; (b) marcar requiere_revision_admin — solo si la nota general
-- ya estaba cerrada. También cubre transiciones de vigencia en cualquier
-- dirección (antes solo miraba el cambio de identidad y dos transiciones
-- puntuales), nunca solo "cambió el id de la persona".
--
-- Verificación de concurrencia (ronda 5) — por qué este trigger NUNCA debe
-- bloquear `rodeos`, a diferencia del trigger AFTER INSERT de más abajo: un
-- UPDATE sobre `asignaciones` YA retiene el lock de esa fila existente
-- ANTES de que este trigger se dispare (lo toma la propia sentencia UPDATE
-- que lo origina — código ajeno en admin/asignaciones.js, nunca
-- modificado). Si este trigger intentara ADEMÁS bloquear `rodeos`, el orden
-- de adquisición de esa transacción sería {asignación, luego rodeos} —
-- exactamente el INVERSO del orden que usa cualquier función de este
-- módulo que ya bloquea `rodeos` primero y después, dentro de
-- fn_recalcular_consolidacion_comision_rodeo, TODAS las asignaciones de
-- jurado del rodeo. Dos transacciones tomando el mismo par de recursos en
-- órdenes opuestos es, por definición, un ciclo de deadlock — agregar el
-- lock acá CREARÍA el problema, no lo evitaría. La protección real para
-- UPDATE ya existe de forma nativa: el lock de fila de Postgres hace que
-- cualquier transacción que necesite esa MISMA fila espere, y al obtenerla
-- SIEMPRE re-lee su valor ya confirmado (nunca una instantánea vieja) — a
-- diferencia de un INSERT, donde no hay fila previa que bloquear.
CREATE OR REPLACE FUNCTION fn_detectar_cambio_designacion_post_evaluacion() RETURNS TRIGGER AS $$
DECLARE
    v_era_vigente BOOLEAN;
    v_es_vigente BOOLEAN;
    v_identidad_cambio BOOLEAN;
    v_eval RECORD;
BEGIN
    v_era_vigente := fn_designacion_vigente(OLD.tipo_persona, OLD.estado, OLD.publicado, OLD.estado_designacion);
    v_es_vigente := fn_designacion_vigente(NEW.tipo_persona, NEW.estado, NEW.publicado, NEW.estado_designacion);
    -- Hallazgo 4 (corrección posterior): además del cambio de
    -- usuario_pagado_id, cuenta como cambio de identidad que
    -- nombre_importado cambie MIENTRAS usuario_pagado_id se mantiene NULL
    -- en ambos lados — sin esto, reemplazar a una persona sin identidad
    -- estable por otra (ambas solo con nombre_importado) pasaba
    -- inadvertido. Cuando YA existe un usuario_pagado_id (identidad
    -- estable), un cambio de nombre_importado es puramente cosmético/
    -- vestigial y se ignora — igual criterio de "nunca marcar por
    -- comentarios o datos irrelevantes".
    v_identidad_cambio := (OLD.usuario_pagado_id IS DISTINCT FROM NEW.usuario_pagado_id)
        OR (OLD.usuario_pagado_id IS NULL AND NEW.usuario_pagado_id IS NULL
            AND OLD.nombre_importado IS DISTINCT FROM NEW.nombre_importado);

    IF NOT (v_identidad_cambio OR v_era_vigente <> v_es_vigente) THEN
        RETURN NEW; -- cambio irrelevante (ej. solo un comentario o un dato financiero)
    END IF;

    -- Hallazgo 2 (corrección posterior): cualquier autorización 'pendiente'
    -- para esta asignación queda invalidada de inmediato ante CUALQUIER
    -- cambio relevante (identidad o vigencia) — nunca debe quedar
    -- disponible para evaluar a alguien distinto de quien fue
    -- expresamente autorizado. Se ejecuta SIEMPRE, sin condicionar al
    -- estado de la nota general (es integridad de la propia autorización,
    -- no una decisión deportiva) y SIEMPRE antes de evaluar si hay algo que
    -- desvincular (son preocupaciones independientes).
    UPDATE comision_autorizaciones_evaluacion
        SET estado = 'invalidada', invalidada_en = now(),
            invalidada_motivo = format(
                'La designación de la asignación %s cambió antes de usar la autorización (usuario_pagado_id: %s -> %s).',
                NEW.id, OLD.usuario_pagado_id, NEW.usuario_pagado_id)
        WHERE asignacion_id = NEW.id AND estado = 'pendiente';

    -- (a) Desvincular — SIEMPRE, sin condicionar al estado de la nota
    -- general. Corrección posterior (ronda 3, punto 2): también reconoce
    -- 'corregida_admin' — una evaluación corregida administrativamente
    -- sigue siendo definitiva y, si la designación cambia después, debe
    -- desvincularse igual que una 'enviada' nunca corregida.
    SELECT * INTO v_eval FROM comision_evaluaciones_jurado
        WHERE asignacion_id = NEW.id AND estado IN ('enviada', 'corregida_admin') FOR UPDATE;
    IF FOUND THEN
        UPDATE comision_evaluaciones_jurado SET estado = 'desvinculada_por_cambio_designacion', updated_at = now()
            WHERE id = v_eval.id;

        INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion)
        VALUES ('comision_evaluaciones_jurado', v_eval.id::text, 'desvincular',
            jsonb_build_object('estado', v_eval.estado), jsonb_build_object('estado', 'desvinculada_por_cambio_designacion'),
            'sistema', 'administrador',
            format('Evaluación desvinculada: la asignación %s cambió (usuario_pagado_id %s -> %s, vigente %s -> %s).',
                NEW.id, OLD.usuario_pagado_id, NEW.usuario_pagado_id, v_era_vigente, v_es_vigente));

        -- Solo entonces, si la nota general ya estaba cerrada, se marca revisión.
        PERFORM fn_marcar_revision_admin_si_corresponde(NEW.rodeo_id, format(
            'Cambio en asignación %s después de publicada la Nota Comisión (usuario_pagado_id: %s -> %s, vigente: %s -> %s).',
            NEW.id, OLD.usuario_pagado_id, NEW.usuario_pagado_id, v_era_vigente, v_es_vigente));
    ELSE
        -- Hallazgo 4 (corrección posterior): no había evaluación que
        -- desvincular, pero SÍ cambió algo relevante (identidad y/o
        -- vigencia) — cubre uniformemente "se volvió vigente sin
        -- evaluación" (antes solo cubierto si NUNCA había sido vigente) Y
        -- "cambió de identidad siendo y siguiendo vigente, sin evaluación
        -- vinculada todavía" (antes no cubierto en absoluto). El helper
        -- solo actúa si la nota general ya está cerrada — nunca antes.
        PERFORM fn_marcar_revision_admin_si_corresponde(NEW.rodeo_id, format(
            'La asignación %s cambió (vigente %s -> %s, identidad cambiada: %s) sin evaluación previa vinculada, después de publicada la Nota Comisión.',
            NEW.id, v_era_vigente, v_es_vigente, v_identidad_cambio));
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger AFTER INSERT — Hallazgo 4: cubre el alta de un jurado vigente
-- NUEVO después de publicada la Nota Comisión general (nadie lo "reemplaza",
-- así que el UPDATE nunca lo vería) — la nómina crece sin que el nuevo
-- integrante tenga evaluación, así que el rodeo debe quedar en revisión.
--
-- Corrección posterior (ronda 5, verificación de concurrencia real — punto
-- 2 del pedido, "no asumir que SELECT...FOR UPDATE sobre filas existentes
-- impide nuevas filas"): CONFIRMADO — fn_recalcular_consolidacion_comision_
-- rodeo bloquea las asignaciones EXISTENTES de un rodeo, pero un candado
-- sobre filas existentes NUNCA puede bloquear una fila que todavía no
-- existe (no hay nada que bloquear). Sin esta corrección, una alta
-- concurrente con el envío que completa la nómina podía NO ser vista por
-- el conteo de esa consolidación (si el INSERT del admin todavía no había
-- confirmado cuando corrió el SELECT), publicando una Nota Comisión
-- 'completa' basada en una nómina desactualizada, SIN ninguna advertencia
-- (ninguno de los dos triggers detectaba nada: el admin veía la nota
-- todavía no 'completa', y la consolidación nunca volvía a mirar).
--
-- Corregido bloqueando `rodeos` como PRIMER paso de este trigger — fuerza
-- serialización real contra fn_recalcular_consolidacion_comision_rodeo
-- (que también bloquea `rodeos` primero, siempre) para el MISMO rodeo: en
-- cualquier orden de ejecución, una de las dos transacciones se completa
-- totalmente antes de que la otra continúe, así que o bien la alta ya está
-- committeada cuando se cuenta (nómina correcta, sigue 'parcial'), o bien
-- la nota ya está 'completa' cuando el alta se procesa (el propio chequeo
-- de abajo detecta eso y marca revisión). Nunca queda una tercera opción
-- silenciosa. Esto NO introduce un ciclo nuevo: a diferencia del trigger
-- AFTER UPDATE (que SÍ ya retiene el lock de la fila existente antes de
-- este punto, y por eso agregar un lock de `rodeos` ahí SÍ crearía un
-- ciclo — ver fn_detectar_cambio_designacion_post_evaluacion, deliberadamente
-- SIN este lock), un INSERT no retiene ningún recurso que otra transacción
-- pueda necesitar ANTES de intentar este lock — la fila nueva es invisible
-- para cualquier otra transacción hasta que esta confirme.
--
-- Corrección posterior (cierre final, riesgo de "lock upgrade" detectado):
-- el candado de arriba se pidió como FOR UPDATE, pero ESTA misma función
-- corre dentro de la transacción de un INSERT en `asignaciones`, y
-- `asignaciones.rodeo_id` tiene FOREIGN KEY REFERENCES rodeos(id) — Postgres
-- adquiere automáticamente un candado FOR KEY SHARE sobre la fila referenciada
-- de `rodeos` para validar esa FK, ANTES de que este trigger AFTER INSERT
-- llegue a ejecutarse. FOR KEY SHARE es compatible entre sí (dos INSERT
-- concurrentes para el mismo rodeo pueden tenerlo ambos a la vez), pero
-- CONFLICTA con FOR UPDATE. Con dos jurados insertados simultáneamente en el
-- mismo rodeo: la transacción A tiene FOR KEY SHARE (su propio FK) y pide
-- FOR UPDATE — bloquea esperando que B libere SU FOR KEY SHARE; la
-- transacción B, simétricamente, tiene FOR KEY SHARE y pide FOR UPDATE —
-- bloquea esperando que A libere EL SUYO. Ninguna de las dos puede avanzar:
-- deadlock real, no solo una espera. CONFIRMADO con la tabla de compatibilidad
-- de candados de fila de PostgreSQL (sección "Explicit Locking" del manual):
-- FOR KEY SHARE conflicta únicamente con FOR UPDATE y FOR NO KEY UPDATE...
-- salvo que FOR NO KEY UPDATE fue diseñado explícitamente para NO conflictuar
-- con FOR KEY SHARE (ese es su propósito declarado: permitir que un UPDATE/
-- lock sobre la fila padre avance sin pelear con los candados de verificación
-- de FK de las filas hijas). Corregido cambiando este candado a FOR NO KEY
-- UPDATE: sigue conflictuando con FOR UPDATE (preserva intacta la
-- serialización contra fn_recalcular_consolidacion_comision_rodeo y el resto
-- de funciones que bloquean `rodeos` con FOR UPDATE, descritas arriba) y
-- con otro FOR NO KEY UPDATE (dos altas concurrentes del mismo rodeo se
-- serializan entre sí, una espera a la otra, sin ciclo porque quien ya lo
-- obtuvo no necesita nada que la otra retenga), pero YA NO conflictúa con el
-- FOR KEY SHARE que el propio INSERT adquirió al validar su FK — rompe
-- exactamente el ciclo descrito sin debilitar ninguna de las garantías
-- anteriores.
CREATE OR REPLACE FUNCTION fn_detectar_alta_jurado_post_evaluacion() RETURNS TRIGGER AS $$
BEGIN
    PERFORM 1 FROM rodeos WHERE id = NEW.rodeo_id FOR NO KEY UPDATE;

    IF fn_designacion_vigente(NEW.tipo_persona, NEW.estado, NEW.publicado, NEW.estado_designacion) THEN
        PERFORM fn_marcar_revision_admin_si_corresponde(NEW.rodeo_id, format(
            'Nueva asignación vigente %s agregada después de publicada la Nota Comisión.', NEW.id));
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_detectar_cambio_designacion_post_evaluacion ON asignaciones;
CREATE TRIGGER trg_detectar_cambio_designacion_post_evaluacion
    AFTER UPDATE ON asignaciones
    FOR EACH ROW
    EXECUTE FUNCTION fn_detectar_cambio_designacion_post_evaluacion();

DROP TRIGGER IF EXISTS trg_detectar_alta_jurado_post_evaluacion ON asignaciones;
CREATE TRIGGER trg_detectar_alta_jurado_post_evaluacion
    AFTER INSERT ON asignaciones
    FOR EACH ROW
    EXECUTE FUNCTION fn_detectar_alta_jurado_post_evaluacion();

COMMENT ON TRIGGER trg_detectar_cambio_designacion_post_evaluacion ON asignaciones IS
    'Comisión de Asociación (079): desvincula (nunca borra) cualquier evaluación enviada cuya asignación cambió de identidad o de vigencia, SIEMPRE; además marca requiere_revision_admin si la Nota Comisión general ya estaba completa/corregida. Nunca bloquea la operación deportiva.';
COMMENT ON TRIGGER trg_detectar_alta_jurado_post_evaluacion ON asignaciones IS
    'Comisión de Asociación (079): un jurado vigente agregado DESPUÉS de publicada la Nota Comisión general marca requiere_revision_admin — la nómina creció sin su evaluación.';

-- ─────────────────────────────────────────────────────────────────────────
-- 12) Endurecimiento de privilegios — TODAS las funciones nuevas o con firma
--     cambiada de este módulo, desde el primer momento (mismo criterio que
--     071/073/077/078). Los triggers también se revocan de PUBLIC como
--     defensa en profundidad, aunque el motor de triggers no requiere GRANT
--     de EXECUTE para disparar la función.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION crear_cuenta_institucional_con_auditoria(UUID, TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION crear_asociacion_institucional_con_auditoria(TEXT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION registrar_evaluador_comision_con_auditoria(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION suspender_evaluador_comision_con_auditoria(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reactivar_evaluador_comision_con_auditoria(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fn_calcular_nota_individual_comision(INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fn_recalcular_consolidacion_comision_rodeo(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION enviar_evaluacion_comision_jurado_con_auditoria(UUID, UUID, UUID, UUID, UUID, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, INTEGER, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION actualizar_notas_secundarias_con_auditoria(UUID, BOOLEAN, NUMERIC, BOOLEAN, NUMERIC, BOOLEAN, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION resolver_revision_admin_comision_con_auditoria(UUID, TEXT, TEXT, NUMERIC, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION corregir_evaluacion_individual_comision_con_auditoria(UUID, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, INTEGER, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION autorizar_evaluacion_reemplazante_comision_con_auditoria(UUID, UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fn_designacion_vigente(TEXT, TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fn_marcar_revision_admin_si_corresponde(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fn_detectar_cambio_designacion_post_evaluacion() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fn_detectar_alta_jurado_post_evaluacion() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION crear_cuenta_institucional_con_auditoria(UUID, TEXT, TEXT, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION crear_asociacion_institucional_con_auditoria(TEXT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION registrar_evaluador_comision_con_auditoria(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION suspender_evaluador_comision_con_auditoria(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION reactivar_evaluador_comision_con_auditoria(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION fn_calcular_nota_individual_comision(INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION fn_recalcular_consolidacion_comision_rodeo(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION enviar_evaluacion_comision_jurado_con_auditoria(UUID, UUID, UUID, UUID, UUID, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, INTEGER, BOOLEAN, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION actualizar_notas_secundarias_con_auditoria(UUID, BOOLEAN, NUMERIC, BOOLEAN, NUMERIC, BOOLEAN, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION resolver_revision_admin_comision_con_auditoria(UUID, TEXT, TEXT, NUMERIC, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION corregir_evaluacion_individual_comision_con_auditoria(UUID, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, INTEGER, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION autorizar_evaluacion_reemplazante_comision_con_auditoria(UUID, UUID, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION fn_designacion_vigente(TEXT, TEXT, BOOLEAN, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION fn_marcar_revision_admin_si_corresponde(UUID, TEXT) TO service_role;

ALTER FUNCTION crear_cuenta_institucional_con_auditoria(UUID, TEXT, TEXT, UUID, TEXT) SET search_path = public, pg_temp;
ALTER FUNCTION crear_asociacion_institucional_con_auditoria(TEXT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT) SET search_path = public, pg_temp;
ALTER FUNCTION registrar_evaluador_comision_con_auditoria(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT) SET search_path = public, pg_temp;
ALTER FUNCTION suspender_evaluador_comision_con_auditoria(UUID, UUID, TEXT) SET search_path = public, pg_temp;
ALTER FUNCTION reactivar_evaluador_comision_con_auditoria(UUID, UUID) SET search_path = public, pg_temp;
ALTER FUNCTION fn_calcular_nota_individual_comision(INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, INTEGER) SET search_path = public, pg_temp;
ALTER FUNCTION fn_recalcular_consolidacion_comision_rodeo(UUID, UUID) SET search_path = public, pg_temp;
ALTER FUNCTION enviar_evaluacion_comision_jurado_con_auditoria(UUID, UUID, UUID, UUID, UUID, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, INTEGER, BOOLEAN, TEXT) SET search_path = public, pg_temp;
ALTER FUNCTION actualizar_notas_secundarias_con_auditoria(UUID, BOOLEAN, NUMERIC, BOOLEAN, NUMERIC, BOOLEAN, TEXT, UUID) SET search_path = public, pg_temp;
ALTER FUNCTION resolver_revision_admin_comision_con_auditoria(UUID, TEXT, TEXT, NUMERIC, UUID) SET search_path = public, pg_temp;
ALTER FUNCTION corregir_evaluacion_individual_comision_con_auditoria(UUID, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, INTEGER, TEXT, UUID) SET search_path = public, pg_temp;
ALTER FUNCTION autorizar_evaluacion_reemplazante_comision_con_auditoria(UUID, UUID, TEXT, UUID) SET search_path = public, pg_temp;
ALTER FUNCTION fn_designacion_vigente(TEXT, TEXT, BOOLEAN, TEXT) SET search_path = public, pg_temp;
ALTER FUNCTION fn_marcar_revision_admin_si_corresponde(UUID, TEXT) SET search_path = public, pg_temp;
ALTER FUNCTION fn_detectar_cambio_designacion_post_evaluacion() SET search_path = public, pg_temp;
ALTER FUNCTION fn_detectar_alta_jurado_post_evaluacion() SET search_path = public, pg_temp;

COMMIT;

-- Reversible:
--   BEGIN;
--   DROP TRIGGER IF EXISTS trg_detectar_alta_jurado_post_evaluacion ON asignaciones;
--   DROP TRIGGER IF EXISTS trg_detectar_cambio_designacion_post_evaluacion ON asignaciones;
--   DROP FUNCTION IF EXISTS fn_detectar_alta_jurado_post_evaluacion();
--   DROP FUNCTION IF EXISTS fn_detectar_cambio_designacion_post_evaluacion();
--   DROP FUNCTION IF EXISTS fn_marcar_revision_admin_si_corresponde(UUID, TEXT);
--   DROP FUNCTION IF EXISTS fn_designacion_vigente(TEXT, TEXT, BOOLEAN, TEXT);
--   DROP FUNCTION IF EXISTS autorizar_evaluacion_reemplazante_comision_con_auditoria(UUID, UUID, TEXT, UUID);
--   DROP FUNCTION IF EXISTS corregir_evaluacion_individual_comision_con_auditoria(UUID, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, INTEGER, TEXT, UUID);
--   DROP FUNCTION IF EXISTS resolver_revision_admin_comision_con_auditoria(UUID, TEXT, TEXT, NUMERIC, UUID);
--   DROP FUNCTION IF EXISTS actualizar_notas_secundarias_con_auditoria(UUID, BOOLEAN, NUMERIC, BOOLEAN, NUMERIC, BOOLEAN, TEXT, UUID);
--   DROP FUNCTION IF EXISTS enviar_evaluacion_comision_jurado_con_auditoria(UUID, UUID, UUID, UUID, UUID, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, INTEGER, BOOLEAN, TEXT);
--   DROP FUNCTION IF EXISTS fn_recalcular_consolidacion_comision_rodeo(UUID, UUID);
--   DROP FUNCTION IF EXISTS fn_calcular_nota_individual_comision(INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, INTEGER);
--   ALTER TABLE comision_autorizaciones_evaluacion DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE comision_evaluaciones_correcciones DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE comision_evaluaciones_jurado DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE evaluadores_comision DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS comision_autorizaciones_evaluacion;
--   DROP TABLE IF EXISTS comision_evaluaciones_correcciones;
--   DROP TABLE IF EXISTS comision_evaluaciones_jurado;
--   DROP TYPE IF EXISTS comision_evaluacion_jurado_publica;
--   ALTER TABLE rodeo_notas_secundarias DROP CONSTRAINT IF EXISTS chk_rns_estado_nota_comision;
--   ALTER TABLE rodeo_notas_secundarias DROP COLUMN IF EXISTS estado_nota_comision, DROP COLUMN IF EXISTS requiere_revision_admin, DROP COLUMN IF EXISTS revision_admin_motivo, DROP COLUMN IF EXISTS revision_admin_detectado_en, DROP COLUMN IF EXISTS revision_admin_resuelto_por, DROP COLUMN IF EXISTS revision_admin_resuelto_en;
--   DROP FUNCTION IF EXISTS reactivar_evaluador_comision_con_auditoria(UUID, UUID);
--   DROP FUNCTION IF EXISTS suspender_evaluador_comision_con_auditoria(UUID, UUID, TEXT);
--   DROP FUNCTION IF EXISTS registrar_evaluador_comision_con_auditoria(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT);
--   DROP TYPE IF EXISTS evaluador_comision_publico;
--   DROP TABLE IF EXISTS evaluadores_comision;
--   DROP FUNCTION IF EXISTS crear_asociacion_institucional_con_auditoria(TEXT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT);
--   DROP FUNCTION IF EXISTS crear_cuenta_institucional_con_auditoria(UUID, TEXT, TEXT, UUID, TEXT);
--   ALTER TABLE cuentas_institucionales DROP CONSTRAINT IF EXISTS uq_cuentas_institucionales_asociacion_rol;
--   ALTER TABLE cuentas_institucionales ADD CONSTRAINT uq_cuentas_institucionales_asociacion_id UNIQUE (asociacion_id);
--   ALTER TABLE cuentas_institucionales DROP CONSTRAINT IF EXISTS cuentas_institucionales_rol_institucional_check;
--   ALTER TABLE cuentas_institucionales ADD CONSTRAINT cuentas_institucionales_rol_institucional_check CHECK (rol_institucional = 'delegado_asociacion');
--   -- (el rollback de la restricción de rol solo es seguro si ninguna cuenta real usa 'comision_asociacion').
--   COMMIT;
