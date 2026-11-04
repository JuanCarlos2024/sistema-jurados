-- ═════════════════════════════════════════════════════════════════════════
-- 092_reapertura_versionado_cartilla_delegado.sql
--
-- NO APLICADA — preparada localmente, pendiente de autorización explícita.
--
-- Implementa "Reabrir" para la Cartilla Digital de Delegado (ambas
-- modalidades: Delegado de Asociación y Delegado Rentado), tomando como
-- referencia conceptual la funcionalidad equivalente ya existente para
-- cartillas_jurado — pero corrigiendo dos defectos reales detectados al
-- auditar ese precedente antes de replicarlo (ver más abajo):
--   a) El esquema de "Reabrir" de cartillas_jurado (columnas es_actual,
--      version, motivo_reapertura, reabierta_por, reabierta_en,
--      reemplaza_cartilla_id) NUNCA quedó en ninguna migración versionada
--      del repositorio — se aplicó directamente en producción fuera del
--      flujo de control de cambios. Esta migración SÍ queda completa y
--      versionada aquí.
--   b) El endpoint POST /admin/cartillas-jurado/:id/reabrir registra su
--      auditoría EN SEGUNDO PLANO, después de responder al cliente (best
--      effort, no transaccional) — si esa inserción fallara, la cartilla
--      quedaría reabierta sin ningún rastro de auditoría. Las funciones de
--      esta migración registran su auditoría DENTRO de la misma transacción
--      que la escritura principal (mismo criterio ya establecido en 070/091):
--      si la auditoría falla, la reapertura/envío tampoco queda aplicada.
--
-- Depende de (asumidas ya aplicadas en producción — el código vivo de este
-- mismo repo, incluyendo un fix ya desplegado sobre "Delegado Oficial" en
-- la cartilla institucional, solo funciona si estas migraciones ya están
-- activas, pese a que cada una se autodeclaró "NO APLICADA" en su propio
-- encabezado al momento de escribirse):
--   037 (tabla base cartillas_delegado)
--   065 (origen institucional + columna `version` para concurrencia óptica)
--   069 (auditoria.actor_tipo admite 'cuenta_institucional')
--   070 (actualizar_cartilla_institucional_con_auditoria, jsonb_populate_record)
--   072 (CHECK de estado admite 'reenviada')
-- Si alguna de estas NO estuviera realmente aplicada, esta migración falla
-- de forma segura (columna/función inexistente) — nunca se aplica a medias.
--
-- CONTENIDO:
--   1) ALTER TABLE cartillas_delegado: amplía el CHECK de `estado` con
--      'reabierta'; agrega motivo_reapertura/reabierta_por/reabierta_en
--      (limpiadas automáticamente al reenviar, ver función 3) y
--      numero_version_actual (NULL hasta el primer envío oficial; cuenta
--      versiones oficiales enviadas — CONCEPTO DISTINTO de `version`, que
--      sigue siendo exclusivamente el control de concurrencia optimista de
--      065: cada guardado de borrador institucional también incrementa
--      `version`, pero NUNCA crea una versión oficial. Nunca confundir
--      ambos campos — ver nota en el propio código, services/routes).
--   2) Tabla NUEVA cartillas_delegado_versiones: historial INMUTABLE,
--      append-only (nunca se actualiza ni se borra una fila existente,
--      salvo adjuntar su storage_path_pdf una única vez tras subir el PDF —
--      ver función 3 y los routers). Cada fila es una copia congelada
--      completa (snapshot JSONB = la fila de cartillas_delegado tal como
--      quedó justo en el momento de ESE envío/reenvío oficial), más la
--      ruta de su PDF propio en Storage y, si corresponde, el motivo/autor/
--      fecha de la reapertura que dio origen a ese reenvío. A diferencia
--      del patrón de cartillas_jurado (que inserta una fila nueva en la
--      MISMA tabla por cada versión, con es_actual/reemplaza_cartilla_id),
--      aquí la fila "viva" de cartillas_delegado sigue siendo una sola por
--      rodeo+delegado — se preservan intactos los índices únicos de 037/065
--      sin necesidad de volverlos parciales ni tocar ningún lector existente
--      (admin, ambos portales, reportes) que ya asume una sola fila.
--   3) RPC reabrir_cartilla_delegado(...): válido desde 'enviada',
--      'reenviada', 'aprobada' o 'cerrada' (ver nota de diseño sobre
--      'cerrada' más abajo). Exige motivo no vacío. Bloquea la fila con
--      FOR UPDATE antes de escribir. Auditoría transaccional. REVISIÓN
--      FINAL (previa a publicación, punto A): si la cartilla nunca tuvo
--      una versión bajo este esquema (`numero_version_actual IS NULL` —
--      es decir, fue enviada/aprobada/cerrada ANTES de esta migración),
--      reconstruye primero una "v1" histórica con su contenido actual
--      (best-effort: reenviada_en indica si corresponde "enviada" o
--      "reenviada"; enviada_en/actualizado_por/actualizado_por_cuenta_
--      institucional_id dan la fecha/autor aproximados) ANTES de limpiar
--      nada — nunca se pierde la primera versión de una cartilla histórica.
--   4) RPC registrar_envio_oficial_cartilla_delegado(...): paso final
--      ATÓMICO de CUALQUIER envío/reenvío oficial (el primero también, no
--      solo los reenvíos tras una reapertura) — aplica los cambios de
--      contenido (mismo mecanismo jsonb_populate_record que ya usa 070),
--      fija el estado recibido explícitamente (nunca confía en un `estado`
--      que pudiera venir dentro de p_cambios), limpia motivo_reapertura/
--      reabierta_por/reabierta_en si los había, incrementa
--      numero_version_actual, INSERTA la fila histórica inmutable
--      correspondiente y su auditoría — todo en una sola transacción. Sirve
--      a AMBAS modalidades (parámetro p_actor_tipo distingue
--      'usuario_pagado' de 'cuenta_institucional'); el control de
--      concurrencia optimista (p_version_esperada) es OPCIONAL — NULL para
--      Delegado Rentado (que hoy no lo usa en absoluto, fuera de alcance
--      retrofit-earlo acá) y obligatorio para Delegado de Asociación
--      (mismo criterio que ya exige actualizar_cartilla_institucional_con_
--      auditoria). El PDF en sí NUNCA se genera ni se sube dentro de esta
--      función (requiere I/O de Storage, incompatible con una transacción
--      SQL) — los routers lo generan/suben DESPUÉS de que esta función
--      confirma el envío, y adjuntan storage_path_pdf con un UPDATE
--      puntual sobre la fila histórica ya creada; si ese paso fallara,
--      el envío oficial ya quedó aplicado igual (el PDF es una
--      conveniencia de consulta sobre el snapshot JSONB, que es la fuente
--      de verdad real y siempre completa).
--
-- SEGUNDA REVISIÓN FINAL (previa a publicación) — dos observaciones más:
--   e) adjuntar_pdf_version_cartilla_delegado permitía sobrescribir
--      storage_path_pdf de cualquier versión sin ninguna restricción,
--      incluso si ya tenía un PDF congelado. Ahora: adjuntar un PDF cuando
--      la versión AÚN NO tiene uno (adjunto automático tras un envío, o
--      recuperación de un PDF que falló — punto B) sigue funcionando igual,
--      sin fricción; pero REEMPLAZAR un PDF ya existente por otro distinto
--      exige actor y motivo explícitos, y deja un registro de auditoría
--      (ruta anterior, ruta nueva, motivo) ANTES de aplicarlo.
--   f) cartillas_delegado_versiones.cartilla_delegado_id usaba ON DELETE
--      CASCADE — un borrado directo de la fila "viva" (nadie en el código
--      lo hace hoy, pero nada lo impedía a nivel de base de datos) habría
--      arrastrado silenciosamente todo su historial inmutable. Cambiado a
--      ON DELETE RESTRICT: bloquea ese borrado en vez de cascadearlo.
--      Confirmado por grep exhaustivo que ningún endpoint ejecuta un DELETE
--      real sobre cartillas_delegado ni sobre rodeos (el "eliminar rodeo"
--      administrativo es un soft-delete por UPDATE estado='anulado') — este
--      cambio no interfiere con ninguna operación administrativa existente.
--
-- TERCERA REVISIÓN FINAL (previa a publicación) — un hallazgo real más, y
-- una verificación adicional pedida:
--   g) El punto A original solo cubría "Reabrir". El flujo YA EXISTENTE
--      "Observar" (que marca estado='observada' con un UPDATE directo,
--      sin pasar nunca por reabrir_cartilla_delegado) podía dejar una
--      cartilla pre-092 enviada→observada→reenviada SIN backfill: el
--      envío original se perdía y el reenvío quedaba mal numerado como
--      "v1" en vez de "v2". Se extrajo la reconstrucción de la v1 a una
--      función interna compartida (sección 2.5) que ahora ejecutan TANTO
--      reabrir_cartilla_delegado COMO registrar_envio_oficial_cartilla_
--      delegado (esta última, solo si la cartilla viene de 'observada' con
--      numero_version_actual todavía NULL — nunca para un primer envío
--      real desde 'borrador', que no tiene nada previo que preservar).
--   h) Se agrega además una inicialización histórica de una sola vez
--      (sección 2.6) que crea la v1 de toda cartilla ya enviada/reenviada/
--      aprobada/cerrada sin versión bajo este esquema, para que su
--      historial sea visible de inmediato — EXCLUYE deliberadamente
--      'observada' (ver sección 2.6: el PATCH del delegado sigue
--      habilitado en ese estado, así que su contenido actual podría ya
--      estar editado y no ser fiel a lo originalmente enviado/observado;
--      inicializarla ahora la presentaría, incorrectamente, como si esas
--      respuestas ya editadas fueran "la versión original"). Esas
--      cartillas se backfillean de forma segura y tardía, recién al
--      reenviarse (punto g).
--   i) Verificación adicional: adjuntar_pdf_version_cartilla_delegado ahora
--      también rechaza una p_storage_path_pdf nula o vacía (antes solo
--      protegía el REEMPLAZO de una ruta ya existente, no validaba la
--      ruta en sí). A nivel de Storage, los 3 puntos de subida (ambos
--      routers de envío y el endpoint admin de regeneración) ya generaban
--      una ruta única con timestamp por intento y usaban `upsert: false`
--      en la subida — confirmado que un reemplazo autorizado nunca
--      sobrescribe el archivo físico anterior en Storage, solo cambia el
--      puntero `storage_path_pdf` tras subir el nuevo archivo a una ruta
--      distinta.
--
-- NOTA DE DISEÑO — por qué 'cerrada' SÍ puede reabrirse: el estado
-- 'cerrada' existe en el CHECK desde 037 pero, a la fecha de esta
-- migración, ningún endpoint lo asigna — es un estado reservado, nunca
-- alcanzado por el código actual. Reabrirlo es seguro bajo el mismo
-- mecanismo que 'aprobada': no borra ni altera ninguna versión histórica
-- ya inmutable, solo habilita un nuevo ciclo de edición/reenvío que crea
-- una versión ADICIONAL. Se incluye por pedido explícito de revisar ese
-- estado y permitir su reapertura "únicamente si se pueden preservar
-- correctamente las reglas actuales de cierre y aprobación" — se preservan,
-- porque ninguna regla de cierre/aprobación existente depende de que
-- 'cerrada'/'aprobada' sean terminales (no hay ningún otro código que lo
-- asuma, confirmado por grep exhaustivo de ambos estados en todo el repo).
--
-- PROTECCIÓN DE NOTA DELEGADO (088) — sin cambios: esta migración no toca
-- sincronizar_nota_delegado_automatica ni su columna de estado. Un reenvío
-- tras una reapertura sigue intentando sincronizar la Nota Delegado, y
-- sigue siendo bloqueado automáticamente si ya fue corregida por un
-- administrador — exactamente igual que cualquier reenvío por "Observar"
-- hoy.
--
-- CONCURRENCIA — mismo orden de locks ya establecido en 091/084 (FOR UPDATE
-- sobre la fila de cartillas_delegado antes de cualquier escritura).
--
-- Migración envuelta en una transacción explícita. Idempotente: CREATE OR
-- REPLACE FUNCTION es seguro de repetir; ADD COLUMN/CONSTRAINT IF NOT
-- EXISTS también. Reversible: ver bloque al final.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1) cartillas_delegado: nuevas columnas + CHECK de estado ampliado
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE cartillas_delegado DROP CONSTRAINT IF EXISTS cartillas_delegado_estado_check;
ALTER TABLE cartillas_delegado ADD CONSTRAINT cartillas_delegado_estado_check
    CHECK (estado IN ('borrador', 'enviada', 'observada', 'aprobada', 'cerrada', 'reenviada', 'reabierta'));

ALTER TABLE cartillas_delegado
    ADD COLUMN IF NOT EXISTS motivo_reapertura      TEXT,
    ADD COLUMN IF NOT EXISTS reabierta_por           UUID,
    ADD COLUMN IF NOT EXISTS reabierta_en            TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS numero_version_actual   INTEGER;

-- REVISIÓN FINAL (previa a publicación, punto D) — mismo hallazgo de "deriva
-- de esquema" que ya documentó 070 ("Pieza 0") para reenviada_en/historial_
-- observaciones: backend/src/routes/admin/cartillas-delegado.js (POST /:id/
-- observar, POST /:id/aprobar) YA escribe observada_en/observado_por/
-- observacion_admin/aprobada_en/aprobado_por desde antes de esta migración,
-- pero ninguna de esas 5 columnas aparece en NINGÚN archivo de migración
-- rastreado. Se agregan aquí, de forma aditiva e idempotente, porque esta
-- migración necesita poder verificar (ver pruebas del punto D) que una
-- aprobación anterior sobrevive intacta a un ciclo de reabrir+reenviar — sin
-- estas columnas documentadas, esa garantía no podría probarse contra un
-- esquema real. Nunca se tocan filas existentes ni se cambia ningún valor ya
-- guardado.
ALTER TABLE cartillas_delegado
    ADD COLUMN IF NOT EXISTS observada_en       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS observado_por      TEXT,
    ADD COLUMN IF NOT EXISTS observacion_admin  TEXT,
    ADD COLUMN IF NOT EXISTS aprobada_en        TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS aprobado_por       TEXT;

COMMENT ON CONSTRAINT cartillas_delegado_estado_check ON cartillas_delegado IS
    'Ampliado (092) para incluir "reabierta" — preserva los 6 valores previos sin cambios (072 ya había agregado "reenviada").';
COMMENT ON COLUMN cartillas_delegado.numero_version_actual IS
    'Cuenta de versiones OFICIALES enviadas (1, 2, 3...) — NULL hasta el primer envío. Concepto DISTINTO de `version` (065), que es control de concurrencia optimista y se incrementa en cada guardado de borrador institucional, no solo en los envíos oficiales. Nunca usar uno por el otro.';
COMMENT ON COLUMN cartillas_delegado.motivo_reapertura IS
    'Motivo de la reapertura vigente (obligatorio al reabrir) — se limpia automáticamente al reenviar (ver registrar_envio_oficial_cartilla_delegado), quedando archivado en cartillas_delegado_versiones.motivo_reapertura_previa de esa versión.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2) Historial inmutable de versiones oficiales
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cartillas_delegado_versiones (
    id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- REVISIÓN FINAL (previa a publicación): RESTRICT, no CASCADE — un
    -- historial inmutable nunca debe desaparecer silenciosamente porque
    -- alguien borró la fila "viva" de cartillas_delegado (accidental o no).
    -- Confirmado por grep exhaustivo: ningún endpoint de este sistema
    -- ejecuta un DELETE real sobre cartillas_delegado ni sobre rodeos (el
    -- "eliminar rodeo" del admin es un soft-delete — solo UPDATE estado=
    -- 'anulado', nunca un DELETE) — RESTRICT no interfiere con ninguna
    -- operación administrativa existente, solo bloquea un borrado directo
    -- en SQL que nadie en el código hace hoy.
    cartilla_delegado_id        UUID        NOT NULL REFERENCES cartillas_delegado(id) ON DELETE RESTRICT,
    numero_version              INTEGER     NOT NULL,
    estado_version              TEXT        NOT NULL CHECK (estado_version IN ('enviada', 'reenviada')),
    -- Copia completa e inmutable de la fila de cartillas_delegado tal como
    -- quedó en el momento exacto de este envío/reenvío (incluye
    -- respuestas_json, datos del delegado, observaciones, notas, fechas —
    -- todo lo que el formulario guarda). Nunca se recalcula ni se reemplaza.
    snapshot                    JSONB       NOT NULL,
    storage_path_pdf            TEXT,
    -- Motivo/autor/fecha de la reapertura que dio origen a ESTE reenvío —
    -- NULL para la versión 1 (nunca hubo reapertura previa a un primer envío).
    motivo_reapertura_previa    TEXT,
    reabierta_por_previa        UUID,
    reabierta_en_previa         TIMESTAMPTZ,
    enviada_en                  TIMESTAMPTZ NOT NULL,
    enviada_por                 UUID,
    enviada_por_tipo            TEXT        NOT NULL CHECK (enviada_por_tipo IN ('usuario_pagado', 'cuenta_institucional')),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_cartilla_delegado_version UNIQUE (cartilla_delegado_id, numero_version)
);

CREATE INDEX IF NOT EXISTS idx_cartillas_delegado_versiones_cartilla
    ON cartillas_delegado_versiones(cartilla_delegado_id);

-- Mismo criterio ya usado desde 071/079/081/083/088 para tablas nuevas: RLS
-- habilitada SIN políticas (deniega todo por defecto salvo a roles con
-- BYPASSRLS, como service_role) — defensa en profundidad adicional, nunca
-- el único mecanismo de control de acceso (el backend ya valida permisos
-- antes de cualquier lectura/escritura). cartillas_delegado (tabla anterior
-- a este patrón) no la tiene — no se retrofittea acá, fuera de alcance.
ALTER TABLE cartillas_delegado_versiones ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE cartillas_delegado_versiones IS
    'Historial inmutable de versiones oficiales (enviada/reenviada) de una cartilla de delegado. Append-only: nunca se actualiza ni se borra una fila existente, salvo adjuntar storage_path_pdf una única vez tras subir el PDF a Storage.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2.5) Función interna: reconstruye la v1 histórica best-effort de una
--      cartilla que nunca tuvo versión bajo este esquema. Uso exclusivo de
--      las RPCs públicas de abajo y de la inicialización histórica que
--      corre una sola vez más abajo — no se expone a clientes.
--
-- TERCERA REVISIÓN FINAL (previa a publicación) — hallazgo real: el punto A
-- de la revisión anterior solo backfilleaba al ejecutar "Reabrir". Pero el
-- flujo YA EXISTENTE "Observar" (POST /admin/cartillas-delegado/:id/
-- observar, sin cambios en esta migración) marca estado='observada' con un
-- UPDATE directo que NUNCA pasa por reabrir_cartilla_delegado. Una cartilla
-- anterior a esta migración que fue enviada → observada → reenviada llegaba
-- a registrar_envio_oficial_cartilla_delegado con numero_version_actual
-- todavía NULL: el contenido originalmente enviado se perdía igual (el
-- UPDATE de esa función sobrescribe los campos editables) y, peor, el
-- reenvío quedaba mal numerado como "v1 reenviada" en vez de "v2" — ni
-- siquiera llegaba a existir ya una v1 que lo precediera. Se extrae aquí la
-- lógica de reconstrucción (antes duplicada solo dentro de reabrir) para
-- que AMBAS RPCs la ejecuten antes de sobrescribir nada, cubriendo también
-- el camino por "Observar" — ver la nota en registrar_envio_oficial_
-- cartilla_delegado más abajo. Idempotente (ON CONFLICT DO NOTHING sobre la
-- UNIQUE de la tabla): invocarla dos veces sobre la misma cartilla nunca
-- duplica ni falla.
CREATE OR REPLACE FUNCTION backfill_version_inicial_cartilla_delegado(
    p_cartilla cartillas_delegado
) RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF p_cartilla.numero_version_actual IS NOT NULL THEN
        RETURN;
    END IF;

    INSERT INTO cartillas_delegado_versiones (
        cartilla_delegado_id, numero_version, estado_version, snapshot,
        motivo_reapertura_previa, reabierta_por_previa, reabierta_en_previa,
        enviada_en, enviada_por, enviada_por_tipo
    ) VALUES (
        p_cartilla.id, 1,
        CASE WHEN p_cartilla.reenviada_en IS NOT NULL THEN 'reenviada' ELSE 'enviada' END,
        row_to_json(p_cartilla)::jsonb,
        NULL, NULL, NULL,
        COALESCE(p_cartilla.reenviada_en, p_cartilla.enviada_en, now()),
        CASE WHEN p_cartilla.delegado_id IS NOT NULL
             THEN COALESCE(p_cartilla.actualizado_por, p_cartilla.creado_por)
             ELSE COALESCE(p_cartilla.actualizado_por_cuenta_institucional_id, p_cartilla.creado_por_cuenta_institucional_id)
        END,
        CASE WHEN p_cartilla.delegado_id IS NOT NULL THEN 'usuario_pagado' ELSE 'cuenta_institucional' END
    )
    ON CONFLICT (cartilla_delegado_id, numero_version) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION backfill_version_inicial_cartilla_delegado(cartillas_delegado) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION backfill_version_inicial_cartilla_delegado(cartillas_delegado) TO service_role;

COMMENT ON FUNCTION backfill_version_inicial_cartilla_delegado IS
    'Función interna (no expuesta a clientes): reconstruye la v1 histórica best-effort de una cartilla sin versión bajo este esquema. Usada por reabrir_cartilla_delegado, registrar_envio_oficial_cartilla_delegado y por la inicialización histórica de esta misma migración. Idempotente (ON CONFLICT DO NOTHING).';

-- ─────────────────────────────────────────────────────────────────────────
-- 2.6) Inicialización histórica (corre una sola vez, idempotente): crea la
--      v1 de cada cartilla YA enviada/reenviada/aprobada/cerrada que nunca
--      tuvo versión bajo este esquema, para que su historial sea visible
--      de inmediato en GET /:id/versiones sin esperar a que alguien la
--      reabra o reenvíe primero.
--
--      Deliberadamente NO incluye 'observada': en ese estado el PATCH del
--      delegado sigue habilitado (usuario/cartilla-delegado.js e
--      institucional/cartilla.js solo bloquean PATCH para 'enviada',
--      'reenviada', 'aprobada' y 'cerrada' — nunca para 'observada'), así
--      que el contenido actual de una cartilla observada puede ya haber
--      sido editado por el delegado y NO sería fiel a lo que realmente se
--      envió u observó — inicializarla aquí la presentaría, de forma
--      incorrecta, como si esas respuestas ya editadas fueran "la versión
--      original" (exactamente lo que se pidió evitar). Esas cartillas
--      quedan con numero_version_actual aún NULL hasta que se reenvíen; en
--      ese momento, registrar_envio_oficial_cartilla_delegado ejecuta el
--      mismo backfill de forma segura, usando el contenido tal como está
--      justo ANTES de aplicar los cambios de ESE reenvío (ver nota allí) —
--      el mismo criterio de "mejor esfuerzo documentado" ya aceptado para
--      aprobada/cerrada, aplicado en el último momento seguro posible.
--      No modifica ninguna fila de cartillas_delegado — solo inserta en la
--      tabla de historial nueva, nunca sobre datos de producción existentes.
SELECT backfill_version_inicial_cartilla_delegado(cd)
FROM cartillas_delegado cd
WHERE cd.estado IN ('enviada', 'reenviada', 'aprobada', 'cerrada')
  AND cd.numero_version_actual IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- 3) RPC pública: reabrir una cartilla ya enviada
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION reabrir_cartilla_delegado(
    p_cartilla_id   UUID,
    p_motivo        TEXT,
    p_actor_id      UUID,
    p_actor_tipo    TEXT DEFAULT 'administrador',
    p_ip_address    TEXT DEFAULT NULL
) RETURNS cartillas_delegado
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_cartilla          cartillas_delegado;
    v_resultado         cartillas_delegado;
    v_numero_backfill   INTEGER;
BEGIN
    IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN
        RAISE EXCEPTION 'MOTIVO_REQUERIDO: el motivo de reapertura es obligatorio';
    END IF;
    IF p_actor_id IS NULL THEN
        RAISE EXCEPTION 'ACTOR_REQUERIDO';
    END IF;

    SELECT * INTO v_cartilla FROM cartillas_delegado WHERE id = p_cartilla_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'CARTILLA_NO_ENCONTRADA';
    END IF;

    IF v_cartilla.estado NOT IN ('enviada', 'reenviada', 'aprobada', 'cerrada') THEN
        RAISE EXCEPTION 'ESTADO_NO_REABRIBLE: no se puede reabrir una cartilla en estado "%"', v_cartilla.estado;
    END IF;

    -- REVISIÓN FINAL (previa a publicación) — punto A: una cartilla enviada
    -- ANTES de esta migración nunca tuvo fila en cartillas_delegado_
    -- versiones (`numero_version_actual` quedó NULL). Sin este backfill, su
    -- contenido ORIGINAL (el que está en esta misma fila justo ahora) se
    -- perdería en cuanto el delegado corrija y reenvíe — el UPDATE de
    -- registrar_envio_oficial_cartilla_delegado sobrescribe los campos
    -- editables de la fila viva. Se reconstruye aquí, ANTES de tocar nada,
    -- una "v1" histórica con el contenido tal como estaba justo antes de
    -- esta reapertura. Reconstrucción best-effort del estado/fecha/autor
    -- original (el esquema previo a 092 nunca distinguió cuántas veces se
    -- había reenviado antes de aprobar/cerrar, solo si reenviada_en estaba
    -- fijada) — documentado explícitamente, no una inferencia perfecta.
    -- TERCERA REVISIÓN FINAL: delega en la función interna compartida (ver
    -- sección 2.5 más arriba) — misma lógica de antes, ahora también
    -- reutilizada por registrar_envio_oficial_cartilla_delegado para cubrir
    -- el camino por "Observar" (ver la nota allí).
    PERFORM backfill_version_inicial_cartilla_delegado(v_cartilla);
    v_numero_backfill := COALESCE(v_cartilla.numero_version_actual, 1);

    UPDATE cartillas_delegado SET
        estado                 = 'reabierta',
        motivo_reapertura      = btrim(p_motivo),
        reabierta_por          = p_actor_id,
        reabierta_en           = now(),
        numero_version_actual  = v_numero_backfill,
        updated_at             = now()
    WHERE id = p_cartilla_id
    RETURNING * INTO v_resultado;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion, ip_address)
    VALUES (
        'cartillas_delegado', p_cartilla_id::text, 'reabrir_cartilla',
        jsonb_build_object('estado', v_cartilla.estado),
        jsonb_build_object('estado', 'reabierta', 'motivo_reapertura', btrim(p_motivo)),
        p_actor_id::text, p_actor_tipo,
        format('Reapertura de cartilla de delegado (estado previo: %s) — motivo: %s', v_cartilla.estado, btrim(p_motivo)),
        p_ip_address
    );

    RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION reabrir_cartilla_delegado(UUID, TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reabrir_cartilla_delegado(UUID, TEXT, UUID, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION reabrir_cartilla_delegado IS
    'Reabre una cartilla de delegado (Asociación o Rentado) ya enviada/reenviada/aprobada/cerrada para que el delegado la corrija y reenvíe. Exige motivo no vacío. Si la cartilla nunca tuvo versión bajo este esquema (enviada antes de esta migración), reconstruye primero su "v1" histórica con el contenido actual — nunca se pierde la primera versión. Auditoría transaccional: si falla, la reapertura tampoco queda aplicada.';

-- ─────────────────────────────────────────────────────────────────────────
-- 4) RPC pública: paso final atómico de un envío/reenvío oficial
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION registrar_envio_oficial_cartilla_delegado(
    p_cartilla_id       UUID,
    p_version_esperada  INTEGER,
    p_cambios           JSONB,
    p_estado_nuevo      TEXT,
    p_actor_id          UUID,
    p_actor_tipo        TEXT,
    p_ip_address        TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_actual                cartillas_delegado;
    v_merged                cartillas_delegado;
    v_resultado             cartillas_delegado;
    v_numero_version        INTEGER;
    v_motivo_previo         TEXT;
    v_reabierta_por_previa  UUID;
    v_reabierta_en_previa   TIMESTAMPTZ;
    v_historia_id           UUID;
    v_ahora                 TIMESTAMPTZ := now();
BEGIN
    IF p_estado_nuevo NOT IN ('enviada', 'reenviada') THEN
        RAISE EXCEPTION 'ESTADO_ENVIO_INVALIDO: "%" no es un estado de envío oficial válido', p_estado_nuevo;
    END IF;
    IF p_actor_tipo NOT IN ('usuario_pagado', 'cuenta_institucional') THEN
        RAISE EXCEPTION 'ACTOR_TIPO_INVALIDO: "%"', p_actor_tipo;
    END IF;
    IF p_actor_id IS NULL THEN
        RAISE EXCEPTION 'ACTOR_REQUERIDO';
    END IF;

    SELECT * INTO v_actual FROM cartillas_delegado WHERE id = p_cartilla_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'CARTILLA_NO_ENCONTRADA';
    END IF;

    -- Concurrencia optimista OPCIONAL — NULL para Delegado Rentado (no la
    -- usa hoy, fuera de alcance retrofittearla acá); obligatoria para
    -- Delegado de Asociación (mismo criterio que actualizar_cartilla_
    -- institucional_con_auditoria, 070).
    IF p_version_esperada IS NOT NULL AND v_actual.version <> p_version_esperada THEN
        RAISE EXCEPTION 'CARTILLA_NO_ENCONTRADA_O_VERSION_DESACTUALIZADA';
    END IF;

    IF v_actual.estado NOT IN ('borrador', 'observada', 'reabierta') THEN
        RAISE EXCEPTION 'ESTADO_NO_ENVIABLE: no se puede enviar una cartilla en estado "%"', v_actual.estado;
    END IF;

    -- TERCERA REVISIÓN FINAL (previa a publicación) — mismo punto A, pero
    -- para el camino por "Observar", que NUNCA pasa por reabrir_cartilla_
    -- delegado: si esta cartilla viene de 'observada' y nunca tuvo versión
    -- bajo este esquema (numero_version_actual IS NULL — enviada antes de
    -- esta migración), se reconstruye primero su v1 con el contenido tal
    -- como está AHORA MISMO, justo antes de aplicarle el merge de este
    -- reenvío — el último momento seguro en que ese contenido todavía
    -- representa lo que se envió/observó, sin la corrección que este mismo
    -- reenvío está a punto de aplicar (mismo criterio de "mejor esfuerzo
    -- documentado" ya usado para aprobada/cerrada en reabrir_cartilla_
    -- delegado). Deliberadamente NO se aplica para 'borrador' (un primer
    -- envío real nunca tuvo nada previo que preservar — backfillarlo
    -- inventaría una v1 falsa) ni para 'reabierta' (reabrir_cartilla_
    -- delegado ya lo garantizó antes de llegar aquí).
    IF v_actual.estado = 'observada' AND v_actual.numero_version_actual IS NULL THEN
        PERFORM backfill_version_inicial_cartilla_delegado(v_actual);
        v_numero_version := 2;
    ELSE
        v_numero_version := COALESCE(v_actual.numero_version_actual, 0) + 1;
    END IF;

    -- Se archivan ANTES del merge — el UPDATE de abajo los limpia.
    v_motivo_previo        := v_actual.motivo_reapertura;
    v_reabierta_por_previa := v_actual.reabierta_por;
    v_reabierta_en_previa  := v_actual.reabierta_en;

    -- Mismo mecanismo de fusión que actualizar_cartilla_institucional_con_
    -- auditoria (070): p_cambios es el mismo objeto `updates` que JS ya
    -- construye hoy (campos editables + enviada_en/reenviada_en/
    -- historial_observaciones + version:+1 si corresponde). El `estado`
    -- recibido en p_cambios, si lo hubiera, se IGNORA deliberadamente — el
    -- estado real a escribir es SIEMPRE p_estado_nuevo, explícito.
    SELECT * INTO v_merged FROM jsonb_populate_record(v_actual, p_cambios);

    UPDATE cartillas_delegado SET
        estado                              = p_estado_nuevo,
        enviada_en                          = v_merged.enviada_en,
        reenviada_en                        = v_merged.reenviada_en,
        historial_observaciones             = v_merged.historial_observaciones,
        version                             = v_merged.version,
        numero_version_actual                = v_numero_version,
        motivo_reapertura                   = NULL,
        reabierta_por                       = NULL,
        reabierta_en                        = NULL,
        actualizado_por                     = CASE WHEN p_actor_tipo = 'usuario_pagado' THEN p_actor_id ELSE cartillas_delegado.actualizado_por END,
        actualizado_por_cuenta_institucional_id = CASE WHEN p_actor_tipo = 'cuenta_institucional' THEN p_actor_id ELSE cartillas_delegado.actualizado_por_cuenta_institucional_id END,
        delegado_nombre                      = v_merged.delegado_nombre,
        delegado_telefono                    = v_merged.delegado_telefono,
        secretario_jurado                     = v_merged.secretario_jurado,
        secretario_numero_socio               = v_merged.secretario_numero_socio,
        serie_campeones_dos_vueltas           = v_merged.serie_campeones_dos_vueltas,
        incluye_informe_disciplinario         = v_merged.incluye_informe_disciplinario,
        incluye_informe_ganado_bajo_peso      = v_merged.incluye_informe_ganado_bajo_peso,
        certificacion_medialuna_comuna        = v_merged.certificacion_medialuna_comuna,
        certificacion_mas_200_personas        = v_merged.certificacion_mas_200_personas,
        certificacion_mas_250_personas        = v_merged.certificacion_mas_250_personas,
        certificacion_vinculacion_comunidad   = v_merged.certificacion_vinculacion_comunidad,
        respuestas_json                       = v_merged.respuestas_json,
        updated_at                            = v_ahora
    WHERE id = p_cartilla_id
    RETURNING * INTO v_resultado;

    -- `enviada_en` de la fila histórica = momento REAL de ESTE envío/reenvío
    -- (siempre now()) — deliberadamente INDEPENDIENTE de
    -- cartillas_delegado.enviada_en, que preserva la fecha del primer envío
    -- ORIGINAL a través de reenvíos posteriores (comportamiento existente,
    -- ver usuario/cartilla-delegado.js: `enviada_en: cartilla.enviada_en ||
    -- ahora`). Si se derivara de v_resultado.enviada_en, un reenvío
    -- quedaría con la fecha del primer envío en vez de la suya propia, y un
    -- primer envío sin ese campo en p_cambios violaría el NOT NULL de esta
    -- tabla.
    INSERT INTO cartillas_delegado_versiones (
        cartilla_delegado_id, numero_version, estado_version, snapshot,
        motivo_reapertura_previa, reabierta_por_previa, reabierta_en_previa,
        enviada_en, enviada_por, enviada_por_tipo
    ) VALUES (
        p_cartilla_id, v_numero_version, p_estado_nuevo, row_to_json(v_resultado)::jsonb,
        v_motivo_previo, v_reabierta_por_previa, v_reabierta_en_previa,
        v_ahora, p_actor_id, p_actor_tipo
    )
    RETURNING id INTO v_historia_id;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_nuevos, actor_id, actor_tipo, descripcion, ip_address)
    VALUES (
        'cartillas_delegado', p_cartilla_id::text,
        CASE WHEN p_estado_nuevo = 'reenviada' THEN 'reenviar_cartilla' ELSE 'enviar_cartilla' END,
        jsonb_build_object('numero_version', v_numero_version, 'estado', p_estado_nuevo),
        p_actor_id::text, p_actor_tipo,
        format('%s oficial de cartilla de delegado — versión %s', CASE WHEN p_estado_nuevo = 'reenviada' THEN 'Reenvío' ELSE 'Envío' END, v_numero_version),
        p_ip_address
    );

    RETURN jsonb_build_object(
        'cartilla', row_to_json(v_resultado),
        'numero_version', v_numero_version,
        'version_historica_id', v_historia_id
    );
END;
$$;

REVOKE ALL ON FUNCTION registrar_envio_oficial_cartilla_delegado(UUID, INTEGER, JSONB, TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION registrar_envio_oficial_cartilla_delegado(UUID, INTEGER, JSONB, TEXT, UUID, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION registrar_envio_oficial_cartilla_delegado IS
    'Paso final atómico de CUALQUIER envío/reenvío oficial de una cartilla de delegado (el primer envío también, no solo los reenvíos tras reapertura u observación): aplica los cambios de contenido (mismo mecanismo jsonb_populate_record que 070), fija el estado explícitamente, limpia motivo_reapertura/reabierta_por/reabierta_en, incrementa numero_version_actual, inserta la fila histórica inmutable correspondiente y su auditoría — todo en una sola transacción. Si la cartilla viene de "observada" y nunca tuvo versión bajo este esquema, reconstruye primero su v1 (mismo backfill que reabrir_cartilla_delegado, cubriendo también el camino por "Observar"). Sirve a ambas modalidades vía p_actor_tipo. p_version_esperada es NULL para Delegado Rentado (sin concurrencia optimista hoy) y obligatorio para Delegado de Asociación.';

-- ─────────────────────────────────────────────────────────────────────────
-- 5) Adjuntar el PDF de una versión histórica ya creada (paso posterior,
--    fuera de la transacción de envío — ver routers).
-- ─────────────────────────────────────────────────────────────────────────
-- REVISIÓN FINAL (previa a publicación) — protección del PDF histórico: la
-- versión original permitía sobrescribir storage_path_pdf sin ninguna
-- restricción, incluso si ya tenía un PDF congelado. Ahora:
--   · Si la versión AÚN NO tiene PDF (storage_path_pdf IS NULL) — el caso
--     normal, tanto el adjunto automático tras un envío como la
--     recuperación de un PDF que falló (punto B) — se adjunta directo, sin
--     exigir motivo ni actor (p_actor_id/p_motivo quedan NULL en esos
--     llamadores, sin problema).
--   · Si la versión YA tiene un PDF DISTINTO al nuevo — un reemplazo
--     excepcional de un PDF ya existente — exige p_actor_id y p_motivo no
--     vacíos, y deja un registro de auditoría explícito (ruta anterior,
--     ruta nueva, actor, motivo) ANTES de aplicar el cambio. Nunca permite
--     un reemplazo silencioso.
CREATE OR REPLACE FUNCTION adjuntar_pdf_version_cartilla_delegado(
    p_version_historica_id  UUID,
    p_storage_path_pdf      TEXT,
    p_actor_id              UUID DEFAULT NULL,
    p_actor_tipo            TEXT DEFAULT 'administrador',
    p_motivo                TEXT DEFAULT NULL
) RETURNS cartillas_delegado_versiones
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_actual    cartillas_delegado_versiones;
    v_resultado cartillas_delegado_versiones;
BEGIN
    -- Punto 7 de la tercera revisión final: una ruta nula o vacía nunca es
    -- un valor válido de storage_path_pdf (ni como adjunto inicial ni como
    -- reemplazo) — rechazarla aquí evita dejar una versión "adjunta" sin
    -- PDF real alguno en Storage.
    IF p_storage_path_pdf IS NULL OR btrim(p_storage_path_pdf) = '' THEN
        RAISE EXCEPTION 'STORAGE_PATH_PDF_REQUERIDO: la ruta del PDF no puede ser nula ni vacía';
    END IF;

    SELECT * INTO v_actual FROM cartillas_delegado_versiones WHERE id = p_version_historica_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'VERSION_HISTORICA_NO_ENCONTRADA';
    END IF;

    IF v_actual.storage_path_pdf IS NOT NULL AND v_actual.storage_path_pdf IS DISTINCT FROM p_storage_path_pdf THEN
        IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN
            RAISE EXCEPTION 'MOTIVO_REQUERIDO_PARA_REEMPLAZO: esta versión ya tiene un PDF — reemplazarlo exige un motivo explícito';
        END IF;
        IF p_actor_id IS NULL THEN
            RAISE EXCEPTION 'ACTOR_REQUERIDO_PARA_REEMPLAZO';
        END IF;

        INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion)
        VALUES (
            'cartillas_delegado_versiones', p_version_historica_id::text, 'reemplazar_pdf_version',
            jsonb_build_object('storage_path_pdf', v_actual.storage_path_pdf),
            jsonb_build_object('storage_path_pdf', p_storage_path_pdf),
            p_actor_id::text, p_actor_tipo,
            format('Reemplazo excepcional del PDF de la versión %s — motivo: %s', v_actual.numero_version, btrim(p_motivo))
        );
    END IF;

    UPDATE cartillas_delegado_versiones
       SET storage_path_pdf = p_storage_path_pdf
     WHERE id = p_version_historica_id
    RETURNING * INTO v_resultado;

    RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION adjuntar_pdf_version_cartilla_delegado(UUID, TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION adjuntar_pdf_version_cartilla_delegado(UUID, TEXT, UUID, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION adjuntar_pdf_version_cartilla_delegado IS
    'Adjunta la ruta de Storage del PDF congelado de una versión histórica. Si la versión ya tenía un PDF distinto, exige p_actor_id y p_motivo no vacíos y deja auditoría explícita del reemplazo (ruta anterior/nueva) antes de aplicarlo — nunca sobrescribe en silencio. Si no tenía PDF (adjunto automático tras envío, o recuperación de un PDF que falló), se adjunta directo sin esa exigencia.';

COMMIT;

-- Reversible:
--   DROP FUNCTION IF EXISTS adjuntar_pdf_version_cartilla_delegado(UUID, TEXT, UUID, TEXT, TEXT);
--   DROP FUNCTION IF EXISTS registrar_envio_oficial_cartilla_delegado(UUID, INTEGER, JSONB, TEXT, UUID, TEXT, TEXT);
--   DROP FUNCTION IF EXISTS reabrir_cartilla_delegado(UUID, TEXT, UUID, TEXT, TEXT);
--   DROP FUNCTION IF EXISTS backfill_version_inicial_cartilla_delegado(cartillas_delegado);
--   DROP TABLE IF EXISTS cartillas_delegado_versiones;
--   ALTER TABLE cartillas_delegado DROP COLUMN IF EXISTS numero_version_actual;
--   ALTER TABLE cartillas_delegado DROP COLUMN IF EXISTS reabierta_en;
--   ALTER TABLE cartillas_delegado DROP COLUMN IF EXISTS reabierta_por;
--   ALTER TABLE cartillas_delegado DROP COLUMN IF EXISTS motivo_reapertura;
--   -- (el CHECK de estado NO se revierte si ya existen filas con
--   --  estado='reabierta' — mismo criterio que el rollback de 072).
--   -- observada_en/observado_por/observacion_admin/aprobada_en/aprobado_por
--   -- (punto D) NO se eliminan al revertir: ya estaban en uso real por
--   -- admin/cartillas-delegado.js antes de esta migración (deriva de
--   -- esquema preexistente, no introducida por 092) — eliminarlas rompería
--   -- ese código vigente, igual criterio que 070 aplicó a reenviada_en.
