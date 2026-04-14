const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');

/**
 * Obtiene el mes y año actual en zona horaria de Chile (America/Santiago).
 * Evita el error de UTC que adelanta el mes cuando son >21hs en Chile.
 */
function fechaChile() {
    const partes = new Intl.DateTimeFormat('es-CL', {
        timeZone: 'America/Santiago',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date());
    const p = {};
    partes.forEach(({ type, value }) => { p[type] = value; });
    return { año: parseInt(p.year), mes: parseInt(p.month) };
}

// GET /api/admin/dashboard?mes=&año=
router.get('/', async (req, res) => {
    const hoy = fechaChile();
    const año = req.query.año ? parseInt(req.query.año) : hoy.año;
    const mes = req.query.mes ? parseInt(req.query.mes) : hoy.mes;
    const inicioMes = `${año}-${String(mes).padStart(2, '0')}-01`;
    const finMes = new Date(año, mes, 0).toISOString().split('T')[0];

    try {
        // ── Contadores globales y alertas (en paralelo) ─────────────────
        const [
            { count: totalJurados },
            { count: totalDelegados },
            { count: bonosPendientes },
            { count: perfilesIncompletos },
            { count: pendientesRevision },
            { count: duplicados }
        ] = await Promise.all([
            supabase.from('usuarios_pagados').select('id', { count: 'exact', head: true })
                .eq('tipo_persona', 'jurado').eq('activo', true),
            supabase.from('usuarios_pagados').select('id', { count: 'exact', head: true })
                .eq('tipo_persona', 'delegado_rentado').eq('activo', true),
            supabase.from('bonos_solicitados').select('id', { count: 'exact', head: true })
                .eq('estado', 'pendiente'),
            supabase.from('usuarios_pagados').select('id', { count: 'exact', head: true })
                .eq('activo', true).eq('perfil_completo', false),
            // Solo los que siguen pendientes de resolución real
            supabase.from('importaciones_pendientes').select('id', { count: 'exact', head: true })
                .eq('estado', 'pendiente').neq('problema', 'duplicado'),
            supabase.from('importaciones_pendientes').select('id', { count: 'exact', head: true })
                .eq('estado', 'pendiente').eq('problema', 'duplicado')
        ]);

        // ── Rodeos del mes (por fecha del rodeo) ────────────────────────
        const { count: rodeosMes } = await supabase
            .from('rodeos')
            .select('id', { count: 'exact', head: true })
            .eq('estado', 'activo')
            .gte('fecha', inicioMes)
            .lte('fecha', finMes);

        // ── Asignaciones del mes (por fecha del rodeo, no created_at) ───
        // Inner join garantiza que solo trae asignaciones cuyo rodeo está en el rango
        // estado_designacion: null = aceptado (compat. migración 002), 'pendiente', 'aceptado', 'rechazado'
        const { data: asigsMes } = await supabase
            .from('asignaciones')
            .select('id, tipo_persona, pago_base_calculado, estado_designacion, rodeos!inner(fecha)')
            .eq('estado', 'activo')
            .gte('rodeos.fecha', inicioMes)
            .lte('rodeos.fecha', finMes);

        const asigs = asigsMes || [];
        const asigJurados    = asigs.filter(a => a.tipo_persona === 'jurado');
        const asigDelegados  = asigs.filter(a => a.tipo_persona === 'delegado_rentado');

        const baseJurados   = asigJurados.reduce((s, a) => s + (a.pago_base_calculado || 0), 0);
        const baseDelegados = asigDelegados.reduce((s, a) => s + (a.pago_base_calculado || 0), 0);

        // ── Contadores de estado de designación por tipo ─────────────────
        // Confirmado = aceptado explícito O null (retrocompat. pre-migración 009)
        // Rechazado  = excluido de ambos conteos
        const esConfirmado = (a) => a.estado_designacion === 'aceptado' || a.estado_designacion === null;
        const esPendiente  = (a) => a.estado_designacion === 'pendiente';

        const juradosPendientes    = asigJurados.filter(esPendiente).length;
        const juradosConfirmados   = asigJurados.filter(esConfirmado).length;
        const delegadosPendientes  = asigDelegados.filter(esPendiente).length;
        const delegadosConfirmados = asigDelegados.filter(esConfirmado).length;

        console.log(`[DASHBOARD] ${año}-${String(mes).padStart(2,'0')} designaciones: jurados_pend=${juradosPendientes} jurados_conf=${juradosConfirmados} deleg_pend=${delegadosPendientes} deleg_conf=${delegadosConfirmados}`);

        // ── Bonos aprobados del mes ─────────────────────────────────────
        let bonosJurados = 0;
        let bonosDelegados = 0;

        if (asigs.length > 0) {
            const asigIds = asigs.map(a => a.id);
            // Mapa tipo_persona por id (para clasificar bonos)
            const tipoMap = {};
            asigs.forEach(a => { tipoMap[a.id] = a.tipo_persona; });

            const { data: bonosMes } = await supabase
                .from('bonos_solicitados')
                .select('asignacion_id, monto_aprobado, monto_solicitado')
                .in('asignacion_id', asigIds)
                .in('estado', ['aprobado', 'modificado']);

            (bonosMes || []).forEach(b => {
                const monto = b.monto_aprobado || b.monto_solicitado || 0;
                if (tipoMap[b.asignacion_id] === 'jurado') bonosJurados += monto;
                else bonosDelegados += monto;
            });
        }

        // ── Retención vigente ───────────────────────────────────────────
        let retencionPct = 0;
        try {
            const { data: ret } = await supabase
                .from('configuracion_retencion')
                .select('porcentaje')
                .limit(1)
                .single();
            retencionPct = ret ? parseFloat(ret.porcentaje) : 0;
        } catch(e) { retencionPct = 0; }

        // ── Cálculos derivados ──────────────────────────────────────────
        const brutoJurados   = baseJurados   + bonosJurados;
        const brutoDelegados = baseDelegados + bonosDelegados;
        const brutoBase      = baseJurados   + baseDelegados;
        const brutoBonos     = bonosJurados  + bonosDelegados;
        const brutoTotal     = brutoJurados  + brutoDelegados;

        const liquidoJurados   = Math.round(brutoJurados   * (1 - retencionPct / 100));
        const liquidoDelegados = Math.round(brutoDelegados * (1 - retencionPct / 100));
        const liquidoTotal     = Math.round(brutoTotal     * (1 - retencionPct / 100));

        // ── Importaciones del mes (con conteo real de pendientes) ───────
        const { data: importacionesMes } = await supabase
            .from('importaciones')
            .select('id, nombre_archivo, insertadas, duplicadas, created_at')
            .gte('created_at', inicioMes + 'T00:00:00')
            .lte('created_at', finMes + 'T23:59:59')
            .order('created_at', { ascending: false })
            .limit(10);

        // Conteo real de pendientes por importacion (no el snapshot)
        let pendientesPorImportacion = {};
        if (importacionesMes && importacionesMes.length > 0) {
            const impIds = importacionesMes.map(i => i.id);
            const { data: realPend } = await supabase
                .from('importaciones_pendientes')
                .select('importacion_id')
                .in('importacion_id', impIds)
                .eq('estado', 'pendiente');
            (realPend || []).forEach(p => {
                pendientesPorImportacion[p.importacion_id] =
                    (pendientesPorImportacion[p.importacion_id] || 0) + 1;
            });
        }

        const ultimasImportaciones = (importacionesMes || []).map(i => ({
            ...i,
            pendientes_reales: pendientesPorImportacion[i.id] || 0
        }));

        // ── Cartillas y videos del mes ──────────────────────────────────
        // Rodeos activos del mes
        const { data: rodeosDelMes } = await supabase
            .from('rodeos')
            .select('id')
            .eq('estado', 'activo')
            .gte('fecha', inicioMes)
            .lte('fecha', finMes);

        const rodeoIdsDelMes = (rodeosDelMes || []).map(r => r.id);
        let cartillasJurado = 0, cartillasDelegado = 0, videosCount = 0;

        if (rodeoIdsDelMes.length > 0) {
            const [
                { data: adjuntosJurado },
                { data: adjuntosDelegado },
                { data: links }
            ] = await Promise.all([
                supabase.from('rodeo_adjuntos').select('rodeo_id')
                    .in('rodeo_id', rodeoIdsDelMes)
                    .in('tipo_adjunto', ['cartilla_jurado', 'cartilla']),
                supabase.from('rodeo_adjuntos').select('rodeo_id')
                    .in('rodeo_id', rodeoIdsDelMes)
                    .eq('tipo_adjunto', 'cartilla_delegado'),
                supabase.from('rodeo_links').select('rodeo_id')
                    .in('rodeo_id', rodeoIdsDelMes)
            ]);
            cartillasJurado  = new Set((adjuntosJurado  || []).map(a => a.rodeo_id)).size;
            cartillasDelegado = new Set((adjuntosDelegado || []).map(a => a.rodeo_id)).size;
            videosCount      = new Set((links            || []).map(a => a.rodeo_id)).size;
        }

        const rodeosTotalesMes = rodeoIdsDelMes.length;

        // ── Bonos pendientes recientes (global) ─────────────────────────
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
            // Contexto del mes consultado
            periodo: { año, mes, inicioMes, finMes },

            // KPIs globales (independientes del mes)
            totales: {
                jurados: totalJurados,
                delegados_rentados: totalDelegados
            },

            // Actividad del mes
            actividad: {
                rodeos: rodeosMes || 0,
                asignaciones_total: asigs.length,
                asignaciones_jurados: asigJurados.length,
                asignaciones_delegados: asigDelegados.length,
                // Desglose por estado de designación (rechazados excluidos de ambos conteos)
                jurados_pendientes:    juradosPendientes,
                jurados_confirmados:   juradosConfirmados,
                delegados_pendientes:  delegadosPendientes,
                delegados_confirmados: delegadosConfirmados
            },

            // Montos brutos del mes
            brutos: {
                jurados: { base: baseJurados, bonos: bonosJurados, total: brutoJurados },
                delegados: { base: baseDelegados, bonos: bonosDelegados, total: brutoDelegados },
                combinado: { base: brutoBase, bonos: brutoBonos, total: brutoTotal }
            },

            // Montos líquidos del mes
            liquidos: {
                retencion_pct: retencionPct,
                jurados: liquidoJurados,
                delegados: liquidoDelegados,
                total: liquidoTotal
            },

            // Alertas (globales)
            alertas: {
                bonos_pendientes: bonosPendientes,
                perfiles_incompletos: perfilesIncompletos,
                pendientes_revision: pendientesRevision,
                duplicados_detectados: duplicados
            },

            // Cartillas y videos del mes (rodeos con al menos 1 adjunto/link)
            cartillas_videos: {
                rodeos_del_mes:         rodeosTotalesMes,
                con_cartilla_jurado:    cartillasJurado,
                sin_cartilla_jurado:    rodeosTotalesMes - cartillasJurado,
                con_cartilla_delegado:  cartillasDelegado,
                sin_cartilla_delegado:  rodeosTotalesMes - cartillasDelegado,
                con_video:              videosCount,
                sin_video:              rodeosTotalesMes - videosCount
            },

            ultimas_importaciones: ultimasImportaciones,
            bonos_pendientes_recientes: ultBonosPend
        });

    } catch (err) {
        console.error('[DASHBOARD]', err);
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
