const supabase = require('../config/supabase');

/**
 * Registra una acción en la tabla de auditoría.
 * No lanza errores para no interrumpir el flujo principal.
 */
async function registrar({
    tabla,
    registro_id = null,
    accion,
    datos_anteriores = null,
    datos_nuevos = null,
    actor_id,
    actor_tipo,
    descripcion = null,
    ip_address = null
}) {
    try {
        await supabase.from('auditoria').insert({
            tabla,
            registro_id: registro_id ? String(registro_id) : null,
            accion,
            datos_anteriores,
            datos_nuevos,
            actor_id: String(actor_id),
            actor_tipo,
            descripcion,
            ip_address
        });
    } catch (err) {
        // Solo log, no interrumpir flujo
        console.error('[AUDITORIA ERROR]', err.message);
    }
}

module.exports = { registrar };
