// Incidente 2026-11-25 (simulación de Propuesta de Designación):
// UND_ERR_HEADERS_OVERFLOW con `.in()` de ~390+ UUIDs. Pruebas de la función
// común de consultas por lotes, con un constructor de consultas en memoria
// que imita PostgREST (filtros, orden, range y corte por max_rows).
const {
    seleccionarPorLotes, normalizarIds, dividirEnLotes, ErrorConsultaPorLotes,
    TAMANO_LOTE_IDS, TAMANO_PAGINA
} = require('./consultaPorLotes');

const uuid = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

// filasPorId: cuántas filas devuelve cada ID (relación 1→N para probar paginación).
function crearFuente({ filas, maxRows = 1000, fallarEnLlamada = null, demoraMs = 0 }) {
    const llamadas = [];
    let enVuelo = 0;
    let maxEnVuelo = 0;
    function construirConsulta(opcionesSelect) {
        const st = { filtros: [], in: null, orden: null, rango: null, eqs: [], contar: !!(opcionesSelect && opcionesSelect.count === 'exact') };
        const chain = {
            eq(col, v) { st.eqs.push([col, v]); st.filtros.push(r => r[col] === v); return chain; },
            in(col, vals) { st.in = { col, vals: [...vals] }; return chain; },
            order(col, opts) { st.orden = { col, opts }; return chain; },
            range(a, b) { st.rango = [a, b]; return chain; },
            then(resolve, reject) {
                const n = llamadas.length + 1;
                llamadas.push({ in: st.in, orden: st.orden, rango: st.rango, eqs: st.eqs, contar: st.contar });
                enVuelo++; maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
                const p = new Promise(r => setTimeout(r, demoraMs)).then(() => {
                    enVuelo--;
                    if (fallarEnLlamada === n) return { data: null, error: { message: 'TypeError: fetch failed' } };
                    let rows = filas.filter(r => st.filtros.every(f => f(r)) && (!st.in || st.in.vals.includes(r[st.in.col])));
                    if (st.orden) rows = [...rows].sort((x, y) => String(x[st.orden.col]).localeCompare(String(y[st.orden.col])) || String(x.k).localeCompare(String(y.k)));
                    const total = rows.length; // PostgREST: count=exact es el total del filtro, sin el corte de max_rows
                    const [a, b] = st.rango || [0, Infinity];
                    rows = rows.slice(a, Math.min(b + 1, a + maxRows));
                    return { data: rows, error: null, count: st.contar ? total : null };
                });
                return p.then(resolve, reject);
            }
        };
        return chain;
    }
    return { construirConsulta, llamadas, maxEnVuelo: () => maxEnVuelo };
}

function datosUnoAUno(n) {
    return Array.from({ length: n }, (_, i) => ({ k: `f${i}`, asignacion_id: uuid(i), nota: (i % 7) + 1, fuente: i % 3 === 0 ? 'manual' : 'evaluacion_tecnica' }));
}

describe('normalizarIds / dividirEnLotes', () => {
    test('quita null/undefined/vacíos y duplicados conservando el orden de primera aparición', () => {
        expect(normalizarIds(['b', null, 'a', 'b', undefined, '', 'c', 'a'])).toEqual(['b', 'a', 'c']);
        expect(normalizarIds(null)).toEqual([]);
    });
    test('lotes de como máximo 150 por defecto', () => {
        expect(TAMANO_LOTE_IDS).toBe(150);
        const lotes = dividirEnLotes(Array.from({ length: 301 }, (_, i) => i));
        expect(lotes.map(l => l.length)).toEqual([150, 150, 1]);
    });
    test('tamaño de lote inválido se rechaza', () => {
        expect(() => dividirEnLotes([1], 0)).toThrow('tamanoLote inválido');
    });
    test('un lote de 150 UUIDs genera un filtro muy por debajo del límite de 16 KB', () => {
        const filtro = `asignacion_id=in.(${Array.from({ length: 150 }, (_, i) => uuid(i)).join(',')})`;
        expect(filtro.length).toBeLessThan(6000);
    });
});

describe('seleccionarPorLotes — tamaños de lista', () => {
    test.each([
        [0, 0], [1, 1], [149, 1], [150, 1], [151, 2], [300, 2], [407, 3], [600, 4], [1000, 7]
    ])('%i IDs → %i consulta(s), todas las filas exactamente una vez', async (n, consultasEsperadas) => {
        const filas = datosUnoAUno(n);
        const fuente = crearFuente({ filas });
        const ids = filas.map(f => f.asignacion_id);
        const r = await seleccionarPorLotes({ construirConsulta: fuente.construirConsulta, columna: 'asignacion_id', ids, ordenarPor: 'asignacion_id' });
        expect(fuente.llamadas).toHaveLength(consultasEsperadas);
        expect(fuente.llamadas.every(l => l.in.vals.length <= 150)).toBe(true);
        expect(r).toHaveLength(n);
        expect(new Set(r.map(x => x.asignacion_id)).size).toBe(n);
        expect(r.map(x => x.k).sort()).toEqual(filas.map(x => x.k).sort());
    });

    test('lista vacía (o solo nulos) → [] sin ninguna consulta', async () => {
        const fuente = crearFuente({ filas: [] });
        expect(await seleccionarPorLotes({ construirConsulta: fuente.construirConsulta, columna: 'x', ids: [] })).toEqual([]);
        expect(await seleccionarPorLotes({ construirConsulta: fuente.construirConsulta, columna: 'x', ids: [null, undefined, ''] })).toEqual([]);
        expect(await seleccionarPorLotes({ construirConsulta: fuente.construirConsulta, columna: 'x', ids: undefined })).toEqual([]);
        expect(fuente.llamadas).toHaveLength(0);
    });

    test('IDs duplicados: se consultan una sola vez y no se duplican filas', async () => {
        const filas = datosUnoAUno(200);
        const fuente = crearFuente({ filas });
        const ids = [...filas.map(f => f.asignacion_id), ...filas.map(f => f.asignacion_id), null];
        const r = await seleccionarPorLotes({ construirConsulta: fuente.construirConsulta, columna: 'asignacion_id', ids });
        expect(fuente.llamadas).toHaveLength(2);
        const consultados = fuente.llamadas.flatMap(l => l.in.vals);
        expect(consultados).toHaveLength(200);
        expect(new Set(consultados).size).toBe(200);
        expect(r).toHaveLength(200);
    });

    test('respuestas vacías: IDs sin filas → [] (no se inventan registros)', async () => {
        const fuente = crearFuente({ filas: [] });
        const ids = Array.from({ length: 407 }, (_, i) => uuid(i));
        const r = await seleccionarPorLotes({ construirConsulta: fuente.construirConsulta, columna: 'asignacion_id', ids });
        expect(r).toEqual([]);
        expect(fuente.llamadas).toHaveLength(3);
    });

    test('se conservan los filtros originales en CADA lote y el orden pedido', async () => {
        const filas = datosUnoAUno(407);
        const fuente = crearFuente({ filas });
        const r = await seleccionarPorLotes({
            construirConsulta: () => fuente.construirConsulta().eq('fuente', 'evaluacion_tecnica'),
            columna: 'asignacion_id', ids: filas.map(f => f.asignacion_id), ordenarPor: 'asignacion_id'
        });
        expect(fuente.llamadas.every(l => l.eqs.length === 1 && l.eqs[0][0] === 'fuente' && l.eqs[0][1] === 'evaluacion_tecnica')).toBe(true);
        expect(fuente.llamadas.every(l => l.orden && l.orden.col === 'asignacion_id' && l.orden.opts.ascending === true)).toBe(true);
        expect(r).toHaveLength(filas.filter(f => f.fuente === 'evaluacion_tecnica').length);
        expect(r.every(x => x.fuente === 'evaluacion_tecnica')).toBe(true);
    });
});

describe('seleccionarPorLotes — límites de filas y paginación', () => {
    test('un lote que devuelve más filas que la página se pagina hasta el final (relación 1→N)', async () => {
        // 150 IDs × 10 filas = 1500 filas en UN lote; max_rows del servidor 1000.
        const filas = [];
        for (let i = 0; i < 150; i++) for (let j = 0; j < 10; j++) filas.push({ k: `f${i}-${j}`, rid: uuid(i) });
        const fuente = crearFuente({ filas, maxRows: 1000 });
        const r = await seleccionarPorLotes({ construirConsulta: fuente.construirConsulta, columna: 'rid', ids: filas.map(f => f.rid), ordenarPor: 'k' });
        expect(r).toHaveLength(1500);
        expect(new Set(r.map(x => x.k)).size).toBe(1500);
        expect(fuente.llamadas.map(l => l.rango)).toEqual([[0, TAMANO_PAGINA - 1], [TAMANO_PAGINA, 2 * TAMANO_PAGINA - 1]]);
    });

    test('página exactamente llena → pide una página más (vacía) y termina', async () => {
        const filas = datosUnoAUno(10);
        const fuente = crearFuente({ filas });
        const r = await seleccionarPorLotes({ construirConsulta: fuente.construirConsulta, columna: 'asignacion_id', ids: filas.map(f => f.asignacion_id), tamanoPagina: 5, ordenarPor: 'asignacion_id' });
        expect(r).toHaveLength(10);
        expect(fuente.llamadas.map(l => l.rango)).toEqual([[0, 4], [5, 9], [10, 14]]);
    });

    test('la página por defecto (900) queda por debajo del max_rows=1000 de Supabase (verificado en producción 2026-11-25)', () => {
        expect(TAMANO_PAGINA).toBeLessThan(1000);
    });

    test('count=exact solo en la PRIMERA página de cada lote', async () => {
        const filas = [];
        for (let i = 0; i < 300; i++) for (let j = 0; j < 4; j++) filas.push({ k: `f${i}-${j}`, rid: uuid(i) });
        const fuente = crearFuente({ filas });
        await seleccionarPorLotes({ construirConsulta: fuente.construirConsulta, columna: 'rid', ids: filas.map(f => f.rid), ordenarPor: 'k' });
        // 2 lotes × 600 filas → página 0 (contar) + página 900 (sin contar)... 600 < 900: una página por lote.
        expect(fuente.llamadas.map(l => [l.rango[0], l.contar])).toEqual([[0, true], [0, true]]);
    });

    test('TRUNCAMIENTO: si la API corta por debajo de la página (max_rows=500 < 900), se lanza error en vez de devolver filas de menos', async () => {
        const filas = [];
        for (let i = 0; i < 150; i++) for (let j = 0; j < 10; j++) filas.push({ k: `f${i}-${j}`, rid: uuid(i) });
        const fuente = crearFuente({ filas, maxRows: 500 });
        let error = null;
        let resultado = 'sin-asignar';
        try {
            resultado = await seleccionarPorLotes({ construirConsulta: fuente.construirConsulta, columna: 'rid', ids: filas.map(f => f.rid), ordenarPor: 'k' });
        } catch (e) { error = e; }
        expect(resultado).toBe('sin-asignar');
        expect(error).toBeInstanceOf(ErrorConsultaPorLotes);
        expect(error.message).toBe('Resultado incompleto: se recuperaron 500 de 1500 filas (posible límite de filas de la API menor a 900)');
    });

    test('sin truncamiento (max_rows=1000 ≥ 900), un lote de 1.500 filas se recupera completo y cuadra con count', async () => {
        const filas = [];
        for (let i = 0; i < 150; i++) for (let j = 0; j < 10; j++) filas.push({ k: `f${i}-${j}`, rid: uuid(i) });
        const fuente = crearFuente({ filas, maxRows: 1000 });
        const r = await seleccionarPorLotes({ construirConsulta: fuente.construirConsulta, columna: 'rid', ids: filas.map(f => f.rid), ordenarPor: 'k' });
        expect(r).toHaveLength(1500);
    });
});

describe('seleccionarPorLotes — errores y concurrencia', () => {
    test('error en un lote intermedio → lanza, sin devolver resultados parciales', async () => {
        const filas = datosUnoAUno(600);
        const fuente = crearFuente({ filas, fallarEnLlamada: 2 });
        let resultado = 'sin-asignar';
        let error = null;
        try {
            resultado = await seleccionarPorLotes({ construirConsulta: fuente.construirConsulta, columna: 'asignacion_id', ids: filas.map(f => f.asignacion_id) });
        } catch (e) { error = e; }
        expect(resultado).toBe('sin-asignar');
        expect(error).toBeInstanceOf(ErrorConsultaPorLotes);
        expect(error.message).toBe('TypeError: fetch failed');
        expect(error.lote).toBe(2);
        expect(error.totalLotes).toBe(4);
        // No sigue consultando lotes después del fallo.
        expect(fuente.llamadas).toHaveLength(2);
    });

    test('lotes en secuencia: nunca más de una consulta en vuelo', async () => {
        const filas = datosUnoAUno(1000);
        const fuente = crearFuente({ filas, demoraMs: 2 });
        await seleccionarPorLotes({ construirConsulta: fuente.construirConsulta, columna: 'asignacion_id', ids: filas.map(f => f.asignacion_id) });
        expect(fuente.maxEnVuelo()).toBe(1);
    });

    test('parámetros inválidos se rechazan', async () => {
        await expect(seleccionarPorLotes({ columna: 'x', ids: ['a'] })).rejects.toThrow('construirConsulta');
        await expect(seleccionarPorLotes({ construirConsulta: () => ({}), ids: ['a'] })).rejects.toThrow('columna');
        await expect(seleccionarPorLotes({ construirConsulta: () => ({}), columna: 'x', ids: ['a'], tamanoPagina: 0 })).rejects.toThrow('tamanoPagina');
    });
});
