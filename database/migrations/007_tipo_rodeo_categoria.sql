-- Migración 007: asociar tipo de rodeo con categoría de rodeo
-- La categoría del tipo sirve como sugerencia al crear un rodeo nuevo.
-- No afecta rodeos existentes ni sus categorías ya asignadas.
ALTER TABLE tipos_rodeo
    ADD COLUMN IF NOT EXISTS categoria_rodeo_id UUID REFERENCES categorias_rodeo(id) ON DELETE SET NULL;

COMMENT ON COLUMN tipos_rodeo.categoria_rodeo_id IS
    'Categoría sugerida por defecto al seleccionar este tipo en un rodeo nuevo. No sobreescribe categorías ya asignadas.';
