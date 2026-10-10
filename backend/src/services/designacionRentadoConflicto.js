// Fase 3.1 (cierre, sección 3): el trigger de base de datos de la migración
// 067 (fn_bloquear_designacion_rentado_si_cartilla_institucional) puede
// abortar un INSERT/UPDATE sobre `asignaciones` con el código
// DESIGNACION_RENTADO_BLOQUEADA_POR_CARTILLA_INSTITUCIONAL cuando el rodeo ya
// tiene una cartilla institucional con contenido real. Como es un trigger de
// base de datos, puede dispararse desde CUALQUIER endpoint que escriba en
// `asignaciones` (crear, reasignar, aceptar/rechazar/reabrir, publicar) — este
// helper traduce ese único error, en un solo lugar, a una respuesta 409 clara
// para el administrador, en vez de dejarlo pasar como un 500 genérico.
const CODIGO = 'DESIGNACION_RENTADO_BLOQUEADA_POR_CARTILLA_INSTITUCIONAL';
const MENSAJE = 'No se puede confirmar esta designación de Delegado Rentado: el rodeo ya tiene una cartilla institucional en curso. Requiere resolución administrativa antes de continuar.';

// Si `error` corresponde a este conflicto, responde 409 y devuelve true.
// Si no, no responde nada y devuelve false (el caller sigue con su manejo normal).
// `mensajePersonalizado` permite que un caller con más contexto (p.ej. la
// publicación masiva, donde conviene aclarar que afecta también a jurados
// del mismo rodeo) use un texto más específico sin duplicar el chequeo.
function responderSiConflictoDesignacionRentado(error, res, mensajePersonalizado) {
    if (!error?.message?.includes(CODIGO)) return false;
    res.status(409).json({ error: mensajePersonalizado || MENSAJE, code: CODIGO });
    return true;
}

module.exports = { responderSiConflictoDesignacionRentado, CODIGO_CONFLICTO_DESIGNACION_RENTADO: CODIGO };
