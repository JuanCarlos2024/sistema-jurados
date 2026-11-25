// Incidente 2026-11-25 — equivalencia de rendimiento y nota técnica entre la
// consulta única original y la consulta por lotes. Un Supabase EN MEMORIA
// imita PostgREST (in/eq/neq/lte anidado/order/range con max_rows=1000) y
// reproduce el desborde real: una consulta con más de 390 IDs en un `.in()`
// falla con "TypeError: fetch failed" (UND_ERR_HEADERS_OVERFLOW en Node).
// La referencia se calcula DIRECTAMENTE sobre los datos (lo que la consulta
// única habría devuelto sin el límite) y se compara con el resultado real.
jest.mock('../config/supabase', () => ({ from: jest.fn() }));
const supabase = require('../config/supabase');
const { cargarRendimientoTemporada, construirRendimientoPorJurado } = require('./motorPropuestaDesignacion');
const { cargarNotaTecnicaPorJurado } = require('./notaTecnicaJurados');

const LIMITE_IDS_DESBORDE = 390;
const uuid = (p, i) => `${p}0000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const leer = (fila, ruta) => ruta.split('.').reduce((o, k) => (o == null ? undefined : o[k]), fila);

function instalarSupabaseEnMemoria(tablas, { maxRows = 1000 } = {}) {
    const llamadas = [];
    supabase.from.mockImplementation((tabla) => {
        const st = { filtros: [], inLen: 0, orden: null, rango: null, contar: false };
        const chain = {
            select(_cols, opts) { st.contar = !!(opts && opts.count === 'exact'); return chain; },
            in(col, vals) { const s = new Set(vals); st.inLen = Math.max(st.inLen, vals.length); st.filtros.push(r => s.has(leer(r, col))); return chain; },
            eq(col, v) { st.filtros.push(r => leer(r, col) === v); return chain; },
            neq(col, v) { st.filtros.push(r => leer(r, col) !== v); return chain; },
            lte(col, v) { st.filtros.push(r => leer(r, col) <= v); return chain; },
            order(col) { st.orden = col; return chain; },
            range(a, b) { st.rango = [a, b]; return chain; },
            then(resolve, reject) {
                llamadas.push({ tabla, inLen: st.inLen, contar: st.contar, desde: st.rango ? st.rango[0] : 0 });
                if (st.inLen > LIMITE_IDS_DESBORDE) {
                    return Promise.resolve({ data: null, error: { message: 'TypeError: fetch failed' } }).then(resolve, reject);
                }
                let rows = (tablas[tabla] || []).filter(r => st.filtros.every(f => f(r)));
                const total = rows.length;
                if (st.orden) rows = [...rows].sort((x, y) => String(leer(x, st.orden)).localeCompare(String(leer(y, st.orden))));
                const [a, b] = st.rango || [0, Infinity];
                rows = rows.slice(a, Math.min(b + 1, a + maxRows));
                return Promise.resolve({ data: rows, error: null, count: st.contar ? total : null }).then(resolve, reject);
            }
        };
        return chain;
    });
    return llamadas;
}

// Temporada sintética: N asignaciones, 30 jurados, ~70% con nota (mezcla de
// fuentes), ~1 rodeo cada 2 asignaciones, evaluaciones (algunas anuladas o
// históricas, que deben quedar excluidas igual que antes).
function construirTemporada(n) {
    const jurados = Array.from({ length: 30 }, (_, j) => ({ id: uuid('j', j), categoria: ['A', 'B', 'C'][j % 3] }));
    const asignaciones = Array.from({ length: n }, (_, i) => ({
        id: uuid('a', i),
        usuario_pagado_id: jurados[i % 30].id,
        rodeo_id: uuid('r', Math.floor(i / 2)),
        estado: i % 17 === 0 ? 'anulado' : 'activo',
        estado_designacion: i % 23 === 0 ? 'rechazado' : (i % 5 === 0 ? null : 'aceptado'),
        tipo_persona: 'jurado',
        rodeos: { fecha: `2026-${String(9 + (i % 3)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}` }
    }));
    const notas = asignaciones
        .filter((_, i) => i % 10 < 7)
        .map((a, k) => ({ asignacion_id: a.id, nota: String(3 + ((k * 7) % 40) / 10), fuente: k % 4 === 0 ? 'manual' : 'evaluacion_tecnica' }));
    const rodeoIds = [...new Set(asignaciones.map(a => a.rodeo_id))];
    const evaluaciones = rodeoIds
        .filter((_, i) => i % 3 !== 0)
        .map((rodeo_id, i) => ({ rodeo_id, resultados_alterados: i % 4 === 0, anulada: i % 11 === 0, es_historica_importacion: i % 13 === 0 }));
    return { jurados, asignaciones, tablas: { asignaciones, notas_rodeo: notas, evaluaciones } };
}

// Referencia: lo que devolvían las 2 consultas originales sin el límite.
function referenciaRendimiento({ tablas }, asignacionesTemporada) {
    const asigIds = new Set(asignacionesTemporada.map(a => a.id));
    const rodeoIds = new Set(asignacionesTemporada.map(a => a.rodeo_id));
    const notasPorAsignacion = new Map();
    for (const n of tablas.notas_rodeo) if (asigIds.has(n.asignacion_id)) notasPorAsignacion.set(n.asignacion_id, parseFloat(n.nota));
    const alteradoPorRodeo = new Map();
    for (const e of tablas.evaluaciones) {
        if (rodeoIds.has(e.rodeo_id) && e.anulada === false && e.es_historica_importacion === false) alteradoPorRodeo.set(e.rodeo_id, !!e.resultados_alterados);
    }
    return { asignacionesTemporada, notasPorAsignacion, alteradoPorRodeo };
}

function referenciaNotaTecnica({ tablas }, juradoIds, fechaCorte) {
    const efectiva = a => a.estado !== 'anulado' && a.estado_designacion !== 'rechazado';
    const notaTec = new Map(tablas.notas_rodeo.filter(n => n.fuente === 'evaluacion_tecnica').map(n => [n.asignacion_id, parseFloat(n.nota)]));
    const r = new Map();
    for (const jid of juradoIds) {
        const notas = tablas.asignaciones
            .filter(a => a.usuario_pagado_id === jid && a.tipo_persona === 'jurado' && efectiva(a) && (!fechaCorte || a.rodeos.fecha <= fechaCorte))
            .map(a => notaTec.get(a.id)).filter(n => n !== undefined && !Number.isNaN(n));
        r.set(jid, { promedio: notas.length ? notas.reduce((s, n) => s + n, 0) / notas.length : null, cantidad: notas.length });
    }
    return r;
}

beforeEach(() => supabase.from.mockReset());

describe('el simulador reproduce el incidente', () => {
    test('una consulta única con 407 IDs falla con "fetch failed" (lo que ocurría en producción)', async () => {
        const { tablas, asignaciones } = construirTemporada(407);
        instalarSupabaseEnMemoria(tablas);
        const { error } = await supabase.from('notas_rodeo').select('asignacion_id, nota').in('asignacion_id', asignaciones.map(a => a.id));
        expect(error.message).toBe('TypeError: fetch failed');
    });
});

describe('cargarRendimientoTemporada — equivalencia con la consulta original', () => {
    test.each([1, 149, 150, 151, 300, 407, 600, 1000])('%i asignaciones de temporada', async (n) => {
        const temporada = construirTemporada(n);
        const llamadas = instalarSupabaseEnMemoria(temporada.tablas);
        const asignacionesTemporada = temporada.asignaciones.filter(a => a.estado !== 'anulado' && a.estado_designacion !== 'rechazado');
        const datos = await cargarRendimientoTemporada({ asignacionesTemporada });
        const ref = referenciaRendimiento(temporada, asignacionesTemporada);

        expect(llamadas.every(l => l.inLen <= 150)).toBe(true);
        // La verificación anti-truncamiento está activa: la 1.ª página de cada lote pide count=exact.
        expect(llamadas.filter(l => l.desde === 0).every(l => l.contar)).toBe(true);
        expect([...datos.notasPorAsignacion.entries()].sort()).toEqual([...ref.notasPorAsignacion.entries()].sort());
        expect([...datos.alteradoPorRodeo.entries()].sort()).toEqual([...ref.alteradoPorRodeo.entries()].sort());

        // Los cálculos de rendimiento (promedios, última nota, alteración)
        // son idénticos con los datos por lotes y con los de referencia.
        const ganadores = temporada.jurados.map(j => j.id);
        const calc = construirRendimientoPorJurado(datos, temporada.jurados, ganadores, '2026-12-31');
        const calcRef = construirRendimientoPorJurado(ref, temporada.jurados, ganadores, '2026-12-31');
        expect([...calc.entries()]).toEqual([...calcRef.entries()]);
    });

    test('IDs duplicados en la población no duplican filas ni alteran el cálculo', async () => {
        const temporada = construirTemporada(300);
        const llamadas = instalarSupabaseEnMemoria(temporada.tablas);
        const base = temporada.asignaciones.filter(a => a.estado !== 'anulado');
        const datos = await cargarRendimientoTemporada({ asignacionesTemporada: [...base, ...base.slice(0, 50)] });
        const ref = referenciaRendimiento(temporada, base);
        expect(datos.notasPorAsignacion.size).toBe(ref.notasPorAsignacion.size);
        const consultadosNotas = llamadas.filter(l => l.tabla === 'notas_rodeo').reduce((s, l) => s + l.inLen, 0);
        expect(consultadosNotas).toBe(base.length);
    });

    test('falla de un lote → error explícito, nunca notas vacías/cero', async () => {
        const temporada = construirTemporada(600);
        instalarSupabaseEnMemoria(temporada.tablas);
        let n = 0;
        const original = supabase.from.getMockImplementation();
        supabase.from.mockImplementation((tabla) => {
            const chain = original(tabla);
            const thenOriginal = chain.then;
            chain.then = (res, rej) => (tabla === 'notas_rodeo' && ++n === 2
                ? Promise.resolve({ data: null, error: { message: 'fallo del lote 2' } }).then(res, rej)
                : thenOriginal(res, rej));
            return chain;
        });
        await expect(cargarRendimientoTemporada({ asignacionesTemporada: temporada.asignaciones }))
            .rejects.toThrow('No se pudieron cargar notas para métricas de rendimiento: fallo del lote 2');
    });

    test('sin asignaciones → 0 consultas (sin cambios)', async () => {
        const llamadas = instalarSupabaseEnMemoria({});
        const r = await cargarRendimientoTemporada({ asignacionesTemporada: [] });
        expect(llamadas).toHaveLength(0);
        expect(r.notasPorAsignacion.size).toBe(0);
    });
});

describe('cargarNotaTecnicaPorJurado — equivalencia con la consulta original', () => {
    test.each([1, 150, 151, 407, 600, 1000])('%i asignaciones (fecha de corte 2026-10-15)', async (n) => {
        const temporada = construirTemporada(n);
        const llamadas = instalarSupabaseEnMemoria(temporada.tablas);
        const ids = temporada.jurados.map(j => j.id);
        const r = await cargarNotaTecnicaPorJurado(ids, '2026-10-15T12:00:00.000Z');
        const ref = referenciaNotaTecnica(temporada, ids, '2026-10-15');
        expect(llamadas.every(l => l.inLen <= LIMITE_IDS_DESBORDE)).toBe(true);
        expect([...r.entries()]).toEqual([...ref.entries()]);
    });

    test('sin fecha de corte y con jurados sin notas → null explícito (nunca 0)', async () => {
        const temporada = construirTemporada(407);
        instalarSupabaseEnMemoria(temporada.tablas);
        const ids = [...temporada.jurados.map(j => j.id), uuid('j', 999)];
        const r = await cargarNotaTecnicaPorJurado(ids, null);
        expect([...r.entries()]).toEqual([...referenciaNotaTecnica(temporada, ids, null).entries()]);
        expect(r.get(uuid('j', 999))).toEqual({ promedio: null, cantidad: 0 });
    });

    test('falla de un lote de notas → error explícito, sin promedios parciales', async () => {
        const temporada = construirTemporada(1000);
        instalarSupabaseEnMemoria(temporada.tablas);
        let n = 0;
        const original = supabase.from.getMockImplementation();
        supabase.from.mockImplementation((tabla) => {
            const chain = original(tabla);
            const thenOriginal = chain.then;
            chain.then = (res, rej) => (tabla === 'notas_rodeo' && ++n === 3
                ? Promise.resolve({ data: null, error: { message: 'fallo del lote 3' } }).then(res, rej)
                : thenOriginal(res, rej));
            return chain;
        });
        await expect(cargarNotaTecnicaPorJurado(temporada.jurados.map(j => j.id), null))
            .rejects.toThrow('No se pudo cargar notas_rodeo para nota técnica: fallo del lote 3');
    });
});
