const { normalizarAsociacion, mismaAsociacion } = require('./asociaciones');

describe('normalizarAsociacion / mismaAsociacion (comparación conservadora)', () => {
    test('casos superficiales que SÍ deben coincidir', () => {
        expect(mismaAsociacion('CONCEPCION', 'Concepción')).toBe(true);
        expect(mismaAsociacion('Asociación Aguanegra', 'AGUANEGRA')).toBe(true);
        expect(mismaAsociacion('  Maipo Norte  ', 'MAIPO NORTE')).toBe(true);
        expect(mismaAsociacion('asociacion Colchagua', 'Colchagua')).toBe(true);
    });

    test('asociaciones distintas NUNCA deben fusionarse (casos explícitos del proyecto)', () => {
        expect(mismaAsociacion('BÍO-BÍO', 'RÍO BÍO-BÍO')).toBe(false);
        expect(mismaAsociacion('LLANQUIHUE', 'LAGO LLANQUIHUE')).toBe(false);
        expect(mismaAsociacion('MAIPO', 'MAIPO NORTE')).toBe(false);
    });

    test('no hace fuzzy matching de nombres parecidos pero distintos', () => {
        expect(mismaAsociacion('Colchagua', 'Colchagua Sur')).toBe(false);
        expect(mismaAsociacion('San Fernando', 'San Vicente')).toBe(false);
    });

    test('valores vacíos/nulos nunca se consideran iguales entre sí', () => {
        expect(mismaAsociacion('', '')).toBe(false);
        expect(mismaAsociacion(null, null)).toBe(false);
        expect(mismaAsociacion(null, 'Colchagua')).toBe(false);
    });

    test('normalizarAsociacion quita solo el prefijo "asociación" inicial, no en medio del texto', () => {
        expect(normalizarAsociacion('Asociación Aguanegra')).toBe('aguanegra');
        expect(normalizarAsociacion('Agua Negra Asociacion')).toBe('agua negra asociacion'); // no es prefijo, no se quita
    });
});
