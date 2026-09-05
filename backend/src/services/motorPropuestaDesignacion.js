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

const DISTANCIA_MAXIMA_KM = 600;
const PAGINA = 900; // mismo tamaño de página usado en el resto del proyecto (analisis-preguntas.js, jurados-disponibles)

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
function evaluarCandidato(jurado, rodeo, matriz, disponibilidad, comunaJuradoPorId, estado) {
    const { asociacionesPorJurado, bloquesPorJurado, designacionesPorJurado } = estado;
    const causas = [];

    // Regla 0 — disponibilidad para TODAS las fechas del rodeo
    const dispJurado = disponibilidad.get(jurado.id);
    const disponible = !!dispJurado && rodeo.fechas.every(f => dispJurado.has(f));
    if (!disponible) causas.push('DISPONIBILIDAD');

    // Regla 1 — misma asociación (comparación conservadora, sin fuzzy)
    const mismaAsoc = mismaAsociacion(jurado.asociacion, rodeo.asociacion);
    if (mismaAsoc) causas.push('MISMA_ASOCIACION');

    // Regla 2 — no repetir asociación en TODA la temporada (BD [+ temporal si el snapshot lo incluye])
    const asocNorm = normalizarAsociacion(rodeo.asociacion);
    const asociacionesUsadas = asociacionesPorJurado.get(jurado.id);
    const repiteAsociacionTemporada = !!asociacionesUsadas && asociacionesUsadas.has(asocNorm);
    if (repiteAsociacionTemporada) causas.push('ASOCIACION_REPETIDA_TEMPORADA');

    // Regla 3/4 — mismo fin de semana / fin de semana consecutivo
    const bloquesJurado = bloquesPorJurado.get(jurado.id) || [];
    const mismoFinde = bloquesJurado.some(b => bloquesSeSuperponen(b, rodeo.bloque));
    const findeConsecutivo = !mismoFinde && bloquesJurado.some(b => bloquesSonConsecutivos(b, rodeo.bloque));
    if (mismoFinde) causas.push('MISMO_FINDE');
    if (findeConsecutivo) causas.push('FINDE_CONSECUTIVO');

    // Regla 6 — categoría elegible según matriz
    const categoriaCompatible = matriz.elegibles.has(jurado.categoria);
    if (!categoriaCompatible) causas.push('CATEGORIA_INCOMPATIBLE');
    const categoriaPreferente = matriz.preferentes.has(jurado.categoria);

    // Regla 5 — distancia (solo calculable si el jurado resuelve comuna)
    const comunaJurado = comunaJuradoPorId.get(jurado.id);
    let distanciaKm = null;
    if (!comunaJurado || !comunaJurado.resuelto) {
        causas.push('JURADO_SIN_COMUNA_RESOLVIBLE');
    } else {
        distanciaKm = calcularDistanciaKm(
            comunaJurado.latitud, comunaJurado.longitud,
            rodeo.comuna_resuelta.latitud, rodeo.comuna_resuelta.longitud
        );
        if (distanciaKm === null || distanciaKm > DISTANCIA_MAXIMA_KM) causas.push('DISTANCIA_EXCEDIDA');
    }

    const designacionesAntes = designacionesPorJurado.get(jurado.id)?.size || 0;

    return {
        jurado, causas, elegible: causas.length === 0,
        distanciaKm, comunaJurado, categoriaPreferente, categoriaCompatible,
        disponible, mismaAsoc, repiteAsociacionTemporada, mismoFinde, findeConsecutivo,
        designacionesAntes
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

    // 3. Matriz de clasificación (6 clasificaciones + 11 filas de matriz) —
    //    se arma un mapa {codigo: {elegibles:Set, preferentes:Set}}.
    const { data: clasifRows, error: errClasif } = await supabase
        .from('clasificaciones_designacion').select('id, codigo');
    queries++;
    if (errClasif) throw new Error('No se pudo cargar clasificaciones: ' + errClasif.message);

    const { data: matrizRows, error: errMatriz } = await supabase
        .from('clasificacion_categoria_matriz').select('clasificacion_id, categoria, elegible, prioridad');
    queries++;
    if (errMatriz) throw new Error('No se pudo cargar la matriz de categorías: ' + errMatriz.message);

    const codigoPorClasifId = {};
    (clasifRows || []).forEach(c => { codigoPorClasifId[c.id] = c.codigo; });
    const matrizPorCodigo = {};
    (matrizRows || []).forEach(m => {
        const codigo = codigoPorClasifId[m.clasificacion_id];
        if (!codigo || !m.elegible) return;
        if (!matrizPorCodigo[codigo]) matrizPorCodigo[codigo] = { elegibles: new Set(), prioridades: {} };
        matrizPorCodigo[codigo].elegibles.add(m.categoria);
        matrizPorCodigo[codigo].prioridades[m.categoria] = m.prioridad;
    });
    // Derivar "preferentes" = categorías con la prioridad mínima de cada clasificación
    Object.values(matrizPorCodigo).forEach(m => {
        const minPrio = Math.min(...Object.values(m.prioridades));
        m.preferentes = new Set(Object.keys(m.prioridades).filter(cat => m.prioridades[cat] === minPrio));
    });

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
        matrizPorCodigo,
        jurados,
        catalogoComunas,
        disponibilidad,
        asignacionesTemporada,
        _queriesAproximadas: queries
    };
}

// ─────────────────────────────────────────────────────────────────────────
// CAPA 2 — Simulación (función pura: no toca la BD, testeable con fixtures)
// ─────────────────────────────────────────────────────────────────────────
function ejecutarSimulacion(contexto, topN = 5) {
    const { idsSolicitados, temporada, rodeosPorId, matrizPorCodigo, jurados, catalogoComunas, disponibilidad, asignacionesTemporada } = contexto;

    // ── Estado temporal de la corrida (BD + asignaciones temporales unificadas) ──
    // Sembrado desde la BD (asignacionesTemporada) y mutado a medida que el
    // motor va proponiendo jurados dentro de esta misma simulación. Nunca se
    // escribe en BD — vive solo en memoria durante esta función.
    const designacionesPorJurado = new Map();  // jurado_id -> Set(rodeo_id)  (para equidad: COUNT DISTINCT rodeo_id)
    const bloquesPorJurado = new Map();        // jurado_id -> [{inicio,fin}, ...]
    const asociacionesPorJurado = new Map();   // jurado_id -> Set(asociacion_normalizada)

    for (const a of asignacionesTemporada) {
        if (!designacionesPorJurado.has(a.usuario_pagado_id)) designacionesPorJurado.set(a.usuario_pagado_id, new Set());
        designacionesPorJurado.get(a.usuario_pagado_id).add(a.rodeo_id);

        if (!bloquesPorJurado.has(a.usuario_pagado_id)) bloquesPorJurado.set(a.usuario_pagado_id, []);
        bloquesPorJurado.get(a.usuario_pagado_id).push(calcularBloqueRodeo(a.rodeos.fecha, a.rodeos.duracion_dias || 1));

        if (a.rodeos.asociacion) {
            if (!asociacionesPorJurado.has(a.usuario_pagado_id)) asociacionesPorJurado.set(a.usuario_pagado_id, new Set());
            asociacionesPorJurado.get(a.usuario_pagado_id).add(normalizarAsociacion(a.rodeos.asociacion));
        }
    }

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
        if (!rodeo.clasificacion_codigo || !matrizPorCodigo[rodeo.clasificacion_codigo]) {
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
        const matriz = matrizPorCodigo[rodeo.clasificacion_codigo];
        rodeo._candidatosPotenciales = jurados.filter(j =>
            evaluarCandidato(j, rodeo, matriz, disponibilidad, comunaJuradoPorId, estadoSoloBD).elegible
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
        const matriz = matrizPorCodigo[rodeo.clasificacion_codigo];
        const evaluaciones = jurados.map(j => evaluarCandidato(j, rodeo, matriz, disponibilidad, comunaJuradoPorId, estadoActual));

        // ── Resumen de descartes (se cuentan TODAS las causas detectadas —
        //    un candidato puede aportar a más de un contador a la vez) ──
        const descartes = {};
        for (const codigo of ['DISPONIBILIDAD','MISMA_ASOCIACION','ASOCIACION_REPETIDA_TEMPORADA','MISMO_FINDE','FINDE_CONSECUTIVO','CATEGORIA_INCOMPATIBLE','JURADO_SIN_COMUNA_RESOLVIBLE','DISTANCIA_EXCEDIDA']) {
            descartes[codigo] = evaluaciones.filter(e => e.causas.includes(codigo)).length;
        }
        const descartados = evaluaciones.filter(e => !e.elegible).map(e => ({
            jurado_id: e.jurado.id, nombre: e.jurado.nombre_completo,
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

        // ── Prioridad de categoría: preferente primero, si existe alguno ──
        const preferentes = candidatosValidos.filter(e => e.categoriaPreferente);
        const grupo = preferentes.length > 0 ? preferentes : candidatosValidos;
        const usoPreferente = preferentes.length > 0;

        // ── Equidad → menor distancia → usuario_pagado_id ascendente (estable) ──
        grupo.sort((a, b) => {
            if (a.designacionesAntes !== b.designacionesAntes) return a.designacionesAntes - b.designacionesAntes;
            const da = a.distanciaKm ?? Infinity, db = b.distanciaKm ?? Infinity;
            if (da !== db) return da - db;
            return a.jurado.id < b.jurado.id ? -1 : (a.jurado.id > b.jurado.id ? 1 : 0);
        });

        // Top N candidatos finales del grupo usado (preferente u otro elegible),
        // ya en el orden de desempate — para auditoría del dry-run (N=5 por
        // defecto) y, con un N mayor, para la pantalla "Modificar" de una
        // propuesta guardada (Etapa 4), que necesita ver más candidatos sin
        // reimplementar el ranking.
        const topCandidatos = grupo.slice(0, topN).map(e => ({
            jurado_id: e.jurado.id, nombre: e.jurado.nombre_completo, categoria: e.jurado.categoria,
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
                categoria_preferente: usoPreferente,
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
                    dentro_600km: ganador.distanciaKm !== null && ganador.distanciaKm <= DISTANCIA_MAXIMA_KM,
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

async function generarSimulacion(rodeoIdsInput, topN = 5) {
    const inicioMs = Date.now();
    const contexto = await cargarDatosMotor(rodeoIdsInput);
    const finCargaMs = Date.now();
    const resultado = ejecutarSimulacion(contexto, topN);
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
    esAsignacionEfectiva, filtrarRodeosSinJuradoEfectivo,
    bloquesSeSuperponen, bloquesSonConsecutivos,
    DISTANCIA_MAXIMA_KM, ORDEN_CAUSA_PRINCIPAL
};
