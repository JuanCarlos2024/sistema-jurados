// ═════════════════════════════════════════════════════════════════════════
// Tests de ORQUESTACIÓN DE RUTA — Cartilla Delegado, mejora "nuevo formato
// oficial 2026-2027". Invoca el router de Express directamente (mismo
// patrón que propuesta-designacion.orquestacion.test.js — sin supertest, sin
// servidor HTTP). services/cartillaDelegadoNotas.js se usa REAL (ya está
// cubierto exhaustivamente en su propio archivo de tests) — acá solo importa
// que la ruta lo conecte correctamente.
// ═════════════════════════════════════════════════════════════════════════
jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
const supabase = require('../../config/supabase');
const router = require('./cartilla-delegado');

function llamarRuta({ method, url, body, usuario }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url,
            body: body || {}, query: {}, params: {}, headers: {},
            ip: '127.0.0.1',
            usuario: usuario || { id: 'delegado-1', tipo_persona: 'delegado_rentado' },
            get() { return undefined; }
        };
        const res = {
            statusCode: 200,
            status(codigo) { this.statusCode = codigo; return this; },
            json(payload) { resolve({ status: this.statusCode, body: payload }); return this; }
        };
        router(req, res, (err) => {
            if (err) reject(err);
            else resolve({ status: 404, body: { error: 'ruta no encontrada' } });
        });
    });
}

// Mock genérico por tabla, con soporte insert/update/upsert (secuencia por
// tabla si se pasa un array; una sola respuesta fija en otro caso).
function crearSupabaseMock(porTabla) {
    const llamadas = {};
    const consumir = (tabla) => {
        const entrada = porTabla[tabla];
        if (entrada === undefined) return { data: [], error: null };
        if (Array.isArray(entrada)) return entrada.length > 1 ? entrada.shift() : entrada[0];
        return entrada;
    };
    supabase.from.mockImplementation((tabla) => {
        llamadas[tabla] = llamadas[tabla] || { inserts: [], updates: [], upserts: [] };
        const chain = {
            select: () => chain, eq: () => chain, neq: () => chain, in: () => chain, order: () => chain,
            insert: (payload) => { llamadas[tabla].inserts.push(payload); return chain; },
            update:  (payload) => { llamadas[tabla].updates.push(payload); return chain; },
            upsert:  (payload, opts) => { llamadas[tabla].upserts.push({ payload, opts }); return chain; },
            single: () => chain, maybeSingle: () => chain,
            then: (resolve, reject) => Promise.resolve(consumir(tabla)).then(resolve, reject)
        };
        return chain;
    });
    return llamadas;
}

beforeEach(() => { jest.clearAllMocks(); });

const ASIG_ACTIVA = { id: 'asig-1', estado_designacion: 'aceptado' };

describe('middleware — solo delegados', () => {
    test('usuario que no es delegado_rentado -> 403', async () => {
        const { status, body } = await llamarRuta({
            method: 'GET', url: '/rodeo/r1',
            usuario: { id: 'j1', tipo_persona: 'jurado' }
        });
        expect(status).toBe(403);
        expect(body.error).toMatch(/Solo los delegados/);
    });
});

describe('GET /rodeo/:rodeo_id — precarga (temporada real, jurados desde la relación real)', () => {
    test('temporada usa temporadas.nombre (fuente oficial), NUNCA hardcodeada', async () => {
        crearSupabaseMock({
            asignaciones: [
                { data: ASIG_ACTIVA, error: null }, // check de asignación activa
                { data: [{ usuario_pagado_id: 'j1', nombre_importado: null, usuarios_pagados: { nombre_completo: 'JUAN PÉREZ' } }], error: null } // cargarJuradosRodeo
            ],
            rodeos: { data: { id: 'r1', club: 'EL VALLE', asociacion: 'CURICÓ', fecha: '2026-09-05', tipo_rodeo_nombre: 'Provincial', temporada_id: 't1', temporadas: { nombre: '2026-2027' } }, error: null },
            usuarios_pagados: { data: { nombre_completo: 'DELEGADO X', telefono: '+56911111111', email: 'd@x.cl' }, error: null },
            cartillas_delegado: { data: null, error: null }
        });

        const { status, body } = await llamarRuta({ method: 'GET', url: '/rodeo/r1' });
        expect(status).toBe(200);
        expect(body.rodeo.temporadas.nombre).toBe('2026-2027');
        expect(body.jurados).toEqual(['JUAN PÉREZ']);
    });

    test('sin asignación activa -> 404, nunca expone datos del rodeo', async () => {
        crearSupabaseMock({ asignaciones: { data: null, error: null } });
        const { status } = await llamarRuta({ method: 'GET', url: '/rodeo/r1' });
        expect(status).toBe(404);
    });
});

describe('POST /rodeo/:rodeo_id — creación: temporada real, SIN duplicar asociación/club/correo del delegado', () => {
    test('CASO 1 del pedido — con Delegado Rentado: usa temporadas.nombre, precarga nombre real', async () => {
        const llamadas = crearSupabaseMock({
            asignaciones: { data: ASIG_ACTIVA, error: null },
            cartillas_delegado: [
                { data: null, error: null }, // "ya existe?" -> no
                { data: { id: 'cart-1', rodeo_id: 'r1', temporada: '2026-2027' }, error: null } // insert().select().single()
            ],
            rodeos: { data: { club: 'EL VALLE', asociacion: 'CURICÓ', fecha: '2026-09-05', tipo_rodeo_nombre: 'Provincial', temporada_id: 't1', temporadas: { nombre: '2026-2027' } }, error: null },
            usuarios_pagados: { data: { nombre_completo: 'DELEGADO X', telefono: '+56911111111' }, error: null }
        });

        const { status, body } = await llamarRuta({ method: 'POST', url: '/rodeo/r1' });
        expect(status).toBe(201);
        expect(body.creada).toBe(true);
        const insertPayload = llamadas.cartillas_delegado.inserts[0];
        expect(insertPayload.temporada).toBe('2026-2027');
        expect(insertPayload.delegado_nombre).toBe('DELEGADO X'); // Caso A: nombre del Delegado Rentado real, no manual
        expect(insertPayload.club_asociacion_organizador).toBe('EL VALLE — CURICÓ');
    });

    test('gate segunda revisión — el INSERT nunca incluye asociacion_organizadora/club_organizador/delegado_email (no son columnas de la tabla)', async () => {
        const llamadas = crearSupabaseMock({
            asignaciones: { data: ASIG_ACTIVA, error: null },
            cartillas_delegado: [
                { data: null, error: null },
                { data: { id: 'cart-1' }, error: null }
            ],
            rodeos: { data: { club: 'EL VALLE', asociacion: 'CURICÓ', fecha: '2026-09-05', tipo_rodeo_nombre: 'Provincial', temporada_id: 't1', temporadas: { nombre: '2026-2027' } }, error: null },
            usuarios_pagados: { data: { nombre_completo: 'DELEGADO X', telefono: '+56911111111' }, error: null }
        });
        await llamarRuta({ method: 'POST', url: '/rodeo/r1' });
        const insertPayload = llamadas.cartillas_delegado.inserts[0];
        expect(insertPayload).not.toHaveProperty('asociacion_organizadora');
        expect(insertPayload).not.toHaveProperty('club_organizador');
        expect(insertPayload).not.toHaveProperty('delegado_email');
    });

    test('rodeo sin temporada_id asignado -> cae al año de la fecha como respaldo (nunca falla)', async () => {
        const llamadas = crearSupabaseMock({
            asignaciones: { data: ASIG_ACTIVA, error: null },
            cartillas_delegado: [
                { data: null, error: null },
                { data: { id: 'cart-1' }, error: null }
            ],
            rodeos: { data: { club: 'EL VALLE', asociacion: 'CURICÓ', fecha: '2026-09-05', tipo_rodeo_nombre: 'Provincial', temporada_id: null, temporadas: null }, error: null },
            usuarios_pagados: { data: { nombre_completo: 'DELEGADO X', telefono: null }, error: null }
        });

        await llamarRuta({ method: 'POST', url: '/rodeo/r1' });
        expect(llamadas.cartillas_delegado.inserts[0].temporada).toBe('2026'); // respaldo: año de la fecha
    });
});

describe('Nombre del Delegado — manual vs automático (punto 6 de la segunda revisión)', () => {
    test('un nombre editado manualmente por el delegado se guarda tal cual, sin exigir que coincida con ninguna asignación', async () => {
        const llamadas = crearSupabaseMock({
            cartillas_delegado: [
                { data: { id: 'cart-1', estado: 'borrador', delegado_id: 'delegado-1' }, error: null },
                { data: { id: 'cart-1', delegado_nombre: 'NOMBRE ESCRITO A MANO' }, error: null }
            ]
        });
        const { status } = await llamarRuta({
            method: 'PATCH', url: '/cart-1',
            body: { delegado_nombre: 'NOMBRE ESCRITO A MANO' }
        });
        expect(status).toBe(200); // nunca rechaza por no calzar con usuarios_pagados/asignacion_id
        expect(llamadas.cartillas_delegado.updates[0].delegado_nombre).toBe('NOMBRE ESCRITO A MANO');
    });

    test('PATCH sin enviar delegado_nombre en el body NUNCA lo sobrescribe con vacío/NULL (solo se actualizan los campos presentes en el body)', async () => {
        const llamadas = crearSupabaseMock({
            cartillas_delegado: [
                { data: { id: 'cart-1', estado: 'borrador', delegado_id: 'delegado-1' }, error: null },
                { data: { id: 'cart-1' }, error: null }
            ]
        });
        await llamarRuta({ method: 'PATCH', url: '/cart-1', body: { secretario_jurado: 'PEDRO' } });
        const update = llamadas.cartillas_delegado.updates[0];
        expect(update).not.toHaveProperty('delegado_nombre'); // no tocado -> el valor ya guardado se conserva intacto en BD
    });
});

describe('PATCH /:id — validación 1.0-7.0 de las notas del desempeño del jurado', () => {
    test('nota fuera de rango -> 422, NO llega a actualizar', async () => {
        const llamadas = crearSupabaseMock({
            cartillas_delegado: { data: { id: 'cart-1', estado: 'borrador', delegado_id: 'delegado-1' }, error: null }
        });
        const { status, body } = await llamarRuta({
            method: 'PATCH', url: '/cart-1',
            body: { respuestas_json: { desempeno_jurado: { aspecto_1: 8 } } }
        });
        expect(status).toBe(422);
        expect(body.campos).toEqual(['aspecto_1']);
        expect(llamadas.cartillas_delegado.updates).toHaveLength(0);
    });

    test('notas parciales válidas -> guarda, nota_promedio queda null (incompleto, nunca 0)', async () => {
        const llamadas = crearSupabaseMock({
            cartillas_delegado: [
                { data: { id: 'cart-1', estado: 'borrador', delegado_id: 'delegado-1' }, error: null },
                { data: { id: 'cart-1' }, error: null }
            ]
        });
        const { status } = await llamarRuta({
            method: 'PATCH', url: '/cart-1',
            body: { respuestas_json: { desempeno_jurado: { aspecto_1: 6, aspecto_2: 5 } } }
        });
        expect(status).toBe(200);
        const update = llamadas.cartillas_delegado.updates[0];
        expect(update.respuestas_json.desempeno_jurado.nota_promedio).toBeNull();
    });

    test('cartilla ya enviada -> 409, no permite editar', async () => {
        crearSupabaseMock({ cartillas_delegado: { data: { id: 'cart-1', estado: 'enviada', delegado_id: 'delegado-1' }, error: null } });
        const { status } = await llamarRuta({ method: 'PATCH', url: '/cart-1', body: { temporada: '2026-2027' } });
        expect(status).toBe(409);
    });
});

describe('Informe general de accidentes (3ª revisión) — respuestas_json.informe_accidentes_general, INDEPENDIENTE de respuestas_json.accidentes_informe (detalle Sección VII)', () => {
    test('guarda el texto libre del relato general junto con el detalle estructurado de la Sección VII, sin que uno pise al otro', async () => {
        const llamadas = crearSupabaseMock({
            cartillas_delegado: [
                { data: { id: 'cart-1', estado: 'borrador', delegado_id: 'delegado-1' }, error: null },
                { data: { id: 'cart-1' }, error: null }
            ]
        });
        const { status } = await llamarRuta({
            method: 'PATCH', url: '/cart-1',
            body: {
                respuestas_json: {
                    informe_accidentes_general: 'Un jinete sufrió una caída leve en la segunda serie, sin lesiones de gravedad.',
                    accidentes_informe: { hubo_accidentes: 'si', medico_nombre: 'DR. PÉREZ', medico_telefono: '+56911112222', items: [] }
                }
            }
        });
        expect(status).toBe(200);
        const update = llamadas.cartillas_delegado.updates[0];
        // el relato general se guarda tal cual, como texto independiente
        expect(update.respuestas_json.informe_accidentes_general).toBe('Un jinete sufrió una caída leve en la segunda serie, sin lesiones de gravedad.');
        // el detalle estructurado de la Sección VII se guarda intacto, sin mezclarse con el relato
        expect(update.respuestas_json.accidentes_informe.medico_nombre).toBe('DR. PÉREZ');
        expect(update.respuestas_json.accidentes_informe).not.toHaveProperty('informe_accidentes_general');
    });

    test('recuperación: GET devuelve el texto guardado sin transformarlo', async () => {
        crearSupabaseMock({
            asignaciones: [
                { data: ASIG_ACTIVA, error: null },
                { data: [], error: null }
            ],
            rodeos: { data: { id: 'r1', club: 'EL VALLE', asociacion: 'CURICÓ', fecha: '2026-09-05', tipo_rodeo_nombre: 'Provincial', temporada_id: 't1', temporadas: { nombre: '2026-2027' } }, error: null },
            usuarios_pagados: { data: { nombre_completo: 'DELEGADO X', telefono: '+56911111111' }, error: null },
            cartillas_delegado: {
                data: { id: 'cart-1', respuestas_json: { informe_accidentes_general: 'Relato guardado previamente.', accidentes_informe: { hubo_accidentes: 'no' } } },
                error: null
            }
        });
        const { status, body } = await llamarRuta({ method: 'GET', url: '/rodeo/r1' });
        expect(status).toBe(200);
        expect(body.cartilla.respuestas_json.informe_accidentes_general).toBe('Relato guardado previamente.');
        expect(body.cartilla.respuestas_json.accidentes_informe.hubo_accidentes).toBe('no');
    });

    test('cartilla antigua sin el campo -> respuestas_json queda sin informe_accidentes_general, nunca se completa con datos de accidentes_informe', async () => {
        crearSupabaseMock({
            asignaciones: [
                { data: ASIG_ACTIVA, error: null },
                { data: [], error: null }
            ],
            rodeos: { data: { id: 'r1', club: 'EL VALLE', asociacion: 'CURICÓ', fecha: '2026-09-05', tipo_rodeo_nombre: 'Provincial', temporada_id: 't1', temporadas: { nombre: '2026-2027' } }, error: null },
            usuarios_pagados: { data: { nombre_completo: 'DELEGADO X', telefono: '+56911111111' }, error: null },
            cartillas_delegado: {
                data: { id: 'cart-antigua', respuestas_json: { accidentes_informe: { hubo_accidentes: 'si', medico_nombre: 'DR. GÓMEZ' } } },
                error: null
            }
        });
        const { status, body } = await llamarRuta({ method: 'GET', url: '/rodeo/r1' });
        expect(status).toBe(200);
        expect(body.cartilla.respuestas_json.informe_accidentes_general).toBeUndefined();
        expect(body.cartilla.respuestas_json.accidentes_informe.medico_nombre).toBe('DR. GÓMEZ'); // el detalle antiguo de la Sección VII se preserva intacto
    });
});

describe('POST /:id/enviar — sincroniza Nota Delegado (rodeo_notas_secundarias) SOLO si las 4 notas están completas', () => {
    test('CASO 6 del pedido — 4 notas válidas -> sincroniza, nota_delegado_sincronizada=true, upsert con el promedio correcto', async () => {
        const llamadas = crearSupabaseMock({
            cartillas_delegado: [
                { data: { id: 'cart-1', rodeo_id: 'rodeo-9', estado: 'borrador', delegado_id: 'delegado-1', temporada: '2026-2027', fecha_rodeo: '2026-09-05', delegado_nombre: 'D', club_asociacion_organizador: 'X', tipo_rodeo: 'Provincial', historial_observaciones: [] }, error: null },
                { data: { id: 'cart-1', estado: 'enviada' }, error: null }
            ],
            rodeo_notas_secundarias: { data: null, error: null }
        });
        const { status, body } = await llamarRuta({
            method: 'POST', url: '/cart-1/enviar',
            body: { respuestas_json: { desempeno_jurado: { aspecto_1: 6, aspecto_2: 5, aspecto_3: 7, aspecto_4: 6 } } }
        });
        expect(status).toBe(200);
        expect(body.nota_delegado_sincronizada).toBe(true);
        const up = llamadas.rodeo_notas_secundarias.upserts[0];
        expect(up.payload.rodeo_id).toBe('rodeo-9');
        expect(up.payload.nota_delegado).toBe(6.0);
        expect(up.opts).toEqual({ onConflict: 'rodeo_id' });
    });

    test('notas incompletas -> NO sincroniza (nota_delegado_sincronizada=false, sin upsert)', async () => {
        const llamadas = crearSupabaseMock({
            cartillas_delegado: [
                { data: { id: 'cart-1', rodeo_id: 'rodeo-9', estado: 'borrador', delegado_id: 'delegado-1', temporada: '2026-2027', fecha_rodeo: '2026-09-05', delegado_nombre: 'D', club_asociacion_organizador: 'X', tipo_rodeo: 'Provincial', historial_observaciones: [] }, error: null },
                { data: { id: 'cart-1', estado: 'enviada' }, error: null }
            ]
        });
        const { status, body } = await llamarRuta({
            method: 'POST', url: '/cart-1/enviar',
            body: { respuestas_json: { desempeno_jurado: { aspecto_1: 6 } } }
        });
        expect(status).toBe(200);
        expect(body.nota_delegado_sincronizada).toBe(false);
        expect(llamadas.rodeo_notas_secundarias).toBeUndefined();
    });

    test('nota fuera de rango en el body de /enviar -> 422, nunca llega a enviar ni a sincronizar', async () => {
        crearSupabaseMock({
            cartillas_delegado: { data: { id: 'cart-1', rodeo_id: 'rodeo-9', estado: 'borrador', delegado_id: 'delegado-1', temporada: '2026-2027', fecha_rodeo: '2026-09-05', delegado_nombre: 'D', club_asociacion_organizador: 'X', tipo_rodeo: 'Provincial' }, error: null }
        });
        const { status } = await llamarRuta({
            method: 'POST', url: '/cart-1/enviar',
            body: { respuestas_json: { desempeno_jurado: { aspecto_1: 6, aspecto_2: 5, aspecto_3: 7, aspecto_4: 0.5 } } }
        });
        expect(status).toBe(422);
    });
});
