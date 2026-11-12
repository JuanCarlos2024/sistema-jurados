// Reporte "Historial de Designaciones": la pantalla (GET /) y el Excel
// (GET /exportar) usan la misma consulta y los mismos filtros. El Excel se
// genera con ExcelJS REAL y se vuelve a leer.
jest.mock('../../config/supabase', () => require('../../services/resumenJurados.testkit').fake);

const { Writable } = require('stream');
const ExcelJS = require('exceljs');
const kit = require('../../services/resumenJurados.testkit');
const router = require('./historial-designaciones');

// Reutiliza el dataset del test del servicio sin duplicarlo.
const ADMIN = { id: 'adm-1', nombre_completo: 'Ana Administradora' };
function dataset() {
    const r = (id, fecha, extra = {}) => ({ id, club: `Club ${id}`, asociacion: `Asoc ${id}`, fecha, duracion_dias: 1, tipo_rodeo_nombre: 'Provincial', temporada_id: 'T26', estado: 'activo', tipos_rodeo: { clasificaciones_designacion: { nombre: 'Provincial' } }, ...extra });
    return {
        administradores: [ADMIN],
        usuarios_pagados: [{ id: 'jA', nombre_completo: 'Jurado Á', categoria: 'B' }, { id: 'jB', nombre_completo: 'Jurado Ñandú', categoria: 'C' }, { id: 'jC', nombre_completo: 'Jurado C', categoria: 'A' }],
        temporadas: [{ id: 'T26', nombre: '2026-2027' }],
        rodeos: [r('R1', '2026-11-14'), r('R2', '2026-11-15'), r('R3', '2026-11-13', { duracion_dias: 2 }), r('R9', '2026-12-20')],
        propuestas_designacion: [{ id: 'P1', estado: 'BORRADOR', creado_por: ADMIN.id, created_at: '2026-11-01T13:16:36Z', configuracion_version_id: 'c', motor_usado: 'global', fecha_corte_tecnica: '2026-11-01T13:16:00Z', resultado_cobertura_json: { total_cupos: 3, cobertura_obtenida: 3, estado_busqueda: 'COBERTURA_COMPLETA' }, configuracion_designacion_versiones: { numero_version: 12 } }],
        propuestas_designacion_detalle: ['R1', 'R2', 'R3'].map((rid, i) => ({ id: `D${i + 1}`, propuesta_id: 'P1', rodeo_id: rid, jurado_id_propuesto: 'jA', jurado_id_seleccionado: null, estado_revision: 'PENDIENTE', origen_seleccion: null, explicacion_json: { jurado_propuesto: { jurado_id: 'jA', categoria: 'A' } }, metricas_json: {}, created_at: '2026-11-01T13:16:36Z', updated_at: '2026-11-01T13:16:36Z' })),
        asignaciones: [{ id: 'AS1', rodeo_id: 'R1', usuario_pagado_id: 'jB', tipo_persona: 'jurado', estado: 'activo', estado_designacion: 'aceptado', publicado: true, publicado_en: '2026-11-03T11:00:00Z', publicado_por: ADMIN.id, propuesta_detalle_id: 'D1', nombre_importado: null, categoria_aplicada: 'C', created_at: '2026-11-03T10:00:00Z', updated_at: '2026-11-03T10:00:00Z', created_by: ADMIN.id, aceptado_en: '2026-11-04T08:00:00Z', observacion_designacion: null }],
        bitacora_designaciones: [
            { id: 'B1', rodeo_id: 'R1', tipo_movimiento: 'aplicacion_propuesta', propuesta_detalle_id: 'D1', asignacion_id: 'AS1', usuario_pagado_id_anterior: null, nombre_anterior_snapshot: null, usuario_pagado_id_nuevo: 'jA', nombre_nuevo_snapshot: 'Jurado Á', motivo_catalogo_id: null, motivo_detalle: null, actor_id: ADMIN.id, fecha_efectiva: '2026-11-03T10:00:00Z', created_at: '2026-11-03T10:00:00Z', operacion_id: null, catalogo_motivos_designacion: null },
            { id: 'B2', rodeo_id: 'R1', tipo_movimiento: 'reemplazo', propuesta_detalle_id: null, asignacion_id: 'AS1', usuario_pagado_id_anterior: 'jA', nombre_anterior_snapshot: 'Jurado Á', usuario_pagado_id_nuevo: 'jB', nombre_nuevo_snapshot: 'Jurado Ñandú', motivo_catalogo_id: 'm', motivo_detalle: 'Enfermó el viernes', actor_id: ADMIN.id, fecha_efectiva: '2026-11-13T21:30:00Z', created_at: '2026-11-13T21:30:00Z', operacion_id: null, catalogo_motivos_designacion: { codigo: 'ENF', etiqueta: 'Enfermedad' } },
        ],
        auditoria: [],
    };
}

function crearRes() {
    const chunks = [];
    const res = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    res.statusCode = 200; res.headers = {};
    res.setHeader = (k, v) => { res.headers[k] = v; };
    res.status = c => { res.statusCode = c; return res; };
    res.json = b => { res.body = b; res.end(); return res; };
    res.buffer = () => Buffer.concat(chunks);
    return res;
}
function llamar(url, query, rol = null) {
    return new Promise((resolve, reject) => {
        const res = crearRes();
        res.on('finish', () => resolve(res));
        const req = { method: 'GET', url, originalUrl: url, query, params: {}, headers: {}, usuario: { id: ADMIN.id, rol_evaluacion: rol }, get() { return undefined; } };
        router(req, res, err => (err ? reject(err) : resolve(Object.assign(res, { statusCode: 404 }))));
    });
}
const valor = c => (c.value && typeof c.value === 'object' && 'result' in c.value ? c.value.result : c.value);

beforeEach(() => kit.cargarDataset(dataset()));

describe('Reporte Historial de Designaciones', () => {
    const FIN_DE_SEMANA = { fecha_desde: '2026-11-14', fecha_hasta: '2026-11-15' };

    test('exportación del fin de semana completo: incluye el rodeo de 2 días que empezó el viernes', async () => {
        const res = await llamar('/', FIN_DE_SEMANA);
        expect(res.statusCode).toBe(200);
        expect(res.body.rodeos.map(r => r.rodeo.id)).toEqual(['R3', 'R1', 'R2']);
    });

    test('pantalla y Excel: mismos rodeos, mismos eventos, mismos valores (3 hojas)', async () => {
        const web = (await llamar('/', FIN_DE_SEMANA)).body;
        const resX = await llamar('/exportar', FIN_DE_SEMANA);
        expect(resX.statusCode).toBe(200);
        expect(resX.headers['Content-Type']).toMatch(/spreadsheetml/);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(resX.buffer());
        expect(wb.worksheets.map(w => w.name)).toEqual(['Resumen por rodeo', 'Historial cronológico', 'Propuesta original del motor']);

        const h1 = wb.getWorksheet('Resumen por rodeo');
        const filas1 = [];
        for (let i = 5; i <= h1.rowCount; i++) filas1.push(h1.getRow(i));
        expect(filas1.map(r => r.getCell(3).value)).toEqual(web.rodeos.map(r => r.resumen.club));
        // Jurados con su categoría: la del motor (A) cuando existe, aclarando
        // que hoy es B; la vigente, la aplicada en la designación (C).
        expect(filas1.map(r => r.getCell(9).value)).toEqual(['Jurado Á [Cat. A, hoy B]', 'Jurado Á [Cat. A, hoy B]', 'Jurado Á [Cat. A, hoy B]']);
        expect(web.rodeos.map(r => r.resumen.jurado_propuesto_original)).toEqual(['Jurado Á', 'Jurado Á', 'Jurado Á']); // texto existente intacto
        expect(web.rodeos[0].resumen.jurado_propuesto_original_jurado).toMatchObject({ id: 'jA', categoria: 'A', categoria_fuente: 'MOTOR', categoria_actual: 'B' });
        expect(filas1.map(r => r.getCell(10).value)).toEqual(web.rodeos.map(r => r.resumen.jurado_confirmado_admin));
        expect(filas1.map(r => r.getCell(11).value)).toEqual(web.rodeos.map(r => r.resumen.decision_borrador));
        expect(filas1.map(r => r.getCell(12).value)).toEqual(['Sin jurado vigente', 'Jurado Ñandú [Cat. C]', 'Sin jurado vigente']);
        expect(web.rodeos[1].resumen.jurado_vigente_jurados).toEqual([{ id: 'jB', nombre: 'Jurado Ñandú', categoria: 'C', categoria_fuente: 'DESIGNACION', categoria_actual: 'C' }]);
        expect(h1.getCell('A2').value).toMatch(/\[Cat\. X, actual\] = categoría actual del jurado/);
        expect(filas1.map(r => r.getCell(15).value)).toEqual(web.rodeos.map(r => r.resumen.reemplazos_posteriores));
        // Fecha de rodeo como fecha real, sin corrimiento
        expect(filas1[0].getCell(1).value.toISOString().slice(0, 10)).toBe('2026-11-13');
        expect(filas1[0].getCell(1).numFmt).toBe('dd/mm/yyyy');

        const h2 = wb.getWorksheet('Historial cronológico');
        const eventosWeb = web.rodeos.flatMap(r => r.eventos.map(e => [r.rodeo.club, e.etiqueta, e.origen]));
        const eventosXls = [];
        for (let i = 5; i <= h2.rowCount; i++) { const row = h2.getRow(i); eventosXls.push([row.getCell(3).value, row.getCell(5).value, row.getCell(6).value]); }
        expect(eventosXls).toEqual(eventosWeb);

        const h3 = wb.getWorksheet('Propuesta original del motor');
        expect(h3.rowCount - 4).toBe(web.propuesta_original.length);
        [h1, h2, h3].forEach(h => { expect(h.autoFilter).toBeTruthy(); expect(h.getRow(4).getCell(1).fill.fgColor.argb).toBe('FF1E3A5F'); });
    });

    test('Excel: reemplazo con motivo, responsable y hora de Chile; tildes y ñ intactas', async () => {
        const resX = await llamar('/exportar', { fecha_desde: '2026-11-14', fecha_hasta: '2026-11-14' });
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(resX.buffer());
        const h2 = wb.getWorksheet('Historial cronológico');
        let fila = null;
        for (let i = 5; i <= h2.rowCount; i++) if (String(h2.getRow(i).getCell(5).value).startsWith('Reemplazo')) fila = h2.getRow(i);
        expect(fila).not.toBeNull();
        expect(fila.getCell(7).value).toBe('Jurado Á [Cat. A, hoy B]'); // registrada por el motor en la propuesta aplicada
        expect(fila.getCell(8).value).toBe('Jurado Ñandú [Cat. C]');    // aplicada en la designación (reemplazo)
        expect(fila.getCell(9).value).toBe('Ana Administradora');
        expect(fila.getCell(10).value).toBe('Enfermedad');
        expect(fila.getCell(11).value).toBe('Enfermó el viernes');
        // 13-11-2026 21:30 UTC = 18:30 hora de Chile (UTC-3 en verano)
        const f = valor(fila.getCell(1));
        expect(f.getUTCHours()).toBe(18);
        expect(f.getUTCDate()).toBe(13);
    });

    test('historial de un rodeo (mismo endpoint para Rodeos y Propuesta)', async () => {
        const res = await llamar('/rodeo/R1', {});
        expect(res.statusCode).toBe(200);
        expect(res.body.rodeo.id).toBe('R1');
        expect(res.body.eventos[res.body.eventos.length - 1]).toMatchObject({ tipo: 'ESTADO_FINAL', jurado_nuevo: { id: 'jB' } });
        expect((await llamar('/rodeo/NO-EXISTE', {})).statusCode).toBe(404);
    });

    test('validaciones de filtros y catálogos', async () => {
        expect((await llamar('/', { fecha_desde: '14/11/2026' })).statusCode).toBe(400);
        expect((await llamar('/', { tipo_movimiento: 'INVENTADO' })).statusCode).toBe(400);
        const cat = (await llamar('/catalogos', {})).body;
        expect(cat.origenes).toEqual(['MOTOR', 'ADMINISTRADOR', 'JURADO', 'SISTEMA']);
        expect(cat.tipos.map(t => t.codigo)).toContain('REEMPLAZO');
    });

    test('permisos: administrador pleno y Director; otros perfiles no', async () => {
        expect((await llamar('/', {}, 'director')).statusCode).toBe(200);
        expect((await llamar('/', {}, 'monitor')).statusCode).toBe(403);
        expect((await llamar('/exportar', {}, 'analista')).statusCode).toBe(403);
    });
});
