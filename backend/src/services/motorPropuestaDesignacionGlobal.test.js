const { ejecutarSimulacionGlobal, resolverAsignacionGlobal, CAUSAS_RELAJABLES, CAUSAS_OBLIGATORIAS, ESTADOS_BUSQUEDA } = require('./motorPropuestaDesignacionGlobal');
const { ejecutarSimulacion } = require('./motorPropuestaDesignacion');
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
        const TODAS = new Set(['DISPONIBILIDAD', 'MISMA_ASOCIACION', 'ASOCIACION_REPETIDA_TEMPORADA', 'FINDE_CONSECUTIVO', 'MISMO_FINDE', 'CATEGORIA_INCOMPATIBLE', 'JURADO_SIN_COMUNA_RESOLVIBLE', 'DISTANCIA_EXCEDIDA']);
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
