// Administración de Comisiones de Asociación (migración 079): evaluadores,
// evaluaciones y resolución de "requiere revisión administrativa".
jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));

const supabase = require('../../config/supabase');
const router = require('./comisiones-asociacion');

let respuestas;
function crearChain(tabla) {
    const chain = {};
    ['select', 'order', 'in'].forEach(m => { chain[m] = () => chain; });
    chain.eq = () => chain;
    chain.maybeSingle = () => Promise.resolve(respuestas[tabla]?.maybeSingle ?? { data: null, error: null });
    chain.then = (resolve, reject) => Promise.resolve(respuestas[tabla]?.list ?? respuestas[tabla] ?? { data: [], error: null }).then(resolve, reject);
    return chain;
}

beforeEach(() => {
    respuestas = {};
    supabase.from.mockReset();
    supabase.from.mockImplementation(tabla => crearChain(tabla));
    supabase.rpc.mockReset();
});

function crearResFake() {
    const res = {};
    res.statusCode = 200;
    res.status = jest.fn((c) => { res.statusCode = c; return res; });
    res.jsonBody = null;
    res.json = jest.fn((p) => { res.jsonBody = p; return res; });
    return res;
}
function llamar(method, ruta, body = {}, query = {}, usuario = { id: 'admin-1', rol_evaluacion: null }) {
    return new Promise((resolve, reject) => {
        const req = { method, url: ruta, originalUrl: ruta, body, params: {}, query, usuario, ip: '127.0.0.1' };
        const res = crearResFake();
        const jsonOriginal = res.json;
        res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}

describe('Permisos — solo administrador pleno en TODO el router', () => {
    test.each(['director', 'analista', 'monitor', 'comision_tecnica'])('rol_evaluacion=%s -> 403', async (rol) => {
        const res = await llamar('GET', '/evaluadores', {}, {}, { id: 'x', rol_evaluacion: rol });
        expect(res.statusCode).toBe(403);
    });
});

describe('GET /asociaciones', () => {
    test('aplana cuenta_comision=null cuando la asociación no tiene cuenta de Comisión', async () => {
        respuestas.asociaciones = { list: { data: [{ id: 'asoc-1', nombre: 'OSORNO', zona: 'Sur', activa: true, es_especial: false }], error: null } };
        respuestas.cuentas_institucionales = { list: { data: [], error: null } };
        const res = await llamar('GET', '/asociaciones');
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.asociaciones[0].cuenta_comision).toBeNull();
    });

    test('adjunta la cuenta de Comisión de la asociación correspondiente, nunca la de otra', async () => {
        respuestas.asociaciones = { list: { data: [
            { id: 'asoc-1', nombre: 'OSORNO', zona: 'Sur', activa: true, es_especial: false },
            { id: 'asoc-2', nombre: 'VALDIVIA', zona: 'Sur', activa: true, es_especial: false }
        ], error: null } };
        respuestas.cuentas_institucionales = { list: { data: [
            { id: 'cta-1', asociacion_id: 'asoc-1', email: 'comision-osorno@x.cl', activo: true, primer_login: false, ultimo_acceso_en: null }
        ], error: null } };
        const res = await llamar('GET', '/asociaciones');
        expect(res.jsonBody.asociaciones[0].cuenta_comision.email).toBe('comision-osorno@x.cl');
        expect(res.jsonBody.asociaciones[1].cuenta_comision).toBeNull();
    });
});

describe('GET /evaluadores', () => {
    test('devuelve la lista con el nombre de asociación aplanado', async () => {
        respuestas.evaluadores_comision = { list: { data: [{ id: 'ev-1', asociacion_id: 'asoc-1', nombre: 'Pedro', apellidos: 'Pérez', activo: true, asociaciones: { nombre: 'OSORNO' } }], error: null } };
        const res = await llamar('GET', '/evaluadores');
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.evaluadores[0].asociacion_nombre).toBe('OSORNO');
    });
});

describe('PATCH /evaluadores/:id/suspender', () => {
    test('éxito -> 200', async () => {
        supabase.rpc.mockResolvedValue({ data: { id: 'ev-1', activo: false }, error: null });
        const res = await llamar('PATCH', '/evaluadores/ev-1/suspender');
        expect(res.statusCode).toBe(200);
    });
    test('ya suspendido -> 409', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'EVALUADOR_YA_SUSPENDIDO' } });
        const res = await llamar('PATCH', '/evaluadores/ev-1/suspender');
        expect(res.statusCode).toBe(409);
    });
    test('no encontrado -> 404', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'EVALUADOR_NO_ENCONTRADO' } });
        const res = await llamar('PATCH', '/evaluadores/ev-x/suspender');
        expect(res.statusCode).toBe(404);
    });
});

describe('PATCH /evaluaciones/:id/corregir (Hallazgo 10)', () => {
    function datosValidos(extra = {}) {
        return { nota_apinadero: 6, nota_cancha: 5, nota_atajadas: 4, nota_cuarta_carrera: 3, hubo_movimiento_rienda: false, motivo: 'corrección por error de tipeo', ...extra };
    }

    test('sin motivo -> 400, nunca llama a la RPC', async () => {
        const res = await llamar('PATCH', '/evaluaciones/eval-1/corregir', datosValidos({ motivo: '' }));
        expect(res.statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('criterio fuera de rango -> 400, nunca llama a la RPC', async () => {
        const res = await llamar('PATCH', '/evaluaciones/eval-1/corregir', datosValidos({ nota_apinadero: 9 }));
        expect(res.statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('corrección válida -> 200', async () => {
        supabase.rpc.mockResolvedValue({ data: { id: 'eval-1', nota_individual_calculada: 7.0, estado: 'corregida_admin' }, error: null });
        const res = await llamar('PATCH', '/evaluaciones/eval-1/corregir', datosValidos());
        expect(res.statusCode).toBe(200);
        expect(supabase.rpc.mock.calls[0][0]).toBe('corregir_evaluacion_individual_comision_con_auditoria');
        expect(supabase.rpc.mock.calls[0][1].p_motivo).toBe('corrección por error de tipeo');
    });

    test('evaluación inexistente -> 404', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'EVALUACION_NO_ENCONTRADA' } });
        const res = await llamar('PATCH', '/evaluaciones/eval-x/corregir', datosValidos());
        expect(res.statusCode).toBe(404);
    });

    test.each(['director', 'monitor'])('rol_evaluacion=%s -> 403 (solo admin pleno, mismo allowlist del router)', async (rol) => {
        const res = await llamar('PATCH', '/evaluaciones/eval-1/corregir', datosValidos(), {}, { id: 'x', rol_evaluacion: rol });
        expect(res.statusCode).toBe(403);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    describe('Migración 080 — notas con un decimal', () => {
        test('acepta "6", "6,5" y "6.5" (coma o punto), normalizando a número con un decimal', async () => {
            supabase.rpc.mockResolvedValue({ data: { id: 'eval-1', nota_individual_calculada: 5.1, estado: 'corregida_admin' }, error: null });
            const res = await llamar('PATCH', '/evaluaciones/eval-1/corregir', datosValidos({
                nota_apinadero: '6', nota_cancha: '6,5', nota_atajadas: 6.5, nota_cuarta_carrera: '7,0'
            }));
            expect(res.statusCode).toBe(200);
            const args = supabase.rpc.mock.calls[0][1];
            expect(args.p_nota_apinadero).toBe(6);
            expect(args.p_nota_cancha).toBe(6.5);
            expect(args.p_nota_atajadas).toBe(6.5);
            expect(args.p_nota_cuarta_carrera).toBe(7);
        });

        test('acepta nota_rienda con coma cuando hubo_movimiento_rienda=true', async () => {
            supabase.rpc.mockResolvedValue({ data: { id: 'eval-1', nota_individual_calculada: 5.5, estado: 'corregida_admin' }, error: null });
            const res = await llamar('PATCH', '/evaluaciones/eval-1/corregir', datosValidos({ hubo_movimiento_rienda: true, nota_rienda: '6,5' }));
            expect(res.statusCode).toBe(200);
            expect(supabase.rpc.mock.calls[0][1].p_nota_rienda).toBe(6.5);
        });

        test.each([
            ['texto', 'seis'],
            ['más de un decimal', '6,55'],
            ['fuera de rango por arriba', '7,5'],
            ['vacío', '']
        ])('rechaza nota_apinadero inválida (%s: %j) -> 400, nunca llama a la RPC', async (_desc, valor) => {
            const res = await llamar('PATCH', '/evaluaciones/eval-1/corregir', datosValidos({ nota_apinadero: valor }));
            expect(res.statusCode).toBe(400);
            expect(supabase.rpc).not.toHaveBeenCalled();
        });

        test('rechaza nota_rienda con más de un decimal aunque las otras 4 notas sean válidas', async () => {
            const res = await llamar('PATCH', '/evaluaciones/eval-1/corregir', datosValidos({ hubo_movimiento_rienda: true, nota_rienda: '6,55' }));
            expect(res.statusCode).toBe(400);
            expect(supabase.rpc).not.toHaveBeenCalled();
        });

        test('hubo_movimiento_rienda=true sin nota_rienda -> 400 directo en Express, nunca llama a la RPC', async () => {
            const res = await llamar('PATCH', '/evaluaciones/eval-1/corregir', datosValidos({ hubo_movimiento_rienda: true, nota_rienda: null }));
            expect(res.statusCode).toBe(400);
            expect(supabase.rpc).not.toHaveBeenCalled();
        });
    });
});

describe('POST /rodeos/:rodeo_id/autorizar-evaluacion (ronda 3, punto 4)', () => {
    test('sin asignacion_id -> 400, nunca llama a la RPC', async () => {
        const res = await llamar('POST', '/rodeos/rodeo-1/autorizar-evaluacion', { motivo: 'motivo real' });
        expect(res.statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('sin motivo -> 400, nunca llama a la RPC', async () => {
        const res = await llamar('POST', '/rodeos/rodeo-1/autorizar-evaluacion', { asignacion_id: 'asig-1' });
        expect(res.statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('éxito -> 201 con el id de la autorización', async () => {
        supabase.rpc.mockResolvedValue({ data: 'aut-1', error: null });
        const res = await llamar('POST', '/rodeos/rodeo-1/autorizar-evaluacion', { asignacion_id: 'asig-1', motivo: 'Jurado B reemplazó a Jurado A' });
        expect(res.statusCode).toBe(201);
        expect(res.jsonBody.autorizacion_id).toBe('aut-1');
        expect(supabase.rpc.mock.calls[0][0]).toBe('autorizar_evaluacion_reemplazante_comision_con_auditoria');
    });

    test('Hallazgo 5 (identificadores manipulados): asignación que no pertenece a ese rodeo -> 404, nunca se otorga la autorización', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'ASIGNACION_NO_ENCONTRADA' } });
        const res = await llamar('POST', '/rodeos/rodeo-1/autorizar-evaluacion', { asignacion_id: 'asig-de-otro-rodeo', motivo: 'intento manipulado' });
        expect(res.statusCode).toBe(404);
    });

    test.each(['director', 'monitor'])('rol_evaluacion=%s -> 403 (solo admin pleno, ninguna Comisión puede llegar aquí)', async (rol) => {
        const res = await llamar('POST', '/rodeos/rodeo-1/autorizar-evaluacion', { asignacion_id: 'asig-1', motivo: 'motivo' }, {}, { id: 'x', rol_evaluacion: rol });
        expect(res.statusCode).toBe(403);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });
});

describe('GET /rodeos-requieren-revision', () => {
    test('aplana los datos del rodeo embebido', async () => {
        respuestas.rodeo_notas_secundarias = {
            list: {
                data: [{ rodeo_id: 'r1', nota_comision: 5.5, estado_nota_comision: 'completa', revision_admin_motivo: 'cambio', revision_admin_detectado_en: '2026-01-01', rodeos: { club: 'Club X', asociacion: 'OSORNO', fecha: '2026-01-01' } }],
                error: null
            }
        };
        const res = await llamar('GET', '/rodeos-requieren-revision');
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.rodeos[0]).toEqual({
            rodeo_id: 'r1', club: 'Club X', asociacion: 'OSORNO', fecha: '2026-01-01',
            nota_comision_actual: 5.5, estado_nota_comision: 'completa', motivo: 'cambio', detectado_en: '2026-01-01'
        });
    });
});

describe('POST /rodeos/:rodeo_id/resolver-revision', () => {
    test('decision inválida -> 400, nunca llama a la RPC', async () => {
        const res = await llamar('POST', '/rodeos/r1/resolver-revision', { decision: 'otra', motivo: 'x' });
        expect(res.statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('sin motivo -> 400, nunca llama a la RPC', async () => {
        const res = await llamar('POST', '/rodeos/r1/resolver-revision', { decision: 'mantener', motivo: '' });
        expect(res.statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('"mantener" válido -> 200', async () => {
        supabase.rpc.mockResolvedValue({ data: { rodeo_id: 'r1', requiere_revision_admin: false }, error: null });
        const res = await llamar('POST', '/rodeos/r1/resolver-revision', { decision: 'mantener', motivo: 'revisado' });
        expect(res.statusCode).toBe(200);
        expect(supabase.rpc.mock.calls[0][1].p_decision).toBe('mantener');
    });

    test('no requiere revisión -> 409', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'NO_REQUIERE_REVISION' } });
        const res = await llamar('POST', '/rodeos/r1/resolver-revision', { decision: 'mantener', motivo: 'x' });
        expect(res.statusCode).toBe(409);
    });

    test('"corregir" con nota fuera de rango -> 400', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'NOTA_FUERA_DE_RANGO' } });
        const res = await llamar('POST', '/rodeos/r1/resolver-revision', { decision: 'corregir', motivo: 'x', nota_comision_nueva: 9 });
        expect(res.statusCode).toBe(400);
    });
});
