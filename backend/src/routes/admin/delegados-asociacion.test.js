// Módulo administrativo de Delegados de Asociación — permisos (solo admin
// pleno), catálogo + conteos, nómina, alta sin duplicados, suspender/
// reactivar y eliminar. Verificación previa a publicación: Crear/Suspender/
// Reactivar/Eliminar ahora pasan por una RPC (migración 073) que hace la
// escritura + la auditoría en UNA transacción — estas pruebas verifican que
// la RUTA llama a la RPC correcta y traduce sus errores/éxitos bien; la
// prueba real de que la transacción es atómica (contra Postgres real, no un
// mock) vive en services/delegadosAsociacionEliminacionSegura.rpc.test.js.
jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));

const supabase = require('../../config/supabase');
const router = require('./delegados-asociacion');

let respuestas;
function crearChain(tabla) {
    const chain = {};
    ['select', 'eq', 'ilike', 'order'].forEach(m => { chain[m] = () => chain; });
    chain.single = () => Promise.resolve(respuestas[tabla]?.single ?? { data: null, error: null });
    chain.maybeSingle = () => Promise.resolve(respuestas[tabla]?.maybeSingle ?? { data: null, error: null });
    chain.then = (resolve, reject) => Promise.resolve(respuestas[tabla]?.list ?? { data: [], error: null }).then(resolve, reject);
    return chain;
}

const ASOC_OSORNO = { id: 'asoc-osorno', nombre: 'OSORNO', activa: true, es_especial: false };
const ASOC_FEDERACION = { id: 'asoc-fed', nombre: 'FEDERACION DEL RODEO CHILENO', activa: true, es_especial: true };

beforeEach(() => {
    respuestas = {
        asociaciones: { list: { data: [ASOC_OSORNO], error: null }, maybeSingle: { data: ASOC_OSORNO, error: null } },
        delegados_asociacion: { list: { data: [], error: null }, maybeSingle: { data: null, error: null } },
        cartillas_delegado: { list: { data: [], error: null } },
        rodeos_delegado_institucional: { list: { data: [], error: null } }
    };
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
function llamar(router_, { metodo = 'GET', url = '/', body = {}, usuario = { id: 'admin-1', rol_evaluacion: null } } = {}) {
    return new Promise((resolve, reject) => {
        const req = { method: metodo, url, originalUrl: url, body: body || {}, params: {}, query: {}, usuario, ip: '127.0.0.1' };
        const res = crearResFake();
        const jsonOriginal = res.json;
        res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
        router_(req, res, (err) => err ? reject(err) : resolve(res));
    });
}

describe('Permisos — solo administrador pleno en TODO el router (incluido GET)', () => {
    test.each(['director', 'analista', 'comision_tecnica', 'monitor', 'jefe_area', 'capacitador'])(
        'rol_evaluacion=%s -> 403 incluso para listar (GET /)',
        async (rol) => {
            const res = await llamar(router, { usuario: { id: 'x', rol_evaluacion: rol } });
            expect(res.statusCode).toBe(403);
        }
    );

    test('rol_evaluacion=analista -> 403 para crear (POST /)', async () => {
        const res = await llamar(router, { metodo: 'POST', body: { nombre: 'X', asociacion_id: 'asoc-osorno' }, usuario: { id: 'x', rol_evaluacion: 'analista' } });
        expect(res.statusCode).toBe(403);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('admin pleno (rol_evaluacion=null) -> permitido', async () => {
        const res = await llamar(router);
        expect(res.statusCode).toBe(200);
    });
});

describe('Integración con admin/index.js — una cuenta institucional nunca llega a este router', () => {
    test('tipo=cuenta_institucional -> 403 por soloAdmin, antes de evaluar rol_evaluacion', async () => {
        const adminRouter = require('./index');
        const req = { method: 'GET', url: '/delegados-asociacion', originalUrl: '/delegados-asociacion', headers: {}, body: {}, params: {}, query: {} };
        const res = crearResFake();
        const jwt = require('jsonwebtoken');
        const token = jwt.sign({ id: 'cuenta-1', tipo: 'cuenta_institucional' }, process.env.JWT_SECRET || 'fallback_secret_change_in_prod');
        req.headers.authorization = 'Bearer ' + token;
        await new Promise((resolve) => {
            const jsonOriginal = res.json;
            res.json = (p) => { jsonOriginal(p); resolve(); return res; };
            adminRouter(req, res, () => resolve());
        });
        expect(res.statusCode).toBe(403);
    });
});

describe('GET / — catálogo oficial de asociaciones ordinarias + conteos', () => {
    test('excluye asociaciones especiales (Federación) por construcción del query (eq es_especial=false)', async () => {
        const res = await llamar(router);
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.asociaciones).toHaveLength(1);
        expect(res.jsonBody.asociaciones[0].nombre).toBe('OSORNO');
    });

    test('cuenta delegados activos y suspendidos por asociación', async () => {
        respuestas.delegados_asociacion.list = {
            data: [
                { asociacion_id: 'asoc-osorno', activo: true },
                { asociacion_id: 'asoc-osorno', activo: true },
                { asociacion_id: 'asoc-osorno', activo: false }
            ], error: null
        };
        const res = await llamar(router);
        expect(res.jsonBody.asociaciones[0]).toMatchObject({ delegados_activos: 2, delegados_suspendidos: 1, delegados_total: 3 });
    });

    test('asociación sin delegados aparece igual, con 0/0/0', async () => {
        const res = await llamar(router);
        expect(res.jsonBody.asociaciones[0]).toMatchObject({ delegados_activos: 0, delegados_suspendidos: 0, delegados_total: 0 });
    });
});

describe('GET /:asociacionId — nómina completa (activos Y suspendidos)', () => {
    test('asociación inexistente -> 404', async () => {
        respuestas.asociaciones.maybeSingle = { data: null, error: null };
        const res = await llamar(router, { url: '/no-existe' });
        expect(res.statusCode).toBe(404);
    });

    test('incluye delegados suspendidos en la respuesta (nunca ocultos al admin)', async () => {
        respuestas.delegados_asociacion.list = {
            data: [{ id: 'd1', nombre: 'Ana', activo: true, certificado: true, created_at: 't1' },
                   { id: 'd2', nombre: 'Bruno', activo: false, certificado: false, created_at: 't2' }], error: null
        };
        const res = await llamar(router, { url: '/asoc-osorno' });
        expect(res.jsonBody.delegados).toHaveLength(2);
        expect(res.jsonBody.delegados.find(d => d.nombre === 'Bruno').estado).toBe('suspendido');
    });
});

describe('POST / — alta de delegado (vía crear_delegado_asociacion_con_auditoria)', () => {
    function crear(body) { return llamar(router, { metodo: 'POST', body }); }

    test('nombre vacío -> 400, nunca llama a la RPC', async () => {
        const res = await crear({ nombre: '   ', asociacion_id: 'asoc-osorno' });
        expect(res.statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('sin asociacion_id -> 400', async () => {
        const res = await crear({ nombre: 'Ana Soto' });
        expect(res.statusCode).toBe(400);
    });

    test('asociación especial (Federación) -> 400, nunca llama a la RPC', async () => {
        respuestas.asociaciones.maybeSingle = { data: ASOC_FEDERACION, error: null };
        const res = await crear({ nombre: 'Ana Soto', asociacion_id: 'asoc-fed' });
        expect(res.statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('nombre duplicado detectado en el pre-chequeo -> 409, nunca llega a llamar la RPC', async () => {
        respuestas.delegados_asociacion.maybeSingle = { data: { id: 'existente' }, error: null };
        const res = await crear({ nombre: 'Ana Soto', asociacion_id: 'asoc-osorno' });
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('DUPLICADO');
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('carrera concurrente: la RPC devuelve 23505 (UNIQUE) -> también se traduce a 409', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate key' } });
        const res = await crear({ nombre: 'Ana Soto', asociacion_id: 'asoc-osorno' });
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('DUPLICADO');
    });

    test('creación exitosa -> 201, llama a crear_delegado_asociacion_con_auditoria con los parámetros correctos', async () => {
        supabase.rpc.mockResolvedValue({ data: { id: 'nuevo-1', nombre: 'Ana Soto', activo: true, certificado: false, created_at: 't' }, error: null });
        const res = await crear({ nombre: 'Ana Soto', asociacion_id: 'asoc-osorno' });
        expect(res.statusCode).toBe(201);
        expect(res.jsonBody.delegado.certificado).toBe(false);
        expect(supabase.rpc).toHaveBeenCalledWith('crear_delegado_asociacion_con_auditoria', expect.objectContaining({
            p_nombre: 'Ana Soto', p_asociacion_id: 'asoc-osorno', p_certificado: false, p_administrador_id: 'admin-1'
        }));
    });

    test('certificado=true solo cuando se confirma explícitamente', async () => {
        supabase.rpc.mockResolvedValue({ data: { id: 'nuevo-1', nombre: 'Ana Soto', activo: true, certificado: true, created_at: 't' }, error: null });
        const res = await crear({ nombre: 'Ana Soto', asociacion_id: 'asoc-osorno', certificado: true });
        expect(res.jsonBody.delegado.certificado).toBe(true);
    });

    test('fallo de auditoría (u otro fallo real dentro de la transacción) -> la ruta NUNCA reporta éxito ni 201', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'FALLO_SIMULADO_AUDITORIA' } });
        const res = await crear({ nombre: 'Ana Soto', asociacion_id: 'asoc-osorno' });
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.jsonBody.ok).not.toBe(true);
    });

    test('nunca toca cuentas_institucionales', async () => {
        supabase.rpc.mockResolvedValue({ data: { id: 'nuevo-1', nombre: 'Ana Soto', activo: true, certificado: false, created_at: 't' }, error: null });
        await crear({ nombre: 'Ana Soto', asociacion_id: 'asoc-osorno' });
        expect(supabase.from).not.toHaveBeenCalledWith('cuentas_institucionales');
        expect(supabase.rpc).not.toHaveBeenCalledWith(expect.stringContaining('institucional'), expect.anything());
    });
});

describe('PATCH /:id/suspender (vía suspender_delegado_asociacion_con_auditoria)', () => {
    function suspender(id = 'del-1') { return llamar(router, { metodo: 'PATCH', url: '/' + id + '/suspender' }); }

    test('delegado inexistente -> 404 (mapeado desde DELEGADO_NO_ENCONTRADO)', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'DELEGADO_NO_ENCONTRADO' } });
        const res = await suspender();
        expect(res.statusCode).toBe(404);
    });

    test('ya suspendido -> 409 (mapeado desde DELEGADO_YA_SUSPENDIDO)', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'DELEGADO_YA_SUSPENDIDO' } });
        const res = await suspender();
        expect(res.statusCode).toBe(409);
    });

    test('con cartillas/selecciones vinculadas: SE SUSPENDE igual (la RPC no las bloquea), e informa advertencias', async () => {
        respuestas.cartillas_delegado.list = { data: [{ id: 'c1' }], error: null };
        respuestas.rodeos_delegado_institucional.list = { data: [{ id: 'r1' }, { id: 'r2' }], error: null };
        supabase.rpc.mockResolvedValue({ data: { id: 'del-1', nombre: 'Ana Soto' }, error: null });
        const res = await suspender();
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.advertencias).toEqual({ cartillas_vinculadas: 1, rodeos_con_seleccion: 2 });
        // La descripción pasada a la RPC refleja las advertencias, para quedar en auditoria.
        expect(supabase.rpc).toHaveBeenCalledWith('suspender_delegado_asociacion_con_auditoria', expect.objectContaining({
            p_delegado_id: 'del-1', p_administrador_id: 'admin-1'
        }));
    });

    test('suspensión exitosa sin antecedentes -> advertencias en cero', async () => {
        supabase.rpc.mockResolvedValue({ data: { id: 'del-1', nombre: 'Ana Soto' }, error: null });
        const res = await suspender();
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.advertencias).toEqual({ cartillas_vinculadas: 0, rodeos_con_seleccion: 0 });
    });

    test('fallo de auditoría dentro de la transacción -> la ruta NUNCA reporta éxito', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'FALLO_SIMULADO_AUDITORIA' } });
        const res = await suspender();
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.jsonBody.ok).not.toBe(true);
    });
});

describe('PATCH /:id/reactivar (vía reactivar_delegado_asociacion_con_auditoria)', () => {
    function reactivar(id = 'del-1') { return llamar(router, { metodo: 'PATCH', url: '/' + id + '/reactivar' }); }

    test('delegado inexistente -> 404', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'DELEGADO_NO_ENCONTRADO' } });
        const res = await reactivar();
        expect(res.statusCode).toBe(404);
    });

    test('ya activo -> 409', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'DELEGADO_YA_ACTIVO' } });
        const res = await reactivar();
        expect(res.statusCode).toBe(409);
    });

    test('reactivación exitosa -> 200, refleja el certificado real devuelto por la RPC (nunca certifica solo)', async () => {
        supabase.rpc.mockResolvedValue({ data: { id: 'del-1', nombre: 'Ana Soto', certificado: false }, error: null });
        const res = await reactivar();
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.delegado.certificado).toBe(false);
        expect(supabase.rpc).toHaveBeenCalledWith('reactivar_delegado_asociacion_con_auditoria', expect.objectContaining({
            p_delegado_id: 'del-1', p_administrador_id: 'admin-1'
        }));
    });

    test('fallo de auditoría dentro de la transacción -> la ruta NUNCA reporta éxito', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'FALLO_SIMULADO_AUDITORIA' } });
        const res = await reactivar();
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.jsonBody.ok).not.toBe(true);
    });
});

describe('DELETE /:id (vía eliminar_delegado_asociacion_con_auditoria) — Caso A vs Caso B', () => {
    function eliminar(body = { confirmar: true }, id = 'del-1') {
        return llamar(router, { metodo: 'DELETE', url: '/' + id, body });
    }

    test('sin confirmar=true -> 400, nunca llama a la RPC', async () => {
        const res = await eliminar({});
        expect(res.statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('delegado inexistente -> 404', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'DELEGADO_NO_ENCONTRADO' } });
        const res = await eliminar();
        expect(res.statusCode).toBe(404);
    });

    test('Caso B: la RPC bloquea por cartilla existente (DELEGADO_TIENE_HISTORIAL) -> 409 con el mensaje exacto pedido', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'DELEGADO_TIENE_HISTORIAL' } });
        const res = await eliminar();
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.error).toBe('Este delegado tiene antecedentes asociados a rodeos o cartillas. Para conservar el historial, puede suspenderlo, pero no eliminarlo definitivamente.');
        expect(res.jsonBody.code).toBe('TIENE_HISTORIAL');
    });

    test('Caso B: la RPC bloquea por responsable confirmado (mismo código DELEGADO_TIENE_HISTORIAL, aunque no haya cartilla) -> 409', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'DELEGADO_TIENE_HISTORIAL' } });
        const res = await eliminar();
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('TIENE_HISTORIAL');
    });

    test('violación cruda de FK (23503, por si algo bypasea la RPC) también se traduce al mismo mensaje, nunca un 500 genérico', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { code: '23503', message: 'foreign key violation' } });
        const res = await eliminar();
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('TIENE_HISTORIAL');
    });

    test('Caso A: sin referencias -> 200, eliminado=true', async () => {
        supabase.rpc.mockResolvedValue({ data: { id: 'del-1', nombre: 'Ana Soto' }, error: null });
        const res = await eliminar();
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody).toMatchObject({ ok: true, eliminado: true });
        expect(supabase.rpc).toHaveBeenCalledWith('eliminar_delegado_asociacion_con_auditoria', expect.objectContaining({
            p_delegado_id: 'del-1', p_administrador_id: 'admin-1'
        }));
    });

    test('fallo de auditoría dentro de la transacción -> la ruta NUNCA reporta éxito ni elimina', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'FALLO_SIMULADO_AUDITORIA' } });
        const res = await eliminar();
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.jsonBody.ok).not.toBe(true);
        expect(res.jsonBody.eliminado).not.toBe(true);
    });
});
