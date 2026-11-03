-- ═════════════════════════════════════════════════════════════════════════
-- 091_sincronizacion_duracion_asignaciones_rodeo.sql
--
-- NO APLICADA — preparada localmente, pendiente de autorización explícita.
--
-- Corrección del bug "ANCUD/CHILOÉ" (jurado Augusto César González Álvarez):
-- al editar el tipo de rodeo (y por lo tanto su duración), `rodeos.
-- duracion_dias` se actualizaba pero `asignaciones.duracion_dias_aplicada`
-- (copia congelada al crear la designación, de la que se deriva
-- pago_base_calculado) nunca se sincronizaba — el portal del jurado, el
-- resumen financiero mensual, la columna "Total pagos" del admin, los
-- reportes y las exportaciones (todos leen exactamente esas dos columnas)
-- seguían mostrando la duración/pago antiguos indefinidamente.
--
-- Revisión correctiva de esta misma ronda — la primera solución (JS puro en
-- backend/src/services/calculo.js, sincronizarAsignacionesPorCambioDuracion)
-- quedó expuesta a un estado parcial real: si la actualización de `rodeos`
-- vía REST tenía éxito pero la sincronización de `asignaciones` fallaba a
-- mitad de camino, el rodeo quedaba editado con asignaciones a medio
-- sincronizar. Esta migración mueve esa lógica a Postgres, DENTRO de la
-- misma transacción que edita el rodeo — mismo patrón ya probado y aplicado
-- en producción por 084 (reemplazar_jurado_asignacion_con_bitacora).
--
-- CONTENIDO:
--   1) Función interna _sincronizar_asignaciones_duracion(...) — el bucle de
--      sincronización en sí, reutilizado por las dos funciones públicas de
--      abajo. Nunca se llama directamente desde el backend.
--   2) RPC pública actualizar_tipo_rodeo_y_sincronizar_asignaciones(...) —
--      usada por PATCH /api/admin/rodeos/:id cuando cambia tipo_rodeo_id:
--      actualiza rodeos.tipo_rodeo_id/nombre/duracion_dias Y sincroniza sus
--      asignaciones activas, ambas escrituras en una sola transacción.
--   3) RPC pública reparar_sincronizacion_asignaciones_rodeo(...) —
--      herramienta de reparación para rodeos YA desincronizados (antes de
--      esta corrección) SIN necesidad de cambiar artificialmente su tipo:
--      relee la duración VIGENTE del rodeo (la que ya tiene, sin tocarla) y
--      sincroniza sus asignaciones contra ese valor. Idempotente: sobre un
--      rodeo ya sincronizado no hace nada.
--   4) CREATE OR REPLACE de reemplazar_jurado_asignacion_con_bitacora (084)
--      — corrige una inconsistencia detectada en la revisión: esa función ya
--      recalculaba pago_base_calculado con la duración VIGENTE del rodeo
--      (v_rodeo_duracion, ya leída ahí mismo), pero nunca escribía
--      duracion_dias_aplicada — podía dejar un pago correcto junto a una
--      duración desplegada incorrecta. El resto de la función (firma,
--      permisos, bloqueos de antecedentes sensibles, bitácora) es
--      exactamente igual a 084 — CREATE OR REPLACE no rompe ningún llamador
--      existente.
--
-- REVISIÓN CORRECTIVA (previa a la primera aplicación en producción —
-- detectada al revisar esta migración antes de ejecutarla manualmente):
--   a) La idempotencia de _sincronizar_asignaciones_duracion comparaba
--      SOLO la duración — una asignación con duracion_dias_aplicada ya
--      correcta pero pago_base_calculado desalineado por cualquier otra
--      causa quedaba para siempre sin corregir. Ahora una asignación solo
--      se considera "sin cambio" cuando duración Y pago YA coinciden con
--      el valor esperado (valor_diario_aplicado × duración) — nunca se
--      reemplaza valor_diario_aplicado ni ninguna otra regla de negocio,
--      solo se amplía qué se considera "ya correcto".
--   b) Ambas RPC públicas ahora rechazan (DURACION_INVALIDA) una duración
--      nula, cero o negativa, antes de tocar cualquier tabla.
--   c) reemplazar_jurado_asignacion_con_bitacora (084) ahora verifica,
--      bajo el lock de `rodeos` ya tomado, que el pago recibido como
--      parámetro corresponde exactamente a valor_diario_aplicado_nuevo ×
--      la duración VIGENTE del rodeo — si no corresponde (p. ej. el rodeo
--      cambió de duración entre que el backend calculó el pago y esta
--      llamada), se rechaza con PAGO_BASE_INCONSISTENTE_CON_DURACION en
--      vez de guardar un monto que no cuadra con los días aplicados.
--
-- SEGUNDA REVISIÓN CORRECTIVA (antes de aplicar manualmente en Supabase):
--   d) reparar_sincronizacion_asignaciones_rodeo usaba
--      COALESCE(v_duracion_vigente, 1) sobre la duración que relee de
--      `rodeos` — convertía en silencio una duración nula en "1 día" antes
--      de sincronizar. Ahora rechaza explícitamente (DURACION_INVALIDA) si
--      esa duración es nula, cero o negativa, igual criterio que
--      actualizar_tipo_rodeo_y_sincronizar_asignaciones — nunca inventa un
--      valor que el rodeo no tenía.
--
-- CONCURRENCIA — mismo orden de locks {rodeos, luego asignaciones} ya
-- establecido y documentado por 067/079/084 (Decisión 9 de 084): las tres
-- funciones de esta migración bloquean la fila de `rodeos` con FOR UPDATE
-- ANTES de tocar cualquier fila de `asignaciones`. Esto serializa entre sí
-- (en el mismo rodeo): dos ediciones de tipo concurrentes, una edición de
-- tipo contra una reparación manual, y cualquiera de las dos contra un
-- reemplazo de jurado (084, que también respeta este mismo orden) — ninguna
-- puede leer datos obsoletos de la otra a medio camino. El bucle interno
-- además toma FOR UPDATE sobre cada fila de `asignaciones` que va a tocar,
-- siempre después del lock de `rodeos`, nunca antes.
--
-- PROTECCIÓN DE PAGOS HISTÓRICOS — HONESTIDAD EXPLÍCITA (pedido 2C): el
-- ÚNICO mecanismo que existe hoy en el sistema para marcar un pago como "ya
-- liquidado/protegido" es el de asignación de IMPORTACIÓN HISTÓRICA
-- (asignaciones.importacion_id → importaciones.tipo = 'historico_rodeos',
-- servicio asignacionHistorica.js). Se auditó el esquema completo en busca
-- de cualquier otro concepto — columna de "cerrado", "liquidado",
-- "exportado a planilla", tabla de períodos de pago cerrados, etc. — y NO
-- EXISTE NINGUNO. Cualquier asignación activa que no sea de importación
-- histórica se considera, por el diseño actual del sistema, abierta a
-- recálculo. Esta migración no inventa una protección nueva que el sistema
-- no tenía — mantiene exactamente el mismo criterio que ya usa
-- esAsignacionHistoricaImportada()/el PATCH de asignaciones existente para
-- bloquear cambios de pago. Si se requiere un concepto real de "período de
-- pago cerrado" (p. ej. ligado a la exportación de una planilla), es una
-- decisión de negocio nueva, fuera del alcance de esta corrección —
-- recomendado como mejora futura, no implementado aquí sin autorización
-- explícita.
--
-- Migración envuelta en una transacción explícita. Idempotente: CREATE OR
-- REPLACE FUNCTION es seguro de repetir. Reversible: ver bloque al final.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1) Función interna — el bucle de sincronización en sí.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _sincronizar_asignaciones_duracion(
    p_rodeo_id              UUID,
    p_nueva_duracion_dias   INTEGER,
    p_actor_id              UUID,
    p_actor_tipo            TEXT DEFAULT 'administrador',
    p_ip_address            TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_asig                  RECORD;
    v_es_historica          BOOLEAN;
    v_nuevo_pago            NUMERIC;
    v_actualizadas          INTEGER := 0;
    v_omitidas_historicas   INTEGER := 0;
    v_sin_cambio            INTEGER := 0;
BEGIN
    -- Revisión correctiva (previa a aplicar en producción): se rechazan
    -- duraciones nulas, cero o negativas — nunca se propaga un valor
    -- inválido a `duracion_dias_aplicada`/`pago_base_calculado`. Esta es la
    -- función interna que ejecuta ambas RPC públicas, así que validar aquí
    -- protege a las dos sin duplicar la verificación.
    IF p_nueva_duracion_dias IS NULL OR p_nueva_duracion_dias <= 0 THEN
        RAISE EXCEPTION 'DURACION_INVALIDA: la duración debe ser un entero positivo (recibido: %)', p_nueva_duracion_dias;
    END IF;

    -- Precondición: el llamador ya debe tener un lock FOR UPDATE sobre la
    -- fila de `rodeos` (orden {rodeos, luego asignaciones} — Decisión 9 de
    -- 084) ANTES de invocar esta función. No se vuelve a bloquear aquí.
    FOR v_asig IN
        SELECT a.id, a.importacion_id, a.valor_diario_aplicado, a.duracion_dias_aplicada, a.pago_base_calculado
          FROM asignaciones a
         WHERE a.rodeo_id = p_rodeo_id AND a.estado = 'activo'
           FOR UPDATE OF a
    LOOP
        -- Pago esperado SIEMPRE calculado conservando valor_diario_aplicado
        -- (nunca se reemplaza la tarifa ya aplicada — preserva cualquier
        -- override manual admin existente, misma regla de negocio que ya
        -- usa el PATCH existente de asignaciones para su propio override).
        v_nuevo_pago := round(COALESCE(v_asig.valor_diario_aplicado, 0) * p_nueva_duracion_dias);

        -- Idempotente — revisión correctiva: NO basta con que la duración ya
        -- coincida. Antes, una asignación con duracion_dias_aplicada ya
        -- correcta pero pago_base_calculado desalineado (p. ej. tocado por
        -- otra vía) quedaba PERMANENTEMENTE sin corregir, porque el chequeo
        -- original solo miraba la duración. Ahora solo se considera "sin
        -- cambio" cuando AMBAS columnas ya coinciden con el valor esperado.
        IF v_asig.duracion_dias_aplicada = p_nueva_duracion_dias
           AND v_asig.pago_base_calculado = v_nuevo_pago THEN
            v_sin_cambio := v_sin_cambio + 1;
            CONTINUE;
        END IF;

        -- Pago histórico importado (ya liquidado fuera del sistema) — nunca
        -- se recalcula, sin importar si difiere de lo esperado. Ver nota de
        -- "PROTECCIÓN DE PAGOS HISTÓRICOS" arriba: es el único mecanismo de
        -- protección que existe en el sistema hoy.
        v_es_historica := FALSE;
        IF v_asig.importacion_id IS NOT NULL THEN
            SELECT EXISTS(
                SELECT 1 FROM importaciones i
                 WHERE i.id = v_asig.importacion_id AND i.tipo = 'historico_rodeos'
            ) INTO v_es_historica;
        END IF;

        IF v_es_historica THEN
            v_omitidas_historicas := v_omitidas_historicas + 1;
            CONTINUE;
        END IF;

        UPDATE asignaciones
           SET duracion_dias_aplicada = p_nueva_duracion_dias,
               pago_base_calculado    = v_nuevo_pago,
               updated_at             = now()
         WHERE id = v_asig.id;

        INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion, ip_address)
        VALUES (
            'asignaciones', v_asig.id::text, 'editar',
            jsonb_build_object('duracion_dias_aplicada', v_asig.duracion_dias_aplicada, 'pago_base_calculado', v_asig.pago_base_calculado),
            jsonb_build_object('duracion_dias_aplicada', p_nueva_duracion_dias, 'pago_base_calculado', v_nuevo_pago),
            p_actor_id::text, p_actor_tipo,
            'Recálculo automático de duración/pago por sincronización con el rodeo',
            p_ip_address
        );

        v_actualizadas := v_actualizadas + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'actualizadas', v_actualizadas,
        'omitidas_historicas', v_omitidas_historicas,
        'sin_cambio', v_sin_cambio
    );
END;
$$;

REVOKE ALL ON FUNCTION _sincronizar_asignaciones_duracion(UUID, INTEGER, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION _sincronizar_asignaciones_duracion(UUID, INTEGER, UUID, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION _sincronizar_asignaciones_duracion IS
    'Función interna — no se llama directamente desde el backend. Sincroniza duracion_dias_aplicada Y pago_base_calculado (ambas, no solo la duración) de las asignaciones activas de un rodeo a la duración indicada, preservando valor_diario_aplicado. Nunca toca asignaciones de importación histórica. Rechaza duraciones nulas/cero/negativas. Idempotente — solo omite una asignación cuando duración Y pago ya coinciden con lo esperado. El llamador debe tener ya un lock FOR UPDATE sobre `rodeos` antes de invocarla.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2) RPC pública: cambiar tipo de rodeo (y su duración) de forma atómica
--    con la sincronización de sus asignaciones.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION actualizar_tipo_rodeo_y_sincronizar_asignaciones(
    p_rodeo_id              UUID,
    p_tipo_rodeo_id         UUID,
    p_tipo_rodeo_nombre     TEXT,
    p_nueva_duracion_dias   INTEGER,
    p_actor_id              UUID,
    p_actor_tipo            TEXT DEFAULT 'administrador',
    p_ip_address            TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_rodeo                 rodeos%ROWTYPE;
    v_anterior_tipo_nombre  TEXT;
    v_anterior_duracion     INTEGER;
    v_sync                  JSONB;
BEGIN
    IF p_rodeo_id IS NULL THEN RAISE EXCEPTION 'RODEO_REQUERIDO'; END IF;
    IF p_actor_id IS NULL THEN RAISE EXCEPTION 'ACTOR_REQUERIDO'; END IF;
    -- Revisión correctiva: fallar ANTES de tocar `rodeos` — nunca se llega
    -- a escribir una duración inválida en rodeos.duracion_dias ni a bloquear
    -- su fila para una operación que de todas formas va a fallar.
    IF p_nueva_duracion_dias IS NULL OR p_nueva_duracion_dias <= 0 THEN
        RAISE EXCEPTION 'DURACION_INVALIDA: la duración debe ser un entero positivo (recibido: %)', p_nueva_duracion_dias;
    END IF;

    -- Lock de `rodeos` PRIMERO (orden {rodeos, luego asignaciones} —
    -- Decisión 9 de 084) — serializa esta operación contra cualquier otra
    -- que también bloquee este mismo rodeo (esta misma función llamada dos
    -- veces concurrentemente, reparar_sincronizacion_asignaciones_rodeo, y
    -- reemplazar_jurado_asignacion_con_bitacora, que respeta el mismo orden).
    SELECT * INTO v_rodeo FROM rodeos WHERE id = p_rodeo_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RODEO_NO_ENCONTRADO';
    END IF;

    v_anterior_tipo_nombre := v_rodeo.tipo_rodeo_nombre;
    v_anterior_duracion    := v_rodeo.duracion_dias;

    UPDATE rodeos
       SET tipo_rodeo_id     = p_tipo_rodeo_id,
           tipo_rodeo_nombre = p_tipo_rodeo_nombre,
           duracion_dias     = p_nueva_duracion_dias,
           updated_at        = now()
     WHERE id = p_rodeo_id
     RETURNING * INTO v_rodeo;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion, ip_address)
    VALUES (
        'rodeos', p_rodeo_id::text, 'editar',
        jsonb_build_object('tipo_rodeo_nombre', v_anterior_tipo_nombre, 'duracion_dias', v_anterior_duracion),
        jsonb_build_object('tipo_rodeo_nombre', p_tipo_rodeo_nombre, 'duracion_dias', p_nueva_duracion_dias),
        p_actor_id::text, p_actor_tipo,
        format('Rodeo editado (tipo de rodeo): %s', v_rodeo.club),
        p_ip_address
    );

    -- Sincronización en la MISMA transacción: si falla, Postgres revierte
    -- también el UPDATE de `rodeos` de arriba — nunca queda el rodeo
    -- cambiado con asignaciones a medio sincronizar (corrige el hallazgo
    -- de la revisión correctiva sobre la primera versión en JS puro).
    v_sync := _sincronizar_asignaciones_duracion(p_rodeo_id, p_nueva_duracion_dias, p_actor_id, p_actor_tipo, p_ip_address);

    RETURN jsonb_build_object('rodeo', row_to_json(v_rodeo), 'sincronizacion', v_sync);
END;
$$;

REVOKE ALL ON FUNCTION actualizar_tipo_rodeo_y_sincronizar_asignaciones(UUID, UUID, TEXT, INTEGER, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION actualizar_tipo_rodeo_y_sincronizar_asignaciones(UUID, UUID, TEXT, INTEGER, UUID, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION actualizar_tipo_rodeo_y_sincronizar_asignaciones IS
    'Cambia el tipo de rodeo (y su duración) y sincroniza, en la MISMA transacción, las asignaciones activas no históricas de ese rodeo — ambas escrituras se confirman o fallan juntas. Rechaza duraciones nulas/cero/negativas antes de tocar `rodeos`. Usada por PATCH /api/admin/rodeos/:id cuando cambia tipo_rodeo_id.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3) RPC pública: reparar un rodeo YA desincronizado, SIN cambiar su tipo.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION reparar_sincronizacion_asignaciones_rodeo(
    p_rodeo_id      UUID,
    p_actor_id      UUID,
    p_actor_tipo    TEXT DEFAULT 'administrador',
    p_ip_address    TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_duracion_vigente  INTEGER;
    v_sync              JSONB;
BEGIN
    IF p_rodeo_id IS NULL THEN RAISE EXCEPTION 'RODEO_REQUERIDO'; END IF;
    IF p_actor_id IS NULL THEN RAISE EXCEPTION 'ACTOR_REQUERIDO'; END IF;

    -- Mismo orden de lock {rodeos, luego asignaciones}. No se modifica el
    -- rodeo en absoluto — solo se relee su duración vigente actual.
    SELECT duracion_dias INTO v_duracion_vigente FROM rodeos WHERE id = p_rodeo_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RODEO_NO_ENCONTRADO';
    END IF;

    -- Revisión correctiva: antes se usaba COALESCE(v_duracion_vigente, 1),
    -- que convertía en silencio una duración nula en "1 día" — podía
    -- sincronizar asignaciones contra un valor que nunca fue la duración
    -- real del rodeo. Ahora se rechaza explícitamente, igual que la RPC de
    -- edición (actualizar_tipo_rodeo_y_sincronizar_asignaciones): nunca se
    -- inventa un valor, se exige que el rodeo ya tenga una duración válida.
    IF v_duracion_vigente IS NULL OR v_duracion_vigente <= 0 THEN
        RAISE EXCEPTION 'DURACION_INVALIDA: la duración vigente del rodeo no es válida (almacenada: %)', v_duracion_vigente;
    END IF;

    v_sync := _sincronizar_asignaciones_duracion(p_rodeo_id, v_duracion_vigente, p_actor_id, p_actor_tipo, p_ip_address);

    RETURN jsonb_build_object('rodeo_id', p_rodeo_id, 'duracion_dias_vigente', v_duracion_vigente, 'sincronizacion', v_sync);
END;
$$;

REVOKE ALL ON FUNCTION reparar_sincronizacion_asignaciones_rodeo(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reparar_sincronizacion_asignaciones_rodeo(UUID, UUID, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION reparar_sincronizacion_asignaciones_rodeo IS
    'Herramienta de reparación: sincroniza las asignaciones de un rodeo contra su duración VIGENTE actual, sin modificar el rodeo ni requerir ningún cambio de tipo. Rechaza (DURACION_INVALIDA) si la duración almacenada en el rodeo es nula, cero o negativa — nunca la convierte en silencio a 1 día. Para usar sobre rodeos que quedaron desincronizados antes de esta corrección (091). Idempotente — en un rodeo ya sincronizado no hace nada.';

-- ─────────────────────────────────────────────────────────────────────────
-- 4) Corrección de reemplazar_jurado_asignacion_con_bitacora (084): agrega
--    duracion_dias_aplicada = COALESCE(v_rodeo_duracion, 1) al UPDATE. Único
--    cambio real; el resto del cuerpo es idéntico a 084 (misma firma, mismos
--    permisos, mismas 14 decisiones documentadas ahí). v_rodeo_duracion ya
--    se leía en esa misma función (línea "SELECT fecha, duracion_dias INTO
--    v_rodeo_fecha, v_rodeo_duracion FROM rodeos ... FOR UPDATE") para el
--    cálculo de pago_base_calculado_nuevo — antes NO se escribía también en
--    duracion_dias_aplicada, lo que podía dejar un pago correcto junto a una
--    duración desplegada incorrecta en el portal/reportes tras un reemplazo.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION reemplazar_jurado_asignacion_con_bitacora(
    p_asignacion_id                        UUID,
    p_usuario_pagado_id_nuevo              UUID,
    p_categoria_aplicada_nueva             TEXT,
    p_valor_diario_aplicado_nuevo          INTEGER,
    p_pago_base_calculado_nuevo            INTEGER,
    p_motivo_catalogo_id                   UUID,
    p_actor_id                             UUID,
    p_tipo_movimiento                      TEXT DEFAULT 'reemplazo',
    p_usuario_pagado_id_anterior_esperado  UUID DEFAULT NULL,
    p_motivo_detalle                       TEXT DEFAULT NULL,
    p_fecha_efectiva                       TIMESTAMPTZ DEFAULT NULL,
    p_operacion_id                         UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
-- SECURITY INVOKER (ver Decisión 8 de 084).
SET search_path = public
AS $$
DECLARE
    v_rodeo_id         UUID;
    v_rodeo_fecha       DATE;
    v_rodeo_duracion    INTEGER;
    v_anterior         asignaciones%ROWTYPE;
    v_nueva            asignaciones%ROWTYPE;
    v_nuevo_jurado      usuarios_pagados%ROWTYPE;
    v_motivo           catalogo_motivos_designacion%ROWTYPE;
    v_bitacora         bitacora_designaciones;
    v_ya_designado     BOOLEAN;
    v_cruce_otro_rodeo BOOLEAN;
BEGIN
    IF p_tipo_movimiento NOT IN (
        'reemplazo', 'cambio_emergencia', 'regularizacion_posterior',
        'rectificacion_administrativa', 'enroque'
    ) THEN
        RAISE EXCEPTION 'TIPO_MOVIMIENTO_NO_PERMITIDO: % no es válido para un reemplazo transaccional', p_tipo_movimiento;
    END IF;
    IF p_actor_id IS NULL THEN
        RAISE EXCEPTION 'ACTOR_REQUERIDO';
    END IF;
    IF p_usuario_pagado_id_nuevo IS NULL THEN
        RAISE EXCEPTION 'JURADO_NUEVO_REQUERIDO';
    END IF;

    -- Decisión 13 (084) — PRIMERA operación de toda la función: advisory
    -- lock sobre el jurado candidato.
    PERFORM pg_advisory_xact_lock(hashtextextended(p_usuario_pagado_id_nuevo::text, 0));

    -- Punto de serialización por rodeo (Decisión 9 de 084): se bloquea
    -- `rodeos` ANTES que la propia fila de `asignaciones`.
    SELECT rodeo_id INTO v_rodeo_id FROM asignaciones WHERE id = p_asignacion_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ASIGNACION_NO_ENCONTRADA';
    END IF;
    SELECT fecha, duracion_dias INTO v_rodeo_fecha, v_rodeo_duracion FROM rodeos WHERE id = v_rodeo_id FOR UPDATE;

    -- Revisión correctiva (091, punto 5): el pago que llega como parámetro
    -- lo calcula el backend (calcularPagoBase, fuera de esta transacción) a
    -- partir de la duración que leyó un instante antes — si entre esa
    -- lectura y esta llamada alguien más editó rodeos.duracion_dias (p. ej.
    -- cambió el tipo de rodeo), el pago recibido quedaría calculado con una
    -- duración ya obsoleta. Con la fila de `rodeos` ya bloqueada arriba,
    -- v_rodeo_duracion es la duración VIGENTE y autoritativa — se verifica
    -- aquí, dentro de la misma transacción, que el pago recibido es
    -- exactamente valor_diario_aplicado_nuevo × esa duración. Nunca se
    -- recalcula en silencio ni se acepta un monto que no cuadra: se
    -- rechaza, y el backend debe reintentar con los datos vigentes.
    IF p_pago_base_calculado_nuevo IS DISTINCT FROM round(COALESCE(p_valor_diario_aplicado_nuevo, 0) * COALESCE(v_rodeo_duracion, 1)) THEN
        RAISE EXCEPTION 'PAGO_BASE_INCONSISTENTE_CON_DURACION: el pago recibido (%) no corresponde a valor_diario_aplicado_nuevo (%) × la duración vigente del rodeo (%)',
            p_pago_base_calculado_nuevo, p_valor_diario_aplicado_nuevo, v_rodeo_duracion;
    END IF;

    -- Bloqueo de concurrencia de la fila afectada (Decisión 4 de 084) — en
    -- ESTE orden ({rodeos, luego asignaciones}), nunca en el inverso.
    SELECT * INTO v_anterior FROM asignaciones WHERE id = p_asignacion_id FOR UPDATE;
    IF v_anterior.tipo_persona <> 'jurado' THEN
        RAISE EXCEPTION 'SOLO_JURADO: esta función solo reemplaza asignaciones de tipo_persona = jurado';
    END IF;
    IF v_anterior.estado = 'anulado' THEN
        RAISE EXCEPTION 'ASIGNACION_ANULADA';
    END IF;

    IF p_usuario_pagado_id_anterior_esperado IS NOT NULL
       AND v_anterior.usuario_pagado_id IS DISTINCT FROM p_usuario_pagado_id_anterior_esperado THEN
        RAISE EXCEPTION 'CONFLICTO_DESIGNACION_MODIFICADA: la asignación ya fue modificada por otro administrador';
    END IF;

    SELECT * INTO v_motivo FROM catalogo_motivos_designacion WHERE id = p_motivo_catalogo_id;
    IF NOT FOUND OR v_motivo.activo IS NOT TRUE THEN
        RAISE EXCEPTION 'MOTIVO_INVALIDO';
    END IF;

    -- Identidad del jurado nuevo SIEMPRE leída de la fuente real (Decisión 6 de 084).
    SELECT * INTO v_nuevo_jurado FROM usuarios_pagados WHERE id = p_usuario_pagado_id_nuevo;
    IF NOT FOUND OR v_nuevo_jurado.activo IS NOT TRUE OR v_nuevo_jurado.tipo_persona <> 'jurado' THEN
        RAISE EXCEPTION 'JURADO_NUEVO_INVALIDO';
    END IF;

    IF v_anterior.usuario_pagado_id IS NOT DISTINCT FROM p_usuario_pagado_id_nuevo THEN
        RAISE EXCEPTION 'JURADO_NUEVO_IGUAL_AL_ANTERIOR';
    END IF;

    -- Antecedentes sensibles — bloquea, nunca reasigna en silencio.
    IF EXISTS (SELECT 1 FROM notas_rodeo WHERE asignacion_id = p_asignacion_id) THEN
        RAISE EXCEPTION 'ANTECEDENTE_SENSIBLE_NOTA: esta asignación ya tiene una nota de rodeo registrada';
    END IF;
    IF EXISTS (SELECT 1 FROM cartillas_jurado WHERE asignacion_id = p_asignacion_id) THEN
        RAISE EXCEPTION 'ANTECEDENTE_SENSIBLE_CARTILLA: esta asignación ya tiene una cartilla de jurado registrada';
    END IF;
    IF EXISTS (
        SELECT 1 FROM bonos_solicitados
        WHERE asignacion_id = p_asignacion_id AND estado IN ('aprobado', 'modificado')
    ) THEN
        RAISE EXCEPTION 'ANTECEDENTE_SENSIBLE_BONO: esta asignación tiene un bono de distancia aprobado con monto real';
    END IF;

    -- Protección contra dos designaciones vigentes incompatibles.
    SELECT EXISTS (
        SELECT 1 FROM asignaciones
        WHERE rodeo_id = v_anterior.rodeo_id
          AND usuario_pagado_id = p_usuario_pagado_id_nuevo
          AND id <> p_asignacion_id
          AND estado = 'activo'
          AND COALESCE(estado_designacion, 'pendiente') <> 'rechazado'
    ) INTO v_ya_designado;
    IF v_ya_designado THEN
        RAISE EXCEPTION 'JURADO_YA_DESIGNADO_EN_RODEO';
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM asignaciones a2
        JOIN rodeos r2 ON r2.id = a2.rodeo_id
        WHERE a2.usuario_pagado_id = p_usuario_pagado_id_nuevo
          AND a2.id <> p_asignacion_id
          AND a2.rodeo_id <> v_rodeo_id
          AND a2.estado <> 'anulado'
          AND (r2.fecha + (COALESCE(r2.duracion_dias, 1) - 1) * INTERVAL '1 day')::date >= v_rodeo_fecha
          AND r2.fecha <= (v_rodeo_fecha + (COALESCE(v_rodeo_duracion, 1) - 1) * INTERVAL '1 day')::date
    ) INTO v_cruce_otro_rodeo;
    IF v_cruce_otro_rodeo THEN
        RAISE EXCEPTION 'CRUCE_DISPONIBILIDAD: el jurado nuevo ya está asignado a otro rodeo en fechas que se cruzan';
    END IF;

    UPDATE bonos_solicitados
        SET estado = 'desvinculado_por_cambio_designacion', updated_at = now()
        WHERE asignacion_id = p_asignacion_id AND estado IN ('pendiente', 'aprobado_auto');

    -- ÚNICO CAMBIO REAL de esta migración respecto a 084: se agrega
    -- duracion_dias_aplicada = COALESCE(v_rodeo_duracion, 1) — ya se
    -- recalculaba pago_base_calculado con esa misma duración vigente, pero
    -- nunca se sincronizaba también la columna de duración.
    UPDATE asignaciones SET
        usuario_pagado_id        = p_usuario_pagado_id_nuevo,
        nombre_importado         = v_nuevo_jurado.nombre_completo,
        categoria_aplicada       = p_categoria_aplicada_nueva,
        valor_diario_aplicado    = p_valor_diario_aplicado_nuevo,
        duracion_dias_aplicada   = COALESCE(v_rodeo_duracion, 1),
        pago_base_calculado      = p_pago_base_calculado_nuevo,
        estado_designacion       = 'pendiente',
        aceptado_en              = NULL,
        observacion_designacion  = NULL,
        distancia_km             = NULL,
        updated_at               = now()
    WHERE id = p_asignacion_id
    RETURNING * INTO v_nueva;

    v_bitacora := registrar_movimiento_designacion(
        p_tipo_movimiento            := p_tipo_movimiento,
        p_rodeo_id                   := v_anterior.rodeo_id,
        p_actor_id                   := p_actor_id,
        p_propuesta_detalle_id       := v_anterior.propuesta_detalle_id,
        p_asignacion_id              := p_asignacion_id,
        p_usuario_pagado_id_anterior := v_anterior.usuario_pagado_id,
        p_nombre_anterior_snapshot   := v_anterior.nombre_importado,
        p_usuario_pagado_id_nuevo    := p_usuario_pagado_id_nuevo,
        p_nombre_nuevo_snapshot      := v_nuevo_jurado.nombre_completo,
        p_motivo_catalogo_id         := p_motivo_catalogo_id,
        p_motivo_detalle             := p_motivo_detalle,
        p_actor_tipo                 := 'administrador',
        p_fecha_efectiva             := p_fecha_efectiva,
        p_operacion_id               := p_operacion_id
    );

    RETURN jsonb_build_object(
        'asignacion', row_to_json(v_nueva),
        'bitacora_id', v_bitacora.id,
        'usuario_pagado_id_anterior', v_anterior.usuario_pagado_id,
        'nombre_anterior_snapshot', v_anterior.nombre_importado
    );
END;
$$;

REVOKE ALL ON FUNCTION reemplazar_jurado_asignacion_con_bitacora(
    UUID, UUID, TEXT, INTEGER, INTEGER, UUID, UUID, TEXT, UUID, TEXT, TIMESTAMPTZ, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION reemplazar_jurado_asignacion_con_bitacora(
    UUID, UUID, TEXT, INTEGER, INTEGER, UUID, UUID, TEXT, UUID, TEXT, TIMESTAMPTZ, UUID
) TO service_role;

COMMENT ON FUNCTION reemplazar_jurado_asignacion_con_bitacora IS
    'Fase 1B + corrección 091: único camino que conecta un cambio de jurado de una asignación con bitacora_designaciones, de forma atómica. Ahora también sincroniza duracion_dias_aplicada con la duración vigente del rodeo (antes solo recalculaba pago_base_calculado), y rechaza (PAGO_BASE_INCONSISTENTE_CON_DURACION) cualquier pago recibido que no corresponda exactamente a valor_diario_aplicado_nuevo × la duración vigente del rodeo, leída bajo lock dentro de la misma transacción. Bloquea si hay antecedentes sensibles, designación incompatible o cruce de disponibilidad. Bonos pendientes/aprobado_auto se desvinculan, nunca bloquean.';

COMMIT;

-- Reversible:
--   DROP FUNCTION IF EXISTS reparar_sincronizacion_asignaciones_rodeo(UUID, UUID, TEXT, TEXT);
--   DROP FUNCTION IF EXISTS actualizar_tipo_rodeo_y_sincronizar_asignaciones(UUID, UUID, TEXT, INTEGER, UUID, TEXT, TEXT);
--   DROP FUNCTION IF EXISTS _sincronizar_asignaciones_duracion(UUID, INTEGER, UUID, TEXT, TEXT);
--   Para revertir el punto 4 (reemplazar_jurado_asignacion_con_bitacora), volver a aplicar el
--   CREATE OR REPLACE de la migración 084 tal cual está en su archivo original (restaura el
--   UPDATE sin la línea duracion_dias_aplicada) — nunca hacer DROP de esa función: tiene
--   llamadores activos en producción (POST /api/admin/asignaciones/:id/reemplazar).
