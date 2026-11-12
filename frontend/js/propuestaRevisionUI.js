// ═════════════════════════════════════════════════════════════════════════
// Revisión administrativa de una propuesta (admin/propuesta-designacion.html)
// — lógica PURA de presentación: estado visual de cada fila (pendiente /
// confirmado / modificado / sin jurado), buscador sin acentos, filtros por
// estado y contadores. Nunca decide reglas de negocio: los estados vienen
// del backend; aquí solo se clasifican y filtran para MOSTRAR.
//
// Los filtros solo afectan la visualización — nunca asignaciones ni historial.
// Cargado por <script src="/js/propuestaRevisionUI.js"> (globales) o require().
// ═════════════════════════════════════════════════════════════════════════

// Minúsculas + sin tildes/diacríticos + espacios colapsados.
function prvNormalizar(texto) {
    return String(texto == null ? '' : texto)
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/\s+/g, ' ').trim();
}

// Jurado efectivo mostrado (mismo criterio que obtenerJuradoEfectivo del backend).
function prvJuradoEfectivoId(d) {
    if (!d) return null;
    if (d.estado_revision === 'ACEPTADO' || d.estado_revision === 'MODIFICADO') return d.jurado_id_seleccionado || null;
    if (d.estado_revision === 'PENDIENTE') return d.jurado_id_propuesto || null;
    return null;
}

// Advertencias del MOTOR (relajaciones del optimizador o advertencias
// guardadas junto a una sugerencia aún no revisada) — nunca decisiones admin.
function prvAdvertenciasMotor(d) {
    const relaj = (d && d.explicacion_json && d.explicacion_json.jurado_propuesto && d.explicacion_json.jurado_propuesto.optimizacion_global_relajaciones) || d && d.optimizacion_global_relajaciones || [];
    if (relaj.length > 0) return relaj.slice();
    if (d && d.estado_revision === 'PENDIENTE') {
        return ((d.metricas_json && d.metricas_json.advertencias_aceptadas) || []).map(a => a.tipo).filter(Boolean);
    }
    return [];
}

// Estado VISUAL de revisión de una fila.
//   PENDIENTE   → sugerencia del motor sin revisar (check vacío, neutro)
//   CONFIRMADO  → el administrador aprobó al propuesto (check verde)
//   MODIFICADO  → el administrador sustituyó al jurado (indicador propio)
//   SIN_EVIDENCIA → ACEPTADO/MODIFICADO con el mismo jurado del motor, sin
//                   evidencia de decisión individual (clasificación automática
//                   del guardado, regla anterior al 11/11/2026). El backend lo
//                   informa en d.decision_evidencia; nunca se muestra en verde.
//   SIN_JURADO  → sin jurado efectivo (no se puede confirmar)
//   NO_EVALUABLE
function prvEstadoVisual(d) {
    if (!d) return 'SIN_JURADO';
    if (d.estado_revision === 'NO_EVALUABLE') return 'NO_EVALUABLE';
    if (d.decision_evidencia && d.decision_evidencia.decision === 'CLASIFICACION_AUTOMATICA') return 'SIN_EVIDENCIA';
    if (d.estado_revision === 'ACEPTADO') return 'CONFIRMADO';
    if (d.estado_revision === 'MODIFICADO') return 'MODIFICADO';
    if (d.estado_revision === 'PENDIENTE' && prvJuradoEfectivoId(d)) return 'PENDIENTE';
    return 'SIN_JURADO';
}

const PRV_FILTROS_ESTADO = {
    todos:        { etiqueta: 'Todos',                   cumple: () => true },
    pendientes:   { etiqueta: 'Pendientes de revisión',  cumple: d => prvEstadoVisual(d) === 'PENDIENTE' },
    confirmados:  { etiqueta: 'Confirmados',             cumple: d => prvEstadoVisual(d) === 'CONFIRMADO' },
    modificados:  { etiqueta: 'Modificados',             cumple: d => prvEstadoVisual(d) === 'MODIFICADO' },
    sin_evidencia:{ etiqueta: 'Sin confirmación registrada', cumple: d => prvEstadoVisual(d) === 'SIN_EVIDENCIA' },
    aplicados:    { etiqueta: 'Aplicados a Rodeos',      cumple: d => !!(d.aplicacion_real && d.aplicacion_real.aplicada) },
    advertencias: { etiqueta: 'Con advertencias',        cumple: d => prvAdvertenciasMotor(d).length > 0 || ((d.metricas_json && d.metricas_json.advertencias_aceptadas) || []).length > 0 },
    sin_jurado:   { etiqueta: 'Sin jurado',              cumple: d => ['SIN_JURADO', 'NO_EVALUABLE'].includes(prvEstadoVisual(d)) },
};

// Texto donde busca el buscador: club, asociación, tipo, clasificación,
// jurado propuesto originalmente y jurado actualmente seleccionado.
function prvTextoBuscable(d) {
    const r = (d && d.rodeo) || {};
    return prvNormalizar([
        r.club, r.asociacion, r.tipo_rodeo_nombre, r.clasificacion_nombre,
        d && d.nombre_propuesto, d && d.nombre_seleccionado,
        d && d.jurado_efectivo && d.jurado_efectivo.nombre,
    ].filter(Boolean).join(' | '));
}

function prvCoincideTexto(d, texto) {
    const q = prvNormalizar(texto);
    if (!q) return true;
    const hay = prvTextoBuscable(d);
    return q.split(' ').every(palabra => hay.includes(palabra));
}

// Filtra conservando SIEMPRE el orden recibido (el orden estable). Las filas
// en `idsFijados` (editadas recién y que dejaron de cumplir el filtro) se
// mantienen visibles, marcadas, para no perder la referencia de trabajo.
// @returns { visibles: [{ fila, fijada }], total }
function prvFiltrar(detalle, filtro, idsFijados) {
    const f = filtro || {};
    const criterio = (PRV_FILTROS_ESTADO[f.estado] || PRV_FILTROS_ESTADO.todos).cumple;
    const fijados = idsFijados || new Set();
    const visibles = [];
    (detalle || []).forEach(d => {
        const cumple = prvCoincideTexto(d, f.texto) && criterio(d);
        if (cumple) visibles.push({ fila: d, fijada: false });
        else if (fijados.has(d.id)) visibles.push({ fila: d, fijada: true });
    });
    return { visibles, total: (detalle || []).length };
}

// Contadores independientes (cobertura ≠ aprobación administrativa).
function prvContadores(detalle) {
    const filas = detalle || [];
    const cuenta = est => filas.filter(d => prvEstadoVisual(d) === est).length;
    const sinJurado = filas.filter(d => ['SIN_JURADO', 'NO_EVALUABLE'].includes(prvEstadoVisual(d))).length;
    return {
        total: filas.length,
        cubiertos: filas.length - sinJurado,
        pendientes: cuenta('PENDIENTE'),
        confirmados: cuenta('CONFIRMADO'),
        modificados: cuenta('MODIFICADO'),
        sin_evidencia: cuenta('SIN_EVIDENCIA'),
        aplicados: filas.filter(PRV_FILTROS_ESTADO.aplicados.cumple).length,
        sin_jurado: sinJurado,
        con_advertencias: filas.filter(PRV_FILTROS_ESTADO.advertencias.cumple).length,
    };
}

const _prvExports = {
    prvNormalizar, prvJuradoEfectivoId, prvAdvertenciasMotor, prvEstadoVisual, prvTextoBuscable,
    prvCoincideTexto, prvFiltrar, prvContadores, PRV_FILTROS_ESTADO,
};
if (typeof module !== 'undefined' && module.exports) { module.exports = _prvExports; }
