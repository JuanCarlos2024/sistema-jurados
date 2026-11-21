// Traduce los errores de las RPC de la migración 103 (revisiones de
// Comisión) a respuestas HTTP con mensajes simples. Nunca expone detalles
// internos de la base de datos.
const ERRORES = [
    // Cierre excepcional del Administrador
    ['REVISION_CERRADA_EXCEPCIONAL',  409, 'Esta revisión fue cerrada por el Administrador mediante cierre excepcional. Ya no admite decisión de la Comisión.'],
    ['CASO_CERRADO_EXCEPCIONAL',      409, 'Este caso fue resuelto por el Administrador mediante cierre excepcional. Ya no admite decisión de la Comisión.'],
    ['ADMIN_NO_AUTORIZADO',           403, 'Solo un Administrador pleno activo puede realizar un cierre excepcional.'],
    ['SIN_PENDIENTES_COMISION',       409, 'Esta evaluación no tiene revisiones de Comisión pendientes: use el cierre normal.'],
    ['DECISIONES_TIPO_B_INCOMPLETAS', 400, 'Debe decidir ERROR o ACIERTO para cada video derivado pendiente.'],
    ['DECISIONES_TIPO_B_INVALIDAS',   400, 'Las decisiones de los videos derivados no son válidas (use ERROR o ACIERTO, una por caso).'],
    ['DECISIONES_DESACTUALIZADAS',    409, 'Las revisiones pendientes cambiaron mientras preparaba el cierre (la Comisión pudo responder). Recargue la pantalla; no se realizó ningún cambio.'],
    ['EVALUACION_NO_APLICA',          409, 'Esta evaluación (anulada o histórica) no admite cierre excepcional.'],
    ['MOTIVO_DEMASIADO_LARGO',        400, 'El motivo no puede superar 2000 caracteres.'],
    ['REVISION_YA_RESUELTA',          409, 'Esta revisión ya fue resuelta. Las decisiones registradas no se pueden cambiar desde aquí.'],
    ['REVISION_ANULADA',              409, 'Esta revisión fue anulada por el analista y ya no requiere decisión.'],
    ['REVISION_NO_ENCONTRADA',        404, 'Revisión no encontrada.'],
    ['CASO_NO_ENCONTRADO',            404, 'Caso no encontrado.'],
    ['CASO_ANULADO',                  409, 'Este caso fue anulado y ya no requiere decisión.'],
    ['CASO_NO_DERIVADO',              409, 'Este caso ya no está pendiente de la Comisión (puede haber sido resuelto por otra persona). Vuelva al listado.'],
    ['EVALUACION_PUBLICADA',          409, 'La nota de este rodeo ya fue publicada; no admite nuevas decisiones.'],
    ['DECISION_INVALIDA',             400, 'Seleccione ERROR o ACIERTO.'],
    ['OBSERVACION_REQUERIDA',         400, 'Escriba una observación que fundamente la decisión.'],
    ['MOTIVO_REQUERIDO',              400, 'El motivo (justificación) es obligatorio.'],
    ['EVALUACION_NO_ENCONTRADA',      404, 'Evaluación no encontrada.'],
    ['ALTERACION_YA_REVISADA',        409, 'La Comisión ya revisó los resultados alterados de este rodeo: el indicador y su comentario no se pueden modificar.'],
    ['REVISION_PENDIENTE_SIN_ANULAR', 409, 'Existe una revisión de Comisión pendiente para los resultados alterados; debe anularse antes de desmarcarlos.'],
    ['CASO_DERIVADO_REQUIERE_COMISION', 409, 'Este caso fue derivado a la Comisión y solo puede resolverse con su decisión.']
];

function mensajeErrorComision(error) {
    const msg = error?.message || '';
    if (error?.code === 'PGRST202' || /could not find the function/i.test(msg)) {
        return { status: 503, code: 'MIGRACION_103_PENDIENTE', mensaje: 'La revisión de Comisión aún no está disponible (falta aplicar la migración 103). No se realizó ningún cambio.' };
    }
    const e = ERRORES.find(([codigo]) => msg.includes(codigo));
    if (e) return { status: e[1], code: e[0], mensaje: e[2] };
    return { status: 500, code: 'ERROR_INTERNO', mensaje: 'No fue posible registrar la decisión. Intente nuevamente.' };
}

module.exports = { mensajeErrorComision };
