-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 035 — Temporizador global por prueba
--
-- CONTENIDO:
--   A. Nuevas columnas en capacitacion_intentos
--      · vence_en                — cuándo expira el intento (NULL = sin límite)
--      · tiempo_limite_aplicado  — snapshot de tiempo_limite_minutos al crear el intento
--      · finalizado_por_tiempo   — TRUE cuando el sistema finaliza por tiempo agotado
--
-- NOTA: La columna tiempo_limite_minutos ya existe en capacitacion_pruebas
--       (creada en el schema original). Esta migración la activa en el flujo
--       de backend/frontend sin modificar la tabla capacitacion_pruebas.
--
-- IDEMPOTENTE: seguro ejecutar varias veces.
-- APLICAR en: Supabase → SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE capacitacion_intentos
    ADD COLUMN IF NOT EXISTS vence_en               TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS tiempo_limite_aplicado INTEGER,
    ADD COLUMN IF NOT EXISTS finalizado_por_tiempo  BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_cap_intentos_vence_en
    ON capacitacion_intentos(vence_en)
    WHERE vence_en IS NOT NULL;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verificación
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    RAISE NOTICE 'vence_en: %',
        (SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'capacitacion_intentos' AND column_name = 'vence_en'
        ));
    RAISE NOTICE 'tiempo_limite_aplicado: %',
        (SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'capacitacion_intentos' AND column_name = 'tiempo_limite_aplicado'
        ));
    RAISE NOTICE 'finalizado_por_tiempo: %',
        (SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'capacitacion_intentos' AND column_name = 'finalizado_por_tiempo'
        ));
END $$;
