const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');

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
    if (decision === 'apelacion_aceptada')  descuento_final = 0;
    else if (decision === 'apelacion_rechazada') descuento_final = descuento_puntos;
    else descuento_final = null; // derivada_comite — se define luego

    const now = new Date().toISOString();
    const { error: updErr } = await supabase
        .from('evaluacion_respuestas_jurado')
        .update({
            decision_analista:    decision,
            comentario_analista:  comentario.trim(),
            decidido_analista_por: req.usuario.id,
            decidido_analista_en:  now,
            descuento_final,
            updated_at: now
        })
        .eq('id', req.params.id);

    if (updErr) return res.status(500).json({ error: updErr.message });
    res.json({ ok: true });
});

// POST /:id/decision-comite
router.post('/:id/decision-comite', async (req, res) => {
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
            decision_comite:    decision,
            comentario_comite:  comentario.trim(),
            decidido_comite_por: req.usuario.id,
            decidido_comite_en:  now,
            descuento_final,
            updated_at: now
        })
        .eq('id', req.params.id);

    if (updErr) return res.status(500).json({ error: updErr.message });
    res.json({ ok: true });
});

module.exports = router;
