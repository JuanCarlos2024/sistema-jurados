/**
 * Rutas de reportes para administradores.
 * Todos los reportes usan valores históricos guardados en asignaciones
 * (pago_base_calculado, valor_diario_aplicado, categoria_aplicada) —
 * no recalculan con tarifas actuales.
 * Solo bonos con estado 'aprobado' o 'modificado' suman al bruto.
 */

const express = require('express');
const router  = express.Router();
const supabase = require('../../config/supabase');
const { obtenerRetencion } = require('../../services/calculo');

// ─── Helper: construir rango de fechas desde filtros ──────────
function buildRango(año, mes, fechaDesde, fechaHasta) {
    const añoNum = parseInt(año);
    const mesNum = parseInt(mes);

    if (fechaDesde && fechaHasta) {
        return { inicio: fechaDesde, fin: fechaHasta };
    }
    if (!isNaN(añoNum) && !isNaN(mesNum) && mesNum >= 1 && mesNum <= 12) {
        return {
            inicio: `${añoNum}-${String(mesNum).padStart(2, '0')}-01`,
            fin:    new Date(añoNum, mesNum, 0).toISOString().split('T')[0]
        };
    }
    if (!isNaN(añoNum)) {
        return { inicio: `${añoNum}-01-01`, fin: `${añoNum}-12-31` };
    }
    return null; // sin filtro de fecha
}

// ─── Query base de asignaciones con filtros ───────────────────
async function queryAsignaciones(filtros) {
    const { año, mes, fechaDesde, fechaHasta, usuario_pagado_id, categoria, asociacion, club, tipo_rodeo_id, categoria_rodeo_id } = filtros;

    let q = supabase
        .from('asignaciones')
        .select(`
            id, tipo_persona, categoria_aplicada, valor_diario_aplicado,
            duracion_dias_aplicada, pago_base_calculado, estado,
            estado_designacion, distancia_km, nombre_importado, created_at,
            usuarios_pagados(id, codigo_interno, nombre_completo, rut, categoria, tipo_persona),
            rodeos!inner(id, club, asociacion, fecha, tipo_rodeo_nombre, duracion_dias, tipo_rodeo_id, categoria_rodeo_nombre)
        `)
        .eq('estado', 'activo');

    const rango = buildRango(año, mes, fechaDesde, fechaHasta);
    if (rango) {
        q = q.gte('rodeos.fecha', rango.inicio).lte('rodeos.fecha', rango.fin);
    }
    if (usuario_pagado_id)  q = q.eq('usuario_pagado_id', usuario_pagado_id);
    if (categoria)          q = q.eq('categoria_aplicada', categoria);
    if (asociacion)         q = q.ilike('rodeos.asociacion', `%${asociacion}%`);
    if (club)               q = q.ilike('rodeos.club', `%${club}%`);
    if (tipo_rodeo_id)      q = q.eq('rodeos.tipo_rodeo_id', tipo_rodeo_id);
    if (categoria_rodeo_id) q = q.eq('rodeos.categoria_rodeo_id', categoria_rodeo_id);

    const { data, error } = await q.order('rodeos(fecha)', { ascending: false });
    if (error) throw new Error('Error en query asignaciones: ' + error.message);
    return data || [];
}

// ─── Agregar bonos aprobados a asignaciones ───────────────────
async function agregarBonos(asignaciones) {
    if (!asignaciones.length) return asignaciones;
    const ids = asignaciones.map(a => a.id);
    const { data: bonos } = await supabase
        .from('bonos_solicitados')
        .select('asignacion_id, estado, monto_aprobado, monto_solicitado, distancia_declarada')
        .in('asignacion_id', ids);

    const bonoMap = {};
    (bonos || []).forEach(b => {
        if (!bonoMap[b.asignacion_id]) bonoMap[b.asignacion_id] = [];
        bonoMap[b.asignacion_id].push(b);
    });

    return asignaciones.map(a => {
        const bs = bonoMap[a.id] || [];
        const ultimo = bs[bs.length - 1] || null;
        // aprobado_auto tiene monto_aprobado=0, lo incluimos para consistencia (no suma al total)
        const bono_aprobado = bs
            .filter(b => ['aprobado', 'modificado', 'aprobado_auto'].includes(b.estado))
            .reduce((s, b) => s + (b.monto_aprobado || b.monto_solicitado || 0), 0);
        return { ...a, bonos: bs, ultimo_bono: ultimo, bono_aprobado };
    });
}

// ─── Calcular totales por jurado ──────────────────────────────
// Las asignaciones con estado_designacion='rechazado' no suman a totales
function calcularTotalesPorJurado(asignaciones, porcentajeRetencion) {
    const mapa = {};

    for (const a of asignaciones) {
        const u = a.usuarios_pagados;
        if (!u) continue;
        const uid = u.id;
        const esRechazada = a.estado_designacion === 'rechazado';
        if (!mapa[uid]) {
            mapa[uid] = {
                id:             uid,
                codigo_interno: u.codigo_interno,
                nombre_completo: u.nombre_completo,
                rut:            u.rut || '—',
                categoria:      u.categoria || '—',
                tipo_persona:   u.tipo_persona,
                cant_rodeos:    0,
                total_pago_base: 0,
                total_bono_aprobado: 0,
            };
        }
        if (!esRechazada) {
            mapa[uid].cant_rodeos++;
            mapa[uid].total_pago_base     += (a.pago_base_calculado || 0);
            mapa[uid].total_bono_aprobado += (a.bono_aprobado || 0);
        }
    }

    return Object.values(mapa).map(j => {
        const bruto     = j.total_pago_base + j.total_bono_aprobado;
        const retencion = Math.round(bruto * porcentajeRetencion / 100);
        return { ...j, bruto, retencion_monto: retencion, liquido: bruto - retencion };
    }).sort((a, b) => a.nombre_completo.localeCompare(b.nombre_completo));
}

// ══════════════════════════════════════════════════════════════
// GET /api/admin/reportes/resumen-mensual
// Resumen financiero agrupado por jurado
// ══════════════════════════════════════════════════════════════
router.get('/resumen-mensual', async (req, res) => {
    try {
        const { año, mes, fechaDesde, fechaHasta, categoria, asociacion, club, tipo_rodeo_id, categoria_rodeo_id } = req.query;
        const asignaciones = await queryAsignaciones({ año, mes, fechaDesde, fechaHasta, categoria, asociacion, club, tipo_rodeo_id, categoria_rodeo_id });
        const conBonos     = await agregarBonos(asignaciones);
        const porcentaje   = await obtenerRetencion();
        const totales      = calcularTotalesPorJurado(conBonos, porcentaje);

        const totalesGlobal = totales.reduce((acc, j) => ({
            cant_rodeos:         acc.cant_rodeos         + j.cant_rodeos,
            total_pago_base:     acc.total_pago_base     + j.total_pago_base,
            total_bono_aprobado: acc.total_bono_aprobado + j.total_bono_aprobado,
            bruto:               acc.bruto               + j.bruto,
            retencion_monto:     acc.retencion_monto     + j.retencion_monto,
            liquido:             acc.liquido             + j.liquido,
        }), { cant_rodeos:0, total_pago_base:0, total_bono_aprobado:0, bruto:0, retencion_monto:0, liquido:0 });

        res.json({ data: totales, totales_global: totalesGlobal, retencion_porcentaje: porcentaje, total: totales.length });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/reportes/detalle-jurado
// Detalle rodeo a rodeo de un jurado específico
// ══════════════════════════════════════════════════════════════
router.get('/detalle-jurado', async (req, res) => {
    try {
        const { usuario_pagado_id, año, mes, fechaDesde, fechaHasta, categoria_rodeo_id } = req.query;
        if (!usuario_pagado_id) return res.status(400).json({ error: 'usuario_pagado_id requerido' });

        const asignaciones = await queryAsignaciones({ usuario_pagado_id, año, mes, fechaDesde, fechaHasta, categoria_rodeo_id });
        const conBonos     = await agregarBonos(asignaciones);
        const porcentaje   = await obtenerRetencion();

        // Rechazados: visibles en historial pero con montos en 0 y marcados
        const filas = conBonos.map(a => {
            const esRechazada = a.estado_designacion === 'rechazado';
            const pago_base   = esRechazada ? 0 : (a.pago_base_calculado || 0);
            const bono_ap     = esRechazada ? 0 : (a.bono_aprobado || 0);
            const bruto       = pago_base + bono_ap;
            const retencion   = Math.round(bruto * porcentaje / 100);
            return {
                fecha:              a.rodeos?.fecha,
                club:               a.rodeos?.club,
                asociacion:         a.rodeos?.asociacion,
                tipo_rodeo:         a.rodeos?.tipo_rodeo_nombre,
                categoria_rodeo:    a.rodeos?.categoria_rodeo_nombre || null,
                duracion_dias:      a.duracion_dias_aplicada,
                categoria:          a.categoria_aplicada,
                estado_designacion: a.estado_designacion || null,
                distancia_km:       a.distancia_km || a.ultimo_bono?.distancia_declarada || null,
                pago_base,
                bono_aprobado:      bono_ap,
                estado_bono:        a.ultimo_bono?.estado || null,
                bruto,
                retencion_monto:    retencion,
                liquido:            bruto - retencion,
                excluido:           esRechazada,
            };
        });

        // Totales: solo filas no rechazadas
        const totales = filas.filter(f => !f.excluido).reduce((acc, f) => ({
            pago_base:     acc.pago_base     + f.pago_base,
            bono_aprobado: acc.bono_aprobado + f.bono_aprobado,
            bruto:         acc.bruto         + f.bruto,
            retencion:     acc.retencion     + f.retencion_monto,
            liquido:       acc.liquido       + f.liquido,
        }), { pago_base:0, bono_aprobado:0, bruto:0, retencion:0, liquido:0 });

        // Contar bonos aprobados/modificados por tramo de monto
        let bonos_35k = 0, bonos_50k = 0;
        for (const a of conBonos) {
            for (const b of (a.bonos || [])) {
                if (['aprobado', 'modificado'].includes(b.estado)) {
                    const m = b.monto_aprobado || b.monto_solicitado || 0;
                    if (m === 35000) bonos_35k++;
                    else if (m === 50000) bonos_50k++;
                }
            }
        }
        totales.bonos_35k = bonos_35k;
        totales.bonos_50k = bonos_50k;

        const { data: usr } = await supabase
            .from('usuarios_pagados')
            .select('codigo_interno, nombre_completo, rut, categoria, tipo_persona')
            .eq('id', usuario_pagado_id)
            .single();

        res.json({ jurado: usr, data: filas, totales, retencion_porcentaje: porcentaje });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/reportes/por-asociacion
// Agrupado por asociación
// ══════════════════════════════════════════════════════════════
router.get('/por-asociacion', async (req, res) => {
    try {
        const asignaciones = await queryAsignaciones(req.query);
        const conBonos     = await agregarBonos(asignaciones);

        const mapa = {};
        for (const a of conBonos) {
            const asoc = a.rodeos?.asociacion || 'Sin asociación';
            if (!mapa[asoc]) mapa[asoc] = { asociacion: asoc, cant_rodeos: new Set(), cant_jurados: 0, total_pago_base: 0, total_bono_aprobado: 0 };
            mapa[asoc].cant_rodeos.add(a.rodeos?.id);
            mapa[asoc].cant_jurados++;
            mapa[asoc].total_pago_base     += (a.pago_base_calculado || 0);
            mapa[asoc].total_bono_aprobado += (a.bono_aprobado || 0);
        }

        const data = Object.values(mapa).map(a => ({
            ...a,
            cant_rodeos:  a.cant_rodeos.size,
            total_bruto:  a.total_pago_base + a.total_bono_aprobado,
        })).sort((a, b) => b.total_bruto - a.total_bruto);

        res.json({ data, total: data.length });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/reportes/por-club
// Agrupado por club
// ══════════════════════════════════════════════════════════════
router.get('/por-club', async (req, res) => {
    try {
        const asignaciones = await queryAsignaciones(req.query);
        const conBonos     = await agregarBonos(asignaciones);

        const mapa = {};
        for (const a of conBonos) {
            const club = a.rodeos?.club || 'Sin club';
            const asoc = a.rodeos?.asociacion || '—';
            const key  = club + '|' + asoc;
            if (!mapa[key]) mapa[key] = { club, asociacion: asoc, cant_rodeos: new Set(), cant_jurados: 0, total_pago_base: 0, total_bono_aprobado: 0 };
            mapa[key].cant_rodeos.add(a.rodeos?.id);
            mapa[key].cant_jurados++;
            mapa[key].total_pago_base     += (a.pago_base_calculado || 0);
            mapa[key].total_bono_aprobado += (a.bono_aprobado || 0);
        }

        const data = Object.values(mapa).map(c => ({
            ...c,
            cant_rodeos: c.cant_rodeos.size,
            total_bruto: c.total_pago_base + c.total_bono_aprobado,
        })).sort((a, b) => b.total_bruto - a.total_bruto);

        res.json({ data, total: data.length });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/reportes/por-tipo-rodeo
// Agrupado por tipo de rodeo
// ══════════════════════════════════════════════════════════════
router.get('/por-tipo-rodeo', async (req, res) => {
    try {
        const asignaciones = await queryAsignaciones(req.query);
        const conBonos     = await agregarBonos(asignaciones);

        const mapa = {};
        for (const a of conBonos) {
            const tipo = a.rodeos?.tipo_rodeo_nombre || '—';
            if (!mapa[tipo]) mapa[tipo] = { tipo_rodeo: tipo, cant_rodeos: new Set(), cant_jurados: 0, total_pago_base: 0, total_bono_aprobado: 0 };
            mapa[tipo].cant_rodeos.add(a.rodeos?.id);
            mapa[tipo].cant_jurados++;
            mapa[tipo].total_pago_base     += (a.pago_base_calculado || 0);
            mapa[tipo].total_bono_aprobado += (a.bono_aprobado || 0);
        }

        const data = Object.values(mapa).map(t => ({
            ...t,
            cant_rodeos: t.cant_rodeos.size,
            total_bruto: t.total_pago_base + t.total_bono_aprobado,
        })).sort((a, b) => b.cant_rodeos - a.cant_rodeos);

        res.json({ data, total: data.length });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/reportes/detalle-asociacion?asociacion=...
// Rodeos de una asociación específica con sus jurados
// ══════════════════════════════════════════════════════════════
router.get('/detalle-asociacion', async (req, res) => {
    try {
        const { asociacion, año, mes, fechaDesde, fechaHasta } = req.query;
        if (!asociacion) return res.status(400).json({ error: 'asociacion requerida' });

        const asignaciones = await queryAsignaciones({ asociacion, año, mes, fechaDesde, fechaHasta });
        const conBonos     = await agregarBonos(asignaciones);

        // Agrupar por rodeo
        const rodeoMap = {};
        for (const a of conBonos) {
            const rid = a.rodeos?.id;
            if (!rid) continue;
            if (!rodeoMap[rid]) {
                rodeoMap[rid] = {
                    rodeo_id: rid,
                    club:          a.rodeos?.club,
                    fecha:         a.rodeos?.fecha,
                    tipo_rodeo:    a.rodeos?.tipo_rodeo_nombre,
                    duracion_dias: a.rodeos?.duracion_dias,
                    personas: [],
                    total_pago_base: 0,
                    total_bono_aprobado: 0
                };
            }
            rodeoMap[rid].personas.push({
                nombre:    a.usuarios_pagados?.nombre_completo || a.nombre_importado || '—',
                tipo:      a.tipo_persona,
                categoria: a.categoria_aplicada,
                pago_base: a.pago_base_calculado || 0,
                bono:      a.bono_aprobado || 0
            });
            rodeoMap[rid].total_pago_base     += (a.pago_base_calculado || 0);
            rodeoMap[rid].total_bono_aprobado += (a.bono_aprobado || 0);
        }

        const data = Object.values(rodeoMap)
            .map(r => ({ ...r, total_bruto: r.total_pago_base + r.total_bono_aprobado }))
            .sort((a, b) => b.fecha.localeCompare(a.fecha));

        res.json({ asociacion, data, total: data.length });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/reportes/por-jurado
// Lista todos los jurados con su conteo de rodeos y total
// ══════════════════════════════════════════════════════════════
router.get('/por-jurado', async (req, res) => {
    try {
        const asignaciones = await queryAsignaciones(req.query);
        const conBonos     = await agregarBonos(asignaciones);
        const porcentaje   = await obtenerRetencion();
        const data         = calcularTotalesPorJurado(conBonos, porcentaje);
        res.json({ data, total: data.length, retencion_porcentaje: porcentaje });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/reportes/por-categoria-rodeo
// Agrupado por categoría de rodeo
// ══════════════════════════════════════════════════════════════
router.get('/por-categoria-rodeo', async (req, res) => {
    try {
        const asignaciones = await queryAsignaciones(req.query);
        const conBonos     = await agregarBonos(asignaciones);

        const mapa = {};
        for (const a of conBonos) {
            const esRechazada = a.estado_designacion === 'rechazado';
            const cat  = a.rodeos?.categoria_rodeo_nombre || 'Sin categoría';
            if (!mapa[cat]) mapa[cat] = { categoria: cat, cant_rodeos: new Set(), cant_asignaciones: 0, total_pago_base: 0, total_bono_aprobado: 0 };
            mapa[cat].cant_rodeos.add(a.rodeos?.id);
            if (!esRechazada) {
                mapa[cat].cant_asignaciones++;
                mapa[cat].total_pago_base     += (a.pago_base_calculado || 0);
                mapa[cat].total_bono_aprobado += (a.bono_aprobado || 0);
            }
        }

        const data = Object.values(mapa).map(c => ({
            ...c,
            cant_rodeos:  c.cant_rodeos.size,
            total_bruto:  c.total_pago_base + c.total_bono_aprobado,
        })).sort((a, b) => b.total_bruto - a.total_bruto);

        res.json({ data, total: data.length });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/reportes/categorias-rodeo/lista
// ══════════════════════════════════════════════════════════════
router.get('/categorias-rodeo/lista', async (req, res) => {
    const { activo } = req.query;
    let q = supabase.from('categorias_rodeo').select('*').order('nombre');
    if (activo !== undefined) q = q.eq('activo', activo === 'true');
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/reportes/bonos-por-persona
// Listado de bonos filtrable por persona, tipo, asociación, fecha, estado
// ══════════════════════════════════════════════════════════════
router.get('/bonos-por-persona', async (req, res) => {
    try {
        const { tipo_persona, usuario_pagado_id, asociacion, fecha_desde, fecha_hasta, estado_bono } = req.query;

        // Pre-query asignaciones si se necesita filtrar por tipo/asociación/fecha
        const needsAsigFilter = tipo_persona || asociacion || fecha_desde || fecha_hasta;
        let asigIds = null;

        if (needsAsigFilter) {
            let sq = supabase
                .from('asignaciones')
                .select('id, rodeos!inner(asociacion, fecha)')
                .eq('estado', 'activo');
            if (tipo_persona) sq = sq.eq('tipo_persona', tipo_persona);
            if (asociacion)   sq = sq.ilike('rodeos.asociacion', `%${asociacion}%`);
            if (fecha_desde)  sq = sq.gte('rodeos.fecha', fecha_desde);
            if (fecha_hasta)  sq = sq.lte('rodeos.fecha', fecha_hasta);
            const { data: asigs, error: errAsig } = await sq;
            if (errAsig) throw new Error('Error filtrando asignaciones: ' + errAsig.message);
            asigIds = (asigs || []).map(a => a.id);
        }

        // Sin resultados en pre-query → respuesta vacía
        if (asigIds !== null && asigIds.length === 0) {
            return res.json({
                data: [],
                resumen: { total: 0, aprobados: 0, pendientes: 0, rechazados: 0,
                           monto_aprobado_total: 0, monto_pendiente_total: 0 }
            });
        }

        let q = supabase
            .from('bonos_solicitados')
            .select(`
                id, estado, monto_solicitado, monto_aprobado, distancia_declarada,
                created_at, observacion_admin,
                usuarios_pagados(id, codigo_interno, nombre_completo, rut, tipo_persona, categoria),
                asignaciones!inner(
                    id, tipo_persona,
                    rodeos!inner(id, club, asociacion, fecha, tipo_rodeo_nombre)
                )
            `);

        if (estado_bono)        q = q.eq('estado', estado_bono);
        if (usuario_pagado_id)  q = q.eq('usuario_pagado_id', usuario_pagado_id);
        if (asigIds !== null)   q = q.in('asignacion_id', asigIds);

        q = q.order('created_at', { ascending: false });

        const { data, error } = await q;
        if (error) throw new Error(error.message);

        const bonos = data || [];
        const aprobados = bonos.filter(b => ['aprobado', 'modificado'].includes(b.estado));
        const pendientes = bonos.filter(b => b.estado === 'pendiente');
        const rechazados = bonos.filter(b => b.estado === 'rechazado');

        res.json({
            data: bonos,
            resumen: {
                total:                bonos.length,
                aprobados:            aprobados.length,
                pendientes:           pendientes.length,
                rechazados:           rechazados.length,
                monto_aprobado_total: aprobados.reduce((s, b) => s + (b.monto_aprobado || b.monto_solicitado || 0), 0),
                monto_pendiente_total: pendientes.reduce((s, b) => s + (b.monto_solicitado || 0), 0)
            }
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/reportes/categorias-rodeo
router.post('/categorias-rodeo', async (req, res) => {
    const { nombre } = req.body;
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'nombre requerido' });
    const { data, error } = await supabase
        .from('categorias_rodeo')
        .insert({ nombre: nombre.trim() })
        .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});

// PATCH /api/admin/reportes/categorias-rodeo/:id
router.patch('/categorias-rodeo/:id', async (req, res) => {
    const { nombre, activo } = req.body;
    const cambios = {};
    if (nombre) cambios.nombre = nombre.trim();
    if (activo !== undefined) cambios.activo = !!activo;
    const { data, error } = await supabase
        .from('categorias_rodeo')
        .update(cambios)
        .eq('id', req.params.id)
        .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

module.exports = router;
