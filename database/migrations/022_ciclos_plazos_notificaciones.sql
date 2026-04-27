-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 022 — Plazos de respuesta, silencio y notificaciones en ciclos
--
-- CONTENIDO:
--   A. evaluacion_configuracion: campos de plazo y aceptación por silencio
--   B. evaluacion_ciclos: fecha_limite_respuesta + timestamps de notificación
--
-- Valores por defecto: todo desactivado (usar_plazo_respuesta = false).
-- IDEMPOTENTE — seguro ejecutar varias veces.
-- APLICAR en: Supabase → SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- A. evaluacion_configuracion — plazos y aceptación por silencio
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE evaluacion_configuracion
    ADD COLUMN IF NOT EXISTS usar_plazo_respuesta    BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS ciclo1_dia_limite        TEXT    NOT NULL DEFAULT 'lunes',
    ADD COLUMN IF NOT EXISTS ciclo1_hora_limite       TEXT    NOT NULL DEFAULT '23:59',
    ADD COLUMN IF NOT EXISTS ciclo2_dia_limite        TEXT    NOT NULL DEFAULT 'miercoles',
    ADD COLUMN IF NOT EXISTS ciclo2_hora_limite       TEXT    NOT NULL DEFAULT '23:59',
    ADD COLUMN IF NOT EXISTS usar_aceptacion_silencio BOOLEAN NOT NULL DEFAULT FALSE;

-- ─────────────────────────────────────────────────────────────────────────────
-- B. evaluacion_ciclos — fecha límite y timestamps de notificación
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE evaluacion_ciclos
    ADD COLUMN IF NOT EXISTS fecha_limite_respuesta    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS notificacion_enviada_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS notificacion_reenviada_at TIMESTAMPTZ;

COMMIT;
