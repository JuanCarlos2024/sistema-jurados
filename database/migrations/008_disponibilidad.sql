-- Migración 008: calendario de disponibilidad mensual de jurados/delegados
-- Cada fila representa un día en que el usuario marcó disponibilidad.
-- La combinación (usuario_pagado_id, fecha) es única: una fila por día.
-- Solo informativo; no bloquea asignaciones.

CREATE TABLE IF NOT EXISTS disponibilidad_usuarios (
    id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    usuario_pagado_id  UUID NOT NULL REFERENCES usuarios_pagados(id) ON DELETE CASCADE,
    fecha              DATE NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_disponibilidad UNIQUE (usuario_pagado_id, fecha)
);

-- Índices para consultas frecuentes del admin (por fecha, por usuario)
CREATE INDEX IF NOT EXISTS idx_disponibilidad_fecha   ON disponibilidad_usuarios(fecha);
CREATE INDEX IF NOT EXISTS idx_disponibilidad_usuario ON disponibilidad_usuarios(usuario_pagado_id);
