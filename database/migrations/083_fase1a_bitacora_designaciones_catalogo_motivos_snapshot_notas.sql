-- ═════════════════════════════════════════════════════════════════════════
-- 083_fase1a_bitacora_designaciones_catalogo_motivos_snapshot_notas.sql
-- Fase 1A — Infraestructura de trazabilidad de designaciones.
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — preparada y probada localmente (PGlite) por
-- autorización explícita y acotada a "implementación local de Fase 1A".
-- NO ejecutar sobre Supabase sin una autorización separada.
--
-- Antecedentes: Diseño Motor de Designaciones, Ajustes al Diseño, Cierre del
-- Diseño — Fase 0, Cierre de Fase 0 y Plan de Fase 1 (los cuatro documentos
-- de diseño previos de esta serie).
--
-- ALCANCE DE ESTA MIGRACIÓN (Fase 1A — solo infraestructura, nada operativo):
--   A. catalogo_motivos_designacion — catálogo de motivos, con los 10
--      motivos iniciales aprobados.
--   B. bitacora_designaciones — bitácora append-only con ANCLA DUAL
--      (propuesta_detalle_id y asignacion_id, ambas NULLABLE, con un CHECK
--      que exige al menos una de las dos) en vez de asignacion_id NOT NULL
--      como única referencia — corrección obligatoria explícita del pedido:
--      la bitácora debe poder registrar movimientos sobre una propuesta que
--      todavía no se aplicó (sin asignación real todavía), sobre una
--      asignación existente (sin propuesta de origen, p. ej. una designación
--      manual histórica), o sobre ambas (el momento en que una propuesta SE
--      APLICA y pasa a ser una asignación real).
--   C. registrar_movimiento_designacion(...) — única vía de escritura hacia
--      la bitácora. Nunca se expone un INSERT directo a ningún rol salvo
--      service_role, y aun así: ver Decisión 2 (append-only real).
--   D. ALTER TABLE notas_rodeo — snapshot de identidad, aditivo.
--   E. CREATE OR REPLACE FUNCTION publicar_evaluacion — ver Decisión 4.
--
-- Esta migración NO conecta nada de lo anterior con el endpoint
-- PATCH /api/admin/asignaciones/:id ni con ningún flujo operativo existente.
-- Ninguna fila de asignaciones, notas_rodeo, evaluaciones ni bonos_solicitados
-- se modifica. No se activa ningún procedimiento nuevo de reemplazo. Eso
-- queda, íntegramente, para una Fase 1B separada y con autorización propia.
--
-- ───────────────────────────────────────────────────────────────────────
-- DECISIÓN 1 — Ancla dual real, no un FK único disfrazado. El CHECK
-- (propuesta_detalle_id IS NOT NULL OR asignacion_id IS NOT NULL) es la
-- garantía de integridad a nivel de base de datos; registrar_movimiento_
-- designacion repite la misma validación a nivel de aplicación (defensa en
-- profundidad, mismo criterio ya usado en el resto del proyecto para reglas
-- de negocio que también existen como CHECK). rodeo_id es siempre NOT NULL
-- porque todo movimiento, con o sin asignación real todavía, ocurre sobre un
-- rodeo concreto — permite consultar la bitácora completa de un rodeo sin
-- depender de qué ancla esté presente en cada fila.
--
-- DECISIÓN 2 — Append-only real, no solo documentado. bitacora_designaciones
-- nunca recibe GRANT de UPDATE ni de DELETE para NINGÚN rol, ni siquiera
-- service_role (que es el único rol que el backend usa). Esto es distinto
-- del patrón de "RLS + REVOKE de anon/authenticated + GRANT ALL a
-- service_role" ya usado en 071/079/081: ahí se revocaba el acceso de roles
-- no autorizados pero se otorgaba ALL a service_role. Acá, incluso
-- service_role solo recibe SELECT e INSERT — ninguna conexión autenticada
-- como ese rol puede modificar ni borrar una fila ya escrita, ni por error
-- de código ni por una llamada manual. Si en una fase futura se necesitara
-- corregir un dato mal registrado, la vía correcta es una fila NUEVA que
-- referencie a la anterior (p. ej. vía operacion_id o un tipo_movimiento de
-- rectificación) — nunca un UPDATE sobre el historial.
--
-- DECISIÓN 3 — tipo_movimiento distingue explícitamente 10 naturalezas de
-- cambio distintas (CHECK de enumeración cerrada). No se asume que un cambio
-- manual de jurado sobre un borrador y una aceptación de propuesta sean la
-- misma operación — tienen semántica y consecuencias distintas aunque ambas
-- toquen la misma propuesta_detalle_id.
--
-- DECISIÓN 4 — publicar_evaluacion(): RESUELTA. La definición real de
-- producción (jurados_2026) fue exportada vía `pg_get_functiondef` de solo
-- lectura y comparada aquí, en Postgres real (PGlite), contra el texto de
-- 031_anular_caso.sql — resultado: CARÁCTER POR CARÁCTER IDÉNTICA una vez
-- normalizada (la diferencia inicial de longitud/MD5 reportada era por
-- saltos de línea CRLF presentes en el export de producción, confirmado por
-- el usuario y reproducido de forma independiente aquí). No existe ninguna
-- diferencia funcional entre producción y la 031 del repositorio. El CREATE
-- OR REPLACE de esta pieza toma esa base verificada y solo agrega las 2
-- columnas de snapshot al SELECT/INSERT/UPSERT del paso 6 — confirmado por
-- diff línea por línea que ninguna otra línea cambia (ver
-- bitacoraDesignaciones.rpc.test.js, describe "publicar_evaluacion —
-- equivalencia con producción..."). Las piezas A-D de esta migración
-- (tablas nuevas + ALTER TABLE aditivo) nunca tuvieron este riesgo: no
-- reemplazan nada que ya exista.
--
-- Migración envuelta en una transacción explícita.
-- Idempotente: CREATE TABLE/INDEX usan IF NOT EXISTS; ALTER TABLE usa
-- ADD COLUMN IF NOT EXISTS; CREATE OR REPLACE FUNCTION es seguro de repetir.
-- Reversible: ver bloque al final.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- A) Catálogo de motivos
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS catalogo_motivos_designacion (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo    TEXT NOT NULL UNIQUE,
    etiqueta  TEXT NOT NULL,
    activo    BOOLEAN NOT NULL DEFAULT true,
    orden     INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT chk_catalogo_motivos_codigo CHECK (btrim(codigo) <> ''),
    CONSTRAINT chk_catalogo_motivos_etiqueta CHECK (btrim(etiqueta) <> '')
);

INSERT INTO catalogo_motivos_designacion (codigo, etiqueta, orden) VALUES
    ('jurado_no_disponible',            'Indisponibilidad del jurado',               10),
    ('rechazo_designacion',             'Rechazo de designación',                    20),
    ('criterio_tecnico_area_deportiva', 'Criterio técnico del Área Deportiva',        30),
    ('ajuste_categoria',                'Ajuste de categoría',                        40),
    ('problema_traslado',               'Problema de traslado',                       50),
    ('solicitud_jurado',                'Solicitud del jurado',                       60),
    ('emergencia_fuerza_mayor',         'Emergencia o fuerza mayor',                  70),
    ('correccion_administrativa',       'Corrección administrativa',                  80),
    ('enroque',                         'Enroque',                                     90),
    ('otro',                            'Otro',                                       100)
ON CONFLICT (codigo) DO NOTHING;

COMMENT ON TABLE catalogo_motivos_designacion IS
    'Fase 1A: catálogo de motivos para movimientos de designación. Las reglas de obligatoriedad (motivo+comentario obligatorios antes de aplicar propuesta; solo motivo obligatorio después) se aplican en los endpoints de Fase 1B — esta tabla solo es el catálogo, no valida nada todavía.';

-- ─────────────────────────────────────────────────────────────────────────
-- B) Bitácora estructural — ancla dual, append-only
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bitacora_designaciones (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Ancla dual (Decisión 1): al menos una debe estar presente.
    propuesta_detalle_id        UUID REFERENCES propuestas_designacion_detalle(id),
    asignacion_id               UUID REFERENCES asignaciones(id),
    rodeo_id                    UUID NOT NULL REFERENCES rodeos(id),

    -- Identidad congelada antes/después del movimiento (mismo criterio ya
    -- probado en comision_evaluaciones_jurado.usuario_pagado_id_evaluado_
    -- snapshot, migración 079): nunca se recalculan a partir del estado
    -- actual de la asignación.
    usuario_pagado_id_anterior  UUID REFERENCES usuarios_pagados(id),
    nombre_anterior_snapshot    TEXT,
    usuario_pagado_id_nuevo     UUID REFERENCES usuarios_pagados(id),
    nombre_nuevo_snapshot       TEXT,

    tipo_movimiento             TEXT NOT NULL CHECK (tipo_movimiento IN (
        'propuesta_automatica',
        'modificacion_manual_borrador',
        'aplicacion_propuesta',
        'aceptacion',
        'rechazo',
        'reemplazo',
        'cambio_emergencia',
        'regularizacion_posterior',
        'enroque',
        'rectificacion_administrativa'
    )),

    motivo_catalogo_id          UUID REFERENCES catalogo_motivos_designacion(id),
    motivo_detalle              TEXT,

    actor_id                    UUID NOT NULL REFERENCES administradores(id),
    actor_tipo                  TEXT NOT NULL CHECK (actor_tipo = 'administrador'),

    -- Fecha en que el movimiento rige operativamente (puede ser anterior a
    -- created_at, p. ej. una regularización posterior que documenta un
    -- cambio que en los hechos ya ocurrió antes).
    fecha_efectiva               TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Agrupa movimientos de una misma operación administrativa (p. ej. un
    -- enroque son 2 filas con el mismo operacion_id). Libre, sin FK propia:
    -- el emisor decide el valor (típicamente un UUID nuevo por operación).
    operacion_id                 UUID,

    CONSTRAINT chk_bitacora_referencia_valida CHECK (
        propuesta_detalle_id IS NOT NULL OR asignacion_id IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_bitacora_designaciones_propuesta  ON bitacora_designaciones(propuesta_detalle_id);
CREATE INDEX IF NOT EXISTS idx_bitacora_designaciones_asignacion ON bitacora_designaciones(asignacion_id);
CREATE INDEX IF NOT EXISTS idx_bitacora_designaciones_rodeo      ON bitacora_designaciones(rodeo_id);
CREATE INDEX IF NOT EXISTS idx_bitacora_designaciones_operacion  ON bitacora_designaciones(operacion_id);

COMMENT ON TABLE bitacora_designaciones IS
    'Fase 1A: historial append-only de movimientos de designación, desde la propuesta automática hasta cambios administrativos posteriores. Ancla dual (propuesta_detalle_id / asignacion_id, al menos una presente) — nunca asignacion_id NOT NULL como única referencia. Nunca se modifica ni se borra una fila existente (ver GRANT más abajo): una corrección se registra como una fila nueva.';

-- ─────────────────────────────────────────────────────────────────────────
-- Endurecimiento desde la creación (mismo criterio que 071/079/081) + la
-- restricción append-only real de la Decisión 2: ni siquiera service_role
-- recibe UPDATE/DELETE sobre bitacora_designaciones.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE catalogo_motivos_designacion ENABLE ROW LEVEL SECURITY;
ALTER TABLE bitacora_designaciones ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE catalogo_motivos_designacion FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE bitacora_designaciones FROM PUBLIC, anon, authenticated;

-- catalogo_motivos_designacion: tabla de configuración administrable
-- (activo/orden), por eso service_role recibe SELECT/INSERT/UPDATE — nunca
-- DELETE (un motivo ya usado por una fila de bitácora no debe poder
-- desaparecer; se desactiva con activo=false, igual que el patrón ya usado
-- para evaluadores_comision en la migración 079).
GRANT SELECT, INSERT, UPDATE ON TABLE catalogo_motivos_designacion TO service_role;

-- bitacora_designaciones: SOLO SELECT e INSERT. Sin UPDATE, sin DELETE,
-- para NINGÚN rol — append-only real (Decisión 2), no solo una convención
-- de código.
GRANT SELECT, INSERT ON TABLE bitacora_designaciones TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- C) Única vía de escritura hacia la bitácora
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION registrar_movimiento_designacion(
    p_tipo_movimiento             TEXT,
    p_rodeo_id                    UUID,
    p_actor_id                    UUID,
    p_propuesta_detalle_id        UUID DEFAULT NULL,
    p_asignacion_id               UUID DEFAULT NULL,
    p_usuario_pagado_id_anterior  UUID DEFAULT NULL,
    p_nombre_anterior_snapshot    TEXT DEFAULT NULL,
    p_usuario_pagado_id_nuevo     UUID DEFAULT NULL,
    p_nombre_nuevo_snapshot       TEXT DEFAULT NULL,
    p_motivo_catalogo_id          UUID DEFAULT NULL,
    p_motivo_detalle              TEXT DEFAULT NULL,
    p_actor_tipo                  TEXT DEFAULT 'administrador',
    p_fecha_efectiva              TIMESTAMPTZ DEFAULT NULL,
    p_operacion_id                UUID DEFAULT NULL
) RETURNS bitacora_designaciones
LANGUAGE plpgsql
-- SECURITY INVOKER (el valor por defecto de Postgres, no se declara
-- SECURITY DEFINER): el único rol que recibe EXECUTE es service_role (ver
-- GRANT más abajo), y ese mismo rol YA tiene GRANT directo de SELECT/INSERT
-- sobre bitacora_designaciones — SECURITY DEFINER no otorgaría ninguna
-- capacidad adicional aquí, solo ampliaría la superficie de ataque sin
-- necesidad (si esta función alguna vez ejecutara un UPDATE/DELETE por
-- error, DEFINER podría ejecutarlo con los privilegios del propietario en
-- vez de los de quien llama, socavando el append-only real de la Decisión
-- 2). Mismo criterio que 071_seguridad_tablas_rpc_institucionales.sql
-- documentó para sus 4 RPC: "ninguna usa SECURITY DEFINER... search_path
-- explícito como buena práctica adicional" — se mantiene SET search_path
-- igual, por la misma razón documentada ahí (defensa en profundidad incluso
-- sin DEFINER).
SET search_path = public
AS $$
DECLARE
    v_resultado bitacora_designaciones;
    v_rodeo_real_propuesta UUID;
    v_rodeo_real_asignacion UUID;
BEGIN
    IF p_propuesta_detalle_id IS NULL AND p_asignacion_id IS NULL THEN
        RAISE EXCEPTION 'REFERENCIA_REQUERIDA: debe indicarse propuesta_detalle_id o asignacion_id (o ambas)';
    END IF;
    IF p_actor_id IS NULL THEN
        RAISE EXCEPTION 'ACTOR_REQUERIDO';
    END IF;

    -- Hallazgo de seguridad/integridad (verificación final de Fase 1A): sin
    -- esta comprobación, nada impedía registrar un movimiento cuyo rodeo_id
    -- declarado no coincidiera con el rodeo real de la propuesta o la
    -- asignación referenciadas — el FK por sí solo valida que el id exista,
    -- nunca que sea coherente con el rodeo informado. Se verifica contra
    -- AMBAS referencias cuando están presentes (p. ej. aplicacion_propuesta).
    IF p_propuesta_detalle_id IS NOT NULL THEN
        SELECT rodeo_id INTO v_rodeo_real_propuesta
        FROM propuestas_designacion_detalle WHERE id = p_propuesta_detalle_id;
        IF v_rodeo_real_propuesta IS DISTINCT FROM p_rodeo_id THEN
            RAISE EXCEPTION 'RODEO_INCONSISTENTE_CON_PROPUESTA: la propuesta % pertenece al rodeo %, no a %',
                p_propuesta_detalle_id, v_rodeo_real_propuesta, p_rodeo_id;
        END IF;
    END IF;
    IF p_asignacion_id IS NOT NULL THEN
        SELECT rodeo_id INTO v_rodeo_real_asignacion
        FROM asignaciones WHERE id = p_asignacion_id;
        IF v_rodeo_real_asignacion IS DISTINCT FROM p_rodeo_id THEN
            RAISE EXCEPTION 'RODEO_INCONSISTENTE_CON_ASIGNACION: la asignación % pertenece al rodeo %, no a %',
                p_asignacion_id, v_rodeo_real_asignacion, p_rodeo_id;
        END IF;
    END IF;

    INSERT INTO bitacora_designaciones (
        propuesta_detalle_id, asignacion_id, rodeo_id,
        usuario_pagado_id_anterior, nombre_anterior_snapshot,
        usuario_pagado_id_nuevo, nombre_nuevo_snapshot,
        tipo_movimiento, motivo_catalogo_id, motivo_detalle,
        actor_id, actor_tipo, fecha_efectiva, operacion_id
    ) VALUES (
        p_propuesta_detalle_id, p_asignacion_id, p_rodeo_id,
        p_usuario_pagado_id_anterior, p_nombre_anterior_snapshot,
        p_usuario_pagado_id_nuevo, p_nombre_nuevo_snapshot,
        p_tipo_movimiento, p_motivo_catalogo_id, p_motivo_detalle,
        p_actor_id, p_actor_tipo, COALESCE(p_fecha_efectiva, now()), p_operacion_id
    )
    RETURNING * INTO v_resultado;

    RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION registrar_movimiento_designacion(
    TEXT, UUID, UUID, UUID, UUID, UUID, TEXT, UUID, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, UUID
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registrar_movimiento_designacion(
    TEXT, UUID, UUID, UUID, UUID, UUID, TEXT, UUID, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, UUID
) TO service_role;

COMMENT ON FUNCTION registrar_movimiento_designacion IS
    'Fase 1A: única vía autorizada para escribir en bitacora_designaciones. Exige al menos una de propuesta_detalle_id/asignacion_id (defensa en profundidad junto al CHECK de la tabla) y un actor_id. No wired a ningún endpoint todavía — esa integración es Fase 1B.';

-- ─────────────────────────────────────────────────────────────────────────
-- D) Snapshot de identidad en notas_rodeo — aditivo, sin backfill
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE notas_rodeo
    ADD COLUMN IF NOT EXISTS usuario_pagado_id_evaluado_snapshot UUID REFERENCES usuarios_pagados(id),
    ADD COLUMN IF NOT EXISTS nombre_evaluado_snapshot TEXT;

COMMENT ON COLUMN notas_rodeo.usuario_pagado_id_evaluado_snapshot IS
    'Fase 1A: identidad congelada del jurado evaluado al momento de publicar_evaluacion(). NULL para toda fila creada antes de esta migración (nunca se rellena retroactivamente a partir de asignaciones.usuario_pagado_id actual) y también NULL si la asignación evaluada nunca tuvo usuario_pagado_id (solo nombre_importado).';

-- ─────────────────────────────────────────────────────────────────────────
-- E) publicar_evaluacion() — agrega el snapshot al UPSERT existente.
--    Ver Decisión 4 (resuelta): base = texto real de producción, verificado
--    idéntico a 031_anular_caso.sql. Mismo comportamiento en todo lo demás —
--    ningún otro paso cambia.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION publicar_evaluacion(
    p_evaluacion_id UUID,
    p_jefe_id       UUID,
    p_comentario    TEXT  DEFAULT NULL,
    p_ip            TEXT  DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_eval              evaluaciones%ROWTYPE;
    v_puntaje_base      INTEGER;
    v_descuentos        INTEGER;
    v_puntaje_final     INTEGER;
    v_nota_final        NUMERIC(4,2);
    v_asig              RECORD;
    v_nota_existente    notas_rodeo%ROWTYPE;
    v_calificacion      TEXT;
    v_sobreescrituras   JSONB    := '[]'::JSONB;
    v_jurados_count     INTEGER  := 0;
    v_ip_inet           INET;
BEGIN
    BEGIN
        v_ip_inet := NULLIF(TRIM(p_ip), '')::INET;
    EXCEPTION WHEN OTHERS THEN
        v_ip_inet := NULL;
    END;

    -- 1. Leer y validar evaluación
    SELECT * INTO v_eval
    FROM evaluaciones
    WHERE id = p_evaluacion_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'evaluacion_no_encontrada: %', p_evaluacion_id;
    END IF;

    IF v_eval.estado <> 'pendiente_aprobacion' THEN
        RAISE EXCEPTION 'estado_invalido: se requiere pendiente_aprobacion, estado actual: %', v_eval.estado;
    END IF;

    -- 2. Verificar casos sin resolver (excluye anulados)
    IF EXISTS (
        SELECT 1 FROM evaluacion_casos
        WHERE evaluacion_id = p_evaluacion_id
          AND estado <> 'resuelto'
          AND (anulado IS FALSE OR anulado IS NULL)
    ) THEN
        RAISE EXCEPTION 'casos_pendientes: existen casos aún no resueltos, no se puede publicar';
    END IF;

    -- 3. Calcular puntaje final (excluye anulados)
    v_puntaje_base := v_eval.puntaje_base;

    SELECT COALESCE(SUM(descuento_puntos), 0) INTO v_descuentos
    FROM evaluacion_casos
    WHERE evaluacion_id = p_evaluacion_id
      AND (anulado IS FALSE OR anulado IS NULL)
      AND resolucion_final IN (
          'interpretativa_confirmada',
          'reglamentaria_confirmada',
          'apelacion_rechazada'
      );

    v_puntaje_final := GREATEST(0, LEAST(v_puntaje_base, v_puntaje_base - v_descuentos));

    -- 4. Convertir puntaje → nota (desde tabla configurable)
    SELECT nota INTO v_nota_final
    FROM evaluacion_escala_puntaje_nota
    WHERE puntaje = v_puntaje_final AND activo = TRUE
    LIMIT 1;

    IF v_nota_final IS NULL THEN
        v_nota_final := 1.0;
    END IF;

    -- 5. Marcar evaluación como aprobada
    UPDATE evaluaciones SET
        estado              = 'aprobado',
        puntaje_final       = v_puntaje_final,
        nota_final          = v_nota_final,
        decision_jefe       = 'aprobado',
        comentario_jefe     = p_comentario,
        fecha_decision_jefe = NOW(),
        jefe_id             = p_jefe_id,
        updated_at          = NOW()
    WHERE id = p_evaluacion_id;

    -- 6. UPSERT en notas_rodeo por cada jurado del rodeo
    FOR v_asig IN
        SELECT
            a.id                 AS asignacion_id,
            up.categoria         AS categoria,
            a.usuario_pagado_id  AS usuario_pagado_id,
            COALESCE(up.nombre_completo, a.nombre_importado) AS nombre_evaluado
        FROM asignaciones a
        JOIN usuarios_pagados up ON up.id = a.usuario_pagado_id
        WHERE a.rodeo_id              = v_eval.rodeo_id
          AND a.estado                = 'activo'
          AND a.estado_designacion IS DISTINCT FROM 'rechazado'
          AND up.tipo_persona         = 'jurado'
    LOOP
        IF v_asig.categoria IS NULL THEN
            v_calificacion := NULL;
        ELSE
            SELECT calificacion INTO v_calificacion
            FROM evaluacion_escala_calificacion
            WHERE categoria    = v_asig.categoria
              AND activo       = TRUE
              AND v_nota_final >= nota_min
              AND v_nota_final <= nota_max
            LIMIT 1;
        END IF;

        SELECT * INTO v_nota_existente
        FROM notas_rodeo
        WHERE asignacion_id = v_asig.asignacion_id;

        IF FOUND AND v_nota_existente.fuente = 'manual' THEN
            v_sobreescrituras := v_sobreescrituras || jsonb_build_object(
                'asignacion_id',        v_asig.asignacion_id,
                'nota_manual_anterior', v_nota_existente.nota,
                'comentario_anterior',  v_nota_existente.comentario
            );
            INSERT INTO evaluacion_auditoria (
                evaluacion_id, accion, detalle, actor_id, actor_tipo, ip_address
            ) VALUES (
                p_evaluacion_id,
                'sobreescritura_nota_manual',
                jsonb_build_object(
                    'asignacion_id',        v_asig.asignacion_id,
                    'nota_manual_anterior', v_nota_existente.nota,
                    'comentario_anterior',  v_nota_existente.comentario,
                    'nota_tecnica_nueva',   v_nota_final,
                    'puntaje_final',        v_puntaje_final
                ),
                p_jefe_id, 'administrador', v_ip_inet
            );
        END IF;

        INSERT INTO notas_rodeo (
            asignacion_id, nota, comentario, evaluado_en, updated_at, updated_by,
            fuente, puntaje_evaluacion, calificacion_cualitativa, evaluacion_id,
            usuario_pagado_id_evaluado_snapshot, nombre_evaluado_snapshot
        ) VALUES (
            v_asig.asignacion_id, v_nota_final, NULL,
            NOW(), NOW(), p_jefe_id::TEXT,
            'evaluacion_tecnica', v_puntaje_final, v_calificacion, p_evaluacion_id,
            v_asig.usuario_pagado_id, v_asig.nombre_evaluado
        )
        ON CONFLICT (asignacion_id) DO UPDATE SET
            nota                     = EXCLUDED.nota,
            evaluado_en              = EXCLUDED.evaluado_en,
            updated_at               = EXCLUDED.updated_at,
            updated_by               = EXCLUDED.updated_by,
            fuente                   = EXCLUDED.fuente,
            puntaje_evaluacion       = EXCLUDED.puntaje_evaluacion,
            calificacion_cualitativa = EXCLUDED.calificacion_cualitativa,
            evaluacion_id            = EXCLUDED.evaluacion_id,
            usuario_pagado_id_evaluado_snapshot = EXCLUDED.usuario_pagado_id_evaluado_snapshot,
            nombre_evaluado_snapshot            = EXCLUDED.nombre_evaluado_snapshot;

        v_jurados_count := v_jurados_count + 1;
    END LOOP;

    -- 7. Validar que haya al menos un jurado
    IF v_jurados_count = 0 THEN
        RAISE EXCEPTION 'sin_jurados: no se encontró ningún jurado activo para este rodeo, no se puede publicar';
    END IF;

    -- 8. Marcar como publicado
    UPDATE evaluaciones SET
        estado         = 'publicado',
        nota_publicada = TRUE,
        updated_at     = NOW()
    WHERE id = p_evaluacion_id;

    -- 9. Auditoría
    INSERT INTO evaluacion_auditoria (
        evaluacion_id, accion, detalle, actor_id, actor_tipo, ip_address
    ) VALUES (
        p_evaluacion_id,
        'publicar_nota',
        jsonb_build_object(
            'puntaje_final',               v_puntaje_final,
            'nota_final',                  v_nota_final,
            'jurados_afectados',           v_jurados_count,
            'sobreescrituras_nota_manual', v_sobreescrituras
        ),
        p_jefe_id, 'administrador', v_ip_inet
    );

    RETURN jsonb_build_object(
        'ok',                          TRUE,
        'puntaje_final',               v_puntaje_final,
        'nota_final',                  v_nota_final,
        'jurados_afectados',           v_jurados_count,
        'sobreescrituras_nota_manual', v_sobreescrituras
    );

EXCEPTION WHEN OTHERS THEN
    RAISE;
END;
$$;

COMMIT;

-- Reversible:
--   DROP FUNCTION IF EXISTS registrar_movimiento_designacion(TEXT, UUID, UUID, UUID, UUID, UUID, TEXT, UUID, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, UUID);
--   DROP TABLE IF EXISTS bitacora_designaciones;
--   DROP TABLE IF EXISTS catalogo_motivos_designacion;
--   ALTER TABLE notas_rodeo DROP COLUMN IF EXISTS usuario_pagado_id_evaluado_snapshot, DROP COLUMN IF EXISTS nombre_evaluado_snapshot;
--   -- publicar_evaluacion vuelve a su versión de la 031 re-aplicando ese archivo.
