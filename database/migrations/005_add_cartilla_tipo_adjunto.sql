-- Migración 005: agregar 'cartilla' a los tipos de adjunto permitidos
ALTER TABLE rodeo_adjuntos DROP CONSTRAINT IF EXISTS rodeo_adjuntos_tipo_adjunto_check;
ALTER TABLE rodeo_adjuntos ADD CONSTRAINT rodeo_adjuntos_tipo_adjunto_check
    CHECK (tipo_adjunto IN ('cartilla', 'planilla', 'contrato', 'foto', 'otro'));
