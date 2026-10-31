// ═════════════════════════════════════════════════════════════════════════
// Tests de ORQUESTACIÓN DE RUTA — usuarios.js, ampliación Hoja de Vida.
// Mismo patrón que hojavida.orquestacion.test.js: se invoca el router de
// Express directamente (sin servidor HTTP) con un req/res mínimos.
//
// Cubre exactamente lo que cambió en esta revisión: PATCH /:id/estado,
// /:id/suspender y /:id/categoria ahora llaman a una RPC transaccional en
// vez de hacer UPDATE+INSERT en dos pasos sueltos; y los dos endpoints
// nuevos /:id/no-certificado y /:id/en-retiro. No se repite la lógica ya
// probada contra Postgres real en usuarioHistorialAdministrativo.rpc.test.js
// (atomicidad, condiciones simultáneas) — acá solo se verifica que la RUTA
// pase los parámetros correctos, mapee los errores de la RPC al código HTTP
// adecuado, y que el control de permisos (soloRolEvaluacion('jefe_area'),
// real — no mockeado) quede efectivamente aplicado.
// ═════════════════════════════════════════════════════════════════════════
jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
jest.mock('../../services/auditoria', () => ({ registrar: jest.fn().mockResolvedValue(undefined) }));

const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');
const router = require('./usuarios');

function crearSupabaseMock(filasPorTabla) {
    supabase.from.mockImplementation((tabla) => {
        const fila = filasPorTabla[tabla];
        const chain = {
            select: () => chain,
            eq: () => chain,
            single: () => Promise.resolve({ data: fila || null, error: fila ? null : { message: 'no encontrado' } })
        };
        return chain;
    });
}

function llamarRuta({ method, url, params, body, usuario }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url,
            body: body || {}, query: {}, params: params || {}, headers: {},
            ip: '127.0.0.1',
            usuario: usuario || { id: 'admin-pleno', nombre: 'Admin Pleno', tipo: 'administrador', rol_evaluacion: null },
            get() { return undefined; }
        };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(payload) { resolve({ status: this.statusCode, body: payload }); return this; }
        };
        router(req, res, (err) => {
            if (err) reject(err);
            else resolve({ status: 404, body: { error: 'ruta no encontrada' } });
        });
    });
}

const ADMIN_PLENO       = { id: 'a1', nombre: 'Admin Pleno', tipo: 'administrador', rol_evaluacion: null };
const JEFE_DEPORTIVO    = { id: 'a2', nombre: 'Jefe Deportivo', tipo: 'administrador', rol_evaluacion: 'jefe_area' };
const ANALISTA          = { id: 'a3', nombre: 'Analista', tipo: 'administrador', rol_evaluacion: 'analista' };
const MONITOR           = { id: 'a4', nombre: 'Monitor', tipo: 'administrador', rol_evaluacion: 'monitor' };

beforeEach(() => { jest.clearAllMocks(); });

describe('PATCH /:id/estado — permisos y mapeo de errores de la RPC', () => {
    test('admin pleno: éxito llama a la RPC con los parámetros correctos', async () => {
        crearSupabaseMock({ usuarios_pagados: { nombre_completo: 'Juan', activo: true, estado_usuario: 'activo', no_certificado: false, en_retiro: false } });
        supabase.rpc.mockResolvedValue({ data: {}, error: null });
        const r = await llamarRuta({ method: 'PATCH', url: '/u1/estado', params: { id: 'u1' }, body: { estado: 'receso' }, usuario: ADMIN_PLENO });
        expect(r.status).toBe(200);
        expect(supabase.rpc).toHaveBeenCalledWith('cambiar_estado_usuario_con_historial', expect.objectContaining({
            p_usuario_id: 'u1', p_estado_nuevo: 'receso', p_actor_id: 'a1', p_actor_nombre: 'Admin Pleno'
        }));
    });

    test('Jefe Deportivo (jefe_area): permitido, igual que admin pleno', async () => {
        crearSupabaseMock({ usuarios_pagados: { nombre_completo: 'Juan', activo: true, estado_usuario: 'activo', no_certificado: false, en_retiro: false } });
        supabase.rpc.mockResolvedValue({ data: {}, error: null });
        const r = await llamarRuta({ method: 'PATCH', url: '/u1/estado', params: { id: 'u1' }, body: { estado: 'receso' }, usuario: JEFE_DEPORTIVO });
        expect(r.status).toBe(200);
    });

    test('Analista: 403, nunca llega a llamar la RPC', async () => {
        const r = await llamarRuta({ method: 'PATCH', url: '/u1/estado', params: { id: 'u1' }, body: { estado: 'receso' }, usuario: ANALISTA });
        expect(r.status).toBe(403);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('Monitor: 403, nunca llega a llamar la RPC', async () => {
        const r = await llamarRuta({ method: 'PATCH', url: '/u1/estado', params: { id: 'u1' }, body: { estado: 'activo' }, usuario: MONITOR });
        expect(r.status).toBe(403);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('CONDICION_BLOQUEANTE_VIGENTE de la RPC se traduce a 409 con mensaje claro', async () => {
        crearSupabaseMock({ usuarios_pagados: { nombre_completo: 'Juan', activo: false, estado_usuario: 'inactivo', no_certificado: true, en_retiro: false } });
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'CONDICION_BLOQUEANTE_VIGENTE: no se puede activar' } });
        const r = await llamarRuta({ method: 'PATCH', url: '/u1/estado', params: { id: 'u1' }, body: { estado: 'activo' }, usuario: ADMIN_PLENO });
        expect(r.status).toBe(409);
        expect(r.body.error).toMatch(/No certificado/);
    });

    test('estado inválido: 400 sin llamar a la RPC', async () => {
        const r = await llamarRuta({ method: 'PATCH', url: '/u1/estado', params: { id: 'u1' }, body: { estado: 'volando' }, usuario: ADMIN_PLENO });
        expect(r.status).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });
});

describe('PATCH /:id/categoria — permisos, validación y mapeo de errores', () => {
    test('admin pleno: éxito, envía justificacion y fecha_efectiva a la RPC', async () => {
        crearSupabaseMock({ usuarios_pagados: { nombre_completo: 'Juan', categoria: 'A', tipo_persona: 'jurado' } });
        supabase.rpc.mockResolvedValue({ data: {}, error: null });
        const r = await llamarRuta({
            method: 'PATCH', url: '/u1/categoria', params: { id: 'u1' },
            body: { categoria: 'B', justificacion: 'Buen desempeño', fecha_efectiva: '2026-06-01' }, usuario: ADMIN_PLENO
        });
        expect(r.status).toBe(200);
        expect(supabase.rpc).toHaveBeenCalledWith('cambiar_categoria_usuario_con_historial', expect.objectContaining({
            p_usuario_id: 'u1', p_categoria_nueva: 'B', p_justificacion: 'Buen desempeño', p_fecha_efectiva: '2026-06-01'
        }));
    });

    test('Jefe Deportivo (jefe_area): permitido, igual que admin pleno', async () => {
        crearSupabaseMock({ usuarios_pagados: { nombre_completo: 'Juan', categoria: 'A', tipo_persona: 'jurado' } });
        supabase.rpc.mockResolvedValue({ data: {}, error: null });
        const r = await llamarRuta({ method: 'PATCH', url: '/u1/categoria', params: { id: 'u1' }, body: { categoria: 'B' }, usuario: JEFE_DEPORTIVO });
        expect(r.status).toBe(200);
    });

    test('Comisión Técnica: 403, nunca llama a la RPC', async () => {
        const r = await llamarRuta({
            method: 'PATCH', url: '/u1/categoria', params: { id: 'u1' }, body: { categoria: 'B' },
            usuario: { id: 'a5', nombre: 'Comisión', tipo: 'administrador', rol_evaluacion: 'comision_tecnica' }
        });
        expect(r.status).toBe(403);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('MISMA_CATEGORIA de la RPC se traduce a 400 con mensaje claro', async () => {
        crearSupabaseMock({ usuarios_pagados: { nombre_completo: 'Juan', categoria: 'A', tipo_persona: 'jurado' } });
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'MISMA_CATEGORIA: el usuario ya está en categoría A' } });
        const r = await llamarRuta({ method: 'PATCH', url: '/u1/categoria', params: { id: 'u1' }, body: { categoria: 'A' }, usuario: ADMIN_PLENO });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/ya está en categoría A/);
    });

    test('categoría fuera de A/B/C: 400 sin llamar a la RPC', async () => {
        const r = await llamarRuta({ method: 'PATCH', url: '/u1/categoria', params: { id: 'u1' }, body: { categoria: 'Z' }, usuario: ADMIN_PLENO });
        expect(r.status).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });
});

describe('PATCH /:id/no-certificado y /:id/en-retiro — permisos y validación', () => {
    test('admin pleno activa No certificado con motivo: éxito', async () => {
        crearSupabaseMock({ usuarios_pagados: { nombre_completo: 'Juan', no_certificado: false } });
        supabase.rpc.mockResolvedValue({ data: {}, error: null });
        const r = await llamarRuta({ method: 'PATCH', url: '/u1/no-certificado', params: { id: 'u1' }, body: { activar: true, motivo: 'Documentación vencida' }, usuario: ADMIN_PLENO });
        expect(r.status).toBe(200);
        expect(supabase.rpc).toHaveBeenCalledWith('marcar_condicion_bloqueante_usuario', expect.objectContaining({
            p_usuario_id: 'u1', p_tipo_condicion: 'no_certificado', p_activar: true, p_motivo: 'Documentación vencida'
        }));
    });

    test('Jefe Deportivo (jefe_area) activa En retiro con motivo: éxito, igual que admin pleno', async () => {
        crearSupabaseMock({ usuarios_pagados: { nombre_completo: 'Juan', en_retiro: false } });
        supabase.rpc.mockResolvedValue({ data: {}, error: null });
        const r = await llamarRuta({ method: 'PATCH', url: '/u1/en-retiro', params: { id: 'u1' }, body: { activar: true, motivo: 'Fin de carrera' }, usuario: JEFE_DEPORTIVO });
        expect(r.status).toBe(200);
    });

    test('activar sin motivo: 400 sin llamar a la RPC', async () => {
        const r = await llamarRuta({ method: 'PATCH', url: '/u1/no-certificado', params: { id: 'u1' }, body: { activar: true }, usuario: ADMIN_PLENO });
        expect(r.status).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('revertir (activar:false) no exige motivo', async () => {
        crearSupabaseMock({ usuarios_pagados: { nombre_completo: 'Juan', en_retiro: true } });
        supabase.rpc.mockResolvedValue({ data: {}, error: null });
        const r = await llamarRuta({ method: 'PATCH', url: '/u1/en-retiro', params: { id: 'u1' }, body: { activar: false }, usuario: ADMIN_PLENO });
        expect(r.status).toBe(200);
    });

    test('Director: 403 — soloRolEvaluacion(\'jefe_area\') ya lo rechaza por sí sola (no está en la lista permitida)', async () => {
        const r = await llamarRuta({
            method: 'PATCH', url: '/u1/en-retiro', params: { id: 'u1' }, body: { activar: true, motivo: 'Fin de carrera' },
            usuario: { id: 'a6', nombre: 'Director', tipo: 'administrador', rol_evaluacion: 'director' }
        });
        expect(r.status).toBe(403);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('tipo_condicion inválido devuelto por la RPC se traduce a 500 con el mensaje original', async () => {
        crearSupabaseMock({ usuarios_pagados: { nombre_completo: 'Juan', no_certificado: false } });
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'TIPO_CONDICION_INVALIDO: x' } });
        const r = await llamarRuta({ method: 'PATCH', url: '/u1/no-certificado', params: { id: 'u1' }, body: { activar: true, motivo: 'x' }, usuario: ADMIN_PLENO });
        expect(r.status).toBe(500);
    });
});
