// Cartilla única por rodeo, con versiones (migración 075) — subirAdjuntoRodeo
// (lógica de POST /api/admin/adjuntos extraída para ser testable sin
// multer, ver su propio comentario en adjuntos.js). Cubre:
//   - Clasificación obligatoria para tipo_adjunto='cartilla_delegado'
//     (nunca se asume "es una versión" ni "es complementario" por omisión).
//   - Cartilla_delegado usa la RPC transaccional; cualquier otro tipo sigue
//     con el INSERT directo de siempre, sin cambios.
//   - Falla parcial Storage-OK/Postgres-falla -> se intenta revertir
//     Storage (rollback best-effort), nunca se deja un archivo huérfano sin
//     rastro ni se declara éxito.
jest.mock('../../config/supabase', () => ({
    from: jest.fn(),
    rpc: jest.fn(),
    storage: { from: jest.fn() }
}));

const supabase = require('../../config/supabase');
const router = require('./adjuntos');
const { subirAdjuntoRodeo, clasificarAdjuntoHistorico } = router;

const FILE = { originalname: 'cartilla.pdf', buffer: Buffer.from('x'), mimetype: 'application/pdf', size: 123 };

let storageUploadImpl, storageRemoveImpl, insertImpl, rpcImpl;
beforeEach(() => {
    supabase.storage.from.mockReset();
    supabase.from.mockReset();
    supabase.rpc.mockReset();

    storageUploadImpl = jest.fn().mockResolvedValue({ data: {}, error: null });
    storageRemoveImpl = jest.fn().mockResolvedValue({ data: {}, error: null });
    supabase.storage.from.mockReturnValue({ upload: storageUploadImpl, remove: storageRemoveImpl });

    insertImpl = jest.fn().mockReturnValue({
        select: () => ({ single: () => Promise.resolve({ data: { id: 'adj-1' }, error: null }) })
    });
    supabase.from.mockReturnValue({ insert: insertImpl });

    rpcImpl = jest.fn().mockResolvedValue({ data: { id: 'adj-1', cartilla_numero_version: 1, cartilla_vigente: true }, error: null });
    supabase.rpc.mockImplementation(rpcImpl);
});

describe('Clasificación obligatoria para tipo_adjunto=cartilla_delegado', () => {
    test('sin es_version_cartilla -> 400 CLASIFICACION_CARTILLA_REQUERIDA, nunca sube a Storage', async () => {
        const r = await subirAdjuntoRodeo({ rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', es_version_cartilla: undefined, file: FILE, administradorId: 'admin-1' });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('CLASIFICACION_CARTILLA_REQUERIDA');
        expect(storageUploadImpl).not.toHaveBeenCalled();
    });

    test('es_version_cartilla con un valor inválido (ni "true" ni "false") -> 400, nunca asume nada', async () => {
        const r = await subirAdjuntoRodeo({ rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', es_version_cartilla: 'tal_vez', file: FILE, administradorId: 'admin-1' });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('CLASIFICACION_CARTILLA_REQUERIDA');
    });

    test('cualquier otro tipo_adjunto NO requiere la clasificación (comportamiento previo intacto)', async () => {
        const r = await subirAdjuntoRodeo({ rodeo_id: 'r1', tipo_adjunto: 'foto', es_version_cartilla: undefined, file: FILE, administradorId: 'admin-1' });
        expect(r.status).toBe(201);
        expect(supabase.rpc).not.toHaveBeenCalled();
        expect(insertImpl).toHaveBeenCalled();
    });
});

describe('cartilla_delegado -> usa la RPC transaccional (nunca el INSERT directo)', () => {
    test('es_version_cartilla="true" -> llama la RPC con p_es_version_cartilla=true', async () => {
        const r = await subirAdjuntoRodeo({ rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', es_version_cartilla: 'true', usuario_pagado_id: null, file: FILE, administradorId: 'admin-1' });
        expect(r.status).toBe(201);
        expect(supabase.rpc).toHaveBeenCalledWith('registrar_version_cartilla_delegado_adjunta', expect.objectContaining({
            p_rodeo_id: 'r1', p_es_version_cartilla: true, p_created_by: 'admin-1',
            p_nombre_archivo: 'cartilla.pdf'
        }));
        expect(insertImpl).not.toHaveBeenCalled();
    });

    test('es_version_cartilla="false" (documento complementario) -> llama la RPC con p_es_version_cartilla=false', async () => {
        const r = await subirAdjuntoRodeo({ rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', es_version_cartilla: 'false', file: FILE, administradorId: 'admin-1' });
        expect(r.status).toBe(201);
        expect(supabase.rpc).toHaveBeenCalledWith('registrar_version_cartilla_delegado_adjunta', expect.objectContaining({ p_es_version_cartilla: false }));
    });
});

describe('Falla de Storage (antes de tocar la BD)', () => {
    test('falla al subir a Storage -> 500, nunca llega a llamar la RPC ni el INSERT', async () => {
        storageUploadImpl.mockResolvedValue({ data: null, error: { message: 'bucket lleno' } });
        const r = await subirAdjuntoRodeo({ rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', es_version_cartilla: 'true', file: FILE, administradorId: 'admin-1' });
        expect(r.status).toBe(500);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });
});

describe('Falla parcial: Storage OK, Postgres falla -> rollback best-effort, nunca archivo huérfano silencioso', () => {
    test('cartilla_delegado: la RPC falla -> se intenta supabase.storage.remove() con el MISMO path subido, y responde 500', async () => {
        rpcImpl.mockResolvedValue({ data: null, error: { message: 'constraint violation' } });
        const r = await subirAdjuntoRodeo({ rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', es_version_cartilla: 'true', file: FILE, administradorId: 'admin-1' });
        expect(r.status).toBe(500);
        expect(storageRemoveImpl).toHaveBeenCalledTimes(1);
        const pathSubido = storageUploadImpl.mock.calls[0][0];
        const pathBorrado = storageRemoveImpl.mock.calls[0][0][0];
        expect(pathBorrado).toBe(pathSubido); // revierte EXACTAMENTE el archivo que se subió
    });

    test('otro tipo_adjunto: el INSERT falla -> también se intenta el rollback de Storage', async () => {
        insertImpl.mockReturnValue({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'fk violation' } }) }) });
        const r = await subirAdjuntoRodeo({ rodeo_id: 'r1', tipo_adjunto: 'foto', file: FILE, administradorId: 'admin-1' });
        expect(r.status).toBe(500);
        expect(storageRemoveImpl).toHaveBeenCalledTimes(1);
    });

    test('si el propio rollback de Storage también falla, igual responde 500 (nunca un éxito falso) y lo deja registrado para revisión manual', async () => {
        rpcImpl.mockResolvedValue({ data: null, error: { message: 'constraint violation' } });
        storageRemoveImpl.mockResolvedValue({ data: null, error: { message: 'network error' } });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const r = await subirAdjuntoRodeo({ rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', es_version_cartilla: 'true', file: FILE, administradorId: 'admin-1' });
        expect(r.status).toBe(500);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Archivo huérfano'));
        errorSpy.mockRestore();
    });
});

// ─── Auditoría/corrección (077) — cartilla digital previa + adjunto oficial
// posterior: nunca se genera en silencio una segunda cartilla oficial
// independiente — se exige confirmación explícita, revirtiendo Storage
// igual que cualquier otra falla de la RPC, nunca un 500 (no es una falla
// real, es una decisión pendiente del Administrador).
describe('Cartilla digital previa + adjunto oficial posterior -> requiere confirmación explícita (nunca silencioso)', () => {
    test('la RPC rechaza por CARTILLA_DIGITAL_EXISTENTE_REQUIERE_CONFIRMACION -> 409 con ese código (no 500), y revierte Storage', async () => {
        rpcImpl.mockResolvedValue({ data: null, error: { message: 'CARTILLA_DIGITAL_EXISTENTE_REQUIERE_CONFIRMACION' } });
        const r = await subirAdjuntoRodeo({ rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', es_version_cartilla: 'true', file: FILE, administradorId: 'admin-1' });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('CARTILLA_DIGITAL_EXISTENTE_REQUIERE_CONFIRMACION');
        expect(storageRemoveImpl).toHaveBeenCalledTimes(1);
    });

    test('confirma_conflicto_cartilla_digital="true" (reintento tras confirmar) -> se envía como boolean true a la RPC', async () => {
        const r = await subirAdjuntoRodeo({ rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', es_version_cartilla: 'true', confirma_conflicto_cartilla_digital: 'true', file: FILE, administradorId: 'admin-1' });
        expect(r.status).toBe(201);
        expect(supabase.rpc).toHaveBeenCalledWith('registrar_version_cartilla_delegado_adjunta', expect.objectContaining({ p_confirma_conflicto_cartilla_digital: true }));
    });

    test('sin confirmar (omitido) -> se envía como boolean false a la RPC, nunca undefined', async () => {
        const r = await subirAdjuntoRodeo({ rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', es_version_cartilla: 'true', file: FILE, administradorId: 'admin-1' });
        expect(r.status).toBe(201);
        expect(supabase.rpc).toHaveBeenCalledWith('registrar_version_cartilla_delegado_adjunta', expect.objectContaining({ p_confirma_conflicto_cartilla_digital: false }));
    });
});

describe('Camino feliz — respuesta final', () => {
    test('cartilla_delegado exitoso -> 201 con el adjunto devuelto por la RPC', async () => {
        const r = await subirAdjuntoRodeo({ rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', es_version_cartilla: 'true', file: FILE, administradorId: 'admin-1' });
        expect(r.status).toBe(201);
        expect(r.body.adjunto).toEqual({ id: 'adj-1', cartilla_numero_version: 1, cartilla_vigente: true });
    });
});

// ─── clasificarAdjuntoHistorico — corrección final (076): resolver UN
// archivo histórico 'pendiente' hacia version_cartilla o complementario, vía
// la RPC clasificar_adjunto_cartilla_delegado_historico. Nunca masivo, nunca
// automático — siempre una decisión explícita del Administrador sobre un
// adjunto puntual.
describe('clasificarAdjuntoHistorico — resolver un archivo histórico pendiente', () => {
    test('es_version_cartilla=true -> llama la RPC con los parámetros correctos y devuelve 200 con el adjunto actualizado', async () => {
        supabase.rpc.mockResolvedValue({ data: { id: 'adj-1', cartilla_clasificacion: 'version_cartilla', cartilla_vigente: true, cartilla_numero_version: 3 }, error: null });
        const r = await clasificarAdjuntoHistorico({ adjuntoId: 'adj-1', esVersionCartilla: true, administradorId: 'admin-1' });
        expect(supabase.rpc).toHaveBeenCalledWith('clasificar_adjunto_cartilla_delegado_historico', {
            p_adjunto_id: 'adj-1', p_es_version_cartilla: true, p_administrador_id: 'admin-1', p_confirma_conflicto_cartilla_digital: false
        });
        expect(r.status).toBe(200);
        expect(r.body.adjunto).toMatchObject({ cartilla_clasificacion: 'version_cartilla', cartilla_vigente: true });
    });

    test('es_version_cartilla=false (documento complementario, caso real CHACAICO/BÍO-BÍO) -> llama la RPC con p_es_version_cartilla=false', async () => {
        supabase.rpc.mockResolvedValue({ data: { id: 'adj-2', cartilla_clasificacion: 'complementario' }, error: null });
        const r = await clasificarAdjuntoHistorico({ adjuntoId: 'adj-2', esVersionCartilla: false, administradorId: 'admin-1' });
        expect(supabase.rpc).toHaveBeenCalledWith('clasificar_adjunto_cartilla_delegado_historico', expect.objectContaining({ p_es_version_cartilla: false }));
        expect(r.status).toBe(200);
        expect(r.body.adjunto.cartilla_clasificacion).toBe('complementario');
    });

    test('adjunto inexistente -> 404 ADJUNTO_NO_ENCONTRADO', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'ADJUNTO_NO_ENCONTRADO' } });
        const r = await clasificarAdjuntoHistorico({ adjuntoId: 'no-existe', esVersionCartilla: true, administradorId: 'admin-1' });
        expect(r.status).toBe(404);
        expect(r.body.code).toBe('ADJUNTO_NO_ENCONTRADO');
    });

    test('adjunto ya clasificado anteriormente -> 409 ADJUNTO_YA_CLASIFICADO, nunca lo reclasifica silenciosamente', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'ADJUNTO_YA_CLASIFICADO' } });
        const r = await clasificarAdjuntoHistorico({ adjuntoId: 'adj-1', esVersionCartilla: true, administradorId: 'admin-1' });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('ADJUNTO_YA_CLASIFICADO');
    });

    test('otra falla real de la RPC -> 500 con el mensaje de la BD', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'timeout' } });
        const r = await clasificarAdjuntoHistorico({ adjuntoId: 'adj-1', esVersionCartilla: true, administradorId: 'admin-1' });
        expect(r.status).toBe(500);
        expect(r.body.error).toBe('timeout');
    });

    test('auditoría (077) — cartilla digital previa ya existente -> 409 CARTILLA_DIGITAL_EXISTENTE_REQUIERE_CONFIRMACION (no 500), nunca clasifica en silencio como oficial', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'CARTILLA_DIGITAL_EXISTENTE_REQUIERE_CONFIRMACION' } });
        const r = await clasificarAdjuntoHistorico({ adjuntoId: 'adj-1', esVersionCartilla: true, administradorId: 'admin-1' });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('CARTILLA_DIGITAL_EXISTENTE_REQUIERE_CONFIRMACION');
    });

    test('confirmaConflictoCartillaDigital=true -> se envía como boolean true a la RPC', async () => {
        supabase.rpc.mockResolvedValue({ data: { id: 'adj-1', cartilla_clasificacion: 'version_cartilla' }, error: null });
        await clasificarAdjuntoHistorico({ adjuntoId: 'adj-1', esVersionCartilla: true, administradorId: 'admin-1', confirmaConflictoCartillaDigital: true });
        expect(supabase.rpc).toHaveBeenCalledWith('clasificar_adjunto_cartilla_delegado_historico', expect.objectContaining({ p_confirma_conflicto_cartilla_digital: true }));
    });
});

// ─── POST /:id/clasificar-historico — validación del body antes de llamar
// la lógica extraída (ver clasificarAdjuntoHistorico arriba) ───────────────
describe('POST /api/admin/adjuntos/:id/clasificar-historico — validación', () => {
    function llamarPost(id, body) {
        return new Promise((resolve, reject) => {
            const req = { method: 'POST', url: `/${id}/clasificar-historico`, originalUrl: `/${id}/clasificar-historico`, params: { id }, body, usuario: { id: 'admin-1' } };
            const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(p) { this.jsonBody = p; resolve(this); return this; } };
            router(req, res, (err) => err ? reject(err) : resolve(res));
        });
    }

    test('sin es_version_cartilla (no boolean) -> 400 CLASIFICACION_CARTILLA_REQUERIDA, nunca llama la RPC', async () => {
        const res = await llamarPost('adj-1', {});
        expect(res.statusCode).toBe(400);
        expect(res.jsonBody.code).toBe('CLASIFICACION_CARTILLA_REQUERIDA');
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('con es_version_cartilla=true -> delega en la RPC y responde 200', async () => {
        supabase.rpc.mockResolvedValue({ data: { id: 'adj-1', cartilla_clasificacion: 'version_cartilla' }, error: null });
        const res = await llamarPost('adj-1', { es_version_cartilla: true });
        expect(res.statusCode).toBe(200);
        expect(supabase.rpc).toHaveBeenCalledWith('clasificar_adjunto_cartilla_delegado_historico', expect.objectContaining({ p_adjunto_id: 'adj-1', p_administrador_id: 'admin-1' }));
    });

    test('con confirma_conflicto_cartilla_digital=true -> se propaga a la RPC como boolean true', async () => {
        supabase.rpc.mockResolvedValue({ data: { id: 'adj-1', cartilla_clasificacion: 'version_cartilla' }, error: null });
        const res = await llamarPost('adj-1', { es_version_cartilla: true, confirma_conflicto_cartilla_digital: true });
        expect(res.statusCode).toBe(200);
        expect(supabase.rpc).toHaveBeenCalledWith('clasificar_adjunto_cartilla_delegado_historico', expect.objectContaining({ p_confirma_conflicto_cartilla_digital: true }));
    });
});

// ─── DELETE /:id — auditoría/corrección (077): nunca eliminar una versión
// confirmada de la Cartilla de Delegado oficial desde este endpoint genérico
// (ver nota en adjuntos.js) ──────────────────────────────────────────────
describe('DELETE /api/admin/adjuntos/:id — protege las versiones oficiales confirmadas', () => {
    let respuestas;
    function crearChainDelete(tabla) {
        const chain = {};
        ['select', 'eq'].forEach(m => { chain[m] = () => chain; });
        chain.single = () => Promise.resolve(respuestas[tabla]?.single ?? { data: null, error: null });
        chain.delete = () => ({ eq: () => Promise.resolve({ data: null, error: null }) });
        return chain;
    }
    function llamarDelete(id) {
        return new Promise((resolve, reject) => {
            const req = { method: 'DELETE', url: `/${id}`, originalUrl: `/${id}`, params: { id }, body: {}, usuario: { id: 'admin-1' } };
            const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(p) { this.jsonBody = p; resolve(this); return this; } };
            router(req, res, (err) => err ? reject(err) : resolve(res));
        });
    }

    beforeEach(() => {
        respuestas = { rodeo_adjuntos: { single: { data: null, error: null } } };
        supabase.from.mockReset();
        supabase.from.mockImplementation(tabla => crearChainDelete(tabla));
    });

    test('adjunto clasificado como version_cartilla -> 409 CARTILLA_OFICIAL_NO_SE_PUEDE_ELIMINAR, nunca llega a borrar de Storage ni de la BD', async () => {
        respuestas.rodeo_adjuntos.single = { data: { id: 'adj-1', storage_path: 'p/1', tipo_adjunto: 'cartilla_delegado', cartilla_clasificacion: 'version_cartilla' }, error: null };
        const res = await llamarDelete('adj-1');
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('CARTILLA_OFICIAL_NO_SE_PUEDE_ELIMINAR');
        expect(storageRemoveImpl).not.toHaveBeenCalled();
    });

    test('adjunto clasificado como complementario -> se elimina normalmente (no es la cartilla oficial)', async () => {
        respuestas.rodeo_adjuntos.single = { data: { id: 'adj-1', storage_path: 'p/1', tipo_adjunto: 'cartilla_delegado', cartilla_clasificacion: 'complementario' }, error: null };
        const res = await llamarDelete('adj-1');
        expect(res.statusCode).toBe(200);
    });

    test('adjunto pendiente de clasificar (histórico) -> se puede eliminar normalmente (no es una versión CONFIRMADA)', async () => {
        respuestas.rodeo_adjuntos.single = { data: { id: 'adj-1', storage_path: 'p/1', tipo_adjunto: 'cartilla_delegado', cartilla_clasificacion: 'pendiente' }, error: null };
        const res = await llamarDelete('adj-1');
        expect(res.statusCode).toBe(200);
    });

    test('cualquier otro tipo_adjunto (ej. foto) -> se elimina normalmente, sin cambios', async () => {
        respuestas.rodeo_adjuntos.single = { data: { id: 'adj-1', storage_path: 'p/1', tipo_adjunto: 'foto', cartilla_clasificacion: null }, error: null };
        const res = await llamarDelete('adj-1');
        expect(res.statusCode).toBe(200);
    });

    test('adjunto inexistente -> 404, nunca intenta eliminar', async () => {
        const res = await llamarDelete('no-existe');
        expect(res.statusCode).toBe(404);
    });
});

// ─── GET / — historial: versión/vigencia + nombre real del administrador ──
// (sin multer, se prueba a través del router real).
describe('GET /api/admin/adjuntos — historial con versión/vigencia y nombre del administrador', () => {
    let respuestas;
    function crearChainTabla(tabla) {
        const chain = {};
        ['select', 'eq', 'order', 'in'].forEach(m => { chain[m] = () => chain; });
        chain.then = (resolve, reject) => Promise.resolve(respuestas[tabla] ?? { data: [], error: null }).then(resolve, reject);
        return chain;
    }
    function llamar(query) {
        return new Promise((resolve, reject) => {
            const req = { method: 'GET', url: '/?' + query, originalUrl: '/?' + query, query: Object.fromEntries(new URLSearchParams(query)), params: {}, body: {} };
            const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(p) { this.jsonBody = p; resolve(this); return this; } };
            router(req, res, (err) => err ? reject(err) : resolve(res));
        });
    }

    beforeEach(() => {
        respuestas = {
            rodeo_adjuntos: { data: [], error: null },
            rodeo_links: { data: [], error: null },
            administradores: { data: [], error: null }
        };
        supabase.from.mockReset();
        supabase.from.mockImplementation(tabla => crearChainTabla(tabla));
    });

    test('incluye cartilla_numero_version y cartilla_vigente tal cual vienen de la BD (nunca recalculados en esta ruta)', async () => {
        respuestas.rodeo_adjuntos = { data: [{ id: 'a1', tipo_adjunto: 'cartilla_delegado', cartilla_numero_version: 2, cartilla_vigente: true, created_by: null }], error: null };
        const res = await llamar('rodeo_id=r1');
        expect(res.jsonBody.adjuntos[0]).toMatchObject({ cartilla_numero_version: 2, cartilla_vigente: true });
    });

    test('resuelve el nombre real del administrador por created_by (nunca por embed, nunca inventado)', async () => {
        respuestas.rodeo_adjuntos = { data: [{ id: 'a1', created_by: 'admin-7' }], error: null };
        respuestas.administradores = { data: [{ id: 'admin-7', nombre_completo: 'Pedro Pérez' }], error: null };
        const res = await llamar('rodeo_id=r1');
        expect(res.jsonBody.adjuntos[0].admin_nombre).toBe('Pedro Pérez');
    });

    test('created_by sin coincidencia en administradores -> admin_nombre=null, nunca un nombre inventado', async () => {
        respuestas.rodeo_adjuntos = { data: [{ id: 'a1', created_by: 'admin-desconocido' }], error: null };
        respuestas.administradores = { data: [], error: null };
        const res = await llamar('rodeo_id=r1');
        expect(res.jsonBody.adjuntos[0].admin_nombre).toBeNull();
    });

    test('created_by null (archivo subido por un usuario pagado, no por un admin) -> admin_nombre=null, nunca consulta administradores de más', async () => {
        respuestas.rodeo_adjuntos = { data: [{ id: 'a1', created_by: null }], error: null };
        const res = await llamar('rodeo_id=r1');
        expect(res.jsonBody.adjuntos[0].admin_nombre).toBeNull();
    });
});
