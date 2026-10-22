-- ═════════════════════════════════════════════════════════════════════════
-- 082_comision_promedio_simple.sql
-- Comisión de Asociación: fn_calcular_nota_individual_comision pasa de
-- ponderación fija (20/30/40/10 sin Movimiento a la Rienda, o 16/24/32/8/20
-- con Rienda) a PROMEDIO SIMPLE de los criterios puntuables — autorizado
-- explícitamente por el usuario. Todos los criterios pesan igual: 1/4 (25%
-- equivalente) sin Rienda, 1/5 (20% equivalente) con Rienda, calculado
-- DINÁMICAMENTE (suma / cantidad de criterios aplicables) en vez de
-- porcentajes hardcodeados — si en el futuro cambia la cantidad de
-- criterios puntuables, esta fórmula no requiere modificación.
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — preparada localmente, pendiente de
-- autorización explícita para ejecutarse.
--
-- AUDITORÍA PREVIA (confirmada antes de escribir esta migración): las
-- ponderaciones 20/30/40/10 eran REALES, no solo etiquetas visuales —
-- existían en TRES lugares: (1) este cuerpo de función en SQL (079/080,
-- fuente de verdad real, la que efectivamente calcula y ALMACENA
-- comision_evaluaciones_jurado.nota_individual_calculada al enviar/corregir
-- una evaluación); (2) frontend/institucional/comision/rodeos.html, una
-- COPIA del mismo cálculo usada solo como vista previa antes de enviar
-- (comentario explícito en el propio archivo: "la nota OFICIAL siempre la
-- recalcula el backend"); (3) backend/src/dev/institucionalDemo.js, una
-- tercera copia para el modo de demostración en memoria (npm run
-- dev:preview), que replica la misma fórmula para simular fielmente el
-- flujo real. Las tres se actualizan en este cambio para que ninguna quede
-- desincronizada; esta migración solo toca la fuente de verdad (1).
--
-- NO afecta evaluaciones ya guardadas: nota_individual_calculada se
-- CALCULA Y ALMACENA en el momento del envío/corrección
-- (enviar_evaluacion_comision_jurado_con_auditoria /
-- corregir_evaluacion_individual_comision_con_auditoria) — ningún camino de
-- LECTURA (listado de rodeos, Hoja de Vida, Evaluación de Desempeño
-- Jurados, consolidación de la Nota Comisión general) vuelve a invocar esta
-- función sobre un valor ya guardado: fn_recalcular_consolidacion_comision_
-- rodeo promedia la columna YA almacenada (avg(nota_individual_calculada)),
-- nunca recalcula desde los criterios crudos. Por lo tanto este cambio
-- afecta únicamente evaluaciones NUEVAS o CORREGIDAS a partir de su
-- aplicación — las ya enviadas conservan su nota_individual_calculada
-- histórica exactamente como quedó registrada, sin ningún UPDATE masivo.
--
-- Misma firma EXACTA que la función vigente desde 080 (los 4 criterios +
-- Rienda en NUMERIC(2,1), retorno NUMERIC(3,1)) — CREATE OR REPLACE SIN
-- DROP previo: al no cambiar la firma, Postgres conserva los GRANT/REVOKE/
-- ALTER...SET search_path ya aplicados en 080 (un DROP sí los limpiaría,
-- pero aquí no hace falta ninguno).
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION fn_calcular_nota_individual_comision(
    p_apinadero NUMERIC(2,1), p_cancha NUMERIC(2,1), p_atajadas NUMERIC(2,1), p_cuarta NUMERIC(2,1),
    p_hubo_rienda BOOLEAN, p_rienda NUMERIC(2,1)
) RETURNS NUMERIC(3,1) AS $$
DECLARE
    v_suma      NUMERIC;
    v_cantidad  INTEGER;
BEGIN
    -- "¿Hubo Movimiento a la Rienda?" es una condición Sí/No, nunca un
    -- criterio puntuable: solo decide si "Jura del Movimiento a la Rienda"
    -- se suma y cuenta como un criterio más (5 en vez de 4). Ningún otro
    -- campo no puntuable (afecto_resultado_final, comentario) llega a esta
    -- función — ver enviar_evaluacion_comision_jurado_con_auditoria, que
    -- nunca los pasa como parámetro.
    v_suma     := p_apinadero + p_cancha + p_atajadas + p_cuarta;
    v_cantidad := 4;
    IF p_hubo_rienda THEN
        v_suma     := v_suma + p_rienda;
        v_cantidad := 5;
    END IF;
    RETURN round((v_suma / v_cantidad)::numeric, 1);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION fn_calcular_nota_individual_comision IS
    'Comisión de Asociación (082): promedio simple de los criterios puntuables (Apiñadero, Cancha, Atajadas, Cuarta carrera y, si hubo Movimiento a la Rienda, Jura del Movimiento a la Rienda) — todos con el mismo peso (1/4 o 1/5), calculado dinámicamente sin porcentajes hardcodeados. Reemplaza la ponderación fija 20/30/40/10 (sin Rienda) o 16/24/32/8/20 (con Rienda) usada desde 079/080. Solo afecta evaluaciones nuevas o corregidas a partir de esta migración — las ya guardadas conservan su nota_individual_calculada histórica intacta.';

COMMIT;
