-- ═════════════════════════════════════════════════════════════════════════
-- 096_formato_visual_actualizado_pdf_cartilla_delegado.sql
--
-- NO APLICADA — preparada para revisión, pendiente de autorización
-- explícita. No ejecutar contra producción sin aprobación.
--
-- CORREGIDO (revisión del usuario sobre la versión anterior de este mismo
-- archivo — no se creó un script nuevo):
--   1) La función declaraba `p_actor_tipo TEXT DEFAULT 'administrador'`
--      ANTES de `p_motivo TEXT` (sin default) — en PostgreSQL, todo
--      parámetro CON default debe ir DESPUÉS de todos los que no lo
--      tienen; el orden anterior es un CREATE FUNCTION inválido y habría
--      fallado al aplicar la migración. Se reordenó: los 4 parámetros
--      obligatorios primero (incluido p_motivo), los 2 con default al
--      final (p_actor_tipo, p_reemplazo_confirmado — ver punto 2). Como
--      PostgREST/supabase-js siempre llama a las RPC por NOMBRE (nunca
--      posicional), este reordenamiento no requiere cambiar ningún
--      llamador (backend/src/routes/admin/cartillas-delegado.js,
--      database/maintenance/017_...js) — se verificó explícitamente que
--      ambos siguen enviando los parámetros por nombre.
--   2) Se agregó p_reemplazo_confirmado (con default false): si la
--      versión YA tenía una actualización de diseño previa (storage_path_
--      pdf_rediseno con un valor DISTINTO al nuevo) y este parámetro no
--      se envía en true, la función aborta con REEMPLAZO_NO_CONFIRMADO —
--      así una segunda ejecución nunca reemplaza en silencio un PDF
--      rediseñado anterior. El proceso masivo (017) nunca necesita este
--      parámetro: su propia consulta ya excluye las filas que ya tienen
--      storage_path_pdf_rediseno, así que jamás intenta un reemplazo.
--      Queda disponible para el endpoint administrativo puntual, por si
--      se llama dos veces sobre la misma versión fuera del proceso
--      masivo.
--
-- CORREGIDO (segunda revisión del usuario sobre este mismo archivo):
--   3) IDEMPOTENCIA REAL: antes, llamar dos veces con la MISMA ruta
--      insertaba una fila de auditoría en CADA llamada (nada cambiaba,
--      pero quedaba "actualizar_diseno_pdf_version" duplicado). Ahora,
--      si storage_path_pdf_rediseno YA es exactamente esa ruta (IS NOT
--      DISTINCT FROM), la función retorna la fila existente de inmediato
--      — sin INSERT en auditoria ni UPDATE — antes de llegar siquiera a
--      la verificación de reemplazo.
--   4) `AND NOT p_reemplazo_confirmado` se reemplazó por
--      `AND p_reemplazo_confirmado IS NOT TRUE`: en plpgsql, si
--      p_reemplazo_confirmado llega como NULL explícito (no solo
--      omitido), `NOT NULL` es NULL — y un `IF NULL THEN` nunca lanza la
--      excepción, dejando pasar el reemplazo sin confirmación real.
--      `IS NOT TRUE` evalúa a TRUE tanto para NULL como para false,
--      cerrando ese hueco.
--
-- PROPÓSITO:
--   El generador de PDF de la Cartilla Digital de Delegado
--   (backend/src/services/cartilla-delegado-pdf.js) fue rediseñado
--   visualmente (logo institucional, encabezado, portada en bloques). El
--   generador es único (confirmado: 6 llamadas en producción, todas a
--   generarCartillaDelegadoPDF, en admin/cartillas-delegado.js,
--   institucional/cartilla.js y usuario/cartilla-delegado.js — sin
--   implementación paralela) y las cartillas NUEVAS ya usan el diseño
--   nuevo automáticamente, sin requerir ningún cambio de esquema.
--
--   El problema son las cartillas YA ENVIADAS: su PDF quedó congelado en
--   Supabase Storage (cartillas_delegado_versiones.storage_path_pdf) con
--   el diseño ANTERIOR, y GET /version/:version_id/pdf nunca lo
--   regenera — solo firma una URL hacia el archivo ya subido.
--
--   La funcionalidad existente POST /version/:version_id/regenerar-pdf +
--   la RPC adjuntar_pdf_version_cartilla_delegado (migración 092) permiten
--   regenerar el PDF de una versión desde su snapshot inmutable — pero
--   SOBRESCRIBEN storage_path_pdf en la misma columna. Usarlas tal cual
--   para "actualizar el diseño" de cartillas históricas violaría el
--   requisito explícito de "conservar el PDF original de cada versión,
--   mantener acceso a él como respaldo histórico" — la ruta anterior solo
--   quedaría recuperable buceando en auditoria.datos_anteriores, nunca
--   desde la UI.
--
--   Por eso esta migración NO modifica ni reutiliza esa ruta de reemplazo
--   para este caso. En vez de eso, agrega una columna NUEVA y ADITIVA
--   (storage_path_pdf_rediseno) que nunca pisa storage_path_pdf (el
--   original permanece intacto, siempre) y una RPC NUEVA, propia, que
--   SIEMPRE exige actor+motivo (a diferencia de adjuntar_pdf_version_
--   cartilla_delegado, que solo lo exige en un reemplazo) — porque aquí
--   "actualizar el diseño" nunca es la recuperación automática de un
--   adjunto fallido, siempre es una decisión administrativa deliberada.
--
-- CONTENIDO:
--   1) ALTER TABLE cartillas_delegado_versiones: agrega
--      storage_path_pdf_rediseno TEXT (nullable, aditiva — no afecta
--      ninguna fila ni consulta existente).
--   2) CREATE FUNCTION actualizar_diseno_pdf_version_cartilla_delegado:
--      adjunta esa ruta nueva, exige actor_id + motivo SIEMPRE, exige
--      confirmación explícita si ya existía una actualización previa
--      distinta, y deja auditoría de cada actualización (quién, cuándo,
--      por qué, ruta anterior si la hubo).
--
-- QUÉ NO TOCA (requisito explícito del usuario):
--   - storage_path_pdf (el PDF original) — jamás se escribe ni se borra
--     desde esta migración ni desde la RPC nueva.
--   - snapshot, numero_version, estado_version, enviada_en/por,
--     motivo_reapertura_previa y demás columnas de auditoría del envío
--     original — ninguna se lee ni se modifica.
--   - cartillas_jurado, adjuntos subidos manualmente (rodeo_adjuntos),
--     notas, evaluaciones, pagos, designaciones, permisos — fuera de
--     alcance, ninguna tabla de esos dominios aparece aquí.
--   - La RPC adjuntar_pdf_version_cartilla_delegado (092) — sigue
--     existiendo intacta, para su propio caso de uso (recuperar un PDF
--     que falló tras el envío real). No se reutiliza para el rediseño
--     para no mezclar dos intenciones distintas bajo la misma columna.
--   - Las funcionalidades "Corre por los premios" / "Deja puntos para la
--     próxima temporada" (registros independientes de colleras) son un
--     requerimiento completamente distinto — no aparecen en ninguna
--     línea de este archivo, intencionalmente.
--
-- Depende de: 092 (tabla cartillas_delegado_versiones y la función
-- adjuntar_pdf_version_cartilla_delegado, usada aquí solo como referencia
-- de estilo, no se invoca).
--
-- VALIDADA (ver backend/src/services/formatoVisualActualizadoPdfCartilla
-- Delegado.rpc.test.js): este archivo se aplica tal cual, en secuencia,
-- contra un PostgreSQL REAL de prueba (PGlite — no un mock de Node, un
-- motor Postgres real embebido), igual patrón que reaperturaVersionadoCar
-- tillaDelegado.rpc.test.js para 092. Esa prueba confirma que el CREATE
-- FUNCTION no falla (el bug de orden de parámetros corregido en la
-- primera revisión se habría detectado ahí de inmediato) y ejercita cada
-- camino: éxito, SIN_PDF_ORIGINAL, ACTOR_REQUERIDO, MOTIVO_REQUERIDO,
-- REEMPLAZO_NO_CONFIRMADO con p_reemplazo_confirmado en false Y en NULL
-- explícito (el hueco de la segunda revisión), reemplazo confirmado,
-- idempotencia real con exactamente 1 fila de auditoría tras 2 llamadas
-- con la misma ruta, y los privilegios reales de BD (anon/authenticated
-- rechazados, service_role permitido).
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- 1) Columna nueva, aditiva. NULL = todavía no se generó una versión con
--    el diseño nuevo para esa fila histórica — el PDF original sigue
--    siendo la única fuente hasta que se actualice explícitamente.
ALTER TABLE cartillas_delegado_versiones
    ADD COLUMN IF NOT EXISTS storage_path_pdf_rediseno TEXT;

COMMENT ON COLUMN cartillas_delegado_versiones.storage_path_pdf_rediseno IS
    'Ruta en Storage de una regeneración del PDF con el diseño visual actualizado (logo + portada en bloques, Nov-2026), generada a partir del MISMO snapshot inmutable de esta fila. Nunca sobrescribe ni reemplaza storage_path_pdf (el PDF original enviado permanece siempre accesible). NULL = esta versión histórica aún no fue actualizada visualmente.';

-- 2) RPC de actualización de diseño — actor y motivo SIEMPRE obligatorios
--    (a diferencia de adjuntar_pdf_version_cartilla_delegado, que solo los
--    exige en un reemplazo): esto nunca es la recuperación automática de
--    un adjunto fallido, siempre es una decisión administrativa explícita
--    de actualizar la presentación visual de un documento ya oficial.
--    Parámetros CON default (p_actor_tipo, p_reemplazo_confirmado) van
--    AL FINAL — regla de PostgreSQL, corregida en esta revisión.
CREATE OR REPLACE FUNCTION actualizar_diseno_pdf_version_cartilla_delegado(
    p_version_historica_id      UUID,
    p_storage_path_pdf_rediseno TEXT,
    p_actor_id                  UUID,
    p_motivo                    TEXT,
    p_actor_tipo                TEXT DEFAULT 'administrador',
    p_reemplazo_confirmado      BOOLEAN DEFAULT false
) RETURNS cartillas_delegado_versiones
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_actual    cartillas_delegado_versiones;
    v_resultado cartillas_delegado_versiones;
BEGIN
    IF p_storage_path_pdf_rediseno IS NULL OR btrim(p_storage_path_pdf_rediseno) = '' THEN
        RAISE EXCEPTION 'STORAGE_PATH_PDF_REDISENO_REQUERIDO: la ruta del PDF actualizado no puede ser nula ni vacía';
    END IF;
    IF p_actor_id IS NULL THEN
        RAISE EXCEPTION 'ACTOR_REQUERIDO: toda actualización de diseño debe quedar atribuida a un administrador';
    END IF;
    IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN
        RAISE EXCEPTION 'MOTIVO_REQUERIDO: toda actualización de diseño debe declarar un motivo';
    END IF;

    SELECT * INTO v_actual FROM cartillas_delegado_versiones WHERE id = p_version_historica_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'VERSION_HISTORICA_NO_ENCONTRADA';
    END IF;

    -- No tiene sentido "actualizar el diseño" de una versión que nunca
    -- tuvo un PDF original — eso es un caso para regenerar-pdf (092), no
    -- para esta RPC. Se reporta como excepción, nunca se inventa un
    -- original a partir de la nada.
    IF v_actual.storage_path_pdf IS NULL THEN
        RAISE EXCEPTION 'SIN_PDF_ORIGINAL: esta versión no tiene un PDF original adjunto — use regenerar-pdf para generarlo por primera vez';
    END IF;

    -- Idempotencia real: la MISMA ruta que ya está adjunta no es un
    -- cambio — se retorna la fila tal cual, sin auditar ni actualizar de
    -- nuevo. Evita auditoría duplicada en reintentos (ej. el llamador no
    -- recibió la respuesta de un éxito previo y reintenta con la misma
    -- ruta ya subida).
    IF v_actual.storage_path_pdf_rediseno IS NOT DISTINCT FROM p_storage_path_pdf_rediseno THEN
        RETURN v_actual;
    END IF;

    -- Seguridad ante reejecución con una ruta DISTINTA: esto es un
    -- reemplazo de un rediseño anterior (no el primer adjunto, ya cubierto
    -- arriba) — exige confirmación explícita, nunca lo hace en silencio.
    -- `IS NOT TRUE` (no `NOT p_reemplazo_confirmado`): si el parámetro
    -- llega como NULL explícito, `NOT NULL` es NULL y nunca dispararía la
    -- excepción — `IS NOT TRUE` sí la dispara tanto para NULL como false.
    -- El proceso masivo (017) nunca llega a este camino: su propia
    -- consulta excluye filas con storage_path_pdf_rediseno ya adjunto.
    IF v_actual.storage_path_pdf_rediseno IS NOT NULL
       AND p_reemplazo_confirmado IS NOT TRUE THEN
        RAISE EXCEPTION 'REEMPLAZO_NO_CONFIRMADO: esta versión ya tiene una actualización de diseño previa — reemplazarla exige p_reemplazo_confirmado = true';
    END IF;

    -- storage_path_pdf (el original) NUNCA se lee más allá de esta
    -- verificación, ni se modifica — solo se escribe la columna nueva.
    INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES (
        'cartillas_delegado_versiones', p_version_historica_id::text, 'actualizar_diseno_pdf_version',
        jsonb_build_object('storage_path_pdf_rediseno', v_actual.storage_path_pdf_rediseno),
        jsonb_build_object('storage_path_pdf_rediseno', p_storage_path_pdf_rediseno),
        p_actor_id::text, p_actor_tipo,
        format('Actualización del diseño visual del PDF de la versión %s — el PDF original (storage_path_pdf) no se modifica — motivo: %s', v_actual.numero_version, btrim(p_motivo))
    );

    UPDATE cartillas_delegado_versiones
       SET storage_path_pdf_rediseno = p_storage_path_pdf_rediseno
     WHERE id = p_version_historica_id
    RETURNING * INTO v_resultado;

    RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION actualizar_diseno_pdf_version_cartilla_delegado(UUID, TEXT, UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION actualizar_diseno_pdf_version_cartilla_delegado(UUID, TEXT, UUID, TEXT, TEXT, BOOLEAN) TO service_role;

COMMENT ON FUNCTION actualizar_diseno_pdf_version_cartilla_delegado IS
    'Adjunta una regeneración del PDF con el diseño visual actualizado (storage_path_pdf_rediseno), generada desde el mismo snapshot inmutable de la versión. Actor y motivo SIEMPRE obligatorios (acción administrativa deliberada, nunca automática). Nunca toca storage_path_pdf (el PDF original enviado permanece intacto y accesible). Idempotente: si la ruta ya es exactamente la misma, retorna la fila sin auditar de nuevo. Falla si la versión no tiene un PDF original (SIN_PDF_ORIGINAL), o si ya tenía una actualización previa con una ruta DISTINTA y no se confirma el reemplazo con p_reemplazo_confirmado = true (REEMPLAZO_NO_CONFIRMADO).';

COMMIT;

-- Reversible:
--   DROP FUNCTION IF EXISTS actualizar_diseno_pdf_version_cartilla_delegado(UUID, TEXT, UUID, TEXT, TEXT, BOOLEAN);
--   ALTER TABLE cartillas_delegado_versiones DROP COLUMN IF EXISTS storage_path_pdf_rediseno;
