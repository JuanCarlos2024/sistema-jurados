// notaTecnicaJurados.js — fuente oficial de nota técnica para el motor
// (Etapa B). Mismo patrón de mock de Supabase que evaluacionDesempenoJurados
// .test.js: cada tabla devuelve un resultado fijo, independiente de los
// .eq()/.in()/.lte() encadenados.
jest.mock('../config/supabase', () => ({ from: jest.fn() }));
const supabase = require('../config/supabase');
const { cargarNotaTecnicaPorJurado } = require('./notaTecnicaJurados');

function mockChain(result) {
    const obj = {};
    ['select', 'eq', 'neq', 'gte', 'lte', 'in', 'order', 'range', 'single', 'limit'].forEach(m => { obj[m] = jest.fn(() => obj); });
    obj.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
    return obj;
}

function mockSupabase({ asignaciones = [], notas = [] } = {}) {
    supabase.from.mockImplementation((tabla) => {
        if (tabla === 'asignaciones') return mockChain({ data: asignaciones, error: null });
        if (tabla === 'notas_rodeo') return mockChain({ data: notas, error: null });
        throw new Error('tabla inesperada en el mock: ' + tabla);
    });
}

beforeEach(() => {
    supabase.from.mockReset();
});

describe('cargarNotaTecnicaPorJurado', () => {
    test('lista de jurados vacía -> Map vacío, sin consultar nada', async () => {
        mockSupabase();
        const r = await cargarNotaTecnicaPorJurado([], '2026-11-14');
        expect(r.size).toBe(0);
        expect(supabase.from).not.toHaveBeenCalled();
    });

    test('jurado sin ninguna asignación -> promedio null (nunca 0), cantidad 0', async () => {
        mockSupabase({ asignaciones: [] });
        const r = await cargarNotaTecnicaPorJurado(['j1'], '2026-11-14');
        expect(r.get('j1')).toEqual({ promedio: null, cantidad: 0 });
    });

    test('jurado con asignaciones pero SIN nota técnica (ninguna fila en notas_rodeo) -> promedio null, nunca 0', async () => {
        mockSupabase({
            asignaciones: [
                { id: 'a1', usuario_pagado_id: 'j1', estado: 'activo', estado_designacion: null, rodeos: { fecha: '2026-05-01' } }
            ],
            notas: []
        });
        const r = await cargarNotaTecnicaPorJurado(['j1'], '2026-11-14');
        expect(r.get('j1')).toEqual({ promedio: null, cantidad: 0 });
    });

    test('promedia correctamente varias evaluaciones técnicas reales del mismo jurado', async () => {
        mockSupabase({
            asignaciones: [
                { id: 'a1', usuario_pagado_id: 'j1', estado: 'activo', estado_designacion: null, rodeos: { fecha: '2026-05-01' } },
                { id: 'a2', usuario_pagado_id: 'j1', estado: 'activo', estado_designacion: null, rodeos: { fecha: '2026-06-01' } }
            ],
            notas: [
                { asignacion_id: 'a1', nota: 6.0 },
                { asignacion_id: 'a2', nota: 7.0 }
            ]
        });
        const r = await cargarNotaTecnicaPorJurado(['j1'], '2026-11-14');
        expect(r.get('j1')).toEqual({ promedio: 6.5, cantidad: 2 });
    });

    // Criterio único de "asignación efectiva" (esAsignacionEfectiva, MISMO
    // que usa el resto del motor) — una designación rechazada nunca debe
    // contar, aunque exista una nota técnica real asociada a esa fila.
    test('excluye asignaciones rechazadas (estado_designacion=rechazado), aunque tengan nota técnica', async () => {
        mockSupabase({
            asignaciones: [
                { id: 'a1', usuario_pagado_id: 'j1', estado: 'activo', estado_designacion: 'rechazado', rodeos: { fecha: '2026-05-01' } },
                { id: 'a2', usuario_pagado_id: 'j1', estado: 'activo', estado_designacion: 'aceptado', rodeos: { fecha: '2026-06-01' } }
            ],
            notas: [
                { asignacion_id: 'a1', nota: 1.0 }, // rechazada -> nunca debe contar
                { asignacion_id: 'a2', nota: 6.0 }
            ]
        });
        const r = await cargarNotaTecnicaPorJurado(['j1'], '2026-11-14');
        expect(r.get('j1')).toEqual({ promedio: 6.0, cantidad: 1 });
    });

    test('devuelve jurados DISTINTOS con sus propios promedios, sin mezclar notas entre ellos', async () => {
        mockSupabase({
            asignaciones: [
                { id: 'a1', usuario_pagado_id: 'j1', estado: 'activo', estado_designacion: null, rodeos: { fecha: '2026-05-01' } },
                { id: 'a2', usuario_pagado_id: 'j2', estado: 'activo', estado_designacion: null, rodeos: { fecha: '2026-05-01' } }
            ],
            notas: [
                { asignacion_id: 'a1', nota: 7.0 },
                { asignacion_id: 'a2', nota: 5.0 }
            ]
        });
        const r = await cargarNotaTecnicaPorJurado(['j1', 'j2'], '2026-11-14');
        expect(r.get('j1').promedio).toBe(7.0);
        expect(r.get('j2').promedio).toBe(5.0);
    });

    test('propaga el error de Supabase con mensaje claro, en vez de devolver datos a medias', async () => {
        supabase.from.mockImplementation((tabla) => {
            if (tabla === 'asignaciones') return mockChain({ data: null, error: { message: 'boom' } });
            throw new Error('no debería llegar a notas_rodeo');
        });
        await expect(cargarNotaTecnicaPorJurado(['j1'], '2026-11-14')).rejects.toThrow(/boom/);
    });
});
