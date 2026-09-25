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

// HTML del campo: editable para el analista (mismo criterio de esAnalista del resto del análisis) o solo lectura.
function cwHtmlCampo(valor, editable) {
    const v = cwValorMostrar(valor);
    const etiqueta = '<div style="font-size:11px;font-weight:600;color:var(--gris);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Casos por WhatsApp</div>';
    const control = editable
        ? `<input type="number" id="ad-casos_whatsapp" class="form-control" value="${v}" min="0" step="1" inputmode="numeric" style="width:120px;" aria-label="Casos por WhatsApp">`
        : `<div class="campo-readonly" id="ad-casos_whatsapp_lectura" style="min-height:32px;width:120px;">${v}</div>`;
    return `<div style="margin-bottom:16px;">${etiqueta}${control}
        <div style="font-size:11px;color:var(--gris);margin-top:4px;">Cantidad de situaciones reportadas a los jurados por WhatsApp y conocidas por el analista.</div></div>`;
}

const _casosWhatsappExports = { cwValorMostrar, cwLeerInput, cwHtmlCampo };
if (typeof module !== 'undefined' && module.exports) { module.exports = _casosWhatsappExports; }
