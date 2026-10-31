// GET /api/admin/rodeos/:id/jurados-disponibles — pruebas de REGRESIÓN
// (caracterizan el comportamiento actual, escritas ANTES de extraer los
// helpers compartidos con el nuevo buscador de reemplazo, para asegurar que
// la extracción no altera en nada el modal "Designar jurado").
let mockDb;
jest.mock('../../config/supabase', () => new Proxy({}, { get: (_, k) => mockDb[k] }));

const { crearSupabaseMemoria, llamarRouter } = require('../../services/__fixtures__/supabaseMemoria');
const router = require('./rodeos');

const RODEO = { id: 'R-DEST', asociacion: 'COLCHAGUA', fecha: '2026-11-07', duracion_dias: 2, club: 'HUEMUL' };

function preparar({ rodeos = [RODEO], usuarios_pagados = [], disponibilidad_usuarios = [], asignaciones = [], notas_rodeo = [] } = {}) {
    mockDb = crearSupabaseMemoria({ tablas: { rodeos, usuarios_pagados, disponibilidad_usuarios, asignaciones, notas_rodeo } });
}

function buscar(query = {}, usuario) {
    return llamarRouter(router, { metodo: 'GET', url: '/R-DEST/jurados-disponibles', params: { id: 'R-DEST' }, query, usuario });
}

function jurado(id, extra = {}) {
    return { id, nombre_completo: 'Jurado ' + id, categoria: 'A', codigo_interno: 'J-' + id, asociacion: 'OTRA', comuna: 'X', activo: true, tipo_persona: 'jurado', ...extra };
}

describe('Rodeo no encontrado', () => {
    test('404 si el rodeo de destino no existe', async () => {
        preparar({ rodeos: [] });
        const r = await buscar();
        expect(r.statusCode).toBe(404);
    });
});

describe('Disponibilidad declarada', () => {
    test('sin disponibilidad declarada para TODAS las fechas del rodeo (2 días) -> excluido de la lista', async () => {
        preparar({
            usuarios_pagados: [jurado('J1')],
            disponibilidad_usuarios: [{ usuario_pagado_id: 'J1', fecha: '2026-11-07' }] // falta 2026-11-08
        });
        const r = await buscar();
        expect(r.body.jurados).toEqual([]);
    });
    test('con disponibilidad declarada para AMBAS fechas -> incluido', async () => {
        preparar({
            usuarios_pagados: [jurado('J1')],
            disponibilidad_usuarios: [
                { usuario_pagado_id: 'J1', fecha: '2026-11-07' },
                { usuario_pagado_id: 'J1', fecha: '2026-11-08' }
            ]
        });
        const r = await buscar();
        expect(r.body.jurados.map(j => j.id)).toEqual(['J1']);
    });
});

const DISP_COMPLETA_J1 = [
    { usuario_pagado_id: 'J1', fecha: '2026-11-07' },
    { usuario_pagado_id: 'J1', fecha: '2026-11-08' }
];

describe('Cruce de fechas con otro rodeo (solapamiento, no solo mismo día)', () => {
    test('otro rodeo de 1 día (2026-11-08) que se cruza con el segundo día del destino -> excluido', async () => {
        preparar({
            usuarios_pagados: [jurado('J1')],
            disponibilidad_usuarios: DISP_COMPLETA_J1,
            asignaciones: [{ id: 'A-OTRO', usuario_pagado_id: 'J1', rodeo_id: 'R-OTRO', estado: 'activo', created_at: '1', rodeos: { fecha: '2026-11-08', duracion_dias: 1, club: 'BULNES' } }]
        });
        const r = await buscar();
        expect(r.body.jurados).toEqual([]);
    });
    test('otro rodeo SIN cruce (termina antes de empezar el destino) -> incluido', async () => {
        preparar({
            usuarios_pagados: [jurado('J1')],
            disponibilidad_usuarios: DISP_COMPLETA_J1,
            asignaciones: [{ id: 'A-OTRO', usuario_pagado_id: 'J1', rodeo_id: 'R-OTRO', estado: 'activo', created_at: '1', rodeos: { fecha: '2026-10-01', duracion_dias: 1, club: 'BULNES' } }]
        });
        const r = await buscar();
        expect(r.body.jurados.map(j => j.id)).toEqual(['J1']);
    });
    test('otro rodeo ANULADO que se cruza -> no bloquea (estado anulado se ignora)', async () => {
        preparar({
            usuarios_pagados: [jurado('J1')],
            disponibilidad_usuarios: DISP_COMPLETA_J1,
            asignaciones: [{ id: 'A-OTRO', usuario_pagado_id: 'J1', rodeo_id: 'R-OTRO', estado: 'anulado', created_at: '1', rodeos: { fecha: '2026-11-08', duracion_dias: 1, club: 'BULNES' } }]
        });
        const r = await buscar();
        expect(r.body.jurados.map(j => j.id)).toEqual(['J1']);
    });
});

describe('Ya asignado en este mismo rodeo', () => {
    test('jurado con asignación activa en el rodeo destino -> incluido con ya_asignado:true', async () => {
        preparar({
            usuarios_pagados: [jurado('J1')],
            disponibilidad_usuarios: DISP_COMPLETA_J1,
            asignaciones: [{ id: 'A-AQUI', usuario_pagado_id: 'J1', rodeo_id: 'R-DEST', estado: 'activo', created_at: '1', rodeos: { fecha: '2026-11-07', duracion_dias: 2, club: 'HUEMUL' } }]
        });
        const r = await buscar();
        expect(r.body.jurados).toEqual([expect.objectContaining({ id: 'J1', ya_asignado: true })]);
    });
});

describe('Repetición de asociación', () => {
    test('jurado con historial previo en la MISMA asociación del rodeo destino -> repite_asociacion:true', async () => {
        preparar({
            usuarios_pagados: [jurado('J1')],
            disponibilidad_usuarios: DISP_COMPLETA_J1,
            // 'rodeos.asociacion' como clave plana además del objeto anidado: el
            // mock en memoria filtra .eq('rodeos.asociacion', v) tomando esa
            // cadena literal como nombre de propiedad (no hace joins reales).
            asignaciones: [{ id: 'A-H', usuario_pagado_id: 'J1', rodeo_id: 'R-PREV', estado: 'activo', created_at: '1', 'rodeos.asociacion': 'COLCHAGUA', rodeos: { fecha: '2026-05-01', duracion_dias: 1, club: 'RANCAGUA', asociacion: 'COLCHAGUA', tipo_rodeo_nombre: 'Provincial' } }]
        });
        const r = await buscar();
        expect(r.body.jurados[0].repite_asociacion).toBe(true);
    });
    test('jurado sin historial en esa asociación -> repite_asociacion:false', async () => {
        preparar({ usuarios_pagados: [jurado('J1')], disponibilidad_usuarios: DISP_COMPLETA_J1, asignaciones: [] });
        const r = await buscar();
        expect(r.body.jurados[0].repite_asociacion).toBe(false);
    });
});

describe('Historial: últimos 3, con nota cuando existe', () => {
    test('se incluyen como máximo 3 entradas y la nota de notas_rodeo cuando está registrada', async () => {
        preparar({
            usuarios_pagados: [jurado('J1')],
            disponibilidad_usuarios: DISP_COMPLETA_J1,
            asignaciones: [
                { id: 'A1', usuario_pagado_id: 'J1', rodeo_id: 'R1', estado: 'activo', created_at: '4', rodeos: { club: 'C1', fecha: '2026-01-01', tipo_rodeo_nombre: 'T1', asociacion: 'X' } },
                { id: 'A2', usuario_pagado_id: 'J1', rodeo_id: 'R2', estado: 'activo', created_at: '3', rodeos: { club: 'C2', fecha: '2026-02-01', tipo_rodeo_nombre: 'T2', asociacion: 'X' } },
                { id: 'A3', usuario_pagado_id: 'J1', rodeo_id: 'R3', estado: 'activo', created_at: '2', rodeos: { club: 'C3', fecha: '2026-03-01', tipo_rodeo_nombre: 'T3', asociacion: 'X' } },
                { id: 'A4', usuario_pagado_id: 'J1', rodeo_id: 'R4', estado: 'activo', created_at: '1', rodeos: { club: 'C4', fecha: '2026-04-01', tipo_rodeo_nombre: 'T4', asociacion: 'X' } }
            ],
            notas_rodeo: [{ asignacion_id: 'A1', nota: 6.0 }]
        });
        const r = await buscar();
        expect(r.body.jurados[0].historial).toHaveLength(3);
        expect(r.body.jurados[0].historial[0]).toEqual({ club: 'C1', fecha: '2026-01-01', tipo_rodeo: 'T1', asociacion: 'X', nota: 6.0 });
        expect(r.body.jurados[0].designaciones).toBe(4); // cuenta TODO el historial, no solo las 3 mostradas
    });
});

describe('Orden de presentación', () => {
    test('menos designaciones primero; empate -> alfabético', async () => {
        preparar({
            usuarios_pagados: [jurado('J-ZETA', { nombre_completo: 'Zeta' }), jurado('J-ALFA', { nombre_completo: 'Alfa' }), jurado('J-BETA', { nombre_completo: 'Beta' })],
            disponibilidad_usuarios: [
                ...DISP_COMPLETA_J1.map(d => ({ ...d, usuario_pagado_id: 'J-ZETA' })),
                ...DISP_COMPLETA_J1.map(d => ({ ...d, usuario_pagado_id: 'J-ALFA' })),
                ...DISP_COMPLETA_J1.map(d => ({ ...d, usuario_pagado_id: 'J-BETA' }))
            ],
            asignaciones: [{ id: 'A1', usuario_pagado_id: 'J-ZETA', rodeo_id: 'R1', estado: 'activo', created_at: '1', rodeos: { club: 'X', fecha: '2026-01-01', tipo_rodeo_nombre: 'T', asociacion: 'Y' } }]
        });
        const r = await buscar();
        expect(r.body.jurados.map(j => j.id)).toEqual(['J-ALFA', 'J-BETA', 'J-ZETA']);
    });
});

describe('Permisos', () => {
    test.each(['analista', 'comision_tecnica'])('rol_evaluacion=%s -> 403', async (rol) => {
        preparar({ usuarios_pagados: [jurado('J1')] });
        const r = await buscar({}, { id: 'x', rol_evaluacion: rol });
        expect(r.statusCode).toBe(403);
    });
});
