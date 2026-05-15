const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');

const _SELECT_BANCO = `
    id, caso_id, evaluacion_id, ciclo_numero, tipo_caso, descripcion_caso,
    video_url, estado_caso, resolucion_final, comentario_banco, activo, created_at, updated_at,
    evaluacion:evaluaciones(
        id,
        rodeo:rodeos(id, club, asociacion, fecha, tipo_rodeo_nombre)
    ),
    guardado_por_admin:administradores!guardado_por(id, nombre_completo)
`;

const TIPO_LABELS = {
    interpretativa: 'Apreciación',
    reglamentaria:  'Reglamentaria',
    informativo:    'Conceptual'
};

function _aplicarFiltros(lista, { asociacion, club, buscar }) {
    let r = lista;
    if (asociacion) {
        const a = asociacion.toLowerCase();
        r = r.filter(x => x.evaluacion?.rodeo?.asociacion?.toLowerCase().includes(a));
    }
    if (club) {
        const c = club.toLowerCase();
        r = r.filter(x => x.evaluacion?.rodeo?.club?.toLowerCase().includes(c));
    }
    if (buscar) {
        const b = buscar.toLowerCase();
        r = r.filter(x =>
            x.descripcion_caso?.toLowerCase().includes(b) ||
            x.comentario_banco?.toLowerCase().includes(b) ||
            x.evaluacion?.rodeo?.club?.toLowerCase().includes(b) ||
            x.evaluacion?.rodeo?.asociacion?.toLowerCase().includes(b)
        );
    }
    return r;
}

// GET / — listado con filtros
router.get('/', async (req, res) => {
    const { tipo_caso, asociacion, club, buscar, desde, hasta, guardado_por, activo } = req.query;

    let q = supabase
        .from('evaluacion_banco_situaciones')
        .select(_SELECT_BANCO)
        .order('created_at', { ascending: false });

    if (activo !== undefined && activo !== '') q = q.eq('activo', activo === 'true');
    if (tipo_caso)    q = q.eq('tipo_caso', tipo_caso);
    if (desde)        q = q.gte('created_at', desde);
    if (hasta)        q = q.lte('created_at', hasta + 'T23:59:59Z');
    if (guardado_por) q = q.eq('guardado_por', guardado_por);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    res.json(_aplicarFiltros(data || [], { asociacion, club, buscar }));
});

// GET /exportar — descarga CSV respetando filtros
router.get('/exportar', async (req, res) => {
    const { tipo_caso, asociacion, club, buscar, desde, hasta, guardado_por, activo } = req.query;

    let q = supabase
        .from('evaluacion_banco_situaciones')
        .select(_SELECT_BANCO)
        .order('created_at', { ascending: false });

    if (activo !== undefined && activo !== '') q = q.eq('activo', activo === 'true');
    if (tipo_caso)    q = q.eq('tipo_caso', tipo_caso);
    if (desde)        q = q.gte('created_at', desde);
    if (hasta)        q = q.lte('created_at', hasta + 'T23:59:59Z');
    if (guardado_por) q = q.eq('guardado_por', guardado_por);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    const resultado = _aplicarFiltros(data || [], { asociacion, club, buscar });

    const esc = (v) => {
        if (v == null || v === '') return '';
        const s = String(v).replace(/"/g, '""');
        return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s}"` : s;
    };

    const headers = [
        'ID Situación Banco', 'ID Evaluación', 'ID Caso',
        'Fecha Guardado', 'Guardado Por',
        'Club', 'Asociación', 'Fecha Rodeo', 'Tipo Rodeo',
        'Ciclo', 'Tipo Caso', 'Descripción del Caso',
        'Comentario Banco', 'Link Video',
        'Estado Caso', 'Resolución Final', 'Estado Banco'
    ];

    const rows = resultado.map(r => [
        r.id,
        r.evaluacion_id,
        r.caso_id,
        r.created_at ? new Date(r.created_at).toLocaleDateString('es-CL') : '',
        r.guardado_por_admin?.nombre_completo || '',
        r.evaluacion?.rodeo?.club            || '',
        r.evaluacion?.rodeo?.asociacion      || '',
        r.evaluacion?.rodeo?.fecha           || '',
        r.evaluacion?.rodeo?.tipo_rodeo_nombre || '',
        r.ciclo_numero ? `Ciclo ${r.ciclo_numero}` : '',
        TIPO_LABELS[r.tipo_caso] || r.tipo_caso || '',
        r.descripcion_caso || '',
        r.comentario_banco || '',
        r.video_url        || 'Sin video',
        r.estado_caso      || '',
        r.resolucion_final || '',
        r.activo ? 'Activo' : 'Inactivo'
    ].map(esc).join(','));

    const csv = '﻿' + [headers.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="banco-situaciones.csv"');
    res.send(csv);
});

// GET /:id — detalle de una situación
router.get('/:id', async (req, res) => {
    const { data, error } = await supabase
        .from('evaluacion_banco_situaciones')
        .select(_SELECT_BANCO)
        .eq('id', req.params.id)
        .single();

    if (error) return res.status(404).json({ error: 'No encontrado' });
    res.json(data);
});

// PATCH /:id — activar / desactivar del banco
router.patch('/:id', async (req, res) => {
    const { activo } = req.body;
    if (activo === undefined) return res.status(400).json({ error: 'activo requerido' });

    const { data, error } = await supabase
        .from('evaluacion_banco_situaciones')
        .update({ activo: !!activo, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

module.exports = router;
