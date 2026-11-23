-- ═════════════════════════════════════════════════════════════════════════
-- 107: Desglose de "Casos por WhatsApp" del Análisis Deportivo en
--      Bien jurado / Mal jurado (evaluaciones, POR RODEO, igual que
--      casos_whatsapp de la 059).
--
-- ADITIVA:
--   · Dos columnas nuevas NULLABLE, sin DEFAULT: los análisis existentes
--     quedan en NULL = "Sin registrar" (nunca se inventa un 0). No hay UPDATE.
--   · CHECK: o el desglose está vacío (ambos NULL), o ambos son enteros >= 0
--     y suman exactamente casos_whatsapp.
--   · No toca casos_whatsapp, notas, descuentos, publicar_evaluacion ni
--     evaluacion_desempeno_manual (los "Mal jurado" manuales se conservan).
--   · Sin objetos nuevos: los privilegios de evaluaciones no cambian (la
--     verificación 022 sigue aplicando igual).
-- Idempotente.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.evaluaciones
    ADD COLUMN IF NOT EXISTS casos_whatsapp_bien_jurado INTEGER,
    ADD COLUMN IF NOT EXISTS casos_whatsapp_mal_jurado  INTEGER;

ALTER TABLE public.evaluaciones DROP CONSTRAINT IF EXISTS chk_evaluaciones_casos_whatsapp_desglose;
ALTER TABLE public.evaluaciones ADD CONSTRAINT chk_evaluaciones_casos_whatsapp_desglose CHECK (
    (casos_whatsapp_bien_jurado IS NULL AND casos_whatsapp_mal_jurado IS NULL)
    -- IS NOT NULL explícito: sin él, un solo valor NULL haría la expresión
    -- NULL y un CHECK con resultado NULL se ACEPTA.
    OR (casos_whatsapp_bien_jurado IS NOT NULL AND casos_whatsapp_mal_jurado IS NOT NULL
        AND casos_whatsapp_bien_jurado >= 0 AND casos_whatsapp_mal_jurado >= 0
        AND casos_whatsapp_bien_jurado + casos_whatsapp_mal_jurado = casos_whatsapp)
);

COMMENT ON COLUMN public.evaluaciones.casos_whatsapp_bien_jurado IS
    'Análisis Deportivo (107): de los casos por WhatsApp del rodeo, cuántos fueron "Bien jurado". NULL = sin registrar. Con mal_jurado suma casos_whatsapp.';
COMMENT ON COLUMN public.evaluaciones.casos_whatsapp_mal_jurado IS
    'Análisis Deportivo (107): de los casos por WhatsApp del rodeo, cuántos fueron "Mal jurado". NULL = sin registrar. Con bien_jurado suma casos_whatsapp.';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Verificación (solo lectura):
--   SELECT count(*) FILTER (WHERE casos_whatsapp_bien_jurado IS NOT NULL) AS con_desglose, count(*) AS total FROM evaluaciones;
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'chk_evaluaciones_casos_whatsapp_desglose';
-- Reversión (solo con autorización; descarta los desgloses cargados):
--   ALTER TABLE public.evaluaciones DROP CONSTRAINT IF EXISTS chk_evaluaciones_casos_whatsapp_desglose;
--   ALTER TABLE public.evaluaciones DROP COLUMN IF EXISTS casos_whatsapp_mal_jurado, DROP COLUMN IF EXISTS casos_whatsapp_bien_jurado;
