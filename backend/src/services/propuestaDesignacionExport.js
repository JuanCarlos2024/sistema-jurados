// ═════════════════════════════════════════════════════════════════════════
// Propuesta de Designación — Fase 2C, sección 5: exportación Excel/PDF.
//
// Reutiliza EXACTAMENTE las mismas bibliotecas ya presentes en el proyecto
// (exceljs/pdfkit — ver services/exportacion.js y services/cartilla-pdf.js)
// y el mismo patrón de estilo (encabezado azul, filas alternadas) — ninguna
// dependencia nueva. Vive en un archivo propio (no dentro de exportacion.js,
// que es para reportes financieros/operativos ya existentes) porque este
// módulo tiene su propio dominio de datos (propuestas_designacion) y no
// comparte ninguna de las consultas de aquel archivo.
//
// NUNCA modifica nada — ambas funciones son de SOLO LECTURA sobre
// propuestas_designacion/propuestas_designacion_detalle/bitacora_
// designaciones/rodeos/usuarios_pagados/administradores/asignaciones.
// ═════════════════════════════════════════════════════════════════════════
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const supabase = require('../config/supabase');
const { obtenerJuradoEfectivo, resumenPropuesta } = require('./propuestaDesignacion');

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a5f' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };

function sanitizarNombreArchivo(nombre) {
    return (nombre || 'propuesta')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .slice(0, 60);
}

function autoWidth(sheet) {
    sheet.columns.forEach(col => {
        let maxLen = col.header ? String(col.header).length : 10;
        col.eachCell({ includeEmpty: false }, cell => {
            const len = cell.value ? String(cell.value).length : 0;
            if (len > maxLen) maxLen = len;
        });
        col.width = Math.min(maxLen + 4, 50);
    });
}

function etiquetaEstadoPropuesta(estado) {
    return { BORRADOR: 'Borrador', CONFIRMADA: 'Confirmada', DESCARTADA: 'Descartada' }[estado] || estado;
}

// ─── Carga TODOS los datos necesarios para exportar una propuesta, en un ──
// único lugar reutilizado por Excel y PDF — nunca se repite la consulta en
// cada formato. Nunca escribe nada.
// @returns { propuesta, filas: [{ rodeo, v1Nombre, actualNombre, estado_revision, origen_seleccion,
//   modificado, ultimoMovimiento:{motivo,actor,fecha}|null, advertencias, aplicada }], resumen }
async function cargarDatosExportacion(propuestaId) {
    const { data: propuesta, error: errProp } = await supabase
        .from('propuestas_designacion')
        .select('id, estado, motor_usado, fecha_corte_tecnica, resultado_cobertura_json, advertencias_json, created_at, temporadas(nombre)')
        .eq('id', propuestaId)
        .maybeSingle();
    if (errProp) throw new Error(errProp.message);
    if (!propuesta) return null;

    const { data: detalles, error: errDet } = await supabase
        .from('propuestas_designacion_detalle')
        .select('id, rodeo_id, jurado_id_propuesto, jurado_id_seleccionado, estado_revision, origen_seleccion, metricas_json, rodeos(club, asociacion, fecha, duracion_dias, tipo_rodeo_nombre)')
        .eq('propuesta_id', propuestaId)
        .order('created_at', { ascending: true });
    if (errDet) throw new Error(errDet.message);

    const idsDetalle = (detalles || []).map(d => d.id);
    const idsJurados = [...new Set((detalles || []).flatMap(d => [d.jurado_id_propuesto, d.jurado_id_seleccionado]).filter(Boolean))];

    const [{ data: jurados }, { data: movimientos }, { data: asigReales }] = await Promise.all([
        idsJurados.length > 0
            ? supabase.from('usuarios_pagados').select('id, nombre_completo').in('id', idsJurados)
            : Promise.resolve({ data: [] }),
        idsDetalle.length > 0
            ? supabase.from('bitacora_designaciones')
                .select('propuesta_detalle_id, nombre_nuevo_snapshot, motivo_detalle, actor_id, created_at, catalogo_motivos_designacion(etiqueta)')
                .in('propuesta_detalle_id', idsDetalle)
                .order('created_at', { ascending: true })
            : Promise.resolve({ data: [] }),
        idsDetalle.length > 0
            ? supabase.from('asignaciones').select('propuesta_detalle_id').in('propuesta_detalle_id', idsDetalle)
            : Promise.resolve({ data: [] })
    ]);

    const nombresPorId = new Map((jurados || []).map(j => [j.id, j.nombre_completo]));
    const ultimoMovimientoPorDetalle = new Map();
    (movimientos || []).forEach(m => ultimoMovimientoPorDetalle.set(m.propuesta_detalle_id, m)); // el último sobrescribe (orden ascendente)
    const aplicadaPorDetalle = new Set((asigReales || []).map(a => a.propuesta_detalle_id));

    const filas = (detalles || []).map(d => {
        const juradoActualId = obtenerJuradoEfectivo(d);
        const ultimoMov = ultimoMovimientoPorDetalle.get(d.id) || null;
        return {
            rodeo: d.rodeos || null,
            v1Nombre: d.jurado_id_propuesto ? (nombresPorId.get(d.jurado_id_propuesto) || '—') : null,
            actualNombre: juradoActualId ? (nombresPorId.get(juradoActualId) || '—') : null,
            estado_revision: d.estado_revision,
            origen_seleccion: d.origen_seleccion,
            modificado: !!d.jurado_id_propuesto && juradoActualId !== d.jurado_id_propuesto,
            ultimoMovimiento: ultimoMov ? {
                motivo: ultimoMov.catalogo_motivos_designacion?.etiqueta || null,
                motivo_detalle: ultimoMov.motivo_detalle || null,
                fecha: ultimoMov.created_at
            } : null,
            advertencias: (d.metricas_json?.advertencias_aceptadas || []).map(a => a.tipo),
            aplicada: aplicadaPorDetalle.has(d.id)
        };
    });

    return { propuesta, filas, resumen: resumenPropuesta(detalles) };
}

// ─── Excel — Resumen general + Detalle completo de todos los rodeos ──────
async function exportarPropuestaExcel(propuestaId, res) {
    const datos = await cargarDatosExportacion(propuestaId);
    if (!datos) return null;
    const { propuesta, filas, resumen } = datos;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Sistema Jurados - Rodeo Chileno';
    wb.created = new Date();

    const wsResumen = wb.addWorksheet('Resumen');
    wsResumen.columns = [{ header: 'Campo', key: 'campo', width: 32 }, { header: 'Valor', key: 'valor', width: 50 }];
    wsResumen.getRow(1).eachCell(c => { c.font = HEADER_FONT; c.fill = HEADER_FILL; });
    const filasResumen = [
        ['Temporada', propuesta.temporadas?.nombre || '—'],
        ['Estado de la propuesta', etiquetaEstadoPropuesta(propuesta.estado)],
        ['Motor utilizado', propuesta.motor_usado === 'global' ? 'Motor global optimizado' : 'Motor actual'],
        ['Fecha de corte de la nota técnica', propuesta.fecha_corte_tecnica ? new Date(propuesta.fecha_corte_tecnica).toLocaleString('es-CL') : '—'],
        ['Fecha de generación', new Date(propuesta.created_at).toLocaleString('es-CL')],
        ['Total de rodeos', resumen.total_rodeos],
        ['Aceptados', resumen.aceptados], ['Modificados', resumen.modificados], ['Pendientes', resumen.pendientes],
        ['Sin propuesta', resumen.sin_propuesta], ['No evaluables', resumen.no_evaluables],
        ['Cobertura obtenida (motor global)', propuesta.resultado_cobertura_json?.cobertura_obtenida ?? '—'],
        ['Cupos pendientes (motor global)', propuesta.resultado_cobertura_json?.cupos_pendientes ?? '—'],
        ['Estado de búsqueda (motor global)', propuesta.resultado_cobertura_json?.estado_busqueda ?? '—']
    ];
    filasResumen.forEach(([campo, valor]) => wsResumen.addRow({ campo, valor }));

    const wsDetalle = wb.addWorksheet('Detalle');
    wsDetalle.columns = [
        { header: 'Club', key: 'club', width: 26 }, { header: 'Asociación', key: 'asociacion', width: 20 },
        { header: 'Fecha', key: 'fecha', width: 12 }, { header: 'Tipo de rodeo', key: 'tipo_rodeo', width: 22 },
        { header: 'Jurado propuesto (V1)', key: 'v1', width: 26 }, { header: 'Jurado seleccionado (actual)', key: 'actual', width: 26 },
        { header: 'Estado', key: 'estado', width: 16 }, { header: 'Origen de la selección', key: 'origen', width: 20 },
        { header: '¿Modificado?', key: 'modificado', width: 14 }, { header: 'Motivo del cambio', key: 'motivo', width: 26 },
        { header: 'Fecha del cambio', key: 'fecha_cambio', width: 18 }, { header: 'Advertencias', key: 'advertencias', width: 30 },
        { header: 'Designación real creada', key: 'aplicada', width: 20 }
    ];
    wsDetalle.getRow(1).eachCell(c => { c.font = HEADER_FONT; c.fill = HEADER_FILL; });
    filas.forEach((f, i) => {
        const row = wsDetalle.addRow({
            club: f.rodeo?.club || '—', asociacion: f.rodeo?.asociacion || '—', fecha: f.rodeo?.fecha || '—',
            tipo_rodeo: f.rodeo?.tipo_rodeo_nombre || '—', v1: f.v1Nombre || 'Sin propuesta', actual: f.actualNombre || 'Sin jurado',
            estado: f.estado_revision, origen: f.origen_seleccion || '—', modificado: f.modificado ? 'Sí' : 'No',
            motivo: f.ultimoMovimiento?.motivo || '—', fecha_cambio: f.ultimoMovimiento?.fecha ? new Date(f.ultimoMovimiento.fecha).toLocaleString('es-CL') : '—',
            advertencias: f.advertencias.length > 0 ? f.advertencias.join(', ') : '—',
            aplicada: f.aplicada ? 'Sí' : 'No'
        });
        if (i % 2 === 0) row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4F8' } }; });
    });
    autoWidth(wsDetalle);

    const estadoArchivo = propuesta.estado === 'BORRADOR' ? 'Borrador' : etiquetaEstadoPropuesta(propuesta.estado);
    const filename = `Propuesta_Designacion_${estadoArchivo}_${sanitizarNombreArchivo(propuesta.temporadas?.nombre)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    await wb.xlsx.write(res);
    return true;
}

// ─── PDF — Resumen ejecutivo + distribución + advertencias + V1/V2 ───────
function generarPropuestaPDF(propuesta, filas, resumen) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const AZUL = '#1a3c6e';
        const GRIS = '#666666';

        doc.fontSize(18).fillColor(AZUL).font('Helvetica-Bold').text('PROPUESTA DE DESIGNACIÓN DE JURADOS', { align: 'center' });
        doc.fontSize(11).fillColor(GRIS).font('Helvetica').text('Federación del Rodeo Chileno', { align: 'center' });
        doc.moveDown(0.3);
        doc.fontSize(10).fillColor(propuesta.estado === 'BORRADOR' ? '#CC6600' : AZUL).font('Helvetica-Bold')
            .text(propuesta.estado === 'BORRADOR' ? 'BORRADOR — AÚN NO APLICADO A RODEOS' : etiquetaEstadoPropuesta(propuesta.estado).toUpperCase(), { align: 'center' });
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(AZUL).lineWidth(2).stroke();
        doc.moveDown(0.8);

        // Resumen ejecutivo de cobertura
        doc.fontSize(13).fillColor(AZUL).font('Helvetica-Bold').text('Resumen ejecutivo de cobertura');
        doc.fontSize(10).fillColor('#333').font('Helvetica');
        doc.text(`Motor utilizado: ${propuesta.motor_usado === 'global' ? 'Motor global optimizado' : 'Motor actual'}`);
        doc.text(`Temporada: ${propuesta.temporadas?.nombre || '—'}`);
        doc.text(`Total de rodeos: ${resumen.total_rodeos} — Aceptados: ${resumen.aceptados} — Modificados: ${resumen.modificados} — Pendientes: ${resumen.pendientes} — Sin propuesta: ${resumen.sin_propuesta}`);
        if (propuesta.resultado_cobertura_json) {
            const c = propuesta.resultado_cobertura_json;
            doc.text(`Motor global — estado de búsqueda: ${c.estado_busqueda || '—'} · cobertura obtenida: ${c.cobertura_obtenida ?? '—'}/${c.total_cupos ?? '—'} · cupos pendientes: ${c.cupos_pendientes ?? '—'}`);
        }
        doc.moveDown(0.6);

        // Distribución de jurados por rodeo
        doc.fontSize(13).fillColor(AZUL).font('Helvetica-Bold').text('Distribución de jurados por rodeo');
        doc.fontSize(9).fillColor('#333').font('Helvetica');
        filas.forEach(f => {
            const linea = `${f.rodeo?.club || '—'} (${f.rodeo?.fecha || '—'}) — ${f.actualNombre || 'Sin jurado'} [${f.estado_revision}]${f.aplicada ? ' — designación real creada' : ''}`;
            doc.text(linea, { lineGap: 2 });
        });
        doc.moveDown(0.6);

        // Advertencias relevantes
        const filasConAdvertencias = filas.filter(f => f.advertencias.length > 0);
        doc.fontSize(13).fillColor(AZUL).font('Helvetica-Bold').text('Advertencias relevantes');
        doc.fontSize(9).fillColor('#333').font('Helvetica');
        if (filasConAdvertencias.length === 0) {
            doc.text('Sin advertencias registradas.');
        } else {
            filasConAdvertencias.forEach(f => {
                doc.text(`${f.rodeo?.club || '—'} (${f.rodeo?.fecha || '—'}): ${f.advertencias.join(', ')}`, { lineGap: 2 });
            });
        }
        doc.moveDown(0.6);

        // Comparación V1/V2 cuando existan modificaciones
        const filasModificadas = filas.filter(f => f.modificado);
        doc.fontSize(13).fillColor(AZUL).font('Helvetica-Bold').text('Comparación V1 / versión actual (solo rodeos modificados)');
        doc.fontSize(9).fillColor('#333').font('Helvetica');
        if (filasModificadas.length === 0) {
            doc.text('Ningún rodeo fue modificado manualmente — toda fila conserva la propuesta original del motor.');
        } else {
            filasModificadas.forEach(f => {
                doc.text(
                    `${f.rodeo?.club || '—'} (${f.rodeo?.fecha || '—'}): V1 "${f.v1Nombre}" → actual "${f.actualNombre}"` +
                    (f.ultimoMovimiento?.motivo ? ` — motivo: ${f.ultimoMovimiento.motivo}` : ''),
                    { lineGap: 2 }
                );
            });
        }

        doc.end();
    });
}

async function exportarPropuestaPDF(propuestaId, res) {
    const datos = await cargarDatosExportacion(propuestaId);
    if (!datos) return null;
    const buffer = await generarPropuestaPDF(datos.propuesta, datos.filas, datos.resumen);
    const filename = `Propuesta_Designacion_${sanitizarNombreArchivo(datos.propuesta.temporadas?.nombre)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.send(buffer);
    return true;
}

module.exports = { cargarDatosExportacion, exportarPropuestaExcel, exportarPropuestaPDF };
