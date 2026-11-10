const ExcelJS = require('exceljs');
const supabase = require('../config/supabase');
const { calcularResumenMensual, obtenerRetencion } = require('./calculo');
const {
    construirQueryRodeosFiltrada, cargarStatsAsignacionesPorRodeo, cargarIndicadoresAdjuntosPorRodeo, cargarNotasPorRodeo,
    cargarEstadoCartillaDelegadoUnificadoPorRodeo, cargarEstadoCartillaJuradoUnificadoPorRodeo, cargarNotaAreaDeportivaPorRodeo
} = require('./rodeosListado');

// Estilo de encabezado estándar
const HEADER_STYLE = {
    font: { bold: true, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a5f' } },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: {
        top: { style: 'thin' }, bottom: { style: 'thin' },
        left: { style: 'thin' }, right: { style: 'thin' }
    }
};

// Fuente roja para celdas "Pendiente" (Nota Comisión/Delegado/Final) — usa
// exclusivamente la API de estilos que ya trae ExcelJS (misma librería que
// ya pinta HEADER_STYLE/las filas alternadas más abajo), sin dependencia nueva.
const PENDIENTE_FONT = { color: { argb: 'FFCC0000' }, bold: true };

// ─── Nota (Comisión/Delegado/Final) -> valor numérico o el texto exacto
// "Pendiente". Chequeo EXPLÍCITO de null/undefined (nunca `if (!valor)`,
// que trataría incorrectamente un futuro valor 0 como pendiente) — hoy
// ninguna de las 3 notas puede valer 0 (CHECK de rango 1.0-7.0 en BD /
// mínimo 1.0 del cálculo de nota_final), pero el chequeo se hace explícito
// de todas formas, nunca por conveniencia con una condición genérica.
function valorNotaOPendiente(valor) {
    return (valor === null || valor === undefined) ? 'Pendiente' : Number(valor);
}

function autoWidth(sheet) {
    sheet.columns.forEach(col => {
        let maxLen = col.header ? col.header.length : 10;
        col.eachCell({ includeEmpty: false }, cell => {
            // Una celda de fecha REAL (ver fechaExcelReal) mide su ancho por el
            // formato visible ("dd/mm/yyyy" = 10 caracteres), nunca por
            // `String(dateObject)` (que da algo como "Sat Nov 07 2026 00:00:00
            // GMT+0000...", ensanchando la columna sin necesidad).
            const len = cell.value instanceof Date ? 10 : (cell.value ? String(cell.value).length : 0);
            if (len > maxLen) maxLen = len;
        });
        col.width = Math.min(maxLen + 4, 50);
    });
}

function formatCLP(monto) {
    if (monto == null) return '$0';
    return '$' + Number(monto).toLocaleString('es-CL');
}

// ─── Fecha real de Excel (dd/mm/yyyy, ordenable/filtrable) ────────────────
// `rodeos.fecha` es columna DATE (database/schema.sql) — Supabase/PostgREST
// la entrega como texto "YYYY-MM-DD" (sin hora ni zona). Se parsean los
// componentes Y/M/D explícitamente y se construye un Date con
// Date.UTC(...): su getTime() (único dato que usa ExcelJS para calcular el
// número de serie, ver node_modules/exceljs/lib/utils/utils.js:dateToExcel)
// queda fijado a la medianoche UTC de ese día exacto — nunca depende de la
// zona horaria del servidor donde corre Node, así que nunca se desplaza un
// día para atrás ni adelante. Se usa el string explícitamente (nunca
// `new Date(iso)` directo) para no depender de que el motor de JS siga
// interpretando un string "YYYY-MM-DD" como UTC.
function fechaExcelReal(fechaIso) {
    if (!fechaIso) return null;
    const [y, m, d] = String(fechaIso).slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return null;
    return new Date(Date.UTC(y, m - 1, d));
}
const NUMFMT_FECHA_CHILENA = 'dd/mm/yyyy';

/**
 * Exportar resumen mensual completo del sistema.
 */
async function exportarResumenMensual(año, mes, res) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Sistema Jurados - Rodeo Chileno';
    wb.created = new Date();

    const ws = wb.addWorksheet('Resumen Mensual');

    ws.columns = [
        { header: 'Código', key: 'codigo', width: 12 },
        { header: 'Nombre', key: 'nombre', width: 30 },
        { header: 'Tipo', key: 'tipo', width: 18 },
        { header: 'Club', key: 'club', width: 25 },
        { header: 'Asociación', key: 'asociacion', width: 20 },
        { header: 'Fecha', key: 'fecha', width: 12 },
        { header: 'Tipo Rodeo', key: 'tipo_rodeo', width: 20 },
        { header: 'Días', key: 'dias', width: 8 },
        { header: 'Categoría', key: 'categoria', width: 10 },
        { header: 'Pago Base', key: 'pago_base', width: 14 },
        { header: 'Bono Aprobado', key: 'bono_aprobado', width: 16 },
        { header: 'Bruto', key: 'bruto', width: 14 },
        { header: 'Retención', key: 'retencion', width: 14 },
        { header: 'Líquido', key: 'liquido', width: 14 }
    ];

    // Estilo encabezado
    ws.getRow(1).eachCell(cell => {
        cell.font = HEADER_STYLE.font;
        cell.fill = HEADER_STYLE.fill;
        cell.alignment = HEADER_STYLE.alignment;
    });
    ws.getRow(1).height = 20;

    // Obtener todos los usuarios
    const { data: usuarios } = await supabase
        .from('usuarios_pagados')
        .select('id, codigo_interno, nombre_completo, tipo_persona')
        .eq('activo', true);

    const porcentaje = await obtenerRetencion();
    let rowNum = 2;

    for (const usuario of (usuarios || [])) {
        const resumen = await calcularResumenMensual(usuario.id, año, mes);
        if (!resumen.asignaciones || resumen.asignaciones.length === 0) continue;

        for (const a of resumen.asignaciones) {
            const fila = ws.getRow(rowNum);
            const brutoRow = a.pago_base_calculado + (a.bono_aprobado || 0);
            const retMonto = Math.round(brutoRow * porcentaje / 100);

            fila.values = [
                usuario.codigo_interno,
                usuario.nombre_completo,
                usuario.tipo_persona === 'jurado' ? 'Jurado' : 'Delegado Rentado',
                a.rodeos?.club,
                a.rodeos?.asociacion,
                a.rodeos?.fecha,
                a.rodeos?.tipo_rodeo_nombre,
                a.duracion_dias_aplicada,
                a.categoria_aplicada || '-',
                formatCLP(a.pago_base_calculado),
                formatCLP(a.bono_aprobado || 0),
                formatCLP(brutoRow),
                formatCLP(retMonto),
                formatCLP(brutoRow - retMonto)
            ];

            // Alternar colores de fila
            if (rowNum % 2 === 0) {
                fila.eachCell(cell => {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4F8' } };
                });
            }
            rowNum++;
        }
    }

    autoWidth(ws);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=resumen_${año}_${mes}.xlsx`);
    await wb.xlsx.write(res);
}

/**
 * Exportar listado de bonos (por estado).
 */
async function exportarBonos(estado, res) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Bonos');

    ws.columns = [
        { header: 'Nombre Usuario', key: 'nombre', width: 30 },
        { header: 'Tipo', key: 'tipo', width: 18 },
        { header: 'Club', key: 'club', width: 25 },
        { header: 'Fecha Rodeo', key: 'fecha', width: 14 },
        { header: 'Distancia (km)', key: 'distancia', width: 15 },
        { header: 'Monto Solicitado', key: 'monto_sol', width: 18 },
        { header: 'Monto Aprobado', key: 'monto_apr', width: 18 },
        { header: 'Estado', key: 'estado', width: 14 },
        { header: 'Observación Admin', key: 'obs_admin', width: 30 },
        { header: 'Fecha Solicitud', key: 'fecha_sol', width: 16 }
    ];

    ws.getRow(1).eachCell(cell => {
        cell.font = HEADER_STYLE.font;
        cell.fill = HEADER_STYLE.fill;
        cell.alignment = HEADER_STYLE.alignment;
    });

    let query = supabase
        .from('bonos_solicitados')
        .select(`
            *,
            usuarios_pagados(nombre_completo, tipo_persona),
            asignaciones(rodeo_id, rodeos(club, fecha))
        `)
        .order('created_at', { ascending: false });

    if (estado && estado !== 'todos') {
        query = query.eq('estado', estado);
    }

    const { data: bonos } = await query;

    let rowNum = 2;
    for (const b of (bonos || [])) {
        const fila = ws.getRow(rowNum);
        fila.values = [
            b.usuarios_pagados?.nombre_completo,
            b.usuarios_pagados?.tipo_persona === 'jurado' ? 'Jurado' : 'Delegado Rentado',
            b.asignaciones?.rodeos?.club,
            b.asignaciones?.rodeos?.fecha,
            b.distancia_declarada,
            formatCLP(b.monto_solicitado),
            formatCLP(b.monto_aprobado),
            b.estado,
            b.observacion_admin || '',
            b.created_at?.split('T')[0]
        ];
        rowNum++;
    }

    autoWidth(ws);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=bonos_${estado || 'todos'}.xlsx`);
    await wb.xlsx.write(res);
}

/**
 * Exportar registros pendientes de revisión.
 */
async function exportarPendientes(res) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Pendientes');

    ws.columns = [
        { header: 'Importación', key: 'imp', width: 20 },
        { header: 'Problema', key: 'problema', width: 30 },
        { header: 'Club', key: 'club', width: 25 },
        { header: 'Asociación', key: 'asoc', width: 20 },
        { header: 'Fecha', key: 'fecha', width: 14 },
        { header: 'Tipo Rodeo', key: 'tipo', width: 20 },
        { header: 'Nombre Jurado', key: 'jurado', width: 30 },
        { header: 'Estado', key: 'estado', width: 14 },
        { header: 'Fecha Registro', key: 'created', width: 16 }
    ];

    ws.getRow(1).eachCell(cell => {
        cell.font = HEADER_STYLE.font;
        cell.fill = HEADER_STYLE.fill;
        cell.alignment = HEADER_STYLE.alignment;
    });

    const { data: pendientes } = await supabase
        .from('importaciones_pendientes')
        .select('*, importaciones(nombre_archivo)')
        .eq('estado', 'pendiente')
        .order('created_at', { ascending: false });

    let rowNum = 2;
    const PROBLEMAS = {
        jurado_no_encontrado: 'Jurado no encontrado',
        tipo_rodeo_no_encontrado: 'Tipo de rodeo no encontrado',
        datos_incompletos: 'Datos incompletos',
        duplicado: 'Posible duplicado'
    };

    for (const p of (pendientes || [])) {
        const d = p.datos_originales || {};
        const campos = extraerCamposDesdeJson(d);
        const fila = ws.getRow(rowNum);
        fila.values = [
            p.importaciones?.nombre_archivo,
            PROBLEMAS[p.problema] || p.problema,
            campos.club,
            campos.asociacion,
            campos.fecha,
            campos.tipo_rodeo,
            campos.nombre_jurado,
            p.estado,
            p.created_at?.split('T')[0]
        ];
        rowNum++;
    }

    autoWidth(ws);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=pendientes_revision.xlsx');
    await wb.xlsx.write(res);
}

function extraerCamposDesdeJson(d) {
    return {
        club: d.Club || d.club || '',
        asociacion: d.Asociacion || d.asociacion || d['Asociación'] || '',
        fecha: d.Fecha || d.fecha || '',
        tipo_rodeo: d['Tipo Rodeo'] || d.tipo_rodeo || d.tipo || '',
        nombre_jurado: d['Nombre Jurado'] || d.nombre_jurado || d.jurado || d.Jurado || ''
    };
}

// ─── Helper: escribir CSV ──────────────────────────────────────
function generarCSV(headers, filas) {
    const escapar = v => {
        if (v == null) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n')
            ? '"' + s.replace(/"/g, '""') + '"'
            : s;
    };
    const lines = [headers.map(escapar).join(',')];
    filas.forEach(f => lines.push(f.map(escapar).join(',')));
    return '\uFEFF' + lines.join('\r\n'); // BOM para Excel
}

/**
 * Exportar listado de rodeos con totales de asignaciones.
 *
 * CORRECCIÓN (bug "Exportar no respeta los filtros aplicados en pantalla"):
 * antes esta función tenía su propia query, independiente de GET /admin/
 * rodeos, que solo entendía año/mes/buscar — cualquier otro filtro activo
 * en la pantalla (fecha_desde/hasta, categoría, tipo, asociación, club,
 * jurado, delegado, estados, cartillas, video, origen, temporada) se
 * ignoraba en silencio y el Excel terminaba trayendo prácticamente todo.
 * Ahora usa construirQueryRodeosFiltrada()/cargarStatsAsignacionesPorRodeo()
 * — EXACTAMENTE la misma lógica de filtrado que ya usa la tabla — para que
 * listado y exportación nunca puedan volver a desincronizarse.
 *
 * `filtros` es literalmente req.query del endpoint de exportación: acepta
 * TODOS los filtros que ya soporta GET /admin/rodeos (ver rodeosListado.js).
 *
 * "Origen" (manual/importado) se quitó de este Excel a pedido — el filtro
 * `origen` sigue funcionando igual (vive en construirQueryRodeosFiltrada),
 * solo dejó de mostrarse como columna acá.
 * "Cartilla Jurado"/"Cartilla Delegado"/"Video" usan cargarIndicadoresAdjuntosPorRodeo()
 * — MISMA fuente exacta que ya usa el indicador "CJ/CD/VY" de la tabla en
 * pantalla (GET /admin/adjuntos/resumen), nunca una lógica nueva.
 * "Nota Comisión"/"Nota Delegado"/"Nota Final" usan cargarNotasPorRodeo() —
 * MISMA fuente exacta que ya usan "Notas secundarias" (edición del rodeo) y
 * el listado de Evaluaciones; nota inexistente = texto "Pendiente" en rojo,
 * nunca 0/NULL/celda vacía.
 */
async function exportarRodeos(filtros, res) {
    const { año, mes } = filtros;

    const { query, vacioPorFiltro } = await construirQueryRodeosFiltrada(
        filtros, 'id, club, asociacion, fecha, tipo_rodeo_nombre, duracion_dias, estado'
    );
    const { data: rodeos } = vacioPorFiltro ? { data: [] } : await query;

    const ids = (rodeos || []).map(r => r.id);
    // Stats de asignaciones (pago total + jurados/estado de designación),
    // estado UNIFICADO de Cartilla Jurado/Delegado (Prioridad 1 — mismo
    // fuente que ya corrige el filtro "con/sin" de la pantalla, nunca el
    // chequeo antiguo que solo miraba rodeo_adjuntos) y notas (comisión/
    // delegado + Nota Área Deportiva por jurado, Prioridad 4) — consultas
    // fijas en paralelo, nunca una por rodeo.
    const [statsMap, cdMap, cjMap, indicMap, notasMap, notaADMap] = await Promise.all([
        cargarStatsAsignacionesPorRodeo(ids),
        cargarEstadoCartillaDelegadoUnificadoPorRodeo(ids),
        cargarEstadoCartillaJuradoUnificadoPorRodeo(ids),
        cargarIndicadoresAdjuntosPorRodeo(ids), // solo se usa el campo `vy` (video) — cj/cd quedan reemplazados por las fuentes unificadas de arriba
        cargarNotasPorRodeo(ids),
        cargarNotaAreaDeportivaPorRodeo(ids)
    ]);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Sistema Jurados - Rodeo Chileno';
    const ws = wb.addWorksheet('Rodeos');

    ws.columns = [
        { header: 'Fecha',              key: 'fecha',     width: 14, style: { numFmt: NUMFMT_FECHA_CHILENA } },
        { header: 'Club',               key: 'club',       width: 28 },
        { header: 'Asociación',         key: 'asoc',       width: 22 },
        { header: 'Tipo Rodeo',         key: 'tipo',       width: 30 },
        { header: 'Días',               key: 'dias',       width: 8  },
        { header: 'Jurado',             key: 'jurado',     width: 30 },
        { header: 'Estado designación', key: 'estado_des', width: 20 },
        { header: 'Jurados',            key: 'jurados',    width: 10 },
        { header: 'Cartilla Jurado',      key: 'cj',         width: 15 },
        { header: 'Cartilla Delegado',    key: 'cd',         width: 16 },
        { header: 'Requiere corrección',  key: 'correccion', width: 18 },
        { header: 'Video',                key: 'video',      width: 10 },
        { header: 'Nota Comisión',        key: 'nota_com',   width: 15 },
        { header: 'Nota Delegado',        key: 'nota_del',   width: 15 },
        { header: 'Nota Área Deportiva',  key: 'nota_ad',    width: 28 },
        { header: 'Total Pagos',          key: 'total',      width: 16 },
    ];
    ws.getRow(1).eachCell(c => { c.font = HEADER_STYLE.font; c.fill = HEADER_STYLE.fill; c.alignment = HEADER_STYLE.alignment; });
    // Columnas de notas (Nota Comisión, Nota Delegado, Nota Área Deportiva) en ese orden.
    const COL_NOTAS = [13, 14, 15];

    (rodeos || []).forEach((r, i) => {
        const s = statsMap[r.id] || { jurados: 0, total_pago_base: 0, jurados_lista: [] };
        const lista = s.jurados_lista || [];
        // Varios jurados en el mismo rodeo (sí puede ocurrir hoy, ver
        // tabla de Rodeos) -> se listan ambos, alineados 1:1 en el mismo
        // orden, nunca se pierde ninguno.
        const jurado     = lista.length > 0 ? lista.map(j => j.nombre).join(' / ') : 'Sin jurado';
        const estadoDes  = lista.length > 0 ? lista.map(j => j.estado_designacion_texto).join(' / ') : '—';
        // Cartilla Jurado/Delegado: fuente UNIFICADA (Prioridad 1) — nunca el
        // chequeo antiguo que solo miraba rodeo_adjuntos. `vy` (video) sigue
        // viniendo de cargarIndicadoresAdjuntosPorRodeo, nunca duplicado.
        const cd = cdMap[r.id] || { recibida: false, requiere_correccion: false };
        const cj = cjMap[r.id] || { recibida: false, requiere_correccion: false };
        const vy = (indicMap[r.id] || {}).vy || false;
        const notas = notasMap[r.id] || { nota_comision: null, nota_delegado: null };
        const notaAD = notaADMap[r.id] || { actuales: [], historicas: [] };
        const valNotaComision = valorNotaOPendiente(notas.nota_comision);
        const valNotaDelegado = valorNotaOPendiente(notas.nota_delegado);
        // Nota Área Deportiva es POR JURADO (nunca un solo valor de rodeo,
        // Prioridad 4) — se listan nombre:nota, alineados con la columna
        // "Jurado" de más arriba; una nota histórica (fuente='manual') se
        // rotula explícitamente, nunca mezclada en silencio como real.
        const valNotaAD = notaAD.actuales.length === 0 && notaAD.historicas.length === 0
            ? 'Pendiente'
            : [
                ...notaAD.actuales.map(n => `${n.jurado_nombre || '—'}: ${n.nota}`),
                ...notaAD.historicas.map(n => `${n.jurado_nombre || '—'}: ${n.nota} (histórica)`)
            ].join(' / ');
        const row = ws.addRow([
            fechaExcelReal(r.fecha), r.club, r.asociacion, r.tipo_rodeo_nombre, r.duracion_dias,
            jurado, estadoDes, s.jurados || 0,
            cj.recibida ? 'Sí' : 'No', cd.recibida ? 'Sí' : 'No',
            (cd.requiere_correccion || cj.requiere_correccion) ? 'Sí' : 'No',
            vy ? 'Sí' : 'No',
            valNotaComision, valNotaDelegado, valNotaAD,
            formatCLP(s.total_pago_base || 0)
        ]);
        if (i % 2 === 0) row.eachCell(c => { c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF0F4F8' } }; });
        // "Pendiente" en rojo — solo la celda, sin tocar el resto de la fila.
        COL_NOTAS.forEach(colNum => {
            const cell = row.getCell(colNum);
            if (cell.value === 'Pendiente') cell.font = PENDIENTE_FONT;
        });
    });
    autoWidth(ws);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=rodeos${año?'_'+año:''}${mes?'_'+mes:''}.xlsx`);
    await wb.xlsx.write(res);
}

// ═════════════════════════════════════════════════════════════════════════
// Resumen por jurado — detalle de rodeos (Excel / CSV)
// Recibe el objeto de services/resumenJurados.js:obtenerResumenJurados()
// (la MISMA estructura que muestra la pantalla). Nunca recalcula montos:
// cada celda numérica es el valor ya calculado; las fórmulas solo
// re-expresan esas mismas sumas y llevan su resultado precalculado.
// ═════════════════════════════════════════════════════════════════════════
const TITULO_RESUMEN_JURADOS = 'Reporte de Pagos por Jurado — Detalle de Rodeos';
const NUMFMT_CLP = '"$"#,##0;-"$"#,##0';
const COLOR_AZUL = 'FF1E3A5F';
const COLOR_AZUL_CLARO = 'FFDCE8F5';
const COLOR_FILA_ALTERNA = 'FFF5F8FC';
const COLOR_ROJO = 'FFC0392B';
const COLOR_VERDE = 'FF1E8449';
const COLOR_GRIS = 'FF8A94A6';

const COLUMNAS_RESUMEN_JURADOS = [
    { header: 'Código',                  width: 11 },
    { header: 'Jurado',                  width: 32 },
    { header: 'RUT',                     width: 13 },
    { header: 'N.º',                     width: 5  },
    { header: 'Fecha',                   width: 11 },
    { header: 'Asociación organizadora', width: 26 },
    { header: 'Club organizador',        width: 26 },
    { header: 'Categoría',               width: 10 },
    { header: 'Tipo de rodeo',           width: 26 },
    { header: 'Días',                    width: 6  },
    { header: 'Pago base',               width: 14 },
    { header: 'Bono',                    width: 12 },
    { header: 'Total bruto',             width: 14 },
    { header: 'Retención',               width: 13 },
    { header: 'Líquido',                 width: 14 },
];
// Columnas (1-based) de montos.
const C = { COD: 1, NOM: 2, RUT: 3, N: 4, FECHA: 5, ASOC: 6, CLUB: 7, CAT: 8, TIPO: 9, DIAS: 10, PB: 11, BONO: 12, BRUTO: 13, RET: 14, LIQ: 15 };
const FILA_ENCABEZADO_RESUMEN = 6;

function letraCol(n) { return String.fromCharCode(64 + n); }

function textoSubtotalJurado(j) {
    const n = j.cant_rodeos;
    let t = `TOTAL JURADO: ${j.nombre_completo} (${n} ${n === 1 ? 'RODEO' : 'RODEOS'})`;
    if (j.designaciones_rechazadas > 0 && n === 0) {
        t += ` — ${j.designaciones_rechazadas} designación(es) rechazada(s), sin pago`;
    }
    return t;
}

function textoTotalGeneral(t) {
    return `TOTAL GENERAL DEL REPORTE — ${t.cant_jurados} ${t.cant_jurados === 1 ? 'jurado' : 'jurados'} · ${t.cant_rodeos} ${t.cant_rodeos === 1 ? 'asignación' : 'asignaciones'}`;
}

function construirCsvResumenJurados(resumen) {
    const sep = ';';
    const escapar = (v, esTexto) => {
        if (v == null) return '';
        let s = String(v);
        // Evita que Excel interprete un texto como fórmula (inyección CSV).
        if (esTexto && /^[=+\-@]/.test(s)) s = "'" + s;
        return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const headers = ['tipo_fila', 'codigo', 'jurado', 'rut', 'n_rodeo', 'fecha', 'asociacion_organizadora', 'club_organizador',
        'categoria', 'tipo_rodeo', 'dias', 'pago_base', 'bono', 'total_bruto', 'retencion', 'liquido', 'rodeo_id', 'asignacion_id'];
    const TEXTO = new Set([1, 2, 3, 6, 7, 8, 9]);
    const lineas = [headers.join(sep)];
    const push = arr => lineas.push(arr.map((v, i) => escapar(v, TEXTO.has(i))).join(sep));

    for (const j of resumen.jurados) {
        for (const f of j.rodeos_detalle) {
            push(['detalle', j.codigo_interno, j.nombre_completo, j.rut, f.n, fechaDDMMAAAA(f.fecha), f.asociacion, f.club,
                f.categoria, f.tipo_rodeo, f.duracion_dias, f.pago_base, f.bono_aprobado, f.bruto, '', '', f.rodeo_id, f.asignacion_id]);
        }
        push(['subtotal_jurado', j.codigo_interno, textoSubtotalJurado(j), j.rut, j.cant_rodeos, '', '', '',
            '', '', '', j.total_pago_base, j.total_bono_aprobado, j.bruto, j.retencion_monto, j.liquido, '', '']);
    }
    const t = resumen.totales_global;
    push(['total_general', '', textoTotalGeneral(t), '', t.cant_rodeos, '', '', '',
        '', '', '', t.total_pago_base, t.total_bono_aprobado, t.bruto, t.retencion_monto, t.liquido, '', '']);
    return '﻿' + lineas.join('\r\n') + '\r\n';
}

function fechaDDMMAAAA(iso) {
    if (!iso) return '';
    const [y, m, d] = String(iso).slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
}

async function construirLibroResumenJurados(resumen, { filtrosTexto = 'Sin filtros adicionales', generado = new Date() } = {}) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Sistema Jurados - Rodeo Chileno';
    wb.created = generado;
    wb.calcProperties = { fullCalcOnLoad: true };
    const ws = wb.addWorksheet('Resumen por jurado', {
        views: [{ state: 'frozen', xSplit: 3, ySplit: FILA_ENCABEZADO_RESUMEN }],
        pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    COLUMNAS_RESUMEN_JURADOS.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });
    const ncol = COLUMNAS_RESUMEN_JURADOS.length;
    const ultimaLetra = letraCol(ncol);

    // ── Encabezado institucional (sin celdas fusionadas) ──
    const pct = resumen.retencion_porcentaje;
    ws.getCell('A1').value = TITULO_RESUMEN_JURADOS;
    ws.getCell('A1').font = { bold: true, size: 14, color: { argb: COLOR_AZUL } };
    ws.getCell('A2').value = `Período: ${resumen.periodo?.descripcion || 'Todos los períodos'}`;
    ws.getCell('A2').font = { bold: true };
    ws.getCell('A3').value = `Filtros: ${filtrosTexto}`;
    ws.getCell('A4').value = `Retención ${String(pct).replace('.', ',')} %: se calcula sobre el bruto total de cada jurado en el período (cálculo oficial) y se informa en su fila de subtotal.`;
    ws.getCell('A4').font = { italic: true, color: { argb: 'FF555555' } };
    const fechaGen = generado.toLocaleString('es-CL', { timeZone: 'America/Santiago' });
    ws.getCell('A5').value = `Generado: ${fechaGen}`;
    ws.getCell('A5').font = { size: 9, color: { argb: COLOR_GRIS } };

    const borde = { top: { style: 'thin', color: { argb: 'FFD5DCE6' } }, bottom: { style: 'thin', color: { argb: 'FFD5DCE6' } },
        left: { style: 'thin', color: { argb: 'FFD5DCE6' } }, right: { style: 'thin', color: { argb: 'FFD5DCE6' } } };

    const hdr = ws.getRow(FILA_ENCABEZADO_RESUMEN);
    hdr.values = COLUMNAS_RESUMEN_JURADOS.map(c => c.header);
    hdr.height = 22;
    hdr.eachCell((c, col) => {
        c.font = HEADER_STYLE.font;
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_AZUL } };
        c.alignment = { horizontal: col >= C.PB ? 'right' : (col === C.N || col === C.DIAS ? 'center' : 'left'), vertical: 'middle', wrapText: true };
        c.border = HEADER_STYLE.border;
    });

    const estiloMontos = (row, desde = C.PB) => {
        for (let col = desde; col <= C.LIQ; col++) row.getCell(col).numFmt = NUMFMT_CLP;
    };

    let r = FILA_ENCABEZADO_RESUMEN + 1;
    const primeraFilaDatos = r;

    for (const j of resumen.jurados) {
        const ini = r;
        j.rodeos_detalle.forEach((f, i) => {
            const row = ws.getRow(r);
            row.values = [
                j.codigo_interno, j.nombre_completo, j.rut, f.n, fechaExcelReal(f.fecha),
                f.asociacion, f.club, f.categoria, f.tipo_rodeo, f.duracion_dias,
                f.pago_base, f.bono_aprobado,
                { formula: `${letraCol(C.PB)}${r}+${letraCol(C.BONO)}${r}`, result: f.bruto },
                null, null,
            ];
            row.getCell(C.FECHA).numFmt = NUMFMT_FECHA_CHILENA;
            estiloMontos(row);
            const fill = i % 2 === 1 ? { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_FILA_ALTERNA } } : null;
            for (let col = 1; col <= ncol; col++) {
                const cell = row.getCell(col);
                cell.border = { ...borde, ...(i === 0 ? { top: { style: 'medium', color: { argb: COLOR_AZUL } } } : {}) };
                cell.alignment = { vertical: 'top', wrapText: [C.NOM, C.ASOC, C.CLUB, C.TIPO].includes(col), horizontal: (col === C.N || col === C.DIAS || col === C.CAT) ? 'center' : undefined };
                if (fill) cell.fill = fill;
            }
            // Identificación del jurado: presente en cada fila (ordenable/filtrable),
            // destacada en la primera y atenuada en las siguientes.
            [C.COD, C.NOM, C.RUT].forEach(col => {
                row.getCell(col).font = i === 0 ? { bold: col === C.NOM } : { color: { argb: COLOR_GRIS } };
            });
            row.getCell(C.BRUTO).font = { bold: true };
            r++;
        });
        const fin = r - 1;

        const sub = ws.getRow(r);
        const tieneFilas = j.rodeos_detalle.length > 0;
        const subtotal = (col, valor) => tieneFilas
            ? { formula: `SUBTOTAL(9,${letraCol(col)}${ini}:${letraCol(col)}${fin})`, result: valor }
            : valor;
        sub.values = [
            j.codigo_interno, textoSubtotalJurado(j), j.rut, j.cant_rodeos, null, null, null, null, null, null,
            subtotal(C.PB, j.total_pago_base), subtotal(C.BONO, j.total_bono_aprobado), subtotal(C.BRUTO, j.bruto),
            j.retencion_monto,
            { formula: `${letraCol(C.BRUTO)}${r}-${letraCol(C.RET)}${r}`, result: j.liquido },
        ];
        estiloMontos(sub);
        for (let col = 1; col <= ncol; col++) {
            const cell = sub.getCell(col);
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_AZUL_CLARO } };
            cell.font = { bold: true, color: { argb: COLOR_AZUL } };
            cell.border = { ...borde, bottom: { style: 'medium', color: { argb: COLOR_AZUL } } };
            cell.alignment = { vertical: 'middle', horizontal: col === C.N ? 'center' : undefined };
        }
        sub.getCell(C.RET).font = { bold: true, color: { argb: COLOR_ROJO } };
        sub.getCell(C.LIQ).font = { bold: true, color: { argb: COLOR_VERDE } };
        r++;
    }
    const ultimaFilaDatos = r - 1;

    // ── Total general ──
    const t = resumen.totales_global;
    const hayDatos = ultimaFilaDatos >= primeraFilaDatos;
    const totalCol = (col, valor) => hayDatos
        ? { formula: `SUBTOTAL(9,${letraCol(col)}${primeraFilaDatos}:${letraCol(col)}${ultimaFilaDatos})`, result: valor }
        : valor;
    const tot = ws.getRow(r);
    tot.values = [
        null, textoTotalGeneral(t), null, t.cant_rodeos, null, null, null, null, null, null,
        totalCol(C.PB, t.total_pago_base), totalCol(C.BONO, t.total_bono_aprobado), totalCol(C.BRUTO, t.bruto),
        totalCol(C.RET, t.retencion_monto), totalCol(C.LIQ, t.liquido),
    ];
    estiloMontos(tot);
    tot.height = 22;
    for (let col = 1; col <= ncol; col++) {
        const cell = tot.getCell(col);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_AZUL } };
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.alignment = { vertical: 'middle', horizontal: col === C.N ? 'center' : undefined };
    }

    if (hayDatos) ws.autoFilter = `A${FILA_ENCABEZADO_RESUMEN}:${ultimaLetra}${ultimaFilaDatos}`;
    return wb;
}

/**
 * Exportar resumen por jurado con detalle de rodeos (Excel o CSV).
 * @param {object} resumen  resultado de obtenerResumenJurados() — misma
 *                          estructura que GET /admin/reportes/resumen-mensual.
 */
async function exportarResumenJurados(resumen, formato, res, opciones = {}) {
    if (formato === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=resumen_jurados.csv');
        return res.send(construirCsvResumenJurados(resumen));
    }
    const wb = await construirLibroResumenJurados(resumen, opciones);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=resumen_jurados.xlsx');
    await wb.xlsx.write(res);
}

/**
 * Exportar detalle de rodeos de un jurado (Excel o CSV).
 */
async function exportarDetalleJurado(jurado, filas, retencionPct, formato, res) {
    const headers = ['Fecha', 'Club', 'Asociación', 'Tipo Rodeo', 'Días', 'Cat.', 'Pago Base', 'Bono', 'Estado Bono', 'Bruto', 'Retención', 'Líquido'];
    const rowsData = filas.map(f => [
        f.fecha, f.club, f.asociacion, f.tipo_rodeo, f.duracion_dias, f.categoria,
        formatCLP(f.pago_base), formatCLP(f.bono_aprobado), f.estado_bono || '—',
        formatCLP(f.bruto), formatCLP(f.retencion_monto), formatCLP(f.liquido)
    ]);

    if (formato === 'csv') {
        const csv = generarCSV(headers, rowsData);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=detalle_${jurado?.codigo_interno||'jurado'}.csv`);
        return res.send(csv);
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Detalle');

    // Cabecera con datos del jurado
    ws.addRow([`Jurado: ${jurado?.nombre_completo || '—'}`]).font = { bold: true, size: 13 };
    ws.addRow([`RUT: ${jurado?.rut || '—'}  |  Código: ${jurado?.codigo_interno || '—'}  |  Categoría: ${jurado?.categoria || '—'}`]);
    ws.addRow([]);

    ws.columns = [
        { header: 'Fecha', key: 'f', width: 14 },    { header: 'Club', key: 'c', width: 26 },
        { header: 'Asociación', key: 'a', width: 22 }, { header: 'Tipo Rodeo', key: 't', width: 28 },
        { header: 'Días', key: 'd', width: 8 },       { header: 'Cat.', key: 'cat', width: 8 },
        { header: 'Pago Base', key: 'pb', width: 16 }, { header: 'Bono', key: 'b', width: 14 },
        { header: 'Estado Bono', key: 'eb', width: 14 }, { header: 'Bruto', key: 'br', width: 16 },
        { header: 'Retención', key: 'r', width: 14 }, { header: 'Líquido', key: 'l', width: 16 },
    ];
    const headerRow = ws.getRow(4);
    headerRow.values = headers;
    headerRow.eachCell(c => { c.font = HEADER_STYLE.font; c.fill = HEADER_STYLE.fill; c.alignment = HEADER_STYLE.alignment; });

    filas.forEach((f, i) => {
        const row = ws.addRow([
            f.fecha, f.club, f.asociacion, f.tipo_rodeo, f.duracion_dias, f.categoria,
            formatCLP(f.pago_base), formatCLP(f.bono_aprobado), f.estado_bono || '—',
            formatCLP(f.bruto), formatCLP(f.retencion_monto), formatCLP(f.liquido)
        ]);
        if (i % 2 === 0) row.eachCell(c => { c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF0F4F8' } }; });
    });

    autoWidth(ws);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=detalle_${jurado?.codigo_interno||'jurado'}.xlsx`);
    await wb.xlsx.write(res);
}

/**
 * Exportar reporte agregado (por asociacion, club o tipo) — Excel o CSV.
 */
async function exportarAgregado(tipo, datos, formato, res) {
    let headers, rowsData, filename;

    if (tipo === 'asociacion') {
        headers = ['Asociación', 'Rodeos', 'Jurados asignados', 'Total Pago Base', 'Total Bonos', 'Total Bruto'];
        rowsData = datos.map(d => [d.asociacion, d.cant_rodeos, d.cant_jurados, formatCLP(d.total_pago_base), formatCLP(d.total_bono_aprobado), formatCLP(d.total_bruto)]);
        filename = 'reporte_asociaciones';
    } else if (tipo === 'club') {
        headers = ['Club', 'Asociación', 'Rodeos', 'Jurados asignados', 'Total Pago Base', 'Total Bonos', 'Total Bruto'];
        rowsData = datos.map(d => [d.club, d.asociacion, d.cant_rodeos, d.cant_jurados, formatCLP(d.total_pago_base), formatCLP(d.total_bono_aprobado), formatCLP(d.total_bruto)]);
        filename = 'reporte_clubes';
    } else {
        headers = ['Tipo Rodeo', 'Veces Realizado', 'Jurados totales', 'Total Pago Base', 'Total Bonos', 'Total Bruto'];
        rowsData = datos.map(d => [d.tipo_rodeo, d.cant_rodeos, d.cant_jurados, formatCLP(d.total_pago_base), formatCLP(d.total_bono_aprobado), formatCLP(d.total_bruto)]);
        filename = 'reporte_tipos_rodeo';
    }

    if (formato === 'csv') {
        const csv = generarCSV(headers, rowsData);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=${filename}.csv`);
        return res.send(csv);
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Reporte');
    ws.addRow(headers).eachCell(c => { c.font = HEADER_STYLE.font; c.fill = HEADER_STYLE.fill; c.alignment = HEADER_STYLE.alignment; });
    rowsData.forEach((r, i) => {
        const row = ws.addRow(r);
        if (i % 2 === 0) row.eachCell(c => { c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF0F4F8' } }; });
    });
    autoWidth(ws);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}.xlsx`);
    await wb.xlsx.write(res);
}

function formatFechaDDMMYYYY(iso) {
    if (!iso) return '—';
    const [y, m, d] = String(iso).slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
}

function sanitizarNombreArchivo(nombre) {
    return (nombre || 'jurado')
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // quitar tildes
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toUpperCase();
}

// Mismo mapeo de tipo_caso → etiqueta ya usado en reporte-deportivo.js (export-detalle)
// y en frontend/js/utils.js — no se inventa, se reutiliza la nomenclatura real del sistema.
const TIPO_CASO_LABEL = {
    interpretativa: 'Apreciación',
    reglamentaria:  'Reglamentaria',
    informativo:    'Conceptual/Informativo'
};

function formatNotaComa(n) {
    if (n == null) return 'Sin nota';
    return Number(n).toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Exporta a Excel el historial completo de rodeos de un jurado (Hoja de Vida).
 * `filas`: [{ fecha, asociacion, club, tipo_rodeo, situaciones, nota }] — ya debe
 * venir con el historial COMPLETO (no solo lo paginado/visible en pantalla).
 * `resumen`: { totalSituaciones, porTipo: {tipo_caso: cantidad}, promedioNota }.
 */
async function exportarHistorialHojaVida(perfil, filas, resumen, res) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Historial de Rodeos');

    ws.addRow(['HOJA DE VIDA — HISTORIAL DE RODEOS']).font = { bold: true, size: 13 };
    ws.addRow([`Nombre: ${perfil?.nombre_completo || '—'}`]);
    ws.addRow([`Asociación: ${perfil?.asociacion || 'Sin información'}`]);
    ws.addRow([`Categoría: ${perfil?.categoria || 'Sin información'}`]);
    ws.addRow([`Comuna: ${perfil?.comuna || 'Sin información'}`]);
    ws.addRow([]);

    // Resumen general acumulado (no incluye Club ni Tipo de Rodeo — eso queda solo
    // en la tabla detallada de más abajo).
    ws.addRow([`Total de Situaciones: ${resumen?.totalSituaciones ?? 0}`]);
    ws.addRow([`Nota Promedio: ${formatNotaComa(resumen?.promedioNota)}`]);
    ws.addRow([]);

    // Resumen de situaciones por tipo (tipos dinámicos según lo que exista realmente)
    ws.addRow(['Resumen de situaciones']).font = { bold: true, size: 12 };
    const tipoHeaderRow = ws.addRow(['Tipo', 'Cantidad']);
    tipoHeaderRow.eachCell(c => { c.font = HEADER_STYLE.font; c.fill = HEADER_STYLE.fill; c.alignment = HEADER_STYLE.alignment; });
    const tiposEncontrados = Object.entries(resumen?.porTipo || {});
    if (tiposEncontrados.length === 0) {
        ws.addRow(['Sin situaciones registradas', 0]);
    } else {
        tiposEncontrados.forEach(([tipo, cantidad]) => {
            ws.addRow([TIPO_CASO_LABEL[tipo] || tipo, cantidad]);
        });
    }
    ws.addRow(['TOTAL', resumen?.totalSituaciones ?? 0]).font = { bold: true };
    ws.addRow([]);

    // Tabla detallada de rodeos (conserva Club y Tipo de Rodeo)
    const headerRow = ws.addRow(['Fecha', 'Asociación', 'Club', 'Tipo de Rodeo', 'Altera resultado', 'Cantidad de Situaciones', 'Nota']);
    headerRow.eachCell(c => { c.font = HEADER_STYLE.font; c.fill = HEADER_STYLE.fill; c.alignment = HEADER_STYLE.alignment; });

    if (!filas || filas.length === 0) {
        ws.addRow(['No existen rodeos registrados para este jurado.']);
    } else {
        filas.forEach((f, i) => {
            // Mismo dato y mismo criterio que la pantalla (a.altera_resultado /
            // renderAlteraResultado en hojavida.html): true→"Sí", false→"No",
            // null (sin evaluación asociada)→"—" — nunca "No" por defecto.
            const alteraTxto = f.altera_resultado === true ? 'Sí' : f.altera_resultado === false ? 'No' : '—';
            const row = ws.addRow([
                formatFechaDDMMYYYY(f.fecha),
                f.asociacion || '—',
                f.club || '—',
                f.tipo_rodeo || '—',
                alteraTxto,
                f.situaciones ?? 0,
                f.nota != null ? Number(f.nota) : 'Sin nota'
            ]);
            if (i % 2 === 0) row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4F8' } }; });
        });
    }

    ws.getColumn(1).width = 26;
    ws.getColumn(2).width = 22;
    ws.getColumn(3).width = 26;
    ws.getColumn(4).width = 28;
    ws.getColumn(5).width = 18;
    ws.getColumn(6).width = 20;
    ws.getColumn(7).width = 14;
    autoWidth(ws);

    const filename = `Hoja_Vida_${sanitizarNombreArchivo(perfil?.nombre_completo)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    await wb.xlsx.write(res);
}

module.exports = {
    exportarResumenMensual, exportarBonos, exportarPendientes,
    exportarRodeos, exportarResumenJurados, exportarDetalleJurado, exportarAgregado,
    exportarHistorialHojaVida,
    construirLibroResumenJurados, construirCsvResumenJurados, TITULO_RESUMEN_JURADOS
};
