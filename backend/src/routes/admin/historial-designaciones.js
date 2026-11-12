/**
 * Historial Unificado de Designaciones — SOLO LECTURA.
 *
 *   GET /api/admin/historial-designaciones            → reporte (pantalla)
 *   GET /api/admin/historial-designaciones/exportar   → mismo reporte en Excel (3 hojas)
 *   GET /api/admin/historial-designaciones/rodeo/:id  → línea de tiempo de un rodeo
 *                                                       (Rodeos y Propuesta usan este mismo endpoint)
 *   GET /api/admin/historial-designaciones/catalogos  → tipos de evento y orígenes (filtros)
 *
 * Todas las variantes usan obtenerHistorialDesignaciones() — una sola fuente.
 * Permisos: administrador pleno y Director (lectura para el Directorio).
 */
const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const { soloRolEvaluacion } = require('../../middleware/auth');
const { obtenerHistorialDesignaciones, TIPOS, ORIGEN } = require('../../services/historialDesignaciones');
const { construirLibroHistorial } = require('../../services/historialDesignacionesExport');

router.use(soloRolEvaluacion('director'));

const FILTROS = ['temporada_id', 'fecha_desde', 'fecha_hasta', 'asociacion', 'club', 'jurado_id', 'propuesta_id', 'tipo_movimiento', 'origen'];
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

function leerFiltros(query) {
    const f = {};
    for (const k of FILTROS) {
        const v = typeof query[k] === 'string' ? query[k].trim() : '';
        if (v) f[k] = v;
    }
    for (const k of ['fecha_desde', 'fecha_hasta']) {
        if (f[k] && !FECHA_RE.test(f[k])) return { error: `${k} debe tener formato AAAA-MM-DD` };
    }
    if (f.tipo_movimiento && !TIPOS[f.tipo_movimiento]) return { error: 'tipo_movimiento inválido' };
    if (f.origen && !Object.values(ORIGEN).includes(f.origen)) return { error: 'origen inválido' };
    return { filtros: f };
}

async function describirFiltros(f) {
    const partes = [];
    if (f.temporada_id) {
        const { data } = await supabase.from('temporadas').select('nombre').eq('id', f.temporada_id).maybeSingle();
        partes.push(`Temporada: ${data?.nombre || f.temporada_id}`);
    }
    if (f.fecha_desde || f.fecha_hasta) {
        const fmt = x => (x ? x.split('-').reverse().join('/') : '…');
        partes.push(`Rodeos del ${fmt(f.fecha_desde)} al ${fmt(f.fecha_hasta)} (con todo su historial)`);
    }
    if (f.asociacion) partes.push(`Asociación contiene "${f.asociacion}"`);
    if (f.club) partes.push(`Club contiene "${f.club}"`);
    if (f.jurado_id) {
        const { data } = await supabase.from('usuarios_pagados').select('nombre_completo').eq('id', f.jurado_id).maybeSingle();
        partes.push(`Jurado: ${data?.nombre_completo || f.jurado_id}`);
    }
    if (f.propuesta_id) partes.push(`Propuesta: ${f.propuesta_id}`);
    if (f.tipo_movimiento) partes.push(`Tipo de movimiento: ${TIPOS[f.tipo_movimiento]}`);
    if (f.origen) partes.push(`Origen: ${f.origen}`);
    return partes.length ? partes.join(' · ') : 'Sin filtros (todos los rodeos)';
}

router.get('/catalogos', (req, res) => {
    res.json({
        tipos: Object.entries(TIPOS).map(([codigo, etiqueta]) => ({ codigo, etiqueta })),
        origenes: Object.values(ORIGEN),
    });
});

router.get('/', async (req, res) => {
    const { filtros, error } = leerFiltros(req.query);
    if (error) return res.status(400).json({ error });
    try {
        res.json(await obtenerHistorialDesignaciones(filtros));
    } catch (err) {
        res.status(500).json({ error: 'No se pudo obtener el historial: ' + err.message });
    }
});

router.get('/exportar', async (req, res) => {
    const { filtros, error } = leerFiltros(req.query);
    if (error) return res.status(400).json({ error });
    try {
        const historial = await obtenerHistorialDesignaciones(filtros);
        const wb = construirLibroHistorial(historial, { descripcionFiltros: await describirFiltros(filtros) });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=historial_designaciones.xlsx');
        await wb.xlsx.write(res);
    } catch (err) {
        if (!res.headersSent) res.status(500).json({ error: 'No se pudo generar el Excel: ' + err.message });
    }
});

router.get('/rodeo/:rodeoId', async (req, res) => {
    try {
        const r = await obtenerHistorialDesignaciones({ rodeo_ids: [req.params.rodeoId] });
        if (r.rodeos.length === 0) return res.status(404).json({ error: 'Rodeo no encontrado' });
        res.json({ ...r.rodeos[0], propuesta_original: r.propuesta_original });
    } catch (err) {
        res.status(500).json({ error: 'No se pudo obtener el historial del rodeo: ' + err.message });
    }
});

module.exports = router;
module.exports._leerFiltros = leerFiltros;
