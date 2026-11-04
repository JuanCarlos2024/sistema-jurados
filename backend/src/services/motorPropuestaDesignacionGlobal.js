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
//     ASOCIACION_REPETIDA_INTERVALO — (schema_version=4, corrección Etapa C,
//                                     sección 3 del pedido) regla de 6 meses
//                                     (configurable) entre designaciones de
//                                     la MISMA asociación: "el motor NO puede
//                                     repetir automáticamente una asociación
//                                     si no han transcurrido [N] meses desde
//                                     la última designación efectiva... no
//                                     debe saltarse automáticamente esta
//                                     restricción". Antes (Etapa B) estaba
//                                     entre las relajables — el usuario
//                                     corrigió explícitamente ese diseño: a
//                                     diferencia de ASOCIACION_REPETIDA_
//                                     TEMPORADA (repetición dentro del MISMO
//                                     lote/temporada, sigue siendo relajable,
//                                     sin cambios), esta regla mira historial
//                                     real con fecha de corte y nunca se cede
//                                     para ganar cobertura — si bloquea un
//                                     rodeo, el motor debe EXPLICARLO como
//                                     SIN_PROPUESTA, nunca forzar la repetición.
//
//   PREFERENCIAS FLEXIBLES (relajables SOLO en el 2º nivel de búsqueda, y
//   SOLO cuando sea la única forma de cubrir el 100% de los cupos):
//     DISTANCIA_EXCEDIDA            — "distancia de referencia" de 600 km.
//     ASOCIACION_REPETIDA_TEMPORADA — repetición de asociación organizadora
//                                     ya designada en la temporada (mismo
//                                     lote, sin mirar fechas históricas —
//                                     distinta de ASOCIACION_REPETIDA_
//                                     INTERVALO, ver arriba, que SÍ es
//                                     obligatoria).
//     FINDE_CONSECUTIVO             — dos rodeos en fines de semana
//                                     consecutivos (NO el mismo fin de
//                                     semana — eso es MISMO_FINDE, siempre
//                                     obligatorio). Expresamente SIGUE siendo
//                                     relajable (pedido, Etapa C, sección 3:
//                                     "independiente de permitir fines de
//                                     semana consecutivos, que sí puede
//                                     flexibilizarse").
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
const { cargarNotaTecnicaPorJurado } = require('./notaTecnicaJurados');

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
//
// CORRECCIÓN (Etapa C, sección 3 del pedido): ASOCIACION_REPETIDA_INTERVALO
// se retiró de esta lista — el usuario corrigió explícitamente el diseño de
// la Etapa B ("la regla acordada es que el motor NO pueda repetir
// automáticamente una asociación si no han transcurrido [N] meses... no
// debe saltarse automáticamente esta restricción"). Queda como OBLIGATORIA
// (ver CAUSAS_OBLIGATORIAS) — nunca se cede, en ningún nivel de búsqueda,
// aunque eso reduzca la cobertura máxima factible; si bloquea un rodeo, se
// reporta SIN_PROPUESTA con el motivo explícito (descartes), nunca se fuerza.
const CAUSAS_RELAJABLES = new Set(['DISTANCIA_EXCEDIDA', 'ASOCIACION_REPETIDA_TEMPORADA', 'FINDE_CONSECUTIVO', 'JURADO_SIN_COMUNA_RESOLVIBLE']);
// Documental/tests — todas las causas que evaluarCandidato() puede producir,
// menos las relajables, son las obligatorias (DISPONIBILIDAD,
// CATEGORIA_INCOMPATIBLE, MISMA_ASOCIACION, MISMO_FINDE,
// ASOCIACION_REPETIDA_INTERVALO — ver corrección arriba).
const CAUSAS_OBLIGATORIAS = new Set(['DISPONIBILIDAD', 'CATEGORIA_INCOMPATIBLE', 'MISMA_ASOCIACION', 'MISMO_FINDE', 'ASOCIACION_REPETIDA_INTERVALO']);

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
    // CORRECCIÓN (Etapa C, sección 3/4 del pedido): faltaban aquí —
    // evaluarCandidato() nunca podía detectar ASOCIACION_REPETIDA_INTERVALO
    // (histórico real, fuera de esta temporada) ni usar la nota técnica como
    // desempate DURANTE esta búsqueda exacta, aunque el llamador
    // (ejecutarSimulacionGlobal/generarSimulacionGlobal) ya las cargara en
    // `contexto` — resolverPrioridadDeportiva() sí las incluía en su propio
    // estado, pero esta función (la que decide la cobertura MÁXIMA, tier0/
    // tier1) no. Se detectó al escribir las pruebas de la corrección de la
    // sección 3: un jurado que debía quedar SIN_PROPUESTA (única vía posible
    // viola el intervalo obligatorio de 6 meses) terminaba propuesto de
    // todas formas por el nivel ESTRICTO, que nunca vio la causa.
    const estado = {
        asociacionesPorJurado, bloquesPorJurado, designacionesPorJurado, trasladosPorJuradoBD, trasladosTemporalesPorJurado,
        ultimaFechaAsociacionPorJurado: contexto.ultimaFechaAsociacionPorJurado, notaTecnicaPorJurado: contexto.notaTecnicaPorJurado
    };

    const comparador = construirComparadorJerarquico(configuracion.ordenCriterios, configuracion.umbral_lejania_km);

    // Candidatos ESTÁTICOS por rodeo — ver comentario de cabecera. Si no se
    // pasó precalculado, se calcula aquí (una sola vez, no por nodo).
    const candidatosEstaticosPorRodeo = opciones.candidatosEstaticosPorRodeo
        || construirCandidatosEstaticosPorRodeo(contexto, configuracion, rodeosConMatriz, causasRelajadas, comunaJuradoPorId);

    // Corrección (sección 8): un rodeo con CERO candidatos estáticos (ya
    // bajo el nivel permisivo de ESTE tier) nunca puede asignarse en NINGÚN
    // nodo de esta búsqueda — es una imposibilidad estructural, no depende
    // de qué otras decisiones tome el backtracking. Incluirlo en la lista
    // de pendientes no solo es inútil: al tener SIEMPRE la menor cantidad
    // de candidatos (0), el orden MRV lo procesa PRIMERO y el nodo raíz
    // completo falla de inmediato (`candidatos.length === 0` más abajo)
    // ANTES de intentar cubrir ningún otro rodeo — "envenenando" la
    // búsqueda entera y dejando `mejorParcial` vacío aunque el resto del
    // lote sí tuviera una combinación perfectamente factible. Se excluyen
    // aquí de lo que el backtracking realmente explora; la exigencia de
    // cobertura TOTAL (`exito`) de todo `rodeosConMatriz` se preserva
    // exacta más abajo (nunca puede ser true si existe uno de estos).
    const rodeosSinCandidatos = new Set(
        rodeosConMatriz.filter(r => (candidatosEstaticosPorRodeo.get(r.id) || []).length === 0).map(r => r.id)
    );
    const rodeosBuscables = rodeosSinCandidatos.size === 0 ? rodeosConMatriz : rodeosConMatriz.filter(r => !rodeosSinCandidatos.has(r.id));

    // Orden MRV APROXIMADO, precalculado UNA sola vez: rodeos ordenados
    // ascendente por cantidad de candidatos ESTÁTICOS. Cualquier orden de
    // ramificación es válido para la CORRECCIÓN del backtracking (prueba
    // todos los candidatos del rodeo elegido, sin importar cuál se eligió
    // primero) — este orden solo decide qué tan rápido se converge, nunca
    // si la respuesta final es correcta.
    const ordenEstatico = [...rodeosBuscables].sort(
        (a, b) => (candidatosEstaticosPorRodeo.get(a.id)?.length || 0) - (candidatosEstaticosPorRodeo.get(b.id)?.length || 0)
    );
    const rodeoPorId = new Map(rodeosConMatriz.map(r => [r.id, r]));

    const asignado = new Map(); // rodeo_id -> jurado_id
    const pendientesRestantes = new Set(rodeosBuscables.map(r => r.id)); // mutado durante la búsqueda
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

    // La cobertura TOTAL de `rodeosConMatriz` (lo que `exito` promete) nunca
    // puede ser true si existe al menos un rodeo sin ningún candidato — eso
    // se decide aquí, independientemente de cómo le haya ido al backtracking
    // sobre `rodeosBuscables` (que persigue cubrir el resto al máximo).
    const exitoBuscables = rodeosBuscables.length === 0 ? true : backtrack();
    const exito = exitoBuscables && rodeosSinCandidatos.size === 0;
    const asignacionFinal = exitoBuscables ? asignado : mejorParcial;
    return {
        exito, asignacion: asignacionFinal,
        cobertura: asignacionFinal.size, totalEvaluables: rodeosConMatriz.length,
        nodosExplorados: nodos, limiteAlcanzado, tiempoMs: Date.now() - inicioMs
    };
}

// ═════════════════════════════════════════════════════════════════════════
// Objetivo secundario — Prioridad Deportiva + Calidad Técnica
// (schema_version=4, pedido "Motor Global con Prioridad de Rodeos,
// Categorías y Calidad Técnica", Etapa B).
//
// "Primero maximizar la cobertura, después optimizar la prioridad
// deportiva..." — la cobertura máxima (`coberturaObjetivo`) SIEMPRE se
// calcula primero con resolverAsignacionGlobal() (sin modificar esa
// función en absoluto); este objetivo secundario NUNCA puede sacrificar un
// solo cupo de cobertura para mejorar la prioridad deportiva —
// coberturaObjetivo es un piso DURO (ver poda de factibilidad más abajo).
//
// Costo de una asignación completa = SUMA, por cada rodeo asignado, de
// peso_prioridad(rodeo.clasificacion_codigo) × costo_categoria(rodeo, jurado):
//   peso_prioridad   — de configuracion.prioridad_clasificaciones (orden=1
//                       la MÁXIMA prioridad deportiva, configurable, nunca
//                       fijo en código — sección 1/2 del pedido): mayor
//                       peso para las clasificaciones de mayor prioridad,
//                       así que darle a un zonal una categoría peor que la
//                       ideal cuesta MUCHO más que la misma "degradación"
//                       en un interclubes — esto ES, en sí mismo, "reservar
//                       los mejores jurados para los rodeos que más los
//                       necesitan".
//   costo_categoria  — rodeo._matrizGlobal.ordenPorCategoria.get(categoria)
//                       - 1: 0 si el jurado tiene la categoría MÁS
//                       preferida para ese rodeo (nunca penaliza al jurado
//                       ideal), 1 si es la 2ª preferida, etc. Reutiliza la
//                       MISMA matriz ya resuelta (zona extrema incluida)
//                       que usa el resto del motor — nunca una fuente
//                       paralela de "qué categoría es mejor para este rodeo".
//
// CORRECCIÓN (Etapa C, sección 4 del pedido): la NOTA TÉCNICA SÍ debe
// participar, pero exclusivamente como DESEMPATE — el usuario detectó que,
// con dos jurados A igualmente elegibles (misma categoría ideal, mismo
// costo_categoria=0) para un zonal y un interasociaciones, el costo de
// prioridad deportiva quedaba EMPATADO entre "A de nota 6,3 → zonal" y "A
// de nota 5,2 → zonal": el objetivo era indiferente a cuál de los dos A
// terminaba en el rodeo de mayor prioridad, pudiendo elegir arbitrariamente
// el de peor nota técnica. `costoNotaTecnicaCandidato` + `ESCALA_COSTO_
// CATEGORIA` abajo resuelven esto como un desempate LEXICOGRÁFICO estricto,
// nunca como un "tipo de cambio" entre nota técnica y prioridad deportiva:
// el costo de categoría se escala por ESCALA_COSTO_CATEGORIA antes de sumar
// el término de nota técnica, así que NINGUNA combinación de diferencias de
// nota técnica (acotadas por NOTA_TECNICA_MAXIMA, sumadas sobre TODO el
// lote) puede jamás invertir una diferencia real de 1 unidad de
// costo_categoria en ningún rodeo — la distribución de categorías A/B/C
// sigue siendo SIEMPRE lo primero que se optimiza; la nota técnica solo
// decide ENTRE soluciones que ya son óptimas en categoría. Sigue sin
// mezclarse con el criterio NOTA_TECNICA del comparador (motor local,
// desempate dentro de un MISMO rodeo) — son dos mecanismos independientes
// que, con esta corrección, apuntan en la misma dirección en vez de
// contradecirse.
// ═════════════════════════════════════════════════════════════════════════
function calcularPesoPorClasificacion(prioridadClasificaciones) {
    const lista = prioridadClasificaciones || [];
    const total = lista.length;
    const pesos = new Map();
    for (const f of lista) pesos.set(f.clasificacion_codigo, total - f.orden + 1);
    return pesos;
}

// Tope documentado de la escala de nota técnica (evaluacionDesempenoJurados.js
// / notas_rodeo.nota) — usado SOLO para acotar este desempate interno, nunca
// mostrado ni almacenado como una nota real.
const NOTA_TECNICA_MAXIMA = 7;
// Garantiza la dominancia lexicográfica descrita arriba: con hasta 6
// clasificaciones (peso máximo 6) y lotes reales de hasta 200 rodeos, la
// suma máxima posible del término de nota técnica es 200 × 6 × 7 = 8400,
// muy por debajo de esta escala — así que 1 sola unidad de costo_categoria
// en un solo rodeo siempre pesa más que la nota técnica de TODO el lote.
const ESCALA_COSTO_CATEGORIA = 1000000;

// Penalización de desempate por nota técnica de UN candidato — mayor nota,
// menor costo. Una nota AUSENTE (jurado sin evaluación técnica todavía)
// recibe la penalización MÁXIMA (mismo criterio que el comparador
// NOTA_TECNICA: nunca mejor que cualquier nota real conocida), sin fingir
// que equivale a una nota real de 0.
function costoNotaTecnicaCandidato(jurado, notaTecnicaPorJurado) {
    const nota = notaTecnicaPorJurado.get(jurado?.id)?.promedio;
    const notaEfectiva = nota ?? 0;
    return Math.max(0, NOTA_TECNICA_MAXIMA - notaEfectiva);
}

// Costo de UN rodeo ya asignado — reutilizado tanto para evaluar una
// asignación completa como para acumular costo nodo a nodo durante la
// búsqueda (branch-and-bound, poda por cota inferior).
// `notaTecnicaPorJurado` es OPCIONAL (Map|undefined) — cuando no se pasa
// (p. ej. criterio NOTA_TECNICA inactivo, o llamadas existentes que no la
// necesitan), el costo es EXACTAMENTE el de antes de esta corrección, sin
// ningún término adicional ni cambio de escala.
function costoRodeoAsignado(rodeo, juradoId, juradoPorId, pesoPorClasificacion, notaTecnicaPorJurado) {
    const jurado = juradoPorId.get(juradoId);
    const ordenPreferencia = rodeo._matrizGlobal?.ordenPorCategoria?.get(jurado?.categoria);
    const costoCategoria = (ordenPreferencia || 1) - 1; // nunca negativo; sin matriz resuelta, costo 0 (defensivo)
    const peso = pesoPorClasificacion.get(rodeo.clasificacion_codigo) ?? 1;
    const costoBase = peso * costoCategoria;
    if (!notaTecnicaPorJurado) return costoBase;
    const costoNota = peso * costoNotaTecnicaCandidato(jurado, notaTecnicaPorJurado);
    return costoBase * ESCALA_COSTO_CATEGORIA + costoNota;
}

function calcularCostoPrioridadDeportiva(asignacion, rodeoPorId, juradoPorId, pesoPorClasificacion, notaTecnicaPorJurado) {
    let total = 0;
    for (const [rodeoId, juradoId] of asignacion.entries()) {
        total += costoRodeoAsignado(rodeoPorId.get(rodeoId), juradoId, juradoPorId, pesoPorClasificacion, notaTecnicaPorJurado);
    }
    return total;
}

// ─── Búsqueda del objetivo secundario (branch-and-bound) ─────────────────
// Explora el MISMO espacio de soluciones que resolverAsignacionGlobal()
// (misma evaluarCandidato(), mismo candidatosEstaticosPorRodeo del nivel ya
// probado) pero, a diferencia de esa búsqueda (que se detiene en la
// PRIMERA cobertura total encontrada), sigue explorando después de
// encontrar una solución completa, buscando una de MENOR costo, y PODA
// cualquier rama cuyo costo acumulado ya iguale o supere la mejor solución
// completa conocida (válido porque el costo nunca es negativo: solo puede
// crecer al agregar más asignaciones).
//
// SIEMPRE arranca con `asignacionSemilla` (la cobertura máxima ya probada
// por resolverAsignacionGlobal) como cota superior inicial — así, aunque se
// agote el presupuesto de nodos/tiempo ANTES de mejorar nada, el resultado
// NUNCA es peor que no haber corrido este objetivo secundario en absoluto
// (sección 2 del pedido: "nunca debe abandonar una cobertura parcial mejor").
//
// @returns { asignacion, costo, costoSemilla, cobertura, mejorada, nodosExplorados, limiteAlcanzado, tiempoMs }
function resolverPrioridadDeportiva(contexto, configuracion, rodeosBuscables, coberturaObjetivo, candidatosEstaticosPorRodeo, causasRelajadas, asignacionSemilla, opciones = {}) {
    const limiteNodos = opciones.limiteNodosPrioridad || LIMITE_NODOS_DEFAULT;
    const limiteMs = opciones.limiteMsPrioridad || LIMITE_MS_DEFAULT;
    const inicioMs = Date.now();

    const rodeoPorId = new Map(rodeosBuscables.map(r => [r.id, r]));
    const juradoPorId = new Map(contexto.jurados.map(j => [j.id, j]));
    const pesoPorClasificacion = calcularPesoPorClasificacion(configuracion.prioridad_clasificaciones);
    // Corrección (Etapa C, sección 4 del pedido) — ver comentario de cabecera
    // de costoRodeoAsignado(): el desempate por nota técnica solo se activa
    // si el criterio NOTA_TECNICA está realmente en el orden configurado
    // (mismo gate que ya usa el resto del motor para esta mejora) Y hay datos
    // cargados en el contexto; de lo contrario queda `undefined` y el costo
    // es idéntico, bit a bit, al de antes de esta corrección.
    const notaTecnicaActiva = (configuracion.ordenCriterios || []).some(o => o.criterio_codigo === 'NOTA_TECNICA')
        ? contexto.notaTecnicaPorJurado
        : undefined;
    const costoSemilla = calcularCostoPrioridadDeportiva(asignacionSemilla, rodeoPorId, juradoPorId, pesoPorClasificacion, notaTecnicaActiva);

    const comunaJuradoPorId = new Map();
    for (const j of contexto.jurados) comunaJuradoPorId.set(j.id, resolverComuna(j.comuna, contexto.catalogoComunas));
    const { designacionesPorJurado, bloquesPorJurado, asociacionesPorJurado } = construirEstadoDesdeBD(contexto.asignacionesTemporada);
    const trasladosPorJuradoBD = construirTrasladosPorJuradoBD(contexto.asignacionesTemporada, comunaJuradoPorId);
    const trasladosTemporalesPorJurado = new Map();
    const estado = {
        asociacionesPorJurado, bloquesPorJurado, designacionesPorJurado, trasladosPorJuradoBD, trasladosTemporalesPorJurado,
        ultimaFechaAsociacionPorJurado: contexto.ultimaFechaAsociacionPorJurado, notaTecnicaPorJurado: contexto.notaTecnicaPorJurado
    };
    const comparador = construirComparadorJerarquico(configuracion.ordenCriterios, configuracion.umbral_lejania_km);

    const ordenEstatico = [...rodeosBuscables].sort(
        (a, b) => (candidatosEstaticosPorRodeo.get(a.id)?.length || 0) - (candidatosEstaticosPorRodeo.get(b.id)?.length || 0)
    );

    const asignado = new Map();
    const pendientesRestantes = new Set(rodeosBuscables.map(r => r.id));
    let costoAcumulado = 0;
    let mejorAsignacion = new Map(asignacionSemilla);
    let mejorCosto = costoSemilla;
    let nodos = 0;
    let limiteAlcanzado = false;

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
            if (!asociacionesPorJurado.get(juradoId).has(asocNorm)) { asociacionesPorJurado.get(juradoId).add(asocNorm); agregoAsociacion = true; }
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
        if (nodos > limiteNodos || Date.now() - inicioMs > limiteMs) { limiteAlcanzado = true; return; }

        if (pendientesRestantes.size === 0) {
            if (asignado.size >= coberturaObjetivo && costoAcumulado < mejorCosto) {
                mejorCosto = costoAcumulado;
                mejorAsignacion = new Map(asignado);
            }
            return; // nunca se detiene en la primera — sigue buscando otra combinación mejor
        }
        // Poda de factibilidad — piso DURO: coberturaObjetivo nunca se sacrifica.
        if (asignado.size + pendientesRestantes.size < coberturaObjetivo) return;
        // Poda por costo — esta rama ya es igual o peor que la mejor completa conocida.
        if (costoAcumulado >= mejorCosto) return;

        let rodeoElegido = null;
        for (const r of ordenEstatico) { if (pendientesRestantes.has(r.id)) { rodeoElegido = r; break; } }
        const candidatos = candidatosFactibles(rodeoElegido);
        pendientesRestantes.delete(rodeoElegido.id);

        // Explora TAMBIÉN la opción de dejar este rodeo sin cubrir (si la
        // cobertura restante todavía puede alcanzar el objetivo) — nunca se
        // asume que el patrón de "quién queda sin cubrir" de la cobertura
        // máxima original es el único válido; distintos jurados libres
        // cambian qué combinación respeta mejor la prioridad deportiva.
        if (asignado.size + pendientesRestantes.size >= coberturaObjetivo) {
            backtrack();
            if (limiteAlcanzado) { pendientesRestantes.add(rodeoElegido.id); return; }
        }

        // Candidatos ordenados por costo ascendente (poda temprana más
        // efectiva — explora primero las ramas más prometedoras); desempate
        // por el comparador ya configurado, nunca aleatorio.
        const ordenados = [...candidatos].sort((a, b) => {
            const ca = costoRodeoAsignado(rodeoElegido, a.jurado.id, juradoPorId, pesoPorClasificacion, notaTecnicaActiva);
            const cb = costoRodeoAsignado(rodeoElegido, b.jurado.id, juradoPorId, pesoPorClasificacion, notaTecnicaActiva);
            return ca !== cb ? ca - cb : comparador(a, b);
        });

        for (const cand of ordenados) {
            const costoCand = costoRodeoAsignado(rodeoElegido, cand.jurado.id, juradoPorId, pesoPorClasificacion, notaTecnicaActiva);
            if (costoAcumulado + costoCand >= mejorCosto) continue; // poda — ni probar esta rama
            const agregoAsoc = asignarTemporal(cand.jurado.id, rodeoElegido);
            asignado.set(rodeoElegido.id, cand.jurado.id);
            costoAcumulado += costoCand;

            backtrack();

            costoAcumulado -= costoCand;
            asignado.delete(rodeoElegido.id);
            desasignarTemporal(cand.jurado.id, rodeoElegido, agregoAsoc);
            if (limiteAlcanzado) { pendientesRestantes.add(rodeoElegido.id); return; }
        }
        pendientesRestantes.add(rodeoElegido.id);
    }

    if (rodeosBuscables.length > 0) backtrack();

    return {
        asignacion: mejorAsignacion, costo: mejorCosto, costoSemilla, cobertura: mejorAsignacion.size,
        mejorada: mejorCosto < costoSemilla,
        nodosExplorados: nodos, limiteAlcanzado, tiempoMs: Date.now() - inicioMs
    };
}

// ─── Aplica el objetivo secundario SOLO si la regla está activa — devuelve
// siempre la misma forma, aplicada o no, para que el llamador no tenga que
// ramificar. Si `asignacionBase` está vacía (nada que optimizar) o la regla
// está inactiva (default — nunca se activa sola, sección 5 del pedido:
// "no activar automáticamente"), devuelve la asignación tal cual, sin costo
// alguno de cómputo adicional.
function aplicarPrioridadDeportivaSiCorresponde(contexto, configuracion, rodeosBuscables, asignacionBase, coberturaObjetivo, candidatosEstaticosPorRodeo, causasRelajadas, opciones) {
    if (!configuracion.regla_prioridad_deportiva_activa || asignacionBase.size === 0) {
        return { asignacion: asignacionBase, info: null };
    }
    const r = resolverPrioridadDeportiva(contexto, configuracion, rodeosBuscables, coberturaObjetivo, candidatosEstaticosPorRodeo, causasRelajadas, asignacionBase, opciones);
    return {
        asignacion: r.asignacion,
        info: {
            aplicada: true, mejorada: r.mejorada,
            costo_local_original: r.costoSemilla, costo_final: r.costo,
            nodos_explorados: r.nodosExplorados, tiempo_busqueda_ms: r.tiempoMs,
            limite_alcanzado: r.limiteAlcanzado
        }
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
// dinámicamente a medida que la búsqueda avanza son las que dependen de qué
// OTRAS asignaciones ya lleva el mismo jurado EN ESTA CORRIDA — mismo
// finde, finde consecutivo, repetición de asociación DENTRO DEL LOTE
// [ASOCIACION_REPETIDA_TEMPORADA] — nunca categoría, disponibilidad,
// distancia, asociación organizadora NI la repetición de asociación por
// INTERVALO histórico [ASOCIACION_REPETIDA_INTERVALO, schema_version=4]:
// esta última mira `contexto.ultimaFechaAsociacionPorJurado`, fijo ANTES de
// que la búsqueda empiece (no depende de qué decida el backtracking), así
// que es seguro — y correcto, ver corrección de abajo — incluirla aquí.
// Por eso es seguro usar este resultado como PRE-FILTRO (nunca como
// respuesta final — la factibilidad real de cada candidato se vuelve a
// comprobar con evaluarCandidato() contra el estado vigente en cada uso,
// ver candidatosFactibles() más arriba).
//
// CORRECCIÓN (Etapa C): antes de esta corrección, `estadoSoloBD` no incluía
// `ultimaFechaAsociacionPorJurado` ni `notaTecnicaPorJurado` — un jurado que
// infringía el intervalo de 6 meses pasaba igual este pre-filtro (como si
// no tuviera esa causa) y la nota técnica nunca participaba del desempate
// NI AQUÍ ni en la búsqueda real (ver misma corrección en
// resolverAsignacionGlobal(), que sí la sufría de forma crítica: hacía que
// el nivel ESTRICTO propusiera jurados que en realidad infringían el
// intervalo obligatorio).
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
    estadoSoloBD.ultimaFechaAsociacionPorJurado = contexto.ultimaFechaAsociacionPorJurado;
    estadoSoloBD.notaTecnicaPorJurado = contexto.notaTecnicaPorJurado;

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
    // Misma corrección que construirCandidatosEstaticosAmbosNiveles() —
    // ver su comentario de cabecera.
    estadoSoloBD.ultimaFechaAsociacionPorJurado = contexto.ultimaFechaAsociacionPorJurado;
    estadoSoloBD.notaTecnicaPorJurado = contexto.notaTecnicaPorJurado;

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

        // 2. El greedy ya cubre el 100% — nada que mejorar EN COBERTURA. Pero
        //    "primero maximizar la cobertura, después optimizar la
        //    prioridad deportiva" (sección 2 del pedido) no se detiene acá
        //    si la regla de prioridad deportiva está activa (schema_version
        //    =4): el greedy local nunca razona entre rodeos DISTINTOS —
        //    puede cubrir el 100% y, aun así, haberle dado la categoría
        //    equivocada a un rodeo de alta prioridad porque el jurado ideal
        //    ya estaba "gastado" en uno de menor prioridad. Se reutiliza el
        //    MISMO objetivo secundario que el resto de esta función, sobre
        //    la semilla que el propio greedy ya encontró (nunca se pierde
        //    cobertura: coberturaObjetivo = totalCupos, piso duro).
        if (sinPropuestaBaseline.length === 0) {
            if (!configuracion.regla_prioridad_deportiva_activa || totalCupos === 0) {
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

            const rodeosConMatrizTotal = anotarMatrizPorRodeo(contexto, configuracion, evaluables);
            const comunaJuradoPorId = new Map();
            for (const j of contexto.jurados) comunaJuradoPorId.set(j.id, resolverComuna(j.comuna, contexto.catalogoComunas));
            // El greedy local cubrió el 100% SIN ceder ninguna preferencia
            // (el motor local nunca relaja nada — ese concepto es exclusivo
            // del motor global) — el objetivo secundario opera siempre al
            // nivel ESTRICTO acá, nunca uno relajado que el local ni usó.
            const candidatosEstaticosTotal = construirCandidatosEstaticosPorRodeo(contexto, configuracion, rodeosConMatrizTotal, new Set(), comunaJuradoPorId);
            const asignacionSemilla = new Map(
                baseline.resultados.filter(r => r.estado === 'PROPUESTO').map(r => [r.rodeo_id, r.jurado_propuesto.jurado_id])
            );

            const { asignacion: asignacionOptimizada, info: prioridadDeportivaInfo } = aplicarPrioridadDeportivaSiCorresponde(
                contexto, configuracion, rodeosConMatrizTotal, asignacionSemilla, totalCupos,
                candidatosEstaticosTotal, new Set(), opciones
            );

            if (!prioridadDeportivaInfo?.mejorada) {
                return {
                    ...baseline,
                    motor: 'GLOBAL',
                    optimizacion_global: {
                        aplicada: false, estado_busqueda: ESTADOS_BUSQUEDA.COBERTURA_COMPLETA,
                        motivo: 'La asignación local ya cubre el 100% de los rodeos evaluables y ya respeta de la mejor forma posible la prioridad deportiva configurada; no fue necesario reasignar nada.',
                        total_cupos: totalCupos, cobertura_obtenida: totalCupos, cupos_pendientes: 0,
                        prioridad_deportiva: prioridadDeportivaInfo,
                        advertencias: []
                    },
                    cobertura_completa: true
                };
            }

            const resultadoConPrioridad = ejecutarSimulacion(contexto, topN, configuracion, { forzarGanadorPorRodeo: asignacionOptimizada });
            const rodeosReasignadosPorPrioridad = resultadoConPrioridad.resultados
                .filter(r => r.estado === 'PROPUESTO' && r.jurado_propuesto.optimizacion_global_forzado)
                .map(r => ({ rodeo_id: r.rodeo_id, jurado_id: r.jurado_propuesto.jurado_id }));
            resultadoConPrioridad.motor = 'GLOBAL';
            resultadoConPrioridad.optimizacion_global = {
                aplicada: true, estado_busqueda: ESTADOS_BUSQUEDA.COBERTURA_COMPLETA,
                motivo: `La asignación local ya cubría el 100% de los rodeos evaluables; se reasignaron ${rodeosReasignadosPorPrioridad.length} rodeo(s) para respetar mejor la prioridad deportiva configurada, sin perder cobertura.`,
                total_cupos: totalCupos, cobertura_obtenida: totalCupos, cupos_pendientes: 0,
                nivel_busqueda: 'ESTRICTO',
                rodeos_recuperados: [],
                rodeos_con_ganador_forzado: rodeosReasignadosPorPrioridad,
                prioridad_deportiva: prioridadDeportivaInfo,
                advertencias: []
            };
            resultadoConPrioridad.cobertura_completa = true;
            return resultadoConPrioridad;
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

            // Sección 8 (corrección): ambas ramas de abajo antes devolvían
            // `baseline` tal cual — la solución del motor LOCAL original —
            // descartando la mejor combinación PARCIAL que el propio
            // backtracking ya calculó y guardó en `mejorParcial` (ver
            // resolverAsignacionGlobal: `asignacionFinal = exito ? asignado :
            // mejorParcial`). Una cobertura imposible al 100% nunca justifica
            // tirar oportunidades reales que la búsqueda sí encontró para los
            // demás rodeos. Se materializa aquí la mejor de las dos (tier0 vs
            // tier1 — tier1 explora un superconjunto de candidatos, pero con
            // presupuesto propio, así que no se asume que domine a tier0 sin
            // comprobarlo) con el MISMO mecanismo `forzarGanadorPorRodeo` que
            // ya usa el camino de éxito más abajo — nunca una reconstrucción
            // paralela.
            const mejorBusqueda = tier1.cobertura >= tier0.cobertura ? tier1 : tier0;
            const usoPreferenciasRelajadas = mejorBusqueda === tier1 && tier1.cobertura > 0;

            // Objetivo secundario — Prioridad Deportiva (schema_version=4,
            // sección 2 del pedido): opera SOBRE la cobertura parcial máxima
            // ya probada arriba (mejorBusqueda.asignacion) — nunca puede
            // reducirla, solo redistribuir QUIÉN cubre cada rodeo entre las
            // combinaciones que logran la MISMA cobertura. Mismo nivel
            // (candidatos estáticos + causas relajadas) que ya probó
            // mejorBusqueda, nunca uno distinto.
            const { asignacion: asignacionOptimizada, info: prioridadDeportivaInfo } = aplicarPrioridadDeportivaSiCorresponde(
                contexto, configuracion, rodeosContestados, mejorBusqueda.asignacion, mejorBusqueda.cobertura,
                usoPreferenciasRelajadas ? estaticoPermisivo : estaticoEstricto,
                usoPreferenciasRelajadas ? CAUSAS_RELAJABLES : new Set(),
                opciones
            );

            const resultadoParcial = asignacionOptimizada.size > 0
                ? ejecutarSimulacion(contexto, topN, configuracion, {
                      forzarGanadorPorRodeo: asignacionOptimizada,
                      ...(usoPreferenciasRelajadas ? { causasRelajadasPorForzado: CAUSAS_RELAJABLES } : {})
                  })
                : baseline;
            const propuestosParcial = resultadoParcial.resultados.filter(r => r.estado === 'PROPUESTO').length;

            // Monotonía: relajar preferencias solo puede AGRANDAR el conjunto
            // de soluciones factibles respecto al nivel estricto — si el
            // nivel permisivo demuestra infactibilidad (no solo límite),
            // automáticamente también es infactible en el nivel estricto, y
            // es la conclusión más fuerte posible: no existe NINGUNA
            // asignación de cobertura total, ni siquiera cediendo preferencias.
            if (!tier1.exito && !tier1.limiteAlcanzado) {
                return {
                    ...resultadoParcial,
                    motor: 'GLOBAL',
                    optimizacion_global: {
                        aplicada: propuestosParcial > (evaluables.length - sinPropuestaBaseline.length),
                        estado_busqueda: ESTADOS_BUSQUEDA.INFACTIBLE_DEMOSTRADO,
                        motivo: 'Búsqueda exhaustiva (incluso cediendo las preferencias flexibles de distancia, repetición de asociación, fin de semana consecutivo y comuna no resoluble): no existe ninguna asignación posible que cubra el 100% de los rodeos evaluables sin violar una restricción obligatoria (disponibilidad, habilitación de categoría, asociación organizadora o conflicto real de fecha). Se conservó la mejor combinación PARCIAL encontrada durante esa misma búsqueda, no solo la solución local original.',
                        total_cupos: totalCupos,
                        cobertura_obtenida: propuestosParcial,
                        cupos_pendientes: totalCupos - propuestosParcial,
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
                        prioridad_deportiva: prioridadDeportivaInfo,
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
                    ...resultadoParcial,
                    motor: 'GLOBAL',
                    optimizacion_global: {
                        aplicada: propuestosParcial > (evaluables.length - sinPropuestaBaseline.length),
                        estado_busqueda: ESTADOS_BUSQUEDA.LIMITE_ALCANZADO,
                        motivo: 'Se alcanzó el límite de búsqueda (nodos o tiempo) antes de poder determinar si existe una asignación con cobertura total, incluso cediendo preferencias flexibles. No se demostró ni la factibilidad ni la imposibilidad — se conservó la mejor combinación PARCIAL encontrada durante la búsqueda, no solo la solución local original.',
                        total_cupos: totalCupos,
                        cobertura_obtenida: propuestosParcial,
                        cupos_pendientes: totalCupos - propuestosParcial,
                        cobertura_parcial_observada: Math.max(tier0.cobertura, tier1.cobertura),
                        limite_busqueda_alcanzado: true,
                        nodos_explorados: tier0.nodosExplorados + tier1.nodosExplorados,
                        tiempo_busqueda_ms: tier0.tiempoMs + tier1.tiempoMs,
                        prioridad_deportiva: prioridadDeportivaInfo,
                        advertencias: []
                    },
                    cobertura_completa: false
                };
            }
        }

        // 5. Cobertura total encontrada (nivel 0 o nivel 1). Objetivo
        //    secundario — Prioridad Deportiva (schema_version=4, sección 2
        //    del pedido: "primero maximizar la cobertura, después optimizar
        //    la prioridad deportiva..."): opera SOBRE la cobertura total ya
        //    probada (busqueda.asignacion) — con cobertura 100% no hay
        //    ningún cupo que "sacrificar"; solo puede cambiar QUIÉN cubre
        //    cada rodeo entre las combinaciones que logran esa misma
        //    cobertura total, nunca reducirla.
        const { asignacion: asignacionGanadora, info: prioridadDeportivaInfo } = aplicarPrioridadDeportivaSiCorresponde(
            contexto, configuracion, rodeosContestados, busqueda.asignacion, busqueda.cobertura,
            relajado ? estaticoPermisivo : estaticoEstricto,
            relajado ? CAUSAS_RELAJABLES : new Set(),
            opciones
        );

        // Se reconstruye el resultado final con el formato enriquecido
        // completo, forzando por rodeo el ganador que dictó la búsqueda
        // (ya con la prioridad deportiva aplicada, si correspondía). Cuando
        // se usó el nivel permisivo, se habilita la whitelist de relajación
        // para el ganador forzado (motorPropuestaDesignacion.js) — nunca
        // se le permite saltar una causa obligatoria, eso es imposible
        // por construcción: la propia búsqueda nunca asignó un jurado con
        // una causa obligatoria pendiente.
        const resultadoFinal = ejecutarSimulacion(contexto, topN, configuracion, {
            forzarGanadorPorRodeo: asignacionGanadora,
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
            prioridad_deportiva: prioridadDeportivaInfo,
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
    // Nota técnica oficial (schema_version=4) — mismo criterio exacto que
    // generarSimulacion() (motorPropuestaDesignacion.js): se carga ANTES de
    // correr el motor (participa del comparador, nunca es enriquecimiento
    // posterior), y solo si el criterio realmente está activo.
    if ((configuracion.ordenCriterios || []).some(o => o.criterio_codigo === 'NOTA_TECNICA')) {
        contexto.notaTecnicaPorJurado = await cargarNotaTecnicaPorJurado(
            contexto.jurados.map(j => j.id),
            opciones.fechaCorteTecnica || new Date().toISOString()
        );
    }
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
    CAUSAS_RELAJABLES, CAUSAS_OBLIGATORIAS, ESTADOS_BUSQUEDA,
    // Mejora "Prioridad Deportiva + Nota Técnica + Repetición por Intervalo"
    // (schema_version=4, Etapa B) — funciones puras nuevas, testeables sin BD.
    calcularPesoPorClasificacion, costoRodeoAsignado, calcularCostoPrioridadDeportiva,
    resolverPrioridadDeportiva, aplicarPrioridadDeportivaSiCorresponde,
    // Corrección Etapa C (sección 4) — desempate por nota técnica en el costo.
    NOTA_TECNICA_MAXIMA, ESCALA_COSTO_CATEGORIA, costoNotaTecnicaCandidato
};
