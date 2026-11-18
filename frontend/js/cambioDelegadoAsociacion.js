// Cambio de Delegado de Asociación (Admin → Rodeos → Informe del Delegado
// Oficial del Rodeo). Funciones PURAS usadas por frontend/admin/rodeos.html:
// visibilidad del botón, validación del formulario, texto de confirmación y
// cuerpo de la solicitud a POST /admin/rodeos/:id/reemplazar-delegado-
// institucional. El backend vuelve a validar todo (permisos, asociación
// real, activo, certificado, estado Borrador, versión y responsable vigente).
(function () {
    // Solo Administrador pleno (rol_evaluacion null), cartilla de Delegado de
    // Asociación (nunca Delegado Rentado), en Borrador y con designación
    // institucional confirmada.
    function cdaPuedeCambiar(c, rolEvaluacion) {
        if (!c || (rolEvaluacion || null) !== null) return false;
        if (!c.delegado_asociacion_id) return false;
        if (c.estado !== 'borrador') return false;
        return !!(c.designacion_institucional && c.designacion_institucional.delegado_asociacion_id);
    }

    // Solo opciones elegibles: el backend ya filtra (misma asociación real,
    // activo, certificado, distinto del vigente); se re-filtra por si acaso.
    function cdaOpcionesElegibles(delegados, actualId) {
        return (Array.isArray(delegados) ? delegados : [])
            .filter(d => d && d.id && d.id !== actualId && d.activo !== false && d.certificado !== false);
    }

    function cdaValidar({ nuevoId, motivo, actualId }) {
        if (!nuevoId) return 'Seleccione el nuevo Delegado Oficial.';
        if (nuevoId === actualId) return 'El nuevo Delegado Oficial debe ser distinto del actual.';
        const m = String(motivo || '').trim();
        if (!m) return 'Indique el motivo del cambio.';
        if (m.length > 1000) return 'El motivo no puede superar los 1000 caracteres.';
        return null;
    }

    function cdaCuerpoSolicitud(opciones, nuevoId, motivo) {
        return {
            nuevo_delegado_asociacion_id: nuevoId,
            motivo: String(motivo || '').trim(),
            delegado_actual_id: opciones?.designacion?.delegado_asociacion_id || null,
            cartilla_version: opciones?.cartilla ? opciones.cartilla.version : null
        };
    }

    // Texto plano (el caller lo sanitiza antes de insertarlo en HTML).
    function cdaTextoConfirmacion({ anterior, nuevo, rodeo }) {
        const r = rodeo || {};
        return `¿Confirma el cambio de Delegado Oficial del rodeo ${r.club || '—'} — ${r.asociacion || '—'} (${r.fecha || '—'})?\n\n` +
            `Delegado anterior: ${anterior || '—'}\nNuevo Delegado Oficial: ${nuevo || '—'}\n\n` +
            'Las respuestas del borrador se conservan y el cambio queda registrado en el historial.';
    }

    const exportar = { cdaPuedeCambiar, cdaOpcionesElegibles, cdaValidar, cdaCuerpoSolicitud, cdaTextoConfirmacion };
    if (typeof window !== 'undefined') Object.assign(window, exportar);
    if (typeof module !== 'undefined' && module.exports) module.exports = exportar;
})();
