// Ampliación Hoja de Vida — Observaciones Administrativas, nuevos estados
// (No certificado / En retiro) e historial de cambios de categoría,
// verificado contra Postgres REAL (PGlite), no mocks. Cubre la migración
// 087: cambiar_estado_usuario_con_historial, suspender_usuario_con_historial,
// cambiar_categoria_usuario_con_historial, marcar_condicion_bloqueante_usuario.
//
// Defecto real detectado y corregido en esta revisión: el código anterior
// (usuarios.js) hacía un UPDATE a usuarios_pagados y un INSERT a
// usuario_historial_cambios en DOS llamadas Supabase separadas, sin
// transacción — un error en el INSERT dejaba la categoría/estado cambiados
// SIN su registro histórico correspondiente. Las 4 RPC de esta migración
// hacen ambas escrituras en UNA sola transacción de Postgres.
jest.setTimeout(120000);
const fs = require('fs');
const path = require('path');
const { crearDb } = require('./__fixtures__/pgliteCliente');

const MIGRACIONES_DIR = path.join(__dirname, '..', '..', '..', 'database', 'migrations');
const leer = (n) => fs.readFileSync(path.join(MIGRACIONES_DIR, n), 'utf8');
const ESQUEMA = fs.readFileSync(path.join(__dirname, '__fixtures__', 'esquemaUsuariosHistorialAdministrativo.sql'), 'utf8');
const MIGRACION_087 = leer('087_observaciones_administrativas_y_estados_usuario.sql');

let db; const ID = {};
async function q(sql, p) { return (await db.query(sql, p)).rows; }

beforeAll(async () => {
    db = crearDb();
    await db.exec(ESQUEMA);

    // Mirror EXACTO de la realidad verificada en producción (jurados_2026,
    // solo lectura) ANTES de aplicar 087: anon/authenticated tienen acceso
    // completo a usuarios_pagados (Hallazgo 2) — service_role también,
    // como siempre. Se otorga ACÁ, no en el esquema base, para que la
    // migración 087 sea la que efectivamente lo corrija (sección F) y la
    // prueba pueda verificar el ANTES/DESPUÉS real.
    await db.exec(`GRANT ALL ON TABLE administradores, usuarios_pagados, usuario_historial_cambios TO service_role, anon, authenticated;`);

    ID.admin = (await q("insert into administradores (nombre_completo) values ('Admin Test') returning id"))[0].id;

    // Hallazgo 1 — fila LEGACY inconsistente, insertada directamente (como
    // habría quedado el PATCH /:id/suspender anterior a esta migración, que
    // nunca sincronizaba `activo`), ANTES de aplicar 087 — para verificar
    // que la reconciliación de la sección E la corrige de verdad.
    ID.jSuspendidoLegacyInconsistente = (await q(
        `insert into usuarios_pagados (tipo_persona, nombre_completo, categoria, estado_usuario, activo, suspension_desde, suspension_hasta, suspension_motivo)
         values ('jurado','Jurado Legacy Inconsistente','A','suspendido', true, '2026-10-26','2026-11-15','Suspensión disciplinaria') returning id`
    ))[0].id;

    // Historial de categoría YA existente en producción (2 filas reales,
    // ambas con observacion=null, verificadas antes de esta migración) —
    // insertado directamente, ANTES de 087, para comprobar que la columna
    // nueva (fecha_efectiva) no las toca ni les inventa nada.
    ID.jConHistorialCategoriaLegacy = (await q(
        `insert into usuarios_pagados (tipo_persona, nombre_completo, categoria) values ('jurado','Jurado Con Historial Legacy','B') returning id`
    ))[0].id;
    await q(
        `insert into usuario_historial_cambios (usuario_pagado_id, tipo_cambio, valor_anterior, valor_nuevo, cambiado_por_nombre, observacion)
         values ($1,'categoria','C','B','Alexander Toledo', null)`,
        [ID.jConHistorialCategoriaLegacy]
    );

    await db.exec(MIGRACION_087);
});
afterAll(async () => { await db.close(); });

async function grants(tabla, grantee) {
    return q(`select privilege_type from information_schema.role_table_grants where table_name = $1 and grantee = $2 order by privilege_type`, [tabla, grantee]);
}

describe('Hallazgo 1 — reconciliación de activo vs. estado_usuario="suspendido"', () => {
    test('la fila legacy inconsistente (suspendido + activo=true) queda corregida por la migración', async () => {
        const u = await usuario(ID.jSuspendidoLegacyInconsistente);
        expect(u.estado_usuario).toBe('suspendido');
        expect(u.activo).toBe(false);
        // Sus propios datos de suspensión (ya escritos antes de la migración)
        // se conservan tal cual — la reconciliación nunca los tocó.
        expect(String(u.suspension_desde)).toContain('2026-10-26');
        expect(u.suspension_motivo).toBe('Suspensión disciplinaria');
    });

    test('la reconciliación NUNCA escribe en usuario_historial_cambios — el historial de esa fila sigue vacío', async () => {
        expect(await historialDe(ID.jSuspendidoLegacyInconsistente)).toHaveLength(0);
    });

    test('una fila ya coherente (ej. activo/activo=true) no se toca por la reconciliación', async () => {
        // nuevoJurado() se define más abajo pero ya se ejecutó la migración
        // en beforeAll — basta con una comprobación general: ningún jurado
        // activo coherente quedó con activo=false por la reconciliación.
        const filas = await q(`select count(*)::int as n from usuarios_pagados where estado_usuario = 'activo' and activo = false`);
        expect(filas[0].n).toBe(0);
    });

    test('a partir de esta migración, suspender_usuario_con_historial ya sincroniza activo=false siempre (no puede recrearse la inconsistencia)', async () => {
        const id = (await q(`insert into usuarios_pagados (tipo_persona, nombre_completo) values ('jurado','Jurado Nuevo Suspendido') returning id`))[0].id;
        await q(`select * from suspender_usuario_con_historial($1,$2,$3,$4,$5,$6)`, [id, '2026-12-01', '2026-12-15', 'x', ID.admin, 'Admin Test']);
        const u = await usuario(id);
        expect(u.estado_usuario).toBe('suspendido');
        expect(u.activo).toBe(false);
    });
});

describe('Preservación del historial existente de categoría (Fase 4)', () => {
    test('una fila de historial de categoría YA existente antes de 087 conserva fecha_efectiva NULL — nunca se inventa retroactivamente', async () => {
        const hist = await historialDe(ID.jConHistorialCategoriaLegacy);
        expect(hist).toHaveLength(1);
        expect(hist[0]).toMatchObject({ tipo_cambio: 'categoria', valor_anterior: 'C', valor_nuevo: 'B', cambiado_por_nombre: 'Alexander Toledo', observacion: null });
        expect(hist[0].fecha_efectiva).toBeNull();
    });

    test('un cambio de categoría NUEVO (posterior a 087) sí recibe fecha_efectiva — la columna funciona hacia adelante', async () => {
        await cambiarCategoria(ID.jConHistorialCategoriaLegacy, 'A', 'Ascenso de categoría');
        const hist = await historialDe(ID.jConHistorialCategoriaLegacy);
        expect(hist).toHaveLength(2);
        expect(hist[1].fecha_efectiva).not.toBeNull();
    });
});

describe('Hallazgo 2 — permisos de usuarios_pagados tras la migración', () => {
    test('anon y authenticated pierden TODO privilegio sobre usuarios_pagados', async () => {
        expect(await grants('usuarios_pagados', 'anon')).toHaveLength(0);
        expect(await grants('usuarios_pagados', 'authenticated')).toHaveLength(0);
    });

    test('service_role conserva sus privilegios existentes sobre usuarios_pagados, sin cambios', async () => {
        const privilegios = (await grants('usuarios_pagados', 'service_role')).map(r => r.privilege_type);
        expect(privilegios).toEqual(expect.arrayContaining(['SELECT', 'INSERT', 'UPDATE', 'DELETE']));
    });

    test('RLS sigue deshabilitado (no se activó indiscriminadamente, por diseño de esta corrección)', async () => {
        const r = await q(`select relrowsecurity from pg_class where relname = 'usuarios_pagados'`);
        expect(r[0].relrowsecurity).toBe(false);
    });
});

describe('Hallazgo 3 — usuario_observaciones_administrativas es append-only a nivel de base de datos', () => {
    test('service_role tiene EXACTAMENTE SELECT e INSERT — nunca UPDATE ni DELETE, ni para el propio backend', async () => {
        const privilegios = (await grants('usuario_observaciones_administrativas', 'service_role')).map(r => r.privilege_type).sort();
        expect(privilegios).toEqual(['INSERT', 'SELECT']);
    });

    test('anon y authenticated no tienen ningún privilegio sobre la tabla de observaciones', async () => {
        expect(await grants('usuario_observaciones_administrativas', 'anon')).toHaveLength(0);
        expect(await grants('usuario_observaciones_administrativas', 'authenticated')).toHaveLength(0);
    });
});

let _seq = 0;
async function nuevoJurado(extra = {}) {
    _seq++;
    const r = await q(
        `insert into usuarios_pagados (tipo_persona, nombre_completo, categoria, estado_usuario, activo)
         values ('jurado', $1, $2, $3, $4) returning id`,
        [`Jurado Test ${_seq}`, extra.categoria ?? 'A', extra.estado_usuario ?? 'activo', extra.activo ?? true]
    );
    return r[0].id;
}
async function nuevoDelegado() {
    _seq++;
    const r = await q(`insert into usuarios_pagados (tipo_persona, nombre_completo) values ('delegado_rentado', $1) returning id`, [`Delegado ${_seq}`]);
    return r[0].id;
}
function cambiarEstado(usuarioId, estadoNuevo, observacion = null) {
    return q(`select * from cambiar_estado_usuario_con_historial($1,$2,$3,$4,$5)`,
        [usuarioId, estadoNuevo, ID.admin, 'Admin Test', observacion]);
}
function suspender(usuarioId, desde, hasta, motivo) {
    return q(`select * from suspender_usuario_con_historial($1,$2,$3,$4,$5,$6)`,
        [usuarioId, desde, hasta, motivo, ID.admin, 'Admin Test']);
}
function cambiarCategoria(usuarioId, catNueva, justificacion = null, fechaEfectiva = null) {
    return q(`select * from cambiar_categoria_usuario_con_historial($1,$2,$3,$4,$5,$6)`,
        [usuarioId, catNueva, ID.admin, 'Admin Test', justificacion, fechaEfectiva]);
}
function marcarCondicion(usuarioId, tipo, activar, motivo = null) {
    return q(`select * from marcar_condicion_bloqueante_usuario($1,$2,$3,$4,$5,$6)`,
        [usuarioId, tipo, activar, motivo, ID.admin, 'Admin Test']);
}
async function usuario(id) { return (await q('select * from usuarios_pagados where id = $1', [id]))[0]; }
async function historialDe(id) { return q(`select * from usuario_historial_cambios where usuario_pagado_id = $1 order by cambiado_en, id`, [id]); }

describe('cambiar_estado_usuario_con_historial — atomicidad y validaciones', () => {
    test('activo → receso: actualiza usuarios_pagados Y registra historial en la misma llamada', async () => {
        const id = await nuevoJurado();
        await cambiarEstado(id, 'receso', 'Pausa solicitada');
        const u = await usuario(id);
        expect(u.estado_usuario).toBe('receso');
        expect(u.activo).toBe(false);
        const hist = await historialDe(id);
        expect(hist.length).toBe(1);
        expect(hist[0]).toMatchObject({ tipo_cambio: 'estado', valor_anterior: 'activo', valor_nuevo: 'receso', observacion: 'Pausa solicitada' });
    });

    test('estado inválido: rechaza y NO deja ningún registro histórico (nunca aplica una mitad del cambio)', async () => {
        const id = await nuevoJurado();
        await expect(cambiarEstado(id, 'no_existe')).rejects.toThrow(/ESTADO_INVALIDO/);
        const u = await usuario(id);
        expect(u.estado_usuario).toBe('activo'); // sin cambios
        expect(await historialDe(id)).toHaveLength(0);
    });

    test('reactivar desde suspendido limpia los campos de suspensión', async () => {
        const id = await nuevoJurado();
        await suspender(id, '2026-01-01', '2026-01-31', 'Motivo X');
        await cambiarEstado(id, 'activo');
        const u = await usuario(id);
        expect(u.estado_usuario).toBe('activo');
        expect(u.activo).toBe(true);
        expect(u.suspension_desde).toBeNull();
        expect(u.suspension_hasta).toBeNull();
        expect(u.suspension_motivo).toBeNull();
    });

    test('CASO (Fase 3) — no se puede reactivar mientras No certificado siga vigente: bloquea sin tocar nada', async () => {
        const id = await nuevoJurado({ estado_usuario: 'inactivo', activo: false });
        await marcarCondicion(id, 'no_certificado', true, 'Documentación vencida');
        await expect(cambiarEstado(id, 'activo')).rejects.toThrow(/CONDICION_BLOQUEANTE_VIGENTE/);
        const u = await usuario(id);
        expect(u.estado_usuario).toBe('inactivo'); // nunca se tocó
        expect(u.activo).toBe(false);
    });
});

describe('suspender_usuario_con_historial', () => {
    test('suspende y registra historial con rango de fechas y motivo, en una sola transacción', async () => {
        const id = await nuevoJurado();
        await suspender(id, '2026-03-01', '2026-03-15', 'Ausencia médica');
        const u = await usuario(id);
        expect(u.estado_usuario).toBe('suspendido');
        expect(u.activo).toBe(false);
        const hist = await historialDe(id);
        expect(hist[0]).toMatchObject({ tipo_cambio: 'suspension', valor_nuevo: 'suspendido', observacion: 'Ausencia médica' });
        expect(String(hist[0].fecha_desde)).toContain('2026-03-01');
        expect(String(hist[0].fecha_hasta)).toContain('2026-03-15');
    });

    test('rango de fechas invertido se rechaza, sin dejar historial', async () => {
        const id = await nuevoJurado();
        await expect(suspender(id, '2026-03-15', '2026-03-01', 'x')).rejects.toThrow(/RANGO_FECHA_INVALIDO/);
        expect(await historialDe(id)).toHaveLength(0);
    });

    test('motivo vacío se rechaza', async () => {
        const id = await nuevoJurado();
        await expect(suspender(id, '2026-03-01', '2026-03-15', '   ')).rejects.toThrow(/MOTIVO_REQUERIDO/);
    });
});

describe('cambiar_categoria_usuario_con_historial — Fase 4', () => {
    test('cambia de categoría y registra historial con justificación y fecha_efectiva', async () => {
        const id = await nuevoJurado({ categoria: 'A' });
        await cambiarCategoria(id, 'B', 'Buen desempeño en la temporada', '2026-06-01');
        const u = await usuario(id);
        expect(u.categoria).toBe('B');
        const hist = await historialDe(id);
        expect(hist[0]).toMatchObject({ tipo_cambio: 'categoria', valor_anterior: 'A', valor_nuevo: 'B', observacion: 'Buen desempeño en la temporada' });
        expect(String(hist[0].fecha_efectiva)).toContain('2026-06-01');
    });

    test('fecha_efectiva no indicada → usa la fecha de hoy, nunca queda NULL para un cambio nuevo', async () => {
        const id = await nuevoJurado({ categoria: 'A' });
        await cambiarCategoria(id, 'C');
        const hist = await historialDe(id);
        expect(hist[0].fecha_efectiva).not.toBeNull();
    });

    test('CASO (Fase 4) — cambiar hacia la MISMA categoría se rechaza, sin dejar historial', async () => {
        const id = await nuevoJurado({ categoria: 'A' });
        await expect(cambiarCategoria(id, 'A')).rejects.toThrow(/MISMA_CATEGORIA/);
        expect(await historialDe(id)).toHaveLength(0);
        expect((await usuario(id)).categoria).toBe('A');
    });

    test('un delegado (no jurado) no puede recibir categoría', async () => {
        const id = await nuevoDelegado();
        await expect(cambiarCategoria(id, 'A')).rejects.toThrow(/SOLO_JURADOS_TIENEN_CATEGORIA/);
    });

    test('categoría inválida se rechaza', async () => {
        const id = await nuevoJurado({ categoria: 'A' });
        await expect(cambiarCategoria(id, 'Z')).rejects.toThrow(/CATEGORIA_INVALIDA/);
    });

    test('atomicidad: el historial de categoría se conserva aunque el jurado cambie de categoría varias veces', async () => {
        const id = await nuevoJurado({ categoria: 'A' });
        await cambiarCategoria(id, 'B');
        await cambiarCategoria(id, 'C');
        await cambiarCategoria(id, 'A');
        const hist = await historialDe(id);
        expect(hist.map(h => h.valor_nuevo)).toEqual(['B', 'C', 'A']);
    });
});

describe('marcar_condicion_bloqueante_usuario — Fase 3, condiciones simultáneas', () => {
    test('marcar No certificado bloquea nuevas designaciones (activo=false) sin tocar estado_usuario', async () => {
        const id = await nuevoJurado(); // estado_usuario='activo', activo=true
        await marcarCondicion(id, 'no_certificado', true, 'Certificación vencida');
        const u = await usuario(id);
        expect(u.no_certificado).toBe(true);
        expect(u.estado_usuario).toBe('activo'); // el ciclo de vida no cambia
        expect(u.activo).toBe(false);            // pero el motor ya no lo ve disponible
    });

    test('CASO CRÍTICO (Fase 3) — condiciones simultáneas: suspendido Y no certificado a la vez, sin que una sobrescriba a la otra', async () => {
        const id = await nuevoJurado();
        await suspender(id, '2026-01-01', '2026-01-31', 'Suspensión temporal');
        await marcarCondicion(id, 'no_certificado', true, 'Documentación vencida');
        const u = await usuario(id);
        expect(u.estado_usuario).toBe('suspendido'); // la suspensión sigue intacta
        expect(u.no_certificado).toBe(true);          // y la nueva condición también está presente
        expect(u.en_retiro).toBe(false);
        expect(u.activo).toBe(false);
        // Revertir la suspensión activando el estado NO reactiva al usuario
        // mientras no_certificado siga vigente — ver describe anterior.
        await expect(cambiarEstado(id, 'activo')).rejects.toThrow(/CONDICION_BLOQUEANTE_VIGENTE/);
        // Revertir no_certificado tampoco reactiva por sí solo si estado_usuario no es 'activo'.
        await marcarCondicion(id, 'no_certificado', false);
        expect((await usuario(id)).activo).toBe(false);
        expect((await usuario(id)).estado_usuario).toBe('suspendido');
    });

    test('En retiro y No certificado pueden coexistir sin interferir entre sí', async () => {
        const id = await nuevoJurado();
        await marcarCondicion(id, 'no_certificado', true, 'Motivo A');
        await marcarCondicion(id, 'en_retiro', true, 'Motivo B');
        const u = await usuario(id);
        expect(u.no_certificado).toBe(true);
        expect(u.en_retiro).toBe(true);
        expect(u.activo).toBe(false);
        // Revertir una sola condición no reactiva mientras la otra siga vigente.
        await marcarCondicion(id, 'no_certificado', false);
        expect((await usuario(id)).activo).toBe(false);
        expect((await usuario(id)).en_retiro).toBe(true);
        // Revertir la última condición pendiente SÍ reactiva (estado_usuario ya era 'activo').
        await marcarCondicion(id, 'en_retiro', false);
        const u2 = await usuario(id);
        expect(u2.activo).toBe(true);
        expect(u2.no_certificado).toBe(false);
        expect(u2.en_retiro).toBe(false);
    });

    test('motivo obligatorio solo al ACTIVAR la condición, no al revertirla', async () => {
        const id = await nuevoJurado();
        await expect(marcarCondicion(id, 'en_retiro', true, '')).rejects.toThrow(/MOTIVO_REQUERIDO/);
        await marcarCondicion(id, 'en_retiro', true, 'Retiro voluntario');
        await expect(marcarCondicion(id, 'en_retiro', false)).resolves.toBeDefined(); // sin motivo, no revienta
    });

    test('registra historial con tipo_cambio distinguible para no_certificado y en_retiro', async () => {
        const id = await nuevoJurado();
        await marcarCondicion(id, 'en_retiro', true, 'Fin de carrera');
        const hist = await historialDe(id);
        expect(hist[0]).toMatchObject({ tipo_cambio: 'en_retiro', valor_anterior: 'false', valor_nuevo: 'true', observacion: 'Fin de carrera' });
    });

    test('tipo_condicion inválido se rechaza', async () => {
        const id = await nuevoJurado();
        await expect(marcarCondicion(id, 'otra_cosa', true, 'x')).rejects.toThrow(/TIPO_CONDICION_INVALIDO/);
    });
});

describe('usuario_observaciones_administrativas — Fase 2 (tabla append-only)', () => {
    test('se puede insertar y listar observaciones ligadas al usuario_pagado_id real', async () => {
        const id = await nuevoJurado();
        await q(`insert into usuario_observaciones_administrativas (usuario_pagado_id, contenido, creado_por, creado_por_nombre) values ($1,$2,$3,$4)`,
            [id, 'Primera observación', ID.admin, 'Admin Test']);
        await q(`insert into usuario_observaciones_administrativas (usuario_pagado_id, contenido, creado_por, creado_por_nombre) values ($1,$2,$3,$4)`,
            [id, 'Segunda observación', ID.admin, 'Admin Test']);
        const rows = await q(`select contenido from usuario_observaciones_administrativas where usuario_pagado_id = $1 order by creado_en`, [id]);
        expect(rows.map(r => r.contenido)).toEqual(['Primera observación', 'Segunda observación']);
    });

    test('contenido vacío se rechaza por el CHECK de la tabla', async () => {
        const id = await nuevoJurado();
        await expect(q(`insert into usuario_observaciones_administrativas (usuario_pagado_id, contenido, creado_por, creado_por_nombre) values ($1,$2,$3,$4)`,
            [id, '   ', ID.admin, 'Admin Test'])).rejects.toThrow();
    });
});
