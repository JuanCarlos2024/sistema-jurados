// ═════════════════════════════════════════════════════════════════════════
// Tests de ORQUESTACIÓN DE RUTA — PATCH /api/admin/rodeos/:id y POST /:id/
// reparar-sincronizacion-asignaciones, bug "ANCUD/CHILOÉ" (jurado Augusto
// González). Revisión correctiva: la sincronización rodeo↔asignaciones ya
// no se hace en dos pasos por JS (REST update + función JS aparte, que podía
// dejar un estado parcial si el segundo paso fallaba) — ahora PATCH /:id
// llama a la RPC transaccional `actualizar_tipo_rodeo_y_sincronizar_
// asignaciones` (migración 091) cuando cambia el tipo de rodeo, que
// actualiza `rodeos` Y sincroniza sus asignaciones en una sola transacción
// de Postgres. Mismo patrón de test que asignaciones.orquestacion.test.js:
// se invoca el router de Express directamente, se mockea `supabase.rpc` y se
// verifica el PEGAMENTO DE RUTA — la lógica real de la RPC (SQL) se revisó
// línea por línea contra el mismo algoritmo ya probado unitariamente en
// calculo.sincronizacionDuracion.test.js (ver nota en calculo.js).
jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
jest.mock('../../services/auditoria', () => ({ registrar: jest.fn().mockResolvedValue(undefined) }));

const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');
const router = require('./rodeos');

function crearSupabaseMock(porTabla) {
    const consumir = (tabla) => {
        const entrada = porTabla[tabla];
        if (entrada === undefined) return { data: null, error: null };
        if (Array.isArray(entrada)) return entrada.length > 1 ? entrada.shift() : entrada[0];
        return entrada;
    };
    supabase.from.mockImplementation((tabla) => {
        const chain = {
            select: () => chain, eq: () => chain, neq: () => chain, in: () => chain,
            ilike: () => chain, order: () => chain, limit: () => chain, range: () => chain,
            insert: () => chain, update: () => chain, delete: () => chain,
            single: () => Promise.resolve(consumir(tabla)), maybeSingle: () => Promise.resolve(consumir(tabla)),
            then: (resolve, reject) => Promise.resolve(consumir(tabla)).then(resolve, reject)
        };
        return chain;
    });
}

function llamarRuta({ method, url, body, params, usuario }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url,
            body: body || {}, query: {}, params: params || {}, headers: {},
            ip: '127.0.0.1',
            usuario: usuario || { id: 'admin-test', tipo: 'administrador', rol_evaluacion: null },
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

const RODEO_ANTERIOR = {
    id: 'rodeo-1', club: 'ANCUD', asociacion: 'CHILOE', fecha: '2026-11-07',
    tipo_rodeo_id: 'tipo-1dia', tipo_rodeo_nombre: 'Provincial 1 día', duracion_dias: 1,
    categoria_rodeo_id: null, categoria_rodeo_nombre: null, temporada_id: null, observacion: null, estado: 'activo'
};

function mockRpcExito(rodeoResultante, sincronizacion = { actualizadas: 1, omitidas_historicas: 0, sin_cambio: 0 }) {
    supabase.rpc.mockResolvedValue({ data: { rodeo: rodeoResultante, sincronizacion }, error: null });
}

describe('PATCH /:id — Caso 1: 1 día -> 2 días (ANCUD) usa la RPC transaccional, no el REST en dos pasos', () => {
    test('llama a actualizar_tipo_rodeo_y_sincronizar_asignaciones con los parámetros correctos y devuelve el rodeo de la RPC', async () => {
        crearSupabaseMock({
            rodeos: { data: RODEO_ANTERIOR, error: null }, // solo la lectura de "anterior" — no hay segundo update
            tipos_rodeo: { data: { nombre: 'Provincial 3 series', duracion_dias: 2 }, error: null }
        });
        const rodeoResultante = { ...RODEO_ANTERIOR, tipo_rodeo_id: 'tipo-3series', tipo_rodeo_nombre: 'Provincial 3 series', duracion_dias: 2 };
        mockRpcExito(rodeoResultante);

        const { status, body } = await llamarRuta({
            method: 'PATCH', url: '/rodeo-1', params: { id: 'rodeo-1' },
            body: { tipo_rodeo_id: 'tipo-3series' },
            usuario: { id: 'admin-7', rol_evaluacion: null }
        });

        expect(status).toBe(200);
        expect(body).toEqual(rodeoResultante);
        expect(supabase.rpc).toHaveBeenCalledTimes(1);
        expect(supabase.rpc).toHaveBeenCalledWith('actualizar_tipo_rodeo_y_sincronizar_asignaciones', {
            p_rodeo_id: 'rodeo-1',
            p_tipo_rodeo_id: 'tipo-3series',
            p_tipo_rodeo_nombre: 'Provincial 3 series',
            p_nueva_duracion_dias: 2,
            p_actor_id: 'admin-7',
            p_actor_tipo: 'administrador',
            p_ip_address: '127.0.0.1'
        });
    });

    test('cuando SOLO cambia el tipo de rodeo, no hace un segundo UPDATE plano sobre rodeos ni una auditoría genérica redundante (ya auditado dentro de la RPC)', async () => {
        crearSupabaseMock({
            rodeos: { data: RODEO_ANTERIOR, error: null },
            tipos_rodeo: { data: { nombre: 'Provincial 3 series', duracion_dias: 2 }, error: null }
        });
        mockRpcExito({ ...RODEO_ANTERIOR, tipo_rodeo_id: 'tipo-3series', tipo_rodeo_nombre: 'Provincial 3 series', duracion_dias: 2 });

        await llamarRuta({ method: 'PATCH', url: '/rodeo-1', params: { id: 'rodeo-1' }, body: { tipo_rodeo_id: 'tipo-3series' } });

        // supabase.from('rodeos') solo se usó para leer "anterior" (select+single),
        // nunca se llamó a .update() sobre rodeos en este caso.
        expect(auditoria.registrar).not.toHaveBeenCalled();
    });

    test('si además cambian otros campos (club, fecha), SÍ aplica el UPDATE plano adicional y su auditoría, sin tocar de nuevo el tipo/duración', async () => {
        crearSupabaseMock({
            rodeos: [
                { data: RODEO_ANTERIOR, error: null },
                { data: { ...RODEO_ANTERIOR, tipo_rodeo_id: 'tipo-3series', tipo_rodeo_nombre: 'Provincial 3 series', duracion_dias: 2, fecha: '2026-11-14' }, error: null }
            ],
            tipos_rodeo: { data: { nombre: 'Provincial 3 series', duracion_dias: 2 }, error: null }
        });
        mockRpcExito({ ...RODEO_ANTERIOR, tipo_rodeo_id: 'tipo-3series', tipo_rodeo_nombre: 'Provincial 3 series', duracion_dias: 2 });

        const { status, body } = await llamarRuta({
            method: 'PATCH', url: '/rodeo-1', params: { id: 'rodeo-1' },
            body: { tipo_rodeo_id: 'tipo-3series', fecha: '2026-11-14' }
        });

        expect(status).toBe(200);
        expect(body.fecha).toBe('2026-11-14');
        expect(supabase.rpc).toHaveBeenCalledTimes(1);
        expect(auditoria.registrar).toHaveBeenCalledTimes(1);
        expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({
            tabla: 'rodeos',
            datos_nuevos: expect.not.objectContaining({ tipo_rodeo_id: expect.anything() })
        }));
    });
});

describe('PATCH /:id — Caso 2: de dos días a un día', () => {
    test('llama a la RPC con la nueva duración (1), no conserva la anterior', async () => {
        const anteriorDosDias = { ...RODEO_ANTERIOR, tipo_rodeo_id: 'tipo-3series', tipo_rodeo_nombre: 'Provincial 3 series', duracion_dias: 2 };
        crearSupabaseMock({
            rodeos: { data: anteriorDosDias, error: null },
            tipos_rodeo: { data: { nombre: 'Provincial 1 día', duracion_dias: 1 }, error: null }
        });
        mockRpcExito({ ...anteriorDosDias, tipo_rodeo_id: 'tipo-1dia', tipo_rodeo_nombre: 'Provincial 1 día', duracion_dias: 1 });

        await llamarRuta({ method: 'PATCH', url: '/rodeo-1', params: { id: 'rodeo-1' }, body: { tipo_rodeo_id: 'tipo-1dia' } });

        expect(supabase.rpc).toHaveBeenCalledWith('actualizar_tipo_rodeo_y_sincronizar_asignaciones', expect.objectContaining({ p_nueva_duracion_dias: 1 }));
    });
});

describe('PATCH /:id — Caso 3: cambio de fecha sin tocar el tipo de rodeo', () => {
    test('solo cambia la fecha -> NUNCA llama a la RPC, sigue el camino REST normal', async () => {
        crearSupabaseMock({
            rodeos: [
                { data: RODEO_ANTERIOR, error: null },
                { data: { ...RODEO_ANTERIOR, fecha: '2026-11-14' }, error: null }
            ]
        });

        const { status, body } = await llamarRuta({ method: 'PATCH', url: '/rodeo-1', params: { id: 'rodeo-1' }, body: { fecha: '2026-11-14' } });

        expect(status).toBe(200);
        expect(body.fecha).toBe('2026-11-14');
        expect(supabase.rpc).not.toHaveBeenCalled();
        expect(auditoria.registrar).toHaveBeenCalledTimes(1);
    });
});

describe('PATCH /:id — Caso 4: cambio de tipo de rodeo que mantiene la misma duración', () => {
    test('tipo_rodeo_id cambia pero la duración del tipo nuevo es igual a la anterior -> SÍ llama a la RPC igual (el tipo sí cambió; la RPC es idempotente del lado de asignaciones)', async () => {
        crearSupabaseMock({
            rodeos: { data: RODEO_ANTERIOR, error: null }, // duracion_dias: 1
            tipos_rodeo: { data: { nombre: 'Provincial 1 día (otro catálogo)', duracion_dias: 1 }, error: null }
        });
        mockRpcExito({ ...RODEO_ANTERIOR, tipo_rodeo_id: 'tipo-1dia-b', tipo_rodeo_nombre: 'Provincial 1 día (otro catálogo)', duracion_dias: 1 });

        await llamarRuta({ method: 'PATCH', url: '/rodeo-1', params: { id: 'rodeo-1' }, body: { tipo_rodeo_id: 'tipo-1dia-b' } });

        expect(supabase.rpc).toHaveBeenCalledWith('actualizar_tipo_rodeo_y_sincronizar_asignaciones', expect.objectContaining({ p_nueva_duracion_dias: 1 }));
    });
});

describe('PATCH /:id — regresión: no modificar otros campos ni comportamiento existente', () => {
    test('observación, club, estado -> sin tipo_rodeo_id, nunca llama a la RPC', async () => {
        crearSupabaseMock({
            rodeos: [
                { data: RODEO_ANTERIOR, error: null },
                { data: { ...RODEO_ANTERIOR, observacion: 'nueva obs' }, error: null }
            ]
        });

        const { status } = await llamarRuta({ method: 'PATCH', url: '/rodeo-1', params: { id: 'rodeo-1' }, body: { observacion: 'nueva obs' } });

        expect(status).toBe(200);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('tipo_rodeo_id inexistente -> 400, nunca llega a llamar a la RPC', async () => {
        crearSupabaseMock({
            rodeos: { data: RODEO_ANTERIOR, error: null },
            tipos_rodeo: { data: null, error: null }
        });

        const { status } = await llamarRuta({ method: 'PATCH', url: '/rodeo-1', params: { id: 'rodeo-1' }, body: { tipo_rodeo_id: 'no-existe' } });

        expect(status).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('rodeo no encontrado -> 404, nunca llega a llamar a la RPC', async () => {
        crearSupabaseMock({ rodeos: { data: null, error: null } });
        const { status } = await llamarRuta({ method: 'PATCH', url: '/no-existe', params: { id: 'no-existe' }, body: { tipo_rodeo_id: 'x' } });
        expect(status).toBe(404);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });
});

describe('PATCH /:id — manejo de errores de la RPC (nunca se oculta un fallo de sincronización)', () => {
    test('la RPC falla con un error genérico -> 500 con el mensaje, nunca se intenta el UPDATE plano por separado', async () => {
        crearSupabaseMock({
            rodeos: { data: RODEO_ANTERIOR, error: null },
            tipos_rodeo: { data: { nombre: 'Provincial 3 series', duracion_dias: 2 }, error: null }
        });
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'constraint violada en auditoria' } });

        const { status, body } = await llamarRuta({ method: 'PATCH', url: '/rodeo-1', params: { id: 'rodeo-1' }, body: { tipo_rodeo_id: 'tipo-3series' } });

        expect(status).toBe(500);
        expect(body.error).toMatch(/constraint violada en auditoria/);
        expect(auditoria.registrar).not.toHaveBeenCalled();
    });

    test('la RPC falla con RODEO_NO_ENCONTRADO (carrera: alguien lo eliminó entre la lectura y la RPC) -> 404', async () => {
        crearSupabaseMock({
            rodeos: { data: RODEO_ANTERIOR, error: null },
            tipos_rodeo: { data: { nombre: 'Provincial 3 series', duracion_dias: 2 }, error: null }
        });
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'RODEO_NO_ENCONTRADO' } });

        const { status } = await llamarRuta({ method: 'PATCH', url: '/rodeo-1', params: { id: 'rodeo-1' }, body: { tipo_rodeo_id: 'tipo-3series' } });

        expect(status).toBe(404);
    });
});

describe('POST /:id/reparar-sincronizacion-asignaciones — herramienta de reparación (Caso 2B: sin cambiar el tipo)', () => {
    test('llama a reparar_sincronizacion_asignaciones_rodeo con el rodeo y el actor, devuelve el resultado tal cual', async () => {
        const resultadoRpc = { rodeo_id: 'rodeo-ancud', duracion_dias_vigente: 2, sincronizacion: { actualizadas: 1, omitidas_historicas: 0, sin_cambio: 0 } };
        supabase.rpc.mockResolvedValue({ data: resultadoRpc, error: null });

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/rodeo-ancud/reparar-sincronizacion-asignaciones', params: { id: 'rodeo-ancud' },
            usuario: { id: 'admin-9', rol_evaluacion: null }
        });

        expect(status).toBe(200);
        expect(body).toEqual(resultadoRpc);
        expect(supabase.rpc).toHaveBeenCalledWith('reparar_sincronizacion_asignaciones_rodeo', {
            p_rodeo_id: 'rodeo-ancud', p_actor_id: 'admin-9', p_actor_tipo: 'administrador', p_ip_address: '127.0.0.1'
        });
        // Nunca toca `rodeos` directamente por REST — todo pasa por la RPC.
        expect(supabase.from).not.toHaveBeenCalled();
    });

    test('rodeo no encontrado -> 404', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'RODEO_NO_ENCONTRADO' } });
        const { status } = await llamarRuta({ method: 'POST', url: '/no-existe/reparar-sincronizacion-asignaciones', params: { id: 'no-existe' } });
        expect(status).toBe(404);
    });

    test('error genérico de la RPC -> 500 con el mensaje', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'timeout de base de datos' } });
        const { status, body } = await llamarRuta({ method: 'POST', url: '/rodeo-1/reparar-sincronizacion-asignaciones', params: { id: 'rodeo-1' } });
        expect(status).toBe(500);
        expect(body.error).toMatch(/timeout de base de datos/);
    });
});
