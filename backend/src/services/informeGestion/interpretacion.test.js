// Ronda final de interpretación: período equivalente por BLOQUE de rodeo (Fiestas Patrias), serie por bloque,
// motivos de seguimiento, temporadas explícitas en señales y conteo de temporadas comparables de colleras.
jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../colleras-completas', () => ({ obtenerCollerasCompletas: jest.fn() }));

const { rangoHistoricoPeriodo, esUnSoloBloque, MODO } = require('./periodoEquivalente');
const { serieSituacionesPorBloque, etiquetaBloque, bloquesDeRodeos } = require('./series');
const { generarSenales } = require('./senales');
const { calcularInforme } = require('./informe');

const T = { id: 't1', nombre: '2026-2027', inicio: '2026-04-01', fin: '2027-03-31', fuente: 'test' };
const rod = (id, fecha, extra = {}) => ({ id, fecha, club: 'C' + id, asociacion: 'ARAUCO', tipo_rodeo_id: 'T_SEG', tipo_rodeo_nombre: 'Provincial', categoria_rodeo_nombre: null, estado: 'activo', duracion_dias: 1, es_prueba: false, ...extra });
const hist = (fecha, temporada = '2025-2026') => ({ temporada, fecha_rodeo: fecha, asociacion_id: 'A1', asociacion_normalizada: null, tipo_rodeo: 'Provincial', categoria: 'Segunda' });
const veces = (n, f) => Array.from({ length: n }, (_, i) => f(i));

describe('período equivalente: un solo bloque de rodeo → bloque histórico completo (Fiestas Patrias)', () => {
    test('18–20/09/2026 es UN bloque; el equivalente histórico es el bloque completo 18–21/09/2025 (no el rango desplazado 19–21)', () => {
        expect(esUnSoloBloque('2026-09-18', '2026-09-20')).toBe(true);
        const r = rangoHistoricoPeriodo({ desde: '2026-09-18', hasta: '2026-09-20', k: 1 });
        expect(r).toMatchObject({ modo: MODO.BLOQUE, desde: '2025-09-18', hasta: '2025-09-21', rango_desplazado: { desde: '2025-09-19', hasta: '2025-09-21' } });
    });
    test('un fin de semana normal produce el mismo rango con ambos métodos (comportamiento sin cambios)', () => {
        const r = rangoHistoricoPeriodo({ desde: '2026-09-05', hasta: '2026-09-06', k: 1 });
        expect(r.modo).toBe(MODO.BLOQUE);
        expect({ desde: r.desde, hasta: r.hasta }).toEqual(r.rango_desplazado);
    });
    test('rango personalizado de varias semanas: se mantiene el rango desplazado', () => {
        const r = rangoHistoricoPeriodo({ desde: '2026-08-29', hasta: '2026-09-20', k: 1 });
        expect(r.modo).toBe(MODO.RANGO);
        expect({ desde: r.desde, hasta: r.hasta }).toEqual({ desde: '2025-08-30', hasta: '2025-09-21' });
    });
    test('un período que es solo parte de un bloque (p. ej. solo el sábado 19/09) NO se expande', () => {
        expect(esUnSoloBloque('2026-09-19', '2026-09-19')).toBe(false);
        expect(rangoHistoricoPeriodo({ desde: '2026-09-19', hasta: '2026-09-19', k: 1 }).modo).toBe(MODO.RANGO);
    });
    test('usa las funciones de feriados.js (inyectables): no hay otra definición de bloque', () => {
        const esDiaRodeo = jest.fn(() => true);
        const calcularBloqueRodeo = jest.fn(f => ({ inicio: f, fin: f }));
        esUnSoloBloque('2026-09-05', '2026-09-05', { esDiaRodeo, calcularBloqueRodeo });
        expect(calcularBloqueRodeo).toHaveBeenCalledWith('2026-09-05', 1);
    });

    describe('calcularInforme con datos de Fiestas Patrias', () => {
        // 2026: 3 el 18, 2 el 19, 1 el 20 = 6.  2025: 4 el 18 (jueves feriado), 1 el 19, 1 el 20 = 6 en el bloque; el rango desplazado 19–21 solo ve 2.
        const ds = () => ({
            temporada: T,
            rodeos: [...veces(3, i => rod('a' + i, '2026-09-18')), ...veces(2, i => rod('b' + i, '2026-09-19')), rod('c0', '2026-09-20')],
            categoriaPorTipoId: { T_SEG: 'Segunda' },
            evaluaciones: [], casos: [], cartillas: [], asignaciones: [], notasSecundarias: [], usuarios: [], disponibilidad: [], notasJurado: [],
            catalogoAsociaciones: null, aliasAsociaciones: [], historicoColleras: null,
            historicoRodeos: [...veces(4, () => hist('2025-09-18')), hist('2025-09-19'), hist('2025-09-20')],
            fuentes: { asociaciones: { disponible: false }, historico_rodeos: { disponible: true }, historico_colleras: { disponible: false } }
        });
        const COL = { total: null, estado: 'no_disponible', resumen: {}, detalle_error: null };
        const generar = (desde, hasta) => calcularInforme({ desde, hasta, hoy: '2026-09-24' }, ds(), COL, new Date('2026-09-24T15:00:00Z'));

        test('18–20/09: 6 vs 6 (0 %), no 6 vs 2 (+200 %)', () => {
            const inf = generar('2026-09-18', '2026-09-20');
            expect(inf.comparacion.rodeos_periodo).toMatchObject({ actual: 6, historico: 6, diferencia: 0, variacion_pct: 0, tendencia: 'IGUAL' });
            expect(inf.comparacion.periodo_equivalente).toMatchObject({ temporada: '2025-2026', modo: 'BLOQUE_DE_RODEO', desde: '2025-09-18', hasta: '2025-09-21' });
            expect(inf.historico_equivalente.temporadas[0].rodeos_periodo_equivalente).toBe(6);
        });
        test('rango personalizado de varias semanas: método general (rango desplazado)', () => {
            const inf = generar('2026-09-12', '2026-09-20');
            expect(inf.comparacion.periodo_equivalente).toMatchObject({ modo: 'RANGO_DESPLAZADO', desde: '2025-09-13', hasta: '2025-09-21' });
            expect(inf.comparacion.rodeos_periodo.historico).toBe(6);   // 2025-09-13..21
        });
        test('las comparaciones del acumulado de temporada no cambian', () => {
            const inf = generar('2026-09-18', '2026-09-20');
            expect(inf.comparacion.rodeos.actual).toBe(6);
        });
    });
});

describe('serie por BLOQUE de rodeo (situaciones_por_bloque)', () => {
    const corte = '2026-09-20';
    const ev = (id, rodeo, estado, alt) => ({ id, rodeo_id: rodeo, estado, nota_final: 5, resultados_alterados: alt, anulada: false });
    function ctxDe(evs, casos = []) {
        const evalPorRodeo = {}; evs.forEach(e => { evalPorRodeo[e.rodeo_id] = e; });
        const casosPorEval = {}; casos.forEach(c => { (casosPorEval[c.evaluacion_id] ||= []).push(c); });
        return { evalPorRodeo, casosPorEval };
    }
    const serie = (rodeos, evs, casos) => serieSituacionesPorBloque({ rodeos, T, corte, ctx: ctxDe(evs, casos) });

    test('un fin de semana largo (viernes feriado + sábado + domingo) es UN solo bloque; el resto de los fines de semana son bloques distintos', () => {
        const rodeos = [rod('s5', '2026-09-05'), rod('s6', '2026-09-06'), rod('f18', '2026-09-18'), rod('f19', '2026-09-19'), rod('f20', '2026-09-20')];
        const p = serie(rodeos, []).puntos;
        expect(p.map(x => [x.bloque_inicio, x.bloque_fin, x.rodeos_realizados, x.etiqueta])).toEqual([
            ['2026-09-05', '2026-09-06', 2, '05–06 SEP'],
            ['2026-09-18', '2026-09-20', 3, '18–20 SEP']
        ]);
    });
    test('un rodeo de varios días que termina en el bloque (jueves 17 con 4 días) se une a ese bloque: 17–20 SEP', () => {
        const rodeos = [rod('j17', '2026-09-17', { duracion_dias: 4 }), rod('f18', '2026-09-18'), rod('f19', '2026-09-19'), rod('f20', '2026-09-20')];
        const p = serie(rodeos, []).puntos;
        expect(p).toHaveLength(1);
        expect(p[0]).toMatchObject({ bloque_inicio: '2026-09-17', bloque_fin: '2026-09-20', rodeos_realizados: 4, etiqueta: '17–20 SEP' });
    });
    test('usa las funciones de feriados.js (inyectables)', () => {
        const calcularBloqueRodeo = jest.fn(f => ({ inicio: f, fin: f }));
        bloquesDeRodeos([rod('a', '2026-09-05')], { calcularBloqueRodeo });
        expect(calcularBloqueRodeo).toHaveBeenCalledWith('2026-09-05', 1);
    });
    test('etiquetas: mismo mes, cruce de mes y un solo día', () => {
        expect(etiquetaBloque('2026-09-18', '2026-09-20')).toBe('18–20 SEP');
        expect(etiquetaBloque('2026-09-30', '2026-10-02')).toBe('30 SEP–02 OCT');
        expect(etiquetaBloque('2026-09-05', '2026-09-05')).toBe('05 SEP');
    });
    test('barra = total de rodeos; faltas sobre rodeos con evaluación; alterados sobre evaluaciones PUBLICADAS (denominadores explícitos)', () => {
        // 10 rodeos en el bloque 18–20: 8 con evaluación (6 publicadas: 2 alteradas), 3 con caso reglamentario
        const rodeos = [...veces(4, i => rod('a' + i, '2026-09-18')), ...veces(4, i => rod('b' + i, '2026-09-19')), ...veces(2, i => rod('c' + i, '2026-09-20'))];
        const evs = [
            ev('e1', 'a0', 'publicado', true), ev('e2', 'a1', 'publicado', true), ev('e3', 'a2', 'publicado', false),
            ev('e4', 'a3', 'publicado', false), ev('e5', 'b0', 'publicado', false), ev('e6', 'b1', 'publicado', false),
            ev('e7', 'b2', 'borrador', false), ev('e8', 'b3', 'en_proceso', false)
        ];
        const casos = [
            { evaluacion_id: 'e1', tipo_caso: 'reglamentaria', anulado: false }, { evaluacion_id: 'e7', tipo_caso: 'reglamentaria', anulado: false },
            { evaluacion_id: 'e8', tipo_caso: 'reglamentaria', anulado: false }, { evaluacion_id: 'e2', tipo_caso: 'interpretativa', anulado: false },
            { evaluacion_id: 'e3', tipo_caso: 'reglamentaria', anulado: true }   // anulado: no cuenta
        ];
        const [b] = serie(rodeos, evs, casos).puntos;
        expect(b).toMatchObject({
            rodeos_realizados: 10, evaluaciones_existentes: 8, evaluaciones_publicadas: 6,
            rodeos_con_falta_reglamentaria: 3, denominador_faltas: 8, porcentaje_faltas: 37.5,
            rodeos_con_resultado_alterado: 2, denominador_alterados: 6, porcentaje_alterados: 33.3,
            cobertura_publicadas: 0.6, interpretable_alterados: true, interpretable_faltas: true
        });
    });
    test('sin evaluaciones publicadas: alterados = null (SIN DATOS), nunca 0; cobertura 0/total', () => {
        const rodeos = [rod('a', '2026-09-18'), rod('b', '2026-09-19')];
        const [b] = serie(rodeos, [ev('e1', 'a', 'borrador', false)]).puntos;
        expect(b).toMatchObject({ evaluaciones_publicadas: 0, rodeos_con_resultado_alterado: null, denominador_alterados: 0, porcentaje_alterados: null, cobertura_publicadas: 0, interpretable_alterados: false });
    });
    test('sin ninguna evaluación: faltas = null (no 0)', () => {
        const [b] = serie([rod('a', '2026-09-18')], []).puntos;
        expect(b.rodeos_con_falta_reglamentaria).toBeNull();
        expect(b.porcentaje_faltas).toBeNull();
    });
    test('cobertura < 50 % marca los indicadores como no interpretables (marcador gris)', () => {
        const rodeos = veces(6, i => rod('r' + i, '2026-09-19'));
        const [b] = serie(rodeos, [ev('e1', 'r0', 'publicado', true)]).puntos;
        expect(b).toMatchObject({ evaluaciones_publicadas: 1, rodeos_con_resultado_alterado: 1, denominador_alterados: 1, interpretable_alterados: false, interpretable_faltas: false });
    });
    test('anulados y posteriores al corte no cuentan; un rodeo aparece en un solo bloque', () => {
        const rodeos = [rod('a', '2026-09-19'), rod('an', '2026-09-19', { estado: 'anulado' }), rod('fut', '2026-09-26')];
        const p = serie(rodeos, []).puntos;
        expect(p).toHaveLength(1);
        expect(p[0].rodeos_realizados).toBe(1);
        expect(p.reduce((s, x) => s + x.rodeos_realizados, 0)).toBe(1);
    });
    test('bloque en curso: bloque_completo = false cuando el fin del bloque es posterior al corte', () => {
        const p = serieSituacionesPorBloque({ rodeos: [rod('a', '2026-09-19')], T, corte: '2026-09-19', ctx: ctxDe([]) }).puntos;
        expect(p[0]).toMatchObject({ bloque_fin: '2026-09-20', bloque_completo: false });
    });
});

describe('motivos de seguimiento y temporadas explícitas en señales', () => {
    const j = (over = {}) => ({ jurado: 'X', categoria: 'B', tamano_muestra: 5, nivel_muestra: 'SUFICIENTE', racha_actual_rodeos_con_falta_reglamentaria: 0, racha_actual_rodeos_con_resultado_alterado: 0, ...over });
    const seg = js => generarSenales({ jurados: { detalle: js } }).find(s => s.codigo === 'JURADO_REINCIDENCIA');

    test('cada evidencia trae el motivo concreto (solo los que superan el umbral)', () => {
        const s = seg([j({ jurado: 'A', racha_actual_rodeos_con_resultado_alterado: 3 }), j({ jurado: 'B', racha_actual_rodeos_con_falta_reglamentaria: 2 }), j({ jurado: 'C', racha_actual_rodeos_con_falta_reglamentaria: 2, racha_actual_rodeos_con_resultado_alterado: 2 })]);
        const por = Object.fromEntries(s.evidencia.map(e => [e.jurado, e.motivos]));
        expect(por).toEqual({ A: ['RESULTADO_ALTERADO'], B: ['CASO_REGLAMENTARIO'], C: ['CASO_REGLAMENTARIO', 'RESULTADO_ALTERADO'] });
    });
    test('el criterio de inclusión no cambió (racha ≥ 2 y muestra ≥ limitada)', () => {
        expect(seg([j({ racha_actual_rodeos_con_resultado_alterado: 1 })])).toBeUndefined();
        expect(seg([j({ nivel_muestra: 'INSUFICIENTE', racha_actual_rodeos_con_resultado_alterado: 5 })])).toBeUndefined();
    });
    test('las señales de comparación nombran las temporadas cuando se conocen (dinámicas) y mantienen el texto anterior si no', () => {
        const comp = { actual: 35, historico: 28, variacion_pct: 25, disponible: true };
        const con = generarSenales({ comparacionColleras: comp, temporadas: { actual: '2030-2031', referencia: '2029-2030' } }).find(s => s.codigo === 'COLLERAS_SOBRE_HISTORICO');
        expect(con.detalle).toBe('Colleras completas: 35 (2030-2031) vs 28 (2029-2030) a fecha equivalente (+25 %).');
        expect(con.referencia).toMatch(/2029-2030/);
        const sin = generarSenales({ comparacionColleras: comp }).find(s => s.codigo === 'COLLERAS_SOBRE_HISTORICO');
        expect(sin.detalle).toBe('Colleras completas: 35 vs 28 a fecha equivalente (+25 %).');
    });
    test('la señal de menor actividad por asociación nombra la temporada de referencia', () => {
        const asociaciones = { catalogo_disponible: true, resumen: { umbral_caida_relevante_pct: 30 }, asociaciones: [{ alertable: true, estado: 'CAIDA_RELEVANTE', asociacion: 'A', rodeos_actuales: 1, rodeos_historicos_equivalentes: 4, variacion_pct: -75 }] };
        const s = generarSenales({ asociaciones, temporadas: { actual: '2026-2027', referencia: '2025-2026' } }).find(x => x.codigo === 'CAIDA_ACTIVIDAD_ASOCIACION');
        expect(s.detalle).toMatch(/2025-2026/);
        expect(s.detalle).toMatch(/2026-2027/);
    });
});

describe('colleras: cantidad de temporadas comparables (0, 1, 2 y 3)', () => {
    const med = (temporada, fecha, total) => ({ temporada, fecha_medicion: fecha, total_colleras: total, fecha_confirmada: true });
    // corte 2026-09-24 → equivalentes 25/09/2025, 26/09/2024, 21/09/2023
    function informe(historicoColleras) {
        const ds = {
            temporada: T, rodeos: [rod('a', '2026-09-19')], categoriaPorTipoId: { T_SEG: 'Segunda' },
            evaluaciones: [], casos: [], cartillas: [], asignaciones: [], notasSecundarias: [], usuarios: [], disponibilidad: [], notasJurado: [],
            catalogoAsociaciones: null, aliasAsociaciones: [], historicoRodeos: [hist('2025-09-20')], historicoColleras,
            fuentes: { asociaciones: { disponible: false }, historico_rodeos: { disponible: true }, historico_colleras: { disponible: true } }
        };
        const col = { total: 35, fechaDato: '2026-09-24T15:00:00.000Z', fuente: 'en_vivo', estado: 'actual', resumen: {}, detalle_error: null };
        return calcularInforme({ desde: '2026-09-18', hasta: '2026-09-24', hoy: '2026-09-24' }, ds, col, new Date('2026-09-24T15:00:00Z')).colleras.comparacion;
    }
    test('0 temporadas comparables', () => {
        const c = informe([med('2025-2026', '2026-02-01', 340)]);   // lejos de la fecha equivalente
        expect(c).toMatchObject({ disponible: false, temporadas_comparables: 0 });
    });
    test('1 temporada comparable', () => {
        const c = informe([med('2025-2026', '2025-09-28', 28)]);
        expect(c).toMatchObject({ disponible: true, temporadas_comparables: 1 });
    });
    test('2 temporadas comparables', () => {
        const c = informe([med('2025-2026', '2025-09-28', 28), med('2024-2025', '2024-09-26', 20)]);
        expect(c).toMatchObject({ temporadas_comparables: 2, promedio_historico: 24, maximo_historico: 28 });
    });
    test('3 temporadas comparables (SIN DATO nunca cuenta como 0 en el promedio)', () => {
        const c = informe([med('2025-2026', '2025-09-28', 28), med('2024-2025', '2024-09-26', 20), med('2023-2024', '2023-09-21', 12)]);
        expect(c).toMatchObject({ temporadas_comparables: 3, promedio_historico: 20, maximo_historico: 28 });
        const parcial = informe([med('2025-2026', '2025-09-28', 28), med('2024-2025', '2024-09-26', 20), med('2023-2024', '2023-01-05', 300)]);
        expect(parcial).toMatchObject({ temporadas_comparables: 2, promedio_historico: 24 });
    });
});
