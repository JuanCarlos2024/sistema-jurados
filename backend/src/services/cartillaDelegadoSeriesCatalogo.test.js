// ═════════════════════════════════════════════════════════════════════════
// Test del catálogo oficial de Series (4ª revisión, punto 4) — verifica que
// `CATALOGO_SERIES_DELEGADO`, declarado dentro del <script> de
// frontend/usuario/cartilla-delegado.html, contenga EXACTAMENTE la lista
// pedida (mismos nombres, abreviaciones, mayúsculas/minúsculas, puntos y
// guiones — ni un valor de más ni de menos). El catálogo es específico de
// Cartilla de Delegado, no un catálogo global del sistema, por eso se
// verifica leyendo directamente el HTML en vez de un módulo compartido.
// Se extrae SOLO la declaración del arreglo (sin ejecutar el resto del
// script, que depende del DOM) para no requerir un entorno jsdom.
// ═════════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const path = require('path');

const RUTA_HTML = path.join(__dirname, '..', '..', '..', 'frontend', 'usuario', 'cartilla-delegado.html');

function extraerCatalogoSeries() {
    const html = fs.readFileSync(RUTA_HTML, 'utf8');
    const match = html.match(/const CATALOGO_SERIES_DELEGADO = \[([\s\S]*?)\];/);
    if (!match) throw new Error('No se encontró CATALOGO_SERIES_DELEGADO en cartilla-delegado.html');
    // eslint-disable-next-line no-eval
    return eval('[' + match[1] + ']');
}

const LISTA_OFICIAL = [
    '10a. Libre', '1ra. Libre', '1ra. Libre A', '1ra. Libre B',
    '2a. Libre', '2a. Libre A', '2a. Libre B',
    '3ra. Libre', '3ra. Libre A', '3ra. Libre B',
    '4a. Libre', '5a. Libre', '6a. Libre', '7a. Libre', '8a. Libre', '9a. Libre',
    'Caballos', 'Criaderos', 'Expositores', 'Menores', 'Mixta', 'Mixta-Criaderos', 'Potros', 'Yeguas'
];

describe('CATALOGO_SERIES_DELEGADO — lista oficial exacta (4ª revisión, punto 4)', () => {
    test('contiene EXACTAMENTE los 24 valores pedidos, en el mismo orden, sin agregar "Primera libre A/B/C" ni otros nombres antiguos', () => {
        const catalogo = extraerCatalogoSeries();
        expect(catalogo).toEqual(LISTA_OFICIAL);
    });

    test('no contiene ninguno de los nombres antiguos retirados', () => {
        const catalogo = extraerCatalogoSeries();
        ['Primera libre A', 'Primera libre B', 'Primera libre C', 'Serie criaderos', 'Serie yeguas', 'Serie caballos jóvenes', 'Serie campeones', 'Serie apertura']
            .forEach(nombreAntiguo => expect(catalogo).not.toContain(nombreAntiguo));
    });

    test('el datalist obsoleto de sugerencias libres ya no existe en el archivo', () => {
        const html = fs.readFileSync(RUTA_HTML, 'utf8');
        expect(html).not.toMatch(/series-sugeridas/);
    });
});
