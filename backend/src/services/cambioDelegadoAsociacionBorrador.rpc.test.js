// Migración 102 — cambiar_delegado_asociacion_borrador, contra un PostgreSQL
// REAL de prueba (PGlite) con las migraciones REALES 037, 061–069 y 102.
// El CHECK de cartillas_delegado.estado se alinea con el vigente en
// producción (verificado el 2026-11-17: borrador, enviada, observada,
// aprobada, cerrada, reenviada, reabierta — migraciones 072/092), para poder
// probar observada/reabierta/reenviada.
const fs = require('fs');
const path = require('path');
jest.setTimeout(120000);
const { crearDb } = require('./__fixtures__/pgliteCliente');

const MIG = path.join(__dirname, '..', '..', '..', 'database', 'migrations');
const leer = (n) => fs.readFileSync(path.join(MIG, n), 'utf8');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaCartillaInstitucional.sql'), 'utf8');

let db; const ID = {};
async function q(sql, p) { return (await db.query(sql, p)).rows; }

// Fragmentos EXACTOS de migraciones reales que la 102 necesita y que no
// están en el fixture: los normalizadores de la 053 (con sus REVOKE, tal
// cual) y la tabla asociacion_alias de la 057.
function fragmento(archivo, desde, hasta) {
    const t = leer(archivo);
    const i = t.indexOf(desde);
    const j = t.indexOf(hasta, i);
    if (i < 0 || j < 0) throw new Error(`fragmento no encontrado en ${archivo}`);
    return t.slice(i, j + hasta.length);
}
const NORMALIZADORES_053 = fragmento('053_zonas_extremas_designacion.sql',
    'CREATE OR REPLACE FUNCTION public._normalizar_texto_designacion',
    'REVOKE ALL ON FUNCTION public._normalizar_asociacion_designacion(TEXT) FROM service_role;');
const ALIAS_057 = fragmento('057_informe_gestion_fundacion.sql',
    'CREATE TABLE IF NOT EXISTS asociacion_alias', 'ON asociacion_alias (asociacion_id);');

beforeAll(async () => {
    db = crearDb({ extensiones: ['unaccent'] });
    await db.exec(ESQUEMA);
    // Mismo emplazamiento que producción (053): unaccent en el esquema extensions.
    await db.exec('CREATE SCHEMA IF NOT EXISTS extensions; CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;');
    await db.exec(NORMALIZADORES_053);
    await db.exec(ALIAS_057);
    for (const m of ['037_cartilla_delegado.sql', '061_cuentas_institucionales.sql', '062_delegados_asociacion.sql',
        '064_delegados_asociacion_certificado.sql', '065_cartillas_delegado_institucional.sql', '066_rpc_cartilla_institucional.sql',
        '067_control_transaccional_designacion_cartilla.sql', '068_seleccion_delegado_institucional_por_rodeo.sql',
        '069_responsable_unico_institucional.sql']) {
        await db.exec(leer(m));
    }
    await db.exec(`ALTER TABLE cartillas_delegado DROP CONSTRAINT IF EXISTS cartillas_delegado_estado_check;
        ALTER TABLE cartillas_delegado ADD CONSTRAINT cartillas_delegado_estado_check
        CHECK (estado IN ('borrador','enviada','observada','aprobada','cerrada','reenviada','reabierta'));`);
    await db.exec(leer('102_cambio_delegado_asociacion_borrador.sql'));

    // Como en producción (Supabase): service_role tiene privilegios sobre
    // las tablas y uso del esquema extensions; las funciones se prueban
    // también ejecutándose COMO service_role (SECURITY INVOKER).
    await db.exec('GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role; GRANT USAGE ON SCHEMA extensions TO service_role;');

    const asoc = async (nombre) => (await q(
        'insert into asociaciones (nombre, nombre_normalizado) values ($1, public._normalizar_asociacion_designacion($1)) returning id', [nombre]))[0].id;
    ID.asoc = await asoc('Asociación Valparaíso');
    ID.asocOtra = await asoc('Quillota');
    ID.bioBio = await asoc('BÍO-BÍO');
    ID.rioBioBio = await asoc('RÍO BÍO-BÍO');
    ID.choapa = await asoc('Choapa');
    ID.maipo = await asoc('Maipo');
    ID.maipoNorte = await asoc('Maipo Norte');
    // Alias real de catálogo: "Illapel" → Choapa.
    await q("insert into asociacion_alias (asociacion_id, alias, alias_normalizado) values ($1, 'Illapel', public._normalizar_asociacion_designacion('Illapel'))", [ID.choapa]);
    ID.cuenta = (await q("insert into cuentas_institucionales (email, password_hash, asociacion_id) values ('d@x.cl','x',$1) returning id", [ID.asoc]))[0].id;
    const del = async (nombre, asoc, extra = '') => (await q(
        `insert into delegados_asociacion (nombre, nombre_normalizado, asociacion_id, certificado${extra ? ', activo' : ''})
         values ($1, lower($1), $2, $3${extra ? ', ' + extra : ''}) returning id`, [nombre, asoc, !nombre.includes('Sin Cert')]))[0].id;
    ID.pablo = await del('Pablo Bijit', ID.asoc);
    ID.pedro = await del('Pedro Soto', ID.asoc);
    ID.maria = await del('Maria Rojas', ID.asoc);
    ID.susp = await del('Suspendido Uno', ID.asoc, 'false');
    ID.nocert = await del('Sin Cert Dos', ID.asoc);
    ID.otra = await del('Otra Asociacion', ID.asocOtra);
    ID.otra2 = await del('Otro Quillota', ID.asocOtra);
    ID.delBio1 = await del('Bio Uno', ID.bioBio);
    ID.delRio1 = await del('Rio Uno', ID.rioBioBio);
    ID.delRio2 = await del('Rio Dos', ID.rioBioBio);
    ID.delChoapa1 = await del('Choapa Uno', ID.choapa);
    ID.delChoapa2 = await del('Choapa Dos', ID.choapa);
    ID.admin1 = '00000000-0000-0000-0000-00000000add1';
    ID.admin2 = '00000000-0000-0000-0000-00000000add2';
});
afterAll(async () => { await db.close(); });
beforeEach(async () => {
    await db.exec('DELETE FROM auditoria; DELETE FROM rodeo_adjuntos; DELETE FROM cartillas_delegado; DELETE FROM rodeos_delegado_institucional; DELETE FROM rodeos');
});

async function rodeoConDesignacion(asociacionTexto = 'VALPARAÍSO', delegadoInicial = null, nombreInicial = 'Pablo Bijit') {
    const rodeoId = (await q("insert into rodeos (club, asociacion, fecha) values ('CLUB X',$1,'2026-11-14') returning id", [asociacionTexto]))[0].id;
    const desig = (await q('select * from confirmar_delegado_institucional_rodeo($1,$2,$3,$4)', [rodeoId, delegadoInicial || ID.pablo, nombreInicial, ID.cuenta]))[0];
    return { rodeoId, desigId: desig.id };
}
async function cartilla(rodeoId, estado = 'borrador', extra = {}) {
    return (await q(
        `insert into cartillas_delegado (rodeo_id, delegado_asociacion_id, delegado_nombre, version, estado, respuestas_json)
         values ($1,$2,'Pablo Bijit',$3,$4,$5) returning *`,
        [rodeoId, ID.pablo, extra.version || 3, estado, JSON.stringify(extra.respuestas || { a: 1 })]
    ))[0];
}
async function cambiar(rodeoId, { actual = ID.pablo, nuevo = ID.pedro, version = 3, admin = ID.admin1, motivo = 'La asociación seleccionó por error al delegado equivocado', asoc = ID.asoc } = {}) {
    return (await q('select cambiar_delegado_asociacion_borrador($1,$2,$3,$4,$5,$6,$7) as r', [rodeoId, asoc, actual, nuevo, version, admin, motivo]))[0].r;
}
const designacionDe = async (rodeoId) => (await q('select delegado_asociacion_id from rodeos_delegado_institucional where rodeo_id=$1', [rodeoId]))[0].delegado_asociacion_id;
const eventosReemplazo = async () => q("select * from auditoria where accion='reemplazar_responsable_institucional' order by created_at");

describe('cambio válido en borrador', () => {
    test('conserva TODO el borrador (fila completa salvo las 4 columnas del responsable), adjuntos y estado; audita UNA vez con nombres', async () => {
        const { rodeoId, desigId } = await rodeoConDesignacion();
        const respuestas = {
            series: [{ serie: 'Caballos', ganado: 12 }], ganado: { bajo_peso: true },
            informe_disciplinario: [{ nombre_infractor: 'Juan', articulo: '45' }], accidentes: [{ tipo: 'Jinete' }],
            colleras_invitadas: [{ caballo1: 'Lucero' }], corre_premios: { aplica: true }, deja_puntos_temporada: { aplica: true },
            observaciones: 'ñandú "N°1" áéíóú'
        };
        const antes = await cartilla(rodeoId, 'borrador', { respuestas });
        await q(`insert into rodeo_adjuntos (rodeo_id, tipo_adjunto, nombre_archivo, storage_path, mime_type)
                 values ($1,'cartilla_delegado','f.jpg',$2,'image/jpeg')`, [rodeoId, `r/${rodeoId}.jpg`]);

        const r = await cambiar(rodeoId);
        expect(r).toMatchObject({
            designacion_id: desigId, rodeo_id: rodeoId, cartilla_id: antes.id, cartilla_version: 4,
            delegado_anterior: { id: ID.pablo, nombre: 'Pablo Bijit' }, delegado_nuevo: { id: ID.pedro, nombre: 'Pedro Soto' }
        });

        const despues = (await q('select * from cartillas_delegado where id=$1', [antes.id]))[0];
        for (const col of Object.keys(antes)) {
            if (['delegado_asociacion_id', 'delegado_nombre', 'version', 'updated_at'].includes(col)) continue;
            expect({ col, v: despues[col] }).toEqual({ col, v: antes[col] });
        }
        expect(despues).toMatchObject({ estado: 'borrador', delegado_asociacion_id: ID.pedro, delegado_nombre: 'Pedro Soto', version: 4 });
        expect(despues.respuestas_json).toEqual(respuestas);
        expect(await designacionDe(rodeoId)).toBe(ID.pedro);
        expect(Number((await q('select count(*) c from rodeo_adjuntos'))[0].c)).toBe(1);
        expect(Number((await q('select count(*) c from cartillas_delegado where rodeo_id=$1', [rodeoId]))[0].c)).toBe(1);

        const ev = await eventosReemplazo();
        expect(ev).toHaveLength(1);
        expect(ev[0]).toMatchObject({ tabla: 'rodeos_delegado_institucional', registro_id: desigId, actor_id: ID.admin1, actor_tipo: 'administrador' });
        expect(ev[0].datos_anteriores).toEqual({ delegado_asociacion_id: ID.pablo, delegado_nombre: 'Pablo Bijit', cartilla_version: 3 });
        expect(ev[0].datos_nuevos).toMatchObject({
            delegado_asociacion_id: ID.pedro, delegado_nombre: 'Pedro Soto', motivo: 'La asociación seleccionó por error al delegado equivocado',
            rodeo_id: rodeoId, cartilla_id: antes.id, cartilla_estado: 'borrador', cartilla_version: 4
        });
        expect(ev[0].descripcion).toBe('Cambio de Delegado de Asociación: Pablo Bijit → Pedro Soto — motivo: La asociación seleccionó por error al delegado equivocado');
        // El evento de confirmación original sigue intacto.
        const conf = await q("select * from auditoria where accion='confirmar_responsable_institucional'");
        expect(conf).toHaveLength(1);
        expect(conf[0].datos_nuevos.delegado_nombre).toBe('Pablo Bijit');
    });

    test('rodeo sin cartilla todavía (versión vista = null) -> cambia la designación; nombre anterior desde el catálogo', async () => {
        const { rodeoId } = await rodeoConDesignacion();
        const r = await cambiar(rodeoId, { version: null });
        expect(r.cartilla_id).toBeNull();
        expect(r.delegado_anterior.nombre).toBe('Pablo Bijit');
        expect(await designacionDe(rodeoId)).toBe(ID.pedro);
    });

    test('Delegado Rentado del mismo rodeo: su cartilla queda idéntica', async () => {
        const { rodeoId } = await rodeoConDesignacion();
        const up = (await q("insert into usuarios_pagados (tipo_persona, nombre_completo) values ('delegado_rentado','Rentado') returning id"))[0].id;
        const rentado = (await q(`insert into cartillas_delegado (rodeo_id, delegado_id, delegado_nombre, version, estado)
                                  values ($1,$2,'Rentado',5,'borrador') returning *`, [rodeoId, up]))[0];
        await cartilla(rodeoId);
        await cambiar(rodeoId);
        expect((await q('select * from cartillas_delegado where id=$1', [rentado.id]))[0]).toEqual(rentado);
    });
});

describe('solo borrador — bloqueado DENTRO de la transacción', () => {
    test.each(['enviada', 'reenviada', 'observada', 'reabierta', 'aprobada', 'cerrada'])(
        'cartilla "%s" -> CARTILLA_NO_BORRADOR; nada cambia, nada se audita', async (estado) => {
            const { rodeoId } = await rodeoConDesignacion();
            const antes = await cartilla(rodeoId, estado);
            await expect(cambiar(rodeoId)).rejects.toThrow(new RegExp(`CARTILLA_NO_BORRADOR: ${estado}`));
            expect((await q('select * from cartillas_delegado where id=$1', [antes.id]))[0]).toEqual(antes);
            expect(await designacionDe(rodeoId)).toBe(ID.pablo);
            expect(await eventosReemplazo()).toHaveLength(0);
        });

    test('carrera: la cartilla pasa a "enviada" (misma versión) después de que el admin la vio en borrador -> bloqueado', async () => {
        const { rodeoId } = await rodeoConDesignacion();
        const c = await cartilla(rodeoId);
        await q("update cartillas_delegado set estado='enviada' where id=$1", [c.id]);
        await expect(cambiar(rodeoId, { version: c.version })).rejects.toThrow(/CARTILLA_NO_BORRADOR/);
        expect(await designacionDe(rodeoId)).toBe(ID.pablo);
    });
});

describe('concurrencia — nunca se sobrescribe un cambio no visto', () => {
    test('dos administradores con la MISMA vista, simultáneos -> exactamente uno gana; el otro recibe RESPONSABLE_CAMBIO_CONCURRENTE y no audita', async () => {
        const { rodeoId } = await rodeoConDesignacion();
        await cartilla(rodeoId);
        const r = await Promise.allSettled([
            cambiar(rodeoId, { nuevo: ID.pedro, admin: ID.admin1 }),
            cambiar(rodeoId, { nuevo: ID.maria, admin: ID.admin2 })
        ]);
        const ok = r.filter(x => x.status === 'fulfilled');
        const ko = r.filter(x => x.status === 'rejected');
        expect(ok).toHaveLength(1);
        expect(ko).toHaveLength(1);
        expect(String(ko[0].reason.message)).toMatch(/RESPONSABLE_CAMBIO_CONCURRENTE/);
        expect(await designacionDe(rodeoId)).toBe(ok[0].value.delegado_nuevo.id);
        expect(await eventosReemplazo()).toHaveLength(1);
        expect((await q('select version from cartillas_delegado where rodeo_id=$1', [rodeoId]))[0].version).toBe(4);
    });

    test('el admin vio una versión vieja (la asociación guardó entretanto) -> VERSION_DESACTUALIZADA', async () => {
        const { rodeoId } = await rodeoConDesignacion();
        const c = await cartilla(rodeoId);
        await q('update cartillas_delegado set version = version + 1 where id=$1', [c.id]);
        await expect(cambiar(rodeoId, { version: c.version })).rejects.toThrow(/VERSION_DESACTUALIZADA/);
        expect(await eventosReemplazo()).toHaveLength(0);
    });

    test('hay cartilla pero el admin no envió versión -> VERSION_DESACTUALIZADA; el admin vio una cartilla que ya no existe -> VERSION_DESACTUALIZADA', async () => {
        const { rodeoId } = await rodeoConDesignacion();
        await cartilla(rodeoId);
        await expect(cambiar(rodeoId, { version: null })).rejects.toThrow(/VERSION_DESACTUALIZADA/);
        const otro = await rodeoConDesignacion();
        await expect(cambiar(otro.rodeoId, { version: 3 })).rejects.toThrow(/VERSION_DESACTUALIZADA/);
    });
});

describe('validaciones', () => {
    test.each([
        ['otra asociación', 'otra'], ['suspendido', 'susp'], ['no certificado', 'nocert']
    ])('nuevo delegado %s -> DELEGADO_NO_VALIDO', async (_n, k) => {
        const { rodeoId } = await rodeoConDesignacion();
        await cartilla(rodeoId);
        await expect(cambiar(rodeoId, { nuevo: ID[k] })).rejects.toThrow(/DELEGADO_NO_VALIDO/);
        expect(await designacionDe(rodeoId)).toBe(ID.pablo);
    });

    test('asociación indicada distinta a la del delegado -> rechazado (la asociación del rodeo no coincide)', async () => {
        const { rodeoId } = await rodeoConDesignacion();
        await cartilla(rodeoId);
        await expect(cambiar(rodeoId, { asoc: ID.asocOtra })).rejects.toThrow(/ASOCIACION_NO_COINCIDE/);
    });

    test('mismo delegado -> MISMO_DELEGADO; motivo vacío -> MOTIVO_REQUERIDO; > 1000 -> MOTIVO_DEMASIADO_LARGO', async () => {
        const { rodeoId } = await rodeoConDesignacion();
        await cartilla(rodeoId);
        await expect(cambiar(rodeoId, { nuevo: ID.pablo })).rejects.toThrow(/MISMO_DELEGADO/);
        await expect(cambiar(rodeoId, { motivo: '   ' })).rejects.toThrow(/MOTIVO_REQUERIDO/);
        await expect(cambiar(rodeoId, { motivo: 'x'.repeat(1001) })).rejects.toThrow(/MOTIVO_DEMASIADO_LARGO/);
        expect(await eventosReemplazo()).toHaveLength(0);
    });

    test('rodeo sin designación confirmada -> SIN_DESIGNACION_PREVIA', async () => {
        const rodeoId = (await q("insert into rodeos (club, asociacion, fecha) values ('X','VALPARAISO','2026-11-14') returning id"))[0].id;
        await expect(cambiar(rodeoId, { version: null })).rejects.toThrow(/SIN_DESIGNACION_PREVIA/);
    });
});

describe('asociación REAL del rodeo validada dentro de PostgreSQL (nunca solo el id del backend)', () => {
    test('p_asociacion_id INCORRECTO + delegado de esa otra asociación (activo y certificado) -> ASOCIACION_NO_COINCIDE; nada cambia ni se audita', async () => {
        // Sin esta validación, este par (asociación ajena + delegado de esa
        // asociación) pasaba todas las demás comprobaciones.
        const { rodeoId } = await rodeoConDesignacion('VALPARAÍSO');
        const antes = await cartilla(rodeoId);
        await expect(cambiar(rodeoId, { asoc: ID.asocOtra, nuevo: ID.otra })).rejects.toThrow(/ASOCIACION_NO_COINCIDE/);
        expect(await designacionDe(rodeoId)).toBe(ID.pablo);
        expect((await q('select * from cartillas_delegado where id=$1', [antes.id]))[0]).toEqual(antes);
        expect(await eventosReemplazo()).toHaveLength(0);
    });

    test('nombres parecidos: rodeo de "RÍO BÍO-BÍO" no acepta el id de "BÍO-BÍO" (ni sus delegados); con el id correcto funciona', async () => {
        const { rodeoId } = await rodeoConDesignacion('Asociación Río Bío-Bío', ID.delRio1, 'Rio Uno');
        await cartilla(rodeoId, 'borrador', {});
        await q('update cartillas_delegado set delegado_asociacion_id=$1, delegado_nombre=$2 where rodeo_id=$3', [ID.delRio1, 'Rio Uno', rodeoId]);
        await expect(cambiar(rodeoId, { asoc: ID.bioBio, actual: ID.delRio1, nuevo: ID.delBio1 })).rejects.toThrow(/ASOCIACION_NO_COINCIDE/);
        const r = await cambiar(rodeoId, { asoc: ID.rioBioBio, actual: ID.delRio1, nuevo: ID.delRio2 });
        expect(r.delegado_nuevo).toEqual({ id: ID.delRio2, nombre: 'Rio Dos' });
    });

    test('ALIAS: rodeo registrado como "Asociación Illapel" (alias de Choapa) -> el cambio válido funciona con el id de Choapa', async () => {
        const { rodeoId } = await rodeoConDesignacion('Asociación Illapel', ID.delChoapa1, 'Choapa Uno');
        await q(`insert into cartillas_delegado (rodeo_id, delegado_asociacion_id, delegado_nombre, version, estado)
                 values ($1,$2,'Choapa Uno',1,'borrador')`, [rodeoId, ID.delChoapa1]);
        const r = await cambiar(rodeoId, { asoc: ID.choapa, actual: ID.delChoapa1, nuevo: ID.delChoapa2, version: 1 });
        expect(r.delegado_nuevo.id).toBe(ID.delChoapa2);
        expect(await designacionDe(rodeoId)).toBe(ID.delChoapa2);
        // y con otro id (aunque el delegado sea de esa otra asociación) se rechaza
        const otro = await rodeoConDesignacion('ILLAPEL', ID.delChoapa1, 'Choapa Uno');
        await expect(cambiar(otro.rodeoId, { asoc: ID.asocOtra, actual: ID.delChoapa1, nuevo: ID.otra2, version: null })).rejects.toThrow(/ASOCIACION_NO_COINCIDE/);
    });

    test('asociación del rodeo inexistente en el catálogo -> ASOCIACION_NO_RESUELTA', async () => {
        const { rodeoId } = await rodeoConDesignacion('ASOCIACIÓN QUE NO EXISTE');
        await expect(cambiar(rodeoId, { version: null })).rejects.toThrow(/ASOCIACION_NO_RESUELTA/);
        expect(await designacionDe(rodeoId)).toBe(ID.pablo);
    });

    test('ambigüedad (el alias de una asociación = nombre de otra) -> ASOCIACION_AMBIGUA, nunca elige una', async () => {
        const alias = (await q("insert into asociacion_alias (asociacion_id, alias, alias_normalizado) values ($1,'Maipo Norte','maipo norte') returning id", [ID.maipo]))[0].id;
        try {
            const { rodeoId } = await rodeoConDesignacion('MAIPO NORTE');
            await expect(cambiar(rodeoId, { asoc: ID.maipoNorte, version: null })).rejects.toThrow(/ASOCIACION_AMBIGUA/);
            await expect(cambiar(rodeoId, { asoc: ID.maipo, version: null })).rejects.toThrow(/ASOCIACION_AMBIGUA/);
        } finally {
            await q('delete from asociacion_alias where id=$1', [alias]);
        }
    });

    test('la asociación del rodeo cambió después de que el backend la resolvió -> ASOCIACION_NO_COINCIDE', async () => {
        const { rodeoId } = await rodeoConDesignacion('VALPARAÍSO');
        await cartilla(rodeoId);
        await q("update rodeos set asociacion='QUILLOTA' where id=$1", [rodeoId]);
        await expect(cambiar(rodeoId, { asoc: ID.asoc })).rejects.toThrow(/ASOCIACION_NO_COINCIDE/);
        expect(await designacionDe(rodeoId)).toBe(ID.pablo);
    });

    test('rodeo inexistente -> RODEO_NO_ENCONTRADO', async () => {
        await expect(cambiar('99999999-9999-4999-8999-999999999999', { version: null })).rejects.toThrow(/RODEO_NO_ENCONTRADO/);
    });

    test('el normalizador SQL (053) produce lo mismo que normalizarAsociacion() del backend', async () => {
        const { normalizarAsociacion } = require('./asociaciones');
        const textos = ['VALPARAÍSO', 'Asociación Valparaíso', '  RÍO  BÍO–BÍO ', 'BÍO-BÍO', 'Maipo Norte', 'ASOCIACION Illapel', 'Ñuble', 'Aconcagua—San Felipe'];
        for (const t of textos) {
            const sql = (await q('select public._normalizar_asociacion_designacion($1) n', [t]))[0].n;
            expect({ t, n: sql }).toEqual({ t, n: normalizarAsociacion(t) });
        }
    });
});

describe('seguridad y compatibilidad', () => {
    test('ejecutada COMO service_role (SECURITY INVOKER, como la llama el backend) funciona de punta a punta', async () => {
        const { rodeoId } = await rodeoConDesignacion();
        await cartilla(rodeoId);
        await db.exec('SET ROLE service_role');
        try {
            const r = await cambiar(rodeoId);
            expect(r.delegado_nuevo.id).toBe(ID.pedro);
        } finally {
            await db.exec('RESET ROLE');
        }
    });

    test('sin los GRANT de la 102 sobre los normalizadores, service_role no podría ejecutarla (por eso se otorgan)', async () => {
        const { rodeoId } = await rodeoConDesignacion();
        await cartilla(rodeoId);
        await db.exec('REVOKE EXECUTE ON FUNCTION public._normalizar_asociacion_designacion(TEXT) FROM service_role');
        try {
            await db.exec('SET ROLE service_role');
            await expect(cambiar(rodeoId)).rejects.toThrow(/permission denied/);
        } finally {
            await db.exec('RESET ROLE');
            await db.exec('GRANT EXECUTE ON FUNCTION public._normalizar_asociacion_designacion(TEXT) TO service_role');
        }
        expect(await designacionDe(rodeoId)).toBe(ID.pablo);
    });

    test('normalizadores: EXECUTE solo para service_role (anon/authenticated siguen sin acceso)', async () => {
        for (const f of ['public._normalizar_texto_designacion(text)', 'public._normalizar_asociacion_designacion(text)']) {
            const r = (await q(`select has_function_privilege('service_role',$1,'EXECUTE') s, has_function_privilege('anon',$1,'EXECUTE') a,
                                       has_function_privilege('authenticated',$1,'EXECUTE') u`, [f]))[0];
            expect({ f, ...r }).toEqual({ f, s: true, a: false, u: false });
        }
    });

    test('EXECUTE solo para service_role (nunca anon/authenticated/PUBLIC)', async () => {
        const firma = 'public.cambiar_delegado_asociacion_borrador(uuid,uuid,uuid,uuid,integer,uuid,text)';
        const r = (await q(`select has_function_privilege('service_role', $1, 'EXECUTE') s,
                                   has_function_privilege('anon', $1, 'EXECUTE') a,
                                   has_function_privilege('authenticated', $1, 'EXECUTE') u`, [firma]))[0];
        expect(r).toEqual({ s: true, a: false, u: false });
        const cfg = (await q("select prosecdef, proconfig from pg_proc where proname='cambiar_delegado_asociacion_borrador'"))[0];
        expect(cfg.prosecdef).toBe(false);
        expect(cfg.proconfig).toEqual(['search_path=public, pg_temp']);
    });

    test('la RPC 069 sigue existiendo y funcionando igual (migración aditiva)', async () => {
        const { rodeoId } = await rodeoConDesignacion();
        const r = (await q('select * from reemplazar_delegado_institucional_rodeo($1,$2,$3,$4,$5)', [rodeoId, ID.pedro, 'Pedro Soto', ID.admin1, 'motivo']))[0];
        expect(r.delegado_asociacion_id).toBe(ID.pedro);
    });

    test('la migración es idempotente (se puede volver a aplicar)', async () => {
        await expect(db.exec(leer('102_cambio_delegado_asociacion_borrador.sql'))).resolves.toBeDefined();
    });
});
