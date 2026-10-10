// Fase 3.5.1 — consistencia transaccional entre la operación principal y su
// auditoría obligatoria, contra un PostgreSQL REAL de prueba (PGlite),
// aplicando las migraciones reales en secuencia (037, 061-070). Prueba:
//   1. crear_o_adjuntar_cartilla_institucional ahora audita DENTRO de su
//      propia transacción (crear y adjuntar/guardar).
//   2. La nueva actualizar_cartilla_institucional_con_auditoria aplica
//      guardar/enviar + auditoría de forma atómica.
//   3. Defensa en profundidad: nunca escribe id/rodeo_id/delegado_id/
//      delegado_asociacion_id/created_at aunque vengan en p_cambios.
//   4. Si el INSERT en auditoria falla (simulado con un trigger temporal
//      que aborta para un marcador específico), TODA la operación —
//      incluida la escritura principal— se revierte: nunca se reporta
//      éxito de una operación que quedó sin trazabilidad.
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
    await db.exec(leer('070_auditoria_transaccional_institucional.sql'));

    ID.asoc = (await q("insert into asociaciones (nombre, nombre_normalizado) values ('OSORNO','osorno') returning id"))[0].id;
    ID.cuenta = (await q("insert into cuentas_institucionales (email, password_hash, asociacion_id) values ('delegado-osorno@ferochi.com','x',$1) returning id", [ID.asoc]))[0].id;
    ID.delA = (await q("insert into delegados_asociacion (nombre, nombre_normalizado, asociacion_id, certificado) values ('Ana Soto','ana soto',$1,true) returning id", [ID.asoc]))[0].id;
});
afterAll(async () => { await db.close(); });

beforeEach(async () => {
    await db.exec('DELETE FROM auditoria; DELETE FROM cartillas_delegado; DELETE FROM rodeos_delegado_institucional; DELETE FROM asignaciones; DELETE FROM rodeos');
});

async function crearRodeo() {
    return (await q("insert into rodeos (club, asociacion, fecha) values ('Club X','OSORNO','2026-09-18') returning id"))[0].id;
}
async function crearOAdjuntar(rodeoId) {
    return (await q(
        'select * from crear_o_adjuntar_cartilla_institucional($1,$2,$3,$4,$5,$6,$7)',
        [rodeoId, ID.delA, 'Ana Soto', ID.cuenta, '2026-2027', '2026-09-18', 'Provincial']
    ))[0];
}
async function actualizar(cartillaId, version, cambios, accion, descripcion) {
    const r = await q(
        'select * from actualizar_cartilla_institucional_con_auditoria($1,$2,$3,$4,$5,$6)',
        [cartillaId, version, JSON.stringify(cambios), ID.cuenta, accion, descripcion]
    );
    return r[0] || null;
}

describe('crear_o_adjuntar_cartilla_institucional — auditoría ahora DENTRO de la misma transacción', () => {
    test('crear (version=1) -> audita accion="crear" en la MISMA llamada, nunca una segunda consulta aparte', async () => {
        const rodeoId = await crearRodeo();
        const cartilla = await crearOAdjuntar(rodeoId);
        expect(cartilla.version).toBe(1);

        const eventos = await q("select * from auditoria where tabla='cartillas_delegado' and registro_id=$1", [cartilla.id]);
        expect(eventos).toHaveLength(1);
        expect(eventos[0].accion).toBe('crear');
        expect(eventos[0].actor_tipo).toBe('cuenta_institucional');
    });

    test('reintento/adjunto con el MISMO delegado (version=2) -> audita accion="guardar", nunca duplica la de "crear"', async () => {
        const rodeoId = await crearRodeo();
        await crearOAdjuntar(rodeoId);
        const segunda = await crearOAdjuntar(rodeoId);
        expect(segunda.version).toBe(2);

        const eventos = await q("select accion from auditoria where tabla='cartillas_delegado' and registro_id=$1 order by created_at asc", [segunda.id]);
        expect(eventos.map(e => e.accion)).toEqual(['crear', 'guardar']);
    });

    test('fallo del INSERT en auditoria (trigger temporal) revierte también la cartilla — nunca queda creada sin su evento', async () => {
        // Simula un fallo real del registro de auditoría: un trigger que
        // aborta SOLO para este marcador específico (nunca afecta otros
        // tests ni otras filas), para probar que la función entera revierte.
        await db.exec(`
            CREATE OR REPLACE FUNCTION fn_simular_fallo_auditoria_070() RETURNS TRIGGER AS $$
            BEGIN
                IF NEW.descripcion LIKE '%__MARCADOR_FALLO_070__%' THEN
                    RAISE EXCEPTION 'FALLO_SIMULADO_AUDITORIA';
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
            DROP TRIGGER IF EXISTS trg_simular_fallo_auditoria_070 ON auditoria;
            CREATE TRIGGER trg_simular_fallo_auditoria_070 BEFORE INSERT ON auditoria
                FOR EACH ROW EXECUTE FUNCTION fn_simular_fallo_auditoria_070();
        `);
        try {
            const rodeoId = await crearRodeo();
            // La función arma su propia descripción con el nombre del
            // delegado — se usa un nombre que incluye el marcador para que
            // el trigger de arriba intercepte justo ESTE INSERT.
            await expect(q(
                'select * from crear_o_adjuntar_cartilla_institucional($1,$2,$3,$4,$5,$6,$7)',
                [rodeoId, ID.delA, 'Ana Soto __MARCADOR_FALLO_070__', ID.cuenta, '2026-2027', '2026-09-18', 'Provincial']
            )).rejects.toThrow(/FALLO_SIMULADO_AUDITORIA/);

            // Nunca quedó creada: ni la cartilla ni ningún evento de auditoría.
            const cartillas = await q('select * from cartillas_delegado where rodeo_id=$1', [rodeoId]);
            expect(cartillas).toHaveLength(0);
            const eventos = await q("select * from auditoria where tabla='cartillas_delegado'");
            expect(eventos).toHaveLength(0);
        } finally {
            await db.exec('DROP TRIGGER IF EXISTS trg_simular_fallo_auditoria_070 ON auditoria;');
        }
    });
});

describe('actualizar_cartilla_institucional_con_auditoria — guardar/enviar atómicos', () => {
    test('guardar: aplica solo los campos enviados, incrementa version, audita "guardar", y conserva el resto intacto', async () => {
        const rodeoId = await crearRodeo();
        const cartilla = await crearOAdjuntar(rodeoId);

        const guardada = await actualizar(cartilla.id, cartilla.version, {
            version: cartilla.version + 1,
            updated_at: new Date().toISOString(),
            actualizado_por_cuenta_institucional_id: ID.cuenta,
            respuestas_json: { comentarios_generales: { texto: 'Prueba' } }
        }, 'guardar', 'Guardado de borrador institucional');

        expect(guardada.version).toBe(2);
        expect(guardada.respuestas_json.comentarios_generales.texto).toBe('Prueba');
        expect(guardada.delegado_nombre).toBe('Ana Soto'); // intacto, no se pidió cambiarlo
        expect(guardada.delegado_asociacion_id).toBe(ID.delA); // intacto

        const eventos = await q("select accion from auditoria where tabla='cartillas_delegado' and registro_id=$1", [cartilla.id]);
        expect(eventos.map(e => e.accion)).toContain('guardar');
    });

    test('enviar: puede cambiar estado/enviada_en/historial_observaciones, audita "enviar"', async () => {
        const rodeoId = await crearRodeo();
        const cartilla = await crearOAdjuntar(rodeoId);
        const ahora = new Date().toISOString();

        const enviada = await actualizar(cartilla.id, cartilla.version, {
            version: cartilla.version + 1,
            updated_at: ahora,
            actualizado_por_cuenta_institucional_id: ID.cuenta,
            estado: 'enviada',
            enviada_en: ahora,
            historial_observaciones: [{ tipo: 'envio', fecha: ahora }]
        }, 'enviar', 'Envío de cartilla institucional');

        expect(enviada.estado).toBe('enviada');
        expect(enviada.enviada_en).toBeTruthy();
        expect(enviada.historial_observaciones).toHaveLength(1);

        const eventos = await q("select accion from auditoria where tabla='cartillas_delegado' and registro_id=$1", [cartilla.id]);
        expect(eventos.map(e => e.accion)).toContain('enviar');
    });

    test('version desactualizada -> RAISE EXCEPTION (nunca un NULL ambiguo), NUNCA audita (0 eventos nuevos)', async () => {
        const rodeoId = await crearRodeo();
        const cartilla = await crearOAdjuntar(rodeoId);
        await actualizar(cartilla.id, cartilla.version, { version: cartilla.version + 1, updated_at: new Date().toISOString() }, 'guardar', 'x');

        const antes = await q("select count(*)::int as c from auditoria where tabla='cartillas_delegado' and registro_id=$1", [cartilla.id]);
        await expect(
            actualizar(cartilla.id, cartilla.version /* vieja */, { version: cartilla.version + 1, updated_at: new Date().toISOString() }, 'guardar', 'y')
        ).rejects.toThrow(/CARTILLA_NO_ENCONTRADA_O_VERSION_DESACTUALIZADA/);
        const despues = await q("select count(*)::int as c from auditoria where tabla='cartillas_delegado' and registro_id=$1", [cartilla.id]);
        expect(despues[0].c).toBe(antes[0].c); // ningún evento nuevo
    });

    test('defensa en profundidad: aunque p_cambios incluya delegado_asociacion_id/rodeo_id/id/created_at, NUNCA se escriben — el responsable es inmutable también a nivel de base de datos', async () => {
        const rodeoId = await crearRodeo();
        const cartilla = await crearOAdjuntar(rodeoId);
        const otroRodeo = await crearRodeo();
        const idFalsificado = '00000000-0000-0000-0000-0000000face0';

        const resultado = await actualizar(cartilla.id, cartilla.version, {
            version: cartilla.version + 1,
            updated_at: new Date().toISOString(),
            delegado_asociacion_id: idFalsificado,
            rodeo_id: otroRodeo,
            id: idFalsificado,
            created_at: '2000-01-01T00:00:00Z'
        }, 'guardar', 'intento de manipulación');

        expect(resultado.id).toBe(cartilla.id); // nunca cambió
        expect(resultado.rodeo_id).toBe(rodeoId); // nunca cambió
        expect(resultado.delegado_asociacion_id).toBe(ID.delA); // nunca cambió
        expect(new Date(resultado.created_at).getFullYear()).not.toBe(2000); // nunca cambió
    });

    test('fallo del INSERT en auditoria (trigger temporal) revierte también el guardado — nunca queda guardado sin su evento', async () => {
        await db.exec(`
            CREATE OR REPLACE FUNCTION fn_simular_fallo_auditoria_070b() RETURNS TRIGGER AS $$
            BEGIN
                IF NEW.descripcion LIKE '%__MARCADOR_FALLO_070B__%' THEN
                    RAISE EXCEPTION 'FALLO_SIMULADO_AUDITORIA_GUARDAR';
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
            DROP TRIGGER IF EXISTS trg_simular_fallo_auditoria_070b ON auditoria;
            CREATE TRIGGER trg_simular_fallo_auditoria_070b BEFORE INSERT ON auditoria
                FOR EACH ROW EXECUTE FUNCTION fn_simular_fallo_auditoria_070b();
        `);
        try {
            const rodeoId = await crearRodeo();
            const cartilla = await crearOAdjuntar(rodeoId);

            await expect(q(
                'select * from actualizar_cartilla_institucional_con_auditoria($1,$2,$3,$4,$5,$6)',
                [cartilla.id, cartilla.version, JSON.stringify({ version: cartilla.version + 1, updated_at: new Date().toISOString(), delegado_telefono: '+56911112222' }), ID.cuenta, 'guardar', '__MARCADOR_FALLO_070B__']
            )).rejects.toThrow(/FALLO_SIMULADO_AUDITORIA_GUARDAR/);

            const actual = await q('select version, delegado_telefono from cartillas_delegado where id=$1', [cartilla.id]);
            expect(actual[0].version).toBe(1); // nunca se incrementó
            expect(actual[0].delegado_telefono).toBeNull(); // nunca se guardó
        } finally {
            await db.exec('DROP TRIGGER IF EXISTS trg_simular_fallo_auditoria_070b ON auditoria;');
        }
    });
});
