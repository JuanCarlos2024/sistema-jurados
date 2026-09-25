-- Esquema MÍNIMO para probar importar_rodeos_historicos en un Postgres de prueba (PGlite).
-- Réplica de las columnas / defaults / constraints REALES auditadas en producción (solo las que usa la función
-- y las que el test necesita para comprobar efectos secundarios). NO es una migración.
CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;

CREATE TABLE administradores (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre_completo TEXT NOT NULL DEFAULT 'x', activo BOOLEAN NOT NULL DEFAULT true, rol_evaluacion TEXT);
CREATE TABLE temporadas (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre TEXT NOT NULL, fecha_inicio DATE NOT NULL, fecha_fin DATE NOT NULL);
CREATE TABLE asociaciones (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre TEXT NOT NULL, activa BOOLEAN NOT NULL DEFAULT true);
CREATE TABLE categorias_rodeo (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre VARCHAR NOT NULL, activo BOOLEAN NOT NULL DEFAULT true);
CREATE TABLE tipos_rodeo (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre TEXT NOT NULL, duracion_dias INTEGER NOT NULL, activo BOOLEAN NOT NULL DEFAULT true, categoria_rodeo_id UUID REFERENCES categorias_rodeo(id));
CREATE TABLE usuarios_pagados (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tipo_persona TEXT NOT NULL, nombre_completo TEXT NOT NULL, categoria TEXT, activo BOOLEAN NOT NULL DEFAULT true, estado_usuario TEXT, es_prueba BOOLEAN NOT NULL DEFAULT false);

CREATE TABLE importaciones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre_archivo TEXT NOT NULL, total_filas INTEGER NOT NULL DEFAULT 0,
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
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), club TEXT NOT NULL, asociacion TEXT NOT NULL, fecha DATE NOT NULL,
    tipo_rodeo_id UUID REFERENCES tipos_rodeo(id), tipo_rodeo_nombre TEXT, duracion_dias INTEGER NOT NULL, observacion TEXT,
    origen TEXT NOT NULL DEFAULT 'manual', estado TEXT NOT NULL DEFAULT 'activo', importacion_id UUID REFERENCES importaciones(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_by UUID REFERENCES administradores(id),
    categoria_rodeo_id UUID REFERENCES categorias_rodeo(id), categoria_rodeo_nombre VARCHAR, comuna_id UUID,
    temporada_id UUID REFERENCES temporadas(id), es_prueba BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT rodeos_duracion_dias_check CHECK (duracion_dias >= 1 AND duracion_dias <= 5),
    CONSTRAINT rodeos_estado_check CHECK (estado = ANY (ARRAY['activo','anulado'])),
    CONSTRAINT rodeos_origen_check CHECK (origen = ANY (ARRAY['importado','manual']))
);
CREATE TABLE asignaciones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), rodeo_id UUID NOT NULL REFERENCES rodeos(id), usuario_pagado_id UUID REFERENCES usuarios_pagados(id),
    tipo_persona TEXT NOT NULL, nombre_importado TEXT, categoria_aplicada TEXT, valor_diario_aplicado INTEGER NOT NULL,
    duracion_dias_aplicada INTEGER NOT NULL, pago_base_calculado INTEGER NOT NULL, estado TEXT NOT NULL DEFAULT 'activo', problema TEXT,
    observacion TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_by UUID REFERENCES administradores(id),
    estado_designacion VARCHAR DEFAULT 'pendiente', distancia_km INTEGER, aceptado_en TIMESTAMPTZ, observacion_designacion TEXT, comentario_admin TEXT,
    publicado BOOLEAN NOT NULL DEFAULT false, publicado_en TIMESTAMPTZ, publicado_por UUID, propuesta_detalle_id UUID,
    CONSTRAINT asignaciones_categoria_aplicada_check CHECK (categoria_aplicada = ANY (ARRAY['A','B','C','DR'])),
    CONSTRAINT asignaciones_estado_check CHECK (estado = ANY (ARRAY['activo','pendiente_revision','anulado'])),
    CONSTRAINT asignaciones_tipo_persona_check CHECK (tipo_persona = ANY (ARRAY['jurado','delegado_rentado']))
);
CREATE TABLE notas_rodeo (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), asignacion_id UUID NOT NULL UNIQUE REFERENCES asignaciones(id), nota NUMERIC NOT NULL,
    comentario TEXT, evaluado_en TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT, fuente TEXT NOT NULL DEFAULT 'manual',
    puntaje_evaluacion INTEGER, calificacion_cualitativa TEXT, evaluacion_id UUID,
    CONSTRAINT notas_rodeo_fuente_check CHECK (fuente = ANY (ARRAY['manual','evaluacion_tecnica'])),
    CONSTRAINT notas_rodeo_nota_check CHECK (nota >= 1.0 AND nota <= 7.0)
);
CREATE TABLE rodeo_notas_secundarias (
    id BIGSERIAL PRIMARY KEY, rodeo_id UUID NOT NULL UNIQUE REFERENCES rodeos(id) ON DELETE CASCADE, nota_comision NUMERIC, nota_delegado NUMERIC,
    actualizado_por TEXT, actualizado_en TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT rns_nota_comision_rango CHECK (nota_comision IS NULL OR (nota_comision >= 1.0 AND nota_comision <= 7.0)),
    CONSTRAINT rns_nota_delegado_rango CHECK (nota_delegado IS NULL OR (nota_delegado >= 1.0 AND nota_delegado <= 7.0))
);
CREATE TABLE evaluaciones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), rodeo_id UUID NOT NULL UNIQUE REFERENCES rodeos(id), creado_por UUID NOT NULL REFERENCES administradores(id),
    analista_id UUID REFERENCES administradores(id), estado TEXT NOT NULL DEFAULT 'borrador', puntaje_base INTEGER NOT NULL DEFAULT 80, puntaje_final INTEGER, nota_final NUMERIC,
    modo_flujo TEXT NOT NULL DEFAULT 'descuento_automatico', nota_publicada BOOLEAN NOT NULL DEFAULT false, resultados_alterados BOOLEAN NOT NULL DEFAULT false,
    anulada BOOLEAN DEFAULT false, casos_whatsapp INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT evaluaciones_estado_check CHECK (estado = ANY (ARRAY['borrador','en_proceso','pendiente_comision','pendiente_aprobacion','devuelto','aprobado','publicado','cerrado'])),
    CONSTRAINT chk_evaluaciones_casos_whatsapp CHECK (casos_whatsapp >= 0)
);
-- Tablas que la función NO debe tocar (el test comprueba que siguen vacías)
CREATE TABLE evaluacion_ciclos (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), evaluacion_id UUID NOT NULL REFERENCES evaluaciones(id), numero_ciclo INTEGER NOT NULL, estado TEXT NOT NULL DEFAULT 'pendiente_carga', min_casos INTEGER, max_casos INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT evaluacion_ciclos_numero_ciclo_check CHECK (numero_ciclo = ANY (ARRAY[1, 2])), CONSTRAINT evaluacion_ciclos_evaluacion_id_numero_ciclo_key UNIQUE (evaluacion_id, numero_ciclo));
CREATE TABLE evaluacion_casos (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), evaluacion_id UUID REFERENCES evaluaciones(id));
CREATE TABLE evaluacion_auditoria (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), evaluacion_id UUID REFERENCES evaluaciones(id), accion TEXT NOT NULL, detalle JSONB, actor_id UUID NOT NULL, actor_tipo TEXT NOT NULL, actor_nombre TEXT, ip_address INET, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT evaluacion_auditoria_actor_tipo_check CHECK (actor_tipo = ANY (ARRAY['administrador','usuario_pagado'])));
CREATE TABLE bonos (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE control_gestion_situaciones (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
