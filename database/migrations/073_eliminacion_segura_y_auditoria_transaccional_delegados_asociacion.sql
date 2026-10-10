-- ═════════════════════════════════════════════════════════════════════════
-- 073_eliminacion_segura_y_auditoria_transaccional_delegados_asociacion.sql
-- Verificación previa a publicación del módulo administrativo de Delegados
-- de Asociación: cierra dos riesgos reales encontrados en revisión.
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — pendiente de autorización.
-- ANTES de aplicar: ejecutar database/verificaciones_fase073_solo_lectura.sql
-- en el SQL Editor y confirmar el nombre real de la FK de la consulta 1 (ver
-- Pieza 1 más abajo si el nombre real difiere del asumido).
-- Depende de 062/064 (delegados_asociacion), 065 (la FK que se corrige), 068
-- (rodeos_delegado_institucional), 069/070 (precedente del mismo patrón).
--
-- ═════════════════════════════════════════════════════════════════════════
-- RIESGO 1 — eliminación insegura por condición de carrera real:
-- `DELETE /api/admin/delegados-asociacion/:id` (código Node) verificaba
-- referencias en cartillas_delegado/rodeos_delegado_institucional y LUEGO,
-- en una llamada HTTP/Supabase SEPARADA, ejecutaba el DELETE. Entre esas dos
-- llamadas no hay ninguna transacción compartida: una cartilla institucional
-- podía crearse (vía crear_o_adjuntar_cartilla_institucional) justo en ese
-- intervalo. Como `cartillas_delegado.delegado_asociacion_id` tiene
-- ON DELETE SET NULL (migración 065), el DELETE de todos modos habría
-- tenido éxito y esa cartilla recién creada habría perdido silenciosamente
-- la identificación de su responsable — exactamente el efecto que el
-- comentario de la propia 065 dice evitar.
--
-- CORRECCIÓN (dos capas, igual criterio de "defensa en profundidad" que
-- 071 — RLS + REVOKE/GRANT como capas independientes):
--   1a. La FK pasa de ON DELETE SET NULL a ON DELETE RESTRICT: ahora es
--       IMPOSIBLE a nivel de base de datos borrar un delegado que tenga
--       cualquier cartilla asociada, sin importar cuándo se haya creado esa
--       cartilla relativo a cualquier chequeo de aplicación.
--   1b. Nueva función eliminar_delegado_asociacion_con_auditoria(): hace el
--       chequeo de referencias y el DELETE en la MISMA transacción, tomando
--       un lock FOR UPDATE sobre la fila del delegado antes de chequear. Una
--       inserción concurrente en cartillas_delegado/rodeos_delegado_
--       institucional necesita validar su propia FK contra esa fila — para
--       eso Postgres toma un lock FOR KEY SHARE sobre ella, que queda
--       BLOQUEADO mientras nuestra transacción retiene el FOR UPDATE. Así,
--       las dos operaciones quedan totalmente serializadas: o el DELETE
--       termina primero (y la inserción concurrente, al reanudarse, falla
--       por la FK de la Pieza 1a — nunca un SET NULL silencioso), o la
--       inserción ya había comprometido su fila antes de que tomáramos el
--       lock (y entonces nuestro propio chequeo la ve y bloquea el DELETE
--       con 'DELEGADO_TIENE_HISTORIAL').
--   La Pieza 1a por sí sola ya vuelve imposible el efecto dañino (SET NULL
--   silencioso) incluso si alguien algún día borra sin pasar por la RPC; la
--   1b además da un mensaje claro en vez de un error crudo de FK.
--
-- RIESGO 2 — auditoría no transaccional en Crear/Suspender/Reactivar/
-- Eliminar: el código Node hacía la escritura en delegados_asociacion y
-- LUEGO llamaba a auditoria.registrar() (que nunca lanza excepciones, por
-- diseño — services/auditoria.js, sin cambios). Si esa segunda llamada
-- fallaba, la operación principal YA había quedado aplicada sin ningún
-- registro de auditoría — exactamente el mismo hallazgo de la Fase 3.5.1
-- (migración 070), para el módulo institucional. Se aplica el MISMO patrón
-- ya probado ahí: 4 funciones nuevas que hacen la escritura principal + el
-- INSERT en auditoria dentro de UNA sola transacción — si el INSERT en
-- auditoria falla (o la excepción de cualquier validación interna se
-- dispara), Postgres revierte TODO, incluida la escritura principal. Nunca
-- se reporta éxito de una operación sin su evento de auditoría.
--
-- Estas 4 funciones son nuevas (nunca existieron antes con otro nombre), así
-- que no hay ventana de vulnerabilidad: se crean YA con el mismo
-- endurecimiento de privilegios de la migración 071 (REVOKE de PUBLIC/anon/
-- authenticated, GRANT solo a service_role, search_path fijado) desde el
-- primer momento, no como una corrección posterior.
-- ═════════════════════════════════════════════════════════════════════════

-- ─── Pieza 1a: FK segura (RESTRICT en vez de SET NULL) ─────────────────────
-- Nombre asumido por convención por defecto de Postgres para una FK de
-- columna agregada vía ADD COLUMN sin nombre explícito (065): verificar con
-- database/verificaciones_fase073_solo_lectura.sql ANTES de aplicar. Si el
-- nombre real difiere, ajustar el DROP CONSTRAINT antes de ejecutar — el
-- ADD CONSTRAINT de abajo no depende del nombre viejo.
ALTER TABLE cartillas_delegado
    DROP CONSTRAINT IF EXISTS cartillas_delegado_delegado_asociacion_id_fkey;

ALTER TABLE cartillas_delegado
    ADD CONSTRAINT cartillas_delegado_delegado_asociacion_id_fkey
    FOREIGN KEY (delegado_asociacion_id) REFERENCES delegados_asociacion(id) ON DELETE RESTRICT;

COMMENT ON CONSTRAINT cartillas_delegado_delegado_asociacion_id_fkey ON cartillas_delegado IS
    'RESTRICT (antes SET NULL, migración 065): nunca permite borrar un delegado de asociación con cartillas asociadas — ni siquiera bajo condición de carrera. Ver migración 073.';

-- ─── Pieza 1b + 2: 4 funciones con escritura + auditoría atómicas ─────────

CREATE OR REPLACE FUNCTION crear_delegado_asociacion_con_auditoria(
    p_nombre TEXT,
    p_nombre_normalizado TEXT,
    p_asociacion_id UUID,
    p_certificado BOOLEAN,
    p_administrador_id UUID
) RETURNS delegados_asociacion AS $$
DECLARE
    v_resultado delegados_asociacion;
BEGIN
    INSERT INTO delegados_asociacion (nombre, nombre_normalizado, asociacion_id, certificado, activo, created_by)
    VALUES (p_nombre, p_nombre_normalizado, p_asociacion_id, p_certificado, true, p_administrador_id)
    RETURNING * INTO v_resultado;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES ('delegados_asociacion', v_resultado.id::text, 'crear',
        jsonb_build_object('nombre', p_nombre, 'asociacion_id', p_asociacion_id, 'certificado', p_certificado),
        p_administrador_id::text, 'administrador',
        format('Alta de delegado de asociación: %s', p_nombre));

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION crear_delegado_asociacion_con_auditoria IS
    'Verificación previa a publicación: alta de delegado + su auditoría en una sola transacción — si el INSERT en auditoria falla, el alta tampoco queda aplicada. La violación UNIQUE(nombre_normalizado, asociacion_id) de la migración 062 sigue aplicando normalmente (23505), sin alta ni auditoría.';

CREATE OR REPLACE FUNCTION suspender_delegado_asociacion_con_auditoria(
    p_delegado_id UUID,
    p_administrador_id UUID,
    p_descripcion TEXT
) RETURNS delegados_asociacion AS $$
DECLARE
    v_resultado delegados_asociacion;
BEGIN
    UPDATE delegados_asociacion
        SET activo = false, updated_at = now()
        WHERE id = p_delegado_id AND activo = true
        RETURNING * INTO v_resultado;

    IF v_resultado IS NULL THEN
        IF EXISTS(SELECT 1 FROM delegados_asociacion WHERE id = p_delegado_id) THEN
            RAISE EXCEPTION 'DELEGADO_YA_SUSPENDIDO';
        END IF;
        RAISE EXCEPTION 'DELEGADO_NO_ENCONTRADO';
    END IF;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES ('delegados_asociacion', p_delegado_id::text, 'suspender',
        jsonb_build_object('activo', true), jsonb_build_object('activo', false),
        p_administrador_id::text, 'administrador', p_descripcion);

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION suspender_delegado_asociacion_con_auditoria IS
    'Verificación previa a publicación: suspensión + su auditoría en una sola transacción. Nunca toca cartillas_delegado ni rodeos_delegado_institucional — el llamador (JS) sigue informando esas referencias como advertencia, de forma separada y no transaccional (son solo informativas, no afectan la corrección de esta operación).';

CREATE OR REPLACE FUNCTION reactivar_delegado_asociacion_con_auditoria(
    p_delegado_id UUID,
    p_administrador_id UUID
) RETURNS delegados_asociacion AS $$
DECLARE
    v_resultado delegados_asociacion;
BEGIN
    UPDATE delegados_asociacion
        SET activo = true, updated_at = now()
        WHERE id = p_delegado_id AND activo = false
        RETURNING * INTO v_resultado;

    IF v_resultado IS NULL THEN
        IF EXISTS(SELECT 1 FROM delegados_asociacion WHERE id = p_delegado_id) THEN
            RAISE EXCEPTION 'DELEGADO_YA_ACTIVO';
        END IF;
        RAISE EXCEPTION 'DELEGADO_NO_ENCONTRADO';
    END IF;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES ('delegados_asociacion', p_delegado_id::text, 'reactivar',
        jsonb_build_object('activo', false), jsonb_build_object('activo', true),
        p_administrador_id::text, 'administrador',
        format('Reactivación de delegado: %s', v_resultado.nombre));

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION reactivar_delegado_asociacion_con_auditoria IS
    'Verificación previa a publicación: reactivación + su auditoría en una sola transacción. Nunca escribe `certificado` — se mantiene en su valor real, nunca se certifica automáticamente al reactivar.';

CREATE OR REPLACE FUNCTION eliminar_delegado_asociacion_con_auditoria(
    p_delegado_id UUID,
    p_administrador_id UUID
) RETURNS delegados_asociacion AS $$
DECLARE
    v_actual delegados_asociacion;
    v_tiene_cartillas BOOLEAN;
    v_tiene_rodeos BOOLEAN;
    v_resultado delegados_asociacion;
BEGIN
    -- FOR UPDATE: serializa contra cualquier INSERT concurrente en
    -- cartillas_delegado/rodeos_delegado_institucional que referencie esta
    -- fila (ver Pieza 1b del comentario de cabecera) — cierra la condición
    -- de carrera, no solo la documenta.
    SELECT * INTO v_actual FROM delegados_asociacion WHERE id = p_delegado_id FOR UPDATE;
    IF v_actual IS NULL THEN
        RAISE EXCEPTION 'DELEGADO_NO_ENCONTRADO';
    END IF;

    SELECT EXISTS(SELECT 1 FROM cartillas_delegado WHERE delegado_asociacion_id = p_delegado_id) INTO v_tiene_cartillas;
    SELECT EXISTS(SELECT 1 FROM rodeos_delegado_institucional WHERE delegado_asociacion_id = p_delegado_id) INTO v_tiene_rodeos;

    IF v_tiene_cartillas OR v_tiene_rodeos THEN
        RAISE EXCEPTION 'DELEGADO_TIENE_HISTORIAL';
    END IF;

    DELETE FROM delegados_asociacion WHERE id = p_delegado_id RETURNING * INTO v_resultado;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, actor_id, actor_tipo, descripcion)
    VALUES ('delegados_asociacion', p_delegado_id::text, 'eliminar',
        jsonb_build_object('nombre', v_actual.nombre, 'asociacion_id', v_actual.asociacion_id, 'activo', v_actual.activo, 'certificado', v_actual.certificado),
        p_administrador_id::text, 'administrador',
        format('Eliminación definitiva de delegado sin historial: %s', v_actual.nombre));

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION eliminar_delegado_asociacion_con_auditoria IS
    'Verificación previa a publicación: cierra la condición de carrera de la eliminación (FOR UPDATE + chequeo de referencias dentro de la misma transacción) y su auditoría, en una sola transacción. Lanza DELEGADO_TIENE_HISTORIAL si existe cualquier cartilla o selección de rodeo — nunca elimina en ese caso. Reforzada además por la FK RESTRICT de la Pieza 1a.';

-- ─── Endurecimiento de privilegios (mismo criterio que 071, desde el
-- primer momento — estas funciones nunca existieron con permisos amplios) ──
REVOKE ALL ON FUNCTION crear_delegado_asociacion_con_auditoria(TEXT, TEXT, UUID, BOOLEAN, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION suspender_delegado_asociacion_con_auditoria(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reactivar_delegado_asociacion_con_auditoria(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION eliminar_delegado_asociacion_con_auditoria(UUID, UUID) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION crear_delegado_asociacion_con_auditoria(TEXT, TEXT, UUID, BOOLEAN, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION suspender_delegado_asociacion_con_auditoria(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION reactivar_delegado_asociacion_con_auditoria(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION eliminar_delegado_asociacion_con_auditoria(UUID, UUID) TO service_role;

ALTER FUNCTION crear_delegado_asociacion_con_auditoria(TEXT, TEXT, UUID, BOOLEAN, UUID) SET search_path = public, pg_temp;
ALTER FUNCTION suspender_delegado_asociacion_con_auditoria(UUID, UUID, TEXT) SET search_path = public, pg_temp;
ALTER FUNCTION reactivar_delegado_asociacion_con_auditoria(UUID, UUID) SET search_path = public, pg_temp;
ALTER FUNCTION eliminar_delegado_asociacion_con_auditoria(UUID, UUID) SET search_path = public, pg_temp;

-- Reversible:
--   DROP FUNCTION IF EXISTS crear_delegado_asociacion_con_auditoria(TEXT, TEXT, UUID, BOOLEAN, UUID);
--   DROP FUNCTION IF EXISTS suspender_delegado_asociacion_con_auditoria(UUID, UUID, TEXT);
--   DROP FUNCTION IF EXISTS reactivar_delegado_asociacion_con_auditoria(UUID, UUID);
--   DROP FUNCTION IF EXISTS eliminar_delegado_asociacion_con_auditoria(UUID, UUID);
--   ALTER TABLE cartillas_delegado DROP CONSTRAINT IF EXISTS cartillas_delegado_delegado_asociacion_id_fkey;
--   ALTER TABLE cartillas_delegado ADD CONSTRAINT cartillas_delegado_delegado_asociacion_id_fkey
--       FOREIGN KEY (delegado_asociacion_id) REFERENCES delegados_asociacion(id) ON DELETE SET NULL;
--   -- (revertir a SET NULL reabre el Riesgo 1 — no se recomienda, se
--   --  documenta solo por completitud del procedimiento de reversión).
