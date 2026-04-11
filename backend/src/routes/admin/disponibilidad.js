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
 * Dos queries separados — sin join de Supabase JS para evitar
 * fallos silenciosos de PostgREST al resolver la FK usuario_pagado_id.
 */
async function obtenerDisponibilidad(fecha_desde, fecha_hasta) {
    // ── Paso 1: registros de disponibilidad ──────────────────
    let q = supabase
        .from('disponibilidad_usuarios')
        .select('id, fecha, usuario_pagado_id')
        .order('fecha', { ascending: true });

    if (fecha_desde) q = q.gte('fecha', fecha_desde);
    if (fecha_hasta) q = q.lte('fecha', fecha_hasta);

    const { data: dispRows, error: dispError } = await q;

    if (dispError) {
        console.error('[DISP] Error en query disponibilidad_usuarios:', dispError.message);
        throw new Error('Error consultando disponibilidad: ' + dispError.message);
    }

    const totalDisp = (dispRows || []).length;
    console.log(`[DISP] Step 1 OK: ${totalDisp} registros (rango: ${fecha_desde || '*'} → ${fecha_hasta || '*'})`);

    if (totalDisp === 0) return [];

    // ── Paso 2: datos de los usuarios involucrados ───────────
    const userIds = [...new Set(dispRows.map(d => d.usuario_pagado_id))];
    console.log(`[DISP] Step 2: buscando ${userIds.length} usuario(s)`);

    const { data: usuarios, error: userError } = await supabase
        .from('usuarios_pagados')
        .select('id, nombre_completo, tipo_persona, categoria, rut')
        .in('id', userIds);

    if (userError) {
        console.error('[DISP] Error en query usuarios_pagados:', userError.message);
        throw new Error('Error consultando usuarios: ' + userError.message);
    }

    console.log(`[DISP] Step 2 OK: ${(usuarios || []).length} usuario(s) encontrado(s)`);

    // ── Paso 3: unir en memoria ──────────────────────────────
    const userMap = {};
    (usuarios || []).forEach(u => { userMap[u.id] = u; });

    const resultado = dispRows
        .map(d => ({ ...d, usuarios_pagados: userMap[d.usuario_pagado_id] || null }))
        .filter(d => d.usuarios_pagados !== null);

    console.log(`[DISP] Step 3 OK: ${resultado.length} filas con usuario válido`);
    return resultado;
}

// ─── GET /api/admin/disponibilidad ──────────────────────────
router.get('/', async (req, res) => {
    console.log('[DISP] GET / params:', JSON.stringify(req.query));
    try {
        const { fecha_desde, fecha_hasta, tipo_persona, categoria, nombre } = req.query;
        let rows = await obtenerDisponibilidad(fecha_desde, fecha_hasta);
        rows = filtrarRows(rows, { tipo_persona, categoria, nombre });
        rows = ordenarPorNombre(rows);
        console.log(`[DISP] GET / responde ${rows.length} filas`);
        res.json(rows);
    } catch (err) {
        console.error('[DISP] GET / ERROR:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/admin/disponibilidad/por-fecha ─────────────────
router.get('/por-fecha', async (req, res) => {
    console.log('[DISP] GET /por-fecha params:', JSON.stringify(req.query));
    try {
        const { fecha_desde, fecha_hasta, tipo_persona, categoria, nombre } = req.query;
        let rows = await obtenerDisponibilidad(fecha_desde, fecha_hasta);
        rows = filtrarRows(rows, { tipo_persona, categoria, nombre });

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

        const nFechas = Object.keys(porFecha).length;
        console.log(`[DISP] GET /por-fecha responde ${nFechas} fecha(s)`);
        res.json(porFecha);
    } catch (err) {
        console.error('[DISP] GET /por-fecha ERROR:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/admin/disponibilidad/exportar ──────────────────
router.get('/exportar', async (req, res) => {
    console.log('[DISP] GET /exportar params:', JSON.stringify(req.query));
    try {
        const { fecha_desde, fecha_hasta, tipo_persona, categoria, nombre, formato = 'xlsx' } = req.query;
        let rows = await obtenerDisponibilidad(fecha_desde, fecha_hasta);
        rows = filtrarRows(rows, { tipo_persona, categoria, nombre });
        rows = ordenarPorNombre(rows);

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
        console.error('[DISP] GET /exportar ERROR:', err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
});

module.exports = router;
