// ═════════════════════════════════════════════════════════════════════════
// Tests de ORQUESTACIÓN DE RUTA — dashboard.js, endpoints de Matriz de
// Participación (/salidas-matriz y /salidas-matriz/excel). Ambos delegan en
// services/matrizParticipacion.js (ya cubierto exhaustivamente en su propio
// archivo de tests) — acá solo importa que la ruta conecte bien los query
// params y que el archivo Excel se genere con las columnas nuevas.
//
// El endpoint Excel arma un .xlsx REAL con ExcelJS y lo escribe sobre un
// stream Writable en memoria (mismo patrón que exportacion.rodeos.test.js)
// — se vuelve a leer con ExcelJS para confirmar encabezados y contenido.
// ═════════════════════════════════════════════════════════════════════════
const { Writable } = require('stream');
const ExcelJS = require('exceljs');

jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
const supabase = require('../../config/supabase');
const router = require('./dashboard');

// ─── Fixture — 1 rodeo con 2 jurados (Juan, Pedro), comparten Comisión/Delegado ──
const ASIGS = [
    { id: 'asig-juan', usuario_pagado_id: 'juan', tipo_persona: 'jurado', estado_designacion: 'aceptado',
      rodeos: { id: 'r1', fecha: '2026-04-10', club: 'Club R1', asociacion: 'Aso R1', tipo_rodeo_nombre: 'Provincial' } },
    { id: 'asig-pedro', usuario_pagado_id: 'pedro', tipo_persona: 'jurado', estado_designacion: 'aceptado',
      rodeos: { id: 'r1', fecha: '2026-04-10', club: 'Club R1', asociacion: 'Aso R1', tipo_rodeo_nombre: 'Provincial' } }
];
const USUARIOS = [
    { id: 'juan',  nombre_completo: 'JUAN PÉREZ', rut: '11.111.111-1', categoria: 'B', tipo_persona: 'jurado' },
    { id: 'pedro', nombre_completo: 'PEDRO SOTO', rut: '22.222.222-2', categoria: 'B', tipo_persona: 'jurado' }
];
const NOTAS_CASOS = [{ asignacion_id: 'asig-juan', nota: 6.3 }, { asignacion_id: 'asig-pedro', nota: 5.5 }];
const NOTAS_SEC = [{ rodeo_id: 'r1', nota_comision: 5.9, nota_delegado: 6.1 }];

function mockSupabaseSecuencial(respuestas) {
    let i = 0;
    supabase.from.mockImplementation(() => {
        const data = respuestas[i++] ?? [];
        const chain = {
            select: () => chain, eq: () => chain, gte: () => chain, lte: () => chain, in: () => chain,
            then: (resolve) => Promise.resolve({ data, error: null }).then(resolve)
        };
        return chain;
    });
}

function llamarRutaJson({ query }) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'GET', url: '/salidas-matriz', originalUrl: '/salidas-matriz',
            body: {}, query: query || {}, params: {}, headers: {},
            ip: '127.0.0.1',
            usuario: { id: 'admin-test', tipo_persona: 'administrador' },
            get() { return undefined; }
        };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(payload) { resolve({ status: this.statusCode, body: payload }); return this; }
        };
        router(req, res, (err) => { if (err) reject(err); else resolve({ status: 404, body: { error: 'no encontrada' } }); });
    });
}

// Simula un `res` de Express: setHeader() + stream escribible donde ExcelJS
// vuelca el .xlsx binario — mismo patrón que exportacion.rodeos.test.js.
function crearResFakeExcel() {
    const chunks = [];
    const sink = new Writable({ write(chunk, enc, cb) { chunks.push(chunk); cb(); } });
    sink.headers = {};
    sink.headersSent = false;
    sink.setHeader = (k, v) => { sink.headers[k] = v; };
    sink.getBuffer = () => Buffer.concat(chunks);
    return sink;
}

function llamarRutaExcel({ query }) {
    return new Promise((resolve, reject) => {
        const res = crearResFakeExcel();
        const req = {
            method: 'GET', url: '/salidas-matriz/excel', originalUrl: '/salidas-matriz/excel',
            body: {}, query: query || {}, params: {}, headers: {},
            ip: '127.0.0.1',
            usuario: { id: 'admin-test', tipo_persona: 'administrador' },
            get() { return undefined; }
        };
        const origEnd = res.end.bind(res);
        res.end = (...args) => { origEnd(...args); resolve(res); };
        router(req, res, (err) => { if (err) reject(err); });
    });
}

async function leerExcel(res) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.getBuffer());
    const ws = wb.getWorksheet('Matriz Salidas');
    const headers = ws.getRow(1).values.slice(1);
    const filas = [];
    for (let i = 2; i <= ws.rowCount; i++) {
        const v = ws.getRow(i).values.slice(1);
        if (v.some(x => x !== undefined && x !== null && x !== '')) filas.push(v);
    }
    return { headers, filas };
}

describe('GET /salidas-matriz — wiring de query params hacia el servicio compartido', () => {
    beforeEach(() => jest.clearAllMocks());

    test('devuelve los 3 promedios y los benchmarks para cada persona (16. compatibilidad con datos de Casos ya existentes)', async () => {
        mockSupabaseSecuencial([ASIGS, USUARIOS, NOTAS_CASOS, NOTAS_SEC]);
        const { status, body } = await llamarRutaJson({ query: { año: '2026', desde: '2026-04-01', hasta: '2026-06-30' } });
        expect(status).toBe(200);
        const juan = body.personas.find(p => p.usuario_pagado_id === 'juan');
        expect(juan.promedios.casos.promedio).toBe(6.3);       // igual que el antiguo promedio_nota
        expect(juan.promedio_nota).toBe(6.3);                  // alias legacy sigue presente
        expect(juan.promedios.comision.promedio).toBe(5.9);
        expect(juan.promedios.delegado.promedio).toBe(6.1);
        expect(juan.promedios.casos.promedio_categoria).toBe(5.5); // Pedro, excluyéndose a sí mismo
    });

    test('14. Desde/Hasta se propagan al período devuelto', async () => {
        mockSupabaseSecuencial([[], [], [], []]);
        const { body } = await llamarRutaJson({ query: { desde: '2026-04-01', hasta: '2026-06-30' } });
        expect(body.periodo.inicio).toBe('2026-04-01');
        expect(body.periodo.fin).toBe('2026-06-30');
    });

    test('errores del servicio se traducen en 500 sin filtrar detalles internos raros', async () => {
        supabase.from.mockImplementation(() => ({
            select() { return this; }, eq() { return this; }, gte() { return this; }, lte() { return this; }, in() { return this; },
            then: (resolve) => Promise.resolve({ data: null, error: { message: 'fallo simulado' } }).then(resolve)
        }));
        const { status, body } = await llamarRutaJson({ query: {} });
        expect(status).toBe(500);
        expect(body.error).toMatch(/fallo simulado/);
    });
});

describe('GET /salidas-matriz/excel — 17. sigue funcionando, ahora con las columnas nuevas', () => {
    beforeEach(() => jest.clearAllMocks());

    test('genera un .xlsx real con columnas de Prom. Casos/Comisión/Delegado y Nota Casos/Comisión/Delegado por rodeo', async () => {
        mockSupabaseSecuencial([ASIGS, USUARIOS, NOTAS_CASOS, NOTAS_SEC]);
        const res = await llamarRutaExcel({ query: { año: '2026' } });
        expect(res.headers['Content-Type']).toMatch(/spreadsheetml/);

        const { headers, filas } = await leerExcel(res);
        expect(headers).toEqual(expect.arrayContaining([
            'Persona', 'RUT', 'Tipo persona', 'Categoría', 'Total salidas',
            'Prom. Casos', 'Prom. Comisión', 'Prom. Delegado',
            'Fecha rodeo', 'Club', 'Asociación', 'Tipo rodeo',
            'Nota Casos', 'Nota Comisión', 'Nota Delegado', 'Estado salida'
        ]));

        const filaJuan = filas.find(f => f[headers.indexOf('Persona')] === 'JUAN PÉREZ');
        expect(filaJuan[headers.indexOf('Nota Casos')]).toBe(6.3);
        expect(filaJuan[headers.indexOf('Nota Comisión')]).toBe(5.9);
        expect(filaJuan[headers.indexOf('Nota Delegado')]).toBe(6.1);
        expect(filaJuan[headers.indexOf('Prom. Casos')]).toBe('6.3 (1/1)');
    });
});
