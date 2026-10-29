// Fase 1A — infraestructura de trazabilidad de designaciones, verificación
// contra Postgres REAL (PGlite) de la migración 083: bitacora_designaciones
// (ancla dual, append-only real), catalogo_motivos_designacion, snapshot de
// identidad en notas_rodeo y publicar_evaluacion(). No conecta nada de esto
// con ningún endpoint — eso es Fase 1B, fuera de alcance de este archivo.
const fs = require('fs');
const path = require('path');
jest.setTimeout(120000);
const { crearDb } = require('./__fixtures__/pgliteCliente');

const MIGRACIONES_DIR = path.join(__dirname, '..', '..', '..', 'database', 'migrations');
const leer = (n) => fs.readFileSync(path.join(MIGRACIONES_DIR, n), 'utf8');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaBitacoraDesignaciones.sql'), 'utf8');
const MIGRACION_031 = leer('031_anular_caso.sql');
const MIGRACION_083 = leer('083_fase1a_bitacora_designaciones_catalogo_motivos_snapshot_notas.sql');
// Texto de publicar_evaluacion recuperado de producción (jurados_2026) vía
// pg_get_functiondef, de solo lectura — entregado como archivo de
// referencia. Se usa como base de comparación, nunca se ejecuta contra
// Supabase desde este test.
const REFERENCIA_PRODUCCION = fs.readFileSync(path.join(__dirname, '__fixtures__', 'publicarEvaluacionProduccionReferencia.sql'), 'utf8');
const FIRMA_PUBLICAR_EVALUACION = "'public.publicar_evaluacion(uuid,uuid,text,text)'::regprocedure";

let db; const ID = {};
async function q(sql, p) { return (await db.query(sql, p)).rows; }

beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);

    // Fixture de dominio reutilizado por todos los tests (no se modifica en
    // los tests individuales salvo que se indique explícitamente).
    ID.admin = (await q("insert into administradores (nombre_completo) values ('Admin Fase1A') returning id"))[0].id;
    ID.jefe = (await q("insert into administradores (nombre_completo) values ('Jefe Área Deportiva') returning id"))[0].id;
    ID.temp = (await q("insert into temporadas (nombre, fecha_inicio, fecha_fin) values ('2026','2026-01-01','2026-12-31') returning id"))[0].id;
    ID.j1 = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Juan Pérez','A') returning id"))[0].id;
    ID.j2 = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Pedro Soto','A') returning id"))[0].id;
    ID.rodeo = (await q("insert into rodeos (club, asociacion, fecha) values ('Club Test','Osorno','2026-05-10') returning id"))[0].id;
    ID.asignacion = (await q(
        "insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, nombre_importado, categoria_aplicada, estado) values ($1,$2,'jurado','Juan Pérez','A','activo') returning id",
        [ID.rodeo, ID.j1]
    ))[0].id;
    ID.propuesta = (await q("insert into propuestas_designacion (temporada_id, creado_por) values ($1,$2) returning id", [ID.temp, ID.admin]))[0].id;
    ID.propuestaDetalle = (await q(
        "insert into propuestas_designacion_detalle (propuesta_id, rodeo_id, jurado_id_propuesto, estado_revision) values ($1,$2,$3,'PENDIENTE') returning id",
        [ID.propuesta, ID.rodeo, ID.j1]
    ))[0].id;

    await db.exec(MIGRACION_083);

    // Mismo patrón ya usado por otras *.rpc.test.js del proyecto: las tablas
    // preexistentes necesitan su propio GRANT a service_role dentro del
    // fixture de pruebas (la migración 083 solo otorga sobre las tablas que
    // ella misma crea/toca).
    await db.exec(`GRANT ALL ON TABLE administradores, temporadas, usuarios_pagados, rodeos, asignaciones,
        propuestas_designacion, propuestas_designacion_detalle, notas_rodeo, evaluaciones, evaluacion_casos,
        evaluacion_escala_puntaje_nota, evaluacion_escala_calificacion, evaluacion_auditoria TO service_role;`);
});
afterAll(async () => { await db.close(); });

async function registrar(args) {
    const cols = [
        'tipo_movimiento', 'rodeo_id', 'actor_id', 'propuesta_detalle_id', 'asignacion_id',
        'usuario_pagado_id_anterior', 'nombre_anterior_snapshot', 'usuario_pagado_id_nuevo', 'nombre_nuevo_snapshot',
        'motivo_catalogo_id', 'motivo_detalle', 'actor_tipo', 'fecha_efectiva', 'operacion_id'
    ];
    const vals = cols.map((c) => {
        if (c === 'actor_tipo') return args.actor_tipo || 'administrador';
        return c in args ? args[c] : null;
    });
    const placeholders = cols.map((c, i) => {
        if (c === 'fecha_efectiva') return `$${i + 1}::timestamptz`;
        return `$${i + 1}`;
    });
    const sql = `select * from registrar_movimiento_designacion(
        p_tipo_movimiento := $1, p_rodeo_id := $2, p_actor_id := $3,
        p_propuesta_detalle_id := $4, p_asignacion_id := $5,
        p_usuario_pagado_id_anterior := $6, p_nombre_anterior_snapshot := $7,
        p_usuario_pagado_id_nuevo := $8, p_nombre_nuevo_snapshot := $9,
        p_motivo_catalogo_id := $10, p_motivo_detalle := $11, p_actor_tipo := $12,
        p_fecha_efectiva := ${placeholders[12]}, p_operacion_id := $14
    )`;
    return (await q(sql, vals))[0];
}

describe('catalogo_motivos_designacion', () => {
    test('queda sembrado con los 10 motivos aprobados, activos', async () => {
        const filas = await q('select codigo from catalogo_motivos_designacion where activo = true order by orden');
        expect(filas.map((f) => f.codigo)).toEqual([
            'jurado_no_disponible', 'rechazo_designacion', 'criterio_tecnico_area_deportiva',
            'ajuste_categoria', 'problema_traslado', 'solicitud_jurado', 'emergencia_fuerza_mayor',
            'correccion_administrativa', 'enroque', 'otro'
        ]);
    });
});

describe('bitacora_designaciones — ancla dual (casos 1-3)', () => {
    test('1) movimiento vinculado únicamente a propuesta (sin asignación todavía)', async () => {
        const r = await registrar({
            tipo_movimiento: 'modificacion_manual_borrador', rodeo_id: ID.rodeo, actor_id: ID.admin,
            propuesta_detalle_id: ID.propuestaDetalle,
            usuario_pagado_id_nuevo: ID.j2, nombre_nuevo_snapshot: 'Pedro Soto'
        });
        expect(r.propuesta_detalle_id).toBe(ID.propuestaDetalle);
        expect(r.asignacion_id).toBeNull();
    });

    test('2) movimiento vinculado únicamente a asignación (sin propuesta de origen)', async () => {
        const r = await registrar({
            tipo_movimiento: 'reemplazo', rodeo_id: ID.rodeo, actor_id: ID.admin,
            asignacion_id: ID.asignacion,
            usuario_pagado_id_anterior: ID.j1, nombre_anterior_snapshot: 'Juan Pérez',
            usuario_pagado_id_nuevo: ID.j2, nombre_nuevo_snapshot: 'Pedro Soto'
        });
        expect(r.asignacion_id).toBe(ID.asignacion);
        expect(r.propuesta_detalle_id).toBeNull();
    });

    test('3) movimiento vinculado a ambas referencias (aplicación de propuesta)', async () => {
        const r = await registrar({
            tipo_movimiento: 'aplicacion_propuesta', rodeo_id: ID.rodeo, actor_id: ID.admin,
            propuesta_detalle_id: ID.propuestaDetalle, asignacion_id: ID.asignacion
        });
        expect(r.propuesta_detalle_id).toBe(ID.propuestaDetalle);
        expect(r.asignacion_id).toBe(ID.asignacion);
    });

    test('4) rechaza un evento sin ninguna referencia válida — vía función y vía INSERT directo', async () => {
        await expect(registrar({
            tipo_movimiento: 'rectificacion_administrativa', rodeo_id: ID.rodeo, actor_id: ID.admin
        })).rejects.toThrow(/REFERENCIA_REQUERIDA/);

        await expect(db.query(
            `insert into bitacora_designaciones (rodeo_id, actor_id, actor_tipo, tipo_movimiento)
             values ($1,$2,'administrador','rectificacion_administrativa')`,
            [ID.rodeo, ID.admin]
        )).rejects.toThrow(/chk_bitacora_referencia_valida/);
    });
});

describe('bitacora_designaciones — identidad e historia (casos 5-8)', () => {
    test('5-6) conserva usuario_pagado_id y nombre anterior/nuevo como snapshot, inmune a cambios posteriores del jurado', async () => {
        const r = await registrar({
            tipo_movimiento: 'reemplazo', rodeo_id: ID.rodeo, actor_id: ID.admin, asignacion_id: ID.asignacion,
            usuario_pagado_id_anterior: ID.j1, nombre_anterior_snapshot: 'Juan Pérez (snapshot)',
            usuario_pagado_id_nuevo: ID.j2, nombre_nuevo_snapshot: 'Pedro Soto (snapshot)'
        });
        await db.query("update usuarios_pagados set nombre_completo = 'Juan Pérez Cambiado' where id = $1", [ID.j1]);
        const fila = (await q('select * from bitacora_designaciones where id = $1', [r.id]))[0];
        expect(fila.usuario_pagado_id_anterior).toBe(ID.j1);
        expect(fila.usuario_pagado_id_nuevo).toBe(ID.j2);
        expect(fila.nombre_anterior_snapshot).toBe('Juan Pérez (snapshot)');
        expect(fila.nombre_nuevo_snapshot).toBe('Pedro Soto (snapshot)');
    });

    test('7) fecha_efectiva puede ser distinta de la fecha administrativa (created_at)', async () => {
        const fechaPasada = '2026-01-15T00:00:00Z';
        const r = await registrar({
            tipo_movimiento: 'regularizacion_posterior', rodeo_id: ID.rodeo, actor_id: ID.admin,
            asignacion_id: ID.asignacion, fecha_efectiva: fechaPasada
        });
        const fila = (await q('select * from bitacora_designaciones where id = $1', [r.id]))[0];
        expect(new Date(fila.fecha_efectiva).toISOString()).toBe(new Date(fechaPasada).toISOString());
        expect(new Date(fila.created_at).getTime()).toBeGreaterThan(new Date(fechaPasada).getTime());
    });

    test('8) dos movimientos de un mismo enroque comparten operacion_id y se recuperan juntos', async () => {
        const operacionId = (await q('select gen_random_uuid() as id'))[0].id;
        await registrar({
            tipo_movimiento: 'enroque', rodeo_id: ID.rodeo, actor_id: ID.admin, asignacion_id: ID.asignacion,
            usuario_pagado_id_anterior: ID.j1, usuario_pagado_id_nuevo: ID.j2, operacion_id: operacionId
        });
        await registrar({
            tipo_movimiento: 'enroque', rodeo_id: ID.rodeo, actor_id: ID.admin, asignacion_id: ID.asignacion,
            usuario_pagado_id_anterior: ID.j2, usuario_pagado_id_nuevo: ID.j1, operacion_id: operacionId
        });
        const filas = await q('select * from bitacora_designaciones where operacion_id = $1', [operacionId]);
        expect(filas).toHaveLength(2);
        expect(filas.every((f) => f.tipo_movimiento === 'enroque')).toBe(true);
    });
});

describe('bitacora_designaciones — integridad, inmutabilidad y permisos (casos 9-11, 14)', () => {
    test('9) integridad de claves foráneas — rechaza asignacion_id, propuesta_detalle_id y rodeo_id inexistentes', async () => {
        const inexistente = (await q('select gen_random_uuid() as id'))[0].id;
        await expect(registrar({
            tipo_movimiento: 'reemplazo', rodeo_id: ID.rodeo, actor_id: ID.admin, asignacion_id: inexistente
        })).rejects.toThrow();
        await expect(registrar({
            tipo_movimiento: 'aceptacion', rodeo_id: ID.rodeo, actor_id: ID.admin, propuesta_detalle_id: inexistente
        })).rejects.toThrow();
        await expect(registrar({
            tipo_movimiento: 'reemplazo', rodeo_id: inexistente, actor_id: ID.admin, asignacion_id: ID.asignacion
        })).rejects.toThrow();
    });

    test('verificación final: rechaza un rodeo_id que exista pero no corresponda al de la asignación/propuesta referenciada', async () => {
        const otroRodeo = (await q("insert into rodeos (club, asociacion, fecha) values ('Club Otro Rodeo','Osorno','2026-07-01') returning id"))[0].id;
        await expect(registrar({
            tipo_movimiento: 'reemplazo', rodeo_id: otroRodeo, actor_id: ID.admin, asignacion_id: ID.asignacion
        })).rejects.toThrow(/RODEO_INCONSISTENTE_CON_ASIGNACION/);
        await expect(registrar({
            tipo_movimiento: 'aceptacion', rodeo_id: otroRodeo, actor_id: ID.admin, propuesta_detalle_id: ID.propuestaDetalle
        })).rejects.toThrow(/RODEO_INCONSISTENTE_CON_PROPUESTA/);
    });

    test('10) inmutabilidad: service_role tiene SELECT/INSERT pero NUNCA UPDATE ni DELETE sobre bitacora_designaciones', async () => {
        const { rows: [p] } = await db.query(`select
            has_table_privilege('service_role', 'bitacora_designaciones', 'SELECT') as sel,
            has_table_privilege('service_role', 'bitacora_designaciones', 'INSERT') as ins,
            has_table_privilege('service_role', 'bitacora_designaciones', 'UPDATE') as upd,
            has_table_privilege('service_role', 'bitacora_designaciones', 'DELETE') as del`);
        expect(p).toEqual({ sel: true, ins: true, upd: false, del: false });
    });

    test('11) permisos de lectura y escritura: anon/authenticated sin ningún privilegio sobre las tablas nuevas', async () => {
        for (const tabla of ['bitacora_designaciones', 'catalogo_motivos_designacion']) {
            const { rows: [p] } = await db.query(
                `select has_table_privilege('anon', $1, 'SELECT') as anon_sel,
                        has_table_privilege('authenticated', $1, 'SELECT') as auth_sel,
                        has_table_privilege('anon', $1, 'INSERT') as anon_ins`,
                [tabla]
            );
            expect(p).toEqual({ anon_sel: false, auth_sel: false, anon_ins: false });
        }
        const { rows: [cat] } = await db.query(`select
            has_table_privilege('service_role', 'catalogo_motivos_designacion', 'UPDATE') as upd,
            has_table_privilege('service_role', 'catalogo_motivos_designacion', 'DELETE') as del`);
        expect(cat).toEqual({ upd: true, del: false });
    });

    const FIRMA_REGISTRAR = "'public.registrar_movimiento_designacion(text,uuid,uuid,uuid,uuid,uuid,text,uuid,text,uuid,text,text,timestamptz,uuid)'::regprocedure";

    test('privilegios de FUNCIÓN sobre registrar_movimiento_designacion: ni PUBLIC ni anon/authenticated tienen EXECUTE; solo service_role', async () => {
        await db.exec('CREATE ROLE rol_sin_privilegios_test;');
        const { rows: [p] } = await db.query(`select
            has_function_privilege('rol_sin_privilegios_test', ${FIRMA_REGISTRAR}, 'EXECUTE') as sin_privilegios,
            has_function_privilege('anon', ${FIRMA_REGISTRAR}, 'EXECUTE') as anon,
            has_function_privilege('authenticated', ${FIRMA_REGISTRAR}, 'EXECUTE') as authenticated,
            has_function_privilege('service_role', ${FIRMA_REGISTRAR}, 'EXECUTE') as service_role`);
        expect(p).toEqual({ sin_privilegios: false, anon: false, authenticated: false, service_role: true });
    });

    test('registrar_movimiento_designacion NO es SECURITY DEFINER y fija search_path=public (defensa contra search_path hijacking)', async () => {
        const { rows: [f] } = await db.query(
            `select prosecdef, proconfig from pg_proc where oid = ${FIRMA_REGISTRAR}`
        );
        expect(f.prosecdef).toBe(false);
        expect(f.proconfig).toEqual(['search_path=public']);
    });

    test('14) errores de escritura reales (no simulados con mocks): tipo_movimiento inválido y motivo_catalogo_id inexistente no dejan fila insertada', async () => {
        const antes = Number((await q('select count(*) c from bitacora_designaciones'))[0].c);

        await expect(db.query(
            `insert into bitacora_designaciones (rodeo_id, actor_id, actor_tipo, tipo_movimiento, asignacion_id)
             values ($1,$2,'administrador','tipo_que_no_existe',$3)`,
            [ID.rodeo, ID.admin, ID.asignacion]
        )).rejects.toThrow();

        const inexistente = (await q('select gen_random_uuid() as id'))[0].id;
        await expect(registrar({
            tipo_movimiento: 'reemplazo', rodeo_id: ID.rodeo, actor_id: ID.admin, asignacion_id: ID.asignacion,
            motivo_catalogo_id: inexistente
        })).rejects.toThrow();

        const despues = Number((await q('select count(*) c from bitacora_designaciones'))[0].c);
        expect(despues).toBe(antes);
    });
});

describe('publicar_evaluacion — equivalencia con producción y preservación de comportamiento', () => {
    test('la migración 031 del repositorio reproduce EXACTAMENTE (pg_get_functiondef) el texto entregado como referencia real de producción', async () => {
        const dbRef = crearDb();
        await dbRef.exec(ESQUEMA);
        await dbRef.exec(REFERENCIA_PRODUCCION);
        const refDef = (await dbRef.query(`select pg_get_functiondef(${FIRMA_PUBLICAR_EVALUACION}) as def`)).rows[0].def;
        await dbRef.close();

        const db031 = crearDb();
        await db031.exec(ESQUEMA);
        await db031.exec(MIGRACION_031);
        const def031 = (await db031.query(`select pg_get_functiondef(${FIRMA_PUBLICAR_EVALUACION}) as def`)).rows[0].def;
        await db031.close();

        // Comparación de CONTENIDO real (no solo longitud/md5 reportados
        // aparte): el texto que produce la 031 del repositorio, reconstruido
        // por Postgres, es idéntico carácter por carácter al texto entregado
        // como referencia de producción. No se detectó ninguna diferencia
        // funcional — ver informe para la nota sobre la discrepancia de
        // longitud/MD5 reportada aparte (no reproducible con este archivo).
        expect(def031).toBe(refDef);
    });

    test('exclusión correcta de casos anulados en la validación de pendientes y en el descuento de puntaje', async () => {
        const jurado = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Carlos Díaz','B') returning id"))[0].id;
        const rodeoAnulado = (await q("insert into rodeos (club, asociacion, fecha) values ('Club Anulado','Osorno','2026-06-05') returning id"))[0].id;
        await q(
            "insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, nombre_importado, categoria_aplicada, estado) values ($1,$2,'jurado','Carlos Díaz','B','activo') returning id",
            [rodeoAnulado, jurado]
        );
        const evalId = (await q(
            "insert into evaluaciones (rodeo_id, creado_por, estado, puntaje_base) values ($1,$2,'pendiente_aprobacion',80) returning id",
            [rodeoAnulado, ID.admin]
        ))[0].id;
        // Un caso NO resuelto pero ANULADO no debe bloquear la publicación
        // (paso 2), y un caso ANULADO con descuento no debe restarse del
        // puntaje final (paso 3) — ambos exigidos explícitamente por el
        // comportamiento ya vigente en producción (migración 031).
        await q(
            "insert into evaluacion_casos (evaluacion_id, estado, descuento_puntos, resolucion_final, anulado) values ($1,'cargado',2,null,true)",
            [evalId]
        );
        await q(
            "insert into evaluacion_casos (evaluacion_id, estado, descuento_puntos, resolucion_final, anulado) values ($1,'resuelto',1,'interpretativa_confirmada',false)",
            [evalId]
        );

        const resultado = (await q('select publicar_evaluacion($1,$2,$3,$4) as r', [evalId, ID.jefe, null, null]))[0].r;
        expect(resultado.ok).toBe(true);
        // Solo se descuenta el caso NO anulado (1 punto): 80 - 1 = 79 -> 6.9.
        expect(resultado.puntaje_final).toBe(79);
        expect(resultado.nota_final).toBe(6.9);
    });

    test('sobrescritura de una nota manual queda auditada y reportada en el JSONB de resultado, preservando la estructura completa esperada', async () => {
        const jurado = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Marta Ríos','A') returning id"))[0].id;
        const rodeoManual = (await q("insert into rodeos (club, asociacion, fecha) values ('Club Manual','Osorno','2026-06-10') returning id"))[0].id;
        const asigManual = (await q(
            "insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, nombre_importado, categoria_aplicada, estado) values ($1,$2,'jurado','Marta Ríos','A','activo') returning id",
            [rodeoManual, jurado]
        ))[0].id;
        await q("insert into notas_rodeo (asignacion_id, nota, comentario, fuente) values ($1, 5.5, 'nota cargada a mano', 'manual')", [asigManual]);
        const evalId = (await q(
            "insert into evaluaciones (rodeo_id, creado_por, estado, puntaje_base) values ($1,$2,'pendiente_aprobacion',80) returning id",
            [rodeoManual, ID.admin]
        ))[0].id;

        const resultado = (await q('select publicar_evaluacion($1,$2,$3,$4) as r', [evalId, ID.jefe, 'reemplaza nota manual', '10.2.2.2']))[0].r;
        expect(Object.keys(resultado).sort()).toEqual(['jurados_afectados', 'nota_final', 'ok', 'puntaje_final', 'sobreescrituras_nota_manual']);
        expect(resultado.sobreescrituras_nota_manual).toHaveLength(1);
        expect(resultado.sobreescrituras_nota_manual[0]).toMatchObject({
            asignacion_id: asigManual, nota_manual_anterior: 5.5, comentario_anterior: 'nota cargada a mano'
        });

        const auditoria = (await q(
            "select * from evaluacion_auditoria where evaluacion_id = $1 and accion = 'sobreescritura_nota_manual'",
            [evalId]
        ))[0];
        expect(auditoria).toBeDefined();
        expect(auditoria.detalle).toMatchObject({ asignacion_id: asigManual, nota_manual_anterior: 5.5 });

        // La nota queda sobrescrita por la técnica y el snapshot de identidad se puebla igual que en el caso normal.
        const nota = (await q('select * from notas_rodeo where asignacion_id = $1', [asigManual]))[0];
        expect(nota.fuente).toBe('evaluacion_tecnica');
        expect(nota.usuario_pagado_id_evaluado_snapshot).toBe(jurado);
    });
});

describe('notas_rodeo — snapshot de identidad (casos 12-13)', () => {
    test('12) una fila sin especificar las columnas nuevas (equivalente a una fila histórica previa a la migración) queda con snapshot NULL', async () => {
        const otroRodeo = (await q("insert into rodeos (club, asociacion, fecha) values ('Club Histórico','Osorno','2020-01-01') returning id"))[0].id;
        const otraAsig = (await q(
            "insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, estado) values ($1,$2,'jurado','activo') returning id",
            [otroRodeo, ID.j1]
        ))[0].id;
        await db.query(
            "insert into notas_rodeo (asignacion_id, nota, fuente) values ($1, 6.5, 'manual')",
            [otraAsig]
        );
        const fila = (await q('select * from notas_rodeo where asignacion_id = $1', [otraAsig]))[0];
        expect(fila.usuario_pagado_id_evaluado_snapshot).toBeNull();
        expect(fila.nombre_evaluado_snapshot).toBeNull();
    });

    test('13) publicar_evaluacion() puebla el snapshot con la identidad real evaluada, sin romper el resultado existente', async () => {
        const jurado = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Ana Torres','A') returning id"))[0].id;
        const rodeoEval = (await q("insert into rodeos (club, asociacion, fecha) values ('Club Eval','Osorno','2026-06-01') returning id"))[0].id;
        const asigEval = (await q(
            "insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, nombre_importado, categoria_aplicada, estado) values ($1,$2,'jurado','Ana Torres','A','activo') returning id",
            [rodeoEval, jurado]
        ))[0].id;
        const evalId = (await q(
            "insert into evaluaciones (rodeo_id, creado_por, estado, puntaje_base) values ($1,$2,'pendiente_aprobacion',80) returning id",
            [rodeoEval, ID.admin]
        ))[0].id;

        const resultado = (await q('select publicar_evaluacion($1,$2,$3,$4) as r', [evalId, ID.jefe, 'ok', '10.0.0.1']))[0].r;
        expect(Object.keys(resultado).sort()).toEqual(['jurados_afectados', 'nota_final', 'ok', 'puntaje_final', 'sobreescrituras_nota_manual']);
        expect(resultado.ok).toBe(true);
        expect(resultado.jurados_afectados).toBe(1);
        expect(resultado.nota_final).toBe(7);
        expect(resultado.sobreescrituras_nota_manual).toEqual([]);

        const nota = (await q('select * from notas_rodeo where asignacion_id = $1', [asigEval]))[0];
        expect(nota.usuario_pagado_id_evaluado_snapshot).toBe(jurado);
        expect(nota.nombre_evaluado_snapshot).toBe('Ana Torres');
        expect(nota.fuente).toBe('evaluacion_tecnica');

        const ev = (await q('select estado, nota_publicada from evaluaciones where id = $1', [evalId]))[0];
        expect(ev).toMatchObject({ estado: 'publicado', nota_publicada: true });
    });
});
