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

    // Incidente 2026-11-25: antes, CUALQUIER error cuyo mensaje contuviera
    // "fetch" se mostraba como "No se puede conectar con el servidor" — un
    // 500 del backend con "TypeError: fetch failed" en el texto quedaba
    // disfrazado de caída de red. Ahora "sin conexión" es SOLO cuando fetch()
    // mismo falla (no hubo respuesta HTTP); si hubo respuesta, se clasifica
    // por su código HTTP y se conserva el mensaje funcional del backend.
    let response;
    try {
        response = await fetch(`${API_BASE}${endpoint}`, config);
    } catch (err) {
        throw apiErrores.sinRespuesta(err);
    }

    if (response.status === 401) {
        cerrarSesion();
        return;
    }

    let texto;
    try {
        texto = await response.text();
    } catch (err) {
        // La conexión se cortó mientras llegaba el cuerpo de la respuesta.
        throw apiErrores.sinRespuesta(err);
    }
    let data = null;
    let jsonValido = true;
    if (texto) {
        try { data = JSON.parse(texto); } catch (_) { jsonValido = false; }
    }

    if (!response.ok) {
        // `data` completo se incluye además de `message` para que endpoints que
        // devuelven info estructurada en el error (p.ej. 409 con advertencias
        // a confirmar) puedan leerla sin romper a quienes solo usan err.message.
        //
        // Diagnóstico "CONFIGURACION_DESIGNACION_INVALIDA" (Zonas Extremas):
        // el backend ya calcula un `detalle` legible (validarConfiguracion() /
        // mensaje de la RPC) en CADA error de configuración de designación,
        // pero antes de este cambio se descartaba acá — el administrador solo
        // veía el código genérico. Se concatena `detalle` cuando existe, sin
        // tocar `data` (los llamadores que ya leían err.data siguen igual).
        throw apiErrores.http(response.status, data, jsonValido && texto !== '');
    }

    // 2xx: el backend siempre responde JSON (app.js). Un HTML en una
    // respuesta "exitosa" (p.ej. una página de un proxy intermedio) nunca es
    // un resultado válido de la API. Cualquier otro cuerpo vacío o no-JSON
    // conserva el comportamiento histórico (null) para no romper llamadores.
    if (!jsonValido && /text\/html/i.test(apiErrores.contentType(response))) {
        throw { status: response.status, tipo: 'RESPUESTA_INVALIDA', message: 'El servidor devolvió una respuesta inválida. Intente nuevamente; si el problema persiste, contacte al administrador.', data: null };
    }
    return data;
}

// Clasificación de errores de apiFetch — encapsulada en UN solo nombre
// global (api.js es un script clásico compartido por todos los portales:
// cada declaración de nivel superior es global y podría chocar con otra).
const apiErrores = (() => {
    const MENSAJES_HTTP_POR_DEFECTO = {
        400: 'La solicitud contiene datos inválidos.',
        403: 'No tiene permisos para realizar esta acción.',
        404: 'El recurso solicitado no existe.',
        500: 'Error interno del servidor. Intente nuevamente; si el problema persiste, contacte al administrador.',
        502: 'El servidor no está disponible temporalmente. Intente nuevamente en unos minutos.',
        503: 'El servidor no está disponible temporalmente. Intente nuevamente en unos minutos.',
        504: 'El servidor tardó demasiado en responder. Intente nuevamente en unos minutos.'
    };

    // Patrones de detalle TÉCNICO que no deben llegar a la pantalla: trazas,
    // errores internos de JavaScript/red, SQL/PostgREST, URLs internas y
    // credenciales/tokens. Conservadores a propósito: un mensaje funcional en
    // español ("La contraseña debe tener 8 caracteres") nunca coincide.
    const PATRONES_DETALLE_TECNICO = [
        /\bat\s+[^\s()]+\s*\(?[^()\s]*:\d+:\d+\)?/,
        /\b(TypeError|ReferenceError|SyntaxError|RangeError|AbortError)\b/,
        /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_|socket hang up/i,
        /\/rest\/v1\/|https?:\/\/[^\s]*(supabase|onrender|localhost|127\.0\.0\.1)/i,
        /\beyJ[A-Za-z0-9_-]{15,}|\bBearer\s+\S{10,}|\bsb_(secret|publishable)_\S+|service_role|SUPABASE_SERVICE_KEY|JWT_SECRET/i,
        /SQLSTATE|\bPGRST\d+|duplicate key value|violates (check|foreign key|unique|not-null) constraint|syntax error at or near|relation "[^"]+" does not exist|column "[^"]+" (of relation|does not exist)/i
    ];

    function contieneDetalleTecnico(texto) {
        return PATRONES_DETALLE_TECNICO.some(p => p.test(texto));
    }

    // Devuelve el mensaje completo si es seguro; si no, el prefijo funcional
    // más largo (los mensajes del backend encadenan contexto con ": ", p.ej.
    // "No se pudo generar la simulación: No se pudieron cargar notas...:
    // TypeError: fetch failed" → "No se pudo generar la simulación: No se
    // pudieron cargar notas..."); o null si ni el primer tramo es seguro.
    function mensajeSeguro(mensaje) {
        if (typeof mensaje !== 'string' || !mensaje.trim()) return null;
        if (mensaje.length <= 600 && !contieneDetalleTecnico(mensaje)) return mensaje;
        const seguros = [];
        for (const t of mensaje.split(': ')) {
            if (!t.trim() || contieneDetalleTecnico(t)) break;
            seguros.push(t);
        }
        const prefijo = seguros.join(': ').trim();
        return prefijo && prefijo.length <= 600 ? prefijo : null;
    }

    // fetch() lanzó: no existe respuesta HTTP. Timeout/cancelación se
    // distinguen de la falta de conexión por el nombre del error (AbortSignal).
    function sinRespuesta(err) {
        const nombre = err && err.name;
        if (nombre === 'TimeoutError') {
            return { tipo: 'TIMEOUT', message: 'El servidor tardó demasiado en responder y la solicitud se canceló. Intente nuevamente.' };
        }
        if (nombre === 'AbortError') {
            return { tipo: 'CANCELADA', message: 'La solicitud fue cancelada antes de completarse.' };
        }
        return { tipo: 'CONEXION', message: 'No se puede conectar con el servidor. Verifique su conexión a internet e intente nuevamente.' };
    }

    function tipoHttp(status, esJson) {
        if (status === 502 || status === 503 || status === 504) return 'SERVIDOR_NO_DISPONIBLE';
        if (status >= 500) return esJson ? 'HTTP_500' : 'RESPUESTA_INVALIDA';
        if (status === 400) return 'HTTP_400';
        if (status === 401 || status === 403) return 'SIN_PERMISO';
        return 'HTTP_4XX';
    }

    // Hubo respuesta HTTP con error: se conserva el mensaje funcional del
    // backend (data.error + data.detalle) si es seguro mostrarlo.
    function http(status, data, esJson) {
        const tipo = tipoHttp(status, esJson);
        const generico = MENSAJES_HTTP_POR_DEFECTO[status]
            || (status >= 500 ? MENSAJES_HTTP_POR_DEFECTO[500] : 'Error en la solicitud');
        // Cuerpo no-JSON (p.ej. página HTML de un proxy): nunca se muestra.
        const mensajeBase = data && typeof data.error === 'string' && data.error.trim() ? data.error : null;
        if (!mensajeBase) return { status, tipo, message: generico, data };

        const original = data.detalle ? `${mensajeBase}: ${data.detalle}` : mensajeBase;
        const seguro = mensajeSeguro(original);
        if (seguro === original) return { status, tipo, message: original, data };

        // Se recortó información técnica. El detalle pertenece a los logs del
        // SERVIDOR: aquí no se registra en la consola del navegador ni se
        // deja en err.data (se reemplazan error/detalle por la versión
        // segura; el resto de los campos estructurados se conserva).
        const sufijo = status >= 500
            ? ` (error interno del servidor, HTTP ${status}). Intente nuevamente; si el problema persiste, contacte al administrador.`
            : '.';
        const message = seguro ? `${seguro}${sufijo}` : generico;
        const dataSegura = { ...data, error: message };
        delete dataSegura.detalle;
        return { status, tipo, message, data: dataSegura };
    }

    function contentType(response) {
        try { return (response.headers && response.headers.get && response.headers.get('content-type')) || ''; }
        catch (_) { return ''; }
    }

    return { sinRespuesta, http, mensajeSeguro, contentType };
})();

/**
 * Pide un archivo al backend con autenticación JWT y devuelve el Blob crudo
 * — sin decidir qué hacer con él. Lo usan tanto `descargar()` (fuerza la
 * descarga con un nombre) como cualquier pantalla que necesite "Ver" un PDF
 * en una pestaña nueva sin forzar su descarga (ver rodeos.html:
 * verPdfCartillaDelegado) — un `<a>` común no puede llevar el header
 * Authorization, así que ambas acciones necesitan pasar primero por acá.
 */
async function obtenerBlob(endpoint) {
    const token = getToken();
    const response = await fetch(`${API_BASE}${endpoint}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (response.status === 401) { cerrarSesion(); return; }
    if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw { message: data?.error || 'Error al obtener archivo' };
    }

    return response.blob();
}

/**
 * Descarga un archivo desde el backend con autenticación JWT.
 * Usa fetch + Blob para evitar necesitar el token en la URL.
 */
async function descargarArchivo(endpoint, nombreArchivo) {
    const blob = await obtenerBlob(endpoint);
    if (!blob) return; // 401 -> obtenerBlob ya redirigió a cerrarSesion()

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
    delete:     (endpoint)       => apiFetch(endpoint, { method: 'DELETE' }),
    deleteBody: (endpoint, body) => apiFetch(endpoint, { method: 'DELETE', body: JSON.stringify(body) }),
    upload:   (endpoint, formData) => apiFetch(endpoint, { method: 'POST', body: formData }),
    descargar: descargarArchivo,
    obtenerBlob,
    getToken,
    getUsuario,
    guardarSesion,
    cerrarSesion
};

window.api = api;
