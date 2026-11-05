// Corrección final de seguridad — Sección 3, verificado contra Postgres
// REAL (PGlite), no mocks. Cubre la migración 094 (crear_asignacion_con_
// bitacora + la extensión aditiva de registrar_movimiento_designacion con
// p_causas_confirmadas), que conecta una designación manual NUEVA con
// excepción confirmada con bitacora_designaciones de forma atómica: la
// creación de la asignación y el registro de la excepción se confirman o
// fallan juntos, nunca en dos pasos separados.
//
// Revisión puntual (antes de autorizar la aplicación) — añade cobertura
// para las 5 correcciones hechas sobre la versión original:
//   1. disponibilidad declarada para TODOS los días del rodeo (antes solo
//      se revisaba cruce con otras asignaciones).
//   2. consistencia de duración/pago contra la fila de rodeos bloqueada.
//   3. el cruce con otro rodeo ya no bloquea por un antecedente rechazado.
//   4. p_causas_confirmadas obligatorio, no vacío, con códigos reconocidos.
//   5. NOTIFY pgrst (verificado por inspección del archivo, no por Postgres).
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

let db; const ID = {};
async function q(sql, p) { return (await db.query(sql, p)).rows; }

beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);
    // Orden real de aplicación — 083 -> 084 -> 086 -> 091 -> 094. Se cargan
    // también 086/091 (no solo 084) para que el describe "convivencia" de
    // más abajo pueda verificar los 4 llamadores reales de
    // registrar_movimiento_designacion(), no solo el de 084.
    await db.exec(MIGRACION_083);
    await db.exec(MIGRACION_084);
    await db.exec(MIGRACION_086);
    await db.exec(MIGRACION_091);
    await db.exec(MIGRACION_094);

    await db.exec(`GRANT ALL ON TABLE administradores, temporadas, usuarios_pagados, rodeos, asignaciones,
        propuestas_designacion, propuestas_designacion_detalle, notas_rodeo, evaluaciones, evaluacion_casos,
        evaluacion_escala_puntaje_nota, evaluacion_escala_calificacion, evaluacion_auditoria,
        bonos_solicitados, cartillas_jurado TO service_role;`);

    ID.admin = (await q("insert into administradores (nombre_completo) values ('Admin Test') returning id"))[0].id;
    ID.jA = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado A','A') returning id"))[0].id;
    ID.jInactivo = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria, activo) values ('jurado','Jurado Inactivo','A', false) returning id"))[0].id;
    ID.delegado = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('delegado_rentado','Delegado X') returning id"))[0].id;

    const motivos = await q('select id, codigo, activo from catalogo_motivos_designacion');
    ID.motivoPorCodigo = {};
    motivos.forEach((m) => { ID.motivoPorCodigo[m.codigo] = m.id; });
});
afterAll(async () => { await db.close(); });

let _rodeoSeq = 0;
async function nuevoRodeo(fecha = null, duracionDias = 1) {
    _rodeoSeq++;
    let fechaFinal = fecha;
    if (!fechaFinal) {
        const base = new Date('2027-01-01T00:00:00Z');
        base.setUTCDate(base.getUTCDate() + _rodeoSeq * 10);
        fechaFinal = base.toISOString().slice(0, 10);
    }
    const r = await q('insert into rodeos (club, asociacion, fecha, duracion_dias) values ($1,$2,$3,$4) returning id', ['Club Test', 'Osorno', fechaFinal, duracionDias]);
    return { id: r[0].id, fecha: fechaFinal, duracion_dias: duracionDias };
}
async function declararDisponibilidad(usuarioId, rodeo) {
    const base = new Date(rodeo.fecha + 'T00:00:00Z');
    for (let i = 0; i < rodeo.duracion_dias; i++) {
        const d = new Date(base);
        d.setUTCDate(base.getUTCDate() + i);
        await q('insert into disponibilidad_usuarios (usuario_pagado_id, fecha) values ($1, $2)', [usuarioId, d.toISOString().slice(0, 10)]);
    }
}
function crear(args) {
    return q(
        `select * from crear_asignacion_con_bitacora(
            p_rodeo_id := $1, p_usuario_pagado_id := $2, p_categoria_aplicada := $3,
            p_valor_diario_aplicado := $4, p_duracion_dias_aplicada := $5, p_pago_base_calculado := $6,
            p_motivo_catalogo_id := $7, p_actor_id := $8, p_causas_confirmadas := $9::jsonb,
            p_motivo_detalle := $10, p_operacion_id := $11
        )`,
        [
            args.rodeo_id, args.usuario_pagado_id, args.categoria_aplicada || 'A',
            args.valor_diario_aplicado ?? 292000, args.duracion_dias_aplicada ?? 1, args.pago_base_calculado ?? 292000,
            args.motivo_catalogo_id, args.actor_id,
            args.causas_confirmadas === undefined ? JSON.stringify(['DISTANCIA_EXCEDIDA']) : (args.causas_confirmadas === null ? null : JSON.stringify(args.causas_confirmadas)),
            args.motivo_detalle || null, args.operacion_id || null
        ]
    );
}
async function contarAsignaciones(rodeoId) {
    return parseInt((await q('select count(*)::int as n from asignaciones where rodeo_id = $1', [rodeoId]))[0].n, 10);
}
async function contarBitacora(rodeoId) {
    return parseInt((await q('select count(*)::int as n from bitacora_designaciones where rodeo_id = $1', [rodeoId]))[0].n, 10);
}

describe('crear_asignacion_con_bitacora — caso normal: excepción confirmada', () => {
    test('crea la asignación Y registra la bitácora con causas_confirmadas, tipo_movimiento y motivo correctos — atómicamente', async () => {
        const rodeo = await nuevoRodeo();
        await declararDisponibilidad(ID.jA, rodeo);

        const [resultado] = await crear({
            rodeo_id: rodeo.id, usuario_pagado_id: ID.jA,
            motivo_catalogo_id: ID.motivoPorCodigo.criterio_tecnico_area_deportiva, actor_id: ID.admin,
            causas_confirmadas: ['DISTANCIA_EXCEDIDA'], motivo_detalle: 'Único jurado disponible en la zona'
        });
        const fila = resultado.crear_asignacion_con_bitacora;

        expect(fila.asignacion.usuario_pagado_id).toBe(ID.jA);
        expect(fila.asignacion.estado).toBe('activo');
        expect(fila.asignacion.estado_designacion).toBe('pendiente');
        expect(fila.bitacora_id).toBeTruthy();

        const bitacora = await q('select * from bitacora_designaciones where id = $1', [fila.bitacora_id]);
        expect(bitacora[0]).toEqual(expect.objectContaining({
            tipo_movimiento: 'designacion_manual_con_advertencia',
            asignacion_id: fila.asignacion.id,
            rodeo_id: rodeo.id,
            usuario_pagado_id_nuevo: ID.jA,
            motivo_catalogo_id: ID.motivoPorCodigo.criterio_tecnico_area_deportiva,
            motivo_detalle: 'Único jurado disponible en la zona',
            actor_id: ID.admin,
            causas_confirmadas: ['DISTANCIA_EXCEDIDA']
        }));
        expect(bitacora[0].created_at).toBeTruthy();

        expect(await contarAsignaciones(rodeo.id)).toBe(1);
        expect(await contarBitacora(rodeo.id)).toBe(1);
    });

    test('llamadores existentes de registrar_movimiento_designacion (sin causas_confirmadas) no se ven afectados: la columna queda NULL', async () => {
        const rodeo = await nuevoRodeo();
        const asigId = (await q(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, nombre_importado, categoria_aplicada,
                valor_diario_aplicado, pago_base_calculado, estado, estado_designacion)
             values ($1,$2,'jurado','Jurado A','A',100000,100000,'activo','pendiente') returning id`,
            [rodeo.id, ID.jA]
        ))[0].id;
        const [r] = await q(
            `select * from registrar_movimiento_designacion(
                p_tipo_movimiento := 'cambio_emergencia', p_rodeo_id := $1, p_actor_id := $2, p_asignacion_id := $3
            )`,
            [rodeo.id, ID.admin, asigId]
        );
        expect(r.causas_confirmadas).toBeNull();
        expect(r.tipo_movimiento).toBe('cambio_emergencia');
    });
});

describe('crear_asignacion_con_bitacora — validaciones previas y atomicidad (nunca una asignación sin su excepción registrada)', () => {
    test('sin motivo_catalogo_id -> MOTIVO_REQUERIDO, NUNCA crea la asignación', async () => {
        const rodeo = await nuevoRodeo();
        await expect(crear({ rodeo_id: rodeo.id, usuario_pagado_id: ID.jA, motivo_catalogo_id: null, actor_id: ID.admin }))
            .rejects.toThrow(/MOTIVO_REQUERIDO/);
        expect(await contarAsignaciones(rodeo.id)).toBe(0);
    });

    test('motivo_catalogo_id inexistente -> MOTIVO_INVALIDO, NUNCA crea la asignación (atomicidad: el fallo es ANTES del insert, nunca después)', async () => {
        const rodeo = await nuevoRodeo();
        await expect(crear({ rodeo_id: rodeo.id, usuario_pagado_id: ID.jA, motivo_catalogo_id: '00000000-0000-0000-0000-000000000000', actor_id: ID.admin }))
            .rejects.toThrow(/MOTIVO_INVALIDO/);
        expect(await contarAsignaciones(rodeo.id)).toBe(0);
        expect(await contarBitacora(rodeo.id)).toBe(0);
    });

    test('jurado inactivo -> JURADO_INVALIDO, NUNCA crea la asignación', async () => {
        const rodeo = await nuevoRodeo();
        await expect(crear({ rodeo_id: rodeo.id, usuario_pagado_id: ID.jInactivo, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin }))
            .rejects.toThrow(/JURADO_INVALIDO/);
        expect(await contarAsignaciones(rodeo.id)).toBe(0);
    });

    test('delegado_rentado -> JURADO_INVALIDO (esta función es exclusiva de jurados)', async () => {
        const rodeo = await nuevoRodeo();
        await expect(crear({ rodeo_id: rodeo.id, usuario_pagado_id: ID.delegado, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin }))
            .rejects.toThrow(/JURADO_INVALIDO/);
    });

    test('sin actor_id -> ACTOR_REQUERIDO', async () => {
        const rodeo = await nuevoRodeo();
        await expect(crear({ rodeo_id: rodeo.id, usuario_pagado_id: ID.jA, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: null }))
            .rejects.toThrow(/ACTOR_REQUERIDO/);
    });

    test('rodeo anulado -> RODEO_ANULADO, NUNCA crea la asignación', async () => {
        const rodeo = await nuevoRodeo();
        await q("update rodeos set estado = 'anulado' where id = $1", [rodeo.id]);
        await expect(crear({ rodeo_id: rodeo.id, usuario_pagado_id: ID.jA, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin }))
            .rejects.toThrow(/RODEO_ANULADO/);
        expect(await contarAsignaciones(rodeo.id)).toBe(0);
    });

    // Revisión puntual, punto 4 — p_causas_confirmadas obligatorio, no
    // vacío, con códigos reconocidos.
    describe('causas_confirmadas (punto 4)', () => {
        test('NULL -> CAUSAS_CONFIRMADAS_REQUERIDAS, nunca crea nada', async () => {
            const rodeo = await nuevoRodeo();
            await declararDisponibilidad(ID.jA, rodeo);
            await expect(crear({ rodeo_id: rodeo.id, usuario_pagado_id: ID.jA, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin, causas_confirmadas: null }))
                .rejects.toThrow(/CAUSAS_CONFIRMADAS_REQUERIDAS/);
            expect(await contarAsignaciones(rodeo.id)).toBe(0);
        });
        test('array vacío -> CAUSAS_CONFIRMADAS_REQUERIDAS, nunca crea nada', async () => {
            const rodeo = await nuevoRodeo();
            await declararDisponibilidad(ID.jA, rodeo);
            await expect(crear({ rodeo_id: rodeo.id, usuario_pagado_id: ID.jA, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin, causas_confirmadas: [] }))
                .rejects.toThrow(/CAUSAS_CONFIRMADAS_REQUERIDAS/);
            expect(await contarAsignaciones(rodeo.id)).toBe(0);
        });
        test('código desconocido (p. ej. uno inventado, o una causa OBLIGATORIA) -> CAUSA_CONFIRMADA_DESCONOCIDA, nunca crea nada', async () => {
            const rodeo = await nuevoRodeo();
            await declararDisponibilidad(ID.jA, rodeo);
            await expect(crear({ rodeo_id: rodeo.id, usuario_pagado_id: ID.jA, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin, causas_confirmadas: ['MISMA_ASOCIACION'] }))
                .rejects.toThrow(/CAUSA_CONFIRMADA_DESCONOCIDA/);
            expect(await contarAsignaciones(rodeo.id)).toBe(0);
        });
        test('mezcla de un código válido y uno inválido -> igual rechaza (basta uno desconocido)', async () => {
            const rodeo = await nuevoRodeo();
            await declararDisponibilidad(ID.jA, rodeo);
            await expect(crear({ rodeo_id: rodeo.id, usuario_pagado_id: ID.jA, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin, causas_confirmadas: ['DISTANCIA_EXCEDIDA', 'INVENTADA'] }))
                .rejects.toThrow(/CAUSA_CONFIRMADA_DESCONOCIDA/);
            expect(await contarAsignaciones(rodeo.id)).toBe(0);
        });
    });

    // Revisión puntual, punto 2 — consistencia de duración/pago contra la
    // fila de rodeos ya bloqueada.
    describe('consistencia de duración/pago (punto 2)', () => {
        test('duración declarada distinta de la real del rodeo -> DURACION_INCONSISTENTE_CON_RODEO, nunca crea nada', async () => {
            const rodeo = await nuevoRodeo(null, 2); // rodeo real de 2 días
            await declararDisponibilidad(ID.jA, rodeo);
            await expect(crear({ rodeo_id: rodeo.id, usuario_pagado_id: ID.jA, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin, duracion_dias_aplicada: 1, pago_base_calculado: 292000 }))
                .rejects.toThrow(/DURACION_INCONSISTENTE_CON_RODEO/);
            expect(await contarAsignaciones(rodeo.id)).toBe(0);
        });
        test('pago_base no corresponde a valor_diario × duración -> PAGO_BASE_INCONSISTENTE, nunca crea nada (rollback real: ni asignación ni bitácora)', async () => {
            const rodeo = await nuevoRodeo();
            await declararDisponibilidad(ID.jA, rodeo);
            await expect(crear({ rodeo_id: rodeo.id, usuario_pagado_id: ID.jA, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin, valor_diario_aplicado: 292000, duracion_dias_aplicada: 1, pago_base_calculado: 999999 }))
                .rejects.toThrow(/PAGO_BASE_INCONSISTENTE/);
            expect(await contarAsignaciones(rodeo.id)).toBe(0);
            expect(await contarBitacora(rodeo.id)).toBe(0);
        });
    });

    // Revisión puntual, punto 1 — disponibilidad declarada para TODOS los
    // días del rodeo (antes de esta revisión, esta función solo revisaba
    // cruces con otras asignaciones, nunca si el candidato había declarado
    // disponibilidad en absoluto).
    describe('disponibilidad declarada (punto 1)', () => {
        test('sin ninguna disponibilidad declarada -> SIN_DISPONIBILIDAD_DECLARADA, nunca crea nada', async () => {
            const rodeo = await nuevoRodeo();
            await expect(crear({ rodeo_id: rodeo.id, usuario_pagado_id: ID.jA, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin }))
                .rejects.toThrow(/SIN_DISPONIBILIDAD_DECLARADA/);
            expect(await contarAsignaciones(rodeo.id)).toBe(0);
        });
        test('rodeo de 2 días, solo declarada disponibilidad para 1 -> SIN_DISPONIBILIDAD_DECLARADA (cobertura parcial no basta)', async () => {
            const rodeo = await nuevoRodeo(null, 2);
            await q('insert into disponibilidad_usuarios (usuario_pagado_id, fecha) values ($1, $2)', [ID.jA, rodeo.fecha]); // solo el primer día
            await expect(crear({ rodeo_id: rodeo.id, usuario_pagado_id: ID.jA, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin, duracion_dias_aplicada: 2, pago_base_calculado: 584000 }))
                .rejects.toThrow(/SIN_DISPONIBILIDAD_DECLARADA/);
            expect(await contarAsignaciones(rodeo.id)).toBe(0);
        });
        test('disponibilidad declarada para TODOS los días -> pasa este chequeo y crea normalmente', async () => {
            const rodeo = await nuevoRodeo(null, 2);
            await declararDisponibilidad(ID.jA, rodeo);
            const [resultado] = await crear({ rodeo_id: rodeo.id, usuario_pagado_id: ID.jA, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin, duracion_dias_aplicada: 2, pago_base_calculado: 584000 });
            expect(resultado.crear_asignacion_con_bitacora.asignacion.usuario_pagado_id).toBe(ID.jA);
        });
    });

    test('defensa en profundidad: jurado ya designado vigente en este mismo rodeo -> JURADO_YA_DESIGNADO_EN_RODEO, atómico', async () => {
        const rodeo = await nuevoRodeo();
        await declararDisponibilidad(ID.jA, rodeo);
        await q(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, nombre_importado, categoria_aplicada,
                valor_diario_aplicado, pago_base_calculado, estado, estado_designacion)
             values ($1,$2,'jurado','Jurado A','A',100000,100000,'activo','pendiente')`,
            [rodeo.id, ID.jA]
        );
        await expect(crear({ rodeo_id: rodeo.id, usuario_pagado_id: ID.jA, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin }))
            .rejects.toThrow(/JURADO_YA_DESIGNADO_EN_RODEO/);
        expect(await contarAsignaciones(rodeo.id)).toBe(1); // solo la que ya existía, nunca una segunda
    });

    test('defensa en profundidad: cruce de fechas con OTRO rodeo -> CRUCE_DISPONIBILIDAD, atómico', async () => {
        const rodeoOtro = await nuevoRodeo('2027-06-01', 2);
        await q(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, nombre_importado, categoria_aplicada,
                valor_diario_aplicado, pago_base_calculado, estado, estado_designacion)
             values ($1,$2,'jurado','Jurado A','A',100000,100000,'activo','pendiente')`,
            [rodeoOtro.id, ID.jA]
        );
        const rodeoNuevo = await nuevoRodeo('2027-06-02', 1); // se cruza con el anterior (2027-06-01 a 2027-06-02)
        await declararDisponibilidad(ID.jA, rodeoNuevo);

        await expect(crear({ rodeo_id: rodeoNuevo.id, usuario_pagado_id: ID.jA, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin }))
            .rejects.toThrow(/CRUCE_DISPONIBILIDAD/);
        expect(await contarAsignaciones(rodeoNuevo.id)).toBe(0);
    });

    // Revisión puntual, punto 3 — un antecedente YA NO VIGENTE (designación
    // rechazada en otro rodeo) no debe bloquear una designación nueva.
    test('cruce "falso": el jurado tiene una designación RECHAZADA (nunca ejerció) en otro rodeo que se cruza en fecha -> NO bloquea, crea normalmente', async () => {
        const rodeoOtro = await nuevoRodeo('2027-07-01', 2);
        await q(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, nombre_importado, categoria_aplicada,
                valor_diario_aplicado, pago_base_calculado, estado, estado_designacion)
             values ($1,$2,'jurado','Jurado A','A',100000,100000,'activo','rechazado')`,
            [rodeoOtro.id, ID.jA]
        );
        const rodeoNuevo = await nuevoRodeo('2027-07-02', 1); // se cruzaría en fecha con rodeoOtro, de no ser rechazada
        await declararDisponibilidad(ID.jA, rodeoNuevo);

        const [resultado] = await crear({ rodeo_id: rodeoNuevo.id, usuario_pagado_id: ID.jA, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin });
        expect(resultado.crear_asignacion_con_bitacora.asignacion.usuario_pagado_id).toBe(ID.jA);
        expect(await contarAsignaciones(rodeoNuevo.id)).toBe(1);
    });
});

describe('convivencia con 084/086/091 — redefinir registrar_movimiento_designacion() no rompe a sus llamadores existentes', () => {
    test('un reemplazo normal (084/091) sigue funcionando exactamente igual después de aplicar 094, con causas_confirmadas NULL (nunca lo pasa)', async () => {
        const rodeo = await nuevoRodeo();
        const asigId = (await q(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, nombre_importado, categoria_aplicada,
                valor_diario_aplicado, pago_base_calculado, estado, estado_designacion)
             values ($1,$2,'jurado','Jurado A','A',100000,100000,'activo','pendiente') returning id`,
            [rodeo.id, ID.jA]
        ))[0].id;
        const jB = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado B','A') returning id"))[0].id;

        const [resultado] = await q(
            `select * from reemplazar_jurado_asignacion_con_bitacora(
                p_asignacion_id := $1, p_usuario_pagado_id_nuevo := $2,
                p_categoria_aplicada_nueva := 'A', p_valor_diario_aplicado_nuevo := 150000, p_pago_base_calculado_nuevo := 150000,
                p_motivo_catalogo_id := $3, p_actor_id := $4
            )`,
            [asigId, jB, ID.motivoPorCodigo.jurado_no_disponible, ID.admin]
        );
        const fila = resultado.reemplazar_jurado_asignacion_con_bitacora;
        expect(fila.asignacion.usuario_pagado_id).toBe(jB);

        const bitacora = await q('select * from bitacora_designaciones where id = $1', [fila.bitacora_id]);
        expect(bitacora[0].tipo_movimiento).toBe('reemplazo');
        expect(bitacora[0].causas_confirmadas).toBeNull();
    });

    test('modificar_jurado_propuesta_borrador (086) sigue funcionando después de 094', async () => {
        const rodeo = await nuevoRodeo();
        const propId = (await q("insert into propuestas_designacion (estado) values ('BORRADOR') returning id"))[0].id;
        const detalleId = (await q(
            `insert into propuestas_designacion_detalle (propuesta_id, rodeo_id, jurado_id_propuesto, estado_revision)
             values ($1, $2, $3, 'PENDIENTE') returning id`,
            [propId, rodeo.id, ID.jA]
        ))[0].id;
        const jB = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado B2','A') returning id"))[0].id;

        const [resultado] = await q(
            `select * from modificar_jurado_propuesta_borrador(
                p_detalle_id := $1, p_jurado_id_nuevo := $2, p_estado_revision_nuevo := 'MODIFICADO',
                p_origen_seleccion_nuevo := 'MANUAL', p_motivo_catalogo_id := $3, p_actor_id := $4
            )`,
            [detalleId, jB, ID.motivoPorCodigo.otro, ID.admin]
        );
        const fila = resultado.modificar_jurado_propuesta_borrador;
        expect(fila.detalle.jurado_id_seleccionado).toBe(jB);
        const bitacora = await q('select * from bitacora_designaciones where id = $1', [fila.bitacora_id]);
        expect(bitacora[0].tipo_movimiento).toBe('modificacion_manual_borrador');
        expect(bitacora[0].causas_confirmadas).toBeNull();
    });
});

describe('permisos — mismo criterio que 083/084', () => {
    test('solo service_role puede ejecutar crear_asignacion_con_bitacora — nunca anon/authenticated/PUBLIC', async () => {
        const grants = await q(`
            select grantee, privilege_type from information_schema.routine_privileges
            where routine_name = 'crear_asignacion_con_bitacora'
        `);
        const grantees = grants.map(g => g.grantee);
        expect(grantees).toContain('service_role');
        expect(grantees).not.toContain('anon');
        expect(grantees).not.toContain('authenticated');
        expect(grantees).not.toContain('PUBLIC');
    });

    test('registrar_movimiento_designacion (nueva firma de 15 parámetros) también restringida a service_role', async () => {
        const grants = await q(`
            select grantee, privilege_type from information_schema.routine_privileges
            where routine_name = 'registrar_movimiento_designacion'
        `);
        const grantees = grants.map(g => g.grantee);
        expect(grantees).toContain('service_role');
        expect(grantees).not.toContain('anon');
        expect(grantees).not.toContain('authenticated');
        expect(grantees).not.toContain('PUBLIC');
    });

    test('bitacora_designaciones sigue sin UPDATE/DELETE para service_role tras la 094 (append-only intacto)', async () => {
        const grants = await q(`
            select privilege_type from information_schema.role_table_grants
            where table_name = 'bitacora_designaciones' and grantee = 'service_role'
        `);
        const tipos = grants.map(g => g.privilege_type);
        expect(tipos).toEqual(expect.arrayContaining(['SELECT', 'INSERT']));
        expect(tipos).not.toContain('UPDATE');
        expect(tipos).not.toContain('DELETE');
    });
});

describe('revisión puntual, punto 5 — NOTIFY pgrst por inspección estática del archivo', () => {
    test('la migración emite NOTIFY pgrst, \'reload schema\' dentro de la transacción, antes de COMMIT', () => {
        const sql = MIGRACION_094;
        const idxNotify = sql.indexOf("NOTIFY pgrst, 'reload schema';");
        const idxCommit = sql.lastIndexOf('COMMIT;');
        expect(idxNotify).toBeGreaterThan(-1);
        expect(idxCommit).toBeGreaterThan(idxNotify);
    });
});
