// GET/PUT /api/admin/evaluacion-desempeno — pruebas de validación de período,
// mapeo de errores de la RPC de campos manuales, y que la RPC recibe
// exactamente los p_actualizar_* que el body pidió (nunca inferidos de la
// sola presencia de una clave, mismo criterio que corrigió el bug de
// notas-secundarias). No reprueba las fórmulas (ver
// evaluacionDesempenoJurados.test.js) — solo la capa HTTP.
jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
jest.mock('../../services/evaluacionDesempenoJurados', () => ({
    obtenerEvaluacionDesempeno: jest.fn()
}));

const supabase = require('../../config/supabase');
const { obtenerEvaluacionDesempeno } = require('../../services/evaluacionDesempenoJurados');
const router = require('./evaluacion-desempeno');

function crearResFake() {
    const res = {};
    res.statusCode = 200;
    res.status = jest.fn((c) => { res.statusCode = c; return res; });
    res.jsonBody = null;
    res.json = jest.fn((p) => { res.jsonBody = p; return res; });
    res.headersSent = false;
    res.setHeader = jest.fn();
    res.end = jest.fn();
    return res;
}
function llamar(method, url, body, query = {}, usuario = { id: 'admin-1', rol_evaluacion: null }) {
    return new Promise((resolve, reject) => {
        const req = { method, url, originalUrl: url, body: body || {}, params: {}, query, usuario, ip: '127.0.0.1' };
        const m = url.match(/^\/manual\/([^/?]+)/);
        if (m) req.params.usuarioId = m[1];
        const res = crearResFake();
        const jsonOriginal = res.json;
        const endOriginal = res.end;
        res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
        res.end = (...a) => { endOriginal(...a); resolve(res); return res; };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}

beforeEach(() => {
    supabase.rpc.mockReset();
    obtenerEvaluacionDesempeno.mockReset();
});

describe('GET /', () => {
    test('período inválido devuelto por el servicio -> 400', async () => {
        obtenerEvaluacionDesempeno.mockRejectedValue(new Error('PERIODO_REQUERIDO'));
        const res = await llamar('GET', '/', null, {});
        expect(res.statusCode).toBe(400);
        expect(res.jsonBody.error).toBe('PERIODO_REQUERIDO');
    });

    test('éxito -> 200 con el resultado del servicio, parámetros reenviados tal cual', async () => {
        obtenerEvaluacionDesempeno.mockResolvedValue({ periodo: { desde: '2026-01-01', hasta: '2026-10-12' }, filas: [] });
        const res = await llamar('GET', '/', null, { desde: '2026-01-01', hasta: '2026-10-12', categoria: 'A', search: 'juan', order: 'nota_ad_desc' });
        expect(res.statusCode).toBe(200);
        expect(obtenerEvaluacionDesempeno).toHaveBeenCalledWith({
            desde: '2026-01-01', hasta: '2026-10-12', categoria: 'A', search: 'juan', order: 'nota_ad_desc'
        });
    });

    test('error inesperado del servicio -> 500', async () => {
        obtenerEvaluacionDesempeno.mockRejectedValue(new Error('usuarios_pagados: boom'));
        const res = await llamar('GET', '/', null, { desde: '2026-01-01', hasta: '2026-10-12' });
        expect(res.statusCode).toBe(500);
    });
});

describe('PUT /manual/:usuarioId — validación en el endpoint (sin llamar a la RPC)', () => {
    test('sin período -> 400, nunca llama a la RPC', async () => {
        const res = await llamar('PUT', '/manual/j1', { actualizar_mal_jurado: true, mal_jurado: 3 });
        expect(res.statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('ningún campo marcado para actualizar -> 400, nunca llama a la RPC', async () => {
        const res = await llamar('PUT', '/manual/j1', { periodo_desde: '2026-01-01', periodo_hasta: '2026-10-12' });
        expect(res.statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('mal_jurado negativo -> 400, nunca llama a la RPC', async () => {
        const res = await llamar('PUT', '/manual/j1', {
            periodo_desde: '2026-01-01', periodo_hasta: '2026-10-12', actualizar_mal_jurado: true, mal_jurado: -1
        });
        expect(res.statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('mal_jurado no entero -> 400, nunca llama a la RPC', async () => {
        const res = await llamar('PUT', '/manual/j1', {
            periodo_desde: '2026-01-01', periodo_hasta: '2026-10-12', actualizar_mal_jurado: true, mal_jurado: 2.5
        });
        expect(res.statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });
});

describe('PUT /manual/:usuarioId — llamada a la RPC', () => {
    beforeEach(() => {
        supabase.rpc.mockResolvedValue({ data: { id: 'row-1', mal_jurado: 3, analisis_tecnico: null, actualizado_en: '2026-10-12T00:00:00Z' }, error: null });
    });

    test('actualizar solo mal_jurado -> p_actualizar_analisis_tecnico=false, p_analisis_tecnico=null', async () => {
        await llamar('PUT', '/manual/j1', {
            periodo_desde: '2026-01-01', periodo_hasta: '2026-10-12',
            actualizar_mal_jurado: true, mal_jurado: 3,
            actualizar_analisis_tecnico: false, analisis_tecnico: 'esto no debería enviarse'
        });
        const args = supabase.rpc.mock.calls[0][1];
        expect(args.p_actualizar_mal_jurado).toBe(true);
        expect(args.p_mal_jurado).toBe(3);
        expect(args.p_actualizar_analisis_tecnico).toBe(false);
        expect(args.p_analisis_tecnico).toBe(null); // nunca se filtra el valor de un campo que no se pidió actualizar
    });

    test('actualizar solo analisis_tecnico -> p_actualizar_mal_jurado=false, p_mal_jurado=null', async () => {
        await llamar('PUT', '/manual/j1', {
            periodo_desde: '2026-01-01', periodo_hasta: '2026-10-12',
            actualizar_mal_jurado: false, mal_jurado: 999,
            actualizar_analisis_tecnico: true, analisis_tecnico: 'Comentario real'
        });
        const args = supabase.rpc.mock.calls[0][1];
        expect(args.p_actualizar_mal_jurado).toBe(false);
        expect(args.p_mal_jurado).toBe(null);
        expect(args.p_actualizar_analisis_tecnico).toBe(true);
        expect(args.p_analisis_tecnico).toBe('Comentario real');
    });

    test('reenvía p_actualizado_en_esperado y p_administrador_id tal cual', async () => {
        await llamar('PUT', '/manual/j1', {
            periodo_desde: '2026-01-01', periodo_hasta: '2026-10-12',
            actualizar_mal_jurado: true, mal_jurado: 0,
            actualizado_en_esperado: '2026-10-10T00:00:00Z'
        }, {}, { id: 'admin-xyz', rol_evaluacion: null });
        const args = supabase.rpc.mock.calls[0][1];
        expect(args.p_administrador_id).toBe('admin-xyz');
        expect(args.p_actualizado_en_esperado).toBe('2026-10-10T00:00:00Z');
        expect(args.p_mal_jurado).toBe(0); // 0 es un valor válido, nunca se confunde con "no enviado"
    });

    test('éxito -> 200 con el row devuelto por la RPC', async () => {
        const res = await llamar('PUT', '/manual/j1', {
            periodo_desde: '2026-01-01', periodo_hasta: '2026-10-12', actualizar_mal_jurado: true, mal_jurado: 3
        });
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.mal_jurado).toBe(3);
    });
});

describe('PUT /manual/:usuarioId — mapeo de errores de la RPC', () => {
    test('CONFLICTO_CONCURRENCIA -> 409', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'CONFLICTO_CONCURRENCIA' } });
        const res = await llamar('PUT', '/manual/j1', { periodo_desde: '2026-01-01', periodo_hasta: '2026-10-12', actualizar_mal_jurado: true, mal_jurado: 3 });
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('CONFLICTO_CONCURRENCIA');
    });

    test('JURADO_NO_ENCONTRADO -> 404', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'JURADO_NO_ENCONTRADO' } });
        const res = await llamar('PUT', '/manual/j1', { periodo_desde: '2026-01-01', periodo_hasta: '2026-10-12', actualizar_mal_jurado: true, mal_jurado: 3 });
        expect(res.statusCode).toBe(404);
    });

    test('PERIODO_INVALIDO (devuelto por la RPC) -> 400', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'PERIODO_INVALIDO' } });
        const res = await llamar('PUT', '/manual/j1', { periodo_desde: '2026-10-12', periodo_hasta: '2026-01-01', actualizar_mal_jurado: true, mal_jurado: 3 });
        expect(res.statusCode).toBe(400);
    });

    test('error desconocido -> 500', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'ALGO_NO_MAPEADO' } });
        const res = await llamar('PUT', '/manual/j1', { periodo_desde: '2026-01-01', periodo_hasta: '2026-10-12', actualizar_mal_jurado: true, mal_jurado: 3 });
        expect(res.statusCode).toBe(500);
    });
});
