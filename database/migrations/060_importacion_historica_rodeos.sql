-- ═════════════════════════════════════════════════════════════════════════
-- 060_importacion_historica_rodeos.sql
-- IMPORTACIÓN DE RODEOS HISTÓRICOS — función transaccional de escritura.
--
-- Autorizada expresamente por el administrador para producción (2026-09-25). Aplicar con el mecanismo normal de migraciones.
--
-- ⚠ ORDEN DE DESPLIEGUE: aplicar ESTA migración ANTES de desplegar el código nuevo (el código filtra por
--   evaluaciones.es_historica_importacion y usa las funciones de abajo).
--
-- Qué contiene (y solo esto):
--   1. evaluaciones.es_historica_importacion BOOLEAN NOT NULL DEFAULT false (+ CHECK: una histórica solo puede
--      estar 'cerrado'). Marca las evaluaciones mínimas creadas SOLO para guardar Casos por WhatsApp. Todas las
--      filas existentes quedan en false (ADD COLUMN con DEFAULT constante = solo metadatos, sin reescribir la tabla).
--   2. asignaciones.importacion_id UUID NULL → importaciones(id). Trazabilidad de las asignaciones creadas por una
--      importación (necesaria porque, en rodeos ya existentes, la cadena asignación→rodeo→importación NO alcanza).
--      Es la fuente de verdad para proteger las asignaciones históricas (pago 0) en recalcular / PATCH / km.
--   3. importar_rodeos_historicos(...)  — SECURITY DEFINER, ejecutable solo por service_role.
--   4. convertir_evaluacion_historica(...) — SECURITY DEFINER, solo service_role: convierte ATÓMICAMENTE una
--      evaluación histórica en una evaluación normal (estado inicial normal + ciclos + auditoría).
--
-- Qué NO contiene (auditado, no hace falta):
--   · NO amplía importaciones.tipo: el CHECK chk_importaciones_tipo YA acepta 'historico_rodeos'.
--   · NO crea tablas, estados ni triggers.
--   · NO crea índices UNIQUE: producción tiene un par (rodeo, jurado) con asignación duplicada,
--     así que un UNIQUE parcial sobre asignaciones fallaría; y rodeos no tiene clave natural única
--     (club es texto libre). La idempotencia y la concurrencia se resuelven DENTRO de la función
--     con pg_advisory_xact_lock + volver a consultar.
--
-- Atomicidad: todo ocurre en la transacción de la llamada RPC. Cualquier error inesperado
-- (RAISE EXCEPTION, violación de CHECK/FK, etc.) revierte TODO: rodeos, asignaciones, notas,
-- evaluaciones, la fila de importaciones y la de auditoría.
--
-- Reglas de negocio (definitivas):
--   · Rodeo: llave lógica fecha + club normalizado + asociación + tipo. 0 → crea; 1 → reutiliza;
--     >1 → NO elige (rodeo ambiguo, se omite y se informa).
--   · Asignación histórica: estado 'activo', estado_designacion 'aceptado', publicado false,
--     categoria_aplicada = categoría ACTUAL del jurado, valor_diario_aplicado 0, pago_base_calculado 0
--     (los rodeos históricos ya se pagaron fuera del sistema: NO generan pagos).
--     Si ya existe una asignación no anulada (rodeo, jurado) se reutiliza y NO se modifica.
--   · Nota Delegado / Nota Comisión → rodeo_notas_secundarias (por rodeo): NULL se completa,
--     igual = sin cambios, distinta = CONFLICTO (no se sobrescribe).
--   · Nota Deportiva → notas_rodeo.nota por asignación (fuente 'manual'); igual/distinta igual que arriba.
--     NO toca evaluaciones.nota_final ni llama publicar_evaluacion ni crea ciclos.
--   · Casos por WhatsApp → evaluaciones.casos_whatsapp (por rodeo):
--       - Excel 0 y sin evaluación → no se crea nada.
--       - Excel > 0 y sin evaluación → evaluación histórica MÍNIMA: solo rodeo_id, creado_por,
--         estado 'cerrado' (estado existente, terminal), es_historica_importacion = true, casos_whatsapp;
--         el resto por defecto. NO crea evaluacion_ciclos ni evaluacion_casos ni evaluacion_auditoria;
--         no hay triggers. Se controla con p_crear_evaluaciones (false = no se crea y se informa).
--       - Evaluación existente (histórica O normal): igual = sin cambios; distinta (incluido 0) = CONFLICTO,
--         no se sobrescribe.
--   · Cuando después alguien crea una evaluación NORMAL para ese rodeo, convertir_evaluacion_historica reutiliza
--     la MISMA fila (evaluaciones.rodeo_id es UNIQUE): conserva casos_whatsapp, pone es_historica_importacion=false,
--     estado 'borrador' (el inicial de una evaluación nueva), crea los ciclos y la auditoría, todo en una transacción.
--   · Los conflictos NO abortan: se informan y se conserva el dato existente.
--
-- Concurrencia: los grupos se procesan ordenados por clave (orden determinista → sin deadlocks entre
-- importaciones simultáneas) y cada grupo toma pg_advisory_xact_lock(clave del rodeo) ANTES de buscar
-- o crear. Dos importaciones simultáneas del mismo rodeo se serializan: la segunda encuentra el rodeo
-- creado por la primera. Como todas las escrituras de un rodeo ocurren bajo ese lock, no hace falta un
-- lock adicional por asignación.
--
-- Seguridad: SECURITY DEFINER + search_path fijo (public, pg_temp) como confirmar_control_gestion_rodeo;
-- REVOKE a PUBLIC/anon/authenticated y GRANT solo a service_role. Valida que p_admin_id sea un
-- administrador activo SIN rol de evaluación (administrador pleno). No usa SQL dinámico. Los datos
-- estructurales (tipo, duración, asociación, categoría, jurado y su categoría) se releen de las tablas
-- maestras: no se confía en lo que envíe el llamador.
-- ═════════════════════════════════════════════════════════════════════════

-- ── 1) Marcador de evaluación histórica ──────────────────────────────────
ALTER TABLE public.evaluaciones
    ADD COLUMN IF NOT EXISTS es_historica_importacion BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_evaluaciones_historica_cerrada'
                                                  AND conrelid = 'public.evaluaciones'::regclass) THEN
        ALTER TABLE public.evaluaciones
            ADD CONSTRAINT chk_evaluaciones_historica_cerrada
            CHECK (NOT es_historica_importacion OR estado = 'cerrado');
    END IF;
END $$;

-- ── 2) Trazabilidad de asignaciones creadas por una importación ─────────────
ALTER TABLE public.asignaciones
    ADD COLUMN IF NOT EXISTS importacion_id UUID REFERENCES public.importaciones(id);

CREATE OR REPLACE FUNCTION importar_rodeos_historicos(
    p_admin_id          UUID,
    p_temporada_id      UUID,
    p_fecha_desde       DATE,
    p_fecha_hasta       DATE,
    p_nombre_archivo    TEXT,
    p_sha256            TEXT,
    p_total_filas       INTEGER,
    p_grupos            JSONB,
    p_filas_omitidas    INTEGER,
    p_filas_con_error   INTEGER,
    p_crear_evaluaciones BOOLEAN,
    p_ip                TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
-- Timeout SOLO de esta función (no toca el global). service_role hereda los 8 s de authenticator; Supabase documenta que un SET
-- statement_timeout en la función se aplica a las llamadas desde el cliente (RPC) y prevalece sobre el del rol.
SET statement_timeout = '120s'
AS $$
DECLARE
    v_admin        RECORD;
    v_temp         RECORD;
    v_imp_id       UUID;
    g              JSONB;
    f              JSONB;
    v_tipo         RECORD;
    v_asoc_nombre  TEXT;
    v_cat_nombre   TEXT;
    v_fecha        DATE;
    v_variantes    TEXT[];
    v_ids          UUID[];
    v_rodeo_id     UUID;
    v_duracion     INTEGER;
    v_accion_rodeo TEXT;
    v_delegado     NUMERIC;
    v_comision     NUMERIC;
    v_casos        INTEGER;
    v_ns           RECORD;
    v_ev           RECORD;
    v_u            RECORD;
    v_asig         RECORD;
    v_asig_id      UUID;
    v_nota_dep     NUMERIC;
    v_nd           RECORD;
    v_n            INTEGER;
    v_creada       BOOLEAN;
    v_g_acc        JSONB;
    v_g_ex         JSONB;
    v_g_conf       JSONB;
    v_g_err        JSONB;
    v_f_acc        JSONB;
    v_f_ex         JSONB;
    v_f_conf       JSONB;
    v_f_err        JSONB;
    v_res_grupos   JSONB := '[]'::jsonb;
    v_res_filas    JSONB := '[]'::jsonb;
    v_tiene_validas BOOLEAN;
    -- contadores
    c_rodeos_creados INTEGER := 0;   c_rodeos_reutilizados INTEGER := 0;   c_rodeos_omitidos INTEGER := 0;
    c_asig_creadas INTEGER := 0;     c_asig_existentes INTEGER := 0;       c_filas_omitidas_rpc INTEGER := 0;
    c_del_cargadas INTEGER := 0;     c_del_iguales INTEGER := 0;
    c_com_cargadas INTEGER := 0;     c_com_iguales INTEGER := 0;
    c_dep_cargadas INTEGER := 0;     c_dep_iguales INTEGER := 0;
    c_casos_cargados INTEGER := 0;   c_casos_iguales INTEGER := 0;         c_casos_no_cargados INTEGER := 0;
    c_evals_creadas INTEGER := 0;
    c_conf_del INTEGER := 0; c_conf_com INTEGER := 0; c_conf_dep INTEGER := 0; c_conf_casos INTEGER := 0;
    v_ids_rodeos_creados JSONB := '[]'::jsonb;
    v_resumen      JSONB;
BEGIN
    -- ── 1) Argumentos y permisos (errores fatales: no se escribe nada) ───────────────
    IF p_admin_id IS NULL OR p_temporada_id IS NULL OR p_fecha_desde IS NULL OR p_fecha_hasta IS NULL
       OR p_nombre_archivo IS NULL OR p_fecha_desde > p_fecha_hasta THEN
        RAISE EXCEPTION 'HIST_ARGUMENTOS_INVALIDOS';
    END IF;
    IF p_grupos IS NULL OR jsonb_typeof(p_grupos) <> 'array' OR jsonb_array_length(p_grupos) = 0 THEN
        RAISE EXCEPTION 'HIST_SIN_GRUPOS';
    END IF;

    SELECT id, activo, rol_evaluacion INTO v_admin FROM administradores WHERE id = p_admin_id;
    IF NOT FOUND OR v_admin.activo IS NOT TRUE OR v_admin.rol_evaluacion IS NOT NULL THEN
        RAISE EXCEPTION 'HIST_SIN_PERMISO';
    END IF;

    SELECT id, nombre, fecha_inicio, fecha_fin INTO v_temp FROM temporadas WHERE id = p_temporada_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'HIST_TEMPORADA_INEXISTENTE';
    END IF;

    -- ── 2) Registro de la importación (arquitectura existente: tabla importaciones) ──
    INSERT INTO importaciones (nombre_archivo, total_filas, tipo, created_by)
    VALUES (p_nombre_archivo, COALESCE(p_total_filas, 0), 'historico_rodeos', p_admin_id)
    RETURNING id INTO v_imp_id;

    -- ── 3) Un grupo = un rodeo. Orden determinista por clave (evita deadlocks). ─────
    FOR g IN SELECT e.value FROM jsonb_array_elements(p_grupos) AS e ORDER BY e.value->>'clave'
    LOOP
        v_g_acc := '[]'::jsonb; v_g_ex := '[]'::jsonb; v_g_conf := '[]'::jsonb; v_g_err := '[]'::jsonb;
        v_rodeo_id := NULL; v_accion_rodeo := 'OMITIDO'; v_tiene_validas := false;

        IF COALESCE(g->>'clave', '') = '' OR jsonb_typeof(g->'filas') <> 'array' THEN
            RAISE EXCEPTION 'HIST_GRUPO_INVALIDO';
        END IF;

        -- Lock ANTES de buscar/crear (serializa importaciones simultáneas del mismo rodeo)
        PERFORM pg_advisory_xact_lock(hashtextextended('hist_rodeo|' || (g->>'clave'), 0));

        v_fecha := (g->>'fecha')::date;
        v_delegado := (g->>'nota_delegado')::numeric;
        v_comision := (g->>'nota_comision')::numeric;
        v_casos := COALESCE((g->>'casos_whatsapp')::integer, 0);
        IF v_casos < 0 OR (v_delegado IS NOT NULL AND (v_delegado < 1 OR v_delegado > 7))
           OR (v_comision IS NOT NULL AND (v_comision < 1 OR v_comision > 7)) THEN
            RAISE EXCEPTION 'HIST_DATOS_FUERA_DE_RANGO';
        END IF;

        -- Datos maestros: se releen de la base (no se confía en el llamador)
        SELECT id, nombre, duracion_dias INTO v_tipo FROM tipos_rodeo
         WHERE id = (g->>'tipo_rodeo_id')::uuid AND activo = true;
        SELECT nombre INTO v_asoc_nombre FROM asociaciones
         WHERE id = (g->>'asociacion_id')::uuid AND activa = true;
        v_cat_nombre := NULL;
        IF g->>'categoria_rodeo_id' IS NOT NULL THEN
            SELECT nombre INTO v_cat_nombre FROM categorias_rodeo WHERE id = (g->>'categoria_rodeo_id')::uuid;
        END IF;

        IF v_tipo.id IS NULL THEN
            v_g_err := v_g_err || to_jsonb('TIPO DE RODEO NO ENCONTRADO EN LA BASE'::text);
        ELSIF v_tipo.duracion_dias < 1 OR v_tipo.duracion_dias > 5 THEN
            v_g_err := v_g_err || to_jsonb('DURACIÓN DEL TIPO DE RODEO FUERA DE RANGO (1 a 5)'::text);
        END IF;
        IF v_asoc_nombre IS NULL THEN
            v_g_err := v_g_err || to_jsonb('ASOCIACIÓN NO ENCONTRADA EN LA BASE'::text);
        END IF;
        IF g->>'categoria_rodeo_id' IS NOT NULL AND v_cat_nombre IS NULL THEN
            v_g_err := v_g_err || to_jsonb('CATEGORÍA DEL RODEO NO ENCONTRADA EN LA BASE'::text);
        END IF;
        IF v_fecha < p_fecha_desde OR v_fecha > p_fecha_hasta OR v_fecha < v_temp.fecha_inicio OR v_fecha > v_temp.fecha_fin THEN
            v_g_err := v_g_err || to_jsonb('FECHA FUERA DEL PERÍODO PERMITIDO'::text);
        END IF;

        -- Buscar el rodeo (SIEMPRE bajo el lock): fecha + tipo + asociación (variantes) + club normalizado
        IF jsonb_array_length(v_g_err) = 0 THEN
            v_variantes := ARRAY(SELECT jsonb_array_elements_text(COALESCE(g->'asociacion_variantes', '[]'::jsonb)));
            v_variantes := v_variantes || v_asoc_nombre;
            SELECT array_agg(r.id ORDER BY r.created_at, r.id) INTO v_ids
              FROM rodeos r
             WHERE r.estado <> 'anulado'
               AND r.fecha = v_fecha
               AND r.tipo_rodeo_id = v_tipo.id
               AND r.asociacion = ANY (v_variantes)
               AND btrim(regexp_replace(regexp_replace(lower(translate(r.club,
                       'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ', 'aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC')),
                       '[-–—]+', ' ', 'g'), '\s+', ' ', 'g')) = (g->>'club_norm');

            IF v_ids IS NOT NULL AND array_length(v_ids, 1) > 1 THEN
                v_g_err := v_g_err || to_jsonb('RODEO AMBIGUO: más de un rodeo existente coincide con la llave lógica'::text);
            END IF;
        END IF;

        IF jsonb_array_length(v_g_err) = 0 THEN
            -- ¿hay al menos un jurado importable? (no se crea un rodeo sin ningún jurado válido)
            SELECT EXISTS (
                SELECT 1 FROM jsonb_array_elements(g->'filas') AS ff(value)
                 JOIN usuarios_pagados u ON u.id = (ff.value->>'usuario_pagado_id')::uuid
                WHERE u.tipo_persona = 'jurado' AND u.es_prueba = false
            ) INTO v_tiene_validas;
            IF NOT v_tiene_validas THEN
                v_g_err := v_g_err || to_jsonb('NINGÚN JURADO VÁLIDO EN LA BASE PARA ESTE RODEO'::text);
            END IF;
        END IF;

        IF jsonb_array_length(v_g_err) > 0 THEN
            c_rodeos_omitidos := c_rodeos_omitidos + 1;
            c_filas_omitidas_rpc := c_filas_omitidas_rpc + jsonb_array_length(g->'filas');
            v_res_grupos := v_res_grupos || jsonb_build_object('clave', g->>'clave', 'rodeo_id', NULL, 'accion_rodeo', 'OMITIDO',
                'acciones', v_g_acc, 'existentes', v_g_ex, 'conflictos', v_g_conf, 'errores', v_g_err);
            CONTINUE;
        END IF;

        -- ── 3a) Rodeo: crear o reutilizar ─────────────────────────────────────────
        IF v_ids IS NULL THEN
            INSERT INTO rodeos (club, asociacion, fecha, tipo_rodeo_id, tipo_rodeo_nombre, duracion_dias, origen, estado,
                                importacion_id, created_by, categoria_rodeo_id, categoria_rodeo_nombre, temporada_id)
            VALUES (btrim(g->>'club'), v_asoc_nombre, v_fecha, v_tipo.id, v_tipo.nombre, v_tipo.duracion_dias, 'importado', 'activo',
                    v_imp_id, p_admin_id, (g->>'categoria_rodeo_id')::uuid, v_cat_nombre, p_temporada_id)
            RETURNING id INTO v_rodeo_id;
            v_duracion := v_tipo.duracion_dias;
            v_accion_rodeo := 'CREADO';
            c_rodeos_creados := c_rodeos_creados + 1;
            v_ids_rodeos_creados := v_ids_rodeos_creados || to_jsonb(v_rodeo_id);
            v_g_acc := v_g_acc || to_jsonb('Rodeo creado'::text);
        ELSE
            v_rodeo_id := v_ids[1];
            SELECT duracion_dias INTO v_duracion FROM rodeos WHERE id = v_rodeo_id;
            v_accion_rodeo := 'REUTILIZADO';
            c_rodeos_reutilizados := c_rodeos_reutilizados + 1;
            v_g_ex := v_g_ex || to_jsonb('Rodeo ya existente (reutilizado)'::text);
        END IF;

        -- ── 3b) Nota Delegado / Nota Comisión (rodeo_notas_secundarias, por rodeo) ──
        IF v_delegado IS NOT NULL OR v_comision IS NOT NULL THEN
            INSERT INTO rodeo_notas_secundarias (rodeo_id, nota_delegado, nota_comision, actualizado_por, actualizado_en)
            VALUES (v_rodeo_id, v_delegado, v_comision, p_admin_id::text, now())
            ON CONFLICT (rodeo_id) DO NOTHING;
            GET DIAGNOSTICS v_n = ROW_COUNT;
            IF v_n = 1 THEN
                IF v_delegado IS NOT NULL THEN c_del_cargadas := c_del_cargadas + 1; v_g_acc := v_g_acc || to_jsonb('Nota Delegado cargada'::text); END IF;
                IF v_comision IS NOT NULL THEN c_com_cargadas := c_com_cargadas + 1; v_g_acc := v_g_acc || to_jsonb('Nota Comisión cargada'::text); END IF;
            ELSE
                SELECT * INTO v_ns FROM rodeo_notas_secundarias WHERE rodeo_id = v_rodeo_id FOR UPDATE;
                IF v_delegado IS NOT NULL THEN
                    IF v_ns.nota_delegado IS NULL THEN
                        UPDATE rodeo_notas_secundarias SET nota_delegado = v_delegado, actualizado_por = p_admin_id::text, actualizado_en = now(), updated_at = now() WHERE rodeo_id = v_rodeo_id;
                        c_del_cargadas := c_del_cargadas + 1; v_g_acc := v_g_acc || to_jsonb('Nota Delegado completada'::text);
                    ELSIF abs(v_ns.nota_delegado - v_delegado) < 0.005 THEN
                        c_del_iguales := c_del_iguales + 1; v_g_ex := v_g_ex || to_jsonb('Nota Delegado ya registrada (igual)'::text);
                    ELSE
                        c_conf_del := c_conf_del + 1;
                        v_g_conf := v_g_conf || to_jsonb('CONFLICTO NOTA DELEGADO: existente ' || v_ns.nota_delegado || ' / Excel ' || v_delegado || ' (no se sobrescribe)');
                    END IF;
                END IF;
                IF v_comision IS NOT NULL THEN
                    IF v_ns.nota_comision IS NULL THEN
                        UPDATE rodeo_notas_secundarias SET nota_comision = v_comision, actualizado_por = p_admin_id::text, actualizado_en = now(), updated_at = now() WHERE rodeo_id = v_rodeo_id;
                        c_com_cargadas := c_com_cargadas + 1; v_g_acc := v_g_acc || to_jsonb('Nota Comisión completada'::text);
                    ELSIF abs(v_ns.nota_comision - v_comision) < 0.005 THEN
                        c_com_iguales := c_com_iguales + 1; v_g_ex := v_g_ex || to_jsonb('Nota Comisión ya registrada (igual)'::text);
                    ELSE
                        c_conf_com := c_conf_com + 1;
                        v_g_conf := v_g_conf || to_jsonb('CONFLICTO NOTA COMISIÓN: existente ' || v_ns.nota_comision || ' / Excel ' || v_comision || ' (no se sobrescribe)');
                    END IF;
                END IF;
            END IF;
        END IF;

        -- ── 3c) Casos por WhatsApp (evaluaciones.casos_whatsapp, por rodeo) ─────────
        v_creada := false;
        IF v_casos > 0 AND p_crear_evaluaciones
           AND NOT EXISTS (SELECT 1 FROM evaluaciones WHERE rodeo_id = v_rodeo_id) THEN
            -- Evaluación histórica MÍNIMA: sin ciclos, sin casos, sin notas, estado terminal existente 'cerrado'.
            INSERT INTO evaluaciones (rodeo_id, creado_por, estado, casos_whatsapp, es_historica_importacion)
            VALUES (v_rodeo_id, p_admin_id, 'cerrado', v_casos, true)
            ON CONFLICT (rodeo_id) DO NOTHING;
            GET DIAGNOSTICS v_n = ROW_COUNT;
            IF v_n = 1 THEN
                v_creada := true; c_evals_creadas := c_evals_creadas + 1; c_casos_cargados := c_casos_cargados + 1;
                v_g_acc := v_g_acc || to_jsonb('Evaluación histórica mínima creada con Casos por WhatsApp = ' || v_casos);
            END IF;
        END IF;
        IF NOT v_creada THEN
            SELECT id, casos_whatsapp, anulada INTO v_ev FROM evaluaciones WHERE rodeo_id = v_rodeo_id FOR UPDATE;
            IF FOUND THEN
                IF v_ev.casos_whatsapp = v_casos THEN
                    IF v_casos > 0 THEN c_casos_iguales := c_casos_iguales + 1; v_g_ex := v_g_ex || to_jsonb('Casos por WhatsApp ya registrados (igual)'::text); END IF;
                ELSE
                    c_conf_casos := c_conf_casos + 1;
                    v_g_conf := v_g_conf || to_jsonb('CONFLICTO CASOS POR WHATSAPP: existente ' || v_ev.casos_whatsapp || ' / Excel ' || v_casos
                        || CASE WHEN v_ev.anulada THEN ' (evaluación anulada)' ELSE '' END || ' (no se sobrescribe)');
                END IF;
            ELSIF v_casos > 0 THEN
                -- sin evaluación y creación deshabilitada
                c_casos_no_cargados := c_casos_no_cargados + 1;
                v_g_ex := v_g_ex || to_jsonb('Casos por WhatsApp NO cargados: la creación de evaluaciones históricas está deshabilitada'::text);
            END IF;
        END IF;

        -- ── 3d) Jurados: asignación + Nota Deportiva ───────────────────────────────
        FOR f IN SELECT e.value FROM jsonb_array_elements(g->'filas') AS e ORDER BY (e.value->>'fila')::integer
        LOOP
            v_f_acc := '[]'::jsonb; v_f_ex := '[]'::jsonb; v_f_conf := '[]'::jsonb; v_f_err := '[]'::jsonb;
            v_nota_dep := (f->>'nota_deportiva')::numeric;
            IF v_nota_dep IS NOT NULL AND (v_nota_dep < 1 OR v_nota_dep > 7) THEN
                RAISE EXCEPTION 'HIST_DATOS_FUERA_DE_RANGO';
            END IF;

            SELECT id, nombre_completo, categoria, tipo_persona, es_prueba INTO v_u
              FROM usuarios_pagados WHERE id = (f->>'usuario_pagado_id')::uuid;
            IF NOT FOUND OR v_u.tipo_persona <> 'jurado' OR v_u.es_prueba IS TRUE THEN
                c_filas_omitidas_rpc := c_filas_omitidas_rpc + 1;
                v_f_err := v_f_err || to_jsonb('JURADO NO VÁLIDO EN LA BASE (inexistente, no es jurado o es de prueba)'::text);
                v_res_filas := v_res_filas || jsonb_build_object('clave', g->>'clave', 'fila', (f->>'fila')::integer, 'jurado', f->>'jurado',
                    'asignacion_id', NULL, 'acciones', v_f_acc, 'existentes', v_f_ex, 'conflictos', v_f_conf, 'errores', v_f_err);
                CONTINUE;
            END IF;

            SELECT id, estado_designacion INTO v_asig FROM asignaciones
             WHERE rodeo_id = v_rodeo_id AND usuario_pagado_id = v_u.id AND tipo_persona = 'jurado' AND estado <> 'anulado'
             ORDER BY created_at, id LIMIT 1;
            IF FOUND THEN
                v_asig_id := v_asig.id;
                c_asig_existentes := c_asig_existentes + 1;
                v_f_ex := v_f_ex || to_jsonb('Asignación ya existente (designación: ' || COALESCE(v_asig.estado_designacion, 'sin estado') || '); no se modifica');
            ELSE
                INSERT INTO asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, categoria_aplicada, valor_diario_aplicado,
                                          duracion_dias_aplicada, pago_base_calculado, estado, estado_designacion, publicado,
                                          created_by, observacion, importacion_id)
                VALUES (v_rodeo_id, v_u.id, 'jurado',
                        CASE WHEN v_u.categoria IN ('A', 'B', 'C', 'DR') THEN v_u.categoria ELSE NULL END,
                        0, v_duracion, 0, 'activo', 'aceptado', false, p_admin_id, 'Importación histórica (sin pago)', v_imp_id)
                RETURNING id INTO v_asig_id;
                c_asig_creadas := c_asig_creadas + 1;
                v_f_acc := v_f_acc || to_jsonb('Asignación histórica creada (aceptada, no publicada, pago $0)'::text);
            END IF;

            IF v_nota_dep IS NOT NULL THEN
                INSERT INTO notas_rodeo (asignacion_id, nota, fuente, evaluado_en, updated_by)
                VALUES (v_asig_id, v_nota_dep, 'manual', now(), p_admin_id::text)
                ON CONFLICT (asignacion_id) DO NOTHING;
                GET DIAGNOSTICS v_n = ROW_COUNT;
                IF v_n = 1 THEN
                    c_dep_cargadas := c_dep_cargadas + 1; v_f_acc := v_f_acc || to_jsonb('Nota Deportiva cargada'::text);
                ELSE
                    SELECT nota INTO v_nd FROM notas_rodeo WHERE asignacion_id = v_asig_id;
                    IF abs(v_nd.nota - v_nota_dep) < 0.005 THEN
                        c_dep_iguales := c_dep_iguales + 1; v_f_ex := v_f_ex || to_jsonb('Nota Deportiva ya registrada (igual)'::text);
                    ELSE
                        c_conf_dep := c_conf_dep + 1;
                        v_f_conf := v_f_conf || to_jsonb('CONFLICTO NOTA DEPORTIVA: existente ' || v_nd.nota || ' / Excel ' || v_nota_dep || ' (no se sobrescribe)');
                    END IF;
                END IF;
            END IF;

            v_res_filas := v_res_filas || jsonb_build_object('clave', g->>'clave', 'fila', (f->>'fila')::integer, 'jurado', f->>'jurado',
                'asignacion_id', v_asig_id, 'acciones', v_f_acc, 'existentes', v_f_ex, 'conflictos', v_f_conf, 'errores', v_f_err);
        END LOOP;

        v_res_grupos := v_res_grupos || jsonb_build_object('clave', g->>'clave', 'rodeo_id', v_rodeo_id, 'accion_rodeo', v_accion_rodeo,
            'acciones', v_g_acc, 'existentes', v_g_ex, 'conflictos', v_g_conf, 'errores', v_g_err);
    END LOOP;

    -- ── 4) Resumen, registro de importación y auditoría (misma transacción) ─────────
    v_resumen := jsonb_build_object(
        'rodeos_creados', c_rodeos_creados, 'rodeos_reutilizados', c_rodeos_reutilizados, 'rodeos_omitidos', c_rodeos_omitidos,
        'asignaciones_creadas', c_asig_creadas, 'asignaciones_existentes', c_asig_existentes,
        'notas_delegado_cargadas', c_del_cargadas, 'notas_delegado_iguales', c_del_iguales,
        'notas_comision_cargadas', c_com_cargadas, 'notas_comision_iguales', c_com_iguales,
        'notas_deportivas_cargadas', c_dep_cargadas, 'notas_deportivas_iguales', c_dep_iguales,
        'casos_whatsapp_cargados', c_casos_cargados, 'casos_whatsapp_iguales', c_casos_iguales, 'casos_whatsapp_no_cargados', c_casos_no_cargados,
        'evaluaciones_historicas_creadas', c_evals_creadas,
        'conflictos_nota_delegado', c_conf_del, 'conflictos_nota_comision', c_conf_com,
        'conflictos_nota_deportiva', c_conf_dep, 'conflictos_casos_whatsapp', c_conf_casos,
        'conflictos_total', c_conf_del + c_conf_com + c_conf_dep + c_conf_casos,
        'filas_omitidas_en_base', c_filas_omitidas_rpc,
        'pagos_generados', 0
    );

    UPDATE importaciones
       SET insertadas = c_rodeos_creados,
           duplicadas = c_rodeos_reutilizados,
           rechazadas = COALESCE(p_filas_omitidas, 0) + c_filas_omitidas_rpc,
           errores    = COALESCE(p_filas_con_error, 0)
     WHERE id = v_imp_id;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_nuevos, actor_id, actor_tipo, descripcion, ip_address)
    VALUES ('importaciones', v_imp_id::text, 'importacion_historica',
            jsonb_build_object('archivo', p_nombre_archivo, 'sha256', p_sha256, 'temporada', v_temp.nombre, 'temporada_id', v_temp.id,
                               'total_filas', p_total_filas, 'filas_omitidas_previas', p_filas_omitidas, 'filas_con_error', p_filas_con_error,
                               'resumen', v_resumen, 'rodeos_creados_ids', v_ids_rodeos_creados),
            p_admin_id::text, 'administrador',
            'IMPORTACIÓN HISTÓRICA de rodeos (' || v_temp.nombre || '): ' || p_nombre_archivo, p_ip);

    RETURN jsonb_build_object('importacion_id', v_imp_id, 'resumen', v_resumen, 'grupos', v_res_grupos, 'filas', v_res_filas);
END;
$$;

REVOKE ALL ON FUNCTION importar_rodeos_historicos(UUID, UUID, DATE, DATE, TEXT, TEXT, INTEGER, JSONB, INTEGER, INTEGER, BOOLEAN, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION importar_rodeos_historicos(UUID, UUID, DATE, DATE, TEXT, TEXT, INTEGER, JSONB, INTEGER, INTEGER, BOOLEAN, TEXT) FROM anon;
REVOKE ALL ON FUNCTION importar_rodeos_historicos(UUID, UUID, DATE, DATE, TEXT, TEXT, INTEGER, JSONB, INTEGER, INTEGER, BOOLEAN, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION importar_rodeos_historicos(UUID, UUID, DATE, DATE, TEXT, TEXT, INTEGER, JSONB, INTEGER, INTEGER, BOOLEAN, TEXT) TO service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- 4) Conversión ATÓMICA: evaluación histórica → evaluación normal
--
-- Se usa cuando alguien crea una evaluación normal para un rodeo que ya tiene una evaluación con
-- es_historica_importacion = true (evaluaciones.rodeo_id es UNIQUE: no se crea una segunda fila, se reutiliza).
-- En UNA transacción: bloquea la fila, la inicializa como una evaluación nueva normal (estado 'borrador' = default de
-- una evaluación nueva, analista, puntaje_base de la configuración, creado_por = quien la crea, es_historica=false),
-- CONSERVA casos_whatsapp, crea los ciclos y registra la auditoría. Si algo falla, no queda nada a medias.
--
-- Los ciclos y el detalle de auditoría los define el backend con el MISMO código que usa la creación normal
-- (services/evaluacionCreacion.js): aquí solo se insertan las filas recibidas; la definición de ciclos no se duplica.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION convertir_evaluacion_historica(
    p_rodeo_id      UUID,
    p_analista_id   UUID,
    p_puntaje_base  INTEGER,
    p_actor_id      UUID,
    p_actor_nombre  TEXT,
    p_ciclos        JSONB,
    p_detalle       JSONB,
    p_ip            TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_ev   RECORD;
    v_ip   INET;
    v_row  JSONB;
BEGIN
    IF p_rodeo_id IS NULL OR p_analista_id IS NULL OR p_puntaje_base IS NULL OR p_actor_id IS NULL
       OR p_ciclos IS NULL OR jsonb_typeof(p_ciclos) <> 'array' OR jsonb_array_length(p_ciclos) = 0 THEN
        RAISE EXCEPTION 'EVAL_CONV_ARGUMENTOS_INVALIDOS';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM administradores WHERE id = p_actor_id AND activo = true) THEN
        RAISE EXCEPTION 'EVAL_CONV_SIN_PERMISO';
    END IF;

    SELECT id, es_historica_importacion, anulada INTO v_ev FROM evaluaciones WHERE rodeo_id = p_rodeo_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'EVAL_CONV_NO_ENCONTRADA'; END IF;
    IF v_ev.es_historica_importacion IS NOT TRUE THEN RAISE EXCEPTION 'EVAL_CONV_NO_HISTORICA'; END IF;
    IF v_ev.anulada IS TRUE THEN RAISE EXCEPTION 'EVAL_CONV_ANULADA'; END IF;
    IF EXISTS (SELECT 1 FROM evaluacion_ciclos WHERE evaluacion_id = v_ev.id) THEN RAISE EXCEPTION 'EVAL_CONV_YA_TIENE_CICLOS'; END IF;

    UPDATE evaluaciones
       SET es_historica_importacion = false,
           estado        = 'borrador',
           analista_id   = p_analista_id,
           puntaje_base  = p_puntaje_base,
           creado_por    = p_actor_id,
           updated_at    = now()
     WHERE id = v_ev.id;                       -- casos_whatsapp NO se toca (se conserva)

    INSERT INTO evaluacion_ciclos (evaluacion_id, numero_ciclo, min_casos, max_casos)
    SELECT v_ev.id, (c.value->>'numero_ciclo')::integer, (c.value->>'min_casos')::integer, (c.value->>'max_casos')::integer
      FROM jsonb_array_elements(p_ciclos) AS c(value);

    BEGIN v_ip := NULLIF(btrim(COALESCE(p_ip, '')), '')::inet; EXCEPTION WHEN others THEN v_ip := NULL; END;
    INSERT INTO evaluacion_auditoria (evaluacion_id, accion, detalle, actor_id, actor_tipo, actor_nombre, ip_address)
    VALUES (v_ev.id, 'crear_evaluacion', COALESCE(p_detalle, '{}'::jsonb), p_actor_id, 'administrador', p_actor_nombre, v_ip);

    SELECT to_jsonb(e) INTO v_row FROM evaluaciones e WHERE e.id = v_ev.id;
    RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION convertir_evaluacion_historica(UUID, UUID, INTEGER, UUID, TEXT, JSONB, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION convertir_evaluacion_historica(UUID, UUID, INTEGER, UUID, TEXT, JSONB, JSONB, TEXT) FROM anon;
REVOKE ALL ON FUNCTION convertir_evaluacion_historica(UUID, UUID, INTEGER, UUID, TEXT, JSONB, JSONB, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION convertir_evaluacion_historica(UUID, UUID, INTEGER, UUID, TEXT, JSONB, JSONB, TEXT) TO service_role;
