// Mejora del Portal del Jurado — "Mi desempeño": resultados alterados,
// rodeos pendientes de evaluación y porcentaje de alteración, sobre el mismo
// universo ya existente de total_rodeos/promedio_nota/promedio_categoria.
// Incluye la corrección de rodeos futuros (ver comentario en resumen.js):
// un rodeo programado con designación ya aceptada/publicada no debe contar
// como "asistido" hasta que ocurra.
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

// Fechas fijas respecto a "hoy": PASADO siempre es pasado, FUTURO siempre es
// futuro, sin importar cuándo corra la suite (nunca una fecha hardcodeada).
const PASADO = '2000-01-01';
const FUTURO = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function asig(over) {
    return { estado: 'activo', publicado: true, estado_designacion: 'aceptado', rodeos: { fecha: PASADO }, ...over };
}

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
        asignaciones: [asig({ id: 'A1', usuario_pagado_id: 'J1', rodeo_id: 'R1' })],
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
        asignaciones: [asig({ id: 'A1', usuario_pagado_id: 'J1', rodeo_id: 'R1' })],
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
        asignaciones: [asig({ id: 'A1', usuario_pagado_id: 'J1', rodeo_id: 'R1' })],
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
            asig({ id: 'A1', usuario_pagado_id: 'J1', rodeo_id: 'R1' }),
            asig({ id: 'A2', usuario_pagado_id: 'J1', rodeo_id: 'R2' }),
            asig({ id: 'A3', usuario_pagado_id: 'J1', rodeo_id: 'R3' }),
            asig({ id: 'A4', usuario_pagado_id: 'J1', rodeo_id: 'R4' })
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
        asignaciones: [asig({ id: 'A1', usuario_pagado_id: 'J1', rodeo_id: 'R1', estado_designacion: 'rechazado' })],
        evaluaciones: [{ rodeo_id: 'R1', estado: 'publicado', resultados_alterados: true, anulada: false, es_historica_importacion: false }]
    });
    const r = await getDesempeno();
    expect(r.body.total_rodeos).toBe(0);
    expect(r.body.rodeos_alterados).toBe(0);
});

test('rodeo FUTURO con designación ya aceptada y publicada: NO cuenta como asistido, ni alterado, ni pendiente', async () => {
    preparar({
        usuarios_pagados: [JURADO_B],
        asignaciones: [
            asig({ id: 'A1', usuario_pagado_id: 'J1', rodeo_id: 'R1' }), // pasado, sí cuenta
            asig({ id: 'A2', usuario_pagado_id: 'J1', rodeo_id: 'R2', rodeos: { fecha: FUTURO } }) // futuro, no debe contar
        ],
        evaluaciones: [{ rodeo_id: 'R1', estado: 'publicado', resultados_alterados: true, anulada: false, es_historica_importacion: false }]
    });
    const r = await getDesempeno();
    expect(r.body.total_rodeos).toBe(1);
    expect(r.body.rodeos_alterados).toBe(1);
    expect(r.body.rodeos_pendientes_evaluacion).toBe(0); // el rodeo futuro NO debe inflar "pendientes"
    expect(r.body.porcentaje_alteracion).toBe(100); // 1/1, no 1/2
});

test('jurado con SOLO designaciones futuras: total 0, "Sin datos" (no 0 pendientes mal interpretados)', async () => {
    preparar({
        usuarios_pagados: [JURADO_B],
        asignaciones: [asig({ id: 'A1', usuario_pagado_id: 'J1', rodeo_id: 'R1', rodeos: { fecha: FUTURO } })]
    });
    const r = await getDesempeno();
    expect(r.body.total_rodeos).toBe(0);
    expect(r.body.rodeos_pendientes_evaluacion).toBe(0);
    expect(r.body.porcentaje_alteracion).toBeNull();
});

test('promedio_nota y promedio_categoria siguen calculándose igual que antes (no se rompieron al agregar rodeos(fecha) al select)', async () => {
    preparar({
        usuarios_pagados: [JURADO_B, { id: 'J2', categoria: 'B', tipo_persona: 'jurado', activo: true }],
        asignaciones: [
            asig({ id: 'A1', usuario_pagado_id: 'J1', rodeo_id: 'R1' }),
            asig({ id: 'A2', usuario_pagado_id: 'J2', rodeo_id: 'R2' })
        ],
        notas_rodeo: [{ asignacion_id: 'A1', nota: 6.0 }, { asignacion_id: 'A2', nota: 5.0 }]
    });
    const r = await getDesempeno();
    expect(r.body.promedio_nota).toBe(6);
    expect(r.body.promedio_categoria).toBe(5.5); // (6.0 + 5.0) / 2
});
