// ============================================================
// API CLIENT — comunicación con el backend
// ============================================================

const API_BASE = '/api';

function getToken() {
    return localStorage.getItem('token');
}

function getUsuario() {
    const u = localStorage.getItem('usuario');
    return u ? JSON.parse(u) : null;
}

function guardarSesion(token, usuario) {
    localStorage.setItem('token', token);
    localStorage.setItem('usuario', JSON.stringify(usuario));
}

function cerrarSesion() {
    localStorage.removeItem('token');
    localStorage.removeItem('usuario');
    window.location.href = '/index.html';
}

async function apiFetch(endpoint, options = {}) {
    const token = getToken();

    const headers = {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(options.headers || {})
    };

    const config = {
        ...options,
        headers
    };

    // Si el body es FormData, quitar Content-Type para que el browser lo maneje
    if (options.body instanceof FormData) {
        delete headers['Content-Type'];
    }

    try {
        const response = await fetch(`${API_BASE}${endpoint}`, config);

        if (response.status === 401) {
            cerrarSesion();
            return;
        }

        const data = await response.json().catch(() => null);

        if (!response.ok) {
            throw { status: response.status, message: data?.error || 'Error en la solicitud' };
        }

        return data;
    } catch (err) {
        if (err.message && err.message.includes('fetch')) {
            throw { message: 'No se puede conectar con el servidor. Verifique que el backend esté corriendo.' };
        }
        throw err;
    }
}

/**
 * Descarga un archivo desde el backend con autenticación JWT.
 * Usa fetch + Blob para evitar necesitar el token en la URL.
 */
async function descargarArchivo(endpoint, nombreArchivo) {
    const token = getToken();
    const response = await fetch(`${API_BASE}${endpoint}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (response.status === 401) { cerrarSesion(); return; }
    if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw { message: data?.error || 'Error al descargar archivo' };
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = nombreArchivo;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// Métodos de conveniencia
const api = {
    get:      (endpoint) => apiFetch(endpoint, { method: 'GET' }),
    post:     (endpoint, body) => apiFetch(endpoint, { method: 'POST',  body: JSON.stringify(body) }),
    put:      (endpoint, body) => apiFetch(endpoint, { method: 'PUT',   body: JSON.stringify(body) }),
    patch:    (endpoint, body) => apiFetch(endpoint, { method: 'PATCH', body: JSON.stringify(body) }),
    delete:   (endpoint) => apiFetch(endpoint, { method: 'DELETE' }),
    upload:   (endpoint, formData) => apiFetch(endpoint, { method: 'POST', body: formData }),
    descargar: descargarArchivo,
    getToken,
    getUsuario,
    guardarSesion,
    cerrarSesion
};

window.api = api;
