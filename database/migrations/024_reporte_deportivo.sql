-- Migración 024: Campos para reporte deportivo
-- Agrega columnas faltantes a evaluaciones (los puntajes oficiales/analista ya existen desde migración 019)

ALTER TABLE evaluaciones
    ADD COLUMN IF NOT EXISTS comentario_monitor              TEXT,
    ADD COLUMN IF NOT EXISTS resultados_alterados            BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS comentario_resultados_alterados TEXT;

-- anulada y motivo_anulacion ya existen desde migración 023
-- No se crea tabla nueva: puntaje_oficial_*/puntaje_analista_*/observacion_general ya están en evaluaciones (019)
-- rodeos.observacion se reutiliza como comentario_admin
-- cartillas_jurado.datos->>'observaciones_finales' se reutiliza como observación del jurado
