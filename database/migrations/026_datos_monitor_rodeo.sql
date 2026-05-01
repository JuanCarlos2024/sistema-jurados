-- Migración 026: Tabla datos_monitor_rodeo
-- Almacena puntajes oficiales y comentario del monitor por rodeo,
-- independiente de si existe evaluación técnica.

CREATE TABLE IF NOT EXISTS datos_monitor_rodeo (
    id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    rodeo_id            uuid NOT NULL UNIQUE REFERENCES rodeos(id) ON DELETE CASCADE,
    puntaje_oficial_1er numeric(10,2),
    puntaje_oficial_2do numeric(10,2),
    puntaje_oficial_3er numeric(10,2),
    comentario_monitor  text,
    updated_at          timestamptz DEFAULT now()
);

-- Migrar datos existentes desde evaluaciones (si los hay)
INSERT INTO datos_monitor_rodeo (
    rodeo_id, puntaje_oficial_1er, puntaje_oficial_2do,
    puntaje_oficial_3er, comentario_monitor, updated_at
)
SELECT
    e.rodeo_id,
    e.puntaje_oficial_1er,
    e.puntaje_oficial_2do,
    e.puntaje_oficial_3er,
    e.comentario_monitor,
    e.updated_at
FROM evaluaciones e
WHERE (
    e.puntaje_oficial_1er IS NOT NULL OR
    e.puntaje_oficial_2do IS NOT NULL OR
    e.puntaje_oficial_3er IS NOT NULL OR
    e.comentario_monitor  IS NOT NULL
)
  AND e.anulada = false
ON CONFLICT (rodeo_id) DO NOTHING;
