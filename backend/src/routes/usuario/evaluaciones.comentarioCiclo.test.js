// Feature flag ENABLE_COMENTARIO_CICLO_JURADO — deshabilita temporalmente el
// comentario general del jurado por ciclo (decisión administrativa), sin
// borrar código ni datos históricos. Por defecto (variable ausente) debe
// quedar deshabilitado.
let mockDb;
jest.mock('../../config/supabase', () => new Proxy({}, { get: (_, k) => mockDb[k] }));

const { crearSupabaseMemoria, llamarRouter } = require('../../services/__fixtures__/supabaseMemoria');
const router = require('./evaluaciones');

const EV = {
    id: 'E1', estado: 'en_revision', rodeo_id: 'R1', modo_flujo: 'descuento_automatico',
    es_historica_importacion: false,
    rodeo: { club: 'HUEMUL', fecha: '2026-01-01', asociacion: 'COLCHAGUA', tipo_rodeo_nombre: 'Provincial' }
};
const ASIG = { id: 'A1', usuario_pagado_id: 'J1', rodeo_id: 'R1', estado: 'activo', publicado: true, estado_designacion: 'aceptado' };
const CICLO1 = { id: 'C1', evaluacion_id: 'E1', numero_ciclo: 1, estado: 'abierto', es_ciclo_sin_casos: false };
const CICLO2 = { id: 'C2', evaluacion_id: 'E1', numero_ciclo: 2, estado: 'abierto', es_ciclo_sin_casos: false };
const COMENTARIO_HIST = { id: 'CM1', ciclo_id: 'C1', asignacion_id: 'A1', comentario: 'Acepto', estado: 'enviado', enviado_en: '2026-01-02T00:00:00Z' };

function preparar({ evaluaciones = [EV], asignaciones = [ASIG], evaluacion_ciclos = [CICLO1, CICLO2], evaluacion_comentarios_jurado_ciclo = [COMENTARIO_HIST], evaluacion_casos = [], evaluacion_respuestas_jurado = [] } = {}) {
    mockDb = crearSupabaseMemoria({ tablas: { evaluaciones, asignaciones, evaluacion_ciclos, evaluacion_comentarios_jurado_ciclo, evaluacion_casos, evaluacion_respuestas_jurado } });
}

function getCasos() {
    return llamarRouter(router, { metodo: 'GET', url: '/E1/casos', params: { id: 'E1' }, usuario: { id: 'J1' } });
}

function postComentario(cicloId = 'C1', comentario = 'Sin comentarios') {
    return llamarRouter(router, { metodo: 'POST', url: `/E1/ciclos/${cicloId}/comentario`, params: { id: 'E1', cicloId }, body: { comentario }, usuario: { id: 'J1' } });
}

const ORIGINAL_FLAG = process.env.ENABLE_COMENTARIO_CICLO_JURADO;
afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.ENABLE_COMENTARIO_CICLO_JURADO;
    else process.env.ENABLE_COMENTARIO_CICLO_JURADO = ORIGINAL_FLAG;
});

describe('Feature flag deshabilitada por defecto (variable ausente)', () => {
    test('GET /:id/casos informa comentario_ciclo_habilitado:false', async () => {
        delete process.env.ENABLE_COMENTARIO_CICLO_JURADO;
        preparar();
        const r = await getCasos();
        expect(r.body.evaluacion.comentario_ciclo_habilitado).toBe(false);
    });

    test('POST comentario -> 403 con comentario_ciclo_disabled:true, no escribe nada', async () => {
        delete process.env.ENABLE_COMENTARIO_CICLO_JURADO;
        preparar();
        const r = await postComentario();
        expect(r.statusCode).toBe(403);
        expect(r.body.comentario_ciclo_disabled).toBe(true);
        expect(mockDb.llamadas('evaluacion_comentarios_jurado_ciclo', 'update')).toHaveLength(0);
        expect(mockDb.llamadas('evaluacion_comentarios_jurado_ciclo', 'insert')).toHaveLength(0);
    });

    test('POST con valor explícito distinto de "true" también bloquea (no basta con setear la variable a cualquier cosa)', async () => {
        process.env.ENABLE_COMENTARIO_CICLO_JURADO = 'false';
        preparar();
        const r = await postComentario();
        expect(r.statusCode).toBe(403);
    });

    test('los comentarios históricos siguen llegando en la lectura (solo se oculta en el frontend, no se borra el dato)', async () => {
        delete process.env.ENABLE_COMENTARIO_CICLO_JURADO;
        preparar();
        const r = await getCasos();
        expect(r.body.ciclo1.mi_comentario).toEqual(expect.objectContaining({ comentario: 'Acepto', estado: 'enviado' }));
    });

    test('casos y descuentos automáticos de la respuesta no se ven afectados por el flag', async () => {
        delete process.env.ENABLE_COMENTARIO_CICLO_JURADO;
        preparar({ evaluacion_casos: [{ id: 'CS1', ciclo_id: 'C1', numero_caso: 1, tipo_caso: 'reglamentaria', estado: 'resuelto', descripcion: 'x', descuento_puntos: 2, anulado: false }] });
        const r = await getCasos();
        expect(r.body.ciclo1.casos).toHaveLength(1);
        expect(r.body.ciclo1.casos[0].descuento_puntos).toBe(2);
    });
});

describe('Feature flag habilitada explícitamente (ENABLE_COMENTARIO_CICLO_JURADO=true)', () => {
    test('GET /:id/casos informa comentario_ciclo_habilitado:true', async () => {
        process.env.ENABLE_COMENTARIO_CICLO_JURADO = 'true';
        preparar();
        const r = await getCasos();
        expect(r.body.evaluacion.comentario_ciclo_habilitado).toBe(true);
    });

    test('POST comentario funciona igual que antes (se recupera el comportamiento original)', async () => {
        process.env.ENABLE_COMENTARIO_CICLO_JURADO = 'true';
        preparar({ evaluacion_comentarios_jurado_ciclo: [] });
        const r = await postComentario('C1', 'Todo correcto');
        expect(r.statusCode).toBe(201);
        expect(r.body.comentario).toBe('Todo correcto');
        expect(r.body.estado).toBe('enviado');
    });
});
