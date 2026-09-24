const P = require('./proyecciones');

describe('proyectarSerie', () => {
    test('bajo el 25 % de avance histórico NO se proyecta (PROYECCION_NO_DISPONIBLE con motivo)', () => {
        const r = P.proyectarSerie({ actual: 10, historicos: [{ temporada: '2025-2026', equivalente: 20, final: 100 }] });
        expect(r).toMatchObject({ estado: 'PROYECCION_NO_DISPONIBLE', estimacion: null, temporadas_comparables: 0, motivo: 'SIN_TEMPORADA_COMPARABLE_CON_AVANCE_SUFICIENTE' });
        expect(r.datos_base.descartadas[0]).toMatchObject({ temporada: '2025-2026', avance_historico: 0.2 });
    });

    test('exactamente 25 % sí proyecta (umbral inclusivo)', () => {
        const r = P.proyectarSerie({ actual: 50, historicos: [{ temporada: 'h', equivalente: 25, final: 100 }] });
        expect(r.estado).toBe('PROYECCION_DISPONIBLE');
        expect(r.estimacion).toBe(200);
    });

    test('con 1 temporada: estimación = actual / (equivalente/final), confianza REFERENCIAL, con aviso de no-certeza', () => {
        const r = P.proyectarSerie({ actual: 190, historicos: [{ temporada: '2025-2026', equivalente: 171, final: 672 }] });
        expect(r.estimacion).toBe(Math.round(190 / (171 / 672)));
        expect(r).toMatchObject({ metodo: 'razon_ritmo_historico', temporadas_comparables: 1, confianza: 'REFERENCIAL' });
        expect(r.rango).toEqual({ minimo: r.estimacion, maximo: r.estimacion });
        expect(r.aviso).toMatch(/no es una certeza/i);
        expect(r.datos_base.comparables[0]).toMatchObject({ temporada: '2025-2026', equivalente: 171, final: 672 });
    });

    test('con varias temporadas: mediana como escenario central y mín/máx como rango; 2 temporadas = LIMITADA', () => {
        const r = P.proyectarSerie({ actual: 100, historicos: [
            { temporada: 'a', equivalente: 50, final: 200 },   // 400
            { temporada: 'b', equivalente: 80, final: 200 }    // 250
        ] });
        expect(r.estimacion).toBe(325);
        expect(r.rango).toEqual({ minimo: 250, maximo: 400 });
        expect(r.confianza).toBe('LIMITADA');
    });

    test('3+ temporadas consistentes = MAYOR_BASE_HISTORICA; dispersas = LIMITADA', () => {
        const consistentes = P.proyectarSerie({ actual: 100, historicos: ['a', 'b', 'c'].map((t, i) => ({ temporada: t, equivalente: 50 + i, final: 200 })) });
        expect(consistentes.confianza).toBe('MAYOR_BASE_HISTORICA');
        expect(consistentes.temporadas_comparables).toBe(3);
        const dispersas = P.proyectarSerie({ actual: 100, historicos: [
            { temporada: 'a', equivalente: 50, final: 200 }, { temporada: 'b', equivalente: 60, final: 200 }, { temporada: 'c', equivalente: 90, final: 200 }] });
        expect(dispersas.confianza).toBe('LIMITADA');
    });

    test('descarta temporadas incompletas y usa las válidas', () => {
        const r = P.proyectarSerie({ actual: 100, historicos: [{ temporada: 'x', equivalente: null, final: 200 }, { temporada: 'y', equivalente: 50, final: 200 }] });
        expect(r.temporadas_comparables).toBe(1);
        expect(r.datos_base.descartadas).toEqual([{ temporada: 'x', motivo: 'HISTORICO_INCOMPLETO' }]);
    });

    test('sin histórico o sin dato actual → no disponible', () => {
        expect(P.proyectarSerie({ actual: 10, historicos: [] })).toMatchObject({ estado: 'PROYECCION_NO_DISPONIBLE', motivo: 'SIN_HISTORICO' });
        expect(P.proyectarSerie({ actual: null, historicos: [{ temporada: 'a', equivalente: 1, final: 2 }] })).toMatchObject({ estado: 'PROYECCION_NO_DISPONIBLE', motivo: 'SIN_DATO_ACTUAL' });
    });

    test('umbral de avance configurable', () => {
        const r = P.proyectarSerie({ actual: 10, historicos: [{ temporada: 'a', equivalente: 20, final: 100 }] }, { PROYECCION: { AVANCE_MINIMO: 0.1, CONSISTENCIA_MAX_DISPERSION: 0.25 } });
        expect(r.estado).toBe('PROYECCION_DISPONIBLE');
    });
});

describe('proyectarRodeos / proyectarColleras', () => {
    test('rodeos informa el piso conocido (realizados + programados)', () => {
        const r = P.proyectarRodeos({ actual: 190, programados: 20, historicos: [{ temporada: 'h', equivalente: 171, final: 672 }] });
        expect(r.datos_base.piso_calendario_conocido).toBe(210);
    });

    const med = (fecha, total, confirmada = true) => ({ fecha_medicion: fecha, total_colleras: total, fecha_confirmada: confirmada });
    test('colleras: usa la medición confirmada más cercana y la última como referencia de cierre', () => {
        const r = P.proyectarColleras({
            actual: 120,
            historicosPorTemporada: [{ temporada: '2025-2026', fechaObjetivo: '2025-11-08', mediciones: [med('2025-09-28', 28), med('2025-11-09', 100), med('2026-02-01', 340)] }]
        });
        expect(r.estado).toBe('PROYECCION_DISPONIBLE');
        expect(r.estimacion).toBe(Math.round(120 / (100 / 340)));
        expect(r.metodo).toBe('razon_ritmo_historico_colleras');
    });

    test('colleras: a fines de septiembre (histórico < 25 % del cierre) NO se proyecta', () => {
        const r = P.proyectarColleras({
            actual: 35,
            historicosPorTemporada: [{ temporada: '2025-2026', fechaObjetivo: '2025-09-28', mediciones: [med('2025-09-28', 28), med('2026-02-01', 340)] }]
        });
        expect(r.estado).toBe('PROYECCION_NO_DISPONIBLE');
        expect(r.datos_base.descartadas[0].motivo).toMatch(/AVANCE_HISTORICO_BAJO/);
    });

    test('colleras: nunca usa mediciones con fecha NO confirmada', () => {
        const r = P.proyectarColleras({
            actual: 35,
            historicosPorTemporada: [{ temporada: '2025-2026', fechaObjetivo: '2025-09-28', mediciones: [med('2025-09-28', 28, false), med('2026-02-01', 340, false)] }]
        });
        expect(r.estado).toBe('PROYECCION_NO_DISPONIBLE');
        expect(r.datos_base.sin_dato_historico_comparable).toEqual([{ temporada: '2025-2026', motivo: 'SIN_DATO_HISTORICO_COMPARABLE' }]);
    });

    test('colleras: temporada sin medición dentro de ±7 días se descarta sin interpolar', () => {
        const r = P.proyectarColleras({
            actual: 120,
            historicosPorTemporada: [
                { temporada: '2024-2025', fechaObjetivo: '2024-11-08', mediciones: [med('2024-09-15', 40), med('2025-02-01', 358)] },
                { temporada: '2025-2026', fechaObjetivo: '2025-11-08', mediciones: [med('2025-11-09', 100), med('2026-02-01', 340)] }
            ]
        });
        expect(r.temporadas_comparables).toBe(1);
        expect(r.datos_base.sin_dato_historico_comparable.map(x => x.temporada)).toEqual(['2024-2025']);
    });
});
