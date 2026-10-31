// ═════════════════════════════════════════════════════════════════════════
// Tests de ORQUESTACIÓN DE RUTA — Fase 2C: persistencia de metadata V1 del
// motor (sección 2), modificación manual con motivo obligatorio (sección 3),
// y comparación V1/actual + historial (sección 4).
//
// Mismo patrón exacto que propuesta-designacion.orquestacion.test.js —
// mock genérico de Supabase por tabla, previewIntegridad REAL (para probar
// que motor/fecha_corte_tecnica/cobertura_resumen firmados sobreviven hasta
// el guardado), resto de servicios mockeados.
// ═════════════════════════════════════════════════════════════════════════
jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
jest.mock('../../services/motorPropuestaDesignacion', () => {
    const real = jest.requireActual('../../services/motorPropuestaDesignacion');
    return { ...real, cargarDatosMotor: jest.fn(), ejecutarSimulacion: jest.fn(), generarSimulacion: jest.fn(), evaluarCandidatoDirecto: jest.fn() };
});
jest.mock('../../services/configuracionDesignacionRepositorio', () => ({
    cargarConfiguracionDesignacionActiva: jest.fn(),
    cargarConfiguracionDesignacionPorId: jest.fn()
}));

const supabase = require('../../config/supabase');
const { cargarDatosMotor, ejecutarSimulacion, evaluarCandidatoDirecto } = require('../../services/motorPropuestaDesignacion');
const { cargarConfiguracionDesignacionPorId } = require('../../services/configuracionDesignacionRepositorio');
const { firmarPreview } = require('../../services/previewIntegridad'); // REAL, sin mock
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
    const llamadas = {};
    const consumir = (tabla) => {
        const entrada = porTabla[tabla];
        if (entrada === undefined) return { data: [], error: null };
        if (Array.isArray(entrada)) return entrada.length > 1 ? entrada.shift() : entrada[0];
        return entrada;
    };
    supabase.from.mockImplementation((tabla) => {
        llamadas[tabla] = llamadas[tabla] || { inserts: [], updates: [], deletes: 0 };
        const chain = {
            select: () => chain, eq: () => chain, neq: () => chain, in: () => chain, is: () => chain,
            ilike: () => chain, order: () => chain, limit: () => chain, range: () => chain,
            insert: (payload) => { llamadas[tabla].inserts.push(payload); return chain; },
            update: (payload) => { llamadas[tabla].updates.push(payload); return chain; },
            delete: () => { llamadas[tabla].deletes += 1; return chain; },
            single: () => chain, maybeSingle: () => chain,
            then: (resolve, reject) => Promise.resolve(consumir(tabla)).then(resolve, reject)
        };
        return chain;
    });
    return llamadas;
}

beforeEach(() => jest.clearAllMocks());

describe('POST /propuestas — persiste motor_usado/fecha_corte_tecnica/resultado_cobertura_json (Fase 2C, sección 2)', () => {
    test('token firmado con motor:"global" + cobertura_resumen -> el INSERT de propuestas_designacion los persiste intactos', async () => {
        const coberturaResumen = { estado_busqueda: 'COBERTURA_COMPLETA', total_cupos: 1, cobertura_obtenida: 1, cupos_pendientes: 0, cobertura_completa: true };
        const token = firmarPreview({
            temporada_id: 't1', configuracion_version_id: 'v1-uuid',
            motor: 'global', fecha_corte_tecnica: '2026-10-30T09:00:00.000Z', cobertura_resumen: coberturaResumen,
            rodeos: [{ rodeo_id: 'r1', estado: 'PROPUESTO', jurado_id_propuesto: 'j1' }]
        });
        cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });

        const llamadas = crearSupabaseMock({
            propuestas_designacion_detalle: [
                { data: [], error: null },
                { data: [{ id: 'det-1', rodeo_id: 'r1' }], error: null }
            ],
            propuestas_designacion: { data: { id: 'prop-1', estado: 'BORRADOR', created_at: '2026-10-30T09:05:00Z' }, error: null },
            rodeos: { data: [{ id: 'r1', club: 'Club R1', fecha: '2026-05-01', asociacion: 'Asoc', tipo_rodeo_nombre: 'Provincial', duracion_dias: 1 }], error: null }
        });

        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-05-01', asociacion: 'Asoc', duracion_dias: 1 }]]) });
        ejecutarSimulacion.mockReturnValue({
            resultados: [{ rodeo_id: 'r1', estado: 'PROPUESTO', jurado_propuesto: { jurado_id: 'j1' }, candidatos_evaluados: 5, candidatos_potenciales_bd: 5, descartes: 0 }]
        });
        evaluarCandidatoDirecto.mockReturnValue({ evaluacion: { causas: [], distanciaKm: 8, jurado: { categoria: 'A', asociacion: 'Asoc' } } });

        const { status } = await llamarRuta({
            method: 'POST', url: '/propuestas',
            body: { preview_token: token, estado_temporal: [{ rodeo_id: 'r1', estado_revision: 'PENDIENTE', jurado_id_seleccionado: null }] }
        });

        expect(status).toBe(201);
        const insertPropuesta = llamadas.propuestas_designacion.inserts[0];
        expect(insertPropuesta.motor_usado).toBe('global');
        expect(insertPropuesta.fecha_corte_tecnica).toBe('2026-10-30T09:00:00.000Z');
        expect(insertPropuesta.resultado_cobertura_json).toEqual(coberturaResumen);
    });

    test('sin motor en el token (default) -> se persiste motor_usado:"local"', async () => {
        const token = firmarPreview({
            temporada_id: 't1', configuracion_version_id: 'v1-uuid',
            rodeos: [{ rodeo_id: 'r1', estado: 'PROPUESTO', jurado_id_propuesto: 'j1' }]
        });
        cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        const llamadas = crearSupabaseMock({
            propuestas_designacion_detalle: [{ data: [], error: null }, { data: [{ id: 'det-1', rodeo_id: 'r1' }], error: null }],
            propuestas_designacion: { data: { id: 'prop-2', estado: 'BORRADOR', created_at: '2026-10-30T09:05:00Z' }, error: null },
            rodeos: { data: [{ id: 'r1', club: 'Club R1', fecha: '2026-05-01', asociacion: 'Asoc', tipo_rodeo_nombre: 'Provincial', duracion_dias: 1 }], error: null }
        });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-05-01', asociacion: 'Asoc', duracion_dias: 1 }]]) });
        ejecutarSimulacion.mockReturnValue({ resultados: [{ rodeo_id: 'r1', estado: 'PROPUESTO', jurado_propuesto: { jurado_id: 'j1' }, candidatos_evaluados: 5, candidatos_potenciales_bd: 5, descartes: 0 }] });
        evaluarCandidatoDirecto.mockReturnValue({ evaluacion: { causas: [], distanciaKm: 8, jurado: { categoria: 'A', asociacion: 'Asoc' } } });

        await llamarRuta({ method: 'POST', url: '/propuestas', body: { preview_token: token, estado_temporal: [{ rodeo_id: 'r1', estado_revision: 'PENDIENTE', jurado_id_seleccionado: null }] } });

        expect(llamadas.propuestas_designacion.inserts[0].motor_usado).toBe('local');
        expect(llamadas.propuestas_designacion.inserts[0].resultado_cobertura_json).toBeNull();
    });
});

describe('POST .../seleccionar — motivo obligatorio para modificación manual (Fase 2C, sección 3)', () => {
    function mockBase(detalleData, respuestaUpdateMotor) {
        const secuencia = [
            detalleData, // select('*') del detalle
            { data: [], error: null } // cargarOtrasFilasEfectivas
        ];
        // Solo la rama MOTOR (sin motivo, sin RPC) hace un 3er llamado a esta
        // tabla: update(...).select().single() con la fila ya actualizada.
        if (respuestaUpdateMotor) secuencia.push(respuestaUpdateMotor);
        return crearSupabaseMock({
            propuestas_designacion: { data: { id: 'prop-1', estado: 'BORRADOR', configuracion_version_id: 'v1-uuid' }, error: null },
            propuestas_designacion_detalle: secuencia
        });
    }

    test('jurado distinto al propuesto, sin motivo -> 409 requiereMotivo, nada se modifica ni se llama a la RPC', async () => {
        mockBase({ data: { id: 'det-1', rodeo_id: 'r1', estado_revision: 'PENDIENTE', jurado_id_propuesto: 'j1', jurado_id_seleccionado: null, metricas_json: {} }, error: null });
        cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-05-01', asociacion: 'Asoc', duracion_dias: 1 }]]) });
        evaluarCandidatoDirecto.mockReturnValue({ evaluacion: { causas: [], distanciaKm: 5, jurado: { id: 'j2', nombre_completo: 'Jurado Dos', categoria: 'A', asociacion: 'Asoc' } } });

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/propuestas/prop-1/detalle/det-1/seleccionar',
            body: { jurado_id: 'j2' } // distinto de jurado_id_propuesto ('j1') -> MANUAL
        });

        expect(status).toBe(409);
        expect(body.requiereMotivo).toBe(true);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('jurado distinto al propuesto, CON motivo -> llama a modificar_jurado_propuesta_borrador y persiste vía la RPC', async () => {
        mockBase({ data: { id: 'det-1', rodeo_id: 'r1', estado_revision: 'PENDIENTE', jurado_id_propuesto: 'j1', jurado_id_seleccionado: null, metricas_json: {} }, error: null });
        cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-05-01', asociacion: 'Asoc', duracion_dias: 1 }]]) });
        evaluarCandidatoDirecto.mockReturnValue({ evaluacion: { causas: [], distanciaKm: 5, jurado: { id: 'j2', nombre_completo: 'Jurado Dos', categoria: 'A', asociacion: 'Asoc' } } });
        supabase.rpc.mockResolvedValue({
            data: { detalle: { id: 'det-1', jurado_id_seleccionado: 'j2', estado_revision: 'MODIFICADO', origen_seleccion: 'MANUAL' }, bitacora_id: 'bit-1' },
            error: null
        });

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/propuestas/prop-1/detalle/det-1/seleccionar',
            body: { jurado_id: 'j2', motivo_catalogo_id: 'motivo-1', motivo_detalle: 'Jurado titular se enfermó' }
        });

        expect(status).toBe(200);
        expect(body.detalle.estado_revision).toBe('MODIFICADO');
        expect(supabase.rpc).toHaveBeenCalledWith('modificar_jurado_propuesta_borrador', expect.objectContaining({
            p_detalle_id: 'det-1', p_jurado_id_nuevo: 'j2', p_motivo_catalogo_id: 'motivo-1',
            p_motivo_detalle: 'Jurado titular se enfermó', p_actor_id: 'admin-test'
        }));
    });

    test('aceptar la sugerencia del motor (jurado == propuesto) -> MOTOR, nunca exige motivo ni llama a la RPC', async () => {
        mockBase(
            { data: { id: 'det-1', rodeo_id: 'r1', estado_revision: 'PENDIENTE', jurado_id_propuesto: 'j1', jurado_id_seleccionado: null, metricas_json: {} }, error: null },
            { data: { id: 'det-1', jurado_id_seleccionado: 'j1', estado_revision: 'ACEPTADO', origen_seleccion: 'MOTOR' }, error: null }
        );
        cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-05-01', asociacion: 'Asoc', duracion_dias: 1 }]]) });
        evaluarCandidatoDirecto.mockReturnValue({ evaluacion: { causas: [], distanciaKm: 5, jurado: { id: 'j1', nombre_completo: 'Jurado Uno', categoria: 'A', asociacion: 'Asoc' } } });

        const { status, body } = await llamarRuta({ method: 'POST', url: '/propuestas/prop-1/detalle/det-1/seleccionar', body: { jurado_id: 'j1' } });

        expect(status).toBe(200);
        expect(body.detalle.estado_revision).toBe('ACEPTADO');
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    // Caso límite real: aceptar al MISMO jurado que el motor propuso, pero
    // revalidado con advertencias vigentes (p.ej. una regla relajada por el
    // motor global) -> decidirEstadoSeleccion() devuelve MANUAL_CON_
    // ADVERTENCIA, pero NO hay ningún cambio de identidad que justificar
    // (juradoId === jurado_id_propuesto) -> nunca debe exigir motivo.
    test('aceptar al mismo jurado propuesto, con advertencias vigentes -> confirma advertencias pero NUNCA exige motivo (no hay cambio de identidad)', async () => {
        mockBase(
            { data: { id: 'det-1', rodeo_id: 'r1', estado_revision: 'PENDIENTE', jurado_id_propuesto: 'j1', jurado_id_seleccionado: null, metricas_json: {} }, error: null },
            { data: { id: 'det-1', jurado_id_seleccionado: 'j1', estado_revision: 'MODIFICADO', origen_seleccion: 'MANUAL_CON_ADVERTENCIA' }, error: null }
        );
        cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-05-01', asociacion: 'Asoc', duracion_dias: 1 }]]) });
        evaluarCandidatoDirecto.mockReturnValue({ evaluacion: { causas: ['DISTANCIA_EXCEDIDA'], distanciaKm: 750, jurado: { id: 'j1', nombre_completo: 'Jurado Uno', categoria: 'A', asociacion: 'Asoc' } } });

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/propuestas/prop-1/detalle/det-1/seleccionar',
            body: { jurado_id: 'j1', confirmar_advertencias: true } // advertencias ya confirmadas por el administrador
        });

        expect(status).toBe(200);
        expect(body.detalle.estado_revision).toBe('MODIFICADO');
        expect(supabase.rpc).not.toHaveBeenCalled(); // sin motivo, sin bitácora: no cambió la identidad del jurado
    });

    test('la RPC rechaza un motivo inválido -> 400 explícito', async () => {
        mockBase({ data: { id: 'det-1', rodeo_id: 'r1', estado_revision: 'PENDIENTE', jurado_id_propuesto: 'j1', jurado_id_seleccionado: null, metricas_json: {} }, error: null });
        cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-05-01', asociacion: 'Asoc', duracion_dias: 1 }]]) });
        evaluarCandidatoDirecto.mockReturnValue({ evaluacion: { causas: [], distanciaKm: 5, jurado: { id: 'j2', nombre_completo: 'Jurado Dos', categoria: 'A', asociacion: 'Asoc' } } });
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'MOTIVO_INVALIDO' } });

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/propuestas/prop-1/detalle/det-1/seleccionar',
            body: { jurado_id: 'j2', motivo_catalogo_id: 'motivo-inexistente' }
        });

        expect(status).toBe(400);
        expect(body.error).toMatch(/motivo/i);
    });
});

describe('GET .../historial — comparación V1/actual (Fase 2C, sección 4)', () => {
    test('fila nunca modificada -> modificado:false, historial vacío', async () => {
        crearSupabaseMock({
            propuestas_designacion_detalle: { data: { id: 'det-1', rodeo_id: 'r1', jurado_id_propuesto: 'j1', jurado_id_seleccionado: 'j1', estado_revision: 'ACEPTADO' }, error: null },
            bitacora_designaciones: { data: [], error: null },
            usuarios_pagados: { data: [{ id: 'j1', nombre_completo: 'Jurado Uno' }], error: null }
        });

        const { status, body } = await llamarRuta({ method: 'GET', url: '/propuestas/prop-1/detalle/det-1/historial' });

        expect(status).toBe(200);
        expect(body.modificado).toBe(false);
        expect(body.v1.jurado_id).toBe('j1');
        expect(body.actual.jurado_id).toBe('j1');
        expect(body.historial).toEqual([]);
    });

    test('fila modificada dos veces -> modificado:true, historial con 2 movimientos en orden, V1 intacto', async () => {
        crearSupabaseMock({
            propuestas_designacion_detalle: { data: { id: 'det-1', rodeo_id: 'r1', jurado_id_propuesto: 'j1', jurado_id_seleccionado: 'j3', estado_revision: 'MODIFICADO' }, error: null },
            bitacora_designaciones: {
                data: [
                    { id: 'bit-1', usuario_pagado_id_anterior: null, nombre_anterior_snapshot: null, usuario_pagado_id_nuevo: 'j2', nombre_nuevo_snapshot: 'Jurado Dos', tipo_movimiento: 'modificacion_manual_borrador', motivo_detalle: null, actor_id: 'admin-1', fecha_efectiva: '2026-10-30T10:00:00Z', created_at: '2026-10-30T10:00:00Z', catalogo_motivos_designacion: { etiqueta: 'Rechazo de designación' } },
                    { id: 'bit-2', usuario_pagado_id_anterior: 'j2', nombre_anterior_snapshot: 'Jurado Dos', usuario_pagado_id_nuevo: 'j3', nombre_nuevo_snapshot: 'Jurado Tres', tipo_movimiento: 'modificacion_manual_borrador', motivo_detalle: 'Ajuste final', actor_id: 'admin-1', fecha_efectiva: '2026-10-30T11:00:00Z', created_at: '2026-10-30T11:00:00Z', catalogo_motivos_designacion: { etiqueta: 'Ajuste de categoría' } }
                ],
                error: null
            },
            usuarios_pagados: { data: [{ id: 'j1', nombre_completo: 'Jurado Uno' }, { id: 'j3', nombre_completo: 'Jurado Tres' }], error: null }
        });

        const { status, body } = await llamarRuta({ method: 'GET', url: '/propuestas/prop-1/detalle/det-1/historial' });

        expect(status).toBe(200);
        expect(body.modificado).toBe(true);
        expect(body.v1).toEqual({ jurado_id: 'j1', nombre: 'Jurado Uno' });
        expect(body.actual).toEqual({ jurado_id: 'j3', nombre: 'Jurado Tres' });
        expect(body.historial.length).toBe(2);
        expect(body.historial[0].jurado_nuevo).toEqual({ id: 'j2', nombre: 'Jurado Dos' });
        expect(body.historial[1].jurado_nuevo).toEqual({ id: 'j3', nombre: 'Jurado Tres' });
        expect(body.historial[1].motivo).toBe('Ajuste de categoría');
        expect(body.historial[1].motivo_detalle).toBe('Ajuste final');
    });

    test('detalle inexistente -> 404', async () => {
        crearSupabaseMock({ propuestas_designacion_detalle: { data: null, error: null } });
        const { status } = await llamarRuta({ method: 'GET', url: '/propuestas/prop-1/detalle/no-existe/historial' });
        expect(status).toBe(404);
    });
});
