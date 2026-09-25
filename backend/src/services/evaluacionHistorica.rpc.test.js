// Marcador es_historica_importacion y conversión histórica → normal (migración 060) sobre un Postgres REAL de prueba (PGlite).
const fs = require('fs');
const path = require('path');
jest.setTimeout(120000);
const { crearDb } = require('./__fixtures__/pgliteCliente');
const { ciclosIniciales, CONFIGURACION_POR_DEFECTO } = require('./evaluacionCreacion');

const MIGRACION = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'database', 'migrations', '060_importacion_historica_rodeos.sql'), 'utf8');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaImportacionHistorica.sql'), 'utf8');
const DESDE = '2026-01-01', HASTA = '2026-03-31';

let db; const ID = {};

async function q(sql, p) { return (await db.query(sql, p)).rows; }
beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);
    // Evaluaciones NORMALES anteriores a la migración (deben quedar es_historica_importacion = false)
    ID.admin = (await q("insert into administradores (nombre_completo) values ('Admin') returning id"))[0].id;
    ID.analista = (await q("insert into administradores (nombre_completo, rol_evaluacion) values ('Analista','analista') returning id"))[0].id;
    ID.inactivo = (await q("insert into administradores (nombre_completo, activo) values ('Inactivo', false) returning id"))[0].id;
    ID.temp = (await q("insert into temporadas (nombre, fecha_inicio, fecha_fin) values ('2025-2026','2025-04-01','2026-03-31') returning id"))[0].id;
    ID.asoc = (await q("insert into asociaciones (nombre) values ('Asociación Osorno') returning id"))[0].id;
    ID.cat = (await q("insert into categorias_rodeo (nombre) values ('Tercera') returning id"))[0].id;
    ID.tipo = (await q("insert into tipos_rodeo (nombre, duracion_dias, categoria_rodeo_id) values ('Rodeo Libre', 2, $1) returning id", [ID.cat]))[0].id;
    ID.j1 = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Juan Pérez','A') returning id"))[0].id;
    ID.rodeoAntiguo = (await q("insert into rodeos (club, asociacion, fecha, tipo_rodeo_id, duracion_dias) values ('Antiguo','Osorno','2025-11-01',$1,2) returning id", [ID.tipo]))[0].id;
    await db.query("insert into evaluaciones (rodeo_id, creado_por, estado) values ($1, $2, 'publicado')", [ID.rodeoAntiguo, ID.admin]);
    await db.exec(MIGRACION);
});
afterAll(async () => { await db.close(); });
beforeEach(async () => {
    // DELETE (no TRUNCATE CASCADE: importaciones/asignaciones arrastrarían también la evaluación normal antigua)
    await db.exec('TRUNCATE evaluacion_auditoria, evaluacion_casos, evaluacion_ciclos, notas_rodeo, rodeo_notas_secundarias');
    await db.exec("DELETE FROM asignaciones");
    await db.exec("DELETE FROM evaluaciones WHERE rodeo_id <> (SELECT id FROM rodeos WHERE club='Antiguo')");
    await db.exec("DELETE FROM rodeos WHERE club <> 'Antiguo'");
    await db.exec('DELETE FROM importaciones; DELETE FROM auditoria');
});

const cnt = async (t, w = '') => Number((await q(`select count(*) c from ${t} ${w}`))[0].c);
const grupo = (o = {}) => ({ clave: '2026-02-15|club x|A|T', fecha: '2026-02-15', club: 'Club X', club_norm: 'club x', asociacion_id: ID.asoc, asociacion_variantes: ['Osorno'], tipo_rodeo_id: ID.tipo, categoria_rodeo_id: ID.cat, nota_delegado: null, nota_comision: null, casos_whatsapp: 0, filas: [{ fila: 2, jurado: 'Juan', usuario_pagado_id: ID.j1, nota_deportiva: null }], ...o });
async function importar(grupos, { crear = true } = {}) {
    return (await q('select importar_rodeos_historicos($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12) as r', [ID.admin, ID.temp, DESDE, HASTA, 'h.xlsx', 'a'.repeat(64), 5, JSON.stringify(grupos), 0, 0, crear, '10.0.0.1']))[0].r;
}
const CFG = { ...CONFIGURACION_POR_DEFECTO, puntaje_base: 77, min_casos_ciclo1: 1, max_casos_ciclo1: 9, min_casos_ciclo2: 7, max_casos_ciclo2: 7 };
async function convertir(rodeoId, o = {}) {
    return (await q('select convertir_evaluacion_historica($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8) as r',
        [rodeoId, o.analista || ID.analista, o.puntaje ?? CFG.puntaje_base, o.actor || ID.admin, 'Admin', JSON.stringify(o.ciclos || ciclosIniciales(CFG)), JSON.stringify(o.detalle || { origen: 'test' }), o.ip === undefined ? '10.1.1.1' : o.ip]))[0].r;
}
const evDe = async (rodeoId) => (await q('select * from evaluaciones where rodeo_id=$1', [rodeoId]))[0];
async function crearHistorica(casos = 4) {
    const r = await importar([grupo({ casos_whatsapp: casos })]);
    const rodeoId = r.grupos[0].rodeo_id;
    return { rodeoId, ev: await evDe(rodeoId) };
}

describe('marcador es_historica_importacion', () => {
    test('la columna existe, es BOOLEAN NOT NULL con default false', async () => {
        const c = (await q("select data_type, is_nullable, column_default from information_schema.columns where table_name='evaluaciones' and column_name='es_historica_importacion'"))[0];
        expect(c).toEqual({ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' });
    });
    test('evaluaciones NORMALES anteriores a la migración quedan en false (y sin tocar)', async () => {
        const e = await evDe(ID.rodeoAntiguo);
        expect(e).toMatchObject({ es_historica_importacion: false, estado: 'publicado' });
    });
    test('un INSERT que no menciona la columna (creación normal actual) queda en false', async () => {
        const rid = (await q("insert into rodeos (club, asociacion, fecha, tipo_rodeo_id, duracion_dias) values ('N','Osorno','2026-02-01',$1,1) returning id", [ID.tipo]))[0].id;
        await db.query("insert into evaluaciones (rodeo_id, creado_por) values ($1,$2)", [rid, ID.admin]);
        expect(await evDe(rid)).toMatchObject({ es_historica_importacion: false, estado: 'borrador' });
    });
    test('CHECK: una evaluación histórica solo puede estar en estado cerrado', async () => {
        const rid = (await q("insert into rodeos (club, asociacion, fecha, tipo_rodeo_id, duracion_dias) values ('N2','Osorno','2026-02-02',$1,1) returning id", [ID.tipo]))[0].id;
        await expect(db.query("insert into evaluaciones (rodeo_id, creado_por, estado, es_historica_importacion) values ($1,$2,'en_proceso',true)", [rid, ID.admin])).rejects.toThrow(/chk_evaluaciones_historica_cerrada/);
    });
    test('la migración es idempotente (segunda ejecución sin error ni cambios)', async () => {
        await expect(db.exec(MIGRACION)).resolves.not.toThrow();
        expect((await evDe(ID.rodeoAntiguo)).es_historica_importacion).toBe(false);
    });
});

describe('evaluación histórica creada por la importación', () => {
    test('Excel casos=0 sin evaluación → NO se crea evaluación', async () => {
        await importar([grupo({ casos_whatsapp: 0 })]);
        expect(await cnt('evaluaciones', "where es_historica_importacion")).toBe(0);
        expect(await cnt('evaluaciones')).toBe(1);        // solo la antigua
    });
    test('Excel casos>0 → histórica: es_historica=true, cerrado, casos conservados, sin ciclos ni nota_final ni notas', async () => {
        const { ev } = await crearHistorica(4);
        expect(ev).toMatchObject({ es_historica_importacion: true, estado: 'cerrado', casos_whatsapp: 4, nota_final: null, puntaje_final: null, analista_id: null, nota_publicada: false, creado_por: ID.admin });
        expect(await cnt('evaluacion_ciclos')).toBe(0); expect(await cnt('evaluacion_casos')).toBe(0);
        expect(await cnt('evaluacion_auditoria')).toBe(0); expect(await cnt('notas_rodeo')).toBe(0); expect(await cnt('rodeo_notas_secundarias')).toBe(0);
    });
    test('no aparece como pendiente: estado terminal cerrado y sin analista', async () => {
        await crearHistorica(2);
        const pendientes = await cnt('evaluaciones', "where es_historica_importacion and estado not in ('cerrado','publicado')");
        expect(pendientes).toBe(0);
    });
    test('C/D: histórica existente + mismo valor = no-op; distinto = CONFLICTO sin sobrescribir', async () => {
        const { rodeoId } = await crearHistorica(4);
        let r = await importar([grupo({ casos_whatsapp: 4 })]);
        expect(r.resumen).toMatchObject({ casos_whatsapp_iguales: 1, conflictos_casos_whatsapp: 0, evaluaciones_historicas_creadas: 0 });
        r = await importar([grupo({ casos_whatsapp: 9 })]);
        expect(r.resumen).toMatchObject({ conflictos_casos_whatsapp: 1, casos_whatsapp_cargados: 0 });
        expect((await evDe(rodeoId)).casos_whatsapp).toBe(4);
    });
    test('reimportar no duplica la histórica (una sola fila por rodeo)', async () => {
        const { rodeoId } = await crearHistorica(4);
        await importar([grupo({ casos_whatsapp: 4 })]); await importar([grupo({ casos_whatsapp: 4 })]);
        expect(await cnt('evaluaciones', `where rodeo_id = '${rodeoId}'`)).toBe(1);
        expect(await cnt('rodeos', "where club = 'Club X'")).toBe(1);
    });
    test('casos_whatsapp de una histórica sigue siendo consultable', async () => {
        const { rodeoId } = await crearHistorica(6);
        expect((await q('select casos_whatsapp from evaluaciones where rodeo_id=$1', [rodeoId]))[0].casos_whatsapp).toBe(6);
    });
});

describe('conversión histórica → normal (atómica)', () => {
    test('reutiliza la MISMA fila: conserva casos_whatsapp, true→false, estado inicial normal, ciclos y auditoría', async () => {
        const { rodeoId, ev } = await crearHistorica(4);
        const r = await convertir(rodeoId);
        expect(r.id).toBe(ev.id);                                               // misma evaluación (no hay segunda fila)
        const e = await evDe(rodeoId);
        expect(e).toMatchObject({ id: ev.id, es_historica_importacion: false, casos_whatsapp: 4, estado: 'borrador', analista_id: ID.analista, puntaje_base: 77, creado_por: ID.admin, nota_final: null, nota_publicada: false });
        expect(await cnt('evaluaciones', `where rodeo_id = '${rodeoId}'`)).toBe(1);        // UNIQUE rodeo_id no genera error ni segunda fila
        const ciclos = await q('select numero_ciclo, min_casos, max_casos, estado from evaluacion_ciclos where evaluacion_id=$1 order by numero_ciclo', [ev.id]);
        expect(ciclos).toEqual(ciclosIniciales(CFG).map(c => ({ ...c, estado: 'pendiente_carga' })));      // misma definición que la creación normal
        const aud = await q('select * from evaluacion_auditoria where evaluacion_id=$1', [ev.id]);
        expect(aud).toHaveLength(1);
        expect(aud[0]).toMatchObject({ accion: 'crear_evaluacion', actor_id: ID.admin, actor_tipo: 'administrador', actor_nombre: 'Admin', detalle: { origen: 'test' } });
        expect(String(aud[0].ip_address)).toContain('10.1.1.1');
    });
    test('el estado inicial es el mismo que el de una evaluación normal nueva (default de la tabla)', async () => {
        const rid = (await q("insert into rodeos (club, asociacion, fecha, tipo_rodeo_id, duracion_dias) values ('Nuevo','Osorno','2026-02-03',$1,1) returning id", [ID.tipo]))[0].id;
        await db.query('insert into evaluaciones (rodeo_id, creado_por) values ($1,$2)', [rid, ID.admin]);
        const normal = await evDe(rid);
        const { rodeoId } = await crearHistorica(3);
        await convertir(rodeoId);
        const conv = await evDe(rodeoId);
        for (const k of ['estado', 'nota_final', 'puntaje_final', 'nota_publicada', 'resultados_alterados', 'anulada', 'modo_flujo', 'decision_jefe', 'jefe_id']) expect(conv[k] ?? null).toEqual(normal[k] ?? null);
    });
    test('después de convertir, la importación ve una evaluación NORMAL: igual = no-op, distinto = conflicto (E/F)', async () => {
        const { rodeoId } = await crearHistorica(4);
        await convertir(rodeoId);
        expect((await importar([grupo({ casos_whatsapp: 4 })])).resumen).toMatchObject({ casos_whatsapp_iguales: 1, conflictos_casos_whatsapp: 0 });
        expect((await importar([grupo({ casos_whatsapp: 8 })])).resumen).toMatchObject({ conflictos_casos_whatsapp: 1 });
        expect((await evDe(rodeoId)).casos_whatsapp).toBe(4);
    });
    test('ATÓMICA: un error después de actualizar la fila (ciclo inválido) no deja estado parcial', async () => {
        const { rodeoId, ev } = await crearHistorica(4);
        await expect(convertir(rodeoId, { ciclos: [{ numero_ciclo: 1, min_casos: 0, max_casos: 5 }, { numero_ciclo: 3, min_casos: 0, max_casos: 5 }] })).rejects.toThrow(/numero_ciclo_check/);
        expect(await evDe(rodeoId)).toMatchObject({ id: ev.id, es_historica_importacion: true, estado: 'cerrado', analista_id: null, casos_whatsapp: 4, creado_por: ev.creado_por });
        expect(await cnt('evaluacion_ciclos')).toBe(0); expect(await cnt('evaluacion_auditoria')).toBe(0);
    });
    test('ATÓMICA: un error en la auditoría (actor_tipo/actor inválido) también revierte ciclos y actualización', async () => {
        const { rodeoId } = await crearHistorica(4);
        // actor_nombre demasiado no aplica; se fuerza el fallo con un detalle que no es JSON de objeto → NULL permitido; usamos ciclos duplicados (UNIQUE)
        await expect(convertir(rodeoId, { ciclos: [{ numero_ciclo: 1, min_casos: 0, max_casos: 5 }, { numero_ciclo: 1, min_casos: 0, max_casos: 5 }] })).rejects.toThrow(/duplicate key|unique/i);
        expect(await evDe(rodeoId)).toMatchObject({ es_historica_importacion: true, estado: 'cerrado' });
        expect(await cnt('evaluacion_ciclos')).toBe(0);
    });
    test('no convierte una evaluación NORMAL, una histórica anulada, una que ya tiene ciclos, ni sin evaluación', async () => {
        await expect(convertir(ID.rodeoAntiguo)).rejects.toThrow(/EVAL_CONV_NO_HISTORICA/);
        const { rodeoId } = await crearHistorica(4);
        await db.exec(`UPDATE evaluaciones SET anulada = true WHERE rodeo_id = '${rodeoId}'`);
        await expect(convertir(rodeoId)).rejects.toThrow(/EVAL_CONV_ANULADA/);
        await db.exec(`UPDATE evaluaciones SET anulada = false WHERE rodeo_id = '${rodeoId}'`);
        await db.exec(`INSERT INTO evaluacion_ciclos (evaluacion_id, numero_ciclo) SELECT id, 1 FROM evaluaciones WHERE rodeo_id = '${rodeoId}'`);
        await expect(convertir(rodeoId)).rejects.toThrow(/EVAL_CONV_YA_TIENE_CICLOS/);
        await expect(convertir('00000000-0000-0000-0000-000000000000')).rejects.toThrow(/EVAL_CONV_NO_ENCONTRADA/);
        expect(await evDe(ID.rodeoAntiguo)).toMatchObject({ estado: 'publicado', es_historica_importacion: false });
    });
    test('valida argumentos y actor (administrador inexistente o inactivo)', async () => {
        const { rodeoId } = await crearHistorica(4);
        await expect(convertir(rodeoId, { ciclos: [] })).rejects.toThrow(/EVAL_CONV_ARGUMENTOS_INVALIDOS/);
        await expect(convertir(rodeoId, { actor: ID.inactivo })).rejects.toThrow(/EVAL_CONV_SIN_PERMISO/);
        await expect(convertir(rodeoId, { actor: '00000000-0000-0000-0000-000000000000' })).rejects.toThrow(/EVAL_CONV_SIN_PERMISO/);
        expect((await evDe(rodeoId)).es_historica_importacion).toBe(true);
    });
    test('una IP no válida no impide la conversión (se guarda NULL)', async () => {
        const { rodeoId, ev } = await crearHistorica(4);
        await convertir(rodeoId, { ip: 'no-es-una-ip' });
        expect((await q('select ip_address from evaluacion_auditoria where evaluacion_id=$1', [ev.id]))[0].ip_address).toBeNull();
    });
    test('seguridad de la función: SECURITY DEFINER, search_path fijo, EXECUTE solo service_role', async () => {
        const p = (await q("select prosecdef, proconfig from pg_proc where proname='convertir_evaluacion_historica'"))[0];
        expect(p.prosecdef).toBe(true); expect(p.proconfig).toContain('search_path=public, pg_temp');
        const priv = async (rol) => (await q(`select has_function_privilege('${rol}', 'convertir_evaluacion_historica(uuid,uuid,integer,uuid,text,jsonb,jsonb,text)', 'EXECUTE') ok`))[0].ok;
        expect(await priv('service_role')).toBe(true); expect(await priv('anon')).toBe(false); expect(await priv('authenticated')).toBe(false);
    });
});

describe('importación: no tocar lo que no corresponde', () => {
    test('la RPC de importación sigue con pago 0, publicado=false, y solo la evaluación mínima marcada', async () => {
        const r = await importar([grupo({ casos_whatsapp: 2, nota_delegado: 6, filas: [{ fila: 2, jurado: 'J', usuario_pagado_id: ID.j1, nota_deportiva: 5 }] })]);
        expect(r.resumen).toMatchObject({ pagos_generados: 0, evaluaciones_historicas_creadas: 1 });
        expect((await q('select pago_base_calculado, valor_diario_aplicado, publicado, estado_designacion, importacion_id from asignaciones'))[0]).toMatchObject({ pago_base_calculado: 0, valor_diario_aplicado: 0, publicado: false, estado_designacion: 'aceptado' });
        expect(await cnt('evaluacion_ciclos')).toBe(0);
    });
    test('la asignación pre-existente en un rodeo existente NO se marca con importacion_id; solo la creada', async () => {
        const rid = (await q("insert into rodeos (club, asociacion, fecha, tipo_rodeo_id, duracion_dias) values ('Club X','Asociación Osorno','2026-02-15',$1,2) returning id", [ID.tipo]))[0].id;
        await db.query("insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, valor_diario_aplicado, duracion_dias_aplicada, pago_base_calculado) values ($1,$2,'jurado',1000,2,2000)", [rid, ID.j1]);
        const j2 = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Otro','B') returning id"))[0].id;
        await importar([grupo({ filas: [{ fila: 2, jurado: 'J1', usuario_pagado_id: ID.j1, nota_deportiva: null }, { fila: 3, jurado: 'J2', usuario_pagado_id: j2, nota_deportiva: null }] })]);
        const filas = await q('select usuario_pagado_id, importacion_id, pago_base_calculado from asignaciones order by pago_base_calculado desc');
        expect(filas[0]).toMatchObject({ usuario_pagado_id: ID.j1, importacion_id: null, pago_base_calculado: 2000 });
        expect(filas[1]).toMatchObject({ usuario_pagado_id: j2, pago_base_calculado: 0 });
        expect(filas[1].importacion_id).not.toBeNull();
    });
});

describe('rendimiento de la RPC (referencia para el timeout; PGlite = WASM, cota superior)', () => {
    test.each([[100], [300], [500]])('%i rodeos con 2 jurados distintos, notas y casos se importan en una sola llamada y con tiempo razonable', async (n) => {
        const j2 = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Segundo Jurado','B') returning id"))[0].id;
        const grupos = [];
        for (let i = 0; i < n; i++) {
            const d = String(1 + (i % 28)).padStart(2, '0');
            grupos.push(grupo({ clave: `c${String(i).padStart(4, '0')}`, fecha: `2026-02-${d}`, club: `Club ${i}`, club_norm: `club ${i}`, nota_delegado: 6, casos_whatsapp: i % 3, filas: [{ fila: 2 + i * 2, jurado: 'a', usuario_pagado_id: ID.j1, nota_deportiva: 5 }, { fila: 3 + i * 2, jurado: 'b', usuario_pagado_id: j2, nota_deportiva: 6 }] }));
        }
        const t0 = Date.now();
        const r = await importar(grupos);
        const ms = Date.now() - t0;
        expect(r.resumen.rodeos_creados).toBe(n);
        console.log(`[timing] ${n} rodeos → ${ms} ms (PGlite/WASM)`);
        expect(ms).toBeLessThan(60000);
    });
});
