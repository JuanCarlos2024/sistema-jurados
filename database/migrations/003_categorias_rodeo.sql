-- ============================================================
-- Migración 003: Categorías de rodeo
-- Ejecutar en Supabase SQL Editor antes de desplegar el backend
-- ============================================================

-- 1. Tabla de categorías
CREATE TABLE IF NOT EXISTS categorias_rodeo (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre     VARCHAR(50) NOT NULL,
    activo     BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT categorias_rodeo_nombre_unique UNIQUE (nombre)
);

-- 2. Datos iniciales
INSERT INTO categorias_rodeo (nombre) VALUES
    ('Primera'), ('Segunda'), ('Tercera'), ('Cuarta'), ('Especial')
ON CONFLICT (nombre) DO NOTHING;

-- 3. Columnas en la tabla rodeos
ALTER TABLE rodeos
    ADD COLUMN IF NOT EXISTS categoria_rodeo_id     UUID REFERENCES categorias_rodeo(id),
    ADD COLUMN IF NOT EXISTS categoria_rodeo_nombre  VARCHAR(50);

-- Los rodeos existentes quedan con categoria_rodeo_id = NULL
-- El sistema los muestra como "Sin categoría"
