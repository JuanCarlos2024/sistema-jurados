// Corrección final de seguridad — decisión explícita del usuario: migración
// 095, verificada contra Postgres REAL (PGlite), no mocks. Carga la cadena
// REAL completa hasta 095 (083 -> 084 -> 086 -> 091 -> 094 -> 095) para
// probar reemplazar_jurado_asignacion_con_bitacora() en su forma
// actualmente vigente — nunca una reimplementación aislada.
//
// Cubre los 7 escenarios pedidos:
//   1. Asignación rechazada (en OTRO rodeo): no bloquea indebidamente.
//   2. Asignación anulada (en OTRO rodeo): no bloquea.
//   3. Asignación vigente y aceptada (en OTRO rodeo): bloquea cuando corresponde.
//   4. Cruces reales de fechas: continúan bloqueados.
//   5. Reemplazo válido: funciona con bitácora.
//   6. Reemplazo inválido: rollback completo.
//   7. Concurrencia: mantiene las garantías existentes (advisory lock,
//      mismo criterio ya documentado y aceptado en 084/091 — sin conexiones
//      TCP concurrentes reales disponibles en este entorno local).
jest.setTimeout(120000);
const fs = require('fs');
const path = require('path');
const { crearDb } = require('./__fixtures__/pgliteCliente');

const MIGRACIONES_DIR = path.join(__dirname, '..', '..', '..', 'database', 'migrations');
const leer = (n) => fs.readFileSync(path.join(MIGRACIONES_DIR, n), 'utf8');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaBitacoraDesignaciones.sql'), 'utf8');
const MIGRACION_083 = leer('083_fase1a_bitacora_designaciones_catalogo_motivos_snapshot_notas.sql');
const MIGRACION_084 = leer('084_reemplazo_jurado_transaccional_con_bitacora.sql');
const MIGRACION_086 = leer('086_fase2c_version_control_propuestas_designacion.sql');
const MIGRACION_091 = leer('091_sincronizacion_duracion_asignaciones_rodeo.sql');
const MIGRACION_094 = leer('094_designacion_manual_con_bitacora_atomica.sql');
const MIGRACION_095 = leer('095_correccion_falso_conflicto_rechazado_reemplazo.sql');

let db; const ID = {};
async function q(sql, p) { return (await db.query(sql, p)).rows; }

beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);
    await db.exec(MIGRACION_083);
    await db.exec(MIGRACION_084);
    await db.exec(MIGRACION_086);
    await db.exec(MIGRACION_091);
    await db.exec(MIGRACION_094);
    await db.exec(MIGRACION_095);

    await db.exec(`GRANT ALL ON TABLE administradores, temporadas, usuarios_pagados, rodeos, asignaciones,
        propuestas_designacion, propuestas_designacion_detalle, notas_rodeo, evaluaciones, evaluacion_casos,
        evaluacion_escala_puntaje_nota, evaluacion_escala_calificacion, evaluacion_auditoria,
        bonos_solicitados, cartillas_jurado TO service_role;`);

    ID.admin = (await q("insert into administradores (nombre_completo) values ('Admin Test') returning id"))[0].id;
    ID.jA = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado A','A') returning id"))[0].id;
    ID.jB = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado B','A') returning id"))[0].id;

    const motivos = await q('select id, codigo from catalogo_motivos_designacion');
    ID.motivoPorCodigo = {};
    motivos.forEach((m) => { ID.motivoPorCodigo[m.codigo] = m.id; });
});
afterAll(async () => { await db.close(); });

let _rodeoSeq = 0;
async function nuevoRodeo(fecha = null, duracionDias = 1) {
    _rodeoSeq++;
    let fechaFinal = fecha;
    if (!fechaFinal) {
        const base = new Date('2028-01-01T00:00:00Z');
        base.setUTCDate(base.getUTCDate() + _rodeoSeq * 10);
        fechaFinal = base.toISOString().slice(0, 10);
    }
    const r = await q('insert into rodeos (club, asociacion, fecha, duracion_dias) values ($1,$2,$3,$4) returning id', ['Club Test', 'Osorno', fechaFinal, duracionDias]);
    return { id: r[0].id, fecha: fechaFinal, duracion_dias: duracionDias };
}
// valor_diario/duracion siempre consistentes con la duración real del
// rodeo (091/095 lo exige bajo PAGO_BASE_INCONSISTENTE_CON_DURACION) —
// nunca un pago arbitrario que no corresponda.
async function nuevaAsignacion(rodeo, juradoId, extra = {}) {
    const valorDiario = extra.valorDiario ?? 100000;
    const pagoBase = valorDiario * rodeo.duracion_dias;
    const estado = extra.estado || 'activo';
    const estadoDesignacion = extra.estado_designacion || 'pendiente';
    const r = await q(
        `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, nombre_importado, categoria_aplicada,
            valor_diario_aplicado, duracion_dias_aplicada, pago_base_calculado, estado, estado_designacion)
         values ($1,$2,'jurado','Jurado',$3,$4,$5,$6,$7,$8) returning id`,
        [rodeo.id, juradoId, 'A', valorDiario, rodeo.duracion_dias, pagoBase, estado, estadoDesignacion]
    );
    return r[0].id;
}
function reemplazar(args) {
    const valorDiario = args.valor_diario_aplicado_nuevo ?? 150000;
    const duracion = args.duracion_rodeo_destino ?? 1;
    return q(
        `select * from reemplazar_jurado_asignacion_con_bitacora(
            p_asignacion_id := $1, p_usuario_pagado_id_nuevo := $2,
            p_categoria_aplicada_nueva := $3, p_valor_diario_aplicado_nuevo := $4, p_pago_base_calculado_nuevo := $5,
            p_motivo_catalogo_id := $6, p_actor_id := $7
        )`,
        [
            args.asignacion_id, args.usuario_pagado_id_nuevo,
            args.categoria_aplicada_nueva || 'A', valorDiario,
            args.pago_base_calculado_nuevo ?? (valorDiario * duracion),
            args.motivo_catalogo_id, args.actor_id
        ]
    );
}
async function contarAsignacionesVigentes(rodeoId, juradoId) {
    return parseInt((await q(
        "select count(*)::int as n from asignaciones where rodeo_id=$1 and usuario_pagado_id=$2 and estado='activo'",
        [rodeoId, juradoId]
    ))[0].n, 10);
}

describe('1) Asignación RECHAZADA en otro rodeo — no bloquea indebidamente', () => {
    test('el jurado B tiene una designación rechazada en un rodeo que se cruzaría en fecha -> el reemplazo A->B en el rodeo destino SÍ se realiza', async () => {
        const rodeoOtro = await nuevoRodeo('2028-03-01', 2);
        await nuevaAsignacion(rodeoOtro, ID.jB, { estado_designacion: 'rechazado' });

        const rodeoDestino = await nuevoRodeo('2028-03-02', 1); // se cruzaría con rodeoOtro, de no ser rechazada
        const asigActual = await nuevaAsignacion(rodeoDestino, ID.jA, { valorDiario: 150000 });

        const [resultado] = await reemplazar({
            asignacion_id: asigActual, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin,
            duracion_rodeo_destino: 1
        });
        expect(resultado.reemplazar_jurado_asignacion_con_bitacora.asignacion.usuario_pagado_id).toBe(ID.jB);
    });
});

describe('2) Asignación ANULADA en otro rodeo — no bloquea (comportamiento ya correcto desde 084, confirmado tras 095)', () => {
    test('el jurado B tiene una designación anulada en un rodeo que se cruzaría en fecha -> el reemplazo SÍ se realiza', async () => {
        const rodeoOtro = await nuevoRodeo('2028-04-01', 2);
        await nuevaAsignacion(rodeoOtro, ID.jB, { estado: 'anulado' });

        const rodeoDestino = await nuevoRodeo('2028-04-02', 1);
        const asigActual = await nuevaAsignacion(rodeoDestino, ID.jA, { valorDiario: 150000 });

        const [resultado] = await reemplazar({
            asignacion_id: asigActual, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin,
            duracion_rodeo_destino: 1
        });
        expect(resultado.reemplazar_jurado_asignacion_con_bitacora.asignacion.usuario_pagado_id).toBe(ID.jB);
    });
});

describe('3) Asignación vigente y ACEPTADA en otro rodeo — bloquea cuando corresponde', () => {
    test('el jurado B ya está aceptado/vigente en un rodeo que se cruza en fecha -> CRUCE_DISPONIBILIDAD, nunca se aplica', async () => {
        const rodeoOtro = await nuevoRodeo('2028-05-01', 2);
        await nuevaAsignacion(rodeoOtro, ID.jB, { estado_designacion: 'aceptado' });

        const rodeoDestino = await nuevoRodeo('2028-05-02', 1);
        const asigActual = await nuevaAsignacion(rodeoDestino, ID.jA, { valorDiario: 150000 });

        await expect(reemplazar({
            asignacion_id: asigActual, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin,
            duracion_rodeo_destino: 1
        })).rejects.toThrow(/CRUCE_DISPONIBILIDAD/);
        expect(await contarAsignacionesVigentes(rodeoDestino.id, ID.jB)).toBe(0);
    });

    test('lo mismo con estado_designacion PENDIENTE (nunca revisado, pero sigue siendo una ocupación real) -> también bloquea', async () => {
        const rodeoOtro = await nuevoRodeo('2028-05-20', 2);
        await nuevaAsignacion(rodeoOtro, ID.jB, { estado_designacion: 'pendiente' });

        const rodeoDestino = await nuevoRodeo('2028-05-21', 1);
        const asigActual = await nuevaAsignacion(rodeoDestino, ID.jA, { valorDiario: 150000 });

        await expect(reemplazar({
            asignacion_id: asigActual, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin,
            duracion_rodeo_destino: 1
        })).rejects.toThrow(/CRUCE_DISPONIBILIDAD/);
    });
});

describe('4) Cruces reales de fechas — continúan bloqueados; sin cruce real, nunca bloquea', () => {
    test('fechas que NO se cruzan en absoluto -> no bloquea, aunque la otra designación esté vigente', async () => {
        const rodeoOtro = await nuevoRodeo('2028-06-01', 1);
        await nuevaAsignacion(rodeoOtro, ID.jB, { estado_designacion: 'aceptado' });

        const rodeoDestino = await nuevoRodeo('2028-06-10', 1); // sin cruce real de fechas
        const asigActual = await nuevaAsignacion(rodeoDestino, ID.jA, { valorDiario: 150000 });

        const [resultado] = await reemplazar({
            asignacion_id: asigActual, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin,
            duracion_rodeo_destino: 1
        });
        expect(resultado.reemplazar_jurado_asignacion_con_bitacora.asignacion.usuario_pagado_id).toBe(ID.jB);
    });

    test('rodeos de varios días con solapamiento parcial real -> sigue bloqueado', async () => {
        const rodeoOtro = await nuevoRodeo('2028-07-01', 3); // 01 al 03
        await nuevaAsignacion(rodeoOtro, ID.jB, { estado_designacion: 'aceptado' });

        const rodeoDestino = await nuevoRodeo('2028-07-03', 2); // 03 al 04 -> se solapa el día 03
        const asigActual = await nuevaAsignacion(rodeoDestino, ID.jA, { valorDiario: 150000 });

        await expect(reemplazar({
            asignacion_id: asigActual, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin,
            duracion_rodeo_destino: 2
        })).rejects.toThrow(/CRUCE_DISPONIBILIDAD/);
    });
});

describe('5) Reemplazo válido — funciona con bitácora', () => {
    test('reemplazo exitoso registra la bitácora con tipo_movimiento=reemplazo, snapshots correctos y causas_confirmadas NULL', async () => {
        const rodeo = await nuevoRodeo();
        const asigActual = await nuevaAsignacion(rodeo, ID.jA, { valorDiario: 100000 });

        const [resultado] = await reemplazar({
            asignacion_id: asigActual, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin,
            valor_diario_aplicado_nuevo: 150000, duracion_rodeo_destino: 1
        });
        const fila = resultado.reemplazar_jurado_asignacion_con_bitacora;
        expect(fila.asignacion.usuario_pagado_id).toBe(ID.jB);
        expect(fila.usuario_pagado_id_anterior).toBe(ID.jA);

        const bitacora = await q('select * from bitacora_designaciones where id=$1', [fila.bitacora_id]);
        expect(bitacora[0]).toEqual(expect.objectContaining({
            tipo_movimiento: 'reemplazo', asignacion_id: asigActual,
            usuario_pagado_id_anterior: ID.jA, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin,
            causas_confirmadas: null
        }));
    });
});

describe('6) Reemplazo inválido — rollback completo', () => {
    test('motivo inválido -> MOTIVO_INVALIDO, la asignación NUNCA cambia de jurado ni se crea bitácora', async () => {
        const rodeo = await nuevoRodeo();
        const asigActual = await nuevaAsignacion(rodeo, ID.jA, { valorDiario: 100000 });

        await expect(reemplazar({
            asignacion_id: asigActual, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: '00000000-0000-0000-0000-000000000000', actor_id: ID.admin,
            valor_diario_aplicado_nuevo: 150000, duracion_rodeo_destino: 1
        })).rejects.toThrow(/MOTIVO_INVALIDO/);

        const [asig] = await q('select usuario_pagado_id from asignaciones where id=$1', [asigActual]);
        expect(asig.usuario_pagado_id).toBe(ID.jA); // sin cambios
        expect(await contarAsignacionesVigentes(rodeo.id, ID.jB)).toBe(0);
    });

    test('pago inconsistente con la duración vigente -> PAGO_BASE_INCONSISTENTE_CON_DURACION, rollback completo', async () => {
        const rodeo = await nuevoRodeo(null, 2); // 2 días
        const asigActual = await nuevaAsignacion(rodeo, ID.jA, { valorDiario: 100000 });

        await expect(reemplazar({
            asignacion_id: asigActual, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin,
            valor_diario_aplicado_nuevo: 150000, pago_base_calculado_nuevo: 150000 // debería ser 300000 (×2 días)
        })).rejects.toThrow(/PAGO_BASE_INCONSISTENTE_CON_DURACION/);

        const [asig] = await q('select usuario_pagado_id, pago_base_calculado from asignaciones where id=$1', [asigActual]);
        expect(asig.usuario_pagado_id).toBe(ID.jA);
        expect(asig.pago_base_calculado).toBe(200000); // intacto (100000 × 2)
    });
});

describe('7) Concurrencia — mantiene las garantías existentes (advisory lock)', () => {
    test('dos reemplazos secuenciales que compiten por el MISMO jurado nuevo, en rodeos distintos sin cruce, se procesan en orden sin error', async () => {
        const rodeo1 = await nuevoRodeo('2028-09-01', 1);
        const asig1 = await nuevaAsignacion(rodeo1, ID.jA, { valorDiario: 100000 });
        const rodeo2 = await nuevoRodeo('2028-09-15', 1); // sin cruce con rodeo1
        const asig2 = await nuevaAsignacion(rodeo2, ID.jA, { valorDiario: 100000 });

        const jC = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado C','A') returning id"))[0].id;

        // Mismo jurado candidato (jC) para dos reemplazos en rodeos SIN
        // cruce de fechas entre sí -> el advisory lock los serializa (evita
        // una carrera real), pero NINGUNO de los dos debe fallar por eso:
        // el lock por sí solo nunca es un bloqueo de negocio, solo una
        // garantía de orden. Confirma que jC termina vigente en AMBOS
        // rodeos, sin ningún CRUCE_DISPONIBILIDAD falso.
        const [r1] = await reemplazar({ asignacion_id: asig1, usuario_pagado_id_nuevo: jC, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin, valor_diario_aplicado_nuevo: 100000, duracion_rodeo_destino: 1 });
        expect(r1.reemplazar_jurado_asignacion_con_bitacora.asignacion.usuario_pagado_id).toBe(jC);

        const [r2] = await reemplazar({ asignacion_id: asig2, usuario_pagado_id_nuevo: jC, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin, valor_diario_aplicado_nuevo: 100000, duracion_rodeo_destino: 1 });
        expect(r2.reemplazar_jurado_asignacion_con_bitacora.asignacion.usuario_pagado_id).toBe(jC);

        expect(await contarAsignacionesVigentes(rodeo1.id, jC)).toBe(1);
        expect(await contarAsignacionesVigentes(rodeo2.id, jC)).toBe(1);
    });

    test('el mismo jurado candidato, pero AHORA en rodeos que SÍ se cruzan -> el segundo reemplazo correctamente falla con CRUCE_DISPONIBILIDAD (el lock nunca oculta un conflicto genuino)', async () => {
        const rodeo1 = await nuevoRodeo('2028-10-01', 2);
        const asig1 = await nuevaAsignacion(rodeo1, ID.jA, { valorDiario: 100000 });
        const rodeo2 = await nuevoRodeo('2028-10-02', 1); // se cruza con rodeo1
        const asig2 = await nuevaAsignacion(rodeo2, ID.jA, { valorDiario: 100000 });

        const jE = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado E','A') returning id"))[0].id;

        await reemplazar({ asignacion_id: asig1, usuario_pagado_id_nuevo: jE, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin, valor_diario_aplicado_nuevo: 100000, duracion_rodeo_destino: 2 });

        await expect(reemplazar({ asignacion_id: asig2, usuario_pagado_id_nuevo: jE, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin, valor_diario_aplicado_nuevo: 100000, duracion_rodeo_destino: 1 }))
            .rejects.toThrow(/CRUCE_DISPONIBILIDAD/);
    });

    test('reemplazos secuenciales sobre jurados candidatos DISTINTOS, sin relación entre sí, nunca interfieren', async () => {
        const rodeo = await nuevoRodeo();
        const asig = await nuevaAsignacion(rodeo, ID.jA, { valorDiario: 100000 });
        const jD = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado D','A') returning id"))[0].id;

        const [resultado] = await reemplazar({ asignacion_id: asig, usuario_pagado_id_nuevo: jD, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin, valor_diario_aplicado_nuevo: 100000, duracion_rodeo_destino: 1 });
        expect(resultado.reemplazar_jurado_asignacion_con_bitacora.asignacion.usuario_pagado_id).toBe(jD);
    });
});
