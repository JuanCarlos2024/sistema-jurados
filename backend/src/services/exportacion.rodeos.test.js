// ═════════════════════════════════════════════════════════════════════════
// Test de integración de exportarRodeos() — regresión del bug "el Excel no
// respeta los filtros aplicados en pantalla". A diferencia de
// rodeosListado.test.js (que prueba el filtrado en aislamiento), este test
// genera un Workbook de ExcelJS REAL (no mockeado) y lo vuelve a leer, para
// confirmar que las columnas nuevas "Jurado" / "Estado designación" quedan
// en el archivo con el contenido y el orden correctos — end to end, tal
// como lo abriría un administrador en Excel.
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

describe('exportarRodeos — columnas nuevas Jurado / Estado designación', () => {
    test('orden de columnas: Fecha,Club,Asociación,Tipo Rodeo,Días,Origen,Jurado,Estado designación,Jurados,Total Pagos', async () => {
        respuestas.rodeos = { data: [{ id: 'r1', club: 'LA CELIA', asociacion: 'CUYO', fecha: '2026-09-18', tipo_rodeo_nombre: 'Libre', duracion_dias: 2, origen: 'manual', estado: 'activo' }], error: null };
        respuestas.asignaciones = { data: [], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { headers } = await leerFilas(res);
        expect(headers).toEqual(['Fecha', 'Club', 'Asociación', 'Tipo Rodeo', 'Días', 'Origen', 'Jurado', 'Estado designación', 'Jurados', 'Total Pagos']);
    });

    test('CASO E — rodeo con jurado designado: Jurado=nombre correcto, Estado designación=correcto', async () => {
        respuestas.rodeos = { data: [{ id: 'r1', club: 'LA JUNTA', asociacion: 'AYSÉN', fecha: '2026-09-18', tipo_rodeo_nombre: 'Interasociaciones', duracion_dias: 2, origen: 'manual', estado: 'activo' }], error: null };
        respuestas.asignaciones = {
            data: [{
                rodeo_id: 'r1', usuario_pagado_id: 'u1', tipo_persona: 'jurado',
                pago_base_calculado: 80000, estado_designacion: 'aceptado', nombre_importado: null,
                publicado: true, usuarios_pagados: { nombre_completo: 'JUAN PÉREZ' }
            }],
            error: null
        };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { filas } = await leerFilas(res);
        expect(filas[0][6]).toBe('JUAN PÉREZ');    // Jurado
        expect(filas[0][7]).toBe('Confirmado');    // Estado designación
    });

    test('CASO F — rodeo sin jurado: no rompe la exportación, muestra "Sin jurado"/"—"', async () => {
        respuestas.rodeos = { data: [{ id: 'r1', club: 'SIN JURADO CLUB', asociacion: 'X', fecha: '2026-09-18', tipo_rodeo_nombre: 'Libre', duracion_dias: 1, origen: 'manual', estado: 'activo' }], error: null };
        respuestas.asignaciones = { data: [], error: null };
        const res = crearResFake();
        await expect(exportarRodeos({}, res)).resolves.not.toThrow();
        const { filas } = await leerFilas(res);
        expect(filas[0][6]).toBe('Sin jurado');
        expect(filas[0][7]).toBe('—');
    });

    test('dos jurados en el mismo rodeo -> "NOMBRE1 / NOMBRE2" alineado con sus estados', async () => {
        respuestas.rodeos = { data: [{ id: 'r1', club: 'CLUB', asociacion: 'X', fecha: '2026-09-18', tipo_rodeo_nombre: 'Libre', duracion_dias: 1, origen: 'manual', estado: 'activo' }], error: null };
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
        expect(filas[0][6]).toBe('JUAN PÉREZ / PEDRO GONZÁLEZ');
        expect(filas[0][7]).toBe('Confirmado / Rechazado');
    });

    test('CASO A — con fecha_desde/fecha_hasta, exportarRodeos delega el filtrado a construirQueryRodeosFiltrada (no re-implementa su propia query)', async () => {
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
