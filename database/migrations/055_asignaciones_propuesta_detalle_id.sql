-- ═════════════════════════════════════════════════════════════════════════
-- 055_asignaciones_propuesta_detalle_id.sql
-- Trazabilidad ESTRUCTURAL entre una asignación y el detalle de propuesta
-- que la originó — reemplaza a la auditoría como fuente de verdad funcional
-- para "¿esta propuesta fue aplicada a Rodeos?".
--
-- ✅ APLICADA EN PRODUCCIÓN (aplicada vía MCP Supabase apply_migration el
--    2026-09-22, con precheck/postcheck de solo lectura antes y después,
--    mismo protocolo que 050-054; validada además con una prueba de
--    integridad FK transaccional con ROLLBACK explícito — ver informe de la
--    conversación. NO volver a ejecutarla.
--
-- CONTEXTO (brecha detectada en revisión de POST /propuestas/:id/aplicar):
-- hasta ahora, "¿esta propuesta ya generó una designación real?" se
-- determinaba consultando `auditoria` (tabla='asignaciones', accion='crear',
-- datos_nuevos.propuesta_id=<propuesta>). Esa escritura de auditoría es
-- BEST-EFFORT por diseño (services/auditoria.js: "No lanza errores para no
-- interrumpir el flujo principal", y ni siquiera revisa el campo `error` de
-- una respuesta resuelta sin excepción) y ocurre en una segunda sentencia
-- INSERT, separada del INSERT de la asignación — sin transacción real entre
-- ambas. Si esa segunda escritura fallara silenciosamente, la asignación
-- quedaría creada igual, pero sin ningún rastro que la vincule a su
-- propuesta de origen — permitiendo eliminar por error un borrador que ya
-- tuvo efectos reales.
--
-- QUÉ HACE:
--   - Agrega a `asignaciones`: propuesta_detalle_id UUID NULL, con FK hacia
--     propuestas_designacion_detalle(id).
--   - Sin ON DELETE explícito -> comportamiento por defecto de Postgres
--     (NO ACTION / RESTRICT): un detalle de propuesta referenciado por una
--     asignación real NUNCA puede borrarse, ni directamente ni en cascada.
--     Mismo patrón ya usado en este proyecto para
--     propuestas_designacion.configuracion_version_id (migración 050,
--     sección 6 de su informe): "Al no especificar ON DELETE, el
--     comportamiento por defecto de Postgres es RESTRICT".
--   - Efecto en cascada (SEGUNDA BARRERA, a nivel de base de datos): la FK
--     propuestas_designacion_detalle.propuesta_id -> propuestas_designacion
--     (migración 047) es ON DELETE CASCADE. Si esta nueva FK bloquea el
--     borrado de UN detalle porque una asignación real lo referencia,
--     Postgres aborta la sentencia DELETE completa sobre propuestas_
--     designacion (la cascada es parte de la MISMA sentencia/transacción) —
--     ninguna fila se pierde, ni siquiera las de OTROS detalles de la misma
--     propuesta que sí fueran borrables. Esta protección existe aunque el
--     chequeo 409 del backend tuviera un bug y jamás se ejecutara.
--   - Columna 100% nullable, sin DEFAULT: toda asignación manual (existente
--     o futura, vía POST /api/admin/asignaciones, sin cambios en ese
--     archivo) queda con propuesta_detalle_id = NULL — comportamiento
--     idéntico al actual, sin ambigüedad ni backfill necesario.
--   - Índice PARCIAL (WHERE propuesta_detalle_id IS NOT NULL): la columna es
--     NULL en la inmensa mayoría de las filas (todo lo manual/histórico);
--     un índice parcial solo indexa las filas realmente vinculadas a una
--     propuesta, que es exactamente lo que consulta calcularAplicacionReal().
--
-- BACKFILL: NINGUNO. "Aplicar propuesta a Rodeos" (POST /propuestas/:id/
-- aplicar) todavía NO fue desplegada a producción — no existe ninguna
-- asignación real, en ningún entorno, que haya nacido de ese flujo. No hay
-- nada que retro-completar; todas las filas existentes quedan en NULL por
-- el simple hecho de no tener DEFAULT.
--
-- Aditiva y reversible. Sin DROP. Sin modificar ninguna fila existente.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE asignaciones
    ADD COLUMN IF NOT EXISTS propuesta_detalle_id UUID
        REFERENCES propuestas_designacion_detalle(id);

CREATE INDEX IF NOT EXISTS idx_asignaciones_propuesta_detalle
    ON asignaciones(propuesta_detalle_id)
    WHERE propuesta_detalle_id IS NOT NULL;

COMMIT;

-- ── Verificación sugerida post-aplicación (no destructiva) ─────────────────
--
-- SELECT column_name, is_nullable, data_type FROM information_schema.columns
--   WHERE table_name = 'asignaciones' AND column_name = 'propuesta_detalle_id';
--   -- debe mostrar is_nullable = 'YES'.
--
-- SELECT conname, confdeltype FROM pg_constraint
--   WHERE conrelid = 'asignaciones'::regclass
--   AND conname LIKE '%propuesta_detalle_id%';
--   -- confdeltype debe ser 'a' (NO ACTION) — nunca 'c' (CASCADE) ni 'n' (SET NULL).
--
-- SELECT count(*) FROM asignaciones WHERE propuesta_detalle_id IS NOT NULL;
--   -- debe dar 0 justo después de aplicar esta migración (sin backfill,
--   -- sin despliegue previo de "Aplicar propuesta a Rodeos").
--
-- -- Prueba conceptual de integridad (transaccional, con ROLLBACK explícito
-- -- — nunca persiste nada):
-- -- BEGIN;
-- --   -- (usar ids reales de una propuesta BORRADOR de prueba con detalle)
-- --   UPDATE asignaciones SET propuesta_detalle_id = '<detalle_id de prueba>'
-- --     WHERE id = '<asignacion_id de prueba>';
-- --   DELETE FROM propuestas_designacion WHERE id = '<propuesta_id de prueba>';
-- --   -- debe fallar con: update or delete on table "propuestas_designacion_detalle"
-- --   -- violates foreign key constraint on table "asignaciones"
-- -- ROLLBACK;
