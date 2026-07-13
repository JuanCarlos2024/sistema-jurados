const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');
const { generarCartillaDelegadoPDF } = require('../../services/cartilla-delegado-pdf');
const { enviarEmail } = require('../../services/emailService');

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
                delegado:usuarios_pagados!cartillas_delegado_delegado_id_fkey(
                    id, nombre_completo, tipo_persona
                )
            `)
            .eq('rodeo_id', req.params.rodeo_id)
            .order('created_at', { ascending: false });

        if (error) return res.status(500).json({ error: error.message });
        res.json(data || []);
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
        res.json(data);
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
                    id, club, asociacion, fecha, tipo_rodeo_nombre
                )
            `)
            .eq('id', req.params.id)
            .single();

        if (error || !cartilla) return res.status(404).json({ error: 'Cartilla no encontrada.' });

        const buffer = await generarCartillaDelegadoPDF(cartilla, cartilla.rodeo || {});

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
