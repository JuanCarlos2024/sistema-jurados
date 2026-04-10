const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');
const ExcelJS  = require('exceljs');

const TIPO_LABEL = { jurado: 'Jurado', delegado_rentado: 'Delegado Rentado' };

// ─── Filtros en memoria ────────────────────────────────────────
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

/**
 * Obtiene disponibilidad usando DOS queries separados (sin join de Supabase JS)
 * para evitar problemas de detección automática de FK en PostgREST.
 * 1. Lee disponibilidad_usuarios con filtros de fecha
 * 2. Lee usuarios_pagados para los IDs encontrados
 * 3. Une en memoria
 */
async function obtenerDisponibilidad(fecha_desde, fecha_hasta) {
    // Paso 1: registros de disponibilidad (solo columnas propias)
    let q = supabase
        .from('disponibilidad_usuarios')
        .select('id, fecha, usuario_pagado_id')
        .order('fecha', { ascending: true });

    if (fecha_desde) q = q.gte('fecha', fecha_desde);
    if (fecha_hasta) q = q.lte('fecha', fecha_hasta);

    const { data: dispRows, error: dispError } = await q;
    if (dispError) throw new Error('Error consultando disponibilidad: ' + dispError.message);
    if (!dispRows || dispRows.length === 0) return [];

    // Paso 2: datos de usuarios involucrados
    const userIds = [...new Set(dispRows.map(d => d.usuario_pagado_id))];
    const { data: usuarios, error: userError } = await supabase
        .from('usuarios_pagados')
        .select('id, nombre_completo, tipo_persona, categoria, rut')
        .in('id', userIds);

    if (userError) throw new Error('Error consultando usuarios: ' + userError.message);

    // Paso 3: unir en memoria
    const userMap = {};
    (usuarios || []).forEach(u => { userMap[u.id] = u; });

    return dispRows
        .map(d => ({ ...d, usuarios_pagados: userMap[d.usuario_pagado_id] || null }))
        .filter(d => d.usuarios_pagados !== null);
}

// ─── GET /api/admin/disponibilidad ──────────────────────────
router.get('/', async (req, res) => {
    try {
        const { fecha_desde, fecha_hasta, tipo_persona, categoria, nombre } = req.query;
        let rows = await obtenerDisponibilidad(fecha_desde, fecha_hasta);
        rows = filtrarRows(rows, { tipo_persona, categoria, nombre });
        rows = ordenarPorNombre(rows);
        res.json(rows);
    } catch (err) {
        console.error('[admin/disponibilidad GET /]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/admin/disponibilidad/por-fecha ─────────────────
router.get('/por-fecha', async (req, res) => {
    try {
        const { fecha_desde, fecha_hasta, tipo_persona, categoria, nombre } = req.query;
        let rows = await obtenerDisponibilidad(fecha_desde, fecha_hasta);
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
        console.error('[admin/disponibilidad GET /por-fecha]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/admin/disponibilidad/exportar ──────────────────
router.get('/exportar', async (req, res) => {
    try {
        const { fecha_desde, fecha_hasta, tipo_persona, categoria, nombre, formato = 'xlsx' } = req.query;
        let rows = await obtenerDisponibilidad(fecha_desde, fecha_hasta);
        rows = filtrarRows(rows, { tipo_persona, categoria, nombre });
        rows = ordenarPorNombre(rows);

        // ── CSV ──
        if (formato === 'csv') {
            const lines = ['Nombre,Tipo,Categoría,Fecha'];
            rows.forEach(d => {
                const u = d.usuarios_pagados;
                lines.push([
                    `"${(u.nombre_completo || '').replace(/"/g, '""')}"`,
                    `"${TIPO_LABEL[u.tipo_persona] || u.tipo_persona || ''}"`,
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

        const HEADER_STYLE = {
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
        ws.getRow(1).eachCell(cell => { Object.assign(cell, HEADER_STYLE); });

        rows.forEach(d => {
            const u = d.usuarios_pagados;
            ws.addRow({
                nombre:    u.nombre_completo || '',
                tipo:      TIPO_LABEL[u.tipo_persona] || u.tipo_persona || '',
                categoria: u.categoria || '',
                fecha:     d.fecha,
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="disponibilidad.xlsx"');
        await wb.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error('[admin/disponibilidad GET /exportar]', err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
});

module.exports = router;
