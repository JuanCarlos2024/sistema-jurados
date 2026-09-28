const zlib = require('zlib');
const { generarGraficoComparativoColleras, indicesAEtiquetar } = require('./graficoColleras');

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
