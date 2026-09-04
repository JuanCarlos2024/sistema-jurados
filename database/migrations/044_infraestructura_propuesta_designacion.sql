-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 044 — Infraestructura de datos para Propuesta de Designación (Etapa 2)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- CONTEXTO:
--   Preparación de datos para el futuro motor de propuesta automática de
--   designación de jurados (Etapa 3+). Esta migración NO crea el motor, NO
--   genera propuestas, NO toca el flujo de designación/publicación existente.
--
-- QUÉ HACE (todo aditivo, sin DROP, sin renombrar, sin NOT NULL sobre datos
-- históricos, sin tocar ninguna tabla/columna existente):
--   1. comunas_chile — catálogo de comunas con coordenadas de referencia.
--      Fuente: https://github.com/2x3-la/geo-chile (chile_with_regions.json,
--      licencia MIT, consultado 2026-09-04). 345 de 346 comunas oficiales
--      (falta 1, no identificada; la región Ñuble no aparece separada en la
--      fuente — sus comunas quedan agrupadas bajo "Bío Bío", como en el
--      dataset original). Los valores se cargan TAL CUAL vienen de la fuente,
--      sin editar. Se detectaron 2 filas con coordenadas fuera de rango
--      plausible para Chile (posible error de la fuente, no corregido aquí):
--        - Recoleta (Metropolitana): lat/lng aparentan estar intercambiados.
--        - Coltauco (O'Higgins): latitud sin signo negativo.
--      Ver informe final para detalle — requieren revisión manual antes de
--      confiar en esas 2 comunas específicas para cálculo de distancia.
--   2. temporadas — fuente única de verdad para el rango de fechas de cada
--      temporada deportiva (reemplaza fechas hardcodeadas dispersas). Se
--      siembra la temporada 2026-2027 con sus subperíodos Chica/Grande.
--   3. clasificaciones_designacion — las 6 clasificaciones oficiales para el
--      motor (Interclubes/Provincial/Interasociaciones/Zonal/Clasificatorio/
--      Nacional). Concepto DISTINTO de categorias_rodeo (Primera/Segunda/...),
--      que no se toca.
--   4. clasificacion_categoria_matriz — matriz elegibilidad+prioridad de
--      categoría de jurado (A/B/C) por clasificación. Editable con simples
--      UPDATE/INSERT, sin tocar código.
--   5. rodeos.comuna_id — FK nullable a comunas_chile. Rodeos existentes
--      quedan en NULL (no se infiere nada). rodeos.club y rodeos.asociacion
--      NO se modifican.
--   6. tipos_rodeo.clasificacion_designacion_id — FK nullable a
--      clasificaciones_designacion. Se autoclasifican solo los tipos cuyo
--      nombre coincide de forma inequívoca con una de las 6 palabras clave;
--      todo lo demás queda NULL ("sin clasificar") — ver informe final para
--      el detalle exacto de qué quedó clasificado y qué no.
--
-- NOTAS:
--   - Idempotente: todos los CREATE/ADD usan IF NOT EXISTS; los INSERT usan
--     ON CONFLICT DO NOTHING; los UPDATE de clasificación solo tocan filas con
--     clasificacion_designacion_id IS NULL (no sobrescribe si ya se corrió).
--   - Reversible: cada pieza puede revertirse con ALTER TABLE ... DROP COLUMN
--     y DROP TABLE de las tablas nuevas — no hay pérdida de datos existentes
--     porque nada de esto modifica columnas/tablas actuales.
--
-- APLICAR en Supabase SQL Editor o MCP apply_migration, previa autorización.
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Catálogo de comunas de Chile
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comunas_chile (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre              TEXT        NOT NULL,
    nombre_normalizado  TEXT        NOT NULL,
    region              TEXT,
    latitud             NUMERIC(10,7),
    longitud            NUMERIC(10,7),
    activo              BOOLEAN     NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_comunas_chile_normalizado ON comunas_chile(nombre_normalizado);
CREATE INDEX IF NOT EXISTS idx_comunas_chile_region ON comunas_chile(region);

-- 345 comunas (fuente: github.com/2x3-la/geo-chile, chile_with_regions.json)
INSERT INTO comunas_chile (nombre, nombre_normalizado, region, latitud, longitud) VALUES
('Santiago', 'santiago', 'Metropolitana', -33.45, -70.6666667),
('Cerro Navia', 'cerro navia', 'Metropolitana', -33.4166667, -70.7166667),
('El Bosque', 'el bosque', 'Metropolitana', -33.5666667, -70.7),
('Huechuraba', 'huechuraba', 'Metropolitana', -33.35, -70.6666667),
('La Cisterna', 'la cisterna', 'Metropolitana', -33.55, -70.6833333),
('La Granja', 'la granja', 'Metropolitana', -33.5833333, -70.5833333),
('La Reina', 'la reina', 'Metropolitana', -33.45, -70.55),
('Lo Barnechea', 'lo barnechea', 'Metropolitana', -33.35, -70.5166667),
('Lo Prado', 'lo prado', 'Metropolitana', -33.4333333, -70.7166667),
('Maipú', 'maipu', 'Metropolitana', -33.5166667, -70.7666667),
('Pedro Aguirre Cerda', 'pedro aguirre cerda', 'Metropolitana', -33.492455, -70.678086),
('Providencia', 'providencia', 'Metropolitana', -33.4333333, -70.6166667),
('Quilicura', 'quilicura', 'Metropolitana', -33.3666667, -70.75),
('Recoleta', 'recoleta', 'Metropolitana', -70.639192, -33.408148),
('San Joaquín', 'san joaquin', 'Metropolitana', -33.5, -70.6166667),
('San Ramón', 'san ramon', 'Metropolitana', -33.45, -70.5),
('Puente Alto', 'puente alto', 'Metropolitana', -33.6166667, -70.5833333),
('Padre Hurtado', 'padre hurtado', 'Metropolitana', -33.5666667, -70.8333333),
('El Monte', 'el monte', 'Metropolitana', -33.6833333, -71.0166667),
('San Pedro', 'san pedro', 'Metropolitana', -33.9, -71.4666667),
('Curacaví', 'curacavi', 'Metropolitana', -33.4, -71.15),
('Melipilla', 'melipilla', 'Metropolitana', -33.7, -71.2166667),
('Calera de Tango', 'calera de tango', 'Metropolitana', -33.65, -70.8166667),
('San Bernardo', 'san bernardo', 'Metropolitana', -33.6, -70.7166667),
('Lampa', 'lampa', 'Metropolitana', -33.2833333, -70.9),
('San José de Maipo', 'san jose de maipo', 'Metropolitana', -33.6333333, -70.3666667),
('Peñaflor', 'penaflor', 'Metropolitana', -33.6166667, -70.9166667),
('Isla de Maipo', 'isla de maipo', 'Metropolitana', -33.75, -70.9),
('Talagante', 'talagante', 'Metropolitana', -33.6666667, -70.9333333),
('María Pinto', 'maria pinto', 'Metropolitana', -33.5333333, -71.1333333),
('Paine', 'paine', 'Metropolitana', -33.8166667, -70.75),
('Buin', 'buin', 'Metropolitana', -33.7333333, -70.75),
('Tiltil', 'tiltil', 'Metropolitana', -33.0833333, -70.9333333),
('Colina', 'colina', 'Metropolitana', -33.2, -70.6833333),
('Pirque', 'pirque', 'Metropolitana', -33.6333333, -70.55),
('Vitacura', 'vitacura', 'Metropolitana', -33.4, -70.6),
('San Miguel', 'san miguel', 'Metropolitana', -33.5, -70.6666667),
('Renca', 'renca', 'Metropolitana', -33.4, -70.7333333),
('Quinta Normal', 'quinta normal', 'Metropolitana', -33.45, -70.7),
('Pudahuel', 'pudahuel', 'Metropolitana', -33.4333333, -70.7166667),
('Peñalolén', 'penalolen', 'Metropolitana', -33.4833333, -70.5333333),
('Ñuñoa', 'nunoa', 'Metropolitana', -33.4666667, -70.6),
('Macul', 'macul', 'Metropolitana', -33.5, -70.5666667),
('Lo Espejo', 'lo espejo', 'Metropolitana', -33.5333333, -70.7166667),
('Las Condes', 'las condes', 'Metropolitana', -33.4166667, -70.5833333),
('La Pintana', 'la pintana', 'Metropolitana', -33.5833333, -70.6166667),
('La Florida', 'la florida', 'Metropolitana', -33.55, -70.5666667),
('Independencia', 'independencia', 'Metropolitana', -33.421988, -70.654932),
('Estación Central', 'estacion central', 'Metropolitana', -33.463315, -70.702976),
('Conchalí', 'conchali', 'Metropolitana', -33.35, -70.6166667),
('Cerrillos', 'cerrillos', 'Metropolitana', -33.4833333, -70.7),
('Arica', 'arica', 'Arica y Parinacota', -18.475, -70.3144444),
('Camarones', 'camarones', 'Arica y Parinacota', -19.0166667, -69.8666667),
('Putre', 'putre', 'Arica y Parinacota', -18.1916667, -69.5977778),
('General Lagos', 'general lagos', 'Arica y Parinacota', -17.5666667, -69.5),
('Iquique', 'iquique', 'Tarapacá', -20.2166667, -70.1666667),
('Alto Hospicio', 'alto hospicio', 'Tarapacá', -20.25, -70.1166667),
('Pozo Almonte', 'pozo almonte', 'Tarapacá', -20.2666667, -69.7833333),
('Camiña', 'camina', 'Tarapacá', -19.3, -69.4166667),
('Colchane', 'colchane', 'Tarapacá', -19.2666667, -68.6166667),
('Huara', 'huara', 'Tarapacá', -19.9666667, -69.7666667),
('Pica', 'pica', 'Tarapacá', -20.5, -69.3333333),
('Antofagasta', 'antofagasta', 'Antofagasta', -23.6333333, -70.4),
('Mejillones', 'mejillones', 'Antofagasta', -23.1, -70.45),
('Sierra Gorda', 'sierra gorda', 'Antofagasta', -22.8833333, -69.3166667),
('Taltal', 'taltal', 'Antofagasta', -25.2833333, -69.7666667),
('Calama', 'calama', 'Antofagasta', -22.4666667, -68.9166667),
('Ollague', 'ollague', 'Antofagasta', -21.2166667, -68.2666667),
('San Pedro de Atacama', 'san pedro de atacama', 'Antofagasta', -22.9166667, -68.2166667),
('María Elena', 'maria elena', 'Antofagasta', -22.35, -69.6666667),
('Tocopilla', 'tocopilla', 'Antofagasta', -22.0666667, -70.2),
('Copiapó', 'copiapo', 'Atacama', -27.3666667, -70.3166667),
('Caldera', 'caldera', 'Atacama', -27.0666667, -70.8166667),
('Tierra Amarilla', 'tierra amarilla', 'Atacama', -27.4666667, -70.2666667),
('Chañaral', 'chanaral', 'Atacama', -26.3333333, -70.6),
('Diego de Almagro', 'diego de almagro', 'Atacama', -26.3666667, -70.05),
('Vallenar', 'vallenar', 'Atacama', -28.5666667, -70.75),
('Alto del Carmen', 'alto del carmen', 'Atacama', -28.9336111, -70.4622222),
('Freirina', 'freirina', 'Atacama', -28.5, -71.0666667),
('Huasco', 'huasco', 'Atacama', -28.45, -71.2166667),
('Río Hurtado', 'rio hurtado', 'Coquimbo', -30.2666667, -70.7),
('Monte Patria', 'monte patria', 'Coquimbo', -30.6833333, -70.9333333),
('Ovalle', 'ovalle', 'Coquimbo', -30.5833333, -71.2),
('Los Vilos', 'los vilos', 'Coquimbo', -31.9, -71.5166667),
('Illapel', 'illapel', 'Coquimbo', -31.6166667, -71.15),
('Paiguano', 'paiguano', 'Coquimbo', -30.0166667, -70.5166667),
('Andacollo', 'andacollo', 'Coquimbo', -30.2166667, -71.0833333),
('La Serena', 'la serena', 'Coquimbo', -29.9, -71.25),
('Punitaqui', 'punitaqui', 'Coquimbo', -30.9, -71.2666667),
('Combarbalá', 'combarbala', 'Coquimbo', -31.1666667, -71.05),
('Salamanca', 'salamanca', 'Coquimbo', -31.7666667, -70.9666667),
('Canela', 'canela', 'Coquimbo', -31.4, -71.45),
('Vicuña', 'vicuna', 'Coquimbo', -30.0166667, -70.7),
('La Higuera', 'la higuera', 'Coquimbo', -29.5, -71.2666667),
('Coquimbo', 'coquimbo', 'Coquimbo', -29.95, -71.3333333),
('Valparaíso', 'valparaiso', 'Valparaíso', -33.0458333, -71.6163889),
('Concón', 'concon', 'Valparaíso', -32.9166667, -71.5166667),
('Puchuncaví', 'puchuncavi', 'Valparaíso', -32.7333333, -71.4166667),
('Los Andes', 'los andes', 'Valparaíso', -32.8166667, -70.6166667),
('Viña del Mar', 'vina del mar', 'Valparaíso', -33.0333333, -71.5333333),
('Rinconada', 'rinconada', 'Valparaíso', -32.8333333, -70.7),
('La Ligua', 'la ligua', 'Valparaíso', -32.45, -71.2166667),
('Papudo', 'papudo', 'Valparaíso', -32.5166667, -71.45),
('Zapallar', 'zapallar', 'Valparaíso', -32.5333333, -71.4666667),
('Calera', 'calera', 'Valparaíso', -32.7833333, -71.2166667),
('San Antonio', 'san antonio', 'Valparaíso', -33.6, -71.6166667),
('Cartagena', 'cartagena', 'Valparaíso', -33.55, -71.6),
('El Tabo', 'el tabo', 'Valparaíso', -33.45, -71.6666667),
('San Felipe', 'san felipe', 'Valparaíso', -32.75, -70.7333333),
('Llaillay', 'llaillay', 'Valparaíso', -32.85, -70.9666667),
('La Cruz', 'la cruz', 'Valparaíso', -32.8166667, -71.2333333),
('Villa Alemana', 'villa alemana', 'Valparaíso', -33.05, -71.3666667),
('Limache', 'limache', 'Valparaíso', -32.9833333, -71.2833333),
('Putaendo', 'putaendo', 'Valparaíso', -32.6333333, -70.7333333),
('Olmué', 'olmue', 'Valparaíso', -33, -71.2),
('Quilpué', 'quilpue', 'Valparaíso', -33.05, -71.45),
('Santa María', 'santa maria', 'Valparaíso', -32.75, -70.6666667),
('Panquehue', 'panquehue', 'Valparaíso', -32.8, -70.8333333),
('Catemu', 'catemu', 'Valparaíso', -32.6333333, -71.0333333),
('Santo Domingo', 'santo domingo', 'Valparaíso', -33.6333333, -71.65),
('El Quisco', 'el quisco', 'Valparaíso', -33.4, -71.7),
('Algarrobo', 'algarrobo', 'Valparaíso', -33.3911111, -71.6927778),
('Nogales', 'nogales', 'Valparaíso', -32.7166667, -71.2333333),
('Hijuelas', 'hijuelas', 'Valparaíso', -32.8, -71.1666667),
('Quillota', 'quillota', 'Valparaíso', -32.8833333, -71.2666667),
('Petorca', 'petorca', 'Valparaíso', -32.25, -70.9333333),
('Cabildo', 'cabildo', 'Valparaíso', -32.4166667, -71.1333333),
('San Esteban', 'san esteban', 'Valparaíso', -32.8, -70.5833333),
('Calle Larga', 'calle larga', 'Valparaíso', -32.85, -70.6333333),
('Isla de Pascua', 'isla de pascua', 'Valparaíso', -27.0833333, -109.375),
('Quintero', 'quintero', 'Valparaíso', -32.7833333, -71.5333333),
('Juan Fernández', 'juan fernandez', 'Valparaíso', -33.6166667, -78.8666667),
('Casablanca', 'casablanca', 'Valparaíso', -33.3166667, -71.4166667),
('Rancagua', 'rancagua', 'O''Higgins', -34.1652778, -70.7397222),
('Coinco', 'coinco', 'O''Higgins', -34.2666667, -70.9666667),
('Doñihue', 'donihue', 'O''Higgins', -34.2333333, -70.9666667),
('Las Cabras', 'las cabras', 'O''Higgins', -34.3, -71.3166667),
('Malloa', 'malloa', 'O''Higgins', -34.45, -70.95),
('Olivar', 'olivar', 'O''Higgins', -34.21, -70.8175),
('San Vicente', 'san vicente', 'O''Higgins', -34.5, -71.1333333),
('Marchihue', 'marchihue', 'O''Higgins', -34.4, -71.6333333),
('Paredones', 'paredones', 'O''Higgins', -34.7833333, -71.1666667),
('Chépica', 'chepica', 'O''Higgins', -34.7333333, -71.2833333),
('Lolol', 'lolol', 'O''Higgins', -34.7286111, -71.6447222),
('Palmilla', 'palmilla', 'O''Higgins', -34.6, -71.3666667),
('Santa Cruz', 'santa cruz', 'O''Higgins', -34.6333333, -71.3666667),
('Placilla', 'placilla', 'O''Higgins', -34.6333333, -71.1166667),
('La Estrella', 'la estrella', 'O''Higgins', -34.2, -71.6666667),
('Rengo', 'rengo', 'O''Higgins', -34.4166667, -70.8666667),
('Pichidegua', 'pichidegua', 'O''Higgins', -34.35, -71.3),
('Pumanque', 'pumanque', 'O''Higgins', -34.6, -71.6666667),
('Peralillo', 'peralillo', 'O''Higgins', -34.4833333, -71.4833333),
('Nancagua', 'nancagua', 'O''Higgins', -34.6666667, -71.2166667),
('Chimbarongo', 'chimbarongo', 'O''Higgins', -34.7, -71.05),
('San Fernando', 'san fernando', 'O''Higgins', -34.5833333, -70.9666667),
('Navidad', 'navidad', 'O''Higgins', -33.9333333, -71.8333333),
('Litueche', 'litueche', 'O''Higgins', -34.1166667, -71.7333333),
('Pichilemu', 'pichilemu', 'O''Higgins', -34.3833333, -72),
('Requínoa', 'requinoa', 'O''Higgins', -34.2833333, -70.8333333),
('Quinta de Tilcoco', 'quinta de tilcoco', 'O''Higgins', -34.35, -70.9833333),
('Peumo', 'peumo', 'O''Higgins', -34.4, -71.1666667),
('Mostazal', 'mostazal', 'O''Higgins', -33.9833333, -70.7),
('Machalí', 'machali', 'O''Higgins', -34.1825, -70.6511111),
('Graneros', 'graneros', 'O''Higgins', -34.0647222, -70.7266667),
('Coltauco', 'coltauco', 'O''Higgins', 34.287229, -71.085723),
('Codegua', 'codegua', 'O''Higgins', -34.0333333, -70.6666667),
('Talca', 'talca', 'Maule', -35.4333333, -71.6666667),
('Curepto', 'curepto', 'Maule', -35.0833333, -72.0166667),
('Maule', 'maule', 'Maule', -35.5333333, -71.7),
('Pencahue', 'pencahue', 'Maule', -35.4, -71.8166667),
('San Clemente', 'san clemente', 'Maule', -35.55, -71.4833333),
('Cauquenes', 'cauquenes', 'Maule', -35.9666667, -72.35),
('Pelluhue', 'pelluhue', 'Maule', -35.8333333, -72.6333333),
('Hualañé', 'hualane', 'Maule', -34.9766667, -71.8047222),
('Molina', 'molina', 'Maule', -34.1166667, -71.2833333),
('Romeral', 'romeral', 'Maule', -34.9666667, -71.1333333),
('Teno', 'teno', 'Maule', -34.8666667, -71.1833333),
('Linares', 'linares', 'Maule', -35.85, -71.6),
('Longaví', 'longavi', 'Maule', -35.9666667, -71.6833333),
('Retiro', 'retiro', 'Maule', -36.05, -71.7666667),
('Villa Alegre', 'villa alegre', 'Maule', -35.6666667, -71.75),
('Constitución', 'constitucion', 'Maule', -35.3333333, -72.4166667),
('Empedrado', 'empedrado', 'Maule', -35.6, -72.2833333),
('Pelarco', 'pelarco', 'Maule', -35.3833333, -71.45),
('Río Claro', 'rio claro', 'Maule', -35.2833333, -71.2666667),
('San Rafael', 'san rafael', 'Maule', -35.3166667, -71.5333333),
('Curicó', 'curico', 'Maule', -34.9833333, -71.2333333),
('Chanco', 'chanco', 'Maule', -35.7333333, -72.5333333),
('Licantén', 'licanten', 'Maule', -34.9833333, -72),
('Rauco', 'rauco', 'Maule', -34.9333333, -71.3166667),
('Sagrada Familia', 'sagrada familia', 'Maule', -35, -71.3833333),
('Vichuquén', 'vichuquen', 'Maule', -34.8833333, -72),
('Colbún', 'colbun', 'Maule', -35.7, -71.4166667),
('Parral', 'parral', 'Maule', -36.15, -71.8333333),
('San Javier', 'san javier', 'Maule', -35.6, -71.75),
('Yerbas Buenas', 'yerbas buenas', 'Maule', -35.75, -71.5833333),
('Concepción', 'concepcion', 'Bío Bío', -36.8333333, -73.05),
('Chiguayante', 'chiguayante', 'Bío Bío', -36.9166667, -73.0166667),
('Hualqui', 'hualqui', 'Bío Bío', -36.9666667, -72.9333333),
('Penco', 'penco', 'Bío Bío', -36.7333333, -72.9833333),
('Santa Juana', 'santa juana', 'Bío Bío', -37.1666667, -72.9333333),
('Tomé', 'tome', 'Bío Bío', -36.6166667, -72.95),
('Lebu', 'lebu', 'Bío Bío', -37.6166667, -73.65),
('Cañete', 'canete', 'Bío Bío', -37.8, -73.3833333),
('Curanilahue', 'curanilahue', 'Bío Bío', -37.4666667, -73.35),
('Tirúa', 'tirua', 'Bío Bío', -38.3333333, -73.5),
('Antuco', 'antuco', 'Bío Bío', -37.3333333, -71.6833333),
('Laja', 'laja', 'Bío Bío', -37.2666667, -72.7),
('Nacimiento', 'nacimiento', 'Bío Bío', -37.5, -72.6666667),
('Quilaco', 'quilaco', 'Bío Bío', -37.6666667, -71.9833333),
('San Rosendo', 'san rosendo', 'Bío Bío', -37.2666667, -72.7166667),
('Tucapel', 'tucapel', 'Bío Bío', -37.2833333, -71.95),
('Alto Biobío', 'alto biobio', 'Bío Bío', -38.05, -71.3166667),
('Bulnes', 'bulnes', 'Bío Bío', -36.741987, -72.301429),
('Coelemu', 'coelemu', 'Bío Bío', -36.4833333, -72.7),
('Chillán Viejo', 'chillan viejo', 'Bío Bío', -36.6166667, -72.1333333),
('Ninhue', 'ninhue', 'Bío Bío', -36.4, -72.4),
('Pemuco', 'pemuco', 'Bío Bío', -36.9666667, -72.1),
('Portezuelo', 'portezuelo', 'Bío Bío', -36.5333333, -72.4333333),
('Quirihue', 'quirihue', 'Bío Bío', -36.2833333, -72.5333333),
('Treguaco', 'treguaco', 'Bío Bío', -36.4333333, -72.6666667),
('San Ignacio', 'san ignacio', 'Bío Bío', -36.8, -72.0333333),
('San Carlos', 'san carlos', 'Bío Bío', -36.4247222, -71.9580556),
('Yungay', 'yungay', 'Bío Bío', -37.1166667, -72.0166667),
('San Nicolás', 'san nicolas', 'Bío Bío', -36.5, -72.2166667),
('San Fabián', 'san fabian', 'Bío Bío', -36.55, -71.55),
('Ránquil', 'ranquil', 'Bío Bío', -36.65, -72.55),
('Quillón', 'quillon', 'Bío Bío', -36.7333333, -72.4666667),
('Pinto', 'pinto', 'Bío Bío', -36.7, -71.9),
('Ñiquén', 'niquen', 'Bío Bío', -36.3, -71.9),
('El Carmen', 'el carmen', 'Bío Bío', -36.899444, -72.032313),
('Coihueco', 'coihueco', 'Bío Bío', -36.6166667, -71.8333333),
('Cobquecura', 'cobquecura', 'Bío Bío', -36.1333333, -72.7833333),
('Chillán', 'chillan', 'Bío Bío', -36.6, -72.1166667),
('Yumbel', 'yumbel', 'Bío Bío', -37.1333333, -72.5333333),
('Santa Bárbara', 'santa barbara', 'Bío Bío', -37.6666667, -72.0166667),
('Quilleco', 'quilleco', 'Bío Bío', -37.4666667, -71.9666667),
('Negrete', 'negrete', 'Bío Bío', -37.5833333, -72.5166667),
('Mulchén', 'mulchen', 'Bío Bío', -37.7166667, -72.2333333),
('Cabrero', 'cabrero', 'Bío Bío', -37.0333333, -72.4),
('Los Angeles', 'los angeles', 'Bío Bío', -37.4666667, -72.35),
('Los Alamos', 'los alamos', 'Bío Bío', -37.6166667, -73.4666667),
('Contulmo', 'contulmo', 'Bío Bío', -38, -73.2333333),
('Arauco', 'arauco', 'Bío Bío', -37.25, -73.3166667),
('Hualpén', 'hualpen', 'Bío Bío', -36.7833333, -73.0833333),
('Talcahuano', 'talcahuano', 'Bío Bío', -36.7166667, -73.1166667),
('San Pedro de la Paz', 'san pedro de la paz', 'Bío Bío', -36.8333333, -73.1166667),
('Lota', 'lota', 'Bío Bío', -37.087073, -73.156056),
('Florida', 'florida', 'Bío Bío', -36.8166667, -72.6666667),
('Coronel', 'coronel', 'Bío Bío', -37.0166667, -73.1333333),
('Temuco', 'temuco', 'Araucanía', -38.75, -72.6666667),
('Cunco', 'cunco', 'Araucanía', -38.9166667, -72.0333333),
('Freire', 'freire', 'Araucanía', -38.95, -72.6333333),
('Gorbea', 'gorbea', 'Araucanía', -39.1, -72.6833333),
('Loncoche', 'loncoche', 'Araucanía', -39.3666667, -72.6333333),
('Nueva Imperial', 'nueva imperial', 'Araucanía', -38.7333333, -72.95),
('Perquenco', 'perquenco', 'Araucanía', -38.4166667, -72.3833333),
('Pucón', 'pucon', 'Araucanía', -39.2666667, -71.9666667),
('Teodoro Schmidt', 'teodoro schmidt', 'Araucanía', -38.9666667, -73.05),
('Vilcún', 'vilcun', 'Araucanía', -39.1183333, -72.3794444),
('Cholchol', 'cholchol', 'Araucanía', -38.6, -72.85),
('Collipulli', 'collipulli', 'Araucanía', -37.95, -72.4333333),
('Ercilla', 'ercilla', 'Araucanía', -38.05, -72.3833333),
('Los Sauces', 'los sauces', 'Araucanía', -37.9666667, -72.8333333),
('Purén', 'puren', 'Araucanía', -38.0166667, -73.0833333),
('Traiguén', 'traiguen', 'Araucanía', -38.25, -72.6833333),
('Carahue', 'carahue', 'Araucanía', -38.7, -73.1666667),
('Curarrehue', 'curarrehue', 'Araucanía', -39.35, -71.5833333),
('Galvarino', 'galvarino', 'Araucanía', -38.4, -72.7833333),
('Lautaro', 'lautaro', 'Araucanía', -38.5291667, -72.435),
('Padre Las Casas', 'padre las casas', 'Araucanía', -38.7666667, -72.6),
('Pitrufquén', 'pitrufquen', 'Araucanía', -38.9833333, -72.65),
('Toltén', 'tolten', 'Araucanía', -39.2166667, -73.2333333),
('Villarrica', 'villarrica', 'Araucanía', -39.2666667, -72.2166667),
('Angol', 'angol', 'Araucanía', -37.8, -72.7166667),
('Curacautín', 'curacautin', 'Araucanía', -38.4333333, -71.8833333),
('Lonquimay', 'lonquimay', 'Araucanía', -38.4333333, -71.2333333),
('Lumaco', 'lumaco', 'Araucanía', -38.15, -72.9166667),
('Renaico', 'renaico', 'Araucanía', -37.6666667, -72.5833333),
('Victoria', 'victoria', 'Araucanía', -38.2166667, -72.3333333),
('Saavedra', 'saavedra', 'Araucanía', -38.7833333, -73.4),
('Melipeuco', 'melipeuco', 'Araucanía', -38.85, -71.7),
('Valdivia', 'valdivia', 'Los Ríos', -39.8, -73.2333333),
('Corral', 'corral', 'Los Ríos', -39.8666667, -73.4333333),
('Lanco', 'lanco', 'Los Ríos', -39.4333333, -72.7666667),
('Los Lagos', 'los lagos', 'Los Ríos', -39.85, -72.8333333),
('Máfil', 'mafil', 'Los Ríos', -39.65, -72.95),
('Mariquina', 'mariquina', 'Los Ríos', -39.5166667, -72.9666667),
('Paillaco', 'paillaco', 'Los Ríos', -40.0666667, -72.8833333),
('Panguipulli', 'panguipulli', 'Los Ríos', -39.6333333, -72.3333333),
('La Unión', 'la union', 'Los Ríos', -40.2833333, -73.0833333),
('Futrono', 'futrono', 'Los Ríos', -40.1333333, -72.4),
('Lago Ranco', 'lago ranco', 'Los Ríos', -40.3166667, -72.5),
('Río Bueno', 'rio bueno', 'Los Ríos', -40.3166667, -72.9666667),
('Puerto Montt', 'puerto montt', 'Los Lagos', -41.4666667, -72.9333333),
('Cochamó', 'cochamo', 'Los Lagos', -41.5, -72.3166667),
('Frutillar', 'frutillar', 'Los Lagos', -41.1166667, -73.1),
('Puerto Varas', 'puerto varas', 'Los Lagos', -41.3166667, -72.9833333),
('Ancud', 'ancud', 'Los Lagos', -41.8666667, -73.8333333),
('Curaco de Vélez', 'curaco de velez', 'Los Lagos', -42.4333333, -73.5833333),
('Puqueldón', 'puqueldon', 'Los Lagos', -42.5833333, -73.6333333),
('Quellón', 'quellon', 'Los Lagos', -43.1, -73.6),
('Quinchao', 'quinchao', 'Los Lagos', -42.5333333, -73.4166667),
('Puerto Octay', 'puerto octay', 'Los Lagos', -40.9666667, -72.9),
('Puyehue', 'puyehue', 'Los Lagos', -40.6666667, -72.6166667),
('Hualaihué', 'hualaihue', 'Los Lagos', -42.0166667, -72.6833333),
('Chaitén', 'chaiten', 'Los Lagos', -42.9194444, -72.7088889),
('San Juan de la Costa', 'san juan de la costa', 'Los Lagos', -40.5166667, -73.4),
('Llanquihue', 'llanquihue', 'Los Lagos', -41.25, -73.0166667),
('Calbuco', 'calbuco', 'Los Lagos', -41.7666667, -73.1333333),
('Fresia', 'fresia', 'Los Lagos', -41.15, -73.45),
('Los Muermos', 'los muermos', 'Los Lagos', -41.4, -73.4833333),
('Maullín', 'maullin', 'Los Lagos', -41.6166667, -73.6),
('Castro', 'castro', 'Los Lagos', -42.4666667, -73.8),
('Queilén', 'queilen', 'Los Lagos', -42.8666667, -73.4666667),
('Quemchi', 'quemchi', 'Los Lagos', -42.1333333, -73.5166667),
('Osorno', 'osorno', 'Los Lagos', -40.5666667, -73.15),
('Purranque', 'purranque', 'Los Lagos', -40.9166667, -73.1666667),
('Río Negro', 'rio negro', 'Los Lagos', -40.7833333, -73.2333333),
('San Pablo', 'san pablo', 'Los Lagos', -40.4, -73.0166667),
('Futaleufú', 'futaleufu', 'Los Lagos', -43.1666667, -71.85),
('Palena', 'palena', 'Los Lagos', -43.6166667, -71.8),
('Dalcahue', 'dalcahue', 'Los Lagos', -42.3666667, -73.7),
('Chonchi', 'chonchi', 'Los Lagos', -42.6166667, -73.8166667),
('Coyhaique', 'coyhaique', 'Aysén', -45.5666667, -72.0666667),
('Aisén', 'aisen', 'Aysén', -45.4, -72.7),
('Guaitecas', 'guaitecas', 'Aysén', -43.8833333, -73.7333333),
('O''Higgins', 'o''higgins', 'Aysén', -48.4666667, -72.5666667),
('Chile Chico', 'chile chico', 'Aysén', -46.55, -71.7333333),
('Verde', 'verde', 'Aysén', -44.2333333, -71.8333333),
('Cisnes', 'cisnes', 'Aysén', -44.75, -72.7),
('Cochrane', 'cochrane', 'Aysén', -47.2666667, -72.55),
('Tortel', 'tortel', 'Aysén', -47.8333333, -73.5666667),
('Río Ibáñez', 'rio ibanez', 'Aysén', -46.3, -71.9333333),
('Punta Arenas', 'punta arenas', 'Magallanes', -53.1669444, -70.9336111),
('Río Verde', 'rio verde', 'Magallanes', -52.65, -71.4833333),
('Cabo de Hornos (Ex-Navarino)', 'cabo de hornos (ex navarino)', 'Magallanes', -54.9333333, -67.6166667),
('Porvenir', 'porvenir', 'Magallanes', -53.3, -70.3666667),
('Timaukel', 'timaukel', 'Magallanes', -53.6666667, -69.9),
('Torres del Paine', 'torres del paine', 'Magallanes', -51.2666667, -72.35),
('Natales', 'natales', 'Magallanes', -51.7333333, -72.5166667),
('Primavera', 'primavera', 'Magallanes', -52.7166667, -69.25),
('Antártica', 'antartica', 'Magallanes', -75, -71.5),
('San Gregorio', 'san gregorio', 'Magallanes', -52.3166667, -69.6833333),
('Laguna Blanca', 'laguna blanca', 'Magallanes', -52.25, -71.9166667)
ON CONFLICT (nombre_normalizado) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Temporada deportiva — fuente única de verdad
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS temporadas (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre          TEXT        NOT NULL,
    fecha_inicio    DATE        NOT NULL,
    fecha_fin       DATE        NOT NULL,
    chica_inicio    DATE,
    chica_fin       DATE,
    grande_inicio   DATE,
    grande_fin      DATE,
    activa          BOOLEAN     NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_temporadas_nombre ON temporadas(nombre);

INSERT INTO temporadas (nombre, fecha_inicio, fecha_fin, chica_inicio, chica_fin, grande_inicio, grande_fin, activa)
VALUES ('2026-2027', '2026-04-15', '2027-04-15', '2026-04-15', '2026-08-14', '2026-08-15', '2027-04-15', true)
ON CONFLICT (nombre) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Clasificaciones de designación (distinto de categorias_rodeo existente)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clasificaciones_designacion (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo      TEXT        NOT NULL,
    nombre      TEXT        NOT NULL,
    orden       INTEGER     NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clasificaciones_designacion_codigo ON clasificaciones_designacion(codigo);

INSERT INTO clasificaciones_designacion (codigo, nombre, orden) VALUES
    ('interclubes',      'Interclubes',       1),
    ('provincial',        'Provincial',        2),
    ('interasociaciones', 'Interasociaciones', 3),
    ('zonal',             'Zonal',             4),
    ('clasificatorio',    'Clasificatorio',    5),
    ('nacional',          'Nacional',          6)
ON CONFLICT (codigo) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Matriz elegibilidad + prioridad de categoría de jurado por clasificación
--    (única fuente de verdad — editable con INSERT/UPDATE, sin tocar código)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clasificacion_categoria_matriz (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    clasificacion_id      UUID        NOT NULL REFERENCES clasificaciones_designacion(id),
    categoria             TEXT        NOT NULL CHECK (categoria IN ('A','B','C')),
    elegible              BOOLEAN     NOT NULL DEFAULT true,
    prioridad             INTEGER     NOT NULL, -- 1 = prioridad principal, 2 = secundaria
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_matriz_clasificacion_categoria ON clasificacion_categoria_matriz(clasificacion_id, categoria);

INSERT INTO clasificacion_categoria_matriz (clasificacion_id, categoria, elegible, prioridad)
SELECT id, v.categoria, true, v.prioridad
FROM clasificaciones_designacion cd
JOIN (VALUES
    ('interclubes',      'B', 2),
    ('interclubes',      'C', 1),
    ('provincial',        'A', 2),
    ('provincial',        'B', 1),
    ('interasociaciones', 'A', 1),
    ('interasociaciones', 'B', 2),
    ('zonal',             'A', 1),
    ('zonal',             'B', 2),
    ('clasificatorio',    'A', 1),
    ('clasificatorio',    'B', 2),
    ('nacional',          'A', 1)
) AS v(codigo, categoria, prioridad) ON v.codigo = cd.codigo
ON CONFLICT (clasificacion_id, categoria) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Comuna del rodeo (FK nullable — sin backfill, sin tocar club/asociacion)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE rodeos
    ADD COLUMN IF NOT EXISTS comuna_id UUID REFERENCES comunas_chile(id);

CREATE INDEX IF NOT EXISTS idx_rodeos_comuna ON rodeos(comuna_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Clasificación de tipo de rodeo (FK nullable — sin tocar tipos_rodeo.nombre)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE tipos_rodeo
    ADD COLUMN IF NOT EXISTS clasificacion_designacion_id UUID REFERENCES clasificaciones_designacion(id);

CREATE INDEX IF NOT EXISTS idx_tipos_rodeo_clasificacion ON tipos_rodeo(clasificacion_designacion_id);

-- Autoclasificación SOLO de coincidencias inequívocas (nombre exacto). Todo lo
-- demás queda NULL ("sin clasificar") — ver informe final para el listado
-- completo de qué quedó clasificado y qué no, y por qué.
UPDATE tipos_rodeo SET clasificacion_designacion_id = (SELECT id FROM clasificaciones_designacion WHERE codigo = 'interclubes')
WHERE clasificacion_designacion_id IS NULL AND nombre IN (
    'Interclubes - Un Día', 'Interclubes 3 series', 'Interclubes 3 series Especial',
    'Interclubes Colindantes Series Libres', 'Interclubes Colindantes Series Sexo',
    'Interclubes Especial - Un Día', 'Interclubes Especial Series Libres',
    'Interclubes Especial Series Sexo', 'Interclubes Series Libres', 'Interclubes Series Sexo'
);

UPDATE tipos_rodeo SET clasificacion_designacion_id = (SELECT id FROM clasificaciones_designacion WHERE codigo = 'provincial')
WHERE clasificacion_designacion_id IS NULL AND nombre IN (
    'Provincial - Un Día', 'Provincial 3 series', 'Provincial 3 series Especial',
    'Provincial Colindante - Un día', 'Provincial Colindante Especial',
    'PROVINCIAL COLINDANTE ESPECIAL SERIES LIBRES', 'Provincial Colindante Especial Series Sexo',
    'Provincial Colindante Series Libres', 'PROVINCIAL COLINDANTE SERIES LIBRES',
    'Provincial Colindante Series Sexo', 'Provincial Especial - Un Día',
    'Provincial Especial Series Libres', 'Provincial Especial Series Sexo',
    'Provincial Series Libres', 'Provincial Series Sexo'
);

UPDATE tipos_rodeo SET clasificacion_designacion_id = (SELECT id FROM clasificaciones_designacion WHERE codigo = 'interasociaciones')
WHERE clasificacion_designacion_id IS NULL AND nombre IN (
    'Interasociaciones', 'Interasociaciones Especial',
    'Interasociaciones Especial Limitado a 25 Colleras',
    'Interasociaciones Limitado 25 colleras', 'Interasociaciones Ltdo Jinetes A'
);

UPDATE tipos_rodeo SET clasificacion_designacion_id = (SELECT id FROM clasificaciones_designacion WHERE codigo = 'zonal')
WHERE clasificacion_designacion_id IS NULL AND nombre IN ('Zonal');

UPDATE tipos_rodeo SET clasificacion_designacion_id = (SELECT id FROM clasificaciones_designacion WHERE codigo = 'clasificatorio')
WHERE clasificacion_designacion_id IS NULL AND nombre IN (
    'Clasificatorio Centro', 'Clasificatorio Norte', 'Clasificatorio Sur',
    'Clasificatorio Escolar Centro Norte', 'Clasificatorio Escolar Centro Sur'
);

UPDATE tipos_rodeo SET clasificacion_designacion_id = (SELECT id FROM clasificaciones_designacion WHERE codigo = 'nacional')
WHERE clasificacion_designacion_id IS NULL AND nombre IN (
    'Campeonato Nacional Rodeo', 'Rodeo Nacional Escolar', 'Rodeo Nacional Universitario'
);

-- Todo lo demás (1ra. con puntos, 4ta. Categoría, Final de Criadores, Libre,
-- Padre e Hijo, Para Criadores y variantes, 2do Clasificatorio..., Repechaje
-- Clasificatorio...) queda clasificacion_designacion_id = NULL a propósito.

COMMIT;
