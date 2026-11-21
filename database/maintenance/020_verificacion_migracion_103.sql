-- ═════════════════════════════════════════════════════════════════════════
-- 020: Verificación de la migración 103 (revisiones de Comisión, bloqueo de
--      publicación y cierre excepcional del Administrador). SOLO LECTURA.
--
-- PASO A — ANTES de aplicar la 103: ejecutar la "FOTO" y guardar el resultado.
-- PASO B — DESPUÉS de aplicar la 103: ejecutar de nuevo la "FOTO" (debe ser
--          IDÉNTICA: la 103 no modifica ninguna fila existente) y luego las
--          COMPROBACIONES: TODAS deben devolver ok = true.
--
-- Reglas de las comprobaciones:
--   · Cada fila devuelve un booleano NO NULO (COALESCE(..., false)): un
--     objeto ausente nunca se cuenta como aprobado.
--   · Cada conjunto se valida con un CONTEO EXACTO además de la condición
--     (bool_and sobre 0 filas sería NULL; un objeto faltante no se omite).
--   · Si la 103 no está aplicada, las comprobaciones que leen las tablas
--     nuevas fallan con error "relation does not exist" (falla cerrada).
--
-- La FOTO refleja también la actividad normal del sistema (notas publicadas,
-- casos resueltos): tomar A y B en un horario sin uso y lo más juntas
-- posible. Si difieren, revisar las columnas *_ultima_mod antes de concluir.
-- ═════════════════════════════════════════════════════════════════════════

-- ── FOTO (pasos A y B): notas, evaluaciones, ciclos y casos existentes ─────
-- json_build_array con columnas EXPLÍCITAS (no row_to_json en evaluaciones/
-- casos: la 103 agrega columnas nuevas a evaluacion_casos y cambiaría la
-- serialización sin que cambie ningún dato). json_build_array nunca descarta
-- una fila por un NULL (a diferencia de concatenar texto con ||).
SELECT
    (SELECT count(*) FROM notas_rodeo)                                                          AS notas_total,
    (SELECT md5(string_agg(row_to_json(n)::text, '|' ORDER BY id)) FROM notas_rodeo n)           AS notas_md5,
    (SELECT max(updated_at)::text FROM notas_rodeo)                                              AS notas_ultima_mod,
    (SELECT count(*) FROM evaluaciones)                                                          AS evaluaciones_total,
    (SELECT count(*) FROM evaluaciones WHERE estado = 'publicado')                               AS evaluaciones_publicadas,
    (SELECT md5(string_agg(json_build_array(id, estado, puntaje_base, puntaje_final, nota_final, nota_publicada,
                                            decision_jefe, anulada, resultados_alterados, comentario_resultados_alterados,
                                            updated_at)::text, '|' ORDER BY id))
       FROM evaluaciones)                                                                        AS evaluaciones_md5,
    (SELECT max(updated_at)::text FROM evaluaciones)                                             AS evaluaciones_ultima_mod,
    (SELECT md5(string_agg(json_build_array(id, evaluacion_id, numero_ciclo, estado, updated_at)::text, '|' ORDER BY id))
       FROM evaluacion_ciclos)                                                                   AS ciclos_md5,
    (SELECT count(*) FROM evaluacion_casos)                                                      AS casos_total,
    (SELECT md5(string_agg(json_build_array(id, estado, tipo_caso, descuento_puntos, resolucion_final, decision_analista,
                                            decision_comision, comision_miembro_id, anulado, updated_at)::text, '|' ORDER BY id))
       FROM evaluacion_casos)                                                                    AS casos_md5,
    (SELECT max(updated_at)::text FROM evaluacion_casos)                                         AS casos_ultima_mod,
    (SELECT count(*) FROM evaluacion_auditoria)                                                  AS auditoria_total;
-- ── FIN FOTO ──────────────────────────────────────────────────────────────

-- ── COMPROBACIONES (solo paso B) ─────────────────────────────────────────
WITH
f AS (
    SELECT p.oid, p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS dueno,
           md5(replace(p.prosrc, E'\r\n', E'\n')) AS md5
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
),
-- Las 10 funciones nuevas de la 103 (publicar_evaluacion se valida aparte).
f103 AS (
    SELECT * FROM f WHERE proname IN (
        'generar_revision_resultado_alterado', 'resolver_revision_resultado_alterado', 'anular_revision_resultado_alterado',
        'resolver_caso_derivado_comision', 'cierre_excepcional_comision_admin', '_pendientes_comision_evaluacion',
        '_en_cierre_excepcional_admin', 'fn_proteger_caso_derivado_comision', 'fn_proteger_alteracion_revisada',
        'fn_proteger_revision_comision')
),
-- Las que el backend invoca (directa o indirectamente) con service_role.
fservicio AS (
    SELECT * FROM f WHERE proname IN (
        'publicar_evaluacion', 'generar_revision_resultado_alterado', 'resolver_revision_resultado_alterado',
        'anular_revision_resultado_alterado', 'resolver_caso_derivado_comision', 'cierre_excepcional_comision_admin',
        '_pendientes_comision_evaluacion', '_en_cierre_excepcional_admin')
),
t103 AS (
    SELECT c.oid, c.relname, c.relrowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname IN ('evaluacion_revisiones_comision', 'evaluacion_cierres_excepcionales')
),
roles_api(rol) AS (VALUES ('public'), ('anon'), ('authenticated')),
privs_tabla(priv) AS (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'))
SELECT comprobacion, COALESCE(ok, false) AS ok FROM (
          SELECT 1 AS orden, 'Existen las 2 tablas nuevas' AS comprobacion,
                 (SELECT count(*) = 2 FROM t103) AS ok
UNION ALL SELECT 2, 'Existen las 10 funciones nuevas, una sola versión de cada una',
                 (SELECT count(*) = 10 AND count(DISTINCT proname) = 10 FROM f103)
UNION ALL SELECT 3, 'Existen las 5 columnas nuevas en evaluacion_casos',
                 (SELECT count(*) = 5 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'evaluacion_casos'
                     AND column_name IN ('decision_admin_excepcional', 'admin_excepcional_por', 'admin_excepcional_en',
                                         'motivo_admin_excepcional', 'cierre_excepcional_id'))
UNION ALL SELECT 4, 'Restricciones CHECK de la 103 (4 en revisiones + 1 en casos)',
                 (SELECT count(*) = 5 FROM pg_constraint
                   WHERE contype = 'c' AND conname IN ('chk_revision_resuelta', 'chk_revision_pendiente', 'chk_revision_anulada',
                                                       'chk_revision_cierre_excepcional', 'chk_caso_decision_admin_excepcional'))
UNION ALL SELECT 5, 'Índices de la 103 (incluido el único de revisión vigente)',
                 (SELECT count(*) = 3 AND bool_and(i.relname <> 'uq_revision_comision_vigente' OR x.indisunique)
                    FROM pg_class i JOIN pg_index x ON x.indexrelid = i.oid
                   WHERE i.relname IN ('uq_revision_comision_vigente', 'idx_revision_comision_estado', 'idx_cierres_excepcionales_evaluacion'))
UNION ALL SELECT 6, 'Triggers de la 103 instalados, habilitados y en su tabla',
                 (SELECT count(*) = 3 AND bool_and(tgenabled = 'O') FROM pg_trigger
                   WHERE NOT tgisinternal AND (tgname, tgrelid) IN (
                         ('trg_proteger_caso_derivado_comision', 'public.evaluacion_casos'::regclass),
                         ('trg_proteger_alteracion_revisada',    'public.evaluaciones'::regclass),
                         ('trg_proteger_revision_comision',      to_regclass('public.evaluacion_revisiones_comision'))))
UNION ALL SELECT 7, 'publicar_evaluacion = cuerpo de la 103 (cálculo de producción + bloque [103]), única versión',
                 (SELECT count(*) = 1 AND bool_and(md5 = '47472945173ac6984105a1f08cb56f20') FROM f WHERE proname = 'publicar_evaluacion')
UNION ALL SELECT 8, 'cierre_excepcional_comision_admin = cuerpo de la 103',
                 (SELECT count(*) = 1 AND bool_and(md5 = '42ca3b4bd480b6b5109128023afa0c7d') FROM f WHERE proname = 'cierre_excepcional_comision_admin')
UNION ALL SELECT 9, 'publicar_evaluacion: SECURITY DEFINER, search_path fijo, dueño postgres',
                 (SELECT count(*) = 1 AND bool_and(prosecdef AND proconfig = ARRAY['search_path=public'] AND dueno = 'postgres')
                    FROM f WHERE proname = 'publicar_evaluacion')
UNION ALL SELECT 10, 'Funciones nuevas: SECURITY INVOKER con search_path fijo (las 10)',
                 (SELECT count(*) = 10 AND bool_and(NOT prosecdef AND proconfig = ARRAY['search_path=public, pg_temp']) FROM f103)
UNION ALL SELECT 11, 'EXECUTE para service_role en publicar y en las 7 que usa el backend',
                 (SELECT count(*) = 8 AND bool_and(has_function_privilege('service_role', oid, 'EXECUTE')) FROM fservicio)
UNION ALL SELECT 12, 'Sin EXECUTE para PUBLIC, anon ni authenticated (publicar + las 10 nuevas)',
                 (SELECT count(*) = 33 AND bool_and(NOT has_function_privilege(r.rol, x.oid, 'EXECUTE'))
                    FROM (SELECT oid FROM f103 UNION ALL SELECT oid FROM f WHERE proname = 'publicar_evaluacion') x
                    CROSS JOIN roles_api r)
UNION ALL SELECT 13, 'Tablas nuevas: RLS activo',
                 (SELECT count(*) = 2 AND bool_and(relrowsecurity) FROM t103)
UNION ALL SELECT 14, 'Tablas nuevas: service_role con SELECT, INSERT y UPDATE (lo que usa el backend)',
                 (SELECT count(*) = 2 AND bool_and(has_table_privilege('service_role', oid, 'SELECT')
                                               AND has_table_privilege('service_role', oid, 'INSERT')
                                               AND has_table_privilege('service_role', oid, 'UPDATE')) FROM t103)
UNION ALL SELECT 15, 'Tablas nuevas: ningún privilegio para PUBLIC, anon ni authenticated',
                 (SELECT count(*) = 42 AND bool_and(NOT has_table_privilege(r.rol, t.oid, p.priv))
                    FROM t103 t CROSS JOIN roles_api r CROSS JOIN privs_tabla p)
UNION ALL SELECT 16, 'Columnas administrativas nuevas vacías en todos los casos existentes',
                 (SELECT count(*) = 0 FROM evaluacion_casos
                   WHERE decision_admin_excepcional IS NOT NULL OR admin_excepcional_por IS NOT NULL
                      OR admin_excepcional_en IS NOT NULL OR motivo_admin_excepcional IS NOT NULL OR cierre_excepcional_id IS NOT NULL)
UNION ALL SELECT 17, 'Sin revisiones ni cierres creados por la migración (nada retroactivo)',
                 (SELECT (SELECT count(*) FROM evaluacion_revisiones_comision) = 0
                     AND (SELECT count(*) FROM evaluacion_cierres_excepcionales) = 0)
) c
ORDER BY orden;
