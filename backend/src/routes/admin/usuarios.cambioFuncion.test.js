// Cambio de función Jurado <-> Delegado Rentado (migración 100) — orquestación
// de ruta en usuarios.js. Se invoca el router real (sin servidor HTTP) con
// Supabase mockeado; la lógica transaccional se prueba contra Postgres real
// en services/cambioFuncionUsuario.rpc.test.js. Acá: permisos reales
// (soloRolEvaluacion('jefe_area')), validaciones previas, parámetros de la
// RPC, mapeo de errores, auditoría y verificación previa.
jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
jest.mock('../../services/auditoria', () => ({ registrar: jest.fn().mockResolvedValue(undefined) }));

const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');
const router = require('./usuarios');
const { fechaHoyChile } = require('../../services/cambioFuncionUsuario');

const UID = '02745610-52b9-4793-9cdc-3931ab254f29';
const ADMIN_PLENO = { id: 'a1', nombre: 'Admin Pleno', tipo: 'administrador', rol_evaluacion: null };
const JEFE_DEPORTIVO = { id: 'a2', nombre: 'Jefe Deportivo', tipo: 'administrador', rol_evaluacion: 'jefe_area' };

// Cadena PostgREST mínima: cada consulta se resuelve con filasPorTabla[tabla]
// (lista) o, para maybeSingle/single, su primer elemento.
function mockTablas(filasPorTabla, registro = []) {
    supabase.from.mockImplementation((tabla) => {
        const op = { tabla, filtros: [] };
        registro.push(op);
        const filas = () => filasPorTabla[tabla] || [];
        const chain = {
            select: () => chain,
            eq: (c, v) => { op.filtros.push(['eq', c, v]); return chain; },
            in: (c, v) => { op.filtros.push(['in', c, v]); return chain; },
            order: () => chain,
            update: (cambios) => { op.update = cambios; return chain; },
            maybeSingle: () => Promise.resolve({ data: filas()[0] || null, error: null }),
            single: () => Promise.resolve({ data: filas()[0] || null, error: filas()[0] ? null : { message: 'no encontrado' } }),
            then: (ok, ko) => Promise.resolve({ data: filas(), error: null }).then(ok, ko)
        };
        return chain;
    });
}

function llamar({ method, url, params, body, usuario }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, body: body || {}, query: {}, params: params || {}, headers: {},
            ip: '127.0.0.1', usuario: usuario || ADMIN_PLENO, get() { return undefined; }
        };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(payload) { resolve({ status: this.statusCode, body: payload }); return this; }
        };
        router(req, res, (err) => (err ? reject(err) : resolve({ status: 404, body: { error: 'ruta no encontrada' } })));
    });
}
const patchFuncion = (body, usuario, id = UID) => llamar({ method: 'PATCH', url: `/${id}/tipo-persona`, body, usuario });
const verificar = (usuario, id = UID) => llamar({ method: 'GET', url: `/${id}/tipo-persona/verificacion`, usuario });

const RESPUESTA_RPC = {
    usuario: { id: UID, codigo_interno: 'USR-0300', nombre_completo: 'ROBERTO RIVAS GONZALEZ', tipo_persona: 'delegado_rentado', categoria: null },
    tipo_anterior: 'jurado', categoria_anterior: 'C', fecha_efectiva: '2026-11-13'
};

beforeEach(() => {
    jest.clearAllMocks();
    supabase.rpc.mockResolvedValue({ data: RESPUESTA_RPC, error: null });
    mockTablas({});
});

describe('7. Permisos: solo administrador pleno o Jefe Deportivo', () => {
    test.each([['administrador pleno', ADMIN_PLENO], ['Jefe Deportivo', JEFE_DEPORTIVO]])('%s puede cambiar la función', async (_n, u) => {
        const r = await patchFuncion({ tipo_persona: 'delegado_rentado', motivo: 'Cambio' }, u);
        expect(r.status).toBe(200);
        expect(supabase.rpc).toHaveBeenCalledTimes(1);
    });

    test.each(['analista', 'monitor', 'director', 'comision_tecnica', 'capacitador'])('rol %s -> 403 en cambio y verificación, sin tocar la BD', async (rol) => {
        const u = { id: 'x', nombre: 'X', tipo: 'administrador', rol_evaluacion: rol };
        expect((await patchFuncion({ tipo_persona: 'delegado_rentado', motivo: 'Cambio' }, u)).status).toBe(403);
        expect((await verificar(u)).status).toBe(403);
        expect(supabase.rpc).not.toHaveBeenCalled();
        expect(supabase.from).not.toHaveBeenCalled();
    });
});

describe('Validaciones previas (nunca llegan a la RPC)', () => {
    test.each([
        ['3. sin motivo', { tipo_persona: 'delegado_rentado' }, /motivo/],
        ['3. motivo en blanco', { tipo_persona: 'delegado_rentado', motivo: '   ' }, /motivo/],
        ['motivo demasiado largo', { tipo_persona: 'delegado_rentado', motivo: 'x'.repeat(1001) }, /1000/],
        ['4. Jurado sin categoría', { tipo_persona: 'jurado', motivo: 'Cambio' }, /categoría A, B o C/],
        ['4. Jurado categoría D', { tipo_persona: 'jurado', categoria: 'D', motivo: 'Cambio' }, /categoría A, B o C/],
        ['4. Jurado categoría minúscula', { tipo_persona: 'jurado', categoria: 'a', motivo: 'Cambio' }, /categoría A, B o C/],
        ['DR con categoría', { tipo_persona: 'delegado_rentado', categoria: 'A', motivo: 'Cambio' }, /no lleva categoría/],
        ['tipo inválido', { tipo_persona: 'administrador', motivo: 'Cambio' }, /Jurado o Delegado Rentado/]
    ])('%s -> 400', async (_n, body, re) => {
        const r = await patchFuncion(body);
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(re);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('id que no es UUID -> 404 sin consultar', async () => {
        expect((await patchFuncion({ tipo_persona: 'delegado_rentado', motivo: 'x' }, ADMIN_PLENO, 'USR-0300')).status).toBe(404);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });
});

describe('RPC: parámetros, respuesta y auditoría', () => {
    test('1. Jurado -> DR: parámetros exactos, motivo recortado, categoría null', async () => {
        const r = await patchFuncion({ tipo_persona: 'delegado_rentado', motivo: '  Pasa a Delegado Rentado  ' }, JEFE_DEPORTIVO);
        expect(supabase.rpc).toHaveBeenCalledWith('cambiar_tipo_persona_usuario_con_historial', {
            p_usuario_id: UID, p_tipo_nuevo: 'delegado_rentado', p_categoria_nueva: null,
            p_actor_id: 'a2', p_actor_nombre: 'Jefe Deportivo', p_motivo: 'Pasa a Delegado Rentado'
        });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ usuario: RESPUESTA_RPC.usuario, tipo_anterior: 'jurado', categoria_anterior: 'C', fecha_efectiva: '2026-11-13' });
        expect(r.body.mensaje).toMatch(/Delegado Rentado/);
        expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({
            accion: 'cambiar_tipo_persona', registro_id: UID, actor_id: 'a2',
            datos_anteriores: { tipo_persona: 'jurado', categoria: 'C' },
            datos_nuevos: expect.objectContaining({ tipo_persona: 'delegado_rentado', categoria: null, motivo: 'Pasa a Delegado Rentado' })
        }));
    });

    test('2. DR -> Jurado B', async () => {
        supabase.rpc.mockResolvedValue({ data: { ...RESPUESTA_RPC, usuario: { ...RESPUESTA_RPC.usuario, tipo_persona: 'jurado', categoria: 'B' }, tipo_anterior: 'delegado_rentado', categoria_anterior: null }, error: null });
        const r = await patchFuncion({ tipo_persona: 'jurado', categoria: 'B', motivo: 'Vuelve a jurado' });
        expect(supabase.rpc.mock.calls[0][1]).toMatchObject({ p_tipo_nuevo: 'jurado', p_categoria_nueva: 'B' });
        expect(r.status).toBe(200);
    });

    test('si la auditoría complementaria falla, el cambio ya confirmado igual responde 200', async () => {
        auditoria.registrar.mockRejectedValueOnce(new Error('caída'));
        expect((await patchFuncion({ tipo_persona: 'delegado_rentado', motivo: 'x' })).status).toBe(200);
    });

    test.each([
        ['DESIGNACIONES_VIGENTES_O_FUTURAS: 2', null, 409, 'DESIGNACIONES_VIGENTES_O_FUTURAS'],
        ['CARTILLAS_PENDIENTES: 1', null, 409, 'CARTILLAS_PENDIENTES'],
        ['TIPO_PERSONA_SIN_CAMBIOS', null, 409, 'TIPO_PERSONA_SIN_CAMBIOS'],
        ['USUARIO_INEXISTENTE', null, 404, undefined],
        ['CATEGORIA_INVALIDA', null, 400, 'DATOS_INVALIDOS'],
        ['MOTIVO_REQUERIDO', null, 400, 'DATOS_INVALIDOS'],
        ['Could not find the function public.cambiar_tipo_persona_usuario_con_historial', 'PGRST202', 503, 'MIGRACION_100_PENDIENTE'],
        ['otro error', null, 500, undefined]
    ])('5. error RPC %s (code %p) -> HTTP %p', async (message, code, status, codigo) => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message, code } });
        const r = await patchFuncion({ tipo_persona: 'delegado_rentado', motivo: 'x' });
        expect(r.status).toBe(status);
        if (codigo) expect(r.body.code).toBe(codigo);
        expect(auditoria.registrar).not.toHaveBeenCalled();
    });
});

describe('Verificación previa (solo lectura)', () => {
    const hoy = fechaHoyChile();
    const sumar = (d) => { const x = new Date(hoy + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };

    test('sin bloqueos: puede cambiar e informa el historial conservado', async () => {
        mockTablas({
            usuarios_pagados: [{ id: UID, nombre_completo: 'ROBERTO', tipo_persona: 'jurado', categoria: 'C' }],
            asignaciones: [
                { id: 'p1', tipo_persona: 'jurado', estado: 'activo', estado_designacion: 'aceptado', rodeos: { id: 'r1', fecha: sumar(-30), duracion_dias: 1, estado: 'activo' } },
                { id: 'p2', tipo_persona: 'jurado', estado: 'activo', estado_designacion: 'rechazado', rodeos: { id: 'r2', fecha: sumar(10), duracion_dias: 1, estado: 'activo' } }
            ],
            cartillas_jurado: []
        });
        const r = await verificar();
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ tipo_actual: 'jurado', tipo_destino: 'delegado_rentado', fecha_efectiva: hoy, puede_cambiar: true,
            historico: { designaciones_como_jurado: 1, designaciones_como_delegado: 0 } });
        expect(r.body.bloqueos.designaciones).toEqual([]);
    });

    test('con designación futura y cartilla pendiente: no puede cambiar y lista el detalle', async () => {
        const registro = [];
        mockTablas({
            usuarios_pagados: [{ id: UID, nombre_completo: 'X', tipo_persona: 'delegado_rentado', categoria: null }],
            asignaciones: [
                { id: 'f1', tipo_persona: 'delegado_rentado', estado: 'activo', estado_designacion: 'pendiente', rodeos: { id: 'r3', club: 'VICTORIA', asociacion: 'MALLECO', fecha: sumar(7), duracion_dias: 2, estado: 'activo' } },
                { id: 'f2', tipo_persona: 'delegado_rentado', estado: 'activo', estado_designacion: 'aceptado', rodeos: { id: 'r4', fecha: sumar(-1), duracion_dias: 3, estado: 'activo' } },
                { id: 'f3', tipo_persona: 'delegado_rentado', estado: 'activo', estado_designacion: 'aceptado', rodeos: { id: 'r5', fecha: sumar(5), duracion_dias: 1, estado: 'anulado' } }
            ],
            cartillas_delegado: [{ id: 'c1', rodeo_id: 'r0', estado: 'observada' }]
        }, registro);
        const r = await verificar();
        expect(r.body.puede_cambiar).toBe(false);
        expect(r.body.tipo_destino).toBe('jurado');
        expect(r.body.bloqueos.designaciones.map(d => d.asignacion_id)).toEqual(['f2', 'f1']);
        expect(r.body.bloqueos.cartillas_pendientes).toEqual([{ id: 'c1', rodeo_id: 'r0', estado: 'observada', tipo: 'cartilla_delegado' }]);
        const consultaCartillas = registro.find(o => o.tabla === 'cartillas_delegado');
        expect(consultaCartillas.filtros).toContainEqual(['in', 'estado', ['borrador', 'observada', 'reabierta']]);
    });

    test('usuario inexistente -> 404', async () => {
        mockTablas({ usuarios_pagados: [] });
        expect((await verificar()).status).toBe(404);
    });
});

describe('Protección: el PATCH genérico nunca cambia la función ni la categoría', () => {
    test('PATCH /:id ignora tipo_persona y categoria del body', async () => {
        const registro = [];
        mockTablas({ usuarios_pagados: [{ id: UID, nombre_completo: 'X', tipo_persona: 'jurado', categoria: 'C' }] }, registro);
        await llamar({ method: 'PATCH', url: `/${UID}`, params: { id: UID }, body: { tipo_persona: 'delegado_rentado', categoria: 'A', telefono: '123' } });
        const upd = registro.find(o => o.update);
        expect(upd.update).toHaveProperty('telefono', '123');
        expect(upd.update).not.toHaveProperty('tipo_persona');
        expect(upd.update).not.toHaveProperty('categoria');
        expect(supabase.rpc).not.toHaveBeenCalled();
    });
});
