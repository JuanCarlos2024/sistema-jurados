// ─────────────────────────────────────────────────────────────────────────
// Módulo administrativo de Delegados de Asociación (catálogo de identidad en
// `delegados_asociacion`, migraciones 062/064). NO administra las cuentas de
// acceso institucional (`cuentas_institucionales`) — son conceptos distintos:
// esta pantalla gestiona a las PERSONAS seleccionables en el portal, no las
// credenciales de la asociación.
//
// Permisos: SOLO administrador pleno (rol_evaluacion === null), igual
// criterio allowlist que admin/propuesta-designacion.js, admin/temporadas.js
// e admin/informe-gestion.js (soloRolEvaluacion() sin argumentos). Director,
// Analista, Comisión Técnica, Monitor, Jefe de Área y Capacitador quedan
// bloqueados para TODO método (incluido GET) en todo este router — más
// estricto que lo mínimo pedido ("crear, suspender, reactivar o eliminar"),
// pero consistente con el resto de módulos sensibles del proyecto.
//
// Verificación previa a publicación (migración 073, pendiente de
// autorización): Crear/Suspender/Reactivar/Eliminar ya NO hacen la
// escritura principal y su auditoría en dos pasos separados — cada una pasa
// por una RPC que hace ambas cosas en UNA transacción (mismo patrón que
// 070 para el módulo institucional). Si el INSERT en auditoria falla, la
// operación principal tampoco queda aplicada: nunca se reporta éxito de una
// operación sin su registro de auditoría.
//
// Eliminación física (Caso A/B): `cartillas_delegado.delegado_asociacion_id`
// pasó de ON DELETE SET NULL a ON DELETE RESTRICT (migración 073) — ya no es
// posible, ni siquiera por una condición de carrera, que un DELETE pierda la
// identificación del responsable de una cartilla. La RPC
// eliminar_delegado_asociacion_con_auditoria() además chequea referencias en
// cartillas_delegado Y rodeos_delegado_institucional dentro de la MISMA
// transacción, con un lock FOR UPDATE sobre la fila del delegado — cierra la
// ventana de carrera, no solo la documenta (ver cabecera de 073). Si hay
// cualquier referencia, se bloquea el DELETE y se ofrece Suspender.
// ─────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const { soloRolEvaluacion } = require('../../middleware/auth');
const { claveExactaNombre } = require('../../services/delegadosAsociacion');

// Allowlist: solo administrador pleno (rol_evaluacion === null).
router.use(soloRolEvaluacion());

// Cuenta referencias reales a un delegado en las dos únicas tablas que lo
// referencian — nunca se asume, siempre se consulta.
async function contarReferencias(delegadoId) {
    const [{ data: cartillas, error: e1 }, { data: seleccionadas, error: e2 }] = await Promise.all([
        supabase.from('cartillas_delegado').select('id').eq('delegado_asociacion_id', delegadoId),
        supabase.from('rodeos_delegado_institucional').select('id').eq('delegado_asociacion_id', delegadoId)
    ]);
    if (e1) throw new Error(e1.message);
    if (e2) throw new Error(e2.message);
    return { cartillas: (cartillas || []).length, rodeosSeleccionado: (seleccionadas || []).length };
}

// ─── GET / — asociaciones ordinarias del catálogo oficial + conteos ───────
router.get('/', async (req, res) => {
    const buscar = (req.query.buscar || '').toString().trim();

    let query = supabase
        .from('asociaciones')
        .select('id, nombre')
        .eq('activa', true)
        .eq('es_especial', false)
        .order('nombre');
    if (buscar) query = query.ilike('nombre', `%${buscar}%`);

    const { data: asociaciones, error: errAsoc } = await query;
    if (errAsoc) return res.status(500).json({ error: errAsoc.message });

    const { data: delegados, error: errDel } = await supabase
        .from('delegados_asociacion')
        .select('asociacion_id, activo');
    if (errDel) return res.status(500).json({ error: errDel.message });

    const conteos = {};
    for (const d of (delegados || [])) {
        if (!conteos[d.asociacion_id]) conteos[d.asociacion_id] = { activos: 0, suspendidos: 0 };
        if (d.activo) conteos[d.asociacion_id].activos++;
        else conteos[d.asociacion_id].suspendidos++;
    }

    const resultado = (asociaciones || []).map(a => {
        const c = conteos[a.id] || { activos: 0, suspendidos: 0 };
        return {
            asociacion_id: a.id,
            nombre: a.nombre,
            delegados_activos: c.activos,
            delegados_suspendidos: c.suspendidos,
            delegados_total: c.activos + c.suspendidos
        };
    });

    res.json({ asociaciones: resultado });
});

// ─── GET /:asociacionId — nómina completa (activos Y suspendidos) ─────────
router.get('/:asociacionId', async (req, res) => {
    const { data: asociacion, error: errAsoc } = await supabase
        .from('asociaciones')
        .select('id, nombre')
        .eq('id', req.params.asociacionId)
        .maybeSingle();
    if (errAsoc) return res.status(500).json({ error: errAsoc.message });
    if (!asociacion) return res.status(404).json({ error: 'Asociación no encontrada.' });

    const buscar = (req.query.buscar || '').toString().trim();
    let query = supabase
        .from('delegados_asociacion')
        .select('id, nombre, activo, certificado, created_at')
        .eq('asociacion_id', asociacion.id)
        .order('nombre');
    if (buscar) query = query.ilike('nombre', `%${buscar}%`);

    const { data: delegados, error: errDel } = await query;
    if (errDel) return res.status(500).json({ error: errDel.message });

    res.json({
        asociacion: { id: asociacion.id, nombre: asociacion.nombre },
        delegados: (delegados || []).map(d => ({
            id: d.id,
            nombre: d.nombre,
            estado: d.activo ? 'activo' : 'suspendido',
            certificado: d.certificado,
            created_at: d.created_at
        }))
    });
});

// ─── POST / — crear delegado ───────────────────────────────────────────────
router.post('/', async (req, res) => {
    const nombre = (req.body?.nombre || '').toString().trim();
    const asociacionId = req.body?.asociacion_id;
    const certificado = req.body?.certificado === true;

    if (!nombre) return res.status(400).json({ error: 'El nombre completo es obligatorio.' });
    if (!asociacionId) return res.status(400).json({ error: 'La asociación es obligatoria.' });

    const { data: asociacion, error: errAsoc } = await supabase
        .from('asociaciones')
        .select('id, activa, es_especial')
        .eq('id', asociacionId)
        .maybeSingle();
    if (errAsoc) return res.status(500).json({ error: errAsoc.message });
    if (!asociacion || !asociacion.activa || asociacion.es_especial) {
        return res.status(400).json({ error: 'La asociación indicada no es válida para este módulo.' });
    }

    // Mismo criterio de normalización que usa el resto del catálogo (nunca
    // reimplementado): services/delegadosAsociacion.js:claveExactaNombre().
    const nombreNormalizado = claveExactaNombre(nombre);

    const { data: existente, error: errDup } = await supabase
        .from('delegados_asociacion')
        .select('id')
        .eq('asociacion_id', asociacionId)
        .eq('nombre_normalizado', nombreNormalizado)
        .maybeSingle();
    if (errDup) return res.status(500).json({ error: errDup.message });
    if (existente) return res.status(409).json({ error: 'Ya existe un delegado con ese nombre en esta asociación.', code: 'DUPLICADO' });

    // crear_delegado_asociacion_con_auditoria (migración 073): INSERT +
    // auditoría en una sola transacción — si la auditoría falla, el alta
    // tampoco queda aplicada.
    const { data: nuevo, error: errIns } = await supabase
        .rpc('crear_delegado_asociacion_con_auditoria', {
            p_nombre: nombre,
            p_nombre_normalizado: nombreNormalizado,
            p_asociacion_id: asociacionId,
            p_certificado: certificado,
            p_administrador_id: req.usuario.id
        });

    if (errIns) {
        // El mismo UNIQUE (nombre_normalizado, asociacion_id) de la
        // migración 062 sigue aplicando — red de seguridad ante una carrera
        // concurrente, sin alta ni auditoría en ese caso.
        if (errIns.code === '23505') {
            return res.status(409).json({ error: 'Ya existe un delegado con ese nombre en esta asociación.', code: 'DUPLICADO' });
        }
        return res.status(500).json({ error: errIns.message });
    }

    res.status(201).json({
        delegado: { id: nuevo.id, nombre: nuevo.nombre, estado: 'activo', certificado: nuevo.certificado, created_at: nuevo.created_at }
    });
});

// ─── PATCH /:id/suspender ───────────────────────────────────────────────
router.patch('/:id/suspender', async (req, res) => {
    // Informativo únicamente (no es un gate de corrección): nunca reemplaza
    // ni desvincula responsabilidades existentes, solo se muestra como
    // advertencia al administrador. No necesita ser race-free porque no
    // decide si la operación procede — eso ya no depende de este chequeo.
    let referencias = { cartillas: 0, rodeosSeleccionado: 0 };
    try {
        referencias = await contarReferencias(req.params.id);
    } catch (e) { /* si falla, se omite la advertencia, nunca bloquea la suspensión */ }

    const descripcion = `Suspensión de delegado`
        + (referencias.cartillas > 0 || referencias.rodeosSeleccionado > 0
            ? ` (con antecedentes: ${referencias.cartillas} cartilla(s), ${referencias.rodeosSeleccionado} selección(es) de rodeo — no se modificaron)`
            : '');

    // suspender_delegado_asociacion_con_auditoria (migración 073): UPDATE +
    // auditoría en una sola transacción.
    const { data, error } = await supabase.rpc('suspender_delegado_asociacion_con_auditoria', {
        p_delegado_id: req.params.id,
        p_administrador_id: req.usuario.id,
        p_descripcion: descripcion
    });

    if (error) {
        if (error.message?.includes('DELEGADO_NO_ENCONTRADO')) return res.status(404).json({ error: 'Delegado no encontrado.' });
        if (error.message?.includes('DELEGADO_YA_SUSPENDIDO')) return res.status(409).json({ error: 'El delegado ya está suspendido.' });
        return res.status(500).json({ error: error.message });
    }

    res.json({
        ok: true,
        delegado: { id: data.id, nombre: data.nombre, estado: 'suspendido' },
        advertencias: { cartillas_vinculadas: referencias.cartillas, rodeos_con_seleccion: referencias.rodeosSeleccionado }
    });
});

// ─── PATCH /:id/reactivar ───────────────────────────────────────────────
router.patch('/:id/reactivar', async (req, res) => {
    // reactivar_delegado_asociacion_con_auditoria (migración 073): UPDATE +
    // auditoría en una sola transacción. Nunca toca `certificado`.
    const { data, error } = await supabase.rpc('reactivar_delegado_asociacion_con_auditoria', {
        p_delegado_id: req.params.id,
        p_administrador_id: req.usuario.id
    });

    if (error) {
        if (error.message?.includes('DELEGADO_NO_ENCONTRADO')) return res.status(404).json({ error: 'Delegado no encontrado.' });
        if (error.message?.includes('DELEGADO_YA_ACTIVO')) return res.status(409).json({ error: 'El delegado ya está activo.' });
        return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true, delegado: { id: data.id, nombre: data.nombre, estado: 'activo', certificado: data.certificado } });
});

// ─── DELETE /:id — Caso A (sin historial) o Caso B (bloqueado) ───────────
router.delete('/:id', async (req, res) => {
    if (req.body?.confirmar !== true) {
        return res.status(400).json({ error: 'Confirmación requerida para eliminar definitivamente.' });
    }

    // eliminar_delegado_asociacion_con_auditoria (migración 073): toma un
    // lock FOR UPDATE sobre el delegado y chequea referencias en
    // cartillas_delegado/rodeos_delegado_institucional DENTRO de la misma
    // transacción del DELETE — cierra la condición de carrera entre el
    // chequeo y el borrado (antes eran dos llamadas separadas). Reforzada
    // además por el ON DELETE RESTRICT de la FK (antes SET NULL).
    const { data, error } = await supabase.rpc('eliminar_delegado_asociacion_con_auditoria', {
        p_delegado_id: req.params.id,
        p_administrador_id: req.usuario.id
    });

    if (error) {
        if (error.message?.includes('DELEGADO_NO_ENCONTRADO')) return res.status(404).json({ error: 'Delegado no encontrado.' });
        if (error.message?.includes('DELEGADO_TIENE_HISTORIAL') || error.code === '23503') {
            return res.status(409).json({
                error: 'Este delegado tiene antecedentes asociados a rodeos o cartillas. Para conservar el historial, puede suspenderlo, pero no eliminarlo definitivamente.',
                code: 'TIENE_HISTORIAL'
            });
        }
        return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true, eliminado: true, delegado: { id: data.id, nombre: data.nombre } });
});

module.exports = router;
