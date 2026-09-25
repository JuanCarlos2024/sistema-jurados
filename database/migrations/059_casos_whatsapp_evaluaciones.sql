-- ═════════════════════════════════════════════════════════════════════════
-- 059_casos_whatsapp_evaluaciones.sql
-- "Casos por WhatsApp": cantidad de situaciones reportadas directamente a los
-- jurados por WhatsApp y conocidas por el analista. Dato INFORMATIVO del
-- Análisis Deportivo (misma tabla donde ya viven observacion_general,
-- resultados_alterados, puntaje_analista_*...). No entra en ningún cálculo.
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — pendiente de autorización.
--
-- Migración ADITIVA y segura:
--   · Una sola columna nueva en evaluaciones: casos_whatsapp INTEGER NOT NULL DEFAULT 0.
--     En PostgreSQL 11+ agregar una columna con DEFAULT constante es solo un cambio de
--     metadatos (no reescribe la tabla): las 136 filas existentes pasan a leerse como 0
--     sin tocarlas una por una, y los INSERT que no mencionan la columna siguen funcionando.
--   · CHECK (casos_whatsapp >= 0): defensa en profundidad (el backend ya valida entero >= 0).
--   · No crea tablas, FK, índices ni triggers; no modifica notas_rodeo ni rodeo_notas_secundarias.
--   · Compatible con el código anterior: las consultas existentes con columnas explícitas no
--     cambian y `select *` solo agrega el campo. La función publicar_evaluacion no se ve afectada.
--   · Orden recomendado de despliegue: aplicar esta migración ANTES (o junto) al deploy del código
--     nuevo (el guardado del Análisis Deportivo envía el campo).
--
-- Idempotente: se puede ejecutar más de una vez sin error.
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE public.evaluaciones
    ADD COLUMN IF NOT EXISTS casos_whatsapp INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.evaluaciones'::regclass AND conname = 'chk_evaluaciones_casos_whatsapp'
    ) THEN
        ALTER TABLE public.evaluaciones
            ADD CONSTRAINT chk_evaluaciones_casos_whatsapp CHECK (casos_whatsapp >= 0);
    END IF;
END $$;

COMMENT ON COLUMN public.evaluaciones.casos_whatsapp IS
    'Análisis Deportivo: cantidad de casos reportados a los jurados por WhatsApp y conocidos por el analista. Dato informativo; NO es la nota del jurado (notas_rodeo.nota) ni participa en cálculos. Por defecto 0.';

-- ─────────────────────────────────────────────────────────────────────────
-- ROLLBACK (solo si hiciera falta revertir; no se ejecuta automáticamente):
--   ALTER TABLE public.evaluaciones DROP CONSTRAINT IF EXISTS chk_evaluaciones_casos_whatsapp;
--   ALTER TABLE public.evaluaciones DROP COLUMN IF EXISTS casos_whatsapp;
-- Es seguro: ninguna otra tabla, vista ni función depende de esta columna, y la reversión solo
-- descarta el dato nuevo; el resto del análisis no se ve afectado.
-- ─────────────────────────────────────────────────────────────────────────
