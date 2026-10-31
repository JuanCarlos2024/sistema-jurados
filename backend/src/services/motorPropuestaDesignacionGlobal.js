// ═════════════════════════════════════════════════════════════════════════
// Motor GLOBAL de Propuesta de Designación — Fase 2A (motor base) + Fase 2B
// (distinción obligatorio/preferencial, estados de búsqueda explícitos,
// integración con dry-run y propuestas borrador).
//
// Problema que resuelve: el motor existente (motorPropuestaDesignacion.js,
// ejecutarSimulacion()) es GREEDY — procesa los rodeos de "más difícil" a
// "más fácil" y, para cada uno, asigna de inmediato el mejor candidato según
// el orden de criterios configurado. Un greedy puede dejar rodeos
// SIN_PROPUESTA aunque SÍ exista una asignación que cubra el 100% de los
// cupos, simplemente porque "gastó" en un rodeo fácil al único jurado que
// un rodeo posterior, más restringido, necesitaba en exclusiva.
//
// Este módulo NO reemplaza ni modifica el motor existente — lo REUTILIZA
// íntegro (mismas reglas vía evaluarCandidato(), mismo comparador
// jerárquico, misma carga de datos vía cargarDatosMotor()).
//
// ─── Fase 2B — restricciones OBLIGATORIAS vs preferencias FLEXIBLES ───────
// evaluarCandidato() (sin modificar) devuelve, para cada candidato, un
// array `causas` con TODAS las reglas incumplidas. El motor LOCAL (greedy)
// sigue tratando cualquier causa como bloqueante — ESO NO CAMBIA (Fase 1A/
// 1B intactas). El motor GLOBAL, en cambio, distingue dos niveles:
//
//   OBLIGATORIAS (nunca relajables, en ningún nivel de búsqueda):
//     DISPONIBILIDAD                — el jurado físicamente no puede estar ahí.
//     CATEGORIA_INCOMPATIBLE        — la matriz de la clasificación define
//                                     qué categorías están HABILITADAS para
//                                     juzgar ese nivel de rodeo (elegible:
//                                     true/false) — es una habilitación
//                                     reglamentaria, no una preferencia.
//                                     orden_preferencia (quién va primero
//                                     ENTRE los ya habilitados) sí es
//                                     preferencial — y YA es tratado como tal
//                                     hoy (nunca bloquea a nadie).
//     MISMA_ASOCIACION              — conflicto de interés real (jurado de
//                                     la asociación organizadora juzgando su
//                                     propio rodeo) — prohibición operacional,
//                                     no está en la lista de preferencias del
//                                     pedido de Fase 2B.
//     MISMO_FINDE                   — conflicto real de fechas: el jurado no
//                                     puede estar en dos rodeos el mismo fin
//                                     de semana. Expresamente distinto de
//                                     FINDE_CONSECUTIVO (ver abajo).
//
//   PREFERENCIAS FLEXIBLES (relajables SOLO en el 2º nivel de búsqueda, y
//   SOLO cuando sea la única forma de cubrir el 100% de los cupos):
//     DISTANCIA_EXCEDIDA            — "distancia de referencia" de 600 km.
//     ASOCIACION_REPETIDA_TEMPORADA — repetición de asociación organizadora
//                                     ya designada en la temporada.
//     FINDE_CONSECUTIVO             — dos rodeos en fines de semana
//                                     consecutivos (NO el mismo fin de
//                                     semana — eso es MISMO_FINDE, siempre
//                                     obligatorio).
//     JURADO_SIN_COMUNA_RESOLVIBLE  — no se pudo calcular distancia: un dato
//                                     faltante, no una prohibición; si la
//                                     distancia en sí es preferencial, no
//                                     tiene sentido que la IMPOSIBILIDAD de
//                                     medirla sea más estricta que la regla
//                                     que mide.
//   (La equidad de traslados y "menos designaciones" nunca aparecen en
//   `causas` — ya son puramente de RANKING hoy, nunca bloquean a nadie; no
//   necesitan relajarse porque nunca fueron obligatorias.)
//
// La búsqueda SIEMPRE intenta primero el nivel estricto (0 preferencias
// relajadas = exactamente el comportamiento de Fase 2A) y solo escala al
// nivel permisivo si ese primer intento no logra cubrir el 100% — nunca se
// relaja una preferencia si no hace falta (sección 3 del pedido: "no
// activar... hasta completar las pruebas" + minimizar cambios respecto al
// ranking que el greedy ya haría).
// ═════════════════════════════════════════════════════════════════════════
const {
    cargarDatosMotor, ejecutarSimulacion, evaluarCandidato, construirEstadoDesdeBD,
    construirMatrizPorClasificacionDesdeConfiguracion, construirMatrizZonaExtremaDesdeConfiguracion,
    resolverMatrizParaRodeo, construirComparadorJerarquico, construirTrasladosPorJuradoBD,
    cargarRendimientoTemporada, construirRendimientoPorJurado, cargarHistorialRecienteBatch
} = require('./motorPropuestaDesignacion');
const { resolverComuna } = require('./geografia');
const { normalizarAsociacion } = require('./asociaciones');
const { construirConfiguracionDefaultV1 } = require('./configuracionDesignacion');

// Límites de seguridad de la búsqueda exacta — pensados para lotes reales
// (hasta 200 rodeos por corrida, mismo tope que POST /dry-run). Si se
// alcanza cualquiera de los dos, la búsqueda se detiene y se informa
// explícitamente "no se pudo determinar" — NUNCA se afirma cobertura total
// ni infactibilidad sin haberla verificado, y NUNCA se cuelga el proceso.
const LIMITE_NODOS_DEFAULT = 60000;
const LIMITE_MS_DEFAULT = 8000;

// Preferencias flexibles — ver comentario de cabecera. Único lugar que
// define esta lista; tanto resolverAsignacionGlobal() como la
// reconstrucción del resultado final la reutilizan, nunca una segunda copia.
const CAUSAS_RELAJABLES = new Set(['DISTANCIA_EXCEDIDA', 'ASOCIACION_REPETIDA_TEMPORADA', 'FINDE_CONSECUTIVO', 'JURADO_SIN_COMUNA_RESOLVIBLE']);
// Documental/tests — todas las causas que evaluarCandidato() puede producir,
// menos las relajables, son las obligatorias (DISPONIBILIDAD,
// CATEGORIA_INCOMPATIBLE, MISMA_ASOCIACION, MISMO_FINDE).
const CAUSAS_OBLIGATORIAS = new Set(['DISPONIBILIDAD', 'CATEGORIA_INCOMPATIBLE', 'MISMA_ASOCIACION', 'MISMO_FINDE']);

// Estados de búsqueda explícitos (Fase 2B, sección 2 del pedido) — nunca se
// informa imposibilidad por un simple timeout, y nunca se afirma cobertura
// total sin haberla verificado.
const ESTADOS_BUSQUEDA = {
    COBERTURA_COMPLETA: 'COBERTURA_COMPLETA',
    INFACTIBLE_DEMOSTRADO: 'INFACTIBLE_DEMOSTRADO',
    LIMITE_ALCANZADO: 'LIMITE_ALCANZADO',
    ERROR_TECNICO: 'ERROR_TECNICO'
};

// ─── Búsqueda exacta (backtracking + MRV) ──────────────────────────────────
// Encuentra, si existe, una asignación rodeo→jurado que cubra el 100% de
// `rodeosConMatriz` (cada uno ya con `_matrizGlobal` resuelta). Reutiliza
// evaluarCandidato() para la MISMA factibilidad que usa el motor local —
// nunca una segunda implementación de las reglas.
//
// `causasRelajadas` (Fase 2B): Set de códigos de causa que NO se consideran
// bloqueantes en ESTA corrida de búsqueda — vacío por defecto (nivel
// estricto, idéntico a Fase 2A). Nunca se pasa aquí una causa OBLIGATORIA;
// quien orquesta los dos niveles (ejecutarSimulacionGlobal) es el único
// responsable de pasar siempre CAUSAS_RELAJABLES o un subconjunto de ella.
//
// `opciones.candidatosEstaticosPorRodeo` (Fase 2B — escalamiento, medido con
// 200 rodeos/110 jurados, ver informe de cierre): Map(rodeo.id -> jurado[])
// OPCIONAL, precomputada UNA VEZ por el llamador (ejecutarSimulacionGlobal)
// con construirCandidatosEstaticos() más abajo. Sin ella, cada nodo de la
// búsqueda re-evaluaba TODOS los jurados contra TODOS los rodeos pendientes
// para decidir cuál es "el más restringido" (MRV) — un costo que escala con
// el LOTE COMPLETO en cada nodo (medido: cientos de ms por nodo con 200×110,
// agotando el presupuesto de tiempo en un puñado de nodos reales). Con la
// lista estática YA filtrada por rodeo (categoría/distancia/asociación
// organizadora/disponibilidad — los únicos factores que NO dependen de qué
// otras asignaciones lleva la búsqueda), cada nodo solo necesita re-evaluar
// dinámicamente (mismo finde, finde consecutivo, repetición de asociación —
// los 3 ÚNICOS factores que sí dependen del estado acumulado) contra ese
// subconjunto pequeño, y el candidato MRV se elige por un orden estático
// precalculado (ordenPorEstatico) en vez de un escaneo completo. Sin esta
// opción (llamada directa, tests unitarios), se calcula igual una sola vez
// aquí mismo — el resultado es idéntico, solo cambia qué tan rápido se llega.
//
// @returns { exito, asignacion: Map(rodeo_id->jurado_id), cobertura, nodosExplorados, limiteAlcanzado, tiempoMs }
function resolverAsignacionGlobal(contexto, configuracion, rodeosConMatriz, opciones = {}) {
    const limiteNodos = opciones.limiteNodos || LIMITE_NODOS_DEFAULT;
    const limiteMs = opciones.limiteMs || LIMITE_MS_DEFAULT;
    const causasRelajadas = opciones.causasRelajadas || new Set();
    const inicioMs = Date.now();

    const comunaJuradoPorId = new Map();
    for (const j of contexto.jurados) comunaJuradoPorId.set(j.id, resolverComuna(j.comuna, contexto.catalogoComunas));

    const { designacionesPorJurado, bloquesPorJurado, asociacionesPorJurado } = construirEstadoDesdeBD(contexto.asignacionesTemporada);
    const trasladosPorJuradoBD = construirTrasladosPorJuradoBD(contexto.asignacionesTemporada, comunaJuradoPorId);
    const trasladosTemporalesPorJurado = new Map();
    const estado = { asociacionesPorJurado, bloquesPorJurado, designacionesPorJurado, trasladosPorJuradoBD, trasladosTemporalesPorJurado };

    const comparador = construirComparadorJerarquico(configuracion.ordenCriterios, configuracion.umbral_lejania_km);

    // Candidatos ESTÁTICOS por rodeo — ver comentario de cabecera. Si no se
    // pasó precalculado, se calcula aquí (una sola vez, no por nodo).
    const candidatosEstaticosPorRodeo = opciones.candidatosEstaticosPorRodeo
        || construirCandidatosEstaticosPorRodeo(contexto, configuracion, rodeosConMatriz, causasRelajadas, comunaJuradoPorId);

    // Orden MRV APROXIMADO, precalculado UNA sola vez: rodeos ordenados
    // ascendente por cantidad de candidatos ESTÁTICOS. Cualquier orden de
    // ramificación es válido para la CORRECCIÓN del backtracking (prueba
    // todos los candidatos del rodeo elegido, sin importar cuál se eligió
    // primero) — este orden solo decide qué tan rápido se converge, nunca
    // si la respuesta final es correcta.
    const ordenEstatico = [...rodeosConMatriz].sort(
        (a, b) => (candidatosEstaticosPorRodeo.get(a.id)?.length || 0) - (candidatosEstaticosPorRodeo.get(b.id)?.length || 0)
    );
    const rodeoPorId = new Map(rodeosConMatriz.map(r => [r.id, r]));

    const asignado = new Map(); // rodeo_id -> jurado_id
    const pendientesRestantes = new Set(rodeosConMatriz.map(r => r.id)); // mutado durante la búsqueda
    let mejorParcial = new Map();
    let nodos = 0;
    let limiteAlcanzado = false;

    // "Factible bajo este nivel de búsqueda" — SOLO contra la lista estática
    // de ESTE rodeo (ya filtrada por lo que nunca cambia durante la
    // búsqueda), re-evaluando contra el estado ACTUAL (lo que sí puede
    // cambiar: mismo finde/finde consecutivo/repetición de asociación).
    function candidatosFactibles(rodeo) {
        return (candidatosEstaticosPorRodeo.get(rodeo.id) || [])
            .map(j => evaluarCandidato(j, rodeo, rodeo._matrizGlobal, contexto.disponibilidad, comunaJuradoPorId, estado, configuracion))
            .filter(e => e.causas.every(c => causasRelajadas.has(c)));
    }

    function asignarTemporal(juradoId, rodeo) {
        if (!designacionesPorJurado.has(juradoId)) designacionesPorJurado.set(juradoId, new Set());
        designacionesPorJurado.get(juradoId).add(rodeo.id);
        if (!bloquesPorJurado.has(juradoId)) bloquesPorJurado.set(juradoId, []);
        bloquesPorJurado.get(juradoId).push(rodeo.bloque);
        let agregoAsociacion = false;
        if (rodeo.asociacion) {
            if (!asociacionesPorJurado.has(juradoId)) asociacionesPorJurado.set(juradoId, new Set());
            const asocNorm = normalizarAsociacion(rodeo.asociacion);
            if (!asociacionesPorJurado.get(juradoId).has(asocNorm)) {
                asociacionesPorJurado.get(juradoId).add(asocNorm);
                agregoAsociacion = true;
            }
        }
        return agregoAsociacion;
    }
    function desasignarTemporal(juradoId, rodeo, agregoAsociacion) {
        designacionesPorJurado.get(juradoId).delete(rodeo.id);
        bloquesPorJurado.get(juradoId).pop();
        if (agregoAsociacion) asociacionesPorJurado.get(juradoId).delete(normalizarAsociacion(rodeo.asociacion));
    }

    function backtrack() {
        nodos++;
        if (asignado.size > mejorParcial.size) mejorParcial = new Map(asignado);
        // Se comprueba en CADA nodo (Date.now() es nanosegundos) — con nodos
        // caros (lotes grandes) comprobar cada N nodos dejaría pasar varios
        // SEGUNDOS de más antes de notar el límite.
        if (nodos > limiteNodos || Date.now() - inicioMs > limiteMs) {
            limiteAlcanzado = true;
            return false;
        }
        if (pendientesRestantes.size === 0) return true;

        // MRV aproximado: el primer rodeo del orden estático precalculado
        // que siga pendiente — O(1) por comprobación (Set.has), nunca
        // evaluarCandidato() contra rodeos que no se van a elegir.
        let rodeoElegido = null;
        for (const r of ordenEstatico) {
            if (pendientesRestantes.has(r.id)) { rodeoElegido = r; break; }
        }
        const candidatos = candidatosFactibles(rodeoElegido);
        if (candidatos.length === 0) return false; // callejón sin salida — podar ya

        pendientesRestantes.delete(rodeoElegido.id);
        const ordenados = [...candidatos].sort(comparador);

        for (const cand of ordenados) {
            const agregoAsoc = asignarTemporal(cand.jurado.id, rodeoElegido);
            asignado.set(rodeoElegido.id, cand.jurado.id);

            if (backtrack()) return true;

            asignado.delete(rodeoElegido.id);
            desasignarTemporal(cand.jurado.id, rodeoElegido, agregoAsoc);
            if (limiteAlcanzado) { pendientesRestantes.add(rodeoElegido.id); return false; }
        }
        pendientesRestantes.add(rodeoElegido.id);
        return false;
    }

    const exito = rodeosConMatriz.length === 0 ? true : backtrack();
    const asignacionFinal = exito ? asignado : mejorParcial;
    return {
        exito, asignacion: asignacionFinal,
        cobertura: asignacionFinal.size, totalEvaluables: rodeosConMatriz.length,
        nodosExplorados: nodos, limiteAlcanzado, tiempoMs: Date.now() - inicioMs
    };
}

// ─── Construye `{...rodeo, _matrizGlobal}` para cada resultado evaluable ──
function anotarMatrizPorRodeo(contexto, configuracion, evaluables) {
    const matrizPorClasificacion = construirMatrizPorClasificacionDesdeConfiguracion(configuracion.matriz);
    const matrizZonaExtrema = construirMatrizZonaExtremaDesdeConfiguracion(configuracion);
    const asociacionesZonaExtrema = configuracion.zonas_extremas?.asociaciones || [];
    return evaluables.map(r => {
        const rodeo = contexto.rodeosPorId.get(r.rodeo_id);
        rodeo._matrizGlobal = resolverMatrizParaRodeo(rodeo, matrizPorClasificacion, matrizZonaExtrema, asociacionesZonaExtrema).matriz;
        return rodeo;
    });
}

// ─── Escalamiento a lotes grandes — partición por componentes conexas ────
// Problema medido: la búsqueda exacta, corrida sobre TODOS los rodeos
// evaluables de un lote grande (hasta 200, el tope de /dry-run), vuelve a
// escanear cada rodeo pendiente contra cada jurado EN CADA NODO — un costo
// que escala con el tamaño del LOTE COMPLETO, aunque el conflicto real que
// dejó rodeos sin cubrir normalmente involucre solo un puñado de rodeos y
// jurados. Medido con 200 rodeos / 110 jurados (ver informe de cierre): un
// solo nodo de la búsqueda puede costar cientos de milisegundos, agotando
// el presupuesto de tiempo en apenas un puñado de nodos reales.
//
// Solución EXACTA (no heurística — nunca produce un falso "no existe" ni
// un falso "cobertura completa"): dos rodeos solo pueden competir por el
// mismo jurado si existe un jurado elegible (bajo el nivel MÁS PERMISIVO,
// para no excluir nada que la búsqueda en 2 niveles pudiera necesitar) para
// AMBOS. "Compartir un jurado elegible" es una relación — su cierre
// transitivo (componentes conexas, Union-Find) agrupa los rodeos en
// bloques TOTALMENTE independientes entre sí: ningún jurado de un bloque
// puede jamás intervenir en otro. Por lo tanto, un bloque que no contiene
// NINGÚN rodeo SIN_PROPUESTA del greedy no puede mejorarse ni empeorarse
// por nada que decida la búsqueda en otro bloque — se deja exactamente como
// lo dejó el greedy. La búsqueda exacta solo se corre sobre los bloques que
// SÍ contienen al menos un rodeo sin cubrir, y solo considera los jurados
// que ese bloque puede usar — nunca los 110 completos si el conflicto real
// involucra, por ejemplo, 5.
//
// @param rodeosConMatriz  [{...rodeo, _matrizGlobal}, ...] — evaluables
// @param candidatosPorRodeo Map(rodeo.id -> jurado[]) — bajo el nivel
//   permisivo (CAUSAS_RELAJABLES), estado SOLO-BD (sin mutaciones) — un
//   superset seguro de lo que cualquiera de los dos niveles podría usar.
// @returns Map(rodeo.id -> root_id) — mismo root ⇔ mismo componente.
function construirComponentesPorRodeo(rodeosConMatriz, candidatosPorRodeo) {
    const padre = new Map(rodeosConMatriz.map(r => [r.id, r.id]));
    function find(x) { while (padre.get(x) !== x) x = padre.get(x); return x; }
    function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) padre.set(ra, rb); }

    const primerRodeoPorJurado = new Map(); // jurado_id -> primer rodeo.id que lo tiene como candidato
    for (const r of rodeosConMatriz) {
        for (const jurado of (candidatosPorRodeo.get(r.id) || [])) {
            if (primerRodeoPorJurado.has(jurado.id)) union(r.id, primerRodeoPorJurado.get(jurado.id));
            else primerRodeoPorJurado.set(jurado.id, r.id);
        }
    }
    const comp = new Map();
    for (const r of rodeosConMatriz) comp.set(r.id, find(r.id));
    return comp;
}

// ─── Candidatos ESTÁTICOS por rodeo — UNA sola pasada para los 2 niveles ──
// "Estático" = usando el estado SOLO-BD (sin ninguna mutación de esta
// búsqueda) — una cota segura: cualquier jurado que no pase aquí JAMÁS va a
// pasar durante la búsqueda real (las únicas causas que pueden APARECER
// dinámicamente a medida que la búsqueda avanza son las 3 que dependen de
// qué OTRAS asignaciones ya lleva el mismo jurado en esta corrida — mismo
// finde, finde consecutivo, repetición de asociación — nunca categoría,
// disponibilidad, distancia o asociación organizadora, que son fijas por
// (rodeo, jurado) y no cambian durante la búsqueda). Por eso es seguro
// usarla como PRE-FILTRO (nunca como respuesta final — la factibilidad real
// de cada candidato se vuelve a comprobar con evaluarCandidato() contra el
// estado vigente en cada uso, ver candidatosFactibles() más arriba).
//
// Una sola pasada evaluarCandidato() por (rodeo, jurado) sirve para AMBOS
// niveles a la vez (se clasifica el mismo resultado contra las 2 whitelists)
// — nunca se duplica el costo de recorrer rodeos×jurados dos veces.
//
// @returns { estricto: Map(rodeo.id -> jurado[]), permisivo: Map(rodeo.id -> jurado[]) }
function construirCandidatosEstaticosAmbosNiveles(contexto, configuracion, rodeosConMatriz) {
    const comunaJuradoPorId = new Map();
    for (const j of contexto.jurados) comunaJuradoPorId.set(j.id, resolverComuna(j.comuna, contexto.catalogoComunas));
    const estadoSoloBD = construirEstadoDesdeBD(contexto.asignacionesTemporada);
    estadoSoloBD.trasladosPorJuradoBD = construirTrasladosPorJuradoBD(contexto.asignacionesTemporada, comunaJuradoPorId);
    estadoSoloBD.trasladosTemporalesPorJurado = new Map();

    const estricto = new Map(), permisivo = new Map();
    for (const rodeo of rodeosConMatriz) {
        const listaEstricto = [], listaPermisivo = [];
        for (const j of contexto.jurados) {
            const ev = evaluarCandidato(j, rodeo, rodeo._matrizGlobal, contexto.disponibilidad, comunaJuradoPorId, estadoSoloBD, configuracion);
            if (ev.causas.length === 0) listaEstricto.push(j);
            if (ev.causas.every(c => CAUSAS_RELAJABLES.has(c))) listaPermisivo.push(j);
        }
        estricto.set(rodeo.id, listaEstricto);
        permisivo.set(rodeo.id, listaPermisivo);
    }
    return { estricto, permisivo, comunaJuradoPorId };
}

// Usada por resolverAsignacionGlobal() cuando se la llama DIRECTAMENTE (sin
// que ejecutarSimulacionGlobal precalculara nada) — mismo costo, una sola
// pasada, calculado para el nivel pedido únicamente.
function construirCandidatosEstaticosPorRodeo(contexto, configuracion, rodeosConMatriz, causasRelajadas, comunaJuradoPorIdExterno) {
    const comunaJuradoPorId = comunaJuradoPorIdExterno || (() => {
        const m = new Map();
        for (const j of contexto.jurados) m.set(j.id, resolverComuna(j.comuna, contexto.catalogoComunas));
        return m;
    })();
    const estadoSoloBD = construirEstadoDesdeBD(contexto.asignacionesTemporada);
    estadoSoloBD.trasladosPorJuradoBD = construirTrasladosPorJuradoBD(contexto.asignacionesTemporada, comunaJuradoPorId);
    estadoSoloBD.trasladosTemporalesPorJurado = new Map();

    const porRodeo = new Map();
    for (const rodeo of rodeosConMatriz) {
        const lista = [];
        for (const j of contexto.jurados) {
            const ev = evaluarCandidato(j, rodeo, rodeo._matrizGlobal, contexto.disponibilidad, comunaJuradoPorId, estadoSoloBD, configuracion);
            if (ev.causas.every(c => causasRelajadas.has(c))) lista.push(j);
        }
        porRodeo.set(rodeo.id, lista);
    }
    return porRodeo;
}

// Respuesta mínima, siempre bien formada, cuando algo impide calcular
// incluso la línea base (ERROR_TECNICO real — nunca se deja propagar una
// excepción sin forma hacia el llamador HTTP).
function resultadoErrorTecnico(motivo, baseline) {
    const base = baseline || { resumen: { rodeos_solicitados: 0, propuestos: 0, sin_propuesta: 0, no_evaluables: 0, candidatos_analizados: 0 }, resultados: [], asignaciones_temporales: [], jurados_utilizados: [], metricas: {} };
    return {
        ...base,
        motor: 'GLOBAL',
        optimizacion_global: {
            aplicada: false, estado_busqueda: ESTADOS_BUSQUEDA.ERROR_TECNICO,
            motivo: `No se pudo completar el proceso de optimización global: ${motivo}`,
            advertencias: []
        },
        cobertura_completa: false
    };
}

// ─── Capa 2 global — función PURA, testeable con fixtures (sin BD) ───────
// @param contexto      de cargarDatosMotor()
// @param topN           igual semántica que ejecutarSimulacion()
// @param configuracion  configuración de designación ya validada
// @param opciones       { limiteNodos, limiteMs }
function ejecutarSimulacionGlobal(contexto, topN = 5, configuracion = construirConfiguracionDefaultV1(), opciones = {}) {
    let baseline = null;
    try {
        // 1. Línea base — el motor local, SIN modificar (greedy).
        baseline = ejecutarSimulacion(contexto, topN, configuracion);

        const evaluables = baseline.resultados.filter(r => r.estado !== 'NO_EVALUABLE');
        const sinPropuestaBaseline = evaluables.filter(r => r.estado === 'SIN_PROPUESTA');
        const totalCupos = evaluables.length;

        // 2. El greedy ya cubre el 100% — nada que mejorar.
        if (sinPropuestaBaseline.length === 0) {
            return {
                ...baseline,
                motor: 'GLOBAL',
                optimizacion_global: {
                    aplicada: false, estado_busqueda: ESTADOS_BUSQUEDA.COBERTURA_COMPLETA,
                    motivo: totalCupos === 0
                        ? 'No hay rodeos evaluables en esta corrida.'
                        : 'La asignación local ya cubre el 100% de los rodeos evaluables; no fue necesario buscar una alternativa global.',
                    total_cupos: totalCupos, cobertura_obtenida: totalCupos, cupos_pendientes: 0,
                    advertencias: []
                },
                cobertura_completa: true
            };
        }

        const rodeosConMatriz = anotarMatrizPorRodeo(contexto, configuracion, evaluables);

        // 3. Escalamiento (ver construirComponentesPorRodeo arriba): restringe
        //    la búsqueda exacta a los componentes conexos que de verdad
        //    contienen un rodeo sin cubrir — nunca cambia el resultado
        //    posible, solo evita recorrer rodeos/jurados que provadamente no
        //    pueden intervenir. En un lote sin conflicto disperso (el caso
        //    común), el componente contestado es pequeño aunque el lote
        //    tenga 200 rodeos.
        // Una sola pasada rodeos×jurados (nunca por nodo) sirve para calcular,
        // a la vez: los componentes conexos (con el nivel permisivo, el más
        // amplio) y la lista estática por rodeo de CADA nivel — ver
        // construirCandidatosEstaticosAmbosNiveles().
        const { estricto: estaticoEstricto, permisivo: estaticoPermisivo } = construirCandidatosEstaticosAmbosNiveles(contexto, configuracion, rodeosConMatriz);
        const componentePorRodeo = construirComponentesPorRodeo(rodeosConMatriz, estaticoPermisivo);
        const sinPropuestaIds = new Set(sinPropuestaBaseline.map(r => r.rodeo_id));
        const rootsContestados = new Set([...sinPropuestaIds].map(id => componentePorRodeo.get(id)));
        const rodeosContestados = rodeosConMatriz.filter(r => rootsContestados.has(componentePorRodeo.get(r.id)));

        // 4. NIVEL 0 — estricto: exactamente las mismas reglas que el greedy
        //    (ninguna preferencia relajada), restringido al componente
        //    contestado y a su propia lista estática (ya precalculada, no se
        //    repite el costo). Si encuentra cobertura total, es la mejor
        //    respuesta posible (nunca hizo falta ceder nada).
        const tier0 = resolverAsignacionGlobal(contexto, configuracion, rodeosContestados, {
            ...opciones, causasRelajadas: new Set(), candidatosEstaticosPorRodeo: estaticoEstricto
        });

        let busqueda = tier0;
        let relajado = false;

        if (!tier0.exito) {
            // 5. NIVEL 1 — permisivo: las preferencias flexibles (distancia,
            //    repetición de asociación, finde consecutivo, comuna no
            //    resoluble) dejan de bloquear. Las obligatorias NUNCA se
            //    tocan (no están en CAUSAS_RELAJABLES). Presupuesto de
            //    búsqueda PROPIO (no se resta del nivel 0).
            const tier1 = resolverAsignacionGlobal(contexto, configuracion, rodeosContestados, {
                ...opciones, causasRelajadas: CAUSAS_RELAJABLES, candidatosEstaticosPorRodeo: estaticoPermisivo
            });
            busqueda = tier1;
            relajado = tier1.exito;

            // Monotonía: relajar preferencias solo puede AGRANDAR el conjunto
            // de soluciones factibles respecto al nivel estricto — si el
            // nivel permisivo demuestra infactibilidad (no solo límite),
            // automáticamente también es infactible en el nivel estricto, y
            // es la conclusión más fuerte posible: no existe NINGUNA
            // asignación de cobertura total, ni siquiera cediendo preferencias.
            if (!tier1.exito && !tier1.limiteAlcanzado) {
                return {
                    ...baseline,
                    motor: 'GLOBAL',
                    optimizacion_global: {
                        aplicada: false, estado_busqueda: ESTADOS_BUSQUEDA.INFACTIBLE_DEMOSTRADO,
                        motivo: 'Búsqueda exhaustiva (incluso cediendo las preferencias flexibles de distancia, repetición de asociación, fin de semana consecutivo y comuna no resoluble): no existe ninguna asignación posible que cubra el 100% de los rodeos evaluables sin violar una restricción obligatoria (disponibilidad, habilitación de categoría, asociación organizadora o conflicto real de fecha).',
                        total_cupos: totalCupos,
                        cobertura_obtenida: evaluables.length - sinPropuestaBaseline.length,
                        cupos_pendientes: sinPropuestaBaseline.length,
                        // Diagnóstico, NO una cota matemáticamente probada:
                        // el backtracking exige cubrir TODOS los rodeos para
                        // declarar éxito, así que al fallar puede quedarse
                        // en una rama que no exploró activamente todas las
                        // combinaciones de "sacrificar distintos rodeos" —
                        // esto es un valor OBSERVADO durante la búsqueda
                        // exhaustiva, un piso real, pero no se garantiza que
                        // sea la cobertura parcial máxima matemáticamente
                        // posible (ver limitación documentada en el informe
                        // de cierre de Fase 2B).
                        cobertura_parcial_observada: tier1.cobertura,
                        nodos_explorados: tier0.nodosExplorados + tier1.nodosExplorados,
                        tiempo_busqueda_ms: tier0.tiempoMs + tier1.tiempoMs,
                        advertencias: []
                    },
                    cobertura_completa: false
                };
            }

            // Se agotó el presupuesto en el nivel permisivo (el más difícil
            // de concluir) sin poder demostrar ni cobertura total ni
            // infactibilidad — estado honesto: LIMITE_ALCANZADO, nunca se
            // informa como si fuera infactibilidad.
            if (!tier1.exito && tier1.limiteAlcanzado) {
                return {
                    ...baseline,
                    motor: 'GLOBAL',
                    optimizacion_global: {
                        aplicada: false, estado_busqueda: ESTADOS_BUSQUEDA.LIMITE_ALCANZADO,
                        motivo: 'Se alcanzó el límite de búsqueda (nodos o tiempo) antes de poder determinar si existe una asignación con cobertura total, incluso cediendo preferencias flexibles. No se demostró ni la factibilidad ni la imposibilidad — se conservó la mejor asignación local válida encontrada, sin aplicar ningún cambio.',
                        total_cupos: totalCupos,
                        cobertura_obtenida: evaluables.length - sinPropuestaBaseline.length,
                        cupos_pendientes: sinPropuestaBaseline.length,
                        cobertura_parcial_observada: Math.max(tier0.cobertura, tier1.cobertura),
                        limite_busqueda_alcanzado: true,
                        nodos_explorados: tier0.nodosExplorados + tier1.nodosExplorados,
                        tiempo_busqueda_ms: tier0.tiempoMs + tier1.tiempoMs,
                        advertencias: []
                    },
                    cobertura_completa: false
                };
            }
        }

        // 5. Cobertura total encontrada (nivel 0 o nivel 1) — se reconstruye
        //    el resultado final con el formato enriquecido completo,
        //    forzando por rodeo el ganador que dictó la búsqueda. Cuando se
        //    usó el nivel permisivo, se habilita la whitelist de relajación
        //    para el ganador forzado (motorPropuestaDesignacion.js) — nunca
        //    se le permite saltar una causa obligatoria, eso es imposible
        //    por construcción: la propia búsqueda nunca asignó un jurado con
        //    una causa obligatoria pendiente.
        const resultadoFinal = ejecutarSimulacion(contexto, topN, configuracion, {
            forzarGanadorPorRodeo: busqueda.asignacion,
            ...(relajado ? { causasRelajadasPorForzado: CAUSAS_RELAJABLES } : {})
        });

        const rodeosRecuperados = resultadoFinal.resultados
            .filter(r => r.estado === 'PROPUESTO' && sinPropuestaBaseline.some(s => s.rodeo_id === r.rodeo_id))
            .map(r => r.rodeo_id);
        const rodeosReasignados = resultadoFinal.resultados
            .filter(r => r.estado === 'PROPUESTO' && r.jurado_propuesto.optimizacion_global_forzado)
            .map(r => ({ rodeo_id: r.rodeo_id, jurado_id: r.jurado_propuesto.jurado_id }));
        // Advertencias explícitas por preferencia cedida — sección 3 del
        // pedido: "mostrar cuándo fue necesario reacomodar". Solo rodeos
        // donde el ganador forzado realmente tiene alguna causa relajada
        // (optimizacion_global_relajaciones no vacío).
        const advertencias = resultadoFinal.resultados
            .filter(r => r.estado === 'PROPUESTO' && r.jurado_propuesto.optimizacion_global_relajaciones?.length > 0)
            .map(r => ({
                rodeo_id: r.rodeo_id, club: r.rodeo?.club || null, fecha: r.rodeo?.fecha || null,
                jurado_id: r.jurado_propuesto.jurado_id,
                preferencias_cedidas: r.jurado_propuesto.optimizacion_global_relajaciones
            }));

        resultadoFinal.motor = 'GLOBAL';
        resultadoFinal.optimizacion_global = {
            aplicada: true, estado_busqueda: ESTADOS_BUSQUEDA.COBERTURA_COMPLETA,
            motivo: relajado
                ? `Se encontró una asignación global que cubre el 100% de los rodeos evaluables, cediendo preferencias flexibles (no restricciones obligatorias) en ${advertencias.length} rodeo(s) (el motor local solo cubría ${evaluables.length - sinPropuestaBaseline.length} de ${evaluables.length}).`
                : `Se encontró una asignación global que cubre el 100% de los rodeos evaluables sin ceder ninguna preferencia (el motor local, procesando rodeo por rodeo, solo cubría ${evaluables.length - sinPropuestaBaseline.length} de ${evaluables.length}).`,
            total_cupos: totalCupos, cobertura_obtenida: totalCupos, cupos_pendientes: 0,
            nivel_busqueda: relajado ? 'PREFERENCIAS_RELAJADAS' : 'ESTRICTO',
            rodeos_recuperados: rodeosRecuperados,
            rodeos_con_ganador_forzado: rodeosReasignados,
            nodos_explorados: tier0.nodosExplorados + (busqueda !== tier0 ? busqueda.nodosExplorados : 0),
            tiempo_busqueda_ms: tier0.tiempoMs + (busqueda !== tier0 ? busqueda.tiempoMs : 0),
            advertencias
        };
        resultadoFinal.cobertura_completa = true;
        return resultadoFinal;
    } catch (err) {
        return resultadoErrorTecnico(err.message, baseline);
    }
}

// ─── Capa 3 — carga de datos + simulación global + métricas de rendimiento ─
// Analoga exacta de generarSimulacion() (motorPropuestaDesignacion.js), solo
// que corre ejecutarSimulacionGlobal() en vez de ejecutarSimulacion().
async function generarSimulacionGlobal(rodeoIdsInput, topN = 5, configuracion = construirConfiguracionDefaultV1(), opciones = {}) {
    const inicioMs = Date.now();
    const contexto = await cargarDatosMotor(rodeoIdsInput);
    const finCargaMs = Date.now();
    const resultado = ejecutarSimulacionGlobal(contexto, topN, configuracion, opciones);
    const finMotorMs = Date.now();

    const juradoIdsGanadores = [...new Set(
        resultado.resultados.filter(r => r.estado === 'PROPUESTO').map(r => r.jurado_propuesto.jurado_id)
    )];
    if (juradoIdsGanadores.length > 0) {
        const hoyChile = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
        const [datosRendimiento, historialPorJurado] = await Promise.all([
            cargarRendimientoTemporada(contexto),
            cargarHistorialRecienteBatch(juradoIdsGanadores)
        ]);
        const rendimientoPorJurado = construirRendimientoPorJurado(datosRendimiento, contexto.jurados, juradoIdsGanadores, hoyChile);
        for (const r of resultado.resultados) {
            if (r.estado === 'PROPUESTO') {
                r.jurado_propuesto.rendimiento_temporada = rendimientoPorJurado.get(r.jurado_propuesto.jurado_id) || null;
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
    ejecutarSimulacionGlobal, generarSimulacionGlobal, resolverAsignacionGlobal,
    LIMITE_NODOS_DEFAULT, LIMITE_MS_DEFAULT,
    CAUSAS_RELAJABLES, CAUSAS_OBLIGATORIAS, ESTADOS_BUSQUEDA
};
