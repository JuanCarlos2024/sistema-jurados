-- ═════════════════════════════════════════════════════════════════════════
-- 049_gestion_temporadas_rodeos.sql
-- Gestión explícita de temporadas — Etapa 1: infraestructura + administración
--
-- ✅ APLICADA MANUALMENTE EN PRODUCCIÓN por el administrador del proyecto
--    (2026-09-06, vía MCP apply_migration, previa autorización explícita y
--    validación de solo lectura antes/después). Se conserva este archivo
--    únicamente para dejar el cambio versionado en el repositorio — NO debe
--    volver a ejecutarse (los ALTER/CREATE usan IF NOT EXISTS y el UPDATE
--    incluye una comprobación defensiva del estado previo, por lo que
--    reejecutarla sería inocua si ocurriera por error — el bloque DO
--    abortaría con RAISE EXCEPTION porque la fila ya no está en el estado
--    "ANTES" que verifica — pero de todos modos no corresponde correrla de
--    nuevo).
--
-- CONTEXTO:
-- Hoy el motor de Propuesta de Designación resuelve la "temporada" de un
-- rodeo únicamente por rango de fechas (rodeos.fecha vs temporadas.fecha_
-- inicio/fecha_fin de la fila con activa=true). Esta migración agrega la
-- infraestructura para que, en el futuro (Etapa 2, NO esta), cada rodeo
-- pueda tener una temporada asignada explícitamente. El motor de Propuesta
-- de Designación NO se modifica en esta migración ni en el código que la
-- acompaña — sigue funcionando exactamente igual que hoy, por fechas.
--
-- QUÉ HACE (todo aditivo; sin DROP de datos; sin renombrar columnas):
--   1. rodeos.temporada_id — FK nullable a temporadas(id). Los 168 rodeos
--      activos existentes a la fecha de este análisis quedan en NULL: no
--      hay backfill automático, ni por fecha ni de ningún otro tipo. Esto
--      es responsabilidad manual del administrador (asignación individual
--      o por lote, ver capa de aplicación).
--   2. idx_rodeos_temporada_id — índice sobre la FK nueva, para que los
--      filtros/contadores de la administración no requieran table scan.
--   3. chk_temporadas_rango_fechas — CHECK (fecha_fin > fecha_inicio) sobre
--      temporadas. La única fila existente hoy (2026-2027) ya lo cumple
--      antes y después del UPDATE de este archivo.
--   4. idx_temporadas_una_activa — índice único parcial sobre
--      temporadas(activa) WHERE activa = true: impide a nivel de base de
--      datos que existan dos temporadas con activa=true simultáneamente.
--      Verificado antes de escribir esta migración (SELECT count(*) FROM
--      temporadas WHERE activa = true → 1 fila) — el índice se puede crear
--      sin conflicto.
--   5. RLS en temporadas — se habilita ROW LEVEL SECURITY sin crear ninguna
--      política. Efecto: cualquier acceso con las claves anon/authenticated
--      queda denegado por defecto (deny-all); el backend administrativo usa
--      exclusivamente la service_role key, que ignora RLS por diseño de
--      Supabase, así que el backend sigue funcionando sin cambios. Se
--      verificó (grep sobre frontend/) que ningún archivo del frontend usa
--      supabase-js ni una anon key directamente — todo el frontend consume
--      exclusivamente la API propia del backend — por lo que no hay ningún
--      consumidor existente que se vea afectado por este cambio.
--   6. UPDATE DEFENSIVO de fechas de la temporada 2026-2027 (autorizado
--      explícitamente por el administrador del proyecto). Antes de tocar la
--      fila, comprueba que exista EXACTAMENTE UNA fila "2026-2027" con el
--      estado ANTERIOR exacto esperado (fecha_inicio, fecha_fin, chica_*,
--      grande_*); si no coincide (fue editada manualmente, ya se corrió
--      antes, no existe, o hay más de una), ABORTA toda la migración con
--      RAISE EXCEPTION — nunca sobrescribe una fila en un estado
--      desconocido. También verifica que el UPDATE afecte exactamente 1
--      fila (GET DIAGNOSTICS ROW_COUNT):
--        ANTES:  fecha_inicio = 2026-04-15   fecha_fin = 2027-04-15
--        DESPUÉS: fecha_inicio = 2026-04-01   fecha_fin = 2027-03-31
--      Los subperíodos Chica/Grande se tratan así (también autorizado
--      explícitamente):
--        chica_inicio / chica_fin  → SIN CAMBIOS (2026-04-15 / 2026-08-14)
--        grande_inicio             → SIN CAMBIOS (2026-08-15)
--        grande_fin                → 2027-04-15 pasa a 2027-03-31, para que
--                                     no quede fuera del nuevo rango de la
--                                     temporada principal.
--      Efecto aceptado explícitamente: los rodeos con fecha entre el
--      01/04/2026 y el 14/04/2026 (16 rodeos activos a la fecha de este
--      análisis) quedan DENTRO de la temporada deportiva 2026-2027, pero
--      FUERA de los subperíodos Chica/Grande (ninguno de los dos los
--      cubre). Esto es intencional y fue confirmado por el administrador:
--      no se usa Chica/Grande para excluir esos rodeos del conteo de
--      temporada, que sigue siendo fecha_inicio/fecha_fin de la temporada
--      principal.
--
-- QUÉ NO HACE (deliberadamente, por instrucción explícita):
--   - NO agrega la columna temporadas.estado. activa BOOLEAN sigue siendo
--     la única fuente de verdad persistida; la UI deriva "ACTIVA" de
--     activa=true sin nueva columna.
--   - NO hace backfill de rodeos.temporada_id.
--   - NO agrega asignaciones.temporada_id (la relación futura es
--     Asignación → Rodeo → Temporada, sin duplicar el dato).
--   - NO modifica motorPropuestaDesignacion.js ni ninguna lógica del motor.
--   - NO modifica Hoja de Vida, reportes, equidad, bonos, pagos, cartillas
--     ni Evaluación Técnica.
--
-- Reversible: los índices y el CHECK pueden eliminarse con DROP INDEX/DROP
-- CONSTRAINT sin pérdida de datos; rodeos.temporada_id puede eliminarse con
-- DROP COLUMN (todas las filas están en NULL salvo las que el administrador
-- haya clasificado manualmente después de aplicar esta migración); el
-- UPDATE de fechas puede revertirse manualmente a los valores "ANTES"
-- documentados arriba si fuera necesario.
--
-- Ya aplicada (ver nota al inicio del archivo). Este commit solo versiona el
-- archivo — no vuelve a ejecutarla.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. rodeos.temporada_id — FK nullable, sin backfill
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE rodeos
    ADD COLUMN IF NOT EXISTS temporada_id UUID REFERENCES temporadas(id);

CREATE INDEX IF NOT EXISTS idx_rodeos_temporada_id ON rodeos(temporada_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. temporadas — CHECK de rango de fechas válido
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE temporadas DROP CONSTRAINT IF EXISTS chk_temporadas_rango_fechas;
ALTER TABLE temporadas
    ADD CONSTRAINT chk_temporadas_rango_fechas CHECK (fecha_fin > fecha_inicio);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. temporadas — a lo sumo una fila con activa = true
-- ─────────────────────────────────────────────────────────────────────────
-- Verificado antes de escribir esta migración: SELECT count(*) FROM
-- temporadas WHERE activa = true devuelve 1 (la fila 2026-2027). El índice
-- se crea sin conflicto sobre el estado actual de la tabla.
CREATE UNIQUE INDEX IF NOT EXISTS idx_temporadas_una_activa
    ON temporadas(activa) WHERE activa = true;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. temporadas — habilitar RLS (sin políticas: deny-all para anon/
--    authenticated; el backend usa service_role, que ignora RLS)
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE temporadas ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Cambio de fechas de la temporada 2026-2027 (autorizado explícitamente)
--    — DEFENSIVO: comprueba el estado ANTERIOR exacto esperado antes de
--    tocar la fila, y que exista exactamente una. Si algo no calza (la fila
--    fue editada manualmente entre el análisis y la aplicación de esta
--    migración, o ya fue corrida antes, o no existe, o hay más de una),
--    ABORTA toda la migración (RAISE EXCEPTION dentro de una transacción
--    hace ROLLBACK automático de TODO lo anterior en este archivo, incluidos
--    los cambios de esquema) en vez de sobrescribir un estado desconocido.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    filas_con_estado_esperado INTEGER;
    filas_actualizadas        INTEGER;
BEGIN
    SELECT count(*) INTO filas_con_estado_esperado
    FROM temporadas
    WHERE nombre        = '2026-2027'
      AND fecha_inicio  = '2026-04-15'
      AND fecha_fin     = '2027-04-15'
      AND chica_inicio  = '2026-04-15'
      AND chica_fin     = '2026-08-14'
      AND grande_inicio = '2026-08-15'
      AND grande_fin    = '2027-04-15';

    IF filas_con_estado_esperado <> 1 THEN
        RAISE EXCEPTION
            'Migración 049 abortada: se esperaba encontrar exactamente 1 fila "2026-2027" con el estado conocido (fecha_inicio=2026-04-15, fecha_fin=2027-04-15, chica_inicio=2026-04-15, chica_fin=2026-08-14, grande_inicio=2026-08-15, grande_fin=2027-04-15) y se encontraron %. La fila pudo haber sido editada, ya migrada, duplicada o eliminada — revise manualmente antes de reintentar. No se aplicó ningún cambio de esta migración.',
            filas_con_estado_esperado;
    END IF;

    UPDATE temporadas
    SET fecha_inicio  = '2026-04-01',
        fecha_fin     = '2027-03-31',
        grande_inicio = '2026-08-15',
        grande_fin    = '2027-03-31'
        -- chica_inicio / chica_fin: SIN CAMBIOS, a propósito.
    WHERE nombre = '2026-2027';

    GET DIAGNOSTICS filas_actualizadas = ROW_COUNT;
    IF filas_actualizadas <> 1 THEN
        RAISE EXCEPTION 'Migración 049 abortada: se esperaba actualizar exactamente 1 fila "2026-2027", se actualizaron %. Revise manualmente — no continúe.', filas_actualizadas;
    END IF;
END $$;

COMMIT;

-- ── Verificación sugerida post-aplicación (no destructiva) ─────────────────
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'rodeos' AND column_name = 'temporada_id';
--   -- debe existir, nullable.
--
-- SELECT count(*) FROM rodeos WHERE temporada_id IS NOT NULL;
--   -- debe ser 0 inmediatamente después de aplicar (sin backfill).
--
-- SELECT indexname FROM pg_indexes
--   WHERE tablename = 'temporadas' AND indexname = 'idx_temporadas_una_activa';
--
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'temporadas'::regclass
--   AND conname = 'chk_temporadas_rango_fechas';
--
-- SELECT relrowsecurity FROM pg_class WHERE relname = 'temporadas';
--   -- debe ser true.
--
-- SELECT nombre, fecha_inicio, fecha_fin, chica_inicio, chica_fin,
--        grande_inicio, grande_fin, activa
--   FROM temporadas WHERE nombre = '2026-2027';
--   -- fecha_inicio=2026-04-01, fecha_fin=2027-03-31, chica sin cambios,
--   -- grande_inicio=2026-08-15, grande_fin=2027-03-31.
