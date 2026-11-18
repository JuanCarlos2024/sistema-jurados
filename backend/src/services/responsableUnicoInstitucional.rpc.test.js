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

    // ── Cambio de Delegado de Asociación en Borrador (Admin → Rodeos) ──────
    // Conservación ÍNTEGRA del borrador: la RPC solo toca delegado_asociacion_id,
    // delegado_nombre, version y updated_at. Se compara la fila completa antes
    // y después, excluyendo exactamente esas 4 columnas.
    test('borrador COMPLETO -> conserva todas las respuestas (series, ganado, disciplina, accidentes, colleras, observaciones), estado Borrador y adjuntos; solo cambian responsable, nombre, versión y fecha', async () => {
        const rodeoId = await crearRodeo();
        await confirmar(rodeoId, ID.delA, 'Ana Soto');
        const respuestas = {
            series: [{ serie: 'Serie Caballos', ganado: 12, observacion: 'Ganado parejo' }],
            ganado: { bajo_peso: true, detalle: [{ serie: 'Potros', cantidad: 2 }] },
            informe_disciplinario: [{ nombre_infractor: 'Juan Pérez', rut: '11.111.111-1', tipo_falta: 'Grave', articulo: '45' }],
            accidentes: [{ tipo: 'Jinete', descripcion: 'Caída en la quincha', atendido: true }],
            colleras_invitadas: [{ caballo1: 'Lucero', caballo2: 'Estribo', jinetes: 'A / B' }],
            corre_premios: { aplica: true, colleras: [{ caballo1: 'Rayo', puntaje: 12 }] },
            deja_puntos_temporada: { aplica: true, colleras: [{ caballo1: 'Trueno', puntaje: 9 }] },
            observaciones: 'Rodeo con lluvia; ñandú "N°1" — tildes áéíóú'
        };
        const cartilla = (await q(
            `insert into cartillas_delegado (rodeo_id, delegado_asociacion_id, delegado_nombre, version, estado,
                temporada, fecha_rodeo, delegado_telefono, secretario_jurado, secretario_numero_socio,
                club_asociacion_organizador, tipo_rodeo, serie_campeones_dos_vueltas, incluye_informe_disciplinario,
                incluye_informe_ganado_bajo_peso, certificacion_medialuna_comuna, respuestas_json)
             values ($1,$2,'Ana Soto',4,'borrador','2026-2027','2026-11-14','+56911111111','Secretario X','123',
                'VALPARAÍSO','Provincial',true,true,true,true,$3) returning *`,
            [rodeoId, ID.delA, JSON.stringify(respuestas)]
        ))[0];
        await q(`insert into rodeo_adjuntos (rodeo_id, tipo_adjunto, nombre_archivo, storage_path, mime_type)
                 values ($1,'cartilla_delegado','foto.jpg',$2,'image/jpeg')`, [rodeoId, `ruta/foto-${rodeoId}.jpg`]);

        await reemplazar(rodeoId, ID.delB, 'Bruno Diaz', 'La asociación seleccionó por error al delegado equivocado');

        const despues = (await q('select * from cartillas_delegado where id=$1', [cartilla.id]))[0];
        const CAMBIAN = ['delegado_asociacion_id', 'delegado_nombre', 'version', 'updated_at'];
        for (const col of Object.keys(cartilla)) {
            if (CAMBIAN.includes(col)) continue;
            expect({ col, valor: despues[col] }).toEqual({ col, valor: cartilla[col] });
        }
        expect(despues.respuestas_json).toEqual(respuestas);
        expect(despues.estado).toBe('borrador');
        expect(despues.delegado_asociacion_id).toBe(ID.delB);
        expect(despues.delegado_nombre).toBe('Bruno Diaz');
        expect(despues.version).toBe(5);
        expect(new Date(despues.updated_at) >= new Date(cartilla.updated_at)).toBe(true);
        const adj = await q('select count(*) c from rodeo_adjuntos where rodeo_id=$1', [rodeoId]);
        expect(Number(adj[0].c)).toBe(1);
        const total = await q('select count(*) c from cartillas_delegado where rodeo_id=$1', [rodeoId]);
        expect(Number(total[0].c)).toBe(1);
    });

    test('auditoría del reemplazo: delegado anterior (id) y nuevo (id + nombre), rodeo (vía designación), administrador, fecha y motivo — en la misma transacción', async () => {
        const rodeoId = await crearRodeo();
        const desig = await confirmar(rodeoId, ID.delA, 'Ana Soto');
        await q(`insert into cartillas_delegado (rodeo_id, delegado_asociacion_id, delegado_nombre, version, estado)
                 values ($1,$2,'Ana Soto',1,'borrador')`, [rodeoId, ID.delA]);
        await reemplazar(rodeoId, ID.delB, 'Bruno Diaz', 'Error de la asociación');
        const ev = (await q("select * from auditoria where accion='reemplazar_responsable_institucional' and registro_id=$1", [desig.id]))[0];
        expect(ev.datos_anteriores).toEqual({ delegado_asociacion_id: ID.delA });
        expect(ev.datos_nuevos).toMatchObject({ delegado_asociacion_id: ID.delB, delegado_nombre: 'Bruno Diaz', motivo: 'Error de la asociación' });
        expect(ev.actor_id).toBe(ID.admin);
        expect(ev.actor_tipo).toBe('administrador');
        expect(ev.created_at).toBeTruthy();
        const fila = (await q('select rodeo_id from rodeos_delegado_institucional where id=$1', [desig.id]))[0];
        expect(fila.rodeo_id).toBe(rodeoId);
        // registros históricos previos intactos: el evento de confirmación sigue igual
        const conf = await q("select * from auditoria where accion='confirmar_responsable_institucional' and registro_id=$1", [desig.id]);
        expect(conf).toHaveLength(1);
        expect(conf[0].datos_nuevos.delegado_nombre).toBe('Ana Soto');
    });

    test('Delegado Rentado NO afectado: su cartilla del mismo rodeo queda idéntica', async () => {
        const rodeoId = await crearRodeo();
        await confirmar(rodeoId, ID.delA, 'Ana Soto');
        const up = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('delegado_rentado','Rentado Uno') returning id"))[0].id;
        const rentado = (await q(
            `insert into cartillas_delegado (rodeo_id, delegado_id, delegado_nombre, version, estado, respuestas_json)
             values ($1,$2,'Rentado Uno',3,'borrador','{"x":1}') returning *`, [rodeoId, up]
        ))[0];
        await q(`insert into cartillas_delegado (rodeo_id, delegado_asociacion_id, delegado_nombre, version, estado)
                 values ($1,$2,'Ana Soto',1,'borrador')`, [rodeoId, ID.delA]);
        await reemplazar(rodeoId, ID.delB, 'Bruno Diaz', 'motivo');
        const despues = (await q('select * from cartillas_delegado where id=$1', [rentado.id]))[0];
        expect(despues).toEqual(rentado);
    });

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
