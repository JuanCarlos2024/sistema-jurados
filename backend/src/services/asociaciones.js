// ─── Comparación conservadora de nombres de asociación ─────────────────────
// Única fuente de verdad para "¿estas dos asociaciones son la misma?", usada
// por el motor de propuesta de designación (Regla 1: no proponer un jurado
// para un rodeo de su propia asociación; Regla 2: no repetir asociación en
// la temporada). NO hace fuzzy matching, NO Levenshtein, NO similitud
// porcentual — solo normalización superficial de formato.
//
// Transformaciones aplicadas (todas mediante normalizarTexto de geografia.js,
// el mismo algoritmo ya usado en el resto del proyecto):
//   - trim
//   - minúsculas
//   - sin tildes
//   - guiones → espacio
//   - espacios duplicados colapsados
// Más, específico de asociaciones:
//   - se quita el prefijo genérico "asociación "/"asociacion " si está al
//     inicio del texto (es boilerplate administrativo, no forma parte del
//     nombre propio de la asociación).
//
// Lo que NO se toca: ninguna palabra significativa se elimina ni se
// reordena. "BÍO-BÍO" y "RÍO BÍO-BÍO" siguen siendo distintas (la primera
// normaliza a "bio bio", la segunda a "rio bio bio"); "LLANQUIHUE" y "LAGO
// LLANQUIHUE" siguen siendo distintas; "MAIPO" y "MAIPO NORTE" siguen siendo
// distintas.
const { normalizarTexto } = require('./geografia');

function normalizarAsociacion(str) {
    let n = normalizarTexto(str);
    n = n.replace(/^asociacion\s+/, '');
    return n.trim();
}

function mismaAsociacion(a, b) {
    const na = normalizarAsociacion(a);
    const nb = normalizarAsociacion(b);
    if (!na || !nb) return false;
    return na === nb;
}

module.exports = { normalizarAsociacion, mismaAsociacion };
