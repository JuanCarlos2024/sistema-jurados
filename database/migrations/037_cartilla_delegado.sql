-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 037 — Módulo Cartilla Delegado (Etapa 1)
--
-- Crea la tabla cartillas_delegado para el formulario estructurado digital del
-- Informe del Delegado Oficial del Rodeo.
--
-- El delegado lo completa desde su perfil, asociado al rodeo asignado.
-- Un índice UNIQUE(rodeo_id, delegado_id) evita duplicados.
--
-- IDEMPOTENTE: seguro ejecutar varias veces.
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS cartillas_delegado (
    id                              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    rodeo_id                        UUID        NOT NULL REFERENCES rodeos(id) ON DELETE CASCADE,
    delegado_id                     UUID        NOT NULL REFERENCES usuarios_pagados(id),
    asignacion_id                   UUID        REFERENCES asignaciones(id) ON DELETE SET NULL,

    -- Estado del ciclo de vida
    estado                          TEXT        NOT NULL DEFAULT 'borrador'
        CHECK (estado IN ('borrador', 'enviada', 'observada', 'aprobada', 'cerrada')),

    -- ── Sección I: Identificación del Rodeo ──────────────────────────────────
    temporada                       TEXT,
    fecha_rodeo                     DATE,
    delegado_nombre                 TEXT,
    delegado_telefono               TEXT,
    secretario_jurado               TEXT,
    secretario_numero_socio         TEXT,
    club_asociacion_organizador     TEXT,
    tipo_rodeo                      TEXT,
    publico_serie_campeones         INTEGER,

    -- Preguntas Sí/No
    serie_campeones_dos_vueltas     BOOLEAN,
    incluye_informe_disciplinario   BOOLEAN,
    incluye_informe_ganado_bajo_peso BOOLEAN,

    -- Certificación del Club Organizador
    certificacion_medialuna_comuna      BOOLEAN,
    certificacion_mas_200_personas      BOOLEAN,
    certificacion_mas_250_personas      BOOLEAN,
    certificacion_vinculacion_comunidad BOOLEAN,

    -- JSONB para secciones futuras (ganado, disciplina, bienestar, etc.)
    respuestas_json                 JSONB,

    -- Control de envío
    enviada_en                      TIMESTAMPTZ,
    creado_por                      UUID,
    actualizado_por                 UUID,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Solo una cartilla activa por rodeo y delegado
    CONSTRAINT cartillas_delegado_rodeo_delegado_unique UNIQUE(rodeo_id, delegado_id)
);

-- Índice para búsqueda por rodeo (admin)
CREATE INDEX IF NOT EXISTS idx_cartillas_delegado_rodeo_id
    ON cartillas_delegado(rodeo_id);

-- Índice para búsqueda por delegado (dashboard)
CREATE INDEX IF NOT EXISTS idx_cartillas_delegado_delegado_id
    ON cartillas_delegado(delegado_id);

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verificación
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    RAISE NOTICE 'tabla cartillas_delegado existe: %',
        (SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_name = 'cartillas_delegado'
        ));
END $$;
