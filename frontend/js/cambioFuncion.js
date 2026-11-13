// ============================================================
// Cambio de función Jurado <-> Delegado Rentado (migración 100)
// Compartido por admin/usuarios.html y admin/hojavida.html.
//
// Flujo: verificación previa (solo lectura) -> formulario con categoría
// (si pasa a Jurado) y motivo obligatorio -> confirmación explícita ->
// PATCH /admin/usuarios/:id/tipo-persona. El backend y la RPC vuelven a
// validar todo; este módulo nunca decide por sí solo.
//
// Requiere los globales de utils.js/api.js (api, sanitizar, mostrarToast,
// mostrarError, confirmar, formatFecha) y el modal estándar de la página
// (#modal-titulo, #modal-contenido, #modal-overlay, cerrarModal()).
// ============================================================

const CF_ETIQUETA = { jurado: 'Jurado', delegado_rentado: 'Delegado Rentado' };
let _cfEstado = null; // { usuarioId, verificacion, onExito }

function _cfFecha(f) {
    return typeof formatFecha === 'function' ? formatFecha(f) : (f || '—');
}

function _cfHtmlBloqueos(v) {
    const des = v.bloqueos?.designaciones || [];
    const car = v.bloqueos?.cartillas_pendientes || [];
    let html = '<div id="cf-bloqueos" style="background:#fdecea;border:1px solid #f1948a;border-radius:6px;padding:10px 12px;margin-bottom:12px;">' +
        '<strong style="color:#943126;">No es posible cambiar la función todavía.</strong>';
    if (des.length) {
        html += '<p style="margin:8px 0 4px;">Designaciones vigentes o futuras (deben reemplazarse o anularse antes):</p><ul id="cf-lista-designaciones" style="margin:0 0 0 18px;">' +
            des.map(d => `<li>${sanitizar(d.club || 'Rodeo')}${d.asociacion ? ' | ' + sanitizar(d.asociacion) : ''} — ${sanitizar(_cfFecha(d.fecha))} (${sanitizar(CF_ETIQUETA[d.tipo_persona] || d.tipo_persona || '')})</li>`).join('') +
            '</ul>';
    }
    if (car.length) {
        html += `<p id="cf-cartillas-pendientes" style="margin:8px 0 0;">Cartillas pendientes de su función actual: <strong>${car.length}</strong> (en borrador, observadas o reabiertas). Deben enviarse o regularizarse antes del cambio.</p>`;
    }
    return html + '</div>';
}

function _cfHtmlFormulario(v) {
    const destino = v.tipo_destino;
    const h = v.historico || {};
    return `
        <form id="cf-form" onsubmit="cfGuardarCambioFuncion(event)">
            ${destino === 'jurado' ? `<div class="form-grupo">
                <label class="form-label">Categoría de jurado <span class="req">*</span></label>
                <select name="categoria" id="cf-categoria" class="form-control" required>
                    <option value="">Seleccione...</option>
                    <option value="A">A</option><option value="B">B</option><option value="C">C</option>
                </select>
            </div>` : ''}
            <div class="form-grupo">
                <label class="form-label">Motivo administrativo <span class="req">*</span></label>
                <textarea name="motivo" id="cf-motivo" class="form-control" rows="3" maxlength="1000" required
                    placeholder="Ej.: Pasa a desempeñarse como ${sanitizar(CF_ETIQUETA[destino])}"></textarea>
            </div>
            <div style="background:#eaf2f8;border:1px solid #aed6f1;border-radius:6px;padding:8px 12px;font-size:13px;margin-bottom:12px;">
                Se conservan su código, contraseña, datos personales e historial.
                Sus designaciones anteriores mantienen la función con que participó
                (${Number(h.designaciones_como_jurado || 0)} como Jurado, ${Number(h.designaciones_como_delegado || 0)} como Delegado Rentado),
                con sus notas, cartillas, categorías y pagos sin cambios.
                Si tiene una sesión abierta, se cerrará y deberá ingresar nuevamente.
            </div>
            <div class="form-acciones">
                <button type="submit" id="cf-btn-guardar" class="btn btn-primario">Confirmar cambio de función</button>
                <button type="button" class="btn btn-secundario" onclick="cerrarModal()">Cancelar</button>
            </div>
        </form>`;
}

async function abrirModalCambioFuncion(usuarioId, { onExito } = {}) {
    _cfEstado = null;
    const titulo = document.getElementById('modal-titulo');
    const cont = document.getElementById('modal-contenido');
    titulo.textContent = 'Cambiar función';
    cont.innerHTML = '<p class="texto-gris">Verificando designaciones y cartillas...</p>';
    document.getElementById('modal-overlay').classList.remove('oculto');

    let v;
    try {
        v = await api.get(`/admin/usuarios/${encodeURIComponent(usuarioId)}/tipo-persona/verificacion`);
    } catch (err) {
        cont.innerHTML = `<p style="color:#943126;">${sanitizar(err?.message || 'No fue posible verificar el cambio de función')}</p>`;
        return;
    }
    if (!v) return; // 401: api.js ya cerró la sesión

    _cfEstado = { usuarioId, verificacion: v, onExito };
    titulo.textContent = 'Cambiar función — ' + (v.usuario?.nombre_completo || '');
    const actual = CF_ETIQUETA[v.tipo_actual] || v.tipo_actual;
    const catActual = v.tipo_actual === 'jurado' && v.usuario?.categoria ? ` (categoría ${sanitizar(v.usuario.categoria)})` : '';
    cont.innerHTML = `
        <p style="margin-bottom:6px;">Función actual: <strong>${sanitizar(actual)}${catActual}</strong></p>
        <p style="margin-bottom:6px;">Nueva función: <strong id="cf-destino">${sanitizar(CF_ETIQUETA[v.tipo_destino])}</strong></p>
        <p style="margin-bottom:12px;">Fecha efectiva: <strong>${sanitizar(_cfFecha(v.fecha_efectiva))}</strong></p>
        ${v.puede_cambiar ? _cfHtmlFormulario(v) : _cfHtmlBloqueos(v) +
            '<div class="form-acciones"><button type="button" class="btn btn-secundario" onclick="cerrarModal()">Cerrar</button></div>'}`;
}

async function cfGuardarCambioFuncion(event) {
    event.preventDefault();
    if (!_cfEstado) return;
    const { usuarioId, verificacion: v, onExito } = _cfEstado;
    const form = event.target;
    const destino = v.tipo_destino;
    const motivo = (form.elements.motivo?.value || '').trim();
    const categoria = destino === 'jurado' ? (form.elements.categoria?.value || '') : null;
    if (destino === 'jurado' && !['A', 'B', 'C'].includes(categoria)) {
        mostrarToast('Seleccione categoría A, B o C', 'error'); return;
    }
    if (!motivo) { mostrarToast('Debe indicar el motivo del cambio de función', 'error'); return; }

    const nombre = sanitizar(v.usuario?.nombre_completo || '');
    const textoDestino = CF_ETIQUETA[destino] + (categoria ? ` categoría ${categoria}` : '');
    const ok = await confirmar(`¿Cambiar la función de <strong>${nombre}</strong> de ${sanitizar(CF_ETIQUETA[v.tipo_actual])} a <strong>${sanitizar(textoDestino)}</strong>?<br><br>` +
        `Quedará registrado en su Hoja de Vida con el motivo indicado. Su historial no se modifica.`);
    if (!ok) return;

    const btn = document.getElementById('cf-btn-guardar');
    if (btn) btn.disabled = true;
    try {
        const r = await api.patch(`/admin/usuarios/${encodeURIComponent(usuarioId)}/tipo-persona`, { tipo_persona: destino, categoria, motivo });
        if (!r) return;
        mostrarToast(r.mensaje || 'Función actualizada', 'success');
        cerrarModal();
        _cfEstado = null;
        if (typeof onExito === 'function') await onExito(r);
    } catch (err) {
        mostrarError(err);
    } finally {
        if (btn) btn.disabled = false;
    }
}

if (typeof window !== 'undefined') {
    window.abrirModalCambioFuncion = abrirModalCambioFuncion;
    window.cfGuardarCambioFuncion = cfGuardarCambioFuncion;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { abrirModalCambioFuncion, cfGuardarCambioFuncion, _cfHtmlBloqueos, _cfHtmlFormulario };
}
