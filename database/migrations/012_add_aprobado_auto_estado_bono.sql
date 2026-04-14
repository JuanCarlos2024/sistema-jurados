-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 012 — Agregar estado 'aprobado_auto' a bonos_solicitados
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- CONTEXTO:
--   Nueva regla de negocio: km < 350 → bono $0, sin revisión manual del admin.
--   Se introduce el estado 'aprobado_auto' para identificar estos bonos y
--   excluirlos de la cola de revisión pendiente.
--
-- ESTADOS resultantes:
--   pendiente     → km >= 350, espera revisión admin
--   aprobado      → admin aprobó con monto_solicitado
--   modificado    → admin modificó el monto
--   rechazado     → admin rechazó
--   aprobado_auto → km < 350, $0 automático, no requiere revisión
--
-- APLICADO en producción (Supabase MCP apply_migration 2026-04-14).
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE bonos_solicitados
  DROP CONSTRAINT bonos_solicitados_estado_check;

ALTER TABLE bonos_solicitados
  ADD CONSTRAINT bonos_solicitados_estado_check
  CHECK (estado IN ('pendiente','aprobado','rechazado','modificado','aprobado_auto'));
