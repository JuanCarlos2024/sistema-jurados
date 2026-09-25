// POST /admin/importacion/historicos/confirmar — el backend revalida TODO y solo entonces llama a la RPC (mockeada aquí;
// la RPC real se prueba sobre Postgres en services/importacionHistorica.rpc.test.js). Sin BD real.
const mockTablas = {};
const mockRpcLlamadas = [];
let mockRpcImpl = null;
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
        // Ninguna escritura directa por la API de tablas: TODO pasa por la RPC.
        for (const m of ['insert', 'update', 'upsert', 'delete']) api[m] = () => { throw new Error('ESCRITURA DIRECTA NO PERMITIDA: ' + tabla + '.' + m); };
        return api;
    }
    return { from, rpc: (nombre, args) => { mockRpcLlamadas.push({ nombre, args }); return mockRpcImpl(nombre, args); } };
});

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const XLSX = require('xlsx');
const { ENCABEZADOS, sha256Buffer } = require('../../services/importacionHistorica');
const router = require('./importacion-historica');

function servidor(rol = null, adminId = 'ADMIN-1') {
    const app = express();
    app.use((req, res, next) => { req.usuario = { id: adminId, nombre: 'U', rol_evaluacion: rol }; next(); });
    app.use('/', router);
    return new Promise(r => { const s = app.listen(0, () => r(s)); });
}
const excel = (filas, hoja = 'CARGA_HISTORICA') => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([ENCABEZADOS, ...filas]), hoja); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };
function post(server, url, { archivo, nombre = 'h.xlsx', campos = {} }) {
    const b = '----t' + Date.now() + Math.random();
    const partes = [];
    for (const [k, v] of Object.entries(campos)) partes.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    if (archivo) partes.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="archivo"; filename="${nombre}"\r\nContent-Type: application/octet-stream\r\n\r\n`), archivo, Buffer.from('\r\n'));
    partes.push(Buffer.from(`--${b}--\r\n`));
    const body = Buffer.concat(partes);
    return new Promise((resolve) => {
        const req = http.request({ port: server.address().port, path: url, method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${b}`, 'Content-Length': body.length } }, (res) => {
            let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
        });
        req.end(body);
    });
}

// ── Datos de prueba ──────────────────────────────────────────────────────
const F = (o = {}) => { const base = { Temporada: '', Fecha: '15-02-2026', Club: 'Club X', 'Asociación': 'Osorno', 'Tipo Rodeo': 'Rodeo Libre', 'Categoría del Rodeo': '', 'Nombre Jurado': 'Juan Pérez', 'Nota Delegado': '', 'Nota Comisión': '', 'Nota Deportiva': '', 'Casos por WhatsApp': '', ...o }; return ENCABEZADOS.map(c => base[c]); };
beforeEach(() => {
    mockRpcLlamadas.length = 0;
    // La RPC simulada devuelve un resultado coherente con el payload recibido (como haría la real ante una base vacía)
    mockRpcImpl = async (nombre, a) => ({
        data: {
            importacion_id: 'IMP-1',
            resumen: { rodeos_creados: a.p_grupos.length, rodeos_reutilizados: 0, rodeos_omitidos: 0, asignaciones_creadas: a.p_grupos.reduce((s, g) => s + g.filas.length, 0), asignaciones_existentes: 0, notas_delegado_cargadas: 0, notas_comision_cargadas: 0, notas_deportivas_cargadas: 0, casos_whatsapp_cargados: 0, evaluaciones_historicas_creadas: 0, conflictos_total: 0, pagos_generados: 0 },
            grupos: a.p_grupos.map(g => ({ clave: g.clave, rodeo_id: 'R-' + g.clave, accion_rodeo: 'CREADO', acciones: ['Rodeo creado'], existentes: [], conflictos: [], errores: [] })),
            filas: a.p_grupos.flatMap(g => g.filas.map(f => ({ clave: g.clave, fila: f.fila, jurado: f.jurado, asignacion_id: 'A', acciones: ['Asignación histórica creada (aceptada, no publicada, pago $0)'], existentes: [], conflictos: [], errores: [] })))
        }, error: null
    });
    mockTablas.temporadas = [{ id: 'T1', nombre: '2025-2026', fecha_inicio: '2025-04-01', fecha_fin: '2026-03-31' }, { id: 'T2', nombre: '2026-2027', fecha_inicio: '2026-04-01', fecha_fin: '2027-03-31' }];
    mockTablas.asociaciones = [{ id: 'A1', nombre: 'Asociación Osorno', nombre_normalizado: 'osorno', activa: true }];
    mockTablas.asociacion_alias = [{ asociacion_id: 'A1', alias: 'Osorno Sur', alias_normalizado: 'osorno sur' }];
    mockTablas.categorias_rodeo = [{ id: 'C3', nombre: 'Tercera', activo: true }];
    mockTablas.tipos_rodeo = [{ id: 'TP1', nombre: 'Rodeo Libre', duracion_dias: 1, categoria_rodeo_id: 'C3', activo: true }];
    mockTablas.usuarios_pagados = [
        { id: 'J1', nombre_completo: 'Juan Pérez', categoria: 'A', activo: true, estado_usuario: 'activo', es_prueba: false, tipo_persona: 'jurado' },
        { id: 'J2', nombre_completo: 'María González', categoria: 'B', activo: true, estado_usuario: 'activo', es_prueba: false, tipo_persona: 'jurado' },
        { id: 'J3', nombre_completo: 'Pedro Inactivo', categoria: 'C', activo: false, estado_usuario: 'inactivo', es_prueba: false, tipo_persona: 'jurado' },
        { id: 'J4', nombre_completo: 'Ana Receso', categoria: null, activo: true, estado_usuario: 'receso', es_prueba: false, tipo_persona: 'jurado' },
        { id: 'J5', nombre_completo: 'Homónimo Uno', categoria: 'A', activo: true, estado_usuario: 'activo', es_prueba: false, tipo_persona: 'jurado' },
        { id: 'J6', nombre_completo: 'Homonimo uno', categoria: 'B', activo: true, estado_usuario: 'activo', es_prueba: false, tipo_persona: 'jurado' },
        { id: 'J7', nombre_completo: 'Usuario Prueba', categoria: 'A', activo: true, estado_usuario: 'activo', es_prueba: true, tipo_persona: 'jurado' }
    ];
    mockTablas.rodeos = []; mockTablas.asignaciones = []; mockTablas.rodeo_notas_secundarias = []; mockTablas.evaluaciones = []; mockTablas.notas_rodeo = [];
});

async function confirmar(filas, { rol = null, temporada = 'T1', hash, extra = {}, archivo, adminId } = {}) {
    const buf = archivo || excel(filas);
    const s = await servidor(rol, adminId);
    try { return await post(s, '/confirmar', { archivo: buf, campos: { temporada_id: temporada, sha256: hash === undefined ? sha256Buffer(buf) : hash, ...extra } }); } finally { s.close(); }
}

describe('confirmación válida', () => {
    test('archivo válido: revalida y llama a la RPC con datos reconstruidos por el servidor; resultado con contadores de la base', async () => {
        const r = await confirmar([F({ 'Nota Deportiva': 6, 'Nota Delegado': 6.5, 'Casos por WhatsApp': 2 }), F({ 'Nombre Jurado': 'María González', 'Nota Deportiva': 5, 'Nota Delegado': 6.5, 'Casos por WhatsApp': 2 })], { adminId: 'ADMIN-77' });
        expect(r.status).toBe(200);
        expect(mockRpcLlamadas).toHaveLength(1);
        const { nombre, args } = mockRpcLlamadas[0];
        expect(nombre).toBe('importar_rodeos_historicos');
        expect(args).toMatchObject({ p_admin_id: 'ADMIN-77', p_temporada_id: 'T1', p_fecha_desde: '2026-01-01', p_fecha_hasta: '2026-03-31', p_nombre_archivo: 'h.xlsx', p_total_filas: 2, p_filas_omitidas: 0, p_filas_con_error: 0, p_crear_evaluaciones: true });
        expect(args.p_sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(args.p_grupos).toHaveLength(1);                                  // dos jurados → UN rodeo
        expect(args.p_grupos[0]).toMatchObject({ fecha: '2026-02-15', club: 'Club X', club_norm: 'club x', asociacion_id: 'A1', tipo_rodeo_id: 'TP1', categoria_rodeo_id: 'C3', nota_delegado: 6.5, nota_comision: null, casos_whatsapp: 2 });
        expect(args.p_grupos[0].asociacion_variantes).toEqual(expect.arrayContaining(['Asociación Osorno', 'Osorno Sur']));
        expect(args.p_grupos[0].filas).toEqual([{ fila: 2, jurado: 'Juan Pérez', usuario_pagado_id: 'J1', nota_deportiva: 6 }, { fila: 3, jurado: 'María González', usuario_pagado_id: 'J2', nota_deportiva: 5 }]);
        expect(r.body).toMatchObject({ modo: 'IMPORTACION', escribe_base_de_datos: true, importacion_id: 'IMP-1', archivo: 'h.xlsx', temporada: { nombre: '2025-2026' } });
        expect(r.body.resumen).toMatchObject({ rodeos_creados: 1, asignaciones_creadas: 2, filas_excel: 2, filas_importadas: 2, filas_omitidas: 0, pagos_generados: 0 });
        expect(r.body.filas.map(f => f.estado_final)).toEqual(['IMPORTADA', 'IMPORTADA']);
        expect(r.body.filas[0].acciones).toEqual(expect.arrayContaining(['Rodeo creado', expect.stringMatching(/pago \$0/)]));
    });

    test('NO confía en lo que envíe el navegador: contadores, plan o grupos falsos en el formulario se ignoran', async () => {
        const r = await confirmar([F()], { extra: { rodeos_a_crear: 999, plan: JSON.stringify({ hay_acciones: true, rodeos_a_crear: 999 }), grupos: '[{"clave":"falsa"}]', preview: '{"resumen":{"rodeos_nuevos":999}}' } });
        expect(r.status).toBe(200);
        expect(mockRpcLlamadas[0].args.p_grupos).toHaveLength(1);
        expect(JSON.stringify(mockRpcLlamadas[0].args)).not.toMatch(/999|falsa/);
        expect(r.body.resumen.rodeos_creados).toBe(1);
    });

    test('la vista previa y la confirmación usan el mismo plan (mismo código): lo que se muestra es lo que se envía a escribir', async () => {
        const filas = [F({ 'Nota Deportiva': 6 }), F({ Fecha: '20-02-2026', 'Nombre Jurado': 'María González' })];
        const buf = excel(filas); const s = await servidor();
        let pv;
        try {
            pv = await post(s, '/preview', { archivo: buf, campos: { temporada_id: 'T1' } });
            expect(pv.body.puede_confirmar).toBe(true);
            expect(pv.body.sha256).toBe(sha256Buffer(buf));
            expect(pv.body._payload).toBeUndefined();                              // el payload interno no viaja al navegador
            await post(s, '/confirmar', { archivo: buf, campos: { temporada_id: 'T1', sha256: pv.body.sha256 } });
        } finally { s.close(); }
        expect(mockRpcLlamadas[0].args.p_grupos).toHaveLength(pv.body.plan.rodeos_a_crear);
        expect(mockRpcLlamadas[0].args.p_grupos.reduce((s2, g) => s2 + g.filas.length, 0)).toBe(pv.body.plan.asignaciones_a_crear);
    });
});

describe('hash SHA-256', () => {
    test('hash distinto (otro Excel) → rechazado con mensaje claro y SIN llamar a la RPC', async () => {
        const otro = sha256Buffer(excel([F({ Club: 'Otro' })]));
        const r = await confirmar([F()], { hash: otro });
        expect(r.status).toBe(400);
        expect(r.body.codigo).toBe('ARCHIVO_DISTINTO');
        expect(r.body.error).toBe('El archivo seleccionado no coincide con el archivo validado previamente. Vuelva a validar.');
        expect(mockRpcLlamadas).toEqual([]);
    });
    test('sin hash o con hash mal formado → 400 sin RPC', async () => {
        for (const h of ['', 'abc', 'z'.repeat(64)]) { expect((await confirmar([F()], { hash: h })).body.codigo).toBe('HASH_REQUERIDO'); }
        expect(mockRpcLlamadas).toEqual([]);
    });
    test('el hash en mayúsculas del mismo archivo es aceptado', async () => {
        const buf = excel([F()]);
        expect((await confirmar([], { archivo: buf, hash: sha256Buffer(buf).toUpperCase() })).status).toBe(200);
    });
});

describe('temporada', () => {
    test('inexistente → 400; sin temporada → 400; existente pero no habilitada (2026-2027) → 400. Nunca se crea y nunca se llama a la RPC', async () => {
        expect((await confirmar([F()], { temporada: 'NO-EXISTE' })).body.codigo).toBe('TEMPORADA_INEXISTENTE');
        expect((await confirmar([F()], { temporada: '' })).body.codigo).toBe('TEMPORADA_REQUERIDA');
        expect((await confirmar([F()], { temporada: 'T2' })).body.codigo).toBe('TEMPORADA_NO_HABILITADA');
        expect(mockRpcLlamadas).toEqual([]);
    });
    test('Temporada del Excel distinta a la seleccionada bloquea ese rodeo; fechas fuera de 01-01-2026..31-03-2026 tampoco se importan', async () => {
        const r = await confirmar([F({ Temporada: '2024-2025' }), F({ Fecha: '02-04-2026', 'Nombre Jurado': 'María González' }), F({ Fecha: '18-02-2026', 'Nombre Jurado': 'Ana Receso' })]);
        expect(r.status).toBe(200);
        expect(mockRpcLlamadas[0].args.p_grupos).toHaveLength(1);
        expect(mockRpcLlamadas[0].args.p_grupos[0].fecha).toBe('2026-02-18');
        expect(r.body.filas.map(f => f.estado_final)).toEqual(['OMITIDA', 'OMITIDA', 'IMPORTADA']);
    });
});

describe('errores parciales y bloqueos (alcance)', () => {
    test('jurado inexistente / ambiguo / de prueba: se omite SOLO esa fila; los demás jurados del mismo rodeo se importan', async () => {
        const r = await confirmar([F(), F({ 'Nombre Jurado': 'No Existe Zzz' }), F({ 'Nombre Jurado': 'Homónimo Uno' }), F({ 'Nombre Jurado': 'Usuario Prueba' }), F({ 'Nombre Jurado': 'María González' })]);
        expect(r.status).toBe(200);
        expect(mockRpcLlamadas[0].args.p_grupos[0].filas.map(f => f.usuario_pagado_id)).toEqual(['J1', 'J2']);
        expect(mockRpcLlamadas[0].args).toMatchObject({ p_filas_omitidas: 3, p_filas_con_error: 3, p_total_filas: 5 });
        expect(r.body.filas.map(f => f.estado_final)).toEqual(['IMPORTADA', 'OMITIDA', 'OMITIDA', 'OMITIDA', 'IMPORTADA']);
        expect(r.body.filas[1].errores.join()).toMatch(/JURADO NO ENCONTRADO/);
    });
    test('jurado inactivo y en receso SÍ se importan (hechos históricos)', async () => {
        await confirmar([F({ 'Nombre Jurado': 'Pedro Inactivo' }), F({ 'Nombre Jurado': 'Ana Receso' })]);
        expect(mockRpcLlamadas[0].args.p_grupos[0].filas.map(f => f.usuario_pagado_id)).toEqual(['J3', 'J4']);
    });
    test('problema estructural compartido bloquea TODO el grupo: conflicto de Nota Delegado / Comisión / Casos entre filas del mismo rodeo', async () => {
        for (const [col, a, b] of [['Nota Delegado', 6, 5], ['Nota Comisión', 6, 5], ['Casos por WhatsApp', 1, 2]]) {
            mockRpcLlamadas.length = 0;
            const r = await confirmar([F({ [col]: a }), F({ 'Nombre Jurado': 'María González', [col]: b }), F({ Fecha: '20-02-2026', 'Nombre Jurado': 'Ana Receso' })]);
            expect(mockRpcLlamadas[0].args.p_grupos).toHaveLength(1);              // el otro rodeo sí
            expect(mockRpcLlamadas[0].args.p_grupos[0].fecha).toBe('2026-02-20');
            expect(r.body.filas.map(f => f.estado_final)).toEqual(['OMITIDA', 'OMITIDA', 'IMPORTADA']);
        }
    });
    test('asociación no encontrada / ambigua, tipo no encontrado, categoría inválida y notas inválidas del rodeo bloquean ese rodeo', async () => {
        const r = await confirmar([
            F({ 'Asociación': 'Marte' }), F({ 'Tipo Rodeo': 'Inexistente', 'Nombre Jurado': 'María González' }),
            F({ 'Categoría del Rodeo': 'Quinta', 'Nombre Jurado': 'Ana Receso' }), F({ 'Nota Delegado': 9, 'Nombre Jurado': 'Pedro Inactivo' }),
            F({ Fecha: '21-02-2026' })
        ]);
        expect(mockRpcLlamadas[0].args.p_grupos).toHaveLength(1);
        expect(r.body.resumen.filas_omitidas).toBe(4);
    });
    test('Nota Deportiva inválida bloquea solo esa fila (no el rodeo)', async () => {
        const r = await confirmar([F({ 'Nota Deportiva': 9 }), F({ 'Nombre Jurado': 'María González', 'Nota Deportiva': 5 })]);
        expect(mockRpcLlamadas[0].args.p_grupos[0].filas.map(f => f.usuario_pagado_id)).toEqual(['J2']);
        expect(r.body.filas.map(f => f.estado_final)).toEqual(['OMITIDA', 'IMPORTADA']);
    });
    test('duplicado exacto en el archivo (mismo rodeo + mismo jurado) no se importa; los otros jurados sí', async () => {
        const r = await confirmar([F(), F(), F({ 'Nombre Jurado': 'María González' })]);
        expect(mockRpcLlamadas[0].args.p_grupos[0].filas.map(f => f.usuario_pagado_id)).toEqual(['J2']);
        expect(r.body.filas.map(f => f.estado_final)).toEqual(['OMITIDA', 'OMITIDA', 'IMPORTADA']);
    });
    test('rodeo sin ningún jurado válido no se envía a escribir', async () => {
        const r = await confirmar([F({ 'Nombre Jurado': 'No Existe' }), F({ Fecha: '18-02-2026' })]);
        expect(mockRpcLlamadas[0].args.p_grupos).toHaveLength(1);
        expect(r.body.resumen.filas_omitidas).toBe(1);
    });
    test('todo con errores → 400 SIN_ACCIONES y no escribe', async () => {
        const r = await confirmar([F({ 'Nombre Jurado': 'No Existe' })]);
        expect(r.status).toBe(400); expect(r.body.codigo).toBe('SIN_ACCIONES');
        expect(mockRpcLlamadas).toEqual([]);
    });
    test('conflictos contra la BD NO bloquean: el rodeo existente con Nota Delegado distinta se envía (la RPC conserva el valor y lo informa)', async () => {
        mockTablas.rodeos = [{ id: 'R1', club: 'club x', asociacion: 'Asociación Osorno', fecha: '2026-02-15', tipo_rodeo_id: 'TP1', estado: 'activo' }];
        mockTablas.rodeo_notas_secundarias = [{ rodeo_id: 'R1', nota_delegado: 6.0, nota_comision: null }];
        await confirmar([F({ 'Nota Delegado': 6.5 })]);
        expect(mockRpcLlamadas).toHaveLength(1);
        expect(mockRpcLlamadas[0].args.p_grupos[0].nota_delegado).toBe(6.5);
    });
    test('todo ya registrado (rodeo, asignación y notas iguales) → SIN_ACCIONES (idempotente, no escribe)', async () => {
        mockTablas.rodeos = [{ id: 'R1', club: 'Club X', asociacion: 'Asociación Osorno', fecha: '2026-02-15', tipo_rodeo_id: 'TP1', estado: 'activo' }];
        mockTablas.asignaciones = [{ id: 'AS1', rodeo_id: 'R1', usuario_pagado_id: 'J1', tipo_persona: 'jurado', estado: 'activo' }];
        mockTablas.notas_rodeo = [{ asignacion_id: 'AS1', nota: 6 }];
        mockTablas.rodeo_notas_secundarias = [{ rodeo_id: 'R1', nota_delegado: 6.5, nota_comision: null }];
        mockTablas.evaluaciones = [{ id: 'E1', rodeo_id: 'R1', estado: 'cerrado', casos_whatsapp: 2, anulada: false }];
        const r = await confirmar([F({ 'Nota Deportiva': 6, 'Nota Delegado': 6.5, 'Casos por WhatsApp': 2 })]);
        expect(r.body.codigo).toBe('SIN_ACCIONES');
        expect(mockRpcLlamadas).toEqual([]);
    });
});

describe('errores del archivo y de la RPC', () => {
    test('archivo corrupto / hoja incorrecta → 400 y no escribe', async () => {
        const basura = Buffer.from([0, 1, 2, 3, 4, 5, 250, 251]);
        expect((await confirmar([], { archivo: basura })).status).toBe(400);
        expect((await confirmar([], { archivo: excel([F()], 'Otra') })).body.codigo).toBe('HOJA_NO_ENCONTRADA');
        expect(mockRpcLlamadas).toEqual([]);
    });
    test('sin archivo → 400', async () => {
        const s = await servidor();
        try { const r = await post(s, '/confirmar', { campos: { temporada_id: 'T1', sha256: 'a'.repeat(64) } }); expect(r.status).toBe(400); expect(r.body.codigo).toBe('SIN_ARCHIVO'); } finally { s.close(); }
    });
    test('error inesperado dentro de la RPC → 500 "revertida por completo" (la base no quedó a medias)', async () => {
        mockRpcImpl = async () => ({ data: null, error: { message: 'null value in column "club" violates not-null constraint' } });
        const r = await confirmar([F()]);
        expect(r.status).toBe(500);
        expect(r.body.codigo).toBe('IMPORTACION_REVERTIDA');
        expect(r.body.error).toMatch(/revertida por completo: no se guardó ningún dato/);
    });
    test('la RPC rechaza al usuario (HIST_SIN_PERMISO) → 403; temporada inexistente en la RPC → 400', async () => {
        mockRpcImpl = async () => ({ data: null, error: { message: 'HIST_SIN_PERMISO' } });
        expect((await confirmar([F()])).status).toBe(403);
        mockRpcImpl = async () => ({ data: null, error: { message: 'HIST_TEMPORADA_INEXISTENTE' } });
        expect((await confirmar([F()])).status).toBe(400);
    });
});

describe('permisos', () => {
    test.each([['analista'], ['jefe_area'], ['monitor'], ['comision_tecnica'], ['director'], ['capacitador']])('rol %s → 403 y NO llama a la RPC', async (rol) => {
        const r = await confirmar([F()], { rol });
        expect(r.status).toBe(403);
        expect(mockRpcLlamadas).toEqual([]);
    });
    test('el middleware global de /admin bloquea además las mutaciones del director y exige soloAdmin (sin cambios)', () => {
        const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        expect(index).toMatch(/rol_evaluacion === 'director' && req\.method !== 'GET'/);
        expect(index.indexOf('router.use(soloAdmin)')).toBeLessThan(index.indexOf("'/importacion/historicos'"));
    });
});

describe('no se toca nada más', () => {
    const raiz = path.join(__dirname, '..', '..');
    const leer = (f) => fs.readFileSync(path.join(raiz, f), 'utf8');
    test('la escritura solo ocurre por la RPC: el servicio de escritura no usa insert/update/delete directos', () => {
        const src = leer('services/importacionHistoricaEscritura.js');
        expect(src).toMatch(/db\.rpc\('importar_rodeos_historicos'/);
        expect(src).not.toMatch(/\.(insert|update|upsert|delete)\(/);
        expect(src).not.toMatch(/publicar_evaluacion|evaluacion_ciclos|auditoria\.registrar/);
    });
    test('importación normal, rodeos, designaciones, propuesta, pagos, cálculo, publicación y Control de Gestión no referencian la importación histórica', () => {
        for (const f of ['routes/admin/importacion.js', 'services/importacion.js', 'routes/admin/rodeos.js', 'routes/admin/asignaciones.js', 'routes/admin/propuesta-designacion.js', 'services/calculo.js', 'services/publicacion.js', 'services/motorPropuestaDesignacion.js', 'routes/admin/evaluaciones.js', 'routes/admin/reportes.js']) {
            expect(leer(f)).not.toMatch(/importacionHistorica|importar_rodeos_historicos/);
        }
        const cg = fs.readdirSync(path.join(raiz, 'services')).filter(n => /controlGestion/i.test(n) && !n.endsWith('.test.js'));
        for (const n of cg) expect(leer('services/' + n)).not.toMatch(/importacionHistorica|importar_rodeos_historicos/);
    });
    test('la RPC no está expuesta a otros roles: solo el servidor (service_role) puede ejecutarla', () => {
        const sql = fs.readFileSync(path.join(raiz, '..', '..', 'database', 'migrations', '060_importacion_historica_rodeos.sql'), 'utf8');
        expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION importar_rodeos_historicos\([^)]*\) TO service_role;/);
        expect(sql).toMatch(/REVOKE ALL ON FUNCTION importar_rodeos_historicos\([^)]*\) FROM PUBLIC;/);
    });
});
