// FASE 2.6 — Comparativa "Colleras completas" (temporada actual vs anterior) en el Reporte Fin de Semana.
// Workbook ExcelJS REAL escrito y releído. Solo fixtures/mocks, sin datos reales. El Reporte Directorio
// (mismo módulo, código NO tocado) debe quedar exactamente igual.
//
// Sin fake timers: usar jest.useFakeTimers() rompe el escritor de streams/zip de ExcelJS (zip corrupto) y
// cuelga zlib.deflateSync en otras partes del código. En su lugar, las fechas esperadas se calculan con el
// MISMO motor de fechas equivalentes (fechasEquivalentes.js) a partir de la fecha real de ejecución, para
// que el test no dependa de qué día corre la suite.
const { Writable } = require('stream');
const ExcelJS = require('exceljs');
const F = require('../../services/informeGestion/fechasEquivalentes');

jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../services/colleras-completas', () => ({ obtenerCollerasCompletas: jest.fn() }));

const supabase = require('../../config/supabase');
const { obtenerCollerasCompletas } = require('../../services/colleras-completas');
const router = require('./reporte-deportivo');

const fmtFecha = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const HOY = F.hoyChile(new Date());
const FECHA_OBJETIVO_HIST = F.desplazarFechaEquivalente(HOY, 1);   // fecha equivalente en la temporada anterior

let respuestas, llamadas;
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
        rodeos: { data: [], error: null, count: 0 },
        evaluaciones: { data: [], error: null },
        datos_monitor_rodeo: { data: [], error: null },
        asignaciones: { data: [], error: null },
        cartillas_jurado: { data: [], error: null },
        temporadas: { data: [{ id: 'T1', nombre: '2026-2027', fecha_inicio: '2026-04-01', fecha_fin: '2027-03-31', activa: true }], error: null },
        historico_colleras_medicion: {
            data: [
                { temporada: '2025-2026', fecha_medicion: F.addDays(FECHA_OBJETIVO_HIST, -14), total_colleras: 20, fecha_confirmada: true },
                { temporada: '2025-2026', fecha_medicion: F.addDays(FECHA_OBJETIVO_HIST, -7), total_colleras: 28, fecha_confirmada: true },
                { temporada: '2025-2026', fecha_medicion: FECHA_OBJETIVO_HIST, total_colleras: 34, fecha_confirmada: true },
                // Otra temporada, mucho más antigua: NO debe aparecer en la comparativa (solo actual vs 2025-2026)
                { temporada: '2000-2001', fecha_medicion: F.addDays(FECHA_OBJETIVO_HIST, -14), total_colleras: 999, fecha_confirmada: true }
            ], error: null
        },
        colleras_completas_snapshots: {
            data: [
                { fecha_snapshot: F.addDays(HOY, -18) + 'T15:00:00Z', total_colleras: 25 },
                { fecha_snapshot: F.addDays(HOY, -10) + 'T15:00:00Z', total_colleras: 33 }
            ], error: null
        }
    };
    supabase.from.mockReset();
    supabase.from.mockImplementation(tabla => crearChain(tabla));
    obtenerCollerasCompletas.mockReset();
    obtenerCollerasCompletas.mockResolvedValue({
        filas: [{ caballo1: 'A', caballo2: 'B', sexoCriadero: 'M', ptj: 1, r: 1, c: 1, jinetes: 'X', zona: 'Sur', asociacion: 'ÑUBLE', zonaClasif: 'S' }],
        resumen: { totalCompletas: 41, zonaNorte: 5, centroNorte: 2, zonaCentro: 10, centroSur: 3, zonaSur: 26 }
    });
});

function crearResFake() {
    const chunks = [];
    const sink = new Writable({ write(chunk, enc, cb) { chunks.push(chunk); cb(); } });
    sink.headers = {}; sink.statusCode = 200;
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
async function cargar(ruta, nombreHoja, query) {
    const res = await llamar(ruta, query);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.getBuffer());
    return { res, wb, ws: nombreHoja ? wb.getWorksheet(nombreHoja) : null };
}
function buscarFilaConValor(ws, col, valor, maxFila = 80) {
    for (let r = 1; r <= maxFila; r++) if (ws.getCell(r, col).value === valor) return r;
    return -1;
}
function textoCompletoHoja(ws) {
    const partes = [];
    ws.eachRow(row => row.eachCell({ includeEmpty: false }, cell => { if (typeof cell.value === 'string') partes.push(cell.value); }));
    return partes.join(' | ');
}

describe('FASE 2.6 — bloque comparativo numérico', () => {
    test('B/D: aparece ANTES de la tabla detalle, con temporada actual, anterior, diferencia y variación', async () => {
        const { wb } = await cargar('/export-fin-semana', 'Colleras completas');
        const ws2 = wb.getWorksheet('Colleras completas');
        const filaComp = buscarFilaConValor(ws2, 1, `COMPARATIVA COLLERAS COMPLETAS AL ${fmtFecha(HOY)}`);
        expect(filaComp).toBeGreaterThan(0);
        expect(ws2.getCell(filaComp + 1, 1).value).toBe('Temporada actual (2026-2027):');
        expect(ws2.getCell(filaComp + 1, 2).value).toBe(41);
        expect(ws2.getCell(filaComp + 2, 1).value).toBe('Temporada anterior (2025-2026, fecha equivalente):');
        expect(ws2.getCell(filaComp + 2, 2).value).toBe(34);   // medición exactamente en la fecha equivalente
        expect(ws2.getCell(filaComp + 3, 1).value).toBe('Diferencia:');
        expect(ws2.getCell(filaComp + 3, 2).value).toBe('+7');
        expect(ws2.getCell(filaComp + 4, 1).value).toBe('Variación:');
        expect(ws2.getCell(filaComp + 4, 2).value).toBe('+20.6%');

        const filaHeaderTabla = buscarFilaConValor(ws2, 1, 'CABALLO 1');
        expect(filaHeaderTabla).toBeGreaterThan(filaComp + 4);   // el bloque queda antes de la tabla
    });

    test('G: solo se comparan 2 temporadas (2026-2027 y 2025-2026); temporadas más antiguas no aparecen en ningún lado de la hoja', async () => {
        const { ws } = await cargar('/export-fin-semana', 'Colleras completas');
        const texto = textoCompletoHoja(ws);
        expect(texto).toContain('2026-2027');
        expect(texto).toContain('2025-2026');
        expect(texto).not.toContain('2000-2001');
        expect(texto).not.toContain('999');   // el valor de la temporada excluida tampoco se filtra
    });

    test('C/H: se incrusta una imagen (PNG) con el gráfico, antes de la tabla', async () => {
        const { wb } = await cargar('/export-fin-semana', 'Colleras completas');
        const ws2 = wb.getWorksheet('Colleras completas');
        const imgs = ws2.getImages();
        expect(imgs.length).toBe(1);
        const media = wb.model.media[imgs[0].imageId];
        expect(media.type).toBe('image');
        expect(media.extension).toBe('png');
        expect(media.buffer.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);   // firma PNG válida

        const filaHeaderTabla = buscarFilaConValor(ws2, 1, 'CABALLO 1');
        expect(imgs[0].range.tl.row).toBeLessThan(filaHeaderTabla - 1);   // ancla antes de la tabla (0-based)
    });

    test('sin histórico ni snapshots (solo el dato en vivo de hoy): "sin dato histórico comparable", igual dibuja la serie actual, no revienta', async () => {
        respuestas.historico_colleras_medicion = { data: [], error: null };
        respuestas.colleras_completas_snapshots = { data: [], error: null };
        const { res, ws } = await cargar('/export-fin-semana', 'Colleras completas');
        expect(res.statusCode).toBe(200);
        const texto = textoCompletoHoja(ws);
        expect(texto).toContain('Sin dato histórico comparable');
        expect(ws.getImages().length).toBe(1);   // igual grafica la serie actual (1 punto: el dato en vivo de hoy)
        const filaHeaderTabla = buscarFilaConValor(ws, 1, 'CABALLO 1');
        expect(filaHeaderTabla).toBeGreaterThan(0);
        expect(ws.getCell(filaHeaderTabla + 1, 1).value).toBe('A');
    });

    test('I/J: sin ningún dato (ni actual, ni histórico, ni snapshots): aviso controlado, 200, tabla detalle intacta', async () => {
        obtenerCollerasCompletas.mockResolvedValue({
            filas: [{ caballo1: 'A', caballo2: 'B', sexoCriadero: 'M', ptj: 1, r: 1, c: 1, jinetes: 'X', zona: 'Sur', asociacion: 'ÑUBLE', zonaClasif: 'S' }],
            resumen: { totalCompletas: null, zonaNorte: null, centroNorte: null, zonaCentro: null, centroSur: null, zonaSur: null }
        });
        respuestas.historico_colleras_medicion = { data: [], error: null };
        respuestas.colleras_completas_snapshots = { data: [], error: null };
        const { res, ws } = await cargar('/export-fin-semana', 'Colleras completas');
        expect(res.statusCode).toBe(200);
        const texto = textoCompletoHoja(ws);
        expect(texto).toMatch(/Sin datos suficientes para graficar/);
        expect(ws.getImages().length).toBe(0);
        const filaHeaderTabla = buscarFilaConValor(ws, 1, 'CABALLO 1');
        expect(filaHeaderTabla).toBeGreaterThan(0);
        expect(ws.getCell(filaHeaderTabla + 1, 1).value).toBe('A');
    });

    test('sin temporada resuelta (tabla temporadas vacía): no revienta, bloque queda con "—" y sin gráfico', async () => {
        respuestas.temporadas = { data: [], error: null };
        const { res, ws } = await cargar('/export-fin-semana', 'Colleras completas');
        expect(res.statusCode).toBe(200);
        const texto = textoCompletoHoja(ws);
        expect(texto).toMatch(/Sin datos suficientes para graficar/);
        const filaHeaderTabla = buscarFilaConValor(ws, 1, 'CABALLO 1');
        expect(filaHeaderTabla).toBeGreaterThan(0);
    });

    test('la tabla "historico_colleras_medicion" inexistente (error de BD) no rompe el reporte (leerOpcional)', async () => {
        respuestas.historico_colleras_medicion = { data: null, error: { message: 'relation "historico_colleras_medicion" does not exist' } };
        const { res, ws } = await cargar('/export-fin-semana', 'Colleras completas');
        expect(res.statusCode).toBe(200);
        expect(buscarFilaConValor(ws, 1, 'CABALLO 1')).toBeGreaterThan(0);
    });

    test('el archivo generado no queda corrupto: se reabre sin lanzar y conserva la Hoja 1', async () => {
        const { wb } = await cargar('/export-fin-semana', 'Reporte Fin de Semana');
        expect(wb.getWorksheet('Reporte Fin de Semana')).toBeDefined();
        expect(wb.getWorksheet('Colleras completas')).toBeDefined();
    });
});

describe('FASE 2.6 — el Reporte Directorio NO cambia (mismo código, no tocado)', () => {
    test('A: /export-directorio no agrega el bloque comparativo ni ninguna imagen; header de la tabla sigue en la fila 8', async () => {
        const { res, wb } = await cargar('/export-directorio', 'Reporte Deportivo');
        expect(res.statusCode).toBe(200);
        const ws2 = wb.getWorksheet('Colleras completas');
        expect(ws2).toBeDefined();
        expect(ws2.getImages().length).toBe(0);
        expect(wb.model.media.length).toBe(0);
        expect(ws2.getCell(8, 1).value).toBe('CABALLO 1');    // posición original, sin cambios
        expect(ws2.getCell(9, 1).value).toBe('A');
        const texto = textoCompletoHoja(ws2);
        expect(texto).not.toMatch(/COMPARATIVA COLLERAS COMPLETAS/);
        expect(texto).not.toMatch(/Temporada actual/);
        // El Directorio no debería siquiera consultar las tablas nuevas de la comparativa
        expect(llamadas.some(c => c.tabla === 'historico_colleras_medicion')).toBe(false);
        expect(llamadas.some(c => c.tabla === 'colleras_completas_snapshots')).toBe(false);
    });
});
