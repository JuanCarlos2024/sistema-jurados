// Fase 2C, sección 5 — wiring de GET /propuestas/:id/exportar/excel|pdf.
// La generación REAL del archivo (columnas, estilos, PDF) ya está cubierta
// en services/propuestaDesignacionExport.test.js contra ExcelJS/pdfkit
// reales — acá solo se verifica que la ruta llama al servicio con el id
// correcto y traduce null/excepción a 404/500, mismo patrón que el resto de
// los archivos de orquestación de este router.
jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
jest.mock('../../services/propuestaDesignacionExport', () => ({
    exportarPropuestaExcel: jest.fn(),
    exportarPropuestaPDF: jest.fn()
}));

const { exportarPropuestaExcel, exportarPropuestaPDF } = require('../../services/propuestaDesignacionExport');
const router = require('./propuesta-designacion');

function llamarRuta({ method, url }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, body: {}, query: {}, params: {}, headers: {}, ip: '127.0.0.1',
            usuario: { id: 'admin-test', tipo: 'administrador', rol_evaluacion: null },
            get() { return undefined; }
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(codigo) { this.statusCode = codigo; return this; },
            json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
            setHeader() {}, send() { resolve({ status: this.statusCode, body: null }); }
        };
        router(req, res, (err) => { if (err) reject(err); else resolve({ status: 404, body: { error: 'ruta no encontrada' } }); });
    });
}

beforeEach(() => jest.clearAllMocks());

describe('GET /propuestas/:id/exportar/excel', () => {
    test('llama exportarPropuestaExcel con el id de la ruta', async () => {
        // Simula lo que hace la implementación real: escribe directo en `res`
        // (setHeader + stream) y no delega la respuesta a la ruta.
        exportarPropuestaExcel.mockImplementation(async (id, res) => { res.send(); return true; });
        const { status } = await llamarRuta({ method: 'GET', url: '/propuestas/prop-1/exportar/excel' });
        expect(status).toBe(200);
        expect(exportarPropuestaExcel).toHaveBeenCalledWith('prop-1', expect.anything());
    });

    test('propuesta inexistente (servicio devuelve null) -> 404', async () => {
        exportarPropuestaExcel.mockResolvedValue(null);
        const { status, body } = await llamarRuta({ method: 'GET', url: '/propuestas/no-existe/exportar/excel' });
        expect(status).toBe(404);
        expect(body.error).toBe('La propuesta no existe.');
    });

    test('error del servicio -> 500, nunca una excepción sin capturar', async () => {
        exportarPropuestaExcel.mockRejectedValue(new Error('fallo simulado'));
        const { status, body } = await llamarRuta({ method: 'GET', url: '/propuestas/prop-1/exportar/excel' });
        expect(status).toBe(500);
        expect(body.error).toMatch(/fallo simulado/);
    });
});

describe('GET /propuestas/:id/exportar/pdf', () => {
    test('llama exportarPropuestaPDF con el id de la ruta', async () => {
        exportarPropuestaPDF.mockImplementation(async (id, res) => { res.send(); return true; });
        const { status } = await llamarRuta({ method: 'GET', url: '/propuestas/prop-1/exportar/pdf' });
        expect(status).toBe(200);
        expect(exportarPropuestaPDF).toHaveBeenCalledWith('prop-1', expect.anything());
    });

    test('propuesta inexistente -> 404', async () => {
        exportarPropuestaPDF.mockResolvedValue(null);
        const { status } = await llamarRuta({ method: 'GET', url: '/propuestas/no-existe/exportar/pdf' });
        expect(status).toBe(404);
    });
});
