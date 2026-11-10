const { validarSeccionColleraNueva } = require('./cartillaDelegadoColleraNueva');

const COLLERA_COMPLETA = {
    rut1: '11.111.111-1', nombre1: 'Juan Pérez',
    rut2: '7.654.321-6', nombre2: 'Pedro Soto',
    num_caballo1: '12', nombre_caballo1: 'Relámpago',
    num_caballo2: '7', nombre_caballo2: 'Trueno',
    lugar: '1°'
};

describe('validarSeccionColleraNueva — "Corre por los premios" / "Deja puntos" (defensa en profundidad backend)', () => {
    test('respuesta distinta de "si" -> siempre válido, nunca exige nada (ni items vacíos)', () => {
        expect(validarSeccionColleraNueva({ respuesta: 'no', items: [] }, 'Corre por los premios')).toEqual({ valido: true });
        expect(validarSeccionColleraNueva(undefined, 'Corre por los premios')).toEqual({ valido: true });
        expect(validarSeccionColleraNueva({ respuesta: null, items: [] }, 'Corre por los premios')).toEqual({ valido: true });
    });

    test('respuesta "si" sin ninguna collera -> inválido', () => {
        const r = validarSeccionColleraNueva({ respuesta: 'si', items: [] }, 'Corre por los premios');
        expect(r.valido).toBe(false);
        expect(r.error).toContain('Corre por los premios');
        expect(r.error).toContain('al menos una collera');
    });

    test('respuesta "si" con una collera completa y RUT válidos -> válido', () => {
        const r = validarSeccionColleraNueva({ respuesta: 'si', items: [COLLERA_COMPLETA] }, 'Corre por los premios');
        expect(r).toEqual({ valido: true });
    });

    test('respuesta "si" con colleras incompletas (falta un campo) -> inválido', () => {
        const incompleta = { ...COLLERA_COMPLETA, lugar: '' };
        const r = validarSeccionColleraNueva({ respuesta: 'si', items: [incompleta] }, 'Deja puntos para la próxima temporada');
        expect(r.valido).toBe(false);
        expect(r.error).toContain('todos sus datos completos');
    });

    test('al menos UNA completa entre varias incompletas -> válido (no exige que TODAS estén completas)', () => {
        const incompleta = { ...COLLERA_COMPLETA, lugar: '' };
        const r = validarSeccionColleraNueva({ respuesta: 'si', items: [incompleta, COLLERA_COMPLETA] }, 'Corre por los premios');
        expect(r.valido).toBe(true);
    });

    test('RUT con dígito verificador inválido -> inválido, con el detalle de qué collera/jinete', () => {
        const rutMalo = { ...COLLERA_COMPLETA, rut1: '11.111.111-9' }; // dv real es 1
        const r = validarSeccionColleraNueva({ respuesta: 'si', items: [rutMalo] }, 'Corre por los premios');
        expect(r.valido).toBe(false);
        expect(r.error).toContain('RUT');
        expect(r.error).toContain('Collera 1');
        expect(r.error).toContain('Jinete 1');
    });

    test('items undefined con respuesta "si" -> inválido (nunca lanza excepción)', () => {
        expect(() => validarSeccionColleraNueva({ respuesta: 'si' }, 'Corre por los premios')).not.toThrow();
        const r = validarSeccionColleraNueva({ respuesta: 'si' }, 'Corre por los premios');
        expect(r.valido).toBe(false);
    });
});
