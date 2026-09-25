const { normalizarCasosWhatsapp, MAXIMO_INTEGER_PG } = require('./casosWhatsapp');

describe('normalizarCasosWhatsapp (entero >= 0)', () => {
    test.each([[0, 0], [1, 1], [2, 2], [3, 3], [10, 10], [MAXIMO_INTEGER_PG, MAXIMO_INTEGER_PG]])('valor entero %s es válido', (entrada, esperado) => {
        expect(normalizarCasosWhatsapp(entrada)).toEqual({ ok: true, cambia: true, valor: esperado });
    });

    test.each([['0', 0], ['3', 3], [' 7 ', 7], ['007', 7]])('texto de solo dígitos %j se acepta como %s', (entrada, esperado) => {
        expect(normalizarCasosWhatsapp(entrada)).toEqual({ ok: true, cambia: true, valor: esperado });
    });

    test('undefined: no viene en la petición → no se toca el valor guardado', () => {
        expect(normalizarCasosWhatsapp(undefined)).toEqual({ ok: true, cambia: false });
    });

    test('null y texto vacío equivalen a 0 (mismo significado que el valor por defecto)', () => {
        expect(normalizarCasosWhatsapp(null)).toEqual({ ok: true, cambia: true, valor: 0 });
        expect(normalizarCasosWhatsapp('')).toEqual({ ok: true, cambia: true, valor: 0 });
        expect(normalizarCasosWhatsapp('   ')).toEqual({ ok: true, cambia: true, valor: 0 });
    });

    test.each([[-1], [-0.5], [1.5], [0.1], ['1.5'], ['-1'], ['tres'], ['3 casos'], ['1e3'], ['0x10'], ['+3'], [NaN], [Infinity], [-Infinity],
        [MAXIMO_INTEGER_PG + 1], [Number.MAX_SAFE_INTEGER], [true], [false], [{}], [[]], [[3]], [() => 3]])('valor inválido %p es rechazado', (entrada) => {
        const r = normalizarCasosWhatsapp(entrada);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/entero mayor o igual a 0/);
    });

    test('no inventa un máximo funcional: solo el límite del tipo INTEGER de PostgreSQL', () => {
        expect(normalizarCasosWhatsapp(1000000).ok).toBe(true);
        expect(MAXIMO_INTEGER_PG).toBe(2147483647);
    });
});
