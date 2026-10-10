// Fase 3.5 — "un único responsable confirmado por rodeo" contra un
// PostgreSQL REAL de prueba (PGlite), aplicando las migraciones REALES en
// secuencia (037, 061-069) — no una aproximación. Prueba:
//   1. Confirmación atómica (INSERT...ON CONFLICT DO NOTHING) y su auditoría.
//   2. CONCURRENCIA REAL entre dos confirmaciones con delegados distintos
//      para el mismo rodeo (Promise.allSettled sobre el motor real).
//   3. Reemplazo administrativo autorizado: motivo, bloqueo en estados
//      terminales, sincronización atómica con cartillas_delegado.
//   4. El CHECK de auditoria.actor_tipo ahora acepta 'cuenta_institucional'
//      (hallazgo crítico corregido en esta misma fase).
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
    await db.exec(leer('067_control_transaccional_designacion_cartilla.sql'));
    await db.exec(leer('068_seleccion_delegado_institucional_por_rodeo.sql'));
    await db.exec(leer('069_responsable_unico_institucional.sql'));

    ID.asoc = (await q("insert into asociaciones (nombre, nombre_normalizado) values ('OSORNO','osorno') returning id"))[0].id;
    ID.cuenta = (await q("insert into cuentas_institucionales (email, password_hash, asociacion_id) values ('delegado-osorno@ferochi.com','x',$1) returning id", [ID.asoc]))[0].id;
    ID.delA = (await q("insert into delegados_asociacion (nombre, nombre_normalizado, asociacion_id, certificado) values ('Ana Soto','ana soto',$1,true) returning id", [ID.asoc]))[0].id;
    ID.delB = (await q("insert into delegados_asociacion (nombre, nombre_normalizado, asociacion_id, certificado) values ('Bruno Diaz','bruno diaz',$1,true) returning id", [ID.asoc]))[0].id;
    ID.admin = '00000000-0000-0000-0000-00000000add1';
});
afterAll(async () => { await db.close(); });

beforeEach(async () => {
    await db.exec('DELETE FROM auditoria; DELETE FROM cartillas_delegado; DELETE FROM rodeos_delegado_institucional; DELETE FROM asignaciones; DELETE FROM rodeos');
});

async function crearRodeo() {
    return (await q("insert into rodeos (club, asociacion, fecha) values ('Club X','OSORNO','2026-09-18') returning id"))[0].id;
}
async function confirmar(rodeoId, delegadoId, nombre) {
    return (await q(
        'select * from confirmar_delegado_institucional_rodeo($1,$2,$3,$4)',
        [rodeoId, delegadoId, nombre, ID.cuenta]
    ))[0];
}
async function reemplazar(rodeoId, nuevoDelegadoId, nuevoNombre, motivo) {
    return (await q(
        'select * from reemplazar_delegado_institucional_rodeo($1,$2,$3,$4,$5)',
        [rodeoId, nuevoDelegadoId, nuevoNombre, ID.admin, motivo]
    ))[0];
}

describe('Hallazgo crítico corregido: auditoria.actor_tipo ahora acepta cuenta_institucional', () => {
    test('un INSERT directo con actor_tipo=cuenta_institucional ya NO viola el CHECK', async () => {
        await expect(q(
            "insert into auditoria (tabla, registro_id, accion, actor_id, actor_tipo) values ('x','1','y','z','cuenta_institucional')"
        )).resolves.toBeDefined();
    });

    test('actor_tipo con un valor arbitrario (no en la lista) SIGUE rechazado — el CHECK no se eliminó, solo se amplió', async () => {
        await expect(q(
            "insert into auditoria (tabla, registro_id, accion, actor_id, actor_tipo) values ('x','1','y','z','valor_invalido')"
        )).rejects.toThrow();
    });
});

describe('confirmar_delegado_institucional_rodeo — confirmación atómica', () => {
    test('primera confirmación -> crea la fila y audita "confirmar_responsable_institucional"', async () => {
        const rodeoId = await crearRodeo();
        const r = await confirmar(rodeoId, ID.delA, 'Ana Soto');
        expect(r.delegado_asociacion_id).toBe(ID.delA);

        const eventos = await q("select * from auditoria where tabla='rodeos_delegado_institucional' and registro_id=$1", [r.id]);
        expect(eventos).toHaveLength(1);
        expect(eventos[0].accion).toBe('confirmar_responsable_institucional');
        expect(eventos[0].actor_tipo).toBe('cuenta_institucional');
    });

    test('re-confirmar el MISMO delegado -> devuelve la MISMA fila, NUNCA audita un segundo evento', async () => {
        const rodeoId = await crearRodeo();
        const r1 = await confirmar(rodeoId, ID.delA, 'Ana Soto');
        const r2 = await confirmar(rodeoId, ID.delA, 'Ana Soto');
        expect(r2.id).toBe(r1.id);

        const eventos = await q("select * from auditoria where tabla='rodeos_delegado_institucional' and registro_id=$1", [r1.id]);
        expect(eventos).toHaveLength(1); // nunca un segundo evento de confirmación
    });

    test('confirmar con OTRO delegado sobre un rodeo YA confirmado -> devuelve el YA vigente, nunca lo sobrescribe', async () => {
        const rodeoId = await crearRodeo();
        const r1 = await confirmar(rodeoId, ID.delA, 'Ana Soto');
        const r2 = await confirmar(rodeoId, ID.delB, 'Bruno Diaz');
        expect(r2.id).toBe(r1.id);
        expect(r2.delegado_asociacion_id).toBe(ID.delA); // sigue siendo Ana, nunca Bruno

        const filas = await q('select count(*) c from rodeos_delegado_institucional where rodeo_id=$1', [rodeoId]);
        expect(Number(filas[0].c)).toBe(1); // nunca dos filas
        const eventos = await q("select * from auditoria where tabla='rodeos_delegado_institucional' and registro_id=$1", [r1.id]);
        expect(eventos).toHaveLength(1); // el intento de Bruno NUNCA se auditó como confirmación
    });

    test('CONCURRENCIA REAL: dos confirmaciones simultáneas con delegados DISTINTOS para el mismo rodeo -> una sola fila, un solo evento de confirmación', async () => {
        const rodeoId = await crearRodeo();
        const resultados = await Promise.allSettled([
            confirmar(rodeoId, ID.delA, 'Ana Soto'),
            confirmar(rodeoId, ID.delB, 'Bruno Diaz')
        ]);
        expect(resultados.every(r => r.status === 'fulfilled')).toBe(true);

        const filas = await q('select id, delegado_asociacion_id from rodeos_delegado_institucional where rodeo_id=$1', [rodeoId]);
        expect(filas).toHaveLength(1); // JAMÁS dos responsables simultáneos
        expect([ID.delA, ID.delB]).toContain(filas[0].delegado_asociacion_id);

        const eventos = await q("select * from auditoria where tabla='rodeos_delegado_institucional' and registro_id=$1", [filas[0].id]);
        expect(eventos).toHaveLength(1); // solo UNA de las dos ganó y se auditó
    });

    test('confirmar para rodeos DISTINTOS es independiente (nunca se cruzan)', async () => {
        const rodeo1 = await crearRodeo();
        const rodeo2 = await crearRodeo();
        await confirmar(rodeo1, ID.delA, 'Ana Soto');
        await confirmar(rodeo2, ID.delB, 'Bruno Diaz');
        const f1 = (await q('select delegado_asociacion_id from rodeos_delegado_institucional where rodeo_id=$1', [rodeo1]))[0];
        const f2 = (await q('select delegado_asociacion_id from rodeos_delegado_institucional where rodeo_id=$1', [rodeo2]))[0];
        expect(f1.delegado_asociacion_id).toBe(ID.delA);
        expect(f2.delegado_asociacion_id).toBe(ID.delB);
    });
});

describe('reemplazar_delegado_institucional_rodeo — reemplazo administrativo autorizado', () => {
    test('motivo vacío -> MOTIVO_REQUERIDO, nunca reemplaza', async () => {
        const rodeoId = await crearRodeo();
        await confirmar(rodeoId, ID.delA, 'Ana Soto');
        await expect(reemplazar(rodeoId, ID.delB, 'Bruno Diaz', '')).rejects.toThrow(/MOTIVO_REQUERIDO/);
        await expect(reemplazar(rodeoId, ID.delB, 'Bruno Diaz', '   ')).rejects.toThrow(/MOTIVO_REQUERIDO/);

        const fila = (await q('select delegado_asociacion_id from rodeos_delegado_institucional where rodeo_id=$1', [rodeoId]))[0];
        expect(fila.delegado_asociacion_id).toBe(ID.delA); // nunca cambió
    });

    test('sin designación previa -> SIN_DESIGNACION_PREVIA', async () => {
        const rodeoId = await crearRodeo();
        await expect(reemplazar(rodeoId, ID.delB, 'Bruno Diaz', 'motivo válido')).rejects.toThrow(/SIN_DESIGNACION_PREVIA/);
    });

    test('sin cartilla todavía -> reemplaza solo la designación, audita con motivo y administrador', async () => {
        const rodeoId = await crearRodeo();
        const original = await confirmar(rodeoId, ID.delA, 'Ana Soto');
        const r = await reemplazar(rodeoId, ID.delB, 'Bruno Diaz', 'Juan no puede continuar por motivos de salud');
        expect(r.id).toBe(original.id); // MISMO registro, nunca uno nuevo
        expect(r.delegado_asociacion_id).toBe(ID.delB);

        const evento = (await q("select * from auditoria where tabla='rodeos_delegado_institucional' and accion='reemplazar_responsable_institucional' and registro_id=$1", [r.id]))[0];
        expect(evento.actor_tipo).toBe('administrador');
        expect(evento.actor_id).toBe(ID.admin);
        expect(evento.datos_nuevos.motivo).toBe('Juan no puede continuar por motivos de salud');
        expect(evento.datos_anteriores.delegado_asociacion_id).toBe(ID.delA);
    });

    test('cartilla en borrador -> reemplaza la designación Y sincroniza la cartilla (mismo id, version incrementada, nunca una segunda cartilla)', async () => {
        const rodeoId = await crearRodeo();
        await confirmar(rodeoId, ID.delA, 'Ana Soto');
        const cartilla = (await q(
            `insert into cartillas_delegado (rodeo_id, delegado_asociacion_id, delegado_nombre, version, estado)
             values ($1,$2,'Ana Soto',1,'borrador') returning id`,
            [rodeoId, ID.delA]
        ))[0];

        await reemplazar(rodeoId, ID.delB, 'Bruno Diaz', 'reemplazo autorizado de prueba');

        const cartillaFinal = (await q('select id, delegado_asociacion_id, delegado_nombre, version from cartillas_delegado where id=$1', [cartilla.id]))[0];
        expect(cartillaFinal.delegado_asociacion_id).toBe(ID.delB);
        expect(cartillaFinal.delegado_nombre).toBe('Bruno Diaz');
        expect(cartillaFinal.version).toBe(2);

        const total = await q('select count(*) c from cartillas_delegado where rodeo_id=$1', [rodeoId]);
        expect(Number(total[0].c)).toBe(1); // nunca una segunda cartilla
    });

    // 'reenviada' se excluye deliberadamente: aparece como mención defensiva en
    // comentarios/WHERE NOT IN de las migraciones 066/067, pero el CHECK real de
    // cartillas_delegado.estado (migración 037) nunca lo admitió como valor —
    // intentar insertarlo aquí viola ese CHECK, confirmando que hoy no es un
    // estado alcanzable; no se amplía el CHECK porque está fuera del alcance
    // mínimo de esta fase.
    test.each(['enviada', 'aprobada', 'cerrada'])(
        'cartilla en estado "%s" -> REEMPLAZO_REQUIERE_PROCEDIMIENTO_ESPECIAL, nunca reemplaza (procedimiento no definido todavía)',
        async (estado) => {
            const rodeoId = await crearRodeo();
            await confirmar(rodeoId, ID.delA, 'Ana Soto');
            await q(
                `insert into cartillas_delegado (rodeo_id, delegado_asociacion_id, delegado_nombre, version, estado)
                 values ($1,$2,'Ana Soto',1,$3)`,
                [rodeoId, ID.delA, estado]
            );

            await expect(reemplazar(rodeoId, ID.delB, 'Bruno Diaz', 'motivo válido')).rejects.toThrow(/REEMPLAZO_REQUIERE_PROCEDIMIENTO_ESPECIAL/);

            const fila = (await q('select delegado_asociacion_id from rodeos_delegado_institucional where rodeo_id=$1', [rodeoId]))[0];
            expect(fila.delegado_asociacion_id).toBe(ID.delA); // nunca cambió
            const cartillaFinal = (await q('select delegado_asociacion_id from cartillas_delegado where rodeo_id=$1', [rodeoId]))[0];
            expect(cartillaFinal.delegado_asociacion_id).toBe(ID.delA); // tampoco la cartilla
        }
    );

    test('cartilla en estado "observada" -> SÍ permite el reemplazo (no es un estado terminal)', async () => {
        const rodeoId = await crearRodeo();
        await confirmar(rodeoId, ID.delA, 'Ana Soto');
        await q(
            `insert into cartillas_delegado (rodeo_id, delegado_asociacion_id, delegado_nombre, version, estado)
             values ($1,$2,'Ana Soto',1,'observada')`,
            [rodeoId, ID.delA]
        );
        const r = await reemplazar(rodeoId, ID.delB, 'Bruno Diaz', 'motivo válido');
        expect(r.delegado_asociacion_id).toBe(ID.delB);
    });
});
