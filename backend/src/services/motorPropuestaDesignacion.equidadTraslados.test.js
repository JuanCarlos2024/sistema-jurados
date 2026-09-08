// ═════════════════════════════════════════════════════════════════════════
// Tests de la mejora "Equidad de Traslados + Métricas de Rendimiento".
// Archivo SEPARADO de motorPropuestaDesignacion.test.js (que se mantiene
// intacto, sin jest.mock de Supabase) porque cargarRendimientoTemporada()
// SÍ toca la BD — necesita un mock de Supabase que el archivo original no
// tiene ni necesita para sus tests puros existentes.
//
// Cubre (ver informe de diseño / pedido de la mejora):
//   - clasificarTraslado ya se testea en configuracionDesignacion.test.js
//     (no se duplica acá).
//   - compararEquidadTraslados / calcularCargaTraslados /
//     construirTrasladosPorJuradoBD / construirExplicacionEquidadTraslados —
//     unidades PURAS, sin BD.
//   - ejecutarSimulacion() con EQUIDAD_TRASLADOS activo — integración pura
//     (CERCA/LEJOS, alternancia, historial de temporada, multi-rodeo/estado
//     temporal, compatibilidad con configuración histórica V1).
//   - construirRendimientoPorJurado — unidad PURA (última nota, promedios,
//     alteración, casos límite).
//   - cargarRendimientoTemporada — con Supabase mockeado, para confirmar
//     cantidad fija de queries (anti N+1).
// ═════════════════════════════════════════════════════════════════════════
jest.mock('../config/supabase', () => ({ from: jest.fn() }));
const supabase = require('../config/supabase');
const {
    ejecutarSimulacion, compararEquidadTraslados, calcularCargaTraslados,
    construirTrasladosPorJuradoBD, construirExplicacionEquidadTraslados,
    construirRendimientoPorJurado, cargarRendimientoTemporada
} = require('./motorPropuestaDesignacion');
const { construirConfiguracionDefaultV1, clonarConfiguracion } = require('./configuracionDesignacion');
const { calcularBloqueRodeo, rangoFechas } = require('./feriados');

// ─── Fixtures — mismo patrón que motorPropuestaDesignacion.test.js ────────
const TEMPORADA = { nombre: '2026-2027', fecha_inicio: '2026-04-15', fecha_fin: '2027-04-15' };
const RADIO_TIERRA_KM = 6371;
function latADistancia(latBase, distanciaKm) {
    const deltaRad = distanciaKm / RADIO_TIERRA_KM;
    return latBase - deltaRad * (180 / Math.PI);
}
let _comunaSeq = 0;
function comuna(lat, lng, nombre) {
    _comunaSeq++;
    const n = nombre || `Comuna${_comunaSeq}`;
    return { id: `comuna-${_comunaSeq}`, nombre: n, nombre_normalizado: n.toLowerCase(), region: 'Test', latitud: lat, longitud: lng };
}
function jurado(id, { categoria = 'A', asociacion = 'Asociación Base', comunaTexto = null, nombre = null } = {}) {
    return { id, nombre_completo: nombre || `Jurado ${id}`, categoria, asociacion, comuna: comunaTexto };
}
function rodeoInterno(id, { clasificacion_codigo = 'provincial', asociacion = 'Otra Asociación', fecha, duracion_dias = 1, comunaObj = null, estado = 'activo' }) {
    return {
        id, club: `Club ${id}`, asociacion, fecha, duracion_dias, estado,
        clasificacion_codigo,
        comuna_resuelta: comunaObj ? { id: comunaObj.id, nombre: comunaObj.nombre, latitud: comunaObj.latitud, longitud: comunaObj.longitud } : null,
        fechas: rangoFechas(fecha, duracion_dias),
        bloque: calcularBloqueRodeo(fecha, duracion_dias)
    };
}
function contexto({ rodeos, jurados, disponibilidadPorJurado = {}, asignacionesTemporada = [], comunas = [], alias = [], temporada = TEMPORADA }) {
    const rodeosPorId = new Map(rodeos.map(r => [r.id, r]));
    const disponibilidad = new Map();
    for (const [juradoId, fechas] of Object.entries(disponibilidadPorJurado)) disponibilidad.set(juradoId, new Set(fechas));
    return {
        idsSolicitados: rodeos.map(r => r.id), temporada, rodeosPorId, jurados,
        catalogoComunas: { comunas, alias }, disponibilidad, asignacionesTemporada
    };
}
function configEquidad(umbral, codigosEnOrden, cambios = {}) {
    const ordenCriterios = codigosEnOrden.map((codigo, i) => ({ criterio_codigo: codigo, orden: i + 1 }));
    return clonarConfiguracion(construirConfiguracionDefaultV1(), {
        schema_version: 2, regla_equidad_traslados_activa: true, umbral_lejania_km: umbral,
        ordenCriterios, ...cambios
    });
}
// Fila de asignación histórica con forma REAL de la query extendida de
// cargarDatosMotor (rodeos.comunas_chile) — usada para construir traslados de temporada.
function asigHistorica(juradoId, rodeoId, fecha, comunaRodeo, { asociacion = 'Historica', id } = {}) {
    return {
        id: id || `${juradoId}-${rodeoId}`, usuario_pagado_id: juradoId, rodeo_id: rodeoId,
        estado: 'activo', estado_designacion: 'aceptado',
        rodeos: { fecha, duracion_dias: 1, asociacion, comunas_chile: comunaRodeo ? { latitud: comunaRodeo.latitud, longitud: comunaRodeo.longitud } : null }
    };
}

const COMUNA_CERCA = comuna(-33.45, -70.6667, 'ComunaCerca');       // 0 km del jurado base
const COMUNA_JURADO = comuna(-33.45, -70.6667, 'ComunaJuradoBase');
const COMUNA_LEJOS = comuna(latADistancia(-33.45, 850), -70.6667, 'ComunaLejos'); // 850 km

// ═════════════════════════════════════════════════════════════════════════
// UNIDADES PURAS
// ═════════════════════════════════════════════════════════════════════════

describe('compararEquidadTraslados — Nivel 0: cercanía a ESTE rodeo siempre primero', () => {
    test('candidato CERCA (220km) le gana a candidato LEJOS (850km) sin importar historial', () => {
        const a = { distanciaKm: 220, trasladosTemporada: { salidas_cerca: 0, salidas_lejos: 5, ultima_salida_tipo: 'LEJOS' } };
        const b = { distanciaKm: 850, trasladosTemporada: { salidas_cerca: 5, salidas_lejos: 0, ultima_salida_tipo: 'CERCA' } };
        expect(compararEquidadTraslados(a, b, 350)).toBeLessThan(0); // a gana
    });
});

describe('compararEquidadTraslados — Nivel 1: ambos LEJOS del rodeo actual (empatados en cercanía)', () => {
    test('preferir quien NO tuvo última salida LEJOS', () => {
        const a = { distanciaKm: 800, trasladosTemporada: { salidas_cerca: 2, salidas_lejos: 1, ultima_salida_tipo: 'LEJOS' } };
        const b = { distanciaKm: 820, trasladosTemporada: { salidas_cerca: 2, salidas_lejos: 1, ultima_salida_tipo: 'CERCA' } };
        expect(compararEquidadTraslados(a, b, 350)).toBeGreaterThan(0); // b gana (a pierde)
    });
    test('empatados en última salida -> preferir menos salidas_lejos', () => {
        const a = { distanciaKm: 800, trasladosTemporada: { salidas_cerca: 2, salidas_lejos: 4, ultima_salida_tipo: 'CERCA' } };
        const b = { distanciaKm: 820, trasladosTemporada: { salidas_cerca: 5, salidas_lejos: 1, ultima_salida_tipo: 'CERCA' } };
        expect(compararEquidadTraslados(a, b, 350)).toBeGreaterThan(0); // b gana (menos lejos)
    });
    test('empatados en última salida y conteo -> proporción de carga lejos decide', () => {
        const a = { distanciaKm: 800, trasladosTemporada: { salidas_cerca: 0, salidas_lejos: 2, ultima_salida_tipo: 'CERCA' } }; // 100% lejos
        const b = { distanciaKm: 820, trasladosTemporada: { salidas_cerca: 8, salidas_lejos: 2, ultima_salida_tipo: 'CERCA' } }; // 20% lejos
        expect(compararEquidadTraslados(a, b, 350)).toBeGreaterThan(0); // b gana (menor proporción)
    });
});

describe('compararEquidadTraslados — Nivel 1: ambos CERCA del rodeo actual (compensación)', () => {
    test('preferir quien SÍ tuvo última salida LEJOS (compensación)', () => {
        const a = { distanciaKm: 100, trasladosTemporada: { salidas_cerca: 3, salidas_lejos: 1, ultima_salida_tipo: 'LEJOS' } };
        const b = { distanciaKm: 120, trasladosTemporada: { salidas_cerca: 3, salidas_lejos: 1, ultima_salida_tipo: 'CERCA' } };
        expect(compararEquidadTraslados(a, b, 350)).toBeLessThan(0); // a gana
    });
    test('empatados en última salida -> preferir MAYOR carga de lejos (compensación)', () => {
        const a = { distanciaKm: 100, trasladosTemporada: { salidas_cerca: 1, salidas_lejos: 4, ultima_salida_tipo: 'CERCA' } };
        const b = { distanciaKm: 120, trasladosTemporada: { salidas_cerca: 5, salidas_lejos: 1, ultima_salida_tipo: 'CERCA' } };
        expect(compararEquidadTraslados(a, b, 350)).toBeLessThan(0); // a gana (más lejos = más carga a compensar)
    });
});

describe('calcularCargaTraslados', () => {
    test('sección 19: solo cuenta asignaciones con fecha ANTERIOR al rodeo objetivo', () => {
        const bd = [
            { fecha: '2026-09-01', distanciaKm: 100 },  // antes -> cuenta
            { fecha: '2026-09-27', distanciaKm: 900 }   // después del objetivo (20-sep) -> NO cuenta
        ];
        const carga = calcularCargaTraslados(bd, [], '2026-09-20', 350);
        expect(carga.salidas_cerca).toBe(1);
        expect(carga.salidas_lejos).toBe(0);
        expect(carga.ultima_salida_tipo).toBe('CERCA');
    });
    test('entradas temporales (misma corrida) cuentan SIEMPRE, sin comparar fecha', () => {
        const bd = [{ fecha: '2026-01-01', distanciaKm: 50 }];
        const temporales = [{ distanciaKm: 800 }]; // recién "propuesto" en este batch
        const carga = calcularCargaTraslados(bd, temporales, '2027-01-01', 350);
        expect(carga.salidas_cerca).toBe(1);
        expect(carga.salidas_lejos).toBe(1);
        // La temporal se procesa al final -> es la "última salida"
        expect(carga.ultima_salida_tipo).toBe('LEJOS');
        expect(carga.ultima_salida_distancia_km).toBe(800);
    });
    test('sin historial ni temporales -> ceros y última salida null', () => {
        const carga = calcularCargaTraslados([], [], '2026-09-20', 350);
        expect(carga).toEqual({ salidas_cerca: 0, salidas_lejos: 0, ultima_salida_tipo: null, ultima_salida_distancia_km: null });
    });
    test('fechaRodeoObjetivo null/undefined -> cuenta TODO el historial (uso directo, sin rodeo futuro que filtrar)', () => {
        const bd = [{ fecha: '2026-01-01', distanciaKm: 50 }, { fecha: '2030-01-01', distanciaKm: 900 }];
        const carga = calcularCargaTraslados(bd, [], null, 350);
        expect(carga.salidas_cerca).toBe(1);
        expect(carga.salidas_lejos).toBe(1);
    });
});

describe('construirTrasladosPorJuradoBD', () => {
    test('reconstruye distancia vía Haversine (misma función que el motor usa en vivo) y ordena por fecha', () => {
        const comunaJuradoPorId = new Map([['j1', { resuelto: true, latitud: COMUNA_JURADO.latitud, longitud: COMUNA_JURADO.longitud }]]);
        const asignaciones = [
            asigHistorica('j1', 'r2', '2026-09-10', COMUNA_LEJOS),
            asigHistorica('j1', 'r1', '2026-08-01', COMUNA_CERCA)
        ];
        const mapa = construirTrasladosPorJuradoBD(asignaciones, comunaJuradoPorId);
        const lista = mapa.get('j1');
        expect(lista).toHaveLength(2);
        expect(lista[0].fecha).toBe('2026-08-01'); // ordenado ASC
        expect(lista[0].distanciaKm).toBeCloseTo(0, 0);
        expect(lista[1].distanciaKm).toBeCloseTo(850, 0);
    });
    test('jurado sin comuna resoluble -> distanciaKm null (no crashea)', () => {
        const comunaJuradoPorId = new Map([['j1', { resuelto: false }]]);
        const mapa = construirTrasladosPorJuradoBD([asigHistorica('j1', 'r1', '2026-08-01', COMUNA_CERCA)], comunaJuradoPorId);
        expect(mapa.get('j1')[0].distanciaKm).toBeNull();
    });
});

describe('construirExplicacionEquidadTraslados — narrativa "¿Por qué ganó?" (sección 19, revisión de cierre)', () => {
    test('decisivo + LEJOS, última cercana -> describe el estado sin calificarlo de empate', () => {
        const txt = construirExplicacionEquidadTraslados(true, 'LEJOS', { salidas_cerca: 2, salidas_lejos: 0, ultima_salida_tipo: 'CERCA' });
        expect(txt).toMatch(/cercana/);
        expect(txt).toMatch(/0 viaje/);
        expect(txt).not.toMatch(/empate/i);
    });
    test('decisivo + CERCA, última lejana -> menciona compensación', () => {
        const txt = construirExplicacionEquidadTraslados(true, 'CERCA', { salidas_cerca: 1, salidas_lejos: 1, ultima_salida_tipo: 'LEJOS' });
        expect(txt).toMatch(/priorizado/);
        expect(txt).not.toMatch(/empate/i);
    });
    test('sin clasificación (null) -> null, nunca inventa texto', () => {
        expect(construirExplicacionEquidadTraslados(true, null, { salidas_cerca: 0, salidas_lejos: 0, ultima_salida_tipo: null })).toBeNull();
    });
    // Sección 19 — bloqueante: NO decisivo (empate en equidad, otro criterio
    // decidió) -> NUNCA se dice "ganó por equidad", se marca explícitamente
    // como empate/contexto.
    test('NO decisivo -> se marca explícitamente como empate, nunca como razón de la victoria', () => {
        const txt = construirExplicacionEquidadTraslados(false, 'LEJOS', { salidas_cerca: 2, salidas_lejos: 0, ultima_salida_tipo: 'CERCA' });
        expect(txt).toMatch(/empate/i);
        expect(txt).toMatch(/otro criterio/i);
        // El dato factual sigue presente como contexto, solo cambia el marco.
        expect(txt).toMatch(/cercana/);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// TESTS DE MOTOR — CERCA/LEJOS (sección 47 del pedido)
// ═════════════════════════════════════════════════════════════════════════
describe('Motor — Equidad de Traslados: CERCA/LEJOS (sección 47)', () => {
    // El límite EXACTO (350 km inclusive = CERCA, 350.1 = LEJOS) ya se prueba
    // de forma precisa como función pura en configuracionDesignacion.test.js
    // (clasificarTraslado) — acá se prueba la integración con una distancia
    // cómodamente dentro del umbral, evitando el ruido de punto flotante de
    // reconstruir una distancia geográfica EXACTA vía Haversine.
    test('A: 300 km (dentro del umbral 350) = CERCA -> elegible, sin DISTANCIA_EXCEDIDA aunque distancia_maxima esté activa a 600', () => {
        const comunaJ = comuna(latADistancia(-33.45, 300), -70.6667, 'A300');
        const j = jurado('j1', { comunaTexto: 'A300' });
        const r = rodeoInterno('r1', { fecha: '2026-09-05', comunaObj: COMUNA_CERCA });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [j], disponibilidadPorJurado: { j1: rangoFechas('2026-09-05', 1) },
            comunas: [COMUNA_CERCA, comunaJ]
        }), undefined, configEquidad(350, ['EQUIDAD_TRASLADOS']));
        expect(res.resultados[0].estado).toBe('PROPUESTO');
        expect(res.resultados[0].jurado_propuesto.distancia_clasificacion).toBe('CERCA');
    });
    test('B: 850 km sigue siendo candidato si la regla dura está OFF (política futura, sección 9 del pedido)', () => {
        const j = jurado('j1', { comunaTexto: 'ComunaJuradoBase' });
        const r = rodeoInterno('r1', { fecha: '2026-09-05', comunaObj: COMUNA_LEJOS });
        const config = configEquidad(350, ['EQUIDAD_TRASLADOS'], { regla_distancia_maxima_activa: false, distancia_maxima_km: null });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [j], disponibilidadPorJurado: { j1: rangoFechas('2026-09-05', 1) },
            comunas: [COMUNA_LEJOS, COMUNA_JURADO]
        }), undefined, config);
        expect(res.resultados[0].estado).toBe('PROPUESTO');
        expect(res.resultados[0].jurado_propuesto.distancia_clasificacion).toBe('LEJOS');
    });
    test('C/D: 1200 km sigue siendo candidato con regla dura OFF, cumpliendo las demás reglas', () => {
        const comunaMuyLejos = comuna(latADistancia(-33.45, 1200), -70.6667, 'C1200');
        const j = jurado('j1', { comunaTexto: 'C1200' });
        const r = rodeoInterno('r1', { fecha: '2026-09-05', comunaObj: COMUNA_CERCA });
        const config = configEquidad(350, ['EQUIDAD_TRASLADOS'], { regla_distancia_maxima_activa: false, distancia_maxima_km: null });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [j], disponibilidadPorJurado: { j1: rangoFechas('2026-09-05', 1) },
            comunas: [COMUNA_CERCA, comunaMuyLejos]
        }), undefined, config);
        expect(res.resultados[0].estado).toBe('PROPUESTO');
        expect(res.resultados[0].jurado_propuesto.distancia_clasificacion).toBe('LEJOS');
    });
    test('E: candidato cerca supera a candidato lejos dentro de EQUIDAD_TRASLADOS como único criterio', () => {
        const jCerca = jurado('jCerca', { comunaTexto: 'ComunaJuradoBase' });
        const jLejos = jurado('jLejos', { comunaTexto: 'ComunaLejosJ' });
        const comunaLejosJurado = comuna(latADistancia(-33.45, 850), -70.6667, 'ComunaLejosJ');
        const r = rodeoInterno('r1', { fecha: '2026-09-05', comunaObj: COMUNA_JURADO });
        const config = configEquidad(350, ['EQUIDAD_TRASLADOS'], { regla_distancia_maxima_activa: false, distancia_maxima_km: null });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [jCerca, jLejos],
            disponibilidadPorJurado: { jCerca: rangoFechas('2026-09-05', 1), jLejos: rangoFechas('2026-09-05', 1) },
            comunas: [COMUNA_JURADO, comunaLejosJurado]
        }), undefined, config);
        expect(res.resultados[0].jurado_propuesto.jurado_id).toBe('jCerca');
    });
});

// ═════════════════════════════════════════════════════════════════════════
// TESTS DE ALTERNANCIA (sección 48)
// ═════════════════════════════════════════════════════════════════════════
describe('Motor — Equidad de Traslados: alternancia por última salida (sección 48)', () => {
    const config = configEquidad(350, ['EQUIDAD_TRASLADOS'], { regla_distancia_maxima_activa: false, distancia_maxima_km: null });
    // Ambos candidatos a la MISMA distancia del rodeo objetivo (misma comuna) —
    // así la única diferencia real es su historial de traslados.
    function fixtureAlternancia(fechaRodeoObjetivo) {
        const jA = jurado('jA', { comunaTexto: 'ComunaJuradoBase' });
        const jB = jurado('jB', { comunaTexto: 'ComunaJuradoBase' });
        const asigs = [
            asigHistorica('jA', 'r-hist-a', '2026-08-01', COMUNA_LEJOS),   // última de A: LEJOS, 850km
            asigHistorica('jB', 'r-hist-b', '2026-08-01', COMUNA_CERCA)    // última de B: CERCA, ~0km
        ];
        return { jA, jB, asigs };
    }
    test('Caso 1: nueva salida LEJOS -> se prefiere a B (su última no fue lejos)', () => {
        const { jA, jB, asigs } = fixtureAlternancia();
        const r = rodeoInterno('r-nuevo', { fecha: '2026-09-05', comunaObj: COMUNA_LEJOS });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [jA, jB],
            disponibilidadPorJurado: { jA: rangoFechas('2026-09-05', 1), jB: rangoFechas('2026-09-05', 1) },
            asignacionesTemporada: asigs,
            comunas: [COMUNA_LEJOS, COMUNA_CERCA, COMUNA_JURADO]
        }), undefined, config);
        expect(res.resultados[0].jurado_propuesto.jurado_id).toBe('jB');
    });
    test('Caso 2: nueva salida CERCA -> se prefiere a A (compensar su última salida lejana)', () => {
        const { jA, jB, asigs } = fixtureAlternancia();
        const r = rodeoInterno('r-nuevo', { fecha: '2026-09-05', comunaObj: COMUNA_CERCA });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [jA, jB],
            disponibilidadPorJurado: { jA: rangoFechas('2026-09-05', 1), jB: rangoFechas('2026-09-05', 1) },
            asignacionesTemporada: asigs,
            comunas: [COMUNA_LEJOS, COMUNA_CERCA, COMUNA_JURADO]
        }), undefined, config);
        expect(res.resultados[0].jurado_propuesto.jurado_id).toBe('jA');
    });
});

// ═════════════════════════════════════════════════════════════════════════
// TEST CERCA SIEMPRE GANA (sección 26, revisión de cierre) — escenario FUERTE:
// A está PEOR en TODOS los demás criterios y aun así gana, porque
// EQUIDAD_TRASLADOS es Nº1 y su clasificación CERCA/LEJOS decide ANTES que
// cualquier otro criterio pueda pesar. Demuestra "SIEMPRE preferir cercanía".
// ═════════════════════════════════════════════════════════════════════════
describe('Motor — Equidad de Traslados: CERCA siempre gana, aunque pierda en todo lo demás (sección 26)', () => {
    test('A (349km, mejor categoría preferente PERDIDA a propósito, más designaciones, historial menos favorable) le gana a B (351km, mejor en todo lo demás)', () => {
        const comunaA = comuna(latADistancia(-33.45, 349), -70.6667, 'A349');
        const comunaB = comuna(latADistancia(-33.45, 351), -70.6667, 'B351');
        // Orden: EQUIDAD_TRASLADOS -> PRIORIDAD_CATEGORIA -> MENOS_DESIGNACIONES —
        // ambos activos DESPUÉS de equidad, para probar que NO alcanzan a decidir
        // (si decidieran, ganaría B: mejor categoría + menos designaciones).
        const config = configEquidad(350, ['EQUIDAD_TRASLADOS', 'PRIORIDAD_CATEGORIA', 'MENOS_DESIGNACIONES_TEMPORADA'],
            { regla_distancia_maxima_activa: false, distancia_maxima_km: null });

        // Clasificación 'provincial' en V1: B es preferente (orden_preferencia=1),
        // A es menos preferente (orden_preferencia=2) — jA tiene la categoría PEOR.
        const jA = jurado('jA', { categoria: 'A', comunaTexto: 'A349' });
        const jB = jurado('jB', { categoria: 'B', comunaTexto: 'B351' });
        const r = rodeoInterno('r-nuevo', { fecha: '2026-09-05', clasificacion_codigo: 'provincial', comunaObj: COMUNA_JURADO });

        // A ya tiene 3 designaciones previas esta temporada (peor en MENOS_DESIGNACIONES); B tiene 0.
        const asigsA = [];
        for (let i = 0; i < 3; i++) asigsA.push(asigHistorica('jA', `rA-desig-${i}`, `2026-05-0${i + 1}`, COMUNA_CERCA));

        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [jA, jB],
            disponibilidadPorJurado: { jA: rangoFechas('2026-09-05', 1), jB: rangoFechas('2026-09-05', 1) },
            asignacionesTemporada: asigsA,
            comunas: [comunaA, comunaB, COMUNA_JURADO]
        }), undefined, config);

        expect(res.resultados[0].estado).toBe('PROPUESTO');
        expect(res.resultados[0].jurado_propuesto.jurado_id).toBe('jA'); // gana el más CERCA (349km), pese a perder en categoría y designaciones
        expect(res.resultados[0].jurado_propuesto.distancia_clasificacion).toBe('CERCA');
    });
});

// ═════════════════════════════════════════════════════════════════════════
// TESTS ALTERNANCIA DENTRO DEL MISMO GRUPO — MENOR_DISTANCIA NO decide sobre
// cercanía/lejanía (secciones 27/28, revisión de cierre): con EQUIDAD_
// TRASLADOS de Nº1 y MENOR_DISTANCIA como criterio posterior, la compensación
// histórica decide ANTES que la distancia exacta dentro del mismo grupo
// CERCA/CERCA o LEJOS/LEJOS.
// ═════════════════════════════════════════════════════════════════════════
describe('Motor — alternancia dentro del mismo grupo, MENOR_DISTANCIA solo desempata después (sección 27/28)', () => {
    const config = configEquidad(350, ['EQUIDAD_TRASLADOS', 'MENOR_DISTANCIA'], { regla_distancia_maxima_activa: false, distancia_maxima_km: null });

    // La distancia histórica se reconstruye con la comuna ACTUAL del jurado
    // (limitación documentada) — para que el historial de cada jurado se
    // reconstruya EXACTAMENTE en el km deseado sin importar su propia comuna
    // actual (que en estos tests difiere entre A y B a propósito, para poder
    // probar distancia_km distinta al rodeo nuevo), el punto histórico se
    // ubica a `distanciaDeseada` del offset actual de CADA jurado — mismo
    // esquema lineal que latADistancia/comuna ya usa el resto del archivo.
    function comunaHistoricaPara(offsetActualKm, distanciaDeseadaKm, nombre) {
        return comuna(latADistancia(-33.45, offsetActualKm + distanciaDeseadaKm), -70.6667, nombre);
    }

    test('sección 27 — ambos <=350: A (última LEJOS) gana aunque B esté más cerca dentro del grupo CERCA', () => {
        const OFFSET_A = 300, OFFSET_B = 50; // ambos CERCA (<=350) del rodeo nuevo; B más cerca
        const comunaA = comuna(latADistancia(-33.45, OFFSET_A), -70.6667, 'A300cerca');
        const comunaB = comuna(latADistancia(-33.45, OFFSET_B), -70.6667, 'B50cerca');
        const histLejosA = comunaHistoricaPara(OFFSET_A, 850, 'HistLejosA');   // reconstruye a 850km de A -> LEJOS
        const histCercaB = comunaHistoricaPara(OFFSET_B, 0, 'HistCercaB');    // reconstruye a 0km de B -> CERCA
        const jA = jurado('jA', { comunaTexto: 'A300cerca' });
        const jB = jurado('jB', { comunaTexto: 'B50cerca' });
        const asigs = [
            asigHistorica('jA', 'r-hist-a', '2026-08-01', histLejosA),  // última de A: LEJOS
            asigHistorica('jB', 'r-hist-b', '2026-08-01', histCercaB)   // última de B: CERCA
        ];
        const r = rodeoInterno('r-nuevo', { fecha: '2026-09-05', comunaObj: COMUNA_JURADO });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [jA, jB],
            disponibilidadPorJurado: { jA: rangoFechas('2026-09-05', 1), jB: rangoFechas('2026-09-05', 1) },
            asignacionesTemporada: asigs,
            comunas: [comunaA, comunaB, histLejosA, histCercaB, COMUNA_JURADO]
        }), undefined, config);
        // Sin equidad, MENOR_DISTANCIA elegiría a B (50km < 300km). Con equidad Nº1,
        // A gana por compensación (última LEJOS) — MENOR_DISTANCIA nunca llega a decidir.
        expect(res.resultados[0].jurado_propuesto.jurado_id).toBe('jA');
    });

    test('sección 28 — ambos >350: B (última CERCA) gana aunque A esté más cerca dentro del grupo LEJOS', () => {
        const OFFSET_A = 400, OFFSET_B = 900; // ambos LEJOS (>350) del rodeo nuevo; A más cerca
        const comunaA = comuna(latADistancia(-33.45, OFFSET_A), -70.6667, 'A400lejos');
        const comunaB = comuna(latADistancia(-33.45, OFFSET_B), -70.6667, 'B900lejos');
        const histLejosA = comunaHistoricaPara(OFFSET_A, 850, 'HistLejosA2');  // reconstruye a 850km de A -> LEJOS
        const histCercaB = comunaHistoricaPara(OFFSET_B, 0, 'HistCercaB2');    // reconstruye a 0km de B -> CERCA
        const jA = jurado('jA', { comunaTexto: 'A400lejos' });
        const jB = jurado('jB', { comunaTexto: 'B900lejos' });
        const asigs = [
            asigHistorica('jA', 'r-hist-a', '2026-08-01', histLejosA),  // última de A: LEJOS
            asigHistorica('jB', 'r-hist-b', '2026-08-01', histCercaB)   // última de B: CERCA
        ];
        const r = rodeoInterno('r-nuevo', { fecha: '2026-09-05', comunaObj: COMUNA_JURADO });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [jA, jB],
            disponibilidadPorJurado: { jA: rangoFechas('2026-09-05', 1), jB: rangoFechas('2026-09-05', 1) },
            asignacionesTemporada: asigs,
            comunas: [comunaA, comunaB, histLejosA, histCercaB, COMUNA_JURADO]
        }), undefined, config);
        // Sin equidad, MENOR_DISTANCIA elegiría a A (400km < 900km). Con equidad Nº1,
        // B gana (su última salida no fue LEJOS) — MENOR_DISTANCIA nunca decide.
        expect(res.resultados[0].jurado_propuesto.jurado_id).toBe('jB');
    });
});

// ═════════════════════════════════════════════════════════════════════════
// TESTS HISTORIAL DE TEMPORADA (sección 49)
// ═════════════════════════════════════════════════════════════════════════
describe('Motor — Equidad de Traslados: carga de toda la temporada, no solo la última (sección 49)', () => {
    const config = configEquidad(350, ['EQUIDAD_TRASLADOS'], { regla_distancia_maxima_activa: false, distancia_maxima_km: null });
    // A: 4 lejos / 2 cerca. B: 1 lejos / 5 cerca. Última salida de AMBOS: CERCA (para
    // aislar el efecto del conteo total, no de "última salida").
    function fixtureCargaTemporada() {
        const jA = jurado('jA', { comunaTexto: 'ComunaJuradoBase' });
        const jB = jurado('jB', { comunaTexto: 'ComunaJuradoBase' });
        const asigs = [];
        for (let i = 0; i < 4; i++) asigs.push(asigHistorica('jA', `rA-lejos-${i}`, `2026-05-0${i + 1}`, COMUNA_LEJOS));
        for (let i = 0; i < 2; i++) asigs.push(asigHistorica('jA', `rA-cerca-${i}`, `2026-06-0${i + 1}`, COMUNA_CERCA));
        asigs.push(asigHistorica('jB', 'rB-lejos-0', '2026-05-01', COMUNA_LEJOS));
        for (let i = 0; i < 5; i++) asigs.push(asigHistorica('jB', `rB-cerca-${i}`, `2026-06-1${i}`, COMUNA_CERCA));
        // Última salida de ambos = la de fecha más tardía = CERCA (junio) en ambos casos.
        return { jA, jB, asigs };
    }
    test('nueva salida LEJOS -> se prefiere a B (menos carga de lejos: 1 vs 4)', () => {
        const { jA, jB, asigs } = fixtureCargaTemporada();
        const r = rodeoInterno('r-nuevo', { fecha: '2026-09-05', comunaObj: COMUNA_LEJOS });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [jA, jB],
            disponibilidadPorJurado: { jA: rangoFechas('2026-09-05', 1), jB: rangoFechas('2026-09-05', 1) },
            asignacionesTemporada: asigs, comunas: [COMUNA_LEJOS, COMUNA_CERCA, COMUNA_JURADO]
        }), undefined, config);
        expect(res.resultados[0].jurado_propuesto.jurado_id).toBe('jB');
    });
    test('nueva salida CERCA -> se prefiere a A (compensación: mayor carga histórica de lejos, 4 vs 1)', () => {
        const { jA, jB, asigs } = fixtureCargaTemporada();
        const r = rodeoInterno('r-nuevo', { fecha: '2026-09-05', comunaObj: COMUNA_CERCA });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [jA, jB],
            disponibilidadPorJurado: { jA: rangoFechas('2026-09-05', 1), jB: rangoFechas('2026-09-05', 1) },
            asignacionesTemporada: asigs, comunas: [COMUNA_LEJOS, COMUNA_CERCA, COMUNA_JURADO]
        }), undefined, config);
        expect(res.resultados[0].jurado_propuesto.jurado_id).toBe('jA');
    });
});

// ═════════════════════════════════════════════════════════════════════════
// TEST MULTI-RODEO — estado temporal dentro de la misma simulación (sección 50)
// ═════════════════════════════════════════════════════════════════════════
describe('Motor — Equidad de Traslados: estado temporal dentro del mismo batch (sección 50/21)', () => {
    test('rodeo 1 entrega un viaje LEJOS a A; rodeo 2 (mismo batch) ya no debe preferir a A para otro viaje lejano', () => {
        const config = configEquidad(350, ['EQUIDAD_TRASLADOS'], { regla_distancia_maxima_activa: false, distancia_maxima_km: null });
        const jA = jurado('jA', { comunaTexto: 'ComunaJuradoBase' });
        const jB = jurado('jB', { comunaTexto: 'ComunaJuradoBase' });
        // Ambos sin historial de BD -> arrancan empatados; solo el batch decide.
        const r1 = rodeoInterno('r1', { fecha: '2026-09-05', clasificacion_codigo: 'nacional', comunaObj: COMUNA_LEJOS });
        const r2 = rodeoInterno('r2', { fecha: '2026-09-06', clasificacion_codigo: 'nacional', comunaObj: COMUNA_LEJOS });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r1, r2], jurados: [jA, jB],
            disponibilidadPorJurado: {
                jA: [...rangoFechas('2026-09-05', 1), ...rangoFechas('2026-09-06', 1)],
                jB: [...rangoFechas('2026-09-05', 1), ...rangoFechas('2026-09-06', 1)]
            },
            comunas: [COMUNA_LEJOS, COMUNA_JURADO]
        }), undefined, config);
        const propuestos = res.resultados.filter(r => r.estado === 'PROPUESTO').map(r => r.jurado_propuesto.jurado_id);
        expect(propuestos).toHaveLength(2);
        // El motor debe distribuir: NO debe asignar los 2 viajes lejanos al mismo jurado
        // ignorando la propuesta recién hecha en este mismo batch.
        expect(new Set(propuestos).size).toBe(2);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// TEST INTEGRACIÓN — "¿Por qué ganó?" solo se atribuye a equidad cuando fue
// REALMENTE decisiva (sección 19, revisión de cierre) — a nivel de
// ejecutarSimulacion(), no solo de la función pura.
// ═════════════════════════════════════════════════════════════════════════
describe('Motor — equidad_traslados_explicacion refleja si realmente decidió (sección 19)', () => {
    test('empate en equidad (mismo historial) -> MENOS_DESIGNACIONES_TEMPORADA decide -> explicación marca "empate"', () => {
        const config = configEquidad(350, ['EQUIDAD_TRASLADOS', 'MENOS_DESIGNACIONES_TEMPORADA'],
            { regla_distancia_maxima_activa: false, distancia_maxima_km: null });
        // Mismo comuna (misma distancia, misma clasificación CERCA) y SIN
        // historial de temporada para ninguno -> empate perfecto en equidad.
        // B tiene menos designaciones previas -> decide el criterio siguiente.
        const jA = jurado('jA', { comunaTexto: 'ComunaJuradoBase' });
        const jB = jurado('jB', { comunaTexto: 'ComunaJuradoBase' });
        const asigsA = [asigHistorica('jA', 'rA-desig-0', '2026-05-01', COMUNA_CERCA)]; // 1 designación previa
        const r = rodeoInterno('r-nuevo', { fecha: '2026-09-05', comunaObj: COMUNA_JURADO });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [jA, jB],
            disponibilidadPorJurado: { jA: rangoFechas('2026-09-05', 1), jB: rangoFechas('2026-09-05', 1) },
            asignacionesTemporada: asigsA,
            comunas: [COMUNA_CERCA, COMUNA_JURADO]
        }), undefined, config);
        expect(res.resultados[0].jurado_propuesto.jurado_id).toBe('jB'); // menos designaciones decide
        const explicacion = res.resultados[0].jurado_propuesto.equidad_traslados_explicacion;
        expect(explicacion).toMatch(/empate/i);
        expect(explicacion).not.toMatch(/ganó por equidad/i);
    });

    test('equidad SÍ decisiva (distinta clasificación) -> explicación NO menciona empate', () => {
        const config = configEquidad(350, ['EQUIDAD_TRASLADOS', 'MENOS_DESIGNACIONES_TEMPORADA'],
            { regla_distancia_maxima_activa: false, distancia_maxima_km: null });
        const comunaCerca = comuna(latADistancia(-33.45, 100), -70.6667, 'Cerca100');
        const comunaLejos = comuna(latADistancia(-33.45, 900), -70.6667, 'Lejos900');
        const jA = jurado('jA', { comunaTexto: 'Cerca100' });
        const jB = jurado('jB', { comunaTexto: 'Lejos900' });
        // B tiene MENOS designaciones (ventaja en el criterio siguiente) — si equidad
        // no fuera decisiva, B ganaría. Confirma que igual gana A (CERCA) por equidad.
        const r = rodeoInterno('r-nuevo', { fecha: '2026-09-05', comunaObj: COMUNA_JURADO });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [jA, jB],
            disponibilidadPorJurado: { jA: rangoFechas('2026-09-05', 1), jB: rangoFechas('2026-09-05', 1) },
            comunas: [comunaCerca, comunaLejos, COMUNA_JURADO]
        }), undefined, config);
        expect(res.resultados[0].jurado_propuesto.jurado_id).toBe('jA');
        expect(res.resultados[0].jurado_propuesto.equidad_traslados_explicacion).not.toMatch(/empate/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// TESTS CONFIG HISTÓRICA — V1/schema_version=1 sin cambios (sección 51)
// ═════════════════════════════════════════════════════════════════════════
describe('Motor — compatibilidad con configuración histórica V1 (sección 51)', () => {
    test('V1 (schema_version=1, sin EQUIDAD_TRASLADOS) produce distancia_clasificacion=null y traslados_temporada=null', () => {
        const j = jurado('j1', { comunaTexto: 'ComunaJuradoBase' });
        const r = rodeoInterno('r1', { fecha: '2026-09-05', comunaObj: COMUNA_JURADO });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [j], disponibilidadPorJurado: { j1: rangoFechas('2026-09-05', 1) },
            comunas: [COMUNA_JURADO]
        }), undefined, construirConfiguracionDefaultV1());
        expect(res.resultados[0].estado).toBe('PROPUESTO');
        expect(res.resultados[0].jurado_propuesto.distancia_clasificacion).toBeNull();
        expect(res.resultados[0].jurado_propuesto.traslados_temporada).toBeNull();
        expect(res.resultados[0].jurado_propuesto.equidad_traslados_explicacion).toBeNull();
        // distancia_km sigue calculándose igual que siempre (no se toca MENOR_DISTANCIA/comportamiento base).
        expect(res.resultados[0].jurado_propuesto.distancia_km).not.toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════════
// TESTS DE MÉTRICAS DE RENDIMIENTO (sección 52) — construirRendimientoPorJurado, PURA
// ═════════════════════════════════════════════════════════════════════════
describe('construirRendimientoPorJurado (sección 52)', () => {
    const HOY = '2026-09-10';
    function datosBase() {
        return {
            asignacionesTemporada: [
                { id: 'a1', usuario_pagado_id: 'j1', rodeo_id: 'r1', rodeos: { fecha: '2026-05-01' } },
                { id: 'a2', usuario_pagado_id: 'j1', rodeo_id: 'r2', rodeos: { fecha: '2026-06-01' } },
                { id: 'a3', usuario_pagado_id: 'j1', rodeo_id: 'r3', rodeos: { fecha: '2026-07-01' } },
                { id: 'a4', usuario_pagado_id: 'j2', rodeo_id: 'r4', rodeos: { fecha: '2026-06-15' } }
            ],
            notasPorAsignacion: new Map([['a1', 5.0], ['a2', 6.0], ['a3', 7.0], ['a4', 4.0]]),
            alteradoPorRodeo: new Map([['r1', true]])
        };
    }
    const jurados = [{ id: 'j1', categoria: 'A' }, { id: 'j2', categoria: 'A' }];

    test('A: última nota correcta (nota del rodeo más reciente por fecha)', () => {
        const r = construirRendimientoPorJurado(datosBase(), jurados, ['j1'], HOY);
        expect(r.get('j1').ultima_nota).toBe(7.0); // r3, 2026-07-01, la más reciente
    });
    test('B: promedio jurado (media de sus notas válidas)', () => {
        const r = construirRendimientoPorJurado(datosBase(), jurados, ['j1'], HOY);
        expect(r.get('j1').promedio_jurado).toBe(6.0); // (5+6+7)/3
    });
    test('C: promedio categoría (promedio de promedios por jurado de la misma categoría)', () => {
        const r = construirRendimientoPorJurado(datosBase(), jurados, ['j1', 'j2'], HOY);
        // j1 promedio=6.0, j2 promedio=4.0 -> categoría A = (6.0+4.0)/2 = 5.0
        expect(r.get('j1').promedio_categoria).toBe(5.0);
        expect(r.get('j2').promedio_categoria).toBe(5.0);
    });
    test('D: promedio general (plano sobre todas las notas individuales)', () => {
        const r = construirRendimientoPorJurado(datosBase(), jurados, ['j1'], HOY);
        // (5+6+7+4)/4 = 5.5
        expect(r.get('j1').promedio_general).toBe(5.5);
    });
    test('E: 1 alterado / 3 rodeos = 1/3 (33%)', () => {
        const r = construirRendimientoPorJurado(datosBase(), jurados, ['j1'], HOY);
        expect(r.get('j1').alteracion).toEqual({ alterados: 1, total: 3, porcentaje: 33 });
    });
    test('F: 0/4 = 0%', () => {
        const datos = datosBase();
        datos.alteradoPorRodeo = new Map(); // ninguna alteración
        const asignacionesTemporada = [
            ...datos.asignacionesTemporada,
            { id: 'a5', usuario_pagado_id: 'j1', rodeo_id: 'r5', rodeos: { fecha: '2026-08-01' } }
        ];
        const r = construirRendimientoPorJurado({ ...datos, asignacionesTemporada }, jurados, ['j1'], HOY);
        expect(r.get('j1').alteracion).toEqual({ alterados: 0, total: 4, porcentaje: 0 });
    });
    test('G: 0 rodeos -> N/D (null), sin división por cero', () => {
        const r = construirRendimientoPorJurado(datosBase(), jurados, ['j-sin-rodeos'], HOY);
        const rend = r.get('j-sin-rodeos');
        expect(rend.alteracion).toEqual({ alterados: 0, total: 0, porcentaje: null });
        expect(rend.ultima_nota).toBeNull();
        expect(rend.promedio_jurado).toBeNull();
    });
    test('H: rodeos futuros (fecha > hoy) se excluyen de última nota/promedio/alteración', () => {
        const datos = datosBase();
        datos.asignacionesTemporada.push({ id: 'a-futura', usuario_pagado_id: 'j1', rodeo_id: 'r-futuro', rodeos: { fecha: '2026-12-01' } });
        datos.notasPorAsignacion.set('a-futura', 1.0); // nota mala, no debería aparecer
        datos.alteradoPorRodeo.set('r-futuro', true);
        const r = construirRendimientoPorJurado(datos, jurados, ['j1'], HOY); // HOY=2026-09-10, r-futuro es 2026-12-01
        expect(r.get('j1').ultima_nota).toBe(7.0); // sigue siendo r3, no la futura
        expect(r.get('j1').alteracion.total).toBe(3); // no cuenta el rodeo futuro
    });
    test('I: duplicidad de evaluaciones/filas no infla la cantidad de rodeos (cuenta RODEOS DISTINTOS)', () => {
        const datos = datosBase();
        // Dos asignaciones "duplicadas" apuntando al MISMO rodeo (ej. reasignación histórica) -
        // el denominador debe seguir contando 1 rodeo, no 2 filas.
        datos.asignacionesTemporada.push({ id: 'a1-dup', usuario_pagado_id: 'j1', rodeo_id: 'r1', rodeos: { fecha: '2026-05-01' } });
        const r = construirRendimientoPorJurado(datos, jurados, ['j1'], HOY);
        expect(r.get('j1').alteracion.total).toBe(3); // sigue siendo 3 rodeos distintos (r1,r2,r3), no 4
    });
});

// ═════════════════════════════════════════════════════════════════════════
// cargarRendimientoTemporada — con Supabase mockeado (anti N+1, sección 39/54)
// ═════════════════════════════════════════════════════════════════════════
describe('cargarRendimientoTemporada — batch, sin N+1', () => {
    function mockSupabaseConteo() {
        const llamadas = [];
        supabase.from.mockImplementation((tabla) => {
            llamadas.push(tabla);
            const chain = {
                select: () => chain, in: () => chain, eq: () => chain,
                then: (resolve) => Promise.resolve({ data: [], error: null }).then(resolve)
            };
            return chain;
        });
        return llamadas;
    }
    beforeEach(() => { supabase.from.mockReset(); });

    test('exactamente 2 queries nuevas, sin importar la cantidad de asignaciones/jurados de la temporada', async () => {
        const llamadas = mockSupabaseConteo();
        const muchasAsignaciones = Array.from({ length: 59 }, (_, i) => ({
            id: `a${i}`, usuario_pagado_id: `j${i % 20}`, rodeo_id: `r${i}`, rodeos: { fecha: '2026-05-01' }
        }));
        const contexto = { asignacionesTemporada: muchasAsignaciones };
        const resultado = await cargarRendimientoTemporada(contexto);
        expect(llamadas).toEqual(['notas_rodeo', 'evaluaciones']);
        expect(resultado.queriesAproximadas).toBe(2);
    });
    test('sin asignaciones de temporada -> 0 queries (nada que enriquecer)', async () => {
        const llamadas = mockSupabaseConteo();
        const resultado = await cargarRendimientoTemporada({ asignacionesTemporada: [] });
        expect(llamadas).toEqual([]);
        expect(resultado.queriesAproximadas).toBe(0);
    });
});
