const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');
const ExcelJS  = require('exceljs');

// ─── GET /api/admin/disponibilidad ──────────────────────────
// Filtros: fecha_desde, fecha_hasta, tipo_persona, categoria, nombre
// Devuelve lista de disponibilidades con datos del usuario
router.get('/', async (req, res) => {
    const { fecha_desde, fecha_hasta, tipo_persona, categoria, nombre } = req.query;

    let query = supabase
        .from('disponibilidad_usuarios')
        .select(`
            id, fecha,
            usuarios_pagados!inner(
                id, nombre_completo, tipo_persona, categoria, rut
            )
        `)
        .order('fecha', { ascending: true })
        .order('usuarios_pagados(nombre_completo)', { ascending: true });

    if (fecha_desde) query = query.gte('fecha', fecha_desde);
    if (fecha_hasta) query = query.lte('fecha', fecha_hasta);
    if (tipo_persona) query = query.eq('usuarios_pagados.tipo_persona', tipo_persona);
    if (categoria)   query = query.eq('usuarios_pagados.categoria', categoria);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    let result = data || [];

    // Filtro por nombre (insensible a mayúsculas, en memoria porque Supabase no soporta ilike en join)
    if (nombre) {
        const q = nombre.toLowerCase();
        result = result.filter(d =>
            d.usuarios_pagados?.nombre_completo?.toLowerCase().includes(q)
        );
    }

    res.json(result);
});

// ─── GET /api/admin/disponibilidad/por-fecha ─────────────────
// Agrupa disponibles por fecha (para vista calendario del admin)
// Filtros: fecha_desde, fecha_hasta, tipo_persona, categoria
router.get('/por-fecha', async (req, res) => {
    const { fecha_desde, fecha_hasta, tipo_persona, categoria } = req.query;

    let query = supabase
        .from('disponibilidad_usuarios')
        .select(`
            fecha,
            usuarios_pagados!inner(id, nombre_completo, tipo_persona, categoria)
        `)
        .order('fecha');

    if (fecha_desde) query = query.gte('fecha', fecha_desde);
    if (fecha_hasta) query = query.lte('fecha', fecha_hasta);
    if (tipo_persona) query = query.eq('usuarios_pagados.tipo_persona', tipo_persona);
    if (categoria)   query = query.eq('usuarios_pagados.categoria', categoria);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Agrupar por fecha
    const porFecha = {};
    (data || []).forEach(d => {
        if (!porFecha[d.fecha]) porFecha[d.fecha] = [];
        porFecha[d.fecha].push(d.usuarios_pagados);
    });

    res.json(porFecha);
});

// ─── GET /api/admin/disponibilidad/exportar ──────────────────
// Exporta a Excel o CSV. Parámetro: formato=xlsx|csv
router.get('/exportar', async (req, res) => {
    const { fecha_desde, fecha_hasta, tipo_persona, categoria, nombre, formato = 'xlsx' } = req.query;

    let query = supabase
        .from('disponibilidad_usuarios')
        .select(`
            fecha,
            usuarios_pagados!inner(nombre_completo, tipo_persona, categoria, rut)
        `)
        .order('fecha')
        .order('usuarios_pagados(nombre_completo)');

    if (fecha_desde) query = query.gte('fecha', fecha_desde);
    if (fecha_hasta) query = query.lte('fecha', fecha_hasta);
    if (tipo_persona) query = query.eq('usuarios_pagados.tipo_persona', tipo_persona);
    if (categoria)   query = query.eq('usuarios_pagados.categoria', categoria);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    let rows = data || [];
    if (nombre) {
        const q = nombre.toLowerCase();
        rows = rows.filter(d => d.usuarios_pagados?.nombre_completo?.toLowerCase().includes(q));
    }

    const tipoLabel = { jurado: 'Jurado', delegado_rentado: 'Delegado Rentado' };

    if (formato === 'csv') {
        const lines = ['Nombre,Tipo,Categoría,Fecha'];
        rows.forEach(d => {
            const u = d.usuarios_pagados;
            lines.push([
                `"${u.nombre_completo || ''}"`,
                `"${tipoLabel[u.tipo_persona] || u.tipo_persona || ''}"`,
                `"${u.categoria || ''}"`,
                `"${d.fecha}"`
            ].join(','));
        });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="disponibilidad.csv"');
        return res.send('\uFEFF' + lines.join('\r\n')); // BOM para Excel
    }

    // Excel
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Sistema Jurados - Rodeo Chileno';
    const ws = wb.addWorksheet('Disponibilidad');

    const HEADER = {
        font: { bold: true, color: { argb: 'FFFFFFFF' } },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a5f' } },
        alignment: { horizontal: 'center' },
        border: { top:{style:'thin'}, bottom:{style:'thin'}, left:{style:'thin'}, right:{style:'thin'} }
    };

    ws.columns = [
        { header: 'Nombre',    key: 'nombre',    width: 30 },
        { header: 'Tipo',      key: 'tipo',       width: 18 },
        { header: 'Categoría', key: 'categoria',  width: 12 },
        { header: 'Fecha',     key: 'fecha',      width: 14 },
    ];
    ws.getRow(1).eachCell(cell => { Object.assign(cell, HEADER); });

    rows.forEach(d => {
        const u = d.usuarios_pagados;
        ws.addRow({
            nombre:    u.nombre_completo || '',
            tipo:      tipoLabel[u.tipo_persona] || u.tipo_persona || '',
            categoria: u.categoria || '',
            fecha:     d.fecha,
        });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="disponibilidad.xlsx"');
    await wb.xlsx.write(res);
    res.end();
});

module.exports = router;
