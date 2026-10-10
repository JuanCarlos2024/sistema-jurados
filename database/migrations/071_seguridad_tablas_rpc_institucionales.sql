-- ═════════════════════════════════════════════════════════════════════════
-- 071_seguridad_tablas_rpc_institucionales.sql
-- Fase 4.1 — Cierre de seguridad de las tablas y RPC institucionales.
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — pendiente de autorización.
-- Depende de 061/062/068 (tablas) y 066/067/069/070 (RPC, cadena de
-- CREATE OR REPLACE sobre las mismas 4 firmas).
--
-- HALLAZGO (auditoría Fase 4): las 3 tablas nuevas de este desarrollo
-- (cuentas_institucionales, delegados_asociacion, rodeos_delegado_
-- institucional) y las 4 funciones RPC institucionales NUNCA recibieron el
-- tratamiento de mínimo privilegio que este mismo proyecto YA aplica a otras
-- RPC sensibles desde las migraciones 038/039/041/042/050 (REVOKE de PUBLIC
-- + GRANT solo a service_role) y a otras tablas sensibles desde 047/049
-- (ENABLE ROW LEVEL SECURITY). Por el comportamiento DEFAULT de Postgres
-- (EXECUTE en funciones nuevas se otorga a PUBLIC salvo que se revoque
-- explícitamente; una tabla nueva puede heredar privilegios amplios de
-- "default privileges" configurados a nivel de proyecto), esto deja una
-- RUTA DE ACCESO DIRECTO vía PostgREST (POST /rpc/<nombre>, GET/POST
-- /<tabla>) que NUNCA pasa por Express — es decir, que NUNCA pasa por
-- soloCuentaInstitucional/soloAdmin ni por ninguna de las validaciones de
-- asociación/responsable/estado que viven en las rutas. Esta migración
-- cierra esa ruta, sin cambiar ninguna firma, ningún comportamiento
-- funcional ni ninguna validación existente dentro de las funciones.
--
-- POR QUÉ ESTO NO ROMPE AL BACKEND: el backend (config/supabase.js) usa
-- SIEMPRE la service_role key — ese rol en Supabase tiene el atributo
-- BYPASSRLS (ignora cualquier RLS, sin necesidad de políticas) y, tras esta
-- migración, además recibe el GRANT explícito que necesita. El backend
-- jamás usa anon/authenticated para nada — bloquearlos acá no afecta a
-- ninguna funcionalidad real hoy, solo cierra una puerta que nunca debió
-- estar abierta.
--
-- POR QUÉ NO SE TOCAN `cartillas_delegado` NI `auditoria`: son tablas
-- PREEXISTENTES (anteriores a este desarrollo, usadas también por el flujo
-- de Delegado Rentado) — el pedido explícito es "no modificar globalmente
-- permisos de tablas preexistentes ajenas a este desarrollo". Si se decide
-- más adelante aplicar el mismo criterio a esas dos tablas, debe ser una
-- decisión separada y explícita, con su propia migración.
--
-- SEARCH_PATH: ninguna de las 4 funciones usa SECURITY DEFINER (confirmado
-- por lectura de 066/067/069/070 — ninguna lo declara, por lo tanto son
-- SECURITY INVOKER, el valor por defecto). El riesgo clásico de
-- "search_path hijacking" aplica sobre todo a funciones SECURITY DEFINER;
-- aun así, se fija `search_path` explícito en las 4 como buena práctica
-- estándar adicional, sin cambiar ningún comportamiento (todas ya calificaban
-- sus pocas referencias a tablas sin necesitar otro esquema).
--
-- Idempotente: REVOKE/GRANT/ALTER FUNCTION ... SET son seguros de repetir.
-- Reversible: ver bloque al final.
-- ═════════════════════════════════════════════════════════════════════════

-- ─── Tablas nuevas: RLS + revocar acceso directo ───────────────────────────
-- RLS habilitado SIN ninguna política: por diseño de Postgres, cuando RLS
-- está activo y no existe ninguna política para un comando dado, NINGÚN rol
-- sin BYPASSRLS puede leer/escribir esa tabla — ni siquiera con un GRANT de
-- tabla válido. service_role (BYPASSRLS en Supabase) sigue funcionando
-- exactamente igual; anon/authenticated quedan en cero acceso real.
ALTER TABLE cuentas_institucionales ENABLE ROW LEVEL SECURITY;
ALTER TABLE delegados_asociacion ENABLE ROW LEVEL SECURITY;
ALTER TABLE rodeos_delegado_institucional ENABLE ROW LEVEL SECURITY;

-- Defensa en profundidad adicional (no depende solo de RLS): revoca
-- cualquier privilegio de tabla heredado por PUBLIC o otorgado
-- directamente a anon/authenticated (p.ej. vía "default privileges" del
-- proyecto), y otorga explícitamente a service_role lo que el backend
-- necesita.
REVOKE ALL ON TABLE cuentas_institucionales FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE delegados_asociacion FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE rodeos_delegado_institucional FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE cuentas_institucionales TO service_role;
GRANT ALL ON TABLE delegados_asociacion TO service_role;
GRANT ALL ON TABLE rodeos_delegado_institucional TO service_role;

-- ─── RPC institucionales: revocar PUBLIC, otorgar solo a service_role ──────
-- ESTA es la vulnerabilidad real que cierra esta migración: sin este
-- REVOKE, cualquier llamada con un JWT válido de PostgREST (incluso con el
-- rol anon) podía invocar estas 4 funciones DIRECTAMENTE vía
-- POST /rpc/<nombre>, saltándose por completo la autorización de Express
-- (verificado y demostrado en el ensayo aislado de esta misma fase).
REVOKE ALL ON FUNCTION confirmar_delegado_institucional_rodeo(UUID, UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reemplazar_delegado_institucional_rodeo(UUID, UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION crear_o_adjuntar_cartilla_institucional(UUID, UUID, TEXT, UUID, TEXT, DATE, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION actualizar_cartilla_institucional_con_auditoria(UUID, INT, JSONB, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION confirmar_delegado_institucional_rodeo(UUID, UUID, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION reemplazar_delegado_institucional_rodeo(UUID, UUID, TEXT, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION crear_o_adjuntar_cartilla_institucional(UUID, UUID, TEXT, UUID, TEXT, DATE, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION actualizar_cartilla_institucional_con_auditoria(UUID, INT, JSONB, UUID, TEXT, TEXT) TO service_role;

-- ─── search_path explícito (defensa en profundidad) ────────────────────────
ALTER FUNCTION confirmar_delegado_institucional_rodeo(UUID, UUID, TEXT, UUID) SET search_path = public, pg_temp;
ALTER FUNCTION reemplazar_delegado_institucional_rodeo(UUID, UUID, TEXT, UUID, TEXT) SET search_path = public, pg_temp;
ALTER FUNCTION crear_o_adjuntar_cartilla_institucional(UUID, UUID, TEXT, UUID, TEXT, DATE, TEXT) SET search_path = public, pg_temp;
ALTER FUNCTION actualizar_cartilla_institucional_con_auditoria(UUID, INT, JSONB, UUID, TEXT, TEXT) SET search_path = public, pg_temp;

-- Reversible:
--   ALTER TABLE cuentas_institucionales DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE delegados_asociacion DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE rodeos_delegado_institucional DISABLE ROW LEVEL SECURITY;
--   GRANT ALL ON TABLE cuentas_institucionales, delegados_asociacion, rodeos_delegado_institucional TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION confirmar_delegado_institucional_rodeo(UUID, UUID, TEXT, UUID) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION reemplazar_delegado_institucional_rodeo(UUID, UUID, TEXT, UUID, TEXT) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION crear_o_adjuntar_cartilla_institucional(UUID, UUID, TEXT, UUID, TEXT, DATE, TEXT) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION actualizar_cartilla_institucional_con_auditoria(UUID, INT, JSONB, UUID, TEXT, TEXT) TO PUBLIC;
--   (revertir el GRANT a PUBLIC recrearía la vulnerabilidad original — no se
--   recomienda, se documenta solo por completitud del procedimiento de
--   reversión).
