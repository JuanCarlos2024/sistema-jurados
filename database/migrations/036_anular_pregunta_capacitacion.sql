-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 036 — Anulación de preguntas en capacitaciones
--
-- CONTENIDO:
--   A. capacitacion_preguntas.anulada — flag de pregunta anulada
--      · anulada = TRUE  → excluida del total evaluable y de correctas/incorrectas
--      · anulada = FALSE → comportamiento normal (default)
--
-- NOTA: No elimina la pregunta ni sus respuestas históricas.
--       El backend recalcula todo dinámicamente excluyendo las anuladas.
--
-- IDEMPOTENTE: seguro ejecutar varias veces.
-- APLICAR en: Supabase → SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE capacitacion_preguntas
    ADD COLUMN IF NOT EXISTS anulada BOOLEAN NOT NULL DEFAULT FALSE;

-- Índice parcial: solo indexa filas anuladas (bajo costo cuando pocas preguntas se anulan)
CREATE INDEX IF NOT EXISTS idx_cap_preguntas_anulada
    ON capacitacion_preguntas(prueba_id, anulada)
    WHERE anulada = TRUE;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verificación
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    RAISE NOTICE 'columna anulada en capacitacion_preguntas: %',
        (SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'capacitacion_preguntas' AND column_name = 'anulada'
        ));
END $$;
