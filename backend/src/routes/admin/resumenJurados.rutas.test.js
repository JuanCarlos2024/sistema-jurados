// Reportes → Resumen por jurado: la pantalla (GET /admin/reportes/
// resumen-mensual) y la exportación (GET /admin/exportacion/resumen-jurados
// ?formato=xlsx|csv) deben mostrar exactamente el mismo detalle y montos con
// los mismos filtros. El Excel se genera con ExcelJS REAL y se vuelve a leer.
jest.mock('../../config/supabase', () => require('../../services/resumenJurados.testkit').fake);

const { Writable } = require('stream');
const ExcelJS = require('exceljs');
const kit = require('../../services/resumenJurados.testkit');
const reportesRouter = require('./reportes');
const exportacionRouter = require('./exportacion');
const { TITULO_RESUMEN_JURADOS } = require('../../services/exportacion');

function handler(router, path) {
    const layer = router.stack.find(l => l.route && l.route.path === path && l.route.methods.get);
    if (!layer) throw new Error('ruta no encontrada: ' + path);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function crearRes() {
    const chunks = [];
    const res = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    res.statusCode = 200;
    res.headers = {};
    res.setHeader = (k, v) => { res.headers[k] = v; };
    res.status = c => { res.statusCode = c; return res; };
    res.json = b => { res.body = b; return res; };
    res.send = b => { res.body = b; return res; };
    res.buffer = () => Buffer.concat(chunks);
    return res;
}

async function llamar(router, path, query) {
    const res = crearRes();
    await handler(router, path)({ query: { ...query }, params: {}, body: {} }, res);
    return res;
}

const pantalla = async q => {
    const res = await llamar(reportesRouter, '/resumen-mensual', q);
    expect(res.statusCode).toBe(200);
    return res.body;
};

async function excel(q) {
    const res = await llamar(exportacionRouter, '/resumen-jurados', { ...q, formato: 'xlsx' });
    expect(res.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer());
    return wb;
}

async function csv(q) {
    const res = await llamar(exportacionRouter, '/resumen-jurados', { ...q, formato: 'csv' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/text\/csv; charset=utf-8/);
    return res.body;
}

// Valor efectivo de una celda. Para fórmulas se usa cell.result: el lector de
// ExcelJS omite `result` en cell.value cuando vale 0, aunque el archivo sí
// guarda <v>0</v> (verificado en la prueba de XML más abajo).
const valorCelda = cell => (cell.value && typeof cell.value === 'object' && 'formula' in cell.value ? cell.result : cell.value);
const valor = v => (v && typeof v === 'object' && 'result' in v ? v.result : v);
const fechaIso = d => (d instanceof Date ? d.toISOString().slice(0, 10) : null);

// Lee la hoja y la clasifica en filas de detalle, subtotales y total general.
function leerHoja(wb) {
    const ws = wb.getWorksheet('Resumen por jurado');
    const detalle = [], subtotales = [];
    let total = null;
    for (let i = 7; i <= ws.rowCount; i++) {
        const row = ws.getRow(i);
        const b = String(valor(row.getCell(2).value) || '');
        const montos = [11, 12, 13, 14, 15].map(c => valorCelda(row.getCell(c)));
        if (b.startsWith('TOTAL GENERAL')) total = { texto: b, n: row.getCell(4).value, montos, fila: i };
        else if (b.startsWith('TOTAL JURADO')) subtotales.push({ codigo: row.getCell(1).value, texto: b, n: row.getCell(4).value, montos, fila: i });
        else if (row.getCell(1).value) detalle.push({
            codigo: row.getCell(1).value, nombre: b, rut: row.getCell(3).value, n: row.getCell(4).value,
            fecha: fechaIso(row.getCell(5).value), asociacion: row.getCell(6).value, club: row.getCell(7).value,
            categoria: row.getCell(8).value, tipo: row.getCell(9).value, dias: row.getCell(10).value, montos, fila: i,
        });
    }
    return { ws, detalle, subtotales, total };
}

function parsearCsv(texto) {
    expect(texto.charCodeAt(0)).toBe(0xFEFF);
    const lineas = texto.slice(1).trim().split('\r\n');
    const parse = l => {
        const out = []; let cur = ''; let q = false;
        for (let i = 0; i < l.length; i++) {
            const ch = l[i];
            if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
            else if (ch === '"') q = true; else if (ch === ';') { out.push(cur); cur = ''; } else cur += ch;
        }
        out.push(cur); return out;
    };
    const headers = parse(lineas[0]);
    return lineas.slice(1).map(l => Object.fromEntries(parse(l).map((v, i) => [headers[i], v])));
}

const OCT = { año: '2026', mes: '10' };
beforeEach(() => kit.cargarDataset());

describe('Excel — formato y estructura', () => {
    test('una sola hoja "Resumen por jurado", título, período, filtros, encabezados', async () => {
        const wb = await excel({ ...OCT, asociacion: 'Puente Alto', categoria_rodeo_id: 'CR2' });
        expect(wb.worksheets.map(w => w.name)).toEqual(['Resumen por jurado']);
        const ws = wb.getWorksheet('Resumen por jurado');
        expect(ws.getCell('A1').value).toBe(TITULO_RESUMEN_JURADOS);
        expect(ws.getCell('A2').value).toBe('Período: Octubre 2026 (01/10/2026 al 31/10/2026)');
        expect(ws.getCell('A3').value).toContain('Asociación contiene: "Puente Alto"');
        expect(ws.getCell('A3').value).toContain('Categoría de rodeo: Segunda');
        expect(ws.getRow(6).values.slice(1)).toEqual([
            'Código', 'Jurado', 'RUT', 'N.º', 'Fecha', 'Asociación organizadora', 'Club organizador', 'Categoría',
            'Tipo de rodeo', 'Días', 'Pago base', 'Bono', 'Total bruto', 'Retención', 'Líquido',
        ]);
        expect(ws.getCell('A6').fill.fgColor.argb).toBe('FF1E3A5F');
    });

    test('cada rodeo en su propia fila; sin celdas fusionadas; paneles inmovilizados y autofiltro', async () => {
        const { ws, detalle, subtotales, total } = leerHoja(await excel(OCT));
        expect(detalle).toHaveLength(8);
        expect(subtotales).toHaveLength(4);
        expect(total).not.toBeNull();
        expect(detalle.every(d => !String(d.club).includes('\n'))).toBe(true);
        expect(Object.keys(ws._merges || {})).toHaveLength(0);
        expect(ws.views[0]).toMatchObject({ state: 'frozen', xSplit: 3, ySplit: 6 });
        expect(ws.autoFilter).toBe(`A6:O${total.fila - 1}`);
        expect(ws.getColumn(6).width).toBeGreaterThanOrEqual(20);
        expect(ws.getRow(detalle[0].fila).getCell(6).alignment.wrapText).toBe(true);
    });

    test('fechas reales de Excel dd/mm/yyyy, sin desplazamiento horario', async () => {
        const { ws, detalle } = leerHoja(await excel(OCT));
        const c = ws.getRow(detalle[0].fila).getCell(5);
        expect(c.value).toBeInstanceOf(Date);
        expect(c.numFmt).toBe('dd/mm/yyyy');
        expect(detalle.map(d => d.fecha)).toEqual([
            '2026-10-03',                                           // U1
            '2026-10-03', '2026-10-10', '2026-10-18', '2026-10-24', // U2
            '2026-10-10', '2026-10-18', '2026-10-31',               // U3 (incluye último día del mes)
        ]);
        detalle.forEach(d => expect(ws.getRow(d.fila).getCell(5).value.getUTCHours()).toBe(0));
    });

    test('montos numéricos reales con formato monetario chileno (numFmt), no texto con $', async () => {
        const { ws, detalle, subtotales, total } = leerHoja(await excel(OCT));
        for (const fila of [...detalle.map(d => d.fila), ...subtotales.map(s => s.fila), total.fila]) {
            for (const col of [11, 12, 13]) {
                const cell = ws.getRow(fila).getCell(col);
                expect(typeof valorCelda(cell)).toBe('number');
                expect(cell.numFmt).toBe('"$"#,##0;-"$"#,##0');
            }
        }
    });

    test('subtotales y total general con fórmulas SUBTOTAL cuyos resultados coinciden con el cálculo oficial', async () => {
        const { ws, subtotales, total } = leerHoja(await excel(OCT));
        const s2 = subtotales.find(s => s.codigo === 'USR-0002');
        expect(s2.texto).toBe('TOTAL JURADO: Alberto Esteban Saravia Retamal (4 RODEOS)');
        expect(s2.montos).toEqual([1225000, 35000, 1260000, 192150, 1067850]);
        const celdaBase = ws.getRow(s2.fila).getCell(11).value;
        expect(celdaBase.formula).toMatch(/^SUBTOTAL\(9,K\d+:K\d+\)$/);
        expect(ws.getRow(s2.fila).getCell(15).value.formula).toBe(`M${s2.fila}-N${s2.fila}`);
        expect(ws.getRow(s2.fila).getCell(14).font.color.argb).toBe('FFC0392B');
        expect(total.texto).toBe('TOTAL GENERAL DEL REPORTE — 4 jurados · 8 asignaciones');
        expect(total.montos).toEqual([2265000, 60000, 2325000, 354563, 1970437]);
        expect(ws.getRow(total.fila).getCell(11).value.formula).toBe(`SUBTOTAL(9,K7:K${total.fila - 1})`);
        const s4 = subtotales.find(s => s.codigo === 'USR-0004');
        expect(s4.texto).toContain('(0 RODEOS)');
        expect(s4.texto).toContain('1 designación(es) rechazada(s), sin pago');
    });

    test('las fórmulas llevan su resultado en caché en el XML, incluido 0 (visible sin recalcular)', async () => {
        const res = await llamar(exportacionRouter, '/resumen-jurados', { ...OCT, formato: 'xlsx' });
        const JSZip = require('jszip');
        const xml = await (await JSZip.loadAsync(res.buffer())).file('xl/worksheets/sheet1.xml').async('string');
        const celdasFormula = xml.match(/<c [^>]*>(?:(?!<\/c>).)*<f>(?:(?!<\/c>).)*<\/c>/g) || [];
        expect(celdasFormula.length).toBeGreaterThan(0);
        celdasFormula.forEach(c => expect(c).toMatch(/<v>-?\d+<\/v>/));
        expect(celdasFormula.some(c => c.includes('<v>0</v>'))).toBe(true);
    });

    test('filas de rodeo sin retención ni líquido (son del agregado del jurado)', async () => {
        const { detalle } = leerHoja(await excel(OCT));
        detalle.forEach(d => { expect(d.montos[3]).toBeNull(); expect(d.montos[4]).toBeNull(); });
    });

    test('reporte vacío no falla: encabezado + total en cero', async () => {
        kit.cargarDataset({ ...kit.datasetBase(), asignaciones: [] });
        const { detalle, total } = leerHoja(await excel(OCT));
        expect(detalle).toHaveLength(0);
        expect(total.montos).toEqual([0, 0, 0, 0, 0]);
    });
});

describe('Consistencia pantalla ↔ Excel ↔ CSV con los mismos filtros', () => {
    const casos = [
        ['octubre', OCT],
        ['octubre + asociación', { ...OCT, asociacion: 'Puente Alto' }],
        ['octubre + club', { ...OCT, club: 'San Joaquín' }],
        ['octubre + jurado', { ...OCT, usuario_pagado_id: 'U2' }],
        ['octubre + categoría de rodeo', { ...OCT, categoria_rodeo_id: 'CR2' }],
        ['rango desde/hasta', { fechaDesde: '2026-09-01', fechaHasta: '2026-10-31' }],
    ];

    test.each(casos)('%s', async (_nombre, q) => {
        const web = await pantalla(q);
        const { detalle, subtotales, total } = leerHoja(await excel(q));
        const filasCsv = parsearCsv(await csv(q));

        // Detalle web aplanado en el mismo orden.
        const webDetalle = web.data.flatMap(j => j.rodeos_detalle.map(f => ({
            codigo: j.codigo_interno, nombre: j.nombre_completo, rut: j.rut, n: f.n, fecha: f.fecha,
            asociacion: f.asociacion, club: f.club, categoria: f.categoria, tipo: f.tipo_rodeo, dias: f.duracion_dias,
            montos: [f.pago_base, f.bono_aprobado, f.bruto],
            asignacion_id: f.asignacion_id, rodeo_id: f.rodeo_id,
        })));

        // Web ↔ Excel (fila a fila)
        expect(detalle.map(d => ({ codigo: d.codigo, nombre: d.nombre, rut: d.rut, n: d.n, fecha: d.fecha, asociacion: d.asociacion,
            club: d.club, categoria: d.categoria, tipo: d.tipo, dias: d.dias, montos: d.montos.slice(0, 3) })))
            .toEqual(webDetalle.map(({ asignacion_id, rodeo_id, ...w }) => w));
        expect(subtotales.map(s => [s.codigo, s.n, ...s.montos]))
            .toEqual(web.data.map(j => [j.codigo_interno, j.cant_rodeos, j.total_pago_base, j.total_bono_aprobado, j.bruto, j.retencion_monto, j.liquido]));
        const t = web.totales_global;
        expect([total.n, ...total.montos]).toEqual([t.cant_rodeos, t.total_pago_base, t.total_bono_aprobado, t.bruto, t.retencion_monto, t.liquido]);

        // Excel ↔ CSV
        const csvDet = filasCsv.filter(f => f.tipo_fila === 'detalle');
        const csvSub = filasCsv.filter(f => f.tipo_fila === 'subtotal_jurado');
        const csvTot = filasCsv.filter(f => f.tipo_fila === 'total_general');
        expect(csvDet.map(f => [f.codigo, f.jurado, f.rut, Number(f.n_rodeo), f.fecha, f.asociacion_organizadora, f.club_organizador,
            f.categoria, f.tipo_rodeo, Number(f.dias), Number(f.pago_base), Number(f.bono), Number(f.total_bruto), f.retencion, f.liquido]))
            .toEqual(detalle.map(d => [d.codigo, d.nombre, d.rut, d.n, d.fecha.split('-').reverse().join('/'), d.asociacion, d.club,
                d.categoria, d.tipo, d.dias, ...d.montos.slice(0, 3), '', '']));
        expect(csvDet.map(f => f.asignacion_id)).toEqual(webDetalle.map(w => w.asignacion_id));
        expect(csvDet.map(f => f.rodeo_id)).toEqual(webDetalle.map(w => w.rodeo_id));
        expect(csvSub.map(f => [f.codigo, Number(f.n_rodeo), ...['pago_base', 'bono', 'total_bruto', 'retencion', 'liquido'].map(k => Number(f[k]))]))
            .toEqual(subtotales.map(s => [s.codigo, s.n, ...s.montos]));
        expect(csvTot).toHaveLength(1);
        expect(['pago_base', 'bono', 'total_bruto', 'retencion', 'liquido'].map(k => Number(csvTot[0][k]))).toEqual(total.montos);

        expect(web.conciliacion.ok).toBe(true);
    });

    test('CSV: BOM UTF-8, separador ;, tildes y ñ intactas, una fila por rodeo y subtotales marcados', async () => {
        const texto = await csv(OCT);
        expect(texto.split('\r\n')[0]).toBe('﻿tipo_fila;codigo;jurado;rut;n_rodeo;fecha;asociacion_organizadora;club_organizador;categoria;tipo_rodeo;dias;pago_base;bono;total_bruto;retencion;liquido;rodeo_id;asignacion_id');
        expect(texto).toContain('Ñuble Peña Muñoz');
        expect(texto).toContain('San Joaquín');
        expect(texto).toContain('Agustín Correa Guzmán');
        const filas = parsearCsv(texto);
        expect(filas.filter(f => f.tipo_fila === 'detalle')).toHaveLength(8);
        expect(filas.filter(f => f.tipo_fila === 'subtotal_jurado')).toHaveLength(4);
        expect(filas.find(f => f.tipo_fila === 'detalle').fecha).toBe('03/10/2026');
        expect(texto).not.toMatch(/\$/);
    });

    test('regresión: el Excel ya no suma designaciones rechazadas (antes sí)', async () => {
        const { subtotales } = leerHoja(await excel(OCT));
        expect(subtotales.find(s => s.codigo === 'USR-0003').montos[0]).toBe(795000); // sin los 430.000 rechazados
    });
});

describe('Las demás pestañas de Reportes siguen respondiendo igual', () => {
    test.each(['/por-asociacion', '/por-club', '/por-tipo-rodeo', '/por-categoria-rodeo', '/por-jurado'])('GET %s', async path => {
        const res = await llamar(reportesRouter, path, OCT);
        expect(res.statusCode).toBe(200);
        expect(Array.isArray(res.body.data)).toBe(true);
        expect(res.body.data.length).toBeGreaterThan(0);
    });

    test('GET /detalle-jurado', async () => {
        const res = await llamar(reportesRouter, '/detalle-jurado', { ...OCT, usuario_pagado_id: 'U2' });
        expect(res.statusCode).toBe(200);
        expect(res.body.totales.bruto).toBe(1260000);
    });

    test('GET /detalle-asociacion', async () => {
        const res = await llamar(reportesRouter, '/detalle-asociacion', { ...OCT, asociacion: 'Puente Alto' });
        expect(res.statusCode).toBe(200);
        expect(res.body.data.length).toBeGreaterThan(0);
    });

    test('exportaciones de detalle y agregados siguen generando archivo', async () => {
        const det = await llamar(exportacionRouter, '/detalle-jurado', { ...OCT, usuario_pagado_id: 'U2', formato: 'csv' });
        expect(det.statusCode).toBe(200);
        expect(String(det.body)).toContain('San Joaquín');
        for (const tipo of ['asociacion', 'club', 'tipo-rodeo']) {
            const ag = await llamar(exportacionRouter, '/agregado', { ...OCT, tipo, formato: 'csv' });
            expect(ag.statusCode).toBe(200);
        }
    });
});
