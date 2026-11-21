-- ═════════════════════════════════════════════════════════════════════════
-- 022: Verificación de la migración 105 (cierre del acceso de la Data API
--      — anon/authenticated — al esquema public). SOLO LECTURA.
--
-- PASO A — ANTES de aplicar la 105: ejecutar la FOTO y guardar el resultado.
-- PASO B — DESPUÉS de aplicar la 105: ejecutar la FOTO (debe ser IDÉNTICA:
--          la 105 no cambia datos ni los privilegios de service_role) y las
--          COMPROBACIONES: todas deben devolver ok = true.
-- Cada comprobación devuelve un booleano NO NULO (COALESCE(..., false)).
-- ═════════════════════════════════════════════════════════════════════════

-- ── FOTO (pasos A y B) ───────────────────────────────────────────────────
SELECT
    -- Privilegios de service_role (lo que usa el backend): deben quedar iguales.
    (SELECT md5(string_agg(c.relname || ':' || has_table_privilege('service_role', c.oid, 'SELECT')::text
                           || has_table_privilege('service_role', c.oid, 'INSERT')::text
                           || has_table_privilege('service_role', c.oid, 'UPDATE')::text
                           || has_table_privilege('service_role', c.oid, 'DELETE')::text, '|' ORDER BY c.relname))
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm'))                     AS service_role_tablas_md5,
    (SELECT md5(string_agg(c.relname || ':' || CASE WHEN c.relkind = 'S'
                           THEN has_sequence_privilege('service_role', c.oid, 'USAGE')::text END, '|' ORDER BY c.relname))
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'S')                                        AS service_role_secuencias_md5,
    (SELECT md5(string_agg(p.oid::regprocedure::text || ':' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text,
                           '|' ORDER BY p.oid::regprocedure::text))
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') AS service_role_funciones_md5,
    -- Datos: la 105 no modifica filas.
    (SELECT count(*) FROM administradores)                                                   AS administradores_total,
    (SELECT md5(string_agg(row_to_json(a)::text, '|' ORDER BY id)) FROM administradores a)   AS administradores_md5,
    (SELECT count(*) FROM usuarios_pagados)                                                  AS usuarios_pagados_total,
    (SELECT count(*) FROM rodeos)                                                            AS rodeos_total,
    (SELECT count(*) FROM asignaciones)                                                      AS asignaciones_total,
    (SELECT count(*) FROM notas_rodeo)                                                       AS notas_total,
    (SELECT md5(string_agg(row_to_json(n)::text, '|' ORDER BY id)) FROM notas_rodeo n)       AS notas_md5,
    (SELECT max(updated_at)::text FROM notas_rodeo)                                          AS notas_ultima_mod,
    (SELECT count(*) FROM evaluaciones)                                                      AS evaluaciones_total,
    (SELECT md5(string_agg(row_to_json(e)::text, '|' ORDER BY id)) FROM evaluaciones e)      AS evaluaciones_md5,
    (SELECT md5(string_agg(row_to_json(c)::text, '|' ORDER BY id)) FROM evaluacion_casos c)  AS casos_md5;
-- (La 105 no agrega columnas a estas tablas: una FOTO idéntica antes y después
--  significa que ninguna fila cambió. Si difiere, revisar notas_ultima_mod:
--  puede ser actividad normal del sistema durante la ventana.)
-- ── FIN FOTO ──────────────────────────────────────────────────────────────

-- ── COMPROBACIONES (solo paso B) ─────────────────────────────────────────
WITH
roles_api(rol) AS (VALUES ('anon'), ('authenticated')),
privs(priv) AS (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
rel AS (
    SELECT c.oid, c.relname, c.relkind, c.relrowsecurity, c.reloptions
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
),
fn AS (
    SELECT p.oid, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
)
SELECT comprobacion, COALESCE(ok, false) AS ok FROM (
          SELECT 1 AS orden, 'Tablas y vistas de public: ningún privilegio para anon ni authenticated' AS comprobacion,
                 (SELECT count(*) > 0 FROM rel WHERE relkind IN ('r', 'p', 'v', 'm', 'f'))
             AND (SELECT count(*) = 0 FROM rel r CROSS JOIN roles_api a CROSS JOIN privs p
                   WHERE r.relkind IN ('r', 'p', 'v', 'm', 'f') AND has_table_privilege(a.rol, r.oid, p.priv)) AS ok
UNION ALL SELECT 2, 'Secuencias de public: ningún privilegio para anon ni authenticated',
                 (SELECT count(*) = 0 FROM rel r CROSS JOIN roles_api a
                   WHERE r.relkind = 'S' AND CASE WHEN r.relkind = 'S' THEN
                         has_sequence_privilege(a.rol, r.oid, 'USAGE') OR has_sequence_privilege(a.rol, r.oid, 'SELECT')
                         OR has_sequence_privilege(a.rol, r.oid, 'UPDATE') ELSE false END)
UNION ALL SELECT 3, 'Funciones de public: sin EXECUTE para PUBLIC, anon ni authenticated',
                 (SELECT count(*) > 0 FROM fn)
             AND (SELECT count(*) = 0 FROM fn f CROSS JOIN (VALUES ('public'), ('anon'), ('authenticated')) r(rol)
                   WHERE has_function_privilege(r.rol, f.oid, 'EXECUTE'))
UNION ALL SELECT 4, 'Ninguna función SECURITY DEFINER ejecutable desde la Data API (/rest/v1/rpc)',
                 (SELECT count(*) = 0 FROM fn f CROSS JOIN (VALUES ('public'), ('anon'), ('authenticated')) r(rol)
                   WHERE f.prosecdef AND has_function_privilege(r.rol, f.oid, 'EXECUTE'))
UNION ALL SELECT 5, 'Todas las tablas de public con RLS activo (incluida administradores)',
                 (SELECT count(*) = 0 FROM rel WHERE relkind IN ('r', 'p') AND NOT relrowsecurity)
             AND (SELECT relrowsecurity FROM rel WHERE relname = 'administradores' AND relkind = 'r')
UNION ALL SELECT 6, 'v_asignaciones_completas con security_invoker (respeta permisos de quien consulta)',
                 (SELECT count(*) = 1 AND bool_and('security_invoker=true' = ANY (coalesce(reloptions, '{}')))
                    FROM rel WHERE relname = 'v_asignaciones_completas' AND relkind = 'v')
UNION ALL SELECT 7, 'Privilegios por defecto (postgres, public): objetos nuevos sin anon ni authenticated',
                 (SELECT count(*) = 0 FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace,
                         aclexplode(d.defaclacl) x
                   WHERE n.nspname = 'public' AND pg_get_userbyid(d.defaclrole) = 'postgres'
                     AND x.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated')))
UNION ALL SELECT 8, 'service_role conserva SELECT/INSERT/UPDATE en las tablas operativas del backend',
                 (SELECT count(*) = 6 AND bool_and(has_table_privilege('service_role', oid, 'SELECT')
                                               AND has_table_privilege('service_role', oid, 'INSERT')
                                               AND has_table_privilege('service_role', oid, 'UPDATE'))
                    FROM rel WHERE relkind = 'r' AND relname IN ('administradores', 'usuarios_pagados', 'rodeos',
                                                                  'asignaciones', 'notas_rodeo', 'evaluaciones'))
UNION ALL SELECT 9, 'service_role conserva EXECUTE en publicar_evaluacion y generar_codigo_usuario',
                 (SELECT count(*) = 2 AND bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE'))
                    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public' AND p.proname IN ('publicar_evaluacion', 'generar_codigo_usuario'))
UNION ALL SELECT 10, 'service_role tiene BYPASSRLS (el backend no depende de políticas RLS)',
                 (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role')
UNION ALL SELECT 11, 'Sin privilegios predeterminados GLOBALES que abran objetos futuros a la Data API (cualquier rol)',
                 (SELECT count(*) = 0 FROM pg_default_acl d, aclexplode(d.defaclacl) x
                   WHERE d.defaclnamespace = 0
                     AND (x.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated'))
                          OR (x.grantee = 0 AND d.defaclobjtype IN ('r', 'S'))))
UNION ALL SELECT 12, 'Ningún objeto de public pertenece a otro rol (los defaults de supabase_admin no han tenido efecto)',
                 (SELECT count(*) = 0 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) <> 'postgres')
             AND (SELECT count(*) = 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> 'postgres')
) c
ORDER BY orden;
