// ═════════════════════════════════════════════════════════════════════════
// Temporadas deportivas — Etapa 1 (infraestructura + administración manual).
//
// PURO — funciones sin acceso a base de datos, testeables directamente con
// Jest. Las rutas (admin/temporadas.js, admin/rodeos.js) hacen el I/O
// (fetch/insert/update en Supabase) y llaman a estas funciones para decidir
// QUÉ hacer, igual que motorPropuestaDesignacion.js/propuestaDesignacion.js
// separan lógica pura de acceso a datos.
//
// IMPORTANTE — esta etapa NO cambia el motor de Propuesta de Designación:
// el motor sigue resolviendo la temporada por rango de fechas
// (temporadas.activa + rodeos.fecha), exactamente igual que hoy. Estas
// funciones solo sirven a la nueva administración manual de
// rodeos.temporada_id.
// ═════════════════════════════════════════════════════════════════════════

// ─── Validación de rango de fechas de una temporada ───────────────────────
// Duplica en JS (para dar un mensaje de error legible) el mismo CHECK que
// impone la migración 049 en base de datos — el backend NUNCA confía solo
// en el frontend, y tampoco solo en el error crudo de Postgres.
function validarRangoFechas(fecha_inicio, fecha_fin) {
    if (!fecha_inicio || !fecha_fin) {
        return { valido: false, error: 'fecha_inicio y fecha_fin son requeridas' };
    }
    if (isNaN(Date.parse(fecha_inicio)) || isNaN(Date.parse(fecha_fin))) {
        return { valido: false, error: 'fecha_inicio o fecha_fin no son fechas válidas' };
    }
    if (!(fecha_fin > fecha_inicio)) {
        return { valido: false, error: 'fecha_fin debe ser posterior a fecha_inicio' };
    }
    return { valido: true };
}

// ─── Detección de solapamiento entre temporadas principales ───────────────
// Dos rangos [a1,a2] y [b1,b2] (fechas DATE, comparables como string
// 'YYYY-MM-DD') se solapan si a1 <= b2 Y b1 <= a2. Rangos contiguos (ej.
// 2026-2027 termina 2027-03-31 y 2027-2028 empieza 2027-04-01) NO se
// consideran solapados — es el diseño intencional pedido por el
// administrador. `excluirId` se usa al editar una temporada existente para
// no compararla consigo misma.
function detectarSolapamiento(candidata, existentes, excluirId = null) {
    for (const t of (existentes || [])) {
        if (excluirId && t.id === excluirId) continue;
        const solapa = candidata.fecha_inicio <= t.fecha_fin && t.fecha_inicio <= candidata.fecha_fin;
        if (solapa) return t;
    }
    return null;
}

// ─── Solo una temporada activa a la vez ────────────────────────────────────
// No desactiva nada automáticamente: si ya existe otra temporada activa,
// rechaza con un mensaje claro para que el administrador decida
// conscientemente (nunca un error SQL crudo del índice único parcial).
function validarActivacion(quiereActivar, temporadaActivaExistente, idPropio = null) {
    if (!quiereActivar) return { permitido: true };
    if (!temporadaActivaExistente || temporadaActivaExistente.id === idPropio) {
        return { permitido: true };
    }
    return {
        permitido: false,
        error: `Ya existe una temporada activa: ${temporadaActivaExistente.nombre}.`
    };
}

// ─── Impedir dejar el sistema con CERO temporadas activas ─────────────────
// El motor actual depende de temporadas.activa=true (ejecutarSimulacion
// aborta con TEMPORADA_NO_RESUELTA si no encuentra ninguna). Mientras eso
// siga así, no se permite apagar la única temporada activa — un cambio
// consciente de "temporada activa" (apagar una y prender otra a la vez)
// queda para una etapa futura explícita, no se improvisa acá.
function validarDesactivacion(activaAntes, activaDespues) {
    if (activaAntes === true && activaDespues === false) {
        return {
            permitido: false,
            error: 'No es posible desactivar la única temporada activa mientras el sistema depende de una temporada activa.'
        };
    }
    return { permitido: true };
}

// ─── ¿La fecha de un rodeo cae fuera del rango de una temporada? ──────────
function estaFueraDeRango(fecha, temporada) {
    if (!temporada) return false;
    return fecha < temporada.fecha_inicio || fecha > temporada.fecha_fin;
}

// ─── Asignación individual de temporada a un rodeo ────────────────────────
// temporada = null representa "Sin temporada" (quitar la asignación), lo
// que siempre está permitido sin advertencia. Nunca modifica rodeo.fecha.
function evaluarAsignacionIndividual(fechaRodeo, temporada, confirmarFueraRango = false) {
    if (!temporada) return { permitido: true, fueraDeRango: false };
    const fuera = estaFueraDeRango(fechaRodeo, temporada);
    if (fuera && !confirmarFueraRango) {
        return {
            permitido: false,
            fueraDeRango: true,
            mensaje: '⚠ La fecha del rodeo está fuera del rango de la temporada seleccionada.'
        };
    }
    return { permitido: true, fueraDeRango: fuera };
}

// ─── Asignación por lote ───────────────────────────────────────────────────
// rodeos: [{id, club, fecha}]. Nunca cambia rodeo.fecha. Si hay rodeos fuera
// de rango y no se confirmó explícitamente, no se aplica nada (todo el lote
// queda pendiente de confirmación) — se informa exactamente cuáles.
function evaluarAsignacionLote(rodeos, temporada, confirmarFueraRango = false) {
    const dentro = [];
    const fuera = [];
    for (const r of (rodeos || [])) {
        if (estaFueraDeRango(r.fecha, temporada)) fuera.push(r);
        else dentro.push(r);
    }
    const requiereConfirmacion = fuera.length > 0 && !confirmarFueraRango;
    return {
        dentro,
        fuera,
        requiereConfirmacion,
        resumen: {
            seleccionados: (rodeos || []).length,
            dentro_rango: dentro.length,
            fuera_rango: fuera.length
        }
    };
}

// ─── Conteos de rodeos por temporada (para Configuración y el panel de
// Rodeos). Una sola pasada en memoria sobre los rodeos ya cargados (1 query
// de columna `temporada_id`) — nunca una consulta por temporada ni por
// rodeo. ─────────────────────────────────────────────────────────────────
function calcularConteosPorTemporada(rodeosActivos, temporadas) {
    const conteo = new Map();
    let sinTemporada = 0;
    for (const r of (rodeosActivos || [])) {
        if (!r.temporada_id) { sinTemporada++; continue; }
        conteo.set(r.temporada_id, (conteo.get(r.temporada_id) || 0) + 1);
    }
    const porTemporada = (temporadas || []).map(t => ({
        temporada_id: t.id,
        nombre: t.nombre,
        count: conteo.get(t.id) || 0
    }));
    return {
        total: (rodeosActivos || []).length,
        sin_temporada: sinTemporada,
        por_temporada: porTemporada
    };
}

// ─── Filtro "Temporada" del listado de Rodeos ─────────────────────────────
// Traduce el query param `temporada` a una intención clara, sin acoplar la
// ruta a los valores mágicos de string. 'todas' (o ausente/vacío) = sin
// filtrar; 'sin_temporada' = temporada_id IS NULL; cualquier otro valor se
// trata como un id de temporada específico.
function resolverFiltroTemporadaRodeos(temporadaParam) {
    if (!temporadaParam || temporadaParam === 'todas') return { tipo: 'todas' };
    if (temporadaParam === 'sin_temporada') return { tipo: 'sin_temporada' };
    return { tipo: 'especifica', valor: temporadaParam };
}

// ─── Registro de auditoría por rodeo afectado (individual o dentro de un
// lote) — mantiene trazabilidad por fila, nunca solo un resumen global. No
// inserta nada: devuelve el objeto listo para auditoria.registrar()
// (individual) o para un INSERT en lote (varios a la vez). ────────────────
function construirAuditoriaAsignacionTemporada(rodeo, temporadaAnteriorId, temporadaNuevaId, actorId) {
    return {
        tabla: 'rodeos',
        registro_id: rodeo.id,
        accion: 'asignar_temporada',
        datos_anteriores: { temporada_id: temporadaAnteriorId },
        datos_nuevos: { temporada_id: temporadaNuevaId },
        actor_id: String(actorId),
        actor_tipo: 'administrador',
        descripcion: `Temporada de rodeo "${rodeo.club || rodeo.id}" (${rodeo.fecha || '—'}) cambiada`
    };
}

// ─── Auditoría de la EXCEPCIÓN al editar fechas de una temporada con
// rodeos ya asociados que quedan fuera del nuevo rango. Nunca se usa para
// cambiar rodeos.temporada_id — esos rodeos no se tocan; solo se documenta
// la decisión administrativa. ──────────────────────────────────────────────
function construirAuditoriaExcepcionFechas(temporada, fechasAnteriores, fechasNuevas, rodeosFuera, actorId) {
    return {
        tabla: 'temporadas',
        registro_id: temporada.id,
        accion: 'editar_fechas_con_rodeos_fuera_de_rango',
        datos_anteriores: fechasAnteriores,
        datos_nuevos: fechasNuevas,
        actor_id: String(actorId),
        actor_tipo: 'administrador',
        descripcion: `Temporada "${temporada.nombre}": ${rodeosFuera.length} rodeo(s) ya asociado(s) quedan fuera del nuevo rango tras confirmación explícita del administrador (rodeo_ids: ${rodeosFuera.map(r => r.id).join(', ')})`
    };
}

module.exports = {
    validarRangoFechas,
    detectarSolapamiento,
    validarActivacion,
    validarDesactivacion,
    estaFueraDeRango,
    evaluarAsignacionIndividual,
    evaluarAsignacionLote,
    calcularConteosPorTemporada,
    resolverFiltroTemporadaRodeos,
    construirAuditoriaAsignacionTemporada,
    construirAuditoriaExcepcionFechas
};
