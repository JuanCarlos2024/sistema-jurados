// Fase 2C — control de versiones/cambios de propuestas de designación,
// verificado contra Postgres REAL (PGlite), no mocks. Cubre la migración 086
// (modificar_jurado_propuesta_borrador, aplicar_propuesta_designacion_completa),
// que reutiliza bitacora_designaciones (083) y el MISMO espacio de advisory
// lock por jurado que reemplazar_jurado_asignacion_con_bitacora (084) —
// mismo patrón de pruebas exacto que reemplazoJuradoAsignacion.rpc.test.js.
//
// Revisión correctiva — la versión anterior de esta migración traía
// aplicar_detalle_propuesta_designacion (una RPC por FILA, no por
// propuesta): esa función fue ELIMINADA (reemplazada por
// aplicar_propuesta_designacion_completa, que procesa el LOTE completo en
// UNA sola transacción) precisamente porque un RPC por fila no puede
// garantizar "todo o nada" — con 19 de 20 filas insertadas con éxito y la
// 20ª fallando, las 19 ya habrían quedado confirmadas. El describe
// "aplicar_propuesta_designacion_completa — atomicidad real" más abajo
// reproduce ese caso exacto.
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

let db; const ID = {};
async function q(sql, p) { return (await db.query(sql, p)).rows; }

beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);
    await db.exec(MIGRACION_083);
    await db.exec(MIGRACION_084);
    await db.exec(MIGRACION_086);

    await db.exec(`GRANT ALL ON TABLE administradores, temporadas, usuarios_pagados, rodeos, asignaciones,
        propuestas_designacion, propuestas_designacion_detalle, notas_rodeo, evaluaciones, evaluacion_casos,
        evaluacion_escala_puntaje_nota, evaluacion_escala_calificacion, evaluacion_auditoria,
        bonos_solicitados, cartillas_jurado, disponibilidad_usuarios TO service_role;`);

    ID.admin = (await q("insert into administradores (nombre_completo) values ('Admin Fase2C') returning id"))[0].id;
    ID.jA = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado A','A') returning id"))[0].id;
    ID.jB = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado B','A') returning id"))[0].id;
    ID.jC = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado C','A') returning id"))[0].id;
    ID.jInactivo = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria, activo) values ('jurado','Jurado Inactivo','A', false) returning id"))[0].id;
    ID.delegado = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('delegado_rentado','Delegado X') returning id"))[0].id;

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
        const base = new Date('2026-01-01T00:00:00Z');
        base.setUTCDate(base.getUTCDate() + _rodeoSeq * 10);
        fechaFinal = base.toISOString().slice(0, 10);
    }
    const r = await q('insert into rodeos (club, asociacion, fecha, duracion_dias) values ($1,$2,$3,$4) returning id', ['Club Test 2C', 'Osorno', fechaFinal, duracionDias]);
    return r[0].id;
}
async function nuevaPropuesta(estado = 'BORRADOR') {
    const r = await q("insert into propuestas_designacion (estado, creado_por) values ($1, $2) returning id", [estado, ID.admin]);
    return r[0].id;
}
async function nuevoDetalle(propuestaId, rodeoId, extra = {}) {
    const r = await q(
        `insert into propuestas_designacion_detalle (propuesta_id, rodeo_id, jurado_id_propuesto, jurado_id_seleccionado, estado_revision, origen_seleccion)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [propuestaId, rodeoId, extra.jurado_id_propuesto ?? null, extra.jurado_id_seleccionado ?? null,
            extra.estado_revision || 'PENDIENTE', extra.origen_seleccion ?? null]
    );
    return r[0].id;
}
function modificar(args) {
    return q(
        `select * from modificar_jurado_propuesta_borrador(
            p_detalle_id := $1, p_jurado_id_nuevo := $2, p_estado_revision_nuevo := $3,
            p_origen_seleccion_nuevo := $4, p_motivo_catalogo_id := $5, p_actor_id := $6, p_motivo_detalle := $7
        )`,
        [args.detalle_id, args.jurado_id_nuevo, args.estado_revision_nuevo || 'MODIFICADO',
            args.origen_seleccion_nuevo || 'MANUAL', args.motivo_catalogo_id, args.actor_id, args.motivo_detalle || null]
    );
}
// Declara disponibilidad para TODAS las fechas de un rodeo — la RPC de lote
// ahora revalida esto dentro de la transacción (sección 1 de la revisión).
async function declararDisponibilidad(juradoId, fecha, duracionDias = 1) {
    const base = new Date(fecha + 'T00:00:00Z');
    for (let i = 0; i < duracionDias; i++) {
        const d = new Date(base);
        d.setUTCDate(base.getUTCDate() + i);
        await q('insert into disponibilidad_usuarios (usuario_pagado_id, fecha) values ($1, $2) on conflict do nothing', [juradoId, d.toISOString().slice(0, 10)]);
    }
}
function aplicarLote(propuestaId, actorId, aplicaciones) {
    return q(
        `select * from aplicar_propuesta_designacion_completa(
            p_propuesta_id := $1, p_actor_id := $2, p_aplicaciones := $3::jsonb
        )`,
        [propuestaId, actorId, JSON.stringify(aplicaciones)]
    );
}
// Construye un detalle ACEPTADO con disponibilidad ya declarada — atajo
// para los tests de aplicación en lote, que necesitan muchas filas válidas.
async function detalleAplicable(propuestaId, juradoId, fecha, duracionDias = 1) {
    const rodeoId = await nuevoRodeo(fecha, duracionDias);
    await declararDisponibilidad(juradoId, fecha, duracionDias);
    const detalleId = await nuevoDetalle(propuestaId, rodeoId, { jurado_id_propuesto: juradoId, jurado_id_seleccionado: juradoId, estado_revision: 'ACEPTADO', origen_seleccion: 'MOTOR' });
    return { detalleId, rodeoId };
}

describe('modificar_jurado_propuesta_borrador — caso normal', () => {
    test('actualiza el detalle y registra el movimiento en la bitácora, atómicamente', async () => {
        const propId = await nuevaPropuesta();
        const rodeoId = await nuevoRodeo();
        const detalleId = await nuevoDetalle(propId, rodeoId, { jurado_id_propuesto: ID.jA, estado_revision: 'PENDIENTE' });

        const [r] = await modificar({
            detalle_id: detalleId, jurado_id_nuevo: ID.jB,
            motivo_catalogo_id: ID.motivoPorCodigo.criterio_tecnico_area_deportiva, actor_id: ID.admin
        });
        const resultado = r.modificar_jurado_propuesta_borrador;

        expect(resultado.detalle.jurado_id_seleccionado).toBe(ID.jB);
        expect(resultado.detalle.estado_revision).toBe('MODIFICADO');
        expect(resultado.detalle.origen_seleccion).toBe('MANUAL');
        expect(resultado.bitacora_id).toBeTruthy();

        const [bitacora] = await q('select * from bitacora_designaciones where id = $1', [resultado.bitacora_id]);
        expect(bitacora.propuesta_detalle_id).toBe(detalleId);
        expect(bitacora.rodeo_id).toBe(rodeoId);
        expect(bitacora.usuario_pagado_id_anterior).toBeNull(); // nunca había seleccionado nadie
        expect(bitacora.usuario_pagado_id_nuevo).toBe(ID.jB);
        expect(bitacora.nombre_nuevo_snapshot).toBe('Jurado B');
        expect(bitacora.tipo_movimiento).toBe('modificacion_manual_borrador');
        expect(bitacora.motivo_catalogo_id).toBe(ID.motivoPorCodigo.criterio_tecnico_area_deportiva);

        const [detalle] = await q('select * from propuestas_designacion_detalle where id = $1', [detalleId]);
        expect(detalle.jurado_id_seleccionado).toBe(ID.jB);
        // jurado_id_propuesto (V1) NUNCA se toca — invariante central de Fase 2C sección 2.
        expect(detalle.jurado_id_propuesto).toBe(ID.jA);
    });
});

describe('modificar_jurado_propuesta_borrador — historial sucesivo (V1 -> V2 -> V3)', () => {
    test('cada modificación registra correctamente su propio anterior/nuevo, V1 (jurado_id_propuesto) nunca cambia', async () => {
        const propId = await nuevaPropuesta();
        const rodeoId = await nuevoRodeo();
        const detalleId = await nuevoDetalle(propId, rodeoId, { jurado_id_propuesto: ID.jA, estado_revision: 'PENDIENTE' });

        await modificar({ detalle_id: detalleId, jurado_id_nuevo: ID.jB, motivo_catalogo_id: ID.motivoPorCodigo.rechazo_designacion, actor_id: ID.admin });
        const [r2] = await modificar({ detalle_id: detalleId, jurado_id_nuevo: ID.jC, motivo_catalogo_id: ID.motivoPorCodigo.ajuste_categoria, actor_id: ID.admin });
        const resultado2 = r2.modificar_jurado_propuesta_borrador;

        const [bitacora2] = await q('select * from bitacora_designaciones where id = $1', [resultado2.bitacora_id]);
        expect(bitacora2.usuario_pagado_id_anterior).toBe(ID.jB);
        expect(bitacora2.usuario_pagado_id_nuevo).toBe(ID.jC);

        const historial = await q('select * from bitacora_designaciones where propuesta_detalle_id = $1 order by created_at', [detalleId]);
        expect(historial.length).toBe(2);
        expect(historial[0].usuario_pagado_id_nuevo).toBe(ID.jB);
        expect(historial[1].usuario_pagado_id_nuevo).toBe(ID.jC);

        const [detalle] = await q('select * from propuestas_designacion_detalle where id = $1', [detalleId]);
        expect(detalle.jurado_id_propuesto).toBe(ID.jA); // V1 intacto tras 2 modificaciones
        expect(detalle.jurado_id_seleccionado).toBe(ID.jC); // estado actual
    });
});

describe('modificar_jurado_propuesta_borrador — validaciones', () => {
    test('sin motivo -> MOTIVO_REQUERIDO, nada se modifica', async () => {
        const propId = await nuevaPropuesta();
        const rodeoId = await nuevoRodeo();
        const detalleId = await nuevoDetalle(propId, rodeoId);

        await expect(modificar({ detalle_id: detalleId, jurado_id_nuevo: ID.jB, motivo_catalogo_id: null, actor_id: ID.admin }))
            .rejects.toThrow(/MOTIVO_REQUERIDO/);
        const [detalle] = await q('select * from propuestas_designacion_detalle where id = $1', [detalleId]);
        expect(detalle.jurado_id_seleccionado).toBeNull();
    });

    test('sin actor -> ACTOR_REQUERIDO', async () => {
        const propId = await nuevaPropuesta();
        const rodeoId = await nuevoRodeo();
        const detalleId = await nuevoDetalle(propId, rodeoId);
        await expect(modificar({ detalle_id: detalleId, jurado_id_nuevo: ID.jB, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: null }))
            .rejects.toThrow(/ACTOR_REQUERIDO/);
    });

    test('motivo inexistente -> MOTIVO_INVALIDO', async () => {
        const propId = await nuevaPropuesta();
        const rodeoId = await nuevoRodeo();
        const detalleId = await nuevoDetalle(propId, rodeoId);
        await expect(modificar({ detalle_id: detalleId, jurado_id_nuevo: ID.jB, motivo_catalogo_id: '00000000-0000-0000-0000-000000000000', actor_id: ID.admin }))
            .rejects.toThrow(/MOTIVO_INVALIDO/);
    });

    test('jurado nuevo inactivo -> JURADO_NUEVO_INVALIDO', async () => {
        const propId = await nuevaPropuesta();
        const rodeoId = await nuevoRodeo();
        const detalleId = await nuevoDetalle(propId, rodeoId);
        await expect(modificar({ detalle_id: detalleId, jurado_id_nuevo: ID.jInactivo, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin }))
            .rejects.toThrow(/JURADO_NUEVO_INVALIDO/);
    });

    test('jurado nuevo es delegado rentado (no jurado) -> JURADO_NUEVO_INVALIDO', async () => {
        const propId = await nuevaPropuesta();
        const rodeoId = await nuevoRodeo();
        const detalleId = await nuevoDetalle(propId, rodeoId);
        await expect(modificar({ detalle_id: detalleId, jurado_id_nuevo: ID.delegado, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin }))
            .rejects.toThrow(/JURADO_NUEVO_INVALIDO/);
    });

    test('propuesta ya no es BORRADOR -> PROPUESTA_NO_ES_BORRADOR, nada se modifica', async () => {
        const propId = await nuevaPropuesta('CONFIRMADA');
        const rodeoId = await nuevoRodeo();
        const detalleId = await nuevoDetalle(propId, rodeoId);
        await expect(modificar({ detalle_id: detalleId, jurado_id_nuevo: ID.jB, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin }))
            .rejects.toThrow(/PROPUESTA_NO_ES_BORRADOR/);
    });

    test('estado_revision_nuevo inválido -> ESTADO_REVISION_INVALIDO', async () => {
        const propId = await nuevaPropuesta();
        const rodeoId = await nuevoRodeo();
        const detalleId = await nuevoDetalle(propId, rodeoId);
        await expect(modificar({ detalle_id: detalleId, jurado_id_nuevo: ID.jB, estado_revision_nuevo: 'PENDIENTE', motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin }))
            .rejects.toThrow(/ESTADO_REVISION_INVALIDO/);
    });

    test('atomicidad: si la escritura en bitácora falla (actor inexistente en administradores), el detalle NO queda modificado', async () => {
        const propId = await nuevaPropuesta();
        const rodeoId = await nuevoRodeo();
        const detalleId = await nuevoDetalle(propId, rodeoId);
        const actorInexistente = '11111111-1111-1111-1111-111111111111';

        await expect(modificar({ detalle_id: detalleId, jurado_id_nuevo: ID.jB, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: actorInexistente }))
            .rejects.toThrow();

        const [detalle] = await q('select * from propuestas_designacion_detalle where id = $1', [detalleId]);
        expect(detalle.jurado_id_seleccionado).toBeNull(); // el UPDATE se revirtió junto con el INSERT fallido
        const historial = await q('select * from bitacora_designaciones where propuesta_detalle_id = $1', [detalleId]);
        expect(historial.length).toBe(0);
    });

    // Revisión correctiva, Decisión 2 — una fila que ya generó una
    // asignación real (por una aplicación anterior) nunca puede modificarse
    // desde el borrador.
    test('detalle ya aplicado (asignación real vinculada) -> DETALLE_YA_APLICADO, nada se modifica', async () => {
        const propId = await nuevaPropuesta();
        const { detalleId } = await detalleAplicable(propId, ID.jA, '2026-03-01');
        await aplicarLote(propId, ID.admin, [{ detalle_id: detalleId, usuario_pagado_id: ID.jA, categoria_aplicada: 'A', valor_diario_aplicado: 100000, pago_base_calculado: 100000, duracion_dias_aplicada: 1 }]);

        await expect(modificar({ detalle_id: detalleId, jurado_id_nuevo: ID.jB, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin }))
            .rejects.toThrow(/DETALLE_YA_APLICADO/);

        const [detalle] = await q('select * from propuestas_designacion_detalle where id = $1', [detalleId]);
        expect(detalle.jurado_id_seleccionado).toBe(ID.jA); // sin cambios
    });
});

describe('aplicar_propuesta_designacion_completa — caso normal', () => {
    test('crea todas las asignaciones reales y registra aplicacion_propuesta en la bitácora de cada una', async () => {
        const propId = await nuevaPropuesta();
        const { detalleId: d1, rodeoId: r1 } = await detalleAplicable(propId, ID.jA, '2026-07-01');
        const { detalleId: d2, rodeoId: r2 } = await detalleAplicable(propId, ID.jB, '2026-07-08');

        const [r] = await aplicarLote(propId, ID.admin, [
            { detalle_id: d1, usuario_pagado_id: ID.jA, categoria_aplicada: 'A', valor_diario_aplicado: 100000, pago_base_calculado: 100000, duracion_dias_aplicada: 1 },
            { detalle_id: d2, usuario_pagado_id: ID.jB, categoria_aplicada: 'A', valor_diario_aplicado: 100000, pago_base_calculado: 100000, duracion_dias_aplicada: 1 }
        ]);
        const resultado = r.aplicar_propuesta_designacion_completa;

        expect(resultado.aplicadas.length).toBe(2);
        const asigs = await q('select * from asignaciones where propuesta_detalle_id in ($1, $2)', [d1, d2]);
        expect(asigs.length).toBe(2);
        expect(asigs.every(a => a.estado === 'activo' && a.publicado === false)).toBe(true);

        const movimientos = await q(
            "select propuesta_detalle_id, tipo_movimiento, actor_id from bitacora_designaciones where propuesta_detalle_id in ($1, $2)", [d1, d2]
        );
        expect(movimientos.length).toBe(2);
        expect(movimientos.every(m => m.tipo_movimiento === 'aplicacion_propuesta' && m.actor_id === ID.admin)).toBe(true);
        expect(r1).toBeTruthy(); expect(r2).toBeTruthy();
    });

    // Sección 2 del pedido de revisión — trazabilidad real de la
    // AUTORIZACIÓN DE APLICAR sobre una fila que NUNCA fue revisada
    // individualmente (sigue PENDIENTE): se aplica igual (tiene jurado
    // efectivo: jurado_id_propuesto), y el movimiento registrado es
    // 'aplicacion_propuesta' — nunca 'modificacion_manual_borrador', que
    // falsamente implicaría una decisión administrativa por fila.
    test('una fila PENDIENTE se aplica (tiene jurado efectivo) con tipo_movimiento aplicacion_propuesta, nunca modificacion_manual_borrador', async () => {
        const propId = await nuevaPropuesta();
        const rodeoId = await nuevoRodeo('2026-07-15');
        await declararDisponibilidad(ID.jA, '2026-07-15');
        const detalleId = await nuevoDetalle(propId, rodeoId, { jurado_id_propuesto: ID.jA, jurado_id_seleccionado: null, estado_revision: 'PENDIENTE', origen_seleccion: null });

        await aplicarLote(propId, ID.admin, [
            { detalle_id: detalleId, usuario_pagado_id: ID.jA, categoria_aplicada: 'A', valor_diario_aplicado: 100000, pago_base_calculado: 100000, duracion_dias_aplicada: 1 }
        ]);

        const [movimiento] = await q('select tipo_movimiento from bitacora_designaciones where propuesta_detalle_id = $1', [detalleId]);
        expect(movimiento.tipo_movimiento).toBe('aplicacion_propuesta');
        // la fila de detalle en sí NUNCA se reescribe a ACEPTADO/MODIFICADO —
        // sigue mostrando, con honestidad, que nadie la revisó individualmente.
        const [detalle] = await q('select estado_revision from propuestas_designacion_detalle where id = $1', [detalleId]);
        expect(detalle.estado_revision).toBe('PENDIENTE');
    });
});

describe('aplicar_propuesta_designacion_completa — atomicidad real (todo o nada)', () => {
    // Caso EXACTO pedido en la revisión: 20 rodeos/20 jurados, los primeros
    // 19 válidos, el 20° provoca un error -> 0 asignaciones nuevas, 0
    // movimientos de bitácora, propuesta conservada en estado recuperable.
    test('20 detalles, el 20° inválido (jurado inactivo) -> rollback COMPLETO: 0 asignaciones, 0 bitácora, propuesta sigue BORRADOR', async () => {
        const propId = await nuevaPropuesta();
        const aplicaciones = [];
        for (let i = 0; i < 19; i++) {
            const jurado = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado', $1, 'A') returning id", [`Jurado Lote ${i}`]))[0].id;
            const fecha = `2026-08-${String(1 + i).padStart(2, '0')}`;
            const { detalleId } = await detalleAplicable(propId, jurado, fecha);
            aplicaciones.push({ detalle_id: detalleId, usuario_pagado_id: jurado, categoria_aplicada: 'A', valor_diario_aplicado: 100000, pago_base_calculado: 100000, duracion_dias_aplicada: 1 });
        }
        // Detalle #20: jurado INACTIVO -> JURADO_INVALIDO en la última iteración.
        const { detalleId: d20 } = await detalleAplicable(propId, ID.jInactivo, '2026-08-20');
        aplicaciones.push({ detalle_id: d20, usuario_pagado_id: ID.jInactivo, categoria_aplicada: 'A', valor_diario_aplicado: 100000, pago_base_calculado: 100000, duracion_dias_aplicada: 1 });

        await expect(aplicarLote(propId, ID.admin, aplicaciones)).rejects.toThrow(/JURADO_INVALIDO/);

        const [{ n: asignacionesCreadas }] = await q(
            `select count(*)::int as n from asignaciones a
             join propuestas_designacion_detalle d on d.id = a.propuesta_detalle_id
             where d.propuesta_id = $1`, [propId]
        );
        expect(asignacionesCreadas).toBe(0); // NINGUNA de las 19 válidas quedó confirmada

        const [{ n: movimientosBitacora }] = await q(
            `select count(*)::int as n from bitacora_designaciones b
             join propuestas_designacion_detalle d on d.id = b.propuesta_detalle_id
             where d.propuesta_id = $1`, [propId]
        );
        expect(movimientosBitacora).toBe(0); // ningún movimiento falso quedó registrado

        const [propuesta] = await q('select estado from propuestas_designacion where id = $1', [propId]);
        expect(propuesta.estado).toBe('BORRADOR'); // estado recuperable, intacto

        // Recuperación REAL (no un atajo que evada la cobertura completa):
        // el administrador corrige el detalle #20 reemplazando al jurado
        // inválido por uno activo, vía modificar_jurado_propuesta_borrador
        // (con motivo) — recién entonces el lote completo de 20 es
        // genuinamente aplicable, y se aplica sin problema.
        const juradoCorregido = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado Corregido','A') returning id"))[0].id;
        await declararDisponibilidad(juradoCorregido, '2026-08-20');
        await modificar({ detalle_id: d20, jurado_id_nuevo: juradoCorregido, motivo_catalogo_id: ID.motivoPorCodigo.ajuste_categoria, actor_id: ID.admin });
        aplicaciones[19].usuario_pagado_id = juradoCorregido;

        const [r2] = await aplicarLote(propId, ID.admin, aplicaciones);
        expect(r2.aplicar_propuesta_designacion_completa.aplicadas.length).toBe(20);
    });

    test('cobertura incompleta (una fila SIN_PROPUESTA) -> COBERTURA_INCOMPLETA, nada se aplica', async () => {
        const propId = await nuevaPropuesta();
        const { detalleId: d1 } = await detalleAplicable(propId, ID.jA, '2026-09-01');
        const rodeoSinJurado = await nuevoRodeo('2026-09-08');
        await nuevoDetalle(propId, rodeoSinJurado, { estado_revision: 'SIN_PROPUESTA' });

        await expect(aplicarLote(propId, ID.admin, [
            { detalle_id: d1, usuario_pagado_id: ID.jA, categoria_aplicada: 'A', valor_diario_aplicado: 100000, pago_base_calculado: 100000, duracion_dias_aplicada: 1 }
        ])).rejects.toThrow(/COBERTURA_INCOMPLETA/);

        const [{ n }] = await q('select count(*)::int as n from asignaciones where propuesta_detalle_id = $1', [d1]);
        expect(n).toBe(0);
    });

    test('lote incompleto (falta una fila aplicable en el arreglo) -> LOTE_INCOMPLETO, nada se aplica', async () => {
        const propId = await nuevaPropuesta();
        const { detalleId: d1 } = await detalleAplicable(propId, ID.jA, '2026-09-15');
        await detalleAplicable(propId, ID.jB, '2026-09-22'); // d2 existe pero NO se envía en el lote

        await expect(aplicarLote(propId, ID.admin, [
            { detalle_id: d1, usuario_pagado_id: ID.jA, categoria_aplicada: 'A', valor_diario_aplicado: 100000, pago_base_calculado: 100000, duracion_dias_aplicada: 1 }
        ])).rejects.toThrow(/LOTE_INCOMPLETO/);

        const [{ n }] = await q('select count(*)::int as n from asignaciones where propuesta_detalle_id = $1', [d1]);
        expect(n).toBe(0);
    });

    test('jurado sin disponibilidad declarada -> SIN_DISPONIBILIDAD_DECLARADA, nada se aplica', async () => {
        const propId = await nuevaPropuesta();
        const rodeoId = await nuevoRodeo('2026-10-01');
        // NO se declara disponibilidad para ID.jA en esta fecha.
        const detalleId = await nuevoDetalle(propId, rodeoId, { jurado_id_propuesto: ID.jA, jurado_id_seleccionado: ID.jA, estado_revision: 'ACEPTADO' });

        await expect(aplicarLote(propId, ID.admin, [
            { detalle_id: detalleId, usuario_pagado_id: ID.jA, categoria_aplicada: 'A', valor_diario_aplicado: 100000, pago_base_calculado: 100000, duracion_dias_aplicada: 1 }
        ])).rejects.toThrow(/SIN_DISPONIBILIDAD_DECLARADA/);
    });

    test('propuesta ya no es BORRADOR -> PROPUESTA_NO_ES_BORRADOR, nada se aplica', async () => {
        const propId = await nuevaPropuesta('DESCARTADA');
        const rodeoId = await nuevoRodeo('2026-10-08');
        const detalleId = await nuevoDetalle(propId, rodeoId, { jurado_id_propuesto: ID.jA, jurado_id_seleccionado: ID.jA, estado_revision: 'ACEPTADO' });
        await expect(aplicarLote(propId, ID.admin, [
            { detalle_id: detalleId, usuario_pagado_id: ID.jA, categoria_aplicada: 'A', valor_diario_aplicado: 100000, pago_base_calculado: 100000, duracion_dias_aplicada: 1 }
        ])).rejects.toThrow(/PROPUESTA_NO_ES_BORRADOR/);
    });
});

describe('aplicar_propuesta_designacion_completa — filas ya aplicadas (Decisión 4)', () => {
    test('una fila ya aplicada por una corrida anterior (código previo a esta revisión) se omite sin error y no se duplica', async () => {
        const propId = await nuevaPropuesta();
        const { detalleId: d1, rodeoId: r1 } = await detalleAplicable(propId, ID.jA, '2026-11-01');
        const { detalleId: d2 } = await detalleAplicable(propId, ID.jB, '2026-11-08');

        // Simula una asignación real ya creada por el código ANTERIOR a esta
        // revisión (un RPC por fila, o un INSERT directo) — hallazgo real de
        // esta revisión: 40 de 90 filas de producción están en este estado.
        await q(`insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, nombre_importado, valor_diario_aplicado, pago_base_calculado, propuesta_detalle_id)
                 values ($1,$2,'jurado','Jurado A', 100000, 100000, $3)`, [r1, ID.jA, d1]);

        // El lote correcto ahora debe incluir SOLO d2 (d1 ya está aplicada) —
        // si se reenviara d1 también, LOTE_INCOMPLETO lo rechazaría (el
        // denominador real pasó a ser 1, no 2).
        const [r2] = await aplicarLote(propId, ID.admin, [
            { detalle_id: d2, usuario_pagado_id: ID.jB, categoria_aplicada: 'A', valor_diario_aplicado: 100000, pago_base_calculado: 100000, duracion_dias_aplicada: 1 }
        ]);
        expect(r2.aplicar_propuesta_designacion_completa.aplicadas.length).toBe(1);

        const [{ n: totalAsignacionesD1 }] = await q('select count(*)::int as n from asignaciones where propuesta_detalle_id = $1', [d1]);
        expect(totalAsignacionesD1).toBe(1); // nunca se duplicó

        // Reenviar d1 en el lote (por error) lo rechaza explícitamente —
        // nunca se re-procesa en silencio dentro de un lote más grande.
        await expect(aplicarLote(propId, ID.admin, [
            { detalle_id: d1, usuario_pagado_id: ID.jA, categoria_aplicada: 'A', valor_diario_aplicado: 100000, pago_base_calculado: 100000, duracion_dias_aplicada: 1 }
        ])).rejects.toThrow(/LOTE_INCOMPLETO/);
    });
});

describe('compatibilidad entre aplicar_propuesta_designacion_completa y reemplazar_jurado_asignacion_con_bitacora (Fase 1B)', () => {
    test('una asignación creada vía aplicar_propuesta_designacion_completa puede luego pasar por el reemplazo transaccional de Fase 1B sin conflicto', async () => {
        const propId = await nuevaPropuesta();
        const { detalleId, rodeoId } = await detalleAplicable(propId, ID.jA, '2026-11-15');
        const [r] = await aplicarLote(propId, ID.admin, [
            { detalle_id: detalleId, usuario_pagado_id: ID.jA, categoria_aplicada: 'A', valor_diario_aplicado: 100000, pago_base_calculado: 100000, duracion_dias_aplicada: 1 }
        ]);
        const asignacionId = r.aplicar_propuesta_designacion_completa.aplicadas[0].asignacion_id;

        const [r2] = await q(
            `select * from reemplazar_jurado_asignacion_con_bitacora(
                p_asignacion_id := $1, p_usuario_pagado_id_nuevo := $2, p_categoria_aplicada_nueva := 'A',
                p_valor_diario_aplicado_nuevo := 100000, p_pago_base_calculado_nuevo := 100000,
                p_motivo_catalogo_id := $3, p_actor_id := $4
            )`,
            [asignacionId, ID.jB, ID.motivoPorCodigo.jurado_no_disponible, ID.admin]
        );
        expect(r2.reemplazar_jurado_asignacion_con_bitacora.asignacion.usuario_pagado_id).toBe(ID.jB);

        // La bitácora conserva AMBOS movimientos sobre la misma asignación —
        // historial completo, sin perder el que vino de "aplicar propuesta".
        const historial = await q('select tipo_movimiento from bitacora_designaciones where asignacion_id = $1 order by created_at', [asignacionId]);
        expect(historial.map(h => h.tipo_movimiento)).toEqual(['aplicacion_propuesta', 'reemplazo']);
    });

    test('mismo jurado en dos propuestas distintas con fechas que se cruzan -> la segunda aplicación es rechazada (comparten el mismo espacio de advisory lock que Fase 1B)', async () => {
        const propA = await nuevaPropuesta();
        const { detalleId: dA } = await detalleAplicable(propA, ID.jC, '2026-12-01');
        await aplicarLote(propA, ID.admin, [
            { detalle_id: dA, usuario_pagado_id: ID.jC, categoria_aplicada: 'A', valor_diario_aplicado: 100000, pago_base_calculado: 100000, duracion_dias_aplicada: 1 }
        ]);

        const propB = await nuevaPropuesta();
        const { detalleId: dB } = await detalleAplicable(propB, ID.jC, '2026-12-01'); // mismo jurado, misma fecha -> cruce
        await expect(aplicarLote(propB, ID.admin, [
            { detalle_id: dB, usuario_pagado_id: ID.jC, categoria_aplicada: 'A', valor_diario_aplicado: 100000, pago_base_calculado: 100000, duracion_dias_aplicada: 1 }
        ])).rejects.toThrow(/CRUCE_DISPONIBILIDAD|RODEO_YA_DESIGNADO/);
    });
});
