-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 032 — Puntajes de análisis deportivo como TEXT
--
-- PROBLEMA: Los campos puntaje_oficial_* y puntaje_analista_* eran NUMERIC,
-- lo que impide guardar valores de desempate como "30+5".
--
-- SOLUCIÓN: Cambiarlos a TEXT para admitir enteros simples ("36") y puntajes
-- con desempate ("30+5"). Los valores existentes se convierten a texto
-- preservando su valor (36.00 → "36", NULL → NULL).
--
-- TABLAS AFECTADAS:
--   • datos_monitor_rodeo  — puntaje_oficial_1er / 2do / 3er
--   • evaluaciones         — puntaje_analista_1er / 2do / 3er
--                          — puntaje_oficial_1er / 2do / 3er  (legacy, para consistencia)
--
-- IDEMPOTENTE: NO. Ejecutar una sola vez en Supabase → SQL Editor.
-- Si ya se ejecutó, los ALTER fallarán con "cannot alter type" sin efecto destructivo.
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Helper: convierte NUMERIC a texto limpio (36.00 → '36', 36.5 → '36.5', NULL → NULL)
-- Se aplica inline en cada USING clause.

-- ─────────────────────────────────────────────────────────────────────────────
-- A. datos_monitor_rodeo — puntajes oficiales del monitor
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE datos_monitor_rodeo
    ALTER COLUMN puntaje_oficial_1er TYPE TEXT
        USING CASE
            WHEN puntaje_oficial_1er IS NULL THEN NULL
            WHEN puntaje_oficial_1er = TRUNC(puntaje_oficial_1er)
                THEN TRUNC(puntaje_oficial_1er)::BIGINT::TEXT
            ELSE puntaje_oficial_1er::TEXT
        END,
    ALTER COLUMN puntaje_oficial_2do TYPE TEXT
        USING CASE
            WHEN puntaje_oficial_2do IS NULL THEN NULL
            WHEN puntaje_oficial_2do = TRUNC(puntaje_oficial_2do)
                THEN TRUNC(puntaje_oficial_2do)::BIGINT::TEXT
            ELSE puntaje_oficial_2do::TEXT
        END,
    ALTER COLUMN puntaje_oficial_3er TYPE TEXT
        USING CASE
            WHEN puntaje_oficial_3er IS NULL THEN NULL
            WHEN puntaje_oficial_3er = TRUNC(puntaje_oficial_3er)
                THEN TRUNC(puntaje_oficial_3er)::BIGINT::TEXT
            ELSE puntaje_oficial_3er::TEXT
        END;

-- ─────────────────────────────────────────────────────────────────────────────
-- B. evaluaciones — puntajes revisados del analista
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE evaluaciones
    ALTER COLUMN puntaje_analista_1er TYPE TEXT
        USING CASE
            WHEN puntaje_analista_1er IS NULL THEN NULL
            WHEN puntaje_analista_1er = TRUNC(puntaje_analista_1er)
                THEN TRUNC(puntaje_analista_1er)::BIGINT::TEXT
            ELSE puntaje_analista_1er::TEXT
        END,
    ALTER COLUMN puntaje_analista_2do TYPE TEXT
        USING CASE
            WHEN puntaje_analista_2do IS NULL THEN NULL
            WHEN puntaje_analista_2do = TRUNC(puntaje_analista_2do)
                THEN TRUNC(puntaje_analista_2do)::BIGINT::TEXT
            ELSE puntaje_analista_2do::TEXT
        END,
    ALTER COLUMN puntaje_analista_3er TYPE TEXT
        USING CASE
            WHEN puntaje_analista_3er IS NULL THEN NULL
            WHEN puntaje_analista_3er = TRUNC(puntaje_analista_3er)
                THEN TRUNC(puntaje_analista_3er)::BIGINT::TEXT
            ELSE puntaje_analista_3er::TEXT
        END;

-- ─────────────────────────────────────────────────────────────────────────────
-- C. evaluaciones — puntajes oficiales legacy (desde migración 019, no activos)
--    Se convierten igual por consistencia de esquema.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE evaluaciones
    ALTER COLUMN puntaje_oficial_1er TYPE TEXT
        USING CASE
            WHEN puntaje_oficial_1er IS NULL THEN NULL
            WHEN puntaje_oficial_1er = TRUNC(puntaje_oficial_1er)
                THEN TRUNC(puntaje_oficial_1er)::BIGINT::TEXT
            ELSE puntaje_oficial_1er::TEXT
        END,
    ALTER COLUMN puntaje_oficial_2do TYPE TEXT
        USING CASE
            WHEN puntaje_oficial_2do IS NULL THEN NULL
            WHEN puntaje_oficial_2do = TRUNC(puntaje_oficial_2do)
                THEN TRUNC(puntaje_oficial_2do)::BIGINT::TEXT
            ELSE puntaje_oficial_2do::TEXT
        END,
    ALTER COLUMN puntaje_oficial_3er TYPE TEXT
        USING CASE
            WHEN puntaje_oficial_3er IS NULL THEN NULL
            WHEN puntaje_oficial_3er = TRUNC(puntaje_oficial_3er)
                THEN TRUNC(puntaje_oficial_3er)::BIGINT::TEXT
            ELSE puntaje_oficial_3er::TEXT
        END;

COMMIT;
