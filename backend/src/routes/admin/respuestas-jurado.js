const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const { soloRolEvaluacion } = require('../../middleware/auth');
const { intentarAutoPublicar } = require('../../services/publicacion');

// Intenta resolver un caso en evaluacion_casos basándose en el estado
// de sus evaluacion_respuestas_jurado. Retorna { evaluacion_id } si resolvió, false si no.
async function _intentarResolverCaso(caso_id, now) {
    const { data: respsRechaza } = await supabase
        .from('evaluacion_respuestas_jurado')
        .select('decision_analista, decision_comite, descuento_final')
        .eq('caso_id', caso_id)
        .eq('decision', 'rechaza');

    // Si no hay rechazos, resolver solo si hay al menos una respuesta real
    if (!respsRechaza || respsRechaza.length === 0) {
        const { count } = await supabase
            .from('evaluacion_respuestas_jurado')
            .select('id', { count: 'exact', head: true })
            .eq('caso_id', caso_id)
            .neq('decision', 'sin_respuesta');
        if (!count || count === 0) return false;
        // Solo acepta → sin_descuento
        return await _marcarCasoResuelto(caso_id, 'sin_descuento', now);
    }

    // Verificar que todos los rechazos tienen decisión final
    const hayPendiente = respsRechaza.some(r =>
        !r.decision_analista ||
        (r.decision_analista === 'derivada_comite' && !r.decision_comite)
    );
    if (hayPendiente) return false;

    const { data: caso } = await supabase
        .from('evaluacion_casos')
        .select('tipo_caso, ciclo_id, evaluacion_id, estado')
        .eq('id', caso_id)
        .single();

    if (!caso || caso.estado === 'resuelto') return false;

    const maxDescuento = Math.max(0, ...respsRechaza.map(r => r.descuento_final ?? 0));
    let resolucion_final;
    if (caso.tipo_caso === 'informativo' || maxDescuento === 0) {
        resolucion_final = 'sin_descuento';
    } else {
        resolucion_final = caso.tipo_caso === 'interpretativa'
            ? 'interpretativa_confirmada'
            : 'reglamentaria_confirmada';
    }

    return await _marcarCasoResuelto(caso_id, resolucion_final, now);
}

async function _marcarCasoResuelto(caso_id, resolucion_final, now) {
    const { data: caso } = await supabase
        .from('evaluacion_casos')
        .select('ciclo_id, evaluacion_id, estado')
        .eq('id', caso_id)
        .single();

    if (!caso || caso.estado === 'resuelto') return false;

    await supabase.from('evaluacion_casos').update({
        estado: 'resuelto',
        resolucion_final,
        updated_at: now
    }).eq('id', caso_id);

    // Auto-cerrar ciclo si todos los casos quedaron resueltos
    const { data: noResueltos } = await supabase
        .from('evaluacion_casos')
        .select('id')
        .eq('ciclo_id', caso.ciclo_id)
        .neq('estado', 'resuelto');

    if (!noResueltos || noResueltos.length === 0) {
        await supabase.from('evaluacion_ciclos')
            .update({ estado: 'cerrado', fecha_cierre: now, updated_at: now })
            .eq('id', caso.ciclo_id)
            .neq('estado', 'cerrado');
    }

    return { evaluacion_id: caso.evaluacion_id };
}

// POST /:id/decision-analista
router.post('/:id/decision-analista', async (req, res) => {
    const { decision, comentario } = req.body;

    const DECISIONES_VALIDAS = ['apelacion_aceptada', 'apelacion_rechazada', 'derivada_comite'];
    if (!decision || !DECISIONES_VALIDAS.includes(decision)) {
        return res.status(400).json({ error: 'decision inválida (apelacion_aceptada|apelacion_rechazada|derivada_comite)' });
    }
    if (!comentario || !comentario.trim()) {
        return res.status(400).json({ error: 'comentario es obligatorio' });
    }

    const { data: resp, error: respErr } = await supabase
        .from('evaluacion_respuestas_jurado')
        .select('id, caso_id, decision, decision_analista, descuento_final, evaluacion_casos!caso_id(descuento_puntos)')
        .eq('id', req.params.id)
        .single();

    if (respErr || !resp) return res.status(404).json({ error: 'Respuesta no encontrada' });
    if (resp.decision !== 'rechaza') {
        return res.status(409).json({ error: 'Solo se puede resolver analista en respuestas con decision=rechaza' });
    }
    if (resp.decision_analista && resp.decision_analista !== 'aprobada_auto') {
        return res.status(409).json({ error: `La respuesta ya tiene decision_analista: ${resp.decision_analista}` });
    }

    const descuento_puntos = resp.evaluacion_casos?.descuento_puntos ?? 0;
    let descuento_final;
    if (decision === 'apelacion_aceptada')   descuento_final = 0;
    else if (decision === 'apelacion_rechazada') descuento_final = descuento_puntos;
    else descuento_final = null; // derivada_comite — se define en decisión de comité

    const now = new Date().toISOString();
    const { error: updErr } = await supabase
        .from('evaluacion_respuestas_jurado')
        .update({
            decision_analista:     decision,
            comentario_analista:   comentario.trim(),
            decidido_analista_por: req.usuario.id,
            decidido_analista_en:  now,
            descuento_final,
            updated_at: now
        })
        .eq('id', req.params.id);

    if (updErr) return res.status(500).json({ error: updErr.message });

    // Sincronizar evaluacion_casos.estado
    if (decision === 'derivada_comite') {
        // Marcar caso como derivado a comisión técnica
        await supabase.from('evaluacion_casos')
            .update({ estado: 'derivado_comision', updated_at: now })
            .eq('id', resp.caso_id);

        const { data: caso } = await supabase
            .from('evaluacion_casos')
            .select('evaluacion_id')
            .eq('id', resp.caso_id)
            .single();

        if (caso) {
            const { data: ev } = await supabase
                .from('evaluaciones')
                .select('estado')
                .eq('id', caso.evaluacion_id)
                .single();
            if (ev && !['pendiente_comision', 'pendiente_aprobacion', 'aprobado', 'publicado', 'cerrado'].includes(ev.estado)) {
                await supabase.from('evaluaciones')
                    .update({ estado: 'pendiente_comision', updated_at: now })
                    .eq('id', caso.evaluacion_id);
            }
        }
    } else {
        // Intentar resolver el caso si todas las respuestas tienen decisión final
        const resultado = await _intentarResolverCaso(resp.caso_id, now);
        if (resultado) {
            await intentarAutoPublicar(resultado.evaluacion_id, req.usuario.id, req.usuario.nombre, req.ip);
        }
    }

    res.json({ ok: true });
});

// POST /:id/decision-comite — solo comisión técnica, jefe de área y admin pleno
router.post('/:id/decision-comite', soloRolEvaluacion('comision_tecnica', 'jefe_area'), async (req, res) => {
    const { decision, comentario } = req.body;

    const DECISIONES_VALIDAS = ['confirma_falta', 'acoge_apelacion'];
    if (!decision || !DECISIONES_VALIDAS.includes(decision)) {
        return res.status(400).json({ error: 'decision inválida (confirma_falta|acoge_apelacion)' });
    }
    if (!comentario || !comentario.trim()) {
        return res.status(400).json({ error: 'comentario es obligatorio' });
    }

    const { data: resp, error: respErr } = await supabase
        .from('evaluacion_respuestas_jurado')
        .select('id, caso_id, decision, decision_analista, evaluacion_casos!caso_id(descuento_puntos)')
        .eq('id', req.params.id)
        .single();

    if (respErr || !resp) return res.status(404).json({ error: 'Respuesta no encontrada' });
    if (resp.decision_analista !== 'derivada_comite') {
        return res.status(409).json({ error: 'Solo se puede resolver comité cuando decision_analista=derivada_comite' });
    }

    const descuento_puntos = resp.evaluacion_casos?.descuento_puntos ?? 0;
    const descuento_final  = decision === 'confirma_falta' ? descuento_puntos : 0;

    const now = new Date().toISOString();
    const { error: updErr } = await supabase
        .from('evaluacion_respuestas_jurado')
        .update({
            decision_comite:     decision,
            comentario_comite:   comentario.trim(),
            decidido_comite_por: req.usuario.id,
            decidido_comite_en:  now,
            descuento_final,
            updated_at: now
        })
        .eq('id', req.params.id);

    if (updErr) return res.status(500).json({ error: updErr.message });

    // Sincronizar evaluacion_casos.estado
    const resultado = await _intentarResolverCaso(resp.caso_id, now);
    if (resultado) {
        const autoPublicado = await intentarAutoPublicar(resultado.evaluacion_id, req.usuario.id, req.usuario.nombre, req.ip);

        if (!autoPublicado) {
            // Si la evaluación sigue en pendiente_comision y ya no quedan derivados → volver a en_proceso
            const { data: ev } = await supabase
                .from('evaluaciones')
                .select('estado')
                .eq('id', resultado.evaluacion_id)
                .single();

            if (ev && ev.estado === 'pendiente_comision') {
                const { count: derivadoCount } = await supabase
                    .from('evaluacion_casos')
                    .select('id', { count: 'exact', head: true })
                    .eq('evaluacion_id', resultado.evaluacion_id)
                    .eq('estado', 'derivado_comision');

                if (!derivadoCount || derivadoCount === 0) {
                    await supabase.from('evaluaciones')
                        .update({ estado: 'en_proceso', updated_at: now })
                        .eq('id', resultado.evaluacion_id);
                }
            }
        }
    }

    res.json({ ok: true });
});

module.exports = router;
