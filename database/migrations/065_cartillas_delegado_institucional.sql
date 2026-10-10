-- ═════════════════════════════════════════════════════════════════════════
-- 065_cartillas_delegado_institucional.sql
-- Fase 3 del nuevo perfil "Delegado de Asociación": permite que
-- `cartillas_delegado` también se origine desde una cuenta institucional,
-- SIN tocar el flujo de Delegado Rentado ni reinterpretar `delegado_id`.
--
-- CONFLICTO ESTRUCTURAL CONFIRMADO Y RESUELTO AQUÍ (verificado por lectura
-- directa de 037_cartilla_delegado.sql, línea 18):
--   delegado_id UUID NOT NULL REFERENCES usuarios_pagados(id)
-- Una cuenta institucional NO es una persona de usuarios_pagados — forzar
-- delegado_id a apuntar a un `delegados_asociacion.id` habría sido
-- EXACTAMENTE lo que el usuario prohibió explícitamente ("No modificar
-- cartillas_delegado.delegado_id para reemplazarlo por identificadores del
-- nuevo catálogo institucional"). Por eso esta migración:
--   1. Relaja delegado_id a NULLABLE (ALTER COLUMN ... DROP NOT NULL es
--      idempotente: no falla si ya es nullable).
--   2. Agrega columnas NUEVAS, independientes, para el origen institucional
--      — delegado_id de las 5 filas reales existentes (verificadas por
--      consulta de solo lectura) NO se toca, y ninguna cartilla de Delegado
--      Rentado futura cambia su comportamiento.
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — pendiente de autorización.
--
-- Garantías de integridad nuevas (aditivas):
--   · CHECK chk_cartillas_delegado_origen_unico: cada cartilla tiene
--     EXACTAMENTE un origen (delegado_id XOR delegado_asociacion_id) — nunca
--     ambos, nunca ninguno. Las 5 filas reales actuales (todas con
--     delegado_id NOT NULL, delegado_asociacion_id NULL por default al
--     agregarse la columna) YA cumplen esta condición sin necesidad de
--     backfill.
--   · Índice único PARCIAL uq_cartillas_delegado_rodeo_institucional:
--     "una sola cartilla institucional oficial por rodeo" — a diferencia de
--     cartillas_delegado_rodeo_delegado_unique (que es por rodeo+delegado,
--     y permite varios delegados_rentados distintos para el mismo rodeo,
--     confirmado 0 casos reales hoy), este índice es solo por rodeo_id
--     (ignora qué delegado_asociacion está seleccionado) — así cambiar el
--     delegado responsable de una cartilla institucional NUNCA crea una
--     segunda fila, y dos creaciones simultáneas para el mismo rodeo
--     chocan contra este índice de forma atómica (no es una verificación
--     previa desde JavaScript: es una restricción real de Postgres).
--   · `version` (INTEGER, default 1): control de concurrencia optimista
--     para guardar/enviar — el backend exige que el cliente envíe la
--     versión que leyó; si no coincide, el UPDATE no afecta ninguna fila
--     (WHERE id=? AND version=?) y la API devuelve 409. Se agrega a TODA la
--     tabla (también sirve para cartillas de Delegado Rentado futuras, sin
--     que el flujo actual la use todavía — aditivo, no rompe nada).
--
-- NO migra ni reinterpreta ninguna fila existente. NO crea cuentas
-- institucionales ni delegados. NO toca `cartillas_jurado` ni ninguna otra
-- tabla.
--
-- Idempotente: ADD COLUMN/INDEX IF NOT EXISTS, DROP NOT NULL es seguro
-- repetir. Si el CHECK ya existe, el bloque DO evita el error de duplicado.
-- Reversible:
--   DROP INDEX IF EXISTS uq_cartillas_delegado_rodeo_institucional;
--   ALTER TABLE cartillas_delegado DROP CONSTRAINT IF EXISTS chk_cartillas_delegado_origen_unico;
--   ALTER TABLE cartillas_delegado DROP COLUMN IF EXISTS delegado_asociacion_id;
--   ALTER TABLE cartillas_delegado DROP COLUMN IF EXISTS creado_por_cuenta_institucional_id;
--   ALTER TABLE cartillas_delegado DROP COLUMN IF EXISTS actualizado_por_cuenta_institucional_id;
--   ALTER TABLE cartillas_delegado DROP COLUMN IF EXISTS version;
--   -- (delegado_id se deja NULLABLE incluso al revertir: no hay forma segura
--   --  de saber si alguna fila real pasó a depender de la nulabilidad sin
--   --  antes auditar datos; revertir ese ALTER específico requiere decisión
--   --  humana, no se automatiza aquí.)
--
-- Validaciones a correr ANTES de aplicar en producción (no ejecutadas acá):
--   SELECT count(*) FROM cartillas_delegado WHERE delegado_id IS NULL;        -- debe dar 0 hoy
--   SELECT rodeo_id, count(*) FROM cartillas_delegado GROUP BY rodeo_id HAVING count(*) > 1;  -- debe dar 0 filas hoy (verificado por auditoría: 0)
--
-- Orden de ejecución: después de 057 (rodeos/asociaciones, ya aplicada) y de
-- 061/062/064 (cuentas_institucionales/delegados_asociacion — deben
-- aplicarse ANTES que esta, porque las FK nuevas las referencian). 037 ya
-- está aplicada (tabla base). Independiente de 063.
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE cartillas_delegado ALTER COLUMN delegado_id DROP NOT NULL;

ALTER TABLE cartillas_delegado
    ADD COLUMN IF NOT EXISTS delegado_asociacion_id UUID REFERENCES delegados_asociacion(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS creado_por_cuenta_institucional_id UUID REFERENCES cuentas_institucionales(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS actualizado_por_cuenta_institucional_id UUID REFERENCES cuentas_institucionales(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'cartillas_delegado'::regclass AND conname = 'chk_cartillas_delegado_origen_unico'
    ) THEN
        ALTER TABLE cartillas_delegado
            ADD CONSTRAINT chk_cartillas_delegado_origen_unico
            CHECK ((delegado_id IS NOT NULL) <> (delegado_asociacion_id IS NOT NULL));
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cartillas_delegado_rodeo_institucional
    ON cartillas_delegado (rodeo_id) WHERE delegado_asociacion_id IS NOT NULL;

COMMENT ON COLUMN cartillas_delegado.delegado_asociacion_id IS
    'Delegado certificado DECLARADO como responsable por una cuenta institucional. Mutuamente excluyente con delegado_id (ver CHECK chk_cartillas_delegado_origen_unico) — nunca se usa delegado_id para esto.';
COMMENT ON COLUMN cartillas_delegado.creado_por_cuenta_institucional_id IS
    'Cuenta institucional que REALMENTE creó la cartilla (autenticación real) — distinta de delegado_asociacion_id, que es la identidad declarada/responsable.';
COMMENT ON COLUMN cartillas_delegado.version IS
    'Control de concurrencia optimista: toda actualización exige WHERE version=<la leída>; si no coincide, 0 filas afectadas -> 409 en la API.';
