-- ═════════════════════════════════════════════════════════════════════════
-- 069_responsable_unico_institucional.sql
-- Fase 3.5 — "Cada rodeo tiene un único Delegado de Asociación responsable,
-- confirmado una sola vez; solo un reemplazo administrativo autorizado puede
-- cambiarlo, con motivo y trazabilidad completa."
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — pendiente de autorización.
-- Depende de 068 (rodeos_delegado_institucional).
--
-- ═════════════════════════════════════════════════════════════════════════
-- HALLAZGO CRÍTICO (auditoría previa a esta fase, sección 1 de las reglas
-- obligatorias): `auditoria.actor_tipo` tiene un CHECK que SOLO permite
-- ('administrador', 'usuario_pagado') — ver database/schema.sql. Desde la
-- Fase 3 en adelante, TODO el código institucional (institucional/cartilla.js,
-- institucional/rodeos.js) llama a auditoria.registrar({actor_tipo:
-- 'cuenta_institucional', ...}). Contra un Postgres real, CADA UNA de esas
-- inserciones habría sido rechazada por este CHECK (auditoria.registrar()
-- atrapa el error internamente y solo lo deja en consola — nunca interrumpe
-- el flujo principal, por eso nadie lo notó: la escritura de negocio
-- siempre "funcionaba", pero la auditoría institucional NUNCA se grababa).
-- Esto habría dejado el "Historial de Responsables" de esta misma Fase 3.5
-- permanentemente vacío para cuentas institucionales. Se corrige acá,
-- ampliando el CHECK de forma aditiva (nunca se quitan los valores
-- existentes, nunca se tocan filas ya auditadas).
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE auditoria DROP CONSTRAINT IF EXISTS auditoria_actor_tipo_check;
ALTER TABLE auditoria ADD CONSTRAINT auditoria_actor_tipo_check
    CHECK (actor_tipo IN ('administrador', 'usuario_pagado', 'cuenta_institucional'));

-- ─── Pieza 1: confirmación ÚNICA del responsable (Fase 3.5, sección 2) ─────
-- Reemplaza el UPSERT libre de la Fase 3.3/3.4 por una confirmación
-- atómica de "primera escritura gana": usa el MISMO índice único de 068
-- (UNIQUE(rodeo_id)) vía INSERT...ON CONFLICT DO NOTHING — si dos
-- confirmaciones llegan simultáneamente para el mismo rodeo, Postgres
-- serializa el conflicto sobre ese índice: UNA sola gana la inserción: la
-- otra ve 0 filas devueltas y, en este mismo llamado, lee el responsable
-- que ya quedó vigente — nunca hay dos responsables simultáneos, nunca se
-- sobrescribe silenciosamente al que ya ganó. El evento de auditoría
-- "confirmar_responsable_institucional" se graba DENTRO de la misma
-- transacción, y SOLO si esta llamada fue la que efectivamente creó la fila
-- (nunca se duplica el evento de confirmación en los llamados que solo
-- leen el responsable ya vigente).
CREATE OR REPLACE FUNCTION confirmar_delegado_institucional_rodeo(
    p_rodeo_id UUID,
    p_delegado_asociacion_id UUID,
    p_delegado_nombre TEXT,
    p_cuenta_institucional_id UUID
) RETURNS rodeos_delegado_institucional AS $$
DECLARE
    v_resultado rodeos_delegado_institucional;
BEGIN
    INSERT INTO rodeos_delegado_institucional (rodeo_id, delegado_asociacion_id, seleccionado_por_cuenta_institucional_id)
    VALUES (p_rodeo_id, p_delegado_asociacion_id, p_cuenta_institucional_id)
    ON CONFLICT (rodeo_id) DO NOTHING
    RETURNING * INTO v_resultado;

    IF v_resultado IS NOT NULL THEN
        INSERT INTO auditoria (tabla, registro_id, accion, datos_nuevos, actor_id, actor_tipo, descripcion)
        VALUES (
            'rodeos_delegado_institucional', v_resultado.id::text, 'confirmar_responsable_institucional',
            jsonb_build_object('rodeo_id', p_rodeo_id, 'delegado_asociacion_id', p_delegado_asociacion_id, 'delegado_nombre', p_delegado_nombre),
            p_cuenta_institucional_id::text, 'cuenta_institucional',
            format('Delegado de Asociación confirmado como responsable: %s', p_delegado_nombre)
        );
        RETURN v_resultado;
    END IF;

    -- Ya existía (otra llamada ganó la carrera, o ya estaba confirmado desde
    -- antes de este llamado) — se devuelve el responsable YA vigente, sin
    -- modificarlo ni auditar un evento nuevo (nada cambió por esta llamada).
    SELECT * INTO v_resultado FROM rodeos_delegado_institucional WHERE rodeo_id = p_rodeo_id;
    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION confirmar_delegado_institucional_rodeo IS
    'Fase 3.5: confirma de forma atómica (primera escritura gana) al Delegado de Asociación responsable de un rodeo. Nunca sobrescribe una confirmación ya vigente; el caller (JS) decide 200 vs 409 comparando el delegado solicitado contra el devuelto.';

-- ─── Pieza 2: reemplazo administrativo autorizado (Fase 3.5, sección 3) ────
-- Única vía para cambiar un responsable YA confirmado. Requiere motivo no
-- vacío y un administrador autenticado (verificado en la ruta, no acá).
-- Bloquea el reemplazo si la cartilla institucional ya está en un estado
-- terminal (enviada/reenviada/aprobada/cerrada) — requiere un procedimiento
-- específico NO definido todavía (ver informe de la Fase 3.5): esta función
-- se detiene ahí a propósito, en vez de improvisar una regla irreversible.
-- Nunca borra la fila anterior de rodeos_delegado_institucional (se
-- ACTUALIZA en el mismo registro — nunca se duplica); nunca crea una
-- segunda cartilla; el historial completo (quién era antes, quién es ahora,
-- motivo, administrador, fecha) queda en `auditoria`, nunca en esta tabla.
CREATE OR REPLACE FUNCTION reemplazar_delegado_institucional_rodeo(
    p_rodeo_id UUID,
    p_nuevo_delegado_asociacion_id UUID,
    p_nuevo_delegado_nombre TEXT,
    p_administrador_id UUID,
    p_motivo TEXT
) RETURNS rodeos_delegado_institucional AS $$
DECLARE
    v_anterior rodeos_delegado_institucional;
    v_cartilla cartillas_delegado;
    v_resultado rodeos_delegado_institucional;
BEGIN
    IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN
        RAISE EXCEPTION 'MOTIVO_REQUERIDO';
    END IF;

    SELECT * INTO v_anterior FROM rodeos_delegado_institucional WHERE rodeo_id = p_rodeo_id FOR UPDATE;
    IF v_anterior IS NULL THEN
        RAISE EXCEPTION 'SIN_DESIGNACION_PREVIA';
    END IF;

    SELECT * INTO v_cartilla FROM cartillas_delegado
        WHERE rodeo_id = p_rodeo_id AND delegado_asociacion_id IS NOT NULL
        FOR UPDATE;

    IF v_cartilla.id IS NOT NULL AND v_cartilla.estado IN ('enviada', 'reenviada', 'aprobada', 'cerrada') THEN
        RAISE EXCEPTION 'REEMPLAZO_REQUIERE_PROCEDIMIENTO_ESPECIAL';
    END IF;

    UPDATE rodeos_delegado_institucional
        SET delegado_asociacion_id = p_nuevo_delegado_asociacion_id, updated_at = now()
        WHERE rodeo_id = p_rodeo_id
        RETURNING * INTO v_resultado;

    IF v_cartilla.id IS NOT NULL THEN
        UPDATE cartillas_delegado
            SET delegado_asociacion_id = p_nuevo_delegado_asociacion_id,
                delegado_nombre = p_nuevo_delegado_nombre,
                version = version + 1,
                updated_at = now()
            WHERE id = v_cartilla.id;
    END IF;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES (
        'rodeos_delegado_institucional', v_resultado.id::text, 'reemplazar_responsable_institucional',
        jsonb_build_object('delegado_asociacion_id', v_anterior.delegado_asociacion_id),
        jsonb_build_object('delegado_asociacion_id', p_nuevo_delegado_asociacion_id, 'delegado_nombre', p_nuevo_delegado_nombre, 'motivo', p_motivo),
        p_administrador_id::text, 'administrador',
        format('Reemplazo de responsable autorizado — motivo: %s', p_motivo)
    );

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION reemplazar_delegado_institucional_rodeo IS
    'Fase 3.5: único camino para reemplazar un responsable institucional YA confirmado. Requiere motivo y actúa como administrador. Bloquea (REEMPLAZO_REQUIERE_PROCEDIMIENTO_ESPECIAL) si la cartilla ya está enviada/aprobada/cerrada — procedimiento para ese caso NO definido todavía, señalado explícitamente en el informe de la Fase 3.5.';

-- Reversible:
--   DROP FUNCTION IF EXISTS reemplazar_delegado_institucional_rodeo(UUID, UUID, TEXT, UUID, TEXT);
--   DROP FUNCTION IF EXISTS confirmar_delegado_institucional_rodeo(UUID, UUID, TEXT, UUID);
--   ALTER TABLE auditoria DROP CONSTRAINT IF EXISTS auditoria_actor_tipo_check;
--   ALTER TABLE auditoria ADD CONSTRAINT auditoria_actor_tipo_check CHECK (actor_tipo IN ('administrador', 'usuario_pagado'));
--   (el rollback del CHECK fallaría si ya existen filas 'cuenta_institucional' — intencional: no se revierte perdiendo datos)
