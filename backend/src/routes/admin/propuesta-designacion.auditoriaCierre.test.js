// Corrección final de seguridad — Sección 1: cierre de la brecha de
// selección en Propuesta de Designación.
//
// La revisión de cierre de integridad anterior confirmó que procesarSeleccion()/
// evaluarSeleccion() (rutas persistida y stateless /preview/seleccionar)
// mezclaban TODAS las causas del motor en un único array `advertencias`:
// bastaba con confirmar_advertencias=true (+ motivo, si era modificación
// manual) para persistir una selección aunque violara una causa OBLIGATORIA
// real (MISMA_ASOCIACION, CATEGORIA_INCOMPATIBLE, MISMO_FINDE, DISPONIBILIDAD,
// ASOCIACION_REPETIDA_INTERVALO) — justo lo que POST /admin/asignaciones ya
// bloqueaba sin excepción desde la Etapa A. Ahora evaluarSeleccion() reutiliza
// evaluarElegibilidadJurado() (mismo mecanismo único) y separa
// causasObligatorias (nunca confirmable) de advertencias (causas relajables +
// conflictos internos del lote, sin cambios en esa lógica).
jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
jest.mock('../../services/motorPropuestaDesignacion', () => {
    const real = jest.requireActual('../../services/motorPropuestaDesignacion');
    return { ...real, cargarDatosMotor: jest.fn(), evaluarCandidatoDirecto: jest.fn() };
});
jest.mock('../../services/configuracionDesignacionRepositorio', () => ({
    cargarConfiguracionDesignacionActiva: jest.fn(),
    cargarConfiguracionDesignacionPorId: jest.fn()
}));

const supabase = require('../../config/supabase');
const { cargarDatosMotor, evaluarCandidatoDirecto } = require('../../services/motorPropuestaDesignacion');
const { cargarConfiguracionDesignacionPorId } = require('../../services/configuracionDesignacionRepositorio');
const { construirConfiguracionDefaultV1 } = require('../../services/configuracionDesignacion');
const router = require('./propuesta-designacion');

const CONFIG_V1 = construirConfiguracionDefaultV1();
const META_V1 = { id: 'v1-uuid', numero_version: 1, schema_version: 1 };

function llamarRuta({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, body: body || {}, query: {}, params: {}, headers: {}, ip: '127.0.0.1',
            usuario: { id: 'admin-test', tipo: 'administrador', rol_evaluacion: null },
            get() { return undefined; }
        };
        const res = {
            statusCode: 200,
            status(codigo) { this.statusCode = codigo; return this; },
            json(payload) { resolve({ status: this.statusCode, body: payload }); return this; }
        };
        router(req, res, (err) => { if (err) reject(err); else resolve({ status: 404, body: { error: 'ruta no encontrada' } }); });
    });
}

function crearSupabaseMock(porTabla) {
    const consumir = (tabla) => {
        const entrada = porTabla[tabla];
        if (entrada === undefined) return { data: [], error: null };
        if (Array.isArray(entrada)) return entrada.length > 1 ? entrada.shift() : entrada[0];
        return entrada;
    };
    supabase.from.mockImplementation((tabla) => {
        const chain = {
            select: () => chain, eq: () => chain, neq: () => chain, in: () => chain, is: () => chain,
            ilike: () => chain, order: () => chain, limit: () => chain, range: () => chain,
            insert: () => chain, update: () => chain, delete: () => chain,
            single: () => chain, maybeSingle: () => chain,
            then: (resolve, reject) => Promise.resolve(consumir(tabla)).then(resolve, reject)
        };
        return chain;
    });
}

beforeEach(() => jest.clearAllMocks());

describe('POST .../seleccionar (persistida) — causa obligatoria nunca confirmable', () => {
    test('1) causa OBLIGATORIA (MISMA_ASOCIACION) + confirmar_advertencias:true + motivo -> 409 bloqueadoPorRestriccionObligatoria, NUNCA se persiste ni se llama a la RPC', async () => {
        crearSupabaseMock({
            propuestas_designacion: { data: { id: 'prop-1', estado: 'BORRADOR', configuracion_version_id: 'v1-uuid' }, error: null },
            propuestas_designacion_detalle: [
                { data: { id: 'det-1', rodeo_id: 'r1', estado_revision: 'PENDIENTE', jurado_id_propuesto: 'j1', jurado_id_seleccionado: null, metricas_json: {} }, error: null },
                { data: [], error: null } // cargarOtrasFilasEfectivas
            ]
        });
        cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-05-01', asociacion: 'Asoc', duracion_dias: 1 }]]) });
        evaluarCandidatoDirecto.mockReturnValue({ evaluacion: { causas: ['MISMA_ASOCIACION'], distanciaKm: 5, jurado: { id: 'j2', nombre_completo: 'Jurado Dos', categoria: 'A', asociacion: 'Asoc' } } });

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/propuestas/prop-1/detalle/det-1/seleccionar',
            body: { jurado_id: 'j2', confirmar_advertencias: true, motivo_catalogo_id: 'motivo-1', motivo_detalle: 'excepción' }
        });

        expect(status).toBe(409);
        expect(body.bloqueadoPorRestriccionObligatoria).toBe(true);
        expect(body.causas).toEqual([{ tipo: 'MISMA_ASOCIACION', origen: 'REGLA_MOTOR' }]);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('1b) causa obligatoria MEZCLADA con una relajable -> igual bloquea (una sola causa obligatoria basta, sin importar cuántas relajables acompañen)', async () => {
        crearSupabaseMock({
            propuestas_designacion: { data: { id: 'prop-1', estado: 'BORRADOR', configuracion_version_id: 'v1-uuid' }, error: null },
            propuestas_designacion_detalle: [
                { data: { id: 'det-1', rodeo_id: 'r1', estado_revision: 'PENDIENTE', jurado_id_propuesto: 'j1', jurado_id_seleccionado: null, metricas_json: {} }, error: null },
                { data: [], error: null }
            ]
        });
        cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-05-01', asociacion: 'Asoc', duracion_dias: 1 }]]) });
        evaluarCandidatoDirecto.mockReturnValue({ evaluacion: { causas: ['MISMA_ASOCIACION', 'DISTANCIA_EXCEDIDA'], distanciaKm: 800, jurado: { id: 'j2', nombre_completo: 'Jurado Dos', categoria: 'A', asociacion: 'Asoc' } } });

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/propuestas/prop-1/detalle/det-1/seleccionar',
            body: { jurado_id: 'j2', confirmar_advertencias: true, motivo_catalogo_id: 'motivo-1' }
        });

        expect(status).toBe(409);
        expect(body.bloqueadoPorRestriccionObligatoria).toBe(true);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('2) causa solo FLEXIBLE (DISTANCIA_EXCEDIDA) sin confirmar -> 409 requiereConfirmacion (no bloqueadoPorRestriccionObligatoria); con confirmar_advertencias + motivo -> se persiste', async () => {
        const mockBase = () => crearSupabaseMock({
            propuestas_designacion: { data: { id: 'prop-1', estado: 'BORRADOR', configuracion_version_id: 'v1-uuid' }, error: null },
            propuestas_designacion_detalle: [
                { data: { id: 'det-1', rodeo_id: 'r1', estado_revision: 'PENDIENTE', jurado_id_propuesto: 'j1', jurado_id_seleccionado: null, metricas_json: {} }, error: null },
                { data: [], error: null }
            ]
        });
        cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-05-01', asociacion: 'Asoc', duracion_dias: 1 }]]) });
        evaluarCandidatoDirecto.mockReturnValue({ evaluacion: { causas: ['DISTANCIA_EXCEDIDA'], distanciaKm: 800, jurado: { id: 'j2', nombre_completo: 'Jurado Dos', categoria: 'A', asociacion: 'Asoc' } } });

        mockBase();
        const sinConfirmar = await llamarRuta({
            method: 'POST', url: '/propuestas/prop-1/detalle/det-1/seleccionar',
            body: { jurado_id: 'j2', motivo_catalogo_id: 'motivo-1' }
        });
        expect(sinConfirmar.status).toBe(409);
        expect(sinConfirmar.body.requiereConfirmacion).toBe(true);
        expect(sinConfirmar.body.bloqueadoPorRestriccionObligatoria).toBeUndefined();
        expect(supabase.rpc).not.toHaveBeenCalled();

        mockBase();
        supabase.rpc.mockResolvedValue({
            data: { detalle: { id: 'det-1', jurado_id_seleccionado: 'j2', estado_revision: 'MODIFICADO', origen_seleccion: 'MANUAL_CON_ADVERTENCIA' }, bitacora_id: 'bit-1' },
            error: null
        });
        const confirmado = await llamarRuta({
            method: 'POST', url: '/propuestas/prop-1/detalle/det-1/seleccionar',
            body: { jurado_id: 'j2', confirmar_advertencias: true, motivo_catalogo_id: 'motivo-1', motivo_detalle: 'excepción justificada' }
        });
        expect(confirmado.status).toBe(200);
        expect(confirmado.body.detalle.estado_revision).toBe('MODIFICADO');
        expect(supabase.rpc).toHaveBeenCalledWith('modificar_jurado_propuesta_borrador', expect.objectContaining({ p_jurado_id_nuevo: 'j2', p_motivo_catalogo_id: 'motivo-1' }));
    });
});

describe('POST /preview/seleccionar (stateless) — 3) el preview no permite eludir las reglas', () => {
    test('causa OBLIGATORIA -> también 409 bloqueadoPorRestriccionObligatoria, igual que la ruta persistida (mismo control, sin importar confirmar_advertencias)', async () => {
        cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-05-01', asociacion: 'Asoc', duracion_dias: 1 }]]) });
        evaluarCandidatoDirecto.mockReturnValue({ evaluacion: { causas: ['CATEGORIA_INCOMPATIBLE'], distanciaKm: 5, jurado: { id: 'j1', nombre_completo: 'Juan Pérez', categoria: 'C', asociacion: 'Asoc' } } });

        const { firmarPreview } = require('../../services/previewIntegridad');
        const token = firmarPreview({
            temporada_id: 't1', configuracion_version_id: 'v1-uuid',
            rodeos: [{ rodeo_id: 'r1', estado: 'PROPUESTO', jurado_id_propuesto: 'j1' }]
        });

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/preview/seleccionar',
            body: {
                rodeo_id: 'r1', jurado_id: 'j1', preview_token: token, confirmar_advertencias: true,
                estado_temporal: [{ rodeo_id: 'r1', estado_revision: 'PENDIENTE', jurado_id_seleccionado: null }]
            }
        });

        expect(status).toBe(409);
        expect(body.bloqueadoPorRestriccionObligatoria).toBe(true);
        expect(body.causas).toEqual([{ tipo: 'CATEGORIA_INCOMPATIBLE', origen: 'REGLA_MOTOR' }]);
    });
});
