const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');
const ExcelJS  = require('exceljs');

// Todos los filtros de usuario se aplican en memoria para evitar
// problemas de sintaxis con filtros sobre tablas relacionadas en Supabase JS.
function filtrarRows(rows, { tipo_persona, categoria, nombre }) {
    if (tipo_persona) rows = rows.filter(d => d.usuarios_pagados?.tipo_persona === tipo_persona);
    if (categoria)    rows = rows.filter(d => d.usuarios_pagados?.categoria === categoria);
    if (nombre) {
        const q = nombre.toLowerCase();
        rows = rows.filter(d => d.usuarios_pagados?.nombre_completo?.toLowerCase().includes(q));
    }
    return rows;
}

function ordenarPorNombre(rows) {
    return rows.sort((a, b) =>
        (a.usuarios_pagados?.nombre_completo || '').localeCompare(
            b.usuarios_pagados?.nombre_completo || '', 'es'
        )
    );
}

// ─── GET /api/admin/disponibilidad ──────────────────────────
router.get('/', async (req, res) => {
    try {
        const { fecha_desde, fecha_hasta, tipo_persona, categoria, nombre } = req.query;

        let query = supabase
            .from('disponibilidad_usuarios')
            .select('id, fecha, usuarios_pagados(id, nombre_completo, tipo_persona, categoria, rut)')
            .order('fecha', { ascending: true });

        if (fecha_desde) query = query.gte('fecha', fecha_desde);
        if (fecha_hasta) query = query.lte('fecha', fecha_hasta);

        const { data, error } = await query;
        if (error) return res.status(500).json({ error: error.message });

        // Excluir filas donde el usuario fue eliminado (usuarios_pagados = null)
        let rows = (data || []).filter(d => d.usuarios_pagados != null);
        rows = filtrarRows(rows, { tipo_persona, categoria, nombre });
        rows = ordenarPorNombre(rows);

        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener disponibilidad: ' + err.message });
    }
});

// ─── GET /api/admin/disponibilidad/por-fecha ─────────────────
router.get('/por-fecha', async (req, res) => {
    try {
        const { fecha_desde, fecha_hasta, tipo_persona, categoria, nombre } = req.query;

        let query = supabase
            .from('disponibilidad_usuarios')
            .select('fecha, usuarios_pagados(id, nombre_completo, tipo_persona, categoria)')
            .order('fecha', { ascending: true });

        if (fecha_desde) query = query.gte('fecha', fecha_desde);
        if (fecha_hasta) query = query.lte('fecha', fecha_hasta);

        const { data, error } = await query;
        if (error) return res.status(500).json({ error: error.message });

        let rows = (data || []).filter(d => d.usuarios_pagados != null);
        rows = filtrarRows(rows, { tipo_persona, categoria, nombre });

        // Agrupar por fecha; ordenar personas dentro de cada fecha
        const porFecha = {};
        rows.forEach(d => {
            if (!porFecha[d.fecha]) porFecha[d.fecha] = [];
            porFecha[d.fecha].push(d.usuarios_pagados);
        });
        Object.keys(porFecha).forEach(f => {
            porFecha[f].sort((a, b) =>
                (a.nombre_completo || '').localeCompare(b.nombre_completo || '', 'es')
            );
        });

        res.json(porFecha);
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener disponibilidad por fecha: ' + err.message });
    }
});

// ─── GET /api/admin/disponibilidad/exportar ──────────────────
router.get('/exportar', async (req, res) => {
    try {
        const { fecha_desde, fecha_hasta, tipo_persona, categoria, nombre, formato = 'xlsx' } = req.query;

        let query = supabase
            .from('disponibilidad_usuarios')
            .select('fecha, usuarios_pagados(nombre_completo, tipo_persona, categoria, rut)')
            .order('fecha', { ascending: true });

        if (fecha_desde) query = query.gte('fecha', fecha_desde);
        if (fecha_hasta) query = query.lte('fecha', fecha_hasta);

        const { data, error } = await query;
        if (error) return res.status(500).json({ error: error.message });

        let rows = (data || []).filter(d => d.usuarios_pagados != null);
        rows = filtrarRows(rows, { tipo_persona, categoria, nombre });
        rows = ordenarPorNombre(rows);

        const tipoLabel = { jurado: 'Jurado', delegado_rentado: 'Delegado Rentado' };

        // ── CSV ──
        if (formato === 'csv') {
            const lines = ['Nombre,Tipo,Categoría,Fecha'];
            rows.forEach(d => {
                const u = d.usuarios_pagados;
                lines.push([
                    `"${(u.nombre_completo || '').replace(/"/g, '""')}"`,
                    `"${tipoLabel[u.tipo_persona] || u.tipo_persona || ''}"`,
                    `"${u.categoria || ''}"`,
                    `"${d.fecha}"`
                ].join(','));
            });
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="disponibilidad.csv"');
            return res.send('\uFEFF' + lines.join('\r\n'));
        }

        // ── Excel ──
        const wb = new ExcelJS.Workbook();
        wb.creator = 'Sistema Jurados - Rodeo Chileno';
        const ws = wb.addWorksheet('Disponibilidad');

        const HEADER = {
            font: { bold: true, color: { argb: 'FFFFFFFF' } },
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a5f' } },
            alignment: { horizontal: 'center' },
            border: {
                top: { style: 'thin' }, bottom: { style: 'thin' },
                left: { style: 'thin' }, right: { style: 'thin' }
            }
        };

        ws.columns = [
            { header: 'Nombre',    key: 'nombre',    width: 30 },
            { header: 'Tipo',      key: 'tipo',       width: 20 },
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
    } catch (err) {
        if (!res.headersSent) {
            res.status(500).json({ error: 'Error al exportar: ' + err.message });
        }
    }
});

module.exports = router;
