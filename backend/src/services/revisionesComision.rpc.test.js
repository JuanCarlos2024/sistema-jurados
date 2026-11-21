// Migración 103 — revisiones de Comisión (Tipo A resultados alterados,
// Tipo B casos derivados) y bloqueo transaccional de publicar_evaluacion,
// contra un PostgreSQL REAL de prueba (PGlite). Orden igual al despliegue:
// esquema → publicar_evaluacion VIGENTE en producción → datos históricos ya
// publicados → migración 103.
const fs = require('fs');
const path = require('path');
jest.setTimeout(120000);
const { crearDb } = require('./__fixtures__/pgliteCliente');

const RAIZ_DB = path.join(__dirname, '..', '..', '..', 'database');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaRevisionesComision.sql'), 'utf8');
const PUBLICAR_PROD = fs.readFileSync(path.join(__dirname, '__fixtures__', 'publicarEvaluacionProduccionReferencia.sql'), 'utf8');
const M103 = fs.readFileSync(path.join(RAIZ_DB, 'migrations', '103_revisiones_comision_y_bloqueo_publicacion.sql'), 'utf8');

let db; const ID = {}; let huellaHistoricaAntes;
const q = async (sql, p) => (await db.query(sql, p)).rows;
const uno = async (sql, p) => (await q(sql, p))[0];

const HUELLA = `select md5(coalesce((select string_agg(row_to_json(e)::text, '|' order by id) from evaluaciones e where estado = 'publicado'), ''))
                    || md5(coalesce((select string_agg(row_to_json(n)::text, '|' order by id) from notas_rodeo n), ''))
                    || md5(coalesce((select string_agg(row_to_json(c)::text, '|' order by c.id) from evaluacion_casos c join evaluaciones e on e.id = c.evaluacion_id where e.estado = 'publicado'), '')) as h`;

beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);
    await db.exec(PUBLICAR_PROD);
    ID.admin = (await uno("insert into administradores (nombre_completo) values ('Admin Pleno') returning id")).id;
    ID.analista = (await uno("insert into administradores (nombre_completo, rol_evaluacion) values ('Ana Analista','analista') returning id")).id;
    ID.comision = (await uno("insert into administradores (nombre_completo, rol_evaluacion) values ('Carla Comisión','comision_tecnica') returning id")).id;
    ID.jurado = (await uno("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Juan Jurado','A') returning id")).id;

    // Histórico YA publicado (con resultados alterados, sin revisión): la 103 no debe tocarlo.
    const h = await crearEvaluacion({ alterado: true, estado: 'publicado', ciclo1: 'cerrado', ciclo2: 'cerrado' });
    await q("update evaluaciones set nota_final = 6.6, puntaje_final = 79, nota_publicada = true where id = $1", [h.evalId]);
    await q("insert into notas_rodeo (asignacion_id, nota, fuente, evaluacion_id) values ($1, 6.6, 'evaluacion_tecnica', $2)", [h.asigId, h.evalId]);
    ID.historica = h.evalId;
    huellaHistoricaAntes = (await uno(HUELLA)).h;

    await db.exec(M103);
});
afterAll(async () => { await db.close(); });

async function crearEvaluacion({ alterado = false, estado = 'en_proceso', ciclo1 = 'cerrado', ciclo2 = 'cerrado', casos = [] } = {}) {
    const rodeoId = (await uno("insert into rodeos (club, asociacion, fecha) values ('Club', 'Asoc', '2026-10-10') returning id")).id;
    const asigId = (await uno("insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona) values ($1, $2, 'jurado') returning id", [rodeoId, ID.jurado])).id;
    const evalId = (await uno(
        `insert into evaluaciones (rodeo_id, analista_id, estado, creado_por, resultados_alterados, comentario_resultados_alterados)
         values ($1, $2, $3, $2, $4, $5) returning id`,
        [rodeoId, ID.analista, estado, alterado, alterado ? 'Se alteró el 2° lugar' : null])).id;
    const c1 = (await uno("insert into evaluacion_ciclos (evaluacion_id, numero_ciclo, estado) values ($1, 1, $2) returning id", [evalId, ciclo1])).id;
    const c2 = (await uno("insert into evaluacion_ciclos (evaluacion_id, numero_ciclo, estado) values ($1, 2, $2) returning id", [evalId, ciclo2])).id;
    const casoIds = [];
    let n = 1;
    for (const c of casos) {
        casoIds.push((await uno(
            `insert into evaluacion_casos (ciclo_id, evaluacion_id, numero_caso, tipo_caso, video_url, descuento_puntos, estado, resolucion_final, decision_analista, comentario_analista)
             values ($1,$2,$3,$4,'https://youtu.be/x',$5,$6,$7,$8,$9) returning id`,
            [c.ciclo === 2 ? c2 : c1, evalId, n++, c.tipo || 'interpretativa', c.desc ?? 1, c.estado || 'resuelto',
             c.resolucion === undefined ? 'interpretativa_confirmada' : c.resolucion,
             c.derivado ? 'derivar_comision' : null, c.derivado ? 'Revisar el atajo' : null])).id);
    }
    return { rodeoId, asigId, evalId, c1, c2, casoIds };
}
const generar = (evalId, origen = 'cierre_ciclo_1') => uno('select generar_revision_resultado_alterado($1,$2,$3) r', [evalId, ID.analista, origen]).then(x => x.r);
const resolverA = (revId, decision, obs = 'Revisado en video') => uno('select resolver_revision_resultado_alterado($1,$2,$3,$4) r', [revId, decision, obs, ID.comision]).then(x => x.r);
const resolverB = (casoId, decision, obs = 'Revisado en video') => uno('select resolver_caso_derivado_comision($1,$2,$3,$4) r', [casoId, decision, obs, ID.comision]).then(x => x.r);
const publicar = async (evalId) => {
    await q("update evaluaciones set estado = 'pendiente_aprobacion' where id = $1", [evalId]);
    return uno('select publicar_evaluacion($1,$2,$3,$4) r', [evalId, ID.admin, null, null]).then(x => x.r);
};
const evaluacion = (id) => uno('select * from evaluaciones where id = $1', [id]);

describe('compatibilidad con lo ya publicado', () => {
    test('aplicar la 103 no modifica ninguna evaluación publicada, nota ni caso histórico', async () => {
        expect((await uno(HUELLA)).h).toBe(huellaHistoricaAntes);
    });
    test('una evaluación publicada con resultados alterados NO recibe revisión retroactiva', async () => {
        expect(await generar(ID.historica)).toEqual({ creada: false, motivo: 'evaluacion_publicada' });
        expect(Number((await uno('select count(*) c from evaluacion_revisiones_comision where evaluacion_id=$1', [ID.historica])).c)).toBe(0);
    });
});

describe('Tipo A — generación', () => {
    test('alteración + Ciclo 1 cerrado → revisión pendiente, evaluación en pendiente_comision, auditada', async () => {
        const e = await crearEvaluacion({ alterado: true });
        const r = await generar(e.evalId);
        expect(r.creada).toBe(true);
        const rev = await uno('select * from evaluacion_revisiones_comision where id=$1', [r.revision_id]);
        expect(rev).toMatchObject({ estado: 'pendiente', tipo: 'resultado_alterado', comentario_alteracion: 'Se alteró el 2° lugar', analista_id: ID.analista, ciclo_id: e.c1 });
        expect((await evaluacion(e.evalId)).estado).toBe('pendiente_comision');
        expect(await q("select * from evaluacion_auditoria where evaluacion_id=$1 and accion='derivar_comision_resultado_alterado'", [e.evalId])).toHaveLength(1);
    });

    test('guardar/cerrar otra vez no duplica (idempotente); el índice único impide un duplicado directo', async () => {
        const e = await crearEvaluacion({ alterado: true });
        await generar(e.evalId);
        expect((await generar(e.evalId, 'datos_deportivos')).motivo).toBe('ya_existe');
        expect((await generar(e.evalId, 'previo_publicacion')).motivo).toBe('ya_existe');
        expect(Number((await uno('select count(*) c from evaluacion_revisiones_comision where evaluacion_id=$1', [e.evalId])).c)).toBe(1);
        await expect(q(`insert into evaluacion_revisiones_comision (evaluacion_id, origen, creada_por) values ($1,'regularizacion',$2)`, [e.evalId, ID.admin])).rejects.toThrow();
    });

    test('sin alteración → no se crea; Ciclo 1 abierto → se crea solo al cerrarlo', async () => {
        const sin = await crearEvaluacion({ alterado: false });
        expect((await generar(sin.evalId)).motivo).toBe('sin_alteracion');
        const abierto = await crearEvaluacion({ alterado: true, ciclo1: 'abierto' });
        expect((await generar(abierto.evalId)).motivo).toBe('ciclo_1_no_cerrado');
        await q("update evaluacion_ciclos set estado='cerrado' where id=$1", [abierto.c1]);
        expect((await generar(abierto.evalId)).creada).toBe(true);
    });

    test('anulada o histórica de importación → no aplica', async () => {
        const e = await crearEvaluacion({ alterado: true });
        await q('update evaluaciones set anulada = true where id=$1', [e.evalId]);
        expect((await generar(e.evalId)).motivo).toBe('no_aplica');
    });
});

describe('Tipo A — resolución y anulación', () => {
    test('ERROR y ACIERTO quedan registrados con quién, cuándo y observación; no se resuelve dos veces', async () => {
        for (const decision of ['error', 'acierto']) {
            const e = await crearEvaluacion({ alterado: true });
            const { revision_id } = await generar(e.evalId);
            const r = await resolverA(revision_id, decision, 'Se verificó en el video');
            expect(r.pendientes_restantes).toBe(0);
            const rev = await uno('select * from evaluacion_revisiones_comision where id=$1', [revision_id]);
            expect(rev).toMatchObject({ estado: 'resuelta', decision, observacion_comision: 'Se verificó en el video', resuelto_por: ID.comision });
            expect(rev.resuelto_en).toBeTruthy();
            await expect(resolverA(revision_id, 'acierto')).rejects.toThrow(/REVISION_YA_RESUELTA/);
            expect(await q("select * from evaluacion_auditoria where evaluacion_id=$1 and accion='decision_comision_resultado_alterado'", [e.evalId])).toHaveLength(1);
        }
    });

    test('decisión inválida u observación vacía → rechazo sin cambios', async () => {
        const e = await crearEvaluacion({ alterado: true });
        const { revision_id } = await generar(e.evalId);
        await expect(resolverA(revision_id, 'aprobar')).rejects.toThrow(/DECISION_INVALIDA/);
        await expect(resolverA(revision_id, 'error', '   ')).rejects.toThrow(/OBSERVACION_REQUERIDA/);
        expect((await uno('select estado from evaluacion_revisiones_comision where id=$1', [revision_id])).estado).toBe('pendiente');
    });

    test('el analista desmarca antes de la resolución: se anula con trazabilidad y la evaluación vuelve a en_proceso; volver a marcar crea una nueva', async () => {
        const e = await crearEvaluacion({ alterado: true });
        const { revision_id } = await generar(e.evalId);
        // desmarcar sin anular primero → bloqueado por el trigger
        await expect(q('update evaluaciones set resultados_alterados=false where id=$1', [e.evalId])).rejects.toThrow(/REVISION_PENDIENTE_SIN_ANULAR/);
        const r = await uno('select anular_revision_resultado_alterado($1,$2,$3) r', [e.evalId, ID.analista, 'El analista corrigió el hallazgo']);
        expect(r.r.anulada).toBe(true);
        await q('update evaluaciones set resultados_alterados=false where id=$1', [e.evalId]);
        const rev = await uno('select * from evaluacion_revisiones_comision where id=$1', [revision_id]);
        expect(rev).toMatchObject({ estado: 'anulada', motivo_anulacion: 'El analista corrigió el hallazgo', anulada_por: ID.analista });
        expect((await evaluacion(e.evalId)).estado).toBe('en_proceso');
        await q("update evaluaciones set resultados_alterados=true, comentario_resultados_alterados='otra vez' where id=$1", [e.evalId]);
        expect((await generar(e.evalId)).creada).toBe(true);
        expect(Number((await uno('select count(*) c from evaluacion_revisiones_comision where evaluacion_id=$1', [e.evalId])).c)).toBe(2);
    });

    test('ya resuelta: no se puede anular, desmarcar ni cambiar el comentario de alteración', async () => {
        const e = await crearEvaluacion({ alterado: true });
        const { revision_id } = await generar(e.evalId);
        await resolverA(revision_id, 'error');
        await expect(q('select anular_revision_resultado_alterado($1,$2,$3)', [e.evalId, ID.analista, 'x'])).rejects.toThrow(/REVISION_YA_RESUELTA/);
        await expect(q('update evaluaciones set resultados_alterados=false where id=$1', [e.evalId])).rejects.toThrow(/ALTERACION_YA_REVISADA/);
        await expect(q("update evaluaciones set comentario_resultados_alterados='otro' where id=$1", [e.evalId])).rejects.toThrow(/ALTERACION_YA_REVISADA/);
        // otros campos de la evaluación siguen editables
        await q("update evaluaciones set observacion_general='ok' where id=$1", [e.evalId]);
    });
});

describe('Tipo B — casos derivados', () => {
    test('ERROR mantiene el descuento del caso; ACIERTO lo excluye; los demás descuentos no cambian', async () => {
        const e = await crearEvaluacion({ casos: [
            { desc: 1 },                                                           // descuento normal (1)
            { derivado: true, estado: 'derivado_comision', resolucion: null, desc: 1 },
            { derivado: true, estado: 'derivado_comision', resolucion: null, desc: 1, ciclo: 2 }
        ] });
        const r1 = await resolverB(e.casoIds[1], 'error');
        expect(r1).toMatchObject({ resolucion_final: 'apelacion_rechazada', pendientes_restantes: 1 });
        await expect(publicar(e.evalId)).rejects.toThrow(/casos_pendientes/);            // uno de dos: sigue bloqueada
        await q("update evaluaciones set estado='en_proceso' where id=$1", [e.evalId]);
        const r2 = await resolverB(e.casoIds[2], 'acierto');
        expect(r2).toMatchObject({ resolucion_final: 'apelacion_acogida', pendientes_restantes: 0 });
        const pub = await publicar(e.evalId);
        expect(pub.puntaje_final).toBe(78);    // 80 − 1 (normal) − 1 (ERROR); el ACIERTO no descuenta
        const caso = await uno('select * from evaluacion_casos where id=$1', [e.casoIds[2]]);
        expect(caso).toMatchObject({ decision_comision: 'aprueba_apelacion', comentario_comision: 'Revisado en video', comision_miembro_id: ID.comision,
            decision_analista: 'derivar_comision', comentario_analista: 'Revisar el atajo' });  // el registro del analista se conserva
        await expect(resolverB(e.casoIds[1], 'acierto')).rejects.toThrow(/CASO_NO_DERIVADO|EVALUACION_PUBLICADA/);
    });

    test('un caso derivado no puede resolverse sin Comisión por otra vía (como hacían /aprobar y /finalizar); la anulación sí es válida', async () => {
        const e = await crearEvaluacion({ casos: [
            { derivado: true, estado: 'derivado_comision', resolucion: null },
            { derivado: true, estado: 'derivado_comision', resolucion: null }
        ] });
        await expect(q("update evaluacion_casos set estado='resuelto', resolucion_final='interpretativa_confirmada' where id=$1", [e.casoIds[0]]))
            .rejects.toThrow(/CASO_DERIVADO_REQUIERE_COMISION/);
        await q("update evaluacion_casos set anulado=true, estado='resuelto' where id=$1", [e.casoIds[1]]);
        expect((await uno('select estado from evaluacion_casos where id=$1', [e.casoIds[0]])).estado).toBe('derivado_comision');
    });

    test('decisión inválida u observación vacía → rechazo; caso no derivado → rechazo', async () => {
        const e = await crearEvaluacion({ casos: [{ derivado: true, estado: 'derivado_comision', resolucion: null }, { desc: 1 }] });
        await expect(resolverB(e.casoIds[0], 'rechaza_apelacion')).rejects.toThrow(/DECISION_INVALIDA/);
        await expect(resolverB(e.casoIds[0], 'error', '')).rejects.toThrow(/OBSERVACION_REQUERIDA/);
        await expect(resolverB(e.casoIds[1], 'error')).rejects.toThrow(/CASO_NO_DERIVADO/);
    });
});

describe('publicar_evaluacion — bloqueo por rodeo', () => {
    test('con revisión Tipo A pendiente NO publica ni escribe notas', async () => {
        const e = await crearEvaluacion({ alterado: true, casos: [{ desc: 1 }] });
        await generar(e.evalId);
        await expect(publicar(e.evalId)).rejects.toThrow(/revisiones_comision_pendientes/);
        expect(await q('select * from notas_rodeo where asignacion_id=$1', [e.asigId])).toHaveLength(0);
    });

    test('con alteración marcada pero sin revisión (vía alternativa sin generar) NO publica', async () => {
        const e = await crearEvaluacion({ alterado: true });
        await expect(publicar(e.evalId)).rejects.toThrow(/revision_resultado_alterado_requerida/);
    });

    test('Tipo A resuelto (ERROR o ACIERTO) no cambia la nota: mismo puntaje que sin alteración', async () => {
        const puntajes = [];
        for (const decision of ['error', 'acierto']) {
            const e = await crearEvaluacion({ alterado: true, casos: [{ desc: 1 }, { desc: 1, ciclo: 2 }] });
            const { revision_id } = await generar(e.evalId);
            await resolverA(revision_id, decision);
            puntajes.push((await publicar(e.evalId)).puntaje_final);
        }
        const sin = await crearEvaluacion({ alterado: false, casos: [{ desc: 1 }, { desc: 1, ciclo: 2 }] });
        puntajes.push((await publicar(sin.evalId)).puntaje_final);
        expect(puntajes).toEqual([78, 78, 78]);
    });

    test('ambos tipos en la misma evaluación: debe resolverse todo; resolver solo uno no libera la nota', async () => {
        const e = await crearEvaluacion({ alterado: true, casos: [{ derivado: true, estado: 'derivado_comision', resolucion: null, desc: 1 }] });
        const { revision_id } = await generar(e.evalId);
        await resolverA(revision_id, 'error');
        await expect(publicar(e.evalId)).rejects.toThrow(/casos_pendientes/);
        await q("update evaluaciones set estado='en_proceso' where id=$1", [e.evalId]);
        await resolverB(e.casoIds[0], 'error');
        expect((await publicar(e.evalId)).puntaje_final).toBe(79);
        const n = await uno('select * from notas_rodeo where asignacion_id=$1', [e.asigId]);
        expect(n).toMatchObject({ fuente: 'evaluacion_tecnica', puntaje_evaluacion: 79 });
    });

    test('un rodeo con pendientes no detiene a otro sin pendientes', async () => {
        const bloqueado = await crearEvaluacion({ alterado: true });
        await generar(bloqueado.evalId);
        const libre = await crearEvaluacion({ alterado: false, casos: [{ desc: 1 }] });
        expect((await publicar(libre.evalId)).ok).toBe(true);
        await expect(publicar(bloqueado.evalId)).rejects.toThrow(/revisiones_comision_pendientes/);
    });

    test('una evaluación ya publicada no admite nuevas decisiones de Comisión', async () => {
        const e = await crearEvaluacion({ alterado: true });
        const { revision_id } = await generar(e.evalId);
        await resolverA(revision_id, 'acierto');
        await publicar(e.evalId);
        expect((await generar(e.evalId)).motivo).toBe('evaluacion_publicada');
    });
});

describe('CIERRE EXCEPCIONAL — ADMINISTRADOR', () => {
    const cerrar = (evalId, decisiones = [], motivo = 'La Comisión no respondió en el plazo', admin = ID.admin) =>
        uno('select cierre_excepcional_comision_admin($1,$2,$3,$4::jsonb) r', [evalId, admin, motivo, JSON.stringify(decisiones)]).then(x => x.r);
    const conPendientes = async () => {
        const e = await crearEvaluacion({ alterado: true, casos: [
            { desc: 1 },                                                                      // descuento normal
            { derivado: true, estado: 'derivado_comision', resolucion: null, desc: 1 },       // B1
            { derivado: true, estado: 'derivado_comision', resolucion: null, desc: 1, ciclo: 2 } // B2
        ] });
        await generar(e.evalId);
        return e;
    };

    test('el Administrador pleno trata formalmente los pendientes: A sin decisión ni puntos; B con su decisión expresa; historial completo', async () => {
        const e = await conPendientes();
        const r = await cerrar(e.evalId, [{ caso_id: e.casoIds[1], decision: 'error' }, { caso_id: e.casoIds[2], decision: 'acierto' }]);
        expect(r).toMatchObject({ revisiones_resultado_alterado: 1, casos_derivados: 2, descuentos_considerados_total: 1 });

        const revA = await uno("select * from evaluacion_revisiones_comision where evaluacion_id=$1", [e.evalId]);
        expect(revA).toMatchObject({ estado: 'cierre_excepcional', decision: null, resuelto_por: null, cierre_admin_por: ID.admin,
            cierre_admin_motivo: 'La Comisión no respondió en el plazo', cierre_excepcional_id: r.cierre_id, comentario_alteracion: 'Se alteró el 2° lugar' });
        expect((await evaluacion(e.evalId)).resultados_alterados).toBe(true);         // indicador original intacto

        const b1 = await uno('select * from evaluacion_casos where id=$1', [e.casoIds[1]]);
        const b2 = await uno('select * from evaluacion_casos where id=$1', [e.casoIds[2]]);
        expect(b1).toMatchObject({ estado: 'resuelto', resolucion_final: 'apelacion_rechazada', decision_admin_excepcional: 'error',
            decision_comision: null, comision_miembro_id: null, admin_excepcional_por: ID.admin,
            decision_analista: 'derivar_comision', comentario_analista: 'Revisar el atajo' });   // nunca atribuido a la Comisión; analista intacto
        expect(b2).toMatchObject({ resolucion_final: 'apelacion_acogida', decision_admin_excepcional: 'acierto', decision_comision: null });

        const cierre = await uno('select * from evaluacion_cierres_excepcionales where id=$1', [r.cierre_id]);
        expect(cierre).toMatchObject({ evaluacion_id: e.evalId, administrador_id: ID.admin, motivo: 'La Comisión no respondió en el plazo' });
        expect(cierre.pendientes.resultado_alterado).toHaveLength(1);
        expect(cierre.pendientes.video_derivado.map(x => x.caso_id).sort()).toEqual([e.casoIds[1], e.casoIds[2]].sort());
        expect(cierre.tratamiento.video_derivado.find(t => t.caso_id === e.casoIds[1])).toMatchObject({ decision_administrativa: 'error', descuento_considerado: 1 });
        expect(cierre.tratamiento.video_derivado.find(t => t.caso_id === e.casoIds[2])).toMatchObject({ decision_administrativa: 'acierto', descuento_considerado: 0 });
        expect(cierre.ciclos.map(c => c.estado)).toEqual(['cerrado', 'cerrado']);
        expect(await q("select * from evaluacion_auditoria where evaluacion_id=$1 and accion='cierre_excepcional_comision_admin'", [e.evalId])).toHaveLength(1);
        expect((await evaluacion(e.evalId)).estado).toBe('en_proceso');

        // Publicación por el procedimiento normal: mismo cálculo (ERROR descuenta, ACIERTO no).
        expect((await publicar(e.evalId)).puntaje_final).toBe(78);   // 80 − 1 normal − 1 (ERROR administrativo)
    });

    test('Tipo A solo: se cierra sin generar descuento alguno', async () => {
        const e = await crearEvaluacion({ alterado: true, casos: [{ desc: 1 }] });
        await generar(e.evalId);
        await cerrar(e.evalId, []);
        expect((await publicar(e.evalId)).puntaje_final).toBe(79);   // igual que sin alteración
    });

    test('Tipo B exige decisión expresa por cada caso: incompleta, de más, desactualizada o inválida → rechazo sin cambios', async () => {
        const e = await conPendientes();
        await expect(cerrar(e.evalId, [{ caso_id: e.casoIds[1], decision: 'error' }])).rejects.toThrow(/DECISIONES_TIPO_B_INCOMPLETAS/);
        await expect(cerrar(e.evalId, [{ caso_id: e.casoIds[1], decision: 'error' }, { caso_id: e.casoIds[2], decision: 'quizas' }])).rejects.toThrow(/DECISIONES_TIPO_B_INVALIDAS/);
        await expect(cerrar(e.evalId, [{ caso_id: e.casoIds[1], decision: 'error' }, { caso_id: e.casoIds[1], decision: 'acierto' }, { caso_id: e.casoIds[2], decision: 'error' }])).rejects.toThrow(/DECISIONES_TIPO_B_INVALIDAS/);
        await expect(cerrar(e.evalId, [{ caso_id: e.casoIds[0], decision: 'error' }, { caso_id: e.casoIds[1], decision: 'error' }, { caso_id: e.casoIds[2], decision: 'error' }])).rejects.toThrow(/DECISIONES_DESACTUALIZADAS/);
        expect((await uno("select estado from evaluacion_revisiones_comision where evaluacion_id=$1", [e.evalId])).estado).toBe('pendiente');
        expect((await uno('select estado from evaluacion_casos where id=$1', [e.casoIds[1]])).estado).toBe('derivado_comision');
        expect(await q('select * from evaluacion_cierres_excepcionales where evaluacion_id=$1', [e.evalId])).toHaveLength(0);
    });

    test('motivo obligatorio', async () => {
        const e = await conPendientes();
        await expect(cerrar(e.evalId, [{ caso_id: e.casoIds[1], decision: 'error' }, { caso_id: e.casoIds[2], decision: 'error' }], '   ')).rejects.toThrow(/MOTIVO_REQUERIDO/);
    });

    test('permiso verificado en la base: analista, Comisión, administrador inactivo o inexistente → ADMIN_NO_AUTORIZADO', async () => {
        const e = await crearEvaluacion({ alterado: true });
        await generar(e.evalId);
        const inactivo = (await uno("insert into administradores (nombre_completo, activo) values ('Inactivo', false) returning id")).id;
        for (const actor of [ID.analista, ID.comision, inactivo, '00000000-0000-0000-0000-00000000dead']) {
            await expect(cerrar(e.evalId, [], 'motivo', actor)).rejects.toThrow(/ADMIN_NO_AUTORIZADO/);
        }
        expect((await uno("select estado from evaluacion_revisiones_comision where evaluacion_id=$1", [e.evalId])).estado).toBe('pendiente');
    });

    test('no reemplaza el cierre de ciclos: un Ciclo 2 abierto sigue abierto y la publicación sigue exigiéndolo', async () => {
        const e = await crearEvaluacion({ alterado: true, ciclo2: 'abierto' });
        await generar(e.evalId);
        await cerrar(e.evalId, []);
        expect((await uno('select estado from evaluacion_ciclos where id=$1', [e.c2])).estado).toBe('abierto');
    });

    test('sin pendientes → no aplica (y no hay doble cierre ni doble publicación)', async () => {
        const e = await crearEvaluacion({ alterado: true });
        await generar(e.evalId);
        await cerrar(e.evalId, []);
        await expect(cerrar(e.evalId, [])).rejects.toThrow(/SIN_PENDIENTES_COMISION/);
        await publicar(e.evalId);
        await expect(uno('select publicar_evaluacion($1,$2,$3,$4) r', [e.evalId, ID.admin, null, null])).rejects.toThrow(/estado_invalido/);
        await expect(cerrar(e.evalId, [])).rejects.toThrow(/EVALUACION_PUBLICADA/);
        expect(await q("select * from evaluacion_auditoria where evaluacion_id=$1 and accion='publicar_nota'", [e.evalId])).toHaveLength(1);
    });

    test('respuesta tardía de la Comisión: no cambia nada (ni la nota ni el estado) y no publica de nuevo', async () => {
        const e = await conPendientes();
        await cerrar(e.evalId, [{ caso_id: e.casoIds[1], decision: 'acierto' }, { caso_id: e.casoIds[2], decision: 'acierto' }]);
        const revId = (await uno('select id from evaluacion_revisiones_comision where evaluacion_id=$1', [e.evalId])).id;
        await expect(resolverA(revId, 'error')).rejects.toThrow(/REVISION_CERRADA_EXCEPCIONAL/);
        await expect(resolverB(e.casoIds[1], 'error')).rejects.toThrow(/CASO_CERRADO_EXCEPCIONAL/);
        const pub = await publicar(e.evalId);
        expect(pub.puntaje_final).toBe(79);
        await expect(resolverB(e.casoIds[2], 'error')).rejects.toThrow(/CASO_CERRADO_EXCEPCIONAL/);
        expect((await evaluacion(e.evalId)).puntaje_final).toBe(79);
        // el comentario de la alteración tampoco puede cambiarse después del cierre excepcional
        await expect(q("update evaluaciones set comentario_resultados_alterados='x' where id=$1", [e.evalId])).rejects.toThrow(/ALTERACION_YA_REVISADA/);
    });

    test('concurrencia: si la Comisión resolvió un caso mientras el Administrador preparaba el cierre → DECISIONES_DESACTUALIZADAS (recargar)', async () => {
        const e = await conPendientes();
        const vista = [{ caso_id: e.casoIds[1], decision: 'error' }, { caso_id: e.casoIds[2], decision: 'acierto' }];
        await resolverB(e.casoIds[1], 'acierto');           // la Comisión respondió justo antes
        await expect(cerrar(e.evalId, vista)).rejects.toThrow(/DECISIONES_DESACTUALIZADAS/);
        expect((await uno('select decision_comision, decision_admin_excepcional from evaluacion_casos where id=$1', [e.casoIds[1]])))
            .toEqual({ decision_comision: 'aprueba_apelacion', decision_admin_excepcional: null });
    });

    test('nadie puede imitar la excepción escribiendo directamente (ni activando la marca en otra transacción)', async () => {
        const e = await conPendientes();
        await expect(q("update evaluacion_casos set decision_admin_excepcional='acierto' where id=$1", [e.casoIds[1]])).rejects.toThrow(/DECISION_ADMIN_SOLO_POR_CIERRE_EXCEPCIONAL/);
        await expect(q("update evaluacion_revisiones_comision set estado='cierre_excepcional' where evaluacion_id=$1", [e.evalId])).rejects.toThrow(/CIERRE_EXCEPCIONAL_SOLO_POR_ADMIN|chk_revision/);
        await q("select set_config('app.cierre_excepcional_admin', 'on', true)");   // otra transacción: no persiste
        await expect(q("update evaluacion_casos set decision_admin_excepcional='acierto' where id=$1", [e.casoIds[1]])).rejects.toThrow(/DECISION_ADMIN_SOLO_POR_CIERRE_EXCEPCIONAL/);
        await expect(publicar(e.evalId)).rejects.toThrow(/revisiones_comision_pendientes/);   // publicar sigue bloqueando
    });
});

describe('regularización de evaluaciones en curso (database/maintenance/019)', () => {
    const SCRIPT = fs.readFileSync(path.join(RAIZ_DB, 'maintenance', '019_regularizar_revisiones_resultado_alterado.sql'), 'utf8').replace(/\r\n/g, '\n');
    const previa = SCRIPT.slice(SCRIPT.indexOf('SELECT e.id AS evaluacion_id'), SCRIPT.indexOf('ORDER BY r.fecha, r.club;') + 'ORDER BY r.fecha, r.club;'.length);
    const bloqueDo = () => SCRIPT.slice(SCRIPT.indexOf('-- DO $$'))
        .split('\n').map(l => l.replace(/^-- ?/, '')).join('\n')
        .replace("v_actor UUID := '00000000-0000-0000-0000-000000000000';", `v_actor UUID := '${ID.admin}';`);

    test('crea solo donde corresponde (Ciclo 1 cerrado, no publicada), es idempotente y no toca lo publicado', async () => {
        await q('delete from evaluacion_revisiones_comision');
        const cerrado = await crearEvaluacion({ alterado: true });
        const abierto = await crearEvaluacion({ alterado: true, ciclo1: 'abierto' });
        const sinAlterar = await crearEvaluacion({ alterado: false });
        const huellaAntes = (await uno(HUELLA)).h;

        const vista = await q(previa);
        const accion = Object.fromEntries(vista.map(v => [v.evaluacion_id, v.accion]));
        expect(accion[cerrado.evalId]).toBe('SE CREARÁ revisión pendiente');
        expect(accion[abierto.evalId]).toBe('se creará al cerrar el Ciclo 1');
        expect(accion[sinAlterar.evalId]).toBeUndefined();
        expect(accion[ID.historica]).toBeUndefined();          // publicada: ni siquiera aparece

        await db.exec(bloqueDo());
        await db.exec(bloqueDo());                              // segunda ejecución: no duplica
        const revs = await q("select evaluacion_id, origen, estado from evaluacion_revisiones_comision where evaluacion_id = any($1::uuid[])",
            [[cerrado.evalId, abierto.evalId, sinAlterar.evalId, ID.historica]]);
        expect(revs).toEqual([{ evaluacion_id: cerrado.evalId, origen: 'regularizacion', estado: 'pendiente' }]);
        // nunca más de una revisión vigente por evaluación, aunque se ejecute dos veces
        const dup = await q("select evaluacion_id from evaluacion_revisiones_comision where estado <> 'anulada' group by evaluacion_id having count(*) > 1");
        expect(dup).toEqual([]);
        expect((await uno(HUELLA)).h).toBe(huellaAntes);       // nada publicado cambió
        expect((await evaluacion(abierto.evalId)).estado).toBe('en_proceso');
    });

    test('sin reemplazar el UUID del ejecutor, el bloque se niega a correr', async () => {
        const original = SCRIPT.slice(SCRIPT.indexOf('-- DO $$')).split('\n').map(l => l.replace(/^-- ?/, '')).join('\n');
        await expect(db.exec(original)).rejects.toThrow(/UUID real del administrador/);
    });
});

describe('seguridad', () => {
    test('publicar_evaluacion y las RPC nuevas: EXECUTE solo service_role (anon/authenticated revocados)', async () => {
        for (const f of ['public.publicar_evaluacion(uuid,uuid,text,text)', 'public.generar_revision_resultado_alterado(uuid,uuid,text)',
                         'public.resolver_revision_resultado_alterado(uuid,text,text,uuid)', 'public.anular_revision_resultado_alterado(uuid,uuid,text)',
                         'public.resolver_caso_derivado_comision(uuid,text,text,uuid)', 'public.cierre_excepcional_comision_admin(uuid,uuid,text,jsonb)']) {
            const r = await uno(`select has_function_privilege('service_role',$1,'EXECUTE') s, has_function_privilege('anon',$1,'EXECUTE') a,
                                        has_function_privilege('authenticated',$1,'EXECUTE') u`, [f]);
            expect({ f, ...r }).toEqual({ f, s: true, a: false, u: false });
        }
    });
    test('la migración es re-aplicable (idempotente)', async () => {
        await expect(db.exec(M103)).resolves.toBeDefined();
    });
});
