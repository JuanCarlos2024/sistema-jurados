// Gestión de acceso institucional (migración 078) — permisos (solo admin
// pleno), alta para asociación existente (Opción A), alta de asociación
// nueva (Opción B), suspender/reactivar, restablecer contraseña (generada y
// manual). Verifica que la RUTA llama a la RPC correcta y traduce sus
// errores/éxitos bien; la prueba de que las RPC son atómicas (contra
// Postgres real, no un mock) vive en
// services/cuentasInstitucionalesGestionAcceso.rpc.test.js.
jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
jest.mock('bcryptjs', () => ({
    hash: jest.fn(async (password) => `hash(${password})`)
}));

const supabase = require('../../config/supabase');
const router = require('./cuentas-institucionales');

let respuestas;
function crearChain(tabla) {
    const chain = {};
    ['select', 'eq'].forEach(m => { chain[m] = () => chain; });
    chain.then = (resolve, reject) => Promise.resolve(respuestas[tabla]?.list ?? { data: [], error: null }).then(resolve, reject);
    return chain;
}

beforeEach(() => {
    respuestas = {
        asociaciones: { list: { data: [], error: null } },
        asociacion_alias: { list: { data: [], error: null } }
    };
    supabase.from.mockReset();
    supabase.from.mockImplementation(tabla => crearChain(tabla));
    supabase.rpc.mockReset();
});

function crearResFake() {
    const res = {};
    res.statusCode = 200;
    res.status = jest.fn((c) => { res.statusCode = c; return res; });
    res.jsonBody = null;
    res.json = jest.fn((p) => { res.jsonBody = p; return res; });
    return res;
}
function llamar({ metodo = 'GET', url = '/', body = {}, usuario = { id: 'admin-1', rol_evaluacion: null }, params = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = { method: metodo, url, originalUrl: url, body: body || {}, params, query: {}, usuario, ip: '127.0.0.1' };
        const res = crearResFake();
        const jsonOriginal = res.json;
        res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}

const CUENTA_RPC_OK = {
    id: 'cta-1', email: 'nueva@ferochi.com', asociacion_id: 'asoc-1',
    rol_institucional: 'delegado_asociacion', activo: true, primer_login: true, password_version: 1
};

describe('Permisos — solo administrador pleno en TODO el router', () => {
    test.each(['director', 'analista', 'comision_tecnica', 'monitor', 'jefe_area', 'capacitador'])(
        'rol_evaluacion=%s -> 403 para crear cuenta (asociación existente)',
        async (rol) => {
            const res = await llamar({ metodo: 'POST', url: '/para-asociacion-existente', body: { asociacion_id: 'asoc-1', email: 'x@y.com', password_mode: 'generar' }, usuario: { id: 'x', rol_evaluacion: rol } });
            expect(res.statusCode).toBe(403);
            expect(supabase.rpc).not.toHaveBeenCalled();
        }
    );

    test('admin pleno (rol_evaluacion=null) -> permitido (llega a la RPC)', async () => {
        supabase.rpc.mockResolvedValue({ data: CUENTA_RPC_OK, error: null });
        const res = await llamar({ metodo: 'POST', url: '/para-asociacion-existente', body: { asociacion_id: 'asoc-1', email: 'x@y.com', password_mode: 'generar' } });
        expect(res.statusCode).toBe(201);
    });
});

describe('POST /para-asociacion-existente — Opción A', () => {
    test('email inválido -> 400, nunca llama la RPC', async () => {
        const res = await llamar({ metodo: 'POST', url: '/para-asociacion-existente', body: { asociacion_id: 'asoc-1', email: 'no-es-un-email', password_mode: 'generar' } });
        expect(res.statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('sin asociacion_id -> 400', async () => {
        const res = await llamar({ metodo: 'POST', url: '/para-asociacion-existente', body: { email: 'x@y.com', password_mode: 'generar' } });
        expect(res.statusCode).toBe(400);
    });

    test('éxito con password_mode=generar -> 201, incluye password_temporal UNA vez, llama la RPC con el hash (nunca el texto plano)', async () => {
        supabase.rpc.mockResolvedValue({ data: CUENTA_RPC_OK, error: null });
        const res = await llamar({ metodo: 'POST', url: '/para-asociacion-existente', body: { asociacion_id: 'asoc-1', email: 'Nueva@Ferochi.com', password_mode: 'generar' } });
        expect(res.statusCode).toBe(201);
        expect(res.jsonBody.password_temporal).toBeDefined();
        expect(typeof res.jsonBody.password_temporal).toBe('string');
        expect(res.jsonBody.cuenta.email).toBe(CUENTA_RPC_OK.email);
        expect(res.jsonBody.cuenta.password_hash).toBeUndefined();
        const llamadaRpc = supabase.rpc.mock.calls[0];
        expect(llamadaRpc[0]).toBe('crear_cuenta_institucional_con_auditoria');
        expect(llamadaRpc[1].p_email).toBe('nueva@ferochi.com'); // normalizado a minúsculas, igual que el login
        expect(llamadaRpc[1].p_password_hash).toBe(`hash(${res.jsonBody.password_temporal})`);
        expect(JSON.stringify(res.jsonBody)).not.toContain(llamadaRpc[1].p_password_hash);
    });

    test('ASOCIACION_NO_ENCONTRADA -> 404', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'ASOCIACION_NO_ENCONTRADA' } });
        const res = await llamar({ metodo: 'POST', url: '/para-asociacion-existente', body: { asociacion_id: 'asoc-x', email: 'x@y.com', password_mode: 'generar' } });
        expect(res.statusCode).toBe(404);
    });

    test('ASOCIACION_INACTIVA -> 409 ASOCIACION_INACTIVA (revisión posterior)', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'ASOCIACION_INACTIVA' } });
        const res = await llamar({ metodo: 'POST', url: '/para-asociacion-existente', body: { asociacion_id: 'asoc-x', email: 'x@y.com', password_mode: 'generar' } });
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('ASOCIACION_INACTIVA');
    });

    test('ASOCIACION_ESPECIAL_SIN_CUENTA (caso real: Federación del Rodeo Chileno) -> 409 ASOCIACION_ESPECIAL (revisión posterior)', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'ASOCIACION_ESPECIAL_SIN_CUENTA' } });
        const res = await llamar({ metodo: 'POST', url: '/para-asociacion-existente', body: { asociacion_id: 'asoc-fed', email: 'x@y.com', password_mode: 'generar' } });
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('ASOCIACION_ESPECIAL');
    });

    test('CUENTA_YA_EXISTE_PARA_ASOCIACION -> 409 CUENTA_YA_EXISTE', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'CUENTA_YA_EXISTE_PARA_ASOCIACION' } });
        const res = await llamar({ metodo: 'POST', url: '/para-asociacion-existente', body: { asociacion_id: 'asoc-1', email: 'x@y.com', password_mode: 'generar' } });
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('CUENTA_YA_EXISTE');
    });

    test('CORREO_YA_REGISTRADO -> 409 CORREO_DUPLICADO', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'CORREO_YA_REGISTRADO' } });
        const res = await llamar({ metodo: 'POST', url: '/para-asociacion-existente', body: { asociacion_id: 'asoc-1', email: 'x@y.com', password_mode: 'generar' } });
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('CORREO_DUPLICADO');
    });

    test('password_mode=manual con contraseña débil -> 400 PASSWORD_DEBIL, nunca llama la RPC', async () => {
        const res = await llamar({ metodo: 'POST', url: '/para-asociacion-existente', body: { asociacion_id: 'asoc-1', email: 'x@y.com', password_mode: 'manual', password: 'corta123' } });
        expect(res.statusCode).toBe(400);
        expect(res.jsonBody.code).toBe('PASSWORD_DEBIL');
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('password_mode=manual con contraseña fuerte -> 201, usa esa contraseña exacta (hasheada)', async () => {
        supabase.rpc.mockResolvedValue({ data: CUENTA_RPC_OK, error: null });
        const res = await llamar({ metodo: 'POST', url: '/para-asociacion-existente', body: { asociacion_id: 'asoc-1', email: 'x@y.com', password_mode: 'manual', password: 'ClaveFuerte123!' } });
        expect(res.statusCode).toBe(201);
        expect(res.jsonBody.password_temporal).toBe('ClaveFuerte123!');
        expect(supabase.rpc.mock.calls[0][1].p_password_hash).toBe('hash(ClaveFuerte123!)');
    });

    test('password_mode inválido/ausente -> 400', async () => {
        const res = await llamar({ metodo: 'POST', url: '/para-asociacion-existente', body: { asociacion_id: 'asoc-1', email: 'x@y.com' } });
        expect(res.statusCode).toBe(400);
    });
});

describe('Validación de fortaleza de contraseña manual (requisito explícito: mínimo 12, rechazo de débiles)', () => {
    test.each([
        ['', 'vacía'],
        ['Corta1!', 'menor a 12 caracteres'],
        ['abcdefghijkl', 'solo minúsculas (1 sola clase)'],
        ['abcdefghijklmnop1', 'solo 2 clases (minúscula + dígito)']
    ])('contraseña débil (%s: %s) -> 400 PASSWORD_DEBIL', async (password) => {
        const res = await llamar({ metodo: 'POST', url: '/para-asociacion-existente', body: { asociacion_id: 'asoc-1', email: 'x@y.com', password_mode: 'manual', password } });
        expect(res.statusCode).toBe(400);
        expect(res.jsonBody.code).toBe('PASSWORD_DEBIL');
    });

    test('contraseña con exactamente 12 caracteres y 3 clases -> aceptada', async () => {
        supabase.rpc.mockResolvedValue({ data: CUENTA_RPC_OK, error: null });
        const res = await llamar({ metodo: 'POST', url: '/para-asociacion-existente', body: { asociacion_id: 'asoc-1', email: 'x@y.com', password_mode: 'manual', password: 'Abcdefghij1!' } });
        expect(res.statusCode).toBe(201);
    });
});

describe('Generación de contraseña temporal — criptográficamente segura, nunca Math.random', () => {
    test('genera 16 caracteres, con al menos una minúscula, una mayúscula, un dígito y un símbolo', async () => {
        supabase.rpc.mockResolvedValue({ data: CUENTA_RPC_OK, error: null });
        const res = await llamar({ metodo: 'POST', url: '/para-asociacion-existente', body: { asociacion_id: 'asoc-1', email: 'x@y.com', password_mode: 'generar' } });
        const p = res.jsonBody.password_temporal;
        expect(p).toHaveLength(16);
        expect(p).toMatch(/[a-z]/);
        expect(p).toMatch(/[A-Z]/);
        expect(p).toMatch(/[0-9]/);
        expect(p).toMatch(/[^a-zA-Z0-9]/);
    });

    test('dos generaciones sucesivas producen contraseñas distintas (no es un valor fijo tipo "jurados")', async () => {
        supabase.rpc.mockResolvedValue({ data: CUENTA_RPC_OK, error: null });
        const res1 = await llamar({ metodo: 'POST', url: '/para-asociacion-existente', body: { asociacion_id: 'asoc-1', email: 'x@y.com', password_mode: 'generar' } });
        const res2 = await llamar({ metodo: 'POST', url: '/para-asociacion-existente', body: { asociacion_id: 'asoc-2', email: 'y@y.com', password_mode: 'generar' } });
        expect(res1.jsonBody.password_temporal).not.toBe(res2.jsonBody.password_temporal);
    });
});

describe('POST /nueva-asociacion — Opción B', () => {
    test('nombre vacío -> 400', async () => {
        const res = await llamar({ metodo: 'POST', url: '/nueva-asociacion', body: { email: 'x@y.com', password_mode: 'generar' } });
        expect(res.statusCode).toBe(400);
    });

    test('éxito -> 201, llama la RPC con nombre_normalizado calculado, nunca crea delegados/rodeos (esta ruta no los toca)', async () => {
        supabase.rpc.mockResolvedValue({ data: CUENTA_RPC_OK, error: null });
        const res = await llamar({ metodo: 'POST', url: '/nueva-asociacion', body: { nombre: 'Nueva Asociación de Prueba', zona: 'Sur', email: 'x@y.com', password_mode: 'generar' } });
        expect(res.statusCode).toBe(201);
        const llamadaRpc = supabase.rpc.mock.calls[0];
        expect(llamadaRpc[0]).toBe('crear_asociacion_institucional_con_auditoria');
        expect(llamadaRpc[1].p_nombre).toBe('Nueva Asociación de Prueba');
        expect(llamadaRpc[1].p_nombre_normalizado).toBe('nueva asociacion de prueba');
        expect(llamadaRpc[1].p_zona).toBe('Sur');
    });

    test('nombre EXACTO ya existe en el catálogo -> 409 ASOCIACION_YA_EXISTE, nunca llega a llamar la RPC', async () => {
        respuestas.asociaciones.list = { data: [{ id: 'asoc-osorno', nombre: 'OSORNO', nombre_normalizado: 'osorno' }], error: null };
        const res = await llamar({ metodo: 'POST', url: '/nueva-asociacion', body: { nombre: 'Osorno', email: 'x@y.com', password_mode: 'generar' } });
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('ASOCIACION_YA_EXISTE');
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('nombre equivalente por ALIAS (no el nombre_normalizado directo) -> 409 ASOCIACION_YA_EXISTE, detectado ANTES de llamar la RPC', async () => {
        respuestas.asociaciones.list = { data: [{ id: 'asoc-osorno', nombre: 'OSORNO', nombre_normalizado: 'osorno' }], error: null };
        respuestas.asociacion_alias.list = { data: [{ asociacion_id: 'asoc-osorno', alias: 'Asociación de Osorno', alias_normalizado: 'de osorno' }], error: null };
        const res = await llamar({ metodo: 'POST', url: '/nueva-asociacion', body: { nombre: 'De Osorno', email: 'x@y.com', password_mode: 'generar' } });
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('ASOCIACION_YA_EXISTE');
        expect(res.jsonBody.error).toContain('OSORNO');
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('ASOCIACION_YA_EXISTE devuelto por la RPC (carrera concurrente, pasó el pre-chequeo) -> 409 igual', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'ASOCIACION_YA_EXISTE' } });
        const res = await llamar({ metodo: 'POST', url: '/nueva-asociacion', body: { nombre: 'Asociación Carrera', email: 'x@y.com', password_mode: 'generar' } });
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('ASOCIACION_YA_EXISTE');
    });

    test('CORREO_YA_REGISTRADO -> 409 CORREO_DUPLICADO', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'CORREO_YA_REGISTRADO' } });
        const res = await llamar({ metodo: 'POST', url: '/nueva-asociacion', body: { nombre: 'Asociación X', email: 'x@y.com', password_mode: 'generar' } });
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('CORREO_DUPLICADO');
    });

    test('nunca crea delegados_asociacion ni rodeos: esta ruta jamás llama a supabase.from con esas tablas', async () => {
        supabase.rpc.mockResolvedValue({ data: CUENTA_RPC_OK, error: null });
        await llamar({ metodo: 'POST', url: '/nueva-asociacion', body: { nombre: 'Asociación Y', email: 'x@y.com', password_mode: 'generar' } });
        const tablasConsultadas = supabase.from.mock.calls.map(c => c[0]);
        expect(tablasConsultadas).not.toContain('delegados_asociacion');
        expect(tablasConsultadas).not.toContain('rodeos');
    });
});

describe('PATCH /:cuentaId/suspender', () => {
    test('éxito -> 200, estado=suspendida', async () => {
        supabase.rpc.mockResolvedValue({ data: { ...CUENTA_RPC_OK, activo: false }, error: null });
        const res = await llamar({ metodo: 'PATCH', url: '/cta-1/suspender', params: { cuentaId: 'cta-1' } });
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.cuenta.estado).toBe('suspendida');
        expect(supabase.rpc).toHaveBeenCalledWith('suspender_cuenta_institucional_con_auditoria', expect.objectContaining({ p_cuenta_id: 'cta-1', p_administrador_id: 'admin-1' }));
    });

    test('CUENTA_NO_ENCONTRADA -> 404', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'CUENTA_NO_ENCONTRADA' } });
        const res = await llamar({ metodo: 'PATCH', url: '/cta-x/suspender', params: { cuentaId: 'cta-x' } });
        expect(res.statusCode).toBe(404);
    });

    test('CUENTA_YA_SUSPENDIDA -> 409', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'CUENTA_YA_SUSPENDIDA' } });
        const res = await llamar({ metodo: 'PATCH', url: '/cta-1/suspender', params: { cuentaId: 'cta-1' } });
        expect(res.statusCode).toBe(409);
    });
});

describe('PATCH /:cuentaId/reactivar', () => {
    test('éxito -> 200, estado=activa', async () => {
        supabase.rpc.mockResolvedValue({ data: { ...CUENTA_RPC_OK, activo: true }, error: null });
        const res = await llamar({ metodo: 'PATCH', url: '/cta-1/reactivar', params: { cuentaId: 'cta-1' } });
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.cuenta.estado).toBe('activa');
    });

    test('CUENTA_YA_ACTIVA -> 409', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'CUENTA_YA_ACTIVA' } });
        const res = await llamar({ metodo: 'PATCH', url: '/cta-1/reactivar', params: { cuentaId: 'cta-1' } });
        expect(res.statusCode).toBe(409);
    });
});

describe('POST /:cuentaId/resetear-password', () => {
    test('modo generar -> 200, incluye password_temporal UNA vez, nunca el hash', async () => {
        supabase.rpc.mockResolvedValue({ data: { ...CUENTA_RPC_OK, primer_login: true }, error: null });
        const res = await llamar({ metodo: 'POST', url: '/cta-1/resetear-password', params: { cuentaId: 'cta-1' }, body: { password_mode: 'generar' } });
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.password_temporal).toBeDefined();
        expect(res.jsonBody.cuenta.primer_login).toBe(true);
        expect(JSON.stringify(res.jsonBody)).not.toContain('hash(');
    });

    test('modo manual con contraseña débil -> 400, nunca llama la RPC', async () => {
        const res = await llamar({ metodo: 'POST', url: '/cta-1/resetear-password', params: { cuentaId: 'cta-1' }, body: { password_mode: 'manual', password: 'débil' } });
        expect(res.statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('CUENTA_NO_ENCONTRADA -> 404', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'CUENTA_NO_ENCONTRADA' } });
        const res = await llamar({ metodo: 'POST', url: '/cta-x/resetear-password', params: { cuentaId: 'cta-x' }, body: { password_mode: 'generar' } });
        expect(res.statusCode).toBe(404);
    });
});
