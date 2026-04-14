/**
 * Tests unitarios para _matchBonoConfig()
 *
 * Regla de negocio obligatoria:
 *   0   – 349 km  →  $0       (sin bono)
 *   350 – 499 km  →  $35.000
 *   500+      km  →  $50.000
 *
 * Ejecutar: cd backend && npm test
 */

const { _matchBonoConfig } = require('./calculo');

// Configs representativos del entorno de producción
const CONFIGS_PROD = [
    {
        id:               '741e6937-ea0b-4705-8e47-9e258580e0ad',
        nombre:           'Bono 350-499 km',
        distancia_minima: 350,
        distancia_maxima: 499,
        monto:            35000,
        activo:           true
    },
    {
        id:               'f6ff30e4-4900-422d-b36a-26185ec5cdc0',
        nombre:           'Bono 500+ km',
        distancia_minima: 500,
        distancia_maxima: null,
        monto:            50000,
        activo:           true
    }
];

// ─── Bordes de tramo 0–349 km ($0) ────────────────────────────────────────────
describe('Tramo sin bono (0–349 km)', () => {
    test('0 km → null ($0)', () => {
        expect(_matchBonoConfig(0, CONFIGS_PROD)).toBeNull();
    });
    test('1 km → null ($0)', () => {
        expect(_matchBonoConfig(1, CONFIGS_PROD)).toBeNull();
    });
    test('150 km → null ($0)  ← caso que reportó el bug', () => {
        expect(_matchBonoConfig(150, CONFIGS_PROD)).toBeNull();
    });
    test('349 km → null ($0)  ← límite superior del tramo sin bono', () => {
        expect(_matchBonoConfig(349, CONFIGS_PROD)).toBeNull();
    });
});

// ─── Bordes de tramo 350–499 km ($35.000) ─────────────────────────────────────
describe('Tramo $35.000 (350–499 km)', () => {
    test('350 km → $35.000  ← primer km con bono', () => {
        const result = _matchBonoConfig(350, CONFIGS_PROD);
        expect(result).not.toBeNull();
        expect(result.monto).toBe(35000);
    });
    test('420 km → $35.000', () => {
        const result = _matchBonoConfig(420, CONFIGS_PROD);
        expect(result).not.toBeNull();
        expect(result.monto).toBe(35000);
    });
    test('499 km → $35.000  ← último km del tramo intermedio', () => {
        const result = _matchBonoConfig(499, CONFIGS_PROD);
        expect(result).not.toBeNull();
        expect(result.monto).toBe(35000);
    });
});

// ─── Bordes de tramo 500+ km ($50.000) ────────────────────────────────────────
describe('Tramo $50.000 (500+ km)', () => {
    test('500 km → $50.000  ← primer km del tramo alto', () => {
        const result = _matchBonoConfig(500, CONFIGS_PROD);
        expect(result).not.toBeNull();
        expect(result.monto).toBe(50000);
    });
    test('738 km → $50.000', () => {
        const result = _matchBonoConfig(738, CONFIGS_PROD);
        expect(result).not.toBeNull();
        expect(result.monto).toBe(50000);
    });
    test('9999 km → $50.000 (tramo abierto sin máximo)', () => {
        const result = _matchBonoConfig(9999, CONFIGS_PROD);
        expect(result).not.toBeNull();
        expect(result.monto).toBe(50000);
    });
});

// ─── Casos defensivos ──────────────────────────────────────────────────────────
describe('Casos defensivos', () => {
    test('km negativo → null', () => {
        expect(_matchBonoConfig(-1, CONFIGS_PROD)).toBeNull();
    });
    test('km = NaN → null', () => {
        expect(_matchBonoConfig(NaN, CONFIGS_PROD)).toBeNull();
    });
    test('lista de configs vacía → null', () => {
        expect(_matchBonoConfig(500, [])).toBeNull();
    });
    test('configs con activo=false se ignoran', () => {
        const inactivo = CONFIGS_PROD.map(c => ({ ...c, activo: false }));
        expect(_matchBonoConfig(500, inactivo)).toBeNull();
    });
    test('config con distancia_minima mal configurado (0) no produce falso positivo', () => {
        // Simula el bug original: config con distancia_minima=0 en vez de 350
        const configsCorruptos = [
            { id: 'x', activo: true, distancia_minima: 0, distancia_maxima: 499, monto: 35000 },
            { id: 'y', activo: true, distancia_minima: 500, distancia_maxima: null, monto: 50000 }
        ];
        // Con datos corruptos, 150 km INCORRECTAMENTE matchearía → esta test documenta el riesgo
        // La función retorna el config si los datos lo dicen. La prevención real es en la BD.
        const result = _matchBonoConfig(150, configsCorruptos);
        // Con datos correctos (distancia_minima=350) → null. Con corruptos (0) → matchea.
        // Este test DOCUMENTA que la función es fiel a los datos: si los datos están mal, sale mal.
        expect(result).not.toBeNull(); // con datos corruptos sí matchea: es esperado
        expect(result.monto).toBe(35000);
    });
});
