// Fase 3.5 — POST /api/admin/rodeos/:id/reemplazar-delegado-institucional.
// Único camino autorizado para reemplazar al Delegado de Asociación
// responsable YA CONFIRMADO de un rodeo (institucional/rodeos.js bloquea
// cualquier cambio directo desde el portal). Se prueba: motivo requerido,
// validación del delegado contra la asociación REAL del rodeo (nunca
// confiando en el frontend), y el mapeo de los códigos de error que
// devuelve la RPC (migración 069) a respuestas HTTP claras.
//
// Cambio de Delegado de Asociación (corrección desde el Informe del
// Delegado): solo Administrador pleno, solo cartillas en Borrador,
// protección de concurrencia (responsable y versión vistos), mismo delegado
// rechazado, auditoría complementaria con nombres, y GET de opciones
// elegibles (misma asociación real, activo, certificado).
jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
jest.mock('../../services/auditoria', () => ({ registrar: jest.fn().mockResolvedValue(undefined) }));

const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');
const router = require('./rodeos');

// nombre_normalizado refleja el mismo criterio de normalizarAsociacion()
// (services/asociaciones.js): sin tildes, minúsculas, y SIN el prefijo
// "asociacion ".
const ASOC_VALPO = { id: 'asoc-valpo', nombre: 'Asociación Valparaíso', nombre_normalizado: 'valparaiso', activa: true };
const ASOC_OTRA = { id: 'asoc-otra', nombre: 'Asociación Quillota', nombre_normalizado: 'quillota', activa: true };
const RODEO = { id: 'rodeo-1', club: 'VALPARAÍSO', asociacion: 'VALPARAÍSO', fecha: '2026-11-14' };
const DEL_PABLO = { id: 'del-pablo', nombre: 'Pablo Bijit', asociacion_id: 'asoc-valpo', activo: true, certificado: true };
const DEL_NUEVO = { id: 'del-nuevo', nombre: 'Pedro Soto', asociacion_id: 'asoc-valpo', activo: true, certificado: true };
const DESIGNACION = { id: 'desig-1', rodeo_id: 'rodeo-1', delegado_asociacion_id: 'del-pablo' };
const CARTILLA = { id: 'cart-1', estado: 'borrador', version: 7, delegado_asociacion_id: 'del-pablo', delegado_nombre: 'Pablo Bijit' };

let estado, llamadas;
function crearChain(tabla) {
    const filtros = [];
    const chain = {};
    ['select', 'in', 'order', 'neq'].forEach(m => { chain[m] = (...a) => { llamadas.push({ tabla, m, a }); return chain; }; });
    chain.eq = (col, val) => { filtros.push([col, val]); llamadas.push({ tabla, m: 'eq', a: [col, val] }); return chain; };
    chain.not = (...a) => { llamadas.push({ tabla, m: 'not', a }); return chain; };
    const resolver = () => {
        if (tabla === 'rodeos') return { data: estado.rodeo, error: null };
        if (tabla === 'rodeos_delegado_institucional') return { data: estado.designacion, error: null };
        if (tabla === 'cartillas_delegado') return { data: estado.cartilla, error: null };
        if (tabla === 'delegados_asociacion') {
            const porId = filtros.find(f => f[0] === 'id');
            if (porId) return { data: estado.delegados.find(d => d.id === porId[1]) || null, error: null };
            const porAsoc = filtros.find(f => f[0] === 'asociacion_id');
            return { data: estado.delegados.filter(d => d.asociacion_id === porAsoc[1]), error: null };
        }
        if (tabla === 'asociaciones') return { data: [ASOC_VALPO, ASOC_OTRA], error: null };
        if (tabla === 'asociacion_alias') return { data: [], error: null };
        return { data: null, error: null };
    };
    chain.maybeSingle = () => Promise.resolve(resolver());
    chain.single = () => Promise.resolve(resolver());
    chain.then = (ok, ko) => Promise.resolve(resolver()).then(ok, ko);
    return chain;
}

beforeEach(() => {
    llamadas = [];
    estado = {
        rodeo: RODEO,
        designacion: DESIGNACION,
        cartilla: { ...CARTILLA },
        delegados: [
            DEL_PABLO, DEL_NUEVO,
            { id: 'del-susp', nombre: 'Suspendido Uno', asociacion_id: 'asoc-valpo', activo: false, certificado: true },
            { id: 'del-nocert', nombre: 'Sin Certificar', asociacion_id: 'asoc-valpo', activo: true, certificado: false },
            { id: 'del-otra', nombre: 'Otra Asociación', asociacion_id: 'asoc-otra', activo: true, certificado: true }
        ]
    };
    supabase.from.mockReset();
    supabase.from.mockImplementation(tabla => crearChain(tabla));
    supabase.rpc.mockReset();
    supabase.rpc.mockImplementation(() => Promise.resolve({
        data: { id: 'desig-1', rodeo_id: RODEO.id, delegado_asociacion_id: DEL_NUEVO.id },
        error: null
    }));
    auditoria.registrar.mockClear();
});

function crearResFake() {
    const res = {};
    res.statusCode = 200;
    res.status = jest.fn((c) => { res.statusCode = c; return res; });
    res.jsonBody = null;
    res.json = jest.fn((p) => { res.jsonBody = p; return res; });
    return res;
}
function invocar(method, ruta, body, usuario = { id: 'admin-1', rol_evaluacion: null }) {
    return new Promise((resolve, reject) => {
        const req = { method, url: ruta, originalUrl: ruta, body: body || {}, params: {}, query: {}, usuario, ip: '127.0.0.1' };
        const res = crearResFake();
        const jsonOriginal = res.json;
        res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}
const BASE = { nuevo_delegado_asociacion_id: 'del-nuevo', motivo: 'La asociación seleccionó por error al delegado equivocado', delegado_actual_id: 'del-pablo', cartilla_version: 7 };
const llamar = (body, usuario) => invocar('POST', '/rodeo-1/reemplazar-delegado-institucional', body, usuario);

describe('POST /admin/rodeos/:id/reemplazar-delegado-institucional (RPC 102)', () => {
    const rpcOk = () => supabase.rpc.mockImplementation(() => Promise.resolve({
        data: {
            designacion_id: 'desig-1', rodeo_id: 'rodeo-1', cartilla_id: 'cart-1', cartilla_version: 8,
            delegado_anterior: { id: 'del-pablo', nombre: 'Pablo Bijit' }, delegado_nuevo: { id: 'del-nuevo', nombre: 'Pedro Soto' }
        },
        error: null
    }));
    const rpcError = (message, code) => supabase.rpc.mockImplementation(() => Promise.resolve({ data: null, error: { message, code } }));
    beforeEach(rpcOk);

    test('cambio válido -> 200; llama UNA vez a la RPC 102 con la asociación REAL, el responsable y la versión vistos', async () => {
        const res = await llamar(BASE, { id: 'admin-7', rol_evaluacion: null });
        expect(res.statusCode).toBe(200);
        expect(supabase.rpc).toHaveBeenCalledTimes(1);
        expect(supabase.rpc).toHaveBeenCalledWith('cambiar_delegado_asociacion_borrador', {
            p_rodeo_id: 'rodeo-1', p_asociacion_id: 'asoc-valpo', p_delegado_actual_id: 'del-pablo',
            p_nuevo_delegado_asociacion_id: 'del-nuevo', p_cartilla_version: 7, p_administrador_id: 'admin-7',
            p_motivo: BASE.motivo
        });
        expect(res.jsonBody).toMatchObject({
            designacion: { id: 'desig-1', rodeo_id: 'rodeo-1', delegado_asociacion_id: 'del-nuevo' },
            cartilla: { id: 'cart-1', version: 8 },
            delegado_anterior: { id: 'del-pablo', nombre: 'Pablo Bijit' },
            delegado_nuevo: { id: 'del-nuevo', nombre: 'Pedro Soto' }
        });
    });

    test('nunca usa la RPC 069 ni escribe una auditoría aparte (la única auditoría la escribe la RPC 102 en su transacción)', async () => {
        await llamar(BASE);
        expect(supabase.rpc).not.toHaveBeenCalledWith('reemplazar_delegado_institucional_rodeo', expect.anything());
        expect(auditoria.registrar).not.toHaveBeenCalled();
    });

    test('rodeo sin cartilla: cartilla_version ausente viaja como null', async () => {
        await llamar({ ...BASE, cartilla_version: undefined });
        expect(supabase.rpc.mock.calls[0][1].p_cartilla_version).toBeNull();
    });

    test('motivo vacío/espacios -> 422; > 1000 -> 422; sin RPC', async () => {
        for (const motivo of ['', '   ', undefined, 'x'.repeat(1001)]) {
            expect((await llamar({ ...BASE, motivo })).statusCode).toBe(422);
        }
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('faltan nuevo_delegado_asociacion_id / delegado_actual_id, o versión no numérica -> 400, sin RPC', async () => {
        expect((await llamar({ ...BASE, nuevo_delegado_asociacion_id: undefined })).statusCode).toBe(400);
        expect((await llamar({ ...BASE, delegado_actual_id: undefined })).statusCode).toBe(400);
        expect((await llamar({ ...BASE, cartilla_version: 'abc' })).statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('rodeo inexistente -> 404, sin RPC', async () => {
        estado.rodeo = null;
        expect((await llamar(BASE)).statusCode).toBe(404);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('asociación del rodeo no resoluble en el catálogo -> 409, sin RPC', async () => {
        estado.rodeo = { ...RODEO, asociacion: 'ASOCIACIÓN INEXISTENTE' };
        const res = await llamar(BASE);
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('ASOCIACION_NO_RESUELTA');
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test.each([
        ['DELEGADO_NO_VALIDO', 403], ['MISMO_DELEGADO', 422], ['MOTIVO_REQUERIDO', 422], ['MOTIVO_DEMASIADO_LARGO', 422],
        ['SIN_DESIGNACION_PREVIA', 409], ['RESPONSABLE_CAMBIO_CONCURRENTE', 409], ['VERSION_DESACTUALIZADA', 409],
        ['RODEO_NO_ENCONTRADO', 404], ['ASOCIACION_NO_RESUELTA', 409], ['ASOCIACION_AMBIGUA', 409], ['ASOCIACION_NO_COINCIDE', 409]
    ])('RPC %s -> %i con el mismo code', async (codigo, status) => {
        rpcError(codigo);
        const res = await llamar(BASE);
        expect(res.statusCode).toBe(status);
        expect(res.jsonBody.code).toBe(codigo);
    });

    test.each(['enviada', 'reenviada', 'observada', 'reabierta', 'aprobada', 'cerrada'])(
        'RPC CARTILLA_NO_BORRADOR: %s -> 409 con el estado real', async (est) => {
            rpcError(`CARTILLA_NO_BORRADOR: ${est}`);
            const res = await llamar(BASE);
            expect(res.statusCode).toBe(409);
            expect(res.jsonBody.code).toBe('CARTILLA_NO_BORRADOR');
            expect(res.jsonBody.estado).toBe(est);
            expect(res.jsonBody.error).toContain(est);
        });

    test('migración 102 sin aplicar (PGRST202) -> 503 MIGRACION_102_PENDIENTE, nunca 500 ni éxito', async () => {
        rpcError('Could not find the function public.cambiar_delegado_asociacion_borrador in the schema cache', 'PGRST202');
        const res = await llamar(BASE);
        expect(res.statusCode).toBe(503);
        expect(res.jsonBody.code).toBe('MIGRACION_102_PENDIENTE');
    });

    test('error desconocido -> 500', async () => {
        rpcError('ERROR_RARO');
        expect((await llamar(BASE)).statusCode).toBe(500);
    });

    test.each(['monitor', 'director', 'analista', 'comision_tecnica', 'jefe_area', 'capacitador'])(
        'rol "%s" -> 403 (solo Administrador pleno), sin tocar datos ni la RPC', async (rol) => {
            const res = await llamar(BASE, { id: 'u1', rol_evaluacion: rol });
            expect(res.statusCode).toBe(403);
            expect(supabase.rpc).not.toHaveBeenCalled();
            expect(supabase.from).not.toHaveBeenCalled();
        });
});

describe('GET /admin/rodeos/:id/delegado-institucional/opciones', () => {
    const get = (usuario) => invocar('GET', '/rodeo-1/delegado-institucional/opciones', null, usuario);

    test('devuelve solo delegados de la asociación REAL, activos, certificados y distintos del vigente', async () => {
        const res = await get();
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.delegados).toEqual([{ id: 'del-nuevo', nombre: 'Pedro Soto' }]);
        expect(res.jsonBody.asociacion).toEqual({ id: 'asoc-valpo', nombre: 'Asociación Valparaíso' });
        expect(res.jsonBody.designacion).toMatchObject({ delegado_asociacion_id: 'del-pablo', delegado_nombre: 'Pablo Bijit' });
        expect(res.jsonBody.cartilla).toEqual({ id: 'cart-1', estado: 'borrador', version: 7, delegado_nombre: 'Pablo Bijit' });
        expect(res.jsonBody.puede_cambiar).toBe(true);
        expect(llamadas).toContainEqual({ tabla: 'delegados_asociacion', m: 'eq', a: ['asociacion_id', 'asoc-valpo'] });
    });

    test('cartilla no Borrador -> puede_cambiar=false con el motivo', async () => {
        estado.cartilla.estado = 'observada';
        const res = await get();
        expect(res.jsonBody.puede_cambiar).toBe(false);
        expect(res.jsonBody.bloqueo.code).toBe('CARTILLA_NO_BORRADOR');
    });

    test('sin designación -> puede_cambiar=false (SIN_DESIGNACION_PREVIA)', async () => {
        estado.designacion = null;
        const res = await get();
        expect(res.jsonBody.puede_cambiar).toBe(false);
        expect(res.jsonBody.bloqueo.code).toBe('SIN_DESIGNACION_PREVIA');
    });

    test('rol Director -> 403 (solo Administrador pleno)', async () => {
        const res = await get({ id: 'u1', rol_evaluacion: 'director' });
        expect(res.statusCode).toBe(403);
    });
});
