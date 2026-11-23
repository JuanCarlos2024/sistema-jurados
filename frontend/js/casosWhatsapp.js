// ═════════════════════════════════════════════════════════════════════════
// "Casos por WhatsApp" en el Análisis Deportivo (admin/evaluacion-detalle.html).
//
// Dato informativo: cantidad de situaciones reportadas a los jurados por WhatsApp y conocidas por el analista.
// NO es la nota del jurado ("Casos", notas_rodeo.nota) ni participa en ningún cálculo.
// El backend vuelve a validar (PATCH /admin/evaluaciones/:id/datos-deportivos); esto es solo ayuda de pantalla.
//
// Funciona cargado por <script src="/js/casosWhatsapp.js"> (define globales) o por require() en Node.
// ═════════════════════════════════════════════════════════════════════════

// Valor guardado → número a mostrar. Análisis antiguos sin el dato (undefined/null) se ven como 0.
function cwValorMostrar(v) {
    const n = Number(v);
    return v === null || v === undefined || v === '' || !Number.isInteger(n) || n < 0 ? 0 : n;
}

// Texto del <input> → { ok, valor } ; vacío = 0 ; solo enteros >= 0 (sin decimales, signos, texto ni notación científica).
function cwLeerInput(texto) {
    const t = String(texto === null || texto === undefined ? '' : texto).trim();
    if (t === '') return { ok: true, valor: 0 };
    if (!/^\d+$/.test(t)) return { ok: false, error: 'Casos por WhatsApp debe ser un número entero mayor o igual a 0' };
    const n = Number(t);
    return Number.isSafeInteger(n) && n <= 2147483647 ? { ok: true, valor: n } : { ok: false, error: 'Casos por WhatsApp debe ser un número entero mayor o igual a 0' };
}

// Desglose Bien / Mal jurado (migración 107). Vacío = "sin registrar" (NULL), nunca 0.
// → { ok, bien, mal } (ambos null = sin desglose) | { ok:false, error }
function cwLeerDesglose(textoBien, textoMal, total) {
    const leer = (t) => {
        const s = String(t === null || t === undefined ? '' : t).trim();
        if (s === '') return { ok: true, valor: null };
        if (!/^\d+$/.test(s)) return { ok: false };
        const n = Number(s);
        return Number.isSafeInteger(n) && n <= 2147483647 ? { ok: true, valor: n } : { ok: false };
    };
    const b = leer(textoBien), m = leer(textoMal);
    if (!b.ok || !m.ok) return { ok: false, error: 'Bien jurado y Mal jurado deben ser números enteros mayores o iguales a 0' };
    if ((b.valor === null) !== (m.valor === null)) return { ok: false, error: 'Complete Bien jurado y Mal jurado (o deje ambos vacíos si aún no hay desglose)' };
    if (b.valor !== null && b.valor + m.valor !== total) {
        return { ok: false, error: `Bien jurado + Mal jurado (${b.valor + m.valor}) debe ser igual al total de Casos por WhatsApp (${total})` };
    }
    return { ok: true, bien: b.valor, mal: m.valor };
}

function _cwSubcampo(id, etiqueta, valor, editable) {
    const tieneValor = valor !== null && valor !== undefined && valor !== '';
    const ctrl = editable
        ? `<input type="number" id="${id}" class="form-control" value="${tieneValor ? Number(valor) : ''}" min="0" step="1" inputmode="numeric" placeholder="—" style="width:120px;" aria-label="${etiqueta}">`
        : `<div class="campo-readonly" id="${id}_lectura" style="min-height:32px;width:120px;">${tieneValor ? Number(valor) : '<span style="color:var(--gris);">Sin registrar</span>'}</div>`;
    return `<div><div style="font-size:11px;font-weight:600;color:var(--gris);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">${etiqueta}</div>${ctrl}</div>`;
}

// HTML del campo: editable para el analista (mismo criterio de esAnalista del resto del análisis) o solo lectura.
// bien / mal: desglose guardado (null = sin registrar).
function cwHtmlCampo(valor, editable, bien, mal) {
    const v = cwValorMostrar(valor);
    const etiqueta = '<div style="font-size:11px;font-weight:600;color:var(--gris);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Casos por WhatsApp</div>';
    const control = editable
        ? `<input type="number" id="ad-casos_whatsapp" class="form-control" value="${v}" min="0" step="1" inputmode="numeric" style="width:120px;" aria-label="Casos por WhatsApp">`
        : `<div class="campo-readonly" id="ad-casos_whatsapp_lectura" style="min-height:32px;width:120px;">${v}</div>`;
    return `<div style="margin-bottom:16px;">
        <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;">
            <div>${etiqueta}${control}</div>
            ${_cwSubcampo('ad-casos_whatsapp_bien_jurado', 'Bien jurado', bien, editable)}
            ${_cwSubcampo('ad-casos_whatsapp_mal_jurado', 'Mal jurado', mal, editable)}
        </div>
        <div style="font-size:11px;color:var(--gris);margin-top:4px;">Cantidad de situaciones reportadas a los jurados por WhatsApp y conocidas por el analista. Bien jurado + Mal jurado debe sumar el total (déjelos vacíos si aún no hay desglose).</div></div>`;
}

const _casosWhatsappExports = { cwValorMostrar, cwLeerInput, cwLeerDesglose, cwHtmlCampo };
if (typeof module !== 'undefined' && module.exports) { module.exports = _casosWhatsappExports; }
