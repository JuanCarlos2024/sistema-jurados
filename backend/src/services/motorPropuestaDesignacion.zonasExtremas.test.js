// ═════════════════════════════════════════════════════════════════════════
// Tests de la nueva regla de negocio "ZONAS EXTREMAS" (schema_version=3,
// migración 053 — PREPARADA, NO aplicada). Archivo SEPARADO (mismo patrón
// que motorPropuestaDesignacion.equidadTraslados.test.js/.equidadDesignaciones
// .test.js): no toca BD, fixtures puras.
//
// Cubre (ver pedido de la mejora, secciones 41-52):
//   - resolverMatrizParaRodeo / construirMatrizZonaExtremaDesdeConfiguracion
//     — UNIDADES PURAS: detección por asociación, precedencia sobre la
//     matriz normal, asociación no incluida -> matriz normal.
//   - ejecutarSimulacion() con Zona Extrema activa — integración: override
//     de Provincial/Interasociaciones, C gana sobre B, A automático excluido
//     (SIN_PROPUESTA si solo A disponible), A manual vía evaluarCandidato
//     Directo (causa CATEGORIA_INCOMPATIBLE — mismo mecanismo de advertencia
//     ya existente, sin causa nueva), A habilitado -> elegible automático,
//     asociación quitada -> vuelve a matriz normal, coexistencia con
//     multi-rodeo/designaciones temporales/EQUIDAD_TRASLADOS/distancia,
//     "no afecta el resto de las reglas" (DISPONIBILIDAD sigue descartando).
// ═════════════════════════════════════════════════════════════════════════
const {
    ejecutarSimulacion, evaluarCandidatoDirecto, resolverMatrizParaRodeo,
    construirMatrizZonaExtremaDesdeConfiguracion, construirMatrizPorClasificacionDesdeConfiguracion,
    construirExplicacionZonaExtrema
} = require('./motorPropuestaDesignacion');
const { construirConfiguracionDefaultV1, clonarConfiguracion, validarConfiguracion, ZONA_EXTREMA_ASOCIACIONES_DEFAULT, ZONA_EXTREMA_CATEGORIAS_DEFAULT } = require('./configuracionDesignacion');
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

const COMUNA = comuna(-33.45, -70.6667, 'ComunaComun'); // rodeo y jurados en el mismo punto

// Configuración schema_version=3 con Zonas Extremas ACTIVA — C1/B2/A-off
// (default de negocio, sección 3/23 del pedido) salvo override explícito.
function configZonaExtrema({ asociaciones = ZONA_EXTREMA_ASOCIACIONES_DEFAULT, categorias = ZONA_EXTREMA_CATEGORIAS_DEFAULT, activa = true } = {}) {
    return clonarConfiguracion(construirConfiguracionDefaultV1(), {
        schema_version: 3,
        regla_zonas_extremas_activa: activa,
        zonas_extremas: { asociaciones, categorias }
    });
}

// ═════════════════════════════════════════════════════════════════════════
// UNIDADES PURAS
// ═════════════════════════════════════════════════════════════════════════
describe('construirMatrizZonaExtremaDesdeConfiguracion — deriva la matriz especial', () => {
    test('regla inactiva -> null', () => {
        const config = configZonaExtrema({ activa: false });
        expect(construirMatrizZonaExtremaDesdeConfiguracion(config)).toBeNull();
    });
    test('regla activa -> {elegibles, ordenPorCategoria} con C=1, B=2, A ausente de elegibles', () => {
        const config = configZonaExtrema();
        const matriz = construirMatrizZonaExtremaDesdeConfiguracion(config);
        expect(matriz.elegibles.has('C')).toBe(true);
        expect(matriz.elegibles.has('B')).toBe(true);
        expect(matriz.elegibles.has('A')).toBe(false);
        expect(matriz.ordenPorCategoria.get('C')).toBe(1);
        expect(matriz.ordenPorCategoria.get('B')).toBe(2);
    });
    test('sin configuracion.zonas_extremas -> null (nunca lanza)', () => {
        expect(construirMatrizZonaExtremaDesdeConfiguracion({ regla_zonas_extremas_activa: true })).toBeNull();
        expect(construirMatrizZonaExtremaDesdeConfiguracion(null)).toBeNull();
    });
});

// TEST 17 explícito del pedido de revisión previa a 053: con V2 REAL activa
// (Equidad de Traslados ON, SIN Zonas Extremas — regla_zonas_extremas_activa
// ausente/false, mismo estado que reconstruirConfiguracionDesdeFilas()
// producirá para la fila V2 real una vez aplicada 053 + desplegado el
// código nuevo), resolverMatrizParaRodeo() DEBE devolver la matriz NORMAL
// para TODOS los rodeos — incluidos los de las asociaciones que son default
// de Zonas Extremas (MAGALLANES/AYSEN/CUYO) — porque V2 no tiene la regla.
// Los defaults de Zonas Extremas NUNCA deben "filtrarse" a una config que no
// los activó explícitamente.
describe('Motor con V2 REAL activa (sin Zonas Extremas) — los defaults NUNCA se aplican a una config que no los activó', () => {
    // Configuración representativa de la V2 REAL de producción, capturada en
    // el precheck de esta revisión (id 0ac4f340-968b-4076-9687-1b13cd358d6b,
    // numero_version=2): 1000 km (no 600 — distinta de V1 deliberadamente,
    // para no confundir "V2 real" con V1), EQUIDAD_TRASLADOS orden=1, umbral
    // 350km, SIN regla_zonas_extremas_activa (schema_version=2 nunca la tiene).
    function configV2Real() {
        return clonarConfiguracion(construirConfiguracionDefaultV1(), {
            schema_version: 2,
            distancia_maxima_km: 1000,
            regla_equidad_traslados_activa: true,
            umbral_lejania_km: 350,
            ordenCriterios: [
                { criterio_codigo: 'EQUIDAD_TRASLADOS', orden: 1 },
                { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 2 },
                { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 3 },
                { criterio_codigo: 'MENOR_DISTANCIA', orden: 4 }
            ]
            // Deliberadamente SIN regla_zonas_extremas_activa ni zonas_extremas
            // — schema_version=2 nunca los tiene (ni siquiera undefined vs false
            // debería importar: construirMatrizZonaExtremaDesdeConfiguracion ya
            // trata ambos como "inactiva").
        });
    }

    test('construirMatrizZonaExtremaDesdeConfiguracion(V2 real) -> null (V2 nunca tiene la regla)', () => {
        expect(construirMatrizZonaExtremaDesdeConfiguracion(configV2Real())).toBeNull();
    });

    test('resolverMatrizParaRodeo con V2 real -> matriz NORMAL para MAGALLANES/AYSEN/CUYO (defaults de Zonas Extremas nunca se filtran a V2)', () => {
        const config = configV2Real();
        const matrizPorClasificacion = construirMatrizPorClasificacionDesdeConfiguracion(config.matriz);
        const matrizZE = construirMatrizZonaExtremaDesdeConfiguracion(config); // null, V2 no la tiene
        for (const asociacion of ['MAGALLANES', 'AYSEN', 'CUYO', 'ARICA Y TARAPACA', 'NORTE GRANDE']) {
            const rodeo = rodeoInterno('r1', { asociacion, clasificacion_codigo: 'provincial', fecha: '2026-09-05' });
            const r = resolverMatrizParaRodeo(rodeo, matrizPorClasificacion, matrizZE, undefined);
            expect(r.fuente).toBe('NORMAL');
            expect(r.asociacion).toBeNull();
            expect(r.matriz).toBe(matrizPorClasificacion.provincial);
        }
    });

    test('ejecutarSimulacion con V2 real y rodeo MAGALLANES -> gana según la matriz NORMAL de Provincial (B->A), NUNCA la especial C->B', () => {
        const jB = jurado('j-b', { categoria: 'B', comunaTexto: 'ComunaComun', nombre: 'JB' });
        const jC = jurado('j-c', { categoria: 'C', comunaTexto: 'ComunaComun', nombre: 'JC' }); // C no elegible en Provincial normal
        const r = rodeoInterno('r1', { fecha: '2026-09-05', clasificacion_codigo: 'provincial', asociacion: 'MAGALLANES', comunaObj: COMUNA });
        const ctx = contexto({
            rodeos: [r], jurados: [jB, jC],
            disponibilidadPorJurado: { 'j-b': rangoFechas('2026-09-05', 1), 'j-c': rangoFechas('2026-09-05', 1) },
            comunas: [COMUNA]
        });
        const res = ejecutarSimulacion(ctx, 10, configV2Real());
        expect(res.resultados[0].estado).toBe('PROPUESTO');
        expect(res.resultados[0].jurado_propuesto.categoria).toBe('B'); // normal Provincial: B->A, C no elegible
        expect(res.resultados[0].zona_extrema).toBeNull();
    });
});

describe('resolverMatrizParaRodeo — precedencia Zona Extrema sobre matriz normal (sección 9/10/11)', () => {
    const configNormalV1 = construirConfiguracionDefaultV1();
    const matrizNormal = construirMatrizPorClasificacionDesdeConfiguracion(configNormalV1.matriz);

    test('TEST 41: rodeo MAGALLANES (incluido) -> zona_extrema=true, fuente ZONA_EXTREMA', () => {
        const config = configZonaExtrema();
        const matrizZE = construirMatrizZonaExtremaDesdeConfiguracion(config);
        const rodeo = rodeoInterno('r1', { asociacion: 'Magallanes', clasificacion_codigo: 'interasociaciones', fecha: '2026-09-05' });
        const r = resolverMatrizParaRodeo(rodeo, matrizNormal, matrizZE, config.zonas_extremas.asociaciones);
        expect(r.fuente).toBe('ZONA_EXTREMA');
        expect(r.asociacion).toBe('Magallanes');
        expect(r.matriz).toBe(matrizZE);
    });
    test('TEST 41: rodeo SANTIAGO (no incluido) -> zona_extrema=false, fuente NORMAL', () => {
        const config = configZonaExtrema();
        const matrizZE = construirMatrizZonaExtremaDesdeConfiguracion(config);
        const rodeo = rodeoInterno('r1', { asociacion: 'Santiago', clasificacion_codigo: 'interasociaciones', fecha: '2026-09-05' });
        const r = resolverMatrizParaRodeo(rodeo, matrizNormal, matrizZE, config.zonas_extremas.asociaciones);
        expect(r.fuente).toBe('NORMAL');
        expect(r.asociacion).toBeNull();
        expect(r.matriz).toBe(matrizNormal.interasociaciones);
    });
    test('TEST 42: MAGALLANES + Provincial -> usa C->B especial, NUNCA B->A normal', () => {
        const config = configZonaExtrema();
        const matrizZE = construirMatrizZonaExtremaDesdeConfiguracion(config);
        const rodeo = rodeoInterno('r1', { asociacion: 'MAGALLANES', clasificacion_codigo: 'provincial', fecha: '2026-09-05' });
        const r = resolverMatrizParaRodeo(rodeo, matrizNormal, matrizZE, config.zonas_extremas.asociaciones);
        expect(r.fuente).toBe('ZONA_EXTREMA');
        expect(r.matriz.elegibles.has('C')).toBe(true);
        expect(r.matriz.elegibles.has('A')).toBe(false); // normal Provincial SÍ tendría A elegible — acá NO
    });
    test('TEST 43: AYSEN + Interasociaciones -> usa C->B especial, NUNCA A->B normal', () => {
        const config = configZonaExtrema();
        const matrizZE = construirMatrizZonaExtremaDesdeConfiguracion(config);
        const rodeo = rodeoInterno('r1', { asociacion: 'AYSEN', clasificacion_codigo: 'interasociaciones', fecha: '2026-09-05' });
        const r = resolverMatrizParaRodeo(rodeo, matrizNormal, matrizZE, config.zonas_extremas.asociaciones);
        expect(r.fuente).toBe('ZONA_EXTREMA');
        expect(r.matriz.ordenPorCategoria.get('C')).toBe(1);
    });
    test('comparación normalizada (case/tilde/guion-insensible) — "Aysén" incluida como "AYSEN"', () => {
        const config = configZonaExtrema();
        const matrizZE = construirMatrizZonaExtremaDesdeConfiguracion(config);
        const rodeo = rodeoInterno('r1', { asociacion: 'Aysén', clasificacion_codigo: 'provincial', fecha: '2026-09-05' });
        const r = resolverMatrizParaRodeo(rodeo, matrizNormal, matrizZE, config.zonas_extremas.asociaciones);
        expect(r.fuente).toBe('ZONA_EXTREMA');
    });
});

describe('construirExplicacionZonaExtrema — narrativa "¿por qué ganó?" (sección 16)', () => {
    test('nunca menciona la clasificación normal sustituida', () => {
        const texto = construirExplicacionZonaExtrema('MAGALLANES', ['C', 'B']);
        expect(texto).toContain('Zona Extrema');
        expect(texto).toContain('MAGALLANES');
        expect(texto).toContain('C → B');
        expect(texto).not.toMatch(/interasociaciones|provincial/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// INTEGRACIÓN — ejecutarSimulacion()
// ═════════════════════════════════════════════════════════════════════════
describe('ejecutarSimulacion — Zona Extrema activa (secciones 42-52)', () => {
    function fixtureCyB(fecha = '2026-09-05', { clasificacion_codigo = 'provincial', asociacionRodeo = 'MAGALLANES' } = {}) {
        const jC = jurado('j-c', { categoria: 'C', comunaTexto: 'ComunaComun', nombre: 'JC' });
        const jB = jurado('j-b', { categoria: 'B', comunaTexto: 'ComunaComun', nombre: 'JB' });
        const jA = jurado('j-a', { categoria: 'A', comunaTexto: 'ComunaComun', nombre: 'JA' });
        const r = rodeoInterno('r1', { fecha, clasificacion_codigo, asociacion: asociacionRodeo, comunaObj: COMUNA });
        return contexto({
            rodeos: [r], jurados: [jC, jB, jA],
            disponibilidadPorJurado: { 'j-c': rangoFechas(fecha, 1), 'j-b': rangoFechas(fecha, 1), 'j-a': rangoFechas(fecha, 1) },
            comunas: [COMUNA]
        });
    }

    test('TEST 44: candidatos C y B válidos -> C gana PRIORIDAD_CATEGORIA (prioridad especial)', () => {
        const config = configZonaExtrema();
        const res = ejecutarSimulacion(fixtureCyB(), 10, config);
        const fila = res.resultados[0];
        expect(fila.estado).toBe('PROPUESTO');
        expect(fila.jurado_propuesto.jurado_id).toBe('j-c');
        expect(fila.zona_extrema).toEqual({ activa: true, asociacion: 'MAGALLANES', prioridad_categorias: ['C', 'B'] });
        expect(fila.jurado_propuesto.zona_extrema_explicacion).toContain('Zona Extrema');
    });

    test('TEST 42: override Provincial — MAGALLANES + Provincial gana con C (normal Provincial habría hecho ganar a B)', () => {
        const config = configZonaExtrema();
        const res = ejecutarSimulacion(fixtureCyB('2026-09-05', { clasificacion_codigo: 'provincial' }), 10, config);
        expect(res.resultados[0].jurado_propuesto.categoria).toBe('C');
    });

    test('TEST 43: override Interasociaciones — AYSEN + Interasociaciones gana con C (normal habría hecho ganar a A)', () => {
        const config = configZonaExtrema();
        const res = ejecutarSimulacion(fixtureCyB('2026-09-05', { clasificacion_codigo: 'interasociaciones', asociacionRodeo: 'AYSEN' }), 10, config);
        expect(res.resultados[0].jurado_propuesto.categoria).toBe('C');
    });

    test('TEST 45: solo A disponible (C/B no elegibles por categoría) -> SIN_PROPUESTA, A nunca propuesto automáticamente', () => {
        const jA = jurado('j-a', { categoria: 'A', comunaTexto: 'ComunaComun', nombre: 'JA' });
        const r = rodeoInterno('r1', { fecha: '2026-09-05', clasificacion_codigo: 'provincial', asociacion: 'MAGALLANES', comunaObj: COMUNA });
        const ctx = contexto({ rodeos: [r], jurados: [jA], disponibilidadPorJurado: { 'j-a': rangoFechas('2026-09-05', 1) }, comunas: [COMUNA] });
        const config = configZonaExtrema();
        const res = ejecutarSimulacion(ctx, 10, config);
        expect(res.resultados[0].estado).toBe('SIN_PROPUESTA');
        // A aparece en descartados con causa CATEGORIA_INCOMPATIBLE — MISMO
        // mecanismo de advertencia ya existente (sección 4/17: reutilizado,
        // sin causa nueva), nunca invisible.
        const descartadoA = res.resultados[0].descartados.find(d => d.jurado_id === 'j-a');
        expect(descartadoA.causas).toContain('CATEGORIA_INCOMPATIBLE');
    });

    test('TEST 46: A manual vía evaluarCandidatoDirecto — elegible=false pero evaluable directamente con causa CATEGORIA_INCOMPATIBLE (selección manual con confirmación, sin escritura real)', () => {
        const jA = jurado('j-a', { categoria: 'A', comunaTexto: 'ComunaComun', nombre: 'JA' });
        const r = rodeoInterno('r1', { fecha: '2026-09-05', clasificacion_codigo: 'provincial', asociacion: 'MAGALLANES', comunaObj: COMUNA });
        const ctx = contexto({ rodeos: [r], jurados: [jA], disponibilidadPorJurado: { 'j-a': rangoFechas('2026-09-05', 1) }, comunas: [COMUNA] });
        const config = configZonaExtrema();
        const resultado = evaluarCandidatoDirecto(ctx, 'r1', 'j-a', config);
        expect(resultado.error).toBeUndefined();
        expect(resultado.evaluacion.elegible).toBe(false);
        expect(resultado.evaluacion.causas).toContain('CATEGORIA_INCOMPATIBLE');
        // El llamador (ruta) puede mostrar el aviso "Zona Extrema" sin recalcular.
        expect(resultado.zonaExtrema).toEqual({ asociacion: 'MAGALLANES' });
    });

    test('TEST 47: A habilitado (C1 B2 A3) -> elegible automático, puede ganar si es el único disponible', () => {
        const jA = jurado('j-a', { categoria: 'A', comunaTexto: 'ComunaComun', nombre: 'JA' });
        const r = rodeoInterno('r1', { fecha: '2026-09-05', clasificacion_codigo: 'provincial', asociacion: 'MAGALLANES', comunaObj: COMUNA });
        const ctx = contexto({ rodeos: [r], jurados: [jA], disponibilidadPorJurado: { 'j-a': rangoFechas('2026-09-05', 1) }, comunas: [COMUNA] });
        const config = configZonaExtrema({
            categorias: [
                { categoria: 'A', elegible: true, orden_preferencia: 3 },
                { categoria: 'B', elegible: true, orden_preferencia: 2 },
                { categoria: 'C', elegible: true, orden_preferencia: 1 }
            ]
        });
        const res = ejecutarSimulacion(ctx, 10, config);
        expect(res.resultados[0].estado).toBe('PROPUESTO');
        expect(res.resultados[0].jurado_propuesto.jurado_id).toBe('j-a');
    });

    test('TEST 48: asociación quitada de la lista -> vuelve a matriz normal (MAGALLANES ya no incluida)', () => {
        const config = configZonaExtrema({ asociaciones: ['AYSEN', 'CUYO'] }); // MAGALLANES ya no está
        const res = ejecutarSimulacion(fixtureCyB('2026-09-05', { clasificacion_codigo: 'provincial', asociacionRodeo: 'MAGALLANES' }), 10, config);
        // Provincial normal: B->A, C no elegible -> gana B (no C).
        expect(res.resultados[0].jurado_propuesto.categoria).toBe('B');
        expect(res.resultados[0].zona_extrema).toBeNull();
    });

    test('TEST 30/49: configuración histórica — dos configuraciones distintas, cada una decide por su cuenta (no hay lista global mutable)', () => {
        const configX = configZonaExtrema({ asociaciones: ['MAGALLANES'] });
        const configY = configZonaExtrema({ asociaciones: ['AYSEN'] }); // MAGALLANES normal en Y
        const resX = ejecutarSimulacion(fixtureCyB('2026-09-05', { clasificacion_codigo: 'provincial', asociacionRodeo: 'MAGALLANES' }), 10, configX);
        const resY = ejecutarSimulacion(fixtureCyB('2026-09-05', { clasificacion_codigo: 'provincial', asociacionRodeo: 'MAGALLANES' }), 10, configY);
        expect(resX.resultados[0].zona_extrema).not.toBeNull(); // X: MAGALLANES sigue extrema
        expect(resY.resultados[0].zona_extrema).toBeNull();     // Y: MAGALLANES ya no está en Y -> normal
    });

    test('TEST 50: Zona Extrema NO relaja otras reglas — candidato C sin disponibilidad sigue descartado por DISPONIBILIDAD', () => {
        const jC = jurado('j-c', { categoria: 'C', comunaTexto: 'ComunaComun', nombre: 'JC' });
        const r = rodeoInterno('r1', { fecha: '2026-09-05', clasificacion_codigo: 'provincial', asociacion: 'MAGALLANES', comunaObj: COMUNA });
        const ctx = contexto({ rodeos: [r], jurados: [jC], disponibilidadPorJurado: {}, comunas: [COMUNA] }); // sin disponibilidad
        const config = configZonaExtrema();
        const res = ejecutarSimulacion(ctx, 10, config);
        expect(res.resultados[0].estado).toBe('SIN_PROPUESTA');
        expect(res.resultados[0].descartados[0].causas).toContain('DISPONIBILIDAD');
    });

    test('TEST 51: Zona Extrema coexiste con distancia máxima activa (hard rule intacta)', () => {
        const jC = jurado('j-c', { categoria: 'C', comunaTexto: null, nombre: 'JC' }); // sin comuna resoluble
        const r = rodeoInterno('r1', { fecha: '2026-09-05', clasificacion_codigo: 'provincial', asociacion: 'MAGALLANES', comunaObj: COMUNA });
        const ctx = contexto({ rodeos: [r], jurados: [jC], disponibilidadPorJurado: { 'j-c': rangoFechas('2026-09-05', 1) }, comunas: [COMUNA] });
        const config = configZonaExtrema(); // distancia_maxima_activa=true heredado de V1 (600km)
        const res = ejecutarSimulacion(ctx, 10, config);
        expect(res.resultados[0].estado).toBe('SIN_PROPUESTA');
        expect(res.resultados[0].descartados[0].causas).toContain('JURADO_SIN_COMUNA_RESOLVIBLE');
    });

    test('TEST 52: multirodeo — Zona Extrema convive con designaciones temporales del mismo lote (MENOS_DESIGNACIONES_TEMPORADA sigue decidiendo dentro del empate de categoría)', () => {
        const jC1 = jurado('jC1', { categoria: 'C', comunaTexto: 'ComunaComun', nombre: 'C1' });
        const jC2 = jurado('jC2', { categoria: 'C', comunaTexto: 'ComunaComun', nombre: 'C2' });
        const r1 = rodeoInterno('r1', { fecha: '2026-09-05', clasificacion_codigo: 'provincial', asociacion: 'MAGALLANES', comunaObj: COMUNA });
        const r2 = rodeoInterno('r2', { fecha: '2026-10-17', clasificacion_codigo: 'provincial', asociacion: 'MAGALLANES', comunaObj: COMUNA });
        const ctx = contexto({
            rodeos: [r1, r2], jurados: [jC1, jC2],
            disponibilidadPorJurado: { jC1: [...rangoFechas('2026-09-05', 1), ...rangoFechas('2026-10-17', 1)], jC2: [...rangoFechas('2026-09-05', 1), ...rangoFechas('2026-10-17', 1)] },
            comunas: [COMUNA]
        });
        const config = configZonaExtrema();
        const res = ejecutarSimulacion(ctx, 10, config);
        const fila1 = res.resultados.find(r => r.rodeo_id === 'r1');
        const fila2 = res.resultados.find(r => r.rodeo_id === 'r2');
        expect(fila1.zona_extrema).not.toBeNull();
        expect(fila2.zona_extrema).not.toBeNull();
        // Distintos ganadores (equidad de designaciones temporal decide dentro del empate de categoría C).
        expect(fila1.jurado_propuesto.jurado_id).not.toBe(fila2.jurado_propuesto.jurado_id);
    });

    test('ranking sin Zona Extrema (schema_version=1/V1) permanece IDÉNTICO — guarda de regresión explícita', () => {
        const configV1 = construirConfiguracionDefaultV1();
        const res = ejecutarSimulacion(fixtureCyB('2026-09-05', { clasificacion_codigo: 'provincial', asociacionRodeo: 'MAGALLANES' }), 10, configV1);
        // V1 normal Provincial: B->A, C no elegible -> gana B.
        expect(res.resultados[0].jurado_propuesto.categoria).toBe('B');
        // Siempre presente (mismo patrón que traslados_temporada/equidad_
        // traslados_explicacion) pero null: V1 nunca activa Zona Extrema.
        expect(res.resultados[0].zona_extrema).toBeNull();
    });
});

describe('validarConfiguracion — Zonas Extremas (guarda de integridad estructural)', () => {
    test('schema_version=3 sin zonas extremas activas es válida (equivalente funcional a schema_version=2)', () => {
        const config = clonarConfiguracion(construirConfiguracionDefaultV1(), { schema_version: 3 });
        expect(validarConfiguracion(config)).toEqual({ valido: true });
    });
    test('regla activa + 0 asociaciones -> inválida', () => {
        const config = configZonaExtrema({ asociaciones: [] });
        expect(validarConfiguracion(config).valido).toBe(false);
    });
    test('regla activa + asociaciones duplicadas (normalizadas) -> inválida', () => {
        const config = configZonaExtrema({ asociaciones: ['MAGALLANES', 'magallanes'] });
        expect(validarConfiguracion(config).valido).toBe(false);
    });
    test('regla activa + 0 categorías elegibles -> inválida', () => {
        const config = configZonaExtrema({ categorias: [
            { categoria: 'A', elegible: false, orden_preferencia: null },
            { categoria: 'B', elegible: false, orden_preferencia: null },
            { categoria: 'C', elegible: false, orden_preferencia: null }
        ] });
        expect(validarConfiguracion(config).valido).toBe(false);
    });
    test('schema_version=1/2 con regla_zonas_extremas_activa=true -> inválida (requiere schema_version=3)', () => {
        const config = clonarConfiguracion(construirConfiguracionDefaultV1(), {
            regla_zonas_extremas_activa: true,
            zonas_extremas: { asociaciones: ['MAGALLANES'], categorias: ZONA_EXTREMA_CATEGORIAS_DEFAULT }
        });
        expect(validarConfiguracion(config).valido).toBe(false);
    });
});
