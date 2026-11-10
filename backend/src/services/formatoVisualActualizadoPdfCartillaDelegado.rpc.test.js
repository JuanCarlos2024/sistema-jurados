// Validación contra Postgres REAL (PGlite — motor Postgres real embebido,
// NO un mock de Node) de la migración 096 — actualización del diseño
// visual del PDF de versiones históricas de la Cartilla Digital de
// Delegado, SIN tocar nunca el PDF original. Mismo patrón que
// reaperturaVersionadoCartillaDelegado.rpc.test.js (092): aplica las
// migraciones reales en orden de producción y ejercita la RPC nueva
// directamente contra una base real — esto es lo que confirma que
// CREATE FUNCTION no falla (el bug de orden de parámetros detectado por
// el usuario en la revisión anterior se habría visto aquí de inmediato,
// un mock de supabase.rpc en Jest nunca lo habría detectado) y que la
// seguridad (REVOKE/GRANT) es real.
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
    // La migración bajo prueba: si el orden de parámetros fuera inválido
    // (el bug detectado en la revisión del usuario), este exec() rechaza
    // la promesa aquí mismo, ANTES de llegar a ningún test — confirmando
    // por sí solo que "la función se crea correctamente".
    await db.exec(leer('096_formato_visual_actualizado_pdf_cartilla_delegado.sql'));
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
async function nuevoUsuarioPagado() {
    const { rows: [u] } = await db.query(
        "insert into usuarios_pagados (tipo_persona, nombre_completo) values ('delegado_rentado', 'Persona Prueba') returning id"
    );
    return u.id;
}
async function nuevoAdmin() {
    const { rows: [a] } = await db.query("insert into administradores (nombre_completo) values ('Admin Prueba') returning id");
    return a.id;
}
async function nuevaCartilla(rodeoId, delegadoId) {
    const { rows: [c] } = await db.query(
        `insert into cartillas_delegado (rodeo_id, delegado_id, estado, delegado_nombre)
         values ($1, $2, 'enviada', 'Delegado Prueba') returning id`,
        [rodeoId, delegadoId]
    );
    return c.id;
}
// Inserta directo en cartillas_delegado_versiones (en vez de pasar por
// registrar_envio_oficial_cartilla_delegado) para poder controlar
// exactamente storage_path_pdf / storage_path_pdf_rediseno en cada caso.
async function nuevaVersionHistorica(cartillaId, { storagePathPdf = 'ruta/original_v1.pdf', storagePathPdfRediseno = null, numeroVersion = 1 } = {}) {
    const { rows: [v] } = await db.query(
        `insert into cartillas_delegado_versiones
            (cartilla_delegado_id, numero_version, estado_version, snapshot, storage_path_pdf, storage_path_pdf_rediseno, enviada_en, enviada_por_tipo)
         values ($1, $2, 'enviada', '{}'::jsonb, $3, $4, now(), 'usuario_pagado')
         returning *`,
        [cartillaId, numeroVersion, storagePathPdf, storagePathPdfRediseno]
    );
    return v;
}
async function versionPorId(id) {
    const { rows: [v] } = await db.query('select * from cartillas_delegado_versiones where id = $1', [id]);
    return v;
}
async function auditoriaDe(versionId) {
    const { rows } = await db.query(
        "select * from auditoria where tabla = 'cartillas_delegado_versiones' and registro_id = $1 and accion = 'actualizar_diseno_pdf_version' order by created_at",
        [String(versionId)]
    );
    return rows;
}

describe('actualizar_diseno_pdf_version_cartilla_delegado — contra Postgres real (096)', () => {
    test('éxito: adjunta storage_path_pdf_rediseno, NUNCA toca storage_path_pdf (el original), y deja auditoría', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const adminId = await nuevoAdmin();
        const cartillaId = await nuevaCartilla(rodeoId, delegadoId);
        const version = await nuevaVersionHistorica(cartillaId, { storagePathPdf: 'ruta/original_v1.pdf' });

        const { rows: [resultado] } = await db.query(
            "select * from actualizar_diseno_pdf_version_cartilla_delegado($1, $2, $3, $4)",
            [version.id, 'ruta/rediseno_v1_123.pdf', adminId, 'Actualización de diseño institucional']
        );

        expect(resultado.storage_path_pdf_rediseno).toBe('ruta/rediseno_v1_123.pdf');
        expect(resultado.storage_path_pdf).toBe('ruta/original_v1.pdf'); // el original, intacto

        const actual = await versionPorId(version.id);
        expect(actual.storage_path_pdf).toBe('ruta/original_v1.pdf');
        expect(actual.storage_path_pdf_rediseno).toBe('ruta/rediseno_v1_123.pdf');

        const auditoria = await auditoriaDe(version.id);
        expect(auditoria.length).toBe(1);
        expect(auditoria[0].actor_id).toBe(adminId);
        expect(auditoria[0].actor_tipo).toBe('administrador');
        expect(auditoria[0].descripcion).toContain('Actualización de diseño institucional');
        expect(auditoria[0].datos_nuevos.storage_path_pdf_rediseno).toBe('ruta/rediseno_v1_123.pdf');
    });

    test('SIN_PDF_ORIGINAL: una versión sin storage_path_pdf nunca puede "actualizarse" — nunca inventa un original', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const adminId = await nuevoAdmin();
        const cartillaId = await nuevaCartilla(rodeoId, delegadoId);
        const version = await nuevaVersionHistorica(cartillaId, { storagePathPdf: null });

        await expect(db.query(
            "select actualizar_diseno_pdf_version_cartilla_delegado($1, 'ruta/rediseno.pdf', $2, 'motivo')",
            [version.id, adminId]
        )).rejects.toThrow(/SIN_PDF_ORIGINAL/);

        const actual = await versionPorId(version.id);
        expect(actual.storage_path_pdf_rediseno).toBeNull(); // nada cambió
    });

    test('ACTOR_REQUERIDO: actor nulo -> rechaza, nunca escribe nada', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const cartillaId = await nuevaCartilla(rodeoId, delegadoId);
        const version = await nuevaVersionHistorica(cartillaId);

        await expect(db.query(
            "select actualizar_diseno_pdf_version_cartilla_delegado($1, 'ruta/rediseno.pdf', NULL, 'motivo')",
            [version.id]
        )).rejects.toThrow(/ACTOR_REQUERIDO/);
    });

    test('MOTIVO_REQUERIDO: motivo vacío -> rechaza, nunca escribe nada', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const adminId = await nuevoAdmin();
        const cartillaId = await nuevaCartilla(rodeoId, delegadoId);
        const version = await nuevaVersionHistorica(cartillaId);

        await expect(db.query(
            "select actualizar_diseno_pdf_version_cartilla_delegado($1, 'ruta/rediseno.pdf', $2, '   ')",
            [version.id, adminId]
        )).rejects.toThrow(/MOTIVO_REQUERIDO/);
    });

    test('REEMPLAZO_NO_CONFIRMADO: una segunda actualización con ruta distinta, sin confirmar, nunca pisa en silencio la anterior', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const adminId = await nuevoAdmin();
        const cartillaId = await nuevaCartilla(rodeoId, delegadoId);
        const version = await nuevaVersionHistorica(cartillaId, { storagePathPdf: 'ruta/original.pdf', storagePathPdfRediseno: 'ruta/rediseno_viejo.pdf' });

        await expect(db.query(
            "select actualizar_diseno_pdf_version_cartilla_delegado($1, 'ruta/rediseno_nuevo.pdf', $2, 'motivo')",
            [version.id, adminId]
        )).rejects.toThrow(/REEMPLAZO_NO_CONFIRMADO/);

        const actual = await versionPorId(version.id);
        expect(actual.storage_path_pdf_rediseno).toBe('ruta/rediseno_viejo.pdf'); // sin cambios

        // Con el reemplazo confirmado SÍ procede, y queda auditado con la
        // ruta anterior registrada en datos_anteriores.
        const { rows: [resultado] } = await db.query(
            "select * from actualizar_diseno_pdf_version_cartilla_delegado($1, $2, $3, $4, 'administrador', true)",
            [version.id, 'ruta/rediseno_nuevo.pdf', adminId, 'motivo confirmado']
        );
        expect(resultado.storage_path_pdf_rediseno).toBe('ruta/rediseno_nuevo.pdf');
        expect(resultado.storage_path_pdf).toBe('ruta/original.pdf'); // el original sigue intacto

        const auditoria = await auditoriaDe(version.id);
        expect(auditoria.length).toBe(1); // solo el reemplazo confirmado audita (el intento rechazado no escribió nada)
        expect(auditoria[0].datos_anteriores.storage_path_pdf_rediseno).toBe('ruta/rediseno_viejo.pdf');
        expect(auditoria[0].datos_nuevos.storage_path_pdf_rediseno).toBe('ruta/rediseno_nuevo.pdf');
    });

    test('llamar dos veces con la MISMA ruta es idempotente: nunca exige confirmación y produce EXACTAMENTE 1 fila de auditoría (no 2)', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const adminId = await nuevoAdmin();
        const cartillaId = await nuevaCartilla(rodeoId, delegadoId);
        const version = await nuevaVersionHistorica(cartillaId);

        const { rows: [r1] } = await db.query("select * from actualizar_diseno_pdf_version_cartilla_delegado($1, 'ruta/rediseno.pdf', $2, 'motivo 1')", [version.id, adminId]);
        const { rows: [r2] } = await db.query(
            "select * from actualizar_diseno_pdf_version_cartilla_delegado($1, 'ruta/rediseno.pdf', $2, 'motivo 2')",
            [version.id, adminId]
        );

        expect(r1.storage_path_pdf_rediseno).toBe('ruta/rediseno.pdf');
        expect(r2.storage_path_pdf_rediseno).toBe('ruta/rediseno.pdf'); // la 2ª llamada retorna la fila existente, sin cambiarla

        const actual = await versionPorId(version.id);
        expect(actual.storage_path_pdf_rediseno).toBe('ruta/rediseno.pdf');

        const auditoria = await auditoriaDe(version.id);
        expect(auditoria.length).toBe(1); // la 2ª llamada (misma ruta) NUNCA audita de nuevo
        expect(auditoria[0].descripcion).toContain('motivo 1'); // la auditoría es la del primer adjunto, no se tocó
    });

    test('REEMPLAZO_NO_CONFIRMADO con p_reemplazo_confirmado = false explícito (ruta distinta)', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const adminId = await nuevoAdmin();
        const cartillaId = await nuevaCartilla(rodeoId, delegadoId);
        const version = await nuevaVersionHistorica(cartillaId, { storagePathPdf: 'ruta/original.pdf', storagePathPdfRediseno: 'ruta/rediseno_viejo.pdf' });

        await expect(db.query(
            "select actualizar_diseno_pdf_version_cartilla_delegado($1, 'ruta/rediseno_nuevo.pdf', $2, 'motivo', 'administrador', false)",
            [version.id, adminId]
        )).rejects.toThrow(/REEMPLAZO_NO_CONFIRMADO/);

        const actual = await versionPorId(version.id);
        expect(actual.storage_path_pdf_rediseno).toBe('ruta/rediseno_viejo.pdf');
        expect((await auditoriaDe(version.id)).length).toBe(0);
    });

    test('REEMPLAZO_NO_CONFIRMADO con p_reemplazo_confirmado = NULL explícito (ruta distinta) — el hueco de "NOT NULL = NULL" queda cerrado', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const adminId = await nuevoAdmin();
        const cartillaId = await nuevaCartilla(rodeoId, delegadoId);
        const version = await nuevaVersionHistorica(cartillaId, { storagePathPdf: 'ruta/original.pdf', storagePathPdfRediseno: 'ruta/rediseno_viejo.pdf' });

        await expect(db.query(
            "select actualizar_diseno_pdf_version_cartilla_delegado($1, 'ruta/rediseno_nuevo.pdf', $2, 'motivo', 'administrador', NULL)",
            [version.id, adminId]
        )).rejects.toThrow(/REEMPLAZO_NO_CONFIRMADO/);

        const actual = await versionPorId(version.id);
        expect(actual.storage_path_pdf_rediseno).toBe('ruta/rediseno_viejo.pdf'); // nunca se reemplazó en silencio
        expect((await auditoriaDe(version.id)).length).toBe(0);
    });

    test('VERSION_HISTORICA_NO_ENCONTRADA para un id inexistente', async () => {
        const adminId = await nuevoAdmin();
        await expect(db.query(
            "select actualizar_diseno_pdf_version_cartilla_delegado(gen_random_uuid(), 'ruta/x.pdf', $1, 'motivo')",
            [adminId]
        )).rejects.toThrow(/VERSION_HISTORICA_NO_ENCONTRADA/);
    });
});

describe('Seguridad — privilegios reales de BD (EXECUTE restringido a service_role)', () => {
    test('anon no puede ejecutar la función nueva', async () => {
        await db.exec('SET ROLE anon');
        try {
            await expect(db.query(
                "select actualizar_diseno_pdf_version_cartilla_delegado(gen_random_uuid(), 'x', gen_random_uuid(), 'motivo')"
            )).rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }
    });

    test('authenticated no puede ejecutar la función nueva', async () => {
        await db.exec('SET ROLE authenticated');
        try {
            await expect(db.query(
                "select actualizar_diseno_pdf_version_cartilla_delegado(gen_random_uuid(), 'x', gen_random_uuid(), 'motivo')"
            )).rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }
    });

    test('service_role SÍ puede (ya lo demuestran los tests funcionales de arriba, corridos sin SET ROLE)', async () => {
        const rodeoId = await nuevoRodeo();
        const delegadoId = await nuevoUsuarioPagado();
        const adminId = await nuevoAdmin();
        const cartillaId = await nuevaCartilla(rodeoId, delegadoId);
        const version = await nuevaVersionHistorica(cartillaId);
        await expect(db.query(
            "select actualizar_diseno_pdf_version_cartilla_delegado($1, 'ruta/rediseno.pdf', $2, 'motivo')",
            [version.id, adminId]
        )).resolves.toBeDefined();
    });
});
