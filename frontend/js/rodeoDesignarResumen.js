// ═════════════════════════════════════════════════════════════════════════
// Resumen del RODEO dentro del modal "Designar jurado" (admin/rodeos.html).
//
// Solo presentación: no consulta nada ni toca la lógica de designación. Recibe el objeto del rodeo que la
// pantalla ya tiene cargado (GET /admin/rodeos/:id) y devuelve HTML seguro (escapado) para el contexto
// "¿a qué rodeo estoy designando?". Todo dato faltante se muestra como "Sin información" (nunca
// "undefined", "null", "Invalid Date" ni "NaN").
//
// Funciona cargado por <script src="/js/rodeoDesignarResumen.js"> (define globales) o por require() en Node.
// ═════════════════════════════════════════════════════════════════════════
const RDR_SIN_INFO = 'Sin información';

function _rdrTexto(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === '' || s === 'null' || s === 'undefined' ? null : s;
}

// "2 días" / "1 día"; inválido → null
function rdrTextoDuracion(d) {
    const n = Number(d);
    if (d === null || d === undefined || d === '' || !Number.isInteger(n) || n < 1) return null;
    return n === 1 ? '1 día' : `${n} días`;
}

// YYYY-MM-DD[...] → DD/MM/YYYY; fecha inexistente o inválida → null
function rdrTextoFecha(f) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(f || ''));
    if (!m) return null;
    const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (isNaN(dt) || dt.getUTCDate() !== Number(m[3]) || dt.getUTCMonth() !== Number(m[2]) - 1) return null;
    return `${m[3]}/${m[2]}/${m[1]}`;
}

// Campos en orden de prioridad visual: Club, Asociación y Fecha primero.
function rdrCampos(r) {
    const x = r || {};
    return [
        { clave: 'club', etiqueta: 'Club', valor: _rdrTexto(x.club) || RDR_SIN_INFO, completo: false },
        { clave: 'asociacion', etiqueta: 'Asociación', valor: _rdrTexto(x.asociacion) || RDR_SIN_INFO, completo: false },
        { clave: 'fecha', etiqueta: 'Fecha', valor: rdrTextoFecha(x.fecha) || RDR_SIN_INFO, completo: false },
        { clave: 'categoria', etiqueta: 'Categoría', valor: _rdrTexto(x.categoria_rodeo_nombre) || 'Sin categoría', completo: false },
        { clave: 'duracion', etiqueta: 'Duración', valor: rdrTextoDuracion(x.duracion_dias) || RDR_SIN_INFO, completo: false },
        { clave: 'tipo', etiqueta: 'Tipo', valor: _rdrTexto(x.tipo_rodeo_nombre) || RDR_SIN_INFO, completo: true }   // texto largo: ocupa el ancho completo y hace wrap
    ];
}

// esc: función de escape HTML (por defecto sanitizar() de utils.js, o un escape propio en Node).
function rdrHtmlResumen(r, esc) {
    const e = esc || (typeof sanitizar === 'function' ? sanitizar : s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
    const idRodeo = r && r.id ? e(r.id) : '';
    if (!r) {
        return `<div id="dj-resumen" data-rodeo-id="" style="border:1px solid var(--gris-borde); border-left:4px solid var(--azul); border-radius:6px; background:#f4f8fc; padding:8px 12px; margin-bottom:10px; font-size:13px; color:var(--gris);">
            <div style="font-size:11px; font-weight:700; letter-spacing:.6px; text-transform:uppercase; color:var(--azul);">Rodeo seleccionado</div>Cargando datos del rodeo…</div>`;
    }
    const celdas = rdrCampos(r).map(c => `<div style="min-width:0; overflow-wrap:anywhere; word-break:break-word;${c.completo ? ' grid-column:1 / -1;' : ''}"><span style="color:var(--gris); font-size:12px;">${c.etiqueta}:</span> <strong>${e(c.valor)}</strong></div>`).join('');
    return `<div id="dj-resumen" data-rodeo-id="${idRodeo}" style="border:1px solid var(--gris-borde); border-left:4px solid var(--azul); border-radius:6px; background:#f4f8fc; padding:8px 12px; margin-bottom:10px; font-size:13px; max-width:100%; box-sizing:border-box;">
        <div style="font-size:11px; font-weight:700; letter-spacing:.6px; text-transform:uppercase; color:var(--azul); margin-bottom:4px;">Rodeo seleccionado</div>
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(230px, 1fr)); gap:3px 16px;">${celdas}</div>
    </div>`;
}

const _rodeoDesignarResumenExports = { RDR_SIN_INFO, rdrTextoDuracion, rdrTextoFecha, rdrCampos, rdrHtmlResumen };
if (typeof module !== 'undefined' && module.exports) { module.exports = _rodeoDesignarResumenExports; }
