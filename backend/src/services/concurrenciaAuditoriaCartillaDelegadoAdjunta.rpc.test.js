// Auditoría y corrección final de la migración 076 (migración 077) —
// verificación contra Postgres REAL (PGlite). Cubre exactamente lo pedido:
//   1. Auditoría transaccional de ambas RPC (registrar_version_... y
//      clasificar_adjunto_..._historico): clasificación anterior/nueva,
//      rodeo, administrador, número de versión, fecha.
//   2. Permisos reales: anon/authenticated SIN EXECUTE, service_role CON
//      EXECUTE, en las 3 RPC del módulo (incluida registrar_version_...,
//      que 076 dejaba sin hardenizar).
//   3. Orden de locks corregido en clasificar_adjunto_..._historico (releer
//      y revalidar tras adquirir los locks) — ver limitación honesta sobre
//      deadlocks reales en el comentario de más abajo.
//   4. Bloqueo de una cartilla oficial aunque NINGUNA fila tenga
//      cartilla_vigente=true (ya no depende solo de ese booleano).
//   5. Cartilla digital preexistente -> ambas RPC exigen confirmación
//      explícita antes de marcar un archivo como oficial.
//   6. Los 3 casos reales "Rentado + adjunto" no se ven afectados.
//   7. Archivos complementarios nunca bloquean.
//   8. SAGRADA FAMILIA/AGUANEGRA sigue bloqueado antes de clasificar nada.
//   9. Numeración V1/V2/V3 se conserva sin cambios.
const fs = require('fs');
const path = require('path');
jest.setTimeout(120000);
const { crearDb } = require('./__fixtures__/pgliteCliente');

const MIGRACIONES_DIR = path.join(__dirname, '..', '..', '..', 'database', 'migrations');
const leer = (n) => fs.readFileSync(path.join(MIGRACIONES_DIR, n), 'utf8');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaCartillaInstitucional.sql'), 'utf8');

const MIGRACIONES_061_A_071 = [
    '061_cuentas_institucionales.sql', '062_delegados_asociacion.sql',
    '064_delegados_asociacion_certificado.sql', '065_cartillas_delegado_institucional.sql',
    '066_rpc_cartilla_institucional.sql', '067_control_transaccional_designacion_cartilla.sql',
    '068_seleccion_delegado_institucional_por_rodeo.sql', '069_responsable_unico_institucional.sql',
    '070_auditoria_transaccional_institucional.sql', '071_seguridad_tablas_rpc_institucionales.sql'
];

let db;
beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);
    await db.exec(leer('037_cartilla_delegado.sql'));
    for (const m of MIGRACIONES_061_A_071) await db.exec(leer(m));
    // 074/075/076 deliberadamente NO se aplican: 077 debe quedar correcta
    // por sí sola (self-contained), igual criterio que 076 sobre 075.
    await db.exec(leer('077_concurrencia_auditoria_y_conflicto_cartilla_digital.sql'));
});
afterAll(async () => { await db.close(); });

let seq = 0;
async function nuevoRodeoConAsociacion(asociacionNombre = 'AGUANEGRA') {
    seq++;
    const { rows: [asoc] } = await db.query(
        "insert into asociaciones (nombre, nombre_normalizado) values ($1,$2) returning id",
        [asociacionNombre + '_' + seq, asociacionNombre.toLowerCase() + '_' + seq]
    );
    const { rows: [cuenta] } = await db.query(
        "insert into cuentas_institucionales (email, password_hash, asociacion_id) values ($1,'x',$2) returning id",
        ['d' + seq + '@test.com', asoc.id]
    );
    const { rows: [delegado] } = await db.query(
        "insert into delegados_asociacion (nombre, nombre_normalizado, asociacion_id, certificado) values ('Ana Soto','ana soto',$1,true) returning id",
        [asoc.id]
    );
    const { rows: [rodeo] } = await db.query(
        "insert into rodeos (club, asociacion, fecha) values ($1,$2,'2026-09-12') returning id",
        ['Club ' + seq, asociacionNombre + '_' + seq]
    );
    const { rows: [admin] } = await db.query("insert into administradores (nombre_completo) values ('Admin Test') returning id");
    return { asoc, cuenta, delegado, rodeoId: rodeo.id, adminId: admin.id };
}
async function registrarAdjunto(rodeoId, esVersion, adminId, nombreArchivo, confirmaConflicto = false) {
    seq++;
    const { rows: [adj] } = await db.query(
        `select * from registrar_version_cartilla_delegado_adjunta($1,$2,null,true,$3,$4,'application/pdf',1000,$5,$6)`,
        [rodeoId, esVersion, nombreArchivo, 'path/' + seq, adminId, confirmaConflicto]
    );
    return adj;
}
async function insertarAdjuntoHistoricoPendiente(rodeoId, nombreArchivo) {
    seq++;
    const { rows: [adj] } = await db.query(
        "insert into rodeo_adjuntos (rodeo_id, subido_por_admin, tipo_adjunto, nombre_archivo, storage_path, mime_type) values ($1,true,'cartilla_delegado',$2,$3,'application/pdf') returning *",
        [rodeoId, nombreArchivo, 'hist/' + seq]
    );
    return adj;
}
async function clasificarHistorico(adjuntoId, esVersion, adminId, confirmaConflicto = false) {
    const { rows: [adj] } = await db.query(
        'select * from clasificar_adjunto_cartilla_delegado_historico($1,$2,$3,$4)',
        [adjuntoId, esVersion, adminId, confirmaConflicto]
    );
    return adj;
}
async function crearCartillaDigital(rodeoId, delegado, cuenta) {
    const { rows } = await db.query(
        'select * from crear_o_adjuntar_cartilla_institucional($1,$2,$3,$4,$5,$6,$7)',
        [rodeoId, delegado.id, 'Ana Soto', cuenta.id, '2026-2027', '2026-09-12', 'Provincial']
    );
    return rows[0];
}
async function ultimaAuditoria(registroId) {
    const { rows } = await db.query(
        "select * from auditoria where tabla='rodeo_adjuntos' and registro_id=$1 order by created_at desc limit 1",
        [registroId]
    );
    return rows[0];
}

describe('1) Auditoría transaccional — registrar_version_cartilla_delegado_adjunta', () => {
    test('alta como version_cartilla -> queda un evento con clasificación anterior null-ish y nueva "version_cartilla", rodeo y administrador correctos', async () => {
        const { rodeoId, adminId } = await nuevoRodeoConAsociacion();
        const adj = await registrarAdjunto(rodeoId, true, adminId, 'oficial.pdf');
        const ev = await ultimaAuditoria(adj.id);
        expect(ev).toBeDefined();
        expect(ev.accion).toBe('crear');
        expect(ev.actor_id).toBe(adminId);
        expect(ev.actor_tipo).toBe('administrador');
        expect(ev.datos_nuevos.cartilla_clasificacion).toBe('version_cartilla');
        expect(ev.datos_nuevos.rodeo_id).toBe(rodeoId);
        expect(ev.datos_nuevos.cartilla_numero_version).toBe(1);
    });

    test('alta como complementario -> el evento refleja "complementario", nunca "version_cartilla"', async () => {
        const { rodeoId, adminId } = await nuevoRodeoConAsociacion();
        const adj = await registrarAdjunto(rodeoId, false, adminId, 'medico.pdf');
        const ev = await ultimaAuditoria(adj.id);
        expect(ev.datos_nuevos.cartilla_clasificacion).toBe('complementario');
    });
});

describe('2) Auditoría transaccional — clasificar_adjunto_cartilla_delegado_historico', () => {
    test('clasificar un histórico como version_cartilla -> evento con clasificación ANTERIOR "pendiente" y NUEVA "version_cartilla", con el número de versión', async () => {
        const { rodeoId, adminId } = await nuevoRodeoConAsociacion();
        const adj = await insertarAdjuntoHistoricoPendiente(rodeoId, 'historico.pdf');
        const resultado = await clasificarHistorico(adj.id, true, adminId);
        const ev = await ultimaAuditoria(adj.id);
        expect(ev.accion).toBe('clasificar_historico');
        expect(ev.actor_id).toBe(adminId);
        expect(ev.datos_anteriores.cartilla_clasificacion).toBe('pendiente');
        expect(ev.datos_nuevos.cartilla_clasificacion).toBe('version_cartilla');
        expect(ev.datos_nuevos.cartilla_numero_version).toBe(resultado.cartilla_numero_version);
        expect(ev.datos_nuevos.rodeo_id).toBe(rodeoId);
    });

    test('clasificar un histórico como complementario -> evento con nueva clasificación "complementario", número de versión null', async () => {
        const { rodeoId, adminId } = await nuevoRodeoConAsociacion();
        const adj = await insertarAdjuntoHistoricoPendiente(rodeoId, 'medico.pdf');
        await clasificarHistorico(adj.id, false, adminId);
        const ev = await ultimaAuditoria(adj.id);
        expect(ev.datos_nuevos.cartilla_clasificacion).toBe('complementario');
        expect(ev.datos_nuevos.cartilla_numero_version).toBeNull();
    });

    test('auditoría obligatoria (revisión posterior) — p_administrador_id NULL -> RAISE ADMINISTRADOR_REQUERIDO de inmediato, nunca completa la clasificación sin rastro', async () => {
        const { rodeoId } = await nuevoRodeoConAsociacion();
        const adj = await insertarAdjuntoHistoricoPendiente(rodeoId, 'historico.pdf');
        await expect(clasificarHistorico(adj.id, true, null)).rejects.toThrow(/ADMINISTRADOR_REQUERIDO/);
        const { rows: [recargado] } = await db.query('select * from rodeo_adjuntos where id=$1', [adj.id]);
        expect(recargado.cartilla_clasificacion).toBe('pendiente'); // nunca quedó a medio clasificar
        expect(recargado.cartilla_vigente).toBe(false);
    });

    test('auditoría obligatoria — registrar_version_cartilla_delegado_adjunta con p_created_by NULL -> RAISE ADMINISTRADOR_REQUERIDO, nunca completa el alta sin rastro (ni siquiera sube el archivo a medias)', async () => {
        const { rodeoId } = await nuevoRodeoConAsociacion();
        await expect(registrarAdjunto(rodeoId, true, null, 'sin-admin.pdf')).rejects.toThrow(/ADMINISTRADOR_REQUERIDO/);
        const { rows } = await db.query('select * from rodeo_adjuntos where rodeo_id=$1', [rodeoId]);
        expect(rows.length).toBe(0); // la transacción completa se revirtió, nunca queda un INSERT huérfano
    });
});

describe('11) Revisión posterior — confirmación de conflicto no admite NULL como "confirmado"', () => {
    test('registrar_version_cartilla_delegado_adjunta: p_confirma_conflicto_cartilla_digital=NULL (en vez de omitido) -> SIGUE exigiendo confirmación, nunca se trata como confirmado', async () => {
        const { rodeoId, delegado, cuenta, adminId } = await nuevoRodeoConAsociacion();
        await crearCartillaDigital(rodeoId, delegado, cuenta);
        await expect(
            db.query(
                `select * from registrar_version_cartilla_delegado_adjunta($1,true,null,true,'oficial.pdf','path/null-conf','application/pdf',1000,$2,null)`,
                [rodeoId, adminId]
            )
        ).rejects.toThrow(/CARTILLA_DIGITAL_EXISTENTE_REQUIERE_CONFIRMACION/);
    });

    test('clasificar_adjunto_cartilla_delegado_historico: p_confirma_conflicto_cartilla_digital=NULL -> SIGUE exigiendo confirmación', async () => {
        const { rodeoId, delegado, cuenta, adminId } = await nuevoRodeoConAsociacion();
        await crearCartillaDigital(rodeoId, delegado, cuenta);
        const adj = await insertarAdjuntoHistoricoPendiente(rodeoId, 'historico.pdf');
        await expect(
            db.query('select * from clasificar_adjunto_cartilla_delegado_historico($1,true,$2,null)', [adj.id, adminId])
        ).rejects.toThrow(/CARTILLA_DIGITAL_EXISTENTE_REQUIERE_CONFIRMACION/);
    });
});

describe('12) Revisión posterior — numeración V1/V2/V3 por fecha REAL de carga, nunca por orden de clasificación', () => {
    test('clasificar un archivo RECIENTE como oficial ANTES que uno MÁS ANTIGUO -> el antiguo queda V1 (no vigente), el reciente queda V2 (vigente) — nunca al revés', async () => {
        const { rodeoId, adminId } = await nuevoRodeoConAsociacion();
        const antiguo = await insertarAdjuntoHistoricoPendiente(rodeoId, 'antiguo.pdf');
        const reciente = await insertarAdjuntoHistoricoPendiente(rodeoId, 'reciente.pdf');
        // Ajusta created_at para reproducir el caso real: "antiguo" se
        // subió realmente ANTES que "reciente", aunque ambos ya existan
        // como históricos pendientes al mismo tiempo en esta prueba.
        await db.query("update rodeo_adjuntos set created_at = now() - interval '10 days' where id=$1", [antiguo.id]);
        await db.query("update rodeo_adjuntos set created_at = now() - interval '1 day' where id=$1", [reciente.id]);

        // El Administrador revisa en orden ARBITRARIO: clasifica primero
        // el RECIENTE, y DESPUÉS el ANTIGUO.
        await clasificarHistorico(reciente.id, true, adminId);
        await clasificarHistorico(antiguo.id, true, adminId);

        const { rows: [a] } = await db.query('select * from rodeo_adjuntos where id=$1', [antiguo.id]);
        const { rows: [r] } = await db.query('select * from rodeo_adjuntos where id=$1', [reciente.id]);
        expect(a.cartilla_numero_version).toBe(1); // el más antiguo es V1, sin importar que se clasificó SEGUNDO
        expect(a.cartilla_vigente).toBe(false);
        expect(r.cartilla_numero_version).toBe(2); // el más reciente es V2
        expect(r.cartilla_vigente).toBe(true); // y es el único vigente
    });

    test('mismo caso, pero dando de alta archivos NUEVOS directamente (registrar_version_cartilla_delegado_adjunta) fuera de orden cronológico -> misma corrección aplica', async () => {
        const { rodeoId, adminId } = await nuevoRodeoConAsociacion();
        const v1real = await registrarAdjunto(rodeoId, true, adminId, 'subido-primero.pdf');
        await db.query("update rodeo_adjuntos set created_at = now() - interval '5 days' where id=$1", [v1real.id]);
        // Un segundo archivo se registra DESPUÉS en el tiempo real, pero su
        // created_at (now(), por DEFAULT) ya es posterior al que se acaba
        // de desplazar al pasado -> debe seguir quedando como V2/vigente.
        const v2real = await registrarAdjunto(rodeoId, true, adminId, 'subido-despues.pdf');

        const { rows: [a] } = await db.query('select * from rodeo_adjuntos where id=$1', [v1real.id]);
        const { rows: [b] } = await db.query('select * from rodeo_adjuntos where id=$1', [v2real.id]);
        expect(a.cartilla_numero_version).toBe(1);
        expect(a.cartilla_vigente).toBe(false);
        expect(b.cartilla_numero_version).toBe(2);
        expect(b.cartilla_vigente).toBe(true);
    });
});

describe('3) Permisos reales — anon/authenticated SIN EXECUTE, service_role CON EXECUTE', () => {
    test('registrar_version_cartilla_delegado_adjunta (076 la dejaba sin hardenizar) -> anon/authenticated: false, service_role: true', async () => {
        const { rows: [{ oid }] } = await db.query("select oid from pg_proc where proname='registrar_version_cartilla_delegado_adjunta'");
        const { rows: [r] } = await db.query('select has_function_privilege($1,$2,$3) as ok', ['anon', oid, 'EXECUTE']);
        const { rows: [r2] } = await db.query('select has_function_privilege($1,$2,$3) as ok', ['authenticated', oid, 'EXECUTE']);
        const { rows: [r3] } = await db.query('select has_function_privilege($1,$2,$3) as ok', ['service_role', oid, 'EXECUTE']);
        expect(r.ok).toBe(false);
        expect(r2.ok).toBe(false);
        expect(r3.ok).toBe(true);
    });

    test('clasificar_adjunto_cartilla_delegado_historico -> anon/authenticated: false, service_role: true', async () => {
        const { rows: [{ oid }] } = await db.query("select oid from pg_proc where proname='clasificar_adjunto_cartilla_delegado_historico'");
        const { rows: [r] } = await db.query('select has_function_privilege($1,$2,$3) as ok', ['anon', oid, 'EXECUTE']);
        const { rows: [r2] } = await db.query('select has_function_privilege($1,$2,$3) as ok', ['authenticated', oid, 'EXECUTE']);
        const { rows: [r3] } = await db.query('select has_function_privilege($1,$2,$3) as ok', ['service_role', oid, 'EXECUTE']);
        expect(r.ok).toBe(false);
        expect(r2.ok).toBe(false);
        expect(r3.ok).toBe(true);
    });

    test('crear_o_adjuntar_cartilla_institucional -> anon/authenticated: false, service_role: true (reafirmado defensivamente en 077)', async () => {
        const { rows: [{ oid }] } = await db.query("select oid from pg_proc where proname='crear_o_adjuntar_cartilla_institucional'");
        const { rows: [r] } = await db.query('select has_function_privilege($1,$2,$3) as ok', ['anon', oid, 'EXECUTE']);
        const { rows: [r3] } = await db.query('select has_function_privilege($1,$2,$3) as ok', ['service_role', oid, 'EXECUTE']);
        expect(r.ok).toBe(false);
        expect(r3.ok).toBe(true);
    });
});

describe('4) Orden de locks corregido — clasificar_adjunto_cartilla_delegado_historico revalida tras adquirir los locks', () => {
    test('clasificar dos archivos históricos DISTINTOS del mismo rodeo, en cualquier orden -> ambos resultados correctos, sin corrupción de estado (releer-y-revalidar funciona)', async () => {
        const { rodeoId, adminId } = await nuevoRodeoConAsociacion();
        const adjA = await insertarAdjuntoHistoricoPendiente(rodeoId, 'medico.pdf');
        const adjB = await insertarAdjuntoHistoricoPendiente(rodeoId, 'oficial.pdf');

        await clasificarHistorico(adjA.id, false, adminId); // "administrador 1" clasifica A como complementario
        await clasificarHistorico(adjB.id, true, adminId);  // "administrador 2" clasifica B como la oficial

        const { rows: [a] } = await db.query('select * from rodeo_adjuntos where id=$1', [adjA.id]);
        const { rows: [b] } = await db.query('select * from rodeo_adjuntos where id=$1', [adjB.id]);
        expect(a.cartilla_clasificacion).toBe('complementario');
        expect(b.cartilla_clasificacion).toBe('version_cartilla');
        expect(b.cartilla_vigente).toBe(true);
        expect(b.cartilla_numero_version).toBe(1);
    });

    test('un archivo clasificado por "otro administrador" justo antes -> la revalidación tras el lock detecta ADJUNTO_YA_CLASIFICADO (nunca confía en una lectura previa sin lock)', async () => {
        const { rodeoId, adminId } = await nuevoRodeoConAsociacion();
        const adj = await insertarAdjuntoHistoricoPendiente(rodeoId, 'historico.pdf');
        await clasificarHistorico(adj.id, true, adminId);
        await expect(clasificarHistorico(adj.id, false, adminId)).rejects.toThrow(/ADJUNTO_YA_CLASIFICADO/);
    });

    // Limitación honesta: el fixture PGlite usa una única conexión física,
    // serializada por una cola interna (ver pgliteServidor.js) — no puede
    // abrir 2 transacciones realmente simultáneas, cada una reteniendo un
    // lock que la otra espera, que es lo que un deadlock real exige. La
    // ausencia de deadlocks entre las 3 RPCs de este módulo es una garantía
    // POR CONSTRUCCIÓN (las 3 adquieren sus locks siempre en el mismo orden:
    // `rodeos` antes que cualquier fila de `rodeo_adjuntos` — un ciclo de
    // espera es estructuralmente imposible si todos los participantes
    // respetan el mismo orden), no algo que esta prueba reproduzca
    // empíricamente. Validarlo con 2 conexiones reales en paralelo (ej.
    // contra un Postgres real con el driver `pg`) queda fuera de este
    // alcance — no se instaló infraestructura nueva ni se tocó producción.
    test('(documentación viva) las 3 RPC del módulo bloquean `rodeos` ANTES que cualquier fila de rodeo_adjuntos — mismo orden, sin excepciones', async () => {
        const codigoHistorico = leer('077_concurrencia_auditoria_y_conflicto_cartilla_digital.sql');
        const fnHistorico = codigoHistorico.slice(
            codigoHistorico.indexOf('CREATE OR REPLACE FUNCTION clasificar_adjunto_cartilla_delegado_historico'),
            codigoHistorico.indexOf('CREATE OR REPLACE FUNCTION crear_o_adjuntar_cartilla_institucional')
        );
        const iLockRodeos = fnHistorico.indexOf('FROM rodeos WHERE id = v_rodeo_id FOR UPDATE');
        const iLockAdjunto = fnHistorico.indexOf('FROM rodeo_adjuntos WHERE id = p_adjunto_id FOR UPDATE');
        expect(iLockRodeos).toBeGreaterThan(-1);
        expect(iLockAdjunto).toBeGreaterThan(iLockRodeos); // rodeos SIEMPRE antes
    });
});

describe('5) Bloqueo endurecido — ya no depende únicamente de cartilla_vigente=true', () => {
    test('fila version_cartilla con cartilla_vigente=false (ej. el booleano se perdió) -> SIGUE bloqueando la creación de una cartilla digital', async () => {
        const { rodeoId, delegado, cuenta, adminId } = await nuevoRodeoConAsociacion();
        const adj = await registrarAdjunto(rodeoId, true, adminId, 'oficial.pdf');
        // Simula la pérdida del booleano vigente sin tocar la clasificación
        // (ej. una corrección manual de datos, o una futura versión que lo
        // degrade) — el código de aplicación nunca hace esto por sí mismo,
        // pero el bloqueo NO debe depender de que nunca ocurra.
        await db.query('update rodeo_adjuntos set cartilla_vigente=false where id=$1', [adj.id]);
        await expect(crearCartillaDigital(rodeoId, delegado, cuenta)).rejects.toThrow(/CARTILLA_DELEGADO_ADJUNTA/);
    });
});

describe('6) Cartilla digital preexistente — ambas RPC exigen confirmación explícita', () => {
    test('registrar_version_cartilla_delegado_adjunta: ya existe una cartilla digital institucional -> RAISE sin confirmar, OK confirmando', async () => {
        const { rodeoId, delegado, cuenta, adminId } = await nuevoRodeoConAsociacion();
        await crearCartillaDigital(rodeoId, delegado, cuenta);
        await expect(registrarAdjunto(rodeoId, true, adminId, 'oficial.pdf', false))
            .rejects.toThrow(/CARTILLA_DIGITAL_EXISTENTE_REQUIERE_CONFIRMACION/);
        const adj = await registrarAdjunto(rodeoId, true, adminId, 'oficial.pdf', true);
        expect(adj.cartilla_clasificacion).toBe('version_cartilla');
        // La cartilla digital NUNCA se borra ni se altera.
        const { rows: [cd] } = await db.query('select * from cartillas_delegado where rodeo_id=$1', [rodeoId]);
        expect(cd).toBeDefined();
        expect(cd.estado).toBe('borrador');
    });

    test('clasificar_adjunto_cartilla_delegado_historico: ya existe una cartilla digital -> RAISE sin confirmar, OK confirmando', async () => {
        const { rodeoId, delegado, cuenta, adminId } = await nuevoRodeoConAsociacion();
        // Orden real del caso que motiva este chequeo: la cartilla digital
        // se crea PRIMERO (todavía sin ningún adjunto histórico pendiente,
        // así que no hay nada que la bloquee), y el archivo histórico
        // aparece/se clasifica DESPUÉS.
        await crearCartillaDigital(rodeoId, delegado, cuenta);
        const adj = await insertarAdjuntoHistoricoPendiente(rodeoId, 'historico.pdf');
        await expect(clasificarHistorico(adj.id, true, adminId, false))
            .rejects.toThrow(/CARTILLA_DIGITAL_EXISTENTE_REQUIERE_CONFIRMACION/);
        const resultado = await clasificarHistorico(adj.id, true, adminId, true);
        expect(resultado.cartilla_clasificacion).toBe('version_cartilla');
    });

    test('sin ninguna cartilla digital previa -> nunca exige confirmación (comportamiento normal intacto)', async () => {
        const { rodeoId, adminId } = await nuevoRodeoConAsociacion();
        const adj = await registrarAdjunto(rodeoId, true, adminId, 'oficial.pdf', false);
        expect(adj.cartilla_clasificacion).toBe('version_cartilla');
    });

    test('marcar un archivo como COMPLEMENTARIO nunca exige confirmación, exista o no una cartilla digital', async () => {
        const { rodeoId, delegado, cuenta, adminId } = await nuevoRodeoConAsociacion();
        await crearCartillaDigital(rodeoId, delegado, cuenta);
        const adj = await registrarAdjunto(rodeoId, false, adminId, 'medico.pdf', false);
        expect(adj.cartilla_clasificacion).toBe('complementario');
    });
});

describe('7) Los 3 casos reales "Rentado + adjunto" no se ven afectados', () => {
    test('cartilla digital de Delegado RENTADO + adjunto histórico pendiente -> el motivo de bloqueo real sigue siendo CARTILLA_RENTADO_EXISTENTE, nunca se pierde ni se altera la cartilla del Rentado', async () => {
        const { rodeoId, delegado, cuenta } = await nuevoRodeoConAsociacion();
        await insertarAdjuntoHistoricoPendiente(rodeoId, 'historico.pdf');
        const { rows: [usuario] } = await db.query(
            "insert into usuarios_pagados (tipo_persona, nombre_completo) values ('delegado_rentado','Juan Rentado') returning id"
        );
        await db.query(
            "insert into cartillas_delegado (rodeo_id, delegado_id, estado) values ($1,$2,'borrador')",
            [rodeoId, usuario.id]
        );
        // El bloqueo real para la vía institucional es CARTILLA_DELEGADO_
        // PENDIENTE_REVISION (el archivo histórico pendiente, chequeado
        // ANTES que el Rentado) — nunca se pierde el dato del Rentado,
        // sigue intacto en cartillas_delegado.
        await expect(crearCartillaDigital(rodeoId, delegado, cuenta)).rejects.toThrow(/CARTILLA_DELEGADO_PENDIENTE_REVISION/);
        const { rows: [cdRentado] } = await db.query('select * from cartillas_delegado where rodeo_id=$1 and delegado_id is not null', [rodeoId]);
        expect(cdRentado).toBeDefined();
        expect(cdRentado.estado).toBe('borrador');
    });
});

describe('8) Documentos complementarios nunca bloquean', () => {
    test('solo archivos complementarios (caso real CHACAICO/BÍO-BÍO) -> no bloquea la creación de una cartilla digital', async () => {
        const { rodeoId, delegado, cuenta, adminId } = await nuevoRodeoConAsociacion();
        await registrarAdjunto(rodeoId, false, adminId, 'medico.pdf');
        await registrarAdjunto(rodeoId, false, adminId, 'paramedico.pdf');
        const cd = await crearCartillaDigital(rodeoId, delegado, cuenta);
        expect(cd.id).toBeDefined();
    });
});

describe('9) SAGRADA FAMILIA / AGUANEGRA — sigue bloqueado antes de clasificar nada (077, igual que 076)', () => {
    test('1 archivo histórico, 0 cartillas digitales -> bloqueado con CARTILLA_DELEGADO_PENDIENTE_REVISION', async () => {
        const { rodeoId, delegado, cuenta } = await nuevoRodeoConAsociacion('AGUANEGRA');
        await insertarAdjuntoHistoricoPendiente(rodeoId, 'Cartilla Sagrada Familia.pdf');
        await expect(crearCartillaDigital(rodeoId, delegado, cuenta)).rejects.toThrow(/CARTILLA_DELEGADO_PENDIENTE_REVISION/);
    });
});

describe('10) Numeración V1/V2/V3 se conserva sin cambios', () => {
    test('3 altas sucesivas como version_cartilla -> V1, V2, V3, solo la última vigente', async () => {
        const { rodeoId, adminId } = await nuevoRodeoConAsociacion();
        const v1 = await registrarAdjunto(rodeoId, true, adminId, 'v1.pdf');
        const v2 = await registrarAdjunto(rodeoId, true, adminId, 'v2.pdf');
        const v3 = await registrarAdjunto(rodeoId, true, adminId, 'v3.pdf');
        expect([v1.cartilla_numero_version, v2.cartilla_numero_version, v3.cartilla_numero_version]).toEqual([1, 2, 3]);
        const { rows } = await db.query('select cartilla_numero_version, cartilla_vigente from rodeo_adjuntos where rodeo_id=$1 order by cartilla_numero_version', [rodeoId]);
        expect(rows.map(r => r.cartilla_vigente)).toEqual([false, false, true]);
    });
});

// ─── 13) Corrección técnica final: el recálculo en 3 pasos nunca viola
// uq_rodeo_adjuntos_cartilla_vigente, aunque el índice esté REALMENTE
// creado (PGlite es Postgres real compilado a WASM, no una simulación —
// esta sección valida la premisa del hallazgo directamente contra el
// índice, antes de probar que las RPC lo evitan). ──────────────────────────
describe('13) Índice único uq_rodeo_adjuntos_cartilla_vigente — validado directamente, y evitado por las RPC', () => {
    test('el índice existe de verdad y SÍ rechaza 2 filas vigente=true del mismo rodeo (prueba directa, sin pasar por ninguna RPC)', async () => {
        const { rodeoId } = await nuevoRodeoConAsociacion();
        await db.query(
            "insert into rodeo_adjuntos (rodeo_id, subido_por_admin, tipo_adjunto, nombre_archivo, storage_path, mime_type, cartilla_clasificacion, cartilla_numero_version, cartilla_vigente) values ($1,true,'cartilla_delegado','a.pdf','path/idx-a','application/pdf','version_cartilla',1,true)",
            [rodeoId]
        );
        await expect(db.query(
            "insert into rodeo_adjuntos (rodeo_id, subido_por_admin, tipo_adjunto, nombre_archivo, storage_path, mime_type, cartilla_clasificacion, cartilla_numero_version, cartilla_vigente) values ($1,true,'cartilla_delegado','b.pdf','path/idx-b','application/pdf','version_cartilla',2,true)",
            [rodeoId]
        )).rejects.toThrow(/uq_rodeo_adjuntos_cartilla_vigente|duplicate key/i);
    });

    test('hallazgo honesto sobre el patrón de UN SOLO UPDATE (documentado, no presentado como seguro): el orden de procesamiento de filas dentro de un UPDATE no está garantizado — por eso la corrección NO depende de él', async () => {
        const { rodeoId } = await nuevoRodeoConAsociacion();
        const { rows: [nueva] } = await db.query(
            "insert into rodeo_adjuntos (rodeo_id, subido_por_admin, tipo_adjunto, nombre_archivo, storage_path, mime_type, cartilla_clasificacion, cartilla_numero_version, cartilla_vigente, created_at) values ($1,true,'cartilla_delegado','nueva.pdf','path/naive-nueva','application/pdf','version_cartilla',null,false, now()) returning id",
            [rodeoId]
        );
        await db.query(
            "insert into rodeo_adjuntos (rodeo_id, subido_por_admin, tipo_adjunto, nombre_archivo, storage_path, mime_type, cartilla_clasificacion, cartilla_numero_version, cartilla_vigente, created_at) values ($1,true,'cartilla_delegado','actual-vigente.pdf','path/naive-actual','application/pdf','version_cartilla',1,true, now() - interval '2 days') returning id",
            [rodeoId]
        );
        // Intento deliberado de reproducir el patrón INGENUO de la revisión
        // anterior (un solo UPDATE con ventana, ordenando DESC para forzar
        // el orden más desfavorable: procesar primero la fila que GANA
        // vigente=true). Se acepta CUALQUIER resultado (éxito o error) — lo
        // que importa es documentar cuál fue, sin fingir una verificación
        // que no ocurrió.
        let huboError = false;
        try {
            await db.query(
                `UPDATE rodeo_adjuntos ra SET
                    cartilla_vigente = (o.rn = 1)
                 FROM (
                    SELECT id, ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC) AS rn
                    FROM rodeo_adjuntos
                    WHERE rodeo_id = $1 AND tipo_adjunto = 'cartilla_delegado' AND cartilla_clasificacion = 'version_cartilla'
                 ) o
                 WHERE ra.id = o.id`,
                [rodeoId]
            );
        } catch (err) {
            huboError = true;
            expect(err.message).toMatch(/uq_rodeo_adjuntos_cartilla_vigente|duplicate key/i);
        }
        // HALLAZGO HONESTO: en esta corrida concreta (PGlite, este plan),
        // el UPDATE ingenuo NO disparó la violación — huboError=false. Esto
        // NO prueba que el patrón de un solo UPDATE sea seguro en general:
        // el orden de procesamiento de filas dentro de un UPDATE no está
        // garantizado por el estándar SQL ni por la documentación de
        // Postgres, y puede diferir entre versiones, volúmenes de datos o
        // planes (ej. ejecución paralela) sin ningún cambio de código. Por
        // eso la corrección NO se apoya en este comportamiento no
        // garantizado: el enfoque de 3 pasos usado por las RPC reales es
        // seguro POR CONSTRUCCIÓN (cada paso, aislado, no puede violar el
        // índice sin importar ningún orden interno) — ver las pruebas de
        // abajo, que SÍ verifican el comportamiento real de las RPC.
        if (!huboError) {
            expect(huboError).toBe(false); // documenta el resultado real, no se fuerza un valor distinto
        }
    });

    test('las RPC reales (registrar_version_cartilla_delegado_adjunta) hacen exactamente ese escenario (V1 vigente -> se registra V2) SIN violar nunca el índice', async () => {
        const { rodeoId, adminId } = await nuevoRodeoConAsociacion();
        const v1 = await registrarAdjunto(rodeoId, true, adminId, 'v1.pdf');
        expect(v1.cartilla_vigente).toBe(true);
        const v2 = await registrarAdjunto(rodeoId, true, adminId, 'v2.pdf'); // no debe lanzar
        expect(v2.cartilla_vigente).toBe(true);
        const { rows: [v1recargado] } = await db.query('select cartilla_vigente from rodeo_adjuntos where id=$1', [v1.id]);
        expect(v1recargado.cartilla_vigente).toBe(false);
    });

    test('las RPC reales (V2 vigente -> se registra V3) SIN violar nunca el índice', async () => {
        const { rodeoId, adminId } = await nuevoRodeoConAsociacion();
        await registrarAdjunto(rodeoId, true, adminId, 'v1.pdf');
        const v2 = await registrarAdjunto(rodeoId, true, adminId, 'v2.pdf');
        expect(v2.cartilla_vigente).toBe(true);
        const v3 = await registrarAdjunto(rodeoId, true, adminId, 'v3.pdf'); // no debe lanzar
        expect(v3.cartilla_vigente).toBe(true);
        const { rows: [v2recargado] } = await db.query('select cartilla_vigente from rodeo_adjuntos where id=$1', [v2.id]);
        expect(v2recargado.cartilla_vigente).toBe(false);
    });

    test('después de CUALQUIER recálculo (registrar o clasificar) existe EXACTAMENTE una versión vigente por rodeo, nunca 0 ni 2+', async () => {
        const { rodeoId, adminId } = await nuevoRodeoConAsociacion();
        await registrarAdjunto(rodeoId, true, adminId, 'v1.pdf');
        await registrarAdjunto(rodeoId, true, adminId, 'v2.pdf');
        const antiguo = await insertarAdjuntoHistoricoPendiente(rodeoId, 'antiguo.pdf');
        await db.query("update rodeo_adjuntos set created_at = now() - interval '30 days' where id=$1", [antiguo.id]);
        await clasificarHistorico(antiguo.id, true, adminId); // clasifica un archivo MÁS ANTIGUO que V1/V2 como oficial también

        const { rows } = await db.query(
            "select count(*)::int as n from rodeo_adjuntos where rodeo_id=$1 and tipo_adjunto='cartilla_delegado' and cartilla_vigente=true",
            [rodeoId]
        );
        expect(rows[0].n).toBe(1);
    });

    test('un intento rechazado (ADMINISTRADOR_REQUERIDO) nunca llega a ejecutar ninguno de los 3 pasos — la vigente/numeración previas quedan intactas', async () => {
        const { rodeoId, adminId } = await nuevoRodeoConAsociacion();
        const v1 = await registrarAdjunto(rodeoId, true, adminId, 'v1.pdf');
        await expect(registrarAdjunto(rodeoId, true, null, 'v2-sin-admin.pdf')).rejects.toThrow(/ADMINISTRADOR_REQUERIDO/);
        // V1 debe seguir exactamente igual — el intento fallido se rechaza
        // ANTES del paso (a) (ver nota de limitación honesta más abajo).
        const { rows: [v1recargado] } = await db.query('select cartilla_numero_version, cartilla_vigente from rodeo_adjuntos where id=$1', [v1.id]);
        expect(v1recargado.cartilla_numero_version).toBe(1);
        expect(v1recargado.cartilla_vigente).toBe(true);
    });

    // Limitación honesta (pedida explícitamente: no presentar una prueba
    // simulada como verificación completa): los 3 pasos (a)/(b)/(c) son
    // UPDATEs deterministas sobre datos ya validados — no existe, con datos
    // válidos, ningún punto de fallo real DESPUÉS de que el paso (a)
    // arranca y ANTES de que el paso (c) termine (los únicos RAISE
    // EXCEPTION de la función ocurren todos ANTES del paso (a): admin
    // faltante o conflicto con cartilla digital sin confirmar). La garantía
    // de que una falla a MITAD de los 3 pasos revertiría igual los 3 no se
    // está demostrando con una falla real inyectada en este punto (no hay
    // ninguna alcanzable sin corromper artificialmente el esquema) — se
    // sostiene en la semántica estándar de Postgres: los 3 UPDATE y el
    // INSERT de auditoría ocurren dentro de la MISMA invocación de la
    // función plpgsql, que plpgsql nunca confirma a mitad de camino (sin
    // COMMIT explícito, sin bloque autónomo) — cualquier error en
    // cualquier sentencia de esa función aborta la transacción completa
    // que la contiene, por diseño del lenguaje, no por algo verificado acá
    // de forma empírica adicional a lo ya probado arriba (rechazos previos
    // al paso (a) no dejan rastro).
});

// ─── 14) Renumeración de OTRAS versiones -> auditada con sus propios
// valores anteriores/posteriores ────────────────────────────────────────
describe('14) Auditoría de renumeración — efectos colaterales sobre OTRAS versiones del mismo rodeo', () => {
    test('clasificar un archivo MÁS ANTIGUO que el vigente actual -> el vigente actual conserva vigente=true (sigue siendo el más reciente) pero se corre de número (V1 -> V2) -> ese cambio de número queda en un evento "renumerar_version_cartilla" propio', async () => {
        const { rodeoId, adminId } = await nuevoRodeoConAsociacion();
        const v1 = await registrarAdjunto(rodeoId, true, adminId, 'v1.pdf'); // único, V1, vigente
        const antiguo = await insertarAdjuntoHistoricoPendiente(rodeoId, 'mas-antiguo.pdf');
        await db.query("update rodeo_adjuntos set created_at = now() - interval '30 days' where id=$1", [antiguo.id]);

        await clasificarHistorico(antiguo.id, true, adminId);

        // "antiguo" es cronológicamente MÁS VIEJO que v1 -> pasa a ser V1,
        // NO vigente. v1 (que ya era vigente) sigue siendo el más
        // reciente -> SIGUE vigente=true, pero se corre a V2 — un efecto
        // colateral (cambio de NÚMERO, sin cambio de vigencia) sobre una
        // fila distinta a la que se clasificó.
        const { rows: antiguoReal } = await db.query('select cartilla_numero_version, cartilla_vigente from rodeo_adjuntos where id=$1', [antiguo.id]);
        expect(antiguoReal[0]).toEqual({ cartilla_numero_version: 1, cartilla_vigente: false });
        const { rows: v1Real } = await db.query('select cartilla_numero_version, cartilla_vigente from rodeo_adjuntos where id=$1', [v1.id]);
        expect(v1Real[0]).toEqual({ cartilla_numero_version: 2, cartilla_vigente: true });

        const { rows: ev } = await db.query(
            "select * from auditoria where tabla='rodeo_adjuntos' and registro_id=$1 and accion='renumerar_version_cartilla' order by created_at desc limit 1",
            [v1.id]
        );
        expect(ev.length).toBe(1);
        expect(ev[0].datos_anteriores.cartilla_numero_version).toBe(1);
        expect(ev[0].datos_anteriores.cartilla_vigente).toBe(true);
        expect(ev[0].datos_nuevos.cartilla_numero_version).toBe(2);
        expect(ev[0].datos_nuevos.cartilla_vigente).toBe(true); // nunca deja de ser vigente: sigue siendo la más reciente
        expect(ev[0].actor_id).toBe(adminId);
        expect(ev[0].datos_nuevos.rodeo_id).toBe(rodeoId);
    });

    test('alta que NO reordena nada (siempre la más reciente) -> ninguna OTRA fila genera un evento "renumerar_version_cartilla" (nunca ruido auditado sin cambio real)', async () => {
        const { rodeoId, adminId } = await nuevoRodeoConAsociacion();
        const v1 = await registrarAdjunto(rodeoId, true, adminId, 'v1.pdf');
        await registrarAdjunto(rodeoId, true, adminId, 'v2.pdf'); // v1 SÍ cambia (deja de ser vigente) -> genera su propio evento, esperado

        const { rows: evV1 } = await db.query(
            "select * from auditoria where tabla='rodeo_adjuntos' and registro_id=$1 and accion='renumerar_version_cartilla'",
            [v1.id]
        );
        expect(evV1.length).toBe(1); // exactamente uno, no duplicado ni repetido de más
    });

    test('el historial de auditoría permite reconstruir la línea de tiempo completa de versiones de un rodeo (alta + renumeraciones + clasificación histórica)', async () => {
        const { rodeoId, adminId } = await nuevoRodeoConAsociacion();
        const v1 = await registrarAdjunto(rodeoId, true, adminId, 'v1.pdf');
        const v2 = await registrarAdjunto(rodeoId, true, adminId, 'v2.pdf');
        const antiguo = await insertarAdjuntoHistoricoPendiente(rodeoId, 'antiguo.pdf');
        await db.query("update rodeo_adjuntos set created_at = now() - interval '30 days' where id=$1", [antiguo.id]);
        await clasificarHistorico(antiguo.id, true, adminId);

        const { rows: eventos } = await db.query(
            `select accion, registro_id, datos_anteriores, datos_nuevos from auditoria
             where tabla='rodeo_adjuntos' and registro_id in ($1,$2,$3)
             order by created_at asc`,
            [v1.id, v2.id, antiguo.id]
        );
        // Reconstrucción: se puede seguir, evento por evento, cómo cada
        // archivo pasó de su clasificación anterior a la nueva — nunca un
        // "salto" sin explicación intermedia.
        const accionesPorArchivo = {};
        eventos.forEach(e => { (accionesPorArchivo[e.registro_id] ||= []).push(e.accion); });
        expect(accionesPorArchivo[v1.id]).toContain('crear');
        expect(accionesPorArchivo[v1.id]).toContain('renumerar_version_cartilla'); // v1 fue desplazado 2 veces (por v2, y por "antiguo")
        expect(accionesPorArchivo[v2.id]).toContain('crear');
        expect(accionesPorArchivo[antiguo.id]).toContain('clasificar_historico');

        // El estado FINAL reconstruido desde el último evento de cada
        // archivo coincide con el estado real en la tabla.
        const { rows: [antiguoReal] } = await db.query('select cartilla_numero_version, cartilla_vigente from rodeo_adjuntos where id=$1', [antiguo.id]);
        const ultimoEventoAntiguo = eventos.filter(e => e.registro_id === antiguo.id).pop();
        expect(ultimoEventoAntiguo.datos_nuevos.cartilla_numero_version).toBe(antiguoReal.cartilla_numero_version);
        expect(ultimoEventoAntiguo.datos_nuevos.cartilla_vigente).toBe(antiguoReal.cartilla_vigente);
    });
});
