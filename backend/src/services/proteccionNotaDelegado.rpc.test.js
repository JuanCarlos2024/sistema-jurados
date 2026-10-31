// ═════════════════════════════════════════════════════════════════════════
// Protección y trazabilidad de Nota Delegado (migración 088, versión final
// — 3 ajustes sobre el diseño inicial) — verificación contra Postgres REAL
// (PGlite), no mocks.
//
// REGLA PRINCIPAL: el administrador SIEMPRE puede modificar la Nota
// Delegado (nunca hay bloqueo permanente); el comentario obligatorio solo
// se exige ante un CAMBIO EFECTIVO (valor numérico distinto). Lo que SÍ se
// bloquea es la sincronización AUTOMÁTICA desde una cartilla digital
// cuando ya hay una corrección administrativa, O cuando la nota es un
// registro histórico preexistente de origen no verificado — en ambos
// casos la cartilla se sigue aceptando igual, solo no se sobrescribe la
// nota en silencio.
//
// Cubre los 10 casos de prueba obligatorios del pedido original, más los
// 3 ajustes de la revisión final:
//   1. Primer envío de cartilla digital.
//   2. Reenvío de cartilla sin corrección administrativa.
//   3. Modificación de nota por administrador con comentario.
//   4. Rechazo de modificación administrativa sin comentario (ante cambio real).
//   5. Nueva modificación administrativa de una nota ya protegida.
//   6. Bloqueo de sobrescritura por reenvío de delegado sobre nota protegida.
//   7. Conservación de todo el historial de modificaciones.
//   8. Integridad ante operaciones concurrentes.
//   9. Compatibilidad con las 94 notas históricas — AJUSTE 2: quedan como
//      'historica_sin_clasificar' (nunca 'automatica' inventado), bloquean
//      la sincronización automática con un motivo distinguible, pero el
//      administrador siempre puede corregirlas.
//  10. Conservación de la Nota Comisión y de los reportes actuales.
//  AJUSTE 1: comentario y corrección SOLO ante cambio numérico real —
//      reenviar el mismo valor nunca exige comentario ni genera historial.
// ═════════════════════════════════════════════════════════════════════════
jest.setTimeout(120000);
const fs = require('fs');
const path = require('path');
const { crearDb } = require('./__fixtures__/pgliteCliente');

const MIGRACIONES_DIR = path.join(__dirname, '..', '..', '..', 'database', 'migrations');
const leer = (n) => fs.readFileSync(path.join(MIGRACIONES_DIR, n), 'utf8');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaCartillaInstitucional.sql'), 'utf8');

const MIGRACIONES_PREVIAS = [
    '061_cuentas_institucionales.sql',
    '078_gestion_acceso_cuentas_institucionales.sql',
    '028_rodeo_notas_secundarias.sql',
    '079_comision_asociacion.sql'
];

let db;
let ADMIN_ID;

beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);
    for (const m of MIGRACIONES_PREVIAS) await db.exec(leer(m));

    const { rows } = await db.query("insert into administradores (nombre_completo) values ('Admin de Prueba') returning id");
    ADMIN_ID = rows[0].id;

    await db.exec(`GRANT ALL ON TABLE rodeos, rodeo_notas_secundarias, auditoria, administradores,
        evaluadores_comision, comision_evaluaciones_jurado, comision_evaluaciones_correcciones
        TO service_role;`);
});
afterAll(async () => { await db.close(); });

let seq = 0;
async function crearRodeo() {
    seq++;
    const { rows } = await db.query(
        "insert into rodeos (club, asociacion, fecha, tipo_rodeo_nombre) values ($1,'ASOC',now()::date,'Provincial') returning id",
        ['Club ' + seq]
    );
    return rows[0].id;
}

async function sincronizar(rodeoId, nota, actorId = 'delegado-test') {
    const { rows } = await db.query(
        'select * from sincronizar_nota_delegado_automatica($1,$2,$3)',
        [rodeoId, nota, actorId]
    );
    return rows[0];
}

async function corregirAdmin(rodeoId, nota, comentario, administradorId = ADMIN_ID) {
    const { rows } = await db.query(
        "select * from actualizar_notas_secundarias_con_auditoria($1,false,null,true,$2,false,'nota',$3,$4)",
        [rodeoId, nota, administradorId, comentario]
    );
    return rows[0];
}

async function filaNotas(rodeoId) {
    const { rows } = await db.query(
        'select nota_comision, nota_delegado, estado_nota_comision, estado_nota_delegado from rodeo_notas_secundarias where rodeo_id=$1',
        [rodeoId]
    );
    return rows[0];
}

async function contarCorrecciones(rodeoId) {
    const { rows } = await db.query('select count(*)::int as n from rodeo_notas_delegado_correcciones where rodeo_id=$1', [rodeoId]);
    return rows[0].n;
}

// Reproduce EXACTAMENTE la forma en que el backend actualmente publicado
// (previo a esta migración) invoca la RPC: 8 argumentos, por notación con
// nombre, sin enviar jamás la clave p_comentario_delegado (no existía en su
// código). supabase-js siempre serializa los params de `.rpc()` como un
// objeto -> PostgREST llama la función en Postgres por notación con nombre;
// como el 9º parámetro tiene DEFAULT NULL, Postgres resuelve esta llamada
// contra la ÚNICA función nueva sin ningún error de "no existe función".
async function llamarRpcAntigua({ rodeoId, actualizarComision, notaComision, actualizarDelegado, notaDelegado, confirmaSobrescritura, motivo, administradorId = ADMIN_ID }) {
    const { rows } = await db.query(
        `select * from actualizar_notas_secundarias_con_auditoria(
            p_rodeo_id := $1,
            p_actualizar_comision := $2,
            p_nota_comision := $3,
            p_actualizar_delegado := $4,
            p_nota_delegado := $5,
            p_confirma_sobrescritura_historica := $6,
            p_motivo := $7,
            p_administrador_id := $8
        )`,
        [rodeoId, actualizarComision, notaComision, actualizarDelegado, notaDelegado, confirmaSobrescritura, motivo, administradorId]
    );
    return rows[0];
}

// ─────────────────────────────────────────────────────────────────────────
// 9) Compatibilidad con las 94 notas históricas — DEBE ejecutarse ANTES de
//    aplicar la migración 088 (simula el estado real de producción: filas
//    con nota_delegado ya cargado, sin la columna estado_nota_delegado
//    todavía). El resto de los describe de este archivo asumen 088 ya
//    aplicada (orden de ejecución de Jest dentro de un archivo = orden de
//    declaración).
// ─────────────────────────────────────────────────────────────────────────
describe('9) Compatibilidad histórica — aplicar la migración 088 sobre notas ya existentes', () => {
    test('una Nota Delegado histórica (preexistente antes de 088) queda "historica_sin_clasificar" (NUNCA "automatica" inventado), valor intacto', async () => {
        const rodeo = await crearRodeo();
        // Simula uno de los 94 registros reales: nota_delegado ya cargada,
        // nota_comision también presente (para verificar que tampoco se
        // toca), por una vía anterior a esta migración.
        await db.query(
            "insert into rodeo_notas_secundarias (rodeo_id, nota_comision, nota_delegado, estado_nota_comision) values ($1,5.0,6.2,'completa')",
            [rodeo]
        );

        await db.exec(leer('088_proteccion_nota_delegado.sql'));

        const fila = await filaNotas(rodeo);
        expect(Number(fila.nota_delegado)).toBeCloseTo(6.2, 5);       // nunca se modifica el valor
        expect(fila.estado_nota_delegado).toBe('historica_sin_clasificar'); // nunca "automatica" inventado
        expect(Number(fila.nota_comision)).toBeCloseTo(5.0, 5);       // Comisión intacta
        expect(fila.estado_nota_comision).toBe('completa');           // Comisión intacta
    });

    test('un rodeo sin ninguna fila de notas no se ve afectado por la migración', async () => {
        const rodeo = await crearRodeo();
        const fila = await filaNotas(rodeo);
        expect(fila).toBeUndefined();
    });

    test('una nota histórica sin clasificar NUNCA se sobrescribe en silencio por una cartilla digital', async () => {
        const rodeo = await crearRodeo();
        await db.query(
            "insert into rodeo_notas_secundarias (rodeo_id, nota_delegado, estado_nota_delegado) values ($1,5.5,'historica_sin_clasificar')",
            [rodeo]
        );
        const r = await sincronizar(rodeo, 6.9);
        expect(r.resultado).toBe('omitida_historica_sin_clasificar');
        expect(Number(r.nota_delegado_vigente)).toBeCloseTo(5.5, 5);
        const fila = await filaNotas(rodeo);
        expect(Number(fila.nota_delegado)).toBeCloseTo(5.5, 5); // intacta
    });

    test('el administrador SIEMPRE puede corregir una nota histórica sin clasificar, con comentario', async () => {
        const rodeo = await crearRodeo();
        await db.query(
            "insert into rodeo_notas_secundarias (rodeo_id, nota_delegado, estado_nota_delegado) values ($1,5.5,'historica_sin_clasificar')",
            [rodeo]
        );
        const fila = await corregirAdmin(rodeo, 6.0, 'corrección de una nota histórica sin clasificar');
        expect(Number(fila.nota_delegado)).toBeCloseTo(6.0, 5);
        expect(fila.estado_nota_delegado).toBe('corregida_admin'); // ya no "a medio clasificar"
    });

    test('una cartilla SÍ puede enviarse sin sobrescritura indebida: el envío (fuera de esta RPC) nunca se bloquea, solo la propagación de la nota', async () => {
        // La RPC de sincronización es independiente del envío de la
        // cartilla (ver services/cartillaDelegadoNotas.js) — "omitida_*"
        // nunca lanza una excepción que pudiera hacer fallar el envío.
        const rodeo = await crearRodeo();
        await db.query(
            "insert into rodeo_notas_secundarias (rodeo_id, nota_delegado, estado_nota_delegado) values ($1,4.0,'historica_sin_clasificar')",
            [rodeo]
        );
        await expect(sincronizar(rodeo, 6.5)).resolves.toBeDefined();
    });

    test('una fila SIN nota_delegado (NULL) no bloquea la primera sincronización, aunque su estado haya quedado "historica_sin_clasificar" por el ADD COLUMN', async () => {
        const rodeo = await crearRodeo();
        await db.query(
            "insert into rodeo_notas_secundarias (rodeo_id, nota_comision, estado_nota_comision) values ($1,5.0,'completa')",
            [rodeo]
        ); // nota_delegado queda NULL; estado_nota_delegado toma el DEFAULT 'historica_sin_clasificar'
        const r = await sincronizar(rodeo, 6.3);
        expect(r.resultado).toBe('aplicada');
        const fila = await filaNotas(rodeo);
        expect(Number(fila.nota_delegado)).toBeCloseTo(6.3, 5);
        expect(fila.estado_nota_delegado).toBe('automatica');
    });
});

describe('1) Primer envío de cartilla digital — sincroniza sin protección previa', () => {
    test('rodeo sin fila previa -> resultado="aplicada", estado_nota_delegado="automatica"', async () => {
        const rodeo = await crearRodeo();
        const r = await sincronizar(rodeo, 6.0);
        expect(r.resultado).toBe('aplicada');
        expect(Number(r.nota_delegado_vigente)).toBeCloseTo(6.0, 5);

        const fila = await filaNotas(rodeo);
        expect(Number(fila.nota_delegado)).toBeCloseTo(6.0, 5);
        expect(fila.estado_nota_delegado).toBe('automatica');
    });

    test('nota null (borrador incompleto) -> resultado="omitida_borrador_incompleto", no crea fila', async () => {
        const rodeo = await crearRodeo();
        const r = await sincronizar(rodeo, null);
        expect(r.resultado).toBe('omitida_borrador_incompleto');
        const fila = await filaNotas(rodeo);
        expect(fila).toBeUndefined();
    });
});

describe('2) Reenvío de cartilla sin corrección administrativa — sigue sincronizando', () => {
    test('un segundo envío (reenvío) con nota distinta, sin protección, actualiza el valor normalmente', async () => {
        const rodeo = await crearRodeo();
        await sincronizar(rodeo, 5.0);
        const r2 = await sincronizar(rodeo, 6.8);
        expect(r2.resultado).toBe('aplicada');
        const fila = await filaNotas(rodeo);
        expect(Number(fila.nota_delegado)).toBeCloseTo(6.8, 5);
        expect(fila.estado_nota_delegado).toBe('automatica');
    });
});

describe('3) Modificación de nota por administrador con comentario', () => {
    test('admin corrige una nota automática -> éxito, queda "corregida_admin"', async () => {
        const rodeo = await crearRodeo();
        await sincronizar(rodeo, 5.0);
        const fila = await corregirAdmin(rodeo, 4.2, 'Corrección: el delegado reportó un promedio erróneo.');
        expect(Number(fila.nota_delegado)).toBeCloseTo(4.2, 5);
        expect(fila.estado_nota_delegado).toBe('corregida_admin');
        expect(await contarCorrecciones(rodeo)).toBe(1);
    });

    test('admin registra la nota por primera vez (sin fila previa) -> éxito, también exige comentario', async () => {
        const rodeo = await crearRodeo();
        const fila = await corregirAdmin(rodeo, 5.5, 'Registro inicial validado manualmente por el administrador.');
        expect(Number(fila.nota_delegado)).toBeCloseTo(5.5, 5);
        expect(fila.estado_nota_delegado).toBe('corregida_admin');
    });
});

describe('4) Rechazo de modificación administrativa sin comentario (ante cambio real)', () => {
    test('comentario NULL con cambio real (sin fila previa) -> rechaza con COMENTARIO_DELEGADO_OBLIGATORIO, no escribe nada', async () => {
        const rodeo = await crearRodeo();
        await expect(corregirAdmin(rodeo, 5.0, null)).rejects.toThrow(/COMENTARIO_DELEGADO_OBLIGATORIO/);
        const fila = await filaNotas(rodeo);
        expect(fila).toBeUndefined();
        expect(await contarCorrecciones(rodeo)).toBe(0);
    });

    test('comentario de solo espacios, con cambio real -> rechaza igual', async () => {
        const rodeo = await crearRodeo();
        await expect(corregirAdmin(rodeo, 5.0, '   ')).rejects.toThrow(/COMENTARIO_DELEGADO_OBLIGATORIO/);
    });

    test('nota fuera de rango -> rechaza con NOTA_DELEGADO_FUERA_DE_RANGO (defensa en profundidad)', async () => {
        const rodeo = await crearRodeo();
        await expect(corregirAdmin(rodeo, 8.5, 'comentario real')).rejects.toThrow(/NOTA_DELEGADO_FUERA_DE_RANGO/);
    });

    // AJUSTE 1: sin cambio real, el comentario NUNCA se exige.
    test('AJUSTE 1 — reenviar el MISMO valor sin comentario -> nunca rechaza, nunca escribe, nunca genera historial', async () => {
        const rodeo = await crearRodeo();
        await sincronizar(rodeo, 5.0); // deja nota_delegado=5.0, estado='automatica'
        const filaAntes = await filaNotas(rodeo);

        const filaDespues = await corregirAdmin(rodeo, 5.0, null); // mismo valor, sin comentario
        expect(Number(filaDespues.nota_delegado)).toBeCloseTo(5.0, 5);
        expect(filaDespues.estado_nota_delegado).toBe(filaAntes.estado_nota_delegado); // sigue "automatica", NUNCA pasa a "corregida_admin"
        expect(await contarCorrecciones(rodeo)).toBe(0); // ninguna fila de historial
    });

    test('AJUSTE 1 — modificación exclusiva de Nota Comisión nunca exige comentario de Delegado', async () => {
        const rodeo = await crearRodeo();
        const { rows } = await db.query(
            "select * from actualizar_notas_secundarias_con_auditoria($1,true,6.0,false,null,false,'solo comision',$2,null)",
            [rodeo, ADMIN_ID]
        );
        expect(Number(rows[0].nota_comision)).toBeCloseTo(6.0, 5);
        expect(rows[0].nota_delegado).toBeNull();
    });
});

describe('5) Nueva modificación administrativa de una nota ya protegida — REGLA PRINCIPAL: siempre permitido', () => {
    test('el administrador puede corregir una nota que ya estaba "corregida_admin", con un nuevo comentario', async () => {
        const rodeo = await crearRodeo();
        await corregirAdmin(rodeo, 4.0, 'primera corrección');
        const fila2 = await corregirAdmin(rodeo, 5.3, 'segunda corrección, dato verificado con el delegado');
        expect(Number(fila2.nota_delegado)).toBeCloseTo(5.3, 5);
        expect(fila2.estado_nota_delegado).toBe('corregida_admin');
        expect(await contarCorrecciones(rodeo)).toBe(2);
    });

    test('nunca implementa un bloqueo permanente: sigue exigiendo comentario (ante cambio real) pero nunca rechaza por "ya protegida"', async () => {
        const rodeo = await crearRodeo();
        await corregirAdmin(rodeo, 4.0, 'primera corrección');
        await expect(corregirAdmin(rodeo, 5.0, 'tercera corrección')).resolves.toBeDefined();
    });
});

describe('6) Bloqueo de sobrescritura por reenvío de delegado sobre nota protegida', () => {
    test('tras una corrección administrativa, un reenvío de cartilla NO sobrescribe: resultado="omitida_proteccion_administrativa", nota intacta', async () => {
        const rodeo = await crearRodeo();
        await sincronizar(rodeo, 5.0); // sincronización automática inicial
        await corregirAdmin(rodeo, 3.5, 'corrección administrativa oficial');

        const r = await sincronizar(rodeo, 6.9); // reenvío posterior del delegado
        expect(r.resultado).toBe('omitida_proteccion_administrativa');
        expect(Number(r.nota_delegado_vigente)).toBeCloseTo(3.5, 5);

        const fila = await filaNotas(rodeo);
        expect(Number(fila.nota_delegado)).toBeCloseTo(3.5, 5); // la corrección oficial se conserva intacta
        expect(fila.estado_nota_delegado).toBe('corregida_admin');
    });
});

describe('7) Conservación de todo el historial de modificaciones (acumulativo, append-only, solo cambios reales)', () => {
    test('dos correcciones administrativas sucesivas con valores distintos dejan DOS filas en el historial, ninguna se pierde', async () => {
        const rodeo = await crearRodeo();
        await corregirAdmin(rodeo, 4.0, 'primera corrección');
        await corregirAdmin(rodeo, 5.5, 'segunda corrección');

        const { rows } = await db.query(
            'select nota_anterior, nota_nueva, comentario, administrador_id, origen_administrativo from rodeo_notas_delegado_correcciones where rodeo_id=$1 order by created_at asc',
            [rodeo]
        );
        expect(rows).toHaveLength(2);
        expect(rows[0].nota_anterior).toBeNull(); // no había nota previa
        expect(Number(rows[0].nota_nueva)).toBeCloseTo(4.0, 5);
        expect(rows[0].comentario).toBe('primera corrección');
        expect(Number(rows[1].nota_anterior)).toBeCloseTo(4.0, 5); // la anterior es la que quedó de la 1ª
        expect(Number(rows[1].nota_nueva)).toBeCloseTo(5.5, 5);
        expect(rows[1].comentario).toBe('segunda corrección');
        rows.forEach(r => {
            expect(r.administrador_id).toBe(ADMIN_ID);
            expect(r.origen_administrativo).toBe('notas_secundarias_admin');
        });
    });

    test('un reenvío del mismo valor en medio de la secuencia NUNCA agrega una fila al historial', async () => {
        const rodeo = await crearRodeo();
        await corregirAdmin(rodeo, 4.0, 'primera corrección');
        await corregirAdmin(rodeo, 4.0, null); // mismo valor, sin comentario -> no-op
        await corregirAdmin(rodeo, 5.0, 'segunda corrección real');
        expect(await contarCorrecciones(rodeo)).toBe(2); // nunca 3
    });

    test('la tabla de historial es append-only a nivel de base de datos: service_role no tiene UPDATE/DELETE', async () => {
        const { rows } = await db.query(
            `select
                has_table_privilege('service_role', 'rodeo_notas_delegado_correcciones', 'SELECT') as sel,
                has_table_privilege('service_role', 'rodeo_notas_delegado_correcciones', 'INSERT') as ins,
                has_table_privilege('service_role', 'rodeo_notas_delegado_correcciones', 'UPDATE') as upd,
                has_table_privilege('service_role', 'rodeo_notas_delegado_correcciones', 'DELETE') as del`
        );
        expect(rows[0].sel).toBe(true);
        expect(rows[0].ins).toBe(true);
        expect(rows[0].upd).toBe(false);
        expect(rows[0].del).toBe(false);
    });

    test('anon y authenticated no tienen ningún privilegio sobre el historial', async () => {
        const { rows } = await db.query(
            `select
                has_table_privilege('anon', 'rodeo_notas_delegado_correcciones', 'SELECT') as anon_sel,
                has_table_privilege('authenticated', 'rodeo_notas_delegado_correcciones', 'SELECT') as auth_sel`
        );
        expect(rows[0].anon_sel).toBe(false);
        expect(rows[0].auth_sel).toBe(false);
    });

    test('también deja un registro en la auditoría genérica (reutilizada, no duplicada) con el comentario real, solo ante cambio', async () => {
        const rodeo = await crearRodeo();
        await corregirAdmin(rodeo, 4.4, 'comentario de auditoría genérica');
        const { rows } = await db.query(
            "select descripcion, actor_tipo from auditoria where tabla='rodeo_notas_secundarias' and accion='corregir_nota_delegado' and registro_id=$1",
            [rodeo]
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].descripcion).toBe('comentario de auditoría genérica');
        expect(rows[0].actor_tipo).toBe('administrador');
    });
});

describe('8) Integridad ante operaciones concurrentes', () => {
    test('dos sincronizaciones automáticas simultáneas sobre el mismo rodeo (sin fila previa) nunca corrompen el dato: termina en un valor consistente, uno de los dos', async () => {
        const rodeo = await crearRodeo();
        const [r1, r2] = await Promise.all([
            sincronizar(rodeo, 5.5),
            sincronizar(rodeo, 6.1)
        ]);
        expect([r1.resultado, r2.resultado]).toEqual(['aplicada', 'aplicada']);
        const fila = await filaNotas(rodeo);
        expect([5.5, 6.1]).toContain(Number(fila.nota_delegado));
        expect(fila.estado_nota_delegado).toBe('automatica');
    });

    test('una corrección administrativa y una sincronización automática concurrentes nunca dejan la fila en un estado mixto inconsistente', async () => {
        const rodeo = await crearRodeo();
        await sincronizar(rodeo, 5.0);
        const [resAdmin, resSync] = await Promise.all([
            corregirAdmin(rodeo, 3.0, 'corrección concurrente'),
            sincronizar(rodeo, 6.6)
        ]);
        const fila = await filaNotas(rodeo);
        // El resultado final es uno de los dos escenarios válidos según el
        // orden real de ejecución del candado FOR UPDATE — nunca un valor
        // corrupto ni un estado a medio escribir.
        const escenarioA = fila.estado_nota_delegado === 'corregida_admin' && Number(fila.nota_delegado) === 3.0;
        const escenarioB = fila.estado_nota_delegado === 'automatica' && Number(fila.nota_delegado) === 6.6;
        expect(escenarioA || escenarioB).toBe(true);
        expect(resAdmin).toBeDefined();
        expect(resSync).toBeDefined();
    });
});

describe('11) Compatibilidad de despliegue — llamadas RPC con la firma antigua (8 argumentos, sin p_comentario_delegado)', () => {
    test('llamada antigua que solo actualiza Nota Comisión (sin tocar Delegado) sigue funcionando igual que antes', async () => {
        const rodeo = await crearRodeo();
        const fila = await llamarRpcAntigua({
            rodeoId: rodeo, actualizarComision: true, notaComision: 6.0,
            actualizarDelegado: false, notaDelegado: null,
            confirmaSobrescritura: false, motivo: 'solo comisión, llamada antigua'
        });
        expect(Number(fila.nota_comision)).toBeCloseTo(6.0, 5);
        expect(fila.nota_delegado).toBeNull();
    });

    test('llamada antigua que intenta cambiar Nota Delegado (cambio real) sin comentario se rechaza de forma controlada, no corrompe nada', async () => {
        const rodeo = await crearRodeo();
        await expect(llamarRpcAntigua({
            rodeoId: rodeo, actualizarComision: false, notaComision: null,
            actualizarDelegado: true, notaDelegado: 5.0,
            confirmaSobrescritura: false, motivo: 'intento antiguo de cambiar delegado'
        })).rejects.toThrow(/COMENTARIO_DELEGADO_OBLIGATORIO/);
        const fila = await filaNotas(rodeo);
        expect(fila).toBeUndefined();
        expect(await contarCorrecciones(rodeo)).toBe(0);
    });

    test('llamada antigua que reenvía el MISMO valor de Delegado (sin cambio real) nunca exige comentario, porque el backend viejo nunca lo manda', async () => {
        const rodeo = await crearRodeo();
        await sincronizar(rodeo, 5.0); // deja nota_delegado=5.0 vía cartilla digital
        const fila = await llamarRpcAntigua({
            rodeoId: rodeo, actualizarComision: false, notaComision: null,
            actualizarDelegado: true, notaDelegado: 5.0,
            confirmaSobrescritura: false, motivo: 'reenvío antiguo mismo valor'
        });
        expect(Number(fila.nota_delegado)).toBeCloseTo(5.0, 5);
        expect(fila.estado_nota_delegado).toBe('automatica'); // nunca pasa a corregida_admin
        expect(await contarCorrecciones(rodeo)).toBe(0);
    });

    test('el backend nuevo (9 argumentos, con comentario) sigue coexistiendo con la misma única función', async () => {
        const rodeo = await crearRodeo();
        const fila = await corregirAdmin(rodeo, 6.5, 'llamada nueva con comentario, misma función');
        expect(Number(fila.nota_delegado)).toBeCloseTo(6.5, 5);
        expect(fila.estado_nota_delegado).toBe('corregida_admin');
    });

    test('no existe una segunda función (overload) de 8 parámetros: solo hay una firma posible para esta función', async () => {
        const { rows } = await db.query(
            `select count(*)::int as n from pg_proc p
             join pg_namespace ns on ns.oid = p.pronamespace
             where ns.nspname = 'public' and p.proname = 'actualizar_notas_secundarias_con_auditoria'`
        );
        expect(rows[0].n).toBe(1);
    });
});

describe('12) Idempotencia de la migración 088 (reejecutar el archivo completo no debe fallar)', () => {
    test('reaplicar 088 sobre un esquema que ya la tiene aplicada no lanza error, y la RPC sigue funcionando después', async () => {
        await expect(db.exec(leer('088_proteccion_nota_delegado.sql'))).resolves.not.toThrow();

        const rodeo = await crearRodeo();
        const fila = await corregirAdmin(rodeo, 6.1, 'verificación post-reaplicación de 088');
        expect(Number(fila.nota_delegado)).toBeCloseTo(6.1, 5);
        expect(fila.estado_nota_delegado).toBe('corregida_admin');

        const { rows } = await db.query(
            `select count(*)::int as n from pg_proc p
             join pg_namespace ns on ns.oid = p.pronamespace
             where ns.nspname = 'public' and p.proname = 'actualizar_notas_secundarias_con_auditoria'`
        );
        expect(rows[0].n).toBe(1); // sigue sin overload tras reaplicar
    });
});

describe('13) Historial de correcciones sobrevive a la eliminación del rodeo (sin ON DELETE CASCADE)', () => {
    test('borrar un rodeo con correcciones de Delegado es rechazado por la FK — el historial nunca se pierde en cascada', async () => {
        const rodeo = await crearRodeo();
        await corregirAdmin(rodeo, 5.0, 'corrección antes de intentar borrar el rodeo');
        expect(await contarCorrecciones(rodeo)).toBe(1);

        await expect(db.query('delete from rodeos where id=$1', [rodeo])).rejects.toThrow();
        expect(await contarCorrecciones(rodeo)).toBe(1); // intacto
    });
});

describe('10) Conservación de la Nota Comisión y de los reportes actuales', () => {
    test('corregir Delegado nunca toca Comisión, en ningún sentido (valor ni estado)', async () => {
        const rodeo = await crearRodeo();
        await db.query(
            "insert into rodeo_notas_secundarias (rodeo_id, nota_comision, estado_nota_comision) values ($1,5.8,'completa')",
            [rodeo]
        );
        await corregirAdmin(rodeo, 4.5, 'corrección de delegado únicamente');
        const fila = await filaNotas(rodeo);
        expect(Number(fila.nota_comision)).toBeCloseTo(5.8, 5);
        expect(fila.estado_nota_comision).toBe('completa');
    });

    test('rodeo_notas_secundarias.nota_delegado sigue siendo la única fuente leída (mismo nombre de columna, sin tabla paralela)', async () => {
        const rodeo = await crearRodeo();
        await corregirAdmin(rodeo, 6.0, 'verificación de fuente única');
        const { rows } = await db.query('select nota_delegado from rodeo_notas_secundarias where rodeo_id=$1', [rodeo]);
        expect(Number(rows[0].nota_delegado)).toBeCloseTo(6.0, 5);
    });
});
