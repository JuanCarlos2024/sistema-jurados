// Creación de evaluaciones NORMALES con registros HISTÓRICOS (solo Casos por WhatsApp) en el rodeo — supabase en memoria.
// (La transacción real de la conversión se prueba sobre Postgres en services/evaluacionHistorica.rpc.test.js.)
let mockDb;
jest.mock('../../config/supabase', () => new Proxy({}, { get: (_, k) => mockDb[k] }));

const { crearSupabaseMemoria, llamarRouter } = require('../../services/__fixtures__/supabaseMemoria');
const { ciclosIniciales, CONFIGURACION_POR_DEFECTO } = require('../../services/evaluacionCreacion');
const router = require('./evaluaciones');

const CFG = { activo: true, puntaje_base: 77, min_casos_ciclo1: 1, max_casos_ciclo1: 9, min_casos_ciclo2: 7, max_casos_ciclo2: 7 };
const ANALISTA = 'AN-1';

// Simula la RPC SQL convertir_evaluacion_historica (mismo contrato); "falla" = error simulado ANTES de escribir (la real es atómica).
function rpcConvertir({ falla } = {}) {
    return (a, { tablas }) => {
        if (falla) return { data: null, error: { message: falla } };
        const ev = tablas.evaluaciones.find(e => e.rodeo_id === a.p_rodeo_id);
        if (!ev || !ev.es_historica_importacion) return { data: null, error: { message: 'EVAL_CONV_NO_HISTORICA' } };
        Object.assign(ev, { es_historica_importacion: false, estado: 'borrador', analista_id: a.p_analista_id, puntaje_base: a.p_puntaje_base, creado_por: a.p_actor_id });
        a.p_ciclos.forEach(c => tablas.evaluacion_ciclos.push({ id: 'C' + tablas.evaluacion_ciclos.length, evaluacion_id: ev.id, ...c }));
        tablas.evaluacion_auditoria.push({ evaluacion_id: ev.id, accion: 'crear_evaluacion', detalle: a.p_detalle, actor_id: a.p_actor_id });
        return { data: { ...ev }, error: null };
    };
}
function preparar(evals = [], { falla, rodeos = [{ id: 'R1', estado: 'activo', fecha: '2026-02-15', club: 'X', asociacion: 'A' }] } = {}) {
    mockDb = crearSupabaseMemoria({
        tablas: { rodeos, evaluaciones: evals, evaluacion_ciclos: [], evaluacion_auditoria: [], evaluacion_configuracion: [CFG], asignaciones: [], evaluacion_casos: [] },
        unicos: { evaluaciones: [['rodeo_id']] },
        rpc: { convertir_evaluacion_historica: rpcConvertir({ falla }) }
    });
}
const crear = (rodeo_id = 'R1', usuario) => llamarRouter(router, { metodo: 'POST', url: '/', body: { rodeo_id, analista_id: ANALISTA }, usuario });
const HIST = (o = {}) => ({ id: 'EH', rodeo_id: 'R1', estado: 'cerrado', es_historica_importacion: true, casos_whatsapp: 4, anulada: false, ...o });

describe('POST /admin/evaluaciones — rodeo SIN evaluación (comportamiento de siempre)', () => {
    test('crea la evaluación, los 2 ciclos definidos por ciclosIniciales y la auditoría normal', async () => {
        preparar();
        const r = await crear();
        expect(r.statusCode).toBe(201);
        expect(mockDb.tablas.evaluaciones).toHaveLength(1);
        expect(mockDb.tablas.evaluaciones[0]).toMatchObject({ rodeo_id: 'R1', analista_id: ANALISTA, puntaje_base: 77, creado_por: 'ADMIN-1' });
        expect(mockDb.tablas.evaluaciones[0].es_historica_importacion).toBeUndefined();          // el INSERT no menciona el marcador: default false en la base
        expect(mockDb.tablas.evaluacion_ciclos.map(({ numero_ciclo, min_casos, max_casos }) => ({ numero_ciclo, min_casos, max_casos }))).toEqual(ciclosIniciales(CFG));
        expect(mockDb.tablas.evaluacion_auditoria).toEqual([expect.objectContaining({ accion: 'crear_evaluacion', detalle: { rodeo_id: 'R1', analista_id: ANALISTA }, actor_tipo: 'administrador', actor_nombre: 'Admin', ip_address: '127.0.0.1' })]);
        expect(mockDb.llamadas('rpc:convertir_evaluacion_historica')).toEqual([]);
    });
    test('requisitos previos y permisos sin cambios (rodeo_id/analista_id obligatorios; solo jefe_area o admin pleno)', async () => {
        preparar();
        expect((await llamarRouter(router, { metodo: 'POST', url: '/', body: { analista_id: 'x' } })).statusCode).toBe(400);
        expect((await llamarRouter(router, { metodo: 'POST', url: '/', body: { rodeo_id: 'R1' } })).statusCode).toBe(400);
        expect((await crear('R1', { id: 'u', nombre: 'a', rol_evaluacion: 'analista' })).statusCode).toBe(403);
        expect((await crear('R1', { id: 'u', nombre: 'a', rol_evaluacion: 'jefe_area' })).statusCode).toBe(201);
    });
    test('sin configuración activa usa los valores por defecto de siempre', async () => {
        preparar(); mockDb.tablas.evaluacion_configuracion.length = 0;
        await crear();
        expect(mockDb.tablas.evaluaciones[0].puntaje_base).toBe(CONFIGURACION_POR_DEFECTO.puntaje_base);
        expect(mockDb.tablas.evaluacion_ciclos.map(c => [c.numero_ciclo, c.min_casos, c.max_casos])).toEqual([[1, 0, 10], [2, 8, 8]]);
    });
});

describe('POST /admin/evaluaciones — rodeo con evaluación HISTÓRICA → conversión', () => {
    test('reutiliza la fila (no crea una segunda), conserva casos_whatsapp, true→false, estado inicial normal', async () => {
        preparar([HIST()]);
        const r = await crear();
        expect(r.statusCode).toBe(201);
        expect(mockDb.tablas.evaluaciones).toHaveLength(1);                       // UNIQUE rodeo_id: una sola fila
        expect(mockDb.tablas.evaluaciones[0]).toMatchObject({ id: 'EH', es_historica_importacion: false, casos_whatsapp: 4, estado: 'borrador', analista_id: ANALISTA, puntaje_base: 77, creado_por: 'ADMIN-1' });
        expect(r.body).toMatchObject({ id: 'EH', es_historica_importacion: false, casos_whatsapp: 4 });
    });
    test('los ciclos y la auditoría tienen la MISMA estructura que en la creación normal (misma definición ciclosIniciales)', async () => {
        preparar([HIST()]);
        await crear();
        expect(mockDb.tablas.evaluacion_ciclos.map(({ numero_ciclo, min_casos, max_casos }) => ({ numero_ciclo, min_casos, max_casos }))).toEqual(ciclosIniciales(CFG));
        expect(mockDb.tablas.evaluacion_auditoria).toHaveLength(1);
        expect(mockDb.tablas.evaluacion_auditoria[0]).toMatchObject({ accion: 'crear_evaluacion', detalle: { rodeo_id: 'R1', analista_id: ANALISTA, convertida_desde_historica: true, casos_whatsapp_conservado: 4 } });
    });
    test('la conversión NO duplica la lógica de ciclos: Node no inserta ciclos ni auditoría por su cuenta, solo llama a la RPC atómica', async () => {
        preparar([HIST()]);
        await crear();
        expect(mockDb.llamadas('evaluacion_ciclos', 'insert')).toEqual([]);
        expect(mockDb.llamadas('evaluacion_auditoria', 'insert')).toEqual([]);
        const [rpc] = mockDb.llamadas('rpc:convertir_evaluacion_historica');
        expect(rpc.payload).toMatchObject({ p_rodeo_id: 'R1', p_analista_id: ANALISTA, p_puntaje_base: 77, p_actor_id: 'ADMIN-1', p_ciclos: ciclosIniciales(CFG) });
    });
    test('error en la conversión: se informa y NO queda estado parcial (la RPC es atómica; Node no escribe nada más)', async () => {
        preparar([HIST()], { falla: 'algo falló dentro de la transacción' });
        const r = await crear();
        expect(r.statusCode).toBe(500);
        expect(r.body.error).toMatch(/no se guardó ningún cambio/);
        expect(mockDb.tablas.evaluaciones[0]).toMatchObject({ es_historica_importacion: true, estado: 'cerrado', casos_whatsapp: 4 });
        expect(mockDb.tablas.evaluacion_ciclos).toEqual([]); expect(mockDb.tablas.evaluacion_auditoria).toEqual([]);
    });
    test('errores conocidos de la RPC se traducen a 409', async () => {
        for (const codigo of ['EVAL_CONV_YA_TIENE_CICLOS', 'EVAL_CONV_ANULADA', 'EVAL_CONV_NO_HISTORICA']) {
            preparar([HIST()], { falla: codigo });
            expect((await crear()).statusCode).toBe(409);
        }
    });
    test('evaluación NORMAL existente → 409 como siempre, sin convertir ni tocar nada', async () => {
        preparar([HIST({ es_historica_importacion: false, estado: 'en_proceso', casos_whatsapp: 2 })]);
        const r = await crear();
        expect(r.statusCode).toBe(409);
        expect(r.body.error).toBe('Ya existe una evaluación para este rodeo');
        expect(mockDb.llamadas('rpc:convertir_evaluacion_historica')).toEqual([]);
        expect(mockDb.tablas.evaluaciones[0]).toMatchObject({ estado: 'en_proceso', casos_whatsapp: 2 });
    });
    test('evaluación histórica ANULADA → 409 (no se resucita)', async () => {
        preparar([HIST({ anulada: true })]);
        expect((await crear()).statusCode).toBe(409);
        expect(mockDb.llamadas('rpc:convertir_evaluacion_historica')).toEqual([]);
    });
    test('segunda creación sobre lo ya convertido = evaluación normal existente → 409 (idempotente)', async () => {
        preparar([HIST()]);
        expect((await crear()).statusCode).toBe(201);
        expect((await crear()).statusCode).toBe(409);
        expect(mockDb.tablas.evaluaciones).toHaveLength(1);
        expect(mockDb.tablas.evaluacion_ciclos).toHaveLength(2);
    });
});

describe('POST /admin/evaluaciones/crear-masivo', () => {
    test('normal + histórica + con evaluación normal: crea, convierte y omite según corresponda', async () => {
        preparar([HIST({ id: 'EH', rodeo_id: 'R2' }), { id: 'EN', rodeo_id: 'R3', estado: 'en_proceso', es_historica_importacion: false, casos_whatsapp: 0, anulada: false }],
            { rodeos: ['R1', 'R2', 'R3'].map(id => ({ id, estado: 'activo' })) });
        const r = await llamarRouter(router, { metodo: 'POST', url: '/crear-masivo', body: { rodeo_ids: ['R1', 'R2', 'R3'], analista_id: ANALISTA } });
        expect(r.statusCode).toBe(200);
        expect(r.body).toEqual({ creadas: 2, convertidas: 1, omitidas: 1, errores: [] });
        expect(mockDb.tablas.evaluaciones).toHaveLength(3);
        expect(mockDb.tablas.evaluaciones.find(e => e.rodeo_id === 'R2')).toMatchObject({ id: 'EH', es_historica_importacion: false, casos_whatsapp: 4 });
        expect(mockDb.tablas.evaluacion_ciclos).toHaveLength(4);                  // 2 ciclos por cada evaluación creada/convertida
        expect(mockDb.tablas.evaluacion_auditoria.map(a => a.detalle.origen)).toEqual(expect.arrayContaining(['masivo']));
    });
});

describe('listados operativos: la histórica no es una evaluación', () => {
    const NORMAL = { id: 'EN', rodeo_id: 'R2', estado: 'en_proceso', es_historica_importacion: false, casos_whatsapp: 0, anulada: false, created_at: '2026-01-01' };
    test('GET / (listado del analista, pendientes, total): excluye históricas; el detalle por id sigue disponible con casos_whatsapp', async () => {
        preparar([HIST(), NORMAL], { rodeos: ['R1', 'R2'].map(id => ({ id, estado: 'activo' })) });
        const r = await llamarRouter(router, { url: '/' });
        expect(r.statusCode).toBe(200);
        expect(r.body.evaluaciones.map(e => e.id)).toEqual(['EN']);
        expect(r.body.total).toBe(1);
        const detalle = await llamarRouter(router, { url: '/EH' });
        expect(detalle.statusCode).toBe(200);
        expect(detalle.body).toMatchObject({ id: 'EH', casos_whatsapp: 4, es_historica_importacion: true });
    });
    test('GET /rodeos-disponibles: un rodeo con evaluación histórica sigue disponible (tiene_evaluacion=false); con normal o histórica anulada = true', async () => {
        preparar([HIST(), NORMAL, HIST({ id: 'EA', rodeo_id: 'R3', anulada: true })], { rodeos: ['R1', 'R2', 'R3', 'R4'].map(id => ({ id, estado: 'activo', fecha: '2026-02-01' })) });
        const r = await llamarRouter(router, { url: '/rodeos-disponibles' });
        const t = Object.fromEntries(r.body.rodeos.map(x => [x.id, x.tiene_evaluacion]));
        expect(t).toEqual({ R1: false, R2: true, R3: true, R4: false });
    });
    test('PATCH /:id/datos-deportivos sobre una histórica: Casos por WhatsApp manual sigue funcionando y no cambia su condición', async () => {
        preparar([HIST()]);
        const r = await llamarRouter(router, { metodo: 'PATCH', url: '/EH/datos-deportivos', body: { casos_whatsapp: 9 } });
        expect(r.statusCode).toBe(200);
        expect(mockDb.tablas.evaluaciones[0]).toMatchObject({ casos_whatsapp: 9, es_historica_importacion: true, estado: 'cerrado' });
    });
});
