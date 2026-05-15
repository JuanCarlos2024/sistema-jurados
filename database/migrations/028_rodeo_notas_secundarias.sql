-- 028: tabla para notas secundarias por rodeo (Nota Comisión y Nota Delegado)
-- Separadas de notas_rodeo (nota de evaluación técnica).
-- Una fila por rodeo (rodeo_id UNIQUE).
-- Nota: rodeos.id es UUID, por lo tanto rodeo_id también es UUID.

CREATE TABLE IF NOT EXISTS rodeo_notas_secundarias (
    id              BIGSERIAL PRIMARY KEY,
    rodeo_id        UUID NOT NULL UNIQUE REFERENCES rodeos(id) ON DELETE CASCADE,
    nota_comision   NUMERIC(3,1),
    nota_delegado   NUMERIC(3,1),
    actualizado_por TEXT,
    actualizado_en  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rodeo_notas_secundarias
    ADD CONSTRAINT rns_nota_comision_rango
    CHECK (nota_comision IS NULL OR (nota_comision >= 1.0 AND nota_comision <= 7.0));

ALTER TABLE rodeo_notas_secundarias
    ADD CONSTRAINT rns_nota_delegado_rango
    CHECK (nota_delegado IS NULL OR (nota_delegado >= 1.0 AND nota_delegado <= 7.0));

CREATE INDEX IF NOT EXISTS idx_rns_rodeo_id ON rodeo_notas_secundarias(rodeo_id);
