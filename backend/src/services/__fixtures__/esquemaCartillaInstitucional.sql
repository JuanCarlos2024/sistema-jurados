-- Esquema MÍNIMO (solo las tablas base que las migraciones 037/061/062/064/065/066
-- necesitan como FK) para probar, contra un Postgres REAL de prueba (PGlite), la
-- migración 065 (conflicto delegado_id NOT NULL resuelto) y la RPC 066
-- (creación/adjunto atómico de cartilla institucional, incluida la concurrencia).
-- NO es una migración — es un fixture de test, igual patrón que
-- esquemaImportacionHistorica.sql (no se modifica ese archivo, es de otro módulo).
CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;

CREATE TABLE administradores (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre_completo TEXT NOT NULL DEFAULT 'x', activo BOOLEAN NOT NULL DEFAULT true);
CREATE TABLE usuarios_pagados (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tipo_persona TEXT NOT NULL, nombre_completo TEXT NOT NULL, activo BOOLEAN NOT NULL DEFAULT true);
CREATE TABLE asociaciones (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre TEXT NOT NULL, nombre_normalizado TEXT NOT NULL, activa BOOLEAN NOT NULL DEFAULT true);
CREATE TABLE rodeos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), club TEXT NOT NULL, asociacion TEXT NOT NULL, fecha DATE NOT NULL,
    tipo_rodeo_nombre TEXT, estado TEXT NOT NULL DEFAULT 'activo',
    CONSTRAINT rodeos_estado_check CHECK (estado = ANY (ARRAY['activo','anulado']))
);
-- Columnas reales de asignaciones relevantes para la Fase 3.1 (designación
-- efectiva de Delegado Rentado), tomadas de database/schema.sql + migraciones
-- 002/009/043 ya aplicadas en el esquema real (no se re-aplican aquí como
-- archivos de migración porque son anteriores al rango 037-066 que este
-- fixture reproduce; se reproducen sus columnas/defaults finales directamente).
CREATE TABLE asignaciones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rodeo_id UUID REFERENCES rodeos(id),
    usuario_pagado_id UUID REFERENCES usuarios_pagados(id),
    tipo_persona TEXT NOT NULL CHECK (tipo_persona IN ('jurado','delegado_rentado')),
    estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','pendiente_revision','anulado')),
    estado_designacion VARCHAR(20) DEFAULT 'pendiente',
    publicado BOOLEAN NOT NULL DEFAULT false,
    publicado_en TIMESTAMPTZ,
    observacion TEXT
);

-- Reproduce la tabla auditoria real (database/schema.sql), incluido su CHECK
-- ORIGINAL (sin 'cuenta_institucional'), para que la migración 069 ejercite
-- de verdad el DROP/ADD CONSTRAINT que corrige el bug detectado en Fase 3.5
-- (ningún archivo previo 037/061-068 escribe en auditoria, por eso esta tabla
-- nunca fue necesaria en este fixture hasta ahora).
CREATE TABLE auditoria (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tabla TEXT NOT NULL,
    registro_id TEXT,
    accion TEXT NOT NULL,
    datos_anteriores JSONB,
    datos_nuevos JSONB,
    actor_id TEXT NOT NULL,
    actor_tipo TEXT NOT NULL CHECK (actor_tipo IN ('administrador', 'usuario_pagado')),
    descripcion TEXT,
    ip_address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
