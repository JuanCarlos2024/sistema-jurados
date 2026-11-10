const path = require('path');
const PDFDocument = require('pdfkit');
const { calcularPorcentajeFueraPeso } = require('./cartillaDelegadoGanado');
const { celdaValor, dibujarTabla, asegurarEspacio } = require('./cartillaDelegadoPdfTabla');
const {
    AZUL, GRIS_NOTA,
    encabezadoPrincipal, franjaEstado, bloqueIdentificacion, dosColumnas, nombreDestacado,
    tituloSeccion, subtitulo, filaInfo, filaInfoEnPares, parrafo, registro,
    lineaSimple, notaDestacada, aplicarPieDePagina
} = require('./cartillaDelegadoPdfDiseno');

// Mismo logo oficial que usa el resto del sistema en sus encabezados (ver
// cualquier frontend/**/*.html) — NUNCA se descarga ni se genera uno nuevo.
// backend/src/services -> ../../../frontend/assets (mismo patrón ya usado en
// backend/src/app.js para servir frontend/ con express.static y en
// cartillaDelegadoSeriesCatalogo.test.js para leer archivos de frontend/).
const LOGO_PATH = path.join(__dirname, '..', '..', '..', 'frontend', 'assets', 'logo_V2.png');

/**
 * Genera el PDF de una cartilla del delegado y retorna un Buffer.
 *
 * Rediseño visual (revisión del usuario, Nov-2026): todas las páginas
 * VERTICALES (todo salvo la tabla de ganado horizontal, que se mantiene
 * exactamente igual — "no quiero modificar esas tablas") ahora se dibujan
 * con los helpers de cartillaDelegadoPdfDiseno.js: encabezados de sección
 * azul institucional con separación arriba/abajo, bloques A/B/C/D en la
 * página 1, pares etiqueta/valor alineados con interlineado cómodo, listas
 * con separación entre registros (nunca partidos entre páginas) y un pie
 * de página consistente en todas las hojas. Nada se resuelve con saltos de
 * línea o espacios sueltos en el contenido — todo el espaciado lo decide
 * el helper según el contenido real.
 *
 * @param {object} cartilla - registro de cartillas_delegado con todos los campos
 * @param {object} rodeo    - registro de rodeos
 * @param {{ historialResponsables?: object[] }} [opciones] - Fase 3.5: eventos
 *   reales de auditoria (ver services/historialResponsableInstitucional.js),
 *   SOLO para cartillas de origen institucional. Parámetro opcional y
 *   aditivo: los llamadores existentes (Delegado Rentado) que no lo pasan
 *   siguen generando exactamente el mismo PDF que antes.
 * @returns {Promise<Buffer>}
 */
function generarCartillaDelegadoPDF(cartilla, rodeo, { historialResponsables = [] } = {}) {
    return new Promise((resolve, reject) => {
        // bufferPages: true — necesario para poder recorrer todas las
        // páginas al final y aplicarles el mismo pie de página (ver
        // aplicarPieDePagina). No cambia cómo se generan los datos del
        // PDF: pdfkit sigue emitiendo 'data' normalmente al llamar doc.end().
        const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.on('end',  () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const rj   = cartilla.respuestas_json || {};
        const GRIS = '#666666';

        // ── Encabezado (con logo institucional, revisión Nov-2026) ──
        encabezadoPrincipal(doc, LOGO_PATH);

        // ── Franja de estado (propia, separada de la identificación del
        // rodeo que viene después) ──────────────────────────────────────
        const estadoLabel = { borrador:'Borrador', enviada:'Enviada', observada:'Observada', reenviada:'Reenviada', aprobada:'Aprobada' }[cartilla.estado] || cartilla.estado;
        const camposEstado = [{ label: 'Estado', value: estadoLabel }];
        if (cartilla.enviada_en)  camposEstado.push({ label: 'Enviada el',  value: fmtFechaHora(cartilla.enviada_en) });
        if (cartilla.aprobada_en) camposEstado.push({ label: 'Aprobada el', value: fmtFechaHora(cartilla.aprobada_en) });
        // numero_version solo existe en cartillas_delegado_versiones (092),
        // no en la fila principal de cartillas_delegado — se muestra SOLO
        // si el llamador lo adjuntó explícitamente al objeto (por ejemplo,
        // al regenerar el PDF de una versión histórica), nunca se inventa.
        if (cartilla.numero_version != null) camposEstado.push({ label: 'Versión', value: 'N° ' + cartilla.numero_version });
        franjaEstado(doc, camposEstado);

        // ── Portada: identificación del rodeo (revisión Nov-2026) ───────
        // Temporada y Tipo de Rodeo — 100% AUTOMÁTICOS: EN VIVO desde
        // `rodeo`, misma fuente que el formulario del Delegado y la vista
        // Administrador (nunca se leen del snapshot de la cartilla, aunque
        // esa columna se conserve por compatibilidad). Tipo y Categoría son
        // conceptos DISTINTOS en el sistema — nunca se concatenan.

        // Identificación del rodeo — Asociación y Club se muestran UNA sola
        // vez (antes se repetían: "Club / Asociación" combinados arriba y,
        // más abajo, "Asociación organizadora"/"Club organizador" por
        // separado con el MISMO valor — una duplicación de presentación,
        // nunca un dato distinto). No se repite en ninguna otra sección.
        // alturaMinimaContenido de cada bloque (revisión Nov-2026, corrige
        // la página casi vacía de "Certificación del Club Organizador"):
        // refleja cuántas filas tiene REALMENTE cada bloque (~31pt/fila) —
        // así, si no entran completas al final de una página, el bloque
        // ENTERO (título + contenido) pasa junto a la página siguiente, en
        // vez de dejar el título huérfano arriba y el contenido solo abajo.
        bloqueIdentificacion(doc, 'Identificación del rodeo', (doc) => {
            filaInfo(doc, [{ label: 'Asociación', value: rodeo?.asociacion }, { label: 'Club', value: rodeo?.club }]);
            filaInfo(doc, [
                { label: 'Fecha del Rodeo', value: cartilla.fecha_rodeo ? fmtFecha(cartilla.fecha_rodeo) : null },
                { label: 'Temporada', value: rodeo?.temporadas?.nombre || (rodeo?.fecha ? String(rodeo.fecha).slice(0, 4) : null) }
            ]);
            if (rodeo?.categoria_rodeo_nombre) {
                filaInfo(doc, [{ label: 'Tipo de Rodeo', value: rodeo?.tipo_rodeo_nombre }, { label: 'Categoría de Rodeo', value: rodeo.categoria_rodeo_nombre }]);
            } else {
                filaInfo(doc, [{ label: 'Tipo de Rodeo', value: rodeo?.tipo_rodeo_nombre }]);
            }
        }, { alturaMinimaContenido: 95 }); // 3 filas

        // Delegado oficial — nombre con mayor jerarquía visual (pedido
        // explícito: "dar mayor visibilidad al nombre del responsable").
        bloqueIdentificacion(doc, 'Delegado oficial', (doc) => {
            nombreDestacado(doc, 'Delegado Oficial', cartilla.delegado_nombre);
            filaInfo(doc, [{ label: 'Teléfono', value: cartilla.delegado_telefono }]);
        }, { alturaMinimaContenido: 80 }); // nombre destacado + 1 fila

        // Personal de apoyo — Veterinario/Técnico (izquierda) y Secretario
        // (derecha) en dos columnas reales, nunca ocho líneas continuas.
        bloqueIdentificacion(doc, 'Personal de apoyo', (doc) => {
            const vetHdr = rj.informe_veterinario || {};
            const sec = rj.secretario || {};
            dosColumnas(doc,
                (doc) => {
                    subtitulo(doc, 'Veterinario, Técnico u otro');
                    filaInfo(doc, [{ label: 'Nombre', value: vetHdr.nombre }]);
                    filaInfo(doc, [{ label: 'RUT', value: vetHdr.rut }]);
                },
                (doc) => {
                    subtitulo(doc, 'Secretario');
                    filaInfo(doc, [{ label: 'Nombre', value: sec.nombre || cartilla.secretario_jurado }]);
                    filaInfo(doc, [{ label: 'RUT', value: sec.rut }]);
                    filaInfo(doc, [{ label: 'N° de Socio', value: sec.n_socio || cartilla.secretario_numero_socio }]);
                    filaInfo(doc, [{ label: 'Teléfono', value: sec.telefono }]);
                    filaInfo(doc, [{ label: 'Correo', value: sec.correo }]);
                }
            );
        }, { alturaMinimaContenido: 180 }); // columna más alta: Secretario, 5 filas + subtítulo

        // Antecedentes del rodeo.
        bloqueIdentificacion(doc, 'Antecedentes del rodeo', (doc) => {
            const antecedentes = [];
            // "Público" retirado del formulario de nuevas cartillas (auditoría
            // versión final) — se sigue imprimiendo SOLO si es un dato histórico.
            if (cartilla.publico_serie_campeones != null) antecedentes.push({ label: 'Público (dato histórico)', value: String(cartilla.publico_serie_campeones) });
            antecedentes.push({ label: '¿Final a dos vueltas en el apiñadero?', value: yn(cartilla.serie_campeones_dos_vueltas) });
            antecedentes.push({ label: 'Incluye informe disciplinario', value: yn(cartilla.incluye_informe_disciplinario) });
            antecedentes.push({ label: 'Incluye informe ganado bajo peso', value: yn(cartilla.incluye_informe_ganado_bajo_peso) });
            filaInfoEnPares(doc, antecedentes);
        }, { alturaMinimaContenido: 70 }); // hasta 2 filas (3 campos sin histórico, 4 con histórico)

        // Certificación del Club Organizador — separada de los antecedentes.
        bloqueIdentificacion(doc, 'Certificación del Club Organizador', (doc) => {
            filaInfoEnPares(doc, [
                { label: 'Medialuna de la comuna del club', value: yn(cartilla.certificacion_medialuna_comuna) },
                { label: 'Más de 200 personas (Serie Campeones)', value: yn(cartilla.certificacion_mas_200_personas) },
                { label: 'Más de 250 personas (Serie Campeones)', value: yn(cartilla.certificacion_mas_250_personas) },
                { label: 'Proyecto de vinculación con la comunidad', value: yn(cartilla.certificacion_vinculacion_comunidad) }
            ]);
        }, { alturaMinimaContenido: 62 }); // 2 filas, 4 campos — medido contra el contenido real (evita reservar de más y perder página 1 sin necesidad)

        // ── I. Información de las Series e Informe del Ganado — TABLA
        // HORIZONTAL, SIN CAMBIOS (pedido explícito: "no quiero modificar
        // esas tablas"). Solo el título usa el mismo helper que el resto
        // del documento para mantener la tipografía/separación consistentes
        // — el contenido y la estructura de las tablas siguen idénticos. ──
        const series = Array.isArray(rj.ganado_series) ? rj.ganado_series : [];
        if (series.length > 0) {
            const PAGINA_GANADO = { size: 'A4', layout: 'landscape', margin: 50 };
            doc.addPage(PAGINA_GANADO);
            tituloSeccion(doc, 'I. INFORMACIÓN DE LAS SERIES E INFORME DEL GANADO');

            const numP = (v) => { const n = parseFloat(v); return (!isNaN(n) && n >= 0) ? n : 0; };
            const nombresAnimal = ['1er animal', '2do animal', '3er animal', '4to animal'];
            const COLUMNAS_GANADO = [
                { header: 'Animal',         width: 100, align: 'left'   },
                { header: 'N° colleras',    width: 56,  align: 'center' },
                { header: '# Ganado',       width: 56,  align: 'center' },
                { header: 'Vueltas',        width: 48,  align: 'center' },
                { header: 'Tipo',           width: 62,  align: 'center' },
                { header: 'Peso (kg)',      width: 56,  align: 'center' },
                { header: 'Corrido',        width: 54,  align: 'center' },
                { header: 'Repetido',       width: 58,  align: 'center' },
                { header: 'Calidad',        width: 60,  align: 'center' },
                { header: 'Bajo/sobrepeso', width: 70,  align: 'center' },
                { header: 'Porcentaje',     width: 58,  align: 'center' }
            ];

            // Ganado bajo/sobrepeso reglamentario — 5ª revisión, punto 2: por
            // cada animal (Art. 242), no solo total de la Serie. Detección
            // por presencia de datos (f1c..f4c) vs formato anterior
            // (fp_tot/fp_baj/fp_sob, solo por Serie) — sin bandera de
            // versión ni migración, igual que en el formulario del Delegado.
            series.forEach((s, i) => {
                const legacy = !!(s.fp_tot || s.fp_baj || s.fp_sob) && !(s.f1c || s.f2c || s.f3c || s.f4c);

                asegurarEspacio(doc, 60, PAGINA_GANADO);
                doc.fontSize(10.5).fillColor(AZUL).font('Helvetica-Bold').text(`Serie ${i + 1}: ${celdaValor(s.nombre)}`);
                doc.moveDown(0.2);

                const filas = [1, 2, 3, 4].map(n => {
                    const pct = legacy ? null : calcularPorcentajeFueraPeso(s['c'+n+'g'], s['f'+n+'c']);
                    return [
                        nombresAnimal[n-1],
                        celdaValor(s['c'+n+'n']),
                        celdaValor(s['c'+n+'g']),
                        celdaValor(s['v'+n+'v']),
                        celdaValor(s['v'+n+'t']),
                        celdaValor(s['v'+n+'p']),
                        celdaValor(s['q'+n+'c']),
                        celdaValor(s['q'+n+'r']),
                        celdaValor(s['q'+n+'k']),
                        legacy ? '—' : celdaValor(s['f'+n+'c']),
                        legacy ? '—' : (pct !== null ? pct.toFixed(1) + '%' : '—')
                    ];
                });
                dibujarTabla(doc, { columnas: COLUMNAS_GANADO, filas, paginaOpciones: PAGINA_GANADO, fontSize: 8 });
                doc.moveDown(0.25);

                // Resumen de ganado y fuera de peso al final de la serie.
                //
                // Cero real vs. ausencia de dato (revisión del usuario): un
                // total es la SUMA de varios campos (los 4 animales, o
                // bajo+sobre peso en el formato anterior) — sumar valores
                // vacíos con numP() los trata como 0, así que la suma por sí
                // sola no distingue "se ingresó 0 en todos" de "no se
                // ingresó nada". `hayDato()` resuelve esa ambigüedad
                // mirando los campos CRUDOS (antes de sumar): si AL MENOS
                // uno tiene un valor realmente ingresado, el total se
                // muestra tal cual (incluso si es 0, porque ese 0 es real);
                // si NINGUNO lo tiene, se muestra '—' (nunca se inventa un
                // 0 que nadie ingresó).
                const hayDato = (v) => v !== undefined && v !== null && String(v).trim() !== '';
                asegurarEspacio(doc, 44, PAGINA_GANADO);
                if (legacy) {
                    const hayTot = hayDato(s.fp_tot), hayBaj = hayDato(s.fp_baj), haySob = hayDato(s.fp_sob);
                    const tot = numP(s.fp_tot), baj = numP(s.fp_baj), sob = numP(s.fp_sob);
                    const fuer = baj + sob, pct = tot > 0 ? ((fuer / tot) * 100).toFixed(1) + '%' : '—';
                    doc.fontSize(8).fillColor('#888').font('Helvetica-Oblique')
                       .text('Formato anterior — fuera de peso solo por Serie (no por animal).');
                    doc.moveDown(0.1);
                    dibujarTabla(doc, {
                        paginaOpciones: PAGINA_GANADO, fontSize: 8.5, headerColor: '#4a5568',
                        columnas: [
                            { header: 'Total ganado (Art. 242)', width: 160, align: 'center' },
                            { header: 'Bajo peso',               width: 110, align: 'center' },
                            { header: 'Sobre peso',              width: 110, align: 'center' },
                            { header: 'Total fuera de peso',     width: 140, align: 'center' },
                            { header: '% fuera de peso',         width: 110, align: 'center' }
                        ],
                        filas: [[
                            hayTot ? tot : '—',
                            hayBaj ? baj : '—',
                            haySob ? sob : '—',
                            (hayBaj || haySob) ? fuer : '—',
                            pct
                        ].map(celdaValor)]
                    });
                } else {
                    let totGanado = 0, totFuera = 0, hayGanado = false, hayFuera = false;
                    [1, 2, 3, 4].forEach(n => {
                        const g = s['c'+n+'g'], f = s['f'+n+'c'];
                        if (hayDato(g)) hayGanado = true;
                        if (hayDato(f)) hayFuera = true;
                        totGanado += numP(g); totFuera += numP(f);
                    });
                    const pctResumen = calcularPorcentajeFueraPeso(totGanado, totFuera);
                    dibujarTabla(doc, {
                        paginaOpciones: PAGINA_GANADO, fontSize: 8.5, headerColor: '#4a5568',
                        columnas: [
                            { header: 'Total ganado utilizado', width: 170, align: 'center' },
                            { header: 'Total fuera de peso',    width: 170, align: 'center' },
                            { header: '% fuera de peso',        width: 120, align: 'center' }
                        ],
                        filas: [[
                            hayGanado ? totGanado : '—',
                            hayFuera ? totFuera : '—',
                            pctResumen !== null ? pctResumen.toFixed(1) + '%' : '—'
                        ].map(celdaValor)]
                    });
                }
                doc.fillColor('#333').font('Helvetica');
                doc.moveDown(0.5);
            });

            // Vuelve a A4 vertical para el resto del documento.
            doc.addPage({ size: 'A4', margin: 50 });
        }

        // ── II. Informe si hubo reemplazo de jinetes ────────────────
        const ree = rj.reemplazo_jinetes;
        if (ree) {
            tituloSeccion(doc, 'II. INFORME SI HUBO REEMPLAZO DE JINETES');
            filaInfo(doc, [{ label: 'Hubo reemplazo', value: yn(ree.hubo) }]);
            if (ree.hubo === 'si' && Array.isArray(ree.items) && ree.items.length > 0) {
                ree.items.forEach((r2, i) => {
                    registro(doc, {
                        numero: i + 1,
                        titulo: `${celdaValor(r2.nombre_reemplazado)} (${celdaValor(r2.rut_reemplazado)}) — reemplazado por ${celdaValor(r2.nombre_reemplazante)} (${celdaValor(r2.rut_reemplazante)})`,
                        detalles: [
                            { label: 'Motivo', texto: r2.motivo },
                            { label: 'Serie', texto: r2.serie },
                            { label: 'Detalle', texto: r2.detalle },
                            { label: 'Observaciones', texto: r2.observaciones }
                        ]
                    });
                });
            }
        }

        // ── Faltas o sanciones disciplinarias en cada serie (breve) ──
        // Reutiliza `rj.ganado_series` (falta_hubo/falta_articulo/falta_obs
        // por serie). NO se confunde con "IV. Informe de disciplina"
        // (detalle completo de los hechos e infractores).
        const conFaltas = series.filter(s => s.falta_hubo || s.falta_articulo || s.falta_obs);
        if (conFaltas.length > 0) {
            tituloSeccion(doc, 'FALTAS O SANCIONES DISCIPLINARIAS EN CADA SERIE');
            conFaltas.forEach((s, i) => {
                registro(doc, {
                    numero: i + 1,
                    titulo: `${celdaValor(s.nombre)}: ${yn(s.falta_hubo)}${s.falta_articulo ? ' — Art. ' + s.falta_articulo : ''}`,
                    detalles: [{ texto: s.falta_obs }]
                });
            });
        }

        // ── III. Informe de accidentes (UNIFICADA) ────────────────────
        // Combina la mención breve (relato libre histórico,
        // `rj.informe_accidentes_general`) y el detalle estructurado
        // (médico, contacto, accidentados, `rj.accidentes_informe`) en una
        // sola sección — tal como la versión final la presenta.
        const acc = rj.accidentes_informe;
        const textoAccGeneral = typeof rj.informe_accidentes_general === 'string' ? rj.informe_accidentes_general : '';
        if ((acc && acc.hubo_accidentes != null) || textoAccGeneral) {
            tituloSeccion(doc, 'III. INFORME DE ACCIDENTES');
            if (acc) {
                filaInfoEnPares(doc, [
                    { label: 'Hubo accidentes en el Rodeo', value: yn(acc.hubo_accidentes) },
                    { label: 'Se revisó protocolo de rescate', value: yn(acc.reviso_protocolo) },
                    { label: 'Médico / paramédico', value: acc.medico_nombre },
                    { label: 'Teléfono de contacto', value: acc.medico_telefono },
                    { label: 'Correo de contacto', value: acc.medico_email }
                ]);
                if (acc.observaciones_generales) parrafo(doc, 'Observaciones generales', acc.observaciones_generales);
            }
            if (textoAccGeneral) parrafo(doc, 'Relato general (dato histórico)', textoAccGeneral);
            if (acc && Array.isArray(acc.items) && acc.items.length > 0) {
                subtitulo(doc, 'Accidentados');
                acc.items.forEach((a, i) => {
                    const esLegacyAcc = !!(a.tipo || a.persona || a.categoria || a.descripcion || a.atencion) && !(a.serie || a.animal || a.collera || a.accidentado);
                    if (esLegacyAcc) {
                        registro(doc, {
                            numero: i + 1,
                            titulo: `[Formato anterior] ${celdaValor(a.persona)} (${celdaValor(a.rut)}) — ${celdaValor(a.categoria)} — ${celdaValor(a.descripcion)}`,
                            detalles: [{ label: 'Atención', texto: a.atencion }, { label: 'Observaciones', texto: a.observaciones }]
                        });
                    } else {
                        registro(doc, {
                            numero: i + 1,
                            titulo: `${celdaValor(a.serie)} — ${celdaValor(a.animal)} — Collera ${celdaValor(a.collera)} — ${celdaValor(a.accidentado)} (${celdaValor(a.rut_socio)}) — ${celdaValor(a.asociacion_club)}`,
                            detalles: [{ label: 'Detalle', texto: a.detalle_hechos }, { label: 'Consecuencia', texto: a.consecuencia }]
                        });
                    }
                });
            }
        }

        // ── IV. Informe sobre el desempeño del Jurado ──────────────────
        const dj = rj.desempeno_jurado;
        if (dj) {
            tituloSeccion(doc, 'IV. INFORME SOBRE EL DESEMPEÑO DEL JURADO');
            const ASPECTOS_PDF = [
                { key: 'aspecto_1', label: '1. Faltas en el apiñadero' },
                { key: 'aspecto_2', label: '2. Faltas en la cancha (incl. postura)' },
                { key: 'aspecto_3', label: '3. Atajadas válidas / faltas en la atajada' },
                { key: 'aspecto_4', label: '4. Faltas en la entrega del novillo' }
            ];
            const esFormatoNuevo = ASPECTOS_PDF.some(a => dj[a.key] !== undefined && dj[a.key] !== null);
            if (esFormatoNuevo) {
                filaInfoEnPares(doc, ASPECTOS_PDF.map(a => ({ label: a.label, value: dj[a.key] != null ? String(dj[a.key]) : null })));
                notaDestacada(doc, 'Nota promedio', dj.nota_promedio != null ? String(dj.nota_promedio) : 'Pendiente');
            } else {
                // Formato anterior — se conserva para cartillas históricas.
                filaInfo(doc, [{ label: 'Evaluación realizada', value: yn(dj.evaluacion_realizada) }]);
                if (dj.evaluacion_realizada === 'si' || dj.evaluacion_realizada === true) {
                    filaInfoEnPares(doc, [
                        { label: 'Fecha de evaluación', value: dj.fecha_evaluacion },
                        { label: 'Cantidad de jurados', value: dj.cantidad_jurados },
                        { label: 'Más de un jurado', value: yn(dj.mas_de_un_jurado) }
                    ]);
                    if (Array.isArray(dj.jurados) && dj.jurados.length > 0) {
                        subtitulo(doc, 'Jurados evaluados');
                        dj.jurados.forEach((j, i) => {
                            registro(doc, { numero: i + 1, titulo: `${celdaValor(j.nombre)} (${celdaValor(j.cargo)})`, detalles: [{ label: 'Nota', texto: j.nota }] });
                        });
                    }
                }
            }
            if (dj.observaciones) parrafo(doc, 'Observaciones', dj.observaciones);
        }

        // ── V. Situaciones a revisar (máximo 3, NUEVA) ─────────────────
        const sitRev = rj.situaciones_revisar;
        if (sitRev && Array.isArray(sitRev.items) && sitRev.items.length > 0) {
            tituloSeccion(doc, 'V. SITUACIONES A REVISAR');
            sitRev.items.forEach((s, i) => {
                registro(doc, {
                    numero: i + 1,
                    titulo: `Serie: ${celdaValor(s.serie)} — Animal: ${celdaValor(s.animal)} — Collera: ${celdaValor(s.collera)}`,
                    detalles: [{ texto: s.detalle }]
                });
            });
        }

        // ── VI. Informe de disciplina y antecedentes disciplinarios
        // complementarios (UNIFICADA) — combina las situaciones
        // estructuradas y el campo libre de antecedentes complementarios
        // (antes "X. Anexo 04"), tal como la versión final las presenta
        // en una sola sección. ─────────────────────────────────────────
        const disc = rj.disciplina_informe;
        const antPdf = rj.antecedentes_disciplinarios;
        if (disc || (antPdf && antPdf.texto)) {
            tituloSeccion(doc, 'VI. INFORME DE DISCIPLINA Y ANTECEDENTES DISCIPLINARIOS COMPLEMENTARIOS');
            if (disc) {
                filaInfo(doc, [{ label: 'Hubo informe disciplinario', value: yn(disc.hubo_informe) }]);
                if (disc.hubo_informe === 'si' && Array.isArray(disc.situaciones) && disc.situaciones.length > 0) {
                    subtitulo(doc, 'Situaciones disciplinarias');
                    disc.situaciones.forEach((s, i) => {
                        // MEJORA 1 — "No informado" explícito (nunca celdaValor,
                        // que usaría "—") para distinguir sin ambigüedad una
                        // cartilla histórica sin este campo de una serie
                        // deliberadamente vacía.
                        const serieTxt = s.serie && String(s.serie).trim() ? celdaValor(s.serie) : 'No informado';
                        registro(doc, {
                            numero: i + 1,
                            titulo: `Serie: ${serieTxt} — ${celdaValor(s.nombre_infractor)} (RUT: ${celdaValor(s.rut)}, N° socio: ${celdaValor(s.num_socio)}) — ${celdaValor(s.tipo_falta)} — Art. ${celdaValor(s.articulo)}`,
                            detalles: [
                                { label: 'Testigos', texto: s.testigos },
                                { label: 'Detalle', texto: s.detalle },
                                { label: 'Observaciones', texto: s.observaciones }
                            ]
                        });
                    });
                }
            }
            if (antPdf && antPdf.texto) parrafo(doc, 'Antecedentes disciplinarios complementarios', antPdf.texto);
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
            tituloSeccion(doc, 'VII. INFORME SOBRE EL ESTADO DEL RECINTO DEPORTIVO');
            if (esLegacy) lineaSimple(doc, 'Formato anterior (18 aspectos) — cartilla registrada antes del nuevo formato oficial.', { fontSize: 8.5, color: GRIS, cursiva: true });
            const camposRecinto = aspectosRecinto
                .filter(a => rec[a.key + '_estado'] || rec[a.key + '_obs'])
                .map(a => ({ label: a.label, value: (rec[a.key + '_estado'] || '—') + (rec[a.key + '_obs'] ? ` (${rec[a.key + '_obs']})` : '') }));
            filaInfoEnPares(doc, camposRecinto);
            if (rec.otros) parrafo(doc, 'Otros aspectos', rec.otros);
        }

        // ── VIII. Colleras Invitadas — tabla institucional (revisión
        // Nov-2026, reemplaza los registros de texto uno debajo del otro):
        // reutiliza dibujarTabla (el mismo helper de la tabla de ganado, SIN
        // modificarlo) — ya maneja salto de página con encabezado repetido y
        // ajuste de alto de fila para nombres largos, en cualquier
        // orientación (ver cartillaDelegadoPdfTabla.js). Las observaciones
        // particulares de una collera (si existen) se listan aparte, debajo
        // de la tabla, asociadas a su número — nunca se pierden, nunca se
        // fuerzan dentro de una columna angosta. ────────────────────────
        const col = rj.colleras_invitadas;
        if (col) {
            tituloSeccion(doc, 'VIII. INFORME DE COLLERAS INVITADAS');
            filaInfo(doc, [{ label: 'Sin colleras invitadas', value: yn(col.no_hubo) }]);
            if (!col.no_hubo && Array.isArray(col.items) && col.items.length > 0) {
                const COLUMNAS_COLLERAS_INV = [
                    { header: 'N°',         width: 26,  align: 'center' },
                    { header: 'Jinete 1',   width: 128, align: 'left'   },
                    { header: 'Jinete 2',   width: 128, align: 'left'   },
                    { header: 'Club',       width: 122, align: 'left'   },
                    { header: 'Asociación', width: 91,  align: 'left'   }
                ];
                const filasCollerasInv = col.items.map((c2, i) => [
                    String(i + 1), celdaValor(c2.jinete1), celdaValor(c2.jinete2), celdaValor(c2.club), celdaValor(c2.asociacion)
                ]);
                asegurarEspacio(doc, 60);
                dibujarTabla(doc, { columnas: COLUMNAS_COLLERAS_INV, filas: filasCollerasInv, fontSize: 9 });
                doc.fillColor('#333').font('Helvetica');
                doc.moveDown(0.4);

                const observacionesCollerasInv = col.items
                    .map((c2, i) => ({ numero: i + 1, texto: c2.observaciones }))
                    .filter(o => o.texto !== undefined && o.texto !== null && String(o.texto).trim() !== '');
                if (observacionesCollerasInv.length > 0) {
                    subtitulo(doc, 'Observaciones por collera');
                    observacionesCollerasInv.forEach(o => parrafo(doc, `Collera N° ${o.numero}`, o.texto));
                }
            }
        }

        // ── Colleras que corren por los premios / dejan puntos para la
        // próxima temporada (nuevo) — dos secciones INDEPENDIENTES entre sí
        // y de "Colleras Invitadas" (requisito explícito del usuario: nunca
        // mezclarlas). Cada una tiene su propia pregunta Sí/No/No informado
        // y su propia tabla de 9 campos — se agrupan en una sola función
        // porque comparten exactamente la misma estructura, nunca se
        // duplica la lógica de dibujo.
        tablaColleraNueve(doc, rj.corre_premios, 'COLLERAS QUE CORREN POR LOS PREMIOS', '¿Hay colleras que corren por los premios?');
        tablaColleraNueve(doc, rj.deja_puntos_temporada, 'COLLERAS QUE DEJAN PUNTOS PARA LA PRÓXIMA TEMPORADA', '¿El rodeo deja puntos para la próxima temporada?');

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
            tituloSeccion(doc, 'IX. INFORME DELEGADO / VETERINARIO CONDICIONES DE BIENESTAR ANIMAL');
            if (ba) {
                filaInfoEnPares(doc, CAMPOS_BIENESTAR
                    .filter(c3 => ba[c3.key] != null)
                    .map(c3 => ({ label: c3.label, value: yn(ba[c3.key]) + (ba[c3.key + '_obs'] ? ` (${ba[c3.key + '_obs']})` : '') })));
                filaInfo(doc, [{ label: 'Hubo lesiones en equinos', value: yn(ba.hubo_lesiones_equinos) }, { label: 'Hubo lesiones en bovinos', value: yn(ba.hubo_lesiones_bovinos) }]);
                if (ba.detalle_lesiones_equinos) parrafo(doc, 'Lesiones equinos', ba.detalle_lesiones_equinos);
                if (ba.detalle_lesiones_bovinos) parrafo(doc, 'Lesiones bovinos', ba.detalle_lesiones_bovinos);
                if (ba.detalle_lesiones) parrafo(doc, 'Detalle lesiones (formato anterior)', ba.detalle_lesiones);
                if (ba.observaciones) parrafo(doc, 'Observaciones', ba.observaciones);
            }
            if (vetTieneBienestarPropio) {
                lineaSimple(doc, 'Respuesta adicional del veterinario (Anexo 02, dato histórico):', { fontSize: 8.5, color: GRIS, cursiva: true });
                filaInfoEnPares(doc, CAMPOS_BIENESTAR
                    .filter(c3 => vet[c3.key] != null)
                    .map(c3 => ({ label: c3.label, value: yn(vet[c3.key]) + (vet[c3.key + '_obs'] ? ` (${vet[c3.key + '_obs']})` : '') })));
                if (vet.detalle_lesiones_equinos) parrafo(doc, 'Lesiones equinos (veterinario)', vet.detalle_lesiones_equinos);
                if (vet.detalle_lesiones_bovinos) parrafo(doc, 'Lesiones bovinos (veterinario)', vet.detalle_lesiones_bovinos);
                if (vet.observaciones) parrafo(doc, 'Observaciones (veterinario)', vet.observaciones);
            }
        }

        // ── X. Reclamos o Sugerencias ────────────────────────────────
        const recs = rj.reclamos_sugerencias;
        if (recs) {
            tituloSeccion(doc, 'X. RECLAMOS O SUGERENCIAS');
            filaInfo(doc, [{ label: 'Hubo reclamos', value: yn(recs.hubo_reclamos) }]);
            if (recs.hubo_reclamos === 'si' && Array.isArray(recs.items) && recs.items.length > 0) {
                recs.items.forEach((r3, i) => {
                    registro(doc, {
                        numero: i + 1,
                        titulo: `${celdaValor(r3.nombre)} (${celdaValor(r3.rut)}) — ${celdaValor(r3.tipo)}`,
                        detalles: [
                            { label: 'Detalle', texto: r3.detalle },
                            { label: 'Respuesta', texto: r3.respuesta },
                            { label: 'Observaciones', texto: r3.observaciones }
                        ]
                    });
                });
            }
            if (recs.sugerencias) parrafo(doc, 'Sugerencias', recs.sugerencias);
            if (recs.observaciones_generales) parrafo(doc, 'Observaciones generales', recs.observaciones_generales);
        }

        // ── XI. Comentarios generales ─────────────────────────────────
        const com = rj.comentarios_generales;
        if (com && com.texto) {
            tituloSeccion(doc, 'XI. COMENTARIOS GENERALES');
            parrafo(doc, null, com.texto);
        }

        // ── Historial de observaciones ─────────────────────────────
        const historial = Array.isArray(cartilla.historial_observaciones) ? cartilla.historial_observaciones : [];
        if (historial.length > 0) {
            tituloSeccion(doc, 'HISTORIAL DE OBSERVACIONES ADMINISTRATIVAS');
            historial.forEach((h, i) => {
                registro(doc, {
                    numero: i + 1,
                    titulo: `[${celdaValor(h.tipo)}] ${h.fecha ? fmtFechaHora(h.fecha) : '—'} — ${celdaValor(h.por)}`,
                    detalles: [{ label: 'Motivo', texto: h.motivo }]
                });
            });
        }

        // ── Historial de Responsables de la Cartilla (Fase 3.5) ──────
        // Exclusivo de cartillas de origen institucional (delegado_asociacion_id
        // presente) — las de Delegado Rentado nunca reciben historialResponsables
        // (parámetro opcional), así que este bloque NUNCA aparece en sus PDFs, ni
        // en los ya emitidos ni en los nuevos. Se construye 100% desde eventos de
        // auditoria ya persistidos (services/historialResponsableInstitucional.js)
        // — nunca se fabrica un evento. No reemplaza ni altera ninguna de las 14
        // secciones anteriores, solo se agrega al final.
        if (cartilla.delegado_asociacion_id && Array.isArray(historialResponsables) && historialResponsables.length > 0) {
            tituloSeccion(doc, 'HISTORIAL DE RESPONSABLES DE LA CARTILLA');
            lineaSimple(doc, 'Nota: el delegado declarado corresponde a la cuenta institucional de la asociación (credencial compartida). Este historial no certifica la identidad individual de quien efectivamente completó cada campo.', { fontSize: 8.3, color: GRIS, cursiva: true });
            const ETIQUETAS_ACCION = {
                confirmar_responsable_institucional: 'Delegado confirmado como responsable',
                reemplazar_responsable_institucional: 'Reemplazo de responsable autorizado por Administrador',
                crear: 'Creación de la cartilla',
                guardar: 'Guardado de avance',
                enviar: 'Envío de la cartilla'
            };
            historialResponsables.forEach((ev, i) => {
                const etiqueta = ETIQUETAS_ACCION[ev.accion] || ev.accion || '—';
                registro(doc, {
                    numero: i + 1,
                    titulo: `[${ev.created_at ? fmtFechaHora(ev.created_at) : '—'}] ${etiqueta}`,
                    detalles: [{ texto: ev.descripcion }]
                });
            });
        }

        // ── Cierre ─────────────────────────────────────────────────
        asegurarEspacio(doc, 40);
        doc.moveDown(0.4);
        doc.x = doc.page.margins.left;
        doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#ccc').lineWidth(1).stroke();
        doc.moveDown(0.5);
        doc.x = doc.page.margins.left;
        doc.fontSize(9).fillColor(GRIS)
           .text(`Estado: ${estadoLabel}  |  Generado: ${fmtFechaHora(new Date().toISOString())}`, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right })
           .text('Generado por el Sistema de Jurados — Federación Deportiva Nacional de Rodeo Chileno');

        // Pie de página consistente en TODAS las páginas — se aplica al
        // final, recorriendo las páginas ya generadas (bufferPages:true).
        aplicarPieDePagina(doc, 'Sistema de Jurados — Federación Deportiva Nacional de Rodeo Chileno');

        doc.end();
    });
}

// ── Helpers ───────────────────────────────────────────────────────
function yn(v) {
    if (v === 'si' || v === true)  return 'Sí';
    if (v === 'no' || v === false) return 'No';
    return '—';
}

// "Corre por los premios" / "Deja puntos para la próxima temporada" (nuevo):
// pregunta Sí/No/No informado + tabla de 9 campos por collera, agrupados en
// 6 columnas (Jinete/Caballo combinan nombre+RUT o nombre+N° en la MISMA
// celda, en dos líneas) para que la tabla completa entre en el ancho útil de
// A4 vertical sin comprimir la letra hasta volverla ilegible — pedido
// explícito del usuario. Reutiliza dibujarTabla (tabla de ganado) sin
// modificarlo. "No informado" (nunca "No" asumido) es para cartillas
// anteriores a esta pregunta, que no tienen `estado` en absoluto.
function tablaColleraNueve(doc, estado, tituloTexto, preguntaTexto) {
    tituloSeccion(doc, tituloTexto);
    const respuesta = estado?.respuesta;
    const respuestaTexto = respuesta === 'si' ? 'Sí' : respuesta === 'no' ? 'No' : 'No informado';
    filaInfo(doc, [{ label: preguntaTexto, value: respuestaTexto }]);

    if (respuesta !== 'si') return; // nunca se dibuja la tabla si la respuesta no es "Sí" (tampoco para "No informado")

    const items = Array.isArray(estado?.items) ? estado.items : [];
    if (items.length === 0) {
        lineaSimple(doc, 'Sin colleras registradas.', { fontSize: 9, color: GRIS_NOTA, cursiva: true });
        return;
    }

    const COLUMNAS_COLLERA_9 = [
        { header: 'N°',        width: 22,  align: 'center' },
        { header: 'Jinete 1',  width: 128, align: 'left'   },
        { header: 'Jinete 2',  width: 128, align: 'left'   },
        { header: 'Caballo 1', width: 84,  align: 'left'   },
        { header: 'Caballo 2', width: 84,  align: 'left'   },
        { header: 'Lugar',     width: 49,  align: 'center' }
    ];
    const filasCollera9 = items.map((c, i) => [
        String(i + 1),
        `${celdaValor(c.nombre1)}\n${celdaValor(c.rut1)}`,
        `${celdaValor(c.nombre2)}\n${celdaValor(c.rut2)}`,
        `${celdaValor(c.nombre_caballo1)}\nN° ${celdaValor(c.num_caballo1)}`,
        `${celdaValor(c.nombre_caballo2)}\nN° ${celdaValor(c.num_caballo2)}`,
        celdaValor(c.lugar)
    ]);
    asegurarEspacio(doc, 60);
    dibujarTabla(doc, { columnas: COLUMNAS_COLLERA_9, filas: filasCollera9, fontSize: 8.5 });
    doc.fillColor('#333').font('Helvetica');
    doc.moveDown(0.4);
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
