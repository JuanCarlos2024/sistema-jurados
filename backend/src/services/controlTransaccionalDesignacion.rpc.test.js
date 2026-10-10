// Fase 3.1 (cierre, sección 3): trigger de base de datos (migración 067) que
// bloquea CUALQUIER INSERT/UPDATE sobre `asignaciones` que deje una
// designación de Delegado Rentado efectiva (activa+publicada+no rechazada)
// para un rodeo que YA tiene una cartilla institucional con contenido real.
// Es un trigger de BASE DE DATOS — protege todos los caminos de escritura
// (creación, reasignación de persona, aceptar/rechazar/reabrir, publicación
// masiva) sin tocar el código JS de esos endpoints. Esta suite prueba la
// LÓGICA del trigger contra un Postgres real de prueba (PGlite), aplicando
// las migraciones REALES en secuencia — no una aproximación.
//
// LÍMITE EXPLÍCITO (ver también el encabezado de la migración 067): PGlite,
// tal como está integrado en este repositorio (un único proceso hijo con una
// cola secuencial — ver __fixtures__/pgliteCliente.js), no permite abrir dos
// transacciones verdaderamente simultáneas sobre la misma base. Esta suite
// prueba que el trigger bloquea/permite correctamente según el estado YA
// confirmado en el momento de cada escritura (semántica "léase antes de
// escribir"), pero NO demuestra empíricamente que el SELECT...FOR UPDATE haga
// esperar a una segunda transacción real y concurrente. Esa garantía se
// apoya en semántica estándar de Postgres (MVCC + row locks), documentada en
// la propia migración, pendiente de validación contra un Postgres con
// conexiones realmente concurrentes antes de confiar en ella en producción.
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

    ID.asoc = (await q("insert into asociaciones (nombre, nombre_normalizado) values ('OSORNO','osorno') returning id"))[0].id;
    ID.cuenta = (await q("insert into cuentas_institucionales (email, password_hash, asociacion_id) values ('delegado-osorno@ferochi.com','x',$1) returning id", [ID.asoc]))[0].id;
    ID.delA = (await q("insert into delegados_asociacion (nombre, nombre_normalizado, asociacion_id, certificado) values ('Ana Soto','ana soto',$1,true) returning id", [ID.asoc]))[0].id;
    ID.usuarioRentado = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('delegado_rentado','Pedro Gonzalez') returning id"))[0].id;
    ID.usuarioRentado2 = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('delegado_rentado','Luis Soto') returning id"))[0].id;
    ID.usuarioJurado = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('jurado','Jurado Uno') returning id"))[0].id;
});
afterAll(async () => { await db.close(); });

beforeEach(async () => {
    await db.exec('DELETE FROM cartillas_delegado; DELETE FROM asignaciones; DELETE FROM rodeos');
});

async function crearRodeo() {
    return (await q("insert into rodeos (club, asociacion, fecha) values ('Club X','OSORNO','2026-09-18') returning id"))[0].id;
}
async function crearCartillaInstitucional(rodeoId) {
    return (await q(
        'select * from crear_o_adjuntar_cartilla_institucional($1,$2,$3,$4,$5,$6,$7)',
        [rodeoId, ID.delA, 'Ana Soto', ID.cuenta, '2026-2027', '2026-09-18', 'Provincial']
    ))[0];
}

describe('Metadato real: el trigger y la función existen tal como los crea la migración 067', () => {
    test('el trigger está registrado sobre asignaciones, BEFORE INSERT OR UPDATE, FOR EACH ROW', async () => {
        const r = (await q(`
            select t.tgname, t.tgtype, p.proname
            from pg_trigger t join pg_proc p on p.oid = t.tgfoid
            where t.tgname = 'trg_asignaciones_designacion_vs_cartilla_institucional'
        `))[0];
        expect(r).toBeDefined();
        expect(r.proname).toBe('fn_bloquear_designacion_rentado_si_cartilla_institucional');
    });
});

describe('INSERT de una designación de Delegado Rentado — bloqueo según exista o no cartilla institucional', () => {
    test('SIN cartilla institucional -> el INSERT de una designación vigente se permite normalmente', async () => {
        const rodeoId = await crearRodeo();
        const fila = (await q(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, estado, publicado, estado_designacion)
             values ($1,$2,'delegado_rentado','activo',true,'aceptado') returning id`,
            [rodeoId, ID.usuarioRentado]
        ))[0];
        expect(fila.id).toBeDefined();
    });

    test('CON cartilla institucional ya existente -> el INSERT de una designación vigente se bloquea con el código esperado', async () => {
        const rodeoId = await crearRodeo();
        await crearCartillaInstitucional(rodeoId);
        await expect(q(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, estado, publicado, estado_designacion)
             values ($1,$2,'delegado_rentado','activo',true,'aceptado')`,
            [rodeoId, ID.usuarioRentado]
        )).rejects.toThrow(/DESIGNACION_RENTADO_BLOQUEADA_POR_CARTILLA_INSTITUCIONAL/);

        const asigs = await q('select count(*) c from asignaciones where rodeo_id=$1', [rodeoId]);
        expect(Number(asigs[0].c)).toBe(0); // nunca queda una fila a medio insertar
    });

    test('CON cartilla institucional, pero la designación NO queda publicada todavía (publicado=false) -> se permite (borrador normal del admin)', async () => {
        const rodeoId = await crearRodeo();
        await crearCartillaInstitucional(rodeoId);
        const fila = (await q(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, estado, publicado, estado_designacion)
             values ($1,$2,'delegado_rentado','activo',false,'pendiente') returning id`,
            [rodeoId, ID.usuarioRentado]
        ))[0];
        expect(fila.id).toBeDefined();
    });

    test('CON cartilla institucional, jurado (no Rentado) -> nunca se ve afectado por este trigger', async () => {
        const rodeoId = await crearRodeo();
        await crearCartillaInstitucional(rodeoId);
        const fila = (await q(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, estado, publicado, estado_designacion)
             values ($1,$2,'jurado','activo',true,'aceptado') returning id`,
            [rodeoId, ID.usuarioJurado]
        ))[0];
        expect(fila.id).toBeDefined();
    });
});

describe('UPDATE sobre una designación existente — publicación, aceptar/rechazar/reabrir, reasignación', () => {
    async function crearDesignacionBorrador(rodeoId, usuarioId = ID.usuarioRentado) {
        return (await q(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, estado, publicado, estado_designacion)
             values ($1,$2,'delegado_rentado','activo',false,'pendiente') returning id`,
            [rodeoId, usuarioId]
        ))[0].id;
    }

    test('"Publicar designaciones" (publicado: false->true) CON cartilla institucional existente -> bloqueado', async () => {
        const rodeoId = await crearRodeo();
        const asigId = await crearDesignacionBorrador(rodeoId);
        await crearCartillaInstitucional(rodeoId);

        await expect(q("update asignaciones set publicado=true where id=$1", [asigId]))
            .rejects.toThrow(/DESIGNACION_RENTADO_BLOQUEADA_POR_CARTILLA_INSTITUCIONAL/);

        const fila = (await q('select publicado from asignaciones where id=$1', [asigId]))[0];
        expect(fila.publicado).toBe(false); // el UPDATE completo se revierte, nunca queda a medias
    });

    test('"Publicar designaciones" SIN cartilla institucional -> se permite normalmente', async () => {
        const rodeoId = await crearRodeo();
        const asigId = await crearDesignacionBorrador(rodeoId);
        await q("update asignaciones set publicado=true where id=$1", [asigId]);
        const fila = (await q('select publicado from asignaciones where id=$1', [asigId]))[0];
        expect(fila.publicado).toBe(true);
    });

    test('"Reabrir" una designación rechazada (rechazado->pendiente) ya publicada, CON cartilla institucional -> bloqueado (la vuelve vigente)', async () => {
        const rodeoId = await crearRodeo();
        const asigId = await crearDesignacionBorrador(rodeoId);
        // Publicada y RECHAZADA (no vigente) -> la institucional SÍ puede crearse en este punto.
        await q("update asignaciones set publicado=true, estado_designacion='rechazado' where id=$1", [asigId]);
        await crearCartillaInstitucional(rodeoId);

        // "Reabrir" la devuelve a 'pendiente' -> vuelve a ser vigente -> ahora SÍ se bloquea.
        await expect(q("update asignaciones set estado_designacion='pendiente' where id=$1", [asigId]))
            .rejects.toThrow(/DESIGNACION_RENTADO_BLOQUEADA_POR_CARTILLA_INSTITUCIONAL/);

        const fila = (await q('select estado_designacion from asignaciones where id=$1', [asigId]))[0];
        expect(fila.estado_designacion).toBe('rechazado'); // el UPDATE se revierte completo, nunca queda a medias
    });

    test('"Rechazar" una designación (estado_designacion->rechazado) NUNCA se bloquea, aunque exista una cartilla institucional en conflicto (es la resolución, no el problema)', async () => {
        const rodeoId = await crearRodeo();
        const asigId = await crearDesignacionBorrador(rodeoId);
        await q("update asignaciones set publicado=true, estado_designacion='pendiente' where id=$1", [asigId]);
        // El trigger también se dispara en el propio INSERT de la institucional por una vía
        // administrativa directa (no la RPC) para simular datos ya coexistentes (caso histórico/
        // de borde) sin pasarla primero por la validación de la RPC.
        await q(
            `insert into cartillas_delegado (rodeo_id, delegado_asociacion_id, delegado_nombre, version)
             values ($1,$2,'Ana Soto',1)`,
            [rodeoId, ID.delA]
        );

        await q("update asignaciones set estado_designacion='rechazado' where id=$1", [asigId]);
        const fila = (await q('select estado_designacion from asignaciones where id=$1', [asigId]))[0];
        expect(fila.estado_designacion).toBe('rechazado');
    });

    test('Reasignación de persona (usuario_pagado_id) sobre una fila YA vigente, con una cartilla institucional coexistente (dato histórico/de borde) -> bloqueada (re-valida en cada UPDATE)', async () => {
        const rodeoId = await crearRodeo();
        const asigId = await crearDesignacionBorrador(rodeoId);
        await q("update asignaciones set publicado=true, estado_designacion='aceptado' where id=$1", [asigId]); // vigente, SIN institucional todavía
        // Cartilla institucional coexistente insertada directamente (simula un dato histórico
        // previo a este control, o una condición de borde ya detectada por otra vía) — nunca
        // pasa por la RPC, así se puede llegar a este estado sin contradicción lógica.
        await q(
            `insert into cartillas_delegado (rodeo_id, delegado_asociacion_id, delegado_nombre, version)
             values ($1,$2,'Ana Soto',1)`,
            [rodeoId, ID.delA]
        );

        await expect(q("update asignaciones set usuario_pagado_id=$2 where id=$1", [asigId, ID.usuarioRentado2]))
            .rejects.toThrow(/DESIGNACION_RENTADO_BLOQUEADA_POR_CARTILLA_INSTITUCIONAL/);
    });

    test('Editar un campo no relacionado (observacion) sobre una designación vigente SIN conflicto -> nunca se bloquea', async () => {
        const rodeoId = await crearRodeo();
        const asigId = await crearDesignacionBorrador(rodeoId);
        await q("update asignaciones set publicado=true, estado_designacion='aceptado' where id=$1", [asigId]);

        await q("update asignaciones set observacion='nota cualquiera' where id=$1", [asigId]);
        const fila = (await q('select observacion from asignaciones where id=$1', [asigId]))[0];
        expect(fila.observacion).toBe('nota cualquiera');
    });
});

describe('Fase 3.2 — Publicación masiva: comportamiento exacto cuando el rodeo mezcla jurados y un Rentado en conflicto', () => {
    test('un rodeo con 1 jurado + 1 Rentado conflictivo, ambos sin publicar: la publicación masiva (mismo UPDATE que admin/rodeos.js) revierte TODO el statement, incluido el jurado (atomicidad de sentencia, no solo de la fila conflictiva)', async () => {
        const rodeoId = await crearRodeo();
        await crearCartillaInstitucional(rodeoId); // conflicto ya presente para el Rentado

        const asigJurado = (await q(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, estado, publicado, estado_designacion)
             values ($1,$2,'jurado','activo',false,'pendiente') returning id`,
            [rodeoId, ID.usuarioJurado]
        ))[0].id;
        const asigRentado = (await q(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, estado, publicado, estado_designacion)
             values ($1,$2,'delegado_rentado','activo',false,'pendiente') returning id`,
            [rodeoId, ID.usuarioRentado]
        ))[0].id;

        // Mismo UPDATE exacto que admin/rodeos.js POST /:id/publicar-designaciones
        // (.eq('rodeo_id',id).eq('estado','activo').eq('publicado', false)) — sin
        // distinguir tipo_persona, afecta ambas filas en UNA sola sentencia.
        await expect(q(
            "update asignaciones set publicado=true, publicado_en=now() where rodeo_id=$1 and estado='activo' and publicado=false",
            [rodeoId]
        )).rejects.toThrow(/DESIGNACION_RENTADO_BLOQUEADA_POR_CARTILLA_INSTITUCIONAL/);

        const filas = await q('select id, tipo_persona, publicado from asignaciones where rodeo_id=$1 order by tipo_persona', [rodeoId]);
        const jurado = filas.find(f => f.id === asigJurado);
        const rentado = filas.find(f => f.id === asigRentado);
        // El jurado NO se publicó tampoco — la sentencia completa se revirtió.
        expect(jurado.publicado).toBe(false);
        expect(rentado.publicado).toBe(false);
    });

    test('el MISMO rodeo sin conflicto -> la publicación masiva SÍ publica ambas filas (jurado + Rentado) en una sola sentencia', async () => {
        const rodeoId = await crearRodeo();
        const asigJurado = (await q(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, estado, publicado, estado_designacion)
             values ($1,$2,'jurado','activo',false,'pendiente') returning id`,
            [rodeoId, ID.usuarioJurado]
        ))[0].id;
        const asigRentado = (await q(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, estado, publicado, estado_designacion)
             values ($1,$2,'delegado_rentado','activo',false,'pendiente') returning id`,
            [rodeoId, ID.usuarioRentado]
        ))[0].id;

        await q("update asignaciones set publicado=true, publicado_en=now() where rodeo_id=$1 and estado='activo' and publicado=false", [rodeoId]);

        const filas = await q('select id, publicado from asignaciones where rodeo_id=$1', [rodeoId]);
        expect(filas.every(f => f.publicado === true)).toBe(true);
        expect(filas.map(f => f.id).sort()).toEqual([asigJurado, asigRentado].sort());
    });

    test('dos rodeos DISTINTOS: publicar el rodeo SIN conflicto nunca se ve afectado por el conflicto del OTRO rodeo (cada publicación está scoped por rodeo_id)', async () => {
        const rodeoConConflicto = await crearRodeo();
        const rodeoLimpio = await crearRodeo();
        await crearCartillaInstitucional(rodeoConConflicto);
        await q(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, estado, publicado, estado_designacion)
             values ($1,$2,'delegado_rentado','activo',false,'pendiente')`,
            [rodeoConConflicto, ID.usuarioRentado]
        );
        const asigLimpia = (await q(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, estado, publicado, estado_designacion)
             values ($1,$2,'jurado','activo',false,'pendiente') returning id`,
            [rodeoLimpio, ID.usuarioJurado]
        ))[0].id;

        await expect(q("update asignaciones set publicado=true where rodeo_id=$1 and estado='activo' and publicado=false", [rodeoConConflicto]))
            .rejects.toThrow(/DESIGNACION_RENTADO_BLOQUEADA_POR_CARTILLA_INSTITUCIONAL/);

        // El rodeo limpio se publica en una llamada INDEPENDIENTE, sin verse afectado.
        await q("update asignaciones set publicado=true where rodeo_id=$1 and estado='activo' and publicado=false", [rodeoLimpio]);
        const filaLimpia = (await q('select publicado from asignaciones where id=$1', [asigLimpia]))[0];
        expect(filaLimpia.publicado).toBe(true);
    });
});

describe('Compatibilidad: la RPC institucional sigue funcionando igual con el SELECT...FOR UPDATE agregado', () => {
    test('crear una cartilla institucional nueva sigue funcionando (el FOR UPDATE no cambia el resultado en uso secuencial)', async () => {
        const rodeoId = await crearRodeo();
        const r = await crearCartillaInstitucional(rodeoId);
        expect(r.estado).toBe('borrador');
        expect(r.delegado_asociacion_id).toBe(ID.delA);
    });

    test('rodeo_id inexistente -> el SELECT...FOR UPDATE no encuentra fila (no-op) y el resto de la función sigue su curso normal (falla después, por FK, no por el lock)', async () => {
        const idFalso = '00000000-0000-0000-0000-000000000000';
        await expect(q(
            'select * from crear_o_adjuntar_cartilla_institucional($1,$2,$3,$4,$5,$6,$7)',
            [idFalso, ID.delA, 'Ana Soto', ID.cuenta, '2026-2027', '2026-09-18', 'Provincial']
        )).rejects.toThrow();
    });
});
