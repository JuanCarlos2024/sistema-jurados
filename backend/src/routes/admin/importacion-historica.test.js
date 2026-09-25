// POST /admin/importacion/historicos/preview — permisos, validaciones de entrada y CERO escrituras (supabase en memoria).
const mockEscrituras = [];
const mockTablas = {};
jest.mock('../../config/supabase', () => {
    function from(tabla) {
        const q = { filtros: [], desde: 0, hasta: 1e9 };
        const ejecutar = () => { let f = (mockTablas[tabla] || []).slice(); q.filtros.forEach(x => { f = f.filter(x); }); return { data: f.slice(q.desde, q.hasta + 1), error: null }; };
        const api = {
            select() { return api; }, order() { return api; },
            eq(k, v) { q.filtros.push(r => r[k] === v); return api; }, neq(k, v) { q.filtros.push(r => r[k] !== v); return api; },
            gte(k, v) { q.filtros.push(r => r[k] >= v); return api; }, lte(k, v) { q.filtros.push(r => r[k] <= v); return api; },
            in(k, vs) { q.filtros.push(r => vs.includes(r[k])); return api; },
            range(d, h) { q.desde = d; q.hasta = h; return api; },
            maybeSingle() { return Promise.resolve({ data: ejecutar().data[0] || null, error: null }); },
            then(ok, ko) { return Promise.resolve(ejecutar()).then(ok, ko); }
        };
        for (const m of ['insert', 'update', 'upsert', 'delete']) api[m] = () => { mockEscrituras.push({ tabla, op: m }); return api; };
        return api;
    }
    return { from, rpc: () => { mockEscrituras.push({ op: 'rpc' }); return Promise.resolve({ data: null, error: null }); } };
});

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const XLSX = require('xlsx');
const { ENCABEZADOS } = require('../../services/importacionHistorica');
const router = require('./importacion-historica');

function servidor(rolEvaluacion) {
    const app = express();
    app.use((req, res, next) => { req.usuario = { id: 'u1', nombre: 'U', rol_evaluacion: rolEvaluacion }; next(); });
    app.use('/', router);
    return new Promise(r => { const s = app.listen(0, () => r(s)); });
}
function excel(filas, hoja = 'CARGA_HISTORICA') {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([ENCABEZADOS, ...filas]), hoja);
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
function post(server, { archivo, nombre = 'h.xlsx', campos = {} }) {
    const b = '----t' + Date.now();
    const partes = [];
    for (const [k, v] of Object.entries(campos)) partes.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    if (archivo) partes.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="archivo"; filename="${nombre}"\r\nContent-Type: application/octet-stream\r\n\r\n`), archivo, Buffer.from('\r\n'));
    partes.push(Buffer.from(`--${b}--\r\n`));
    const body = Buffer.concat(partes);
    return new Promise((resolve) => {
        const req = http.request({ port: server.address().port, path: '/preview', method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${b}`, 'Content-Length': body.length } }, (res) => {
            let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
        });
        req.end(body);
    });
}
function get(server, url) {
    return new Promise(resolve => http.get({ port: server.address().port, path: url }, res => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null })); }));
}

const FILA = ['', '15-02-2026', 'Club X', 'Osorno', 'Rodeo Libre', '', 'Juan Pérez', '', '', 6, 2];
beforeEach(() => {
    mockEscrituras.length = 0;
    mockTablas.temporadas = [{ id: 'T1', nombre: '2025-2026', fecha_inicio: '2025-04-01', fecha_fin: '2026-03-31', activa: false }];
    mockTablas.asociaciones = [{ id: 'A1', nombre: 'Asociación Osorno', nombre_normalizado: 'osorno', activa: true }];
    mockTablas.asociacion_alias = []; mockTablas.categorias_rodeo = [{ id: 'C3', nombre: 'Tercera', activo: true }];
    mockTablas.tipos_rodeo = [{ id: 'TP1', nombre: 'Rodeo Libre', duracion_dias: 1, categoria_rodeo_id: 'C3', activo: true }];
    mockTablas.usuarios_pagados = [{ id: 'J1', nombre_completo: 'Juan Pérez', categoria: 'Primera', activo: true, estado_usuario: 'activo', es_prueba: false, tipo_persona: 'jurado' }];
    mockTablas.rodeos = []; mockTablas.asignaciones = []; mockTablas.rodeo_notas_secundarias = []; mockTablas.evaluaciones = []; mockTablas.notas_rodeo = [];
});

describe('permisos (solo administrador pleno)', () => {
    test('admin pleno (rol_evaluacion null) accede y recibe la vista previa', async () => {
        const s = await servidor(null);
        try {
            const r = await post(s, { archivo: excel([FILA]), campos: { temporada_id: 'T1' } });
            expect(r.status).toBe(200);
            expect(r.body).toMatchObject({ modo: 'VISTA_PREVIA', escribe_base_de_datos: false, puede_confirmar: true });
            expect(r.body.resumen).toMatchObject({ filas_excel: 1, rodeos_nuevos: 1, evaluaciones_requeridas_casos_whatsapp: 1 });
            expect(mockEscrituras).toEqual([]);
        } finally { s.close(); }
    });
    test.each([['analista'], ['jefe_area'], ['monitor'], ['comision_tecnica'], ['director'], ['capacitador']])('rol %s recibe 403 en preview y temporadas', async (rol) => {
        const s = await servidor(rol);
        try {
            expect((await post(s, { archivo: excel([FILA]), campos: { temporada_id: 'T1' } })).status).toBe(403);
            expect((await get(s, '/temporadas')).status).toBe(403);
            expect(mockEscrituras).toEqual([]);
        } finally { s.close(); }
    });
    test('el router se monta bajo soloAdmin (registro en admin/index.js antes de /importacion)', () => {
        const idx = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const a = idx.indexOf("'/importacion/historicos'"), b = idx.indexOf("router.use('/importacion',");
        expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a);
        expect(idx.indexOf('router.use(soloAdmin)')).toBeLessThan(a);
        expect(fs.readFileSync(path.join(__dirname, 'importacion-historica.js'), 'utf8')).toMatch(/router\.use\(soloRolEvaluacion\(\)\)/);
    });
});

describe('validación de entrada', () => {
    test('sin archivo → 400', async () => {
        const s = await servidor(null);
        try { expect((await post(s, { campos: { temporada_id: 'T1' } })).body.codigo).toBe('SIN_ARCHIVO'); } finally { s.close(); }
    });
    test('extensión inválida → 400', async () => {
        const s = await servidor(null);
        try { const r = await post(s, { archivo: Buffer.from('x'), nombre: 'a.pdf', campos: { temporada_id: 'T1' } }); expect(r.status).toBe(400); expect(r.body.codigo).toBe('EXTENSION_INVALIDA'); } finally { s.close(); }
    });
    test('sin temporada / temporada inexistente / no habilitada → 400', async () => {
        const s = await servidor(null);
        try {
            expect((await post(s, { archivo: excel([FILA]) })).body.codigo).toBe('TEMPORADA_REQUERIDA');
            expect((await post(s, { archivo: excel([FILA]), campos: { temporada_id: 'nada' } })).body.codigo).toBe('TEMPORADA_INEXISTENTE');
            mockTablas.temporadas.push({ id: 'T2', nombre: '2026-2027', fecha_inicio: '2026-04-01', fecha_fin: '2027-03-31' });
            expect((await post(s, { archivo: excel([FILA]), campos: { temporada_id: 'T2' } })).body.codigo).toBe('TEMPORADA_NO_HABILITADA');
            expect(mockEscrituras).toEqual([]);
        } finally { s.close(); }
    });
    test('hoja incorrecta y encabezados incorrectos → 400 con mensaje', async () => {
        const s = await servidor(null);
        try {
            const r1 = await post(s, { archivo: excel([FILA], 'Otra'), campos: { temporada_id: 'T1' } });
            expect(r1.status).toBe(400); expect(r1.body.codigo).toBe('HOJA_NO_ENCONTRADA'); expect(r1.body.error).toMatch(/CARGA_HISTORICA/);
            const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['A', 'B'], [1, 2]]), 'CARGA_HISTORICA');
            const r2 = await post(s, { archivo: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), campos: { temporada_id: 'T1' } });
            expect(r2.body.codigo).toBe('ENCABEZADOS_INCORRECTOS');
            expect(typeof r2.body.error).toBe('string');
        } finally { s.close(); }
    });
    test('rutas expuestas: temporadas (GET), preview (POST, solo lectura) y confirmar (POST, escritura por RPC)', () => {
        const rutas = router.stack.filter(l => l.route).map(l => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
        expect(rutas.sort()).toEqual(['GET /temporadas', 'POST /confirmar', 'POST /preview']);
    });
});

describe('frontend: página, navegación y bloqueo por rol (guardas estáticas)', () => {
    const raiz = path.join(__dirname, '..', '..', '..', '..', 'frontend');
    const leer = f => fs.readFileSync(path.join(raiz, f), 'utf8').replace(/\r\n/g, '\n');
    const html = leer('admin/importacion-historica.html');
    test('título, selector, archivo, VALIDAR ARCHIVO y CONFIRMAR IMPORTACIÓN (deshabilitado hasta validar)', () => {
        expect(html).toMatch(/IMPORTAR RODEOS HISTÓRICOS/);
        expect(html).toMatch(/id="sel-temporada"/);
        expect(html).toMatch(/type="file" id="input-archivo" accept="\.xlsx,\.xls"/);
        expect(html).toMatch(/VALIDAR ARCHIVO/);
        expect(html).toMatch(/<button[^>]*id="btn-confirmar" disabled onclick="abrirConfirmacion\(\)"[^>]*>CONFIRMAR IMPORTACIÓN<\/button>/);
    });
    test('usa preview, temporadas y confirmar; no llama a ninguna otra API de escritura', () => {
        expect(html).toMatch(/api\.upload\('\/admin\/importacion\/historicos\/preview'/);
        expect(html).toMatch(/api\.upload\('\/admin\/importacion\/historicos\/confirmar'/);
        expect(html).toMatch(/api\.get\('\/admin\/importacion\/historicos\/temporadas'\)/);
        expect(html).not.toMatch(/api\.(post|put|patch|delete)\(/);
        expect(html).not.toMatch(/\/admin\/importacion\/excel/);
    });
    test('DOBLE CONFIRMACIÓN: el botón principal solo abre el diálogo; únicamente el botón del diálogo llama a /confirmar', () => {
        const abrir = html.slice(html.indexOf('function abrirConfirmacion'), html.indexOf('function cerrarConfirmacion'));
        expect(abrir).not.toMatch(/api\./);
        expect(abrir).toMatch(/style\.display = 'flex'/);
        expect(html).toMatch(/id="btn-modal-confirmar" onclick="ejecutarImportacion\(\)"/);
        expect(html.match(/historicos\/confirmar/g)).toHaveLength(1);
        for (const t of ['Se crearán rodeos', 'Se reutilizarán rodeos existentes', 'Se crearán asignaciones', 'Notas Delegado', 'Notas Comisión', 'Notas Deportivas', 'Casos por WhatsApp', 'Evaluaciones históricas', 'Se omitirán', 'Conflictos que NO serán sobrescritos', 'Pagos históricos']) expect(abrir).toContain(t);
        expect(html).toMatch(/CONFIRMAR IMPORTACIÓN HISTÓRICA/);
        expect(html).toMatch(/onclick="cerrarConfirmacion\(\)">Cancelar/);
    });
    test('el botón se habilita solo con validación vigente (mismo archivo, misma temporada, con acciones) y envía el hash validado', () => {
        expect(html).toMatch(/preview\.puede_confirmar && archivo === validado\.archivo && temporadaId === validado\.temporadaId/);
        expect(html).toMatch(/validado = \{ archivo, temporadaId, sha256: preview\.sha256 \}/);
        expect(html).toMatch(/fd\.append\('sha256', validado\.sha256\)/);
        expect(html).toMatch(/getElementById\('input-archivo'\)\.addEventListener\('change', invalidarValidacion\)/);
        expect(html).toMatch(/getElementById\('sel-temporada'\)\.addEventListener\('change', invalidarValidacion\)/);
    });
    test('BLOQUEO de doble envío: bandera _enviando, botones desactivados durante el envío e indicador de progreso', () => {
        const ejecutar = html.slice(html.indexOf('async function ejecutarImportacion'), html.indexOf('// ── Resultado final'));
        expect(ejecutar).toMatch(/if \(_enviando \|\| !validacionVigente\(\)\) return;\n\s+_enviando = true;/);
        expect(ejecutar).toMatch(/btnOk\.disabled = true; btnNo\.disabled = true;/);
        expect(ejecutar).toMatch(/btn-validar'\)\.disabled = true/);
        expect(ejecutar).toMatch(/progreso'\)\.classList\.remove\('oculto'\)/);
        expect(ejecutar).toMatch(/finally \{\n\s+_enviando = false;/);
        expect(html).toMatch(/btn\.disabled = _enviando \|\| !validacionVigente\(\)/);
    });
    test('pantalla de resultado con contadores del servidor, detalle por fila y CSV', () => {
        for (const t of ['Rodeos creados', 'Rodeos ya existentes', 'Asignaciones creadas', 'Asignaciones ya existentes', 'Notas Delegado cargadas', 'Notas Comisión cargadas', 'Notas Deportivas cargadas', 'Casos por WhatsApp cargados', 'Evaluaciones históricas creadas', 'Datos ya existentes sin cambios', 'Conflictos no sobrescritos', 'Filas omitidas', 'Filas con error', 'Acciones realizadas', 'Estado final']) expect(html).toContain(t);
        expect(html).toMatch(/descargarResultadoCsv/);
        expect(html).toMatch(/resultado\.resumen/);
    });
    test('escapa el contenido del archivo antes de mostrarlo (XSS)', () => {
        expect(html).toMatch(/const esc = v => sanitizar\(/);
        expect(html).not.toMatch(/innerHTML\s*=\s*[^;]*\$\{f\.(jurado|club)\.[a-z]+\}(?!.*esc)/);
    });
    test('navegación y bloqueo para roles de evaluación', () => {
        expect(leer('js/admin-nav.js')).toMatch(/\/admin\/importacion-historica\.html/);
        expect(leer('js/utils.js')).toMatch(/_PAGINAS_BLOQUEADAS_EVAL = \[[^\]]*'\/admin\/importacion-historica\.html'/);
    });
});
