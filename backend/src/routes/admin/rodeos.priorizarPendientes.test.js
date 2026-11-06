// GET /api/admin/rodeos?priorizar_pendientes=true (Panel de Gestión
// Deportiva, cierre): antes "Priorizar pendientes" reordenaba SOLO la
// página ya traída (25/50 filas) — un rodeo pendiente que cayera en la
// página 2 nunca podía aparecer antes que uno sin pendientes de la página
// 1. Este test verifica que ahora se resuelve y reordena el UNIVERSO
// COMPLETO de rodeos que coinciden con los filtros (obtenerTodosLosIdsFiltrados
// + calcularPendientesPorRodeo, misma fuente que el resto del panel) ANTES
// de cortar la página pedida, así page=2 ya refleja el orden global.
jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
const supabase = require('../../config/supabase');
const router = require('./rodeos');

// 3 rodeos en el orden "natural" (fecha descendente) que devolvería la
// query real: r1/r3 YA SE REALIZARON sin nada registrado (tienen
// pendientes); r2 es FUTURO sin designaciones pendientes (sin pendientes).
const AYER   = '2020-01-01';
const FUTURO = '2099-01-01';
const TODOS_RODEOS = [
    { id: 'r1', club: 'Club 1', fecha: AYER },
    { id: 'r2', club: 'Club 2', fecha: FUTURO },
    { id: 'r3', club: 'Club 3', fecha: AYER }
];

// Mock de `rodeos` que SÍ respeta `.in('id', ids)` y `.range(from,to)` sobre
// el dataset fijo de arriba — a diferencia del mock "todo fijo" usado en
// otros tests de este archivo, acá es necesario para poder distinguir
// "universo completo" de "solo la página" en la aserción.
function crearChainRodeos() {
    const chain = {};
    let idsFiltro = null;
    let rango = null;
    ['select', 'eq', 'neq', 'gte', 'lte', 'ilike', 'or', 'not', 'is', 'order'].forEach(m => { chain[m] = () => chain; });
    chain.in = (col, valores) => { if (col === 'id') idsFiltro = valores; return chain; };
    chain.range = (from, to) => { rango = [from, to]; return chain; };
    chain.then = (resolve) => {
        const base = idsFiltro ? TODOS_RODEOS.filter(r => idsFiltro.includes(r.id)) : TODOS_RODEOS;
        const pagina = rango ? base.slice(rango[0], rango[1] + 1) : base;
        resolve({ data: pagina, error: null, count: base.length });
        return Promise.resolve();
    };
    return chain;
}

function crearChainGenerica() {
    const chain = {};
    ['select', 'eq', 'neq', 'gte', 'lte', 'ilike', 'or', 'in', 'not', 'is', 'order', 'range'].forEach(m => { chain[m] = () => chain; });
    chain.then = (resolve) => { resolve({ data: [], error: null, count: 0 }); return Promise.resolve(); };
    return chain;
}

beforeEach(() => {
    supabase.from.mockReset();
    supabase.from.mockImplementation(tabla => tabla === 'rodeos' ? crearChainRodeos() : crearChainGenerica());
});

function crearResFake() {
    const res = {};
    res.statusCode = 200;
    res.status = jest.fn((c) => { res.statusCode = c; return res; });
    res.jsonBody = null;
    res.json = jest.fn((p) => { res.jsonBody = p; return res; });
    return res;
}
function llamar(query = {}) {
    return new Promise((resolve, reject) => {
        const ruta = '/';
        const req = { method: 'GET', url: ruta, originalUrl: ruta, params: {}, query, usuario: { id: 'admin-1', rol_evaluacion: null }, ip: '127.0.0.1' };
        const res = crearResFake();
        const jsonOriginal = res.json;
        res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}

describe('GET /admin/rodeos?priorizar_pendientes=true', () => {
    test('reordena el universo COMPLETO (no solo la página): r1/r3 (pendientes) antes de r2 (sin pendientes), incluso en otra página', async () => {
        const pag1 = await llamar({ priorizar_pendientes: 'true', page: '1', limit: '2' });
        expect(pag1.jsonBody.total).toBe(3);
        expect(pag1.jsonBody.data.map(r => r.id)).toEqual(['r1', 'r3']);
        expect(pag1.jsonBody.data.every(r => r.tiene_pendientes)).toBe(true);

        const pag2 = await llamar({ priorizar_pendientes: 'true', page: '2', limit: '2' });
        expect(pag2.jsonBody.total).toBe(3);
        expect(pag2.jsonBody.data.map(r => r.id)).toEqual(['r2']);
        expect(pag2.jsonBody.data[0].tiene_pendientes).toBe(false);
    });

    test('sin priorizar_pendientes, la paginación sigue siendo la de siempre (orden natural, sin reordenar)', async () => {
        const res = await llamar({ page: '1', limit: '2' });
        expect(res.jsonBody.total).toBe(3);
        expect(res.jsonBody.data.map(r => r.id)).toEqual(['r1', 'r2']);
    });
});
