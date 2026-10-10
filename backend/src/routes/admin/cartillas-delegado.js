const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');
const { generarCartillaDelegadoPDF } = require('../../services/cartilla-delegado-pdf');
const { enviarEmail } = require('../../services/emailService');
// Fase 3.5 — mismo servicio ÚNICO de lectura de historial (basado 100% en
// auditoria real, nunca fabricado) que usa institucional/cartilla.js.
const { obtenerHistorialResponsables } = require('../../services/historialResponsableInstitucional');

// ─── GET /api/admin/cartillas-delegado/by-rodeo/:rodeo_id ────────────────────
router.get('/by-rodeo/:rodeo_id', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('cartillas_delegado')
            .select(`
                id, estado, enviada_en, created_at, updated_at,
                temporada, fecha_rodeo, tipo_rodeo, club_asociacion_organizador,
                delegado_nombre, delegado_telefono,
                observada_en, observacion_admin, aprobada_en, reenviada_en,
                delegado_asociacion_id,
                delegado:usuarios_pagados!cartillas_delegado_delegado_id_fkey(
                    id, nombre_completo, tipo_persona
                )
            `)
            .eq('rodeo_id', req.params.rodeo_id)
            .order('created_at', { ascending: false });

        if (error) return res.status(500).json({ error: error.message });
        // Fase 3: distingue el origen de la cartilla (Delegado Rentado vs
        // Delegado de Asociación) — campo puramente informativo, no cambia
        // ningún comportamiento existente de este endpoint.
        const conOrigen = (data || []).map(c => ({ ...c, origen: c.delegado_asociacion_id ? 'delegado_asociacion' : 'delegado_rentado' }));

        // Fase 3.1 (Caso D — cambio de designación posterior): si hay una
        // cartilla institucional Y, además, una designación VIGENTE de
        // Delegado Rentado para el mismo rodeo, es una señal de conflicto que
        // requiere resolución administrativa. Es puramente informativa: NUNCA
        // elimina, bloquea ni transfiere nada por sí sola — solo expone el
        // conflicto para que el administrador decida. Mismo criterio exacto
        // de "designación efectiva" que institucional/cartilla.js.
        const hayInstitucional = conOrigen.some(c => c.origen === 'delegado_asociacion');
        if (hayInstitucional) {
            const { data: designacion } = await supabase
                .from('asignaciones')
                .select('id')
                .eq('rodeo_id', req.params.rodeo_id)
                .eq('tipo_persona', 'delegado_rentado')
                .eq('estado', 'activo')
                .eq('publicado', true)
                .neq('estado_designacion', 'rechazado')
                .maybeSingle();
            if (designacion) {
                conOrigen.forEach(c => { if (c.origen === 'delegado_asociacion') c.conflicto_designacion_posterior = true; });
            }
        }

        res.json(conOrigen);
    } catch (err) {
        console.error('[CARTILLAS-DELEGADO by-rodeo]', err.message);
        res.status(500).json({ error: 'Error interno al cargar cartillas del delegado' });
    }
});

// ─── GET /api/admin/cartillas-delegado/:id ───────────────────────────────────
router.get('/:id', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('cartillas_delegado')
            .select(`
                *,
                delegado:usuarios_pagados!cartillas_delegado_delegado_id_fkey(
                    id, nombre_completo, telefono, email, tipo_persona
                ),
                rodeo:rodeos!cartillas_delegado_rodeo_id_fkey(
                    id, club, asociacion, fecha, tipo_rodeo_nombre, categoria_rodeo_nombre
                )
            `)
            .eq('id', req.params.id)
            .single();

        if (error || !data) return res.status(404).json({ error: 'Cartilla no encontrada' });

        // Fase 3.5 — "Historial de Responsables": solo tiene sentido para
        // cartillas de origen institucional (las de Delegado Rentado no usan
        // rodeos_delegado_institucional). Nunca fabrica eventos: si no hay
        // designación asociada, el servicio devuelve [] directamente.
        let historialResponsables = [];
        if (data.delegado_asociacion_id) {
            const { data: designacion } = await supabase
                .from('rodeos_delegado_institucional')
                .select('id')
                .eq('rodeo_id', data.rodeo_id)
                .maybeSingle();
            historialResponsables = await obtenerHistorialResponsables(supabase, {
                designacionId: designacion?.id || null,
                cartillaId: data.id
            });
        }

        // Fase 3: mismo campo informativo que GET /by-rodeo/:rodeo_id.
        res.json({
            ...data,
            origen: data.delegado_asociacion_id ? 'delegado_asociacion' : 'delegado_rentado',
            historial_responsables: historialResponsables
        });
    } catch (err) {
        console.error('[CARTILLAS-DELEGADO detalle]', err.message);
        res.status(500).json({ error: 'Error interno al cargar cartilla del delegado' });
    }
});

// ─── POST /api/admin/cartillas-delegado/:id/observar ────────────────────────
// Marca la cartilla como observada (requiere motivo). Válido desde: enviada, reenviada.
router.post('/:id/observar', async (req, res) => {
    const { motivo } = req.body || {};
    if (!motivo || String(motivo).trim() === '') {
        return res.status(422).json({ error: 'El motivo de observación es obligatorio.' });
    }

    try {
        const { data: cartilla, error: errGet } = await supabase
            .from('cartillas_delegado')
            .select('id, estado, historial_observaciones')
            .eq('id', req.params.id)
            .single();

        if (errGet || !cartilla) return res.status(404).json({ error: 'Cartilla no encontrada.' });
        if (!['enviada', 'reenviada'].includes(cartilla.estado)) {
            return res.status(409).json({ error: `No se puede observar una cartilla en estado "${cartilla.estado}".` });
        }

        const ahora = new Date().toISOString();
        const adminNombre = req.usuario?.nombre_completo || req.usuario?.nombre || req.usuario?.email || req.usuario?.id || 'Administrador';

        const historial = Array.isArray(cartilla.historial_observaciones) ? [...cartilla.historial_observaciones] : [];
        historial.push({ tipo: 'observacion', fecha: ahora, por: adminNombre, motivo: String(motivo).trim() });

        const { data, error } = await supabase
            .from('cartillas_delegado')
            .update({
                estado:                    'observada',
                observada_en:              ahora,
                observado_por:             adminNombre,
                observacion_admin:         String(motivo).trim(),
                historial_observaciones:   historial,
                updated_at:                ahora
            })
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) return res.status(500).json({ error: error.message });
        res.json({ mensaje: 'Cartilla marcada como observada.', cartilla: data });
    } catch (err) {
        console.error('[CARTILLAS-DELEGADO observar]', err.message);
        res.status(500).json({ error: 'Error interno.' });
    }
});

// ─── POST /api/admin/cartillas-delegado/:id/aprobar ─────────────────────────
// Aprueba la cartilla. Válido desde: enviada, reenviada.
router.post('/:id/aprobar', async (req, res) => {
    try {
        const { data: cartilla, error: errGet } = await supabase
            .from('cartillas_delegado')
            .select('id, estado, historial_observaciones')
            .eq('id', req.params.id)
            .single();

        if (errGet || !cartilla) return res.status(404).json({ error: 'Cartilla no encontrada.' });
        if (!['enviada', 'reenviada', 'observada'].includes(cartilla.estado)) {
            return res.status(409).json({ error: `No se puede aprobar una cartilla en estado "${cartilla.estado}".` });
        }

        const ahora = new Date().toISOString();
        const adminNombre = req.usuario?.nombre_completo || req.usuario?.nombre || req.usuario?.email || req.usuario?.id || 'Administrador';

        const historial = Array.isArray(cartilla.historial_observaciones) ? [...cartilla.historial_observaciones] : [];
        historial.push({ tipo: 'aprobacion', fecha: ahora, por: adminNombre });

        const { data, error } = await supabase
            .from('cartillas_delegado')
            .update({
                estado:                  'aprobada',
                aprobada_en:             ahora,
                aprobado_por:            adminNombre,
                historial_observaciones: historial,
                updated_at:              ahora
            })
            .eq('id', req.params.id)
            .select()
            .single();

        if (error) return res.status(500).json({ error: error.message });
        res.json({ mensaje: 'Cartilla aprobada correctamente.', cartilla: data });
    } catch (err) {
        console.error('[CARTILLAS-DELEGADO aprobar]', err.message);
        res.status(500).json({ error: 'Error interno.' });
    }
});

// ─── GET /api/admin/cartillas-delegado/:id/pdf ──────────────────────────────
// Genera y descarga el PDF de la cartilla del delegado.
router.get('/:id/pdf', async (req, res) => {
    try {
        const { data: cartilla, error } = await supabase
            .from('cartillas_delegado')
            .select(`
                *,
                rodeo:rodeos!cartillas_delegado_rodeo_id_fkey(
                    id, club, asociacion, fecha, tipo_rodeo_nombre, categoria_rodeo_nombre,
                    temporada_id, temporadas(nombre)
                )
            `)
            .eq('id', req.params.id)
            .single();

        if (error || !cartilla) return res.status(404).json({ error: 'Cartilla no encontrada.' });

        // Fase 3.5: mismo servicio de historial que el detalle (GET /:id) —
        // solo aplica a cartillas institucionales; para Delegado Rentado
        // queda vacío y el bloque final simplemente no aparece en el PDF.
        let historialResponsables = [];
        if (cartilla.delegado_asociacion_id) {
            const { data: designacion } = await supabase
                .from('rodeos_delegado_institucional')
                .select('id')
                .eq('rodeo_id', cartilla.rodeo_id)
                .maybeSingle();
            historialResponsables = await obtenerHistorialResponsables(supabase, {
                designacionId: designacion?.id || null,
                cartillaId: cartilla.id
            });
        }

        const buffer = await generarCartillaDelegadoPDF(cartilla, cartilla.rodeo || {}, { historialResponsables });

        const nombre = [
            'cartilla-delegado',
            (cartilla.rodeo?.club || 'rodeo').replace(/[^a-zA-Z0-9]/g, '-').slice(0, 30),
            cartilla.fecha_rodeo || 'sin-fecha'
        ].join('_') + '.pdf';

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
        res.setHeader('Content-Length', buffer.length);
        res.end(buffer);
    } catch (err) {
        console.error('[CARTILLAS-DELEGADO pdf]', err.message);
        res.status(500).json({ error: 'Error al generar PDF: ' + err.message });
    }
});

// ─── POST /api/admin/cartillas-delegado/:id/enviar-correo ───────────────────
// Envía un correo al delegado con el contenido indicado.
router.post('/:id/enviar-correo', async (req, res) => {
    const { to, subject, body } = req.body || {};
    if (!to) return res.status(422).json({ error: 'El destinatario (to) es obligatorio.' });
    if (!subject) return res.status(422).json({ error: 'El asunto (subject) es obligatorio.' });

    try {
        const { data: cartilla } = await supabase
            .from('cartillas_delegado')
            .select('id, estado, delegado_nombre, fecha_rodeo, club_asociacion_organizador')
            .eq('id', req.params.id)
            .single();

        const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;border:1px solid #e0e0e0;border-radius:8px;">
<h2 style="color:#1a5276;margin-top:0;">Sistema de Jurados — Cartilla del Delegado</h2>
<p>${(body || '').replace(/\n/g, '<br>')}</p>
<hr style="border:none;border-top:1px solid #eee;margin-top:24px;">
<p style="font-size:11px;color:#999;">Federación Deportiva Nacional de Rodeo Chileno — Sistema de Jurados</p>
</div>`;

        const resultado = await enviarEmail({ to, subject, html, text: body || subject });

        if (!resultado.ok) {
            return res.status(502).json({ error: 'Error al enviar correo: ' + (resultado.motivo || 'desconocido') });
        }

        res.json({ mensaje: 'Correo enviado correctamente.' });
    } catch (err) {
        console.error('[CARTILLAS-DELEGADO enviar-correo]', err.message);
        res.status(500).json({ error: 'Error interno al enviar correo.' });
    }
});

module.exports = router;
