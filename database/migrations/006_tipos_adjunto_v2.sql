-- Migración 006: expandir tipos de adjunto con clasificación semántica
-- Compatible hacia atrás: valores legacy siguen siendo válidos
ALTER TABLE rodeo_adjuntos DROP CONSTRAINT IF EXISTS rodeo_adjuntos_tipo_adjunto_check;
ALTER TABLE rodeo_adjuntos ADD CONSTRAINT rodeo_adjuntos_tipo_adjunto_check
    CHECK (tipo_adjunto IN (
        'cartilla_jurado',   -- nuevo
        'cartilla_delegado', -- nuevo
        'respaldo',          -- nuevo
        'cartilla',          -- legacy → equivale a cartilla_jurado
        'planilla',          -- legacy
        'contrato',          -- legacy
        'foto',              -- legacy
        'otro'               -- legacy
    ));
