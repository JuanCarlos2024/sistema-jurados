// Corrección final de seguridad — Sección 2: protección del reemplazo de
// jurados (mitad lectura). GET /:id/jurados-candidatos-reemplazo ahora
// reutiliza evaluarElegibilidadJurado() (mismo mecanismo que
// /jurados-disponibles) — nunca excluye a nadie, pero marca estado_
// elegibilidad/causas_obligatorias/causas_relajables/distancia_km, igual
// que "Designar jurado" desde la Etapa A/B. Autoexclusión verificada:
// bloquesPorJurado/asociacionesPorJurado (construirEstadoDesdeBD,
// motorPropuestaDesignacion.js) se indexan por usuario_pagado_id, nunca por
// asignación — la fila que se está reemplazando (dueña del jurado ANTERIOR,
// no del candidato) nunca puede generar un conflicto falso contra el
// candidato evaluado.
let mockDb;
jest.mock('../../config/supabase', () => new Proxy({}, { get: (_, k) => mockDb[k] }));
jest.mock('../../services/motorPropuestaDesignacion', () => {
    const real = jest.requireActual('../../services/motorPropuestaDesignacion');
    return { ...real, cargarDatosMotor: jest.fn() };
});
jest.mock('../../services/configuracionDesignacionRepositorio', () => ({
    cargarConfiguracionDesignacionActiva: jest.fn()
}));
jest.mock('../../services/elegibilidadJurado', () => ({
    evaluarElegibilidadJurado: jest.fn(),
    ESTADOS_ELEGIBILIDAD: { DISPONIBLE_Y_HABILITADO: 'DISPONIBLE_Y_HABILITADO', CON_ADVERTENCIAS: 'CON_ADVERTENCIAS', NO_HABILITADO: 'NO_HABILITADO' }
}));

const { crearSupabaseMemoria, llamarRouter } = require('../../services/__fixtures__/supabaseMemoria');
const { cargarDatosMotor } = require('../../services/motorPropuestaDesignacion');
const { cargarConfiguracionDesignacionActiva } = require('../../services/configuracionDesignacionRepositorio');
const { evaluarElegibilidadJurado } = require('../../services/elegibilidadJurado');
const router = require('./rodeos');

const RODEO = { id: 'R-HUEMUL', asociacion: 'COLCHAGUA', fecha: '2026-11-07', duracion_dias: 2, club: 'HUEMUL' };
const ASIG_ACTUAL = { id: 'A-ACTUAL', rodeo_id: 'R-HUEMUL', usuario_pagado_id: 'J-ANTERIOR', tipo_persona: 'jurado', estado: 'activo', created_at: '0' };

function preparar({ rodeos = [RODEO], usuarios_pagados = [], disponibilidad_usuarios = [], asignaciones = [ASIG_ACTUAL], notas_rodeo = [] } = {}) {
    mockDb = crearSupabaseMemoria({ tablas: { rodeos, usuarios_pagados, disponibilidad_usuarios, asignaciones, notas_rodeo } });
}
function buscar(query = {}) {
    return llamarRouter(router, {
        metodo: 'GET', url: '/R-HUEMUL/jurados-candidatos-reemplazo',
        params: { id: 'R-HUEMUL' }, query: { asignacion_id: 'A-ACTUAL', ...query }
    });
}
function jurado(id, extra = {}) {
    return { id, nombre_completo: 'Jurado ' + id, categoria: 'A', codigo_interno: 'J-' + id, asociacion: 'OTRA', comuna: 'X', activo: true, tipo_persona: 'jurado', ...extra };
}
const DISP_COMPLETA = (id) => ([{ usuario_pagado_id: id, fecha: '2026-11-07' }, { usuario_pagado_id: id, fecha: '2026-11-08' }]);

beforeEach(() => {
    jest.clearAllMocks();
    cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: { _fake: true } });
    cargarDatosMotor.mockResolvedValue({ _contextoFake: true });
});

test('candidato NO_HABILITADO (ej. MISMA_ASOCIACION) -> queda marcado (nunca excluido) y ordenado al final, igual que /jurados-disponibles', async () => {
    preparar({
        usuarios_pagados: [jurado('J-OK'), jurado('J-MAL')],
        disponibilidad_usuarios: [...DISP_COMPLETA('J-OK'), ...DISP_COMPLETA('J-MAL')]
    });
    evaluarElegibilidadJurado.mockImplementation((ctx, rodeoId, juradoId) =>
        juradoId === 'J-MAL'
            ? { estado: 'NO_HABILITADO', causas: ['MISMA_ASOCIACION'], causas_obligatorias: ['MISMA_ASOCIACION'], causas_relajables: [], distancia_km: null }
            : { estado: 'DISPONIBLE_Y_HABILITADO', causas: [], causas_obligatorias: [], causas_relajables: [], distancia_km: 10 }
    );

    const r = await buscar();

    expect(r.statusCode).toBe(200);
    expect(r.body.candidatos.map(c => c.id)).toEqual(['J-OK', 'J-MAL']); // sigue en la lista, al final
    const malo = r.body.candidatos.find(c => c.id === 'J-MAL');
    expect(malo).toEqual(expect.objectContaining({ estado_elegibilidad: 'NO_HABILITADO', causas_obligatorias: ['MISMA_ASOCIACION'] }));
});

test('candidato CON_ADVERTENCIAS (ej. DISTANCIA_EXCEDIDA) -> queda marcado, sin excluirse', async () => {
    preparar({ usuarios_pagados: [jurado('J1')], disponibilidad_usuarios: DISP_COMPLETA('J1') });
    evaluarElegibilidadJurado.mockReturnValue({ estado: 'CON_ADVERTENCIAS', causas: ['DISTANCIA_EXCEDIDA'], causas_obligatorias: [], causas_relajables: ['DISTANCIA_EXCEDIDA'], distancia_km: 750 });

    const r = await buscar();

    expect(r.body.candidatos[0]).toEqual(expect.objectContaining({ estado_elegibilidad: 'CON_ADVERTENCIAS', causas_relajables: ['DISTANCIA_EXCEDIDA'], distancia_km: 750 }));
});

test('autoexclusión: el candidato evaluado nunca se ve afectado por la asignación que se está reemplazando (de OTRO usuario_pagado_id)', async () => {
    preparar({ usuarios_pagados: [jurado('J-NUEVO')], disponibilidad_usuarios: DISP_COMPLETA('J-NUEVO') });
    evaluarElegibilidadJurado.mockReturnValue({ estado: 'DISPONIBLE_Y_HABILITADO', causas: [], causas_obligatorias: [], causas_relajables: [], distancia_km: 5 });

    const r = await buscar();

    // Se evaluó al candidato nuevo (J-NUEVO), nunca al anterior (J-ANTERIOR,
    // dueño de la asignación que se está reemplazando) — y el resultado no
    // quedó bloqueado por la sola existencia de esa asignación.
    expect(evaluarElegibilidadJurado).toHaveBeenCalledWith({ _contextoFake: true }, 'R-HUEMUL', 'J-NUEVO', { _fake: true });
    expect(evaluarElegibilidadJurado).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'J-ANTERIOR', expect.anything());
    expect(r.body.candidatos[0].estado_elegibilidad).toBe('DISPONIBLE_Y_HABILITADO');
});

test('configuración de designación no resuelta -> degrada con gracia (estado_elegibilidad null, la lista sigue funcionando igual que antes de esta corrección)', async () => {
    preparar({ usuarios_pagados: [jurado('J1')], disponibilidad_usuarios: DISP_COMPLETA('J1') });
    cargarConfiguracionDesignacionActiva.mockResolvedValue({ error: 'CONFIGURACION_DESIGNACION_NO_RESUELTA', detalle: 'sin config activa' });

    const r = await buscar();

    expect(r.body.candidatos[0]).toEqual(expect.objectContaining({ id: 'J1', estado_elegibilidad: null, causas_obligatorias: [], causas_relajables: [], distancia_km: null }));
    expect(evaluarElegibilidadJurado).not.toHaveBeenCalled();
});
