// ─────────────────────────────────────────────────────────────────────────
// Catálogo de delegados de la asociación autenticada (Fase 2, solo lectura
// salvo la validación de selección, que tampoco escribe nada todavía).
// ─────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const { soloCuentaInstitucional } = require('../../middleware/auth');

router.use(soloCuentaInstitucional);

// GET /api/institucional/delegados — solo delegados activos Y certificados
// (ver migración 064: certificado != activo) de la asociación del token.
// Nunca acepta una asociación distinta desde el request (Caso B).
router.get('/', async (req, res) => {
    const { data, error } = await supabase
        .from('delegados_asociacion')
        .select('id, nombre')
        .eq('asociacion_id', req.usuario.asociacion_id)
        .eq('activo', true)
        .eq('certificado', true)
        .order('nombre');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ delegados: data || [], asociacion_id: req.usuario.asociacion_id });
});

// POST /api/institucional/delegados/seleccionar — valida (STATELESS, Fase 2)
// que un delegado_id sea legítimo para la asociación autenticada antes de
// que el frontend lo recuerde localmente durante la sesión. No persiste
// "quién está seleccionado" en ninguna tabla — esa auditoría real (quién
// seleccionó a quién, cuándo, para qué acción) es diseño de Fase 3, ligado a
// la integración con la Cartilla de Delegado. Es una declaración del usuario
// institucional, nunca una autenticación individual (no emite ni modifica
// ningún token).
router.post('/seleccionar', async (req, res) => {
    const { delegado_id } = req.body;
    if (!delegado_id) return res.status(400).json({ error: 'delegado_id es requerido' });

    const { data, error } = await supabase
        .from('delegados_asociacion')
        .select('id, nombre, asociacion_id, activo, certificado')
        .eq('id', delegado_id)
        .single();

    // Mismo criterio ante cualquier motivo de rechazo (inexistente, inactivo, no
    // certificado, o de OTRA asociación): un único mensaje genérico — Caso G.
    if (error || !data || !data.activo || !data.certificado || data.asociacion_id !== req.usuario.asociacion_id) {
        return res.status(403).json({ error: 'Delegado no válido para esta asociación' });
    }

    res.json({ delegado: { id: data.id, nombre: data.nombre } });
});

module.exports = router;
