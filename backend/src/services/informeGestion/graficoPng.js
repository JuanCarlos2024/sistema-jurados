// ═════════════════════════════════════════════════════════════════════════
// Lienzo de píxeles + codificador PNG MÍNIMO, sin dependencias externas.
//
// Por qué: la versión de ExcelJS instalada (4.4.0) no soporta gráficos nativos
// de Excel (`worksheet.addChart` no existe), pero sí soporta incrustar imágenes
// (`workbook.addImage` + `worksheet.addImage`, formato PNG/JPEG/GIF). Añadir una
// librería de canvas (node-canvas, chartjs-node-canvas, sharp…) implica un binario
// nativo precompilado — riesgo de despliegue para una sola función. Este módulo
// dibuja líneas/círculos/texto sobre un buffer RGBA en memoria y lo codifica como
// PNG usando solo Node core (zlib para el IDAT comprimido); es ~150 líneas,
// determinístico y 100% portable.
//
// No es un motor de gráficos genérico: solo las primitivas que necesita
// graficoColleras.js (línea, círculo relleno, rectángulo relleno, texto con una
// fuente de mapa de bits de 3×5 con dígitos y símbolos básicos).
// ═════════════════════════════════════════════════════════════════════════
const zlib = require('zlib');

// ── Lienzo RGBA ───────────────────────────────────────────────────────────
function crearLienzo(width, height, fondo = [255, 255, 255, 255]) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) data.set(fondo, i * 4);
    return { width, height, data };
}

function setPixel(l, x, y, [r, g, b, a = 255]) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= l.width || y >= l.height) return;
    const i = (y * l.width + x) * 4;
    if (a >= 255) { l.data[i] = r; l.data[i + 1] = g; l.data[i + 2] = b; l.data[i + 3] = 255; return; }
    const ia = a / 255;
    l.data[i] = Math.round(r * ia + l.data[i] * (1 - ia));
    l.data[i + 1] = Math.round(g * ia + l.data[i + 1] * (1 - ia));
    l.data[i + 2] = Math.round(b * ia + l.data[i + 2] * (1 - ia));
    l.data[i + 3] = 255;
}

function fillRect(l, x0, y0, w, h, color) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPixel(l, x, y, color);
}

// Bresenham con grosor (offset cuadrado alrededor de cada punto del trazo).
function drawLine(l, x0, y0, x1, y1, color, grosor = 1) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    const mitad = Math.floor(grosor / 2);
    while (true) {
        for (let ox = -mitad; ox <= mitad; ox++) for (let oy = -mitad; oy <= mitad; oy++) setPixel(l, x0 + ox, y0 + oy, color);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
    }
}

function drawCircle(l, cx, cy, r, color) {
    cx = Math.round(cx); cy = Math.round(cy);
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) setPixel(l, cx + x, cy + y, color);
}

// ── Fuente de mapa de bits 3×5 (solo lo que necesita el gráfico: dígitos y símbolos) ──
const GLIFOS = {
    '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'],
    '2': ['111', '001', '111', '100', '111'], '3': ['111', '001', '111', '001', '111'],
    '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
    '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '010', '010', '010'],
    '8': ['111', '101', '111', '101', '111'], '9': ['111', '101', '111', '001', '111'],
    '-': ['000', '000', '111', '000', '000'], '/': ['001', '001', '010', '100', '100'],
    '.': ['000', '000', '000', '000', '010'], ',': ['000', '000', '000', '010', '100'],
    '%': ['101', '001', '010', '100', '101'], '+': ['000', '010', '111', '010', '000'],
    ' ': ['000', '000', '000', '000', '000']
};
const ANCHO_GLIFO = 3, ALTO_GLIFO = 5;

// Dibuja texto (solo caracteres soportados; uno no soportado se omite en vez de romper el gráfico).
function drawText(l, x, y, texto, color, escala = 2, espaciado = 1) {
    let cx = x;
    for (const ch of String(texto)) {
        const glifo = GLIFOS[ch];
        if (glifo) {
            for (let fy = 0; fy < ALTO_GLIFO; fy++) for (let fx = 0; fx < ANCHO_GLIFO; fx++) {
                if (glifo[fy][fx] === '1') fillRect(l, cx + fx * escala, y + fy * escala, escala, escala, color);
            }
        }
        cx += (ANCHO_GLIFO * escala) + espaciado;
    }
    return cx - x; // ancho total dibujado, por si el llamador necesita centrar
}
function anchoTexto(texto, escala = 2, espaciado = 1) { return String(texto).length * ((ANCHO_GLIFO * escala) + espaciado) - espaciado; }

// Rota una matriz de '1'/'0' (array de strings) 90° en sentido horario: una grilla de nf filas × nc
// columnas queda de nc filas × nf columnas, con out[c][nf-1-r] = filas[r][c] (fórmula estándar de rotación
// de matrices). Se usa para las etiquetas verticales del eje X (FASE 2.8).
function rotarGlifoCW(filas) {
    const nf = filas.length, nc = filas[0].length;
    const out = Array.from({ length: nc }, () => new Array(nf).fill('0'));
    for (let r = 0; r < nf; r++) for (let c = 0; c < nc; c++) out[c][nf - 1 - r] = filas[r][c];
    return out.map(a => a.join(''));
}

// Texto en VERTICAL: cada carácter se dibuja rotado 90° en sentido horario (como al girar físicamente una
// tira de texto horizontal) y se apilan hacia abajo en el mismo orden — se lee inclinando la cabeza hacia
// la derecha. Evita que las etiquetas de fecha del eje X se monten entre sí (FASE 2.8). `x,y` = esquina
// superior izquierda del bloque de texto (mismo punto de referencia que drawText).
function drawTextVertical(l, x, y, texto, color, escala = 2, espaciado = 1) {
    let cy = y;
    for (const ch of String(texto)) {
        const glifo = GLIFOS[ch];
        if (glifo) {
            const rot = rotarGlifoCW(glifo);   // ANCHO_GLIFO filas × ALTO_GLIFO columnas (dimensiones intercambiadas)
            for (let fy = 0; fy < rot.length; fy++) for (let fx = 0; fx < rot[fy].length; fx++) {
                if (rot[fy][fx] === '1') fillRect(l, x + fx * escala, cy + fy * escala, escala, escala, color);
            }
        }
        cy += (ANCHO_GLIFO * escala) + espaciado;   // avanza el ancho original del glifo (= alto tras rotar)
    }
    return cy - y; // alto total dibujado
}
// Alto/ancho del bloque de texto vertical (para centrarlo respecto de una marca del eje).
function altoTextoVertical(texto, escala = 2, espaciado = 1) { return String(texto).length * ((ANCHO_GLIFO * escala) + espaciado) - espaciado; }
function anchoTextoVertical(escala = 2) { return ALTO_GLIFO * escala; }

// ── Codificador PNG (RGBA 8 bits, filtro "None", IDAT via zlib.deflateSync) ──
const FIRMA_PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let TABLA_CRC = null;
function crc32(buf) {
    if (!TABLA_CRC) {
        TABLA_CRC = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            TABLA_CRC[n] = c >>> 0;
        }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = TABLA_CRC[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunkPng(tipo, datos) {
    const len = Buffer.alloc(4); len.writeUInt32BE(datos.length, 0);
    const tipoBuf = Buffer.from(tipo, 'ascii');
    const cuerpo = Buffer.concat([tipoBuf, datos]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(cuerpo), 0);
    return Buffer.concat([len, cuerpo, crc]);
}

function lienzoAPng(l) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(l.width, 0);
    ihdr.writeUInt32BE(l.height, 4);
    ihdr[8] = 8;  // profundidad 8 bits/canal
    ihdr[9] = 6;  // tipo de color: RGBA
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    const bytesPorFila = l.width * 4;
    const raw = Buffer.alloc(l.height * (1 + bytesPorFila));
    const pixBuf = Buffer.from(l.data.buffer, l.data.byteOffset, l.data.byteLength);
    for (let y = 0; y < l.height; y++) {
        const inicio = y * (1 + bytesPorFila);
        raw[inicio] = 0; // filtro "None"
        pixBuf.copy(raw, inicio + 1, y * bytesPorFila, (y + 1) * bytesPorFila);
    }
    const idatDatos = zlib.deflateSync(raw, { level: 9 });
    return Buffer.concat([
        FIRMA_PNG,
        chunkPng('IHDR', ihdr),
        chunkPng('IDAT', idatDatos),
        chunkPng('IEND', Buffer.alloc(0))
    ]);
}

module.exports = {
    crearLienzo, setPixel, fillRect, drawLine, drawCircle, drawText, anchoTexto,
    rotarGlifoCW, drawTextVertical, altoTextoVertical, anchoTextoVertical,
    lienzoAPng
};
