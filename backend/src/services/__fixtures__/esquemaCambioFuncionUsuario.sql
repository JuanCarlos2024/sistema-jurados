-- Esquema MÍNIMO para probar la migración 100 (cambio de función Jurado <->
-- Delegado Rentado) en PGlite. Réplica de las columnas/constraints REALES
-- verificadas en producción (jurados_2026) el 2026-11-13: CHECKs de
-- usuarios_pagados, CHECK vigente de usuario_historial_cambios (incluye
-- 'asociacion', migración 089), CHECKs de estado de cartillas_jurado y
-- cartillas_delegado. NO es una migración: no se aplica en ningún entorno.
CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;

CREATE TABLE administradores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre_completo TEXT NOT NULL DEFAULT 'x'
);

CREATE TABLE usuarios_pagados (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo_interno TEXT UNIQUE NOT NULL,
    tipo_persona TEXT NOT NULL CHECK (tipo_persona = ANY (ARRAY['jurado','delegado_rentado'])),
    nombre_completo TEXT NOT NULL,
    rut TEXT,
    categoria TEXT CHECK (categoria = ANY (ARRAY['A','B','C']) OR categoria IS NULL),
    password_hash TEXT NOT NULL DEFAULT 'hash',
    activo BOOLEAN NOT NULL DEFAULT true,
    primer_login BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE usuario_historial_cambios (
    id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    usuario_pagado_id UUID        NOT NULL REFERENCES usuarios_pagados(id) ON DELETE CASCADE,
    tipo_cambio       TEXT        NOT NULL,
    valor_anterior    TEXT,
    valor_nuevo       TEXT        NOT NULL,
    cambiado_por      UUID        REFERENCES administradores(id),
    cambiado_por_nombre TEXT,
    cambiado_en       TIMESTAMPTZ DEFAULT now(),
    observacion       TEXT,
    fecha_desde       DATE,
    fecha_hasta       DATE,
    fecha_efectiva    DATE,
    CONSTRAINT usuario_historial_cambios_tipo_cambio_check
        CHECK (tipo_cambio IN ('estado', 'categoria', 'suspension', 'no_certificado', 'en_retiro', 'asociacion'))
);

CREATE TABLE rodeos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club TEXT, asociacion TEXT,
    fecha DATE NOT NULL,
    duracion_dias INTEGER DEFAULT 1,
    estado TEXT NOT NULL DEFAULT 'activo'
);

CREATE TABLE asignaciones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rodeo_id UUID NOT NULL REFERENCES rodeos(id),
    usuario_pagado_id UUID REFERENCES usuarios_pagados(id),
    tipo_persona TEXT NOT NULL,
    categoria_aplicada TEXT,
    pago_base_calculado INTEGER,
    estado TEXT NOT NULL DEFAULT 'activo',
    estado_designacion VARCHAR DEFAULT 'pendiente'
);

CREATE TABLE notas_rodeo (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asignacion_id UUID REFERENCES asignaciones(id),
    nota NUMERIC
);

CREATE TABLE cartillas_jurado (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asignacion_id UUID REFERENCES asignaciones(id),
    rodeo_id UUID REFERENCES rodeos(id),
    usuario_pagado_id UUID REFERENCES usuarios_pagados(id),
    estado TEXT NOT NULL CHECK (estado = ANY (ARRAY['borrador','enviada','reabierta','corregida','anulada'])),
    es_actual BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE cartillas_delegado (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rodeo_id UUID REFERENCES rodeos(id),
    delegado_id UUID REFERENCES usuarios_pagados(id),
    delegado_asociacion_id UUID,
    estado TEXT NOT NULL CHECK (estado = ANY (ARRAY['borrador','enviada','observada','aprobada','cerrada','reenviada','reabierta'])),
    CHECK ((delegado_id IS NOT NULL) <> (delegado_asociacion_id IS NOT NULL))
);

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
