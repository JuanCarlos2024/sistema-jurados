-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 040 — ETAPA 5: Snapshot inmutable de contenido para intentos
--
-- PROBLEMA:
--   capacitacion_intentos guarda el ORDEN de preguntas y alternativas
--   (orden_preguntas_json / orden_alternativas_json), pero el CONTENIDO
--   (enunciado, imagen_url, video_url, texto de alternativas) se lee fresh
--   de la DB en cada llamada a GET /iniciar.
--   Si un admin edita una pregunta mientras hay un intento activo, el usuario
--   ve el contenido nuevo al recargar, rompiendo la estabilidad del examen.
--
-- SOLUCIÓN:
--   Nueva columna snapshot_contenido_json en capacitacion_intentos.
--   Al crear un intento (primera llamada a /iniciar), el backend congela
--   el contenido en este JSON. En llamadas posteriores (retomar), el backend
--   usa el snapshot para enunciados, imágenes, videos y textos de alternativas.
--   Intentos históricos (columna NULL) siguen usando la DB como fallback.
--
-- ESTRUCTURA del JSON:
--   {
--     "preguntas": {
--       "<uuid>": { "enunciado":"...", "tipo":"...", "imagen_url":"...",
--                   "video_url":"...", "video_sin_audio":false }
--     },
--     "alternativas": {
--       "<uuid>": "texto de la alternativa"
--     }
--   }
--
-- IDEMPOTENTE: ADD COLUMN IF NOT EXISTS es seguro en ejecuciones repetidas.
-- REVERSIÓN:
--   ALTER TABLE capacitacion_intentos DROP COLUMN IF EXISTS snapshot_contenido_json;
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE capacitacion_intentos
    ADD COLUMN IF NOT EXISTS snapshot_contenido_json JSONB;

COMMENT ON COLUMN capacitacion_intentos.snapshot_contenido_json IS
'Snapshot inmutable del contenido de la prueba al crear el intento '
'(enunciado, imagen, video, texto de alternativas). '
'NULL en intentos históricos → el backend usa la DB como fallback.';

COMMIT;

-- Verificación
DO $$
BEGIN
    RAISE NOTICE 'snapshot_contenido_json exists: %',
        (SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE  table_name   = 'capacitacion_intentos'
            AND    column_name  = 'snapshot_contenido_json'
        ));
END $$;
