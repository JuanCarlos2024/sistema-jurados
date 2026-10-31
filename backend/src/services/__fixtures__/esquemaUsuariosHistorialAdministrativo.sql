-- Esquema MÍNIMO para probar la migración 087 (Observaciones Administrativas,
-- nuevos estados de usuario, historial de cambios de categoría) en un
-- Postgres de prueba (PGlite). Réplica de las columnas/constraints REALES de
-- usuarios_pagados / usuario_historial_cambios ya verificadas contra
-- producción (jurados_2026) en esta revisión. NO es una migración — no se
-- publica ni se aplica en ningún entorno real.
CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;

CREATE TABLE administradores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre_completo TEXT NOT NULL DEFAULT 'x',
    rol_evaluacion TEXT,
    activo BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE usuarios_pagados (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo_persona TEXT NOT NULL CHECK (tipo_persona = ANY (ARRAY['jurado','delegado_rentado'])),
    nombre_completo TEXT NOT NULL,
    categoria TEXT CHECK (categoria = ANY (ARRAY['A','B','C']) OR categoria IS NULL),
    activo BOOLEAN NOT NULL DEFAULT true,
    estado_usuario TEXT DEFAULT 'activo' CHECK (estado_usuario = ANY (ARRAY['activo','inactivo','receso','suspendido'])),
    suspension_desde DATE, suspension_hasta DATE, suspension_motivo TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE usuario_historial_cambios (
    id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    usuario_pagado_id UUID        NOT NULL REFERENCES usuarios_pagados(id) ON DELETE CASCADE,
    tipo_cambio       TEXT        NOT NULL CHECK (tipo_cambio IN ('estado', 'categoria', 'suspension')),
    valor_anterior    TEXT,
    valor_nuevo       TEXT        NOT NULL,
    cambiado_por      UUID        REFERENCES administradores(id),
    cambiado_por_nombre TEXT,
    cambiado_en       TIMESTAMPTZ DEFAULT now(),
    observacion       TEXT,
    fecha_desde       DATE,
    fecha_hasta       DATE
);
