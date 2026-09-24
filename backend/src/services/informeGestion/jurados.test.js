const { analizarJurados, nivelMuestra, pendiente, direccionTendencia } = require('./jurados');
const { analizarDisponibilidad, bloquesRodeo } = require('./disponibilidad');
const A = require('./agregados');

const rodeo = (id, fecha, extra = {}) => ({ id, fecha, club: 'C' + id, asociacion: 'A', tipo_rodeo_id: 'T', estado: 'activo', duracion_dias: 1, ...extra });
const ev = (id, rodeo_id, estado, extra = {}) => ({ id, rodeo_id, estado, nota_final: 5, resultados_alterados: false, anulada: false, ...extra });
const asig = (id, rodeo_id, usuario, cat, extra = {}) => ({ id, rodeo_id, usuario_pagado_id: usuario, tipo_persona: 'jurado', categoria_aplicada: cat, estado: 'activo', estado_designacion: 'aceptado', ...extra });

describe('muestra de jurados (configurable)', () => {
    test('1-2 INSUFICIENTE · 3-4 LIMITADA · 5+ SUFICIENTE', () => {
        expect([1, 2, 3, 4, 5, 20].map(n => nivelMuestra(n))).toEqual(['INSUFICIENTE', 'INSUFICIENTE', 'LIMITADA', 'LIMITADA', 'SUFICIENTE', 'SUFICIENTE']);
    });
    test('los umbrales se pueden sobrescribir por configuración', () => {
        const cfg = { JURADO: { MUESTRA_LIMITADA_DESDE: 2, MUESTRA_SUFICIENTE_DESDE: 3 } };
        expect(nivelMuestra(2, cfg)).toBe('LIMITADA');
        expect(nivelMuestra(3, cfg)).toBe('SUFICIENTE');
    });
    test('tendencia por pendiente: 6,2 → 4,7 es DESCENDENTE aunque el promedio parezca aceptable', () => {
        const p = pendiente([6.2, 6.0, 5.8, 5.1, 4.7]);
        expect(p).toBeLessThan(0);
        expect(direccionTendencia(p)).toBe('DESCENDENTE');
        expect(direccionTendencia(pendiente([5, 5, 5]))).toBe('ESTABLE');
        expect(pendiente([5, 6])).toBeNull(); // menos de 3 actuaciones: sin tendencia
    });
});

describe('analizarJurados', () => {
    const realizados = [
        rodeo('r1', '2026-09-01'), rodeo('r2', '2026-09-08'), rodeo('r3', '2026-09-15'), rodeo('r4', '2026-09-22'), rodeo('r5', '2026-09-29'),
        rodeo('rf', '2026-08-01')
    ];
    const evalPorRodeo = A.indexarEvaluaciones([
        ev('e1', 'r1', 'publicado', { resultados_alterados: false }),
        ev('e2', 'r2', 'publicado', { resultados_alterados: true }),
        ev('e3', 'r3', 'publicado', { resultados_alterados: true }),
        ev('e4', 'r4', 'borrador', { resultados_alterados: true }),
        ev('e5', 'r5', 'publicado', { resultados_alterados: false })
    ]);
    const casosPorEval = A.indexarPorClave([
        { evaluacion_id: 'e3', tipo_caso: 'reglamentaria', anulado: false },
        { evaluacion_id: 'e4', tipo_caso: 'interpretativa', anulado: false },
        { evaluacion_id: 'e5', tipo_caso: 'reglamentaria', anulado: false },
        { evaluacion_id: 'e5', tipo_caso: 'reglamentaria', anulado: true }
    ], 'evaluacion_id');
    // JUAN: 5 actuaciones en categoría B; LUIS: 1 actuación en A y luego cambió de categoría (actúa como C)
    const asignaciones = [
        asig('a1', 'r1', 'JUAN', 'B'), asig('a2', 'r2', 'JUAN', 'B'), asig('a3', 'r3', 'JUAN', 'B'), asig('a4', 'r4', 'JUAN', 'B'), asig('a5', 'r5', 'JUAN', 'B'),
        asig('b1', 'r1', 'LUIS', 'A'), asig('b2', 'r2', 'LUIS', 'C'),
        asig('x1', 'r1', 'ANULADO', 'B', { estado: 'anulado' }), asig('x2', 'r1', 'RECHAZADO', 'B', { estado_designacion: 'rechazado' }),
        asig('f1', 'rf', 'FUERA', 'B')   // rodeo fuera del conjunto de realizados analizado
    ];
    const notasPorAsignacion = { a1: { nota: 6.2 }, a2: { nota: 6.0 }, a3: { nota: 5.8 }, a4: { nota: 5.1 }, a5: { nota: 4.7 }, b1: { nota: 4.0 }, b2: { nota: 5.0 } };
    const usuariosPorId = { JUAN: { nombre_completo: 'JUAN PÉREZ' }, LUIS: { nombre_completo: 'LUIS SOTO' } };
    const notasSecPorRodeo = { r1: { nota_comision: 6, nota_delegado: 5 }, r2: { nota_comision: null, nota_delegado: 7 } };
    const r = analizarJurados({ realizados: realizados.slice(0, 5), evalPorRodeo, casosPorEval, asignaciones, usuariosPorId, notasPorAsignacion, notasSecPorRodeo, periodo: { desde: '2026-09-22', hasta: '2026-09-30' } });
    const juan = r.detalle.find(d => d.usuario_id === 'JUAN');

    test('ignora asignaciones anuladas, rechazadas y de rodeos fuera del conjunto', () => {
        expect(r.detalle.map(d => d.usuario_id).sort()).toEqual(['JUAN', 'LUIS', 'LUIS']);
    });

    test('métricas de un jurado con muestra suficiente', () => {
        expect(juan).toMatchObject({
            jurado: 'JUAN PÉREZ', categoria: 'B', rodeos: 5, rodeos_en_periodo: 2, nota_promedio: 5.56, n_notas: 5,
            rodeos_con_resultado_alterado_en_que_participo: 2, denominador_rodeos_publicados: 4, porcentaje_rodeos_con_resultado_alterado_en_que_participo: 50, // e4 es borrador: fuera del denominador
            casos_en_rodeos_en_que_participo: 3, casos_reglamentarios_en_rodeos_en_que_participo: 2, casos_apreciacion_en_rodeos_en_que_participo: 1,
            ultima_actuacion: '2026-09-29', tamano_muestra: 5, nivel_muestra: 'SUFICIENTE'
        });
        expect(juan.rodeos_con_situaciones_en_que_participo).toBe(3);
        expect(juan.ultimas_notas.map(x => x.nota)).toEqual([6.2, 6.0, 5.8, 5.1, 4.7]);
        expect(juan.tendencia.direccion).toBe('DESCENDENTE');
    });

    test('rachas recientes (para la señal de reincidencia): e3,e4,e5 tienen situaciones', () => {
        expect(juan.racha_actual_rodeos_con_situaciones).toBe(3);
        expect(juan.racha_actual_rodeos_con_resultado_alterado).toBe(0); // la última publicada (r5) no fue alterada
    });

    test('la categoría se toma de la asignación (snapshot): LUIS aparece en A y en C, sin reinterpretar', () => {
        const luis = r.detalle.filter(d => d.usuario_id === 'LUIS');
        expect(luis.map(d => d.categoria).sort()).toEqual(['A', 'C']);
        expect(luis.every(d => d.nivel_muestra === 'INSUFICIENTE' && d.tamano_muestra === 1)).toBe(true);
    });

    test('resumen por categoría: separa A/B/C, promedios de Comisión y Delegado separados, ranking solo con muestra mínima', () => {
        expect(Object.keys(r.por_categoria)).toEqual(expect.arrayContaining(['A', 'B', 'C']));
        expect(r.por_categoria.B).toMatchObject({ cantidad_jurados: 1, actuaciones: 5, nota_promedio: 5.56 });
        expect(r.por_categoria.B.modo_ranking).toBe('TABLA_UNICA');                       // 1 elegible: tabla única, sin Top/Bottom
        expect(r.por_categoria.B.desempeno_categoria.map(j => j.jurado)).toEqual(['JUAN PÉREZ']);
        expect(r.por_categoria.B.mejor_evaluados).toEqual([]);
        expect(r.por_categoria.A.mejor_evaluados).toEqual([]);         // LUIS tiene 1 actuación: no se rankea
        expect(r.por_categoria.A.excluidos_por_muestra).toBe(1);
        expect(r.por_categoria.B.promedio_comision).toBe(6);            // r2 tiene comisión NULL: no cuenta como 0
        expect(r.por_categoria.A.promedio_comision).toBe(6);            // r1
        expect(r.por_categoria.C.promedio_delegado).toBe(7);            // r2
    });
});

describe('disponibilidad declarada y utilización', () => {
    // 2026-09-05/06 (sáb/dom), 12/13, 19/20 (+ feriados 18/19 de septiembre: viernes 18 y sábado 19)
    const esDia = f => { const d = new Date(f + 'T00:00:00Z').getUTCDay(); return d === 0 || d === 6 || f === '2026-09-18'; };
    const rodeos = [rodeo('r1', '2026-09-05', { duracion_dias: 2 }), rodeo('r2', '2026-09-12'), rodeo('r3', '2026-09-19')];

    test('bloques de rodeo: fines de semana y feriado adyacente forman un solo bloque', () => {
        const b = bloquesRodeo('2026-09-01', '2026-09-20', esDia);
        expect(b.map(x => [x.inicio, x.fin])).toEqual([['2026-09-05', '2026-09-06'], ['2026-09-12', '2026-09-13'], ['2026-09-18', '2026-09-20']]);
    });

    const jurados = [
        { id: 'U1', nombre_completo: 'UNO', categoria: 'B' },
        { id: 'U2', nombre_completo: 'DOS', categoria: 'B' },
        { id: 'U3', nombre_completo: 'TRES', categoria: 'C' }
    ];
    const disponibilidad = [
        { usuario_pagado_id: 'U1', fecha: '2026-09-05' }, { usuario_pagado_id: 'U1', fecha: '2026-09-12' },
        { usuario_pagado_id: 'U2', fecha: '2026-09-05' }, { usuario_pagado_id: 'U2', fecha: '2026-09-12' }, { usuario_pagado_id: 'U2', fecha: '2026-09-19' }
    ];
    const asignaciones = [asig('a1', 'r1', 'U1', 'B'), asig('a2', 'r2', 'U1', 'B'), asig('a3', 'r1', 'U2', 'B'), asig('a4', 'r3', 'U3', 'C')];
    const d = analizarDisponibilidad({ desde: '2026-09-01', hasta: '2026-09-20', jurados, disponibilidad, asignaciones, rodeos }, { esDiaRodeo: esDia, rangoFechas: (f, n) => Array.from({ length: n }, (_, i) => new Date(new Date(f + 'T00:00:00Z').getTime() + i * 86400000).toISOString().slice(0, 10)) });
    const por = id => d.detalle.find(x => x.usuario_id === id);

    test('disponible 2 de 3 bloques y designado en ambos = utilización 100 %', () => {
        expect(por('U1')).toMatchObject({ estado: 'CON_DECLARACION', bloques_posibles: 3, bloques_con_disponibilidad_declarada: 2, porcentaje_disponibilidad_declarada: 66.7, bloques_designados: 2, utilizacion_sobre_disponibilidad_declarada: 100 });
    });
    test('disponible 3 y designado 1 = utilización 33,3 % (no se confunde con el caso anterior)', () => {
        expect(por('U2')).toMatchObject({ bloques_con_disponibilidad_declarada: 3, bloques_designados_con_disponibilidad_declarada: 1, utilizacion_sobre_disponibilidad_declarada: 33.3 });
    });
    test('sin registros NO es "no disponible": SIN_DECLARACION_REGISTRADA y utilización null; la designación se informa aparte', () => {
        expect(por('U3')).toMatchObject({ estado: 'SIN_DECLARACION_REGISTRADA', bloques_con_disponibilidad_declarada: 0, utilizacion_sobre_disponibilidad_declarada: null, bloques_designados_sin_declaracion: 1 });
        expect(JSON.stringify(d)).not.toMatch(/NO_DISPONIBLE|no disponible"/);
    });
    test('resumen y nota metodológica ("DISPONIBILIDAD DECLARADA")', () => {
        expect(d.resumen).toMatchObject({ jurados_analizados: 3, con_declaracion: 2, sin_declaracion_registrada: 1 });
        expect(d.nota_metodologica).toMatch(/DISPONIBILIDAD DECLARADA/);
    });
    test('disponibilidad fuera del rango consultado se ignora', () => {
        const x = analizarDisponibilidad({ desde: '2026-09-10', hasta: '2026-09-14', jurados, disponibilidad, asignaciones, rodeos }, { esDiaRodeo: esDia, rangoFechas: (f, n) => [f] });
        expect(x.bloques_posibles).toBe(1);
        expect(x.detalle.find(y => y.usuario_id === 'U1').bloques_con_disponibilidad_declarada).toBe(1);
    });
});

describe('ATRIBUCIÓN: resultado alterado / situaciones NO se asignan a un jurado individual', () => {
    // r1 tiene 2 jurados (JUAN y LUIS) y resultado alterado; r2 y r3 tienen 1 jurado cada uno.
    const realizados = [rodeo('r1', '2026-09-01'), rodeo('r2', '2026-09-08'), rodeo('r3', '2026-09-15')];
    const evalPorRodeo = A.indexarEvaluaciones([
        ev('e1', 'r1', 'publicado', { resultados_alterados: true }),
        ev('e2', 'r2', 'publicado', { resultados_alterados: false }),
        ev('e3', 'r3', 'publicado', { resultados_alterados: true })
    ]);
    const casosPorEval = A.indexarPorClave([{ evaluacion_id: 'e1', tipo_caso: 'reglamentaria', anulado: false }, { evaluacion_id: 'e1', tipo_caso: 'reglamentaria', anulado: false }], 'evaluacion_id');
    const asignaciones = [asig('a1', 'r1', 'JUAN', 'B'), asig('a2', 'r1', 'LUIS', 'B'), asig('a3', 'r2', 'JUAN', 'B'), asig('a4', 'r3', 'LUIS', 'B')];
    const r = analizarJurados({ realizados, evalPorRodeo, casosPorEval, asignaciones, usuariosPorId: { JUAN: { nombre_completo: 'JUAN' }, LUIS: { nombre_completo: 'LUIS' } }, notasPorAsignacion: {}, notasSecPorRodeo: {} });
    const juan = r.detalle.find(d => d.usuario_id === 'JUAN');
    const luis = r.detalle.find(d => d.usuario_id === 'LUIS');

    test('el JSON declara explícitamente que no hay atribución individual y deja los campos "atribuidos" en null', () => {
        [juan, luis].forEach(j => {
            expect(j.resultados_alterados_atribuidos).toBeNull();
            expect(j.situaciones_atribuidas).toBeNull();
            expect(j.atribucion).toMatchObject({ resultados_alterados: 'NO_ATRIBUIBLE_A_JURADO_INDIVIDUAL', situaciones: 'NO_ATRIBUIBLE_A_JURADO_INDIVIDUAL', nota: 'INDIVIDUAL' });
        });
        expect(r.atribucion.resultados_alterados).toBe('NO_ATRIBUIBLE_A_JURADO_INDIVIDUAL');
    });

    test('con 2 jurados en un rodeo alterado, AMBOS registran solo "participó en un rodeo con resultado alterado" (no "alteró")', () => {
        expect(juan).toMatchObject({ rodeos_con_resultado_alterado_en_que_participo: 1, denominador_rodeos_publicados: 2, rodeos_con_mas_de_un_jurado: 1 });
        expect(luis).toMatchObject({ rodeos_con_resultado_alterado_en_que_participo: 2, denominador_rodeos_publicados: 2, rodeos_con_mas_de_un_jurado: 1 });
    });

    test('ningún campo del jurado usa el nombre ambiguo "resultados_alterados" con un número (evita afirmar autoría)', () => {
        [juan, luis].forEach(j => {
            expect(Object.keys(j)).not.toContain('resultados_alterados');
            expect(Object.keys(j)).not.toContain('situaciones');
            expect(Object.keys(j)).not.toContain('porcentaje_alterados');
        });
        expect(JSON.stringify(r)).not.toMatch(/"resultados_alterados":d/);
    });

    test('a nivel categoría el rodeo compartido se cuenta UNA vez (no se duplica por jurado)', () => {
        const b = r.por_categoria.B;
        expect(b).toMatchObject({ rodeos_realizados: 3, rodeos_con_resultado_alterado: 2, denominador_rodeos_publicados: 3, rodeos_con_situaciones: 1 });
        expect(b.actuaciones).toBe(4);            // 4 participaciones, 3 rodeos distintos
        expect(b.porcentaje_rodeos_con_resultado_alterado).toBeCloseTo(66.7, 1);
    });

    test('la nota SÍ es individual (notas_rodeo por asignación)', () => {
        const x = analizarJurados({ realizados, evalPorRodeo, casosPorEval, asignaciones, usuariosPorId: {}, notasPorAsignacion: { a1: { nota: 6 }, a2: { nota: 4 } }, notasSecPorRodeo: {} });
        expect(x.detalle.find(d => d.usuario_id === 'JUAN').nota_promedio).toBe(6);
        expect(x.detalle.find(d => d.usuario_id === 'LUIS').nota_promedio).toBe(4);
    });
});

describe('ranking por categoría: prioridad de muestra', () => {
    const rodeoN = i => rodeo('q' + i, '2026-08-' + String(10 + i).padStart(2, '0'));
    // J1..J3 = SUFICIENTE (5 actuaciones); L1..L3 = LIMITADA (3); I1 = INSUFICIENTE (1, con la nota más alta)
    const jurados = [['J1', 5, 5.0], ['J2', 5, 5.5], ['J3', 5, 4.0], ['L1', 3, 6.9], ['L2', 3, 6.5], ['L3', 3, 2.0], ['I1', 1, 7.0]];
    const realizados = []; const asignaciones = []; const notas = {};
    let n = 0;
    jurados.forEach(([id, veces, nota]) => { for (let i = 0; i < veces; i++) { const r = rodeoN(n++); realizados.push(r); asignaciones.push(asig('a' + n, r.id, id, 'B')); notas['a' + n] = { nota }; } });
    const cat = analizarJurados({ realizados, evalPorRodeo: {}, casosPorEval: {}, asignaciones, usuariosPorId: {}, notasPorAsignacion: notas, notasSecPorRodeo: {} }).por_categoria.B;

    test('primero los de muestra SUFICIENTE (aunque un LIMITADO tenga mejor nota); luego se completa con LIMITADA', () => {
        // 6 elegibles → Top/Bottom de 3, sin repetir personas: SUFICIENTE primero, luego LIMITADA
        expect(cat.modo_ranking).toBe('TOP_BOTTOM');
        expect(cat.mejor_evaluados.map(j => j.usuario_id)).toEqual(['J2', 'J1', 'J3']);
        expect(cat.menor_evaluacion.map(j => j.usuario_id)).toEqual(['L3', 'L2', 'L1']);
    });
    test('la muestra INSUFICIENTE no ocupa el ranking (aunque tenga la nota más alta) y queda contada', () => {
        expect(cat.mejor_evaluados.map(j => j.usuario_id)).not.toContain('I1');
        expect(cat.elegibles_ranking).toBe(6);
        expect(cat.excluidos_por_muestra).toBe(1);
        expect(cat.criterio_ranking).toMatch(/SUFICIENTE/);
    });
    test('cada jurado del ranking trae su tamaño y nivel de muestra', () => {
        cat.mejor_evaluados.forEach(j => expect(j).toEqual(expect.objectContaining({ tamano_muestra: expect.any(Number), nivel_muestra: expect.stringMatching(/SUFICIENTE|LIMITADA/) })));
    });
});

describe('disponibilidad: destacados (lectura, no evaluación)', () => {
    const esDia = f => { const d = new Date(f + 'T00:00:00Z').getUTCDay(); return d === 0 || d === 6; };
    const rg = (f, n) => Array.from({ length: n }, (_, i) => new Date(new Date(f + 'T00:00:00Z').getTime() + i * 86400000).toISOString().slice(0, 10));
    const jurados = ['U1', 'U2', 'U3', 'U4'].map(id => ({ id, nombre_completo: id, categoria: 'B' }));
    const disp = [
        ...['2026-09-05', '2026-09-12', '2026-09-19'].map(f => ({ usuario_pagado_id: 'U1', fecha: f })),   // 3 bloques, 0 designados
        ...['2026-09-05', '2026-09-12'].map(f => ({ usuario_pagado_id: 'U2', fecha: f })),                  // 2 bloques, 2 designados
        { usuario_pagado_id: 'U3', fecha: '2026-09-05' }                                                     // 1 bloque, 0 designados
    ];
    const rodeos = [rodeo('r1', '2026-09-05'), rodeo('r2', '2026-09-12')];
    const asignaciones = [asig('a1', 'r1', 'U2', 'B'), asig('a2', 'r2', 'U2', 'B')];
    const d = analizarDisponibilidad({ desde: '2026-09-01', hasta: '2026-09-20', jurados, disponibilidad: disp, asignaciones, rodeos }, { esDiaRodeo: esDia, rangoFechas: rg });
    test('mayor disponibilidad sin utilizar: ordenado por brecha, sin incluir a quien no declaró ni a quien fue utilizado por completo', () => {
        expect(d.destacados.mayor_disponibilidad_sin_utilizar.map(x => x.usuario_id)).toEqual(['U1', 'U3']);
        expect(d.destacados.mayor_disponibilidad_sin_utilizar.length).toBeLessThanOrEqual(10);
    });
    test('menor disponibilidad declarada solo entre quienes SÍ declararon (quien no declaró = SIN_DECLARACION_REGISTRADA, no "baja")', () => {
        expect(d.destacados.menor_disponibilidad_declarada.map(x => x.usuario_id)).toEqual(['U3', 'U2', 'U1']);
        expect(d.detalle.find(x => x.usuario_id === 'U4').estado).toBe('SIN_DECLARACION_REGISTRADA');
        expect(d.destacados.criterio).toMatch(/no es una evaluación/);
    });
});

describe('regla de muestra por categoría: tabla única vs Top/Bottom', () => {
    // n jurados elegibles (3 actuaciones = LIMITADA), notas distintas y crecientes 4,0 + 0,1·i
    function categoria(n, extraInsuficientes = 0) {
        const realizados = [], asignaciones = [], notas = {}; let c = 0;
        const agregar = (id, veces, nota) => { for (let i = 0; i < veces; i++) { const r = rodeo('m' + c, '2026-08-01'); c++; realizados.push(r); asignaciones.push(asig('a' + c, r.id, id, 'A')); notas['a' + c] = { nota }; } };
        for (let i = 0; i < n; i++) agregar('E' + String(i).padStart(2, '0'), 3, Math.round((4 + i * 0.1) * 10) / 10);
        for (let i = 0; i < extraInsuficientes; i++) agregar('I' + i, 1, 6.9);
        const u = {}; asignaciones.forEach(a => { u[a.usuario_pagado_id] = { nombre_completo: a.usuario_pagado_id }; });
        return analizarJurados({ realizados, evalPorRodeo: {}, casosPorEval: {}, asignaciones, usuariosPorId: u, notasPorAsignacion: notas, notasSecPorRodeo: {} }).por_categoria.A;
    }

    test('4 elegibles → una única tabla ordenada de mayor a menor (sin Top/Bottom)', () => {
        const a = categoria(4);
        expect(a).toMatchObject({ modo_ranking: 'TABLA_UNICA', elegibles_ranking: 4, tamano_top_bottom: null, mejor_evaluados: [], menor_evaluacion: [] });
        expect(a.desempeno_categoria.map(j => j.jurado)).toEqual(['E03', 'E02', 'E01', 'E00']);
        a.desempeno_categoria.forEach(j => expect(j).toEqual(expect.objectContaining({ nota_promedio: expect.any(Number), tamano_muestra: 3, nivel_muestra: 'LIMITADA' })));
    });
    test('5 elegibles → sigue siendo tabla única', () => {
        const a = categoria(5);
        expect(a.modo_ranking).toBe('TABLA_UNICA');
        expect(a.desempeno_categoria.length).toBe(5);
        expect(a.mejor_evaluados).toEqual([]);
    });
    test('6 elegibles → Top/Bottom de 3 sin repetir a nadie', () => {
        const a = categoria(6);
        expect(a).toMatchObject({ modo_ranking: 'TOP_BOTTOM', tamano_top_bottom: 3, desempeno_categoria: [] });
        expect(a.mejor_evaluados.map(j => j.jurado)).toEqual(['E05', 'E04', 'E03']);
        expect(a.menor_evaluacion.map(j => j.jurado)).toEqual(['E00', 'E01', 'E02']);
    });
    test('10 elegibles → Top 5 y Bottom 5, disjuntos y cubriendo a todos', () => {
        const a = categoria(10);
        expect(a).toMatchObject({ modo_ranking: 'TOP_BOTTOM', tamano_top_bottom: 5 });
        const top = a.mejor_evaluados.map(j => j.jurado), bot = a.menor_evaluacion.map(j => j.jurado);
        expect(top).toEqual(['E09', 'E08', 'E07', 'E06', 'E05']);
        expect(bot).toEqual(['E00', 'E01', 'E02', 'E03', 'E04']);
        expect(top.filter(x => bot.includes(x))).toEqual([]);
    });
    test('en ningún caso una persona aparece en Mayor y Menor promedio a la vez (7, 8, 9 elegibles)', () => {
        [7, 8, 9].forEach(n => {
            const a = categoria(n);
            const top = a.mejor_evaluados.map(j => j.jurado), bot = a.menor_evaluacion.map(j => j.jurado);
            expect(top.filter(x => bot.includes(x))).toEqual([]);
            expect(top.length).toBe(Math.floor(n / 2) > 5 ? 5 : Math.floor(n / 2));
        });
    });
    test('la muestra INSUFICIENTE no cuenta como elegible (4 elegibles + 3 insuficientes = tabla única de 4)', () => {
        const a = categoria(4, 3);
        expect(a).toMatchObject({ modo_ranking: 'TABLA_UNICA', elegibles_ranking: 4, excluidos_por_muestra: 3 });
        expect(a.desempeno_categoria.length).toBe(4);
    });
    test('el promedio y los datos del jurado no se alteran por la regla de presentación', () => {
        const a4 = categoria(4), a6 = categoria(6);
        expect(a4.desempeno_categoria.find(j => j.jurado === 'E01').nota_promedio).toBe(4.1);
        expect(a6.mejor_evaluados[0].nota_promedio).toBe(4.5);
    });
});
