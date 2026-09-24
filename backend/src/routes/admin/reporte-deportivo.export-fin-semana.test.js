// Reporte Fin de Semana: GET /export-fin-semana = 14 columnas del Reporte
// Directorio (A:N) + "Obs. Monitor" (O, visible) + "Rodeo ID" (P, oculta).
// Workbook ExcelJS REAL escrito y releído (mismo patrón que
// reporte-deportivo.export-directorio.test.js). Solo fixtures, sin datos reales.
const { Writable } = require('stream');
const ExcelJS = require('exceljs');

jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../services/colleras-completas', () => ({ obtenerCollerasCompletas: jest.fn() }));

const supabase = require('../../config/supabase');
const { obtenerCollerasCompletas } = require('../../services/colleras-completas');
const router = require('./reporte-deportivo');

const ID_SAN_CARLOS = '5e0d7828-ae39-47ad-b8ed-7f955b43f4a0';
const ID_PUCON = 'f5300d3f-6810-471d-8a8b-e0de5672bd78';
const ID_SIN_COMENTARIO = '60842ab4-02ae-4be5-96aa-10bb69dc7d6f';

const COMENTARIO_SAN_CARLOS =
    'Nota manual previa del monitor: buen estado de la pista.\n\n---\n\n' +
    'Rodeo: SAN CARLOS - ÑUBLE; Fecha: 18/09/2026\n' +
    'N° situaciones: 2\n' +
    'Categorías:\n' +
    '- Servicios básicos / logística crítica\n' +
    '- Accidente de jinete\n' +
    'Comentario del monitor: Se informaron dos situaciones durante la jornada.';
const COMENTARIO_PUCON =
    'Rodeo: PUCON - CAUTÍN; Fecha: 19/09/2026\n' +
    'N° situaciones: 0\n' +
    'Categorías:\n' +
    '- Sin situaciones relevantes\n' +
    'Comentario del monitor: Rodeo finalizado sin novedad, según lo informado por el jurado.';

const HEADERS_14 = [
    'Fecha', 'Club', 'Asociación', 'Tipo Rodeo', 'Jurado(s)', 'Resultado Alterado',
    'Descripción de lo observado', 'Total Situaciones', 'Serie Campeones - 2 Vueltas',
    'Caseta Jurado', 'Faltas Disciplinarias/Reglamentarias', 'Ganado Fuera del Peso Reglamentario',
    'Movimiento a la Rienda', 'Acciones Área Deportiva'
];

let respuestas;
let llamadas;
function crearChain(tabla) {
    const chain = {};
    ['select', 'eq', 'neq', 'gte', 'lte', 'ilike', 'or', 'in', 'not', 'is', 'order', 'range', 'limit'].forEach(m => {
        chain[m] = (...args) => { llamadas.push({ tabla, m, args }); return chain; };
    });
    chain.then = (resolve, reject) => Promise.resolve(respuestas[tabla] || { data: [], error: null, count: 0 }).then(resolve, reject);
    return chain;
}

beforeEach(() => {
    llamadas = [];
    respuestas = {
        rodeos: {
            data: [
                { id: ID_SAN_CARLOS, club: 'SAN CARLOS', asociacion: 'ÑUBLE', fecha: '2026-09-18', tipo_rodeo_nombre: 'Provincial', categoria_rodeo_nombre: 'A', observacion: '' },
                { id: ID_PUCON, club: 'PUCON', asociacion: 'CAUTÍN', fecha: '2026-09-19', tipo_rodeo_nombre: 'Provincial', categoria_rodeo_nombre: 'A', observacion: '' },
                { id: ID_SIN_COMENTARIO, club: 'LA CELIA', asociacion: 'MAULE', fecha: '2026-09-19', tipo_rodeo_nombre: 'Provincial', categoria_rodeo_nombre: 'A', observacion: '' }
            ],
            error: null, count: 3
        },
        evaluaciones: { data: [], error: null },
        datos_monitor_rodeo: {
            data: [
                { rodeo_id: ID_SAN_CARLOS, puntaje_oficial_1er: '10', puntaje_oficial_2do: null, puntaje_oficial_3er: null, comentario_monitor: COMENTARIO_SAN_CARLOS },
                { rodeo_id: ID_PUCON, puntaje_oficial_1er: null, puntaje_oficial_2do: null, puntaje_oficial_3er: null, comentario_monitor: COMENTARIO_PUCON },
                { rodeo_id: ID_SIN_COMENTARIO, puntaje_oficial_1er: null, puntaje_oficial_2do: null, puntaje_oficial_3er: null, comentario_monitor: null }
            ],
            error: null
        },
        asignaciones: { data: [], error: null },
        cartillas_jurado: { data: [], error: null }
    };
    supabase.from.mockReset();
    supabase.from.mockImplementation(tabla => crearChain(tabla));
    obtenerCollerasCompletas.mockReset();
    obtenerCollerasCompletas.mockResolvedValue({
        filas: [{ caballo1: 'A', caballo2: 'B', sexoCriadero: 'M', ptj: 1, r: 1, c: 1, jinetes: 'X', zona: 'Sur', asociacion: 'ÑUBLE', zonaClasif: 'S' }],
        resumen: { totalCompletas: 1, zonaNorte: 0, centroNorte: 0, zonaCentro: 0, centroSur: 0, zonaSur: 1 }
    });
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

function llamar(ruta, query = {}) {
    return new Promise((resolve, reject) => {
        const req = { method: 'GET', url: ruta, originalUrl: ruta, query, params: {}, headers: {}, usuario: { id: 'admin-test' }, get() { return undefined; } };
        const res = crearResFake();
        const originalEnd = res.end.bind(res);
        res.end = (...args) => { originalEnd(...args); resolve(res); };
        const jsonOriginal = res.json;
        res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}

async function cargarHoja1(ruta, nombreHoja, query) {
    const res = await llamar(ruta, query);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.getBuffer());
    return { res, wb, ws1: wb.getWorksheet(nombreHoja) };
}

describe('GET /export-fin-semana', () => {
    test('A-G: 16 columnas; A:N iguales al Directorio; O = Obs. Monitor visible; P = Rodeo ID oculta con UUID exacto', async () => {
        const { res, ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        expect(res.statusCode).toBe(200);
        expect(res.headers['Content-Disposition']).toMatch(/^attachment; filename="reporte_fin_semana_\d{4}-\d{2}-\d{2}\.xlsx"$/);
        expect(ws1).toBeDefined();

        const headers = ws1.getRow(1).values.slice(1);
        expect(headers.length).toBe(16);
        expect(headers.slice(0, 14)).toEqual(HEADERS_14);
        expect(headers[14]).toBe('Obs. Monitor');
        expect(headers[15]).toBe('Rodeo ID');

        expect(ws1.getColumn(15).hidden).toBeFalsy();
        expect(ws1.getColumn(16).hidden).toBe(true);

        const fila = ws1.getRow(2).values.slice(1);
        expect(fila[15]).toBe(ID_SAN_CARLOS);
        expect(fila[1]).toBe('SAN CARLOS');
    });

    test('H/J/18: San Carlos exporta el comentario COMPLETO con saltos de línea (manual previo + bloque CG)', async () => {
        const { ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        const obs = ws1.getRow(2).values.slice(1)[14];
        expect(obs).toBe(COMENTARIO_SAN_CARLOS);
        expect(obs.split('\n').length).toBe(COMENTARIO_SAN_CARLOS.split('\n').length);
    });

    test('18/19: Pucón con 0 situaciones exporta su comentario completo (no depende de control_gestion_situaciones)', async () => {
        const { ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        expect(ws1.getRow(3).values.slice(1)[14]).toBe(COMENTARIO_PUCON);
        expect(supabase.from.mock.calls.map(c => c[0])).not.toContain('control_gestion_situaciones');
    });

    test('I: comentario_monitor NULL, vacío o solo espacios → celda vacía (sin placeholders)', async () => {
        respuestas.datos_monitor_rodeo.data.push();
        respuestas.datos_monitor_rodeo.data[1].comentario_monitor = '';
        respuestas.datos_monitor_rodeo.data[2].comentario_monitor = '   ';
        const { ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        for (const n of [3, 4]) {
            const v = ws1.getRow(n).getCell(15).value;
            expect(v === null || v === undefined || v === '').toBe(true);
        }
        // sin fila en datos_monitor_rodeo tampoco
        respuestas.datos_monitor_rodeo.data = [];
        const { ws1: ws } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        const v = ws.getRow(2).getCell(15).value;
        expect(v === null || v === undefined || v === '').toBe(true);
    });

    test('K: Obs. Monitor con wrapText y alineación superior; altura crece con el contenido', async () => {
        const { ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        const c = ws1.getRow(2).getCell(15);
        expect(c.alignment.wrapText).toBe(true);
        expect(c.alignment.vertical).toBe('top');
        expect(ws1.getRow(2).height).toBeGreaterThan(28);
        expect(ws1.getColumn(15).width).toBeGreaterThanOrEqual(50);
    });

    test('L: autoFilter cubre A:O (columnas visibles), sin la P oculta', async () => {
        const { ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        expect(ws1.autoFilter).toBe('A1:O1');
    });

    test('estilos: fila alterada recibe fill también en Obs. Monitor, con rojo/negrita en Resultado Alterado', async () => {
        respuestas.evaluaciones.data = [{ id: 'ev1', rodeo_id: ID_SAN_CARLOS, estado: 'cerrada', resultados_alterados: true, comentario_resultados_alterados: 'x', modo_flujo: null }];
        const { ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        const fila = ws1.getRow(2);
        expect(fila.getCell(15).fill.fgColor.argb).toBe('FFFDEBD0');
        expect(fila.getCell(6).font.bold).toBe(true);
        expect(fila.getCell(6).font.color.argb).toBe('FFC0392B');
    });

    test('M: Hoja 2 "Colleras completas" presente con estructura del Directorio', async () => {
        const { wb } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        const ws2 = wb.getWorksheet('Colleras completas');
        expect(ws2).toBeDefined();
        expect(ws2.getCell(1, 1).value).toBe('1 COLLERAS COMPLETAS AL ' + ws2.getCell(1, 1).value.split(' AL ')[1]);
        expect(ws2.getCell(8, 1).value).toBe('CABALLO 1');
        expect(ws2.getCell(8, 10).value).toBe('ZONA CLASIF.');
        expect(ws2.getCell(9, 1).value).toBe('A');
        // Obs. Monitor NO se agrega a la Hoja 2
        expect(ws2.getRow(8).values.slice(1).length).toBe(10);
    });

    test('502 sin generar archivo si falla la fuente de Colleras Completas', async () => {
        obtenerCollerasCompletas.mockRejectedValueOnce(new Error('caída'));
        const res = await llamar('/export-fin-semana');
        expect(res.statusCode).toBe(502);
        expect(res.getBuffer().length).toBe(0);
    });

    test('N: respeta los mismos filtros que el Directorio (mismo conjunto de rodeos y mismas llamadas de filtro)', async () => {
        const query = { fecha_desde: '2026-09-17', fecha_hasta: '2026-09-20', asociacion: 'ÑUBLE', club: 'SAN' };

        llamadas = [];
        await llamar('/export-directorio', query);
        const filtrosDir = llamadas.filter(c => c.tabla === 'rodeos' && ['gte', 'lte', 'ilike', 'eq', 'in'].includes(c.m));

        llamadas = [];
        await llamar('/export-fin-semana', query);
        const filtrosFin = llamadas.filter(c => c.tabla === 'rodeos' && ['gte', 'lte', 'ilike', 'eq', 'in'].includes(c.m));

        expect(filtrosFin).toEqual(filtrosDir);
        expect(filtrosFin.map(c => c.m)).toEqual(expect.arrayContaining(['gte', 'lte', 'ilike']));

        const dir = await cargarHoja1('/export-directorio', 'Reporte Deportivo', query);
        const fin = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana', query);
        const idsDir = dir.ws1.getColumn(15).values.slice(2);
        const idsFin = fin.ws1.getColumn(16).values.slice(2);
        expect(idsFin).toEqual(idsDir);
    });

    test('O: /export-directorio no cambia (15 columnas, sin Obs. Monitor, autoFilter A1:N1, hoja "Reporte Deportivo")', async () => {
        const { res, wb, ws1 } = await cargarHoja1('/export-directorio', 'Reporte Deportivo');
        expect(res.headers['Content-Disposition']).toMatch(/reporte_directorio_/);
        const headers = ws1.getRow(1).values.slice(1);
        expect(headers.length).toBe(15);
        expect(headers.slice(0, 14)).toEqual(HEADERS_14);
        expect(headers[14]).toBe('Rodeo ID');
        expect(headers).not.toContain('Obs. Monitor');
        expect(ws1.getColumn(15).hidden).toBe(true);
        expect(ws1.autoFilter).toBe('A1:N1');
        expect(wb.getWorksheet('Reporte Fin de Semana')).toBeUndefined();
        expect(wb.getWorksheet('Colleras completas')).toBeDefined();
    });
});
