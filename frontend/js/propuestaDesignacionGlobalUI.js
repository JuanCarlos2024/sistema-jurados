// ═════════════════════════════════════════════════════════════════════════
// Lógica pura de presentación — Fase 2C, motor global (admin/propuesta-
// designacion.html). Corrección post-producción (2026-10-31), tres casos:
//
// 1. Las advertencias del motor global ({ rodeo_id, club, fecha, jurado_id,
//    preferencias_cedidas }) se mostraban como JSON técnico (JSON.stringify)
//    en el resumen de cobertura — pdgDatosAdvertenciaGlobal() resuelve los
//    datos (incluido el NOMBRE del jurado, que la advertencia solo trae
//    como id) para que la pantalla los presente en español.
// 2. metricas_json.advertencias_aceptadas se escribe también cuando el motor
//    GLOBAL relajó una preferencia por su cuenta (pre-aceptadas para que
//    "Guardar propuesta" en bloque no las re-exija fila por fila), no solo
//    cuando un administrador confirmó manualmente una excepción. Mostrar
//    "excepción MANUAL confirmada" en ambos casos atribuía falsamente al
//    administrador una decisión que el motor tomó por sí solo —
//    pdgEsExcepcionManualConfirmada() solo es verdadero cuando el jurado
//    efectivo es DISTINTO del propuesto originalmente por el motor.
//
// Solo datos: el HTML/escapado final lo sigue armando la pantalla
// (sanitizar, ETIQUETAS_CAUSA, formatFecha ya existentes ahí) — este módulo
// nunca devuelve HTML ni decide ninguna regla de negocio nueva, solo
// reestructura datos ya calculados por el motor/backend.
//
// Funciona cargado por <script src="/js/propuestaDesignacionGlobalUI.js">
// (define globales) o por require() en Node.
// ═════════════════════════════════════════════════════════════════════════

// Caso 1 — resuelve los datos en español de una advertencia del motor
// global. `detalleList` es el detalle de la propuesta/preview ya cargado en
// pantalla (array de filas con rodeo_id) — se usa SOLO para encontrar el
// nombre del jurado de ese rodeo; la advertencia en sí nunca se modifica.
// Devuelve null si `a` no es un objeto de advertencia reconocible.
function pdgDatosAdvertenciaGlobal(a, detalleList) {
    if (!a || typeof a !== 'object') return null;
    const fila = (detalleList || []).find(d => d && d.rodeo_id === a.rodeo_id);
    const nombreJurado = (fila && (fila.nombre_propuesto || (fila.jurado_efectivo && fila.jurado_efectivo.nombre) || fila.nombre_seleccionado)) || null;
    return {
        club: a.club || null,
        fecha: a.fecha || null,
        jurado: nombreJurado,
        preferencias_cedidas: Array.isArray(a.preferencias_cedidas) ? a.preferencias_cedidas : []
    };
}

// Caso 2 — ¿esta fila debe mostrarse como "excepción MANUAL, con
// advertencias confirmadas"? Solo cuando el jurado efectivo
// (jurado_id_seleccionado) es DISTINTO del propuesto originalmente por el
// motor (jurado_id_propuesto) — nunca solo porque existan advertencias
// guardadas en metricas_json.advertencias_aceptadas, ya que esas también
// las pre-acepta el motor GLOBAL automáticamente al relajar una preferencia
// por su cuenta, sin que medie ninguna decisión del administrador.
function pdgEsExcepcionManualConfirmada(detalle) {
    const d = detalle || {};
    const esElPropuestoDelMotor = !!d.jurado_id_propuesto && (!d.jurado_id_seleccionado || d.jurado_id_seleccionado === d.jurado_id_propuesto);
    const advertencias = d.metricas_json && d.metricas_json.advertencias_aceptadas;
    return !esElPropuestoDelMotor && Array.isArray(advertencias) && advertencias.length > 0;
}

const _pdgGlobalUIExports = { pdgDatosAdvertenciaGlobal, pdgEsExcepcionManualConfirmada };
if (typeof module !== 'undefined' && module.exports) { module.exports = _pdgGlobalUIExports; }
