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

module.exports = { exportarResumenMensual, exportarBonos, exportarPendientes };
