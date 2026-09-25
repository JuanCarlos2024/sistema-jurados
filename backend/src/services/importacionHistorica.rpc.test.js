// Función SQL importar_rodeos_historicos (migración 060) ejecutada sobre un Postgres REAL de prueba (PGlite, en memoria).
// Réplica de las tablas/constraints reales en __fixtures__/esquemaImportacionHistorica.sql. NO toca producción.
const fs = require('fs');
const path = require('path');
jest.setTimeout(120000);      // el Postgres de prueba tarda en arrancar cuando Jest corre muchas suites en paralelo
const { crearDb } = require('./__fixtures__/pgliteCliente');
const { normalizar } = require('./importacion');

const MIGRACION = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'database', 'migrations', '060_importacion_historica_rodeos.sql'), 'utf8');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaImportacionHistorica.sql'), 'utf8');

let db;
const ID = {};   // ids de maestros
const DESDE = '2026-01-01', HASTA = '2026-03-31';

beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);
    await db.exec(MIGRACION);
    const q = async (sql, p) => (await db.query(sql, p)).rows;
    ID.admin = (await q("insert into administradores (nombre_completo) values ('Admin Pleno') returning id"))[0].id;
    ID.adminEval = (await q("insert into administradores (nombre_completo, rol_evaluacion) values ('Analista','analista') returning id"))[0].id;
    ID.adminInactivo = (await q("insert into administradores (nombre_completo, activo) values ('Inactivo', false) returning id"))[0].id;
    ID.temp = (await q("insert into temporadas (nombre, fecha_inicio, fecha_fin) values ('2025-2026','2025-04-01','2026-03-31') returning id"))[0].id;
    ID.asoc = (await q("insert into asociaciones (nombre) values ('Asociación Osorno') returning id"))[0].id;
    ID.cat = (await q("insert into categorias_rodeo (nombre) values ('Tercera') returning id"))[0].id;
    ID.tipo = (await q("insert into tipos_rodeo (nombre, duracion_dias, categoria_rodeo_id) values ('Rodeo Libre', 2, $1) returning id", [ID.cat]))[0].id;
    const j = async (n, cat, extra = '') => (await q(`insert into usuarios_pagados (tipo_persona, nombre_completo, categoria, estado_usuario ${extra ? ', es_prueba' : ''}) values ('jurado', $1, $2, 'activo' ${extra ? ', true' : ''}) returning id`, [n, cat]))[0].id;
    ID.j1 = await j('Juan Pérez', 'A');
    ID.j2 = await j('María González', 'B');
    ID.j3 = await j('Pedro Inactivo', 'C');
    ID.j4 = await j('Ana Receso', null);
    ID.jPrueba = await j('Usuario Prueba', 'A', 'x');
    ID.delegado = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('delegado_rentado','Un Delegado') returning id"))[0].id;
});
afterAll(async () => { await db.close(); });

beforeEach(async () => {
    await db.exec('TRUNCATE evaluacion_ciclos, evaluacion_casos, evaluacion_auditoria, evaluaciones, notas_rodeo, rodeo_notas_secundarias, asignaciones, rodeos, importaciones, auditoria CASCADE');
});

// ── helpers ──────────────────────────────────────────────────────────────
const cnt = async (t) => Number((await db.query(`select count(*) c from ${t}`)).rows[0].c);
async function conteos() { const o = {}; for (const t of ['rodeos', 'asignaciones', 'notas_rodeo', 'rodeo_notas_secundarias', 'evaluaciones', 'evaluacion_ciclos', 'evaluacion_casos', 'evaluacion_auditoria', 'importaciones', 'auditoria', 'bonos', 'control_gestion_situaciones']) o[t] = await cnt(t); return o; }
const fila = (n, usuario, extra = {}) => ({ fila: n, jurado: 'x', usuario_pagado_id: usuario, nota_deportiva: null, ...extra });
const grupo = (o = {}) => ({
    clave: '2026-02-15|club rio bueno|A|T', fecha: '2026-02-15', club: 'Club Río Bueno', club_norm: 'club rio bueno',
    asociacion_id: ID.asoc, asociacion_variantes: ['Osorno'], tipo_rodeo_id: ID.tipo, categoria_rodeo_id: ID.cat,
    nota_delegado: null, nota_comision: null, casos_whatsapp: 0, filas: [fila(2, ID.j1)], ...o
});
async function importar(grupos, { admin = ID.admin, temporada = ID.temp, crear = true, omitidas = 0, conError = 0, archivo = 'h.xlsx' } = {}) {
    const r = await db.query('select importar_rodeos_historicos($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12) as r',
        [admin, temporada, DESDE, HASTA, archivo, 'a'.repeat(64), 10, JSON.stringify(grupos), omitidas, conError, crear, '10.0.0.1']);
    return r.rows[0].r;
}
const asig = async () => (await db.query('select * from asignaciones order by created_at, id')).rows;
const rodeoExistente = async (o = {}) => (await db.query(
    "insert into rodeos (club, asociacion, fecha, tipo_rodeo_id, tipo_rodeo_nombre, duracion_dias, origen, estado) values ($1,$2,$3,$4,'Rodeo Libre',2,'manual',$5) returning id",
    [o.club || 'CLUB  RÍO  Bueno', o.asociacion || 'Asociación Osorno', o.fecha || '2026-02-15', ID.tipo, o.estado || 'activo'])).rows[0].id;

// ── creación y reglas de la asignación histórica ────────────────────────
describe('rodeo nuevo y asignación histórica', () => {
    test('un rodeo con dos jurados crea UN rodeo y DOS asignaciones (activo/aceptado/no publicado/pago 0)', async () => {
        const r = await importar([grupo({ filas: [fila(2, ID.j1), fila(3, ID.j2)] })]);
        expect(r.resumen).toMatchObject({ rodeos_creados: 1, asignaciones_creadas: 2, rodeos_reutilizados: 0, pagos_generados: 0 });
        expect(await cnt('rodeos')).toBe(1);
        const a = await asig();
        expect(a).toHaveLength(2);
        for (const x of a) expect(x).toMatchObject({ estado: 'activo', estado_designacion: 'aceptado', publicado: false, pago_base_calculado: 0, valor_diario_aplicado: 0, duracion_dias_aplicada: 2, tipo_persona: 'jurado', publicado_en: null });
        expect(a.map(x => x.categoria_aplicada).sort()).toEqual(['A', 'B']);      // categoría ACTUAL del jurado
        const imp = (await db.query('select id from importaciones')).rows[0].id;
        for (const x of a) expect(x.importacion_id).toBe(imp);                    // trazabilidad: la asignación apunta a su importación
    });
    test('valores del rodeo creado (estructura real)', async () => {
        await importar([grupo()]);
        const r = (await db.query('select * from rodeos')).rows[0];
        expect(r).toMatchObject({ club: 'Club Río Bueno', asociacion: 'Asociación Osorno', tipo_rodeo_id: ID.tipo, tipo_rodeo_nombre: 'Rodeo Libre', duracion_dias: 2, origen: 'importado', estado: 'activo', temporada_id: ID.temp, categoria_rodeo_id: ID.cat, categoria_rodeo_nombre: 'Tercera', created_by: ID.admin, es_prueba: false });
        expect(String(r.fecha).slice(0, 10)).toBe('2026-02-15');
        expect(r.importacion_id).not.toBeNull();
    });
    test('jurado sin categoría actual queda con categoria_aplicada NULL; el estado del jurado no se modifica', async () => {
        await db.exec("update usuarios_pagados set estado_usuario='inactivo', activo=false where nombre_completo='Pedro Inactivo'");
        await importar([grupo({ filas: [fila(2, ID.j4), fila(3, ID.j3)] })]);
        expect((await asig()).map(a => a.categoria_aplicada).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(['C', null]);
        expect((await db.query("select estado_usuario, activo from usuarios_pagados where nombre_completo='Pedro Inactivo'")).rows[0]).toEqual({ estado_usuario: 'inactivo', activo: false });
    });
    test('jurado es_prueba o no-jurado → solo esa fila se omite; los demás se importan', async () => {
        const r = await importar([grupo({ filas: [fila(2, ID.j1), fila(3, ID.jPrueba), fila(4, ID.delegado)] })]);
        expect(r.resumen).toMatchObject({ asignaciones_creadas: 1, filas_omitidas_en_base: 2 });
        expect(r.filas.filter(f => f.errores.length).map(f => f.fila)).toEqual([3, 4]);
        expect(await cnt('asignaciones')).toBe(1);
    });
    test('rodeo sin ningún jurado válido → no se crea el rodeo', async () => {
        const r = await importar([grupo({ filas: [fila(2, ID.jPrueba)] })]);
        expect(r.resumen).toMatchObject({ rodeos_creados: 0, rodeos_omitidos: 1 });
        expect(await cnt('rodeos')).toBe(0);
        expect(r.grupos[0].errores[0]).toMatch(/NINGÚN JURADO VÁLIDO/);
    });
});

// ── reutilización, ambigüedad, idempotencia ─────────────────────────────
describe('rodeo existente / idempotencia', () => {
    test('rodeo existente (club con otra escritura, misma llave) se reutiliza sin duplicar', async () => {
        const id = await rodeoExistente();
        const r = await importar([grupo()]);
        expect(r.resumen).toMatchObject({ rodeos_creados: 0, rodeos_reutilizados: 1, asignaciones_creadas: 1 });
        expect(await cnt('rodeos')).toBe(1);
        expect(r.grupos[0].rodeo_id).toBe(id);
    });
    test('rodeo anulado no cuenta: se crea uno nuevo', async () => {
        await rodeoExistente({ estado: 'anulado' });
        expect((await importar([grupo()])).resumen.rodeos_creados).toBe(1);
        expect(await cnt('rodeos')).toBe(2);
    });
    test('otra fecha / otro tipo / otra asociación = otro rodeo', async () => {
        await rodeoExistente({ fecha: '2026-02-16' });
        expect((await importar([grupo()])).resumen.rodeos_creados).toBe(1);
    });
    test('2 rodeos existentes coinciden → AMBIGUO: no se elige ni se escribe nada en ese grupo', async () => {
        await rodeoExistente(); await rodeoExistente({ club: 'club rio bueno' });
        const r = await importar([grupo({ nota_delegado: 6 })]);
        expect(r.resumen).toMatchObject({ rodeos_omitidos: 1, rodeos_creados: 0, asignaciones_creadas: 0 });
        expect(r.grupos[0].errores[0]).toMatch(/RODEO AMBIGUO/);
        expect(await cnt('asignaciones')).toBe(0); expect(await cnt('rodeo_notas_secundarias')).toBe(0);
    });
    test('REIMPORTAR el mismo archivo no duplica rodeos, asignaciones, notas ni evaluaciones', async () => {
        const g = () => [grupo({ nota_delegado: 6, nota_comision: 5.5, casos_whatsapp: 3, filas: [fila(2, ID.j1, { nota_deportiva: 6.5 }), fila(3, ID.j2, { nota_deportiva: 5 })] }),
            grupo({ clave: '2026-02-20|otro|A|T', fecha: '2026-02-20', club: 'Otro Club', club_norm: 'otro club', filas: [fila(4, ID.j3)] })];
        const r1 = await importar(g());
        const c1 = await conteos();
        expect(r1.resumen).toMatchObject({ rodeos_creados: 2, asignaciones_creadas: 3, notas_delegado_cargadas: 1, notas_comision_cargadas: 1, notas_deportivas_cargadas: 2, evaluaciones_historicas_creadas: 1, casos_whatsapp_cargados: 1 });
        const r2 = await importar(g());
        const c2 = await conteos();
        expect({ ...c2, importaciones: 0, auditoria: 0 }).toEqual({ ...c1, importaciones: 0, auditoria: 0 });
        expect(r2.resumen).toMatchObject({ rodeos_creados: 0, rodeos_reutilizados: 2, asignaciones_creadas: 0, asignaciones_existentes: 3, notas_delegado_cargadas: 0, notas_delegado_iguales: 1, notas_comision_iguales: 1, notas_deportivas_cargadas: 0, notas_deportivas_iguales: 2, evaluaciones_historicas_creadas: 0, casos_whatsapp_iguales: 1, conflictos_total: 0 });
        expect(c2.importaciones).toBe(2); expect(c2.auditoria).toBe(2);       // cada ejecución deja su registro
    });
    test('asignación existente (no anulada) NO se duplica ni se modifica; anulada sí permite crear una nueva', async () => {
        const rid = await rodeoExistente();
        await db.query("insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, valor_diario_aplicado, duracion_dias_aplicada, pago_base_calculado, estado_designacion, publicado) values ($1,$2,'jurado',50000,2,100000,'pendiente',true)", [rid, ID.j1]);
        await db.query("insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, valor_diario_aplicado, duracion_dias_aplicada, pago_base_calculado, estado) values ($1,$2,'jurado',1,1,1,'anulado')", [rid, ID.j2]);
        const r = await importar([grupo({ filas: [fila(2, ID.j1), fila(3, ID.j2)] })]);
        expect(r.resumen).toMatchObject({ asignaciones_creadas: 1, asignaciones_existentes: 1 });
        const existente = (await asig()).find(a => a.usuario_pagado_id === ID.j1);
        expect(existente).toMatchObject({ estado_designacion: 'pendiente', publicado: true, pago_base_calculado: 100000 });     // intacta
    });
    test('duplicado legado (2 asignaciones del mismo jurado) no genera una tercera', async () => {
        const rid = await rodeoExistente();
        for (let i = 0; i < 2; i++) await db.query("insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, valor_diario_aplicado, duracion_dias_aplicada, pago_base_calculado) values ($1,$2,'jurado',1,1,1)", [rid, ID.j1]);
        await importar([grupo()]);
        expect(await cnt('asignaciones')).toBe(2);
    });
});

// ── notas ────────────────────────────────────────────────────────────────
describe('Nota Delegado / Comisión (rodeo_notas_secundarias)', () => {
    const sec = async () => (await db.query('select nota_delegado, nota_comision from rodeo_notas_secundarias')).rows;
    test('nuevas: se crea la fila con ambas', async () => {
        const r = await importar([grupo({ nota_delegado: 6.5, nota_comision: 5 })]);
        expect(r.resumen).toMatchObject({ notas_delegado_cargadas: 1, notas_comision_cargadas: 1 });
        expect((await sec())[0]).toEqual({ nota_delegado: '6.5', nota_comision: '5' });
    });
    test('sin notas en el Excel: no se crea fila', async () => {
        await importar([grupo()]);
        expect(await cnt('rodeo_notas_secundarias')).toBe(0);
    });
    test('existente NULL se completa; igual = sin cambios; distinta = CONFLICTO sin sobrescribir', async () => {
        const rid = await rodeoExistente();
        await db.query('insert into rodeo_notas_secundarias (rodeo_id, nota_delegado, nota_comision) values ($1, 6.0, NULL)', [rid]);
        let r = await importar([grupo({ nota_delegado: 6, nota_comision: 5 })]);
        expect(r.resumen).toMatchObject({ notas_delegado_iguales: 1, notas_comision_cargadas: 1, conflictos_total: 0 });
        expect((await sec())[0]).toEqual({ nota_delegado: '6.0', nota_comision: '5' });
        r = await importar([grupo({ nota_delegado: 6.5, nota_comision: 4.5 })]);
        expect(r.resumen).toMatchObject({ conflictos_nota_delegado: 1, conflictos_nota_comision: 1, notas_delegado_cargadas: 0 });
        expect((await sec())[0]).toEqual({ nota_delegado: '6.0', nota_comision: '5' });          // intactas
        expect(r.grupos[0].conflictos.join()).toMatch(/CONFLICTO NOTA DELEGADO.*existente 6\.0 \/ Excel 6\.5/);
    });
    test('conflicto NO bloquea: la asignación y la Nota Deportiva del jurado sí se cargan', async () => {
        const rid = await rodeoExistente();
        await db.query('insert into rodeo_notas_secundarias (rodeo_id, nota_delegado) values ($1, 6.0)', [rid]);
        const r = await importar([grupo({ nota_delegado: 6.5, filas: [fila(2, ID.j1, { nota_deportiva: 6 })] })]);
        expect(r.resumen).toMatchObject({ conflictos_nota_delegado: 1, asignaciones_creadas: 1, notas_deportivas_cargadas: 1 });
    });
});

describe('Nota Deportiva (notas_rodeo, por asignación)', () => {
    const notas = async () => (await db.query('select * from notas_rodeo')).rows;
    test('nueva: notas_rodeo con fuente manual; NO crea ciclos, casos, evaluaciones ni nota_final', async () => {
        const antes = await conteos();
        const r = await importar([grupo({ filas: [fila(2, ID.j1, { nota_deportiva: 6.4 })] })]);
        expect(r.resumen.notas_deportivas_cargadas).toBe(1);
        const n = (await notas())[0];
        expect(n).toMatchObject({ nota: '6.4', fuente: 'manual', evaluacion_id: null, updated_by: ID.admin });
        const c = await conteos();
        expect(c.evaluacion_ciclos).toBe(0); expect(c.evaluacion_casos).toBe(0); expect(c.evaluacion_auditoria).toBe(0); expect(c.evaluaciones).toBe(antes.evaluaciones);
    });
    test('igual → sin cambios; distinta → CONFLICTO sin sobrescribir', async () => {
        await importar([grupo({ filas: [fila(2, ID.j1, { nota_deportiva: 6 })] })]);
        let r = await importar([grupo({ filas: [fila(2, ID.j1, { nota_deportiva: 6.0 })] })]);
        expect(r.resumen).toMatchObject({ notas_deportivas_iguales: 1, conflictos_nota_deportiva: 0 });
        r = await importar([grupo({ filas: [fila(2, ID.j1, { nota_deportiva: 4 })] })]);
        expect(r.resumen).toMatchObject({ conflictos_nota_deportiva: 1, notas_deportivas_cargadas: 0 });
        expect(Number((await notas())[0].nota)).toBe(6);
        expect(await cnt('notas_rodeo')).toBe(1);
    });
    test('nota fuera de rango 1–7 → error fatal y rollback total', async () => {
        const antes = await conteos();
        await expect(importar([grupo({ filas: [fila(2, ID.j1, { nota_deportiva: 7.5 })] })])).rejects.toThrow(/HIST_DATOS_FUERA_DE_RANGO/);
        expect(await conteos()).toEqual(antes);
    });
});

// ── Casos por WhatsApp / evaluación histórica mínima ────────────────────
describe('Casos por WhatsApp', () => {
    const evs = async () => (await db.query('select * from evaluaciones')).rows;
    test('Excel 0 y sin evaluación → NO se crea evaluación', async () => {
        const r = await importar([grupo({ casos_whatsapp: 0 })]);
        expect(await cnt('evaluaciones')).toBe(0);
        expect(r.resumen).toMatchObject({ evaluaciones_historicas_creadas: 0, casos_whatsapp_cargados: 0, conflictos_casos_whatsapp: 0 });
    });
    test('Excel > 0 y sin evaluación → evaluación histórica MÍNIMA (cerrado, sin ciclos/casos/notas/auditoría de evaluación)', async () => {
        const r = await importar([grupo({ casos_whatsapp: 4, filas: [fila(2, ID.j1, { nota_deportiva: 6 })] })]);
        expect(r.resumen).toMatchObject({ evaluaciones_historicas_creadas: 1, casos_whatsapp_cargados: 1 });
        const e = (await evs())[0];
        expect(e).toMatchObject({ estado: 'cerrado', es_historica_importacion: true, casos_whatsapp: 4, nota_final: null, puntaje_final: null, nota_publicada: false, anulada: false, resultados_alterados: false, creado_por: ID.admin, puntaje_base: 80, modo_flujo: 'descuento_automatico' });
        expect(await cnt('evaluacion_ciclos')).toBe(0); expect(await cnt('evaluacion_casos')).toBe(0); expect(await cnt('evaluacion_auditoria')).toBe(0);
        expect((await db.query('select nota, evaluacion_id from notas_rodeo')).rows).toEqual([{ nota: '6', evaluacion_id: null }]);   // notas_rodeo solo la nota individual
    });
    test('evaluación existente: igual = sin cambios; distinta = CONFLICTO (incluido existente 0 vs Excel 4)', async () => {
        const rid = await rodeoExistente();
        await db.query("insert into evaluaciones (rodeo_id, creado_por, estado, casos_whatsapp) values ($1,$2,'en_proceso',2)", [rid, ID.admin]);
        let r = await importar([grupo({ casos_whatsapp: 2 })]);
        expect(r.resumen).toMatchObject({ casos_whatsapp_iguales: 1, conflictos_casos_whatsapp: 0 });
        r = await importar([grupo({ casos_whatsapp: 5 })]);
        expect(r.resumen).toMatchObject({ conflictos_casos_whatsapp: 1, casos_whatsapp_cargados: 0 });
        await db.exec('update evaluaciones set casos_whatsapp = 0');
        r = await importar([grupo({ casos_whatsapp: 4 })]);
        expect(r.resumen.conflictos_casos_whatsapp).toBe(1);
        expect((await evs())[0]).toMatchObject({ casos_whatsapp: 0, estado: 'en_proceso' });      // no se sobrescribe ni cambia estado
    });
    test('creación de evaluaciones deshabilitada (p_crear_evaluaciones=false): no se crea y se informa', async () => {
        const r = await importar([grupo({ casos_whatsapp: 4 })], { crear: false });
        expect(await cnt('evaluaciones')).toBe(0);
        expect(r.resumen).toMatchObject({ casos_whatsapp_no_cargados: 1, evaluaciones_historicas_creadas: 0 });
        expect(await cnt('asignaciones')).toBe(1);                                                // el resto sí se importa
    });
    test('publicar_evaluacion / triggers: el esquema real no tiene triggers y la función no los invoca', () => {
        const cuerpoImportar = MIGRACION.slice(MIGRACION.indexOf('CREATE OR REPLACE FUNCTION importar_rodeos_historicos'), MIGRACION.indexOf('CREATE OR REPLACE FUNCTION convertir_evaluacion_historica'));
        expect(cuerpoImportar.length).toBeGreaterThan(1000);
        expect(cuerpoImportar).not.toMatch(/INSERT INTO evaluacion_|publicar_evaluacion\(|PERFORM publicar/);
        expect(MIGRACION).not.toMatch(/CREATE TRIGGER/);
    });
});

// ── validaciones fatales y por grupo ────────────────────────────────────
describe('permisos y validaciones', () => {
    test('administrador con rol de evaluación / inexistente / inactivo → HIST_SIN_PERMISO y no escribe', async () => {
        const antes = await conteos();
        for (const a of [ID.adminEval, ID.adminInactivo, '00000000-0000-0000-0000-000000000000']) await expect(importar([grupo()], { admin: a })).rejects.toThrow(/HIST_SIN_PERMISO/);
        expect(await conteos()).toEqual(antes);
    });
    test('temporada inexistente / argumentos inválidos / sin grupos → error y no escribe', async () => {
        const antes = await conteos();
        await expect(importar([grupo()], { temporada: '00000000-0000-0000-0000-000000000000' })).rejects.toThrow(/HIST_TEMPORADA_INEXISTENTE/);
        await expect(importar([])).rejects.toThrow(/HIST_SIN_GRUPOS/);
        await expect(importar([grupo()], { archivo: null })).rejects.toThrow(/HIST_ARGUMENTOS_INVALIDOS/);
        expect(await conteos()).toEqual(antes);
    });
    test('fecha fuera del período / tipo o asociación inexistentes → el grupo se omite, los demás siguen', async () => {
        const r = await importar([
            grupo({ clave: 'a', fecha: '2026-04-05' }),
            grupo({ clave: 'b', tipo_rodeo_id: '00000000-0000-0000-0000-000000000000' }),
            grupo({ clave: 'c', asociacion_id: '00000000-0000-0000-0000-000000000000' }),
            grupo({ clave: 'd', fecha: '2026-02-18' })
        ]);
        expect(r.resumen).toMatchObject({ rodeos_omitidos: 3, rodeos_creados: 1 });
        expect(await cnt('rodeos')).toBe(1);
    });
    test('los datos maestros se releen de la base (la duración enviada por el llamador no existe/influye)', async () => {
        await importar([grupo({ duracion_dias: 5 })]);
        expect((await db.query('select duracion_dias from rodeos')).rows[0].duracion_dias).toBe(2);
    });
    test('seguridad: SECURITY DEFINER con search_path fijo; EXECUTE solo service_role', async () => {
        const p = (await db.query("select prosecdef, proconfig from pg_proc where proname='importar_rodeos_historicos'")).rows[0];
        expect(p.prosecdef).toBe(true);
        expect(p.proconfig).toContain('search_path=public, pg_temp');
        const priv = async (rol) => (await db.query(`select has_function_privilege('${rol}', 'importar_rodeos_historicos(uuid,uuid,date,date,text,text,integer,jsonb,integer,integer,boolean,text)', 'EXECUTE') ok`)).rows[0].ok;
        expect(await priv('service_role')).toBe(true);
        expect(await priv('anon')).toBe(false); expect(await priv('authenticated')).toBe(false);
    });
});

// ── atomicidad ──────────────────────────────────────────────────────────
describe('ROLLBACK real ante error inesperado', () => {
    test('un error DESPUÉS de haber escrito (grupo 1 completo, grupo 2 revienta) deja la base exactamente igual', async () => {
        await rodeoExistente({ fecha: '2026-03-01', club: 'Preexistente' });
        await db.query("insert into rodeo_notas_secundarias (rodeo_id, nota_delegado) select id, 6 from rodeos");
        const antes = await conteos();
        const grupos = [
            grupo({ clave: '1-ok', nota_delegado: 6, nota_comision: 5, casos_whatsapp: 3, filas: [fila(2, ID.j1, { nota_deportiva: 6 }), fila(3, ID.j2, { nota_deportiva: 5 })] }),
            grupo({ clave: '2-revienta', fecha: '2026-02-20', club_norm: 'otro', nota_comision: 9 })            // fuera de rango → RAISE
        ];
        await expect(importar(grupos)).rejects.toThrow(/HIST_DATOS_FUERA_DE_RANGO/);
        expect(await conteos()).toEqual(antes);                                           // 0 rodeos, asignaciones, notas, evaluaciones, importaciones, auditoría nuevos
        expect((await db.query('select count(*) c from rodeos where origen = \'importado\'')).rows[0].c).toBe(0);
    });
    test('violación real de una restricción de la base (NOT NULL) en el 2º grupo también revierte lo escrito por el 1º', async () => {
        const antes = await conteos();
        const malo = grupo({ clave: '2-sin-club', fecha: '2026-02-20', club_norm: 'x' }); delete malo.club;
        await expect(importar([grupo({ clave: '1-ok', nota_delegado: 6, casos_whatsapp: 2 }), malo])).rejects.toThrow(/null value in column "club"/);
        expect(await conteos()).toEqual(antes);
    });
    test('categoría actual del jurado fuera de A/B/C/DR se guarda como NULL (no rompe el CHECK ni la importación)', async () => {
        await db.exec("update usuarios_pagados set categoria='ZZ' where nombre_completo='Juan Pérez'");
        try {
            const r = await importar([grupo()]);
            expect(r.resumen.asignaciones_creadas).toBe(1);
            expect((await asig())[0].categoria_aplicada).toBeNull();
        } finally { await db.exec("update usuarios_pagados set categoria='A' where nombre_completo='Juan Pérez'"); }
    });
});

// ── registro, auditoría y efectos sobre otros módulos ───────────────────
describe('importaciones, auditoría y ausencia de efectos colaterales', () => {
    test('importaciones registra la operación (tipo historico_rodeos) y auditoria al administrador', async () => {
        const r = await importar([grupo({ filas: [fila(2, ID.j1), fila(3, ID.j2)] })], { omitidas: 2, conError: 3, archivo: 'historico.xlsx' });
        const imp = (await db.query('select * from importaciones')).rows[0];
        expect(imp).toMatchObject({ id: r.importacion_id, nombre_archivo: 'historico.xlsx', tipo: 'historico_rodeos', total_filas: 10, insertadas: 1, duplicadas: 0, rechazadas: 2, errores: 3, created_by: ID.admin });
        const aud = (await db.query('select * from auditoria')).rows[0];
        expect(aud).toMatchObject({ tabla: 'importaciones', registro_id: r.importacion_id, accion: 'importacion_historica', actor_id: ID.admin, actor_tipo: 'administrador', ip_address: '10.0.0.1' });
        expect(aud.descripcion).toMatch(/IMPORTACIÓN HISTÓRICA/);
        expect(aud.datos_nuevos).toMatchObject({ archivo: 'historico.xlsx', sha256: 'a'.repeat(64), temporada: '2025-2026', resumen: { rodeos_creados: 1, asignaciones_creadas: 2, pagos_generados: 0 } });
        expect((await db.query('select importacion_id from rodeos')).rows[0].importacion_id).toBe(r.importacion_id);
    });
    test('pagos: los existentes no cambian y los históricos suman 0', async () => {
        const rid = await rodeoExistente({ fecha: '2026-03-01', club: 'Otro' });
        await db.query("insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, valor_diario_aplicado, duracion_dias_aplicada, pago_base_calculado, publicado) values ($1,$2,'jurado',60000,2,120000,true)", [rid, ID.j1]);
        const suma = async () => Number((await db.query('select coalesce(sum(pago_base_calculado),0) s from asignaciones')).rows[0].s);
        expect(await suma()).toBe(120000);
        await importar([grupo({ filas: [fila(2, ID.j1), fila(3, ID.j2)] }), grupo({ clave: 'x', fecha: '2026-02-20', club_norm: 'x2', club: 'X2' })]);
        expect(await suma()).toBe(120000);
        expect((await db.query('select pago_base_calculado, publicado from asignaciones where rodeo_id = $1', [rid])).rows[0]).toEqual({ pago_base_calculado: 120000, publicado: true });
    });
    test('bonos y control de gestión: no se tocan', async () => {
        await importar([grupo({ casos_whatsapp: 2, nota_delegado: 6 })]);
        expect(await cnt('bonos')).toBe(0); expect(await cnt('control_gestion_situaciones')).toBe(0);
    });
    test('el resultado por fila incluye acciones / existentes / conflictos / errores', async () => {
        const r = await importar([grupo({ filas: [fila(2, ID.j1), fila(3, ID.jPrueba)] })]);
        expect(r.filas).toHaveLength(2);
        expect(r.filas[0].acciones.join()).toMatch(/Asignación histórica creada/);
        expect(r.filas[1].errores.length).toBe(1);
        expect(r.grupos[0].acciones).toContain('Rodeo creado');
    });
});

// ── concurrencia (análisis + prueba disponible en un solo Postgres) ─────
describe('concurrencia', () => {
    test('la función toma pg_advisory_xact_lock por rodeo ANTES de buscar, y procesa grupos en orden determinista', () => {
        const lock = MIGRACION.indexOf("pg_advisory_xact_lock(hashtextextended('hist_rodeo|'");
        const buscar = MIGRACION.indexOf('FROM rodeos r');
        const crear = MIGRACION.indexOf('INSERT INTO rodeos');
        expect(lock).toBeGreaterThan(0);
        expect(lock).toBeLessThan(buscar); expect(buscar).toBeLessThan(crear);
        expect(MIGRACION).toMatch(/ORDER BY e\.value->>'clave'/);
        expect(MIGRACION).toMatch(/ON CONFLICT \(rodeo_id\) DO NOTHING/);
        expect(MIGRACION).toMatch(/ON CONFLICT \(asignacion_id\) DO NOTHING/);
    });
    test('el segundo intento (lo que vería la importación que espera el lock) encuentra el rodeo del primero: 1 rodeo, no 2', async () => {
        await importar([grupo()]);
        const r2 = await importar([grupo()]);
        expect(r2.resumen).toMatchObject({ rodeos_creados: 0, rodeos_reutilizados: 1 });
        expect(await cnt('rodeos')).toBe(1);
    });
    test('las dos ejecuciones lanzadas a la vez sobre la misma conexión se serializan y dejan 1 rodeo', async () => {
        const [a, b] = await Promise.all([importar([grupo({ filas: [fila(2, ID.j1)] })]), importar([grupo({ filas: [fila(2, ID.j2)] })])]);
        expect(a.resumen.rodeos_creados + b.resumen.rodeos_creados).toBe(1);
        expect(await cnt('rodeos')).toBe(1);
        expect(await cnt('asignaciones')).toBe(2);
    });
});

// ── la normalización de club en SQL coincide con la de Node ─────────────
describe('normalización del club: SQL == Node', () => {
    const sqlNorm = async (s) => (await db.query(`select btrim(regexp_replace(regexp_replace(lower(translate($1,
        'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ', 'aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC')), '[-–—]+', ' ', 'g'), '\\s+', ' ', 'g')) n`, [s])).rows[0].n;
    test.each(['Club Río Bueno', '  CLUB   RÍO  BUENO ', 'Club Ñuble-Sur', 'Lo Miranda – Rancagua', 'Ánimas  del  Sur', 'Sin club', 'Peñaflor', 'Café—Bar', 'ÜÑÍ'])('%j', async (s) => {
        expect(await sqlNorm(s)).toBe(normalizar(s));
    });
});
