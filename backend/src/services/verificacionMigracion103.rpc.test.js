// Procedimiento de verificación de la migración 103
// (database/maintenance/020_verificacion_migracion_103.sql) ejecutado contra
// PostgreSQL real (PGlite) en la misma secuencia que el despliegue:
// FOTO → aplicar 103 → FOTO idéntica → todas las comprobaciones en ok.
// También: las comprobaciones fallan CERRADO (objeto ausente o permiso
// indebido → false, nunca NULL; sin la 103 → error), y la reversión 021
// nunca reabre EXECUTE de publicar_evaluacion a PUBLIC/anon/authenticated.
const fs = require('fs');
const path = require('path');
jest.setTimeout(120000);
const { crearDb } = require('./__fixtures__/pgliteCliente');

const DB = path.join(__dirname, '..', '..', '..', 'database');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaRevisionesComision.sql'), 'utf8');
const PUBLICAR_PROD = fs.readFileSync(path.join(__dirname, '__fixtures__', 'publicarEvaluacionProduccionReferencia.sql'), 'utf8');
const M103 = fs.readFileSync(path.join(DB, 'migrations', '103_revisiones_comision_y_bloqueo_publicacion.sql'), 'utf8');
const SCRIPT = fs.readFileSync(path.join(DB, 'maintenance', '020_verificacion_migracion_103.sql'), 'utf8').replace(/\r\n/g, '\n');
const iniFoto = SCRIPT.indexOf('-- ── FOTO');
const FOTO = SCRIPT.slice(SCRIPT.indexOf('\nSELECT\n', iniFoto) + 1, SCRIPT.indexOf('-- ── FIN FOTO'));
const COMPROBACIONES = SCRIPT.slice(SCRIPT.indexOf('WITH\nf AS ('));
const TOTAL_COMPROBACIONES = 17;

let db;
const q = async (sql, p) => (await db.query(sql, p)).rows;
afterAll(async () => { if (db) await db.close(); });

const fallidas = (resultados) => resultados.filter(r => r.ok !== true).map(r => r.comprobacion);

test('la 103 no modifica datos existentes y deja seguridad, cálculo y triggers como se espera', async () => {
    db = crearDb();
    await db.exec(ESQUEMA);
    await db.exec(PUBLICAR_PROD);
    // Datos previos realistas: una evaluación publicada con nota y una en curso con caso derivado.
    const adm = (await q("insert into administradores (nombre_completo) values ('A') returning id"))[0].id;
    const up = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','J','A') returning id"))[0].id;
    for (const [estado, alterado] of [['publicado', true], ['en_proceso', true]]) {
        const r = (await q("insert into rodeos (club, asociacion, fecha) values ('C','A','2026-10-01') returning id"))[0].id;
        const a = (await q("insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona) values ($1,$2,'jurado') returning id", [r, up]))[0].id;
        const e = (await q("insert into evaluaciones (rodeo_id, estado, creado_por, resultados_alterados, comentario_resultados_alterados, nota_final, puntaje_final) values ($1,$2,$3,$4,'x',6.6,79) returning id", [r, estado, adm, alterado]))[0].id;
        const c = (await q("insert into evaluacion_ciclos (evaluacion_id, numero_ciclo, estado) values ($1,1,'cerrado') returning id", [e]))[0].id;
        await q("insert into evaluacion_casos (ciclo_id, evaluacion_id, numero_caso, tipo_caso, descuento_puntos, estado, decision_analista) values ($1,$2,1,'interpretativa',1,$3,$4)",
            [c, e, estado === 'publicado' ? 'resuelto' : 'derivado_comision', estado === 'publicado' ? null : 'derivar_comision']);
        if (estado === 'publicado') await q("insert into notas_rodeo (asignacion_id, nota, fuente, evaluacion_id) values ($1, 6.6, 'evaluacion_tecnica', $2)", [a, e]);
    }
    // Una fila con campos opcionales NULL no debe desaparecer de la FOTO.
    await q("update evaluaciones set comentario_resultados_alterados = null where estado = 'en_proceso'");

    // Sin la 103 las comprobaciones fallan cerrado (error), nunca "aprueban".
    await expect(q(COMPROBACIONES)).rejects.toThrow(/does not exist/);

    const antes = (await q(FOTO))[0];
    expect(antes.evaluaciones_total).toBe(2);
    expect(antes.evaluaciones_md5).toMatch(/^[0-9a-f]{32}$/);
    await db.exec(M103);
    const despues = (await q(FOTO))[0];
    expect(despues).toEqual(antes);

    const resultados = await q(COMPROBACIONES);
    expect(resultados.length).toBe(TOTAL_COMPROBACIONES);
    expect(fallidas(resultados)).toEqual([]);
});

test('020 falla cerrado: un objeto faltante o un permiso indebido da false (nunca NULL ni omisión)', async () => {
    await db.exec(`BEGIN;
        DROP FUNCTION public.anular_revision_resultado_alterado(UUID, UUID, TEXT);
        DROP TRIGGER trg_proteger_revision_comision ON public.evaluacion_revisiones_comision;
        REVOKE INSERT ON public.evaluacion_cierres_excepcionales FROM service_role;
        GRANT SELECT ON public.evaluacion_revisiones_comision TO anon;
        GRANT EXECUTE ON FUNCTION public.publicar_evaluacion(UUID, UUID, TEXT, TEXT) TO authenticated;`);
    try {
        const resultados = await q(COMPROBACIONES);
        expect(resultados.length).toBe(TOTAL_COMPROBACIONES);
        for (const r of resultados) expect(typeof r.ok).toBe('boolean');
        expect(fallidas(resultados)).toEqual([
            'Existen las 10 funciones nuevas, una sola versión de cada una',
            'Triggers de la 103 instalados, habilitados y en su tabla',
            'Funciones nuevas: SECURITY INVOKER con search_path fijo (las 10)',
            'EXECUTE para service_role en publicar y en las 7 que usa el backend',
            'Sin EXECUTE para PUBLIC, anon ni authenticated (publicar + las 10 nuevas)',
            'Tablas nuevas: service_role con SELECT, INSERT y UPDATE (lo que usa el backend)',
            'Tablas nuevas: ningún privilegio para PUBLIC, anon ni authenticated'
        ]);
    } finally {
        await db.exec('ROLLBACK');
    }
    expect(fallidas(await q(COMPROBACIONES))).toEqual([]);
});

test('FOTO detecta cualquier cambio en una evaluación, un caso o una nota históricos', async () => {
    const base = (await q(FOTO))[0];
    for (const cambio of [
        "update evaluaciones set nota_final = 6.3 where estado = 'publicado'",
        "update evaluacion_casos set descuento_puntos = 2 where estado = 'resuelto'",
        "update notas_rodeo set nota = 6.3"
    ]) {
        await db.exec('BEGIN');
        try {
            await db.exec(`ALTER TABLE evaluacion_casos DISABLE TRIGGER USER; ALTER TABLE evaluaciones DISABLE TRIGGER USER; ${cambio};`);
            expect((await q(FOTO))[0]).not.toEqual(base);
        } finally {
            await db.exec('ROLLBACK');
        }
    }
    expect((await q(FOTO))[0]).toEqual(base);
});

// Reversión (database/maintenance/021_reversion_migracion_103.sql), sobre el
// mismo estado posterior a la 103 de los tests anteriores.
const REV = fs.readFileSync(path.join(DB, 'maintenance', '021_reversion_migracion_103.sql'), 'utf8').replace(/\r\n/g, '\n');
const NIVEL1 = REV.slice(REV.indexOf('-- ── NIVEL 1'), REV.indexOf('-- ── NIVEL 2'));
const descomentar = t => t.split('\n').map(l => l.replace(/^-- ?/, '')).join('\n');
const NIVEL2 = descomentar(REV.slice(REV.indexOf('-- BEGIN;'), REV.indexOf('-- ── VERIFICACIÓN')));
const VERIF = descomentar(REV.slice(REV.indexOf('-- SELECT COALESCE(md5(')));

test('021 nunca otorga EXECUTE ni privilegios a PUBLIC, anon o authenticated (sentencias ejecutables)', () => {
    const ejecutable = REV.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
    expect(ejecutable).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\b(PUBLIC|anon|authenticated)\b/i);
    expect(ejecutable).toMatch(/REVOKE ALL ON FUNCTION public\.publicar_evaluacion\(UUID, UUID, TEXT, TEXT\) FROM PUBLIC, anon, authenticated;/);
    expect(ejecutable).toMatch(/GRANT EXECUTE ON FUNCTION public\.publicar_evaluacion\(UUID, UUID, TEXT, TEXT\) TO service_role;/);
});

test('reversión nivel 1: cuerpo previo exacto (md5), EXECUTE solo service_role, sin triggers; datos intactos', async () => {
    const antes = (await q(FOTO))[0];
    await db.exec(NIVEL1);
    expect((await q(VERIF))[0]).toEqual({
        publicar_igual_a_previa: true,
        publicar_security_definer_search_path: true,
        service_role_execute: true,
        sin_execute_public_anon_authenticated: true,
        sin_triggers_103: true
    });
    // Ningún dato histórico cambia y las tablas/filas de la 103 se conservan.
    expect((await q(FOTO))[0]).toEqual(antes);
    expect((await q("select count(*)::int n from pg_class where relname in ('evaluacion_revisiones_comision','evaluacion_cierres_excepcionales')"))[0].n).toBe(2);
});

test('reversión nivel 2: se niega si hay historial de la 103 y limpia cuando no lo hay', async () => {
    const e = (await q("select id from evaluaciones limit 1"))[0].id;
    const adm = (await q("select id from administradores limit 1"))[0].id;
    await q("insert into evaluacion_cierres_excepcionales (evaluacion_id, administrador_id, motivo, pendientes, tratamiento, ciclos) values ($1,$2,'m','[]','{}','[]')", [e, adm]);
    await expect(db.exec(NIVEL2)).rejects.toThrow(/REVERSION_NIVEL_2_RECHAZADA/);
    await db.exec('ROLLBACK');
    expect((await q("select count(*)::int n from evaluacion_cierres_excepcionales"))[0].n).toBe(1);
    await q('delete from evaluacion_cierres_excepcionales');
    const antes = (await q(FOTO))[0];
    await db.exec(NIVEL2);
    expect((await q("select count(*)::int n from pg_class where relname in ('evaluacion_revisiones_comision','evaluacion_cierres_excepcionales')"))[0].n).toBe(0);
    expect((await q("select count(*)::int n from information_schema.columns where table_name='evaluacion_casos' and column_name like '%excepcional%'"))[0].n).toBe(0);
    expect((await q(FOTO))[0]).toEqual(antes);
    // Tras ambos niveles, publicar_evaluacion sigue cerrada a la Data API.
    expect((await q(VERIF))[0].sin_execute_public_anon_authenticated).toBe(true);
});
