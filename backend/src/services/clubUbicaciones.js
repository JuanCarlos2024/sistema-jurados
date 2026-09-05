// ─── Comuna habitual del club (sugerencias SEGURAS, sin fuzzy matching) ────
// Ayuda al administrador a completar la comuna de un rodeo, pero NUNCA la
// aplica automáticamente. Dos fuentes de sugerencia, en este orden:
//
//   1. club_ubicaciones — relación explícita CLUB + ASOCIACIÓN → COMUNA que
//      el propio administrador confirmó antes para este mismo club+asociación.
//   2. Coincidencia EXACTA de nombre — reutiliza resolverComuna() (misma
//      lógica que ya usa el catálogo de comunas para jurados): si el nombre
//      normalizado del club coincide exactamente con una comuna o un alias
//      del catálogo, se sugiere esa comuna.
//
// Si ninguna de las dos aplica, NO hay sugerencia (null) — nunca se inventa
// ni se aproxima por similitud. "Sin club" nunca genera sugerencia.
const { normalizarTexto, resolverComuna } = require('./geografia');

function normalizarClub(club) {
    return normalizarTexto(club);
}

function normalizarAsociacionClub(asociacion) {
    return normalizarTexto(asociacion);
}

// Clave estable para indexar el mapa de ubicaciones habituales en memoria.
function claveClubAsociacion(club, asociacion) {
    return `${normalizarClub(club)}||${normalizarAsociacionClub(asociacion)}`;
}

/**
 * @param {string} club
 * @param {string} asociacion
 * @param {Map<string,{comuna_id:string,comuna_nombre:string}>} mapaHabitual - clave: claveClubAsociacion()
 * @param {{comunas:Array, alias:Array}} catalogoComunas - mismo shape que usa resolverComuna()
 * @returns {{comuna_id:string, comuna_nombre:string, origen:'club_ubicacion'|'coincidencia_exacta'}|null}
 */
function sugerirComunaParaClub(club, asociacion, mapaHabitual, catalogoComunas) {
    const clubTexto = (club || '').toString().trim();
    if (!clubTexto) return null;
    if (normalizarClub(clubTexto) === 'sin club') return null; // nunca inferir para "Sin club"

    const clave = claveClubAsociacion(clubTexto, asociacion);
    const habitual = mapaHabitual && mapaHabitual.get(clave);
    if (habitual) {
        return { comuna_id: habitual.comuna_id, comuna_nombre: habitual.comuna_nombre, origen: 'club_ubicacion' };
    }

    const resuelto = resolverComuna(clubTexto, catalogoComunas);
    if (resuelto.resuelto) {
        return { comuna_id: resuelto.comuna_id, comuna_nombre: resuelto.nombre, origen: 'coincidencia_exacta' };
    }

    return null;
}

module.exports = { normalizarClub, normalizarAsociacionClub, claveClubAsociacion, sugerirComunaParaClub };
