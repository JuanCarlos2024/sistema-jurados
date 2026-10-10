-- ═════════════════════════════════════════════════════════════════════════
-- 070_auditoria_transaccional_institucional.sql
-- Fase 3.5.1 — "La operación principal y su auditoría obligatoria deben
-- mantener consistencia transaccional; si falla el registro obligatorio, no
-- se debe comunicar éxito de una operación que quedó sin trazabilidad."
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — pendiente de autorización.
-- Depende de 066/067 (crear_o_adjuntar_cartilla_institucional) y de 069
-- (CHECK de auditoria.actor_tipo ya amplía para 'cuenta_institucional').
--
-- ═════════════════════════════════════════════════════════════════════════
-- HALLAZGO (auditoría de la Fase 3.5.1): de las 5 operaciones institucionales
-- críticas, solo 2 (confirmar / reemplazar, migración 069) registran su
-- auditoría DENTRO de la misma función/transacción que hace la escritura
-- principal — si esa inserción en `auditoria` falla por cualquier motivo, la
-- excepción no controlada aborta TODA la función y Postgres revierte
-- también la escritura principal (ni la designación ni el reemplazo quedan
-- aplicados sin su evento de auditoría — ya era así desde la 069, no
-- requiere cambios; se agregan tests que lo demuestran, ver
-- responsableUnicoInstitucional.rpc.test.js).
--
-- Las otras 3 (crear/adjuntar cartilla, guardar borrador, enviar) NO tenían
-- esa garantía:
--   - "Crear cartilla" ya usaba una RPC (crear_o_adjuntar_cartilla_
--     institucional, 066/067), pero el INSERT en `auditoria` se hacía
--     DESPUÉS, desde institucional/cartilla.js, vía auditoria.registrar() —
--     un helper que TRAGA sus propios errores a propósito ("no lanza errores
--     para no interrumpir el flujo principal", services/auditoria.js — ese
--     diseño es correcto y se mantiene intacto para el resto del sistema,
--     NO se modifica acá). Si esa inserción posterior fallaba, la cartilla
--     ya había quedado creada/adjuntada SIN que el cliente se enterara de
--     que su auditoría no quedó registrada.
--   - "Guardar borrador" y "Enviar cartilla" ni siquiera pasaban por una RPC:
--     eran un UPDATE directo desde JS + el mismo auditoria.registrar()
--     posterior, con el mismo problema.
--
-- CORRECCIÓN (cambios mínimos, reutilizando las RPC existentes):
--   1. crear_o_adjuntar_cartilla_institucional (CREATE OR REPLACE): el
--      mismo INSERT en `auditoria` que antes hacía institucional/cartilla.js
--      se mueve DENTRO de la función, en la MISMA transacción que el
--      INSERT/UPDATE de la cartilla — ahora, si el INSERT en auditoria
--      falla, la función entera revierte (incluida la escritura de la
--      cartilla) y el cliente recibe un error real, nunca un 201/200 falso.
--   2. Nueva función genérica actualizar_cartilla_institucional_con_auditoria:
--      reemplaza el UPDATE suelto + auditoria.registrar() posterior que
--      usaban PATCH /institucional/cartilla/:id y POST /institucional/
--      cartilla/:id/enviar. Recibe exactamente el mismo objeto `updates` que
--      JS ya construye hoy (misma lista de campos editables, mismo control
--      de concurrencia optimista por id+version) como JSONB, y aplica el
--      UPDATE + el INSERT en auditoria en la MISMA transacción. Por diseño,
--      esta función NUNCA escribe id/rodeo_id/delegado_id/
--      delegado_asociacion_id/created_at — ni siquiera si esas claves
--      vinieran en el JSONB recibido (defensa en profundidad adicional a los
--      chequeos 403 ya existentes en la ruta: el responsable institucional
--      es estructuralmente inmutable por esta vía, a nivel de base de datos).
-- ═════════════════════════════════════════════════════════════════════════

-- ─── Pieza 0: HALLAZGO — columnas usadas por código YA EXISTENTE (envío/
-- reenvío de cartilla, usuario/cartilla-delegado.js; observar/aprobar,
-- admin/cartillas-delegado.js) que NUNCA aparecen en ningún archivo de
-- migración rastreado ni en database/schema.sql: `reenviada_en` e
-- `historial_observaciones`. Es decir: o existen en la base real porque se
-- agregaron alguna vez fuera del flujo de migraciones versionadas, o el
-- reenvío/historial de observaciones viene fallando en producción desde
-- antes de esta fase (mismo patrón que el hallazgo de `auditoria.actor_tipo`
-- en la Fase 3.5). No se investiga más a fondo acá (fuera del alcance de
-- esta fase), pero la función nueva de la Pieza 2 SÍ las necesita — se
-- agregan de forma aditiva e idempotente (ADD COLUMN IF NOT EXISTS) para
-- que esta migración sea correcta sin importar cuál de los dos escenarios
-- sea cierto. Nunca se tocan filas existentes ni se cambia ningún valor ya
-- guardado.
ALTER TABLE cartillas_delegado
    ADD COLUMN IF NOT EXISTS reenviada_en TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS historial_observaciones JSONB;

-- ─── Pieza 1: crear_o_adjuntar_cartilla_institucional ahora audita dentro
-- de su propia transacción ──────────────────────────────────────────────
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

    -- Fase 3.5.1: auditoría DENTRO de la misma transacción que la escritura
    -- — si este INSERT falla, la excepción revierte también el INSERT/UPDATE
    -- de arriba (nunca se reporta éxito sin trazabilidad). Mismo criterio de
    -- 'crear'/'guardar' que usaba institucional/cartilla.js (se retira de
    -- ahí, ver ese archivo).
    INSERT INTO auditoria (tabla, registro_id, accion, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES (
        'cartillas_delegado', v_resultado.id::text,
        CASE WHEN v_resultado.version = 1 THEN 'crear' ELSE 'guardar' END,
        jsonb_build_object('delegado_asociacion_id', p_delegado_asociacion_id, 'delegado_nombre', p_delegado_nombre, 'version', v_resultado.version),
        p_cuenta_institucional_id::text, 'cuenta_institucional',
        format('%s de cartilla institucional — delegado: %s',
            CASE WHEN v_resultado.version = 1 THEN 'Creación' ELSE 'Adjunto' END, p_delegado_nombre)
    );

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION crear_o_adjuntar_cartilla_institucional IS
    'Fase 3.1 (cierre) + 3.5.1: crea o adjunta la cartilla institucional oficial de un rodeo, serializada contra Delegado Rentado concurrente, y registra su propio evento de auditoría en la MISMA transacción (si la auditoría falla, la cartilla tampoco queda creada/adjuntada).';

-- ─── Pieza 2: guardar/enviar — UPDATE + auditoría atómicos ─────────────────
-- Reemplaza el UPDATE suelto (PATCH /:id, POST /:id/enviar) + el
-- auditoria.registrar() posterior. JS sigue siendo el único responsable de
-- DECIDIR qué campos van en p_cambios (misma lista CAMPOS_EDITABLES de
-- siempre, más estado/enviada_en/reenviada_en/historial_observaciones solo
-- cuando corresponde a un envío) — esta función solo aplica ese objeto ya
-- armado de forma atómica junto con su auditoría. Columnas estructuralmente
-- protegidas (nunca en el SET, aunque vinieran en p_cambios): id, rodeo_id,
-- delegado_id, delegado_asociacion_id, created_at — el responsable
-- institucional es inmutable por esta vía también a nivel de base de datos,
-- no solo por el chequeo 403 ya existente en la ruta.
CREATE OR REPLACE FUNCTION actualizar_cartilla_institucional_con_auditoria(
    p_cartilla_id UUID,
    p_version INT,
    p_cambios JSONB,
    p_cuenta_institucional_id UUID,
    p_accion TEXT,
    p_descripcion TEXT
) RETURNS cartillas_delegado AS $$
DECLARE
    v_actual cartillas_delegado;
    v_merged cartillas_delegado;
    v_resultado cartillas_delegado;
BEGIN
    SELECT * INTO v_actual FROM cartillas_delegado
        WHERE id = p_cartilla_id AND version = p_version
        FOR UPDATE;

    -- RAISE EXCEPTION en vez de RETURN NULL: un NULL compuesto, visto a
    -- través de `SELECT * FROM funcion(...)` (como hace PostgREST/Supabase
    -- al exponer la RPC), se expande en UNA fila con TODAS las columnas en
    -- NULL — ambiguo e indistinguible de un resultado real con columnas
    -- nulas. Señalizar con una excepción (mismo patrón ya usado por
    -- confirmar_delegado_institucional_rodeo/reemplazar_delegado_
    -- institucional_rodeo, migración 069) es inequívoco: el caller (JS)
    -- detecta el código del mensaje y responde 404/409 según corresponda.
    IF v_actual IS NULL THEN
        RAISE EXCEPTION 'CARTILLA_NO_ENCONTRADA_O_VERSION_DESACTUALIZADA';
    END IF;

    SELECT * INTO v_merged FROM jsonb_populate_record(v_actual, p_cambios);

    UPDATE cartillas_delegado SET
        estado = v_merged.estado,
        version = v_merged.version,
        updated_at = v_merged.updated_at,
        actualizado_por_cuenta_institucional_id = v_merged.actualizado_por_cuenta_institucional_id,
        enviada_en = v_merged.enviada_en,
        reenviada_en = v_merged.reenviada_en,
        historial_observaciones = v_merged.historial_observaciones,
        delegado_nombre = v_merged.delegado_nombre,
        delegado_telefono = v_merged.delegado_telefono,
        secretario_jurado = v_merged.secretario_jurado,
        secretario_numero_socio = v_merged.secretario_numero_socio,
        serie_campeones_dos_vueltas = v_merged.serie_campeones_dos_vueltas,
        incluye_informe_disciplinario = v_merged.incluye_informe_disciplinario,
        incluye_informe_ganado_bajo_peso = v_merged.incluye_informe_ganado_bajo_peso,
        certificacion_medialuna_comuna = v_merged.certificacion_medialuna_comuna,
        certificacion_mas_200_personas = v_merged.certificacion_mas_200_personas,
        certificacion_mas_250_personas = v_merged.certificacion_mas_250_personas,
        certificacion_vinculacion_comunidad = v_merged.certificacion_vinculacion_comunidad,
        respuestas_json = v_merged.respuestas_json
    WHERE id = p_cartilla_id AND version = p_version
    RETURNING * INTO v_resultado;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES ('cartillas_delegado', v_resultado.id::text, p_accion,
        jsonb_build_object('version', v_resultado.version), p_cuenta_institucional_id::text, 'cuenta_institucional', p_descripcion);

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION actualizar_cartilla_institucional_con_auditoria IS
    'Fase 3.5.1: aplica un guardado (PATCH) o envío (POST /enviar) de cartilla institucional junto con su evento de auditoría, en una sola transacción — si la auditoría falla, el guardado tampoco queda aplicado. Nunca escribe id/rodeo_id/delegado_id/delegado_asociacion_id/created_at aunque vinieran en p_cambios. Lanza CARTILLA_NO_ENCONTRADA_O_VERSION_DESACTUALIZADA si id+version no matchean ninguna fila (el caller distingue 404 vs 409 con su propia consulta previa, igual que hoy).';

-- Reversible:
--   DROP FUNCTION IF EXISTS actualizar_cartilla_institucional_con_auditoria(UUID, INT, JSONB, UUID, TEXT, TEXT);
--   (crear_o_adjuntar_cartilla_institucional vuelve a su versión de la 067 re-aplicando esa migración)
--   -- reenviada_en/historial_observaciones NO se eliminan al revertir: no hay
--   -- forma segura de saber si ya eran usadas fuera de las migraciones
--   -- versionadas (ver Pieza 0) sin auditar datos reales primero.
