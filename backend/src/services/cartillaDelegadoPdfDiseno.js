// ═════════════════════════════════════════════════════════════════════════
// cartillaDelegadoPdfDiseno.js — helpers reutilizables de diseño para las
// páginas VERTICALES del PDF de la Cartilla del Delegado (todo salvo la
// tabla de ganado, que vive aparte en cartillaDelegadoPdfTabla.js y no se
// toca: "no quiero modificar esas tablas"). Antes cada sección dibujaba su
// propio texto con `campo()`/`.text()` sueltos, sin interlineado ni
// separación consistente entre bloques — esto convierte el documento en un
// informe institucional: encabezados azules con separación arriba/abajo,
// pares etiqueta/valor alineados, párrafos con interlineado cómodo, listas
// con separación entre registros (nunca partidos entre páginas) y un pie de
// página consistente en todas las hojas.
//
// Reutiliza asegurarEspacio/limiteInferior/celdaValor de
// cartillaDelegadoPdfTabla.js (la tabla de ganado y estas páginas comparten
// el mismo criterio de salto de página y de "0 real nunca es ausencia de
// dato") — nunca se duplica esa lógica.
// ═════════════════════════════════════════════════════════════════════════
const { celdaValor, asegurarEspacio, limiteInferior } = require('./cartillaDelegadoPdfTabla');

const AZUL        = '#1a3c6e';
const AZUL_SUAVE  = '#2f5593';
const GRIS_LABEL  = '#5b6b82';
const GRIS_TEXTO  = '#333333';
const GRIS_NOTA   = '#8a97a8';
const LINEA_SUAVE = '#c7d4e8';
const FONDO_SUAVE = '#eef3fa';
const BARRA_SUAVE = '#9fb3cf';

const FS_TITULO_SECCION = 12.5;
const FS_SUBTITULO      = 10;
const FS_LABEL          = 8.3;
const FS_VALOR          = 10.5; // dentro del rango 10-11pt pedido
const FS_PARRAFO        = 10;
const FS_REGISTRO_TIT   = 9.5;
const FS_REGISTRO_DET   = 9;

// lineGap ~0.16x el tamaño de fuente: el alto de línea base de Helvetica en
// pdfkit (métricas AFM) ya equivale a ~1.15x el tamaño de fuente, así que
// sumar este lineGap da un interlineado total ~1.3x — dentro del rango
// 1.25-1.35 pedido. (Antes era 0.32, que sumado a ese ~1.15 base daba ~1.47x:
// más "aire" entre líneas del que se pidió, y una de las causas de que el
// documento pasara de 4 a 7 páginas sin que el contenido lo requiriera.)
const lineGap = (fs) => fs * 0.16;

function anchoUtilPagina(doc) {
    return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

// ── Encabezado principal (portada, revisión Nov-2026): logo institucional
// a la izquierda + título/subtítulo centrados en el espacio restante + línea
// institucional debajo. `logoPath` es opcional. Si falla, el error se
// REGISTRA con console.error (nunca se oculta en silencio — pedido explícito
// del usuario: "investigar la causa real" si el logo falla) pero no hace
// fallar la generación del PDF completo por un activo gráfico — degrada al
// encabezado sin logo, igual que si `logoPath` nunca se hubiera pasado.
function encabezadoPrincipal(doc, logoPath) {
    const anchoTotal = anchoUtilPagina(doc);
    const xIzq = doc.page.margins.left;
    const yTop = doc.y;
    const logoSize = 50; // dentro del rango 45-55pt pedido
    let xTexto = xIzq;
    let anchoTexto = anchoTotal;
    let logoDibujado = false;

    if (logoPath) {
        try {
            doc.image(logoPath, xIzq, yTop, { width: logoSize, height: logoSize });
            logoDibujado = true;
        } catch (err) {
            console.error('[cartillaDelegadoPdfDiseno] No se pudo incrustar el logo institucional (' + logoPath + '):', err && err.message);
            logoDibujado = false;
        }
    }
    if (logoDibujado) {
        xTexto = xIzq + logoSize + 14;
        anchoTexto = anchoTotal - logoSize - 14;
    }

    // Texto institucional EXACTO (revisión del usuario): "Federación de
    // Rodeo Chileno" — NO "Federación Deportiva Nacional de Rodeo Chileno"
    // (el nombre largo que usa el resto del sistema). Es una decisión de
    // contenido explícita y repetida ("el texto debe ser exactamente ese"),
    // no un error de tipeo — se implementa tal cual fue pedida.
    doc.fontSize(16).fillColor(AZUL).font('Helvetica-Bold')
       .text('INFORME DEL DELEGADO OFICIAL DEL RODEO', xTexto, yTop + 3, { width: anchoTexto, align: 'center' });
    doc.fontSize(10).fillColor('#666666').font('Helvetica')
       .text('Federación de Rodeo Chileno', xTexto, doc.y + 3, { width: anchoTexto, align: 'center' });

    const yFinBloque = Math.max(doc.y, yTop + (logoDibujado ? logoSize : 0));
    doc.x = xIzq;
    doc.y = yFinBloque + 10;
    doc.moveTo(xIzq, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y)
       .strokeColor(AZUL).lineWidth(2).stroke();
    doc.y += 14; // buena separación entre el encabezado y el contenido del informe
    doc.x = xIzq;
}

// ── Franja de estado (debajo del encabezado, revisión Nov-2026): estado +
// fecha/hora de envío + N° de versión, en UNA franja compacta y propia —
// nunca mezclada con la identificación del rodeo que viene después.
function franjaEstado(doc, campos) {
    const visibles = campos.filter(c => c && c.value !== undefined && c.value !== null && String(c.value).trim() !== '');
    if (visibles.length === 0) return;
    const ancho = anchoUtilPagina(doc);
    const x = doc.page.margins.left;
    const alturaFranja = 28;
    asegurarEspacio(doc, alturaFranja + 14);
    const y = doc.y;
    doc.rect(x, y, ancho, alturaFranja).fill(FONDO_SUAVE);
    doc.rect(x, y, 3, alturaFranja).fill(AZUL);
    doc.x = x + 14;
    doc.y = y + 9;
    visibles.forEach((c, i) => {
        if (i > 0) doc.font('Helvetica').fontSize(9.5).fillColor(GRIS_NOTA).text('      ', { continued: true, lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(GRIS_LABEL).text(c.label.toUpperCase() + ':  ', { continued: true, lineBreak: false });
        doc.font('Helvetica').fontSize(9.5).fillColor('#1a1a1a').text(celdaValor(c.value), { continued: i < visibles.length - 1, lineBreak: false });
    });
    doc.x = x;
    doc.y = y + alturaFranja + 14;
}

// ── Página 1 — bloque de identificación (revisión Nov-2026): título con
// barra de color a la izquierda (mismo lenguaje visual que `registro()`, no
// una "tarjeta" con borde propio) + el contenido a continuación + separación
// moderada antes del próximo bloque. A propósito NO usa una caja/borde
// completo ni una letra en un recuadro: el pedido explícito fue evitar que
// los bloques de la portada parezcan "documentos separados" — solo deben
// leerse como secciones de UN mismo informe, con jerarquía clara pero sin
// aislarse unas de otras. `dibujarContenido` dibuja adentro con los helpers
// de siempre (filaInfo, subtitulo, dosColumnas, etc.) — nunca se duplica esa
// lógica.
//
// `alturaMinimaContenido` (mismo patrón que tituloSeccion): antes se
// reservaba un mínimo fijo de 40 — solo cubría el título. Si el título
// alcanzaba a entrar por poco al final de una página pero su contenido NO,
// el título quedaba huérfano abajo y TODO el contenido (ej. "Certificación
// del Club Organizador": título + 2 filas) saltaba solo a una página nueva,
// que quedaba casi vacía. Ahora se reserva título + un mínimo realista del
// contenido de CADA bloque (pasado por el llamador, que conoce cuántas
// filas tiene) — si no entra ese mínimo completo, el bloque ENTERO pasa
// junto a la página siguiente, nunca se separa el título de su contenido.
function bloqueIdentificacion(doc, titulo, dibujarContenido, { alturaMinimaContenido = 70 } = {}) {
    asegurarEspacio(doc, 30 + alturaMinimaContenido);
    if (doc.y > doc.page.margins.top + 2) doc.moveDown(0.35);
    const x0 = doc.page.margins.left;
    const y0 = doc.y;
    const anchoTotal = anchoUtilPagina(doc);

    const alturaTitulo = doc.fontSize(FS_SUBTITULO + 0.5).font('Helvetica-Bold').heightOfString(titulo, { width: anchoTotal - 10 });
    doc.rect(x0, y0, 3, alturaTitulo).fill(AZUL);
    doc.fontSize(FS_SUBTITULO + 0.5).font('Helvetica-Bold').fillColor(AZUL).text(titulo, x0 + 10, y0, { width: anchoTotal - 10 });
    doc.y = Math.max(doc.y, y0 + alturaTitulo) + 6;
    doc.x = x0;

    dibujarContenido(doc);

    doc.x = x0;
    // 7 (antes 10): mismo criterio de "separación moderada" pedido, pero
    // ajustado tras medir que el bloque "Certificación del Club
    // Organizador" (el más chico) quedaba a solo ~9.5pt de entrar completo
    // en lo que sobraba de la página 1 — este ahorro uniforme en los 4
    // bloques anteriores (nunca solo en Certificación, para no crear una
    // regla especial de un solo caso) recupera esos puntos sin apretar la
    // tipografía ni el interlineado.
    doc.y += 7;
}

// ── Dos columnas lado a lado dentro de un bloque (ej. "Personal de apoyo":
// Veterinario/Técnico a la izquierda, Secretario a la derecha) — a
// diferencia de `filaInfo` (que pone dos CAMPOS lado a lado), esto pone dos
// MINI-SECCIONES completas lado a lado, cada una con su propio subtítulo y
// filas. Angosta temporalmente los márgenes para que `subtitulo`/`filaInfo`
// (sin cambios) dibujen dentro de cada mitad; ambas columnas parten en el
// mismo y0 y avanzan de forma independiente — al final se usa la más alta
// de las dos como punto de continuación, para no superponer nada.
function dosColumnas(doc, dibujarIzquierda, dibujarDerecha, { gap = 20 } = {}) {
    const anchoTotal = anchoUtilPagina(doc);
    const anchoCol = (anchoTotal - gap) / 2;
    const xIzq = doc.page.margins.left;
    const y0 = doc.y;
    const margenIzqOriginal = doc.page.margins.left;
    const margenDerOriginal = doc.page.margins.right;

    doc.page.margins.right = doc.page.width - (xIzq + anchoCol);
    doc.x = xIzq;
    doc.y = y0;
    dibujarIzquierda(doc);
    const yIzq = doc.y;

    doc.page.margins.right = margenDerOriginal;
    doc.page.margins.left = xIzq + anchoCol + gap;
    doc.x = doc.page.margins.left;
    doc.y = y0;
    dibujarDerecha(doc);
    const yDer = doc.y;

    doc.page.margins.left = margenIzqOriginal;
    doc.page.margins.right = margenDerOriginal;
    doc.x = xIzq;
    doc.y = Math.max(yIzq, yDer);
}

// ── Nombre destacado (ej. Delegado Oficial): mayor jerarquía visual que un
// valor de filaInfo común — pedido explícito: "dar mayor visibilidad al
// nombre del responsable".
function nombreDestacado(doc, etiqueta, nombre) {
    const ancho = anchoUtilPagina(doc);
    asegurarEspacio(doc, 36);
    doc.x = doc.page.margins.left;
    doc.fontSize(FS_LABEL).font('Helvetica-Bold').fillColor(GRIS_LABEL).text(etiqueta.toUpperCase(), { width: ancho });
    doc.y += 2;
    doc.fontSize(13).font('Helvetica-Bold').fillColor(AZUL).text(celdaValor(nombre), { width: ancho });
    doc.x = doc.page.margins.left;
    doc.y += 6;
}

// ── Título de sección (I., II., III. ...) — azul institucional, negrita,
// con una línea tenue debajo y separación arriba/abajo. Nunca queda
// "huérfano" al final de una página: reserva espacio para sí mismo + un
// mínimo de contenido antes de decidir el salto.
function tituloSeccion(doc, texto, { alturaMinimaContenido = 40 } = {}) {
    asegurarEspacio(doc, 30 + alturaMinimaContenido);
    // 0.55 (antes 0.9): separa la nueva sección de la anterior sin dejar un
    // vacío tan grande que el documento se vea como secciones sueltas sin
    // continuidad — el título y su línea ya marcan la jerarquía por sí solos.
    if (doc.y > doc.page.margins.top + 2) doc.moveDown(0.55);
    doc.x = doc.page.margins.left;
    doc.fontSize(FS_TITULO_SECCION).fillColor(AZUL).font('Helvetica-Bold').text(texto, { width: anchoUtilPagina(doc) });
    const yLinea = doc.y + 3;
    doc.moveTo(doc.page.margins.left, yLinea).lineTo(doc.page.width - doc.page.margins.right, yLinea)
       .lineWidth(1.1).strokeColor(LINEA_SUAVE).stroke();
    doc.x = doc.page.margins.left;
    doc.y = yLinea + 8;
}

// ── Subtítulo de bloque dentro de una sección (ej. "A. Datos generales del
// rodeo", "Secretario", "Accidentados:"). `destacado: true` (bloques A/B/C/D
// de la página 1) agrega una franja de fondo muy suave para marcar un nivel
// jerárquico más — nunca un color fuerte, solo una banda tenue.
function subtitulo(doc, texto, { alturaMinimaContenido = 24, destacado = false } = {}) {
    asegurarEspacio(doc, 26 + alturaMinimaContenido);
    doc.moveDown(0.3);
    doc.x = doc.page.margins.left;
    const ancho = anchoUtilPagina(doc);
    if (destacado) {
        const y0 = doc.y;
        const alturaFranja = doc.fontSize(FS_SUBTITULO).font('Helvetica-Bold').heightOfString(texto, { width: ancho }) + 8;
        doc.rect(doc.page.margins.left, y0, ancho, alturaFranja).fill(FONDO_SUAVE);
        doc.fontSize(FS_SUBTITULO).fillColor(AZUL).font('Helvetica-Bold').text(texto, doc.page.margins.left + 6, y0 + 4, { width: ancho - 12 });
        doc.y = y0 + alturaFranja + 6;
    } else {
        doc.fontSize(FS_SUBTITULO).fillColor(AZUL_SUAVE).font('Helvetica-Bold').text(texto, { width: ancho });
        doc.moveDown(0.2);
    }
    doc.x = doc.page.margins.left;
}

// ── Fila de información: 1 o 2 pares {label, value} lado a lado, cada uno
// con la ETIQUETA (versalita gris, negrita) en su propia línea y el VALOR
// (tamaño de contenido) debajo — así la etiqueta nunca empuja ni desalinea
// el valor sin importar qué tan larga sea ("Teléfono (Secretario)" vs
// "RUT"), y cada columna queda alineada en la misma grilla sin más trabajo.
// `value` pasa SIEMPRE por celdaValor (nunca pierde un 0 real).
function filaInfo(doc, pares) {
    const anchoTotal = anchoUtilPagina(doc);
    const gap = 18;
    const cols = pares.length;
    const anchoCol = (anchoTotal - gap * (cols - 1)) / cols;
    const x0 = doc.page.margins.left;

    const alturas = pares.map((par) => {
        if (!par) return 0;
        const valorTexto = celdaValor(par.value);
        const hLabel = doc.fontSize(FS_LABEL).font('Helvetica-Bold').heightOfString(par.label.toUpperCase(), { width: anchoCol });
        const hValor = doc.fontSize(FS_VALOR).font('Helvetica').heightOfString(valorTexto, { width: anchoCol, lineGap: lineGap(FS_VALOR) });
        return hLabel + 2 + hValor;
    });
    const alturaFila = Math.max(...alturas, 0);
    asegurarEspacio(doc, alturaFila + 10);
    const y0 = doc.y;

    pares.forEach((par, i) => {
        if (!par) return;
        const x = x0 + i * (anchoCol + gap);
        doc.fontSize(FS_LABEL).font('Helvetica-Bold').fillColor(GRIS_LABEL)
           .text(par.label.toUpperCase(), x, y0, { width: anchoCol, characterSpacing: 0.3 });
        const yValor = doc.y + 1;
        doc.fontSize(FS_VALOR).font('Helvetica').fillColor('#1a1a1a')
           .text(celdaValor(par.value), x, yValor, { width: anchoCol, lineGap: lineGap(FS_VALOR) });
    });

    doc.x = x0;
    doc.y = y0 + alturaFila + 7; // separación vertical entre filas (moderada y uniforme)
}

// Acomoda una lista de {label, value} en filas de a 2 (o 1 si es impar al
// final) — evita tener que calcular los pares a mano en cada sección.
function filaInfoEnPares(doc, campos) {
    const visibles = campos.filter(c => c && c.value !== undefined && c.value !== null && String(c.value).trim() !== '');
    for (let i = 0; i < visibles.length; i += 2) {
        filaInfo(doc, visibles.slice(i, i + 2));
    }
}

// ── Párrafo de texto libre (observaciones extensas, relatos, sugerencias):
// etiqueta en su propia línea + el texto con interlineado cómodo,
// reservando espacio para no partir el párrafo apenas empezado en el borde
// de una página. Alineación IZQUIERDA (no justificada): en pdfkit, el
// texto justificado logra el espaciado entre palabras moviendo la posición
// del siguiente glifo (un ajuste numérico en el operador TJ) en vez de
// dibujar siempre el carácter espacio — más difícil de verificar y, para
// un informe institucional en español, el texto alineado a la izquierda
// es igual de legible y evita "ríos" de espacio desigual entre palabras.
function parrafo(doc, etiqueta, texto, { fontSize = FS_PARRAFO, sangria = false } = {}) {
    const ancho = anchoUtilPagina(doc) - (sangria ? 14 : 0);
    const x = doc.page.margins.left + (sangria ? 14 : 0);
    const textoFinal = celdaValor(texto);
    const hEtiqueta = etiqueta ? doc.fontSize(FS_LABEL).font('Helvetica-Bold').heightOfString(etiqueta.toUpperCase(), { width: ancho }) + 4 : 0;
    const hTexto = doc.fontSize(fontSize).font('Helvetica').heightOfString(textoFinal, { width: ancho, lineGap: lineGap(fontSize) });
    asegurarEspacio(doc, hEtiqueta + hTexto + 10);
    doc.x = doc.page.margins.left;
    if (etiqueta) {
        doc.fontSize(FS_LABEL).font('Helvetica-Bold').fillColor(GRIS_LABEL).text(etiqueta.toUpperCase(), x, doc.y, { width: ancho });
        doc.y += 4;
    }
    doc.fontSize(fontSize).font('Helvetica').fillColor(GRIS_TEXTO)
       .text(textoFinal, x, doc.y, { width: ancho, lineGap: lineGap(fontSize) });
    doc.x = doc.page.margins.left;
    doc.y += 8;
}

// ── Registro de lista (un ítem de una lista: reemplazo, accidentado,
// collera invitada, evento de historial...). Se calcula su altura COMPLETA
// antes de dibujar, así nunca queda partido entre dos páginas — si no entra
// completo en lo que resta de la página, pasa entero a la siguiente.
// `detalles`: [{label?, texto}] — las líneas sin `texto` se omiten (nunca
// se inventa un detalle vacío).
function registro(doc, { numero, titulo, detalles = [] }) {
    const anchoTotal = anchoUtilPagina(doc);
    const xBarra = doc.page.margins.left;
    const xTexto = xBarra + 10;
    const anchoTexto = anchoTotal - 10;
    const detallesVisibles = detalles.filter(d => d && d.texto !== undefined && d.texto !== null && String(d.texto).trim() !== '');

    const tituloCompleto = (numero != null ? numero + '. ' : '') + celdaValor(titulo);
    let altura = doc.fontSize(FS_REGISTRO_TIT).font('Helvetica-Bold').heightOfString(tituloCompleto, { width: anchoTexto });
    const alturasDetalle = detallesVisibles.map(d => {
        const txt = (d.label ? d.label + ': ' : '') + d.texto;
        return doc.fontSize(FS_REGISTRO_DET).font('Helvetica').heightOfString(txt, { width: anchoTexto - 8, lineGap: lineGap(FS_REGISTRO_DET) }) + 4;
    });
    altura += alturasDetalle.reduce((a, b) => a + b, 0) + 8;

    asegurarEspacio(doc, altura + 8);
    const y0 = doc.y;
    doc.rect(xBarra, y0, 2.4, altura - 2).fill(BARRA_SUAVE);
    doc.fontSize(FS_REGISTRO_TIT).font('Helvetica-Bold').fillColor(AZUL).text(tituloCompleto, xTexto, y0, { width: anchoTexto });
    let yDetalle = doc.y + 2;
    detallesVisibles.forEach(d => {
        const txt = (d.label ? d.label + ': ' : '') + d.texto;
        doc.fontSize(FS_REGISTRO_DET).font('Helvetica').fillColor(GRIS_TEXTO)
           .text(txt, xTexto + 8, yDetalle, { width: anchoTexto - 8, lineGap: lineGap(FS_REGISTRO_DET) });
        yDetalle = doc.y + 4;
    });

    doc.x = doc.page.margins.left;
    doc.y = y0 + altura + 7; // separación entre registros (moderada, sin perder el orden visual de lista)
}

// ── Lista vacía / aviso corto (ej. "Sin colleras invitadas: Sí") — una
// línea simple, reservando su propio espacio como cualquier otro bloque.
function lineaSimple(doc, texto, { fontSize = FS_PARRAFO, color = GRIS_TEXTO, cursiva = false } = {}) {
    const ancho = anchoUtilPagina(doc);
    const h = doc.fontSize(fontSize).font(cursiva ? 'Helvetica-Oblique' : 'Helvetica').heightOfString(texto, { width: ancho });
    asegurarEspacio(doc, h + 8);
    doc.x = doc.page.margins.left;
    doc.fontSize(fontSize).font(cursiva ? 'Helvetica-Oblique' : 'Helvetica').fillColor(color).text(texto, { width: ancho });
    doc.y += 6;
    doc.x = doc.page.margins.left;
}

// ── Nota destacada (ej. NOTA PROMEDIO del Jurado): una caja de fondo muy
// suave con una barra azul a la izquierda — resalta el resultado sin
// recurrir a colores llamativos.
function notaDestacada(doc, etiqueta, valor) {
    const ancho = anchoUtilPagina(doc);
    const alturaCaja = 32;
    asegurarEspacio(doc, alturaCaja + 12);
    const x = doc.page.margins.left, y = doc.y;
    doc.rect(x, y, ancho, alturaCaja).fill(FONDO_SUAVE);
    doc.rect(x, y, 3, alturaCaja).fill(AZUL);
    doc.fontSize(FS_LABEL).font('Helvetica-Bold').fillColor(GRIS_LABEL).text(etiqueta.toUpperCase(), x + 14, y + 9, { width: ancho - 120 });
    doc.fontSize(14).font('Helvetica-Bold').fillColor(AZUL).text(celdaValor(valor), x + ancho - 110, y + 7, { width: 96, align: 'right' });
    doc.x = x;
    doc.y = y + alturaCaja + 12;
}

// ── Pie de página consistente en TODAS las páginas (incluida la tabla de
// ganado horizontal — se dibuja dentro del margen inferior reservado, sin
// tocar ni acercarse al contenido de la tabla). Requiere `bufferPages:
// true` en el documento; se aplica una sola vez, al final, recorriendo
// todas las páginas ya generadas.
function aplicarPieDePagina(doc, textoIzquierda) {
    const rango = doc.bufferedPageRange();
    for (let i = rango.start; i < rango.start + rango.count; i++) {
        doc.switchToPage(i);
        // El pie se dibuja DENTRO del margen inferior reservado — por
        // diseño, por debajo de `page.height - margins.bottom`. pdfkit
        // chequea ese límite en CADA `.text()` y agrega una página nueva
        // automáticamente si la posición ya lo excede (así se "perdían" 13
        // páginas extra, una o dos por cada página real, cuando esto no se
        // neutralizaba). Se baja el margen a 0 solo mientras se dibuja el
        // pie de ESTA página, y se restaura enseguida — nunca afecta el
        // contenido real, que ya terminó de dibujarse antes de este punto.
        const margenInferiorOriginal = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        const y = doc.page.height - margenInferiorOriginal + 14;
        const anchoTotal = doc.page.width - doc.page.margins.left - doc.page.margins.right;
        doc.moveTo(doc.page.margins.left, y - 6).lineTo(doc.page.width - doc.page.margins.right, y - 6)
           .lineWidth(0.6).strokeColor('#dde3ec').stroke();
        doc.fontSize(7.5).font('Helvetica').fillColor(GRIS_NOTA)
           .text(textoIzquierda, doc.page.margins.left, y, { width: anchoTotal - 70, lineBreak: false });
        doc.text(`Página ${i - rango.start + 1} de ${rango.count}`, doc.page.margins.left, y, { width: anchoTotal, align: 'right', lineBreak: false });
        doc.page.margins.bottom = margenInferiorOriginal;
    }
}

module.exports = {
    AZUL, GRIS_TEXTO, GRIS_NOTA,
    encabezadoPrincipal, franjaEstado, bloqueIdentificacion, dosColumnas, nombreDestacado,
    tituloSeccion, subtitulo, filaInfo, filaInfoEnPares, parrafo, registro,
    lineaSimple, notaDestacada, aplicarPieDePagina, anchoUtilPagina,
    asegurarEspacio, limiteInferior, celdaValor
};
