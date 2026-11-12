// ═════════════════════════════════════════════════════════════════════════
// Historial Unificado de Designaciones — componente compartido.
// Rodeos (detalle), Propuesta de Designación y el reporte del Directorio
// muestran EXACTAMENTE la misma línea de tiempo, servida por
// GET /api/admin/historial-designaciones/rodeo/:id (una sola fuente).
//
// hdRenderLineaTiempo(h) es PURA (devuelve HTML); hdAbrirHistorialRodeo()
// crea el modal dinámicamente (no requiere marcado previo en la página).
// ═════════════════════════════════════════════════════════════════════════

function hdEsc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function hdFechaHora(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return d.toLocaleString('es-CL', { timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function hdFechaDia(iso) {
    if (!iso) return '—';
    const [y, m, d] = String(iso).slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
}
// Badge discreto de categoría junto al nombre del jurado (solo presentación).
// info = { categoria, categoria_fuente | fuente }. Fuente:
//   DESIGNACION — categoría aplicada en la designación (registro histórico),
//   MOTOR       — categoría registrada por el motor al generar la propuesta,
//   ACTUAL      — categoría actual del jurado (sin registro histórico): se
//                 rotula "actual" para no presentarla como histórica, salvo
//                 en vistas del estado presente (opts.marcarActual === false).
const HD_TITULO_FUENTE_CATEGORIA = {
    DESIGNACION: 'Categoría aplicada al crear la designación',
    MOTOR: 'Categoría registrada por el motor al generar la propuesta',
    ACTUAL: 'Categoría actual del jurado (no hay registro de la categoría en la fecha del evento)',
};
function hdBadgeCategoria(info, opts) {
    if (!info) return '';
    const fuente = info.categoria_fuente || info.fuente || null;
    const marcarActual = !(opts && opts.marcarActual === false) && fuente === 'ACTUAL';
    const cambio = fuente && fuente !== 'ACTUAL' && info.categoria_actual && info.categoria_actual !== info.categoria ? info.categoria_actual : null;
    const texto = info.categoria ? `Cat. ${info.categoria}${marcarActual ? ' · actual' : ''}${cambio ? ' · hoy ' + cambio : ''}` : 'Sin categoría';
    const titulo = info.categoria
        ? (HD_TITULO_FUENTE_CATEGORIA[fuente] || 'Categoría del jurado') + (cambio ? `. Categoría actual: ${cambio}` : '')
        : 'El jurado no tiene categoría registrada';
    return ` <span class="hd-cat" title="${hdEsc(titulo)}" style="display:inline-block; vertical-align:middle; margin-left:4px; padding:0 6px; border:1px solid #c9d3e0; border-radius:8px; background:#f4f6f9; color:#1f3b5c; font-size:11px; font-weight:600; line-height:16px; white-space:nowrap;">${hdEsc(texto)}</span>`;
}
// Nombre en negrita + badge; el badge solo si el jurado tiene id real.
function hdJuradoConCategoria(j, opts) {
    if (!j) return '';
    const nombre = (opts && opts.negrita === false) ? hdEsc(j.nombre || j.id) : `<strong>${hdEsc(j.nombre || j.id)}</strong>`;
    // Sin la clave `categoria` (respuesta sin ese dato) no se dibuja badge;
    // con categoria null se informa "Sin categoría".
    return j.id && Object.prototype.hasOwnProperty.call(j, 'categoria') ? nombre + hdBadgeCategoria(j, opts) : nombre;
}

const HD_COLOR_ORIGEN = { MOTOR: '#1a5276', ADMINISTRADOR: '#7d3c98', JURADO: '#1e8449', SISTEMA: '#6b7280' };
const HD_SIN_INFO = 'Sin información registrada';

function hdRenderEvento(e) {
    const color = HD_COLOR_ORIGEN[e.origen] || '#6b7280';
    const fecha = e.tipo === 'ESTADO_FINAL' ? 'Hoy' : (hdFechaHora(e.fecha) || 'Sin fecha registrada');
    const ant = e.jurado_anterior ? hdJuradoConCategoria(e.jurado_anterior) : null;
    const nue = e.jurado_nuevo ? hdJuradoConCategoria(e.jurado_nuevo) : null;
    const cambio = ant && nue ? `${ant} → ${nue}`
        : nue ? `Jurado: ${nue}` : ant ? `Jurado: ${ant}` : '';
    const noAplicada = e.propuesta_aplicada === false ? ' <span class="hd-chip hd-chip-gris">Propuesta no aplicada</span>' : '';
    const filas = [
        cambio,
        `Responsable: ${hdEsc(e.responsable || HD_SIN_INFO)}`,
        e.motivo ? `Motivo: ${hdEsc(e.motivo)}` : null,
        e.justificacion ? `Detalle: ${hdEsc(e.justificacion)}` : null,
        e.estado_resultante ? `Estado resultante: <strong>${hdEsc(e.estado_resultante)}</strong>` : null,
        e.configuracion_version != null ? `Configuración v${hdEsc(e.configuracion_version)}${e.motor ? ' · motor ' + hdEsc(e.motor) : ''}` : null,
    ].filter(Boolean);
    return `<li class="hd-evento${e.tipo === 'ESTADO_FINAL' ? ' hd-final' : ''}" style="border-left-color:${color};">
        <div class="hd-cab">
            <span class="hd-fecha">${hdEsc(fecha)}</span>
            <span class="hd-chip" style="background:${color};">${hdEsc(e.origen)}</span>${noAplicada}
        </div>
        <div class="hd-titulo">${hdEsc(e.etiqueta)}</div>
        <div class="hd-cuerpo">${filas.join('<br>')}</div>
    </li>`;
}

// Resumen por rodeo: jurado estructurado (con categoría) si viene; si no, el
// texto existente tal cual (ej. "Sin confirmación individual registrada").
const hdNegrita = (txt, opts) => ((opts && opts.negrita === false) ? hdEsc(txt) : `<strong>${hdEsc(txt)}</strong>`);
function hdResumenPropuesto(s, opts) {
    return s.jurado_propuesto_original_jurado ? hdJuradoConCategoria(s.jurado_propuesto_original_jurado, opts) : hdNegrita(s.jurado_propuesto_original || '—', opts);
}
function hdResumenConfirmado(s, opts) {
    return s.jurado_confirmado_admin_jurado
        ? hdJuradoConCategoria(s.jurado_confirmado_admin_jurado, opts) + (s.jurado_confirmado_admin_nota ? ' ' + hdNegrita(s.jurado_confirmado_admin_nota, opts) : '')
        : hdNegrita(s.jurado_confirmado_admin || '—', opts);
}
function hdResumenVigente(s) {
    return s.jurado_vigente_jurados && s.jurado_vigente_jurados.length
        ? s.jurado_vigente_jurados.map(j => hdJuradoConCategoria(j)).join(' / ')
        : `<strong>${hdEsc(s.jurado_vigente || '—')}</strong>`;
}

// @param h { rodeo, resumen, eventos }
function hdRenderLineaTiempo(h) {
    if (!h || !h.rodeo) return '<p>Sin datos.</p>';
    const r = h.rodeo, s = h.resumen || {};
    const eventos = h.eventos || [];
    const huboCambiosAdmin = eventos.some(e => ['MODIFICACION_BORRADOR', 'REEMPLAZO', 'ANULACION'].includes(e.tipo));
    const aviso = !huboCambiosAdmin && eventos.some(e => e.tipo === 'MOTOR_PROPUESTA')
        ? '<div class="alerta alerta-info" style="font-size:13px; margin-bottom:10px;">Se mantiene la propuesta original del motor. Sin modificaciones administrativas registradas.</div>'
        : '';
    const avisoClasificacion = eventos.some(e => e.tipo === 'CLASIFICACION_AUTOMATICA')
        ? '<div class="alerta alerta-advertencia" style="font-size:13px; margin-bottom:10px;">El borrador registra un estado de revisión asignado automáticamente al guardar (regla anterior al 11/11/2026). No existe confirmación individual del administrador para este rodeo.</div>'
        : '';
    return `<div class="hd-resumen">
            <div><strong>${hdEsc(r.club || '—')}</strong> · ${hdEsc(r.asociacion || '—')} · ${hdFechaDia(r.fecha)}${r.duracion_dias > 1 ? ` (${r.duracion_dias} días)` : ''}</div>
            <div style="font-size:13px; color:#6b7280;">${hdEsc(r.tipo_rodeo || '—')}${r.clasificacion ? ' · ' + hdEsc(r.clasificacion) : ''}</div>
            <div class="hd-claves">
                <div><span>Propuesto por el motor</span>${hdResumenPropuesto(s)}</div>
                <div><span>Confirmado por administración</span>${hdResumenConfirmado(s)}${s.decision_borrador ? `<small style="display:block; color:#6b7280;">${hdEsc(s.decision_borrador)}</small>` : ''}</div>
                <div><span>Jurado vigente</span>${hdResumenVigente(s)}</div>
            </div>
        </div>
        ${aviso}${avisoClasificacion}
        <ol class="hd-linea">${eventos.map(hdRenderEvento).join('')}</ol>`;
}

const HD_CSS = `
.hd-resumen { background:#f4f6f9; border-radius:8px; padding:10px 12px; margin-bottom:12px; }
.hd-claves { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:8px; margin-top:8px; }
.hd-claves span { display:block; font-size:11px; color:#6b7280; text-transform:uppercase; letter-spacing:.3px; }
.hd-linea { list-style:none; margin:0; padding:0; }
.hd-evento { border-left:4px solid #6b7280; background:#fff; border:1px solid #dde1e7; border-left-width:4px; border-radius:6px; padding:8px 12px; margin-bottom:8px; }
.hd-evento.hd-final { background:#eef6ff; }
.hd-cab { display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:12px; color:#6b7280; }
.hd-chip { color:#fff; border-radius:10px; padding:1px 8px; font-size:11px; font-weight:700; }
.hd-chip-gris { background:#9ca3af; }
.hd-titulo { font-weight:700; margin:3px 0; }
.hd-cuerpo { font-size:13px; color:#374151; line-height:1.55; overflow-wrap:anywhere; }
`;

function hdAsegurarCss() {
    if (typeof document === 'undefined' || document.getElementById('hd-estilos')) return;
    const st = document.createElement('style');
    st.id = 'hd-estilos';
    st.textContent = HD_CSS;
    document.head.appendChild(st);
}

async function hdAbrirHistorialRodeo(rodeoId) {
    hdAsegurarCss();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal" style="max-width:760px; width:96%;">
        <div class="modal-header"><h3>Historial de Designaciones</h3><button class="modal-cerrar" aria-label="Cerrar">×</button></div>
        <div class="modal-body" style="max-height:72vh; overflow-y:auto;"><div class="spinner-wrap"><div class="spinner"></div></div></div>
    </div>`;
    document.body.appendChild(overlay);
    const cerrar = () => overlay.remove();
    overlay.querySelector('.modal-cerrar').onclick = cerrar;
    overlay.addEventListener('click', ev => { if (ev.target === overlay) cerrar(); });
    const body = overlay.querySelector('.modal-body');
    try {
        const h = await api.get('/admin/historial-designaciones/rodeo/' + encodeURIComponent(rodeoId));
        body.innerHTML = hdRenderLineaTiempo(h);
    } catch (err) {
        body.innerHTML = `<div class="alerta alerta-error">${hdEsc(err.message || 'No se pudo cargar el historial')}</div>`;
    }
}

const _hdExports = { hdRenderLineaTiempo, hdRenderEvento, hdEsc, hdFechaDia, HD_CSS, hdBadgeCategoria, hdJuradoConCategoria, hdResumenPropuesto, hdResumenConfirmado, hdResumenVigente };
if (typeof module !== 'undefined' && module.exports) { module.exports = _hdExports; }
