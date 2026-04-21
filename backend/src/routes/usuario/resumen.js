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

// GET /api/usuario/resumen/desempeno
// KPIs globales del jurado: total rodeos histórico, promedio nota propio, promedio categoría
router.get('/desempeno', async (req, res) => {
    const uid = req.usuario.id;
    try {
        // 1. Perfil para obtener categoría y tipo
        const { data: perfil } = await supabase
            .from('usuarios_pagados')
            .select('categoria, tipo_persona')
            .eq('id', uid)
            .single();

        const esDelegado = perfil?.tipo_persona === 'delegado_rentado';
        const categoria  = esDelegado ? 'DR' : (perfil?.categoria || null);

        // 2. Todas las asignaciones activas y no rechazadas del usuario
        const { data: asigs } = await supabase
            .from('asignaciones')
            .select('id, estado_designacion')
            .eq('usuario_pagado_id', uid)
            .eq('estado', 'activo');

        const propias = (asigs || []).filter(a => a.estado_designacion !== 'rechazado');
        const total_rodeos = propias.length;
        const propiosIds   = propias.map(a => a.id);

        // 3. Notas propias
        let promedio_nota = null;
        if (propiosIds.length > 0) {
            const { data: notas } = await supabase
                .from('notas_rodeo')
                .select('nota')
                .in('asignacion_id', propiosIds);
            const vals = (notas || []).map(n => parseFloat(n.nota)).filter(n => !isNaN(n));
            if (vals.length > 0)
                promedio_nota = Math.round((vals.reduce((s, n) => s + n, 0) / vals.length) * 100) / 100;
        }

        // 4. Promedio de categoría (todos los usuarios del mismo tipo/categoría)
        let promedio_categoria = null;
        if (categoria) {
            const qPares = supabase
                .from('usuarios_pagados')
                .select('id')
                .eq('activo', true);
            const { data: pares } = esDelegado
                ? await qPares.eq('tipo_persona', 'delegado_rentado')
                : await qPares.eq('tipo_persona', 'jurado').eq('categoria', categoria);

            const pareIds = (pares || []).map(u => u.id);
            if (pareIds.length > 0) {
                const { data: asigsPares } = await supabase
                    .from('asignaciones')
                    .select('id, estado_designacion')
                    .eq('estado', 'activo')
                    .in('usuario_pagado_id', pareIds);

                const asigIdsPares = (asigsPares || [])
                    .filter(a => a.estado_designacion !== 'rechazado')
                    .map(a => a.id);

                if (asigIdsPares.length > 0) {
                    const { data: notasPares } = await supabase
                        .from('notas_rodeo')
                        .select('nota')
                        .in('asignacion_id', asigIdsPares);
                    const vals = (notasPares || []).map(n => parseFloat(n.nota)).filter(n => !isNaN(n));
                    if (vals.length > 0)
                        promedio_categoria = Math.round((vals.reduce((s, n) => s + n, 0) / vals.length) * 100) / 100;
                }
            }
        }

        res.json({ total_rodeos, promedio_nota, promedio_categoria, categoria });
    } catch (err) {
        console.error('[resumen/desempeno]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/usuario/resumen?año=&mes=
router.get('/', async (req, res) => {
    const ahora = new Date();
    const año = req.query.año || ahora.getFullYear().toString();
    const mes = req.query.mes || String(ahora.getMonth() + 1).padStart(2, '0');

    try {
        const resumen = await calcularResumenMensual(req.usuario.id, año, mes);

        // Adjuntar notas y estado de cartilla por asignación
        const asigIds = (resumen.asignaciones || []).map(a => a.id);
        if (asigIds.length > 0) {
            const [{ data: notas }, { data: cartillas }] = await Promise.all([
                supabase.from('notas_rodeo').select('asignacion_id, nota, comentario').in('asignacion_id', asigIds),
                supabase.from('cartillas_jurado').select('asignacion_id, estado').in('asignacion_id', asigIds)
            ]);
            const notasMap     = {};
            const cartillasMap = {};
            (notas     || []).forEach(n => { notasMap[n.asignacion_id]     = n; });
            (cartillas || []).forEach(c => { cartillasMap[c.asignacion_id] = c.estado; });
            resumen.asignaciones = resumen.asignaciones.map(a => ({
                ...a,
                nota_rodeo:     notasMap[a.id]     || null,
                cartilla_estado: cartillasMap[a.id] || null
            }));
        }

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
