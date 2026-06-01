-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 033 — Material Complementario: Nuevos proveedores de video
--
-- CONTENIDO:
--   A. Ampliar CHECK de tipo_material → agrega 'sharepoint' y 'notebooklm'
--   B. Nueva columna video_embed_html (código iframe sanitizado)
--
-- IDEMPOTENTE: seguro ejecutar varias veces.
-- APLICAR en: Supabase → SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- A. Ampliar el CHECK de tipo_material
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    -- Intentar eliminar el constraint auto-generado por PostgreSQL
    BEGIN
        ALTER TABLE material_complementario
            DROP CONSTRAINT material_complementario_tipo_material_check;
    EXCEPTION WHEN undefined_object THEN NULL;
    END;

    -- Agregar constraint con los tipos extendidos (nombre único para idempotencia)
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'material_complementario'
          AND c.conname  = 'mc_tipo_material_v033'
    ) THEN
        ALTER TABLE material_complementario
            ADD CONSTRAINT mc_tipo_material_v033
            CHECK (tipo_material IN (
                'pdf','word','excel','imagen',
                'youtube','link_externo','video_externo',
                'sharepoint','notebooklm'
            ));
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- B. Columna para código iframe sanitizado (SharePoint embed, etc.)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE material_complementario
    ADD COLUMN IF NOT EXISTS video_embed_html TEXT;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verificación
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    RAISE NOTICE 'Migration 033 OK — columna video_embed_html presente: %',
        (SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name  = 'material_complementario'
              AND column_name = 'video_embed_html'
        ));
END $$;
