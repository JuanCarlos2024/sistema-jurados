// ═════════════════════════════════════════════════════════════════════════
// Imagen PNG del gráfico comparativo de Colleras Completas (2 series: temporada
// actual vs anterior), a partir del resultado de collerasComparativa.js.
//
// Gráfico de líneas con marcadores (preferencia del pedido). Etiquetas numéricas:
// si cada serie tiene ≤12 puntos se etiquetan TODOS (Opción A); con más puntos se
// etiquetan solo el primero, el último, el máximo y el mínimo de cada serie
// (Opción B) para no recargar el gráfico — el bloque numérico de la hoja (celdas
// de Excel, texto real) siempre muestra el resumen completo sin esa limitación.
// ═════════════════════════════════════════════════════════════════════════
const { crearLienzo, fillRect, drawLine, drawCircle, drawText, anchoTexto, lienzoAPng } = require('./graficoPng');

const COLOR_ACTUAL = [30, 58, 95, 255];      // azul institucional (mismo tono que HEADER_STYLE: FF1e3a5f)
const COLOR_ANTERIOR = [196, 106, 25, 255];  // ámbar, distinguible en pantalla e impreso
const COLOR_EJE = [90, 90, 90, 255];
const COLOR_GRID = [222, 222, 222, 255];
const COLOR_FONDO = [255, 255, 255, 255];
const MAX_ETIQUETAS_TODAS = 12;

function indicesAEtiquetar(puntos) {
    if (puntos.length <= MAX_ETIQUETAS_TODAS) return puntos.map((_, i) => i);
    let iMax = 0, iMin = 0;
    puntos.forEach((p, i) => { if (p.valor > puntos[iMax].valor) iMax = i; if (p.valor < puntos[iMin].valor) iMin = i; });
    return [...new Set([0, puntos.length - 1, iMin, iMax])];
}

// comparativa: salida de construirComparativaColleras() (collerasComparativa.js). Devuelve un Buffer PNG,
// o null si no hay ningún punto que graficar (el llamador entonces omite la imagen sin romper la hoja).
function generarGraficoComparativoColleras(comparativa, { width = 900, height = 380 } = {}) {
    const serieA = (comparativa && comparativa.serie && comparativa.serie.actual && comparativa.serie.actual.puntos) || [];
    const serieB = (comparativa && comparativa.serie && comparativa.serie.anterior && comparativa.serie.anterior.puntos) || [];
    const todos = [...serieA, ...serieB];
    if (todos.length === 0) return null;

    const margen = { top: 34, right: 26, bottom: 42, left: 46 };
    const l = crearLienzo(width, height, COLOR_FONDO);
    const anchoPlot = width - margen.left - margen.right;
    const altoPlot = height - margen.top - margen.bottom;

    const xs = todos.map(p => p.x_dias);
    const ys = todos.map(p => p.valor);
    const xMin = Math.min(0, ...xs), xMax = Math.max(1, ...xs);
    const yMax = Math.max(1, ...ys);

    const px = x => margen.left + (x - xMin) / (xMax - xMin || 1) * anchoPlot;
    const py = y => margen.top + altoPlot - (y / (yMax || 1)) * altoPlot;

    // Gridlines horizontales + etiquetas del eje Y (4 divisiones)
    const DIVISIONES = 4;
    for (let i = 0; i <= DIVISIONES; i++) {
        const valor = Math.round(yMax * i / DIVISIONES);
        const y = py(valor);
        drawLine(l, margen.left, y, width - margen.right, y, COLOR_GRID, 1);
        drawText(l, 4, y - 3, String(valor), COLOR_EJE, 2);
    }
    // Ejes
    drawLine(l, margen.left, margen.top + altoPlot, width - margen.right, margen.top + altoPlot, COLOR_EJE, 2);
    drawLine(l, margen.left, margen.top, margen.left, margen.top + altoPlot, COLOR_EJE, 2);

    function dibujarSerie(puntos, color) {
        if (puntos.length === 0) return;
        for (let i = 1; i < puntos.length; i++) {
            drawLine(l, px(puntos[i - 1].x_dias), py(puntos[i - 1].valor), px(puntos[i].x_dias), py(puntos[i].valor), color, 3);
        }
        const etiquetar = new Set(indicesAEtiquetar(puntos));
        puntos.forEach((p, i) => {
            drawCircle(l, px(p.x_dias), py(p.valor), 4, color);
            if (etiquetar.has(i)) {
                const txt = String(p.valor);
                drawText(l, px(p.x_dias) - anchoTexto(txt, 2) / 2, py(p.valor) - 15, txt, color, 2);
            }
        });
    }
    dibujarSerie(serieB, COLOR_ANTERIOR);   // se dibuja primero para que la actual quede visualmente "encima"
    dibujarSerie(serieA, COLOR_ACTUAL);

    // Etiquetas del eje X (fechas dd/mm), como máximo 7, tomadas de la serie con más puntos
    const base = serieA.length >= serieB.length ? serieA : serieB;
    if (base.length) {
        const paso = Math.max(1, Math.ceil(base.length / 7));
        base.forEach((p, i) => {
            if (i % paso !== 0 && i !== base.length - 1) return;
            const txt = p.etiqueta || '';
            drawText(l, px(p.x_dias) - anchoTexto(txt, 2) / 2, margen.top + altoPlot + 8, txt, COLOR_EJE, 2);
        });
    }

    // Leyenda (esquina superior derecha): cuadro de color + nombre de temporada (solo dígitos/guion, sin acentos)
    const nombreA = comparativa.temporada_actual || '----', nombreB = comparativa.temporada_anterior || '----';
    const anchoA = anchoTexto(nombreA, 2), anchoB = anchoTexto(nombreB, 2);
    let xLeyenda = width - margen.right - 12 - anchoA - 24 - 12 - anchoB;
    if (xLeyenda < margen.left) xLeyenda = margen.left;
    fillRect(l, xLeyenda, 8, 10, 10, COLOR_ACTUAL);
    drawText(l, xLeyenda + 14, 8, nombreA, COLOR_ACTUAL, 2);
    const xB = xLeyenda + 14 + anchoA + 20;
    fillRect(l, xB, 8, 10, 10, COLOR_ANTERIOR);
    drawText(l, xB + 14, 8, nombreB, COLOR_ANTERIOR, 2);

    return lienzoAPng(l);
}

module.exports = { generarGraficoComparativoColleras, indicesAEtiquetar, COLOR_ACTUAL, COLOR_ANTERIOR };
