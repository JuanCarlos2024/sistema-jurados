const {
    ejecutarSimulacionGlobal, resolverAsignacionGlobal, CAUSAS_RELAJABLES, CAUSAS_OBLIGATORIAS, ESTADOS_BUSQUEDA,
    calcularPesoPorClasificacion, costoRodeoAsignado, calcularCostoPrioridadDeportiva, resolverPrioridadDeportiva,
    NOTA_TECNICA_MAXIMA
} = require('./motorPropuestaDesignacionGlobal');
const { ejecutarSimulacion, construirUltimaFechaAsociacionPorJurado } = require('./motorPropuestaDesignacion');
const { construirConfiguracionDefaultV1, clonarConfiguracion } = require('./configuracionDesignacion');
const { calcularBloqueRodeo, rangoFechas } = require('./feriados');

// ─────────────────────────────────────────────────────────────────────────
// Fixtures — mismo patrón que motorPropuestaDesignacion.test.js (construyen
// el "contexto" tal como lo arma cargarDatosMotor(), sin tocar la BD).
// ─────────────────────────────────────────────────────────────────────────
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
function catalogoConComunas(comunas, alias = []) {
    return { comunas, alias };
}
function jurado(id, { categoria = 'A', asociacion = 'Asociación Base', comunaTexto = null, nombre = null } = {}) {
    return { id, nombre_completo: nombre || `Jurado ${id}`, categoria, asociacion, comuna: comunaTexto };
}
function rodeoInterno(id, { clasificacion_codigo = 'nacional', asociacion = 'Otra Asociación', fecha, duracion_dias = 1, comunaObj = null, estado = 'activo' }) {
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
    for (const [juradoId, fechas] of Object.entries(disponibilidadPorJurado)) {
        disponibilidad.set(juradoId, new Set(fechas));
    }
    return {
        idsSolicitados: rodeos.map(r => r.id),
        temporada, rodeosPorId, jurados,
        catalogoComunas: catalogoConComunas(comunas, alias),
        disponibilidad, asignacionesTemporada
    };
}

// ─────────────────────────────────────────────────────────────────────────
// Fixture central — un caso DOCUMENTADO de fallo del motor local (greedy)
// que el motor global SÍ resuelve, sin ceder ninguna preferencia.
//
//   Rodeo A: elegibles {j1, j2}  (excluye a j3 por "misma asociación")
//   Rodeo B: elegibles {j2, j3}  (excluye a j1 por "misma asociación")
//   Rodeo C: elegibles {j3}      (excluye a j1 por asociación, a j2 por distancia > 600km)
//
// Única asignación completa posible: A←j1, B←j2, C←j3. El greedy (hardest-
// first) resuelve C primero (forzado a j3), y luego A — donde j1/j2 empatan
// en categoría/designaciones y MENOR_DISTANCIA decide por j2 (más cerca) —
// dejando a B sin ningún candidato (j3 ocupado por C, j2 por A).
// ─────────────────────────────────────────────────────────────────────────
function construirCasoFalloGreedy() {
    const fecha = '2026-09-05'; // sábado

    const p0 = comuna(-30, -70, 'P0');                              // j2, A, B
    const p1 = comuna(latADistancia(-30, 100), -70, 'P1');          // j1 — 100km de P0
    const pj3 = comuna(latADistancia(-30, 350), -70, 'Pj3');        // j3 — 350km de P0
    const pc = comuna(latADistancia(-30, 700), -70, 'Pc');          // C — 700km de P0, 350km de Pj3

    const j1 = jurado('j1', { categoria: 'A', asociacion: 'AsocJ1', comunaTexto: 'P1' });
    const j2 = jurado('j2', { categoria: 'A', asociacion: 'AsocJ2', comunaTexto: 'P0' });
    const j3 = jurado('j3', { categoria: 'A', asociacion: 'AsocJ3', comunaTexto: 'Pj3' });

    const rodeoA = rodeoInterno('rodeoA', { fecha, asociacion: 'AsocJ3', comunaObj: p0 }); // excluye a j3
    const rodeoB = rodeoInterno('rodeoB', { fecha, asociacion: 'AsocJ1', comunaObj: p0 }); // excluye a j1
    const rodeoC = rodeoInterno('rodeoC', { fecha, asociacion: 'AsocJ1', comunaObj: pc }); // excluye a j1 (asoc) y a j2 (distancia)

    const ctx = contexto({
        rodeos: [rodeoA, rodeoB, rodeoC],
        jurados: [j1, j2, j3],
        disponibilidadPorJurado: {
            j1: rangoFechas(fecha, 1), j2: rangoFechas(fecha, 1), j3: rangoFechas(fecha, 1)
        },
        comunas: [p0, p1, pj3, pc]
    });
    return { ctx, config: construirConfiguracionDefaultV1() };
}

describe('Motor Global de Designaciones (Fase 2A/2B) — cobertura estricta', () => {
    test('[Aceptación 1] el motor LOCAL (greedy) deja un rodeo SIN_PROPUESTA aunque existe una asignación completa', () => {
        const { ctx, config } = construirCasoFalloGreedy();
        const res = ejecutarSimulacion(ctx, 5, config);

        const porId = new Map(res.resultados.map(r => [r.rodeo_id, r.estado]));
        expect(porId.get('rodeoC')).toBe('PROPUESTO');
        expect(porId.get('rodeoA')).toBe('PROPUESTO');
        expect(porId.get('rodeoB')).toBe('SIN_PROPUESTA');
        expect(res.resumen.sin_propuesta).toBe(1);
    });

    test('[Aceptación 1] el motor GLOBAL encuentra la asignación completa (3/3) para el mismo caso, sin ceder preferencias', () => {
        const { ctx, config } = construirCasoFalloGreedy();
        const res = ejecutarSimulacionGlobal(ctx, 5, config);

        expect(res.cobertura_completa).toBe(true);
        expect(res.optimizacion_global.estado_busqueda).toBe(ESTADOS_BUSQUEDA.COBERTURA_COMPLETA);
        expect(res.optimizacion_global.nivel_busqueda).toBe('ESTRICTO');
        expect(res.optimizacion_global.total_cupos).toBe(3);
        expect(res.optimizacion_global.cobertura_obtenida).toBe(3);
        expect(res.optimizacion_global.cupos_pendientes).toBe(0);
        expect(res.optimizacion_global.rodeos_recuperados).toEqual(['rodeoB']);
        expect(res.resumen.sin_propuesta).toBe(0);
        expect(res.resumen.propuestos).toBe(3);

        const porId = new Map(res.resultados.map(r => [r.rodeo_id, r]));
        expect(porId.get('rodeoA').jurado_propuesto.jurado_id).toBe('j1');
        expect(porId.get('rodeoB').jurado_propuesto.jurado_id).toBe('j2');
        expect(porId.get('rodeoC').jurado_propuesto.jurado_id).toBe('j3');

        // Marca correctamente cuál cambió respecto al criterio local (A, que
        // el greedy le habría dado a j2) y cuál no (C).
        expect(porId.get('rodeoA').jurado_propuesto.optimizacion_global_forzado).toBe(true);
        expect(porId.get('rodeoC').jurado_propuesto.optimizacion_global_forzado).toBe(false);
        // Nivel estricto — nunca se cedió ninguna preferencia.
        expect(porId.get('rodeoA').jurado_propuesto.optimizacion_global_relajaciones).toEqual([]);
        expect(res.optimizacion_global.advertencias).toEqual([]);
    });

    test('resolverAsignacionGlobal(), usado directamente, encuentra la misma asignación completa', () => {
        const { ctx, config } = construirCasoFalloGreedy();
        const rodeos = [...ctx.rodeosPorId.values()].map(r => ({ ...r, _matrizGlobal: { elegibles: new Set(['A']), ordenPorCategoria: new Map([['A', 1]]) } }));
        const res = resolverAsignacionGlobal(ctx, config, rodeos);

        expect(res.exito).toBe(true);
        expect(res.cobertura).toBe(3);
        expect(res.asignacion.get('rodeoA')).toBe('j1');
        expect(res.asignacion.get('rodeoB')).toBe('j2');
        expect(res.asignacion.get('rodeoC')).toBe('j3');
    });

    test('no se activa el motor global si el motor local ya cubre el 100% de los cupos', () => {
        const fecha = '2026-09-05';
        const p0 = comuna(-30, -70, 'Unica');
        const j1 = jurado('j1', { comunaTexto: 'Unica' });
        const j2 = jurado('j2', { comunaTexto: 'Unica' });
        const r1 = rodeoInterno('r1', { fecha, asociacion: 'OtraAsoc', comunaObj: p0 });
        const r2 = rodeoInterno('r2', { fecha: '2026-09-12', asociacion: 'OtraAsoc', comunaObj: p0 });
        const ctx = contexto({
            rodeos: [r1, r2], jurados: [j1, j2],
            disponibilidadPorJurado: { j1: rangoFechas(fecha, 1), j2: rangoFechas('2026-09-12', 1) },
            comunas: [p0]
        });
        const config = construirConfiguracionDefaultV1();

        const baseline = ejecutarSimulacion(ctx, 5, config);
        expect(baseline.resumen.sin_propuesta).toBe(0);

        const res = ejecutarSimulacionGlobal(ctx, 5, config);
        expect(res.cobertura_completa).toBe(true);
        expect(res.optimizacion_global.aplicada).toBe(false);
        expect(res.optimizacion_global.estado_busqueda).toBe(ESTADOS_BUSQUEDA.COBERTURA_COMPLETA);
        expect(res.optimizacion_global.motivo).toMatch(/ya cubre el 100%/);
        expect(res.resultados.map(r => r.estado)).toEqual(baseline.resultados.map(r => r.estado));
    });

    test('ejecutarSimulacion() sigue funcionando exactamente igual sin el 4º parámetro (compatibilidad Fase 1A/1B)', () => {
        const { ctx, config } = construirCasoFalloGreedy();
        const conOpciones = ejecutarSimulacion(ctx, 5, config, {});
        const sinOpciones = ejecutarSimulacion(ctx, 5, config);
        expect(conOpciones.resultados.map(r => r.estado)).toEqual(sinOpciones.resultados.map(r => r.estado));
        expect(sinOpciones.resultados.every(r => r.estado !== 'PROPUESTO' || r.jurado_propuesto.optimizacion_global_forzado === false)).toBe(true);
    });
});

describe('Motor Global — distinción restricciones OBLIGATORIAS vs preferencias FLEXIBLES', () => {
    test('restricciones y preferencias declaradas coinciden con las causas reales de evaluarCandidato()', () => {
        // ASOCIACION_REPETIDA_INTERVALO agregada por la mejora "Repetición de
        // Asociación por Intervalo" (schema_version=4) — mismo tipo de
        // actualización de expectativa que ya documentan los demás tests U.
        const TODAS = new Set(['DISPONIBILIDAD', 'MISMA_ASOCIACION', 'ASOCIACION_REPETIDA_TEMPORADA', 'ASOCIACION_REPETIDA_INTERVALO', 'FINDE_CONSECUTIVO', 'MISMO_FINDE', 'CATEGORIA_INCOMPATIBLE', 'JURADO_SIN_COMUNA_RESOLVIBLE', 'DISTANCIA_EXCEDIDA']);
        for (const c of CAUSAS_RELAJABLES) expect(TODAS.has(c)).toBe(true);
        for (const c of CAUSAS_OBLIGATORIAS) expect(TODAS.has(c)).toBe(true);
        // Ninguna causa real queda sin clasificar, y ninguna está en ambos lados.
        for (const c of TODAS) expect(CAUSAS_RELAJABLES.has(c) !== CAUSAS_OBLIGATORIAS.has(c)).toBe(true);
    });

    test('[Aceptación 2] un rodeo SOLO se cubre superando los 600 km — el motor global lo acepta cediendo DISTANCIA_EXCEDIDA', () => {
        const fecha = '2026-09-05';
        const pJurado = comuna(-30, -70, 'PJurado');
        const pRodeo = comuna(latADistancia(-30, 750), -70, 'PRodeo'); // 750km > 600km
        const j1 = jurado('j1', { comunaTexto: 'PJurado' });
        const r1 = rodeoInterno('r1', { fecha, asociacion: 'OtraAsoc', comunaObj: pRodeo });
        const ctx = contexto({
            rodeos: [r1], jurados: [j1],
            disponibilidadPorJurado: { j1: rangoFechas(fecha, 1) },
            comunas: [pJurado, pRodeo]
        });
        const config = construirConfiguracionDefaultV1();

        const baseline = ejecutarSimulacion(ctx, 5, config);
        expect(baseline.resultados[0].estado).toBe('SIN_PROPUESTA');
        expect(baseline.resultados[0].descartes.DISTANCIA_EXCEDIDA).toBe(1);

        const res = ejecutarSimulacionGlobal(ctx, 5, config);
        expect(res.cobertura_completa).toBe(true);
        expect(res.optimizacion_global.nivel_busqueda).toBe('PREFERENCIAS_RELAJADAS');
        expect(res.resultados[0].estado).toBe('PROPUESTO');
        expect(res.resultados[0].jurado_propuesto.jurado_id).toBe('j1');
        expect(res.resultados[0].jurado_propuesto.optimizacion_global_relajaciones).toEqual(['DISTANCIA_EXCEDIDA']);
        expect(res.optimizacion_global.advertencias).toEqual([
            expect.objectContaining({ rodeo_id: 'r1', jurado_id: 'j1', preferencias_cedidas: ['DISTANCIA_EXCEDIDA'] })
        ]);
    });

    test('[Aceptación 3] un rodeo SOLO se cubre permitiendo fin de semana consecutivo — nunca confundido con mismo fin de semana', () => {
        const fechaAnterior = '2026-09-05'; // sábado
        const fechaActual = '2026-09-12';   // sábado siguiente, sin feriado entre medio -> consecutivo
        const p0 = comuna(-30, -70, 'P0');
        const j1 = jurado('j1', { comunaTexto: 'P0' });
        const r1 = rodeoInterno('r1', { fecha: fechaActual, asociacion: 'OtraAsoc', comunaObj: p0 });
        const ctx = contexto({
            rodeos: [r1], jurados: [j1],
            disponibilidadPorJurado: { j1: rangoFechas(fechaActual, 1) },
            asignacionesTemporada: [{ usuario_pagado_id: 'j1', rodeo_id: 'r-previo', rodeos: { fecha: fechaAnterior, duracion_dias: 1, asociacion: 'Distinta' } }],
            comunas: [p0]
        });
        const config = construirConfiguracionDefaultV1();

        const baseline = ejecutarSimulacion(ctx, 5, config);
        expect(baseline.resultados[0].estado).toBe('SIN_PROPUESTA');
        expect(baseline.resultados[0].descartes.FINDE_CONSECUTIVO).toBe(1);

        const res = ejecutarSimulacionGlobal(ctx, 5, config);
        expect(res.cobertura_completa).toBe(true);
        expect(res.resultados[0].jurado_propuesto.jurado_id).toBe('j1');
        expect(res.resultados[0].jurado_propuesto.optimizacion_global_relajaciones).toEqual(['FINDE_CONSECUTIVO']);
    });

    test('[Aceptación 4] repetición de asociación necesaria para cobertura total — se cede sin tocar la asociación organizadora', () => {
        const fecha = '2026-09-05';
        const p0 = comuna(-30, -70, 'P0');
        const j1 = jurado('j1', { asociacion: 'AsocPropiaDeJ1', comunaTexto: 'P0' });
        const r1 = rodeoInterno('r1', { fecha, asociacion: 'AsocRepetida', comunaObj: p0 });
        const ctx = contexto({
            rodeos: [r1], jurados: [j1],
            disponibilidadPorJurado: { j1: rangoFechas(fecha, 1) },
            asignacionesTemporada: [{ usuario_pagado_id: 'j1', rodeo_id: 'r-previo', rodeos: { fecha: '2026-05-01', duracion_dias: 1, asociacion: 'AsocRepetida' } }],
            comunas: [p0]
        });
        const config = construirConfiguracionDefaultV1();

        const baseline = ejecutarSimulacion(ctx, 5, config);
        expect(baseline.resultados[0].estado).toBe('SIN_PROPUESTA');
        expect(baseline.resultados[0].descartes.ASOCIACION_REPETIDA_TEMPORADA).toBe(1);
        expect(baseline.resultados[0].descartes.MISMA_ASOCIACION).toBe(0); // nunca su propia asociación organizadora

        const res = ejecutarSimulacionGlobal(ctx, 5, config);
        expect(res.cobertura_completa).toBe(true);
        expect(res.resultados[0].jurado_propuesto.jurado_id).toBe('j1');
        expect(res.resultados[0].jurado_propuesto.optimizacion_global_relajaciones).toEqual(['ASOCIACION_REPETIDA_TEMPORADA']);
    });

    test('[Aceptación 5] conflicto REAL entre dos rodeos del mismo fin de semana — MISMO_FINDE nunca se relaja, ni cediendo todas las preferencias', () => {
        // Un solo jurado total — ni siquiera cediendo TODAS las preferencias
        // (distancia, repetición de asociación, finde consecutivo, comuna no
        // resoluble) puede estar físicamente en dos rodeos el mismo fin de
        // semana. (Con un 2º jurado disponible, cubrir el segundo rodeo
        // cediendo distancia sería la respuesta CORRECTA del motor global —
        // ver Aceptación 2 — por eso este caso usa un único jurado: así
        // MISMO_FINDE es la única causa posible, sin ninguna vía de escape.)
        const fecha = '2026-09-05';
        const pCerca = comuna(-30, -70, 'Cerca');
        const j1 = jurado('j1', { comunaTexto: 'Cerca' });
        const r1 = rodeoInterno('r1', { fecha, asociacion: 'Asoc1', comunaObj: pCerca });
        const r2 = rodeoInterno('r2', { fecha, asociacion: 'Asoc2', comunaObj: pCerca });
        const ctx = contexto({
            rodeos: [r1, r2], jurados: [j1],
            disponibilidadPorJurado: { j1: rangoFechas(fecha, 1) },
            comunas: [pCerca]
        });
        const config = construirConfiguracionDefaultV1();

        const res = ejecutarSimulacionGlobal(ctx, 5, config);
        expect(res.cobertura_completa).toBe(false);
        expect(res.optimizacion_global.estado_busqueda).toBe(ESTADOS_BUSQUEDA.INFACTIBLE_DEMOSTRADO);
        expect(res.optimizacion_global.cobertura_parcial_observada).toBe(1);
        expect(res.resumen.sin_propuesta).toBe(1);
    });

    // Sección 8 (corrección): cuando la cobertura total es imposible, el
    // motor global antes devolvía la solución LOCAL (greedy) tal cual,
    // descartando la mejor combinación PARCIAL que la propia búsqueda ya
    // había encontrado. Este caso extiende construirCasoFalloGreedy (donde
    // el greedy solo cubre 2/3 pero existe una asignación completa A/B/C,
    // ver [Aceptación 1] más arriba) agregando un 4º rodeo DESACOPLADO de
    // la contienda por A/B/C: clasificación 'interclubes' (matriz default:
    // categoría A NO elegible) con j1/j2/j3 todos categoría A ->
    // CATEGORIA_INCOMPATIBLE para los 3, SIEMPRE, sin relación con qué
    // jurado quedó libre de A/B/C. La cobertura máxima real del lote
    // completo es 3/4 (A,B,C), nunca 4/4 — D jamás puede cubrirse.
    test('sección 8: con cobertura total imposible (3/4), conserva la MEJOR combinación parcial (A,B,C) y no la peor solución local (solo A,C)', () => {
        const { ctx, config } = construirCasoFalloGreedy();
        const fecha = '2026-09-05';
        const pd = comuna(-30, -70, 'P0-D');
        const rodeoD = rodeoInterno('rodeoD', { fecha, asociacion: 'OtraAsociacion', clasificacion_codigo: 'interclubes', comunaObj: pd });
        ctx.rodeosPorId.set('rodeoD', rodeoD);
        ctx.idsSolicitados.push('rodeoD');

        // Confirma la premisa: el motor LOCAL (greedy), sin el motor global,
        // solo cubre 2 de los 4 (el mismo fallo documentado de siempre, A y C
        // — ver [Aceptación 1] — más D, que ningún motor puede cubrir nunca).
        const baseline = ejecutarSimulacion(ctx, 5, config);
        expect(baseline.resumen.sin_propuesta).toBe(2);

        const res = ejecutarSimulacionGlobal(ctx, 5, config);
        expect(res.cobertura_completa).toBe(false);
        expect(res.optimizacion_global.estado_busqueda).toBe(ESTADOS_BUSQUEDA.INFACTIBLE_DEMOSTRADO);
        // 3/4 es la cobertura máxima real — nunca 4/4 (rodeoD siempre sin
        // cobertura, los 3 jurados están todos ocupados ese mismo fin de
        // semana por A/B/C) — pero SÍ debe lograrse 3, no quedarse en 2.
        expect(res.optimizacion_global.cobertura_obtenida).toBe(3);
        expect(res.optimizacion_global.cupos_pendientes).toBe(1);
        expect(res.optimizacion_global.aplicada).toBe(true); // mejoró respecto al local
        expect(res.resumen.sin_propuesta).toBe(1);
        expect(res.resumen.propuestos).toBe(3);

        const porId = new Map(res.resultados.map(r => [r.rodeo_id, r.estado]));
        expect(porId.get('rodeoA')).toBe('PROPUESTO');
        expect(porId.get('rodeoB')).toBe('PROPUESTO'); // el rodeo que el greedy local dejaba sin propuesta
        expect(porId.get('rodeoC')).toBe('PROPUESTO');
        expect(porId.get('rodeoD')).toBe('SIN_PROPUESTA'); // el único imposible — nunca se inventa un 4º jurado
    });

    test('[Aceptación 8] jurado sin disponibilidad declarada — DISPONIBILIDAD nunca se relaja', () => {
        const fecha = '2026-09-05';
        const p0 = comuna(-30, -70, 'P0');
        const j1 = jurado('j1', { comunaTexto: 'P0' });
        const r1 = rodeoInterno('r1', { fecha, asociacion: 'OtraAsoc', comunaObj: p0 });
        const ctx = contexto({
            rodeos: [r1], jurados: [j1],
            disponibilidadPorJurado: {}, // j1 no declaró disponibilidad para esa fecha
            comunas: [p0]
        });
        const config = construirConfiguracionDefaultV1();

        const res = ejecutarSimulacionGlobal(ctx, 5, config);
        expect(res.cobertura_completa).toBe(false);
        expect(res.optimizacion_global.estado_busqueda).toBe(ESTADOS_BUSQUEDA.INFACTIBLE_DEMOSTRADO);
    });

    test('[Aceptación 8] jurado inactivo/no habilitado (no incluido en contexto.jurados) nunca se propone, ni relajando preferencias', () => {
        const fecha = '2026-09-05';
        const p0 = comuna(-30, -70, 'P0');
        // jurado2 (inactivo) simplemente NO está en la lista — cargarDatosMotor()
        // ya filtra por activo=true/tipo_persona='jurado' antes de llegar acá;
        // la lista que recibe el motor nunca incluye inhabilitados.
        const j1 = jurado('j1', { categoria: 'B', comunaTexto: 'P0' }); // categoría incompatible con 'nacional' (solo A)
        const r1 = rodeoInterno('r1', { fecha, asociacion: 'OtraAsoc', clasificacion_codigo: 'nacional', comunaObj: p0 });
        const ctx = contexto({
            rodeos: [r1], jurados: [j1],
            disponibilidadPorJurado: { j1: rangoFechas(fecha, 1) },
            comunas: [p0]
        });
        const config = construirConfiguracionDefaultV1();

        const res = ejecutarSimulacionGlobal(ctx, 5, config);
        expect(res.cobertura_completa).toBe(false);
        expect(res.optimizacion_global.estado_busqueda).toBe(ESTADOS_BUSQUEDA.INFACTIBLE_DEMOSTRADO);
    });

    test('[Aceptación 7] una designación ya fijada FUERA del lote restringe correctamente y nunca se altera', () => {
        const fecha = '2026-09-05'; // mismo fin de semana que el rodeo del lote
        const p0 = comuna(-30, -70, 'P0');
        const j1 = jurado('j1', { comunaTexto: 'P0' });
        // r-fijo NO forma parte de idsSolicitados/rodeosPorId del lote — es una
        // designación histórica real que ya existe en asignacionesTemporada.
        const rNuevo = rodeoInterno('r-nuevo', { fecha, asociacion: 'OtraAsoc', comunaObj: p0 });
        const asignacionesTemporadaOriginal = [
            { usuario_pagado_id: 'j1', rodeo_id: 'r-fijo', rodeos: { fecha, duracion_dias: 1, asociacion: 'AsocFija' } }
        ];
        const ctx = contexto({
            rodeos: [rNuevo], jurados: [j1],
            disponibilidadPorJurado: { j1: rangoFechas(fecha, 1) },
            asignacionesTemporada: asignacionesTemporadaOriginal,
            comunas: [p0]
        });
        const config = construirConfiguracionDefaultV1();

        const res = ejecutarSimulacionGlobal(ctx, 5, config);
        // j1 ya está ocupado ese fin de semana por la designación fija -> ni
        // siquiera cediendo preferencias puede cubrir r-nuevo (MISMO_FINDE es
        // obligatorio) -> infactible, y la designación fija nunca se tocó
        // (no está en rodeosPorId/idsSolicitados, el motor no puede escribirla).
        expect(res.cobertura_completa).toBe(false);
        expect(res.optimizacion_global.estado_busqueda).toBe(ESTADOS_BUSQUEDA.INFACTIBLE_DEMOSTRADO);
        expect(ctx.asignacionesTemporada).toEqual(asignacionesTemporadaOriginal); // sin mutar
    });

    test('[Aceptación 9] diferencia entre INFACTIBLE_DEMOSTRADO y LIMITE_ALCANZADO, usando el MISMO caso factible', () => {
        const { ctx, config } = construirCasoFalloGreedy();

        // Presupuesto generoso -> concluye con cobertura completa.
        const generoso = ejecutarSimulacionGlobal(ctx, 5, config, { limiteNodos: 60000, limiteMs: 8000 });
        expect(generoso.optimizacion_global.estado_busqueda).toBe(ESTADOS_BUSQUEDA.COBERTURA_COMPLETA);

        // Presupuesto artificialmente mínimo -> nunca llega a concluir nada,
        // nunca se informa como infactibilidad (sería un falso negativo).
        const agotado = ejecutarSimulacionGlobal(ctx, 5, config, { limiteNodos: 1, limiteMs: 1 });
        expect(agotado.optimizacion_global.estado_busqueda).toBe(ESTADOS_BUSQUEDA.LIMITE_ALCANZADO);
        expect(agotado.optimizacion_global.estado_busqueda).not.toBe(ESTADOS_BUSQUEDA.INFACTIBLE_DEMOSTRADO);
        expect(agotado.cobertura_completa).toBe(false);
        expect(agotado.optimizacion_global.limite_busqueda_alcanzado).toBe(true);
    });
});

describe('Motor Global — manejo de errores técnicos (nunca una excepción sin forma)', () => {
    test('configuración inválida -> ERROR_TECNICO, nunca una excepción sin capturar', () => {
        const { ctx, config } = construirCasoFalloGreedy();
        const configInvalida = clonarConfiguracion(config, { ordenCriterios: [] }); // inválida: 0 criterios activos

        let res;
        expect(() => { res = ejecutarSimulacionGlobal(ctx, 5, configInvalida); }).not.toThrow();
        expect(res.optimizacion_global.estado_busqueda).toBe(ESTADOS_BUSQUEDA.ERROR_TECNICO);
        expect(res.cobertura_completa).toBe(false);
        expect(Array.isArray(res.resultados)).toBe(true);
    });
});

describe('Motor Global — [Aceptación 6] feriados largos (bloque de fin de semana extendido)', () => {
    test('viernes 18-sep (feriado) + sábado 19 + domingo 20-sep-2026 forman UN solo bloque — reutiliza feriados.js sin reimplementarlo', () => {
        // Fiestas Patrias 2026: 18-sep es feriado y cae viernes -> el bloque se
        // extiende viernes-domingo (calcularBloqueRodeo, sin tocar, ver
        // feriados.js). Dos rodeos en los EXTREMOS de ese bloque (viernes y
        // domingo — 2 días de diferencia, nunca el mismo día calendario)
        // deben tratarse como MISMO_FINDE para un mismo jurado — nunca como
        // "fines de semana distintos" por la sola razón de no compartir
        // fecha exacta. bloquesSeSuperponen() es siempre una comparación de
        // PAR (nunca una agrupación transitiva), así que esto no depende de
        // ningún tercer rodeo ni de ninguna cadena de fechas.
        expect(calcularBloqueRodeo('2026-09-18', 1)).toEqual({ inicio: '2026-09-18', fin: '2026-09-20' });
        expect(calcularBloqueRodeo('2026-09-20', 1)).toEqual({ inicio: '2026-09-18', fin: '2026-09-20' });

        const p0 = comuna(-30, -70, 'P0');
        const j1 = jurado('j1', { comunaTexto: 'P0' });
        const rViernes = rodeoInterno('r-viernes', { fecha: '2026-09-18', asociacion: 'Asoc1', comunaObj: p0 });
        const rDomingo = rodeoInterno('r-domingo', { fecha: '2026-09-20', asociacion: 'Asoc2', comunaObj: p0 });

        // Con UN solo jurado, ni siquiera cediendo todas las preferencias
        // puede cubrir los dos extremos del mismo bloque largo — demuestra
        // que el motor global trata viernes+domingo como el MISMO fin de
        // semana, no como fechas independientes.
        const ctxUnJurado = contexto({
            rodeos: [rViernes, rDomingo], jurados: [j1],
            disponibilidadPorJurado: { j1: [...rangoFechas('2026-09-18', 1), ...rangoFechas('2026-09-20', 1)] },
            comunas: [p0]
        });
        const config = construirConfiguracionDefaultV1();
        const resUnJurado = ejecutarSimulacionGlobal(ctxUnJurado, 5, config);
        expect(resUnJurado.cobertura_completa).toBe(false);
        expect(resUnJurado.optimizacion_global.estado_busqueda).toBe(ESTADOS_BUSQUEDA.INFACTIBLE_DEMOSTRADO);
        expect(resUnJurado.optimizacion_global.cobertura_parcial_observada).toBe(1);

        // Con un SEGUNDO jurado disponible, el bloque largo se cubre
        // completo (cada extremo con un jurado distinto) — confirma que el
        // bloqueo de arriba era real (mismo bloque), no un error ajeno.
        const j2 = jurado('j2', { comunaTexto: 'P0' });
        const ctxDosJurados = contexto({
            rodeos: [rViernes, rDomingo], jurados: [j1, j2],
            disponibilidadPorJurado: {
                j1: [...rangoFechas('2026-09-18', 1), ...rangoFechas('2026-09-20', 1)],
                j2: [...rangoFechas('2026-09-18', 1), ...rangoFechas('2026-09-20', 1)]
            },
            comunas: [p0]
        });
        const resDosJurados = ejecutarSimulacionGlobal(ctxDosJurados, 5, config);
        expect(resDosJurados.cobertura_completa).toBe(true);
        expect(resDosJurados.resumen.propuestos).toBe(2);
    });
});

describe('Motor Global — [Aceptación 10] volumen representativo de producción (200 rodeos / 110 jurados)', () => {
    test('lote al tope del dry-run (200 rodeos) con un conflicto real de cobertura — concluye en tiempo acotado, sin falsos resultados', () => {
        // Réplica del caso de fallo del greedy (rodeoA/B/C) incrustada entre
        // 197 rodeos "de relleno" abundantes y sin conflicto — reproduce la
        // topología real medida (pocos rodeos genuinamente disputados, la
        // mayoría con sobra de candidatos) que motivó la optimización de
        // escalamiento (candidatos estáticos precalculados + orden MRV
        // precalculado — ver motorPropuestaDesignacionGlobal.js).
        const p0 = comuna(-30, -70, 'P0');
        const p1 = comuna(latADistancia(-30, 100), -70, 'P1');
        const pj3 = comuna(latADistancia(-30, 350), -70, 'Pj3');
        const pc = comuna(latADistancia(-30, 700), -70, 'Pc');
        const pFiller = comuna(-35, -72, 'PFiller');

        const jurados = [
            jurado('j1', { categoria: 'A', asociacion: 'AsocJ1', comunaTexto: 'P1' }),
            jurado('j2', { categoria: 'A', asociacion: 'AsocJ2', comunaTexto: 'P0' }),
            jurado('j3', { categoria: 'A', asociacion: 'AsocJ3', comunaTexto: 'Pj3' })
        ];
        // 107 jurados de relleno — NUNCA categoría 'A' (para que ninguno sea
        // elegible en rodeoA/B/C, clasificación 'nacional' solo habilita A).
        for (let i = 0; i < 107; i++) {
            jurados.push(jurado(`f${i}`, { categoria: i % 2 === 0 ? 'B' : 'C', asociacion: `AsocFiller${i % 5}`, comunaTexto: 'PFiller' }));
        }

        // Base DENTRO de la temporada activa (TEMPORADA.fecha_inicio = 2026-04-15)
        // — 2026-04-18 es un sábado, con margen seguro antes del inicio.
        const fechaSemana = n => {
            const base = new Date(Date.UTC(2026, 3, 18));
            base.setUTCDate(base.getUTCDate() + n * 7);
            return base.toISOString().slice(0, 10);
        };
        const fechaDificil = fechaSemana(0);
        const rodeos = [
            rodeoInterno('rodeoA', { fecha: fechaDificil, asociacion: 'AsocJ3', comunaObj: p0 }),
            rodeoInterno('rodeoB', { fecha: fechaDificil, asociacion: 'AsocJ1', comunaObj: p0 }),
            rodeoInterno('rodeoC', { fecha: fechaDificil, asociacion: 'AsocJ1', comunaObj: pc })
        ];
        let idx = 0;
        for (let w = 1; w <= 50 && rodeos.length < 200; w++) {
            const fecha = fechaSemana(w);
            for (let k = 0; k < 4 && rodeos.length < 200; k++) {
                const id = `filler${idx++}`;
                rodeos.push(rodeoInterno(id, { fecha, asociacion: `AsocRodeo${idx}`, clasificacion_codigo: 'provincial', comunaObj: pFiller }));
            }
        }
        expect(rodeos.length).toBe(200);

        const todasLasFechas = rodeos.map(r => r.fecha);
        const disponibilidadPorJurado = {};
        for (const j of jurados) disponibilidadPorJurado[j.id] = todasLasFechas;

        const ctx = contexto({
            rodeos, jurados, disponibilidadPorJurado,
            comunas: [p0, p1, pj3, pc, pFiller]
        });
        const config = construirConfiguracionDefaultV1();

        const inicio = Date.now();
        const res = ejecutarSimulacionGlobal(ctx, 5, config);
        const duracionMs = Date.now() - inicio;

        // No se afirma un tiempo exacto (depende de la máquina) — se exige
        // una cota generosa pero real, y SOBRE TODO que el resultado sea
        // correcto y bien formado, nunca un falso LIMITE_ALCANZADO/
        // INFACTIBLE_DEMOSTRADO para un caso que SÍ tiene solución.
        expect([ESTADOS_BUSQUEDA.COBERTURA_COMPLETA, ESTADOS_BUSQUEDA.LIMITE_ALCANZADO]).toContain(res.optimizacion_global.estado_busqueda);
        if (res.optimizacion_global.estado_busqueda === ESTADOS_BUSQUEDA.COBERTURA_COMPLETA) {
            expect(res.resumen.sin_propuesta).toBe(0);
            expect(res.resumen.propuestos).toBe(200);
        }
        expect(duracionMs).toBeLessThan(60000); // cota de seguridad del propio test, no del motor
    }, 70000);
});

// ═════════════════════════════════════════════════════════════════════════
// Mejora "Prioridad Deportiva + Nota Técnica + Repetición por Intervalo"
// (schema_version=4, Etapa B del pedido "Motor Global con Prioridad de
// Rodeos, Categorías y Calidad Técnica").
// ═════════════════════════════════════════════════════════════════════════
const PRIORIDAD_ZONAL_PRIMERO = [
    { clasificacion_codigo: 'zonal', orden: 1 },
    { clasificacion_codigo: 'interasociaciones', orden: 2 },
    { clasificacion_codigo: 'provincial', orden: 3 },
    { clasificacion_codigo: 'interclubes', orden: 4 },
    { clasificacion_codigo: 'clasificatorio', orden: 5 },
    { clasificacion_codigo: 'nacional', orden: 6 }
];

describe('calcularPesoPorClasificacion / costoRodeoAsignado / calcularCostoPrioridadDeportiva — puras', () => {
    test('mayor peso para la clasificación de mayor prioridad (orden=1)', () => {
        const pesos = calcularPesoPorClasificacion(PRIORIDAD_ZONAL_PRIMERO);
        expect(pesos.get('zonal')).toBe(6); // orden 1 de 6 -> peso máximo
        expect(pesos.get('nacional')).toBe(1); // orden 6 de 6 -> peso mínimo
        expect(pesos.get('zonal')).toBeGreaterThan(pesos.get('provincial'));
    });
    test('costoRodeoAsignado es 0 cuando el jurado tiene la categoría MÁS preferida del rodeo', () => {
        const rodeo = { clasificacion_codigo: 'zonal', _matrizGlobal: { ordenPorCategoria: new Map([['A', 1], ['B', 2]]) } };
        const juradoPorId = new Map([['jA', { categoria: 'A' }]]);
        const pesos = new Map([['zonal', 6]]);
        expect(costoRodeoAsignado(rodeo, 'jA', juradoPorId, pesos)).toBe(0);
    });
    test('costoRodeoAsignado crece con el peso de la clasificación Y con lo lejos que está de la categoría ideal', () => {
        const rodeo = { clasificacion_codigo: 'zonal', _matrizGlobal: { ordenPorCategoria: new Map([['A', 1], ['B', 2]]) } };
        const juradoPorId = new Map([['jB', { categoria: 'B' }]]);
        const pesos = new Map([['zonal', 6]]);
        expect(costoRodeoAsignado(rodeo, 'jB', juradoPorId, pesos)).toBe(6); // peso 6 × costo_categoria 1
    });
    test('calcularCostoPrioridadDeportiva suma el costo de TODOS los rodeos de la asignación', () => {
        const rodeoZ = { id: 'Z', clasificacion_codigo: 'zonal', _matrizGlobal: { ordenPorCategoria: new Map([['A', 1], ['B', 2]]) } };
        const rodeoP = { id: 'P', clasificacion_codigo: 'provincial', _matrizGlobal: { ordenPorCategoria: new Map([['A', 1], ['B', 2]]) } };
        const rodeoPorId = new Map([['Z', rodeoZ], ['P', rodeoP]]);
        const juradoPorId = new Map([['jA', { categoria: 'A' }], ['jB', { categoria: 'B' }]]);
        const pesos = calcularPesoPorClasificacion(PRIORIDAD_ZONAL_PRIMERO);
        // Z<-jB (costo 6×1=6) + P<-jA (costo 3×0=0) = 6
        const asignacionMala = new Map([['Z', 'jB'], ['P', 'jA']]);
        expect(calcularCostoPrioridadDeportiva(asignacionMala, rodeoPorId, juradoPorId, pesos)).toBe(6);
        // Z<-jA (peso 6 × costo_categoria 0 = 0) + P<-jB (peso 4 × costo_categoria 1, B es la 2ª preferida de P = 4) = 4
        // Aun así, es MENOR que la asignación mala (6) — menos "degradación" ponderada por prioridad.
        const asignacionBuena = new Map([['Z', 'jA'], ['P', 'jB']]);
        expect(calcularCostoPrioridadDeportiva(asignacionBuena, rodeoPorId, juradoPorId, pesos)).toBe(4);
        expect(calcularCostoPrioridadDeportiva(asignacionBuena, rodeoPorId, juradoPorId, pesos))
            .toBeLessThan(calcularCostoPrioridadDeportiva(asignacionMala, rodeoPorId, juradoPorId, pesos));
    });
});

describe('Motor Global — Prioridad Deportiva (schema_version=4): reserva el mejor jurado para el rodeo de mayor prioridad', () => {
    // Caso de contención REAL (verificado empíricamente): un zonal y un
    // provincial, ambos con la MISMA matriz (A preferido, B alternativa),
    // compitiendo por un único jurado A — sin el objetivo secundario, el
    // motor local YA cubre el 100% por su cuenta (P<-jA, Z<-jB), así que
    // ejecutarSimulacionGlobal nunca llegaría a correr tier0/tier1 sin la
    // corrección de la sección 2 ("primero cobertura, LUEGO prioridad,
    // incluso si el local ya cubrió todo por su cuenta").
    function construirCasoContencionZonalProvincial() {
        const fecha = '2026-11-14';
        const p0 = comuna(-30, -70, 'ContencionP0');
        const jA = jurado('jA', { categoria: 'A', asociacion: 'AsocA', comunaTexto: 'ContencionP0' });
        const jB = jurado('jB', { categoria: 'B', asociacion: 'AsocB', comunaTexto: 'ContencionP0' });
        // Orden de inserción deliberado [P, Z] — reproduce el escenario real
        // donde el greedy/MRV, ante un empate de candidatos, resuelve el
        // provincial primero y "gasta" al único A ahí, dejando al zonal con B.
        const rodeoP = rodeoInterno('P', { fecha, clasificacion_codigo: 'provincial', asociacion: 'OtraAsoc', comunaObj: p0 });
        const rodeoZ = rodeoInterno('Z', { fecha, clasificacion_codigo: 'zonal', asociacion: 'OtraAsoc', comunaObj: p0 });
        const matriz = {
            interclubes: [{ categoria: 'A', elegible: false, orden_preferencia: null }, { categoria: 'B', elegible: true, orden_preferencia: 2 }, { categoria: 'C', elegible: true, orden_preferencia: 1 }],
            // Provincial y zonal usan la MISMA matriz a propósito (A pref1, B pref2) — el único factor que debe decidir quién se queda con A es la PRIORIDAD DEPORTIVA entre rodeos, nunca la matriz interna (idéntica para ambos).
            provincial: [{ categoria: 'A', elegible: true, orden_preferencia: 1 }, { categoria: 'B', elegible: true, orden_preferencia: 2 }, { categoria: 'C', elegible: false, orden_preferencia: null }],
            interasociaciones: [{ categoria: 'A', elegible: true, orden_preferencia: 1 }, { categoria: 'B', elegible: true, orden_preferencia: 2 }, { categoria: 'C', elegible: false, orden_preferencia: null }],
            zonal: [{ categoria: 'A', elegible: true, orden_preferencia: 1 }, { categoria: 'B', elegible: true, orden_preferencia: 2 }, { categoria: 'C', elegible: false, orden_preferencia: null }],
            clasificatorio: [{ categoria: 'A', elegible: true, orden_preferencia: 1 }, { categoria: 'B', elegible: true, orden_preferencia: 2 }, { categoria: 'C', elegible: false, orden_preferencia: null }],
            nacional: [{ categoria: 'A', elegible: true, orden_preferencia: 1 }, { categoria: 'B', elegible: false, orden_preferencia: null }, { categoria: 'C', elegible: false, orden_preferencia: null }]
        };
        const ctx = contexto({
            rodeos: [rodeoP, rodeoZ], jurados: [jA, jB],
            disponibilidadPorJurado: { jA: rangoFechas(fecha, 1), jB: rangoFechas(fecha, 1) },
            comunas: [p0]
        });
        const configSinPrioridad = clonarConfiguracion(construirConfiguracionDefaultV1(), { matriz });
        const configConPrioridad = clonarConfiguracion(construirConfiguracionDefaultV1(), {
            schema_version: 4, matriz,
            regla_prioridad_deportiva_activa: true,
            prioridad_clasificaciones: PRIORIDAD_ZONAL_PRIMERO
        });
        return { ctx, configSinPrioridad, configConPrioridad };
    }

    test('premisa: SIN el objetivo de prioridad deportiva, el provincial "gasta" al único jurado A y el zonal queda con B', () => {
        const { ctx, configSinPrioridad } = construirCasoContencionZonalProvincial();
        const res = ejecutarSimulacionGlobal(ctx, 5, configSinPrioridad);
        expect(res.resumen.sin_propuesta).toBe(0); // cobertura total igual, por eso nadie nota el problema sin esta mejora
        const porId = new Map(res.resultados.map(r => [r.rodeo_id, r.jurado_propuesto.jurado_id]));
        expect(porId.get('P')).toBe('jA');
        expect(porId.get('Z')).toBe('jB');
    });

    test('CON el objetivo de prioridad deportiva activo, se reasigna: el zonal (mayor prioridad) se queda con el jurado A, el provincial con el B — sin perder cobertura', () => {
        const { ctx, configConPrioridad } = construirCasoContencionZonalProvincial();
        const res = ejecutarSimulacionGlobal(ctx, 5, configConPrioridad);
        expect(res.resumen.sin_propuesta).toBe(0); // la cobertura NUNCA se sacrifica
        expect(res.resumen.propuestos).toBe(2);
        const porId = new Map(res.resultados.map(r => [r.rodeo_id, r.jurado_propuesto.jurado_id]));
        expect(porId.get('Z')).toBe('jA'); // el zonal reserva al mejor (A)
        expect(porId.get('P')).toBe('jB'); // el provincial libera al A y queda con B
        expect(res.optimizacion_global.prioridad_deportiva).toMatchObject({ aplicada: true, mejorada: true });
        // Al menos uno de los dos queda marcado como reasignado respecto a
        // su propio ranking natural en esta reconstrucción secuencial (P,
        // forzado a jB en vez de su ganador natural jA) — el otro (Z) puede
        // coincidir con su ranking natural RECALCULADO después de que P ya
        // quedó forzado (jA sigue libre en ese punto), sin que eso invalide
        // el resultado: lo que importa es la asignación FINAL, ya verificada
        // arriba (Z→jA, P→jB).
        expect(res.optimizacion_global.rodeos_con_ganador_forzado.length).toBeGreaterThanOrEqual(1);
        expect(res.optimizacion_global.rodeos_con_ganador_forzado.some(r => r.rodeo_id === 'P' && r.jurado_id === 'jB')).toBe(true);
    });

    test('regla INACTIVA (default) -> ningún cambio respecto al comportamiento ya existente, aunque la contención exista', () => {
        const { ctx, configSinPrioridad } = construirCasoContencionZonalProvincial();
        const res = ejecutarSimulacionGlobal(ctx, 5, configSinPrioridad);
        expect(res.optimizacion_global.prioridad_deportiva).toBeUndefined();
        expect(res.optimizacion_global.aplicada).toBe(false);
    });

    // Punto 3 del pedido de pruebas original: "Un A destinado a un
    // provincial se reubica en un rodeo prioritario" + "Un B reemplaza al A
    // desplazado" — exactamente el mismo caso de arriba, verificado también
    // vía resolverPrioridadDeportiva() directamente (unidad, sin pasar por
    // ejecutarSimulacionGlobal), probando la cota superior/semilla.
    test('resolverPrioridadDeportiva(): nunca empeora respecto a la semilla, y encuentra una mejor combinación cuando existe', () => {
        const { ctx, configConPrioridad } = construirCasoContencionZonalProvincial();
        const rodeoP = ctx.rodeosPorId.get('P');
        const rodeoZ = ctx.rodeosPorId.get('Z');
        const matrizPorClasificacion = { provincial: { elegibles: new Set(['A', 'B']), ordenPorCategoria: new Map([['A', 1], ['B', 2]]) }, zonal: { elegibles: new Set(['A', 'B']), ordenPorCategoria: new Map([['A', 1], ['B', 2]]) } };
        rodeoP._matrizGlobal = matrizPorClasificacion.provincial;
        rodeoZ._matrizGlobal = matrizPorClasificacion.zonal;
        const rodeosBuscables = [rodeoP, rodeoZ];
        const candidatosEstaticosPorRodeo = new Map([
            ['P', [{ id: 'jA', categoria: 'A' }, { id: 'jB', categoria: 'B' }]],
            ['Z', [{ id: 'jA', categoria: 'A' }, { id: 'jB', categoria: 'B' }]]
        ]);
        const semillaMala = new Map([['P', 'jA'], ['Z', 'jB']]); // la "mala" (provincial se queda con A)
        const r = resolverPrioridadDeportiva(ctx, configConPrioridad, rodeosBuscables, 2, candidatosEstaticosPorRodeo, new Set(), semillaMala);
        expect(r.cobertura).toBe(2); // nunca menos que la semilla
        expect(r.mejorada).toBe(true);
        expect(r.asignacion.get('Z')).toBe('jA');
        expect(r.asignacion.get('P')).toBe('jB');
        expect(r.costo).toBeLessThan(r.costoSemilla);
    });

    test('resolverPrioridadDeportiva(): si la semilla YA es la óptima, no la cambia (mejorada=false, misma asignación)', () => {
        const { ctx, configConPrioridad } = construirCasoContencionZonalProvincial();
        const rodeoP = ctx.rodeosPorId.get('P');
        const rodeoZ = ctx.rodeosPorId.get('Z');
        rodeoP._matrizGlobal = { elegibles: new Set(['A', 'B']), ordenPorCategoria: new Map([['A', 1], ['B', 2]]) };
        rodeoZ._matrizGlobal = { elegibles: new Set(['A', 'B']), ordenPorCategoria: new Map([['A', 1], ['B', 2]]) };
        const rodeosBuscables = [rodeoP, rodeoZ];
        const candidatosEstaticosPorRodeo = new Map([
            ['P', [{ id: 'jA', categoria: 'A' }, { id: 'jB', categoria: 'B' }]],
            ['Z', [{ id: 'jA', categoria: 'A' }, { id: 'jB', categoria: 'B' }]]
        ]);
        const semillaBuena = new Map([['Z', 'jA'], ['P', 'jB']]);
        const r = resolverPrioridadDeportiva(ctx, configConPrioridad, rodeosBuscables, 2, candidatosEstaticosPorRodeo, new Set(), semillaBuena);
        expect(r.mejorada).toBe(false);
        expect(r.costo).toBe(r.costoSemilla);
        expect(r.asignacion).toEqual(semillaBuena);
    });

    // Punto 6 del pedido de pruebas: "No se desperdicia un A/B necesario
    // para otro rodeo" — la poda de factibilidad (coberturaObjetivo) es un
    // piso DURO: aunque reasignar "mejoraría" el costo si se permitiera
    // perder un cupo, la búsqueda nunca acepta una solución con menos
    // cobertura que la semilla.
    test('nunca sacrifica cobertura por mejorar el costo — coberturaObjetivo es un piso duro', () => {
        const { ctx, configConPrioridad } = construirCasoContencionZonalProvincial();
        const rodeoP = ctx.rodeosPorId.get('P');
        const rodeoZ = ctx.rodeosPorId.get('Z');
        rodeoP._matrizGlobal = { elegibles: new Set(['A']), ordenPorCategoria: new Map([['A', 1]]) };
        rodeoZ._matrizGlobal = { elegibles: new Set(['A', 'B']), ordenPorCategoria: new Map([['A', 1], ['B', 2]]) };
        const rodeosBuscables = [rodeoP, rodeoZ];
        // P SOLO admite jA (ningún otro candidato) — forzar a jA a Z dejaría
        // a P sin nadie, perdiendo cobertura. La búsqueda nunca debe hacerlo.
        const candidatosEstaticosPorRodeo = new Map([
            ['P', [{ id: 'jA', categoria: 'A' }]],
            ['Z', [{ id: 'jA', categoria: 'A' }, { id: 'jB', categoria: 'B' }]]
        ]);
        const semilla = new Map([['P', 'jA'], ['Z', 'jB']]);
        const r = resolverPrioridadDeportiva(ctx, configConPrioridad, rodeosBuscables, 2, candidatosEstaticosPorRodeo, new Set(), semilla);
        expect(r.cobertura).toBe(2); // sigue cubriendo ambos
        expect(r.asignacion.get('P')).toBe('jA'); // P solo puede ser jA — nunca se le quita
    });
});

// ═════════════════════════════════════════════════════════════════════════
// Etapa C, sección 3 del pedido — corrección: "la regla acordada es que el
// motor NO pueda repetir automáticamente una asociación si no han
// transcurrido [N] meses desde la última designación efectiva... no debe
// saltarse automáticamente esta restricción". ASOCIACION_REPETIDA_INTERVALO
// pasó de CAUSAS_RELAJABLES (Etapa B) a CAUSAS_OBLIGATORIAS — este bloque
// verifica esa corrección a nivel de clasificación Y de comportamiento real
// del motor global (nunca se fuerza, ni siquiera cuando ceder lograría
// cobertura total).
// ═════════════════════════════════════════════════════════════════════════
describe('Corrección Etapa C (sección 3) — ASOCIACION_REPETIDA_INTERVALO es OBLIGATORIA, nunca se relaja', () => {
    test('ASOCIACION_REPETIDA_INTERVALO está en CAUSAS_OBLIGATORIAS y NUNCA en CAUSAS_RELAJABLES', () => {
        expect(CAUSAS_OBLIGATORIAS.has('ASOCIACION_REPETIDA_INTERVALO')).toBe(true);
        expect(CAUSAS_RELAJABLES.has('ASOCIACION_REPETIDA_INTERVALO')).toBe(false);
    });

    // Mismo patrón que [Aceptación 4] (ASOCIACION_REPETIDA_TEMPORADA SÍ se
    // cede), pero con la regla de intervalo — demuestra la diferencia de
    // tratamiento exigida por el pedido con el MISMO tipo de escenario
    // (único jurado, única vía posible de cobertura es repetir la
    // asociación): un rodeo de la MISMA asociación que el jurado ya cubrió
    // hace 3 meses, con un intervalo configurado de 6 — ningún nivel de
    // búsqueda (ni el permisivo) puede proponerlo.
    test('único jurado posible repite su propia asociación hace 3 meses (intervalo=6) — el motor global NUNCA lo fuerza, ni cediendo todas las preferencias', () => {
        const fecha = '2026-11-14';
        const p0 = comuna(-30, -70, 'P0Intervalo');
        const j1 = jurado('j1', { asociacion: 'OtraAsoc', comunaTexto: 'P0Intervalo' });
        const r1 = rodeoInterno('r1', { fecha, asociacion: 'AsocRepetida', comunaObj: p0 });
        const ctx = contexto({
            rodeos: [r1], jurados: [j1],
            disponibilidadPorJurado: { j1: rangoFechas(fecha, 1) },
            comunas: [p0]
        });
        ctx.ultimaFechaAsociacionPorJurado = construirUltimaFechaAsociacionPorJurado([
            { usuario_pagado_id: 'j1', estado: 'activo', estado_designacion: null, rodeos: { fecha: '2026-08-14', asociacion: 'AsocRepetida' } } // 3 meses antes
        ]);
        const config = clonarConfiguracion(construirConfiguracionDefaultV1(), {
            schema_version: 4,
            regla_repeticion_asociacion_intervalo_activa: true,
            repeticion_asociacion_meses: 6
        });

        const baseline = ejecutarSimulacion(ctx, 5, config);
        expect(baseline.resultados[0].estado).toBe('SIN_PROPUESTA');
        expect(baseline.resultados[0].descartes.ASOCIACION_REPETIDA_INTERVALO).toBe(1);
        expect(baseline.resultados[0].descartes.MISMA_ASOCIACION).toBe(0); // nunca confundir con la prohibición de auto-juzgarse

        const res = ejecutarSimulacionGlobal(ctx, 5, config);
        // A diferencia de [Aceptación 4] (donde el motor global SÍ cubre
        // cediendo ASOCIACION_REPETIDA_TEMPORADA), acá NUNCA debe cubrirse:
        // la única vía posible infringiría la restricción obligatoria.
        expect(res.cobertura_completa).toBe(false);
        expect(res.optimizacion_global.estado_busqueda).toBe(ESTADOS_BUSQUEDA.INFACTIBLE_DEMOSTRADO);
        expect(res.resultados[0].estado).toBe('SIN_PROPUESTA');
        expect(res.resultados[0].descartes.ASOCIACION_REPETIDA_INTERVALO).toBe(1);
    });

    test('última designación histórica hace 8 meses (intervalo=6) — fuera del intervalo, el motor global SÍ cubre sin ceder nada', () => {
        const fecha = '2026-11-14';
        const p0 = comuna(-30, -70, 'P0IntervaloOk');
        const j1 = jurado('j1', { asociacion: 'OtraAsoc', comunaTexto: 'P0IntervaloOk' });
        const r1 = rodeoInterno('r1', { fecha, asociacion: 'AsocRepetida', comunaObj: p0 });
        const ctx = contexto({
            rodeos: [r1], jurados: [j1],
            disponibilidadPorJurado: { j1: rangoFechas(fecha, 1) },
            comunas: [p0]
        });
        ctx.ultimaFechaAsociacionPorJurado = construirUltimaFechaAsociacionPorJurado([
            { usuario_pagado_id: 'j1', estado: 'activo', estado_designacion: null, rodeos: { fecha: '2026-03-14', asociacion: 'AsocRepetida' } } // 8 meses antes
        ]);
        const config = clonarConfiguracion(construirConfiguracionDefaultV1(), {
            schema_version: 4,
            regla_repeticion_asociacion_intervalo_activa: true,
            repeticion_asociacion_meses: 6
        });
        const res = ejecutarSimulacionGlobal(ctx, 5, config);
        expect(res.cobertura_completa).toBe(true);
        expect(res.resultados[0].jurado_propuesto.jurado_id).toBe('j1');
        expect(res.resultados[0].jurado_propuesto.optimizacion_global_relajaciones ?? []).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// Etapa C, sección 4 del pedido — corrección: el objetivo de prioridad
// deportiva no debía limitarse a distribuir categorías A/B/C; con dos
// jurados de la MISMA categoría (mismo costo_categoria, empate), debía
// preferir al de mejor nota técnica para el rodeo de MAYOR prioridad.
// ═════════════════════════════════════════════════════════════════════════
describe('Corrección Etapa C (sección 4) — desempate por nota técnica en el COSTO de prioridad deportiva', () => {
    test('costoRodeoAsignado: sin notaTecnicaPorJurado, el costo es idéntico al de antes de la corrección (compatibilidad)', () => {
        const rodeo = { clasificacion_codigo: 'zonal', _matrizGlobal: { ordenPorCategoria: new Map([['A', 1], ['B', 2]]) } };
        const juradoPorId = new Map([['jA', { categoria: 'A' }]]);
        const pesos = new Map([['zonal', 6]]);
        expect(costoRodeoAsignado(rodeo, 'jA', juradoPorId, pesos)).toBe(0);
        expect(costoRodeoAsignado(rodeo, 'jA', juradoPorId, pesos, undefined)).toBe(0);
    });

    test('costoRodeoAsignado: entre dos candidatos de la MISMA categoría (mismo costo_categoria), gana el de mejor nota técnica', () => {
        const rodeo = { clasificacion_codigo: 'zonal', _matrizGlobal: { ordenPorCategoria: new Map([['A', 1], ['B', 2]]) } };
        const juradoPorId = new Map([['jMejor', { id: 'jMejor', categoria: 'A' }], ['jPeor', { id: 'jPeor', categoria: 'A' }]]);
        const pesos = new Map([['zonal', 6]]);
        const notas = new Map([['jMejor', { promedio: 6.3, cantidad: 3 }], ['jPeor', { promedio: 5.2, cantidad: 3 }]]);
        const costoMejor = costoRodeoAsignado(rodeo, 'jMejor', juradoPorId, pesos, notas);
        const costoPeor = costoRodeoAsignado(rodeo, 'jPeor', juradoPorId, pesos, notas);
        expect(costoMejor).toBeLessThan(costoPeor);
    });

    test('costoRodeoAsignado: la diferencia de nota técnica NUNCA invierte una diferencia real de costo_categoria (dominancia lexicográfica)', () => {
        const rodeo = { clasificacion_codigo: 'zonal', _matrizGlobal: { ordenPorCategoria: new Map([['A', 1], ['B', 2]]) } };
        const juradoPorId = new Map([
            ['jA_peorNota', { id: 'jA_peorNota', categoria: 'A' }], // costo_categoria 0, nota pésima
            ['jB_mejorNota', { id: 'jB_mejorNota', categoria: 'B' }] // costo_categoria 1 (peor categoría), nota máxima
        ]);
        const pesos = new Map([['zonal', 6]]);
        const notas = new Map([
            ['jA_peorNota', { promedio: 0, cantidad: 1 }],
            ['jB_mejorNota', { promedio: NOTA_TECNICA_MAXIMA, cantidad: 1 }]
        ]);
        const costoA = costoRodeoAsignado(rodeo, 'jA_peorNota', juradoPorId, pesos, notas);
        const costoB = costoRodeoAsignado(rodeo, 'jB_mejorNota', juradoPorId, pesos, notas);
        // La categoría ideal (A) SIEMPRE gana, aunque su nota técnica sea la
        // peor posible y la del B la mejor posible — nunca se "compra" una
        // mejor categoría con nota técnica.
        expect(costoA).toBeLessThan(costoB);
    });

    test('resolverPrioridadDeportiva(): con dos A igualmente elegibles, prefiere al de mejor nota técnica para el rodeo de MAYOR prioridad (zonal > interasociaciones), sin sacrificar cobertura', () => {
        const fecha = '2026-11-14';
        const p0 = comuna(-30, -70, 'ContencionNota');
        const jMejorNota = jurado('jMejorNota', { categoria: 'A', asociacion: 'AsocMejor', comunaTexto: 'ContencionNota' });
        const jPeorNota = jurado('jPeorNota', { categoria: 'A', asociacion: 'AsocPeor', comunaTexto: 'ContencionNota' });
        const rodeoZ = rodeoInterno('Z', { fecha, clasificacion_codigo: 'zonal', asociacion: 'OtraAsoc', comunaObj: p0 });
        const rodeoI = rodeoInterno('I', { fecha, clasificacion_codigo: 'interasociaciones', asociacion: 'OtraAsoc', comunaObj: p0 });
        const ctx = contexto({
            rodeos: [rodeoZ, rodeoI], jurados: [jMejorNota, jPeorNota],
            disponibilidadPorJurado: { jMejorNota: rangoFechas(fecha, 1), jPeorNota: rangoFechas(fecha, 1) },
            comunas: [p0]
        });
        ctx.notaTecnicaPorJurado = new Map([
            ['jMejorNota', { promedio: 6.3, cantidad: 4 }],
            ['jPeorNota', { promedio: 5.2, cantidad: 4 }]
        ]);
        const configConPrioridadYNota = clonarConfiguracion(construirConfiguracionDefaultV1(), {
            schema_version: 4,
            regla_prioridad_deportiva_activa: true,
            prioridad_clasificaciones: PRIORIDAD_ZONAL_PRIMERO,
            ordenCriterios: [
                { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 },
                { criterio_codigo: 'NOTA_TECNICA', orden: 2 },
                { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 3 },
                { criterio_codigo: 'MENOR_DISTANCIA', orden: 4 }
            ]
        });
        const rodeoZanotado = { ...ctx.rodeosPorId.get('Z'), _matrizGlobal: { elegibles: new Set(['A']), ordenPorCategoria: new Map([['A', 1]]) } };
        const rodeoIanotado = { ...ctx.rodeosPorId.get('I'), _matrizGlobal: { elegibles: new Set(['A']), ordenPorCategoria: new Map([['A', 1]]) } };
        const rodeosBuscables = [rodeoZanotado, rodeoIanotado];
        const candidatosEstaticosPorRodeo = new Map([
            ['Z', [jMejorNota, jPeorNota]],
            ['I', [jMejorNota, jPeorNota]]
        ]);
        // Semilla deliberadamente "mala" desde el punto de vista de la nota
        // técnica (empatada en costo de categoría — ambos son A — así que,
        // SIN la corrección, resolverPrioridadDeportiva sería indiferente).
        const semilla = new Map([['Z', 'jPeorNota'], ['I', 'jMejorNota']]);
        const r = resolverPrioridadDeportiva(ctx, configConPrioridadYNota, rodeosBuscables, 2, candidatosEstaticosPorRodeo, new Set(), semilla);
        expect(r.cobertura).toBe(2); // nunca se sacrifica cobertura
        expect(r.asignacion.get('Z')).toBe('jMejorNota'); // el zonal (mayor prioridad) se queda con la mejor nota
        expect(r.asignacion.get('I')).toBe('jPeorNota');
        expect(r.mejorada).toBe(true);
    });

    test('sin NOTA_TECNICA activa en ordenCriterios, el objetivo de prioridad deportiva queda indiferente entre jurados de la misma categoría (comportamiento Etapa B, sin cambios)', () => {
        const fecha = '2026-11-14';
        const p0 = comuna(-30, -70, 'ContencionSinNota');
        const jMejorNota = jurado('jMejorNota', { categoria: 'A', asociacion: 'AsocMejor', comunaTexto: 'ContencionSinNota' });
        const jPeorNota = jurado('jPeorNota', { categoria: 'A', asociacion: 'AsocPeor', comunaTexto: 'ContencionSinNota' });
        const rodeoZ = rodeoInterno('Z', { fecha, clasificacion_codigo: 'zonal', asociacion: 'OtraAsoc', comunaObj: p0 });
        const rodeoI = rodeoInterno('I', { fecha, clasificacion_codigo: 'interasociaciones', asociacion: 'OtraAsoc', comunaObj: p0 });
        const ctx = contexto({
            rodeos: [rodeoZ, rodeoI], jurados: [jMejorNota, jPeorNota],
            disponibilidadPorJurado: { jMejorNota: rangoFechas(fecha, 1), jPeorNota: rangoFechas(fecha, 1) },
            comunas: [p0]
        });
        ctx.notaTecnicaPorJurado = new Map([
            ['jMejorNota', { promedio: 6.3, cantidad: 4 }],
            ['jPeorNota', { promedio: 5.2, cantidad: 4 }]
        ]);
        const configSinNota = clonarConfiguracion(construirConfiguracionDefaultV1(), {
            schema_version: 4,
            regla_prioridad_deportiva_activa: true,
            prioridad_clasificaciones: PRIORIDAD_ZONAL_PRIMERO
            // ordenCriterios por defecto (sin NOTA_TECNICA) — el costo nunca recibe el término de nota técnica.
        });
        const rodeoZanotado = { ...ctx.rodeosPorId.get('Z'), _matrizGlobal: { elegibles: new Set(['A']), ordenPorCategoria: new Map([['A', 1]]) } };
        const rodeoIanotado = { ...ctx.rodeosPorId.get('I'), _matrizGlobal: { elegibles: new Set(['A']), ordenPorCategoria: new Map([['A', 1]]) } };
        const rodeosBuscables = [rodeoZanotado, rodeoIanotado];
        const candidatosEstaticosPorRodeo = new Map([
            ['Z', [jMejorNota, jPeorNota]],
            ['I', [jMejorNota, jPeorNota]]
        ]);
        const semilla = new Map([['Z', 'jPeorNota'], ['I', 'jMejorNota']]);
        const r = resolverPrioridadDeportiva(ctx, configSinNota, rodeosBuscables, 2, candidatosEstaticosPorRodeo, new Set(), semilla);
        // Mismo costo de categoría en ambos lados (0): sin el criterio NOTA_
        // TECNICA activo, nunca mejora — se queda con la semilla, tal como
        // ya se comportaba en la Etapa B.
        expect(r.mejorada).toBe(false);
        expect(r.asignacion).toEqual(semilla);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Sección 7 del pedido Etapa B: "Verificar que la exclusión de rodeos
// imposibles considere únicamente restricciones realmente obligatorias, y
// no descarte rodeos que podrían cubrirse al flexibilizar preferencias."
// — regresión explícita de la corrección de la sección 8 (Etapa A): un
// rodeo sin candidatos en el nivel ESTRICTO, pero con candidatos bajo el
// nivel PERMISIVO (relajando una preferencia, nunca una obligatoria), NUNCA
// debe quedar excluido de tier1 — solo de tier0.
// ─────────────────────────────────────────────────────────────────────────
describe('Sección 7 — la exclusión de "rodeo imposible" nunca confunde preferencias flexibles con restricciones obligatorias', () => {
    test('un rodeo solo cubrible superando los 600km (preferencia flexible) NUNCA se excluye de tier1, y el motor global sí lo cubre', () => {
        const fecha = '2026-09-05';
        const pJurado = comuna(-30, -70, 'P7Jurado');
        const pRodeoLejos = comuna(latADistancia(-30, 750), -70, 'P7RodeoLejos'); // 750km > 600km
        const j1 = jurado('j1', { comunaTexto: 'P7Jurado' });
        // r1 (lejos, preferencia) y r2 (cerca, sin conflicto) comparten el
        // único jurado disponible — fuerza a que SI r1 quedara mal
        // excluido por la corrección de la sección 8, igual se detectaría
        // acá por no lograr cobertura total.
        const r1 = rodeoInterno('r1', { fecha, asociacion: 'OtraAsoc1', comunaObj: pRodeoLejos });
        const ctx = contexto({
            rodeos: [r1], jurados: [j1],
            disponibilidadPorJurado: { j1: rangoFechas(fecha, 1) },
            comunas: [pJurado, pRodeoLejos]
        });
        const config = construirConfiguracionDefaultV1();
        const res = ejecutarSimulacionGlobal(ctx, 5, config);
        // Bajo el nivel ESTRICTO, r1 tiene CERO candidatos (750km > 600km) —
        // la corrección de la sección 8 lo excluiría de tier0 (correcto).
        // Bajo el nivel PERMISIVO, SÍ tiene candidato (DISTANCIA_EXCEDIDA es
        // relajable) — nunca debe quedar excluido de tier1 por el mismo
        // motivo. Resultado esperado: cobertura total, cediendo distancia.
        expect(res.cobertura_completa).toBe(true);
        expect(res.optimizacion_global.estado_busqueda).toBe(ESTADOS_BUSQUEDA.COBERTURA_COMPLETA);
        expect(res.optimizacion_global.nivel_busqueda).toBe('PREFERENCIAS_RELAJADAS');
        expect(res.resumen.propuestos).toBe(1);
        expect(res.resultados[0].jurado_propuesto.optimizacion_global_relajaciones).toContain('DISTANCIA_EXCEDIDA');
    });

    test('un rodeo imposible incluso bajo el nivel PERMISIVO (categoría incompatible, obligatoria) SÍ se excluye correctamente de ambos niveles', () => {
        const fecha = '2026-09-05';
        const p0 = comuna(-30, -70, 'P7Obligatoria');
        const j1 = jurado('j1', { categoria: 'B', comunaTexto: 'P7Obligatoria' }); // B no elegible en 'nacional'
        const r1 = rodeoInterno('r1', { fecha, clasificacion_codigo: 'nacional', asociacion: 'OtraAsoc', comunaObj: p0 });
        const ctx = contexto({
            rodeos: [r1], jurados: [j1],
            disponibilidadPorJurado: { j1: rangoFechas(fecha, 1) },
            comunas: [p0]
        });
        const config = construirConfiguracionDefaultV1();
        const res = ejecutarSimulacionGlobal(ctx, 5, config);
        // CATEGORIA_INCOMPATIBLE es obligatoria (CAUSAS_OBLIGATORIAS) — nunca
        // se relaja en ningún nivel, así que r1 es imposible en AMBOS y el
        // motor debe demostrarlo correctamente (INFACTIBLE_DEMOSTRADO), no
        // confundirlo con LIMITE_ALCANZADO ni afirmar cobertura falsa.
        expect(res.cobertura_completa).toBe(false);
        expect(res.optimizacion_global.estado_busqueda).toBe(ESTADOS_BUSQUEDA.INFACTIBLE_DEMOSTRADO);
        expect(res.resumen.sin_propuesta).toBe(1);
    });
});
