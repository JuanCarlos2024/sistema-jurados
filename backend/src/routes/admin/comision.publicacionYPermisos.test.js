// Migración 103 — orquestación en Node:
//   · intentarAutoPublicar retiene la nota con revisiones de Comisión pendientes
//     y genera la revisión de resultados alterados antes de publicar.
//   · /aprobar y /finalizar ya no resuelven casos derivados sin la Comisión.
//   · cerrar el Ciclo 1 genera la revisión de resultados alterados.
//   · la Comisión Técnica no puede usar las rutas del analista (403) y los
//     roles legítimos siguen pasando.
const { crearSupabaseMemoria, llamarRouter } = require('../../services/__fixtures__/supabaseMemoria');

jest.mock('../../config/supabase', () => ({
    from: (...a) => global.__sb.from(...a),
    rpc: (...a) => global.__sb.rpc(...a)
}));
jest.mock('../../services/emailService', () => ({ enviarEmail: jest.fn(), enviar: jest.fn() }));
const { intentarAutoPublicar, continuarTrasDecisionComision } = require('../../services/publicacion');
const evaluaciones = require('./evaluaciones');
const casos = require('./casos');
const ciclos = require('./ciclos');
const respuestas = require('./respuestas-jurado');

let rpcs;
function base(extra = {}) {
    rpcs = [];
    const registrar = (nombre, resp) => (a) => { rpcs.push([nombre, a]); return typeof resp === 'function' ? resp(a) : resp; };
    global.__sb = crearSupabaseMemoria({
        tablas: {
            evaluaciones: [{ id: 'E1', rodeo_id: 'R1', estado: 'en_proceso', resultados_alterados: false }],
            evaluacion_ciclos: [
                { id: 'C1', evaluacion_id: 'E1', numero_ciclo: 1, estado: 'cerrado' },
                { id: 'C2', evaluacion_id: 'E1', numero_ciclo: 2, estado: 'cerrado' }
            ],
            evaluacion_casos: [],
            evaluacion_revisiones_comision: [],
            evaluacion_auditoria: [],
            evaluacion_respuestas_jurado: [],
            ...extra.tablas
        },
        rpc: {
            generar_revision_resultado_alterado: registrar('generar', { data: { creada: false, motivo: 'sin_alteracion' }, error: null }),
            publicar_evaluacion: registrar('publicar', { data: { ok: true, puntaje_final: 79, nota_final: 6.6, jurados_afectados: 1 }, error: null }),
            resolver_caso_derivado_comision: registrar('resolverB', (a) => ({ data: { evaluacion_id: 'E1', ciclo_id: 'C1', pendientes_restantes: 0 }, error: null })),
            ...extra.rpc
        }
    });
}

describe('intentarAutoPublicar — retención por Comisión', () => {
    test('sin pendientes y ciclos cerrados: genera (idempotente) y publica por el mecanismo habitual', async () => {
        base();
        const r = await intentarAutoPublicar('E1', 'ADM', 'Admin', null);
        expect(r).toMatchObject({ ok: true });
        expect(rpcs.map(x => x[0])).toEqual(['generar', 'publicar']);
        expect(rpcs[0][1]).toEqual({ p_evaluacion_id: 'E1', p_actor_id: 'ADM', p_origen: 'previo_publicacion' });
    });

    test('revisión Tipo A pendiente → NO publica', async () => {
        base({ tablas: { evaluacion_revisiones_comision: [{ id: 'RA', evaluacion_id: 'E1', estado: 'pendiente' }] } });
        expect(await intentarAutoPublicar('E1', 'ADM', 'Admin', null)).toBeNull();
        expect(rpcs.map(x => x[0])).toEqual(['generar']);
    });

    test('caso derivado (Tipo B) pendiente → NO publica', async () => {
        base({ tablas: { evaluacion_casos: [{ id: 'K', evaluacion_id: 'E1', ciclo_id: 'C1', estado: 'derivado_comision', decision_analista: 'derivar_comision' }] } });
        expect(await intentarAutoPublicar('E1', 'ADM', 'Admin', null)).toBeNull();
        expect(rpcs.map(x => x[0])).not.toContain('publicar');
    });

    test('si no se puede generar/verificar la revisión (p. ej. 103 sin aplicar) → ante la duda NO publica', async () => {
        base({ rpc: { generar_revision_resultado_alterado: () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }) } });
        expect(await intentarAutoPublicar('E1', 'ADM', 'Admin', null)).toBeNull();
        expect(rpcs.map(x => x[0])).not.toContain('publicar');
    });

    test('tras la última decisión de Comisión sin otros requisitos cumplidos: vuelve a en_proceso y no publica', async () => {
        base({ tablas: {
            evaluaciones: [{ id: 'E1', rodeo_id: 'R1', estado: 'pendiente_comision' }],
            evaluacion_ciclos: [{ id: 'C1', evaluacion_id: 'E1', numero_ciclo: 1, estado: 'cerrado' }, { id: 'C2', evaluacion_id: 'E1', numero_ciclo: 2, estado: 'abierto' }]
        } });
        const r = await continuarTrasDecisionComision({ evaluacion_id: 'E1', actor_id: 'COM', actor_nombre: 'C', ip: null });
        expect(r.publicado).toBe(false);
        expect(global.__sb.tablas.evaluaciones[0].estado).toBe('en_proceso');
        expect(rpcs.map(x => x[0])).not.toContain('publicar');
    });
});

describe('caminos alternativos cerrados', () => {
    const derivado = { id: 'KD', evaluacion_id: 'E1', ciclo_id: 'C1', tipo_caso: 'interpretativa', descuento_puntos: 1, estado: 'derivado_comision', decision_analista: 'derivar_comision', decision_comision: null };

    test('/aprobar NO resuelve el caso derivado antes de llamar a publicar (la RPC lo rechaza → 409)', async () => {
        base({ tablas: { evaluacion_casos: [{ ...derivado }] },
               rpc: { publicar_evaluacion: () => ({ data: null, error: { message: 'casos_pendientes: existen casos aún no resueltos' } }) } });
        const r = await llamarRouter(evaluaciones, { metodo: 'POST', url: '/E1/aprobar', params: { id: 'E1' } });
        expect(r.statusCode).toBe(409);
        expect(global.__sb.tablas.evaluacion_casos[0].estado).toBe('derivado_comision');
        expect(global.__sb.tablas.evaluacion_casos[0].resolucion_final).toBeUndefined();
        expect(global.__sb.calls.filter(c => c.tabla === 'evaluacion_casos' && c.op === 'update')).toEqual([]);
    });

    test('/aprobar con revisiones de Comisión pendientes → 409 con mensaje claro', async () => {
        base({ rpc: { publicar_evaluacion: () => ({ data: null, error: { message: 'revisiones_comision_pendientes: ...' } }) } });
        const r = await llamarRouter(evaluaciones, { metodo: 'POST', url: '/E1/aprobar', params: { id: 'E1' } });
        expect(r.statusCode).toBe(409);
        expect(r.body.code).toBe('REVISIONES_COMISION_PENDIENTES');
    });

    test('/finalizar con caso derivado sin decisión de Comisión → 409 y no toca nada', async () => {
        base({ tablas: { evaluacion_casos: [{ ...derivado }] } });
        const r = await llamarRouter(evaluaciones, { metodo: 'POST', url: '/E1/finalizar', params: { id: 'E1' } });
        expect(r.statusCode).toBe(409);
        expect(r.body.error).toMatch(/Comisión/);
        expect(global.__sb.calls.filter(c => c.op === 'update')).toEqual([]);
        expect(rpcs).toEqual([]);
    });

    test('/casos/:id/decision-comision (Bandeja existente) acepta los valores antiguos y los traduce a ERROR/ACIERTO vía RPC', async () => {
        base({ tablas: { evaluacion_casos: [{ ...derivado }] } });
        const r = await llamarRouter(casos, { metodo: 'POST', url: '/KD/decision-comision', params: { id: 'KD' },
            body: { decision: 'aprueba_apelacion', comentario_comision: 'Bien jurado' }, usuario: { id: 'COM', rol_evaluacion: 'comision_tecnica' } });
        expect(r.statusCode).toBe(200);
        expect(rpcs.find(x => x[0] === 'resolverB')[1]).toEqual({ p_caso_id: 'KD', p_decision: 'acierto', p_observacion: 'Bien jurado', p_actor_id: 'COM' });
    });
});

describe('cierre del Ciclo 1 genera la revisión de resultados alterados', () => {
    test('modo descuento automático: al cerrar el ciclo 1 se llama a generar con origen cierre_ciclo_1', async () => {
        base({ tablas: {
            evaluaciones: [{ id: 'E1', rodeo_id: 'R1', estado: 'en_proceso', resultados_alterados: true, modo_flujo: 'descuento_automatico' }],
            evaluacion_ciclos: [{ id: 'C1', evaluacion_id: 'E1', numero_ciclo: 1, estado: 'abierto', es_ciclo_sin_casos: true,
                                  evaluacion: { id: 'E1', rodeo_id: 'R1', modo_flujo: 'descuento_automatico' } }],
            asignaciones: []
        } });
        const r = await llamarRouter(ciclos, { metodo: 'POST', url: '/C1/cerrar', params: { id: 'C1' }, usuario: { id: 'AN', nombre: 'Ana', rol_evaluacion: 'analista' } });
        expect(r.statusCode).toBe(200);
        const gen = rpcs.filter(x => x[0] === 'generar');
        expect(gen[0][1]).toEqual({ p_evaluacion_id: 'E1', p_actor_id: 'AN', p_origen: 'cierre_ciclo_1' });
    });
});

describe('"Habilitar respuesta del jurado" no deshace decisiones de Comisión ni administrativas', () => {
    test('solo se reabren los casos sin decisión; los decididos por Comisión/Administración y los derivados pendientes quedan intactos', async () => {
        base({ tablas: {
            evaluaciones: [{ id: 'E1', rodeo_id: 'R1', estado: 'en_proceso' }],
            evaluacion_ciclos: [{ id: 'C1', evaluacion_id: 'E1', numero_ciclo: 1, estado: 'cerrado', evaluacion: { id: 'E1', estado: 'en_proceso' } }],
            evaluacion_casos: [
                { id: 'NORMAL', ciclo_id: 'C1', evaluacion_id: 'E1', estado: 'resuelto', resolucion_final: 'interpretativa_confirmada' },
                { id: 'COMISION', ciclo_id: 'C1', evaluacion_id: 'E1', estado: 'resuelto', resolucion_final: 'apelacion_acogida', decision_analista: 'derivar_comision', decision_comision: 'aprueba_apelacion' },
                { id: 'ADMIN', ciclo_id: 'C1', evaluacion_id: 'E1', estado: 'resuelto', resolucion_final: 'apelacion_acogida', decision_analista: 'derivar_comision', decision_admin_excepcional: 'acierto' },
                { id: 'PENDIENTE', ciclo_id: 'C1', evaluacion_id: 'E1', estado: 'derivado_comision', decision_analista: 'derivar_comision' }
            ]
        } });
        const r = await llamarRouter(ciclos, { metodo: 'POST', url: '/C1/habilitar-respuesta-jurado', params: { id: 'C1' }, body: { motivo: 'reabrir' }, usuario: { id: 'ADM', nombre: 'A', rol_evaluacion: null } });
        expect(r.statusCode).toBe(200);
        const caso = (id) => global.__sb.tablas.evaluacion_casos.find(c => c.id === id);
        expect(caso('NORMAL')).toMatchObject({ estado: 'visible_jurado', resolucion_final: null });
        expect(caso('COMISION')).toMatchObject({ estado: 'resuelto', resolucion_final: 'apelacion_acogida' });
        expect(caso('ADMIN')).toMatchObject({ estado: 'resuelto', resolucion_final: 'apelacion_acogida' });
        expect(caso('PENDIENTE').estado).toBe('derivado_comision');
    });
});

describe('permisos: la Comisión no modifica antecedentes del analista', () => {
    const COM = { id: 'COM', rol_evaluacion: 'comision_tecnica' };
    const casosProhibidos = [
        ['ciclos', ciclos, 'POST', '/C1/cerrar'], ['ciclos', ciclos, 'POST', '/C1/abrir'], ['ciclos', ciclos, 'POST', '/C1/reabrir'],
        ['ciclos', ciclos, 'POST', '/C1/abrir-sin-casos'], ['ciclos', ciclos, 'POST', '/C1/casos'], ['ciclos', ciclos, 'POST', '/C1/importar'],
        ['ciclos', ciclos, 'POST', '/C1/reenviar-notificacion'],
        ['casos', casos, 'POST', '/K/decision-analista'], ['casos', casos, 'PATCH', '/K/anular'], ['casos', casos, 'DELETE', '/K'],
        ['casos', casos, 'PATCH', '/K'], ['casos', casos, 'POST', '/K/guardar-en-banco'],
        ['respuestas', respuestas, 'POST', '/RJ/decision-analista'],
        ['evaluaciones', evaluaciones, 'PATCH', '/E1/datos-deportivos'], ['evaluaciones', evaluaciones, 'POST', '/E1/enviar-aprobacion'],
        ['evaluaciones', evaluaciones, 'PATCH', '/E1/anular'], ['evaluaciones', evaluaciones, 'POST', '/E1/aprobar'], ['evaluaciones', evaluaciones, 'POST', '/E1/finalizar']
    ];
    test.each(casosProhibidos)('%s %s %s → 403 sin escribir', async (_n, router, metodo, url) => {
        base();
        const r = await llamarRouter(router, { metodo, url, body: { motivo: 'x', comentario_analista: 'x', decision: 'mantener', comentario: 'x', comentario_banco: 'x' }, usuario: COM });
        expect(r.statusCode).toBe(403);
        expect(global.__sb.calls.filter(c => c.op !== 'select')).toEqual([]);
        expect(rpcs).toEqual([]);
    });

    test('los roles legítimos siguen pasando el control de rol (analista, jefe de área, admin pleno)', async () => {
        for (const rol of ['analista', 'jefe_area', null]) {
            base();
            const r = await llamarRouter(ciclos, { metodo: 'POST', url: '/NO-EXISTE/cerrar', params: { id: 'NO-EXISTE' }, usuario: { id: 'U', rol_evaluacion: rol } });
            expect(r.statusCode).toBe(404);   // llegó al handler (no 403)
        }
    });
});
