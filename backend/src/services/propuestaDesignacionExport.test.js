// Fase 2C, sección 5 — exportación Excel/PDF de una propuesta. Genera un
// Workbook de ExcelJS REAL (no mockeado) y lo vuelve a leer, igual patrón
// que exportacion.rodeos.test.js, para confirmar que las columnas pedidas
// (jurado propuesto/seleccionado, motivo del cambio, advertencias, cupos
// pendientes) quedan en el archivo. El PDF se verifica por cabecera
// Content-Type + firma binaria %PDF (sin agregar un parser de PDF nuevo).
const { Writable } = require('stream');
const ExcelJS = require('exceljs');

jest.mock('../config/supabase', () => ({ from: jest.fn() }));
const supabase = require('../config/supabase');
const { exportarPropuestaExcel, exportarPropuestaPDF, cargarDatosExportacion } = require('./propuestaDesignacionExport');

let respuestas;
function crearChain(tabla) {
    const chain = {};
    const metodos = ['select', 'eq', 'neq', 'gte', 'lte', 'ilike', 'or', 'in', 'not', 'is', 'order', 'range', 'single', 'maybeSingle'];
    metodos.forEach(m => { chain[m] = () => chain; });
    chain.then = (resolve, reject) => Promise.resolve(respuestas[tabla] || { data: [], error: null }).then(resolve, reject);
    return chain;
}

beforeEach(() => {
    respuestas = {};
    supabase.from.mockReset();
    supabase.from.mockImplementation(tabla => crearChain(tabla));
});

function crearResFake() {
    const chunks = [];
    const sink = new Writable({ write(chunk, enc, cb) { chunks.push(chunk); cb(); } });
    sink.headers = {};
    sink.setHeader = (k, v) => { sink.headers[k] = v; };
    sink.send = (buf) => { chunks.push(buf); sink.end(); };
    sink.getBuffer = () => Buffer.concat(chunks);
    return sink;
}

function configurarPropuestaBase() {
    respuestas = {
        propuestas_designacion: {
            data: {
                id: 'prop-1', estado: 'BORRADOR', motor_usado: 'global',
                fecha_corte_tecnica: '2026-10-30T10:00:00.000Z', created_at: '2026-10-30T11:00:00.000Z',
                resultado_cobertura_json: { estado_busqueda: 'COBERTURA_COMPLETA', total_cupos: 2, cobertura_obtenida: 2, cupos_pendientes: 0 },
                temporadas: { nombre: 'Temporada 2026' }
            },
            error: null
        },
        propuestas_designacion_detalle: {
            data: [
                {
                    id: 'd1', rodeo_id: 'r1', jurado_id_propuesto: 'j1', jurado_id_seleccionado: 'j2',
                    estado_revision: 'MODIFICADO', origen_seleccion: 'MANUAL',
                    metricas_json: { advertencias_aceptadas: [{ tipo: 'DISTANCIA_EXCEDIDA' }] },
                    rodeos: { club: 'Club Uno', asociacion: 'Osorno', fecha: '2026-11-01', duracion_dias: 1, tipo_rodeo_nombre: 'Interclubes' }
                },
                {
                    id: 'd2', rodeo_id: 'r2', jurado_id_propuesto: 'j1', jurado_id_seleccionado: null,
                    estado_revision: 'PENDIENTE', origen_seleccion: null, metricas_json: {},
                    rodeos: { club: 'Club Dos', asociacion: 'Valdivia', fecha: '2026-11-08', duracion_dias: 1, tipo_rodeo_nombre: 'Provincial' }
                }
            ],
            error: null
        },
        usuarios_pagados: { data: [{ id: 'j1', nombre_completo: 'Jurado Uno' }, { id: 'j2', nombre_completo: 'Jurado Dos' }], error: null },
        bitacora_designaciones: {
            data: [{
                propuesta_detalle_id: 'd1', nombre_nuevo_snapshot: 'Jurado Dos', motivo_detalle: 'Ajuste manual',
                actor_id: 'admin-1', created_at: '2026-10-30T12:00:00.000Z',
                catalogo_motivos_designacion: { etiqueta: 'Criterio técnico del Área Deportiva' }
            }],
            error: null
        },
        asignaciones: { data: [{ propuesta_detalle_id: 'd1' }], error: null } // d1 ya fue aplicada; d2 no
    };
}

describe('cargarDatosExportacion', () => {
    test('propuesta inexistente -> null', async () => {
        respuestas = { propuestas_designacion: { data: null, error: null } };
        const datos = await cargarDatosExportacion('no-existe');
        expect(datos).toBeNull();
    });

    test('arma filas con V1/actual/modificado/aplicada/advertencias correctamente', async () => {
        configurarPropuestaBase();
        const datos = await cargarDatosExportacion('prop-1');
        expect(datos.resumen.modificados).toBe(1);
        expect(datos.resumen.pendientes).toBe(1);

        const [f1, f2] = datos.filas;
        expect(f1.v1Nombre).toBe('Jurado Uno');
        expect(f1.actualNombre).toBe('Jurado Dos');
        expect(f1.modificado).toBe(true);
        expect(f1.aplicada).toBe(true);
        expect(f1.advertencias).toEqual(['DISTANCIA_EXCEDIDA']);
        expect(f1.ultimoMovimiento.motivo).toBe('Criterio técnico del Área Deportiva');

        expect(f2.v1Nombre).toBe('Jurado Uno');
        expect(f2.actualNombre).toBe('Jurado Uno'); // PENDIENTE -> efectivo es el propuesto
        expect(f2.modificado).toBe(false);
        expect(f2.aplicada).toBe(false);
    });
});

describe('exportarPropuestaExcel', () => {
    test('propuesta inexistente -> devuelve null, no escribe nada en res', async () => {
        respuestas = { propuestas_designacion: { data: null, error: null } };
        const res = crearResFake();
        const resultado = await exportarPropuestaExcel('no-existe', res);
        expect(resultado).toBeNull();
        expect(res.getBuffer().length).toBe(0);
    });

    test('genera un .xlsx real con hoja Resumen y hoja Detalle con las columnas pedidas', async () => {
        configurarPropuestaBase();
        const res = crearResFake();
        const resultado = await exportarPropuestaExcel('prop-1', res);
        expect(resultado).toBe(true);
        expect(res.headers['Content-Type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(res.getBuffer());

        const wsResumen = wb.getWorksheet('Resumen');
        const filasResumen = [];
        for (let i = 1; i <= wsResumen.rowCount; i++) filasResumen.push(wsResumen.getRow(i).values.slice(1));
        expect(filasResumen.some(f => f[0] === 'Motor utilizado' && f[1] === 'Motor global optimizado')).toBe(true);
        expect(filasResumen.some(f => f[0] === 'Cobertura obtenida (motor global)' && f[1] === 2)).toBe(true);

        const wsDetalle = wb.getWorksheet('Detalle');
        const headers = wsDetalle.getRow(1).values.slice(1);
        expect(headers).toContain('Jurado propuesto (V1)');
        expect(headers).toContain('Jurado seleccionado (actual)');
        expect(headers).toContain('Motivo del cambio');
        expect(headers).toContain('Advertencias');
        expect(headers).toContain('Designación real creada');

        const fila1 = wsDetalle.getRow(2).values.slice(1);
        expect(fila1).toContain('Jurado Uno'); // V1
        expect(fila1).toContain('Jurado Dos'); // actual
        expect(fila1).toContain('Sí'); // modificado y/o aplicada
    });
});

describe('exportarPropuestaPDF', () => {
    test('propuesta inexistente -> devuelve null', async () => {
        respuestas = { propuestas_designacion: { data: null, error: null } };
        const res = crearResFake();
        const resultado = await exportarPropuestaPDF('no-existe', res);
        expect(resultado).toBeNull();
    });

    test('genera un PDF real (firma %PDF) con Content-Type correcto', async () => {
        configurarPropuestaBase();
        const res = crearResFake();
        const resultado = await exportarPropuestaPDF('prop-1', res);
        expect(resultado).toBe(true);
        expect(res.headers['Content-Type']).toBe('application/pdf');
        const buffer = res.getBuffer();
        expect(buffer.slice(0, 4).toString('latin1')).toBe('%PDF');
    });
});
