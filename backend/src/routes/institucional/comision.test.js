// Portal de Comisión de Asociación (migración 079). Mismo patrón de mock
// que rodeos.js/delegados.js: resolverTemporada()/resolverAsociacion()/
// construirIndiceCatalogo() REALES contra supabase.from mockeado — nunca
// reimplementados.
const jwt = require('jsonwebtoken');

jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));

const supabase = require('../../config/supabase');
const router = require('./comision');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_in_prod';
const ID_OSORNO = 'id-osorno';
const ID_VALDIVIA = 'id-valdivia';

const TEMPORADA = { id: 'temp-1', nombre: '2026-2027', fecha_inicio: '2026-07-01', fecha_fin: '2027-06-30', activa: true };
const CATALOGO = [
    { id: ID_OSORNO, nombre: 'OSORNO', nombre_normalizado: 'osorno', activa: true },
    { id: ID_VALDIVIA, nombre: 'VALDIVIA', nombre_normalizado: 'valdivia', activa: true }
];

let respuestas;
function crearChain(tabla) {
    const chain = {};
    ['select', 'gte', 'lte', 'limit', 'order', 'in', 'neq', 'insert'].forEach(m => { chain[m] = () => chain; });
    chain.eq = () => chain;
    chain.single = () => Promise.resolve(respuestas[tabla]?.single ?? respuestas[tabla] ?? { data: null, error: null });
    chain.maybeSingle = () => Promise.resolve(respuestas[tabla]?.maybeSingle ?? respuestas[tabla] ?? { data: null, error: null });
    chain.then = (resolve, reject) => Promise.resolve(respuestas[tabla]?.list ?? respuestas[tabla] ?? { data: [], error: null }).then(resolve, reject);
    return chain;
}

beforeEach(() => {
    respuestas = {
        cuentas_institucionales: { data: { activo: true, asociaciones: { activa: true } }, error: null },
        temporadas: { data: [TEMPORADA], error: null },
        asociaciones: { data: CATALOGO, error: null },
        asociacion_alias: { data: [], error: null },
        rodeos: { data: [], error: null },
        asignaciones: { data: [], error: null },
        comision_evaluaciones_jurado: { data: [], error: null },
        rodeo_notas_secundarias: { data: [], error: null },
        evaluadores_comision: { data: [], error: null }
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
function tokenComision(asociacion_id = ID_OSORNO) {
    return jwt.sign({ id: 'com-1', tipo: 'cuenta_institucional', rol_institucional: 'comision_asociacion', asociacion_id }, JWT_SECRET, { expiresIn: '8h' });
}
function tokenDelegado(asociacion_id = ID_OSORNO) {
    return jwt.sign({ id: 'del-1', tipo: 'cuenta_institucional', rol_institucional: 'delegado_asociacion', asociacion_id }, JWT_SECRET, { expiresIn: '8h' });
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
const authComision = (asoc) => ({ authorization: `Bearer ${tokenComision(asoc)}` });

describe('Aislamiento de rol', () => {
    test('una cuenta de Delegado NUNCA puede usar el portal de Comisión, aunque llame directo por HTTP', async () => {
        const res = await llamar('GET', '/rodeos', {}, { authorization: `Bearer ${tokenDelegado()}` });
        expect(res.statusCode).toBe(403);
    });
});

describe('GET /comision/rodeos', () => {
    test('devuelve solo rodeos de la asociación propia, con jurados y su estado de evaluación', async () => {
        respuestas.rodeos = {
            data: [
                { id: 'rodeo-1', fecha: '2026-09-18', club: 'Club A', asociacion: 'OSORNO', tipo_rodeo_nombre: 'Provincial', estado: 'activo' },
                { id: 'rodeo-2', fecha: '2026-09-19', club: 'Club B', asociacion: 'VALDIVIA', tipo_rodeo_nombre: 'Provincial', estado: 'activo' }
            ],
            error: null
        };
        respuestas.asignaciones = {
            data: [
                { id: 'asig-1', rodeo_id: 'rodeo-1', usuario_pagado_id: null, nombre_importado: 'Juan Jurado', usuarios_pagados: null },
                { id: 'asig-2', rodeo_id: 'rodeo-1', usuario_pagado_id: 'up-1', nombre_importado: null, usuarios_pagados: { nombre_completo: 'Pedro Pagado' } }
            ],
            error: null
        };
        respuestas.comision_evaluaciones_jurado = {
            data: [{ asignacion_id: 'asig-1', nota_individual_calculada: 4.6, estado: 'enviada', enviada_en: '2026-09-19T00:00:00Z', evaluadores_comision: { nombre: 'Ana', apellidos: 'Soto' } }],
            error: null
        };
        respuestas.rodeo_notas_secundarias = { data: [{ rodeo_id: 'rodeo-1', nota_comision: null, estado_nota_comision: 'parcial', requiere_revision_admin: false }], error: null };

        const res = await llamar('GET', '/rodeos', {}, authComision());
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.rodeos.length).toBe(1); // solo el de OSORNO
        const r = res.jsonBody.rodeos[0];
        expect(r.jurados).toEqual([
            { asignacion_id: 'asig-1', nombre: 'Juan Jurado', evaluado: true, nota_individual: 4.6, evaluador_nombre: 'Ana Soto', enviada_en: '2026-09-19T00:00:00Z' },
            { asignacion_id: 'asig-2', nombre: 'Pedro Pagado', evaluado: false, nota_individual: null, evaluador_nombre: null, enviada_en: null }
        ]);
        expect(r.estado_nota_comision).toBe('parcial');
    });

    test('un rodeo con Nota Comisión histórica -> evaluacion_disponible=false', async () => {
        respuestas.rodeos = { data: [{ id: 'rodeo-h', fecha: '2026-09-18', club: 'Club H', asociacion: 'OSORNO', tipo_rodeo_nombre: 'Provincial', estado: 'activo' }], error: null };
        respuestas.rodeo_notas_secundarias = { data: [{ rodeo_id: 'rodeo-h', nota_comision: 5.5, estado_nota_comision: 'historica_sin_desglose', requiere_revision_admin: false }], error: null };

        const res = await llamar('GET', '/rodeos', {}, authComision());
        expect(res.jsonBody.rodeos[0].evaluacion_disponible).toBe(false);
        expect(res.jsonBody.rodeos[0].nota_comision).toBe(5.5);
    });
});

describe('POST /comision/evaluadores', () => {
    test('RUT inválido -> 400, nunca llama a la RPC', async () => {
        const res = await llamar('POST', '/evaluadores', { nombre: 'A', apellidos: 'B', rut: 'no-es-un-rut' }, authComision());
        expect(res.statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('registro válido -> 201, actor_tipo=cuenta_institucional, RUT normalizado', async () => {
        supabase.rpc.mockResolvedValue({ data: { id: 'ev-1', nombre: 'Pedro', apellidos: 'Pérez' }, error: null });
        const res = await llamar('POST', '/evaluadores', { nombre: 'Pedro', apellidos: 'Pérez', rut: '12.345.678-5' }, authComision());
        expect(res.statusCode).toBe(201);
        const args = supabase.rpc.mock.calls[0][1];
        expect(supabase.rpc.mock.calls[0][0]).toBe('registrar_evaluador_comision_con_auditoria');
        expect(args.p_actor_tipo).toBe('cuenta_institucional');
        expect(args.p_rut).toBe('12345678-5');
        expect(args.p_asociacion_id).toBe(ID_OSORNO);
    });

    test('RUT duplicado en la asociación -> 409', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'EVALUADOR_YA_REGISTRADO' } });
        const res = await llamar('POST', '/evaluadores', { nombre: 'Pedro', apellidos: 'Pérez', rut: '12345678-5' }, authComision());
        expect(res.statusCode).toBe(409);
    });
});

describe('POST /comision/evaluaciones', () => {
    function datosValidos(extra = {}) {
        return {
            rodeo_id: 'rodeo-1', asignacion_id: 'asig-1', evaluador_id: 'ev-1',
            nota_apinadero: 6, nota_cancha: 5, nota_atajadas: 4, nota_cuarta_carrera: 3,
            hubo_movimiento_rienda: false, nota_rienda: null, afecto_resultado_final: false,
            ...extra
        };
    }

    test('campos de criterio faltantes -> 400, nunca llama a la RPC', async () => {
        const res = await llamar('POST', '/evaluaciones', { rodeo_id: 'r1', asignacion_id: 'a1', evaluador_id: 'e1' }, authComision());
        expect(res.statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('rodeo que no pertenece a la asociación propia -> 404, nunca llama a la RPC', async () => {
        respuestas.rodeos = { data: null, error: null }; // maybeSingle -> null -> rodeoDeMiAsociacion devuelve null
        const res = await llamar('POST', '/evaluaciones', datosValidos(), authComision());
        expect(res.statusCode).toBe(404);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('Hallazgo 2: una cuenta de Comisión de OSORNO intenta evaluar un jurado de un rodeo de SANTIAGO SUR -> rechazado, CERO escrituras, CERO llamadas a la RPC', async () => {
        // rodeoDeMiAsociacion(rodeo_id, req.usuario.asociacion_id=ID_OSORNO)
        // resuelve el rodeo real contra el catálogo/alias — si pertenece a
        // otra asociación, devuelve null SIN exponer que el rodeo existe.
        respuestas.rodeos = { data: { id: 'rodeo-santiago-sur', club: 'Club Santiago', asociacion: 'SANTIAGO SUR', fecha: '2026-09-18', estado: 'activo', temporada_id: null, temporadas: null }, error: null };
        respuestas.asociaciones = { data: [{ id: ID_OSORNO, nombre: 'OSORNO', nombre_normalizado: 'osorno', activa: true }, { id: 'id-santiago-sur', nombre: 'SANTIAGO SUR', nombre_normalizado: 'santiago sur', activa: true }], error: null };
        const res = await llamar('POST', '/evaluaciones', datosValidos({ rodeo_id: 'rodeo-santiago-sur' }), authComision(ID_OSORNO));
        expect(res.statusCode).toBe(404);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('rodeo con Nota Comisión ya cerrada (completa/corregida) -> 409 NOTA_COMISION_CERRADA', async () => {
        respuestas.rodeos = { data: { id: 'rodeo-1', club: 'X', asociacion: 'OSORNO', fecha: '2026-09-18', estado: 'activo', tipo_rodeo_nombre: 'Provincial' }, error: null };
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'NOTA_COMISION_CERRADA' } });
        const res = await llamar('POST', '/evaluaciones', datosValidos(), authComision());
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('NOTA_COMISION_CERRADA');
    });

    test('rodeo con revisión administrativa pendiente -> 409 REQUIERE_RESOLUCION_ADMINISTRATIVA_PRIMERO', async () => {
        respuestas.rodeos = { data: { id: 'rodeo-1', club: 'X', asociacion: 'OSORNO', fecha: '2026-09-18', estado: 'activo', tipo_rodeo_nombre: 'Provincial' }, error: null };
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'REQUIERE_RESOLUCION_ADMINISTRATIVA_PRIMERO' } });
        const res = await llamar('POST', '/evaluaciones', datosValidos(), authComision());
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('REQUIERE_RESOLUCION_ADMINISTRATIVA_PRIMERO');
    });

    test('Hallazgo 5 (identificadores manipulados): asignacion_id que pertenece a OTRO rodeo que el indicado en el body -> rechazado por la RPC (FK real, sin duplicar el resolutor)', async () => {
        // El rodeo SÍ pertenece a la asociación propia (pasa rodeoDeMiAsociacion),
        // pero el asignacion_id fue manipulado para apuntar a una asignación de
        // otro rodeo — la propia RPC lo detecta (WHERE a.id=... AND a.rodeo_id=...)
        // sin necesidad de duplicar ninguna lógica de catálogo/alias en SQL.
        respuestas.rodeos = { data: { id: 'rodeo-1', club: 'X', asociacion: 'OSORNO', fecha: '2026-09-18', estado: 'activo', tipo_rodeo_nombre: 'Provincial' }, error: null };
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'ASIGNACION_NO_ENCONTRADA' } });
        const res = await llamar('POST', '/evaluaciones', datosValidos({ asignacion_id: 'asig-de-otro-rodeo' }), authComision());
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('DESIGNACION_NO_VIGENTE');
    });

    test('envío exitoso -> 201', async () => {
        respuestas.rodeos = { data: { id: 'rodeo-1', club: 'X', asociacion: 'OSORNO', fecha: '2026-09-18', estado: 'activo', tipo_rodeo_nombre: 'Provincial', temporada_id: null, temporadas: null }, error: null };
        supabase.rpc.mockResolvedValue({ data: { id: 'eval-1', nota_individual_calculada: 4.6, estado: 'enviada' }, error: null });
        const res = await llamar('POST', '/evaluaciones', datosValidos(), authComision());
        expect(res.statusCode).toBe(201);
        expect(supabase.rpc.mock.calls[0][0]).toBe('enviar_evaluacion_comision_jurado_con_auditoria');
        expect(supabase.rpc.mock.calls[0][1].p_asociacion_id).toBe(ID_OSORNO);
    });

    test('evaluación duplicada -> 409 EVALUACION_YA_ENVIADA', async () => {
        respuestas.rodeos = { data: { id: 'rodeo-1', club: 'X', asociacion: 'OSORNO', fecha: '2026-09-18', estado: 'activo', tipo_rodeo_nombre: 'Provincial' }, error: null };
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'EVALUACION_YA_ENVIADA' } });
        const res = await llamar('POST', '/evaluaciones', datosValidos(), authComision());
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('EVALUACION_YA_ENVIADA');
    });

    test('rodeo con Nota Comisión histórica -> 409 NOTA_COMISION_HISTORICA_PROTEGIDA', async () => {
        respuestas.rodeos = { data: { id: 'rodeo-1', club: 'X', asociacion: 'OSORNO', fecha: '2026-09-18', estado: 'activo', tipo_rodeo_nombre: 'Provincial' }, error: null };
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'NOTA_COMISION_HISTORICA_PROTEGIDA' } });
        const res = await llamar('POST', '/evaluaciones', datosValidos(), authComision());
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('NOTA_COMISION_HISTORICA_PROTEGIDA');
    });

    test('hubo_movimiento_rienda=true sin nota_rienda -> la RPC rechaza y se traduce a 400', async () => {
        respuestas.rodeos = { data: { id: 'rodeo-1', club: 'X', asociacion: 'OSORNO', fecha: '2026-09-18', estado: 'activo', tipo_rodeo_nombre: 'Provincial' }, error: null };
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'NOTA_RIENDA_REQUERIDA' } });
        const res = await llamar('POST', '/evaluaciones', datosValidos({ hubo_movimiento_rienda: true, nota_rienda: null }), authComision());
        expect(res.statusCode).toBe(400);
        expect(res.jsonBody.code).toBe('NOTA_RIENDA_REQUERIDA');
    });
});
