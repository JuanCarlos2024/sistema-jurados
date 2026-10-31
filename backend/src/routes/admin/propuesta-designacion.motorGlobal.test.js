// ═════════════════════════════════════════════════════════════════════════
// Tests de ORQUESTACIÓN DE RUTA — Fase 2B: integración del motor GLOBAL con
// POST /dry-run (sección 3 del pedido) y el bloqueo de aplicación cuando
// faltan cupos en POST /propuestas/:id/aplicar (sección 4 del pedido).
//
// Mismo patrón exacto que propuesta-designacion.orquestacion.test.js
// (llamarRuta sin supertest, mock genérico de Supabase por tabla) — no se
// repite esa cobertura ya existente (Etapa 3/4 completas), solo lo nuevo de
// Fase 2B.
// ═════════════════════════════════════════════════════════════════════════
const express = require('express'); // eslint-disable-line no-unused-vars -- mismo patrón que el archivo hermano

jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
jest.mock('../../services/motorPropuestaDesignacion', () => {
    const real = jest.requireActual('../../services/motorPropuestaDesignacion');
    return { ...real, cargarDatosMotor: jest.fn(), ejecutarSimulacion: jest.fn(), generarSimulacion: jest.fn(), evaluarCandidatoDirecto: jest.fn() };
});
jest.mock('../../services/motorPropuestaDesignacionGlobal', () => ({ generarSimulacionGlobal: jest.fn() }));
jest.mock('../../services/configuracionDesignacionRepositorio', () => ({
    cargarConfiguracionDesignacionActiva: jest.fn(),
    cargarConfiguracionDesignacionPorId: jest.fn()
}));

const supabase = require('../../config/supabase');
const { generarSimulacion } = require('../../services/motorPropuestaDesignacion');
const { generarSimulacionGlobal } = require('../../services/motorPropuestaDesignacionGlobal');
const { cargarConfiguracionDesignacionActiva } = require('../../services/configuracionDesignacionRepositorio');
const { construirConfiguracionDefaultV1 } = require('../../services/configuracionDesignacion');
const router = require('./propuesta-designacion');

const CONFIG_V1 = construirConfiguracionDefaultV1();
const META_V1 = { id: 'v1-uuid', numero_version: 1, schema_version: 1 };

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
            else resolve({ status: 404, body: { error: 'ruta no encontrada' } });
        });
    });
}

function crearSupabaseMock(porTabla) {
    const llamadas = {};
    const consumir = (tabla) => {
        const entrada = porTabla[tabla];
        if (entrada === undefined) return { data: [], error: null };
        if (Array.isArray(entrada)) return entrada.length > 1 ? entrada.shift() : entrada[0];
        return entrada;
    };
    supabase.from.mockImplementation((tabla) => {
        llamadas[tabla] = llamadas[tabla] || { inserts: [], updates: [], deletes: 0 };
        const chain = {
            select: () => chain, eq: () => chain, neq: () => chain, in: () => chain, is: () => chain,
            ilike: () => chain, order: () => chain, limit: () => chain, range: () => chain,
            insert: (payload) => { llamadas[tabla].inserts.push(payload); return chain; },
            update: (payload) => { llamadas[tabla].updates.push(payload); return chain; },
            delete: () => { llamadas[tabla].deletes++; return chain; },
            maybeSingle: () => Promise.resolve(consumir(tabla)),
            single: () => Promise.resolve(consumir(tabla)),
            then: (resolve) => Promise.resolve(consumir(tabla)).then(resolve)
        };
        return chain;
    });
    return llamadas;
}

beforeEach(() => jest.clearAllMocks());

describe('POST /dry-run — selección de motor (Fase 2B, sección 3)', () => {
    test('sin "motor" en el body -> usa el motor LOCAL (generarSimulacion), nunca el global, por defecto', async () => {
        crearSupabaseMock({
            temporadas: { data: { id: 't1' }, error: null },
            rodeos: { data: [], error: null }
        });
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        generarSimulacion.mockResolvedValue({ resumen: {}, resultados: [], temporada: 'T', metricas: {} });

        const { status } = await llamarRuta({ method: 'POST', url: '/dry-run', body: { rodeo_ids: ['r1'] } });

        expect(status).toBe(200);
        expect(generarSimulacion).toHaveBeenCalledWith(['r1'], 5, CONFIG_V1);
        expect(generarSimulacionGlobal).not.toHaveBeenCalled();
    });

    test('motor:"global" -> usa generarSimulacionGlobal, nunca generarSimulacion, y el resultado (con optimizacion_global) llega intacto en la respuesta', async () => {
        crearSupabaseMock({
            temporadas: { data: { id: 't1' }, error: null },
            rodeos: { data: [], error: null }
        });
        cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: CONFIG_V1, meta: META_V1 });
        const resultadoGlobal = {
            resumen: { rodeos_solicitados: 1, propuestos: 1, sin_propuesta: 0, no_evaluables: 0, candidatos_analizados: 1 },
            resultados: [{ rodeo_id: 'r1', estado: 'PROPUESTO', jurado_propuesto: { jurado_id: 'j1' } }],
            temporada: 'T', metricas: {},
            motor: 'GLOBAL',
            optimizacion_global: { aplicada: true, estado_busqueda: 'COBERTURA_COMPLETA', total_cupos: 1, cobertura_obtenida: 1, cupos_pendientes: 0, advertencias: [] },
            cobertura_completa: true
        };
        generarSimulacionGlobal.mockResolvedValue(resultadoGlobal);

        const { status, body } = await llamarRuta({ method: 'POST', url: '/dry-run', body: { rodeo_ids: ['r1'], motor: 'global' } });

        expect(status).toBe(200);
        expect(generarSimulacionGlobal).toHaveBeenCalledWith(['r1'], 5, CONFIG_V1);
        expect(generarSimulacion).not.toHaveBeenCalled();
        expect(body.motor).toBe('GLOBAL');
        expect(body.cobertura_completa).toBe(true);
        expect(body.optimizacion_global.estado_busqueda).toBe('COBERTURA_COMPLETA');
        expect(body.preview_token).toBeTruthy(); // mismo mecanismo de firma, sin cambios
    });

    test('motor con un valor inválido -> 400 explícito, ningún motor se ejecuta', async () => {
        const { status, body } = await llamarRuta({ method: 'POST', url: '/dry-run', body: { rodeo_ids: ['r1'], motor: 'rapido' } });

        expect(status).toBe(400);
        expect(body.error).toMatch(/motor inválido/);
        expect(generarSimulacion).not.toHaveBeenCalled();
        expect(generarSimulacionGlobal).not.toHaveBeenCalled();
    });
});

describe('POST /propuestas/:id/aplicar — bloqueo si faltan cupos (Fase 2B, sección 4)', () => {
    test('propuesta con un rodeo SIN_PROPUESTA mezclado con filas ACEPTADO -> 409, no se consulta rodeos/jurados/asignaciones, nada se inserta', async () => {
        const llamadas = crearSupabaseMock({
            propuestas_designacion: { data: { id: 'prop-incompleta', estado: 'BORRADOR', temporada_id: 't1' }, error: null },
            propuestas_designacion_detalle: {
                data: [
                    { id: 'd1', rodeo_id: 'r1', jurado_id_seleccionado: 'j1', jurado_id_propuesto: 'j1', estado_revision: 'ACEPTADO' },
                    { id: 'd2', rodeo_id: 'r2', jurado_id_seleccionado: null, jurado_id_propuesto: null, estado_revision: 'SIN_PROPUESTA' }
                ], error: null
            }
        });

        const { status, body } = await llamarRuta({ method: 'POST', url: '/propuestas/prop-incompleta/aplicar' });

        expect(status).toBe(409);
        expect(body.error).toMatch(/cupos incompletos/);
        expect(body.rodeos_sin_cupo).toEqual(['r2']);
        expect(llamadas.rodeos).toBeUndefined();
        expect(llamadas.usuarios_pagados).toBeUndefined();
        expect(llamadas.asignaciones).toBeUndefined();
    });

    test('propuesta con un rodeo NO_EVALUABLE -> igualmente bloqueada (ni evaluable ni evaluado tiene jurado)', async () => {
        crearSupabaseMock({
            propuestas_designacion: { data: { id: 'prop-no-eval', estado: 'BORRADOR', temporada_id: 't1' }, error: null },
            propuestas_designacion_detalle: {
                data: [{ id: 'd1', rodeo_id: 'r1', jurado_id_seleccionado: null, jurado_id_propuesto: null, estado_revision: 'NO_EVALUABLE' }], error: null
            }
        });

        const { status, body } = await llamarRuta({ method: 'POST', url: '/propuestas/prop-no-eval/aplicar' });

        expect(status).toBe(409);
        expect(body.rodeos_sin_cupo).toEqual(['r1']);
    });

    test('propuesta donde el motor global dejó una fila SIN_JURADO_ACTUAL (jurado movido a otra fila) -> también bloqueada', async () => {
        crearSupabaseMock({
            propuestas_designacion: { data: { id: 'prop-movido', estado: 'BORRADOR', temporada_id: 't1' }, error: null },
            propuestas_designacion_detalle: {
                data: [
                    { id: 'd1', rodeo_id: 'r1', jurado_id_seleccionado: 'j1', jurado_id_propuesto: 'j1', estado_revision: 'ACEPTADO' },
                    { id: 'd2', rodeo_id: 'r2', jurado_id_seleccionado: null, jurado_id_propuesto: 'j1', estado_revision: 'SIN_JURADO_ACTUAL' }
                ], error: null
            }
        });

        const { status, body } = await llamarRuta({ method: 'POST', url: '/propuestas/prop-movido/aplicar' });

        expect(status).toBe(409);
        expect(body.rodeos_sin_cupo).toEqual(['r2']);
    });

    // Fase 2C, sección 6 — corrección: antes de esta fase, una fila PENDIENTE
    // pasaba el chequeo de "cupos completos" (tiene jurado_id_propuesto) pero
    // LUEGO se excluía en silencio de `aplicables` — la respuesta mostraba
    // "1 aplicada, 0 conflictos" sin mencionar que d2 (con jurado efectivo
    // real) jamás se aplicó. Eso es exactamente la "parcialidad silenciosa"
    // que la Fase 2C pide evitar. Ahora TODA fila con jurado efectivo se
    // aplica (vía obtenerJuradoEfectivo), y la respuesta marca con
    // revisado_por_admin:false la que se aplicó por sugerencia del motor sin
    // revisión explícita — nunca de forma indistinguible de una ACEPTADO.
    test('una fila PENDIENTE (sugerencia del motor sin revisar) NO cuenta como cupo faltante y SÍ se aplica, marcada como no revisada por el administrador', async () => {
        const llamadas = crearSupabaseMock({
            propuestas_designacion: { data: { id: 'prop-mixta', estado: 'BORRADOR', temporada_id: 't1' }, error: null },
            propuestas_designacion_detalle: {
                data: [
                    { id: 'd1', rodeo_id: 'r1', jurado_id_seleccionado: 'j1', jurado_id_propuesto: 'j1', estado_revision: 'ACEPTADO' },
                    { id: 'd2', rodeo_id: 'r2', jurado_id_seleccionado: null, jurado_id_propuesto: 'j2', estado_revision: 'PENDIENTE' }
                ], error: null
            },
            rodeos: {
                data: [
                    { id: 'r1', club: 'Club A', fecha: '2026-05-01', duracion_dias: 1, estado: 'activo' },
                    { id: 'r2', club: 'Club B', fecha: '2026-05-10', duracion_dias: 1, estado: 'activo' }
                ], error: null
            },
            usuarios_pagados: {
                data: [
                    { id: 'j1', nombre_completo: 'Juan Perez', categoria: 'A', tipo_persona: 'jurado', activo: true },
                    { id: 'j2', nombre_completo: 'Maria Soto', categoria: 'A', tipo_persona: 'jurado', activo: true }
                ], error: null
            },
            disponibilidad_usuarios: { data: [{ usuario_pagado_id: 'j1', fecha: '2026-05-01' }, { usuario_pagado_id: 'j2', fecha: '2026-05-10' }], error: null },
            configuracion_tarifas: { data: [{ categoria: 'A', valor_diario: 100000 }], error: null },
            asignaciones: [
                { data: [], error: null }, // SELECT ya-aplicadas — ninguna
                { data: [], error: null }, // SELECT ya-designados
                { data: [], error: null } // SELECT otras fechas del jurado
            ]
        });
        supabase.rpc.mockResolvedValueOnce({
            data: {
                aplicadas: [
                    { detalle_id: 'd1', asignacion_id: 'asig-1', rodeo_id: 'r1', usuario_pagado_id: 'j1', bitacora_id: 'bit-1' },
                    { detalle_id: 'd2', asignacion_id: 'asig-2', rodeo_id: 'r2', usuario_pagado_id: 'j2', bitacora_id: 'bit-2' }
                ]
            },
            error: null
        });

        const { status, body } = await llamarRuta({ method: 'POST', url: '/propuestas/prop-mixta/aplicar' });

        expect(status).toBe(200);
        expect(body.resumen).toEqual({ aplicadas: 2, conflictos: 0 });
        expect(supabase.rpc).toHaveBeenCalledTimes(1); // UN solo lote atómico, nunca una RPC por fila
        expect(llamadas.asignaciones.inserts.length).toBe(0); // vía RPC, nunca INSERT directo
        const d1Aplicada = body.aplicadas.find(a => a.rodeo_id === 'r1');
        const d2Aplicada = body.aplicadas.find(a => a.rodeo_id === 'r2');
        expect(d1Aplicada.revisado_por_admin).toBe(true); // ACEPTADO — decisión explícita
        expect(d2Aplicada.revisado_por_admin).toBe(false); // PENDIENTE — sugerencia del motor, nunca ocultado
    });
});

describe('POST /propuestas/:id/aplicar — mutex de aplicación (Fase 2C, sección 6)', () => {
    test('una segunda aplicación simultánea de la MISMA propuesta recibe 409 explícito, nunca corre el loop en paralelo', async () => {
        const llamadas = crearSupabaseMock({
            propuestas_designacion: [
                { data: { id: 'prop-mutex', estado: 'BORRADOR', temporada_id: 't1' }, error: null }, // SELECT inicial
                { data: null, error: null } // UPDATE condicional de reclamo: no encontró fila libre -> ya está en curso
            ]
        });

        const { status, body } = await llamarRuta({ method: 'POST', url: '/propuestas/prop-mutex/aplicar' });

        expect(status).toBe(409);
        expect(body.code).toBe('APLICACION_EN_CURSO');
        expect(llamadas.propuestas_designacion_detalle).toBeUndefined(); // nunca llegó a leer el detalle
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('el mutex se libera siempre, incluso cuando la aplicación termina en cupos incompletos', async () => {
        const llamadas = crearSupabaseMock({
            propuestas_designacion: { data: { id: 'prop-libera', estado: 'BORRADOR', temporada_id: 't1' }, error: null },
            propuestas_designacion_detalle: {
                data: [{ id: 'd1', rodeo_id: 'r1', jurado_id_seleccionado: null, jurado_id_propuesto: null, estado_revision: 'SIN_PROPUESTA' }], error: null
            }
        });

        const { status } = await llamarRuta({ method: 'POST', url: '/propuestas/prop-libera/aplicar' });

        expect(status).toBe(409);
        const updatesLiberacion = llamadas.propuestas_designacion.updates.filter(u => u.aplicacion_en_curso_desde === null);
        expect(updatesLiberacion.length).toBe(1); // el finally liberó el mutex aunque la respuesta fuera 409
    });
});
