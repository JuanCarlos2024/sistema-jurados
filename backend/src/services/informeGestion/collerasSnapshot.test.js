jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../colleras-completas', () => ({ obtenerCollerasCompletas: jest.fn() }));

const { obtenerCollerasActuales, construirSnapshot, guardarSnapshot, registrarSnapshot, fechaDatoISO } = require('./collerasSnapshot');

const AHORA = new Date('2026-09-24T15:00:00Z');
function dbConSnapshot(snapshot, error = null) {
    const c = {};
    ['select', 'eq', 'order', 'limit'].forEach(m => { c[m] = jest.fn(() => c); });
    c.then = res => Promise.resolve({ data: snapshot ? [snapshot] : [], error }).then(res);
    return { from: jest.fn(() => c), chain: c };
}

describe('obtenerCollerasActuales (reutiliza colleras-completas.js; la fuente no bloquea el informe)', () => {
    test('fuente en vivo OK → estado actual', async () => {
        const obtenerFn = jest.fn().mockResolvedValue({ resumen: { totalCompletas: 35 }, filas: [] });
        const r = await obtenerCollerasActuales({ obtenerFn, db: dbConSnapshot(null), ahora: () => AHORA });
        expect(r).toMatchObject({ total: 35, fuente: 'en_vivo', estado: 'actual', fechaDato: AHORA.toISOString(), detalle_error: null });
    });

    test('la fuente falla → usa el último snapshot VÁLIDO (fallback) e informa el error', async () => {
        const db = dbConSnapshot({ fecha_snapshot: '2026-09-20T10:00:00Z', total_colleras: 33, temporada: '2026-2027', fuente: 'gestionderodeos.cl' });
        const r = await obtenerCollerasActuales({ obtenerFn: jest.fn().mockRejectedValue(new Error('HTTP 500')), db, ahora: () => AHORA });
        expect(r).toMatchObject({ total: 33, fuente: 'snapshot', estado: 'fallback', fechaDato: '2026-09-20T10:00:00Z' });
        expect(r.detalle_error).toMatch(/HTTP 500/);
        expect(db.chain.eq).toHaveBeenCalledWith('estado_fuente', 'OK');
        expect(db.chain.order).toHaveBeenCalledWith('fecha_snapshot', { ascending: false });
    });

    test('fuente caída y sin snapshot → no_disponible (sin inventar un total)', async () => {
        const r = await obtenerCollerasActuales({ obtenerFn: jest.fn().mockRejectedValue(new Error('caída')), db: dbConSnapshot(null), ahora: () => AHORA });
        expect(r).toMatchObject({ total: null, fuente: 'ninguna', estado: 'no_disponible' });
        expect(r.detalle_error).toMatch(/Sin snapshot válido/);
    });

    test('tabla de snapshots inexistente (migración no aplicada) tampoco rompe el informe', async () => {
        const r = await obtenerCollerasActuales({ obtenerFn: jest.fn().mockRejectedValue(new Error('caída')), db: dbConSnapshot(null, { message: 'relation "colleras_completas_snapshots" does not exist' }), ahora: () => AHORA });
        expect(r).toMatchObject({ total: null, estado: 'no_disponible' });
        expect(r.detalle_error).toMatch(/does not exist/);
    });

    test('timeout propio: una fuente lenta cae al fallback sin bloquear', async () => {
        const lenta = () => new Promise(() => {});
        const db = dbConSnapshot({ fecha_snapshot: '2026-09-20T10:00:00Z', total_colleras: 30 });
        const r = await obtenerCollerasActuales({ obtenerFn: lenta, db, timeoutMs: 20 });
        expect(r).toMatchObject({ estado: 'fallback', total: 30 });
        expect(r.detalle_error).toMatch(/Tiempo de espera agotado/);
    });

    test('respuesta sin totalCompletas numérico se trata como fallo', async () => {
        const r = await obtenerCollerasActuales({ obtenerFn: jest.fn().mockResolvedValue({ resumen: {} }), db: dbConSnapshot(null) });
        expect(r.estado).toBe('no_disponible');
    });
});

describe('snapshots (no se guardan solos)', () => {
    test('construirSnapshot: OK solo con dato en vivo; el error se registra sin total', () => {
        expect(construirSnapshot({ estado: 'actual', total: 35, fechaDato: '2026-09-24T15:00:00.000Z' }, '2026-2027'))
            .toEqual({ fecha_snapshot: '2026-09-24T15:00:00.000Z', temporada: '2026-2027', total_colleras: 35, fuente: 'gestionderodeos.cl', estado_fuente: 'OK', detalle_error: null });
        expect(construirSnapshot({ estado: 'fallback', total: 33, detalle_error: 'x' }, '2026-2027', AHORA))
            .toMatchObject({ estado_fuente: 'ERROR', total_colleras: null, detalle_error: 'x' });
    });

    test('guardarSnapshot inserta la fila (función disponible para la fase siguiente; no está conectada a ninguna ruta)', async () => {
        const insert = jest.fn(() => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 's1' }, error: null }) }) }));
        const db = { from: jest.fn(() => ({ insert })) };
        const r = await guardarSnapshot({ estado: 'actual', total: 35, fechaDato: AHORA.toISOString() }, '2026-2027', { db });
        expect(db.from).toHaveBeenCalledWith('colleras_completas_snapshots');
        expect(insert.mock.calls[0][0]).toMatchObject({ estado_fuente: 'OK', total_colleras: 35 });
        expect(r.id).toBe('s1');
    });

    test('fechaDatoISO devuelve la fecha (Chile) del dato', () => {
        expect(fechaDatoISO({ fechaDato: '2026-09-24T15:00:00.000Z' })).toBe('2026-09-24');
        expect(fechaDatoISO({ fechaDato: null })).toBeNull();
    });
});

describe('registrarSnapshot (operación explícita, sin duplicar ni guardar fallbacks)', () => {
    function dbSnap({ ultimo = null, errorSelect = null } = {}) {
        const inserts = [];
        const db = {
            inserts,
            from: jest.fn(tabla => {
                const c = {};
                ['select', 'eq', 'order', 'limit', 'lte', 'gte'].forEach(m => { c[m] = () => c; });
                c.insert = v => { inserts.push({ tabla, v }); return { select: () => ({ single: () => Promise.resolve({ data: { id: 'nuevo', ...v }, error: null }) }) }; };
                c.then = res => Promise.resolve(tabla === 'temporadas'
                    ? { data: [{ nombre: '2026-2027' }], error: null }
                    : { data: ultimo ? [ultimo] : [], error: errorSelect }).then(res);
                return c;
            })
        };
        return db;
    }
    const ok = () => jest.fn().mockResolvedValue({ resumen: { totalCompletas: 35 }, filas: [] });

    test('fuente OK y sin snapshot del día → guarda (estado OK, temporada, total) y lo devuelve como último', async () => {
        const db = dbSnap({ ultimo: { fecha_snapshot: '2026-09-20T10:00:00Z', total_colleras: 33 } });
        const r = await registrarSnapshot({ obtenerFn: ok(), db, ahora: () => AHORA });
        expect(r).toMatchObject({ guardado: true, motivo: 'SNAPSHOT_GUARDADO', total_fuente: 35 });
        expect(db.inserts).toHaveLength(1);
        expect(db.inserts[0]).toMatchObject({ tabla: 'colleras_completas_snapshots', v: { estado_fuente: 'OK', total_colleras: 35, temporada: '2026-2027' } });
        expect(r.ultimo_snapshot.total_colleras).toBe(35);
    });

    test('ya existe un snapshot válido de la MISMA fecha (Chile) → no duplica', async () => {
        const db = dbSnap({ ultimo: { fecha_snapshot: '2026-09-24T12:00:00Z', total_colleras: 34 } });
        const r = await registrarSnapshot({ obtenerFn: ok(), db, ahora: () => AHORA });
        expect(r).toMatchObject({ guardado: false, motivo: 'YA_EXISTE_SNAPSHOT_VALIDO_DEL_DIA', total_fuente: 35 });
        expect(r.snapshot.total_colleras).toBe(34);
        expect(db.inserts).toHaveLength(0);
    });

    test('si la fuente falla NO guarda un fallback como dato nuevo y devuelve el último snapshot conocido', async () => {
        const db = dbSnap({ ultimo: { fecha_snapshot: '2026-09-20T10:00:00Z', total_colleras: 33 } });
        const r = await registrarSnapshot({ obtenerFn: jest.fn().mockRejectedValue(new Error('HTTP 500')), db, ahora: () => AHORA });
        expect(r).toMatchObject({ guardado: false, motivo: 'FUENTE_NO_DISPONIBLE', ultimo_snapshot: { total_colleras: 33 } });
        expect(r.detalle_error).toMatch(/HTTP 500/);
        expect(db.inserts).toHaveLength(0);
    });

    test('fuente lenta (timeout) o sin total numérico tampoco guardan', async () => {
        const db = dbSnap();
        expect((await registrarSnapshot({ obtenerFn: () => new Promise(() => {}), db, timeoutMs: 20, ahora: () => AHORA })).motivo).toBe('FUENTE_NO_DISPONIBLE');
        expect((await registrarSnapshot({ obtenerFn: jest.fn().mockResolvedValue({ resumen: {} }), db, ahora: () => AHORA })).motivo).toBe('FUENTE_NO_DISPONIBLE');
        expect(db.inserts).toHaveLength(0);
    });

    test('un snapshot de un día anterior no impide guardar el de hoy', async () => {
        const db = dbSnap({ ultimo: { fecha_snapshot: '2026-09-23T15:00:00Z', total_colleras: 30 } });
        expect((await registrarSnapshot({ obtenerFn: ok(), db, ahora: () => AHORA })).guardado).toBe(true);
    });
});
