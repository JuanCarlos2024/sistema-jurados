// GET /institucional/perfil (Fase 2) — nunca expone campos financieros ni de
// otras cuentas.
const jwt = require('jsonwebtoken');

jest.mock('../../config/supabase', () => ({ from: jest.fn() }));

const supabase = require('../../config/supabase');
const router = require('./perfil');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_in_prod';

let respuestas;
function crearChain(tabla) {
    const chain = {};
    ['select', 'eq'].forEach(m => { chain[m] = () => chain; });
    chain.single = () => Promise.resolve(respuestas[tabla] || { data: null, error: null });
    return chain;
}

beforeEach(() => {
    respuestas = {
        cuentas_institucionales: {
            data: { email: 'delegado-osorno@ferochi.com', activo: true, rol_institucional: 'delegado_asociacion', asociaciones: { id: 'asoc-osorno', nombre: 'OSORNO' } },
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

function tokenInstitucional() {
    return jwt.sign({ id: 'inst-1', tipo: 'cuenta_institucional', rol_institucional: 'delegado_asociacion', asociacion_id: 'asoc-osorno' }, JWT_SECRET, { expiresIn: '8h' });
}

function llamar(headers = {}) {
    return new Promise((resolve, reject) => {
        const req = { method: 'GET', url: '/', originalUrl: '/', body: {}, params: {}, headers, query: {}, ip: '127.0.0.1' };
        const res = crearResFake();
        const jsonOriginal = res.json;
        res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}

test('devuelve datos institucionales básicos: asociación, email, rol, estado — nada financiero', async () => {
    const res = await llamar({ authorization: `Bearer ${tokenInstitucional()}` });
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({
        email: 'delegado-osorno@ferochi.com',
        activo: true,
        rol_institucional: 'delegado_asociacion',
        asociacion_id: 'asoc-osorno',
        asociacion_nombre: 'OSORNO'
    });
    // Ninguna clave financiera presente (defensa en profundidad del propio test):
    for (const k of ['pago_base', 'bonos', 'total_bruto', 'password_hash']) {
        expect(res.jsonBody[k]).toBeUndefined();
    }
});

test('sin token -> 401', async () => {
    const res = await llamar({});
    expect(res.statusCode).toBe(401);
});
