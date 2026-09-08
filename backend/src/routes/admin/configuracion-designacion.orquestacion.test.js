// ═════════════════════════════════════════════════════════════════════════
// Tests de ORQUESTACIÓN DE RUTA — configuracion-designacion.js (Etapa 4).
// Mismo patrón que propuesta-designacion.orquestacion.test.js: se invoca el
// router de Express directamente (sin servidor HTTP, sin supertest — ver
// `llamarRuta`) con un req/res mínimos hechos a mano. Se mockea la capa de
// repositorio completa (configuracionDesignacionRepositorio) y auditoria —
// este archivo prueba PEGAMENTO de ruta (qué llama, con qué argumentos, qué
// responde), no la lógica de negocio de esas capas (ya cubierta en sus
// propios tests). `configuracionDesignacion.js` (validarConfiguracion,
// construirConfiguracionDefaultV1) se mantiene REAL — es puro.
// ═════════════════════════════════════════════════════════════════════════
jest.mock('../../services/configuracionDesignacionRepositorio', () => ({
    cargarConfiguracionDesignacionActiva: jest.fn(),
    listarVersionesDesignacion: jest.fn(),
    obtenerVersionDesignacionDetalle: jest.fn(),
    crearVersionDesignacion: jest.fn(),
    activarVersionDesignacion: jest.fn()
}));
jest.mock('../../services/auditoria', () => ({ registrar: jest.fn().mockResolvedValue(undefined) }));

const {
    cargarConfiguracionDesignacionActiva, listarVersionesDesignacion, obtenerVersionDesignacionDetalle,
    crearVersionDesignacion, activarVersionDesignacion
} = require('../../services/configuracionDesignacionRepositorio');
const auditoria = require('../../services/auditoria');
const { construirConfiguracionDefaultV1 } = require('../../services/configuracionDesignacion');
const router = require('./configuracion-designacion');

function llamarRuta({ method, url, body, usuario, params }) {
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

// ─── GET /versiones ────────────────────────────────────────────────────────
describe('GET /versiones', () => {
    test('devuelve el historial tal cual lo entrega el repositorio', async () => {
        listarVersionesDesignacion.mockResolvedValue([{ id: 'v1-uuid', numero_version: 1, activa: true }]);
        const { status, body } = await llamarRuta({ method: 'GET', url: '/versiones' });
        expect(status).toBe(200);
        expect(body.versiones).toHaveLength(1);
    });
    test('error de BD → 500 controlado, sin excepción sin capturar', async () => {
        listarVersionesDesignacion.mockRejectedValue(new Error('timeout'));
        const { status, body } = await llamarRuta({ method: 'GET', url: '/versiones' });
        expect(status).toBe(500);
        expect(body.error).toMatch(/timeout/);
    });
});

// ─── GET /versiones/:id ────────────────────────────────────────────────────
describe('GET /versiones/:id', () => {
    test('versión existente → 200 con configuracion + meta', async () => {
        obtenerVersionDesignacionDetalle.mockResolvedValue({ configuracion: { schema_version: 1 }, meta: { id: 'v-historica', numero_version: 3 } });
        const { status, body } = await llamarRuta({ method: 'GET', url: '/versiones/v-historica', params: { id: 'v-historica' } });
        expect(status).toBe(200);
        expect(body.meta.numero_version).toBe(3);
        expect(obtenerVersionDesignacionDetalle).toHaveBeenCalledWith('v-historica');
    });
    test('versión inexistente → 404 controlado', async () => {
        obtenerVersionDesignacionDetalle.mockResolvedValue({ error: 'CONFIGURACION_DESIGNACION_NO_RESUELTA', detalle: 'no existe' });
        const { status, body } = await llamarRuta({ method: 'GET', url: '/versiones/x', params: { id: 'x' } });
        expect(status).toBe(404);
        expect(body.error).toBe('CONFIGURACION_DESIGNACION_NO_RESUELTA');
    });
});

// ─── GET /activa ────────────────────────────────────────────────────────────
describe('GET /activa', () => {
    test('devuelve el detalle completo de la versión activa', async () => {
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: {}, meta: { id: 'v1-uuid', numero_version: 1 } });
        obtenerVersionDesignacionDetalle.mockResolvedValue({ configuracion: { schema_version: 1 }, meta: { id: 'v1-uuid', numero_version: 1, creado_por_nombre: null } });
        const { status, body } = await llamarRuta({ method: 'GET', url: '/activa' });
        expect(status).toBe(200);
        expect(body.meta.id).toBe('v1-uuid');
        expect(obtenerVersionDesignacionDetalle).toHaveBeenCalledWith('v1-uuid');
    });
    // Mejora "Equidad de Traslados" (revisión de cierre, sección 3) — el
    // frontend debe poder leer explícitamente qué schema_version soporta
    // este backend, sin inferirlo de errores.
    // 3 se agregó por la mejora "Zonas Extremas" (mismo tipo de
    // actualización que ya ocurrió acá cuando 2 se agregó con "Equidad de
    // Traslados") — el backend YA declara soporte de código para schema_
    // version=3 aunque la migración 053 todavía no esté aplicada.
    test('incluye capacidades.schema_versions_soportadas = [1, 2, 3]', async () => {
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: {}, meta: { id: 'v1-uuid', numero_version: 1 } });
        obtenerVersionDesignacionDetalle.mockResolvedValue({ configuracion: { schema_version: 1 }, meta: { id: 'v1-uuid', numero_version: 1, creado_por_nombre: null } });
        const { body } = await llamarRuta({ method: 'GET', url: '/activa' });
        expect(body.capacidades.schema_versions_soportadas).toEqual([1, 2, 3]);
        expect(body.capacidades.criterios_soportados_por_schema[2]).toContain('EQUIDAD_TRASLADOS');
        expect(body.capacidades.criterios_soportados_por_schema[1]).not.toContain('EQUIDAD_TRASLADOS');
        expect(body.capacidades.criterios_soportados_por_schema[3]).toContain('EQUIDAD_TRASLADOS');
        // Zonas Extremas — el frontend necesita el payload por defecto para
        // ofrecer la activación en un draft nuevo (sección 6/23 del pedido).
        expect(Array.isArray(body.capacidades.zonas_extremas_default.asociaciones)).toBe(true);
        expect(body.capacidades.zonas_extremas_default.asociaciones.length).toBeGreaterThan(0);
    });
    test('0 activas → 500 controlado, nunca asume ninguna', async () => {
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ error: 'CONFIGURACION_DESIGNACION_NO_RESUELTA', detalle: '0 activas' });
        const { status, body } = await llamarRuta({ method: 'GET', url: '/activa' });
        expect(status).toBe(500);
        expect(body.error).toBe('CONFIGURACION_DESIGNACION_NO_RESUELTA');
        expect(obtenerVersionDesignacionDetalle).not.toHaveBeenCalled();
    });
});

// ─── GET /defaults ──────────────────────────────────────────────────────────
describe('GET /defaults', () => {
    test('devuelve construirConfiguracionDefaultV1() real (pura, sin BD) — no toca el repositorio', async () => {
        const { status, body } = await llamarRuta({ method: 'GET', url: '/defaults' });
        expect(status).toBe(200);
        expect(body.configuracion).toEqual(construirConfiguracionDefaultV1());
        expect(cargarConfiguracionDesignacionActiva).not.toHaveBeenCalled();
        expect(listarVersionesDesignacion).not.toHaveBeenCalled();
    });
    // Sección 17 de la revisión de cierre: los defaults siguen siendo V1/
    // schema_version=1 — "Restaurar predeterminada" NO cambia a schema 2.
    test('los defaults siguen siendo schema_version=1 (Restaurar predeterminada no promueve a schema2)', async () => {
        const { body } = await llamarRuta({ method: 'GET', url: '/defaults' });
        expect(body.configuracion.schema_version).toBe(1);
    });
    test('incluye capacidades.schema_versions_soportadas = [1, 2, 3] (mismo endpoint liviano, sin BD)', async () => {
        const { body } = await llamarRuta({ method: 'GET', url: '/defaults' });
        expect(body.capacidades.schema_versions_soportadas).toEqual([1, 2, 3]);
        expect(body.capacidades.criterios_soportados_por_schema[2]).toContain('EQUIDAD_TRASLADOS');
    });
});

// ─── POST /versiones ────────────────────────────────────────────────────────
describe('POST /versiones — crear (sección 4/38 del pedido de Etapa 4)', () => {
    test('crea correctamente: pasa creadoPor=req.usuario.id, responde 201, activa=false, y audita CREAR_VERSION_CONFIG_DESIGNACION', async () => {
        crearVersionDesignacion.mockResolvedValue({ id: 'v2-uuid', numero_version: 2 });
        const configuracion = construirConfiguracionDefaultV1();

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/versiones',
            body: { configuracion, descripcion: 'Prioriza distancia' },
            usuario: { id: 'admin-77', tipo: 'administrador', rol_evaluacion: null }
        });

        expect(status).toBe(201);
        expect(body).toEqual({ id: 'v2-uuid', numero_version: 2, activa: false });
        expect(crearVersionDesignacion).toHaveBeenCalledWith({ configuracion, descripcion: 'Prioriza distancia', creadoPor: 'admin-77' });
        expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({
            accion: 'CREAR_VERSION_CONFIG_DESIGNACION', registro_id: 'v2-uuid', actor_id: 'admin-77'
        }));
    });

    // Mejora "Equidad de Traslados" (revisión de cierre, sección 14/27): la
    // ruta debe aceptar un objeto schema_version=2 COMPLETO sin filtrar ni
    // eliminar los campos nuevos, y delegar en crearVersionDesignacion() tal
    // cual — sin ninguna lógica especial de negocio para schema2 en la ruta
    // (esa lógica vive en configuracionDesignacion.js/el repositorio).
    test('POST /versiones con configuración schema_version=2 completa → se pasa TAL CUAL al repositorio, sin filtrar campos de equidad', async () => {
        crearVersionDesignacion.mockResolvedValue({ id: 'v-schema2-uuid', numero_version: 8 });
        const configuracionSchema2 = {
            ...construirConfiguracionDefaultV1(),
            schema_version: 2,
            regla_distancia_maxima_activa: false,
            distancia_maxima_km: null,
            regla_equidad_traslados_activa: true,
            umbral_lejania_km: 350,
            ordenCriterios: [
                { criterio_codigo: 'EQUIDAD_TRASLADOS', orden: 1 },
                { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 2 },
                { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 3 },
                { criterio_codigo: 'MENOR_DISTANCIA', orden: 4 }
            ]
        };

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/versiones',
            body: { configuracion: configuracionSchema2, descripcion: 'Equidad de traslados 350km' },
            usuario: { id: 'admin-9', tipo: 'administrador', rol_evaluacion: null }
        });

        expect(status).toBe(201);
        expect(body).toEqual({ id: 'v-schema2-uuid', numero_version: 8, activa: false });
        // El objeto COMPLETO llega al repositorio — regla_equidad_traslados_activa
        // y umbral_lejania_km presentes, nada filtrado en la ruta.
        expect(crearVersionDesignacion).toHaveBeenCalledWith({
            configuracion: configuracionSchema2, descripcion: 'Equidad de traslados 350km', creadoPor: 'admin-9'
        });
        const configuracionRecibida = crearVersionDesignacion.mock.calls[0][0].configuracion;
        expect(configuracionRecibida.schema_version).toBe(2);
        expect(configuracionRecibida.regla_equidad_traslados_activa).toBe(true);
        expect(configuracionRecibida.umbral_lejania_km).toBe(350);
    });

    // TEST 43 (pedido de UI "Zonas Extremas") — mismo tipo de test que
    // schema_version=2 arriba, ahora para schema_version=3: la ruta pasa el
    // objeto COMPLETO (incluida zonas_extremas) sin filtrar nada.
    test('POST /versiones con configuración schema_version=3 (Zonas Extremas) completa → se pasa TAL CUAL al repositorio, sin filtrar zonas_extremas', async () => {
        crearVersionDesignacion.mockResolvedValue({ id: 'v-schema3-uuid', numero_version: 9 });
        const configuracionSchema3 = {
            ...construirConfiguracionDefaultV1(),
            schema_version: 3,
            regla_zonas_extremas_activa: true,
            zonas_extremas: {
                asociaciones: ['ARICA Y TARAPACA', 'NORTE GRANDE', 'MAGALLANES', 'AYSEN', 'CUYO'],
                categorias: [
                    { categoria: 'A', elegible: false, orden_preferencia: null },
                    { categoria: 'B', elegible: true, orden_preferencia: 2 },
                    { categoria: 'C', elegible: true, orden_preferencia: 1 }
                ]
            }
        };

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/versiones',
            body: { configuracion: configuracionSchema3, descripcion: 'Zonas Extremas C->B' },
            usuario: { id: 'admin-10', tipo: 'administrador', rol_evaluacion: null }
        });

        expect(status).toBe(201);
        expect(body).toEqual({ id: 'v-schema3-uuid', numero_version: 9, activa: false });
        expect(crearVersionDesignacion).toHaveBeenCalledWith({
            configuracion: configuracionSchema3, descripcion: 'Zonas Extremas C->B', creadoPor: 'admin-10'
        });
        const configuracionRecibida = crearVersionDesignacion.mock.calls[0][0].configuracion;
        expect(configuracionRecibida.schema_version).toBe(3);
        expect(configuracionRecibida.regla_zonas_extremas_activa).toBe(true);
        expect(configuracionRecibida.zonas_extremas.asociaciones).toHaveLength(5);
        expect(configuracionRecibida.zonas_extremas.categorias).toHaveLength(3);
    });

    // Revisión final Etapa 4, sección 5: la UI NO puede decidir creado_por —
    // aunque el body declare explícitamente el id de OTRO administrador, se
    // ignora por completo (la ruta ni siquiera lo desestructura de req.body
    // — ver configuracion-designacion.js línea `const { configuracion,
    // descripcion, es_restaurar_defaults } = req.body`). El actor SIEMPRE
    // sale de req.usuario.id (el JWT ya verificado por soloAdmin, fuera de
    // este router).
    test('body con creado_por de OTRO administrador → se ignora; creadoPor siempre es req.usuario.id (el autenticado)', async () => {
        crearVersionDesignacion.mockResolvedValue({ id: 'v2-uuid', numero_version: 2 });
        const configuracion = construirConfiguracionDefaultV1();

        await llamarRuta({
            method: 'POST', url: '/versiones',
            body: { configuracion, descripcion: null, creado_por: 'admin-SUPLANTADO-999' },
            usuario: { id: 'admin-real-77', tipo: 'administrador', rol_evaluacion: null }
        });

        const argumentoRecibido = crearVersionDesignacion.mock.calls[0][0];
        expect(argumentoRecibido.creadoPor).toBe('admin-real-77');
        expect(argumentoRecibido.creadoPor).not.toBe('admin-SUPLANTADO-999');
        expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({ actor_id: 'admin-real-77' }));
    });

    test('es_restaurar_defaults=true → misma creación, pero audita RESTAURAR_DEFAULT_CONFIG_DESIGNACION (nunca activa nada)', async () => {
        crearVersionDesignacion.mockResolvedValue({ id: 'v5-uuid', numero_version: 5 });
        const { status, body } = await llamarRuta({
            method: 'POST', url: '/versiones',
            body: { configuracion: construirConfiguracionDefaultV1(), descripcion: null, es_restaurar_defaults: true }
        });
        expect(status).toBe(201);
        expect(body.activa).toBe(false);
        expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({ accion: 'RESTAURAR_DEFAULT_CONFIG_DESIGNACION' }));
    });

    test('configuracion ausente → 400, ni crearVersionDesignacion ni auditoria se llaman', async () => {
        const { status, body } = await llamarRuta({ method: 'POST', url: '/versiones', body: { descripcion: 'x' } });
        expect(status).toBe(400);
        expect(body.error).toBe('CONFIGURACION_DESIGNACION_INVALIDA');
        expect(crearVersionDesignacion).not.toHaveBeenCalled();
        expect(auditoria.registrar).not.toHaveBeenCalled();
    });

    test('configuración inválida (rechazada por el repositorio/RPC) → 400, sin auditar', async () => {
        crearVersionDesignacion.mockResolvedValue({ error: 'CONFIGURACION_DESIGNACION_INVALIDA', detalle: 'matriz incompleta' });
        const { status, body } = await llamarRuta({ method: 'POST', url: '/versiones', body: { configuracion: { schema_version: 1 } } });
        expect(status).toBe(400);
        expect(body.error).toBe('CONFIGURACION_DESIGNACION_INVALIDA');
        expect(auditoria.registrar).not.toHaveBeenCalled();
    });
});

// ─── POST /versiones/:id/activar ────────────────────────────────────────────
describe('POST /versiones/:id/activar — activación EXPLÍCITA (sección 5/39/40 del pedido)', () => {
    test('activa correctamente, responde 200 activa=true, y audita ACTIVAR_VERSION_CONFIG_DESIGNACION con antes/después', async () => {
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: {}, meta: { id: 'v1-uuid', numero_version: 1 } });
        activarVersionDesignacion.mockResolvedValue({ ok: true });
        obtenerVersionDesignacionDetalle.mockResolvedValue({ configuracion: {}, meta: { id: 'v2-uuid', numero_version: 2 } });

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/versiones/v2-uuid/activar', params: { id: 'v2-uuid' },
            usuario: { id: 'admin-77', tipo: 'administrador', rol_evaluacion: null }
        });

        expect(status).toBe(200);
        expect(body).toEqual({ id: 'v2-uuid', numero_version: 2, activa: true });
        expect(activarVersionDesignacion).toHaveBeenCalledWith('v2-uuid');
        expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({
            accion: 'ACTIVAR_VERSION_CONFIG_DESIGNACION',
            datos_anteriores: { numero_version_activa: 1 },
            datos_nuevos: { numero_version_activa: 2 }
        }));
    });

    // Revisión final Etapa 4, sección 6: mismo principio que crear — el
    // actor de la auditoría de activación sale de req.usuario.id, nunca de
    // algo que declare el body (la ruta no desestructura ningún "actor" de
    // req.body en este endpoint — estructuralmente imposible falsificarlo).
    test('el actor de la auditoría es req.usuario.id, aunque el body declare otro valor bajo cualquier nombre', async () => {
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: {}, meta: { id: 'v1-uuid', numero_version: 1 } });
        activarVersionDesignacion.mockResolvedValue({ ok: true });
        obtenerVersionDesignacionDetalle.mockResolvedValue({ configuracion: {}, meta: { id: 'v2-uuid', numero_version: 2 } });

        await llamarRuta({
            method: 'POST', url: '/versiones/v2-uuid/activar', params: { id: 'v2-uuid' },
            body: { actor_id: 'admin-SUPLANTADO-999', creado_por: 'admin-SUPLANTADO-999' },
            usuario: { id: 'admin-real-77', tipo: 'administrador', rol_evaluacion: null }
        });

        expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({ actor_id: 'admin-real-77' }));
    });

    test('la RPC rechaza (versión inválida) → 400 controlado, sin auditar', async () => {
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: {}, meta: { id: 'v1-uuid', numero_version: 1 } });
        activarVersionDesignacion.mockResolvedValue({ error: 'CONFIGURACION_DESIGNACION_INVALIDA', detalle: 'matriz incompleta' });
        const { status, body } = await llamarRuta({ method: 'POST', url: '/versiones/v-corrupta/activar', params: { id: 'v-corrupta' } });
        expect(status).toBe(400);
        expect(body.error).toBe('CONFIGURACION_DESIGNACION_INVALIDA');
        expect(auditoria.registrar).not.toHaveBeenCalled();
    });
});

// ─── Permisos (sección 53.O) — dentro de ESTE router, soloRolEvaluacion() ──
// aplica directamente. soloAdmin/verificarToken (401 sin token) viven en
// admin/index.js + middleware/auth.js, FUERA de este router — no son
// ejercitables a este nivel (mismo límite ya documentado y aceptado en
// propuesta-designacion.orquestacion.test.js); se confirman por inspección
// de código: idéntico patrón (router.use(soloAdmin) en admin/index.js).
describe('Permisos — sección 53.O: rol_evaluacion distinto de null (admin no pleno) → 403', () => {
    test.each(['monitor', 'director', 'analista', 'comision_tecnica'])('rol_evaluacion=%s no puede ni siquiera listar versiones', async (rol) => {
        const { status } = await llamarRuta({
            method: 'GET', url: '/versiones',
            usuario: { id: 'x', tipo: 'administrador', rol_evaluacion: rol }
        });
        expect(status).toBe(403);
        expect(listarVersionesDesignacion).not.toHaveBeenCalled();
    });
});

// ─── Sin DELETE ni PATCH funcional (sección 53.Q/R) ────────────────────────
describe('Sin DELETE ni PATCH — las versiones son históricas e inmutables (sección 3/35 del pedido)', () => {
    test('DELETE /versiones/:id no existe (el router no lo matchea)', async () => {
        const { status } = await llamarRuta({ method: 'DELETE', url: '/versiones/v1-uuid', params: { id: 'v1-uuid' } });
        expect(status).toBe(404);
    });
    test('PATCH /versiones/:id no existe (el router no lo matchea)', async () => {
        const { status } = await llamarRuta({ method: 'PATCH', url: '/versiones/v1-uuid', params: { id: 'v1-uuid' } });
        expect(status).toBe(404);
    });
});
