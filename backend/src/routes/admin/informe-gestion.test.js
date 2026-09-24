// Permisos y contrato del endpoint /admin/informe-gestion (sin BD: servicios mockeados).
jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../services/informeGestion/informe', () => ({ generarInforme: jest.fn() }));
jest.mock('../../services/informeGestion/collerasSnapshot', () => ({ registrarSnapshot: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { generarInforme } = require('../../services/informeGestion/informe');
const { registrarSnapshot } = require('../../services/informeGestion/collerasSnapshot');
const router = require('./informe-gestion');

function llamar(metodo, url, rol, query = {}) {
    return new Promise((resolve) => {
        const req = { method: metodo, url, originalUrl: url, query, params: {}, headers: {}, body: {}, usuario: { id: 'u1', rol_evaluacion: rol }, get() { return undefined; } };
        const res = { statusCode: 200, headers: {}, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; resolve(this); return this; } };
        router(req, res, (err) => { res.statusCode = err ? 500 : 404; res.body = err ? { error: err.message } : {}; resolve(res); });
    });
}

beforeEach(() => { generarInforme.mockReset(); generarInforme.mockResolvedValue({ metadata: {} }); });

describe('GET /datos — permisos de lectura', () => {
    test.each([[null], ['director'], ['jefe_area']])('rol %s puede leer el informe', async (rol) => {
        const res = await llamar('GET', '/datos', rol, { desde: '2026-09-18', hasta: '2026-09-20' });
        expect(res.statusCode).toBe(200);
        expect(generarInforme).toHaveBeenCalledWith({ desde: '2026-09-18', hasta: '2026-09-20' });
    });

    test.each([['monitor'], ['analista'], ['comision_tecnica'], ['capacitador']])('rol %s recibe 403 (el informe incluye desempeño individual)', async (rol) => {
        const res = await llamar('GET', '/datos', rol, { desde: '2026-09-18', hasta: '2026-09-20' });
        expect(res.statusCode).toBe(403);
        expect(generarInforme).not.toHaveBeenCalled();
    });

    test('errores de parámetros se devuelven como 400; otros como 500', async () => {
        generarInforme.mockRejectedValueOnce(Object.assign(new Error('parámetros'), { status: 400 }));
        expect((await llamar('GET', '/datos', null, {})).statusCode).toBe(400);
        generarInforme.mockRejectedValueOnce(new Error('boom'));
        expect((await llamar('GET', '/datos', null, {})).statusCode).toBe(500);
    });
});

describe('importaciones e históricos — solo administrador pleno', () => {
    const rutas = [
        ['POST', '/catalogo/asociaciones/preview'], ['POST', '/catalogo/asociaciones/confirmar'],
        ['POST', '/historico/rodeos/preview'], ['POST', '/historico/rodeos/confirmar'],
        ['POST', '/historico/colleras/preview'], ['POST', '/historico/colleras/confirmar'],
        ['POST', '/colleras/snapshot']
    ];
    test.each(rutas)('%s %s bloquea a director, jefe_area y monitor con 403', async (metodo, url) => {
        for (const rol of ['director', 'jefe_area', 'monitor', 'analista']) {
            expect((await llamar(metodo, url, rol)).statusCode).toBe(403);
        }
    });
});

describe('montaje y aislamiento', () => {
    test('está montado en admin/index.js (detrás de soloAdmin) y no toca otras rutas', () => {
        const idx = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        expect(idx).toMatch(/router\.use\('\/informe-gestion', require\('\.\/informe-gestion'\)\)/);
        expect(idx.indexOf("router.use(soloAdmin)")).toBeLessThan(idx.indexOf('/informe-gestion'));
    });
    test('el endpoint no importa ni modifica reporte-deportivo ni control-gestion', () => {
        const src = fs.readFileSync(path.join(__dirname, 'informe-gestion.js'), 'utf8');
        expect(src).not.toMatch(/reporte-deportivo|controlGestion|control-gestion/);
    });
});

describe('POST /colleras/snapshot', () => {
    test('administrador pleno lo ejecuta y recibe el resultado (guardado o no)', async () => {
        registrarSnapshot.mockResolvedValueOnce({ guardado: false, motivo: 'YA_EXISTE_SNAPSHOT_VALIDO_DEL_DIA' });
        const res = await llamar('POST', '/colleras/snapshot', null);
        expect(res.statusCode).toBe(200);
        expect(res.body.motivo).toBe('YA_EXISTE_SNAPSHOT_VALIDO_DEL_DIA');
    });
    test('GET /datos NUNCA dispara un snapshot (no se guarda al refrescar la pantalla)', async () => {
        registrarSnapshot.mockClear();
        await llamar('GET', '/datos', null, { desde: '2026-09-18', hasta: '2026-09-20' });
        expect(registrarSnapshot).not.toHaveBeenCalled();
    });
});

describe('GET /rangos-rapidos', () => {
    test('devuelve último fin de semana (bloque de rodeo) y últimos 30 días para quienes pueden leer el informe', async () => {
        const res = await llamar('GET', '/rangos-rapidos', 'director');
        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('ultimo_fin_de_semana.desde');
        expect(res.body).toHaveProperty('ultimos_30_dias.hasta', res.body.hoy);
    });
    test('roles sin acceso al informe reciben 403', async () => {
        expect((await llamar('GET', '/rangos-rapidos', 'monitor')).statusCode).toBe(403);
    });
});
