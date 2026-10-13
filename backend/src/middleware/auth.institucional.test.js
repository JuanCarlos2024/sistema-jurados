// Cobertura del middleware soloCuentaInstitucional (Fase 1) + verificación
// cruzada de que NO mezcla con soloAdmin/soloUsuario en ningún sentido +
// (Fase 2) revalidación real contra la BD en cada request — Caso F de
// seguridad: una cuenta desactivada DESPUÉS de emitido el token debe perder
// acceso de inmediato. No reimplementa nada: importa y ejecuta las funciones
// reales de auth.js, usando generarToken() real (mismo flujo que un login
// real produciría).
jest.mock('../config/supabase', () => ({ from: jest.fn() }));

const { generarToken, soloAdmin, soloUsuario, soloCuentaInstitucional, exigirCambioPasswordSiPrimerLogin, soloRolInstitucional } = require('./auth');
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

// Gestión de acceso institucional (migración 078): invalidación real de
// sesiones al restablecer contraseña — password_version viaja en el JWT y
// se revalida contra la BD en cada request, igual criterio que `activo`.
describe('Gestión de acceso (078) — password_version invalida sesiones tras un restablecimiento', () => {
    test('JWT sin password_version (emitido antes de esta migración) + BD en el DEFAULT (1) → permitido, nunca se corta una sesión legítima ya activa', async () => {
        mockCuentaInstitucional({ data: { activo: true, primer_login: false, password_version: 1, asociaciones: { activa: true } }, error: null });
        const res = fakeRes();
        const next = jest.fn();
        await soloCuentaInstitucional(reqConToken(tokenInstitucional()), res, next); // tokenInstitucional() no incluye password_version
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
    });

    test('JWT con password_version=1 + BD en password_version=1 → permitido (coinciden)', async () => {
        mockCuentaInstitucional({ data: { activo: true, primer_login: false, password_version: 1, asociaciones: { activa: true } }, error: null });
        const token = generarToken({ id: 'inst-1', tipo: 'cuenta_institucional', rol_institucional: 'delegado_asociacion', asociacion_id: 'asoc-osorno', password_version: 1 });
        const res = fakeRes();
        const next = jest.fn();
        await soloCuentaInstitucional(reqConToken(token), res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
    });

    test('JWT con password_version=1 pero la BD ya está en 2 (se restableció la contraseña DESPUÉS de emitido el token) → 401, nunca permite el acceso con la sesión vieja', async () => {
        mockCuentaInstitucional({ data: { activo: true, primer_login: false, password_version: 2, asociaciones: { activa: true } }, error: null });
        const token = generarToken({ id: 'inst-1', tipo: 'cuenta_institucional', rol_institucional: 'delegado_asociacion', asociacion_id: 'asoc-osorno', password_version: 1 });
        const res = fakeRes();
        const next = jest.fn();
        await soloCuentaInstitucional(reqConToken(token), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
    });

    test('la cuenta sigue activa (no fue suspendida) pero la sesión vieja queda cortada igual solo por el cambio de contraseña — son chequeos independientes', async () => {
        mockCuentaInstitucional({ data: { activo: true, primer_login: false, password_version: 5, asociaciones: { activa: true } }, error: null });
        const token = generarToken({ id: 'inst-1', tipo: 'cuenta_institucional', password_version: 4 });
        const res = fakeRes();
        const next = jest.fn();
        await soloCuentaInstitucional(reqConToken(token), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
    });

    test('expone req.cuentaInstitucional.primer_login desde la BD real (nunca desde el JWT, que puede estar desactualizado)', async () => {
        mockCuentaInstitucional({ data: { activo: true, primer_login: true, password_version: 1, asociaciones: { activa: true } }, error: null });
        // El JWT dice primer_login=false (desactualizado) — la BD real dice true.
        const token = generarToken({ id: 'inst-1', tipo: 'cuenta_institucional', primer_login: false, password_version: 1 });
        const req = reqConToken(token);
        const res = fakeRes();
        const next = jest.fn();
        await soloCuentaInstitucional(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(req.cuentaInstitucional).toEqual({ primer_login: true });
    });

    // Escenario real completo pedido explícitamente (Riesgo 1, migración
    // 078 revisión posterior): el mismo JWT, a través de las 3 fases de un
    // ciclo suspender -> reactivar, usando exactamente el middleware real
    // (no solo el estado de datos crudo, que ya se prueba aparte en
    // services/cuentasInstitucionalesGestionAcceso.rpc.test.js).
    describe('Escenario real — JWT emitido antes de suspender: válido antes, rechazado durante, SIGUE rechazado después de reactivar', () => {
        test('las 4 fases del ciclo completo', async () => {
            // El JWT se "emite" (simulado) con la versión vigente en ese momento: 1.
            const jwtViejo = generarToken({ id: 'inst-1', tipo: 'cuenta_institucional', password_version: 1 });

            // Fase 1 — ANTES de suspender: válido.
            mockCuentaInstitucional({ data: { activo: true, primer_login: false, password_version: 1, asociaciones: { activa: true } }, error: null });
            let res = fakeRes(); let next = jest.fn();
            await soloCuentaInstitucional(reqConToken(jwtViejo), res, next);
            expect(next).toHaveBeenCalledTimes(1);

            // Fase 2 — DURANTE la suspensión (suspender_cuenta_institucional_
            // con_auditoria ya puso activo=false Y password_version=2): rechazado.
            mockCuentaInstitucional({ data: { activo: false, primer_login: false, password_version: 2, asociaciones: { activa: true } }, error: null });
            res = fakeRes(); next = jest.fn();
            await soloCuentaInstitucional(reqConToken(jwtViejo), res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);

            // Fase 3 — DESPUÉS de reactivar (activo vuelve a true, pero
            // password_version SIGUE en 2 — el incremento de la suspensión es
            // permanente): el JWT viejo SIGUE rechazado, aunque `activo` ya no
            // sería motivo de rechazo por sí solo.
            mockCuentaInstitucional({ data: { activo: true, primer_login: false, password_version: 2, asociaciones: { activa: true } }, error: null });
            res = fakeRes(); next = jest.fn();
            await soloCuentaInstitucional(reqConToken(jwtViejo), res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);

            // Fase 4 — un NUEVO login (JWT con la versión real vigente, 2):
            // permitido, con la contraseña vigente (nunca se cambió el hash).
            const jwtNuevo = generarToken({ id: 'inst-1', tipo: 'cuenta_institucional', password_version: 2 });
            res = fakeRes(); next = jest.fn();
            await soloCuentaInstitucional(reqConToken(jwtNuevo), res, next);
            expect(next).toHaveBeenCalledTimes(1);
            expect(res.status).not.toHaveBeenCalled();
        });
    });
});

describe('exigirCambioPasswordSiPrimerLogin — bloquea rutas de negocio mientras el cambio de contraseña está pendiente', () => {
    test('req.cuentaInstitucional.primer_login=true → 403 CAMBIO_PASSWORD_REQUERIDO, nunca llama next()', () => {
        const req = { cuentaInstitucional: { primer_login: true } };
        const res = fakeRes();
        const next = jest.fn();
        exigirCambioPasswordSiPrimerLogin(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CAMBIO_PASSWORD_REQUERIDO' }));
    });

    test('req.cuentaInstitucional.primer_login=false → permitido, llama next()', () => {
        const req = { cuentaInstitucional: { primer_login: false } };
        const res = fakeRes();
        const next = jest.fn();
        exigirCambioPasswordSiPrimerLogin(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
    });

    test('sin req.cuentaInstitucional (nunca debería pasar en producción, soloCuentaInstitucional siempre lo fija antes) → fail-safe: permitido, nunca lanza', () => {
        const req = {};
        const res = fakeRes();
        const next = jest.fn();
        expect(() => exigirCambioPasswordSiPrimerLogin(req, res, next)).not.toThrow();
        expect(next).toHaveBeenCalledTimes(1);
    });
});

describe('soloRolInstitucional (Comisión de Asociación, 079) — aislamiento Delegado vs. Comisión', () => {
    test('rol_institucional="delegado_asociacion" pasa soloRolInstitucional("delegado_asociacion")', () => {
        const req = { usuario: { rol_institucional: 'delegado_asociacion' } };
        const res = fakeRes();
        const next = jest.fn();
        soloRolInstitucional('delegado_asociacion')(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
    });

    test('rol_institucional="comision_asociacion" es rechazado por soloRolInstitucional("delegado_asociacion")', () => {
        const req = { usuario: { rol_institucional: 'comision_asociacion' } };
        const res = fakeRes();
        const next = jest.fn();
        soloRolInstitucional('delegado_asociacion')(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
    });

    test('rol_institucional="delegado_asociacion" es rechazado por soloRolInstitucional("comision_asociacion")', () => {
        const req = { usuario: { rol_institucional: 'delegado_asociacion' } };
        const res = fakeRes();
        const next = jest.fn();
        soloRolInstitucional('comision_asociacion')(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
    });

    test('sin rol_institucional (nunca debería pasar, pero fail-closed) -> 403', () => {
        const req = { usuario: {} };
        const res = fakeRes();
        const next = jest.fn();
        soloRolInstitucional('delegado_asociacion')(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
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
