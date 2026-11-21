// Portal "REVISIÓN DE CASOS — COMISIÓN" — funciones PURAS (sin DOM) usadas
// por frontend/admin/comision-revision.html. Textos simples, pensados para
// personas con poca experiencia tecnológica.
(function () {
    // ─── YouTube (misma lógica que capacitacion-banco-preguntas.html) ─────
    function youtubeExtraerId(url) {
        if (!url || typeof url !== 'string') return null;
        url = url.trim().split('#')[0];
        if (!/^https?:\/\/(www\.|m\.|music\.)?youtu(be\.com|\.be)/.test(url)) return null;
        const pats = [
            /youtu\.be\/([a-zA-Z0-9_-]{11})/, /[?&]v=([a-zA-Z0-9_-]{11})/, /\/embed\/([a-zA-Z0-9_-]{11})/,
            /\/shorts\/([a-zA-Z0-9_-]{11})/, /\/live\/([a-zA-Z0-9_-]{11})/, /\/v\/([a-zA-Z0-9_-]{11})/
        ];
        for (const p of pats) { const m = url.match(p); if (m) return m[1]; }
        return null;
    }
    function youtubeEmbed(url) {
        const id = youtubeExtraerId(url);
        if (!id) return null;
        let ss = 0;
        const sm = url.match(/[?&]start=(\d+)/);
        if (sm) ss = parseInt(sm[1], 10);
        else {
            const tm = url.match(/[?&]t=([0-9hms]+)/);
            if (tm) {
                const v = tm[1];
                if (/^\d+$/.test(v)) ss = parseInt(v, 10);
                else {
                    const p = v.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
                    if (p) ss = (parseInt(p[1] || 0) * 3600) + (parseInt(p[2] || 0) * 60) + parseInt(p[3] || 0);
                }
            }
        }
        const params = ['playsinline=1', 'rel=0'];
        if (ss > 0) params.push('start=' + ss);
        return 'https://www.youtube-nocookie.com/embed/' + id + '?' + params.join('&');
    }

    // ─── Etiquetas ─────────────────────────────────────────────────────────
    const ETIQUETA_TIPO = { resultado_alterado: 'Resultado alterado', video_derivado: 'Video derivado' };
    const ETIQUETA_ESTADO = { pendiente: 'Pendiente', resuelto: 'Resuelto' };
    const ETIQUETA_DECISION = { error: 'ERROR', acierto: 'ACIERTO' };
    // Quién cerró la revisión (nunca se confunde una decisión administrativa con una de la Comisión).
    const ETIQUETA_RESUELTO_POR = {
        comision: 'Resuelto por Comisión',
        administracion: 'Resuelto por Administración (cierre excepcional)',
        cierre_excepcional: 'Cierre excepcional del Administrador, sin resolución de Comisión'
    };

    function fmtFecha(f) {
        if (!f) return '—';
        const [y, m, d] = String(f).split('T')[0].split('-');
        return d && m && y ? `${d}/${m}/${y}` : '—';
    }
    function fmtFechaHora(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        return isNaN(d) ? '—' : d.toLocaleString('es-CL');
    }

    // "5 revisiones — 2 de 5 completadas"
    function textoIndicador(c) {
        const total = c?.total || 0;
        if (total === 0) return 'Sin revisiones en este período';
        return `${total} ${total === 1 ? 'revisión' : 'revisiones'} — ${c.resueltas} de ${total} ${total === 1 ? 'completada' : 'completadas'}`;
    }

    function textoAdvertenciaAnteriores(n) {
        if (!n) return null;
        return n === 1
            ? 'Hay 1 revisión pendiente de fechas anteriores al período elegido.'
            : `Hay ${n} revisiones pendientes de fechas anteriores al período elegido.`;
    }

    // Explicación sencilla de lo que significa cada botón, según el tipo.
    function explicacionDecision(tipo, decision, descuento) {
        const pts = Number(descuento) || 0;
        if (tipo === 'resultado_alterado') {
            return decision === 'error'
                ? 'Hubo un error del jurado: se confirma que los resultados fueron alterados. (No cambia la nota.)'
                : 'El jurado actuó correctamente: no se confirma la alteración. (No cambia la nota.)';
        }
        if (decision === 'error') {
            return pts > 0
                ? `Hubo un error del jurado: se mantiene el descuento de ${pts} ${pts === 1 ? 'punto' : 'puntos'}.`
                : 'Hubo un error del jurado: se mantiene la situación registrada (sin descuento de puntos).';
        }
        return pts > 0
            ? `El jurado actuó correctamente: el descuento de ${pts} ${pts === 1 ? 'punto' : 'puntos'} NO se aplica.`
            : 'El jurado actuó correctamente.';
    }

    // Texto (plano) del cuadro de confirmación — el caller lo sanitiza.
    function textoConfirmacion(detalle, decision) {
        const e = detalle?.encabezado || {};
        const lineas = [
            '¿Confirma que desea registrar esta decisión?',
            '',
            `Rodeo: ${e.club || '—'} — ${e.asociacion || '—'} (${fmtFecha(e.fecha)})`,
            `Tipo: ${ETIQUETA_TIPO[detalle?.tipo] || '—'}`,
            `Decisión: ${ETIQUETA_DECISION[decision] || '—'}`,
            explicacionDecision(detalle?.tipo, decision, detalle?.video_derivado?.descuento_propuesto)
        ];
        if (detalle?.es_ultima_pendiente) {
            lineas.push('', 'ATENCIÓN: es la última revisión pendiente de este rodeo. Al confirmar, la nota podrá publicarse automáticamente si el análisis ya está terminado.');
        }
        lineas.push('', 'Una vez registrada, la decisión no se puede cambiar desde esta pantalla.');
        return lineas.join('\n');
    }

    function validarDecision(decision, observacion) {
        if (!['error', 'acierto'].includes(decision)) return 'Elija ERROR o ACIERTO.';
        // La observación es opcional (106); solo se limita su largo.
        if (String(observacion || '').trim().length > 2000) return 'La observación no puede superar 2000 caracteres.';
        return null;
    }

    function construirQuery(f) {
        const p = new URLSearchParams();
        if (f.desde) p.set('desde', f.desde);
        if (f.hasta) p.set('hasta', f.hasta);
        if (f.tipo && f.tipo !== 'todos') p.set('tipo', f.tipo);
        p.set('estado', f.estado || 'pendientes');
        if (f.resolucion && f.resolucion !== 'todas') p.set('resolucion', f.resolucion);
        return p.toString();
    }

    const exportar = {
        youtubeExtraerId, youtubeEmbed, ETIQUETA_TIPO, ETIQUETA_ESTADO, ETIQUETA_DECISION, ETIQUETA_RESUELTO_POR,
        fmtFecha, fmtFechaHora, textoIndicador, textoAdvertenciaAnteriores, explicacionDecision,
        textoConfirmacion, validarDecision, construirQuery
    };
    if (typeof window !== 'undefined') window.ComisionRevision = exportar;
    if (typeof module !== 'undefined' && module.exports) module.exports = exportar;
})();
