-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 034 — Nota manual en intentos de prueba
--
-- Permite al Administrador sobreescribir la nota calculada automáticamente
-- para un jurado en una prueba/capacitación.
--
-- CONTENIDO:
--   A. Columnas de nota manual en capacitacion_intentos
--   B. Tabla de historial/auditoría de notas manuales
--   C. Índices
--
-- IDEMPOTENTE: seguro ejecutar varias veces (usa IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- APLICAR en: Supabase → SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- A. Campos de nota manual en capacitacion_intentos
-- ─────────────────────────────────────────────────────────────────────────────
-- nota_manual          : valor de nota ingresado manualmente por el administrador
-- nota_manual_activa   : true si la nota manual está vigente (false = usa automática)
-- nota_manual_motivo   : motivo registrado por el administrador
-- nota_manual_por      : ID del administrador que aplicó la nota
-- nota_manual_fecha    : fecha/hora de la última modificación manual

ALTER TABLE capacitacion_intentos
    ADD COLUMN IF NOT EXISTS nota_manual        NUMERIC(4,1),
    ADD COLUMN IF NOT EXISTS nota_manual_activa BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS nota_manual_motivo TEXT,
    ADD COLUMN IF NOT EXISTS nota_manual_por    UUID,
    ADD COLUMN IF NOT EXISTS nota_manual_fecha  TIMESTAMPTZ;

-- ─────────────────────────────────────────────────────────────────────────────
-- B. Historial de notas manuales (auditoría)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS capacitacion_notas_manuales_historial (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    intento_id           UUID        NOT NULL REFERENCES capacitacion_intentos(id) ON DELETE CASCADE,
    prueba_id            UUID        NOT NULL,
    nota_automatica      NUMERIC(4,1),
    nota_manual_anterior NUMERIC(4,1),
    nota_manual_nueva    NUMERIC(4,1),
    motivo               TEXT        NOT NULL,
    accion               TEXT        NOT NULL CHECK (accion IN ('crear', 'modificar', 'quitar')),
    creado_por           UUID        NOT NULL,
    creado_en            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- C. Índices
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_cap_nota_manual_historial_intento
    ON capacitacion_notas_manuales_historial(intento_id);

CREATE INDEX IF NOT EXISTS idx_cap_nota_manual_historial_prueba
    ON capacitacion_notas_manuales_historial(prueba_id);

CREATE INDEX IF NOT EXISTS idx_cap_nota_manual_historial_fecha
    ON capacitacion_notas_manuales_historial(creado_en DESC);

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verificación
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    RAISE NOTICE 'nota_manual en capacitacion_intentos: %',
        (SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'capacitacion_intentos' AND column_name = 'nota_manual'
        ));
    RAISE NOTICE 'capacitacion_notas_manuales_historial: %',
        (SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_name = 'capacitacion_notas_manuales_historial'
        ));
END $$;
