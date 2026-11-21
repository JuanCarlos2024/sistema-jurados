// Análisis de Casos (listado administrativo): columnas "Resultados
// alterados" y "Comisión", filtros nuevos combinables con los existentes y
// GET /exportar (9 columnas exactas). Supabase en memoria.
const { Writable } = require('stream');
const ExcelJS = require('exceljs');
const { crearSupabaseMemoria, llamarRouter } = require('../../services/__fixtures__/supabaseMemoria');

jest.mock('../../config/supabase', () => ({
    from: (...a) => global.__sb.from(...a),
    rpc: (...a) => global.__sb.rpc(...a)
}));
const router = require('./evaluaciones');

const ev = (id, club, asociacion, fecha, extra = {}) => ({
    id, rodeo_id: 'R-' + id, estado: 'en_proceso', created_at: `2026-11-${10 + Number(id.slice(1))}T00:00:00Z`,
    analista_id: extra.analista ? 'AN-1' : null, nota_final: null, anulada: false, es_historica_importacion: false,
    resultados_alterados: !!extra.alterado,
    rodeo: { id: 'R-' + id, club, fecha, asociacion },
    analista: extra.analista ? { id: 'AN-1', nombre_completo: 'Ana Analista' } : null
});

function datos() {
    return {
        evaluaciones: [
            ev('E1', 'Club Uno', 'Ñuble', '2026-11-01', { alterado: true, analista: true }),     // A pendiente → Pendiente 0/1
            ev('E2', 'Club Dos', 'Maule', '2026-11-02', { alterado: true, analista: true }),     // A resuelta (error) + B pendiente → En revisión 1/2
            ev('E3', 'Club Tres', 'Talca', '2026-11-03', { alterado: false }),                   // B resuelto (acierto) → Revisado 1/1
            ev('E4', 'Club Cuatro', 'Ñuble', '2026-11-04', { alterado: false, analista: true })  // sin revisiones → No derivado
        ],
        evaluacion_revisiones_comision: [
            { id: 'RA1', evaluacion_id: 'E1', estado: 'pendiente' },
            { id: 'RA2', evaluacion_id: 'E2', estado: 'resuelta', decision: 'error' },
            { id: 'RA0', evaluacion_id: 'E4', estado: 'anulada' }
        ],
        evaluacion_casos: [
            { id: 'K2', evaluacion_id: 'E2', tipo_caso: 'interpretativa', estado: 'derivado_comision', decision_analista: 'derivar_comision', anulado: false, ciclo_id: 'X' },
            { id: 'K2b', evaluacion_id: 'E2', tipo_caso: 'interpretativa', estado: 'resuelto', anulado: false, ciclo_id: 'X' },
            { id: 'K2c', evaluacion_id: 'E2', tipo_caso: 'interpretativa', estado: 'resuelto', anulado: false, ciclo_id: 'X' },
            { id: 'K3', evaluacion_id: 'E3', tipo_caso: 'interpretativa', estado: 'resuelto', decision_analista: 'derivar_comision', decision_comision: 'aprueba_apelacion', anulado: false, ciclo_id: 'Y' }
        ],
        asignaciones: [], evaluacion_ciclos: [], evaluacion_respuestas_jurado: [], rodeos: [], administradores: []
    };
}
beforeEach(() => { global.__sb = crearSupabaseMemoria({ tablas: datos() }); });

const listar = (query = {}) => llamarRouter(router, { url: '/', query });
const ids = (r) => r.body.evaluaciones.map(e => e.id).sort();

describe('columnas nuevas', () => {
    test('Resultados alterados (dato real) y Comisión (avance X/Y sin duplicar revisiones)', async () => {
        const r = await listar();
        const por = Object.fromEntries(r.body.evaluaciones.map(e => [e.id, e]));
        expect(por.E1.resultados_alterados).toBe(true);
        expect(por.E3.resultados_alterados).toBe(false);
        expect(por.E1.comision.etiqueta).toBe('Pendiente 0/1');
        expect(por.E2.comision.etiqueta).toBe('En revisión 1/2');   // el caso derivado cuenta una vez; los demás casos no
        expect(por.E3.comision.etiqueta).toBe('Revisado 1/1');
        expect(por.E4.comision.etiqueta).toBe('No derivado');        // la revisión anulada no cuenta
    });
});

describe('filtros nuevos (combinables)', () => {
    test('Resultados alterados Sí / No', async () => {
        expect(ids(await listar({ resultados_alterados: 'si' }))).toEqual(['E1', 'E2']);
        expect(ids(await listar({ resultados_alterados: 'no' }))).toEqual(['E3', 'E4']);
    });
    test('Derivado a Comisión Sí / No', async () => {
        expect(ids(await listar({ derivado_comision: 'si' }))).toEqual(['E1', 'E2', 'E3']);
        expect(ids(await listar({ derivado_comision: 'no' }))).toEqual(['E4']);
    });
    test('Estado Comisión Pendiente / En revisión / Resuelto', async () => {
        expect(ids(await listar({ estado_comision: 'pendiente' }))).toEqual(['E1']);
        expect(ids(await listar({ estado_comision: 'en_revision' }))).toEqual(['E2']);
        expect(ids(await listar({ estado_comision: 'resuelto' }))).toEqual(['E3']);
    });
    test('Resolución Error / Acierto', async () => {
        expect(ids(await listar({ resolucion: 'error' }))).toEqual(['E2']);
        expect(ids(await listar({ resolucion: 'acierto' }))).toEqual(['E3']);
    });
    test('combinados entre sí y con los filtros existentes (analista)', async () => {
        expect(ids(await listar({ resultados_alterados: 'si', estado_comision: 'pendiente' }))).toEqual(['E1']);
        expect(ids(await listar({ derivado_comision: 'no', analista_id: 'AN-1' }))).toEqual(['E4']);
        expect(ids(await listar({ derivado_comision: 'no', estado_comision: 'pendiente' }))).toEqual([]);   // contradictorio → vacío
    });
    test('los filtros nunca escriben', async () => {
        await listar({ resultados_alterados: 'si', derivado_comision: 'si', estado_comision: 'pendiente', resolucion: 'error' });
        expect(global.__sb.calls.filter(c => c.op !== 'select')).toEqual([]);
    });
});

function exportar(query = {}) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const res = new Writable({ write(ch, e, cb) { chunks.push(ch); cb(); } });
        res.headers = {}; res.statusCode = 200;
        res.setHeader = (k, v) => { res.headers[k] = v; };
        res.status = (c) => { res.statusCode = c; return res; };
        res.json = (p) => { res.body = p; resolve(res); return res; };
        const end = res.end.bind(res);
        res.end = (...a) => { end(...a); res.buffer = Buffer.concat(chunks); resolve(res); };
        const req = { method: 'GET', url: '/exportar', originalUrl: '/exportar', query, params: {}, headers: {}, body: {}, usuario: { id: 'A', rol_evaluacion: null }, get() {} };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}
async function hoja(query) {
    const res = await exportar(query);
    expect(res.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer);
    return wb.worksheets[0];
}

describe('Exportar Excel', () => {
    test('exactamente 9 columnas con los encabezados repetidos, en orden', async () => {
        const ws = await hoja();
        expect(ws.getRow(1).values.slice(1)).toEqual(['Club', 'Asociación', 'Fecha', 'Analista', 'Estado', 'Asociación', 'Analista', 'Estado', 'N° de collera']);
        expect(ws.actualColumnCount).toBe(9);
    });

    test('valores: A club, B asociación, C fecha, D analista (vacía si no hay), F repite asociación; E, G, H e I realmente vacías', async () => {
        const ws = await hoja();
        const filas = [];
        ws.eachRow((row, n) => { if (n > 1) filas.push(row); });
        expect(filas).toHaveLength(4);
        const porClub = Object.fromEntries(filas.map(r => [r.getCell(1).value, r]));
        const r1 = porClub['Club Uno'];
        expect([1, 2, 3, 4, 6].map(c => r1.getCell(c).value)).toEqual(['Club Uno', 'Ñuble', '01/11/2026', 'Ana Analista', 'Ñuble']);
        for (const fila of filas) for (const c of [5, 7, 8, 9]) {
            expect(fila.getCell(c).value).toBeNull();
            expect(fila.getCell(c).type).toBe(ExcelJS.ValueType.Null);
        }
        const sinAnalista = porClub['Club Tres'];
        expect(sinAnalista.getCell(4).value).toBeNull();     // ni guion, ni "Sin datos"
    });

    test('respeta los filtros activos y no duplica filas por casos o revisiones', async () => {
        const ws = await hoja({ resultados_alterados: 'si' });
        const clubes = [];
        ws.eachRow((row, n) => { if (n > 1) clubes.push(row.getCell(1).value); });
        expect(clubes.sort()).toEqual(['Club Dos', 'Club Uno']);   // E2 tiene 3 casos y 2 revisiones: una sola fila
    });

    test('nombre de archivo y tipo de contenido', async () => {
        const res = await exportar();
        expect(res.headers['Content-Disposition']).toMatch(/^attachment; filename="analisis_casos_\d{4}-\d{2}-\d{2}\.xlsx"$/);
        expect(res.headers['Content-Type']).toMatch(/spreadsheetml/);
    });
});
