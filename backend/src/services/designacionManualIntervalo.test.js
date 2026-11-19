// Corrección 2026-11-19 — Designaciones manuales con excepciones autorizadas.
//
// Caso real (configuración v16: intervalo 2 meses activo, "no repetir en toda
// la temporada" desactivada, fines de semana consecutivos activa): jurado con
// última designación en LINARES el 01/05/2026 aparecía NO HABILITADO para
// ALBORADA DE LINARES 28/11/2026 por ASOCIACION_REPETIDA_INTERVALO, aunque
// habían pasado más de 2 meses — el motor sumaba `|| repiteAsociacionTemporada`.
//
// Estas pruebas usan el MOTOR REAL (evaluarCandidato/evaluarCandidatoDirecto,
// ejecutarSimulacion y ejecutarSimulacionGlobal) y la clasificación real de
// elegibilidadJurado.js — sin mocks de reglas.
const {
    ejecutarSimulacion, construirUltimaFechaAsociacionPorJurado, construirFechasAsociacionPorJurado,
    buscarConflictoIntervalo, registrarFechaAsociacionLote, retirarFechaAsociacionLote,
    construirMatrizPorClasificacionDesdeConfiguracion, construirMatrizZonaExtremaDesdeConfiguracion, resolverMatrizParaRodeo
} = require('./motorPropuestaDesignacion');
const { ejecutarSimulacionGlobal, resolverAsignacionGlobal, CAUSAS_OBLIGATORIAS, CAUSAS_RELAJABLES } = require('./motorPropuestaDesignacionGlobal');
const {
    evaluarElegibilidadJurado, ESTADOS_ELEGIBILIDAD, CAUSAS_EXCEPCIONABLES_MANUAL, FLUJO_DESIGNACION_MANUAL, clasificarCausas
} = require('./elegibilidadJurado');
const { construirConfiguracionDefaultV1, clonarConfiguracion } = require('./configuracionDesignacion');
const { calcularBloqueRodeo, rangoFechas } = require('./feriados');

const TEMPORADA = { nombre: '2026-2027', fecha_inicio: '2026-04-01', fecha_fin: '2027-03-31' };
const COMUNA = { id: 'c-1', nombre: 'ComunaX', nombre_normalizado: 'comunax', region: 'Test', latitud: -36, longitud: -71.6 };
const MANUAL = { flujo: FLUJO_DESIGNACION_MANUAL };

// Configuración equivalente a la v16 de producción en lo que importa aquí.
function configV16(cambios = {}) {
    return clonarConfiguracion(construirConfiguracionDefaultV1(), {
        schema_version: 4,
        regla_repeticion_asociacion_intervalo_activa: true,
        repeticion_asociacion_meses: 2,
        regla_no_repetir_asociacion_activa: false,
        regla_finde_consecutivo_activa: true,
        regla_un_rodeo_por_finde_activa: true,
        regla_asociacion_organizadora_activa: true,
        ...cambios
    });
}

function jurado(id, extra = {}) {
    return { id, nombre_completo: 'Jurado ' + id, categoria: 'A', asociacion: 'RIO RAHUE', comuna: 'ComunaX', ...extra };
}
function rodeo(id, fecha, asociacion, extra = {}) {
    const duracion_dias = extra.duracion_dias || 1;
    return {
        id, club: extra.club || ('Club ' + id), asociacion, fecha, duracion_dias, estado: 'activo',
        clasificacion_codigo: 'provincial',
        comuna_resuelta: { id: COMUNA.id, nombre: COMUNA.nombre, latitud: COMUNA.latitud, longitud: COMUNA.longitud },
        fechas: rangoFechas(fecha, duracion_dias), bloque: calcularBloqueRodeo(fecha, duracion_dias)
    };
}
// Fila con la misma forma que trae cargarDatosMotor() de `asignaciones`.
function asig(juradoId, rodeoId, fecha, asociacion, club) {
    return { usuario_pagado_id: juradoId, rodeo_id: rodeoId, estado: 'activo', estado_designacion: 'aceptado', rodeos: { fecha, duracion_dias: 1, asociacion, club } };
}
// Contexto como lo arma cargarDatosMotor(): temporada recortada + historial completo.
function contexto({ rodeos, jurados, disponibles = {}, historial = [] }) {
    const disponibilidad = new Map();
    for (const [id, fechas] of Object.entries(disponibles)) disponibilidad.set(id, new Set(fechas));
    const enTemporada = historial.filter(a => a.rodeos.fecha >= TEMPORADA.fecha_inicio && a.rodeos.fecha <= TEMPORADA.fecha_fin);
    return {
        idsSolicitados: rodeos.map(r => r.id), temporada: TEMPORADA,
        rodeosPorId: new Map(rodeos.map(r => [r.id, r])), jurados,
        catalogoComunas: { comunas: [COMUNA], alias: [] }, disponibilidad,
        asignacionesTemporada: enTemporada, asignacionesHistoricas: historial,
        ultimaFechaAsociacionPorJurado: construirUltimaFechaAsociacionPorJurado(historial),
        fechasAsociacionPorJurado: construirFechasAsociacionPorJurado(historial)
    };
}

const OBJ = rodeo('R-ALBORADA', '2026-11-28', 'LINARES', { club: 'ALBORADA DE LINARES' });
const HIST_AUGUSTO = [
    asig('AUG', 'R-OSORNO', '2026-04-18', 'OSORNO', 'OSORNO - CANCURA'),
    asig('AUG', 'R-YERBAS', '2026-05-01', 'LINARES', 'YERBAS BUENAS'),
    asig('AUG', 'R-PMONTT', '2026-09-18', 'LLANQUIHUE', 'PUERTO MONTT'),
    asig('AUG', 'R-BLANCO', '2026-10-10', 'AYSÉN', 'EL BLANCO'),
    asig('AUG', 'R-ANCUD', '2026-11-07', 'CHILOE', 'ANCUD'),
    asig('AUG', 'R-LONCO', '2026-11-21', 'LAGO LLANQUIHUE', 'LONCOTORO')
];

describe('Caso real — Augusto (LINARES 01/05 → ALBORADA DE LINARES 28/11, intervalo 2 meses)', () => {
    const ctx = () => contexto({ rodeos: [OBJ], jurados: [jurado('AUG')], disponibles: { AUG: ['2026-11-28'] }, historial: HIST_AUGUSTO });

    test('ya NO aparece ASOCIACION_REPETIDA_INTERVALO: mayo está fuera de los 2 meses', () => {
        const r = evaluarElegibilidadJurado(ctx(), OBJ.id, 'AUG', configV16(), MANUAL);
        expect(r.causas).not.toContain('ASOCIACION_REPETIDA_INTERVALO');
    });

    test('queda CON_ADVERTENCIAS solo por fin de semana consecutivo (Loncotoro 21/11), con el detalle del rodeo', () => {
        const r = evaluarElegibilidadJurado(ctx(), OBJ.id, 'AUG', configV16(), MANUAL);
        expect(r.estado).toBe(ESTADOS_ELEGIBILIDAD.CON_ADVERTENCIAS);
        expect(r.causas_relajables).toEqual(['FINDE_CONSECUTIVO']);
        expect(r.causas_obligatorias).toEqual([]);
        expect(r.detalle_advertencias).toEqual([
            { causa: 'FINDE_CONSECUTIVO', rodeos: [{ club: 'LONCOTORO', asociacion: 'LAGO LLANQUIHUE', fecha: '2026-11-21' }] }
        ]);
    });

    test('también el flujo NO manual (Propuesta/reemplazo) deja de bloquearlo por intervalo', () => {
        const r = evaluarElegibilidadJurado(ctx(), OBJ.id, 'AUG', configV16());
        expect(r.estado).toBe(ESTADOS_ELEGIBILIDAD.CON_ADVERTENCIAS);
        expect(r.causas).toEqual(['FINDE_CONSECUTIVO']);
    });
});

describe('Designación manual — clasificación con excepciones autorizadas', () => {
    test('repetición FUERA del intervalo y sin otra advertencia -> DISPONIBLE_Y_HABILITADO', () => {
        const c = contexto({ rodeos: [OBJ], jurados: [jurado('J1')], disponibles: { J1: ['2026-11-28'] },
            historial: [asig('J1', 'R-PREV', '2026-05-01', 'LINARES', 'YERBAS BUENAS')] });
        const r = evaluarElegibilidadJurado(c, OBJ.id, 'J1', configV16(), MANUAL);
        expect(r.estado).toBe(ESTADOS_ELEGIBILIDAD.DISPONIBLE_Y_HABILITADO);
        expect(r.causas).toEqual([]);
    });

    test('repetición DENTRO del intervalo -> advertencia excepcionable con fecha, club, asociación y meses', () => {
        const c = contexto({ rodeos: [OBJ], jurados: [jurado('J1')], disponibles: { J1: ['2026-11-28'] },
            historial: [asig('J1', 'R-PREV', '2026-10-24', 'LINARES', 'YERBAS BUENAS')] });
        const r = evaluarElegibilidadJurado(c, OBJ.id, 'J1', configV16(), MANUAL);
        expect(r.estado).toBe(ESTADOS_ELEGIBILIDAD.CON_ADVERTENCIAS);
        expect(r.causas_relajables).toEqual(['ASOCIACION_REPETIDA_INTERVALO']);
        expect(r.detalle_advertencias).toEqual([expect.objectContaining({
            causa: 'ASOCIACION_REPETIDA_INTERVALO', meses: 2, asociacion: 'LINARES', origen: 'historial',
            rodeos: [{ club: 'YERBAS BUENAS', asociacion: 'LINARES', fecha: '2026-10-24' }]
        })]);
    });

    test('la MISMA repetición dentro del intervalo sigue siendo NO_HABILITADO fuera del flujo manual', () => {
        const c = contexto({ rodeos: [OBJ], jurados: [jurado('J1')], disponibles: { J1: ['2026-11-28'] },
            historial: [asig('J1', 'R-PREV', '2026-10-24', 'LINARES', 'YERBAS BUENAS')] });
        const r = evaluarElegibilidadJurado(c, OBJ.id, 'J1', configV16());
        expect(r.estado).toBe(ESTADOS_ELEGIBILIDAD.NO_HABILITADO);
        expect(r.causas_obligatorias).toEqual(['ASOCIACION_REPETIDA_INTERVALO']);
    });

    test('varias advertencias simultáneas (intervalo + fin de semana consecutivo) -> UNA clasificación con ambos detalles', () => {
        const c = contexto({ rodeos: [OBJ], jurados: [jurado('J1')], disponibles: { J1: ['2026-11-28'] },
            historial: [asig('J1', 'R-PREV', '2026-11-21', 'LINARES', 'YERBAS BUENAS')] });
        const r = evaluarElegibilidadJurado(c, OBJ.id, 'J1', configV16(), MANUAL);
        expect(r.estado).toBe(ESTADOS_ELEGIBILIDAD.CON_ADVERTENCIAS);
        expect([...r.causas_relajables].sort()).toEqual(['ASOCIACION_REPETIDA_INTERVALO', 'FINDE_CONSECUTIVO']);
        const porCausa = Object.fromEntries(r.detalle_advertencias.map(d => [d.causa, d]));
        expect(porCausa.ASOCIACION_REPETIDA_INTERVALO.rodeos[0].fecha).toBe('2026-11-21');
        expect(porCausa.FINDE_CONSECUTIVO.rodeos).toEqual([{ club: 'YERBAS BUENAS', asociacion: 'LINARES', fecha: '2026-11-21' }]);
    });

    test('una designación POSTERIOR en la misma asociación dentro del plazo también cuenta (y no oculta una anterior)', () => {
        const c = contexto({ rodeos: [OBJ], jurados: [jurado('J1')], disponibles: { J1: ['2026-11-28'] },
            historial: [asig('J1', 'R-FUT', '2027-01-09', 'LINARES', 'FUTURO')] });
        const r = evaluarElegibilidadJurado(c, OBJ.id, 'J1', configV16(), MANUAL);
        expect(r.causas_relajables).toEqual(['ASOCIACION_REPETIDA_INTERVALO']);
        expect(r.detalle_advertencias[0].rodeos[0].fecha).toBe('2027-01-09');
    });

    describe('restricciones estructurales: bloqueo total aunque haya además una repetición dentro del intervalo', () => {
        const histDentro = [asig('J1', 'R-PREV', '2026-10-24', 'LINARES', 'YERBAS BUENAS')];
        test('sin disponibilidad declarada', () => {
            const c = contexto({ rodeos: [OBJ], jurados: [jurado('J1')], disponibles: {}, historial: histDentro });
            const r = evaluarElegibilidadJurado(c, OBJ.id, 'J1', configV16(), MANUAL);
            expect(r.estado).toBe(ESTADOS_ELEGIBILIDAD.NO_HABILITADO);
            expect(r.causas_obligatorias).toContain('DISPONIBILIDAD');
            expect(r.detalle_advertencias).toEqual([]);
        });
        test('jurado de la propia asociación organizadora (regla activa)', () => {
            const c = contexto({ rodeos: [OBJ], jurados: [jurado('J1', { asociacion: 'LINARES' })], disponibles: { J1: ['2026-11-28'] }, historial: histDentro });
            const r = evaluarElegibilidadJurado(c, OBJ.id, 'J1', configV16(), MANUAL);
            expect(r.estado).toBe(ESTADOS_ELEGIBILIDAD.NO_HABILITADO);
            expect(r.causas_obligatorias).toEqual(['MISMA_ASOCIACION']);
        });
        test('otro rodeo el mismo fin de semana (superposición)', () => {
            const c = contexto({ rodeos: [OBJ], jurados: [jurado('J1')], disponibles: { J1: ['2026-11-28'] },
                historial: [...histDentro, asig('J1', 'R-MISMO', '2026-11-29', 'OTRA', 'MISMO FINDE')] });
            const r = evaluarElegibilidadJurado(c, OBJ.id, 'J1', configV16(), MANUAL);
            expect(r.estado).toBe(ESTADOS_ELEGIBILIDAD.NO_HABILITADO);
            expect(r.causas_obligatorias).toContain('MISMO_FINDE');
        });
        test('categoría no habilitada para la clasificación del rodeo', () => {
            const c = contexto({ rodeos: [OBJ], jurados: [jurado('J1', { categoria: 'ZZ' })], disponibles: { J1: ['2026-11-28'] }, historial: histDentro });
            const r = evaluarElegibilidadJurado(c, OBJ.id, 'J1', configV16(), MANUAL);
            expect(r.estado).toBe(ESTADOS_ELEGIBILIDAD.NO_HABILITADO);
            expect(r.causas_obligatorias).toContain('CATEGORIA_INCOMPATIBLE');
        });
    });

    test('conjuntos: el intervalo sigue OBLIGATORIO para el motor; solo el flujo manual lo excepciona', () => {
        expect(CAUSAS_OBLIGATORIAS.has('ASOCIACION_REPETIDA_INTERVALO')).toBe(true);
        expect(CAUSAS_RELAJABLES.has('ASOCIACION_REPETIDA_INTERVALO')).toBe(false);
        expect(clasificarCausas(['ASOCIACION_REPETIDA_INTERVALO'])).toBe(ESTADOS_ELEGIBILIDAD.NO_HABILITADO);
        expect(CAUSAS_EXCEPCIONABLES_MANUAL.has('ASOCIACION_REPETIDA_INTERVALO')).toBe(true);
        for (const c of ['DISPONIBILIDAD', 'CATEGORIA_INCOMPATIBLE', 'MISMA_ASOCIACION', 'MISMO_FINDE']) {
            expect(CAUSAS_EXCEPCIONABLES_MANUAL.has(c)).toBe(false);
        }
    });
});

describe('Motor automático — sigue respetando el intervalo (por fechas reales)', () => {
    test('historial dentro del intervalo -> SIN_PROPUESTA por ASOCIACION_REPETIDA_INTERVALO (local y global)', () => {
        const c = contexto({ rodeos: [OBJ], jurados: [jurado('J1')], disponibles: { J1: ['2026-11-28'] },
            historial: [asig('J1', 'R-PREV', '2026-10-24', 'LINARES', 'YERBAS BUENAS')] });
        const local = ejecutarSimulacion(c, 5, configV16());
        expect(local.resultados[0].estado).toBe('SIN_PROPUESTA');
        expect(local.resultados[0].descartes.ASOCIACION_REPETIDA_INTERVALO).toBe(1);
        const global = ejecutarSimulacionGlobal(c, 5, configV16());
        expect(global.cobertura_completa).toBe(false);
        expect(global.resultados[0].estado).toBe('SIN_PROPUESTA');
    });

    test('historial fuera del intervalo (caso Augusto sin fin de semana contiguo) -> PROPUESTO', () => {
        const c = contexto({ rodeos: [OBJ], jurados: [jurado('J1')], disponibles: { J1: ['2026-11-28'] },
            historial: [asig('J1', 'R-PREV', '2026-05-01', 'LINARES', 'YERBAS BUENAS')] });
        expect(ejecutarSimulacion(c, 5, configV16()).resultados[0].estado).toBe('PROPUESTO');
        expect(ejecutarSimulacionGlobal(c, 5, configV16()).cobertura_completa).toBe(true);
    });

    test('dentro de un MISMO lote: dos rodeos de la misma asociación a 6 semanas (intervalo 2 meses) nunca van al mismo jurado', () => {
        const r2 = rodeo('R-ENERO', '2027-01-09', 'LINARES');
        const c = contexto({ rodeos: [OBJ, r2], jurados: [jurado('J1')], disponibles: { J1: ['2026-11-28', '2027-01-09'] } });
        const local = ejecutarSimulacion(c, 5, configV16());
        const estados = local.resultados.map(x => x.estado).sort();
        expect(estados).toEqual(['PROPUESTO', 'SIN_PROPUESTA']);
        const sinPropuesta = local.resultados.find(x => x.estado === 'SIN_PROPUESTA');
        expect(sinPropuesta.descartes.ASOCIACION_REPETIDA_INTERVALO).toBe(1);
        const global = ejecutarSimulacionGlobal(c, 5, configV16());
        expect(global.cobertura_completa).toBe(false);
    });

    test('dentro de un MISMO lote: misma asociación a 7 meses (intervalo 2) -> ambos al mismo jurado (se comparan fechas, no "misma temporada")', () => {
        const rMayo = rodeo('R-MAYO', '2026-05-02', 'LINARES');
        const c = contexto({ rodeos: [rMayo, OBJ], jurados: [jurado('J1')], disponibles: { J1: ['2026-05-02', '2026-11-28'] } });
        const local = ejecutarSimulacion(c, 5, configV16());
        expect(local.resultados.map(x => x.estado)).toEqual(['PROPUESTO', 'PROPUESTO']);
        expect(ejecutarSimulacionGlobal(c, 5, configV16()).cobertura_completa).toBe(true);
    });

    test('regla de intervalo desactivada -> nunca produce la causa', () => {
        const c = contexto({ rodeos: [OBJ], jurados: [jurado('J1')], disponibles: { J1: ['2026-11-28'] },
            historial: [asig('J1', 'R-PREV', '2026-10-24', 'LINARES', 'YERBAS BUENAS')] });
        const r = evaluarElegibilidadJurado(c, OBJ.id, 'J1', configV16({ regla_repeticion_asociacion_intervalo_activa: false }), MANUAL);
        expect(r.causas).not.toContain('ASOCIACION_REPETIDA_INTERVALO');
    });
});

describe('Aviso informativo de repetición de asociación (repeticion_asociacion)', () => {
    const evaluar = (historial, cambios) => evaluarElegibilidadJurado(
        contexto({ rodeos: [OBJ], jurados: [jurado('J1')], disponibles: { J1: ['2026-11-28'] }, historial }), OBJ.id, 'J1', configV16(cambios), MANUAL);

    test('Augusto: Yerbas Buenas 01/05/2026 es antecedente con intervalo CUMPLIDO para el 28/11/2026', () => {
        const r = evaluarElegibilidadJurado(contexto({ rodeos: [OBJ], jurados: [jurado('AUG')], disponibles: { AUG: ['2026-11-28'] }, historial: HIST_AUGUSTO }),
            OBJ.id, 'AUG', configV16(), MANUAL);
        expect(r.repeticion_asociacion).toEqual({
            asociacion: 'LINARES', intervalo_activo: true, meses: 2, desde: '2026-09-28', hasta: '2027-01-28', intervalo_cumplido: true,
            antecedentes: [{ fecha: '2026-05-01', club: 'YERBAS BUENAS', asociacion: 'LINARES', posterior: false, dentro_intervalo: false }]
        });
        expect(r.causas).not.toContain('ASOCIACION_REPETIDA_INTERVALO');
    });

    test('antecedente dentro del intervalo -> INCUMPLIDO, y coincide con la causa del motor', () => {
        const r = evaluar([asig('J1', 'R-A', '2026-05-01', 'LINARES', 'VIEJO'), asig('J1', 'R-B', '2026-10-24', 'LINARES', 'RECIENTE')]);
        expect(r.repeticion_asociacion.intervalo_cumplido).toBe(false);
        expect(r.repeticion_asociacion.antecedentes.map(a => [a.fecha, a.dentro_intervalo])).toEqual([['2026-10-24', true], ['2026-05-01', false]]);
        expect(r.causas_relajables).toContain('ASOCIACION_REPETIDA_INTERVALO');
    });

    test('antecedente POSTERIOR dentro de ±N meses -> incumplido y marcado como posterior', () => {
        const r = evaluar([asig('J1', 'R-F', '2027-01-09', 'LINARES', 'FUTURO')]);
        expect(r.repeticion_asociacion.antecedentes).toEqual([{ fecha: '2027-01-09', club: 'FUTURO', asociacion: 'LINARES', posterior: true, dentro_intervalo: true }]);
        expect(r.repeticion_asociacion.intervalo_cumplido).toBe(false);
    });

    test('antecedente posterior FUERA del intervalo -> informativo, cumplido', () => {
        const r = evaluar([asig('J1', 'R-F', '2027-03-20', 'LINARES', 'LEJANO')]);
        expect(r.repeticion_asociacion.intervalo_cumplido).toBe(true);
        expect(r.causas).not.toContain('ASOCIACION_REPETIDA_INTERVALO');
    });

    test('historial NO efectivo (anulado o rechazado) nunca genera aviso ni conflicto', () => {
        const anulada = { ...asig('J1', 'R-X', '2026-11-14', 'LINARES', 'ANULADA'), estado: 'anulado' };
        const rechazada = { ...asig('J1', 'R-Y', '2026-10-31', 'LINARES', 'RECHAZADA'), estado_designacion: 'rechazado' };
        const r = evaluar([anulada, rechazada]);
        expect(r.repeticion_asociacion).toBeNull();
        expect(r.causas).not.toContain('ASOCIACION_REPETIDA_INTERVALO');
    });

    test('otra asociación nunca cuenta; el propio rodeo consultado tampoco', () => {
        const r = evaluar([asig('J1', 'R-O', '2026-11-14', 'TALCA', 'OTRA'), asig('J1', OBJ.id, '2026-11-28', 'LINARES', 'MISMO RODEO')]);
        expect(r.repeticion_asociacion).toBeNull();
    });

    test('regla de intervalo desactivada -> antecedentes informativos, sin juicio de cumplimiento', () => {
        const r = evaluar([asig('J1', 'R-B', '2026-10-24', 'LINARES', 'RECIENTE')], { regla_repeticion_asociacion_intervalo_activa: false });
        expect(r.repeticion_asociacion).toEqual(expect.objectContaining({ intervalo_activo: false, intervalo_cumplido: null, meses: null }));
        expect(r.repeticion_asociacion.antecedentes[0].dentro_intervalo).toBeNull();
    });

    test('coherencia total: intervalo_cumplido === no existe ASOCIACION_REPETIDA_INTERVALO en las causas del motor', () => {
        for (const f of ['2026-05-01', '2026-09-27', '2026-09-28', '2026-11-21', '2027-01-28', '2027-01-29', '2027-06-01']) {
            const r = evaluar([asig('J1', 'R-' + f, f, 'LINARES', 'C-' + f)]);
            expect([f, r.repeticion_asociacion.intervalo_cumplido]).toEqual([f, !r.causas.includes('ASOCIACION_REPETIDA_INTERVALO')]);
        }
    });
});

describe('Motor global — retroceso (backtracking) con varios jurados y rodeos', () => {
    // Prepara rodeos con la matriz que usa la búsqueda global (mismo resolver real).
    function conMatriz(rodeos, config) {
        const porClasif = construirMatrizPorClasificacionDesdeConfiguracion(config.matriz);
        const zona = construirMatrizZonaExtremaDesdeConfiguracion(config);
        return rodeos.map(r => ({ ...r, _matrizGlobal: resolverMatrizParaRodeo(r, porClasif, zona, config.zonas_extremas?.asociaciones).matriz }));
    }

    // A (LINARES 28/11) y B (LINARES 09/01) están a 6 semanas: con intervalo
    // de 2 meses NO pueden ir al mismo jurado. C (TALCA domingo 10/01) solo lo
    // puede cubrir j2 (único disponible ese día), y comparte fin de semana con B. La búsqueda procesa C
    // (1 candidato) -> j2; luego A con j1 primero (menos designaciones) -> en
    // B, j1 choca por intervalo con A (lote) y j2 por mismo fin de semana con
    // C -> callejón sin salida -> DESHACE j1->A (retira esa fecha del lote) y
    // prueba j2->A -> B queda para j1. Si la fecha de A no se retirara al
    // deshacer, j1 seguiría "bloqueado" en B y no habría cobertura completa.
    const A = rodeo('R-A', '2026-11-28', 'LINARES');
    const B = rodeo('R-B', '2027-01-09', 'LINARES');
    const C = rodeo('R-C', '2027-01-10', 'TALCA');
    const ctxRetroceso = () => contexto({
        rodeos: [A, B, C], jurados: [jurado('j1'), jurado('j2')],
        disponibles: { j1: ['2026-11-28', '2027-01-09'], j2: ['2026-11-28', '2027-01-09', '2027-01-10'] }
    });

    test('resolverAsignacionGlobal: cobertura total SOLO si al deshacer se retira la fecha de la propuesta deshecha', () => {
        const config = configV16();
        const res = resolverAsignacionGlobal(ctxRetroceso(), config, conMatriz([A, B, C], config));
        expect(res.exito).toBe(true);
        expect(Object.fromEntries(res.asignacion)).toEqual({ 'R-A': 'j2', 'R-B': 'j1', 'R-C': 'j2' });
        // Hubo retroceso real: más nodos que rodeos (raíz + 3 niveles = 4 sin retroceder).
        expect(res.nodosExplorados).toBeGreaterThan(4);
    });

    test('ejecutarSimulacionGlobal: misma solución, nunca dos rodeos de LINARES dentro de 2 meses para el mismo jurado', () => {
        const res = ejecutarSimulacionGlobal(ctxRetroceso(), 5, configV16());
        expect(res.cobertura_completa).toBe(true);
        const porId = new Map(res.resultados.map(r => [r.rodeo_id, r.jurado_propuesto?.jurado_id]));
        expect(porId.get('R-A')).not.toBe(porId.get('R-B'));
        expect(porId.get('R-C')).toBe('j2');
    });

    test('retirar del lote elimina SOLO la fecha de esa propuesta (las demás del mismo jurado/asociación permanecen)', () => {
        const lote = new Map();
        const r1 = rodeo('L1', '2026-05-02', 'LINARES'), r2 = rodeo('L2', '2026-08-01', 'LINARES'), r3 = rodeo('L3', '2026-12-12', 'LINARES');
        for (const r of [r1, r2, r3]) registrarFechaAsociacionLote(lote, 'j1', r);
        retirarFechaAsociacionLote(lote, 'j1', r2);
        expect(lote.get('j1').get('linares').map(e => e.rodeo_id)).toEqual(['L1', 'L3']);
        retirarFechaAsociacionLote(lote, 'j1', r2); // retirar dos veces no borra otra
        expect(lote.get('j1').get('linares').map(e => e.rodeo_id)).toEqual(['L1', 'L3']);
        retirarFechaAsociacionLote(lote, 'j9', r1); // otro jurado: sin efecto
        expect(lote.get('j1').get('linares')).toHaveLength(2);
    });

    test.each([
        ['anterior dentro', '2026-10-24', false],
        ['anterior en el límite (28/09)', '2026-09-28', false],
        ['anterior fuera (27/09)', '2026-09-27', true],
        ['posterior dentro', '2027-01-09', false],
        ['posterior en el límite (28/01)', '2027-01-28', false],
        ['posterior fuera (29/01)', '2027-01-29', true]
    ])('historial %s -> global %s', (_n, fecha, cubre) => {
        const c = contexto({ rodeos: [OBJ], jurados: [jurado('J1')], disponibles: { J1: ['2026-11-28'] }, historial: [asig('J1', 'R-H', fecha, 'LINARES', 'H')] });
        const res = ejecutarSimulacionGlobal(c, 5, configV16());
        expect(res.cobertura_completa).toBe(cubre);
        if (!cubre) expect(res.resultados[0].descartes.ASOCIACION_REPETIDA_INTERVALO).toBe(1);
    });

    test.each([
        ['dentro (28/01, límite)', '2027-01-28', false],
        ['fuera (29/01)', '2027-01-29', true]
    ])('dos rodeos del MISMO lote, misma asociación, un solo jurado: segundo %s -> cobertura %s', (_n, fecha2, cubre) => {
        const r2 = rodeo('R-2', fecha2, 'LINARES');
        const c = contexto({ rodeos: [OBJ, r2], jurados: [jurado('J1')], disponibles: { J1: ['2026-11-28', fecha2] } });
        expect(ejecutarSimulacionGlobal(c, 5, configV16()).cobertura_completa).toBe(cubre);
    });

    test('el intervalo sigue siendo OBLIGATORIO en el global: ni el nivel permisivo lo cede', () => {
        const c = contexto({ rodeos: [OBJ], jurados: [jurado('J1')], disponibles: { J1: ['2026-11-28'] }, historial: [asig('J1', 'R-H', '2026-11-14', 'LINARES', 'H')] });
        const res = ejecutarSimulacionGlobal(c, 5, configV16());
        expect(res.resultados[0].estado).toBe('SIN_PROPUESTA');
        expect(CAUSAS_RELAJABLES.has('ASOCIACION_REPETIDA_INTERVALO')).toBe(false);
    });
});

describe('buscarConflictoIntervalo / lote — funciones puras', () => {
    test('el propio rodeo nunca genera conflicto consigo mismo; registrar/retirar del lote es simétrico', () => {
        const lote = new Map();
        const estado = { fechasAsociacionPorJurado: new Map(), fechasAsociacionLotePorJurado: lote };
        registrarFechaAsociacionLote(lote, 'J1', OBJ);
        expect(buscarConflictoIntervalo('J1', OBJ, 'linares', 2, estado)).toBeNull();
        const otro = rodeo('R-DIC', '2026-12-12', 'LINARES');
        expect(buscarConflictoIntervalo('J1', otro, 'linares', 2, estado)).toEqual(expect.objectContaining({ fecha: '2026-11-28', origen: 'lote' }));
        retirarFechaAsociacionLote(lote, 'J1', OBJ);
        expect(buscarConflictoIntervalo('J1', otro, 'linares', 2, estado)).toBeNull();
    });

    test('límite inclusivo: exactamente N meses antes cuenta como dentro; un día antes de ese límite, fuera', () => {
        const mk = f => ({ fechasAsociacionPorJurado: new Map([['J1', new Map([['linares', [{ fecha: f, rodeo_id: 'X' }]]])]]) });
        expect(buscarConflictoIntervalo('J1', OBJ, 'linares', 2, mk('2026-09-28'))).not.toBeNull();
        expect(buscarConflictoIntervalo('J1', OBJ, 'linares', 2, mk('2026-09-27'))).toBeNull();
    });
});
