// Cambio de función (migración 100) — acceso al portal con servidor Express
// REAL (HTTP) y JWT reales; Supabase mockeado con un "estado de BD" mutable.
//
// Defecto que cubre: el JWT lleva tipo_persona (8 h) y varias rutas del
// portal autorizan con ese claim. Sin revalidación, quien cambia de función
// conservaría los permisos de la anterior hasta que expire su token.
//  8. Login con función actualizada -> token con la función vigente.
// 10. Acceso a la Cartilla Digital del Delegado según la función vigente.
//     Token antiguo -> 401 FUNCION_ACTUALIZADA (el frontend cierra sesión).
jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
jest.mock('../../services/auditoria', () => ({ registrar: jest.fn().mockResolvedValue(undefined) }));

const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../../config/supabase');
const { generarToken, revalidarTipoPersonaUsuario } = require('../../middleware/auth');

const UID = '02745610-52b9-4793-9cdc-3931ab254f29';
const RODEO = '11111111-2222-3333-4444-555555555555';
const BD = { usuario: null, asignacion: null, errorUsuarios: null };

function mockSupabase() {
    supabase.from.mockImplementation((tabla) => {
        const chain = {
            select: () => chain, eq: () => chain, neq: () => chain, ilike: () => chain, in: () => chain,
            order: () => chain, limit: () => chain,
            maybeSingle: () => Promise.resolve(resolver(true)),
            single: () => Promise.resolve(resolver(true)),
            then: (ok, ko) => Promise.resolve(resolver(false)).then(ok, ko)
        };
        function resolver(uno) {
            if (tabla === 'usuarios_pagados') {
                if (BD.errorUsuarios) return { data: null, error: BD.errorUsuarios };
                return { data: uno ? BD.usuario : (BD.usuario ? [BD.usuario] : []), error: null };
            }
            if (tabla === 'asignaciones') return { data: uno ? BD.asignacion : (BD.asignacion ? [BD.asignacion] : []), error: null };
            if (tabla === 'rodeos') return { data: uno ? { id: RODEO, club: 'CLUB' } : [], error: null };
            return { data: uno ? null : [], error: null };
        }
        return chain;
    });
}

let servidor; let base;
beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', require('../auth'));
    app.use('/api/usuario', require('./index'));
    servidor = http.createServer(app);
    await new Promise(r => servidor.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${servidor.address().port}`;
});
afterAll(() => new Promise(r => servidor.close(r)));

beforeEach(async () => {
    jest.clearAllMocks();
    BD.usuario = {
        id: UID, codigo_interno: 'USR-0300', nombre_completo: 'ROBERTO RIVAS GONZALEZ', tipo_persona: 'jurado', categoria: 'C',
        activo: true, primer_login: false, perfil_completo: true, password_hash: await bcrypt.hash('clave-correcta', 4)
    };
    BD.asignacion = null;
    BD.errorUsuarios = null;
    mockSupabase();
});

async function pedir(metodo, ruta, { token, body } = {}) {
    const r = await fetch(base + ruta, {
        method: metodo,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    return { status: r.status, body: await r.json().catch(() => null) };
}
const login = () => pedir('POST', '/api/auth/usuario/login', { body: { identificador: 'USR-0300', password: 'clave-correcta' } });

describe('8. Inicio de sesión con función actualizada', () => {
    test('el login emite el token con la función VIGENTE en la BD (antes y después del cambio)', async () => {
        const antes = await login();
        expect(antes.status).toBe(200);
        expect(jwt.decode(antes.body.token).tipo_persona).toBe('jurado');

        BD.usuario.tipo_persona = 'delegado_rentado'; BD.usuario.categoria = null;   // cambio aplicado por la RPC
        const despues = await login();
        expect(despues.status).toBe(200);
        expect(jwt.decode(despues.body.token).tipo_persona).toBe('delegado_rentado');
        expect(despues.body.usuario).toMatchObject({ id: UID, codigo_interno: 'USR-0300', tipo_persona: 'delegado_rentado' });
    });
});

describe('Tokens antiguos tras un cambio de función', () => {
    test('token de Jurado emitido ANTES del cambio a DR -> 401 FUNCION_ACTUALIZADA en todo el portal', async () => {
        const tokenViejo = (await login()).body.token;
        BD.usuario.tipo_persona = 'delegado_rentado';
        for (const ruta of ['/api/usuario/cartillas/x', `/api/usuario/cartilla-delegado/rodeo/${RODEO}`, '/api/usuario/resumen']) {
            const r = await pedir('GET', ruta, { token: tokenViejo });
            expect(r.status).toBe(401);
            expect(r.body.code).toBe('FUNCION_ACTUALIZADA');
        }
    });

    test('token de DR emitido ANTES del cambio a Jurado -> pierde acceso a la Cartilla del Delegado (401)', async () => {
        BD.usuario.tipo_persona = 'delegado_rentado';
        const tokenDR = (await login()).body.token;
        BD.usuario.tipo_persona = 'jurado'; BD.usuario.categoria = 'B';
        const r = await pedir('POST', `/api/usuario/cartilla-delegado/rodeo/${RODEO}`, { token: tokenDR });
        expect(r.status).toBe(401);
        expect(r.body.code).toBe('FUNCION_ACTUALIZADA');
    });

    test('persona eliminada de la BD -> 401', async () => {
        const token = (await login()).body.token;
        BD.usuario = null;
        expect((await pedir('GET', '/api/usuario/resumen', { token })).status).toBe(401);
    });

    test('error de BD al revalidar -> 503 (no se cierra la sesión por una falla transitoria)', async () => {
        const token = (await login()).body.token;
        BD.errorUsuarios = { message: 'timeout' };
        expect((await pedir('GET', '/api/usuario/resumen', { token })).status).toBe(503);
    });
});

describe('10. Cartilla Digital del Delegado según la función vigente', () => {
    test('tras re-ingresar como DR: pasa los guardas y accede a su rodeo designado', async () => {
        BD.usuario.tipo_persona = 'delegado_rentado'; BD.usuario.categoria = null;
        const token = (await login()).body.token;
        BD.asignacion = { id: 'asig-dr', estado_designacion: 'aceptado' };
        const r = await pedir('GET', `/api/usuario/cartilla-delegado/rodeo/${RODEO}`, { token });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ asignacion_id: 'asig-dr', rodeo: { id: RODEO } });
    });

    test('Jurado vigente (token correcto) sigue sin acceso a la Cartilla del Delegado (403)', async () => {
        const token = (await login()).body.token;
        const r = await pedir('GET', `/api/usuario/cartilla-delegado/rodeo/${RODEO}`, { token });
        expect(r.status).toBe(403);
    });

    test('DR vigente no accede a la cartilla de jurado (403)', async () => {
        BD.usuario.tipo_persona = 'delegado_rentado';
        const token = (await login()).body.token;
        expect((await pedir('GET', '/api/usuario/cartillas/x', { token })).status).toBe(403);
    });
});

describe('revalidarTipoPersonaUsuario (unidad)', () => {
    const res = () => { const r = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r; };
    test('claim coincide -> next()', async () => {
        const next = jest.fn(); const rr = res();
        await revalidarTipoPersonaUsuario({ usuario: { id: UID, tipo_persona: 'jurado' } }, rr, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(rr.status).not.toHaveBeenCalled();
    });
    test('token sin claim tipo_persona (formato antiguo) -> 401', async () => {
        const next = jest.fn(); const rr = res();
        await revalidarTipoPersonaUsuario({ usuario: { id: UID } }, rr, next);
        expect(next).not.toHaveBeenCalled();
        expect(rr.status).toHaveBeenCalledWith(401);
    });
    test('generarToken sigue funcionando para el login (sin cambios en autenticación)', () => {
        expect(jwt.decode(generarToken({ id: UID, tipo: 'usuario_pagado', tipo_persona: 'jurado' })).tipo_persona).toBe('jurado');
    });
});
