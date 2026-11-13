// ═════════════════════════════════════════════════════════════════════════
// Confirmación EXACTA de advertencias (preferencias flexibles) — hotfix del
// reemplazo de jurado (caso VICTORIA/MALLECO 14/11/2026).
//
// Un `confirmar_advertencias: true` genérico nunca basta: el administrador
// debe declarar la lista exacta de causas que vio y aceptó
// (`causas_aceptadas`), y esa lista debe coincidir — como CONJUNTO, sin
// depender del orden — con las causas relajables que el motor detecta EN
// ESTE MOMENTO al revalidar. Si falta una, sobra una o el candidato ya no
// tiene advertencias, la confirmación está desactualizada y no se guarda.
//
// Módulo puro (sin BD): nunca decide qué es relajable u obligatorio — eso
// lo hace exclusivamente evaluarElegibilidadJurado() con el motor real.
// ═════════════════════════════════════════════════════════════════════════

// Normaliza causas_aceptadas recibidas del cliente.
// @returns { ok:true, causas:string[]|null } | { ok:false, error }
function normalizarCausasAceptadas(valor) {
    if (valor === undefined || valor === null) return { ok: true, causas: null };
    if (!Array.isArray(valor)) return { ok: false, error: 'causas_aceptadas debe ser una lista de códigos de causa' };
    if (valor.some(c => typeof c !== 'string' || c.trim() === '')) {
        return { ok: false, error: 'causas_aceptadas solo admite códigos de causa de texto' };
    }
    const causas = valor.map(c => c.trim());
    if (new Set(causas).size !== causas.length) return { ok: false, error: 'causas_aceptadas contiene causas duplicadas' };
    return { ok: true, causas };
}

// Compara causas actuales (motor) con las aceptadas (administrador).
// @returns { coincide, nuevas, ya_no_existen }
function compararCausas(actuales, aceptadas) {
    const a = new Set(actuales || []);
    const b = new Set(aceptadas || []);
    const nuevas = [...a].filter(c => !b.has(c)).sort();
    const ya_no_existen = [...b].filter(c => !a.has(c)).sort();
    return { coincide: nuevas.length === 0 && ya_no_existen.length === 0, nuevas, ya_no_existen };
}

module.exports = { normalizarCausasAceptadas, compararCausas };
