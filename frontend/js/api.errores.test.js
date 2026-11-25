// Incidente 2026-11-25 — un 500 del backend cuyo texto contenía "TypeError:
// fetch failed" se mostraba como "No se puede conectar con el servidor"
// porque apiFetch clasificaba por la palabra "fetch". Ejecuta el código REAL
// de frontend/js/api.js (mismo patrón que api.obtenerBlob.test.js).
const fs = require('fs');
const path = require('path');

const codigo = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8').replace(/\r\n/g, '\n');

function entorno(fetchImpl) {
    const store = { token: 'tok-123', usuario: JSON.stringify({ id: 'u1' }) };
    const localStorageFalso = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = v; },
        removeItem: (k) => { delete store[k]; }
    };
    const redirecciones = [];
    const windowFalso = { location: {} };
    Object.defineProperty(windowFalso.location, 'href', { set(v) { redirecciones.push(v); }, get() { return redirecciones[redirecciones.length - 1]; } });
    const advertencias = [];
    // Registra CUALQUIER salida a consola: api.js no debe escribir nada (incidente 2026-11-25).
    const registrar = (...a) => advertencias.push(a.join(' '));
    const consolaFalsa = { warn: registrar, error: registrar, log: registrar, info: registrar, debug: registrar };
    // eslint-disable-next-line no-new-func
    const fabrica = new Function('fetch', 'localStorage', 'URL', 'document', 'window', 'console',
        `${codigo}\nreturn window.api;`);
    const api = fabrica(fetchImpl, localStorageFalso, {}, {}, windowFalso, consolaFalsa);
    return { api, store, redirecciones, advertencias };
}

function respuesta(status, cuerpo, contentType = 'application/json; charset=utf-8') {
    const texto = cuerpo === undefined ? '' : (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo));
    return {
        status, ok: status >= 200 && status < 300,
        headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
        text: () => Promise.resolve(texto)
    };
}

async function capturar(promesa) {
    try { return { valor: await promesa }; } catch (e) { return { error: e }; }
}

const MENSAJE_INCIDENTE = 'No se pudo generar la simulación: No se pudieron cargar notas para métricas de rendimiento: TypeError: fetch failed';

describe('apiFetch — sin respuesta HTTP', () => {
    test('fetch rechazado (red caída / CORS) → CONEXION', async () => {
        const { api } = entorno(() => Promise.reject(new TypeError('Failed to fetch')));
        const { error } = await capturar(api.get('/x'));
        expect(error.tipo).toBe('CONEXION');
        expect(error.message).toMatch(/^No se puede conectar con el servidor/);
        expect(error.status).toBeUndefined();
    });
    test('timeout (AbortSignal.timeout) → TIMEOUT', async () => {
        const e = new Error('signal timed out'); e.name = 'TimeoutError';
        const { api } = entorno(() => Promise.reject(e));
        const { error } = await capturar(api.get('/x'));
        expect(error.tipo).toBe('TIMEOUT');
        expect(error.message).toMatch(/tardó demasiado/);
    });
    test('cancelación (AbortController) → CANCELADA', async () => {
        const e = new Error('The user aborted a request.'); e.name = 'AbortError';
        const { api } = entorno(() => Promise.reject(e));
        const { error } = await capturar(api.get('/x'));
        expect(error.tipo).toBe('CANCELADA');
    });
    test('conexión cortada mientras llega el cuerpo → CONEXION', async () => {
        const { api } = entorno(() => Promise.resolve({ status: 200, ok: true, headers: { get: () => null }, text: () => Promise.reject(new TypeError('network error')) }));
        const { error } = await capturar(api.get('/x'));
        expect(error.tipo).toBe('CONEXION');
    });
});

describe('apiFetch — el incidente: un 500 que menciona "fetch" NO es un error de conexión', () => {
    test('se clasifica como HTTP_500 y conserva la parte funcional, sin detalle técnico', async () => {
        const { api, advertencias } = entorno(() => Promise.resolve(respuesta(500, { error: MENSAJE_INCIDENTE })));
        const { error } = await capturar(api.post('/admin/propuesta-designacion/dry-run', { rodeo_ids: ['a'] }));
        expect(error.tipo).toBe('HTTP_500');
        expect(error.status).toBe(500);
        expect(error.message).not.toMatch(/No se puede conectar/);
        expect(error.message).not.toMatch(/fetch|TypeError/);
        expect(error.message).toMatch(/^No se pudo generar la simulación: No se pudieron cargar notas para métricas de rendimiento \(error interno del servidor, HTTP 500\)/);
        // El detalle técnico pertenece SOLO a los logs del servidor: ni en la
        // consola del navegador ni en err.data.
        expect(advertencias).toEqual([]);
        expect(JSON.stringify(error)).not.toMatch(/fetch failed|TypeError/);
        expect(error.data.error).toBe(error.message);
    });
    test('el saneo de err.data conserva los demás campos estructurados (p.ej. referencia)', async () => {
        const { api, advertencias } = entorno(() => Promise.resolve(respuesta(500, { error: 'Falla: TypeError: x is undefined', detalle: 'at f (/app/a.js:1:2)', referencia: 'DR-1A2B3C4D' })));
        const { error } = await capturar(api.get('/x'));
        expect(error.data).toEqual({ error: error.message, referencia: 'DR-1A2B3C4D' });
        expect(advertencias).toEqual([]);
    });
    test('el mensaje seguro del dry-run corregido (con referencia) se muestra completo', async () => {
        const cuerpo = { error: 'No se pudo generar la simulación: No se pudieron cargar notas para métricas de rendimiento. Intente nuevamente; si el problema persiste, informe la referencia DR-0A1B2C3D.', referencia: 'DR-0A1B2C3D' };
        const { api } = entorno(() => Promise.resolve(respuesta(500, cuerpo)));
        const { error } = await capturar(api.post('/admin/propuesta-designacion/dry-run', {}));
        expect(error).toEqual({ status: 500, tipo: 'HTTP_500', message: cuerpo.error, data: cuerpo });
    });
    test('un mensaje funcional que contiene la palabra "fetch" sin ser técnico se muestra tal cual', async () => {
        const { api } = entorno(() => Promise.resolve(respuesta(400, { error: 'El parámetro prefetch no es válido' })));
        const { error } = await capturar(api.get('/x'));
        expect(error.message).toBe('El parámetro prefetch no es válido');
        expect(error.tipo).toBe('HTTP_400');
    });
});

describe('apiFetch — respuestas HTTP con error', () => {
    test('400 conserva el mensaje funcional y concatena `detalle` (comportamiento previo)', async () => {
        const data = { error: 'CONFIGURACION_DESIGNACION_INVALIDA', detalle: 'La matriz no tiene categorías elegibles' };
        const { api } = entorno(() => Promise.resolve(respuesta(400, data)));
        const { error } = await capturar(api.post('/x', {}));
        expect(error).toEqual({ status: 400, tipo: 'HTTP_400', message: 'CONFIGURACION_DESIGNACION_INVALIDA: La matriz no tiene categorías elegibles', data });
    });
    test('400 sin cuerpo JSON → mensaje genérico de datos inválidos', async () => {
        const { api } = entorno(() => Promise.resolve(respuesta(400, '', 'text/plain')));
        const { error } = await capturar(api.get('/x'));
        expect(error.message).toBe('La solicitud contiene datos inválidos.');
    });
    test('mensajes funcionales con "contraseña" no se censuran', async () => {
        const { api } = entorno(() => Promise.resolve(respuesta(400, { error: 'La contraseña debe tener al menos 8 caracteres' })));
        const { error } = await capturar(api.post('/x', {}));
        expect(error.message).toBe('La contraseña debe tener al menos 8 caracteres');
    });
    test('401 mantiene el cierre de sesión existente y no lanza', async () => {
        const { api, store, redirecciones } = entorno(() => Promise.resolve(respuesta(401, { error: 'Token expirado' })));
        const { valor, error } = await capturar(api.get('/x'));
        expect(error).toBeUndefined();
        expect(valor).toBeUndefined();
        expect(store.token).toBeUndefined();
        expect(redirecciones).toEqual(['/index.html']);
    });
    test('403 → SIN_PERMISO con el mensaje del backend (consumidores que miran e.status siguen igual)', async () => {
        const { api } = entorno(() => Promise.resolve(respuesta(403, { error: 'Sin asignación a este rodeo' })));
        const { error } = await capturar(api.get('/x'));
        expect(error).toMatchObject({ status: 403, tipo: 'SIN_PERMISO', message: 'Sin asignación a este rodeo' });
    });
    test('403 sin mensaje → genérico de permisos', async () => {
        const { api } = entorno(() => Promise.resolve(respuesta(403, {})));
        const { error } = await capturar(api.get('/x'));
        expect(error.message).toBe('No tiene permisos para realizar esta acción.');
    });
    test('409 conserva `data` estructurada (advertencias a confirmar)', async () => {
        const data = { error: 'Requiere confirmación', advertencias: [{ codigo: 'X' }] };
        const { api } = entorno(() => Promise.resolve(respuesta(409, data)));
        const { error } = await capturar(api.post('/x', {}));
        expect(error).toMatchObject({ status: 409, tipo: 'HTTP_4XX', message: 'Requiere confirmación' });
        expect(error.data.advertencias).toEqual([{ codigo: 'X' }]);
    });
    test('500 con mensaje funcional seguro → se muestra completo', async () => {
        const { api } = entorno(() => Promise.resolve(respuesta(500, { error: 'No se pudo guardar la propuesta' })));
        const { error } = await capturar(api.post('/x', {}));
        expect(error).toMatchObject({ status: 500, tipo: 'HTTP_500', message: 'No se pudo guardar la propuesta' });
    });
    test.each([
        ['token JWT', 'Error: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc'],
        ['traza', 'Falla at cargarDatos (/app/src/services/motor.js:120:15)'],
        ['SQL', 'duplicate key value violates unique constraint "x_pkey"'],
        ['URL interna', 'No responde https://abc.supabase.co/rest/v1/notas_rodeo'],
        ['clave', 'Falta SUPABASE_SERVICE_KEY']
    ])('500 con detalle técnico (%s) → nunca se muestra', async (_n, mensaje) => {
        const { api } = entorno(() => Promise.resolve(respuesta(500, { error: mensaje })));
        const { error } = await capturar(api.get('/x'));
        expect(error.message).not.toContain(mensaje);
        expect(error.message).not.toMatch(/eyJ|supabase\.co|duplicate key|motor\.js|SUPABASE_SERVICE_KEY/);
        expect(error.tipo).toBe('HTTP_500');
    });
    test('500 con cuerpo HTML → RESPUESTA_INVALIDA, sin mostrar el HTML', async () => {
        const { api } = entorno(() => Promise.resolve(respuesta(500, '<html>Internal</html>', 'text/html')));
        const { error } = await capturar(api.get('/x'));
        expect(error.tipo).toBe('RESPUESTA_INVALIDA');
        expect(error.message).not.toMatch(/html/i);
    });
    test.each([502, 503, 504])('%i con página HTML del proxy → SERVIDOR_NO_DISPONIBLE', async (status) => {
        const { api } = entorno(() => Promise.resolve(respuesta(status, '<!doctype html><title>Bad Gateway</title>', 'text/html')));
        const { error } = await capturar(api.get('/x'));
        expect(error.tipo).toBe('SERVIDOR_NO_DISPONIBLE');
        expect(error.status).toBe(status);
        expect(error.message).not.toMatch(/doctype|Bad Gateway|No se puede conectar/i);
    });
    test('503 con JSON funcional del backend → se conserva el mensaje', async () => {
        const { api } = entorno(() => Promise.resolve(respuesta(503, { error: 'Servicio en mantenimiento' })));
        const { error } = await capturar(api.get('/x'));
        expect(error).toMatchObject({ tipo: 'SERVIDOR_NO_DISPONIBLE', message: 'Servicio en mantenimiento' });
    });
});

describe('apiFetch — respuestas exitosas (sin regresiones)', () => {
    test('200 JSON → devuelve los datos', async () => {
        const { api } = entorno(() => Promise.resolve(respuesta(200, { ok: true, n: 3 })));
        expect(await api.get('/x')).toEqual({ ok: true, n: 3 });
    });
    test('200/204 sin cuerpo → null (como antes)', async () => {
        const { api } = entorno(() => Promise.resolve(respuesta(204, '')));
        expect(await api.delete('/x')).toBeNull();
    });
    test('200 no-JSON que no es HTML → null (como antes)', async () => {
        const { api } = entorno(() => Promise.resolve(respuesta(200, 'a;b\n1;2', 'text/csv')));
        expect(await api.get('/x')).toBeNull();
    });
    test('200 con HTML → RESPUESTA_INVALIDA', async () => {
        const { api } = entorno(() => Promise.resolve(respuesta(200, '<html>login proxy</html>', 'text/html')));
        const { error } = await capturar(api.get('/x'));
        expect(error.tipo).toBe('RESPUESTA_INVALIDA');
    });
    test('envía Authorization y Content-Type; FormData sin Content-Type (sin cambios)', async () => {
        const vistos = [];
        const { api } = entorno((url, opts) => { vistos.push({ url, opts }); return Promise.resolve(respuesta(200, {})); });
        await api.post('/y', { a: 1 });
        expect(vistos[0].url).toBe('/api/y');
        expect(vistos[0].opts.headers.Authorization).toBe('Bearer tok-123');
        expect(vistos[0].opts.headers['Content-Type']).toBe('application/json');
        expect(vistos[0].opts.body).toBe('{"a":1}');
    });
    test('api.js declara un solo nombre global nuevo (apiErrores) además de los existentes', () => {
        const nuevos = [...codigo.matchAll(/^(?:const|let|var|function|async function)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
        expect(nuevos.sort()).toEqual(['API_BASE', 'api', 'apiErrores', 'apiFetch', 'cerrarSesion', 'descargarArchivo', 'getToken', 'getUsuario', 'guardarSesion', 'obtenerBlob'].sort());
    });
});
