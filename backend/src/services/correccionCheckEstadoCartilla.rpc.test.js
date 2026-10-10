// Corrección de compatibilidad previa a producción — confirma, contra un
// PostgreSQL REAL (PGlite) con el CHECK EXACTO que el usuario verificó
// directamente en el SQL Editor de Supabase producción (NO una suposición):
//   cartillas_delegado_estado_check SOLO permite hoy:
//   'borrador', 'enviada', 'observada', 'aprobada', 'cerrada' — SIN 'reenviada'.
//
// Prueba dos escenarios:
//   1. SIN la migración 072: intentar guardar estado='reenviada' FALLA con
//      una violación real de CHECK (el defecto confirmado existe de verdad,
//      no es una suposición tampoco de este lado).
//   2. CON la migración 072 aplicada: el mismo intento TIENE ÉXITO, y los 5
//      valores históricos (incluido para Delegado Rentado) siguen intactos.
const fs = require('fs');
const path = require('path');
jest.setTimeout(120000);
const { crearDb } = require('./__fixtures__/pgliteCliente');

const MIGRACIONES_DIR = path.join(__dirname, '..', '..', '..', 'database', 'migrations');
const leer = (n) => fs.readFileSync(path.join(MIGRACIONES_DIR, n), 'utf8');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaCartillaInstitucional.sql'), 'utf8');

const MIGRACIONES_061_A_071 = [
    '061_cuentas_institucionales.sql', '062_delegados_asociacion.sql',
    '064_delegados_asociacion_certificado.sql', '065_cartillas_delegado_institucional.sql',
    '066_rpc_cartilla_institucional.sql', '067_control_transaccional_designacion_cartilla.sql',
    '068_seleccion_delegado_institucional_por_rodeo.sql', '069_responsable_unico_institucional.sql',
    '070_auditoria_transaccional_institucional.sql', '071_seguridad_tablas_rpc_institucionales.sql'
];
// 063 (alias Biobío) se omite en esta familia de fixtures desde la Fase 3.1:
// requiere `asociacion_alias`, tabla que este esquema mínimo nunca incluyó
// (mismo criterio ya usado en responsableUnicoInstitucional.rpc.test.js y
// auditoriaTransaccionalInstitucional.rpc.test.js).

async function construirDb(incluir072) {
    const db = crearDb();
    await db.exec(ESQUEMA);
    await db.exec(leer('037_cartilla_delegado.sql'));
    for (const m of MIGRACIONES_061_A_071) await db.exec(leer(m));
    if (incluir072) await db.exec(leer('072_correccion_check_estado_cartilla_reenviada.sql'));
    return db;
}

async function crearRodeoYCartillaBase(db) {
    const { rows: [r] } = await db.query("insert into rodeos (club, asociacion, fecha) values ('Club X','OSORNO','2026-09-18') returning id");
    const { rows: [u] } = await db.query("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('delegado_rentado','Rentado Prueba') returning id");
    const { rows: [c] } = await db.query(
        "insert into cartillas_delegado (rodeo_id, delegado_id, estado, version) values ($1,$2,'observada',1) returning id",
        [r.id, u.id]
    );
    return c.id;
}

describe('SIN la migración 072 (CHECK real de producción, confirmado): "reenviada" está bloqueado', () => {
    let db;
    beforeAll(async () => { db = await construirDb(false); });
    afterAll(async () => { await db.close(); });

    test('intentar guardar estado=\'reenviada\' FALLA con una violación real de CHECK — el defecto confirmado existe de verdad en este ensayo', async () => {
        const cartillaId = await crearRodeoYCartillaBase(db);
        await expect(
            db.query("update cartillas_delegado set estado='reenviada' where id=$1", [cartillaId])
        ).rejects.toThrow(/cartillas_delegado_estado_check/);
    });

    test('los 5 estados históricos SÍ siguen permitidos (el defecto es específico de "reenviada", no de todo el CHECK)', async () => {
        const cartillaId = await crearRodeoYCartillaBase(db);
        for (const estado of ['borrador', 'enviada', 'observada', 'aprobada', 'cerrada']) {
            await expect(db.query('update cartillas_delegado set estado=$1 where id=$2', [estado, cartillaId])).resolves.toBeDefined();
        }
    });
});

describe('CON la migración 072 aplicada: "reenviada" queda admitido, nunca se pierden los 5 estados históricos', () => {
    let db;
    beforeAll(async () => { db = await construirDb(true); });
    afterAll(async () => { await db.close(); });

    test('guardar estado=\'reenviada\' ahora funciona', async () => {
        const cartillaId = await crearRodeoYCartillaBase(db);
        const { rows } = await db.query("update cartillas_delegado set estado='reenviada' where id=$1 returning estado", [cartillaId]);
        expect(rows[0].estado).toBe('reenviada');
    });

    test('los 5 estados históricos siguen funcionando exactamente igual tras la corrección (compatibilidad con Delegado Rentado preservada)', async () => {
        const cartillaId = await crearRodeoYCartillaBase(db);
        for (const estado of ['borrador', 'enviada', 'observada', 'aprobada', 'cerrada']) {
            const { rows } = await db.query('update cartillas_delegado set estado=$1 where id=$2 returning estado', [estado, cartillaId]);
            expect(rows[0].estado).toBe(estado);
        }
    });

    test('un valor arbitrario fuera de los 6 permitidos SIGUE rechazado — el CHECK no se eliminó, solo se amplió', async () => {
        const cartillaId = await crearRodeoYCartillaBase(db);
        await expect(
            db.query("update cartillas_delegado set estado='valor_invalido' where id=$1", [cartillaId])
        ).rejects.toThrow(/cartillas_delegado_estado_check/);
    });

    test('el flujo real de envío/reenvío (RPC de la migración 070) funciona de punta a punta con el CHECK ya corregido', async () => {
        const { rows: [asoc] } = await db.query("insert into asociaciones (nombre, nombre_normalizado) values ('OSORNO','osorno') returning id");
        const { rows: [cuenta] } = await db.query("insert into cuentas_institucionales (email, password_hash, asociacion_id) values ('d@x.com','x',$1) returning id", [asoc.id]);
        const { rows: [del] } = await db.query("insert into delegados_asociacion (nombre, nombre_normalizado, asociacion_id, certificado) values ('Ana Soto','ana soto',$1,true) returning id", [asoc.id]);
        const { rows: [rodeo] } = await db.query("insert into rodeos (club, asociacion, fecha) values ('Club Y','OSORNO','2026-10-01') returning id");

        const cartilla = (await db.query(
            'select * from crear_o_adjuntar_cartilla_institucional($1,$2,$3,$4,$5,$6,$7)',
            [rodeo.id, del.id, 'Ana Soto', cuenta.id, '2026-2027', '2026-10-01', 'Provincial']
        )).rows[0];

        // Envío inicial.
        const enviada = (await db.query(
            'select * from actualizar_cartilla_institucional_con_auditoria($1,$2,$3,$4,$5,$6)',
            [cartilla.id, cartilla.version, JSON.stringify({ version: cartilla.version + 1, updated_at: new Date().toISOString(), estado: 'enviada', enviada_en: new Date().toISOString() }), cuenta.id, 'enviar', 'Envío']
        )).rows[0];
        expect(enviada.estado).toBe('enviada');

        // Se marca observada "a mano" (simulando la acción del admin, fuera del alcance de esta RPC).
        await db.query("update cartillas_delegado set estado='observada' where id=$1", [cartilla.id]);

        // Reenvío — exactamente el escenario que estaba roto antes de la 072.
        const reenviada = (await db.query(
            'select * from actualizar_cartilla_institucional_con_auditoria($1,$2,$3,$4,$5,$6)',
            [cartilla.id, enviada.version, JSON.stringify({ version: enviada.version + 1, updated_at: new Date().toISOString(), estado: 'reenviada', reenviada_en: new Date().toISOString() }), cuenta.id, 'enviar', 'Reenvío']
        )).rows[0];
        expect(reenviada.estado).toBe('reenviada');

        const eventos = (await db.query("select accion from auditoria where tabla='cartillas_delegado' and registro_id=$1 order by created_at asc", [cartilla.id])).rows;
        expect(eventos.map(e => e.accion)).toEqual(['crear', 'enviar', 'enviar']);
    });
});

describe('Confirmación del CHECK de auditoria.actor_tipo (ya correcto en 069, verificado contra el valor REAL confirmado en producción)', () => {
    let db;
    beforeAll(async () => {
        db = crearDb();
        await db.exec(ESQUEMA);
        await db.exec(leer('037_cartilla_delegado.sql'));
        // 069 define funciones RETURNS rodeos_delegado_institucional — ese tipo
        // compuesto solo existe una vez creada esa tabla (068, que a su vez
        // depende de 061/062). Se aplican ANTES de 069, sin tocar el CHECK de
        // auditoria todavía (ninguna de 061/062/064/065/068 lo toca).
        for (const m of ['061_cuentas_institucionales.sql', '062_delegados_asociacion.sql', '064_delegados_asociacion_certificado.sql', '065_cartillas_delegado_institucional.sql', '068_seleccion_delegado_institucional_por_rodeo.sql']) {
            await db.exec(leer(m));
        }
        // SIN 069 todavía: el CHECK real de producción confirmado (administrador, usuario_pagado) es
        // EXACTAMENTE el que ya trae el fixture base — se verifica primero que el defecto original existiría de verdad.
    });
    afterAll(async () => { await db.close(); });

    test('SIN 069: cuenta_institucional está bloqueado (coincide con el hallazgo original de la Fase 3.5)', async () => {
        await expect(
            db.query("insert into auditoria (tabla, registro_id, accion, actor_id, actor_tipo) values ('x','1','y','z','cuenta_institucional')")
        ).rejects.toThrow(/auditoria_actor_tipo_check/);
    });

    test('CON 069: administrador, usuario_pagado Y cuenta_institucional (los 3 confirmados) quedan permitidos; nada fuera de esos 3', async () => {
        await db.exec(leer('069_responsable_unico_institucional.sql'));
        for (const tipo of ['administrador', 'usuario_pagado', 'cuenta_institucional']) {
            await expect(
                db.query("insert into auditoria (tabla, registro_id, accion, actor_id, actor_tipo) values ('x',$1,'y','z',$2)", [tipo, tipo])
            ).resolves.toBeDefined();
        }
        await expect(
            db.query("insert into auditoria (tabla, registro_id, accion, actor_id, actor_tipo) values ('x','otro','y','z','valor_no_confirmado')")
        ).rejects.toThrow(/auditoria_actor_tipo_check/);
    });
});
