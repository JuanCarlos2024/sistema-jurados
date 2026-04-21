const PDFDocument = require('pdfkit');

/**
 * Genera el PDF de una cartilla de jurado y retorna un Buffer.
 * @param {object} cartilla - registro de cartillas_jurado con datos JSONB
 * @param {object} rodeo    - registro de rodeos
 * @param {object} usuario  - { nombre_completo, rut, categoria, tipo_persona }
 * @returns {Promise<Buffer>}
 */
function generarCartillaPDF(cartilla, rodeo, usuario) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.on('end',  () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const datos = cartilla.datos || {};
        const AZUL  = '#1a3c6e';
        const GRIS  = '#666666';

        // ── Encabezado ────────────────────────────────────────────
        doc.fontSize(18).fillColor(AZUL).font('Helvetica-Bold')
           .text('CARTILLA DE JURADO', { align: 'center' });
        doc.fontSize(11).fillColor(GRIS).font('Helvetica')
           .text('Federación del Rodeo Chileno', { align: 'center' });
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(AZUL).lineWidth(2).stroke();
        doc.moveDown(0.8);

        // ── Bloque 1: Datos del rodeo ─────────────────────────────
        seccion(doc, 'BLOQUE 1 — Datos del rodeo', AZUL);
        campo(doc, 'Club / Sede',        rodeo.club || '—');
        campo(doc, 'Asociación',         rodeo.asociacion || '—');
        campo(doc, 'Fecha',              rodeo.fecha ? fmtFecha(rodeo.fecha) : '—');
        campo(doc, 'Tipo de rodeo',      rodeo.tipo_rodeo_nombre || '—');
        campo(doc, 'Hora de inicio',     datos.hora_inicio || '—');
        campo(doc, 'Nombre delegado',    datos.delegado_nombre || '—');
        campo(doc, 'Teléfono delegado',  datos.delegado_telefono || '—');
        doc.moveDown(0.5);

        // ── Bloque 2: Identificación del jurado ───────────────────
        seccion(doc, 'BLOQUE 2 — Identificación del jurado', AZUL);
        campo(doc, 'Nombre',    usuario.nombre_completo || '—');
        campo(doc, 'RUT',       usuario.rut || '—');
        campo(doc, 'Rol',       usuario.tipo_persona === 'delegado_rentado' ? 'Delegado Rentado' : 'Jurado');
        campo(doc, 'Categoría', usuario.categoria || (usuario.tipo_persona === 'delegado_rentado' ? 'DR' : '—'));
        doc.moveDown(0.5);

        // ── Bloque 3: Preguntas generales ─────────────────────────
        seccion(doc, 'BLOQUE 3 — Preguntas generales', AZUL);
        campo(doc, 'Serie de campeones a 2 vueltas',                         yn(datos.serie_campeones_2_vueltas));
        campo(doc, '¿Hubo faltas disciplinarias o reglamentarias?',          yn(datos.hubo_faltas));
        campo(doc, '¿Hubo ganado fuera del peso reglamentario?',             yn(datos.hubo_ganado_fuera_peso));
        campo(doc, '¿Hubo movimiento de rienda?',                            yn(datos.hubo_movimiento_rienda));
        campo(doc, '¿La caseta del jurado ofrece condiciones adecuadas?',    yn(datos.caseta_adecuada));
        doc.moveDown(0.5);

        // ── Bloque 4: Ganado fuera de peso (condicional) ──────────
        if (datos.hubo_ganado_fuera_peso === 'si') {
            seccion(doc, 'BLOQUE 4 — Ganado fuera del peso reglamentario', AZUL);
            campo(doc, 'Clasificación (Art. 242)', datos.clasificacion_peso || '—');
            const filas = datos.filas_ganado || [];
            if (filas.length > 0) {
                doc.moveDown(0.3);
                doc.fontSize(10).fillColor(AZUL).font('Helvetica-Bold').text('Detalle de series:');
                doc.font('Helvetica').fillColor('#333');
                filas.forEach((f, i) => {
                    doc.fontSize(9).text(
                        `  ${i + 1}. Serie: ${f.serie || '—'} | Cantidad: ${f.cantidad || '—'} | %: ${f.porcentaje || '—'} | Obs: ${f.observacion || '—'}`,
                        { lineGap: 2 }
                    );
                });
            }
            doc.moveDown(0.5);
        }

        // ── Bloque 5: Faltas (condicional) ────────────────────────
        if (datos.hubo_faltas === 'si') {
            seccion(doc, 'BLOQUE 5 — Faltas disciplinarias o reglamentarias', AZUL);
            doc.fontSize(10).fillColor('#333').font('Helvetica')
               .text(datos.descripcion_faltas || '—', { width: 495, lineGap: 3 });
            doc.moveDown(0.5);
        }

        // ── Bloque 6: Movimiento a la rienda (condicional) ────────
        if (datos.hubo_movimiento_rienda === 'si') {
            seccion(doc, 'BLOQUE 6 — Movimiento a la rienda', AZUL);
            const registros = datos.registros_rienda || [];
            registros.forEach((r, i) => {
                doc.fontSize(10).fillColor(AZUL).font('Helvetica-Bold').text(`Registro ${i + 1}:`);
                doc.font('Helvetica').fillColor('#333');
                campo(doc, 'Categoría',            r.categoria || '—');
                campo(doc, 'Sistema',              r.sistema || '—');
                campo(doc, 'Nombre del socio',     r.nombre_socio || '—');
                campo(doc, 'RUT del socio',        r.rut_socio || '—');
                campo(doc, 'N° de socio',          r.nro_socio || '—');
                campo(doc, 'Nombre del equino',    r.nombre_equino || '—');
                campo(doc, 'N° inscripción equino',r.nro_inscripcion || '—');
                campo(doc, 'Puntaje',              r.puntaje || '—');
                doc.moveDown(0.3);
            });
            doc.moveDown(0.3);
        }

        // ── Bloque 7: Observaciones finales ───────────────────────
        seccion(doc, 'BLOQUE 7 — Observaciones finales / Varios', AZUL);
        doc.fontSize(10).fillColor('#333').font('Helvetica')
           .text(datos.observaciones_finales || 'Sin observaciones.', { width: 495, lineGap: 3 });
        doc.moveDown(1);

        // ── Cierre ────────────────────────────────────────────────
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').lineWidth(1).stroke();
        doc.moveDown(0.5);
        doc.fontSize(9).fillColor(GRIS)
           .text(`Enviada el: ${cartilla.enviada_en ? fmtFechaHora(cartilla.enviada_en) : '—'}`)
           .text('Generado por el Sistema de Jurados — Federación del Rodeo Chileno');

        doc.end();
    });
}

// ── Helpers ───────────────────────────────────────────────────────
function seccion(doc, texto, color) {
    doc.fontSize(11).fillColor(color).font('Helvetica-Bold').text(texto);
    doc.moveDown(0.3);
    doc.font('Helvetica').fillColor('#333');
}

function campo(doc, etiqueta, valor) {
    doc.fontSize(10)
       .fillColor('#555').font('Helvetica-Bold').text(`${etiqueta}: `, { continued: true })
       .fillColor('#222').font('Helvetica').text(String(valor ?? '—'));
}

function yn(v) {
    if (v === 'si' || v === true)  return 'Sí';
    if (v === 'no' || v === false) return 'No';
    return '—';
}

function fmtFecha(iso) {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
}

function fmtFechaHora(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('es-CL') + ' ' + d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
}

module.exports = { generarCartillaPDF };
