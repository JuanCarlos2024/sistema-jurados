// ═════════════════════════════════════════════════════════════════════════
// "Casos por WhatsApp" — dato informativo del ANÁLISIS DEPORTIVO (evaluaciones.casos_whatsapp).
//
// Cantidad de situaciones reportadas directamente a los jurados por WhatsApp y conocidas por el analista.
// NO es la nota del jurado (notas_rodeo.nota, "Casos") ni interviene en ningún cálculo: solo se guarda y se muestra.
//
// Validación (el backend NO confía en <input type="number">):
//   · undefined            → no viene en la petición: el valor guardado no se toca.
//   · null o "" (vacío)    → equivale a 0 ("sin casos"), igual que el valor por defecto de la columna.
//   · entero >= 0 (número o texto de solo dígitos) → válido.
//   · negativos, decimales, texto, NaN, Infinity, booleanos, objetos → rechazados.
// Máximo: solo el del tipo INTEGER de PostgreSQL (2.147.483.647); no hay un máximo funcional inventado.
// ═════════════════════════════════════════════════════════════════════════
const MAXIMO_INTEGER_PG = 2147483647;
const MENSAJE = 'Casos por WhatsApp debe ser un número entero mayor o igual a 0';

// → { ok: true, cambia: false } | { ok: true, cambia: true, valor } | { ok: false, error }
function normalizarCasosWhatsapp(entrada) {
    if (entrada === undefined) return { ok: true, cambia: false };
    if (entrada === null) return { ok: true, cambia: true, valor: 0 };

    let n;
    if (typeof entrada === 'number') {
        n = entrada;
    } else if (typeof entrada === 'string') {
        const t = entrada.trim();
        if (t === '') return { ok: true, cambia: true, valor: 0 };
        if (!/^\d+$/.test(t)) return { ok: false, error: MENSAJE };
        n = Number(t);
    } else {
        return { ok: false, error: MENSAJE };
    }
    if (!Number.isInteger(n) || n < 0 || n > MAXIMO_INTEGER_PG) return { ok: false, error: MENSAJE };
    return { ok: true, cambia: true, valor: n };
}

module.exports = { normalizarCasosWhatsapp, MENSAJE_CASOS_WHATSAPP: MENSAJE, MAXIMO_INTEGER_PG };
