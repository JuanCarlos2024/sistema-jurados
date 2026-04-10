const express = require('express');
const router = express.Router();
const { calcularResumenMensual } = require('../../services/calculo');
const supabase = require('../../config/supabase');

// GET /api/usuario/resumen/historial
// Retorna todos los meses con totales para el historial financiero
router.get('/historial', async (req, res) => {
    const { data, error } = await supabase
        .from('asignaciones')
        .select(`
            id, pago_base_calculado, estado_designacion,
            rodeos!inner(fecha),
            bonos_solicitados(estado, monto_aprobado, monto_solicitado)
        `)
        .eq('usuario_pagado_id', req.usuario.id)
        .eq('estado', 'activo');

    if (error) return res.status(500).json({ error: error.message });

    const meses = {};
    (data || []).forEach(a => {
        const fecha = a.rodeos?.fecha;
        if (!fecha) return;
        const [año, mes] = fecha.split('-');
        const key = `${año}-${mes}`;
        if (!meses[key]) meses[key] = { año: parseInt(año), mes: parseInt(mes), total_pago_base: 0, total_bono: 0, rodeos: 0 };
        if (a.estado_designacion !== 'rechazado') {
            meses[key].total_pago_base += a.pago_base_calculado || 0;
            meses[key].rodeos += 1;
            const bonoAprobado = (a.bonos_solicitados || [])
                .filter(b => ['aprobado', 'modificado'].includes(b.estado))
                .reduce((s, b) => s + (b.monto_aprobado || b.monto_solicitado || 0), 0);
            meses[key].total_bono += bonoAprobado;
        }
    });

    const result = Object.values(meses)
        .sort((a, b) => b.año !== a.año ? b.año - a.año : b.mes - a.mes)
        .map(m => ({ ...m, bruto: m.total_pago_base + m.total_bono }));

    res.json(result);
});

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
