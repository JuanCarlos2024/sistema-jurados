// PUT /api/admin/rodeos/:id/notas-secundarias (Comisión de Asociación, 079).
// Ya no hace un upsert directo — delega en actualizar_notas_secundarias_con_
// auditoria. Se prueba: permisos (admin/monitor/director sí, otros no),
// validación de rango, inferencia de p_actualizar_* desde las claves del
// body, y el mapeo de los 2 códigos de error nuevos de la RPC.
jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
jest.mock('../../services/auditoria', () => ({ registrar: jest.fn() }));

const supabase = require('../../config/supabase');
const router = require('./rodeos');

function crearResFake() {
    const res = {};
    res.statusCode = 200;
    res.status = jest.fn((c) => { res.statusCode = c; return res; });
    res.jsonBody = null;
    res.json = jest.fn((p) => { res.jsonBody = p; return res; });
    return res;
}
function llamar(body, usuario = { id: 'admin-1', rol_evaluacion: null }) {
    return new Promise((resolve, reject) => {
        const ruta = '/rodeo-1/notas-secundarias';
        const req = { method: 'PUT', url: ruta, originalUrl: ruta, body: body || {}, params: { id: 'rodeo-1' }, query: {}, usuario, ip: '127.0.0.1' };
        const res = crearResFake();
        const jsonOriginal = res.json;
        res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}

beforeEach(() => {
    supabase.rpc.mockReset();
    supabase.rpc.mockResolvedValue({ data: { rodeo_id: 'rodeo-1', nota_comision: 5.5, nota_delegado: 6.0 }, error: null });
});

describe('Permisos', () => {
    test.each(['analista', 'comision_tecnica'])('rol_evaluacion=%s -> 403, nunca llama a la RPC', async (rol) => {
        const res = await llamar({ nota_comision: 5.5, nota_delegado: 6.0 }, { id: 'x', rol_evaluacion: rol });
        expect(res.statusCode).toBe(403);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test.each([null, 'monitor', 'director'])('rol_evaluacion=%s (admin pleno, monitor, director) -> permitido', async (rol) => {
        const res = await llamar({ nota_comision: 5.5, nota_delegado: 6.0 }, { id: 'x', rol_evaluacion: rol });
        expect(res.statusCode).toBe(200);
    });
});

describe('Validación de rango', () => {
    test('nota fuera de rango -> 400, nunca llama a la RPC', async () => {
        const res = await llamar({ nota_comision: 8.5 });
        expect(res.statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });
});

describe('Inferencia de p_actualizar_* desde las claves del body', () => {
    test('body con ambas claves -> actualiza ambas', async () => {
        await llamar({ nota_comision: 5.5, nota_delegado: 6.0 });
        const args = supabase.rpc.mock.calls[0][1];
        expect(args.p_actualizar_comision).toBe(true);
        expect(args.p_actualizar_delegado).toBe(true);
        expect(args.p_nota_comision).toBe(5.5);
        expect(args.p_nota_delegado).toBe(6.0);
    });

    test('body con solo nota_delegado -> NUNCA toca Comisión (p_actualizar_comision=false)', async () => {
        await llamar({ nota_delegado: 6.0 });
        const args = supabase.rpc.mock.calls[0][1];
        expect(args.p_actualizar_comision).toBe(false);
        expect(args.p_actualizar_delegado).toBe(true);
    });

    test('body con solo nota_comision -> NUNCA toca Delegado (p_actualizar_delegado=false)', async () => {
        await llamar({ nota_comision: 5.5 });
        const args = supabase.rpc.mock.calls[0][1];
        expect(args.p_actualizar_comision).toBe(true);
        expect(args.p_actualizar_delegado).toBe(false);
    });

    // Corrección (bug reportado en producción, rodeos AGUANEGRA LOS NICHES y
    // QUILPOCO DE RAUCO): el formulario REAL de admin/rodeos.html SIEMPRE
    // envía las dos claves en el body (nunca omite una), aunque el campo
    // correspondiente esté vacío — a diferencia de los tests de arriba, que
    // simulaban un body "ideal" con solo una clave presente. Antes, usar
    // hasOwnProperty trataba esto como "Comisión fue editada" sin importar
    // su valor, marcando corregida_admin con nota_comision=NULL sin que
    // nadie la hubiera tocado realmente.
    test('BUG REAL: body con AMBAS claves pero nota_comision vacía (como siempre la envía el formulario real) -> NUNCA toca Comisión', async () => {
        await llamar({ nota_comision: '', nota_delegado: 6.0 });
        const args = supabase.rpc.mock.calls[0][1];
        expect(args.p_actualizar_comision).toBe(false);
        expect(args.p_actualizar_delegado).toBe(true);
    });

    test('BUG REAL: body con AMBAS claves pero nota_comision null (JSON explícito) -> NUNCA toca Comisión', async () => {
        await llamar({ nota_comision: null, nota_delegado: 6.0 });
        const args = supabase.rpc.mock.calls[0][1];
        expect(args.p_actualizar_comision).toBe(false);
        expect(args.p_actualizar_delegado).toBe(true);
    });

    test('BUG REAL, simétrico: body con AMBAS claves pero nota_delegado vacía -> NUNCA toca Delegado', async () => {
        await llamar({ nota_comision: 5.5, nota_delegado: '' });
        const args = supabase.rpc.mock.calls[0][1];
        expect(args.p_actualizar_comision).toBe(true);
        expect(args.p_actualizar_delegado).toBe(false);
    });

    test('confirma_sobrescritura_historica se propaga a la RPC (con motivo real, ya exigido por Hallazgo 7)', async () => {
        await llamar({ nota_comision: 5.5, confirma_sobrescritura_historica: true, motivo: 'corrección deportiva autorizada' });
        expect(supabase.rpc.mock.calls[0][1].p_confirma_sobrescritura_historica).toBe(true);
        expect(supabase.rpc.mock.calls[0][1].p_motivo).toBe('corrección deportiva autorizada');
    });
});

describe('Hallazgo 7 (corrección posterior) — motivo real y administrador pleno exigidos para sobrescribir una nota protegida', () => {
    test('confirma_sobrescritura_historica=true SIN motivo -> 400, nunca llama a la RPC', async () => {
        const res = await llamar({ nota_comision: 5.5, confirma_sobrescritura_historica: true });
        expect(res.statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('confirma_sobrescritura_historica=true con motivo solo espacios -> 400, nunca llama a la RPC', async () => {
        const res = await llamar({ nota_comision: 5.5, confirma_sobrescritura_historica: true, motivo: '   ' });
        expect(res.statusCode).toBe(400);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test.each(['monitor', 'director'])('confirma_sobrescritura_historica=true con rol_evaluacion=%s -> 403, nunca llama a la RPC (solo admin pleno)', async (rol) => {
        const res = await llamar(
            { nota_comision: 5.5, confirma_sobrescritura_historica: true, motivo: 'motivo real' },
            { id: 'x', rol_evaluacion: rol }
        );
        expect(res.statusCode).toBe(403);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('confirma_sobrescritura_historica=true con admin pleno y motivo real -> permitido', async () => {
        const res = await llamar({ nota_comision: 5.5, confirma_sobrescritura_historica: true, motivo: 'motivo real' }, { id: 'admin-1', rol_evaluacion: null });
        expect(res.statusCode).toBe(200);
        expect(supabase.rpc.mock.calls[0][1].p_motivo).toBe('motivo real');
    });

    test('sin confirma_sobrescritura_historica, monitor/director siguen pudiendo editar normalmente (sin motivo)', async () => {
        const res = await llamar({ nota_comision: 5.5 }, { id: 'x', rol_evaluacion: 'monitor' });
        expect(res.statusCode).toBe(200);
    });
});

describe('Mapeo de errores de la RPC', () => {
    test('REQUIERE_RESOLUCION_ADMINISTRATIVA_PRIMERO -> 409', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'REQUIERE_RESOLUCION_ADMINISTRATIVA_PRIMERO' } });
        const res = await llamar({ nota_comision: 5.5 });
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('REQUIERE_RESOLUCION_ADMINISTRATIVA_PRIMERO');
    });

    test('NOTA_COMISION_PROTEGIDA_REQUIERE_CONFIRMACION -> 409', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'NOTA_COMISION_PROTEGIDA_REQUIERE_CONFIRMACION' } });
        const res = await llamar({ nota_comision: 5.5 });
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('NOTA_COMISION_PROTEGIDA_REQUIERE_CONFIRMACION');
    });

    test('MOTIVO_OBLIGATORIO (devuelto por la RPC) -> 400', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'MOTIVO_OBLIGATORIO' } });
        const res = await llamar({ nota_comision: 5.5, confirma_sobrescritura_historica: true, motivo: 'x' });
        expect(res.statusCode).toBe(400);
    });

    test('NOTA_FUERA_DE_RANGO (devuelto por la RPC) -> 400', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'NOTA_FUERA_DE_RANGO' } });
        const res = await llamar({ nota_comision: 5.5, confirma_sobrescritura_historica: true, motivo: 'x' });
        expect(res.statusCode).toBe(400);
    });

    test('RODEO_NO_ENCONTRADO -> 404', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'RODEO_NO_ENCONTRADO' } });
        const res = await llamar({ nota_comision: 5.5 });
        expect(res.statusCode).toBe(404);
    });
});
