// Migración 104 (designación manual con excepción por intervalo) contra
// PostgreSQL REAL (PGlite), sobre el mismo esquema y orden de migraciones que
// designacionManualConBitacora.rpc.test.js: 083 → 084 → 086 → 091 → 094 → 104.
//   - con 094 sola, ASOCIACION_REPETIDA_INTERVALO se rechaza (estado actual de producción);
//   - con 104, se acepta y queda registrada atómicamente en la bitácora;
//   - el cuerpo cambia SOLO en el allowlist (todo lo demás idéntico a 094);
//   - las demás defensas siguen intactas (causa desconocida/obligatoria, sin motivo, sin disponibilidad).
jest.setTimeout(120000);
const fs = require('fs');
const path = require('path');
const { crearDb } = require('./__fixtures__/pgliteCliente');

const DIR = path.join(__dirname, '..', '..', '..', 'database', 'migrations');
const leer = (n) => fs.readFileSync(path.join(DIR, n), 'utf8');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaBitacoraDesignaciones.sql'), 'utf8');

let db; const ID = {};
const q = async (sql, p) => (await db.query(sql, p)).rows;
let cuerpo094, comentario094, dueno094;

beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);
    for (const m of ['083_fase1a_bitacora_designaciones_catalogo_motivos_snapshot_notas.sql', '084_reemplazo_jurado_transaccional_con_bitacora.sql',
        '086_fase2c_version_control_propuestas_designacion.sql', '091_sincronizacion_duracion_asignaciones_rodeo.sql',
        '094_designacion_manual_con_bitacora_atomica.sql']) {
        await db.exec(leer(m));
    }
    await db.exec(`GRANT ALL ON TABLE administradores, temporadas, usuarios_pagados, rodeos, asignaciones,
        propuestas_designacion, propuestas_designacion_detalle, notas_rodeo, evaluaciones, evaluacion_casos,
        evaluacion_escala_puntaje_nota, evaluacion_escala_calificacion, evaluacion_auditoria,
        bonos_solicitados, cartillas_jurado TO service_role;`);
    ID.admin = (await q("insert into administradores (nombre_completo) values ('Admin Test') returning id"))[0].id;
    ID.j = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado Ficticio','C') returning id"))[0].id;
    ID.motivo = (await q("select id from catalogo_motivos_designacion where activo limit 1"))[0].id;
    const f094 = (await q("select prosrc, obj_description(oid, 'pg_proc') c, proowner from pg_proc where proname = 'crear_asignacion_con_bitacora'"))[0];
    cuerpo094 = f094.prosrc; comentario094 = f094.c; dueno094 = f094.proowner;
});
afterAll(async () => { if (db) await db.close(); });

let seq = 0;
async function rodeoConDisponibilidad(conDisponibilidad = true) {
    seq++;
    const d = new Date('2027-02-01T00:00:00Z'); d.setUTCDate(d.getUTCDate() + seq * 9);
    const fecha = d.toISOString().slice(0, 10);
    const id = (await q("insert into rodeos (club, asociacion, fecha, duracion_dias) values ('ALBORADA FICTICIA','LINARES',$1,1) returning id", [fecha]))[0].id;
    if (conDisponibilidad) await q('insert into disponibilidad_usuarios (usuario_pagado_id, fecha) values ($1,$2)', [ID.j, fecha]);
    return id;
}
function crear(rodeoId, causas, motivo = ID.motivo) {
    return q(`select crear_asignacion_con_bitacora(
        p_rodeo_id := $1, p_usuario_pagado_id := $2, p_categoria_aplicada := 'C', p_valor_diario_aplicado := 100000,
        p_duracion_dias_aplicada := 1, p_pago_base_calculado := 100000, p_motivo_catalogo_id := $3, p_actor_id := $4,
        p_causas_confirmadas := $5::jsonb, p_motivo_detalle := 'prueba') r`, [rodeoId, ID.j, motivo, ID.admin, JSON.stringify(causas)]);
}
const contar = async (tabla, rodeoId) => (await q(`select count(*)::int n from ${tabla} where rodeo_id = $1`, [rodeoId]))[0].n;

test('estado actual (solo 094): la excepción por intervalo se rechaza y no deja nada escrito', async () => {
    const r = await rodeoConDisponibilidad();
    await expect(crear(r, ['ASOCIACION_REPETIDA_INTERVALO'])).rejects.toThrow(/CAUSA_CONFIRMADA_DESCONOCIDA/);
    expect(await contar('asignaciones', r)).toBe(0);
    expect(await contar('bitacora_designaciones', r)).toBe(0);
});

describe('con la migración 104 aplicada', () => {
    beforeAll(async () => { await db.exec(leer('104_designacion_manual_excepcion_intervalo.sql')); });

    test('el cuerpo cambia SOLO en el allowlist (todo lo demás idéntico a 094 / producción)', async () => {
        const cuerpo104 = (await q("select prosrc from pg_proc where proname = 'crear_asignacion_con_bitacora'"))[0].prosrc.replace(/\r\n/g, '\n');
        const BLOQUE_104 = '        -- [104] Desde esta migración el allowlist ya NO es espejo exacto de\n'
            + '        -- CAUSAS_RELAJABLES: es CAUSAS_EXCEPCIONABLES_MANUAL (elegibilidadJurado.js)\n'
            + '        -- = relajables + ASOCIACION_REPETIDA_INTERVALO, excepción administrativa\n'
            + '        -- SOLO de la designación manual. El motor automático sigue tratando el\n'
            + '        -- intervalo como obligatorio y el reemplazo no usa esta función.\n';
        expect(cuerpo104).toContain(BLOQUE_104);
        const restaurado = cuerpo104
            .replace(BLOQUE_104, '')
            .replace(", 'JURADO_SIN_COMUNA_RESOLVIBLE', 'ASOCIACION_REPETIDA_INTERVALO')", ", 'JURADO_SIN_COMUNA_RESOLVIBLE')");
        expect(restaurado).toBe(cuerpo094.replace(/\r\n/g, '\n'));
        expect((await q("select count(*)::int n from pg_proc where proname = 'crear_asignacion_con_bitacora'"))[0].n).toBe(1); // sin sobrecarga
        // Comentario y dueño de la función se conservan (CREATE OR REPLACE).
        const f = (await q("select obj_description(oid, 'pg_proc') c, proowner from pg_proc where proname = 'crear_asignacion_con_bitacora'"))[0];
        expect(f.c).toBe(comentario094);
        expect(f.proowner).toBe(dueno094);
    });

    test('nada más cambia: reemplazo, registrar_movimiento y el CHECK de la bitácora quedan idénticos', async () => {
        // Se aplicó solo la 104 sobre el estado 094: comparar contra la definición de las migraciones previas.
        const reemplazo = (await q("select count(*)::int n from pg_proc where proname = 'reemplazar_jurado_asignacion_con_bitacora' and prosrc like '%ASOCIACION_REPETIDA_INTERVALO%'"))[0].n;
        expect(reemplazo).toBe(0);
        const archivo104 = leer('104_designacion_manual_excepcion_intervalo.sql');
        const sentencias = archivo104.replace(/\r\n/g, '\n').split('\n').filter(l => /^(CREATE|ALTER|DROP|REVOKE|GRANT|COMMENT|INSERT|UPDATE|DELETE)\b/.test(l));
        expect(sentencias).toEqual([
            'CREATE OR REPLACE FUNCTION crear_asignacion_con_bitacora(',
            'REVOKE ALL ON FUNCTION crear_asignacion_con_bitacora(',
            'GRANT EXECUTE ON FUNCTION crear_asignacion_con_bitacora('
        ]);
    });

    test('acepta la excepción por intervalo (sola o con otra advertencia) y la registra atómicamente en la bitácora', async () => {
        const r = await rodeoConDisponibilidad();
        const res = (await crear(r, ['ASOCIACION_REPETIDA_INTERVALO', 'FINDE_CONSECUTIVO']))[0].r;
        const bit = (await q('select * from bitacora_designaciones where id = $1', [res.bitacora_id]))[0];
        expect(bit.tipo_movimiento).toBe('designacion_manual_con_advertencia');
        expect(bit.causas_confirmadas).toEqual(['ASOCIACION_REPETIDA_INTERVALO', 'FINDE_CONSECUTIVO']);
        expect(bit.motivo_catalogo_id).toBe(ID.motivo);
        expect(bit.actor_id).toBe(ID.admin);
        expect(await contar('asignaciones', r)).toBe(1);
    });

    test('causas obligatorias o desconocidas siguen rechazadas; nada queda escrito', async () => {
        for (const causas of [['MISMA_ASOCIACION'], ['DISPONIBILIDAD'], ['MISMO_FINDE'], ['CATEGORIA_INCOMPATIBLE'], ['ASOCIACION_REPETIDA_INTERVALO', 'INVENTADA']]) {
            const r = await rodeoConDisponibilidad();
            await expect(crear(r, causas)).rejects.toThrow(/CAUSA_CONFIRMADA_DESCONOCIDA/);
            expect(await contar('asignaciones', r)).toBe(0);
        }
    });

    test('defensas estructurales intactas: sin disponibilidad declarada, sin motivo o sin causas -> rechazo', async () => {
        const sinDisp = await rodeoConDisponibilidad(false);
        await expect(crear(sinDisp, ['ASOCIACION_REPETIDA_INTERVALO'])).rejects.toThrow(/SIN_DISPONIBILIDAD_DECLARADA/);
        const r = await rodeoConDisponibilidad();
        await expect(crear(r, ['ASOCIACION_REPETIDA_INTERVALO'], null)).rejects.toThrow(/MOTIVO_REQUERIDO/);
        await expect(crear(r, [])).rejects.toThrow(/CAUSAS_CONFIRMADAS_REQUERIDAS/);
        expect(await contar('asignaciones', r)).toBe(0);
    });

    test('privilegios: solo service_role puede ejecutarla', async () => {
        const ok = (await q(`select has_function_privilege('service_role', p.oid, 'EXECUTE') sr,
                                    has_function_privilege('anon', p.oid, 'EXECUTE') an,
                                    has_function_privilege('authenticated', p.oid, 'EXECUTE') au
                             from pg_proc p where proname = 'crear_asignacion_con_bitacora'`))[0];
        expect(ok).toEqual({ sr: true, an: false, au: false });
    });
});
