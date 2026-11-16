// PUT /api/admin/rodeos/:id/datos-monitor — formato de puntajes oficiales.
// Los puntajes que importa Control de Gestión (migración 101) admiten varios
// desempates ("22+5+3"); el guardado manual debe aceptar ese mismo valor,
// o el Monitor no podría volver a guardar el comentario de ese rodeo.
const { crearSupabaseMemoria, llamarRouter } = require('../../services/__fixtures__/supabaseMemoria');

jest.mock('../../config/supabase', () => ({
    from: (...a) => global.__sb.from(...a),
    rpc: (...a) => global.__sb.rpc(...a)
}));
jest.mock('../../services/auditoria', () => ({ registrar: jest.fn() }));
const router = require('./rodeos');

beforeEach(() => {
    global.__sb = crearSupabaseMemoria({ tablas: { datos_monitor_rodeo: [] }, unicos: { datos_monitor_rodeo: [['rodeo_id']] } });
});
const put = (body) => llamarRouter(router, { metodo: 'PUT', url: '/rodeo-1/datos-monitor', params: { id: 'rodeo-1' }, body });
const guardado = () => global.__sb.calls.find(c => c.tabla === 'datos_monitor_rodeo' && c.op === 'upsert')?.payload;

test.each([
    ['36', '36'], ['30+5', '30+5'], ['23-2', '23-2'], ['30 + 5', '30+5'],
    ['22+5+3', '22+5+3'], ['22 + 5 - 3', '22+5-3'], ['24+12', '24+12']
])('acepta %p y guarda %p (texto)', async (entrada, esperado) => {
    const r = await put({ puntaje_oficial_1er: entrada, comentario_monitor: 'x' });
    expect(r.statusCode).toBe(200);
    expect(guardado().puntaje_oficial_1er).toBe(esperado);
});

test.each([['abc'], ['27.5'], ['27++8'], ['+8']])('rechaza %p sin escribir', async (v) => {
    const r = await put({ puntaje_oficial_2do: v });
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toMatch(/22\+5\+3/);
    expect(guardado()).toBeUndefined();
});

test('vacío sigue guardándose como null (no 0)', async () => {
    await put({ puntaje_oficial_1er: '', puntaje_oficial_2do: null });
    expect(guardado()).toMatchObject({ puntaje_oficial_1er: null, puntaje_oficial_2do: null });
});
