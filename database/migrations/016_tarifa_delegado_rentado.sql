-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 016 — Tarifa independiente para Delegado Rentado
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- CONTEXTO:
--   configuracion_tarifas tiene CHECK (categoria IN ('A','B','C')).
--   Se amplía el CHECK para incluir 'DR' y se inserta la nueva fila.
--
-- VALORES:
--   Valor diario : $257.250 CLP
--   Valor 2 días : $514.500 CLP
--
-- RETROACTIVO:
--   Actualiza todas las asignaciones activas de delegado_rentado para que
--   reflejen la nueva tarifa DR y el pago base recalculado.
--
-- IDEMPOTENTE: seguro para ejecutar varias veces.
--
-- APLICAR en: Supabase → proyecto jurados_2026 → SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Paso 1: Ampliar el CHECK constraint para permitir 'DR' ────────────────────

ALTER TABLE configuracion_tarifas
    DROP CONSTRAINT IF EXISTS configuracion_tarifas_categoria_check;

ALTER TABLE configuracion_tarifas
    ADD CONSTRAINT configuracion_tarifas_categoria_check
    CHECK (categoria IN ('A', 'B', 'C', 'DR'));

-- ── Paso 2: Insertar (o actualizar si ya existe) la tarifa DR ─────────────────

INSERT INTO configuracion_tarifas (categoria, valor_diario, valor_2_dias, updated_at)
VALUES ('DR', 257250, 514500, NOW())
ON CONFLICT (categoria) DO UPDATE SET
    valor_diario = EXCLUDED.valor_diario,
    valor_2_dias = EXCLUDED.valor_2_dias,
    updated_at   = NOW();

-- ── Paso 3: Recalcular asignaciones activas de delegado_rentado ───────────────
-- Solo asignaciones activas; las rechazadas/históricas se dejan intactas.

UPDATE asignaciones
SET
    categoria_aplicada    = 'DR',
    valor_diario_aplicado = 257250,
    pago_base_calculado   = 257250 * duracion_dias_aplicada,
    updated_at            = NOW()
WHERE tipo_persona = 'delegado_rentado'
  AND estado       = 'activo';

-- ── Verificación ──────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_constraint_ok BOOLEAN;
    v_tarifa_ok     BOOLEAN;
    v_actualizadas  INTEGER;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM information_schema.check_constraints
        WHERE constraint_name = 'configuracion_tarifas_categoria_check'
          AND check_clause LIKE '%DR%'
    ) INTO v_constraint_ok;

    SELECT EXISTS (
        SELECT 1 FROM configuracion_tarifas
        WHERE categoria = 'DR' AND valor_diario = 257250
    ) INTO v_tarifa_ok;

    SELECT COUNT(*) INTO v_actualizadas
    FROM asignaciones
    WHERE tipo_persona = 'delegado_rentado'
      AND estado       = 'activo'
      AND categoria_aplicada = 'DR';

    RAISE NOTICE '=== RESULTADO MIGRACIÓN 016 ===';
    RAISE NOTICE 'CHECK constraint actualizado (incluye DR): %', v_constraint_ok;
    RAISE NOTICE 'Tarifa DR creada/actualizada: %', v_tarifa_ok;
    RAISE NOTICE 'Asignaciones delegado_rentado actualizadas: %', v_actualizadas;

    IF v_tarifa_ok THEN
        RAISE NOTICE '✓ Tarifa DR lista ($257.250/día, $514.500/2 días).';
    ELSE
        RAISE WARNING '⚠ La tarifa DR no se creó correctamente, verificar.';
    END IF;
END $$;

COMMIT;
