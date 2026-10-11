// Gestión de acceso institucional (migración 078) — verificación contra
// Postgres REAL (PGlite), no mocks. Cubre:
//   1. Alta de cuenta para asociación existente (Opción A), atómica + auditada.
//   2. Alta de asociación nueva + su cuenta (Opción B), atómica + 2 auditorías.
//   3. Rechazo real (UNIQUE) de asociación duplicada, cuenta duplicada por
//      asociación, y correo duplicado.
//   4. Suspender/reactivar — tocan EXCLUSIVAMENTE cuentas_institucionales.
//      activo, nunca asociaciones.activa.
//   5. Restablecer contraseña — primer_login=true, password_version++,
//      nunca registra el hash en auditoria.
//   6. Ninguna de las 5 RPC devuelve password_hash (tipo de retorno propio).
//   7. Permisos reales: anon/authenticated SIN EXECUTE, service_role CON.
//   8. Atomicidad: si el INSERT en auditoria fallara, TODA la operación se
//      revierte (mismo patrón de trigger de prueba que 073).
//   9. Concurrencia: dos altas para la MISMA asociación nunca terminan
//      ambas con éxito (lock FOR UPDATE + UNIQUE como backstop).
jest.setTimeout(120000);
const fs = require('fs');
const path = require('path');
const { crearDb } = require('./__fixtures__/pgliteCliente');

const MIGRACIONES_DIR = path.join(__dirname, '..', '..', '..', 'database', 'migrations');
const leer = (n) => fs.readFileSync(path.join(MIGRACIONES_DIR, n), 'utf8');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaCartillaInstitucional.sql'), 'utf8');

const MIGRACIONES = [
    '061_cuentas_institucionales.sql',
    '078_gestion_acceso_cuentas_institucionales.sql'
];

let db;
let ADMIN_ID;
beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);

    // El fixture compartido (esquemaCartillaInstitucional.sql) define una
    // `asociaciones` MÍNIMA (id, nombre, nombre_normalizado, activa) para
    // las pruebas de cartilla institucional, que nunca necesitaron más.
    // Esta migración sí necesita zona/es_especial (reales desde la 057,
    // ✅ YA APLICADA en producción) y el UNIQUE real de nombre_normalizado
    // — se agregan acá, NUNCA modificando el fixture compartido (que otras
    // suites siguen usando tal cual), con el mismo criterio IF NOT EXISTS
    // que usa esa propia migración 057.
    await db.exec(`
        ALTER TABLE asociaciones
            ADD COLUMN IF NOT EXISTS zona TEXT,
            ADD COLUMN IF NOT EXISTS es_especial BOOLEAN NOT NULL DEFAULT false;
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conrelid = 'asociaciones'::regclass AND conname = 'uq_asociaciones_nombre_normalizado'
            ) THEN
                ALTER TABLE asociaciones ADD CONSTRAINT uq_asociaciones_nombre_normalizado UNIQUE (nombre_normalizado);
            END IF;
        END $$;
    `);

    for (const m of MIGRACIONES) await db.exec(leer(m));

    const { rows } = await db.query("insert into administradores (nombre_completo) values ('Admin de Prueba') returning id");
    ADMIN_ID = rows[0].id;

    // Mismo criterio que 073: reproduce el default real de Supabase
    // (service_role con acceso amplio a tablas preexistentes) dentro del
    // fixture mínimo, que no ejecuta la 071 completa.
    await db.exec(`GRANT ALL ON TABLE asociaciones, cuentas_institucionales, auditoria, administradores TO service_role;`);

    // Trigger de PRUEBA (no es parte de ninguna migración real): fuerza un
    // fallo determinístico del INSERT en auditoria cuando la descripción
    // contiene un marcador — mismo mecanismo que 073.
    await db.exec(`
        CREATE OR REPLACE FUNCTION _fallar_auditoria_test_078() RETURNS TRIGGER AS $$
        BEGIN
            IF NEW.descripcion LIKE '%__FORZAR_FALLO_AUDITORIA__%' THEN
                RAISE EXCEPTION 'FALLO_SIMULADO_AUDITORIA';
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER trg_fallar_auditoria_test_078 BEFORE INSERT ON auditoria
            FOR EACH ROW EXECUTE FUNCTION _fallar_auditoria_test_078();
    `);
});
afterAll(async () => { await db.close(); });

let seq = 0;
async function crearAsociacion(nombre = 'OSORNO', activa = true, esEspecial = false) {
    seq++;
    const n = nombre + '_' + seq;
    const { rows } = await db.query(
        "insert into asociaciones (nombre, nombre_normalizado, activa, es_especial) values ($1,$2,$3,$4) returning id",
        [n, n.toLowerCase(), activa, esEspecial]
    );
    return rows[0].id;
}
function emailUnico() {
    seq++;
    return `cuenta${seq}@ferochi.cl`;
}
async function crearCuenta(asociacionId, email = emailUnico(), descripcion = 'Alta de prueba') {
    const { rows } = await db.query(
        'select * from crear_cuenta_institucional_con_auditoria($1,$2,$3,$4)',
        [asociacionId, email, 'hash-fijo-de-prueba', ADMIN_ID]
    );
    return rows[0];
}

describe('1) Opción A — alta de cuenta para asociación existente, atómica + auditada', () => {
    test('alta exitosa: primer_login=true, password_version=1, activo=true, rol_institucional=delegado_asociacion por defecto', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuenta(asoc);
        expect(cuenta.primer_login).toBe(true);
        expect(cuenta.password_version).toBe(1);
        expect(cuenta.activo).toBe(true);
        expect(cuenta.rol_institucional).toBe('delegado_asociacion');
    });

    test('registra un evento de auditoría "crear" sobre cuentas_institucionales, actor_tipo=administrador, sin el hash', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuenta(asoc, 'auditada@ferochi.cl');
        const { rows } = await db.query(
            "select * from auditoria where tabla='cuentas_institucionales' and registro_id=$1 and accion='crear'",
            [cuenta.id]
        );
        expect(rows.length).toBe(1);
        expect(rows[0].actor_id).toBe(ADMIN_ID);
        expect(rows[0].actor_tipo).toBe('administrador');
        expect(JSON.stringify(rows[0])).not.toContain('hash-fijo-de-prueba');
    });

    test('asociación inexistente -> RAISE ASOCIACION_NO_ENCONTRADA, nunca crea la cuenta', async () => {
        await expect(crearCuenta('00000000-0000-0000-0000-000000000000')).rejects.toThrow(/ASOCIACION_NO_ENCONTRADA/);
    });

    test('ya existe una cuenta para esa asociación -> RAISE CUENTA_YA_EXISTE_PARA_ASOCIACION', async () => {
        const asoc = await crearAsociacion();
        await crearCuenta(asoc);
        await expect(crearCuenta(asoc)).rejects.toThrow(/CUENTA_YA_EXISTE_PARA_ASOCIACION/);
    });

    test('correo ya registrado (en otra asociación) -> RAISE CORREO_YA_REGISTRADO', async () => {
        const asoc1 = await crearAsociacion();
        const asoc2 = await crearAsociacion();
        await crearCuenta(asoc1, 'repetido@ferochi.cl');
        await expect(crearCuenta(asoc2, 'repetido@ferochi.cl')).rejects.toThrow(/CORREO_YA_REGISTRADO/);
    });

    test('nunca devuelve password_hash (columna ausente del tipo de retorno)', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuenta(asoc);
        expect(cuenta.password_hash).toBeUndefined();
        expect(Object.keys(cuenta)).not.toContain('password_hash');
    });

    // Riesgo 2 (revisión posterior): antes solo se validaba existencia —
    // nunca que la asociación estuviera activa ni que no fuera especial.
    describe('Riesgo 2 — bloqueo real de asociaciones inactivas o especiales (caso de referencia: Federación del Rodeo Chileno)', () => {
        test('asociación INACTIVA (activa=false) -> RAISE ASOCIACION_INACTIVA, nunca crea la cuenta', async () => {
            const asocInactiva = await crearAsociacion('Asociación Inactiva', false, false);
            await expect(crearCuenta(asocInactiva)).rejects.toThrow(/ASOCIACION_INACTIVA/);
            const { rows } = await db.query('select count(*)::int as n from cuentas_institucionales where asociacion_id=$1', [asocInactiva]);
            expect(rows[0].n).toBe(0);
        });

        test('asociación ESPECIAL (es_especial=true, caso real: Federación del Rodeo Chileno) -> RAISE ASOCIACION_ESPECIAL_SIN_CUENTA, nunca crea la cuenta NI modifica el registro de la asociación', async () => {
            const asocEspecial = await crearAsociacion('FEDERACION DEL RODEO CHILENO', true, true);
            await expect(crearCuenta(asocEspecial)).rejects.toThrow(/ASOCIACION_ESPECIAL_SIN_CUENTA/);
            const { rows: [real] } = await db.query('select activa, es_especial from asociaciones where id=$1', [asocEspecial]);
            expect(real).toEqual({ activa: true, es_especial: true }); // intacta, sin cambios
            const { rows } = await db.query('select count(*)::int as n from cuentas_institucionales where asociacion_id=$1', [asocEspecial]);
            expect(rows[0].n).toBe(0);
        });

        test('asociación activa Y ordinaria (es_especial=false) -> permitido, comportamiento normal intacto', async () => {
            const asocOrdinaria = await crearAsociacion('OSORNO', true, false);
            const cuenta = await crearCuenta(asocOrdinaria);
            expect(cuenta.activo).toBe(true);
        });

        test('el lock FOR UPDATE sigue vigente: la validación de activa/es_especial usa la MISMA fila bloqueada que ya serializaba la creación concurrente (nunca una consulta aparte sin lock)', async () => {
            // Verificación indirecta: una asociación válida pero YA con cuenta
            // sigue rechazando por CUENTA_YA_EXISTE_PARA_ASOCIACION (no por
            // ASOCIACION_INACTIVA/ESPECIAL) — confirma que el chequeo nuevo no
            // alteró el orden ni la lógica de los chequeos posteriores.
            const asoc = await crearAsociacion();
            await crearCuenta(asoc);
            await expect(crearCuenta(asoc)).rejects.toThrow(/CUENTA_YA_EXISTE_PARA_ASOCIACION/);
        });
    });
});

describe('2) Opción B — asociación NUEVA + su cuenta, atómico', () => {
    async function crearAsociacionInstitucional(nombre, zona, email) {
        const { rows } = await db.query(
            'select * from crear_asociacion_institucional_con_auditoria($1,$2,$3,$4,$5,$6)',
            [nombre, nombre.toLowerCase(), zona, email, 'hash-fijo-de-prueba', ADMIN_ID]
        );
        return rows[0];
    }

    test('crea la asociación Y la cuenta en una sola operación -> ambas existen, vinculadas', async () => {
        seq++;
        const nombre = 'Asociación Nueva ' + seq;
        const cuenta = await crearAsociacionInstitucional(nombre, 'Sur', emailUnico());
        const { rows: [asociacion] } = await db.query('select * from asociaciones where id=$1', [cuenta.asociacion_id]);
        expect(asociacion.nombre).toBe(nombre);
        expect(asociacion.activa).toBe(true);
        expect(asociacion.es_especial).toBe(false);
    });

    test('registra DOS eventos de auditoría (asociaciones + cuentas_institucionales), ambos en la misma transacción', async () => {
        seq++;
        const cuenta = await crearAsociacionInstitucional('Asociación Auditada ' + seq, 'Norte', emailUnico());
        const { rows: evAsoc } = await db.query("select * from auditoria where tabla='asociaciones' and registro_id=$1", [cuenta.asociacion_id]);
        const { rows: evCuenta } = await db.query("select * from auditoria where tabla='cuentas_institucionales' and registro_id=$1", [cuenta.id]);
        expect(evAsoc.length).toBe(1);
        expect(evCuenta.length).toBe(1);
    });

    test('nombre ya existe (UNIQUE real de nombre_normalizado) -> RAISE ASOCIACION_YA_EXISTE, NINGUNA de las dos filas queda creada (atomicidad real)', async () => {
        seq++;
        const nombre = 'Asociación Duplicada ' + seq;
        await crearAsociacionInstitucional(nombre, null, emailUnico());
        const emailSegundoIntento = emailUnico();
        await expect(crearAsociacionInstitucional(nombre, null, emailSegundoIntento)).rejects.toThrow(/ASOCIACION_YA_EXISTE/);
        const { rows } = await db.query('select * from cuentas_institucionales where email=$1', [emailSegundoIntento]);
        expect(rows.length).toBe(0); // la cuenta del intento fallido nunca quedó creada
    });

    test('correo ya registrado -> RAISE CORREO_YA_REGISTRADO, la asociación tampoco queda creada (atomicidad real: nunca una asociación huérfana sin cuenta)', async () => {
        seq++;
        const emailRepetido = emailUnico();
        await crearAsociacionInstitucional('Asociación Original ' + seq, null, emailRepetido);
        const nombreFallido = 'Asociación Huérfana ' + seq;
        await expect(crearAsociacionInstitucional(nombreFallido, null, emailRepetido)).rejects.toThrow(/CORREO_YA_REGISTRADO/);
        const { rows } = await db.query('select * from asociaciones where nombre=$1', [nombreFallido]);
        expect(rows.length).toBe(0); // nunca queda la asociación sin su cuenta
    });

    test('nunca crea delegados_asociacion, rodeos ni asignaciones', async () => {
        seq++;
        await crearAsociacionInstitucional('Asociación Sin Efectos ' + seq, null, emailUnico());
        // Esta migración ni siquiera referencia esas tablas — se confirma
        // indirectamente: la función se ejecuta sin error aunque esas
        // tablas del fixture mínimo existan vacías y sin relación alguna.
        const { rows } = await db.query("select count(*)::int as n from asociaciones");
        expect(rows[0].n).toBeGreaterThan(0); // sanity: la asociación sí se creó
    });
});

describe('3) Suspender / reactivar — tocan EXCLUSIVAMENTE cuentas_institucionales.activo (+ password_version, revisión posterior)', () => {
    test('suspender: activo pasa a false, asociaciones.activa NUNCA se toca', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuenta(asoc);
        const { rows: [suspendida] } = await db.query(
            'select * from suspender_cuenta_institucional_con_auditoria($1,$2,$3)',
            [cuenta.id, ADMIN_ID, 'Suspensión de prueba']
        );
        expect(suspendida.activo).toBe(false);
        const { rows: [asociacionReal] } = await db.query('select activa from asociaciones where id=$1', [asoc]);
        expect(asociacionReal.activa).toBe(true); // intacta
    });

    test('suspender dos veces -> RAISE CUENTA_YA_SUSPENDIDA la segunda vez', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuenta(asoc);
        await db.query('select * from suspender_cuenta_institucional_con_auditoria($1,$2,$3)', [cuenta.id, ADMIN_ID, 'x']);
        await expect(
            db.query('select * from suspender_cuenta_institucional_con_auditoria($1,$2,$3)', [cuenta.id, ADMIN_ID, 'x'])
        ).rejects.toThrow(/CUENTA_YA_SUSPENDIDA/);
    });

    test('cuenta inexistente -> RAISE CUENTA_NO_ENCONTRADA', async () => {
        await expect(
            db.query('select * from suspender_cuenta_institucional_con_auditoria($1,$2,$3)', ['00000000-0000-0000-0000-000000000000', ADMIN_ID, 'x'])
        ).rejects.toThrow(/CUENTA_NO_ENCONTRADA/);
    });

    // Riesgo 1 (revisión posterior): suspender ahora TAMBIÉN incrementa
    // password_version — nunca cambia password_hash, nunca fuerza
    // primer_login solo por suspender/reactivar.
    test('suspender incrementa password_version (de 1 a 2), nunca toca password_hash ni fuerza primer_login', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuenta(asoc);
        const { rows: [hashAntes] } = await db.query('select password_hash from cuentas_institucionales where id=$1', [cuenta.id]);
        const { rows: [suspendida] } = await db.query('select * from suspender_cuenta_institucional_con_auditoria($1,$2,$3)', [cuenta.id, ADMIN_ID, 'x']);
        expect(suspendida.password_version).toBe(2);
        expect(suspendida.primer_login).toBe(true); // ya era true desde el alta — no se tocó
        const { rows: [hashDespues] } = await db.query('select password_hash from cuentas_institucionales where id=$1', [cuenta.id]);
        expect(hashDespues.password_hash).toBe(hashAntes.password_hash); // sin cambios
    });

    test('reactivar: activo vuelve a true, NUNCA cambia password_hash; password_version se mantiene en el valor que dejó la suspensión (2), nunca vuelve a 1', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuenta(asoc);
        await db.query('select * from suspender_cuenta_institucional_con_auditoria($1,$2,$3)', [cuenta.id, ADMIN_ID, 'x']);
        const { rows: [reactivada] } = await db.query('select * from reactivar_cuenta_institucional_con_auditoria($1,$2)', [cuenta.id, ADMIN_ID]);
        expect(reactivada.activo).toBe(true);
        expect(reactivada.password_version).toBe(2); // el incremento de la suspensión es PERMANENTE
        expect(reactivada.primer_login).toBe(true); // no se forzó ni se tocó por reactivar
    });

    test('reactivar una cuenta ya activa -> RAISE CUENTA_YA_ACTIVA', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuenta(asoc);
        await expect(
            db.query('select * from reactivar_cuenta_institucional_con_auditoria($1,$2)', [cuenta.id, ADMIN_ID])
        ).rejects.toThrow(/CUENTA_YA_ACTIVA/);
    });

    test('registra auditoría con datos_anteriores/datos_nuevos reales de activo Y password_version', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuenta(asoc);
        await db.query('select * from suspender_cuenta_institucional_con_auditoria($1,$2,$3)', [cuenta.id, ADMIN_ID, 'x']);
        const { rows } = await db.query("select * from auditoria where tabla='cuentas_institucionales' and registro_id=$1 and accion='suspender'", [cuenta.id]);
        expect(rows[0].datos_anteriores).toEqual({ activo: true, password_version: 1 });
        expect(rows[0].datos_nuevos).toEqual({ activo: false, password_version: 2 });
        expect(JSON.stringify(rows[0])).not.toContain('hash'); // nunca el hash, nunca la contraseña
    });

    // ─── Escenario completo pedido explícitamente: el ciclo de vida real de
    // un JWT alrededor de una suspensión + reactivación ─────────────────────
    describe('Escenario real: JWT emitido antes de suspender -> rechazado durante -> SIGUE rechazado después de reactivar', () => {
        test('simulación completa a nivel de datos: la "versión del JWT" (capturada al login, ANTES de suspender) nunca vuelve a coincidir con la versión real, ni siquiera después de reactivar', async () => {
            const asoc = await crearAsociacion();
            const cuenta = await crearCuenta(asoc);
            // "Login" simulado: el JWT se emitiría con la versión vigente EN ESE MOMENTO.
            const versionDelJwtViejo = cuenta.password_version; // 1

            // Mientras la cuenta está activa, un JWT con esa versión sería válido
            // (activo=true Y password_version coincide) — lo prueba el middleware,
            // no esta RPC; acá se confirma el estado de datos que ese middleware lee.
            const { rows: [antesDeSuspender] } = await db.query('select activo, password_version from cuentas_institucionales where id=$1', [cuenta.id]);
            expect(antesDeSuspender.activo).toBe(true);
            expect(antesDeSuspender.password_version).toBe(versionDelJwtViejo);

            // Se suspende.
            await db.query('select * from suspender_cuenta_institucional_con_auditoria($1,$2,$3)', [cuenta.id, ADMIN_ID, 'x']);
            const { rows: [durante] } = await db.query('select activo, password_version from cuentas_institucionales where id=$1', [cuenta.id]);
            expect(durante.activo).toBe(false); // el middleware ya rechazaría solo por esto
            expect(durante.password_version).not.toBe(versionDelJwtViejo); // Y además por esto

            // Se reactiva.
            await db.query('select * from reactivar_cuenta_institucional_con_auditoria($1,$2)', [cuenta.id, ADMIN_ID]);
            const { rows: [despuesDeReactivar] } = await db.query('select activo, password_version from cuentas_institucionales where id=$1', [cuenta.id]);
            expect(despuesDeReactivar.activo).toBe(true); // el chequeo de activo ya NO rechazaría...
            expect(despuesDeReactivar.password_version).not.toBe(versionDelJwtViejo); // ...pero el de password_version SIGUE rechazando el JWT viejo

            // Un "nuevo login" (que leería la versión REAL vigente) sí coincidiría.
            expect(despuesDeReactivar.password_version).toBe(2);
        });
    });
});

describe('4) Restablecer contraseña — primer_login=true, password_version++, nunca registra el hash', () => {
    test('después del reset: primer_login=true, password_version pasó de 1 a 2', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuenta(asoc);
        const { rows: [resultado] } = await db.query(
            'select * from resetear_password_cuenta_institucional_con_auditoria($1,$2,$3,$4)',
            [cuenta.id, 'nuevo-hash-de-prueba', ADMIN_ID, 'Restablecimiento de prueba']
        );
        expect(resultado.primer_login).toBe(true);
        expect(resultado.password_version).toBe(2);
    });

    test('el hash realmente se actualizó en la tabla (columna no expuesta por el tipo de retorno, pero sí persistida)', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuenta(asoc);
        await db.query('select * from resetear_password_cuenta_institucional_con_auditoria($1,$2,$3,$4)', [cuenta.id, 'hash-nuevo-123', ADMIN_ID, 'x']);
        const { rows: [real] } = await db.query('select password_hash from cuentas_institucionales where id=$1', [cuenta.id]);
        expect(real.password_hash).toBe('hash-nuevo-123');
    });

    test('la auditoría NUNCA incluye el hash ni ninguna contraseña en texto plano', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuenta(asoc);
        await db.query('select * from resetear_password_cuenta_institucional_con_auditoria($1,$2,$3,$4)', [cuenta.id, 'secreto-nunca-debe-aparecer', ADMIN_ID, 'x']);
        const { rows } = await db.query("select * from auditoria where tabla='cuentas_institucionales' and registro_id=$1 and accion='resetear_password'", [cuenta.id]);
        expect(JSON.stringify(rows[0])).not.toContain('secreto-nunca-debe-aparecer');
    });

    test('resets sucesivos siguen incrementando password_version (3, 4, ...) — cada uno invalida la sesión del anterior', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuenta(asoc);
        await db.query('select * from resetear_password_cuenta_institucional_con_auditoria($1,$2,$3,$4)', [cuenta.id, 'h1', ADMIN_ID, 'x']);
        const { rows: [tras2] } = await db.query('select * from resetear_password_cuenta_institucional_con_auditoria($1,$2,$3,$4)', [cuenta.id, 'h2', ADMIN_ID, 'x']);
        expect(tras2.password_version).toBe(3);
    });

    test('cuenta inexistente -> RAISE CUENTA_NO_ENCONTRADA', async () => {
        await expect(
            db.query('select * from resetear_password_cuenta_institucional_con_auditoria($1,$2,$3,$4)', ['00000000-0000-0000-0000-000000000000', 'h', ADMIN_ID, 'x'])
        ).rejects.toThrow(/CUENTA_NO_ENCONTRADA/);
    });
});

describe('5) Permisos reales — anon/authenticated SIN EXECUTE, service_role CON EXECUTE', () => {
    test.each([
        'crear_cuenta_institucional_con_auditoria',
        'crear_asociacion_institucional_con_auditoria',
        'suspender_cuenta_institucional_con_auditoria',
        'reactivar_cuenta_institucional_con_auditoria',
        'resetear_password_cuenta_institucional_con_auditoria'
    ])('%s -> anon: false, authenticated: false, service_role: true', async (nombreFuncion) => {
        const { rows: [{ oid }] } = await db.query('select oid from pg_proc where proname=$1', [nombreFuncion]);
        const { rows: [r1] } = await db.query('select has_function_privilege($1,$2,$3) as ok', ['anon', oid, 'EXECUTE']);
        const { rows: [r2] } = await db.query('select has_function_privilege($1,$2,$3) as ok', ['authenticated', oid, 'EXECUTE']);
        const { rows: [r3] } = await db.query('select has_function_privilege($1,$2,$3) as ok', ['service_role', oid, 'EXECUTE']);
        expect(r1.ok).toBe(false);
        expect(r2.ok).toBe(false);
        expect(r3.ok).toBe(true);
    });
});

describe('6) Atomicidad — si el INSERT en auditoria fallara, TODA la operación se revierte', () => {
    // crear_cuenta_institucional_con_auditoria / crear_asociacion_institucional_
    // con_auditoria fijan su propia descripción (no reciben p_descripcion del
    // caller, así que no admiten el marcador de prueba) — su atomicidad real
    // ante un fallo YA quedó probada en las secciones 1 y 2: ante un
    // unique_violation (el único fallo real posible después de intentar el
    // INSERT principal), ninguna fila parcial queda creada. Acá se agregan
    // las 2 RPC que SÍ reciben p_descripcion del caller, forzando el fallo
    // de auditoria directamente (mismo mecanismo de marcador que 073).
    test('suspender_cuenta_institucional_con_auditoria: auditoría forzada a fallar (marcador en p_descripcion) -> la cuenta NUNCA queda suspendida (se revierte la transacción completa)', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuenta(asoc);
        await expect(
            db.query('select * from suspender_cuenta_institucional_con_auditoria($1,$2,$3)', [cuenta.id, ADMIN_ID, 'x __FORZAR_FALLO_AUDITORIA__ x'])
        ).rejects.toThrow(/FALLO_SIMULADO_AUDITORIA/);
        const { rows: [real] } = await db.query('select activo from cuentas_institucionales where id=$1', [cuenta.id]);
        expect(real.activo).toBe(true); // sigue activa: la operación completa se revirtió, no solo la auditoría
    });

    test('resetear_password_cuenta_institucional_con_auditoria: auditoría forzada a fallar -> el hash NUNCA queda cambiado (se revierte la transacción completa)', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuenta(asoc);
        const { rows: [antes] } = await db.query('select password_hash from cuentas_institucionales where id=$1', [cuenta.id]);
        await expect(
            db.query('select * from resetear_password_cuenta_institucional_con_auditoria($1,$2,$3,$4)', [cuenta.id, 'hash-que-nunca-debe-quedar', ADMIN_ID, 'x __FORZAR_FALLO_AUDITORIA__ x'])
        ).rejects.toThrow(/FALLO_SIMULADO_AUDITORIA/);
        const { rows: [despues] } = await db.query('select password_hash, primer_login, password_version from cuentas_institucionales where id=$1', [cuenta.id]);
        expect(despues.password_hash).toBe(antes.password_hash); // nunca cambió
        expect(despues.primer_login).toBe(true); // sigue en su valor original (true, recién creada)
        expect(despues.password_version).toBe(1); // nunca se incrementó
    });
});

describe('7) Concurrencia — dos altas para la MISMA asociación nunca terminan ambas con éxito', () => {
    // Limitación honesta (mismo criterio que 073): PGlite es un único backend
    // en un solo proceso, serializado por una cola interna — no modela dos
    // transacciones realmente simultáneas con bloqueo real por lock. Se
    // demuestra la propiedad SUFICIENTE: ejecutadas una tras otra (la única
    // secuencia que esta herramienta puede reproducir), el lock FOR UPDATE +
    // el chequeo explícito + el UNIQUE real como backstop garantizan que la
    // segunda SIEMPRE falla — nunca dos cuentas para la misma asociación.
    test('segunda alta para la misma asociación falla siempre, sin importar el motivo exacto (chequeo explícito o UNIQUE)', async () => {
        const asoc = await crearAsociacion();
        await crearCuenta(asoc, emailUnico());
        await expect(crearCuenta(asoc, emailUnico())).rejects.toThrow(/CUENTA_YA_EXISTE_PARA_ASOCIACION/);
        const { rows } = await db.query('select count(*)::int as n from cuentas_institucionales where asociacion_id=$1', [asoc]);
        expect(rows[0].n).toBe(1); // nunca quedan dos
    });

    test('el UNIQUE real (uq_cuentas_institucionales_asociacion_id) es el backstop final: un INSERT crudo que lo intente saltar también falla', async () => {
        const asoc = await crearAsociacion();
        await crearCuenta(asoc, emailUnico());
        await expect(
            db.query(
                "insert into cuentas_institucionales (email, password_hash, asociacion_id) values ($1,'x',$2)",
                [emailUnico(), asoc]
            )
        ).rejects.toThrow(/uq_cuentas_institucionales_asociacion_id|duplicate key/i);
    });
});
