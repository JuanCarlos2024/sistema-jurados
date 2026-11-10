// GET /api/admin/cartillas-delegado/:id/pdf — nombre de archivo (mejora):
// antes el header Content-Disposition usaba un nombre fijo que ignoraba la
// asociación y truncaba el club a 30 caracteres ('cartilla-delegado_CLUB_
// FECHA.pdf'). Ahora usa el mismo formato único del resto del sistema
// (ver services/cartillaDelegadoPdfNombreArchivo.js), ASOCIACION_CLUB_
// FECHA.pdf, sin truncar. Mismo patrón que cartillas-delegado.origen.test.js
// (router de Express invocado directamente, sin servidor HTTP).
jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../services/cartilla-delegado-pdf', () => ({ generarCartillaDelegadoPDF: jest.fn() }));
jest.mock('../../services/historialResponsableInstitucional', () => ({ obtenerHistorialResponsables: jest.fn().mockResolvedValue([]) }));
jest.mock('../../services/emailService', () => ({ enviarEmail: jest.fn() }));

const supabase = require('../../config/supabase');
const { generarCartillaDelegadoPDF } = require('../../services/cartilla-delegado-pdf');
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
    generarCartillaDelegadoPDF.mockReset();
    generarCartillaDelegadoPDF.mockResolvedValue(Buffer.from('pdf-content'));
});

function crearResFake() {
    const res = { headers: {} };
    res.statusCode = 200;
    res.status = jest.fn((c) => { res.statusCode = c; return res; });
    res.jsonBody = null;
    res.json = jest.fn((p) => { res.jsonBody = p; return res; });
    res.setHeader = jest.fn((k, v) => { res.headers[k] = v; return res; });
    res.end = jest.fn((p) => { res.ended = true; return res; });
    return res;
}
function llamar(cartillaId) {
    return new Promise((resolve, reject) => {
        const ruta = '/' + cartillaId + '/pdf';
        const req = { method: 'GET', url: ruta, originalUrl: ruta, params: {}, query: {}, usuario: { id: 'admin-1' }, ip: '127.0.0.1' };
        const res = crearResFake();
        const endOriginal = res.end;
        res.end = (p) => { endOriginal(p); resolve(res); return res; };
        const jsonOriginal = res.json;
        res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}

describe('GET /:id/pdf — nombre de archivo ASOCIACION_CLUB_FECHA.pdf', () => {
    test('caso real EL BOSQUE PONIENTE / SANTIAGO PONIENTE / 2026-11-01 -> Content-Disposition con el nombre exacto, sin truncar', async () => {
        respuestas.cartillas_delegado = {
            single: {
                data: {
                    id: 'cart-1', estado: 'enviada', fecha_rodeo: '2026-11-01', delegado_asociacion_id: null,
                    rodeo: { id: 'rodeo-1', club: 'EL BOSQUE PONIENTE', asociacion: 'SANTIAGO PONIENTE', fecha: '2026-11-01' }
                },
                error: null
            }
        };
        const res = await llamar('cart-1');
        expect(res.statusCode).toBe(200);
        expect(res.headers['Content-Disposition']).toBe('attachment; filename="SANTIAGO-PONIENTE_EL-BOSQUE-PONIENTE_2026-11-01.pdf"');
    });

    test('club con más de 30 caracteres -> ya NO se trunca (antes el nombre fijo cortaba a 30 caracteres)', async () => {
        const clubLargo = 'ASOCIACION DEPORTIVA DE RODEO MUY LARGA Y COMPUESTA';
        respuestas.cartillas_delegado = {
            single: {
                data: {
                    id: 'cart-2', estado: 'enviada', fecha_rodeo: '2026-11-01', delegado_asociacion_id: null,
                    rodeo: { id: 'rodeo-2', club: clubLargo, asociacion: 'SANTIAGO PONIENTE', fecha: '2026-11-01' }
                },
                error: null
            }
        };
        const res = await llamar('cart-2');
        expect(res.statusCode).toBe(200);
        expect(res.headers['Content-Disposition']).toContain('ASOCIACION-DEPORTIVA-DE-RODEO-MUY-LARGA-Y-COMPUESTA');
    });

    test('cartilla no encontrada -> 404, nunca intenta generar el PDF', async () => {
        const res = await llamar('cart-x');
        expect(res.statusCode).toBe(404);
        expect(generarCartillaDelegadoPDF).not.toHaveBeenCalled();
    });
});
