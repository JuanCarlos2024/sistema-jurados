const supabase = require('../config/supabase');

/**
 * Migración 103 — genera (idempotente) la revisión de Comisión por
 * resultados alterados del Ciclo 1. La RPC decide si corresponde: solo con
 * la alteración marcada, el Ciclo 1 cerrado y una evaluación aún no
 * aprobada/publicada; nunca duplica. Devuelve el resultado de la RPC, o
 * { error } si falló (p. ej. migración 103 aún no aplicada).
 */
async function generarRevisionResultadoAlterado(evaluacion_id, actor_id, origen) {
    const r = await supabase.rpc('generar_revision_resultado_alterado', {
        p_evaluacion_id: evaluacion_id,
        p_actor_id:      actor_id,
        p_origen:        origen
    });
    const { data, error } = r || { data: null, error: { message: 'respuesta vacía de la RPC' } };
    if (error) {
        console.error(`[COMISION] No se pudo generar la revisión de resultados alterados evaluacion_id=${evaluacion_id}:`, error.message);
        return { error };
    }
    return Array.isArray(data) ? data[0] : data;
}

/** Revisiones de Comisión (Tipo A + Tipo B) aún pendientes de la evaluación. */
async function contarPendientesComision(evaluacion_id) {
    const [{ count: a, error: ea }, { count: b, error: eb }] = await Promise.all([
        supabase.from('evaluacion_revisiones_comision')
            .select('id', { count: 'exact', head: true })
            .eq('evaluacion_id', evaluacion_id)
            .eq('estado', 'pendiente'),
        supabase.from('evaluacion_casos')
            .select('id', { count: 'exact', head: true })
            .eq('evaluacion_id', evaluacion_id)
            .eq('estado', 'derivado_comision')
    ]);
    if (ea || eb) throw new Error((ea || eb).message);
    return (a || 0) + (b || 0);
}

/**
 * Intenta publicar automáticamente una evaluación cuando ambos ciclos están
 * cerrados y no quedan casos pendientes de analista o comisión técnica.
 * Retorna el resultado de la RPC si se publicó, o null si no aplica.
 */
async function intentarAutoPublicar(evaluacion_id, actor_id, actor_nombre, ip) {
    // 0. Migración 103: si hay resultados alterados con el Ciclo 1 cerrado, la
    //    revisión de Comisión debe existir antes de pensar en publicar (cubre
    //    todos los caminos que llegan aquí: cierre de ciclo, decisiones del
    //    analista o de Comisión, anulación de casos, finalizar).
    const gen = await generarRevisionResultadoAlterado(evaluacion_id, actor_id, 'previo_publicacion');
    if (gen?.error) return null;   // ante la duda, nunca se publica

    // 1. Estado actual de la evaluación — solo progresa desde estados activos
    const { data: ev } = await supabase
        .from('evaluaciones')
        .select('id, estado')
        .eq('id', evaluacion_id)
        .single();

    if (!ev) return null;
    // Estado LEÍDO, fijado aquí: la transición y la reversión se condicionan a él.
    const estadoLeido = ev.estado;
    if (!['en_proceso', 'devuelto', 'pendiente_comision'].includes(estadoLeido)) return null;

    // 1b. Revisiones de Comisión pendientes (Tipo A o B) → la nota queda retenida.
    try {
        if (await contarPendientesComision(evaluacion_id) > 0) return null;
    } catch (e) {
        console.error(`[AUTO-PUBLICAR] No se pudo verificar revisiones de Comisión evaluacion_id=${evaluacion_id}:`, e.message);
        return null;
    }

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

    // 4. Llevar a pendiente_aprobacion (estado requerido por la RPC).
    //    CONDICIONAL al estado leído: si otro proceso simultáneo ya la llevó a
    //    pendiente_aprobacion o la publicó, esta llamada no hace nada (nunca
    //    devuelve una evaluación publicada a pendiente_aprobacion → nunca
    //    hay una segunda publicación).
    const { data: transicion, error: transErr } = await supabase
        .from('evaluaciones')
        .update({ estado: 'pendiente_aprobacion', updated_at: now })
        .eq('id', evaluacion_id)
        .eq('estado', estadoLeido)
        .select('id');

    if (transErr) {
        console.error(`[AUTO-PUBLICAR] Error transición evaluacion_id=${evaluacion_id}:`, transErr.message);
        return null;
    }
    if (!transicion || transicion.length === 0) return null;

    // 5. Llamar RPC publicar_evaluacion (calcula nota, UPSERT notas_rodeo, publica)
    const { data: rpcData, error: rpcErr } = await supabase.rpc('publicar_evaluacion', {
        p_evaluacion_id: evaluacion_id,
        p_jefe_id:       actor_id,
        p_comentario:    'Publicación automática al cierre de ambos ciclos'
    });

    if (rpcErr) {
        // Revertir estado si la RPC falló para no dejar inconsistencia —
        // solo si sigue en pendiente_aprobacion (nunca pisa una publicación).
        await supabase
            .from('evaluaciones')
            .update({ estado: estadoLeido, updated_at: now })
            .eq('id', evaluacion_id)
            .eq('estado', 'pendiente_aprobacion');
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

/**
 * Pasos posteriores a una decisión de la Comisión (Tipo A o B), iguales a
 * los que ya hacía la decisión de Comisión sobre casos:
 *   1. Tipo B: si el ciclo del caso ya no tiene casos sin resolver, se cierra.
 *   2. Se intenta la publicación automática habitual (la RPC verifica todo).
 *   3. Si no se publicó y ya no queda nada pendiente para la Comisión, la
 *      evaluación vuelve de 'pendiente_comision' a 'en_proceso'.
 * Devuelve { publicado, evaluacion } para informar al usuario.
 */
async function continuarTrasDecisionComision({ evaluacion_id, ciclo_id = null, actor_id, actor_nombre, ip }) {
    const now = new Date().toISOString();
    let ciclo_cerrado = false;

    if (ciclo_id) {
        const { data: noResueltos } = await supabase
            .from('evaluacion_casos')
            .select('id')
            .eq('ciclo_id', ciclo_id)
            .neq('estado', 'resuelto');
        if (!noResueltos || noResueltos.length === 0) {
            await supabase.from('evaluacion_ciclos')
                .update({ estado: 'cerrado', fecha_cierre: now, updated_at: now })
                .eq('id', ciclo_id)
                .neq('estado', 'cerrado');
            ciclo_cerrado = true;
        }
    }

    const publicado = await intentarAutoPublicar(evaluacion_id, actor_id, actor_nombre, ip);

    if (!publicado) {
        const { data: ev } = await supabase.from('evaluaciones').select('estado').eq('id', evaluacion_id).single();
        if (ev && ev.estado === 'pendiente_comision') {
            let pendientes = 1;
            try { pendientes = await contarPendientesComision(evaluacion_id); } catch (_) { /* conservador: no cambia estado */ }
            if (pendientes === 0) {
                await supabase.from('evaluaciones')
                    .update({ estado: 'en_proceso', updated_at: now })
                    .eq('id', evaluacion_id)
                    .eq('estado', 'pendiente_comision');
            }
        }
    }

    const { data: evaluacion } = await supabase
        .from('evaluaciones')
        .select('id, estado, nota_final, puntaje_final')
        .eq('id', evaluacion_id)
        .single();
    return { publicado: !!publicado, ciclo_cerrado, evaluacion: evaluacion || null };
}

module.exports = { intentarAutoPublicar, generarRevisionResultadoAlterado, contarPendientesComision, continuarTrasDecisionComision };
