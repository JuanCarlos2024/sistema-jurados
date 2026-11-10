// 096 — POST /version/:version_id/actualizar-diseno-pdf y el cambio en
// GET /version/:version_id/pdf para preferir el PDF rediseñado. Mismo
// patrón de mocking que cartillas-delegado.reabrirVersiones.test.js
// (router de Express invocado directamente, sin servidor HTTP).
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
function llamar(method, ruta, body, query) {
    return new Promise((resolve, reject) => {
        const req = { method, url: ruta, originalUrl: ruta, body: body || {}, params: {}, query: query || {}, ip: '127.0.0.1', usuario: { id: 'admin-1' } };
        const res = crearResFake();
        const jsonOriginal = res.json;
        res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}

describe('GET /version/:version_id/pdf — preferencia por el diseño actualizado (096)', () => {
    test('sin storage_path_pdf_rediseno -> firma el PDF original, tiene_rediseno=false, mostrando="original"', async () => {
        respuestas.cartillas_delegado_versiones = {
            maybeSingle: { data: { numero_version: 1, storage_path_pdf: 'r/v1.pdf', storage_path_pdf_rediseno: null, snapshot: {} }, error: null }
        };
        const createSignedUrl = jest.fn().mockResolvedValue({ data: { signedUrl: 'https://signed/v1.pdf' }, error: null });
        supabase.storage.from.mockReturnValue({ createSignedUrl });

        const res = await llamar('GET', '/version/v1/pdf');

        expect(res.statusCode).toBe(200);
        expect(createSignedUrl).toHaveBeenCalledWith('r/v1.pdf', 3600);
        expect(res.jsonBody.tiene_rediseno).toBe(false);
        expect(res.jsonBody.mostrando).toBe('original');
    });

    test('con storage_path_pdf_rediseno -> firma el PDF rediseñado por defecto, mostrando="rediseno"', async () => {
        respuestas.cartillas_delegado_versiones = {
            maybeSingle: { data: { numero_version: 1, storage_path_pdf: 'r/v1.pdf', storage_path_pdf_rediseno: 'r/v1_rediseno.pdf', snapshot: {} }, error: null }
        };
        const createSignedUrl = jest.fn().mockResolvedValue({ data: { signedUrl: 'https://signed/v1_rediseno.pdf' }, error: null });
        supabase.storage.from.mockReturnValue({ createSignedUrl });

        const res = await llamar('GET', '/version/v1/pdf');

        expect(res.statusCode).toBe(200);
        expect(createSignedUrl).toHaveBeenCalledWith('r/v1_rediseno.pdf', 3600);
        expect(res.jsonBody.tiene_rediseno).toBe(true);
        expect(res.jsonBody.mostrando).toBe('rediseno');
    });

    test('con storage_path_pdf_rediseno pero ?original=1 -> fuerza el PDF original, nunca se pierde el acceso a él', async () => {
        respuestas.cartillas_delegado_versiones = {
            maybeSingle: { data: { numero_version: 1, storage_path_pdf: 'r/v1.pdf', storage_path_pdf_rediseno: 'r/v1_rediseno.pdf', snapshot: {} }, error: null }
        };
        const createSignedUrl = jest.fn().mockResolvedValue({ data: { signedUrl: 'https://signed/v1.pdf' }, error: null });
        supabase.storage.from.mockReturnValue({ createSignedUrl });

        const res = await llamar('GET', '/version/v1/pdf', null, { original: '1' });

        expect(res.statusCode).toBe(200);
        expect(createSignedUrl).toHaveBeenCalledWith('r/v1.pdf', 3600);
        expect(res.jsonBody.mostrando).toBe('original');
        expect(res.jsonBody.tiene_rediseno).toBe(true); // sigue informando que existe, aunque no se use ahora
    });
});

describe('POST /version/:version_id/actualizar-diseno-pdf (096)', () => {
    const { generarCartillaDelegadoPDF } = require('../../services/cartilla-delegado-pdf');

    test('sin motivo -> 422, nunca consulta la versión ni genera nada', async () => {
        const res = await llamar('POST', '/version/v1/actualizar-diseno-pdf', {});
        expect(res.statusCode).toBe(422);
        expect(res.jsonBody.code).toBe('MOTIVO_REQUERIDO');
        expect(supabase.from).not.toHaveBeenCalled();
        expect(generarCartillaDelegadoPDF).not.toHaveBeenCalled();
    });

    test('versión no encontrada -> 404', async () => {
        const res = await llamar('POST', '/version/v-x/actualizar-diseno-pdf', { motivo: 'Actualizar logo' });
        expect(res.statusCode).toBe(404);
        expect(generarCartillaDelegadoPDF).not.toHaveBeenCalled();
    });

    test('versión sin PDF original -> 422 SIN_PDF_ORIGINAL, nunca genera ni sube nada', async () => {
        respuestas.cartillas_delegado_versiones = { maybeSingle: { data: { id: 'v1', cartilla_delegado_id: 'cart-1', numero_version: 1, snapshot: { rodeo_id: 'rodeo-9' }, storage_path_pdf: null }, error: null } };
        const res = await llamar('POST', '/version/v1/actualizar-diseno-pdf', { motivo: 'Actualizar logo' });
        expect(res.statusCode).toBe(422);
        expect(res.jsonBody.code).toBe('SIN_PDF_ORIGINAL');
        expect(generarCartillaDelegadoPDF).not.toHaveBeenCalled();
    });

    test('éxito -> genera desde el snapshot (nunca datos en vivo), sube a una ruta "_rediseno_" y llama a la RPC nueva con motivo y actor', async () => {
        const snapshot = { id: 'cart-1', rodeo_id: 'rodeo-9', secretario_jurado: 'Secretario V1' };
        respuestas.cartillas_delegado_versiones = { maybeSingle: { data: { id: 'v1', cartilla_delegado_id: 'cart-1', numero_version: 1, snapshot, storage_path_pdf: 'rodeo-9/.../v1_original.pdf' }, error: null } };
        respuestas.rodeos = { maybeSingle: { data: { id: 'rodeo-9', club: 'Club X' }, error: null } };
        generarCartillaDelegadoPDF.mockResolvedValue(Buffer.from('pdf-rediseno'));
        const uploadMock = jest.fn().mockResolvedValue({ error: null });
        supabase.storage.from.mockReturnValue({ upload: uploadMock });
        supabase.rpc.mockResolvedValue({ data: { id: 'v1', storage_path_pdf_rediseno: 'rodeo-9/.../v1_rediseno_123.pdf' }, error: null });

        const res = await llamar('POST', '/version/v1/actualizar-diseno-pdf', { motivo: 'Actualización del formato visual institucional (logo + rediseño Nov-2026)' });

        expect(res.statusCode).toBe(200);
        expect(generarCartillaDelegadoPDF).toHaveBeenCalledWith(snapshot, { id: 'rodeo-9', club: 'Club X' });
        expect(uploadMock).toHaveBeenCalledWith(
            expect.stringContaining('_rediseno_'),
            Buffer.from('pdf-rediseno'),
            { contentType: 'application/pdf', upsert: false }
        );
        expect(supabase.rpc).toHaveBeenCalledWith('actualizar_diseno_pdf_version_cartilla_delegado', {
            p_version_historica_id: 'v1',
            p_storage_path_pdf_rediseno: expect.stringContaining('_rediseno_'),
            p_actor_id: 'admin-1',
            p_motivo: 'Actualización del formato visual institucional (logo + rediseño Nov-2026)',
            p_actor_tipo: 'administrador',
            p_reemplazo_confirmado: false
        });
        expect(res.jsonBody.mensaje).toContain('El PDF original se conserva intacto');
    });

    test('nunca llama a adjuntar_pdf_version_cartilla_delegado (la RPC de reemplazo del original) — siempre la RPC nueva', async () => {
        respuestas.cartillas_delegado_versiones = { maybeSingle: { data: { id: 'v1', cartilla_delegado_id: 'cart-1', numero_version: 1, snapshot: { rodeo_id: 'rodeo-9' }, storage_path_pdf: 'r/v1.pdf' }, error: null } };
        generarCartillaDelegadoPDF.mockResolvedValue(Buffer.from('x'));
        supabase.storage.from.mockReturnValue({ upload: jest.fn().mockResolvedValue({ error: null }) });
        supabase.rpc.mockResolvedValue({ data: {}, error: null });

        await llamar('POST', '/version/v1/actualizar-diseno-pdf', { motivo: 'x' });

        expect(supabase.rpc).toHaveBeenCalledTimes(1);
        expect(supabase.rpc).not.toHaveBeenCalledWith('adjuntar_pdf_version_cartilla_delegado', expect.anything());
    });

    test('la RPC rechaza con REEMPLAZO_NO_CONFIRMADO (ya había una actualización de diseño previa) -> 409', async () => {
        respuestas.cartillas_delegado_versiones = { maybeSingle: { data: { id: 'v1', cartilla_delegado_id: 'cart-1', numero_version: 1, snapshot: { rodeo_id: 'rodeo-9' }, storage_path_pdf: 'r/v1.pdf', storage_path_pdf_rediseno: 'r/v1_rediseno_viejo.pdf' }, error: null } };
        generarCartillaDelegadoPDF.mockResolvedValue(Buffer.from('x'));
        supabase.storage.from.mockReturnValue({ upload: jest.fn().mockResolvedValue({ error: null }) });
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'REEMPLAZO_NO_CONFIRMADO: ...' } });

        const res = await llamar('POST', '/version/v1/actualizar-diseno-pdf', { motivo: 'Actualizar otra vez' });

        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('REEMPLAZO_NO_CONFIRMADO');
    });

    test('confirmar_reemplazo=true -> se envía p_reemplazo_confirmado=true a la RPC', async () => {
        respuestas.cartillas_delegado_versiones = { maybeSingle: { data: { id: 'v1', cartilla_delegado_id: 'cart-1', numero_version: 1, snapshot: { rodeo_id: 'rodeo-9' }, storage_path_pdf: 'r/v1.pdf', storage_path_pdf_rediseno: 'r/v1_rediseno_viejo.pdf' }, error: null } };
        generarCartillaDelegadoPDF.mockResolvedValue(Buffer.from('x'));
        supabase.storage.from.mockReturnValue({ upload: jest.fn().mockResolvedValue({ error: null }) });
        supabase.rpc.mockResolvedValue({ data: {}, error: null });

        const res = await llamar('POST', '/version/v1/actualizar-diseno-pdf', { motivo: 'Actualizar otra vez', confirmar_reemplazo: true });

        expect(res.statusCode).toBe(200);
        expect(supabase.rpc).toHaveBeenCalledWith('actualizar_diseno_pdf_version_cartilla_delegado', expect.objectContaining({ p_reemplazo_confirmado: true }));
    });

    test('la RPC rechaza con SIN_PDF_ORIGINAL (defensa en profundidad) -> 422', async () => {
        respuestas.cartillas_delegado_versiones = { maybeSingle: { data: { id: 'v1', cartilla_delegado_id: 'cart-1', numero_version: 1, snapshot: { rodeo_id: 'rodeo-9' }, storage_path_pdf: 'r/v1.pdf' }, error: null } };
        generarCartillaDelegadoPDF.mockResolvedValue(Buffer.from('x'));
        supabase.storage.from.mockReturnValue({ upload: jest.fn().mockResolvedValue({ error: null }) });
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'SIN_PDF_ORIGINAL: ...' } });

        const res = await llamar('POST', '/version/v1/actualizar-diseno-pdf', { motivo: 'x' });

        expect(res.statusCode).toBe(422);
        expect(res.jsonBody.code).toBe('SIN_PDF_ORIGINAL');
    });

    test('falla la subida a Storage -> 500, nunca llega a llamar a la RPC', async () => {
        respuestas.cartillas_delegado_versiones = { maybeSingle: { data: { id: 'v1', cartilla_delegado_id: 'cart-1', numero_version: 1, snapshot: { rodeo_id: 'rodeo-9' }, storage_path_pdf: 'r/v1.pdf' }, error: null } };
        generarCartillaDelegadoPDF.mockResolvedValue(Buffer.from('x'));
        supabase.storage.from.mockReturnValue({ upload: jest.fn().mockResolvedValue({ error: { message: 'boom' } }) });

        const res = await llamar('POST', '/version/v1/actualizar-diseno-pdf', { motivo: 'x' });

        expect(res.statusCode).toBe(500);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });
});
