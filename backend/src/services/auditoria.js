const supabase = require('../config/supabase');

/**
 * Registra una acción en la tabla de auditoría.
 * No lanza errores para no interrumpir el flujo principal (fire-and-forget,
 * igual que siempre). Devuelve true/false según si el registro se guardó
 * realmente — antes no se comprobaba el `error` que devuelve `.insert()`
 * (a diferencia de una excepción, un error de base de datos como una
 * violación de CHECK no lanza: la promesa se resuelve con `{ error }`), así
 * que un fallo real de auditoría quedaba indistinguible de un éxito. Ningún
 * llamador existente lee este valor de retorno, así que no cambia su
 * comportamiento — solo permite que un llamador nuevo evite declarar una
 * operación como auditada cuando en realidad no lo fue.
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
        const { error } = await supabase.from('auditoria').insert({
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
        if (error) {
            console.error('[AUDITORIA ERROR]', error.message);
            return false;
        }
        return true;
    } catch (err) {
        // Solo log, no interrumpir flujo
        console.error('[AUDITORIA ERROR]', err.message);
        return false;
    }
}

module.exports = { registrar };
