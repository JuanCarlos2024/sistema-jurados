-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 013 — Agregar columna asociacion a usuarios_pagados
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- CONTEXTO:
--   Los jurados y delegados pertenecen a una asociación regional.
--   Este campo permite planificar asignaciones de forma equitativa
--   y mostrarlo en el reporte de disponibilidad admin.
--
-- NOTAS:
--   - Nulable por defecto: usuarios existentes no se bloquean.
--   - Los usuarios pueden completarlo desde su perfil.
--   - IF NOT EXISTS garantiza idempotencia.
--
-- APLICAR en Supabase SQL Editor o MCP apply_migration.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE usuarios_pagados
  ADD COLUMN IF NOT EXISTS asociacion TEXT;
