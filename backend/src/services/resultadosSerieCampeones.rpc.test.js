// Migración 101 — resultados Serie de Campeones desde Control de Gestión,
// verificada contra Postgres REAL (PGlite), no mocks. La RPC se invoca como
// service_role (el único rol con EXECUTE), igual que el backend.
jest.setTimeout(120000);
const fs = require('fs');
const path = require('path');
const { crearDb } = require('./__fixtures__/pgliteCliente');

const MIGRACION = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'database', 'migrations',
    '101_resultados_serie_campeones_control_gestion.sql'), 'utf8');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaResultadosSerieCampeones.sql'), 'utf8');
const FIRMA = 'aplicar_resultados_serie_campeones_rodeo(uuid,text[],boolean,text[],uuid,uuid)';
const ACTOR = '11111111-1111-1111-1111-111111111111';
const IMPORTACION = '22222222-2222-2222-2222-222222222222';

let db;
async function q(sql, p) { return (await db.query(sql, p)).rows; }
const crearRodeo = async (estado = 'activo') => (await q('insert into rodeos (estado) values ($1) returning id', [estado]))[0].id;
async function datosMonitor(rodeoId, p1, p2, p3, comentario = 'Comentario manual intacto') {
    await q(`insert into datos_monitor_rodeo (rodeo_id, puntaje_oficial_1er, puntaje_oficial_2do, puntaje_oficial_3er, comentario_monitor, control_gestion_ultimo_bloque)
             values ($1, $2, $3, $4, $5, 'bloque CG')`, [rodeoId, p1, p2, p3, comentario]);
}
const fila = async (rodeoId) => (await q('select * from datos_monitor_rodeo where rodeo_id = $1', [rodeoId]))[0];
const auditorias = async (rodeoId) => q(`select * from auditoria where registro_id = $1 order by created_at`, [String(rodeoId)]);
async function aplicar(rodeoId, puntajes, { reemplazar = false, esperados = null, actor = ACTOR } = {}) {
    await db.exec('SET ROLE service_role');
    try {
        return (await q('select aplicar_resultados_serie_campeones_rodeo($1, $2, $3, $4, $5, $6) r',
            [rodeoId, puntajes, reemplazar, esperados, IMPORTACION, actor]))[0].r;
    } finally {
        await db.exec('RESET ROLE');
    }
}
const estados = (r) => r.lugares.map(l => l.estado);

beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);
    await db.exec(MIGRACION);
});
afterAll(async () => { await db.close(); });

describe('Migración 101 — estructura y seguridad', () => {
    test('una sola firma, SECURITY INVOKER, search_path fijo, bloqueos FOR SHARE / FOR UPDATE', async () => {
        const f = await q(`select p.oid::regprocedure::text firma, p.prosecdef, p.proconfig, pg_get_functiondef(p.oid) def
                           from pg_proc p where p.proname = 'aplicar_resultados_serie_campeones_rodeo'`);
        expect(f).toHaveLength(1);
        expect(f[0].firma).toBe(FIRMA);
        expect(f[0].prosecdef).toBe(false);
        expect(f[0].proconfig).toEqual(['search_path=public']);
        expect(f[0].def).toMatch(/FOR SHARE/);
        expect(f[0].def).toMatch(/FOR UPDATE/);
    });

    test('EXECUTE solo para service_role (nunca PUBLIC, anon ni authenticated)', async () => {
        const r = (await q(`select has_function_privilege('service_role', '${FIRMA}', 'EXECUTE') s,
                                   has_function_privilege('anon', '${FIRMA}', 'EXECUTE') a,
                                   has_function_privilege('authenticated', '${FIRMA}', 'EXECUTE') au`))[0];
        expect(r).toEqual({ s: true, a: false, au: false });
    });

    test('es re-ejecutable (CREATE OR REPLACE) sin duplicar la función', async () => {
        await db.exec(MIGRACION);
        expect(await q(`select 1 from pg_proc where proname = 'aplicar_resultados_serie_campeones_rodeo'`)).toHaveLength(1);
    });

    test('no altera el esquema de datos_monitor_rodeo (puntajes siguen siendo TEXT)', async () => {
        const cols = await q(`select column_name, data_type from information_schema.columns
                              where table_name = 'datos_monitor_rodeo' and column_name like 'puntaje_oficial_%' order by 1`);
        expect(cols.map(c => c.data_type)).toEqual(['text', 'text', 'text']);
    });
});

describe('Rodeo sin puntajes previos', () => {
    test('crea la fila y guarda los desempates como TEXTO exacto; auditoría en la misma transacción', async () => {
        const r = await crearRodeo();
        const res = await aplicar(r, ['27+8', '27-1', '22+5+3']);
        expect(estados(res)).toEqual(['importado', 'importado', 'importado']);
        expect(res.cambio).toBe(true);
        const f = await fila(r);
        expect([f.puntaje_oficial_1er, f.puntaje_oficial_2do, f.puntaje_oficial_3er]).toEqual(['27+8', '27-1', '22+5+3']);
        expect(f.comentario_monitor).toBeNull();
        const a = await auditorias(r);
        expect(a).toHaveLength(1);
        expect(a[0]).toMatchObject({ tabla: 'datos_monitor_rodeo', accion: 'importar_resultados_serie_campeones', actor_id: ACTOR, actor_tipo: 'administrador' });
        expect(a[0].datos_anteriores).toEqual({ puntaje_oficial_1er: null, puntaje_oficial_2do: null, puntaje_oficial_3er: null });
        expect(a[0].datos_nuevos).toMatchObject({ puntaje_oficial_1er: '27+8', importacion_id: IMPORTACION, reemplazo_autorizado: false });
    });

    test('vacío = no informado: nunca se convierte en 0 ni crea valor', async () => {
        const r = await crearRodeo();
        const res = await aplicar(r, ['30+12', null, '']);
        expect(estados(res)).toEqual(['importado', 'no_informado', 'no_informado']);
        const f = await fila(r);
        expect([f.puntaje_oficial_1er, f.puntaje_oficial_2do, f.puntaje_oficial_3er]).toEqual(['30+12', null, null]);
    });

    test('quita espacios: "24 + 8" se guarda "24+8"', async () => {
        const r = await crearRodeo();
        await aplicar(r, ['24 + 8', null, null]);
        expect((await fila(r)).puntaje_oficial_1er).toBe('24+8');
    });
});

describe('Rodeo con puntajes registrados — nunca se sobrescribe silenciosamente', () => {
    test('completar: llena solo vacíos, iguales no se tocan, conflictos se conservan; comentario intacto', async () => {
        const r = await crearRodeo();
        await datosMonitor(r, '27+8', '25', null);
        const res = await aplicar(r, ['27 + 8', '26', '22']);
        expect(estados(res)).toEqual(['igual', 'conflicto_conservado', 'importado']);
        const f = await fila(r);
        expect([f.puntaje_oficial_1er, f.puntaje_oficial_2do, f.puntaje_oficial_3er]).toEqual(['27+8', '25', '22']);
        expect(f.comentario_monitor).toBe('Comentario manual intacto');
        expect(f.control_gestion_ultimo_bloque).toBe('bloque CG');
        expect(res.lugares[1]).toMatchObject({ anterior: '25', excel: '26', final: '25' });
    });

    test('todo igual o conflicto conservado -> sin cambios: ni UPDATE ni auditoría', async () => {
        const r = await crearRodeo();
        await datosMonitor(r, '27+8', '25', '22');
        const antes = await fila(r);
        const res = await aplicar(r, ['27+8', '99', null]);
        expect(res.cambio).toBe(false);
        expect(await fila(r)).toEqual(antes);
        expect(await auditorias(r)).toHaveLength(0);
    });

    test('reemplazar con el valor vigente que vio el administrador -> reemplaza y audita el anterior', async () => {
        const r = await crearRodeo();
        await datosMonitor(r, '27+8', '25', null);
        const res = await aplicar(r, ['28', '26', null], { reemplazar: true, esperados: ['27+8', '25', null] });
        expect(estados(res)).toEqual(['reemplazado', 'reemplazado', 'no_informado']);
        const f = await fila(r);
        expect([f.puntaje_oficial_1er, f.puntaje_oficial_2do]).toEqual(['28', '26']);
        const a = await auditorias(r);
        expect(a[0].datos_anteriores).toMatchObject({ puntaje_oficial_1er: '27+8', puntaje_oficial_2do: '25' });
        expect(a[0].datos_nuevos).toMatchObject({ puntaje_oficial_1er: '28', reemplazo_autorizado: true });
    });

    test('reemplazar pero el valor cambió desde la previsualización -> se conserva (cambio concurrente)', async () => {
        const r = await crearRodeo();
        await datosMonitor(r, '30', '25', null);
        const res = await aplicar(r, ['28', '26', null], { reemplazar: true, esperados: ['27+8', '25', null] });
        expect(estados(res)).toEqual(['conflicto_cambio_concurrente', 'reemplazado', 'no_informado']);
        expect((await fila(r)).puntaje_oficial_1er).toBe('30');
    });

    test('reemplazar sin valores vistos -> rechazado sin escribir', async () => {
        const r = await crearRodeo();
        await datosMonitor(r, '30', null, null);
        await expect(aplicar(r, ['28', null, null], { reemplazar: true, esperados: null })).rejects.toThrow(/ESPERADOS_REQUERIDOS/);
        expect((await fila(r)).puntaje_oficial_1er).toBe('30');
    });
});

describe('Validaciones — rechazo completo, nada se escribe', () => {
    test('Rodeo ID inexistente -> RODEO_NO_ENCONTRADO (no se crea fila huérfana)', async () => {
        const fantasma = '33333333-3333-3333-3333-333333333333';
        await expect(aplicar(fantasma, ['27', null, null])).rejects.toThrow(/RODEO_NO_ENCONTRADO/);
        expect(await q('select 1 from datos_monitor_rodeo where rodeo_id = $1', [fantasma])).toHaveLength(0);
    });

    test('rodeo anulado -> RODEO_ANULADO', async () => {
        const r = await crearRodeo('anulado');
        await expect(aplicar(r, ['27', null, null])).rejects.toThrow(/RODEO_ANULADO/);
        expect(await fila(r)).toBeUndefined();
    });

    test.each([['27.5'], ['abc'], ['27++8'], ['+8'], ['-3'], ['1'.repeat(31)]])('formato inválido %p -> PUNTAJE_FORMATO_INVALIDO', async (v) => {
        const r = await crearRodeo();
        await expect(aplicar(r, ['27', v, null])).rejects.toThrow(/PUNTAJE_FORMATO_INVALIDO/);
        expect(await fila(r)).toBeUndefined();
    });

    test('sin resultados, arreglo de largo distinto de 3 o sin actor -> rechazado', async () => {
        const r = await crearRodeo();
        await expect(aplicar(r, [null, '', ' '])).rejects.toThrow(/SIN_RESULTADOS/);
        await expect(aplicar(r, ['27', '26'])).rejects.toThrow(/PUNTAJES_INVALIDOS/);
        await expect(aplicar(r, ['27', null, null], { actor: null })).rejects.toThrow(/ACTOR_REQUERIDO/);
        expect(await fila(r)).toBeUndefined();
    });

    test('anon no puede ejecutarla', async () => {
        const r = await crearRodeo();
        await db.exec('SET ROLE anon');
        try {
            await expect(q('select aplicar_resultados_serie_campeones_rodeo($1, $2, false, null, null, $3)', [r, ['27', null, null], ACTOR]))
                .rejects.toThrow(/permission denied/);
        } finally {
            await db.exec('RESET ROLE');
        }
    });
});
