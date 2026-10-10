-- ═════════════════════════════════════════════════════════════════════════
-- Verificaciones de SOLO LECTURA para ejecutar en el SQL Editor de Supabase
-- ANTES de aplicar 073_eliminacion_segura_y_auditoria_transaccional_
-- delegados_asociacion.sql. Ninguna consulta modifica nada (sin ALTER/DROP/
-- CREATE/INSERT/UPDATE/DELETE). Compárteme el resultado de la consulta 1.
-- ═════════════════════════════════════════════════════════════════════════

-- 1) Nombre REAL de la FK de cartillas_delegado.delegado_asociacion_id —
--    la migración 065 la creó sin nombre explícito (ADD COLUMN ...
--    REFERENCES ... ON DELETE SET NULL), así que Postgres le asignó el
--    nombre por defecto. 073 asume "cartillas_delegado_delegado_asociacion_id_fkey"
--    (convención estándar <tabla>_<columna>_fkey) — esta consulta lo confirma
--    antes de intentar el DROP CONSTRAINT.
SELECT conname, pg_get_constraintdef(oid) AS definicion
FROM pg_constraint
WHERE conrelid = 'public.cartillas_delegado'::regclass
  AND contype = 'f'
  AND confrelid = 'public.delegados_asociacion'::regclass;

-- 2) Confirmar que rodeos_delegado_institucional.delegado_asociacion_id NO
--    tiene ON DELETE SET NULL (ya debería ser NO ACTION/RESTRICT por defecto,
--    migración 068) — si esto ya es seguro, 073 no necesita tocarla.
SELECT conname, pg_get_constraintdef(oid) AS definicion
FROM pg_constraint
WHERE conrelid = 'public.rodeos_delegado_institucional'::regclass
  AND contype = 'f'
  AND confrelid = 'public.delegados_asociacion'::regclass;
