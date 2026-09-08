// ═════════════════════════════════════════════════════════════════════════
// Motor de Propuesta de Designación de Jurados — Etapa 3, MODO DRY-RUN.
//
// Analiza rodeos y jurados reales y devuelve una SIMULACIÓN: 1 jurado
// propuesto por rodeo, o SIN_PROPUESTA / NO_EVALUABLE con la explicación
// completa de por qué. NO escribe nada en la base de datos — no inserta,
// no actualiza, no elimina asignaciones. Es efímero: cada llamada calcula
// todo desde cero, no persiste ningún estado entre corridas.
//
// Diseño en dos capas (mismo patrón que resolverComuna en geografia.js):
//   - cargarDatosMotor(rodeoIds)  → hace TODAS las queries (batch, sin N+1)
//     y arma un "contexto" en memoria.
//   - ejecutarSimulacion(contexto) → función PURA (no toca la BD) que
//     aplica todas las reglas y devuelve el resultado. Se puede testear con
//     fixtures sintéticas sin base de datos, y será reutilizable por la
//     futura creación real de propuestas (Etapa 4+) sin reimplementar nada.
//   - generarSimulacion(rodeoIds) → junta ambas, es lo que usa el endpoint.
// ═════════════════════════════════════════════════════════════════════════
const supabase = require('../config/supabase');
const { resolverComuna, calcularDistanciaKm, cargarCatalogoResolucionComunas } = require('./geografia');
const { normalizarAsociacion, mismaAsociacion } = require('./asociaciones');
const { calcularBloqueRodeo, contarSabadosEntre, rangoFechas } = require('./feriados');
const {
    construirConfiguracionDefaultV1, validarConfiguracion, configuracionRequiereDistancia, clasificarTraslado
} = require('./configuracionDesignacion');

// Etapa 2 — Configuración de Propuesta de Designación. Valor histórico
// (equivalente a configuracion.distancia_maxima_km de la Versión 1) que se
// mantiene exportado únicamente por compatibilidad con tests existentes y
// como referencia documental — YA NO se lee dentro de evaluarCandidato():
// la evaluación real usa siempre configuracion.regla_distancia_maxima_activa
// + configuracion.distancia_maxima_km (ver sección 11 del pedido de Etapa 2).
const DISTANCIA_MAXIMA_KM = 600;
const PAGINA = 900; // mismo tamaño de página usado en el resto del proyecto (analisis-preguntas.js, jurados-disponibles)

// topN para ejecutarSimulacion()/generarSimulacion(): cuántos candidatos del
// grupo final (ya filtrado por preferencia de categoría) se devuelven en
// top_candidatos. Con el topN por defecto (5) es "los 5 mejores, para
// auditoría del dry-run". Las pantallas que necesitan "prácticamente todos
// los candidatos elegibles" (paneles de Designar/Modificar, revalidación al
// guardar) usan esta constante en vez de repetir un número mágico: es mayor
// que cualquier tamaño realista del padrón de jurados activos (~110 hoy), así
// que `grupo.slice(0, topN)` nunca trunca — no es un sentinel ni un hack,
// es simplemente "sin límite práctico" expresado como un topN válido de la
// misma API pública que ya usa el dry-run.
const TOP_N_TODOS_LOS_CANDIDATOS = 999;

// Orden de prioridad para decidir la "causa_principal" cuando un candidato
// incumple más de una regla (se cuentan TODAS las causas en el resumen de
// descartes — opción B del enunciado — pero causa_principal usa este orden
// fijo, que sigue la numeración de las reglas documentadas: 0 disponibilidad,
// 1 misma asociación, 2 asociación repetida, 3 finde consecutivo,
// 4 mismo finde, 6 categoría, comuna del jurado, 5 distancia).
const ORDEN_CAUSA_PRINCIPAL = [
    'DISPONIBILIDAD',
    'MISMA_ASOCIACION',
    'ASOCIACION_REPETIDA_TEMPORADA',
    'FINDE_CONSECUTIVO',
    'MISMO_FINDE',
    'CATEGORIA_INCOMPATIBLE',
    'JURADO_SIN_COMUNA_RESOLVIBLE',
    'DISTANCIA_EXCEDIDA'
];

// ─── Criterio único de "asignación efectiva para el motor" ────────────────
// Etapa 3.1 — aprobado: coincide con el criterio ya usado por Hoja de Vida
// (routes/admin/hojavida.js) y por el cálculo de pagos (services/calculo.js).
// Este es el ÚNICO lugar del motor que decide si una fila de `asignaciones`
// cuenta como designación efectiva (para equidad, repetición de asociación,
// mismo fin de semana y fin de semana consecutivo). No se repite este
// criterio en ninguna otra parte del algoritmo — todo lo demás consume
// `asignacionesTemporada`, que ya viene filtrada por esta función.
//
//   CUENTA:     estado != 'anulado'  Y  estado_designacion en {pendiente, aceptado, null(legacy)}
//   NO CUENTA:  estado = 'anulado'   O  estado_designacion = 'rechazado'
//
// `publicado`/`publicado_en`/`publicado_por` NO interviene en este criterio
// (una asignación pendiente de publicación cuenta igual que una publicada).
// No se modifica ni se elimina ninguna fila — es un filtro de lectura.
function esAsignacionEfectiva(asignacion) {
    if (asignacion.estado === 'anulado') return false;
    if (asignacion.estado_designacion === 'rechazado') return false;
    return true;
}

// ─── Filtro de "rodeos sin jurado efectivo" (buscador del laboratorio) ────
// Etapa 3.1 — usado por GET /admin/propuesta-designacion/rodeos-disponibles.
// Reutiliza esAsignacionEfectiva (mismo criterio único, sin duplicarlo): un
// rodeo cuyas únicas asignaciones son rechazadas y/o anuladas se considera
// "sin jurado" y debe seguir apareciendo en la búsqueda. Función pura —
// recibe listas ya cargadas (rodeos + asignaciones de esos rodeos), no hace
// queries — para que el endpoint la use sin duplicar el filtro y para que
// sea testeable sin base de datos.
function filtrarRodeosSinJuradoEfectivo(rodeos, asignaciones) {
    const rodeosConJurado = new Set((asignaciones || []).filter(esAsignacionEfectiva).map(a => a.rodeo_id));
    return (rodeos || []).filter(r => !rodeosConJurado.has(r.id));
}

// ─── Helpers puros de bloques (fin de semana del rodeo) ────────────────────
function bloquesSeSuperponen(b1, b2) {
    return b1.inicio <= b2.fin && b2.inicio <= b1.fin;
}
// "Consecutivos": no se superponen y no hay ningún sábado libre entre medio,
// en cualquier dirección (a→b o b→a). Ver services/feriados.js para el
// algoritmo de bloque/feriados reutilizado tal cual desde asignaciones.js.
function bloquesSonConsecutivos(b1, b2) {
    if (bloquesSeSuperponen(b1, b2)) return false;
    if (b1.fin < b2.inicio) return contarSabadosEntre(b1.fin, b2.inicio) === 0;
    if (b2.fin < b1.inicio) return contarSabadosEntre(b2.fin, b1.inicio) === 0;
    return false;
}

// ─── Deriva, desde configuracion.matriz (modelo versionado de la Etapa 1:
// por clasificación, un array con LAS 3 categorías A/B/C siempre presentes,
// cada una con {categoria, elegible, orden_preferencia}), la estructura
// interna que evaluarCandidato() necesita: { elegibles: Set,
// ordenPorCategoria: Map }. Reemplaza la derivación legacy que antes se
// armaba desde clasificacion_categoria_matriz (contexto.matrizPorCodigo,
// retirado en Etapa 3 — ver cargarDatosMotor) — la selección usa SIEMPRE
// esta matriz derivada de la configuración (BD real desde Etapa 3).
function construirMatrizPorClasificacionDesdeConfiguracion(configuracionMatriz) {
    const resultado = {};
    for (const [clasifCodigo, filas] of Object.entries(configuracionMatriz || {})) {
        const elegibles = new Set();
        const ordenPorCategoria = new Map();
        for (const f of (filas || [])) {
            if (f.elegible) {
                elegibles.add(f.categoria);
                ordenPorCategoria.set(f.categoria, f.orden_preferencia);
            }
        }
        resultado[clasifCodigo] = { elegibles, ordenPorCategoria };
    }
    return resultado;
}

// ═════════════════════════════════════════════════════════════════════════
// Mejora "Zonas Extremas" (schema_version=3) — para ciertas asociaciones
// organizadoras (configurables, ver configuracion.zonas_extremas — NUNCA
// hardcodeadas acá), la prioridad de categoría del jurado la decide una
// matriz especial versionada, con PRECEDENCIA total sobre la matriz normal
// por clasificación (sección 2/3/9/10 del pedido) — no importa si el rodeo
// es interclubes/provincial/interasociaciones/zonal/clasificatorio/
// nacional. Ninguna otra regla del motor se ve afectada (sección 12): solo
// sustituye la FUENTE de elegibilidad/prioridad de categoría que ya
// consume evaluarCandidato() a través de `matriz` — la función en sí no se
// toca ni se duplica.
// ═════════════════════════════════════════════════════════════════════════

// ─── Deriva la matriz especial de Zonas Extremas, si la regla está activa
// y configurada — MISMA función de derivación que la matriz normal
// (construirMatrizPorClasificacionDesdeConfiguracion), aplicada a una única
// "pseudo-clasificación" interna ZONA_EXTREMA — nunca una segunda
// implementación de "¿qué categorías son elegibles y en qué orden?".
// @returns {elegibles, ordenPorCategoria} | null (regla inactiva, o sin categorías configuradas)
function construirMatrizZonaExtremaDesdeConfiguracion(configuracion) {
    const c = configuracion || {};
    if (!c.regla_zonas_extremas_activa || !c.zonas_extremas?.categorias) return null;
    const derivada = construirMatrizPorClasificacionDesdeConfiguracion({ ZONA_EXTREMA: c.zonas_extremas.categorias });
    return derivada.ZONA_EXTREMA || null;
}

// ─── Resuelve la matriz de categorías EFECTIVA para UN rodeo — punto ÚNICO
// de la precedencia Zona Extrema vs. matriz normal (sección 15 del pedido:
// "resolverMatrizCategoriaParaRodeo"). Reutilizado por los 3 lugares que
// antes leían matrizPorClasificacion[rodeo.clasificacion_codigo]
// directamente (dificultad de procesamiento, evaluación real del lote,
// evaluarCandidatoDirecto) — así NUNCA puede haber inconsistencia entre
// ellos (sección 14: "simulación usa Zona Extrema pero dificultad usa
// Provincial" queda estructuralmente imposible, un solo resolver para los 3).
//
// La comparación de asociación reutiliza normalizarAsociacion() — MISMA
// función que ya usa el motor para "¿misma asociación?"/"¿asociación
// repetida en la temporada?" — nunca una comparación literal distinta.
//
// @param rodeo                  { asociacion, clasificacion_codigo, ... }
// @param matrizPorClasificacion resultado de construirMatrizPorClasificacionDesdeConfiguracion(configuracion.matriz)
// @param matrizZonaExtrema      resultado de construirMatrizZonaExtremaDesdeConfiguracion(configuracion) (o null)
// @param asociacionesZonaExtrema configuracion.zonas_extremas?.asociaciones || []
// @returns { matriz: {elegibles,ordenPorCategoria}|null, fuente:'NORMAL'|'ZONA_EXTREMA', asociacion: string|null }
function resolverMatrizParaRodeo(rodeo, matrizPorClasificacion, matrizZonaExtrema, asociacionesZonaExtrema) {
    if (matrizZonaExtrema && rodeo.asociacion) {
        const asocNorm = normalizarAsociacion(rodeo.asociacion);
        const coincide = (asociacionesZonaExtrema || []).some(a => normalizarAsociacion(a) === asocNorm);
        if (coincide) {
            return { matriz: matrizZonaExtrema, fuente: 'ZONA_EXTREMA', asociacion: rodeo.asociacion };
        }
    }
    const matriz = rodeo.clasificacion_codigo ? (matrizPorClasificacion[rodeo.clasificacion_codigo] || null) : null;
    return { matriz, fuente: 'NORMAL', asociacion: null };
}

// ─── Narrativa "¿Por qué ganó?" cuando Zona Extrema decidió la prioridad de
// categoría (sección 16 del pedido) — nunca se narra "Interasociaciones
// prioriza A" si Zona Extrema sustituyó esa regla. `categoriasOrdenadas`:
// ['C','B'] (orden ascendente de orden_preferencia, solo elegibles).
function construirExplicacionZonaExtrema(asociacion, categoriasOrdenadas) {
    return `Rodeo perteneciente a Zona Extrema (${asociacion}); se aplicó prioridad especial ${categoriasOrdenadas.join(' → ')}.`;
}

// ─── EQUIDAD_TRASLADOS — comparador dedicado (mejora "Equidad de Traslados") ─
// Recibe los resultados YA calculados de evaluarCandidato() (a.distanciaKm,
// a.trasladosTemporada — ver más abajo) — nunca vuelve a tocar la BD ni
// recalcula distancias/Haversine (eso ya existe en calcularDistanciaKm(),
// geografia.js — no se duplica ningún motor de distancia).
//
// Algoritmo (informe de diseño, secciones 9/14/15 del pedido):
//   NIVEL 0 — cercanía a ESTE rodeo SIEMPRE primero: un candidato CERCA de
//     este rodeo específico le gana a uno LEJOS de este mismo rodeo, sin
//     importar el historial de ninguno de los dos (sección 9: "A 220km debe
//     preferirse sobre B a 850km" — ambos elegibles, pero distinta clase
//     PARA ESTE rodeo). Esto es independiente de MENOR_DISTANCIA (que sigue
//     comparando el valor exacto sin redondeo si está configurado aparte).
//   NIVEL 1 — cuando ambos quedan en la MISMA clase (ambos CERCA o ambos
//     LEJOS de este rodeo), se balancea la carga histórica de la temporada
//     (secciones 11/12/13/14):
//     · Si el rodeo actual es LEJOS para ambos: preferir 1) quien NO tuvo su
//       última salida LEJOS, 2) luego menos salidas_lejos en la temporada,
//       3) luego menor proporción de carga lejos (salidas_lejos / total).
//     · Si el rodeo actual es CERCA para ambos: preferir 1) quien SÍ tuvo su
//       última salida LEJOS (compensación), 2) luego MÁS salidas_lejos en la
//       temporada (compensación), como indica la sección 12.
// Candidatos sin distancia resoluble (clasificación null) quedan al final —
// en la práctica no debería ocurrir: si EQUIDAD_TRASLADOS está activo,
// configuracionRequiereDistancia() ya exige comuna resoluble como regla dura
// (JURADO_SIN_COMUNA_RESOLVIBLE), así que todo candidato que llega hasta acá
// ya tiene distanciaKm no-null.
function compararEquidadTraslados(a, b, umbralLejaniaKm) {
    const claseA = clasificarTraslado(a.distanciaKm, umbralLejaniaKm);
    const claseB = clasificarTraslado(b.distanciaKm, umbralLejaniaKm);
    const rango = (clase) => clase === 'CERCA' ? 0 : clase === 'LEJOS' ? 1 : 2;
    if (rango(claseA) !== rango(claseB)) return rango(claseA) - rango(claseB);
    if (claseA === null) return 0; // ambos sin distancia resoluble — empate, no debería ocurrir en la práctica (ver comentario arriba)

    const cargaA = a.trasladosTemporada || { salidas_cerca: 0, salidas_lejos: 0, ultima_salida_tipo: null };
    const cargaB = b.trasladosTemporada || { salidas_cerca: 0, salidas_lejos: 0, ultima_salida_tipo: null };
    const proporcionLejos = (c) => {
        const total = c.salidas_cerca + c.salidas_lejos;
        return total === 0 ? 0 : c.salidas_lejos / total;
    };

    if (claseA === 'LEJOS') {
        // 1) preferir quien NO tuvo última salida LEJOS
        const ultA = cargaA.ultima_salida_tipo === 'LEJOS' ? 1 : 0;
        const ultB = cargaB.ultima_salida_tipo === 'LEJOS' ? 1 : 0;
        if (ultA !== ultB) return ultA - ultB;
        // 2) menos salidas lejos en la temporada
        if (cargaA.salidas_lejos !== cargaB.salidas_lejos) return cargaA.salidas_lejos - cargaB.salidas_lejos;
        // 3) menor proporción/carga de viajes lejos
        return proporcionLejos(cargaA) - proporcionLejos(cargaB);
    }
    // claseA === 'CERCA' (== claseB, ya empatadas arriba)
    // 1) preferir quien SÍ tuvo última salida LEJOS (compensación)
    const ultA = cargaA.ultima_salida_tipo === 'LEJOS' ? 0 : 1;
    const ultB = cargaB.ultima_salida_tipo === 'LEJOS' ? 0 : 1;
    if (ultA !== ultB) return ultA - ultB;
    // 2) mayor carga de viajes lejos en la temporada (compensación)
    if (cargaA.salidas_lejos !== cargaB.salidas_lejos) return cargaB.salidas_lejos - cargaA.salidas_lejos;
    return 0;
}

// ─── "¿Por qué ganó?" — narrativa de Equidad de Traslados (informe, sección
// 41; revisión de cierre, sección 19) ──────────────────────────────────────
// Pura, solo texto — nunca decide nada, se llama DESPUÉS de que el ganador
// ya está determinado. `clasificacionActual` es la del GANADOR respecto al
// rodeo que se está proponiendo; `trasladosTemporada` es su carga de la
// temporada (calcularCargaTraslados()), tal cual la vio el comparador.
//
// `fueDecisivo` (revisión de cierre — bloqueante de negocio, sección 19): que
// EQUIDAD_TRASLADOS "forme parte del orden" (y sea Nº1) NO basta para decir
// que fue la razón de la victoria — pudo haber quedado EMPATADO contra el
// segundo candidato del grupo (mismo clasificación CERCA/LEJOS, misma carga
// histórica) y haber sido en realidad OTRO criterio posterior el que decidió.
// El llamador (ejecutarSimulacion) calcula esto comparando al ganador contra
// el candidato inmediatamente siguiente (grupo[1]) con el MISMO comparador
// que usó el ranking real — nunca se infiere ni se aproxima acá.
function construirExplicacionEquidadTraslados(fueDecisivo, clasificacionActual, trasladosTemporada) {
    if (!clasificacionActual || !trasladosTemporada) return null;
    const ultimaTxt = trasladosTemporada.ultima_salida_tipo === 'LEJOS' ? 'lejana'
        : trasladosTemporada.ultima_salida_tipo === 'CERCA' ? 'cercana' : null;

    let descripcion;
    if (clasificacionActual === 'LEJOS') {
        descripcion = ultimaTxt
            ? `Última salida ${ultimaTxt}; ${trasladosTemporada.salidas_lejos} viaje(s) lejano(s) esta temporada`
            : `Sin salidas previas esta temporada; ${trasladosTemporada.salidas_lejos} viaje(s) lejano(s) hasta ahora`;
    } else {
        // clasificacionActual === 'CERCA'
        descripcion = trasladosTemporada.ultima_salida_tipo === 'LEJOS'
            ? 'Última salida lejana; priorizado para una salida cercana'
            : (ultimaTxt ? `Última salida ${ultimaTxt}; sin viaje lejano reciente que compensar` : 'Sin salidas previas esta temporada');
    }

    // Decisivo: se presenta como la razón real de la selección (fraseo tal
    // cual). NO decisivo: se marca explícitamente como empate — el mismo
    // dato queda como CONTEXTO, nunca como "ganó por esto" (sección 19: "no
    // decir que ganó por equidad" cuando otro criterio fue quien decidió).
    return fueDecisivo ? descripcion : `Equidad de traslados: empate (${descripcion}) — decidido por otro criterio`;
}

// ─── Comparación de dos candidatos (ya evaluados) según UN criterio ───────
// Recibe los resultados de evaluarCandidato() para a y b — nunca vuelve a
// tocar la BD ni recalcula nada, solo lee los campos ya calculados.
//   PRIORIDAD_CATEGORIA           → categoriaOrdenPreferencia ascendente
//                                    (menor número = mejor categoría).
//   MENOS_DESIGNACIONES_TEMPORADA → designacionesAntes ascendente.
//   MENOR_DISTANCIA               → distanciaKm ascendente, valor REAL sin
//                                    redondeo ni tolerancia (sección 19 del
//                                    pedido — "10.1 km gana a 10.2 km" es
//                                    intencional cuando este criterio ocupa
//                                    la primera prioridad).
//   EQUIDAD_TRASLADOS             → ver compararEquidadTraslados() arriba
//                                    (nuevo criterio, mejora "Equidad de
//                                    Traslados" — MENOR_DISTANCIA NO se toca).
// Un código desconocido nunca debería llegar aquí (validarConfiguracion ya
// lo rechaza antes de ejecutar) — se trata como empate (0) por seguridad.
// `umbralLejaniaKm` solo lo usa EQUIDAD_TRASLADOS — se recibe aparte (no
// dentro de a/b) porque es un PARÁMETRO de la configuración, no un dato
// calculado por candidato.
function compararPorCriterio(criterioCodigo, a, b, umbralLejaniaKm) {
    switch (criterioCodigo) {
        case 'PRIORIDAD_CATEGORIA': {
            const oa = a.categoriaOrdenPreferencia ?? Infinity;
            const ob = b.categoriaOrdenPreferencia ?? Infinity;
            return oa - ob;
        }
        case 'MENOS_DESIGNACIONES_TEMPORADA':
            return a.designacionesAntes - b.designacionesAntes;
        case 'MENOR_DISTANCIA': {
            const da = a.distanciaKm ?? Infinity;
            const db = b.distanciaKm ?? Infinity;
            return da - db;
        }
        case 'EQUIDAD_TRASLADOS':
            return compararEquidadTraslados(a, b, umbralLejaniaKm);
        default:
            return 0;
    }
}

// ─── Comparador jerárquico determinístico — Nivel 1 de la configuración ──
// Recorre configuracion.ordenCriterios en su orden configurado (1..N,
// SOLO los criterios activos — un código ausente = inactivo, igual que en
// la migración 050) y compara por el primero que no empate. Si TODOS
// empatan, el desempate final es SIEMPRE por jurado_id ascendente — nunca
// configurable, garantiza que el motor sea determinístico pase lo que pase
// en la configuración (sección 6/18 del pedido).
// @param ordenCriterios [{criterio_codigo, orden}] — no necesita venir
//   preordenado, esta función lo ordena internamente.
// @param umbralLejaniaKm solo lo usa EQUIDAD_TRASLADOS si está en el orden —
//   ignorado por los demás criterios (mejora "Equidad de Traslados").
// @returns (a, b) => number — comparador listo para Array.prototype.sort().
function construirComparadorJerarquico(ordenCriterios, umbralLejaniaKm) {
    const criteriosEnOrden = [...(ordenCriterios || [])]
        .sort((a, b) => a.orden - b.orden)
        .map(c => c.criterio_codigo);

    return (a, b) => {
        for (const codigo of criteriosEnOrden) {
            const cmp = compararPorCriterio(codigo, a, b, umbralLejaniaKm);
            if (cmp !== 0) return cmp;
        }
        return a.jurado.id < b.jurado.id ? -1 : (a.jurado.id > b.jurado.id ? 1 : 0);
    };
}

// ─── Evaluación de un candidato contra un rodeo (única implementación) ────
// Se llama DOS veces por par (rodeo, jurado) durante una corrida:
//   1. En la pasada preliminar de dificultad (Etapa 3.1) — usando el estado
//      SOLO de BD (asociaciones/bloques/designaciones antes de que el motor
//      empiece a proponer nada en esta corrida), para estimar cuántos
//      candidatos son realmente viables antes de decidir el orden.
//   2. En la evaluación real de cada rodeo, en el orden de dificultad ya
//      decidido — usando el estado BD + asignaciones temporales de esta
//      misma corrida (que en la pasada 1 todavía no existían).
// Es la MISMA función en ambos casos — no hay una segunda versión de las
// reglas. La única diferencia es qué snapshot de `estado` se le pasa.
//
// @param configuracion — Etapa 2: objeto validado (ver validarConfiguracion())
//   con las reglas booleanas activables y los parámetros de distancia. Las
//   reglas ESTRUCTURALES (disponibilidad, categoría-como-regla, desempate)
//   NUNCA se leen desde acá — siguen siempre activas, tal como antes.
function evaluarCandidato(jurado, rodeo, matriz, disponibilidad, comunaJuradoPorId, estado, configuracion) {
    const { asociacionesPorJurado, bloquesPorJurado, designacionesPorJurado, trasladosPorJuradoBD, trasladosTemporalesPorJurado } = estado;
    const causas = [];

    // Regla 0 — disponibilidad para TODAS las fechas del rodeo (ESTRUCTURAL,
    // nunca configurable — ver sección 6 del pedido de Etapa 2).
    const dispJurado = disponibilidad.get(jurado.id);
    const disponible = !!dispJurado && rodeo.fechas.every(f => dispJurado.has(f));
    if (!disponible) causas.push('DISPONIBILIDAD');

    // Regla 1 — misma asociación (comparación conservadora, sin fuzzy).
    // El HECHO (mismaAsoc) se calcula siempre — solo la CAUSA depende de la
    // configuración (sección 7): con la regla desactivada, un jurado de la
    // asociación organizadora deja de ser descartado por esto, pero el dato
    // informativo (checks.asociacion_diferente) sigue siendo veraz.
    const mismaAsoc = mismaAsociacion(jurado.asociacion, rodeo.asociacion);
    if (configuracion.regla_asociacion_organizadora_activa && mismaAsoc) causas.push('MISMA_ASOCIACION');

    // Regla 2 — no repetir asociación en TODA la temporada (sección 8).
    const asocNorm = normalizarAsociacion(rodeo.asociacion);
    const asociacionesUsadas = asociacionesPorJurado.get(jurado.id);
    const repiteAsociacionTemporada = !!asociacionesUsadas && asociacionesUsadas.has(asocNorm);
    if (configuracion.regla_no_repetir_asociacion_activa && repiteAsociacionTemporada) causas.push('ASOCIACION_REPETIDA_TEMPORADA');

    // Regla 3/4 — mismo fin de semana / fin de semana consecutivo (secciones
    // 9/10) — dos flags INDEPENDIENTES; bloquesSonConsecutivos()/feriados.js
    // no se tocan, solo se condiciona si la causa se genera o no.
    const bloquesJurado = bloquesPorJurado.get(jurado.id) || [];
    const mismoFinde = bloquesJurado.some(b => bloquesSeSuperponen(b, rodeo.bloque));
    const findeConsecutivo = !mismoFinde && bloquesJurado.some(b => bloquesSonConsecutivos(b, rodeo.bloque));
    if (configuracion.regla_un_rodeo_por_finde_activa && mismoFinde) causas.push('MISMO_FINDE');
    if (configuracion.regla_finde_consecutivo_activa && findeConsecutivo) causas.push('FINDE_CONSECUTIVO');

    // Regla 6 — categoría elegible según matriz. La REGLA es SIEMPRE
    // estructural (nunca se desactiva) — lo único configurable es el
    // CONTENIDO de la matriz (sección 15). categoriaOrdenPreferencia
    // reemplaza al antiguo booleano categoriaPreferente: es la posición de
    // preferencia (menor = mejor) que usa PRIORIDAD_CATEGORIA en el
    // comparador jerárquico (sección 16) — queda undefined si la categoría
    // no es elegible, pero en ese caso el candidato ya se descarta por
    // CATEGORIA_INCOMPATIBLE y ese valor nunca se usa para ordenar.
    const categoriaCompatible = matriz.elegibles.has(jurado.categoria);
    if (!categoriaCompatible) causas.push('CATEGORIA_INCOMPATIBLE');
    const categoriaOrdenPreferencia = matriz.ordenPorCategoria.get(jurado.categoria);

    // Regla 5 — distancia. La comuna solo es indispensable si la
    // configuración realmente USA distancia (regla dura activa o
    // MENOR_DISTANCIA como criterio de ranking) — configuracionRequiere
    // Distancia() es la única fuente de esa decisión (secciones 12/13).
    // Con V1 (ambas activas) el comportamiento es idéntico al actual.
    const necesitaDistancia = configuracionRequiereDistancia(configuracion);
    const comunaJurado = comunaJuradoPorId.get(jurado.id);
    let distanciaKm = null;
    if (necesitaDistancia) {
        if (!comunaJurado || !comunaJurado.resuelto) {
            causas.push('JURADO_SIN_COMUNA_RESOLVIBLE');
        } else {
            distanciaKm = calcularDistanciaKm(
                comunaJurado.latitud, comunaJurado.longitud,
                rodeo.comuna_resuelta.latitud, rodeo.comuna_resuelta.longitud
            );
            if (configuracion.regla_distancia_maxima_activa &&
                (distanciaKm === null || distanciaKm > configuracion.distancia_maxima_km)) {
                causas.push('DISTANCIA_EXCEDIDA');
            }
        }
    } else if (comunaJurado && comunaJurado.resuelto && rodeo.comuna_resuelta) {
        // Ninguna regla usa distancia hoy — se calcula igual como dato
        // informativo (nunca descarta a nadie) si ambas comunas resuelven.
        distanciaKm = calcularDistanciaKm(
            comunaJurado.latitud, comunaJurado.longitud,
            rodeo.comuna_resuelta.latitud, rodeo.comuna_resuelta.longitud
        );
    }

    const designacionesAntes = designacionesPorJurado.get(jurado.id)?.size || 0;

    // ── Equidad de Traslados — carga de traslados de la TEMPORADA, relativa
    // a la fecha de ESTE rodeo (informe, secciones 13/18/19/21). Se computa
    // SOLO cuando regla_equidad_traslados_activa está activa (schema_version=2
    // con equidad configurada) — para V1/schema_version=1, o schema_version=2
    // sin equidad, queda en null: nunca se muestra un "0 salidas cercanas/0
    // lejanas" que sugeriría equidad configurada cuando en realidad no existe
    // para esta versión (sección 44: V1 debe seguir funcionando EXACTAMENTE
    // igual, incluida su superficie de datos expuesta).
    let trasladosTemporada = null;
    if (trasladosPorJuradoBD && configuracion.regla_equidad_traslados_activa) {
        trasladosTemporada = calcularCargaTraslados(
            trasladosPorJuradoBD.get(jurado.id),
            trasladosTemporalesPorJurado ? trasladosTemporalesPorJurado.get(jurado.id) : null,
            rodeo.fecha,
            configuracion.umbral_lejania_km
        );
    }

    return {
        jurado, causas, elegible: causas.length === 0,
        distanciaKm, comunaJurado, categoriaOrdenPreferencia, categoriaCompatible,
        disponible, mismaAsoc, repiteAsociacionTemporada, mismoFinde, findeConsecutivo,
        designacionesAntes, trasladosTemporada
    };
}

// ─── Carga de traslados de temporada — RELATIVA a un rodeo objetivo ───────
// Pura, sin BD. Combina:
//   - `trasladosBD` [{fecha, distanciaKm}, ...] ya ordenado por fecha ASC —
//     SOLO las entradas con fecha ANTERIOR a `fechaRodeoObjetivo` cuentan
//     (informe, sección 19: nunca usar una salida posterior para decidir una
//     anterior). Si `fechaRodeoObjetivo` es null/undefined, cuenta TODO
//     (usado por evaluarCandidatoDirecto()/tarjeta, donde no hay "rodeo
//     objetivo futuro" que filtrar).
//   - `trasladosTemporales` [{distanciaKm}, ...] — asignaciones propuestas
//     por ESTA MISMA corrida de ejecutarSimulacion() para rodeos procesados
//     antes que este en el orden de dificultad (informe, sección 21/50):
//     se tratan como "más recientes que cualquier entrada de BD" y cuentan
//     SIEMPRE (no llevan fecha propia — el estado temporal del motor nunca
//     compara fechas entre sí, mismo criterio ya usado por designacionesPor
//     Jurado/asociacionesPorJurado/bloquesPorJurado).
// @returns { salidas_cerca, salidas_lejos, ultima_salida_tipo, ultima_salida_distancia_km }
function calcularCargaTraslados(trasladosBD, trasladosTemporales, fechaRodeoObjetivo, umbralLejaniaKm) {
    let salidas_cerca = 0, salidas_lejos = 0;
    let ultimaClase = null, ultimaDistancia = null;

    const historicoRelevante = (trasladosBD || []).filter(x => !fechaRodeoObjetivo || x.fecha < fechaRodeoObjetivo);
    for (const x of historicoRelevante) {
        const clase = clasificarTraslado(x.distanciaKm, umbralLejaniaKm);
        if (clase === 'CERCA') salidas_cerca++;
        else if (clase === 'LEJOS') salidas_lejos++;
        // La lista viene ordenada por fecha ASC — cada iteración sobrescribe
        // con la más reciente hasta el momento; al terminar el loop queda la
        // última salida real anterior al rodeo objetivo.
        if (clase !== null) { ultimaClase = clase; ultimaDistancia = x.distanciaKm; }
    }
    // Las temporales de esta misma corrida son "más recientes que todo BD"
    // por diseño (sección 21) — se procesan al final; si hay varias, la
    // última del array manda (orden de inserción = orden de propuesta).
    for (const x of (trasladosTemporales || [])) {
        const clase = clasificarTraslado(x.distanciaKm, umbralLejaniaKm);
        if (clase === 'CERCA') salidas_cerca++;
        else if (clase === 'LEJOS') salidas_lejos++;
        if (clase !== null) { ultimaClase = clase; ultimaDistancia = x.distanciaKm; }
    }

    return { salidas_cerca, salidas_lejos, ultima_salida_tipo: ultimaClase, ultima_salida_distancia_km: ultimaDistancia };
}

// ─── Historial de traslados de TODA la temporada, por jurado — SOLO BD ────
// Batch, sin N+1 (informe, sección 39): recorre `asignacionesTemporada` (ya
// cargada UNA vez por cargarDatosMotor, extendida con la comuna del rodeo de
// cada fila — ver cargarDatosMotor) y reconstruye la distancia de cada
// asignación pasada vía Haversine — MISMA función que usa el motor hoy para
// distancia en vivo (calcularDistanciaKm, geografia.js) — usando la comuna
// ACTUAL del jurado (usuarios_pagados.comuna). Limitación aceptada y
// documentada (ver informe de diseño, sección "Distancia histórica"):
// usuarios_pagados.comuna es un valor único mutable, SIN historización — si
// un jurado cambió de comuna durante la temporada, sus traslados anteriores
// a ese cambio se reconstruyen igual con su comuna actual, lo que puede
// reclasificar una salida antigua como CERCA/LEJOS de forma distinta a la
// situación real de ese momento. Es la MISMA asunción que ya hace hoy el
// motor para MENOR_DISTANCIA/DISTANCIA_EXCEDIDA (tampoco existe distancia
// histórica persistida) — no es una asunción nueva introducida acá.
// asignaciones.distancia_km (kilometraje declarado para bono de traslado)
// NUNCA se usa para esto — es una magnitud distinta (ver informe, sección 3).
// @returns Map(jurado_id -> [{fecha, distanciaKm}, ...]) ordenado por fecha ASC
function construirTrasladosPorJuradoBD(asignacionesTemporada, comunaJuradoPorId) {
    const porJurado = new Map();
    for (const a of (asignacionesTemporada || [])) {
        const comunaJurado = comunaJuradoPorId.get(a.usuario_pagado_id);
        const comunaRodeo = a.rodeos?.comunas_chile;
        let distanciaKm = null;
        if (comunaJurado?.resuelto && comunaRodeo?.latitud != null && comunaRodeo?.longitud != null) {
            distanciaKm = calcularDistanciaKm(comunaJurado.latitud, comunaJurado.longitud, comunaRodeo.latitud, comunaRodeo.longitud);
        }
        if (!porJurado.has(a.usuario_pagado_id)) porJurado.set(a.usuario_pagado_id, []);
        porJurado.get(a.usuario_pagado_id).push({ fecha: a.rodeos.fecha, distanciaKm });
    }
    for (const lista of porJurado.values()) lista.sort((x, y) => (x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : 0));
    return porJurado;
}

// ═════════════════════════════════════════════════════════════════════════
// Mejora "Equidad Visible de Designaciones" — SOLO INFORMATIVO, NUNCA
// participa del ranking (misma separación que Métricas de Rendimiento, más
// abajo): no se lee dentro de evaluarCandidato() ni del comparador
// jerárquico. NO es un criterio nuevo (no existe PROMEDIO_CATEGORIA ni
// PROMEDIO_GENERAL en configuracionDesignacion.js) — MENOS_DESIGNACIONES_
// TEMPORADA sigue exactamente igual.
//
// "Designaciones jurado" reutiliza SIEMPRE designacionesAntes ya calculado
// por evaluarCandidato() (esAsignacionEfectiva + temporada activa, con las
// mutaciones temporales de la corrida ya aplicadas cuando corresponde) —
// nunca se recalcula por separado, así nunca puede haber una diferencia
// entre "lo que decidió el ranking" y "lo que muestra la pantalla".
//
// Los promedios (categoría/general) son una estadística de POBLACIÓN
// distinta: se calculan UNA sola vez por corrida, en memoria, a partir de
// contexto.jurados (todos los jurados activos, tipo_persona='jurado' — ya
// filtrado por cargarDatosMotor) y designacionesAntesOriginal (snapshot
// SOLO-BD, previo a cualquier propuesta de esta corrida) — cero queries
// nuevas. Incluyen a los jurados con 0 designaciones (ese es justamente el
// punto: detectar a quién no ha salido) y usan la categoría ACTUAL de cada
// jurado (nunca una categoría histórica reconstruida).
// ═════════════════════════════════════════════════════════════════════════
function _promedioRedondeado(numeros) {
    if (!numeros || numeros.length === 0) return null;
    const suma = numeros.reduce((s, n) => s + n, 0);
    return Math.round((suma / numeros.length) * 10) / 10; // 1 decimal (sección 9)
}

// @param jurados                     contexto.jurados — todos los jurados activos
// @param designacionesPorJuradoOriginal  Map(jurado_id -> cantidad) — snapshot SOLO-BD
// @returns { promedioGeneral, totalJuradosGeneral, promedioPorCategoria: Map, totalPorCategoria: Map }
function construirEquidadDesignacionesAgregada(jurados, designacionesPorJuradoOriginal) {
    const conteosPorCategoria = new Map();
    const todosLosConteos = [];
    for (const j of (jurados || [])) {
        const n = designacionesPorJuradoOriginal.get(j.id) || 0;
        todosLosConteos.push(n);
        const cat = j.categoria || null;
        if (!conteosPorCategoria.has(cat)) conteosPorCategoria.set(cat, []);
        conteosPorCategoria.get(cat).push(n);
    }
    const promedioPorCategoria = new Map();
    const totalPorCategoria = new Map();
    for (const [cat, conteos] of conteosPorCategoria.entries()) {
        promedioPorCategoria.set(cat, _promedioRedondeado(conteos));
        totalPorCategoria.set(cat, conteos.length);
    }
    return {
        promedioGeneral: _promedioRedondeado(todosLosConteos),
        totalJuradosGeneral: (jurados || []).length,
        promedioPorCategoria, totalPorCategoria
    };
}

// Convierte el Map<jurado_id, Set(rodeo_id)> vigente (BD + lo que lleva
// mutado esta misma corrida hasta este punto) al Map<jurado_id, cantidad>
// que espera construirEquidadDesignacionesAgregada() — SIN congelar nada:
// se invoca de nuevo por cada rodeo del lote (corrección: antes se llamaba
// UNA sola vez con un snapshot congelado antes de empezar el lote, mezclando
// dos estados temporales distintos — ver comentario en ejecutarSimulacion()).
function _designacionesActualesComoMapa(designacionesPorJurado) {
    const conteos = new Map();
    for (const [juradoId, set] of designacionesPorJurado.entries()) conteos.set(juradoId, set.size);
    return conteos;
}

// Vista por candidato — combina la agregada (población) con el dato
// temporal-exacto de ESTE candidato (designacionesAntes, ya calculado por
// evaluarCandidato() — sección 3/8/36: nunca una segunda fuente).
// Nombres de campo explícitos (sección 29) — sin ambigüedad con el
// "Promedio categoría" de Rendimiento (que promedia NOTAS, no designaciones).
function construirEquidadDesignacionesCandidato(agregada, categoriaJurado, designacionesAntes) {
    const cat = categoriaJurado || null;
    return {
        designaciones_jurado: designacionesAntes,
        categoria: cat,
        promedio_categoria: cat != null ? (agregada.promedioPorCategoria.get(cat) ?? null) : null,
        total_jurados_categoria: cat != null ? (agregada.totalPorCategoria.get(cat) ?? 0) : 0,
        promedio_general: agregada.promedioGeneral,
        total_jurados_general: agregada.totalJuradosGeneral
    };
}

// ─── Estado SOLO-BD (asociaciones/bloques/designaciones) por jurado ──────
// Reduce `asignacionesTemporada` (ya cargada por cargarDatosMotor) a los 3
// mapas que evaluarCandidato() necesita como `estado`. Extraído para que
// ejecutarSimulacion() (que además le suma asignaciones TEMPORALES de la
// propia corrida) y evaluarCandidatoDirecto() (que solo necesita el estado
// real de BD, sin ninguna corrida encima) compartan la MISMA reducción —
// nunca dos implementaciones de "cómo se arma el estado" para las mismas reglas.
function construirEstadoDesdeBD(asignacionesTemporada) {
    const designacionesPorJurado = new Map();  // jurado_id -> Set(rodeo_id)
    const bloquesPorJurado = new Map();        // jurado_id -> [{inicio,fin}, ...]
    const asociacionesPorJurado = new Map();   // jurado_id -> Set(asociacion_normalizada)

    for (const a of (asignacionesTemporada || [])) {
        if (!designacionesPorJurado.has(a.usuario_pagado_id)) designacionesPorJurado.set(a.usuario_pagado_id, new Set());
        designacionesPorJurado.get(a.usuario_pagado_id).add(a.rodeo_id);

        if (!bloquesPorJurado.has(a.usuario_pagado_id)) bloquesPorJurado.set(a.usuario_pagado_id, []);
        bloquesPorJurado.get(a.usuario_pagado_id).push(calcularBloqueRodeo(a.rodeos.fecha, a.rodeos.duracion_dias || 1));

        if (a.rodeos.asociacion) {
            if (!asociacionesPorJurado.has(a.usuario_pagado_id)) asociacionesPorJurado.set(a.usuario_pagado_id, new Set());
            asociacionesPorJurado.get(a.usuario_pagado_id).add(normalizarAsociacion(a.rodeos.asociacion));
        }
    }
    return { designacionesPorJurado, bloquesPorJurado, asociacionesPorJurado };
}

// ─── Evalúa UN jurado específico para UN rodeo específico, DIRECTAMENTE ──
// Sin depender de ningún topN ni de buscar en una lista de candidatos — el
// llamador ya sabe exactamente qué jurado quiere verificar. Llama a
// evaluarCandidato() (la única implementación de las reglas) con el
// contexto real de BD, la misma que usa toda corrida normal del motor.
// Responde "¿este jurado específico sigue siendo válido?" (disponibilidad,
// asociación, categoría, distancia, fin de semana/consecutivo, historial),
// NUNCA "¿seguiría siendo el número 1 del ranking?" — un cambio de equidad
// entre jurados no aparece acá en absoluto, porque esta función ni siquiera
// mira a los demás candidatos.
//
// Usada por la revalidación al Guardar una propuesta y por la evaluación de
// una selección administrativa (aceptar/designar/modificar/mover) — ambas
// necesitan "¿sigue siendo válido este jurado puntual?", nunca un ranking.
//
// @param contexto - de cargarDatosMotor([rodeoId]) (o un lote más grande que lo incluya)
// @param rodeoId, juradoId
// @param configuracion - Etapa 2: por defecto Versión 1 (equivalente exacta
//   al motor actual). Se valida igual que en ejecutarSimulacion() — nunca se
//   relajan reglas silenciosamente ante una configuración inválida.
// @returns { evaluacion: <resultado de evaluarCandidato()> } | { error: 'JURADO_INACTIVO_O_INEXISTENTE'|'RODEO_NO_ENCONTRADO'|'TIPO_SIN_CLASIFICACION' }
function evaluarCandidatoDirecto(contexto, rodeoId, juradoId, configuracion = construirConfiguracionDefaultV1()) {
    const val = validarConfiguracion(configuracion);
    if (!val.valido) throw new Error(`Configuración de designación inválida: ${val.error}`);

    const jurado = (contexto.jurados || []).find(j => j.id === juradoId);
    if (!jurado) return { error: 'JURADO_INACTIVO_O_INEXISTENTE' }; // contexto.jurados ya viene filtrado a activo=true, tipo_persona='jurado'

    const rodeo = contexto.rodeosPorId.get(rodeoId);
    if (!rodeo) return { error: 'RODEO_NO_ENCONTRADO' };

    // Misma matriz derivada de la configuración que usa ejecutarSimulacion()
    // — la legacy clasificacion_categoria_matriz/contexto.matrizPorCodigo ya
    // no se consulta desde cargarDatosMotor (retirada en Etapa 3). Mejora
    // "Zonas Extremas" (sección 15 del pedido): resolverMatrizParaRodeo() es
    // el ÚNICO punto que decide matriz normal vs. especial — MISMO resolver
    // que usa ejecutarSimulacion(), para que nunca haya inconsistencia entre
    // una evaluación directa (aceptar/seleccionar) y la simulación.
    const matrizPorClasificacion = construirMatrizPorClasificacionDesdeConfiguracion(configuracion.matriz);
    const matrizZonaExtrema = construirMatrizZonaExtremaDesdeConfiguracion(configuracion);
    const resueltaMatriz = resolverMatrizParaRodeo(rodeo, matrizPorClasificacion, matrizZonaExtrema, configuracion.zonas_extremas?.asociaciones);
    const matriz = resueltaMatriz.matriz;
    if (!matriz) return { error: 'TIPO_SIN_CLASIFICACION' };

    // comunaJuradoPorId se resuelve para TODOS los jurados activos (no solo
    // juradoId) — necesario para reconstruir el historial de traslados de
    // temporada (construirTrasladosPorJuradoBD recorre asignacionesTemporada
    // completa, que incluye asignaciones de otros jurados). Son llamadas
    // puras a resolverComuna() (sin BD, ya son ~110 hoy en ejecutarSimulacion)
    // — no introduce ningún query nuevo.
    const comunaJuradoPorId = new Map();
    for (const j of (contexto.jurados || [])) comunaJuradoPorId.set(j.id, resolverComuna(j.comuna, contexto.catalogoComunas));

    const estado = construirEstadoDesdeBD(contexto.asignacionesTemporada);
    estado.trasladosPorJuradoBD = construirTrasladosPorJuradoBD(contexto.asignacionesTemporada, comunaJuradoPorId);
    estado.trasladosTemporalesPorJurado = new Map(); // sin corrida encima — evaluación directa contra estado real de BD únicamente

    return {
        evaluacion: evaluarCandidato(jurado, rodeo, matriz, contexto.disponibilidad, comunaJuradoPorId, estado, configuracion),
        // Zona Extrema — para que el llamador (aceptar/seleccionar directo)
        // pueda mostrar el mismo aviso "⚠ Zona Extrema · Prioridad automática
        // C → B" que la simulación (sección 17 del pedido) sin recalcularlo.
        zonaExtrema: resueltaMatriz.fuente === 'ZONA_EXTREMA' ? { asociacion: resueltaMatriz.asociacion } : null
    };
}

// ─────────────────────────────────────────────────────────────────────────
// CAPA 1 — Carga de datos (batch, anti N+1)
// ─────────────────────────────────────────────────────────────────────────
async function cargarDatosMotor(rodeoIdsInput) {
    let queries = 0;

    // 1. Temporada activa — fuente única de verdad (Etapa 2). Si no hay
    //    ninguna marcada activa, la simulación completa queda sin temporada
    //    resuelta y todos los rodeos terminan NO_EVALUABLE/TEMPORADA_NO_RESUELTA.
    const { data: temporadaRow, error: errTemp } = await supabase
        .from('temporadas').select('nombre, fecha_inicio, fecha_fin').eq('activa', true).maybeSingle();
    queries++;
    if (errTemp) throw new Error('No se pudo cargar la temporada: ' + errTemp.message);

    // 2. Rodeos solicitados (todos los ids pedidos, existan o no, activos o
    //    no — se resuelve el estado de cada uno en ejecutarSimulacion) con
    //    su tipo/clasificación y comuna ya resueltos vía join.
    const idsUnicos = [...new Set((rodeoIdsInput || []).filter(Boolean))];
    let rodeosRaw = [];
    if (idsUnicos.length > 0) {
        const { data, error } = await supabase
            .from('rodeos')
            .select(`
                id, club, asociacion, fecha, duracion_dias, tipo_rodeo_id, comuna_id, estado,
                tipos_rodeo(clasificacion_designacion_id, clasificaciones_designacion(codigo)),
                comunas_chile(id, nombre, region, latitud, longitud)
            `)
            .in('id', idsUnicos);
        queries++;
        if (error) throw new Error('No se pudo cargar los rodeos: ' + error.message);
        rodeosRaw = data || [];
    }

    // 3. clasificacion_codigo por rodeo (para saber a qué fila de
    //    configuracion.matriz corresponde cada rodeo — la matriz LEGACY
    //    clasificacion_categoria_matriz ya no se consulta acá: Etapa 3
    //    confirmó por grep que contexto.matrizPorCodigo no tenía consumidores
    //    reales fuera de este mismo archivo desde el refactor de Etapa 2, así
    //    que la consulta "puente temporal" y su derivación se retiraron. La
    //    tabla en sí NO se elimina — sigue existiendo para GET /clasificaciones
    //    (feature de administración "Tipos de Rodeo", consumidor distinto) y
    //    como fuente histórica de la migración 050.

    // Enriquecer rodeos con clasificacion_codigo y comuna resuelta + fechas
    const rodeosPorId = new Map();
    for (const r of rodeosRaw) {
        const clasifCodigo = r.tipos_rodeo?.clasificaciones_designacion?.codigo || null;
        rodeosPorId.set(r.id, {
            id: r.id, club: r.club, asociacion: r.asociacion, fecha: r.fecha,
            duracion_dias: r.duracion_dias || 1, estado: r.estado,
            clasificacion_codigo: clasifCodigo,
            comuna_resuelta: r.comunas_chile ? {
                id: r.comunas_chile.id, nombre: r.comunas_chile.nombre,
                latitud: r.comunas_chile.latitud, longitud: r.comunas_chile.longitud
            } : null,
            fechas: rangoFechas(r.fecha, r.duracion_dias || 1),
            bloque: calcularBloqueRodeo(r.fecha, r.duracion_dias || 1)
        });
    }

    // 4. Jurados activos
    const { data: juradosRaw, error: errJ } = await supabase
        .from('usuarios_pagados')
        .select('id, nombre_completo, categoria, asociacion, comuna, codigo_interno')
        .eq('activo', true).eq('tipo_persona', 'jurado');
    queries++;
    if (errJ) throw new Error('No se pudo cargar jurados: ' + errJ.message);
    const jurados = juradosRaw || [];

    // 5. Catálogo de resolución de comunas (comunas_chile + comunas_chile_alias)
    const catalogoComunas = await cargarCatalogoResolucionComunas();
    queries += 2;

    // 6. Disponibilidad — unión de todas las fechas necesarias por los rodeos
    //    solicitados, para todos los jurados activos, en una sola consulta.
    const fechasUnion = [...new Set([...rodeosPorId.values()].flatMap(r => r.fechas))];
    const juradoIds = jurados.map(j => j.id);
    let disponibilidadRows = [];
    if (fechasUnion.length > 0 && juradoIds.length > 0) {
        const { data, error } = await supabase
            .from('disponibilidad_usuarios')
            .select('usuario_pagado_id, fecha')
            .in('usuario_pagado_id', juradoIds)
            .in('fecha', fechasUnion);
        queries++;
        if (error) throw new Error('No se pudo cargar disponibilidad: ' + error.message);
        disponibilidadRows = data || [];
    }
    const disponibilidad = new Map(); // usuario_pagado_id -> Set(fecha)
    for (const d of disponibilidadRows) {
        if (!disponibilidad.has(d.usuario_pagado_id)) disponibilidad.set(d.usuario_pagado_id, new Set());
        disponibilidad.get(d.usuario_pagado_id).add(d.fecha);
    }

    // 7. Asignaciones de TODA la temporada (tipo jurado) — paginado por
    //    seguridad (mismo patrón que jurados-disponibles/validar-historial).
    //    Se trae estado + estado_designacion para poder aplicar el criterio
    //    ÚNICO de "asignación efectiva" (esAsignacionEfectiva) más abajo —
    //    la query solo excluye anuladas como optimización, pero el filtro
    //    real y completo (incluye rechazadas) se aplica en un solo lugar.
    //    comunas_chile(latitud, longitud) — mejora "Equidad de Traslados":
    //    misma extensión de columnas EXISTENTES ya usadas para la comuna de
    //    los rodeos solicitados (paso 2) — NO es una consulta nueva, solo
    //    columnas adicionales de esta misma consulta ya existente. Permite
    //    reconstruir en memoria la distancia histórica de cada asignación de
    //    la temporada (construirTrasladosPorJuradoBD, más abajo) sin ningún
    //    query por jurado/asignación. `id` — mejora "Métricas de Rendimiento":
    //    misma razón, permite unir con notas_rodeo.asignacion_id en batch
    //    (cargarRendimientoTemporada) sin ninguna consulta nueva de asignaciones.
    let asignacionesRaw = [];
    {
        let offset = 0;
        while (true) {
            const { data, error } = await supabase
                .from('asignaciones')
                .select('id, usuario_pagado_id, rodeo_id, estado, estado_designacion, rodeos!inner(fecha, duracion_dias, asociacion, comunas_chile(latitud, longitud))')
                .eq('tipo_persona', 'jurado')
                .neq('estado', 'anulado')
                .range(offset, offset + PAGINA - 1);
            queries++;
            if (error) throw new Error('No se pudo cargar asignaciones de temporada: ' + error.message);
            const filas = data || [];
            asignacionesRaw = asignacionesRaw.concat(filas);
            if (filas.length < PAGINA) break;
            offset += PAGINA;
        }
    }
    const asignacionesTemporada = temporadaRow
        ? asignacionesRaw.filter(a => esAsignacionEfectiva(a) && a.rodeos?.fecha >= temporadaRow.fecha_inicio && a.rodeos?.fecha <= temporadaRow.fecha_fin)
        : [];

    return {
        idsSolicitados: idsUnicos,
        temporada: temporadaRow,
        rodeosPorId,
        jurados,
        catalogoComunas,
        disponibilidad,
        asignacionesTemporada,
        _queriesAproximadas: queries
    };
}

// ─────────────────────────────────────────────────────────────────────────
// CAPA 2 — Simulación (función pura: no toca la BD, testeable con fixtures)
//
// Etapa 2 — Configuración de Propuesta de Designación: `configuracion` es
// SIEMPRE requerida en la práctica (tiene un default a Versión 1, ver más
// abajo) y se valida antes de ejecutar nada — jamás se relajan reglas
// silenciosamente ante una configuración inválida (sección 5/38 del pedido):
// se lanza un Error controlado que el llamador puede capturar (todavía sin
// mapear a un código HTTP — eso es de una etapa posterior).
//
// IMPORTANTE — orden de parámetros: `configuracion` se agregó AL FINAL,
// después de `topN`, deliberadamente. `topN` ya era el 2º parámetro
// posicional consumido por llamadores productivos reales (ej.
// propuesta-designacion.js llama a `ejecutarSimulacion(contexto,
// TOP_N_TODOS_LOS_CANDIDATOS)` para los paneles de Designar/Modificar) — si
// `configuracion` se hubiera insertado en 2º lugar, ese `999` pasaría a
// interpretarse como `configuracion` y rompería esos endpoints en
// producción (detectado en la revisión de cierre de Etapa 2 buscando TODOS
// los llamadores reales antes de commitear). Con `configuracion` al final,
// ningún llamador existente (ruta ni tests previos) cambia de
// comportamiento sin tocar ese archivo.
//
// PUENTE TEMPORAL CERRADO (Etapa 2 lo introdujo, Etapa 3 lo cerró): esta
// función usa exclusivamente configuracion.matriz. contexto.matrizPorCodigo
// (la matriz legacy cargada desde clasificacion_categoria_matriz) quedó sin
// consumidores reales desde el refactor de Etapa 2 — confirmado por grep en
// Etapa 3 — y la consulta que la armaba se retiró de cargarDatosMotor.
// ─────────────────────────────────────────────────────────────────────────
function ejecutarSimulacion(contexto, topN = 5, configuracion = construirConfiguracionDefaultV1()) {
    const val = validarConfiguracion(configuracion);
    if (!val.valido) throw new Error(`Configuración de designación inválida: ${val.error}`);

    const { idsSolicitados, temporada, rodeosPorId, jurados, catalogoComunas, disponibilidad, asignacionesTemporada } = contexto;
    const matrizPorClasificacion = construirMatrizPorClasificacionDesdeConfiguracion(configuracion.matriz);
    // Mejora "Zonas Extremas" — derivada UNA vez por corrida (pura, sin BD,
    // sección 15 del pedido); resolverMatrizParaRodeo() decide por rodeo si
    // corresponde usarla en vez de matrizPorClasificacion.
    const matrizZonaExtrema = construirMatrizZonaExtremaDesdeConfiguracion(configuracion);
    const asociacionesZonaExtrema = configuracion.zonas_extremas?.asociaciones || [];

    // Comuna resuelta de cada jurado, precalculada una sola vez (61 llamadas
    // puras a resolverComuna, no hay N+1 de BD acá — ya está todo en memoria).
    // Se mueve ANTES del estado (antes se calculaba después) porque
    // construirTrasladosPorJuradoBD() la necesita para reconstruir distancias
    // históricas — mismo resultado, mismo costo, solo cambia el orden.
    const comunaJuradoPorId = new Map();
    for (const j of jurados) comunaJuradoPorId.set(j.id, resolverComuna(j.comuna, catalogoComunas));

    // ── Estado temporal de la corrida (BD + asignaciones temporales unificadas) ──
    // Sembrado desde la BD (asignacionesTemporada, vía construirEstadoDesdeBD
    // — misma reducción que usa evaluarCandidatoDirecto(), nunca duplicada) y
    // mutado a medida que el motor va proponiendo jurados dentro de esta
    // misma simulación. Nunca se escribe en BD — vive solo en memoria.
    const { designacionesPorJurado, bloquesPorJurado, asociacionesPorJurado } = construirEstadoDesdeBD(asignacionesTemporada);

    // Equidad de Traslados — historial de temporada por jurado (SOLO BD, sin
    // mutar) + acumulador TEMPORAL (mutado por registrarAsignacionTemporal a
    // medida que esta corrida propone jurados — informe, sección 21/50: una
    // propuesta anterior del MISMO batch debe pesar en las siguientes, sin
    // persistir nada). Ambos son baratos: arrays ya en memoria, sin BD nueva.
    const trasladosPorJuradoBD = construirTrasladosPorJuradoBD(asignacionesTemporada, comunaJuradoPorId);
    const trasladosTemporalesPorJurado = new Map(); // jurado_id -> [{distanciaKm}, ...]

    // Snapshot de designaciones SOLO-BD por jurado (antes de cualquier
    // propuesta de esta corrida) — para el resumen final de distribución
    // ("Jurados utilizados en la simulación").
    const designacionesAntesOriginal = new Map();
    for (const [juradoId, set] of designacionesPorJurado.entries()) designacionesAntesOriginal.set(juradoId, set.size);

    // Mejora "Equidad Visible de Designaciones" — la agregada de POBLACIÓN
    // (promedio_categoria/promedio_general) NO se calcula una sola vez para
    // toda la corrida: en un lote multi-rodeo, cada FILA debe ver el estado
    // vigente justo ANTES de proponerse a sí misma (BD + propuestas
    // temporales de las filas anteriores del MISMO lote, nunca el snapshot
    // congelado del inicio) — corrección explícita del round anterior, ver
    // helper _designacionesActualesComoMapa() más abajo, invocado dentro del
    // loop principal, no acá afuera.

    const asignacionesTemporalesLog = [];
    // `distanciaKm` — la del GANADOR contra ESTE rodeo (puede ser null si no
    // se pudo resolver comuna) — se agrega al acumulador temporal para que
    // los rodeos procesados DESPUÉS en esta misma corrida vean esta salida
    // recién propuesta como parte de la carga de traslados del jurado.
    const registrarAsignacionTemporal = (juradoId, rodeo, distanciaKm) => {
        if (!designacionesPorJurado.has(juradoId)) designacionesPorJurado.set(juradoId, new Set());
        designacionesPorJurado.get(juradoId).add(rodeo.id);

        if (!bloquesPorJurado.has(juradoId)) bloquesPorJurado.set(juradoId, []);
        bloquesPorJurado.get(juradoId).push(rodeo.bloque);

        if (rodeo.asociacion) {
            if (!asociacionesPorJurado.has(juradoId)) asociacionesPorJurado.set(juradoId, new Set());
            asociacionesPorJurado.get(juradoId).add(normalizarAsociacion(rodeo.asociacion));
        }

        if (!trasladosTemporalesPorJurado.has(juradoId)) trasladosTemporalesPorJurado.set(juradoId, []);
        trasladosTemporalesPorJurado.get(juradoId).push({ distanciaKm: distanciaKm ?? null });

        asignacionesTemporalesLog.push({ jurado_id: juradoId, rodeo_id: rodeo.id, fecha: rodeo.fecha, asociacion: rodeo.asociacion });
    };

    // ── 1. Clasificar cada id solicitado: NO_EVALUABLE inmediato o evaluable ──
    const resultados = [];
    const rodeosEvaluables = [];

    for (const id of idsSolicitados) {
        const rodeo = rodeosPorId.get(id);
        if (!rodeo) {
            resultados.push({ rodeo_id: id, estado: 'NO_EVALUABLE', causa: 'RODEO_NO_ENCONTRADO' });
            continue;
        }
        if (rodeo.estado !== 'activo') {
            resultados.push({ rodeo_id: id, estado: 'NO_EVALUABLE', causa: 'RODEO_INACTIVO', rodeo: { club: rodeo.club, fecha: rodeo.fecha } });
            continue;
        }
        if (!temporada) {
            resultados.push({ rodeo_id: id, estado: 'NO_EVALUABLE', causa: 'TEMPORADA_NO_RESUELTA', rodeo: { club: rodeo.club, fecha: rodeo.fecha } });
            continue;
        }
        if (rodeo.fecha < temporada.fecha_inicio || rodeo.fecha > temporada.fecha_fin) {
            resultados.push({ rodeo_id: id, estado: 'NO_EVALUABLE', causa: 'RODEO_FUERA_DE_TEMPORADA', rodeo: { club: rodeo.club, fecha: rodeo.fecha } });
            continue;
        }
        if (!rodeo.comuna_resuelta) {
            resultados.push({ rodeo_id: id, estado: 'NO_EVALUABLE', causa: 'RODEO_SIN_COMUNA', rodeo: { club: rodeo.club, fecha: rodeo.fecha, asociacion: rodeo.asociacion } });
            continue;
        }
        if (!rodeo.clasificacion_codigo || !matrizPorClasificacion[rodeo.clasificacion_codigo]) {
            resultados.push({ rodeo_id: id, estado: 'NO_EVALUABLE', causa: 'TIPO_SIN_CLASIFICACION', rodeo: { club: rodeo.club, fecha: rodeo.fecha, asociacion: rodeo.asociacion } });
            continue;
        }
        rodeosEvaluables.push(rodeo);
    }

    // ── 2. Orden de procesamiento: "más difícil primero" ─────────────────
    // Dificultad = candidatos POTENCIALMENTE VÁLIDOS reales (Etapa 3.1):
    // se corre la evaluación completa de reglas (evaluarCandidato) contra el
    // estado SOLO-BD (sin las asignaciones temporales de esta corrida, que
    // todavía no existen en este punto) — no un conteo superficial por
    // categoría. Esto evita que un rodeo "aparentemente amplio" (20 elegibles
    // por categoría) se procese antes que uno con pocos candidatos reales
    // (ej. la mayoría no disponible, fuera de 600 km, o repite asociación).
    // Es la MISMA función evaluarCandidato() que se usa en la evaluación real
    // más abajo — no hay una segunda versión de las reglas, solo se le pasa
    // un snapshot de estado distinto (sin mutaciones de esta corrida todavía).
    const estadoSoloBD = { asociacionesPorJurado, bloquesPorJurado, designacionesPorJurado, trasladosPorJuradoBD, trasladosTemporalesPorJurado };
    for (const rodeo of rodeosEvaluables) {
        // Zona Extrema (sección 14 del pedido): la dificultad se estima con la
        // MISMA matriz efectiva (normal o especial) que usará la evaluación
        // real más abajo — nunca la matriz normal "a secas" para un rodeo que
        // en realidad se va a evaluar con la especial.
        const matriz = resolverMatrizParaRodeo(rodeo, matrizPorClasificacion, matrizZonaExtrema, asociacionesZonaExtrema).matriz;
        rodeo._candidatosPotenciales = jurados.filter(j =>
            evaluarCandidato(j, rodeo, matriz, disponibilidad, comunaJuradoPorId, estadoSoloBD, configuracion).elegible
        ).length;
        rodeo._restrictividad = matriz.elegibles.size;
    }
    rodeosEvaluables.sort((a, b) => {
        if (a._candidatosPotenciales !== b._candidatosPotenciales) return a._candidatosPotenciales - b._candidatosPotenciales;
        if (a._restrictividad !== b._restrictividad) return a._restrictividad - b._restrictividad;
        if (a.fecha !== b.fecha) return a.fecha < b.fecha ? -1 : 1;
        return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });

    // ── 3. Procesar cada rodeo evaluable ──────────────────────────────────
    // A partir de aquí, `estadoActual` sí se muta (registrarAsignacionTemporal
    // agrega a las mismas Map/Set que arriba) — cada rodeo que se procesa ve
    // las propuestas ya hechas a rodeos anteriores en esta misma corrida.
    const estadoActual = { asociacionesPorJurado, bloquesPorJurado, designacionesPorJurado, trasladosPorJuradoBD, trasladosTemporalesPorJurado };
    for (const rodeo of rodeosEvaluables) {
        // Zona Extrema — mismo resolver que la dificultad de arriba (sección
        // 14/15 del pedido: un único punto de decisión, nunca dos).
        const resueltaMatriz = resolverMatrizParaRodeo(rodeo, matrizPorClasificacion, matrizZonaExtrema, asociacionesZonaExtrema);
        const matriz = resueltaMatriz.matriz;
        // Info de Zona Extrema para ESTE rodeo (sección 16 del pedido: "¿Por
        // qué ganó?" nunca debe narrar la matriz normal si Zona Extrema la
        // sustituyó) — se arma una vez, se adjunta tanto a SIN_PROPUESTA como
        // a PROPUESTO más abajo. prioridad_categorias: ['C','B'] (orden
        // ascendente de orden_preferencia, solo elegibles).
        const zonaExtremaInfo = resueltaMatriz.fuente === 'ZONA_EXTREMA'
            ? {
                activa: true, asociacion: resueltaMatriz.asociacion,
                prioridad_categorias: [...matrizZonaExtrema.ordenPorCategoria.entries()].sort((a, b) => a[1] - b[1]).map(([cat]) => cat)
            }
            : null;
        const evaluaciones = jurados.map(j => evaluarCandidato(j, rodeo, matriz, disponibilidad, comunaJuradoPorId, estadoActual, configuracion));

        // Mejora "Equidad Visible de Designaciones" — agregada de POBLACIÓN
        // recalculada FRESCA para ESTA fila (corrección del round anterior,
        // sección 1-9): `designacionesPorJurado` en este punto exacto ya
        // tiene BD + las propuestas temporales de las filas anteriores del
        // mismo lote (registrarAsignacionTemporal ya corrió para ellas),
        // pero TODAVÍA NO la de esta fila (registrarAsignacionTemporal(
        // ganador) para ESTE rodeo corre más abajo) — misma semántica
        // temporal exacta que designacionesAntes de cada evaluación de
        // arriba. Puramente en memoria, sin ninguna consulta nueva.
        const equidadDesignacionesAgregadaFila = construirEquidadDesignacionesAgregada(jurados, _designacionesActualesComoMapa(designacionesPorJurado));

        // ── Resumen de descartes (se cuentan TODAS las causas detectadas —
        //    un candidato puede aportar a más de un contador a la vez) ──
        const descartes = {};
        for (const codigo of ['DISPONIBILIDAD','MISMA_ASOCIACION','ASOCIACION_REPETIDA_TEMPORADA','MISMO_FINDE','FINDE_CONSECUTIVO','CATEGORIA_INCOMPATIBLE','JURADO_SIN_COMUNA_RESOLVIBLE','DISTANCIA_EXCEDIDA']) {
            descartes[codigo] = evaluaciones.filter(e => e.causas.includes(codigo)).length;
        }
        const descartados = evaluaciones.filter(e => !e.elegible).map(e => ({
            jurado_id: e.jurado.id, nombre: e.jurado.nombre_completo,
            categoria: e.jurado.categoria, asociacion: e.jurado.asociacion,
            categoria_preferente: e.categoriaOrdenPreferencia === 1,
            comuna_nombre: e.comunaJurado?.nombre || null,
            distancia_km: e.distanciaKm !== null ? Math.round(e.distanciaKm * 10) / 10 : null,
            designaciones_antes: e.designacionesAntes,
            causas: e.causas,
            causa_principal: ORDEN_CAUSA_PRINCIPAL.find(c => e.causas.includes(c)) || e.causas[0],
            // Mejora "Equidad Visible de Designaciones" — sección 37: también
            // para descartados/con-advertencias, no solo para los válidos.
            equidad_designaciones: construirEquidadDesignacionesCandidato(equidadDesignacionesAgregadaFila, e.jurado.categoria, e.designacionesAntes)
        }));

        const candidatosValidos = evaluaciones.filter(e => e.elegible);

        if (candidatosValidos.length === 0) {
            resultados.push({
                rodeo_id: rodeo.id, estado: 'SIN_PROPUESTA',
                rodeo: { club: rodeo.club, fecha: rodeo.fecha, asociacion: rodeo.asociacion, clasificacion_codigo: rodeo.clasificacion_codigo },
                candidatos_evaluados: evaluaciones.length,
                candidatos_potenciales_bd: rodeo._candidatosPotenciales,
                // Zona Extrema — sección 45 del pedido: si solo A estaba
                // disponible y no está habilitada automáticamente, SIN_
                // PROPUESTA también debe poder explicar por qué (nunca solo
                // "sin candidatos", sin decir que Zona Extrema fue la causa).
                zona_extrema: zonaExtremaInfo,
                descartes, descartados
            });
            continue;
        }

        // ── Comparador jerárquico según el Nivel 1 configurado ────────────
        // Nivel 2 (orden_preferencia por categoría) ya quedó resuelto por
        // candidato dentro de evaluarCandidato() — acá solo se aplica el
        // ORDEN GLOBAL de criterios (configuracion.ordenCriterios).
        const criteriosOrdenados = [...configuracion.ordenCriterios].sort((a, b) => a.orden - b.orden);
        const primerCriterioEsCategoria = criteriosOrdenados[0]?.criterio_codigo === 'PRIORIDAD_CATEGORIA';
        const comparador = construirComparadorJerarquico(configuracion.ordenCriterios, configuracion.umbral_lejania_km);

        // Paridad EXACTA con el comportamiento actual (sección 2 del pedido
        // de Etapa 2): si PRIORIDAD_CATEGORIA es el criterio Nº1, el grupo
        // se reduce a la categoría de mejor (=menor) orden_preferencia
        // disponible ANTES de aplicar el resto del comparador — reproduce
        // el filtro "preferente primero" tal cual existe hoy, incluyendo
        // que top_candidatos muestre solo ese nivel. Si PRIORIDAD_CATEGORIA
        // no es el criterio Nº1 (o está inactivo), NO se reduce nada: el
        // comparador jerárquico ya la aplica en su posición configurada
        // sobre TODOS los candidatos elegibles (ej. sección 19/20/21 del
        // pedido — distancia u equidad pueden decidir antes que categoría).
        let grupo = candidatosValidos;
        if (primerCriterioEsCategoria) {
            const mejorOrden = Math.min(...candidatosValidos.map(e => e.categoriaOrdenPreferencia));
            grupo = candidatosValidos.filter(e => e.categoriaOrdenPreferencia === mejorOrden);
        }
        grupo = [...grupo].sort(comparador);

        // Top N candidatos finales del grupo usado, ya en el orden de
        // desempate — para auditoría del dry-run (N=5 por defecto) y, con
        // un N mayor, para la pantalla "Modificar" de una propuesta
        // guardada (Etapa 4), que necesita ver más candidatos sin
        // reimplementar el ranking.
        const topCandidatos = grupo.slice(0, topN).map(e => ({
            jurado_id: e.jurado.id, nombre: e.jurado.nombre_completo, categoria: e.jurado.categoria,
            asociacion: e.jurado.asociacion,
            categoria_preferente: e.categoriaOrdenPreferencia === 1,
            comuna_nombre: e.comunaJurado?.nombre || null,
            designaciones_antes: e.designacionesAntes,
            distancia_km: e.distanciaKm !== null ? Math.round(e.distanciaKm * 10) / 10 : null,
            // Mejora "Equidad Visible de Designaciones" — sección 37.
            equidad_designaciones: construirEquidadDesignacionesCandidato(equidadDesignacionesAgregadaFila, e.jurado.categoria, e.designacionesAntes)
        }));

        const ganador = grupo[0];
        registrarAsignacionTemporal(ganador.jurado.id, rodeo, ganador.distanciaKm);

        // Equidad de Traslados — datos SOLO INFORMATIVOS del ganador (informe,
        // secciones 2/25/41). distancia_clasificacion usa el umbral de ESTA
        // configuración (null si EQUIDAD_TRASLADOS no está configurado — sin
        // umbral no hay clasificación). Nunca influyen en who gana MÁS ALLÁ
        // de lo que ya decidió el comparador jerárquico de arriba.
        const distanciaClasificacion = clasificarTraslado(ganador.distanciaKm, configuracion.umbral_lejania_km);
        const equidadTrasladosActiva = criteriosOrdenados.some(c => c.criterio_codigo === 'EQUIDAD_TRASLADOS');

        // ¿Fue EQUIDAD_TRASLADOS realmente decisivo? (revisión de cierre,
        // sección 19) — se compara al ganador contra el candidato siguiente
        // del MISMO grupo (grupo[1], ya ordenado por el comparador jerárquico
        // real) con el mismo compararEquidadTraslados() que usó el ranking.
        // Si el resultado es 0 (empate en este criterio), quien decidió
        // realmente fue OTRO criterio posterior — nunca se le atribuye la
        // victoria a la equidad en ese caso. Sin un segundo candidato con
        // quien comparar, no hay ambigüedad posible que evitar.
        const equidadFueDecisivo = !equidadTrasladosActiva ? false
            : (grupo.length < 2 || compararEquidadTraslados(ganador, grupo[1], configuracion.umbral_lejania_km) !== 0);

        resultados.push({
            rodeo_id: rodeo.id, estado: 'PROPUESTO',
            rodeo: { club: rodeo.club, fecha: rodeo.fecha, asociacion: rodeo.asociacion, clasificacion_codigo: rodeo.clasificacion_codigo },
            candidatos_potenciales_bd: rodeo._candidatosPotenciales,
            top_candidatos: topCandidatos,
            // Zona Extrema — sección 16 del pedido: se muestra a nivel de
            // rodeo (aplica igual a todos los candidatos de esta fila, no
            // solo al ganador).
            zona_extrema: zonaExtremaInfo,
            jurado_propuesto: {
                jurado_id: ganador.jurado.id,
                nombre: ganador.jurado.nombre_completo,
                categoria: ganador.jurado.categoria,
                categoria_preferente: ganador.categoriaOrdenPreferencia === 1,
                comuna_canonica: ganador.comunaJurado?.nombre || null,
                origen_comuna: ganador.comunaJurado?.origen || null,
                distancia_km: ganador.distanciaKm !== null ? Math.round(ganador.distanciaKm * 10) / 10 : null,
                // Equidad de Traslados — nulo si umbral_lejania_km no está
                // configurado (V1/schema_version=1 y schema_version=2 sin
                // equidad activa): "CERCA"|"LEJOS"|null.
                distancia_clasificacion: distanciaClasificacion,
                traslados_temporada: ganador.trasladosTemporada ? {
                    salidas_cercanas: ganador.trasladosTemporada.salidas_cerca,
                    salidas_lejanas: ganador.trasladosTemporada.salidas_lejos,
                    ultima_salida_tipo: ganador.trasladosTemporada.ultima_salida_tipo,
                    ultima_salida_distancia_km: ganador.trasladosTemporada.ultima_salida_distancia_km !== null
                        ? Math.round(ganador.trasladosTemporada.ultima_salida_distancia_km * 10) / 10 : null
                } : null,
                // "¿Por qué ganó?" — solo se agrega narrativa cuando EQUIDAD_
                // TRASLADOS realmente forma parte del orden de criterios
                // configurado (informe, sección 41) — nunca una frase inventada
                // cuando el criterio no participó de la decisión.
                equidad_traslados_explicacion: equidadTrasladosActiva
                    ? construirExplicacionEquidadTraslados(equidadFueDecisivo, distanciaClasificacion, ganador.trasladosTemporada)
                    : null,
                // Zona Extrema — sección 16 del pedido: "¿Por qué ganó?" debe
                // explicar la prioridad especial cuando aplicó, en vez de
                // dejar que se infiera la matriz normal de la clasificación
                // (que en este caso NO fue la que decidió).
                zona_extrema_explicacion: zonaExtremaInfo
                    ? construirExplicacionZonaExtrema(zonaExtremaInfo.asociacion, zonaExtremaInfo.prioridad_categorias)
                    : null,
                designaciones_temporada_antes: ganador.designacionesAntes,
                designaciones_temporada_despues: ganador.designacionesAntes + 1,
                // Mejora "Equidad Visible de Designaciones" — SOLO INFORMATIVO
                // (sección 27/28: nunca decide ni cambia al ganador, ya
                // decidido arriba por el comparador jerárquico). historial_
                // reciente NO va acá — requiere una consulta (batch) y se
                // agrega después, solo para ganadores, en generarSimulacion().
                equidad_designaciones: construirEquidadDesignacionesCandidato(equidadDesignacionesAgregadaFila, ganador.jurado.categoria, ganador.designacionesAntes),
                checks: {
                    disponible: ganador.disponible,
                    asociacion_diferente: !ganador.mismaAsoc,
                    no_repite_asociacion: !ganador.repiteAsociacionTemporada,
                    sin_rodeo_mismo_finde: !ganador.mismoFinde,
                    sin_finde_consecutivo: !ganador.findeConsecutivo,
                    dentro_600km: !configuracion.regla_distancia_maxima_activa ||
                        (ganador.distanciaKm !== null && ganador.distanciaKm <= configuracion.distancia_maxima_km),
                    categoria_compatible: ganador.categoriaCompatible
                }
            },
            candidatos_evaluados: evaluaciones.length,
            descartes, descartados
        });
    }

    const resumen = {
        rodeos_solicitados: idsSolicitados.length,
        propuestos: resultados.filter(r => r.estado === 'PROPUESTO').length,
        sin_propuesta: resultados.filter(r => r.estado === 'SIN_PROPUESTA').length,
        no_evaluables: resultados.filter(r => r.estado === 'NO_EVALUABLE').length,
        candidatos_analizados: resultados.reduce((acc, r) => acc + (r.candidatos_evaluados || 0), 0)
    };

    // Reordenar resultados según el orden original solicitado (el procesamiento
    // interno usa el orden de dificultad, pero la respuesta debe ser predecible
    // para quien llamó: mismo orden que rodeo_ids de entrada).
    const resultadosPorId = new Map(resultados.map(r => [r.rodeo_id, r]));
    const resultadosOrdenados = idsSolicitados.map(id => resultadosPorId.get(id)).filter(Boolean);

    // ── Distribución: jurados utilizados en esta corrida (para revisar   ──
    //    visualmente que ningún jurado se lleve una porción desproporcionada) ──
    const porJurado = {};
    for (const log of asignacionesTemporalesLog) {
        if (!porJurado[log.jurado_id]) porJurado[log.jurado_id] = { nombre: null, propuestas_nuevas: 0 };
        porJurado[log.jurado_id].propuestas_nuevas++;
    }
    for (const j of jurados) if (porJurado[j.id]) porJurado[j.id].nombre = j.nombre_completo;
    const juradosUtilizados = Object.entries(porJurado).map(([juradoId, v]) => {
        const antes = designacionesAntesOriginal.get(juradoId) || 0;
        return { jurado_id: juradoId, nombre: v.nombre, designaciones_antes: antes, propuestas_nuevas: v.propuestas_nuevas, total_temporal: antes + v.propuestas_nuevas };
    }).sort((a, b) => b.propuestas_nuevas - a.propuestas_nuevas || a.nombre.localeCompare(b.nombre, 'es'));

    return {
        resumen,
        resultados: resultadosOrdenados,
        asignaciones_temporales: asignacionesTemporalesLog,
        jurados_utilizados: juradosUtilizados,
        metricas: {}
    };
}

// ═════════════════════════════════════════════════════════════════════════
// Métricas de Rendimiento (informe, Objetivo B) — SOLO INFORMATIVO, NUNCA
// participa del ranking (no se lee dentro de evaluarCandidato()/comparador
// — separación explícita pedida en la sección 40 del informe). Se calcula
// DESPUÉS de ejecutarSimulacion(), únicamente para los jurados que resultaron
// GANADORES en esta corrida — no para los ~59 candidatos evaluados durante
// el ranking, evitando cargar datos innecesarios en el camino caliente.
//
// Fuentes canónicas reutilizadas (ver informe de diseño — nunca inventadas):
//   - nota: notas_rodeo.nota, vinculada a asignaciones.id — misma fuente que
//     Hoja de Vida (hojavida.js) y GET /admin/dashboard/desempeno.
//   - promedio jurado / categoría / general: MISMA metodología ya usada por
//     GET /admin/dashboard/desempeno (dashboard.js) — promedio jurado y
//     promedio categoría son promedios "de promedios por jurado"; promedio
//     general es un promedio PLANO de todas las notas individuales (dos
//     metodologías distintas dentro de la misma fuente oficial — se
//     reutilizan tal cual, sin homogeneizarlas).
//   - participación/alteración: esAsignacionEfectiva() (mismo criterio único
//     del motor) + evaluaciones.resultados_alterados, contando RODEOS
//     DISTINTOS (evaluaciones.rodeo_id es UNIQUE — nunca hay más de 1
//     evaluación por rodeo, así que no hay riesgo de inflar el conteo).
// ═════════════════════════════════════════════════════════════════════════

// ─── Carga batch — 2 queries NUEVAS, FIJAS (no crecen con la cantidad de ──
// jurados/rodeos evaluados en el ranking) ──────────────────────────────────
// Reutiliza contexto.asignacionesTemporada (YA cargada por cargarDatosMotor,
// sin query adicional) como población base — misma fuente/filtro que usa el
// motor para equidad de traslados (esAsignacionEfectiva + rango de
// temporada activa). Se salta por completo si no hay ninguna asignación de
// temporada (nada que enriquecer).
// @returns { asignacionesTemporada, notasPorAsignacion: Map(asignacion_id->nota),
//            alteradoPorRodeo: Map(rodeo_id->boolean), queriesAproximadas }
async function cargarRendimientoTemporada(contexto) {
    const asignacionesTemporada = contexto.asignacionesTemporada || [];
    if (asignacionesTemporada.length === 0) {
        return { asignacionesTemporada, notasPorAsignacion: new Map(), alteradoPorRodeo: new Map(), queriesAproximadas: 0 };
    }

    const asigIds = asignacionesTemporada.map(a => a.id).filter(Boolean);
    const rodeoIds = [...new Set(asignacionesTemporada.map(a => a.rodeo_id))];
    let queries = 0;

    const { data: notasRaw, error: errNotas } = await supabase
        .from('notas_rodeo').select('asignacion_id, nota').in('asignacion_id', asigIds);
    queries++;
    if (errNotas) throw new Error('No se pudieron cargar notas para métricas de rendimiento: ' + errNotas.message);
    const notasPorAsignacion = new Map();
    for (const n of (notasRaw || [])) notasPorAsignacion.set(n.asignacion_id, parseFloat(n.nota));

    // anulada=false — misma semántica ya documentada: evaluaciones.rodeo_id
    // es UNIQUE, así que como mucho hay 1 fila por rodeo; una evaluación
    // anulada se trata como "sin evaluación" (nunca como alteración=false).
    const { data: evalsRaw, error: errEvals } = await supabase
        .from('evaluaciones').select('rodeo_id, resultados_alterados').in('rodeo_id', rodeoIds).eq('anulada', false);
    queries++;
    if (errEvals) throw new Error('No se pudieron cargar evaluaciones para métricas de rendimiento: ' + errEvals.message);
    const alteradoPorRodeo = new Map();
    for (const e of (evalsRaw || [])) alteradoPorRodeo.set(e.rodeo_id, !!e.resultados_alterados);

    return { asignacionesTemporada, notasPorAsignacion, alteradoPorRodeo, queriesAproximadas: queries };
}

// ─── Cálculo PURO de rendimiento por jurado — sin BD, testeable con fixtures ─
// @param datos      { asignacionesTemporada, notasPorAsignacion, alteradoPorRodeo } — de cargarRendimientoTemporada()
// @param jurados     [{id, categoria}, ...] — lista completa (para resolver categoría de cada jurado)
// @param juradoIdsAMostrar  iterable de jurado_id — SOLO se calcula/devuelve para estos (los ganadores de esta corrida)
// @param hoyChile    'YYYY-MM-DD' — corte: rodeos con fecha > hoyChile se excluyen (informe, sección 36)
// @returns Map(jurado_id -> { ultima_nota, promedio_jurado, promedio_categoria, promedio_general, alteracion:{alterados,total,porcentaje} })
function construirRendimientoPorJurado(datos, jurados, juradoIdsAMostrar, hoyChile) {
    const { asignacionesTemporada, notasPorAsignacion, alteradoPorRodeo } = datos;
    const categoriaPorJurado = new Map((jurados || []).map(j => [j.id, j.categoria]));

    // Solo rodeos YA REALIZADOS — nunca futuros (sección 36).
    const pasadas = (asignacionesTemporada || []).filter(a => a.rodeos?.fecha && a.rodeos.fecha <= hoyChile);

    // Por jurado: entradas ordenadas por fecha + set de rodeos DISTINTOS en
    // los que participó (denominador de alteración — sección 33/34: RODEOS
    // DISTINTOS, nunca filas de evaluación ni cantidad de notas).
    const porJurado = new Map();
    for (const a of pasadas) {
        if (!porJurado.has(a.usuario_pagado_id)) porJurado.set(a.usuario_pagado_id, { entradas: [], rodeosDistintos: new Set() });
        const registro = porJurado.get(a.usuario_pagado_id);
        registro.rodeosDistintos.add(a.rodeo_id);
        const nota = a.id != null ? notasPorAsignacion.get(a.id) : undefined;
        registro.entradas.push({ fecha: a.rodeos.fecha, rodeo_id: a.rodeo_id, nota: nota != null ? nota : null });
    }
    for (const registro of porJurado.values()) {
        registro.entradas.sort((x, y) => (x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : 0));
    }

    // Promedio general — PLANO sobre TODAS las notas válidas de la temporada
    // (misma metodología que dashboard.js /desempeno: resumen.promedio_nota_general).
    const todasNotas = [];
    for (const registro of porJurado.values()) {
        for (const e of registro.entradas) if (e.nota != null) todasNotas.push(e.nota);
    }
    const promedioGeneral = todasNotas.length
        ? Math.round((todasNotas.reduce((s, n) => s + n, 0) / todasNotas.length) * 100) / 100 : null;

    // Promedio por categoría — promedio DE LOS PROMEDIOS por jurado dentro
    // de cada categoría (misma metodología que dashboard.js /desempeno:
    // por_categoria[cat].promedio_nota — NO un promedio plano de notas
    // individuales; se reutiliza tal cual, sin homogeneizar con el general).
    const promediosPorJuradoPorCategoria = new Map();
    for (const [juradoId, registro] of porJurado.entries()) {
        const notasValidas = registro.entradas.map(e => e.nota).filter(n => n != null);
        if (notasValidas.length === 0) continue;
        const promedioJurado = notasValidas.reduce((s, n) => s + n, 0) / notasValidas.length;
        const cat = categoriaPorJurado.get(juradoId) || '?';
        if (!promediosPorJuradoPorCategoria.has(cat)) promediosPorJuradoPorCategoria.set(cat, []);
        promediosPorJuradoPorCategoria.get(cat).push(promedioJurado);
    }
    const promedioPorCategoria = new Map();
    for (const [cat, lista] of promediosPorJuradoPorCategoria.entries()) {
        promedioPorCategoria.set(cat, Math.round((lista.reduce((s, n) => s + n, 0) / lista.length) * 100) / 100);
    }

    const resultado = new Map();
    for (const juradoId of juradoIdsAMostrar) {
        const registro = porJurado.get(juradoId);
        const categoria = categoriaPorJurado.get(juradoId) ?? null;
        const promedioCategoria = categoria != null ? (promedioPorCategoria.get(categoria) ?? null) : null;

        if (!registro || registro.entradas.length === 0) {
            resultado.set(juradoId, {
                ultima_nota: null, promedio_jurado: null,
                promedio_categoria: promedioCategoria, promedio_general: promedioGeneral,
                alteracion: { alterados: 0, total: 0, porcentaje: null }
            });
            continue;
        }

        // Última nota = la del ÚLTIMO rodeo (por fecha) en que participó —
        // NO la última nota que exista salteando rodeos sin nota (sección
        // 28: "si el último rodeo no posee nota, mostrar Sin nota/N/D", no
        // buscar hacia atrás la nota anterior más cercana).
        const ultimaEntrada = registro.entradas[registro.entradas.length - 1];
        const ultimaNota = ultimaEntrada.nota;

        const notasValidas = registro.entradas.map(e => e.nota).filter(n => n != null);
        const promedioJurado = notasValidas.length
            ? Math.round((notasValidas.reduce((s, n) => s + n, 0) / notasValidas.length) * 100) / 100 : null;

        const total = registro.rodeosDistintos.size;
        let alterados = 0;
        for (const rodeoId of registro.rodeosDistintos) if (alteradoPorRodeo.get(rodeoId)) alterados++;
        const porcentaje = total > 0 ? Math.round((alterados / total) * 100) : null; // total=0 nunca divide — sección 35

        resultado.set(juradoId, {
            ultima_nota: ultimaNota, promedio_jurado: promedioJurado,
            promedio_categoria: promedioCategoria, promedio_general: promedioGeneral,
            alteracion: { alterados, total, porcentaje }
        });
    }
    return resultado;
}

// ═════════════════════════════════════════════════════════════════════════
// Mejora "Equidad Visible de Designaciones" — Historial reciente. BATCH
// equivalente exacto de GET /admin/usuarios/:id/historial (usuarios.js) —
// MISMA semántica (estado != 'anulado', ORDER BY created_at DESC, notas
// vía notas_rodeo.asignacion_id), reutilizada tal cual y nunca redefinida
// (sección 11/13/33/36 de la mejora): es la misma fuente OFICIAL que ya
// alimenta el popover de jurado de la pantalla Rodeos — deliberadamente
// career-wide (NO acotado a la temporada activa), a diferencia de
// "Designaciones jurado"/equidad de designaciones (motor-exacto, temporada-
// scoped) — dos conceptos distintos, nunca mezclados.
//
// UNA sola consulta batch (paginada, mismo patrón PAGINA=900 del resto del
// proyecto) para TODOS los jurado_ids pedidos — nunca una consulta por
// jurado (anti-N+1, sección 31/33/37: hasta 59+ candidatos en "Modificar
// jurado" sin que el conteo de queries dependa de N).
// @returns Map(jurado_id -> [{ rodeo_id, club, asociacion, fecha, nota }, ...]) máx 4, más reciente primero
async function cargarHistorialRecienteBatch(juradoIds) {
    const idsUnicos = [...new Set((juradoIds || []).filter(Boolean))];
    if (idsUnicos.length === 0) return new Map();

    let todasAsigs = [];
    {
        let offset = 0;
        while (true) {
            const { data, error } = await supabase
                .from('asignaciones')
                .select('id, usuario_pagado_id, rodeo_id, created_at, rodeos(club, asociacion, fecha)')
                .in('usuario_pagado_id', idsUnicos)
                .neq('estado', 'anulado')
                .order('created_at', { ascending: false })
                .range(offset, offset + PAGINA - 1);
            if (error) throw new Error('No se pudo cargar historial reciente: ' + error.message);
            const filas = data || [];
            todasAsigs = todasAsigs.concat(filas);
            if (filas.length < PAGINA) break;
            offset += PAGINA;
        }
    }

    const notasPorAsignacion = new Map();
    if (todasAsigs.length > 0) {
        const idsAsig = todasAsigs.map(a => a.id);
        const { data: notasRaw, error: errNotas } = await supabase
            .from('notas_rodeo').select('asignacion_id, nota').in('asignacion_id', idsAsig);
        if (errNotas) throw new Error('No se pudo cargar notas para historial reciente: ' + errNotas.message);
        for (const n of (notasRaw || [])) notasPorAsignacion.set(n.asignacion_id, n.nota);
    }

    // todasAsigs ya viene ORDER BY created_at DESC (global) — filtrar por
    // jurado preserva ese orden relativo, así que las primeras 4 que se
    // encuentren para cada jurado_id YA son sus 4 más recientes.
    const historialPorJurado = new Map();
    for (const a of todasAsigs) {
        if (!historialPorJurado.has(a.usuario_pagado_id)) historialPorJurado.set(a.usuario_pagado_id, []);
        const lista = historialPorJurado.get(a.usuario_pagado_id);
        if (lista.length >= 4) continue; // sección 12: máximo 4, más reciente primero
        lista.push({
            rodeo_id: a.rodeo_id,
            club: a.rodeos?.club || null,
            asociacion: a.rodeos?.asociacion || null,
            fecha: a.rodeos?.fecha || null,
            nota: notasPorAsignacion.get(a.id) ?? null
        });
    }
    return historialPorJurado;
}

// Etapa 2 — Configuración de Propuesta de Designación. `configuracion` es
// un parámetro OPCIONAL (por defecto Versión 1 hardcodeada) agregado al
// final para no romper ningún llamador existente. Desde Etapa 3, la ruta de
// producción siempre resuelve la configuración real desde
// configuracion_designacion_versiones (vía configuracionDesignacionRepositorio)
// y la pasa explícitamente aquí — el default solo se ejerce en tests/uso
// directo de esta función, nunca en un endpoint real.
async function generarSimulacion(rodeoIdsInput, topN = 5, configuracion = construirConfiguracionDefaultV1()) {
    const inicioMs = Date.now();
    const contexto = await cargarDatosMotor(rodeoIdsInput);
    const finCargaMs = Date.now();
    const resultado = ejecutarSimulacion(contexto, topN, configuracion);
    const finMotorMs = Date.now();

    // Métricas de Rendimiento (Objetivo B) — SOLO para los jurados GANADORES
    // de esta corrida (informe, sección 40), enriquecidas DESPUÉS del
    // ranking — nunca antes, para no pagar su costo si nadie resultó
    // PROPUESTO (ej. una corrida que solo devuelve SIN_PROPUESTA/NO_EVALUABLE).
    const juradoIdsGanadores = [...new Set(
        resultado.resultados.filter(r => r.estado === 'PROPUESTO').map(r => r.jurado_propuesto.jurado_id)
    )];
    if (juradoIdsGanadores.length > 0) {
        const hoyChile = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
        // Rendimiento (notas/alteración) e Historial reciente (mejora "Equidad
        // Visible de Designaciones") son consultas independientes — en
        // paralelo, mismo espíritu de "fijo, no crece con N" (acá N = jurados
        // GANADORES, ya deduplicado arriba).
        const [datosRendimiento, historialPorJurado] = await Promise.all([
            cargarRendimientoTemporada(contexto),
            cargarHistorialRecienteBatch(juradoIdsGanadores)
        ]);
        const rendimientoPorJurado = construirRendimientoPorJurado(datosRendimiento, contexto.jurados, juradoIdsGanadores, hoyChile);
        for (const r of resultado.resultados) {
            if (r.estado === 'PROPUESTO') {
                r.jurado_propuesto.rendimiento_temporada = rendimientoPorJurado.get(r.jurado_propuesto.jurado_id) || null;
                // Historial reciente — career-wide, misma fuente que el
                // popover de Rodeos (nunca las propuestas temporales de este
                // mismo dry-run — sección 13). [] si nunca tuvo designaciones.
                r.jurado_propuesto.historial_reciente = historialPorJurado.get(r.jurado_propuesto.jurado_id) || [];
            }
        }
        resultado.metricas.queries_rendimiento_aproximadas = datosRendimiento.queriesAproximadas;
    }

    resultado.temporada = contexto.temporada ? contexto.temporada.nombre : null;
    resultado.modo = 'DRY_RUN';
    resultado.metricas = {
        ...resultado.metricas,
        tiempo_ejecucion_ms: finMotorMs - inicioMs,
        tiempo_carga_bd_ms: finCargaMs - inicioMs,
        tiempo_motor_memoria_ms: finMotorMs - finCargaMs,
        queries_aproximadas: contexto._queriesAproximadas,
        jurados_activos_considerados: contexto.jurados.length
    };
    return resultado;
}

module.exports = {
    generarSimulacion, cargarDatosMotor, ejecutarSimulacion, evaluarCandidato,
    evaluarCandidatoDirecto, construirEstadoDesdeBD,
    esAsignacionEfectiva, filtrarRodeosSinJuradoEfectivo,
    bloquesSeSuperponen, bloquesSonConsecutivos,
    // Etapa 2 — Configuración de Propuesta de Designación (funciones puras
    // nuevas, testeables sin BD; ver informe de entrega).
    construirMatrizPorClasificacionDesdeConfiguracion, compararPorCriterio, construirComparadorJerarquico,
    DISTANCIA_MAXIMA_KM, ORDEN_CAUSA_PRINCIPAL, TOP_N_TODOS_LOS_CANDIDATOS,
    // Mejora "Equidad de Traslados" — funciones puras nuevas, testeables sin BD.
    compararEquidadTraslados, calcularCargaTraslados, construirTrasladosPorJuradoBD,
    construirExplicacionEquidadTraslados,
    // Mejora "Métricas de Rendimiento" — ver más abajo (cargarRendimientoTemporada/construirRendimientoPorJurado).
    cargarRendimientoTemporada, construirRendimientoPorJurado,
    // Mejora "Equidad Visible de Designaciones" — funciones puras + batch nuevas.
    construirEquidadDesignacionesAgregada, construirEquidadDesignacionesCandidato,
    cargarHistorialRecienteBatch,
    designacionesPorJuradoAConteos: _designacionesActualesComoMapa,
    // Mejora "Zonas Extremas" (schema_version=3) — funciones puras nuevas.
    construirMatrizZonaExtremaDesdeConfiguracion, resolverMatrizParaRodeo, construirExplicacionZonaExtrema
};
