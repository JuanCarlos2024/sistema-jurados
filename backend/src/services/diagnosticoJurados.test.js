const { clasificarJurado } = require('./diagnosticoJurados');

const catalogo = {
    comunas: [{ id: 'c1', nombre: 'Santiago', nombre_normalizado: 'santiago', latitud: -33.45, longitud: -70.66 }],
    alias: []
};

describe('clasificarJurado', () => {
    test('categoría válida (A/B/C) no cuenta como sin categoría', () => {
        expect(clasificarJurado({ categoria: 'A', comuna: 'Santiago', asociacion: 'X' }, catalogo).sinCategoria).toBe(false);
    });
    test('categoría NULL, vacía o inválida cuenta como sin categoría', () => {
        expect(clasificarJurado({ categoria: null }, catalogo).sinCategoria).toBe(true);
        expect(clasificarJurado({ categoria: '' }, catalogo).sinCategoria).toBe(true);
        expect(clasificarJurado({ categoria: 'D' }, catalogo).sinCategoria).toBe(true);
    });
    test('comuna vacía o nula → sinComuna=true, comunaNoReconocida=false', () => {
        const r = clasificarJurado({ comuna: '' }, catalogo);
        expect(r.sinComuna).toBe(true);
        expect(r.comunaNoReconocida).toBe(false);
    });
    test('comuna con texto que resuelve contra el catálogo → ninguna de las dos', () => {
        const r = clasificarJurado({ comuna: 'Santiago' }, catalogo);
        expect(r.sinComuna).toBe(false);
        expect(r.comunaNoReconocida).toBe(false);
    });
    test('comuna con texto que NO resuelve → comunaNoReconocida=true, sinComuna=false', () => {
        const r = clasificarJurado({ comuna: 'Lugar Inexistente' }, catalogo);
        expect(r.sinComuna).toBe(false);
        expect(r.comunaNoReconocida).toBe(true);
    });
    test('asociación vacía o nula → sinAsociacion=true', () => {
        expect(clasificarJurado({ asociacion: null }, catalogo).sinAsociacion).toBe(true);
        expect(clasificarJurado({ asociacion: '  ' }, catalogo).sinAsociacion).toBe(true);
        expect(clasificarJurado({ asociacion: 'Colchagua' }, catalogo).sinAsociacion).toBe(false);
    });
});
