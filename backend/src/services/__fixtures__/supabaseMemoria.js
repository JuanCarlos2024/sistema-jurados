// Supabase EN MEMORIA para pruebas de rutas/servicios (no es parte de la aplicación).
// Soporta: select/eq/neq/in/gte/lte/is/order/range/limit/single/maybeSingle/insert/update/delete, claves únicas (23505),
// conteo exacto, rpc con manejadores y un registro de llamadas. Los filtros sobre columnas se aplican de verdad.
function crearSupabaseMemoria({ tablas = {}, unicos = {}, rpc = {} } = {}) {
    const calls = [];
    let seq = 0;
    const filas = (t) => (tablas[t] = tablas[t] || []);

    function from(tabla) {
        const q = { op: 'select', filtros: [], payload: null, orden: null, desde: 0, hasta: Infinity, cuenta: false, unico: null };
        const registro = { tabla, filtros: [] };
        const coinciden = () => {
            let r = filas(tabla).filter(f => q.filtros.every(fn => fn(f)));
            if (q.orden) r = r.slice().sort((a, b) => (a[q.orden.k] > b[q.orden.k] ? 1 : a[q.orden.k] < b[q.orden.k] ? -1 : 0) * (q.orden.asc ? 1 : -1));
            return r;
        };
        const ejecutar = () => {
            calls.push({ tabla, op: q.op, payload: q.payload, filtros: registro.filtros.slice() });
            if (q.op === 'insert') {
                const nuevas = [];
                for (const p of [].concat(q.payload)) {
                    for (const cols of (unicos[tabla] || [])) {
                        if (filas(tabla).some(f => cols.every(c => f[c] === p[c]))) return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint on ${tabla}(${cols})` } };
                    }
                    const fila = { id: `${tabla}-${++seq}`, ...p };
                    nuevas.push(fila);
                }
                filas(tabla).push(...nuevas);
                return q.unico ? { data: nuevas[0], error: null } : { data: nuevas, error: null };
            }
            if (q.op === 'update') { const r = coinciden(); r.forEach(f => Object.assign(f, q.payload)); return q.unico ? { data: r[0] || null, error: null } : { data: r, error: null }; }
            if (q.op === 'delete') { const r = coinciden(); tablas[tabla] = filas(tabla).filter(f => !r.includes(f)); return { data: r, error: null }; }
            const r = coinciden();
            const pagina = r.slice(q.desde, q.hasta === Infinity ? undefined : q.hasta + 1);
            if (q.unico === 'single') return pagina.length === 1 ? { data: pagina[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
            if (q.unico === 'maybe') return { data: pagina[0] || null, error: null };
            return { data: pagina, error: null, count: q.cuenta ? r.length : null };
        };
        const filtro = (nombre, fn, k, v) => { registro.filtros.push([nombre, k, v]); q.filtros.push(fn); };
        const api = {
            select(_c, opts) { if (opts && opts.count) q.cuenta = true; if (q.op === 'insert' || q.op === 'update') q.unico = q.unico || null; return api; },
            insert(p) { q.op = 'insert'; q.payload = p; return api; },
            update(p) { q.op = 'update'; q.payload = p; return api; },
            delete() { q.op = 'delete'; return api; },
            eq(k, v) { filtro('eq', f => f[k] === v, k, v); return api; },
            neq(k, v) { filtro('neq', f => f[k] !== v, k, v); return api; },
            in(k, vs) { filtro('in', f => vs.includes(f[k]), k, vs); return api; },
            gte(k, v) { filtro('gte', f => f[k] >= v, k, v); return api; },
            lte(k, v) { filtro('lte', f => f[k] <= v, k, v); return api; },
            is(k, v) { filtro('is', f => (f[k] ?? null) === v, k, v); return api; },
            ilike() { return api; }, or() { return api; },
            order(k, o) { q.orden = { k, asc: !(o && o.ascending === false) }; return api; },
            range(d, h) { q.desde = d; q.hasta = h; return api; },
            limit(n) { q.hasta = q.desde + n - 1; return api; },
            single() { q.unico = 'single'; return Promise.resolve(ejecutar()); },
            maybeSingle() { q.unico = 'maybe'; return Promise.resolve(ejecutar()); },
            then(ok, ko) { return Promise.resolve(ejecutar()).then(ok, ko); }
        };
        // insert(...).select().single() → single sobre la fila insertada
        const selectOriginal = api.select;
        api.select = function (c, o) { selectOriginal.call(api, c, o); return api; };
        return api;
    }
    return {
        from, tablas, calls,
        rpc: (nombre, args) => { calls.push({ tabla: `rpc:${nombre}`, op: 'rpc', payload: args, filtros: [] }); const h = rpc[nombre]; return Promise.resolve(h ? h(args, { tablas }) : { data: null, error: { message: 'rpc no definida: ' + nombre } }); },
        llamadas: (tabla, op) => calls.filter(c => c.tabla === tabla && (!op || c.op === op))
    };
}

// Llama a un router de Express sin red: devuelve { statusCode, body }.
function llamarRouter(router, { metodo = 'GET', url = '/', usuario = { id: 'ADMIN-1', nombre: 'Admin', rol_evaluacion: null }, body = {}, query = {}, params = {} } = {}) {
    return new Promise((resolve) => {
        const req = { method: metodo, url, originalUrl: url, query, params, headers: {}, body, ip: '127.0.0.1', usuario, get() { return undefined; } };
        const res = { statusCode: 200, headers: {}, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; resolve(this); return this; }, send(p) { this.body = p; resolve(this); return this; } };
        router(req, res, (err) => { res.statusCode = err ? 500 : 404; res.body = err ? { error: err.message } : {}; resolve(res); });
    });
}

module.exports = { crearSupabaseMemoria, llamarRouter };
