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
const router = require('./propuesta-designacion');

// ─── Objetos-marca: identidad de referencia, no solo forma ────────────────
const CONFIG_V1 = Object.freeze({ marca: 'CONFIG_V1' });
const CONFIG_V2 = Object.freeze({ marca: 'CONFIG_V2' });
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
        expect(body.configuracion).toEqual(META_V1);
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
