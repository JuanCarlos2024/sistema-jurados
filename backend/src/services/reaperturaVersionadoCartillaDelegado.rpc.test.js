// Validación contra Postgres REAL (PGlite) de la migración 092 — "Reabrir" +
// versionado histórico de la Cartilla Digital de Delegado (ambas
// modalidades). Mismo patrón que sincronizacionDuracionRodeo.rpc.test.js:
// aplica las migraciones reales en orden de producción y ejercita las RPC
// directamente contra una base real, incluida su seguridad (REVOKE/GRANT) y
// transaccionalidad (rollback real ante un fallo forzado a mitad de camino).
const fs = require('fs');
const path = require('path');
jest.setTimeout(120000);
const { crearDb } = require('./__fixtures__/pgliteCliente');

const MIGRACIONES_DIR = path.join(__dirname, '..', '..', '..', 'database', 'migrations');
const leer = (n) => fs.readFileSync(path.join(MIGRACIONES_DIR, n), 'utf8');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaCartillaInstitucional.sql'), 'utf8');

const MIGRACIONES_061_A_072 = [
    '061_cuentas_institucionales.sql', '062_delegados_asociacion.sql',
    '064_delegados_asociacion_certificado.sql', '065_cartillas_delegado_institucional.sql',
    '066_rpc_cartilla_institucional.sql', '067_control_transaccional_designacion_cartilla.sql',
    '068_seleccion_delegado_institucional_por_rodeo.sql', '069_responsable_unico_institucional.sql',
    '070_auditoria_transaccional_institucional.sql', '071_seguridad_tablas_rpc_institucionales.sql',
    '072_correccion_check_estado_cartilla_reenviada.sql'
];

let db;
beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);
    await db.exec(leer('037_cartilla_delegado.sql'));
    for (const m of MIGRACIONES_061_A_072) await db.exec(leer(m));
    await db.exec(leer('092_reapertura_versionado_cartilla_delegado.sql'));
});
afterAll(async () => { await db.close(); });

let seq = 0;
async function nuevoRodeo() {
    seq++;
    const { rows: [r] } = await db.query(
        "insert into rodeos (club, asociacion, fecha) values ($1,'AGUANEGRA','2026-09-12') returning id",
        ['Club ' + seq]
    );
    return r.id;
}
async function nuevoUsuarioPagado(tipoPersona = 'delegado_rentado') {
    const { rows: [u] } = await db.query(
        "insert into usuarios_pagados (tipo_persona, nombre_completo) values ($1, 'Persona Prueba') returning id",
        [tipoPersona]
    );
    return u.id;
}
async function nuevaCuentaInstitucional() {
    seq++;
    const { rows: [a] } = await db.query(
        "insert into asociaciones (nombre, nombre_normalizado) values ($1, $1) returning id",
        ['ASOCIACION ' + seq]
    );
    const { rows: [c] } = await db.query(
        "insert into cuentas_institucionales (email, password_hash, asociacion_id) values ($1, 'hash', $2) returning id",
        [`cuenta${seq}@test.cl`, a.id]
    );
    return c.id;
}
async function nuevaCartillaRentado(rodeoId, delegadoId, estadoInicial = 'borrador') {
    const { rows: [c] } = await db.query(
        `insert into cartillas_delegado (rodeo_id, delegado_id, estado, delegado_nombre)
         values ($1, $2, $3, 'Delegado Prueba') returning *`,
        [rodeoId, delegadoId, estadoInicial]
    );
    return c;
}
async function cartillaPorId(id) {
    const { rows: [c] } = await db.query('select * from cartillas_delegado where id = $1', [id]);
    return c;
}
async function versionesDeCartilla(cartillaId) {
    const { rows } = await db.query(
        'select * from cartillas_delegado_versiones where cartilla_delegado_id = $1 order by numero_version',
        [cartillaId]
    );
    return rows;
}

describe('reabrir_cartilla_delegado', () => {
    test('rechaza motivo vacío, no toca la cartilla', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'enviada');

        await expect(db.query(
            "select reabrir_cartilla_delegado($1, '', $2, 'administrador', null)",
            [cartilla.id, delegadoId]
        )).rejects.toThrow(/MOTIVO_REQUERIDO/);

        const actual = await cartillaPorId(cartilla.id);
        expect(actual.estado).toBe('enviada');
    });

    test.each(['borrador', 'observada', 'reabierta'])('rechaza reapertura desde estado "%s" (no reabrible)', async (estadoInicial) => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, estadoInicial);

        await expect(db.query(
            "select reabrir_cartilla_delegado($1, 'motivo válido', $2, 'administrador', null)",
            [cartilla.id, delegadoId]
        )).rejects.toThrow(/ESTADO_NO_REABRIBLE/);
    });

    test.each(['enviada', 'reenviada', 'aprobada', 'cerrada'])('permite reabrir desde estado "%s"', async (estadoInicial) => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, estadoInicial);
        const adminId = await nuevoUsuarioPagado('delegado_rentado'); // solo necesitamos un UUID válido como actor

        const { rows: [resultado] } = await db.query(
            "select * from reabrir_cartilla_delegado($1, 'Falta corregir el nombre del secretario', $2, 'administrador', '10.0.0.1')",
            [cartilla.id, adminId]
        );

        expect(resultado.estado).toBe('reabierta');
        expect(resultado.motivo_reapertura).toBe('Falta corregir el nombre del secretario');
        expect(resultado.reabierta_por).toBe(adminId);
        expect(resultado.reabierta_en).not.toBeNull();

        const { rows: auditRows } = await db.query(
            "select * from auditoria where tabla='cartillas_delegado' and registro_id=$1 and accion='reabrir_cartilla'",
            [cartilla.id]
        );
        expect(auditRows.length).toBe(1);
        expect(auditRows[0].actor_id).toBe(adminId);
    });

    test('rodeo/cartilla inexistente -> CARTILLA_NO_ENCONTRADA', async () => {
        const adminId = await nuevoUsuarioPagado();
        await expect(db.query(
            "select reabrir_cartilla_delegado('00000000-0000-0000-0000-000000000000', 'motivo', $1, 'administrador', null)",
            [adminId]
        )).rejects.toThrow(/CARTILLA_NO_ENCONTRADA/);
    });
});

describe('registrar_envio_oficial_cartilla_delegado — primer envío (v1)', () => {
    test('crea numero_version_actual=1, inserta la versión histórica inmutable con el snapshot completo', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'borrador');

        const cambios = JSON.stringify({ enviada_en: '2026-09-12T10:00:00Z', historial_observaciones: [] });
        const { rows: [out] } = await db.query(
            `select registrar_envio_oficial_cartilla_delegado($1, null, $2::jsonb, 'enviada', $3, 'usuario_pagado', null) as resultado`,
            [cartilla.id, cambios, delegadoId]
        );
        const resultado = out.resultado;

        expect(resultado.numero_version).toBe(1);
        expect(resultado.cartilla.estado).toBe('enviada');
        expect(resultado.cartilla.numero_version_actual).toBe(1);

        const actual = await cartillaPorId(cartilla.id);
        expect(actual.estado).toBe('enviada');
        expect(actual.numero_version_actual).toBe(1);
        expect(actual.motivo_reapertura).toBeNull();

        const versiones = await versionesDeCartilla(cartilla.id);
        expect(versiones.length).toBe(1);
        expect(versiones[0].numero_version).toBe(1);
        expect(versiones[0].estado_version).toBe('enviada');
        expect(versiones[0].motivo_reapertura_previa).toBeNull();
        expect(versiones[0].snapshot.id).toBe(cartilla.id);
        expect(versiones[0].snapshot.estado).toBe('enviada');
        expect(versiones[0].enviada_por).toBe(delegadoId);
        expect(versiones[0].enviada_por_tipo).toBe('usuario_pagado');

        const { rows: auditRows } = await db.query(
            "select * from auditoria where tabla='cartillas_delegado' and registro_id=$1 and accion='enviar_cartilla'",
            [cartilla.id]
        );
        expect(auditRows.length).toBe(1);
    });

    test.each(['enviada', 'aprobada'])('rechaza enviar una cartilla ya en estado "%s" (no enviable)', async (estadoInicial) => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, estadoInicial);

        await expect(db.query(
            `select registrar_envio_oficial_cartilla_delegado($1, null, '{}'::jsonb, 'enviada', $2, 'usuario_pagado', null)`,
            [cartilla.id, delegadoId]
        )).rejects.toThrow(/ESTADO_NO_ENVIABLE/);
    });
});

describe('Ciclo completo — reapertura + reenvío crea versiones oficiales sucesivas (pedido del usuario: v1 -> reapertura -> v2 -> reapertura -> v3)', () => {
    test('v1 enviada, reabierta, v2 reenviada (archiva motivo/autor/fecha de la reapertura), reabierta otra vez, v3 reenviada — las 3 versiones quedan inmutables y distintas', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const adminId = await nuevoUsuarioPagado('delegado_rentado');
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'borrador');

        // v1
        await db.query('update cartillas_delegado set secretario_jurado = $1 where id = $2', ['Secretario V1', cartilla.id]);
        await db.query(
            `select registrar_envio_oficial_cartilla_delegado($1, null, $2::jsonb, 'enviada', $3, 'usuario_pagado', null)`,
            [cartilla.id, JSON.stringify({ enviada_en: '2026-09-12T10:00:00Z' }), delegadoId]
        );

        // Reapertura 1
        await db.query(
            "select reabrir_cartilla_delegado($1, 'Falta el secretario correcto', $2, 'administrador', null)",
            [cartilla.id, adminId]
        );
        let actual = await cartillaPorId(cartilla.id);
        expect(actual.estado).toBe('reabierta');

        // Delegado corrige y reenvía -> v2
        await db.query('update cartillas_delegado set secretario_jurado = $1 where id = $2', ['Secretario V2', cartilla.id]);
        await db.query(
            `select registrar_envio_oficial_cartilla_delegado($1, null, $2::jsonb, 'reenviada', $3, 'usuario_pagado', null)`,
            [cartilla.id, JSON.stringify({ reenviada_en: '2026-09-13T10:00:00Z' }), delegadoId]
        );
        actual = await cartillaPorId(cartilla.id);
        expect(actual.estado).toBe('reenviada');
        expect(actual.numero_version_actual).toBe(2);
        expect(actual.motivo_reapertura).toBeNull();

        // Reapertura 2
        await db.query(
            "select reabrir_cartilla_delegado($1, 'Falta corregir el teléfono', $2, 'administrador', null)",
            [cartilla.id, adminId]
        );

        // Delegado corrige y reenvía -> v3
        await db.query('update cartillas_delegado set secretario_jurado = $1 where id = $2', ['Secretario V3', cartilla.id]);
        await db.query(
            `select registrar_envio_oficial_cartilla_delegado($1, null, $2::jsonb, 'reenviada', $3, 'usuario_pagado', null)`,
            [cartilla.id, JSON.stringify({ reenviada_en: '2026-09-14T10:00:00Z' }), delegadoId]
        );
        actual = await cartillaPorId(cartilla.id);
        expect(actual.numero_version_actual).toBe(3);

        const versiones = await versionesDeCartilla(cartilla.id);
        expect(versiones.length).toBe(3);
        expect(versiones.map(v => v.numero_version)).toEqual([1, 2, 3]);
        expect(versiones.map(v => v.estado_version)).toEqual(['enviada', 'reenviada', 'reenviada']);
        expect(versiones.map(v => v.snapshot.secretario_jurado)).toEqual(['Secretario V1', 'Secretario V2', 'Secretario V3']);
        // v2 y v3 archivan el motivo/autor de SU reapertura previa respectiva — v1 nunca tuvo una.
        expect(versiones[0].motivo_reapertura_previa).toBeNull();
        expect(versiones[1].motivo_reapertura_previa).toBe('Falta el secretario correcto');
        expect(versiones[1].reabierta_por_previa).toBe(adminId);
        expect(versiones[2].motivo_reapertura_previa).toBe('Falta corregir el teléfono');
        // v1 nunca se sobrescribe ni se pierde — sigue exactamente igual.
        expect(versiones[0].snapshot.secretario_jurado).toBe('Secretario V1');
    });
});

describe('Concurrencia optimista OPCIONAL (p_version_esperada)', () => {
    test('Delegado Rentado (p_version_esperada = null): nunca valida versión, aunque la cartilla ya haya cambiado', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'borrador');
        await db.query('update cartillas_delegado set version = 99 where id = $1', [cartilla.id]);

        await expect(db.query(
            `select registrar_envio_oficial_cartilla_delegado($1, null, '{}'::jsonb, 'enviada', $2, 'usuario_pagado', null)`,
            [cartilla.id, delegadoId]
        )).resolves.toBeDefined();
    });

    test('Delegado de Asociación (p_version_esperada provisto): versión desactualizada -> CARTILLA_NO_ENCONTRADA_O_VERSION_DESACTUALIZADA, nada se modifica', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'borrador'); // version default = 1
        const cuentaId = await nuevaCuentaInstitucional();

        await expect(db.query(
            `select registrar_envio_oficial_cartilla_delegado($1, 99, '{}'::jsonb, 'enviada', $2, 'cuenta_institucional', null)`,
            [cartilla.id, cuentaId]
        )).rejects.toThrow(/CARTILLA_NO_ENCONTRADA_O_VERSION_DESACTUALIZADA/);

        const actual = await cartillaPorId(cartilla.id);
        expect(actual.estado).toBe('borrador');
        expect((await versionesDeCartilla(cartilla.id)).length).toBe(0);
    });

    test('Delegado de Asociación con versión correcta -> acepta y escribe en actualizado_por_cuenta_institucional_id, nunca en actualizado_por', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'borrador');
        const cuentaId = await nuevaCuentaInstitucional();

        await db.query(
            `select registrar_envio_oficial_cartilla_delegado($1, 1, '{}'::jsonb, 'enviada', $2, 'cuenta_institucional', null)`,
            [cartilla.id, cuentaId]
        );
        const actual = await cartillaPorId(cartilla.id);
        expect(actual.actualizado_por_cuenta_institucional_id).toBe(cuentaId);
        expect(actual.actualizado_por).toBeNull();

        const versiones = await versionesDeCartilla(cartilla.id);
        expect(versiones[0].enviada_por_tipo).toBe('cuenta_institucional');
        expect(versiones[0].enviada_por).toBe(cuentaId);
    });
});

describe('adjuntar_pdf_version_cartilla_delegado', () => {
    test('adjunta storage_path_pdf a una versión histórica ya creada', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'borrador');
        const { rows: [out] } = await db.query(
            `select registrar_envio_oficial_cartilla_delegado($1, null, '{}'::jsonb, 'enviada', $2, 'usuario_pagado', null) as resultado`,
            [cartilla.id, delegadoId]
        );
        const versionId = out.resultado.version_historica_id;

        const { rows: [actualizada] } = await db.query(
            "select * from adjuntar_pdf_version_cartilla_delegado($1, 'rodeos/cart/v1_123.pdf')",
            [versionId]
        );
        expect(actualizada.storage_path_pdf).toBe('rodeos/cart/v1_123.pdf');
    });

    test('versión histórica inexistente -> VERSION_HISTORICA_NO_ENCONTRADA', async () => {
        await expect(db.query(
            "select adjuntar_pdf_version_cartilla_delegado('00000000-0000-0000-0000-000000000000', 'x.pdf')"
        )).rejects.toThrow(/VERSION_HISTORICA_NO_ENCONTRADA/);
    });

    // Protección del PDF histórico (revisión final previa a publicación).
    test('adjuntar el MISMO path sobre una versión que ya lo tiene -> no es un reemplazo, nunca exige motivo', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'borrador');
        const { rows: [out] } = await db.query(
            `select registrar_envio_oficial_cartilla_delegado($1, null, '{}'::jsonb, 'enviada', $2, 'usuario_pagado', null) as resultado`,
            [cartilla.id, delegadoId]
        );
        const versionId = out.resultado.version_historica_id;
        await db.query("select adjuntar_pdf_version_cartilla_delegado($1, 'rodeos/cart/v1_123.pdf')", [versionId]);

        await expect(db.query(
            "select adjuntar_pdf_version_cartilla_delegado($1, 'rodeos/cart/v1_123.pdf')",
            [versionId]
        )).resolves.toBeDefined();
    });

    test('reemplazar un PDF YA existente por otro distinto, sin motivo -> MOTIVO_REQUERIDO_PARA_REEMPLAZO, nunca se aplica el cambio', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'borrador');
        const { rows: [out] } = await db.query(
            `select registrar_envio_oficial_cartilla_delegado($1, null, '{}'::jsonb, 'enviada', $2, 'usuario_pagado', null) as resultado`,
            [cartilla.id, delegadoId]
        );
        const versionId = out.resultado.version_historica_id;
        await db.query("select adjuntar_pdf_version_cartilla_delegado($1, 'rodeos/cart/v1_ORIGINAL.pdf')", [versionId]);

        await expect(db.query(
            "select adjuntar_pdf_version_cartilla_delegado($1, 'rodeos/cart/v1_NUEVO.pdf')",
            [versionId]
        )).rejects.toThrow(/MOTIVO_REQUERIDO_PARA_REEMPLAZO/);

        const { rows: [actual] } = await db.query('select storage_path_pdf from cartillas_delegado_versiones where id = $1', [versionId]);
        expect(actual.storage_path_pdf).toBe('rodeos/cart/v1_ORIGINAL.pdf'); // nunca se tocó
    });

    test('reemplazar un PDF YA existente con motivo y actor -> se aplica y queda auditado', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const adminId = await nuevoUsuarioPagado('delegado_rentado');
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'borrador');
        const { rows: [out] } = await db.query(
            `select registrar_envio_oficial_cartilla_delegado($1, null, '{}'::jsonb, 'enviada', $2, 'usuario_pagado', null) as resultado`,
            [cartilla.id, delegadoId]
        );
        const versionId = out.resultado.version_historica_id;
        await db.query("select adjuntar_pdf_version_cartilla_delegado($1, 'rodeos/cart/v1_ORIGINAL.pdf')", [versionId]);

        const { rows: [actualizada] } = await db.query(
            "select * from adjuntar_pdf_version_cartilla_delegado($1, 'rodeos/cart/v1_NUEVO.pdf', $2, 'administrador', 'El PDF original quedó corrupto')",
            [versionId, adminId]
        );
        expect(actualizada.storage_path_pdf).toBe('rodeos/cart/v1_NUEVO.pdf');

        const { rows: auditRows } = await db.query(
            "select * from auditoria where tabla='cartillas_delegado_versiones' and registro_id=$1 and accion='reemplazar_pdf_version'",
            [versionId]
        );
        expect(auditRows.length).toBe(1);
        expect(auditRows[0].actor_id).toBe(adminId);
        expect(auditRows[0].datos_anteriores.storage_path_pdf).toBe('rodeos/cart/v1_ORIGINAL.pdf');
        expect(auditRows[0].datos_nuevos.storage_path_pdf).toBe('rodeos/cart/v1_NUEVO.pdf');
    });

    test('reemplazar sin actor (aun con motivo) -> ACTOR_REQUERIDO_PARA_REEMPLAZO', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'borrador');
        const { rows: [out] } = await db.query(
            `select registrar_envio_oficial_cartilla_delegado($1, null, '{}'::jsonb, 'enviada', $2, 'usuario_pagado', null) as resultado`,
            [cartilla.id, delegadoId]
        );
        const versionId = out.resultado.version_historica_id;
        await db.query("select adjuntar_pdf_version_cartilla_delegado($1, 'rodeos/cart/v1_ORIGINAL.pdf')", [versionId]);

        await expect(db.query(
            "select adjuntar_pdf_version_cartilla_delegado($1, 'rodeos/cart/v1_NUEVO.pdf', null, 'administrador', 'motivo válido')",
            [versionId]
        )).rejects.toThrow(/ACTOR_REQUERIDO_PARA_REEMPLAZO/);
    });

    // Punto 7 de la tercera revisión final: la ruta en sí nunca puede ser
    // nula ni vacía, ni como adjunto inicial ni como intento de reemplazo.
    test('p_storage_path_pdf NULL -> STORAGE_PATH_PDF_REQUERIDO, nunca deja la versión "adjunta" sin archivo real', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'borrador');
        const { rows: [out] } = await db.query(
            `select registrar_envio_oficial_cartilla_delegado($1, null, '{}'::jsonb, 'enviada', $2, 'usuario_pagado', null) as resultado`,
            [cartilla.id, delegadoId]
        );
        const versionId = out.resultado.version_historica_id;

        await expect(db.query(
            "select adjuntar_pdf_version_cartilla_delegado($1, null)",
            [versionId]
        )).rejects.toThrow(/STORAGE_PATH_PDF_REQUERIDO/);

        const { rows: [actual] } = await db.query('select storage_path_pdf from cartillas_delegado_versiones where id = $1', [versionId]);
        expect(actual.storage_path_pdf).toBeNull();
    });

    test('p_storage_path_pdf vacío ("") -> STORAGE_PATH_PDF_REQUERIDO', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'borrador');
        const { rows: [out] } = await db.query(
            `select registrar_envio_oficial_cartilla_delegado($1, null, '{}'::jsonb, 'enviada', $2, 'usuario_pagado', null) as resultado`,
            [cartilla.id, delegadoId]
        );
        const versionId = out.resultado.version_historica_id;

        await expect(db.query(
            "select adjuntar_pdf_version_cartilla_delegado($1, '   ')",
            [versionId]
        )).rejects.toThrow(/STORAGE_PATH_PDF_REQUERIDO/);
    });
});

describe('Protección contra eliminación accidental del historial (ON DELETE RESTRICT, revisión final)', () => {
    test('intentar DELETE directo sobre una cartilla con versiones históricas falla (RESTRICT), nunca arrastra el historial', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'borrador');
        await db.query(
            `select registrar_envio_oficial_cartilla_delegado($1, null, '{}'::jsonb, 'enviada', $2, 'usuario_pagado', null)`,
            [cartilla.id, delegadoId]
        );

        await expect(db.query('delete from cartillas_delegado where id = $1', [cartilla.id]))
            .rejects.toThrow(/violates foreign key constraint|update or delete/i);

        expect((await versionesDeCartilla(cartilla.id)).length).toBe(1); // el historial sigue intacto
    });

    test('una cartilla SIN versiones históricas (nunca enviada) sí puede eliminarse — RESTRICT no bloquea de más', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'borrador');

        await expect(db.query('delete from cartillas_delegado where id = $1', [cartilla.id])).resolves.toBeDefined();
    });
});

describe('Transaccionalidad REAL — si la auditoría falla a mitad de camino, Postgres revierte TODO', () => {
    test('actor_tipo inválido en registrar_envio_oficial_cartilla_delegado revierte también el UPDATE de cartillas_delegado y el INSERT de la versión histórica', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'borrador');

        await expect(db.query(
            `select registrar_envio_oficial_cartilla_delegado($1, null, '{}'::jsonb, 'enviada', $2, 'actor_invalido', null)`,
            [cartilla.id, delegadoId]
        )).rejects.toThrow(/ACTOR_TIPO_INVALIDO/);

        const actual = await cartillaPorId(cartilla.id);
        expect(actual.estado).toBe('borrador'); // nunca quedó a medio camino
        expect((await versionesDeCartilla(cartilla.id)).length).toBe(0);
    });
});

describe('Seguridad — privilegios reales de BD (EXECUTE restringido a service_role)', () => {
    test('anon no puede ejecutar ninguna de las 4 funciones nuevas (incluida la interna de backfill)', async () => {
        await db.exec('SET ROLE anon');
        try {
            await expect(db.query("select reabrir_cartilla_delegado(gen_random_uuid(), 'x', gen_random_uuid(), 'administrador', null)"))
                .rejects.toThrow(/permission denied/i);
            await expect(db.query("select registrar_envio_oficial_cartilla_delegado(gen_random_uuid(), null, '{}'::jsonb, 'enviada', gen_random_uuid(), 'usuario_pagado', null)"))
                .rejects.toThrow(/permission denied/i);
            await expect(db.query("select adjuntar_pdf_version_cartilla_delegado(gen_random_uuid(), 'x')"))
                .rejects.toThrow(/permission denied/i);
            await expect(db.query("select backfill_version_inicial_cartilla_delegado(NULL::cartillas_delegado)"))
                .rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }
    });

    test('authenticated no puede ejecutar ninguna de las 4 funciones nuevas', async () => {
        await db.exec('SET ROLE authenticated');
        try {
            await expect(db.query("select reabrir_cartilla_delegado(gen_random_uuid(), 'x', gen_random_uuid(), 'administrador', null)"))
                .rejects.toThrow(/permission denied/i);
            await expect(db.query("select backfill_version_inicial_cartilla_delegado(NULL::cartillas_delegado)"))
                .rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }
    });

    test('service_role SÍ puede ejecutar las funciones (ya lo demuestran los tests funcionales de arriba, corridos sin SET ROLE)', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'enviada');
        await expect(db.query(
            "select reabrir_cartilla_delegado($1, 'motivo', $2, 'administrador', null)",
            [cartilla.id, delegadoId]
        )).resolves.toBeDefined();
    });
});

// ═════════════════════════════════════════════════════════════════════════
// REVISIÓN FINAL (previa a publicación) — puntos A, B y D del pedido.
// ═════════════════════════════════════════════════════════════════════════
describe('Punto A — Cartillas históricas (enviadas ANTES de esta migración, numero_version_actual=NULL)', () => {
    test('reabrir una cartilla "enviada" pre-092 reconstruye su v1 histórica con el contenido EXACTO original, antes de permitir cualquier corrección', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const adminId = await nuevoUsuarioPagado('delegado_rentado');
        // Simula una fila real pre-092: enviada por el flujo histórico,
        // numero_version_actual nunca se fijó (no existía la columna).
        const { rows: [cartilla] } = await db.query(
            `insert into cartillas_delegado (rodeo_id, delegado_id, estado, delegado_nombre, secretario_jurado, enviada_en, actualizado_por)
             values ($1, $2, 'enviada', 'Delegado Histórico', 'Secretario Original', '2025-05-10T10:00:00Z', $2) returning *`,
            [rodeoId, delegadoId]
        );
        expect(cartilla.numero_version_actual).toBeNull(); // confirma el escenario pre-092

        await db.query(
            "select reabrir_cartilla_delegado($1, 'Falta corregir el secretario', $2, 'administrador', null)",
            [cartilla.id, adminId]
        );

        const versiones = await versionesDeCartilla(cartilla.id);
        expect(versiones.length).toBe(1); // la v1 se reconstruyó, nunca se perdió
        expect(versiones[0].numero_version).toBe(1);
        expect(versiones[0].estado_version).toBe('enviada'); // reenviada_en era null
        expect(versiones[0].snapshot.secretario_jurado).toBe('Secretario Original'); // contenido EXACTO preservado
        expect(versiones[0].snapshot.delegado_nombre).toBe('Delegado Histórico');
        expect(new Date(versiones[0].enviada_en).toISOString()).toBe('2025-05-10T10:00:00.000Z'); // fecha original, no "ahora"
        expect(versiones[0].enviada_por).toBe(delegadoId); // autor reconstruido desde actualizado_por
        expect(versiones[0].enviada_por_tipo).toBe('usuario_pagado');
        expect(versiones[0].motivo_reapertura_previa).toBeNull(); // nunca hubo una reapertura antes de esta

        const actual = await cartillaPorId(cartilla.id);
        expect(actual.numero_version_actual).toBe(1); // el contador queda sincronizado

        // Ahora el delegado corrige y reenvía -> v2, sin tocar ni duplicar v1.
        await db.query('update cartillas_delegado set secretario_jurado = $1 where id = $2', ['Secretario Corregido', cartilla.id]);
        await db.query(
            `select registrar_envio_oficial_cartilla_delegado($1, null, '{}'::jsonb, 'reenviada', $2, 'usuario_pagado', null)`,
            [cartilla.id, delegadoId]
        );
        const versionesFinal = await versionesDeCartilla(cartilla.id);
        expect(versionesFinal.length).toBe(2);
        expect(versionesFinal[0].snapshot.secretario_jurado).toBe('Secretario Original'); // v1 intacta
        expect(versionesFinal[1].snapshot.secretario_jurado).toBe('Secretario Corregido'); // v2 nueva
    });

    test('reabrir una cartilla "aprobada" pre-092 con reenviada_en ya fijada -> la v1 reconstruida queda como "reenviada" (heurística documentada)', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const adminId = await nuevoUsuarioPagado('delegado_rentado');
        const { rows: [cartilla] } = await db.query(
            `insert into cartillas_delegado (rodeo_id, delegado_id, estado, delegado_nombre, enviada_en, reenviada_en, aprobada_en, aprobado_por)
             values ($1, $2, 'aprobada', 'Delegado Histórico', '2025-05-10T10:00:00Z', '2025-05-12T10:00:00Z', '2025-05-15T10:00:00Z', 'Admin Histórico') returning *`,
            [rodeoId, delegadoId]
        );

        await db.query(
            "select reabrir_cartilla_delegado($1, 'Corrección administrativa post-aprobación', $2, 'administrador', null)",
            [cartilla.id, adminId]
        );

        const versiones = await versionesDeCartilla(cartilla.id);
        expect(versiones[0].estado_version).toBe('reenviada'); // reenviada_en estaba fijada
        expect(new Date(versiones[0].enviada_en).toISOString()).toBe('2025-05-12T10:00:00.000Z'); // usa reenviada_en, no enviada_en
        expect(versiones[0].snapshot.aprobada_en).not.toBeNull(); // el snapshot conserva que SÍ fue aprobada
    });

    test('reabrir dos veces una cartilla pre-092 nunca duplica la v1 (segundo reabrir ocurre con numero_version_actual ya fijado)', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const adminId = await nuevoUsuarioPagado('delegado_rentado');
        const { rows: [cartilla] } = await db.query(
            `insert into cartillas_delegado (rodeo_id, delegado_id, estado, delegado_nombre, enviada_en)
             values ($1, $2, 'enviada', 'Delegado Histórico', '2025-05-10T10:00:00Z') returning *`,
            [rodeoId, delegadoId]
        );
        await db.query("select reabrir_cartilla_delegado($1, 'motivo 1', $2, 'administrador', null)", [cartilla.id, adminId]);
        // Reenvía y lo vuelven a reabrir (segunda reapertura real).
        await db.query(`select registrar_envio_oficial_cartilla_delegado($1, null, '{}'::jsonb, 'reenviada', $2, 'usuario_pagado', null)`, [cartilla.id, delegadoId]);
        await db.query("select reabrir_cartilla_delegado($1, 'motivo 2', $2, 'administrador', null)", [cartilla.id, adminId]);

        const versiones = await versionesDeCartilla(cartilla.id);
        expect(versiones.length).toBe(2); // v1 (backfill) + v2 (reenvío) — nunca 3 ni una v1 duplicada
        expect(versiones.map(v => v.numero_version)).toEqual([1, 2]);
    });
});

describe('Punto D — regresión: borrador intacto, aprobaciones anteriores quedan registradas, Nota Delegado nunca se toca al reabrir', () => {
    test('una cartilla en "borrador" rechazada por reabrir_cartilla_delegado queda BYTE-A-BYTE idéntica (ningún campo se modifica)', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'borrador');
        const antes = await cartillaPorId(cartilla.id);

        await expect(db.query(
            "select reabrir_cartilla_delegado($1, 'motivo', $2, 'administrador', null)",
            [cartilla.id, delegadoId]
        )).rejects.toThrow(/ESTADO_NO_REABRIBLE/);

        const despues = await cartillaPorId(cartilla.id);
        expect(despues).toEqual(antes); // ningún campo cambió, ni siquiera updated_at
        expect((await versionesDeCartilla(cartilla.id)).length).toBe(0);
    });

    test('aprobada_en/aprobado_por sobreviven intactos a un ciclo completo de reabrir + reenviar (la aprobación anterior queda registrada, nunca se borra)', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const adminId = await nuevoUsuarioPagado('delegado_rentado');
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'aprobada');
        await db.query(
            "update cartillas_delegado set aprobada_en = '2025-06-01T10:00:00Z', aprobado_por = 'Admin X' where id = $1",
            [cartilla.id]
        );

        await db.query("select reabrir_cartilla_delegado($1, 'motivo', $2, 'administrador', null)", [cartilla.id, adminId]);
        await db.query(`select registrar_envio_oficial_cartilla_delegado($1, null, '{}'::jsonb, 'reenviada', $2, 'usuario_pagado', null)`, [cartilla.id, delegadoId]);

        const actual = await cartillaPorId(cartilla.id);
        expect(new Date(actual.aprobada_en).toISOString()).toBe('2025-06-01T10:00:00.000Z'); // nunca se limpia
        expect(actual.aprobado_por).toBe('Admin X');

        // Y la versión histórica v1 (backfill) también conserva que estaba aprobada.
        const versiones = await versionesDeCartilla(cartilla.id);
        expect(versiones[0].snapshot.aprobada_en).not.toBeNull();
        expect(versiones[0].snapshot.aprobado_por).toBe('Admin X');
    });

    test('reabrir_cartilla_delegado NUNCA toca rodeo_notas_secundarias/Nota Delegado — la protección (088) solo se evalúa al reenviar, nunca al reabrir', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const adminId = await nuevoUsuarioPagado('delegado_rentado');
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'enviada');

        // Prueba estructural: el cuerpo SQL de reabrir_cartilla_delegado no
        // menciona en absoluto rodeo_notas_secundarias/nota_delegado (nunca
        // podría sincronizar/tocar la Nota Delegado aunque quisiera) — la
        // protección de la migración 088 solo aplica dentro de
        // sincronizar_nota_delegado_automatica, llamada EXCLUSIVAMENTE desde
        // los routers de "enviar" (JS), nunca desde "reabrir".
        const { rows: [def] } = await db.query(
            "select pg_get_functiondef(oid) as def from pg_proc where proname = 'reabrir_cartilla_delegado'"
        );
        expect(def.def).not.toMatch(/rodeo_notas_secundarias/i);
        expect(def.def).not.toMatch(/nota_delegado/i);

        // Y funcionalmente: reabrir no debe fallar ni alterar nada aunque no
        // exista ninguna fila de notas para este rodeo (no intenta leerlas).
        await expect(db.query(
            "select reabrir_cartilla_delegado($1, 'motivo', $2, 'administrador', null)",
            [cartilla.id, adminId]
        )).resolves.toBeDefined();
    });
});

// ═════════════════════════════════════════════════════════════════════════
// TERCERA REVISIÓN FINAL (previa a publicación) — hallazgo real: una
// cartilla pre-092 que pasa por "Observar" (NUNCA por reabrir_cartilla_
// delegado) también debe conservar su contenido original y numerar bien
// sus versiones al reenviarse. Ver la nota en registrar_envio_oficial_
// cartilla_delegado (migración 092) para el detalle de la corrección.
// ═════════════════════════════════════════════════════════════════════════
describe('Punto A extendido — camino por "Observar" (pre-092, sin pasar por reabrir_cartilla_delegado)', () => {
    test('cartilla pre-092 enviada -> observada (UPDATE directo, como hace hoy el endpoint admin) -> reenviada: reconstruye v1 con el contenido ORIGINAL y numera el reenvío como v2 (nunca v1)', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        // Simula una fila real pre-092 que ya fue observada por el admin
        // (estado='observada' llegó por un UPDATE directo del endpoint
        // /admin/cartillas-delegado/:id/observar, que nunca pasa por
        // reabrir_cartilla_delegado) — numero_version_actual nunca se fijó.
        const { rows: [cartilla] } = await db.query(
            `insert into cartillas_delegado (rodeo_id, delegado_id, estado, delegado_nombre, secretario_jurado, enviada_en, actualizado_por, observacion_admin)
             values ($1, $2, 'observada', 'Delegado Histórico', 'Secretario Original', '2025-05-10T10:00:00Z', $2, 'Falta corregir el secretario') returning *`,
            [rodeoId, delegadoId]
        );
        expect(cartilla.numero_version_actual).toBeNull(); // confirma el escenario pre-092

        // El delegado corrige y reenvía — mismo llamado que hace el router
        // real (usuario/cartilla-delegado.js) en POST /:id/enviar.
        const cambios = JSON.stringify({ secretario_jurado: 'Secretario Corregido' });
        const { rows: [out] } = await db.query(
            `select registrar_envio_oficial_cartilla_delegado($1, null, $2::jsonb, 'reenviada', $3, 'usuario_pagado', null) as resultado`,
            [cartilla.id, cambios, delegadoId]
        );
        expect(out.resultado.numero_version).toBe(2); // nunca "v1" — ya existía un envío real previo

        const versiones = await versionesDeCartilla(cartilla.id);
        expect(versiones.length).toBe(2); // v1 (backfill) + v2 (este reenvío) — nunca se perdió la original
        expect(versiones[0].numero_version).toBe(1);
        expect(versiones[0].estado_version).toBe('enviada');
        expect(versiones[0].snapshot.secretario_jurado).toBe('Secretario Original'); // contenido ORIGINAL preservado
        expect(versiones[1].numero_version).toBe(2);
        expect(versiones[1].estado_version).toBe('reenviada');
        expect(versiones[1].snapshot.secretario_jurado).toBe('Secretario Corregido'); // corrección de ESTE reenvío

        const actual = await cartillaPorId(cartilla.id);
        expect(actual.numero_version_actual).toBe(2);
        expect(actual.estado).toBe('reenviada');
    });

    test('un primer envío real desde "borrador" NUNCA dispara el backfill (no inventa una v1 falsa) — sigue siendo v1 la del propio envío', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'borrador');

        const { rows: [out] } = await db.query(
            `select registrar_envio_oficial_cartilla_delegado($1, null, '{}'::jsonb, 'enviada', $2, 'usuario_pagado', null) as resultado`,
            [cartilla.id, delegadoId]
        );
        expect(out.resultado.numero_version).toBe(1);

        const versiones = await versionesDeCartilla(cartilla.id);
        expect(versiones.length).toBe(1); // nunca 2 — no hay nada previo que backfillear
    });

    test('invocar la función interna de backfill dos veces sobre la misma cartilla nunca duplica la v1 (idempotencia)', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const { rows: [cartilla] } = await db.query(
            `insert into cartillas_delegado (rodeo_id, delegado_id, estado, delegado_nombre, enviada_en)
             values ($1, $2, 'enviada', 'Delegado Histórico', '2025-05-10T10:00:00Z') returning *`,
            [rodeoId, delegadoId]
        );

        await db.query('select backfill_version_inicial_cartilla_delegado(cd) from cartillas_delegado cd where cd.id = $1', [cartilla.id]);
        await db.query('select backfill_version_inicial_cartilla_delegado(cd) from cartillas_delegado cd where cd.id = $1', [cartilla.id]);

        const versiones = await versionesDeCartilla(cartilla.id);
        expect(versiones.length).toBe(1);
    });
});

describe('Inicialización histórica masiva (sección 2.6 de la migración 092) — backfill al aplicarse en producción', () => {
    // Re-ejecuta exactamente la misma sentencia que corre dentro de la
    // migración (sección 2.6) — en el momento en que la migración 092 se
    // aplicó dentro de beforeAll no existía ninguna cartilla todavía, así
    // que aquí se simula el escenario real: filas YA existentes en
    // producción, sin versión bajo este esquema, en distintos estados.
    const BACKFILL_MASIVO_SQL = `
        select backfill_version_inicial_cartilla_delegado(cd)
        from cartillas_delegado cd
        where cd.estado in ('enviada', 'reenviada', 'aprobada', 'cerrada')
          and cd.numero_version_actual is null
    `;

    test.each(['enviada', 'reenviada', 'aprobada', 'cerrada'])('backfillea v1 para una cartilla pre-092 en estado "%s"', async (estado) => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const { rows: [cartilla] } = await db.query(
            `insert into cartillas_delegado (rodeo_id, delegado_id, estado, delegado_nombre, enviada_en)
             values ($1, $2, $3, 'Delegado Histórico', '2025-05-10T10:00:00Z') returning *`,
            [rodeoId, delegadoId, estado]
        );

        await db.query(BACKFILL_MASIVO_SQL);

        const versiones = await versionesDeCartilla(cartilla.id);
        expect(versiones.length).toBe(1);
        expect(versiones[0].numero_version).toBe(1);

        // No modifica la fila "viva" — numero_version_actual queda tal cual
        // (NULL), consistente con que ningún camino de escritura real haya
        // vuelto a tocar esta cartilla todavía.
        const actual = await cartillaPorId(cartilla.id);
        expect(actual.numero_version_actual).toBeNull();
        expect(actual.estado).toBe(estado); // tampoco toca el estado
    });

    test('NUNCA backfillea una cartilla en estado "observada" (su contenido actual podría ya estar editado y no sería fiel a lo originalmente enviado)', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const { rows: [cartilla] } = await db.query(
            `insert into cartillas_delegado (rodeo_id, delegado_id, estado, delegado_nombre, enviada_en)
             values ($1, $2, 'observada', 'Delegado Histórico', '2025-05-10T10:00:00Z') returning *`,
            [rodeoId, delegadoId]
        );

        await db.query(BACKFILL_MASIVO_SQL);

        const versiones = await versionesDeCartilla(cartilla.id);
        expect(versiones.length).toBe(0); // deliberadamente NO inicializada

        const actual = await cartillaPorId(cartilla.id);
        expect(actual.numero_version_actual).toBeNull();
    });

    test('ejecutar la inicialización masiva dos veces nunca duplica versiones (idempotencia real sobre varias filas a la vez)', async () => {
        const delegadoId = await nuevoUsuarioPagado();
        const cartillaA = await nuevaCartillaRentado(await nuevoRodeo(), delegadoId, 'borrador');
        await db.query("update cartillas_delegado set estado = 'enviada', enviada_en = now() where id = $1", [cartillaA.id]);
        const cartillaB = await nuevaCartillaRentado(await nuevoRodeo(), delegadoId, 'borrador');
        await db.query("update cartillas_delegado set estado = 'cerrada', enviada_en = now() where id = $1", [cartillaB.id]);

        await db.query(BACKFILL_MASIVO_SQL);
        await db.query(BACKFILL_MASIVO_SQL); // segunda corrida — simula reaplicar la migración

        expect((await versionesDeCartilla(cartillaA.id)).length).toBe(1);
        expect((await versionesDeCartilla(cartillaB.id)).length).toBe(1);
    });

    test('una cartilla que YA tiene numero_version_actual fijado (post-092) nunca es tocada por la inicialización masiva', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartilla = await nuevaCartillaRentado(rodeoId, delegadoId, 'borrador');
        await db.query(
            `select registrar_envio_oficial_cartilla_delegado($1, null, '{}'::jsonb, 'enviada', $2, 'usuario_pagado', null)`,
            [cartilla.id, delegadoId]
        );
        expect((await versionesDeCartilla(cartilla.id)).length).toBe(1);

        await db.query(BACKFILL_MASIVO_SQL);

        expect((await versionesDeCartilla(cartilla.id)).length).toBe(1); // sin cambios
    });
});
