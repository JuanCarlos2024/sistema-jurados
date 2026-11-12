// ═════════════════════════════════════════════════════════════════════════
// Revisión administrativa de propuestas (2026-11-11):
//   - Guardar un borrador NUNCA aprueba nada (causa raíz de la propuesta
//     27c6bc5d…: 9 ACEPTADO/MOTOR + 16 MODIFICADO/MANUAL_CON_ADVERTENCIA
//     sin acción administrativa).
//   - Orden de presentación estable y persistido.
//   - Confirmación expresa → ACEPTADO con autor/fecha; revertir conserva historial.
// Mismo patrón de mocks que propuesta-designacion.fase2c.test.js:
// previewIntegridad REAL, Supabase simulado que registra INSERT/UPDATE.
// ═════════════════════════════════════════════════════════════════════════
jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
jest.mock('../../services/motorPropuestaDesignacion', () => {
    const real = jest.requireActual('../../services/motorPropuestaDesignacion');
    return { ...real, cargarDatosMotor: jest.fn(), ejecutarSimulacion: jest.fn(), generarSimulacion: jest.fn(), evaluarCandidatoDirecto: jest.fn() };
});
jest.mock('../../services/configuracionDesignacionRepositorio', () => ({
    cargarConfiguracionDesignacionActiva: jest.fn(),
    cargarConfiguracionDesignacionPorId: jest.fn()
}));

const supabase = require('../../config/supabase');
const { cargarDatosMotor, ejecutarSimulacion, evaluarCandidatoDirecto } = require('../../services/motorPropuestaDesignacion');
const { cargarConfiguracionDesignacionPorId } = require('../../services/configuracionDesignacionRepositorio');
const { firmarPreview } = require('../../services/previewIntegridad');
const { construirConfiguracionDefaultV1 } = require('../../services/configuracionDesignacion');
const { resumenPropuesta } = require('../../services/propuestaDesignacion');
const router = require('./propuesta-designacion');

const CONFIG = construirConfiguracionDefaultV1();
const META = { id: 'v12-uuid', numero_version: 12, schema_version: 4 };

function llamarRuta({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, body: body || {}, query: {}, params: {}, headers: {}, ip: '127.0.0.1',
            usuario: { id: 'admin-1', tipo: 'administrador', rol_evaluacion: null }, get() { return undefined; }
        };
        const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(p) { resolve({ status: this.statusCode, body: p }); return this; } };
        router(req, res, err => (err ? reject(err) : resolve({ status: 404, body: {} })));
    });
}

function crearSupabaseMock(porTabla) {
    const llamadas = {};
    const consumir = tabla => {
        const e = porTabla[tabla];
        if (e === undefined) return { data: [], error: null };
        const valor = Array.isArray(e) ? (e.length > 1 ? e.shift() : e[0]) : e;
        return typeof valor === 'function' ? valor(llamadas[tabla]) : valor;
    };
    supabase.from.mockImplementation(tabla => {
        llamadas[tabla] = llamadas[tabla] || { inserts: [], updates: [] };
        const chain = {
            select: () => chain, eq: () => chain, neq: () => chain, in: () => chain, is: () => chain,
            ilike: () => chain, order: () => chain, limit: () => chain, range: () => chain,
            insert: p => { llamadas[tabla].inserts.push(p); chain._insert = p; return chain; },
            update: p => { llamadas[tabla].updates.push(p); return chain; },
            delete: () => chain, single: () => chain, maybeSingle: () => chain,
            then: (ok, ko) => Promise.resolve(consumir(tabla)).then(ok, ko)
        };
        return chain;
    });
    return llamadas;
}

beforeEach(() => jest.clearAllMocks());

// 25 rodeos como el caso real: 9 sin advertencias, 16 elegidos por el
// optimizador global relajando preferencias flexibles.
const N = 25;
const RELAJADOS = new Set(Array.from({ length: 16 }, (_, i) => i + 9));
const rodeoId = i => `r${String(i + 1).padStart(2, '0')}`;
const juradoId = i => `j${String(i + 1).padStart(2, '0')}`;
const fechaRodeo = i => `2026-12-${String(1 + (i % 27)).padStart(2, '0')}`;

function escenarioGuardado(estadoTemporalPorIndice = () => ({})) {
    const token = firmarPreview({
        temporada_id: 't1', configuracion_version_id: META.id, motor: 'global',
        fecha_corte_tecnica: '2026-11-11T13:16:00.000Z',
        cobertura_resumen: { estado_busqueda: 'COBERTURA_COMPLETA', total_cupos: N, cobertura_obtenida: N, cupos_pendientes: 0, cobertura_completa: true },
        rodeos: Array.from({ length: N }, (_, i) => ({ rodeo_id: rodeoId(i), estado: 'PROPUESTO', jurado_id_propuesto: juradoId(i) }))
    });
    cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG, meta: META });
    const rodeos = Array.from({ length: N }, (_, i) => ({ id: rodeoId(i), club: `Club ${i + 1}`, fecha: fechaRodeo(i), asociacion: `Asoc ${i + 1}`, tipo_rodeo_nombre: 'Provincial', duracion_dias: 1 }));
    cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map(rodeos.map(r => [r.id, r])) });
    ejecutarSimulacion.mockReturnValue({
        resultados: Array.from({ length: N }, (_, i) => ({
            rodeo_id: rodeoId(i), estado: 'PROPUESTO', candidatos_evaluados: 10, candidatos_potenciales_bd: 10, descartes: 0,
            jurado_propuesto: {
                jurado_id: juradoId(i), nombre: `Jurado ${i + 1}`,
                ...(RELAJADOS.has(i) ? { optimizacion_global_forzado: true, optimizacion_global_relajaciones: ['FINDE_CONSECUTIVO'] } : {})
            },
            top_candidatos: []
        }))
    });
    evaluarCandidatoDirecto.mockImplementation((ctx, rid) => {
        const i = Number(rid.slice(1)) - 1;
        return { evaluacion: { causas: RELAJADOS.has(i) ? ['FINDE_CONSECUTIVO'] : [], distanciaKm: 100, jurado: { categoria: 'A', asociacion: `Otra ${i}` } } };
    });
    const llamadas = crearSupabaseMock({
        propuestas_designacion_detalle: [
            { data: [], error: null }, // rodeos ya en otra propuesta
            // INSERT ... select(): devuelve lo insertado (con ids)
            l => ({ data: (l.inserts[0] || []).map((f, k) => ({ id: `det-${k}`, ...f })), error: null })
        ],
        propuestas_designacion: { data: { id: '27c6bc5d-3333-4819-a0a1-80fe1cd9abe4', estado: 'BORRADOR', created_at: '2026-11-11T13:16:36Z' }, error: null },
        rodeos: { data: rodeos, error: null }
    });
    const estado_temporal = Array.from({ length: N }, (_, i) => ({
        rodeo_id: rodeoId(i), estado_revision: 'PENDIENTE', jurado_id_seleccionado: null, origen_seleccion: null,
        metricas_json: RELAJADOS.has(i) ? { advertencias_aceptadas: [{ tipo: 'FINDE_CONSECUTIVO', origen: 'REGLA_MOTOR' }] } : {},
        ...estadoTemporalPorIndice(i)
    }));
    return { token, estado_temporal, llamadas };
}

describe('Etapa 1 — guardar el borrador NO es una aprobación administrativa', () => {
    test('25 filas del motor (9 sin advertencias + 16 con relajaciones) → 25 PENDIENTE, ninguna ACEPTADO/MODIFICADO', async () => {
        const { token, estado_temporal, llamadas } = escenarioGuardado();
        const { status } = await llamarRuta({ method: 'POST', url: '/propuestas', body: { preview_token: token, estado_temporal } });
        expect(status).toBe(201);

        const filas = llamadas.propuestas_designacion_detalle.inserts[0];
        expect(filas).toHaveLength(N);
        expect(filas.every(f => f.estado_revision === 'PENDIENTE')).toBe(true);
        expect(filas.every(f => f.origen_seleccion === null && f.jurado_id_seleccionado === null)).toBe(true);
        expect(filas.every((f, i) => f.jurado_id_propuesto === juradoId(i))).toBe(true); // historial original intacto
        expect(filas.some(f => f.metricas_json.revision_administrativa)).toBe(false);
    });

    test('las relajaciones del optimizador se conservan como advertencias del MOTOR (no como modificación manual)', async () => {
        const { token, estado_temporal, llamadas } = escenarioGuardado();
        await llamarRuta({ method: 'POST', url: '/propuestas', body: { preview_token: token, estado_temporal } });
        const filas = llamadas.propuestas_designacion_detalle.inserts[0];
        const relajadas = filas.filter((f, i) => RELAJADOS.has(i));
        expect(relajadas).toHaveLength(16);
        relajadas.forEach(f => {
            expect(f.estado_revision).toBe('PENDIENTE');
            expect(f.metricas_json.advertencias_aceptadas.map(a => a.tipo)).toEqual(['FINDE_CONSECUTIVO']);
        });
    });

    test('cobertura 25/25 no implica 25 aceptaciones', async () => {
        const { token, estado_temporal, llamadas } = escenarioGuardado();
        await llamarRuta({ method: 'POST', url: '/propuestas', body: { preview_token: token, estado_temporal } });
        const r = resumenPropuesta(llamadas.propuestas_designacion_detalle.inserts[0]);
        expect(r).toMatchObject({ cupos_cubiertos: 25, cobertura_completa: true, confirmados: 0, modificados: 0, pendientes_revision: 25, con_advertencias_motor: 16 });
    });

    test('no se atribuye al administrador ninguna acción automática: sin auditoría individual de filas', async () => {
        const { token, estado_temporal, llamadas } = escenarioGuardado();
        await llamarRuta({ method: 'POST', url: '/propuestas', body: { preview_token: token, estado_temporal } });
        const audits = (llamadas.auditoria?.inserts || []);
        expect(audits.filter(a => a.tabla === 'propuestas_designacion_detalle')).toHaveLength(0);
        expect(audits.filter(a => a.tabla === 'propuestas_designacion' && a.accion === 'crear')).toHaveLength(1);
    });

    test('decisiones REALES del preview sí se conservan: confirmar → ACEPTADO/MOTOR; cambiar jurado → MODIFICADO; ambas auditadas', async () => {
        const { token, estado_temporal, llamadas } = escenarioGuardado(i => {
            if (i === 0) return { estado_revision: 'ACEPTADO', jurado_id_seleccionado: juradoId(0) };
            if (i === 1) return { estado_revision: 'MODIFICADO', jurado_id_seleccionado: 'j-otro' };
            return {};
        });
        const { status } = await llamarRuta({ method: 'POST', url: '/propuestas', body: { preview_token: token, estado_temporal } });
        expect(status).toBe(201);
        const filas = llamadas.propuestas_designacion_detalle.inserts[0];
        expect(filas[0]).toMatchObject({ estado_revision: 'ACEPTADO', origen_seleccion: 'MOTOR', jurado_id_seleccionado: juradoId(0) });
        expect(filas[0].metricas_json.revision_administrativa).toMatchObject({ accion: 'CONFIRMAR', actor_id: 'admin-1', en_vista_previa: true });
        expect(filas[1]).toMatchObject({ estado_revision: 'MODIFICADO', origen_seleccion: 'MANUAL', jurado_id_seleccionado: 'j-otro', jurado_id_propuesto: juradoId(1) });
        expect(filas.slice(2).every(f => f.estado_revision === 'PENDIENTE')).toBe(true);
        const auditsFila = llamadas.auditoria.inserts.filter(a => a.tabla === 'propuestas_designacion_detalle');
        expect(auditsFila.map(a => a.datos_nuevos.estado_revision).sort()).toEqual(['ACEPTADO', 'MODIFICADO']);
    });
});

describe('Etapa 2 — orden de presentación estable', () => {
    test('al guardar se persiste orden_presentacion = posición firmada en el preview', async () => {
        const { token, estado_temporal, llamadas } = escenarioGuardado();
        await llamarRuta({ method: 'POST', url: '/propuestas', body: { preview_token: token, estado_temporal: estado_temporal.slice().reverse() } });
        const filas = llamadas.propuestas_designacion_detalle.inserts[0];
        filas.forEach(f => expect(f.metricas_json.orden_presentacion).toBe(Number(f.rodeo_id.slice(1)) - 1));
    });

    function detalleBD(i, extra = {}) {
        return {
            id: `det-${i}`, rodeo_id: rodeoId(i), jurado_id_propuesto: juradoId(i), jurado_id_seleccionado: null,
            estado_revision: 'PENDIENTE', origen_seleccion: null, explicacion_json: {}, metricas_json: { orden_presentacion: i },
            created_at: '2026-11-11T13:16:36Z', updated_at: '2026-11-11T13:16:36Z',
            rodeos: { club: `Club ${i + 1}`, fecha: fechaRodeo(i), asociacion: 'A', tipo_rodeo_nombre: 'P', tipos_rodeo: null, comunas_chile: null }, ...extra
        };
    }
    async function abrir(detalles, bitacora = []) {
        crearSupabaseMock({
            propuestas_designacion: { data: { id: 'p1', estado: 'BORRADOR', created_at: '2026-11-11T13:16:36Z', configuracion_version_id: null }, error: null },
            propuestas_designacion_detalle: { data: detalles, error: null },
            bitacora_designaciones: { data: bitacora, error: null },
            usuarios_pagados: { data: [], error: null },
            asignaciones: { data: [], error: null }
        });
        return (await llamarRuta({ method: 'GET', url: '/propuestas/p1' })).body;
    }

    test('25 rodeos devueltos en orden aleatorio por la BD → se muestran en el orden estable, con posición 1..25', async () => {
        const desordenados = Array.from({ length: N }, (_, i) => detalleBD(i)).sort(() => 0.5 - Math.random());
        const body = await abrir(desordenados);
        expect(body.detalle.map(d => d.rodeo_id)).toEqual(Array.from({ length: N }, (_, i) => rodeoId(i)));
        expect(body.detalle.map(d => d.posicion)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    });

    test('modificar la fila 5 (updated_at reciente, estado distinto) no cambia el orden de ninguna otra', async () => {
        const filas = Array.from({ length: N }, (_, i) => detalleBD(i));
        filas[4] = { ...filas[4], estado_revision: 'MODIFICADO', jurado_id_seleccionado: 'j-otro', updated_at: '2026-11-12T00:00:00Z' };
        const antes = (await abrir(Array.from({ length: N }, (_, i) => detalleBD(i)))).detalle.map(d => d.rodeo_id);
        const despues = (await abrir(filas.slice().reverse())).detalle.map(d => d.rodeo_id);
        expect(despues).toEqual(antes);
        expect(despues[4]).toBe(rodeoId(4));
    });

    test('borrador antiguo sin orden guardado → orden determinista por fecha, club e id (nunca por estado ni updated_at)', async () => {
        const viejos = [
            detalleBD(2, { metricas_json: {}, rodeos: { club: 'B', fecha: '2026-12-05' }, estado_revision: 'ACEPTADO', jurado_id_seleccionado: 'j03' }),
            detalleBD(0, { metricas_json: {}, rodeos: { club: 'Z', fecha: '2026-12-01' } }),
            detalleBD(1, { metricas_json: {}, rodeos: { club: 'A', fecha: '2026-12-05' } }),
        ];
        const body = await abrir(viejos);
        expect(body.detalle.map(d => d.id)).toEqual(['det-0', 'det-1', 'det-2']);
    });

    test('"Ver historial" solo con evidencia: movimientos en bitácora o jurado realmente cambiado', async () => {
        const filas = [
            detalleBD(0, { estado_revision: 'MODIFICADO', jurado_id_seleccionado: juradoId(0) }), // estado falso, sin evidencia
            detalleBD(1, { estado_revision: 'MODIFICADO', jurado_id_seleccionado: 'j-otro' }),
            detalleBD(2)
        ];
        const body = await abrir(filas, [{ propuesta_detalle_id: 'det-2' }]);
        const ev = Object.fromEntries(body.detalle.map(d => [d.id, d.historial_evidencia]));
        expect(ev['det-0']).toEqual({ movimientos_bitacora: 0, jurado_cambiado: false });
        expect(ev['det-1']).toEqual({ movimientos_bitacora: 0, jurado_cambiado: true });
        expect(ev['det-2']).toEqual({ movimientos_bitacora: 1, jurado_cambiado: false });
    });
});

describe('Etapa 3 — confirmación expresa y reversión', () => {
    function base(detalle, respuestaUpdate) {
        cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG, meta: META });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-12-01', asociacion: 'Asoc', duracion_dias: 1 }]]) });
        evaluarCandidatoDirecto.mockReturnValue({ evaluacion: { causas: [], distanciaKm: 10, jurado: { id: 'j1', nombre_completo: 'Jurado Uno', categoria: 'A', asociacion: 'Otra' } } });
        return crearSupabaseMock({
            propuestas_designacion: { data: { id: 'p1', estado: 'BORRADOR', configuracion_version_id: META.id }, error: null },
            propuestas_designacion_detalle: [
                { data: detalle, error: null },
                { data: detalle, error: null },
                { data: [], error: null },
                respuestaUpdate || { data: { ...detalle, estado_revision: 'ACEPTADO' }, error: null }
            ]
        });
    }

    test('Confirmar jurado propuesto → ACEPTADO con autor y fecha; conserva jurado, orden y advertencias del motor', async () => {
        const detalle = { id: 'd1', rodeo_id: 'r1', jurado_id_propuesto: 'j1', jurado_id_seleccionado: null, estado_revision: 'PENDIENTE', metricas_json: { orden_presentacion: 4 } };
        const llamadas = base(detalle);
        const { status } = await llamarRuta({ method: 'POST', url: '/propuestas/p1/detalle/d1/aceptar', body: {} });
        expect(status).toBe(200);
        const upd = llamadas.propuestas_designacion_detalle.updates.find(u => u.estado_revision);
        expect(upd).toMatchObject({ estado_revision: 'ACEPTADO', origen_seleccion: 'MOTOR', jurado_id_seleccionado: 'j1' });
        expect(upd.metricas_json.orden_presentacion).toBe(4);
        expect(upd.metricas_json.revision_administrativa).toMatchObject({ accion: 'CONFIRMAR', actor_id: 'admin-1' });
        expect(typeof upd.metricas_json.revision_administrativa.fecha).toBe('string');
        expect(supabase.rpc).not.toHaveBeenCalled(); // no crea designaciones reales ni toca bitácora
        expect(llamadas.asignaciones.inserts).toEqual([]); // solo se LEE (¿fila ya aplicada?), nunca se escribe
        expect(llamadas.asignaciones.updates).toEqual([]);
        const aud = llamadas.auditoria.inserts.find(a => a.tabla === 'propuestas_designacion_detalle');
        expect(aud.descripcion).toMatch(/confirmado por el administrador/i);
    });

    test('restricción obligatoria → nunca se puede confirmar', async () => {
        const detalle = { id: 'd1', rodeo_id: 'r1', jurado_id_propuesto: 'j1', jurado_id_seleccionado: null, estado_revision: 'PENDIENTE', metricas_json: {} };
        base(detalle);
        evaluarCandidatoDirecto.mockReturnValue({ evaluacion: { causas: ['MISMA_ASOCIACION'], distanciaKm: 10, jurado: { id: 'j1', nombre_completo: 'Jurado Uno', categoria: 'A', asociacion: 'Asoc' } } });
        const { status, body } = await llamarRuta({ method: 'POST', url: '/propuestas/p1/detalle/d1/aceptar', body: { confirmar_advertencias: true } });
        expect(status).toBe(409);
        expect(body.bloqueadoPorRestriccionObligatoria).toBe(true);
    });

    test('Revertir → vuelve a PENDIENTE, quita la marca vigente pero conserva orden y deja auditoría (historial intacto)', async () => {
        const detalle = { id: 'd1', rodeo_id: 'r1', jurado_id_propuesto: 'j1', jurado_id_seleccionado: 'j1', estado_revision: 'ACEPTADO', metricas_json: { orden_presentacion: 7, revision_administrativa: { accion: 'CONFIRMAR' } } };
        const llamadas = crearSupabaseMock({
            propuestas_designacion: { data: { estado: 'BORRADOR' }, error: null },
            propuestas_designacion_detalle: [{ data: detalle, error: null }, { data: { ...detalle, estado_revision: 'PENDIENTE' }, error: null }]
        });
        const { status } = await llamarRuta({ method: 'POST', url: '/propuestas/p1/detalle/d1/revertir', body: {} });
        expect(status).toBe(200);
        const upd = llamadas.propuestas_designacion_detalle.updates[0];
        expect(upd).toMatchObject({ estado_revision: 'PENDIENTE', jurado_id_seleccionado: null });
        expect(upd.metricas_json.orden_presentacion).toBe(7);
        expect(upd.metricas_json.revision_administrativa).toBeUndefined();
        expect(llamadas.auditoria.inserts[0]).toMatchObject({ tabla: 'propuestas_designacion_detalle', registro_id: 'd1' });
        expect(llamadas.bitacora_designaciones).toBeUndefined(); // nada se borra
    });
});

// ═════════════════════════════════════════════════════════════════════════
// Propuesta YA APLICADA (réplica 27c6bc5d…, verificada en solo lectura el
// 11/11/2026): la pantalla interpreta por EVIDENCIA y el borrador de una fila
// aplicada no se edita. Orden de presentación preservado en cada acción.
// ═════════════════════════════════════════════════════════════════════════
describe('Propuesta aplicada — interpretación por evidencia y bloqueo de filas aplicadas', () => {
    const det = (i, extra = {}) => ({
        id: `det-${i}`, rodeo_id: rodeoId(i), jurado_id_propuesto: juradoId(i),
        jurado_id_seleccionado: i >= 17 ? `jM${i}` : juradoId(i),
        estado_revision: i < 5 ? 'ACEPTADO' : 'MODIFICADO', origen_seleccion: i < 5 ? 'MOTOR' : (i < 17 ? 'MANUAL_CON_ADVERTENCIA' : 'MANUAL'),
        explicacion_json: {}, metricas_json: {}, created_at: '2026-11-11T13:16:36Z', updated_at: '2026-11-11T13:16:36Z',
        rodeos: { club: `Club ${i + 1}`, fecha: fechaRodeo(i), asociacion: 'A', tipo_rodeo_nombre: 'P', tipos_rodeo: null, comunas_chile: null }, ...extra
    });

    test('GET: 0 confirmados en verde, 17 clasificaciones automáticas, 8 modificaciones comprobadas, 25 aplicadas (2 anuladas)', async () => {
        const detalles = Array.from({ length: N }, (_, i) => det(i));
        const bitacora = [
            ...Array.from({ length: N }, (_, i) => ({ propuesta_detalle_id: `det-${i}`, tipo_movimiento: 'aplicacion_propuesta' })),
            ...Array.from({ length: 8 }, (_, k) => ({ propuesta_detalle_id: `det-${17 + k}`, tipo_movimiento: 'modificacion_manual_borrador' })),
        ];
        const asignaciones = Array.from({ length: N }, (_, i) => ({ id: `as-${i}`, propuesta_detalle_id: `det-${i}`, estado: [3, 20].includes(i) ? 'anulado' : 'activo', publicado: true, estado_designacion: 'pendiente' }));
        crearSupabaseMock({
            propuestas_designacion: { data: { id: 'p1', estado: 'BORRADOR', created_at: '2026-11-11T13:16:36Z', configuracion_version_id: null }, error: null },
            propuestas_designacion_detalle: { data: detalles, error: null },
            bitacora_designaciones: { data: bitacora, error: null },
            auditoria: { data: [], error: null },
            usuarios_pagados: { data: [], error: null },
            asignaciones: { data: asignaciones, error: null }
        });
        const { body } = await llamarRuta({ method: 'GET', url: '/propuestas/p1' });
        expect(body.resumen).toMatchObject({ confirmados: 0, clasificacion_automatica: 17, modificados_comprobados: 8, modificados_sin_registro: 0, filas_aplicadas: 25 });
        expect(body.resumen.aceptados).toBe(5); // el dato crudo se conserva; la interpretación va aparte
        const porId = Object.fromEntries(body.detalle.map(d => [d.id, d]));
        expect(porId['det-0'].decision_evidencia).toMatchObject({ decision: 'CLASIFICACION_AUTOMATICA', comprobada: false });
        expect(porId['det-10'].decision_evidencia.decision).toBe('CLASIFICACION_AUTOMATICA');
        expect(porId['det-20'].decision_evidencia).toMatchObject({ decision: 'MODIFICACION_COMPROBADA', comprobada: true, fuentes: ['bitacora'] });
        expect(porId['det-3'].aplicacion_real).toEqual({ aplicada: true, asignaciones: 1, activas: 0, anuladas: 1, publicadas: 0 });
        expect(porId['det-4'].aplicacion_real).toMatchObject({ aplicada: true, activas: 1, publicadas: 1 });
    });

    test('GET: categoría junto a cada jurado — designación aplicada, snapshot del motor o actual rotulada (solo presentación)', async () => {
        const detalles = [
            // Motor registró C; hoy es B; aplicada con C.
            det(0, { explicacion_json: { jurado_propuesto: { jurado_id: juradoId(0), categoria: 'C' } } }),
            // Modificada: propuesto (motor C) → elegido jM20 (aplicada con B).
            det(20, { explicacion_json: { jurado_propuesto: { jurado_id: juradoId(20), categoria: 'C' } } }),
            // Modificada, sin categoria_aplicada en su designación → elegido solo con la ACTUAL.
            det(21, { explicacion_json: { jurado_propuesto: { jurado_id: juradoId(21) } } }),
        ];
        crearSupabaseMock({
            propuestas_designacion: { data: { id: 'p1', estado: 'BORRADOR', created_at: '2026-11-11T13:16:36Z', configuracion_version_id: null }, error: null },
            propuestas_designacion_detalle: { data: detalles, error: null },
            bitacora_designaciones: { data: [{ propuesta_detalle_id: 'det-20', tipo_movimiento: 'modificacion_manual_borrador' }, { propuesta_detalle_id: 'det-21', tipo_movimiento: 'modificacion_manual_borrador' }], error: null },
            auditoria: { data: [], error: null },
            usuarios_pagados: { data: [
                { id: juradoId(0), nombre_completo: 'Erik Saez', categoria: 'B' },
                { id: juradoId(20), nombre_completo: 'Prop 21', categoria: 'C' },
                { id: 'jM20', nombre_completo: 'Andrés Amor Alfaro', categoria: 'B' },
                { id: juradoId(21), nombre_completo: 'Prop 22', categoria: 'A' },
                { id: 'jM21', nombre_completo: 'Elegido 22', categoria: 'B' },
            ], error: null },
            asignaciones: { data: [
                { id: 'as-0', propuesta_detalle_id: 'det-0', estado: 'activo', publicado: true, usuario_pagado_id: juradoId(0), categoria_aplicada: 'C' },
                { id: 'as-20', propuesta_detalle_id: 'det-20', estado: 'activo', publicado: true, usuario_pagado_id: 'jM20', categoria_aplicada: 'B' },
                { id: 'as-21', propuesta_detalle_id: 'det-21', estado: 'activo', publicado: true, usuario_pagado_id: 'jM21', categoria_aplicada: null },
            ], error: null }
        });
        const { body } = await llamarRuta({ method: 'GET', url: '/propuestas/p1' });
        const porId = Object.fromEntries(body.detalle.map(d => [d.id, d]));
        expect(porId['det-0'].categoria_propuesto).toEqual({ categoria: 'C', categoria_fuente: 'MOTOR', categoria_actual: 'B' });
        expect(porId['det-0'].categoria_efectivo).toEqual({ categoria: 'C', categoria_fuente: 'DESIGNACION', categoria_actual: 'B' });
        expect(porId['det-0'].jurado_efectivo.categoria).toBe('B'); // dato existente (actual) intacto
        expect(porId['det-20'].categoria_propuesto).toMatchObject({ categoria: 'C', categoria_fuente: 'MOTOR' });
        expect(porId['det-20'].categoria_seleccionado).toEqual({ categoria: 'B', categoria_fuente: 'DESIGNACION', categoria_actual: 'B' });
        // Sin snapshot del motor ni categoría aplicada → actual, rotulada como tal.
        expect(porId['det-21'].categoria_propuesto).toEqual({ categoria: 'A', categoria_fuente: 'ACTUAL', categoria_actual: 'A' });
        expect(porId['det-21'].categoria_seleccionado).toEqual({ categoria: 'B', categoria_fuente: 'ACTUAL', categoria_actual: 'B' });
        // Lo demás no cambia: misma decisión por evidencia, mismo orden.
        expect(porId['det-20'].decision_evidencia.decision).toBe('MODIFICACION_COMPROBADA');
        expect(body.detalle.map(d => d.id)).toEqual(['det-0', 'det-20', 'det-21']);
    });

    test('GET historial V1 vs. actual: categoría en campo paralelo, sin alterar la respuesta existente', async () => {
        crearSupabaseMock({
            propuestas_designacion_detalle: { data: { id: 'd1', rodeo_id: 'r1', jurado_id_propuesto: 'j1', jurado_id_seleccionado: 'j2', estado_revision: 'MODIFICADO', explicacion_json: { jurado_propuesto: { jurado_id: 'j1', categoria: 'C' } } }, error: null },
            bitacora_designaciones: { data: [{ id: 'b1', usuario_pagado_id_anterior: 'j1', nombre_anterior_snapshot: 'Erik Saez', usuario_pagado_id_nuevo: 'j2', nombre_nuevo_snapshot: 'Andrés Amor Alfaro', tipo_movimiento: 'modificacion_manual_borrador', motivo_detalle: null, actor_id: 'a1', fecha_efectiva: '2026-11-11T13:40:00Z', created_at: '2026-11-11T13:40:00Z', catalogo_motivos_designacion: { etiqueta: 'Ajuste' } }], error: null },
            usuarios_pagados: { data: [{ id: 'j1', nombre_completo: 'Erik Saez', categoria: 'C' }, { id: 'j2', nombre_completo: 'Andrés Amor Alfaro', categoria: 'B' }], error: null },
        });
        const { status, body } = await llamarRuta({ method: 'GET', url: '/propuestas/p1/detalle/d1/historial' });
        expect(status).toBe(200);
        expect(body.v1).toEqual({ jurado_id: 'j1', nombre: 'Erik Saez' });
        expect(body.historial[0].jurado_nuevo).toEqual({ id: 'j2', nombre: 'Andrés Amor Alfaro' });
        expect(body.categorias).toEqual({
            v1: { categoria: 'C', categoria_fuente: 'MOTOR', categoria_actual: 'C' },
            actual: { categoria: 'B', categoria_fuente: 'ACTUAL', categoria_actual: 'B' },
            historial: [{ anterior: { categoria: 'C', categoria_fuente: 'MOTOR', categoria_actual: 'C' }, nuevo: { categoria: 'B', categoria_fuente: 'ACTUAL', categoria_actual: 'B' } }],
        });
    });

    function mockEdicion({ detalle, asignaciones, extraDetalle = [] }) {
        cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG, meta: META });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-12-01', asociacion: 'Asoc', duracion_dias: 1 }]]) });
        evaluarCandidatoDirecto.mockReturnValue({ evaluacion: { causas: [], distanciaKm: 10, jurado: { id: 'j1', nombre_completo: 'Jurado Uno', categoria: 'A', asociacion: 'Otra' } } });
        return crearSupabaseMock({
            propuestas_designacion: { data: { id: 'p1', estado: 'BORRADOR', configuracion_version_id: META.id }, error: null },
            propuestas_designacion_detalle: [{ data: detalle, error: null }, { data: detalle, error: null }, ...extraDetalle],
            asignaciones
        });
    }
    const escrituras = l => (l.propuestas_designacion_detalle?.updates || []).length + (l.auditoria?.inserts || []).length;

    test('Confirmar una fila YA APLICADA → 409 FILA_YA_APLICADA, sin escribir nada', async () => {
        const detalle = { id: 'd1', rodeo_id: 'r1', jurado_id_propuesto: 'j1', jurado_id_seleccionado: 'j1', estado_revision: 'ACEPTADO', metricas_json: {} };
        const l = mockEdicion({ detalle, asignaciones: { data: [{ id: 'as1', propuesta_detalle_id: 'd1', estado: 'activo' }], error: null } });
        const { status, body } = await llamarRuta({ method: 'POST', url: '/propuestas/p1/detalle/d1/aceptar', body: {} });
        expect(status).toBe(409);
        expect(body.code).toBe('FILA_YA_APLICADA');
        expect(escrituras(l)).toBe(0);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('Modificar una fila cuya asignación fue ANULADA → igual bloqueado (la anulación es historia, no reabre el borrador)', async () => {
        const detalle = { id: 'd1', rodeo_id: 'r1', jurado_id_propuesto: 'j1', jurado_id_seleccionado: null, estado_revision: 'PENDIENTE', metricas_json: {} };
        const l = mockEdicion({ detalle, asignaciones: { data: [{ id: 'as1', propuesta_detalle_id: 'd1', estado: 'anulado' }], error: null } });
        const { status, body } = await llamarRuta({ method: 'POST', url: '/propuestas/p1/detalle/d1/seleccionar', body: { jurado_id: 'j2', motivo_catalogo_id: 'm1' } });
        expect(status).toBe(409);
        expect(body.code).toBe('FILA_YA_APLICADA');
        expect(escrituras(l)).toBe(0);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('Revertir una fila YA APLICADA → 409, sin escribir', async () => {
        const detalle = { id: 'd1', rodeo_id: 'r1', jurado_id_propuesto: 'j1', jurado_id_seleccionado: 'j1', estado_revision: 'ACEPTADO', metricas_json: { orden_presentacion: 3 } };
        const l = crearSupabaseMock({
            propuestas_designacion: { data: { estado: 'BORRADOR' }, error: null },
            propuestas_designacion_detalle: { data: detalle, error: null },
            asignaciones: { data: [{ id: 'as1', propuesta_detalle_id: 'd1', estado: 'activo' }], error: null }
        });
        const { status, body } = await llamarRuta({ method: 'POST', url: '/propuestas/p1/detalle/d1/revertir', body: {} });
        expect(status).toBe(409);
        expect(body.code).toBe('FILA_YA_APLICADA');
        expect(escrituras(l)).toBe(0);
    });

    test('si la consulta de asignaciones falla, NO se edita (falla cerrada)', async () => {
        const detalle = { id: 'd1', rodeo_id: 'r1', jurado_id_propuesto: 'j1', jurado_id_seleccionado: null, estado_revision: 'PENDIENTE', metricas_json: {} };
        const l = mockEdicion({ detalle, asignaciones: { data: null, error: { message: 'timeout' } } });
        const { status } = await llamarRuta({ method: 'POST', url: '/propuestas/p1/detalle/d1/aceptar', body: {} });
        expect(status).toBe(500);
        expect(escrituras(l)).toBe(0);
    });

    const METRICAS_HIST = { orden_presentacion: 4, descartes: { MISMA_ASOCIACION: 3 }, candidatos_evaluados: 12, advertencias_aceptadas: [{ tipo: 'FINDE_CONSECUTIVO' }] };
    const EXPLICACION = { jurado_propuesto: { jurado_id: 'j1', optimizacion_global_relajaciones: ['FINDE_CONSECUTIVO'] } };

    test('Modificar (borrador no aplicado) → orden y métricas históricas intactas; explicacion_json del motor no se toca', async () => {
        const detalle = { id: 'd1', rodeo_id: 'r1', jurado_id_propuesto: 'j1', jurado_id_seleccionado: null, estado_revision: 'PENDIENTE', metricas_json: METRICAS_HIST, explicacion_json: EXPLICACION };
        // Lecturas de detalle: la fila, luego "otras filas" (vacías).
        mockEdicion({ detalle, asignaciones: { data: [], error: null } }); // config + motor
        const l = crearSupabaseMock({
            propuestas_designacion: { data: { id: 'p1', estado: 'BORRADOR', configuracion_version_id: META.id }, error: null },
            propuestas_designacion_detalle: [{ data: detalle, error: null }, { data: [], error: null }],
            asignaciones: { data: [], error: null }
        });
        supabase.rpc.mockResolvedValue({ data: { detalle: { ...detalle, estado_revision: 'MODIFICADO', jurado_id_seleccionado: 'j2' }, bitacora_id: 'b1' }, error: null });
        const { status } = await llamarRuta({ method: 'POST', url: '/propuestas/p1/detalle/d1/seleccionar', body: { jurado_id: 'j2', motivo_catalogo_id: 'm1' } });
        expect(status).toBe(200);
        const args = supabase.rpc.mock.calls.find(c => c[0] === 'modificar_jurado_propuesta_borrador')[1];
        expect(args.p_metricas_json_nuevo).toMatchObject({ orden_presentacion: 4, descartes: { MISMA_ASOCIACION: 3 }, candidatos_evaluados: 12, revision_administrativa: { accion: 'MODIFICAR', actor_id: 'admin-1' } });
        expect(JSON.stringify(args)).not.toMatch(/explicacion_json/);
        expect(l.propuestas_designacion_detalle.updates).toEqual([]); // la modificación va SOLO por la RPC atómica (con bitácora)
    });

    test('Mover jurado desde otra fila (no aplicada) → la fila liberada conserva orden y métricas, pierde solo la aprobación vigente', async () => {
        const destino = { id: 'd1', rodeo_id: 'r1', jurado_id_propuesto: 'j9', jurado_id_seleccionado: null, estado_revision: 'PENDIENTE', metricas_json: { orden_presentacion: 0 } };
        const otra = { id: 'd2', estado_revision: 'ACEPTADO', jurado_id_seleccionado: 'j1', jurado_id_propuesto: 'j1', rodeo_id: 'r2', rodeos: { id: 'r2', club: 'Club R2', fecha: '2027-03-01', asociacion: 'X', duracion_dias: 1 } };
        cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG, meta: META });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-12-01', asociacion: 'Asoc', duracion_dias: 1, bloque: require('../../services/feriados').calcularBloqueRodeo('2026-12-01', 1) }]]) });
        evaluarCandidatoDirecto.mockReturnValue({ evaluacion: { causas: [], distanciaKm: 10, jurado: { id: 'j1', nombre_completo: 'Jurado Uno', categoria: 'A', asociacion: 'Otra' } } });
        const l = crearSupabaseMock({
            propuestas_designacion: { data: { id: 'p1', estado: 'BORRADOR', configuracion_version_id: META.id }, error: null },
            propuestas_designacion_detalle: [
                { data: destino, error: null },
                { data: [otra], error: null },
                { data: { jurado_id_seleccionado: 'j1', estado_revision: 'ACEPTADO', metricas_json: { orden_presentacion: 9, descartes: { X: 1 }, revision_administrativa: { accion: 'CONFIRMAR' }, advertencias_aceptadas: [{ tipo: 'T' }] } }, error: null },
                { data: null, error: null }
            ],
            asignaciones: { data: [], error: null }
        });
        supabase.rpc.mockResolvedValue({ data: { detalle: { ...destino, estado_revision: 'MODIFICADO', jurado_id_seleccionado: 'j1' }, bitacora_id: 'b1' }, error: null });
        const { status } = await llamarRuta({ method: 'POST', url: '/propuestas/p1/detalle/d1/seleccionar', body: { jurado_id: 'j1', motivo_catalogo_id: 'm1', confirmar_advertencias: true } });
        expect(status).toBe(200);
        const liberacion = l.propuestas_designacion_detalle.updates[0];
        expect(liberacion).toMatchObject({ jurado_id_seleccionado: null, estado_revision: 'SIN_JURADO_ACTUAL' });
        expect(liberacion.metricas_json).toEqual({ orden_presentacion: 9, descartes: { X: 1 } });
    });

    test('Mover jurado desde una fila YA APLICADA → 409, nada se escribe', async () => {
        const destino = { id: 'd1', rodeo_id: 'r1', jurado_id_propuesto: 'j9', jurado_id_seleccionado: null, estado_revision: 'PENDIENTE', metricas_json: {} };
        const otra = { id: 'd2', estado_revision: 'ACEPTADO', jurado_id_seleccionado: 'j1', jurado_id_propuesto: 'j1', rodeo_id: 'r2', rodeos: { id: 'r2', club: 'Club R2', fecha: '2027-03-01', asociacion: 'X', duracion_dias: 1 } };
        cargarConfiguracionDesignacionPorId.mockResolvedValue({ configuracion: CONFIG, meta: META });
        cargarDatosMotor.mockResolvedValue({ rodeosPorId: new Map([['r1', { club: 'Club R1', fecha: '2026-12-01', asociacion: 'Asoc', duracion_dias: 1, bloque: require('../../services/feriados').calcularBloqueRodeo('2026-12-01', 1) }]]) });
        evaluarCandidatoDirecto.mockReturnValue({ evaluacion: { causas: [], distanciaKm: 10, jurado: { id: 'j1', nombre_completo: 'Jurado Uno', categoria: 'A', asociacion: 'Otra' } } });
        const l = crearSupabaseMock({
            propuestas_designacion: { data: { id: 'p1', estado: 'BORRADOR', configuracion_version_id: META.id }, error: null },
            propuestas_designacion_detalle: [{ data: destino, error: null }, { data: [otra], error: null }],
            asignaciones: [{ data: [], error: null }, { data: [{ id: 'as2', propuesta_detalle_id: 'd2', estado: 'activo' }], error: null }]
        });
        const { status, body } = await llamarRuta({ method: 'POST', url: '/propuestas/p1/detalle/d1/seleccionar', body: { jurado_id: 'j1', motivo_catalogo_id: 'm1', confirmar_advertencias: true } });
        expect(status).toBe(409);
        expect(body.code).toBe('FILA_YA_APLICADA');
        expect(escrituras(l)).toBe(0);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });
});
