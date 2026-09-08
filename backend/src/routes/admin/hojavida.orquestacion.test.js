// ═════════════════════════════════════════════════════════════════════════
// Tests de ORQUESTACIÓN DE RUTA — hojavida.js.
// Mismo patrón que propuesta-designacion.orquestacion.test.js: se invoca el
// router de Express directamente (sin servidor HTTP, sin supertest — ver
// `llamarRutaJson`/`llamarRutaExportar`) con un req/res mínimos hechos a mano.
//
// A diferencia del mock "por tabla, estático" de otros orquestacion.test.js,
// aquí se usa un mock de Supabase que SÍ aplica los filtros reales
// (.eq/.neq/.in/.ilike/.range) sobre un set de filas en memoria. Es necesario
// porque el objetivo explícito de esta batería es probar que "Altera
// resultado" nunca se mezcla entre jurados ni entre rodeos (CASO 5 y CASO 6)
// — con un mock que ignora los filtros no se podría distinguir un fallo real
// de aislamiento de un mock que simplemente devuelve todo.
//
// Enfoque: mejora "Altera resultado" en Hoja de Vida (agrega
// evaluaciones.resultados_alterados al historial de pantalla y al Excel,
// reutilizando la consulta a evaluaciones ya existente / agregando una
// consulta acotada equivalente en /exportar). No se prueba aquí la lógica ya
// existente de comparación/ranking entre pares — esos bloques están
// envueltos en try/catch en el propio archivo y toleran datos vacíos.
// ═════════════════════════════════════════════════════════════════════════
jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../services/auditoria', () => ({ registrar: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/exportacion', () => ({ exportarHistorialHojaVida: jest.fn() }));

const supabase = require('../../config/supabase');
const { exportarHistorialHojaVida } = require('../../services/exportacion');
const router = require('./hojavida');

// ─── Mock de Supabase con filtros reales sobre filas en memoria ───────────
function crearSupabaseMock(tablas) {
    supabase.from.mockImplementation((tabla) => {
        let rows = (tablas[tabla] || []).slice();
        let modoSingle = false;
        const chain = {
            select: () => chain,
            eq:  (campo, valor) => { rows = rows.filter(r => r[campo] === valor); return chain; },
            neq: (campo, valor) => { rows = rows.filter(r => r[campo] !== valor); return chain; },
            in:  (campo, valores) => { rows = rows.filter(r => valores.includes(r[campo])); return chain; },
            ilike: (campo, patron) => {
                const p = String(patron).replace(/%/g, '').toLowerCase();
                rows = rows.filter(r => String(r[campo] || '').toLowerCase().includes(p));
                return chain;
            },
            order: () => chain,
            limit: () => chain,
            range: (desde, hasta) => { rows = rows.slice(desde, hasta + 1); return chain; },
            single: () => { modoSingle = true; return chain; },
            maybeSingle: () => { modoSingle = true; return chain; },
            insert: () => chain,
            update: () => chain,
            then: (resolve, reject) => {
                const data = modoSingle ? (rows[0] || null) : rows;
                return Promise.resolve({ data, error: null }).then(resolve, reject);
            }
        };
        return chain;
    });
}

function llamarRutaJson({ method, url, params }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url,
            body: {}, query: {}, params: params || {}, headers: {},
            ip: '127.0.0.1',
            usuario: { id: 'admin-test', tipo: 'administrador' },
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

// GET /:id/exportar termina llamando exportarHistorialHojaVida (mockeada) en vez
// de escribir un .xlsx real — se captura su invocación por polling sobre res._ended,
// mismo patrón usado para exports binarios en este proyecto (sin servidor HTTP).
function llamarRutaExportar(uid) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'GET', url: `/${uid}/exportar`, originalUrl: `/${uid}/exportar`,
            body: {}, query: {}, params: { id: uid }, headers: {},
            ip: '127.0.0.1',
            usuario: { id: 'admin-test', tipo: 'administrador' },
            get() { return undefined; }
        };
        const res = { _ended: false, statusCode: 200, status(c) { this.statusCode = c; return this; }, json() { this._ended = true; return this; } };
        router(req, res, (err) => { if (err) reject(err); });
        const check = setInterval(() => {
            if (res._ended || exportarHistorialHojaVida.mock.calls.length > 0) { clearInterval(check); clearTimeout(fallback); resolve(); }
        }, 10);
        const fallback = setTimeout(() => { clearInterval(check); resolve(); }, 5000);
    });
}

beforeEach(() => {
    jest.clearAllMocks();
});

// ─── Fixture común ─────────────────────────────────────────────────────────
// Jurado 1: 3 rodeos → A (altera=true), B (altera=false), C (sin evaluación).
// Jurado 2: 1 rodeo D con su propia evaluación (altera=true) — sirve para
// CASO 5 (no mezclar entre jurados).
const PERFILES = [
    { id: 'jurado-1', codigo_interno: 'USR-0001', nombre_completo: 'Juan Pérez', rut: '1-9', tipo_persona: 'jurado', categoria: 'A', email: 'a@a.cl', telefono: null, ciudad: null, comuna: null, asociacion: 'Asoc X', activo: true, estado_usuario: 'activo', suspension_desde: null, suspension_hasta: null, suspension_motivo: null, created_at: '2026-01-01' },
    { id: 'jurado-2', codigo_interno: 'USR-0002', nombre_completo: 'Ana Soto', rut: '2-7', tipo_persona: 'jurado', categoria: 'A', email: 'b@b.cl', telefono: null, ciudad: null, comuna: null, asociacion: 'Asoc X', activo: true, estado_usuario: 'activo', suspension_desde: null, suspension_hasta: null, suspension_motivo: null, created_at: '2026-01-01' }
];

const ASIGNACIONES = [
    { id: 'asig-A', usuario_pagado_id: 'jurado-1', estado: 'activo', estado_designacion: 'confirmado', categoria_aplicada: 'A', valor_diario_aplicado: 100000, duracion_dias_aplicada: 1, pago_base_calculado: 100000, comentario_admin: null, created_at: '2026-01-10', rodeo_id: 'rodeo-A', rodeos: { id: 'rodeo-A', club: 'Club A', asociacion: 'Asoc X', fecha: '2026-03-01', tipo_rodeo_nombre: 'Provincial', duracion_dias: 1 } },
    { id: 'asig-B', usuario_pagado_id: 'jurado-1', estado: 'activo', estado_designacion: 'confirmado', categoria_aplicada: 'A', valor_diario_aplicado: 100000, duracion_dias_aplicada: 1, pago_base_calculado: 100000, comentario_admin: null, created_at: '2026-02-10', rodeo_id: 'rodeo-B', rodeos: { id: 'rodeo-B', club: 'Club B', asociacion: 'Asoc X', fecha: '2026-04-01', tipo_rodeo_nombre: 'Provincial', duracion_dias: 1 } },
    { id: 'asig-C', usuario_pagado_id: 'jurado-1', estado: 'activo', estado_designacion: 'confirmado', categoria_aplicada: 'A', valor_diario_aplicado: 100000, duracion_dias_aplicada: 1, pago_base_calculado: 100000, comentario_admin: null, created_at: '2026-03-10', rodeo_id: 'rodeo-C', rodeos: { id: 'rodeo-C', club: 'Club C', asociacion: 'Asoc X', fecha: '2026-05-01', tipo_rodeo_nombre: 'Provincial', duracion_dias: 1 } },
    { id: 'asig-D', usuario_pagado_id: 'jurado-2', estado: 'activo', estado_designacion: 'confirmado', categoria_aplicada: 'A', valor_diario_aplicado: 100000, duracion_dias_aplicada: 1, pago_base_calculado: 100000, comentario_admin: null, created_at: '2026-01-15', rodeo_id: 'rodeo-D', rodeos: { id: 'rodeo-D', club: 'Club D', asociacion: 'Asoc X', fecha: '2026-03-15', tipo_rodeo_nombre: 'Provincial', duracion_dias: 1 } }
];

const EVALUACIONES = [
    { id: 'eval-A', rodeo_id: 'rodeo-A', estado: 'publicado', resultados_alterados: true,  anulada: false },
    { id: 'eval-B', rodeo_id: 'rodeo-B', estado: 'publicado', resultados_alterados: false, anulada: false },
    // rodeo-C: sin fila en evaluaciones → sin análisis de caso.
    { id: 'eval-D', rodeo_id: 'rodeo-D', estado: 'publicado', resultados_alterados: true,  anulada: false }
];

function tablasBase() {
    return {
        usuarios_pagados: PERFILES,
        asignaciones: ASIGNACIONES,
        notas_rodeo: [],
        evaluaciones: EVALUACIONES,
        evaluacion_casos: [],
        fichas_internas: [],
        usuario_historial_cambios: []
    };
}

// ─── GET /:id — pantalla ───────────────────────────────────────────────────
describe('GET /:id — columna "Altera resultado" (historial)', () => {
    test('CASO 1/2/3/4: cada rodeo del jurado muestra su propio valor real (true/false/null), nunca "No" inventado', async () => {
        crearSupabaseMock(tablasBase());
        const { status, body } = await llamarRutaJson({ method: 'GET', url: '/jurado-1', params: { id: 'jurado-1' } });
        expect(status).toBe(200);

        const porRodeo = {};
        body.historial.forEach(h => { porRodeo[h.rodeos.id] = h.altera_resultado; });

        expect(porRodeo['rodeo-A']).toBe(true);   // CASO 1
        expect(porRodeo['rodeo-B']).toBe(false);  // CASO 2
        expect(porRodeo['rodeo-C']).toBeNull();   // CASO 3 — sin evaluación → null, no false
        expect(body.historial).toHaveLength(3);   // CASO 4 — las 3 filas del jurado presentes
    });

    test('CASO 5: no se mezclan resultados entre distintos jurados', async () => {
        crearSupabaseMock(tablasBase());
        const { body: bodyJ1 } = await llamarRutaJson({ method: 'GET', url: '/jurado-1', params: { id: 'jurado-1' } });
        const { body: bodyJ2 } = await llamarRutaJson({ method: 'GET', url: '/jurado-2', params: { id: 'jurado-2' } });

        // jurado-1 no debe traer el rodeo-D de jurado-2
        expect(bodyJ1.historial.some(h => h.rodeos.id === 'rodeo-D')).toBe(false);
        // jurado-2 solo trae su propio rodeo, con su propio valor
        expect(bodyJ2.historial).toHaveLength(1);
        expect(bodyJ2.historial[0].rodeos.id).toBe('rodeo-D');
        expect(bodyJ2.historial[0].altera_resultado).toBe(true);
    });

    test('CASO 6: no se mezclan resultados entre distintos rodeos del mismo jurado', async () => {
        crearSupabaseMock(tablasBase());
        const { body } = await llamarRutaJson({ method: 'GET', url: '/jurado-1', params: { id: 'jurado-1' } });
        const a = body.historial.find(h => h.rodeos.id === 'rodeo-A');
        const b = body.historial.find(h => h.rodeos.id === 'rodeo-B');
        expect(a.altera_resultado).toBe(true);
        expect(b.altera_resultado).toBe(false);
        expect(a.altera_resultado).not.toBe(b.altera_resultado);
    });

    test('evaluación anulada se trata igual que "sin evaluación" (null, no false)', async () => {
        const tablas = tablasBase();
        tablas.evaluaciones = [
            { id: 'eval-A', rodeo_id: 'rodeo-A', estado: 'publicado', resultados_alterados: true, anulada: true }
        ];
        crearSupabaseMock(tablas);
        const { body } = await llamarRutaJson({ method: 'GET', url: '/jurado-1', params: { id: 'jurado-1' } });
        const a = body.historial.find(h => h.rodeos.id === 'rodeo-A');
        expect(a.altera_resultado).toBeNull();
    });

    test('CASO 8 (regresión): situaciones, nota, estado y demás campos del historial siguen presentes', async () => {
        const tablas = tablasBase();
        tablas.notas_rodeo = [{ asignacion_id: 'asig-A', nota: 6.5, comentario: 'ok', evaluado_en: '2026-03-02', updated_by: 'admin-test' }];
        tablas.evaluacion_casos = [{ evaluacion_id: 'eval-A', tipo_caso: 'reglamentaria', anulado: false }];
        crearSupabaseMock(tablas);
        const { status, body } = await llamarRutaJson({ method: 'GET', url: '/jurado-1', params: { id: 'jurado-1' } });
        expect(status).toBe(200);
        const a = body.historial.find(h => h.rodeos.id === 'rodeo-A');
        expect(a.estado_designacion).toBe('confirmado');
        expect(a.pago_base_calculado).toBe(100000);
        expect(a.situaciones).toBe(1);
        expect(a.notas_rodeo.nota).toBe(6.5);
        expect(body.indicadores).toBeDefined();
        expect(body.resumen_situaciones).toBeDefined();
    });
});

// ─── GET /:id/exportar — Excel ──────────────────────────────────────────────
describe('GET /:id/exportar — columna "Altera resultado" en Excel', () => {
    test('CASO 1/2/3 + CASO 7: mismas filas y mismo valor que pantalla, ordenadas por fecha desc', async () => {
        crearSupabaseMock(tablasBase());
        exportarHistorialHojaVida.mockImplementation(async () => {});

        await llamarRutaExportar('jurado-1');

        expect(exportarHistorialHojaVida).toHaveBeenCalledTimes(1);
        const [perfil, filas, resumen] = exportarHistorialHojaVida.mock.calls[0];
        expect(perfil.id).toBe('jurado-1');
        expect(filas).toHaveLength(3); // mismas 3 filas que pantalla (CASO 7)

        const porFecha = {};
        filas.forEach(f => { porFecha[f.fecha] = f; });
        expect(porFecha['2026-03-01'].altera_resultado).toBe(true);   // rodeo-A, CASO 1
        expect(porFecha['2026-04-01'].altera_resultado).toBe(false);  // rodeo-B, CASO 2
        expect(porFecha['2026-05-01'].altera_resultado).toBeNull();   // rodeo-C, CASO 3

        // Orden descendente por fecha, igual que la pantalla (renderHistorial ordena desc)
        const fechas = filas.map(f => f.fecha);
        const ordenadas = [...fechas].sort((x, y) => y.localeCompare(x));
        expect(fechas).toEqual(ordenadas);

        expect(resumen).toBeDefined();
    });

    test('CASO 5 (Excel): no mezcla jurados', async () => {
        crearSupabaseMock(tablasBase());
        exportarHistorialHojaVida.mockImplementation(async () => {});
        await llamarRutaExportar('jurado-2');
        const [perfil, filas] = exportarHistorialHojaVida.mock.calls[0];
        expect(perfil.id).toBe('jurado-2');
        expect(filas).toHaveLength(1);
        expect(filas[0].club).toBe('Club D');
        expect(filas[0].altera_resultado).toBe(true);
    });
});
