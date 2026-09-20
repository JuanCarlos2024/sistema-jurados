const PDFDocument = require('pdfkit');
const { calcularPorcentajeFueraPeso } = require('./cartillaDelegadoGanado');

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
        // Temporada y Tipo de Rodeo — 100% AUTOMÁTICOS: EN VIVO desde
        // `rodeo`, misma fuente que el formulario del Delegado y la vista
        // Administrador (nunca se leen del snapshot de la cartilla, aunque
        // esa columna se conserve por compatibilidad). Tipo y Categoría son
        // conceptos DISTINTOS en el sistema — nunca se concatenan.
        seccion(doc, 'I. IDENTIFICACIÓN DEL RODEO', AZUL);
        campo(doc, 'Club / Asociación', [rodeo?.club, rodeo?.asociacion].filter(Boolean).join(' — ') || cartilla.club_asociacion_organizador || '—');
        campo(doc, 'Fecha del Rodeo',   cartilla.fecha_rodeo ? fmtFecha(cartilla.fecha_rodeo) : '—');
        campo(doc, 'Temporada',         rodeo?.temporadas?.nombre || (rodeo?.fecha ? String(rodeo.fecha).slice(0, 4) : '—'));
        campo(doc, 'Tipo de Rodeo',     rodeo?.tipo_rodeo_nombre || '—');
        if (rodeo?.categoria_rodeo_nombre) campo(doc, 'Categoría de Rodeo', rodeo.categoria_rodeo_nombre);
        campo(doc, 'Delegado Oficial',  cartilla.delegado_nombre || '—');
        campo(doc, 'Teléfono',          cartilla.delegado_telefono || '—');
        // Veterinario, Técnico u otro (nombre y rut) — versión final.
        const vetHdr = rj.informe_veterinario || {};
        campo(doc, 'Veterinario, Técnico u otro', vetHdr.nombre || '—');
        campo(doc, 'RUT (Veterinario/Técnico)', vetHdr.rut || '—');
        // Secretario (nombre, rut, N° socio, teléfono, correo) — versión
        // final; respaldo a las columnas antiguas para cartillas históricas.
        const sec = rj.secretario || {};
        campo(doc, 'Secretario', sec.nombre || cartilla.secretario_jurado || '—');
        campo(doc, 'RUT (Secretario)', sec.rut || '—');
        campo(doc, 'N° de Socio (Secretario)', sec.n_socio || cartilla.secretario_numero_socio || '—');
        campo(doc, 'Teléfono (Secretario)', sec.telefono || '—');
        campo(doc, 'Correo (Secretario)', sec.correo || '—');
        campo(doc, 'Asociación organizadora', rodeo?.asociacion || '—');
        campo(doc, 'Club organizador', rodeo?.club || '—');
        // "Público" retirado del formulario de nuevas cartillas (auditoría
        // versión final) — se sigue imprimiendo SOLO si es un dato histórico.
        if (cartilla.publico_serie_campeones != null) campo(doc, 'Público (dato histórico)', String(cartilla.publico_serie_campeones));
        campo(doc, '¿Final de rodeo se corrió a dos vueltas en el apiñadero?', yn(cartilla.serie_campeones_dos_vueltas));
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

        // ── I. Información de las Series e Informe del Ganado (UNIFICADA,
        // 4ª revisión) ───────────────────────────────────────────────
        // Antes eran dos secciones separadas ("I. Series" + "II. Ganado")
        // que repetían la misma Serie dos veces. Ahora se presenta UNA sola
        // vez por Serie, con sus 4 animales y toda su información (colleras,
        // vueltas, tipo, peso, corrido, repetido, calidad) + fuera de peso
        // reglamentario — misma fuente `rj.ganado_series`, nunca duplicada.
        const series = Array.isArray(rj.ganado_series) ? rj.ganado_series : [];
        if (series.length > 0) {
            seccion(doc, 'I. INFORMACIÓN DE LAS SERIES E INFORME DEL GANADO', AZUL);
            const numP = (v) => { const n = parseFloat(v); return (!isNaN(n) && n >= 0) ? n : 0; };
            const nombresAnimal = ['1er animal', '2do animal', '3er animal', '4to animal'];
            // Ganado bajo/sobrepeso reglamentario — 5ª revisión, punto 2: por
            // cada animal (Art. 242), no solo total de la Serie. Detección
            // por presencia de datos (f1c..f4c) vs formato anterior
            // (fp_tot/fp_baj/fp_sob, solo por Serie) — sin bandera de
            // versión ni migración, igual que en el formulario del Delegado.
            series.forEach((s, i) => {
                const legacy = !!(s.fp_tot || s.fp_baj || s.fp_sob) && !(s.f1c || s.f2c || s.f3c || s.f4c);
                doc.fontSize(10).fillColor(AZUL).font('Helvetica-Bold').text(`  Serie ${i + 1}: ${s.nombre || '—'}`);
                doc.font('Helvetica').fillColor('#333');
                [1, 2, 3, 4].forEach(n => {
                    let linea = `    ${nombresAnimal[n-1]} — N° colleras: ${s['c'+n+'n'] || '—'} | # Ganado utilizado: ${s['c'+n+'g'] || '—'} | Vueltas: ${s['v'+n+'v'] || '—'} | Tipo: ${s['v'+n+'t'] || '—'} | Peso: ${s['v'+n+'p'] || '—'} kg | Corrido: ${s['q'+n+'c'] || '—'} | Repetido: ${s['q'+n+'r'] || '—'} | Calidad: ${s['q'+n+'k'] || '—'}`;
                    if (!legacy) {
                        const pct = calcularPorcentajeFueraPeso(s['c'+n+'g'], s['f'+n+'c']);
                        linea += ` | Bajo/sobrepeso: ${s['f'+n+'c'] || '—'} | %: ${pct !== null ? pct.toFixed(1) + '%' : '—'}`;
                    }
                    doc.fontSize(8.5).fillColor('#333').font('Helvetica').text(linea);
                });
                if (legacy) {
                    const tot = numP(s.fp_tot), baj = numP(s.fp_baj), sob = numP(s.fp_sob);
                    const fuer = baj + sob, pct = tot > 0 ? ((fuer / tot) * 100).toFixed(1) + '%' : '—';
                    doc.fontSize(8.5).fillColor('#555').font('Helvetica-Oblique')
                       .text(`    Fuera de peso (Art. 242, formato anterior por Serie) — Total: ${tot || '—'} | Bajo peso: ${baj || '—'} | Sobre peso: ${sob || '—'} | Total fuera de peso: ${fuer > 0 ? fuer : '—'} | %: ${pct}`);
                } else {
                    let totGanado = 0, totFuera = 0;
                    [1, 2, 3, 4].forEach(n => { totGanado += numP(s['c'+n+'g']); totFuera += numP(s['f'+n+'c']); });
                    const pctResumen = calcularPorcentajeFueraPeso(totGanado, totFuera);
                    doc.fontSize(8.5).fillColor('#555').font('Helvetica-Oblique')
                       .text(`    Resumen fuera de peso (suma de los 4 animales) — Total ganado: ${totGanado || '—'} | Total fuera de peso: ${totFuera > 0 ? totFuera : '—'} | %: ${pctResumen !== null ? pctResumen.toFixed(1) + '%' : '—'}`);
                }
                doc.font('Helvetica').fillColor('#333');
                doc.moveDown(0.3);
            });
            doc.moveDown(0.3);
        }

        // ── II. Informe si hubo reemplazo de jinetes ────────────────
        const ree = rj.reemplazo_jinetes;
        if (ree) {
            seccion(doc, 'II. INFORME SI HUBO REEMPLAZO DE JINETES', AZUL);
            campo(doc, 'Hubo reemplazo', yn(ree.hubo));
            if (ree.hubo === 'si' && Array.isArray(ree.items) && ree.items.length > 0) {
                ree.items.forEach((r2, i) => {
                    doc.fontSize(9).font('Helvetica').fillColor('#333')
                       .text(`  ${i + 1}. ${r2.nombre_reemplazado || '—'} (${r2.rut_reemplazado || '—'}) → reemplazado por ${r2.nombre_reemplazante || '—'} (${r2.rut_reemplazante || '—'}) — Motivo: ${r2.motivo || '—'} — Serie: ${r2.serie || '—'}`);
                    if (r2.detalle) doc.fontSize(8.5).text(`     Detalle: ${r2.detalle}`);
                    if (r2.observaciones) doc.fontSize(8.5).text(`     Observaciones: ${r2.observaciones}`);
                });
            }
            doc.moveDown(0.5);
        }

        // ── Faltas o sanciones disciplinarias en cada serie (breve) ──
        // Reutiliza `rj.ganado_series` (falta_hubo/falta_articulo/falta_obs
        // por serie). NO se confunde con "IV. Informe de disciplina"
        // (detalle completo de los hechos e infractores).
        const conFaltas = series.filter(s => s.falta_hubo || s.falta_articulo || s.falta_obs);
        if (conFaltas.length > 0) {
            seccion(doc, 'FALTAS O SANCIONES DISCIPLINARIAS EN CADA SERIE', AZUL);
            conFaltas.forEach(s => {
                doc.fontSize(9).font('Helvetica').fillColor('#333')
                   .text(`  ${s.nombre || '—'}: ${yn(s.falta_hubo)}${s.falta_articulo ? ' — Art. ' + s.falta_articulo : ''}${s.falta_obs ? ' — ' + s.falta_obs : ''}`);
            });
            doc.moveDown(0.5);
        }

        // ── III. Informe de accidentes (UNIFICADA) ────────────────────
        // Combina la mención breve (relato libre histórico,
        // `rj.informe_accidentes_general`) y el detalle estructurado
        // (médico, contacto, accidentados, `rj.accidentes_informe`) en una
        // sola sección — tal como la versión final la presenta.
        const acc = rj.accidentes_informe;
        const textoAccGeneral = typeof rj.informe_accidentes_general === 'string' ? rj.informe_accidentes_general : '';
        if ((acc && acc.hubo_accidentes != null) || textoAccGeneral) {
            seccion(doc, 'III. INFORME DE ACCIDENTES', AZUL);
            if (acc) {
                campo(doc, 'Hubo accidentes en el Rodeo', yn(acc.hubo_accidentes));
                campo(doc, 'Se revisó protocolo de rescate', yn(acc.reviso_protocolo));
                if (acc.medico_nombre) campo(doc, 'Médico / paramédico', acc.medico_nombre);
                if (acc.medico_telefono) campo(doc, 'Teléfono de contacto', acc.medico_telefono);
                if (acc.medico_email) campo(doc, 'Correo de contacto', acc.medico_email);
                if (acc.observaciones_generales) campo(doc, 'Observaciones generales', acc.observaciones_generales);
            }
            if (textoAccGeneral) {
                doc.fontSize(9).fillColor(GRIS).font('Helvetica-Oblique').text(`Relato general (dato histórico): ${textoAccGeneral}`);
                doc.font('Helvetica').fillColor('#333');
            }
            if (acc && Array.isArray(acc.items) && acc.items.length > 0) {
                doc.fontSize(10).fillColor(AZUL).font('Helvetica-Bold').text('Accidentados:');
                doc.font('Helvetica').fillColor('#333');
                acc.items.forEach((a, i) => {
                    const esLegacyAcc = !!(a.tipo || a.persona || a.categoria || a.descripcion || a.atencion) && !(a.serie || a.animal || a.collera || a.accidentado);
                    if (esLegacyAcc) {
                        doc.fontSize(9).text(`  ${i + 1}. [Formato anterior] ${a.persona || '—'} (${a.rut || '—'}) — ${a.categoria || '—'} — ${a.descripcion || '—'}`);
                        if (a.atencion) doc.fontSize(8.5).text(`     Atención: ${a.atencion}`);
                        if (a.observaciones) doc.fontSize(8.5).text(`     Observaciones: ${a.observaciones}`);
                    } else {
                        doc.fontSize(9).text(`  ${i + 1}. ${a.serie || '—'} — ${a.animal || '—'} — Collera ${a.collera || '—'} — ${a.accidentado || '—'} (${a.rut_socio || '—'}) — ${a.asociacion_club || '—'}`);
                        if (a.detalle_hechos) doc.fontSize(8.5).text(`     Detalle: ${a.detalle_hechos}`);
                        if (a.consecuencia) doc.fontSize(8.5).text(`     Consecuencia: ${a.consecuencia}`);
                    }
                });
            }
            doc.moveDown(0.5);
        }

        // ── IV. Informe sobre el desempeño del Jurado ──────────────────
        const dj = rj.desempeno_jurado;
        if (dj) {
            seccion(doc, 'IV. INFORME SOBRE EL DESEMPEÑO DEL JURADO', AZUL);
            const ASPECTOS_PDF = [
                { key: 'aspecto_1', label: '1. Faltas en el apiñadero' },
                { key: 'aspecto_2', label: '2. Faltas en la cancha (incl. postura)' },
                { key: 'aspecto_3', label: '3. Atajadas válidas / faltas en la atajada' },
                { key: 'aspecto_4', label: '4. Faltas en la entrega del novillo' }
            ];
            const esFormatoNuevo = ASPECTOS_PDF.some(a => dj[a.key] !== undefined && dj[a.key] !== null);
            if (esFormatoNuevo) {
                ASPECTOS_PDF.forEach(a => campo(doc, a.label, dj[a.key] != null ? String(dj[a.key]) : '—'));
                campo(doc, 'NOTA PROMEDIO', dj.nota_promedio != null ? String(dj.nota_promedio) : 'Pendiente');
            } else {
                // Formato anterior — se conserva para cartillas históricas.
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
            }
            if (dj.observaciones) campo(doc, 'Observaciones', dj.observaciones);
            doc.moveDown(0.5);
        }

        // ── V. Situaciones a revisar (máximo 3, NUEVA) ─────────────────
        const sitRev = rj.situaciones_revisar;
        if (sitRev && Array.isArray(sitRev.items) && sitRev.items.length > 0) {
            seccion(doc, 'V. SITUACIONES A REVISAR', AZUL);
            sitRev.items.forEach((s, i) => {
                doc.fontSize(9).font('Helvetica').fillColor('#333')
                   .text(`  ${i + 1}. Serie: ${s.serie || '—'} — Animal: ${s.animal || '—'} — Collera: ${s.collera || '—'}`);
                if (s.detalle) doc.fontSize(8.5).text(`     ${s.detalle}`);
            });
            doc.moveDown(0.5);
        }

        // ── VI. Informe de disciplina y antecedentes disciplinarios
        // complementarios (UNIFICADA) — combina las situaciones
        // estructuradas y el campo libre de antecedentes complementarios
        // (antes "X. Anexo 04"), tal como la versión final las presenta
        // en una sola sección. ─────────────────────────────────────────
        const disc = rj.disciplina_informe;
        const antPdf = rj.antecedentes_disciplinarios;
        if (disc || (antPdf && antPdf.texto)) {
            seccion(doc, 'VI. INFORME DE DISCIPLINA Y ANTECEDENTES DISCIPLINARIOS COMPLEMENTARIOS', AZUL);
            if (disc) {
                campo(doc, 'Hubo informe disciplinario', yn(disc.hubo_informe));
                if (disc.hubo_informe === 'si' && Array.isArray(disc.situaciones) && disc.situaciones.length > 0) {
                    doc.fontSize(10).fillColor(AZUL).font('Helvetica-Bold').text('Situaciones disciplinarias:');
                    doc.font('Helvetica').fillColor('#333');
                    disc.situaciones.forEach((s, i) => {
                        doc.fontSize(9).text(`  ${i + 1}. ${s.nombre_infractor || '—'} (RUT: ${s.rut || '—'}, N° socio: ${s.num_socio || '—'}) — ${s.tipo_falta || '—'} — Art. ${s.articulo || '—'}`);
                        if (s.testigos) doc.fontSize(8.5).text(`     Testigos: ${s.testigos}`);
                        if (s.detalle) doc.fontSize(8.5).text(`     Detalle: ${s.detalle}`);
                        if (s.observaciones) doc.fontSize(8.5).text(`     Observaciones: ${s.observaciones}`);
                    });
                }
            }
            if (antPdf && antPdf.texto) {
                if (disc) doc.moveDown(0.2);
                doc.fontSize(9).fillColor(AZUL).font('Helvetica-Bold').text('Antecedentes disciplinarios complementarios:');
                doc.fontSize(9).fillColor('#333').font('Helvetica').text(antPdf.texto);
            }
            doc.moveDown(0.5);
        }

        // ── VII. Recinto Deportivo ──────────────────────────────────
        // Nuevo formato 2026-2027: 5 campos (Cancha, Iluminación,
        // Instalaciones públicas, Casetas de jurados, Otros). Cartillas
        // antiguas con datos en los 18 aspectos del formato previo se
        // detectan por presencia de datos y se siguen mostrando igual,
        // sin transformar ni perder su información histórica.
        const rec = rj.recinto_deportivo;
        if (rec && Object.keys(rec).length > 0) {
            const ASPECTOS_RECINTO_LEGACY = [
                { key: 'piso', label: 'Piso' }, { key: 'riego', label: 'Riego de la cancha' },
                { key: 'lineas_sentencia', label: 'Líneas de sentencia' }, { key: 'banderas_salida', label: 'Banderas de salida' },
                { key: 'apinladero', label: 'Apiñadero' }, { key: 'iluminacion', label: 'Iluminación de la cancha' },
                { key: 'atajadas', label: 'Atajadas' }, { key: 'toril', label: 'Toril' },
                { key: 'corrales', label: 'Corrales' }, { key: 'picadero', label: 'Picadero' },
                { key: 'caseta_jurado', label: 'Caseta del Jurado' }, { key: 'caseta_filmacion', label: 'Caseta de filmación' },
                { key: 'casinos', label: 'Casinos' }, { key: 'banhos', label: 'Baños' },
                { key: 'duchas_petiseros', label: 'Duchas para petiseros' }, { key: 'graderias', label: 'Graderías' },
                { key: 'accesos_discapacitados', label: 'Accesos para discapacitados' }, { key: 'stands_artesanos', label: 'Stands de artesanos' }
            ];
            const ASPECTOS_RECINTO_NUEVO = [
                { key: 'cancha', label: 'Cancha' }, { key: 'iluminacion_cancha', label: 'Iluminación' },
                { key: 'instalaciones_publicas', label: 'Instalaciones públicas' }, { key: 'casetas_jurados', label: 'Casetas de jurados' }
            ];
            const esLegacy = ASPECTOS_RECINTO_LEGACY.some(a => rec[a.key + '_estado'] || rec[a.key + '_obs']);
            const aspectosRecinto = esLegacy ? ASPECTOS_RECINTO_LEGACY : ASPECTOS_RECINTO_NUEVO;
            seccion(doc, 'VII. INFORME SOBRE EL ESTADO DEL RECINTO DEPORTIVO', AZUL);
            if (esLegacy) {
                doc.fontSize(8).fillColor(GRIS).font('Helvetica-Oblique')
                   .text('Formato anterior (18 aspectos) — cartilla registrada antes del nuevo formato oficial.');
                doc.font('Helvetica').fillColor('#333');
            }
            aspectosRecinto.forEach(a => {
                if (rec[a.key + '_estado'] || rec[a.key + '_obs']) {
                    const obs = rec[a.key + '_obs'] ? ` (${rec[a.key + '_obs']})` : '';
                    campo(doc, a.label, (rec[a.key + '_estado'] || '—') + obs);
                }
            });
            if (rec.otros) campo(doc, 'Otros aspectos', rec.otros);
            doc.moveDown(0.5);
        }

        // ── VIII. Colleras Invitadas ────────────────────────────────
        const col = rj.colleras_invitadas;
        if (col) {
            seccion(doc, 'VIII. INFORME DE COLLERAS INVITADAS', AZUL);
            campo(doc, 'Sin colleras invitadas', yn(col.no_hubo));
            if (!col.no_hubo && Array.isArray(col.items) && col.items.length > 0) {
                col.items.forEach((c2, i) => {
                    doc.fontSize(9).font('Helvetica').fillColor('#333')
                       .text(`  ${i + 1}. Jinetes: ${[c2.jinete1, c2.jinete2].filter(Boolean).join(' / ') || '—'} — Club: ${c2.club || '—'} — Asociación: ${c2.asociacion || '—'}`);
                    if (c2.observaciones) doc.fontSize(8.5).text(`     Observaciones: ${c2.observaciones}`);
                });
            }
            doc.moveDown(0.5);
        }

        // ── IX. Informe delegado / veterinario condiciones de Bienestar
        // Animal (UNIFICADA) — se responde una sola vez, sobre `ba`. Si la
        // cartilla es histórica y el veterinario respondió el Anexo 02 por
        // separado, se agrega como bloque adicional de solo lectura.
        const CAMPOS_BIENESTAR = [
            { key: 'sombra_ganado',  label: 'Sombra para ganado' },
            { key: 'sombra_equinos', label: 'Sombra para equinos' },
            { key: 'agua_ganado',    label: 'Agua para ganado' },
            { key: 'agua_equinos',   label: 'Agua para equinos' },
            { key: 'comida_ganado',  label: 'Comida para ganado' },
            { key: 'comida_equinos', label: 'Comida para equinos' },
        ];
        const ba  = rj.bienestar_animal;
        const vet = rj.informe_veterinario;
        const vetTieneBienestarPropio = !!(vet && CAMPOS_BIENESTAR.some(c3 => vet[c3.key] != null));
        if (ba || vet) {
            seccion(doc, 'IX. INFORME DELEGADO / VETERINARIO CONDICIONES DE BIENESTAR ANIMAL', AZUL);
            if (ba) {
                CAMPOS_BIENESTAR.forEach(c3 => {
                    if (ba[c3.key] != null) {
                        const obs = ba[c3.key + '_obs'] ? ` (${ba[c3.key + '_obs']})` : '';
                        campo(doc, c3.label, yn(ba[c3.key]) + obs);
                    }
                });
                campo(doc, 'Hubo lesiones en equinos', yn(ba.hubo_lesiones_equinos));
                campo(doc, 'Hubo lesiones en bovinos', yn(ba.hubo_lesiones_bovinos));
                if (ba.detalle_lesiones_equinos) campo(doc, 'Lesiones equinos', ba.detalle_lesiones_equinos);
                if (ba.detalle_lesiones_bovinos) campo(doc, 'Lesiones bovinos', ba.detalle_lesiones_bovinos);
                if (ba.detalle_lesiones) campo(doc, 'Detalle lesiones (formato anterior)', ba.detalle_lesiones);
                if (ba.observaciones) campo(doc, 'Observaciones', ba.observaciones);
            }
            if (vetTieneBienestarPropio) {
                doc.fontSize(8).fillColor(GRIS).font('Helvetica-Oblique')
                   .text('Respuesta adicional del veterinario (Anexo 02, dato histórico):');
                doc.font('Helvetica').fillColor('#333');
                CAMPOS_BIENESTAR.forEach(c3 => {
                    if (vet[c3.key] != null) {
                        const obs = vet[c3.key + '_obs'] ? ` (${vet[c3.key + '_obs']})` : '';
                        campo(doc, c3.label, yn(vet[c3.key]) + obs);
                    }
                });
                if (vet.detalle_lesiones_equinos) campo(doc, 'Lesiones equinos (veterinario)', vet.detalle_lesiones_equinos);
                if (vet.detalle_lesiones_bovinos) campo(doc, 'Lesiones bovinos (veterinario)', vet.detalle_lesiones_bovinos);
                if (vet.observaciones) campo(doc, 'Observaciones (veterinario)', vet.observaciones);
            }
            doc.moveDown(0.5);
        }

        // ── X. Reclamos o Sugerencias ────────────────────────────────
        const recs = rj.reclamos_sugerencias;
        if (recs) {
            seccion(doc, 'X. RECLAMOS O SUGERENCIAS', AZUL);
            campo(doc, 'Hubo reclamos', yn(recs.hubo_reclamos));
            if (recs.hubo_reclamos === 'si' && Array.isArray(recs.items) && recs.items.length > 0) {
                recs.items.forEach((r3, i) => {
                    doc.fontSize(9).font('Helvetica').fillColor('#333')
                       .text(`  ${i + 1}. ${r3.nombre || '—'} (${r3.rut || '—'}) — ${r3.tipo || '—'}`);
                    if (r3.detalle) doc.fontSize(8.5).text(`     Detalle: ${r3.detalle}`);
                    if (r3.respuesta) doc.fontSize(8.5).text(`     Respuesta: ${r3.respuesta}`);
                    if (r3.observaciones) doc.fontSize(8.5).text(`     Observaciones: ${r3.observaciones}`);
                });
            }
            if (recs.sugerencias) campo(doc, 'Sugerencias', recs.sugerencias);
            if (recs.observaciones_generales) campo(doc, 'Observaciones generales', recs.observaciones_generales);
            doc.moveDown(0.5);
        }

        // ── XI. Comentarios generales ─────────────────────────────────
        const com = rj.comentarios_generales;
        if (com && com.texto) {
            seccion(doc, 'XI. COMENTARIOS GENERALES', AZUL);
            doc.fontSize(10).fillColor('#333').font('Helvetica').text(com.texto);
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
