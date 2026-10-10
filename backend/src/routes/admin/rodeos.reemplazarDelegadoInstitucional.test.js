// Fase 3.5 — POST /api/admin/rodeos/:id/reemplazar-delegado-institucional.
// Único camino autorizado para reemplazar al Delegado de Asociación
// responsable YA CONFIRMADO de un rodeo (institucional/rodeos.js bloquea
// cualquier cambio directo desde el portal). Se prueba: motivo requerido,
// validación del delegado contra la asociación REAL del rodeo (nunca
// confiando en el frontend), y el mapeo de los 3 códigos de error que
// devuelve la RPC (migración 069) a respuestas HTTP claras — sin asumir
// nada que la RPC no haya devuelto.
jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));

const supabase = require('../../config/supabase');
const router = require('./rodeos');

let respuestas;
function crearChain(tabla) {
    const chain = {};
    ['select', 'eq', 'in', 'order'].forEach(m => { chain[m] = () => chain; });
    chain.single = () => Promise.resolve(respuestas[tabla]?.single ?? { data: null, error: null });
    chain.maybeSingle = () => Promise.resolve(respuestas[tabla]?.maybeSingle ?? { data: null, error: null });
    chain.then = (resolve, reject) => Promise.resolve(respuestas[tabla]?.list ?? { data: [], error: null }).then(resolve, reject);
    return chain;
}

// nombre_normalizado refleja el mismo criterio de normalizarAsociacion()
// (services/asociaciones.js): sin tildes, minúsculas, y SIN el prefijo
// "asociacion " — nunca "asociacion osorno" literal, o resolverAsociacion()
// nunca encuentra coincidencia (bug detectado al escribir este mismo test).
const ASOCIACION_OSORNO = { id: 'asoc-osorno', nombre: 'Asociación Osorno', nombre_normalizado: 'osorno', activa: true };
const RODEO = { id: 'rodeo-1', club: 'Club Rahue', asociacion: 'Asociación Osorno', fecha: '2026-03-01' };
const DELEGADO_OK = { id: 'del-nuevo', nombre: 'Pedro Soto', asociacion_id: 'asoc-osorno', activo: true, certificado: true };

beforeEach(() => {
    respuestas = {
        rodeos: { maybeSingle: { data: RODEO, error: null } },
        asociaciones: { list: { data: [ASOCIACION_OSORNO], error: null } },
        asociacion_alias: { list: { data: [], error: null } },
        delegados_asociacion: { maybeSingle: { data: DELEGADO_OK, error: null } }
    };
    supabase.from.mockReset();
    supabase.from.mockImplementation(tabla => crearChain(tabla));
    supabase.rpc.mockReset();
    supabase.rpc.mockImplementation(() => Promise.resolve({
        data: { id: 'desig-1', rodeo_id: RODEO.id, delegado_asociacion_id: DELEGADO_OK.id },
        error: null
    }));
});

function crearResFake() {
    const res = {};
    res.statusCode = 200;
    res.status = jest.fn((c) => { res.statusCode = c; return res; });
    res.jsonBody = null;
    res.json = jest.fn((p) => { res.jsonBody = p; return res; });
    return res;
}
function llamar(body, usuario = { id: 'admin-1', rol_evaluacion: null }) {
    return new Promise((resolve, reject) => {
        const ruta = '/rodeo-1/reemplazar-delegado-institucional';
        const req = { method: 'POST', url: ruta, originalUrl: ruta, body: body || {}, params: {}, query: {}, usuario };
        const res = crearResFake();
        const jsonOriginal = res.json;
        res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}

describe('POST /admin/rodeos/:id/reemplazar-delegado-institucional', () => {
    test('motivo vacío -> 422, nunca llama a la RPC', async () => {
        const res = await llamar({ nuevo_delegado_asociacion_id: 'del-nuevo', motivo: '  ' });
        expect(res.statusCode).toBe(422);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('nuevo_delegado_asociacion_id ausente -> 400, nunca llama a la RPC', async () => {
        const res = await llamar({ motivo: 'Juan no puede continuar' });
        expect(res.statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('rodeo inexistente -> 404', async () => {
        respuestas.rodeos = { maybeSingle: { data: null, error: null } };
        const res = await llamar({ nuevo_delegado_asociacion_id: 'del-nuevo', motivo: 'reemplazo' });
        expect(res.statusCode).toBe(404);
    });

    test('delegado de OTRA asociación -> 403, nunca llama a la RPC (nunca confía en el frontend)', async () => {
        respuestas.delegados_asociacion = { maybeSingle: { data: { ...DELEGADO_OK, asociacion_id: 'asoc-otra' }, error: null } };
        const res = await llamar({ nuevo_delegado_asociacion_id: 'del-nuevo', motivo: 'reemplazo' });
        expect(res.statusCode).toBe(403);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('delegado inactivo -> 403, nunca llama a la RPC', async () => {
        respuestas.delegados_asociacion = { maybeSingle: { data: { ...DELEGADO_OK, activo: false }, error: null } };
        const res = await llamar({ nuevo_delegado_asociacion_id: 'del-nuevo', motivo: 'reemplazo' });
        expect(res.statusCode).toBe(403);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('reemplazo válido -> 200, llama la RPC con los parámetros correctos', async () => {
        const res = await llamar({ nuevo_delegado_asociacion_id: 'del-nuevo', motivo: 'Juan no puede continuar' }, { id: 'admin-7', rol_evaluacion: null });
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.designacion.delegado_asociacion_id).toBe(DELEGADO_OK.id);
        expect(supabase.rpc).toHaveBeenCalledWith('reemplazar_delegado_institucional_rodeo', {
            p_rodeo_id: RODEO.id,
            p_nuevo_delegado_asociacion_id: DELEGADO_OK.id,
            p_nuevo_delegado_nombre: DELEGADO_OK.nombre,
            p_administrador_id: 'admin-7',
            p_motivo: 'Juan no puede continuar'
        });
    });

    test('RPC error SIN_DESIGNACION_PREVIA -> 409 con code', async () => {
        supabase.rpc.mockImplementation(() => Promise.resolve({ data: null, error: { message: 'SIN_DESIGNACION_PREVIA' } }));
        const res = await llamar({ nuevo_delegado_asociacion_id: 'del-nuevo', motivo: 'reemplazo' });
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('SIN_DESIGNACION_PREVIA');
    });

    test('RPC error REEMPLAZO_REQUIERE_PROCEDIMIENTO_ESPECIAL -> 409 con code, nunca se presenta como éxito', async () => {
        supabase.rpc.mockImplementation(() => Promise.resolve({ data: null, error: { message: 'REEMPLAZO_REQUIERE_PROCEDIMIENTO_ESPECIAL' } }));
        const res = await llamar({ nuevo_delegado_asociacion_id: 'del-nuevo', motivo: 'reemplazo' });
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('REEMPLAZO_REQUIERE_PROCEDIMIENTO_ESPECIAL');
    });

    test('RPC error MOTIVO_REQUERIDO (defensa en profundidad del lado DB) -> 422 con code', async () => {
        supabase.rpc.mockImplementation(() => Promise.resolve({ data: null, error: { message: 'MOTIVO_REQUERIDO' } }));
        const res = await llamar({ nuevo_delegado_asociacion_id: 'del-nuevo', motivo: 'reemplazo' });
        expect(res.statusCode).toBe(422);
        expect(res.jsonBody.code).toBe('MOTIVO_REQUERIDO');
    });

    test('RPC error desconocido -> 500', async () => {
        supabase.rpc.mockImplementation(() => Promise.resolve({ data: null, error: { message: 'ERROR_RARO' } }));
        const res = await llamar({ nuevo_delegado_asociacion_id: 'del-nuevo', motivo: 'reemplazo' });
        expect(res.statusCode).toBe(500);
    });

    test('rol Monitor -> 403, bloqueado por soloNoMonitor antes de tocar la RPC', async () => {
        const res = await llamar({ nuevo_delegado_asociacion_id: 'del-nuevo', motivo: 'reemplazo' }, { id: 'u1', rol_evaluacion: 'monitor' });
        expect(res.statusCode).toBe(403);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });
});
