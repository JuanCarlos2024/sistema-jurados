-- Migración 090: Fundamento técnico visible para el jurado (alteración de resultado)
--
-- CONTEXTO (Portal del Jurado — "Mi historial de evaluaciones"):
-- El requerimiento pide mostrar al jurado el fundamento técnico real cuando
-- "evaluaciones.resultados_alterados = true", siempre que haya sido
-- "autorizado para consulta del jurado". El campo ya existente para esto,
-- evaluaciones.comentario_resultados_alterados, se confirmó (revisando
-- backend/src/routes/admin/evaluaciones.js PATCH /:id/datos-deportivos y
-- frontend/admin/evaluacion-detalle.html "Análisis deportivo") que es el
-- ANÁLISIS INTERNO DEL ANALISTA — redactado para la Comisión Técnica y los
-- reportes administrativos (Reporte Fin de Semana, columna "Com.
-- Alteración"), nunca revisado ni redactado pensando en que el propio
-- jurado evaluado lo lea. Mezclar ahí información pública y privada es
-- exactamente el riesgo que el requerimiento pidió evitar explícitamente:
-- no se expone comentario_resultados_alterados directamente al jurado.
--
-- Por eso se agrega un campo SEPARADO, de publicación explícita y manual,
-- que preserva comentario_resultados_alterados intacto como registro
-- interno:
--   - fundamento_jurado: texto redactado por el analista/jefe deportivo
--     específicamente para que el jurado lo lea (puede reutilizar texto de
--     comentario_resultados_alterados si el analista decide que ya es
--     apto, pero es una decisión consciente, nunca automática).
--   - fundamento_jurado_publicado: por defecto FALSE para todo registro,
--     incluidos los históricos — ningún comentario ya existente queda
--     expuesto retroactivamente solo por aplicar esta migración. Solo se
--     muestra al jurado cuando un administrador (analista/jefe/admin
--     pleno) lo marca true explícitamente desde "Análisis deportivo".
--
-- Nunca se toca comentario_resultados_alterados ni ninguna otra columna.

ALTER TABLE evaluaciones
    ADD COLUMN IF NOT EXISTS fundamento_jurado            TEXT,
    ADD COLUMN IF NOT EXISTS fundamento_jurado_publicado  BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN evaluaciones.fundamento_jurado IS
    'Fundamento técnico redactado para que el propio jurado lo lea cuando resultados_alterados=true. Independiente de comentario_resultados_alterados (análisis interno del analista, nunca expuesto al jurado).';
COMMENT ON COLUMN evaluaciones.fundamento_jurado_publicado IS
    'Control de publicación explícito y manual. Default false también para registros históricos: nada queda visible al jurado solo por existir esta columna.';
