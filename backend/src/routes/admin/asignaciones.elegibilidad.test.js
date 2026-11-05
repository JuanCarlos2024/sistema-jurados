// POST /api/admin/asignaciones — Auditoría de elegibilidad (Etapa A).
//
// Causa raíz corregida: esta ruta ("Designar jurado" en Rodeos) solo
// validaba disponibilidad declarada y cruce de fechas — nunca
// MISMA_ASOCIACION (conflicto de interés real), categoría/matriz ni
// distancia. Podía escribirse una designación real violando una
// restricción obligatoria, sin ninguna advertencia. Se reutiliza el mismo
// mecanismo de elegibilidad que ya usa Propuesta de Designación
// (services/elegibilidadJurado.js, que a su vez envuelve
// evaluarCandidato() — nunca una regla nueva).
//
// Mismo patrón de router directo (sin HTTP real) que
// asignaciones.orquestacion.test.js. Se mockean cargarConfiguracionDesignacionActiva/
// cargarDatosMotor/evaluarElegibilidadJurado para aislar esta ruta de la
// evaluación real del motor (ya cubierta en otros archivos) y poder
// controlar exactamente el estado de elegibilidad en cada escenario.
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
const { cargarDatosMotor } = require('../../services/motorPropuestaDesignacion');
const { cargarConfiguracionDesignacionActiva } = require('../../services/configuracionDesignacionRepositorio');
const { evaluarElegibilidadJurado } = require('../../services/elegibilidadJurado');
const router = require('./asignaciones');

// Mismo helper liviano (queue por tabla) que asignaciones.orquestacion.test.js.
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
const TARIFAS = [{ categoria: 'A', valor_diario: 100000 }, { categoria: 'DR', valor_diario: 80000 }];

function llamarPost(personas) {
    return llamarRuta({ method: 'POST', url: '/', body: { rodeo_id: 'R1', personas } });
}

function contarLlamadasATabla(tabla) {
    return supabase.from.mock.calls.filter(c => c[0] === tabla).length;
}

beforeEach(() => {
    jest.clearAllMocks();
    cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: { _fake: true } });
    cargarDatosMotor.mockResolvedValue({ _contextoFake: true });
});

describe('POST / — elegibilidad real de jurados (Etapa A)', () => {
    test('DISPONIBLE_Y_HABILITADO -> se crea normalmente (sin regresión del flujo existente)', async () => {
        crearSupabaseMock({
            rodeos: { data: RODEO, error: null },
            configuracion_tarifas: { data: TARIFAS, error: null },
            usuarios_pagados: { data: { id: 'J1', nombre_completo: 'Jurado Uno', tipo_persona: 'jurado', categoria: 'A', activo: true }, error: null },
            disponibilidad_usuarios: { data: [{ fecha: '2026-11-07' }], error: null },
            asignaciones: [
                { data: [], error: null }, // chequeo de cruce con otros rodeos
                { data: { id: 'asig-1', usuario_pagado_id: 'J1' }, error: null } // insert
            ]
        });
        evaluarElegibilidadJurado.mockReturnValue({ estado: 'DISPONIBLE_Y_HABILITADO', causas: [], causas_obligatorias: [], causas_relajables: [], distancia_km: 50 });

        const { status, body } = await llamarPost([{ usuario_pagado_id: 'J1', tipo_persona: 'jurado' }]);

        expect(status).toBe(201);
        expect(body.creadas).toHaveLength(1);
        expect(body.errores).toHaveLength(0);
        expect(evaluarElegibilidadJurado).toHaveBeenCalledWith({ _contextoFake: true }, 'R1', 'J1', { _fake: true });
    });

    test('NO_HABILITADO (ej. MISMA_ASOCIACION) -> nunca se crea la designación, el error reporta la causa obligatoria', async () => {
        crearSupabaseMock({
            rodeos: { data: RODEO, error: null },
            configuracion_tarifas: { data: TARIFAS, error: null },
            usuarios_pagados: { data: { id: 'J1', nombre_completo: 'Jurado Uno', tipo_persona: 'jurado', categoria: 'A', activo: true }, error: null },
            disponibilidad_usuarios: { data: [{ fecha: '2026-11-07' }], error: null },
            asignaciones: { data: [], error: null } // solo el chequeo de cruce; el insert NUNCA debe pedirse
        });
        evaluarElegibilidadJurado.mockReturnValue({ estado: 'NO_HABILITADO', causas: ['MISMA_ASOCIACION'], causas_obligatorias: ['MISMA_ASOCIACION'], causas_relajables: [], distancia_km: null });

        const { status, body } = await llamarPost([{ usuario_pagado_id: 'J1', tipo_persona: 'jurado' }]);

        expect(status).toBe(201); // la ruta siempre responde 201 e informa el detalle en "errores"
        expect(body.creadas).toHaveLength(0);
        expect(body.errores).toHaveLength(1);
        expect(body.errores[0]).toEqual(expect.objectContaining({ usuario_pagado_id: 'J1', estado_elegibilidad: 'NO_HABILITADO', causas: ['MISMA_ASOCIACION'] }));
        expect(contarLlamadasATabla('asignaciones')).toBe(1); // solo el chequeo de cruce, nunca el insert
    });

    test('CON_ADVERTENCIAS sin confirmar_advertencias -> se bloquea y pide confirmación explícita, nunca se crea', async () => {
        crearSupabaseMock({
            rodeos: { data: RODEO, error: null },
            configuracion_tarifas: { data: TARIFAS, error: null },
            usuarios_pagados: { data: { id: 'J1', nombre_completo: 'Jurado Uno', tipo_persona: 'jurado', categoria: 'A', activo: true }, error: null },
            disponibilidad_usuarios: { data: [{ fecha: '2026-11-07' }], error: null },
            asignaciones: { data: [], error: null }
        });
        evaluarElegibilidadJurado.mockReturnValue({ estado: 'CON_ADVERTENCIAS', causas: ['DISTANCIA_EXCEDIDA'], causas_obligatorias: [], causas_relajables: ['DISTANCIA_EXCEDIDA'], distancia_km: 800 });

        const { body } = await llamarPost([{ usuario_pagado_id: 'J1', tipo_persona: 'jurado' }]); // sin confirmar_advertencias

        expect(body.creadas).toHaveLength(0);
        expect(body.errores[0]).toEqual(expect.objectContaining({ estado_elegibilidad: 'CON_ADVERTENCIAS', causas: ['DISTANCIA_EXCEDIDA'], requiere_confirmacion: true }));
        expect(contarLlamadasATabla('asignaciones')).toBe(1);
    });

    test('CON_ADVERTENCIAS con confirmar_advertencias:true pero SIN motivo_codigo -> bloquea con requiere_motivo (la excepción nunca se guarda sin justificación)', async () => {
        crearSupabaseMock({
            rodeos: { data: RODEO, error: null },
            configuracion_tarifas: { data: TARIFAS, error: null },
            usuarios_pagados: { data: { id: 'J1', nombre_completo: 'Jurado Uno', tipo_persona: 'jurado', categoria: 'A', activo: true }, error: null },
            disponibilidad_usuarios: { data: [{ fecha: '2026-11-07' }], error: null },
            asignaciones: { data: [], error: null }
        });
        evaluarElegibilidadJurado.mockReturnValue({ estado: 'CON_ADVERTENCIAS', causas: ['DISTANCIA_EXCEDIDA'], causas_obligatorias: [], causas_relajables: ['DISTANCIA_EXCEDIDA'], distancia_km: 800 });

        const { body } = await llamarPost([{ usuario_pagado_id: 'J1', tipo_persona: 'jurado', confirmar_advertencias: true }]);

        expect(body.creadas).toHaveLength(0);
        expect(body.errores[0]).toEqual(expect.objectContaining({ requiere_motivo: true, causas: ['DISTANCIA_EXCEDIDA'] }));
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('CON_ADVERTENCIAS con confirmar_advertencias:true + motivo_codigo válido -> crea vía crear_asignacion_con_bitacora (atómico, excepción administrativa justificada, nunca por defecto)', async () => {
        crearSupabaseMock({
            rodeos: { data: RODEO, error: null },
            configuracion_tarifas: { data: TARIFAS, error: null },
            usuarios_pagados: { data: { id: 'J1', nombre_completo: 'Jurado Uno', tipo_persona: 'jurado', categoria: 'A', activo: true }, error: null },
            disponibilidad_usuarios: { data: [{ fecha: '2026-11-07' }], error: null },
            asignaciones: { data: [], error: null },
            catalogo_motivos_designacion: { data: { id: 'mot-1', activo: true }, error: null }
        });
        evaluarElegibilidadJurado.mockReturnValue({ estado: 'CON_ADVERTENCIAS', causas: ['DISTANCIA_EXCEDIDA'], causas_obligatorias: [], causas_relajables: ['DISTANCIA_EXCEDIDA'], distancia_km: 800 });
        supabase.rpc.mockResolvedValue({ data: { asignacion: { id: 'asig-1', usuario_pagado_id: 'J1' }, bitacora_id: 'bit-1' }, error: null });

        const { body } = await llamarPost([{
            usuario_pagado_id: 'J1', tipo_persona: 'jurado', confirmar_advertencias: true,
            motivo_codigo: 'criterio_tecnico_area_deportiva', motivo_detalle: 'Único disponible en la zona'
        }]);

        expect(body.creadas).toHaveLength(1);
        expect(body.errores).toHaveLength(0);
        expect(supabase.rpc).toHaveBeenCalledWith('crear_asignacion_con_bitacora', expect.objectContaining({
            p_rodeo_id: 'R1', p_usuario_pagado_id: 'J1', p_motivo_catalogo_id: 'mot-1',
            p_causas_confirmadas: JSON.stringify(['DISTANCIA_EXCEDIDA']), p_motivo_detalle: 'Único disponible en la zona'
        }));
    });

    test('CON_ADVERTENCIAS con motivo_codigo inválido/inactivo -> bloquea, nunca llama a la RPC', async () => {
        crearSupabaseMock({
            rodeos: { data: RODEO, error: null },
            configuracion_tarifas: { data: TARIFAS, error: null },
            usuarios_pagados: { data: { id: 'J1', nombre_completo: 'Jurado Uno', tipo_persona: 'jurado', categoria: 'A', activo: true }, error: null },
            disponibilidad_usuarios: { data: [{ fecha: '2026-11-07' }], error: null },
            asignaciones: { data: [], error: null },
            catalogo_motivos_designacion: { data: null, error: null }
        });
        evaluarElegibilidadJurado.mockReturnValue({ estado: 'CON_ADVERTENCIAS', causas: ['DISTANCIA_EXCEDIDA'], causas_obligatorias: [], causas_relajables: ['DISTANCIA_EXCEDIDA'], distancia_km: 800 });

        const { body } = await llamarPost([{ usuario_pagado_id: 'J1', tipo_persona: 'jurado', confirmar_advertencias: true, motivo_codigo: 'inexistente' }]);

        expect(body.creadas).toHaveLength(0);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('configuración de designación no disponible -> bloquea con mensaje explicativo, nunca crea ni evalúa a ciegas', async () => {
        crearSupabaseMock({
            rodeos: { data: RODEO, error: null },
            configuracion_tarifas: { data: TARIFAS, error: null },
            usuarios_pagados: { data: { id: 'J1', nombre_completo: 'Jurado Uno', tipo_persona: 'jurado', categoria: 'A', activo: true }, error: null },
            disponibilidad_usuarios: { data: [{ fecha: '2026-11-07' }], error: null },
            asignaciones: { data: [], error: null }
        });
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ error: 'CONFIGURACION_DESIGNACION_NO_RESUELTA', detalle: 'sin config activa' });

        const { body } = await llamarPost([{ usuario_pagado_id: 'J1', tipo_persona: 'jurado' }]);

        expect(body.creadas).toHaveLength(0);
        expect(body.errores[0].error).toMatch(/elegibilidad/i);
        expect(body.errores[0].error).toMatch(/sin config activa/);
        expect(evaluarElegibilidadJurado).not.toHaveBeenCalled();
        expect(contarLlamadasATabla('asignaciones')).toBe(1);
    });

    test('delegado_rentado -> nunca pasa por elegibilidad (el chequeo es exclusivo de jurados) y se crea igual que antes', async () => {
        crearSupabaseMock({
            rodeos: { data: RODEO, error: null },
            configuracion_tarifas: { data: TARIFAS, error: null },
            usuarios_pagados: { data: { id: 'D1', nombre_completo: 'Delegado Uno', tipo_persona: 'delegado_rentado', categoria: null, activo: true }, error: null },
            asignaciones: { data: { id: 'asig-2', usuario_pagado_id: 'D1' }, error: null } // directo al insert, sin chequeo de cruce (no es jurado)
        });

        const { status, body } = await llamarPost([{ usuario_pagado_id: 'D1', tipo_persona: 'delegado_rentado' }]);

        expect(status).toBe(201);
        expect(body.creadas).toHaveLength(1);
        expect(body.errores).toHaveLength(0);
        expect(cargarConfiguracionDesignacionActiva).not.toHaveBeenCalled();
        expect(cargarDatosMotor).not.toHaveBeenCalled();
        expect(evaluarElegibilidadJurado).not.toHaveBeenCalled();
    });

    test('lote mixto: un jurado NO_HABILITADO no bloquea al delegado_rentado del mismo lote', async () => {
        crearSupabaseMock({
            rodeos: { data: RODEO, error: null },
            configuracion_tarifas: { data: TARIFAS, error: null },
            usuarios_pagados: [
                { data: { id: 'J1', nombre_completo: 'Jurado Uno', tipo_persona: 'jurado', categoria: 'A', activo: true }, error: null },
                { data: { id: 'D1', nombre_completo: 'Delegado Uno', tipo_persona: 'delegado_rentado', categoria: null, activo: true }, error: null }
            ],
            disponibilidad_usuarios: { data: [{ fecha: '2026-11-07' }], error: null },
            asignaciones: [
                { data: [], error: null }, // chequeo de cruce de J1
                { data: { id: 'asig-2', usuario_pagado_id: 'D1' }, error: null } // insert de D1
            ]
        });
        evaluarElegibilidadJurado.mockReturnValue({ estado: 'NO_HABILITADO', causas: ['MISMA_ASOCIACION'], causas_obligatorias: ['MISMA_ASOCIACION'], causas_relajables: [], distancia_km: null });

        const { body } = await llamarPost([
            { usuario_pagado_id: 'J1', tipo_persona: 'jurado' },
            { usuario_pagado_id: 'D1', tipo_persona: 'delegado_rentado' }
        ]);

        expect(body.creadas).toHaveLength(1);
        expect(body.creadas[0].usuario_pagado_id).toBe('D1');
        expect(body.errores).toHaveLength(1);
        expect(body.errores[0].usuario_pagado_id).toBe('J1');
    });
});
