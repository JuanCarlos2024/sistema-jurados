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

// ── Control de acceso por rol admin ───────────────────────────────

// Etiqueta visible de rol administrativo
function labelRolAdmin(rol) {
    const M = {
        jefe_area:        'Jefe Área Deportiva',
        analista:         'Analista',
        comision_tecnica: 'Comisión Técnica',
        monitor:          'Monitor'
    };
    return M[rol] || 'Admin pleno';
}

// Páginas permitidas por rol (monitor: acceso muy restringido)
const _PAGINAS_MONITOR    = ['/admin/dashboard.html', '/admin/rodeos.html', '/admin/reporte-deportivo.html'];
// Páginas bloqueadas para roles de evaluación (analista/jefe/comision)
const _PAGINAS_BLOQUEADAS_EVAL = [
    '/admin/configuracion.html', '/admin/bonos.html', '/admin/exportacion-pagos.html',
    '/admin/reportes.html', '/admin/usuarios.html', '/admin/disponibilidad.html',
    '/admin/importacion.html', '/admin/auditoria.html'
];

function _ajustarMenuPorRol(rol) {
    if (!rol) return; // admin pleno: muestra todo
    const nav = document.querySelector('.sidebar-nav') || document.querySelector('nav');
    if (!nav) return;
    nav.querySelectorAll('a.nav-item').forEach(a => {
        const href = a.getAttribute('href') || '';
        if (rol === 'monitor') {
            // Monitor solo ve dashboard, rodeos y reporte-deportivo
            const permitida = _PAGINAS_MONITOR.some(p => href.endsWith(p.split('/').pop()));
            a.style.display = permitida ? '' : 'none';
            // Ocultar también separadores de sección sin items visibles
        } else {
            // Analista, jefe, comision: ocultar páginas de pagos/config/admin
            const bloqueada = _PAGINAS_BLOQUEADAS_EVAL.some(p => href.endsWith(p.split('/').pop()));
            if (bloqueada) a.style.display = 'none';
        }
    });
    // Ocultar nav-seccion vacías (sin items visibles debajo)
    nav.querySelectorAll('.nav-seccion').forEach(sec => {
        let sib = sec.nextElementSibling;
        let tieneVisible = false;
        while (sib && !sib.classList.contains('nav-seccion')) {
            if (sib.classList.contains('nav-item') && sib.style.display !== 'none') {
                tieneVisible = true; break;
            }
            sib = sib.nextElementSibling;
        }
        sec.style.display = tieneVisible ? '' : 'none';
    });
}

function _aplicarControlAccesoAdmin(usuario) {
    const rol = usuario.rol_evaluacion || null;
    if (!rol) return; // admin pleno: acceso total
    const path = window.location.pathname;
    if (rol === 'monitor') {
        const permitida = _PAGINAS_MONITOR.some(p => path.endsWith(p.split('/').pop()) || path === p);
        if (!permitida) { window.location.href = '/admin/rodeos.html'; return; }
    } else {
        // analista / jefe_area / comision_tecnica: bloquear páginas de admin general
        const bloqueada = _PAGINAS_BLOQUEADAS_EVAL.some(p => path.endsWith(p.split('/').pop()));
        if (bloqueada) { window.location.href = '/admin/evaluaciones.html'; return; }
    }
    // Ajustar menú lateral según rol
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => _ajustarMenuPorRol(rol));
    } else {
        _ajustarMenuPorRol(rol);
    }
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

    // Para páginas admin: aplicar control de acceso por rol
    if (tipoRequerido === 'administrador') {
        _aplicarControlAccesoAdmin(usuario);
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

// Etiqueta visible de ciclo con nombre oficial
function labelCiclo(num) {
    return num === 1 ? 'Ciclo 1 — Primeros 3 lugares'
         : num === 2 ? 'Ciclo 2 — 8 Carreras series de Campeones'
         : 'Ciclo ' + num;
}

// Etiqueta visible de tipo de caso (no cambiar valores en BD)
function formatTipoCaso(tipo) {
    const M = { interpretativa: 'Apreciación', reglamentaria: 'Reglamentaria', informativo: 'Conceptual' };
    return M[tipo] || tipo;
}

window.labelCiclo = labelCiclo;
window.formatTipoCaso = formatTipoCaso;
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
window.labelRolAdmin = labelRolAdmin;
