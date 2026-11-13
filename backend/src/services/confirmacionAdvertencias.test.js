const { normalizarCausasAceptadas, compararCausas } = require('./confirmacionAdvertencias');

describe('normalizarCausasAceptadas', () => {
    test('ausente -> null (sin aceptación)', () => {
        expect(normalizarCausasAceptadas(undefined)).toEqual({ ok: true, causas: null });
        expect(normalizarCausasAceptadas(null)).toEqual({ ok: true, causas: null });
    });
    test('lista válida -> se conserva', () => {
        expect(normalizarCausasAceptadas(['FINDE_CONSECUTIVO'])).toEqual({ ok: true, causas: ['FINDE_CONSECUTIVO'] });
    });
    test.each([['x'], [{}], [[1]], [['']], [['A', 'A']], [true]])('mal formada %p -> error', (v) => {
        expect(normalizarCausasAceptadas(v).ok).toBe(false);
    });
});

describe('compararCausas (como conjuntos)', () => {
    test('mismo conjunto en distinto orden -> coincide', () => {
        expect(compararCausas(['B', 'A'], ['A', 'B'])).toEqual({ coincide: true, nuevas: [], ya_no_existen: [] });
    });
    test('nueva causa', () => {
        expect(compararCausas(['A', 'B'], ['A'])).toEqual({ coincide: false, nuevas: ['B'], ya_no_existen: [] });
    });
    test('causa que ya no existe', () => {
        expect(compararCausas(['A'], ['A', 'B'])).toEqual({ coincide: false, nuevas: [], ya_no_existen: ['B'] });
    });
    test('vacío vs aceptadas', () => {
        expect(compararCausas([], ['A']).coincide).toBe(false);
    });
});
