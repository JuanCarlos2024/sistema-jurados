-- 018_cartillas_jurado.sql
-- Tabla para gestión de cartillas de jurado con formulario estructurado
-- El PDF final se guarda en rodeo_adjuntos (tipo_adjunto='cartilla_jurado') para activar el ticket CJ

CREATE TABLE IF NOT EXISTS cartillas_jurado (
    id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    asignacion_id     UUID NOT NULL REFERENCES asignaciones(id) ON DELETE CASCADE,
    rodeo_id          UUID NOT NULL REFERENCES rodeos(id) ON DELETE CASCADE,
    usuario_pagado_id UUID NOT NULL REFERENCES usuarios_pagados(id) ON DELETE CASCADE,
    estado            TEXT NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'enviada')),
    -- Todos los campos del formulario en JSONB para facilitar reportes futuros y no romper schema
    datos             JSONB NOT NULL DEFAULT '{}',
    -- Referencia al registro en rodeo_adjuntos donde quedó el PDF (se llena al enviar)
    adjunto_id        UUID,   -- sin FK para evitar dependencia circular
    storage_path_pdf  TEXT,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW(),
    enviada_en        TIMESTAMPTZ
);

-- Una cartilla por asignación
CREATE UNIQUE INDEX IF NOT EXISTS cartillas_jurado_asignacion_idx ON cartillas_jurado(asignacion_id);
CREATE INDEX IF NOT EXISTS cartillas_jurado_rodeo_idx         ON cartillas_jurado(rodeo_id);
CREATE INDEX IF NOT EXISTS cartillas_jurado_usuario_idx       ON cartillas_jurado(usuario_pagado_id);
CREATE INDEX IF NOT EXISTS cartillas_jurado_estado_idx        ON cartillas_jurado(estado);

-- Índice GIN para queries sobre datos JSON (reportes futuros)
CREATE INDEX IF NOT EXISTS cartillas_jurado_datos_gin ON cartillas_jurado USING GIN (datos);
