-- Esquema MÍNIMO para probar la migración 091 (sincronización transaccional
-- rodeo <-> asignaciones, bug ANCUD/CHILOÉ) en un Postgres de prueba
-- (PGlite). Réplica de las columnas/constraints reales de las tablas que
-- 091 referencia o modifica. NO es una migración — no se publica ni se
-- aplica en ningún entorno real.
--
-- Base: mismo esquema ya usado y probado por esquemaBitacoraDesignaciones.sql
-- (083/084, ver reemplazoJuradoAsignacion.rpc.test.js) — se reutiliza tal
-- cual para que 091 (que incluye un CREATE OR REPLACE de la función de 084)
-- se pruebe exactamente sobre el mismo terreno ya validado, más las tablas
-- que 091 agrega (`importaciones`, `auditoria`) y las columnas que le faltan
-- a `rodeos`/`asignaciones` (tipo_rodeo_id, tipo_rodeo_nombre, importacion_id
-- — ver migración 060, que las agrega en producción real).
CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;

CREATE TABLE administradores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre_completo TEXT NOT NULL DEFAULT 'x',
    activo BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE temporadas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre TEXT NOT NULL,
    fecha_inicio DATE NOT NULL, fecha_fin DATE NOT NULL
);
CREATE TABLE usuarios_pagados (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tipo_persona TEXT NOT NULL,
    nombre_completo TEXT NOT NULL, categoria TEXT, activo BOOLEAN NOT NULL DEFAULT true
);

-- importaciones/auditoria — réplica exacta de esquemaImportacionHistorica.sql
-- (migración 060), que ya se usa y prueba aparte en
-- importacionHistorica.rpc.test.js.
CREATE TABLE importaciones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre_archivo TEXT NOT NULL DEFAULT 'x', total_filas INTEGER NOT NULL DEFAULT 0,
    insertadas INTEGER NOT NULL DEFAULT 0, pendientes INTEGER NOT NULL DEFAULT 0, duplicadas INTEGER NOT NULL DEFAULT 0,
    rechazadas INTEGER NOT NULL DEFAULT 0, errores INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID REFERENCES administradores(id), tipo TEXT NOT NULL DEFAULT 'rodeos',
    CONSTRAINT chk_importaciones_tipo CHECK (tipo = ANY (ARRAY['rodeos','control_gestion','historico_rodeos','historico_colleras','catalogo_asociaciones']))
);
CREATE TABLE auditoria (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tabla TEXT NOT NULL, registro_id TEXT, accion TEXT NOT NULL, datos_anteriores JSONB,
    datos_nuevos JSONB, actor_id TEXT NOT NULL, actor_tipo TEXT NOT NULL, descripcion TEXT, ip_address TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT auditoria_actor_tipo_check CHECK (actor_tipo = ANY (ARRAY['administrador','usuario_pagado']))
);

CREATE TABLE rodeos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), club TEXT NOT NULL, asociacion TEXT NOT NULL,
    fecha DATE NOT NULL, duracion_dias INTEGER NOT NULL DEFAULT 1,
    tipo_rodeo_id UUID, tipo_rodeo_nombre TEXT,
    estado TEXT NOT NULL DEFAULT 'activo',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT rodeos_estado_check CHECK (estado = ANY (ARRAY['activo','anulado']))
);
CREATE TABLE asignaciones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), rodeo_id UUID NOT NULL REFERENCES rodeos(id),
    usuario_pagado_id UUID REFERENCES usuarios_pagados(id), tipo_persona TEXT NOT NULL,
    nombre_importado TEXT, categoria_aplicada TEXT, valor_diario_aplicado INTEGER NOT NULL DEFAULT 0,
    duracion_dias_aplicada INTEGER NOT NULL DEFAULT 1, pago_base_calculado INTEGER NOT NULL DEFAULT 0,
    estado TEXT NOT NULL DEFAULT 'activo', estado_designacion VARCHAR DEFAULT 'pendiente',
    propuesta_detalle_id UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    aceptado_en TIMESTAMPTZ, observacion_designacion TEXT, publicado BOOLEAN NOT NULL DEFAULT false, distancia_km INTEGER,
    created_by UUID, importacion_id UUID REFERENCES importaciones(id),
    CONSTRAINT asignaciones_estado_check CHECK (estado = ANY (ARRAY['activo','pendiente_revision','anulado'])),
    CONSTRAINT asignaciones_tipo_persona_check CHECK (tipo_persona = ANY (ARRAY['jurado','delegado_rentado']))
);

CREATE TABLE disponibilidad_usuarios (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_pagado_id UUID NOT NULL REFERENCES usuarios_pagados(id),
    fecha DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE propuestas_designacion (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), temporada_id UUID REFERENCES temporadas(id),
    estado TEXT NOT NULL DEFAULT 'BORRADOR' CHECK (estado IN ('BORRADOR', 'CONFIRMADA', 'DESCARTADA')),
    creado_por UUID REFERENCES administradores(id), confirmado_en TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE propuestas_designacion_detalle (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    propuesta_id UUID NOT NULL REFERENCES propuestas_designacion(id) ON DELETE CASCADE,
    rodeo_id UUID NOT NULL REFERENCES rodeos(id),
    jurado_id_propuesto UUID REFERENCES usuarios_pagados(id),
    jurado_id_seleccionado UUID REFERENCES usuarios_pagados(id),
    estado_revision TEXT NOT NULL CHECK (estado_revision IN ('PENDIENTE', 'ACEPTADO', 'MODIFICADO', 'SIN_PROPUESTA', 'NO_EVALUABLE', 'SIN_JURADO_ACTUAL')),
    origen_seleccion TEXT CHECK (origen_seleccion IN ('MOTOR', 'MANUAL', 'MANUAL_CON_ADVERTENCIA')),
    explicacion_json JSONB, metricas_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE notas_rodeo (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), asignacion_id UUID NOT NULL UNIQUE REFERENCES asignaciones(id),
    nota NUMERIC NOT NULL, comentario TEXT, evaluado_en TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by TEXT, fuente TEXT NOT NULL DEFAULT 'manual', puntaje_evaluacion INTEGER,
    calificacion_cualitativa TEXT, evaluacion_id UUID,
    CONSTRAINT notas_rodeo_fuente_check CHECK (fuente = ANY (ARRAY['manual','evaluacion_tecnica'])),
    CONSTRAINT notas_rodeo_nota_check CHECK (nota >= 1.0 AND nota <= 7.0)
);

CREATE TABLE evaluaciones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), rodeo_id UUID NOT NULL UNIQUE REFERENCES rodeos(id),
    creado_por UUID REFERENCES administradores(id), jefe_id UUID REFERENCES administradores(id),
    estado TEXT NOT NULL DEFAULT 'borrador', puntaje_base INTEGER NOT NULL DEFAULT 80,
    puntaje_final INTEGER, nota_final NUMERIC, decision_jefe TEXT, comentario_jefe TEXT,
    fecha_decision_jefe TIMESTAMPTZ, nota_publicada BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT evaluaciones_estado_check CHECK (estado = ANY (ARRAY['borrador','en_proceso','pendiente_comision','pendiente_aprobacion','devuelto','aprobado','publicado','cerrado']))
);
CREATE TABLE evaluacion_casos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), evaluacion_id UUID NOT NULL REFERENCES evaluaciones(id),
    estado TEXT NOT NULL DEFAULT 'resuelto', descuento_puntos INTEGER NOT NULL DEFAULT 0,
    resolucion_final TEXT, anulado BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE evaluacion_escala_puntaje_nota (
    id SERIAL PRIMARY KEY, puntaje INTEGER NOT NULL UNIQUE CHECK (puntaje >= 0),
    nota NUMERIC(4,2) NOT NULL CHECK (nota >= 1.0 AND nota <= 7.0), activo BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE evaluacion_escala_calificacion (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY, categoria TEXT NOT NULL CHECK (categoria IN ('A','B','C')),
    nota_min NUMERIC(4,2) NOT NULL, nota_max NUMERIC(4,2) NOT NULL,
    calificacion TEXT NOT NULL CHECK (calificacion IN ('SOBRESALIENTE','BIEN','BAJO LO ESPERADO','DEFICIENTE')),
    activo BOOLEAN NOT NULL DEFAULT TRUE, CONSTRAINT chk_cal_rango CHECK (nota_min < nota_max)
);
CREATE TABLE evaluacion_auditoria (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), evaluacion_id UUID REFERENCES evaluaciones(id),
    accion TEXT NOT NULL, detalle JSONB, actor_id UUID NOT NULL, actor_tipo TEXT NOT NULL, ip_address INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bonos_solicitados (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), asignacion_id UUID NOT NULL REFERENCES asignaciones(id),
    usuario_pagado_id UUID NOT NULL REFERENCES usuarios_pagados(id),
    distancia_declarada INTEGER NOT NULL, monto_solicitado INTEGER NOT NULL, monto_aprobado INTEGER,
    estado TEXT NOT NULL DEFAULT 'pendiente',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bonos_solicitados_estado_check CHECK (estado = ANY (ARRAY['pendiente','aprobado','rechazado','modificado','aprobado_auto']))
);
CREATE TABLE cartillas_jurado (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), asignacion_id UUID NOT NULL REFERENCES asignaciones(id),
    rodeo_id UUID NOT NULL REFERENCES rodeos(id), usuario_pagado_id UUID NOT NULL REFERENCES usuarios_pagados(id),
    estado TEXT NOT NULL DEFAULT 'borrador', datos JSONB NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX cartillas_jurado_asignacion_idx ON cartillas_jurado(asignacion_id);

INSERT INTO evaluacion_escala_puntaje_nota (puntaje, nota) VALUES
    (80, 7.0), (79, 6.9), (78, 6.8), (77, 6.7), (76, 6.6), (75, 6.5), (0, 1.0);
INSERT INTO evaluacion_escala_calificacion (categoria, nota_min, nota_max, calificacion) VALUES
    ('A', 1.0, 6.99, 'BIEN'), ('A', 6.99, 7.01, 'SOBRESALIENTE');
