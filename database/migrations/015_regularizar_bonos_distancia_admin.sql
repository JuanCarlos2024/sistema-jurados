-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 015 — Regularizar bonos de distancia ingresados por admin
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- CONTEXTO:
--   Asignaciones con distancia_km ingresado por admin no tenían bono generado,
--   o tenían bono con estado incorrecto.
--
-- REGLA DE NEGOCIO:
--   - km sin tramo (< 350) → aprobado_auto, monto $0   (sin revisión manual)
--   - km con tramo (>= 350) → pendiente, monto del tramo (requiere aprobación admin)
--
-- IDEMPOTENTE: Se puede ejecutar múltiples veces sin duplicar registros.
--   Solo actúa donde falta o hay estado incorrecto.
--   No modifica bonos ya aprobados/modificados manualmente.
--
-- APLICAR en: Supabase → proyecto jurados_2026 → SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Paso 1: Crear bonos faltantes para km SIN tramo → aprobado_auto ($0) ──────
-- Caso: asignacion con km activo, sin bono activo, y km no cae en ningún tramo

INSERT INTO bonos_solicitados (
    asignacion_id, usuario_pagado_id,
    distancia_declarada, monto_solicitado, monto_aprobado,
    bono_config_id, estado, created_at, updated_at
)
SELECT
    a.id,
    a.usuario_pagado_id,
    a.distancia_km,
    0,
    0,
    NULL,
    'aprobado_auto',
    NOW(),
    NOW()
FROM asignaciones a
WHERE a.distancia_km > 0
  AND a.estado = 'activo'
  -- No hay tramo que aplique para esta distancia
  AND NOT EXISTS (
      SELECT 1 FROM bonos_config bc
      WHERE bc.activo = true
        AND bc.distancia_minima <= a.distancia_km
        AND (bc.distancia_maxima IS NULL OR bc.distancia_maxima >= a.distancia_km)
  )
  -- No existe bono activo (no rechazado) para esta asignación
  AND NOT EXISTS (
      SELECT 1 FROM bonos_solicitados bs
      WHERE bs.asignacion_id = a.id
        AND bs.estado != 'rechazado'
  );

-- ── Paso 2: Crear bonos faltantes para km CON tramo → pendiente ────────────────
-- Caso: asignacion con km activo, sin bono activo, y km SÍ cae en un tramo

INSERT INTO bonos_solicitados (
    asignacion_id, usuario_pagado_id,
    distancia_declarada, monto_solicitado, monto_aprobado,
    bono_config_id, estado, created_at, updated_at
)
SELECT
    a.id,
    a.usuario_pagado_id,
    a.distancia_km,
    bc_match.monto,
    NULL,
    bc_match.id,
    'pendiente',
    NOW(),
    NOW()
FROM asignaciones a
JOIN LATERAL (
    SELECT id, monto
    FROM bonos_config
    WHERE activo = true
      AND distancia_minima <= a.distancia_km
      AND (distancia_maxima IS NULL OR distancia_maxima >= a.distancia_km)
    ORDER BY distancia_minima DESC
    LIMIT 1
) bc_match ON true
WHERE a.distancia_km > 0
  AND a.estado = 'activo'
  -- No existe bono activo (no rechazado) para esta asignación
  AND NOT EXISTS (
      SELECT 1 FROM bonos_solicitados bs
      WHERE bs.asignacion_id = a.id
        AND bs.estado != 'rechazado'
  );

-- ── Paso 3: Corregir bonos aprobado_auto que deberían ser pendiente ────────────
-- Caso: bono en aprobado_auto pero km >= 350 (tiene tramo → debería ser pendiente)

UPDATE bonos_solicitados bs
SET
    estado           = 'pendiente',
    monto_solicitado = bc_match.monto,
    bono_config_id   = bc_match.id,
    monto_aprobado   = NULL,
    updated_at       = NOW()
FROM asignaciones a
JOIN LATERAL (
    SELECT id, monto
    FROM bonos_config
    WHERE activo = true
      AND distancia_minima <= a.distancia_km
      AND (distancia_maxima IS NULL OR distancia_maxima >= a.distancia_km)
    ORDER BY distancia_minima DESC
    LIMIT 1
) bc_match ON true
WHERE bs.asignacion_id = a.id
  AND a.distancia_km > 0
  AND a.estado = 'activo'
  AND bs.estado = 'aprobado_auto';

-- ── Paso 4: Corregir bonos pendientes que deberían ser aprobado_auto ──────────
-- Caso: bono en pendiente pero km < 350 (sin tramo → debería ser aprobado_auto $0)

UPDATE bonos_solicitados bs
SET
    estado           = 'aprobado_auto',
    monto_solicitado = 0,
    monto_aprobado   = 0,
    bono_config_id   = NULL,
    updated_at       = NOW()
FROM asignaciones a
WHERE bs.asignacion_id = a.id
  AND a.distancia_km > 0
  AND a.estado = 'activo'
  AND bs.estado = 'pendiente'
  AND NOT EXISTS (
      SELECT 1 FROM bonos_config bc
      WHERE bc.activo = true
        AND bc.distancia_minima <= a.distancia_km
        AND (bc.distancia_maxima IS NULL OR bc.distancia_maxima >= a.distancia_km)
  );

-- ── Verificación final ─────────────────────────────────────────────────────────
DO $$
DECLARE
    v_total_con_km   INTEGER;
    v_sin_bono       INTEGER;
    v_pendientes     INTEGER;
    v_auto           INTEGER;
    v_aprobados      INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_total_con_km
    FROM asignaciones
    WHERE distancia_km > 0 AND estado = 'activo';

    SELECT COUNT(*) INTO v_sin_bono
    FROM asignaciones a
    WHERE a.distancia_km > 0 AND a.estado = 'activo'
      AND NOT EXISTS (
          SELECT 1 FROM bonos_solicitados bs
          WHERE bs.asignacion_id = a.id AND bs.estado != 'rechazado'
      );

    SELECT COUNT(*) INTO v_pendientes
    FROM bonos_solicitados bs
    JOIN asignaciones a ON a.id = bs.asignacion_id
    WHERE a.distancia_km > 0 AND a.estado = 'activo' AND bs.estado = 'pendiente';

    SELECT COUNT(*) INTO v_auto
    FROM bonos_solicitados bs
    JOIN asignaciones a ON a.id = bs.asignacion_id
    WHERE a.distancia_km > 0 AND a.estado = 'activo' AND bs.estado = 'aprobado_auto';

    SELECT COUNT(*) INTO v_aprobados
    FROM bonos_solicitados bs
    JOIN asignaciones a ON a.id = bs.asignacion_id
    WHERE a.distancia_km > 0 AND a.estado = 'activo' AND bs.estado IN ('aprobado','modificado');

    RAISE NOTICE '=== RESULTADO REGULARIZACIÓN ===';
    RAISE NOTICE 'Asignaciones activas con km:  %', v_total_con_km;
    RAISE NOTICE 'Sin bono activo (pendiente):   %', v_sin_bono;
    RAISE NOTICE 'Bonos pendientes (>= 350 km):  %', v_pendientes;
    RAISE NOTICE 'Bonos aprobado_auto (< 350 km):%', v_auto;
    RAISE NOTICE 'Bonos aprobados/modificados:   %', v_aprobados;

    IF v_sin_bono = 0 THEN
        RAISE NOTICE '✓ Todas las asignaciones con km tienen bono activo.';
    ELSE
        RAISE WARNING '⚠ Quedan % asignaciones sin bono (verificar manualmente).', v_sin_bono;
    END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PARA VERIFICAR MANUALMENTE (ejecutar por separado):
--
-- SELECT a.id, a.distancia_km, bs.estado, bs.monto_solicitado, bs.monto_aprobado
-- FROM asignaciones a
-- LEFT JOIN bonos_solicitados bs ON bs.asignacion_id = a.id AND bs.estado != 'rechazado'
-- WHERE a.distancia_km > 0 AND a.estado = 'activo'
-- ORDER BY a.distancia_km DESC;
-- ═══════════════════════════════════════════════════════════════════════════════
