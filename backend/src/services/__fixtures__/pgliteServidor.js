// Proceso auxiliar de PRUEBAS: levanta un Postgres en memoria (PGlite) y atiende consultas por stdio (una línea JSON por mensaje).
// Se ejecuta con `node` normal (no dentro de Jest) porque PGlite usa import() dinámico. No es parte de la aplicación.
const readline = require('readline');
const { PGlite } = require('@electric-sql/pglite');

const db = new PGlite();
const rl = readline.createInterface({ input: process.stdin });
let cola = Promise.resolve();

rl.on('line', (linea) => {
    cola = cola.then(async () => {
        const { id, op, sql, params } = JSON.parse(linea);
        try {
            if (op === 'exec') { await db.exec(sql); process.stdout.write(JSON.stringify({ id, rows: [] }) + '\n'); }
            else if (op === 'query') { const r = await db.query(sql, params || []); process.stdout.write(JSON.stringify({ id, rows: r.rows }) + '\n'); }
            else if (op === 'close') { await db.close(); process.stdout.write(JSON.stringify({ id, rows: [] }) + '\n'); process.exit(0); }
        } catch (e) {
            process.stdout.write(JSON.stringify({ id, error: e.message }) + '\n');
        }
    });
});
