/**
 * GET /api/admin/reportes/movimiento-rienda
 * GET /api/admin/reportes/movimiento-rienda/exportar
 *
 * Reporte consolidado de registros de movimiento a la rienda.
 * Fuente: cartillas_jurado (JSONB datos.registros_rienda) + rodeos + usuarios_pagados.
 * Cada registro de rienda genera una fila independiente.
 */

const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtF  = iso => iso ? new Date(iso).toLocaleDateString('es-CL')  : '—';
const fmtDT = iso => iso ? new Date(iso).toLocaleString('es-CL')      : '—';
const clean = v  => String(v ?? '').trim() || '—';

// ─── Query principal ──────────────────────────────────────────────────────────

async function queryRienda(filtros) {
    const {
        fecha_desde, fecha_hasta, club, asociacion, jurado, tipo_rodeo, estado,
        categoria_rienda, sistema, nombre_socio, rut_socio, nombre_equino,
        puntaje_desde, puntaje_hasta, buscar
    } = filtros;

    let q = supabase
        .from('cartillas_jurado')
        .select(`
            id,
            asignacion_id,
            rodeo_id,
            usuario_pagado_id,
            estado,
            version,
            datos,
            enviada_en,
            rodeo:rodeos!cartillas_jurado_rodeo_id_fkey(id, club, asociacion, fecha, tipo_rodeo_nombre),
            jurado:usuarios_pagados!cartillas_jurado_usuario_pagado_id_fkey(id, nombre_completo, categoria)
        `)
        .eq('es_actual', true)
        .order('created_at', { ascending: false });

    if (estado) q = q.eq('estado', estado);

    const { data: cartillas, error } = await q;
    if (error) {
        console.error('[reporte-rienda] Error en query:', error);
        throw new Error('Error consultando cartillas: ' + error.message);
    }

    console.log(`[reporte-rienda] total cartillas obtenidas: ${(cartillas || []).length}`);

    // Solo cartillas con movimiento_rienda = 'si' y registros reales
    let resultado = (cartillas || []).filter(c => {
        const d = c.datos || {};
        return d.hubo_movimiento_rienda === 'si'
            && Array.isArray(d.registros_rienda)
            && d.registros_rienda.length > 0;
    });

    console.log(`[reporte-rienda] cartillas con movimiento_rienda='si': ${resultado.length}`);

    // Filtros de cartilla en JS
    if (jurado) {
        const b = jurado.toLowerCase();
        resultado = resultado.filter(c =>
            (c.jurado?.nombre_completo || '').toLowerCase().includes(b)
        );
    }
    if (fecha_desde) resultado = resultado.filter(c => c.rodeo?.fecha >= fecha_desde);
    if (fecha_hasta) resultado = resultado.filter(c => c.rodeo?.fecha <= fecha_hasta);
    if (club) {
        const b = club.toLowerCase();
        resultado = resultado.filter(c => (c.rodeo?.club || '').toLowerCase().includes(b));
    }
    if (asociacion) {
        const b = asociacion.toLowerCase();
        resultado = resultado.filter(c => (c.rodeo?.asociacion || '').toLowerCase().includes(b));
    }
    if (tipo_rodeo) {
        const b = tipo_rodeo.toLowerCase();
        resultado = resultado.filter(c => (c.rodeo?.tipo_rodeo_nombre || '').toLowerCase().includes(b));
    }

    // Expandir registros_rienda → filas planas
    const filas = [];
    for (const c of resultado) {
        const d      = c.datos  || {};
        const rodeo  = c.rodeo  || {};
        const jur    = c.jurado || {};
        const base = {
            cartilla_id:          c.id,
            asignacion_id:        c.asignacion_id,
            fecha_rodeo:          fmtF(rodeo.fecha),
            _fecha_raw:           rodeo.fecha || '',
            club:                 clean(rodeo.club),
            asociacion:           clean(rodeo.asociacion),
            tipo_rodeo:           clean(rodeo.tipo_rodeo_nombre),
            estado_cartilla:      c.estado || '—',
            fecha_envio:          fmtDT(c.enviada_en),
            jurado:               clean(jur.nombre_completo),
            categoria_jurado:     clean(jur.categoria),
            observaciones_finales: d.observaciones_finales || '—',
        };
        for (const rr of (d.registros_rienda || [])) {
            filas.push({
                ...base,
                categoria_rienda:  clean(rr.categoria),
                sistema:           clean(rr.sistema),
                nombre_socio:      clean(rr.nombre_socio),
                rut_socio:         clean(rr.rut_socio),
                nro_socio:         clean(rr.nro_socio),
                nombre_equino:     clean(rr.nombre_equino),
                nro_inscripcion:   clean(rr.nro_inscripcion),
                puntaje:           rr.puntaje !== undefined && rr.puntaje !== null ? String(rr.puntaje) : '—',
            });
        }
    }

    // Filtros sobre filas expandidas
    let filtradas = filas;

    if (categoria_rienda) {
        const b = categoria_rienda.toLowerCase();
        filtradas = filtradas.filter(f => f.categoria_rienda.toLowerCase().includes(b));
    }
    if (sistema) {
        const b = sistema.toLowerCase();
        filtradas = filtradas.filter(f => f.sistema.toLowerCase().includes(b));
    }
    if (nombre_socio) {
        const b = nombre_socio.toLowerCase();
        filtradas = filtradas.filter(f => f.nombre_socio.toLowerCase().includes(b));
    }
    if (rut_socio) {
        filtradas = filtradas.filter(f => f.rut_socio.includes(rut_socio));
    }
    if (nombre_equino) {
        const b = nombre_equino.toLowerCase();
        filtradas = filtradas.filter(f => f.nombre_equino.toLowerCase().includes(b));
    }
    if (puntaje_desde !== undefined && puntaje_desde !== '') {
        const pd = parseFloat(puntaje_desde);
        if (!isNaN(pd)) {
            filtradas = filtradas.filter(f => {
                const p = parseFloat(f.puntaje);
                return !isNaN(p) && p >= pd;
            });
        }
    }
    if (puntaje_hasta !== undefined && puntaje_hasta !== '') {
        const ph = parseFloat(puntaje_hasta);
        if (!isNaN(ph)) {
            filtradas = filtradas.filter(f => {
                const p = parseFloat(f.puntaje);
                return !isNaN(p) && p <= ph;
            });
        }
    }
    if (buscar) {
        const b = buscar.toLowerCase();
        filtradas = filtradas.filter(f =>
            f.nombre_socio.toLowerCase().includes(b)   ||
            f.nombre_equino.toLowerCase().includes(b)  ||
            f.jurado.toLowerCase().includes(b)         ||
            f.club.toLowerCase().includes(b)           ||
            f.asociacion.toLowerCase().includes(b)     ||
            f.rut_socio.toLowerCase().includes(b)      ||
            f.nro_socio.toLowerCase().includes(b)
        );
    }

    return filtradas;
}

// ─── GET /api/admin/reportes/movimiento-rienda ────────────────────────────────

router.get('/', async (req, res) => {
    console.log('[reporte-rienda] GET / query:', req.query);
    try {
        const filas = await queryRienda(req.query);
        console.log(`[reporte-rienda] GET / → ${filas.length} registros`);
        res.json(filas);
    } catch (e) {
        console.error('[reporte-rienda] ERROR:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── GET /api/admin/reportes/movimiento-rienda/exportar ──────────────────────

router.get('/exportar', async (req, res) => {
    try {
        const filas = await queryRienda(req.query);
        if (filas.length === 0) {
            return res.status(404).json({ error: 'No hay datos para exportar con los filtros indicados.' });
        }

        const COLS = [
            'Fecha Rodeo', 'Club', 'Asociación', 'Tipo Rodeo', 'Estado Cartilla', 'Fecha Envío',
            'Jurado', 'Categoría Jurado',
            'Categoría Rienda', 'Sistema',
            'Nombre Socio', 'RUT Socio', 'N° Socio',
            'Nombre Equino', 'N° Inscripción Equino', 'Puntaje',
            'Observaciones Finales', 'ID Asignación'
        ];
        const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

        const lineas = [
            '﻿' + COLS.map(esc).join(';'),
            ...filas.map(f => [
                f.fecha_rodeo, f.club, f.asociacion, f.tipo_rodeo, f.estado_cartilla, f.fecha_envio,
                f.jurado, f.categoria_jurado,
                f.categoria_rienda, f.sistema,
                f.nombre_socio, f.rut_socio, f.nro_socio,
                f.nombre_equino, f.nro_inscripcion, f.puntaje,
                f.observaciones_finales, f.asignacion_id
            ].map(esc).join(';'))
        ];

        const ts = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="reporte_movimiento_rienda_${ts}.csv"`);
        res.send(lineas.join('\r\n'));
    } catch (e) {
        console.error('[reporte-rienda] ERROR exportar:', e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
