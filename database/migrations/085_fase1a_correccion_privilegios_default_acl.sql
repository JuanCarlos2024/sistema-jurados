-- ═════════════════════════════════════════════════════════════════════════
-- 085_fase1a_correccion_privilegios_default_acl.sql
-- Fase 1A — registro versionado de una corrección YA APLICADA directamente
-- en producción (jurados_2026) en una sesión anterior, inmediatamente
-- después de aplicar 083. Este archivo existe solo para que el repositorio
-- refleje el estado real de la base de datos — NO debe volver a ejecutarse
-- contra producción como parte de este despliegue (Fase 1B). El historial de
-- migraciones de Supabase ya la registra como aplicada (versión
-- 20261029160318, nombre "fase1a_correccion_privilegios_default_acl").
--
-- Es idempotente (solo REVOKE/GRANT) — volver a ejecutarla no tendría efecto
-- destructivo si alguna vez fuera necesario, pero no corresponde hacerlo
-- ahora: ya está aplicada.
--
-- CONTEXTO — hallazgo post-aplicación de 083: este proyecto tiene
-- ALTER DEFAULT PRIVILEGES configurado a nivel de esquema public que otorga
-- arwdDxtm (todos los privilegios de tabla) y EXECUTE (funciones) a
-- anon/authenticated/service_role en todo objeto nuevo, de forma automática
-- al crearlo — independiente de los GRANT/REVOKE explícitos del archivo de
-- migración. La migración 083 revocó correctamente PUBLIC/anon/authenticated
-- sobre las 2 tablas nuevas, pero nunca revocó los privilegios EXTRA que el
-- default ACL ya le había dado a service_role (UPDATE/DELETE incluidos) antes
-- de que el GRANT explícito (solo SELECT/INSERT) se ejecutara — un GRANT
-- nunca quita privilegios, solo los añade. Y sobre la función nueva, solo se
-- revocó de PUBLIC, no de anon/authenticated directamente (que tienen su
-- propio grant separado vía default ACL, no solo heredado de PUBLIC).
-- Verificado en vivo tras aplicar la 083: anon/authenticated tenían EXECUTE
-- sobre registrar_movimiento_designacion, y service_role tenía UPDATE/DELETE
-- sobre bitacora_designaciones. Esta corrección deja exactamente los
-- privilegios que la migración 083 pretendía desde un principio.
--
-- Mismo hallazgo que motivó la Decisión 14 de 084_reemplazo_jurado_
-- transaccional_con_bitacora.sql, corregida ahí ANTES de aplicar (nunca se
-- aplicó con el defecto).
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

REVOKE ALL ON TABLE bitacora_designaciones FROM anon, authenticated, service_role;
REVOKE ALL ON TABLE catalogo_motivos_designacion FROM anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE ON TABLE catalogo_motivos_designacion TO service_role;
GRANT SELECT, INSERT ON TABLE bitacora_designaciones TO service_role;

REVOKE ALL ON FUNCTION registrar_movimiento_designacion(
    TEXT, UUID, UUID, UUID, UUID, UUID, TEXT, UUID, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION registrar_movimiento_designacion(
    TEXT, UUID, UUID, UUID, UUID, UUID, TEXT, UUID, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, UUID
) TO service_role;

COMMIT;
