// 092: POST /:id/reabrir, GET /:id/versiones y GET /version/:version_id/pdf —
// mismo patrón que cartillas-delegado.origen.test.js (router de Express
// invocado directamente, sin servidor HTTP).
jest.mock('../../config/supabase', () => ({
    from: jest.fn(), rpc: jest.fn(),
    storage: { from: jest.fn() }
}));
jest.mock('../../services/cartilla-delegado-pdf', () => ({ generarCartillaDelegadoPDF: jest.fn() }));
jest.mock('../../services/emailService', () => ({ enviarEmail: jest.fn() }));

const supabase = require('../../config/supabase');
const router = require('./cartillas-delegado');

let respuestas;
function crearChain(tabla) {
    const chain = {};
    ['select', 'eq', 'order', 'neq'].forEach(m => { chain[m] = () => chain; });
    chain.single = () => Promise.resolve(respuestas[tabla]?.single ?? { data: null, error: null });
    chain.maybeSingle = () => Promise.resolve(respuestas[tabla]?.maybeSingle ?? { data: null, error: null });
    chain.then = (resolve, reject) => Promise.resolve(respuestas[tabla]?.list ?? { data: [], error: null }).then(resolve, reject);
    return chain;
}

beforeEach(() => {
    respuestas = {};
    supabase.from.mockReset();
    supabase.from.mockImplementation(tabla => crearChain(tabla));
    supabase.rpc.mockReset();
    supabase.storage.from.mockReset();
    require('../../services/cartilla-delegado-pdf').generarCartillaDelegadoPDF.mockReset();
});

function crearResFake() {
    const res = {};
    res.statusCode = 200;
    res.status = jest.fn((c) => { res.statusCode = c; return res; });
    res.jsonBody = null;
    res.json = jest.fn((p) => { res.jsonBody = p; return res; });
    return res;
}
function llamar(method, ruta, body) {
    return new Promise((resolve, reject) => {
        const req = { method, url: ruta, originalUrl: ruta, body: body || {}, params: {}, query: {}, ip: '127.0.0.1', usuario: { id: 'admin-1' } };
        const res = crearResFake();
        const jsonOriginal = res.json;
        res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}

describe('POST /:id/reabrir', () => {
    test('motivo vacío -> 422, nunca llama a la RPC', async () => {
        const res = await llamar('POST', '/cart-1/reabrir', { motivo: '   ' });
        expect(res.statusCode).toBe(422);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('éxito -> llama a reabrir_cartilla_delegado con el actor/motivo correctos, devuelve la cartilla reabierta', async () => {
        supabase.rpc.mockResolvedValue({ data: { id: 'cart-1', estado: 'reabierta', motivo_reapertura: 'Falta corregir el nombre' }, error: null });
        const res = await llamar('POST', '/cart-1/reabrir', { motivo: 'Falta corregir el nombre' });
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.cartilla.estado).toBe('reabierta');
        expect(supabase.rpc).toHaveBeenCalledWith('reabrir_cartilla_delegado', {
            p_cartilla_id: 'cart-1', p_motivo: 'Falta corregir el nombre',
            p_actor_id: 'admin-1', p_actor_tipo: 'administrador', p_ip_address: '127.0.0.1'
        });
    });

    test('RPC rechaza con CARTILLA_NO_ENCONTRADA -> 404', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'CARTILLA_NO_ENCONTRADA' } });
        const res = await llamar('POST', '/cart-1/reabrir', { motivo: 'x' });
        expect(res.statusCode).toBe(404);
    });

    test('RPC rechaza con ESTADO_NO_REABRIBLE -> 409', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'ESTADO_NO_REABRIBLE: no se puede reabrir una cartilla en estado "borrador"' } });
        const res = await llamar('POST', '/cart-1/reabrir', { motivo: 'x' });
        expect(res.statusCode).toBe(409);
    });

    test('error genérico de la RPC -> 500 con el mensaje', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
        const res = await llamar('POST', '/cart-1/reabrir', { motivo: 'x' });
        expect(res.statusCode).toBe(500);
        expect(res.jsonBody.error).toBe('boom');
    });
});

describe('GET /:id/versiones', () => {
    test('devuelve el historial ordenado por numero_version descendente (tal cual lo entrega la consulta)', async () => {
        respuestas.cartillas_delegado_versiones = {
            list: {
                data: [
                    { id: 'v2', numero_version: 2, estado_version: 'reenviada', storage_path_pdf: 'p/v2.pdf' },
                    { id: 'v1', numero_version: 1, estado_version: 'enviada', storage_path_pdf: 'p/v1.pdf' }
                ], error: null
            }
        };
        const res = await llamar('GET', '/cart-1/versiones');
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.map(v => v.numero_version)).toEqual([2, 1]);
    });

    test('sin versiones -> 200 con arreglo vacío', async () => {
        const res = await llamar('GET', '/cart-1/versiones');
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody).toEqual([]);
    });
});

describe('GET /version/:version_id/pdf', () => {
    test('versión no encontrada -> 404', async () => {
        const res = await llamar('GET', '/version/v-x/pdf');
        expect(res.statusCode).toBe(404);
    });

    test('versión sin PDF adjunto todavía -> 404 con mensaje específico', async () => {
        respuestas.cartillas_delegado_versiones = { maybeSingle: { data: { storage_path_pdf: null }, error: null } };
        const res = await llamar('GET', '/version/v1/pdf');
        expect(res.statusCode).toBe(404);
        expect(res.jsonBody.error).toMatch(/aún no tiene/i);
    });

    test('versión con PDF -> devuelve URL firmada', async () => {
        respuestas.cartillas_delegado_versiones = { maybeSingle: { data: { storage_path_pdf: 'rodeos/cart-1/v1_123.pdf' }, error: null } };
        supabase.storage.from.mockReturnValue({
            createSignedUrl: jest.fn().mockResolvedValue({ data: { signedUrl: 'https://signed.example/v1.pdf' }, error: null })
        });
        const res = await llamar('GET', '/version/v1/pdf');
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.url).toBe('https://signed.example/v1.pdf');
        expect(supabase.storage.from).toHaveBeenCalledWith('rodeo-adjuntos');
    });
});

// Punto B (revisión final) — recuperación del PDF cuando falló tras el envío.
describe('POST /version/:version_id/regenerar-pdf', () => {
    const { generarCartillaDelegadoPDF } = require('../../services/cartilla-delegado-pdf');

    test('versión no encontrada -> 404, nunca intenta generar el PDF', async () => {
        const res = await llamar('POST', '/version/v-x/regenerar-pdf');
        expect(res.statusCode).toBe(404);
        expect(generarCartillaDelegadoPDF).not.toHaveBeenCalled();
    });

    test('éxito -> genera el PDF desde el snapshot (nunca desde datos en vivo), lo sube y adjunta vía la RPC', async () => {
        const snapshot = { id: 'cart-1', rodeo_id: 'rodeo-9', secretario_jurado: 'Secretario V1' };
        respuestas.cartillas_delegado_versiones = { maybeSingle: { data: { id: 'v1', cartilla_delegado_id: 'cart-1', numero_version: 1, snapshot }, error: null } };
        respuestas.rodeos = { maybeSingle: { data: { id: 'rodeo-9', club: 'Club X' }, error: null } };
        generarCartillaDelegadoPDF.mockResolvedValue(Buffer.from('pdf-content'));
        const uploadMock = jest.fn().mockResolvedValue({ error: null });
        supabase.storage.from.mockReturnValue({ upload: uploadMock });
        supabase.rpc.mockResolvedValue({ data: { id: 'v1', storage_path_pdf: 'rodeo-9/cartillas-delegado-versiones/cart-1/v1_123.pdf' }, error: null });

        const res = await llamar('POST', '/version/v1/regenerar-pdf');

        expect(res.statusCode).toBe(200);
        expect(generarCartillaDelegadoPDF).toHaveBeenCalledWith(snapshot, { id: 'rodeo-9', club: 'Club X' });
        expect(uploadMock).toHaveBeenCalledWith(expect.stringContaining('rodeo-9/cartillas-delegado-versiones/cart-1/v1_'), Buffer.from('pdf-content'), { contentType: 'application/pdf', upsert: false });
        expect(supabase.rpc).toHaveBeenCalledWith('adjuntar_pdf_version_cartilla_delegado', expect.objectContaining({ p_version_historica_id: 'v1' }));
        expect(res.jsonBody.version.storage_path_pdf).toBe('rodeo-9/cartillas-delegado-versiones/cart-1/v1_123.pdf');
    });

    test('nunca modifica snapshot ni crea una versión nueva — solo llama a adjuntar_pdf_version_cartilla_delegado (nunca a registrar_envio_oficial_cartilla_delegado)', async () => {
        respuestas.cartillas_delegado_versiones = { maybeSingle: { data: { id: 'v1', cartilla_delegado_id: 'cart-1', numero_version: 1, snapshot: { rodeo_id: 'rodeo-9' } }, error: null } };
        generarCartillaDelegadoPDF.mockResolvedValue(Buffer.from('x'));
        supabase.storage.from.mockReturnValue({ upload: jest.fn().mockResolvedValue({ error: null }) });
        supabase.rpc.mockResolvedValue({ data: {}, error: null });

        await llamar('POST', '/version/v1/regenerar-pdf');

        expect(supabase.rpc).toHaveBeenCalledTimes(1);
        expect(supabase.rpc).not.toHaveBeenCalledWith('registrar_envio_oficial_cartilla_delegado', expect.anything());
    });

    test('revisión final — la versión YA tiene un PDF y no se envía motivo -> 422, nunca intenta generar/subir nada', async () => {
        respuestas.cartillas_delegado_versiones = { maybeSingle: { data: { id: 'v1', cartilla_delegado_id: 'cart-1', numero_version: 1, snapshot: { rodeo_id: 'rodeo-9' }, storage_path_pdf: 'rodeo-9/.../v1_old.pdf' }, error: null } };

        const res = await llamar('POST', '/version/v1/regenerar-pdf');

        expect(res.statusCode).toBe(422);
        expect(res.jsonBody.code).toBe('MOTIVO_REQUERIDO_PARA_REEMPLAZO');
        expect(generarCartillaDelegadoPDF).not.toHaveBeenCalled();
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('revisión final — la versión YA tiene un PDF y SÍ se envía motivo -> procede y pasa el motivo/actor a la RPC', async () => {
        respuestas.cartillas_delegado_versiones = { maybeSingle: { data: { id: 'v1', cartilla_delegado_id: 'cart-1', numero_version: 1, snapshot: { rodeo_id: 'rodeo-9' }, storage_path_pdf: 'rodeo-9/.../v1_old.pdf' }, error: null } };
        generarCartillaDelegadoPDF.mockResolvedValue(Buffer.from('x'));
        supabase.storage.from.mockReturnValue({ upload: jest.fn().mockResolvedValue({ error: null }) });
        supabase.rpc.mockResolvedValue({ data: { storage_path_pdf: 'rodeo-9/.../v1_new.pdf' }, error: null });

        const res = await llamar('POST', '/version/v1/regenerar-pdf', { motivo: 'El PDF original quedó corrupto' });

        expect(res.statusCode).toBe(200);
        expect(supabase.rpc).toHaveBeenCalledWith('adjuntar_pdf_version_cartilla_delegado', expect.objectContaining({
            p_version_historica_id: 'v1', p_actor_id: 'admin-1', p_actor_tipo: 'administrador', p_motivo: 'El PDF original quedó corrupto'
        }));
    });

    test('revisión final — la RPC rechaza con MOTIVO_REQUERIDO_PARA_REEMPLAZO (defensa en profundidad) -> 422', async () => {
        respuestas.cartillas_delegado_versiones = { maybeSingle: { data: { id: 'v1', cartilla_delegado_id: 'cart-1', numero_version: 1, snapshot: { rodeo_id: 'rodeo-9' }, storage_path_pdf: null }, error: null } };
        generarCartillaDelegadoPDF.mockResolvedValue(Buffer.from('x'));
        supabase.storage.from.mockReturnValue({ upload: jest.fn().mockResolvedValue({ error: null }) });
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'MOTIVO_REQUERIDO_PARA_REEMPLAZO: ...' } });

        const res = await llamar('POST', '/version/v1/regenerar-pdf');

        expect(res.statusCode).toBe(422);
        expect(res.jsonBody.code).toBe('MOTIVO_REQUERIDO_PARA_REEMPLAZO');
    });

    test('falla la subida a Storage -> 500, nunca llega a llamar a la RPC de adjuntar', async () => {
        respuestas.cartillas_delegado_versiones = { maybeSingle: { data: { id: 'v1', cartilla_delegado_id: 'cart-1', numero_version: 1, snapshot: { rodeo_id: 'rodeo-9' } }, error: null } };
        generarCartillaDelegadoPDF.mockResolvedValue(Buffer.from('x'));
        supabase.storage.from.mockReturnValue({ upload: jest.fn().mockResolvedValue({ error: { message: 'boom' } }) });

        const res = await llamar('POST', '/version/v1/regenerar-pdf');

        expect(res.statusCode).toBe(500);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });
});
