// ═════════════════════════════════════════════════════════════════════════
// Incidente 2026-11-25 — POST /dry-run: los errores INTERNOS ya no exponen
// el detalle técnico al navegador (antes: "No se pudo generar la simulación:
// ...: TypeError: fetch failed"). El detalle queda solo en el log del
// servidor (redactado) con una referencia que también recibe el usuario.
// Mismo patrón de orquestación que propuesta-designacion.motorGlobal.test.js.
// ═════════════════════════════════════════════════════════════════════════
jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
jest.mock('../../services/motorPropuestaDesignacion', () => {
    const real = jest.requireActual('../../services/motorPropuestaDesignacion');
    return { ...real, cargarDatosMotor: jest.fn(), ejecutarSimulacion: jest.fn(), generarSimulacion: jest.fn(), evaluarCandidatoDirecto: jest.fn() };
});
jest.mock('../../services/motorPropuestaDesignacionGlobal', () => {
    const real = jest.requireActual('../../services/motorPropuestaDesignacionGlobal');
    return { ...real, generarSimulacionGlobal: jest.fn() };
});
jest.mock('../../services/configuracionDesignacionRepositorio', () => ({
    cargarConfiguracionDesignacionActiva: jest.fn(),
    cargarConfiguracionDesignacionPorId: jest.fn()
}));

const supabase = require('../../config/supabase');
const { generarSimulacion } = require('../../services/motorPropuestaDesignacion');
const { generarSimulacionGlobal } = require('../../services/motorPropuestaDesignacionGlobal');
const { cargarConfiguracionDesignacionActiva } = require('../../services/configuracionDesignacionRepositorio');
const { construirConfiguracionDefaultV1 } = require('../../services/configuracionDesignacion');
const router = require('./propuesta-designacion');

const CONFIG_V1 = construirConfiguracionDefaultV1();
const META_V1 = { id: 'v1-uuid', numero_version: 1, schema_version: 1 };
const JWT = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJyb2xlIjoiZmljdGljaW8ifQ', 'firmaFicticia123'].join('.'); // ficticio, armado en ejecución
const PATRON_TECNICO = /TypeError|fetch failed|Cannot read|at \S+ \(|supabase\.co|\/rest\/v1|eyJ|duplicate key/;

function llamarRuta({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, body: body || {}, query: {}, params: {}, headers: {}, ip: '127.0.0.1',
            usuario: { id: 'admin-test', tipo: 'administrador', rol_evaluacion: null },
            get() { return undefined; }
        };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(payload) { resolve({ status: this.statusCode, body: payload }); return this; }
        };
        router(req, res, (err) => (err ? reject(err) : resolve({ status: 404, body: { error: 'ruta no encontrada' } })));
    });
}

function supabaseVacio() {
    supabase.from.mockImplementation(() => {
        const chain = {
            select: () => chain, eq: () => chain, in: () => chain, order: () => chain, range: () => chain,
            maybeSingle: () => Promise.resolve({ data: { id: 't1' }, error: null }),
            then: (r) => Promise.resolve({ data: [], error: null }).then(r)
        };
        return chain;
    });
}

let logs;
beforeEach(() => {
    jest.clearAllMocks();
    logs = [];
    jest.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
});
afterEach(() => console.error.mockRestore());

describe('POST /dry-run — errores internos sin detalle técnico hacia el navegador', () => {
    test('el caso exacto del incidente: 500 funcional + referencia; el detalle queda solo en el log', async () => {
        supabaseVacio();
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        generarSimulacionGlobal.mockRejectedValue(new Error('No se pudieron cargar notas para métricas de rendimiento: TypeError: fetch failed'));

        const { status, body } = await llamarRuta({ method: 'POST', url: '/dry-run', body: { rodeo_ids: ['r1'], motor: 'global' } });

        expect(status).toBe(500);
        expect(body.referencia).toMatch(/^DR-[0-9A-F]{8}$/);
        expect(body.error).toBe(`No se pudo generar la simulación: No se pudieron cargar notas para métricas de rendimiento. Intente nuevamente; si el problema persiste, informe la referencia ${body.referencia}.`);
        expect(JSON.stringify(body)).not.toMatch(PATRON_TECNICO);
        expect(logs.some(l => l.includes(`ref=${body.referencia}`) && l.includes('TypeError: fetch failed'))).toBe(true);
    });

    test('error de JavaScript del motor local → mensaje fijo, sin traza ni texto técnico', async () => {
        supabaseVacio();
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        generarSimulacion.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'fecha')"));

        const { status, body } = await llamarRuta({ method: 'POST', url: '/dry-run', body: { rodeo_ids: ['r1'] } });

        expect(status).toBe(500);
        expect(body.error).toMatch(/^No se pudo generar la simulación\. Intente nuevamente/);
        expect(JSON.stringify(body)).not.toMatch(PATRON_TECNICO);
        expect(logs.some(l => l.includes("Cannot read properties of undefined"))).toBe(true);
    });

    test('credenciales en el error: nunca en la respuesta y redactadas en el log', async () => {
        supabaseVacio();
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        generarSimulacion.mockRejectedValue(new Error(`No se pudo cargar jurados: JWT invalido ${JWT}`));

        const { body } = await llamarRuta({ method: 'POST', url: '/dry-run', body: { rodeo_ids: ['r1'] } });

        expect(body.error).toMatch(/^No se pudo generar la simulación: No se pudo cargar jurados\. /);
        expect(JSON.stringify(body)).not.toContain(JWT);
        expect(logs.join('\n')).not.toContain(JWT);
        expect(logs.join('\n')).toContain('[TOKEN REDACTADO]');
    });

    test('falla al cargar la configuración (excepción) → 500 funcional + referencia, ningún motor se ejecuta', async () => {
        cargarConfiguracionDesignacionActiva.mockRejectedValue(new Error('No se pudo cargar la configuración de designación activa: TypeError: fetch failed'));

        const { status, body } = await llamarRuta({ method: 'POST', url: '/dry-run', body: { rodeo_ids: ['r1'] } });

        expect(status).toBe(500);
        expect(body.error).toMatch(/^No se pudo cargar la configuración de designación: No se pudo cargar la configuración de designación activa\. Intente nuevamente; si el problema persiste, informe la referencia DR-/);
        expect(JSON.stringify(body)).not.toMatch(PATRON_TECNICO);
        expect(generarSimulacion).not.toHaveBeenCalled();
        expect(generarSimulacionGlobal).not.toHaveBeenCalled();
    });

    test('configuración NO resuelta (error funcional) → respuesta estructurada intacta {error, detalle}', async () => {
        cargarConfiguracionDesignacionActiva.mockResolvedValue({
            error: 'CONFIGURACION_DESIGNACION_NO_RESUELTA',
            detalle: 'Se esperaba exactamente 1 configuración de designación activa; se encontraron 0.'
        });

        const { status, body } = await llamarRuta({ method: 'POST', url: '/dry-run', body: { rodeo_ids: ['r1'] } });

        expect(status).toBe(500);
        expect(body).toEqual({
            error: 'CONFIGURACION_DESIGNACION_NO_RESUELTA',
            detalle: 'Se esperaba exactamente 1 configuración de designación activa; se encontraron 0.'
        });
    });

    test('validaciones 400 del cliente sin cambios', async () => {
        const { status, body } = await llamarRuta({ method: 'POST', url: '/dry-run', body: { rodeo_ids: [] } });
        expect(status).toBe(400);
        expect(body).toEqual({ error: 'rodeo_ids debe ser un array con al menos un id' });
    });
});

describe('POST /dry-run — estado ERROR_TECNICO del motor global (respuesta 200)', () => {
    test('el motivo técnico se reemplaza por texto funcional + referencia; el estado y el resultado se conservan', async () => {
        supabaseVacio();
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        generarSimulacionGlobal.mockResolvedValue({
            resumen: { rodeos_solicitados: 1, propuestos: 1, sin_propuesta: 0, no_evaluables: 0, candidatos_analizados: 1 },
            resultados: [{ rodeo_id: 'r1', estado: 'PROPUESTO', jurado_propuesto: { jurado_id: 'j1' } }],
            temporada: 'T', metricas: {}, motor: 'GLOBAL',
            optimizacion_global: {
                aplicada: false, estado_busqueda: 'ERROR_TECNICO',
                motivo: "No se pudo completar el proceso de optimización global: Cannot read properties of undefined (reading 'id')",
                advertencias: []
            },
            cobertura_completa: false
        });

        const { status, body } = await llamarRuta({ method: 'POST', url: '/dry-run', body: { rodeo_ids: ['r1'], motor: 'global' } });

        expect(status).toBe(200);
        expect(body.optimizacion_global.estado_busqueda).toBe('ERROR_TECNICO');
        expect(body.optimizacion_global.aplicada).toBe(false);
        expect(body.cobertura_completa).toBe(false);
        expect(body.resultados).toHaveLength(1);
        expect(body.optimizacion_global.referencia_error).toMatch(/^DR-[0-9A-F]{8}$/);
        expect(body.optimizacion_global.motivo).toMatch(/^No se pudo completar el proceso de optimización global por un error interno/);
        expect(JSON.stringify(body.optimizacion_global)).not.toMatch(PATRON_TECNICO);
        expect(logs.some(l => l.includes(body.optimizacion_global.referencia_error) && l.includes('Cannot read properties'))).toBe(true);
        expect(body.preview_token).toBeTruthy();
    });

    test('un resultado normal (COBERTURA_COMPLETA) no se altera', async () => {
        supabaseVacio();
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        const og = { aplicada: true, estado_busqueda: 'COBERTURA_COMPLETA', motivo: 'Se encontró una asignación global que cubre el 100%.', total_cupos: 1, cobertura_obtenida: 1, cupos_pendientes: 0, advertencias: [] };
        generarSimulacionGlobal.mockResolvedValue({ resumen: {}, resultados: [], temporada: 'T', metricas: {}, motor: 'GLOBAL', optimizacion_global: { ...og }, cobertura_completa: true });

        const { status, body } = await llamarRuta({ method: 'POST', url: '/dry-run', body: { rodeo_ids: ['r1'], motor: 'global' } });

        expect(status).toBe(200);
        expect(body.optimizacion_global).toEqual(og);
        expect(logs).toEqual([]);
    });
});
