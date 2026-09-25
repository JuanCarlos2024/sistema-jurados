// Auditoría de CONSUMIDORES de evaluaciones: una evaluación histórica (es_historica_importacion = true, solo Casos por WhatsApp)
// no debe ser interpretada como una evaluación deportiva real. Además: protección de pagos históricos en /recalcular.
let mockDb;
jest.mock('../../config/supabase', () => new Proxy({}, { get: (_, k) => mockDb[k] }));
jest.mock('../../services/calculo', () => ({
    obtenerTarifas: async () => ({}),
    calcularPagoBase: () => ({ categoria_aplicada: 'A', valor_diario_aplicado: 50000, pago_base_calculado: 100000 }),
    obtenerBonoParaDistancia: () => null
}));

const fs = require('fs');
const path = require('path');
const { crearSupabaseMemoria, llamarRouter } = require('../../services/__fixtures__/supabaseMemoria');

const HIST = { id: 'EH', rodeo_id: 'R-H', estado: 'cerrado', es_historica_importacion: true, casos_whatsapp: 5, anulada: false, nota_final: null, resultados_alterados: false, puntaje_final: null, created_at: '2026-02-01' };
const REAL = { id: 'ER', rodeo_id: 'R-N', estado: 'publicado', es_historica_importacion: false, casos_whatsapp: 1, anulada: false, nota_final: 6.2, resultados_alterados: true, puntaje_final: 40, created_at: '2026-02-02' };
const rodeos = [
    { id: 'R-H', club: 'H', asociacion: 'A', fecha: '2026-02-01', estado: 'activo', tipo_rodeo_nombre: 'T', duracion_dias: 1 },
    { id: 'R-N', club: 'N', asociacion: 'A', fecha: '2026-02-02', estado: 'activo', tipo_rodeo_nombre: 'T', duracion_dias: 1 }
];
function preparar(extra = {}) {
    mockDb = crearSupabaseMemoria({ tablas: { rodeos: rodeos.map(r => ({ ...r })), evaluaciones: [{ ...HIST }, { ...REAL }], evaluacion_casos: [], asignaciones: [], evaluacion_ciclos: [], ...extra } });
}

describe('reportes de evaluación / dashboard "Total evaluaciones"', () => {
    test('GET /admin/reportes/evaluaciones (fuente de Total, estados, promedios, % faltas, tiempos) no incluye históricas', async () => {
        preparar();
        const r = await llamarRouter(require('./reportes'), { url: '/evaluaciones' });
        expect(r.statusCode).toBe(200);
        expect(r.body.map(e => e.id)).toEqual(['ER']);
        expect(r.body.some(e => e.estado === 'cerrado')).toBe(false);
    });
    test('el CSV de evaluaciones tampoco las incluye', async () => {
        preparar();
        const r = await llamarRouter(require('./reportes'), { url: '/evaluaciones/exportar' });
        expect(r.statusCode).toBe(200);
        expect(String(r.body)).toContain('N;');
        expect(String(r.body)).not.toMatch(/(^|\n)H;/);
    });
});

describe('detalle del rodeo: la histórica no es "la evaluación" pero el dato sigue consultable', () => {
    test('GET /admin/rodeos/:id de un rodeo con histórica → evaluacion=null y evaluacion_historica con casos_whatsapp', async () => {
        preparar();
        const r = await llamarRouter(require('./rodeos'), { url: '/R-H', params: { id: 'R-H' } });
        expect(r.statusCode).toBe(200);
        expect(r.body.evaluacion).toBeNull();
        expect(r.body.evaluacion_historica).toEqual({ id: 'EH', casos_whatsapp: 5 });
    });
    test('GET /admin/rodeos/:id de un rodeo con evaluación real → sin cambios (evaluacion presente, sin evaluacion_historica)', async () => {
        preparar();
        const r = await llamarRouter(require('./rodeos'), { url: '/R-N', params: { id: 'R-N' } });
        expect(r.body.evaluacion).toMatchObject({ id: 'ER', estado: 'publicado', nota_final: 6.2 });
        expect(r.body.evaluacion_historica).toBeNull();
    });
});

describe('Informe de Gestión: base de evaluaciones, faltas e indicadores', () => {
    const { cargarDataset } = require('../../services/informeGestion/cargaDatos');
    const { agregarEvaluacion, indexarEvaluaciones } = require('../../services/informeGestion/agregados');
    test('el dataset no trae históricas: evaluaciones_existentes y la base de faltas no se distorsionan', async () => {
        preparar({ temporadas: [{ id: 'T1', nombre: '2025-2026', fecha_inicio: '2025-04-01', fecha_fin: '2026-03-31', activa: true }] });
        const ds = await cargarDataset({ hasta: '2026-03-01' }, mockDb);
        expect(ds.evaluaciones.map(e => e.id)).toEqual(['ER']);
        const realizados = ds.rodeos.filter(r => r.estado === 'activo');
        expect(realizados).toHaveLength(2);
        const ev = agregarEvaluacion(realizados, indexarEvaluaciones(ds.evaluaciones));
        expect(ev.evaluaciones_existentes).toBe(1);                 // con la histórica habría sido 2
        expect(ev.evaluaciones_no_publicadas).toBe(0);
        expect(ev.evaluaciones_publicadas).toBe(1);
    });
});

describe('protección de pagos históricos: POST /admin/asignaciones/:id/recalcular', () => {
    const router = () => require('./asignaciones');
    const ASIG = (o = {}) => ({ id: 'AS1', rodeo_id: 'R1', usuario_pagado_id: 'J1', tipo_persona: 'jurado', valor_diario_aplicado: 0, duracion_dias_aplicada: 2, pago_base_calculado: 0, categoria_aplicada: 'A', importacion_id: null, rodeos: { duracion_dias: 2, importacion_id: null }, usuarios_pagados: { categoria: 'A', tipo_persona: 'jurado' }, ...o });
    const IMPS = [{ id: 'IMP-H', tipo: 'historico_rodeos' }, { id: 'IMP-R', tipo: 'rodeos' }, { id: 'IMP-CG', tipo: 'control_gestion' }];
    const recalcular = (asig) => { mockDb = crearSupabaseMemoria({ tablas: { asignaciones: [asig], importaciones: IMPS.map(i => ({ ...i })), auditoria: [] } }); return llamarRouter(router(), { metodo: 'POST', url: '/AS1/recalcular', params: { id: 'AS1' } }); };
    const pagoActual = () => mockDb.tablas.asignaciones[0].pago_base_calculado;

    test('asignación creada por una importación histórica (asignaciones.importacion_id) → 409 y el pago sigue en 0', async () => {
        const r = await recalcular(ASIG({ importacion_id: 'IMP-H' }));
        expect(r.statusCode).toBe(409);
        expect(r.body.error).toBe('No se puede recalcular el pago de una asignación histórica importada.');
        expect(pagoActual()).toBe(0);
        expect(mockDb.llamadas('asignaciones', 'update')).toEqual([]);
        expect(mockDb.tablas.auditoria).toEqual([]);
    });
    test('una asignación NORMAL (sin importacion_id) en un rodeo creado por una importación histórica NO se bloquea (la fuente de verdad es la asignación)', async () => {
        const r = await recalcular(ASIG({ pago_base_calculado: 10, rodeos: { duracion_dias: 2, importacion_id: 'IMP-H' } }));
        expect(r.statusCode).toBe(200); expect(pagoActual()).toBe(100000);
    });
    test('asignación normal (sin importación) sigue recalculándose con la tarifa actual', async () => {
        const r = await recalcular(ASIG({ pago_base_calculado: 10 }));
        expect(r.statusCode).toBe(200);
        expect(pagoActual()).toBe(100000);
        expect(mockDb.tablas.auditoria).toHaveLength(1);
    });
    test('otros tipos de importación (rodeos, control_gestion) NO se bloquean', async () => {
        expect((await recalcular(ASIG({ importacion_id: 'IMP-R' }))).statusCode).toBe(200);
        expect((await recalcular(ASIG({ importacion_id: 'IMP-CG', rodeos: { duracion_dias: 2, importacion_id: 'IMP-R' } }))).statusCode).toBe(200);
    });
    test('un rodeo con origen importado pero SIN importación histórica no se bloquea (origen por sí solo no es criterio)', async () => {
        const r = await recalcular(ASIG({ rodeos: { duracion_dias: 2, importacion_id: null, origen: 'importado' }, origen: 'importado' }));
        expect(r.statusCode).toBe(200);
    });
    test('asignación inexistente sigue devolviendo 404', async () => {
        mockDb = crearSupabaseMemoria({ tablas: { asignaciones: [], importaciones: [] } });
        expect((await llamarRouter(router(), { metodo: 'POST', url: '/NOEXISTE/recalcular' })).statusCode).toBe(404);
    });
});

describe('guarda de regresión: cada consulta a evaluaciones fue revisada semánticamente', () => {
    const base = path.join(__dirname, '..', '..');
    const cuenta = (f, re) => (fs.readFileSync(path.join(base, f), 'utf8').match(re) || []).length;
    // [archivo, consultas from('evaluaciones'), menciones de es_historica_importacion]. Si aparece una consulta nueva (o se quita un filtro),
    // este test falla y obliga a decidir si el consumidor debe (o no) ver los registros históricos.
    const ESPERADO = {
        'routes/admin/evaluaciones.js': [18, 5],            // listado (filtra), rodeos-disponibles y crear-masivo (semántica propia); el resto opera por id/estado
        'routes/admin/reportes.js': [2, 2],                 // dashboard/CSV: filtra
        'routes/admin/reporte-deportivo.js': [2, 1],        // reporte: filtra; la 2ª lee comentario_jefe por id ya filtrado
        'routes/admin/hojavida.js': [3, 2],                 // "Ver evaluación"/"Altera resultado": filtra; calcularSituaciones cuenta casos (histórica = 0)
        'routes/admin/rodeos.js': [1, 2],                   // detalle: separa evaluacion / evaluacion_historica
        'routes/usuario/evaluaciones.js': [6, 4],           // portal del jurado: no ve históricas (listado, detalle, resultado, comentar)
        'services/informeGestion/cargaDatos.js': [1, 1],    // Informe de Gestión: base de evaluaciones
        'services/motorPropuestaDesignacion.js': [1, 1],    // métricas de rendimiento: histórica ≠ "sin alteración"
        'services/evaluacionCreacion.js': [2, 3],           // creación/conversión: necesita ver la histórica
        'services/importacionHistorica.js': [1, 0],         // importación: DEBE ver históricas y normales para comparar Casos por WhatsApp
        'routes/admin/casos.js': [7, 0], 'routes/admin/ciclos.js': [4, 0], 'routes/admin/respuestas-jurado.js': [4, 0],   // por id, sobre ciclos/casos que una histórica no tiene
        'services/publicacion.js': [3, 0],                  // por id y estado (una histórica 'cerrado' nunca se autopublica)
        'services/rodeosListado.js': [1, 0]                 // solo nota_final (NULL en una histórica): sin efecto
    };
    test.each(Object.entries(ESPERADO))('%s', (archivo, [consultas, marcadores]) => {
        expect(cuenta(archivo, /from\('evaluaciones'\)/g)).toBe(consultas);
        expect(cuenta(archivo, /es_historica_importacion/g)).toBe(marcadores);
    });
    test('no hay consumidores de evaluaciones fuera de la lista revisada', () => {
        const dir = (d) => fs.readdirSync(path.join(base, d), { withFileTypes: true }).flatMap(e => e.isDirectory() ? (e.name === '__fixtures__' ? [] : dir(path.join(d, e.name))) : [path.join(d, e.name)]);
        const conConsulta = dir('.').filter(f => f.endsWith('.js') && !f.endsWith('.test.js')).filter(f => /from\('evaluaciones'\)/.test(fs.readFileSync(path.join(base, f), 'utf8'))).map(f => f.replace(/\\/g, '/').replace(/^\.\//, ''));
        expect(conConsulta.sort()).toEqual(Object.keys(ESPERADO).sort());
    });
});

describe('Control de Gestión, propuesta de designación e importación normal: sin cambios', () => {
    const base = path.join(__dirname, '..', '..');
    const leer = (f) => fs.readFileSync(path.join(base, f), 'utf8');
    test('no referencian el marcador, la importación histórica ni la conversión', () => {
        const archivos = ['routes/admin/importacion.js', 'services/importacion.js', 'routes/admin/propuesta-designacion.js', 'routes/admin/control-gestion.js'];
        for (const f of archivos) if (fs.existsSync(path.join(base, f))) expect(leer(f)).not.toMatch(/es_historica_importacion|importar_rodeos_historicos|convertir_evaluacion_historica/);
        for (const n of fs.readdirSync(path.join(base, 'services')).filter(n => /controlGestion/i.test(n) && !n.endsWith('.test.js'))) expect(leer('services/' + n)).not.toMatch(/es_historica_importacion/);
    });
    test('PGlite es solo de pruebas: devDependencies, ningún código productivo lo importa', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(base, '..', 'package.json'), 'utf8'));
        expect(pkg.devDependencies['@electric-sql/pglite']).toBeDefined();
        expect((pkg.dependencies || {})['@electric-sql/pglite']).toBeUndefined();
        const productivos = [];
        const recorrer = (d) => fs.readdirSync(path.join(base, d), { withFileTypes: true }).forEach(e => { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== '__fixtures__') recorrer(p); } else if (p.endsWith('.js') && !p.endsWith('.test.js')) productivos.push(p); });
        recorrer('.');
        for (const f of productivos) expect(leer(f)).not.toMatch(/pglite/i);
    });
});

describe('protección de pagos históricos: PATCH /admin/asignaciones/:id y PATCH /:id/km', () => {
    const router = () => require('./asignaciones');
    const MSG = 'No se pueden modificar datos de pago de una asignación histórica importada.';
    const ASIG = (o = {}) => ({ id: 'AS1', rodeo_id: 'R1', usuario_pagado_id: 'J1', tipo_persona: 'jurado', valor_diario_aplicado: 0, duracion_dias_aplicada: 2, pago_base_calculado: 0, categoria_aplicada: 'A', estado: 'activo', observacion: null, distancia_km: null, importacion_id: null, rodeos: { duracion_dias: 2 }, ...o });
    const IMPS = [{ id: 'IMP-H', tipo: 'historico_rodeos' }, { id: 'IMP-R', tipo: 'rodeos' }];
    const preparar = (asig) => { mockDb = crearSupabaseMemoria({ tablas: { asignaciones: [asig], importaciones: IMPS.map(i => ({ ...i })), usuarios_pagados: [{ id: 'J2', nombre_completo: 'Otro', tipo_persona: 'jurado', categoria: 'B', activo: true }], auditoria: [], bonos_solicitados: [] } }); };
    const patch = (body, url = '/AS1') => llamarRouter(router(), { metodo: 'PATCH', url, params: { id: 'AS1' }, body });
    const fila = () => mockDb.tablas.asignaciones[0];

    test.each([
        ['cambio de jurado (recalcula categoría, tarifa y pago)', { usuario_pagado_id: 'J2' }],
        ['override del valor diario', { valor_diario_aplicado: 60000 }],
        ['kilometraje (genera bono de distancia)', { distancia_km: 400 }],
        ['combinación con observación', { observacion: 'x', valor_diario_aplicado: 1 }]
    ])('asignación histórica + %s → 409 y NO cambia nada (pago sigue en 0)', async (_t, body) => {
        preparar(ASIG({ importacion_id: 'IMP-H' }));
        const r = await patch(body);
        expect(r.statusCode).toBe(409);
        expect(r.body.error).toBe(MSG);
        expect(fila()).toMatchObject({ pago_base_calculado: 0, valor_diario_aplicado: 0, usuario_pagado_id: 'J1', observacion: null, distancia_km: null });
        expect(mockDb.llamadas('asignaciones', 'update')).toEqual([]);
        expect(mockDb.tablas.bonos_solicitados).toEqual([]);
    });
    test('asignación histórica: los campos puramente administrativos NO se bloquean (observación; misma persona)', async () => {
        preparar(ASIG({ importacion_id: 'IMP-H' }));
        const r = await patch({ observacion: 'nota del administrador', usuario_pagado_id: 'J1' });
        expect(r.statusCode).toBe(200);
        expect(fila()).toMatchObject({ observacion: 'nota del administrador', pago_base_calculado: 0, valor_diario_aplicado: 0, usuario_pagado_id: 'J1' });
    });
    test('asignación histórica + /km → 409 sin crear bono', async () => {
        preparar(ASIG({ importacion_id: 'IMP-H' }));
        const r = await patch({ distancia_km: 500 }, '/AS1/km');
        expect(r.statusCode).toBe(409); expect(r.body.error).toBe(MSG);
        expect(mockDb.tablas.bonos_solicitados).toEqual([]); expect(fila().distancia_km).toBeNull();
    });
    test('asignación NORMAL: cambio de jurado, override de valor diario y /km siguen funcionando igual', async () => {
        preparar(ASIG({ pago_base_calculado: 50 }));
        let r = await patch({ usuario_pagado_id: 'J2' });
        expect(r.statusCode).toBe(200);
        expect(fila()).toMatchObject({ usuario_pagado_id: 'J2', pago_base_calculado: 100000, valor_diario_aplicado: 50000 });
        r = await patch({ valor_diario_aplicado: 30000 });
        expect(r.statusCode).toBe(200);
        expect(fila()).toMatchObject({ valor_diario_aplicado: 30000, pago_base_calculado: 60000 });
        r = await patch({ distancia_km: 120 }, '/AS1/km');
        expect(r.statusCode).toBe(200); expect(fila().distancia_km).toBe(120);
    });
    test('otro tipo de importación y origen importado sin importación histórica NO se bloquean por error', async () => {
        preparar(ASIG({ importacion_id: 'IMP-R', rodeos: { duracion_dias: 2, origen: 'importado' } }));
        expect((await patch({ valor_diario_aplicado: 40000 })).statusCode).toBe(200);
        expect(fila().pago_base_calculado).toBe(80000);
    });
    test('asignación anulada / inexistente: mismas respuestas de siempre', async () => {
        preparar(ASIG({ estado: 'anulado', importacion_id: 'IMP-H' }));
        expect((await patch({ valor_diario_aplicado: 1 })).statusCode).toBe(400);
        mockDb = crearSupabaseMemoria({ tablas: { asignaciones: [], importaciones: [] } });
        expect((await patch({ observacion: 'x' })).statusCode).toBe(404);
    });
});
