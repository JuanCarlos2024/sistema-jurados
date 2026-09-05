-- ═════════════════════════════════════════════════════════════════════════
-- 047_propuestas_designacion.sql
-- Propuesta de Designación — Etapa 4: propuesta BORRADOR persistente
--
-- ⚠️  PROPUESTA — NO APLICADA EN PRODUCCIÓN. Requiere autorización expresa
--     antes de ejecutarse. Preparada para revisión (SQL, constraints,
--     índices, FKs, estados, compatibilidad) únicamente.
--
-- Objetivo: guardar el resultado de una simulación DRY-RUN como una
-- propuesta administrativa BORRADOR que se puede revisar, aceptar y
-- modificar en el tiempo, SIN crear ninguna asignación real.
--
-- CRÍTICO — una fila de propuestas_designacion_detalle NO ES una
-- asignación: no aparece en Rodeos, portal del jurado, disponibilidad,
-- pagos, hoja de vida, ni en ningún contador oficial de designaciones.
-- Vive exclusivamente dentro de este módulo. Nada de esta migración toca
-- la tabla `asignaciones` ni ninguna de sus columnas (publicado incluido).
--
-- Aditiva y reversible. Sin DROP. Sin modificar ninguna tabla existente.
-- Ambas tablas nacen vacías.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. propuestas_designacion — la propuesta en sí (cabecera)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS propuestas_designacion (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    temporada_id    UUID        REFERENCES temporadas(id),
    estado          TEXT        NOT NULL DEFAULT 'BORRADOR'
                                 CHECK (estado IN ('BORRADOR', 'CONFIRMADA', 'DESCARTADA')),
    creado_por      UUID        REFERENCES administradores(id),
    confirmado_en   TIMESTAMPTZ, -- NULL en esta etapa; lo usará la Etapa 5 al confirmar
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_propdesig_estado ON propuestas_designacion(estado);
CREATE INDEX IF NOT EXISTS idx_propdesig_temporada ON propuestas_designacion(temporada_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. propuestas_designacion_detalle — un rodeo dentro de una propuesta
-- ─────────────────────────────────────────────────────────────────────────
-- estado_revision:
--   PENDIENTE      → el motor propuso un jurado, el administrador no ha
--                    decidido todavía (ni aceptado ni modificado).
--   ACEPTADO       → jurado_id_seleccionado = jurado_id_propuesto,
--                    confirmado por el administrador.
--   MODIFICADO     → jurado_id_seleccionado distinto de jurado_id_propuesto
--                    (o igual pero con advertencias aceptadas manualmente).
--   SIN_PROPUESTA  → el motor no encontró ningún candidato válido (se
--                    conserva tal cual; el administrador puede igual
--                    seleccionar uno manualmente vía MODIFICAR).
--   NO_EVALUABLE   → faltan datos estructurales (comuna/clasificación) —
--                    no se puede seleccionar jurado para esta fila.
--
-- origen_seleccion:
--   MOTOR                  → jurado_id_seleccionado = jurado_id_propuesto,
--                             sin advertencias.
--   MANUAL                 → el administrador eligió un candidato válido
--                             distinto al propuesto por el motor.
--   MANUAL_CON_ADVERTENCIA → el administrador eligió un candidato que
--                             incumple alguna regla o genera conflicto
--                             interno con otra fila de la misma propuesta,
--                             y confirmó explícitamente la excepción.
CREATE TABLE IF NOT EXISTS propuestas_designacion_detalle (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    propuesta_id            UUID        NOT NULL REFERENCES propuestas_designacion(id) ON DELETE CASCADE,
    rodeo_id                UUID        NOT NULL REFERENCES rodeos(id),
    jurado_id_propuesto     UUID        REFERENCES usuarios_pagados(id),
    jurado_id_seleccionado  UUID        REFERENCES usuarios_pagados(id),
    estado_revision         TEXT        NOT NULL
                                         CHECK (estado_revision IN ('PENDIENTE', 'ACEPTADO', 'MODIFICADO', 'SIN_PROPUESTA', 'NO_EVALUABLE')),
    origen_seleccion        TEXT        CHECK (origen_seleccion IN ('MOTOR', 'MANUAL', 'MANUAL_CON_ADVERTENCIA')),
    explicacion_json        JSONB,      -- checks/top_candidatos/descartados/causa del dry-run original
    metricas_json           JSONB,      -- distancia, designaciones, candidatos evaluados, advertencias aceptadas
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Un mismo rodeo no puede repetirse DENTRO de la misma propuesta. Distintas
-- propuestas SÍ pueden compartir un rodeo (se advierte en la aplicación,
-- no se bloquea a nivel de base de datos — ver services/propuestaDesignacion.js).
CREATE UNIQUE INDEX IF NOT EXISTS idx_propdesig_detalle_unico ON propuestas_designacion_detalle(propuesta_id, rodeo_id);
CREATE INDEX IF NOT EXISTS idx_propdesig_detalle_propuesta ON propuestas_designacion_detalle(propuesta_id);
CREATE INDEX IF NOT EXISTS idx_propdesig_detalle_rodeo ON propuestas_designacion_detalle(rodeo_id);
CREATE INDEX IF NOT EXISTS idx_propdesig_detalle_jurado_sel ON propuestas_designacion_detalle(jurado_id_seleccionado);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. RLS — sin políticas públicas. El backend opera exclusivamente con la
-- service_role key, que siempre bypassea RLS (verificado empíricamente en
-- este proyecto: rolbypassrls=true), así que esto no afecta al backend en
-- absoluto. anon/authenticated quedan SIN acceso a estas dos tablas (RLS
-- habilitado + cero políticas = denegación total para cualquier rol que no
-- bypasee RLS). Es más estricto que el resto del esquema (donde RLS está
-- deshabilitado en todas las tablas existentes) — un endurecimiento
-- deliberado y aislado a estas dos tablas nuevas, sin tocar las demás.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE propuestas_designacion ENABLE ROW LEVEL SECURITY;
ALTER TABLE propuestas_designacion_detalle ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ── Verificación sugerida post-aplicación (no destructiva) ─────────────────
-- SELECT count(*) FROM propuestas_designacion;            -- esperado: 0
-- SELECT count(*) FROM propuestas_designacion_detalle;    -- esperado: 0
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid IN ('propuestas_designacion'::regclass, 'propuestas_designacion_detalle'::regclass);
