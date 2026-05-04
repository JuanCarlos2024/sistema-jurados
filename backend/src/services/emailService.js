const sgMail = require('@sendgrid/mail');

// APP_URL se lee a nivel de módulo porque no es un secreto y tiene fallback seguro
const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

async function enviarEmail({ to, subject, html, text }) {
    // Leer en el momento de enviar (no al cargar el módulo) para capturar cambios de entorno
    const apiKey    = process.env.SENDGRID_API_KEY;
    const fromEmail = process.env.SENDGRID_FROM_EMAIL;
    const fromName  = process.env.SENDGRID_FROM_NAME || 'Sistema de Jurados';

    // Log de diagnóstico seguro — muestra presencia, no valores secretos
    console.log('[emailService] Config SendGrid al enviar:');
    console.log('  SENDGRID_API_KEY presente:    ', !!apiKey);
    console.log('  SENDGRID_FROM_EMAIL presente: ', !!fromEmail, fromEmail ? `(${fromEmail})` : '');
    console.log('  SENDGRID_FROM_NAME presente:  ', !!process.env.SENDGRID_FROM_NAME);

    if (!apiKey || !fromEmail) {
        const faltantes = [
            !apiKey    ? 'SENDGRID_API_KEY'    : null,
            !fromEmail ? 'SENDGRID_FROM_EMAIL'  : null
        ].filter(Boolean);
        console.warn('[emailService] Variables faltantes en proceso:', faltantes.join(', '));
        return { ok: false, motivo: 'sin_configuracion', faltantes };
    }

    if (!to) return { ok: false, motivo: 'sin_destinatario', faltantes: [] };

    sgMail.setApiKey(apiKey);

    const msg = {
        to:   Array.isArray(to) ? to : [to],
        from: { email: fromEmail, name: fromName },
        subject,
        html,
        text
    };

    try {
        await sgMail.send(msg);
        console.log(`[emailService] Enviado OK a ${to}`);
        return { ok: true };
    } catch (err) {
        const status = err.response?.status;
        const detail = err.response?.body?.errors?.[0]?.message || err.message;
        console.warn(`[emailService] Error al enviar a ${to} | statusCode:${status ?? 'network'} | msg:${detail}`);
        return { ok: false, motivo: status ? `HTTP ${status}` : err.message, faltantes: [] };
    }
}

async function notificarJuradosCicloAbierto({ ciclo, rodeo, jurados, configuracion }) {
    const usarSilencio   = configuracion?.usar_aceptacion_silencio === true;
    const usarPlazo      = configuracion?.usar_plazo_respuesta     === true;
    const rodeoClub      = rodeo?.club         || 'Rodeo';
    const rodeoAsoc      = rodeo?.asociacion   || '';
    const rodeoFecha     = rodeo?.fecha ? new Date(rodeo.fecha).toLocaleDateString('es-CL') : '';
    const link           = `${APP_URL}/usuario/evaluaciones.html`;

    const resultados = [];

    for (const j of (jurados || [])) {
        if (!j.email) {
            resultados.push({ nombre: j.nombre_completo, ok: false, motivo: 'sin_email', faltantes: [] });
            continue;
        }

        const limiteHtml = (usarPlazo && ciclo.fecha_limite_respuesta)
            ? `<p><strong>Fecha límite de respuesta:</strong> ${new Date(ciclo.fecha_limite_respuesta).toLocaleString('es-CL')}</p>`
            : '';

        const silencioHtml = (usarPlazo && usarSilencio && ciclo.fecha_limite_respuesta)
            ? `<p style="color:#784212;"><em>Si no responde antes del plazo, se entenderá que está de acuerdo con lo indicado por el analista.</em></p>`
            : '';

        const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;border:1px solid #e0e0e0;border-radius:8px;">
  <h2 style="color:#1a5276;margin-top:0;">Nueva evaluación técnica disponible — Ciclo ${ciclo.numero_ciclo}</h2>
  <p>Estimado/a <strong>${j.nombre_completo}</strong>,</p>
  <p>Se ha abierto el <strong>Ciclo ${ciclo.numero_ciclo}</strong> de la evaluación técnica para el siguiente rodeo:</p>
  <ul style="line-height:1.8;">
    <li><strong>Club:</strong> ${rodeoClub}</li>
    ${rodeoAsoc ? `<li><strong>Asociación:</strong> ${rodeoAsoc}</li>` : ''}
    ${rodeoFecha ? `<li><strong>Fecha del rodeo:</strong> ${rodeoFecha}</li>` : ''}
  </ul>
  <p>Debe iniciar sesión en el sistema y responder las situaciones técnicas asignadas.</p>
  ${limiteHtml}
  ${silencioHtml}
  <p style="margin-top:24px;">
    <a href="${link}"
       style="background:#1a5276;color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;display:inline-block;font-size:14px;">
      Ingresar al sistema
    </a>
  </p>
  <hr style="margin-top:32px;border:none;border-top:1px solid #eee;">
  <p style="font-size:11px;color:#999;">Federación Deportiva Nacional de Rodeo Chileno — Sistema de Jurados</p>
</div>`.trim();

        const text = [
            `Nueva evaluación técnica disponible — Ciclo ${ciclo.numero_ciclo}`,
            '',
            `Estimado/a ${j.nombre_completo},`,
            `Se ha abierto el Ciclo ${ciclo.numero_ciclo} para el rodeo ${rodeoClub}.`,
            `Debe ingresar al sistema y responder las situaciones técnicas asignadas.`,
            usarPlazo && ciclo.fecha_limite_respuesta
                ? `Fecha límite: ${new Date(ciclo.fecha_limite_respuesta).toLocaleString('es-CL')}`
                : '',
            usarPlazo && usarSilencio && ciclo.fecha_limite_respuesta
                ? 'Si no responde antes del plazo, se entenderá que acepta lo indicado por el analista.'
                : '',
            '',
            `Link: ${link}`
        ].filter(l => l !== '').join('\n');

        const r = await enviarEmail({
            to:      j.email,
            subject: `Nueva evaluación técnica disponible — Ciclo ${ciclo.numero_ciclo}`,
            html,
            text
        });

        resultados.push({ nombre: j.nombre_completo, email: j.email, ...r });
    }

    return resultados;
}

module.exports = { enviarEmail, notificarJuradosCicloAbierto };
