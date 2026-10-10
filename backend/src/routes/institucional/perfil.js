// ─────────────────────────────────────────────────────────────────────────
// GET /api/institucional/perfil — información institucional básica (Fase 2).
// Nunca expone campos financieros ni datos de otras cuentas: solo lo propio.
// ─────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const { soloCuentaInstitucional } = require('../../middleware/auth');

router.use(soloCuentaInstitucional);

router.get('/', async (req, res) => {
    const { data: cuenta, error } = await supabase
        .from('cuentas_institucionales')
        .select('email, activo, rol_institucional, asociaciones(id, nombre)')
        .eq('id', req.usuario.id)
        .single();

    if (error || !cuenta) return res.status(404).json({ error: 'Cuenta no encontrada' });

    res.json({
        email: cuenta.email,
        activo: cuenta.activo,
        rol_institucional: cuenta.rol_institucional,
        asociacion_id: cuenta.asociaciones?.id || null,
        asociacion_nombre: cuenta.asociaciones?.nombre || null
    });
});

module.exports = router;
