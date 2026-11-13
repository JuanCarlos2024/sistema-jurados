// Hotfix — reemplazo de jurado con advertencias (preferencias flexibles).
// Caso real (reproducido con datos FICTICIOS, nunca producción): rodeo
// VICTORIA/MALLECO 14-15/11/2026, reemplazante categoría C con
// FINDE_CONSECUTIVO (otro rodeo aceptado el fin de semana siguiente).
//
// POST /api/admin/asignaciones/:id/reemplazar debe:
//   - exigir confirmar_advertencias:true + causas_aceptadas EXACTAS (como
//     conjunto) frente a la revalidación del motor;
//   - responder 409 si falta, sobra o cambió una causa (nunca guardar);
//   - bloquear siempre NO_HABILITADO;
//   - enviar p_causas_confirmadas a la RPC (bitácora) y registrar causas,
//     motivo, comentario y responsable en la auditoría.
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

function llamarRuta({ body, id = 'asig-victoria' }) {
    return new Promise((resolve, reject) => {
        const url = `/${id}/reemplazar`;
        const req = {
            method: 'POST', url, originalUrl: url, body: body || {}, query: {}, params: { id }, headers: {},
            ip: '127.0.0.1', usuario: { id: 'admin-responsable', tipo: 'administrador', rol_evaluacion: null },
            get() { return undefined; }
        };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(payload) { resolve({ status: this.statusCode, body: payload }); return this; }
        };
        router(req, res, (err) => err ? reject(err) : resolve({ status: 404, body: {} }));
    });
}

// ── Datos ficticios del caso VICTORIA (sin ningún id real) ────────────────
const ASIG_VICTORIA = { id: 'asig-victoria', tipo_persona: 'jurado', rodeo_id: 'rodeo-victoria', usuario_pagado_id: 'jurado-actual-ficticio', duracion_dias_aplicada: 2, rodeos: { fecha: '2026-11-14', duracion_dias: 2 } };
const REEMPLAZANTE = { id: 'jurado-reemplazante-ficticio', nombre_completo: 'Jurado Reemplazante Ficticio', tipo_persona: 'jurado', categoria: 'C', activo: true };
const TARIFAS = [{ categoria: 'C', valor_diario: 200000 }];

function prepararBd() {
    crearSupabaseMock({
        asignaciones: [{ data: ASIG_VICTORIA, error: null }, { data: [], error: null }],
        catalogo_motivos_designacion: { data: { id: 'mot-indisp', activo: true }, error: null },
        usuarios_pagados: { data: REEMPLAZANTE, error: null },
        disponibilidad_usuarios: { data: [{ fecha: '2026-11-14' }, { fecha: '2026-11-15' }], error: null },
        configuracion_tarifas: { data: TARIFAS, error: null }
    });
}
const elegibilidad = (estado, relajables = [], obligatorias = []) => ({
    estado, causas: [...obligatorias, ...relajables], causas_obligatorias: obligatorias, causas_relajables: relajables, distancia_km: 407
});
const rpcOk = () => supabase.rpc.mockResolvedValue({
    data: { asignacion: { id: 'asig-victoria', usuario_pagado_id: REEMPLAZANTE.id }, bitacora_id: 'bit-1', usuario_pagado_id_anterior: 'jurado-actual-ficticio', nombre_anterior_snapshot: 'Jurado Actual Ficticio' },
    error: null
});
const BASE = {
    usuario_pagado_id_nuevo: REEMPLAZANTE.id, motivo_codigo: 'jurado_no_disponible',
    motivo_detalle: 'El jurado titular tiene problemas personales y solicita el cambio.',
    usuario_pagado_id_anterior_esperado: 'jurado-actual-ficticio'
};

beforeEach(() => {
    jest.clearAllMocks();
    supabase.rpc.mockReset();
    cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: { _fake: true } });
    cargarDatosMotor.mockResolvedValue({ _contextoFake: true });
});

describe('reemplazo sin advertencias', () => {
    test('DISPONIBLE_Y_HABILITADO -> reemplazo normal; la RPC NO recibe p_causas_confirmadas (compatible con la firma previa a 099)', async () => {
        prepararBd(); rpcOk();
        evaluarElegibilidadJurado.mockReturnValue(elegibilidad('DISPONIBLE_Y_HABILITADO'));
        const r = await llamarRuta({ body: BASE });
        expect(r.status).toBe(200);
        const args = supabase.rpc.mock.calls[0][1];
        expect(args).not.toHaveProperty('p_causas_confirmadas');
        expect(args.p_motivo_detalle).toBe(BASE.motivo_detalle);
        expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({
            actor_id: 'admin-responsable',
            datos_nuevos: expect.objectContaining({ excepcion_advertencias: false, causas_confirmadas: null, motivo: 'jurado_no_disponible' })
        }));
    });
});

describe('caso VICTORIA (ficticio) — FINDE_CONSECUTIVO', () => {
    beforeEach(() => evaluarElegibilidadJurado.mockReturnValue(elegibilidad('CON_ADVERTENCIAS', ['FINDE_CONSECUTIVO'])));

    test('sin confirmación -> 409 REQUIERE_CONFIRMACION_ADVERTENCIAS con la causa concreta; nunca llama a la RPC', async () => {
        prepararBd();
        const r = await llamarRuta({ body: BASE });
        expect(r.status).toBe(409);
        expect(r.body).toMatchObject({ code: 'REQUIERE_CONFIRMACION_ADVERTENCIAS', causas: ['FINDE_CONSECUTIVO'], requiere_confirmacion: true });
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('confirmar_advertencias:true SIN lista de causas -> 409 (una confirmación genérica nunca basta)', async () => {
        prepararBd();
        const r = await llamarRuta({ body: { ...BASE, confirmar_advertencias: true } });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('REQUIERE_CONFIRMACION_ADVERTENCIAS');
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('causas_aceptadas sin confirmar_advertencias:true -> 409', async () => {
        prepararBd();
        const r = await llamarRuta({ body: { ...BASE, causas_aceptadas: ['FINDE_CONSECUTIVO'] } });
        expect(r.status).toBe(409);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('confirmación exacta -> 200; la RPC recibe las causas (bitácora) y la auditoría registra causa, motivo, comentario y responsable', async () => {
        prepararBd(); rpcOk();
        const r = await llamarRuta({ body: { ...BASE, confirmar_advertencias: true, causas_aceptadas: ['FINDE_CONSECUTIVO'] } });
        expect(r.status).toBe(200);
        expect(supabase.rpc).toHaveBeenCalledTimes(1);
        expect(supabase.rpc).toHaveBeenCalledWith('reemplazar_jurado_asignacion_con_bitacora', expect.objectContaining({
            p_usuario_pagado_id_nuevo: REEMPLAZANTE.id, p_motivo_catalogo_id: 'mot-indisp', p_actor_id: 'admin-responsable',
            p_motivo_detalle: BASE.motivo_detalle, p_usuario_pagado_id_anterior_esperado: 'jurado-actual-ficticio',
            p_causas_confirmadas: ['FINDE_CONSECUTIVO'], p_categoria_aplicada_nueva: 'C',
            p_valor_diario_aplicado_nuevo: 200000, p_pago_base_calculado_nuevo: 400000
        }));
        const llamada = auditoria.registrar.mock.calls[0][0];
        expect(llamada.actor_id).toBe('admin-responsable');
        expect(llamada.datos_nuevos).toMatchObject({
            motivo: 'jurado_no_disponible', motivo_detalle: BASE.motivo_detalle,
            excepcion_advertencias: true, causas_confirmadas: ['FINDE_CONSECUTIVO']
        });
        expect(llamada.descripcion).toMatch(/excepción administrativa: advertencias aceptadas FINDE_CONSECUTIVO/);
    });
});

describe('otras preferencias flexibles', () => {
    test.each([
        ['DISTANCIA_EXCEDIDA'], ['ASOCIACION_REPETIDA_TEMPORADA'], ['JURADO_SIN_COMUNA_RESOLVIBLE']
    ])('%s: sin confirmar -> 409; confirmado exacto -> 200 con la causa en la RPC', async (causa) => {
        evaluarElegibilidadJurado.mockReturnValue(elegibilidad('CON_ADVERTENCIAS', [causa]));
        prepararBd();
        expect((await llamarRuta({ body: BASE })).status).toBe(409);
        prepararBd(); rpcOk();
        const r = await llamarRuta({ body: { ...BASE, confirmar_advertencias: true, causas_aceptadas: [causa] } });
        expect(r.status).toBe(200);
        expect(supabase.rpc.mock.calls[0][1].p_causas_confirmadas).toEqual([causa]);
    });

    test('varias advertencias simultáneas: se aceptan como CONJUNTO (sin depender del orden) y se registran ordenadas', async () => {
        evaluarElegibilidadJurado.mockReturnValue(elegibilidad('CON_ADVERTENCIAS', ['FINDE_CONSECUTIVO', 'DISTANCIA_EXCEDIDA', 'ASOCIACION_REPETIDA_TEMPORADA']));
        prepararBd(); rpcOk();
        const r = await llamarRuta({ body: { ...BASE, confirmar_advertencias: true, causas_aceptadas: ['ASOCIACION_REPETIDA_TEMPORADA', 'FINDE_CONSECUTIVO', 'DISTANCIA_EXCEDIDA'] } });
        expect(r.status).toBe(200);
        expect(supabase.rpc.mock.calls[0][1].p_causas_confirmadas).toEqual(['ASOCIACION_REPETIDA_TEMPORADA', 'DISTANCIA_EXCEDIDA', 'FINDE_CONSECUTIVO']);
    });
});

describe('confirmación desactualizada o insuficiente -> 409, nunca se guarda', () => {
    test('causa FALTANTE (apareció una nueva entre selección y guardado) -> 409 ADVERTENCIAS_CAMBIARON con causas_nuevas', async () => {
        evaluarElegibilidadJurado.mockReturnValue(elegibilidad('CON_ADVERTENCIAS', ['FINDE_CONSECUTIVO', 'DISTANCIA_EXCEDIDA']));
        prepararBd();
        const r = await llamarRuta({ body: { ...BASE, confirmar_advertencias: true, causas_aceptadas: ['FINDE_CONSECUTIVO'] } });
        expect(r.status).toBe(409);
        expect(r.body).toMatchObject({ code: 'ADVERTENCIAS_CAMBIARON', causas: ['DISTANCIA_EXCEDIDA', 'FINDE_CONSECUTIVO'], causas_nuevas: ['DISTANCIA_EXCEDIDA'], causas_ya_no_existen: [] });
        expect(supabase.rpc).not.toHaveBeenCalled();
        expect(auditoria.registrar).not.toHaveBeenCalled();
    });

    test('causa que YA NO EXISTE -> 409 ADVERTENCIAS_CAMBIARON con causas_ya_no_existen', async () => {
        evaluarElegibilidadJurado.mockReturnValue(elegibilidad('CON_ADVERTENCIAS', ['FINDE_CONSECUTIVO']));
        prepararBd();
        const r = await llamarRuta({ body: { ...BASE, confirmar_advertencias: true, causas_aceptadas: ['FINDE_CONSECUTIVO', 'DISTANCIA_EXCEDIDA'] } });
        expect(r.status).toBe(409);
        expect(r.body).toMatchObject({ code: 'ADVERTENCIAS_CAMBIARON', causas_nuevas: [], causas_ya_no_existen: ['DISTANCIA_EXCEDIDA'] });
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('se aceptaron advertencias pero HOY el candidato no tiene ninguna -> 409 (la decisión se tomó sobre otro estado)', async () => {
        evaluarElegibilidadJurado.mockReturnValue(elegibilidad('DISPONIBLE_Y_HABILITADO'));
        prepararBd();
        const r = await llamarRuta({ body: { ...BASE, confirmar_advertencias: true, causas_aceptadas: ['FINDE_CONSECUTIVO'] } });
        expect(r.status).toBe(409);
        expect(r.body).toMatchObject({ code: 'ADVERTENCIAS_CAMBIARON', causas: [], causas_ya_no_existen: ['FINDE_CONSECUTIVO'] });
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('incluir una causa OBLIGATORIA en causas_aceptadas nunca la autoriza (el conjunto no coincide) -> 409', async () => {
        evaluarElegibilidadJurado.mockReturnValue(elegibilidad('CON_ADVERTENCIAS', ['FINDE_CONSECUTIVO']));
        prepararBd();
        const r = await llamarRuta({ body: { ...BASE, confirmar_advertencias: true, causas_aceptadas: ['FINDE_CONSECUTIVO', 'MISMA_ASOCIACION'] } });
        expect(r.status).toBe(409);
        expect(r.body.causas_ya_no_existen).toEqual(['MISMA_ASOCIACION']);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test.each([
        ['un string', 'FINDE_CONSECUTIVO'], ['un número dentro de la lista', [1]], ['duplicados', ['FINDE_CONSECUTIVO', 'FINDE_CONSECUTIVO']], ['texto vacío', ['']]
    ])('causas_aceptadas mal formadas (%s) -> 400, nunca llega al motor ni a la RPC', async (_d, valor) => {
        prepararBd();
        const r = await llamarRuta({ body: { ...BASE, confirmar_advertencias: true, causas_aceptadas: valor } });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('CAUSAS_ACEPTADAS_INVALIDAS');
        expect(evaluarElegibilidadJurado).not.toHaveBeenCalled();
        expect(supabase.rpc).not.toHaveBeenCalled();
    });
});

describe('restricciones obligatorias — bloqueo absoluto', () => {
    test('NO_HABILITADO + confirmar_advertencias + causas_aceptadas (incluso las obligatorias) -> 409 RESTRICCION_OBLIGATORIA, nunca la RPC', async () => {
        evaluarElegibilidadJurado.mockReturnValue(elegibilidad('NO_HABILITADO', ['FINDE_CONSECUTIVO'], ['MISMO_FINDE']));
        prepararBd();
        const r = await llamarRuta({ body: { ...BASE, confirmar_advertencias: true, causas_aceptadas: ['FINDE_CONSECUTIVO', 'MISMO_FINDE'] } });
        expect(r.status).toBe(409);
        expect(r.body).toMatchObject({ code: 'RESTRICCION_OBLIGATORIA', causas: ['MISMO_FINDE'] });
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('la validación de disponibilidad/cruce sigue ANTES del motor: cruce real -> 409 CRUCE_DISPONIBILIDAD aunque se confirmen advertencias', async () => {
        crearSupabaseMock({
            asignaciones: [{ data: ASIG_VICTORIA, error: null }, { data: [{ id: 'otra', rodeo_id: 'rodeo-otro', estado_designacion: 'aceptado', rodeos: { fecha: '2026-11-15', duracion_dias: 1, club: 'OTRO' } }], error: null }],
            catalogo_motivos_designacion: { data: { id: 'mot-indisp', activo: true }, error: null },
            usuarios_pagados: { data: REEMPLAZANTE, error: null },
            disponibilidad_usuarios: { data: [{ fecha: '2026-11-14' }, { fecha: '2026-11-15' }], error: null }
        });
        evaluarElegibilidadJurado.mockReturnValue(elegibilidad('CON_ADVERTENCIAS', ['FINDE_CONSECUTIVO']));
        const r = await llamarRuta({ body: { ...BASE, confirmar_advertencias: true, causas_aceptadas: ['FINDE_CONSECUTIVO'] } });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('CRUCE_DISPONIBILIDAD');
        expect(supabase.rpc).not.toHaveBeenCalled();
    });
});

describe('errores de la RPC (099)', () => {
    beforeEach(() => evaluarElegibilidadJurado.mockReturnValue(elegibilidad('CON_ADVERTENCIAS', ['FINDE_CONSECUTIVO'])));
    const confirmado = { ...BASE, confirmar_advertencias: true, causas_aceptadas: ['FINDE_CONSECUTIVO'] };

    test('CAUSA_CONFIRMADA_DESCONOCIDA desde la BD -> 400 claro, sin auditoría', async () => {
        prepararBd();
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'CAUSA_CONFIRMADA_DESCONOCIDA: solo se aceptan causas relajables reconocidas por el motor' } });
        const r = await llamarRuta({ body: confirmado });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('CAUSAS_CONFIRMADAS_INVALIDAS');
        expect(auditoria.registrar).not.toHaveBeenCalled();
    });

    test('BD sin la migración 099 (PostgREST no encuentra la firma con p_causas_confirmadas) -> 409 MIGRACION_099_PENDIENTE, nunca un éxito sin registrar causas', async () => {
        prepararBd();
        supabase.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.reemplazar_jurado_asignacion_con_bitacora(p_actor_id, ..., p_causas_confirmadas) in the schema cache' } });
        const r = await llamarRuta({ body: confirmado });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('MIGRACION_099_PENDIENTE');
        expect(auditoria.registrar).not.toHaveBeenCalled();
    });

    test('conflicto de concurrencia de la RPC se conserva (CONFLICTO_DESIGNACION_MODIFICADA)', async () => {
        prepararBd();
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'CONFLICTO_DESIGNACION_MODIFICADA: la asignación ya fue modificada por otro administrador' } });
        const r = await llamarRuta({ body: confirmado });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('CONFLICTO_DESIGNACION_MODIFICADA');
    });
});
