// ═════════════════════════════════════════════════════════════════════════
// cartillaDelegadoPdfTabla.js — dibuja tablas reales (encabezado azul
// oscuro, bordes visibles, columnas alineadas) sobre un `doc` de pdfkit,
// replicando la estructura de la vista previa HTML (frontend/admin/
// rodeos.html:renderSeriesGanadoModal). Antes la sección "Información de
// las Series e Informe del Ganado" del PDF convertía cada animal en un
// párrafo largo con campos separados por "|" — ilegible frente a la vista
// previa, que ya mostraba tablas. Este archivo es infraestructura de dibujo
// pura (no conoce la forma de `ganado_series`): nunca corta una fila entre
// páginas y repite el encabezado si una tabla continúa en otra página.
// ═════════════════════════════════════════════════════════════════════════

const PAD_X = 4;
const PAD_Y = 4;
const ALTURA_MIN_FILA = 16;

// Único criterio para mostrar un valor de celda: '—' SOLO para null/
// undefined/'' (tras recortar espacios) — un 0 válido (ej. "Repetido: 0",
// "Bajo/sobrepeso: 0") NUNCA se confunde con ausencia de información. Mismo
// criterio que la vista previa HTML usa en su `val()`.
function celdaValor(v) {
    if (v === undefined || v === null) return '—';
    const texto = String(v);
    return texto.trim() === '' ? '—' : texto;
}

function limiteInferior(doc) {
    return doc.page.height - doc.page.margins.bottom;
}

// Si lo que sigue (título, resumen, etc.) no entra en el espacio restante
// de la página actual, salta de página ANTES de dibujarlo — nunca lo
// empieza y lo corta a la mitad.
function asegurarEspacio(doc, alturaNecesaria, paginaOpciones) {
    if (doc.y + alturaNecesaria > limiteInferior(doc)) {
        doc.addPage(paginaOpciones);
    }
}

function alturaTexto(doc, texto, ancho, fontSize, font) {
    doc.fontSize(fontSize).font(font);
    return doc.heightOfString(String(texto), { width: ancho });
}

function alturaFila(doc, columnas, valores, fontSize, font) {
    let max = ALTURA_MIN_FILA - 2 * PAD_Y;
    columnas.forEach((col, i) => {
        const h = alturaTexto(doc, valores[i], col.width - 2 * PAD_X, fontSize, font);
        if (h > max) max = h;
    });
    return max + 2 * PAD_Y;
}

function dibujarEncabezadoTabla(doc, columnas, x, y, { headerColor, headerTextColor, fontSize }) {
    const altura = alturaFila(doc, columnas, columnas.map(c => c.header), fontSize, 'Helvetica-Bold');
    let cx = x;
    columnas.forEach(col => {
        doc.rect(cx, y, col.width, altura).fillAndStroke(headerColor, headerColor);
        doc.fontSize(fontSize).font('Helvetica-Bold').fillColor(headerTextColor)
           .text(col.header, cx + PAD_X, y + PAD_Y, { width: col.width - 2 * PAD_X, align: col.align || 'center' });
        cx += col.width;
    });
    doc.fillColor('#222').font('Helvetica');
    return altura;
}

/**
 * Dibuja una tabla con encabezado azul oscuro y bordes visibles en todas
 * las celdas, manejando el salto de página: antes de dibujar cada fila
 * comprueba si entra completa en el espacio restante; si no, salta de
 * página (con las MISMAS opciones de página — tamaño/orientación/margen —
 * usadas para la página actual) y repite el encabezado ahí. Nunca corta una
 * fila a la mitad.
 *
 * @param {object} opciones
 * @param {{header:string, width:number, align?:string}[]} opciones.columnas
 * @param {string[][]} opciones.filas - valores YA formateados (ver celdaValor)
 * @param {object} opciones.paginaOpciones - {size, layout, margin} de la
 *   página actual — se reutiliza tal cual si la tabla necesita una página
 *   nueva, para no romper la orientación/márgenes a mitad de tabla.
 * @param {number} [opciones.fontSize=8]
 * @param {string} [opciones.headerColor='#1a3c6e'] - azul oscuro, igual que
 *   la vista previa HTML.
 * @param {string} [opciones.headerTextColor='#ffffff']
 * @returns {number} la posición Y final (también queda en `doc.y`).
 */
function dibujarTabla(doc, { columnas, filas, paginaOpciones, fontSize = 8, headerColor = '#1a3c6e', headerTextColor = '#ffffff' }) {
    const x = doc.page.margins.left;
    let y = doc.y;
    const opcionesEncabezado = { headerColor, headerTextColor, fontSize: Math.max(fontSize, 7.5) };

    y += dibujarEncabezadoTabla(doc, columnas, x, y, opcionesEncabezado);

    filas.forEach(fila => {
        const alturaFilaActual = alturaFila(doc, columnas, fila, fontSize, 'Helvetica');
        if (y + alturaFilaActual > limiteInferior(doc)) {
            doc.addPage(paginaOpciones);
            y = doc.page.margins.top;
            y += dibujarEncabezadoTabla(doc, columnas, x, y, opcionesEncabezado);
        }
        let cx = x;
        columnas.forEach((col, i) => {
            doc.rect(cx, y, col.width, alturaFilaActual).stroke('#8ba0bf');
            doc.fontSize(fontSize).font('Helvetica').fillColor('#222')
               .text(fila[i], cx + PAD_X, y + PAD_Y, { width: col.width - 2 * PAD_X, align: col.align || 'left' });
            cx += col.width;
        });
        y += alturaFilaActual;
    });

    doc.x = x;
    doc.y = y;
    return y;
}

module.exports = { celdaValor, dibujarTabla, asegurarEspacio, limiteInferior };
