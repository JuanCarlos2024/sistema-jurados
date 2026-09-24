jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../colleras-completas', () => ({ obtenerCollerasCompletas: jest.fn() }));

const { calcularInforme } = require('./informe');
const { excluirDatosPrueba } = require('./exclusionPrueba');
const { cargarDataset } = require('./cargaDatos');

const T = { id: 't1', nombre: '2026-2027', inicio: '2026-04-01', fin: '2027-03-31', fuente: 'test' };
const rod = (id, fecha, asociacion, extra = {}) => ({ id, fecha, club: 'C' + id, asociacion, tipo_rodeo_id: 'T_SEG', tipo_rodeo_nombre: 'Provincial', categoria_rodeo_nombre: null, estado: 'activo', duracion_dias: 1, es_prueba: false, ...extra });
const usr = (id, nombre, extra = {}) => ({ id, nombre_completo: nombre, categoria: 'A', activo: true, estado_usuario: 'activo', tipo_persona: 'jurado', es_prueba: false, ...extra });
const asig = (id, rodeo, usuario, extra = {}) => ({ id, rodeo_id: rodeo, usuario_pagado_id: usuario, tipo_persona: 'jurado', categoria_aplicada: 'A', estado: 'activo', estado_designacion: 'aceptado', ...extra });

// Dataset: 3 jurados reales-o-de-prueba (JA, JB, JT) con 3 actuaciones cada uno en categoría A + un rodeo real (LP, solo con JT)
// + un rodeo candidato a "de prueba" (RP) con jurado real JA.
function dataset({ jtPrueba = false, rpPrueba = false, lpPrueba = false } = {}) {
    const rodeos = [
        rod('x1', '2026-06-06', 'ARAUCO'), rod('x2', '2026-06-13', 'ARAUCO'), rod('x3', '2026-06-20', 'COLCHAGUA'),
        rod('LP', '2026-06-27', 'SANTIAGO PONIENTE', { es_prueba: lpPrueba }),
        rod('RP', '2026-09-19', 'ASOC PRUEBA', { tipo_rodeo_id: 'T_PRI', es_prueba: rpPrueba }),
        rod('fut', '2026-09-26', 'OSORNO')
    ];
    const asignaciones = [];
    const notas = [];
    let n = 0;
    const acto = (rodeoId, usuarioId, nota) => { n++; asignaciones.push(asig('as' + n, rodeoId, usuarioId)); notas.push({ asignacion_id: 'as' + n, nota }); };
    ['x1', 'x2', 'x3'].forEach(id => { acto(id, 'JA', 6); acto(id, 'JB', 5); acto(id, 'JT', 7); });
    acto('LP', 'JT', 6.5);   // Lo Prado: rodeo real donde solo participó la cuenta de prueba
    acto('RP', 'JA', 4);     // rodeo candidato a prueba con jurado real
    return {
        temporada: T,
        rodeos,
        categoriaPorTipoId: { T_SEG: 'Segunda', T_PRI: 'Primera' },
        evaluaciones: [
            { id: 'eLP', rodeo_id: 'LP', estado: 'publicado', nota_final: 5.5, resultados_alterados: true, anulada: false },
            { id: 'eRP', rodeo_id: 'RP', estado: 'publicado', nota_final: 3, resultados_alterados: true, anulada: false },
            { id: 'ex1', rodeo_id: 'x1', estado: 'publicado', nota_final: 6, resultados_alterados: false, anulada: false }
        ],
        casos: [
            { evaluacion_id: 'eLP', tipo_caso: 'reglamentaria', anulado: false },
            { evaluacion_id: 'eRP', tipo_caso: 'reglamentaria', anulado: false }, { evaluacion_id: 'eRP', tipo_caso: 'interpretativa', anulado: false }
        ],
        cartillas: [
            { rodeo_id: 'LP', estado: 'enviada', datos: { hubo_ganado_fuera_peso: 'si', caseta_adecuada: 'si' } },
            { rodeo_id: 'RP', estado: 'enviada', datos: { hubo_ganado_fuera_peso: 'si', caseta_adecuada: 'no' } }
        ],
        asignaciones,
        notasSecundarias: [{ rodeo_id: 'RP', nota_comision: 2, nota_delegado: null }],
        usuarios: [usr('JA', 'JURADO A'), usr('JB', 'JURADO B'), usr('JT', 'JURADO T', { es_prueba: jtPrueba }), usr('JC', 'JURADO SIN ACTUACIONES')],
        disponibilidad: [
            { usuario_pagado_id: 'JA', fecha: '2026-06-06' }, { usuario_pagado_id: 'JB', fecha: '2026-06-06' },
            { usuario_pagado_id: 'JT', fecha: '2026-06-06' }, { usuario_pagado_id: 'JT', fecha: '2026-06-13' }
        ],
        notasJurado: notas,
        catalogoAsociaciones: [
            { id: 'A1', nombre: 'ARAUCO', nombre_normalizado: 'arauco', activa: true, es_especial: false, incluir_en_alertas: true },
            { id: 'A2', nombre: 'COLCHAGUA', nombre_normalizado: 'colchagua', activa: true, es_especial: false, incluir_en_alertas: true }
        ],
        aliasAsociaciones: [],
        historicoRodeos: [
            { temporada: '2025-2026', fecha_rodeo: '2025-06-07', asociacion_id: 'A1', asociacion_normalizada: null, tipo_rodeo: 'Provincial', categoria: 'Segunda' },
            { temporada: '2025-2026', fecha_rodeo: '2025-06-14', asociacion_id: 'A2', asociacion_normalizada: null, tipo_rodeo: 'Provincial', categoria: 'Segunda' },
            { temporada: '2025-2026', fecha_rodeo: '2025-09-20', asociacion_id: 'A1', asociacion_normalizada: null, tipo_rodeo: 'Provincial', categoria: 'Segunda' },
            { temporada: '2025-2026', fecha_rodeo: '2025-12-13', asociacion_id: 'A2', asociacion_normalizada: null, tipo_rodeo: 'Provincial', categoria: 'Segunda' }
        ],
        historicoColleras: null,
        fuentes: { asociaciones: { disponible: true }, historico_rodeos: { disponible: true }, historico_colleras: { disponible: false } }
    };
}
const COLLERAS = { total: null, estado: 'no_disponible', resumen: {}, detalle_error: null };
const params = { desde: '2026-09-18', hasta: '2026-09-20', hoy: '2026-09-24' };
const generar = ds => calcularInforme(params, ds, COLLERAS, new Date('2026-09-24T15:00:00Z'));
const sinMetadata = inf => { const { metadata, ...resto } = inf; return resto; };
const catA = inf => inf.jurados.por_categoria.A;

// Copia del dataset sin un rodeo (y todo lo que cuelga de él): equivale a "el rodeo no existe" para el informe.
function sinRodeoFisico(ds, id) {
    const evs = new Set(ds.evaluaciones.filter(e => e.rodeo_id === id).map(e => e.id));
    const asigs = new Set(ds.asignaciones.filter(a => a.rodeo_id === id).map(a => a.id));
    return {
        ...ds,
        rodeos: ds.rodeos.filter(r => r.id !== id),
        evaluaciones: ds.evaluaciones.filter(e => e.rodeo_id !== id),
        casos: ds.casos.filter(c => !evs.has(c.evaluacion_id)),
        cartillas: ds.cartillas.filter(c => c.rodeo_id !== id),
        notasSecundarias: ds.notasSecundarias.filter(n => n.rodeo_id !== id),
        asignaciones: ds.asignaciones.filter(a => a.rodeo_id !== id),
        notasJurado: ds.notasJurado.filter(n => !asigs.has(n.asignacion_id))
    };
}

describe('sin marcas: el motor se comporta igual que antes', () => {
    const inf = generar(dataset());
    test('metadata.datos_excluidos en cero y todos los jurados en la categoría A', () => {
        expect(inf.metadata.datos_excluidos).toEqual({ usuarios_prueba: 0, rodeos_prueba: 0 });
        expect(catA(inf)).toMatchObject({ cantidad_jurados: 3, elegibles_ranking: 3 });
        expect(inf.acumulado_temporada.rodeos.realizados).toBe(5);
    });
    test('un dataset sin la columna es_prueba (filas antiguas) funciona igual', () => {
        const ds = dataset();
        ds.rodeos.forEach(r => { delete r.es_prueba; }); ds.usuarios.forEach(u => { delete u.es_prueba; });
        expect(sinMetadata(generar(ds))).toEqual(sinMetadata(inf));
    });
});

describe('USUARIO de prueba: excluido de todo análisis personal', () => {
    const con = generar(dataset());
    const sin = generar(dataset({ jtPrueba: true }));

    test('excluido del ranking / tabla de la categoría', () => {
        expect(catA(con).desempeno_categoria.map(j => j.jurado)).toContain('JURADO T');
        expect(catA(sin).desempeno_categoria.map(j => j.jurado)).not.toContain('JURADO T');
        expect(catA(sin).elegibles_ranking).toBe(catA(con).elegibles_ranking - 1);
        expect(JSON.stringify(sin.jurados)).not.toContain('JURADO T');
    });
    test('excluido del promedio de categoría, muestra y actuaciones', () => {
        expect(catA(con)).toMatchObject({ cantidad_jurados: 3, nota_promedio: expect.any(Number) });
        expect(catA(sin).cantidad_jurados).toBe(2);
        expect(catA(sin).actuaciones).toBe(catA(con).actuaciones - 4);     // 3 actuaciones normales + Lo Prado
        expect(catA(sin).nota_promedio).toBeLessThan(catA(con).nota_promedio);   // JT tenía las notas más altas
        expect(sin.jurados.resumen.jurados_distintos_con_actuaciones).toBe(con.jurados.resumen.jurados_distintos_con_actuaciones - 1);
    });
    test('excluido de disponibilidad declarada y utilización (universo personal)', () => {
        expect(con.disponibilidad.universo.jurados_considerados).toBe(4);
        expect(sin.disponibilidad.universo.jurados_considerados).toBe(3);
        expect(sin.disponibilidad.acumulado_temporada.resumen.jurados_analizados).toBe(3);
        expect(sin.disponibilidad.acumulado_temporada.resumen.con_declaracion).toBe(2);
        expect(con.disponibilidad.acumulado_temporada.resumen.con_declaracion).toBe(3);
    });
    test('conteo en metadata (solo números)', () => {
        expect(sin.metadata.datos_excluidos).toEqual({ usuarios_prueba: 1, rodeos_prueba: 0 });
    });

    test('USUARIO prueba + RODEO real (caso Lo Prado): la persona sale, el rodeo y sus datos siguen contando', () => {
        // LP solo tenía como jurado a la cuenta de prueba
        expect(sin.acumulado_temporada.rodeos.realizados).toBe(con.acumulado_temporada.rodeos.realizados);
        expect(sin.acumulado_temporada.rodeos.por_asociacion.map(x => x.clave)).toContain('SANTIAGO PONIENTE');
        expect(sin.cobertura.acumulado_temporada.evaluaciones_existentes.numerador).toBe(con.cobertura.acumulado_temporada.evaluaciones_existentes.numerador);
        expect(sin.cobertura.acumulado_temporada.evaluaciones_publicadas.numerador).toBe(con.cobertura.acumulado_temporada.evaluaciones_publicadas.numerador);
        expect(sin.cobertura.acumulado_temporada.cartillas_jurado.numerador).toBe(con.cobertura.acumulado_temporada.cartillas_jurado.numerador);
        expect(sin.evaluaciones.acumulado_temporada.faltas.total_casos).toBe(con.evaluaciones.acumulado_temporada.faltas.total_casos);
        expect(sin.evaluaciones.acumulado_temporada.faltas.reglamentarias.casos_total).toBeGreaterThanOrEqual(1);
        expect(sin.periodo).toEqual(con.periodo);
        expect(sin.comparacion).toEqual(con.comparacion);
        expect(sin.proyecciones).toEqual(con.proyecciones);
        expect(sin.series).toEqual(con.series);
        expect(sin.asociaciones).toEqual(con.asociaciones);
        expect(sin.metadata.datos_excluidos.rodeos_prueba).toBe(0);
    });
});

describe('RODEO de prueba: excluido de las estadísticas ejecutivas aunque tenga usuarios reales', () => {
    const con = generar(dataset());
    const sin = generar(dataset({ rpPrueba: true }));
    const ref = generar(sinRodeoFisico(dataset(), 'RP'));   // el rodeo "no existe"

    test('el informe es idéntico a que el rodeo no existiera (salvo metadata)', () => {
        expect(sinMetadata(sin)).toEqual(sinMetadata(ref));
        expect(sinMetadata(sin)).not.toEqual(sinMetadata(con));
    });
    test('excluido del total y de los realizados', () => {
        expect(con.periodo.rodeos.realizados).toBe(1);
        expect(sin.periodo.rodeos.realizados).toBe(0);
        expect(sin.acumulado_temporada.rodeos.realizados).toBe(con.acumulado_temporada.rodeos.realizados - 1);
        expect(sin.periodo.rodeos.total).toBe(con.periodo.rodeos.total - 1);
    });
    test('excluido de categorías (Primera) y de asociaciones', () => {
        const prim = i => (i.acumulado_temporada.rodeos.por_categoria.find(x => x.clave === 'Primera') || { cantidad: 0 }).cantidad;
        expect(prim(con)).toBe(1); expect(prim(sin)).toBe(0);
        expect(con.acumulado_temporada.rodeos.por_asociacion.map(x => x.clave)).toContain('ASOC PRUEBA');
        expect(sin.acumulado_temporada.rodeos.por_asociacion.map(x => x.clave)).not.toContain('ASOC PRUEBA');
        expect(JSON.stringify(sin.asociaciones)).not.toContain('ASOC PRUEBA');
    });
    test('excluido de evaluaciones, coberturas, resultados alterados y cartillas', () => {
        const cob = i => i.cobertura.acumulado_temporada;
        expect(cob(sin).evaluaciones_existentes.numerador).toBe(cob(con).evaluaciones_existentes.numerador - 1);
        expect(cob(sin).evaluaciones_publicadas.numerador).toBe(cob(con).evaluaciones_publicadas.numerador - 1);
        expect(cob(sin).evaluaciones_publicadas.denominador).toBe(cob(con).evaluaciones_publicadas.denominador - 1);
        expect(cob(sin).cartillas_jurado.numerador).toBe(cob(con).cartillas_jurado.numerador - 1);
        expect(cob(sin).nota_comision.numerador).toBe(cob(con).nota_comision.numerador - 1);
        expect(JSON.stringify(sin.evaluaciones.acumulado_temporada)).not.toEqual(JSON.stringify(con.evaluaciones.acumulado_temporada));
    });
    test('excluido de faltas (casos) y de ganado / caseta de la cartilla', () => {
        const f = i => i.evaluaciones.acumulado_temporada.faltas;
        expect(f(sin).total_casos).toBe(f(con).total_casos - 2);
        expect(f(sin).apreciacion.casos_total).toBe(f(con).apreciacion.casos_total - 1);
        expect(f(sin).reglamentarias.casos_total).toBe(f(con).reglamentarias.casos_total - 1);
        expect(sin.evaluaciones.acumulado_temporada.caseta).toEqual(ref.evaluaciones.acumulado_temporada.caseta);
        expect(sin.evaluaciones.acumulado_temporada.ganado).toEqual(ref.evaluaciones.acumulado_temporada.ganado);
        expect(JSON.stringify(sin.evaluaciones.acumulado_temporada.caseta)).not.toEqual(JSON.stringify(con.evaluaciones.acumulado_temporada.caseta));
    });
    test('excluido de la comparación histórica, proyección y series', () => {
        expect(sin.comparacion.rodeos.actual).toBe(con.comparacion.rodeos.actual - 1);
        expect(sin.proyecciones.rodeos.datos_base.actual).toBe(con.proyecciones.rodeos.datos_base.actual - 1);
        expect(sin.proyecciones).toEqual(ref.proyecciones);
        expect(sin.series).toEqual(ref.series);
        expect(JSON.stringify(sin.series)).not.toEqual(JSON.stringify(con.series));
    });
    test('el usuario real NO se pierde como persona: solo pierde la actuación en el rodeo de prueba', () => {
        const ja = i => catA(i).desempeno_categoria.find(j => j.jurado === 'JURADO A');
        expect(ja(con).tamano_muestra).toBe(4);
        expect(ja(sin).tamano_muestra).toBe(3);
        expect(sin.jurados.resumen.jurados_distintos_con_actuaciones).toBe(con.jurados.resumen.jurados_distintos_con_actuaciones);
        expect(sin.disponibilidad.universo.jurados_considerados).toBe(con.disponibilidad.universo.jurados_considerados);
    });
    test('conteo en metadata', () => {
        expect(sin.metadata.datos_excluidos).toEqual({ usuarios_prueba: 0, rodeos_prueba: 1 });
    });
});

describe('ambos conceptos son independientes y se combinan', () => {
    test('usuario prueba + rodeo prueba distintos: ambos conteos y ambos efectos', () => {
        const inf = generar(dataset({ jtPrueba: true, rpPrueba: true }));
        expect(inf.metadata.datos_excluidos).toEqual({ usuarios_prueba: 1, rodeos_prueba: 1 });
        expect(catA(inf).cantidad_jurados).toBe(2);
        expect(inf.acumulado_temporada.rodeos.realizados).toBe(4);
    });
    test('el metadata no expone nombres ni ids', () => {
        const inf = generar(dataset({ jtPrueba: true, rpPrueba: true }));
        expect(JSON.stringify(inf.metadata)).not.toMatch(/JURADO T|"JT"|"RP"|ASOC PRUEBA/);
    });
    test('idsUsuariosPrueba (cuentas de otro tipo, p. ej. delegados) se cuentan y no afectan al análisis de jurados', () => {
        const ds = dataset(); ds.idsUsuariosPrueba = ['DELEG-1'];
        const inf = generar(ds);
        expect(inf.metadata.datos_excluidos).toEqual({ usuarios_prueba: 1, rodeos_prueba: 0 });
        expect(sinMetadata(inf)).toEqual(sinMetadata(generar(dataset())));
    });
    test('excluirDatosPrueba es pura: no muta el dataset original', () => {
        const ds = dataset({ jtPrueba: true, rpPrueba: true });
        const copia = JSON.stringify(ds);
        excluirDatosPrueba(ds);
        expect(JSON.stringify(ds)).toBe(copia);
    });
});

describe('cargarDataset: lee la marca y las cuentas de prueba de cualquier tipo', () => {
    test('selecciona es_prueba en rodeos y usuarios y consulta las cuentas de prueba', async () => {
        const seleccionados = {};
        const filas = {
            temporadas: [{ id: 't1', nombre: '2026-2027', fecha_inicio: '2026-04-01', fecha_fin: '2027-03-31', activa: true }],
            usuarios_pagados: [{ id: 'X' }]
        };
        const consulta = tabla => {
            const q = {
                select: cols => { seleccionados[tabla] = (seleccionados[tabla] || []).concat(cols); return q; },
                gte: () => q, lte: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q,
                range: () => Promise.resolve({ data: filas[tabla] || [], error: null }),
                then: (ok, ko) => Promise.resolve({ data: filas[tabla] || [], error: null }).then(ok, ko)
            };
            return q;
        };
        const ds = await cargarDataset({ hasta: '2026-09-20' }, { from: consulta });
        expect(seleccionados.rodeos.join(' ')).toMatch(/es_prueba/);
        expect(seleccionados.usuarios_pagados.join(' ')).toMatch(/es_prueba/);
        expect(ds.idsUsuariosPrueba).toEqual(['X']);
    });
});
