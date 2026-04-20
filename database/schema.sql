-- ============================================================
-- SISTEMA DE JURADOS - FEDERACIÓN DE RODEO CHILENO
-- Schema SQL para Supabase (PostgreSQL)
-- ============================================================

-- Habilitar extensión para UUIDs
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- TABLA: administradores
-- ============================================================
CREATE TABLE IF NOT EXISTS administradores (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre_completo TEXT        NOT NULL,
    email           TEXT        UNIQUE NOT NULL,
    password_hash   TEXT        NOT NULL,
    activo          BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- TABLA: usuarios_pagados
-- Cubre tanto jurados como delegados rentados
-- ============================================================
CREATE TABLE IF NOT EXISTS usuarios_pagados (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo_interno  TEXT        UNIQUE NOT NULL,           -- USR-0001
    tipo_persona    TEXT        NOT NULL
                    CHECK (tipo_persona IN ('jurado', 'delegado_rentado')),
    nombre_completo TEXT        NOT NULL,
    rut             TEXT        UNIQUE,                    -- 12345678-9, NULL hasta primer login
    categoria       TEXT
                    CHECK (categoria IN ('A', 'B', 'C') OR categoria IS NULL),
    direccion       TEXT,
    comuna          TEXT,
    ciudad          TEXT,
    telefono        TEXT,
    email           TEXT        UNIQUE,
    password_hash   TEXT        NOT NULL,
    perfil_completo BOOLEAN     NOT NULL DEFAULT FALSE,
    primer_login    BOOLEAN     NOT NULL DEFAULT TRUE,
    activo          BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      UUID        REFERENCES administradores(id)
);

-- Índices para búsqueda frecuente
CREATE INDEX IF NOT EXISTS idx_usuarios_rut ON usuarios_pagados(rut);
CREATE INDEX IF NOT EXISTS idx_usuarios_codigo ON usuarios_pagados(codigo_interno);
CREATE INDEX IF NOT EXISTS idx_usuarios_tipo ON usuarios_pagados(tipo_persona);
CREATE INDEX IF NOT EXISTS idx_usuarios_activo ON usuarios_pagados(activo);

-- ============================================================
-- TABLA: configuracion_tarifas
-- Una fila por categoría (A, B, C, DR). Solo se actualiza.
-- ============================================================
CREATE TABLE IF NOT EXISTS configuracion_tarifas (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    categoria       TEXT        NOT NULL UNIQUE
                    CHECK (categoria IN ('A', 'B', 'C', 'DR')),
    valor_diario    INTEGER     NOT NULL,                  -- CLP
    valor_2_dias    INTEGER     NOT NULL,                  -- CLP referencia
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      UUID        REFERENCES administradores(id)
);

-- Insertar valores iniciales
INSERT INTO configuracion_tarifas (categoria, valor_diario, valor_2_dias) VALUES
    ('A',  292000, 584000),
    ('B',  245000, 490000),
    ('C',  213500, 427000),
    ('DR', 257250, 514500)
ON CONFLICT (categoria) DO NOTHING;

-- ============================================================
-- TABLA: configuracion_retencion
-- Una sola fila. Solo se actualiza.
-- ============================================================
CREATE TABLE IF NOT EXISTS configuracion_retencion (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    porcentaje      NUMERIC(5,2) NOT NULL DEFAULT 15.25,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      UUID        REFERENCES administradores(id)
);

-- Insertar valor inicial
INSERT INTO configuracion_retencion (porcentaje) VALUES (15.25)
ON CONFLICT DO NOTHING;

-- ============================================================
-- TABLA: bonos_config
-- Configuración de bonos por distancia (modificable por admin)
-- ============================================================
CREATE TABLE IF NOT EXISTS bonos_config (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre           TEXT        NOT NULL,
    distancia_minima INTEGER     NOT NULL,                 -- km
    distancia_maxima INTEGER,                              -- NULL = sin límite
    monto            INTEGER     NOT NULL,                 -- CLP
    activo           BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by       UUID        REFERENCES administradores(id)
);

-- Insertar bonos iniciales
INSERT INTO bonos_config (nombre, distancia_minima, distancia_maxima, monto) VALUES
    ('Bono 350-499 km', 350, 499, 35000),
    ('Bono 500+ km',    500, NULL, 55000)
ON CONFLICT DO NOTHING;

-- ============================================================
-- TABLA: tipos_rodeo
-- Catálogo maestro de tipos de rodeo
-- ============================================================
CREATE TABLE IF NOT EXISTS tipos_rodeo (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre          TEXT        NOT NULL UNIQUE,
    duracion_dias   INTEGER     NOT NULL CHECK (duracion_dias BETWEEN 1 AND 5),
    activo          BOOLEAN     NOT NULL DEFAULT TRUE,
    observacion     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tipos_rodeo_activo ON tipos_rodeo(activo);

-- ============================================================
-- TABLA: importaciones
-- Registro de cada carga de Excel
-- ============================================================
CREATE TABLE IF NOT EXISTS importaciones (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre_archivo  TEXT        NOT NULL,
    total_filas     INTEGER     NOT NULL DEFAULT 0,
    insertadas      INTEGER     NOT NULL DEFAULT 0,
    pendientes      INTEGER     NOT NULL DEFAULT 0,
    duplicadas      INTEGER     NOT NULL DEFAULT 0,
    rechazadas      INTEGER     NOT NULL DEFAULT 0,
    errores         INTEGER     NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      UUID        REFERENCES administradores(id)
);

-- ============================================================
-- TABLA: rodeos
-- Cada evento/rodeo
-- ============================================================
CREATE TABLE IF NOT EXISTS rodeos (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    club            TEXT        NOT NULL,
    asociacion      TEXT        NOT NULL,
    fecha           DATE        NOT NULL,
    tipo_rodeo_id   UUID        REFERENCES tipos_rodeo(id),
    tipo_rodeo_nombre TEXT,                                -- snapshot del nombre
    duracion_dias   INTEGER     NOT NULL CHECK (duracion_dias BETWEEN 1 AND 5),
    observacion     TEXT,
    origen          TEXT        NOT NULL DEFAULT 'manual'
                    CHECK (origen IN ('importado', 'manual')),
    estado          TEXT        NOT NULL DEFAULT 'activo'
                    CHECK (estado IN ('activo', 'anulado')),
    importacion_id  UUID        REFERENCES importaciones(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      UUID        REFERENCES administradores(id)
);

CREATE INDEX IF NOT EXISTS idx_rodeos_fecha ON rodeos(fecha);
CREATE INDEX IF NOT EXISTS idx_rodeos_tipo ON rodeos(tipo_rodeo_id);
CREATE INDEX IF NOT EXISTS idx_rodeos_estado ON rodeos(estado);
CREATE INDEX IF NOT EXISTS idx_rodeos_importacion ON rodeos(importacion_id);

-- ============================================================
-- TABLA: asignaciones
-- Personas asignadas a cada rodeo (N por rodeo)
-- ============================================================
CREATE TABLE IF NOT EXISTS asignaciones (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    rodeo_id                UUID        NOT NULL REFERENCES rodeos(id),
    usuario_pagado_id       UUID        REFERENCES usuarios_pagados(id),  -- NULL si pendiente
    tipo_persona            TEXT        NOT NULL
                            CHECK (tipo_persona IN ('jurado', 'delegado_rentado')),
    nombre_importado        TEXT,                          -- nombre original del Excel
    categoria_aplicada      TEXT
                            CHECK (categoria_aplicada IN ('A', 'B', 'C') OR categoria_aplicada IS NULL),
    valor_diario_aplicado   INTEGER     NOT NULL,          -- snapshot inmutable
    duracion_dias_aplicada  INTEGER     NOT NULL,          -- snapshot inmutable
    pago_base_calculado     INTEGER     NOT NULL,          -- snapshot inmutable
    estado                  TEXT        NOT NULL DEFAULT 'activo'
                            CHECK (estado IN ('activo', 'pendiente_revision', 'anulado')),
    problema                TEXT
                            CHECK (problema IN (
                                'jurado_no_encontrado',
                                'tipo_rodeo_no_encontrado',
                                'datos_incompletos',
                                'duplicado'
                            ) OR problema IS NULL),
    observacion             TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by              UUID        REFERENCES administradores(id)
);

CREATE INDEX IF NOT EXISTS idx_asignaciones_rodeo ON asignaciones(rodeo_id);
CREATE INDEX IF NOT EXISTS idx_asignaciones_usuario ON asignaciones(usuario_pagado_id);
CREATE INDEX IF NOT EXISTS idx_asignaciones_estado ON asignaciones(estado);
CREATE INDEX IF NOT EXISTS idx_asignaciones_tipo ON asignaciones(tipo_persona);

-- ============================================================
-- TABLA: bonos_solicitados
-- Bonos por distancia solicitados o asignados manualmente
-- ============================================================
CREATE TABLE IF NOT EXISTS bonos_solicitados (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    asignacion_id       UUID        NOT NULL REFERENCES asignaciones(id),
    usuario_pagado_id   UUID        NOT NULL REFERENCES usuarios_pagados(id),
    bono_config_id      UUID        REFERENCES bonos_config(id),  -- NULL si admin ingresó libre
    distancia_declarada INTEGER     NOT NULL,              -- km declarados
    monto_solicitado    INTEGER     NOT NULL,              -- según tabla bonos_config
    monto_aprobado      INTEGER,                          -- puede diferir si admin modifica
    estado              TEXT        NOT NULL DEFAULT 'pendiente'
                        CHECK (estado IN ('pendiente', 'aprobado', 'rechazado', 'modificado')),
    observacion_usuario TEXT,
    observacion_admin   TEXT,
    revisado_por        UUID        REFERENCES administradores(id),
    revisado_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bonos_asignacion ON bonos_solicitados(asignacion_id);
CREATE INDEX IF NOT EXISTS idx_bonos_usuario ON bonos_solicitados(usuario_pagado_id);
CREATE INDEX IF NOT EXISTS idx_bonos_estado ON bonos_solicitados(estado);

-- ============================================================
-- TABLA: importaciones_pendientes
-- Filas del Excel que no se pudieron procesar automáticamente
-- ============================================================
CREATE TABLE IF NOT EXISTS importaciones_pendientes (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    importacion_id      UUID        NOT NULL REFERENCES importaciones(id),
    datos_originales    JSONB       NOT NULL,              -- fila completa del Excel
    problema            TEXT        NOT NULL
                        CHECK (problema IN (
                            'jurado_no_encontrado',
                            'tipo_rodeo_no_encontrado',
                            'datos_incompletos',
                            'duplicado'
                        )),
    estado              TEXT        NOT NULL DEFAULT 'pendiente'
                        CHECK (estado IN ('pendiente', 'resuelto', 'descartado')),
    asignacion_id       UUID        REFERENCES asignaciones(id),
    rodeo_id            UUID        REFERENCES rodeos(id),
    resuelto_por        UUID        REFERENCES administradores(id),
    resuelto_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pendientes_importacion ON importaciones_pendientes(importacion_id);
CREATE INDEX IF NOT EXISTS idx_pendientes_estado ON importaciones_pendientes(estado);

-- ============================================================
-- TABLA: auditoria
-- Registro de todas las acciones importantes del sistema
-- ============================================================
CREATE TABLE IF NOT EXISTS auditoria (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tabla            TEXT        NOT NULL,
    registro_id      TEXT,
    accion           TEXT        NOT NULL,
    datos_anteriores JSONB,
    datos_nuevos     JSONB,
    actor_id         TEXT        NOT NULL,
    actor_tipo       TEXT        NOT NULL
                     CHECK (actor_tipo IN ('administrador', 'usuario_pagado')),
    descripcion      TEXT,
    ip_address       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auditoria_tabla ON auditoria(tabla);
CREATE INDEX IF NOT EXISTS idx_auditoria_actor ON auditoria(actor_id);
CREATE INDEX IF NOT EXISTS idx_auditoria_accion ON auditoria(accion);
CREATE INDEX IF NOT EXISTS idx_auditoria_created ON auditoria(created_at DESC);

-- ============================================================
-- SECUENCIA para codigo_interno de usuarios (USR-0001)
-- ============================================================
CREATE SEQUENCE IF NOT EXISTS seq_codigo_usuario START 1 INCREMENT 1;

-- Función para generar código interno
CREATE OR REPLACE FUNCTION generar_codigo_usuario()
RETURNS TEXT AS $$
BEGIN
    RETURN 'USR-' || LPAD(nextval('seq_codigo_usuario')::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- VISTAS útiles
-- ============================================================

-- Vista: resumen de asignación con datos completos
CREATE OR REPLACE VIEW v_asignaciones_completas AS
SELECT
    a.id,
    a.rodeo_id,
    r.club,
    r.asociacion,
    r.fecha,
    r.tipo_rodeo_nombre,
    r.duracion_dias AS rodeo_duracion,
    a.usuario_pagado_id,
    u.codigo_interno,
    u.nombre_completo,
    u.rut,
    a.tipo_persona,
    a.nombre_importado,
    a.categoria_aplicada,
    a.valor_diario_aplicado,
    a.duracion_dias_aplicada,
    a.pago_base_calculado,
    a.estado,
    a.problema,
    a.observacion,
    a.created_at,
    a.updated_at,
    -- Bono activo si existe
    bs.id AS bono_id,
    bs.estado AS bono_estado,
    bs.monto_solicitado,
    bs.monto_aprobado,
    bs.distancia_declarada
FROM asignaciones a
LEFT JOIN rodeos r ON a.rodeo_id = r.id
LEFT JOIN usuarios_pagados u ON a.usuario_pagado_id = u.id
LEFT JOIN LATERAL (
    SELECT id, estado, monto_solicitado, monto_aprobado, distancia_declarada
    FROM bonos_solicitados
    WHERE asignacion_id = a.id
    ORDER BY created_at DESC LIMIT 1
) bs ON TRUE;

-- ============================================================
-- COMENTARIOS en tablas
-- ============================================================
COMMENT ON TABLE administradores IS 'Usuarios con rol de administrador del sistema';
COMMENT ON TABLE usuarios_pagados IS 'Jurados y delegados rentados que reciben pago';
COMMENT ON TABLE configuracion_tarifas IS 'Tarifas diarias por categoría (A, B, C). 3 filas fijas.';
COMMENT ON TABLE configuracion_retencion IS 'Porcentaje de retención aplicado al bruto. 1 fila fija.';
COMMENT ON TABLE bonos_config IS 'Configuración de tipos de bono por distancia';
COMMENT ON TABLE tipos_rodeo IS 'Catálogo maestro de tipos de rodeo con duración en días';
COMMENT ON TABLE rodeos IS 'Cada evento/rodeo registrado en el sistema';
COMMENT ON TABLE asignaciones IS 'Personas asignadas a cada rodeo con valores snapshot';
COMMENT ON TABLE bonos_solicitados IS 'Bonos por distancia solicitados por usuarios o asignados por admin';
COMMENT ON TABLE importaciones IS 'Registro de cada carga de Excel realizada';
COMMENT ON TABLE importaciones_pendientes IS 'Filas del Excel que requieren revisión manual';
COMMENT ON TABLE auditoria IS 'Log de todas las acciones importantes del sistema';

COMMENT ON COLUMN asignaciones.valor_diario_aplicado IS 'Snapshot inmutable: valor al momento de crear la asignación';
COMMENT ON COLUMN asignaciones.pago_base_calculado IS 'Snapshot inmutable: valor_diario_aplicado * duracion_dias_aplicada';
COMMENT ON COLUMN usuarios_pagados.rut IS 'NULL hasta que el usuario completa su perfil en primer login';
COMMENT ON COLUMN usuarios_pagados.codigo_interno IS 'USR-0001 - usado solo para login inicial';
