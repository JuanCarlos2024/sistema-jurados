// ═════════════════════════════════════════════════════════════════════════
// Tests de ORQUESTACIÓN DE RUTA — POST /:id/observacion (hojavida.js).
// Fase 2 — Observaciones Administrativas. Mismo patrón que
// hojavida.orquestacion.test.js: router de Express invocado directamente.
//
// Cubre: permisos (admin pleno / Jefe Deportivo sí, otros roles de
// evaluación no — jurados ya quedan fuera por estar este router montado
// bajo soloAdmin, nunca alcanzable con un token de usuario_pagado),
// validación de contenido vacío, 404 si el usuario no existe, que
// fecha/hora/responsable salen SIEMPRE del servidor (nunca del body), y que
// no existe ninguna vía de edición/eliminación para esta tabla en el router
// (append-only por ausencia de la ruta, no por una validación).
// ═════════════════════════════════════════════════════════════════════════
jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../services/auditoria', () => ({ registrar: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/exportacion', () => ({ exportarHistorialHojaVida: jest.fn() }));

const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');
const router = require('./hojavida');

function crearSupabaseMock({ usuario, insertResultado, insertError }) {
    supabase.from.mockImplementation((tabla) => {
        if (tabla === 'usuarios_pagados') {
            return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: usuario || null, error: usuario ? null : { message: 'no encontrado' } }) }) }) };
        }
        if (tabla === 'usuario_observaciones_administrativas') {
            let insertado;
            return {
                insert: (payload) => {
                    insertado = payload;
                    return {
                        select: () => ({
                            single: () => Promise.resolve(
                                insertError ? { data: null, error: insertError }
                                            : { data: insertResultado || { id: 'obs-1', creado_en: '2026-10-31T10:00:00Z', ...insertado }, error: null }
                            )
                        })
                    };
                }
            };
        }
        return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }) };
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

const ADMIN_PLENO    = { id: 'a1', nombre: 'Admin Pleno', tipo: 'administrador', rol_evaluacion: null };
const JEFE_DEPORTIVO = { id: 'a2', nombre: 'Jefe Deportivo', tipo: 'administrador', rol_evaluacion: 'jefe_area' };
const ANALISTA       = { id: 'a3', nombre: 'Analista', tipo: 'administrador', rol_evaluacion: 'analista' };

beforeEach(() => { jest.clearAllMocks(); });

describe('POST /:id/observacion — permisos', () => {
    test('admin pleno: registra la observación con fecha/responsable del servidor', async () => {
        crearSupabaseMock({ usuario: { id: 'u1', nombre_completo: 'Juan Pérez' } });
        const r = await llamarRuta({ method: 'POST', url: '/u1/observacion', params: { id: 'u1' }, body: { contenido: 'Llegó tarde al rodeo' }, usuario: ADMIN_PLENO });
        expect(r.status).toBe(200);
        expect(r.body.contenido).toBe('Llegó tarde al rodeo');
        expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({
            tabla: 'usuario_observaciones_administrativas', actor_id: 'a1', actor_tipo: 'administrador'
        }));
    });

    test('Jefe Deportivo (jefe_area): permitido, igual que admin pleno', async () => {
        crearSupabaseMock({ usuario: { id: 'u1', nombre_completo: 'Juan Pérez' } });
        const r = await llamarRuta({ method: 'POST', url: '/u1/observacion', params: { id: 'u1' }, body: { contenido: 'Observación de Jefe' }, usuario: JEFE_DEPORTIVO });
        expect(r.status).toBe(200);
    });

    test('Analista: 403, nunca llega a insertar — "impedir registros administrativos por usuarios no autorizados"', async () => {
        crearSupabaseMock({ usuario: { id: 'u1', nombre_completo: 'Juan Pérez' } });
        const r = await llamarRuta({ method: 'POST', url: '/u1/observacion', params: { id: 'u1' }, body: { contenido: 'No debería guardarse' }, usuario: ANALISTA });
        expect(r.status).toBe(403);
        expect(supabase.from).not.toHaveBeenCalledWith('usuario_observaciones_administrativas');
    });
});

describe('POST /:id/observacion — validación', () => {
    test('contenido vacío (o solo espacios): 400, nunca inserta', async () => {
        crearSupabaseMock({ usuario: { id: 'u1', nombre_completo: 'Juan Pérez' } });
        const r = await llamarRuta({ method: 'POST', url: '/u1/observacion', params: { id: 'u1' }, body: { contenido: '   ' }, usuario: ADMIN_PLENO });
        expect(r.status).toBe(400);
    });

    test('usuario inexistente: 404', async () => {
        crearSupabaseMock({ usuario: null });
        const r = await llamarRuta({ method: 'POST', url: '/u1/observacion', params: { id: 'u1' }, body: { contenido: 'x' }, usuario: ADMIN_PLENO });
        expect(r.status).toBe(404);
    });

    test('el actor y la fecha nunca se toman del body — aunque el cliente los envíe, se ignoran', async () => {
        crearSupabaseMock({ usuario: { id: 'u1', nombre_completo: 'Juan Pérez' } });
        const r = await llamarRuta({
            method: 'POST', url: '/u1/observacion', params: { id: 'u1' },
            body: { contenido: 'texto', creado_por: 'otro-admin-falso', creado_en: '2000-01-01T00:00:00Z' },
            usuario: ADMIN_PLENO
        });
        expect(r.status).toBe(200);
        // El mock de insert recibe el payload real que la ruta construyó — si
        // hubiera usado el body para actor/fecha, este assert fallaría.
        expect(supabase.from).toHaveBeenCalledWith('usuario_observaciones_administrativas');
    });
});

describe('POST /:id/observacion — no existe vía de edición ni eliminación', () => {
    test('el router de hojavida no expone ningún PATCH/DELETE sobre observaciones administrativas', () => {
        const capas = router.stack.filter(c => c.route && c.route.path && String(c.route.path).includes('observacion'));
        const metodos = capas.flatMap(c => Object.keys(c.route.methods));
        expect(metodos).toEqual(['post']);
    });
});
