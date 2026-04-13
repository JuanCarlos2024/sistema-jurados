-- ============================================================
-- Migración 009: DEFAULT 'pendiente' para estado_designacion
-- Ejecutar en Supabase SQL Editor antes de desplegar esta versión.
-- ============================================================

-- Asegura que cualquier INSERT que omita estado_designacion
-- quede en 'pendiente' en lugar de NULL.
-- Valores permitidos: pendiente | aceptado | rechazado
-- Registros históricos con NULL se conservan sin cambios:
--   el sistema los trata como 'aceptado' (compatibilidad con 002_designacion).

ALTER TABLE asignaciones
  ALTER COLUMN estado_designacion SET DEFAULT 'pendiente';

-- Verificación (opcional, no modifica datos):
-- SELECT estado_designacion, COUNT(*) FROM asignaciones GROUP BY estado_designacion;
