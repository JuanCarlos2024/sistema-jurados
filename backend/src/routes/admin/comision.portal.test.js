// Portal "REVISIÓN DE CASOS — COMISIÓN" (routes/admin/comision.js) y su
// servicio (services/revisionesComision.js), con Supabase en memoria. Las
// RPC de escritura (migración 103) se prueban contra PostgreSQL real en
// services/revisionesComision.rpc.test.js; aquí se prueba la orquestación:
// permisos, contadores, filtros, orden, detalle de solo lectura y la
// resolución ERROR/ACIERTO.
const { crearSupabaseMemoria, llamarRouter } = require('../../services/__fixtures__/supabaseMemoria');

jest.mock('../../config/supabase', () => ({
    from: (...a) => global.__sb.from(...a),
    rpc: (...a) => global.__sb.rpc(...a)
}));
const router = require('./comision');
const { resumirPorEvaluacion } = require('../../services/revisionesComision');

const COMISION = { id: 'COM-1', nombre: 'Carla', rol_evaluacion: 'comision_tecnica' };
const jur = (rodeo_id, nombre) => ({ rodeo_id, tipo_persona: 'jurado', estado: 'activo', estado_designacion: 'aceptado', nombre_importado: null, usuarios_pagados: { nombre_completo: nombre } });

function datos() {
    return {
        rodeos: [
            { id: 'R-OCT', club: 'Club Octubre', asociacion: 'Ñuble', fecha: '2026-10-05', tipo_rodeo_nombre: 'Provincial' },
            { id: 'R-NOV1', club: 'Club Nov Uno', asociacion: 'Maule', fecha: '2026-11-08', tipo_rodeo_nombre: 'Provincial' },
            { id: 'R-NOV2', club: 'Club Nov Dos', asociacion: 'Talca', fecha: '2026-11-02', tipo_rodeo_nombre: 'Nacional' },
            { id: 'R-ANUL', club: 'Club Anulado', asociacion: 'X', fecha: '2026-11-03', tipo_rodeo_nombre: 'P' }
        ],
        evaluaciones: [
            { id: 'E-OCT', rodeo_id: 'R-OCT', estado: 'pendiente_comision', analista_id: 'AN-1', anulada: false, es_historica_importacion: false },
            { id: 'E-NOV1', rodeo_id: 'R-NOV1', estado: 'pendiente_comision', analista_id: 'AN-1', anulada: false, es_historica_importacion: false,
              puntaje_analista_1er: '30', puntaje_analista_2do: '27+8', puntaje_analista_3er: '25', observacion_general: 'Análisis general',
              resultados_alterados: true, comentario_resultados_alterados: 'Se alteró el 2°', casos_whatsapp: 2 },
            { id: 'E-NOV2', rodeo_id: 'R-NOV2', estado: 'en_proceso', analista_id: 'AN-1', anulada: false, es_historica_importacion: false },
            { id: 'E-ANUL', rodeo_id: 'R-ANUL', estado: 'pendiente_comision', analista_id: 'AN-1', anulada: true, es_historica_importacion: false }
        ],
        asignaciones: [jur('R-OCT', 'Juan Uno'), jur('R-NOV1', 'Pedro Dos'), jur('R-NOV1', 'Luis Tres'), jur('R-NOV2', 'Ana Cuatro')],
        administradores: [{ id: 'AN-1', nombre_completo: 'Ana Analista' }, { id: 'COM-1', nombre_completo: 'Carla Comisión' }],
        evaluacion_ciclos: [
            { id: 'C1-OCT', evaluacion_id: 'E-OCT', numero_ciclo: 1, estado: 'cerrado' },
            { id: 'C1-NOV1', evaluacion_id: 'E-NOV1', numero_ciclo: 1, estado: 'cerrado' },
            { id: 'C2-NOV1', evaluacion_id: 'E-NOV1', numero_ciclo: 2, estado: 'abierto' },
            { id: 'C1-NOV2', evaluacion_id: 'E-NOV2', numero_ciclo: 1, estado: 'cerrado' },
            { id: 'C2-NOV2', evaluacion_id: 'E-NOV2', numero_ciclo: 2, estado: 'cerrado' }
        ],
        evaluacion_revisiones_comision: [
            { id: 'RA-OCT', evaluacion_id: 'E-OCT', ciclo_id: 'C1-OCT', estado: 'pendiente', created_at: '2026-10-06T10:00:00Z' },
            { id: 'RA-NOV1', evaluacion_id: 'E-NOV1', ciclo_id: 'C1-NOV1', estado: 'pendiente', created_at: '2026-11-09T10:00:00Z' },
            { id: 'RA-NOV2', evaluacion_id: 'E-NOV2', ciclo_id: 'C1-NOV2', estado: 'resuelta', decision: 'acierto', observacion_comision: 'Correcto', resuelto_por: 'COM-1', resuelto_en: '2026-11-10T10:00:00Z', created_at: '2026-11-03T10:00:00Z' },
            { id: 'RA-ANUL', evaluacion_id: 'E-ANUL', ciclo_id: null, estado: 'pendiente', created_at: '2026-11-04T10:00:00Z' },
            { id: 'RA-X', evaluacion_id: 'E-NOV2', ciclo_id: 'C1-NOV2', estado: 'anulada', created_at: '2026-11-03T09:00:00Z' }
        ],
        evaluacion_casos: [
            // E-NOV1: ciclo 1 con 2 videos; uno además derivado (Tipo B pendiente); ciclo 2 con 1 caso.
            { id: 'K1', evaluacion_id: 'E-NOV1', ciclo_id: 'C1-NOV1', numero_caso: 1, tipo_caso: 'interpretativa', descripcion: 'Atajada', video_url: 'https://youtu.be/AAA', descuento_puntos: 1, estado: 'resuelto', decision_analista: null, anulado: false },
            { id: 'K2', evaluacion_id: 'E-NOV1', ciclo_id: 'C1-NOV1', numero_caso: 2, tipo_caso: 'reglamentaria', descripcion: 'Puerta', video_url: 'https://youtu.be/BBB', descuento_puntos: 1, estado: 'derivado_comision', decision_analista: 'derivar_comision', comentario_analista: 'Dudoso', analista_decidio_en: '2026-11-09T12:00:00Z', anulado: false },
            { id: 'K3', evaluacion_id: 'E-NOV1', ciclo_id: 'C2-NOV1', numero_caso: 1, tipo_caso: 'interpretativa', video_url: 'https://youtu.be/CCC', descuento_puntos: 1, estado: 'resuelto', anulado: false },
            // E-NOV2: un caso derivado ya resuelto con ERROR (rechaza_apelacion).
            { id: 'K4', evaluacion_id: 'E-NOV2', ciclo_id: 'C2-NOV2', numero_caso: 1, tipo_caso: 'interpretativa', video_url: 'https://youtu.be/DDD', descuento_puntos: 1, estado: 'resuelto', decision_analista: 'derivar_comision', decision_comision: 'rechaza_apelacion', comentario_comision: 'Error claro', comision_miembro_id: 'COM-1', comision_decidio_en: '2026-11-11T10:00:00Z', analista_decidio_en: '2026-11-04T10:00:00Z', anulado: false },
            // caso derivado y luego anulado: no cuenta
            { id: 'K5', evaluacion_id: 'E-NOV2', ciclo_id: 'C2-NOV2', numero_caso: 2, tipo_caso: 'interpretativa', descuento_puntos: 1, estado: 'resuelto', decision_analista: 'derivar_comision', anulado: true }
        ],
        datos_monitor_rodeo: [{ rodeo_id: 'R-NOV1', puntaje_oficial_1er: '30', puntaje_oficial_2do: '27', puntaje_oficial_3er: null, comentario_monitor: 'Comentario del monitor' }],
        control_gestion_situaciones: [{ rodeo_id: 'R-NOV1', categoria_principal: 'Atraso de inicio', subcategoria: null, descripcion_unificada: 'Inicio 30 min tarde', impacto: 'Bajo' }]
    };
}

let rpcLlamadas;
beforeEach(() => {
    rpcLlamadas = [];
    global.__sb = crearSupabaseMemoria({
        tablas: datos(),
        rpc: {
            resolver_revision_resultado_alterado: (a, { tablas }) => {
                rpcLlamadas.push(['A', a]);
                const r = tablas.evaluacion_revisiones_comision.find(x => x.id === a.p_revision_id);
                if (r.estado === 'resuelta') return { data: null, error: { message: 'REVISION_YA_RESUELTA' } };
                Object.assign(r, { estado: 'resuelta', decision: a.p_decision, observacion_comision: a.p_observacion, resuelto_por: a.p_actor_id, resuelto_en: '2026-11-18T10:00:00Z' });
                return { data: { evaluacion_id: r.evaluacion_id, pendientes_restantes: 0 }, error: null };
            },
            resolver_caso_derivado_comision: (a, { tablas }) => {
                rpcLlamadas.push(['B', a]);
                const c = tablas.evaluacion_casos.find(x => x.id === a.p_caso_id);
                if (c.estado !== 'derivado_comision') return { data: null, error: { message: 'CASO_NO_DERIVADO: estado actual resuelto' } };
                Object.assign(c, { estado: 'resuelto', decision_comision: a.p_decision === 'error' ? 'rechaza_apelacion' : 'aprueba_apelacion', comentario_comision: a.p_observacion });
                return { data: { evaluacion_id: c.evaluacion_id, ciclo_id: c.ciclo_id, pendientes_restantes: 1 }, error: null };
            },
            generar_revision_resultado_alterado: () => ({ data: { creada: false, motivo: 'ya_existe' }, error: null }),
            publicar_evaluacion: () => { throw new Error('la Comisión nunca debe publicar directamente en este escenario'); }
        }
    });
});

const get = (url, query = {}, usuario = COMISION) => llamarRouter(router, { url, query, usuario });
const resolver = (tipo, id, body, usuario = COMISION) => llamarRouter(router, { metodo: 'POST', url: `/revisiones/${tipo}/${id}/resolver`, body, usuario });
const escrituras = () => global.__sb.calls.filter(c => ['insert', 'update', 'upsert', 'delete'].includes(c.op));

describe('permisos', () => {
    test.each([['comision_tecnica'], ['jefe_area'], [null]])('rol %s accede', async (rol) => {
        expect((await get('/revisiones', {}, { id: 'X', rol_evaluacion: rol })).statusCode).toBe(200);
    });
    test.each([['analista'], ['monitor'], ['director'], ['capacitador']])('rol %s → 403 (no puede ver ni resolver)', async (rol) => {
        expect((await get('/revisiones', {}, { id: 'X', rol_evaluacion: rol })).statusCode).toBe(403);
        expect((await resolver('resultado_alterado', 'RA-NOV1', { decision: 'error', observacion: 'x' }, { id: 'X', rol_evaluacion: rol })).statusCode).toBe(403);
        expect(rpcLlamadas).toEqual([]);
    });
});

describe('listado y contadores', () => {
    test('por defecto: solo pendientes, más antiguos primero; anuladas (revisión o evaluación) nunca aparecen', async () => {
        const r = await get('/revisiones');
        expect(r.body.items.map(i => `${i.tipo}:${i.id}`)).toEqual(['resultado_alterado:RA-OCT', 'resultado_alterado:RA-NOV1', 'video_derivado:K2']);
        expect(r.body.items[1]).toMatchObject({ club: 'Club Nov Uno', asociacion: 'Maule', fecha_rodeo: '2026-11-08', jurados: ['Pedro Dos', 'Luis Tres'], estado: 'pendiente', ciclo: 1 });
    });

    test('filtro de noviembre: los pendientes de octubre no salen en la lista pero SIGUEN en el contador total, con advertencia', async () => {
        const r = await get('/revisiones', { desde: '2026-11-01', hasta: '2026-11-30' });
        expect(r.body.items.map(i => i.id)).toEqual(['RA-NOV1', 'K2']);
        expect(r.body.contadores.pendientes_totales).toBe(3);
        expect(r.body.contadores.pendientes_fuera_del_periodo).toBe(1);
        expect(r.body.contadores.pendientes_anteriores).toBe(1);
        expect(r.body.contadores.periodo.resultado_alterado).toEqual({ total: 2, resueltas: 1, pendientes: 1 });
        expect(r.body.contadores.periodo.video_derivado).toEqual({ total: 2, resueltas: 1, pendientes: 1 });
        expect(r.body.contadores.pendientes_totales_por_tipo).toEqual({ resultado_alterado: 2, video_derivado: 1 });
    });

    test('filtros por tipo, estado y resolución; nunca escriben nada', async () => {
        expect((await get('/revisiones', { tipo: 'video_derivado', estado: 'todos' })).body.items.map(i => i.id)).toEqual(['K2', 'K4']);
        expect((await get('/revisiones', { estado: 'resueltos' })).body.items.map(i => i.id)).toEqual(['K4', 'RA-NOV2']);   // últimos decididos primero
        expect((await get('/revisiones', { estado: 'todos', resolucion: 'error' })).body.items.map(i => i.id)).toEqual(['K4']);
        expect((await get('/revisiones', { estado: 'todos', resolucion: 'acierto' })).body.items.map(i => i.id)).toEqual(['RA-NOV2']);
        expect(escrituras()).toEqual([]);
    });

    test('fecha mal escrita → 400', async () => {
        expect((await get('/revisiones', { desde: '01-11-2026' })).statusCode).toBe(400);
    });
});

describe('avance X/Y por evaluación (columna Comisión)', () => {
    test('0/5 … 5/5 y estados Pendiente / En revisión / Revisado', () => {
        const filas = (resueltas) => Array.from({ length: 5 }, (_, i) => ({ evaluacion_id: 'E', tipo: i ? 'video_derivado' : 'resultado_alterado', pendiente: i >= resueltas, decision: i < resueltas ? 'error' : null }));
        expect(resumirPorEvaluacion(filas(0)).E.etiqueta).toBe('Pendiente 0/5');
        expect(resumirPorEvaluacion(filas(1)).E.etiqueta).toBe('En revisión 1/5');
        expect(resumirPorEvaluacion(filas(4)).E.etiqueta).toBe('En revisión 4/5');
        expect(resumirPorEvaluacion(filas(5)).E.etiqueta).toBe('Revisado 5/5');
        expect(resumirPorEvaluacion(filas(5)).E.estado).toBe('resuelto');
    });
});

describe('Ver caso (solo lectura)', () => {
    test('Tipo A: encabezado, puntajes con diferencias, comentarios, situaciones y TODOS los videos del Ciclo 1 (el derivado marcado, sin duplicar)', async () => {
        const r = await get('/revisiones/resultado_alterado/RA-NOV1');
        expect(r.statusCode).toBe(200);
        const d = r.body;
        expect(d.encabezado).toEqual({ club: 'Club Nov Uno', asociacion: 'Maule', fecha: '2026-11-08', tipo_rodeo: 'Provincial', analista: 'Ana Analista', jurados: ['Pedro Dos', 'Luis Tres'], ciclo: 1 });
        expect(d.analisis.puntajes).toEqual([
            { lugar: 1, oficial: '30', revisado: '30', diferencia: { igual: true, texto: 'Sin diferencia' } },
            { lugar: 2, oficial: '27', revisado: '27+8', diferencia: { igual: false, texto: 'Distinto' } },
            { lugar: 3, oficial: null, revisado: '25', diferencia: null }
        ]);
        expect(d.analisis).toMatchObject({ casos_whatsapp: 2, observacion_general: 'Análisis general', comentario_monitor: 'Comentario del monitor' });
        expect(d.analisis.situaciones).toEqual([{ categoria: 'Atraso de inicio', subcategoria: null, descripcion: 'Inicio 30 min tarde', impacto: 'Bajo' }]);
        expect(d.resultado_alterado.comentario).toBe('Se alteró el 2°');
        expect(d.resultado_alterado.videos_ciclo_1.map(v => [v.id, v.video_url, v.derivado_a_comision])).toEqual([
            ['K1', 'https://youtu.be/AAA', false], ['K2', 'https://youtu.be/BBB', true]
        ]);
        // dos pendientes en este rodeo (A + B): resolver uno NO es el último
        expect(d.es_ultima_pendiente).toBe(false);
        expect(d.otras_pendientes_del_rodeo).toBe(1);
        expect(escrituras()).toEqual([]);
    });

    test('Tipo B: video, comentario del analista, tipo, descuento propuesto y fecha de derivación', async () => {
        const d = (await get('/revisiones/video_derivado/K2')).body;
        expect(d.video_derivado).toMatchObject({ id: 'K2', video_url: 'https://youtu.be/BBB', comentario_analista: 'Dudoso', tipo_situacion: 'Reglamentaria', descuento_propuesto: 1, ciclo: 1, derivado_en: '2026-11-09T12:00:00Z' });
        expect(d.estado).toBe('pendiente');
    });

    test('resuelta: muestra la decisión, la observación y quién resolvió', async () => {
        const d = (await get('/revisiones/video_derivado/K4')).body;
        expect(d.resolucion).toMatchObject({ decision: 'error', observacion: 'Error claro', resuelto_por_nombre: 'Carla Comisión' });
    });

    test('única pendiente del rodeo → advertencia de posible publicación automática', async () => {
        global.__sb.tablas.evaluacion_casos.find(c => c.id === 'K2').estado = 'resuelto';
        global.__sb.tablas.evaluacion_casos.find(c => c.id === 'K2').decision_comision = 'aprueba_apelacion';
        const d = (await get('/revisiones/resultado_alterado/RA-NOV1')).body;
        expect(d.es_ultima_pendiente).toBe(true);
    });

    test('tipo inválido → 400; inexistente, anulada o caso no derivado → 404', async () => {
        expect((await get('/revisiones/otro/RA-NOV1')).statusCode).toBe(400);
        expect((await get('/revisiones/resultado_alterado/NO-EXISTE')).statusCode).toBe(404);
        expect((await get('/revisiones/resultado_alterado/RA-X')).statusCode).toBe(404);
        expect((await get('/revisiones/video_derivado/K1')).statusCode).toBe(404);
        expect((await get('/revisiones/video_derivado/K5')).statusCode).toBe(404);
    });
});

describe('resolver ERROR / ACIERTO', () => {
    test('Tipo A: llama a su RPC con la decisión, la observación y el usuario; no publica si quedan pendientes', async () => {
        const r = await resolver('resultado_alterado', 'RA-NOV1', { decision: 'ERROR', observacion: '  Se confirma la alteración  ' });
        expect(r.statusCode).toBe(200);
        expect(rpcLlamadas).toEqual([['A', { p_revision_id: 'RA-NOV1', p_decision: 'error', p_observacion: 'Se confirma la alteración', p_actor_id: 'COM-1' }]]);
        expect(r.body.nota_publicada).toBe(false);   // K2 sigue pendiente
    });

    test('Tipo B: ACIERTO llama a la RPC de casos', async () => {
        const r = await resolver('video_derivado', 'K2', { decision: 'acierto', observacion: 'El jurado actuó bien' });
        expect(r.statusCode).toBe(200);
        expect(rpcLlamadas[0]).toEqual(['B', { p_caso_id: 'K2', p_decision: 'acierto', p_observacion: 'El jurado actuó bien', p_actor_id: 'COM-1' }]);
    });

    test('observación OPCIONAL (106): ERROR y ACIERTO sin observación llaman a la RPC con texto vacío (se guarda NULL)', async () => {
        const a = await resolver('resultado_alterado', 'RA-NOV1', { decision: 'error', observacion: '   ' });
        expect(a.statusCode).toBe(200);
        const b = await resolver('video_derivado', 'K2', { decision: 'acierto' });
        expect(b.statusCode).toBe(200);
        expect(rpcLlamadas).toEqual([
            ['A', { p_revision_id: 'RA-NOV1', p_decision: 'error', p_observacion: '', p_actor_id: 'COM-1' }],
            ['B', { p_caso_id: 'K2', p_decision: 'acierto', p_observacion: '', p_actor_id: 'COM-1' }]
        ]);
    });

    test('sigue obligatoria la decisión: sin ERROR/ACIERTO → 400 sin llamar a ninguna RPC', async () => {
        expect((await resolver('resultado_alterado', 'RA-NOV1', { observacion: 'x' })).statusCode).toBe(400);
        expect((await resolver('video_derivado', 'K2', {})).statusCode).toBe(400);
        expect(rpcLlamadas).toEqual([]);
    });

    test('decisión inválida, etiquetas antiguas u observación > 2000 → 400 sin llamar a ninguna RPC', async () => {
        expect((await resolver('resultado_alterado', 'RA-NOV1', { decision: 'error', observacion: 'x'.repeat(2001) })).statusCode).toBe(400);
        expect((await resolver('resultado_alterado', 'RA-NOV1', { decision: 'aprobar', observacion: 'x' })).statusCode).toBe(400);
        expect((await resolver('video_derivado', 'K2', { decision: 'rechaza_apelacion', observacion: 'x' })).statusCode).toBe(400);
        expect(rpcLlamadas).toEqual([]);
    });

    test('ya resuelta (doble clic u otra persona) → 409 con mensaje claro, sin cambios', async () => {
        await resolver('resultado_alterado', 'RA-NOV1', { decision: 'error', observacion: 'Primera' });
        const r = await resolver('resultado_alterado', 'RA-NOV1', { decision: 'acierto', observacion: 'Segunda' });
        expect(r.statusCode).toBe(409);
        expect(r.body.code).toBe('REVISION_YA_RESUELTA');
        expect(global.__sb.tablas.evaluacion_revisiones_comision.find(x => x.id === 'RA-NOV1')).toMatchObject({ decision: 'error', observacion_comision: 'Primera' });
    });

    test('migración 103 sin aplicar → 503, nunca un éxito falso', async () => {
        global.__sb = crearSupabaseMemoria({ tablas: datos(), rpc: {} });
        const r = await resolver('resultado_alterado', 'RA-NOV1', { decision: 'error', observacion: 'x' });
        expect(r.statusCode).toBe(500);   // rpc no definida en el mock → error genérico
        global.__sb = crearSupabaseMemoria({ tablas: datos(), rpc: { resolver_revision_resultado_alterado: () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }) } });
        const r2 = await resolver('resultado_alterado', 'RA-NOV1', { decision: 'error', observacion: 'x' });
        expect(r2.statusCode).toBe(503);
        expect(r2.body.code).toBe('MIGRACION_103_PENDIENTE');
    });

    test('la Comisión no tiene ruta para publicar notas', () => {
        const rutas = router.stack.filter(l => l.route).map(l => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
        expect(rutas).toEqual(['get /revisiones', 'get /revisiones/:tipo/:id', 'post /revisiones/:tipo/:id/resolver']);
    });
});
