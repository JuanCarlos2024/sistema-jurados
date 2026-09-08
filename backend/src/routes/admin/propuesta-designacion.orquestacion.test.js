// ═════════════════════════════════════════════════════════════════════════
// Tests de ORQUESTACIÓN DE RUTA — Etapa 3, revisión final (GAP explícito del
// pedido: "verificado en parte por inspección de código, falta cobertura
// ejecutable a nivel de orquestación").
//
// Este es el PRIMER archivo del proyecto que ejercita un router de Express
// directamente. NO se agrega `supertest` (ni ninguna dependencia nueva) ni
// se levanta un servidor HTTP real — eso sería sobre-diseño para lo que hace
// falta probar aquí. En vez de eso, se invoca el router (que en Express 4 es
// simplemente una función `(req, res, next)`) con un `req`/`res` mínimos
// hechos a mano (`llamarRuta`, más abajo) — la misma técnica interna que usa
// supertest, sin la capa HTTP. NINGÚN código de producción fue tocado ni
// reestructurado para esto: se importa `./propuesta-designacion` tal cual
// existe.
//
// Qué se mockea y qué se mantiene REAL:
//   - `../../config/supabase`               → mock genérico por tabla (igual
//     patrón que configuracionDesignacionRepositorio.test.js, extendido con
//     soporte a insert/update y a secuencias de respuestas por tabla, porque
//     una misma tabla se consulta más de una vez con intención distinta
//     dentro de un mismo request — ver `crearSupabaseMock` más abajo).
//   - `../../services/motorPropuestaDesignacion` → SOLO se reemplazan
//     `cargarDatosMotor`/`ejecutarSimulacion`/`generarSimulacion`/
//     `evaluarCandidatoDirecto` por jest.fn() controlados; el resto del
//     módulo (`TOP_N_TODOS_LOS_CANDIDATOS`, `filtrarRodeosSinJuradoEfectivo`)
//     se mantiene REAL vía jest.requireActual, para poder comparar contra la
//     constante real de producción (sección 15/13 del pedido).
//   - `../../services/configuracionDesignacionRepositorio` → mock completo
//     (`cargarConfiguracionDesignacionActiva`/`PorId`) — YA está probado a
//     fondo en su propio archivo; acá solo importa qué llama la RUTA y con
//     qué argumento, nunca su lógica interna.
//   - `../../services/previewIntegridad` → NUNCA se mockea. Se usa el firmado
//     HMAC REAL — es la única forma honesta de probar que el
//     configuracion_version_id firmado por /dry-run efectivamente sobrevive,
//     intacto, hasta /preview/* y hasta el guardado, y que un token legacy
//     se rechaza de verdad (no una simulación de eso).
//   - `../../services/propuestaDesignacion` (obtenerJuradoEfectivo,
//     decidirEstadoSeleccion, detectarConflictoInterno, etc.) → REAL, son
//     funciones puras ya cubiertas por sus propios tests; acá solo hace
//     falta que el pegamento las use bien, no volver a probarlas.
//   - `../../services/auditoria` → NO se mockea aparte: sus escrituras pasan
//     por el mismo `supabase` mockeado (tabla 'auditoria', con respuesta por
//     defecto benigna) — evita duplicar un mock separado sin necesidad.
//
// Dos objetos-marca (`CONFIG_V1`/`CONFIG_V2`, más abajo) permiten aserciones
// por IDENTIDAD DE REFERENCIA (===) sobre qué configuración exacta llegó al
// motor — más fuerte que comparar solo el id de metadata.
// ═════════════════════════════════════════════════════════════════════════
const express = require('express');
const { calcularBloqueRodeo } = require('../../services/feriados'); // REAL, puro — solo para armar fixtures con forma real

jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../services/motorPropuestaDesignacion', () => {
    const real = jest.requireActual('../../services/motorPropuestaDesignacion');
    return {
        ...real,
        cargarDatosMotor: jest.fn(),
        ejecutarSimulacion: jest.fn(),
        generarSimulacion: jest.fn(),
        evaluarCandidatoDirecto: jest.fn()
    };
});
jest.mock('../../services/configuracionDesignacionRepositorio', () => ({
    cargarConfiguracionDesignacionActiva: jest.fn(),
    cargarConfiguracionDesignacionPorId: jest.fn()
}));

const supabase = require('../../config/supabase');
const { cargarDatosMotor, ejecutarSimulacion, generarSimulacion, evaluarCandidatoDirecto, TOP_N_TODOS_LOS_CANDIDATOS } = require('../../services/motorPropuestaDesignacion');
const { cargarConfiguracionDesignacionActiva, cargarConfiguracionDesignacionPorId } = require('../../services/configuracionDesignacionRepositorio');
const { firmarPreview, verificarPreviewToken } = require('../../services/previewIntegridad'); // REAL, sin mock
const { construirConfiguracionDefaultV1 } = require('../../services/configuracionDesignacion'); // REAL, puro
const router = require('./propuesta-designacion');

// ─── Objetos-marca: identidad de referencia (===), CON forma real de V1 ───
// (revisión final Etapa 4, sección 15/19: el resumen del dry-run debe traer
// valores REALES de distancia/orden — no solo un objeto vacío que "pasaría"
// aunque el backend no los propagara). `marca` se mantiene para que las
// aserciones toBe(CONFIG_V1) sigan siendo por identidad de referencia.
const CONFIG_V1 = Object.freeze({ ...construirConfiguracionDefaultV1(), marca: 'CONFIG_V1' });
const CONFIG_V2 = Object.freeze({
    ...construirConfiguracionDefaultV1(),
    distancia_maxima_km: 450,
    ordenCriterios: [
        { criterio_codigo: 'MENOR_DISTANCIA', orden: 1 },
        { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 2 },
        { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 3 }
    ],
    marca: 'CONFIG_V2'
});
const META_V1 = { id: 'v1-uuid', numero_version: 1, schema_version: 1 };
const META_V2 = { id: 'v2-uuid', numero_version: 2, schema_version: 1 };

// ─── Invoca el router de Express directamente, sin servidor HTTP ni ──────
// supertest — construye un req/res mínimos y llama `router(req, res, next)`.
function llamarRuta({ method, url, body, usuario }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url,
            body: body || {}, query: {}, params: {}, headers: {},
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
            else resolve({ status: 404, body: { error: 'ruta no encontrada por el router (posible cambio de path no reflejado en el test)' } });
        });
    });
}

// ─── Mock genérico de Supabase por tabla — igual patrón que ──────────────
// configuracionDesignacionRepositorio.test.js, extendido: soporta
// insert()/update() (capturando el payload para aserciones) y respuestas en
// SECUENCIA por tabla (un array se consume una respuesta por llamada; la
// última se repite si se agotan) porque una misma tabla puede consultarse
// más de una vez con intención distinta dentro de un mismo request (ej.
// 'propuestas_designacion_detalle': primero el detalle, después "otras
// filas"). Tabla no configurada → { data: [], error: null } por defecto
// (cubre 'auditoria' sin configuración explícita en cada test).
function crearSupabaseMock(porTabla) {
    const llamadas = {}; // tabla -> { inserts: [], updates: [] }
    const consumir = (tabla) => {
        const entrada = porTabla[tabla];
        if (entrada === undefined) return { data: [], error: null };
        if (Array.isArray(entrada)) return entrada.length > 1 ? entrada.shift() : entrada[0];
        return entrada;
    };
    supabase.from.mockImplementation((tabla) => {
        llamadas[tabla] = llamadas[tabla] || { inserts: [], updates: [] };
        const chain = {
            select: () => chain, eq: () => chain, neq: () => chain, in: () => chain,
            ilike: () => chain, order: () => chain, limit: () => chain, range: () => chain,
            insert: (payload) => { llamadas[tabla].inserts.push(payload); return chain; },
            update: (payload) => { llamadas[tabla].updates.push(payload); return chain; },
            single: () => chain, maybeSingle: () => chain,
            then: (resolve, reject) => Promise.resolve(consumir(tabla)).then(resolve, reject)
        };
        return chain;
    });
    return llamadas;
}

beforeEach(() => {
    jest.clearAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════
// 2. POST /dry-run — carga la config ACTIVA, la pasa al motor en la
//    posición correcta, y la firma en el preview_token.
// ═════════════════════════════════════════════════════════════════════════
describe('POST /dry-run', () => {
    test('carga configuración activa (V1), llama generarSimulacion(rodeoIds, topN, configuracion) en ese orden, firma V1 en el token y la devuelve en la respuesta', async () => {
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        generarSimulacion.mockResolvedValue({
            resultados: [{ rodeo_id: 'r1', estado: 'PROPUESTO', jurado_propuesto: { jurado_id: 'j1' } }],
            resumen: {}, modo: 'DRY_RUN'
        });
        crearSupabaseMock({ temporadas: { data: { id: 'temp-1' }, error: null } });

        const { status, body } = await llamarRuta({ method: 'POST', url: '/dry-run', body: { rodeo_ids: ['r1'] } });

        expect(status).toBe(200);
        // Posición de argumentos — EXACTAMENTE el problema detectado al
        // cierre de Etapa 2: rodeoIds, topN, configuracion, en ese orden.
        expect(generarSimulacion).toHaveBeenCalledWith(['r1'], 5, CONFIG_V1);
        expect(typeof body.preview_token).toBe('string');
        const snapshot = verificarPreviewToken(body.preview_token);
        expect(snapshot).not.toBeNull();
        expect(snapshot.configuracion_version_id).toBe('v1-uuid');
        // Etapa 4: la respuesta ahora también trae el resumen (regla/
        // distancia/orden de criterios) ADEMÁS de META_V1 — toMatchObject en
        // vez de toEqual porque el resumen es un superconjunto, nunca quita nada.
        expect(body.configuracion).toMatchObject(META_V1);
        // Revisión final Etapa 4, sección 15: el PREVIEW INICIAL (la propia
        // respuesta de /dry-run, ANTES de llamar a /preview/candidatos) ya
        // debe traer valores REALES — nunca solo id/numero_version/schema_version.
        // Si el backend dejara de propagar esto, este assert (no solo el
        // toHaveProperty anterior) rompería.
        expect(body.configuracion.regla_distancia_maxima_activa).toBe(true);
        expect(body.configuracion.distancia_maxima_km).toBe(600);
        expect(body.configuracion.orden_criterios_codigos).toEqual(
            ['PRIORIDAD_CATEGORIA', 'MENOS_DESIGNACIONES_TEMPORADA', 'MENOR_DISTANCIA']
        );
    });

    test('con una config activa hipotética distinta (V2: 450km, distancia primero) — el resumen del dry-run refleja ESOS valores reales, nunca los de V1', async () => {
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: CONFIG_V2, meta: META_V2 });
        generarSimulacion.mockResolvedValue({ resultados: [], resumen: {}, modo: 'DRY_RUN' });
        crearSupabaseMock({ temporadas: { data: { id: 'temp-1' }, error: null } });

        const { body } = await llamarRuta({ method: 'POST', url: '/dry-run', body: { rodeo_ids: ['r1'] } });

        expect(body.configuracion.distancia_maxima_km).toBe(450);
        expect(body.configuracion.orden_criterios_codigos[0]).toBe('MENOR_DISTANCIA');
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 3. POST /dry-run SIN configuración activa resuelta.
// ═════════════════════════════════════════════════════════════════════════
describe('POST /dry-run sin configuración activa', () => {
    test('CONFIGURACION_DESIGNACION_NO_RESUELTA → el motor NO se ejecuta, no se genera token, respuesta controlada', async () => {
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ error: 'CONFIGURACION_DESIGNACION_NO_RESUELTA', detalle: 'ninguna activa' });

        const { status, body } = await llamarRuta({ method: 'POST', url: '/dry-run', body: { rodeo_ids: ['r1'] } });

        expect(status).toBe(500);
        expect(body.error).toBe('CONFIGURACION_DESIGNACION_NO_RESUELTA');
        expect(generarSimulacion).not.toHaveBeenCalled();
        expect(body.preview_token).toBeUndefined();
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 4. POST /preview/candidatos — usa la versión DEL TOKEN (V1), nunca la
//    activa del momento (V2 hipotética) — cubre también la sección 12
//    (versión inactiva histórica válida en un flujo real, no solo en el
//    repositorio: acá V1 "ya no activa" se resuelve igual de bien que
//    cualquier otra, porque cargarConfiguracionDesignacionPorId no mira
//    'activa' — el mismo test alcanza ambas secciones sin duplicar setup).
// ═════════════════════════════════════════════════════════════════════════
describe('POST /preview/candidatos — usa la versión firmada en el token, no la activa', () => {
    test('token firmado con V1; activa actual (hipotética) es V2 — se usa V1 para ejecutarSimulacion, activa nunca se consulta', async () => {
        const tokenV1 = firmarPreview({
            temporada_id: 't1', configuracion_version_id: 'v1-uuid',
            rodeos: [{ rodeo_id: 'r1', estado: 'PROPUESTO', jurado_id_propuesto: 'j1' }]
        });
        // Solo 'v1-uuid' resuelve — si la ruta llamara por error a la activa
        // o pidiera 'v2-uuid', esto rompe el test en vez de esconderlo.
        cargarConfiguracionDesignacionPorId.mockImplementation(async (id) => {
            if (id === 'v1-uuid') return { configuracion: CONFIG_V1, meta: META_V1 };
            return { error: 'CONFIGURACION_DESIGNACION_NO_RESUELTA', detalle: `id inesperado en este test: ${id}` };
        });
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: CONFIG_V2, meta: META_V2 });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-05-01', asociacion: 'Asoc', duracion_dias: 1 }]]) });
        ejecutarSimulacion.mockReturnValue({ resultados: [{ estado: 'PROPUESTO', top_candidatos: [], descartados: [], candidatos_evaluados: 7 }] });

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/preview/candidatos',
            body: {
                rodeo_id: 'r1', preview_token: tokenV1,
                estado_temporal: [{ rodeo_id: 'r1', estado_revision: 'PENDIENTE', jurado_id_seleccionado: null }]
            }
        });

        expect(status).toBe(200);
        expect(body.candidatos_evaluados).toBe(7);
        expect(cargarConfiguracionDesignacionPorId).toHaveBeenCalledWith('v1-uuid');
        expect(cargarConfiguracionDesignacionActiva).not.toHaveBeenCalled();
        expect(ejecutarSimulacion).toHaveBeenCalledTimes(1);
        const [, topNUsado, configUsada] = ejecutarSimulacion.mock.calls[0];
        expect(topNUsado).toBe(TOP_N_TODOS_LOS_CANDIDATOS);
        expect(configUsada).toBe(CONFIG_V1); // identidad de referencia — nunca CONFIG_V2
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 5. POST /preview/seleccionar — misma garantía, para evaluarCandidatoDirecto.
// ═════════════════════════════════════════════════════════════════════════
describe('POST /preview/seleccionar — usa la versión firmada en el token, no la activa', () => {
    test('token firmado con V1; activa actual (hipotética) es V2 — evaluarCandidatoDirecto recibe V1', async () => {
        const tokenV1 = firmarPreview({
            temporada_id: 't1', configuracion_version_id: 'v1-uuid',
            rodeos: [{ rodeo_id: 'r1', estado: 'PROPUESTO', jurado_id_propuesto: 'j1' }]
        });
        cargarConfiguracionDesignacionPorId.mockImplementation(async (id) => {
            if (id === 'v1-uuid') return { configuracion: CONFIG_V1, meta: META_V1 };
            return { error: 'CONFIGURACION_DESIGNACION_NO_RESUELTA', detalle: `id inesperado: ${id}` };
        });
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: CONFIG_V2, meta: META_V2 });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-05-01', asociacion: 'Asoc', duracion_dias: 1 }]]) });
        evaluarCandidatoDirecto.mockReturnValue({
            evaluacion: { causas: [], distanciaKm: 12, jurado: { id: 'j1', nombre_completo: 'Juan Pérez', categoria: 'A', asociacion: 'Asoc' } }
        });

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/preview/seleccionar',
            body: {
                rodeo_id: 'r1', jurado_id: 'j1', preview_token: tokenV1,
                estado_temporal: [{ rodeo_id: 'r1', estado_revision: 'PENDIENTE', jurado_id_seleccionado: null }]
            }
        });

        expect(status).toBe(200);
        expect(body.destino.jurado_id_seleccionado).toBe('j1');
        expect(cargarConfiguracionDesignacionPorId).toHaveBeenCalledWith('v1-uuid');
        expect(cargarConfiguracionDesignacionActiva).not.toHaveBeenCalled();
        expect(evaluarCandidatoDirecto).toHaveBeenCalledTimes(1);
        const [, , , configUsada] = evaluarCandidatoDirecto.mock.calls[0];
        expect(configUsada).toBe(CONFIG_V1);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 6/7. POST /propuestas (guardar) — la ÚNICA fuente de configuracion_
//      version_id es el snapshot firmado, JAMÁS req.body (aunque el body
//      declare explícitamente V2) — y toda revalidación (evaluarCandidatoDirecto)
//      en el guardado usa esa MISMA versión (V1), nunca la activa.
// ═════════════════════════════════════════════════════════════════════════
describe('POST /propuestas (guardar) — el body no puede cambiar la versión; la revalidación usa la versión del token', () => {
    test('token firmado con V1; body declara configuracion_version_id=V2 (ignorado); se persiste V1 y evaluarCandidatoDirecto recibe V1', async () => {
        const tokenV1 = firmarPreview({
            temporada_id: 't1', configuracion_version_id: 'v1-uuid',
            rodeos: [{ rodeo_id: 'r1', estado: 'PROPUESTO', jurado_id_propuesto: 'j1' }]
        });
        // Solo 'v1-uuid' resuelve — si la ruta leyera configuracion_version_id
        // del body (V2), cargarConfiguracionDesignacionPorId('v2-uuid') fallaría
        // cerrado y el test lo detectaría con un 500, no con un guardado silencioso.
        cargarConfiguracionDesignacionPorId.mockImplementation(async (id) => {
            if (id === 'v1-uuid') return { configuracion: CONFIG_V1, meta: META_V1 };
            return { error: 'CONFIGURACION_DESIGNACION_NO_RESUELTA', detalle: `id inesperado: ${id}` };
        });

        const llamadas = crearSupabaseMock({
            // 1ª llamada: "rodeos ya en otra propuesta BORRADOR" (advertencia, no bloqueante).
            // 2ª llamada: insert de propuestas_designacion_detalle al final.
            propuestas_designacion_detalle: [
                { data: [], error: null },
                { data: [{ id: 'det-1', rodeo_id: 'r1' }], error: null }
            ],
            propuestas_designacion: { data: { id: 'prop-1', estado: 'BORRADOR', created_at: '2026-09-06T00:00:00Z' }, error: null },
            rodeos: { data: [{ id: 'r1', club: 'Club R1', fecha: '2026-05-01', asociacion: 'Asoc', tipo_rodeo_nombre: 'Provincial', duracion_dias: 1 }], error: null }
        });

        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-05-01', asociacion: 'Asoc', duracion_dias: 1 }]]) });
        ejecutarSimulacion.mockReturnValue({
            resultados: [{
                rodeo_id: 'r1', estado: 'PROPUESTO', jurado_propuesto: { jurado_id: 'j1' },
                candidatos_evaluados: 5, candidatos_potenciales_bd: 5, descartes: 0
            }]
        });
        evaluarCandidatoDirecto.mockReturnValue({
            evaluacion: { causas: [], distanciaKm: 8, jurado: { categoria: 'A', asociacion: 'Asoc' } }
        });

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/propuestas',
            body: {
                preview_token: tokenV1,
                estado_temporal: [{ rodeo_id: 'r1', estado_revision: 'PENDIENTE', jurado_id_seleccionado: null }],
                configuracion_version_id: 'v2-uuid' // intento del cliente de forzar V2 — debe ser ignorado
            }
        });

        expect(status).toBe(201);
        expect(body.propuesta.id).toBe('prop-1');

        // La revalidación en vivo usó V1, nunca V2.
        expect(cargarConfiguracionDesignacionPorId).toHaveBeenCalledWith('v1-uuid');
        expect(cargarConfiguracionDesignacionPorId).not.toHaveBeenCalledWith('v2-uuid');
        expect(ejecutarSimulacion.mock.calls[0][2]).toBe(CONFIG_V1);
        expect(evaluarCandidatoDirecto.mock.calls[0][3]).toBe(CONFIG_V1);

        // Lo persistido en el INSERT es V1 — el campo del body (V2) nunca se leyó.
        const insertPropuesta = llamadas['propuestas_designacion'].inserts[0];
        expect(insertPropuesta.configuracion_version_id).toBe('v1-uuid');
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 8. Borrador persistente — GET candidatos usa la versión DE LA PROPUESTA,
//    nunca la activa del momento.
// ═════════════════════════════════════════════════════════════════════════
describe('GET /propuestas/:id/detalle/:id/candidatos — borrador usa su propia versión', () => {
    test('propuesta con configuracion_version_id=V1; activa actual (hipotética) es V2 — se usa V1', async () => {
        crearSupabaseMock({
            propuestas_designacion_detalle: [
                // 1ª llamada: el detalle con el embed de la propuesta.
                { data: { id: 'det-1', rodeo_id: 'r1', estado_revision: 'PENDIENTE', propuestas_designacion: { configuracion_version_id: 'v1-uuid' } }, error: null },
                // 2ª llamada: cargarOtrasFilasEfectivas (sin otras filas).
                { data: [], error: null }
            ]
        });
        cargarConfiguracionDesignacionPorId.mockImplementation(async (id) => {
            if (id === 'v1-uuid') return { configuracion: CONFIG_V1, meta: META_V1 };
            return { error: 'CONFIGURACION_DESIGNACION_NO_RESUELTA', detalle: `id inesperado: ${id}` };
        });
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: CONFIG_V2, meta: META_V2 });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-05-01', asociacion: 'Asoc', duracion_dias: 1 }]]) });
        ejecutarSimulacion.mockReturnValue({ resultados: [{ estado: 'PROPUESTO', top_candidatos: [], descartados: [], candidatos_evaluados: 4 }] });

        const { status, body } = await llamarRuta({ method: 'GET', url: '/propuestas/prop-1/detalle/det-1/candidatos' });

        expect(status).toBe(200);
        expect(body.candidatos_evaluados).toBe(4);
        expect(cargarConfiguracionDesignacionPorId).toHaveBeenCalledWith('v1-uuid');
        expect(cargarConfiguracionDesignacionActiva).not.toHaveBeenCalled();
        expect(ejecutarSimulacion.mock.calls[0][2]).toBe(CONFIG_V1);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// Mejora "Equidad Visible de Designaciones" — historial_reciente en los
// endpoints de candidatos (GET .../candidatos y POST /preview/candidatos):
// anti-N+1 (sección 31/33/35: cantidad de queries FIJA, sin importar N
// candidatos) + autosuficiencia del payload (sección 42/48: cada candidato
// ya trae equidad_designaciones + historial_reciente, sin llamadas de
// seguimiento por candidato). ejecutarSimulacion() está mockeado en este
// archivo — equidad_designaciones se simula tal cual la calcularía el motor
// real; historial_reciente se agrega por la RUTA vía cargarHistorialRecienteBatch
// (real, no mockeado), contra Supabase mockeado por tabla.
// ═════════════════════════════════════════════════════════════════════════
describe('Candidatos — historial_reciente en batch (anti N+1) y payload autosuficiente', () => {
    function candidatoFalso(n, extra = {}) {
        return {
            jurado_id: `j${n}`, nombre: `Jurado ${n}`, categoria: 'A', asociacion: 'Asoc',
            comuna_nombre: 'Comuna', distancia_km: 10, designaciones_antes: n % 3,
            equidad_designaciones: { designaciones_jurado: n % 3, categoria: 'A', promedio_categoria: 2.1, total_jurados_categoria: 40, promedio_general: 2.0, total_jurados_general: 61 },
            ...extra
        };
    }

    test('POST /preview/candidatos — 1 sola consulta a "asignaciones" y a "notas_rodeo" con 59 candidatos (fijo, no por candidato)', async () => {
        const tokenV1 = firmarPreview({
            temporada_id: 't1', configuracion_version_id: 'v1-uuid',
            rodeos: [{ rodeo_id: 'r1', estado: 'PROPUESTO', jurado_id_propuesto: 'j0' }]
        });
        cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-05-01', asociacion: 'Asoc', duracion_dias: 1 }]]) });
        const validos = Array.from({ length: 40 }, (_, i) => candidatoFalso(i));
        const descartados = Array.from({ length: 19 }, (_, i) => candidatoFalso(40 + i, { causas: ['DISTANCIA_EXCEDIDA'] }));
        ejecutarSimulacion.mockReturnValue({ resultados: [{ estado: 'PROPUESTO', top_candidatos: validos, descartados, candidatos_evaluados: 59 }] });

        const llamadas = crearSupabaseMock({}); // todas las tablas -> { data: [], error: null } por defecto

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/preview/candidatos',
            body: {
                rodeo_id: 'r1', preview_token: tokenV1,
                estado_temporal: [{ rodeo_id: 'r1', estado_revision: 'PENDIENTE', jurado_id_seleccionado: null }]
            }
        });

        expect(status).toBe(200);
        expect(body.candidatos_validos).toHaveLength(40);
        expect(body.descartados).toHaveLength(19);
        // Fijo — nunca 59 llamadas, ni 2 por candidato: crearSupabaseMock
        // registra cada tabla una sola vez aunque se consulte varias veces
        // (llamadas[tabla] se crea al primer from()); para contar
        // invocaciones reales usamos supabase.from.mock.calls directamente.
        const nombreTablas = supabase.from.mock.calls.map(c => c[0]);
        expect(nombreTablas.filter(t => t === 'asignaciones')).toHaveLength(1);
        // 'asignaciones' mockeada devuelve [] (sin historial real para estos
        // 59 jurado_id falsos) -> cargarHistorialRecienteBatch se salta la
        // consulta de notas (nada que enriquecer, sección "0 queries si no
        // hay nada" del mismo patrón que cargarRendimientoTemporada).
        expect(nombreTablas.filter(t => t === 'notas_rodeo')).toHaveLength(0);

        // Payload autosuficiente (sección 42/48): CADA candidato ya trae
        // equidad_designaciones (del motor) e historial_reciente (agregado
        // por la ruta, batch) — sin necesitar una llamada de seguimiento.
        for (const c of [...body.candidatos_validos, ...body.descartados]) {
            expect(c.equidad_designaciones).toBeTruthy();
            expect(Array.isArray(c.historial_reciente)).toBe(true);
        }
    });

    test('GET .../candidatos (borrador persistido) — misma garantía: historial_reciente presente, 1 sola consulta batch', async () => {
        crearSupabaseMock({
            propuestas_designacion_detalle: [
                { data: { id: 'det-1', rodeo_id: 'r1', estado_revision: 'PENDIENTE', propuestas_designacion: { configuracion_version_id: 'v1-uuid' } }, error: null },
                { data: [], error: null } // otras filas
            ]
        });
        cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-05-01', asociacion: 'Asoc', duracion_dias: 1 }]]) });
        const validos = [candidatoFalso(1), candidatoFalso(2)];
        ejecutarSimulacion.mockReturnValue({ resultados: [{ estado: 'PROPUESTO', top_candidatos: validos, descartados: [], candidatos_evaluados: 2 }] });

        const { status, body } = await llamarRuta({ method: 'GET', url: '/propuestas/prop-1/detalle/det-1/candidatos' });

        expect(status).toBe(200);
        expect(body.candidatos_validos).toHaveLength(2);
        for (const c of body.candidatos_validos) {
            expect(c.equidad_designaciones.designaciones_jurado).toEqual(c.designaciones_antes);
            expect(Array.isArray(c.historial_reciente)).toBe(true);
        }
        const nombreTablas = supabase.from.mock.calls.map(c => c[0]);
        expect(nombreTablas.filter(t => t === 'asignaciones')).toHaveLength(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// Corrección — equidad_designaciones debe reflejar BD + designaciones
// TEMPORALES ya existentes en OTRAS filas del mismo preview (secciones
// 10/11 del pedido de corrección: "no solo BD"). ejecutarSimulacion() está
// mockeado devolviendo el estado SOLO-BD (como lo haría de verdad para un
// único rodeo) — la ruta debe ajustarlo con `otrasFilas`, ya construido para
// detectarConflictoInterno, sin ninguna consulta nueva.
// ═════════════════════════════════════════════════════════════════════════
describe('POST /preview/candidatos — equidad_designaciones ajustado con temporales de OTRAS filas del preview', () => {
    test('j1 ya está propuesto (PENDIENTE) en otra fila del mismo preview -> su designaciones_jurado sube en 1 y el promedio de categoría sube para TODOS los candidatos de esa categoría', async () => {
        const tokenV1 = firmarPreview({
            temporada_id: 't1', configuracion_version_id: 'v1-uuid',
            rodeos: [
                { rodeo_id: 'r1', estado: 'PROPUESTO', jurado_id_propuesto: 'j2' },
                { rodeo_id: 'r-otro', estado: 'PROPUESTO', jurado_id_propuesto: 'j1' }
            ]
        });
        cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        // contexto SOLO-BD: sin asignaciones reales todavía, población {j1,j2} categoría A.
        // .bloque con forma REAL (calcularBloqueRodeo) — detectarConflictoInterno
        // (real, no mockeado) lo necesita al comparar contra `otrasFilas`.
        cargarDatosMotor.mockResolvedValue({
            rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-09-05', asociacion: 'Asoc', duracion_dias: 1, bloque: calcularBloqueRodeo('2026-09-05', 1) }]]),
            jurados: [{ id: 'j1', categoria: 'A' }, { id: 'j2', categoria: 'A' }],
            asignacionesTemporada: []
        });
        // equidad_designaciones tal como la calcularía ejecutarSimulacion() para un ÚNICO
        // rodeo (SOLO-BD, sin ver la otra fila): ambos en 0, promedio 0.
        const equidadBase = (designJurado) => ({ designaciones_jurado: designJurado, categoria: 'A', promedio_categoria: 0, total_jurados_categoria: 2, promedio_general: 0, total_jurados_general: 2 });
        ejecutarSimulacion.mockReturnValue({
            resultados: [{
                estado: 'PROPUESTO',
                top_candidatos: [
                    { jurado_id: 'j1', nombre: 'J1', categoria: 'A', designaciones_antes: 0, equidad_designaciones: equidadBase(0) },
                    { jurado_id: 'j2', nombre: 'J2', categoria: 'A', designaciones_antes: 0, equidad_designaciones: equidadBase(0) }
                ],
                descartados: [], candidatos_evaluados: 2
            }]
        });
        crearSupabaseMock({
            rodeos: { data: [{ id: 'r-otro', club: 'Club Otro', fecha: '2026-09-06', asociacion: 'Asoc2', tipo_rodeo_nombre: 'Provincial', duracion_dias: 1 }], error: null }
        });

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/preview/candidatos',
            body: {
                rodeo_id: 'r1', preview_token: tokenV1,
                estado_temporal: [
                    { rodeo_id: 'r1', estado_revision: 'PENDIENTE', jurado_id_seleccionado: null },
                    { rodeo_id: 'r-otro', estado_revision: 'PENDIENTE', jurado_id_seleccionado: null }
                ]
            }
        });

        expect(status).toBe(200);
        const j1 = body.candidatos_validos.find(c => c.jurado_id === 'j1');
        const j2 = body.candidatos_validos.find(c => c.jurado_id === 'j2');
        // j1 ya está "usado" en r-otro (temporal, sin guardar) -> su propio contador sube.
        expect(j1.equidad_designaciones.designaciones_jurado).toBe(1);
        // j2 no cambió su propio contador...
        expect(j2.equidad_designaciones.designaciones_jurado).toBe(0);
        // ...pero el promedio de categoría (población {j1,j2}) SÍ ve la temporal de j1: (1+0)/2 = 0,5.
        expect(j1.equidad_designaciones.promedio_categoria).toBe(0.5);
        expect(j2.equidad_designaciones.promedio_categoria).toBe(0.5);
        expect(j1.equidad_designaciones.promedio_general).toBe(0.5);
    });

    test('sin ninguna otra fila con jurado efectivo -> equidad_designaciones queda EXACTAMENTE como la devolvió el motor (sin ajuste, sin objetos nuevos innecesarios)', async () => {
        const tokenV1 = firmarPreview({
            temporada_id: 't1', configuracion_version_id: 'v1-uuid',
            rodeos: [{ rodeo_id: 'r1', estado: 'PROPUESTO', jurado_id_propuesto: 'j1' }]
        });
        cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        cargarDatosMotor.mockResolvedValue({
            rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-09-05', asociacion: 'Asoc', duracion_dias: 1 }]])
        });
        const equidadOriginal = { designaciones_jurado: 3, categoria: 'A', promedio_categoria: 2.1, total_jurados_categoria: 5, promedio_general: 2.0, total_jurados_general: 20 };
        ejecutarSimulacion.mockReturnValue({
            resultados: [{ estado: 'PROPUESTO', top_candidatos: [{ jurado_id: 'j1', nombre: 'J1', categoria: 'A', designaciones_antes: 3, equidad_designaciones: equidadOriginal }], descartados: [], candidatos_evaluados: 1 }]
        });
        crearSupabaseMock({});

        const { body } = await llamarRuta({
            method: 'POST', url: '/preview/candidatos',
            body: { rodeo_id: 'r1', preview_token: tokenV1, estado_temporal: [{ rodeo_id: 'r1', estado_revision: 'PENDIENTE', jurado_id_seleccionado: null }] }
        });

        expect(body.candidatos_validos[0].equidad_designaciones).toEqual(equidadOriginal);
    });
});

// TEST 27/28/43 (pedido de UI "Zonas Extremas"): el modal "Modificar
// jurado" necesita saber si ESTE rodeo es zona extrema — resultado.
// zona_extrema (ya calculado por ejecutarSimulacion(), sin query nueva) se
// expone tal cual en la respuesta de ambos endpoints de candidatos.
describe('Candidatos — zona_extrema expuesto en la respuesta (sección 27/28/43/44)', () => {
    test('POST /preview/candidatos con rodeo de Zona Extrema -> body.zona_extrema presente, sin queries nuevas', async () => {
        const tokenV1 = firmarPreview({
            temporada_id: 't1', configuracion_version_id: 'v1-uuid',
            rodeos: [{ rodeo_id: 'r1', estado: 'PROPUESTO', jurado_id_propuesto: 'j1' }]
        });
        cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-09-05', asociacion: 'MAGALLANES', duracion_dias: 1 }]]) });
        ejecutarSimulacion.mockReturnValue({
            resultados: [{
                estado: 'PROPUESTO',
                zona_extrema: { activa: true, asociacion: 'MAGALLANES', prioridad_categorias: ['C', 'B'] },
                top_candidatos: [], descartados: [], candidatos_evaluados: 0
            }]
        });
        crearSupabaseMock({});

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/preview/candidatos',
            body: { rodeo_id: 'r1', preview_token: tokenV1, estado_temporal: [{ rodeo_id: 'r1', estado_revision: 'PENDIENTE', jurado_id_seleccionado: null }] }
        });

        expect(status).toBe(200);
        expect(body.zona_extrema).toEqual({ activa: true, asociacion: 'MAGALLANES', prioridad_categorias: ['C', 'B'] });
    });

    test('GET .../candidatos con rodeo normal -> body.zona_extrema es null', async () => {
        crearSupabaseMock({
            propuestas_designacion_detalle: [
                { data: { id: 'det-1', rodeo_id: 'r1', estado_revision: 'PENDIENTE', propuestas_designacion: { configuracion_version_id: 'v1-uuid' } }, error: null },
                { data: [], error: null }
            ]
        });
        cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-05-01', asociacion: 'Santiago', duracion_dias: 1 }]]) });
        ejecutarSimulacion.mockReturnValue({ resultados: [{ estado: 'PROPUESTO', zona_extrema: null, top_candidatos: [], descartados: [], candidatos_evaluados: 0 }] });

        const { body } = await llamarRuta({ method: 'GET', url: '/propuestas/prop-1/detalle/det-1/candidatos' });
        expect(body.zona_extrema).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 16 (revisión final Etapa 4) — GET /propuestas/:id (vista general del
// borrador, NO la lista de candidatos): el resumen que se muestra en la
// cabecera de la pantalla debe ser el de LA PROPIA versión de la propuesta,
// nunca la activa actual. Cubre el escenario "Borrador V1, activa actual V2"
// pedido explícitamente en la revisión final.
// ═════════════════════════════════════════════════════════════════════════
describe('GET /propuestas/:id — resumen de configuración de la vista general del borrador', () => {
    test('propuesta con configuracion_version_id=V1; activa actual (hipotética) es V2 — la cabecera muestra V1 (600km), nunca V2 (450km)', async () => {
        crearSupabaseMock({
            propuestas_designacion: {
                data: {
                    id: 'prop-1', temporada_id: 't1', estado: 'BORRADOR', creado_por: 'admin-1',
                    created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', confirmado_en: null,
                    configuracion_version_id: 'v1-uuid',
                    temporadas: { nombre: '2026-2027' },
                    configuracion_designacion_versiones: { numero_version: 1 }
                },
                error: null
            },
            propuestas_designacion_detalle: { data: [], error: null }
        });
        cargarConfiguracionDesignacionPorId.mockImplementation(async (id) => {
            if (id === 'v1-uuid') return { configuracion: CONFIG_V1, meta: META_V1 };
            return { error: 'CONFIGURACION_DESIGNACION_NO_RESUELTA', detalle: `id inesperado: ${id}` };
        });
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: CONFIG_V2, meta: META_V2 });

        const { status, body } = await llamarRuta({ method: 'GET', url: '/propuestas/prop-1' });

        expect(status).toBe(200);
        expect(body.propuesta.configuracion_numero_version).toBe(1);
        expect(body.propuesta.configuracion.distancia_maxima_km).toBe(600); // V1, nunca 450 (V2)
        expect(cargarConfiguracionDesignacionPorId).toHaveBeenCalledWith('v1-uuid');
        expect(cargarConfiguracionDesignacionActiva).not.toHaveBeenCalled();
    });

    test('propuesta sin configuracion_version_id (histórica, sin backfill) — configuracion=null, sin romper la vista', async () => {
        crearSupabaseMock({
            propuestas_designacion: {
                data: {
                    id: 'prop-vieja', temporada_id: null, estado: 'BORRADOR', creado_por: 'admin-1',
                    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', confirmado_en: null,
                    configuracion_version_id: null, temporadas: null, configuracion_designacion_versiones: null
                },
                error: null
            },
            propuestas_designacion_detalle: { data: [], error: null }
        });

        const { status, body } = await llamarRuta({ method: 'GET', url: '/propuestas/prop-vieja' });

        expect(status).toBe(200);
        expect(body.propuesta.configuracion_numero_version).toBeNull();
        expect(body.propuesta.configuracion).toBeNull();
        expect(cargarConfiguracionDesignacionPorId).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 9. Borrador persistente — "Modificar/Mover" (procesarSeleccion). Es la
//    función compartida por ACEPTAR, SELECCIONAR ("Modificar") y el
//    mecanismo de "mover jurado" (ver comentario junto a procesarSeleccion en
//    la ruta: mismo código para las tres, solo cambia el jurado_id de
//    entrada). Un test fuerte sobre POST .../seleccionar cubre las tres,
//    porque las tres invocan literalmente la misma función con el mismo
//    contrato — no hay lógica adicional específica de "aceptar" o "mover"
//    fuera de procesarSeleccion que dependa de la versión de configuración.
// ═════════════════════════════════════════════════════════════════════════
describe('POST /propuestas/:id/detalle/:id/seleccionar — borrador usa su propia versión (cubre aceptar/seleccionar/mover, misma función procesarSeleccion)', () => {
    test('propuesta con configuracion_version_id=V1 — evaluarCandidatoDirecto recibe V1', async () => {
        crearSupabaseMock({
            propuestas_designacion: { data: { id: 'prop-1', estado: 'BORRADOR', configuracion_version_id: 'v1-uuid' }, error: null },
            propuestas_designacion_detalle: [
                // 1ª: select('*') del detalle.
                { data: { id: 'det-1', rodeo_id: 'r1', estado_revision: 'PENDIENTE', jurado_id_propuesto: 'j1', jurado_id_seleccionado: null, metricas_json: {} }, error: null },
                // 2ª: cargarOtrasFilasEfectivas (sin otras filas → sin "mover").
                { data: [], error: null },
                // 3ª: update final + select().single() con la fila actualizada.
                { data: { id: 'det-1', rodeo_id: 'r1', estado_revision: 'ACEPTADO', jurado_id_seleccionado: 'j1' }, error: null }
            ]
        });
        cargarConfiguracionDesignacionPorId.mockImplementation(async (id) => {
            if (id === 'v1-uuid') return { configuracion: CONFIG_V1, meta: META_V1 };
            return { error: 'CONFIGURACION_DESIGNACION_NO_RESUELTA', detalle: `id inesperado: ${id}` };
        });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-05-01', asociacion: 'Asoc', duracion_dias: 1 }]]) });
        evaluarCandidatoDirecto.mockReturnValue({
            evaluacion: { causas: [], distanciaKm: 3, jurado: { id: 'j1', nombre_completo: 'Juan Pérez', categoria: 'A', asociacion: 'Asoc' } }
        });

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/propuestas/prop-1/detalle/det-1/seleccionar',
            body: { jurado_id: 'j1' }
        });

        expect(status).toBe(200);
        expect(body.detalle.estado_revision).toBe('ACEPTADO');
        expect(cargarConfiguracionDesignacionPorId).toHaveBeenCalledWith('v1-uuid');
        expect(evaluarCandidatoDirecto.mock.calls[0][3]).toBe(CONFIG_V1);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 10. Propuesta con configuracion_version_id NULL — falla cerrado, nunca
//     ejecuta el motor, nunca usa Default V1, nunca consulta la activa.
// ═════════════════════════════════════════════════════════════════════════
describe('Propuesta con configuracion_version_id NULL', () => {
    test('CONFIGURACION_PROPUESTA_NO_RESUELTA — no se llama al cargador ni al motor', async () => {
        crearSupabaseMock({
            propuestas_designacion: { data: { id: 'prop-1', estado: 'BORRADOR', configuracion_version_id: null }, error: null }
        });

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/propuestas/prop-1/detalle/det-1/seleccionar',
            body: { jurado_id: 'j1' }
        });

        expect(status).toBe(500);
        expect(body.error).toBe('CONFIGURACION_PROPUESTA_NO_RESUELTA');
        expect(cargarConfiguracionDesignacionPorId).not.toHaveBeenCalled();
        expect(cargarConfiguracionDesignacionActiva).not.toHaveBeenCalled();
        expect(cargarDatosMotor).not.toHaveBeenCalled();
        expect(evaluarCandidatoDirecto).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 11. Token legacy (v=1, sin configuracion_version_id) — rechazado antes de
//     tocar cualquier configuración o el motor.
// ═════════════════════════════════════════════════════════════════════════
describe('Token legacy (formato anterior a Etapa 3)', () => {
    test('/preview/candidatos con un token v=1 sin configuracion_version_id → rechazado, sin resolver configuración ni ejecutar el motor', async () => {
        const crypto = require('crypto');
        const SECRETO = process.env.JWT_SECRET || 'fallback_secret_change_in_prod';
        const DOMINIO = 'propuesta-designacion-preview-v1:';
        const payloadLegacy = { v: 1, temporada_id: 't1', rodeos: [{ rodeo_id: 'r1', estado: 'PROPUESTO', jurado_id_propuesto: 'j1' }] };
        const payloadB64 = Buffer.from(JSON.stringify(payloadLegacy), 'utf8').toString('base64url');
        const firma = crypto.createHmac('sha256', SECRETO).update(DOMINIO + payloadB64).digest('hex');
        const tokenLegacy = `${payloadB64}.${firma}`;

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/preview/candidatos',
            body: { rodeo_id: 'r1', preview_token: tokenLegacy, estado_temporal: [{ rodeo_id: 'r1', estado_revision: 'PENDIENTE', jurado_id_seleccionado: null }] }
        });

        expect(status).toBe(400);
        expect(body.error).toMatch(/preview_token inválido/);
        expect(cargarConfiguracionDesignacionPorId).not.toHaveBeenCalled();
        expect(cargarConfiguracionDesignacionActiva).not.toHaveBeenCalled();
        expect(cargarDatosMotor).not.toHaveBeenCalled();
        expect(ejecutarSimulacion).not.toHaveBeenCalled();
    });
});
