// Cambio de función (migración 100) — un antiguo jurado NUNCA desaparece de
// los informes históricos. Supabase EN MEMORIA que aplica los filtros de
// verdad (supabaseMemoria.js): una consulta por la función VIGENTE del
// usuario excluiría realmente al ex-jurado, así que estas pruebas fallan con
// el código anterior. Escenario: EX actuó 2 veces como Jurado (C y luego B)
// y hoy es Delegado Rentado, con 1 designación DR. J1 y D1 nunca cambiaron.
const fs = require('fs');
const path = require('path');
const { crearSupabaseMemoria, llamarRouter } = require('./__fixtures__/supabaseMemoria');

jest.mock('../config/supabase', () => ({
    from: (...a) => global.__memSupabase.from(...a),
    rpc: (...a) => global.__memSupabase.rpc(...a)
}));

const { obtenerEvaluacionDesempeno } = require('./evaluacionDesempenoJurados');
const { obtenerMatrizParticipacion } = require('./matrizParticipacion');
const { cargarDataset } = require('./informeGestion/cargaDatos');

const asig = (id, usuario, tipo, cat, fecha, rodeoId) => ({
    id, usuario_pagado_id: usuario, tipo_persona: tipo, categoria_aplicada: cat,
    estado: 'activo', estado_designacion: 'aceptado', rodeo_id: rodeoId,
    rodeos: { id: rodeoId, fecha, club: 'CLUB ' + rodeoId, asociacion: 'ASOC' }, 'rodeos.fecha': fecha
});

function datos() {
    return {
        usuarios_pagados: [
            { id: 'J1', nombre_completo: 'JURADO VIGENTE', tipo_persona: 'jurado', categoria: 'A', activo: true, estado_usuario: 'activo', es_prueba: false },
            { id: 'EX', nombre_completo: 'EX JURADO HOY DR', tipo_persona: 'delegado_rentado', categoria: null, activo: true, estado_usuario: 'activo', es_prueba: false },
            { id: 'D1', nombre_completo: 'DELEGADO VIGENTE', tipo_persona: 'delegado_rentado', categoria: null, activo: true, estado_usuario: 'activo', es_prueba: false }
        ],
        asignaciones: [
            asig('a1', 'J1', 'jurado', 'A', '2026-09-10', 'r1'),
            asig('a2', 'EX', 'jurado', 'C', '2026-09-10', 'r1'),
            asig('a3', 'EX', 'jurado', 'B', '2026-10-05', 'r2'),
            asig('a4', 'EX', 'delegado_rentado', 'DR', '2026-11-01', 'r3'),
            asig('a5', 'D1', 'delegado_rentado', 'DR', '2026-10-05', 'r2')
        ],
        rodeos: [
            { id: 'r1', club: 'CLUB r1', asociacion: 'ASOC', fecha: '2026-09-10', estado: 'activo', duracion_dias: 1, es_prueba: false },
            { id: 'r2', club: 'CLUB r2', asociacion: 'ASOC', fecha: '2026-10-05', estado: 'activo', duracion_dias: 1, es_prueba: false },
            { id: 'r3', club: 'CLUB r3', asociacion: 'ASOC', fecha: '2026-11-01', estado: 'activo', duracion_dias: 1, es_prueba: false }
        ],
        notas_rodeo: [{ asignacion_id: 'a3', nota: '6.0', fuente: 'evaluacion_tecnica' }],
        temporadas: [{ id: 't1', nombre: '2026-2027', fecha_inicio: '2026-09-01', fecha_fin: '2027-04-30', activa: true }]
    };
}

beforeEach(() => { global.__memSupabase = crearSupabaseMemoria({ tablas: datos() }); });
afterAll(() => { delete global.__memSupabase; });

describe('Evaluación de Desempeño de Jurados', () => {
    test('incluye al ex-jurado con sus rodeos como jurado y la categoría aplicada más reciente', async () => {
        const r = await obtenerEvaluacionDesempeno({ desde: '2026-09-01', hasta: '2026-12-31' });
        const filas = Object.fromEntries((r.filas || r.jurados || r).map(f => [f.usuario_pagado_id, f]));
        expect(filas.EX).toMatchObject({ nombre: 'EX JURADO HOY DR', categoria: 'B', total_rodeos: 2 });
        expect(filas.J1).toMatchObject({ categoria: 'A', total_rodeos: 1 });
        expect(filas.D1).toBeUndefined();                 // un DR que nunca fue jurado no entra
    });
});

describe('Matriz de Participación', () => {
    const porId = (personas) => personas.reduce((m, p) => { (m[p.usuario_pagado_id] = m[p.usuario_pagado_id] || []).push(p); return m; }, {});

    test('filtro Jurado: el ex-jurado aparece con sus 2 salidas como jurado (categoría B)', async () => {
        const { personas } = await obtenerMatrizParticipacion({ desde: '2026-09-01', hasta: '2026-12-31', tipo: 'jurado' });
        const m = porId(personas);
        expect(m.EX).toHaveLength(1);
        expect(m.EX[0]).toMatchObject({ tipo_persona: 'jurado', categoria: 'B', total_salidas: 2 });
        expect(m.J1[0]).toMatchObject({ tipo_persona: 'jurado', categoria: 'A', total_salidas: 1 });
        expect(m.D1).toBeUndefined();
    });

    test('filtro Delegado Rentado: solo su salida como DR, nunca las de jurado', async () => {
        const { personas } = await obtenerMatrizParticipacion({ desde: '2026-09-01', hasta: '2026-12-31', tipo: 'delegado_rentado' });
        const m = porId(personas);
        expect(m.EX).toHaveLength(1);
        expect(m.EX[0]).toMatchObject({ tipo_persona: 'delegado_rentado', categoria: 'DR', total_salidas: 1 });
        expect(m.J1).toBeUndefined();
    });

    test('sin filtro: una fila por función ejercida; las personas sin cambios quedan igual', async () => {
        const { personas } = await obtenerMatrizParticipacion({ desde: '2026-09-01', hasta: '2026-12-31' });
        const m = porId(personas);
        expect(m.EX.map(p => `${p.tipo_persona}:${p.categoria}:${p.total_salidas}`).sort()).toEqual(['delegado_rentado:DR:1', 'jurado:B:2']);
        expect(m.J1).toHaveLength(1);
        expect(m.D1).toHaveLength(1);
        expect(m.D1[0]).toMatchObject({ tipo_persona: 'delegado_rentado', categoria: 'DR', total_salidas: 1 });
    });
});

describe('Dashboard > Desempeño (estadísticas de salidas)', () => {
    const router = require('../routes/admin/dashboard');
    test('filtro Jurado: el ex-jurado conserva sus salidas como jurado y no figura "sin salidas"', async () => {
        const r = await llamarRouter(router, { url: '/desempeno', query: { desde: '2026-09-01', hasta: '2026-12-31', tipo: 'jurado' } });
        expect(r.statusCode).toBe(200);
        const ex = r.body.ranking_salidas.find(u => u.id === 'EX');
        expect(ex).toMatchObject({ categoria: 'B', tipo: 'jurado', salidas: 2 });
        expect(r.body.sin_salidas.find(u => u.id === 'EX')).toBeUndefined();
        expect(r.body.resumen.total_salidas).toBe(3);
    });
    test('filtro DR: el ex-jurado solo con su salida DR', async () => {
        const r = await llamarRouter(router, { url: '/desempeno', query: { desde: '2026-09-01', hasta: '2026-12-31', tipo: 'delegado_rentado' } });
        const ex = r.body.ranking_salidas.filter(u => u.id === 'EX');
        expect(ex).toEqual([expect.objectContaining({ categoria: 'DR', tipo: 'delegado_rentado', salidas: 1 })]);
        expect(r.body.resumen.total_salidas).toBe(2);
    });
});

describe('Informe de Gestión', () => {
    test('el dataset carga al ex-jurado (sus actuaciones como jurado nunca quedan anónimas)', async () => {
        const ds = await cargarDataset({ hasta: '2026-12-31' });
        expect(ds.asignaciones.map(a => a.id).sort()).toEqual(['a1', 'a2', 'a3']);
        expect(ds.usuarios.map(u => u.id).sort()).toEqual(['EX', 'J1']);
    });
    test('informe.js excluye a quien hoy es DR del universo de disponibilidad de jurados', () => {
        const src = fs.readFileSync(path.join(__dirname, 'informeGestion', 'informe.js'), 'utf8');
        expect(src).toMatch(/juradosActivos = ds\.usuarios\.filter\(u => u\.tipo_persona !== 'delegado_rentado'/);
    });
});

describe('Reportes de evaluación técnica y ciclos', () => {
    test('nunca filtran por la función VIGENTE del usuario (usuarios_pagados.tipo_persona)', () => {
        for (const f of ['reportes.js', 'ciclos.js']) {
            const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin', f), 'utf8');
            expect(src).not.toMatch(/\.eq\('usuarios_pagados\.tipo_persona'/);
        }
    });
});
