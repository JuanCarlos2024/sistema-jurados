const F = require('./fechasEquivalentes');

describe('desplazarFechaEquivalente (52 semanas + corrección de deriva)', () => {
    test('domingo 20/09/2026 → domingo 21/09/2025 (ejemplo del diseño)', () => {
        const r = F.desplazarFechaEquivalente('2026-09-20', 1);
        expect(r).toBe('2025-09-21');
        expect(F.diaSemana(r)).toBe(0);
    });

    test('retroceder varias temporadas conserva el día de la semana y corrige la deriva (k=2, k=3)', () => {
        expect(F.desplazarFechaEquivalente('2026-09-20', 2)).toBe('2024-09-22');
        // 24/09/2023 quedaría a 4 días de la fecha calendario: se prefiere el domingo 17/09 (a 3 días)
        expect(F.desplazarFechaEquivalente('2026-09-20', 3)).toBe('2023-09-17');
        expect(F.diaSemana('2023-09-17')).toBe(0);
    });

    test('cambio de año: 03/01/2027 (domingo) → 04/01/2026 (domingo)', () => {
        expect(F.desplazarFechaEquivalente('2027-01-03', 1)).toBe('2026-01-04');
    });

    test('propiedad: siempre conserva el día de la semana y queda a ≤ 3 días de la fecha calendario (incluye años bisiestos)', () => {
        let d = '2024-01-01';
        while (d <= '2028-12-31') {
            for (const k of [1, 2, 3]) {
                const r = F.desplazarFechaEquivalente(d, k);
                expect(F.diaSemana(r)).toBe(F.diaSemana(d));
                expect(Math.abs(F.diffDays(r, F.mismoDiaCalendarioAnterior(d, k)))).toBeLessThanOrEqual(3);
            }
            d = F.addDays(d, 1);
        }
    });

    test('año bisiesto: 29/02 se compara con 28/02 del año no bisiesto; el 29/02/2028 → martes 02/03/2027', () => {
        expect(F.mismoDiaCalendarioAnterior('2028-02-29', 1)).toBe('2027-02-28');
        expect(F.mismoDiaCalendarioAnterior('2028-02-29', 4)).toBe('2024-02-29');
        expect(F.desplazarFechaEquivalente('2028-02-29', 1)).toBe('2027-03-02');
    });

    test('fecha inválida lanza error', () => {
        expect(() => F.desplazarFechaEquivalente('2026-13-40', 1)).toThrow(/inválida/);
    });
});

describe('ventana de temporada equivalente (límites de temporada)', () => {
    test('temporada 01/04/2026–31/03/2027, corte 20/09/2026, k=1', () => {
        expect(F.ventanaEquivalente({ inicio: '2026-04-01', corte: '2026-09-20', fin: '2027-03-31' }, 1))
            .toEqual({ k: 1, inicio: '2025-04-02', corte: '2025-09-21', fin: '2026-04-01' });
    });
    test('nombres de temporada', () => {
        expect(F.temporadaAnterior('2026-2027', 1)).toBe('2025-2026');
        expect(F.temporadaAnterior('2026-2027', 2)).toBe('2024-2025');
        expect(F.temporadaAnterior('2026/27')).toBeNull();
        expect(F.distanciaTemporadas('2026-2027', '2024-2025')).toBe(2);
        expect(F.distanciaTemporadas('2026-2027', '2027-2028')).toBeNull();
    });
    test('avance de temporada acotado 0..1', () => {
        expect(F.avanceTemporada('2026-04-01', '2026-04-01', '2027-03-31')).toBe(0);
        expect(F.avanceTemporada('2027-03-31', '2026-04-01', '2027-03-31')).toBe(1);
        expect(F.avanceTemporada('2028-01-01', '2026-04-01', '2027-03-31')).toBe(1);
        expect(F.avanceTemporada('2026-09-30', '2026-04-01', '2027-03-31')).toBeCloseTo(182 / 364, 3);
    });
});

describe('buscarMedicionEquivalente (colleras)', () => {
    const med = (fecha, total, confirmada = true) => ({ fecha_medicion: fecha, total_colleras: total, fecha_confirmada: confirmada });

    test('elige la medición real más cercana dentro de ±7 días', () => {
        const r = F.buscarMedicionEquivalente([med('2025-09-14', 20), med('2025-09-27', 28), med('2025-10-04', 37)], '2025-09-28');
        expect(r.estado).toBe('OK');
        expect(r.medicion.total_colleras).toBe(28);
        expect(r.diferencia_dias).toBe(-1);
    });

    test('empate de distancia → la medición ANTERIOR (regla determinística)', () => {
        const r = F.buscarMedicionEquivalente([med('2025-10-05', 40), med('2025-09-29', 30)], '2025-10-02');
        expect(r.medicion.fecha_medicion).toBe('2025-09-29');
        expect(r.diferencia_dias).toBe(-3);
    });

    test('sin medición dentro de la tolerancia → SIN_DATO_HISTORICO_COMPARABLE (sin interpolar)', () => {
        const r = F.buscarMedicionEquivalente([med('2025-09-01', 10), med('2025-11-01', 90)], '2025-10-02');
        expect(r.estado).toBe(F.SIN_DATO_HISTORICO_COMPARABLE);
        expect(r.medicion).toBeNull();
    });

    test('ignora mediciones sin fecha confirmada y valores vacíos (nunca se convierten en cero)', () => {
        const r = F.buscarMedicionEquivalente([med('2025-10-02', 50, false), { fecha_medicion: '2025-10-03', total_colleras: null, fecha_confirmada: true }], '2025-10-02');
        expect(r.estado).toBe(F.SIN_DATO_HISTORICO_COMPARABLE);
    });

    test('tolerancia configurable y borde ±7 inclusivo', () => {
        expect(F.buscarMedicionEquivalente([med('2025-10-09', 5)], '2025-10-02').estado).toBe('OK');
        expect(F.buscarMedicionEquivalente([med('2025-10-10', 5)], '2025-10-02').estado).toBe(F.SIN_DATO_HISTORICO_COMPARABLE);
        expect(F.buscarMedicionEquivalente([med('2025-10-10', 5)], '2025-10-02', { toleranciaDias: 8 }).estado).toBe('OK');
    });
});

test('hoyChile usa la zona horaria de Chile', () => {
    expect(F.hoyChile(new Date('2026-09-24T02:00:00Z'))).toBe('2026-09-23');
    expect(F.hoyChile(new Date('2026-09-24T15:00:00Z'))).toBe('2026-09-24');
});
