-- ============================================================================
-- 058 — Marca estructural de datos de prueba (Informe de Gestión Deportiva)
-- ============================================================================
-- Migración aditiva e idempotente. NO modifica ni borra datos existentes:
-- todas las filas actuales quedan con es_prueba = false.
-- NO crea claves foráneas. NO modifica la migración 057.
--
-- Son dos conceptos independientes:
--   * usuarios_pagados.es_prueba: cuenta de pruebas internas.
--   * rodeos.es_prueba:           rodeo de pruebas internas.
-- Un rodeo NO es de prueba solo porque participó una cuenta de prueba, ni al revés.
-- ============================================================================

ALTER TABLE public.usuarios_pagados
    ADD COLUMN IF NOT EXISTS es_prueba BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.rodeos
    ADD COLUMN IF NOT EXISTS es_prueba BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.usuarios_pagados.es_prueba IS
    'Cuenta destinada a pruebas internas; debe excluirse de los análisis personales ejecutivos (rankings, promedios, disponibilidad, seguimiento) pero NO elimina automáticamente sus rodeos.';

COMMENT ON COLUMN public.rodeos.es_prueba IS
    'Rodeo utilizado para pruebas internas; debe excluirse de las estadísticas deportivas ejecutivas (Informe de Gestión) sin eliminar el registro.';
