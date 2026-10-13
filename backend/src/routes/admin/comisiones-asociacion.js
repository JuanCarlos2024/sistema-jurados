// ─────────────────────────────────────────────────────────────────────────
// Administración de Comisiones de Asociación (migración 079): supervisión
// de evaluadores y evaluaciones individuales, y resolución de los casos
// "requiere revisión administrativa" (cambio de nómina después de publicada
// la Nota Comisión — ver fn_detectar_cambio_designacion_post_evaluacion).
//
// Permisos: SOLO administrador pleno (rol_evaluacion === null) — mismo
// criterio allowlist que admin/cuentas-institucionales.js y
// admin/delegados-asociacion.js. La creación/suspensión de CUENTAS de
// Comisión vive en admin/cuentas-institucionales.js (ya parametrizada por
// rol_institucional) — este archivo es exclusivamente evaluadores +
// evaluaciones + resolución de revisión administrativa.
// ─────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const { soloRolEvaluacion } = require('../../middleware/auth');

router.use(soloRolEvaluacion());

// ─── GET /asociaciones — catálogo + estado de su cuenta de Comisión ──────
// Mismo criterio que admin/delegados-asociacion.js (join directo con
// cuentas_institucionales), pero filtrado a rol_institucional='comision_asociacion'
// — nunca mezcla con el estado de la cuenta de Delegado de esa misma asociación.
router.get('/asociaciones', async (req, res) => {
    const [{ data: asociaciones, error: errAsoc }, { data: cuentas, error: errCuentas }] = await Promise.all([
        supabase.from('asociaciones').select('id, nombre, zona, activa, es_especial').order('nombre'),
        supabase.from('cuentas_institucionales')
            .select('id, asociacion_id, email, activo, primer_login, ultimo_acceso_en')
            .eq('rol_institucional', 'comision_asociacion')
    ]);
    if (errAsoc) return res.status(500).json({ error: errAsoc.message });
    if (errCuentas) return res.status(500).json({ error: errCuentas.message });

    const cuentaPorAsociacion = new Map((cuentas || []).map(c => [c.asociacion_id, c]));
    res.json({
        asociaciones: (asociaciones || []).map(a => ({
            id: a.id, nombre: a.nombre, zona: a.zona, activa: a.activa, es_especial: a.es_especial,
            cuenta_comision: cuentaPorAsociacion.get(a.id)
                ? { id: cuentaPorAsociacion.get(a.id).id, email: cuentaPorAsociacion.get(a.id).email, activo: cuentaPorAsociacion.get(a.id).activo, primer_login: cuentaPorAsociacion.get(a.id).primer_login, ultimo_acceso_en: cuentaPorAsociacion.get(a.id).ultimo_acceso_en }
                : null
        }))
    });
});

// ─── GET /evaluadores — supervisión por asociación (opcional) ────────────
router.get('/evaluadores', async (req, res) => {
    let query = supabase
        .from('evaluadores_comision')
        .select('id, asociacion_id, nombre, apellidos, rut, telefono, email, activo, created_at, asociaciones(nombre)')
        .order('nombre');
    if (req.query.asociacion_id) query = query.eq('asociacion_id', req.query.asociacion_id);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({
        evaluadores: (data || []).map(e => ({ ...e, asociacion_nombre: e.asociaciones?.nombre || null, asociaciones: undefined }))
    });
});

// ─── PATCH /evaluadores/:id/suspender ─────────────────────────────────────
router.patch('/evaluadores/:id/suspender', async (req, res) => {
    const motivo = (req.body?.motivo || '').toString().trim() || 'Suspensión de evaluador';
    const { data, error } = await supabase.rpc('suspender_evaluador_comision_con_auditoria', {
        p_evaluador_id: req.params.id, p_administrador_id: req.usuario.id, p_motivo: motivo
    });
    if (error) {
        if (error.message?.includes('EVALUADOR_NO_ENCONTRADO')) return res.status(404).json({ error: 'Evaluador no encontrado.' });
        if (error.message?.includes('EVALUADOR_YA_SUSPENDIDO')) return res.status(409).json({ error: 'El evaluador ya está suspendido.' });
        return res.status(500).json({ error: error.message });
    }
    res.json({ ok: true, evaluador: data });
});

// ─── PATCH /evaluadores/:id/reactivar ─────────────────────────────────────
router.patch('/evaluadores/:id/reactivar', async (req, res) => {
    const { data, error } = await supabase.rpc('reactivar_evaluador_comision_con_auditoria', {
        p_evaluador_id: req.params.id, p_administrador_id: req.usuario.id
    });
    if (error) {
        if (error.message?.includes('EVALUADOR_NO_ENCONTRADO')) return res.status(404).json({ error: 'Evaluador no encontrado.' });
        if (error.message?.includes('EVALUADOR_YA_ACTIVO')) return res.status(409).json({ error: 'El evaluador ya está activo.' });
        return res.status(500).json({ error: error.message });
    }
    res.json({ ok: true, evaluador: data });
});

// ─── GET /evaluaciones?rodeo_id= — consulta de evaluaciones individuales ──
router.get('/evaluaciones', async (req, res) => {
    if (!req.query.rodeo_id) return res.status(400).json({ error: 'rodeo_id es requerido.' });
    const { data, error } = await supabase
        .from('comision_evaluaciones_jurado')
        .select(`id, rodeo_id, asignacion_id, nombre_evaluado_snapshot, nota_apinadero, nota_cancha, nota_atajadas,
                 nota_cuarta_carrera, hubo_movimiento_rienda, nota_rienda, nota_individual_calculada,
                 afecto_resultado_final, comentario, estado, enviada_en, evaluadores_comision(nombre, apellidos)`)
        .eq('rodeo_id', req.query.rodeo_id)
        .order('enviada_en');
    if (error) return res.status(500).json({ error: error.message });
    res.json({
        evaluaciones: (data || []).map(e => ({
            ...e,
            evaluador_nombre: e.evaluadores_comision ? `${e.evaluadores_comision.nombre} ${e.evaluadores_comision.apellidos}` : null,
            evaluadores_comision: undefined
        }))
    });
});

// ─── GET /rodeos-requieren-revision — bandeja de resolución administrativa ─
router.get('/rodeos-requieren-revision', async (req, res) => {
    const { data: rodeosNotas, error } = await supabase
        .from('rodeo_notas_secundarias')
        .select('rodeo_id, nota_comision, estado_nota_comision, revision_admin_motivo, revision_admin_detectado_en, rodeos(club, asociacion, fecha)')
        .eq('requiere_revision_admin', true)
        .order('revision_admin_detectado_en', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    res.json({
        rodeos: (rodeosNotas || []).map(r => ({
            rodeo_id: r.rodeo_id,
            club: r.rodeos?.club || null,
            asociacion: r.rodeos?.asociacion || null,
            fecha: r.rodeos?.fecha || null,
            nota_comision_actual: r.nota_comision != null ? Number(r.nota_comision) : null,
            estado_nota_comision: r.estado_nota_comision,
            motivo: r.revision_admin_motivo,
            detectado_en: r.revision_admin_detectado_en
        }))
    });
});

// ─── GET /rodeos/:rodeo_id/revision — detalle para resolver un caso ───────
// Nómina ORIGINAL (snapshot de cada evaluación enviada) vs. nómina ACTUAL
// vigente — para que el administrador compare antes de decidir.
router.get('/rodeos/:rodeo_id/revision', async (req, res) => {
    const [{ data: notas, error: errNotas }, { data: evaluaciones, error: errEval }, { data: vigentes, error: errVig }] = await Promise.all([
        supabase.from('rodeo_notas_secundarias').select('*').eq('rodeo_id', req.params.rodeo_id).maybeSingle(),
        supabase.from('comision_evaluaciones_jurado')
            .select('id, asignacion_id, nombre_evaluado_snapshot, nota_individual_calculada, estado, enviada_en')
            .eq('rodeo_id', req.params.rodeo_id),
        supabase.from('asignaciones')
            .select('id, usuario_pagado_id, nombre_importado, usuarios_pagados(nombre_completo)')
            .eq('rodeo_id', req.params.rodeo_id).eq('tipo_persona', 'jurado').eq('estado', 'activo')
            .eq('publicado', true).neq('estado_designacion', 'rechazado')
    ]);
    if (errNotas) return res.status(500).json({ error: errNotas.message });
    if (errEval) return res.status(500).json({ error: errEval.message });
    if (errVig) return res.status(500).json({ error: errVig.message });

    res.json({
        notas_secundarias: notas || null,
        nomina_original_evaluada: (evaluaciones || []).map(e => ({
            asignacion_id: e.asignacion_id, nombre: e.nombre_evaluado_snapshot,
            nota_individual: Number(e.nota_individual_calculada), estado: e.estado, enviada_en: e.enviada_en
        })),
        nomina_actual_vigente: (vigentes || []).map(v => ({
            asignacion_id: v.id, nombre: v.usuarios_pagados?.nombre_completo || v.nombre_importado || null
        }))
    });
});

// ─── PATCH /evaluaciones/:id/corregir — Hallazgo 10 ────────────────────────
// Único camino para corregir los criterios de una evaluación individual ya
// enviada. Administrador pleno (ya exigido por el router.use de arriba),
// motivo obligatorio, recalcula server-side. Nunca recalcula sola la Nota
// Comisión general — eso es un paso aparte (resolver-revision o el PUT de
// notas-secundarias), nunca automático.
router.patch('/evaluaciones/:id/corregir', async (req, res) => {
    const {
        nota_apinadero, nota_cancha, nota_atajadas, nota_cuarta_carrera,
        hubo_movimiento_rienda, nota_rienda, motivo
    } = req.body || {};
    const motivoReal = (motivo || '').toString().trim();
    if (!motivoReal) return res.status(400).json({ error: 'El motivo es obligatorio.' });

    const notasObligatorias = [nota_apinadero, nota_cancha, nota_atajadas, nota_cuarta_carrera];
    if (notasObligatorias.some(n => n === undefined || n === null || Number(n) < 1 || Number(n) > 7 || !Number.isInteger(Number(n)))) {
        return res.status(400).json({ error: 'Las cuatro notas de criterio son obligatorias y deben ser enteros entre 1 y 7.' });
    }
    if (typeof hubo_movimiento_rienda !== 'boolean') {
        return res.status(400).json({ error: '¿Hubo Movimiento a la Rienda? es obligatorio.' });
    }

    const { data, error } = await supabase.rpc('corregir_evaluacion_individual_comision_con_auditoria', {
        p_evaluacion_id: req.params.id,
        p_nota_apinadero: Number(nota_apinadero),
        p_nota_cancha: Number(nota_cancha),
        p_nota_atajadas: Number(nota_atajadas),
        p_nota_cuarta_carrera: Number(nota_cuarta_carrera),
        p_hubo_movimiento_rienda: hubo_movimiento_rienda,
        p_nota_rienda: hubo_movimiento_rienda ? Number(nota_rienda) : null,
        p_motivo: motivoReal,
        p_administrador_id: req.usuario.id
    });

    if (error) {
        if (error.message?.includes('EVALUACION_NO_ENCONTRADA')) return res.status(404).json({ error: 'Evaluación no encontrada.' });
        if (error.message?.includes('MOTIVO_OBLIGATORIO')) return res.status(400).json({ error: 'El motivo es obligatorio.' });
        if (error.message?.includes('NOTA_RIENDA_REQUERIDA')) return res.status(400).json({ error: 'Debe ingresar la nota del Movimiento a la Rienda.' });
        if (error.message?.includes('NOTA_RIENDA_NO_CORRESPONDE')) return res.status(400).json({ error: 'No corresponde ingresar nota de Rienda si no hubo Movimiento a la Rienda.' });
        return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true, evaluacion: data });
});

// ─── POST /rodeos/:rodeo_id/autorizar-evaluacion — ronda 3, punto 4 ───────
// Autorización administrativa ESPECÍFICA (rodeo+asignación) para destrabar
// un envío sobre un rodeo con Nota Comisión cerrada o en revisión. Decisión
// 4 ya aprobada y definitiva: "mantener" NUNCA reabre el portal — esta es
// la única vía para evaluar a un jurado reemplazante después de eso.
// Admin pleno (ya exigido por el router.use de arriba) — una cuenta de
// Comisión nunca puede llamar esto, ni directamente (REVOKE EXECUTE de la
// RPC) ni por este endpoint (middleware distinto, soloAdmin/soloRolEvaluacion,
// nunca soloCuentaInstitucional).
router.post('/rodeos/:rodeo_id/autorizar-evaluacion', async (req, res) => {
    const motivo = (req.body?.motivo || '').toString().trim();
    const asignacionId = req.body?.asignacion_id;
    if (!asignacionId) return res.status(400).json({ error: 'asignacion_id es requerido.' });
    if (!motivo) return res.status(400).json({ error: 'El motivo es obligatorio.' });

    const { data, error } = await supabase.rpc('autorizar_evaluacion_reemplazante_comision_con_auditoria', {
        p_rodeo_id: req.params.rodeo_id,
        p_asignacion_id: asignacionId,
        p_motivo: motivo,
        p_administrador_id: req.usuario.id
    });

    if (error) {
        if (error.message?.includes('ASIGNACION_NO_ENCONTRADA')) {
            return res.status(404).json({ error: 'La asignación no corresponde a un jurado de este rodeo.' });
        }
        if (error.message?.includes('MOTIVO_OBLIGATORIO')) return res.status(400).json({ error: 'El motivo es obligatorio.' });
        return res.status(500).json({ error: error.message });
    }

    res.status(201).json({ ok: true, autorizacion_id: data });
});

// ─── POST /rodeos/:rodeo_id/resolver-revision ─────────────────────────────
router.post('/rodeos/:rodeo_id/resolver-revision', async (req, res) => {
    const decision = (req.body?.decision || '').toString();
    const motivo = (req.body?.motivo || '').toString().trim();
    const notaNueva = req.body?.nota_comision_nueva != null ? Number(req.body.nota_comision_nueva) : null;

    if (!['mantener', 'corregir'].includes(decision)) {
        return res.status(400).json({ error: 'decision debe ser "mantener" o "corregir".' });
    }
    if (!motivo) return res.status(400).json({ error: 'El motivo es obligatorio.' });

    const { data, error } = await supabase.rpc('resolver_revision_admin_comision_con_auditoria', {
        p_rodeo_id: req.params.rodeo_id,
        p_decision: decision,
        p_motivo: motivo,
        p_nota_comision_nueva: notaNueva,
        p_administrador_id: req.usuario.id
    });

    if (error) {
        if (error.message?.includes('NO_REQUIERE_REVISION')) return res.status(409).json({ error: 'Este rodeo no tiene una revisión administrativa pendiente.', code: 'NO_REQUIERE_REVISION' });
        if (error.message?.includes('NOTAS_SECUNDARIAS_NO_ENCONTRADAS') || error.message?.includes('RODEO_NO_ENCONTRADO')) return res.status(404).json({ error: 'Rodeo no encontrado.' });
        if (error.message?.includes('NOTA_FUERA_DE_RANGO')) return res.status(400).json({ error: 'La nueva Nota Comisión debe estar entre 1.0 y 7.0.' });
        if (error.message?.includes('MOTIVO_OBLIGATORIO')) return res.status(400).json({ error: 'El motivo es obligatorio.' });
        return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true, notas_secundarias: data });
});

module.exports = router;
