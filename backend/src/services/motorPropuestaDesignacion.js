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
    construirConfiguracionDefaultV1, validarConfiguracion, configuracionRequiereDistancia
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
// Un código desconocido nunca debería llegar aquí (validarConfiguracion ya
// lo rechaza antes de ejecutar) — se trata como empate (0) por seguridad.
function compararPorCriterio(criterioCodigo, a, b) {
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
// @returns (a, b) => number — comparador listo para Array.prototype.sort().
function construirComparadorJerarquico(ordenCriterios) {
    const criteriosEnOrden = [...(ordenCriterios || [])]
        .sort((a, b) => a.orden - b.orden)
        .map(c => c.criterio_codigo);

    return (a, b) => {
        for (const codigo of criteriosEnOrden) {
            const cmp = compararPorCriterio(codigo, a, b);
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
    const { asociacionesPorJurado, bloquesPorJurado, designacionesPorJurado } = estado;
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

    return {
        jurado, causas, elegible: causas.length === 0,
        distanciaKm, comunaJurado, categoriaOrdenPreferencia, categoriaCompatible,
        disponible, mismaAsoc, repiteAsociacionTemporada, mismoFinde, findeConsecutivo,
        designacionesAntes
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
    // no se consulta desde cargarDatosMotor (retirada en Etapa 3).
    const matrizPorClasificacion = construirMatrizPorClasificacionDesdeConfiguracion(configuracion.matriz);
    const matriz = rodeo.clasificacion_codigo ? matrizPorClasificacion[rodeo.clasificacion_codigo] : null;
    if (!matriz) return { error: 'TIPO_SIN_CLASIFICACION' };

    const comunaJuradoPorId = new Map([[jurado.id, resolverComuna(jurado.comuna, contexto.catalogoComunas)]]);
    const estado = construirEstadoDesdeBD(contexto.asignacionesTemporada);

    return { evaluacion: evaluarCandidato(jurado, rodeo, matriz, contexto.disponibilidad, comunaJuradoPorId, estado, configuracion) };
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
    let asignacionesRaw = [];
    {
        let offset = 0;
        while (true) {
            const { data, error } = await supabase
                .from('asignaciones')
                .select('usuario_pagado_id, rodeo_id, estado, estado_designacion, rodeos!inner(fecha, duracion_dias, asociacion)')
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

    // ── Estado temporal de la corrida (BD + asignaciones temporales unificadas) ──
    // Sembrado desde la BD (asignacionesTemporada, vía construirEstadoDesdeBD
    // — misma reducción que usa evaluarCandidatoDirecto(), nunca duplicada) y
    // mutado a medida que el motor va proponiendo jurados dentro de esta
    // misma simulación. Nunca se escribe en BD — vive solo en memoria.
    const { designacionesPorJurado, bloquesPorJurado, asociacionesPorJurado } = construirEstadoDesdeBD(asignacionesTemporada);

    // Snapshot de designaciones SOLO-BD por jurado (antes de cualquier
    // propuesta de esta corrida) — para el resumen final de distribución
    // ("Jurados utilizados en la simulación").
    const designacionesAntesOriginal = new Map();
    for (const [juradoId, set] of designacionesPorJurado.entries()) designacionesAntesOriginal.set(juradoId, set.size);

    const asignacionesTemporalesLog = [];
    const registrarAsignacionTemporal = (juradoId, rodeo) => {
        if (!designacionesPorJurado.has(juradoId)) designacionesPorJurado.set(juradoId, new Set());
        designacionesPorJurado.get(juradoId).add(rodeo.id);

        if (!bloquesPorJurado.has(juradoId)) bloquesPorJurado.set(juradoId, []);
        bloquesPorJurado.get(juradoId).push(rodeo.bloque);

        if (rodeo.asociacion) {
            if (!asociacionesPorJurado.has(juradoId)) asociacionesPorJurado.set(juradoId, new Set());
            asociacionesPorJurado.get(juradoId).add(normalizarAsociacion(rodeo.asociacion));
        }

        asignacionesTemporalesLog.push({ jurado_id: juradoId, rodeo_id: rodeo.id, fecha: rodeo.fecha, asociacion: rodeo.asociacion });
    };

    // Comuna resuelta de cada jurado, precalculada una sola vez (61 llamadas
    // puras a resolverComuna, no hay N+1 de BD acá — ya está todo en memoria).
    const comunaJuradoPorId = new Map();
    for (const j of jurados) comunaJuradoPorId.set(j.id, resolverComuna(j.comuna, catalogoComunas));

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
    const estadoSoloBD = { asociacionesPorJurado, bloquesPorJurado, designacionesPorJurado };
    for (const rodeo of rodeosEvaluables) {
        const matriz = matrizPorClasificacion[rodeo.clasificacion_codigo];
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
    const estadoActual = { asociacionesPorJurado, bloquesPorJurado, designacionesPorJurado };
    for (const rodeo of rodeosEvaluables) {
        const matriz = matrizPorClasificacion[rodeo.clasificacion_codigo];
        const evaluaciones = jurados.map(j => evaluarCandidato(j, rodeo, matriz, disponibilidad, comunaJuradoPorId, estadoActual, configuracion));

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
            causa_principal: ORDEN_CAUSA_PRINCIPAL.find(c => e.causas.includes(c)) || e.causas[0]
        }));

        const candidatosValidos = evaluaciones.filter(e => e.elegible);

        if (candidatosValidos.length === 0) {
            resultados.push({
                rodeo_id: rodeo.id, estado: 'SIN_PROPUESTA',
                rodeo: { club: rodeo.club, fecha: rodeo.fecha, asociacion: rodeo.asociacion, clasificacion_codigo: rodeo.clasificacion_codigo },
                candidatos_evaluados: evaluaciones.length,
                candidatos_potenciales_bd: rodeo._candidatosPotenciales,
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
        const comparador = construirComparadorJerarquico(configuracion.ordenCriterios);

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
            distancia_km: e.distanciaKm !== null ? Math.round(e.distanciaKm * 10) / 10 : null
        }));

        const ganador = grupo[0];
        registrarAsignacionTemporal(ganador.jurado.id, rodeo);

        resultados.push({
            rodeo_id: rodeo.id, estado: 'PROPUESTO',
            rodeo: { club: rodeo.club, fecha: rodeo.fecha, asociacion: rodeo.asociacion, clasificacion_codigo: rodeo.clasificacion_codigo },
            candidatos_potenciales_bd: rodeo._candidatosPotenciales,
            top_candidatos: topCandidatos,
            jurado_propuesto: {
                jurado_id: ganador.jurado.id,
                nombre: ganador.jurado.nombre_completo,
                categoria: ganador.jurado.categoria,
                categoria_preferente: ganador.categoriaOrdenPreferencia === 1,
                comuna_canonica: ganador.comunaJurado?.nombre || null,
                origen_comuna: ganador.comunaJurado?.origen || null,
                distancia_km: ganador.distanciaKm !== null ? Math.round(ganador.distanciaKm * 10) / 10 : null,
                designaciones_temporada_antes: ganador.designacionesAntes,
                designaciones_temporada_despues: ganador.designacionesAntes + 1,
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
    resultado.temporada = contexto.temporada ? contexto.temporada.nombre : null;
    resultado.modo = 'DRY_RUN';
    resultado.metricas = {
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
    DISTANCIA_MAXIMA_KM, ORDEN_CAUSA_PRINCIPAL, TOP_N_TODOS_LOS_CANDIDATOS
};
