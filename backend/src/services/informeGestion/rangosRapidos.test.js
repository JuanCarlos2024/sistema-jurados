const { ultimoFinDeSemana, rangosRapidos } = require('./rangosRapidos');
const feriados = require('../feriados');

describe('ÚLTIMO FIN DE SEMANA = bloque de rodeo (misma lógica que la designación)', () => {
    test('fin de semana normal: entre semana devuelve el último sábado–domingo completo', () => {
        expect(ultimoFinDeSemana('2026-09-09')).toEqual({ desde: '2026-09-05', hasta: '2026-09-06' });   // miércoles
        expect(ultimoFinDeSemana('2026-09-10')).toEqual({ desde: '2026-09-05', hasta: '2026-09-06' });   // jueves
        expect(ultimoFinDeSemana('2026-09-11')).toEqual({ desde: '2026-09-05', hasta: '2026-09-06' });   // viernes
    });

    test('fin de semana con feriado: viernes 18 + sábado 19 + domingo 20 de septiembre es UN solo bloque', () => {
        expect(ultimoFinDeSemana('2026-09-24')).toEqual({ desde: '2026-09-18', hasta: '2026-09-20' });
        expect(ultimoFinDeSemana('2026-09-21')).toEqual({ desde: '2026-09-18', hasta: '2026-09-20' });   // lunes siguiente
    });

    test('corte en lunes: el fin de semana que acaba de terminar', () => {
        expect(ultimoFinDeSemana('2026-09-07')).toEqual({ desde: '2026-09-05', hasta: '2026-09-06' });
    });

    test('corte entre semana y durante el bloque en curso (sábado/domingo): se usa el bloque anterior ya terminado', () => {
        expect(ultimoFinDeSemana('2026-09-12')).toEqual({ desde: '2026-09-05', hasta: '2026-09-06' });   // sábado (en curso)
        expect(ultimoFinDeSemana('2026-09-13')).toEqual({ desde: '2026-09-05', hasta: '2026-09-06' });   // domingo (último día, aún no terminó)
        expect(ultimoFinDeSemana('2026-09-14')).toEqual({ desde: '2026-09-12', hasta: '2026-09-13' });   // lunes
    });

    test('un feriado en lunes extiende el bloque (y mientras dura, el bloque no está terminado)', () => {
        // 29/06/2026 es lunes feriado: el bloque es 27–29 (sáb, dom, lun)
        expect(feriados.esDiaRodeo('2026-06-29')).toBe(true);
        expect(ultimoFinDeSemana('2026-06-30')).toEqual({ desde: '2026-06-27', hasta: '2026-06-29' });
        const enCurso = ultimoFinDeSemana('2026-06-29');            // hoy es el último día del bloque → se usa el anterior
        expect(enCurso.hasta < '2026-06-27').toBe(true);
    });

    test('reutiliza las funciones del sistema (inyectables): no hay otra definición de fin de semana', () => {
        const esDiaRodeo = jest.fn(f => f === '2026-01-03');
        const calcularBloqueRodeo = jest.fn(() => ({ inicio: '2026-01-03', fin: '2026-01-03' }));
        expect(ultimoFinDeSemana('2026-01-05', { esDiaRodeo, calcularBloqueRodeo })).toEqual({ desde: '2026-01-03', hasta: '2026-01-03' });
        expect(calcularBloqueRodeo).toHaveBeenCalledWith('2026-01-03', 1);
    });

    test('fecha inválida', () => { expect(() => ultimoFinDeSemana('hoy')).toThrow(/YYYY-MM-DD/); });
});

describe('rangosRapidos', () => {
    test('incluye últimos 30 días (30 días corridos hasta hoy)', () => {
        const r = rangosRapidos('2026-09-24');
        expect(r.ultimos_30_dias).toEqual({ desde: '2026-08-26', hasta: '2026-09-24' });
        expect(r.ultimo_fin_de_semana).toMatchObject({ desde: '2026-09-18', hasta: '2026-09-20' });
        expect(r.ultimo_fin_de_semana.criterio).toMatch(/feriados/);
    });
});
