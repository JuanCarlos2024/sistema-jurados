// Evaluación de Desempeño Jurados — pruebas de las piezas puras (sin mock de
// Supabase, mismo patrón que matrizParticipacion.test.js: construirFilas /
// calcularBenchmarksCategoria / aplicarFiltrosVisuales / ordenar se prueban
// directamente con datos ya "traídos de la base", que es exactamente la
// forma en que obtenerDatosBase() los entrega.
jest.mock('../config/supabase', () => ({ from: jest.fn() }));
const supabase = require('../config/supabase');
const {
    round1, promedio, calcularPeriodo,
    construirFilas, calcularBenchmarksCategoria,
    aplicarFiltrosVisuales, ordenar, ORDENES,
    obtenerEvaluacionDesempeno
} = require('./evaluacionDesempenoJurados');

// ─── Mock de chain de Supabase: cada tabla devuelve un resultado fijo,
// independiente de los .eq()/.in()/.gte()/.lte() que se le encadenen (esos
// filtros YA se prueban contra Postgres real en otros módulos del proyecto;
// acá solo se verifica que el SERVICIO aplica su propio filtro JS de
// estado_designacion y que conecta correctamente cada tabla). ──────────────
function mockChain(result) {
    const obj = {};
    ['select', 'eq', 'neq', 'gte', 'lte', 'in', 'order', 'range', 'single', 'limit'].forEach(m => { obj[m] = jest.fn(() => obj); });
    obj.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
    return obj;
}

describe('calcularPeriodo', () => {
    test('exige desde y hasta', () => {
        expect(() => calcularPeriodo({})).toThrow('PERIODO_REQUERIDO');
        expect(() => calcularPeriodo({ desde: '2026-01-01' })).toThrow('PERIODO_REQUERIDO');
    });
    test('rechaza hasta < desde', () => {
        expect(() => calcularPeriodo({ desde: '2026-10-01', hasta: '2026-01-01' })).toThrow('PERIODO_INVALIDO');
    });
    test('acepta rango válido, incluso abarcando más de una temporada', () => {
        const p = calcularPeriodo({ desde: '2026-01-01', hasta: '2027-03-31' });
        expect(p).toEqual({ desde: '2026-01-01', hasta: '2027-03-31' });
    });
});

describe('round1 / promedio', () => {
    test('round1 redondea a un decimal y preserva null', () => {
        expect(round1(5.666)).toBe(5.7);
        expect(round1(null)).toBe(null);
    });
    test('promedio de arreglo vacío es null, nunca cero', () => {
        expect(promedio([])).toBe(null);
        expect(promedio([6, 7])).toBe(6.5);
    });
});

// ─── Fixture base: 2 jurados, 1 rodeo compartido + 1 rodeo individual ──────
function fixtureBase() {
    const jurados = [
        { id: 'j1', nombre_completo: 'Jurado Uno', categoria: 'A' },
        { id: 'j2', nombre_completo: 'Jurado Dos', categoria: 'A' },
        { id: 'j3', nombre_completo: 'Jurado Tres (sin rodeos)', categoria: 'B' }
    ];
    // j1 y j2 comparten el rodeo r1 (mismo rodeo, dos asignaciones distintas).
    // j1 además participó en r2 (individual).
    const todasAsigs = [
        { id: 'a1', usuario_pagado_id: 'j1', estado_designacion: null, rodeos: { id: 'r1', fecha: '2026-05-01' } },
        { id: 'a2', usuario_pagado_id: 'j2', estado_designacion: null, rodeos: { id: 'r1', fecha: '2026-05-01' } },
        { id: 'a3', usuario_pagado_id: 'j1', estado_designacion: null, rodeos: { id: 'r2', fecha: '2026-06-01' } }
    ];
    const evalMap = {
        r1: { rodeo_id: 'r1', resultados_alterados: true,  casos_whatsapp: 10 },
        r2: { rodeo_id: 'r2', resultados_alterados: false, casos_whatsapp: 0 }
    };
    const notaDelegadoMap = { r1: 6.0, r2: null };
    const notaComisionMap = { a1: 5.5 }; // solo j1 en r1 tiene nota de comisión individual
    const notaADMap = { a1: 5.6, a3: 5.8 }; // j1 tiene AD en ambos rodeos; j2 no tiene AD
    return { jurados, todasAsigs, evalMap, notaDelegadoMap, notaComisionMap, notaADMap };
}

describe('construirFilas', () => {
    test('incluye a TODOS los jurados activos, incluso sin rodeos en el período', () => {
        const filas = construirFilas(fixtureBase());
        const j3 = filas.find(f => f.usuario_pagado_id === 'j3');
        expect(j3.total_rodeos).toBe(0);
        expect(j3.altera_resultado).toBe(0);
        expect(j3.nota_delegado_promedio).toBe(null);
        expect(j3.pct_alterado_individual).toBe(null); // nunca divide por cero
    });

    test('cuenta rodeos DISTINTOS (dedup), nunca asignaciones', () => {
        const base = fixtureBase();
        // Duplicamos la asignación de j1 en r1 (p.ej. reemplazo con fila residual) — no debe contarse dos veces.
        base.todasAsigs.push({ id: 'a1-dup', usuario_pagado_id: 'j1', estado_designacion: null, rodeos: { id: 'r1', fecha: '2026-05-01' } });
        const filas = construirFilas(base);
        const j1 = filas.find(f => f.usuario_pagado_id === 'j1');
        expect(j1.total_rodeos).toBe(2); // r1 y r2, nunca 3
    });

    // El filtro por estado_designacion!=='rechazado' ocurre en obtenerDatosBase
    // (antes de llamar a construirFilas) — ver el test de integración de
    // obtenerDatosBase más abajo. construirFilas confía en recibir ya ese
    // universo filtrado, igual que matrizParticipacion.js.

    test('Altera resultado: rodeo compartido se atribuye a AMBOS jurados sin dividir', () => {
        const filas = construirFilas(fixtureBase());
        const j1 = filas.find(f => f.usuario_pagado_id === 'j1');
        const j2 = filas.find(f => f.usuario_pagado_id === 'j2');
        expect(j1.altera_resultado).toBe(1); // r1 altera, r2 no
        expect(j2.altera_resultado).toBe(1); // mismo r1, mismo conteo completo (no 0.5)
        expect(j1.pct_alterado_individual).toBe(50.0); // 1 de 2
        expect(j2.pct_alterado_individual).toBe(100.0); // 1 de 1
    });

    test('Consultas WSP: total del rodeo se atribuye completo a cada participante, sin dividir entre ellos', () => {
        const filas = construirFilas(fixtureBase());
        const j1 = filas.find(f => f.usuario_pagado_id === 'j1');
        const j2 = filas.find(f => f.usuario_pagado_id === 'j2');
        expect(j1.consultas_wsp_total).toBe(10); // r1 aporta 10, r2 aporta 0
        expect(j2.consultas_wsp_total).toBe(10); // el MISMO 10 de r1, no 5 (no se divide)
        expect(j1.consultas_wsp_rodeos).toBe(1); // solo r1 tuvo consultas > 0
        expect(j2.consultas_wsp_rodeos).toBe(1);
    });

    test('Nota Delegado: nota del rodeo atribuida a cada participante; rodeos sin nota no cuentan en el promedio', () => {
        const filas = construirFilas(fixtureBase());
        const j1 = filas.find(f => f.usuario_pagado_id === 'j1');
        // j1: r1=6.0, r2=null -> promedio solo sobre r1 = 6.0 (nunca 3.0 tratando null como 0)
        expect(j1.nota_delegado_promedio).toBe(6.0);
    });

    test('Nota Comisión: grano real por jurado (asignacion_id), nunca compartida entre participantes del mismo rodeo', () => {
        const filas = construirFilas(fixtureBase());
        const j1 = filas.find(f => f.usuario_pagado_id === 'j1');
        const j2 = filas.find(f => f.usuario_pagado_id === 'j2');
        expect(j1.nota_comision_promedio).toBe(5.5);
        expect(j2.nota_comision_promedio).toBe(null); // j2 no tiene evaluación individual de comisión, aunque compartió el rodeo con j1
    });

    test('Nota Área Deportiva: grano por asignación, promedia solo las notas con fuente evaluacion_tecnica', () => {
        const filas = construirFilas(fixtureBase());
        const j1 = filas.find(f => f.usuario_pagado_id === 'j1');
        const j2 = filas.find(f => f.usuario_pagado_id === 'j2');
        expect(j1.nota_ad_promedio).toBe(round1((5.6 + 5.8) / 2));
        expect(j2.nota_ad_promedio).toBe(null);
    });

    describe('Promedio D + Com. (regla confirmada por el usuario)', () => {
        test('ambas notas existen -> promedio de las dos', () => {
            const filas = construirFilas(fixtureBase());
            const j1 = filas.find(f => f.usuario_pagado_id === 'j1');
            expect(j1.promedio_d_com).toBe(round1((6.0 + 5.5) / 2));
        });
        test('solo una existe -> se muestra esa, nunca se inventa la otra', () => {
            const base = fixtureBase();
            delete base.notaComisionMap.a1; // j1 pierde su nota de comisión, le queda solo delegado
            const filas = construirFilas(base);
            const j1 = filas.find(f => f.usuario_pagado_id === 'j1');
            expect(j1.promedio_d_com).toBe(6.0);
        });
        test('ninguna existe -> null (N.I.), nunca cero', () => {
            const filas = construirFilas(fixtureBase());
            const j3 = filas.find(f => f.usuario_pagado_id === 'j3');
            expect(j3.promedio_d_com).toBe(null);
        });
    });
});

describe('calcularBenchmarksCategoria', () => {
    test('% alterado por categoría: mismo valor para TODOS los jurados de la categoría (suma/suma, no promedio de promedios)', () => {
        const filas = calcularBenchmarksCategoria(construirFilas(fixtureBase()));
        const j1 = filas.find(f => f.usuario_pagado_id === 'j1'); // cat A: alterado=1, rodeos=2
        const j2 = filas.find(f => f.usuario_pagado_id === 'j2'); // cat A: alterado=1, rodeos=1
        // Categoría A combinada: (1+1) alterados / (2+1) rodeos = 2/3 = 66.7%
        const esperado = round1((2 / 3) * 100);
        expect(j1.pct_alterado_categoria).toBe(esperado);
        expect(j2.pct_alterado_categoria).toBe(esperado); // EXACTAMENTE el mismo valor, no un benchmark distinto excluyéndose a sí mismo
    });

    test('categoría sin ningún rodeo -> null, nunca división por cero', () => {
        const filas = calcularBenchmarksCategoria(construirFilas(fixtureBase()));
        const j3 = filas.find(f => f.usuario_pagado_id === 'j3'); // cat B, solo, sin rodeos
        expect(j3.pct_alterado_categoria).toBe(null);
    });

    test('Promedio categoría (AD): promedia solo entre quienes SÍ tienen Nota AD, nunca trata ausentes como 0', () => {
        const filas = calcularBenchmarksCategoria(construirFilas(fixtureBase()));
        const j1 = filas.find(f => f.usuario_pagado_id === 'j1'); // AD = 5.7
        const j2 = filas.find(f => f.usuario_pagado_id === 'j2'); // sin AD
        // Solo j1 aporta AD en categoría A -> promedio_categoria_ad = el propio AD de j1 (5.7), no (5.7+0)/2
        expect(j1.promedio_categoria_ad).toBe(j1.nota_ad_promedio);
        expect(j2.promedio_categoria_ad).toBe(j1.nota_ad_promedio); // mismo valor de referencia para toda la categoría
    });

    test('no muta ni expone los campos crudos internos', () => {
        const filas = calcularBenchmarksCategoria(construirFilas(fixtureBase()));
        filas.forEach(f => expect(f._crudo).toBeUndefined());
    });
});

describe('aplicarFiltrosVisuales', () => {
    const filas = calcularBenchmarksCategoria(construirFilas(fixtureBase()));

    test('filtra por categoría sin afectar los valores ya calculados (el universo ya se calculó antes)', () => {
        const soloA = aplicarFiltrosVisuales(filas, { categoria: 'A', search: '' });
        expect(soloA.length).toBe(2);
        expect(soloA.every(f => f.categoria === 'A')).toBe(true);
    });

    test('búsqueda por nombre, insensible a mayúsculas', () => {
        const res = aplicarFiltrosVisuales(filas, { categoria: '', search: 'uno' });
        expect(res.length).toBe(1);
        expect(res[0].nombre).toBe('Jurado Uno');
    });

    test('sin filtros, devuelve a TODOS los jurados (incluso sin rodeos)', () => {
        const res = aplicarFiltrosVisuales(filas, { categoria: '', search: '' });
        expect(res.length).toBe(3);
    });
});

describe('ordenar', () => {
    const filas = calcularBenchmarksCategoria(construirFilas(fixtureBase()));

    test('total_rodeos_desc', () => {
        const res = ordenar(filas, 'total_rodeos_desc');
        expect(res[0].usuario_pagado_id).toBe('j1'); // 2 rodeos > 1 (j2) > 0 (j3)
    });

    test('nota_comision_desc deja sin nota (null) al final', () => {
        const res = ordenar(filas, 'nota_comision_desc');
        expect(res[0].usuario_pagado_id).toBe('j1'); // único con nota de comisión
        expect(res[res.length - 1].nota_comision_promedio).toBe(null);
    });

    test('order desconocido cae al default (total_rodeos_desc) sin lanzar error', () => {
        expect(() => ordenar(filas, 'orden_inexistente')).not.toThrow();
    });

    test('ORDENES expone un par asc/desc para cada columna ordenable del frontend', () => {
        ['total_rodeos', 'pct_alterado', 'pct_categoria', 'wsp_total', 'wsp_rodeos',
         'mal_jurado', 'nota_delegado', 'nota_comision', 'promedio_d_com', 'nota_ad',
         'promedio_categoria_ad', 'altera_resultado'].forEach(base => {
            expect(ORDENES[base + '_asc']).toBeInstanceOf(Function);
            expect(ORDENES[base + '_desc']).toBeInstanceOf(Function);
        });
    });
});

// ─── obtenerEvaluacionDesempeno: integración con Supabase mockeado — confirma
// que el filtro JS de estado_designacion='rechazado' realmente se aplica
// (responsabilidad de obtenerDatosBase, no de construirFilas — ver nota
// arriba) y que el reporte incluye a un jurado sin ninguna fila en
// evaluacion_desempeno_manual (Mal jurado/Análisis técnico quedan null,
// nunca inventados). ─────────────────────────────────────────────────────
describe('obtenerEvaluacionDesempeno (integración, Supabase mockeado)', () => {
    beforeEach(() => {
        supabase.from.mockImplementation((tabla) => {
            const TABLAS = {
                usuarios_pagados: mockChain({
                    data: [{ id: 'j1', nombre_completo: 'Jurado Uno', categoria: 'A' }], error: null
                }),
                asignaciones: mockChain({
                    data: [
                        { id: 'a1', usuario_pagado_id: 'j1', estado_designacion: null, rodeos: { id: 'r1', fecha: '2026-05-01' } },
                        { id: 'a2', usuario_pagado_id: 'j1', estado_designacion: 'rechazado', rodeos: { id: 'r2', fecha: '2026-05-02' } }
                    ], error: null
                }),
                evaluaciones: mockChain({ data: [{ rodeo_id: 'r1', resultados_alterados: true, casos_whatsapp: 4 }], error: null }),
                rodeo_notas_secundarias: mockChain({ data: [{ rodeo_id: 'r1', nota_delegado: 6.0 }], error: null }),
                comision_evaluaciones_jurado: mockChain({ data: [], error: null }),
                notas_rodeo: mockChain({ data: [], error: null }),
                evaluacion_desempeno_manual: mockChain({ data: [], error: null })
            };
            return TABLAS[tabla] || mockChain({ data: [], error: null });
        });
    });

    test('la asignación rechazada NUNCA se cuenta como rodeo del período', async () => {
        const { filas } = await obtenerEvaluacionDesempeno({ desde: '2026-01-01', hasta: '2026-12-31' });
        const j1 = filas.find(f => f.usuario_pagado_id === 'j1');
        expect(j1.total_rodeos).toBe(1); // solo r1; r2 fue rechazada
        expect(j1.altera_resultado).toBe(1);
        expect(j1.consultas_wsp_total).toBe(4);
    });

    test('sin fila en evaluacion_desempeno_manual -> mal_jurado y analisis_tecnico quedan null, nunca 0/""', async () => {
        const { filas } = await obtenerEvaluacionDesempeno({ desde: '2026-01-01', hasta: '2026-12-31' });
        const j1 = filas.find(f => f.usuario_pagado_id === 'j1');
        expect(j1.mal_jurado).toBe(null);
        expect(j1.analisis_tecnico).toBe(null);
    });
});
