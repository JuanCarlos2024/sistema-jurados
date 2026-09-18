// ─────────────────────────────────────────────────────────────────────────
// Colleras Completas — consulta en vivo a la fuente externa pública de la
// Federación (gestionderodeos.cl), usada exclusivamente por la Hoja 2 del
// Reporte Directorio (reporte-deportivo.js: GET /export-directorio).
//
// La URL está FIJA aquí, nunca proviene del frontend (evita SSRF/proxy).
// GET público, sin cookies/tokens del Sistema de Jurados.
// ─────────────────────────────────────────────────────────────────────────
const cheerio = require('cheerio');

const URL_COLLERAS_COMPLETAS = 'https://gestionderodeos.cl/rodeo/reportes/index.php?inc=cc';
const TIMEOUT_MS = 15000;

// Prefijos SIN tilde (solo para validar que la columna está presente): la
// página de origen mezcla codificaciones dentro del mismo documento — el
// texto estático de esta fila de encabezado viaja en UTF-8 aunque la página
// declara iso-8859-1, mientras que el resto del contenido (datos dinámicos)
// sí es iso-8859-1 real. Comparar por el prefijo sin acento evita depender
// de qué codificación tomó ese fragmento puntual, sin tocar los datos.
const COLUMNAS_ESPERADAS = ['CABALLO 1', 'CABALLO 2', 'PTJ', 'JINETES', 'ZONA', 'ASOCIACI', 'ZONA CLASIF'];

// Decodifica el body según el charset que el propio servidor declara (header
// Content-Type, con el <meta charset> del HTML como respaldo). La página
// declara iso-8859-1: cada byte 0x00-0xFF se mapea 1:1 a su code point
// Unicode — exactamente lo que hace el encoding 'latin1' de Buffer en Node.
// No hay reemplazos de texto hardcodeados por nombre.
function decodificarBody(buffer, contentTypeHeader) {
    let charset = null;
    const mHeader = /charset\s*=\s*["']?\s*([\w-]+)/i.exec(contentTypeHeader || '');
    if (mHeader) charset = mHeader[1].toLowerCase();

    if (!charset) {
        const previo = buffer.toString('latin1');
        const mMeta = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(previo);
        if (mMeta) charset = mMeta[1].toLowerCase();
    }

    if (charset && (charset.includes('utf-8') || charset.includes('utf8'))) {
        return buffer.toString('utf8');
    }
    // iso-8859-1 / latin1 / windows-1252 u otro no reconocido → latin1 (mapeo seguro 1 byte = 1 code point)
    return buffer.toString('latin1');
}

// Convierte el contenido de una celda preservando <br> como salto de línea
// (varias celdas de la fuente — JINETES, ASOCIACIÓN, ZONA — pueden traer más
// de un valor separado por <br> dentro de la misma celda; se conservan en la
// MISMA celda de Excel, nunca se generan filas nuevas).
function textoCelda($, el) {
    const html = ($(el).html() || '').replace(/<br\s*\/?>/gi, '\n');
    const texto = cheerio.load(`<div>${html}</div>`)('div').text();
    return texto
        .replace(/ /g, ' ')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
        .join('\n');
}

function parseResumen($) {
    const resumen = {
        totalCompletas: null, zonaNorte: null, zonaCentro: null, zonaSur: null,
        centroNorte: null, centroSur: null
    };

    const fieldset = $('fieldset').filter((_, fs) => /resumen\s+reporte/i.test($(fs).find('legend').text())).first();
    const scope = fieldset.length ? fieldset : $.root();

    scope.find('tr').each((_, tr) => {
        const celdas = $(tr).find('td');
        for (let i = 0; i < celdas.length - 1; i += 2) {
            const label = $(celdas[i]).text().replace(/ /g, ' ').trim();
            const valorTxt = $(celdas[i + 1]).text().replace(/ /g, ' ').trim();
            const valor = /^\d+$/.test(valorTxt) ? parseInt(valorTxt, 10) : (valorTxt || null);
            if (!label) continue;
            if (/TOTAL\s+DE\s+COLLERAS\s+COMPLETAS/i.test(label))       resumen.totalCompletas = valor;
            else if (/TOTAL\s+DE\s+COLLERAS\s+ZONA\s+NORTE/i.test(label)) resumen.zonaNorte = valor;
            else if (/TOTAL\s+DE\s+COLLERAS\s+ZONA\s+CENTRO/i.test(label)) resumen.zonaCentro = valor;
            else if (/TOTAL\s+DE\s+COLLERAS\s+ZONA\s+SUR/i.test(label))   resumen.zonaSur = valor;
            else if (/^COLLERAS\s+CENTRO\s+NORTE/i.test(label))          resumen.centroNorte = valor;
            else if (/^COLLERAS\s+CENTRO\s+SUR/i.test(label))            resumen.centroSur = valor;
        }
    });

    return resumen;
}

async function obtenerCollerasCompletas() {
    let resp;
    try {
        resp = await fetch(URL_COLLERAS_COMPLETAS, {
            method: 'GET',
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch (e) {
        const motivo = e.name === 'TimeoutError' || e.name === 'AbortError'
            ? `tiempo de espera agotado (${TIMEOUT_MS / 1000}s)`
            : (e.message || 'error de red');
        throw new Error(`No se pudo conectar con la fuente externa de Colleras Completas (${motivo}).`);
    }

    if (!resp.ok) {
        throw new Error(`La fuente externa de Colleras Completas respondió con estado HTTP ${resp.status}.`);
    }

    const contentType = resp.headers.get('content-type') || '';
    const buffer = Buffer.from(await resp.arrayBuffer());
    const html = decodificarBody(buffer, contentType);

    const $ = cheerio.load(html);

    // Localizar la tabla que contiene el encabezado "CABALLO 1" (el resumen
    // y la tabla de colleras están anidados dentro del mismo <table> externo
    // en el HTML de origen, por eso se busca en TODO el texto de la tabla,
    // no solo en su primera fila).
    let tablaData = null;
    $('table').each((_, table) => {
        if (tablaData) return;
        if (/CABALLO\s*1/i.test($(table).text())) tablaData = table;
    });
    if (!tablaData) {
        throw new Error('No fue posible ubicar la tabla de "Colleras Completas" en la página externa (estructura inesperada).');
    }

    // La fila de encabezado es la que contiene "CABALLO 1" con ~10 celdas;
    // las filas de datos son todas las siguientes con exactamente 10 <td>
    // (esto excluye automáticamente la fila/tabla de "Resumen reporte",
    // que está anidada más arriba con una cantidad de celdas distinta).
    const filasTr = $(tablaData).find('tr').toArray();
    const idxHeader = filasTr.findIndex(tr => /CABALLO\s*1/i.test($(tr).text()) && $(tr).find('td,th').length >= 8);
    if (idxHeader === -1) {
        throw new Error('No fue posible ubicar la fila de encabezado de "Colleras Completas" (estructura inesperada).');
    }

    const encabezados = $(filasTr[idxHeader]).find('td,th').map((_, td) => textoCelda($, td)).get();
    const encabezadosTexto = encabezados.join(' | ').toUpperCase();
    const faltantes = COLUMNAS_ESPERADAS.filter(col => !encabezadosTexto.includes(col));
    if (faltantes.length > 0) {
        throw new Error(`Los encabezados de "Colleras Completas" no son los esperados (faltan: ${faltantes.join(', ')}).`);
    }

    const filas = [];
    for (let i = idxHeader + 1; i < filasTr.length; i++) {
        const celdas = $(filasTr[i]).find('td');
        if (celdas.length !== 10) continue; // ignora filas que no son de datos (ej. separadores)
        const valores = celdas.map((_, td) => textoCelda($, td)).get();
        filas.push({
            caballo1:    valores[0],
            caballo2:    valores[1],
            sexoCriadero: valores[2],
            ptj:         /^\d+$/.test(valores[3]) ? parseInt(valores[3], 10) : valores[3],
            r:           valores[4],
            c:           valores[5],
            jinetes:     valores[6],
            zona:        valores[7],
            asociacion:  valores[8],
            zonaClasif:  valores[9]
        });
    }

    if (filas.length === 0) {
        throw new Error('No se encontraron filas de datos en la tabla de "Colleras Completas".');
    }

    const resumen = parseResumen($);

    return { resumen, filas };
}

module.exports = { obtenerCollerasCompletas, URL_COLLERAS_COMPLETAS };
