-- ═════════════════════════════════════════════════════════════════════════
-- 045_correccion_catalogo_comunas.sql
-- ETAPA 2.1 — Corrección y cierre del catálogo de comunas
--
-- ⚠️  PROPUESTA — NO APLICADA EN PRODUCCIÓN. Requiere autorización expresa
--     antes de ejecutarse. Preparada para revisión únicamente.
--
-- Corrige 3 problemas identificados en comunas_chile (345 filas, cargadas en
-- la migración 044) y agrega un mecanismo de alias explícito y auditable
-- (solo para comunas, NO para asociaciones) para resolver, sin fuzzy
-- matching y sin tocar usuarios_pagados.comuna, dos variantes de nombre
-- detectadas en el diagnóstico de jurados.
--
--   1. Comuna faltante: Alhué (Región Metropolitana, Provincia de Melipilla).
--      Confirmado contra el listado oficial por región (fuente: Wikipedia /
--      SUBDERE — 346 comunas, RM = 52; el catálogo cargado tenía 51 en RM).
--      Coordenadas: ficha/infobox de es.wikipedia.org/wiki/Alhué.
--      No es una comuna de creación reciente (existe desde 1891) — la
--      omisión es del dataset fuente (2x3-la/geo-chile), no un problema de
--      normalización/importación propio: se insertó exactamente lo que
--      traía el JSON de origen, y el JSON de origen no incluía esta fila.
--
--   2. Recoleta: latitud y longitud estaban INTERCAMBIADAS en el dataset
--      fuente. Verificado contra es.wikipedia.org/wiki/Recoleta_(Chile)
--      (-33.4167, -70.65): los valores cargados (-70.6391920, -33.4081480)
--      coinciden en magnitud con los de Wikipedia pero en las columnas
--      opuestas. Detectado también por la validación automática de rango
--      (la longitud cargada, -33.4, cae fuera del rango de longitud
--      chilena continental).
--
--   3. Coltauco: a la latitud le faltaba el signo negativo (34.2872290 en
--      vez de -34.2872290). Verificado contra es.wikipedia.org/wiki/Coltauco
--      (-34.3, -71.1) — la longitud cargada coincide; el signo de la
--      latitud es el único error.
--
--   4. comunas_chile_alias — alias EXPLÍCITOS y auditables para 2 variantes
--      de nombre confirmadas contra SUBDERE (fuente oficial de división
--      administrativa de Chile):
--        "San Vicente de Tagua Tagua" → comuna administrativa "San Vicente"
--        "San José de la Mariquina"   → comuna administrativa "Mariquina"
--      No se usa similitud/fuzzy matching. No se modifica ningún dato de
--      usuarios_pagados. No se tocan asociaciones (BÍO-BÍO, LLANQUIHUE,
--      MAIPO y sus variantes NO se alían aquí ni en ningún otro lado).
--
-- Aditiva y reversible. Sin DROP. Sin renombrar columnas. Sin NOT NULL sobre
-- datos históricos.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- 1. Comuna faltante: Alhué
INSERT INTO comunas_chile (nombre, nombre_normalizado, region, latitud, longitud, activo)
VALUES ('Alhué', 'alhue', 'Metropolitana', -34.0333333, -71.1000000, true)
ON CONFLICT (nombre_normalizado) DO NOTHING;

-- 2. Recoleta: intercambiar latitud/longitud.
-- Guarda de seguridad: el UPDATE solo aplica si la fila sigue exactamente
-- con el valor erróneo detectado (evita corromper un dato ya corregido a
-- mano o distinto al diagnosticado).
UPDATE comunas_chile
SET latitud = longitud, longitud = latitud
WHERE nombre_normalizado = 'recoleta'
  AND latitud = -70.6391920 AND longitud = -33.4081480;

-- 3. Coltauco: corregir el signo de la latitud.
UPDATE comunas_chile
SET latitud = -34.2872290
WHERE nombre_normalizado = 'coltauco'
  AND latitud = 34.2872290;

-- 4. Alias explícitos y auditables de comuna (solo comunas, no asociaciones)
CREATE TABLE IF NOT EXISTS comunas_chile_alias (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    alias               TEXT        NOT NULL,
    alias_normalizado   TEXT        NOT NULL,
    comuna_id           UUID        NOT NULL REFERENCES comunas_chile(id),
    fuente              TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comunas_chile_alias_normalizado ON comunas_chile_alias(alias_normalizado);
CREATE INDEX IF NOT EXISTS idx_comunas_chile_alias_comuna ON comunas_chile_alias(comuna_id);

INSERT INTO comunas_chile_alias (alias, alias_normalizado, comuna_id, fuente)
SELECT 'San Vicente de Tagua Tagua', 'san vicente de tagua tagua', id,
       'SUBDERE — nombre de uso común de la comuna "San Vicente" (O''Higgins, Prov. Cachapoal)'
FROM comunas_chile WHERE nombre_normalizado = 'san vicente'
ON CONFLICT (alias_normalizado) DO NOTHING;

INSERT INTO comunas_chile_alias (alias, alias_normalizado, comuna_id, fuente)
SELECT 'San José de la Mariquina', 'san jose de la mariquina', id,
       'SUBDERE — nombre de la capital comunal, de uso común para la comuna "Mariquina" (Los Ríos, Prov. Valdivia)'
FROM comunas_chile WHERE nombre_normalizado = 'mariquina'
ON CONFLICT (alias_normalizado) DO NOTHING;

COMMIT;

-- ── Verificación sugerida post-aplicación (no destructiva) ─────────────────
-- SELECT count(*) FROM comunas_chile WHERE activo = true;                    -- esperado: 346
-- SELECT nombre, latitud, longitud FROM comunas_chile WHERE nombre IN ('Recoleta','Coltauco','Alhué');
-- SELECT alias, comuna_id FROM comunas_chile_alias;
