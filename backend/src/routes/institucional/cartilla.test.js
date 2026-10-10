// POST/GET/PATCH /institucional/cartilla (Fase 3). La atomicidad real de
// "crear o adjuntar" y la concurrencia ya están probadas contra PGlite en
// services/cartillaInstitucional.rpc.test.js — aquí se prueba que la RUTA
// llama correctamente a la RPC, propaga sus errores como 409 con el código
// correcto, y que PATCH/enviar respetan versión/estado/asociación.
const jwt = require('jsonwebtoken');

jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
jest.mock('../../services/auditoria', () => ({ registrar: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/cartilla-delegado-pdf', () => ({ generarCartillaDelegadoPDF: jest.fn() }));

const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');
const { generarCartillaDelegadoPDF } = require('../../services/cartilla-delegado-pdf');
const router = require('./cartilla');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_in_prod';
const ASOC_OSORNO = 'asoc-osorno';
const ASOC_VALDIVIA = 'asoc-valdivia';

const RODEO_OSORNO = { id: 'rodeo-1', club: 'Club X', asociacion: 'OSORNO', fecha: '2026-09-18', estado: 'activo', tipo_rodeo_nombre: 'Provincial', temporadas: { nombre: '2026-2027' } };
const RODEO_ANULADO = { ...RODEO_OSORNO, id: 'rodeo-anulado', estado: 'anulado' };
const CATALOGO = [{ id: ASOC_OSORNO, nombre: 'OSORNO', nombre_normalizado: 'osorno', activa: true }, { id: ASOC_VALDIVIA, nombre: 'VALDIVIA', nombre_normalizado: 'valdivia', activa: true }];
const DELEGADO_OK = { id: 'del-1', nombre: 'Ana Soto', asociacion_id: ASOC_OSORNO, activo: true, certificado: true };
const DELEGADO_OTRA_ASOC = { id: 'del-2', nombre: 'Otro', asociacion_id: ASOC_VALDIVIA, activo: true, certificado: true };
const DELEGADO_INACTIVO = { id: 'del-3', nombre: 'Inactivo', asociacion_id: ASOC_OSORNO, activo: false, certificado: true };

let respuestas, rpcImpl;
function crearChain(tabla) {
    const chain = {};
    ['select', 'eq', 'in', 'neq', 'upsert'].forEach(m => { chain[m] = () => chain; });
    chain.maybeSingle = () => Promise.resolve(respuestas[tabla]?.maybeSingle ?? { data: null, error: null });
    chain.single = () => Promise.resolve(respuestas[tabla]?.single ?? { data: null, error: null });
    // Fase 3.5 — historial de responsables: .order() es la llamada FINAL de
    // esas consultas (sobre `auditoria`), se resuelve directo como .then().
    chain.order = () => Promise.resolve(respuestas[tabla]?.list ?? { data: [], error: null });
    chain.update = (payload) => {
        const upd = { payload, eq: () => upd, select: () => upd, maybeSingle: () => Promise.resolve(respuestas[tabla]?.updateResult ?? { data: null, error: null }) };
        return upd;
    };
    chain.then = (resolve, reject) => Promise.resolve(respuestas[tabla]?.list ?? { data: [], error: null }).then(resolve, reject);
    return chain;
}

beforeEach(() => {
    respuestas = {
        cuentas_institucionales: { single: { data: { activo: true, asociaciones: { activa: true } }, error: null } },
        rodeos: { maybeSingle: { data: RODEO_OSORNO, error: null } },
        asociaciones: { list: { data: CATALOGO, error: null } },
        asociacion_alias: { list: { data: [], error: null } },
        delegados_asociacion: { maybeSingle: { data: DELEGADO_OK, error: null } },
        cartillas_delegado: { list: { data: [], error: null }, maybeSingle: { data: null, error: null }, updateResult: { data: null, error: null } },
        asignaciones: { maybeSingle: { data: null, error: null } }, // sin designación vigente de Rentado por defecto
        // Fase 3.5: la fuente del responsable CONFIRMADO ya no es el body del
        // POST, sino esta tabla — por defecto ya hay un delegado confirmado
        // (del-1, el mismo DELEGADO_OK) para que los tests existentes de
        // "creación válida" sigan representando el camino normal.
        rodeos_delegado_institucional: { maybeSingle: { data: { delegado_asociacion_id: DELEGADO_OK.id }, error: null }, single: { data: {}, error: null } }
    };
    supabase.from.mockReset();
    supabase.from.mockImplementation(tabla => crearChain(tabla));
    // Fase 3.5.1: supabase.rpc ahora se usa para DOS funciones distintas en
    // este archivo — crear_o_adjuntar_cartilla_institucional (POST /rodeo/:id)
    // y actualizar_cartilla_institucional_con_auditoria (PATCH/enviar,
    // migración 070). Por defecto cada una responde con un resultado
    // razonable; los tests de PATCH/enviar siguen reutilizando
    // `respuestas.cartillas_delegado.updateResult` (ahora como el {data,error}
    // completo que devuelve la RPC) para no duplicar la configuración.
    rpcImpl = jest.fn((fn) => {
        if (fn === 'actualizar_cartilla_institucional_con_auditoria') {
            return Promise.resolve(respuestas.cartillas_delegado.updateResult ?? { data: null, error: null });
        }
        return Promise.resolve({ data: { id: 'cart-1', version: 1, delegado_asociacion_id: DELEGADO_OK.id, delegado_nombre: DELEGADO_OK.nombre }, error: null });
    });
    supabase.rpc.mockReset();
    supabase.rpc.mockImplementation((...args) => rpcImpl(...args));
    auditoria.registrar.mockClear();
});

function crearResFake() {
    const res = {};
    res.statusCode = 200;
    res.status = jest.fn((c) => { res.statusCode = c; return res; });
    res.jsonBody = null;
    res.json = jest.fn((p) => { res.jsonBody = p; return res; });
    // Fase 3.4 — PDF: respuesta binaria (res.setHeader + res.end), nunca res.json().
    res.cabeceras = {};
    res.setHeader = jest.fn((k, v) => { res.cabeceras[k] = v; return res; });
    res.endBody = null;
    res.end = jest.fn((buf) => { res.endBody = buf; return res; });
    return res;
}
function tokenInstitucional(asociacion_id = ASOC_OSORNO) {
    return jwt.sign({ id: 'inst-1', tipo: 'cuenta_institucional', rol_institucional: 'delegado_asociacion', asociacion_id }, JWT_SECRET, { expiresIn: '8h' });
}
function llamar(method, ruta, body = {}, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = { method, url: ruta, originalUrl: ruta, body, params: {}, headers, query: {}, ip: '127.0.0.1' };
        const res = crearResFake();
        const jsonOriginal = res.json;
        res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
        const endOriginal = res.end;
        res.end = (p) => { endOriginal(p); resolve(res); return res; };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}
const auth = (asoc) => ({ authorization: `Bearer ${tokenInstitucional(asoc)}` });

describe('GET /institucional/cartilla/rodeo/:rodeo_id', () => {
    test('rodeo de otra asociación -> 404 (nunca expone el rodeo)', async () => {
        const res = await llamar('GET', '/rodeo/rodeo-1', {}, auth(ASOC_VALDIVIA));
        expect(res.statusCode).toBe(404);
    });

    test('sin cartilla previa -> cartilla=null, conflicto_rentado=false', async () => {
        const res = await llamar('GET', '/rodeo/rodeo-1', {}, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.cartilla).toBeNull();
        expect(res.jsonBody.conflicto_rentado).toBe(false);
    });

    test('solo existe cartilla de Delegado Rentado (compatibilidad histórica) -> conflicto_rentado=true, cartilla=null', async () => {
        respuestas.cartillas_delegado.list = { data: [{ id: 'cart-rentado', rodeo_id: 'rodeo-1', delegado_id: 'usr-1', delegado_asociacion_id: null }], error: null };
        const res = await llamar('GET', '/rodeo/rodeo-1', {}, auth(ASOC_OSORNO));
        expect(res.jsonBody.conflicto_rentado).toBe(true);
        expect(res.jsonBody.cartilla).toBeNull();
    });

    test('existe cartilla institucional -> se devuelve, conflicto_rentado=false', async () => {
        respuestas.cartillas_delegado.list = { data: [{ id: 'cart-inst', rodeo_id: 'rodeo-1', delegado_id: null, delegado_asociacion_id: 'del-1', estado: 'borrador' }], error: null };
        const res = await llamar('GET', '/rodeo/rodeo-1', {}, auth(ASOC_OSORNO));
        expect(res.jsonBody.cartilla.id).toBe('cart-inst');
        expect(res.jsonBody.conflicto_rentado).toBe(false);
    });

    test('Fase 3.1 — designación vigente de Delegado Rentado (sin ninguna cartilla todavía) -> conflicto_rentado=true, delegado_rentado_designado=true (Caso A)', async () => {
        respuestas.asignaciones.maybeSingle = { data: { id: 'asig-1', estado_designacion: 'aceptado' }, error: null };
        const res = await llamar('GET', '/rodeo/rodeo-1', {}, auth(ASOC_OSORNO));
        expect(res.jsonBody.cartilla).toBeNull();
        expect(res.jsonBody.conflicto_rentado).toBe(true);
        expect(res.jsonBody.delegado_rentado_designado).toBe(true);
    });

    test('sin designación vigente y sin cartilla -> delegado_rentado_designado=false (Caso B, la asociación puede completar)', async () => {
        const res = await llamar('GET', '/rodeo/rodeo-1', {}, auth(ASOC_OSORNO));
        expect(res.jsonBody.delegado_rentado_designado).toBe(false);
        expect(res.jsonBody.conflicto_rentado).toBe(false);
    });

    test('Fase 3.1 (cierre) Caso D — cartilla institucional YA existe y DESPUÉS aparece designación vigente de Rentado -> se sigue devolviendo la cartilla (lectura permitida), marcada bloqueada_por_designacion_posterior=true, conflicto_rentado=false', async () => {
        respuestas.cartillas_delegado.list = { data: [{ id: 'cart-inst', rodeo_id: 'rodeo-1', delegado_id: null, delegado_asociacion_id: 'del-1', estado: 'borrador' }], error: null };
        respuestas.asignaciones.maybeSingle = { data: { id: 'asig-1', estado_designacion: 'aceptado' }, error: null };
        const res = await llamar('GET', '/rodeo/rodeo-1', {}, auth(ASOC_OSORNO));
        expect(res.jsonBody.cartilla.id).toBe('cart-inst'); // nunca se oculta ni se borra
        expect(res.jsonBody.bloqueada_por_designacion_posterior).toBe(true);
        expect(res.jsonBody.conflicto_rentado).toBe(false); // no es Caso A: ya existe cartilla, se puede consultar
    });
});

describe('POST /institucional/cartilla/rodeo/:rodeo_id (creación/adjunto)', () => {
    test('creación válida -> 201, llama la RPC con los parámetros correctos', async () => {
        const res = await llamar('POST', '/rodeo/rodeo-1', { delegado_asociacion_id: 'del-1' }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(201);
        expect(supabase.rpc).toHaveBeenCalledWith('crear_o_adjuntar_cartilla_institucional', expect.objectContaining({
            p_rodeo_id: 'rodeo-1', p_delegado_asociacion_id: 'del-1', p_cuenta_institucional_id: 'inst-1',
            p_temporada: '2026-2027', p_fecha_rodeo: '2026-09-18', p_tipo_rodeo: 'Provincial'
        }));
        // Fase 3.5.1: la auditoría ('crear') ya no se registra con una
        // llamada JS separada — queda DENTRO de la misma transacción de la
        // RPC (migración 070), probado contra Postgres real en
        // auditoriaTransaccionalInstitucional.rpc.test.js. Esta ruta ya no
        // debe llamar a auditoria.registrar en absoluto.
        expect(auditoria.registrar).not.toHaveBeenCalled();
    });

    test('rodeo anulado -> 422, nunca llega a llamar la RPC', async () => {
        respuestas.rodeos.maybeSingle = { data: RODEO_ANULADO, error: null };
        const res = await llamar('POST', '/rodeo/rodeo-anulado', { delegado_asociacion_id: 'del-1' }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(422);
        expect(res.jsonBody.code).toBe('RODEO_ANULADO');
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('delegado de otra asociación -> 403, nunca llega a llamar la RPC', async () => {
        respuestas.delegados_asociacion.maybeSingle = { data: DELEGADO_OTRA_ASOC, error: null };
        const res = await llamar('POST', '/rodeo/rodeo-1', { delegado_asociacion_id: 'del-2' }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(403);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('delegado inactivo -> 403', async () => {
        respuestas.delegados_asociacion.maybeSingle = { data: DELEGADO_INACTIVO, error: null };
        const res = await llamar('POST', '/rodeo/rodeo-1', { delegado_asociacion_id: 'del-3' }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(403);
    });

    test('la RPC rechaza por DELEGADO_RENTADO_DESIGNADO -> 409 con el mensaje exacto del Caso A', async () => {
        rpcImpl.mockResolvedValue({ data: null, error: { message: 'DELEGADO_RENTADO_DESIGNADO' } });
        const res = await llamar('POST', '/rodeo/rodeo-1', { delegado_asociacion_id: 'del-1' }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('DELEGADO_RENTADO_DESIGNADO');
        expect(res.jsonBody.error).toBe('Este rodeo tiene un Delegado Rentado designado. La cartilla corresponde a dicho delegado.');
    });

    test('la RPC rechaza por CARTILLA_RENTADO_EXISTENTE -> 409 con código específico', async () => {
        rpcImpl.mockResolvedValue({ data: null, error: { message: 'CARTILLA_RENTADO_EXISTENTE' } });
        const res = await llamar('POST', '/rodeo/rodeo-1', { delegado_asociacion_id: 'del-1' }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('CARTILLA_RENTADO_EXISTENTE');
    });

    test('la RPC rechaza por estado bloqueado -> 409 con código específico', async () => {
        rpcImpl.mockResolvedValue({ data: null, error: { message: 'CARTILLA_BLOQUEADA_PARA_CAMBIO_DE_DELEGADO' } });
        const res = await llamar('POST', '/rodeo/rodeo-1', { delegado_asociacion_id: 'del-1' }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('CARTILLA_BLOQUEADA_PARA_CAMBIO_DE_DELEGADO');
    });

    test('Fase 3.5 — reintento/adjunto con el MISMO delegado ya confirmado (version>1 en la respuesta de la RPC) -> 200 (no 201), nunca es un cambio de responsable', async () => {
        rpcImpl.mockResolvedValue({ data: { id: 'cart-1', version: 2, delegado_asociacion_id: 'del-1', delegado_nombre: 'Ana Soto' }, error: null });
        const res = await llamar('POST', '/rodeo/rodeo-1', {}, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.creada).toBe(false);
        // La auditoría ('guardar' en este caso) la registra la propia RPC —
        // ver nota de la Fase 3.5.1 arriba.
        expect(auditoria.registrar).not.toHaveBeenCalled();
    });

    test('Fase 3.5 — body con delegado_asociacion_id DISTINTO al confirmado -> 403 RESPONSABLE_YA_CONFIRMADO, nunca llega a llamar la RPC', async () => {
        const res = await llamar('POST', '/rodeo/rodeo-1', { delegado_asociacion_id: 'del-2' }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(403);
        expect(res.jsonBody.code).toBe('RESPONSABLE_YA_CONFIRMADO');
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('sin delegado_asociacion_id en el body y sin selección guardada para el rodeo -> 422 DELEGADO_NO_SELECCIONADO', async () => {
        respuestas.rodeos_delegado_institucional.maybeSingle = { data: null, error: null };
        const res = await llamar('POST', '/rodeo/rodeo-1', {}, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(422);
        expect(res.jsonBody.code).toBe('DELEGADO_NO_SELECCIONADO');
    });

    test('Fase 3.3 — sin delegado_asociacion_id en el body PERO con selección ya guardada para el rodeo -> usa esa selección (201)', async () => {
        respuestas.rodeos_delegado_institucional.maybeSingle = { data: { delegado_asociacion_id: 'del-1' }, error: null };
        const res = await llamar('POST', '/rodeo/rodeo-1', {}, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(201);
        expect(supabase.rpc).toHaveBeenCalledWith('crear_o_adjuntar_cartilla_institucional', expect.objectContaining({ p_delegado_asociacion_id: 'del-1' }));
    });
});

describe('PATCH /institucional/cartilla/:id (guardar — concurrencia optimista)', () => {
    const CARTILLA_INST = { id: 'cart-1', rodeo_id: 'rodeo-1', estado: 'borrador', version: 3, delegado_asociacion_id: 'del-1', delegado_nombre: 'Ana Soto' };

    test('version correcta -> guarda, incrementa version, usa la RPC atómica de guardado+auditoría (migración 070)', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: CARTILLA_INST, error: null };
        respuestas.cartillas_delegado.updateResult = { data: { ...CARTILLA_INST, version: 4, delegado_nombre: 'Ana Soto' }, error: null };
        const res = await llamar('PATCH', '/cart-1', { version: 3, delegado_nombre: 'Ana Soto' }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.cartilla.version).toBe(4);
        expect(supabase.rpc).toHaveBeenCalledWith('actualizar_cartilla_institucional_con_auditoria', expect.objectContaining({
            p_cartilla_id: 'cart-1', p_version: 3, p_accion: 'guardar'
        }));
        // Fase 3.5.1: la auditoría la registra la propia RPC, en la misma
        // transacción — esta ruta ya no debe llamar a auditoria.registrar.
        expect(auditoria.registrar).not.toHaveBeenCalled();
    });

    test('version desactualizada (otra sesión ya guardó) -> 409 VERSION_DESACTUALIZADA, nunca sobrescribe silenciosamente', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: CARTILLA_INST, error: null };
        // La RPC (migración 070) señaliza esto con una excepción, no con
        // data:null — ver CARTILLA_NO_ENCONTRADA_O_VERSION_DESACTUALIZADA.
        respuestas.cartillas_delegado.updateResult = { data: null, error: { message: 'CARTILLA_NO_ENCONTRADA_O_VERSION_DESACTUALIZADA' } };
        const res = await llamar('PATCH', '/cart-1', { version: 2 }, auth(ASOC_OSORNO)); // version vieja
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('VERSION_DESACTUALIZADA');
    });

    test('cartilla de origen Delegado Rentado (delegado_asociacion_id null) -> 403, nunca editable desde este namespace', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: { ...CARTILLA_INST, delegado_asociacion_id: null, delegado_id: 'usr-1' }, error: null };
        const res = await llamar('PATCH', '/cart-1', { version: 3 }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(403);
    });

    test('estado bloqueado (enviada) -> 409, sin intentar el UPDATE', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: { ...CARTILLA_INST, estado: 'enviada' }, error: null };
        const res = await llamar('PATCH', '/cart-1', { version: 3 }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('ESTADO_BLOQUEADO');
    });

    test('rodeo ya no pertenece a la asociación del token -> 403 (defensa en profundidad)', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: CARTILLA_INST, error: null };
        const res = await llamar('PATCH', '/cart-1', { version: 3 }, auth(ASOC_VALDIVIA));
        expect(res.statusCode).toBe(403);
    });

    test('sin version en el body -> 400', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: CARTILLA_INST, error: null };
        const res = await llamar('PATCH', '/cart-1', {}, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(400);
    });

    test('Caso F: cuenta institucional desactivada -> 401, ni siquiera llega a leer la cartilla', async () => {
        respuestas.cuentas_institucionales.single = { data: { activo: false, asociaciones: { activa: true } }, error: null };
        const res = await llamar('PATCH', '/cart-1', { version: 3 }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(401);
    });

    test('Fase 3.1 (cierre) Caso D — designación vigente de Rentado aparecida DESPUÉS -> 409 con el mensaje EXACTO pedido, nunca llega a intentar el UPDATE', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: CARTILLA_INST, error: null };
        respuestas.asignaciones.maybeSingle = { data: { id: 'asig-1', estado_designacion: 'aceptado' }, error: null };
        const res = await llamar('PATCH', '/cart-1', { version: 3, delegado_nombre: 'Otro' }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('BLOQUEADA_POR_DESIGNACION_POSTERIOR');
        expect(res.jsonBody.error).toBe('Este rodeo presenta un cambio de designación de Delegado. La cartilla se encuentra temporalmente bloqueada hasta que el Administrador resuelva la situación.');
    });

    test('Fase 3.5 — intentar cambiar delegado_asociacion_id vía guardado normal -> 403 RESPONSABLE_YA_CONFIRMADO, nunca llega a actualizar', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: CARTILLA_INST, error: null };
        const res = await llamar('PATCH', '/cart-1', { version: 3, delegado_asociacion_id: 'del-2' }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(403);
        expect(res.jsonBody.code).toBe('RESPONSABLE_YA_CONFIRMADO');
    });

    test('Fase 3.5 — intentar cambiar delegado_nombre (snapshot) vía guardado normal -> 403 RESPONSABLE_YA_CONFIRMADO', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: CARTILLA_INST, error: null };
        const res = await llamar('PATCH', '/cart-1', { version: 3, delegado_nombre: 'Nombre Falsificado' }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(403);
        expect(res.jsonBody.code).toBe('RESPONSABLE_YA_CONFIRMADO');
    });

    test('Fase 3.5 — enviar delegado_nombre IGUAL al ya confirmado (sin cambio real) -> permitido, nunca bloquea un guardado normal', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: CARTILLA_INST, error: null };
        respuestas.cartillas_delegado.updateResult = { data: { ...CARTILLA_INST, version: 4 }, error: null };
        const res = await llamar('PATCH', '/cart-1', { version: 3, delegado_nombre: 'Ana Soto', delegado_telefono: '+56911112222' }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(200);
    });

    // Fase 3.5 — Sección 9, punto 13: "el historial de auditoría no es
    // editable por la asociación desde el formulario". `historial_responsables`
    // nunca es un campo de cartillas_delegado (se calcula en cada lectura
    // desde `auditoria`, ver historialResponsableInstitucional.js) y nunca
    // está en CAMPOS_EDITABLES — un body que lo incluya se ignora en
    // silencio, nunca llega a escribirse ni a alterar el UPDATE real.
    test('Fase 3.5 — enviar historial_responsables en el body se ignora por completo: nunca se persiste, el UPDATE real no lo incluye', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: CARTILLA_INST, error: null };
        respuestas.cartillas_delegado.updateResult = { data: { ...CARTILLA_INST, version: 4 }, error: null };
        const res = await llamar('PATCH', '/cart-1', {
            version: 3,
            historial_responsables: [{ accion: 'reemplazar_responsable_institucional', descripcion: 'Evento fabricado por la asociación', created_at: new Date().toISOString() }]
        }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.cartilla.historial_responsables).toBeUndefined();
    });
});

describe('POST /institucional/cartilla/:id/enviar', () => {
    const BASE = {
        id: 'cart-1', rodeo_id: 'rodeo-1', estado: 'borrador', version: 1, delegado_asociacion_id: 'del-1',
        temporada: '2026-2027', fecha_rodeo: '2026-09-18', delegado_nombre: 'Ana Soto', tipo_rodeo: 'Provincial',
        historial_observaciones: []
    };

    test('envío válido con todos los campos requeridos -> 200, estado=enviada, vía la RPC atómica de envío+auditoría (migración 070)', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: BASE, error: null };
        respuestas.cartillas_delegado.updateResult = { data: { ...BASE, estado: 'enviada', version: 2 }, error: null };
        const res = await llamar('POST', '/cart-1/enviar', { version: 1 }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.cartilla.estado).toBe('enviada');
        expect(supabase.rpc).toHaveBeenCalledWith('actualizar_cartilla_institucional_con_auditoria', expect.objectContaining({
            p_cartilla_id: 'cart-1', p_version: 1, p_accion: 'enviar'
        }));
        // Fase 3.5.1: la auditoría la registra la propia RPC — esta ruta ya
        // no debe llamar a auditoria.registrar.
        expect(auditoria.registrar).not.toHaveBeenCalled();
    });

    test('faltan campos requeridos (CAMPOS_REQUERIDOS_ENVIO) -> 422, nunca envía', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: { ...BASE, temporada: null }, error: null };
        const res = await llamar('POST', '/cart-1/enviar', { version: 1 }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(422);
        expect(res.jsonBody.faltantes).toContain('temporada');
    });

    test('version desactualizada -> 409, antes de validar campos', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: BASE, error: null };
        const res = await llamar('POST', '/cart-1/enviar', { version: 99 }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('VERSION_DESACTUALIZADA');
    });

    test('estaba "observada" -> pasa a "reenviada" (no "enviada")', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: { ...BASE, estado: 'observada' }, error: null };
        respuestas.cartillas_delegado.updateResult = { data: { ...BASE, estado: 'reenviada', version: 2 }, error: null };
        const res = await llamar('POST', '/cart-1/enviar', { version: 1 }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.cartilla.estado).toBe('reenviada');
    });

    test('ya enviada -> 409, no se reenvía dos veces', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: { ...BASE, estado: 'enviada' }, error: null };
        const res = await llamar('POST', '/cart-1/enviar', { version: 1 }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(409);
    });

    test('cartilla de origen Delegado Rentado -> 403, nunca se puede enviar desde este namespace', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: { ...BASE, delegado_asociacion_id: null, delegado_id: 'usr-1' }, error: null };
        const res = await llamar('POST', '/cart-1/enviar', { version: 1 }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(403);
    });

    test('Fase 3.1 (cierre) Caso D — designación vigente de Rentado aparecida DESPUÉS -> 409, bloquea el envío con el mensaje EXACTO pedido', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: BASE, error: null };
        respuestas.asignaciones.maybeSingle = { data: { id: 'asig-1', estado_designacion: 'pendiente' }, error: null };
        const res = await llamar('POST', '/cart-1/enviar', { version: 1 }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('BLOQUEADA_POR_DESIGNACION_POSTERIOR');
        expect(res.jsonBody.error).toBe('Este rodeo presenta un cambio de designación de Delegado. La cartilla se encuentra temporalmente bloqueada hasta que el Administrador resuelva la situación.');
    });

    test('Fase 3.5 — intentar cambiar delegado_nombre al enviar -> 403 RESPONSABLE_YA_CONFIRMADO, nunca envía', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: BASE, error: null };
        const res = await llamar('POST', '/cart-1/enviar', { version: 1, delegado_nombre: 'Nombre Falsificado' }, auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(403);
        expect(res.jsonBody.code).toBe('RESPONSABLE_YA_CONFIRMADO');
    });
});

describe('Fase 3.4 — GET /institucional/cartilla/:id/pdf (reutiliza el generador oficial, nunca un diseño paralelo)', () => {
    const CARTILLA_PDF = {
        id: 'cart-1', rodeo_id: 'rodeo-1', estado: 'enviada', delegado_asociacion_id: 'del-1',
        delegado_nombre: 'Ana Soto', fecha_rodeo: '2026-09-18',
        rodeo: { id: 'rodeo-1', club: 'Club Río Negro', asociacion: 'OSORNO', fecha: '2026-09-18', tipo_rodeo_nombre: 'Provincial' }
    };

    beforeEach(() => {
        respuestas.cartillas_delegado.maybeSingle = { data: CARTILLA_PDF, error: null };
        generarCartillaDelegadoPDF.mockReset();
        generarCartillaDelegadoPDF.mockResolvedValue(Buffer.from('%PDF-FAKE'));
    });

    function llamarGet(ruta, headers) {
        return new Promise((resolve, reject) => {
            const req = { method: 'GET', url: ruta, originalUrl: ruta, body: {}, params: {}, headers, query: {}, ip: '127.0.0.1' };
            const res = crearResFake();
            const jsonOriginal = res.json;
            res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
            const endOriginal = res.end;
            res.end = (p) => { endOriginal(p); resolve(res); return res; };
            router(req, res, (err) => err ? reject(err) : resolve(res));
        });
    }

    test('cartilla institucional, rodeo de MI asociación -> 200, reutiliza generarCartillaDelegadoPDF con (cartilla, rodeo, historial), nombre de archivo claro', async () => {
        const res = await llamarGet('/cart-1/pdf', auth(ASOC_OSORNO));
        expect(generarCartillaDelegadoPDF).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'cart-1' }),
            expect.objectContaining({ club: 'Club Río Negro' }),
            expect.objectContaining({ historialResponsables: expect.any(Array) })
        );
        expect(res.cabeceras['Content-Type']).toBe('application/pdf');
        expect(res.cabeceras['Content-Disposition']).toBe('attachment; filename="Cartilla_Delegado_Club_Rio_Negro_18-09-2026.pdf"');
        expect(res.endBody.toString()).toBe('%PDF-FAKE');
    });

    test('funciona para CUALQUIER estado (enviada, aprobada, cerrada, etc.) — el generador reutilizado no restringe por estado', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: { ...CARTILLA_PDF, estado: 'aprobada' }, error: null };
        const res = await llamarGet('/cart-1/pdf', auth(ASOC_OSORNO));
        expect(res.endBody).not.toBeNull();
        expect(generarCartillaDelegadoPDF).toHaveBeenCalled();
    });

    test('cartilla inexistente -> 404, nunca intenta generar el PDF', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: null, error: null };
        const res = await llamarGet('/id-fantasma/pdf', auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(404);
        expect(generarCartillaDelegadoPDF).not.toHaveBeenCalled();
    });

    test('cartilla de origen Delegado Rentado (delegado_asociacion_id null) -> 403, nunca se expone por este namespace', async () => {
        respuestas.cartillas_delegado.maybeSingle = { data: { ...CARTILLA_PDF, delegado_asociacion_id: null, delegado_id: 'usr-1' }, error: null };
        const res = await llamarGet('/cart-1/pdf', auth(ASOC_OSORNO));
        expect(res.statusCode).toBe(403);
        expect(generarCartillaDelegadoPDF).not.toHaveBeenCalled();
    });

    test('cartilla institucional, pero de OTRA asociación (ej. rodeo ya no resuelve a la asociación del token) -> 403, nunca por solo el ID', async () => {
        respuestas.rodeos.maybeSingle = { data: null, error: null }; // rodeoDeMiAsociacion no encuentra el rodeo para esta asociación
        const res = await llamarGet('/cart-1/pdf', auth(ASOC_VALDIVIA));
        expect(res.statusCode).toBe(403);
        expect(generarCartillaDelegadoPDF).not.toHaveBeenCalled();
    });
});
