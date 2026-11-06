// GET /api/admin/rodeos — Panel Central de Gestión Deportiva: la tabla
// principal ahora trae, además de las columnas ya existentes, `pendientes`/
// `tiene_pendientes` (Prioridad 5) y `nota_comision`/`nota_delegado`/
// `nota_area_deportiva` (Prioridad 4) por rodeo — mismas fuentes que ya usa
// la exportación a Excel (rodeosListado.js), nunca recalculadas aparte.
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
        const ruta = '/';
        const req = { method: 'GET', url: ruta, originalUrl: ruta, params: {}, query, usuario, ip: '127.0.0.1' };
        const res = crearResFake();
        const jsonOriginal = res.json;
        res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}

describe('GET /admin/rodeos — campos aditivos del Panel de Gestión Deportiva', () => {
    test('incluye pendientes/tiene_pendientes y notas por rodeo, usando las mismas fuentes que la exportación', async () => {
        respuestas.rodeos = { data: [{ id: 'r1', fecha: '2020-01-01' }], error: null, count: 1 };
        respuestas.asignaciones = { data: [], error: null };
        respuestas.cartillas_delegado = { data: [], error: null };
        respuestas.rodeo_adjuntos = { data: [], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        respuestas.cartillas_jurado = { data: [], error: null };
        respuestas.rodeo_notas_secundarias = { data: [{ rodeo_id: 'r1', nota_comision: 6.5, nota_delegado: null }], error: null };
        respuestas.evaluaciones = { data: [], error: null };
        respuestas.notas_rodeo = { data: [], error: null };

        const res = await llamar({});
        const fila = res.jsonBody.data[0];
        expect(fila.tiene_pendientes).toBe(true);
        expect(fila.pendientes).toContain('cartilla_jurado_pendiente');
        expect(fila.nota_comision).toBe(6.5);
        expect(fila.nota_delegado).toBeNull();
        expect(fila.nota_area_deportiva).toEqual({ actuales: [], historicas: [] });
    });

    test('rodeo sin ningún rodeo (lista vacía) no rompe y no agrega campos de pendientes/notas', async () => {
        respuestas.rodeos = { data: [], error: null, count: 0 };
        const res = await llamar({});
        expect(res.jsonBody.data).toEqual([]);
    });
});
