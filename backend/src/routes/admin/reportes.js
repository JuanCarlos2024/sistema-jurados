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
    const { año, mes, fechaDesde, fechaHasta, usuario_pagado_id, categoria, asociacion, club, tipo_rodeo_id } = filtros;

    let q = supabase
        .from('asignaciones')
        .select(`
            id, tipo_persona, categoria_aplicada, valor_diario_aplicado,
            duracion_dias_aplicada, pago_base_calculado, estado,
            nombre_importado, created_at,
            usuarios_pagados(id, codigo_interno, nombre_completo, rut, categoria, tipo_persona),
            rodeos!inner(id, club, asociacion, fecha, tipo_rodeo_nombre, duracion_dias, tipo_rodeo_id)
        `)
        .eq('estado', 'activo');

    const rango = buildRango(año, mes, fechaDesde, fechaHasta);
    if (rango) {
        q = q.gte('rodeos.fecha', rango.inicio).lte('rodeos.fecha', rango.fin);
    }
    if (usuario_pagado_id) q = q.eq('usuario_pagado_id', usuario_pagado_id);
    if (categoria)         q = q.eq('categoria_aplicada', categoria);
    if (asociacion)        q = q.ilike('rodeos.asociacion', `%${asociacion}%`);
    if (club)              q = q.ilike('rodeos.club', `%${club}%`);
    if (tipo_rodeo_id)     q = q.eq('rodeos.tipo_rodeo_id', tipo_rodeo_id);

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
        const bono_aprobado = bs
            .filter(b => ['aprobado', 'modificado'].includes(b.estado))
            .reduce((s, b) => s + (b.monto_aprobado || b.monto_solicitado || 0), 0);
        return { ...a, bonos: bs, ultimo_bono: ultimo, bono_aprobado };
    });
}

// ─── Calcular totales por jurado ──────────────────────────────
function calcularTotalesPorJurado(asignaciones, porcentajeRetencion) {
    const mapa = {};

    for (const a of asignaciones) {
        const u = a.usuarios_pagados;
        if (!u) continue;
        const uid = u.id;
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
        mapa[uid].cant_rodeos++;
        mapa[uid].total_pago_base     += (a.pago_base_calculado || 0);
        mapa[uid].total_bono_aprobado += (a.bono_aprobado || 0);
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
        const { año, mes, fechaDesde, fechaHasta, categoria, asociacion, club, tipo_rodeo_id } = req.query;
        const asignaciones = await queryAsignaciones({ año, mes, fechaDesde, fechaHasta, categoria, asociacion, club, tipo_rodeo_id });
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
        const { usuario_pagado_id, año, mes, fechaDesde, fechaHasta } = req.query;
        if (!usuario_pagado_id) return res.status(400).json({ error: 'usuario_pagado_id requerido' });

        const asignaciones = await queryAsignaciones({ usuario_pagado_id, año, mes, fechaDesde, fechaHasta });
        const conBonos     = await agregarBonos(asignaciones);
        const porcentaje   = await obtenerRetencion();

        const filas = conBonos.map(a => {
            const bruto     = (a.pago_base_calculado || 0) + (a.bono_aprobado || 0);
            const retencion = Math.round(bruto * porcentaje / 100);
            return {
                fecha:            a.rodeos?.fecha,
                club:             a.rodeos?.club,
                asociacion:       a.rodeos?.asociacion,
                tipo_rodeo:       a.rodeos?.tipo_rodeo_nombre,
                duracion_dias:    a.duracion_dias_aplicada,
                categoria:        a.categoria_aplicada,
                pago_base:        a.pago_base_calculado,
                bono_aprobado:    a.bono_aprobado,
                estado_bono:      a.ultimo_bono?.estado || null,
                distancia_km:     a.ultimo_bono?.distancia_declarada || null,
                bruto,
                retencion_monto:  retencion,
                liquido:          bruto - retencion,
            };
        });

        const totales = filas.reduce((acc, f) => ({
            pago_base:     acc.pago_base     + f.pago_base,
            bono_aprobado: acc.bono_aprobado + f.bono_aprobado,
            bruto:         acc.bruto         + f.bruto,
            retencion:     acc.retencion     + f.retencion_monto,
            liquido:       acc.liquido       + f.liquido,
        }), { pago_base:0, bono_aprobado:0, bruto:0, retencion:0, liquido:0 });

        // Datos del jurado
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

module.exports = router;
