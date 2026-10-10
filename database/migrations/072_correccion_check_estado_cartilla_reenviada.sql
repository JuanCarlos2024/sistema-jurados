-- ═════════════════════════════════════════════════════════════════════════
-- 072_correccion_check_estado_cartilla_reenviada.sql
-- Corrección de compatibilidad previa a producción — confirmado por consulta
-- SQL de solo lectura directamente en el SQL Editor de Supabase PRODUCCIÓN
-- (no una suposición, ejecutada por el usuario):
--
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'public.cartillas_delegado'::regclass AND contype = 'c';
--
--   -> cartillas_delegado_estado_check permite HOY exactamente:
--      'borrador', 'enviada', 'observada', 'aprobada', 'cerrada'.
--      NO incluye 'reenviada'.
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — pendiente de autorización.
-- Depende de 037 (crea el CHECK original). Independiente de 061-071.
--
-- ═════════════════════════════════════════════════════════════════════════
-- HALLAZGO: la Fase 3.5.1 había agregado las columnas `reenviada_en` y
-- `historial_observaciones` (migración 070, "Pieza 0") asumiendo —por
-- evidencia INDIRECTA, nunca confirmada— que el CHECK de `estado` ya había
-- sido ampliado junto con esas columnas, fuera del flujo de migraciones
-- versionado. La confirmación directa en producción (este mensaje) muestra
-- que NO fue así: las columnas existen, pero el CHECK nunca se amplió. Esto
-- significa que, en producción HOY, cualquier intento de reenviar una
-- cartilla —ya sea del flujo histórico de Delegado Rentado
-- (usuario/cartilla-delegado.js, código que antecede a este desarrollo) o
-- del nuevo flujo institucional— falla con una violación de CHECK, nunca
-- llega a guardar `estado = 'reenviada'`. Es un defecto real y preexistente,
-- no introducido por las migraciones 061-071, pero que SÍ bloquea el reenvío
-- institucional recién construido si no se corrige.
--
-- DECISIÓN (nueva migración numerada, no editar la 070 ni ninguna anterior):
-- las migraciones 061-071 siguen sin aplicarse en producción, así que
-- técnicamente se podría haber ajustado 070 en el propio archivo. Se opta
-- por una migración NUEVA, numerada, por el mismo criterio ya aplicado en
-- cada fase anterior de este desarrollo (063 amplía el alias sin tocar 057;
-- 064 agrega una columna sin tocar 062; 070 reemplaza una función sin tocar
-- 066/067; 071 ajusta permisos sin tocar 069): cada corrección queda
-- registrada en su propio archivo, con su propio hallazgo documentado,
-- nunca reescribiendo lo que una fase anterior ya entregó y fue informado
-- al usuario como tal. Mantiene el historial auditable de qué se corrigió,
-- cuándo y por qué — incluso para migraciones que, de hecho, aún no se
-- ejecutaron en ningún ambiente real.
--
-- ADITIVA: preserva los 5 valores existentes exactamente (ninguna fila con
-- esos 5 valores deja de ser válida); agrega 'reenviada' como sexto valor
-- permitido. No cambia ninguna transición de estado en el código (sigue
-- siendo el propio backend el que decide cuándo pasar a 'reenviada', esta
-- migración solo permite que ese valor pueda guardarse). No modifica
-- ninguna fila existente, no migra datos, no afecta el comportamiento
-- histórico de Delegado Rentado más allá de —por primera vez— permitir que
-- su propio reenvío (funcionalidad ya existente en el código, nunca antes
-- en el esquema real) funcione sin error.
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE cartillas_delegado DROP CONSTRAINT IF EXISTS cartillas_delegado_estado_check;
ALTER TABLE cartillas_delegado ADD CONSTRAINT cartillas_delegado_estado_check
    CHECK (estado IN ('borrador', 'enviada', 'observada', 'aprobada', 'cerrada', 'reenviada'));

COMMENT ON CONSTRAINT cartillas_delegado_estado_check ON cartillas_delegado IS
    'Ampliado para incluir "reenviada" (corrección de compatibilidad confirmada contra producción real) — preserva los 5 valores históricos sin cambios. Antes de esta migración, el CHECK real de producción no permitía "reenviada", pese a que el código (Delegado Rentado e institucional) ya lo escribe.';

-- Reversible:
--   ALTER TABLE cartillas_delegado DROP CONSTRAINT IF EXISTS cartillas_delegado_estado_check;
--   ALTER TABLE cartillas_delegado ADD CONSTRAINT cartillas_delegado_estado_check
--       CHECK (estado IN ('borrador', 'enviada', 'observada', 'aprobada', 'cerrada'));
--   -- (el rollback fallaría si ya existen filas con estado='reenviada' —
--   --  intencional: nunca se revierte perdiendo la representación de datos
--   --  ya guardados, mismo criterio que el rollback del CHECK de 069).
