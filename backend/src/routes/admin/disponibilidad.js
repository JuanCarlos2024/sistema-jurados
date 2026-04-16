const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');
const ExcelJS  = require('exceljs');

const TIPO_LABEL = { jurado: 'Jurado', delegado_rentado: 'Delegado Rentado' };
const SUPABASE_TIMEOUT_MS = 20000; // 20 s — falla rápido si Supabase no responde

// ─── Helper: timeout para cualquier thenable de Supabase ──────
function withTimeout(thenable, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`Timeout: "${label}" no respondió en ${SUPABASE_TIMEOUT_MS / 1000}s`)),
            SUPABASE_TIMEOUT_MS
        );
        Promise.resolve(thenable)
            .then(v => { clearTimeout(timer); resolve(v); })
            .catch(e => { clearTimeout(timer); reject(e); });
    });
}

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

    const { data: dispRows, error: dispError } = await withTimeout(q, 'disponibilidad_usuarios');

    if (dispError) {
        console.error('[DISP] Error Step1:', JSON.stringify(dispError));
        throw new Error('Error consultando disponibilidad: ' + (dispError.message || dispError.code || JSON.stringify(dispError)));
    }

    const totalDisp = (dispRows || []).length;
    console.log(`[DISP] Step1 OK: ${totalDisp} registros (${fecha_desde || '*'} → ${fecha_hasta || '*'})`);

    if (totalDisp === 0) return [];

    // ── Paso 2: datos de los usuarios involucrados ───────────
    const userIds = [...new Set(dispRows.map(d => d.usuario_pagado_id))];

    const { data: usuarios, error: userError } = await withTimeout(
        supabase
            .from('usuarios_pagados')
            .select('id, nombre_completo, tipo_persona, categoria, rut, ciudad, asociacion')
            .in('id', userIds),
        'usuarios_pagados'
    );

    if (userError) {
        console.error('[DISP] Error Step2:', JSON.stringify(userError));
        throw new Error('Error consultando usuarios: ' + (userError.message || userError.code || JSON.stringify(userError)));
    }

    // ── Paso 3: historial de rodeos por usuario (batch, histórico global) ───
    const N_HISTORIAL = 8;
    const { data: asigRows, error: asigError } = await withTimeout(
        supabase
            .from('asignaciones')
            .select('usuario_pagado_id, rodeos(club, asociacion, fecha)')
            .in('usuario_pagado_id', userIds)
            .eq('estado_designacion', 'aceptado'),
        'asignaciones_historial'
    );

    if (asigError) {
        console.warn('[DISP] Step3 warn (historial, no-fatal):', JSON.stringify(asigError));
    }

    const historialMap = {};
    (asigRows || []).forEach(a => {
        const rodeo = a.rodeos;
        if (!rodeo || !rodeo.fecha) return;
        // Sin filtro de período — histórico general
        if (!historialMap[a.usuario_pagado_id]) historialMap[a.usuario_pagado_id] = [];
        historialMap[a.usuario_pagado_id].push(rodeo);
    });
    Object.keys(historialMap).forEach(uid => {
        // Deduplicar por club + asociacion + fecha
        const seen = new Set();
        historialMap[uid] = historialMap[uid].filter(r => {
            const key = `${r.club}|${r.asociacion}|${r.fecha}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        // Ordenar fecha desc, tomar los últimos N históricos, formatear
        historialMap[uid].sort((a, b) => b.fecha.localeCompare(a.fecha));
        historialMap[uid] = historialMap[uid]
            .slice(0, N_HISTORIAL)
            .map(r => {
                const [, mes, dia] = r.fecha.split('-');
                return `${(r.club || '—')} - ${(r.asociacion || '—')} - ${dia}/${mes}`;
            });
    });
    console.log(`[DISP] Step3 OK: historial histórico para ${Object.keys(historialMap).length} usuario(s) (N=${N_HISTORIAL})`);

    // ── Paso 4: unir en memoria ──────────────────────────────
    const userMap = {};
    (usuarios || []).forEach(u => {
        userMap[u.id] = { ...u, historial_rodeos: historialMap[u.id] || [] };
    });

    const resultado = dispRows
        .map(d => ({ ...d, usuarios_pagados: userMap[d.usuario_pagado_id] || null }))
        .filter(d => d.usuarios_pagados !== null);

    console.log(`[DISP] OK: ${resultado.length} filas (${userIds.length} usuarios)`);
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

        // Helper: extrae las 8 columnas de rodeos de un usuario
        function rodeosCols(u) {
            const h = u.historial_rodeos || [];
            return [
                h[0]||'', h[1]||'', h[2]||'', h[3]||'',
                h[4]||'', h[5]||'', h[6]||'', h[7]||''
            ];
        }

        if (formato === 'csv') {
            const lines = [
                'Nombre,Tipo,Categoría,Asociación,Ciudad,Fecha disponible,Último rodeo 1,Último rodeo 2,Último rodeo 3,Último rodeo 4,Último rodeo 5,Último rodeo 6,Último rodeo 7,Último rodeo 8'
            ];
            rows.forEach(d => {
                const u = d.usuarios_pagados;
                const [r1,r2,r3,r4,r5,r6,r7,r8] = rodeosCols(u);
                lines.push([
                    `"${(u.nombre_completo || '').replace(/"/g, '""')}"`,
                    `"${TIPO_LABEL[u.tipo_persona] || u.tipo_persona || ''}"`,
                    `"${u.categoria || ''}"`,
                    `"${(u.asociacion || '').replace(/"/g, '""')}"`,
                    `"${u.ciudad || ''}"`,
                    `"${d.fecha}"`,
                    `"${r1.replace(/"/g,'""')}"`,`"${r2.replace(/"/g,'""')}"`,
                    `"${r3.replace(/"/g,'""')}"`,`"${r4.replace(/"/g,'""')}"`,
                    `"${r5.replace(/"/g,'""')}"`,`"${r6.replace(/"/g,'""')}"`,
                    `"${r7.replace(/"/g,'""')}"`,`"${r8.replace(/"/g,'""')}"`
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
            { header: 'Nombre',           key: 'nombre',  width: 30 },
            { header: 'Tipo',             key: 'tipo',    width: 20 },
            { header: 'Categoría',        key: 'cat',     width: 12 },
            { header: 'Asociación',       key: 'asoc',    width: 22 },
            { header: 'Ciudad',           key: 'ciudad',  width: 18 },
            { header: 'Fecha disponible', key: 'fecha',   width: 16 },
            { header: 'Último rodeo 1',   key: 'r1',      width: 32 },
            { header: 'Último rodeo 2',   key: 'r2',      width: 32 },
            { header: 'Último rodeo 3',   key: 'r3',      width: 32 },
            { header: 'Último rodeo 4',   key: 'r4',      width: 32 },
            { header: 'Último rodeo 5',   key: 'r5',      width: 32 },
            { header: 'Último rodeo 6',   key: 'r6',      width: 32 },
            { header: 'Último rodeo 7',   key: 'r7',      width: 32 },
            { header: 'Último rodeo 8',   key: 'r8',      width: 32 },
        ];
        ws.getRow(1).eachCell(cell => { Object.assign(cell, HEADER_STYLE); });

        rows.forEach(d => {
            const u = d.usuarios_pagados;
            const [r1,r2,r3,r4,r5,r6,r7,r8] = rodeosCols(u);
            ws.addRow({
                nombre: u.nombre_completo || '',
                tipo:   TIPO_LABEL[u.tipo_persona] || u.tipo_persona || '',
                cat:    u.categoria || '',
                asoc:   u.asociacion || '',
                ciudad: u.ciudad || '',
                fecha:  d.fecha,
                r1, r2, r3, r4, r5, r6, r7, r8,
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
