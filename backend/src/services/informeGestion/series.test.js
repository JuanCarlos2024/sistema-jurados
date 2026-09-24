const F = require('./fechasEquivalentes');
const { serieRodeosAcumulados, serieCollerasAcumuladas, serieSituacionesSemanales, domingosEntre } = require('./series');
const A = require('./agregados');

const T = { nombre: '2026-2027', inicio: '2026-04-01', fin: '2027-03-31' };
const r = (id, fecha, extra = {}) => ({ id, fecha, estado: 'activo', ...extra });

describe('desplazarFechaHaciaAdelante (inversa de la equivalencia)', () => {
    test('lleva una fecha histórica al punto equivalente de la temporada actual conservando el día de la semana', () => {
        expect(F.desplazarFechaHaciaAdelante('2025-09-28', 1)).toBe('2026-09-27');
        expect(F.diaSemana(F.desplazarFechaHaciaAdelante('2025-09-28', 1))).toBe(F.diaSemana('2025-09-28'));
        expect(F.desplazarFechaHaciaAdelante('2024-11-02', 2)).toBe('2026-10-31');   // sábado → sábado
    });
    test('propiedad: ida y vuelta no se aleja más de una semana y siempre conserva el día de la semana', () => {
        let d = '2024-01-01';
        while (d <= '2027-12-31') {
            for (const k of [1, 2, 3]) {
                const adelante = F.desplazarFechaHaciaAdelante(d, k);
                expect(F.diaSemana(adelante)).toBe(F.diaSemana(d));
                expect(Math.abs(F.diffDays(adelante, F.mismoDiaCalendarioAnterior(d, -k)))).toBeLessThanOrEqual(3);
                expect(Math.abs(F.diffDays(F.desplazarFechaEquivalente(adelante, k), d))).toBeLessThanOrEqual(7);
            }
            d = F.addDays(d, 11);
        }
    });
});

describe('serieRodeosAcumulados', () => {
    const rodeos = [r('a', '2026-04-04'), r('b', '2026-04-12'), r('c', '2026-04-12', { estado: 'anulado' }), r('d', '2026-09-19'), r('f', '2026-10-03')];
    const hist = [
        { temporada: '2025-2026', fecha_rodeo: '2025-04-05' }, { temporada: '2025-2026', fecha_rodeo: '2025-04-13' },
        { temporada: '2025-2026', fecha_rodeo: '2025-09-20' }, { temporada: '2025-2026', fecha_rodeo: '2025-10-04' }, { temporada: '2024-2025', fecha_rodeo: '2025-04-05' }
    ];
    const s = serieRodeosAcumulados({ rodeos, T, corte: '2026-09-20', historicoRodeos: hist, referencia: '2025-2026' });
    const p = f => s.puntos.find(x => x.fecha === f);

    test('puntos semanales ordenados (domingos) más el corte, sin duplicados', () => {
        const fechas = s.puntos.map(x => x.fecha);
        expect([...fechas].sort()).toEqual(fechas);
        expect(new Set(fechas).size).toBe(fechas.length);
        expect(fechas).toContain('2026-09-20');
        expect(fechas.filter(f => f !== '2026-09-20').every(f => F.diaSemana(f) === 0)).toBe(true);
    });
    test('conteos acumulados exactos; anulados fuera; futuros no cuentan como realizados', () => {
        expect(p('2026-04-05')).toMatchObject({ actual: 1, calendario_cargado: null });
        expect(p('2026-04-12')).toMatchObject({ actual: 2 });
        expect(p('2026-09-20')).toMatchObject({ actual: 3 });
        expect(p('2026-10-04')).toMatchObject({ actual: null, calendario_cargado: 4 });   // el rodeo del 03/10 es calendario, no realizado
    });
    test('el histórico usa la fecha equivalente (52 semanas) de la temporada de referencia únicamente', () => {
        expect(s.temporada_referencia).toBe('2025-2026');
        expect(p('2026-09-20')).toMatchObject({ fecha_historica: '2025-09-21', historico: 3 });   // no incluye la fila de 2024-2025
        expect(p('2026-04-05').historico).toBe(1);
    });
    test('sin histórico: historico es null (no 0)', () => {
        const x = serieRodeosAcumulados({ rodeos, T, corte: '2026-09-20', historicoRodeos: null, referencia: null });
        expect(x.puntos.every(q => q.historico === null && q.fecha_historica === null)).toBe(true);
        expect(x.temporada_referencia).toBeNull();
    });
    test('domingosEntre', () => { expect(domingosEntre('2026-04-01', '2026-04-20')).toEqual(['2026-04-05', '2026-04-12', '2026-04-19']); });
});

describe('serieCollerasAcumuladas', () => {
    const m = (t, f, v, c = true) => ({ temporada: t, fecha_medicion: f, total_colleras: v, fecha_confirmada: c });
    const hist = [m('2025-2026', '2025-10-05', 37), m('2025-2026', '2025-09-28', 28), m('2025-2026', '2025-10-12', 47, false), m('2024-2025', '2024-10-19', 60)];

    test('cada temporada histórica trae solo mediciones confirmadas, ordenadas y con su fecha equivalente en la temporada actual', () => {
        const s = serieCollerasAcumuladas({ T, historicoColleras: hist, snapshots: [], colleras: null, fechaColleras: null });
        const t2526 = s.temporadas.find(t => t.temporada === '2025-2026');
        expect(t2526.puntos.map(p => [p.fecha, p.valor])).toEqual([['2025-09-28', 28], ['2025-10-05', 37]]);   // la no confirmada no aparece
        expect(t2526.puntos[0].fecha_equivalente).toBe('2026-09-27');
        expect(t2526.puntos[0].x_dias).toBe(F.diffDays('2026-09-27', T.inicio));
        expect(s.temporadas.map(t => t.temporada)).toEqual(['2024-2025', '2025-2026', '2026-2027']);
    });
    test('la temporada actual solo tiene puntos reales: snapshot + dato en vivo (sin interpolar)', () => {
        const s = serieCollerasAcumuladas({
            T, historicoColleras: hist,
            snapshots: [{ fecha_snapshot: '2026-09-17T15:00:00Z', total_colleras: 30 }, { fecha_snapshot: '2026-09-24T15:00:00Z', total_colleras: null }],
            colleras: { estado: 'actual', total: 35 }, fechaColleras: '2026-09-24'
        });
        const act = s.temporadas.find(t => t.actual);
        expect(act.puntos.map(p => [p.fecha, p.valor, p.fuente])).toEqual([['2026-09-17', 30, 'snapshot'], ['2026-09-24', 35, 'en_vivo']]);
        expect(s.ritmo_actual).toMatchObject({ disponible: true, mediciones_actuales: 2, delta: 5, dias: 7, por_semana: 5 });
    });
    test('con una sola medición actual: ritmo no disponible con el motivo exacto', () => {
        const s = serieCollerasAcumuladas({ T, historicoColleras: hist, snapshots: [], colleras: { estado: 'actual', total: 35 }, fechaColleras: '2026-09-24' });
        expect(s.ritmo_actual).toEqual({ disponible: false, mediciones_actuales: 1, motivo: 'Se requieren al menos 2 mediciones actuales' });
    });
    test('un dato de respaldo (fallback) no se dibuja como punto nuevo de la temporada actual', () => {
        const s = serieCollerasAcumuladas({ T, historicoColleras: hist, snapshots: [], colleras: { estado: 'fallback', total: 33 }, fechaColleras: '2026-09-20' });
        expect(s.temporadas.find(t => t.actual).puntos).toEqual([]);
    });
});

describe('serieSituacionesSemanales', () => {
    const rodeos = [r('a', '2026-09-12'), r('b', '2026-09-13'), r('c', '2026-09-19'), r('d', '2026-09-26')];
    const ctx = {
        evalPorRodeo: A.indexarEvaluaciones([
            { id: 'ea', rodeo_id: 'a', estado: 'publicado', resultados_alterados: true }, { id: 'eb', rodeo_id: 'b', estado: 'publicado', resultados_alterados: false },
            { id: 'ec', rodeo_id: 'c', estado: 'borrador', resultados_alterados: true }
        ]),
        casosPorEval: A.indexarPorClave([{ evaluacion_id: 'ea', tipo_caso: 'reglamentaria', anulado: false }, { evaluacion_id: 'eb', tipo_caso: 'reglamentaria', anulado: true }, { evaluacion_id: 'ec', tipo_caso: 'interpretativa', anulado: false }], 'evaluacion_id')
    };
    const s = serieSituacionesSemanales({ rodeos, T, corte: '2026-09-20', ctx });
    test('semanas lunes–domingo con rodeos; la semana futura (26/09) no aparece', () => {
        expect(s.puntos.map(p => [p.semana_inicio, p.semana_fin])).toEqual([['2026-09-07', '2026-09-13'], ['2026-09-14', '2026-09-20']]);
    });
    test('rodeos con falta reglamentaria (anulados no cuentan) y alterados solo de publicadas', () => {
        expect(s.puntos[0]).toMatchObject({ rodeos_realizados: 2, evaluaciones_publicadas: 2, rodeos_con_falta_reglamentaria: 1, rodeos_con_resultado_alterado: 1, denominador_publicadas: 2, interpretable_alterados: true });
    });
    test('semana sin evaluaciones publicadas: alterados null (NO cero) y no interpretable', () => {
        expect(s.puntos[1]).toMatchObject({ rodeos_realizados: 1, evaluaciones_publicadas: 0, rodeos_con_resultado_alterado: null, denominador_publicadas: 0, cobertura_publicadas: 0, interpretable_alterados: false });
    });
    test('semana sin ninguna evaluación: falta reglamentaria null', () => {
        const x = serieSituacionesSemanales({ rodeos: [r('z', '2026-09-12')], T, corte: '2026-09-20', ctx: { evalPorRodeo: {}, casosPorEval: {} } });
        expect(x.puntos[0]).toMatchObject({ rodeos_con_falta_reglamentaria: null, evaluaciones_existentes: 0 });
    });
});
