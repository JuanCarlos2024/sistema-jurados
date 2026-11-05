// elegibilidadJurado.js — mecanismo ÚNICO y compartido de elegibilidad
// (Auditoría de elegibilidad, Etapa A). Este módulo es solo un envoltorio de
// clasificación sobre evaluarCandidatoDirecto() — nunca reimplementa una
// regla — así que estas pruebas mockean evaluarCandidatoDirecto (ya probado
// exhaustivamente en motorPropuestaDesignacion.test.js) y verifican
// EXCLUSIVAMENTE la clasificación en los 3 estados y el paso de datos.
jest.mock('./motorPropuestaDesignacion', () => ({ evaluarCandidatoDirecto: jest.fn() }));

const { evaluarCandidatoDirecto } = require('./motorPropuestaDesignacion');
const { ESTADOS_ELEGIBILIDAD, clasificarCausas, evaluarElegibilidadJurado } = require('./elegibilidadJurado');
const { CAUSAS_OBLIGATORIAS, CAUSAS_RELAJABLES } = require('./motorPropuestaDesignacionGlobal');

describe('clasificarCausas', () => {
    test('sin causas -> DISPONIBLE_Y_HABILITADO', () => {
        expect(clasificarCausas([])).toBe(ESTADOS_ELEGIBILIDAD.DISPONIBLE_Y_HABILITADO);
        expect(clasificarCausas(undefined)).toBe(ESTADOS_ELEGIBILIDAD.DISPONIBLE_Y_HABILITADO);
    });

    test('solo causas relajables -> CON_ADVERTENCIAS', () => {
        const unaRelajable = [...CAUSAS_RELAJABLES][0];
        expect(clasificarCausas([unaRelajable])).toBe(ESTADOS_ELEGIBILIDAD.CON_ADVERTENCIAS);
    });

    test('cualquier causa obligatoria -> NO_HABILITADO, incluso mezclada con relajables', () => {
        const unaObligatoria = [...CAUSAS_OBLIGATORIAS][0];
        const unaRelajable = [...CAUSAS_RELAJABLES][0];
        expect(clasificarCausas([unaObligatoria])).toBe(ESTADOS_ELEGIBILIDAD.NO_HABILITADO);
        expect(clasificarCausas([unaRelajable, unaObligatoria])).toBe(ESTADOS_ELEGIBILIDAD.NO_HABILITADO);
    });

    test('todas las causas obligatorias/relajables conocidas por el motor global son clasificables (ninguna cae en una 3ra categoría)', () => {
        for (const c of CAUSAS_OBLIGATORIAS) expect(clasificarCausas([c])).toBe(ESTADOS_ELEGIBILIDAD.NO_HABILITADO);
        for (const c of CAUSAS_RELAJABLES) expect(clasificarCausas([c])).toBe(ESTADOS_ELEGIBILIDAD.CON_ADVERTENCIAS);
    });
});

describe('evaluarElegibilidadJurado', () => {
    beforeEach(() => jest.clearAllMocks());

    test('propaga el error de evaluarCandidatoDirecto como NO_HABILITADO (nunca se trata un error como "sin causas")', () => {
        evaluarCandidatoDirecto.mockReturnValue({ error: 'JURADO_INACTIVO_O_INEXISTENTE' });

        const r = evaluarElegibilidadJurado({}, 'R1', 'J1', {});

        expect(r).toEqual({
            estado: ESTADOS_ELEGIBILIDAD.NO_HABILITADO, error: 'JURADO_INACTIVO_O_INEXISTENTE',
            causas: [], causas_obligatorias: [], causas_relajables: [], distancia_km: null, zona_extrema: null, jurado: null
        });
    });

    test('sin causas -> DISPONIBLE_Y_HABILITADO, con distancia_km, zona_extrema y la identidad del jurado pasados tal cual (Corrección final de seguridad: evita una 2ª consulta en cada llamador)', () => {
        evaluarCandidatoDirecto.mockReturnValue({ evaluacion: { causas: [], distanciaKm: 42, jurado: { id: 'J1', nombre_completo: 'Jurado Uno', categoria: 'A' } }, zonaExtrema: 'NORTE' });

        const r = evaluarElegibilidadJurado({}, 'R1', 'J1', {});

        expect(r).toEqual({
            estado: ESTADOS_ELEGIBILIDAD.DISPONIBLE_Y_HABILITADO, causas: [],
            causas_obligatorias: [], causas_relajables: [], distancia_km: 42, zona_extrema: 'NORTE',
            jurado: { id: 'J1', nombre_completo: 'Jurado Uno', categoria: 'A' }
        });
    });

    test('separa correctamente causas_obligatorias de causas_relajables cuando vienen mezcladas', () => {
        const obligatoria = [...CAUSAS_OBLIGATORIAS][0];
        const relajable = [...CAUSAS_RELAJABLES][0];
        evaluarCandidatoDirecto.mockReturnValue({ evaluacion: { causas: [obligatoria, relajable], distanciaKm: null } });

        const r = evaluarElegibilidadJurado({}, 'R1', 'J1', {});

        expect(r.estado).toBe(ESTADOS_ELEGIBILIDAD.NO_HABILITADO);
        expect(r.causas).toEqual([obligatoria, relajable]);
        expect(r.causas_obligatorias).toEqual([obligatoria]);
        expect(r.causas_relajables).toEqual([relajable]);
    });

    test('pasa contexto/rodeoId/juradoId/configuración exactamente a evaluarCandidatoDirecto, sin transformarlos', () => {
        evaluarCandidatoDirecto.mockReturnValue({ evaluacion: { causas: [] } });
        const contexto = { _marca: 'ctx' }, configuracion = { _marca: 'cfg' };

        evaluarElegibilidadJurado(contexto, 'R9', 'J9', configuracion);

        expect(evaluarCandidatoDirecto).toHaveBeenCalledWith(contexto, 'R9', 'J9', configuracion);
    });
});
