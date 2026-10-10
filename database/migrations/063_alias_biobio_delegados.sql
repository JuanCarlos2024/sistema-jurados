-- ═════════════════════════════════════════════════════════════════════════
-- 063_alias_biobio_delegados.sql
-- Propuesta puntual derivada de la conciliación de asociaciones (Fase 1,
-- Delegado de Asociación): el texto "Biobío" usado por 8 delegados en
-- LISTADELEGADOS.xlsx no resolvía contra ningún alias real — verificado por
-- consulta de solo lectura (0 filas en asociacion_alias con "bio").
--
-- Confirmado por el usuario (no inferido por el agente):
--   1. BÍO BÍO y RÍO BÍO BÍO son asociaciones INDEPENDIENTES — esta
--      migración no las fusiona ni modifica ninguna de las dos filas de
--      `asociaciones`, solo agrega UN alias nuevo.
--   2. Los 8 delegados de "Biobío" corresponden a BÍO BÍO, NO a RÍO BÍO BÍO.
--
-- Verificado en producción (solo lectura, antes de preparar esta propuesta):
--   SELECT id, nombre, nombre_normalizado FROM asociaciones
--     WHERE nombre_normalizado IN ('bio bio', 'rio bio bio');
--   -> BÍO-BÍO     (nombre_normalizado = 'bio bio')      id real verificado
--   -> RIO BIO-BIO (nombre_normalizado = 'rio bio bio')  id real verificado,
--      ambas activa=true, ambas ya existían (migración 057).
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — pendiente de autorización.
--
-- Migración ADITIVA: una sola fila nueva en `asociacion_alias`, resuelta por
-- nombre_normalizado (nunca por UUID hardcodeado, para no depender de un
-- valor específico de un ambiente). No crea, fusiona ni modifica ninguna
-- fila de `asociaciones`. No crea delegados ni carga el listado — eso sigue
-- pendiente de autorización en una fase posterior (sección F del informe de
-- Fase 1).
--
-- Idempotente: ON CONFLICT (alias_normalizado) DO NOTHING — ejecutarla dos
-- veces no duplica el alias ni genera error (alias_normalizado es UNIQUE,
-- migración 057).
-- Reversible: DELETE FROM asociacion_alias WHERE alias_normalizado = 'biobio';
-- ═════════════════════════════════════════════════════════════════════════

INSERT INTO asociacion_alias (asociacion_id, alias, alias_normalizado)
SELECT id, 'Biobío', 'biobio'
FROM asociaciones
WHERE nombre_normalizado = 'bio bio'
ON CONFLICT (alias_normalizado) DO NOTHING;
