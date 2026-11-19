// POST /api/admin/asignaciones — Designación manual con excepciones
// autorizadas (corrección 2026-11-19).
//
// A diferencia de asignaciones.elegibilidad.test.js (que mockea la
// elegibilidad), aquí corre la elegibilidad REAL (elegibilidadJurado.js +
// motor real) sobre un contexto con la forma de cargarDatosMotor(); solo se
// simulan la BD (supabase), la configuración activa y la auditoría. Ninguna
// prueba toca datos reales.
jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
jest.mock('../../services/auditoria', () => ({ registrar: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/motorPropuestaDesignacion', () => {
    const real = jest.requireActual('../../services/motorPropuestaDesignacion');
    return { ...real, cargarDatosMotor: jest.fn() };
});
jest.mock('../../services/configuracionDesignacionRepositorio', () => ({ cargarConfiguracionDesignacionActiva: jest.fn() }));

const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');
const { cargarDatosMotor, construirUltimaFechaAsociacionPorJurado, construirFechasAsociacionPorJurado } = require('../../services/motorPropuestaDesignacion');
const { cargarConfiguracionDesignacionActiva } = require('../../services/configuracionDesignacionRepositorio');
const { construirConfiguracionDefaultV1, clonarConfiguracion } = require('../../services/configuracionDesignacion');
const { calcularBloqueRodeo, rangoFechas } = require('../../services/feriados');
const router = require('./asignaciones');

// ── Fixtures (misma forma que cargarDatosMotor) ─────────────────────────────
const TEMPORADA = { nombre: '2026-2027', fecha_inicio: '2026-04-01', fecha_fin: '2027-03-31' };
const COMUNA = { id: 'c-1', nombre: 'ComunaX', nombre_normalizado: 'comunax', region: 'Test', latitud: -36, longitud: -71.6 };
const CONFIG_V16 = clonarConfiguracion(construirConfiguracionDefaultV1(), {
    schema_version: 4, regla_repeticion_asociacion_intervalo_activa: true, repeticion_asociacion_meses: 2,
    regla_no_repetir_asociacion_activa: false, regla_finde_consecutivo_activa: true
});
const RODEO_MOTOR = {
    id: 'R1', club: 'ALBORADA DE LINARES', asociacion: 'LINARES', fecha: '2026-11-28', duracion_dias: 1, estado: 'activo',
    clasificacion_codigo: 'provincial', comuna_resuelta: { id: COMUNA.id, nombre: COMUNA.nombre, latitud: COMUNA.latitud, longitud: COMUNA.longitud },
    fechas: rangoFechas('2026-11-28', 1), bloque: calcularBloqueRodeo('2026-11-28', 1)
};
function asig(rodeoId, fecha, asociacion, club) {
    return { usuario_pagado_id: 'J1', rodeo_id: rodeoId, estado: 'activo', estado_designacion: 'aceptado', rodeos: { fecha, duracion_dias: 1, asociacion, club } };
}
function contextoCon(historial, { asociacionJurado = 'RIO RAHUE' } = {}) {
    return {
        idsSolicitados: ['R1'], temporada: TEMPORADA, rodeosPorId: new Map([['R1', RODEO_MOTOR]]),
        jurados: [{ id: 'J1', nombre_completo: 'Jurado Uno', categoria: 'A', asociacion: asociacionJurado, comuna: 'ComunaX' }],
        catalogoComunas: { comunas: [COMUNA], alias: [] }, disponibilidad: new Map([['J1', new Set(['2026-11-28'])]]),
        asignacionesTemporada: historial, asignacionesHistoricas: historial,
        ultimaFechaAsociacionPorJurado: construirUltimaFechaAsociacionPorJurado(historial),
        fechasAsociacionPorJurado: construirFechasAsociacionPorJurado(historial)
    };
}
const HIST = {
    fueraIntervalo: [asig('R-YB', '2026-05-01', 'LINARES', 'YERBAS BUENAS')],
    augusto: [asig('R-YB', '2026-05-01', 'LINARES', 'YERBAS BUENAS'), asig('R-LONCO', '2026-11-21', 'LAGO LLANQUIHUE', 'LONCOTORO')],
    dentroIntervalo: [asig('R-YB', '2026-10-24', 'LINARES', 'YERBAS BUENAS')],
    dentroMasFinde: [asig('R-YB', '2026-10-24', 'LINARES', 'YERBAS BUENAS'), asig('R-LONCO', '2026-11-21', 'LAGO LLANQUIHUE', 'LONCOTORO')]
};

// ── BD simulada (cola por tabla) — mismo patrón que asignaciones.elegibilidad.test.js
function crearSupabaseMock(porTabla) {
    const consumir = (tabla) => {
        const entrada = porTabla[tabla];
        if (entrada === undefined) return { data: [], error: null };
        if (Array.isArray(entrada)) return entrada.length > 1 ? entrada.shift() : entrada[0];
        return entrada;
    };
    supabase.from.mockImplementation((tabla) => {
        const chain = {
            select: () => chain, eq: () => chain, neq: () => chain, in: () => chain, ilike: () => chain, order: () => chain,
            limit: () => chain, range: () => chain, insert: () => chain, update: () => chain, delete: () => chain,
            single: () => chain, maybeSingle: () => chain,
            then: (resolve, reject) => Promise.resolve(consumir(tabla)).then(resolve, reject)
        };
        return chain;
    });
}
function baseBD(extra = {}) {
    crearSupabaseMock({
        rodeos: { data: { id: 'R1', duracion_dias: 1, estado: 'activo', fecha: '2026-11-28' }, error: null },
        configuracion_tarifas: { data: [{ categoria: 'A', valor_diario: 100000 }], error: null },
        usuarios_pagados: { data: { id: 'J1', nombre_completo: 'Jurado Uno', tipo_persona: 'jurado', categoria: 'A', activo: true }, error: null },
        disponibilidad_usuarios: { data: [{ fecha: '2026-11-28' }], error: null },
        asignaciones: [{ data: [], error: null }, { data: { id: 'asig-simple', usuario_pagado_id: 'J1' }, error: null }],
        catalogo_motivos_designacion: { data: { id: 'mot-1', activo: true }, error: null },
        ...extra
    });
}
function post(persona) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url: '/', originalUrl: '/', body: { rodeo_id: 'R1', personas: [{ usuario_pagado_id: 'J1', tipo_persona: 'jurado', ...persona }] },
            query: {}, params: {}, headers: {}, ip: '127.0.0.1',
            usuario: { id: 'admin-test', tipo: 'administrador', rol_evaluacion: null }, get() { return undefined; }
        };
        const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(p) { resolve({ status: this.statusCode, body: p }); return this; } };
        router(req, res, (err) => (err ? reject(err) : resolve({ status: 404, body: {} })));
    });
}
const insertsDeAsignacion = () => supabase.from.mock.calls.filter(c => c[0] === 'asignaciones').length - 1; // la 1ª es el chequeo de cruce

beforeEach(() => {
    jest.clearAllMocks();
    cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: CONFIG_V16 });
    supabase.rpc.mockResolvedValue({ data: { asignacion: { id: 'asig-exc', usuario_pagado_id: 'J1' }, bitacora_id: 'bit-1' }, error: null });
});

describe('Repetición fuera del intervalo', () => {
    test('habilitado: se crea por el INSERT simple, sin excepción ni RPC', async () => {
        cargarDatosMotor.mockResolvedValue(contextoCon(HIST.fueraIntervalo));
        baseBD();
        const { status, body } = await post({});
        expect(status).toBe(201);
        expect(body.creadas).toEqual([{ id: 'asig-simple', usuario_pagado_id: 'J1' }]);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });
});

describe('Repetición dentro del intervalo — excepción administrativa manual', () => {
    beforeEach(() => cargarDatosMotor.mockResolvedValue(contextoCon(HIST.dentroIntervalo)));

    test('sin confirmar -> advertencia que exige confirmación, nada se crea', async () => {
        baseBD();
        const { status, body } = await post({});
        expect(status).toBe(422);
        expect(body.errores[0]).toEqual(expect.objectContaining({ estado_elegibilidad: 'CON_ADVERTENCIAS', causas: ['ASOCIACION_REPETIDA_INTERVALO'], requiere_confirmacion: true }));
        expect(supabase.rpc).not.toHaveBeenCalled();
        expect(insertsDeAsignacion()).toBe(0);
    });

    test('confirmar_advertencias:true "pelado" enviado por HTTP (sin causas_aceptadas) -> rechazado, nunca basta para el intervalo', async () => {
        baseBD();
        const { body } = await post({ confirmar_advertencias: true, motivo_codigo: 'criterio_tecnico_area_deportiva' });
        expect(body.errores[0]).toEqual(expect.objectContaining({ code: 'REQUIERE_CONFIRMACION_ADVERTENCIAS', causas: ['ASOCIACION_REPETIDA_INTERVALO'] }));
        expect(body.errores[0].detalle_advertencias[0].rodeos[0]).toEqual({ club: 'YERBAS BUENAS', asociacion: 'LINARES', fecha: '2026-10-24' });
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('confirmada y con causas exactas pero SIN motivo -> rechazado (requiere_motivo)', async () => {
        baseBD();
        const { body } = await post({ confirmar_advertencias: true, causas_aceptadas: ['ASOCIACION_REPETIDA_INTERVALO'] });
        expect(body.errores[0]).toEqual(expect.objectContaining({ requiere_motivo: true }));
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('confirmada + causas exactas + motivo válido -> crea vía crear_asignacion_con_bitacora y audita con fechas/asociación', async () => {
        baseBD();
        const { status, body } = await post({
            confirmar_advertencias: true, causas_aceptadas: ['ASOCIACION_REPETIDA_INTERVALO'],
            motivo_codigo: 'criterio_tecnico_area_deportiva', motivo_detalle: 'Único disponible'
        });
        expect(status).toBe(201);
        expect(body.creadas).toEqual([{ id: 'asig-exc', usuario_pagado_id: 'J1' }]);
        expect(supabase.rpc).toHaveBeenCalledWith('crear_asignacion_con_bitacora', expect.objectContaining({
            p_rodeo_id: 'R1', p_usuario_pagado_id: 'J1', p_motivo_catalogo_id: 'mot-1', p_actor_id: 'admin-test',
            p_causas_confirmadas: ['ASOCIACION_REPETIDA_INTERVALO'], p_motivo_detalle: 'Único disponible'
        }));
        expect(insertsDeAsignacion()).toBe(0); // nunca el INSERT simple
        const aud = auditoria.registrar.mock.calls[0][0];
        expect(aud.datos_nuevos).toEqual(expect.objectContaining({
            excepcion_confirmada: true, causas_relajables: ['ASOCIACION_REPETIDA_INTERVALO'], motivo_codigo: 'criterio_tecnico_area_deportiva'
        }));
        expect(aud.datos_nuevos.detalle_advertencias[0]).toEqual(expect.objectContaining({
            causa: 'ASOCIACION_REPETIDA_INTERVALO', meses: 2, rodeos: [{ club: 'YERBAS BUENAS', asociacion: 'LINARES', fecha: '2026-10-24' }]
        }));
    });

    test('migración 104 aún no aplicada (RPC rechaza la causa) -> falla controlada, nada se crea', async () => {
        baseBD();
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'CAUSA_CONFIRMADA_DESCONOCIDA: solo se aceptan causas relajables reconocidas por el motor' } });
        const { status, body } = await post({
            confirmar_advertencias: true, causas_aceptadas: ['ASOCIACION_REPETIDA_INTERVALO'], motivo_codigo: 'criterio_tecnico_area_deportiva'
        });
        expect(status).toBe(422);
        expect(body.creadas).toEqual([]);
        expect(body.errores[0]).toEqual(expect.objectContaining({ code: 'MIGRACION_104_PENDIENTE' }));
        expect(auditoria.registrar).not.toHaveBeenCalled();
    });
});

describe('Fin de semana consecutivo y varias advertencias', () => {
    test('caso Augusto: solo FINDE_CONSECUTIVO -> confirmación con esa causa exacta + motivo crea y audita', async () => {
        cargarDatosMotor.mockResolvedValue(contextoCon(HIST.augusto));
        baseBD();
        const { status } = await post({ confirmar_advertencias: true, causas_aceptadas: ['FINDE_CONSECUTIVO'], motivo_codigo: 'criterio_tecnico_area_deportiva' });
        expect(status).toBe(201);
        expect(supabase.rpc).toHaveBeenCalledWith('crear_asignacion_con_bitacora', expect.objectContaining({ p_causas_confirmadas: ['FINDE_CONSECUTIVO'] }));
        expect(auditoria.registrar.mock.calls[0][0].datos_nuevos.detalle_advertencias).toEqual([
            { causa: 'FINDE_CONSECUTIVO', rodeos: [{ club: 'LONCOTORO', asociacion: 'LAGO LLANQUIHUE', fecha: '2026-11-21' }] }
        ]);
    });

    test('varias advertencias: ambas aceptadas en una sola confirmación -> crea con las dos causas', async () => {
        cargarDatosMotor.mockResolvedValue(contextoCon(HIST.dentroMasFinde));
        baseBD();
        const { status } = await post({
            confirmar_advertencias: true, causas_aceptadas: ['FINDE_CONSECUTIVO', 'ASOCIACION_REPETIDA_INTERVALO'], motivo_codigo: 'criterio_tecnico_area_deportiva'
        });
        expect(status).toBe(201);
        const causas = supabase.rpc.mock.calls[0][1].p_causas_confirmadas;
        expect([...causas].sort()).toEqual(['ASOCIACION_REPETIDA_INTERVALO', 'FINDE_CONSECUTIVO']);
    });
});

describe('Cambio de elegibilidad antes de guardar — revalidación y rechazo controlado', () => {
    test('se aceptó solo FINDE_CONSECUTIVO pero al guardar aparece además el intervalo -> ADVERTENCIAS_CAMBIARON, nada se crea', async () => {
        cargarDatosMotor.mockResolvedValue(contextoCon(HIST.dentroMasFinde));
        baseBD();
        const { status, body } = await post({ confirmar_advertencias: true, causas_aceptadas: ['FINDE_CONSECUTIVO'], motivo_codigo: 'criterio_tecnico_area_deportiva' });
        expect(status).toBe(422);
        expect(body.errores[0]).toEqual(expect.objectContaining({
            code: 'ADVERTENCIAS_CAMBIARON', causas_nuevas: ['ASOCIACION_REPETIDA_INTERVALO'], causas_ya_no_existen: []
        }));
        expect(supabase.rpc).not.toHaveBeenCalled();
        expect(insertsDeAsignacion()).toBe(0);
    });

    test('se aceptó una advertencia que ya no existe (hoy habilitado) -> ADVERTENCIAS_CAMBIARON, nada se crea', async () => {
        cargarDatosMotor.mockResolvedValue(contextoCon(HIST.fueraIntervalo));
        baseBD();
        const { body } = await post({ confirmar_advertencias: true, causas_aceptadas: ['ASOCIACION_REPETIDA_INTERVALO'], motivo_codigo: 'criterio_tecnico_area_deportiva' });
        expect(body.errores[0]).toEqual(expect.objectContaining({ code: 'ADVERTENCIAS_CAMBIARON', causas_ya_no_existen: ['ASOCIACION_REPETIDA_INTERVALO'] }));
        expect(supabase.rpc).not.toHaveBeenCalled();
        expect(insertsDeAsignacion()).toBe(0);
    });
});

describe('Lista EXACTA de causas obligatoria para TODA advertencia (no solo el intervalo) — solicitud HTTP directa', () => {
    // Caso Augusto: única advertencia actual = FINDE_CONSECUTIVO.
    beforeEach(() => cargarDatosMotor.mockResolvedValue(contextoCon(HIST.augusto)));
    const MOTIVO = { motivo_codigo: 'criterio_tecnico_area_deportiva' };

    test.each([
        ['ausente', { confirmar_advertencias: true, ...MOTIVO }, 'REQUIERE_CONFIRMACION_ADVERTENCIAS'],
        ['vacía', { confirmar_advertencias: true, causas_aceptadas: [], ...MOTIVO }, 'REQUIERE_CONFIRMACION_ADVERTENCIAS'],
        ['con sobrantes', { confirmar_advertencias: true, causas_aceptadas: ['FINDE_CONSECUTIVO', 'DISTANCIA_EXCEDIDA'], ...MOTIVO }, 'ADVERTENCIAS_CAMBIARON'],
        ['equivocada', { confirmar_advertencias: true, causas_aceptadas: ['DISTANCIA_EXCEDIDA'], ...MOTIVO }, 'ADVERTENCIAS_CAMBIARON'],
        ['duplicada', { confirmar_advertencias: true, causas_aceptadas: ['FINDE_CONSECUTIVO', 'FINDE_CONSECUTIVO'], ...MOTIVO }, 'CAUSAS_ACEPTADAS_INVALIDAS'],
        ['que no es lista', { confirmar_advertencias: true, causas_aceptadas: 'FINDE_CONSECUTIVO', ...MOTIVO }, 'CAUSAS_ACEPTADAS_INVALIDAS']
    ])('lista %s -> rechazo (%s), nada se crea', async (_n, persona, code) => {
        baseBD();
        const { status, body } = await post(persona);
        expect(status).toBe(422);
        expect(body.errores[0].code).toBe(code);
        expect(supabase.rpc).not.toHaveBeenCalled();
        expect(insertsDeAsignacion()).toBe(0);
    });

    test('lista exacta pero SIN confirmar_advertencias -> rechazo (requiere confirmación), nada se crea', async () => {
        baseBD();
        const { body } = await post({ causas_aceptadas: ['FINDE_CONSECUTIVO'], ...MOTIVO });
        expect(body.errores[0]).toEqual(expect.objectContaining({ requiere_confirmacion: true }));
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('lista exacta + confirmación pero motivo inactivo -> rechazo, nada se crea', async () => {
        baseBD({ catalogo_motivos_designacion: { data: { id: 'mot-x', activo: false }, error: null } });
        const { body } = await post({ confirmar_advertencias: true, causas_aceptadas: ['FINDE_CONSECUTIVO'], motivo_codigo: 'inactivo' });
        expect(body.errores[0].error).toBe('motivo_codigo inválido o inactivo');
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('lo registrado en bitácora son las causas REVALIDADAS por el backend, nunca texto del cliente', async () => {
        baseBD();
        await post({ confirmar_advertencias: true, causas_aceptadas: [' FINDE_CONSECUTIVO '], ...MOTIVO });
        expect(supabase.rpc.mock.calls[0][1].p_causas_confirmadas).toEqual(['FINDE_CONSECUTIVO']);
    });
});

describe('Restricción estructural — bloqueo total, ninguna confirmación la pasa', () => {
    test('jurado de la propia asociación organizadora + intervalo, todo "confirmado" -> NO_HABILITADO, nada se crea', async () => {
        cargarDatosMotor.mockResolvedValue(contextoCon(HIST.dentroIntervalo, { asociacionJurado: 'LINARES' }));
        baseBD();
        const { status, body } = await post({
            confirmar_advertencias: true, causas_aceptadas: ['ASOCIACION_REPETIDA_INTERVALO', 'MISMA_ASOCIACION'], motivo_codigo: 'criterio_tecnico_area_deportiva'
        });
        expect(status).toBe(422);
        expect(body.errores[0]).toEqual(expect.objectContaining({ estado_elegibilidad: 'NO_HABILITADO', causas: ['MISMA_ASOCIACION'] }));
        expect(supabase.rpc).not.toHaveBeenCalled();
        expect(insertsDeAsignacion()).toBe(0);
    });
});
