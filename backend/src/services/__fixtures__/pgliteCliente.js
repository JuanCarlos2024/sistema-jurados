// Cliente de PRUEBAS para el Postgres en memoria (PGlite). PGlite corre en un proceso Node aparte (pgliteServidor.js) porque usa
// import() dinámico, incompatible con el VM de Jest. No es parte de la aplicación.
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

// opciones.extensiones: extensiones contrib de PGlite a cargar (p. ej.
// ['unaccent']). Opcional: sin ella, idéntico a antes.
function crearDb(opciones = {}) {
    const env = { ...process.env };
    if (Array.isArray(opciones.extensiones) && opciones.extensiones.length) env.PGLITE_EXTENSIONES = opciones.extensiones.join(',');
    else delete env.PGLITE_EXTENSIONES;
    const hijo = spawn(process.execPath, [path.join(__dirname, 'pgliteServidor.js')], { stdio: ['pipe', 'pipe', 'inherit'], env });
    const pendientes = new Map();
    let seq = 0;
    readline.createInterface({ input: hijo.stdout }).on('line', (l) => {
        const m = JSON.parse(l); const p = pendientes.get(m.id); pendientes.delete(m.id);
        if (!p) return;
        if (m.error) p.reject(new Error(m.error)); else p.resolve({ rows: m.rows });
    });
    const enviar = (msg) => new Promise((resolve, reject) => { const id = ++seq; pendientes.set(id, { resolve, reject }); hijo.stdin.write(JSON.stringify({ id, ...msg }) + '\n'); });
    return {
        exec: (sql) => enviar({ op: 'exec', sql }),
        query: (sql, params) => enviar({ op: 'query', sql, params }),
        close: async () => { hijo.stdin.write(JSON.stringify({ id: ++seq, op: 'close' }) + '\n'); }
    };
}

module.exports = { crearDb };
