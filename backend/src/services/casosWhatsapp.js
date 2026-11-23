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

// ─── Desglose Bien jurado / Mal jurado (migración 107) ─────────────────────
// A diferencia del total, aquí vacío NO es 0: es "sin registrar" (NULL).
//   · ambos undefined          → no vienen: el desglose guardado no se toca.
//   · ambos vacíos (null / "") → sin desglose (NULL, NULL).
//   · ambos enteros >= 0       → desglose; deben sumar el total (validarSumaDesglose).
//   · uno vacío y el otro no   → rechazado.
const MENSAJE_DESGLOSE = 'Bien jurado y Mal jurado deben ser números enteros mayores o iguales a 0';

function valorDesglose(v) {
    if (v === null || v === undefined) return { ok: true, valor: null };
    if (typeof v === 'string') {
        const t = v.trim();
        if (t === '') return { ok: true, valor: null };
        if (!/^\d+$/.test(t)) return { ok: false };
        v = Number(t);
    }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAXIMO_INTEGER_PG) return { ok: false };
    return { ok: true, valor: v };
}

// → { ok: true, cambia: false } | { ok: true, cambia: true, bien, mal } | { ok: false, error }
function normalizarDesgloseWhatsapp(bien, mal) {
    if (bien === undefined && mal === undefined) return { ok: true, cambia: false };
    const b = valorDesglose(bien), m = valorDesglose(mal);
    if (!b.ok || !m.ok) return { ok: false, error: MENSAJE_DESGLOSE };
    if ((b.valor === null) !== (m.valor === null)) {
        return { ok: false, error: 'Complete Bien jurado y Mal jurado (o deje ambos vacíos si aún no hay desglose)' };
    }
    return { ok: true, cambia: true, bien: b.valor, mal: m.valor };
}

// null si es válido; mensaje si no. Sin desglose (ambos NULL) siempre es válido.
function validarSumaDesglose(bien, mal, total) {
    if (bien === null && mal === null) return null;
    if (bien + mal !== total) {
        return `Bien jurado + Mal jurado (${bien + mal}) debe ser igual al total de Casos por WhatsApp (${total})`;
    }
    return null;
}

module.exports = {
    normalizarCasosWhatsapp, MENSAJE_CASOS_WHATSAPP: MENSAJE, MAXIMO_INTEGER_PG,
    normalizarDesgloseWhatsapp, validarSumaDesglose
};
