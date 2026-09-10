// ═════════════════════════════════════════════════════════════════════════
// Test de integración de exportarRodeos() — regresión del bug "el Excel no
// respeta los filtros aplicados en pantalla" + mejora "Cartilla Jurado /
// Cartilla Delegado / Video + quitar Origen". Genera un Workbook de ExcelJS
// REAL (no mockeado) y lo vuelve a leer, para confirmar que las columnas
// quedan en el archivo con el contenido y el orden correctos — end to end,
// tal como lo abriría un administrador en Excel.
// ═════════════════════════════════════════════════════════════════════════
const { Writable } = require('stream');
const ExcelJS = require('exceljs');

jest.mock('../config/supabase', () => ({ from: jest.fn() }));
const supabase = require('../config/supabase');
const { exportarRodeos } = require('./exportacion');

let respuestas;
function crearChain(tabla) {
    const chain = {};
    const metodos = ['select', 'eq', 'neq', 'gte', 'lte', 'ilike', 'or', 'in', 'not', 'is', 'order', 'range'];
    metodos.forEach(m => { chain[m] = () => chain; });
    chain.then = (resolve, reject) => Promise.resolve(respuestas[tabla] || { data: [], error: null, count: 0 }).then(resolve, reject);
    return chain;
}

beforeEach(() => {
    respuestas = { rodeos: { data: [], error: null } };
    supabase.from.mockReset();
    supabase.from.mockImplementation(tabla => crearChain(tabla));
});

// Simula un `res` de Express lo suficiente para exportarRodeos(): setHeader()
// + ser un stream escribible donde ExcelJS vuelca el .xlsx binario.
function crearResFake() {
    const chunks = [];
    const sink = new Writable({
        write(chunk, enc, cb) { chunks.push(chunk); cb(); }
    });
    sink.headers = {};
    sink.setHeader = (k, v) => { sink.headers[k] = v; };
    sink.getBuffer = () => Buffer.concat(chunks);
    return sink;
}

async function leerFilas(res) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.getBuffer());
    const ws = wb.getWorksheet('Rodeos');
    const headers = ws.getRow(1).values.slice(1); // ExcelJS values[0] es undefined
    const filas = [];
    for (let i = 2; i <= ws.rowCount; i++) filas.push(ws.getRow(i).values.slice(1));
    return { headers, filas };
}

// Índices de columna (0-based) sobre el nuevo orden:
// Fecha,Club,Asociación,Tipo Rodeo,Días,Jurado,Estado designación,Jurados,
// Cartilla Jurado,Cartilla Delegado,Video,Total Pagos
const COL = { FECHA: 0, CLUB: 1, ASOC: 2, TIPO: 3, DIAS: 4, JURADO: 5, ESTADO_DES: 6, JURADOS: 7, CJ: 8, CD: 9, VIDEO: 10, TOTAL: 11 };

const RODEO_BASE = { id: 'r1', club: 'CLUB', asociacion: 'X', fecha: '2026-09-18', tipo_rodeo_nombre: 'Libre', duracion_dias: 1, origen: 'manual', estado: 'activo' };

describe('exportarRodeos — columnas (Jurado/Estado designación ya existentes + Cartillas/Video nuevas, Origen eliminado)', () => {
    test('orden de columnas final: Fecha,Club,Asociación,Tipo Rodeo,Días,Jurado,Estado designación,Jurados,Cartilla Jurado,Cartilla Delegado,Video,Total Pagos', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { headers } = await leerFilas(res);
        expect(headers).toEqual([
            'Fecha', 'Club', 'Asociación', 'Tipo Rodeo', 'Días',
            'Jurado', 'Estado designación', 'Jurados',
            'Cartilla Jurado', 'Cartilla Delegado', 'Video', 'Total Pagos'
        ]);
    });

    test('CASO 4 del pedido — "Origen" NO existe en absoluto en el Excel', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { headers } = await leerFilas(res);
        expect(headers).not.toContain('Origen');
        expect(headers.some(h => /origen/i.test(h || ''))).toBe(false);
    });

    test('CASO 1 del pedido — CJ ✓ CD ✓ VV ✓ -> Cartilla Jurado=Sí, Cartilla Delegado=Sí, Video=Sí', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        respuestas.rodeo_adjuntos = { data: [
            { rodeo_id: 'r1', tipo_adjunto: 'cartilla_jurado' },
            { rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado' }
        ], error: null };
        respuestas.rodeo_links = { data: [{ rodeo_id: 'r1' }], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { filas } = await leerFilas(res);
        expect(filas[0][COL.CJ]).toBe('Sí');
        expect(filas[0][COL.CD]).toBe('Sí');
        expect(filas[0][COL.VIDEO]).toBe('Sí');
    });

    test('CASO 2 del pedido — CJ ✓ CD ✓ VV sin check -> Video=No', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        respuestas.rodeo_adjuntos = { data: [
            { rodeo_id: 'r1', tipo_adjunto: 'cartilla_jurado' },
            { rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado' }
        ], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { filas } = await leerFilas(res);
        expect(filas[0][COL.CJ]).toBe('Sí');
        expect(filas[0][COL.CD]).toBe('Sí');
        expect(filas[0][COL.VIDEO]).toBe('No');
    });

    test('CASO 3 del pedido — sin cartillas ni video -> los 3 en "No"', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        respuestas.rodeo_adjuntos = { data: [], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { filas } = await leerFilas(res);
        expect(filas[0][COL.CJ]).toBe('No');
        expect(filas[0][COL.CD]).toBe('No');
        expect(filas[0][COL.VIDEO]).toBe('No');
    });

    test('tipo_adjunto legacy "cartilla" (sin sufijo) también cuenta como Cartilla Jurado=Sí — mismo criterio que la pantalla', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        respuestas.rodeo_adjuntos = { data: [{ rodeo_id: 'r1', tipo_adjunto: 'cartilla' }], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { filas } = await leerFilas(res);
        expect(filas[0][COL.CJ]).toBe('Sí');
    });

    test('CASO 6 del pedido — Total Pagos, Jurados y Estado designación se mantienen correctos junto a las columnas nuevas', async () => {
        respuestas.rodeos = { data: [{ ...RODEO_BASE, id: 'r1', club: 'EL VALLE DE RAUCO', asociacion: 'CURICÓ' }], error: null };
        respuestas.asignaciones = {
            data: [{
                rodeo_id: 'r1', usuario_pagado_id: 'u1', tipo_persona: 'jurado',
                pago_base_calculado: 490000, estado_designacion: 'aceptado', nombre_importado: null,
                publicado: true, usuarios_pagados: { nombre_completo: 'JORGE PATRICIO MORALES GONZALEZ' }
            }],
            error: null
        };
        respuestas.rodeo_adjuntos = { data: [
            { rodeo_id: 'r1', tipo_adjunto: 'cartilla_jurado' },
            { rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado' }
        ], error: null };
        respuestas.rodeo_links = { data: [{ rodeo_id: 'r1' }], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { filas } = await leerFilas(res);
        expect(filas[0][COL.JURADO]).toBe('JORGE PATRICIO MORALES GONZALEZ');
        expect(filas[0][COL.ESTADO_DES]).toBe('Confirmado');
        expect(filas[0][COL.JURADOS]).toBe(1);
        expect(filas[0][COL.CJ]).toBe('Sí');
        expect(filas[0][COL.CD]).toBe('Sí');
        expect(filas[0][COL.VIDEO]).toBe('Sí');
        expect(filas[0][COL.TOTAL]).toBe('$490.000');
    });

    test('CASO F (ronda anterior) — rodeo sin jurado: no rompe la exportación, muestra "Sin jurado"/"—"', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        respuestas.asignaciones = { data: [], error: null };
        const res = crearResFake();
        await expect(exportarRodeos({}, res)).resolves.not.toThrow();
        const { filas } = await leerFilas(res);
        expect(filas[0][COL.JURADO]).toBe('Sin jurado');
        expect(filas[0][COL.ESTADO_DES]).toBe('—');
    });

    test('dos jurados en el mismo rodeo -> "NOMBRE1 / NOMBRE2" alineado con sus estados', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        respuestas.asignaciones = {
            data: [
                { rodeo_id: 'r1', usuario_pagado_id: 'u1', tipo_persona: 'jurado', pago_base_calculado: 40000, estado_designacion: 'aceptado', nombre_importado: null, publicado: true, usuarios_pagados: { nombre_completo: 'JUAN PÉREZ' } },
                { rodeo_id: 'r1', usuario_pagado_id: 'u2', tipo_persona: 'jurado', pago_base_calculado: 40000, estado_designacion: 'rechazado', nombre_importado: null, publicado: true, usuarios_pagados: { nombre_completo: 'PEDRO GONZÁLEZ' } }
            ],
            error: null
        };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { filas } = await leerFilas(res);
        expect(filas[0][COL.JURADO]).toBe('JUAN PÉREZ / PEDRO GONZÁLEZ');
        expect(filas[0][COL.ESTADO_DES]).toBe('Confirmado / Rechazado');
    });

    test('CASO 5 del pedido — con fecha_desde/fecha_hasta, exportarRodeos sigue delegando el filtrado a construirQueryRodeosFiltrada (no re-implementa su propia query)', async () => {
        let gteVisto = null, lteVisto = null;
        const chainRodeos = {};
        ['select','eq','neq','ilike','or','in','not','is','order','range'].forEach(m => { chainRodeos[m] = () => chainRodeos; });
        chainRodeos.gte = (col, val) => { if (col === 'fecha') gteVisto = val; return chainRodeos; };
        chainRodeos.lte = (col, val) => { if (col === 'fecha') lteVisto = val; return chainRodeos; };
        chainRodeos.then = (resolve) => resolve({ data: [], error: null });
        supabase.from.mockImplementation(tabla => tabla === 'rodeos' ? chainRodeos : crearChain(tabla));

        const res = crearResFake();
        await exportarRodeos({ fecha_desde: '2026-09-17', fecha_hasta: '2026-09-20' }, res);
        expect(gteVisto).toBe('2026-09-17');
        expect(lteVisto).toBe('2026-09-20');
    });
});
