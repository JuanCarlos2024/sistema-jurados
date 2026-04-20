-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 017 — Hoja de Vida: fichas internas y notas por rodeo
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Crea dos tablas nuevas:
--   fichas_internas  — evaluación interna del administrador (1:1 con usuario_pagado)
--   notas_rodeo      — nota global por asignación (1:1 con asignaciones)
--
-- IDEMPOTENTE: usa IF NOT EXISTS — seguro para ejecutar varias veces.
-- APLICAR en: Supabase → SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Ficha interna: una por persona ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fichas_internas (
    id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_pagado_id         UUID        NOT NULL UNIQUE REFERENCES usuarios_pagados(id),

    -- Atributos de desempeño
    caracter                  TEXT        CHECK (caracter               IN ('Excelente','Bueno','Regular','Deficiente')),
    liderazgo                 TEXT        CHECK (liderazgo              IN ('Fuerte','Mediano','Débil')),
    habilidades_blandas       TEXT        CHECK (habilidades_blandas    IN ('Excelente','Bueno','Regular','Deficiente')),
    puntualidad               TEXT        CHECK (puntualidad            IN ('Excelente','Bueno','Regular','Deficiente')),
    responsabilidad_admin     TEXT        CHECK (responsabilidad_admin  IN ('Excelente','Bueno','Regular','Deficiente')),
    trabajo_equipo            TEXT        CHECK (trabajo_equipo         IN ('Excelente','Bueno','Regular','Deficiente')),
    comunicacion              TEXT        CHECK (comunicacion           IN ('Excelente','Bueno','Regular','Deficiente')),
    manejo_presion            TEXT        CHECK (manejo_presion         IN ('Excelente','Bueno','Regular','Deficiente')),

    -- Disponibilidad
    disponibilidad_viajes     BOOLEAN,
    disponibilidad_reemplazos BOOLEAN,

    -- Geográfico
    zona_preferente           TEXT,
    restricciones_geograficas TEXT,

    -- Observaciones y recomendación
    observaciones_tecnicas    TEXT,
    observaciones_conductuales TEXT,
    recomendacion             TEXT        CHECK (recomendacion IN ('Alta','Media','Baja')),
    comentarios_admin         TEXT,

    -- Trazabilidad
    evaluado_en               TIMESTAMPTZ,
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by                TEXT        -- UUID del admin (TEXT para evitar FK a admins)
);

-- ── Nota por rodeo: una por asignación ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS notas_rodeo (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    asignacion_id  UUID        NOT NULL UNIQUE REFERENCES asignaciones(id),

    nota           NUMERIC(4,2) NOT NULL
                   CHECK (nota >= 1.0 AND nota <= 7.0),  -- escala chilena 1-7
    comentario     TEXT,

    -- Trazabilidad
    evaluado_en    TIMESTAMPTZ,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by     TEXT        -- UUID del admin
);

-- ── Índices de búsqueda frecuente ────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_fichas_usuario   ON fichas_internas(usuario_pagado_id);
CREATE INDEX IF NOT EXISTS idx_notas_asignacion ON notas_rodeo(asignacion_id);

-- ── Verificación ──────────────────────────────────────────────────────────────
DO $$
BEGIN
    RAISE NOTICE '=== RESULTADO MIGRACIÓN 017 ===';
    RAISE NOTICE 'Tabla fichas_internas: %', (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'fichas_internas'));
    RAISE NOTICE 'Tabla notas_rodeo:     %', (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'notas_rodeo'));
    RAISE NOTICE '✓ Hoja de Vida lista.';
END $$;

COMMIT;
