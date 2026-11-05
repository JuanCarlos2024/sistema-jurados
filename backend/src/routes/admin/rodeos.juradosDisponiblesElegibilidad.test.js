// GET /api/admin/rodeos/:id/jurados-disponibles — Auditoría de elegibilidad
// y gestión de propuestas incompletas, Etapa A/B.
//
// Causa raíz corregida: este endpoint (usado por Rodeos → "Designar
// jurado") solo validaba disponibilidad declarada y cruce de fechas —
// nunca MISMA_ASOCIACION (conflicto de interés real), categoría/matriz ni
// distancia, a diferencia de Propuesta de Designación (que sí evalúa todo
// eso vía evaluarCandidato()). Un jurado que Propuesta descartaba
// correctamente podía aparecer en Rodeos sin ninguna advertencia.
//
// Estas pruebas verifican el ENRIQUECIMIENTO nuevo (estado_elegibilidad/
// causas_obligatorias/causas_relajables/distancia_km) usando el mismo
// mecanismo compartido (evaluarElegibilidadJurado, services/
// elegibilidadJurado.js) — mockeado acá para aislar esta ruta de la
// evaluación real del motor (ya cubierta por motorPropuestaDesignacion*.test.js
// y por elegibilidadJurado.test.js). Las pruebas de REGRESIÓN del filtro de
// disponibilidad/cruce de fechas (que NUNCA cambia) siguen en
// rodeos.juradosDisponibles.test.js, sin tocar.
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

const RODEO = { id: 'R-DEST', asociacion: 'COLCHAGUA', fecha: '2026-11-07', duracion_dias: 2, club: 'HUEMUL' };

function preparar({ rodeos = [RODEO], usuarios_pagados = [], disponibilidad_usuarios = [], asignaciones = [], notas_rodeo = [] } = {}) {
    mockDb = crearSupabaseMemoria({ tablas: { rodeos, usuarios_pagados, disponibilidad_usuarios, asignaciones, notas_rodeo } });
}
function buscar(query = {}, usuario) {
    return llamarRouter(router, { metodo: 'GET', url: '/R-DEST/jurados-disponibles', params: { id: 'R-DEST' }, query, usuario });
}
function jurado(id, extra = {}) {
    return { id, nombre_completo: 'Jurado ' + id, categoria: 'A', codigo_interno: 'J-' + id, asociacion: 'OTRA', comuna: 'X', activo: true, tipo_persona: 'jurado', ...extra };
}
function dispCompleta(id) {
    return [{ usuario_pagado_id: id, fecha: '2026-11-07' }, { usuario_pagado_id: id, fecha: '2026-11-08' }];
}

beforeEach(() => {
    jest.clearAllMocks();
    cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: { _fake: true } });
    cargarDatosMotor.mockResolvedValue({ _contextoFake: true });
});

test('candidato DISPONIBLE_Y_HABILITADO -> estado_elegibilidad y distancia_km se exponen en la respuesta', async () => {
    preparar({ usuarios_pagados: [jurado('J1')], disponibilidad_usuarios: dispCompleta('J1') });
    evaluarElegibilidadJurado.mockReturnValue({ estado: 'DISPONIBLE_Y_HABILITADO', causas: [], causas_obligatorias: [], causas_relajables: [], distancia_km: 120 });

    const r = await buscar();

    expect(r.body.jurados[0]).toEqual(expect.objectContaining({
        id: 'J1', estado_elegibilidad: 'DISPONIBLE_Y_HABILITADO', causas_obligatorias: [], causas_relajables: [], distancia_km: 120
    }));
    expect(cargarDatosMotor).toHaveBeenCalledWith(['R-DEST']);
    expect(evaluarElegibilidadJurado).toHaveBeenCalledWith({ _contextoFake: true }, 'R-DEST', 'J1', { _fake: true });
});

test('candidato NO_HABILITADO (ej. MISMA_ASOCIACION) -> NUNCA se excluye de la lista, pero queda marcado y ordenado al final', async () => {
    preparar({
        usuarios_pagados: [jurado('J-OK', { nombre_completo: 'Ana' }), jurado('J-MAL', { nombre_completo: 'Beto' })],
        disponibilidad_usuarios: [...dispCompleta('J-OK'), ...dispCompleta('J-MAL')]
    });
    evaluarElegibilidadJurado.mockImplementation((ctx, rodeoId, juradoId) =>
        juradoId === 'J-MAL'
            ? { estado: 'NO_HABILITADO', causas: ['MISMA_ASOCIACION'], causas_obligatorias: ['MISMA_ASOCIACION'], causas_relajables: [], distancia_km: null }
            : { estado: 'DISPONIBLE_Y_HABILITADO', causas: [], causas_obligatorias: [], causas_relajables: [], distancia_km: 10 }
    );

    const r = await buscar();

    // Sigue en la lista (nunca se oculta por una restricción distinta de
    // disponibilidad/cruce de fechas) — solo se ordena al final.
    expect(r.body.jurados.map(j => j.id)).toEqual(['J-OK', 'J-MAL']);
    expect(r.body.jurados.find(j => j.id === 'J-MAL')).toEqual(expect.objectContaining({
        estado_elegibilidad: 'NO_HABILITADO', causas_obligatorias: ['MISMA_ASOCIACION']
    }));
});

test('candidato CON_ADVERTENCIAS (ej. DISTANCIA_EXCEDIDA) -> queda marcado con la causa relajable, sin excluirse', async () => {
    preparar({ usuarios_pagados: [jurado('J1')], disponibilidad_usuarios: dispCompleta('J1') });
    evaluarElegibilidadJurado.mockReturnValue({ estado: 'CON_ADVERTENCIAS', causas: ['DISTANCIA_EXCEDIDA'], causas_obligatorias: [], causas_relajables: ['DISTANCIA_EXCEDIDA'], distancia_km: 750 });

    const r = await buscar();

    expect(r.body.jurados[0]).toEqual(expect.objectContaining({
        estado_elegibilidad: 'CON_ADVERTENCIAS', causas_relajables: ['DISTANCIA_EXCEDIDA'], distancia_km: 750
    }));
});

test('configuración de designación no resuelta -> degrada con gracia (estado_elegibilidad null, la lista sigue funcionando igual que antes de esta corrección)', async () => {
    preparar({ usuarios_pagados: [jurado('J1')], disponibilidad_usuarios: dispCompleta('J1') });
    cargarConfiguracionDesignacionActiva.mockResolvedValue({ error: 'CONFIGURACION_DESIGNACION_NO_RESUELTA', detalle: 'sin config activa' });

    const r = await buscar();

    expect(r.body.jurados[0]).toEqual(expect.objectContaining({
        id: 'J1', estado_elegibilidad: null, causas_obligatorias: [], causas_relajables: [], distancia_km: null
    }));
    expect(cargarDatosMotor).not.toHaveBeenCalled();
    expect(evaluarElegibilidadJurado).not.toHaveBeenCalled();
});

test('error inesperado al cargar la configuración -> degrada con gracia (nunca rompe la lista de jurados disponibles)', async () => {
    preparar({ usuarios_pagados: [jurado('J1')], disponibilidad_usuarios: dispCompleta('J1') });
    cargarConfiguracionDesignacionActiva.mockRejectedValue(new Error('timeout de red'));

    const r = await buscar();

    expect(r.statusCode).toBe(200);
    expect(r.body.jurados[0]).toEqual(expect.objectContaining({ id: 'J1', estado_elegibilidad: null }));
});
