// GET /api/admin/rodeos/contadores-pendientes (Panel de Gestión Deportiva,
// Prioridad 2) — contadores de pendientes sobre TODOS los rodeos que
// coincidan con los filtros (nunca solo la página visible), delegando en
// construirQueryRodeosFiltrada + calcularPendientesPorRodeo de
// services/rodeosListado.js (fuente única, Prioridad 6).
jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
const supabase = require('../../config/supabase');
const router = require('./rodeos');

let respuestas;
function crearChain(tabla) {
    const chain = {};
    const metodos = ['select', 'eq', 'neq', 'gte', 'lte', 'ilike', 'or', 'in', 'not', 'is', 'order', 'range'];
    metodos.forEach(m => { chain[m] = () => chain; });
    chain.then = (resolve, reject) => Promise.resolve(respuestas[tabla] || { data: [], error: null, count: 0 }).then(resolve, reject);
    return chain;
}

beforeEach(() => {
    respuestas = { rodeos: { data: [], error: null, count: 0 } };
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
function llamar(query = {}, usuario = { id: 'admin-1', rol_evaluacion: null }) {
    return new Promise((resolve, reject) => {
        const ruta = '/contadores-pendientes';
        const req = { method: 'GET', url: ruta, originalUrl: ruta, params: {}, query, usuario, ip: '127.0.0.1' };
        const res = crearResFake();
        const jsonOriginal = res.json;
        res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}

describe('GET /admin/rodeos/contadores-pendientes', () => {
    test('permisos: analista/comision_tecnica -> 403, nunca consulta BD', async () => {
        const res = await llamar({}, { id: 'x', rol_evaluacion: 'analista' });
        expect(res.statusCode).toBe(403);
        expect(supabase.from).not.toHaveBeenCalled();
    });

    test('sin rodeos que coincidan -> todos los contadores en 0', async () => {
        respuestas.rodeos = { data: [], error: null, count: 0 };
        const res = await llamar({});
        expect(res.jsonBody).toEqual({ total: 0, designaciones: 0, cartilla_jurado: 0, cartilla_delegado: 0, cartilla_correccion: 0, notas: 0 });
    });

    test('rodeo ya realizado sin nada registrado -> cuenta en cartilla_jurado/cartilla_delegado/notas, total=1', async () => {
        respuestas.rodeos = { data: [{ id: 'r1', fecha: '2020-01-01' }], error: null, count: 1 };
        respuestas.asignaciones = { data: [], error: null };
        respuestas.cartillas_delegado = { data: [], error: null };
        respuestas.rodeo_adjuntos = { data: [], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        respuestas.cartillas_jurado = { data: [], error: null };
        respuestas.rodeo_notas_secundarias = { data: [], error: null };
        respuestas.evaluaciones = { data: [], error: null };
        respuestas.notas_rodeo = { data: [], error: null };

        const res = await llamar({});
        expect(res.jsonBody.total).toBe(1);
        expect(res.jsonBody.cartilla_jurado).toBe(1);
        expect(res.jsonBody.cartilla_delegado).toBe(1);
        expect(res.jsonBody.notas).toBe(1);
        expect(res.jsonBody.cartilla_correccion).toBe(0);
    });

    test('contadores respetan los filtros recibidos (se delegan a construirQueryRodeosFiltrada) — club filtra antes de contar', async () => {
        let clubVisto = null;
        const chainRodeos = {};
        ['select', 'eq', 'neq', 'gte', 'lte', 'or', 'in', 'not', 'is', 'order', 'range'].forEach(m => { chainRodeos[m] = () => chainRodeos; });
        chainRodeos.ilike = (col, val) => { if (col === 'club') clubVisto = val; return chainRodeos; };
        chainRodeos.then = (resolve) => resolve({ data: [], error: null, count: 0 });
        supabase.from.mockImplementation(tabla => tabla === 'rodeos' ? chainRodeos : crearChain(tabla));

        await llamar({ club: 'Rauco' });
        expect(clubVisto).toBe('%Rauco%');
    });
});
