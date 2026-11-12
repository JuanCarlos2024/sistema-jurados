/**
 * Excel "Historial de Designaciones" (presentación al Directorio).
 * Recibe EXACTAMENTE el objeto de obtenerHistorialDesignaciones() — el mismo
 * que muestra la pantalla —, así que pantalla y archivo no pueden divergir.
 * Tres hojas: Resumen por rodeo, Historial cronológico, Propuesta original
 * del motor. Solo lectura; no modifica nada.
 */
const ExcelJS = require('exceljs');
const { SIN_INFO } = require('./historialDesignaciones');

const AZUL = 'FF1E3A5F';
const ALTERNA = 'FFF5F8FC';
const NUMFMT_FECHA = 'dd/mm/yyyy';
const NUMFMT_FECHA_HORA = 'dd/mm/yyyy hh:mm';

// Fecha de rodeo (DATE "YYYY-MM-DD") → Date UTC a medianoche, sin corrimiento.
function fechaDia(iso) {
    if (!iso) return null;
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return y && m && d ? new Date(Date.UTC(y, m - 1, d)) : null;
}
// Timestamp → fecha/hora de Chile representada como "hora de pared" para
// que Excel muestre la hora local real (Excel no maneja zonas horarias).
function fechaHoraChile(iso) {
    if (!iso) return null;
    const t = new Date(iso);
    if (isNaN(t)) return null;
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(t).map(x => [x.type, x.value]));
    return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second));
}
// Nombre del jurado + categoría: "Nombre [Cat. C]" (registro histórico:
// designación o snapshot del motor) o "Nombre [Cat. C, actual]" cuando solo
// existe la categoría actual del jurado (nunca se presenta como histórica).
function etiquetaCategoria(j) {
    if (!j || !j.id) return '';
    if (!j.categoria) return ' [Sin categoría registrada]';
    if (j.categoria_fuente === 'ACTUAL') return ` [Cat. ${j.categoria}, actual]`;
    return j.categoria_actual && j.categoria_actual !== j.categoria ? ` [Cat. ${j.categoria}, hoy ${j.categoria_actual}]` : ` [Cat. ${j.categoria}]`;
}
const nombreJur = j => (j ? ((j.nombre || j.id || '') + etiquetaCategoria(j)) || null : null);
const LEYENDA_CATEGORIA = 'Categoría: [Cat. X] = registrada en la designación o por el motor; [Cat. X, actual] = categoría actual del jurado, sin registro de la fecha del evento; "hoy Y" = la categoría cambió después';

function hoja(wb, nombre, columnas, filas, { filaTitulo, subtitulo }) {
    const ws = wb.addWorksheet(nombre, { views: [{ state: 'frozen', ySplit: 4 }] });
    columnas.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });
    ws.getCell('A1').value = filaTitulo;
    ws.getCell('A1').font = { bold: true, size: 14, color: { argb: AZUL } };
    ws.getCell('A2').value = subtitulo;
    ws.getCell('A2').font = { italic: true, color: { argb: 'FF555555' } };
    const hdr = ws.getRow(4);
    hdr.values = columnas.map(c => c.header);
    hdr.height = 30;
    hdr.eachCell(c => {
        c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL } };
        c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    filas.forEach((valores, i) => {
        const row = ws.getRow(5 + i);
        row.values = valores;
        columnas.forEach((c, j) => {
            const cell = row.getCell(j + 1);
            if (c.numFmt) cell.numFmt = c.numFmt;
            cell.alignment = { vertical: 'top', wrapText: !!c.wrap };
            if (i % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ALTERNA } };
        });
    });
    const ultima = 4 + Math.max(filas.length, 1);
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: ultima, column: columnas.length } };
    return ws;
}

function construirLibroHistorial(historial, { descripcionFiltros = 'Sin filtros adicionales', generado = new Date() } = {}) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Sistema Jurados - Rodeo Chileno';
    wb.created = generado;
    const sub = `Filtros: ${descripcionFiltros} · Generado: ${generado.toLocaleString('es-CL', { timeZone: 'America/Santiago' })} · Horas en hora de Chile`;

    // ── Hoja 1 ──
    const c1 = [
        { header: 'Fecha del rodeo', width: 12, numFmt: NUMFMT_FECHA },
        { header: 'Días', width: 6 },
        { header: 'Club', width: 24, wrap: true },
        { header: 'Asociación', width: 22, wrap: true },
        { header: 'Tipo de rodeo', width: 24, wrap: true },
        { header: 'Clasificación', width: 16, wrap: true },
        { header: 'Propuesta aplicada', width: 38 },
        { header: 'Versión configuración', width: 12 },
        { header: 'Jurado originalmente propuesto', width: 28, wrap: true },
        { header: 'Jurado confirmado por administración', width: 30, wrap: true },
        { header: 'Decisión individual en el borrador (según evidencia)', width: 34, wrap: true },
        { header: 'Jurado finalmente vigente', width: 28, wrap: true },
        { header: 'Estado actual de la designación', width: 26, wrap: true },
        { header: 'Modificaciones administrativas', width: 14 },
        { header: 'Reemplazos posteriores', width: 12 },
        { header: 'Motivo del último reemplazo', width: 26, wrap: true },
        { header: 'Fecha del último cambio', width: 17, numFmt: NUMFMT_FECHA_HORA },
    ];
    hoja(wb, 'Resumen por rodeo', c1, historial.rodeos.map(({ resumen: r }) => [
        fechaDia(r.fecha), r.duracion_dias, r.club, r.asociacion, r.tipo_rodeo, r.clasificacion,
        r.propuesta_aplicada_id || 'Ninguna propuesta aplicada', r.configuracion_version != null ? `v${r.configuracion_version}` : null,
        r.jurado_propuesto_original_jurado ? nombreJur(r.jurado_propuesto_original_jurado) : r.jurado_propuesto_original,
        r.jurado_confirmado_admin_jurado ? nombreJur(r.jurado_confirmado_admin_jurado) + (r.jurado_confirmado_admin_nota ? ' ' + r.jurado_confirmado_admin_nota : '') : r.jurado_confirmado_admin,
        r.decision_borrador,
        r.jurado_vigente_jurados && r.jurado_vigente_jurados.length ? r.jurado_vigente_jurados.map(nombreJur).join(' / ') : r.jurado_vigente,
        r.estado_actual,
        r.modificaciones_administrativas, r.reemplazos_posteriores, r.motivo_ultimo_reemplazo,
        fechaHoraChile(r.fecha_ultimo_cambio),
    ]), { filaTitulo: 'Historial de Designaciones — Resumen por rodeo', subtitulo: `${sub} · ${LEYENDA_CATEGORIA}` });

    // ── Hoja 2 ──
    const c2 = [
        { header: 'Fecha y hora', width: 17, numFmt: NUMFMT_FECHA_HORA },
        { header: 'Fecha del rodeo', width: 12, numFmt: NUMFMT_FECHA },
        { header: 'Rodeo (club)', width: 24, wrap: true },
        { header: 'Asociación', width: 22, wrap: true },
        { header: 'Tipo de evento', width: 34, wrap: true },
        { header: 'Origen', width: 14 },
        { header: 'Jurado anterior', width: 26, wrap: true },
        { header: 'Jurado nuevo', width: 26, wrap: true },
        { header: 'Usuario responsable', width: 26, wrap: true },
        { header: 'Motivo', width: 26, wrap: true },
        { header: 'Justificación', width: 40, wrap: true },
        { header: 'Estado resultante', width: 28, wrap: true },
        { header: 'Propuesta', width: 38 },
        { header: 'Propuesta aplicada', width: 10 },
        { header: 'Referencia', width: 46 },
    ];
    const filas2 = [];
    for (const r of historial.rodeos) {
        for (const e of r.eventos) {
            filas2.push([
                e.fecha ? fechaHoraChile(e.fecha) : (e.tipo === 'ESTADO_FINAL' ? 'Estado actual' : 'Sin fecha registrada'),
                fechaDia(r.rodeo.fecha), r.rodeo.club, r.rodeo.asociacion, e.etiqueta, e.origen,
                nombreJur(e.jurado_anterior), nombreJur(e.jurado_nuevo), e.responsable || SIN_INFO,
                e.motivo, e.justificacion, e.estado_resultante,
                e.propuesta_id || null, e.propuesta_aplicada == null ? null : (e.propuesta_aplicada ? 'Sí' : 'No'),
                e.referencia ? `${e.referencia.tabla}:${e.referencia.id}` : null,
            ]);
        }
    }
    hoja(wb, 'Historial cronológico', c2, filas2, { filaTitulo: 'Historial de Designaciones — Historial cronológico', subtitulo: `${sub} · ${LEYENDA_CATEGORIA}` });

    // ── Hoja 3 ──
    const c3 = [
        { header: 'Fecha de generación', width: 17, numFmt: NUMFMT_FECHA_HORA },
        { header: 'Propuesta', width: 38 },
        { header: 'Aplicada', width: 9 },
        { header: 'Versión configuración', width: 12 },
        { header: 'Motor', width: 10 },
        { header: 'Rodeo', width: 30, wrap: true },
        { header: 'Jurado originalmente propuesto', width: 28, wrap: true },
        { header: 'Categoría (registrada por el motor)', width: 12 },
        { header: 'Comuna', width: 18, wrap: true },
        { header: 'Distancia (km)', width: 11 },
        { header: 'Nota técnica disponible', width: 12 },
        { header: 'Criterios registrados', width: 44, wrap: true },
        { header: 'Advertencias registradas', width: 30, wrap: true },
        { header: 'Relajaciones del optimizador', width: 30, wrap: true },
        { header: 'Resultado de cobertura', width: 24, wrap: true },
        { header: 'Estado de revisión registrado', width: 16 },
        { header: 'Decisión individual (según evidencia)', width: 34, wrap: true },
    ];
    hoja(wb, 'Propuesta original del motor', c3, historial.propuesta_original.map(f => [
        fechaHoraChile(f.fecha_generacion), f.propuesta_id, f.propuesta_aplicada ? 'Sí' : 'No',
        f.configuracion_version != null ? `v${f.configuracion_version}` : null, f.motor, f.rodeo,
        f.jurado_propuesto, f.categoria, f.comuna, f.distancia_km, f.nota_tecnica,
        f.criterios, f.advertencias, f.relajaciones, f.cobertura, f.estado_revision_actual, f.decision_administrativa,
    ]), { filaTitulo: 'Historial de Designaciones — Propuesta original del motor', subtitulo: sub + ' · Datos del snapshot guardado; no se recalculan métricas históricas.' });

    return wb;
}

module.exports = { construirLibroHistorial, fechaHoraChile, fechaDia };
