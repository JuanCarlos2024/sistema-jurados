-- ============================================================
-- Migración 002: Estado de designación en asignaciones
-- Ejecutar en Supabase SQL Editor antes de desplegar el backend
-- ============================================================

ALTER TABLE asignaciones
  ADD COLUMN IF NOT EXISTS estado_designacion VARCHAR(20),
  ADD COLUMN IF NOT EXISTS distancia_km       INTEGER,
  ADD COLUMN IF NOT EXISTS aceptado_en        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS observacion_designacion TEXT;

-- Los registros existentes quedan con estado_designacion = NULL
-- El sistema los trata como 'aceptado' (backward compatible)
-- Solo nuevas asignaciones creadas desde esta versión
-- tendrán estado_designacion = 'pendiente' por defecto.
