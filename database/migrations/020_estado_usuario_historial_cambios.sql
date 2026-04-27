-- 020_estado_usuario_historial_cambios.sql
-- Agrega campo estado_usuario (activo|inactivo|receso) y tabla de historial de cambios

-- 1. Columna estado_usuario en usuarios_pagados
ALTER TABLE usuarios_pagados
    ADD COLUMN IF NOT EXISTS estado_usuario TEXT
    DEFAULT 'activo'
    CHECK (estado_usuario IN ('activo', 'inactivo', 'receso'));

-- Sincronizar con campo activo existente
UPDATE usuarios_pagados
SET estado_usuario = CASE WHEN activo THEN 'activo' ELSE 'inactivo' END
WHERE estado_usuario IS NULL OR estado_usuario = 'activo';

-- 2. Tabla de historial de cambios de estado y categoría
CREATE TABLE IF NOT EXISTS usuario_historial_cambios (
    id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    usuario_pagado_id UUID        NOT NULL REFERENCES usuarios_pagados(id) ON DELETE CASCADE,
    tipo_cambio       TEXT        NOT NULL CHECK (tipo_cambio IN ('estado', 'categoria')),
    valor_anterior    TEXT,
    valor_nuevo       TEXT        NOT NULL,
    cambiado_por      UUID        REFERENCES administradores(id),
    cambiado_por_nombre TEXT,
    cambiado_en       TIMESTAMPTZ DEFAULT NOW(),
    observacion       TEXT
);

CREATE INDEX IF NOT EXISTS idx_uhc_usuario_pagado_id ON usuario_historial_cambios(usuario_pagado_id);
CREATE INDEX IF NOT EXISTS idx_uhc_cambiado_en       ON usuario_historial_cambios(cambiado_en DESC);
