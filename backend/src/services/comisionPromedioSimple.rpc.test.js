// Comisión de Asociación (migración 082) — promedio simple. Verificación
// contra Postgres REAL (PGlite), no mocks. Cubre exactamente los CASO 2-10
// del pedido: fn_calcular_nota_individual_comision ya NO pondera por
// criterio (20/30/40/10 o 16/24/32/8/20) — todos los criterios puntuables
// pesan lo mismo (promedio simple, calculado dinámicamente según la
// cantidad de criterios aplicables: 4 sin Rienda, 5 con Rienda).
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
    '082_comision_promedio_simple.sql'
];

let db;
let ADMIN_ID;
beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);
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
async function crearAsociacion() {
    seq++;
    const n = 'ASOC_PS_' + seq;
    const { rows } = await db.query(
        'insert into asociaciones (nombre, nombre_normalizado, activa, es_especial) values ($1,$2,true,false) returning id',
        [n, n.toLowerCase()]
    );
    return rows[0].id;
}
function emailUnico() { seq++; return `cuenta-ps${seq}@ferochi.cl`; }
async function crearCuenta(asociacionId) {
    const { rows } = await db.query(
        'select * from crear_cuenta_institucional_con_auditoria($1,$2,$3,$4,$5)',
        [asociacionId, emailUnico(), 'hash-fijo', ADMIN_ID, 'comision_asociacion']
    );
    return rows[0];
}
async function crearRodeo() {
    const { rows } = await db.query(
        "insert into rodeos (club, asociacion, fecha, tipo_rodeo_nombre) values ('Club PS','ASOC',now()::date,'Provincial') returning id"
    );
    return rows[0].id;
}
async function crearJurado(rodeoId, nombre = 'Jurado Promedio Simple') {
    const { rows } = await db.query(
        `insert into asignaciones (rodeo_id, tipo_persona, estado, estado_designacion, publicado, nombre_importado)
         values ($1,'jurado','activo','aceptado',true,$2) returning id`,
        [rodeoId, nombre]
    );
    return rows[0].id;
}
async function crearEvaluador(asociacionId) {
    seq++;
    const rut = (30000000 + seq) + '-K';
    const { rows } = await db.query(
        'select * from registrar_evaluador_comision_con_auditoria($1,$2,$3,$4,$5,$6,$7,$8)',
        [asociacionId, 'Eval', 'Uador', rut, null, null, ADMIN_ID, 'administrador']
    );
    return rows[0];
}
async function enviarEvaluacion(opts) {
    const { rows } = await db.query(
        `select * from enviar_evaluacion_comision_jurado_con_auditoria($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [opts.rodeoId, opts.asignacionId, opts.asociacionId, opts.evaluadorId, opts.cuentaId,
         opts.apinadero, opts.cancha, opts.atajadas, opts.cuarta,
         opts.huboRienda ?? false, opts.rienda ?? null, opts.afecto ?? false, opts.comentario ?? null]
    );
    return rows[0];
}
async function fnDirecta(apinadero, cancha, atajadas, cuarta, huboRienda, rienda) {
    const { rows } = await db.query(
        'select fn_calcular_nota_individual_comision($1,$2,$3,$4,$5,$6) as n',
        [apinadero, cancha, atajadas, cuarta, huboRienda, rienda]
    );
    return Number(rows[0].n);
}

describe('CASO 2 — 4 preguntas, promedio simple', () => {
    test('4, 2.5, 5.5, 7 -> 4.75 antes de redondear, 4.8 con el redondeo oficial (1 decimal)', async () => {
        const n = await fnDirecta(4, 2.5, 5.5, 7, false, null);
        expect(n).toBeCloseTo(4.8, 5);
        expect(n).toBeCloseTo(Math.round((4 + 2.5 + 5.5 + 7) / 4 * 10) / 10, 10);
    });
});

describe('CASO 3 — todas las notas iguales', () => {
    test('4 preguntas con nota 7 -> 7.0', async () => {
        expect(await fnDirecta(7, 7, 7, 7, false, null)).toBeCloseTo(7.0, 5);
    });
    test('4 preguntas con nota 1 -> 1.0', async () => {
        expect(await fnDirecta(1, 1, 1, 1, false, null)).toBeCloseTo(1.0, 5);
    });
});

describe('CASO 4 — Movimiento a la Rienda = No: Jura NO interviene, 4 criterios puntuables', () => {
    test('el parámetro p_rienda se ignora completamente cuando p_hubo_rienda=false (aunque venga con un valor)', async () => {
        const sinRiendaParam = await fnDirecta(6, 5, 4, 3, false, null);
        const conRiendaParamIgnorado = await fnDirecta(6, 5, 4, 3, false, 1); // valor "trampa": si se usara, cambiaría el resultado
        expect(sinRiendaParam).toBeCloseTo(4.5, 5); // (6+5+4+3)/4, nunca /5
        expect(conRiendaParamIgnorado).toBe(sinRiendaParam);
    });

    test('a nivel de RPC real: enviar sin Movimiento a la Rienda calcula sobre 4 criterios', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuenta(asoc);
        const ev = await crearEvaluador(asoc);
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        const res = await enviarEvaluacion({
            rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: cuenta.id,
            apinadero: 6, cancha: 5, atajadas: 4, cuarta: 3, huboRienda: false, rienda: null
        });
        expect(Number(res.nota_individual_calculada)).toBeCloseTo(4.5, 5);
    });
});

describe('CASO 5 — Movimiento a la Rienda = Sí: 5 criterios puntuables', () => {
    test('4, 5, 6, 7, 3 (rienda) -> (4+5+6+7+3)/5 = 5', async () => {
        expect(await fnDirecta(4, 5, 6, 7, true, 3)).toBeCloseTo(5.0, 5);
    });

    test('a nivel de RPC real: enviar CON Movimiento a la Rienda calcula sobre 5 criterios', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuenta(asoc);
        const ev = await crearEvaluador(asoc);
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        const res = await enviarEvaluacion({
            rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: cuenta.id,
            apinadero: 4, cancha: 5, atajadas: 6, cuarta: 7, huboRienda: true, rienda: 3
        });
        expect(Number(res.nota_individual_calculada)).toBeCloseTo(5.0, 5);
    });
});

describe('CASO 6 — "¿Hubo Movimiento a la Rienda?" no es una nota', () => {
    test('fn_calcular_nota_individual_comision no tiene ningún parámetro que reciba ese booleano como nota puntuable (p_hubo_rienda es BOOLEAN, nunca se suma)', async () => {
        // Confirmado por construcción: p_hubo_rienda solo decide la cantidad de
        // criterios (4 o 5) en la división, nunca participa de la suma — ver
        // migración 082 (v_suma = p_apinadero + p_cancha + p_atajadas + p_cuarta [+ p_rienda]).
        const conTrue  = await fnDirecta(6, 6, 6, 6, true, 6);
        const conFalse = await fnDirecta(6, 6, 6, 6, false, null);
        // Con todos los criterios en 6 (incluida Rienda=6), el promedio es 6
        // en ambos casos — si el booleano se hubiera sumado como nota, el
        // resultado con true sería distinto.
        expect(conTrue).toBeCloseTo(6.0, 5);
        expect(conFalse).toBeCloseTo(6.0, 5);
    });
});

describe('CASO 7 — "¿Afectó el resultado final?" no interviene en el cálculo', () => {
    test('enviar la evaluación con afecto=true o afecto=false da exactamente la misma nota_individual_calculada', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuenta(asoc);
        const ev = await crearEvaluador(asoc);

        const rodeoA = await crearRodeo();
        const jA = await crearJurado(rodeoA, 'Jurado Afecto Si');
        const resA = await enviarEvaluacion({ rodeoId: rodeoA, asignacionId: jA, asociacionId: asoc, evaluadorId: ev.id, cuentaId: cuenta.id, apinadero: 6, cancha: 5, atajadas: 4, cuarta: 3, afecto: true });

        const rodeoB = await crearRodeo();
        const jB = await crearJurado(rodeoB, 'Jurado Afecto No');
        const resB = await enviarEvaluacion({ rodeoId: rodeoB, asignacionId: jB, asociacionId: asoc, evaluadorId: ev.id, cuentaId: cuenta.id, apinadero: 6, cancha: 5, atajadas: 4, cuarta: 3, afecto: false });

        expect(Number(resA.nota_individual_calculada)).toBeCloseTo(4.5, 5);
        expect(Number(resB.nota_individual_calculada)).toBeCloseTo(4.5, 5);
        expect(Number(resA.nota_individual_calculada)).toBe(Number(resB.nota_individual_calculada));

        const guardadas = await db.query(
            'select id, afecto_resultado_final from comision_evaluaciones_jurado where id in ($1,$2)',
            [resA.id, resB.id]
        );
        const porId = Object.fromEntries(guardadas.rows.map(r => [r.id, r.afecto_resultado_final]));
        expect(porId[resA.id]).toBe(true);
        expect(porId[resB.id]).toBe(false);
    });
});

describe('CASO 8 — Comentario general no interviene en el cálculo', () => {
    test('enviar con comentarios distintos (o sin comentario) da exactamente la misma nota_individual_calculada', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuenta(asoc);
        const ev = await crearEvaluador(asoc);

        const rodeoA = await crearRodeo();
        const jA = await crearJurado(rodeoA, 'Jurado Con Comentario');
        const resA = await enviarEvaluacion({ rodeoId: rodeoA, asignacionId: jA, asociacionId: asoc, evaluadorId: ev.id, cuentaId: cuenta.id, apinadero: 6, cancha: 5, atajadas: 4, cuarta: 3, comentario: 'Un comentario largo e irrelevante para el cálculo.' });

        const rodeoB = await crearRodeo();
        const jB = await crearJurado(rodeoB, 'Jurado Sin Comentario');
        const resB = await enviarEvaluacion({ rodeoId: rodeoB, asignacionId: jB, asociacionId: asoc, evaluadorId: ev.id, cuentaId: cuenta.id, apinadero: 6, cancha: 5, atajadas: 4, cuarta: 3, comentario: null });

        expect(Number(resA.nota_individual_calculada)).toBeCloseTo(4.5, 5);
        expect(Number(resA.nota_individual_calculada)).toBe(Number(resB.nota_individual_calculada));
    });
});

describe('CASO 9 — sin referencias activas a la ponderación antigua en la fórmula', () => {
    test('el cuerpo de fn_calcular_nota_individual_comision ya no contiene los literales de ponderación 0.16/0.24/0.32/0.08/0.20/0.30/0.40/0.10', async () => {
        const { rows } = await db.query(`select pg_get_functiondef(oid) as def from pg_proc where proname = 'fn_calcular_nota_individual_comision'`);
        const def = rows[0].def;
        for (const literal of ['0.16', '0.24', '0.32', '0.08', '0.20', '0.30', '0.40', '0.10']) {
            expect(def).not.toContain(literal);
        }
        // En su lugar, debe dividir dinámicamente por la cantidad de criterios aplicables.
        expect(def).toMatch(/\/\s*v_cantidad/);
    });
});

describe('CASO 10 — guardar, editar, cerrar y visualizar siguen funcionando', () => {
    test('flujo completo: enviar (parcial), completar el 2º jurado (completa), corregir, y la nota general refleja la columna almacenada', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuenta(asoc);
        const ev = await crearEvaluador(asoc);
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo, 'Jurado Uno');
        const j2 = await crearJurado(rodeo, 'Jurado Dos');

        const e1 = await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: cuenta.id, apinadero: 6, cancha: 5, atajadas: 4, cuarta: 3 });
        expect(Number(e1.nota_individual_calculada)).toBeCloseTo(4.5, 5);
        let fila = (await db.query('select estado_nota_comision from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(fila.estado_nota_comision).toBe('parcial');

        await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j2, asociacionId: asoc, evaluadorId: ev.id, cuentaId: cuenta.id, apinadero: 7, cancha: 7, atajadas: 7, cuarta: 7 });
        fila = (await db.query('select estado_nota_comision, nota_comision from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(fila.estado_nota_comision).toBe('completa');
        expect(Number(fila.nota_comision)).toBeCloseTo(5.8, 5); // avg(4.5, 7.0) = 5.75 -> 5.8

        // Corrección administrativa: recalcula server-side con la fórmula vigente (082).
        const corregida = await db.query(
            "select * from corregir_evaluacion_individual_comision_con_auditoria($1,7,7,7,7,false,null,'corrección de prueba',$2)",
            [e1.id, ADMIN_ID]
        );
        expect(Number(corregida.rows[0].nota_individual_calculada)).toBeCloseTo(7.0, 5);
        expect(corregida.rows[0].estado).toBe('corregida_admin');

        // Visualizar: la Nota Comisión general NUNCA se recalcula sola tras una
        // corrección individual (comportamiento ya existente, sin cambios) —
        // sigue reflejando lo que había al completarse, hasta una acción
        // administrativa explícita sobre la nota general.
        const final = (await db.query('select nota_comision, estado_nota_comision from rodeo_notas_secundarias where rodeo_id=$1', [rodeo])).rows[0];
        expect(Number(final.nota_comision)).toBeCloseTo(5.8, 5);
        expect(final.estado_nota_comision).toBe('completa');
    });
});

describe('NO afecta evaluaciones ya guardadas al visualizarlas', () => {
    test('una evaluación enviada ANTES de releer la función sigue mostrando su nota_individual_calculada histórica (la columna, no un recálculo)', async () => {
        const asoc = await crearAsociacion();
        const cuenta = await crearCuenta(asoc);
        const ev = await crearEvaluador(asoc);
        const rodeo = await crearRodeo();
        const j1 = await crearJurado(rodeo);
        const enviada = await enviarEvaluacion({ rodeoId: rodeo, asignacionId: j1, asociacionId: asoc, evaluadorId: ev.id, cuentaId: cuenta.id, apinadero: 6, cancha: 5, atajadas: 4, cuarta: 3 });
        const notaGuardada = Number(enviada.nota_individual_calculada);

        // Releer varias veces: el valor almacenado nunca cambia por sí solo,
        // sin importar cuántas veces se "visualice" (ningún SELECT re-invoca
        // fn_calcular_nota_individual_comision sobre una fila ya guardada).
        for (let i = 0; i < 3; i++) {
            const { rows } = await db.query('select nota_individual_calculada from comision_evaluaciones_jurado where id=$1', [enviada.id]);
            expect(Number(rows[0].nota_individual_calculada)).toBe(notaGuardada);
        }
    });
});
