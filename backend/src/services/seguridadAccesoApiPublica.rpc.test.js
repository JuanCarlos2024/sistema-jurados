// Migración 105 (cierre del acceso de la Data API — anon/authenticated — al
// esquema public) contra PostgreSQL REAL (PGlite), sobre un esquema que
// reproduce el estado de producción del 2026-11-19: privilegios por defecto
// del esquema que otorgan todo a anon/authenticated/service_role, 32 tablas
// expuestas sin RLS (entre ellas administradores con email/password_hash),
// 35 con RLS pero con GRANT a anon, 2 ya endurecidas sin RLS, una vista
// SECURITY DEFINER, funciones con EXECUTE para PUBLIC/anon y secuencias.
//
// Se verifica, con SET ROLE (permisos EFECTIVOS, no solo catálogo):
//   - antes: anon lee y modifica administradores (la vulnerabilidad);
//   - después: anon/authenticated no acceden a nada; service_role (backend)
//     conserva EXACTAMENTE lo que tenía (incluidas restricciones intencionales);
//   - datos intactos, idempotencia, objetos futuros cerrados, la verificación
//     022 falla cerrado y la reversión 023 restaura el estado previo exacto.
jest.setTimeout(120000);
const fs = require('fs');
const path = require('path');
const { crearDb } = require('./__fixtures__/pgliteCliente');

const DB = path.join(__dirname, '..', '..', '..', 'database');
const M105 = fs.readFileSync(path.join(DB, 'migrations', '105_seguridad_cerrar_acceso_api_publica.sql'), 'utf8');
const V022 = fs.readFileSync(path.join(DB, 'maintenance', '022_verificacion_migracion_105.sql'), 'utf8').replace(/\r\n/g, '\n');
const R023 = fs.readFileSync(path.join(DB, 'maintenance', '023_reversion_migracion_105.sql'), 'utf8');
const FOTO = V022.slice(V022.indexOf('\nSELECT\n', V022.indexOf('-- ── FOTO')) + 1, V022.indexOf('-- ── FIN FOTO'));
const COMPROBACIONES = V022.slice(V022.indexOf('WITH\nroles_api'));

// Producción 2026-11-19: tablas SIN RLS con todos los privilegios para anon/authenticated.
const EXPUESTAS_SIN_RLS = ['administradores', 'asignaciones', 'auditoria', 'bonos_config', 'bonos_solicitados',
    'capacitacion_alternativas', 'capacitacion_asignaciones', 'capacitacion_banco_alternativas', 'capacitacion_banco_preguntas',
    'capacitacion_intentos', 'capacitacion_preguntas', 'capacitacion_pruebas', 'capacitacion_respuestas', 'cartillas_delegado',
    'cartillas_jurado', 'categorias_rodeo', 'clasificacion_categoria_matriz', 'clasificaciones_designacion', 'club_ubicaciones',
    'comunas_chile', 'configuracion_retencion', 'configuracion_tarifas', 'control_gestion_situaciones', 'disponibilidad_usuarios',
    'evaluacion_banco_situaciones', 'evaluacion_comentarios_jurado_ciclo', 'importaciones', 'importaciones_pendientes',
    'rodeo_adjuntos', 'rodeo_links', 'rodeos', 'tipos_rodeo'];
// Con RLS (sin políticas) pero con GRANT a anon/authenticated.
const CON_RLS_CON_GRANT = ['asociacion_alias', 'asociaciones', 'capacitacion_materiales', 'capacitacion_notas_manuales_historial',
    'capacitacion_recalculos', 'capacitacion_recalculos_detalle', 'cartillas_delegado_versiones', 'colleras_completas_snapshots',
    'comunas_chile_alias', 'configuracion_designacion_matriz', 'configuracion_designacion_orden_criterios',
    'configuracion_designacion_versiones', 'configuracion_designacion_zona_extrema_categorias',
    'configuracion_designacion_zonas_extremas', 'datos_monitor_rodeo', 'evaluacion_auditoria', 'evaluacion_casos',
    'evaluacion_ciclos', 'evaluacion_comentarios_finales', 'evaluacion_configuracion', 'evaluacion_escala_calificacion',
    'evaluacion_escala_puntaje_nota', 'evaluacion_respuestas_jurado', 'evaluaciones', 'fichas_internas',
    'historico_colleras_medicion', 'historico_rodeos_temporada', 'material_complementario',
    'material_complementario_interacciones', 'notas_rodeo', 'propuestas_designacion', 'propuestas_designacion_detalle',
    'rodeo_notas_secundarias', 'temporadas', 'usuario_historial_cambios'];
const ESPECIALES = new Set(['administradores', 'usuarios_pagados', 'rodeos', 'asignaciones', 'bonos_solicitados',
    'evaluacion_escala_puntaje_nota', 'evaluacion_configuracion', 'rodeo_notas_secundarias']);

const ESQUEMA_PRODUCCION = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

CREATE SEQUENCE seq_codigo_usuario;
CREATE SEQUENCE configuracion_designacion_numero_version_seq;
CREATE FUNCTION generar_codigo_usuario() RETURNS TEXT LANGUAGE sql AS $$ SELECT 'USR-' || lpad(nextval('seq_codigo_usuario')::text, 4, '0') $$;

CREATE TABLE administradores (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nombre_completo TEXT NOT NULL, email TEXT,
    password_hash TEXT, activo BOOLEAN DEFAULT true, rol_evaluacion TEXT, updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE usuarios_pagados (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), codigo_interno TEXT DEFAULT generar_codigo_usuario(),
    rut TEXT, nombre_completo TEXT NOT NULL, email TEXT, password_hash TEXT);
CREATE TABLE rodeos (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), club TEXT NOT NULL);
CREATE TABLE asignaciones (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), rodeo_id UUID REFERENCES rodeos(id),
    usuario_pagado_id UUID REFERENCES usuarios_pagados(id), tipo_persona TEXT DEFAULT 'jurado');
CREATE TABLE bonos_solicitados (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), asignacion_id UUID REFERENCES asignaciones(id));
CREATE TABLE evaluacion_escala_puntaje_nota (id SERIAL PRIMARY KEY, puntaje INT);
CREATE TABLE evaluacion_configuracion (id SERIAL PRIMARY KEY, dato TEXT);
CREATE TABLE rodeo_notas_secundarias (id SERIAL PRIMARY KEY, dato TEXT);
CREATE TABLE rodeo_notas_delegado_correcciones (id SERIAL PRIMARY KEY, dato TEXT);
${[...EXPUESTAS_SIN_RLS, ...CON_RLS_CON_GRANT].filter(t => !ESPECIALES.has(t))
    .map(t => `CREATE TABLE ${t} (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), dato TEXT);`).join('\n')}
ALTER TABLE notas_rodeo ADD COLUMN updated_at TIMESTAMPTZ DEFAULT now();   -- como en producción (FOTO: notas_ultima_mod)
CREATE TABLE usuario_observaciones_administrativas (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), dato TEXT);
CREATE TABLE configuracion_designacion_prioridad_clasificaciones (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), dato TEXT);

${CON_RLS_CON_GRANT.map(t => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`).join('\n')}
-- Ya endurecidas antes (087 y otras): sin privilegios para la API.
REVOKE ALL ON usuarios_pagados, usuario_observaciones_administrativas, rodeo_notas_delegado_correcciones FROM anon, authenticated;
ALTER TABLE rodeo_notas_delegado_correcciones ENABLE ROW LEVEL SECURITY;
-- Restricción INTENCIONAL para service_role (solo lectura) que debe conservarse.
ALTER TABLE configuracion_designacion_prioridad_clasificaciones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON configuracion_designacion_prioridad_clasificaciones FROM anon, authenticated, service_role;
GRANT SELECT ON configuracion_designacion_prioridad_clasificaciones TO service_role;

CREATE VIEW v_asignaciones_completas AS
    SELECT a.id, u.rut, u.nombre_completo, r.club, b.id AS bono_id
    FROM asignaciones a JOIN usuarios_pagados u ON u.id = a.usuario_pagado_id JOIN rodeos r ON r.id = a.rodeo_id
    LEFT JOIN bonos_solicitados b ON b.asignacion_id = a.id;

CREATE FUNCTION fn_bloquear_designacion_rentado_si_cartilla_institucional() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER trg_bloquear_rentado BEFORE INSERT ON asignaciones FOR EACH ROW EXECUTE FUNCTION fn_bloquear_designacion_rentado_si_cartilla_institucional();
CREATE FUNCTION publicar_evaluacion(p_evaluacion_id UUID, p_jefe_id UUID, p_comentario TEXT DEFAULT NULL, p_ip TEXT DEFAULT NULL)
    RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    BEGIN INSERT INTO notas_rodeo (dato) VALUES ('publicada'); RETURN jsonb_build_object('ok', true); END $$;
CREATE FUNCTION rpc_recalcular_intentos_capacitacion(a UUID, b UUID, c TEXT, d UUID, e TEXT, f UUID) RETURNS VOID LANGUAGE sql AS $$ SELECT $$;
REVOKE EXECUTE ON FUNCTION rpc_recalcular_intentos_capacitacion(UUID, UUID, TEXT, UUID, TEXT, UUID) FROM PUBLIC;
CREATE FUNCTION _cap_calc_resumen(a UUID, b JSONB, c UUID, d NUMERIC, e NUMERIC, f NUMERIC, g NUMERIC) RETURNS JSONB LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
REVOKE EXECUTE ON FUNCTION _cap_calc_resumen(UUID, JSONB, UUID, NUMERIC, NUMERIC, NUMERIC, NUMERIC) FROM PUBLIC;
-- Restricción INTENCIONAL: solo postgres (service_role no la ejecuta).
CREATE FUNCTION _validar_estructura_configuracion_designacion(p UUID) RETURNS BOOLEAN LANGUAGE sql AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION _validar_estructura_configuracion_designacion(UUID) FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO administradores (nombre_completo, email, password_hash, rol_evaluacion) VALUES
    ('Admin Uno', 'uno@ejemplo.invalid', '$2b$10$hashficticio1', NULL), ('Analista', 'dos@ejemplo.invalid', '$2b$10$hashficticio2', 'analista');
INSERT INTO usuarios_pagados (rut, nombre_completo) VALUES ('11.111.111-1', 'Jurado Ficticio');
INSERT INTO rodeos (club) VALUES ('Club Ficticio');
INSERT INTO asignaciones (rodeo_id, usuario_pagado_id) SELECT r.id, u.id FROM rodeos r, usuarios_pagados u;
INSERT INTO notas_rodeo (dato) VALUES ('nota');
INSERT INTO evaluaciones (dato) VALUES ('evaluacion');
`;

let db;
const q = async (sql, p) => (await db.query(sql, p)).rows;
afterAll(async () => { if (db) await db.close(); });

// Ejecuta fn con el rol indicado (permisos EFECTIVOS) y siempre vuelve a postgres.
async function comoRol(rol, fn) {
    await db.exec(`SET ROLE ${rol}`);
    try { return await fn(); } finally { await db.exec('RESET ROLE'); }
}
const fallidas = (r) => r.filter(x => x.ok !== true).map(x => x.comprobacion);
// Privilegios efectivos de service_role sobre TODO public (catálogo).
const privilegiosServiceRole = () => q(`
    SELECT c.relname AS objeto, has_table_privilege('service_role', c.oid, 'SELECT') s, has_table_privilege('service_role', c.oid, 'INSERT') i,
           has_table_privilege('service_role', c.oid, 'UPDATE') u, has_table_privilege('service_role', c.oid, 'DELETE') d
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','v')
    UNION ALL
    SELECT p.oid::regprocedure::text, has_function_privilege('service_role', p.oid, 'EXECUTE'), null, null, null
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
    ORDER BY 1`);

// Estado EFECTIVO de la API (anon/authenticated/PUBLIC) sobre todo public + RLS + defaults.
const estadoApi = () => q(`
    SELECT 'rel:' || c.relname AS objeto, c.relrowsecurity::text AS rls,
           (SELECT string_agg(r.rol || '=' || (SELECT string_agg(p.priv, ',' ORDER BY p.priv) FROM
                   (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv)
                   WHERE has_table_privilege(r.rol, c.oid, p.priv)), ';' ORDER BY r.rol)
              FROM (VALUES ('anon'),('authenticated')) r(rol)) AS privs,
           coalesce(array_to_string(c.reloptions, ','), '') AS opciones
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','v')
    UNION ALL
    SELECT 'seq:' || c.relname, '', (SELECT string_agg(r.rol || '=' || CASE WHEN c.relkind = 'S' THEN
               has_sequence_privilege(r.rol, c.oid, 'USAGE')::text || has_sequence_privilege(r.rol, c.oid, 'UPDATE')::text END, ';' ORDER BY r.rol)
             FROM (VALUES ('anon'),('authenticated')) r(rol)), ''
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'S'
    UNION ALL
    SELECT 'fn:' || p.oid::regprocedure::text, '', (SELECT string_agg(r.rol || '=' || has_function_privilege(r.rol, p.oid, 'EXECUTE')::text, ';' ORDER BY r.rol)
             FROM (VALUES ('public'),('anon'),('authenticated')) r(rol)), ''
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
    UNION ALL
    SELECT 'default:' || d.defaclobjtype::text, '', d.defaclacl::text, '' FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
     WHERE n.nspname = 'public' AND pg_get_userbyid(d.defaclrole) = 'postgres'
    ORDER BY 1`);
const sinObjetos = (filas, excluidos) => filas.filter(f => !excluidos.includes(f.objeto));
const distintos = (a, b) => {
    const mb = new Map(b.map(f => [f.objeto, JSON.stringify(f)]));
    return a.filter(f => mb.get(f.objeto) !== JSON.stringify(f)).map(f => f.objeto).sort();
};

let fotoAntes, privsAntes, apiAntes;

test('ANTES (estado de producción): anon lee los hashes y puede modificar administradores — vulnerabilidad reproducida', async () => {
    db = crearDb();
    await db.exec(ESQUEMA_PRODUCCION);
    await comoRol('anon', async () => {
        expect((await q('SELECT count(*)::int n FROM administradores WHERE password_hash IS NOT NULL'))[0].n).toBe(2);
        await db.exec('BEGIN');
        await q("UPDATE administradores SET rol_evaluacion = NULL WHERE rol_evaluacion = 'analista'");   // escalada a Admin pleno
        await db.exec('ROLLBACK');
        expect((await q('SELECT rut FROM v_asignaciones_completas'))[0].rut).toBe('11.111.111-1');      // vista definer filtra RUT
        await db.exec('BEGIN');
        await q("SELECT publicar_evaluacion(gen_random_uuid(), gen_random_uuid())");                      // RPC SECURITY DEFINER
        await db.exec('ROLLBACK');
    });
    // La verificación 022 lo detecta (falla cerrado, sin NULL).
    const r = await q(COMPROBACIONES);
    for (const x of r) expect(typeof x.ok).toBe('boolean');
    expect(fallidas(r)).toEqual(expect.arrayContaining([
        'Tablas y vistas de public: ningún privilegio para anon ni authenticated',
        'Funciones de public: sin EXECUTE para PUBLIC, anon ni authenticated',
        'Ninguna función SECURITY DEFINER ejecutable desde la Data API (/rest/v1/rpc)',
        'Todas las tablas de public con RLS activo (incluida administradores)'
    ]));
    fotoAntes = (await q(FOTO))[0];
    privsAntes = await privilegiosServiceRole();
    apiAntes = await estadoApi();
});

describe('lock_timeout: la 105 nunca espera indefinidamente ni deja cambios parciales', () => {
    test('SET LOCAL lock_timeout = 5s es la primera sentencia tras BEGIN y solo rige dentro de la transacción', async () => {
        const ejecutables = M105.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim() && !l.trim().startsWith('--'));
        expect(ejecutables[0]).toBe('BEGIN;');
        expect(ejecutables[1]).toBe("SET LOCAL lock_timeout = '5s';");
        const hastaSet = M105.slice(0, M105.indexOf("SET LOCAL lock_timeout = '5s';") + "SET LOCAL lock_timeout = '5s';".length);
        await db.exec(hastaSet);
        try {
            expect((await q('SHOW lock_timeout'))[0].lock_timeout).toBe('5s');
        } finally {
            await db.exec('ROLLBACK');
        }
        expect((await q('SHOW lock_timeout'))[0].lock_timeout).toBe('0');   // no queda aplicado a la sesión
    });

    test('un error de bloqueo (55P03) a mitad de la migración revierte TODO: ningún REVOKE, RLS ni default aplicado', async () => {
        // Se inyecta el mismo error que Postgres lanza al vencer lock_timeout, DESPUÉS de los
        // REVOKE y de activar RLS en las 34 tablas (el peor caso: casi todo ya ejecutado).
        const marca = 'ALTER VIEW public.v_asignaciones_completas';
        expect(M105.includes(marca)).toBe(true);
        // (función de reemplazo: en un string de reemplazo "$$" significaría "$")
        const conBloqueo = M105.replace(marca, () =>
            "DO $$ BEGIN RAISE EXCEPTION 'canceling statement due to lock timeout' USING ERRCODE = '55P03'; END $$;\n" + marca);
        expect(conBloqueo).toContain('DO $$ BEGIN RAISE EXCEPTION');
        await expect(db.exec(conBloqueo)).rejects.toThrow(/lock timeout/);
        await db.exec('ROLLBACK');                                     // transacción abortada → se descarta completa
        expect(await estadoApi()).toEqual(apiAntes);                   // permisos de la API exactamente como antes
        expect(await privilegiosServiceRole()).toEqual(privsAntes);
        expect((await q(FOTO))[0]).toEqual(fotoAntes);
        expect((await q("SELECT relrowsecurity r FROM pg_class WHERE relname = 'administradores'"))[0].r).toBe(false);
    });
});

test('aplicar 105: todas las comprobaciones de 022 en ok; FOTO idéntica (datos y privilegios de service_role intactos)', async () => {
    await db.exec(M105);
    const r = await q(COMPROBACIONES);
    expect(r).toHaveLength(12);
    expect(fallidas(r)).toEqual([]);
    expect((await q(FOTO))[0]).toEqual(fotoAntes);
    expect(await privilegiosServiceRole()).toEqual(privsAntes);
});

test('DESPUÉS: anon y authenticated no pueden leer, modificar, insertar, ver la vista, llamar RPC ni usar secuencias', async () => {
    for (const rol of ['anon', 'authenticated']) {
        await comoRol(rol, async () => {
            for (const sql of [
                'SELECT * FROM administradores',
                "UPDATE administradores SET rol_evaluacion = NULL",
                "INSERT INTO administradores (nombre_completo) VALUES ('intruso')",
                'DELETE FROM rodeos',
                'SELECT * FROM v_asignaciones_completas',
                'SELECT * FROM notas_rodeo',
                'SELECT * FROM usuarios_pagados',
                "SELECT publicar_evaluacion(gen_random_uuid(), gen_random_uuid())",
                "SELECT setval('seq_codigo_usuario', 1)",
                'SELECT generar_codigo_usuario()'
            ]) {
                await expect(q(sql)).rejects.toThrow(/permission denied/);
            }
        });
    }
    expect((await q("SELECT count(*)::int n FROM administradores WHERE nombre_completo = 'intruso'"))[0].n).toBe(0);
});

test('DESPUÉS: service_role (backend) sigue operando igual, incluidas defaults, triggers, vista y RPC', async () => {
    await comoRol('service_role', async () => {
        await db.exec('BEGIN');
        try {
            expect((await q('SELECT count(*)::int n FROM administradores'))[0].n).toBe(2);
            await q("UPDATE administradores SET updated_at = now() WHERE nombre_completo = 'Admin Uno'");
            const u = (await q("INSERT INTO usuarios_pagados (rut, nombre_completo) VALUES ('22.222.222-2', 'Nuevo') RETURNING codigo_interno"))[0];
            expect(u.codigo_interno).toMatch(/^USR-\d{4}$/);                                            // DEFAULT función + secuencia
            await q("INSERT INTO asignaciones (rodeo_id, usuario_pagado_id) SELECT r.id, u.id FROM rodeos r, usuarios_pagados u WHERE u.rut = '22.222.222-2'"); // trigger
            expect((await q('SELECT count(*)::int n FROM v_asignaciones_completas'))[0].n).toBe(2);   // vista security_invoker + BYPASSRLS
            expect((await q('SELECT count(*)::int n FROM notas_rodeo'))[0].n).toBe(1);                 // tabla con RLS
            expect((await q("SELECT publicar_evaluacion(gen_random_uuid(), gen_random_uuid()) r"))[0].r).toEqual({ ok: true });
            await q("INSERT INTO evaluacion_configuracion (dato) VALUES ('x')");                       // serial
            // Restricciones INTENCIONALES conservadas (no se amplían privilegios).
            expect((await q('SELECT count(*)::int n FROM configuracion_designacion_prioridad_clasificaciones'))[0].n).toBe(0);
            await expect(q("INSERT INTO configuracion_designacion_prioridad_clasificaciones (dato) VALUES ('x')")).rejects.toThrow(/permission denied/);
        } finally {
            await db.exec('ROLLBACK');
        }
        await expect(q('SELECT _validar_estructura_configuracion_designacion(gen_random_uuid())')).rejects.toThrow(/permission denied/);
    });
});

test('objetos FUTUROS: una tabla nueva nace cerrada para anon y abierta para service_role; una función nueva con EXECUTE implícito de PUBLIC es detectada por 022', async () => {
    await db.exec('BEGIN');
    try {
        await db.exec('CREATE TABLE tabla_futura (id INT); CREATE SEQUENCE secuencia_futura;');
        const t = (await q(`SELECT has_table_privilege('anon','tabla_futura','SELECT') a, has_table_privilege('authenticated','tabla_futura','INSERT') au,
                                   has_table_privilege('service_role','tabla_futura','SELECT') s,
                                   has_sequence_privilege('anon','secuencia_futura','USAGE') sa`))[0];
        expect(t).toEqual({ a: false, au: false, s: true, sa: false });
        expect(fallidas(await q(COMPROBACIONES))).toEqual(['Todas las tablas de public con RLS activo (incluida administradores)']);
        // Default GLOBAL de Postgres: EXECUTE a PUBLIC en funciones nuevas → 022 lo marca hasta que la migración lo revoque.
        await db.exec('CREATE FUNCTION funcion_futura() RETURNS INT LANGUAGE sql AS $$ SELECT 1 $$;');
        expect(fallidas(await q(COMPROBACIONES))).toContain('Funciones de public: sin EXECUTE para PUBLIC, anon ni authenticated');
        await db.exec('REVOKE EXECUTE ON FUNCTION funcion_futura() FROM PUBLIC; ALTER TABLE tabla_futura ENABLE ROW LEVEL SECURITY;');
        expect(fallidas(await q(COMPROBACIONES))).toEqual([]);
    } finally {
        await db.exec('ROLLBACK');
    }
});

test('022 comprobación 11: un privilegio predeterminado GLOBAL que abra objetos futuros a anon/authenticated/PUBLIC la hace fallar', async () => {
    for (const sentencia of [
        'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO anon',
        'ALTER DEFAULT PRIVILEGES GRANT USAGE ON SEQUENCES TO authenticated',
        'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC'
    ]) {
        await db.exec('BEGIN');
        try {
            await db.exec(sentencia);
            const r = await q(COMPROBACIONES);
            for (const x of r) expect(typeof x.ok).toBe('boolean');
            expect(fallidas(r)).toEqual(['Sin privilegios predeterminados GLOBALES que abran objetos futuros a la Data API (cualquier rol)']);
        } finally {
            await db.exec('ROLLBACK');
        }
    }
    expect(fallidas(await q(COMPROBACIONES))).toEqual([]);
});

test('022 comprobación 12: una tabla o función de public con otro dueño la hace fallar', async () => {
    for (const crear of [
        'CREATE TABLE tabla_otro_dueno (id INT); ALTER TABLE tabla_otro_dueno ENABLE ROW LEVEL SECURITY; ALTER TABLE tabla_otro_dueno OWNER TO otro_dueno;',
        'CREATE FUNCTION funcion_otro_dueno() RETURNS INT LANGUAGE sql AS $$ SELECT 1 $$; REVOKE EXECUTE ON FUNCTION funcion_otro_dueno() FROM PUBLIC; ALTER FUNCTION funcion_otro_dueno() OWNER TO otro_dueno;'
    ]) {
        await db.exec('BEGIN');
        try {
            await db.exec('CREATE ROLE otro_dueno; ' + crear);
            expect(fallidas(await q(COMPROBACIONES))).toEqual(['Ningún objeto de public pertenece a otro rol (los defaults de supabase_admin no han tenido efecto)']);
        } finally {
            await db.exec('ROLLBACK');
        }
    }
    expect(fallidas(await q(COMPROBACIONES))).toEqual([]);
});

test('FOTO de 022 detecta cualquier UPDATE en notas, evaluaciones o casos (no solo cambios de conteo)', async () => {
    const base = (await q(FOTO))[0];
    for (const [cambio, campo] of [
        ["UPDATE notas_rodeo SET dato = 'nota alterada'", 'notas_md5'],
        ["UPDATE evaluaciones SET dato = 'evaluacion alterada'", 'evaluaciones_md5'],
        ["INSERT INTO evaluacion_casos (dato) VALUES ('caso'); UPDATE evaluacion_casos SET dato = 'caso alterado'", 'casos_md5']
    ]) {
        await db.exec('BEGIN');
        try {
            await db.exec(cambio);
            const f = (await q(FOTO))[0];
            expect(f.notas_total).toBe(base.notas_total);           // sin cambio de conteo en notas…
            expect(f[campo]).not.toBe(base[campo]);                  // …pero la suma de control sí lo detecta
        } finally {
            await db.exec('ROLLBACK');
        }
    }
    expect((await q(FOTO))[0]).toEqual(base);
});

test('105 es idempotente: aplicarla de nuevo no falla ni cambia nada', async () => {
    await db.exec(M105);
    expect(fallidas(await q(COMPROBACIONES))).toEqual([]);
    expect((await q(FOTO))[0]).toEqual(fotoAntes);
    expect(await privilegiosServiceRole()).toEqual(privsAntes);
});

// ── Recuperación selectiva 023 ─────────────────────────────────────────
const R023N = R023.replace(/\r\n/g, '\n');
const bloque = (letra) => {
    const ini = R023N.indexOf(`-- ┌─ BLOQUE ${letra}`);
    const fin = R023N.indexOf(`-- └─ FIN BLOQUE ${letra}`);
    expect(ini).toBeGreaterThan(-1);
    expect(fin).toBeGreaterThan(ini);
    return R023N.slice(R023N.indexOf('\n', ini) + 1, fin).split('\n').filter(l => l.trim());
};
// Lo que hace Ctrl+/ en el SQL Editor: quitar un "-- " de cada línea seleccionada.
const descomentar = (lineas) => 'BEGIN;\n' + lineas.map(l => l.replace(/^-- /, '')).join('\n') + '\nCOMMIT;';
const SENSIBLES_NUNCA = ['administradores', 'usuarios_pagados', 'usuario_observaciones_administrativas', 'publicar_evaluacion'];
const leePermitido = async (rol, tabla) => {
    try { await comoRol(rol, () => q(`SELECT 1 FROM ${tabla} LIMIT 1`)); return true; } catch (e) {
        if (/permission denied/.test(e.message)) return false; throw e;
    }
};

test('023 completo no ejecuta NADA: todas sus sentencias están comentadas y el estado queda idéntico', async () => {
    const ejecutables = R023N.split('\n').filter(l => l.trim() && !l.trim().startsWith('--'));
    expect(ejecutables).toEqual([]);
    const antes = await estadoApi();
    await db.exec(R023);
    expect(await estadoApi()).toEqual(antes);
    expect(fallidas(await q(COMPROBACIONES))).toEqual([]);
});

test('023: administradores, usuarios_pagados y publicar_evaluacion no figuran en NINGÚN bloque; cada línea de bloque es comentario seleccionable', () => {
    for (const letra of ['A', 'B', 'C', 'D']) {
        const lineas = bloque(letra);
        for (const l of lineas) expect(l.startsWith('-- ')).toBe(true);
        const sql = lineas.filter(l => !l.startsWith('-- --')).join('\n');
        for (const s of SENSIBLES_NUNCA) expect(sql).not.toMatch(new RegExp(`\\b${s}\\b`));
        // Las notas dentro del bloque siguen siendo comentarios después de descomentar.
        for (const l of lineas.filter(x => x.startsWith('-- --'))) expect(l.replace(/^-- /, '').startsWith('--')).toBe(true);
    }
});

test('023 bloque A (catálogos) restaura SOLO catálogos; datos sensibles y operación siguen cerrados; la 105 vuelve a cerrar', async () => {
    await db.exec(descomentar(bloque('A')));
    expect(await leePermitido('anon', 'categorias_rodeo')).toBe(true);
    expect(await leePermitido('anon', 'configuracion_tarifas')).toBe(true);
    for (const t of ['administradores', 'rodeos', 'asignaciones', 'cartillas_jurado', 'notas_rodeo', 'usuarios_pagados']) {
        expect(await leePermitido('anon', t)).toBe(false);
    }
    expect((await q(FOTO))[0]).toEqual(fotoAntes);
    expect(await privilegiosServiceRole()).toEqual(privsAntes);
    await db.exec(M105);
    expect(fallidas(await q(COMPROBACIONES))).toEqual([]);
});

test('023 bloque B (operación) restaura SOLO operación; administradores, cartillas y notas siguen cerrados', async () => {
    await db.exec(descomentar(bloque('B')));
    expect(await leePermitido('anon', 'rodeos')).toBe(true);
    expect(await leePermitido('anon', 'asignaciones')).toBe(true);
    for (const t of ['administradores', 'categorias_rodeo', 'cartillas_jurado', 'notas_rodeo', 'v_asignaciones_completas']) {
        expect(await leePermitido('anon', t)).toBe(false);
    }
    await db.exec(M105);
    expect(fallidas(await q(COMPROBACIONES))).toEqual([]);
});

test('023 selección de UN objeto (cartillas_jurado): solo ese objeto cambia; administradores y publicar siguen cerrados', async () => {
    const lineas = bloque('C').filter(l => /public\.cartillas_jurado\b/.test(l));
    expect(lineas).toHaveLength(2);                                     // GRANT + DISABLE RLS
    const antes = await estadoApi();
    await db.exec(descomentar(lineas));
    expect(distintos(await estadoApi(), antes)).toEqual(['rel:cartillas_jurado']);
    expect(await leePermitido('anon', 'cartillas_jurado')).toBe(true);
    expect(await leePermitido('anon', 'administradores')).toBe(false);
    await comoRol('anon', () => expect(q('SELECT publicar_evaluacion(gen_random_uuid(), gen_random_uuid())')).rejects.toThrow(/permission denied/));
    await db.exec(M105);
    expect(fallidas(await q(COMPROBACIONES))).toEqual([]);
});

test('023 bloques A+B+C+D juntos = estado previo EXACTO, salvo administradores, publicar_evaluacion y la RLS de las tablas de usuarios', async () => {
    for (const letra of ['A', 'B', 'C', 'D']) await db.exec(descomentar(bloque(letra)));
    const excluidos = ['rel:administradores', 'rel:usuarios_pagados', 'rel:usuario_observaciones_administrativas',
        'fn:publicar_evaluacion(uuid,uuid,text,text)'];
    expect(sinObjetos(await estadoApi(), excluidos)).toEqual(sinObjetos(apiAntes, excluidos));
    expect(await leePermitido('anon', 'administradores')).toBe(false);
    await comoRol('anon', () => expect(q('SELECT publicar_evaluacion(gen_random_uuid(), gen_random_uuid())')).rejects.toThrow(/permission denied/));
    expect((await q(FOTO))[0]).toEqual(fotoAntes);
    expect(await privilegiosServiceRole()).toEqual(privsAntes);

    await db.exec(M105);                                               // y la 105 vuelve a cerrar todo
    expect(fallidas(await q(COMPROBACIONES))).toEqual([]);
    expect((await q(FOTO))[0]).toEqual(fotoAntes);
});
