// Cambio de función (migración 100) — 9. designación como Delegado Rentado y
// 12. integridad de tarifas/pagos. Router REAL de asignaciones con Supabase
// en memoria (filtros reales). Escenario: Roberto era Jurado C (con una
// designación histórica pagada con tarifa C) y hoy es Delegado Rentado.
const { crearSupabaseMemoria, llamarRouter } = require('../../services/__fixtures__/supabaseMemoria');

jest.mock('../../config/supabase', () => ({
    from: (...a) => global.__memSupabase.from(...a),
    rpc: (...a) => global.__memSupabase.rpc(...a)
}));
jest.mock('../../services/auditoria', () => ({ registrar: jest.fn().mockResolvedValue(undefined) }));

const router = require('./asignaciones');
const ROBERTO = '02745610-52b9-4793-9cdc-3931ab254f29';

function tablas(tipoVigente) {
    return {
        usuarios_pagados: [{ id: ROBERTO, nombre_completo: 'ROBERTO RIVAS GONZALEZ', tipo_persona: tipoVigente,
            categoria: tipoVigente === 'jurado' ? 'C' : null, activo: true }],
        rodeos: [{ id: 'r-nuevo', fecha: '2026-12-05', duracion_dias: 2, estado: 'activo' }],
        configuracion_tarifas: [
            { categoria: 'A', valor_diario: 120000 }, { categoria: 'B', valor_diario: 100000 },
            { categoria: 'C', valor_diario: 80000 }, { categoria: 'DR', valor_diario: 60000 }
        ],
        asignaciones: [{ id: 'hist-1', rodeo_id: 'r-viejo', usuario_pagado_id: ROBERTO, tipo_persona: 'jurado', categoria_aplicada: 'C',
            valor_diario_aplicado: 80000, duracion_dias_aplicada: 1, pago_base_calculado: 80000, estado: 'activo', estado_designacion: 'aceptado' }]
    };
}
const designar = (tipo_persona) => llamarRouter(router, { metodo: 'POST', url: '/', body: { rodeo_id: 'r-nuevo', personas: [{ usuario_pagado_id: ROBERTO, tipo_persona }] } });

afterAll(() => { delete global.__memSupabase; });

test('9/12. tras el cambio: se designa como Delegado Rentado con tarifa DR; la designación histórica de jurado no cambia', async () => {
    global.__memSupabase = crearSupabaseMemoria({ tablas: tablas('delegado_rentado') });
    const historicaAntes = JSON.parse(JSON.stringify(global.__memSupabase.tablas.asignaciones[0]));

    const r = await designar('delegado_rentado');
    expect(r.statusCode).toBe(201);
    const nueva = global.__memSupabase.tablas.asignaciones.find(a => a.rodeo_id === 'r-nuevo');
    expect(nueva).toMatchObject({ usuario_pagado_id: ROBERTO, tipo_persona: 'delegado_rentado', categoria_aplicada: 'DR',
        valor_diario_aplicado: 60000, duracion_dias_aplicada: 2, pago_base_calculado: 120000, estado: 'activo' });
    expect(global.__memSupabase.tablas.asignaciones.find(a => a.id === 'hist-1')).toEqual(historicaAntes);
});

test('tras el cambio ya no puede designarse como Jurado (función vigente = DR)', async () => {
    global.__memSupabase = crearSupabaseMemoria({ tablas: tablas('delegado_rentado') });
    const r = await designar('jurado');
    expect(global.__memSupabase.tablas.asignaciones.filter(a => a.rodeo_id === 'r-nuevo')).toHaveLength(0);
    expect(JSON.stringify(r.body)).toMatch(/El usuario es delegado_rentado, no se puede asignar como jurado/);
});

test('antes del cambio (Jurado C) no puede designarse como Delegado Rentado — el bloqueo que motivó la corrección', async () => {
    global.__memSupabase = crearSupabaseMemoria({ tablas: tablas('jurado') });
    const r = await designar('delegado_rentado');
    expect(global.__memSupabase.tablas.asignaciones.filter(a => a.rodeo_id === 'r-nuevo')).toHaveLength(0);
    expect(JSON.stringify(r.body)).toMatch(/El usuario es jurado, no se puede asignar como delegado_rentado/);
});
