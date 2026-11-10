// MEJORA 3 — verPdfCartillaDelegado()/descargarPdfCartillaDelegado() en
// rodeos.html, ya que el bug real era que api.obtenerBlob no existía (ver
// api.obtenerBlob.test.js). Acá se verifica que ESTAS dos funciones (las que
// el botón llama) siguen usando api.obtenerBlob/api.descargar correctamente,
// abren el PDF en pestaña nueva (nunca fuerzan descarga en "Ver"), y pasan
// el nombre de archivo automático a "Descargar" — mismo patrón de extracción
// real que rodeosCartillaDelegadoReabrir.test.js.
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'rodeos.html'), 'utf8').replace(/\r\n/g, '\n');

function extraerFuncion(nombre) {
    let inicio = html.indexOf(`function ${nombre}(`);
    if (inicio === -1) throw new Error(`No se encontró function ${nombre}(...) en rodeos.html`);
    // verPdfCartillaDelegado/descargarPdfCartillaDelegado son `async
    // function` — si no se incluye "async " en el texto extraído, el
    // `await` de adentro queda en una función NO async (SyntaxError).
    if (html.slice(Math.max(0, inicio - 6), inicio) === 'async ') inicio -= 6;
    let i = html.indexOf('{', inicio);
    let profundidad = 0;
    for (; i < html.length; i++) {
        if (html[i] === '{') profundidad++;
        else if (html[i] === '}') { profundidad--; if (profundidad === 0) { i++; break; } }
    }
    return html.slice(inicio, i);
}

function construirEntorno({ obtenerBlobImpl, descargarImpl } = {}) {
    const toasts = [];
    const aperturas = [];
    const apiFalso = {
        obtenerBlob: obtenerBlobImpl || (() => Promise.resolve({ _esBlob: true })),
        descargar: descargarImpl || (() => Promise.resolve())
    };
    const windowFalso = { open: (url, target) => aperturas.push({ url, target }) };
    const URLFalso = { createObjectURL: () => 'blob:fake-url', revokeObjectURL: () => {} };
    const mostrarToast = (msg, tipo) => toasts.push({ msg, tipo });
    const nombreArchivoCartillaDelegadoPdf = () => 'ASOCIACION_CLUB_2026-11-07.pdf';
    const setTimeoutFalso = () => {}; // nunca se necesita esperar el revokeObjectURL real en el test

    const codigo = extraerFuncion('verPdfCartillaDelegado') + '\n' + extraerFuncion('descargarPdfCartillaDelegado');
    // eslint-disable-next-line no-new-func
    const fabrica = new Function('api', 'window', 'URL', 'mostrarToast', 'nombreArchivoCartillaDelegadoPdf', 'setTimeout', '_cdActivaData',
        `${codigo}\nreturn { verPdfCartillaDelegado, descargarPdfCartillaDelegado };`);
    const { verPdfCartillaDelegado, descargarPdfCartillaDelegado } = fabrica(
        apiFalso, windowFalso, URLFalso, mostrarToast, nombreArchivoCartillaDelegadoPdf, setTimeoutFalso, { id: 'cart-1' }
    );
    return { verPdfCartillaDelegado, descargarPdfCartillaDelegado, toasts, aperturas, apiFalso };
}

describe('verPdfCartillaDelegado() — botón "Ver PDF" principal', () => {
    test('pide el Blob vía api.obtenerBlob (nunca api.descargar) y lo abre en pestaña nueva, nunca fuerza la descarga', async () => {
        let endpointVisto = null;
        const { verPdfCartillaDelegado, aperturas } = construirEntorno({
            obtenerBlobImpl: (ep) => { endpointVisto = ep; return Promise.resolve({ _esBlob: true }); }
        });
        await verPdfCartillaDelegado('cart-1');
        expect(endpointVisto).toBe('/admin/cartillas-delegado/cart-1/pdf');
        expect(aperturas).toEqual([{ url: 'blob:fake-url', target: '_blank' }]);
    });

    test('obtenerBlob retorna undefined (401 ya manejado por api.js) -> no abre nada, no lanza excepción', async () => {
        const { verPdfCartillaDelegado, aperturas } = construirEntorno({ obtenerBlobImpl: () => Promise.resolve(undefined) });
        await expect(verPdfCartillaDelegado('cart-1')).resolves.not.toThrow();
        expect(aperturas).toHaveLength(0);
    });

    test('error 404/500 -> muestra un toast de error legible, nunca una excepción sin manejar', async () => {
        const { verPdfCartillaDelegado, toasts } = construirEntorno({
            obtenerBlobImpl: () => Promise.reject({ message: 'Cartilla no encontrada.' })
        });
        await verPdfCartillaDelegado('cart-1');
        expect(toasts).toEqual([{ msg: 'Cartilla no encontrada.', tipo: 'error' }]);
    });
});

describe('descargarPdfCartillaDelegado() — botón "Descargar PDF" principal', () => {
    test('usa api.descargar con el endpoint correcto y el nombre de archivo automático', async () => {
        let args = null;
        const { descargarPdfCartillaDelegado } = construirEntorno({
            descargarImpl: (ep, nombre) => { args = [ep, nombre]; return Promise.resolve(); }
        });
        await descargarPdfCartillaDelegado('cart-1');
        expect(args).toEqual(['/admin/cartillas-delegado/cart-1/pdf', 'ASOCIACION_CLUB_2026-11-07.pdf']);
    });

    test('error en la descarga -> muestra un toast de error, nunca una excepción sin manejar', async () => {
        const { descargarPdfCartillaDelegado, toasts } = construirEntorno({
            descargarImpl: () => Promise.reject({ message: 'Error al obtener archivo' })
        });
        await descargarPdfCartillaDelegado('cart-1');
        expect(toasts).toEqual([{ msg: 'Error al obtener archivo', tipo: 'error' }]);
    });
});
