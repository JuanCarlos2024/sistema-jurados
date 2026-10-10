// Cobertura del middleware soloCuentaInstitucional (Fase 1) + verificación
// cruzada de que NO mezcla con soloAdmin/soloUsuario en ningún sentido +
// (Fase 2) revalidación real contra la BD en cada request — Caso F de
// seguridad: una cuenta desactivada DESPUÉS de emitido el token debe perder
// acceso de inmediato. No reimplementa nada: importa y ejecuta las funciones
// reales de auth.js, usando generarToken() real (mismo flujo que un login
// real produciría).
jest.mock('../config/supabase', () => ({ from: jest.fn() }));

const { generarToken, soloAdmin, soloUsuario, soloCuentaInstitucional } = require('./auth');
const supabase = require('../config/supabase');

function fakeRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
}

function reqConToken(token) {
    return { headers: { authorization: `Bearer ${token}` }, method: 'GET', path: '/test' };
}

const tokenAdmin = () => generarToken({ id: 'admin-1', tipo: 'administrador' });
const tokenUsuario = () => generarToken({ id: 'usr-1', tipo: 'usuario_pagado', tipo_persona: 'delegado_rentado' });
const tokenInstitucional = () => generarToken({ id: 'inst-1', tipo: 'cuenta_institucional', rol_institucional: 'delegado_asociacion', asociacion_id: 'asoc-osorno' });

// Mock de la cadena de Supabase usada por soloCuentaInstitucional: select().eq().single().
function mockCuentaInstitucional(resultado) {
    const chain = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.single = () => Promise.resolve(resultado);
    supabase.from.mockImplementation(() => chain);
}

beforeEach(() => {
    supabase.from.mockReset();
});

describe('soloCuentaInstitucional — acepta solo tipo="cuenta_institucional" Y cuenta/asociación activas en BD', () => {
    test('token institucional válido + cuenta activa + asociación activa → permitido, llama next()', async () => {
        mockCuentaInstitucional({ data: { activo: true, asociaciones: { activa: true } }, error: null });
        const res = fakeRes();
        const next = jest.fn();
        await soloCuentaInstitucional(reqConToken(tokenInstitucional()), res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
    });

    test('token de administrador → 403, nunca permite acceso institucional (sin llegar siquiera a consultar la BD)', async () => {
        const res = fakeRes();
        const next = jest.fn();
        await soloCuentaInstitucional(reqConToken(tokenAdmin()), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
        expect(supabase.from).not.toHaveBeenCalled();
    });

    test('token de usuario_pagado (jurado/delegado rentado) → 403', async () => {
        const res = fakeRes();
        const next = jest.fn();
        await soloCuentaInstitucional(reqConToken(tokenUsuario()), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
    });

    test('sin token → 401 (vía verificarToken)', async () => {
        const res = fakeRes();
        const next = jest.fn();
        await soloCuentaInstitucional({ headers: {}, method: 'GET', path: '/test' }, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
    });

    test('CASO F (Fase 2): cuenta desactivada DESPUÉS de emitido el token → 401, nunca llama next() aunque el JWT siga siendo válido', async () => {
        mockCuentaInstitucional({ data: { activo: false, asociaciones: { activa: true } }, error: null });
        const res = fakeRes();
        const next = jest.fn();
        await soloCuentaInstitucional(reqConToken(tokenInstitucional()), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
    });

    test('CASO F: la asociación vinculada se deshabilita DESPUÉS de emitido el token → 401', async () => {
        mockCuentaInstitucional({ data: { activo: true, asociaciones: { activa: false } }, error: null });
        const res = fakeRes();
        const next = jest.fn();
        await soloCuentaInstitucional(reqConToken(tokenInstitucional()), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
    });

    test('la cuenta fue eliminada (consulta no encuentra fila) → 401', async () => {
        mockCuentaInstitucional({ data: null, error: { message: 'no rows' } });
        const res = fakeRes();
        const next = jest.fn();
        await soloCuentaInstitucional(reqConToken(tokenInstitucional()), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
    });

    test('error de red/BD al revalidar → 401 (nunca "falla abierto" dejando pasar la petición)', async () => {
        supabase.from.mockImplementation(() => { throw new Error('conexión caída'); });
        const res = fakeRes();
        const next = jest.fn();
        await soloCuentaInstitucional(reqConToken(tokenInstitucional()), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
    });
});

describe('Requisito de seguridad: un token institucional NUNCA pasa soloAdmin ni soloUsuario', () => {
    test('token institucional → soloAdmin devuelve 403', () => {
        const res = fakeRes();
        const next = jest.fn();
        soloAdmin(reqConToken(tokenInstitucional()), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
    });

    test('token institucional → soloUsuario devuelve 403', () => {
        const res = fakeRes();
        const next = jest.fn();
        soloUsuario(reqConToken(tokenInstitucional()), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
    });
});

// Cobertura de regresión: soloAdmin/soloUsuario no tenían tests propios antes
// de la Fase 1 (confirmado en la auditoría) — se agregan aquí porque este
// archivo ya depende de ambos para las pruebas cruzadas de arriba. No hacen
// ninguna consulta a la BD (sin cambios respecto a su comportamiento previo).
describe('Regresión — soloAdmin y soloUsuario siguen aceptando sus propios tipos sin cambios, sin tocar la BD', () => {
    test('soloAdmin: token administrador → permitido', () => {
        const res = fakeRes();
        const next = jest.fn();
        soloAdmin(reqConToken(tokenAdmin()), res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
        expect(supabase.from).not.toHaveBeenCalled();
    });

    test('soloUsuario: token usuario_pagado (jurado o delegado rentado) → permitido', () => {
        const res = fakeRes();
        const next = jest.fn();
        soloUsuario(reqConToken(tokenUsuario()), res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
        expect(supabase.from).not.toHaveBeenCalled();
    });

    test('soloAdmin: token usuario_pagado → 403 (sin cambios respecto al comportamiento previo)', () => {
        const res = fakeRes();
        const next = jest.fn();
        soloAdmin(reqConToken(tokenUsuario()), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
    });
});
