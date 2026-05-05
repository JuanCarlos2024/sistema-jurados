const supabase = require('../config/supabase');

/**
 * Intenta publicar automáticamente una evaluación cuando ambos ciclos están
 * cerrados y no quedan casos pendientes de analista o comisión técnica.
 * Retorna el resultado de la RPC si se publicó, o null si no aplica.
 */
async function intentarAutoPublicar(evaluacion_id, actor_id, actor_nombre, ip) {
    // 1. Estado actual de la evaluación — solo progresa desde estados activos
    const { data: ev } = await supabase
        .from('evaluaciones')
        .select('id, estado')
        .eq('id', evaluacion_id)
        .single();

    if (!ev) return null;
    if (!['en_proceso', 'devuelto', 'pendiente_comision'].includes(ev.estado)) return null;

    // 2. Ambos ciclos deben estar en estado 'cerrado'
    const { data: ciclos } = await supabase
        .from('evaluacion_ciclos')
        .select('numero_ciclo, estado')
        .eq('evaluacion_id', evaluacion_id);

    if (!ciclos || ciclos.length < 2) return null;
    if (!ciclos.every(c => c.estado === 'cerrado')) return null;

    // 3. No debe haber casos pendientes de resolución
    const { count: pendientes } = await supabase
        .from('evaluacion_casos')
        .select('id', { count: 'exact', head: true })
        .eq('evaluacion_id', evaluacion_id)
        .in('estado', ['pendiente_analista', 'derivado_comision']);

    if (pendientes && pendientes > 0) return null;

    const now = new Date().toISOString();

    // 4. Llevar a pendiente_aprobacion (estado requerido por la RPC)
    const { error: transErr } = await supabase
        .from('evaluaciones')
        .update({ estado: 'pendiente_aprobacion', updated_at: now })
        .eq('id', evaluacion_id);

    if (transErr) {
        console.error(`[AUTO-PUBLICAR] Error transición evaluacion_id=${evaluacion_id}:`, transErr.message);
        return null;
    }

    // 5. Llamar RPC publicar_evaluacion (calcula nota, UPSERT notas_rodeo, publica)
    const { data: rpcData, error: rpcErr } = await supabase.rpc('publicar_evaluacion', {
        p_evaluacion_id: evaluacion_id,
        p_jefe_id:       actor_id,
        p_comentario:    'Publicación automática al cierre de ambos ciclos'
    });

    if (rpcErr) {
        // Revertir estado si la RPC falló para no dejar inconsistencia
        await supabase
            .from('evaluaciones')
            .update({ estado: ev.estado, updated_at: now })
            .eq('id', evaluacion_id);
        console.error(`[AUTO-PUBLICAR] Error RPC evaluacion_id=${evaluacion_id}:`, rpcErr.message);
        return null;
    }

    // 6. Auditoría del proceso automático
    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id,
        accion:       'auto_publicacion',
        detalle:      {
            puntaje_final:    rpcData?.puntaje_final,
            nota_final:       rpcData?.nota_final,
            jurados_afectados: rpcData?.jurados_afectados
        },
        actor_id,
        actor_tipo:   'administrador',
        actor_nombre: actor_nombre || 'Sistema',
        ip_address:   ip || null
    });

    return rpcData;
}

module.exports = { intentarAutoPublicar };
