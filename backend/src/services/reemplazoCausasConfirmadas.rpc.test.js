// Hotfix — migración 099, verificada contra Postgres REAL (PGlite). Carga la
// cadena real completa (083 -> 084 -> 086 -> 091 -> 094 -> 095 -> 099) y prueba
// reemplazar_jurado_asignacion_con_bitacora() con p_causas_confirmadas:
//   - firma única (sin sobrecarga de 12 parámetros que permita eludir la validación);
//   - permisos (solo service_role);
//   - compatibilidad con llamadas anteriores (sin el parámetro nuevo);
//   - registro de causas en bitacora_designaciones junto a motivo/actor/comentario;
//   - rechazo de causas obligatorias, desconocidas o mal formadas;
//   - atomicidad (ningún error deja la asignación ni la bitácora a medias);
//   - garantías previas intactas (pago vs duración, concurrencia, cruces);
//   - idempotencia de la migración.
// Caso VICTORIA reproducido con datos FICTICIOS.
jest.setTimeout(120000);
const fs = require('fs');
const path = require('path');
const { crearDb } = require('./__fixtures__/pgliteCliente');

const MIGRACIONES_DIR = path.join(__dirname, '..', '..', '..', 'database', 'migrations');
const leer = (n) => fs.readFileSync(path.join(MIGRACIONES_DIR, n), 'utf8');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaBitacoraDesignaciones.sql'), 'utf8');
const MIGRACION_099 = leer('099_reemplazo_jurado_causas_confirmadas.sql');

let db; const ID = {};
async function q(sql, p) { return (await db.query(sql, p)).rows; }

beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);
    for (const m of [
        '083_fase1a_bitacora_designaciones_catalogo_motivos_snapshot_notas.sql',
        '084_reemplazo_jurado_transaccional_con_bitacora.sql',
        '086_fase2c_version_control_propuestas_designacion.sql',
        '091_sincronizacion_duracion_asignaciones_rodeo.sql',
        '094_designacion_manual_con_bitacora_atomica.sql',
        '095_correccion_falso_conflicto_rechazado_reemplazo.sql'
    ]) await db.exec(leer(m));
    await db.exec(MIGRACION_099);

    await db.exec(`GRANT ALL ON TABLE administradores, temporadas, usuarios_pagados, rodeos, asignaciones,
        propuestas_designacion, propuestas_designacion_detalle, notas_rodeo, evaluaciones, evaluacion_casos,
        evaluacion_escala_puntaje_nota, evaluacion_escala_calificacion, evaluacion_auditoria,
        bonos_solicitados, cartillas_jurado TO service_role;`);

    ID.admin = (await q("insert into administradores (nombre_completo) values ('Admin Responsable') returning id"))[0].id;
    ID.actual = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado Actual Ficticio','C') returning id"))[0].id;
    ID.reemplazante = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado Reemplazante Ficticio','C') returning id"))[0].id;
    const motivos = await q('select id, codigo from catalogo_motivos_designacion');
    ID.motivo = Object.fromEntries(motivos.map(m => [m.codigo, m.id]));
});
afterAll(async () => { await db.close(); });

let seq = 0;
async function rodeoConAsignacion({ fecha, duracion = 2, juradoId = ID.actual, valorDiario = 200000 } = {}) {
    seq++;
    const f = fecha || new Date(Date.UTC(2029, 0, 1 + seq * 14)).toISOString().slice(0, 10);
    const rodeo = (await q("insert into rodeos (club, asociacion, fecha, duracion_dias) values ('VICTORIA FICTICIO','MALLECO FICTICIA',$1,$2) returning id", [f, duracion]))[0].id;
    const asig = (await q(
        `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, nombre_importado, categoria_aplicada,
            valor_diario_aplicado, duracion_dias_aplicada, pago_base_calculado, estado, estado_designacion)
         values ($1,$2,'jurado','Jurado Actual Ficticio','C',$3,$4,$5,'activo','aceptado') returning id`,
        [rodeo, juradoId, valorDiario, duracion, valorDiario * duracion]
    ))[0].id;
    return { rodeo, asig, fecha: f, duracion };
}
function reemplazar({ asig, nuevo = ID.reemplazante, duracion = 2, causas, motivo = 'jurado_no_disponible', detalle = null, esperado = null, pago }) {
    const conCausas = causas !== undefined;
    return q(
        `select reemplazar_jurado_asignacion_con_bitacora(
            p_asignacion_id := $1, p_usuario_pagado_id_nuevo := $2, p_categoria_aplicada_nueva := 'C',
            p_valor_diario_aplicado_nuevo := 200000, p_pago_base_calculado_nuevo := $3,
            p_motivo_catalogo_id := $4, p_actor_id := $5, p_motivo_detalle := $6,
            p_usuario_pagado_id_anterior_esperado := $7
            ${conCausas ? ', p_causas_confirmadas := $8::jsonb' : ''}
        ) as r`,
        [asig, nuevo, pago ?? 200000 * duracion, ID.motivo[motivo], ID.admin, detalle, esperado,
            ...(conCausas ? [causas === null ? null : JSON.stringify(causas)] : [])]
    ).then(rows => rows[0].r);
}
const estadoAsig = async (id) => (await q('select usuario_pagado_id, estado_designacion from asignaciones where id=$1', [id]))[0];
const bitacoraDe = (asig) => q('select * from bitacora_designaciones where asignacion_id=$1 order by created_at', [asig]);

describe('firma, sobrecargas y permisos', () => {
    test('existe UNA sola versión de la función (13 parámetros, último p_causas_confirmadas jsonb) — la de 12 fue eliminada', async () => {
        const filas = await q(`select pg_get_function_identity_arguments(p.oid) as args from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'reemplazar_jurado_asignacion_con_bitacora'`);
        expect(filas).toHaveLength(1);
        expect(filas[0].args).toMatch(/p_causas_confirmadas jsonb$/);
        expect(filas[0].args.split(',')).toHaveLength(13);
    });

    test('EXECUTE solo para service_role (nunca anon, authenticated ni PUBLIC)', async () => {
        const firma = 'reemplazar_jurado_asignacion_con_bitacora(uuid,uuid,text,integer,integer,uuid,uuid,text,uuid,text,timestamptz,uuid,jsonb)';
        const [p] = await q(`select has_function_privilege('service_role', '${firma}', 'EXECUTE') as svc,
            has_function_privilege('anon', '${firma}', 'EXECUTE') as anon,
            has_function_privilege('authenticated', '${firma}', 'EXECUTE') as auth`);
        expect(p).toEqual({ svc: true, anon: false, auth: false });
    });

    test('la migración es idempotente (volver a ejecutarla no crea sobrecargas ni falla)', async () => {
        await db.exec(MIGRACION_099);
        const [{ n }] = await q("select count(*)::int as n from pg_proc where proname = 'reemplazar_jurado_asignacion_con_bitacora'");
        expect(n).toBe(1);
    });
});

describe('compatibilidad con llamadas anteriores', () => {
    test('llamada SIN p_causas_confirmadas (forma previa a 099) -> reemplazo normal, causas_confirmadas NULL en la bitácora', async () => {
        const { asig } = await rodeoConAsignacion();
        const r = await reemplazar({ asig });
        expect(r.asignacion.usuario_pagado_id).toBe(ID.reemplazante);
        const [b] = await bitacoraDe(asig);
        expect(b.causas_confirmadas).toBeNull();
        expect(b.tipo_movimiento).toBe('reemplazo');
    });

    test('p_causas_confirmadas NULL explícito -> igual que sin parámetro', async () => {
        const { asig } = await rodeoConAsignacion();
        await reemplazar({ asig, causas: null });
        const [b] = await bitacoraDe(asig);
        expect(b.causas_confirmadas).toBeNull();
    });
});

describe('caso VICTORIA (ficticio) — registro de la excepción en la bitácora', () => {
    test('FINDE_CONSECUTIVO confirmado: bitácora con causa exacta, motivo, comentario, responsable y fecha; asignación actualizada atómicamente', async () => {
        const { asig } = await rodeoConAsignacion({ fecha: '2026-11-14', duracion: 2 });
        const r = await reemplazar({
            asig, causas: ['FINDE_CONSECUTIVO'], esperado: ID.actual,
            detalle: 'El jurado titular tiene problemas personales y solicita el cambio.'
        });
        expect(r.causas_confirmadas).toEqual(['FINDE_CONSECUTIVO']);
        expect(await estadoAsig(asig)).toEqual({ usuario_pagado_id: ID.reemplazante, estado_designacion: 'pendiente' });
        const bits = await bitacoraDe(asig);
        expect(bits).toHaveLength(1);
        expect(bits[0]).toEqual(expect.objectContaining({
            id: r.bitacora_id,
            causas_confirmadas: ['FINDE_CONSECUTIVO'],
            motivo_catalogo_id: ID.motivo.jurado_no_disponible,
            motivo_detalle: 'El jurado titular tiene problemas personales y solicita el cambio.',
            actor_id: ID.admin, actor_tipo: 'administrador',
            usuario_pagado_id_anterior: ID.actual, usuario_pagado_id_nuevo: ID.reemplazante,
            nombre_nuevo_snapshot: 'Jurado Reemplazante Ficticio'
        }));
        expect(bits[0].fecha_efectiva).toBeTruthy();
    });

    test('varias causas flexibles simultáneas quedan registradas', async () => {
        const { asig } = await rodeoConAsignacion();
        await reemplazar({ asig, causas: ['ASOCIACION_REPETIDA_TEMPORADA', 'DISTANCIA_EXCEDIDA', 'FINDE_CONSECUTIVO', 'JURADO_SIN_COMUNA_RESOLVIBLE'] });
        const [b] = await bitacoraDe(asig);
        expect(b.causas_confirmadas).toEqual(['ASOCIACION_REPETIDA_TEMPORADA', 'DISTANCIA_EXCEDIDA', 'FINDE_CONSECUTIVO', 'JURADO_SIN_COMUNA_RESOLVIBLE']);
    });
});

describe('causas inválidas -> excepción y ROLLBACK completo (nada cambia)', () => {
    test.each([
        ['causa OBLIGATORIA (MISMA_ASOCIACION)', ['MISMA_ASOCIACION'], /CAUSA_CONFIRMADA_DESCONOCIDA/],
        ['causa OBLIGATORIA mezclada con una flexible (MISMO_FINDE)', ['FINDE_CONSECUTIVO', 'MISMO_FINDE'], /CAUSA_CONFIRMADA_DESCONOCIDA/],
        ['causa desconocida', ['INVENTADA'], /CAUSA_CONFIRMADA_DESCONOCIDA/],
        ['array vacío', [], /CAUSAS_CONFIRMADAS_INVALIDAS/],
        ['objeto en lugar de array', { causa: 'FINDE_CONSECUTIVO' }, /CAUSAS_CONFIRMADAS_INVALIDAS/],
        ['string suelto', 'FINDE_CONSECUTIVO', /CAUSAS_CONFIRMADAS_INVALIDAS/],
        ['elemento no textual', [1], /CAUSAS_CONFIRMADAS_INVALIDAS/],
        ['duplicados', ['FINDE_CONSECUTIVO', 'FINDE_CONSECUTIVO'], /CAUSAS_CONFIRMADAS_INVALIDAS/]
    ])('%s', async (_d, causas, error) => {
        const { asig } = await rodeoConAsignacion();
        await expect(reemplazar({ asig, causas })).rejects.toThrow(error);
        expect(await estadoAsig(asig)).toEqual({ usuario_pagado_id: ID.actual, estado_designacion: 'aceptado' });
        expect(await bitacoraDe(asig)).toHaveLength(0);
    });
});

describe('garantías previas intactas (con causas confirmadas válidas)', () => {
    test('cruce real de fechas -> CRUCE_DISPONIBILIDAD y rollback (la confirmación de advertencias nunca omite un cruce)', async () => {
        const destino = await rodeoConAsignacion({ fecha: '2030-03-02', duracion: 2 });
        await rodeoConAsignacion({ fecha: '2030-03-03', duracion: 1, juradoId: ID.reemplazante });
        await expect(reemplazar({ asig: destino.asig, causas: ['FINDE_CONSECUTIVO'] })).rejects.toThrow(/CRUCE_DISPONIBILIDAD/);
        expect((await estadoAsig(destino.asig)).usuario_pagado_id).toBe(ID.actual);
        expect(await bitacoraDe(destino.asig)).toHaveLength(0);
    });

    test('pago inconsistente con la duración -> PAGO_BASE_INCONSISTENTE_CON_DURACION', async () => {
        const { asig } = await rodeoConAsignacion({ duracion: 2 });
        await expect(reemplazar({ asig, causas: ['FINDE_CONSECUTIVO'], pago: 200000 })).rejects.toThrow(/PAGO_BASE_INCONSISTENTE_CON_DURACION/);
        expect(await bitacoraDe(asig)).toHaveLength(0);
    });

    test('concurrencia optimista -> CONFLICTO_DESIGNACION_MODIFICADA', async () => {
        const { asig } = await rodeoConAsignacion();
        await expect(reemplazar({ asig, causas: ['FINDE_CONSECUTIVO'], esperado: ID.admin })).rejects.toThrow(/CONFLICTO_DESIGNACION_MODIFICADA/);
        expect(await bitacoraDe(asig)).toHaveLength(0);
    });

    test('motivo inactivo -> MOTIVO_INVALIDO y rollback', async () => {
        const { asig } = await rodeoConAsignacion();
        await q("update catalogo_motivos_designacion set activo = false where codigo = 'otro'");
        await expect(reemplazar({ asig, causas: ['FINDE_CONSECUTIVO'], motivo: 'otro' })).rejects.toThrow(/MOTIVO_INVALIDO/);
        await q("update catalogo_motivos_designacion set activo = true where codigo = 'otro'");
        expect(await bitacoraDe(asig)).toHaveLength(0);
    });

    test('ejecutada como service_role (rol real del backend) funciona y registra causas', async () => {
        const { asig } = await rodeoConAsignacion();
        // En producción service_role tiene BYPASSRLS (verificado); PGlite no
        // lo trae por defecto — se replica ese atributo para probar con el rol real.
        await db.exec('ALTER ROLE service_role BYPASSRLS;');
        await db.exec('BEGIN; SET LOCAL ROLE service_role;');
        try {
            await reemplazar({ asig, causas: ['DISTANCIA_EXCEDIDA'] });
            await db.exec('COMMIT;');
        } catch (e) { await db.exec('ROLLBACK;'); throw e; }
        const [b] = await bitacoraDe(asig);
        expect(b.causas_confirmadas).toEqual(['DISTANCIA_EXCEDIDA']);
    });
});
