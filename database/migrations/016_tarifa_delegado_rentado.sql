-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 016 — Tarifa independiente para Delegado Rentado
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- CONTEXTO:
--   Delegados Rentados usaban la tarifa de Categoría A.
--   Se crea una entrada propia en configuracion_tarifas con clave 'DR'.
--
-- VALORES:
--   Valor diario : $257.250 CLP
--   Valor 2 días : $514.500 CLP
--
-- RETROACTIVO:
--   Actualiza todas las asignaciones activas de delegado_rentado para que
--   reflejen la nueva tarifa DR y el pago base recalculado.
--
-- IDEMPOTENTE: ON CONFLICT DO UPDATE — seguro para ejecutar varias veces.
--
-- APLICAR en: Supabase → proyecto jurados_2026 → SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Paso 1: Insertar (o actualizar si ya existe) la tarifa DR ─────────────────

INSERT INTO configuracion_tarifas (categoria, valor_diario, valor_2_dias, updated_at)
VALUES ('DR', 257250, 514500, NOW())
ON CONFLICT (categoria) DO UPDATE SET
    valor_diario = EXCLUDED.valor_diario,
    valor_2_dias = EXCLUDED.valor_2_dias,
    updated_at   = NOW();

-- ── Paso 2: Recalcular asignaciones activas de delegado_rentado ───────────────
-- Actualiza categoria_aplicada, valor_diario_aplicado y pago_base_calculado.
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
    v_tarifa_ok     BOOLEAN;
    v_actualizadas  INTEGER;
BEGIN
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
    RAISE NOTICE 'Tarifa DR creada/actualizada: %', v_tarifa_ok;
    RAISE NOTICE 'Asignaciones delegado_rentado actualizadas: %', v_actualizadas;

    IF v_tarifa_ok THEN
        RAISE NOTICE '✓ Tarifa DR lista ($257.250/día, $514.500/2 días).';
    ELSE
        RAISE WARNING '⚠ La tarifa DR no se creó correctamente, verificar.';
    END IF;
END $$;

COMMIT;
