// Mejora del Portal del Jurado — "Mi historial de evaluaciones":
// GET /historial (lista + filtros + paginación) y GET /:id/detalle-historial
// (modal "Ver evaluación", con control de confidencialidad del analista).
let mockDb;
jest.mock('../../config/supabase', () => new Proxy({}, { get: (_, k) => mockDb[k] }));

const { crearSupabaseMemoria, llamarRouter } = require('../../services/__fixtures__/supabaseMemoria');
const router = require('./evaluaciones');

const J1 = { id: 'J1', tipo_persona: 'jurado' };
const J2 = { id: 'J2', tipo_persona: 'jurado' };

// R1: evaluación publicada, resultados_alterados=true. La fuente correcta del
// comentario es observacion_general (confirmado en admin/evaluacion-detalle.html,
// "Observación general del análisis") — comentario_resultados_alterados es el
// análisis interno del analista y NUNCA debe exponerse. 3 situaciones (1 R + 2 A).
const ASIG1 = { id: 'A1', usuario_pagado_id: 'J1', rodeo_id: 'R1', estado: 'activo', publicado: true, estado_designacion: 'aceptado', categoria_aplicada: 'B',
    rodeos: { id: 'R1', club: 'Club Uno', fecha: '2026-03-10', asociacion: 'COLCHAGUA', tipo_rodeo_nombre: 'Provincial', temporada_id: 'T1' } };
const EVAL1 = { id: 'EV1', rodeo_id: 'R1', estado: 'publicado', resultados_alterados: true, anulada: false, es_historica_importacion: false,
    observacion_general: 'Según esta revisión, diferencias en el 4to toro con la collera que obtuvo el 3er lugar.',
    comentario_resultados_alterados: 'SECRETO INTERNO DEL ANALISTA',
    rodeo: { id: 'R1', club: 'Club Uno', fecha: '2026-03-10', asociacion: 'COLCHAGUA', tipo_rodeo_nombre: 'Provincial' } };

// R2: evaluación publicada, resultados_alterados=false, con observación general
// (debe mostrarse igual, bajo el encabezado "Observación general del análisis",
// nunca presentada como fundamento de una alteración que no ocurrió).
const ASIG2 = { id: 'A2', usuario_pagado_id: 'J1', rodeo_id: 'R2', estado: 'activo', publicado: true, estado_designacion: 'aceptado', categoria_aplicada: 'B',
    rodeos: { id: 'R2', club: 'Club Dos', fecha: '2026-02-01', asociacion: 'MAULE', tipo_rodeo_nombre: 'Zonal', temporada_id: 'T1' } };
const EVAL2 = { id: 'EV2', rodeo_id: 'R2', estado: 'cerrado', resultados_alterados: false, anulada: false, es_historica_importacion: false,
    observacion_general: 'Rodeo sin novedades relevantes.',
    rodeo: { id: 'R2', club: 'Club Dos', fecha: '2026-02-01', asociacion: 'MAULE', tipo_rodeo_nombre: 'Zonal' } };

// R3: rodeo asistido SIN evaluación -> pendiente
const ASIG3 = { id: 'A3', usuario_pagado_id: 'J1', rodeo_id: 'R3', estado: 'activo', publicado: true, estado_designacion: 'aceptado', categoria_aplicada: 'A',
    rodeos: { id: 'R3', club: 'Club Tres', fecha: '2026-01-05', asociacion: 'ÑUBLE', tipo_rodeo_nombre: 'Provincial', temporada_id: 'T2' } };

// R4: evaluación en borrador (en_proceso) -> también pendiente, nunca se expone
const ASIG4 = { id: 'A4', usuario_pagado_id: 'J1', rodeo_id: 'R4', estado: 'activo', publicado: true, estado_designacion: 'aceptado', categoria_aplicada: 'A',
    rodeos: { id: 'R4', club: 'Club Cuatro', fecha: '2025-12-20', asociacion: 'ÑUBLE', tipo_rodeo_nombre: 'Provincial', temporada_id: 'T2' } };
const EVAL4 = { id: 'EV4', rodeo_id: 'R4', estado: 'en_proceso', resultados_alterados: false, anulada: false, es_historica_importacion: false,
    comentario_resultados_alterados: 'borrador, no debe verse',
    rodeo: { id: 'R4', club: 'Club Cuatro', fecha: '2025-12-20', asociacion: 'ÑUBLE', tipo_rodeo_nombre: 'Provincial' } };

// R5: rodeo SIN evaluación técnica digital (nunca pasó por el sistema de casos),
// pero con una nota ingresada manualmente por el administrador desde Hoja de
// Vida ("+ Nota", fuente='manual' por DEFAULT de columna — ver migración 017).
// Confirmado contra producción: 65/65 notas fuente='manual' están en
// asignaciones publicadas reales y 0 coexisten con una evaluación ya
// publicada (la publicación siempre sobrescribe fuente a 'evaluacion_tecnica').
// La nota SÍ debe mostrarse — igual que en Hoja de Vida — aunque el rodeo
// quede "pendiente" por no tener evaluación.
const ASIG5 = { id: 'A5', usuario_pagado_id: 'J1', rodeo_id: 'R5', estado: 'activo', publicado: true, estado_designacion: 'aceptado', categoria_aplicada: 'A',
    rodeos: { id: 'R5', club: 'Club Cinco', fecha: '2025-11-01', asociacion: 'ÑUBLE', tipo_rodeo_nombre: 'Provincial', temporada_id: 'T2' } };

// R6: resultados_alterados=true pero SIN observación general registrada (vacía)
// -> mensaje neutral, nunca null ni un fundamento inventado.
const ASIG6 = { id: 'A6', usuario_pagado_id: 'J1', estado: 'activo', publicado: true, estado_designacion: 'aceptado', categoria_aplicada: 'A',
    rodeo_id: 'R6', rodeos: { id: 'R6', club: 'Club Seis', fecha: '2025-10-01', asociacion: 'ÑUBLE', tipo_rodeo_nombre: 'Provincial', temporada_id: 'T2' } };
const EVAL6 = { id: 'EV6', rodeo_id: 'R6', estado: 'publicado', resultados_alterados: true, anulada: false, es_historica_importacion: false,
    observacion_general: null,
    comentario_resultados_alterados: 'análisis interno del analista',
    rodeo: { id: 'R6', club: 'Club Seis', fecha: '2025-10-01', asociacion: 'ÑUBLE', tipo_rodeo_nombre: 'Provincial' } };

// Rechazada -> nunca debe aparecer
const ASIG_RECHAZADA = { id: 'A7', usuario_pagado_id: 'J1', rodeo_id: 'R7', estado: 'activo', publicado: true, estado_designacion: 'rechazado',
    rodeos: { id: 'R7', club: 'Club Siete', fecha: '2026-04-01', temporada_id: 'T1' } };

// Otro jurado -> nunca debe aparecer en el historial de J1
const ASIG_J2 = { id: 'A8', usuario_pagado_id: 'J2', rodeo_id: 'R8', estado: 'activo', publicado: true, estado_designacion: 'aceptado',
    rodeos: { id: 'R8', club: 'Club Ocho', fecha: '2026-04-02', temporada_id: 'T1' } };

const CASOS_R1 = [
    { evaluacion_id: 'EV1', tipo_caso: 'reglamentaria', anulado: false },
    { evaluacion_id: 'EV1', tipo_caso: 'interpretativa', anulado: false },
    { evaluacion_id: 'EV1', tipo_caso: 'interpretativa', anulado: false },
    { evaluacion_id: 'EV1', tipo_caso: 'informativo', anulado: true } // anulado: no debe contar
];

const NOTAS = [
    { asignacion_id: 'A1', nota: 6.2, fuente: 'evaluacion_tecnica' },
    { asignacion_id: 'A2', nota: 5.0, fuente: 'evaluacion_tecnica' },
    { asignacion_id: 'A5', nota: 3.0, fuente: 'manual' } // nota manual real (sin evaluación): debe mostrarse igual que en Hoja de Vida
];

function preparar(extra = {}) {
    mockDb = crearSupabaseMemoria({
        tablas: {
            usuarios_pagados: [J1, J2],
            asignaciones: [ASIG1, ASIG2, ASIG3, ASIG4, ASIG5, ASIG6, ASIG_RECHAZADA, ASIG_J2],
            evaluaciones: [EVAL1, EVAL2, EVAL4, EVAL6],
            notas_rodeo: NOTAS,
            evaluacion_casos: CASOS_R1,
            ...extra
        }
    });
}

function getHistorial(query = {}, usuarioId = 'J1') {
    return llamarRouter(router, { metodo: 'GET', url: '/historial', query, usuario: { id: usuarioId } });
}

function getDetalle(id, usuarioId = 'J1') {
    return llamarRouter(router, { metodo: 'GET', url: `/${id}/detalle-historial`, params: { id }, usuario: { id: usuarioId } });
}

beforeEach(() => preparar());

// Rodeo FUTURO con designación ya aceptada/publicada: NO debe aparecer en
// "Mi historial de evaluaciones" (todavía no ocurrió — no es "pendiente de
// evaluación", simplemente no se ha jurado). Fecha calculada en runtime para
// que siempre sea futura, sin importar cuándo corra la suite.
const FUTURO = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const ASIG_FUTURA = { id: 'A11', usuario_pagado_id: 'J1', rodeo_id: 'R11', estado: 'activo', publicado: true, estado_designacion: 'aceptado', categoria_aplicada: 'B',
    rodeos: { id: 'R11', club: 'Club Once (futuro)', fecha: FUTURO, asociacion: 'COLCHAGUA', tipo_rodeo_nombre: 'Provincial', temporada_id: 'T1' } };

describe('GET /historial — lista', () => {
    test('rodeo futuro con designación ya aceptada/publicada: NO aparece en el historial (aún no ocurrió)', async () => {
        preparar({ asignaciones: [ASIG1, ASIG_FUTURA] });
        const r = await getHistorial({ limite: 100 });
        expect(r.body.total).toBe(1);
        expect(r.body.filas.map(f => f.club)).not.toContain('Club Once (futuro)');
    });

    test('totales sin duplicados: 6 rodeos asistidos de J1 (rechazado y de J2 excluidos)', async () => {
        const r = await getHistorial();
        expect(r.body.total).toBe(6);
        expect(r.body.filas.map(f => f.club)).not.toContain('Club Siete');
        expect(r.body.filas.map(f => f.club)).not.toContain('Club Ocho');
    });

    test('orden cronológico descendente por fecha', async () => {
        const r = await getHistorial({ limite: 100 });
        const fechas = r.body.filas.map(f => f.fecha);
        expect(fechas).toEqual([...fechas].sort().reverse());
    });

    test('desglose de situaciones de R1: coincide exactamente con el criterio de la Hoja de Vida (1 R + 2 A, anulado excluido)', async () => {
        const r = await getHistorial({ limite: 100 });
        const fila = r.body.filas.find(f => f.club === 'Club Uno');
        expect(fila.situaciones_por_tipo).toEqual({ reglamentaria: 1, interpretativa: 2 });
        expect(fila.situaciones_total).toBe(3);
    });

    test('rodeo sin evaluación -> resultado_alterado "pendiente", sin nota ni situaciones, sin eval_id', async () => {
        const r = await getHistorial({ limite: 100 });
        const fila = r.body.filas.find(f => f.club === 'Club Tres');
        expect(fila.resultado_alterado).toBe('pendiente');
        expect(fila.nota).toBeNull();
        expect(fila.situaciones_total).toBe(0);
        expect(fila.eval_id).toBeNull();
    });

    test('evaluación en borrador (en_proceso) -> también "pendiente", nunca se usa su resultados_alterados=false', async () => {
        const r = await getHistorial({ limite: 100 });
        const fila = r.body.filas.find(f => f.club === 'Club Cuatro');
        expect(fila.resultado_alterado).toBe('pendiente');
    });

    test('nota manual (fuente=manual, rodeo sin evaluación) se muestra igual que en Hoja de Vida, aunque el rodeo quede "pendiente"', async () => {
        const r = await getHistorial({ limite: 100 });
        const fila = r.body.filas.find(f => f.club === 'Club Cinco');
        expect(fila.resultado_alterado).toBe('pendiente');
        expect(fila.nota).toBe(3.0);
    });

    test('categoría histórica = categoria_aplicada de la asignación, no la categoría actual del jurado', async () => {
        const r = await getHistorial({ limite: 100 });
        const fila = r.body.filas.find(f => f.club === 'Club Tres');
        expect(fila.categoria).toBe('A');
    });

    test('filtro resultado=si: solo rodeos con alteración confirmada', async () => {
        const r = await getHistorial({ resultado: 'si', limite: 100 });
        expect(r.body.filas.every(f => f.resultado_alterado === true)).toBe(true);
        expect(r.body.filas.length).toBe(2); // R1 y R6
    });

    test('filtro resultado=pendiente: solo rodeos sin evaluación publicada', async () => {
        const r = await getHistorial({ resultado: 'pendiente', limite: 100 });
        expect(r.body.filas.every(f => f.resultado_alterado === 'pendiente')).toBe(true);
        expect(r.body.filas.length).toBe(3); // R3, R4 y R5 (R5 no tiene evaluación, solo una nota manual)
    });

    test('filtro temporada: T2 devuelve solo esos rodeos', async () => {
        const r = await getHistorial({ temporada: 'T2', limite: 100 });
        expect(r.body.filas.every(f => ['Club Tres', 'Club Cuatro', 'Club Cinco', 'Club Seis'].includes(f.club))).toBe(true);
        expect(r.body.filas.length).toBe(4);
    });

    test('paginación: limite=2 pagina=1 devuelve 2 filas y total global sin recortar', async () => {
        const r = await getHistorial({ limite: 2, pagina: 1 });
        expect(r.body.filas.length).toBe(2);
        expect(r.body.total).toBe(6);
    });

    test('paginación: pagina=2 trae las siguientes filas, sin solaparse con la página 1', async () => {
        const p1 = await getHistorial({ limite: 2, pagina: 1 });
        const p2 = await getHistorial({ limite: 2, pagina: 2 });
        const idsP1 = p1.body.filas.map(f => f.rodeo_id);
        const idsP2 = p2.body.filas.map(f => f.rodeo_id);
        expect(idsP1.some(id => idsP2.includes(id))).toBe(false);
    });

    test('jurado sin ningún rodeo asistido: lista vacía, total 0, sin error', async () => {
        preparar({ asignaciones: [] });
        const r = await getHistorial();
        expect(r.body).toEqual({ total: 0, pagina: 1, limite: 20, filas: [] });
    });

    test('tipo_persona distinto de jurado (ej. delegado) recibe lista vacía, sin fallar', async () => {
        preparar({ usuarios_pagados: [{ id: 'D1', tipo_persona: 'delegado_rentado' }] });
        const r = await getHistorial({}, 'D1');
        expect(r.body.filas).toEqual([]);
    });
});

describe('GET /:id/detalle-historial — modal "Ver evaluación"', () => {
    test('resultado alterado = Sí: se muestra el texto real e íntegro de observacion_general (fuente correcta confirmada en el admin)', async () => {
        const r = await getDetalle('EV1');
        expect(r.statusCode).toBe(200);
        expect(r.body.resultado_alterado).toBe(true);
        expect(r.body.observacion_general).toBe('Según esta revisión, diferencias en el 4to toro con la collera que obtuvo el 3er lugar.');
    });

    test('resultado alterado = No: igual se muestra la observación general (el botón "Ver evaluación" funciona también sin alteración)', async () => {
        const r = await getDetalle('EV2');
        expect(r.statusCode).toBe(200);
        expect(r.body.resultado_alterado).toBe(false);
        expect(r.body.observacion_general).toBe('Rodeo sin novedades relevantes.');
    });

    test('evaluación alterada SIN observación general registrada: mensaje neutral, nunca null ni inventado', async () => {
        const r = await getDetalle('EV6');
        expect(r.statusCode).toBe(200);
        expect(r.body.observacion_general).toBe('No existen observaciones disponibles para esta evaluación.');
    });

    test('evaluación SIN alteración y SIN observación general: también el mismo mensaje neutral (mismo criterio en ambos casos)', async () => {
        preparar({
            asignaciones: [{ id: 'A9', usuario_pagado_id: 'J1', rodeo_id: 'R9', estado: 'activo', publicado: true, estado_designacion: 'aceptado', categoria_aplicada: 'A' }],
            evaluaciones: [{ id: 'EV9', rodeo_id: 'R9', estado: 'publicado', resultados_alterados: false, anulada: false, es_historica_importacion: false, observacion_general: '   ',
                rodeo: { id: 'R9', club: 'Club Nueve', fecha: '2025-09-01', asociacion: 'ÑUBLE', tipo_rodeo_nombre: 'Provincial' } }]
        });
        const r = await getDetalle('EV9');
        expect(r.statusCode).toBe(200);
        expect(r.body.resultado_alterado).toBe(false);
        expect(r.body.observacion_general).toBe('No existen observaciones disponibles para esta evaluación.');
    });

    test('compatibilidad con notas manuales: una nota fuente=manual en una evaluación publicada igual se muestra (sin romper el detalle)', async () => {
        preparar({
            asignaciones: [{ id: 'A10', usuario_pagado_id: 'J1', rodeo_id: 'R10', estado: 'activo', publicado: true, estado_designacion: 'aceptado', categoria_aplicada: 'A' }],
            evaluaciones: [{ id: 'EV10', rodeo_id: 'R10', estado: 'publicado', resultados_alterados: false, anulada: false, es_historica_importacion: false, observacion_general: 'ok',
                rodeo: { id: 'R10', club: 'Club Diez', fecha: '2025-08-01', asociacion: 'ÑUBLE', tipo_rodeo_nombre: 'Provincial' } }],
            notas_rodeo: [{ asignacion_id: 'A10', nota: 4.5, fuente: 'manual' }]
        });
        const r = await getDetalle('EV10');
        expect(r.statusCode).toBe(200);
        expect(r.body.nota).toBe(4.5);
    });

    test('la respuesta nunca incluye identidad del analista ni el comentario interno de alteración (comentario_resultados_alterados)', async () => {
        const r = await getDetalle('EV1');
        const serializado = JSON.stringify(r.body);
        expect(serializado).not.toMatch(/SECRETO/);
        expect(serializado).not.toMatch(/analista/i);
    });

    test('desglose de situaciones en el detalle coincide con el de la lista', async () => {
        const r = await getDetalle('EV1');
        expect(r.body.situaciones_por_tipo).toEqual({ reglamentaria: 1, interpretativa: 2 });
        expect(r.body.situaciones_total).toBe(3);
    });

    test('nota técnica correcta (fuente evaluacion_tecnica)', async () => {
        const r = await getDetalle('EV1');
        expect(r.body.nota).toBe(6.2);
    });

    test('categoría histórica mostrada es la de la asignación de ese rodeo', async () => {
        const r = await getDetalle('EV1');
        expect(r.body.categoria).toBe('B');
    });

    test('evaluación no publicada (en_proceso) -> 403, el jurado nunca ve un borrador', async () => {
        const r = await getDetalle('EV4');
        expect(r.statusCode).toBe(403);
    });

    test('evaluación inexistente -> 404', async () => {
        const r = await getDetalle('NO-EXISTE');
        expect(r.statusCode).toBe(404);
    });

    test('un jurado no puede ver el detalle de la evaluación de otro jurado (sin asignación propia en ese rodeo)', async () => {
        const r = await getDetalle('EV1', 'J2');
        expect(r.statusCode).toBe(403);
    });
});
