// Revisión de cierre de integridad (post Etapas A/B/D) — comprobaciones 1 y 2.
// Corrección final de seguridad, sección 3 (1b): CORREGIDO — ver migración
// 094 y el nuevo camino crear_asignacion_con_bitacora() en asignaciones.js.
//
// Comprobación 1 — Trazabilidad de excepciones en POST /admin/asignaciones:
//   (a) invariante de seguridad: confirmar_advertencias=true NUNCA permite
//       omitir una restricción obligatoria (NO_HABILITADO), incluso si se
//       envía junto con la confirmación — se verifica que esto YA es cierto
//       hoy (doble gate: el chequeo de NO_HABILITADO corta ANTES y SIN
//       condicionar nada a confirmar_advertencias).
//   (b) CORREGIDO — una excepción confirmada (CON_ADVERTENCIAS +
//       confirmar_advertencias:true) ahora exige motivo_codigo y, con él,
//       crea la asignación Y registra la excepción (causas relajables,
//       motivo, actor, fecha, id de la asignación) en bitacora_
//       designaciones de forma atómica, vía crear_asignacion_con_bitacora()
//       (migración 094) — nunca dos pasos separados.
//
// Comprobación 2 (mitad escritura) — POST /:id/reemplazar NUNCA evalúa
// elegibilidad real (ni MISMA_ASOCIACION, ni categoría/matriz, ni
// distancia): solo disponibilidad+cruce de fechas+motivo+antecedentes
// sensibles. Un jurado que sería NO_HABILITADO en "Designar jurado" puede
// pasar sin ningún chequeo adicional por este endpoint. Se demuestra
// mockeando evaluarElegibilidadJurado (ya importado por asignaciones.js
// para la ruta POST /) y comprobando que /:id/reemplazar jamás lo invoca.
jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
jest.mock('../../services/auditoria', () => ({ registrar: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/motorPropuestaDesignacion', () => {
    const real = jest.requireActual('../../services/motorPropuestaDesignacion');
    return { ...real, cargarDatosMotor: jest.fn() };
});
jest.mock('../../services/configuracionDesignacionRepositorio', () => ({
    cargarConfiguracionDesignacionActiva: jest.fn()
}));
jest.mock('../../services/elegibilidadJurado', () => ({
    evaluarElegibilidadJurado: jest.fn(),
    ESTADOS_ELEGIBILIDAD: { DISPONIBLE_Y_HABILITADO: 'DISPONIBLE_Y_HABILITADO', CON_ADVERTENCIAS: 'CON_ADVERTENCIAS', NO_HABILITADO: 'NO_HABILITADO' }
}));

const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');
const { cargarDatosMotor } = require('../../services/motorPropuestaDesignacion');
const { cargarConfiguracionDesignacionActiva } = require('../../services/configuracionDesignacionRepositorio');
const { evaluarElegibilidadJurado } = require('../../services/elegibilidadJurado');
const router = require('./asignaciones');

function crearSupabaseMock(porTabla) {
    const consumir = (tabla) => {
        const entrada = porTabla[tabla];
        if (entrada === undefined) return { data: [], error: null };
        if (Array.isArray(entrada)) return entrada.length > 1 ? entrada.shift() : entrada[0];
        return entrada;
    };
    supabase.from.mockImplementation((tabla) => {
        const chain = {
            select: () => chain, eq: () => chain, neq: () => chain, in: () => chain,
            ilike: () => chain, order: () => chain, limit: () => chain, range: () => chain,
            insert: () => chain, update: () => chain, delete: () => chain,
            single: () => chain, maybeSingle: () => chain,
            then: (resolve, reject) => Promise.resolve(consumir(tabla)).then(resolve, reject)
        };
        return chain;
    });
}

function llamarRuta({ method, url, body, params }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url,
            body: body || {}, query: {}, params: params || {}, headers: {},
            ip: '127.0.0.1',
            usuario: { id: 'admin-test', tipo: 'administrador', rol_evaluacion: null },
            get() { return undefined; }
        };
        const res = {
            statusCode: 200,
            status(codigo) { this.statusCode = codigo; return this; },
            json(payload) { resolve({ status: this.statusCode, body: payload }); return this; }
        };
        router(req, res, (err) => {
            if (err) reject(err);
            else resolve({ status: 404, body: { error: 'ruta no encontrada por el router' } });
        });
    });
}

const RODEO = { id: 'R1', duracion_dias: 1, estado: 'activo', fecha: '2026-11-07' };
const TARIFAS = [{ categoria: 'A', valor_diario: 100000 }];

beforeEach(() => {
    jest.clearAllMocks();
    cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: { _fake: true } });
    cargarDatosMotor.mockResolvedValue({ _contextoFake: true });
});

describe('Comprobación 1 — trazabilidad de excepciones (confirmar_advertencias)', () => {
    test('1a) NO_HABILITADO + confirmar_advertencias:true -> SIGUE bloqueado (invariante de seguridad ya se cumple hoy)', async () => {
        crearSupabaseMock({
            rodeos: { data: RODEO, error: null },
            configuracion_tarifas: { data: TARIFAS, error: null },
            usuarios_pagados: { data: { id: 'J1', nombre_completo: 'Jurado Uno', tipo_persona: 'jurado', categoria: 'A', activo: true }, error: null },
            disponibilidad_usuarios: { data: [{ fecha: '2026-11-07' }], error: null },
            asignaciones: { data: [], error: null } // solo el chequeo de cruce; el insert NUNCA debe pedirse
        });
        evaluarElegibilidadJurado.mockReturnValue({ estado: 'NO_HABILITADO', causas: ['MISMA_ASOCIACION'], causas_obligatorias: ['MISMA_ASOCIACION'], causas_relajables: [], distancia_km: null });

        const { body } = await llamarRuta({
            method: 'POST', url: '/',
            body: { rodeo_id: 'R1', personas: [{ usuario_pagado_id: 'J1', tipo_persona: 'jurado', confirmar_advertencias: true }] }
        });

        expect(body.creadas).toHaveLength(0);
        expect(body.errores[0].estado_elegibilidad).toBe('NO_HABILITADO');
        expect(auditoria.registrar).not.toHaveBeenCalled(); // nunca se auditó una creación que nunca ocurrió
    });

    test('1b) CORREGIDO — CON_ADVERTENCIAS confirmado + motivo_codigo válido crea la asignación Y registra la excepción atómicamente vía crear_asignacion_con_bitacora; sin motivo_codigo, se bloquea', async () => {
        const base = () => crearSupabaseMock({
            rodeos: { data: RODEO, error: null },
            configuracion_tarifas: { data: TARIFAS, error: null },
            usuarios_pagados: { data: { id: 'J1', nombre_completo: 'Jurado Uno', tipo_persona: 'jurado', categoria: 'A', activo: true }, error: null },
            disponibilidad_usuarios: { data: [{ fecha: '2026-11-07' }], error: null },
            asignaciones: { data: [], error: null },
            catalogo_motivos_designacion: { data: { id: 'mot-1', activo: true }, error: null }
        });
        evaluarElegibilidadJurado.mockReturnValue({ estado: 'CON_ADVERTENCIAS', causas: ['DISTANCIA_EXCEDIDA'], causas_obligatorias: [], causas_relajables: ['DISTANCIA_EXCEDIDA'], distancia_km: 800 });

        // Sin motivo_codigo -> bloqueado, nunca se crea ni se llama a la RPC.
        base();
        const sinMotivo = await llamarRuta({
            method: 'POST', url: '/',
            body: { rodeo_id: 'R1', personas: [{ usuario_pagado_id: 'J1', tipo_persona: 'jurado', confirmar_advertencias: true }] }
        });
        expect(sinMotivo.body.creadas).toHaveLength(0);
        expect(sinMotivo.body.errores[0].requiere_motivo).toBe(true);
        expect(supabase.rpc).not.toHaveBeenCalled();

        // Con motivo_codigo válido -> se crea, y la excepción queda
        // persistida atómicamente (asignación + bitácora en una sola RPC).
        base();
        supabase.rpc.mockResolvedValue({ data: { asignacion: { id: 'asig-1', usuario_pagado_id: 'J1' }, bitacora_id: 'bit-1' }, error: null });
        const { body } = await llamarRuta({
            method: 'POST', url: '/',
            body: {
                rodeo_id: 'R1', personas: [{
                    usuario_pagado_id: 'J1', tipo_persona: 'jurado', confirmar_advertencias: true,
                    motivo_codigo: 'criterio_tecnico_area_deportiva', motivo_detalle: 'Único disponible en la zona'
                }]
            }
        });

        expect(body.creadas).toHaveLength(1);
        // CORRECCIÓN URGENTE (caso LO BARNECHEA) — p_causas_confirmadas es
        // JSONB; debe llegar como arreglo JS real (supabase-js lo serializa
        // una sola vez al armar el body), NUNCA pre-serializado con
        // JSON.stringify() (eso lo convertía en un string JSON, que
        // jsonb_typeof() ve como 'string' y la RPC rechazaba siempre).
        expect(supabase.rpc).toHaveBeenCalledWith('crear_asignacion_con_bitacora', expect.objectContaining({
            p_motivo_catalogo_id: 'mot-1', p_causas_confirmadas: ['DISTANCIA_EXCEDIDA'],
            p_motivo_detalle: 'Único disponible en la zona'
        }));

        // El log genérico de auditoría AHORA también refleja la excepción
        // (visibilidad extra, aunque la fuente de verdad real es la bitácora).
        const llamadaAuditoria = auditoria.registrar.mock.calls[0][0];
        expect(llamadaAuditoria.datos_nuevos).toEqual(expect.objectContaining({
            excepcion_confirmada: true, causas_relajables: ['DISTANCIA_EXCEDIDA'], motivo_codigo: 'criterio_tecnico_area_deportiva'
        }));
        expect(llamadaAuditoria.descripcion).toMatch(/bit-1/);
    });
});

// Corrección final de seguridad, sección 2 — POST /:id/reemplazar ahora
// revalida elegibilidad real (mismo mecanismo que Designar jurado) justo
// antes de llamar a la RPC transaccional.
describe('Comprobación 2 (escritura) — CORREGIDO: POST /:id/reemplazar ahora revalida elegibilidad real', () => {
    const ASIGNACION_ACTUAL = { id: 'asig-1', tipo_persona: 'jurado', rodeo_id: 'r1', duracion_dias_aplicada: 2, rodeos: { fecha: '2026-11-07', duracion_dias: 2 } };
    const TARIFAS_REEMPLAZO = [{ categoria: 'A', valor_diario: 292000 }, { categoria: 'B', valor_diario: 245000 }];

    test('5) causa OBLIGATORIA (MISMA_ASOCIACION) del candidato nuevo -> 409 RESTRICCION_OBLIGATORIA, NUNCA llama a la RPC (nunca se ejecuta el reemplazo)', async () => {
        crearSupabaseMock({
            asignaciones: [{ data: ASIGNACION_ACTUAL, error: null }, { data: [], error: null }],
            catalogo_motivos_designacion: { data: { id: 'mot-1', activo: true }, error: null },
            usuarios_pagados: { data: { id: 'jur-B', nombre_completo: 'Jurado B', tipo_persona: 'jurado', categoria: 'B', activo: true }, error: null },
            disponibilidad_usuarios: { data: [{ fecha: '2026-11-07' }, { fecha: '2026-11-08' }], error: null }
        });
        evaluarElegibilidadJurado.mockReturnValue({ estado: 'NO_HABILITADO', causas: ['MISMA_ASOCIACION'], causas_obligatorias: ['MISMA_ASOCIACION'], causas_relajables: [], distancia_km: null });

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/asig-1/reemplazar', params: { id: 'asig-1' },
            body: { usuario_pagado_id_nuevo: 'jur-B', motivo_codigo: 'jurado_no_disponible', confirmar_advertencias: true }
        });

        expect(status).toBe(409);
        expect(body.code).toBe('RESTRICCION_OBLIGATORIA');
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('6) causa solo FLEXIBLE (DISTANCIA_EXCEDIDA) -> sin confirmar: 409 requiere confirmación, nunca llama a la RPC; con confirmar_advertencias:true (+ motivo, ya exigido siempre) -> se ejecuta el reemplazo', async () => {
        crearSupabaseMock({
            asignaciones: [{ data: ASIGNACION_ACTUAL, error: null }, { data: [], error: null }],
            catalogo_motivos_designacion: { data: { id: 'mot-1', activo: true }, error: null },
            usuarios_pagados: { data: { id: 'jur-B', nombre_completo: 'Jurado B', tipo_persona: 'jurado', categoria: 'B', activo: true }, error: null },
            disponibilidad_usuarios: { data: [{ fecha: '2026-11-07' }, { fecha: '2026-11-08' }], error: null },
            configuracion_tarifas: { data: TARIFAS_REEMPLAZO, error: null }
        });
        evaluarElegibilidadJurado.mockReturnValue({ estado: 'CON_ADVERTENCIAS', causas: ['DISTANCIA_EXCEDIDA'], causas_obligatorias: [], causas_relajables: ['DISTANCIA_EXCEDIDA'], distancia_km: 800 });

        const sinConfirmar = await llamarRuta({
            method: 'POST', url: '/asig-1/reemplazar', params: { id: 'asig-1' },
            body: { usuario_pagado_id_nuevo: 'jur-B', motivo_codigo: 'emergencia_fuerza_mayor' }
        });
        expect(sinConfirmar.status).toBe(409);
        expect(sinConfirmar.body.code).toBe('REQUIERE_CONFIRMACION_ADVERTENCIAS');
        expect(supabase.rpc).not.toHaveBeenCalled();

        crearSupabaseMock({
            asignaciones: [{ data: ASIGNACION_ACTUAL, error: null }, { data: [], error: null }],
            catalogo_motivos_designacion: { data: { id: 'mot-1', activo: true }, error: null },
            usuarios_pagados: { data: { id: 'jur-B', nombre_completo: 'Jurado B', tipo_persona: 'jurado', categoria: 'B', activo: true }, error: null },
            disponibilidad_usuarios: { data: [{ fecha: '2026-11-07' }, { fecha: '2026-11-08' }], error: null },
            configuracion_tarifas: { data: TARIFAS_REEMPLAZO, error: null }
        });
        supabase.rpc.mockResolvedValue({ data: { asignacion: { id: 'asig-1', usuario_pagado_id: 'jur-B' }, bitacora_id: 'bit-1', usuario_pagado_id_anterior: 'jur-A', nombre_anterior_snapshot: 'Jurado A' }, error: null });
        const confirmado = await llamarRuta({
            method: 'POST', url: '/asig-1/reemplazar', params: { id: 'asig-1' },
            body: { usuario_pagado_id_nuevo: 'jur-B', motivo_codigo: 'emergencia_fuerza_mayor', confirmar_advertencias: true }
        });
        expect(confirmado.status).toBe(200);
        expect(supabase.rpc).toHaveBeenCalledWith('reemplazar_jurado_asignacion_con_bitacora', expect.objectContaining({ p_usuario_pagado_id_nuevo: 'jur-B' }));
    });

    test('7) el reemplazo NO se invalida por "conflicto consigo mismo": evaluarElegibilidadJurado se llama con el CANDIDATO nuevo, nunca con el jurado anterior ni con el id de la asignación que se reemplaza', async () => {
        crearSupabaseMock({
            asignaciones: [{ data: ASIGNACION_ACTUAL, error: null }, { data: [], error: null }],
            catalogo_motivos_designacion: { data: { id: 'mot-1', activo: true }, error: null },
            usuarios_pagados: { data: { id: 'jur-B', nombre_completo: 'Jurado B', tipo_persona: 'jurado', categoria: 'B', activo: true }, error: null },
            disponibilidad_usuarios: { data: [{ fecha: '2026-11-07' }, { fecha: '2026-11-08' }], error: null },
            configuracion_tarifas: { data: TARIFAS_REEMPLAZO, error: null }
        });
        evaluarElegibilidadJurado.mockReturnValue({ estado: 'DISPONIBLE_Y_HABILITADO', causas: [], causas_obligatorias: [], causas_relajables: [], distancia_km: 5 });
        supabase.rpc.mockResolvedValue({ data: { asignacion: { id: 'asig-1', usuario_pagado_id: 'jur-B' }, bitacora_id: 'bit-1', usuario_pagado_id_anterior: 'jur-A', nombre_anterior_snapshot: 'Jurado A' }, error: null });

        const { status } = await llamarRuta({
            method: 'POST', url: '/asig-1/reemplazar', params: { id: 'asig-1' },
            body: { usuario_pagado_id_nuevo: 'jur-B', motivo_codigo: 'jurado_no_disponible' }
        });

        expect(status).toBe(200);
        expect(evaluarElegibilidadJurado).toHaveBeenCalledWith({ _contextoFake: true }, 'r1', 'jur-B', { _fake: true });
        expect(cargarDatosMotor).toHaveBeenCalledWith(['r1']);
    });

    test('la configuración de designación no resuelta bloquea el reemplazo (conservador: nunca se reemplaza a ciegas)', async () => {
        crearSupabaseMock({
            asignaciones: [{ data: ASIGNACION_ACTUAL, error: null }, { data: [], error: null }],
            catalogo_motivos_designacion: { data: { id: 'mot-1', activo: true }, error: null },
            usuarios_pagados: { data: { id: 'jur-B', nombre_completo: 'Jurado B', tipo_persona: 'jurado', categoria: 'B', activo: true }, error: null },
            disponibilidad_usuarios: { data: [{ fecha: '2026-11-07' }, { fecha: '2026-11-08' }], error: null }
        });
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ error: 'CONFIGURACION_DESIGNACION_NO_RESUELTA', detalle: 'sin config activa' });

        const { status } = await llamarRuta({
            method: 'POST', url: '/asig-1/reemplazar', params: { id: 'asig-1' },
            body: { usuario_pagado_id_nuevo: 'jur-B', motivo_codigo: 'jurado_no_disponible' }
        });

        expect(status).toBe(409);
        expect(supabase.rpc).not.toHaveBeenCalled();
        expect(evaluarElegibilidadJurado).not.toHaveBeenCalled();
    });
});
