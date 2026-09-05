-- ═════════════════════════════════════════════════════════════════════════
-- 046_club_ubicaciones.sql
-- Propuesta de Designación — comuna habitual del club (mejora del buscador)
--
-- ⚠️  PROPUESTA — NO APLICADA EN PRODUCCIÓN. Requiere autorización expresa
--     antes de ejecutarse. Preparada para revisión (SQL, constraints,
--     índices, impacto) únicamente.
--
-- Objetivo: evitar tener que volver a seleccionar la comuna de un mismo
-- club en cada temporada. Guarda una relación CLUB + ASOCIACIÓN → COMUNA
-- HABITUAL, usada solo como SUGERENCIA (nunca se aplica automáticamente).
-- La comuna definitiva que usa el motor sigue siendo rodeos.comuna_id —
-- esta tabla NO la reemplaza ni la sincroniza automáticamente.
--
-- Por qué CLUB + ASOCIACIÓN y no solo el club: evita que dos clubes
-- homónimos de asociaciones distintas (posible, no verificado exhaustivamente
-- pero real como riesgo) compartan una comuna incorrecta.
--
-- Aditiva y reversible. Sin DROP. Sin modificar rodeos ni usuarios_pagados.
-- No inserta ninguna fila — la tabla nace vacía; cada relación se crea
-- manualmente desde la pantalla, con confirmación del administrador.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS club_ubicaciones (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    club_nombre             TEXT        NOT NULL,
    club_nombre_normalizado TEXT        NOT NULL,
    asociacion              TEXT        NOT NULL,
    asociacion_normalizada  TEXT        NOT NULL,
    comuna_id               UUID        NOT NULL REFERENCES comunas_chile(id),
    confirmado_por          UUID        REFERENCES administradores(id),
    confirmado_en           TIMESTAMPTZ,
    activo                  BOOLEAN     NOT NULL DEFAULT true,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Única ubicación habitual por club+asociación (normalizados).
--
-- CORREGIDO en revisión final: la versión original de este archivo usaba un
-- índice PARCIAL (WHERE activo = true) pensando en conservar historial de
-- ubicaciones desactivadas. Se detectó que eso rompe el upsert: Postgres
-- solo usa un índice único como "arbiter" de ON CONFLICT (club_nombre_
-- normalizado, asociacion_normalizada) si el índice NO es parcial (o si el
-- INSERT especifica el mismo predicado WHERE, algo que el upsert de
-- PostgREST/Supabase-js no permite indicar). Con el índice parcial, guardar
-- una ubicación habitual por segunda vez para el mismo club+asociación
-- fallaba con "no unique or exclusion constraint matching the ON CONFLICT
-- specification" en vez de actualizar la fila existente.
--
-- Con un índice único NO parcial, cada club+asociación tiene como máximo
-- UNA fila en toda la tabla (se actualiza in-place, nunca se duplica). No
-- existe todavía ningún flujo que desactive una ubicación (activo se deja
-- por si se necesita en el futuro), así que esta simplificación no pierde
-- ninguna capacidad usada hoy.
CREATE UNIQUE INDEX IF NOT EXISTS idx_club_ubicaciones_club_asoc
    ON club_ubicaciones(club_nombre_normalizado, asociacion_normalizada);

CREATE INDEX IF NOT EXISTS idx_club_ubicaciones_comuna ON club_ubicaciones(comuna_id);

COMMIT;

-- ── Verificación sugerida post-aplicación (no destructiva) ─────────────────
-- SELECT count(*) FROM club_ubicaciones;                        -- esperado: 0 (nace vacía)
-- SELECT * FROM information_schema.columns WHERE table_name = 'club_ubicaciones';
