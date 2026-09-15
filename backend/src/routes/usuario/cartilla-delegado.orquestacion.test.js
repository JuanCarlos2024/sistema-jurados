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
        expect(insertPayload.tipo_rodeo).toBe('Provincial');
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

    test('gate cuarta revisión — el INSERT ya NO incluye club_asociacion_organizador (redundante con Asociación/Club en vivo)', async () => {
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
        expect(llamadas.cartillas_delegado.inserts[0]).not.toHaveProperty('club_asociacion_organizador');
    });

    test('GET /rodeo/:rodeo_id devuelve asociacion/club/tipo_rodeo_nombre del rodeo tal cual (fuente única, sin transformar)', async () => {
        crearSupabaseMock({
            asignaciones: [
                { data: ASIG_ACTIVA, error: null },
                { data: [], error: null }
            ],
            rodeos: { data: { id: 'r1', club: 'FEDERACION', asociacion: 'FEDERACION', fecha: '2026-09-26', tipo_rodeo_nombre: 'Provincial', categoria_rodeo_nombre: '3 series', temporada_id: 't1', temporadas: { nombre: '2026-2027' } }, error: null },
            usuarios_pagados: { data: { nombre_completo: 'DELEGADO FEDERACION PRUEBA', telefono: '+56911111111' }, error: null },
            cartillas_delegado: { data: null, error: null }
        });
        const { status, body } = await llamarRuta({ method: 'GET', url: '/rodeo/r1' });
        expect(status).toBe(200);
        expect(body.rodeo.asociacion).toBe('FEDERACION');
        expect(body.rodeo.club).toBe('FEDERACION');
        expect(body.rodeo.tipo_rodeo_nombre).toBe('Provincial');
        expect(body.rodeo.categoria_rodeo_nombre).toBe('3 series');
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

describe('Temporada / Tipo de Rodeo — 100% automáticos (4ª revisión, puntos 1 y 3)', () => {
    test('PATCH con temporada/tipo_rodeo/club_asociacion_organizador en el body NUNCA los aplica (ya no son editables)', async () => {
        const llamadas = crearSupabaseMock({
            cartillas_delegado: [
                { data: { id: 'cart-1', estado: 'borrador', delegado_id: 'delegado-1' }, error: null },
                { data: { id: 'cart-1' }, error: null }
            ]
        });
        const { status } = await llamarRuta({
            method: 'PATCH', url: '/cart-1',
            body: { temporada: 'HACKEADA', tipo_rodeo: 'HACKEADO', club_asociacion_organizador: 'HACKEADO', secretario_jurado: 'PEDRO' }
        });
        expect(status).toBe(200);
        const update = llamadas.cartillas_delegado.updates[0];
        expect(update).not.toHaveProperty('temporada');
        expect(update).not.toHaveProperty('tipo_rodeo');
        expect(update).not.toHaveProperty('club_asociacion_organizador');
        expect(update.secretario_jurado).toBe('PEDRO'); // el resto de los campos editables sigue funcionando
    });

    test('POST /:id/enviar — NO exige club_asociacion_organizador (ya no se auto-completa, quedaría siempre vacío en cartillas nuevas)', async () => {
        const llamadas = crearSupabaseMock({
            cartillas_delegado: [
                {
                    data: {
                        id: 'cart-1', rodeo_id: 'rodeo-9', estado: 'borrador', delegado_id: 'delegado-1',
                        temporada: '2026-2027', fecha_rodeo: '2026-09-05', delegado_nombre: 'D',
                        tipo_rodeo: 'Provincial', historial_observaciones: []
                        // sin club_asociacion_organizador — ya no se auto-completa (4ª revisión)
                    }, error: null
                },
                { data: { id: 'cart-1', estado: 'enviada' }, error: null }
            ]
        });
        const { status } = await llamarRuta({ method: 'POST', url: '/cart-1/enviar', body: {} });
        expect(status).toBe(200);
        expect(llamadas.cartillas_delegado.updates[0].estado).toBe('enviada');
    });

    test('POST /:id/enviar — SIGUE exigiendo temporada/tipo_rodeo (garantizados por el auto-cálculo de creación, nunca por el Delegado)', async () => {
        crearSupabaseMock({
            cartillas_delegado: {
                data: {
                    id: 'cart-1', rodeo_id: 'rodeo-9', estado: 'borrador', delegado_id: 'delegado-1',
                    temporada: null, fecha_rodeo: '2026-09-05', delegado_nombre: 'D',
                    tipo_rodeo: null, historial_observaciones: []
                }, error: null
            }
        });
        const { status, body } = await llamarRuta({ method: 'POST', url: '/cart-1/enviar', body: {} });
        expect(status).toBe(422);
        expect(body.faltantes).toEqual(expect.arrayContaining(['temporada', 'tipo_rodeo']));
    });
});

describe('Fecha del Rodeo — 100% automática (5ª revisión, punto 1: mismo problema y misma corrección que Temporada)', () => {
    test('GET /rodeo/:rodeo_id devuelve rodeo.fecha tal cual, disponible aunque NO exista cartilla guardada todavía', async () => {
        crearSupabaseMock({
            asignaciones: [
                { data: ASIG_ACTIVA, error: null },
                { data: [], error: null }
            ],
            rodeos: { data: { id: 'r1', club: 'FEDERACION', asociacion: 'FEDERACION', fecha: '2026-09-26', tipo_rodeo_nombre: 'Provincial 3 series', temporada_id: 't1', temporadas: { nombre: '2026-2027' } }, error: null },
            usuarios_pagados: { data: { nombre_completo: 'DELEGADO FEDERACION PRUEBA', telefono: '+56911111111' }, error: null },
            cartillas_delegado: { data: null, error: null } // sin cartilla creada todavía
        });
        const { status, body } = await llamarRuta({ method: 'GET', url: '/rodeo/r1' });
        expect(status).toBe(200);
        expect(body.cartilla).toBeNull();
        expect(body.rodeo.fecha).toBe('2026-09-26'); // disponible aunque no exista cartilla
    });

    test('PATCH con fecha_rodeo en el body NUNCA la aplica (ya no es editable, igual que temporada/tipo_rodeo)', async () => {
        const llamadas = crearSupabaseMock({
            cartillas_delegado: [
                { data: { id: 'cart-1', estado: 'borrador', delegado_id: 'delegado-1' }, error: null },
                { data: { id: 'cart-1' }, error: null }
            ]
        });
        const { status } = await llamarRuta({
            method: 'PATCH', url: '/cart-1',
            body: { fecha_rodeo: '1999-01-01', secretario_jurado: 'PEDRO' }
        });
        expect(status).toBe(200);
        const update = llamadas.cartillas_delegado.updates[0];
        expect(update).not.toHaveProperty('fecha_rodeo');
        expect(update.secretario_jurado).toBe('PEDRO');
    });

    test('POST /:id/enviar — sigue exigiendo fecha_rodeo (garantizada por el auto-cálculo de creación, nunca por el Delegado)', async () => {
        crearSupabaseMock({
            cartillas_delegado: {
                data: {
                    id: 'cart-1', rodeo_id: 'rodeo-9', estado: 'borrador', delegado_id: 'delegado-1',
                    temporada: '2026-2027', fecha_rodeo: null, delegado_nombre: 'D',
                    tipo_rodeo: 'Provincial', historial_observaciones: []
                }, error: null
            }
        });
        const { status, body } = await llamarRuta({ method: 'POST', url: '/cart-1/enviar', body: {} });
        expect(status).toBe(422);
        expect(body.faltantes).toContain('fecha_rodeo');
    });
});

describe('Tipo de Rodeo — no debe concatenar Categoría (5ª revisión, punto 7)', () => {
    const fs = require('fs');
    const path = require('path');
    const leer = (rutaRelativa) => fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', rutaRelativa), 'utf8');

    test('el patrón de concatenación tipo_rodeo_nombre + categoria_rodeo_nombre NO existe en el formulario del Delegado', () => {
        const html = leer('frontend/usuario/cartilla-delegado.html');
        expect(html).not.toMatch(/tipo_rodeo_nombre,\s*rodeo\?\.categoria_rodeo_nombre/);
    });

    test('el patrón de concatenación NO existe en la vista Administrador', () => {
        const html = leer('frontend/admin/rodeos.html');
        expect(html).not.toMatch(/tipo_rodeo_nombre,\s*c\.rodeo\?\.categoria_rodeo_nombre/);
    });

    test('el patrón de concatenación NO existe en el PDF', () => {
        const js = leer('backend/src/services/cartilla-delegado-pdf.js');
        expect(js).not.toMatch(/tipo_rodeo_nombre,\s*rodeo\?\.categoria_rodeo_nombre/);
    });
});

describe('Series + Ganado unificados (4ª revisión) — un solo objeto por Serie dentro de respuestas_json.ganado_series', () => {
    test('un mismo objeto de serie guarda a la vez campos de colleras/vueltas (antes "Sección I") y de calidad/fuera de peso (antes "Sección II"), sin dividirse en estructuras separadas', async () => {
        const llamadas = crearSupabaseMock({
            cartillas_delegado: [
                { data: { id: 'cart-1', estado: 'borrador', delegado_id: 'delegado-1' }, error: null },
                { data: { id: 'cart-1' }, error: null }
            ]
        });
        const serieUnificada = {
            nombre: '1ra. Libre A',
            c1n: '5', c1g: 'A123', v1v: '3', v1t: 'Overo', v1p: '420',
            q1c: '2', q1r: '1', q1k: 'Bueno',
            fp_tot: '4', fp_baj: '1', fp_sob: '0',
            falta_hubo: 'si', falta_articulo: '242', falta_obs: 'Falta leve'
        };
        const { status } = await llamarRuta({
            method: 'PATCH', url: '/cart-1',
            body: { respuestas_json: { ganado_series: [serieUnificada] } }
        });
        expect(status).toBe(200);
        const guardada = llamadas.cartillas_delegado.updates[0].respuestas_json.ganado_series[0];
        // colleras/vueltas (antes "I. Series")
        expect(guardada.c1n).toBe('5');
        expect(guardada.v1t).toBe('Overo');
        // calidad/fuera de peso (antes "II. Ganado")
        expect(guardada.q1k).toBe('Bueno');
        expect(guardada.fp_baj).toBe('1');
        // faltas por serie — reutiliza el mismo objeto, no una selección de serie aparte
        expect(guardada.falta_articulo).toBe('242');
        expect(Object.keys(llamadas.cartillas_delegado.updates[0].respuestas_json)).toEqual(['ganado_series']); // ninguna estructura paralela nueva
    });

    test('cartilla antigua con series en formato previo (sin falta_hubo/falta_articulo/falta_obs) se recupera intacta, sin completarse artificialmente', async () => {
        crearSupabaseMock({
            asignaciones: [
                { data: ASIG_ACTIVA, error: null },
                { data: [], error: null }
            ],
            rodeos: { data: { id: 'r1', club: 'EL VALLE', asociacion: 'CURICÓ', fecha: '2026-09-05', tipo_rodeo_nombre: 'Provincial', temporada_id: 't1', temporadas: { nombre: '2026-2027' } }, error: null },
            usuarios_pagados: { data: { nombre_completo: 'DELEGADO X', telefono: '+56911111111' }, error: null },
            cartillas_delegado: {
                data: { id: 'cart-antigua', respuestas_json: { ganado_series: [{ nombre: 'Serie apertura', c1n: '4', v1t: 'Colorado', q1k: 'Regular' }] } },
                error: null
            }
        });
        const { status, body } = await llamarRuta({ method: 'GET', url: '/rodeo/r1' });
        expect(status).toBe(200);
        const serie = body.cartilla.respuestas_json.ganado_series[0];
        expect(serie.nombre).toBe('Serie apertura'); // nombre histórico fuera del catálogo nuevo, se conserva
        expect(serie.c1n).toBe('4');
        expect(serie.v1t).toBe('Colorado');
        expect(serie.q1k).toBe('Regular');
        expect(serie.falta_hubo).toBeUndefined(); // no se inventa el dato nuevo
    });
});

describe('Ganado bajo/sobrepeso reglamentario POR ANIMAL (5ª revisión, puntos 2-5) — extensión ADITIVA f1c..f4c, sin tocar fp_tot/fp_baj/fp_sob', () => {
    test('cada animal guarda su propia cantidad bajo/sobrepeso de forma independiente, dentro del mismo objeto de serie', async () => {
        const llamadas = crearSupabaseMock({
            cartillas_delegado: [
                { data: { id: 'cart-1', estado: 'borrador', delegado_id: 'delegado-1' }, error: null },
                { data: { id: 'cart-1' }, error: null }
            ]
        });
        const serie = {
            nombre: '1ra. Libre A',
            c1g: '25', f1c: '2',   // 1er animal: 25 cabezas, 2 fuera de peso
            c2g: '30', f2c: '0',   // 2do animal: 30 cabezas, 0 fuera de peso
            c3g: '20', f3c: '5',   // 3er animal: 20 cabezas, 5 fuera de peso
            c4g: '',   f4c: ''     // 4to animal: sin datos
        };
        const { status } = await llamarRuta({
            method: 'PATCH', url: '/cart-1',
            body: { respuestas_json: { ganado_series: [serie] } }
        });
        expect(status).toBe(200);
        const guardada = llamadas.cartillas_delegado.updates[0].respuestas_json.ganado_series[0];
        expect(guardada.f1c).toBe('2');
        expect(guardada.f2c).toBe('0');
        expect(guardada.f3c).toBe('5');
        expect(guardada.f4c).toBe('');
        // cada animal es independiente: cambiar uno no afecta a los demás
        expect(guardada.c1g).toBe('25');
        expect(guardada.c3g).toBe('20');
    });

    test('cartilla histórica con fp_tot/fp_baj/fp_sob (formato anterior, por Serie) se recupera intacta, sin transformarse a formato por animal', async () => {
        crearSupabaseMock({
            asignaciones: [
                { data: ASIG_ACTIVA, error: null },
                { data: [], error: null }
            ],
            rodeos: { data: { id: 'r1', club: 'EL VALLE', asociacion: 'CURICÓ', fecha: '2026-09-05', tipo_rodeo_nombre: 'Provincial', temporada_id: 't1', temporadas: { nombre: '2026-2027' } }, error: null },
            usuarios_pagados: { data: { nombre_completo: 'DELEGADO X', telefono: '+56911111111' }, error: null },
            cartillas_delegado: {
                data: { id: 'cart-antigua', respuestas_json: { ganado_series: [{ nombre: 'Serie apertura', fp_tot: '12', fp_baj: '2', fp_sob: '1' }] } },
                error: null
            }
        });
        const { status, body } = await llamarRuta({ method: 'GET', url: '/rodeo/r1' });
        expect(status).toBe(200);
        const serie = body.cartilla.respuestas_json.ganado_series[0];
        expect(serie.fp_tot).toBe('12');
        expect(serie.fp_baj).toBe('2');
        expect(serie.fp_sob).toBe('1');
        expect(serie.f1c).toBeUndefined(); // no se inventa el formato nuevo por animal
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
