const { calcularDistanciaKm, normalizarTexto, resolverComuna } = require('./geografia');

describe('calcularDistanciaKm (Haversine)', () => {
    test('distancia entre el mismo punto es 0', () => {
        expect(calcularDistanciaKm(-33.45, -70.6667, -33.45, -70.6667)).toBeCloseTo(0, 3);
    });

    test('Santiago → Valparaíso es aproximadamente 100 km (rango 90-115 km)', () => {
        // Santiago: -33.45, -70.6667 | Valparaíso: -33.0458, -71.6164
        const d = calcularDistanciaKm(-33.45, -70.6667, -33.0458, -71.6164);
        expect(d).toBeGreaterThan(90);
        expect(d).toBeLessThan(115);
    });

    test('Santiago → Arica es mayor a 1500 km (extremo norte)', () => {
        // Arica: -18.475, -70.3144
        const d = calcularDistanciaKm(-33.45, -70.6667, -18.475, -70.3144);
        expect(d).toBeGreaterThan(1500);
    });

    test('Santiago → Punta Arenas es mayor a 2000 km (extremo sur)', () => {
        // Punta Arenas: -53.1669, -70.9336
        const d = calcularDistanciaKm(-33.45, -70.6667, -53.1669, -70.9336);
        expect(d).toBeGreaterThan(2000);
    });

    test('es simétrica: distancia(A,B) === distancia(B,A)', () => {
        const ab = calcularDistanciaKm(-33.45, -70.6667, -36.6, -72.1167);
        const ba = calcularDistanciaKm(-36.6, -72.1167, -33.45, -70.6667);
        expect(ab).toBeCloseTo(ba, 6);
    });

    test('devuelve null si falta algún valor', () => {
        expect(calcularDistanciaKm(null, -70.6667, -33.0458, -71.6164)).toBeNull();
        expect(calcularDistanciaKm(-33.45, undefined, -33.0458, -71.6164)).toBeNull();
        expect(calcularDistanciaKm(-33.45, -70.6667, NaN, -71.6164)).toBeNull();
    });
});

describe('normalizarTexto', () => {
    test('quita tildes, mayúsculas y espacios duplicados', () => {
        expect(normalizarTexto('  MAIPÚ  ')).toBe('maipu');
        expect(normalizarTexto('Ñuñoa')).toBe('nunoa');
        expect(normalizarTexto('San   José   de Maipo')).toBe('san jose de maipo');
    });

    test('no fusiona nombres semánticamente distintos (normalización conservadora)', () => {
        // Estos casos NO deben transformarse a la misma cadena por ser
        // comunas/asociaciones distintas — solo se normaliza formato, no significado.
        expect(normalizarTexto('Maipo')).not.toBe(normalizarTexto('Maipo Norte'));
        expect(normalizarTexto('Llanquihue')).not.toBe(normalizarTexto('Lago Llanquihue'));
        expect(normalizarTexto('Bío-Bío')).not.toBe(normalizarTexto('Río Bío-Bío'));
    });

    test('valores vacíos o nulos devuelven cadena vacía', () => {
        expect(normalizarTexto('')).toBe('');
        expect(normalizarTexto(null)).toBe('');
        expect(normalizarTexto(undefined)).toBe('');
    });
});

describe('resolverComuna (mecanismo central: directa → alias → no resuelta)', () => {
    // Catálogo de prueba, con la misma forma que cargarCatalogoResolucionComunas()
    const catalogo = {
        comunas: [
            { id: 'c-san-vicente', nombre: 'San Vicente', nombre_normalizado: 'san vicente', region: "O'Higgins", latitud: -34.4333, longitud: -71.0833 },
            { id: 'c-mariquina', nombre: 'Mariquina', nombre_normalizado: 'mariquina', region: 'Los Ríos', latitud: -39.35, longitud: -72.9667 },
            { id: 'c-maipo-norte-inexistente', nombre: 'Maipú', nombre_normalizado: 'maipu', region: 'Metropolitana', latitud: -33.5167, longitud: -70.7667 }
        ],
        alias: [
            { alias_normalizado: 'san vicente de tagua tagua', comuna_id: 'c-san-vicente' },
            { alias_normalizado: 'san jose de la mariquina', comuna_id: 'c-mariquina' }
        ]
    };

    test('"San Vicente" resuelve DIRECTA contra comunas_chile', () => {
        const r = resolverComuna('San Vicente', catalogo);
        expect(r.resuelto).toBe(true);
        expect(r.origen).toBe('DIRECTA');
        expect(r.comuna_id).toBe('c-san-vicente');
        expect(r.nombre).toBe('San Vicente');
    });

    test('"San Vicente de Tagua Tagua" resuelve por ALIAS a San Vicente', () => {
        const r = resolverComuna('San Vicente de Tagua Tagua', catalogo);
        expect(r.resuelto).toBe(true);
        expect(r.origen).toBe('ALIAS');
        expect(r.comuna_id).toBe('c-san-vicente');
        expect(r.nombre).toBe('San Vicente');
    });

    test('"Mariquina" resuelve DIRECTA', () => {
        const r = resolverComuna('Mariquina', catalogo);
        expect(r.resuelto).toBe(true);
        expect(r.origen).toBe('DIRECTA');
        expect(r.comuna_id).toBe('c-mariquina');
    });

    test('"San José de la Mariquina" resuelve por ALIAS a Mariquina', () => {
        const r = resolverComuna('San José de la Mariquina', catalogo);
        expect(r.resuelto).toBe(true);
        expect(r.origen).toBe('ALIAS');
        expect(r.comuna_id).toBe('c-mariquina');
        expect(r.nombre).toBe('Mariquina');
    });

    test('texto inexistente (ni directa ni alias) no se resuelve', () => {
        const r = resolverComuna('Comuna Que No Existe En Ninguna Parte', catalogo);
        expect(r.resuelto).toBe(false);
        expect(r.origen).toBeNull();
    });

    test('NULL, undefined o vacío no se resuelven', () => {
        expect(resolverComuna(null, catalogo).resuelto).toBe(false);
        expect(resolverComuna(undefined, catalogo).resuelto).toBe(false);
        expect(resolverComuna('', catalogo).resuelto).toBe(false);
        expect(resolverComuna('   ', catalogo).resuelto).toBe(false);
    });

    test('no hace fuzzy matching ni coincidencia parcial (contains)', () => {
        // "San Vicente" es una subcadena de un texto más largo que no es un alias
        // registrado — no debe resolver por contains.
        const r = resolverComuna('San Vicente algo distinto que no es alias', catalogo);
        expect(r.resuelto).toBe(false);
    });

    test('devuelve latitud/longitud/region junto al comuna_id para uso futuro del motor', () => {
        const r = resolverComuna('Maipú', catalogo);
        expect(r.latitud).toBe(-33.5167);
        expect(r.longitud).toBe(-70.7667);
        expect(r.region).toBe('Metropolitana');
    });
});
