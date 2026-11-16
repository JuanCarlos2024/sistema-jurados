-- Esquema MÍNIMO para probar la migración 101 (resultados Serie de
-- Campeones desde Control de Gestión) en PGlite. Réplica de las columnas y
-- constraints REALES verificadas en producción el 2026-11-16:
--   rodeos.estado CHECK (activo|anulado); datos_monitor_rodeo con
--   puntajes TEXT (migración 032), UNIQUE(rodeo_id), FK ON DELETE CASCADE;
--   auditoria con CHECK de actor_tipo. NO es una migración.
CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;

CREATE TABLE rodeos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club TEXT NOT NULL DEFAULT 'CLUB',
    asociacion TEXT NOT NULL DEFAULT 'ASOC',
    fecha DATE NOT NULL DEFAULT '2026-09-18',
    duracion_dias INTEGER NOT NULL DEFAULT 1 CHECK (duracion_dias >= 1 AND duracion_dias <= 5),
    estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado = ANY (ARRAY['activo','anulado']))
);

CREATE TABLE datos_monitor_rodeo (
    id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    rodeo_id            uuid NOT NULL UNIQUE REFERENCES rodeos(id) ON DELETE CASCADE,
    puntaje_oficial_1er text,
    puntaje_oficial_2do text,
    puntaje_oficial_3er text,
    comentario_monitor  text,
    updated_at          timestamptz DEFAULT now(),
    control_gestion_ultimo_bloque text
);

CREATE TABLE auditoria (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tabla TEXT NOT NULL,
    registro_id TEXT,
    accion TEXT NOT NULL,
    datos_anteriores JSONB,
    datos_nuevos JSONB,
    actor_id TEXT NOT NULL,
    actor_tipo TEXT NOT NULL CHECK (actor_tipo = ANY (ARRAY['administrador','usuario_pagado','cuenta_institucional'])),
    descripcion TEXT,
    ip_address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
