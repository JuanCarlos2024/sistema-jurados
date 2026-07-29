-- Migración 042 — Restringir permisos de rpc_iniciar_intento
--
-- La función solo debe poder ser ejecutada por service_role.
-- Se revocan explícitamente permisos heredados o directos de PUBLIC,
-- anon y authenticated.
--
-- Idempotente: puede ejecutarse varias veces de forma segura.

BEGIN;

REVOKE ALL
ON FUNCTION public.rpc_iniciar_intento(
    UUID,
    TIMESTAMPTZ,
    INTEGER
)
FROM PUBLIC;

REVOKE ALL
ON FUNCTION public.rpc_iniciar_intento(
    UUID,
    TIMESTAMPTZ,
    INTEGER
)
FROM anon;

REVOKE ALL
ON FUNCTION public.rpc_iniciar_intento(
    UUID,
    TIMESTAMPTZ,
    INTEGER
)
FROM authenticated;

GRANT EXECUTE
ON FUNCTION public.rpc_iniciar_intento(
    UUID,
    TIMESTAMPTZ,
    INTEGER
)
TO service_role;

COMMIT;
