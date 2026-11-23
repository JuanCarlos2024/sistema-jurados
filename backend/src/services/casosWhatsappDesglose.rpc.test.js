// Migración 107 contra un PostgreSQL REAL de prueba (PGlite): columnas
// nullable, restricción de suma y registros existentes intactos.
const fs = require('fs');
const path = require('path');
jest.setTimeout(60000);
const { crearDb } = require('./__fixtures__/pgliteCliente');
const M107 = fs.readFileSync(path.join(__dirname, '../../../database/migrations/107_casos_whatsapp_bien_mal_jurado.sql'), 'utf8');

let db;
const q = async (sql, p) => (await db.query(sql, p)).rows;

beforeAll(async () => {
    db = crearDb();
    // Lo mínimo de evaluaciones que la 107 necesita (casos_whatsapp de la 059).
    await db.exec(`CREATE TABLE public.evaluaciones (
        id INT PRIMARY KEY, nota_final NUMERIC,
        casos_whatsapp INTEGER NOT NULL DEFAULT 0 CONSTRAINT chk_evaluaciones_casos_whatsapp CHECK (casos_whatsapp >= 0));
        INSERT INTO evaluaciones VALUES (1, 6.1, 20), (2, 5.5, 0), (3, 6.0, 3);`);
    await db.exec(M107);
});
afterAll(async () => { await db.close(); });

test('registros existentes quedan SIN desglose (NULL) y sin otros cambios', async () => {
    expect(await q('select id, nota_final::text, casos_whatsapp, casos_whatsapp_bien_jurado b, casos_whatsapp_mal_jurado m from evaluaciones order by id'))
        .toEqual([
            { id: 1, nota_final: '6.1', casos_whatsapp: 20, b: null, m: null },
            { id: 2, nota_final: '5.5', casos_whatsapp: 0, b: null, m: null },
            { id: 3, nota_final: '6.0', casos_whatsapp: 3, b: null, m: null }
        ]);
});

test('desglose que suma el total → aceptado (20 = 5 + 15)', async () => {
    await q('update evaluaciones set casos_whatsapp_bien_jurado = 5, casos_whatsapp_mal_jurado = 15 where id = 1');
    expect((await q('select casos_whatsapp_bien_jurado b, casos_whatsapp_mal_jurado m from evaluaciones where id = 1'))[0]).toEqual({ b: 5, m: 15 });
});

test.each([
    ['suma distinta', 'casos_whatsapp_bien_jurado = 1, casos_whatsapp_mal_jurado = 1'],
    ['negativo', 'casos_whatsapp_bien_jurado = -1, casos_whatsapp_mal_jurado = 4'],
    ['solo uno', 'casos_whatsapp_bien_jurado = 3, casos_whatsapp_mal_jurado = NULL'],
    ['cambia el total sin ajustar el desglose', 'casos_whatsapp = 21']
])('la base rechaza: %s', async (_n, set) => {
    const id = set.startsWith('casos_whatsapp =') ? 1 : 3;
    await expect(q(`update evaluaciones set ${set} where id = ${id}`)).rejects.toThrow(/chk_evaluaciones_casos_whatsapp_desglose/);
});

test('la 107 es idempotente', async () => {
    await expect(db.exec(M107)).resolves.toBeDefined();
    expect((await q('select casos_whatsapp_bien_jurado b from evaluaciones where id = 1'))[0].b).toBe(5);
});
