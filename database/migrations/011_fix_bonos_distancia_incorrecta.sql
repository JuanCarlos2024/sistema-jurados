-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 011 — Corregir bonos_solicitados con monto incorrecto
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- CONTEXTO:
--   La tabla bonos_config tuvo un período en que el registro "Bono 350-499 km"
--   tenía distancia_minima=0 (en vez de 350). Durante ese período, usuarios
--   que ingresaron km < 350 obtuvieron monto_solicitado=35000 incorrectamente.
--   El config fue corregido a distancia_minima=350, pero los bonos ya creados
--   quedaron con datos incorrectos.
--
-- REGLA CORRECTA:
--   0 – 349 km  →  $0         (sin bono — monto_solicitado=0, bono_config_id=NULL)
--   350–499 km  →  $35.000
--   500+    km  →  $50.000
--
-- ACCIÓN:
--   Solo se corrigen bonos en estado PENDIENTE (no revisados por admin).
--   Bonos aprobados/modificados/rechazados NO se tocan: el admin ya tomó
--   una decisión deliberada y ese monto puede haber sido comunicado.
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- 1) Verificación previa: mostrar bonos afectados ANTES del fix
DO $$
DECLARE
    rec RECORD;
BEGIN
    RAISE NOTICE '=== BONOS A CORREGIR (distancia < 350 con monto > 0, estado pendiente) ===';
    FOR rec IN
        SELECT id, distancia_declarada, monto_solicitado, bono_config_id, estado, created_at
        FROM bonos_solicitados
        WHERE distancia_declarada < 350
          AND monto_solicitado > 0
          AND estado = 'pendiente'
        ORDER BY created_at
    LOOP
        RAISE NOTICE 'id=% distancia=% monto_solicitado=% estado=% created_at=%',
            rec.id, rec.distancia_declarada, rec.monto_solicitado, rec.estado, rec.created_at;
    END LOOP;
END $$;

-- 2) Aplicar corrección
UPDATE bonos_solicitados
SET
    monto_solicitado  = 0,
    bono_config_id    = NULL,
    observacion_admin = COALESCE(observacion_admin || ' | ', '') ||
                        'Corrección automática: distancia ' || distancia_declarada ||
                        ' km no alcanza el mínimo para bono ($0 según regla 350-499/$35000, 500+/$50000).',
    updated_at        = NOW()
WHERE distancia_declarada < 350
  AND monto_solicitado > 0
  AND estado = 'pendiente';

-- 3) Verificar resultado
DO $$
DECLARE
    cnt INTEGER;
BEGIN
    SELECT COUNT(*) INTO cnt
    FROM bonos_solicitados
    WHERE distancia_declarada < 350 AND monto_solicitado > 0 AND estado = 'pendiente';

    IF cnt = 0 THEN
        RAISE NOTICE '✓ Corrección aplicada. No quedan bonos pendientes con distancia < 350 y monto > 0.';
    ELSE
        RAISE WARNING '⚠ Quedan % registros sin corregir (verificar manualmente).', cnt;
    END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK DE REFERENCIA (no ejecutar en producción salvo emergencia):
-- UPDATE bonos_solicitados
-- SET monto_solicitado=35000,
--     bono_config_id='741e6937-ea0b-4705-8e47-9e258580e0ad',
--     observacion_admin=NULL, updated_at=NOW()
-- WHERE id='80e873fb-7d12-43c5-8195-4aa1ac64aaac';
-- ═══════════════════════════════════════════════════════════════════════════════
