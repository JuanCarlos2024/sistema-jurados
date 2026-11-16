// Reporte Fin de Semana — columnas "Falta disciplinaria / reglamentaria" y
// "Acciones Área Deportiva" (hoja "Reporte Fin de Semana", M y N).
//   M: cartillas_jurado.datos.descripcion_faltas de TODAS las cartillas
//      enviadas (es_actual) del rodeo con datos.hubo_faltas === 'si' — misma
//      clave estructurada que el Reporte Cartillas Digitales — Jurados.
//   N: rodeos.observacion ("Obs. Jefe Deportivo / Acciones Área Deportiva").
// Workbook ExcelJS REAL escrito y releído. Solo fixtures, sin datos reales.
const { Writable } = require('stream');
const ExcelJS = require('exceljs');

jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../services/colleras-completas', () => ({ obtenerCollerasCompletas: jest.fn() }));

const supabase = require('../../config/supabase');
const { obtenerCollerasCompletas } = require('../../services/colleras-completas');
const router = require('./reporte-deportivo');

const R1 = '11111111-1111-4111-8111-111111111111';   // con falta
const R2 = '22222222-2222-4222-8222-222222222222';   // misma fecha y asociación que R1, sin falta
const R3 = '33333333-3333-4333-8333-333333333333';   // sin cartilla
const U1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const U2 = 'aaaaaaaa-0000-4000-8000-000000000002';

const COL_MONITOREO = 12, COL_FALTA = 13, COL_ACCIONES = 14;

let respuestas, llamadas;
function crearChain(tabla) {
    const chain = {};
    ['select', 'eq', 'neq', 'gte', 'lte', 'ilike', 'or', 'in', 'not', 'is', 'order', 'range', 'limit'].forEach(m => {
        chain[m] = (...args) => { llamadas.push({ tabla, m, args }); return chain; };
    });
    chain.then = (resolve, reject) => Promise.resolve(respuestas[tabla] || { data: [], error: null, count: 0 }).then(resolve, reject);
    return chain;
}

const cartilla = (id, rodeo_id, usuario_pagado_id, datos, extra = {}) => ({
    id, rodeo_id, usuario_pagado_id, estado: 'enviada', datos,
    enviada_en: '2026-11-15T20:00:00Z', storage_path_pdf: null, ...extra
});

beforeEach(() => {
    llamadas = [];
    respuestas = {
        rodeos: {
            data: [
                { id: R1, club: 'LOS ÁNGELES', asociacion: 'BÍO-BÍO', fecha: '2026-11-15', tipo_rodeo_nombre: 'Provincial', categoria_rodeo_nombre: 'A', observacion: '' },
                { id: R2, club: 'MULCHÉN', asociacion: 'BÍO-BÍO', fecha: '2026-11-15', tipo_rodeo_nombre: 'Provincial', categoria_rodeo_nombre: 'A', observacion: '' },
                { id: R3, club: 'ÑIQUÉN', asociacion: 'ÑUBLE', fecha: '2026-11-15', tipo_rodeo_nombre: 'Provincial', categoria_rodeo_nombre: 'A', observacion: null }
            ],
            error: null, count: 3
        },
        evaluaciones: { data: [], error: null },
        datos_monitor_rodeo: { data: [], error: null },
        asignaciones: {
            data: [
                { rodeo_id: R1, tipo_persona: 'jurado', estado_designacion: 'aceptado', nombre_importado: null, usuarios_pagados: { id: U1, nombre_completo: 'Juan Pérez' } },
                { rodeo_id: R1, tipo_persona: 'jurado', estado_designacion: 'aceptado', nombre_importado: null, usuarios_pagados: { id: U2, nombre_completo: 'María Muñoz' } }
            ],
            error: null
        },
        cartillas_jurado: {
            data: [
                cartilla('c1', R1, U1, { hubo_faltas: 'si', descripcion_faltas: 'Jinete golpea al novillo con puerta.' }),
                cartilla('c2', R2, U2, { hubo_faltas: 'no' })
            ],
            error: null
        }
    };
    supabase.from.mockReset();
    supabase.from.mockImplementation(tabla => crearChain(tabla));
    obtenerCollerasCompletas.mockReset();
    obtenerCollerasCompletas.mockResolvedValue({
        filas: [],
        resumen: { totalCompletas: 0, zonaNorte: 0, centroNorte: 0, zonaCentro: 0, centroSur: 0, zonaSur: 0 }
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
async function libro(ruta = '/export-fin-semana') {
    const res = await llamar(ruta);
    expect(res.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.getBuffer());
    return wb;
}
const hoja1 = async () => (await libro()).getWorksheet('Reporte Fin de Semana');
const vacia = (v) => v === null || v === undefined || v === '';
// Fila de la hoja 1 por Club (los rodeos salen en el orden del fixture).
const fila = (ws, club) => {
    for (let r = 2; r <= ws.rowCount; r++) if (ws.getRow(r).getCell(2).value === club) return ws.getRow(r);
    throw new Error('fila no encontrada: ' + club);
};

describe('Reporte Fin de Semana — Falta disciplinaria / reglamentaria', () => {
    test('CASO 1: Sí + comentario → la celda contiene EXACTAMENTE ese comentario (sin rótulo de jurado)', async () => {
        const ws = await hoja1();
        expect(fila(ws, 'LOS ÁNGELES').getCell(COL_FALTA).value).toBe('Jinete golpea al novillo con puerta.');
    });

    test('CASO 2: Respuesta = No → celda vacía', async () => {
        const ws = await hoja1();
        expect(vacia(fila(ws, 'MULCHÉN').getCell(COL_FALTA).value)).toBe(true);
    });

    test('CASO 2b: "No" con una descripción antigua guardada → igual vacía (solo cuenta la respuesta Sí)', async () => {
        respuestas.cartillas_jurado.data[1].datos = { hubo_faltas: 'no', descripcion_faltas: 'texto residual' };
        const ws = await hoja1();
        expect(vacia(fila(ws, 'MULCHÉN').getCell(COL_FALTA).value)).toBe(true);
    });

    test('CASO 3: rodeo sin cartilla → celda vacía y el Excel se genera normalmente', async () => {
        respuestas.cartillas_jurado.data = [];
        const wb = await libro();
        const ws = wb.getWorksheet('Reporte Fin de Semana');
        expect(ws.rowCount).toBe(4);
        for (const club of ['LOS ÁNGELES', 'MULCHÉN', 'ÑIQUÉN']) expect(vacia(fila(ws, club).getCell(COL_FALTA).value)).toBe(true);
    });

    test('CASO 4: Sí con comentario vacío o solo espacios → no se inventa texto (celda vacía)', async () => {
        respuestas.cartillas_jurado.data[0].datos = { hubo_faltas: 'si', descripcion_faltas: '   ' };
        let ws = await hoja1();
        expect(vacia(fila(ws, 'LOS ÁNGELES').getCell(COL_FALTA).value)).toBe(true);
        respuestas.cartillas_jurado.data[0].datos = { hubo_faltas: 'si' };
        ws = await hoja1();
        const v = fila(ws, 'LOS ÁNGELES').getCell(COL_FALTA).value;
        expect(vacia(v)).toBe(true);
        expect(String(v ?? '')).not.toMatch(/SIN INFORMACI|—/i);
    });

    test('CASO 5: dos jurados con dos comentarios → ambos en una sola celda, rotulados y legibles', async () => {
        respuestas.cartillas_jurado.data.push(cartilla('c3', R1, U2,
            { hubo_faltas: 'si', descripcion_faltas: '1ra libre: el jinete golpea el novillo con puerta.' },
            { enviada_en: '2026-11-15T21:00:00Z' }));
        const ws = await hoja1();
        const celda = fila(ws, 'LOS ÁNGELES').getCell(COL_FALTA);
        expect(celda.value).toBe(
            '[Juan Pérez] Jinete golpea al novillo con puerta.\n\n' +
            '[María Muñoz] 1ra libre: el jinete golpea el novillo con puerta.'
        );
        expect(celda.alignment.wrapText).toBe(true);
    });

    test('CASO 5b: el mismo comentario repetido (otra cartilla, distinto espaciado) no se duplica', async () => {
        respuestas.cartillas_jurado.data.push(cartilla('c3', R1, U2,
            { hubo_faltas: 'si', descripcion_faltas: '  Jinete golpea  al novillo con puerta. ' }));
        const ws = await hoja1();
        expect(fila(ws, 'LOS ÁNGELES').getCell(COL_FALTA).value).toBe('Jinete golpea al novillo con puerta.');
    });

    test('CASO 5c: cartillas en borrador o reabiertas no aportan comentarios (solo enviadas)', async () => {
        respuestas.cartillas_jurado.data.push(cartilla('c3', R1, U2,
            { hubo_faltas: 'si', descripcion_faltas: 'Borrador no enviado.' }, { estado: 'borrador' }));
        const ws = await hoja1();
        expect(fila(ws, 'LOS ÁNGELES').getCell(COL_FALTA).value).toBe('Jinete golpea al novillo con puerta.');
    });

    test('CASO 10: vínculo por rodeo_id — otro rodeo con igual fecha y asociación no recibe el comentario', async () => {
        const ws = await hoja1();
        expect(fila(ws, 'LOS ÁNGELES').getCell(4).value).toBe(fila(ws, 'MULCHÉN').getCell(4).value);
        expect(vacia(fila(ws, 'MULCHÉN').getCell(COL_FALTA).value)).toBe(true);
        // Una cartilla de un rodeo que no está en el período no aparece en ninguna fila.
        respuestas.cartillas_jurado.data.push(cartilla('cx', '99999999-9999-4999-8999-999999999999', U1,
            { hubo_faltas: 'si', descripcion_faltas: 'Falta de otro rodeo.' }));
        const ws2 = await hoja1();
        for (let r = 2; r <= ws2.rowCount; r++) expect(ws2.getRow(r).getCell(COL_FALTA).value).not.toBe('Falta de otro rodeo.');
    });

    test('sin N+1: cartillas_jurado se consulta UNA sola vez, por lote de rodeo_id, solo cartillas actuales', async () => {
        await libro();
        const consultas = supabase.from.mock.calls.filter(c => c[0] === 'cartillas_jurado');
        expect(consultas.length).toBe(1);
        const inRodeo = llamadas.find(l => l.tabla === 'cartillas_jurado' && l.m === 'in');
        expect(inRodeo.args).toEqual(['rodeo_id', [R1, R2, R3]]);
        expect(llamadas).toContainEqual({ tabla: 'cartillas_jurado', m: 'eq', args: ['es_actual', true] });
    });
});

describe('Reporte Fin de Semana — Acciones Área Deportiva', () => {
    test('CASO 6: rodeos.observacion → la columna contiene EXACTAMENTE ese texto', async () => {
        respuestas.rodeos.data[0].observacion = 'Se contactó al club y se solicitó informe.';
        const ws = await hoja1();
        expect(fila(ws, 'LOS ÁNGELES').getCell(COL_ACCIONES).value).toBe('Se contactó al club y se solicitó informe.');
    });

    test('CASO 7: vacío, NULL o solo espacios → celda vacía (sin "No aplica")', async () => {
        respuestas.rodeos.data[1].observacion = '   ';
        const ws = await hoja1();
        for (const club of ['LOS ÁNGELES', 'MULCHÉN', 'ÑIQUÉN']) {
            const v = fila(ws, club).getCell(COL_ACCIONES).value;
            expect(vacia(v)).toBe(true);
        }
    });

    test('CASO 8: Monitoreo y Acciones Área Deportiva con textos distintos → cada uno en SU columna', async () => {
        respuestas.rodeos.data[0].observacion = 'Se contactó al club y se solicitó informe.';
        respuestas.datos_monitor_rodeo.data = [{ rodeo_id: R1, comentario_monitor: 'Corte generalizado de luz; la tercera serie libre comenzó con generador.' }];
        const ws = await hoja1();
        const f = fila(ws, 'LOS ÁNGELES');
        expect(f.getCell(COL_MONITOREO).value).toBe('Corte generalizado de luz; la tercera serie libre comenzó con generador.');
        expect(f.getCell(COL_ACCIONES).value).toBe('Se contactó al club y se solicitó informe.');
        expect(f.getCell(COL_FALTA).value).toBe('Jinete golpea al novillo con puerta.');
        // Sin monitoreo: Acciones no se rellena con nada del monitor, ni al revés.
        const g = fila(ws, 'MULCHÉN');
        expect(vacia(g.getCell(COL_MONITOREO).value)).toBe(true);
        expect(vacia(g.getCell(COL_ACCIONES).value)).toBe(true);
    });
});

describe('Reporte Fin de Semana — estructura', () => {
    test('CASO 9: orden exacto Monitoreo → Falta disciplinaria / reglamentaria → Acciones Área Deportiva (últimas columnas)', async () => {
        const ws = await hoja1();
        const headers = ws.getRow(1).values.slice(1);
        expect(headers.slice(-5)).toEqual([
            'Total Situaciones', 'Serie Campeones - 2 Vueltas', 'Monitoreo',
            'Falta disciplinaria / reglamentaria', 'Acciones Área Deportiva'
        ]);
        expect(headers[COL_MONITOREO - 1]).toBe('Monitoreo');
        expect(headers[COL_FALTA - 1]).toBe('Falta disciplinaria / reglamentaria');
        expect(headers[COL_ACCIONES - 1]).toBe('Acciones Área Deportiva');
    });

    test('formato: encabezados con el mismo estilo, wrapText + alineación superior, anchos razonables, congelado y filtro A:N', async () => {
        respuestas.rodeos.data[0].observacion = 'Acción larga del Área Deportiva. '.repeat(10);
        const ws = await hoja1();
        for (const col of [COL_FALTA, COL_ACCIONES]) {
            const h = ws.getRow(1).getCell(col);
            expect(h.font.bold).toBe(true);
            expect(h.fill.fgColor.argb).toBe('FF1e3a5f');
            const c = fila(ws, 'LOS ÁNGELES').getCell(col);
            expect(c.alignment).toMatchObject({ vertical: 'top', wrapText: true });
            expect(ws.getColumn(col).width).toBeGreaterThanOrEqual(40);
            expect(ws.getColumn(col).width).toBeLessThanOrEqual(60);
        }
        expect(fila(ws, 'LOS ÁNGELES').height).toBeGreaterThan(28);   // crece con Acciones larga
        expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
        expect(ws.autoFilter).toBe('A1:N1');
    });

    test('fila con resultado alterado: el relleno también cubre las dos columnas nuevas', async () => {
        respuestas.evaluaciones.data = [{ id: 'ev1', rodeo_id: R1, estado: 'cerrada', resultados_alterados: true, comentario_resultados_alterados: 'x', modo_flujo: null }];
        const ws = await hoja1();
        for (const col of [COL_FALTA, COL_ACCIONES]) expect(fila(ws, 'LOS ÁNGELES').getCell(col).fill.fgColor.argb).toBe('FFFDEBD0');
    });

    test('CASO 15: tildes, ñ, N°, comillas y saltos de línea se exportan intactos', async () => {
        const texto = 'Jinete Ñúñez "el Chico" golpeó al novillo N° 3 con puerta.\nSegunda línea: área, éxito, índice, órgano, único.';
        respuestas.cartillas_jurado.data[0].datos = { hubo_faltas: 'si', descripcion_faltas: texto };
        respuestas.rodeos.data[0].observacion = 'Se citó al jinete «Ñúñez»; N° de oficio 12.\nSeguimiento pendiente.';
        const ws = await hoja1();
        const f = fila(ws, 'LOS ÁNGELES');
        expect(f.getCell(COL_FALTA).value).toBe(texto);
        expect(f.getCell(COL_ACCIONES).value).toBe('Se citó al jinete «Ñúñez»; N° de oficio 12.\nSeguimiento pendiente.');
    });
});

describe('Otros exportes y hojas sin cambios', () => {
    const HEADERS_DETALLE = [
        'Club / Asociación', 'Fecha', 'Tipo de Rodeo', 'Jurado(s)', 'Delegado Rentado',
        'Puntaje Serie Campeones 1° - 2° - 3°', 'Revisión Puntaje 1° - 2° - 3°',
        'Análisis de la Jura', 'Resultado Alterado', 'Caso', 'Enlace a Situación / Video',
        'Comentario / Descripción', 'Tipo Situación', 'Resolución Final', 'Desc. Pts',
        'Comentario Analista', 'Comentario Comisión',
        'Observaciones (Jurado / Analista / Jefe / Monitor / Admin)',
        'Hora de Inicio', 'Serie Campeones - 2 Vueltas', 'Caseta Adecuada',
        'Faltas Disciplinarias/Reglamentarias', 'Descripción de la Falta',
        'Ganado Fuera del Peso Reglamentario', 'Detalle Ganado Fuera de Peso',
        'Movimiento a la Rienda', 'Detalle Movimiento a la Rienda'
    ];

    test('CASO 11: Reporte Directorio sin cambios (15 columnas; Acciones = "No aplica" cuando está vacío, como siempre)', async () => {
        const ws = (await libro('/export-directorio')).getWorksheet('Reporte Deportivo');
        const headers = ws.getRow(1).values.slice(1);
        expect(headers.length).toBe(15);
        expect(headers[13]).toBe('Acciones Área Deportiva');
        expect(headers[14]).toBe('Rodeo ID');
        expect(headers).not.toContain('Falta disciplinaria / reglamentaria');
        expect(ws.getRow(2).getCell(14).value).toBe('No aplica');
    });

    test('CASO 12: Exportar Excel normal sin columnas nuevas', async () => {
        const ws = (await libro('/export')).getWorksheet('Reporte Deportivo');
        const headers = ws.getRow(1).values.slice(1);
        expect(headers).not.toContain('Falta disciplinaria / reglamentaria');
        expect(headers).not.toContain('Acciones Área Deportiva');
    });

    test('CASO 13: Exportar Excel Detallado sin cambios (27 columnas; Descripción de la Falta = primera cartilla enviada, como antes)', async () => {
        respuestas.cartillas_jurado.data.push(cartilla('c3', R1, U2, { hubo_faltas: 'si', descripcion_faltas: 'Segunda falta.' }));
        const ws = (await libro('/export-detalle')).getWorksheet('Reporte Deportivo Detalle');
        expect(ws.getRow(1).values.slice(1)).toEqual(HEADERS_DETALLE);
        expect(ws.getRow(2).getCell(23).value).toBe('Jinete golpea al novillo con puerta.');
    });

    test('CASO 14: hojas "Detalle" y "Colleras completas" del Reporte Fin de Semana siguen generándose igual', async () => {
        const wb = await libro();
        expect(wb.worksheets.map(w => w.name)).toEqual(['Reporte Fin de Semana', 'Detalle', 'Colleras completas']);
        const det = wb.getWorksheet('Detalle');
        expect(det.getRow(1).values.slice(1)).toEqual(HEADERS_DETALLE);
        expect(det.getRow(2).getCell(23).value).toBe('Jinete golpea al novillo con puerta.');
        const col = wb.getWorksheet('Colleras completas');
        expect(String(col.getCell(1, 1).value)).toMatch(/COLLERAS COMPLETAS AL/);
    });
});
