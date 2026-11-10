// CORRECCIÓN URGENTE — Designaciones que mostraban éxito pero no se
// guardaban (caso real: LO BARNECHEA / Felipe Ordóñez Saavedra, rodeo
// d913f26b-a30e-4245-bc70-5ba77a549e23).
//
// Causa raíz (dos bugs independientes, ambos en POST /admin/asignaciones):
//   1. CONTRATO DE RESPUESTA: el endpoint respondía SIEMPRE 201, incluso con
//      creadas.length===0 (ninguna asignación creada). El frontend
//      (designarJurado() en rodeos.html) nunca inspeccionaba el cuerpo —
//      cualquier HTTP 2xx bastaba para mostrar "designado correctamente".
//   2. TIPO JSONB: al confirmar una excepción (confirmar_advertencias=true),
//      p_causas_confirmadas se enviaba con JSON.stringify(...) — un array JS
//      ya se serializa correctamente al armar el body completo; pre-
//      serializarlo lo convertía en un STRING JSON (jsonb_typeof='string'),
//      así que crear_asignacion_con_bitacora() (migración 094, YA APLICADA
//      en producción — no se modifica ni se vuelve a ejecutar) rechazaba
//      SIEMPRE con CAUSAS_CONFIRMADAS_REQUERIDAS. Ese error quedaba
//      enterrado en erroresCreacion mientras el endpoint seguía
//      respondiendo 201 — exactamente la combinación que permitió el falso
//      "designado correctamente" para Felipe en LO BARNECHEA (advertencia
//      FINDE_CONSECUTIVO confirmada).
//
// Este archivo cubre el CONTRATO DE RESPUESTA de la ruta (mock de
// supabase.rpc/from, sin HTTP real — mismo patrón que
// asignaciones.auditoriaCierre.test.js). El bug 2 (tipo JSONB real) y la
// atomicidad de la RPC ya están cubiertos contra Postgres REAL (PGlite) en
// backend/src/services/designacionManualConBitacora.rpc.test.js — este
// archivo no lo repite, solo verifica que asignaciones.js llama a la RPC con
// el arreglo JS real (ver también la aserción corregida en
// asignaciones.elegibilidad.test.js).
jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
jest.mock('../../services/auditoria', () => ({ registrar: jest.fn().mockResolvedValue(undefined) }));
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

const supabase = require('../../config/supabase');
const { cargarDatosMotor } = require('../../services/motorPropuestaDesignacion');
const { cargarConfiguracionDesignacionActiva } = require('../../services/configuracionDesignacionRepositorio');
const { evaluarElegibilidadJurado } = require('../../services/elegibilidadJurado');
const router = require('./asignaciones');

function crearSupabaseMock(porTabla) {
    const consumir = (tabla) => {
        const entrada = porTabla[tabla];
        if (entrada === undefined) return { data: [], error: null };
        if (Array.isArray(entrada)) return entrada.length > 1 ? entrada.shift() : entrada[0];
        return entrada;
    };
    supabase.from.mockImplementation((tabla) => {
        const chain = {
            select: () => chain, eq: () => chain, neq: () => chain, in: () => chain,
            ilike: () => chain, order: () => chain, limit: () => chain, range: () => chain,
            insert: () => chain, update: () => chain, delete: () => chain,
            single: () => chain, maybeSingle: () => chain,
            then: (resolve, reject) => Promise.resolve(consumir(tabla)).then(resolve, reject)
        };
        return chain;
    });
}

function llamarRuta({ method, url, body, params }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url,
            body: body || {}, query: {}, params: params || {}, headers: {},
            ip: '127.0.0.1',
            usuario: { id: 'admin-test', tipo: 'administrador', rol_evaluacion: null },
            get() { return undefined; }
        };
        const res = {
            statusCode: 200,
            status(codigo) { this.statusCode = codigo; return this; },
            json(payload) { resolve({ status: this.statusCode, body: payload }); return this; }
        };
        router(req, res, (err) => {
            if (err) reject(err);
            else resolve({ status: 404, body: { error: 'ruta no encontrada por el router' } });
        });
    });
}

const RODEO = { id: 'R1', duracion_dias: 2, estado: 'activo', fecha: '2026-11-14' };
const TARIFAS = [{ categoria: 'A', valor_diario: 100000 }];

function mockBaseFelipe() {
    crearSupabaseMock({
        rodeos: { data: RODEO, error: null },
        configuracion_tarifas: { data: TARIFAS, error: null },
        usuarios_pagados: { data: { id: 'felipe-id', nombre_completo: 'Felipe Ordóñez Saavedra', tipo_persona: 'jurado', categoria: 'A', activo: true }, error: null },
        disponibilidad_usuarios: { data: [{ fecha: '2026-11-14' }, { fecha: '2026-11-15' }], error: null },
        asignaciones: { data: [], error: null },
        catalogo_motivos_designacion: { data: { id: 'mot-1', activo: true }, error: null }
    });
    evaluarElegibilidadJurado.mockReturnValue({
        estado: 'CON_ADVERTENCIAS', causas: ['FINDE_CONSECUTIVO'],
        causas_obligatorias: [], causas_relajables: ['FINDE_CONSECUTIVO'], distancia_km: 20
    });
}

function llamarFelipe() {
    return llamarRuta({
        method: 'POST', url: '/',
        body: {
            rodeo_id: 'R1',
            personas: [{
                usuario_pagado_id: 'felipe-id', tipo_persona: 'jurado', confirmar_advertencias: true,
                motivo_codigo: 'jurado_no_disponible', motivo_detalle: 'Único disponible esa fecha'
            }]
        }
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    cargarConfiguracionDesignacionActiva.mockResolvedValue({ configuracion: { _fake: true } });
    cargarDatosMotor.mockResolvedValue({ _contextoFake: true });
});

describe('CORRECCIÓN URGENTE — reproducción aislada del caso LO BARNECHEA (Felipe Ordóñez, FINDE_CONSECUTIVO confirmado)', () => {
    test('la RPC rechaza (p.ej. el bug original: CAUSAS_CONFIRMADAS_REQUERIDAS) -> NUNCA 2xx de éxito; responde 422 con el motivo real, creadas vacío', async () => {
        mockBaseFelipe();
        supabase.rpc.mockResolvedValue({ data: null, error: { message: "CAUSAS_CONFIRMADAS_REQUERIDAS: esta excepción debe declarar al menos una causa relajable confirmada" } });

        const { status, body } = await llamarFelipe();

        expect(status).toBe(422);
        expect(body.creadas).toHaveLength(0);
        expect(body.mensaje).not.toMatch(/designado|creada/i);
        // el campo que lee api.js/apiFetch para el mensaje de la excepción
        // en el frontend (ver frontend/js/api.js: data?.error)
        expect(body.error).toBeTruthy();
    });

    test('el mensaje de error final queda comprensible: se quita el prefijo técnico "CODIGO:" del RAISE EXCEPTION de la RPC', async () => {
        mockBaseFelipe();
        supabase.rpc.mockResolvedValue({ data: null, error: { message: "CAUSAS_CONFIRMADAS_REQUERIDAS: esta excepción debe declarar al menos una causa relajable confirmada" } });

        const { body } = await llamarFelipe();

        expect(body.errores[0].error).toBe('esta excepción debe declarar al menos una causa relajable confirmada');
        expect(body.errores[0].error).not.toMatch(/^[A-Z_]+:/);
        expect(body.error).toBe('esta excepción debe declarar al menos una causa relajable confirmada');
    });

    test('con la corrección aplicada, la llamada real a la RPC ya no reproduce el bug: p_causas_confirmadas llega como arreglo JS real y la asignación se crea', async () => {
        mockBaseFelipe();
        supabase.rpc.mockResolvedValue({ data: { asignacion: { id: 'asig-felipe', usuario_pagado_id: 'felipe-id' }, bitacora_id: 'bit-felipe' }, error: null });

        const { status, body } = await llamarFelipe();

        expect(status).toBe(201);
        expect(body.creadas).toEqual([{ id: 'asig-felipe', usuario_pagado_id: 'felipe-id' }]);
        expect(supabase.rpc).toHaveBeenCalledWith('crear_asignacion_con_bitacora', expect.objectContaining({
            p_causas_confirmadas: ['FINDE_CONSECUTIVO']
        }));
        // defensa en profundidad: si esto alguna vez volviera a pre-serializarse,
        // este assert lo detecta inmediatamente (nunca un string JSON).
        expect(typeof supabase.rpc.mock.calls[0][1].p_causas_confirmadas).not.toBe('string');
    });

    test('reintento sobre un jurado ya designado vigente en el mismo rodeo (p.ej. doble clic / reenvío) -> 422, mensaje claro, nunca crea una segunda asignación', async () => {
        mockBaseFelipe();
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'JURADO_YA_DESIGNADO_EN_RODEO' } });

        const { status, body } = await llamarFelipe();

        expect(status).toBe(422);
        expect(body.creadas).toHaveLength(0);
        expect(body.errores[0].error).toBe('El jurado ya está designado vigente en este mismo rodeo');
    });
});

describe('CORRECCIÓN URGENTE — éxito parcial explícito con dos excepciones confirmadas en el mismo lote', () => {
    test('dos jurados con excepción confirmada en la misma solicitud: uno crea, el otro falla en la RPC -> 207, nunca afirma que todo se guardó', async () => {
        crearSupabaseMock({
            rodeos: { data: RODEO, error: null },
            configuracion_tarifas: { data: TARIFAS, error: null },
            usuarios_pagados: [
                { data: { id: 'jur-ok', nombre_completo: 'Jurado OK', tipo_persona: 'jurado', categoria: 'A', activo: true }, error: null },
                { data: { id: 'jur-mal', nombre_completo: 'Jurado Mal', tipo_persona: 'jurado', categoria: 'A', activo: true }, error: null }
            ],
            disponibilidad_usuarios: { data: [{ fecha: '2026-11-14' }, { fecha: '2026-11-15' }], error: null },
            asignaciones: { data: [], error: null },
            catalogo_motivos_designacion: { data: { id: 'mot-1', activo: true }, error: null }
        });
        evaluarElegibilidadJurado.mockReturnValue({ estado: 'CON_ADVERTENCIAS', causas: ['FINDE_CONSECUTIVO'], causas_obligatorias: [], causas_relajables: ['FINDE_CONSECUTIVO'], distancia_km: 20 });
        supabase.rpc
            .mockResolvedValueOnce({ data: { asignacion: { id: 'asig-ok', usuario_pagado_id: 'jur-ok' }, bitacora_id: 'bit-ok' }, error: null })
            .mockResolvedValueOnce({ data: null, error: { message: 'CRUCE_DISPONIBILIDAD' } });

        const { status, body } = await llamarRuta({
            method: 'POST', url: '/',
            body: {
                rodeo_id: 'R1',
                personas: [
                    { usuario_pagado_id: 'jur-ok', tipo_persona: 'jurado', confirmar_advertencias: true, motivo_codigo: 'otro' },
                    { usuario_pagado_id: 'jur-mal', tipo_persona: 'jurado', confirmar_advertencias: true, motivo_codigo: 'otro' }
                ]
            }
        });

        expect(status).toBe(207);
        expect(body.creadas).toHaveLength(1);
        expect(body.creadas[0].usuario_pagado_id).toBe('jur-ok');
        expect(body.errores).toHaveLength(1);
        expect(body.errores[0].usuario_pagado_id).toBe('jur-mal');
        expect(body.mensaje).toMatch(/1 asignación\(es\) creada\(s\), 1 con error/);
    });
});
