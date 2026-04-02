const express = require('express');
const router = express.Router();
const { calcularResumenMensual } = require('../../services/calculo');
const supabase = require('../../config/supabase');

// GET /api/usuario/resumen?año=&mes=
router.get('/', async (req, res) => {
    const ahora = new Date();
    const año = req.query.año || ahora.getFullYear().toString();
    const mes = req.query.mes || String(ahora.getMonth() + 1).padStart(2, '0');

    try {
        const resumen = await calcularResumenMensual(req.usuario.id, año, mes);
        res.json({ año: parseInt(año), mes: parseInt(mes), ...resumen });
    } catch (err) {
        res.status(500).json({ error: 'Error al calcular resumen: ' + err.message });
    }
});

// GET /api/usuario/resumen/meses-disponibles
// Retorna los meses en que el usuario tiene asignaciones
router.get('/meses-disponibles', async (req, res) => {
    const { data, error } = await supabase
        .from('asignaciones')
        .select('rodeos!inner(fecha)')
        .eq('usuario_pagado_id', req.usuario.id)
        .eq('estado', 'activo');

    if (error) return res.status(500).json({ error: error.message });

    // Extraer años y meses únicos
    const mesesSet = new Set();
    (data || []).forEach(a => {
        const fecha = a.rodeos?.fecha;
        if (fecha) {
            const [año, mes] = fecha.split('-');
            mesesSet.add(`${año}-${mes}`);
        }
    });

    const meses = Array.from(mesesSet)
        .sort((a, b) => b.localeCompare(a))
        .map(m => {
            const [año, mes] = m.split('-');
            return { año: parseInt(año), mes: parseInt(mes) };
        });

    res.json(meses);
});

module.exports = router;
