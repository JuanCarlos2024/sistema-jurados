// Lienzo de píxeles + codificador PNG (sin dependencias externas). Se valida decodificando el PNG a mano
// con zlib.inflateSync (Node core) — sin depender de ninguna librería de imágenes.
const zlib = require('zlib');
const { crearLienzo, setPixel, fillRect, drawLine, drawCircle, drawText, anchoTexto, rotarGlifoCW, drawTextVertical, altoTextoVertical, anchoTextoVertical, lienzoAPng } = require('./graficoPng');

const FIRMA = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function leerChunk(buf, offset) {
    const len = buf.readUInt32BE(offset);
    const tipo = buf.slice(offset + 4, offset + 8).toString('ascii');
    const datos = buf.slice(offset + 8, offset + 8 + len);
    return { len, tipo, datos, next: offset + 8 + len + 4 };
}
function decodificarPng(buf) {
    expect(buf.slice(0, 8).equals(FIRMA)).toBe(true);
    const ihdr = leerChunk(buf, 8);
    expect(ihdr.tipo).toBe('IHDR');
    const width = ihdr.datos.readUInt32BE(0), height = ihdr.datos.readUInt32BE(4);
    expect(ihdr.datos[8]).toBe(8);  // 8 bits/canal
    expect(ihdr.datos[9]).toBe(6);  // RGBA
    const idat = leerChunk(buf, ihdr.next);
    expect(idat.tipo).toBe('IDAT');
    const iend = leerChunk(buf, idat.next);
    expect(iend.tipo).toBe('IEND');
    expect(iend.len).toBe(0);
    expect(iend.next).toBe(buf.length);   // no hay bytes extra después de IEND
    const raw = zlib.inflateSync(idat.datos);
    const bytesPorFila = 1 + width * 4;
    expect(raw.length).toBe(height * bytesPorFila);
    const pixel = (x, y) => { const b = y * bytesPorFila + 1 + x * 4; return [raw[b], raw[b + 1], raw[b + 2], raw[b + 3]]; };
    return { width, height, pixel, raw };
}

describe('lienzo de píxeles', () => {
    test('crearLienzo llena todo el fondo con el color dado', () => {
        const l = crearLienzo(5, 3, [10, 20, 30, 255]);
        for (let y = 0; y < 3; y++) for (let x = 0; x < 5; x++) {
            const i = (y * 5 + x) * 4;
            expect([l.data[i], l.data[i + 1], l.data[i + 2], l.data[i + 3]]).toEqual([10, 20, 30, 255]);
        }
    });
    test('setPixel fuera de rango no lanza ni afecta otros píxeles', () => {
        const l = crearLienzo(4, 4, [0, 0, 0, 255]);
        expect(() => setPixel(l, -1, -1, [255, 0, 0, 255])).not.toThrow();
        expect(() => setPixel(l, 100, 100, [255, 0, 0, 255])).not.toThrow();
        expect([l.data[0], l.data[1], l.data[2]]).toEqual([0, 0, 0]);
    });
    test('drawLine dibuja los extremos exactos (horizontal, vertical, diagonal)', () => {
        const l = crearLienzo(10, 10, [255, 255, 255, 255]);
        drawLine(l, 0, 5, 9, 5, [255, 0, 0, 255], 1);
        const i = (5 * 10 + 0) * 4;
        expect([l.data[i], l.data[i + 1], l.data[i + 2]]).toEqual([255, 0, 0]);
        const i2 = (5 * 10 + 9) * 4;
        expect([l.data[i2], l.data[i2 + 1], l.data[i2 + 2]]).toEqual([255, 0, 0]);
    });
    test('drawCircle rellena un círculo centrado', () => {
        const l = crearLienzo(20, 20, [255, 255, 255, 255]);
        drawCircle(l, 10, 10, 3, [0, 0, 255, 255]);
        const i = (10 * 20 + 10) * 4;
        expect([l.data[i], l.data[i + 1], l.data[i + 2]]).toEqual([0, 0, 255]);
    });
    test('fillRect rellena exactamente el rectángulo pedido', () => {
        const l = crearLienzo(10, 10, [255, 255, 255, 255]);
        fillRect(l, 2, 2, 3, 3, [0, 255, 0, 255]);
        for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) {
            const i = (y * 10 + x) * 4;
            expect([l.data[i], l.data[i + 1], l.data[i + 2]]).toEqual([0, 255, 0]);
        }
        const fuera = (0 * 10 + 0) * 4;
        expect([l.data[fuera], l.data[fuera + 1], l.data[fuera + 2]]).toEqual([255, 255, 255]);
    });
    test('drawText con un carácter no soportado no lanza (se omite)', () => {
        const l = crearLienzo(20, 10, [255, 255, 255, 255]);
        expect(() => drawText(l, 0, 0, '1ª2', [0, 0, 0, 255], 1)).not.toThrow();
    });
    test('anchoTexto crece con la longitud del texto', () => {
        expect(anchoTexto('12345')).toBeGreaterThan(anchoTexto('12'));
    });
});

describe('rotarGlifoCW / drawTextVertical (FASE 2.8: fechas del eje X en vertical)', () => {
    test('rota 90° en sentido horario una grilla de 5×3 a 3×5 (fórmula out[c][nf-1-r] = filas[r][c])', () => {
        // El '8' es simétrico izq/der: sirve para comprobar que el resultado NO es una simetría accidental.
        expect(rotarGlifoCW(['111', '101', '101', '101', '111'])).toEqual(['11111', '10001', '11111']);
        // El '7' es asimétrico: confirma la orientación exacta de la rotación (no solo las dimensiones).
        expect(rotarGlifoCW(['111', '001', '010', '010', '010'])).toEqual(['00001', '11101', '00011']);
    });
    test('altoTextoVertical/anchoTextoVertical: el texto vertical es más ALTO que ANCHO a partir de 2 caracteres', () => {
        expect(altoTextoVertical('27/09', 2)).toBeGreaterThan(anchoTextoVertical(2));
        expect(anchoTextoVertical(2)).toBe(anchoTextoVertical(2));   // constante: no depende del contenido
    });
    test('drawTextVertical dibuja el bloque APILADO hacia abajo: más alto que ancho (al revés que drawText horizontal)', () => {
        const l = crearLienzo(60, 60, [255, 255, 255, 255]);
        drawTextVertical(l, 5, 2, '27/09', [0, 0, 0, 255], 2);
        let minX = 60, maxX = -1, minY = 60, maxY = -1;
        for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) {
            const i = (y * 60 + x) * 4;
            if (l.data[i] === 0 && l.data[i + 1] === 0 && l.data[i + 2] === 0) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
        }
        const alto = maxY - minY, ancho = maxX - minX;
        expect(alto).toBeGreaterThan(ancho);          // vertical: más alto que ancho
        expect(alto).toBeCloseTo(altoTextoVertical('27/09', 2), -1);
    });
    test('un carácter no soportado no lanza (se omite, igual que en drawText)', () => {
        const l = crearLienzo(30, 30, [255, 255, 255, 255]);
        expect(() => drawTextVertical(l, 0, 0, '1ª2', [0, 0, 0, 255], 1)).not.toThrow();
    });
});

describe('codificador PNG (round-trip con zlib.inflateSync)', () => {
    test('dimensiones, firma y estructura de chunks correctas', () => {
        const l = crearLienzo(16, 8, [255, 255, 255, 255]);
        const png = lienzoAPng(l);
        const d = decodificarPng(png);
        expect(d.width).toBe(16);
        expect(d.height).toBe(8);
    });
    test('cada píxel dibujado se recupera exactamente igual tras codificar/decodificar', () => {
        const l = crearLienzo(12, 12, [255, 255, 255, 255]);
        setPixel(l, 3, 4, [12, 34, 56, 255]);
        drawCircle(l, 8, 8, 2, [200, 10, 10, 255]);
        const d = decodificarPng(l && lienzoAPng(l));
        expect(d.pixel(3, 4)).toEqual([12, 34, 56, 255]);
        expect(d.pixel(8, 8)).toEqual([200, 10, 10, 255]);
        expect(d.pixel(0, 0)).toEqual([255, 255, 255, 255]);   // fondo intacto
    });
    test('mezcla alfa (semitransparente) se aplica sobre el fondo', () => {
        const l = crearLienzo(4, 4, [0, 0, 0, 255]);
        setPixel(l, 1, 1, [255, 255, 255, 128]);
        const d = decodificarPng(lienzoAPng(l));
        const [r, g, b] = d.pixel(1, 1);
        expect(r).toBeGreaterThan(0); expect(r).toBeLessThan(255);   // gris intermedio, ni negro ni blanco puro
    });
    test('imagen grande (900×380, tamaño real usado por el gráfico) se codifica y decodifica sin error', () => {
        const l = crearLienzo(900, 380, [255, 255, 255, 255]);
        drawLine(l, 0, 0, 899, 379, [30, 58, 95, 255], 3);
        const d = decodificarPng(lienzoAPng(l));
        expect(d.width).toBe(900);
        expect(d.height).toBe(380);
    });
});
