const { ejecutarSimulacion, DISTANCIA_MAXIMA_KM, esAsignacionEfectiva, filtrarRodeosSinJuradoEfectivo } = require('./motorPropuestaDesignacion');
const { calcularBloqueRodeo, rangoFechas } = require('./feriados');

// ─────────────────────────────────────────────────────────────────────────
// Fixtures de prueba — construyen el "contexto" tal como lo arma
// cargarDatosMotor(), pero sin tocar la base de datos. ejecutarSimulacion()
// es una función pura: mismos datos de entrada → mismo resultado siempre.
// ─────────────────────────────────────────────────────────────────────────
const TEMPORADA = { nombre: '2026-2027', fecha_inicio: '2026-04-15', fecha_fin: '2027-04-15' };

// Matriz real (Etapa 2, verificada en BD): elegibles + preferente por clasificación.
const MATRIZ = {
    interclubes:      { elegibles: new Set(['B','C']), preferentes: new Set(['C']) },
    provincial:        { elegibles: new Set(['A','B']), preferentes: new Set(['B']) },
    interasociaciones: { elegibles: new Set(['A','B']), preferentes: new Set(['A']) },
    zonal:             { elegibles: new Set(['A','B']), preferentes: new Set(['A']) },
    clasificatorio:    { elegibles: new Set(['A','B']), preferentes: new Set(['A']) },
    nacional:          { elegibles: new Set(['A']),      preferentes: new Set(['A']) }
};

// Dos puntos sobre el mismo meridiano separados por una distancia EXACTA
// (misma fórmula que calcularDistanciaKm cuando dLng=0: distancia = R * dLatRad),
// para poder probar el límite de 600 km sin depender de coordenadas reales.
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

function catalogoConComunas(comunas, alias = []) {
    return { comunas, alias };
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

function contexto({ rodeos, jurados, disponibilidadPorJurado = {}, asignacionesTemporada = [], comunas = [], alias = [], temporada = TEMPORADA, matriz = MATRIZ }) {
    const rodeosPorId = new Map(rodeos.map(r => [r.id, r]));
    const disponibilidad = new Map();
    for (const [juradoId, fechas] of Object.entries(disponibilidadPorJurado)) {
        disponibilidad.set(juradoId, new Set(fechas));
    }
    return {
        idsSolicitados: rodeos.map(r => r.id),
        temporada,
        rodeosPorId,
        matrizPorCodigo: matriz,
        jurados,
        catalogoComunas: catalogoConComunas(comunas, alias),
        disponibilidad,
        asignacionesTemporada
    };
}

// Comunas por defecto: rodeo y jurado en el mismo punto (distancia 0) salvo que
// un test indique lo contrario.
const COMUNA_RODEO_DEFAULT = comuna(-33.45, -70.6667, 'ComunaRodeo');
const COMUNA_JURADO_DEFAULT = comuna(-33.45, -70.6667, 'ComunaJurado'); // mismo punto → 0 km

// Un único jurado disponible en una fecha dada, con datos "todo en regla" —
// usado como base y luego se rompe una sola condición por test.
function juradoDisponibleBase(id, fecha, duracionDias = 1, overrides = {}) {
    return {
        j: jurado(id, { categoria: 'A', asociacion: 'Asociación Jurado', comunaTexto: 'ComunaJurado', ...overrides }),
        disponibilidad: rangoFechas(fecha, duracionDias)
    };
}

describe('Motor de Propuesta de Designación — reglas duras (CASO 1-8)', () => {
    test('CASO 1: jurado no disponible → descartado', () => {
        const fecha = '2026-09-05';
        const j = jurado('j1', { comunaTexto: 'ComunaJurado' });
        const r = rodeoInterno('r1', { fecha, comunaObj: COMUNA_RODEO_DEFAULT });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [j],
            disponibilidadPorJurado: {}, // sin disponibilidad declarada
            comunas: [COMUNA_RODEO_DEFAULT, COMUNA_JURADO_DEFAULT]
        }));
        expect(res.resultados[0].estado).toBe('SIN_PROPUESTA');
        expect(res.resultados[0].descartes.DISPONIBILIDAD).toBe(1);
    });

    test('CASO 2: misma asociación del rodeo → descartado', () => {
        const fecha = '2026-09-05';
        const j = jurado('j1', { asociacion: 'Colchagua', comunaTexto: 'ComunaJurado' });
        const r = rodeoInterno('r1', { fecha, asociacion: 'Colchagua', comunaObj: COMUNA_RODEO_DEFAULT });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [j],
            disponibilidadPorJurado: { j1: rangoFechas(fecha, 1) },
            comunas: [COMUNA_RODEO_DEFAULT, COMUNA_JURADO_DEFAULT]
        }));
        expect(res.resultados[0].estado).toBe('SIN_PROPUESTA');
        expect(res.resultados[0].descartes.MISMA_ASOCIACION).toBe(1);
    });

    test('CASO 3: repite asociación ya designada en la temporada → descartado', () => {
        const fecha = '2026-09-05';
        const j = jurado('j1', { asociacion: 'Asociación Jurado', comunaTexto: 'ComunaJurado' });
        const r = rodeoInterno('r1', { fecha, asociacion: 'Colchagua', comunaObj: COMUNA_RODEO_DEFAULT });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [j],
            disponibilidadPorJurado: { j1: rangoFechas(fecha, 1) },
            asignacionesTemporada: [{ usuario_pagado_id: 'j1', rodeo_id: 'r-historico', rodeos: { fecha: '2026-05-01', duracion_dias: 1, asociacion: 'Colchagua' } }],
            comunas: [COMUNA_RODEO_DEFAULT, COMUNA_JURADO_DEFAULT]
        }));
        expect(res.resultados[0].estado).toBe('SIN_PROPUESTA');
        expect(res.resultados[0].descartes.ASOCIACION_REPETIDA_TEMPORADA).toBe(1);
    });

    test('CASO 4: trabajó el fin de semana anterior (consecutivo) → descartado', () => {
        const fechaAnterior = '2026-09-05'; // sábado
        const fechaActual = '2026-09-12';   // sábado siguiente, sin feriado entre medio
        const j = jurado('j1', { asociacion: 'Asociación Jurado', comunaTexto: 'ComunaJurado' });
        const r = rodeoInterno('r1', { fecha: fechaActual, asociacion: 'Otra', comunaObj: COMUNA_RODEO_DEFAULT });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [j],
            disponibilidadPorJurado: { j1: rangoFechas(fechaActual, 1) },
            asignacionesTemporada: [{ usuario_pagado_id: 'j1', rodeo_id: 'r-previo', rodeos: { fecha: fechaAnterior, duracion_dias: 1, asociacion: 'Distinta' } }],
            comunas: [COMUNA_RODEO_DEFAULT, COMUNA_JURADO_DEFAULT]
        }));
        expect(res.resultados[0].estado).toBe('SIN_PROPUESTA');
        expect(res.resultados[0].descartes.FINDE_CONSECUTIVO).toBe(1);
    });

    test('CASO 5: ya tiene un rodeo el mismo fin de semana → descartado', () => {
        const fecha = '2026-09-05'; // sábado
        const j = jurado('j1', { asociacion: 'Asociación Jurado', comunaTexto: 'ComunaJurado' });
        const r = rodeoInterno('r1', { fecha, asociacion: 'Otra', comunaObj: COMUNA_RODEO_DEFAULT });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [j],
            disponibilidadPorJurado: { j1: rangoFechas(fecha, 1) },
            // Ya asignado el domingo (2026-09-06) del MISMO bloque de fin de semana
            asignacionesTemporada: [{ usuario_pagado_id: 'j1', rodeo_id: 'r-mismo-finde', rodeos: { fecha: '2026-09-06', duracion_dias: 1, asociacion: 'Distinta' } }],
            comunas: [COMUNA_RODEO_DEFAULT, COMUNA_JURADO_DEFAULT]
        }));
        expect(res.resultados[0].estado).toBe('SIN_PROPUESTA');
        expect(res.resultados[0].descartes.MISMO_FINDE).toBe(1);
    });

    test('CASO 6: distancia 599 km → elegible', () => {
        const fecha = '2026-09-05';
        const comunaJ = comuna(latADistancia(-30, 599), -70, 'ComunaJ599');
        const comunaR = comuna(-30, -70, 'ComunaR599');
        const j = jurado('j1', { asociacion: 'Asociación Jurado', comunaTexto: comunaJ.nombre });
        const r = rodeoInterno('r1', { fecha, asociacion: 'Otra', comunaObj: comunaR });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [j],
            disponibilidadPorJurado: { j1: rangoFechas(fecha, 1) },
            comunas: [comunaJ, comunaR]
        }));
        expect(res.resultados[0].estado).toBe('PROPUESTO');
        expect(res.resultados[0].jurado_propuesto.distancia_km).toBeLessThan(DISTANCIA_MAXIMA_KM);
    });

    test('CASO 7: distancia > 600 km → descartado', () => {
        const fecha = '2026-09-05';
        const comunaJ = comuna(latADistancia(-30, 601), -70, 'ComunaJ601');
        const comunaR = comuna(-30, -70, 'ComunaR601');
        const j = jurado('j1', { asociacion: 'Asociación Jurado', comunaTexto: comunaJ.nombre });
        const r = rodeoInterno('r1', { fecha, asociacion: 'Otra', comunaObj: comunaR });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [j],
            disponibilidadPorJurado: { j1: rangoFechas(fecha, 1) },
            comunas: [comunaJ, comunaR]
        }));
        expect(res.resultados[0].estado).toBe('SIN_PROPUESTA');
        expect(res.resultados[0].descartes.DISTANCIA_EXCEDIDA).toBe(1);
    });

    test('CASO 8: categoría incompatible → descartado', () => {
        const fecha = '2026-09-05';
        const j = jurado('j1', { categoria: 'C', asociacion: 'Asociación Jurado', comunaTexto: 'ComunaJurado' });
        const r = rodeoInterno('r1', { fecha, clasificacion_codigo: 'nacional', asociacion: 'Otra', comunaObj: COMUNA_RODEO_DEFAULT });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [j],
            disponibilidadPorJurado: { j1: rangoFechas(fecha, 1) },
            comunas: [COMUNA_RODEO_DEFAULT, COMUNA_JURADO_DEFAULT]
        }));
        expect(res.resultados[0].estado).toBe('SIN_PROPUESTA');
        expect(res.resultados[0].descartes.CATEGORIA_INCOMPATIBLE).toBe(1);
    });
});

describe('Motor — prioridad de categoría (CASO 9-10)', () => {
    test('CASO 9: Provincial con B y A disponibles → prefiere B', () => {
        const fecha = '2026-09-05';
        const jA = jurado('jA', { categoria: 'A', comunaTexto: 'ComunaJurado' });
        const jB = jurado('jB', { categoria: 'B', comunaTexto: 'ComunaJurado' });
        const r = rodeoInterno('r1', { fecha, clasificacion_codigo: 'provincial', comunaObj: COMUNA_RODEO_DEFAULT });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [jA, jB],
            disponibilidadPorJurado: { jA: rangoFechas(fecha, 1), jB: rangoFechas(fecha, 1) },
            comunas: [COMUNA_RODEO_DEFAULT, COMUNA_JURADO_DEFAULT]
        }));
        expect(res.resultados[0].estado).toBe('PROPUESTO');
        expect(res.resultados[0].jurado_propuesto.jurado_id).toBe('jB');
        expect(res.resultados[0].jurado_propuesto.categoria_preferente).toBe(true);
    });

    test('CASO 10: Provincial sin B válido → permite A', () => {
        const fecha = '2026-09-05';
        const jA = jurado('jA', { categoria: 'A', comunaTexto: 'ComunaJurado' });
        const r = rodeoInterno('r1', { fecha, clasificacion_codigo: 'provincial', comunaObj: COMUNA_RODEO_DEFAULT });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [jA],
            disponibilidadPorJurado: { jA: rangoFechas(fecha, 1) },
            comunas: [COMUNA_RODEO_DEFAULT, COMUNA_JURADO_DEFAULT]
        }));
        expect(res.resultados[0].estado).toBe('PROPUESTO');
        expect(res.resultados[0].jurado_propuesto.jurado_id).toBe('jA');
        expect(res.resultados[0].jurado_propuesto.categoria_preferente).toBe(false);
    });
});

describe('Motor — equidad y desempate (CASO 11-12)', () => {
    test('CASO 11: dos candidatos iguales salvo cantidad de designaciones → elige el de 2, no el de 4', () => {
        const fecha = '2026-09-05';
        const jMenos = jurado('jMenos', { categoria: 'A', comunaTexto: 'ComunaJurado' });
        const jMas = jurado('jMas', { categoria: 'A', comunaTexto: 'ComunaJurado' });
        const r = rodeoInterno('r1', { fecha, clasificacion_codigo: 'nacional', comunaObj: COMUNA_RODEO_DEFAULT });
        const asigsHist = (juradoId, n) => Array.from({ length: n }, (_, i) => ({
            usuario_pagado_id: juradoId, rodeo_id: `hist-${juradoId}-${i}`,
            rodeos: { fecha: `2026-0${5 - (i % 3)}-0${(i % 9) + 1}`, duracion_dias: 1, asociacion: `Historica${i}` }
        }));
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [jMenos, jMas],
            disponibilidadPorJurado: { jMenos: rangoFechas(fecha, 1), jMas: rangoFechas(fecha, 1) },
            asignacionesTemporada: [...asigsHist('jMenos', 2), ...asigsHist('jMas', 4)],
            comunas: [COMUNA_RODEO_DEFAULT, COMUNA_JURADO_DEFAULT]
        }));
        expect(res.resultados[0].jurado_propuesto.jurado_id).toBe('jMenos');
        expect(res.resultados[0].jurado_propuesto.designaciones_temporada_antes).toBe(2);
    });

    test('CASO 12: mismo conteo de designaciones, 80 km vs 200 km → elige 80 km', () => {
        const fecha = '2026-09-05';
        const comunaCerca = comuna(latADistancia(-30, 80), -70, 'ComunaCerca');
        const comunaLejos = comuna(latADistancia(-30, 200), -70, 'ComunaLejos');
        const comunaR = comuna(-30, -70, 'ComunaR12');
        const jCerca = jurado('jCerca', { categoria: 'A', comunaTexto: comunaCerca.nombre });
        const jLejos = jurado('jLejos', { categoria: 'A', comunaTexto: comunaLejos.nombre });
        const r = rodeoInterno('r1', { fecha, clasificacion_codigo: 'nacional', comunaObj: comunaR });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [jCerca, jLejos],
            disponibilidadPorJurado: { jCerca: rangoFechas(fecha, 1), jLejos: rangoFechas(fecha, 1) },
            comunas: [comunaCerca, comunaLejos, comunaR]
        }));
        expect(res.resultados[0].jurado_propuesto.jurado_id).toBe('jCerca');
        expect(res.resultados[0].jurado_propuesto.distancia_km).toBeCloseTo(80, 0);
    });
});

describe('Motor — múltiples rodeos en la misma corrida (CASO 13-15, 20)', () => {
    test('CASO 13: mismo jurado, dos rodeos del mismo fin de semana en la corrida → solo obtiene uno', () => {
        const fecha = '2026-09-05'; // sábado
        const j = jurado('j1', { categoria: 'A', comunaTexto: 'ComunaJurado' });
        const r1 = rodeoInterno('r1', { fecha, clasificacion_codigo: 'nacional', asociacion: 'AsocA', comunaObj: COMUNA_RODEO_DEFAULT });
        const r2 = rodeoInterno('r2', { fecha: '2026-09-06', clasificacion_codigo: 'nacional', asociacion: 'AsocB', comunaObj: COMUNA_RODEO_DEFAULT }); // domingo, mismo bloque
        const res = ejecutarSimulacion(contexto({
            rodeos: [r1, r2], jurados: [j],
            disponibilidadPorJurado: { j1: [...rangoFechas(fecha, 1), ...rangoFechas('2026-09-06', 1)] },
            comunas: [COMUNA_RODEO_DEFAULT, COMUNA_JURADO_DEFAULT]
        }));
        const propuestos = res.resultados.filter(r => r.estado === 'PROPUESTO');
        expect(propuestos.length).toBe(1);
        const sinPropuesta = res.resultados.filter(r => r.estado === 'SIN_PROPUESTA');
        expect(sinPropuesta.length).toBe(1);
    });

    test('CASO 14: jurado usado en el finde actual queda excluido del finde consecutivo, dentro de la misma corrida', () => {
        const fechaA = '2026-09-05'; // sábado
        const fechaB = '2026-09-12'; // sábado siguiente
        const j = jurado('j1', { categoria: 'A', comunaTexto: 'ComunaJurado' });
        const rA = rodeoInterno('rA', { fecha: fechaA, clasificacion_codigo: 'nacional', asociacion: 'AsocA', comunaObj: COMUNA_RODEO_DEFAULT });
        const rB = rodeoInterno('rB', { fecha: fechaB, clasificacion_codigo: 'nacional', asociacion: 'AsocB', comunaObj: COMUNA_RODEO_DEFAULT });
        const res = ejecutarSimulacion(contexto({
            rodeos: [rA, rB], jurados: [j],
            disponibilidadPorJurado: { j1: [...rangoFechas(fechaA, 1), ...rangoFechas(fechaB, 1)] },
            comunas: [COMUNA_RODEO_DEFAULT, COMUNA_JURADO_DEFAULT]
        }));
        const propuestos = res.resultados.filter(r => r.estado === 'PROPUESTO');
        expect(propuestos.length).toBe(1); // el otro queda SIN_PROPUESTA por FINDE_CONSECUTIVO
        const sinPropuesta = res.resultados.find(r => r.estado === 'SIN_PROPUESTA');
        expect(sinPropuesta.descartes.FINDE_CONSECUTIVO).toBe(1);
    });

    test('CASO 15: dos rodeos misma asociación en la propuesta → el mismo jurado no puede recibir ambos', () => {
        const j = jurado('j1', { categoria: 'A', comunaTexto: 'ComunaJurado' });
        const r1 = rodeoInterno('r1', { fecha: '2026-09-05', clasificacion_codigo: 'nacional', asociacion: 'AsocRepetida', comunaObj: COMUNA_RODEO_DEFAULT });
        const r2 = rodeoInterno('r2', { fecha: '2026-10-10', clasificacion_codigo: 'nacional', asociacion: 'AsocRepetida', comunaObj: COMUNA_RODEO_DEFAULT }); // fecha lejana, sin conflicto de finde
        const res = ejecutarSimulacion(contexto({
            rodeos: [r1, r2], jurados: [j],
            disponibilidadPorJurado: { j1: [...rangoFechas('2026-09-05', 1), ...rangoFechas('2026-10-10', 1)] },
            comunas: [COMUNA_RODEO_DEFAULT, COMUNA_JURADO_DEFAULT]
        }));
        const propuestos = res.resultados.filter(r => r.estado === 'PROPUESTO');
        expect(propuestos.length).toBe(1);
        const sinPropuesta = res.resultados.find(r => r.estado === 'SIN_PROPUESTA');
        expect(sinPropuesta.descartes.ASOCIACION_REPETIDA_TEMPORADA).toBe(1);
    });

    test('CASO 20: Nacional con pocos candidatos A se resuelve antes que Provincial con muchos A/B', () => {
        // Nacional: solo 1 candidato válido (jNac). Provincial: 3 candidatos válidos.
        // El orden de dificultad debe proteger el recurso escaso (jNac) para el Nacional
        // aunque también fuera elegible (categoría A) para el Provincial.
        const fecha = '2026-09-05';
        const jNac = jurado('jNac', { categoria: 'A', comunaTexto: 'ComunaJurado' });
        const jProv1 = jurado('jProv1', { categoria: 'B', comunaTexto: 'ComunaJurado' });
        const jProv2 = jurado('jProv2', { categoria: 'B', comunaTexto: 'ComunaJurado' });
        const rNac = rodeoInterno('rNac', { fecha, clasificacion_codigo: 'nacional', asociacion: 'AsocNac', comunaObj: COMUNA_RODEO_DEFAULT });
        const rProv = rodeoInterno('rProv', { fecha, clasificacion_codigo: 'provincial', asociacion: 'AsocProv', comunaObj: COMUNA_RODEO_DEFAULT });
        const res = ejecutarSimulacion(contexto({
            rodeos: [rProv, rNac], // orden de entrada intencionalmente "al revés"
            jurados: [jNac, jProv1, jProv2],
            disponibilidadPorJurado: { jNac: rangoFechas(fecha, 1), jProv1: rangoFechas(fecha, 1), jProv2: rangoFechas(fecha, 1) },
            comunas: [COMUNA_RODEO_DEFAULT, COMUNA_JURADO_DEFAULT]
        }));
        const resNac = res.resultados.find(r => r.rodeo_id === 'rNac');
        expect(resNac.estado).toBe('PROPUESTO');
        expect(resNac.jurado_propuesto.jurado_id).toBe('jNac');
    });
});

describe('Motor — NO_EVALUABLE (CASO 16-18)', () => {
    test('CASO 16: rodeo sin comuna → NO_EVALUABLE', () => {
        const r = rodeoInterno('r1', { fecha: '2026-09-05', comunaObj: null });
        const res = ejecutarSimulacion(contexto({ rodeos: [r], jurados: [] }));
        expect(res.resultados[0].estado).toBe('NO_EVALUABLE');
        expect(res.resultados[0].causa).toBe('RODEO_SIN_COMUNA');
    });

    test('CASO 17: tipo sin clasificación → NO_EVALUABLE', () => {
        const r = rodeoInterno('r1', { fecha: '2026-09-05', clasificacion_codigo: null, comunaObj: COMUNA_RODEO_DEFAULT });
        const res = ejecutarSimulacion(contexto({ rodeos: [r], jurados: [], comunas: [COMUNA_RODEO_DEFAULT] }));
        expect(res.resultados[0].estado).toBe('NO_EVALUABLE');
        expect(res.resultados[0].causa).toBe('TIPO_SIN_CLASIFICACION');
    });

    test('extra: rodeo con fecha fuera del rango de la temporada activa → NO_EVALUABLE', () => {
        // Caso real detectado en producción: hay rodeos con fecha ANTES del
        // inicio de la temporada 2026-2027 (15/04/2026).
        const r = rodeoInterno('r1', { fecha: '2026-04-03', comunaObj: COMUNA_RODEO_DEFAULT });
        const res = ejecutarSimulacion(contexto({ rodeos: [r], jurados: [], comunas: [COMUNA_RODEO_DEFAULT] }));
        expect(res.resultados[0].estado).toBe('NO_EVALUABLE');
        expect(res.resultados[0].causa).toBe('RODEO_FUERA_DE_TEMPORADA');
    });

    test('CASO 18: jurado sin comuna resolvible → descartado (no NO_EVALUABLE del rodeo)', () => {
        const fecha = '2026-09-05';
        const j = jurado('j1', { categoria: 'A', comunaTexto: null }); // sin comuna
        const r = rodeoInterno('r1', { fecha, clasificacion_codigo: 'nacional', comunaObj: COMUNA_RODEO_DEFAULT });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [j],
            disponibilidadPorJurado: { j1: rangoFechas(fecha, 1) },
            comunas: [COMUNA_RODEO_DEFAULT]
        }));
        expect(res.resultados[0].estado).toBe('SIN_PROPUESTA');
        expect(res.resultados[0].descartes.JURADO_SIN_COMUNA_RESOLVIBLE).toBe(1);
    });
});

describe('Motor — alias de comuna (CASO 19)', () => {
    test('CASO 19: jurado con comuna en alias → distancia calculada usando la comuna canónica', () => {
        const fecha = '2026-09-05';
        const comunaCanonica = comuna(latADistancia(-30, 50), -70, 'San Vicente');
        const comunaR = comuna(-30, -70, 'ComunaR19');
        const j = jurado('j1', { categoria: 'A', comunaTexto: 'San Vicente de Tagua Tagua' }); // texto = alias, no el nombre canónico
        const r = rodeoInterno('r1', { fecha, clasificacion_codigo: 'nacional', comunaObj: comunaR });
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [j],
            disponibilidadPorJurado: { j1: rangoFechas(fecha, 1) },
            comunas: [comunaCanonica, comunaR],
            alias: [{ alias_normalizado: 'san vicente de tagua tagua', comuna_id: comunaCanonica.id }]
        }));
        expect(res.resultados[0].estado).toBe('PROPUESTO');
        expect(res.resultados[0].jurado_propuesto.origen_comuna).toBe('ALIAS');
        expect(res.resultados[0].jurado_propuesto.comuna_canonica).toBe('San Vicente');
        expect(res.resultados[0].jurado_propuesto.distancia_km).toBeCloseTo(50, 0);
    });
});

describe('Motor — Etapa 3.1: dificultad REAL (no superficial por categoría)', () => {
    test('protege el rodeo realmente escaso aunque ambos rodeos sean de la misma clasificación (y por tanto empaten en el conteo superficial por categoría)', () => {
        // rAbundante y rEscaso son AMBOS "provincial" → el conteo superficial
        // antiguo (jurados.filter(cat in elegibles)) daría el MISMO número para
        // los dos (depende solo de la clasificación, no del rodeo concreto) y
        // el desempate caería en fecha: rAbundante (antes) se procesaría primero,
        // "usándose" a R por equidad, y rEscaso quedaría en 0 candidatos
        // (S y T están a >600 km de rEscaso). El algoritmo real (Etapa 3.1)
        // debe detectar que rEscaso solo tiene 1 candidato real (R) y procesarlo
        // PRIMERO, dejando S/T disponibles para rAbundante.
        const comunaAbundante = comuna(-30, -70, 'ComunaAbundante');
        const comunaEscaso = comuna(latADistancia(-30, 650), -70, 'ComunaEscaso'); // 650 km al sur
        const comunaR = comuna(latADistancia(-30, 325), -70, 'ComunaR'); // 325 km de ambos rodeos

        const R = jurado('R', { categoria: 'B', asociacion: 'Otra', comunaTexto: 'ComunaR' });
        const S = jurado('S', { categoria: 'B', asociacion: 'Otra', comunaTexto: 'ComunaAbundante' });
        const T = jurado('T', { categoria: 'B', asociacion: 'Otra', comunaTexto: 'ComunaAbundante' });

        const rAbundante = rodeoInterno('rAbundante', { fecha: '2026-09-05', clasificacion_codigo: 'provincial', asociacion: 'AsocCompartida', comunaObj: comunaAbundante });
        const rEscaso = rodeoInterno('rEscaso', { fecha: '2026-11-14', clasificacion_codigo: 'provincial', asociacion: 'AsocCompartida', comunaObj: comunaEscaso });

        // S y T ya tienen 1 designación histórica cada uno (en OTRA asociación,
        // no "AsocCompartida") — R parte en 0. Esto es lo que haría que, si
        // rAbundante se procesara primero, la equidad elija a R (0 < 1) y
        // "AsocCompartida" quede usada, bloqueando a R para rEscaso.
        const asignacionesTemporada = [
            { usuario_pagado_id: 'S', rodeo_id: 'hist-S', rodeos: { fecha: '2026-05-10', duracion_dias: 1, asociacion: 'AsocHistorica' } },
            { usuario_pagado_id: 'T', rodeo_id: 'hist-T', rodeos: { fecha: '2026-05-10', duracion_dias: 1, asociacion: 'AsocHistorica' } }
        ];

        const res = ejecutarSimulacion(contexto({
            rodeos: [rAbundante, rEscaso], jurados: [R, S, T],
            disponibilidadPorJurado: {
                R: [...rangoFechas('2026-09-05', 1), ...rangoFechas('2026-11-14', 1)],
                S: [...rangoFechas('2026-09-05', 1), ...rangoFechas('2026-11-14', 1)],
                T: [...rangoFechas('2026-09-05', 1), ...rangoFechas('2026-11-14', 1)]
            },
            asignacionesTemporada,
            comunas: [comunaAbundante, comunaEscaso, comunaR]
        }));

        const resEscaso = res.resultados.find(r => r.rodeo_id === 'rEscaso');
        const resAbundante = res.resultados.find(r => r.rodeo_id === 'rAbundante');

        // Con el algoritmo antiguo (superficial) esto habría dado SIN_PROPUESTA
        // para rEscaso. Con la dificultad real, ambos deben quedar PROPUESTOS.
        expect(resEscaso.estado).toBe('PROPUESTO');
        expect(resEscaso.jurado_propuesto.jurado_id).toBe('R');
        expect(resAbundante.estado).toBe('PROPUESTO');
        expect(['S', 'T']).toContain(resAbundante.jurado_propuesto.jurado_id);

        // El campo de auditoría debe reflejar la dificultad real, no la superficial:
        // rEscaso tenía candidatos_potenciales_bd = 1 (mucho menor que rAbundante = 3).
        expect(resEscaso.candidatos_potenciales_bd).toBe(1);
        expect(resAbundante.candidatos_potenciales_bd).toBe(3);
    });
});

describe('Motor — Etapa 3.1: asignaciones rechazadas NO cuentan como efectivas (CASO A-H)', () => {
    // Mismo criterio único usado por cargarDatosMotor(): filtra la lista cruda
    // de asignaciones con esAsignacionEfectiva() antes de pasarla al motor —
    // así los tests E-H ejercitan exactamente la misma función que usa la
    // carga real de datos, no una reimplementación paralela.
    const filtrarEfectivas = (rows) => rows.filter(esAsignacionEfectiva);

    test('CASO A: asignación activa + pendiente → cuenta', () => {
        expect(esAsignacionEfectiva({ estado: 'activo', estado_designacion: 'pendiente' })).toBe(true);
    });
    test('CASO B: asignación activa + aceptada → cuenta', () => {
        expect(esAsignacionEfectiva({ estado: 'activo', estado_designacion: 'aceptado' })).toBe(true);
    });
    test('CASO C: asignación activa + estado_designacion NULL → cuenta (legacy)', () => {
        expect(esAsignacionEfectiva({ estado: 'activo', estado_designacion: null })).toBe(true);
    });
    test('CASO D: asignación activa + rechazada → NO cuenta', () => {
        expect(esAsignacionEfectiva({ estado: 'activo', estado_designacion: 'rechazado' })).toBe(false);
    });
    test('CASO H: asignación anulada → NO cuenta (sin importar estado_designacion)', () => {
        expect(esAsignacionEfectiva({ estado: 'anulado', estado_designacion: 'aceptado' })).toBe(false);
        expect(esAsignacionEfectiva({ estado: 'anulado', estado_designacion: null })).toBe(false);
    });

    test('CASO E: asignación rechazada en la misma asociación → NO bloquea volver a esa asociación', () => {
        const fecha = '2026-09-05';
        const j = jurado('j1', { categoria: 'A', comunaTexto: 'ComunaJurado' });
        const r = rodeoInterno('r1', { fecha, clasificacion_codigo: 'nacional', asociacion: 'AsocX', comunaObj: COMUNA_RODEO_DEFAULT });
        const rawAsignaciones = [
            { usuario_pagado_id: 'j1', rodeo_id: 'hist-rechazada', estado: 'activo', estado_designacion: 'rechazado',
              rodeos: { fecha: '2026-05-01', duracion_dias: 1, asociacion: 'AsocX' } }
        ];
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [j],
            disponibilidadPorJurado: { j1: rangoFechas(fecha, 1) },
            asignacionesTemporada: filtrarEfectivas(rawAsignaciones), // → [] (la rechazada queda fuera)
            comunas: [COMUNA_RODEO_DEFAULT, COMUNA_JURADO_DEFAULT]
        }));
        expect(res.resultados[0].estado).toBe('PROPUESTO');
        expect(res.resultados[0].jurado_propuesto.jurado_id).toBe('j1');
        expect(res.resultados[0].jurado_propuesto.checks.no_repite_asociacion).toBe(true);
    });

    test('CASO F: asignación rechazada el mismo fin de semana → NO bloquea ese fin de semana', () => {
        const fecha = '2026-09-05'; // sábado
        const j = jurado('j1', { categoria: 'A', comunaTexto: 'ComunaJurado' });
        const r = rodeoInterno('r1', { fecha, clasificacion_codigo: 'nacional', asociacion: 'Otra', comunaObj: COMUNA_RODEO_DEFAULT });
        const rawAsignaciones = [
            { usuario_pagado_id: 'j1', rodeo_id: 'hist-rechazada-finde', estado: 'activo', estado_designacion: 'rechazado',
              rodeos: { fecha: '2026-09-06', duracion_dias: 1, asociacion: 'Distinta' } } // domingo, mismo bloque
        ];
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [j],
            disponibilidadPorJurado: { j1: rangoFechas(fecha, 1) },
            asignacionesTemporada: filtrarEfectivas(rawAsignaciones),
            comunas: [COMUNA_RODEO_DEFAULT, COMUNA_JURADO_DEFAULT]
        }));
        expect(res.resultados[0].estado).toBe('PROPUESTO');
        expect(res.resultados[0].jurado_propuesto.checks.sin_rodeo_mismo_finde).toBe(true);
    });

    test('CASO G: asignación rechazada el fin de semana anterior → NO genera consecutividad', () => {
        const fechaAnterior = '2026-09-05';
        const fechaActual = '2026-09-12';
        const j = jurado('j1', { categoria: 'A', comunaTexto: 'ComunaJurado' });
        const r = rodeoInterno('r1', { fecha: fechaActual, asociacion: 'Otra', clasificacion_codigo: 'nacional', comunaObj: COMUNA_RODEO_DEFAULT });
        const rawAsignaciones = [
            { usuario_pagado_id: 'j1', rodeo_id: 'hist-rechazada-previo', estado: 'activo', estado_designacion: 'rechazado',
              rodeos: { fecha: fechaAnterior, duracion_dias: 1, asociacion: 'Distinta' } }
        ];
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [j],
            disponibilidadPorJurado: { j1: rangoFechas(fechaActual, 1) },
            asignacionesTemporada: filtrarEfectivas(rawAsignaciones),
            comunas: [COMUNA_RODEO_DEFAULT, COMUNA_JURADO_DEFAULT]
        }));
        expect(res.resultados[0].estado).toBe('PROPUESTO');
        expect(res.resultados[0].jurado_propuesto.checks.sin_finde_consecutivo).toBe(true);
    });

    test('control positivo: la MISMA asignación pero ACEPTADA sí debe seguir bloqueando (confirma que el filtro es específico de "rechazado", no de cualquier historial)', () => {
        const fecha = '2026-09-05';
        const j = jurado('j1', { categoria: 'A', comunaTexto: 'ComunaJurado' });
        const r = rodeoInterno('r1', { fecha, clasificacion_codigo: 'nacional', asociacion: 'AsocX', comunaObj: COMUNA_RODEO_DEFAULT });
        const rawAsignaciones = [
            { usuario_pagado_id: 'j1', rodeo_id: 'hist-aceptada', estado: 'activo', estado_designacion: 'aceptado',
              rodeos: { fecha: '2026-05-01', duracion_dias: 1, asociacion: 'AsocX' } }
        ];
        const res = ejecutarSimulacion(contexto({
            rodeos: [r], jurados: [j],
            disponibilidadPorJurado: { j1: rangoFechas(fecha, 1) },
            asignacionesTemporada: filtrarEfectivas(rawAsignaciones), // aceptada → SÍ pasa el filtro
            comunas: [COMUNA_RODEO_DEFAULT, COMUNA_JURADO_DEFAULT]
        }));
        expect(res.resultados[0].estado).toBe('SIN_PROPUESTA');
        expect(res.resultados[0].descartes.ASOCIACION_REPETIDA_TEMPORADA).toBe(1);
    });
});

describe('Motor — determinismo (CASO 21)', () => {
    test('CASO 21: repetir la misma simulación con los mismos datos produce exactamente el mismo resultado', () => {
        const fecha = '2026-09-05';
        const jA = jurado('jA', { categoria: 'B', comunaTexto: 'ComunaJurado' });
        const jB = jurado('jB', { categoria: 'B', comunaTexto: 'ComunaJurado' });
        const r = rodeoInterno('r1', { fecha, clasificacion_codigo: 'provincial', comunaObj: COMUNA_RODEO_DEFAULT });
        const construir = () => ejecutarSimulacion(contexto({
            rodeos: [rodeoInterno('r1', { fecha, clasificacion_codigo: 'provincial', comunaObj: COMUNA_RODEO_DEFAULT })],
            jurados: [jurado('jA', { categoria: 'B', comunaTexto: 'ComunaJurado' }), jurado('jB', { categoria: 'B', comunaTexto: 'ComunaJurado' })],
            disponibilidadPorJurado: { jA: rangoFechas(fecha, 1), jB: rangoFechas(fecha, 1) },
            comunas: [COMUNA_RODEO_DEFAULT, COMUNA_JURADO_DEFAULT]
        }));
        const res1 = construir();
        const res2 = construir();
        expect(JSON.stringify(res1)).toBe(JSON.stringify(res2));
    });
});

describe('Motor — Etapa 3.1: buscador "rodeos sin jurado efectivo" (CASO 1-7)', () => {
    // Mismos rodeos de prueba, solo cambian las asignaciones ya existentes.
    const rodeos = [{ id: 'r1' }, { id: 'r2' }];

    test('CASO 1: rodeo sin ninguna asignación → aparece', () => {
        const res = filtrarRodeosSinJuradoEfectivo(rodeos, []);
        expect(res.map(r => r.id)).toEqual(['r1', 'r2']);
    });

    test('CASO 2: rodeo con asignación activa + pendiente → NO aparece', () => {
        const asigs = [{ rodeo_id: 'r1', estado: 'activo', estado_designacion: 'pendiente' }];
        const res = filtrarRodeosSinJuradoEfectivo(rodeos, asigs);
        expect(res.map(r => r.id)).toEqual(['r2']);
    });

    test('CASO 3: rodeo con asignación activa + aceptada → NO aparece', () => {
        const asigs = [{ rodeo_id: 'r1', estado: 'activo', estado_designacion: 'aceptado' }];
        const res = filtrarRodeosSinJuradoEfectivo(rodeos, asigs);
        expect(res.map(r => r.id)).toEqual(['r2']);
    });

    test('CASO 4: rodeo con asignación activa + estado_designacion NULL (legacy) → NO aparece', () => {
        const asigs = [{ rodeo_id: 'r1', estado: 'activo', estado_designacion: null }];
        const res = filtrarRodeosSinJuradoEfectivo(rodeos, asigs);
        expect(res.map(r => r.id)).toEqual(['r2']);
    });

    test('CASO 5: rodeo solo con asignación rechazada → aparece', () => {
        const asigs = [{ rodeo_id: 'r1', estado: 'activo', estado_designacion: 'rechazado' }];
        const res = filtrarRodeosSinJuradoEfectivo(rodeos, asigs);
        expect(res.map(r => r.id)).toEqual(['r1', 'r2']);
    });

    test('CASO 6: rodeo solo con asignación anulada → aparece', () => {
        const asigs = [{ rodeo_id: 'r1', estado: 'anulado', estado_designacion: 'aceptado' }];
        const res = filtrarRodeosSinJuradoEfectivo(rodeos, asigs);
        expect(res.map(r => r.id)).toEqual(['r1', 'r2']);
    });

    test('CASO 7: rodeo con una rechazada y otra efectiva → NO aparece', () => {
        const asigs = [
            { rodeo_id: 'r1', estado: 'activo', estado_designacion: 'rechazado' },
            { rodeo_id: 'r1', estado: 'activo', estado_designacion: 'pendiente' }
        ];
        const res = filtrarRodeosSinJuradoEfectivo(rodeos, asigs);
        expect(res.map(r => r.id)).toEqual(['r2']);
    });
});
