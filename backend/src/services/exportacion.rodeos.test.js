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

// Lee valor + color de fuente de UNA celda (fila de datos 1-based: la
// primera fila de datos es filaDatos=1, columna 1-based con COL.X + 1).
async function leerCelda(res, filaDatos, colIndex0Based) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.getBuffer());
    const ws = wb.getWorksheet('Rodeos');
    const cell = ws.getRow(filaDatos + 1).getCell(colIndex0Based + 1);
    return { value: cell.value, fontColor: cell.font && cell.font.color ? cell.font.color.argb : null };
}

// Índices de columna (0-based) sobre el orden final (Panel de Gestión
// Deportiva, Prioridad 1/4): se agrega "Requiere corrección" y "Nota Final"
// pasa a ser "Nota Área Deportiva" (fuente notas_rodeo por jurado, nunca
// evaluaciones.nota_final — ver Prioridad 4).
// Fecha,Club,Asociación,Tipo Rodeo,Días,Jurado,Estado designación,Jurados,
// Cartilla Jurado,Cartilla Delegado,Requiere corrección,Video,
// Nota Comisión,Nota Delegado,Nota Área Deportiva,Total Pagos
const COL = {
    FECHA: 0, CLUB: 1, ASOC: 2, TIPO: 3, DIAS: 4, JURADO: 5, ESTADO_DES: 6, JURADOS: 7,
    CJ: 8, CD: 9, CORRECCION: 10, VIDEO: 11, NOTA_COM: 12, NOTA_DEL: 13, NOTA_AD: 14, TOTAL: 15
};

const RODEO_BASE = { id: 'r1', club: 'CLUB', asociacion: 'X', fecha: '2026-09-18', tipo_rodeo_nombre: 'Libre', duracion_dias: 1, origen: 'manual', estado: 'activo' };

describe('exportarRodeos — columnas (Jurado/Estado designación ya existentes + Cartillas/Video nuevas, Origen eliminado)', () => {
    test('orden de columnas final: Fecha,Club,Asociación,Tipo Rodeo,Días,Jurado,Estado designación,Jurados,Cartilla Jurado,Cartilla Delegado,Requiere corrección,Video,Nota Comisión,Nota Delegado,Nota Área Deportiva,Total Pagos', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { headers } = await leerFilas(res);
        expect(headers).toEqual([
            'Fecha', 'Club', 'Asociación', 'Tipo Rodeo', 'Días',
            'Jurado', 'Estado designación', 'Jurados',
            'Cartilla Jurado', 'Cartilla Delegado', 'Requiere corrección', 'Video',
            'Nota Comisión', 'Nota Delegado', 'Nota Área Deportiva', 'Total Pagos'
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

    test('CASO 1 del pedido — CJ ✓ CD oficial ✓ VV ✓ -> Cartilla Jurado=Sí, Cartilla Delegado=Sí, Video=Sí', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        respuestas.rodeo_adjuntos = { data: [
            { rodeo_id: 'r1', tipo_adjunto: 'cartilla_jurado' },
            { rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', cartilla_clasificacion: 'version_cartilla' }
        ], error: null };
        respuestas.rodeo_links = { data: [{ rodeo_id: 'r1' }], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { filas } = await leerFilas(res);
        expect(filas[0][COL.CJ]).toBe('Sí');
        expect(filas[0][COL.CD]).toBe('Sí');
        expect(filas[0][COL.VIDEO]).toBe('Sí');
    });

    test('CASO 2 del pedido — CJ ✓ CD oficial ✓ VV sin check -> Video=No', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        respuestas.rodeo_adjuntos = { data: [
            { rodeo_id: 'r1', tipo_adjunto: 'cartilla_jurado' },
            { rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', cartilla_clasificacion: 'version_cartilla' }
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

    // ─── PRIORIDAD 1 (corrección del bug real): el chequeo anterior contaba
    // CUALQUIER adjunto tipo_adjunto='cartilla_delegado' como "Sí", sin
    // mirar su clasificación — un documento complementario o todavía sin
    // clasificar quedaba indistinguible de una cartilla oficial recibida.
    test('PRIORIDAD 1 — adjunto de Cartilla Delegado SIN clasificar (pendiente) NUNCA cuenta como recibida', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        respuestas.rodeo_adjuntos = { data: [{ rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', cartilla_clasificacion: 'pendiente' }], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { filas } = await leerFilas(res);
        expect(filas[0][COL.CD]).toBe('No');
    });
    test('PRIORIDAD 1 — adjunto clasificado "complementario" NUNCA certifica la cartilla real', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        respuestas.rodeo_adjuntos = { data: [{ rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', cartilla_clasificacion: 'complementario' }], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { filas } = await leerFilas(res);
        expect(filas[0][COL.CD]).toBe('No');
    });
    test('PRIORIDAD 1 — cartilla digital en "observada" marca "Requiere corrección"=Sí, pero Cartilla Delegado sigue "Sí" (existió un envío)', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        respuestas.cartillas_delegado = { data: [{ rodeo_id: 'r1', estado: 'observada', delegado_id: null, delegado_asociacion_id: 'asoc1' }], error: null };
        respuestas.asignaciones = { data: [], error: null };
        respuestas.rodeo_adjuntos = { data: [], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { filas } = await leerFilas(res);
        expect(filas[0][COL.CD]).toBe('Sí');
        expect(filas[0][COL.CORRECCION]).toBe('Sí');
    });
    test('PRIORIDAD 1 — delegado rentado ya reemplazado: su cartilla "enviada" nunca se informa como vigente del rodeo', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        respuestas.cartillas_delegado = { data: [{ rodeo_id: 'r1', estado: 'enviada', delegado_id: 'delViejo', delegado_asociacion_id: null }], error: null };
        respuestas.asignaciones = { data: [{ rodeo_id: 'r1', usuario_pagado_id: 'delNuevo', estado_designacion: 'aceptado', created_at: '2026-01-01' }], error: null };
        respuestas.rodeo_adjuntos = { data: [], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { filas } = await leerFilas(res);
        expect(filas[0][COL.CD]).toBe('No');
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
            { rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', cartilla_clasificacion: 'version_cartilla' }
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

describe('exportarRodeos — Nota Comisión / Nota Delegado (rodeo_notas_secundarias)', () => {
    test('las dos notas existen -> valores NUMÉRICOS exactos', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        respuestas.rodeo_notas_secundarias = { data: [{ rodeo_id: 'r1', nota_comision: 7, nota_delegado: 6.5 }], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { filas } = await leerFilas(res);
        expect(filas[0][COL.NOTA_COM]).toBe(7);
        expect(filas[0][COL.NOTA_DEL]).toBe(6.5);
        expect(typeof filas[0][COL.NOTA_COM]).toBe('number');
        expect(typeof filas[0][COL.NOTA_DEL]).toBe('number');
    });

    test('Nota Comisión presente, Nota Delegado NULL -> "Pendiente" en rojo', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        respuestas.rodeo_notas_secundarias = { data: [{ rodeo_id: 'r1', nota_comision: 7, nota_delegado: null }], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { filas } = await leerFilas(res);
        expect(filas[0][COL.NOTA_COM]).toBe(7);
        expect(filas[0][COL.NOTA_DEL]).toBe('Pendiente');
        const celda = await leerCelda(res, 1, COL.NOTA_DEL);
        expect(celda.fontColor).toBe('FFCC0000'); // rojo
    });

    test('sin ninguna nota (sin fila en rodeo_notas_secundarias) -> las 2 "Pendiente", en rojo', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        respuestas.rodeo_notas_secundarias = { data: [], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { filas } = await leerFilas(res);
        expect(filas[0][COL.NOTA_COM]).toBe('Pendiente');
        expect(filas[0][COL.NOTA_DEL]).toBe('Pendiente');
        for (const col of [COL.NOTA_COM, COL.NOTA_DEL]) {
            const celda = await leerCelda(res, 1, col);
            expect(celda.fontColor).toBe('FFCC0000');
        }
    });

    test('nota existente NO se transforma en 0 ni en texto — se preserva el valor numérico exacto, incluso decimales', async () => {
        respuestas.rodeos = { data: [{ ...RODEO_BASE, id: 'r1' }, { ...RODEO_BASE, id: 'r2' }], error: null };
        respuestas.rodeo_notas_secundarias = { data: [{ rodeo_id: 'r1', nota_comision: 1.0, nota_delegado: 7.0 }], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { filas } = await leerFilas(res);
        // Nota mínima real (1.0) nunca debe confundirse con "ausente" (0/Pendiente).
        expect(filas[0][COL.NOTA_COM]).toBe(1);
        expect(filas[0][COL.NOTA_DEL]).toBe(7);
        expect(filas[0][COL.NOTA_COM]).not.toBe('Pendiente');
        // r2 sin ninguna fila -> Pendiente (no cae a 0 tampoco)
        expect(filas[1][COL.NOTA_COM]).toBe('Pendiente');
        expect(filas[1][COL.NOTA_COM]).not.toBe(0);
    });

    test('no se introduce una consulta por rodeo (N+1) al cargar notas — 1 llamada fija independiente de la cantidad de rodeos', async () => {
        respuestas.rodeos = { data: [
            { ...RODEO_BASE, id: 'r1' }, { ...RODEO_BASE, id: 'r2' }, { ...RODEO_BASE, id: 'r3' }
        ], error: null };
        respuestas.rodeo_notas_secundarias = { data: [], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const llamadasNotas = supabase.from.mock.calls.filter(c => c[0] === 'rodeo_notas_secundarias');
        expect(llamadasNotas.length).toBe(1);
    });
});

// Prioridad 4: "Nota Final" pasa a ser "Nota Área Deportiva" — fuente
// notas_rodeo POR JURADO (vía asignacion_id), fuente='evaluacion_tecnica'
// exclusivamente; evaluaciones.nota_final ya NO se usa para esta columna
// (es un concepto distinto, ver rodeosListado.cargarNotasPorRodeo).
describe('exportarRodeos — Nota Área Deportiva (Prioridad 4, notas_rodeo por jurado)', () => {
    test('un jurado con nota técnica real -> "Nombre: nota"', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        respuestas.asignaciones = { data: [{ id: 'a1', rodeo_id: 'r1', usuario_pagado_id: 'j1', nombre_importado: null, usuarios_pagados: { nombre_completo: 'Juan Pérez' } }], error: null };
        respuestas.notas_rodeo = { data: [{ asignacion_id: 'a1', nota: 6.5, fuente: 'evaluacion_tecnica' }], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { filas } = await leerFilas(res);
        expect(filas[0][COL.NOTA_AD]).toBe('Juan Pérez: 6.5');
    });

    test('sin ningún jurado activo ni nota -> "Pendiente" en rojo (nunca 0/vacío)', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        respuestas.asignaciones = { data: [], error: null };
        respuestas.notas_rodeo = { data: [], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { filas } = await leerFilas(res);
        expect(filas[0][COL.NOTA_AD]).toBe('Pendiente');
        const celda = await leerCelda(res, 1, COL.NOTA_AD);
        expect(celda.fontColor).toBe('FFCC0000');
    });

    test('nota fuente="manual" (histórica importada) se rotula explícitamente, nunca se confunde con una evaluación técnica real', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        respuestas.asignaciones = { data: [{ id: 'a1', rodeo_id: 'r1', usuario_pagado_id: 'j1', nombre_importado: null, usuarios_pagados: { nombre_completo: 'Juan Pérez' } }], error: null };
        respuestas.notas_rodeo = { data: [{ asignacion_id: 'a1', nota: 5.0, fuente: 'manual' }], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { filas } = await leerFilas(res);
        expect(filas[0][COL.NOTA_AD]).toBe('Juan Pérez: 5 (histórica)');
    });

    test('dos jurados en el mismo rodeo -> ambas notas separadas, con sus nombres', async () => {
        respuestas.rodeos = { data: [RODEO_BASE], error: null };
        respuestas.asignaciones = {
            data: [
                { id: 'a1', rodeo_id: 'r1', usuario_pagado_id: 'j1', nombre_importado: null, usuarios_pagados: { nombre_completo: 'Jurado Uno' } },
                { id: 'a2', rodeo_id: 'r1', usuario_pagado_id: 'j2', nombre_importado: null, usuarios_pagados: { nombre_completo: 'Jurado Dos' } }
            ], error: null
        };
        respuestas.notas_rodeo = { data: [{ asignacion_id: 'a1', nota: 6, fuente: 'evaluacion_tecnica' }, { asignacion_id: 'a2', nota: 7, fuente: 'evaluacion_tecnica' }], error: null };
        const res = crearResFake();
        await exportarRodeos({}, res);
        const { filas } = await leerFilas(res);
        expect(filas[0][COL.NOTA_AD]).toBe('Jurado Uno: 6 / Jurado Dos: 7');
    });
});
