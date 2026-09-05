-- ═════════════════════════════════════════════════════════════════════════
-- 048_propuestas_designacion_sin_jurado_actual.sql
-- Propuesta de Designación — Etapa 4: nuevo estado_revision SIN_JURADO_ACTUAL
--
-- ✅ APLICADA MANUALMENTE EN PRODUCCIÓN por el administrador del proyecto.
-- Se conserva este archivo únicamente para dejar el cambio versionado en el
-- repositorio — NO debe volver a ejecutarse (usa DROP CONSTRAINT IF EXISTS +
-- ADD CONSTRAINT, así que reejecutarla sería inocuo si ocurriera por error,
-- pero de todos modos no corresponde correrla de nuevo).
--
-- POR QUÉ ES NECESARIA:
-- La corrección "mover un jurado que solo está PROPUESTO en otra fila" (no
-- ACEPTADO/MODIFICADO) necesita distinguir dos situaciones que, con el
-- modelo de 5 estados de la migración 047, son indistinguibles:
--
--   A) Una fila PENDIENTE recién generada, donde jurado_id_propuesto sigue
--      siendo la sugerencia vigente del motor.
--   B) Una fila PENDIENTE cuyo jurado_id_propuesto YA fue movido por el
--      administrador a otra fila de la misma propuesta — el campo histórico
--      sigue apuntando al mismo jurado (nunca se borra, es auditoría), pero
--      ese jurado YA NO debe contar como "en uso" en esta fila.
--
-- Sin un estado explícito para (B), cualquier código que necesite saber "hay
-- alguien vigente en esta fila" (el indicador "propuesto en otro rodeo", la
-- detección de conflictos internos, el resumen de la propuesta) tendría que
-- adivinarlo con lógica ad-hoc en vez de leer un solo campo confiable — el
-- pedido explícito fue evitar justamente ese tipo de hack.
--
-- QUÉ CAMBIA:
-- Solo se amplía el CHECK constraint de estado_revision en
-- propuestas_designacion_detalle para permitir el valor 'SIN_JURADO_ACTUAL'
-- además de los 5 ya existentes. No se agregan columnas, no se migran datos
-- (la tabla está vacía en producción a la fecha de esta migración), no se
-- toca ninguna otra tabla. jurado_id_propuesto/jurado_id_seleccionado no
-- cambian de tipo ni de nulabilidad.
--
-- SIN_JURADO_ACTUAL: el motor propuso originalmente a alguien (jurado_id_
-- propuesto se conserva, histórico/auditoría) pero esa fila ya no tiene
-- ningún jurado vigente — fue movido a otra fila de la misma propuesta por
-- el administrador. jurado_id_seleccionado permanece NULL. No cuenta como
-- PENDIENTE/ACEPTADO/MODIFICADO en el resumen de la propuesta; requiere
-- revisión administrativa (designar manualmente o dejar así).
--
-- Reversible: ALTER TABLE ... DROP CONSTRAINT + volver a crear el CHECK
-- original de 5 valores (solo es seguro si no quedan filas con
-- estado_revision = 'SIN_JURADO_ACTUAL' en ese momento).
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE propuestas_designacion_detalle
    DROP CONSTRAINT IF EXISTS propuestas_designacion_detalle_estado_revision_check;

ALTER TABLE propuestas_designacion_detalle
    ADD CONSTRAINT propuestas_designacion_detalle_estado_revision_check
    CHECK (estado_revision IN ('PENDIENTE', 'ACEPTADO', 'MODIFICADO', 'SIN_PROPUESTA', 'NO_EVALUABLE', 'SIN_JURADO_ACTUAL'));

COMMIT;

-- ── Verificación sugerida post-aplicación (no destructiva) ─────────────────
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'propuestas_designacion_detalle'::regclass
--   AND conname = 'propuestas_designacion_detalle_estado_revision_check';
-- -- debe incluir 'SIN_JURADO_ACTUAL' en la lista.
