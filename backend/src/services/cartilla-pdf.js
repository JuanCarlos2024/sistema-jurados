const PDFDocument = require('pdfkit');

/**
 * Genera el PDF de una cartilla de jurado y retorna un Buffer.
 * @param {object} cartilla - registro de cartillas_jurado con datos JSONB
 * @param {object} rodeo    - registro de rodeos
 * @param {object} usuario  - { nombre, rut, categoria, tipo_persona }
 * @returns {Promise<Buffer>}
 */
function generarCartillaPDF(cartilla, rodeo, usuario) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const datos = cartilla.datos || {};
        const AZUL  = '#1a3c6e';
        const GRIS  = '#555555';
        const LINEA = '#cccccc';

        // ── Encabezado ────────────────────────────────────────────
        doc.fontSize(18).fillColor(AZUL).font('Helvetica-Bold')
           .text('CARTILLA DE JURADO', { align: 'center' });
        doc.fontSize(11).fillColor(GRIS).font('Helvetica')
           .text('Federación del Rodeo Chileno', { align: 'center' });
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(AZUL).lineWidth(2).stroke();
        doc.moveDown(0.8);

        // ── Bloque 1: Identificación del rodeo ────────────────────
        seccionTitulo(doc, 'BLOQUE 1 — Identificación del rodeo', AZUL);
        campo(doc, 'Club / Sede',      rodeo.club || '—');
        campo(doc, 'Asociación',       rodeo.asociacion || '—');
        campo(doc, 'Fecha',            rodeo.fecha ? fmtFecha(rodeo.fecha) : '—');
        campo(doc, 'Tipo de rodeo',    rodeo.tipo_rodeo_nombre || '—');
        campo(doc, 'Duración (días)',  rodeo.duracion_dias ?? '—');
        doc.moveDown(0.5);

        // ── Bloque 2: Identificación del jurado/delegado ──────────
        seccionTitulo(doc, 'BLOQUE 2 — Identificación del evaluador', AZUL);
        campo(doc, 'Nombre',           usuario.nombre || '—');
        campo(doc, 'RUT',              usuario.rut || '—');
        campo(doc, 'Rol',              usuario.tipo_persona === 'delegado_rentado' ? 'Delegado Rentado' : 'Jurado');
        campo(doc, 'Categoría',        usuario.categoria || (usuario.tipo_persona === 'delegado_rentado' ? 'DR' : '—'));
        doc.moveDown(0.5);

        // ── Bloque 3: Desarrollo del evento ──────────────────────
        seccionTitulo(doc, 'BLOQUE 3 — Desarrollo del evento', AZUL);
        campo(doc, 'N° de colleras juzgadas',   datos.nro_colleras ?? '—');
        campo(doc, 'N° de animales evaluados',  datos.nro_animales ?? '—');
        campo(doc, 'Duración efectiva (horas)', datos.duracion_horas ?? '—');
        campo(doc, 'Se realizó sorteo',          yesNo(datos.realizo_sorteo));
        campo(doc, 'Conformidad con el sorteo',  yesNo(datos.conformidad_sorteo));
        doc.moveDown(0.5);

        // ── Bloque 4: Evaluación de instalaciones ────────────────
        seccionTitulo(doc, 'BLOQUE 4 — Evaluación de instalaciones', AZUL);
        campo(doc, 'Estado de la pista',         datos.estado_pista || '—');
        campo(doc, 'Corrales / manga',           datos.estado_corrales || '—');
        campo(doc, 'Iluminación',                datos.iluminacion || '—');
        campo(doc, 'Baños / vestuarios',         datos.sanitarios || '—');
        campo(doc, 'Condición general',          datos.condicion_general || '—');
        doc.moveDown(0.5);

        // ── Bloque 5: Evaluación organizativa ────────────────────
        seccionTitulo(doc, 'BLOQUE 5 — Evaluación organizativa', AZUL);
        campo(doc, 'Puntualidad del inicio',     datos.puntualidad || '—');
        campo(doc, 'Coordinación general',       datos.coordinacion || '—');
        campo(doc, 'Trato al jurado',            datos.trato_jurado || '—');
        campo(doc, 'Difusión y comunicación',    datos.difusion || '—');
        doc.moveDown(0.5);

        // ── Bloque 6: Observaciones y confirmación ───────────────
        seccionTitulo(doc, 'BLOQUE 6 — Observaciones e incidentes', AZUL);
        const obs = datos.observaciones || 'Sin observaciones registradas.';
        doc.fontSize(10).fillColor('#333')
           .text(obs, { width: 495, lineGap: 3 });
        doc.moveDown(1);

        // ── Firma / cierre ────────────────────────────────────────
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(LINEA).lineWidth(1).stroke();
        doc.moveDown(0.6);
        doc.fontSize(9).fillColor(GRIS)
           .text(`Enviada el: ${cartilla.enviada_en ? fmtFechaHora(cartilla.enviada_en) : '—'}`, { align: 'left' })
           .text(`Generado por el Sistema de Jurados — Federación del Rodeo Chileno`, { align: 'left' });

        doc.end();
    });
}

// ── Helpers internos ──────────────────────────────────────────────
function seccionTitulo(doc, texto, color) {
    doc.fontSize(11).fillColor(color).font('Helvetica-Bold').text(texto);
    doc.moveDown(0.3);
    doc.font('Helvetica').fillColor('#333');
}

function campo(doc, etiqueta, valor) {
    doc.fontSize(10)
       .fillColor('#555').font('Helvetica-Bold').text(`${etiqueta}: `, { continued: true })
       .fillColor('#222').font('Helvetica').text(String(valor));
}

function yesNo(v) {
    if (v === true  || v === 'si'  || v === 'sí')  return 'Sí';
    if (v === false || v === 'no')                  return 'No';
    return v ?? '—';
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
