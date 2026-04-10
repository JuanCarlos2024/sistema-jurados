-- ─── Migración 004: Módulo de adjuntos por rodeo ────────────────────────────
-- Crea tablas rodeo_adjuntos y rodeo_links para archivos y links YouTube por rodeo

-- Tabla de adjuntos (archivos PDF/Word/Imagen subidos a Supabase Storage)
CREATE TABLE IF NOT EXISTS rodeo_adjuntos (
    id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    rodeo_id           UUID NOT NULL REFERENCES rodeos(id) ON DELETE CASCADE,
    asignacion_id      UUID REFERENCES asignaciones(id) ON DELETE SET NULL,
    usuario_pagado_id  UUID REFERENCES usuarios_pagados(id) ON DELETE SET NULL,
    subido_por_admin   BOOLEAN NOT NULL DEFAULT false,
    tipo_adjunto       TEXT NOT NULL DEFAULT 'otro'
                       CHECK (tipo_adjunto IN ('planilla', 'contrato', 'foto', 'otro')),
    nombre_archivo     TEXT NOT NULL,
    storage_path       TEXT NOT NULL UNIQUE,
    mime_type          TEXT NOT NULL,
    tamano_bytes       INTEGER,
    created_by         UUID,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tabla de links de YouTube
CREATE TABLE IF NOT EXISTS rodeo_links (
    id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    rodeo_id           UUID NOT NULL REFERENCES rodeos(id) ON DELETE CASCADE,
    asignacion_id      UUID REFERENCES asignaciones(id) ON DELETE SET NULL,
    usuario_pagado_id  UUID REFERENCES usuarios_pagados(id) ON DELETE SET NULL,
    subido_por_admin   BOOLEAN NOT NULL DEFAULT false,
    url                TEXT NOT NULL,
    descripcion        TEXT,
    created_by         UUID,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índices para consultas frecuentes
CREATE INDEX IF NOT EXISTS idx_rodeo_adjuntos_rodeo   ON rodeo_adjuntos(rodeo_id);
CREATE INDEX IF NOT EXISTS idx_rodeo_adjuntos_usuario ON rodeo_adjuntos(usuario_pagado_id);
CREATE INDEX IF NOT EXISTS idx_rodeo_links_rodeo      ON rodeo_links(rodeo_id);
CREATE INDEX IF NOT EXISTS idx_rodeo_links_usuario    ON rodeo_links(usuario_pagado_id);

-- Bucket de Storage creado manualmente en Supabase Dashboard:
--   Nombre: rodeo-adjuntos
--   Acceso: privado (solo acceso mediante signed URLs)
