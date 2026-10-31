// GET /api/admin/rodeos/:id/jurados-candidatos-reemplazo — buscador de
// reemplazo mejorado (Rodeos → Ver → Reemplazar jurado). A diferencia de
// /jurados-disponibles (Designar jurado), este endpoint NUNCA excluye a un
// candidato por tener conflicto: lo incluye con el detalle exacto de por qué
// no está disponible, para que el administrador entienda la situación.
let mockDb;
jest.mock('../../config/supabase', () => new Proxy({}, { get: (_, k) => mockDb[k] }));

const { crearSupabaseMemoria, llamarRouter } = require('../../services/__fixtures__/supabaseMemoria');
const router = require('./rodeos');

// Rodeo de destino: HUEMUL, COLCHAGUA, 07 al 08-11-2026 (2 días) — mismo
// ejemplo del pedido.
const RODEO = { id: 'R-HUEMUL', asociacion: 'COLCHAGUA', fecha: '2026-11-07', duracion_dias: 2, club: 'HUEMUL' };
const ASIG_ACTUAL = { id: 'A-ACTUAL', rodeo_id: 'R-HUEMUL', usuario_pagado_id: 'J-ANTERIOR', tipo_persona: 'jurado', estado: 'activo', created_at: '0' };

function preparar({ rodeos = [RODEO], usuarios_pagados = [], disponibilidad_usuarios = [], asignaciones = [ASIG_ACTUAL], notas_rodeo = [] } = {}) {
    mockDb = crearSupabaseMemoria({ tablas: { rodeos, usuarios_pagados, disponibilidad_usuarios, asignaciones, notas_rodeo } });
}

function buscar(query = {}, usuario) {
    return llamarRouter(router, {
        metodo: 'GET', url: '/R-HUEMUL/jurados-candidatos-reemplazo',
        params: { id: 'R-HUEMUL' }, query: { asignacion_id: 'A-ACTUAL', ...query }, usuario
    });
}

function jurado(id, extra = {}) {
    return { id, nombre_completo: 'Jurado ' + id, categoria: 'A', codigo_interno: 'J-' + id, asociacion: 'OTRA', comuna: 'X', activo: true, tipo_persona: 'jurado', ...extra };
}

const DISP_COMPLETA = (id) => ([
    { usuario_pagado_id: id, fecha: '2026-11-07' },
    { usuario_pagado_id: id, fecha: '2026-11-08' }
]);

describe('Validaciones previas', () => {
    test('asignacion_id requerido -> 400', async () => {
        preparar();
        const r = await llamarRouter(router, { metodo: 'GET', url: '/R-HUEMUL/jurados-candidatos-reemplazo', params: { id: 'R-HUEMUL' }, query: {} });
        expect(r.statusCode).toBe(400);
    });
    test('asignacion_id inexistente -> 404', async () => {
        preparar();
        const r = await buscar({ asignacion_id: 'NO-EXISTE' });
        expect(r.statusCode).toBe(404);
    });
    test('asignacion_id de OTRO rodeo -> 400 (no pertenece a este rodeo)', async () => {
        preparar({ asignaciones: [{ ...ASIG_ACTUAL, rodeo_id: 'R-OTRO' }] });
        const r = await buscar();
        expect(r.statusCode).toBe(400);
    });
    test('asignacion_id de tipo_persona distinto de jurado -> 400', async () => {
        preparar({ asignaciones: [{ ...ASIG_ACTUAL, tipo_persona: 'delegado_rentado' }] });
        const r = await buscar();
        expect(r.statusCode).toBe(400);
    });
    test('rodeo de destino inexistente -> 404', async () => {
        preparar({ rodeos: [] });
        const r = await buscar();
        expect(r.statusCode).toBe(404);
    });
    test('el ocupante actual de la asignación nunca aparece como su propio candidato', async () => {
        preparar({ usuarios_pagados: [jurado('J-ANTERIOR')] });
        const r = await buscar();
        expect(r.body.candidatos).toEqual([]);
    });
});

describe('1) Candidato disponible', () => {
    test('con disponibilidad declarada, sin conflictos, sin otra designación en este rodeo -> todo en orden', async () => {
        preparar({ usuarios_pagados: [jurado('J1')], disponibilidad_usuarios: DISP_COMPLETA('J1') });
        const r = await buscar();
        expect(r.body.candidatos).toEqual([expect.objectContaining({
            id: 'J1', disponibilidad_declarada: true, ya_asignado_en_rodeo: false, conflictos: []
        })]);
    });
});

describe('2) Candidato designado en otro rodeo el mismo día', () => {
    test('otro rodeo de 1 día que cae en el primer día del destino -> aparece como conflicto, NUNCA oculto', async () => {
        preparar({
            usuarios_pagados: [jurado('J1')],
            disponibilidad_usuarios: DISP_COMPLETA('J1'),
            asignaciones: [ASIG_ACTUAL, { id: 'A2', usuario_pagado_id: 'J1', rodeo_id: 'R-BULNES', estado: 'activo', estado_designacion: 'aceptado', created_at: '1', rodeos: { id: 'R-BULNES', club: 'BULNES', asociacion: 'ÑUBLE CORDILLERA', fecha: '2026-11-07', duracion_dias: 1, tipo_rodeo_nombre: 'Provincial' } }]
        });
        const r = await buscar();
        expect(r.body.candidatos.map(c => c.id)).toEqual(['J1']); // visible, no oculto
        expect(r.body.candidatos[0].conflictos).toEqual([{
            rodeo_id: 'R-BULNES', club: 'BULNES', asociacion: 'ÑUBLE CORDILLERA',
            fecha_inicio: '2026-11-07', fecha_fin: '2026-11-07', tipo_rodeo: 'Provincial', estado_designacion: 'aceptado'
        }]);
    });
});

describe('3) Conflicto de fechas de rodeos de dos días (ejemplo real del pedido)', () => {
    test('BULNES 07 al 08-11-2026 se cruza con HUEMUL 07 al 08-11-2026 aunque ninguna fecha de inicio coincida al revés', async () => {
        preparar({
            usuarios_pagados: [jurado('JORGE')],
            disponibilidad_usuarios: DISP_COMPLETA('JORGE'),
            asignaciones: [ASIG_ACTUAL, { id: 'A2', usuario_pagado_id: 'JORGE', rodeo_id: 'R-BULNES', estado: 'activo', estado_designacion: 'pendiente', created_at: '1', rodeos: { id: 'R-BULNES', club: 'BULNES', asociacion: 'ÑUBLE CORDILLERA', fecha: '2026-11-07', duracion_dias: 2, tipo_rodeo_nombre: 'Provincial' } }]
        });
        const r = await buscar();
        expect(r.body.candidatos[0].conflictos[0]).toMatchObject({ club: 'BULNES', fecha_inicio: '2026-11-07', fecha_fin: '2026-11-08' });
    });
    test('rodeo B termina el mismo día en que A empieza (solapamiento de un solo día) -> SÍ hay conflicto', async () => {
        preparar({
            usuarios_pagados: [jurado('J1')],
            disponibilidad_usuarios: DISP_COMPLETA('J1'),
            asignaciones: [ASIG_ACTUAL, { id: 'A2', usuario_pagado_id: 'J1', rodeo_id: 'R-PREV', estado: 'activo', created_at: '1', rodeos: { id: 'R-PREV', club: 'PREV', asociacion: 'X', fecha: '2026-11-06', duracion_dias: 2, tipo_rodeo_nombre: 'T' } }]
        });
        const r = await buscar();
        expect(r.body.candidatos[0].conflictos).toHaveLength(1); // R-PREV termina 2026-11-07, el destino empieza ese mismo día
    });
    test('sin solapamiento real (termina antes de que empiece el destino) -> sin conflicto', async () => {
        preparar({
            usuarios_pagados: [jurado('J1')],
            disponibilidad_usuarios: DISP_COMPLETA('J1'),
            asignaciones: [ASIG_ACTUAL, { id: 'A2', usuario_pagado_id: 'J1', rodeo_id: 'R-LEJOS', estado: 'activo', created_at: '1', rodeos: { id: 'R-LEJOS', club: 'LEJOS', asociacion: 'X', fecha: '2026-10-01', duracion_dias: 1, tipo_rodeo_nombre: 'T' } }]
        });
        const r = await buscar();
        expect(r.body.candidatos[0].conflictos).toEqual([]);
    });
});

describe('4) Candidato con varios conflictos', () => {
    test('se listan TODOS los rodeos con los que se cruza, no solo el primero', async () => {
        preparar({
            usuarios_pagados: [jurado('J1')],
            disponibilidad_usuarios: DISP_COMPLETA('J1'),
            asignaciones: [
                ASIG_ACTUAL,
                { id: 'A2', usuario_pagado_id: 'J1', rodeo_id: 'R-X', estado: 'activo', created_at: '1', rodeos: { id: 'R-X', club: 'X', asociacion: 'A1', fecha: '2026-11-07', duracion_dias: 1, tipo_rodeo_nombre: 'T' } },
                { id: 'A3', usuario_pagado_id: 'J1', rodeo_id: 'R-Y', estado: 'activo', created_at: '1', rodeos: { id: 'R-Y', club: 'Y', asociacion: 'A2', fecha: '2026-11-08', duracion_dias: 1, tipo_rodeo_nombre: 'T' } }
            ]
        });
        const r = await buscar();
        expect(r.body.candidatos[0].conflictos.map(c => c.club).sort()).toEqual(['X', 'Y']);
    });
    test('un conflicto ANULADO nunca cuenta', async () => {
        preparar({
            usuarios_pagados: [jurado('J1')],
            disponibilidad_usuarios: DISP_COMPLETA('J1'),
            asignaciones: [ASIG_ACTUAL, { id: 'A2', usuario_pagado_id: 'J1', rodeo_id: 'R-X', estado: 'anulado', created_at: '1', rodeos: { id: 'R-X', club: 'X', asociacion: 'A1', fecha: '2026-11-07', duracion_dias: 1, tipo_rodeo_nombre: 'T' } }]
        });
        const r = await buscar();
        expect(r.body.candidatos[0].conflictos).toEqual([]);
    });
});

describe('5) Candidato sin disponibilidad declarada', () => {
    test('falta disponibilidad para una de las 2 fechas -> disponibilidad_declarada:false, pero SIGUE visible', async () => {
        preparar({ usuarios_pagados: [jurado('J1')], disponibilidad_usuarios: [{ usuario_pagado_id: 'J1', fecha: '2026-11-07' }] });
        const r = await buscar();
        expect(r.body.candidatos).toEqual([expect.objectContaining({ id: 'J1', disponibilidad_declarada: false })]);
    });
    test('sin ninguna disponibilidad declarada -> disponibilidad_declarada:false, visible igual', async () => {
        preparar({ usuarios_pagados: [jurado('J1')], disponibilidad_usuarios: [] });
        const r = await buscar();
        expect(r.body.candidatos[0].disponibilidad_declarada).toBe(false);
    });
});

describe('6) Historial de designaciones y notas existentes', () => {
    test('incluye hasta 3 últimos rodeos con nota cuando existe, y el conteo histórico total', async () => {
        preparar({
            usuarios_pagados: [jurado('J1')],
            disponibilidad_usuarios: DISP_COMPLETA('J1'),
            asignaciones: [
                ASIG_ACTUAL,
                { id: 'H1', usuario_pagado_id: 'J1', rodeo_id: 'R1', estado: 'activo', created_at: '4', rodeos: { club: 'C1', fecha: '2026-01-01', tipo_rodeo_nombre: 'T1', asociacion: 'X' } },
                { id: 'H2', usuario_pagado_id: 'J1', rodeo_id: 'R2', estado: 'activo', created_at: '3', rodeos: { club: 'C2', fecha: '2026-02-01', tipo_rodeo_nombre: 'T2', asociacion: 'X' } },
                { id: 'H3', usuario_pagado_id: 'J1', rodeo_id: 'R3', estado: 'activo', created_at: '2', rodeos: { club: 'C3', fecha: '2026-03-01', tipo_rodeo_nombre: 'T3', asociacion: 'X' } },
                { id: 'H4', usuario_pagado_id: 'J1', rodeo_id: 'R4', estado: 'activo', created_at: '1', rodeos: { club: 'C4', fecha: '2026-04-01', tipo_rodeo_nombre: 'T4', asociacion: 'X' } }
            ],
            notas_rodeo: [{ asignacion_id: 'H1', nota: 5.5 }]
        });
        const r = await buscar();
        const c = r.body.candidatos[0];
        expect(c.historial).toHaveLength(3);
        expect(c.historial[0]).toEqual({ club: 'C1', fecha: '2026-01-01', tipo_rodeo: 'T1', asociacion: 'X', nota: 5.5 });
        expect(c.designaciones).toBe(4);
    });
});

describe('7) Repetición de asociación', () => {
    test('historial previo en la MISMA asociación del rodeo destino -> repite_asociacion:true', async () => {
        preparar({
            usuarios_pagados: [jurado('J1')],
            disponibilidad_usuarios: DISP_COMPLETA('J1'),
            asignaciones: [ASIG_ACTUAL, { id: 'H1', usuario_pagado_id: 'J1', rodeo_id: 'R-PREV', estado: 'activo', created_at: '1', 'rodeos.asociacion': 'COLCHAGUA', rodeos: { fecha: '2026-05-01', duracion_dias: 1, club: 'RANCAGUA', asociacion: 'COLCHAGUA', tipo_rodeo_nombre: 'Provincial' } }]
        });
        const r = await buscar();
        expect(r.body.candidatos[0].repite_asociacion).toBe(true);
    });
});

describe('Ya asignado en este mismo rodeo (otra asignación)', () => {
    test('jurado con OTRA asignación activa, aceptada, en este rodeo -> ya_asignado_en_rodeo:true, visible', async () => {
        preparar({
            usuarios_pagados: [jurado('J1')],
            disponibilidad_usuarios: DISP_COMPLETA('J1'),
            asignaciones: [ASIG_ACTUAL, { id: 'A-OTRA-SLOT', usuario_pagado_id: 'J1', rodeo_id: 'R-HUEMUL', estado: 'activo', estado_designacion: 'pendiente', created_at: '1' }]
        });
        const r = await buscar();
        expect(r.body.candidatos[0].ya_asignado_en_rodeo).toBe(true);
    });
    test('si esa otra asignación fue RECHAZADA, no bloquea (mismo criterio que la RPC)', async () => {
        preparar({
            usuarios_pagados: [jurado('J1')],
            disponibilidad_usuarios: DISP_COMPLETA('J1'),
            asignaciones: [ASIG_ACTUAL, { id: 'A-OTRA-SLOT', usuario_pagado_id: 'J1', rodeo_id: 'R-HUEMUL', estado: 'activo', estado_designacion: 'rechazado', created_at: '1' }]
        });
        const r = await buscar();
        expect(r.body.candidatos[0].ya_asignado_en_rodeo).toBe(false);
    });
});

describe('Orden de presentación: sin impedimentos primero', () => {
    test('un candidato bloqueado (conflicto) queda después de uno disponible, aunque tenga menos designaciones', async () => {
        preparar({
            usuarios_pagados: [jurado('J-BLOQUEADO', { nombre_completo: 'Alfa Bloqueado' }), jurado('J-LIBRE', { nombre_completo: 'Zeta Libre' })],
            disponibilidad_usuarios: [...DISP_COMPLETA('J-BLOQUEADO'), ...DISP_COMPLETA('J-LIBRE')],
            asignaciones: [ASIG_ACTUAL, { id: 'A2', usuario_pagado_id: 'J-BLOQUEADO', rodeo_id: 'R-X', estado: 'activo', created_at: '1', rodeos: { id: 'R-X', club: 'X', asociacion: 'A1', fecha: '2026-11-07', duracion_dias: 1, tipo_rodeo_nombre: 'T' } }]
        });
        const r = await buscar();
        expect(r.body.candidatos.map(c => c.id)).toEqual(['J-LIBRE', 'J-BLOQUEADO']);
    });
});

describe('Permisos', () => {
    test.each(['analista', 'comision_tecnica'])('rol_evaluacion=%s -> 403', async (rol) => {
        preparar({ usuarios_pagados: [jurado('J1')] });
        const r = await buscar({}, { id: 'x', rol_evaluacion: rol });
        expect(r.statusCode).toBe(403);
    });
});
