const express = require('express');
const router = express.Router();
const { enviarEmail } = require('../../services/emailService');

// POST /api/admin/notificaciones/test-email
// Envía un email de prueba al destinatario indicado (solo admin pleno)
router.post('/test-email', async (req, res) => {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'Falta el campo "to"' });

    const result = await enviarEmail({
        to,
        subject: 'Test de email — Sistema de Jurados',
        html: `<p>Este es un mensaje de prueba enviado desde el <strong>Sistema de Jurados</strong>.</p>
               <p style="color:#999;font-size:12px;">Si recibió este correo, la configuración de SendGrid está funcionando correctamente.</p>`,
        text: 'Este es un mensaje de prueba enviado desde el Sistema de Jurados.\nSi recibió este correo, la configuración de SendGrid está funcionando correctamente.'
    });

    if (result.ok) {
        res.json({ ok: true, mensaje: `Email enviado a ${to}` });
    } else {
        res.status(500).json({ ok: false, motivo: result.motivo, faltantes: result.faltantes || [] });
    }
});

module.exports = router;
