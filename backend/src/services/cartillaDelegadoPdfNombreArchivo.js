// ═════════════════════════════════════════════════════════════════════════
// cartillaDelegadoPdfNombreArchivo.js — nombre ÚNICO y testeable del archivo
// PDF de la Cartilla del Delegado: `ASOCIACION_CLUB_FECHA.pdf` (histórico:
// `..._V{n}.pdf`). Antes el nombre vivía hardcodeado y por separado en el
// backend (routes/admin/cartillas-delegado.js, ignorando la asociación y
// truncando el club a 30 caracteres) y en el frontend (`api.descargar(...,
// 'cartilla-delegado.pdf')`, un nombre fijo que ignoraba ambos). Esta es la
// ÚNICA fuente de verdad en el backend — reusada por GET /:id/pdf (versión
// viva, sin sufijo de versión) y GET /version/:version_id/pdf (versión
// histórica, con `_V{numero_version}`).
// ═════════════════════════════════════════════════════════════════════════

// Quita tildes/diacríticos, pasa a mayúsculas y reemplaza cualquier
// secuencia de caracteres no alfanuméricos por un único guion — nunca
// trunca (el pedido explícito es "conservar nombres completos").
function normalizarSegmentoNombreArchivo(texto) {
    const base = (texto === undefined || texto === null) ? '' : String(texto).trim();
    if (!base) return '';
    return base
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// Acepta 'YYYY-MM-DD' o un timestamp ISO completo ('YYYY-MM-DDTHH:mm:ssZ') —
// siempre se queda con la parte de fecha, estable y sin zona horaria.
function normalizarFechaNombreArchivo(fecha) {
    if (!fecha) return 'SIN-FECHA';
    const texto = String(fecha);
    const soloFecha = texto.includes('T') ? texto.split('T')[0] : texto.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(soloFecha) ? soloFecha : 'SIN-FECHA';
}

/**
 * @param {object} datos
 * @param {string} [datos.asociacion]
 * @param {string} [datos.club]
 * @param {string|null} [datos.fecha] - 'YYYY-MM-DD' o timestamp ISO.
 * @param {number|string|null} [datos.version] - numero_version de
 *   cartillas_delegado_versiones. Si se pasa, agrega el sufijo `_V{n}`
 *   (documento histórico); si se omite, es la versión viva de la cartilla.
 * @returns {string} 'ASOCIACION_CLUB_FECHA.pdf' o '..._V2.pdf'
 */
function construirNombreArchivoCartillaDelegadoPdf({ asociacion, club, fecha, version } = {}) {
    const asociacionSlug = normalizarSegmentoNombreArchivo(asociacion) || 'ASOCIACION';
    const clubSlug = normalizarSegmentoNombreArchivo(club) || 'CLUB';
    const fechaSlug = normalizarFechaNombreArchivo(fecha);
    const sufijoVersion = (version !== undefined && version !== null && version !== '') ? `_V${version}` : '';
    return `${asociacionSlug}_${clubSlug}_${fechaSlug}${sufijoVersion}.pdf`;
}

module.exports = {
    construirNombreArchivoCartillaDelegadoPdf,
    normalizarSegmentoNombreArchivo,
    normalizarFechaNombreArchivo
};
