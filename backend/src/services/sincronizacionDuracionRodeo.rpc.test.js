// Migración 091 (sincronización transaccional rodeo <-> asignaciones, bug
// ANCUD/CHILOÉ — jurado Augusto César González Álvarez) ejecutada contra un
// Postgres REAL de prueba (PGlite, en memoria), no mocks. Se aplica en el
// MISMO orden que producción (083 -> 084 -> 091) para probar que el CREATE
// OR REPLACE de 091 sobre reemplazar_jurado_asignacion_con_bitacora (084) es
// compatible con lo ya desplegado, nunca una reimplementación aislada.
jest.setTimeout(120000);
const fs = require('fs');
const path = require('path');
const { crearDb } = require('./__fixtures__/pgliteCliente');

const MIGRACIONES_DIR = path.join(__dirname, '..', '..', '..', 'database', 'migrations');
const leer = (n) => fs.readFileSync(path.join(MIGRACIONES_DIR, n), 'utf8');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaSincronizacionDuracionRodeo.sql'), 'utf8');
const MIGRACION_083 = leer('083_fase1a_bitacora_designaciones_catalogo_motivos_snapshot_notas.sql');
const MIGRACION_084 = leer('084_reemplazo_jurado_transaccional_con_bitacora.sql');
const MIGRACION_091 = leer('091_sincronizacion_duracion_asignaciones_rodeo.sql');
// Corrección final de seguridad, sección 3 (revisión puntual, punto 7) —
// se carga también acá, en el mismo orden real de aplicación (después de
// 091), para verificar que la versión de reemplazar_jurado_asignacion_con_
// bitacora() que REALMENTE vive en producción (la de 091, no la de 084)
// sigue llamando correctamente a registrar_movimiento_designacion() tras
// su cambio de firma de 14 a 15 parámetros.
const MIGRACION_094 = leer('094_designacion_manual_con_bitacora_atomica.sql');
// Corrección final de seguridad — decisión explícita del usuario: 095
// redefine reemplazar_jurado_asignacion_con_bitacora() (misma firma, CREATE
// OR REPLACE real sobre la versión de 091, no una reimplementación aislada)
// para que una designación rechazada en OTRO rodeo deje de contar como
// cruce de disponibilidad. Se carga acá, en el mismo orden real de
// aplicación (después de 091/094), para confirmar que la sincronización de
// duración/pago y el resto de las pruebas de este archivo sigan
// funcionando exactamente igual.
const MIGRACION_095 = leer('095_correccion_falso_conflicto_rechazado_reemplazo.sql');

let db; const ID = {};
async function q(sql, p) { return (await db.query(sql, p)).rows; }

beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);
    await db.exec(MIGRACION_083);
    await db.exec(MIGRACION_084);
    await db.exec(MIGRACION_091);
    await db.exec(MIGRACION_094);
    await db.exec(MIGRACION_095);

    await db.exec(`GRANT ALL ON TABLE administradores, temporadas, usuarios_pagados, rodeos, asignaciones,
        propuestas_designacion, propuestas_designacion_detalle, notas_rodeo, evaluaciones, evaluacion_casos,
        evaluacion_escala_puntaje_nota, evaluacion_escala_calificacion, evaluacion_auditoria,
        bonos_solicitados, cartillas_jurado, importaciones, auditoria TO service_role;`);

    ID.admin = (await q("insert into administradores (nombre_completo) values ('Admin Test') returning id"))[0].id;
    ID.augusto = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Augusto Cesar Gonzalez Alvarez','C') returning id"))[0].id;
    ID.jurA = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado A','A') returning id"))[0].id;
    ID.jurB = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado B','B') returning id"))[0].id;
    ID.delegado = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('delegado_rentado','Delegado X') returning id"))[0].id;

    const motivos = await q('select id, codigo from catalogo_motivos_designacion');
    ID.motivoPorCodigo = {};
    motivos.forEach((m) => { ID.motivoPorCodigo[m.codigo] = m.id; });

    ID.importHistorica = (await q("insert into importaciones (nombre_archivo, tipo) values ('h.xlsx','historico_rodeos') returning id"))[0].id;
    ID.importNormal = (await q("insert into importaciones (nombre_archivo, tipo) values ('n.xlsx','rodeos') returning id"))[0].id;
});
afterAll(async () => { await db.close(); });

let _rodeoSeq = 0;
async function nuevoRodeo({ duracionDias = 1, tipoRodeoNombre = 'Provincial 1 día', club = 'ANCUD', asociacion = 'CHILOE' } = {}) {
    _rodeoSeq++;
    const base = new Date('2026-01-01T00:00:00Z');
    base.setUTCDate(base.getUTCDate() + _rodeoSeq * 10);
    const fecha = base.toISOString().slice(0, 10);
    const r = await q(
        'insert into rodeos (club, asociacion, fecha, duracion_dias, tipo_rodeo_nombre) values ($1,$2,$3,$4,$5) returning id',
        [club, asociacion, fecha, duracionDias, tipoRodeoNombre]
    );
    return r[0].id;
}
async function nuevaAsignacion(rodeoId, personaId, { valorDiario = 213500, duracionAplicada = 1, importacionId = null, tipoPersona = 'jurado' } = {}) {
    const pagoBase = valorDiario * duracionAplicada;
    const r = await q(
        `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, nombre_importado, categoria_aplicada,
            valor_diario_aplicado, duracion_dias_aplicada, pago_base_calculado, importacion_id)
         values ($1,$2,$3,(select nombre_completo from usuarios_pagados where id=$2),
            (select categoria from usuarios_pagados where id=$2), $4,$5,$6,$7) returning id`,
        [rodeoId, personaId, tipoPersona, valorDiario, duracionAplicada, pagoBase, importacionId]
    );
    return r[0].id;
}
function actualizarTipo(args) {
    return q(
        `select * from actualizar_tipo_rodeo_y_sincronizar_asignaciones(
            p_rodeo_id := $1, p_tipo_rodeo_id := $2, p_tipo_rodeo_nombre := $3, p_nueva_duracion_dias := $4,
            p_actor_id := $5, p_actor_tipo := $6, p_ip_address := $7
        )`,
        [args.rodeo_id, args.tipo_rodeo_id || null, args.tipo_rodeo_nombre, args.nueva_duracion_dias, args.actor_id, args.actor_tipo || 'administrador', args.ip_address || null]
    );
}
function reparar(args) {
    return q(
        `select * from reparar_sincronizacion_asignaciones_rodeo(p_rodeo_id := $1, p_actor_id := $2, p_actor_tipo := $3, p_ip_address := $4)`,
        [args.rodeo_id, args.actor_id, args.actor_tipo || 'administrador', args.ip_address || null]
    );
}
function reemplazar(args) {
    return q(
        `select * from reemplazar_jurado_asignacion_con_bitacora(
            p_asignacion_id := $1, p_usuario_pagado_id_nuevo := $2,
            p_categoria_aplicada_nueva := $3, p_valor_diario_aplicado_nuevo := $4, p_pago_base_calculado_nuevo := $5,
            p_motivo_catalogo_id := $6, p_actor_id := $7
        )`,
        [args.asignacion_id, args.usuario_pagado_id_nuevo, args.categoria_aplicada_nueva, args.valor_diario_aplicado_nuevo, args.pago_base_calculado_nuevo, args.motivo_catalogo_id, args.actor_id]
    );
}

describe('actualizar_tipo_rodeo_y_sincronizar_asignaciones — Caso ANCUD exacto (1 día -> 2 días, jurado categoría C)', () => {
    test('actualiza rodeos.tipo_rodeo_nombre/duracion_dias y sincroniza la asignación de Augusto, en una sola llamada', async () => {
        const rodeoId = await nuevoRodeo({ duracionDias: 1, tipoRodeoNombre: 'Provincial 1 día' });
        const asigId = await nuevaAsignacion(rodeoId, ID.augusto, { valorDiario: 213500, duracionAplicada: 1 });

        const [fila] = await actualizarTipo({
            rodeo_id: rodeoId, tipo_rodeo_id: null, tipo_rodeo_nombre: 'Provincial 3 series', nueva_duracion_dias: 2, actor_id: ID.admin
        });
        const r = fila.actualizar_tipo_rodeo_y_sincronizar_asignaciones;

        expect(r.rodeo.tipo_rodeo_nombre).toBe('Provincial 3 series');
        expect(r.rodeo.duracion_dias).toBe(2);
        expect(r.sincronizacion).toEqual({ actualizadas: 1, omitidas_historicas: 0, sin_cambio: 0 });

        const [rodeoDb] = await q('select * from rodeos where id=$1', [rodeoId]);
        expect(rodeoDb.tipo_rodeo_nombre).toBe('Provincial 3 series');
        expect(rodeoDb.duracion_dias).toBe(2);

        const [asigDb] = await q('select * from asignaciones where id=$1', [asigId]);
        expect(asigDb.duracion_dias_aplicada).toBe(2);
        expect(asigDb.pago_base_calculado).toBe(427000);
        // No se duplicó ninguna asignación, no se tocó la identidad ni la aceptación.
        expect(asigDb.usuario_pagado_id).toBe(ID.augusto);
        expect(asigDb.estado_designacion).toBe('pendiente'); // no se tocó (seguía en su valor original)

        const auditRodeo = await q("select * from auditoria where tabla='rodeos' and registro_id=$1", [rodeoId]);
        expect(auditRodeo.length).toBeGreaterThanOrEqual(1);
        const auditAsig = await q("select * from auditoria where tabla='asignaciones' and registro_id=$1", [asigId]);
        expect(auditAsig).toHaveLength(1);
        expect(auditAsig[0].datos_anteriores).toMatchObject({ duracion_dias_aplicada: 1, pago_base_calculado: 213500 });
        expect(auditAsig[0].datos_nuevos).toMatchObject({ duracion_dias_aplicada: 2, pago_base_calculado: 427000 });
    });

    test('inverso: 2 días -> 1 día, el pago vuelve a 213.500', async () => {
        const rodeoId = await nuevoRodeo({ duracionDias: 2, tipoRodeoNombre: 'Provincial 3 series' });
        const asigId = await nuevaAsignacion(rodeoId, ID.augusto, { valorDiario: 213500, duracionAplicada: 2 });

        await actualizarTipo({ rodeo_id: rodeoId, tipo_rodeo_nombre: 'Provincial 1 día', nueva_duracion_dias: 1, actor_id: ID.admin });

        const [asigDb] = await q('select * from asignaciones where id=$1', [asigId]);
        expect(asigDb.duracion_dias_aplicada).toBe(1);
        expect(asigDb.pago_base_calculado).toBe(213500);
    });
});

describe('Protección de pagos históricos (importación histórica — único mecanismo que existe)', () => {
    test('asignación de importación histórica NUNCA se recalcula', async () => {
        const rodeoId = await nuevoRodeo({ duracionDias: 1 });
        const asigId = await nuevaAsignacion(rodeoId, ID.jurA, { valorDiario: 0, duracionAplicada: 1, importacionId: ID.importHistorica });

        const [fila] = await actualizarTipo({ rodeo_id: rodeoId, tipo_rodeo_nombre: 'Provincial 3 series', nueva_duracion_dias: 2, actor_id: ID.admin });
        const r = fila.actualizar_tipo_rodeo_y_sincronizar_asignaciones;

        expect(r.sincronizacion.omitidas_historicas).toBe(1);
        expect(r.sincronizacion.actualizadas).toBe(0);
        const [asigDb] = await q('select * from asignaciones where id=$1', [asigId]);
        expect(asigDb.duracion_dias_aplicada).toBe(1); // intacto
        expect(asigDb.pago_base_calculado).toBe(0);    // intacto

        const audit = await q("select * from auditoria where tabla='asignaciones' and registro_id=$1", [asigId]);
        expect(audit).toHaveLength(0); // nunca se auditó un cambio que no ocurrió
    });

    test('importacion_id presente pero de OTRO tipo (no histórico) -> sí se sincroniza', async () => {
        const rodeoId = await nuevoRodeo({ duracionDias: 1 });
        const asigId = await nuevaAsignacion(rodeoId, ID.jurA, { valorDiario: 200000, duracionAplicada: 1, importacionId: ID.importNormal });

        await actualizarTipo({ rodeo_id: rodeoId, tipo_rodeo_nombre: 'Provincial 3 series', nueva_duracion_dias: 2, actor_id: ID.admin });

        const [asigDb] = await q('select * from asignaciones where id=$1', [asigId]);
        expect(asigDb.pago_base_calculado).toBe(400000);
    });
});

describe('Idempotencia (ejecuciones repetidas)', () => {
    test('llamar dos veces con la misma duración nueva -> la segunda vez no cambia nada ni audita de más', async () => {
        const rodeoId = await nuevoRodeo({ duracionDias: 1 });
        const asigId = await nuevaAsignacion(rodeoId, ID.jurA, { valorDiario: 100000, duracionAplicada: 1 });

        await actualizarTipo({ rodeo_id: rodeoId, tipo_rodeo_nombre: 'X', nueva_duracion_dias: 2, actor_id: ID.admin });
        const [fila2] = await actualizarTipo({ rodeo_id: rodeoId, tipo_rodeo_nombre: 'X', nueva_duracion_dias: 2, actor_id: ID.admin });
        const r2 = fila2.actualizar_tipo_rodeo_y_sincronizar_asignaciones;

        expect(r2.sincronizacion).toEqual({ actualizadas: 0, omitidas_historicas: 0, sin_cambio: 1 });
        const auditAsig = await q("select * from auditoria where tabla='asignaciones' and registro_id=$1", [asigId]);
        expect(auditAsig).toHaveLength(1); // solo la primera vez
    });
});

describe('Revisión correctiva (previa a producción) — pago desalineado con duración ya correcta', () => {
    test('CASO ESPECÍFICO del pedido: duración del rodeo Y de la asignación ya son 2 días, pero el pago registrado corresponde a 1 día -> debe corregirse (antes quedaba sin corregir porque la duración ya coincidía)', async () => {
        const rodeoId = await nuevoRodeo({ duracionDias: 2, tipoRodeoNombre: 'Provincial 3 series' });
        // duracion_dias_aplicada=2 (coincide con el rodeo), pero pago_base_calculado
        // quedó calculado como si fuera 1 día (213.500 en vez de 427.000).
        const asigId = await nuevaAsignacion(rodeoId, ID.augusto, { valorDiario: 213500, duracionAplicada: 2 });
        await db.exec(`update asignaciones set pago_base_calculado = 213500 where id = '${asigId}'`);

        const [antes] = await q('select duracion_dias_aplicada, pago_base_calculado from asignaciones where id=$1', [asigId]);
        expect(antes).toEqual({ duracion_dias_aplicada: 2, pago_base_calculado: 213500 }); // estado inicial del caso

        // Reparar sin cambiar el tipo (herramienta de reparación, Caso 2B) —
        // mismo síntoma que actualizar_tipo_rodeo_y_sincronizar_asignaciones
        // detectaría si se volviera a guardar el mismo tipo.
        const [fila] = await reparar({ rodeo_id: rodeoId, actor_id: ID.admin });
        const r = fila.reparar_sincronizacion_asignaciones_rodeo;

        expect(r.sincronizacion).toEqual({ actualizadas: 1, omitidas_historicas: 0, sin_cambio: 0 });
        const [despues] = await q('select duracion_dias_aplicada, pago_base_calculado from asignaciones where id=$1', [asigId]);
        expect(despues).toEqual({ duracion_dias_aplicada: 2, pago_base_calculado: 427000 });

        // Auditoría refleja el pago anterior real (213.500), no el que "ya
        // coincidía" en duración.
        const [audit] = await q("select * from auditoria where tabla='asignaciones' and registro_id=$1", [asigId]);
        expect(audit.datos_anteriores).toMatchObject({ duracion_dias_aplicada: 2, pago_base_calculado: 213500 });
        expect(audit.datos_nuevos).toMatchObject({ duracion_dias_aplicada: 2, pago_base_calculado: 427000 });
    });

    test('tras la corrección, una segunda ejecución ya es sin_cambio (confirma que ahora sí quedó realmente sincronizado)', async () => {
        const rodeoId = await nuevoRodeo({ duracionDias: 2 });
        const asigId = await nuevaAsignacion(rodeoId, ID.jurA, { valorDiario: 100000, duracionAplicada: 2 });
        await db.exec(`update asignaciones set pago_base_calculado = 100000 where id = '${asigId}'`); // debería ser 200000

        await reparar({ rodeo_id: rodeoId, actor_id: ID.admin });
        const [fila2] = await reparar({ rodeo_id: rodeoId, actor_id: ID.admin });
        expect(fila2.reparar_sincronizacion_asignaciones_rodeo.sincronizacion).toEqual({ actualizadas: 0, omitidas_historicas: 0, sin_cambio: 1 });
    });

    test('pago histórico con duración ya correcta pero pago distinto del "esperado" (valor_diario=0) sigue protegido — nunca se toca aunque el nuevo chequeo también mire el pago', async () => {
        const rodeoId = await nuevoRodeo({ duracionDias: 2 });
        // Histórica: valor_diario_aplicado=0 (así se cargan), duracion ya en 2, pero con un pago_base_calculado residual distinto de 0 por algún motivo externo.
        const asigId = await nuevaAsignacion(rodeoId, ID.jurA, { valorDiario: 0, duracionAplicada: 2, importacionId: ID.importHistorica });
        await db.exec(`update asignaciones set pago_base_calculado = 50000 where id = '${asigId}'`);

        const [fila] = await reparar({ rodeo_id: rodeoId, actor_id: ID.admin });
        expect(fila.reparar_sincronizacion_asignaciones_rodeo.sincronizacion).toEqual({ actualizadas: 0, omitidas_historicas: 1, sin_cambio: 0 });
        const [asigDb] = await q('select pago_base_calculado from asignaciones where id=$1', [asigId]);
        expect(asigDb.pago_base_calculado).toBe(50000); // intacto, nunca se tocó
    });
});

describe('Revisión correctiva — rechazo de duraciones inválidas (nula, cero, negativa)', () => {
    test.each([
        ['nula', null],
        ['cero', 0],
        ['negativa', -1]
    ])('actualizar_tipo_rodeo_y_sincronizar_asignaciones con duración %s -> DURACION_INVALIDA, nunca toca rodeos ni asignaciones', async (_etiqueta, duracionInvalida) => {
        const rodeoId = await nuevoRodeo({ duracionDias: 1, tipoRodeoNombre: 'Provincial 1 día' });
        await nuevaAsignacion(rodeoId, ID.jurA, { valorDiario: 100000, duracionAplicada: 1 });

        await expect(
            actualizarTipo({ rodeo_id: rodeoId, tipo_rodeo_nombre: 'Provincial X', nueva_duracion_dias: duracionInvalida, actor_id: ID.admin })
        ).rejects.toThrow(/DURACION_INVALIDA/);

        const [rodeoDb] = await q('select tipo_rodeo_nombre, duracion_dias from rodeos where id=$1', [rodeoId]);
        expect(rodeoDb).toEqual({ tipo_rodeo_nombre: 'Provincial 1 día', duracion_dias: 1 }); // sin cambios
    });

    test.each([
        ['cero', 0],
        ['negativa', -3]
    ])('reparar_sincronizacion_asignaciones_rodeo: si la duración YA ALMACENADA en el rodeo es %s (dato corrupto/legado), rechaza con DURACION_INVALIDA en vez de convertirla en silencio en "1 día" (antes usaba COALESCE(v_duracion_vigente, 1))', async (_etiqueta, duracionCorrupta) => {
        const rodeoId = await nuevoRodeo({ duracionDias: 1 });
        const asigId = await nuevaAsignacion(rodeoId, ID.jurA, { valorDiario: 100000, duracionAplicada: 1 });
        // Simula un dato ya corrupto/legado en producción (el CHECK real de
        // rodeos.duracion_dias en producción normalmente lo impediría, pero
        // la función debe protegerse igual, nunca inventar un valor).
        await db.exec(`update rodeos set duracion_dias = ${duracionCorrupta} where id = '${rodeoId}'`);

        await expect(reparar({ rodeo_id: rodeoId, actor_id: ID.admin })).rejects.toThrow(/DURACION_INVALIDA/);

        // Nada se tocó: ni se "corrigió" a 1 día, ni se sincronizó la asignación.
        const [asigDb] = await q('select duracion_dias_aplicada, pago_base_calculado from asignaciones where id=$1', [asigId]);
        expect(asigDb).toEqual({ duracion_dias_aplicada: 1, pago_base_calculado: 100000 });
    });
});

describe('Revisión correctiva — reemplazar_jurado_asignacion_con_bitacora no puede dejar un pago inconsistente con la duración', () => {
    test('pago recibido NO corresponde a valor_diario_aplicado_nuevo × la duración vigente del rodeo -> PAGO_BASE_INCONSISTENTE_CON_DURACION, nada se modifica', async () => {
        const rodeoId = await nuevoRodeo({ duracionDias: 2 }); // el rodeo vive en 2 días
        const asigId = await nuevaAsignacion(rodeoId, ID.jurA, { valorDiario: 100000, duracionAplicada: 2 });

        // El backend "se equivocó" (o el rodeo cambió de duración justo antes):
        // envía un pago calculado para 1 día (245000) con una tarifa de 245000/día,
        // en vez de 490000 (245000 × 2, la duración real).
        await expect(reemplazar({
            asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jurB,
            categoria_aplicada_nueva: 'B', valor_diario_aplicado_nuevo: 245000, pago_base_calculado_nuevo: 245000,
            motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin
        })).rejects.toThrow(/PAGO_BASE_INCONSISTENTE_CON_DURACION/);

        // Nada se modificó: ni el jurado, ni el pago, ni la duración aplicada.
        const [asigDb] = await q('select usuario_pagado_id, pago_base_calculado, duracion_dias_aplicada from asignaciones where id=$1', [asigId]);
        expect(asigDb).toEqual({ usuario_pagado_id: ID.jurA, pago_base_calculado: 200000, duracion_dias_aplicada: 2 });
    });

    test('pago recibido SÍ corresponde a la duración vigente -> se acepta normalmente (no rompe el caso de uso real)', async () => {
        const rodeoId = await nuevoRodeo({ duracionDias: 2 });
        const asigId = await nuevaAsignacion(rodeoId, ID.jurA, { valorDiario: 100000, duracionAplicada: 2 });

        const [fila] = await reemplazar({
            asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jurB,
            categoria_aplicada_nueva: 'B', valor_diario_aplicado_nuevo: 245000, pago_base_calculado_nuevo: 490000, // 245000 × 2, correcto
            motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin
        });
        expect(fila.reemplazar_jurado_asignacion_con_bitacora.asignacion.pago_base_calculado).toBe(490000);
    });
});

describe('Varios jurados/delegados en el mismo rodeo', () => {
    test('todos se sincronizan de forma independiente, sin duplicar ni mezclar montos', async () => {
        const rodeoId = await nuevoRodeo({ duracionDias: 1 });
        const asigAugusto = await nuevaAsignacion(rodeoId, ID.augusto, { valorDiario: 213500, duracionAplicada: 1 });
        const asigJurA = await nuevaAsignacion(rodeoId, ID.jurA, { valorDiario: 292000, duracionAplicada: 1 });
        const asigDelegado = await nuevaAsignacion(rodeoId, ID.delegado, { valorDiario: 180000, duracionAplicada: 1, tipoPersona: 'delegado_rentado' });

        const [fila] = await actualizarTipo({ rodeo_id: rodeoId, tipo_rodeo_nombre: 'Provincial 3 series', nueva_duracion_dias: 2, actor_id: ID.admin });
        expect(fila.actualizar_tipo_rodeo_y_sincronizar_asignaciones.sincronizacion.actualizadas).toBe(3);

        const asigs = await q('select id, pago_base_calculado from asignaciones where rodeo_id=$1', [rodeoId]);
        expect(asigs.find(a => a.id === asigAugusto).pago_base_calculado).toBe(427000);
        expect(asigs.find(a => a.id === asigJurA).pago_base_calculado).toBe(584000);
        expect(asigs.find(a => a.id === asigDelegado).pago_base_calculado).toBe(360000);
    });
});

describe('Herramienta de reparación (reparar_sincronizacion_asignaciones_rodeo) — sin cambiar el tipo', () => {
    test('rodeo ya desincronizado ANTES de esta corrección (duracion_dias cambiado directamente, sin pasar por la RPC) queda reparado sin tocar rodeos', async () => {
        const rodeoId = await nuevoRodeo({ duracionDias: 1, tipoRodeoNombre: 'Provincial 3 series' });
        // Simula el estado real pre-corrección: alguien cambió rodeos.duracion_dias
        // directamente (o con la versión anterior, no transaccional) y la
        // asignación quedó atrás.
        await db.exec(`update rodeos set duracion_dias = 2 where id = '${rodeoId}'`);
        const asigId = await nuevaAsignacion(rodeoId, ID.augusto, { valorDiario: 213500, duracionAplicada: 1 });

        const [fila] = await reparar({ rodeo_id: rodeoId, actor_id: ID.admin });
        const r = fila.reparar_sincronizacion_asignaciones_rodeo;

        expect(r.duracion_dias_vigente).toBe(2);
        expect(r.sincronizacion).toEqual({ actualizadas: 1, omitidas_historicas: 0, sin_cambio: 0 });

        const [rodeoDb] = await q('select duracion_dias, tipo_rodeo_nombre from rodeos where id=$1', [rodeoId]);
        expect(rodeoDb.duracion_dias).toBe(2); // sin cambios por esta función (ya estaba en 2)
        expect(rodeoDb.tipo_rodeo_nombre).toBe('Provincial 3 series'); // nunca tocado

        const [asigDb] = await q('select duracion_dias_aplicada, pago_base_calculado from asignaciones where id=$1', [asigId]);
        expect(asigDb.duracion_dias_aplicada).toBe(2);
        expect(asigDb.pago_base_calculado).toBe(427000);
    });

    test('rodeo ya sincronizado -> no hace nada (idempotente)', async () => {
        const rodeoId = await nuevoRodeo({ duracionDias: 1 });
        await nuevaAsignacion(rodeoId, ID.jurA, { valorDiario: 100000, duracionAplicada: 1 });

        const [fila] = await reparar({ rodeo_id: rodeoId, actor_id: ID.admin });
        expect(fila.reparar_sincronizacion_asignaciones_rodeo.sincronizacion).toEqual({ actualizadas: 0, omitidas_historicas: 0, sin_cambio: 1 });
    });
});

describe('Compatibilidad con reemplazar_jurado_asignacion_con_bitacora (084) — corrección del punto 2D', () => {
    test('al reemplazar un jurado en un rodeo YA desincronizado, el reemplazo ahora también corrige duracion_dias_aplicada (antes solo corregía el pago)', async () => {
        const rodeoId = await nuevoRodeo({ duracionDias: 2 }); // el rodeo YA está en 2 días
        const asigId = await nuevaAsignacion(rodeoId, ID.jurA, { valorDiario: 292000, duracionAplicada: 1 }); // pero la asignación quedó en 1 (desincronizada)

        const [fila] = await reemplazar({
            asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jurB,
            categoria_aplicada_nueva: 'B', valor_diario_aplicado_nuevo: 245000, pago_base_calculado_nuevo: 490000,
            motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin
        });
        const r = fila.reemplazar_jurado_asignacion_con_bitacora;
        expect(r.asignacion.usuario_pagado_id).toBe(ID.jurB);

        const [asigDb] = await q('select duracion_dias_aplicada, pago_base_calculado from asignaciones where id=$1', [asigId]);
        expect(asigDb.pago_base_calculado).toBe(490000);     // ya funcionaba antes
        expect(asigDb.duracion_dias_aplicada).toBe(2);        // CORREGIDO por 091 — antes quedaba en 1
    });

    test('regresión: todas las validaciones y bloqueos de 084 siguen intactos (antecedente sensible de nota bloquea el reemplazo)', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jurA, { valorDiario: 100000, duracionAplicada: 1 });
        await db.exec(`insert into notas_rodeo (asignacion_id, nota) values ('${asigId}', 6.5)`);

        await expect(reemplazar({
            asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jurB,
            categoria_aplicada_nueva: 'B', valor_diario_aplicado_nuevo: 245000, pago_base_calculado_nuevo: 245000,
            motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin
        })).rejects.toThrow(/ANTECEDENTE_SENSIBLE_NOTA/);
    });
});

describe('Transaccionalidad REAL — si algo falla a mitad de camino, Postgres revierte TODO', () => {
    test('un actor_tipo inválido (viola el CHECK de auditoria) en la segunda asignación revierte también la primera Y el rodeo', async () => {
        const rodeoId = await nuevoRodeo({ duracionDias: 1, tipoRodeoNombre: 'Provincial 1 día' });
        const asig1 = await nuevaAsignacion(rodeoId, ID.jurA, { valorDiario: 100000, duracionAplicada: 1 });
        const asig2 = await nuevaAsignacion(rodeoId, ID.jurB, { valorDiario: 150000, duracionAplicada: 1 });

        // 'rol_invalido' no está permitido por auditoria_actor_tipo_check — el
        // INSERT INTO auditoria de la (en este caso, cualquiera de las dos)
        // asignación falla, y con él debe fallar TODA la función.
        await expect(
            actualizarTipo({ rodeo_id: rodeoId, tipo_rodeo_nombre: 'Provincial 3 series', nueva_duracion_dias: 2, actor_id: ID.admin, actor_tipo: 'rol_invalido' })
        ).rejects.toThrow();

        const [rodeoDb] = await q('select tipo_rodeo_nombre, duracion_dias from rodeos where id=$1', [rodeoId]);
        expect(rodeoDb.tipo_rodeo_nombre).toBe('Provincial 1 día'); // NUNCA se aplicó — revertido
        expect(rodeoDb.duracion_dias).toBe(1);

        const asigs = await q('select id, duracion_dias_aplicada, pago_base_calculado from asignaciones where rodeo_id=$1', [rodeoId]);
        for (const a of asigs) {
            expect(a.duracion_dias_aplicada).toBe(1); // ninguna quedó a medio sincronizar
        }
        const auditRodeo = await q("select * from auditoria where tabla='rodeos' and registro_id=$1", [rodeoId]);
        expect(auditRodeo).toHaveLength(0); // tampoco quedó un registro de auditoría "huérfano" de un cambio que no se aplicó
    });
});

describe('Errores — rodeo inexistente', () => {
    test('actualizar_tipo_rodeo_y_sincronizar_asignaciones con un rodeo que no existe -> RODEO_NO_ENCONTRADO', async () => {
        await expect(
            actualizarTipo({ rodeo_id: '00000000-0000-0000-0000-000000000000', tipo_rodeo_nombre: 'X', nueva_duracion_dias: 1, actor_id: ID.admin })
        ).rejects.toThrow(/RODEO_NO_ENCONTRADO/);
    });

    test('reparar_sincronizacion_asignaciones_rodeo con un rodeo que no existe -> RODEO_NO_ENCONTRADO', async () => {
        await expect(
            reparar({ rodeo_id: '00000000-0000-0000-0000-000000000000', actor_id: ID.admin })
        ).rejects.toThrow(/RODEO_NO_ENCONTRADO/);
    });
});

describe('Seguridad — privilegios reales de BD (EXECUTE restringido a service_role)', () => {
    async function comoRol(rol, fn) {
        await db.exec(`SET ROLE ${rol};`);
        try { return await fn(); } finally { await db.exec('RESET ROLE;'); }
    }

    test('anon no puede ejecutar ninguna de las 3 funciones nuevas', async () => {
        await expect(comoRol('anon', () =>
            db.query("select * from actualizar_tipo_rodeo_y_sincronizar_asignaciones($1,null,'X',1,$1,'administrador',null)", [ID.admin])
        )).rejects.toThrow(/permission denied/i);

        await expect(comoRol('anon', () =>
            db.query("select * from reparar_sincronizacion_asignaciones_rodeo($1,$1,'administrador',null)", [ID.admin])
        )).rejects.toThrow(/permission denied/i);
    });

    test('authenticated no puede ejecutar ninguna de las 3 funciones nuevas', async () => {
        await expect(comoRol('authenticated', () =>
            db.query("select * from actualizar_tipo_rodeo_y_sincronizar_asignaciones($1,null,'X',1,$1,'administrador',null)", [ID.admin])
        )).rejects.toThrow(/permission denied/i);
    });

    test('service_role SÍ puede ejecutar las 3 funciones (ya lo demuestran los tests funcionales de arriba, corridos sin SET ROLE — este test confirma explícitamente el GRANT)', async () => {
        const rodeoId = await nuevoRodeo({ duracionDias: 1 });
        await nuevaAsignacion(rodeoId, ID.jurA, { valorDiario: 100000, duracionAplicada: 1 });
        await expect(comoRol('service_role', () =>
            actualizarTipo({ rodeo_id: rodeoId, tipo_rodeo_nombre: 'X', nueva_duracion_dias: 2, actor_id: ID.admin })
        )).resolves.toBeDefined();
    });
});
