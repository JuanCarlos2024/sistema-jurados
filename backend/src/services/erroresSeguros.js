// ═════════════════════════════════════════════════════════════════════════
// erroresSeguros.js — respuesta segura para errores INTERNOS del endpoint
// POST /admin/propuesta-designacion/dry-run (incidente 2026-11-25).
//
// Antes, el 500 del dry-run devolvía al navegador el texto completo del
// error ("No se pudo generar la simulación: No se pudieron cargar notas ...:
// TypeError: fetch failed"), y el estado ERROR_TECNICO del motor global
// devolvía en un 200 el mensaje de JavaScript dentro de `motivo`.
//
// Ahora:
//   · el detalle técnico COMPLETO queda solo en los logs del servidor,
//     redactado (tokens, claves, credenciales) y acotado en largo;
//   · el navegador recibe un mensaje funcional + una referencia corta que
//     permite encontrar la entrada del log;
//   · la parte funcional se conserva solo si es un texto propio del sistema
//     ("No se pudo …" / "No se pudieron …", solo letras y espacios), nunca
//     una ruta, tabla, SQL, URL o error de JavaScript.
//
// Alcance acotado a propósito: NO es un manejador de errores general del
// backend (pedido explícito: sin refactorización general).
// ═════════════════════════════════════════════════════════════════════════
const crypto = require('crypto');

const LARGO_MAXIMO_LOG = 2000;

const REDACCIONES = [
    [/\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+){0,2}/g, '[TOKEN REDACTADO]'],
    [/\bBearer\s+\S+/gi, 'Bearer [REDACTADO]'],
    [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, '[CLAVE REDACTADA]'],
    [/\b(apikey|api_key|key|token|access_token|refresh_token|password|contrase(?:n|ñ)a|secret)\s*[=:]\s*[^\s&,;"']+/gi, '$1=[REDACTADO]'],
    [/(postgres(?:ql)?:\/\/)[^\s@]+@/gi, '$1[CREDENCIALES REDACTADAS]@']
];

// Detalle técnico para el LOG del servidor: redactado y acotado.
function redactarDetalleTecnico(texto) {
    let s = String(texto == null ? '' : texto);
    for (const [patron, reemplazo] of REDACCIONES) s = s.replace(patron, reemplazo);
    if (s.length > LARGO_MAXIMO_LOG) s = `${s.slice(0, LARGO_MAXIMO_LOG)}… [${s.length - LARGO_MAXIMO_LOG} caracteres omitidos]`;
    return s;
}

function generarReferenciaError(prefijo = 'DR') {
    return `${prefijo}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

// Primer tramo ("contexto: detalle") solo si es un texto funcional propio.
const TRAMO_FUNCIONAL = /^No se (?:pudo|pudieron) [A-Za-zÁÉÍÓÚÜÑáéíóúüñ ,]{3,150}$/;
function contextoFuncional(mensaje) {
    const tramo = String(mensaje == null ? '' : mensaje).split(': ')[0].trim();
    return TRAMO_FUNCIONAL.test(tramo) ? tramo : null;
}

// Registra el detalle completo (redactado) y devuelve el cuerpo seguro.
// @param etiqueta       prefijo del log, p.ej. '[DRY-RUN]'
// @param mensajeUsuario texto funcional fijo, p.ej. 'No se pudo generar la simulación'
// @param err            error original (Error o string)
// @param logger         inyectable para pruebas (por defecto console)
// @returns { cuerpo: { error, referencia }, referencia }
function construirRespuestaErrorInterno(etiqueta, mensajeUsuario, err, logger = console) {
    const referencia = generarReferenciaError();
    const mensajeOriginal = err && err.message !== undefined ? err.message : err;
    const pila = err && err.stack ? `\n${err.stack.split('\n').slice(1, 6).join('\n')}` : '';
    logger.error(`${etiqueta} ref=${referencia} ${redactarDetalleTecnico(mensajeOriginal)}${redactarDetalleTecnico(pila)}`);
    const contexto = contextoFuncional(mensajeOriginal);
    const error = `${mensajeUsuario}${contexto ? `: ${contexto}` : ''}. Intente nuevamente; si el problema persiste, informe la referencia ${referencia}.`;
    return { cuerpo: { error, referencia }, referencia };
}

module.exports = {
    redactarDetalleTecnico, generarReferenciaError, contextoFuncional, construirRespuestaErrorInterno,
    LARGO_MAXIMO_LOG
};
