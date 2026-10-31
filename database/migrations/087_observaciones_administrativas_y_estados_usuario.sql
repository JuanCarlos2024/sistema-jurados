-- ═════════════════════════════════════════════════════════════════════════
-- 087_observaciones_administrativas_y_estados_usuario.sql
-- Ampliación de Hoja de Vida — Observaciones Administrativas, nuevos estados
-- (No certificado / En retiro) e historial de cambios de categoría.
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — preparada y probada localmente (PGlite) por
-- autorización explícita, acotada a "implementación local". NO ejecutar
-- sobre Supabase sin autorización separada.
--
-- Verificado contra el esquema REAL de producción (jurados_2026, solo
-- lectura, sin modificar nada):
--   - usuarios_pagados.estado_usuario: CHECK IN ('activo','inactivo','receso','suspendido').
--   - usuario_historial_cambios.tipo_cambio: CHECK IN ('estado','categoria','suspension').
--   - administradores.rol_evaluacion: CHECK IN ('analista','comision_tecnica',
--     'jefe_area','monitor','director','capacitador') — 'jefe_area' = "Jefe
--     Área Deportiva" (el "Jefe Deportivo" del requerimiento — mismo rol que
--     ya usan evaluaciones.js/configuracion.html), 1 administrador real con
--     ese rol hoy. null = admin pleno.
--   - 89 jurados / 24 delegados activos en usuarios_pagados.
--   - Hallazgo 1 (revisión de integridad previa a 087): EXACTAMENTE 1 jurado
--     real con estado_usuario='suspendido' AND activo=true (suspensión
--     vigente del 2026-10-26 al 2026-11-15) — causado por un defecto del
--     código ANTERIOR a esta migración: el PATCH /:id/suspender original
--     nunca escribía `activo`, solo `estado_usuario` (a diferencia de
--     PATCH /:id/estado, que sí sincronizaba ambos). El motor de
--     designaciones filtra únicamente por `activo = true` — ese jurado SÍ
--     podía ser propuesto mientras su suspensión seguía vigente. Las 89
--     filas restantes (activo/inactivo/receso) están todas coherentes. Ver
--     sección E más abajo.
--   - Hallazgo 2 (revisión de integridad previa a 087): usuarios_pagados
--     tiene RLS deshabilitado y los roles anon/authenticated de PostgREST
--     tienen SELECT/INSERT/UPDATE/DELETE completos sobre ella — mismo
--     patrón de ALTER DEFAULT PRIVILEGES ya documentado en 085, aquí sobre
--     una tabla EXISTENTE (no nueva). Confirmado por inspección de todo el
--     frontend: no existe NINGÚN uso de supabase-js ni de la anon key en
--     ningún archivo del proyecto — el único consumidor real es el backend
--     Express, que siempre usa la service_role key (ver INSTRUCCIONES.md,
--     "Nunca use la anon key en el backend"). anon/authenticated no tienen
--     ningún consumidor legítimo sobre esta tabla. Mismo patrón expuesto
--     también en administradores/rodeos/asignaciones/bonos_solicitados/
--     disponibilidad_usuarios — fuera del alcance autorizado de esta
--     revisión (acotada a usuarios_pagados); queda señalado como riesgo
--     residual para una revisión de seguridad dedicada. Ver sección F.
--
-- DECISIÓN DE DISEÑO — "No certificado" y "En retiro" como columnas
-- INDEPENDIENTES, nunca como valores adicionales de estado_usuario: el
-- pedido exige explícitamente soportar condiciones SIMULTÁNEAS (ej. un
-- jurado suspendido temporalmente que ADEMÁS está no certificado) sin que
-- una se sobrescriba con la otra. estado_usuario es, por diseño ya
-- existente, un valor ÚNICO y mutuamente excluyente (activo|inactivo|
-- receso|suspendido) — forzar "no_certificado"/"en_retiro" dentro de ese
-- mismo campo haría literalmente imposible representar dos condiciones a
-- la vez. En cambio, se agregan dos pares de columnas booleanas+motivo+
-- fecha, independientes de estado_usuario, que se COMBINAN para calcular
-- el único campo que el motor de designaciones ya lee hoy (`activo`):
--     activo_efectivo = (estado_usuario = 'activo') AND NOT no_certificado AND NOT en_retiro
-- Esto significa CERO cambios en motorPropuestaDesignacion.js/
-- motorPropuestaDesignacionGlobal.js — ambos ya filtran exclusivamente por
-- `usuarios_pagados.activo = true`; la combinación de condiciones ocurre
-- enteramente en las RPC de esta migración, nunca en el motor.
--
-- ALCANCE:
--   A. usuarios_pagados — 6 columnas aditivas (no_certificado + motivo +
--      desde; en_retiro + motivo + desde).
--   B. usuario_historial_cambios — amplía el CHECK de tipo_cambio (agrega
--      'no_certificado','en_retiro'; 'categoria' y 'estado' ya existían) y
--      agrega 1 columna aditiva (fecha_efectiva) — Fase 4: "fecha efectiva
--      del cambio" de categoría, distinta de cambiado_en ("fecha y hora del
--      registro"). NULL para todo historial anterior a esta migración
--      (nunca se inventa una fecha efectiva retroactiva para datos ya
--      existentes sin ese dato).
--   C. usuario_observaciones_administrativas — tabla NUEVA, append-only
--      (sin UPDATE/DELETE en el código de aplicación): Observaciones
--      Administrativas de la Hoja de Vida. Vinculada al usuario_pagado_id
--      real, nunca solo al nombre.
--   D. 4 funciones RPC — reemplazan el patrón "UPDATE usuarios_pagados +
--      INSERT usuario_historial_cambios" en DOS llamadas separadas sin
--      transacción que ya usaba el código existente (defecto real detectado
--      en esta revisión: un error en el INSERT, después de que el UPDATE ya
--      se confirmó, deja la categoría/estado cambiados SIN su registro
--      histórico correspondiente — exactamente lo que el pedido pide
--      impedir). Cada función hace ambas escrituras en UNA sola transacción
--      de Postgres — mismo patrón ya establecido en 083/084/086 de este
--      proyecto para el mismo problema.
--        - cambiar_estado_usuario_con_historial(...)
--        - suspender_usuario_con_historial(...)
--        - cambiar_categoria_usuario_con_historial(...) — bloquea cambiar
--          hacia la MISMA categoría; registra fecha_efectiva.
--        - marcar_condicion_bloqueante_usuario(...) — No certificado / En
--          retiro, activar o revertir, siempre con motivo y trazabilidad.
--   E. Reconciliación de coherencia — corrige `activo` SOLO para la fila
--      (o filas) donde estado_usuario='suspendido' AND activo=true, usando
--      exclusivamente datos YA escritos en usuarios_pagados (nunca inventa
--      nada). NUNCA toca usuario_historial_cambios — el registro histórico
--      ya existente permanece intacto, tal cual se escribió.
--   F. Permisos — revoca anon/authenticated sobre usuarios_pagados (tabla
--      EXISTENTE, nunca se tocan los privilegios de service_role, que el
--      backend sigue necesitando sin cambios) y aprieta el GRANT de la
--      sección C a SELECT/INSERT solamente (antes quedaba en GRANT ALL por
--      error — ver Hallazgo 2 e Hallazgo de la sección C).
--
-- Nunca modifica rodeos, asignaciones, pagos, notas_rodeo, evaluaciones,
-- cartillas ni bonos. Nunca recalcula nada histórico. No toca el motor de
-- designaciones ni sus archivos.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- A) Condiciones bloqueantes independientes del ciclo de vida (estado_usuario)
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE usuarios_pagados
    ADD COLUMN IF NOT EXISTS no_certificado         BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS no_certificado_motivo   TEXT,
    ADD COLUMN IF NOT EXISTS no_certificado_desde    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS en_retiro               BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS en_retiro_motivo         TEXT,
    ADD COLUMN IF NOT EXISTS en_retiro_desde          TIMESTAMPTZ;

COMMENT ON COLUMN usuarios_pagados.no_certificado IS
    'Ampliación Hoja de Vida: condición bloqueante INDEPENDIENTE de estado_usuario — puede coexistir con una suspensión o un receso. Mientras sea TRUE, usuarios_pagados.activo nunca puede quedar en TRUE (ver marcar_condicion_bloqueante_usuario / cambiar_estado_usuario_con_historial).';
COMMENT ON COLUMN usuarios_pagados.en_retiro IS
    'Ampliación Hoja de Vida: condición bloqueante INDEPENDIENTE de estado_usuario, mismo criterio que no_certificado.';

-- ─────────────────────────────────────────────────────────────────────────
-- B) Historial de cambios — amplía tipos y agrega fecha_efectiva (Fase 4)
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE usuario_historial_cambios DROP CONSTRAINT IF EXISTS usuario_historial_cambios_tipo_cambio_check;
ALTER TABLE usuario_historial_cambios ADD CONSTRAINT usuario_historial_cambios_tipo_cambio_check
    CHECK (tipo_cambio IN ('estado', 'categoria', 'suspension', 'no_certificado', 'en_retiro'));

ALTER TABLE usuario_historial_cambios
    ADD COLUMN IF NOT EXISTS fecha_efectiva DATE;

COMMENT ON COLUMN usuario_historial_cambios.fecha_efectiva IS
    'Fase 4 (cambio de categoría): fecha en que el cambio opera realmente, DISTINTA de cambiado_en (momento del registro en el sistema). NULL para historial anterior a esta migración y para tipo_cambio distinto de "categoria" — nunca se inventa retroactivamente.';

-- ─────────────────────────────────────────────────────────────────────────
-- C) Observaciones Administrativas — append-only, vinculada al usuario real
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usuario_observaciones_administrativas (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_pagado_id UUID        NOT NULL REFERENCES usuarios_pagados(id) ON DELETE CASCADE,
    contenido         TEXT        NOT NULL CHECK (btrim(contenido) <> ''),
    creado_por        UUID        NOT NULL REFERENCES administradores(id),
    creado_por_nombre TEXT        NOT NULL,
    creado_en         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_uoa_usuario_pagado_id ON usuario_observaciones_administrativas(usuario_pagado_id);
CREATE INDEX IF NOT EXISTS idx_uoa_creado_en          ON usuario_observaciones_administrativas(creado_en DESC);

COMMENT ON TABLE usuario_observaciones_administrativas IS
    'Fase 2 — Observaciones Administrativas de la Hoja de Vida. Append-only a nivel de BASE DE DATOS (no solo porque la aplicación no expone UPDATE/DELETE): service_role solo tiene SELECT/INSERT otorgado explícitamente — ni siquiera el propio backend puede modificar o borrar una observación ya escrita, aunque algún código futuro lo intentara. Vinculada a usuario_pagado_id (identificador real), nunca solo al nombre.';

-- Corrección de seguridad (revisión de integridad previa a 087): el proyecto
-- tiene ALTER DEFAULT PRIVILEGES a nivel de esquema que otorga privilegios
-- de tabla completos a anon/authenticated/service_role en todo objeto NUEVO
-- de forma automática (mismo hallazgo ya documentado en 085) — por eso se
-- revoca TODO primero, de las tres, antes de otorgar explícitamente solo lo
-- mínimo a service_role. GRANT ALL habría dejado UPDATE/DELETE disponibles
-- para service_role — append-only real exige no otorgarlos nunca, ni
-- siquiera al propio backend.
REVOKE ALL ON TABLE usuario_observaciones_administrativas FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE usuario_observaciones_administrativas TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- E) Reconciliación de coherencia (Hallazgo 1) — corrige ÚNICAMENTE las
--    filas donde estado_usuario='suspendido' AND activo=true, causadas por
--    el defecto del PATCH /:id/suspender anterior a esta migración (nunca
--    escribía `activo`). Acotado por WHERE a filas VERIFICABLEMENTE
--    inconsistentes con sus propios datos ya existentes — nunca se inventa
--    ni se asume nada nuevo, y usuario_historial_cambios NUNCA se toca
--    (el registro histórico ya escrito permanece exactamente igual).
--    A partir de esta migración, suspender_usuario_con_historial (sección D)
--    siempre sincroniza `activo`, por lo que esta inconsistencia no puede
--    volver a producirse por esa vía.
-- ─────────────────────────────────────────────────────────────────────────
UPDATE usuarios_pagados SET activo = false, updated_at = now()
WHERE estado_usuario = 'suspendido' AND activo = true;

-- ─────────────────────────────────────────────────────────────────────────
-- F) Permisos (Hallazgo 2) — usuarios_pagados es una tabla EXISTENTE (no
--    creada por esta migración): revoca únicamente anon/authenticated
--    (confirmado sin ningún consumidor legítimo — ver Hallazgo 2 más
--    arriba), preservando intactos los privilegios de service_role, que el
--    backend sigue necesitando exactamente como hoy (no se emite ningún
--    GRANT nuevo para service_role aquí — lo que ya tenía, lo conserva).
--    Nunca se activa RLS (requeriría auditar políticas para cada
--    consumidor existente — fuera del alcance autorizado de esta revisión)
--    y nunca se tocan permisos de ninguna otra tabla.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON TABLE usuarios_pagados FROM anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- D) RPC — cada una hace "actualizar usuarios_pagados + insertar historial"
--    en UNA sola transacción. Si el INSERT del historial falla, Postgres
--    revierte también el UPDATE — nunca queda un cambio sin su registro.
-- ─────────────────────────────────────────────────────────────────────────

-- D.1 — Activo / Inactivo / Receso (reemplaza el PATCH /:id/estado actual).
-- Bloquea pasar a 'activo' mientras no_certificado o en_retiro sigan en
-- TRUE — revertir esas condiciones es una acción EXPLÍCITA y separada
-- (marcar_condicion_bloqueante_usuario), nunca algo que un cambio de
-- estado "activo" pueda sobrescribir implícitamente (Fase 3: "no permitir
-- que una condición sobrescriba otra de manera incorrecta").
CREATE OR REPLACE FUNCTION cambiar_estado_usuario_con_historial(
    p_usuario_id UUID,
    p_estado_nuevo TEXT,
    p_actor_id UUID,
    p_actor_nombre TEXT,
    p_observacion TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_usuario       usuarios_pagados%ROWTYPE;
    v_estado_anterior TEXT;
    v_activo_nuevo  BOOLEAN;
    v_update        usuarios_pagados%ROWTYPE;
BEGIN
    IF p_actor_id IS NULL THEN RAISE EXCEPTION 'ACTOR_REQUERIDO'; END IF;
    IF p_estado_nuevo NOT IN ('activo', 'inactivo', 'receso') THEN
        RAISE EXCEPTION 'ESTADO_INVALIDO: %', p_estado_nuevo;
    END IF;

    SELECT * INTO v_usuario FROM usuarios_pagados WHERE id = p_usuario_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'USUARIO_NO_ENCONTRADO'; END IF;

    IF p_estado_nuevo = 'activo' AND (v_usuario.no_certificado OR v_usuario.en_retiro) THEN
        RAISE EXCEPTION 'CONDICION_BLOQUEANTE_VIGENTE: no se puede activar — revierta primero No certificado / En retiro';
    END IF;

    v_estado_anterior := COALESCE(v_usuario.estado_usuario, CASE WHEN v_usuario.activo THEN 'activo' ELSE 'inactivo' END);
    v_activo_nuevo := (p_estado_nuevo = 'activo') AND NOT v_usuario.no_certificado AND NOT v_usuario.en_retiro;

    UPDATE usuarios_pagados SET
        estado_usuario = p_estado_nuevo,
        activo = v_activo_nuevo,
        -- Al reactivar desde una suspensión, limpiar sus campos — mismo
        -- comportamiento que ya tenía el endpoint anterior.
        suspension_desde  = CASE WHEN p_estado_nuevo = 'activo' AND v_estado_anterior = 'suspendido' THEN NULL ELSE suspension_desde END,
        suspension_hasta  = CASE WHEN p_estado_nuevo = 'activo' AND v_estado_anterior = 'suspendido' THEN NULL ELSE suspension_hasta END,
        suspension_motivo = CASE WHEN p_estado_nuevo = 'activo' AND v_estado_anterior = 'suspendido' THEN NULL ELSE suspension_motivo END,
        updated_at = now()
    WHERE id = p_usuario_id
    RETURNING * INTO v_update;

    INSERT INTO usuario_historial_cambios (usuario_pagado_id, tipo_cambio, valor_anterior, valor_nuevo, cambiado_por, cambiado_por_nombre, observacion)
    VALUES (p_usuario_id, 'estado', v_estado_anterior, p_estado_nuevo, p_actor_id, p_actor_nombre, p_observacion);

    RETURN jsonb_build_object('usuario', row_to_json(v_update), 'estado_anterior', v_estado_anterior);
END;
$$;

REVOKE ALL ON FUNCTION cambiar_estado_usuario_con_historial(UUID, TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION cambiar_estado_usuario_con_historial(UUID, TEXT, UUID, TEXT, TEXT) TO service_role;

-- D.2 — Suspensión temporal (reemplaza el PATCH /:id/suspender actual).
CREATE OR REPLACE FUNCTION suspender_usuario_con_historial(
    p_usuario_id UUID,
    p_fecha_desde DATE,
    p_fecha_hasta DATE,
    p_motivo TEXT,
    p_actor_id UUID,
    p_actor_nombre TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_usuario usuarios_pagados%ROWTYPE;
    v_estado_anterior TEXT;
    v_update  usuarios_pagados%ROWTYPE;
BEGIN
    IF p_actor_id IS NULL THEN RAISE EXCEPTION 'ACTOR_REQUERIDO'; END IF;
    IF p_fecha_desde IS NULL OR p_fecha_hasta IS NULL THEN RAISE EXCEPTION 'FECHAS_REQUERIDAS'; END IF;
    IF p_fecha_hasta < p_fecha_desde THEN RAISE EXCEPTION 'RANGO_FECHA_INVALIDO'; END IF;
    IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_REQUERIDO'; END IF;

    SELECT * INTO v_usuario FROM usuarios_pagados WHERE id = p_usuario_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'USUARIO_NO_ENCONTRADO'; END IF;

    v_estado_anterior := COALESCE(v_usuario.estado_usuario, CASE WHEN v_usuario.activo THEN 'activo' ELSE 'inactivo' END);

    UPDATE usuarios_pagados SET
        estado_usuario = 'suspendido',
        activo = false,
        suspension_desde = p_fecha_desde, suspension_hasta = p_fecha_hasta, suspension_motivo = btrim(p_motivo),
        updated_at = now()
    WHERE id = p_usuario_id
    RETURNING * INTO v_update;

    INSERT INTO usuario_historial_cambios (usuario_pagado_id, tipo_cambio, valor_anterior, valor_nuevo, fecha_desde, fecha_hasta, cambiado_por, cambiado_por_nombre, observacion)
    VALUES (p_usuario_id, 'suspension', v_estado_anterior, 'suspendido', p_fecha_desde, p_fecha_hasta, p_actor_id, p_actor_nombre, btrim(p_motivo));

    RETURN jsonb_build_object('usuario', row_to_json(v_update), 'estado_anterior', v_estado_anterior);
END;
$$;

REVOKE ALL ON FUNCTION suspender_usuario_con_historial(UUID, DATE, DATE, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION suspender_usuario_con_historial(UUID, DATE, DATE, TEXT, UUID, TEXT) TO service_role;

-- D.3 — Cambio de categoría (amplía el PATCH /:id/categoria actual).
-- Bloquea un cambio hacia la MISMA categoría (Fase 4). p_fecha_efectiva es
-- opcional — si no se indica, se usa la fecha de hoy (nunca se deja NULL
-- para un cambio nuevo; NULL queda reservado para el historial anterior a
-- esta migración, que nunca se completa retroactivamente).
CREATE OR REPLACE FUNCTION cambiar_categoria_usuario_con_historial(
    p_usuario_id UUID,
    p_categoria_nueva TEXT,
    p_actor_id UUID,
    p_actor_nombre TEXT,
    p_justificacion TEXT DEFAULT NULL,
    p_fecha_efectiva DATE DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_usuario usuarios_pagados%ROWTYPE;
    v_update  usuarios_pagados%ROWTYPE;
BEGIN
    IF p_actor_id IS NULL THEN RAISE EXCEPTION 'ACTOR_REQUERIDO'; END IF;
    IF p_categoria_nueva NOT IN ('A', 'B', 'C') THEN RAISE EXCEPTION 'CATEGORIA_INVALIDA: %', p_categoria_nueva; END IF;

    SELECT * INTO v_usuario FROM usuarios_pagados WHERE id = p_usuario_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'USUARIO_NO_ENCONTRADO'; END IF;
    IF v_usuario.tipo_persona <> 'jurado' THEN RAISE EXCEPTION 'SOLO_JURADOS_TIENEN_CATEGORIA'; END IF;
    IF v_usuario.categoria = p_categoria_nueva THEN RAISE EXCEPTION 'MISMA_CATEGORIA: el usuario ya está en categoría %', p_categoria_nueva; END IF;

    UPDATE usuarios_pagados SET categoria = p_categoria_nueva, updated_at = now()
    WHERE id = p_usuario_id
    RETURNING * INTO v_update;

    INSERT INTO usuario_historial_cambios (usuario_pagado_id, tipo_cambio, valor_anterior, valor_nuevo, fecha_efectiva, cambiado_por, cambiado_por_nombre, observacion)
    VALUES (p_usuario_id, 'categoria', v_usuario.categoria, p_categoria_nueva, COALESCE(p_fecha_efectiva, CURRENT_DATE), p_actor_id, p_actor_nombre, p_justificacion);

    RETURN jsonb_build_object('usuario', row_to_json(v_update), 'categoria_anterior', v_usuario.categoria);
END;
$$;

REVOKE ALL ON FUNCTION cambiar_categoria_usuario_con_historial(UUID, TEXT, UUID, TEXT, TEXT, DATE) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION cambiar_categoria_usuario_con_historial(UUID, TEXT, UUID, TEXT, TEXT, DATE) TO service_role;

-- D.4 — No certificado / En retiro: activar o revertir, con motivo y
-- trazabilidad. Nunca toca estado_usuario (Fase 3: condiciones
-- independientes) — solo recalcula `activo` combinando las tres señales.
CREATE OR REPLACE FUNCTION marcar_condicion_bloqueante_usuario(
    p_usuario_id UUID,
    p_tipo_condicion TEXT,   -- 'no_certificado' | 'en_retiro'
    p_activar BOOLEAN,
    p_motivo TEXT,
    p_actor_id UUID,
    p_actor_nombre TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_usuario usuarios_pagados%ROWTYPE;
    v_update  usuarios_pagados%ROWTYPE;
    v_activo_nuevo BOOLEAN;
    v_valor_anterior TEXT;
    v_no_cert BOOLEAN;
    v_en_ret  BOOLEAN;
BEGIN
    IF p_actor_id IS NULL THEN RAISE EXCEPTION 'ACTOR_REQUERIDO'; END IF;
    IF p_tipo_condicion NOT IN ('no_certificado', 'en_retiro') THEN
        RAISE EXCEPTION 'TIPO_CONDICION_INVALIDO: %', p_tipo_condicion;
    END IF;
    IF p_activar AND (p_motivo IS NULL OR btrim(p_motivo) = '') THEN
        RAISE EXCEPTION 'MOTIVO_REQUERIDO';
    END IF;

    SELECT * INTO v_usuario FROM usuarios_pagados WHERE id = p_usuario_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'USUARIO_NO_ENCONTRADO'; END IF;

    IF p_tipo_condicion = 'no_certificado' THEN
        v_valor_anterior := v_usuario.no_certificado::TEXT;
        v_no_cert := p_activar;
        v_en_ret  := v_usuario.en_retiro;
        UPDATE usuarios_pagados SET
            no_certificado = p_activar,
            no_certificado_motivo = CASE WHEN p_activar THEN btrim(p_motivo) ELSE no_certificado_motivo END,
            no_certificado_desde  = CASE WHEN p_activar THEN now() ELSE no_certificado_desde END,
            updated_at = now()
        WHERE id = p_usuario_id RETURNING * INTO v_update;
    ELSE
        v_valor_anterior := v_usuario.en_retiro::TEXT;
        v_no_cert := v_usuario.no_certificado;
        v_en_ret  := p_activar;
        UPDATE usuarios_pagados SET
            en_retiro = p_activar,
            en_retiro_motivo = CASE WHEN p_activar THEN btrim(p_motivo) ELSE en_retiro_motivo END,
            en_retiro_desde  = CASE WHEN p_activar THEN now() ELSE en_retiro_desde END,
            updated_at = now()
        WHERE id = p_usuario_id RETURNING * INTO v_update;
    END IF;

    -- Recalcula `activo` combinando las tres señales — nunca activa de
    -- vuelta solo porque esta condición se revirtió, si la OTRA condición
    -- o el ciclo de vida (estado_usuario) siguen bloqueando.
    v_activo_nuevo := (COALESCE(v_update.estado_usuario, 'inactivo') = 'activo') AND NOT v_no_cert AND NOT v_en_ret;
    UPDATE usuarios_pagados SET activo = v_activo_nuevo WHERE id = p_usuario_id RETURNING * INTO v_update;

    INSERT INTO usuario_historial_cambios (usuario_pagado_id, tipo_cambio, valor_anterior, valor_nuevo, cambiado_por, cambiado_por_nombre, observacion)
    VALUES (p_usuario_id, p_tipo_condicion, v_valor_anterior, p_activar::TEXT, p_actor_id, p_actor_nombre, p_motivo);

    RETURN jsonb_build_object('usuario', row_to_json(v_update));
END;
$$;

REVOKE ALL ON FUNCTION marcar_condicion_bloqueante_usuario(UUID, TEXT, BOOLEAN, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION marcar_condicion_bloqueante_usuario(UUID, TEXT, BOOLEAN, TEXT, UUID, TEXT) TO service_role;

COMMIT;

-- Reversible:
--   DROP FUNCTION IF EXISTS marcar_condicion_bloqueante_usuario(UUID, TEXT, BOOLEAN, TEXT, UUID, TEXT);
--   DROP FUNCTION IF EXISTS cambiar_categoria_usuario_con_historial(UUID, TEXT, UUID, TEXT, TEXT, DATE);
--   DROP FUNCTION IF EXISTS suspender_usuario_con_historial(UUID, DATE, DATE, TEXT, UUID, TEXT);
--   DROP FUNCTION IF EXISTS cambiar_estado_usuario_con_historial(UUID, TEXT, UUID, TEXT, TEXT);
--   DROP TABLE IF EXISTS usuario_observaciones_administrativas;
--   ALTER TABLE usuario_historial_cambios DROP COLUMN IF EXISTS fecha_efectiva;
--   (el rollback del CHECK de tipo_cambio y de las columnas de usuarios_pagados
--    fallaría si ya existen filas con 'no_certificado'/'en_retiro' o con esas
--    columnas en TRUE — intencional: no se revierte perdiendo estado real)
--
-- Secciones E y F NO son reversibles por diseño, ni deberían revertirse:
--   - E (reconciliación de `activo`) corrige un dato que estaba mal — un
--     rollback que lo devolviera a activo=true reintroduciría a sabiendas
--     el defecto de seguridad original (un suspendido disponible para el
--     motor).
--   - F (REVOKE anon/authenticated sobre usuarios_pagados) cierra un acceso
--     que nunca debió existir — revertirlo (volver a otorgarlo) reabriría
--     esa misma exposición.
