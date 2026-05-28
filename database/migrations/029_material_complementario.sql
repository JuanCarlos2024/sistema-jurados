-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 029 — Módulo: Material Complementario (Parte 1)
--
-- CONTENIDO:
--   A. Tabla material_complementario
--   B. Índices
--
-- IDEMPOTENTE: seguro ejecutar varias veces.
-- APLICAR en: Supabase → SQL Editor
--
-- NOTA SOBRE ALMACENAMIENTO DE ARCHIVOS:
--   Los archivos se guardan en el bucket de Supabase Storage "rodeo-adjuntos"
--   bajo el prefijo "materiales/". No se requiere crear un bucket nuevo.
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- A. Tabla principal
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS material_complementario (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Contenido
    titulo          TEXT        NOT NULL CHECK (LENGTH(TRIM(titulo)) > 0),
    descripcion     TEXT,
    categoria       TEXT,

    -- Tipo de material y estado
    tipo_material   TEXT        NOT NULL
        CHECK (tipo_material IN ('pdf','word','excel','imagen','youtube','link_externo','video_externo')),
    estado          TEXT        NOT NULL DEFAULT 'borrador'
        CHECK (estado IN ('borrador','publicado','archivado')),

    -- Archivo adjunto (Supabase Storage — bucket "rodeo-adjuntos", prefijo "materiales/")
    url_archivo     TEXT,       -- storage_path (e.g. "materiales/1234_documento.pdf")
    nombre_archivo  TEXT,       -- nombre original del archivo
    mime_type       TEXT,
    tamano_archivo  INTEGER,    -- bytes

    -- Enlace externo (YouTube, link externo, video externo)
    url_externa     TEXT,

    -- Audiencia y clasificación
    audiencia       TEXT        NOT NULL DEFAULT 'jurados'
        CHECK (audiencia IN ('jurados','delegados','ambos')),
    obligatorio     BOOLEAN     NOT NULL DEFAULT FALSE,
    orden           INTEGER     NOT NULL DEFAULT 0,

    -- Trazabilidad
    creado_por      UUID        NOT NULL REFERENCES administradores(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ             -- borrado lógico; NULL = activo
);

-- ─────────────────────────────────────────────────────────────────────────────
-- B. Índices
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_material_estado    ON material_complementario(estado)    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_material_audiencia ON material_complementario(audiencia) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_material_orden     ON material_complementario(orden)     WHERE deleted_at IS NULL;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verificación
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    RAISE NOTICE 'material_complementario: %',
        (SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_name = 'material_complementario'
        ));
END $$;
