// ─────────────────────────────────────────────────────────────────────────
// Portal "REVISIÓN DE CASOS — COMISIÓN" (migración 103).
//   GET  /revisiones                     listado + contadores (filtros de solo lectura)
//   GET  /revisiones/:tipo/:id           detalle "Ver caso" (solo lectura)
//   POST /revisiones/:tipo/:id/resolver  decisión ERROR / ACIERTO + observación
// :tipo = resultado_alterado | video_derivado.
//
// Permisos: Comisión Técnica, Jefe de Área y Administrador pleno — los
// mismos que ya podían registrar decisiones de Comisión
// (casos.js /decision-comision). La Comisión resuelve casos: NUNCA publica
// notas directamente; tras su decisión corre la publicación automática
// habitual, que verifica todo dentro de publicar_evaluacion.
// ─────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const { soloRolEvaluacion } = require('../../middleware/auth');
const { listarParaComision, detalleRevision, TIPO_A, TIPO_B } = require('../../services/revisionesComision');
const { continuarTrasDecisionComision } = require('../../services/publicacion');
const { mensajeErrorComision } = require('../../services/erroresComision');

router.use(soloRolEvaluacion('comision_tecnica', 'jefe_area'));

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/revisiones', async (req, res) => {
    const { desde, hasta } = req.query;
    if ((desde && !FECHA_RE.test(desde)) || (hasta && !FECHA_RE.test(hasta))) {
        return res.status(400).json({ error: 'Fecha inválida (use AAAA-MM-DD).' });
    }
    const tipo = [TIPO_A, TIPO_B].includes(req.query.tipo) ? req.query.tipo : 'todos';
    const estado = ['pendientes', 'resueltos', 'todos'].includes(req.query.estado) ? req.query.estado : 'pendientes';
    const resolucion = ['error', 'acierto'].includes(req.query.resolucion) ? req.query.resolucion : 'todas';
    try {
        res.json(await listarParaComision({ desde: desde || null, hasta: hasta || null, tipo, estado, resolucion }));
    } catch (e) {
        res.status(500).json({ error: 'No fue posible cargar las revisiones.' });
    }
});

router.get('/revisiones/:tipo/:id', async (req, res) => {
    try {
        const r = await detalleRevision(req.params.tipo, req.params.id);
        if (r.error) return res.status(r.error.status).json({ error: r.error.mensaje });
        res.json(r.detalle);
    } catch (e) {
        res.status(500).json({ error: 'No fue posible cargar la revisión.' });
    }
});

router.post('/revisiones/:tipo/:id/resolver', async (req, res) => {
    const { tipo, id } = req.params;
    const decision = String(req.body?.decision || '').toLowerCase();
    const observacion = String(req.body?.observacion || '').trim();
    if (![TIPO_A, TIPO_B].includes(tipo)) return res.status(400).json({ error: 'Tipo de revisión inválido.' });
    if (!['error', 'acierto'].includes(decision)) return res.status(400).json({ error: 'Seleccione ERROR o ACIERTO.' });
    if (!observacion) return res.status(400).json({ error: 'Escriba una observación que fundamente la decisión.' });
    if (observacion.length > 2000) return res.status(400).json({ error: 'La observación no puede superar 2000 caracteres.' });

    const rpc = tipo === TIPO_A
        ? supabase.rpc('resolver_revision_resultado_alterado', { p_revision_id: id, p_decision: decision, p_observacion: observacion, p_actor_id: req.usuario.id })
        : supabase.rpc('resolver_caso_derivado_comision', { p_caso_id: id, p_decision: decision, p_observacion: observacion, p_actor_id: req.usuario.id });
    const { data, error } = await rpc;
    if (error) {
        const m = mensajeErrorComision(error);
        return res.status(m.status).json({ error: m.mensaje, code: m.code });
    }
    const r = Array.isArray(data) ? data[0] : data;

    const tras = await continuarTrasDecisionComision({
        evaluacion_id: r.evaluacion_id,
        ciclo_id: tipo === TIPO_B ? r.ciclo_id : null,
        actor_id: req.usuario.id, actor_nombre: req.usuario.nombre, ip: req.ip
    });

    res.json({
        ok: true,
        mensaje: 'Decisión registrada.',
        pendientes_restantes_rodeo: r.pendientes_restantes ?? null,
        nota_publicada: tras.publicado
    });
});

module.exports = router;
