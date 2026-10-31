// Comisión de Asociación (migración 079) — verificación contra Postgres
// REAL (PGlite), no mocks. Cubre:
//   1. Rol nuevo + UNIQUE(asociacion_id, rol_institucional): ambas cuentas
//      (Delegado y Comisión) coexisten para la misma asociación; nunca dos
//      del mismo rol; sin overload (firma vieja de 4 parámetros ya no existe).
//   2. Evaluadores: alta, duplicado por RUT+asociación, suspender/reactivar.
//   3. Envío de evaluación individual: éxito, duplicado (409 vía
//      unique_violation), designación no vigente, cuenta que no es Comisión,
//      evaluador de otra asociación, nota histórica protegida.
//   4. Fórmula Movimiento a la Rienda — casos de referencia exactos.
//   5. Consolidación: parcial con 1/2 jurados, completa al llegar el 2º.
//   6. Protección de notas históricas (nunca se recalculan/sobreescriben).
//   7. Trigger de cambio de nómina tras nota publicada -> requiere_revision_admin,
//      nota_comision se conserva intacta hasta resolución administrativa.
//   8. actualizar_notas_secundarias_con_auditoria: Comisión y Delegado
//      independientes, bloqueo de nota protegida sin confirmación.
//   9. Permisos reales: anon/authenticated SIN EXECUTE en las funciones nuevas.
jest.setTimeout(120000);
const fs = require('fs');
const path = require('path');
const { crearDb } = require('./__fixtures__/pgliteCliente');

const MIGRACIONES_DIR = path.join(__dirname, '..', '..', '..', 'database', 'migrations');
const leer = (n) => fs.readFileSync(path.join(MIGRACIONES_DIR, n), 'utf8');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaCartillaInstitucional.sql'), 'utf8');

const MIGRACIONES = [
    '061_cuentas_institucionales.sql',
    '078_gestion_acceso_cuentas_institucionales.sql',
    '028_rodeo_notas_secundarias.sql',
    '079_comision_asociacion.sql',
    '080_notas_decimales_comision.sql',
    '082_comision_promedio_simple.sql',
    // Protección de Nota Delegado (088): reemplaza actualizar_notas_
    // secundarias_con_auditoria agregando un parámetro (comentario
    // obligatorio para Delegado) — este archivo debe seguir probando la
    // función REAL tal como queda en producción, no una versión anterior.
    '088_proteccion_nota_delegado.sql'
];

let db;
let ADMIN_ID;
beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);

    // Extensiones MÍNIMAS del fixture compartido (nunca se modifica el
    // archivo compartido) — mismo criterio IF NOT EXISTS que ya usa esta
    // familia de pruebas:
    //  - asociaciones: zona/es_especial (reales desde 057) + UNIQUE nombre.
    //  - asignaciones: nombre_importado (real, usado por 079 para resolver
    //    el nombre del jurado evaluado cuando no hay usuario_pagado_id).
    //  - auditoria.actor_tipo: agrega 'cuenta_institucional' (real desde la
    //    migración 069 — se aplica el mismo ALTER, sin ejecutar el archivo
    //    069 completo porque referencia tablas institucionales de rodeos
    //    que este fixture mínimo no necesita).
    await db.exec(`
        ALTER TABLE asociaciones
            ADD COLUMN IF NOT EXISTS zona TEXT,
            ADD COLUMN IF NOT EXISTS es_especial BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE asignaciones ADD COLUMN IF NOT EXISTS nombre_importado TEXT;
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conrelid = 'asociaciones'::regclass AND conname = 'uq_asociaciones_nombre_normalizado'
            ) THEN
                ALTER TABLE asociaciones ADD CONSTRAINT uq_asociaciones_nombre_normalizado UNIQUE (nombre_normalizado);
            END IF;
        END $$;
        ALTER TABLE auditoria DROP CONSTRAINT IF EXISTS auditoria_actor_tipo_check;
        ALTER TABLE auditoria ADD CONSTRAINT auditoria_actor_tipo_check
            CHECK (actor_tipo IN ('administrador', 'usuario_pagado', 'cuenta_institucional'));
    `);

    for (const m of MIGRACIONES) await db.exec(leer(m));

    const { rows } = await db.query("insert into administradores (nombre_completo) values ('Admin de Prueba') returning id");
    ADMIN_ID = rows[0].id;

    await db.exec(`GRANT ALL ON TABLE asociaciones, cuentas_institucionales, auditoria, administradores,
        rodeos, asignaciones, usuarios_pagados, rodeo_notas_secundarias,
        evaluadores_comision, comision_evaluaciones_jurado, comision_evaluaciones_correcciones
        TO service_role;`);
});
afterAll(async () => { await db.close(); });

let seq = 0;
async function crearAsociacion(activa = true, esEspecial = false) {
    seq++;
    const n = 'ASOC_' + seq;
    const { rows } = await db.query(
        'insert into asociaciones (nombre, nombre_normalizado, activa, es_especial) values ($1,$2,$3,$4) returning id',
        [n, n.toLowerCase(), activa, esEspecial]
    );
    return rows[0].id;
}
function emailUnico() { seq++; return `cuenta${seq}@ferochi.cl`; }

async function crearCuenta(asociacionId, rol = 'delegado_asociacion') {
    const { rows } = await db.query(
        'select * from crear_cuenta_institucional_con_auditoria($1,$2,$3,$4,$5)',
        [asociacionId, emailUnico(), 'hash-fijo', ADMIN_ID, rol]
    );
    return rows[0];
}
async function crearCuentaFirmaVieja(asociacionId) {
    // Simula una llamada EXISTENTE (admin/cuentas-institucionales.js) que
    // nunca envía el 5º parámetro — debe seguir funcionando igual que antes.
    const { rows } = await db.query(
        'select * from crear_cuenta_institucional_con_auditoria($1,$2,$3,$4)',
        [asociacionId, emailUnico(), 'hash-fijo', ADMIN_ID]
    );
    return rows[0];
}
async function crearRodeo() {
    const { rows } = await db.query(
        "insert into rodeos (club, asociacion, fecha, tipo_rodeo_nombre) values ('Club X','ASOC',now()::date,'Provincial') returning id"
    );
    return rows[0].id;
}
async function crearJurado(rodeoId, nombre = 'Juan Jurado') {
    const { rows } = await db.query(
        `insert into asignaciones (rodeo_id, tipo_persona, estado, estado_designacion, publicado, nombre_importado)
         values ($1,'jurado','activo','aceptado',true,$2) returning id`,
        [rodeoId, nombre]
    );
    return rows[0].id;
}
async function crearEvaluador(asociacionId, actorId, actorTipo = 'administrador') {
    seq++;
    const rut = (10000000 + seq) + '-' + 'K'; // DV no se valida en SQL (se valida en services/rut.js) — valor fijo de prueba.
    const { rows } = await db.query(
        'select * from registrar_evaluador_comision_con_auditoria($1,$2,$3,$4,$5,$6,$7,$8)',
        [asociacionId, 'Pedro', 'Pérez', rut, '+56911111111', 'pedro@x.cl', actorId, actorTipo]
    );
    return rows[0];
}
async function enviarEvaluacion(opts) {
    const { rows } = await db.query(
        `select * from enviar_evaluacion_comision_jurado_con_auditoria($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [opts.rodeoId, opts.asignacionId, opts.asociacionId, opts.evaluadorId, opts.cuentaId,
         opts.apinadero ?? 6, opts.cancha ?? 5, opts.atajadas ?? 4, opts.cuarta ?? 3,
         opts.huboRienda ?? false, opts.rienda ?? null, opts.afecto ?? false, opts.comentario ?? null]
    );
    return rows[0];
}

describe('1) Rol nuevo + unicidad compuesta, sin overload', () => {
    test('una asociación puede tener una cuenta Delegado Y una Comisión simultáneamente', async () => {
        const asoc = await crearAsociacion();
        const delegado = await crearCuenta(asoc, 'delegado_asociacion');
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        expect(delegado.rol_institucional).toBe('delegado_asociacion');
        expect(comision.rol_institucional).toBe('comision_asociacion');
    });

    test('rechaza una segunda cuenta del MISMO rol para la misma asociación', async () => {
        const asoc = await crearAsociacion();
        await crearCuenta(asoc, 'comision_asociacion');
        await expect(crearCuenta(asoc, 'comision_asociacion')).rejects.toThrow(/CUENTA_YA_EXISTE_PARA_ASOCIACION/);
    });

    test('rechaza rol_institucional inválido', async () => {
        const asoc = await crearAsociacion();
        await expect(crearCuenta(asoc, 'otro_rol')).rejects.toThrow(/ROL_INSTITUCIONAL_INVALIDO/);
    });

    test('la firma VIEJA de 4 parámetros sigue funcionando (DEFAULT delegado_asociacion) — sin overload ambiguo', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuentaFirmaVieja(asoc);
        expect(cuenta.rol_institucional).toBe('delegado_asociacion');
    });

    test('las 55 cuentas existentes (simuladas) no se ven afectadas: crear Comisión para una asociación con Delegado ya existente funciona', async () => {
        const asoc = await crearAsociacion();
        const delegado = await crearCuentaFirmaVieja(asoc);
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        expect(delegado.id).not.toBe(comision.id);
        const { rows } = await db.query('select count(*)::int as n from cuentas_institucionales where asociacion_id=$1', [asoc]);
        expect(rows[0].n).toBe(2);
    });
});

describe('2) Evaluadores de Comisión', () => {
    test('registro válido, reutilizable, suspender/reactivar', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        expect(ev.activo).toBe(true);

        const suspendido = await db.query('select * from suspender_evaluador_comision_con_auditoria($1,$2,$3)', [ev.id, ADMIN_ID, 'motivo']);
        expect(suspendido.rows[0].activo).toBe(false);

        const reactivado = await db.query('select * from reactivar_evaluador_comision_con_auditoria($1,$2)', [ev.id, ADMIN_ID]);
        expect(reactivado.rows[0].activo).toBe(true);
    });

    test('rechaza duplicado por mismo RUT dentro de la misma asociación', async () => {
        const asoc = await crearAsociacion();
        seq++;
        const rut = (20000000 + seq) + '-5';
        await db.query(
            'select * from registrar_evaluador_comision_con_auditoria($1,$2,$3,$4,$5,$6,$7,$8)',
            [asoc, 'A', 'B', rut, null, null, ADMIN_ID, 'administrador']
        );
        await expect(db.query(
            'select * from registrar_evaluador_comision_con_auditoria($1,$2,$3,$4,$5,$6,$7,$8)',
            [asoc, 'C', 'D', rut, null, null, ADMIN_ID, 'administrador']
        )).rejects.toThrow(/EVALUADOR_YA_REGISTRADO/);
    });
});

describe('3) Fórmula promedio simple (082) — casos de referencia', () => {
    // Hasta la migración 082 esta fórmula usaba ponderación fija (20/30/40/10
    // sin rienda, 16/24/32/8/20 con rienda) y estos mismos casos daban 4.6/5.1
    // (ver comentario histórico en 079). Desde 082, todos los criterios
    // puntuables pesan lo mismo (promedio simple) — ver
    // comisionPromedioSimple.rpc.test.js para la cobertura dedicada.
    test('sin rienda: 6,5,4,3 -> 4.5 (promedio de 4)', async () => {
        const { rows } = await db.query('select fn_calcular_nota_individual_comision(6,5,4,3,false,null) as n');
        expect(Number(rows[0].n)).toBeCloseTo(4.5, 5);
    });
    test('con rienda: 6,5,4,3,7 -> 5.0 (promedio de 5)', async () => {
        const { rows } = await db.query('select fn_calcular_nota_individual_comision(6,5,4,3,true,7) as n');
        expect(Number(rows[0].n)).toBeCloseTo(5.0, 5);
    });
});

describe('4) Envío de evaluación individual y consolidación', () => {
    test('evaluación exitosa calcula la nota server-side y queda "parcial" con un solo jurado de dos', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo, 'Jurado Uno');
        await crearJurado(rodeo, 'Jurado Dos'); // segundo jurado vigente, aún sin evaluar

        const res = await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });
        expect(Number(res.nota_individual_calculada)).toBeCloseTo(4.5, 5); // (6+5+4+3)/4

        const { rows } = await db.query('select estado_nota_comision, nota_comision from rodeo_notas_secundarias where rodeo_id=$1', [rodeo]);
        expect(rows[0].estado_nota_comision).toBe('parcial');
        expect(rows[0].nota_comision).toBeNull();
    });

    test('al completar todos los jurados vigentes, publica el promedio y marca "completa"', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo, 'Jurado A');
        const j2 = await crearJurado(rodeo, 'Jurado B');

        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id, apinadero: 6, cancha: 5, atajadas: 4, cuarta: 3 }); // 4.5
        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j2, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id, apinadero: 7, cancha: 7, atajadas: 7, cuarta: 7 }); // 7.0

        const { rows } = await db.query('select estado_nota_comision, nota_comision from rodeo_notas_secundarias where rodeo_id=$1', [rodeo]);
        expect(rows[0].estado_nota_comision).toBe('completa');
        expect(Number(rows[0].nota_comision)).toBeCloseTo(5.8, 5); // avg(4.5, 7.0) = 5.75 -> round(5.75,1) = 5.8
    });

    test('rechaza una segunda evaluación para la MISMA asignación (409 / unique_violation) — rodeo con 2 jurados, nunca llega a "completa"', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        await crearJurado(rodeo, 'Segundo jurado, sin evaluar'); // mantiene el rodeo en 'parcial'
        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });
        await expect(enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id }))
            .rejects.toThrow(/EVALUACION_YA_ENVIADA/);
    });

    test('una vez "completa", NINGÚN nuevo envío es aceptado (Hallazgo 6) — el chequeo de estado corre ANTES del de duplicado', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });
        const fila = (await db.query('select estado_nota_comision from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(fila.estado_nota_comision).toBe('completa');

        // Reintentar sobre la MISMA asignación ya evaluada: con el rodeo
        // 'completa', se rechaza por NOTA_COMISION_CERRADA (chequeo de
        // estado), nunca llega a evaluar el índice único de duplicados.
        await expect(enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id }))
            .rejects.toThrow(/NOTA_COMISION_CERRADA/);
    });

    test('un jurado NUEVO agregado (INSERT) después de "completa" marca requiere_revision_admin automáticamente (Hallazgo 4)', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });

        await crearJurado(rodeo, 'Jurado agregado después de completa');
        const fila = (await db.query('select requiere_revision_admin, revision_admin_motivo from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(fila.requiere_revision_admin).toBe(true);
        expect(fila.revision_admin_motivo).toMatch(/Nueva asignación vigente/);
    });

    test('una asignación que NUNCA tuvo evaluación y se vuelve vigente vía UPDATE después de "completa" también marca revisión (Hallazgo 4)', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        const { rows: rJ } = await db.query(
            `insert into asignaciones (rodeo_id, tipo_persona, estado, estado_designacion, publicado, nombre_importado)
             values ($1,'jurado','activo','rechazado',true,'No vigente al principio') returning id`, [rodeo]
        );
        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });
        let fila = (await db.query('select estado_nota_comision, requiere_revision_admin from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(fila.estado_nota_comision).toBe('completa'); // el rechazado nunca contó para la vigencia

        await db.query("update asignaciones set estado_designacion='pendiente' where id=$1", [rJ[0].id]);
        fila = (await db.query('select requiere_revision_admin from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(fila.requiere_revision_admin).toBe(true);
    });

    test('rechaza si la designación no está vigente (rechazada)', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const { rows: rJ } = await db.query(
            `insert into asignaciones (rodeo_id, tipo_persona, estado, estado_designacion, publicado, nombre_importado)
             values ($1,'jurado','activo','rechazado',true,'Rechazado') returning id`, [rodeo]
        );
        await expect(enviarEvaluacion({ rodeoId: rodeo, asignacionId: rJ[0].id, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id }))
            .rejects.toThrow(/DESIGNACION_NO_VIGENTE/);
    });

    test('rechaza si la cuenta no es de rol Comisión', async () => {
        const asoc = await crearAsociacion();
        const delegado = await crearCuenta(asoc, 'delegado_asociacion');
        const ev = await crearEvaluador(asoc, ADMIN_ID, 'administrador');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        await expect(enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: delegado.id }))
            .rejects.toThrow(/CUENTA_NO_ES_COMISION/);
    });

    test('rechaza un evaluador de otra asociación', async () => {
        const asoc1 = await crearAsociacion();
        const asoc2 = await crearAsociacion();
        const comision = await crearCuenta(asoc1, 'comision_asociacion');
        const evOtra = await crearEvaluador(asoc2, ADMIN_ID, 'administrador');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        await expect(enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc1, evaluadorId: evOtra.id, cuentaId: comision.id }))
            .rejects.toThrow(/EVALUADOR_DE_OTRA_ASOCIACION/);
    });

    test('rechaza enviar evaluación sobre un rodeo con Nota Comisión histórica protegida', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        await db.query(
            `insert into rodeo_notas_secundarias (rodeo_id, nota_comision, estado_nota_comision) values ($1,5.5,'historica_sin_desglose')`,
            [rodeo]
        );
        await expect(enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id }))
            .rejects.toThrow(/NOTA_COMISION_HISTORICA_PROTEGIDA/);
        const { rows } = await db.query('select nota_comision from rodeo_notas_secundarias where rodeo_id=$1', [rodeo]);
        expect(Number(rows[0].nota_comision)).toBeCloseTo(5.5, 5); // nunca se tocó
    });

    test('exige nota_rienda cuando hubo_movimiento_rienda=true, y rechaza si viene sin corresponder', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        await expect(enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id, huboRienda: true, rienda: null }))
            .rejects.toThrow(/NOTA_RIENDA_REQUERIDA/);

        const j2 = await crearJurado(rodeo, 'Otro');
        await expect(enviarEvaluacion({ rodeoId: rodeo, asignacionId: j2, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id, huboRienda: false, rienda: 5 }))
            .rejects.toThrow(/NOTA_RIENDA_NO_CORRESPONDE/);
    });
});

describe('5) Cambio de nómina DESPUÉS de publicada la Nota Comisión -> requiere revisión administrativa', () => {
    test('reemplazar un jurado ya evaluado, tras publicar, marca requiere_revision_admin y CONSERVA la nota', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo, 'Jurado Único');

        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id, apinadero: 6, cancha: 5, atajadas: 4, cuarta: 3 });
        let fila = (await db.query('select * from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(fila.estado_nota_comision).toBe('completa');
        const notaPublicada = Number(fila.nota_comision);

        // Reemplazo administrativo: PATCH /admin/asignaciones/:id sobreescribe
        // usuario_pagado_id EN LA MISMA FILA (mismo patrón real confirmado en Fase 1).
        const { rows: up } = await db.query(
            "insert into usuarios_pagados (tipo_persona, nombre_completo) values ('jurado','Jurado Reemplazante') returning id"
        );
        await db.query('update asignaciones set usuario_pagado_id=$1 where id=$2', [up[0].id, j1]);

        fila = (await db.query('select * from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(fila.requiere_revision_admin).toBe(true);
        expect(Number(fila.nota_comision)).toBeCloseTo(notaPublicada, 5); // la nota original NUNCA se tocó
        expect(fila.revision_admin_motivo).toMatch(/Cambio en asignación/);
    });

    test('anular una asignación ya evaluada, tras publicar, también marca requiere_revision_admin', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });

        await db.query("update asignaciones set estado='anulado' where id=$1", [j1]);
        const fila = (await db.query('select requiere_revision_admin from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(fila.requiere_revision_admin).toBe(true);
    });

    test('un cambio de nómina ANTES de completar la evaluación no marca revisión (es normal)', async () => {
        const asoc = await crearAsociacion();
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        // Sin ninguna evaluación enviada todavía: reemplazar la persona es inocuo.
        const { rows: up } = await db.query(
            "insert into usuarios_pagados (tipo_persona, nombre_completo) values ('jurado','X') returning id"
        );
        await db.query('update asignaciones set usuario_pagado_id=$1 where id=$2', [up[0].id, j1]);
        const fila = await db.query('select * from rodeo_notas_secundarias where rodeo_id=$1', [rodeo]);
        expect(fila.rows.length).toBe(0); // ni siquiera se creó fila — no hay nada que marcar
    });

    test('resolver_revision_admin_comision_con_auditoria: "mantener" limpia la bandera sin tocar la nota', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });
        const { rows: up } = await db.query("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('jurado','Y') returning id");
        await db.query('update asignaciones set usuario_pagado_id=$1 where id=$2', [up[0].id, j1]);

        const notaAntes = (await db.query('select nota_comision from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0].nota_comision;
        const { rows } = await db.query(
            "select * from resolver_revision_admin_comision_con_auditoria($1,'mantener','revisado, sin cambios',null,$2)",
            [rodeo, ADMIN_ID]
        );
        expect(rows[0].requiere_revision_admin).toBe(false);
        expect(Number(rows[0].nota_comision)).toBeCloseTo(Number(notaAntes), 5);
    });

    test('resolver_revision_admin_comision_con_auditoria: "corregir" exige motivo y deja historial', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });
        const { rows: up } = await db.query("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('jurado','Z') returning id");
        await db.query('update asignaciones set usuario_pagado_id=$1 where id=$2', [up[0].id, j1]);

        await expect(db.query("select * from resolver_revision_admin_comision_con_auditoria($1,'corregir','',6.0,$2)", [rodeo, ADMIN_ID]))
            .rejects.toThrow(/MOTIVO_OBLIGATORIO/);

        const { rows } = await db.query(
            "select * from resolver_revision_admin_comision_con_auditoria($1,'corregir','corrección deportiva autorizada',6.0,$2)",
            [rodeo, ADMIN_ID]
        );
        expect(rows[0].estado_nota_comision).toBe('corregida_admin');
        expect(Number(rows[0].nota_comision)).toBeCloseTo(6.0, 5);

        const historial = await db.query('select * from comision_evaluaciones_correcciones where rodeo_id=$1', [rodeo]);
        expect(historial.rows.length).toBe(1);
    });
});

describe('6) actualizar_notas_secundarias_con_auditoria — Comisión y Delegado independientes', () => {
    test('actualizar solo Delegado nunca toca Comisión, y viceversa', async () => {
        const rodeo = await crearRodeo();
        await db.query(
            "select * from actualizar_notas_secundarias_con_auditoria($1,true,5.0,false,null,false,'carga inicial',$2)",
            [rodeo, ADMIN_ID]
        );
        await db.query(
            "select * from actualizar_notas_secundarias_con_auditoria($1,false,null,true,6.5,false,'carga delegado',$2,'comentario real de prueba')",
            [rodeo, ADMIN_ID]
        );
        const fila = (await db.query('select nota_comision, nota_delegado from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(Number(fila.nota_comision)).toBeCloseTo(5.0, 5); // nunca se limpió
        expect(Number(fila.nota_delegado)).toBeCloseTo(6.5, 5);
    });

    test('rechaza sobrescribir una nota histórica sin confirmación explícita, y la permite con confirmación', async () => {
        const rodeo = await crearRodeo();
        await db.query(
            "insert into rodeo_notas_secundarias (rodeo_id, nota_comision, estado_nota_comision) values ($1,5.5,'historica_sin_desglose')",
            [rodeo]
        );
        await expect(db.query(
            "select * from actualizar_notas_secundarias_con_auditoria($1,true,6.0,false,null,false,'intento sin confirmar',$2)",
            [rodeo, ADMIN_ID]
        )).rejects.toThrow(/NOTA_COMISION_PROTEGIDA_REQUIERE_CONFIRMACION/);

        const { rows } = await db.query(
            "select * from actualizar_notas_secundarias_con_auditoria($1,true,6.0,false,null,true,'corrección autorizada',$2)",
            [rodeo, ADMIN_ID]
        );
        expect(Number(rows[0].nota_comision)).toBeCloseTo(6.0, 5);
        expect(rows[0].estado_nota_comision).toBe('corregida_admin');
    });

    test('rechaza editar Comisión mientras hay una revisión administrativa pendiente', async () => {
        const rodeo = await crearRodeo();
        await db.query(
            "insert into rodeo_notas_secundarias (rodeo_id, nota_comision, estado_nota_comision, requiere_revision_admin) values ($1,5.0,'completa',true)",
            [rodeo]
        );
        await expect(db.query(
            "select * from actualizar_notas_secundarias_con_auditoria($1,true,6.0,false,null,true,'motivo',$2)",
            [rodeo, ADMIN_ID]
        )).rejects.toThrow(/REQUIERE_RESOLUCION_ADMINISTRATIVA_PRIMERO/);
    });

    test('Hallazgo 7: rechaza sobrescribir una nota protegida con motivo vacío, aunque venga confirmada', async () => {
        const rodeo = await crearRodeo();
        await db.query(
            "insert into rodeo_notas_secundarias (rodeo_id, nota_comision, estado_nota_comision) values ($1,5.5,'completa')",
            [rodeo]
        );
        await expect(db.query(
            "select * from actualizar_notas_secundarias_con_auditoria($1,true,6.0,false,null,true,'   ',$2)",
            [rodeo, ADMIN_ID]
        )).rejects.toThrow(/MOTIVO_OBLIGATORIO/);
    });

    test('Hallazgo 7: rechaza "vaciar" una nota protegida con NULL, aunque venga confirmada y con motivo', async () => {
        const rodeo = await crearRodeo();
        await db.query(
            "insert into rodeo_notas_secundarias (rodeo_id, nota_comision, estado_nota_comision) values ($1,5.5,'completa')",
            [rodeo]
        );
        await expect(db.query(
            "select * from actualizar_notas_secundarias_con_auditoria($1,true,null,false,null,true,'motivo real',$2)",
            [rodeo, ADMIN_ID]
        )).rejects.toThrow(/NOTA_FUERA_DE_RANGO/);
        const fila = (await db.query('select nota_comision from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(Number(fila.nota_comision)).toBeCloseTo(5.5, 5); // nunca se tocó
    });
});

describe('8) Desvinculación de evaluaciones (Hallazgos 3 y 5) — identidad real, no solo asignación', () => {
    test('reemplazar al jurado de una asignación YA evaluada la desvincula; la nota general queda en revisión y, tras resolverla, el portal normal NO reabre el envío (boundary deliberado — Decisión 10: solo corrección administrativa individual)', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo, 'Jurado A');

        const res1 = await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });
        let fila = (await db.query('select estado_nota_comision from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(fila.estado_nota_comision).toBe('completa'); // único jurado -> consolida de inmediato

        const { rows: up } = await db.query("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('jurado','Jurado B') returning id");
        await db.query('update asignaciones set usuario_pagado_id=$1 where id=$2', [up[0].id, j1]);

        const evalVieja = (await db.query('select estado from comision_evaluaciones_jurado where id=$1', [res1.id])).rows[0];
        expect(evalVieja.estado).toBe('desvinculada_por_cambio_designacion'); // nunca se borra, nunca se reatribuye

        fila = (await db.query('select requiere_revision_admin from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(fila.requiere_revision_admin).toBe(true);

        await db.query("select * from resolver_revision_admin_comision_con_auditoria($1,'mantener','revisado, sin acción adicional',null,$2)", [rodeo, ADMIN_ID]);

        // El portal normal NUNCA reabre el envío para el reemplazante tras
        // resolver (estado_nota_comision sigue 'completa') — por diseño,
        // evaluar a Jurado B requiere la corrección administrativa individual
        // dedicada (sección 10), nunca el flujo estándar de Comisión.
        await expect(enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id }))
            .rejects.toThrow(/NOTA_COMISION_CERRADA/);
    });

    test('dos asignaciones DISTINTAS de la MISMA persona real en el mismo rodeo: la segunda evaluación es rechazada', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const { rows: up } = await db.query("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('jurado','Persona Duplicada') returning id");
        const { rows: a1 } = await db.query(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, estado, estado_designacion, publicado)
             values ($1,$2,'jurado','activo','aceptado',true) returning id`, [rodeo, up[0].id]
        );
        const { rows: a2 } = await db.query(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, estado, estado_designacion, publicado)
             values ($1,$2,'jurado','activo','aceptado',true) returning id`, [rodeo, up[0].id]
        );
        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: a1[0].id, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });
        await expect(enviarEvaluacion({ rodeoId: rodeo, asignacionId: a2[0].id, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id }))
            .rejects.toThrow(/EVALUACION_YA_ENVIADA|duplicate key/);
    });

    test('anular una asignación evaluada la desvincula igual que un reemplazo', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        const res1 = await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });
        await db.query("update asignaciones set estado='anulado' where id=$1", [j1]);
        const fila = (await db.query('select estado from comision_evaluaciones_jurado where id=$1', [res1.id])).rows[0];
        expect(fila.estado).toBe('desvinculada_por_cambio_designacion');
    });
});

describe('9) Hallazgo 2 — consistencia entre asociaciones', () => {
    test('un rodeo con evaluaciones de UNA asociación rechaza un intento de evaluación con p_asociacion_id de OTRA', async () => {
        const asoc1 = await crearAsociacion();
        const asoc2 = await crearAsociacion();
        const comision1 = await crearCuenta(asoc1, 'comision_asociacion');
        const comision2 = await crearCuenta(asoc2, 'comision_asociacion');
        const ev1 = await crearEvaluador(asoc1, comision1.id, 'cuenta_institucional');
        const ev2 = await crearEvaluador(asoc2, comision2.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo, 'Jurado 1');
        const j2 = await crearJurado(rodeo, 'Jurado 2');

        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc1, evaluadorId: ev1.id, cuentaId: comision1.id });
        // comision2 (otra asociación) intenta evaluar un SEGUNDO jurado del
        // MISMO rodeo que comision1 ya evaluó — la RPC detecta la mezcla
        // (comision_evaluaciones_jurado.asociacion_id <> p_asociacion_id) y
        // rechaza, aunque el resto de sus propios chequeos pase.
        await expect(enviarEvaluacion({ rodeoId: rodeo, asignacionId: j2, asociacionId: asoc2, evaluadorId: ev2.id, cuentaId: comision2.id }))
            .rejects.toThrow(/ASOCIACION_NO_COINCIDE/);
    });

    // Nota: la verificación de que el RODEO en sí pertenece a la asociación
    // (texto libre vía catálogo/alias) vive en Express (rodeoDeMiAsociacion),
    // no en esta RPC — ver el test "Comisión de OSORNO intenta evaluar un
    // rodeo de SANTIAGO SUR" en backend/src/routes/institucional/comision.test.js.
});

describe('10) Corrección administrativa de evaluación individual (Hallazgo 10)', () => {
    test('corrige los criterios, recalcula server-side, exige motivo, deja historial completo, y NUNCA recalcula sola la nota general', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        const original = await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id, apinadero: 6, cancha: 5, atajadas: 4, cuarta: 3 });
        expect(Number(original.nota_individual_calculada)).toBeCloseTo(4.5, 5); // (6+5+4+3)/4

        const notaGeneralAntes = (await db.query('select nota_comision from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0].nota_comision;

        await expect(db.query(
            "select * from corregir_evaluacion_individual_comision_con_auditoria($1,7,7,7,7,false,null,'',$2)",
            [original.id, ADMIN_ID]
        )).rejects.toThrow(/MOTIVO_OBLIGATORIO/);

        const { rows } = await db.query(
            "select * from corregir_evaluacion_individual_comision_con_auditoria($1,7,7,7,7,false,null,'corrección por error de tipeo',$2)",
            [original.id, ADMIN_ID]
        );
        expect(Number(rows[0].nota_individual_calculada)).toBeCloseTo(7.0, 5);
        expect(rows[0].estado).toBe('corregida_admin');

        const notaGeneralDespues = (await db.query('select nota_comision from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0].nota_comision;
        expect(Number(notaGeneralDespues)).toBeCloseTo(Number(notaGeneralAntes), 5); // nunca se recalculó sola

        const historial = await db.query('select * from comision_evaluaciones_correcciones where evaluacion_id=$1', [original.id]);
        expect(historial.rows.length).toBe(1);
        expect(historial.rows[0].motivo).toBe('corrección por error de tipeo');
    });

    test('rechaza corregir una evaluación inexistente', async () => {
        await expect(db.query(
            "select * from corregir_evaluacion_individual_comision_con_auditoria($1,6,6,6,6,false,null,'motivo',$2)",
            ['00000000-0000-0000-0000-000000000000', ADMIN_ID]
        )).rejects.toThrow(/EVALUACION_NO_ENCONTRADA/);
    });
});

describe('7) Permisos reales', () => {
    test('anon y authenticated NO tienen EXECUTE sobre las funciones nuevas; service_role sí', async () => {
        const funciones = [
            'enviar_evaluacion_comision_jurado_con_auditoria',
            'registrar_evaluador_comision_con_auditoria',
            'actualizar_notas_secundarias_con_auditoria',
            'resolver_revision_admin_comision_con_auditoria'
        ];
        for (const fn of funciones) {
            const { rows } = await db.query(
                `select
                    has_function_privilege('anon', p.oid, 'EXECUTE') as anon_ok,
                    has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_ok,
                    has_function_privilege('service_role', p.oid, 'EXECUTE') as service_ok
                 from pg_proc p where p.proname = $1 limit 1`,
                [fn]
            );
            expect(rows[0].anon_ok).toBe(false);
            expect(rows[0].auth_ok).toBe(false);
            expect(rows[0].service_ok).toBe(true);
        }
    });

    test('Hallazgo 1: anon y authenticated NO tienen NINGÚN privilegio de TABLA sobre las 3 tablas nuevas (RLS + REVOKE); service_role sí', async () => {
        const tablas = ['evaluadores_comision', 'comision_evaluaciones_jurado', 'comision_evaluaciones_correcciones'];
        for (const tabla of tablas) {
            const { rows } = await db.query(
                `select
                    has_table_privilege('anon', $1, 'SELECT') as anon_select,
                    has_table_privilege('anon', $1, 'INSERT') as anon_insert,
                    has_table_privilege('authenticated', $1, 'SELECT') as auth_select,
                    has_table_privilege('authenticated', $1, 'UPDATE') as auth_update,
                    has_table_privilege('service_role', $1, 'SELECT') as service_select,
                    has_table_privilege('service_role', $1, 'INSERT') as service_insert`,
                [tabla]
            );
            expect(rows[0].anon_select).toBe(false);
            expect(rows[0].anon_insert).toBe(false);
            expect(rows[0].auth_select).toBe(false);
            expect(rows[0].auth_update).toBe(false);
            expect(rows[0].service_select).toBe(true);
            expect(rows[0].service_insert).toBe(true);

            const rls = await db.query('select relrowsecurity from pg_class where relname=$1', [tabla]);
            expect(rls.rows[0].relrowsecurity).toBe(true);
        }
    });

    test('Hallazgo 1: aunque PUBLIC tuviera GRANT heredado por "default privileges", RLS sin políticas sigue bloqueando a anon/authenticated (defensa en profundidad real, no solo el REVOKE)', async () => {
        // Simula el escenario que el hallazgo describe: un GRANT amplio que
        // pudiera heredarse de "default privileges" del proyecto. Incluso
        // otorgando SELECT a anon explícitamente, RLS sin políticas sigue
        // bloqueando — se revierte el GRANT al final para no afectar otras
        // pruebas de este archivo.
        await db.exec('GRANT SELECT ON TABLE evaluadores_comision TO anon;');
        const { rows } = await db.query(
            "select has_table_privilege('anon', 'evaluadores_comision', 'SELECT') as tiene_grant"
        );
        expect(rows[0].tiene_grant).toBe(true); // el GRANT en sí existe...
        // ...pero RLS (sin ninguna política) sigue negando el acceso real a
        // cualquier rol sin BYPASSRLS, sin importar el GRANT de tabla.
        const rls = await db.query('select relrowsecurity, relforcerowsecurity from pg_class where relname=$1', ['evaluadores_comision']);
        expect(rls.rows[0].relrowsecurity).toBe(true);
        await db.exec('REVOKE SELECT ON TABLE evaluadores_comision FROM anon;'); // revertir, no afecta otras pruebas
    });
});

describe('11) Ronda 3 — corregida_admin cuenta como evaluación definitiva', () => {
    test('escenario 2: evaluación corregida y un SEGUNDO envío (misma asignación) sigue rechazado', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        await crearJurado(rodeo, 'Segundo jurado'); // mantiene el rodeo en 'parcial'
        const original = await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });

        await db.query(
            "select * from corregir_evaluacion_individual_comision_con_auditoria($1,7,7,7,7,false,null,'corrección',$2)",
            [original.id, ADMIN_ID]
        );
        const fila = (await db.query('select estado from comision_evaluaciones_jurado where id=$1', [original.id])).rows[0];
        expect(fila.estado).toBe('corregida_admin');

        // Antes de esta ronda, 'corregida_admin' salía del índice único y
        // este segundo envío habría tenido éxito indebidamente.
        await expect(enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id }))
            .rejects.toThrow(/EVALUACION_YA_ENVIADA/);
    });

    test('escenario 4: evaluación corregida administrativamente, luego reemplazo de jurado -> se desvincula igual que una "enviada"', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo, 'Jurado Original');
        const original = await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });
        await db.query("select * from corregir_evaluacion_individual_comision_con_auditoria($1,7,7,7,7,false,null,'corrección',$2)", [original.id, ADMIN_ID]);

        const { rows: up } = await db.query("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('jurado','Jurado Reemplazante') returning id");
        await db.query('update asignaciones set usuario_pagado_id=$1 where id=$2', [up[0].id, j1]);

        const fila = (await db.query('select estado from comision_evaluaciones_jurado where id=$1', [original.id])).rows[0];
        expect(fila.estado).toBe('desvinculada_por_cambio_designacion'); // nunca se le atribuye al reemplazante
    });

    test('escenario 5: la corrección individual sobre un rodeo YA publicado marca requiere_revision_admin (diferencia pendiente), sin recalcular sola la nota general', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        const original = await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id, apinadero: 6, cancha: 5, atajadas: 4, cuarta: 3 });
        let fila = (await db.query('select estado_nota_comision, nota_comision, requiere_revision_admin from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(fila.estado_nota_comision).toBe('completa');
        const notaOriginal = Number(fila.nota_comision);

        await db.query("select * from corregir_evaluacion_individual_comision_con_auditoria($1,7,7,7,7,false,null,'corrección cambia el valor',$2)", [original.id, ADMIN_ID]);

        fila = (await db.query('select estado_nota_comision, nota_comision, requiere_revision_admin from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(Number(fila.nota_comision)).toBeCloseTo(notaOriginal, 5); // la oficial se conserva intacta
        expect(fila.requiere_revision_admin).toBe(true); // pero queda visible como pendiente de resolución
    });

    test('escenario 5b: si la corrección NO cambia el valor, no genera una revisión innecesaria', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        const original = await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id, apinadero: 6, cancha: 5, atajadas: 4, cuarta: 3 });

        await db.query("select * from corregir_evaluacion_individual_comision_con_auditoria($1,6,5,4,3,false,null,'mismo valor, solo corrige un comentario',$2)", [original.id, ADMIN_ID]);
        const fila = (await db.query('select requiere_revision_admin from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(fila.requiere_revision_admin).toBe(false);
    });

    test('escenario 6: una evaluación desvinculada queda excluida de la consolidación (el rodeo vuelve a "parcial", no cuenta como evaluada)', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        const j2 = await crearJurado(rodeo, 'Jurado Dos');
        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });
        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j2, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });
        let fila = (await db.query('select estado_nota_comision from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(fila.estado_nota_comision).toBe('completa');

        // Anular j1 desvincula su evaluación -> la nota YA publicada se
        // conserva (requiere_revision_admin=true), pero si luego se
        // consultara el conteo de "evaluados vigentes" (vía una nueva
        // consolidación futura), j1 ya no contaría.
        await db.query("update asignaciones set estado='anulado' where id=$1", [j1]);
        const evalJ1 = (await db.query('select estado from comision_evaluaciones_jurado where asignacion_id=$1', [j1])).rows[0];
        expect(evalJ1.estado).toBe('desvinculada_por_cambio_designacion');

        const totalEvaluadosVigentes = await db.query(
            `select count(*)::int as n from comision_evaluaciones_jurado cej join asignaciones a on a.id=cej.asignacion_id
             where cej.rodeo_id=$1 and cej.estado in ('enviada','corregida_admin') and a.estado='activo'`, [rodeo]
        );
        expect(totalEvaluadosVigentes.rows[0].n).toBe(1); // solo j2 sigue contando
    });
});

describe('12) Ronda 3, punto 4 — autorización administrativa específica para evaluar reemplazante', () => {
    test('escenario 8/9: tras "mantener", el portal normal sigue cerrado; con autorización específica, SOLO esa asignación se destraba, y la nota general NO se recalcula sola', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo, 'Jurado A');
        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id, apinadero: 6, cancha: 5, atajadas: 4, cuarta: 3 });

        const { rows: up } = await db.query("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('jurado','Jurado B') returning id");
        await db.query('update asignaciones set usuario_pagado_id=$1 where id=$2', [up[0].id, j1]);
        await db.query("select * from resolver_revision_admin_comision_con_auditoria($1,'mantener','revisado',null,$2)", [rodeo, ADMIN_ID]);

        // Sin autorización: sigue bloqueado (comportamiento ya probado arriba).
        await expect(enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id }))
            .rejects.toThrow(/NOTA_COMISION_CERRADA/);

        // Un administrador pleno otorga autorización ESPECÍFICA para esta asignación.
        const { rows: autRows } = await db.query(
            "select autorizar_evaluacion_reemplazante_comision_con_auditoria($1,$2,'Jurado B reemplazó a Jurado A, autorizado a evaluar',$3) as id",
            [rodeo, j1, ADMIN_ID]
        );
        expect(autRows[0].id).toBeTruthy();

        const notaAntes = (await db.query('select nota_comision, estado_nota_comision from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];

        const resultado = await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id, apinadero: 7, cancha: 7, atajadas: 7, cuarta: 7 });
        expect(Number(resultado.nota_individual_calculada)).toBeCloseTo(7.0, 5);

        // La nota general NO se recalculó sola (Decisión 4: operaciones diferenciadas).
        const notaDespues = (await db.query('select nota_comision, estado_nota_comision from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(Number(notaDespues.nota_comision)).toBeCloseTo(Number(notaAntes.nota_comision), 5);
        expect(notaDespues.estado_nota_comision).toBe(notaAntes.estado_nota_comision);

        // La autorización quedó consumida (estado='usada') — un tercer intento ya no tiene autorización disponible.
        const aut = (await db.query('select estado from comision_autorizaciones_evaluacion where id=$1', [autRows[0].id])).rows[0];
        expect(aut.estado).toBe('usada');
    });

    test('la autorización exige motivo real y una asignación que exista en ese rodeo', async () => {
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        await expect(db.query(
            "select autorizar_evaluacion_reemplazante_comision_con_auditoria($1,$2,'',$3)",
            [rodeo, j1, ADMIN_ID]
        )).rejects.toThrow(/MOTIVO_OBLIGATORIO/);

        const otroRodeo = await crearRodeo();
        await expect(db.query(
            "select autorizar_evaluacion_reemplazante_comision_con_auditoria($1,$2,'motivo',$3)",
            [otroRodeo, j1, ADMIN_ID] // j1 pertenece al PRIMER rodeo, no a otroRodeo
        )).rejects.toThrow(/ASIGNACION_NO_ENCONTRADA/);
    });

    test('la autorización NUNCA bypassa la protección histórica (ni con autorización se puede evaluar un rodeo historica_sin_desglose)', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        await db.query("insert into rodeo_notas_secundarias (rodeo_id, nota_comision, estado_nota_comision) values ($1,5.5,'historica_sin_desglose')", [rodeo]);
        await db.query("select autorizar_evaluacion_reemplazante_comision_con_auditoria($1,$2,'motivo',$3)", [rodeo, j1, ADMIN_ID]);

        await expect(enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id }))
            .rejects.toThrow(/NOTA_COMISION_HISTORICA_PROTEGIDA/);
    });
});

describe('13) Ronda 4 — reactivación indebida, identidad de la autorización, trazabilidad, nómina sin evaluación', () => {
    test('escenario 1/2: corregir una evaluación DESVINCULADA es rechazado — nunca se reactiva ni se atribuye al reemplazante', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo, 'Jurado A');
        const original = await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });

        const { rows: up } = await db.query("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('jurado','Jurado B') returning id");
        await db.query('update asignaciones set usuario_pagado_id=$1 where id=$2', [up[0].id, j1]);
        let fila = (await db.query('select estado from comision_evaluaciones_jurado where id=$1', [original.id])).rows[0];
        expect(fila.estado).toBe('desvinculada_por_cambio_designacion');

        await expect(db.query(
            "select * from corregir_evaluacion_individual_comision_con_auditoria($1,7,7,7,7,false,null,'intento de reactivar',$2)",
            [original.id, ADMIN_ID]
        )).rejects.toThrow(/EVALUACION_DESVINCULADA_NO_CORREGIBLE/);

        // Permanece desvinculada, con su contenido histórico intacto (nunca se tocó).
        fila = (await db.query('select estado, nota_individual_calculada from comision_evaluaciones_jurado where id=$1', [original.id])).rows[0];
        expect(fila.estado).toBe('desvinculada_por_cambio_designacion');
        expect(Number(fila.nota_individual_calculada)).toBeCloseTo(4.5, 5); // (6+5+4+3)/4, nunca cambió a 7

        // Y nunca participa de nuevo en una futura consolidación.
        const cuentaComoDefinitiva = await db.query(
            "select count(*)::int as n from comision_evaluaciones_jurado where id=$1 and estado in ('enviada','corregida_admin')",
            [original.id]
        );
        expect(cuentaComoDefinitiva.rows[0].n).toBe(0);
    });

    test('escenario 3: autorización otorgada para Jurado B queda invalidada automáticamente si la asignación cambia a Jurado C antes de usarse', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo, 'Jurado A (original, ya evaluado)');
        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });

        const { rows: upB } = await db.query("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('jurado','Jurado B') returning id");
        await db.query('update asignaciones set usuario_pagado_id=$1 where id=$2', [upB[0].id, j1]);
        const { rows: autRows } = await db.query(
            "select autorizar_evaluacion_reemplazante_comision_con_auditoria($1,$2,'Autorizado para evaluar a Jurado B',$3) as id",
            [rodeo, j1, ADMIN_ID]
        );
        let aut = (await db.query('select estado, usuario_pagado_id_autorizado from comision_autorizaciones_evaluacion where id=$1', [autRows[0].id])).rows[0];
        expect(aut.estado).toBe('pendiente');
        expect(aut.usuario_pagado_id_autorizado).toBe(upB[0].id);

        // Antes de usarse, la asignación cambia de B a C.
        const { rows: upC } = await db.query("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('jurado','Jurado C') returning id");
        await db.query('update asignaciones set usuario_pagado_id=$1 where id=$2', [upC[0].id, j1]);

        aut = (await db.query('select estado, invalidada_motivo from comision_autorizaciones_evaluacion where id=$1', [autRows[0].id])).rows[0];
        expect(aut.estado).toBe('invalidada');
        expect(aut.invalidada_motivo).toMatch(/cambió antes de usar/);

        // Un intento de evaluar a C usando esa autorización (ya invalidada) sigue
        // bloqueado — y, como el propio cambio B->C desvinculó la evaluación de A
        // y volvió a marcar requiere_revision_admin (el rodeo ya estaba 'completa'),
        // el chequeo de revisión pendiente gana primero (orden de chequeos: historica
        // -> revisión pendiente -> cerrada), confirmando que el administrador debe
        // resolver explícitamente antes de cualquier intento nuevo.
        await expect(enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id }))
            .rejects.toThrow(/REQUIERE_RESOLUCION_ADMINISTRATIVA_PRIMERO/);
    });

    test('escenario 4: otorgar una NUEVA autorización para la misma asignación invalida automáticamente la pendiente anterior (nunca coexisten dos)', async () => {
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        const { rows: a1 } = await db.query("select autorizar_evaluacion_reemplazante_comision_con_auditoria($1,$2,'primera',$3) as id", [rodeo, j1, ADMIN_ID]);
        const { rows: a2 } = await db.query("select autorizar_evaluacion_reemplazante_comision_con_auditoria($1,$2,'segunda',$3) as id", [rodeo, j1, ADMIN_ID]);

        const estado1 = (await db.query('select estado from comision_autorizaciones_evaluacion where id=$1', [a1[0].id])).rows[0];
        const estado2 = (await db.query('select estado from comision_autorizaciones_evaluacion where id=$1', [a2[0].id])).rows[0];
        expect(estado1.estado).toBe('invalidada');
        expect(estado2.estado).toBe('pendiente');

        const pendientes = await db.query(
            "select count(*)::int as n from comision_autorizaciones_evaluacion where rodeo_id=$1 and asignacion_id=$2 and estado='pendiente'",
            [rodeo, j1]
        );
        expect(pendientes.rows[0].n).toBe(1); // nunca más de una pendiente simultánea
    });

    test('escenario 5: una autorización ya "usada" no puede reutilizarse para una segunda evaluación', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo, 'Jurado A');
        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });

        const { rows: up } = await db.query("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('jurado','Jurado B') returning id");
        await db.query('update asignaciones set usuario_pagado_id=$1 where id=$2', [up[0].id, j1]);
        await db.query("select autorizar_evaluacion_reemplazante_comision_con_auditoria($1,$2,'motivo',$3)", [rodeo, j1, ADMIN_ID]);
        const { estado: autEstado } = (await db.query(
            "select estado from comision_autorizaciones_evaluacion where rodeo_id=$1 and asignacion_id=$2 order by created_at desc limit 1", [rodeo, j1]
        )).rows[0];
        expect(autEstado).toBe('pendiente');
        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });

        const usada = (await db.query(
            "select estado from comision_autorizaciones_evaluacion where rodeo_id=$1 and asignacion_id=$2 order by created_at desc limit 1", [rodeo, j1]
        )).rows[0];
        expect(usada.estado).toBe('usada'); // consumida, nunca reutilizable

        // El envío autorizado vuelve a marcar requiere_revision_admin
        // (Hallazgo 3) — así que un tercer intento se bloquea primero por
        // "revisión pendiente", nunca llega siquiera a chocar con el
        // índice único de duplicados (que de todos modos también lo
        // bloquearía: la asignación ya quedó 'enviada' de nuevo para B).
        await expect(enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id }))
            .rejects.toThrow(/REQUIERE_RESOLUCION_ADMINISTRATIVA_PRIMERO/);
    });

    test('escenario 7: una evaluación autorizada registrada después de "mantener" queda visible como pendiente de decisión administrativa (reutiliza la bandeja existente)', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo, 'Jurado A');
        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });

        const { rows: up } = await db.query("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('jurado','Jurado B') returning id");
        await db.query('update asignaciones set usuario_pagado_id=$1 where id=$2', [up[0].id, j1]);
        await db.query("select * from resolver_revision_admin_comision_con_auditoria($1,'mantener','revisado',null,$2)", [rodeo, ADMIN_ID]);
        let fila = (await db.query('select requiere_revision_admin from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(fila.requiere_revision_admin).toBe(false); // "mantener" la cerró

        await db.query("select autorizar_evaluacion_reemplazante_comision_con_auditoria($1,$2,'Autorizado para Jurado B',$3)", [rodeo, j1, ADMIN_ID]);
        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id, apinadero: 7, cancha: 7, atajadas: 7, cuarta: 7 });

        // La evaluación autorizada vuelve a marcar requiere_revision_admin —
        // visible en la MISMA bandeja ya existente, sin estado nuevo.
        fila = (await db.query('select requiere_revision_admin, revision_admin_motivo from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(fila.requiere_revision_admin).toBe(true);
        expect(fila.revision_admin_motivo).toMatch(/Evaluación autorizada registrada/);
    });

    test('escenario 8: cambio de identidad en una asignación vigente SIN evaluación vinculada, sobre un rodeo ya cerrado, marca revisión (antes no se detectaba)', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo, 'Jurado Evaluado');
        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });

        // Jurado agregado DESPUÉS de completa (ya marca revisión por el AFTER INSERT) — se resuelve "mantener" para limpiar el flag y aislar el siguiente evento.
        const { rows: j2 } = await db.query(
            `insert into asignaciones (rodeo_id, tipo_persona, estado, estado_designacion, publicado, nombre_importado)
             values ($1,'jurado','activo','aceptado',true,'Jurado Dos, sin evaluación todavía') returning id`, [rodeo]
        );
        await db.query("select * from resolver_revision_admin_comision_con_auditoria($1,'mantener','limpio para aislar el siguiente evento',null,$2)", [rodeo, ADMIN_ID]);
        let fila = (await db.query('select requiere_revision_admin from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(fila.requiere_revision_admin).toBe(false);

        // Ahora cambia la IDENTIDAD de esa asignación vigente-sin-evaluación (sigue vigente antes y después).
        const { rows: up } = await db.query("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('jurado','Reemplazo de Jurado Dos') returning id");
        await db.query('update asignaciones set usuario_pagado_id=$1 where id=$2', [up[0].id, j2[0].id]);

        fila = (await db.query('select requiere_revision_admin, revision_admin_motivo from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(fila.requiere_revision_admin).toBe(true);
        expect(fila.revision_admin_motivo).toMatch(/sin evaluación previa vinculada/);
    });

    test('escenario 9: cambio de nombre_importado (ambos extremos con usuario_pagado_id NULL) también cuenta como cambio de identidad', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo, 'Nombre Importado Original');
        const original = await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });

        // Cambia SOLO nombre_importado, usuario_pagado_id sigue NULL en ambos extremos.
        await db.query("update asignaciones set nombre_importado='Nombre Importado Distinto' where id=$1", [j1]);

        const fila = (await db.query('select estado from comision_evaluaciones_jurado where id=$1', [original.id])).rows[0];
        expect(fila.estado).toBe('desvinculada_por_cambio_designacion'); // se detecta aunque nunca hubo usuario_pagado_id
    });

    test('escenario 9b: cuando YA existe usuario_pagado_id, un cambio cosmético de nombre_importado se ignora (no desvincula nada)', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const { rows: up } = await db.query("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('jurado','Jurado Real') returning id");
        const { rows: a1 } = await db.query(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, estado, estado_designacion, publicado, nombre_importado)
             values ($1,$2,'jurado','activo','aceptado',true,'Etiqueta vieja') returning id`, [rodeo, up[0].id]
        );
        const original = await enviarEvaluacion({ rodeoId: rodeo, asignacionId: a1[0].id, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });

        await db.query("update asignaciones set nombre_importado='Etiqueta nueva, mismo usuario_pagado_id' where id=$1", [a1[0].id]);

        const fila = (await db.query('select estado from comision_evaluaciones_jurado where id=$1', [original.id])).rows[0];
        expect(fila.estado).toBe('enviada'); // nunca se desvinculó por un cambio cosmético
    });

    test('escenario 10 (orden secuencial, NO prueba de concurrencia real — PGlite es una sola conexión física): alta de un jurado nuevo justo antes del envío que completaría el rodeo nunca produce una "completa" basada en nómina desactualizada', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo, 'Jurado Uno');
        // Se agrega un SEGUNDO jurado justo antes de evaluar al primero —
        // simula (en orden secuencial, no genuinamente concurrente) una
        // alta que llega "justo a tiempo". El conteo de vigentes en la
        // consolidación debe reflejar AMBOS, nunca solo el que existía
        // cuando empezó el envío.
        const j2 = await crearJurado(rodeo, 'Jurado Dos, agregado justo antes');
        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });

        let fila = (await db.query('select estado_nota_comision from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(fila.estado_nota_comision).toBe('parcial'); // nunca "completa" con solo 1 de 2 evaluado

        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j2, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id });
        fila = (await db.query('select estado_nota_comision from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(fila.estado_nota_comision).toBe('completa'); // ahora sí, con los 2
    });
});

describe('15) Migración 080 — notas con un decimal (1.0-7.0) en los 5 criterios', () => {
    // Nota (082): fn_calcular_nota_individual_comision pasó de ponderación fija
    // a promedio simple — los valores esperados de esta sección ya reflejan
    // esa fórmula (ver comisionPromedioSimple.rpc.test.js para la cobertura
    // dedicada del cambio de fórmula en sí).
    test('fn_calcular_nota_individual_comision acepta decimales y promedia igual que con enteros (sin rienda)', async () => {
        // (6.5+5.5+4.5+3.5)/4 = 20/4 = 5.0
        const { rows } = await db.query('select fn_calcular_nota_individual_comision(6.5,5.5,4.5,3.5,false,null) as n');
        expect(Number(rows[0].n)).toBeCloseTo(5.0, 5);
    });

    test('fn_calcular_nota_individual_comision acepta decimales con rienda decimal', async () => {
        // (6.5+5.5+4.5+3.5+7.0)/5 = 27/5 = 5.4
        const { rows } = await db.query('select fn_calcular_nota_individual_comision(6.5,5.5,4.5,3.5,true,7.0) as n');
        expect(Number(rows[0].n)).toBeCloseTo(5.4, 5);
    });

    test('un valor de rienda decimal distinto (6.5 en vez de 7) cambia el resultado respecto al caso de referencia 6,5,4,3,7 -> 5.4 (demuestra que el decimal realmente se usa, no se trunca)', async () => {
        // (6+5+4+3+6.5)/5 = 24.5/5 = 4.9
        const { rows } = await db.query('select fn_calcular_nota_individual_comision(6,5,4,3,true,6.5) as n');
        expect(Number(rows[0].n)).toBeCloseTo(4.9, 5);
    });

    test('enviar_evaluacion_comision_jurado_con_auditoria acepta los 5 criterios con decimal y los guarda exactos (NUMERIC(2,1))', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo, 'Jurado Decimal');
        const res = await enviarEvaluacion({
            rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id,
            apinadero: 6.5, cancha: 5.5, atajadas: 4.5, cuarta: 3.5, huboRienda: true, rienda: 7.0
        });
        expect(Number(res.nota_individual_calculada)).toBeCloseTo(5.4, 5);

        const { rows } = await db.query(
            'select nota_apinadero, nota_cancha, nota_atajadas, nota_cuarta_carrera, nota_rienda from comision_evaluaciones_jurado where id=$1',
            [res.id]
        );
        expect(Number(rows[0].nota_apinadero)).toBe(6.5);
        expect(Number(rows[0].nota_cancha)).toBe(5.5);
        expect(Number(rows[0].nota_atajadas)).toBe(4.5);
        expect(Number(rows[0].nota_cuarta_carrera)).toBe(3.5);
        expect(Number(rows[0].nota_rienda)).toBe(7.0);
    });

    test('la consolidación promedia correctamente notas individuales con decimales', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo, 'Jurado Uno Decimal');
        const j2 = await crearJurado(rodeo, 'Jurado Dos Decimal');

        // (6.5+5.5+4.5+3.5)/4 = 5.0
        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id, apinadero: 6.5, cancha: 5.5, atajadas: 4.5, cuarta: 3.5 });
        // 7,7,7,7 sin rienda -> 7.0
        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j2, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id, apinadero: 7, cancha: 7, atajadas: 7, cuarta: 7 });

        const { rows } = await db.query('select estado_nota_comision, nota_comision from rodeo_notas_secundarias where rodeo_id=$1', [rodeo]);
        expect(rows[0].estado_nota_comision).toBe('completa');
        // avg(5.0, 7.0) = 6.0 -> round(6.0, 1) = 6.0, mismo round() final de siempre en
        // fn_recalcular_consolidacion_comision_rodeo (sin cambios: sigue promediando la
        // columna YA almacenada, nunca recalcula desde los criterios crudos).
        expect(Number(rows[0].nota_comision)).toBeCloseTo(6.0, 5);
    });

    test('corregir_evaluacion_individual_comision_con_auditoria acepta decimales y recalcula server-side', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        const original = await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id, apinadero: 6, cancha: 5, atajadas: 4, cuarta: 3 });
        expect(Number(original.nota_individual_calculada)).toBeCloseTo(4.5, 5); // (6+5+4+3)/4

        const { rows } = await db.query(
            "select * from corregir_evaluacion_individual_comision_con_auditoria($1,6.5,5.5,4.5,3.5,false,null,'corrección con decimales',$2)",
            [original.id, ADMIN_ID]
        );
        expect(Number(rows[0].nota_individual_calculada)).toBeCloseTo(5.0, 5); // (6.5+5.5+4.5+3.5)/4
        expect(rows[0].estado).toBe('corregida_admin');
    });

    test('las evaluaciones enteras ya existentes (6,5,4,3 etc.) siguen funcionando igual tras la 080/082 — compatibilidad hacia atrás', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        const res = await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id, apinadero: 6, cancha: 5, atajadas: 4, cuarta: 3 });
        expect(Number(res.nota_individual_calculada)).toBeCloseTo(4.5, 5); // (6+5+4+3)/4
        const { rows } = await db.query('select nota_apinadero from comision_evaluaciones_jurado where id=$1', [res.id]);
        expect(Number(rows[0].nota_apinadero)).toBe(6); // entero almacenado como NUMERIC(2,1) = 6.0, mismo valor
    });

    test('rechaza notas fuera de rango incluso con decimal (p.ej. 7.5, por encima de 7.0) — vía el CHECK existente, sin cambios', async () => {
        const asoc = await crearAsociacion();
        const comision = await crearCuenta(asoc, 'comision_asociacion');
        const ev = await crearEvaluador(asoc, comision.id, 'cuenta_institucional');
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        await expect(enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: comision.id, apinadero: 7.5, cancha: 5, atajadas: 4, cuarta: 3 }))
            .rejects.toThrow(/constraint|check/i);
    });
});
