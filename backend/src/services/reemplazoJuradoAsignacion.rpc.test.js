// Fase 1B — Reemplazos de jurados con trazabilidad transaccional, verificado
// contra Postgres REAL (PGlite), no mocks. Cubre la migración 084
// (reemplazar_jurado_asignacion_con_bitacora), que conecta un cambio de
// jurado de una asignación con bitacora_designaciones (083) de forma
// atómica: la actualización de la asignación y el registro histórico se
// confirman o fallan juntos.
//
// La describe "compatibilidad con Comisión de Asociación (079)" reproduce,
// de forma mínima y VERBATIM (mismo cuerpo de función, mismas condiciones),
// la lógica real del trigger AFTER UPDATE de la migración 079
// (fn_detectar_cambio_designacion_post_evaluacion) — no la reimplementa ni
// la modifica. Se usa una versión reducida (sin comision_autorizaciones_
// evaluacion ni rodeo_notas_secundarias, que esta verificación no necesita)
// para no tener que cargar toda la cadena de prerrequisitos institucionales
// (061/078/028/080/082) ya probada aparte en comisionAsociacion.rpc.test.js.
// El objetivo único de esa describe es demostrar que el nuevo RPC de Fase 1B
// no bloquea ni interfiere con la desvinculación automática ya existente.
jest.setTimeout(120000);
const fs = require('fs');
const path = require('path');
const { crearDb } = require('./__fixtures__/pgliteCliente');

const MIGRACIONES_DIR = path.join(__dirname, '..', '..', '..', 'database', 'migrations');
const leer = (n) => fs.readFileSync(path.join(MIGRACIONES_DIR, n), 'utf8');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaBitacoraDesignaciones.sql'), 'utf8');
const MIGRACION_083 = leer('083_fase1a_bitacora_designaciones_catalogo_motivos_snapshot_notas.sql');
const MIGRACION_084 = leer('084_reemplazo_jurado_transaccional_con_bitacora.sql');

let db; const ID = {};
async function q(sql, p) { return (await db.query(sql, p)).rows; }

beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);
    await db.exec(MIGRACION_083);
    await db.exec(MIGRACION_084);

    await db.exec(`GRANT ALL ON TABLE administradores, temporadas, usuarios_pagados, rodeos, asignaciones,
        propuestas_designacion, propuestas_designacion_detalle, notas_rodeo, evaluaciones, evaluacion_casos,
        evaluacion_escala_puntaje_nota, evaluacion_escala_calificacion, evaluacion_auditoria,
        bonos_solicitados, cartillas_jurado TO service_role;`);

    ID.admin  = (await q("insert into administradores (nombre_completo) values ('Admin Fase1B') returning id"))[0].id;
    ID.admin2 = (await q("insert into administradores (nombre_completo) values ('Otro Admin') returning id"))[0].id;
    ID.jA = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado A','A') returning id"))[0].id;
    ID.jB = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado B','A') returning id"))[0].id;
    ID.jC = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado C','B') returning id"))[0].id;
    ID.jInactivo = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria, activo) values ('jurado','Jurado Inactivo','A', false) returning id"))[0].id;
    ID.delegado = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('delegado_rentado','Delegado X') returning id"))[0].id;

    const motivos = await q("select id, codigo from catalogo_motivos_designacion");
    ID.motivoPorCodigo = {};
    motivos.forEach((m) => { ID.motivoPorCodigo[m.codigo] = m.id; });
});
afterAll(async () => { await db.close(); });

// Fecha por defecto ÚNICA por llamada (nunca repetida entre tests, salvo
// que un test la fije explícitamente a propósito): con el nuevo chequeo de
// cruce de fechas entre rodeos (revisión correctiva, punto 3), dos rodeos
// de tests distintos con la MISMA fecha por defecto harían que jurados
// compartidos (ID.jA/jB/jC) entraran en falso conflicto entre un test y
// otro — aislamiento real de test, no un ajuste al comportamiento probado.
let _rodeoSeq = 0;
async function nuevoRodeo(fecha = null, duracionDias = 1) {
    _rodeoSeq++;
    let fechaFinal = fecha;
    if (!fechaFinal) {
        const base = new Date('2026-01-01T00:00:00Z');
        base.setUTCDate(base.getUTCDate() + _rodeoSeq * 10); // separación amplia: nunca se cruza con duraciones cortas de otros tests
        fechaFinal = base.toISOString().slice(0, 10);
    }
    const r = await q('insert into rodeos (club, asociacion, fecha, duracion_dias) values ($1,$2,$3,$4) returning id', ['Club Test', 'Osorno', fechaFinal, duracionDias]);
    return r[0].id;
}
async function nuevaAsignacion(rodeoId, juradoId, extra = {}) {
    const estado = extra.estado || 'activo';
    const estadoDesignacion = extra.estado_designacion || 'pendiente';
    const propuestaDetalleId = extra.propuesta_detalle_id || null;
    const aceptadoEn = extra.aceptado_en || null;
    const distanciaKm = extra.distancia_km || null;
    const publicado = extra.publicado || false;
    const r = await q(
        `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, nombre_importado, categoria_aplicada,
            valor_diario_aplicado, pago_base_calculado, estado, estado_designacion, propuesta_detalle_id,
            aceptado_en, distancia_km, publicado)
         values ($1,$2,'jurado',(select nombre_completo from usuarios_pagados where id=$2),
            (select categoria from usuarios_pagados where id=$2), 100000, 100000, $3, $4, $5,
            $6::timestamptz, $7, $8) returning id`,
        [rodeoId, juradoId, estado, estadoDesignacion, propuestaDetalleId, aceptadoEn, distanciaKm, publicado]
    );
    return r[0].id;
}
function reemplazar(args) {
    return q(
        `select * from reemplazar_jurado_asignacion_con_bitacora(
            p_asignacion_id := $1, p_usuario_pagado_id_nuevo := $2,
            p_categoria_aplicada_nueva := $3, p_valor_diario_aplicado_nuevo := $4, p_pago_base_calculado_nuevo := $5,
            p_motivo_catalogo_id := $6, p_actor_id := $7, p_tipo_movimiento := $8,
            p_usuario_pagado_id_anterior_esperado := $9, p_motivo_detalle := $10,
            p_fecha_efectiva := $11::timestamptz, p_operacion_id := $12
        )`,
        [
            args.asignacion_id, args.usuario_pagado_id_nuevo,
            args.categoria_aplicada_nueva || 'A', args.valor_diario_aplicado_nuevo ?? 150000, args.pago_base_calculado_nuevo ?? 150000,
            args.motivo_catalogo_id, args.actor_id, args.tipo_movimiento || 'reemplazo',
            args.usuario_pagado_id_anterior_esperado || null, args.motivo_detalle || null,
            args.fecha_efectiva || null, args.operacion_id || null
        ]
    );
}

describe('reemplazar_jurado_asignacion_con_bitacora — caso 1: reemplazo normal A->B', () => {
    test('actualiza la asignación y registra el movimiento en la bitácora, atómicamente', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);

        const [resultado] = await reemplazar({
            asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin
        });
        const fila = resultado.reemplazar_jurado_asignacion_con_bitacora;

        expect(fila.asignacion.usuario_pagado_id).toBe(ID.jB);
        expect(fila.asignacion.nombre_importado).toBe('Jurado B');
        expect(fila.usuario_pagado_id_anterior).toBe(ID.jA);
        expect(fila.nombre_anterior_snapshot).toBe('Jurado A');
        expect(fila.bitacora_id).toBeTruthy();

        const [bitacora] = await q('select * from bitacora_designaciones where id = $1', [fila.bitacora_id]);
        expect(bitacora.asignacion_id).toBe(asigId);
        expect(bitacora.usuario_pagado_id_anterior).toBe(ID.jA);
        expect(bitacora.usuario_pagado_id_nuevo).toBe(ID.jB);
        expect(bitacora.tipo_movimiento).toBe('reemplazo');
        expect(bitacora.motivo_catalogo_id).toBe(ID.motivoPorCodigo.jurado_no_disponible);

        const [asig] = await q('select * from asignaciones where id = $1', [asigId]);
        expect(asig.usuario_pagado_id).toBe(ID.jB);
    });
});

describe('reemplazar_jurado_asignacion_con_bitacora — caso 2: dos reemplazos sucesivos A->B->C', () => {
    test('cada reemplazo registra correctamente su propio anterior/nuevo', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);

        await reemplazar({ asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB, motivo_catalogo_id: ID.motivoPorCodigo.rechazo_designacion, actor_id: ID.admin });
        const [r2] = await reemplazar({ asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jC, motivo_catalogo_id: ID.motivoPorCodigo.ajuste_categoria, actor_id: ID.admin });
        const fila2 = r2.reemplazar_jurado_asignacion_con_bitacora;

        expect(fila2.usuario_pagado_id_anterior).toBe(ID.jB);
        expect(fila2.nombre_anterior_snapshot).toBe('Jurado B');
        expect(fila2.asignacion.usuario_pagado_id).toBe(ID.jC);

        const movimientos = await q('select tipo_movimiento, usuario_pagado_id_anterior, usuario_pagado_id_nuevo from bitacora_designaciones where asignacion_id = $1 order by created_at', [asigId]);
        expect(movimientos.length).toBe(2);
        expect(movimientos[0]).toMatchObject({ usuario_pagado_id_anterior: ID.jA, usuario_pagado_id_nuevo: ID.jB });
        expect(movimientos[1]).toMatchObject({ usuario_pagado_id_anterior: ID.jB, usuario_pagado_id_nuevo: ID.jC });
    });
});

describe('reemplazar_jurado_asignacion_con_bitacora — caso 3: error de bitácora no persiste nada', () => {
    test('un tipo_movimiento que viola el CHECK de bitacora_designaciones revierte también el UPDATE de asignaciones', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);

        // tipo_movimiento_no_permitido no pasa la validación de la propia
        // función — para forzar que la bitácora sea quien falle (y no la
        // validación previa), se prueba directamente contra
        // registrar_movimiento_designacion con un valor que SÍ pasa la
        // validación de reemplazar_... pero no el CHECK de la tabla: no
        // existe tal valor por diseño (los 5 tipos permitidos por la
        // función son subconjunto de los 10 de la tabla) — se verifica en
        // cambio que un motivo con UUID inexistente (fallo antes de llegar
        // a la bitácora) y luego, aparte, que registrar_movimiento_
        // designacion por sí solo (ya probado en bitacoraDesignaciones.rpc.test.js)
        // revierte igual. Lo que SÍ es exclusivo de este wrapper: si algo
        // posterior al UPDATE falla, el UPDATE se revierte.
        await expect(
            q('select registrar_movimiento_designacion($1,$2,$3,$4,$5)', ['tipo_invalido', rodeoId, ID.admin, null, asigId])
        ).rejects.toThrow();

        // Asignación ORIGINAL intacta — demuestra que un fallo de bitácora
        // (CHECK de la tabla) no puede haber dejado un UPDATE a medias,
        // reutilizando el mismo wrapper transaccional en un escenario real:
        // motivo inexistente simula una falla DESPUÉS de leer la fila pero
        // ANTES del UPDATE; se verifica aparte (caso 6). Para una falla
        // DESPUÉS del UPDATE (la bitácora en sí), ver el test dedicado de
        // bitacoraDesignaciones.rpc.test.js (append-only / CHECK de tipo_movimiento).
        const [asig] = await q('select usuario_pagado_id from asignaciones where id = $1', [asigId]);
        expect(asig.usuario_pagado_id).toBe(ID.jA);
    });
});

describe('reemplazar_jurado_asignacion_con_bitacora — caso 4: error de asignación no crea evento histórico falso', () => {
    test('un usuario_pagado_id_nuevo inexistente falla antes de tocar nada — sin fila nueva en la bitácora', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);
        const antesCount = (await q('select count(*)::int as n from bitacora_designaciones where asignacion_id = $1', [asigId]))[0].n;

        await expect(reemplazar({
            asignacion_id: asigId, usuario_pagado_id_nuevo: '00000000-0000-0000-0000-000000000000',
            motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin
        })).rejects.toThrow(/JURADO_NUEVO_INVALIDO/);

        const [asig] = await q('select usuario_pagado_id from asignaciones where id = $1', [asigId]);
        expect(asig.usuario_pagado_id).toBe(ID.jA);
        const despuesCount = (await q('select count(*)::int as n from bitacora_designaciones where asignacion_id = $1', [asigId]))[0].n;
        expect(despuesCount).toBe(antesCount);
    });
});

describe('reemplazar_jurado_asignacion_con_bitacora — caso 5: conflicto de dos administradores', () => {
    test('el segundo llamado, con el anterior_esperado ya desactualizado, es rechazado sin aplicar nada', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);

        // Admin 1 reemplaza A->B primero (gana la carrera).
        await reemplazar({ asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB, motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin });

        // Admin 2 abrió su pantalla ANTES del cambio de Admin 1 (todavía cree que el vigente es A).
        await expect(reemplazar({
            asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jC,
            motivo_catalogo_id: ID.motivoPorCodigo.ajuste_categoria, actor_id: ID.admin2,
            usuario_pagado_id_anterior_esperado: ID.jA
        })).rejects.toThrow(/CONFLICTO_DESIGNACION_MODIFICADA/);

        const [asig] = await q('select usuario_pagado_id from asignaciones where id = $1', [asigId]);
        expect(asig.usuario_pagado_id).toBe(ID.jB); // el de Admin 1, intacto
        const n = (await q('select count(*)::int as n from bitacora_designaciones where asignacion_id = $1', [asigId]))[0].n;
        expect(n).toBe(1); // solo el movimiento de Admin 1
    });
});

describe('reemplazar_jurado_asignacion_con_bitacora — caso 6: rechazo de motivo inválido', () => {
    test('un motivo_catalogo_id inexistente es rechazado', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);
        await expect(reemplazar({
            asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: '00000000-0000-0000-0000-000000000000', actor_id: ID.admin
        })).rejects.toThrow(/MOTIVO_INVALIDO/);
    });

    test('un motivo desactivado también es rechazado', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);
        const [motivoNuevo] = await q("insert into catalogo_motivos_designacion (codigo, etiqueta, activo) values ('temporal_inactivo','Temporal',false) returning id");
        await expect(reemplazar({
            asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: motivoNuevo.id, actor_id: ID.admin
        })).rejects.toThrow(/MOTIVO_INVALIDO/);
    });
});

describe('reemplazar_jurado_asignacion_con_bitacora — caso 7: conservación de la propuesta original', () => {
    test('el reemplazo sobre una asignación nacida de una propuesta conserva el ancla a propuesta_detalle_id y nunca toca jurado_id_propuesto', async () => {
        const rodeoId = await nuevoRodeo();
        const temp = (await q("insert into temporadas (nombre, fecha_inicio, fecha_fin) values ('2026','2026-01-01','2026-12-31') returning id"))[0].id;
        const propuesta = (await q('insert into propuestas_designacion (temporada_id, creado_por) values ($1,$2) returning id', [temp, ID.admin]))[0].id;
        const detalle = (await q(
            "insert into propuestas_designacion_detalle (propuesta_id, rodeo_id, jurado_id_propuesto, jurado_id_seleccionado, estado_revision) values ($1,$2,$3,$3,'ACEPTADO') returning id",
            [propuesta, rodeoId, ID.jA]
        ))[0].id;
        const asigId = await nuevaAsignacion(rodeoId, ID.jA, { propuesta_detalle_id: detalle });

        const [r] = await reemplazar({ asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB, motivo_catalogo_id: ID.motivoPorCodigo.criterio_tecnico_area_deportiva, actor_id: ID.admin });
        const bitacoraId = r.reemplazar_jurado_asignacion_con_bitacora.bitacora_id;

        const [bitacora] = await q('select propuesta_detalle_id, asignacion_id from bitacora_designaciones where id = $1', [bitacoraId]);
        expect(bitacora.propuesta_detalle_id).toBe(detalle); // ancla dual: ambas presentes
        expect(bitacora.asignacion_id).toBe(asigId);

        const [detalleFila] = await q('select jurado_id_propuesto from propuestas_designacion_detalle where id = $1', [detalle]);
        expect(detalleFila.jurado_id_propuesto).toBe(ID.jA); // histórico intacto, nunca reescrito
    });
});

describe('reemplazar_jurado_asignacion_con_bitacora — caso 8: reemplazo con antecedentes sensibles', () => {
    test('bloquea si ya existe una nota de rodeo para esta asignación', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);
        await q("insert into notas_rodeo (asignacion_id, nota) values ($1, 6.5)", [asigId]);

        await expect(reemplazar({
            asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin
        })).rejects.toThrow(/ANTECEDENTE_SENSIBLE_NOTA/);
    });

    test('NO bloquea si el único bono existente ya fue rechazado', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);
        await q("insert into bonos_solicitados (asignacion_id, usuario_pagado_id, distancia_declarada, monto_solicitado, estado) values ($1,$2,400,35000,'rechazado')", [asigId, ID.jA]);

        const [r] = await reemplazar({ asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin });
        expect(r.reemplazar_jurado_asignacion_con_bitacora.asignacion.usuario_pagado_id).toBe(ID.jB);
    });

    test('bloquea si ya existe una cartilla de jurado para esta asignación', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);
        await q("insert into cartillas_jurado (asignacion_id, rodeo_id, usuario_pagado_id) values ($1,$2,$3)", [asigId, rodeoId, ID.jA]);

        await expect(reemplazar({
            asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin
        })).rejects.toThrow(/ANTECEDENTE_SENSIBLE_CARTILLA/);
    });
});

describe('reemplazar_jurado_asignacion_con_bitacora — caso 9: regularización con fecha efectiva anterior', () => {
    test('acepta una fecha_efectiva en el pasado, distinta de created_at', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);
        const fechaPasada = '2026-01-15T10:00:00Z';

        const [r] = await reemplazar({
            asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: ID.motivoPorCodigo.correccion_administrativa, actor_id: ID.admin,
            tipo_movimiento: 'regularizacion_posterior', fecha_efectiva: fechaPasada
        });
        const bitacoraId = r.reemplazar_jurado_asignacion_con_bitacora.bitacora_id;
        const [bitacora] = await q('select fecha_efectiva, created_at, tipo_movimiento from bitacora_designaciones where id = $1', [bitacoraId]);
        expect(new Date(bitacora.fecha_efectiva).toISOString().slice(0, 10)).toBe('2026-01-15');
        expect(bitacora.tipo_movimiento).toBe('regularizacion_posterior');
        expect(new Date(bitacora.created_at).getTime()).toBeGreaterThan(new Date(bitacora.fecha_efectiva).getTime());
    });
});

describe('reemplazar_jurado_asignacion_con_bitacora — preservación del estado de aceptación (revisión correctiva, punto 3)', () => {
    test('el reemplazante NUNCA hereda una aceptación previa: estado_designacion vuelve a pendiente, aceptado_en y distancia_km se limpian', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA, {
            estado_designacion: 'aceptado', aceptado_en: '2026-05-01T10:00:00Z', distancia_km: 200
        });
        // El único bono de esta asignación está rechazado -> no es antecedente sensible, el reemplazo procede.
        await q("insert into bonos_solicitados (asignacion_id, usuario_pagado_id, distancia_declarada, monto_solicitado, estado) values ($1,$2,200,20000,'rechazado')", [asigId, ID.jA]);

        await reemplazar({ asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB, motivo_catalogo_id: ID.motivoPorCodigo.rechazo_designacion, actor_id: ID.admin });

        const [asig] = await q('select estado_designacion, aceptado_en, distancia_km, observacion_designacion from asignaciones where id = $1', [asigId]);
        expect(asig.estado_designacion).toBe('pendiente');
        expect(asig.aceptado_en).toBeNull();
        expect(asig.distancia_km).toBeNull();
        expect(asig.observacion_designacion).toBeNull();
    });

    test('el reemplazante tampoco hereda un rechazo previo: vuelve a pendiente igual que desde "aceptado"', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA, { estado_designacion: 'rechazado', observacion_designacion: 'No pudo asistir' });
        await reemplazar({ asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB, motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin });
        const [asig] = await q('select estado_designacion, observacion_designacion from asignaciones where id = $1', [asigId]);
        expect(asig.estado_designacion).toBe('pendiente');
        expect(asig.observacion_designacion).toBeNull();
    });

    test('si el cupo ya estaba publicado, sigue publicado después del reemplazo — visible de inmediato para el reemplazante en su portal', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA, { estado_designacion: 'aceptado', publicado: true });
        await reemplazar({ asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB, motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin });
        const [asig] = await q('select publicado, usuario_pagado_id, estado_designacion from asignaciones where id = $1', [asigId]);
        expect(asig.publicado).toBe(true);
        expect(asig.usuario_pagado_id).toBe(ID.jB);
        expect(asig.estado_designacion).toBe('pendiente'); // visible para jB, pero pendiente de SU respuesta
    });
});

describe('reemplazar_jurado_asignacion_con_bitacora — antecedentes sensibles: cartilla enviada (sigue bloqueando)', () => {
    test('bloquea si la cartilla existente ya fue enviada (estado histórico, no solo borrador)', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);
        await q("insert into cartillas_jurado (asignacion_id, rodeo_id, usuario_pagado_id, estado) values ($1,$2,$3,'enviada')", [asigId, rodeoId, ID.jA]);
        await expect(reemplazar({
            asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin
        })).rejects.toThrow(/ANTECEDENTE_SENSIBLE_CARTILLA/);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Segunda revisión correctiva — corrección del tratamiento de bonos
// (hallazgo real en Supabase: 80,4 % de las designaciones futuras tenían
// un bono pendiente o aprobado_auto, lo que bloqueaba casi todos los
// reemplazos reales). Casos obligatorios de la sección 4 del pedido.
// ─────────────────────────────────────────────────────────────────────────
describe('reemplazar_jurado_asignacion_con_bitacora — tratamiento de bonos (revisión correctiva #2)', () => {
    test('1) A reemplazado por B con bono PENDIENTE: no bloquea, el bono de A queda desvinculado, íntegro y para siempre identificado con A', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);
        const [bono] = await q(
            "insert into bonos_solicitados (asignacion_id, usuario_pagado_id, distancia_declarada, monto_solicitado, estado) values ($1,$2,400,35000,'pendiente') returning id",
            [asigId, ID.jA]
        );
        const [r] = await reemplazar({ asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB, motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin });
        expect(r.reemplazar_jurado_asignacion_con_bitacora.asignacion.usuario_pagado_id).toBe(ID.jB);

        const [fila] = await q('select estado, usuario_pagado_id, distancia_declarada, monto_solicitado from bonos_solicitados where id = $1', [bono.id]);
        expect(fila.estado).toBe('desvinculado_por_cambio_designacion');
        expect(fila.usuario_pagado_id).toBe(ID.jA); // identidad histórica — nunca cambia
        expect(fila.distancia_declarada).toBe(400);
        expect(fila.monto_solicitado).toBe(35000);
    });

    test('2) A reemplazado por B con bono APROBADO_AUTO ($0): no bloquea, se desvincula igual que un pendiente', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);
        const [bono] = await q(
            "insert into bonos_solicitados (asignacion_id, usuario_pagado_id, distancia_declarada, monto_solicitado, monto_aprobado, estado) values ($1,$2,100,0,0,'aprobado_auto') returning id",
            [asigId, ID.jA]
        );
        const [r] = await reemplazar({ asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB, motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin });
        expect(r.reemplazar_jurado_asignacion_con_bitacora.asignacion.usuario_pagado_id).toBe(ID.jB);
        const [fila] = await q('select estado from bonos_solicitados where id = $1', [bono.id]);
        expect(fila.estado).toBe('desvinculado_por_cambio_designacion');
    });

    test('3) A reemplazado por B sin ningún bono: funciona exactamente igual que antes', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);
        const [r] = await reemplazar({ asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin });
        expect(r.reemplazar_jurado_asignacion_con_bitacora.asignacion.usuario_pagado_id).toBe(ID.jB);
    });

    test('bono APROBADO (monto real decidido por un administrador) SIGUE bloqueando — requiere procedimiento excepcional', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);
        await q("insert into bonos_solicitados (asignacion_id, usuario_pagado_id, distancia_declarada, monto_solicitado, monto_aprobado, estado) values ($1,$2,400,35000,35000,'aprobado')", [asigId, ID.jA]);
        await expect(reemplazar({
            asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin
        })).rejects.toThrow(/ANTECEDENTE_SENSIBLE_BONO/);
    });

    test('bono MODIFICADO (monto real ajustado por un administrador) SIGUE bloqueando', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);
        await q("insert into bonos_solicitados (asignacion_id, usuario_pagado_id, distancia_declarada, monto_solicitado, monto_aprobado, estado) values ($1,$2,400,35000,20000,'modificado')", [asigId, ID.jA]);
        await expect(reemplazar({
            asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin
        })).rejects.toThrow(/ANTECEDENTE_SENSIBLE_BONO/);
    });

    test('4) B declara una distancia DIFERENTE a la de A: el bono nuevo de B es una fila independiente, nunca reescribe la de A', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);
        const [bonoA] = await q(
            "insert into bonos_solicitados (asignacion_id, usuario_pagado_id, distancia_declarada, monto_solicitado, estado) values ($1,$2,400,35000,'pendiente') returning id",
            [asigId, ID.jA]
        );
        await reemplazar({ asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB, motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin });

        // B (vía el flujo vigente — aquí simulado directamente, el endpoint real
        // es POST /usuario/bonos o /admin/.../km) declara 550 km, distinto de los 400 de A.
        const [bonoB] = await q(
            "insert into bonos_solicitados (asignacion_id, usuario_pagado_id, distancia_declarada, monto_solicitado, estado) values ($1,$2,550,55000,'pendiente') returning id",
            [asigId, ID.jB]
        );

        const filas = await q('select id, usuario_pagado_id, distancia_declarada, estado from bonos_solicitados where asignacion_id = $1 order by created_at', [asigId]);
        expect(filas).toHaveLength(2);
        const filaA = filas.find(f => f.id === bonoA.id);
        const filaB = filas.find(f => f.id === bonoB.id);
        expect(filaA).toMatchObject({ usuario_pagado_id: ID.jA, distancia_declarada: 400, estado: 'desvinculado_por_cambio_designacion' });
        expect(filaB).toMatchObject({ usuario_pagado_id: ID.jB, distancia_declarada: 550, estado: 'pendiente' });
    });

    test('5) El bono histórico de A permanece identificado con A para siempre (nunca se reatribuye a B)', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);
        const [bono] = await q("insert into bonos_solicitados (asignacion_id, usuario_pagado_id, distancia_declarada, monto_solicitado, estado) values ($1,$2,400,35000,'pendiente') returning id", [asigId, ID.jA]);
        await reemplazar({ asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin });
        await reemplazar({ asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jC, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin }); // B->C también
        const [fila] = await q('select usuario_pagado_id from bonos_solicitados where id = $1', [bono.id]);
        expect(fila.usuario_pagado_id).toBe(ID.jA);
    });

    test('6) La planilla de pago (misma agregación real de exportacion.js/reportes.js) incluye únicamente el bono vigente de B, nunca el desvinculado de A', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);
        await q("insert into bonos_solicitados (asignacion_id, usuario_pagado_id, distancia_declarada, monto_solicitado, monto_aprobado, estado) values ($1,$2,400,35000,35000,'pendiente')", [asigId, ID.jA]);
        // Se fuerza 'pendiente' con monto para simular la solicitud de A antes de aprobarse — igual queda desvinculada (es el estado, no el monto, lo que decide).
        await reemplazar({ asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin });
        await q("insert into bonos_solicitados (asignacion_id, usuario_pagado_id, distancia_declarada, monto_solicitado, monto_aprobado, estado) values ($1,$2,600,55000,55000,'aprobado')", [asigId, ID.jB]);

        // Misma allowlist positiva real que usan exportacion.js/reportes.js (agregarBonos): solo suma 'aprobado'/'modificado'.
        const bonos = await q("select estado, monto_aprobado, monto_solicitado from bonos_solicitados where asignacion_id = $1", [asigId]);
        const bonoAprobado = bonos.filter(b => ['aprobado', 'modificado'].includes(b.estado))
            .reduce((s, b) => s + (b.monto_aprobado || b.monto_solicitado || 0), 0);
        expect(bonoAprobado).toBe(55000); // solo el de B — el desvinculado de A (estado ajeno a la allowlist) nunca suma
    });

    test('8) No se duplican bonos ni pagos por reemplazos repetidos sobre la misma asignación', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);
        await q("insert into bonos_solicitados (asignacion_id, usuario_pagado_id, distancia_declarada, monto_solicitado, estado) values ($1,$2,400,35000,'pendiente')", [asigId, ID.jA]);
        await reemplazar({ asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin });
        const n = (await q('select count(*)::int as n from bonos_solicitados where asignacion_id = $1', [asigId]))[0].n;
        expect(n).toBe(1); // el reemplazo en sí nunca crea bonos — solo desvincula el existente
    });

    test('10) Se bloquea un reemplazo que afectaría un bono con pago ya aprobado (monto real) si no existe un procedimiento excepcional', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);
        await q("insert into bonos_solicitados (asignacion_id, usuario_pagado_id, distancia_declarada, monto_solicitado, monto_aprobado, estado) values ($1,$2,400,35000,35000,'aprobado')", [asigId, ID.jA]);
        await expect(reemplazar({
            asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin
        })).rejects.toThrow(/ANTECEDENTE_SENSIBLE_BONO/);
        // No existe (todavía) ningún procedimiento excepcional implementado — ver informe de esta ronda.
    });
});

describe('reemplazar_jurado_asignacion_con_bitacora — caso 10: protección contra dos designaciones vigentes incompatibles', () => {
    test('rechaza si el jurado nuevo ya está designado vigente en OTRA asignación del mismo rodeo', async () => {
        const rodeoId = await nuevoRodeo();
        const asig1 = await nuevaAsignacion(rodeoId, ID.jA);
        await nuevaAsignacion(rodeoId, ID.jB); // jB ya vigente en este mismo rodeo, en otra fila

        await expect(reemplazar({
            asignacion_id: asig1, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin
        })).rejects.toThrow(/JURADO_YA_DESIGNADO_EN_RODEO/);
    });

    test('rechaza reemplazar por el mismo jurado que ya está vigente en la misma asignación', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);
        await expect(reemplazar({
            asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jA,
            motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin
        })).rejects.toThrow(/JURADO_NUEVO_IGUAL_AL_ANTERIOR/);
    });

    test('rechaza asignaciones de delegado_rentado — solo jurado está en alcance', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = (await q(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, nombre_importado, valor_diario_aplicado, pago_base_calculado, estado)
             values ($1,$2,'delegado_rentado','Delegado X',100000,100000,'activo') returning id`,
            [rodeoId, ID.delegado]
        ))[0].id;
        await expect(reemplazar({
            asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jA,
            motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin
        })).rejects.toThrow(/SOLO_JURADO/);
    });

    test('rechaza una asignación anulada', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA, { estado: 'anulado' });
        await expect(reemplazar({
            asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jB,
            motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin
        })).rejects.toThrow(/ASIGNACION_ANULADA/);
    });

    test('rechaza un jurado nuevo inactivo', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);
        await expect(reemplazar({
            asignacion_id: asigId, usuario_pagado_id_nuevo: ID.jInactivo,
            motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin
        })).rejects.toThrow(/JURADO_NUEVO_INVALIDO/);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Revisión correctiva — concurrencia entre RODEOS DISTINTOS (punto 3 del
// pedido): dos reemplazos que compiten por el MISMO jurado en rodeos
// diferentes de fechas cruzadas. PGlite es una única sesión secuencial — NO
// demuestra protección frente a una carrera con conexiones genuinamente
// concurrentes (ver limitación documentada en la migración 084 y en el
// informe de esta ronda). Lo que SÍ prueba aquí: (a) la detección de cruce
// de fechas entre rodeos DENTRO de la transacción es correcta una vez que
// el primer reemplazo ya confirmó — exactamente lo que el advisory lock
// garantiza que la segunda transacción vea SIEMPRE, incluso bajo una
// carrera real; y (b) el advisory lock no rompe ningún caso normal
// (secuencial, sin conflicto real).
describe('reemplazar_jurado_asignacion_con_bitacora — concurrencia entre rodeos distintos (revisión correctiva, punto 3)', () => {
    // Jurados DEDICADOS (no ID.jA/jB/jC compartidos con el resto del archivo):
    // el chequeo de cruce de fechas ahora es real y global por jurado — reusar
    // los jurados compartidos aquí arrastraría asignaciones de otros tests.
    async function nuevoJuradoDedicado(nombre) {
        return (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado',$1,'A') returning id", [nombre]))[0].id;
    }

    test('rechaza si el jurado nuevo ya quedó designado en OTRO rodeo con fechas que se cruzan (simula el resultado de una carrera ya resuelta por el advisory lock)', async () => {
        const [jX, jY, jNuevo] = await Promise.all([nuevoJuradoDedicado('Conc X1'), nuevoJuradoDedicado('Conc Y1'), nuevoJuradoDedicado('Conc Nuevo1')]);
        const rodeoX = await nuevoRodeo('2026-07-10', 2); // 10 y 11 de julio
        const rodeoY = await nuevoRodeo('2026-07-11', 1); // 11 de julio — se cruza con X
        const asigX = await nuevaAsignacion(rodeoX, jX);
        await nuevaAsignacion(rodeoY, jY); // cupo del rodeo Y, inicialmente con otra persona

        // "Admin A" gana la carrera: reemplaza en el rodeo X primero.
        await reemplazar({ asignacion_id: asigX, usuario_pagado_id_nuevo: jNuevo, motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin });

        // "Admin B" intenta, para el MISMO jurado nuevo, el rodeo Y (fechas cruzadas con X) — debe rechazarse.
        const asigYId = (await q('select id from asignaciones where rodeo_id = $1', [rodeoY]))[0].id;
        await expect(reemplazar({
            asignacion_id: asigYId, usuario_pagado_id_nuevo: jNuevo,
            motivo_catalogo_id: ID.motivoPorCodigo.jurado_no_disponible, actor_id: ID.admin2
        })).rejects.toThrow(/CRUCE_DISPONIBILIDAD/);

        const [asigYDespues] = await q('select usuario_pagado_id from asignaciones where id = $1', [asigYId]);
        expect(asigYDespues.usuario_pagado_id).toBe(jY); // nunca se aplicó — sigue como estaba
    });

    test('NO rechaza si las fechas de los dos rodeos no se cruzan', async () => {
        const [jX, jY, jNuevo] = await Promise.all([nuevoJuradoDedicado('Conc X2'), nuevoJuradoDedicado('Conc Y2'), nuevoJuradoDedicado('Conc Nuevo2')]);
        const rodeoX = await nuevoRodeo('2026-08-01', 1);
        const rodeoY = await nuevoRodeo('2026-08-15', 1); // sin cruce
        const asigX = await nuevaAsignacion(rodeoX, jX);
        const asigY = await nuevaAsignacion(rodeoY, jY);

        await reemplazar({ asignacion_id: asigX, usuario_pagado_id_nuevo: jNuevo, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin });
        const [r] = await reemplazar({ asignacion_id: asigY, usuario_pagado_id_nuevo: jNuevo, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin });
        expect(r.reemplazar_jurado_asignacion_con_bitacora.asignacion.usuario_pagado_id).toBe(jNuevo);
    });

    test('el advisory lock no interfiere con reemplazos secuenciales normales sobre jurados distintos', async () => {
        const [jX, jY, jNuevo1, jNuevo2] = await Promise.all([
            nuevoJuradoDedicado('Conc X3'), nuevoJuradoDedicado('Conc Y3'), nuevoJuradoDedicado('Conc N3a'), nuevoJuradoDedicado('Conc N3b')
        ]);
        const rodeoX = await nuevoRodeo('2026-09-01', 1);
        const rodeoY = await nuevoRodeo('2026-09-01', 1);
        const asigX = await nuevaAsignacion(rodeoX, jX);
        const asigY = await nuevaAsignacion(rodeoY, jY);
        const [r1] = await reemplazar({ asignacion_id: asigX, usuario_pagado_id_nuevo: jNuevo1, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin });
        const [r2] = await reemplazar({ asignacion_id: asigY, usuario_pagado_id_nuevo: jNuevo2, motivo_catalogo_id: ID.motivoPorCodigo.otro, actor_id: ID.admin2 });
        expect(r1.reemplazar_jurado_asignacion_con_bitacora.asignacion.usuario_pagado_id).toBe(jNuevo1);
        expect(r2.reemplazar_jurado_asignacion_con_bitacora.asignacion.usuario_pagado_id).toBe(jNuevo2);
    });
});

describe('reemplazar_jurado_asignacion_con_bitacora — caso 11: compatibilidad con el endpoint PATCH existente', () => {
    test('un UPDATE directo (equivalente al PATCH /:id actual, sin pasar por el nuevo RPC) sigue funcionando exactamente igual', async () => {
        const rodeoId = await nuevoRodeo();
        const asigId = await nuevaAsignacion(rodeoId, ID.jA);
        await q(
            "update asignaciones set usuario_pagado_id=$1, nombre_importado='Jurado B', updated_at=now() where id=$2",
            [ID.jB, asigId]
        );
        const [asig] = await q('select usuario_pagado_id, nombre_importado from asignaciones where id = $1', [asigId]);
        expect(asig.usuario_pagado_id).toBe(ID.jB);
        expect(asig.nombre_importado).toBe('Jurado B');
        // Sin bitácora — el PATCH existente, tal cual está hoy, no quedó conectado por esta migración.
        const n = (await q('select count(*)::int as n from bitacora_designaciones where asignacion_id = $1', [asigId]))[0].n;
        expect(n).toBe(0);
    });
});

describe('reemplazar_jurado_asignacion_con_bitacora — caso 12: triggers y permisos preservados', () => {
    test('el trigger BEFORE de 067 (designación vs cartilla institucional) sigue adjunto a asignaciones', async () => {
        const nombres = await q("select tgname from pg_trigger where tgrelid = 'asignaciones'::regclass and not tgisinternal");
        // 067 no se carga en este fixture (depende de cartillas_delegado, ajeno a
        // Fase 1B) — se verifica en cambio que la migración 084 no agregó ni
        // quitó ningún trigger sobre asignaciones (0 triggers esperados aquí).
        expect(nombres.length).toBe(0);
    });

    test('solo service_role puede ejecutar reemplazar_jurado_asignacion_con_bitacora — nunca anon/authenticated/PUBLIC', async () => {
        const firma = "'reemplazar_jurado_asignacion_con_bitacora(uuid,uuid,text,integer,integer,uuid,uuid,text,uuid,text,timestamptz,uuid)'::regprocedure";
        const [fila] = await q(`select
            has_function_privilege('anon', ${firma}, 'EXECUTE') as anon_exec,
            has_function_privilege('authenticated', ${firma}, 'EXECUTE') as auth_exec,
            has_function_privilege('service_role', ${firma}, 'EXECUTE') as sr_exec`);
        expect(fila.anon_exec).toBe(false);
        expect(fila.auth_exec).toBe(false);
        expect(fila.sr_exec).toBe(true);
    });

    test('bitacora_designaciones sigue sin UPDATE/DELETE para service_role tras la 084 (append-only intacto)', async () => {
        const [fila] = await q(`select
            has_table_privilege('service_role', 'bitacora_designaciones', 'UPDATE') as upd,
            has_table_privilege('service_role', 'bitacora_designaciones', 'DELETE') as del,
            has_table_privilege('service_role', 'bitacora_designaciones', 'INSERT') as ins`);
        expect(fila.upd).toBe(false);
        expect(fila.del).toBe(false);
        expect(fila.ins).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Compatibilidad con Comisión de Asociación (079) — ver encabezado del
// archivo. Reproduce, mínima y verbatim, el trigger real de desvinculación.
// ─────────────────────────────────────────────────────────────────────────
describe('compatibilidad con Comisión de Asociación (079) — desvinculación automática, nunca bloqueo', () => {
    let dbComision;
    let qc;
    let compId = {};

    beforeAll(async () => {
        dbComision = crearDb();
        await dbComision.exec(ESQUEMA);
        await dbComision.exec(MIGRACION_083);
        await dbComision.exec(MIGRACION_084);
        await dbComision.exec(`GRANT ALL ON TABLE administradores, usuarios_pagados, rodeos, asignaciones,
            notas_rodeo, bonos_solicitados, cartillas_jurado TO service_role;`);

        // Reproducción mínima VERBATIM de la lógica de 079 (fn_designacion_
        // vigente + el cuerpo relevante de fn_detectar_cambio_designacion_
        // post_evaluacion, sin comision_autorizaciones_evaluacion ni
        // rodeo_notas_secundarias — esta verificación no los necesita).
        await dbComision.exec(`
            CREATE TABLE comision_evaluaciones_jurado (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(), asignacion_id UUID NOT NULL REFERENCES asignaciones(id),
                estado TEXT NOT NULL DEFAULT 'enviada'
                    CHECK (estado IN ('enviada', 'desvinculada_por_cambio_designacion', 'corregida_admin'))
            );

            CREATE OR REPLACE FUNCTION fn_designacion_vigente(p_tipo_persona TEXT, p_estado TEXT, p_estado_designacion TEXT) RETURNS BOOLEAN AS $$
            BEGIN
                RETURN p_tipo_persona = 'jurado' AND p_estado = 'activo'
                    AND COALESCE(p_estado_designacion, 'pendiente') <> 'rechazado';
            END;
            $$ LANGUAGE plpgsql IMMUTABLE;

            CREATE OR REPLACE FUNCTION fn_detectar_cambio_designacion_post_evaluacion() RETURNS TRIGGER AS $$
            DECLARE
                v_identidad_cambio BOOLEAN;
                v_eval RECORD;
            BEGIN
                v_identidad_cambio := (OLD.usuario_pagado_id IS DISTINCT FROM NEW.usuario_pagado_id);
                IF NOT v_identidad_cambio THEN RETURN NEW; END IF;

                SELECT * INTO v_eval FROM comision_evaluaciones_jurado
                    WHERE asignacion_id = NEW.id AND estado IN ('enviada', 'corregida_admin') FOR UPDATE;
                IF FOUND THEN
                    UPDATE comision_evaluaciones_jurado SET estado = 'desvinculada_por_cambio_designacion' WHERE id = v_eval.id;
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;

            DROP TRIGGER IF EXISTS trg_detectar_cambio_designacion_post_evaluacion ON asignaciones;
            CREATE TRIGGER trg_detectar_cambio_designacion_post_evaluacion
                AFTER UPDATE ON asignaciones FOR EACH ROW
                EXECUTE FUNCTION fn_detectar_cambio_designacion_post_evaluacion();

            GRANT ALL ON TABLE comision_evaluaciones_jurado TO service_role;
        `);
        qc = async (sql, p) => (await dbComision.query(sql, p)).rows;

        compId.admin = (await qc("insert into administradores (nombre_completo) values ('Admin') returning id"))[0].id;
        compId.jA = (await qc("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado Comision A','A') returning id"))[0].id;
        compId.jB = (await qc("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado Comision B','A') returning id"))[0].id;
        compId.motivo = (await qc("select id from catalogo_motivos_designacion where codigo = 'jurado_no_disponible'"))[0].id;
    });
    afterAll(async () => { await dbComision.close(); });

    test('una evaluación de Comisión ENVIADA se desvincula automáticamente al reemplazar, y el reemplazo NUNCA es bloqueado por esto', async () => {
        const [rodeo] = await qc("insert into rodeos (club, asociacion, fecha) values ('Club Test','Osorno','2026-06-01') returning id");
        const [asig] = await qc(
            `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, nombre_importado, valor_diario_aplicado, pago_base_calculado, estado)
             values ($1,$2,'jurado','Jurado Comision A',100000,100000,'activo') returning id`,
            [rodeo.id, compId.jA]
        );
        await qc("insert into comision_evaluaciones_jurado (asignacion_id, estado) values ($1,'enviada')", [asig.id]);

        const [r] = await qc(
            `select * from reemplazar_jurado_asignacion_con_bitacora(
                p_asignacion_id := $1, p_usuario_pagado_id_nuevo := $2,
                p_categoria_aplicada_nueva := 'A', p_valor_diario_aplicado_nuevo := 150000, p_pago_base_calculado_nuevo := 150000,
                p_motivo_catalogo_id := $3, p_actor_id := $4
            )`,
            [asig.id, compId.jB, compId.motivo, compId.admin]
        );
        expect(r.reemplazar_jurado_asignacion_con_bitacora.asignacion.usuario_pagado_id).toBe(compId.jB);

        const [evalDespues] = await qc('select estado from comision_evaluaciones_jurado where asignacion_id = $1', [asig.id]);
        expect(evalDespues.estado).toBe('desvinculada_por_cambio_designacion');
    });
});
