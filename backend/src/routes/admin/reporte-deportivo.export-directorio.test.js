// ═════════════════════════════════════════════════════════════════════════
// Regresión: GET /export-directorio (el Reporte Directorio real que se
// entrega a GPT — nombre de archivo reporte_directorio_<fecha>.xlsx) debe
// incluir la columna técnica "Rodeo ID" con el UUID real de rodeos.id, sin
// alterar las 14 columnas visibles ya existentes ni la segunda hoja
// "Colleras completas".
//
// Mismo patrón que exportacion.rodeos.test.js: genera un Workbook de
// ExcelJS REAL (nunca mockeado) y lo vuelve a leer — confirma lo que un
// administrador (o GPT vía SheetJS) realmente encontraría al abrir el
// archivo, no solo que el código "se ejecutó sin error".
// ═════════════════════════════════════════════════════════════════════════
const { Writable } = require('stream');
const ExcelJS = require('exceljs');

jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../services/colleras-completas', () => ({ obtenerCollerasCompletas: jest.fn() }));

const supabase = require('../../config/supabase');
const { obtenerCollerasCompletas } = require('../../services/colleras-completas');
const router = require('./reporte-deportivo');

const RODEO_ID_REAL = '5e0d7828-ae39-47ad-b8ed-7f955b43f4a0';

let respuestas;
function crearChain(tabla) {
    const chain = {};
    const metodos = ['select', 'eq', 'neq', 'gte', 'lte', 'ilike', 'or', 'in', 'not', 'is', 'order', 'range', 'limit'];
    metodos.forEach(m => { chain[m] = () => chain; });
    chain.then = (resolve, reject) => Promise.resolve(respuestas[tabla] || { data: [], error: null, count: 0 }).then(resolve, reject);
    return chain;
}

beforeEach(() => {
    respuestas = {
        rodeos: {
            data: [{ id: RODEO_ID_REAL, club: 'SAN CARLOS', asociacion: 'ÑUBLE', fecha: '2026-09-18', tipo_rodeo_nombre: 'Provincial', categoria_rodeo_nombre: 'A', observacion: '' }],
            error: null, count: 1
        },
        evaluaciones: { data: [], error: null },
        datos_monitor_rodeo: { data: [], error: null },
        asignaciones: { data: [], error: null },
        cartillas_jurado: { data: [], error: null }
    };
    supabase.from.mockReset();
    supabase.from.mockImplementation(tabla => crearChain(tabla));
    obtenerCollerasCompletas.mockReset();
    obtenerCollerasCompletas.mockResolvedValue({
        filas: [],
        resumen: { totalCompletas: 0, zonaNorte: 0, centroNorte: 0, zonaCentro: 0, centroSur: 0, zonaSur: 0 }
    });
});

// Simula un `res` de Express que además es un stream escribible (igual que
// exportacion.rodeos.test.js) — la ruta llama wb.xlsx.write(res) directo.
function crearResFake() {
    const chunks = [];
    const sink = new Writable({ write(chunk, enc, cb) { chunks.push(chunk); cb(); } });
    sink.headers = {};
    sink.statusCode = 200;
    sink.setHeader = (k, v) => { sink.headers[k] = v; };
    sink.status = (c) => { sink.statusCode = c; return sink; };
    sink.json = (payload) => { sink.jsonBody = payload; return sink; };
    sink.getBuffer = () => Buffer.concat(chunks);
    return sink;
}

function llamarExportDirectorio() {
    return new Promise((resolve, reject) => {
        const req = { method: 'GET', url: '/export-directorio', originalUrl: '/export-directorio', query: {}, params: {}, headers: {}, usuario: { id: 'admin-test' }, get() { return undefined; } };
        const res = crearResFake();
        const originalEnd = res.end.bind(res);
        res.end = (...args) => { originalEnd(...args); resolve(res); };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}

test('el Reporte Directorio incluye "Rodeo ID" con el UUID real, oculta, sin alterar las 14 columnas visibles ni la Hoja 2', async () => {
    const res = await llamarExportDirectorio();

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Disposition']).toMatch(/reporte_directorio_.*\.xlsx/);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.getBuffer());
    const ws1 = wb.getWorksheet('Reporte Deportivo');
    expect(ws1).toBeDefined();

    const headers = ws1.getRow(1).values.slice(1); // values[0] es undefined en ExcelJS
    expect(headers.length).toBe(15); // 14 visibles + Rodeo ID técnica
    expect(headers.slice(0, 14)).toEqual([
        'Fecha', 'Club', 'Asociación', 'Tipo Rodeo', 'Jurado(s)', 'Resultado Alterado',
        'Descripción de lo observado', 'Total Situaciones', 'Serie Campeones - 2 Vueltas',
        'Caseta Jurado', 'Faltas Disciplinarias/Reglamentarias', 'Ganado Fuera del Peso Reglamentario',
        'Movimiento a la Rienda', 'Acciones Área Deportiva'
    ]);
    expect(headers[14]).toBe('Rodeo ID');

    // Columna oculta
    expect(ws1.getColumn(15).hidden).toBe(true);

    // El valor de la fila de datos es EXACTAMENTE el UUID real, sin transformar
    const filaDatos = ws1.getRow(2).values.slice(1);
    expect(filaDatos[14]).toBe(RODEO_ID_REAL);
    expect(filaDatos[1]).toBe('SAN CARLOS'); // Club sigue en su posición original (columna 2)

    // El autoFilter original (A1:N1, 14 columnas) no fue tocado/ampliado
    // (ExcelJS lo serializa como string tras el round-trip write/read).
    expect(ws1.autoFilter).toBe('A1:N1');

    // Hoja 2 "Colleras completas" intacta
    expect(wb.getWorksheet('Colleras completas')).toBeDefined();
});
