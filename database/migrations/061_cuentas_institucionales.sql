-- ═════════════════════════════════════════════════════════════════════════
-- 061_cuentas_institucionales.sql
-- Fase 1 del nuevo perfil "Delegado de Asociación": cuentas institucionales
-- (una por asociación, ej. delegado-osorno@ferochi.com), separadas de
-- `usuarios_pagados` y `asignaciones` a propósito — esas dos tablas modelan
-- una PERSONA FÍSICA PAGADA por rodeo (CHECK tipo_persona IN ('jurado',
-- 'delegado_rentado'), campos de pago NOT NULL en asignaciones). Una cuenta
-- institucional no es una persona pagada ni tiene asignación individual, por
-- lo que ampliar esos CHECK habría sido forzar un concepto distinto dentro de
-- un modelo que no lo representa — de ahí esta tabla nueva e independiente,
-- que NO modifica `usuarios_pagados` ni `asignaciones` de ninguna forma.
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — pendiente de autorización.
--
-- Migración ADITIVA y segura:
--   · Tabla nueva, sin tocar ninguna tabla existente.
--   · FK `asociacion_id` → asociaciones(id) (tabla ya aplicada en producción,
--     migración 057, 56 filas reales verificadas por consulta de solo
--     lectura) — la vinculación es por identificador estable, nunca por
--     coincidencia de texto.
--   · `rol_institucional` se deja como CHECK de un solo valor
--     ('delegado_asociacion') a propósito: la auditoría pidió "preparar
--     compatibilidad futura con Comisión de Asociación, pero no implementar
--     ese segundo perfil todavía". Agregar 'comision_asociacion' más
--     adelante será un ALTER TABLE ... DROP CONSTRAINT + ADD CONSTRAINT
--     aditivo sobre esta misma tabla, sin migrar datos.
--   · `primer_login` reutiliza el mismo nombre/semántica que
--     `usuarios_pagados.primer_login` (cambio de contraseña obligatorio en
--     el primer ingreso) — mismo patrón ya usado en el resto del sistema.
--   · `ultimo_acceso_en` no tiene precedente en el esquema actual (ninguna
--     tabla de usuarios registra último acceso hoy); se agrega porque la
--     Fase 1 lo pidió explícitamente.
--
-- Idempotente: CREATE TABLE/INDEX IF NOT EXISTS — se puede ejecutar más de
-- una vez sin error y sin duplicar nada.
--
-- Reversible: DROP TABLE IF EXISTS cuentas_institucionales; (no hay FKs de
-- otras tablas hacia esta, por lo que el rollback no tiene efectos en
-- cascada sobre datos existentes — no se crea ninguna cuenta real en esta
-- fase, así que el rollback tampoco perdería información real).
--
-- Orden de ejecución: independiente de 062_delegados_asociacion.sql (ambas
-- dependen solo de 057, ya aplicada); no existe dependencia entre sí.
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cuentas_institucionales (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email               TEXT        UNIQUE NOT NULL,
    password_hash       TEXT        NOT NULL,
    asociacion_id       UUID        NOT NULL REFERENCES asociaciones(id),
    rol_institucional   TEXT        NOT NULL DEFAULT 'delegado_asociacion'
                        CHECK (rol_institucional IN ('delegado_asociacion')),
    activo              BOOLEAN     NOT NULL DEFAULT TRUE,
    primer_login        BOOLEAN     NOT NULL DEFAULT TRUE,
    ultimo_acceso_en     TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by          UUID        REFERENCES administradores(id),
    CONSTRAINT chk_cuentas_institucionales_email CHECK (btrim(email) <> '')
);

COMMENT ON TABLE cuentas_institucionales IS
    'Cuentas institucionales (1 por asociación) para el perfil Delegado de Asociación. NO es una persona física pagada: independiente de usuarios_pagados/asignaciones.';
COMMENT ON COLUMN cuentas_institucionales.rol_institucional IS
    'Hoy solo "delegado_asociacion". Reservado para extender a "comision_asociacion" en una fase futura sin migrar datos existentes.';
COMMENT ON COLUMN cuentas_institucionales.primer_login IS
    'TRUE hasta que la cuenta cambie su contraseña inicial por primera vez — mismo patrón que usuarios_pagados.primer_login.';

CREATE INDEX IF NOT EXISTS idx_cuentas_institucionales_asociacion ON cuentas_institucionales (asociacion_id);
