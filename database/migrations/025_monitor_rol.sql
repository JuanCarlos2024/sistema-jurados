-- Migración 025: Agregar rol 'monitor' al campo rol_evaluacion de administradores
-- El monitor puede cargar puntajes oficiales y comentario del rodeo desde el panel admin.

-- 1. Eliminar constraint existente (solo contiene analista, comision_tecnica, jefe_area)
ALTER TABLE administradores
    DROP CONSTRAINT IF EXISTS administradores_rol_evaluacion_check;

-- 2. Agregar constraint actualizado con los 4 roles + monitor
ALTER TABLE administradores
    ADD CONSTRAINT administradores_rol_evaluacion_check
    CHECK (rol_evaluacion IN ('analista', 'comision_tecnica', 'jefe_area', 'monitor'));

-- 3. Asegurar que los registros existentes sin rol queden como NULL (admin pleno)
--    (No modifica nada si ya están bien, es solo preventivo)
UPDATE administradores
    SET rol_evaluacion = NULL
    WHERE rol_evaluacion IS NOT NULL
      AND rol_evaluacion NOT IN ('analista', 'comision_tecnica', 'jefe_area', 'monitor');

-- Roles disponibles:
--   NULL              → Administrador pleno (acceso total)
--   'analista'        → Analista de evaluación técnica
--   'comision_tecnica'→ Comisión técnica (resuelve casos derivados)
--   'jefe_area'       → Jefe de área deportiva (aprueba/devuelve evaluaciones)
--   'monitor'         → Monitor (carga puntajes oficiales y comentario del rodeo)
