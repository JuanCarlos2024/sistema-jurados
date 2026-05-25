const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');

// GET /api/admin/cartillas-jurado/by-rodeo/:rodeo_id
// Devuelve todas las versiones de cartillas_jurado del rodeo, agrupadas por jurado
router.get('/by-rodeo/:rodeo_id', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('cartillas_jurado')
            .select(`
                id, asignacion_id, version, es_actual, estado,
                enviada_en, created_at, adjunto_id, storage_path_pdf,
                motivo_reapertura, reabierta_por, reabierta_en,
                reemplaza_cartilla_id,
                jurado:usuarios_pagados!cartillas_jurado_usuario_pagado_id_fkey(id, nombre_completo, categoria)
            `)
            .eq('rodeo_id', req.params.rodeo_id)
            .order('usuario_pagado_id')
            .order('version', { ascending: false });

        if (error) return res.status(500).json({ error: error.message });
        res.json(data || []);
    } catch (err) {
        console.error('[CARTILLAS by-rodeo] Error inesperado:', err.message);
        res.status(500).json({ error: 'Error interno al cargar cartillas' });
    }
});

// GET /api/admin/cartillas-jurado/pdf/:id
// URL firmada del PDF de una versión específica
router.get('/pdf/:id', async (req, res) => {
    try {
        const { data: cartilla } = await supabase
            .from('cartillas_jurado')
            .select('storage_path_pdf, estado')
            .eq('id', req.params.id)
            .single();

        if (!cartilla) return res.status(404).json({ error: 'Cartilla no encontrada' });
        if (!cartilla.storage_path_pdf) return res.status(404).json({ error: 'Sin PDF adjunto' });

        const { data, error } = await supabase.storage
            .from('rodeo-adjuntos')
            .createSignedUrl(cartilla.storage_path_pdf, 3600);

        if (error) return res.status(500).json({ error: error.message });
        res.json({ url: data.signedUrl });
    } catch (err) {
        console.error('[CARTILLAS pdf] Error inesperado:', err.message);
        res.status(500).json({ error: 'Error interno al obtener PDF' });
    }
});

// POST /api/admin/cartillas-jurado/:id/reabrir
// Actualiza en la misma fila: estado='reabierta', agrega motivo y metadata.
// No crea fila nueva — evita conflictos de índice parcial.
// Cuando el jurado reenvíe, ESE envío crea la nueva versión (version+1).
router.post('/:id/reabrir', async (req, res) => {
    try {
        const { motivo } = req.body;
        if (!motivo || !motivo.trim()) {
            return res.status(400).json({ error: 'El motivo de reapertura es obligatorio' });
        }

        console.log(`[CARTILLA REABRIR] Inicio — cartilla_id=${req.params.id} actor=${req.usuario.id}`);

        // 1. Leer cartilla actual
        const { data: cartilla, error: errLeer } = await supabase
            .from('cartillas_jurado')
            .select('id, estado, es_actual, version, asignacion_id')
            .eq('id', req.params.id)
            .single();

        if (errLeer || !cartilla) {
            console.warn(`[CARTILLA REABRIR] Cartilla no encontrada: ${req.params.id}`);
            return res.status(404).json({ error: 'Cartilla no encontrada' });
        }
        if (cartilla.estado !== 'enviada') {
            return res.status(409).json({ error: 'Solo se puede reabrir una cartilla en estado "enviada"' });
        }
        if (!cartilla.es_actual) {
            return res.status(409).json({ error: 'Solo se puede reabrir la versión actual de la cartilla' });
        }

        console.log(`[CARTILLA REABRIR] Validación OK — estado=${cartilla.estado} version=${cartilla.version}`);

        // 2. Actualizar en la misma fila — sin crear fila nueva
        const ahora = new Date().toISOString();
        const { data: actualizada, error: errUpdate } = await supabase
            .from('cartillas_jurado')
            .update({
                estado:            'reabierta',
                motivo_reapertura: motivo.trim(),
                reabierta_por:     String(req.usuario.id),
                reabierta_en:      ahora,
                updated_at:        ahora
            })
            .eq('id', cartilla.id)
            .select()
            .single();

        if (errUpdate) {
            console.error(`[CARTILLA REABRIR] Error en UPDATE: ${errUpdate.message}`);
            return res.status(500).json({ error: 'Error al reabrir cartilla: ' + errUpdate.message });
        }

        console.log(`[CARTILLA REABRIR] UPDATE exitoso — cartilla_id=${cartilla.id}`);

        // 3. Responder al cliente ANTES de registrar auditoría
        //    (la auditoría es secundaria — no debe bloquear ni afectar la respuesta)
        res.json({
            ok: true,
            mensaje: 'Cartilla reabierta. El jurado puede enviar una nueva versión.',
            cartilla: actualizada
        });

        // 4. Auditoría en background — después de responder al cliente
        supabase.from('auditoria').insert({
            tabla:        'cartillas_jurado',
            accion:       'reabrir_cartilla',
            registro_id:  String(cartilla.id),
            datos_nuevos: { version: cartilla.version, motivo: motivo.trim() },
            actor_id:     String(req.usuario.id),
            actor_tipo:   'administrador',
            ip_address:   req.ip || null
        }).then(() => {
            console.log(`[CARTILLA REABRIR] Auditoría registrada — cartilla_id=${cartilla.id}`);
        }).catch((err) => {
            console.error(`[CARTILLA REABRIR] Error en auditoría (no crítico): ${err?.message || err}`);
        });

    } catch (err) {
        console.error('[CARTILLA REABRIR] Error inesperado:', err.message, err.stack);
        // Solo responder si no se respondió aún
        if (!res.headersSent) {
            res.status(500).json({ error: 'Error interno al reabrir cartilla' });
        }
    }
});

module.exports = router;
