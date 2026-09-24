-- ═════════════════════════════════════════════════════════════════════════
-- 057 — Informe Ejecutivo de Gestión Deportiva: fundación de datos
--
-- ✅ APLICADA EN PRODUCCIÓN el 2026-09-24 (MCP Supabase apply_migration,
--    versión 20260924153401). Antes: precheck de solo lectura + dry-run
--    transaccional (bloque DO terminado en RAISE EXCEPTION ⇒ rollback total)
--    con pruebas de UNIQUE/CHECK/FK; después: postcheck (5 tablas, RLS activo,
--    22 índices, conteos de tablas previas idénticos). NO volver a ejecutarla.
--
-- Crea (todo aditivo; no altera datos existentes):
--   1. asociaciones                    catálogo maestro (universo para "asociaciones sin rodeos")
--   2. asociacion_alias                alias/variantes → asociación
--   3. historico_rodeos_temporada      histórico de rodeos por temporada (Excel 2025-2026)
--   4. historico_colleras_medicion     mediciones históricas de colleras completas
--   5. colleras_completas_snapshots    snapshots del dato en vivo (respaldo)
-- Y amplía el CHECK de importaciones.tipo (compatible: los valores actuales
-- 'rodeos' y 'control_gestion' se conservan).
--
-- Sin FK desde rodeos hacia asociaciones (se mantiene el texto libre actual).
-- RLS habilitado sin políticas: el backend usa la service key (la omite) y
-- estas tablas nuevas no quedan expuestas a la clave anon.
-- ═════════════════════════════════════════════════════════════════════════

-- ── 1. asociaciones ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS asociaciones (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre              TEXT NOT NULL,
    nombre_normalizado  TEXT NOT NULL,
    zona                TEXT,
    activa              BOOLEAN NOT NULL DEFAULT TRUE,
    es_especial         BOOLEAN NOT NULL DEFAULT FALSE,
    incluir_en_alertas  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_asociaciones_nombre_normalizado UNIQUE (nombre_normalizado),
    CONSTRAINT chk_asociaciones_nombre CHECK (btrim(nombre) <> '' AND btrim(nombre_normalizado) <> '')
);
COMMENT ON TABLE asociaciones IS 'Catálogo maestro de asociaciones (universo del análisis de actividad). nombre_normalizado = normalizarAsociacion().';
COMMENT ON COLUMN asociaciones.es_especial IS 'Entidad institucional (p. ej. Federación): no debe aparecer como "asociación sin rodeos".';

-- ── 2. asociacion_alias ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS asociacion_alias (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asociacion_id        UUID NOT NULL REFERENCES asociaciones(id) ON DELETE CASCADE,
    alias                TEXT NOT NULL,
    alias_normalizado    TEXT NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_asociacion_alias_normalizado UNIQUE (alias_normalizado),
    CONSTRAINT chk_asociacion_alias CHECK (btrim(alias) <> '' AND btrim(alias_normalizado) <> '')
);
CREATE INDEX IF NOT EXISTS idx_asociacion_alias_asociacion ON asociacion_alias (asociacion_id);

-- ── 3. historico_rodeos_temporada ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS historico_rodeos_temporada (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    temporada                TEXT NOT NULL,
    fecha_rodeo              DATE NOT NULL,
    club                     TEXT NOT NULL,
    club_normalizado         TEXT NOT NULL,
    asociacion               TEXT NOT NULL,
    asociacion_normalizada   TEXT NOT NULL,
    asociacion_id            UUID REFERENCES asociaciones(id) ON DELETE SET NULL,
    tipo_rodeo               TEXT NOT NULL,
    tipo_normalizado         TEXT NOT NULL,
    categoria                TEXT,
    fuente                   TEXT NOT NULL,
    importacion_id           UUID REFERENCES importaciones(id) ON DELETE SET NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_historico_rodeos_temporada CHECK (temporada ~ '^[0-9]{4}-[0-9]{4}$'),
    -- Clave de idempotencia: NO depende solo del nombre del club.
    CONSTRAINT uq_historico_rodeos_clave UNIQUE (temporada, fecha_rodeo, club_normalizado, asociacion_normalizada, tipo_normalizado)
);
CREATE INDEX IF NOT EXISTS idx_hist_rodeos_temporada   ON historico_rodeos_temporada (temporada);
CREATE INDEX IF NOT EXISTS idx_hist_rodeos_fecha       ON historico_rodeos_temporada (fecha_rodeo);
CREATE INDEX IF NOT EXISTS idx_hist_rodeos_asociacion  ON historico_rodeos_temporada (asociacion_normalizada);
CREATE INDEX IF NOT EXISTS idx_hist_rodeos_asoc_id     ON historico_rodeos_temporada (asociacion_id);
CREATE INDEX IF NOT EXISTS idx_hist_rodeos_categoria   ON historico_rodeos_temporada (categoria);
CREATE INDEX IF NOT EXISTS idx_hist_rodeos_tipo        ON historico_rodeos_temporada (tipo_normalizado);
CREATE INDEX IF NOT EXISTS idx_hist_rodeos_importacion ON historico_rodeos_temporada (importacion_id);

-- ── 4. historico_colleras_medicion ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS historico_colleras_medicion (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    temporada         TEXT NOT NULL,
    fecha_medicion    DATE NOT NULL,
    total_colleras    INTEGER NOT NULL CHECK (total_colleras >= 0),
    fuente            TEXT NOT NULL,
    importacion_id    UUID REFERENCES importaciones(id) ON DELETE SET NULL,
    observacion       TEXT,
    fecha_confirmada  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_hist_colleras_temporada CHECK (temporada ~ '^[0-9]{4}-[0-9]{4}$'),
    CONSTRAINT uq_hist_colleras_medicion UNIQUE (temporada, fecha_medicion)
);
COMMENT ON COLUMN historico_colleras_medicion.fecha_confirmada IS 'true solo si la fecha fue validada (o confirmada por una persona). El informe NUNCA usa mediciones con fecha no confirmada.';
CREATE INDEX IF NOT EXISTS idx_hist_colleras_temporada ON historico_colleras_medicion (temporada);
CREATE INDEX IF NOT EXISTS idx_hist_colleras_fecha     ON historico_colleras_medicion (fecha_medicion);
CREATE INDEX IF NOT EXISTS idx_hist_colleras_import    ON historico_colleras_medicion (importacion_id);

-- ── 5. colleras_completas_snapshots ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS colleras_completas_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fecha_snapshot  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    temporada       TEXT,
    total_colleras  INTEGER CHECK (total_colleras >= 0),
    fuente          TEXT NOT NULL,
    estado_fuente   TEXT NOT NULL CHECK (estado_fuente IN ('OK', 'ERROR')),
    detalle_error   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_snapshot_ok_con_total CHECK (estado_fuente <> 'OK' OR total_colleras IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_colleras_snapshots_fecha ON colleras_completas_snapshots (fecha_snapshot DESC);
CREATE INDEX IF NOT EXISTS idx_colleras_snapshots_ok    ON colleras_completas_snapshots (fecha_snapshot DESC) WHERE estado_fuente = 'OK';

-- ── 6. importaciones.tipo: valores adicionales (compatible) ──────────────
ALTER TABLE importaciones DROP CONSTRAINT IF EXISTS chk_importaciones_tipo;
ALTER TABLE importaciones ADD CONSTRAINT chk_importaciones_tipo
    CHECK (tipo IN ('rodeos', 'control_gestion', 'historico_rodeos', 'historico_colleras', 'catalogo_asociaciones'));

-- ── 7. RLS (sin políticas: solo service key) ─────────────────────────────
ALTER TABLE asociaciones                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE asociacion_alias              ENABLE ROW LEVEL SECURITY;
ALTER TABLE historico_rodeos_temporada    ENABLE ROW LEVEL SECURITY;
ALTER TABLE historico_colleras_medicion   ENABLE ROW LEVEL SECURITY;
ALTER TABLE colleras_completas_snapshots  ENABLE ROW LEVEL SECURITY;

-- ── Verificación sugerida tras aplicar (solo lectura) ────────────────────
-- SELECT count(*) FROM asociaciones;                    -- 0
-- SELECT count(*) FROM historico_rodeos_temporada;      -- 0
-- SELECT count(*) FROM historico_colleras_medicion;     -- 0
-- SELECT count(*) FROM colleras_completas_snapshots;    -- 0
-- SELECT tipo, count(*) FROM importaciones GROUP BY 1;  -- idéntico a antes
