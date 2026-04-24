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
                rodeos_detalle: [],
                _seenRodeos:    new Set(),
            };
        }
        if (!esRechazada) {
            mapa[uid].cant_rodeos++;
            mapa[uid].total_pago_base     += (a.pago_base_calculado || 0);
            mapa[uid].total_bono_aprobado += (a.bono_aprobado || 0);
            const rid = a.rodeos?.id;
            if (rid && !mapa[uid]._seenRodeos.has(rid)) {
                mapa[uid]._seenRodeos.add(rid);
                mapa[uid].rodeos_detalle.push({ club: a.rodeos?.club || '—', fecha: a.rodeos?.fecha || '' });
            }
        }
    }

    return Object.values(mapa).map(j => {
        const bruto     = j.total_pago_base + j.total_bono_aprobado;
        const retencion = Math.round(bruto * porcentajeRetencion / 100);
        j.rodeos_detalle.sort((a, b) => a.fecha.localeCompare(b.fecha));
        delete j._seenRodeos;
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

// ══════════════════════════════════════════════════════════════
// Helpers de clasificación de casos (usados en los 3 endpoints)
// ══════════════════════════════════════════════════════════════
// Helpers de clasificación de casos
// ══════════════════════════════════════════════════════════════
function clasificarCaso(caso) {
    const sinDescuento =
        caso.tipo_caso === 'informativo' ||
        caso.resolucion_final === 'sin_descuento' ||
        caso.resolucion_final === 'apelacion_acogida';
    const faltaConfirmada = ['interpretativa_confirmada', 'reglamentaria_confirmada', 'apelacion_rechazada']
        .includes(caso.resolucion_final);
    const derivado = caso.decision_comision !== null && caso.decision_comision !== undefined;
    return { sinDescuento, faltaConfirmada, derivado };
}

function agregarDistribucion(casos) {
    let sin_descuento = 0, faltas_confirmadas = 0, derivados_comision = 0, sin_resolver = 0;
    let puntaje_descontado = 0;
    for (const c of casos) {
        const { sinDescuento, faltaConfirmada, derivado } = clasificarCaso(c);
        if (sinDescuento)      sin_descuento++;
        if (faltaConfirmada) { faltas_confirmadas++; puntaje_descontado += (c.descuento_puntos || 0); }
        if (derivado)          derivados_comision++;
        if (!sinDescuento && !faltaConfirmada && !derivado && c.tipo_caso !== 'informativo') sin_resolver++;
    }
    return { total_casos: casos.length, sin_descuento, faltas_confirmadas, derivados_comision, sin_resolver, puntaje_descontado };
}

// ── CSV: campo individual con escape RFC 4180 ─────────────────
function csvCampo(val) {
    if (val === null || val === undefined) return '""';
    return '"' + String(val).replace(/"/g, '""') + '"';
}

// ── CSV: construir archivo completo ──────────────────────────
// UTF-8 BOM + separador ; + CRLF — compatible con Excel en Chile
function construirCsv(filas, columnas) {
    const SEP  = ';';
    const CRLF = '\r\n';
    const cabecera = columnas.map(c => csvCampo(c.label)).join(SEP);
    const cuerpo   = filas.map(fila =>
        columnas.map(c => csvCampo(c.get(fila))).join(SEP)
    );
    return '\uFEFF' + [cabecera, ...cuerpo].join(CRLF) + CRLF;
}

// ── Query helper: evaluaciones con métricas ───────────────────
async function queryEvaluacionesData({ estado, asociacion, temporada }) {
    let q = supabase
        .from('evaluaciones')
        .select(`
            id, estado, created_at, fecha_decision_jefe, puntaje_base,
            rodeos(id, club, asociacion, fecha, tipo_rodeo_nombre),
            evaluacion_ciclos(id, numero_ciclo, estado),
            evaluacion_casos(id, tipo_caso, descuento_puntos, resolucion_final, decision_comision)
        `)
        .order('created_at', { ascending: false });

    if (estado)    q = q.eq('estado', estado);
    if (asociacion) q = q.ilike('rodeos.asociacion', `%${asociacion}%`);
    if (temporada) {
        const yr = parseInt(temporada);
        if (!isNaN(yr)) q = q.gte('rodeos.fecha', `${yr}-01-01`).lte('rodeos.fecha', `${yr}-12-31`);
    }

    const { data: evals, error } = await q;
    if (error) throw new Error(error.message);

    const evalIds = (evals || []).map(e => e.id);
    let notasMap = {};
    if (evalIds.length > 0) {
        const { data: notas } = await supabase
            .from('notas_rodeo')
            .select('evaluacion_id, nota')
            .in('evaluacion_id', evalIds);
        (notas || []).forEach(n => {
            if (!notasMap[n.evaluacion_id]) notasMap[n.evaluacion_id] = [];
            notasMap[n.evaluacion_id].push(n.nota);
        });
    }

    return (evals || []).map(ev => {
        const dist = agregarDistribucion(ev.evaluacion_casos || []);
        const notas = notasMap[ev.id] || [];
        const nota_promedio = notas.length > 0
            ? parseFloat((notas.reduce((s, n) => s + (n || 0), 0) / notas.length).toFixed(2))
            : null;
        const tiempo_dias = ev.fecha_decision_jefe
            ? Math.round((new Date(ev.fecha_decision_jefe) - new Date(ev.created_at)) / 86400000)
            : null;
        return {
            id:                     ev.id,
            estado:                 ev.estado,
            created_at:             ev.created_at,
            fecha_decision_jefe:    ev.fecha_decision_jefe,
            tiempo_resolucion_dias: tiempo_dias,
            rodeo:                  ev.rodeos,
            ciclos:                 (ev.evaluacion_ciclos || []).map(c => ({
                id: c.id, numero_ciclo: c.numero_ciclo, estado: c.estado
            })),
            ...dist,
            jurados_evaluados: notas.length,
            nota_promedio,
        };
    });
}

// ── Query helper: jurados con desempeño ───────────────────────
async function queryJuradosData({ usuario_pagado_id, asociacion, temporada }) {
    let q = supabase
        .from('notas_rodeo')
        .select(`
            asignacion_id, nota, puntaje_evaluacion, calificacion_cualitativa, fuente, evaluacion_id,
            asignaciones!inner(
                id, tipo_persona, categoria_aplicada, usuario_pagado_id,
                usuarios_pagados(id, nombre_completo, rut, categoria),
                rodeos!inner(id, club, asociacion, fecha, tipo_rodeo_nombre)
            )
        `)
        .not('evaluacion_id', 'is', null)
        .eq('asignaciones.tipo_persona', 'jurado');

    if (usuario_pagado_id) q = q.eq('asignaciones.usuario_pagado_id', usuario_pagado_id);
    if (asociacion) q = q.ilike('asignaciones.rodeos.asociacion', `%${asociacion}%`);
    if (temporada) {
        const yr = parseInt(temporada);
        if (!isNaN(yr)) {
            q = q.gte('asignaciones.rodeos.fecha', `${yr}-01-01`)
                 .lte('asignaciones.rodeos.fecha', `${yr}-12-31`);
        }
    }

    const { data: notas, error } = await q;
    if (error) throw new Error(error.message);

    const evalIds = [...new Set((notas || []).map(n => n.evaluacion_id).filter(Boolean))];
    let evalStateMap = {};
    if (evalIds.length > 0) {
        const { data: evals } = await supabase
            .from('evaluaciones').select('id, estado').in('id', evalIds);
        (evals || []).forEach(e => { evalStateMap[e.id] = e.estado; });
    }

    const asigIds = (notas || []).map(n => n.asignacion_id).filter(Boolean);
    let respuestasMap = {};
    if (asigIds.length > 0) {
        const { data: resps } = await supabase
            .from('evaluacion_respuestas_jurado')
            .select(`asignacion_id, decision, evaluacion_casos!inner(tipo_caso)`)
            .in('asignacion_id', asigIds)
            .neq('evaluacion_casos.tipo_caso', 'informativo');
        (resps || []).forEach(r => {
            if (!respuestasMap[r.asignacion_id]) respuestasMap[r.asignacion_id] = { acepta: 0, rechaza: 0 };
            if (r.decision === 'acepta' || r.decision === 'rechaza') {
                respuestasMap[r.asignacion_id][r.decision]++;
            }
        });
    }

    return (notas || []).map(n => {
        const asig  = n.asignaciones || {};
        const usr   = asig.usuarios_pagados || {};
        const rodeo = asig.rodeos || {};
        const resp  = respuestasMap[n.asignacion_id] || { acepta: 0, rechaza: 0 };
        return {
            asignacion_id:            n.asignacion_id,
            evaluacion_id:            n.evaluacion_id,
            evaluacion_estado:        evalStateMap[n.evaluacion_id] || null,
            usuario: {
                id:        usr.id,
                nombre:    usr.nombre_completo,
                rut:       usr.rut,
                categoria: usr.categoria || asig.categoria_aplicada,
            },
            rodeo: {
                club:       rodeo.club,
                asociacion: rodeo.asociacion,
                fecha:      rodeo.fecha,
                tipo_rodeo: rodeo.tipo_rodeo_nombre,
            },
            nota:                     n.nota,
            puntaje_evaluacion:       n.puntaje_evaluacion,
            calificacion_cualitativa: n.calificacion_cualitativa,
            fuente:                   n.fuente,
            respuestas_acepta:        resp.acepta,
            respuestas_rechaza:       resp.rechaza,
        };
    });
}

// ══════════════════════════════════════════════════════════════
// GET /api/admin/reportes/evaluaciones
// ══════════════════════════════════════════════════════════════
router.get('/evaluaciones', async (req, res) => {
    try {
        const data = await queryEvaluacionesData(req.query);
        res.json({ data, total: data.length });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/reportes/evaluaciones/exportar
// Exporta CSV con los mismos filtros que el endpoint de lista.
// DEBE definirse antes de /:id/detalle para evitar colisión de ruta.
// Autenticación: soloAdmin (heredada del router padre en index.js)
// ══════════════════════════════════════════════════════════════
router.get('/evaluaciones/exportar', async (req, res) => {
    try {
        const data = await queryEvaluacionesData(req.query);

        const ESTADO_LABEL = {
            borrador: 'Borrador', en_proceso: 'En proceso',
            pendiente_comision: 'Pend. comision', pendiente_aprobacion: 'Pend. aprobacion',
            devuelto: 'Devuelto', aprobado: 'Aprobado', publicado: 'Publicado', cerrado: 'Cerrado'
        };

        const columnas = [
            { label: 'Club',                   get: r => r.rodeo?.club },
            { label: 'Asociacion',             get: r => r.rodeo?.asociacion },
            { label: 'Fecha Rodeo',            get: r => r.rodeo?.fecha },
            { label: 'Tipo Rodeo',             get: r => r.rodeo?.tipo_rodeo_nombre },
            { label: 'Estado',                 get: r => ESTADO_LABEL[r.estado] || r.estado },
            { label: 'Total Ciclos',           get: r => r.ciclos?.length ?? 0 },
            { label: 'Total Casos',            get: r => r.total_casos ?? 0 },
            { label: 'Sin Descuento',          get: r => r.sin_descuento ?? 0 },
            { label: 'Faltas Confirmadas',     get: r => r.faltas_confirmadas ?? 0 },
            { label: 'Derivados Comision',     get: r => r.derivados_comision ?? 0 },
            { label: 'Sin Resolver',           get: r => r.sin_resolver ?? 0 },
            { label: 'Puntaje Descontado',     get: r => r.puntaje_descontado ?? 0 },
            { label: 'Jurados Evaluados',      get: r => r.jurados_evaluados ?? 0 },
            { label: 'Nota Promedio',          get: r => r.nota_promedio ?? '' },
            { label: 'Tiempo Resolucion Dias', get: r => r.tiempo_resolucion_dias ?? '' },
        ];

        const csv = construirCsv(data, columnas);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="evaluaciones.csv"');
        res.send(csv);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/reportes/jurados
// ══════════════════════════════════════════════════════════════
router.get('/jurados', async (req, res) => {
    try {
        const data = await queryJuradosData(req.query);
        res.json({ data, total: data.length });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/reportes/jurados/exportar
// Exporta CSV con los mismos filtros que el endpoint de lista.
// Autenticación: soloAdmin (heredada del router padre en index.js)
// ══════════════════════════════════════════════════════════════
router.get('/jurados/exportar', async (req, res) => {
    try {
        const data = await queryJuradosData(req.query);

        const columnas = [
            { label: 'Nombre',                   get: r => r.usuario?.nombre },
            { label: 'RUT',                      get: r => r.usuario?.rut },
            { label: 'Categoria',                get: r => r.usuario?.categoria },
            { label: 'Club',                     get: r => r.rodeo?.club },
            { label: 'Asociacion',               get: r => r.rodeo?.asociacion },
            { label: 'Fecha Rodeo',              get: r => r.rodeo?.fecha },
            { label: 'Tipo Rodeo',               get: r => r.rodeo?.tipo_rodeo },
            { label: 'Estado Evaluacion',        get: r => r.evaluacion_estado },
            { label: 'Nota',                     get: r => r.nota ?? '' },
            { label: 'Puntaje Evaluacion',       get: r => r.puntaje_evaluacion ?? '' },
            { label: 'Calificacion Cualitativa', get: r => r.calificacion_cualitativa },
            { label: 'Fuente',                   get: r => r.fuente },
            { label: 'Respuestas Acepta',        get: r => r.respuestas_acepta ?? 0 },
            { label: 'Respuestas Rechaza',       get: r => r.respuestas_rechaza ?? 0 },
        ];

        const csv = construirCsv(data, columnas);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="jurados-evaluaciones.csv"');
        res.send(csv);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/reportes/evaluaciones/:id/detalle
// Detalle completo de una evaluación — para informe exportable
// Secciones: cabecera, resumen_casos, ciclos con casos, jurados con notas
// No expone qué jurado respondió qué caso (privacidad)
// ══════════════════════════════════════════════════════════════
router.get('/evaluaciones/:id/detalle', async (req, res) => {
    try {
        const { id } = req.params;

        const { data: ev, error: evErr } = await supabase
            .from('evaluaciones')
            .select(`
                id, estado, created_at, fecha_decision_jefe, puntaje_base, puntaje_final, nota_final,
                observacion_general, decision_jefe, comentario_jefe,
                rodeos(id, club, asociacion, fecha, tipo_rodeo_nombre)
            `)
            .eq('id', id)
            .single();
        if (evErr || !ev) return res.status(404).json({ error: 'Evaluación no encontrada' });

        const [{ data: ciclos }, { data: casos }, { data: notas }] = await Promise.all([
            supabase
                .from('evaluacion_ciclos')
                .select('id, numero_ciclo, estado, fecha_apertura, fecha_cierre')
                .eq('evaluacion_id', id)
                .order('numero_ciclo'),
            supabase
                .from('evaluacion_casos')
                .select('id, ciclo_id, numero_caso, tipo_caso, descripcion, descuento_puntos, resolucion_final, decision_comision, comentario_comision, estado')
                .eq('evaluacion_id', id)
                .order('numero_caso'),
            supabase
                .from('notas_rodeo')
                .select(`
                    asignacion_id, nota, puntaje_evaluacion, calificacion_cualitativa, fuente,
                    asignaciones!inner(
                        categoria_aplicada,
                        usuarios_pagados(nombre_completo, categoria)
                    )
                `)
                .eq('evaluacion_id', id),
        ]);

        // Respuestas agregadas por caso (sin revelar qué jurado respondió qué)
        const casoIds = (casos || []).map(c => c.id);
        let respMap = {};
        if (casoIds.length > 0) {
            const { data: resps } = await supabase
                .from('evaluacion_respuestas_jurado')
                .select('caso_id, decision, evaluacion_casos!inner(tipo_caso)')
                .in('caso_id', casoIds);
            (resps || []).forEach(r => {
                if (!respMap[r.caso_id]) respMap[r.caso_id] = { acepta: 0, rechaza: 0 };
                const esInformativo = r.evaluacion_casos?.tipo_caso === 'informativo';
                if (!esInformativo) respMap[r.caso_id][r.decision] = (respMap[r.caso_id][r.decision] || 0) + 1;
            });
        }

        // Casos enriquecidos con clasificación y stats de respuestas
        const casosEnriquecidos = (casos || []).map(c => {
            const { sinDescuento, faltaConfirmada, derivado } = clasificarCaso(c);
            const resp = respMap[c.id] || { acepta: 0, rechaza: 0 };
            return {
                id: c.id, ciclo_id: c.ciclo_id, numero_caso: c.numero_caso,
                tipo_caso: c.tipo_caso, descripcion: c.descripcion,
                descuento_puntos: c.descuento_puntos, resolucion_final: c.resolucion_final,
                decision_comision: c.decision_comision, comentario_comision: c.comentario_comision,
                estado: c.estado,
                sin_descuento:    sinDescuento,
                falta_confirmada: faltaConfirmada,
                derivado_comision: derivado,
                respuestas_acepta:  resp.acepta,
                respuestas_rechaza: resp.rechaza,
            };
        });

        // Ciclos con sus casos y sub-distribución
        const cicloMap = {};
        (ciclos || []).forEach(c => { cicloMap[c.id] = { ...c, casos: [] }; });
        casosEnriquecidos.forEach(c => { if (cicloMap[c.ciclo_id]) cicloMap[c.ciclo_id].casos.push(c); });
        const ciclosConStats = Object.values(cicloMap).map(ciclo => {
            const dist = agregarDistribucion(ciclo.casos);
            return { ...ciclo, ...dist };
        });

        // Resumen global de casos
        const resumen_casos = agregarDistribucion(casosEnriquecidos);

        // Jurados con nota individual (calificacion_cualitativa es por asignación)
        const jurados = (notas || []).map(n => {
            const asig = n.asignaciones || {};
            const usr  = asig.usuarios_pagados || {};
            return {
                asignacion_id:            n.asignacion_id,
                nombre:                   usr.nombre_completo,
                categoria:                usr.categoria || asig.categoria_aplicada,
                nota:                     n.nota,
                puntaje_evaluacion:       n.puntaje_evaluacion,
                calificacion_cualitativa: n.calificacion_cualitativa,
                fuente:                   n.fuente,
            };
        });

        const tiempo_dias = ev.fecha_decision_jefe
            ? Math.round((new Date(ev.fecha_decision_jefe) - new Date(ev.created_at)) / 86400000)
            : null;

        res.json({
            evaluacion: {
                id: ev.id, estado: ev.estado, created_at: ev.created_at,
                fecha_decision_jefe: ev.fecha_decision_jefe,
                tiempo_resolucion_dias: tiempo_dias,
                puntaje_base: ev.puntaje_base, puntaje_final: ev.puntaje_final, nota_final: ev.nota_final,
                observacion_general: ev.observacion_general,
                decision_jefe: ev.decision_jefe, comentario_jefe: ev.comentario_jefe,
                rodeo: ev.rodeos,
            },
            resumen_casos,
            ciclos: ciclosConStats,
            jurados,
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
