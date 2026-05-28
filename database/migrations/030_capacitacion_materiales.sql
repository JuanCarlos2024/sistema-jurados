-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 030 — Etapa 3 Material Complementario
--
-- CONTENIDO:
--   A. Tabla capacitacion_materiales     (relación N:M prueba ↔ material)
--   B. Tabla material_complementario_interacciones (tracking de uso)
--   C. Índices
--
-- IDEMPOTENTE: seguro ejecutar varias veces.
-- APLICAR en: Supabase → SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- A. Relación entre capacitaciones (pruebas) y materiales complementarios
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS capacitacion_materiales (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    capacitacion_id UUID        NOT NULL REFERENCES capacitacion_pruebas(id) ON DELETE CASCADE,
    material_id     UUID        NOT NULL REFERENCES material_complementario(id) ON DELETE CASCADE,
    obligatorio     BOOLEAN     NOT NULL DEFAULT FALSE,
    orden           INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(capacitacion_id, material_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- B. Registro de interacciones de usuarios con materiales
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS material_complementario_interacciones (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    material_id      UUID        NOT NULL REFERENCES material_complementario(id) ON DELETE CASCADE,
    usuario_id       UUID        NOT NULL REFERENCES usuarios_pagados(id) ON DELETE CASCADE,
    capacitacion_id  UUID        REFERENCES capacitacion_pruebas(id) ON DELETE SET NULL,
    tipo_interaccion TEXT        NOT NULL CHECK (tipo_interaccion IN ('visualizacion','descarga','apertura_link')),
    rol_usuario      TEXT        NOT NULL CHECK (rol_usuario IN ('jurado','delegado','admin')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- C. Índices
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_cap_mat_cap     ON capacitacion_materiales(capacitacion_id);
CREATE INDEX IF NOT EXISTS idx_cap_mat_mat     ON capacitacion_materiales(material_id);
CREATE INDEX IF NOT EXISTS idx_mc_int_material ON material_complementario_interacciones(material_id);
CREATE INDEX IF NOT EXISTS idx_mc_int_usuario  ON material_complementario_interacciones(usuario_id);
CREATE INDEX IF NOT EXISTS idx_mc_int_cap      ON material_complementario_interacciones(capacitacion_id);
CREATE INDEX IF NOT EXISTS idx_mc_int_fecha    ON material_complementario_interacciones(created_at DESC);

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verificación
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    RAISE NOTICE 'capacitacion_materiales: %',
        (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'capacitacion_materiales'));
    RAISE NOTICE 'material_complementario_interacciones: %',
        (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'material_complementario_interacciones'));
END $$;
