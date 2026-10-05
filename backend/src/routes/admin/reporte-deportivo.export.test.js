// ═════════════════════════════════════════════════════════════════════════
// GET /export — el Excel del botón verde "Exportar Excel" de la pantalla
// Reporte Deportivo (filename reporte_deportivo_<fecha>.xlsx). Cubre la
// inserción de 3 columnas nuevas justo después de "Nota Final":
//   Nota Delegado   (rodeo_notas_secundarias.nota_delegado, 1 fila por rodeo)
//   Nota Comisión   (rodeo_notas_secundarias.nota_comision, 1 fila por rodeo)
//   Total Casos WSP (evaluaciones.casos_whatsapp, INTEGER DEFAULT 0)
//
// Workbook ExcelJS REAL escrito y releído (mismo patrón que
// reporte-deportivo.export-directorio.test.js / export-fin-semana.test.js).
// Solo fixtures, sin datos reales.
// ═════════════════════════════════════════════════════════════════════════
const { Writable } = require('stream');
const ExcelJS = require('exceljs');

jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../services/colleras-completas', () => ({ obtenerCollerasCompletas: jest.fn() }));

const supabase = require('../../config/supabase');
const router = require('./reporte-deportivo');

const ID_CON_NOTAS = '5e0d7828-ae39-47ad-b8ed-7f955b43f4a0';   // notas + evaluación con casos_whatsapp=3
const ID_SIN_NOTAS = 'f5300d3f-6810-471d-8a8b-e0de5672bd78';   // sin fila en rodeo_notas_secundarias; evaluación con casos_whatsapp=0
const ID_SIN_EVAL  = '60842ab4-02ae-4be5-96aa-10bb69dc7d6f';   // sin evaluación en absoluto
const ID_DOS_JURADOS = '8b6a6a9e-3b40-4a3a-9a0a-2f6a7e6c5d10'; // 1 rodeo, 2 asignaciones de jurado

// Orden completo esperado (35 columnas: 32 originales + 3 nuevas).
const HEADERS_ESPERADOS = [
    'Fecha', 'Club', 'Asociación', 'Tipo Rodeo', 'Categoría', 'Jurado(s)', 'Delegado Rentado',
    'Nota Final', 'Nota Delegado', 'Nota Comisión', 'Total Casos WSP',
    'Oficial 1er Lugar', 'Oficial 2do Lugar', 'Oficial 3er Lugar',
    'Revisado 1er Lugar', 'Revisado 2do Lugar', 'Revisado 3er Lugar',
    'Resultado Alterado', 'Com. Alteración', 'Total Situaciones',
    'Sit. Ciclo 1 - Primeros 3', 'Sit. Ciclo 2 - Campeones',
    'Apreciación', 'Reglamentaria', 'Conceptual',
    'Observaciones de Jurado en Rodeo', 'Observación Jurado de Análisis de Jura',
    'Obs. Jefe Deportivo', 'Obs. Monitor', 'Obs. Análisis Técnico',
    'Serie Campeones - 2 Vueltas', 'Caseta Adecuada',
    'Faltas Disciplinarias/Reglamentarias', 'Ganado Fuera del Peso Reglamentario', 'Movimiento a la Rienda'
];

let respuestas;
function crearChain(tabla) {
    const chain = {};
    ['select', 'eq', 'neq', 'gte', 'lte', 'ilike', 'or', 'in', 'not', 'is', 'order', 'range', 'limit'].forEach(m => {
        chain[m] = () => chain;
    });
    chain.then = (resolve, reject) => Promise.resolve(respuestas[tabla] || { data: [], error: null, count: 0 }).then(resolve, reject);
    return chain;
}

beforeEach(() => {
    respuestas = {
        rodeos: {
            data: [
                { id: ID_CON_NOTAS,   club: 'SAN CARLOS', asociacion: 'ÑUBLE',  fecha: '2026-09-18', tipo_rodeo_nombre: 'Provincial', categoria_rodeo_nombre: 'A', observacion: '' },
                { id: ID_SIN_NOTAS,   club: 'PUCON',      asociacion: 'CAUTÍN', fecha: '2026-09-19', tipo_rodeo_nombre: 'Provincial', categoria_rodeo_nombre: 'A', observacion: '' },
                { id: ID_SIN_EVAL,    club: 'LA CELIA',   asociacion: 'MAULE',  fecha: '2026-09-19', tipo_rodeo_nombre: 'Provincial', categoria_rodeo_nombre: 'A', observacion: '' },
                { id: ID_DOS_JURADOS, club: 'LOS ANGELES',asociacion: 'BIOBIO', fecha: '2026-09-20', tipo_rodeo_nombre: 'Provincial', categoria_rodeo_nombre: 'A', observacion: '' }
            ],
            error: null, count: 4
        },
        evaluaciones: {
            data: [
                { id: 'ev-1', rodeo_id: ID_CON_NOTAS, estado: 'cerrada', casos_whatsapp: 3, modo_flujo: null },
                { id: 'ev-2', rodeo_id: ID_SIN_NOTAS, estado: 'cerrada', casos_whatsapp: 0, modo_flujo: null },
                { id: 'ev-3', rodeo_id: ID_DOS_JURADOS, estado: 'cerrada', casos_whatsapp: 1, modo_flujo: null }
                // ID_SIN_EVAL: sin fila -> CASO H (sin evaluación)
            ],
            error: null
        },
        rodeo_notas_secundarias: {
            data: [
                { rodeo_id: ID_CON_NOTAS, nota_delegado: 5.8, nota_comision: 6.4 }
                // ID_SIN_NOTAS, ID_SIN_EVAL, ID_DOS_JURADOS: sin fila -> SIN INFORMACIÓN
            ],
            error: null
        },
        datos_monitor_rodeo: { data: [], error: null },
        asignaciones: {
            data: [
                { rodeo_id: ID_DOS_JURADOS, tipo_persona: 'jurado', estado_designacion: 'aceptado', nombre_importado: null, usuarios_pagados: { id: 'u1', nombre_completo: 'Jurado Uno' } },
                { rodeo_id: ID_DOS_JURADOS, tipo_persona: 'jurado', estado_designacion: 'aceptado', nombre_importado: null, usuarios_pagados: { id: 'u2', nombre_completo: 'Jurado Dos' } }
            ],
            error: null
        },
        cartillas_jurado: { data: [], error: null }
    };
    supabase.from.mockReset();
    supabase.from.mockImplementation(tabla => crearChain(tabla));
});

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

function llamar(query = {}) {
    return new Promise((resolve, reject) => {
        const req = { method: 'GET', url: '/export', originalUrl: '/export', query, params: {}, headers: {}, usuario: { id: 'admin-test' }, get() { return undefined; } };
        const res = crearResFake();
        const originalEnd = res.end.bind(res);
        res.end = (...args) => { originalEnd(...args); resolve(res); };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}

async function cargarHoja(query) {
    const res = await llamar(query);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.getBuffer());
    return { res, ws: wb.getWorksheet('Reporte Deportivo') };
}

// Fila (1-based, sin encabezado) de cada rodeo según el orden `data.rodeos` arriba.
const FILA_CON_NOTAS   = 2;
const FILA_SIN_NOTAS   = 3;
const FILA_SIN_EVAL    = 4;
const FILA_DOS_JURADOS = 5;

describe('GET /export — columnas nuevas después de Nota Final', () => {
    test('CASO A: orden exacto de columnas (35 en total; Nota Delegado/Comisión/Total Casos WSP consecutivas después de Nota Final)', async () => {
        const { res, ws } = await cargarHoja();
        expect(res.statusCode).toBe(200);
        expect(res.headers['Content-Disposition']).toMatch(/^attachment; filename="reporte_deportivo_\d{4}-\d{2}-\d{2}\.xlsx"$/);

        const headers = ws.getRow(1).values.slice(1);
        expect(headers.length).toBe(35);
        expect(headers).toEqual(HEADERS_ESPERADOS);

        const iNotaFinal = headers.indexOf('Nota Final');
        expect(headers[iNotaFinal + 1]).toBe('Nota Delegado');
        expect(headers[iNotaFinal + 2]).toBe('Nota Comisión');
        expect(headers[iNotaFinal + 3]).toBe('Total Casos WSP');
        expect(headers[iNotaFinal + 4]).toBe('Oficial 1er Lugar');
    });

    test('CASO B/D: Nota Delegado=5.8 y Nota Comisión=6.4 se exportan con su valor numérico exacto', async () => {
        const { ws } = await cargarHoja();
        expect(ws.getRow(FILA_CON_NOTAS).getCell(9).value).toBe(5.8);   // Nota Delegado
        expect(ws.getRow(FILA_CON_NOTAS).getCell(10).value).toBe(6.4);  // Nota Comisión
    });

    test('CASO C/E: sin fila en rodeo_notas_secundarias -> Nota Delegado y Nota Comisión muestran "SIN INFORMACIÓN"', async () => {
        const { ws } = await cargarHoja();
        expect(ws.getRow(FILA_SIN_NOTAS).getCell(9).value).toBe('SIN INFORMACIÓN');
        expect(ws.getRow(FILA_SIN_NOTAS).getCell(10).value).toBe('SIN INFORMACIÓN');
        expect(ws.getRow(FILA_SIN_EVAL).getCell(9).value).toBe('SIN INFORMACIÓN');
        expect(ws.getRow(FILA_SIN_EVAL).getCell(10).value).toBe('SIN INFORMACIÓN');
    });

    test('CASO F: casos_whatsapp=0 muestra 0, NUNCA "SIN INFORMACIÓN"', async () => {
        const { ws } = await cargarHoja();
        expect(ws.getRow(FILA_SIN_NOTAS).getCell(11).value).toBe(0);
    });

    test('CASO G: casos_whatsapp=3 se exporta como 3', async () => {
        const { ws } = await cargarHoja();
        expect(ws.getRow(FILA_CON_NOTAS).getCell(11).value).toBe(3);
    });

    test('CASO H: rodeo sin evaluación -> Total Casos WSP = 0 y el Excel se genera sin error', async () => {
        const { res, ws } = await cargarHoja();
        expect(res.statusCode).toBe(200);
        expect(ws.getRow(FILA_SIN_EVAL).getCell(11).value).toBe(0);
    });

    test('CASO I: las columnas que ya existían después de Nota Final siguen presentes y con sus datos (desplazadas, no perdidas)', async () => {
        const { ws } = await cargarHoja();
        const headers = ws.getRow(1).values.slice(1);
        expect(headers).toContain('Oficial 1er Lugar');
        expect(headers).toContain('Revisado 1er Lugar');
        expect(headers).toContain('Movimiento a la Rienda');
        // "Club" de la fila 1 sigue correcto bajo su propio encabezado (sin desfase por la inserción).
        expect(ws.getRow(FILA_CON_NOTAS).getCell(2).value).toBe('SAN CARLOS');
    });

    test('CASO M: los filtros (fecha_desde/fecha_hasta/club/asociacion) se siguen aplicando igual que antes', async () => {
        await cargarHoja({ fecha_desde: '2026-09-17', fecha_hasta: '2026-09-20', club: 'SAN' });
        const llamadasRodeos = supabase.from.mock.calls.map(c => c[0]);
        expect(llamadasRodeos).toContain('rodeos');
        // La propia respuesta mock de `rodeos` no cambia con el query (fixture fija), pero confirma
        // que el endpoint no lanza error al recibir filtros y sigue consultando la tabla esperada.
    });

    test('CASO N: un rodeo con 2 jurados no duplica fila ni altera Nota Delegado/Comisión/Total Casos WSP (1 fila por rodeo)', async () => {
        const { ws } = await cargarHoja();
        expect(ws.rowCount).toBe(5); // encabezado + 4 rodeos (nunca 5 por duplicar el de 2 jurados)
        const fila = ws.getRow(FILA_DOS_JURADOS);
        expect(fila.getCell(6).value).toBe('Jurado Uno, Jurado Dos'); // Jurado(s): ambos en 1 sola celda
        expect(fila.getCell(9).value).toBe('SIN INFORMACIÓN');  // Nota Delegado: sin fila en rodeo_notas_secundarias
        expect(fila.getCell(10).value).toBe('SIN INFORMACIÓN'); // Nota Comisión: ídem
        expect(fila.getCell(11).value).toBe(1);                 // Total Casos WSP: valor único de su evaluación
    });

    test('las 3 columnas nuevas usan el mismo estilo de encabezado que el resto (fuente/relleno/alineación/borde)', async () => {
        const { ws } = await cargarHoja();
        const headerRow = ws.getRow(1);
        const refCell = headerRow.getCell(1);   // "Fecha", estilo de referencia ya existente
        for (const col of [9, 10, 11]) {
            const c = headerRow.getCell(col);
            expect(c.font).toEqual(refCell.font);
            expect(c.fill).toEqual(refCell.fill);
            expect(c.alignment).toEqual(refCell.alignment);
            expect(c.border).toEqual(refCell.border);
        }
    });
});
