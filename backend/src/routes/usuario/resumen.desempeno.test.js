// Mejora del Portal del Jurado — "Mi desempeño": resultados alterados,
// rodeos pendientes de evaluación y porcentaje de alteración, sobre el mismo
// universo ya existente de total_rodeos/promedio_nota/promedio_categoria.
let mockDb;
jest.mock('../../config/supabase', () => new Proxy({}, { get: (_, k) => mockDb[k] }));

const { crearSupabaseMemoria, llamarRouter } = require('../../services/__fixtures__/supabaseMemoria');
const router = require('./resumen');

function preparar({ usuarios_pagados = [], asignaciones = [], evaluaciones = [], notas_rodeo = [] } = {}) {
    mockDb = crearSupabaseMemoria({ tablas: { usuarios_pagados, asignaciones, evaluaciones, notas_rodeo } });
}

function getDesempeno(usuarioId = 'J1') {
    return llamarRouter(router, { metodo: 'GET', url: '/desempeno', usuario: { id: usuarioId } });
}

const JURADO_B = { id: 'J1', categoria: 'B', tipo_persona: 'jurado', activo: true };

test('jurado sin rodeos asistidos: total 0, porcentaje "Sin datos" (null), nunca división por cero', async () => {
    preparar({ usuarios_pagados: [JURADO_B] });
    const r = await getDesempeno();
    expect(r.body).toMatchObject({
        total_rodeos: 0, rodeos_alterados: 0, rodeos_pendientes_evaluacion: 0, porcentaje_alteracion: null
    });
});

test('rodeo con evaluación publicada y resultados_alterados=true cuenta como alterado, no como pendiente', async () => {
    preparar({
        usuarios_pagados: [JURADO_B],
        asignaciones: [{ id: 'A1', usuario_pagado_id: 'J1', rodeo_id: 'R1', estado: 'activo', publicado: true, estado_designacion: 'aceptado' }],
        evaluaciones: [{ rodeo_id: 'R1', estado: 'publicado', resultados_alterados: true, anulada: false, es_historica_importacion: false }]
    });
    const r = await getDesempeno();
    expect(r.body.total_rodeos).toBe(1);
    expect(r.body.rodeos_alterados).toBe(1);
    expect(r.body.rodeos_pendientes_evaluacion).toBe(0);
    expect(r.body.porcentaje_alteracion).toBe(100);
});

test('rodeo sin evaluación -> pendiente (nunca se cuenta como "no alterado")', async () => {
    preparar({
        usuarios_pagados: [JURADO_B],
        asignaciones: [{ id: 'A1', usuario_pagado_id: 'J1', rodeo_id: 'R1', estado: 'activo', publicado: true, estado_designacion: 'aceptado' }],
        evaluaciones: []
    });
    const r = await getDesempeno();
    expect(r.body.total_rodeos).toBe(1);
    expect(r.body.rodeos_alterados).toBe(0);
    expect(r.body.rodeos_pendientes_evaluacion).toBe(1);
    expect(r.body.porcentaje_alteracion).toBe(0); // 0 alterados / 1 asistido
});

test('rodeo con evaluación en borrador (en_proceso) -> pendiente, no publicado', async () => {
    preparar({
        usuarios_pagados: [JURADO_B],
        asignaciones: [{ id: 'A1', usuario_pagado_id: 'J1', rodeo_id: 'R1', estado: 'activo', publicado: true, estado_designacion: 'aceptado' }],
        evaluaciones: [{ rodeo_id: 'R1', estado: 'en_proceso', resultados_alterados: false, anulada: false, es_historica_importacion: false }]
    });
    const r = await getDesempeno();
    expect(r.body.rodeos_pendientes_evaluacion).toBe(1);
    expect(r.body.rodeos_alterados).toBe(0);
});

test('porcentaje de alteración: 1 de 4 rodeos alterado = 25.0%, con un decimal', async () => {
    preparar({
        usuarios_pagados: [JURADO_B],
        asignaciones: [
            { id: 'A1', usuario_pagado_id: 'J1', rodeo_id: 'R1', estado: 'activo', publicado: true, estado_designacion: 'aceptado' },
            { id: 'A2', usuario_pagado_id: 'J1', rodeo_id: 'R2', estado: 'activo', publicado: true, estado_designacion: 'aceptado' },
            { id: 'A3', usuario_pagado_id: 'J1', rodeo_id: 'R3', estado: 'activo', publicado: true, estado_designacion: 'aceptado' },
            { id: 'A4', usuario_pagado_id: 'J1', rodeo_id: 'R4', estado: 'activo', publicado: true, estado_designacion: 'aceptado' }
        ],
        evaluaciones: [
            { rodeo_id: 'R1', estado: 'publicado', resultados_alterados: true,  anulada: false, es_historica_importacion: false },
            { rodeo_id: 'R2', estado: 'publicado', resultados_alterados: false, anulada: false, es_historica_importacion: false },
            { rodeo_id: 'R3', estado: 'cerrado',   resultados_alterados: false, anulada: false, es_historica_importacion: false },
            { rodeo_id: 'R4', estado: 'publicado', resultados_alterados: false, anulada: false, es_historica_importacion: false }
        ]
    });
    const r = await getDesempeno();
    expect(r.body.total_rodeos).toBe(4);
    expect(r.body.rodeos_alterados).toBe(1);
    expect(r.body.porcentaje_alteracion).toBe(25);
});

test('rodeo rechazado (estado_designacion=rechazado) no cuenta en total_rodeos ni en los indicadores nuevos', async () => {
    preparar({
        usuarios_pagados: [JURADO_B],
        asignaciones: [{ id: 'A1', usuario_pagado_id: 'J1', rodeo_id: 'R1', estado: 'activo', publicado: true, estado_designacion: 'rechazado' }],
        evaluaciones: [{ rodeo_id: 'R1', estado: 'publicado', resultados_alterados: true, anulada: false, es_historica_importacion: false }]
    });
    const r = await getDesempeno();
    expect(r.body.total_rodeos).toBe(0);
    expect(r.body.rodeos_alterados).toBe(0);
});

test('promedio_nota y promedio_categoria siguen calculándose igual que antes (no se rompieron al agregar rodeo_id al select)', async () => {
    preparar({
        usuarios_pagados: [JURADO_B, { id: 'J2', categoria: 'B', tipo_persona: 'jurado', activo: true }],
        asignaciones: [
            { id: 'A1', usuario_pagado_id: 'J1', rodeo_id: 'R1', estado: 'activo', publicado: true, estado_designacion: 'aceptado' },
            { id: 'A2', usuario_pagado_id: 'J2', rodeo_id: 'R2', estado: 'activo', publicado: true, estado_designacion: 'aceptado' }
        ],
        notas_rodeo: [{ asignacion_id: 'A1', nota: 6.0 }, { asignacion_id: 'A2', nota: 5.0 }]
    });
    const r = await getDesempeno();
    expect(r.body.promedio_nota).toBe(6);
    expect(r.body.promedio_categoria).toBe(5.5); // (6.0 + 5.0) / 2
});
