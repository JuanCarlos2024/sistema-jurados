// CIERRE EXCEPCIONAL — ADMINISTRADOR — funciones PURAS usadas por
// frontend/admin/evaluacion-cierre-excepcional.html. El backend y la base
// vuelven a validar todo (permisos, motivo, una decisión por caso).
(function () {
    // Puede ver/usar la opción: solo Administrador pleno (rol_evaluacion null).
    function puedeCierreExcepcional(rolEvaluacion) {
        return (rolEvaluacion ?? null) === null;
    }

    // Cada video derivado pendiente necesita una decisión EXPRESA (nunca por defecto).
    function validarCierre(datos, decisiones, motivo) {
        const pendB = datos?.pendientes?.video_derivado || [];
        for (const c of pendB) {
            const d = decisiones[c.caso_id];
            if (d !== 'error' && d !== 'acierto') return `Falta decidir ERROR o ACIERTO para el caso ${c.numero_caso} (Ciclo ${c.ciclo}).`;
        }
        if (!String(motivo || '').trim()) return 'La justificación (motivo) es obligatoria.';
        if (String(motivo).trim().length > 2000) return 'La justificación no puede superar 2000 caracteres.';
        if ((datos?.total_pendientes || 0) === 0) return 'No hay revisiones pendientes: use el cierre normal.';
        return null;
    }

    function cuerpoSolicitud(datos, decisiones, motivo, ciclosACerrar) {
        return {
            motivo: String(motivo || '').trim(),
            decisiones: (datos?.pendientes?.video_derivado || []).map(c => ({ caso_id: c.caso_id, decision: decisiones[c.caso_id] })),
            ciclos_a_cerrar: ciclosACerrar,
            confirmado: true
        };
    }

    function descuentoConsiderado(datos, decisiones) {
        return (datos?.pendientes?.video_derivado || [])
            .reduce((s, c) => s + (decisiones[c.caso_id] === 'error' ? (Number(c.descuento_propuesto) || 0) : 0), 0);
    }

    // Texto (plano) de la confirmación final — el caller lo sanitiza.
    function textoConfirmacion(datos, decisiones, ciclosACerrar) {
        const e = datos?.evaluacion || {};
        const pa = datos?.pendientes?.resultado_alterado || [];
        const pb = datos?.pendientes?.video_derivado || [];
        const ciclos = (datos?.ciclos || []).filter(c => ciclosACerrar.includes(c.ciclo_id)).map(c => `Ciclo ${c.numero_ciclo}`);
        const lineas = [
            'CIERRE EXCEPCIONAL — ADMINISTRADOR',
            '',
            `Rodeo: ${e.club || '—'} — ${e.asociacion || '—'}`,
            `Revisiones de Comisión pendientes que se cerrarán: ${pa.length + pb.length}`
        ];
        if (pa.length) lineas.push(`· Resultados alterados: ${pa.length} (se cierran sin resolución de Comisión; no generan descuento)`);
        for (const c of pb) {
            lineas.push(`· Caso ${c.numero_caso} (Ciclo ${c.ciclo}): ${decisiones[c.caso_id] === 'error' ? `ERROR — se mantiene el descuento de ${c.descuento_propuesto}` : 'ACIERTO — el descuento no se aplica'}`);
        }
        lineas.push(`Descuento considerado por estas decisiones: ${descuentoConsiderado(datos, decisiones)} punto(s).`);
        lineas.push(ciclos.length ? `Se cerrará con el procedimiento normal: ${ciclos.join(', ')}.` : 'No se cerrará ningún ciclo ahora.');
        lineas.push('', 'ATENCIÓN: si se cumplen todos los demás requisitos (ambos ciclos cerrados), este procedimiento PUBLICARÁ la nota definitiva del rodeo.');
        lineas.push('Esta acción queda registrada en el historial y no se puede deshacer desde esta pantalla.');
        return lineas.join('\n');
    }

    // Confirmación del reintento ("Completar cierre excepcional").
    function textoConfirmacionCompletar(datos, ciclosACerrar) {
        const e = datos?.evaluacion || {};
        const ciclos = (datos?.ciclos || []).filter(c => ciclosACerrar.includes(c.ciclo_id)).map(c => `Ciclo ${c.numero_ciclo}`);
        return [
            'COMPLETAR CIERRE EXCEPCIONAL',
            '',
            `Rodeo: ${e.club || '—'} — ${e.asociacion || '—'}`,
            'Las decisiones del cierre excepcional ya están registradas y no se repetirán.',
            ciclos.length ? `Se cerrará con el procedimiento normal: ${ciclos.join(', ')}.` : 'No se cerrará ningún ciclo ahora; solo se volverá a intentar la publicación.',
            '',
            'ATENCIÓN: si se cumplen todos los requisitos, se PUBLICARÁ la nota definitiva del rodeo.'
        ].join('\n');
    }

    const exportar = { puedeCierreExcepcional, validarCierre, cuerpoSolicitud, descuentoConsiderado, textoConfirmacion, textoConfirmacionCompletar };
    if (typeof window !== 'undefined') window.CierreExcepcional = exportar;
    if (typeof module !== 'undefined' && module.exports) module.exports = exportar;
})();
