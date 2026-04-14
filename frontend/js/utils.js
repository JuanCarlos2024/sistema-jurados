// ============================================================
// UTILIDADES GLOBALES
// ============================================================

// Formatear montos en CLP
function formatCLP(monto) {
    if (monto == null || monto === '') return '$0';
    return '$' + Math.round(Number(monto)).toLocaleString('es-CL');
}

// Formatear fecha DD/MM/YYYY
function formatFecha(fecha) {
    if (!fecha) return '-';
    const [año, mes, dia] = fecha.split('T')[0].split('-');
    return `${dia}/${mes}/${año}`;
}

// Nombre del mes en español
const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
function nombreMes(num) {
    return MESES[(parseInt(num) - 1)] || '-';
}

// Estado del bono → clase CSS y texto
function estadoBono(estado) {
    const mapa = {
        pendiente:     { clase: 'bono-pendiente',    texto: 'Pendiente' },
        aprobado:      { clase: 'bono-aprobado',     texto: 'Aprobado' },
        rechazado:     { clase: 'bono-rechazado',    texto: 'Rechazado' },
        modificado:    { clase: 'bono-modificado',   texto: 'Modificado' },
        aprobado_auto: { clase: 'bono-aprobado-auto', texto: 'Sin bono ($0)' }
    };
    return mapa[estado] || { clase: '', texto: estado };
}

// Mostrar toast de notificación
function mostrarToast(mensaje, tipo = 'info', duracion = 3500) {
    let contenedor = document.getElementById('toast-contenedor');
    if (!contenedor) {
        contenedor = document.createElement('div');
        contenedor.id = 'toast-contenedor';
        document.body.appendChild(contenedor);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${tipo}`;
    toast.innerHTML = `
        <span>${mensaje}</span>
        <button onclick="this.parentElement.remove()">×</button>
    `;
    contenedor.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('toast-salida');
        setTimeout(() => toast.remove(), 400);
    }, duracion);
}

// Mostrar error genérico
function mostrarError(err) {
    const msg = typeof err === 'string' ? err : (err?.message || 'Error desconocido');
    mostrarToast(msg, 'error');
}

// Mostrar modal de confirmación
function confirmar(mensaje) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-confirmar">
                <p>${mensaje}</p>
                <div class="modal-acciones">
                    <button class="btn btn-secundario" id="btn-cancelar">Cancelar</button>
                    <button class="btn btn-peligro" id="btn-confirmar">Confirmar</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector('#btn-confirmar').onclick = () => { overlay.remove(); resolve(true); };
        overlay.querySelector('#btn-cancelar').onclick = () => { overlay.remove(); resolve(false); };
    });
}

// Sanitizar input para prevenir XSS
function sanitizar(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Mostrar spinner en un contenedor
function mostrarSpinner(contenedor) {
    if (!contenedor) return;
    contenedor.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
}

// Proteger ruta: redirigir si no hay token del tipo correcto
function protegerRuta(tipoRequerido) {
    const usuario = api.getUsuario();
    const token = api.getToken();

    if (!token || !usuario) {
        window.location.href = '/index.html';
        return false;
    }

    if (tipoRequerido && usuario.tipo !== tipoRequerido) {
        if (usuario.tipo === 'administrador') {
            window.location.href = '/admin/dashboard.html';
        } else {
            window.location.href = '/usuario/dashboard.html';
        }
        return false;
    }

    return true;
}

// Construir query string desde objeto
function toQueryString(params) {
    return Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
}

// Parsear query string actual
function getQueryParams() {
    const params = {};
    new URLSearchParams(window.location.search).forEach((v, k) => { params[k] = v; });
    return params;
}

window.formatCLP = formatCLP;
window.formatFecha = formatFecha;
window.nombreMes = nombreMes;
window.estadoBono = estadoBono;
window.mostrarToast = mostrarToast;
window.mostrarError = mostrarError;
window.confirmar = confirmar;
window.sanitizar = sanitizar;
window.mostrarSpinner = mostrarSpinner;
window.protegerRuta = protegerRuta;
window.toQueryString = toQueryString;
window.getQueryParams = getQueryParams;
