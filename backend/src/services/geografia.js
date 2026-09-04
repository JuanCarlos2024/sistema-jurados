// ─── Utilidades geográficas (Etapa 2 — infraestructura para Propuesta de ──────
// Designación de Jurados). Puramente utilitario: NO está conectado a ningún
// generador de jurados todavía. Eso corresponde a la Etapa 3+.

function _toRad(deg) {
    return deg * (Math.PI / 180);
}

/**
 * Distancia aproximada en kilómetros entre dos puntos (lat/lng en grados
 * decimales), usando la fórmula de Haversine (distancia geodésica en línea
 * recta sobre una esfera). Suficiente para un filtro de "¿está a menos de
 * N km?" — no es distancia vial exacta, no requiere servicios externos.
 * Devuelve null si algún valor no es un número válido (ej. comuna sin
 * coordenadas cargadas todavía).
 */
function calcularDistanciaKm(lat1, lng1, lat2, lng2) {
    const RADIO_TIERRA_KM = 6371;
    const crudos = [lat1, lng1, lat2, lng2];
    if (crudos.some(v => v === null || v === undefined || v === '' || Number.isNaN(Number(v)))) return null;

    const [la1, lo1, la2, lo2] = crudos.map(Number);
    const dLat = _toRad(la2 - la1);
    const dLng = _toRad(lo2 - lo1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(_toRad(la1)) * Math.cos(_toRad(la2)) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return RADIO_TIERRA_KM * c;
}

// Mismo algoritmo que backend/src/services/importacion.js normalizar() —
// reutilizado tal cual (trim, minúsculas, sin tildes, guiones→espacio,
// espacios colapsados) para resolver comuna en texto contra el catálogo.
function normalizarTexto(str) {
    if (!str) return '';
    return str.toString().trim().toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[\-–—]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ─── Resolución centralizada de comuna en texto libre ──────────────────────
// Única fuente de verdad para "texto de comuna → comuna canónica". Cualquier
// lugar que necesite resolver una comuna (el diagnóstico de hoy, el futuro
// motor de propuesta) debe llamar a resolverComuna() en vez de reimplementar
// la lógica de "buscar directo y después en alias".
//
// Orden determinístico, SIN fuzzy matching, SIN Levenshtein, SIN coincidencia
// parcial/contains, SIN eliminar palabras:
//   1. Normalización conservadora (normalizarTexto: trim/minúsculas/tildes/
//      espacios — nada que cambie el significado del nombre).
//   2. Coincidencia EXACTA normalizada contra comunas_chile.
//   3. Si no hay match directo, coincidencia EXACTA normalizada contra
//      comunas_chile_alias.
//   4. Si el alias existe, se devuelve la comuna canónica asociada.
//   5. Si nada matchea, NO RESUELTA (resuelto: false).
//
// resolverComuna() es una función PURA (recibe los catálogos ya cargados, no
// hace queries) para poder reutilizarse tanto en un solo lookup como en un
// diagnóstico masivo sin N+1, y para ser trivialmente testeable sin BD.
// cargarCatalogoResolucionComunas() es el helper que carga esos catálogos
// una sola vez desde Supabase.

/**
 * @param {string} textoComuna - texto libre a resolver (ej. usuarios_pagados.comuna)
 * @param {{comunas: Array<{id,nombre,nombre_normalizado,region?,latitud?,longitud?}>, alias: Array<{alias_normalizado,comuna_id}>}} catalogo
 * @returns {{resuelto:false, origen:null} | {resuelto:true, origen:'DIRECTA'|'ALIAS', comuna_id:string, nombre:string, region:string|null, latitud:number|null, longitud:number|null}}
 */
function resolverComuna(textoComuna, catalogo) {
    const texto = (textoComuna || '').toString().trim();
    if (!texto) return { resuelto: false, origen: null };

    const normalizado = normalizarTexto(texto);
    const { comunas = [], alias = [] } = catalogo || {};

    const directa = comunas.find(c => c.nombre_normalizado === normalizado);
    if (directa) {
        return {
            resuelto: true, origen: 'DIRECTA', comuna_id: directa.id, nombre: directa.nombre,
            region: directa.region ?? null, latitud: directa.latitud ?? null, longitud: directa.longitud ?? null
        };
    }

    const aliasMatch = alias.find(a => a.alias_normalizado === normalizado);
    if (aliasMatch) {
        const comuna = comunas.find(c => c.id === aliasMatch.comuna_id);
        if (comuna) {
            return {
                resuelto: true, origen: 'ALIAS', comuna_id: comuna.id, nombre: comuna.nombre,
                region: comuna.region ?? null, latitud: comuna.latitud ?? null, longitud: comuna.longitud ?? null
            };
        }
    }

    return { resuelto: false, origen: null };
}

// Carga los catálogos (comunas_chile activas + comunas_chile_alias) una sola
// vez, listos para pasarle a resolverComuna() en un bucle sin N+1. Único
// lugar que sabe cómo se consultan estas dos tablas para fines de resolución.
async function cargarCatalogoResolucionComunas() {
    const supabase = require('../config/supabase');
    const [{ data: comunas, error: errComunas }, { data: alias, error: errAlias }] = await Promise.all([
        supabase.from('comunas_chile').select('id, nombre, nombre_normalizado, region, latitud, longitud').eq('activo', true),
        supabase.from('comunas_chile_alias').select('alias_normalizado, comuna_id')
    ]);
    if (errComunas) throw new Error('No se pudo cargar el catálogo de comunas: ' + errComunas.message);
    if (errAlias) throw new Error('No se pudo cargar el catálogo de alias de comunas: ' + errAlias.message);
    return { comunas: comunas || [], alias: alias || [] };
}

module.exports = { calcularDistanciaKm, normalizarTexto, resolverComuna, cargarCatalogoResolucionComunas };
