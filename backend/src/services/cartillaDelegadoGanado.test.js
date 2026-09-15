// ═════════════════════════════════════════════════════════════════════════
// Tests de calcularPorcentajeFueraPeso (5ª revisión, punto 6) — "% Ganado
// bajo o sobrepeso reglamentario" por Animal, SIEMPRE calculado por el
// sistema, nunca a mano por el Delegado.
// ═════════════════════════════════════════════════════════════════════════
const { calcularPorcentajeFueraPeso } = require('./cartillaDelegadoGanado');

describe('calcularPorcentajeFueraPeso', () => {
    test('ejemplo del pedido: Ganado 25, Fuera de peso 2 -> 8.0%', () => {
        expect(calcularPorcentajeFueraPeso(25, 2)).toBe(8.0);
    });

    test('redondea a 1 decimal', () => {
        expect(calcularPorcentajeFueraPeso(3, 1)).toBeCloseTo(33.3, 1);
    });

    test('sin fuera de peso -> 0%', () => {
        expect(calcularPorcentajeFueraPeso(10, 0)).toBe(0);
    });

    test('# Ganado en 0 -> null (evita división por cero, nunca 0% falso)', () => {
        expect(calcularPorcentajeFueraPeso(0, 2)).toBeNull();
    });

    test('# Ganado vacío/no numérico -> null', () => {
        expect(calcularPorcentajeFueraPeso('', 2)).toBeNull();
        expect(calcularPorcentajeFueraPeso(undefined, 2)).toBeNull();
        expect(calcularPorcentajeFueraPeso('abc', 2)).toBeNull();
    });

    test('cantidad fuera de peso vacía/no numérica -> se trata como 0, no rompe el cálculo', () => {
        expect(calcularPorcentajeFueraPeso(10, '')).toBe(0);
        expect(calcularPorcentajeFueraPeso(10, undefined)).toBe(0);
        expect(calcularPorcentajeFueraPeso(10, 'abc')).toBe(0);
    });

    test('cantidad fuera de peso negativa -> se trata como 0 (nunca negativo)', () => {
        expect(calcularPorcentajeFueraPeso(10, -5)).toBe(0);
    });

    test('fuera de peso mayor que el ganado (dato inconsistente) -> igual calcula, no lanza excepción', () => {
        expect(calcularPorcentajeFueraPeso(5, 10)).toBe(200);
    });
});
