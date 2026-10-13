// Reporte Fin de Semana: GET /export-fin-semana genera UN XLSX con
// EXACTAMENTE 3 hojas, en este orden: "Reporte Fin de Semana" (12 columnas,
// A:L), "Detalle" (27 columnas, A:AA, idénticas a las de /export-detalle) y
// "Colleras completas" (sin cambios). Workbook ExcelJS REAL escrito y
// releído (mismo patrón que reporte-deportivo.export-directorio.test.js).
// Solo fixtures, sin datos reales.
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

// Usado solo para /export-directorio (NO cambia en esta tarea).
const HEADERS_14 = [
    'Fecha', 'Club', 'Asociación', 'Tipo Rodeo', 'Jurado(s)', 'Resultado Alterado',
    'Descripción de lo observado', 'Total Situaciones', 'Serie Campeones - 2 Vueltas',
    'Caseta Jurado', 'Faltas Disciplinarias/Reglamentarias', 'Ganado Fuera del Peso Reglamentario',
    'Movimiento a la Rienda', 'Acciones Área Deportiva'
];

// Hoja 1 "Reporte Fin de Semana" — EXACTAMENTE 12 columnas, A:L. Sin "Acciones
// Área Deportiva" ni "Rodeo ID" (ninguna columna oculta); la última es
// "Monitoreo" (comentario_monitor íntegro, sin composición).
const HEADERS_FIN_SEMANA = [
    'Fecha', 'Club', 'Asociación', 'Tipo Rodeo', 'Jurado(s)', 'Resultado Alterado',
    'Puntaje Serie Campeones 1° - 2° - 3°', 'Revisión Puntaje 1° - 2° - 3°',
    'Descripción de lo observado', 'Total Situaciones', 'Serie Campeones - 2 Vueltas',
    'Monitoreo'
];

// Hoja 2 "Detalle" — EXACTAMENTE 27 columnas, A:AA, idénticas a "Reporte
// Deportivo Detalle" de /export-detalle (mismo orden, ese endpoint no cambia).
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

// Busca en la columna `col` (1-based) la fila cuyo valor sea exactamente `valor`. La fila de encabezado de
// la tabla detalle de "Colleras completas" ya no está en una fila fija: puede haber, antes de ella, el
// bloque comparativo nuevo (FASE 2.6). Buscarla dinámicamente evita tests frágiles atados a un número de fila.
function buscarFilaConValor(ws, col, valor, maxFila = 80) {
    for (let r = 1; r <= maxFila; r++) if (ws.getCell(r, col).value === valor) return r;
    return -1;
}

describe('GET /export-fin-semana', () => {
    test('PRUEBA 1/14: el XLSX contiene exactamente 3 hojas, en orden "Reporte Fin de Semana", "Detalle", "Colleras completas"', async () => {
        const { res, wb } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        expect(res.statusCode).toBe(200);
        const nombres = wb.worksheets.map(ws => ws.name);
        expect(nombres).toEqual(['Reporte Fin de Semana', 'Detalle', 'Colleras completas']);
    });

    test('PRUEBA 2/3: HOJA 1 tiene exactamente 12 columnas A:L, en el orden exacto pedido; sin Acciones Área Deportiva ni Rodeo ID oculta', async () => {
        const { res, ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        expect(res.headers['Content-Disposition']).toMatch(/^attachment; filename="reporte_fin_semana_\d{4}-\d{2}-\d{2}\.xlsx"$/);
        expect(ws1).toBeDefined();

        const headers = ws1.getRow(1).values.slice(1);
        expect(headers.length).toBe(12);
        expect(headers).toEqual(HEADERS_FIN_SEMANA);
        expect(headers).not.toContain('Acciones Área Deportiva');
        expect(headers).not.toContain('Rodeo ID');
        expect(headers).not.toContain('Obs. Monitor');
        expect(ws1.columns.length).toBe(12);

        const fila = ws1.getRow(2).values.slice(1);
        expect(fila[1]).toBe('SAN CARLOS');
    });

    test('las 4 columnas eliminadas (del Directorio) no aparecen en ningún lugar del Reporte Fin de Semana', async () => {
        const { ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        const headers = ws1.getRow(1).values.slice(1);
        for (const eliminada of ['Caseta Jurado', 'Faltas Disciplinarias/Reglamentarias', 'Ganado Fuera del Peso Reglamentario', 'Movimiento a la Rienda']) {
            expect(headers).not.toContain(eliminada);
        }
    });

    test('Puntaje Serie Campeones / Revisión Puntaje quedan consecutivas inmediatamente después de Resultado Alterado', async () => {
        const { ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        const headers = ws1.getRow(1).values.slice(1);
        const iAlterado = headers.indexOf('Resultado Alterado');
        expect(headers[iAlterado + 1]).toBe('Puntaje Serie Campeones 1° - 2° - 3°');
        expect(headers[iAlterado + 2]).toBe('Revisión Puntaje 1° - 2° - 3°');
    });

    test('G/H: Puntaje Serie Campeones y Revisión Puntaje usan la misma fuente/lógica/formato que el Reporte Deportivo Detalle (fmtP, "1er - 2do - 3er", "—" para null)', async () => {
        const { ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        expect(ws1.getRow(2).getCell(7).value).toBe('10 - — - —');   // San Carlos: dato presente
        expect(ws1.getRow(2).getCell(8).value).toBe('— - — - —');    // sin revisión
        expect(ws1.getRow(3).getCell(7).value).toBe('— - — - —');    // Pucón, sin puntaje oficial
        expect(ws1.getRow(4).getCell(7).value).toBe('— - — - —');    // sin comentario, sin puntaje oficial
    });

    test('con puntaje_analista_* presentes, Revisión Puntaje refleja exactamente esos valores (misma fuente que evaluaciones.puntaje_analista_1er/2do/3er)', async () => {
        respuestas.evaluaciones.data = [
            { id: 'ev1', rodeo_id: ID_SAN_CARLOS, estado: 'cerrada', puntaje_analista_1er: '9', puntaje_analista_2do: '8+', puntaje_analista_3er: null, modo_flujo: null }
        ];
        const { ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        expect(ws1.getRow(2).getCell(8).value).toBe('9 - 8+ - —');
    });

    test('las columnas de puntaje (G, H) usan formato de texto (numFmt "@"), igual que en el Reporte Deportivo Detalle, para no perder valores como "8+"', async () => {
        const { ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        expect(ws1.getColumn(7).numFmt).toBe('@');
        expect(ws1.getColumn(8).numFmt).toBe('@');
    });

    test('PRUEBA 4/5: I (Descripción de lo observado) = evaluaciones.comentario_resultados_alterados exacto, NUNCA observacion_general', async () => {
        respuestas.evaluaciones.data = [{
            id: 'ev1', rodeo_id: ID_SAN_CARLOS, estado: 'cerrada', modo_flujo: null,
            resultados_alterados: true,
            comentario_resultados_alterados: 'Comentario sobre la alteración: se revirtió el 2° lugar.',
            observacion_general: 'Observación general del análisis: jura dentro de los parámetros esperados.'
        }];
        const { ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        const col9 = ws1.getRow(1).values.slice(1).indexOf('Descripción de lo observado') + 1;
        expect(col9).toBe(9);
        expect(ws1.getRow(2).getCell(9).value).toBe('Comentario sobre la alteración: se revirtió el 2° lugar.');
        // Nunca el texto de observación general / análisis:
        expect(ws1.getRow(2).getCell(9).value).not.toBe('Observación general del análisis: jura dentro de los parámetros esperados.');
    });

    test('I: sin comentario_resultados_alterados → "—" (no fabricar descripciones, no concatenar otros comentarios)', async () => {
        const { ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        expect(ws1.getRow(4).getCell(9).value).toBe('—'); // LA CELIA, sin evaluación
    });

    test('H/J: San Carlos exporta el comentario de Monitoreo COMPLETO con saltos de línea (manual previo + bloque CG)', async () => {
        const { ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        const obs = ws1.getRow(2).values.slice(1)[11]; // L = Monitoreo (índice 11, 0-based)
        expect(obs).toBe(COMENTARIO_SAN_CARLOS);
        expect(obs.split('\n').length).toBe(COMENTARIO_SAN_CARLOS.split('\n').length);
    });

    test('Pucón con 0 situaciones exporta su comentario de Monitoreo completo (no depende de control_gestion_situaciones)', async () => {
        const { ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        expect(ws1.getRow(3).values.slice(1)[11]).toBe(COMENTARIO_PUCON);
        expect(supabase.from.mock.calls.map(c => c[0])).not.toContain('control_gestion_situaciones');
    });

    test('PRUEBA 6: L (Monitoreo) es SOLAMENTE el comentario_monitor íntegro — nunca etiquetas/metadatos compuestos', async () => {
        const { ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        const monitoreo = ws1.getRow(3).getCell(12).value; // Pucón
        expect(monitoreo).toBe(COMENTARIO_PUCON);
        // El valor es exactamente el comentario_monitor crudo del fixture — nunca una
        // composición nueva con las etiquetas que el reporte general SÍ usa en otro lado.
        for (const etiquetaProhibida of ['N° situaciones:', 'Categorías:']) {
            // Estas etiquetas SÍ existen en el propio comentario_monitor del fixture (texto libre
            // que el monitor pudo haber escrito así) — lo que se prueba es que la celda es
            // EXACTAMENTE comentario_monitor, no una plantilla nueva generada por este endpoint.
            expect(typeof monitoreo).toBe('string');
        }
        expect(monitoreo).toBe(respuestas.datos_monitor_rodeo.data[1].comentario_monitor);
    });

    test('comentario_monitor NULL, vacío o solo espacios → celda vacía (sin placeholders)', async () => {
        respuestas.datos_monitor_rodeo.data[1].comentario_monitor = '';
        respuestas.datos_monitor_rodeo.data[2].comentario_monitor = '   ';
        const { ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        for (const n of [3, 4]) {
            const v = ws1.getRow(n).getCell(12).value;
            expect(v === null || v === undefined || v === '').toBe(true);
        }
        // sin fila en datos_monitor_rodeo tampoco
        respuestas.datos_monitor_rodeo.data = [];
        const { ws1: ws } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        const v = ws.getRow(2).getCell(12).value;
        expect(v === null || v === undefined || v === '').toBe(true);
    });

    test('Monitoreo (L) con wrapText y alineación superior; altura crece con el contenido', async () => {
        const { ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        const c = ws1.getRow(2).getCell(12);
        expect(c.alignment.wrapText).toBe(true);
        expect(c.alignment.vertical).toBe('top');
        expect(ws1.getRow(2).height).toBeGreaterThan(28);
        expect(ws1.getColumn(12).width).toBeGreaterThanOrEqual(50);
    });

    test('autoFilter cubre A:L (las 12 columnas visibles, sin ninguna oculta)', async () => {
        const { ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        expect(ws1.autoFilter).toBe('A1:L1');
    });

    test('estilos: fila alterada recibe fill también en Monitoreo, con rojo/negrita en Resultado Alterado', async () => {
        respuestas.evaluaciones.data = [{ id: 'ev1', rodeo_id: ID_SAN_CARLOS, estado: 'cerrada', resultados_alterados: true, comentario_resultados_alterados: 'x', modo_flujo: null }];
        const { ws1 } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        const fila = ws1.getRow(2);
        expect(fila.getCell(12).fill.fgColor.argb).toBe('FFFDEBD0');
        expect(fila.getCell(6).font.bold).toBe(true);
        expect(fila.getCell(6).font.color.argb).toBe('FFC0392B');
    });

    test('PRUEBA 7/8: HOJA "Detalle" tiene exactamente 27 columnas A:AA, en el orden exacto pedido', async () => {
        const { wb } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        const wsDetalle = wb.getWorksheet('Detalle');
        expect(wsDetalle).toBeDefined();
        const headers = wsDetalle.getRow(1).values.slice(1);
        expect(headers.length).toBe(27);
        expect(headers).toEqual(HEADERS_DETALLE);
    });

    test('PRUEBA 9/10: Detalle!H (Análisis de la Jura) = evaluaciones.observacion_general exacto; Reporte Fin de Semana!I = comentario_resultados_alterados exacto; nunca se cruzan', async () => {
        respuestas.evaluaciones.data = [{
            id: 'ev1', rodeo_id: ID_SAN_CARLOS, estado: 'cerrada', modo_flujo: null,
            resultados_alterados: true,
            comentario_resultados_alterados: 'Comentario sobre la alteración: se revirtió el 2° lugar.',
            observacion_general: 'Observación general del análisis: jura dentro de los parámetros esperados.'
        }];
        const { ws1, wb } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        const wsDetalle = wb.getWorksheet('Detalle');

        const colAnalisis = wsDetalle.getRow(1).values.slice(1).indexOf('Análisis de la Jura') + 1;
        expect(colAnalisis).toBe(8);
        expect(wsDetalle.getRow(2).getCell(8).value).toBe('Observación general del análisis: jura dentro de los parámetros esperados.');

        const colDescripcion = ws1.getRow(1).values.slice(1).indexOf('Descripción de lo observado') + 1;
        expect(ws1.getRow(2).getCell(colDescripcion).value).toBe('Comentario sobre la alteración: se revirtió el 2° lugar.');

        // Nunca cruzados: el valor de Detalle!H no debe coincidir con el de Reporte Fin de Semana!I, y viceversa.
        expect(wsDetalle.getRow(2).getCell(8).value).not.toBe(ws1.getRow(2).getCell(colDescripcion).value);
    });

    test('Detalle!I (Resultado Alterado) mantiene "Sí: [comentario de alteración]" / "No" — no usa Análisis de la Jura para completarse', async () => {
        respuestas.evaluaciones.data = [{
            id: 'ev1', rodeo_id: ID_SAN_CARLOS, estado: 'cerrada', modo_flujo: null,
            resultados_alterados: true,
            comentario_resultados_alterados: 'Se revirtió el 2° lugar.',
            observacion_general: 'Jura dentro de los parámetros esperados.'
        }];
        const { wb } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        const wsDetalle = wb.getWorksheet('Detalle');
        expect(wsDetalle.getRow(2).getCell(9).value).toBe('Sí: Se revirtió el 2° lugar.');
        expect(wsDetalle.getRow(3).getCell(9).value).toBe('No'); // Pucón, sin evaluación
    });

    test('PRUEBA 11: Reporte Fin de Semana!L es solo comentario monitor, mientras Detalle!R conserva la composición amplia de Observaciones', async () => {
        respuestas.evaluaciones.data = [{
            id: 'ev1', rodeo_id: ID_SAN_CARLOS, estado: 'cerrada', modo_flujo: null,
            resultados_alterados: false, observacion_general: 'análisis x'
        }];
        const { ws1, wb } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        const wsDetalle = wb.getWorksheet('Detalle');

        expect(ws1.getRow(2).getCell(12).value).toBe(COMENTARIO_SAN_CARLOS); // L, solo monitor

        const colObs = wsDetalle.getRow(1).values.slice(1)
            .indexOf('Observaciones (Jurado / Analista / Jefe / Monitor / Admin)') + 1;
        expect(colObs).toBe(18);
        // Detalle!R SÍ compone por etiqueta (incluye "MONITOR: ..."), a diferencia de Reporte Fin de Semana!L.
        expect(wsDetalle.getRow(2).getCell(18).value).toContain('MONITOR:');
        expect(wsDetalle.getRow(2).getCell(18).value).not.toBe(COMENTARIO_SAN_CARLOS);
    });

    test('PRUEBA 12 (corrección posterior): Hoja "Colleras completas" presente solo con resumen superior + comparativa en texto — SIN la tabla completa de colleras', async () => {
        const { wb } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        const ws2 = wb.getWorksheet('Colleras completas');
        expect(ws2).toBeDefined();
        expect(ws2.getCell(1, 1).value).toBe('1 COLLERAS COMPLETAS AL ' + ws2.getCell(1, 1).value.split(' AL ')[1]);

        const texto = [];
        ws2.eachRow(row => row.eachCell({ includeEmpty: false }, cell => { if (typeof cell.value === 'string') texto.push(cell.value); }));
        const textoCompleto = texto.join(' | ');
        expect(textoCompleto).toContain('Total colleras completas:');
        expect(textoCompleto).toContain('Total zona norte:');
        expect(textoCompleto).toContain('Total zona centro:');
        expect(textoCompleto).toContain('Total zona sur:');
        expect(textoCompleto).toContain('Colleras centro norte:');
        expect(textoCompleto).toContain('Colleras centro sur:');
        expect(textoCompleto).toMatch(/COMPARATIVA COLLERAS COMPLETAS AL/);
        expect(textoCompleto).toMatch(/Temporada actual/);
        expect(textoCompleto).toMatch(/Temporada anterior/);
        expect(textoCompleto).toContain('Diferencia:');
        expect(textoCompleto).toContain('Variación:');

        // Sin tabla de detalle: ningún encabezado ni fila individual de colleras.
        for (const header of ['CABALLO 1', 'CABALLO 2', 'SEXO (CRIADERO)', 'PTJ', 'JINETES', 'ZONA CLASIF.']) {
            expect(textoCompleto).not.toContain(header);
        }
        expect(buscarFilaConValor(ws2, 1, 'CABALLO 1')).toBe(-1);
    });

    test('PRUEBA 13 (corrección posterior): Colleras completas NO contiene ningún gráfico/imagen — CERO, siempre', async () => {
        const { wb } = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana');
        const ws2 = wb.getWorksheet('Colleras completas');
        expect(ws2.getImages().length).toBe(0);
        expect(wb.model.media.length).toBe(0);
    });

    test('502 sin generar archivo si falla la fuente de Colleras Completas', async () => {
        obtenerCollerasCompletas.mockRejectedValueOnce(new Error('caída'));
        const res = await llamar('/export-fin-semana');
        expect(res.statusCode).toBe(502);
        expect(res.getBuffer().length).toBe(0);
    });

    test('respeta los mismos filtros que el Directorio (mismo conjunto de llamadas de filtro sobre rodeos)', async () => {
        const query = { fecha_desde: '2026-09-17', fecha_hasta: '2026-09-20', asociacion: 'ÑUBLE', club: 'SAN' };

        llamadas = [];
        await llamar('/export-directorio', query);
        const filtrosDir = llamadas.filter(c => c.tabla === 'rodeos' && ['gte', 'lte', 'ilike', 'eq', 'in'].includes(c.m));

        llamadas = [];
        await llamar('/export-fin-semana', query);
        const filtrosFin = llamadas.filter(c => c.tabla === 'rodeos' && ['gte', 'lte', 'ilike', 'eq', 'in'].includes(c.m));

        expect(filtrosFin).toEqual(filtrosDir);
        expect(filtrosFin.map(c => c.m)).toEqual(expect.arrayContaining(['gte', 'lte', 'ilike']));

        // Mismo conjunto de rodeos (Club+Fecha, en el mismo orden) entre Directorio y Fin de Semana —
        // ya no hay columna oculta "Rodeo ID" en Fin de Semana (eliminada a propósito en esta tarea).
        const dir = await cargarHoja1('/export-directorio', 'Reporte Deportivo', query);
        const fin = await cargarHoja1('/export-fin-semana', 'Reporte Fin de Semana', query);
        const clavesDir = dir.ws1.getColumn(1).values.slice(2).map((f, i) => `${f}|${dir.ws1.getColumn(2).values.slice(2)[i]}`);
        const clavesFin = fin.ws1.getColumn(1).values.slice(2).map((f, i) => `${f}|${fin.ws1.getColumn(2).values.slice(2)[i]}`);
        expect(clavesFin).toEqual(clavesDir);
    });

    test('PRUEBA 16: /export-directorio no cambia (15 columnas, sin Obs. Monitor, autoFilter A1:N1, hoja "Reporte Deportivo")', async () => {
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
        expect(wb.getWorksheet('Detalle')).toBeUndefined();
        expect(wb.getWorksheet('Colleras completas')).toBeDefined();
    });

    test('PRUEBA 17: /export y /export-detalle (Exportar Excel / Exportar Excel Detallado) no fueron modificados por esta tarea', async () => {
        const resExport = await llamar('/export');
        expect(resExport.statusCode).toBe(200);
        const wbExport = new ExcelJS.Workbook();
        await wbExport.xlsx.load(resExport.getBuffer());
        expect(wbExport.getWorksheet('Reporte Deportivo')).toBeDefined();

        const resDetalle = await llamar('/export-detalle');
        expect(resDetalle.statusCode).toBe(200);
        const wbDetalle = new ExcelJS.Workbook();
        await wbDetalle.xlsx.load(resDetalle.getBuffer());
        const wsDetalleOriginal = wbDetalle.getWorksheet('Reporte Deportivo Detalle');
        expect(wsDetalleOriginal).toBeDefined();
        expect(wsDetalleOriginal.getRow(1).values.slice(1)).toEqual(HEADERS_DETALLE);
    });

    test('PRUEBA 15: el XLSX generado es válido y se puede releer sin errores (archivo no corrupto)', async () => {
        const res = await llamar('/export-fin-semana');
        const wb = new ExcelJS.Workbook();
        await expect(wb.xlsx.load(res.getBuffer())).resolves.not.toThrow();
        expect(wb.worksheets.length).toBe(3);
    });
});
