// CIERRE EXCEPCIONAL — ADMINISTRADOR (routes/admin/evaluaciones.js), con
// Supabase en memoria. La RPC transaccional se prueba contra PostgreSQL real
// en services/revisionesComision.rpc.test.js; aquí: permisos (incluido el
// acceso sin sesión), validaciones, cierre NORMAL de ciclos, publicación
// habitual solo si se cumplen los demás requisitos e historial.
const { crearSupabaseMemoria, llamarRouter } = require('../../services/__fixtures__/supabaseMemoria');

jest.mock('../../config/supabase', () => ({
    from: (...a) => global.__sb.from(...a),
    rpc: (...a) => global.__sb.rpc(...a)
}));
jest.mock('../../services/emailService', () => ({ enviarEmail: jest.fn(), enviar: jest.fn() }));
const router = require('./evaluaciones');
const comision = require('./comision');

const ADMIN = { id: 'ADM', nombre: 'Admin', rol_evaluacion: null };
let rpcs;

function base({ ciclo2 = 'abierto', rpcCierre } = {}) {
    rpcs = [];
    const tablas = {
        evaluaciones: [{ id: 'E1', rodeo_id: 'R1', estado: 'pendiente_comision', analista_id: 'AN', anulada: false, es_historica_importacion: false,
                         resultados_alterados: true, comentario_resultados_alterados: 'Se alteró el 2°', modo_flujo: 'descuento_automatico' }],
        rodeos: [{ id: 'R1', club: 'Club Uno', asociacion: 'Ñuble', fecha: '2026-11-01', tipo_rodeo_nombre: 'Provincial' }],
        asignaciones: [{ rodeo_id: 'R1', tipo_persona: 'jurado', estado: 'activo', estado_designacion: 'aceptado', usuarios_pagados: { nombre_completo: 'Juan Jurado' } }],
        administradores: [{ id: 'AN', nombre_completo: 'Ana Analista', activo: true, rol_evaluacion: 'analista' },
                          { id: 'ADM', nombre_completo: 'Admin Pleno', activo: true, rol_evaluacion: null }],
        evaluacion_ciclos: [
            { id: 'C1', evaluacion_id: 'E1', numero_ciclo: 1, estado: 'cerrado', evaluacion: { id: 'E1', rodeo_id: 'R1', modo_flujo: 'descuento_automatico' } },
            { id: 'C2', evaluacion_id: 'E1', numero_ciclo: 2, estado: ciclo2, es_ciclo_sin_casos: true, evaluacion: { id: 'E1', rodeo_id: 'R1', modo_flujo: 'descuento_automatico' } }
        ],
        evaluacion_casos: [
            { id: 'K1', evaluacion_id: 'E1', ciclo_id: 'C1', numero_caso: 1, tipo_caso: 'interpretativa', video_url: 'https://youtu.be/AAA', descuento_puntos: 1, estado: 'resuelto', anulado: false },
            { id: 'K2', evaluacion_id: 'E1', ciclo_id: 'C1', numero_caso: 2, tipo_caso: 'reglamentaria', video_url: 'https://youtu.be/BBB', descuento_puntos: 1,
              estado: 'derivado_comision', decision_analista: 'derivar_comision', comentario_analista: 'Dudoso', analista_decidio_en: '2026-11-02T10:00:00Z', anulado: false }
        ],
        evaluacion_revisiones_comision: [{ id: 'RA', evaluacion_id: 'E1', ciclo_id: 'C1', estado: 'pendiente', created_at: '2026-11-02T09:00:00Z' }],
        evaluacion_cierres_excepcionales: [],
        evaluacion_auditoria: [],
        evaluacion_respuestas_jurado: [],
        evaluacion_comentarios_jurado_ciclo: []
    };
    const registrar = (n, fn) => (a, ctx) => { rpcs.push([n, a]); return fn(a, ctx); };
    global.__sb = crearSupabaseMemoria({
        tablas,
        rpc: {
            cierre_excepcional_comision_admin: registrar('cierre', rpcCierre || ((a, { tablas: t }) => {
                // simula el tratamiento formal que hace la RPC real
                t.evaluacion_revisiones_comision[0].estado = 'cierre_excepcional';
                Object.assign(t.evaluacion_casos[1], { estado: 'resuelto', decision_admin_excepcional: a.p_decisiones[0]?.decision, resolucion_final: 'apelacion_rechazada' });
                t.evaluaciones[0].estado = 'en_proceso';
                t.evaluacion_cierres_excepcionales.push({ id: 'CIERRE-1', evaluacion_id: 'E1', administrador_id: 'ADM', motivo: a.p_motivo, resultado: null, created_at: '2026-11-18T10:00:00Z' });
                return { data: { cierre_id: 'CIERRE-1', tratamiento: { video_derivado: [{ caso_id: 'K2', decision_administrativa: a.p_decisiones[0]?.decision }] }, descuentos_considerados_total: 1 }, error: null };
            })),
            generar_revision_resultado_alterado: registrar('generar', () => ({ data: { creada: false, motivo: 'ya_existe' }, error: null })),
            publicar_evaluacion: registrar('publicar', (a, { tablas: t }) => {
                Object.assign(t.evaluaciones[0], { estado: 'publicado', nota_final: 6.6, puntaje_final: 79 });
                t.evaluacion_auditoria.push({ id: 'AUD-PUB', evaluacion_id: 'E1', accion: 'publicar_nota', created_at: '2026-11-18T10:00:01Z' });
                return { data: { ok: true, puntaje_final: 79, nota_final: 6.6 }, error: null };
            })
        }
    });
}

const cuerpo = (extra = {}) => ({ motivo: 'La Comisión no respondió en 30 días', decisiones: [{ caso_id: 'K2', decision: 'ERROR' }], ciclos_a_cerrar: ['C2'], confirmado: true, ...extra });
const post = (body, usuario = ADMIN) => llamarRouter(router, { metodo: 'POST', url: '/E1/cierre-excepcional', params: { id: 'E1' }, body, usuario });
const get = (usuario = ADMIN) => llamarRouter(router, { url: '/E1/cierre-excepcional', params: { id: 'E1' }, usuario });

describe('permisos: solo Administrador pleno', () => {
    test.each([['analista'], ['comision_tecnica'], ['jefe_area'], ['monitor'], ['director'], ['capacitador']])('rol %s → 403 (ver y ejecutar), sin tocar nada', async (rol) => {
        base();
        expect((await get({ id: 'X', rol_evaluacion: rol })).statusCode).toBe(403);
        expect((await post(cuerpo(), { id: 'X', rol_evaluacion: rol })).statusCode).toBe(403);
        expect(rpcs).toEqual([]);
        expect(global.__sb.calls.filter(c => c.op !== 'select')).toEqual([]);
    });

    test('sin sesión (sin token) → 401 en el router /admin, nunca llega a la ruta', async () => {
        base();
        const admin = require('./index');
        const r = await new Promise((resolve) => {
            const req = { method: 'POST', url: '/evaluaciones/E1/cierre-excepcional', originalUrl: '/api/admin/evaluaciones/E1/cierre-excepcional', headers: {}, body: cuerpo(), query: {}, params: {}, get() {} };
            const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; resolve(this); return this; }, setHeader() {} };
            admin(req, res, () => resolve(res));
        });
        expect(r.statusCode).toBe(401);
        expect(rpcs).toEqual([]);
    });
});

describe('validaciones previas', () => {
    test('sin confirmación expresa → 400; sin motivo → 400; ciclo ajeno → 400 (sin RPC)', async () => {
        base();
        expect((await post(cuerpo({ confirmado: undefined }))).statusCode).toBe(400);
        expect((await post(cuerpo({ confirmado: 'true' }))).statusCode).toBe(400);   // un "force" en texto no sirve
        expect((await post(cuerpo({ motivo: '  ' }))).statusCode).toBe(400);
        expect((await post(cuerpo({ ciclos_a_cerrar: ['C-OTRO'] }))).statusCode).toBe(400);
        expect(rpcs).toEqual([]);
    });

    test.each([
        ['ADMIN_NO_AUTORIZADO', 403], ['DECISIONES_TIPO_B_INCOMPLETAS', 400], ['DECISIONES_DESACTUALIZADAS', 409],
        ['SIN_PENDIENTES_COMISION', 409], ['EVALUACION_PUBLICADA', 409], ['MOTIVO_REQUERIDO', 400]
    ])('error de la RPC %s → %i, sin cerrar ciclos ni publicar', async (codigo, status) => {
        base({ rpcCierre: () => ({ data: null, error: { message: codigo } }) });
        const r = await post(cuerpo());
        expect(r.statusCode).toBe(status);
        expect(r.body.code).toBe(codigo);
        expect(rpcs.map(x => x[0])).toEqual(['cierre']);
        expect(global.__sb.tablas.evaluacion_ciclos[1].estado).toBe('abierto');
    });
});

describe('ejecución', () => {
    test('trata pendientes (decisión normalizada), cierra el ciclo con el procedimiento NORMAL y publica por la vía habitual; historial con resultado', async () => {
        base();
        const r = await post(cuerpo());
        expect(r.statusCode).toBe(200);
        expect(rpcs[0]).toEqual(['cierre', { p_evaluacion_id: 'E1', p_admin_id: 'ADM', p_motivo: 'La Comisión no respondió en 30 días', p_decisiones: [{ caso_id: 'K2', decision: 'error' }] }]);
        expect(global.__sb.tablas.evaluacion_ciclos[1].estado).toBe('cerrado');                        // cierre normal
        expect(rpcs.map(x => x[0])).toContain('publicar');
        expect(rpcs.filter(x => x[0] === 'publicar')).toHaveLength(1);                                  // una sola publicación
        expect(r.body).toMatchObject({ publicado: true, nota_final: 6.6, puntaje_final: 79, auditoria_publicacion_id: 'AUD-PUB', cierre_id: 'CIERRE-1' });
        const cierre = global.__sb.tablas.evaluacion_cierres_excepcionales[0];
        expect(cierre.resultado).toMatchObject({ publicado: true, nota_final: 6.6, auditoria_publicacion_id: 'AUD-PUB' });
        expect(cierre.resultado.intentos).toHaveLength(1);
        expect(cierre.resultado.intentos[0].ciclos_cerrados).toEqual([{ ciclo_id: 'C2', numero_ciclo: 2, cerrado: true, estado: 'cerrado', error: null }]);
        expect(r.body.ciclos_cerrados).toEqual(cierre.resultado.intentos[0].ciclos_cerrados);
    });

    test('si el Administrador NO cierra el otro ciclo, la nota NO se publica (no se omiten otros requisitos)', async () => {
        base();
        const r = await post(cuerpo({ ciclos_a_cerrar: [] }));
        expect(r.statusCode).toBe(200);
        expect(r.body.publicado).toBe(false);
        expect(r.body.mensaje).toMatch(/todavía no se publica/);
        expect(rpcs.map(x => x[0])).not.toContain('publicar');
        expect(global.__sb.tablas.evaluaciones[0].estado).toBe('en_proceso');
    });
});

describe('pantalla de datos (solo lectura)', () => {
    test('rodeo, jurados, ciclos (cuáles se pueden cerrar), pendientes con videos, comentarios y descuentos propuestos', async () => {
        base();
        const r = await get();
        expect(r.statusCode).toBe(200);
        expect(r.body.evaluacion).toMatchObject({ club: 'Club Uno', asociacion: 'Ñuble', jurados: ['Juan Jurado'], analista: 'Ana Analista' });
        expect(r.body.ciclos).toEqual([
            { ciclo_id: 'C1', numero_ciclo: 1, estado: 'cerrado', puede_cerrarse: false },
            { ciclo_id: 'C2', numero_ciclo: 2, estado: 'abierto', puede_cerrarse: true }
        ]);
        expect(r.body.pendientes.resultado_alterado[0]).toMatchObject({ revision_id: 'RA', comentario_alteracion: 'Se alteró el 2°' });
        expect(r.body.pendientes.resultado_alterado[0].videos_ciclo_1.map(v => v.video_url)).toEqual(['https://youtu.be/AAA', 'https://youtu.be/BBB']);
        expect(r.body.pendientes.video_derivado).toEqual([expect.objectContaining({ caso_id: 'K2', descuento_propuesto: 1, comentario_analista: 'Dudoso', video_url: 'https://youtu.be/BBB' })]);
        expect(r.body.puede_cerrar_excepcionalmente).toBe(true);
        expect(global.__sb.calls.filter(c => c.op !== 'select')).toEqual([]);
    });
});

// Fallo simulado en la escritura de ciclos (p. ej. corte de red) durante el cierre normal.
function fallarActualizacionCiclos(veces = 1) {
    const fromOrig = global.__sb.from;
    let restantes = veces;
    global.__sb.from = (t) => {
        const q = fromOrig(t);
        if (t === 'evaluacion_ciclos') {
            const upd = q.update;
            q.update = (...a) => { if (restantes > 0) { restantes--; throw new Error('fallo simulado de red'); } return upd(...a); };
        }
        return q;
    };
}
const completar = (body = { ciclos_a_cerrar: ['C2'], confirmado: true }, usuario = ADMIN) =>
    llamarRouter(router, { metodo: 'POST', url: '/E1/cierre-excepcional/completar', params: { id: 'E1' }, body, usuario });
const publicaciones = () => rpcs.filter(x => x[0] === 'publicar').length;

describe('fallos parciales y recuperación (sin tocar Supabase a mano)', () => {
    test('E: falla el cierre del ciclo después de tratar los pendientes → no se publica nada, queda registrado como incompleto y recuperable', async () => {
        base();
        fallarActualizacionCiclos(1);
        const r = await post(cuerpo());
        expect(r.statusCode).toBe(200);
        expect(r.body).toMatchObject({ publicado: false, completo: false, ultimo_error: 'fallo simulado de red' });
        expect(r.body.mensaje).toMatch(/Completar cierre excepcional/);
        expect(publicaciones()).toBe(0);
        expect(global.__sb.tablas.evaluaciones[0].estado).toBe('en_proceso');           // nunca "publicado"
        const cierre = global.__sb.tablas.evaluacion_cierres_excepcionales[0];
        expect(cierre.resultado.intentos).toHaveLength(1);
        expect(cierre.resultado.intentos[0]).toMatchObject({ n: 1, tipo: 'inicial', publicado: false, error: 'fallo simulado de red' });
        expect(global.__sb.tablas.evaluacion_auditoria.filter(a => a.accion === 'cierre_excepcional_resultado')).toHaveLength(1);

        // La pantalla ofrece completarlo.
        const datos = (await get()).body;
        expect(datos.puede_cerrar_excepcionalmente).toBe(false);
        expect(datos.cierre_por_completar).toMatchObject({ cierre_id: 'CIERRE-1', motivo: 'La Comisión no respondió en 30 días' });
        expect(datos.cierre_por_completar.resultado.ultimo_error).toBe('fallo simulado de red');

        // Reintento: NO vuelve a llamar a la RPC de decisiones; cierra normal y publica UNA vez.
        const c = await completar();
        expect(c.statusCode).toBe(200);
        expect(c.body).toMatchObject({ publicado: true, completo: true, nota_final: 6.6 });
        expect(rpcs.filter(x => x[0] === 'cierre')).toHaveLength(1);
        expect(publicaciones()).toBe(1);
        expect(global.__sb.tablas.evaluacion_cierres_excepcionales[0].resultado.intentos.map(i => i.tipo)).toEqual(['inicial', 'reintento']);
        expect(global.__sb.tablas.evaluacion_auditoria.filter(a => a.accion === 'cierre_excepcional_reintento')).toHaveLength(1);

        // F: otro reintento ya no hace nada (ni segunda publicación).
        const otra = await completar();
        expect(otra.statusCode).toBe(409);
        expect(otra.body.code).toBe('EVALUACION_PUBLICADA');
        expect(publicaciones()).toBe(1);
    });

    test('E: la publicación es rechazada por otra condición → la evaluación vuelve a su estado (no queda "publicada" ni trabada) y se puede reintentar', async () => {
        base();
        let rechazar = true;
        global.__sb.rpc = ((orig) => (n, a) => {
            if (n === 'publicar_evaluacion' && rechazar) { rpcs.push(['publicar-rechazada', a]); return Promise.resolve({ data: null, error: { message: 'sin_jurados: no se encontró ningún jurado activo' } }); }
            return orig(n, a);
        })(global.__sb.rpc);
        const r = await post(cuerpo());
        expect(r.body).toMatchObject({ publicado: false, completo: false });
        expect(global.__sb.tablas.evaluaciones[0].estado).toBe('en_proceso');       // revertido: recuperable
        rechazar = false;                                                             // se corrigió la causa (p. ej. se designó el jurado)
        const c = await completar({ ciclos_a_cerrar: [], confirmado: true });
        expect(c.body).toMatchObject({ publicado: true });
        expect(publicaciones()).toBe(1);
    });

    test('completar: solo Administrador pleno, con confirmación, y nunca si aparecieron pendientes nuevos', async () => {
        base();
        await post(cuerpo({ ciclos_a_cerrar: [] }));                                 // cierre sin cerrar el ciclo 2 → nota pendiente
        for (const rol of ['analista', 'comision_tecnica', 'jefe_area']) {
            expect((await completar(undefined, { id: 'X', rol_evaluacion: rol })).statusCode).toBe(403);
        }
        expect((await completar({ ciclos_a_cerrar: ['C2'] })).statusCode).toBe(400);   // sin confirmación
        global.__sb.tablas.evaluacion_revisiones_comision.push({ id: 'RA2', evaluacion_id: 'E1', estado: 'pendiente', created_at: '2026-11-19T00:00:00Z' });
        const r = await completar();
        expect(r.statusCode).toBe(409);
        expect(r.body.code).toBe('PENDIENTES_NUEVOS');
        expect(publicaciones()).toBe(0);
    });

    // Revalidación en BD: el token (hasta 8 h) dice "Administrador pleno",
    // pero la cuenta cambió después de emitido.
    test.each([
        ['desactivado', { activo: false }],
        ['con activo NULL', { activo: null }],
        ['con rol de evaluación asignado después', { rol_evaluacion: 'analista' }],
        ['eliminado / inexistente', null]
    ])('completar: administrador %s en BD → 403 ADMIN_NO_AUTORIZADO, sin cerrar ciclos, publicar ni escribir', async (_n, cambio) => {
        base();
        await post(cuerpo({ ciclos_a_cerrar: [] }));                                 // cierre registrado, nota pendiente
        const t = global.__sb.tablas;
        if (cambio === null) t.administradores = t.administradores.filter(a => a.id !== 'ADM');
        else Object.assign(t.administradores.find(a => a.id === 'ADM'), cambio);
        const escriturasAntes = global.__sb.calls.filter(c => c.op !== 'select').length;
        const intentosAntes = t.evaluacion_cierres_excepcionales[0].resultado.intentos.length;

        const r = await completar();

        expect(r.statusCode).toBe(403);
        expect(r.body.code).toBe('ADMIN_NO_AUTORIZADO');
        expect(publicaciones()).toBe(0);
        expect(t.evaluacion_ciclos[1].estado).toBe('abierto');
        expect(global.__sb.calls.filter(c => c.op !== 'select').length).toBe(escriturasAntes);
        expect(t.evaluacion_cierres_excepcionales[0].resultado.intentos).toHaveLength(intentosAntes);
    });

    test('completar: si no se puede consultar al administrador → 503 y no se actúa (falla cerrado)', async () => {
        base();
        await post(cuerpo({ ciclos_a_cerrar: [] }));
        const fromOrig = global.__sb.from;
        global.__sb.from = (t) => {
            const q = fromOrig(t);
            if (t === 'administradores') q.maybeSingle = () => Promise.resolve({ data: null, error: { message: 'timeout' } });
            return q;
        };
        const r = await completar();
        expect(r.statusCode).toBe(503);
        expect(r.body.code).toBe('VALIDACION_ADMIN_NO_DISPONIBLE');
        expect(publicaciones()).toBe(0);
        expect(global.__sb.tablas.evaluacion_ciclos[1].estado).toBe('abierto');
    });

    test('completar: Administrador pleno y activo en BD → sigue publicando por la vía habitual (sin cambios en el cálculo)', async () => {
        base();
        await post(cuerpo({ ciclos_a_cerrar: [] }));
        const r = await completar();
        expect(r.statusCode).toBe(200);
        expect(r.body).toMatchObject({ publicado: true, nota_final: 6.6, puntaje_final: 79 });
        expect(publicaciones()).toBe(1);
        expect(global.__sb.calls.some(c => c.tabla === 'administradores' && c.filtros.some(f => JSON.stringify(f).includes('ADM')))).toBe(true);
    });

    test('sin cierre excepcional previo → 409 (completar no sustituye al cierre)', async () => {
        base();
        global.__sb.tablas.evaluaciones[0].estado = 'en_proceso';
        global.__sb.tablas.evaluacion_revisiones_comision = [];
        global.__sb.tablas.evaluacion_casos[1].estado = 'resuelto';
        const r = await completar();
        expect(r.statusCode).toBe(409);
        expect(r.body.code).toBe('SIN_CIERRE_EXCEPCIONAL');
    });
});

describe('escenarios de publicación A–F', () => {
    const { intentarAutoPublicar } = require('../../services/publicacion');
    const listo = () => {
        base({ ciclo2: 'cerrado' });
        global.__sb.tablas.evaluaciones[0].estado = 'en_proceso';
        global.__sb.tablas.evaluacion_revisiones_comision[0].estado = 'resuelta';
        Object.assign(global.__sb.tablas.evaluacion_casos[1], { estado: 'resuelto', decision_comision: 'rechaza_apelacion' });
    };

    test('A: ambos ciclos cerrados y todo resuelto → publicación automática normal', async () => {
        listo();
        expect(await intentarAutoPublicar('E1', 'ADM', 'A', null)).toMatchObject({ ok: true });
        expect(publicaciones()).toBe(1);
    });

    test('B: ambos ciclos cerrados pero revisiones pendientes → bloqueada', async () => {
        base({ ciclo2: 'cerrado' });
        global.__sb.tablas.evaluaciones[0].estado = 'en_proceso';
        expect(await intentarAutoPublicar('E1', 'ADM', 'A', null)).toBeNull();
        expect(publicaciones()).toBe(0);
    });

    test('C: cierre excepcional que deja todo cumplido → se publica por la vía habitual', async () => {
        base({ ciclo2: 'cerrado' });
        const r = await post(cuerpo({ ciclos_a_cerrar: [] }));
        expect(r.body.publicado).toBe(true);
        expect(publicaciones()).toBe(1);
    });

    test('D: cierre excepcional cerrando solo un ciclo → la nota queda pendiente hasta completar el otro', async () => {
        base();
        expect((await post(cuerpo({ ciclos_a_cerrar: [] }))).body.publicado).toBe(false);
        expect(global.__sb.tablas.evaluacion_ciclos[1].estado).toBe('abierto');
        expect((await completar()).body.publicado).toBe(true);
    });

    test('F: carrera — si otro proceso publica entre la lectura y la transición, NO hay segunda publicación ni se pisa el estado', async () => {
        listo();
        const fromOrig = global.__sb.from;
        global.__sb.from = (t) => {
            const q = fromOrig(t);
            // justo después de verificar los casos (paso 3), otro proceso publica
            if (t === 'evaluacion_casos') global.__sb.tablas.evaluaciones[0].estado = 'publicado';
            return q;
        };
        expect(await intentarAutoPublicar('E1', 'ADM', 'A', null)).toBeNull();
        expect(publicaciones()).toBe(0);
        expect(global.__sb.tablas.evaluaciones[0].estado).toBe('publicado');
    });

    test('F: ya publicada → ninguna llamada posterior publica de nuevo', async () => {
        listo();
        await intentarAutoPublicar('E1', 'ADM', 'A', null);
        await intentarAutoPublicar('E1', 'ADM', 'A', null);
        expect(publicaciones()).toBe(1);
    });
});

describe('después del cierre excepcional', () => {
    test('el portal de Comisión lo muestra como resuelto por Administración / cierre excepcional y rechaza respuestas tardías (409)', async () => {
        base();
        await post(cuerpo());
        global.__sb.rpc = (n) => n === 'resolver_revision_resultado_alterado'
            ? Promise.resolve({ data: null, error: { message: 'REVISION_CERRADA_EXCEPCIONAL' } })
            : Promise.resolve({ data: null, error: { message: 'CASO_CERRADO_EXCEPCIONAL' } });
        const COM = { id: 'COM', rol_evaluacion: 'comision_tecnica' };
        const lista = await llamarRouter(comision, { url: '/revisiones', query: { estado: 'todos' }, usuario: COM });
        const porId = Object.fromEntries(lista.body.items.map(i => [i.id, i]));
        expect(porId.RA).toMatchObject({ estado: 'resuelto', decision: null, resuelto_por_tipo: 'cierre_excepcional' });
        expect(porId.K2).toMatchObject({ estado: 'resuelto', decision: 'error', resuelto_por_tipo: 'administracion' });
        const r1 = await llamarRouter(comision, { metodo: 'POST', url: '/revisiones/resultado_alterado/RA/resolver', body: { decision: 'error', observacion: 'tarde' }, usuario: COM });
        expect(r1.statusCode).toBe(409);
        expect(r1.body.code).toBe('REVISION_CERRADA_EXCEPCIONAL');
        const r2 = await llamarRouter(comision, { metodo: 'POST', url: '/revisiones/video_derivado/K2/resolver', body: { decision: 'acierto', observacion: 'tarde' }, usuario: COM });
        expect(r2.statusCode).toBe(409);
        expect(r2.body.code).toBe('CASO_CERRADO_EXCEPCIONAL');
    });
});
