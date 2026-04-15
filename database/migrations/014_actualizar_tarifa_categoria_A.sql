-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 014 — Corrección tarifa categoría A (y delegado rentado)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- CONTEXTO:
--   El valor correcto para jurado categoría A y delegado rentado es:
--     1 día  → $292.250
--     2 días → $584.500
--     N días → $292.250 × N
--
--   Delegado rentado usa tarifa A por diseño (calculo.js línea 44).
--
-- IMPACTO:
--   - configuracion_tarifas: actualiza valor vigente (afecta asignaciones futuras)
--   - asignaciones: recalcula TODAS las filas con categoria_aplicada = 'A'
--     (incluye delegados rentados e históricas)
--
-- APLICAR en: Supabase → proyecto jurados_2026 → SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Actualizar tarifa vigente categoría A
UPDATE configuracion_tarifas
SET
    valor_diario = 292250,
    valor_2_dias = 584500,
    updated_at   = NOW()
WHERE categoria = 'A';

-- 2. Recalcular todas las asignaciones históricas con categoría A
--    pago_base_calculado = 292.250 × duracion_dias_aplicada
UPDATE asignaciones
SET
    valor_diario_aplicado = 292250,
    pago_base_calculado   = 292250 * duracion_dias_aplicada,
    updated_at            = NOW()
WHERE categoria_aplicada = 'A';

-- Verificación (ejecutar después para confirmar):
-- SELECT categoria, valor_diario, valor_2_dias FROM configuracion_tarifas WHERE categoria = 'A';
-- SELECT COUNT(*), AVG(valor_diario_aplicado) FROM asignaciones WHERE categoria_aplicada = 'A';
