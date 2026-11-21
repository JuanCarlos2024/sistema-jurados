-- Esquema MÍNIMO para probar la migración 103 (revisiones de Comisión y
-- bloqueo de publicación) en un Postgres de prueba (PGlite). Columnas y
-- CHECK de las tablas de evaluación copiados de producción (consultados el
-- 2026-11-18). Sobre este esquema se aplica primero la publicar_evaluacion
-- VIGENTE en producción (publicarEvaluacionProduccionReferencia.sql) y
-- después la 103, igual que ocurrirá en el despliegue real. NO es una
-- migración.
CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;

CREATE TABLE administradores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre_completo TEXT NOT NULL DEFAULT 'x',
    rol_evaluacion TEXT, activo BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE usuarios_pagados (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tipo_persona TEXT NOT NULL,
    nombre_completo TEXT NOT NULL, categoria TEXT, activo BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE rodeos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), club TEXT NOT NULL, asociacion TEXT NOT NULL,
    fecha DATE NOT NULL, estado TEXT NOT NULL DEFAULT 'activo'
);
CREATE TABLE asignaciones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), rodeo_id UUID NOT NULL REFERENCES rodeos(id),
    usuario_pagado_id UUID REFERENCES usuarios_pagados(id), tipo_persona TEXT NOT NULL,
    nombre_importado TEXT, estado TEXT NOT NULL DEFAULT 'activo', estado_designacion VARCHAR DEFAULT 'aceptado'
);
CREATE TABLE notas_rodeo (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), asignacion_id UUID NOT NULL UNIQUE REFERENCES asignaciones(id),
    nota NUMERIC NOT NULL, comentario TEXT, evaluado_en TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by TEXT, fuente TEXT NOT NULL DEFAULT 'manual', puntaje_evaluacion INTEGER,
    calificacion_cualitativa TEXT, evaluacion_id UUID,
    usuario_pagado_id_evaluado_snapshot UUID, nombre_evaluado_snapshot TEXT,
    CONSTRAINT notas_rodeo_fuente_check CHECK (fuente = ANY (ARRAY['manual','evaluacion_tecnica'])),
    CONSTRAINT notas_rodeo_nota_check CHECK (nota >= 1.0 AND nota <= 7.0)
);

CREATE TABLE evaluaciones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), rodeo_id UUID NOT NULL UNIQUE REFERENCES rodeos(id),
    analista_id UUID REFERENCES administradores(id),
    estado TEXT NOT NULL DEFAULT 'borrador', puntaje_base INTEGER NOT NULL DEFAULT 80,
    puntaje_final INTEGER, nota_final NUMERIC, nota_publicada BOOLEAN NOT NULL DEFAULT false,
    observacion_general TEXT,
    decision_jefe TEXT, comentario_jefe TEXT, fecha_decision_jefe TIMESTAMPTZ, jefe_id UUID REFERENCES administradores(id),
    creado_por UUID REFERENCES administradores(id),
    anulada BOOLEAN NOT NULL DEFAULT false,
    resultados_alterados BOOLEAN NOT NULL DEFAULT false, comentario_resultados_alterados TEXT,
    modo_flujo TEXT DEFAULT 'descuento_automatico',
    es_historica_importacion BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT evaluaciones_estado_check CHECK (estado = ANY (ARRAY['borrador','en_proceso','pendiente_comision','pendiente_aprobacion','devuelto','aprobado','publicado','cerrado'])),
    CONSTRAINT evaluaciones_decision_jefe_check CHECK (decision_jefe = ANY (ARRAY['aprobado','devuelto']))
);
CREATE TABLE evaluacion_ciclos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), evaluacion_id UUID NOT NULL REFERENCES evaluaciones(id),
    numero_ciclo INTEGER NOT NULL CHECK (numero_ciclo IN (1, 2)),
    estado TEXT NOT NULL DEFAULT 'pendiente_carga'
        CHECK (estado IN ('pendiente_carga','sin_casos','cargado','abierto','en_revision','cerrado')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (evaluacion_id, numero_ciclo)
);
CREATE TABLE evaluacion_casos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), ciclo_id UUID NOT NULL REFERENCES evaluacion_ciclos(id),
    evaluacion_id UUID NOT NULL REFERENCES evaluaciones(id), numero_caso INTEGER NOT NULL,
    tipo_caso TEXT NOT NULL CHECK (tipo_caso IN ('interpretativa','reglamentaria','informativo')),
    descripcion TEXT, video_url TEXT,
    descuento_puntos INTEGER NOT NULL DEFAULT 0 CHECK (descuento_puntos IN (0, 1, 2)),
    estado TEXT NOT NULL DEFAULT 'cargado'
        CHECK (estado IN ('cargado','visible_jurado','consolidado','pendiente_analista','derivado_comision','resuelto')),
    resolucion_final TEXT CHECK (resolucion_final IN ('sin_descuento','interpretativa_confirmada','reglamentaria_confirmada','apelacion_acogida','apelacion_rechazada')),
    decision_analista TEXT CHECK (decision_analista IN ('mantener','revertir','derivar_comision')),
    comentario_analista TEXT, analista_decidio_en TIMESTAMPTZ, analista_id UUID,
    decision_comision TEXT CHECK (decision_comision IN ('aprueba_apelacion','rechaza_apelacion')),
    comentario_comision TEXT, comision_decidio_en TIMESTAMPTZ, comision_miembro_id UUID REFERENCES administradores(id),
    cargado_por UUID, anulado BOOLEAN DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (ciclo_id, numero_caso),
    CONSTRAINT chk_comentario_comision CHECK (decision_comision IS NULL OR (comentario_comision IS NOT NULL AND length(trim(comentario_comision)) > 0))
);
CREATE TABLE evaluacion_auditoria (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), evaluacion_id UUID REFERENCES evaluaciones(id),
    caso_id UUID REFERENCES evaluacion_casos(id), ciclo_id UUID REFERENCES evaluacion_ciclos(id),
    accion TEXT NOT NULL, detalle JSONB, actor_id UUID NOT NULL,
    actor_tipo TEXT NOT NULL CHECK (actor_tipo IN ('administrador', 'usuario_pagado')),
    actor_nombre TEXT, ip_address INET, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE evaluacion_escala_puntaje_nota (
    id SERIAL PRIMARY KEY, puntaje INTEGER NOT NULL UNIQUE CHECK (puntaje >= 0),
    nota NUMERIC(4,2) NOT NULL CHECK (nota >= 1.0 AND nota <= 7.0), activo BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE evaluacion_escala_calificacion (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY, categoria TEXT NOT NULL CHECK (categoria IN ('A','B','C')),
    nota_min NUMERIC(4,2) NOT NULL, nota_max NUMERIC(4,2) NOT NULL,
    calificacion TEXT NOT NULL, activo BOOLEAN NOT NULL DEFAULT TRUE
);

-- Escala real (extracto): 80 → 7.0, 79 → 6.6, 78 → 6.3, 77 → 5.9.
INSERT INTO evaluacion_escala_puntaje_nota (puntaje, nota) VALUES
    (80, 7.0), (79, 6.6), (78, 6.3), (77, 5.9), (76, 5.5), (0, 1.0);
INSERT INTO evaluacion_escala_calificacion (categoria, nota_min, nota_max, calificacion) VALUES
    ('A', 1.0, 6.49, 'BIEN'), ('A', 6.5, 7.0, 'SOBRESALIENTE');
