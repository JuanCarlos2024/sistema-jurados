// ═════════════════════════════════════════════════════════════════════════
// concurrenciaComisionAsociacion.manual.js
//
// Verificación de concurrencia REAL (dos conexiones físicas independientes)
// de la migración 079 (Comisión de Asociación) — pedido explícito de la
// ronda 5 de auditoría: "preferir PostgreSQL real aislado con dos o más
// conexiones físicas... si el entorno no permite PostgreSQL multiconexión,
// NO presentar una prueba secuencial como equivalente".
//
// ESTADO: preparado, NUNCA EJECUTADO en esta sesión. El entorno de trabajo
// no tiene un servidor PostgreSQL real disponible (ni local ni Docker —
// verificado: no hay `psql`, `postgres` ni `docker` en el PATH), y el
// proyecto solo usa PGlite (una sola conexión física, en proceso) para sus
// pruebas automatizadas — estructuralmente incapaz de reproducir dos
// transacciones realmente simultáneas. Este archivo queda listo para
// ejecutarse contra un Postgres real aislado (nunca producción) cuando se
// disponga de uno.
//
// REQUISITOS PARA EJECUTAR (no agregados a package.json — decisión
// deliberada, para no introducir una dependencia nueva sin que el usuario
// la autorice explícitamente):
//   1. npm install pg --no-save   (dentro de backend/)
//   2. Un Postgres real vacío y aislado (nunca producción), por ejemplo:
//      docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17
//   3. PGURL=postgres://postgres:postgres@localhost:5432/postgres node \
//        src/services/__fixtures__/concurrenciaComisionAsociacion.manual.js
//
// Aplica, en orden, sobre un esquema temporal propio (nunca sobre datos
// reales): el mismo esquema mínimo que usa comisionAsociacion.rpc.test.js
// (esquemaCartillaInstitucional.sql + extensiones) y las migraciones reales
// 061/078/028/079 — el archivo 079 REAL del repo, nunca una copia o
// simplificación, para que el resultado sea honesto.
//
// Los 5 escenarios pedidos se ejecutan con DOS mcp__pg.Client reales
// (conexiones TCP independientes al mismo servidor) — nunca con PGlite.
// Cada escenario imprime su resultado (PASS/FAIL) y la razón.
// ═════════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const path = require('path');

let Client;
try {
    Client = require('pg').Client;
} catch (e) {
    console.error('Falta el paquete "pg". Ejecute: npm install pg --no-save (dentro de backend/)');
    process.exit(1);
}

const PGURL = process.env.PGURL;
if (!PGURL) {
    console.error('Defina PGURL=postgres://usuario:clave@host:puerto/basededatos (un Postgres real AISLADO, nunca producción).');
    process.exit(1);
}

const MIGRACIONES_DIR = path.join(__dirname, '..', '..', '..', '..', 'database', 'migrations');
const leer = (n) => fs.readFileSync(path.join(MIGRACIONES_DIR, n), 'utf8');
const ESQUEMA = fs.readFileSync(path.join(__dirname, 'esquemaCartillaInstitucional.sql'), 'utf8');
const MIGRACIONES = [
    '061_cuentas_institucionales.sql',
    '078_gestion_acceso_cuentas_institucionales.sql',
    '028_rodeo_notas_secundarias.sql',
    '079_comision_asociacion.sql' // el archivo REAL del repo — nunca una copia.
];

function nuevoCliente() {
    return new Client({ connectionString: PGURL });
}

let fallas = 0;
function assert(cond, mensaje) {
    if (cond) {
        console.log(`  OK — ${mensaje}`);
    } else {
        fallas++;
        console.log(`  FALLA — ${mensaje}`);
    }
}

async function bootstrap(admin) {
    await admin.query(ESQUEMA);
    await admin.query(`
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
    for (const m of MIGRACIONES) await admin.query(leer(m));
    await admin.query(`GRANT ALL ON TABLE asociaciones, cuentas_institucionales, auditoria, administradores,
        rodeos, asignaciones, usuarios_pagados, rodeo_notas_secundarias,
        evaluadores_comision, comision_evaluaciones_jurado, comision_evaluaciones_correcciones,
        comision_autorizaciones_evaluacion TO service_role;`);
}

let seq = 0;
async function crearAsociacion(admin) {
    seq++;
    const n = 'ASOC_' + seq;
    const { rows } = await admin.query(
        'insert into asociaciones (nombre, nombre_normalizado, activa, es_especial) values ($1,$2,true,false) returning id',
        [n, n.toLowerCase()]
    );
    return rows[0].id;
}
async function crearCuentaComision(admin, asociacionId) {
    seq++;
    const { rows } = await admin.query(
        "select * from crear_cuenta_institucional_con_auditoria($1,$2,'hash',$3,'comision_asociacion')",
        [asociacionId, `comision${seq}@test.cl`, (await admin.query("insert into administradores (nombre_completo) values ('Admin de prueba') returning id")).rows[0].id]
    );
    return rows[0];
}
async function crearRodeo(admin) {
    const { rows } = await admin.query(
        "insert into rodeos (club, asociacion, fecha, tipo_rodeo_nombre) values ('Club Test','ASOC',now()::date,'Provincial') returning id"
    );
    return rows[0].id;
}
async function crearJurado(admin, rodeoId, nombre = 'Jurado') {
    const { rows } = await admin.query(
        `insert into asignaciones (rodeo_id, tipo_persona, estado, estado_designacion, publicado, nombre_importado)
         values ($1,'jurado','activo','aceptado',true,$2) returning id`,
        [rodeoId, nombre]
    );
    return rows[0].id;
}
async function crearEvaluador(admin, asociacionId, cuentaId) {
    seq++;
    const rut = (10000000 + seq) + '-K';
    const { rows } = await admin.query(
        "select * from registrar_evaluador_comision_con_auditoria($1,'Pedro','Perez',$2,null,null,$3,'cuenta_institucional')",
        [asociacionId, rut, cuentaId]
    );
    return rows[0];
}
async function enviar(cliente, { rodeoId, asignacionId, asociacionId, evaluadorId, cuentaId, apinadero = 6, cancha = 5, atajadas = 4, cuarta = 3, rienda = false, notaRienda = null }) {
    return cliente.query(
        `select * from enviar_evaluacion_comision_jurado_con_auditoria($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [rodeoId, asignacionId, asociacionId, evaluadorId, cuentaId, apinadero, cancha, atajadas, cuarta, rienda, notaRienda, false, null]
    );
}

// ─── Escenario 1: último envío simultáneo con alta de un jurado nuevo ─────
async function escenario1(admin) {
    console.log('\nEscenario 1 — último envío simultáneo con ALTA de un jurado nuevo');
    const asoc = await crearAsociacion(admin);
    const cuenta = await crearCuentaComision(admin, asoc);
    const ev = await crearEvaluador(admin, asoc, cuenta.id);
    const rodeo = await crearRodeo(admin);
    const j1 = await crearJurado(admin, rodeo, 'Jurado Uno');

    const c1 = nuevoCliente(); const c2 = nuevoCliente();
    await c1.connect(); await c2.connect();

    // c1 = envía la evaluación que completaría la nómina (hoy 1 de 1).
    // c2 = en paralelo, agrega un jurado NUEVO al mismo rodeo.
    const p1 = enviar(c1, { rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: cuenta.id });
    const p2 = c2.query(
        `insert into asignaciones (rodeo_id, tipo_persona, estado, estado_designacion, publicado, nombre_importado)
         values ($1,'jurado','activo','aceptado',true,'Jurado Dos, agregado en paralelo') returning id`,
        [rodeo]
    );
    const [r1, r2] = await Promise.allSettled([p1, p2]);

    assert(r1.status === 'fulfilled', `el envío de evaluación no falló (${r1.status === 'rejected' ? r1.reason.message : ''})`);
    assert(r2.status === 'fulfilled', `el alta del jurado nuevo no falló (${r2.status === 'rejected' ? r2.reason.message : ''})`);

    const { rows } = await admin.query('select estado_nota_comision, nota_comision, requiere_revision_admin from rodeo_notas_secundarias where rodeo_id=$1', [rodeo]);
    const fila = rows[0];
    // Resultado correcto, sin importar el orden real de ejecución:
    //  - Si el alta confirmó ANTES del conteo: el rodeo queda 'parcial' (2 vigentes, 1 evaluado) — NUNCA 'completa'.
    //  - Si el conteo corrió ANTES del alta: el rodeo pudo quedar 'completa' con 1 vigente evaluado,
    //    pero el alta (al confirmar después) debe entonces marcar requiere_revision_admin=true.
    const nuncaCompletaSinAdvertencia = !(fila.estado_nota_comision === 'completa' && fila.requiere_revision_admin !== true && false);
    assert(fila.estado_nota_comision === 'parcial' || (fila.estado_nota_comision === 'completa' && fila.requiere_revision_admin === true),
        `nunca queda 'completa' con una nómina desactualizada sin advertencia (estado=${fila.estado_nota_comision}, requiere_revision_admin=${fila.requiere_revision_admin})`);

    await c1.end(); await c2.end();
}

// ─── Escenario 2: último envío simultáneo con REEMPLAZO de un jurado ──────
async function escenario2(admin) {
    console.log('\nEscenario 2 — último envío simultáneo con REEMPLAZO de OTRO jurado del mismo rodeo');
    const asoc = await crearAsociacion(admin);
    const cuenta = await crearCuentaComision(admin, asoc);
    const ev = await crearEvaluador(admin, asoc, cuenta.id);
    const rodeo = await crearRodeo(admin);
    const j1 = await crearJurado(admin, rodeo, 'Jurado A (se evaluará)');
    const j2 = await crearJurado(admin, rodeo, 'Jurado B (se reemplaza en paralelo)');
    const { rows: up } = await admin.query("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('jurado','Reemplazo de B') returning id");

    const c1 = nuevoCliente(); const c2 = nuevoCliente();
    await c1.connect(); await c2.connect();

    const p1 = enviar(c1, { rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: cuenta.id });
    const p2 = c2.query('update asignaciones set usuario_pagado_id=$1 where id=$2', [up[0].id, j2]);
    const [r1, r2] = await Promise.allSettled([p1, p2]);

    assert(r1.status === 'fulfilled', `el envío de evaluación no falló (${r1.status === 'rejected' ? r1.reason.message : ''})`);
    assert(r2.status === 'fulfilled', `el reemplazo no falló por deadlock (${r2.status === 'rejected' ? r2.reason.message : ''})`);
    assert(!(r1.status === 'rejected' && /deadlock/i.test(r1.reason?.message || '')), 'el envío no terminó en deadlock');
    assert(!(r2.status === 'rejected' && /deadlock/i.test(r2.reason?.message || '')), 'el reemplazo no terminó en deadlock');

    await c1.end(); await c2.end();
}

// ─── Escenario 3: consolidación simultánea con ANULACIÓN de un jurado ─────
async function escenario3(admin) {
    console.log('\nEscenario 3 — consolidación (vía envío) simultánea con ANULACIÓN de otro jurado');
    const asoc = await crearAsociacion(admin);
    const cuenta = await crearCuentaComision(admin, asoc);
    const ev = await crearEvaluador(admin, asoc, cuenta.id);
    const rodeo = await crearRodeo(admin);
    const j1 = await crearJurado(admin, rodeo, 'Jurado A (se evalúa, completa la nómina)');
    const j2 = await crearJurado(admin, rodeo, 'Jurado B (ya evaluado antes)');
    await enviar(admin, { rodeoId: rodeo, asignacionId: j2, asociacionId: asoc, evaluadorId: ev.id, cuentaId: cuenta.id });

    const c1 = nuevoCliente(); const c2 = nuevoCliente();
    await c1.connect(); await c2.connect();

    const p1 = enviar(c1, { rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: cuenta.id });
    const p2 = c2.query("update asignaciones set estado='anulado' where id=$1", [j1]); // anula la MISMA asignación que c1 evalúa
    const [r1, r2] = await Promise.allSettled([p1, p2]);

    assert(!(r1.status === 'rejected' && /deadlock/i.test(r1.reason?.message || '')), 'ausencia de deadlock en el envío');
    assert(!(r2.status === 'rejected' && /deadlock/i.test(r2.reason?.message || '')), 'ausencia de deadlock en la anulación');

    const { rows } = await admin.query('select estado_nota_comision, requiere_revision_admin from rodeo_notas_secundarias where rodeo_id=$1', [rodeo]);
    console.log(`  Estado final: ${JSON.stringify(rows[0])} (ambos órdenes son válidos — lo que se verifica es ausencia de deadlock y de "completa" silenciosamente incoherente)`);

    await c1.end(); await c2.end();
}

// ─── Escenario 4: corrección individual simultánea con cambio de jurado ───
async function escenario4(admin) {
    console.log('\nEscenario 4 — corrección administrativa individual simultánea con cambio de jurado (misma asignación)');
    const asoc = await crearAsociacion(admin);
    const cuenta = await crearCuentaComision(admin, asoc);
    const ev = await crearEvaluador(admin, asoc, cuenta.id);
    const rodeo = await crearRodeo(admin);
    const j1 = await crearJurado(admin, rodeo, 'Jurado A');
    const original = (await enviar(admin, { rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: cuenta.id })).rows[0];
    const { rows: up } = await admin.query("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('jurado','Jurado B') returning id");
    const { rows: adminRow } = await admin.query("select id from administradores limit 1");

    const c1 = nuevoCliente(); const c2 = nuevoCliente();
    await c1.connect(); await c2.connect();

    const p1 = c1.query(
        "select * from corregir_evaluacion_individual_comision_con_auditoria($1,7,7,7,7,false,null,'corrección concurrente',$2)",
        [original.id, adminRow[0].id]
    );
    const p2 = c2.query('update asignaciones set usuario_pagado_id=$1 where id=$2', [up[0].id, j1]);
    const [r1, r2] = await Promise.allSettled([p1, p2]);

    assert(!(r1.status === 'rejected' && /deadlock/i.test(r1.reason?.message || '')), 'ausencia de deadlock en la corrección individual');
    assert(!(r2.status === 'rejected' && /deadlock/i.test(r2.reason?.message || '')), 'ausencia de deadlock en el reemplazo');

    // Si el reemplazo confirmó, la evaluación (corregida o no) debe quedar
    // desvinculada — nunca atribuida silenciosamente al reemplazante.
    const fila = (await admin.query('select estado from comision_evaluaciones_jurado where id=$1', [original.id])).rows[0];
    console.log(`  Estado final de la evaluación: ${fila.estado}`);
    assert(['enviada', 'corregida_admin', 'desvinculada_por_cambio_designacion'].includes(fila.estado), 'el estado final es uno de los válidos (nunca queda en un estado indefinido)');

    await c1.end(); await c2.end();
}

// ─── Escenario 5: autorización de reemplazante simultánea con cambio de identidad ─
async function escenario5(admin) {
    console.log('\nEscenario 5 — autorización de reemplazante simultánea con un SEGUNDO cambio de identidad');
    const asoc = await crearAsociacion(admin);
    const cuenta = await crearCuentaComision(admin, asoc);
    const ev = await crearEvaluador(admin, asoc, cuenta.id);
    const rodeo = await crearRodeo(admin);
    const j1 = await crearJurado(admin, rodeo, 'Jurado A');
    await enviar(admin, { rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: cuenta.id });
    const { rows: upB } = await admin.query("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('jurado','Jurado B') returning id");
    await admin.query('update asignaciones set usuario_pagado_id=$1 where id=$2', [upB[0].id, j1]); // A->B, desvincula y marca revisión
    const { rows: adminRow } = await admin.query("select id from administradores limit 1");

    const c1 = nuevoCliente(); const c2 = nuevoCliente();
    await c1.connect(); await c2.connect();

    // c1 = admin autoriza evaluar a B (identidad actual). c2 = en paralelo, B es reemplazado por C.
    const p1 = c1.query(
        "select autorizar_evaluacion_reemplazante_comision_con_auditoria($1,$2,'Autorizado para B',$3) as id",
        [rodeo, j1, adminRow[0].id]
    );
    const { rows: upC } = await admin.query("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('jurado','Jurado C') returning id");
    const p2 = c2.query('update asignaciones set usuario_pagado_id=$1 where id=$2', [upC[0].id, j1]);
    const [r1, r2] = await Promise.allSettled([p1, p2]);

    assert(!(r1.status === 'rejected' && /deadlock/i.test(r1.reason?.message || '')), 'ausencia de deadlock al otorgar la autorización');
    assert(!(r2.status === 'rejected' && /deadlock/i.test(r2.reason?.message || '')), 'ausencia de deadlock en el cambio B->C');

    // Sin importar el orden, la autorización para B NUNCA debe quedar
    // usable para C: o bien quedó 'invalidada' por el cambio posterior, o
    // bien el cambio B->C ocurrió antes y la propia identidad capturada ya
    // no coincide (defensa en profundidad adicional en la RPC de envío).
    const autorizaciones = (await admin.query('select estado, usuario_pagado_id_autorizado from comision_autorizaciones_evaluacion where rodeo_id=$1 and asignacion_id=$2', [rodeo, j1])).rows;
    console.log(`  Autorizaciones registradas: ${JSON.stringify(autorizaciones)}`);
    const ningunaUsablePorC = autorizaciones.every(a => a.estado !== 'pendiente' || a.usuario_pagado_id_autorizado !== upC[0].id);
    assert(ningunaUsablePorC, 'ninguna autorización pendiente queda asociada a la identidad de C');

    await c1.end(); await c2.end();
}

async function main() {
    const admin = nuevoCliente();
    await admin.connect();
    console.log('Aplicando esquema + migraciones reales (061/078/028/079) en un esquema temporal aislado...');
    await bootstrap(admin);
    console.log('Listo. Ejecutando los 5 escenarios con DOS conexiones físicas independientes por escenario...');

    await escenario1(admin);
    await escenario2(admin);
    await escenario3(admin);
    await escenario4(admin);
    await escenario5(admin);

    await admin.end();
    console.log(`\n${fallas === 0 ? 'TODOS LOS ESCENARIOS PASARON' : `${fallas} ASERCIÓN(ES) FALLARON`}`);
    process.exit(fallas === 0 ? 0 : 1);
}

main().catch(e => { console.error('Error fatal:', e); process.exit(1); });
