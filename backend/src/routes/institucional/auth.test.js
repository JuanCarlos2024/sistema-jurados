// Login + cambio de contraseña de cuentas institucionales (Fase 1, Delegado
// de Asociación). Mismo patrón de mock que el resto del repo (ver
// reporte-deportivo.export.test.js): cadena de Supabase mockeada, Express
// router llamado directamente sin levantar el servidor HTTP.
//
// Fase 1 es solo preparación: ninguna cuenta real existe en producción. Estos
// tests prueban el CÓDIGO con datos simulados, nunca contra producción.
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../services/auditoria', () => ({ registrar: jest.fn().mockResolvedValue(undefined) }));

const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');
const router = require('./auth');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_in_prod';

let respuestas;
let actualizaciones;
function crearChain(tabla) {
    const chain = {};
    ['select', 'eq', 'neq', 'single'].forEach(m => { chain[m] = () => chain; });
    chain.update = (payload) => {
        actualizaciones.push({ tabla, payload });
        return { eq: () => Promise.resolve({ data: null, error: null }) };
    };
    chain.then = (resolve, reject) => Promise.resolve(respuestas[tabla] || { data: null, error: null }).then(resolve, reject);
    return chain;
}

const ASOCIACION_OSORNO = { id: 'asoc-osorno', nombre: 'OSORNO', activa: true };
const ASOCIACION_INACTIVA = { id: 'asoc-x', nombre: 'ASOC X', activa: false };

let hashValido;
beforeAll(async () => {
    hashValido = await bcrypt.hash('ClaveSegura123', 12);
});

beforeEach(() => {
    actualizaciones = [];
    respuestas = {
        cuentas_institucionales: {
            data: {
                id: 'cta-1', email: 'delegado-osorno@ferochi.com', password_hash: hashValido,
                rol_institucional: 'delegado_asociacion', activo: true, primer_login: false,
                asociaciones: ASOCIACION_OSORNO
            },
            error: null
        }
    };
    supabase.from.mockReset();
    supabase.from.mockImplementation(tabla => crearChain(tabla));
    auditoria.registrar.mockClear();
});

function crearResFake() {
    const res = {};
    res.statusCode = 200;
    res.status = jest.fn((c) => { res.statusCode = c; return res; });
    res.jsonBody = null;
    res.json = jest.fn((p) => { res.jsonBody = p; return res; });
    return res;
}

function llamar(ruta, body = {}, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = { method: 'POST', url: ruta, originalUrl: ruta, body, params: {}, headers, query: {}, ip: '127.0.0.1' };
        const res = crearResFake();
        const jsonOriginal = res.json;
        res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}

function tokenInstitucional(overrides = {}) {
    return jwt.sign({ id: 'cta-1', tipo: 'cuenta_institucional', rol_institucional: 'delegado_asociacion', asociacion_id: 'asoc-osorno', ...overrides }, JWT_SECRET, { expiresIn: '8h' });
}

describe('POST /institucional/auth/login', () => {
    test('login válido: devuelve token + datos de la cuenta, incluyendo asociación resuelta server-side', async () => {
        const res = await llamar('/login', { email: 'delegado-osorno@ferochi.com', password: 'ClaveSegura123' });
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.token).toBeDefined();
        expect(res.jsonBody.usuario).toMatchObject({ tipo: 'cuenta_institucional', asociacion_id: 'asoc-osorno', asociacion_nombre: 'OSORNO' });

        const payload = jwt.verify(res.jsonBody.token, JWT_SECRET);
        expect(payload).toMatchObject({ tipo: 'cuenta_institucional', asociacion_id: 'asoc-osorno' });
    });

    test('la asociación del token SIEMPRE viene de la fila real (join server-side), nunca de algo que mande el request', async () => {
        // Aunque el body intente mandar una asociación distinta, se ignora: no existe
        // ningún campo en el endpoint que acepte "asociacion" desde el cliente.
        const res = await llamar('/login', { email: 'delegado-osorno@ferochi.com', password: 'ClaveSegura123', asociacion_id: 'asoc-VALDIVIA-FALSA' });
        expect(res.jsonBody.usuario.asociacion_id).toBe('asoc-osorno');
    });

    test('contraseña incorrecta -> 401 "Credenciales inválidas"', async () => {
        const res = await llamar('/login', { email: 'delegado-osorno@ferochi.com', password: 'claveMala' });
        expect(res.statusCode).toBe(401);
        expect(res.jsonBody.error).toBe('Credenciales inválidas');
    });

    test('cuenta inactiva: el query ya filtra activo=true, por lo que no aparece -> mismo 401 genérico que credenciales inválidas (anti-enumeración)', async () => {
        respuestas.cuentas_institucionales = { data: null, error: { message: 'no rows' } };
        const res = await llamar('/login', { email: 'inactivo@ferochi.com', password: 'ClaveSegura123' });
        expect(res.statusCode).toBe(401);
        expect(res.jsonBody.error).toBe('Credenciales inválidas');
    });

    test('email inexistente -> MISMO mensaje genérico que contraseña incorrecta (anti-enumeración, requisito 9)', async () => {
        respuestas.cuentas_institucionales = { data: null, error: { message: 'no rows' } };
        const resInexistente = await llamar('/login', { email: 'no-existe@ferochi.com', password: 'cualquiera' });
        const resPasswordMala = await llamar('/login', { email: 'delegado-osorno@ferochi.com', password: 'claveMala' });
        expect(resInexistente.jsonBody.error).toBe(resPasswordMala.jsonBody.error);
    });

    test('asociación vinculada deshabilitada (activa=false) -> 401 "Credenciales inválidas" (mismo mensaje genérico, no revela el motivo)', async () => {
        respuestas.cuentas_institucionales.data.asociaciones = ASOCIACION_INACTIVA;
        const res = await llamar('/login', { email: 'delegado-osorno@ferochi.com', password: 'ClaveSegura123' });
        expect(res.statusCode).toBe(401);
        expect(res.jsonBody.error).toBe('Credenciales inválidas');
    });

    test('registra auditoría de login con actor_tipo="cuenta_institucional"', async () => {
        await llamar('/login', { email: 'delegado-osorno@ferochi.com', password: 'ClaveSegura123' });
        expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({
            tabla: 'cuentas_institucionales', accion: 'login', actor_tipo: 'cuenta_institucional'
        }));
    });

    test('actualiza ultimo_acceso_en al autenticar correctamente', async () => {
        await llamar('/login', { email: 'delegado-osorno@ferochi.com', password: 'ClaveSegura123' });
        const upd = actualizaciones.find(a => a.tabla === 'cuentas_institucionales' && 'ultimo_acceso_en' in a.payload);
        expect(upd).toBeDefined();
    });

    test('primer_login=true se refleja en el token y en la respuesta (para forzar cambio de password en frontend)', async () => {
        respuestas.cuentas_institucionales.data.primer_login = true;
        const res = await llamar('/login', { email: 'delegado-osorno@ferochi.com', password: 'ClaveSegura123' });
        expect(res.jsonBody.usuario.primer_login).toBe(true);
        const payload = jwt.verify(res.jsonBody.token, JWT_SECRET);
        expect(payload.primer_login).toBe(true);
    });

    test('faltan email o password -> 400', async () => {
        const res = await llamar('/login', { email: 'delegado-osorno@ferochi.com' });
        expect(res.statusCode).toBe(400);
    });
});

describe('POST /institucional/auth/cambiar-password', () => {
    test('token no institucional (ej. administrador) -> 403, nunca permite cambiar password de una cuenta institucional', async () => {
        const tokenAdmin = jwt.sign({ id: 'admin-1', tipo: 'administrador' }, JWT_SECRET, { expiresIn: '8h' });
        const res = await llamar('/cambiar-password', { password_nueva: 'NuevaClave123' }, { authorization: `Bearer ${tokenAdmin}` });
        expect(res.statusCode).toBe(403);
    });

    test('sin token -> 401', async () => {
        const res = await llamar('/cambiar-password', { password_nueva: 'NuevaClave123' }, {});
        expect(res.statusCode).toBe(401);
    });

    test('primer_login=true: NO exige password_actual, y la deja en false tras el cambio', async () => {
        respuestas.cuentas_institucionales.data.primer_login = true;
        const res = await llamar('/cambiar-password', { password_nueva: 'NuevaClave123' }, { authorization: `Bearer ${tokenInstitucional({ primer_login: true })}` });
        expect(res.statusCode).toBe(200);
        const upd = actualizaciones.find(a => a.tabla === 'cuentas_institucionales' && 'primer_login' in a.payload);
        expect(upd.payload.primer_login).toBe(false);
    });

    test('primer_login=false: SIN password_actual -> 400', async () => {
        respuestas.cuentas_institucionales.data.primer_login = false;
        const res = await llamar('/cambiar-password', { password_nueva: 'NuevaClave123' }, { authorization: `Bearer ${tokenInstitucional()}` });
        expect(res.statusCode).toBe(400);
    });

    test('primer_login=false: password_actual incorrecta -> 401', async () => {
        respuestas.cuentas_institucionales.data.primer_login = false;
        const res = await llamar('/cambiar-password', { password_actual: 'incorrecta', password_nueva: 'NuevaClave123' }, { authorization: `Bearer ${tokenInstitucional()}` });
        expect(res.statusCode).toBe(401);
    });

    test('primer_login=false: password_actual correcta -> 200 y actualiza password_hash', async () => {
        respuestas.cuentas_institucionales.data.primer_login = false;
        const res = await llamar('/cambiar-password', { password_actual: 'ClaveSegura123', password_nueva: 'NuevaClave123' }, { authorization: `Bearer ${tokenInstitucional()}` });
        expect(res.statusCode).toBe(200);
        const upd = actualizaciones.find(a => a.tabla === 'cuentas_institucionales' && 'password_hash' in a.payload);
        expect(upd).toBeDefined();
    });

    test('password_nueva muy corta -> 400', async () => {
        const res = await llamar('/cambiar-password', { password_actual: 'ClaveSegura123', password_nueva: '123' }, { authorization: `Bearer ${tokenInstitucional()}` });
        expect(res.statusCode).toBe(400);
    });
});
