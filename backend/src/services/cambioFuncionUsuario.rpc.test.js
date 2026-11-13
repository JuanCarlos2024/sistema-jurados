// Migración 100 — cambio de función Jurado <-> Delegado Rentado, verificada
// contra Postgres REAL (PGlite), no mocks. La RPC se invoca como
// service_role (el único rol con EXECUTE), igual que el backend.
jest.setTimeout(120000);
const fs = require('fs');
const path = require('path');
const { crearDb } = require('./__fixtures__/pgliteCliente');

const MIGRACIONES_DIR = path.join(__dirname, '..', '..', '..', 'database', 'migrations');
const MIGRACION_100 = fs.readFileSync(path.join(MIGRACIONES_DIR, '100_cambio_tipo_persona_con_historial.sql'), 'utf8');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaCambioFuncionUsuario.sql'), 'utf8');
const FIRMA = 'cambiar_tipo_persona_usuario_con_historial(uuid,text,text,uuid,text,text)';

let db; const ID = {};
async function q(sql, p) { return (await db.query(sql, p)).rows; }
let seqCodigo = 0;
async function crearUsuario(tipo, categoria = null, nombre = 'PERSONA') {
    seqCodigo++;
    return (await q(
        `insert into usuarios_pagados (codigo_interno, tipo_persona, nombre_completo, rut, categoria, password_hash)
         values ($1, $2, $3, $4, $5, 'hash-original') returning id`,
        [`USR-9${String(seqCodigo).padStart(3, '0')}`, tipo, nombre, `1${seqCodigo}-K`, categoria]))[0].id;
}
const hoyChile = async () => (await q(`select (now() at time zone 'America/Santiago')::date::text d`))[0].d;
async function crearRodeo(offsetDias, { duracion = 1, estado = 'activo' } = {}) {
    return (await q(
        `insert into rodeos (club, asociacion, fecha, duracion_dias, estado)
         values ('CLUB', 'ASOC', (now() at time zone 'America/Santiago')::date + $1::int, $2, $3) returning id`,
        [offsetDias, duracion, estado]))[0].id;
}
async function asignar(usuarioId, rodeoId, tipo, cat, extra = {}) {
    return (await q(
        `insert into asignaciones (rodeo_id, usuario_pagado_id, tipo_persona, categoria_aplicada, pago_base_calculado, estado, estado_designacion)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [rodeoId, usuarioId, tipo, cat, extra.pago ?? 100000, extra.estado || 'activo', extra.estado_designacion || 'aceptado']))[0].id;
}
async function cambiar(usuarioId, tipo, categoria, motivo = 'Cambio de función administrativo', actor = ID.admin) {
    await db.exec('SET ROLE service_role');
    try {
        return (await q(`select cambiar_tipo_persona_usuario_con_historial($1, $2, $3, $4, 'Admin Test', $5) r`,
            [usuarioId, tipo, categoria, actor, motivo]))[0].r;
    } finally {
        await db.exec('RESET ROLE');
    }
}
const usuario = async (id) => (await q('select * from usuarios_pagados where id = $1', [id]))[0];
const historial = async (id) => q('select * from usuario_historial_cambios where usuario_pagado_id = $1 order by tipo_cambio desc', [id]);

beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);
    await db.exec(MIGRACION_100);
    ID.admin = (await q("insert into administradores (nombre_completo) values ('Admin Test') returning id"))[0].id;
});
afterAll(async () => { await db.close(); });

describe('Migración 100 — estructura, seguridad e idempotencia', () => {
    test('una sola firma, SECURITY INVOKER, search_path fijo y bloqueo FOR UPDATE de la fila', async () => {
        const f = await q(`select p.oid::regprocedure::text firma, p.prosecdef, p.proconfig, pg_get_functiondef(p.oid) def
                           from pg_proc p where p.proname = 'cambiar_tipo_persona_usuario_con_historial'`);
        expect(f).toHaveLength(1);
        expect(f[0].firma).toBe(FIRMA);
        expect(f[0].prosecdef).toBe(false);
        expect(f[0].proconfig).toEqual(['search_path=public']);
        expect(f[0].def).toMatch(/FOR UPDATE/);
    });

    test('EXECUTE solo para service_role (nunca PUBLIC, anon ni authenticated)', async () => {
        const r = (await q(`select has_function_privilege('service_role', '${FIRMA}', 'EXECUTE') s,
                                   has_function_privilege('anon', '${FIRMA}', 'EXECUTE') a,
                                   has_function_privilege('authenticated', '${FIRMA}', 'EXECUTE') au`))[0];
        expect(r).toEqual({ s: true, a: false, au: false });
        await db.exec('SET ROLE anon');
        try {
            await expect(q(`select cambiar_tipo_persona_usuario_con_historial(gen_random_uuid(), 'jurado', 'A', gen_random_uuid(), 'x', 'x')`))
                .rejects.toThrow(/permission denied/);
        } finally { await db.exec('RESET ROLE'); }
    });

    test('el CHECK conserva todos los tipos vigentes (incluido asociacion, 089) y agrega tipo_persona', async () => {
        const id = await crearUsuario('jurado', 'A');
        for (const t of ['estado', 'categoria', 'suspension', 'no_certificado', 'en_retiro', 'asociacion', 'tipo_persona']) {
            await q(`insert into usuario_historial_cambios (usuario_pagado_id, tipo_cambio, valor_nuevo) values ($1, $2, 'x')`, [id, t]);
        }
        await expect(q(`insert into usuario_historial_cambios (usuario_pagado_id, tipo_cambio, valor_nuevo) values ($1, 'otro', 'x')`, [id]))
            .rejects.toThrow(/check constraint/);
    });

    test('re-ejecutar la migración es idempotente (sigue una sola firma, mismos permisos)', async () => {
        await db.exec(MIGRACION_100);
        const f = await q(`select count(*)::int n from pg_proc where proname = 'cambiar_tipo_persona_usuario_con_historial'`);
        expect(f[0].n).toBe(1);
        expect((await q(`select has_function_privilege('anon', '${FIRMA}', 'EXECUTE') a`))[0].a).toBe(false);
    });
});

describe('Cambios permitidos', () => {
    test('1. Jurado C -> Delegado Rentado: misma persona, categoría NULL, historial completo y respuesta sin password_hash', async () => {
        const id = await crearUsuario('jurado', 'C', 'ROBERTO PRUEBA');
        const antes = await usuario(id);
        const r = await cambiar(id, 'delegado_rentado', null, '  Pasa a desempeñarse como Delegado Rentado  ');

        const despues = await usuario(id);
        expect(despues.tipo_persona).toBe('delegado_rentado');
        expect(despues.categoria).toBeNull();
        for (const campo of ['id', 'codigo_interno', 'rut', 'nombre_completo', 'password_hash', 'activo', 'primer_login']) {
            expect(despues[campo]).toEqual(antes[campo]);
        }
        expect((await q('select count(*)::int n from usuarios_pagados where rut = $1', [antes.rut]))[0].n).toBe(1);

        const h = await historial(id);
        expect(h).toHaveLength(2);
        const tp = h.find(x => x.tipo_cambio === 'tipo_persona');
        expect(tp).toMatchObject({ valor_anterior: 'jurado', valor_nuevo: 'delegado_rentado', cambiado_por: ID.admin,
            cambiado_por_nombre: 'Admin Test', observacion: 'Pasa a desempeñarse como Delegado Rentado' });
        const hoy = await hoyChile();
        expect(tp.fecha_efectiva).toEqual(expect.anything());
        expect((await q('select fecha_efectiva::text f from usuario_historial_cambios where id = $1', [tp.id]))[0].f).toBe(hoy);
        expect(h.find(x => x.tipo_cambio === 'categoria')).toMatchObject({ valor_anterior: 'C', valor_nuevo: 'DR' });

        expect(r.usuario).toEqual({ id, codigo_interno: antes.codigo_interno, nombre_completo: 'ROBERTO PRUEBA', tipo_persona: 'delegado_rentado', categoria: null });
        expect(r).toMatchObject({ tipo_anterior: 'jurado', categoria_anterior: 'C', fecha_efectiva: hoy });
        expect(JSON.stringify(r)).not.toMatch(/password|hash/);
    });

    test.each(['A', 'B', 'C'])('2. Delegado Rentado -> Jurado %s', async (cat) => {
        const id = await crearUsuario('delegado_rentado');
        await cambiar(id, 'jurado', cat);
        expect(await usuario(id)).toMatchObject({ tipo_persona: 'jurado', categoria: cat });
        const h = await historial(id);
        expect(h.find(x => x.tipo_cambio === 'tipo_persona')).toMatchObject({ valor_anterior: 'delegado_rentado', valor_nuevo: 'jurado' });
        expect(h.find(x => x.tipo_cambio === 'categoria')).toMatchObject({ valor_anterior: 'DR', valor_nuevo: cat });
    });

    test('ida y vuelta conserva todos los movimientos (append-only)', async () => {
        const id = await crearUsuario('jurado', 'B');
        await cambiar(id, 'delegado_rentado', null);
        await cambiar(id, 'jurado', 'A');
        const h = await q(`select tipo_cambio, valor_anterior, valor_nuevo from usuario_historial_cambios where usuario_pagado_id = $1 and tipo_cambio = 'tipo_persona'`, [id]);
        expect(h).toHaveLength(2);
    });
});

describe('Rechazos (sin cambios parciales)', () => {
    async function sinCambios(id, tipoEsperado, catEsperada) {
        expect(await usuario(id)).toMatchObject({ tipo_persona: tipoEsperado, categoria: catEsperada });
        expect(await historial(id)).toHaveLength(0);
    }

    test.each([[''], ['   '], [null]])('3. motivo vacío (%p) -> MOTIVO_REQUERIDO', async (motivo) => {
        const id = await crearUsuario('jurado', 'C');
        await expect(cambiar(id, 'delegado_rentado', null, motivo)).rejects.toThrow(/MOTIVO_REQUERIDO/);
        await sinCambios(id, 'jurado', 'C');
    });

    test.each([['D'], [null], [''], ['a']])('4. categoría inválida para Jurado (%p) -> CATEGORIA_INVALIDA', async (cat) => {
        const id = await crearUsuario('delegado_rentado');
        await expect(cambiar(id, 'jurado', cat)).rejects.toThrow(/CATEGORIA_INVALIDA/);
        await sinCambios(id, 'delegado_rentado', null);
    });

    test('4b. Delegado Rentado con categoría -> CATEGORIA_INVALIDA', async () => {
        const id = await crearUsuario('jurado', 'A');
        await expect(cambiar(id, 'delegado_rentado', 'A')).rejects.toThrow(/CATEGORIA_INVALIDA/);
        await sinCambios(id, 'jurado', 'A');
    });

    test('tipo inválido, misma función, usuario inexistente y actor nulo', async () => {
        const id = await crearUsuario('jurado', 'A');
        await expect(cambiar(id, 'administrador', null)).rejects.toThrow(/TIPO_PERSONA_INVALIDO/);
        await expect(cambiar(id, 'jurado', 'B')).rejects.toThrow(/TIPO_PERSONA_SIN_CAMBIOS/);
        await expect(cambiar('00000000-0000-0000-0000-000000000000', 'jurado', 'B')).rejects.toThrow(/USUARIO_INEXISTENTE/);
        await db.exec('SET ROLE service_role');
        try {
            await expect(q(`select cambiar_tipo_persona_usuario_con_historial($1, 'delegado_rentado', null, null, 'x', 'motivo')`, [id]))
                .rejects.toThrow(/ACTOR_REQUERIDO/);
        } finally { await db.exec('RESET ROLE'); }
        await sinCambios(id, 'jurado', 'A');
    });

    test('atomicidad: si el registro histórico falla, el perfil NO queda cambiado', async () => {
        const id = await crearUsuario('jurado', 'C');
        // Actor inexistente -> FK de usuario_historial_cambios.cambiado_por falla en el INSERT, DESPUÉS del UPDATE.
        await expect(cambiar(id, 'delegado_rentado', null, 'motivo', '11111111-1111-1111-1111-111111111111'))
            .rejects.toThrow(/foreign key/);
        await sinCambios(id, 'jurado', 'C');
    });
});

describe('5. Designaciones vigentes o futuras', () => {
    test.each([
        ['futura', 10, {}],
        ['hoy (hora de Chile)', 0, {}],
        ['en curso: comenzó ayer y dura 3 días', -1, { duracion: 3 }],
        ['futura pendiente de respuesta', 5, { estado_designacion: 'pendiente' }]
    ])('bloquea: %s', async (_n, offset, opt) => {
        const id = await crearUsuario('jurado', 'C');
        const rodeo = await crearRodeo(offset, { duracion: opt.duracion || 1 });
        await asignar(id, rodeo, 'jurado', 'C', { estado_designacion: opt.estado_designacion });
        await expect(cambiar(id, 'delegado_rentado', null)).rejects.toThrow(/DESIGNACIONES_VIGENTES_O_FUTURAS: 1/);
        expect((await usuario(id)).tipo_persona).toBe('jurado');
        expect(await historial(id)).toHaveLength(0);
    });

    test.each([
        ['pasada', -1, {}, {}],
        ['futura rechazada', 10, {}, { estado_designacion: 'rechazado' }],
        ['futura anulada', 10, {}, { estado: 'anulado' }],
        ['rodeo futuro anulado', 10, { estado: 'anulado' }, {}]
    ])('NO bloquea: %s', async (_n, offset, optRodeo, optAsig) => {
        const id = await crearUsuario('jurado', 'C');
        const rodeo = await crearRodeo(offset, optRodeo);
        await asignar(id, rodeo, 'jurado', 'C', optAsig);
        await cambiar(id, 'delegado_rentado', null);
        expect((await usuario(id)).tipo_persona).toBe('delegado_rentado');
    });
});

describe('Cartillas pendientes de la función que deja', () => {
    test.each([['borrador'], ['reabierta']])('Jurado con cartilla de jurado %s -> CARTILLAS_PENDIENTES', async (estado) => {
        const id = await crearUsuario('jurado', 'C');
        const rodeo = await crearRodeo(-20);
        const asig = await asignar(id, rodeo, 'jurado', 'C');
        await q(`insert into cartillas_jurado (asignacion_id, rodeo_id, usuario_pagado_id, estado) values ($1, $2, $3, $4)`, [asig, rodeo, id, estado]);
        await expect(cambiar(id, 'delegado_rentado', null)).rejects.toThrow(/CARTILLAS_PENDIENTES/);
    });

    test.each([['borrador'], ['observada'], ['reabierta']])('DR con cartilla de delegado %s -> CARTILLAS_PENDIENTES', async (estado) => {
        const id = await crearUsuario('delegado_rentado');
        const rodeo = await crearRodeo(-20);
        await asignar(id, rodeo, 'delegado_rentado', 'DR');
        await q(`insert into cartillas_delegado (rodeo_id, delegado_id, estado) values ($1, $2, $3)`, [rodeo, id, estado]);
        await expect(cambiar(id, 'jurado', 'B')).rejects.toThrow(/CARTILLAS_PENDIENTES/);
    });

    test('cartillas ya enviadas/aprobadas y versiones no actuales NO bloquean', async () => {
        const id = await crearUsuario('jurado', 'C');
        const rodeo = await crearRodeo(-20);
        const asig = await asignar(id, rodeo, 'jurado', 'C');
        await q(`insert into cartillas_jurado (asignacion_id, rodeo_id, usuario_pagado_id, estado, es_actual) values ($1, $2, $3, 'enviada', true), ($1, $2, $3, 'reabierta', false)`, [asig, rodeo, id]);
        await cambiar(id, 'delegado_rentado', null);
        expect((await usuario(id)).tipo_persona).toBe('delegado_rentado');
    });
});

describe('6/12. Preservación histórica: designaciones, notas, cartillas, categorías y pagos intactos', () => {
    test('Jurado con historial -> DR -> Jurado: ningún registro histórico cambia', async () => {
        const id = await crearUsuario('jurado', 'B');
        const r1 = await crearRodeo(-60); const r2 = await crearRodeo(-30, { duracion: 2 });
        const a1 = await asignar(id, r1, 'jurado', 'B', { pago: 150000 });
        const a2 = await asignar(id, r2, 'jurado', 'B', { pago: 300000 });
        await q('insert into notas_rodeo (asignacion_id, nota) values ($1, 6.5), ($2, 5.8)', [a1, a2]);
        await q(`insert into cartillas_jurado (asignacion_id, rodeo_id, usuario_pagado_id, estado) values ($1, $2, $3, 'enviada')`, [a1, r1, id]);

        const foto = async () => ({
            asignaciones: await q('select * from asignaciones where usuario_pagado_id = $1 order by id', [id]),
            notas: await q('select n.* from notas_rodeo n join asignaciones a on a.id = n.asignacion_id where a.usuario_pagado_id = $1 order by n.id', [id]),
            cartillas: await q('select * from cartillas_jurado where usuario_pagado_id = $1 order by id', [id]),
            rodeos: await q('select * from rodeos where id in ($1, $2) order by id', [r1, r2])
        });
        const antes = await foto();
        await cambiar(id, 'delegado_rentado', null);
        expect(await foto()).toEqual(antes);
        // Como DR, puede recibir una designación DR sin afectar las de jurado.
        const r3 = await crearRodeo(-5);
        await asignar(id, r3, 'delegado_rentado', 'DR', { pago: 80000 });
        const antes2 = await foto();
        await cambiar(id, 'jurado', 'A');
        expect(await foto()).toEqual(antes2);

        const porTipo = await q(`select tipo_persona, categoria_aplicada, sum(pago_base_calculado)::int total from asignaciones
                                 where usuario_pagado_id = $1 group by 1, 2 order by 1`, [id]);
        expect(porTipo).toEqual([
            { tipo_persona: 'delegado_rentado', categoria_aplicada: 'DR', total: 80000 },
            { tipo_persona: 'jurado', categoria_aplicada: 'B', total: 450000 }
        ]);
    });
});
