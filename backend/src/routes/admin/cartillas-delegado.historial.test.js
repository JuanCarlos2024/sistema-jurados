// Fase 3.5 — GET /:id ahora agrega `historial_responsables`, construido con
// el MISMO servicio de solo lectura (services/historialResponsableInstitucional,
// 100% basado en auditoria real) que usa el formulario institucional. Solo
// aplica a cartillas de origen institucional (delegado_asociacion_id
// presente) — las de Delegado Rentado nunca tienen fila en
// rodeos_delegado_institucional, así que el historial viene vacío sin ni
// siquiera consultar auditoria.
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
        asignaciones: { maybeSingle: { data: null, error: null } }
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

describe('GET /:id — historial_responsables (Fase 3.5)', () => {
    test('cartilla de Delegado Rentado -> historial_responsables=[], nunca consulta rodeos_delegado_institucional ni auditoria', async () => {
        respuestas.cartillas_delegado = { single: { data: { id: 'c1', rodeo_id: 'rodeo-1', estado: 'enviada', delegado_asociacion_id: null }, error: null } };
        const res = await llamar('/c1');
        expect(res.jsonBody.historial_responsables).toEqual([]);
        expect(supabase.from).not.toHaveBeenCalledWith('rodeos_delegado_institucional');
        expect(supabase.from).not.toHaveBeenCalledWith('auditoria');
    });

    test('cartilla institucional sin designación encontrada -> historial solo desde auditoria por cartillaId', async () => {
        respuestas.cartillas_delegado = { single: { data: { id: 'c2', rodeo_id: 'rodeo-2', estado: 'borrador', delegado_asociacion_id: 'del-1' }, error: null } };
        respuestas.rodeos_delegado_institucional = { maybeSingle: { data: null, error: null } };
        respuestas.auditoria = { list: { data: [{ id: 'ev1', accion: 'crear', created_at: '2026-01-01T00:00:00Z' }], error: null } };
        const res = await llamar('/c2');
        expect(res.jsonBody.historial_responsables).toEqual([{ id: 'ev1', accion: 'crear', created_at: '2026-01-01T00:00:00Z' }]);
    });

    test('cartilla institucional con designación confirmada -> consulta rodeos_delegado_institucional para resolver su id', async () => {
        respuestas.cartillas_delegado = { single: { data: { id: 'c3', rodeo_id: 'rodeo-3', estado: 'borrador', delegado_asociacion_id: 'del-1' }, error: null } };
        respuestas.rodeos_delegado_institucional = { maybeSingle: { data: { id: 'desig-3' }, error: null } };
        respuestas.auditoria = { list: { data: [{ id: 'ev1', accion: 'confirmar_responsable_institucional', created_at: '2026-01-01T00:00:00Z' }], error: null } };
        const res = await llamar('/c3');
        expect(res.jsonBody.historial_responsables.length).toBe(2); // misma lista mockeada se devuelve para ambas consultas de auditoria (designacionId + cartillaId)
        expect(supabase.from).toHaveBeenCalledWith('rodeos_delegado_institucional');
    });

    test('cartilla no encontrada -> 404 (sin regresión)', async () => {
        respuestas.cartillas_delegado = { single: { data: null, error: { message: 'no rows' } } };
        const res = await llamar('/no-existe');
        expect(res.statusCode).toBe(404);
    });
});
