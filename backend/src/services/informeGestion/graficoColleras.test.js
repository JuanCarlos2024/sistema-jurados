const zlib = require('zlib');
const { generarGraficoComparativoColleras, indicesAEtiquetar, indicesUniformes } = require('./graficoColleras');

const FIRMA = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function dimensionesPng(buf) {
    const ihdr = buf.slice(16, 24);
    return { width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4) };
}

const punto = (x_dias, valor, etiqueta = '01/01') => ({ x_dias, valor, etiqueta });

describe('generarGraficoComparativoColleras', () => {
    test('sin ningún punto en ninguna serie → null (el llamador omite la imagen, no rompe la hoja)', () => {
        const comparativa = { temporada_actual: 'A', temporada_anterior: 'B', serie: { actual: { puntos: [] }, anterior: { puntos: [] } } };
        expect(generarGraficoComparativoColleras(comparativa)).toBeNull();
    });
    test('estructura faltante (sin comparativa.serie) → null, no lanza', () => {
        expect(generarGraficoComparativoColleras(null)).toBeNull();
        expect(generarGraficoComparativoColleras({})).toBeNull();
    });
    test('con puntos en ambas series: devuelve un PNG válido con las dimensiones pedidas', () => {
        const comparativa = {
            temporada_actual: '2026-2027', temporada_anterior: '2025-2026',
            serie: { actual: { puntos: [punto(0, 10), punto(10, 20), punto(20, 41)] }, anterior: { puntos: [punto(1, 8), punto(11, 18), punto(21, 34)] } }
        };
        const png = generarGraficoComparativoColleras(comparativa, { width: 300, height: 150 });
        expect(png.slice(0, 8).equals(FIRMA)).toBe(true);
        expect(dimensionesPng(png)).toEqual({ width: 300, height: 150 });
        // el PNG decodifica sin error (zlib no lanza)
        const idatStart = 8 + 8 + 13 + 4; // firma + (len+tipo) IHDR + datos IHDR + crc
        expect(() => {
            let off = 8, chunks = [];
            while (off < png.length) {
                const len = png.readUInt32BE(off), tipo = png.slice(off + 4, off + 8).toString('ascii');
                if (tipo === 'IDAT') chunks.push(png.slice(off + 8, off + 8 + len));
                off += 8 + len + 4;
            }
            zlib.inflateSync(Buffer.concat(chunks));
        }).not.toThrow();
    });
    test('solo la serie actual tiene puntos (sin histórico comparable): igual genera imagen', () => {
        const comparativa = { temporada_actual: '2026-2027', temporada_anterior: '2025-2026', serie: { actual: { puntos: [punto(0, 41)] }, anterior: { puntos: [] } } };
        expect(generarGraficoComparativoColleras(comparativa)).not.toBeNull();
    });
    test('un solo punto por serie no lanza división por cero (rango de ejes degenerado)', () => {
        const comparativa = { temporada_actual: 'A', temporada_anterior: 'B', serie: { actual: { puntos: [punto(0, 0)] }, anterior: { puntos: [punto(0, 0)] } } };
        expect(() => generarGraficoComparativoColleras(comparativa)).not.toThrow();
    });
});

// Decodifica el PNG y devuelve un helper pixel(x,y) → [r,g,b,a], para inspeccionar geometría (FASE 2.8).
function decodificar(buf) {
    const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
    let off = 8, idatChunks = [];
    while (off < buf.length) {
        const len = buf.readUInt32BE(off), tipo = buf.slice(off + 4, off + 8).toString('ascii');
        if (tipo === 'IDAT') idatChunks.push(buf.slice(off + 8, off + 8 + len));
        off += 8 + len + 4;
    }
    const raw = zlib.inflateSync(Buffer.concat(idatChunks));
    const bytesPorFila = 1 + width * 4;
    const pixel = (x, y) => { const b = y * bytesPorFila + 1 + x * 4; return [raw[b], raw[b + 1], raw[b + 2], raw[b + 3]]; };
    return { width, height, pixel };
}
const esBlanco = ([r, g, b]) => r === 255 && g === 255 && b === 255;

describe('FASE 2.8 — distribución del eje X (ajustada al rango real de los datos)', () => {
    test('canvas por defecto ahora es 900×430 (antes 900×380, más margen inferior para fechas verticales)', () => {
        const comparativa = { temporada_actual: 'A', temporada_anterior: 'B', serie: { actual: { puntos: [punto(150, 20), punto(180, 41)] }, anterior: { puntos: [] } } };
        const d = decodificar(generarGraficoComparativoColleras(comparativa));
        expect(d).toMatchObject({ width: 900, height: 430 });
    });

    test('puntos agrupados LEJOS de x_dias=0 ya no dejan un hueco vacío al inicio: hay trazo cerca del borde izquierdo del área de trazado', () => {
        // Antes (xMin forzado a 0) toda la curva quedaba comprimida en el 15-20% derecho del ancho. Ahora
        // el rango del eje X es el de los datos reales: debe haber píxeles de la serie ya en el primer
        // 20% del área de trazado (columnas cercanas al margen izquierdo, no solo al final).
        const puntos = [punto(150, 15, '10/09'), punto(160, 25, '20/09'), punto(170, 33, '30/09'), punto(180, 41, '10/10')];
        const comparativa = { temporada_actual: '2026-2027', temporada_anterior: null, serie: { actual: { puntos }, anterior: { puntos: [] } } };
        const png = generarGraficoComparativoColleras(comparativa, { width: 900, height: 430 });
        const d = decodificar(png);
        const margenIzq = 46, margenDer = 26, anchoPlot = d.width - margenIzq - margenDer;
        const columnaLimite = margenIzq + Math.round(anchoPlot * 0.2);   // primer 20% del área de trazado
        let hayTrazoTemprano = false;
        for (let x = margenIzq; x <= columnaLimite && !hayTrazoTemprano; x++) {
            for (let y = 40; y < d.height - 92; y++) {   // zona de trazado (excluye ejes/leyenda/etiquetas)
                if (!esBlanco(d.pixel(x, y)) && !(d.pixel(x, y)[0] === 222)) { hayTrazoTemprano = true; break; }
            }
        }
        expect(hayTrazoTemprano).toBe(true);
    });
});

describe('FASE 2.8 — fechas del eje X en vertical (más filas ocupadas que columnas por etiqueta)', () => {
    test('la franja inferior (debajo del eje) tiene texto distribuido en más filas que en columnas por cada marca', () => {
        const puntos = [punto(150, 15, '10/09'), punto(160, 25, '20/09'), punto(170, 33, '30/09'), punto(180, 41, '10/10')];
        const comparativa = { temporada_actual: '2026-2027', temporada_anterior: null, serie: { actual: { puntos }, anterior: { puntos: [] } } };
        const d = decodificar(generarGraficoComparativoColleras(comparativa, { width: 900, height: 430 }));
        const ejeY = 430 - 92; // margen.top(34)+altoPlot = top de la franja de etiquetas
        let filaMin = d.height, filaMax = -1, huboPixel = false;
        for (let y = ejeY; y < d.height; y++) {
            for (let x = 0; x < d.width; x++) {
                if (!esBlanco(d.pixel(x, y))) { huboPixel = true; filaMin = Math.min(filaMin, y); filaMax = Math.max(filaMax, y); }
            }
        }
        expect(huboPixel).toBe(true);
        expect(filaMax - filaMin).toBeGreaterThan(20);   // el bloque de fecha vertical ocupa varias filas (5 caracteres apilados)
    });
});

describe('indicesUniformes', () => {
    test('n ≤ max: devuelve TODOS los índices en orden', () => {
        expect(indicesUniformes(5, 7)).toEqual([0, 1, 2, 3, 4]);
    });
    test('n > max: devuelve exactamente `max` índices (o menos por colisión de redondeo), incluyendo siempre el primero y el último', () => {
        const idx = indicesUniformes(30, 7);
        expect(idx.length).toBeLessThanOrEqual(7);
        expect(idx[0]).toBe(0);
        expect(idx[idx.length - 1]).toBe(29);
        // distribución uniforme: sin dos índices consecutivos "pegados" salvo en los extremos por redondeo
        for (let i = 1; i < idx.length - 1; i++) expect(idx[i] - idx[i - 1]).toBeGreaterThan(1);
    });
    test('no genera un índice casi-duplicado pegado al último (el bug del "paso módulo" anterior)', () => {
        const idx = indicesUniformes(22, 7);   // 22 no es múltiplo exacto del paso: caso que antes daba dos marcas casi pegadas al final
        const ultimo = idx[idx.length - 1], penultimo = idx[idx.length - 2];
        expect(ultimo - penultimo).toBeGreaterThan(1);
    });
});

describe('indicesAEtiquetar (Opción A ≤12 puntos: todos · Opción B >12: extremos + mín/máx)', () => {
    test('≤12 puntos: etiqueta TODOS (Opción A)', () => {
        const puntos = Array.from({ length: 12 }, (_, i) => punto(i, i));
        expect(indicesAEtiquetar(puntos)).toEqual(puntos.map((_, i) => i));
    });
    test('>12 puntos: solo primero, último, mínimo y máximo (Opción B, sin recargar el gráfico)', () => {
        const valores = [5, 8, 3, 20, 7, 1, 9, 12, 6, 4, 11, 2, 15];   // 13 puntos
        const puntos = valores.map((v, i) => punto(i, v));
        const idx = indicesAEtiquetar(puntos);
        expect(idx.length).toBeLessThanOrEqual(4);
        expect(idx).toContain(0);                 // primero
        expect(idx).toContain(puntos.length - 1);  // último
        expect(idx).toContain(valores.indexOf(Math.max(...valores)));
        expect(idx).toContain(valores.indexOf(Math.min(...valores)));
    });
});
