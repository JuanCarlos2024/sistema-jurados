// ─── Clasificación de un jurado para el diagnóstico de datos incompletos ──
// Única fuente de verdad para "¿a este jurado le falta X?", usada tanto por
// GET /diagnostico (para los contadores) como por GET /jurados-pendientes
// (para listar exactamente esos jurados). Si esta función cambiara y solo
// se actualizara en un lugar, el contador y la lista podrían divergir — por
// eso viven en un único lugar.
//
// NO decide nada por sí sola ni corrige nada — es puramente de lectura.
const { resolverComuna } = require('./geografia');

/**
 * @param {{categoria, comuna, asociacion}} jurado
 * @param {{comunas:Array, alias:Array}} catalogoComunas - mismo shape que resolverComuna()
 * @returns {{sinCategoria:boolean, sinComuna:boolean, comunaNoReconocida:boolean, sinAsociacion:boolean}}
 */
function clasificarJurado(jurado, catalogoComunas) {
    const sinCategoria = !jurado.categoria || !['A', 'B', 'C'].includes(jurado.categoria);

    const comunaTexto = (jurado.comuna || '').trim();
    const sinComuna = !comunaTexto;
    const comunaNoReconocida = !sinComuna && !resolverComuna(comunaTexto, catalogoComunas).resuelto;

    const sinAsociacion = !jurado.asociacion || !jurado.asociacion.trim();

    return { sinCategoria, sinComuna, comunaNoReconocida, sinAsociacion };
}

module.exports = { clasificarJurado };
