// Fase 3: GET /by-rodeo/:rodeo_id y GET /:id ahora agregan un campo
// informativo `origen` ('delegado_rentado' | 'delegado_asociacion'), sin
// cambiar nada más del comportamiento existente (sin romper el circuito
// administrativo actual de Delegado Rentado).
jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../services/cartilla-delegado-pdf', () => ({ generarCartillaDelegadoPDF: jest.fn() }));
jest.mock('../../services/emailService', () => ({ enviarEmail: jest.fn() }));

const supabase = require('../../config/supabase');
const router = require('./cartillas-delegado');

let respuestas;
function crearChain(tabla) {
    const chain = {};
    ['select', 'eq', 'order', 'neq'].forEach(m => { chain[m] = () => chain; });
    chain.single = () => Promise.resolve(respuestas[tabla]?.single ?? { data: null, error: null });
    chain.maybeSingle = () => Promise.resolve(respuestas[tabla]?.maybeSingle ?? { data: null, error: null });
    chain.then = (resolve, reject) => Promise.resolve(respuestas[tabla]?.list ?? { data: [], error: null }).then(resolve, reject);
    return chain;
}

beforeEach(() => {
    respuestas = {
        asignaciones: { maybeSingle: { data: null, error: null } } // sin designación vigente de Rentado por defecto
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
function llamar(ruta) {
    return new Promise((resolve, reject) => {
        const req = { method: 'GET', url: ruta, originalUrl: ruta, body: {}, params: {}, query: {} };
        const res = crearResFake();
        const jsonOriginal = res.json;
        res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}

describe('GET /by-rodeo/:rodeo_id — campo origen', () => {
    test('cartilla de Delegado Rentado (delegado_asociacion_id null) -> origen="delegado_rentado"', async () => {
        respuestas.cartillas_delegado = { list: { data: [{ id: 'c1', delegado_asociacion_id: null, delegado: { nombre_completo: 'Pedro' } }], error: null } };
        const res = await llamar('/by-rodeo/rodeo-1');
        expect(res.jsonBody[0].origen).toBe('delegado_rentado');
    });

    test('cartilla institucional (delegado_asociacion_id presente) -> origen="delegado_asociacion"', async () => {
        respuestas.cartillas_delegado = { list: { data: [{ id: 'c2', delegado_asociacion_id: 'del-1', delegado: null }], error: null } };
        const res = await llamar('/by-rodeo/rodeo-1');
        expect(res.jsonBody[0].origen).toBe('delegado_asociacion');
    });

    test('sin resultados -> 200 con arreglo vacío (sin regresión)', async () => {
        respuestas.cartillas_delegado = { list: { data: [], error: null } };
        const res = await llamar('/by-rodeo/rodeo-1');
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody).toEqual([]);
    });

    test('Fase 3.1 Caso D — cartilla institucional + designación VIGENTE de Rentado para el mismo rodeo -> conflicto_designacion_posterior=true (solo informativo, no borra ni transfiere nada)', async () => {
        respuestas.cartillas_delegado = { list: { data: [{ id: 'c2', delegado_asociacion_id: 'del-1', delegado: null }], error: null } };
        respuestas.asignaciones = { maybeSingle: { data: { id: 'asig-1' }, error: null } };
        const res = await llamar('/by-rodeo/rodeo-1');
        expect(res.jsonBody[0].conflicto_designacion_posterior).toBe(true);
        expect(res.jsonBody[0].id).toBe('c2'); // la fila institucional sigue intacta
    });

    test('cartilla institucional SIN designación vigente de Rentado -> sin la bandera de conflicto', async () => {
        respuestas.cartillas_delegado = { list: { data: [{ id: 'c2', delegado_asociacion_id: 'del-1', delegado: null }], error: null } };
        const res = await llamar('/by-rodeo/rodeo-1');
        expect(res.jsonBody[0].conflicto_designacion_posterior).toBeUndefined();
    });

    test('cartilla de Delegado Rentado (sin institucional) -> nunca consulta asignaciones para esta bandera', async () => {
        respuestas.cartillas_delegado = { list: { data: [{ id: 'c1', delegado_asociacion_id: null, delegado: { nombre_completo: 'Pedro' } }], error: null } };
        const res = await llamar('/by-rodeo/rodeo-1');
        expect(res.jsonBody[0].conflicto_designacion_posterior).toBeUndefined();
    });
});

describe('GET /:id — campo origen', () => {
    test('cartilla de Delegado Rentado -> origen="delegado_rentado", resto de los campos intactos', async () => {
        respuestas.cartillas_delegado = { single: { data: { id: 'c1', estado: 'enviada', delegado_asociacion_id: null, delegado_nombre: 'Pedro' }, error: null } };
        const res = await llamar('/c1');
        expect(res.jsonBody.origen).toBe('delegado_rentado');
        expect(res.jsonBody.estado).toBe('enviada');
        expect(res.jsonBody.delegado_nombre).toBe('Pedro');
    });

    test('cartilla institucional -> origen="delegado_asociacion"', async () => {
        respuestas.cartillas_delegado = { single: { data: { id: 'c2', estado: 'borrador', delegado_asociacion_id: 'del-1', delegado_nombre: 'Ana' }, error: null } };
        const res = await llamar('/c2');
        expect(res.jsonBody.origen).toBe('delegado_asociacion');
    });

    test('no encontrada -> 404 (sin regresión)', async () => {
        respuestas.cartillas_delegado = { single: { data: null, error: { message: 'no rows' } } };
        const res = await llamar('/no-existe');
        expect(res.statusCode).toBe(404);
    });
});
