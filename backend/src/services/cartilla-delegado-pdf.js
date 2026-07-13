const PDFDocument = require('pdfkit');

/**
 * Genera el PDF de una cartilla del delegado y retorna un Buffer.
 * @param {object} cartilla - registro de cartillas_delegado con todos los campos
 * @param {object} rodeo    - registro de rodeos
 * @returns {Promise<Buffer>}
 */
function generarCartillaDelegadoPDF(cartilla, rodeo) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.on('end',  () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const rj   = cartilla.respuestas_json || {};
        const AZUL = '#1a3c6e';
        const GRIS = '#666666';

        // ── Encabezado ─────────────────────────────────────────────
        doc.fontSize(16).fillColor(AZUL).font('Helvetica-Bold')
           .text('INFORME DEL DELEGADO OFICIAL DEL RODEO', { align: 'center' });
        doc.fontSize(10).fillColor(GRIS).font('Helvetica')
           .text('Federación Deportiva Nacional de Rodeo Chileno', { align: 'center' });
        doc.moveDown(0.4);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(AZUL).lineWidth(2).stroke();
        doc.moveDown(0.7);

        // ── Estado y fechas ─────────────────────────────────────────
        const estadoLabel = { borrador:'Borrador', enviada:'Enviada', observada:'Observada', reenviada:'Reenviada', aprobada:'Aprobada' }[cartilla.estado] || cartilla.estado;
        campo(doc, 'Estado', estadoLabel);
        if (cartilla.enviada_en)  campo(doc, 'Enviada el', fmtFechaHora(cartilla.enviada_en));
        if (cartilla.aprobada_en) campo(doc, 'Aprobada el', fmtFechaHora(cartilla.aprobada_en));
        doc.moveDown(0.5);

        // ── I. Identificación del Rodeo ────────────────────────────
        seccion(doc, 'I. IDENTIFICACIÓN DEL RODEO', AZUL);
        campo(doc, 'Club / Asociación', [rodeo?.club, rodeo?.asociacion].filter(Boolean).join(' — ') || cartilla.club_asociacion_organizador || '—');
        campo(doc, 'Fecha del Rodeo',   cartilla.fecha_rodeo ? fmtFecha(cartilla.fecha_rodeo) : '—');
        campo(doc, 'Temporada',         cartilla.temporada || '—');
        campo(doc, 'Tipo de Rodeo',     cartilla.tipo_rodeo || '—');
        campo(doc, 'Delegado Oficial',  cartilla.delegado_nombre || '—');
        campo(doc, 'Teléfono',          cartilla.delegado_telefono || '—');
        campo(doc, 'Secretario del Jurado', cartilla.secretario_jurado || '—');
        campo(doc, 'N° de Socio (Secretario)', cartilla.secretario_numero_socio || '—');
        campo(doc, 'Público en Serie de Campeones', cartilla.publico_serie_campeones != null ? String(cartilla.publico_serie_campeones) : '—');
        campo(doc, 'Serie Campeones a 2 vueltas', yn(cartilla.serie_campeones_dos_vueltas));
        campo(doc, 'Incluye informe disciplinario', yn(cartilla.incluye_informe_disciplinario));
        campo(doc, 'Incluye informe ganado bajo peso', yn(cartilla.incluye_informe_ganado_bajo_peso));
        doc.moveDown(0.3);
        doc.fontSize(10).fillColor(AZUL).font('Helvetica-Bold').text('Certificación del Club Organizador:');
        doc.font('Helvetica').fillColor('#333');
        campo(doc, 'Medialuna de la comuna del club', yn(cartilla.certificacion_medialuna_comuna));
        campo(doc, 'Más de 200 personas (Serie Campeones)', yn(cartilla.certificacion_mas_200_personas));
        campo(doc, 'Más de 250 personas (Serie Campeones)', yn(cartilla.certificacion_mas_250_personas));
        campo(doc, 'Proyecto de vinculación con la comunidad', yn(cartilla.certificacion_vinculacion_comunidad));
        doc.moveDown(0.5);

        // ── II. Ganado ─────────────────────────────────────────────
        const series = Array.isArray(rj.ganado_series) ? rj.ganado_series : [];
        if (series.length > 0) {
            seccion(doc, 'II. GANADO UTILIZADO', AZUL);
            series.forEach((s, i) => {
                doc.fontSize(10).fillColor(AZUL).font('Helvetica-Bold').text(`  Serie ${i + 1}: ${s.nombre || '—'}`);
                doc.font('Helvetica').fillColor('#333');
                if (s.fp_baj || s.fp_sob) {
                    campo(doc, '  Ganado bajo peso', s.fp_baj || '0');
                    campo(doc, '  Ganado sobre peso', s.fp_sob || '0');
                }
                doc.moveDown(0.2);
            });
            doc.moveDown(0.3);
        }

        // ── III. Desempeño del Jurado ──────────────────────────────
        const dj = rj.desempeno_jurado;
        if (dj) {
            seccion(doc, 'III. DESEMPEÑO DEL JURADO', AZUL);
            campo(doc, 'Evaluación realizada', yn(dj.evaluacion_realizada));
            if (dj.evaluacion_realizada === 'si' || dj.evaluacion_realizada === true) {
                campo(doc, 'Fecha de evaluación', dj.fecha_evaluacion || '—');
                campo(doc, 'Cantidad de jurados', dj.cantidad_jurados || '—');
                campo(doc, 'Más de un jurado', yn(dj.mas_de_un_jurado));
                if (Array.isArray(dj.jurados) && dj.jurados.length > 0) {
                    doc.fontSize(10).fillColor(AZUL).font('Helvetica-Bold').text('Jurados evaluados:');
                    doc.font('Helvetica').fillColor('#333');
                    dj.jurados.forEach((j, i) => {
                        doc.fontSize(9).text(`  ${i + 1}. ${j.nombre || '—'} (${j.cargo || '—'}) — Nota: ${j.nota || '—'}`);
                    });
                }
            }
            if (dj.observaciones) campo(doc, 'Observaciones', dj.observaciones);
            doc.moveDown(0.5);
        }

        // ── IV. Disciplina ─────────────────────────────────────────
        const disc = rj.disciplina_informe;
        if (disc) {
            seccion(doc, 'IV. INFORME DE DISCIPLINA', AZUL);
            campo(doc, 'Hubo informe disciplinario', yn(disc.hubo_informe));
            if (disc.hubo_informe === 'si' && Array.isArray(disc.situaciones) && disc.situaciones.length > 0) {
                doc.fontSize(10).fillColor(AZUL).font('Helvetica-Bold').text('Situaciones disciplinarias:');
                doc.font('Helvetica').fillColor('#333');
                disc.situaciones.forEach((s, i) => {
                    doc.fontSize(9).text(`  ${i + 1}. Art. ${s.articulo || '—'} — ${s.descripcion || '—'}`);
                    if (s.sancion) doc.text(`     Sanción: ${s.sancion}`);
                });
            }
            doc.moveDown(0.5);
        }

        // ── V. Recinto Deportivo ───────────────────────────────────
        const rec = rj.recinto_deportivo;
        if (rec && Object.keys(rec).length > 0) {
            seccion(doc, 'V. ESTADO DEL RECINTO DEPORTIVO', AZUL);
            const aspectos = [
                { key: 'estado_medialuna', label: 'Estado de la medialuna' },
                { key: 'estado_corrales',  label: 'Estado de los corrales' },
                { key: 'estado_vestuarios', label: 'Estado de los vestuarios' },
                { key: 'estado_servicios',  label: 'Estado de los servicios' },
                { key: 'estado_iluminacion', label: 'Iluminación' },
                { key: 'estado_estacionamiento', label: 'Estacionamiento' },
            ];
            aspectos.forEach(a => {
                if (rec[a.key]) {
                    const obs = rec[a.key + '_obs'] ? ` (${rec[a.key + '_obs']})` : '';
                    campo(doc, a.label, (rec[a.key] || '—') + obs);
                }
            });
            if (rec.observaciones_generales) campo(doc, 'Observaciones generales', rec.observaciones_generales);
            doc.moveDown(0.5);
        }

        // ── VI. Colleras Invitadas ─────────────────────────────────
        const col = rj.colleras_invitadas;
        if (col) {
            seccion(doc, 'VI. COLLERAS INVITADAS', AZUL);
            campo(doc, 'Sin colleras invitadas', yn(col.no_hubo));
            if (!col.no_hubo && Array.isArray(col.items) && col.items.length > 0) {
                col.items.forEach((c2, i) => {
                    doc.fontSize(9).font('Helvetica').fillColor('#333')
                       .text(`  ${i + 1}. ${c2.club || '—'} — ${c2.collera || '—'} (${c2.categoria || '—'})`);
                });
            }
            doc.moveDown(0.5);
        }

        // ── VII. Reemplazo de Jinetes ──────────────────────────────
        const ree = rj.reemplazo_jinetes;
        if (ree) {
            seccion(doc, 'VII. REEMPLAZO DE JINETES', AZUL);
            campo(doc, 'Hubo reemplazo', yn(ree.hubo));
            if (ree.hubo === 'si' && Array.isArray(ree.items) && ree.items.length > 0) {
                ree.items.forEach((r2, i) => {
                    doc.fontSize(9).font('Helvetica').fillColor('#333')
                       .text(`  ${i + 1}. Jinete: ${r2.jinete_original || '—'} → Reemplazado por: ${r2.jinete_reemplazo || '—'} (${r2.motivo || '—'})`);
                });
            }
            doc.moveDown(0.5);
        }

        // ── VIII. Accidentes ───────────────────────────────────────
        const acc = rj.accidentes_informe;
        if (acc) {
            seccion(doc, 'VIII. INFORME DE ACCIDENTES', AZUL);
            campo(doc, 'Hubo accidentes', yn(acc.hubo_accidentes));
            campo(doc, 'Se revisó protocolo de emergencia', yn(acc.reviso_protocolo));
            if (acc.medico_nombre) campo(doc, 'Médico de turno', acc.medico_nombre);
            if (acc.medico_telefono) campo(doc, 'Teléfono médico', acc.medico_telefono);
            if (acc.hubo_accidentes === 'si' && Array.isArray(acc.items) && acc.items.length > 0) {
                doc.fontSize(10).fillColor(AZUL).font('Helvetica-Bold').text('Accidentes registrados:');
                acc.items.forEach((a, i) => {
                    doc.font('Helvetica').fillColor('#333').fontSize(9)
                       .text(`  ${i + 1}. Tipo: ${a.tipo || '—'} | Persona: ${a.persona_tipo || '—'} | Derivado: ${yn(a.derivado)}`);
                    if (a.centro_asistencial) doc.text(`     Centro: ${a.centro_asistencial}`);
                });
            }
            if (acc.observaciones_generales) campo(doc, 'Observaciones generales', acc.observaciones_generales);
            doc.moveDown(0.5);
        }

        // ── IX. Bienestar Animal ───────────────────────────────────
        const ba = rj.bienestar_animal;
        if (ba) {
            seccion(doc, 'IX. BIENESTAR ANIMAL', AZUL);
            const campos_ba = [
                { key: 'sombra_ganado',  label: 'Sombra para ganado' },
                { key: 'sombra_equinos', label: 'Sombra para equinos' },
                { key: 'agua_ganado',    label: 'Agua para ganado' },
                { key: 'agua_equinos',   label: 'Agua para equinos' },
                { key: 'comida_ganado',  label: 'Comida para ganado' },
                { key: 'comida_equinos', label: 'Comida para equinos' },
            ];
            campos_ba.forEach(c3 => { if (ba[c3.key] != null) campo(doc, c3.label, yn(ba[c3.key])); });
            campo(doc, 'Hubo lesiones en equinos', yn(ba.hubo_lesiones_equinos));
            campo(doc, 'Hubo lesiones en bovinos', yn(ba.hubo_lesiones_bovinos));
            if (ba.detalle_lesiones) campo(doc, 'Detalle lesiones', ba.detalle_lesiones);
            if (ba.observaciones) campo(doc, 'Observaciones', ba.observaciones);
            doc.moveDown(0.5);
        }

        // ── X. Veterinario ─────────────────────────────────────────
        const vet = rj.informe_veterinario;
        if (vet && (vet.nombre || vet.preparacion)) {
            seccion(doc, 'X. INFORME DEL VETERINARIO', AZUL);
            campo(doc, 'Nombre', vet.nombre || '—');
            campo(doc, 'Teléfono', vet.telefono || '—');
            campo(doc, 'Preparación', vet.preparacion || '—');
            if (vet.preparacion === 'tecnico' && vet.especifica_tecnico) campo(doc, 'Tipo técnico', vet.especifica_tecnico);
            if (vet.preparacion === 'otro' && vet.especifica_otro) campo(doc, 'Otro tipo', vet.especifica_otro);
            if (vet.observaciones) campo(doc, 'Observaciones', vet.observaciones);
            doc.moveDown(0.5);
        }

        // ── XI. Reclamos o Sugerencias ────────────────────────────
        const recs = rj.reclamos_sugerencias;
        if (recs) {
            seccion(doc, 'XI. RECLAMOS O SUGERENCIAS', AZUL);
            campo(doc, 'Hubo reclamos', yn(recs.hubo_reclamos));
            if (recs.hubo_reclamos === 'si' && Array.isArray(recs.items) && recs.items.length > 0) {
                recs.items.forEach((r3, i) => {
                    doc.fontSize(9).font('Helvetica').fillColor('#333')
                       .text(`  ${i + 1}. ${r3.tipo || '—'}: ${r3.descripcion || '—'}`);
                });
            }
            if (recs.sugerencias) campo(doc, 'Sugerencias', recs.sugerencias);
            if (recs.observaciones_generales) campo(doc, 'Observaciones generales', recs.observaciones_generales);
            doc.moveDown(0.5);
        }

        // ── Historial de observaciones ─────────────────────────────
        const historial = Array.isArray(cartilla.historial_observaciones) ? cartilla.historial_observaciones : [];
        if (historial.length > 0) {
            seccion(doc, 'HISTORIAL DE OBSERVACIONES ADMINISTRATIVAS', AZUL);
            historial.forEach((h, i) => {
                doc.fontSize(9).font('Helvetica').fillColor('#333')
                   .text(`  ${i + 1}. [${h.tipo || '—'}] ${h.fecha ? fmtFechaHora(h.fecha) : '—'} — ${h.por || '—'}`);
                if (h.motivo) doc.text(`     Motivo: ${h.motivo}`);
            });
            doc.moveDown(0.5);
        }

        // ── Cierre ─────────────────────────────────────────────────
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').lineWidth(1).stroke();
        doc.moveDown(0.5);
        doc.fontSize(9).fillColor(GRIS)
           .text(`Estado: ${estadoLabel}  |  Generado: ${fmtFechaHora(new Date().toISOString())}`)
           .text('Generado por el Sistema de Jurados — Federación Deportiva Nacional de Rodeo Chileno');

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
    const parts = String(iso).split('T')[0].split('-');
    if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
    return iso;
}

function fmtFechaHora(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('es-CL') + ' ' + d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
}

module.exports = { generarCartillaDelegadoPDF };
