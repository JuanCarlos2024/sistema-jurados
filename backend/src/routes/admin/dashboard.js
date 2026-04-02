const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');

// GET /api/admin/dashboard
router.get('/', async (req, res) => {
    const ahora = new Date();
    const año = ahora.getFullYear();
    const mes = ahora.getMonth() + 1;
    const inicioMes = `${año}-${String(mes).padStart(2, '0')}-01`;
    const finMes = new Date(año, mes, 0).toISOString().split('T')[0];

    try {
        // Contadores en paralelo
        const [
            { count: totalJurados },
            { count: totalDelegados },
            { count: totalAdmins },
            { count: rodeosMes },
            { count: asignacionesMes },
            { count: bonosPendientes },
            { count: bonosAprobados },
            { count: perfilesIncompletos },
            { count: pendientesRevision },
            { count: duplicados }
        ] = await Promise.all([
            supabase.from('usuarios_pagados').select('id', { count: 'exact', head: true }).eq('tipo_persona', 'jurado').eq('activo', true),
            supabase.from('usuarios_pagados').select('id', { count: 'exact', head: true }).eq('tipo_persona', 'delegado_rentado').eq('activo', true),
            supabase.from('administradores').select('id', { count: 'exact', head: true }).eq('activo', true),
            supabase.from('rodeos').select('id', { count: 'exact', head: true }).eq('estado', 'activo').gte('fecha', inicioMes).lte('fecha', finMes),
            supabase.from('asignaciones').select('id', { count: 'exact', head: true }).eq('estado', 'activo')
                .gte('created_at', inicioMes + 'T00:00:00').lte('created_at', finMes + 'T23:59:59'),
            supabase.from('bonos_solicitados').select('id', { count: 'exact', head: true }).eq('estado', 'pendiente'),
            supabase.from('bonos_solicitados').select('id', { count: 'exact', head: true }).in('estado', ['aprobado', 'modificado']),
            supabase.from('usuarios_pagados').select('id', { count: 'exact', head: true }).eq('activo', true).eq('perfil_completo', false),
            supabase.from('importaciones_pendientes').select('id', { count: 'exact', head: true }).eq('estado', 'pendiente').neq('problema', 'duplicado'),
            supabase.from('importaciones_pendientes').select('id', { count: 'exact', head: true }).eq('estado', 'pendiente').eq('problema', 'duplicado')
        ]);

        // Total bruto del mes (suma de pago_base_calculado de asignaciones activas del mes)
        const { data: asigMes } = await supabase
            .from('asignaciones')
            .select('pago_base_calculado')
            .eq('estado', 'activo')
            .gte('created_at', inicioMes + 'T00:00:00')
            .lte('created_at', finMes + 'T23:59:59');

        const totalBrutoMes = (asigMes || []).reduce((s, a) => s + (a.pago_base_calculado || 0), 0);

        // Últimas importaciones
        const { data: ultimasImportaciones } = await supabase
            .from('importaciones')
            .select('id, nombre_archivo, insertadas, pendientes, duplicadas, created_at')
            .order('created_at', { ascending: false })
            .limit(5);

        // Últimos bonos pendientes (para mostrar en dashboard)
        const { data: ultBonosPend } = await supabase
            .from('bonos_solicitados')
            .select(`
                id, monto_solicitado, distancia_declarada, created_at,
                usuarios_pagados(nombre_completo),
                asignaciones(rodeos(club, fecha))
            `)
            .eq('estado', 'pendiente')
            .order('created_at', { ascending: false })
            .limit(10);

        res.json({
            totales: {
                jurados: totalJurados,
                delegados_rentados: totalDelegados,
                administradores: totalAdmins
            },
            mes_actual: {
                año,
                mes,
                rodeos: rodeosMes,
                asignaciones: asignacionesMes,
                bruto_total: totalBrutoMes
            },
            alertas: {
                bonos_pendientes: bonosPendientes,
                bonos_aprobados: bonosAprobados,
                perfiles_incompletos: perfilesIncompletos,
                pendientes_revision: pendientesRevision,
                duplicados_detectados: duplicados
            },
            ultimas_importaciones: ultimasImportaciones,
            bonos_pendientes_recientes: ultBonosPend
        });

    } catch (err) {
        res.status(500).json({ error: 'Error al cargar dashboard: ' + err.message });
    }
});

// GET /api/admin/dashboard/auditoria?page=&limit=&accion=&tabla=
router.get('/auditoria', async (req, res) => {
    const { page = 1, limit = 50, accion, tabla, actor_id } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
        .from('auditoria')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + parseInt(limit) - 1);

    if (accion) query = query.eq('accion', accion);
    if (tabla) query = query.eq('tabla', tabla);
    if (actor_id) query = query.eq('actor_id', actor_id);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ data, total: count });
});

module.exports = router;
