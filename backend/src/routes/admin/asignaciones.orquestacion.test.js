// ═════════════════════════════════════════════════════════════════════════
// Tests de ORQUESTACIÓN DE RUTA — admin/asignaciones.js (Fase 1B, revisión
// correctiva). Mismo patrón que propuesta-designacion.orquestacion.test.js y
// comisiones-asociacion.test.js: se invoca el router de Express directamente
// (sin servidor HTTP, sin supertest) con un req/res mínimos. Se mockea
// `../../config/supabase` (from + rpc) y `../../services/auditoria`;
// `../../services/calculo` (calcularPagoBase) se mantiene REAL — es puro —
// para probar de verdad que la tarifa se recalcula desde la categoría del
// jurado NUEVO y nunca se hereda de la persona anterior (punto 2 del pedido
// de revisión correctiva).
//
// Cubre exclusivamente PEGAMENTO DE RUTA:
//   - PATCH /:id ya rechaza cualquier intento de cambiar usuario_pagado_id
//     (punto 1), sin afectar los demás campos.
//   - POST /:id/reemplazar: validaciones previas a la RPC, mapeo de cada
//     código de error a su status HTTP, y que la tarifa enviada a la RPC
//     corresponde siempre a la categoría del jurado nuevo (A->B->C->A).
//   - GET /motivos-designacion.
//
// La lógica transaccional real (bloqueos, antecedentes sensibles, append-
// only, etc.) ya está cubierta exhaustivamente contra Postgres real en
// reemplazoJuradoAsignacion.rpc.test.js — este archivo NO la vuelve a probar.
// ═════════════════════════════════════════════════════════════════════════
jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
jest.mock('../../services/auditoria', () => ({ registrar: jest.fn().mockResolvedValue(undefined) }));

const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');
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

beforeEach(() => {
    jest.clearAllMocks();
});

describe('PATCH /:id — ya no permite cambiar usuario_pagado_id (punto 1)', () => {
    test('con usuario_pagado_id distinto del actual -> 409 USAR_ENDPOINT_REEMPLAZO, sin llegar a actualizar nada', async () => {
        crearSupabaseMock({
            asignaciones: { data: { id: 'asig-1', estado: 'activo', usuario_pagado_id: 'jur-A', duracion_dias_aplicada: 2, rodeos: { duracion_dias: 2 } }, error: null }
        });
        const { status, body } = await llamarRuta({
            method: 'PATCH', url: '/asig-1', params: { id: 'asig-1' },
            body: { usuario_pagado_id: 'jur-B' }
        });
        expect(status).toBe(409);
        expect(body.code).toBe('USAR_ENDPOINT_REEMPLAZO');
    });

    test('con el mismo usuario_pagado_id ya vigente (no-op de identidad) -> sigue permitiéndose, no es un cambio', async () => {
        crearSupabaseMock({
            asignaciones: [
                { data: { id: 'asig-1', estado: 'activo', usuario_pagado_id: 'jur-A', duracion_dias_aplicada: 2, rodeos: { duracion_dias: 2 } }, error: null },
                { data: { id: 'asig-1', observacion: 'ok' }, error: null }
            ]
        });
        const { status } = await llamarRuta({
            method: 'PATCH', url: '/asig-1', params: { id: 'asig-1' },
            body: { usuario_pagado_id: 'jur-A', observacion: 'ok' }
        });
        expect(status).toBe(200);
    });

    test('sin tocar usuario_pagado_id (solo observación/km) -> sigue funcionando exactamente igual que antes', async () => {
        crearSupabaseMock({
            asignaciones: [
                { data: { id: 'asig-1', estado: 'activo', usuario_pagado_id: 'jur-A', duracion_dias_aplicada: 2, rodeos: { duracion_dias: 2 } }, error: null },
                { data: { id: 'asig-1', observacion: 'nueva observación' }, error: null }
            ],
            bonos_solicitados: { data: [], error: null }
        });
        const { status, body } = await llamarRuta({
            method: 'PATCH', url: '/asig-1', params: { id: 'asig-1' },
            body: { observacion: 'nueva observación' }
        });
        expect(status).toBe(200);
        expect(body.observacion).toBe('nueva observación');
    });
});

describe('POST /:id/reemplazar — validaciones previas y mapeo de errores', () => {
    test('sin usuario_pagado_id_nuevo -> 400, nunca llega a tocar la BD', async () => {
        const { status, body } = await llamarRuta({ method: 'POST', url: '/asig-1/reemplazar', params: { id: 'asig-1' }, body: { motivo_codigo: 'otro' } });
        expect(status).toBe(400);
        expect(supabase.from).not.toHaveBeenCalled();
    });

    test('sin motivo_codigo -> 400, nunca llega a tocar la BD', async () => {
        const { status } = await llamarRuta({ method: 'POST', url: '/asig-1/reemplazar', params: { id: 'asig-1' }, body: { usuario_pagado_id_nuevo: 'jur-B' } });
        expect(status).toBe(400);
        expect(supabase.from).not.toHaveBeenCalled();
    });

    test('asignación no encontrada -> 404', async () => {
        crearSupabaseMock({ asignaciones: { data: null, error: null } });
        const { status } = await llamarRuta({
            method: 'POST', url: '/asig-1/reemplazar', params: { id: 'asig-1' },
            body: { usuario_pagado_id_nuevo: 'jur-B', motivo_codigo: 'otro' }
        });
        expect(status).toBe(404);
    });

    test('asignación de delegado_rentado -> 400, nunca llama al motivo ni a la RPC', async () => {
        crearSupabaseMock({ asignaciones: { data: { id: 'asig-1', tipo_persona: 'delegado_rentado' }, error: null } });
        const { status } = await llamarRuta({
            method: 'POST', url: '/asig-1/reemplazar', params: { id: 'asig-1' },
            body: { usuario_pagado_id_nuevo: 'jur-B', motivo_codigo: 'otro' }
        });
        expect(status).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('motivo_codigo inexistente/inactivo -> 400, nunca llama a la RPC', async () => {
        crearSupabaseMock({
            asignaciones: { data: { id: 'asig-1', tipo_persona: 'jurado', rodeo_id: 'r1', rodeos: { fecha: null } }, error: null },
            catalogo_motivos_designacion: { data: null, error: null }
        });
        const { status } = await llamarRuta({
            method: 'POST', url: '/asig-1/reemplazar', params: { id: 'asig-1' },
            body: { usuario_pagado_id_nuevo: 'jur-B', motivo_codigo: 'inexistente' }
        });
        expect(status).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test.each([
        ['ASIGNACION_NO_ENCONTRADA', 404],
        ['ASIGNACION_ANULADA', 400],
        ['CONFLICTO_DESIGNACION_MODIFICADA', 409],
        ['JURADO_NUEVO_INVALIDO', 400],
        ['ANTECEDENTE_SENSIBLE_NOTA', 409],
        ['ANTECEDENTE_SENSIBLE_BONO', 409],
        ['ANTECEDENTE_SENSIBLE_CARTILLA', 409],
        ['JURADO_YA_DESIGNADO_EN_RODEO', 409],
        ['CRUCE_DISPONIBILIDAD', 409]
    ])('la RPC falla con %s -> %i', async (codigo, statusEsperado) => {
        crearSupabaseMock({
            asignaciones: { data: { id: 'asig-1', tipo_persona: 'jurado', rodeo_id: 'r1', duracion_dias_aplicada: 2, rodeos: { fecha: null, duracion_dias: 2 } }, error: null },
            catalogo_motivos_designacion: { data: { id: 'mot-1', activo: true }, error: null },
            usuarios_pagados: { data: { id: 'jur-B', nombre_completo: 'Jurado B', tipo_persona: 'jurado', categoria: 'A', activo: true }, error: null },
            configuracion_tarifas: { data: [{ categoria: 'A', valor_diario: 100000 }], error: null }
        });
        supabase.rpc.mockResolvedValue({ data: null, error: { message: codigo } });

        const { status } = await llamarRuta({
            method: 'POST', url: '/asig-1/reemplazar', params: { id: 'asig-1' },
            body: { usuario_pagado_id_nuevo: 'jur-B', motivo_codigo: 'otro' }
        });
        expect(status).toBe(statusEsperado);
    });

    test('aviso rápido en JS (antes de llamar a la RPC): cruce de fechas con otro rodeo del jurado nuevo -> 409 CRUCE_DISPONIBILIDAD', async () => {
        crearSupabaseMock({
            asignaciones: [
                { data: { id: 'asig-1', tipo_persona: 'jurado', rodeo_id: 'r1', duracion_dias_aplicada: 1, rodeos: { fecha: '2026-07-10', duracion_dias: 1 } }, error: null },
                { data: [{ id: 'asig-otra', rodeos: { fecha: '2026-07-10', duracion_dias: 1, club: 'Otro Club' } }], error: null }
            ],
            catalogo_motivos_designacion: { data: { id: 'mot-1', activo: true }, error: null },
            usuarios_pagados: { data: { id: 'jur-B', nombre_completo: 'Jurado B', tipo_persona: 'jurado', categoria: 'B', activo: true }, error: null },
            disponibilidad_usuarios: { data: [{ fecha: '2026-07-10' }], error: null }
        });
        const { status, body } = await llamarRuta({
            method: 'POST', url: '/asig-1/reemplazar', params: { id: 'asig-1' },
            body: { usuario_pagado_id_nuevo: 'jur-B', motivo_codigo: 'otro' }
        });
        expect(status).toBe(409);
        expect(body.code).toBe('CRUCE_DISPONIBILIDAD');
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('éxito: llama a la RPC con la tarifa de la categoría del jurado NUEVO y registra auditoría', async () => {
        crearSupabaseMock({
            asignaciones: { data: { id: 'asig-1', tipo_persona: 'jurado', rodeo_id: 'r1', duracion_dias_aplicada: 2, rodeos: { fecha: null, duracion_dias: 2 } }, error: null },
            catalogo_motivos_designacion: { data: { id: 'mot-1', activo: true }, error: null },
            usuarios_pagados: { data: { id: 'jur-B', nombre_completo: 'Jurado B', tipo_persona: 'jurado', categoria: 'B', activo: true }, error: null },
            configuracion_tarifas: { data: [{ categoria: 'A', valor_diario: 292000 }, { categoria: 'B', valor_diario: 245000 }, { categoria: 'C', valor_diario: 213500 }], error: null }
        });
        supabase.rpc.mockResolvedValue({ data: { asignacion: { id: 'asig-1', usuario_pagado_id: 'jur-B' }, bitacora_id: 'bit-1', usuario_pagado_id_anterior: 'jur-A', nombre_anterior_snapshot: 'Jurado A' }, error: null });

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/asig-1/reemplazar', params: { id: 'asig-1' },
            body: { usuario_pagado_id_nuevo: 'jur-B', motivo_codigo: 'jurado_no_disponible' }
        });

        expect(status).toBe(200);
        expect(body.bitacora_id).toBe('bit-1');
        expect(supabase.rpc).toHaveBeenCalledWith('reemplazar_jurado_asignacion_con_bitacora', expect.objectContaining({
            p_categoria_aplicada_nueva: 'B',
            p_valor_diario_aplicado_nuevo: 245000,
            p_pago_base_calculado_nuevo: 490000 // 245000 * 2 días
        }));
        expect(auditoria.registrar).toHaveBeenCalledTimes(1);
    });
});

describe('POST /:id/reemplazar — recálculo de tarifa nunca hereda la del anterior (punto 2: A->B->C->A)', () => {
    const TARIFAS = [{ categoria: 'A', valor_diario: 300000 }, { categoria: 'B', valor_diario: 250000 }, { categoria: 'C', valor_diario: 200000 }];

    async function reemplazarPor(categoriaNueva, duracionDias = 1) {
        crearSupabaseMock({
            asignaciones: { data: { id: 'asig-1', tipo_persona: 'jurado', rodeo_id: 'r1', duracion_dias_aplicada: duracionDias, rodeos: { fecha: null, duracion_dias: duracionDias } }, error: null },
            catalogo_motivos_designacion: { data: { id: 'mot-1', activo: true }, error: null },
            usuarios_pagados: { data: { id: 'jur-nuevo', nombre_completo: 'Jurado', tipo_persona: 'jurado', categoria: categoriaNueva, activo: true }, error: null },
            configuracion_tarifas: { data: TARIFAS, error: null }
        });
        supabase.rpc.mockResolvedValue({ data: { asignacion: { id: 'asig-1' }, bitacora_id: 'bit-x', usuario_pagado_id_anterior: 'x', nombre_anterior_snapshot: 'x' }, error: null });
        return llamarRuta({ method: 'POST', url: '/asig-1/reemplazar', params: { id: 'asig-1' }, body: { usuario_pagado_id_nuevo: 'jur-nuevo', motivo_codigo: 'otro' } });
    }

    test('A->B: la RPC recibe la tarifa de B (250.000), no la de A', async () => {
        await reemplazarPor('B');
        expect(supabase.rpc).toHaveBeenCalledWith('reemplazar_jurado_asignacion_con_bitacora', expect.objectContaining({ p_categoria_aplicada_nueva: 'B', p_valor_diario_aplicado_nuevo: 250000 }));
    });

    test('B->C: la RPC recibe la tarifa de C (200.000), no la de B', async () => {
        await reemplazarPor('C');
        expect(supabase.rpc).toHaveBeenCalledWith('reemplazar_jurado_asignacion_con_bitacora', expect.objectContaining({ p_categoria_aplicada_nueva: 'C', p_valor_diario_aplicado_nuevo: 200000 }));
    });

    test('C->A: la RPC recibe la tarifa de A (300.000), no la de C — y el pago base usa la duración real del rodeo', async () => {
        await reemplazarPor('A', 3);
        expect(supabase.rpc).toHaveBeenCalledWith('reemplazar_jurado_asignacion_con_bitacora', expect.objectContaining({
            p_categoria_aplicada_nueva: 'A', p_valor_diario_aplicado_nuevo: 300000, p_pago_base_calculado_nuevo: 900000
        }));
    });
});

describe('GET /motivos-designacion', () => {
    test('devuelve solo los motivos activos, ordenados', async () => {
        crearSupabaseMock({ catalogo_motivos_designacion: { data: [{ id: 'm1', codigo: 'otro', etiqueta: 'Otro' }], error: null } });
        const { status, body } = await llamarRuta({ method: 'GET', url: '/motivos-designacion' });
        expect(status).toBe(200);
        expect(body.motivos).toHaveLength(1);
    });
});
