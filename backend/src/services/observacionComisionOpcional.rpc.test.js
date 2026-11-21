// Migración 106 — la observación de la Comisión Técnica es OPCIONAL (Tipo A y
// Tipo B), contra un PostgreSQL REAL de prueba (PGlite). Orden igual al
// despliegue: esquema → publicar_evaluacion de producción → 103 → 106.
// Sigue obligatoria la decisión ERROR / ACIERTO; no cambian descuentos,
// bloqueo de publicación, auditoría, permisos, anulación ni cierre excepcional.
const fs = require('fs');
const path = require('path');
jest.setTimeout(120000);
const { crearDb } = require('./__fixtures__/pgliteCliente');

const DB = path.join(__dirname, '..', '..', '..', 'database');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaRevisionesComision.sql'), 'utf8');
const PUBLICAR_PROD = fs.readFileSync(path.join(__dirname, '__fixtures__', 'publicarEvaluacionProduccionReferencia.sql'), 'utf8');
const M103 = fs.readFileSync(path.join(DB, 'migrations', '103_revisiones_comision_y_bloqueo_publicacion.sql'), 'utf8');
const M106 = fs.readFileSync(path.join(DB, 'migrations', '106_observacion_comision_opcional.sql'), 'utf8');

let db; const ID = {};
const q = async (sql, p) => (await db.query(sql, p)).rows;
const uno = async (sql, p) => (await q(sql, p))[0];
const ACL = `select proname, proacl::text acl, prosecdef, proconfig::text cfg, pg_get_userbyid(proowner) dueno from pg_proc
             where proname in ('resolver_revision_resultado_alterado','resolver_caso_derivado_comision') order by proname`;
let aclAntes; let casoHistorico;

beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);
    await db.exec(PUBLICAR_PROD);
    ID.admin = (await uno("insert into administradores (nombre_completo) values ('Admin Pleno') returning id")).id;
    ID.analista = (await uno("insert into administradores (nombre_completo, rol_evaluacion) values ('Ana Analista','analista') returning id")).id;
    ID.comision = (await uno("insert into administradores (nombre_completo, rol_evaluacion) values ('Carla Comisión','comision_tecnica') returning id")).id;
    ID.jurado = (await uno("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Juan Jurado','A') returning id")).id;
    await db.exec(M103);

    // Decisión de Comisión registrada ANTES de la 106 (con comentario): no debe cambiar.
    const h = await crearEvaluacion({ casos: [{ derivado: true, estado: 'derivado_comision', resolucion: null }] });
    await resolverB(h.casoIds[0], 'error', 'Comentario histórico');
    casoHistorico = await uno('select * from evaluacion_casos where id=$1', [h.casoIds[0]]);

    aclAntes = await q(ACL);
    await db.exec(M106);
});
afterAll(async () => { await db.close(); });

async function crearEvaluacion({ alterado = false, ciclo1 = 'cerrado', ciclo2 = 'cerrado', casos = [] } = {}) {
    const rodeoId = (await uno("insert into rodeos (club, asociacion, fecha) values ('Club', 'Asoc', '2026-10-10') returning id")).id;
    const asigId = (await uno("insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona) values ($1, $2, 'jurado') returning id", [rodeoId, ID.jurado])).id;
    const evalId = (await uno(
        `insert into evaluaciones (rodeo_id, analista_id, estado, creado_por, resultados_alterados, comentario_resultados_alterados)
         values ($1, $2, 'en_proceso', $2, $3, $4) returning id`,
        [rodeoId, ID.analista, alterado, alterado ? 'Se alteró el 2° lugar' : null])).id;
    const c1 = (await uno("insert into evaluacion_ciclos (evaluacion_id, numero_ciclo, estado) values ($1, 1, $2) returning id", [evalId, ciclo1])).id;
    const c2 = (await uno("insert into evaluacion_ciclos (evaluacion_id, numero_ciclo, estado) values ($1, 2, $2) returning id", [evalId, ciclo2])).id;
    const casoIds = []; let n = 1;
    for (const c of casos) {
        casoIds.push((await uno(
            `insert into evaluacion_casos (ciclo_id, evaluacion_id, numero_caso, tipo_caso, video_url, descuento_puntos, estado, resolucion_final, decision_analista, comentario_analista)
             values ($1,$2,$3,'interpretativa','https://youtu.be/x',$4,$5,$6,$7,$8) returning id`,
            [c.ciclo === 2 ? c2 : c1, evalId, n++, c.desc ?? 1, c.estado || 'resuelto',
             c.resolucion === undefined ? 'interpretativa_confirmada' : c.resolucion,
             c.derivado ? 'derivar_comision' : null, c.derivado ? 'Revisar el atajo' : null])).id);
    }
    return { rodeoId, asigId, evalId, c1, c2, casoIds };
}
const generar = (evalId) => uno('select generar_revision_resultado_alterado($1,$2,$3) r', [evalId, ID.analista, 'cierre_ciclo_1']).then(x => x.r);
const resolverA = (revId, decision, obs) => uno('select resolver_revision_resultado_alterado($1,$2,$3,$4) r', [revId, decision, obs, ID.comision]).then(x => x.r);
const resolverB = (casoId, decision, obs) => uno('select resolver_caso_derivado_comision($1,$2,$3,$4) r', [casoId, decision, obs, ID.comision]).then(x => x.r);
const publicar = async (evalId) => {
    await q("update evaluaciones set estado = 'pendiente_aprobacion' where id = $1", [evalId]);
    return uno('select publicar_evaluacion($1,$2,$3,$4) r', [evalId, ID.admin, null, null]).then(x => x.r);
};
const auditoria = (evalId, accion) => q('select * from evaluacion_auditoria where evaluacion_id=$1 and accion=$2', [evalId, accion]);

// Sin observación se prueba con las 3 formas que puede enviar un cliente.
const SIN_OBS = [null, '', '   '];

describe('Tipo A — resultados alterados', () => {
    test.each(['error', 'acierto'])('%s SIN observación: se registra (observación NULL), con auditoría y quién/cuándo', async (decision) => {
        for (const obs of SIN_OBS) {
            const e = await crearEvaluacion({ alterado: true });
            const { revision_id } = await generar(e.evalId);
            const r = await resolverA(revision_id, decision, obs);
            expect(r.pendientes_restantes).toBe(0);
            const rev = await uno('select * from evaluacion_revisiones_comision where id=$1', [revision_id]);
            expect(rev).toMatchObject({ estado: 'resuelta', decision, observacion_comision: null, resuelto_por: ID.comision });
            expect(rev.resuelto_en).toBeTruthy();
            const aud = await auditoria(e.evalId, 'decision_comision_resultado_alterado');
            expect(aud).toHaveLength(1);
            expect(aud[0].detalle).toEqual({ revision_id, decision, observacion: null });
            expect(aud[0].actor_id).toBe(ID.comision);
        }
    });

    test.each(['error', 'acierto'])('%s CON observación: se conserva tal cual (recortada), igual que antes', async (decision) => {
        const e = await crearEvaluacion({ alterado: true });
        const { revision_id } = await generar(e.evalId);
        await resolverA(revision_id, decision, '  Se verificó en el video  ');
        expect((await uno('select observacion_comision o from evaluacion_revisiones_comision where id=$1', [revision_id])).o).toBe('Se verificó en el video');
        expect((await auditoria(e.evalId, 'decision_comision_resultado_alterado'))[0].detalle.observacion).toBe('Se verificó en el video');
    });

    test('la decisión sigue obligatoria y no se resuelve dos veces', async () => {
        const e = await crearEvaluacion({ alterado: true });
        const { revision_id } = await generar(e.evalId);
        await expect(resolverA(revision_id, null, 'x')).rejects.toThrow(/DECISION_INVALIDA/);
        await expect(resolverA(revision_id, 'aprobar', null)).rejects.toThrow(/DECISION_INVALIDA/);
        expect((await uno('select estado from evaluacion_revisiones_comision where id=$1', [revision_id])).estado).toBe('pendiente');
        await resolverA(revision_id, 'error', null);
        await expect(resolverA(revision_id, 'acierto', null)).rejects.toThrow(/REVISION_YA_RESUELTA/);
    });

    test('la restricción de la tabla sigue exigiendo decisión, quién y cuándo, y prohíbe observación en blanco', async () => {
        const e = await crearEvaluacion({ alterado: true });
        const { revision_id } = await generar(e.evalId);
        await expect(q("update evaluacion_revisiones_comision set estado='resuelta', resuelto_por=$2, resuelto_en=now() where id=$1", [revision_id, ID.comision]))
            .rejects.toThrow(/chk_revision_resuelta/);
        await expect(q("update evaluacion_revisiones_comision set estado='resuelta', decision='error', resuelto_por=$2, resuelto_en=now(), observacion_comision='  ' where id=$1", [revision_id, ID.comision]))
            .rejects.toThrow(/chk_revision_resuelta/);
    });

    test('bloqueo de publicación intacto: pendiente bloquea; resuelta sin observación permite publicar con la misma nota', async () => {
        const e = await crearEvaluacion({ alterado: true, casos: [{ desc: 1 }] });
        const { revision_id } = await generar(e.evalId);
        await expect(publicar(e.evalId)).rejects.toThrow(/revisiones_comision_pendientes/);
        await q("update evaluaciones set estado='pendiente_comision' where id=$1", [e.evalId]);
        await resolverA(revision_id, 'acierto', '');
        const pub = await publicar(e.evalId);
        expect(pub.puntaje_final).toBe(79);     // 80 − 1: la alteración nunca descuenta puntos
    });

    test('anular una revisión pendiente SIGUE exigiendo motivo', async () => {
        const e = await crearEvaluacion({ alterado: true });
        await generar(e.evalId);
        await expect(q('select anular_revision_resultado_alterado($1,$2,$3)', [e.evalId, ID.analista, '  '])).rejects.toThrow(/MOTIVO/);
        await expect(q('select anular_revision_resultado_alterado($1,$2,$3)', [e.evalId, ID.analista, null])).rejects.toThrow(/MOTIVO/);
    });
});

describe('Tipo B — casos derivados', () => {
    test('ERROR y ACIERTO SIN observación: mismo significado y mismos descuentos; comentario NULL; auditoría completa', async () => {
        for (const obs of SIN_OBS) {
            const e = await crearEvaluacion({ casos: [
                { desc: 1 },
                { derivado: true, estado: 'derivado_comision', resolucion: null, desc: 1 },
                { derivado: true, estado: 'derivado_comision', resolucion: null, desc: 1, ciclo: 2 }
            ] });
            expect(await resolverB(e.casoIds[1], 'error', obs)).toMatchObject({ resolucion_final: 'apelacion_rechazada', pendientes_restantes: 1 });
            expect(await resolverB(e.casoIds[2], 'acierto', obs)).toMatchObject({ resolucion_final: 'apelacion_acogida', pendientes_restantes: 0 });
            expect(await uno('select decision_comision, comentario_comision, comision_miembro_id, estado from evaluacion_casos where id=$1', [e.casoIds[1]]))
                .toEqual({ decision_comision: 'rechaza_apelacion', comentario_comision: null, comision_miembro_id: ID.comision, estado: 'resuelto' });
            expect(await uno('select decision_comision, comentario_comision from evaluacion_casos where id=$1', [e.casoIds[2]]))
                .toEqual({ decision_comision: 'aprueba_apelacion', comentario_comision: null });
            const aud = await auditoria(e.evalId, 'decision_comision');
            expect(aud.map(a => a.detalle.decision_visible).sort()).toEqual(['acierto', 'error']);
            expect(aud.find(a => a.detalle.decision_visible === 'error').detalle).toMatchObject({ descuento_puntos: 1, descuento_validado: 1, resolucion_final: 'apelacion_rechazada' });
            expect(aud.find(a => a.detalle.decision_visible === 'acierto').detalle).toMatchObject({ descuento_puntos: 1, descuento_validado: 0, resolucion_final: 'apelacion_acogida' });
            const pub = await publicar(e.evalId);
            expect(pub.puntaje_final).toBe(78);  // 80 − 1 (normal) − 1 (ERROR); el ACIERTO no descuenta
        }
    });

    test.each(['error', 'acierto'])('%s CON observación: se conserva', async (decision) => {
        const e = await crearEvaluacion({ casos: [{ derivado: true, estado: 'derivado_comision', resolucion: null }] });
        await resolverB(e.casoIds[0], decision, '  Revisado en video  ');
        expect((await uno('select comentario_comision c from evaluacion_casos where id=$1', [e.casoIds[0]])).c).toBe('Revisado en video');
    });

    test('decisión obligatoria; un caso derivado sigue sin poder resolverse por otra vía', async () => {
        const e = await crearEvaluacion({ casos: [{ derivado: true, estado: 'derivado_comision', resolucion: null }] });
        await expect(resolverB(e.casoIds[0], null, null)).rejects.toThrow(/DECISION_INVALIDA/);
        await expect(resolverB(e.casoIds[0], 'rechaza_apelacion', null)).rejects.toThrow(/DECISION_INVALIDA/);
        await expect(q("update evaluacion_casos set estado='resuelto', resolucion_final='interpretativa_confirmada' where id=$1", [e.casoIds[0]]))
            .rejects.toThrow(/CASO_DERIVADO_REQUIERE_COMISION/);
        await expect(publicar(e.evalId)).rejects.toThrow(/casos_pendientes/);
    });

    test('chk_comentario_comision sigue prohibiendo un comentario en blanco', async () => {
        const e = await crearEvaluacion({ casos: [{ desc: 1 }] });
        await expect(q("update evaluacion_casos set comentario_comision='   ' where id=$1", [e.casoIds[0]])).rejects.toThrow(/chk_comentario_comision/);
    });
});

describe('lo que NO cambia', () => {
    test('decisión registrada antes de la 106 queda intacta', async () => {
        expect(await uno('select * from evaluacion_casos where id=$1', [casoHistorico.id])).toEqual(casoHistorico);
        expect(casoHistorico.comentario_comision).toBe('Comentario histórico');
    });

    test('privilegios, dueño, SECURITY INVOKER y search_path idénticos a la 103', async () => {
        expect(await q(ACL)).toEqual(aclAntes);
    });

    test('cierre excepcional del Administrador SIGUE exigiendo motivo', async () => {
        const e = await crearEvaluacion({ alterado: true });
        await generar(e.evalId);
        await expect(q('select cierre_excepcional_comision_admin($1,$2,$3,$4)', [e.evalId, ID.admin, '  ', '[]']))
            .rejects.toThrow(/MOTIVO/);
    });

    test('los cuerpos de la 106 son los de la 103 salvo la observación (nada más cambió)', () => {
        const cuerpo = (sql, fn) => {
            const i = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
            return sql.slice(i, sql.indexOf('$$;', sql.indexOf('AS $$', i)) + 3).replace(/\r\n/g, '\n');
        };
        const normalizar = (s) => s.split('\n')
            .filter(l => !l.includes('OBSERVACION_REQUERIDA'))
            .map(l => l.replace(/\s*-- 106: opcional\s*$/, '')
                       .replace("NULLIF(btrim(COALESCE(p_observacion, '')), '')", "btrim(COALESCE(p_observacion, ''))"))
            .join('\n');
        for (const fn of ['resolver_revision_resultado_alterado', 'resolver_caso_derivado_comision']) {
            expect(cuerpo(M103, fn)).toContain('OBSERVACION_REQUERIDA');
            expect(cuerpo(M106, fn)).not.toContain('OBSERVACION_REQUERIDA');
            expect(normalizar(cuerpo(M106, fn))).toBe(normalizar(cuerpo(M103, fn)));
        }
    });

    test('la 106 es idempotente', async () => {
        await expect(db.exec(M106)).resolves.toBeDefined();
        expect(await q(ACL)).toEqual(aclAntes);
    });

    test('la 106 no contiene UPDATE/DELETE/INSERT de datos', () => {
        const sinComentarios = M106.replace(/--.*$/gm, '');
        const fuera = sinComentarios.replace(/AS \$\$[\s\S]*?\$\$;/g, '');   // excluye cuerpos de funciones
        expect(fuera).not.toMatch(/\b(UPDATE|DELETE|INSERT|TRUNCATE)\b/i);
    });
});
