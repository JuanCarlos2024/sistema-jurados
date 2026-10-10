-- ═════════════════════════════════════════════════════════════════════════
-- 062_delegados_asociacion.sql
-- Fase 1 del nuevo perfil "Delegado de Asociación": catálogo de identidad de
-- delegados por asociación (QUIÉN puede ser seleccionado al completar una
-- Cartilla de Delegado desde una cuenta institucional). Fuente inicial:
-- LISTADELEGADOS.xlsx — la auditoría encontró que ese archivo es en realidad
-- una planilla de EVALUACIÓN (columnas BUENAS/%/NOTA, con 7 personas
-- repetidas en evaluaciones distintas), no un directorio de identidad único.
-- Por eso esta tabla solo guarda nombre + asociación (decisión 5): ninguna
-- columna de puntaje/evaluación se traslada aquí.
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — pendiente de autorización.
--
-- Migración ADITIVA y segura:
--   · Tabla nueva, sin tocar ninguna tabla existente.
--   · FK `asociacion_id` → asociaciones(id), igual criterio que 061: nunca
--     por coincidencia de texto.
--   · `activo` permite desactivar un delegado sin perder su historial (soft
--     delete, mismo patrón que usuarios_pagados.activo/administradores.activo).
--   · UNIQUE(nombre_normalizado, asociacion_id): cada persona aparece una
--     única vez por asociación en el selector (decisión 5) — pero NO impide
--     que la misma persona exista bajo asociaciones distintas (no hay UNIQUE
--     global por nombre), porque eso sí puede ser legítimo.
--   · Esta migración NO carga ningún dato: la preparación/consolidación del
--     listado real se hace con una función pura versionada en código
--     (services/delegadosAsociacion.js, cubierta por tests), nunca mediante
--     un INSERT masivo en esta fase.
--
-- Idempotente: CREATE TABLE/INDEX IF NOT EXISTS.
-- Reversible: DROP TABLE IF EXISTS delegados_asociacion; (sin FKs entrantes
-- de otras tablas; sin datos reales cargados en esta fase).
-- Orden de ejecución: independiente de 061_cuentas_institucionales.sql.
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS delegados_asociacion (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre              TEXT        NOT NULL,
    nombre_normalizado  TEXT        NOT NULL,
    asociacion_id       UUID        NOT NULL REFERENCES asociaciones(id),
    activo              BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by          UUID        REFERENCES administradores(id),
    CONSTRAINT uq_delegados_asociacion_nombre_asoc UNIQUE (nombre_normalizado, asociacion_id),
    CONSTRAINT chk_delegados_asociacion_nombre CHECK (btrim(nombre) <> '' AND btrim(nombre_normalizado) <> '')
);

COMMENT ON TABLE delegados_asociacion IS
    'Catálogo de identidad (nombre + asociación) de delegados seleccionables al completar una Cartilla de Delegado desde una cuenta institucional. Sin datos de evaluación/puntaje: ver services/delegadosAsociacion.js.';

CREATE INDEX IF NOT EXISTS idx_delegados_asociacion_asociacion ON delegados_asociacion (asociacion_id);
