// MEJORA 3 — corrección del botón "Ver PDF" (error "api.obtenerBlob is not
// a function" en producción). Ejecuta el código REAL de frontend/js/api.js
// (nunca reimplementado) con fetch/localStorage/URL/document/window
// simulados — mismo patrón de "ejecución real de la función" ya usado en
// utils.protegerRuta.test.js, aplicado acá al archivo completo porque api.js
// es un script de nivel superior (sin función envolvente).
const fs = require('fs');
const path = require('path');

const codigo = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8').replace(/\r\n/g, '\n');

function construirEntorno({ token = 'tok-123', fetchImpl } = {}) {
    const store = { token, usuario: JSON.stringify({ id: 'u1' }) };
    const localStorageFalso = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = v; },
        removeItem: (k) => { delete store[k]; }
    };
    const anclasCreadas = [];
    const documentFalso = {
        createElement: (tag) => {
            const el = { tag, _clicked: false, click() { this._clicked = true; } };
            if (tag === 'a') anclasCreadas.push(el);
            return el;
        },
        body: { appendChild: () => {}, removeChild: () => {} }
    };
    const redirecciones = [];
    const windowFalso = { location: {} };
    Object.defineProperty(windowFalso.location, 'href', {
        set(v) { redirecciones.push(v); }, get() { return redirecciones[redirecciones.length - 1]; }
    });
    const urlRevocadas = [];
    const URLFalso = { createObjectURL: () => 'blob:fake-url', revokeObjectURL: (u) => urlRevocadas.push(u) };

    // eslint-disable-next-line no-new-func
    const fabrica = new Function('fetch', 'localStorage', 'URL', 'document', 'window',
        `${codigo}\nreturn window.api;`);
    const apiReal = fabrica(fetchImpl, localStorageFalso, URLFalso, documentFalso, windowFalso);
    return { apiReal, store, anclasCreadas, redirecciones, urlRevocadas, localStorageFalso };
}

function respuestaFalsa({ status = 200, ok = true, blobValor = { _esBlob: true }, jsonValor = null } = {}) {
    return {
        status, ok,
        blob: () => Promise.resolve(blobValor),
        json: () => Promise.resolve(jsonValor)
    };
}

describe('api.obtenerBlob — existe y es una función (regresión del bug exacto reportado)', () => {
    test('api.obtenerBlob está definida como función (antes: "api.obtenerBlob is not a function")', () => {
        const { apiReal } = construirEntorno({ fetchImpl: () => Promise.resolve(respuestaFalsa()) });
        expect(typeof apiReal.obtenerBlob).toBe('function');
    });

    test('envía el token JWT como header Authorization: Bearer', async () => {
        let headersVistos = null;
        const fetchImpl = (url, opts) => { headersVistos = opts.headers; return Promise.resolve(respuestaFalsa()); };
        const { apiReal } = construirEntorno({ token: 'MI-TOKEN-JWT', fetchImpl });
        await apiReal.obtenerBlob('/admin/cartillas-delegado/c1/pdf');
        expect(headersVistos.Authorization).toBe('Bearer MI-TOKEN-JWT');
    });

    test('llama a la URL correcta con /api como prefijo', async () => {
        let urlVista = null;
        const fetchImpl = (url) => { urlVista = url; return Promise.resolve(respuestaFalsa()); };
        const { apiReal } = construirEntorno({ fetchImpl });
        await apiReal.obtenerBlob('/admin/cartillas-delegado/c1/pdf');
        expect(urlVista).toBe('/api/admin/cartillas-delegado/c1/pdf');
    });

    test('devuelve el Blob crudo (nunca intenta interpretarlo como JSON)', async () => {
        const blobEsperado = { _esBlob: true, marcador: 'pdf-binario' };
        const fetchImpl = () => Promise.resolve(respuestaFalsa({ blobValor: blobEsperado }));
        const { apiReal } = construirEntorno({ fetchImpl });
        const resultado = await apiReal.obtenerBlob('/x');
        expect(resultado).toBe(blobEsperado);
    });

    test('401 -> cierra sesión (limpia token/usuario, redirige a /index.html) y retorna undefined, nunca lanza excepción', async () => {
        const fetchImpl = () => Promise.resolve(respuestaFalsa({ status: 401, ok: false }));
        const { apiReal, store, redirecciones } = construirEntorno({ fetchImpl });
        const resultado = await apiReal.obtenerBlob('/x');
        expect(resultado).toBeUndefined();
        expect(store.token).toBeUndefined();
        expect(store.usuario).toBeUndefined();
        expect(redirecciones).toEqual(['/index.html']);
    });

    test('404/500 (no-ok, no 401) -> lanza con el mensaje de error del backend, nunca intenta leer .blob()', async () => {
        const fetchImpl = () => Promise.resolve(respuestaFalsa({ status: 404, ok: false, jsonValor: { error: 'Cartilla no encontrada.' } }));
        const { apiReal } = construirEntorno({ fetchImpl });
        await expect(apiReal.obtenerBlob('/x')).rejects.toEqual({ message: 'Cartilla no encontrada.' });
    });

    test('500 sin cuerpo JSON legible -> mensaje de error genérico, nunca lanza un error distinto al tipo esperado', async () => {
        const fetchImpl = () => Promise.resolve({ status: 500, ok: false, json: () => Promise.reject(new Error('no es JSON')) });
        const { apiReal } = construirEntorno({ fetchImpl });
        await expect(apiReal.obtenerBlob('/x')).rejects.toEqual({ message: 'Error al obtener archivo' });
    });
});

describe('api.descargar — sigue funcionando igual tras la refactorización (nunca se rompió)', () => {
    test('éxito -> crea un <a download> con el blob obtenido, hace click y libera la URL temporal', async () => {
        const fetchImpl = () => Promise.resolve(respuestaFalsa());
        const { apiReal, anclasCreadas, urlRevocadas } = construirEntorno({ fetchImpl });
        await apiReal.descargar('/admin/cartillas-delegado/c1/pdf', 'ASOCIACION_CLUB_2026-11-07.pdf');
        expect(anclasCreadas).toHaveLength(1);
        expect(anclasCreadas[0].download).toBe('ASOCIACION_CLUB_2026-11-07.pdf');
        expect(anclasCreadas[0]._clicked).toBe(true);
        expect(urlRevocadas).toEqual(['blob:fake-url']);
    });

    test('401 durante la descarga -> nunca crea el <a> (ya lo maneja obtenerBlob), no lanza excepción', async () => {
        const fetchImpl = () => Promise.resolve(respuestaFalsa({ status: 401, ok: false }));
        const { apiReal, anclasCreadas } = construirEntorno({ fetchImpl });
        await expect(apiReal.descargar('/x', 'archivo.pdf')).resolves.toBeUndefined();
        expect(anclasCreadas).toHaveLength(0);
    });
});
