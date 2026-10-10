// RPC crear_o_adjuntar_cartilla_institucional (migración 066) sobre un
// Postgres REAL de prueba (PGlite) — aplica las migraciones REALES
// (037/061/062/064/065/066), no una aproximación. Única forma honesta de
// probar la unicidad/concurrencia "representativa del esquema real" pedida
// en la Fase 3, dado que la unicidad se garantiza con un índice único
// parcial de Postgres, no con un mock de Supabase en JS.
const fs = require('fs');
const path = require('path');
jest.setTimeout(120000);
const { crearDb } = require('./__fixtures__/pgliteCliente');

const MIGRACIONES_DIR = path.join(__dirname, '..', '..', '..', 'database', 'migrations');
const leer = (n) => fs.readFileSync(path.join(MIGRACIONES_DIR, n), 'utf8');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaCartillaInstitucional.sql'), 'utf8');

let db; const ID = {};
async function q(sql, p) { return (await db.query(sql, p)).rows; }

beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);
    await db.exec(leer('037_cartilla_delegado.sql'));
    await db.exec(leer('061_cuentas_institucionales.sql'));
    await db.exec(leer('062_delegados_asociacion.sql'));
    await db.exec(leer('064_delegados_asociacion_certificado.sql'));
    await db.exec(leer('065_cartillas_delegado_institucional.sql'));
    await db.exec(leer('066_rpc_cartilla_institucional.sql'));
    // Fase 3.1 (cierre): 067 reemplaza la función de 066 (CREATE OR REPLACE)
    // agregando el SELECT...FOR UPDATE — en un despliegue real las
    // migraciones se aplican acumulativamente, así que esta suite debe
    // seguir pasando IGUAL contra la versión final de la función, no contra
    // la de 066 sola (que ya no sería la que corre en producción).
    await db.exec(leer('067_control_transaccional_designacion_cartilla.sql'));

    ID.asoc = (await q("insert into asociaciones (nombre, nombre_normalizado) values ('OSORNO','osorno') returning id"))[0].id;
    ID.cuenta = (await q("insert into cuentas_institucionales (email, password_hash, asociacion_id) values ('delegado-osorno@ferochi.com','x',$1) returning id", [ID.asoc]))[0].id;
    ID.delA = (await q("insert into delegados_asociacion (nombre, nombre_normalizado, asociacion_id, certificado) values ('Ana Soto','ana soto',$1,true) returning id", [ID.asoc]))[0].id;
    ID.delB = (await q("insert into delegados_asociacion (nombre, nombre_normalizado, asociacion_id, certificado) values ('Bruno Diaz','bruno diaz',$1,true) returning id", [ID.asoc]))[0].id;
    ID.usuarioRentado = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('delegado_rentado','Pedro Gonzalez') returning id"))[0].id;
});
afterAll(async () => { await db.close(); });

beforeEach(async () => {
    await db.exec('DELETE FROM cartillas_delegado; DELETE FROM asignaciones; DELETE FROM rodeos');
});

async function crearRodeo() {
    return (await q("insert into rodeos (club, asociacion, fecha) values ('Club X','OSORNO','2026-09-18') returning id"))[0].id;
}
async function rpc(rodeoId, delegadoId, nombre = 'Ana Soto') {
    return (await q(
        'select * from crear_o_adjuntar_cartilla_institucional($1,$2,$3,$4,$5,$6,$7)',
        [rodeoId, delegadoId, nombre, ID.cuenta, '2026-2027', '2026-09-18', 'Provincial']
    ))[0];
}

describe('Esquema real (migración 065): conflicto delegado_id resuelto', () => {
    test('delegado_id ahora es NULLABLE (antes era NOT NULL — confirmado por lectura directa de 037)', async () => {
        const c = (await q("select is_nullable from information_schema.columns where table_name='cartillas_delegado' and column_name='delegado_id'"))[0];
        expect(c.is_nullable).toBe('YES');
    });

    test('CHECK chk_cartillas_delegado_origen_unico: rechaza fila con AMBOS delegado_id y delegado_asociacion_id', async () => {
        const rodeoId = await crearRodeo();
        await expect(q(
            'insert into cartillas_delegado (rodeo_id, delegado_id, delegado_asociacion_id) values ($1,$2,$3)',
            [rodeoId, ID.usuarioRentado, ID.delA]
        )).rejects.toThrow();
    });

    test('CHECK chk_cartillas_delegado_origen_unico: rechaza fila SIN NINGUNO de los dos', async () => {
        const rodeoId = await crearRodeo();
        await expect(q('insert into cartillas_delegado (rodeo_id) values ($1)', [rodeoId])).rejects.toThrow();
    });

    test('una cartilla de Delegado Rentado (solo delegado_id) sigue siendo válida (compatibilidad histórica)', async () => {
        const rodeoId = await crearRodeo();
        const fila = (await q('insert into cartillas_delegado (rodeo_id, delegado_id) values ($1,$2) returning *', [rodeoId, ID.usuarioRentado]))[0];
        expect(fila.delegado_id).toBe(ID.usuarioRentado);
        expect(fila.delegado_asociacion_id).toBeNull();
        expect(fila.version).toBe(1); // default aplicado también a filas de Delegado Rentado (aditivo, no usado por ese flujo todavía)
    });
});

describe('RPC crear_o_adjuntar_cartilla_institucional', () => {
    test('rodeo sin cartilla previa -> crea un borrador institucional nuevo, version=1, con temporada/fecha/tipo auto-completados', async () => {
        const rodeoId = await crearRodeo();
        const r = await rpc(rodeoId, ID.delA);
        expect(r.estado).toBe('borrador');
        expect(r.version).toBe(1);
        expect(r.delegado_asociacion_id).toBe(ID.delA);
        expect(r.delegado_id).toBeNull();
        expect(r.temporada).toBe('2026-2027');
        expect(r.tipo_rodeo).toBe('Provincial');
    });

    test('al cambiar de delegado responsable, temporada/fecha/tipo NO se vuelven a sobrescribir (siguen siendo los del rodeo, nunca se pierden)', async () => {
        const rodeoId = await crearRodeo();
        await rpc(rodeoId, ID.delA);
        const r2 = await rpc(rodeoId, ID.delB);
        expect(r2.temporada).toBe('2026-2027');
        expect(r2.tipo_rodeo).toBe('Provincial');
    });

    test('llamar de nuevo con OTRO delegado para el MISMO rodeo -> actualiza el MISMO registro (no crea un segundo borrador)', async () => {
        const rodeoId = await crearRodeo();
        const r1 = await rpc(rodeoId, ID.delA, 'Ana Soto');
        const r2 = await rpc(rodeoId, ID.delB, 'Bruno Diaz');
        expect(r2.id).toBe(r1.id); // MISMO id, no una fila nueva
        expect(r2.delegado_asociacion_id).toBe(ID.delB);
        expect(r2.version).toBe(2);

        const total = await q('select count(*) c from cartillas_delegado where rodeo_id=$1', [rodeoId]);
        expect(Number(total[0].c)).toBe(1); // nunca 2 filas
    });

    test('ya existe una cartilla de Delegado Rentado para ese rodeo -> rechaza (CARTILLA_RENTADO_EXISTENTE), nunca la toca ni crea una paralela', async () => {
        const rodeoId = await crearRodeo();
        await q('insert into cartillas_delegado (rodeo_id, delegado_id) values ($1,$2)', [rodeoId, ID.usuarioRentado]);

        await expect(rpc(rodeoId, ID.delA)).rejects.toThrow(/CARTILLA_RENTADO_EXISTENTE/);

        // La cartilla del Delegado Rentado sigue intacta, y no se creó ninguna institucional.
        const filas = await q('select delegado_id, delegado_asociacion_id from cartillas_delegado where rodeo_id=$1', [rodeoId]);
        expect(filas).toHaveLength(1);
        expect(filas[0].delegado_id).toBe(ID.usuarioRentado);
    });

    test('cartilla institucional ya "enviada" -> rechaza el cambio de responsable (CARTILLA_BLOQUEADA_PARA_CAMBIO_DE_DELEGADO), no la reabre', async () => {
        const rodeoId = await crearRodeo();
        const creada = await rpc(rodeoId, ID.delA);
        await q("update cartillas_delegado set estado='enviada' where id=$1", [creada.id]);

        await expect(rpc(rodeoId, ID.delB)).rejects.toThrow(/CARTILLA_BLOQUEADA_PARA_CAMBIO_DE_DELEGADO/);

        const fila = (await q('select estado, delegado_asociacion_id, version from cartillas_delegado where id=$1', [creada.id]))[0];
        expect(fila.estado).toBe('enviada');
        expect(fila.delegado_asociacion_id).toBe(ID.delA); // no cambió
        expect(fila.version).toBe(1); // no se incrementó
    });

    test('CONCURRENCIA REAL: dos llamadas simultáneas para el mismo rodeo (delegados distintos) nunca duplican la fila', async () => {
        const rodeoId = await crearRodeo();
        const resultados = await Promise.allSettled([
            rpc(rodeoId, ID.delA, 'Ana Soto'),
            rpc(rodeoId, ID.delB, 'Bruno Diaz')
        ]);

        // Ambas deben resolver (ninguna debe fallar por violación de unicidad sin control: el ON CONFLICT
        // la absorbe como UPDATE) — si alguna fuera 'rejected' por un error de índice único SIN manejar,
        // sería la señal exacta de que la RPC no es realmente atómica.
        expect(resultados.every(r => r.status === 'fulfilled')).toBe(true);

        const filas = await q('select id, delegado_asociacion_id, version from cartillas_delegado where rodeo_id=$1', [rodeoId]);
        expect(filas).toHaveLength(1); // JAMÁS dos filas, sin importar el orden de llegada
        expect([ID.delA, ID.delB]).toContain(filas[0].delegado_asociacion_id); // una de las dos selecciones "ganó", consistente
        expect(filas[0].version).toBe(2); // create (v1) + un update (v2) — las dos llamadas se aplicaron en serie, nunca se perdió una
    });

    test('dos CREACIONES simultáneas (mismo delegado) para el mismo rodeo -> sigue siendo una sola fila', async () => {
        const rodeoId = await crearRodeo();
        const resultados = await Promise.allSettled([
            rpc(rodeoId, ID.delA, 'Ana Soto'),
            rpc(rodeoId, ID.delA, 'Ana Soto')
        ]);
        expect(resultados.every(r => r.status === 'fulfilled')).toBe(true);
        const filas = await q('select count(*) c from cartillas_delegado where rodeo_id=$1', [rodeoId]);
        expect(Number(filas[0].c)).toBe(1);
    });
});

describe('Fase 3.1 — designación EFECTIVA de Delegado Rentado (asignaciones), sin que exista todavía ninguna cartilla', () => {
    async function designar(rodeoId, { estado = 'activo', publicado = true, estado_designacion = 'aceptado' } = {}) {
        return (await q(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, estado, publicado, estado_designacion)
             values ($1,$2,'delegado_rentado',$3,$4,$5) returning id`,
            [rodeoId, ID.usuarioRentado, estado, publicado, estado_designacion]
        ))[0].id;
    }

    test('designación vigente (activo+publicado+aceptado), SIN cartilla aún -> bloquea con DELEGADO_RENTADO_DESIGNADO (escenario 1)', async () => {
        const rodeoId = await crearRodeo();
        await designar(rodeoId);

        await expect(rpc(rodeoId, ID.delA)).rejects.toThrow(/DELEGADO_RENTADO_DESIGNADO/);

        const filas = await q('select count(*) c from cartillas_delegado where rodeo_id=$1', [rodeoId]);
        expect(Number(filas[0].c)).toBe(0); // nunca se crea nada, ni institucional ni rentado
    });

    test('designación vigente con estado_designacion="pendiente" (aún sin responder) -> igual bloquea (pendiente cuenta como vigente)', async () => {
        const rodeoId = await crearRodeo();
        await designar(rodeoId, { estado_designacion: 'pendiente' });
        await expect(rpc(rodeoId, ID.delA)).rejects.toThrow(/DELEGADO_RENTADO_DESIGNADO/);
    });

    test('sin designación de Rentado -> la asociación puede crear la cartilla institucional (escenario 2)', async () => {
        const rodeoId = await crearRodeo();
        const r = await rpc(rodeoId, ID.delA);
        expect(r.estado).toBe('borrador');
    });

    test('designación RECHAZADA por el Rentado -> no cuenta como vigente, la asociación puede crear la cartilla (escenario 3)', async () => {
        const rodeoId = await crearRodeo();
        await designar(rodeoId, { estado_designacion: 'rechazado' });
        const r = await rpc(rodeoId, ID.delA);
        expect(r.estado).toBe('borrador');
    });

    test('designación ANULADA (estado=anulado) -> no cuenta como vigente, la asociación puede crear la cartilla (escenario 3)', async () => {
        const rodeoId = await crearRodeo();
        await designar(rodeoId, { estado: 'anulado' });
        const r = await rpc(rodeoId, ID.delA);
        expect(r.estado).toBe('borrador');
    });

    test('designación NO PUBLICADA todavía (publicado=false) -> no cuenta como vigente, igual que el autochequeo del propio Rentado', async () => {
        const rodeoId = await crearRodeo();
        await designar(rodeoId, { publicado: false });
        const r = await rpc(rodeoId, ID.delA);
        expect(r.estado).toBe('borrador');
    });

    test('cambio de designación DESPUÉS de iniciada la cartilla institucional: la designación de Rentado queda bloqueada DESDE SU PROPIO INSERT (Fase 3.1 cierre, trigger de 067) — nunca se confirma silenciosamente', async () => {
        const rodeoId = await crearRodeo();
        const institucional = await rpc(rodeoId, ID.delA);

        // El trigger de 067 bloquea el INSERT mismo de la designación (no hace falta
        // esperar a un segundo intento de operar la vía institucional): la designación
        // de Rentado NUNCA queda confirmada mientras exista una cartilla institucional
        // con contenido real para ese rodeo — requiere resolución administrativa.
        await expect(designar(rodeoId)).rejects.toThrow(/DESIGNACION_RENTADO_BLOQUEADA_POR_CARTILLA_INSTITUCIONAL/);

        // La cartilla institucional sigue existiendo intacta, sin eliminarse ni transferirse.
        const fila = (await q('select id, delegado_asociacion_id, delegado_id from cartillas_delegado where id=$1', [institucional.id]))[0];
        expect(fila.delegado_asociacion_id).toBe(ID.delA);
        expect(fila.delegado_id).toBeNull();

        // Y, por supuesto, ninguna fila de asignaciones quedó creada.
        const asigs = await q('select count(*) c from asignaciones where rodeo_id=$1', [rodeoId]);
        expect(Number(asigs[0].c)).toBe(0);
    });

    test('designación anulada DESPUÉS de haber bloqueado la creación institucional -> deja de bloquear (la asociación puede crear la cartilla)', async () => {
        const rodeoId = await crearRodeo();
        const asigId = await designar(rodeoId);
        await expect(rpc(rodeoId, ID.delA)).rejects.toThrow(/DELEGADO_RENTADO_DESIGNADO/);

        await q("update asignaciones set estado='anulado' where id=$1", [asigId]);

        const r = await rpc(rodeoId, ID.delA);
        expect(r.estado).toBe('borrador');
    });

    test('CONCURRENCIA REAL: designación de Rentado se inserta y se confirma (commit) justo antes de la llamada RPC -> la RPC ve el estado ya confirmado y bloquea (lectura consistente, no una condición de carrera silenciosa)', async () => {
        const rodeoId = await crearRodeo();
        await designar(rodeoId);
        const resultados = await Promise.allSettled([
            rpc(rodeoId, ID.delA),
            rpc(rodeoId, ID.delB)
        ]);
        expect(resultados.every(r => r.status === 'rejected')).toBe(true);
        resultados.forEach(r => expect(r.reason.message).toMatch(/DELEGADO_RENTADO_DESIGNADO/));

        const filas = await q('select count(*) c from cartillas_delegado where rodeo_id=$1', [rodeoId]);
        expect(Number(filas[0].c)).toBe(0);
    });
});

describe('Índice único parcial (metadato real, no inferido)', () => {
    test('uq_cartillas_delegado_rodeo_institucional existe y es parcial (tiene cláusula WHERE)', async () => {
        const r = (await q("select indexdef from pg_indexes where indexname='uq_cartillas_delegado_rodeo_institucional'"))[0];
        expect(r).toBeDefined();
        expect(r.indexdef).toMatch(/WHERE/i);
        expect(r.indexdef).toMatch(/delegado_asociacion_id/);
    });
});
