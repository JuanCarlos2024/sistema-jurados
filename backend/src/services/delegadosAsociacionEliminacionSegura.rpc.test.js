// Verificación previa a publicación — módulo administrativo de Delegados de
// Asociación: contra un Postgres REAL (PGlite), no contra mocks, se prueba:
//
//   1. La FK de cartillas_delegado.delegado_asociacion_id es REALMENTE
//      ON DELETE RESTRICT (ya no SET NULL) — un DELETE crudo con una
//      cartilla vinculada falla de verdad con una violación de FK.
//   2/3. eliminar_delegado_asociacion_con_auditoria bloquea de verdad con
//      DELEGADO_TIENE_HISTORIAL ante una cartilla o un responsable
//      confirmado (rodeos_delegado_institucional).
//   4. Elimina + audita atómicamente cuando no hay referencias.
//   5. Las DOS secuencias posibles de una carrera (la referencia se crea
//      ANTES de intentar eliminar / el delegado se elimina y DESPUÉS se
//      intenta referenciar un id que ya no existe) son ambas seguras — ver
//      nota más abajo sobre por qué no se simula una colisión EXACTAMENTE
//      simultánea.
//   6. Si el INSERT en auditoria falla (simulado con un trigger), TODA la
//      operación (crear/suspender/reactivar/eliminar) se revierte — nunca
//      queda aplicada sin su registro de auditoría.
//
// NOTA sobre el límite real de esta herramienta: PGlite es un único backend
// de Postgres embebido en un solo proceso (services/__fixtures__/
// pgliteServidor.js procesa un mensaje a la vez, en cola) — no modela dos
// conexiones/transacciones verdaderamente simultáneas con bloqueo real por
// lock, como sí ocurre en un Postgres real con dos sesiones. Por eso esta
// prueba no simula una colisión exactamente simultánea con dos clientes en
// paralelo (requeriría un Postgres real multi-sesión, como el ensayo
// aislado con embedded-postgres usado en fases anteriores de este mismo
// proyecto, pero fuera del repositorio — agregar esa dependencia pesada al
// conjunto de pruebas versionado sería un cambio no mínimo). En su lugar se
// demuestra la propiedad más fuerte y SUFICIENTE: las dos únicas secuencias
// posibles en las que podría resolverse una carrera real (referencia creada
// antes de que el DELETE comience a ejecutarse vs. después de que ya
// comprometió) son, cada una, seguras — lo cual, combinado con el lock
// FOR UPDATE dentro de la RPC (que en un Postgres real serializa cualquier
// intento concurrente contra esas mismas dos secuencias, nunca una tercera),
// cubre el espacio completo de resultados posibles.
jest.setTimeout(120000);
const fs = require('fs');
const path = require('path');
const { crearDb } = require('./__fixtures__/pgliteCliente');

const MIGRACIONES_DIR = path.join(__dirname, '..', '..', '..', 'database', 'migrations');
const leer = (n) => fs.readFileSync(path.join(MIGRACIONES_DIR, n), 'utf8');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaCartillaInstitucional.sql'), 'utf8');

const MIGRACIONES = [
    '061_cuentas_institucionales.sql',
    '062_delegados_asociacion.sql',
    '064_delegados_asociacion_certificado.sql',
    '065_cartillas_delegado_institucional.sql',
    '068_seleccion_delegado_institucional_por_rodeo.sql',
    '073_eliminacion_segura_y_auditoria_transaccional_delegados_asociacion.sql'
];

let db;
let ADMIN_ID; // auditoria.actor_id es TEXT NOT NULL: todas las llamadas que
// esperan llegar hasta el INSERT en auditoria necesitan un admin real (no
// null), igual que en producción (req.usuario.id siempre viene poblado).
beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);
    await db.exec(leer('037_cartilla_delegado.sql'));
    for (const m of MIGRACIONES) await db.exec(leer(m));

    const { rows } = await db.query("insert into administradores (nombre_completo) values ('Admin de Prueba') returning id");
    ADMIN_ID = rows[0].id;

    // Fixture de prueba (no es parte de ninguna migración real): en Supabase
    // real, service_role ya tiene acceso amplio por defecto a las tablas
    // preexistentes (auditoria, cartillas_delegado) sin que ninguna
    // migración de este proyecto lo otorgue explícitamente — 071 solo
    // documenta que NO las toca. Este GRANT reproduce ese mismo default de
    // la plataforma dentro del fixture mínimo de PGlite, que no lo trae
    // incorporado por no ejecutar 071 completa (fuera del alcance de esta
    // prueba, que solo valida 073).
    await db.exec(`GRANT ALL ON TABLE delegados_asociacion, auditoria, cartillas_delegado, rodeos_delegado_institucional, asociaciones, administradores TO service_role;`);

    // Trigger de PRUEBA (no forma parte de ninguna migración real): simula
    // un fallo real del INSERT en auditoria cuando la descripción contiene
    // un marcador — único mecanismo determinístico para forzar ese fallo
    // sin depender de permisos/roles reales.
    await db.exec(`
        CREATE OR REPLACE FUNCTION _fallar_auditoria_test() RETURNS TRIGGER AS $$
        BEGIN
            IF NEW.descripcion LIKE '%__FORZAR_FALLO_AUDITORIA__%' THEN
                RAISE EXCEPTION 'FALLO_SIMULADO_AUDITORIA';
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER trg_fallar_auditoria_test BEFORE INSERT ON auditoria
            FOR EACH ROW EXECUTE FUNCTION _fallar_auditoria_test();
    `);
});
afterAll(async () => { await db.close(); });

let seq = 0;
async function crearAsociacion(nombre = 'OSORNO') {
    seq++;
    const { rows } = await db.query(
        "insert into asociaciones (nombre, nombre_normalizado, activa) values ($1,$2,true) returning id",
        [nombre + '_' + seq, (nombre + '_' + seq).toLowerCase()]
    );
    return rows[0].id;
}
async function crearDelegado(asociacionId, nombre = 'Ana Soto', certificado = true) {
    seq++;
    const nombreUnico = nombre + ' ' + seq;
    const { rows } = await db.query(
        "insert into delegados_asociacion (nombre, nombre_normalizado, asociacion_id, certificado, activo) values ($1,$2,$3,$4,true) returning id",
        [nombreUnico, nombreUnico.toLowerCase(), asociacionId, certificado]
    );
    return { id: rows[0].id, nombre: nombreUnico };
}
async function crearRodeo(asociacionTexto = 'OSORNO') {
    seq++;
    const { rows } = await db.query(
        "insert into rodeos (club, asociacion, fecha) values ($1,$2,'2026-09-18') returning id",
        ['Club ' + seq, asociacionTexto]
    );
    return rows[0].id;
}
async function crearCartillaInstitucional(rodeoId, delegadoId) {
    await db.query(
        "insert into cartillas_delegado (rodeo_id, delegado_asociacion_id, estado, version) values ($1,$2,'borrador',1)",
        [rodeoId, delegadoId]
    );
}

describe('Riesgo 1a — la FK de cartillas_delegado.delegado_asociacion_id ya es RESTRICT (no SET NULL)', () => {
    test('un DELETE crudo sobre delegados_asociacion con una cartilla vinculada FALLA con una violación real de FK', async () => {
        const asoc = await crearAsociacion();
        const del = await crearDelegado(asoc);
        const rodeo = await crearRodeo();
        await crearCartillaInstitucional(rodeo, del.id);

        await expect(db.query('delete from delegados_asociacion where id=$1', [del.id]))
            .rejects.toThrow(/foreign key|violat/i);

        // La cartilla sigue intacta, con su responsable identificado — nunca
        // quedó en NULL silenciosamente (el efecto dañino original).
        const { rows } = await db.query('select delegado_asociacion_id from cartillas_delegado where rodeo_id=$1', [rodeo]);
        expect(rows[0].delegado_asociacion_id).toBe(del.id);
    });

    test('sin ninguna cartilla vinculada, el DELETE crudo SÍ funciona (la FK no es overprotectora)', async () => {
        const asoc = await crearAsociacion();
        const del = await crearDelegado(asoc);
        await expect(db.query('delete from delegados_asociacion where id=$1', [del.id])).resolves.toBeDefined();
    });
});

describe('Riesgo 1b — eliminar_delegado_asociacion_con_auditoria: Caso A vs Caso B', () => {
    test('Caso B: con cartilla vinculada -> RAISE DELEGADO_TIENE_HISTORIAL, no elimina', async () => {
        const asoc = await crearAsociacion();
        const del = await crearDelegado(asoc);
        const rodeo = await crearRodeo();
        await crearCartillaInstitucional(rodeo, del.id);

        await expect(
            db.query('select * from eliminar_delegado_asociacion_con_auditoria($1,$2)', [del.id, ADMIN_ID])
        ).rejects.toThrow(/DELEGADO_TIENE_HISTORIAL/);

        const { rows } = await db.query('select id from delegados_asociacion where id=$1', [del.id]);
        expect(rows).toHaveLength(1); // sigue existiendo
    });

    test('Caso B: con responsable confirmado (rodeos_delegado_institucional) aunque NO haya cartilla -> también bloquea', async () => {
        const asoc = await crearAsociacion();
        const del = await crearDelegado(asoc);
        const rodeo = await crearRodeo();
        await db.query('insert into rodeos_delegado_institucional (rodeo_id, delegado_asociacion_id) values ($1,$2)', [rodeo, del.id]);

        await expect(
            db.query('select * from eliminar_delegado_asociacion_con_auditoria($1,$2)', [del.id, ADMIN_ID])
        ).rejects.toThrow(/DELEGADO_TIENE_HISTORIAL/);
    });

    test('Caso A: sin ninguna referencia -> elimina Y audita, en la misma transacción', async () => {
        const asoc = await crearAsociacion();
        const del = await crearDelegado(asoc);
        const { rows: adminRows } = await db.query("insert into administradores (nombre_completo) values ('Admin Prueba') returning id");
        const adminId = adminRows[0].id;

        const { rows } = await db.query('select * from eliminar_delegado_asociacion_con_auditoria($1,$2)', [del.id, adminId]);
        expect(rows[0].id).toBe(del.id);

        const { rows: existe } = await db.query('select id from delegados_asociacion where id=$1', [del.id]);
        expect(existe).toHaveLength(0);

        const { rows: eventos } = await db.query(
            "select accion, actor_tipo, datos_anteriores from auditoria where tabla='delegados_asociacion' and registro_id=$1",
            [del.id]
        );
        expect(eventos).toHaveLength(1);
        expect(eventos[0].accion).toBe('eliminar');
        expect(eventos[0].actor_tipo).toBe('administrador');
        expect(eventos[0].datos_anteriores.nombre).toBe(del.nombre);
    });

    test('delegado inexistente -> RAISE DELEGADO_NO_ENCONTRADO', async () => {
        await expect(
            db.query('select * from eliminar_delegado_asociacion_con_auditoria($1,$2)', ['00000000-0000-0000-0000-000000000000', ADMIN_ID])
        ).rejects.toThrow(/DELEGADO_NO_ENCONTRADO/);
    });
});

describe('Riesgo 1 — las dos secuencias posibles de una carrera real son, cada una, seguras', () => {
    test('Secuencia A (la referencia se crea ANTES de intentar eliminar): la RPC la detecta y bloquea — nunca un SET NULL silencioso', async () => {
        const asoc = await crearAsociacion();
        const del = await crearDelegado(asoc);
        const rodeo = await crearRodeo();
        // Simula: otra sesión (p.ej. la asociación creando su cartilla) gana
        // la carrera y compromete su INSERT justo antes de que esta llamada
        // a eliminar_... se ejecute.
        await crearCartillaInstitucional(rodeo, del.id);

        await expect(
            db.query('select * from eliminar_delegado_asociacion_con_auditoria($1,$2)', [del.id, ADMIN_ID])
        ).rejects.toThrow(/DELEGADO_TIENE_HISTORIAL/);
    });

    test('Secuencia B (el delegado se elimina PRIMERO, sin referencias; una inserción posterior intenta referenciar ese id): falla por FK, nunca queda huérfana ni referenciando basura', async () => {
        const asoc = await crearAsociacion();
        const del = await crearDelegado(asoc);
        const rodeo = await crearRodeo();

        await db.query('select * from eliminar_delegado_asociacion_con_auditoria($1,$2)', [del.id, ADMIN_ID]);

        // La "otra sesión" perdió la carrera: para cuando intenta insertar
        // su cartilla, el delegado ya no existe — la FK lo rechaza de verdad,
        // nunca se crea una cartilla "huérfana" apuntando a un id borrado.
        await expect(crearCartillaInstitucional(rodeo, del.id)).rejects.toThrow(/foreign key|violat/i);
    });
});

describe('Riesgo 2 — auditoría transaccional: Crear/Suspender/Reactivar/Eliminar nunca quedan aplicados sin su auditoría', () => {
    test('Crear: si el INSERT en auditoria falla, el alta TAMPOCO queda aplicada', async () => {
        const asoc = await crearAsociacion();
        const nombreMarcador = '__FORZAR_FALLO_AUDITORIA__ crear';

        await expect(
            db.query(
                'select * from crear_delegado_asociacion_con_auditoria($1,$2,$3,$4,$5)',
                [nombreMarcador, nombreMarcador.toLowerCase(), asoc, true, ADMIN_ID]
            )
        ).rejects.toThrow(/FALLO_SIMULADO_AUDITORIA/);

        const { rows } = await db.query('select id from delegados_asociacion where nombre=$1', [nombreMarcador]);
        expect(rows).toHaveLength(0); // nunca se insertó
    });

    test('Suspender: si el INSERT en auditoria falla, la suspensión TAMPOCO queda aplicada', async () => {
        const asoc = await crearAsociacion();
        const del = await crearDelegado(asoc);

        await expect(
            db.query(
                'select * from suspender_delegado_asociacion_con_auditoria($1,$2,$3)',
                [del.id, ADMIN_ID, '__FORZAR_FALLO_AUDITORIA__']
            )
        ).rejects.toThrow(/FALLO_SIMULADO_AUDITORIA/);

        const { rows } = await db.query('select activo from delegados_asociacion where id=$1', [del.id]);
        expect(rows[0].activo).toBe(true); // nunca se suspendió
    });

    test('Reactivar: si el INSERT en auditoria falla, la reactivación TAMPOCO queda aplicada', async () => {
        const asoc = await crearAsociacion();
        const nombreMarcador = '__FORZAR_FALLO_AUDITORIA__ reactivar ' + (++seq);
        const { rows: insRows } = await db.query(
            "insert into delegados_asociacion (nombre, nombre_normalizado, asociacion_id, certificado, activo) values ($1,$2,$3,true,false) returning id",
            [nombreMarcador, nombreMarcador.toLowerCase(), asoc]
        );
        const delId = insRows[0].id;

        await expect(
            db.query('select * from reactivar_delegado_asociacion_con_auditoria($1,$2)', [delId, ADMIN_ID])
        ).rejects.toThrow(/FALLO_SIMULADO_AUDITORIA/);

        const { rows } = await db.query('select activo from delegados_asociacion where id=$1', [delId]);
        expect(rows[0].activo).toBe(false); // nunca se reactivó
    });

    test('Eliminar: si el INSERT en auditoria falla, la eliminación TAMPOCO queda aplicada', async () => {
        const asoc = await crearAsociacion();
        const nombreMarcador = '__FORZAR_FALLO_AUDITORIA__ eliminar ' + (++seq);
        const { rows: insRows } = await db.query(
            "insert into delegados_asociacion (nombre, nombre_normalizado, asociacion_id, certificado, activo) values ($1,$2,$3,true,true) returning id",
            [nombreMarcador, nombreMarcador.toLowerCase(), asoc]
        );
        const delId = insRows[0].id;

        await expect(
            db.query('select * from eliminar_delegado_asociacion_con_auditoria($1,$2)', [delId, ADMIN_ID])
        ).rejects.toThrow(/FALLO_SIMULADO_AUDITORIA/);

        const { rows } = await db.query('select id from delegados_asociacion where id=$1', [delId]);
        expect(rows).toHaveLength(1); // sigue existiendo, nunca se eliminó
    });

    test('camino feliz (sin fallo de auditoria): las 4 operaciones SÍ dejan su evento correspondiente', async () => {
        const asoc = await crearAsociacion();

        const { rows: creado } = await db.query(
            'select * from crear_delegado_asociacion_con_auditoria($1,$2,$3,$4,$5)',
            ['Delegado Feliz', 'delegado feliz', asoc, false, ADMIN_ID]
        );
        const delId = creado[0].id;

        await db.query('select * from suspender_delegado_asociacion_con_auditoria($1,$2,$3)', [delId, ADMIN_ID, 'Suspensión de prueba']);
        await db.query('select * from reactivar_delegado_asociacion_con_auditoria($1,$2)', [delId, ADMIN_ID]);
        await db.query('select * from eliminar_delegado_asociacion_con_auditoria($1,$2)', [delId, ADMIN_ID]);

        const { rows: eventos } = await db.query(
            "select accion from auditoria where tabla='delegados_asociacion' and registro_id=$1 order by created_at asc",
            [delId]
        );
        expect(eventos.map(e => e.accion)).toEqual(['crear', 'suspender', 'reactivar', 'eliminar']);
    });
});

describe('Suspender/Reactivar — nunca modifican historial ni certificación indebidamente', () => {
    test('Suspender con cartillas/selecciones vinculadas: SÍ suspende (no bloquea), pero nunca toca la cartilla ni la desvincula', async () => {
        const asoc = await crearAsociacion();
        const del = await crearDelegado(asoc);
        const rodeo = await crearRodeo();
        await crearCartillaInstitucional(rodeo, del.id);

        await db.query('select * from suspender_delegado_asociacion_con_auditoria($1,$2,$3)', [del.id, ADMIN_ID, 'Suspensión con antecedentes']);

        const { rows: delRows } = await db.query('select activo from delegados_asociacion where id=$1', [del.id]);
        expect(delRows[0].activo).toBe(false);

        const { rows: cartRows } = await db.query('select delegado_asociacion_id, estado from cartillas_delegado where rodeo_id=$1', [rodeo]);
        expect(cartRows[0].delegado_asociacion_id).toBe(del.id); // intacta
        expect(cartRows[0].estado).toBe('borrador'); // sin cambios
    });

    test('ya suspendido -> RAISE DELEGADO_YA_SUSPENDIDO', async () => {
        const asoc = await crearAsociacion();
        const del = await crearDelegado(asoc);
        await db.query('select * from suspender_delegado_asociacion_con_auditoria($1,$2,$3)', [del.id, ADMIN_ID, 'x']);
        await expect(
            db.query('select * from suspender_delegado_asociacion_con_auditoria($1,$2,$3)', [del.id, ADMIN_ID, 'x'])
        ).rejects.toThrow(/DELEGADO_YA_SUSPENDIDO/);
    });

    test('Reactivar nunca certifica automáticamente (certificado conserva su valor real)', async () => {
        const asoc = await crearAsociacion();
        const del = await crearDelegado(asoc, 'Ana Soto', false); // certificado=false
        await db.query('select * from suspender_delegado_asociacion_con_auditoria($1,$2,$3)', [del.id, ADMIN_ID, 'x']);

        const { rows } = await db.query('select * from reactivar_delegado_asociacion_con_auditoria($1,$2)', [del.id, ADMIN_ID]);
        expect(rows[0].activo).toBe(true);
        expect(rows[0].certificado).toBe(false); // sigue pendiente, nunca se certificó solo
    });

    test('ya activo -> RAISE DELEGADO_YA_ACTIVO', async () => {
        const asoc = await crearAsociacion();
        const del = await crearDelegado(asoc);
        await expect(
            db.query('select * from reactivar_delegado_asociacion_con_auditoria($1,$2)', [del.id, ADMIN_ID])
        ).rejects.toThrow(/DELEGADO_YA_ACTIVO/);
    });
});

describe('Acceso exclusivo del administrador pleno (privilegios reales de BD, migración 073)', () => {
    async function comoRol(rol, fn) {
        await db.exec(`SET ROLE ${rol};`);
        try {
            return await fn();
        } finally {
            await db.exec('RESET ROLE;');
        }
    }

    test('anon no puede ejecutar ninguna de las 4 funciones', async () => {
        const llamadas = [
            () => db.query("select * from eliminar_delegado_asociacion_con_auditoria($1::uuid, null)", ['00000000-0000-0000-0000-000000000000']),
            () => db.query("select * from reactivar_delegado_asociacion_con_auditoria($1::uuid, null)", ['00000000-0000-0000-0000-000000000000']),
            () => db.query("select * from suspender_delegado_asociacion_con_auditoria($1::uuid, null, 'x')", ['00000000-0000-0000-0000-000000000000']),
            () => db.query("select * from crear_delegado_asociacion_con_auditoria('x','x',$1::uuid, false, null)", ['00000000-0000-0000-0000-000000000000'])
        ];
        for (const llamar of llamadas) {
            await expect(comoRol('anon', llamar)).rejects.toThrow(/permission denied/i);
        }
    });

    test('service_role sí puede ejecutar (uso real del backend)', async () => {
        const asoc = await crearAsociacion();
        await expect(
            comoRol('service_role', () => db.query(
                "select * from crear_delegado_asociacion_con_auditoria('Via Service Role','via service role',$1,false,$2)",
                [asoc, ADMIN_ID]
            ))
        ).resolves.toBeDefined();
    });
});
