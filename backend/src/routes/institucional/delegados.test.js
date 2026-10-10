// GET /institucional/delegados + POST /institucional/delegados/seleccionar
// (Fase 2, solo lectura + validación stateless). Mismo patrón de mock que el
// resto del repo.
const jwt = require('jsonwebtoken');

jest.mock('../../config/supabase', () => ({ from: jest.fn() }));

const supabase = require('../../config/supabase');
const router = require('./delegados');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_in_prod';
const ASOCIACION_OSORNO = 'asoc-osorno';
const ASOCIACION_VALDIVIA = 'asoc-valdivia';

let respuestas;
function crearChain(tabla) {
    const chain = {};
    ['select', 'eq', 'order'].forEach(m => { chain[m] = () => chain; });
    chain.single = () => Promise.resolve(respuestas[tabla] || { data: null, error: null });
    chain.then = (resolve, reject) => Promise.resolve(respuestas[tabla] || { data: [], error: null }).then(resolve, reject);
    return chain;
}

beforeEach(() => {
    respuestas = {
        // Revalidación del middleware soloCuentaInstitucional (vía .single()):
        cuentas_institucionales: { data: { activo: true, asociaciones: { activa: true } }, error: null },
        delegados_asociacion: {
            data: [
                { id: 'del-1', nombre: 'Ana Soto' },
                { id: 'del-2', nombre: 'Bruno Pérez' }
            ],
            error: null
        }
    };
    supabase.from.mockReset();
    supabase.from.mockImplementation(tabla => crearChain(tabla));
});

function crearResFake() {
    const res = {};
    res.statusCode = 200;
    res.status = jest.fn((c) => { res.statusCode = c; return res; });
    res.jsonBody = null;
    res.json = jest.fn((p) => { res.jsonBody = p; return res; });
    return res;
}

function tokenInstitucional(asociacion_id = ASOCIACION_OSORNO) {
    return jwt.sign({ id: 'inst-1', tipo: 'cuenta_institucional', rol_institucional: 'delegado_asociacion', asociacion_id }, JWT_SECRET, { expiresIn: '8h' });
}
function tokenUsuario() {
    return jwt.sign({ id: 'usr-1', tipo: 'usuario_pagado', tipo_persona: 'delegado_rentado' }, JWT_SECRET, { expiresIn: '8h' });
}

function llamar(method, ruta, body = {}, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = { method, url: ruta, originalUrl: ruta, body, params: {}, headers, query: {}, ip: '127.0.0.1' };
        const res = crearResFake();
        const jsonOriginal = res.json;
        res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}

describe('GET /institucional/delegados', () => {
    test('sin token -> 401', async () => {
        const res = await llamar('GET', '/', {}, {});
        expect(res.statusCode).toBe(401);
    });

    test('token de usuario_pagado (jurado/delegado rentado) -> 403 (Caso E)', async () => {
        const res = await llamar('GET', '/', {}, { authorization: `Bearer ${tokenUsuario()}` });
        expect(res.statusCode).toBe(403);
    });

    test('token institucional válido -> devuelve solo los delegados de SU asociación (resuelta del token, no del request)', async () => {
        const res = await llamar('GET', '/', {}, { authorization: `Bearer ${tokenInstitucional()}` });
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.asociacion_id).toBe(ASOCIACION_OSORNO);
        expect(res.jsonBody.delegados).toEqual([{ id: 'del-1', nombre: 'Ana Soto' }, { id: 'del-2', nombre: 'Bruno Pérez' }]);
    });

    test('catálogo vacío (asociación sin delegados certificados) -> lista vacía, nunca error ni delegados inventados', async () => {
        respuestas.delegados_asociacion = { data: [], error: null };
        const res = await llamar('GET', '/', {}, { authorization: `Bearer ${tokenInstitucional()}` });
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.delegados).toEqual([]);
    });

    test('cuenta institucional desactivada (CASO F) -> 401, ni siquiera llega a listar delegados', async () => {
        respuestas.cuentas_institucionales = { data: { activo: false, asociaciones: { activa: true } }, error: null };
        const res = await llamar('GET', '/', {}, { authorization: `Bearer ${tokenInstitucional()}` });
        expect(res.statusCode).toBe(401);
    });
});

describe('POST /institucional/delegados/seleccionar', () => {
    test('delegado activo+certificado de LA MISMA asociación -> aceptado', async () => {
        respuestas.delegados_asociacion = { data: { id: 'del-1', nombre: 'Ana Soto', asociacion_id: ASOCIACION_OSORNO, activo: true, certificado: true }, error: null };
        const res = await llamar('POST', '/seleccionar', { delegado_id: 'del-1' }, { authorization: `Bearer ${tokenInstitucional()}` });
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.delegado).toEqual({ id: 'del-1', nombre: 'Ana Soto' });
    });

    test('Caso G: delegado de OTRA asociación -> rechazado con mensaje genérico', async () => {
        respuestas.delegados_asociacion = { data: { id: 'del-9', nombre: 'Otro', asociacion_id: ASOCIACION_VALDIVIA, activo: true, certificado: true }, error: null };
        const res = await llamar('POST', '/seleccionar', { delegado_id: 'del-9' }, { authorization: `Bearer ${tokenInstitucional(ASOCIACION_OSORNO)}` });
        expect(res.statusCode).toBe(403);
    });

    test('Caso G: delegado inactivo -> rechazado', async () => {
        respuestas.delegados_asociacion = { data: { id: 'del-1', nombre: 'Ana Soto', asociacion_id: ASOCIACION_OSORNO, activo: false, certificado: true }, error: null };
        const res = await llamar('POST', '/seleccionar', { delegado_id: 'del-1' }, { authorization: `Bearer ${tokenInstitucional()}` });
        expect(res.statusCode).toBe(403);
    });

    test('Caso G: delegado no certificado (activo pero sin certificar) -> rechazado', async () => {
        respuestas.delegados_asociacion = { data: { id: 'del-1', nombre: 'Ana Soto', asociacion_id: ASOCIACION_OSORNO, activo: true, certificado: false }, error: null };
        const res = await llamar('POST', '/seleccionar', { delegado_id: 'del-1' }, { authorization: `Bearer ${tokenInstitucional()}` });
        expect(res.statusCode).toBe(403);
    });

    test('Caso G: delegado inexistente -> rechazado, mismo mensaje que los demás casos (sin distinguir el motivo)', async () => {
        respuestas.delegados_asociacion = { data: null, error: { message: 'no rows' } };
        const res = await llamar('POST', '/seleccionar', { delegado_id: 'id-fantasma' }, { authorization: `Bearer ${tokenInstitucional()}` });
        expect(res.statusCode).toBe(403);
    });

    test('Caso H (identificador arbitrario): sin delegado_id en el body -> 400, nunca se intenta adivinar', async () => {
        const res = await llamar('POST', '/seleccionar', {}, { authorization: `Bearer ${tokenInstitucional()}` });
        expect(res.statusCode).toBe(400);
    });
});
