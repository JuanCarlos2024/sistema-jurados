-- ═════════════════════════════════════════════════════════════════════════
-- Fase 4.1 — Verificaciones de SOLO LECTURA para ejecutar en el SQL Editor
-- de Supabase (producción). NINGUNA de estas consultas modifica nada:
-- ninguna usa ALTER/DROP/CREATE/INSERT/UPDATE/DELETE. Son solo SELECT
-- contra pg_catalog/information_schema.
--
-- Cópielas y ejecútelas una por una (o todas juntas); cada una devuelve su
-- propio resultado. Compárteme el resultado para incorporarlo al informe.
-- ═════════════════════════════════════════════════════════════════════════

-- 1) CHECK real de cartillas_delegado.estado — ¿incluye 'reenviada'?
SELECT conname, pg_get_constraintdef(oid) AS definicion
FROM pg_constraint
WHERE conrelid = 'public.cartillas_delegado'::regclass AND contype = 'c';

-- 2) CHECK real de auditoria.actor_tipo — ¿ya incluye 'cuenta_institucional'?
--    ¿La migración 069 eliminaría algún valor que no debería?
SELECT conname, pg_get_constraintdef(oid) AS definicion
FROM pg_constraint
WHERE conrelid = 'public.auditoria'::regclass AND contype = 'c';

-- 3) (contexto para 1 y 2) Todos los valores de actor_tipo/accion que YA
--    existen hoy en auditoria — para confirmar que la migración 069 nunca
--    eliminaría un tipo de actor en uso real.
SELECT DISTINCT actor_tipo FROM auditoria;

-- 4) ¿Existen hoy las 3 tablas institucionales? (deberían dar 0 filas si
--    ninguna migración 061/062/068 fue aplicada aún)
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('cuentas_institucionales', 'delegados_asociacion', 'rodeos_delegado_institucional');

-- 5) ¿Existen hoy las 4 funciones RPC institucionales? Útil para saber si
--    ya fueron aplicadas antes de ejecutar la 071.
SELECT proname, pg_get_function_identity_arguments(oid) AS firma,
       prosecdef AS es_security_definer,
       proconfig AS configuracion_actual -- acá aparecería search_path si ya estuviera fijado
FROM pg_proc
WHERE proname IN (
    'confirmar_delegado_institucional_rodeo',
    'reemplazar_delegado_institucional_rodeo',
    'crear_o_adjuntar_cartilla_institucional',
    'actualizar_cartilla_institucional_con_auditoria'
);

-- 6) Privilegios EXECUTE actuales sobre esas 4 funciones (si ya existen) —
--    para confirmar si PUBLIC/anon/authenticated ya tienen acceso directo
--    (la migración 071 lo cierra).
SELECT p.proname, r.rolname AS rol_con_privilegio, has_function_privilege(r.oid, p.oid, 'EXECUTE') AS puede_ejecutar
FROM pg_proc p
CROSS JOIN pg_roles r
WHERE p.proname IN (
    'confirmar_delegado_institucional_rodeo',
    'reemplazar_delegado_institucional_rodeo',
    'crear_o_adjuntar_cartilla_institucional',
    'actualizar_cartilla_institucional_con_auditoria'
)
AND r.rolname IN ('anon', 'authenticated', 'service_role', 'postgres')
ORDER BY p.proname, r.rolname;

-- 7) RLS y privilegios de tabla actuales sobre las 3 tablas institucionales
--    (si ya existen) — "rls_habilitado" debería ser true después de la 071.
SELECT c.relname AS tabla, c.relrowsecurity AS rls_habilitado, c.relforcerowsecurity AS rls_forzado_incluso_para_owner
FROM pg_class c
WHERE c.relname IN ('cuentas_institucionales', 'delegados_asociacion', 'rodeos_delegado_institucional');

SELECT table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('cuentas_institucionales', 'delegados_asociacion', 'rodeos_delegado_institucional')
  AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC')
ORDER BY table_name, grantee;

-- 8) (Referencial, mismo criterio que la pregunta 6/7 pero para confirmar
--    que NO se tocó nada de las tablas preexistentes cartillas_delegado y
--    auditoria — deben verse igual antes y después de aplicar la 071).
SELECT table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('cartillas_delegado', 'auditoria')
  AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC')
ORDER BY table_name, grantee;
