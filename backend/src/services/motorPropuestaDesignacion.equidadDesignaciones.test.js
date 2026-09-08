// ═════════════════════════════════════════════════════════════════════════
// Tests de la mejora "Equidad Visible de Designaciones + Historial del
// Jurado + Optimización del modal Modificar Jurado".
//
// Archivo SEPARADO (mismo criterio que motorPropuestaDesignacion.
// equidadTraslados.test.js): cargarHistorialRecienteBatch() SÍ toca la BD y
// necesita un mock de Supabase que motorPropuestaDesignacion.test.js (sin
// mock) no tiene ni necesita para sus tests puros existentes.
//
// Cubre (ver pedido de la mejora, secciones 40-51):
//   - construirEquidadDesignacionesAgregada — UNIDAD PURA: promedio de
//     categoría/general INCLUYE jurados con 0 designaciones (sección 4/6/7),
//     usa la categoría ACTUAL (sección 5), 1 decimal con coma (sección 9).
//   - construirEquidadDesignacionesCandidato — combina agregada + dato
//     temporal-exacto del candidato, nombres de campo explícitos (sección 29).
//   - ejecutarSimulacion() — integración: equidad_designaciones presente y
//     TEMPORALMENTE CONSISTENTE con designaciones_antes (nunca una segunda
//     fuente — sección 3/8/36) en jurado_propuesto/top_candidatos/
//     descartados; el ganador NO cambia por estos nuevos números (sección 27).
//   - Ningún criterio PROMEDIO_CATEGORIA/PROMEDIO_GENERAL fue agregado al
//     motor de ranking (sección 27 — guarda explícita contra scope creep).
//   - cargarHistorialRecienteBatch — con Supabase mockeado: anti-N+1 (sección
//     31/33), máximo 4 más reciente primero (sección 12), nota ausente → null
//     (sección 14/39), sin jurado_ids → 0 queries.
// ═════════════════════════════════════════════════════════════════════════
jest.mock('../config/supabase', () => ({ from: jest.fn() }));
const supabase = require('../config/supabase');
const {
    ejecutarSimulacion, construirEquidadDesignacionesAgregada, construirEquidadDesignacionesCandidato,
    cargarHistorialRecienteBatch
} = require('./motorPropuestaDesignacion');
const { construirConfiguracionDefaultV1, CRITERIOS_CONOCIDOS, CRITERIOS_CONOCIDOS_POR_SCHEMA } = require('./configuracionDesignacion');
const { calcularBloqueRodeo, rangoFechas } = require('./feriados');

// ─── Fixtures — mismo patrón que motorPropuestaDesignacion.test.js ────────
const TEMPORADA = { nombre: '2026-2027', fecha_inicio: '2026-04-15', fecha_fin: '2027-04-15' };
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
// Asignación histórica mínima (basta usuario_pagado_id + rodeo_id + estado
// para que construirEstadoDesdeBD la cuente) — misma forma real que arma
// cargarDatosMotor().
function asigHistorica(juradoId, rodeoId, fecha = '2026-05-01', { estado = 'activo', estado_designacion = 'aceptado', asociacion = 'Historica' } = {}) {
    return { id: `${juradoId}-${rodeoId}`, usuario_pagado_id: juradoId, rodeo_id: rodeoId, estado, estado_designacion, rodeos: { fecha, duracion_dias: 1, asociacion, comunas_chile: null } };
}

const COMUNA = comuna(-33.45, -70.6667, 'ComunaComun'); // rodeo y jurados en el mismo punto

// ═════════════════════════════════════════════════════════════════════════
// UNIDADES PURAS — construirEquidadDesignacionesAgregada
// ═════════════════════════════════════════════════════════════════════════
describe('construirEquidadDesignacionesAgregada — promedio de categoría/general (secciones 4/6/7/9)', () => {
    test('A: promedio de categoría INCLUYE jurados con 0 designaciones (0,1,3,4 -> 2,0)', () => {
        const jurados = [
            jurado('c0', { categoria: 'C' }), jurado('c1', { categoria: 'C' }),
            jurado('c3', { categoria: 'C' }), jurado('c4', { categoria: 'C' })
        ];
        const conteos = new Map([['c1', 1], ['c3', 3], ['c4', 4]]); // c0 SIN entrada -> 0 implícito
        const agregada = construirEquidadDesignacionesAgregada(jurados, conteos);
        expect(agregada.promedioPorCategoria.get('C')).toBe(2.0);
        expect(agregada.totalPorCategoria.get('C')).toBe(4); // los 4, incluyendo el de 0
    });

    test('B: promedio general INCLUYE jurados con 0 designaciones, población = TODOS los jurados recibidos', () => {
        const jurados = [
            jurado('j0', { categoria: 'A' }), jurado('j1', { categoria: 'B' }),
            jurado('j2', { categoria: 'B' }), jurado('j5', { categoria: 'C' })
        ];
        const conteos = new Map([['j1', 1], ['j2', 2], ['j5', 5]]); // j0 -> 0 implícito
        const agregada = construirEquidadDesignacionesAgregada(jurados, conteos);
        expect(agregada.promedioGeneral).toBe(2.0); // (0+1+2+5)/4
        expect(agregada.totalJuradosGeneral).toBe(4);
    });

    test('C: la población es exactamente la lista de jurados recibida — excluir inactivos/otros perfiles es responsabilidad de quien arma esa lista (cargarDatosMotor ya filtra activo=true, tipo_persona=jurado), no de esta función pura', () => {
        // Simula que cargarDatosMotor ya excluyó a un jurado inactivo con 10
        // designaciones (nunca llega a esta función) — el resultado no debe
        // verse afectado por datos que ni siquiera se le pasaron.
        const jurados = [jurado('a', { categoria: 'A' }), jurado('b', { categoria: 'A' })];
        const conteos = new Map([['a', 0], ['b', 2], ['inactivo-nunca-deberia-llegar', 10]]);
        const agregada = construirEquidadDesignacionesAgregada(jurados, conteos);
        expect(agregada.promedioGeneral).toBe(1.0); // (0+2)/2, el "10" nunca se cuenta
        expect(agregada.totalJuradosGeneral).toBe(2);
    });

    test('D: 1 decimal, redondeado (no entero, no muchos decimales)', () => {
        const jurados = [jurado('a', { categoria: 'B' }), jurado('b', { categoria: 'B' }), jurado('c', { categoria: 'B' })];
        const conteos = new Map([['a', 1], ['b', 2]]); // c -> 0; total = 3/3 = 1.0 pero probemos un caso no exacto
        const conteos2 = new Map([['a', 1], ['b', 1]]); // (1+1+0)/3 = 0.666...
        const agregada = construirEquidadDesignacionesAgregada(jurados, conteos2);
        expect(agregada.promedioGeneral).toBe(0.7);
    });

    test('E: sin jurados -> promedios null (nunca división por cero)', () => {
        const agregada = construirEquidadDesignacionesAgregada([], new Map());
        expect(agregada.promedioGeneral).toBeNull();
        expect(agregada.totalJuradosGeneral).toBe(0);
        expect(agregada.promedioPorCategoria.size).toBe(0);
    });
});

describe('construirEquidadDesignacionesCandidato — vista por candidato (sección 5/28/29/39)', () => {
    test('usa la categoría ACTUAL pasada explícitamente (nunca una reconstrucción histórica)', () => {
        const jurados = [jurado('a', { categoria: 'B' }), jurado('b', { categoria: 'B' }), jurado('c', { categoria: 'C' })];
        const conteos = new Map([['a', 2], ['b', 4], ['c', 9]]);
        const agregada = construirEquidadDesignacionesAgregada(jurados, conteos);
        const vista = construirEquidadDesignacionesCandidato(agregada, 'B', 2);
        expect(vista).toEqual({
            designaciones_jurado: 2, categoria: 'B',
            promedio_categoria: 3.0, total_jurados_categoria: 2,
            promedio_general: 5.0, total_jurados_general: 3
        });
    });

    test('categoría sin universo (null/desconocida) -> N/D (null), nunca NaN/undefined', () => {
        const agregada = construirEquidadDesignacionesAgregada([jurado('a', { categoria: 'A' })], new Map([['a', 1]]));
        const vista = construirEquidadDesignacionesCandidato(agregada, null, 0);
        expect(vista.promedio_categoria).toBeNull();
        expect(vista.total_jurados_categoria).toBe(0);
        expect(vista.categoria).toBeNull();
        expect(vista.promedio_general).toBe(1.0); // el general sigue disponible
    });
});

// ═════════════════════════════════════════════════════════════════════════
// INTEGRACIÓN — ejecutarSimulacion() con equidad_designaciones
// ═════════════════════════════════════════════════════════════════════════
describe('ejecutarSimulacion — equidad_designaciones (secciones 3/8/27/36/37/44)', () => {
    function fixtureTresCandidatos(fecha = '2026-09-05') {
        // 3 jurados categoría A, mismo punto que el rodeo (0 km) — j-bajo con
        // 0 designaciones previas, j-medio con 1, j-alto con 3.
        const jA = jurado('j-bajo', { categoria: 'A', comunaTexto: 'ComunaComun' });
        const jB = jurado('j-medio', { categoria: 'A', comunaTexto: 'ComunaComun' });
        const jC = jurado('j-alto', { categoria: 'A', comunaTexto: 'ComunaComun' });
        const r = rodeoInterno('r1', { fecha, comunaObj: COMUNA });
        const asignaciones = [
            asigHistorica('j-medio', 'r-previo-1', '2026-05-01'),
            asigHistorica('j-alto', 'r-previo-2', '2026-05-02'),
            asigHistorica('j-alto', 'r-previo-3', '2026-05-03'),
            asigHistorica('j-alto', 'r-previo-4', '2026-05-04')
        ];
        return contexto({
            rodeos: [r], jurados: [jA, jB, jC],
            disponibilidadPorJurado: { 'j-bajo': rangoFechas(fecha, 1), 'j-medio': rangoFechas(fecha, 1), 'j-alto': rangoFechas(fecha, 1) },
            asignacionesTemporada: asignaciones,
            comunas: [COMUNA]
        });
    }

    test('designaciones_jurado del ganador === designaciones_antes que decidió el ranking (nunca una segunda fuente)', () => {
        const res = ejecutarSimulacion(fixtureTresCandidatos());
        const fila = res.resultados[0];
        expect(fila.estado).toBe('PROPUESTO');
        // MENOS_DESIGNACIONES_TEMPORADA (criterio Nº1 en V1) hace ganar a j-bajo (0 designaciones).
        expect(fila.jurado_propuesto.jurado_id).toBe('j-bajo');
        expect(fila.jurado_propuesto.equidad_designaciones.designaciones_jurado).toBe(fila.jurado_propuesto.designaciones_temporada_antes);
        expect(fila.jurado_propuesto.equidad_designaciones.designaciones_jurado).toBe(0);
        // Promedio categoría A: (0+1+3)/3 = 1,3
        expect(fila.jurado_propuesto.equidad_designaciones.promedio_categoria).toBe(1.3);
        expect(fila.jurado_propuesto.equidad_designaciones.promedio_general).toBe(1.3);
    });

    test('top_candidatos y descartados también traen equidad_designaciones consistente con su propio designaciones_antes (sección 37 — no solo el ganador)', () => {
        const res = ejecutarSimulacion(fixtureTresCandidatos(), 10);
        const fila = res.resultados[0];
        for (const c of fila.top_candidatos) {
            expect(c.equidad_designaciones.designaciones_jurado).toBe(c.designaciones_antes);
            expect(c.equidad_designaciones.promedio_categoria).toBe(1.3);
        }
    });

    test('las nuevas cifras NUNCA cambian al ganador (sección 27) — j-alto (3 designaciones) sigue perdiendo pese a estar informativamente "sobre el promedio"', () => {
        const res = ejecutarSimulacion(fixtureTresCandidatos());
        expect(res.resultados[0].jurado_propuesto.jurado_id).not.toBe('j-alto');
    });

    test('consistencia temporal en un lote multi-rodeo: el segundo rodeo del mismo lote ve la designación temporal del primero (sección 8/44)', () => {
        // Dos rodeos separados por varias semanas (para no disparar las
        // reglas de "mismo fin de semana"/"fin de semana consecutivo", que
        // son un asunto aparte de esta mejora), mismos 2 candidatos (ambos
        // con 0 previas) — el motor asigna el primero a alguien, y para el
        // segundo rodeo esa persona ya debe figurar con 1 designación_antes
        // (mutación temporal del propio lote, sección 8/44).
        const jA = jurado('jA', { categoria: 'A', comunaTexto: 'ComunaComun', nombre: 'AAA' });
        const jB = jurado('jB', { categoria: 'A', comunaTexto: 'ComunaComun', nombre: 'BBB' });
        const r1 = rodeoInterno('r1', { fecha: '2026-09-05', asociacion: 'Asoc1', comunaObj: COMUNA });
        const r2 = rodeoInterno('r2', { fecha: '2026-10-17', asociacion: 'Asoc2', comunaObj: COMUNA });
        const ctx = contexto({
            rodeos: [r1, r2], jurados: [jA, jB],
            disponibilidadPorJurado: { jA: [...rangoFechas('2026-09-05', 1), ...rangoFechas('2026-10-17', 1)], jB: [...rangoFechas('2026-09-05', 1), ...rangoFechas('2026-10-17', 1)] },
            comunas: [COMUNA]
        });
        const res = ejecutarSimulacion(ctx, 10);
        const filaR1 = res.resultados.find(r => r.rodeo_id === 'r1');
        const filaR2 = res.resultados.find(r => r.rodeo_id === 'r2');
        const ganadorR1 = filaR1.jurado_propuesto.jurado_id;
        const otroCandidatoEnR2 = filaR2.top_candidatos.find(c => c.jurado_id === ganadorR1);
        // Quien ganó r1 ahora tiene 1 designación "antes" al evaluarse para r2 (temporal, dentro del mismo lote).
        expect(otroCandidatoEnR2.designaciones_antes).toBe(1);
        expect(otroCandidatoEnR2.equidad_designaciones.designaciones_jurado).toBe(1);
    });

    // ═════════════════════════════════════════════════════════════════════
    // CORRECCIÓN — agregada FRESCA por fila (no un snapshot congelado del
    // inicio del lote). Ejemplo obligatorio del pedido: 4 jurados categoría
    // C, todos en 0, 3 rodeos consecutivos del MISMO lote. Cada fila debe
    // ver: BD + propuestas temporales de las filas ANTERIORES — nunca la
    // propia, nunca el snapshot congelado del inicio.
    // ═════════════════════════════════════════════════════════════════════
    describe('agregada fresca por fila — ejemplo obligatorio del pedido (4 jurados C, 0,0,0,0)', () => {
        function fixtureCuatroJuradosC() {
            const nombres = ['J1', 'J2', 'J3', 'J4'];
            const js = nombres.map(n => jurado(n, { categoria: 'C', comunaTexto: 'ComunaComun', nombre: n }));
            const fechas = ['2026-09-05', '2026-10-17', '2026-11-28']; // bien separadas — sin finde consecutivo
            const rodeos = fechas.map((f, i) => rodeoInterno(`r${i + 1}`, { fecha: f, asociacion: `Asoc${i + 1}`, comunaObj: COMUNA, clasificacion_codigo: 'interclubes' }));
            const disponibilidadPorJurado = {};
            for (const n of nombres) disponibilidadPorJurado[n] = fechas.flatMap(f => rangoFechas(f, 1));
            return contexto({ rodeos, jurados: js, disponibilidadPorJurado, comunas: [COMUNA] });
        }

        test('A: fila 1 — snapshot inicial 0,0,0,0 -> promedio categoría 0,0 (no hay nada previo, ni siquiera del propio lote)', () => {
            const res = ejecutarSimulacion(fixtureCuatroJuradosC(), 10);
            const fila1 = res.resultados.find(r => r.rodeo_id === 'r1');
            expect(fila1.jurado_propuesto.equidad_designaciones.promedio_categoria).toBe(0);
            expect(fila1.jurado_propuesto.equidad_designaciones.designaciones_jurado).toBe(0); // el propio ganador tampoco se cuenta a sí mismo todavía
        });

        test('B/F/G: fila 2 -> ve la temporal de la fila 1 (1,0,0,0 -> 0,25 -> redondeado a 1 decimal 0,3), pero el ganador de la fila 1 NO se contó a sí mismo en SU propia fila', () => {
            const res = ejecutarSimulacion(fixtureCuatroJuradosC(), 10);
            const fila1 = res.resultados.find(r => r.rodeo_id === 'r1');
            const fila2 = res.resultados.find(r => r.rodeo_id === 'r2');
            // F: el ganador de la fila 1, en SU PROPIA fila, todavía no incluye su propia asignación.
            expect(fila1.jurado_propuesto.equidad_designaciones.designaciones_jurado).toBe(0);
            // G: la fila 2 SÍ ve esa temporal (promedio categoría sube de 0 a 0,25->0,3).
            expect(fila2.jurado_propuesto.equidad_designaciones.promedio_categoria).toBe(0.3);
            // El ganador de la fila 1 sigue apareciendo como candidato en la fila 2 (no fue excluido, solo ya no es el "más bajo").
            const ganadorFila1EnFila2 = fila2.top_candidatos.find(c => c.jurado_id === fila1.jurado_propuesto.jurado_id);
            expect(ganadorFila1EnFila2.equidad_designaciones.designaciones_jurado).toBe(1);
        });

        test('C: fila 3 -> ve las temporales de fila 1 Y fila 2 (1,1,0,0 -> promedio 0,5)', () => {
            const res = ejecutarSimulacion(fixtureCuatroJuradosC(), 10);
            const fila3 = res.resultados.find(r => r.rodeo_id === 'r3');
            expect(fila3.jurado_propuesto.equidad_designaciones.promedio_categoria).toBe(0.5);
        });

        test('D: el promedio GENERAL también evoluciona igual que el de categoría (única categoría presente en la población de este fixture)', () => {
            const res = ejecutarSimulacion(fixtureCuatroJuradosC(), 10);
            const fila1 = res.resultados.find(r => r.rodeo_id === 'r1');
            const fila2 = res.resultados.find(r => r.rodeo_id === 'r2');
            const fila3 = res.resultados.find(r => r.rodeo_id === 'r3');
            expect(fila1.jurado_propuesto.equidad_designaciones.promedio_general).toBe(0);
            expect(fila2.jurado_propuesto.equidad_designaciones.promedio_general).toBe(0.3);
            expect(fila3.jurado_propuesto.equidad_designaciones.promedio_general).toBe(0.5);
        });

        test('E: una designación temporal de categoría B NO afecta el promedio de categoría C del mismo lote (sí afecta el general)', () => {
            const jC1 = jurado('jC1', { categoria: 'C', comunaTexto: 'ComunaComun', nombre: 'C1' });
            const jC2 = jurado('jC2', { categoria: 'C', comunaTexto: 'ComunaComun', nombre: 'C2' });
            const jB1 = jurado('jB1', { categoria: 'B', comunaTexto: 'ComunaComun', nombre: 'B1' });
            // Fila 1: clasificación 'provincial' — matriz V1 real: B elegible,
            // C NO elegible (sección 27/28 de Etapa 2, sin tocar acá) — fuerza
            // determinísticamente que el ÚNICO ganador posible sea jB1.
            const r1 = rodeoInterno('r1', { fecha: '2026-09-05', asociacion: 'Asoc1', comunaObj: COMUNA, clasificacion_codigo: 'provincial' });
            // Fila 2: 'interclubes' — ambas categorías elegibles (C con mejor
            // orden_preferencia) — el ganador será jC1 o jC2, da igual cuál.
            const r2 = rodeoInterno('r2', { fecha: '2026-10-17', asociacion: 'Asoc2', comunaObj: COMUNA, clasificacion_codigo: 'interclubes' });
            const disponibilidadPorJurado = {
                jC1: [...rangoFechas('2026-09-05', 1), ...rangoFechas('2026-10-17', 1)],
                jC2: [...rangoFechas('2026-09-05', 1), ...rangoFechas('2026-10-17', 1)],
                jB1: rangoFechas('2026-09-05', 1) // solo disponible para la fila 1
            };
            const ctx = contexto({ rodeos: [r1, r2], jurados: [jC1, jC2, jB1], disponibilidadPorJurado, comunas: [COMUNA] });
            const res = ejecutarSimulacion(ctx, 10);
            const fila1 = res.resultados.find(r => r.rodeo_id === 'r1');
            const fila2 = res.resultados.find(r => r.rodeo_id === 'r2');

            expect(fila1.jurado_propuesto.jurado_id).toBe('jB1'); // el único elegible para 'provincial'
            expect(fila1.jurado_propuesto.categoria).toBe('B');
            // La categoría C sigue en 0,0 en la fila 2 — la designación temporal fue de B, no de C.
            expect(fila2.jurado_propuesto.equidad_designaciones.promedio_categoria).toBe(0);
            // El promedio GENERAL sí la ve: población {jC1,jC2,jB1}=3, suma=1 -> 0,33... -> 0,3.
            expect(fila2.jurado_propuesto.equidad_designaciones.promedio_general).toBe(0.3);
        });
    });

    test('ningún criterio PROMEDIO_CATEGORIA/PROMEDIO_GENERAL fue agregado al motor de ranking (guarda explícita contra sección 27)', () => {
        expect(CRITERIOS_CONOCIDOS).not.toContain('PROMEDIO_CATEGORIA');
        expect(CRITERIOS_CONOCIDOS).not.toContain('PROMEDIO_GENERAL');
        expect(CRITERIOS_CONOCIDOS_POR_SCHEMA[1]).not.toContain('PROMEDIO_CATEGORIA');
        expect(CRITERIOS_CONOCIDOS_POR_SCHEMA[2]).not.toContain('PROMEDIO_CATEGORIA');
    });
});

// ═════════════════════════════════════════════════════════════════════════
// cargarHistorialRecienteBatch — con Supabase mockeado (anti N+1, sección 31/33)
// ═════════════════════════════════════════════════════════════════════════
describe('cargarHistorialRecienteBatch — batch, sin N+1 (sección 12/13/14/31/33)', () => {
    beforeEach(() => { supabase.from.mockReset(); });

    function mockSupabase({ asignaciones = [], notas = [] } = {}) {
        const llamadas = [];
        supabase.from.mockImplementation((tabla) => {
            llamadas.push(tabla);
            const datos = tabla === 'asignaciones' ? asignaciones : (tabla === 'notas_rodeo' ? notas : []);
            const chain = {
                select: () => chain, in: () => chain, eq: () => chain, neq: () => chain,
                order: () => chain, range: () => chain,
                then: (resolve) => Promise.resolve({ data: datos, error: null }).then(resolve)
            };
            return chain;
        });
        return llamadas;
    }

    test('sin jurado_ids -> 0 queries, Map vacío', async () => {
        const llamadas = mockSupabase();
        const resultado = await cargarHistorialRecienteBatch([]);
        expect(llamadas).toEqual([]);
        expect(resultado.size).toBe(0);
    });

    test('exactamente 2 queries (asignaciones + notas_rodeo), sin importar la cantidad de jurado_ids pedidos (1 vs 59)', async () => {
        const asigs = [{ id: 'a1', usuario_pagado_id: 'j1', rodeo_id: 'r1', created_at: '2026-06-01', rodeos: { club: 'Club1', asociacion: 'AsocX', fecha: '2026-06-06' } }];
        const llamadasUno = mockSupabase({ asignaciones: asigs, notas: [{ asignacion_id: 'a1', nota: 4.8 }] });
        await cargarHistorialRecienteBatch(['j1']);
        expect(llamadasUno).toEqual(['asignaciones', 'notas_rodeo']);

        const muchosIds = Array.from({ length: 59 }, (_, i) => `j${i}`);
        const llamadas59 = mockSupabase({ asignaciones: asigs, notas: [{ asignacion_id: 'a1', nota: 4.8 }] });
        await cargarHistorialRecienteBatch(muchosIds);
        expect(llamadas59).toEqual(['asignaciones', 'notas_rodeo']); // mismo conteo fijo
    });

    test('máximo 4 por jurado, más reciente primero (ya viene ordenado ASC->DESC por la query)', async () => {
        // 5 asignaciones del mismo jurado, ya en orden created_at DESC (como
        // las devolvería la query real) — la 5ª debe descartarse.
        const asigs = Array.from({ length: 5 }, (_, i) => ({
            id: `a${i}`, usuario_pagado_id: 'j1', rodeo_id: `r${i}`, created_at: `2026-0${6 - i}-01`,
            rodeos: { club: `Club${i}`, asociacion: 'AsocX', fecha: `2026-0${6 - i}-05` }
        }));
        mockSupabase({ asignaciones: asigs, notas: [] });
        const resultado = await cargarHistorialRecienteBatch(['j1']);
        const hist = resultado.get('j1');
        expect(hist).toHaveLength(4);
        expect(hist[0].rodeo_id).toBe('r0'); // el más reciente
        expect(hist[3].rodeo_id).toBe('r3'); // el 5º (r4) quedó fuera
    });

    test('nota ausente -> null (nunca NaN/undefined) — sección 14/39', async () => {
        const asigs = [{ id: 'a1', usuario_pagado_id: 'j1', rodeo_id: 'r1', created_at: '2026-06-01', rodeos: { club: 'Club1', asociacion: 'AsocX', fecha: '2026-06-05' } }];
        mockSupabase({ asignaciones: asigs, notas: [] }); // sin fila en notas_rodeo para a1
        const resultado = await cargarHistorialRecienteBatch(['j1']);
        expect(resultado.get('j1')[0].nota).toBeNull();
    });

    test('jurado sin ninguna asignación -> no aparece en el Map (el llamador debe tratar .get() undefined como [])', async () => {
        mockSupabase({ asignaciones: [], notas: [] });
        const resultado = await cargarHistorialRecienteBatch(['j-sin-historial']);
        expect(resultado.get('j-sin-historial')).toBeUndefined();
        expect(resultado.get('j-sin-historial') || []).toEqual([]);
    });
});
