-- Migración 027: Agregar rol 'director' al campo rol_evaluacion de administradores

ALTER TABLE administradores
    DROP CONSTRAINT IF EXISTS administradores_rol_evaluacion_check;

ALTER TABLE administradores
    ADD CONSTRAINT administradores_rol_evaluacion_check
    CHECK (rol_evaluacion IN ('analista', 'comision_tecnica', 'jefe_area', 'monitor', 'director'));

-- Roles disponibles:
--   NULL               → Administrador pleno (acceso total)
--   'analista'         → Analista de evaluación técnica
--   'comision_tecnica' → Comisión técnica
--   'jefe_area'        → Jefe de área deportiva
--   'monitor'          → Monitor (carga puntajes oficiales y comentario del rodeo)
--   'director'         → Director (solo lectura: reporte deportivo, cartillas, evaluaciones)
