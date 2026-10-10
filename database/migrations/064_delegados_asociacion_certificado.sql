-- ═════════════════════════════════════════════════════════════════════════
-- 064_delegados_asociacion_certificado.sql
-- Fase 2 del nuevo perfil "Delegado de Asociación": distingue explícitamente
-- "registrado" (existe la fila) de "certificado" (confirmado como apto para
-- aparecer en el selector del portal institucional) en `delegados_asociacion`.
--
-- Por qué una columna nueva y no reutilizar `activo`: `activo` ya tiene un
-- significado establecido en todo el esquema (soft-delete: "sigue existiendo
-- pero no debe usarse" — administradores.activo, usuarios_pagados.activo).
-- Asumir que `activo=true` por sí solo demuestra certificación mezclaría dos
-- preguntas distintas ("¿sigue vigente?" vs "¿fue confirmado como delegado
-- real de esa asociación?") — la Fase 2 pidió explícitamente no asumir eso.
--
-- Los 11 delegados de CUYO y los 8 de BÍO-BÍO (vía el alias propuesto en
-- 063) quedarán con certificado=true recién cuando se autorice la carga
-- real (fuera del alcance de esta fase) — esta migración solo agrega la
-- columna, NO carga ningún dato.
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — pendiente de autorización.
--
-- Migración ADITIVA: una sola columna nueva sobre una tabla que a su vez
-- todavía no fue aplicada (062_delegados_asociacion.sql, también pendiente).
-- Se agrega en un archivo separado (no se edita 062) para preservar íntegra
-- la Fase 1 ya entregada, tal como pidió el usuario explícitamente.
-- DEFAULT FALSE: ningún delegado se considera certificado hasta que se
-- confirme explícitamente — evita que una carga futura certifique por
-- omisión.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS.
-- Reversible: ALTER TABLE delegados_asociacion DROP COLUMN IF EXISTS certificado;
-- Orden de ejecución: después de 062 (misma tabla); independiente de 061/063.
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE delegados_asociacion
    ADD COLUMN IF NOT EXISTS certificado BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN delegados_asociacion.certificado IS
    'TRUE solo cuando el delegado fue confirmado explícitamente como habilitado para el selector institucional. Distinto de `activo` (soft-delete). DEFAULT FALSE: nunca se asume certificación por omisión.';
