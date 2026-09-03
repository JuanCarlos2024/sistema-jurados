-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 043 — Publicación de designaciones (visibilidad para el jurado)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- CONTEXTO:
--   Hasta ahora, apenas el administrador designaba un jurado, la asignación
--   quedaba inmediatamente visible en el portal del jurado. Se necesita separar
--   "designar" (preparación administrativa) de "publicar" (oficializar y hacer
--   visible al jurado), para permitir revisión de jefatura antes de informar.
--
-- QUÉ HACE:
--   - Agrega a `asignaciones`: publicado (bool), publicado_en, publicado_por.
--   - Backfill: TODAS las filas que existan al momento de aplicar esta
--     migración quedan publicado = true (preserva visibilidad actual, sin
--     mirar la fecha del rodeo — lo que importa es que ya existían).
--   - Las filas creadas DESPUÉS de este ALTER nacen en publicado = false por
--     el DEFAULT de la columna (cubre tanto designación manual como
--     importación por Excel, sin tocar ese código).
--
-- NOTAS:
--   - Idempotente: ADD COLUMN IF NOT EXISTS + backfill condicional
--     (WHERE publicado = false) no reescribe filas ya migradas si se re-corre.
--   - No destructiva. No toca ninguna otra columna, tabla ni dato.
--   - No cambia el modelo de `estado` (activo/pendiente_revision/anulado) ni
--     `estado_designacion` (respuesta del jurado) — son conceptos distintos.
--
-- APLICAR en Supabase SQL Editor o MCP apply_migration.
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE asignaciones
  ADD COLUMN IF NOT EXISTS publicado      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS publicado_en   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS publicado_por  UUID REFERENCES administradores(id);

-- Backfill: preservar visibilidad de todo lo que ya existía antes de esta
-- funcionalidad. No depende de la fecha del rodeo, solo de que la fila ya
-- existía al momento de aplicar la migración.
UPDATE asignaciones SET publicado = true WHERE publicado = false;

CREATE INDEX IF NOT EXISTS idx_asignaciones_publicado ON asignaciones(publicado);

COMMIT;
