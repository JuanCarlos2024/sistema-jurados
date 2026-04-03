const ExcelJS = require('exceljs');
const supabase = require('../config/supabase');
const { calcularResumenMensual, obtenerRetencion } = require('./calculo');

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

function autoWidth(sheet) {
    sheet.columns.forEach(col => {
        let maxLen = col.header ? col.header.length : 10;
        col.eachCell({ includeEmpty: false }, cell => {
            const len = cell.value ? String(cell.value).length : 0;
            if (len > maxLen) maxLen = len;
        });
        col.width = Math.min(maxLen + 4, 50);
    });
}

function formatCLP(monto) {
    if (monto == null) return '$0';
    return '$' + Number(monto).toLocaleString('es-CL');
}

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
 * Respeta filtros: año, mes, buscar.
 */
async function exportarRodeos(filtros, res) {
    const { año, mes, buscar } = filtros;
    const añoNum = parseInt(año);
    const mesNum = parseInt(mes);

    let q = supabase
        .from('rodeos')
        .select('id, club, asociacion, fecha, tipo_rodeo_nombre, duracion_dias, origen, estado')
        .eq('estado', 'activo')
        .order('fecha', { ascending: false });

    if (!isNaN(añoNum) && !isNaN(mesNum) && mesNum >= 1 && mesNum <= 12) {
        q = q.gte('fecha', `${añoNum}-${String(mesNum).padStart(2,'0')}-01`)
             .lte('fecha', new Date(añoNum, mesNum, 0).toISOString().split('T')[0]);
    } else if (!isNaN(añoNum)) {
        q = q.gte('fecha', `${añoNum}-01-01`).lte('fecha', `${añoNum}-12-31`);
    }
    if (buscar) q = q.or(`club.ilike.%${buscar}%,asociacion.ilike.%${buscar}%`);

    const { data: rodeos } = await q;

    // Agregar stats de asignaciones
    const ids = (rodeos || []).map(r => r.id);
    const { data: asigs } = ids.length > 0
        ? await supabase.from('asignaciones').select('rodeo_id, pago_base_calculado').in('rodeo_id', ids).eq('estado', 'activo')
        : { data: [] };

    const statsMap = {};
    (asigs || []).forEach(a => {
        if (!statsMap[a.rodeo_id]) statsMap[a.rodeo_id] = { n: 0, total: 0 };
        statsMap[a.rodeo_id].n++;
        statsMap[a.rodeo_id].total += (a.pago_base_calculado || 0);
    });

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Sistema Jurados - Rodeo Chileno';
    const ws = wb.addWorksheet('Rodeos');

    ws.columns = [
        { header: 'Fecha',       key: 'fecha',     width: 14 },
        { header: 'Club',        key: 'club',       width: 28 },
        { header: 'Asociación',  key: 'asoc',       width: 22 },
        { header: 'Tipo Rodeo',  key: 'tipo',       width: 30 },
        { header: 'Días',        key: 'dias',       width: 8  },
        { header: 'Origen',      key: 'origen',     width: 12 },
        { header: 'Jurados',     key: 'jurados',    width: 10 },
        { header: 'Total Pagos', key: 'total',      width: 16 },
    ];
    ws.getRow(1).eachCell(c => { c.font = HEADER_STYLE.font; c.fill = HEADER_STYLE.fill; c.alignment = HEADER_STYLE.alignment; });

    (rodeos || []).forEach((r, i) => {
        const s = statsMap[r.id] || { n: 0, total: 0 };
        const row = ws.addRow([r.fecha, r.club, r.asociacion, r.tipo_rodeo_nombre, r.duracion_dias, r.origen, s.n, formatCLP(s.total)]);
        if (i % 2 === 0) row.eachCell(c => { c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF0F4F8' } }; });
    });
    autoWidth(ws);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=rodeos${año?'_'+año:''}${mes?'_'+mes:''}.xlsx`);
    await wb.xlsx.write(res);
}

/**
 * Exportar resumen mensual por jurado (Excel o CSV).
 * Datos ya calculados vienen como parámetro desde la ruta.
 */
async function exportarResumenJurados(datos, retencionPct, formato, res) {
    const headers = ['Código', 'Nombre', 'RUT', 'Categoría', 'Tipo', 'Rodeos', 'Pago Base', 'Bonos Aprobados', 'Bruto', 'Retención', 'Líquido'];
    const filas = datos.map(j => [
        j.codigo_interno, j.nombre_completo, j.rut || '—', j.categoria || '—',
        j.tipo_persona === 'jurado' ? 'Jurado' : 'Delegado Rentado',
        j.cant_rodeos, formatCLP(j.total_pago_base), formatCLP(j.total_bono_aprobado),
        formatCLP(j.bruto), formatCLP(j.retencion_monto), formatCLP(j.liquido)
    ]);

    if (formato === 'csv') {
        const csv = generarCSV(headers, filas);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=resumen_jurados.csv');
        return res.send(csv);
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Resumen Jurados');
    ws.columns = [
        { header: 'Código', key: 'cod', width: 12 }, { header: 'Nombre', key: 'nom', width: 30 },
        { header: 'RUT', key: 'rut', width: 14 },    { header: 'Categoría', key: 'cat', width: 12 },
        { header: 'Tipo', key: 'tipo', width: 18 },  { header: 'Rodeos', key: 'rod', width: 10 },
        { header: 'Pago Base', key: 'pb', width: 16 }, { header: 'Bonos', key: 'bon', width: 16 },
        { header: 'Bruto', key: 'bruto', width: 16 }, { header: 'Retención', key: 'ret', width: 16 },
        { header: 'Líquido', key: 'liq', width: 16 },
    ];
    ws.getRow(1).eachCell(c => { c.font = HEADER_STYLE.font; c.fill = HEADER_STYLE.fill; c.alignment = HEADER_STYLE.alignment; });
    ws.getRow(1).height = 20;

    datos.forEach((j, i) => {
        const row = ws.addRow([
            j.codigo_interno, j.nombre_completo, j.rut || '—', j.categoria || '—',
            j.tipo_persona === 'jurado' ? 'Jurado' : 'Delegado Rentado',
            j.cant_rodeos, formatCLP(j.total_pago_base), formatCLP(j.total_bono_aprobado),
            formatCLP(j.bruto), formatCLP(j.retencion_monto), formatCLP(j.liquido)
        ]);
        if (i % 2 === 0) row.eachCell(c => { c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF0F4F8' } }; });
    });

    // Fila de totales
    const totRow = ws.addRow(['', 'TOTALES', '', '', '',
        datos.reduce((s,j) => s+j.cant_rodeos, 0),
        formatCLP(datos.reduce((s,j) => s+j.total_pago_base, 0)),
        formatCLP(datos.reduce((s,j) => s+j.total_bono_aprobado, 0)),
        formatCLP(datos.reduce((s,j) => s+j.bruto, 0)),
        formatCLP(datos.reduce((s,j) => s+j.retencion_monto, 0)),
        formatCLP(datos.reduce((s,j) => s+j.liquido, 0)),
    ]);
    totRow.eachCell(c => { c.font = { bold: true }; c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFFE0B2' } }; });

    autoWidth(ws);
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

module.exports = {
    exportarResumenMensual, exportarBonos, exportarPendientes,
    exportarRodeos, exportarResumenJurados, exportarDetalleJurado, exportarAgregado
};
