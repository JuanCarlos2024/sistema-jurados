const express = require('express');
const router  = express.Router();
const {
    exportarResumenMensual, exportarBonos, exportarPendientes,
    exportarRodeos, exportarResumenJurados, exportarDetalleJurado, exportarAgregado
} = require('../../services/exportacion');

// Los reportes usan la misma lógica de cálculo — importamos el helper
const reportesRouter = require('./reportes');
const { obtenerRetencion } = require('../../services/calculo');

// ── Exportaciones existentes ──────────────────────────────────

// GET /api/admin/exportacion/resumen-mensual?año=&mes=
router.get('/resumen-mensual', async (req, res) => {
    const { año, mes } = req.query;
    const ahora = new Date();
    try {
        await exportarResumenMensual(año || ahora.getFullYear().toString(), mes || String(ahora.getMonth() + 1).padStart(2, '0'), res);
    } catch (err) {
        res.status(500).json({ error: 'Error al generar exportación: ' + err.message });
    }
});

// GET /api/admin/exportacion/bonos?estado=
router.get('/bonos', async (req, res) => {
    try {
        await exportarBonos(req.query.estado || 'todos', res);
    } catch (err) {
        res.status(500).json({ error: 'Error al generar exportación: ' + err.message });
    }
});

// GET /api/admin/exportacion/pendientes
router.get('/pendientes', async (req, res) => {
    try {
        await exportarPendientes(res);
    } catch (err) {
        res.status(500).json({ error: 'Error al generar exportación: ' + err.message });
    }
});

// ── Nuevas exportaciones ──────────────────────────────────────

// GET /api/admin/exportacion/rodeos?año=&mes=&buscar=
router.get('/rodeos', async (req, res) => {
    try {
        await exportarRodeos(req.query, res);
    } catch (err) {
        res.status(500).json({ error: 'Error al generar exportación: ' + err.message });
    }
});

// GET /api/admin/exportacion/resumen-jurados?año=&mes=&...&formato=xlsx|csv
// Reutiliza la misma query de reportes para consistencia
router.get('/resumen-jurados', async (req, res) => {
    try {
        const supabase = require('../../config/supabase');
        const { calcularTotalesPorJurado, queryAsignaciones, agregarBonos } = _buildReportHelpers(supabase);
        const asignaciones = await queryAsignaciones(req.query);
        const conBonos     = await agregarBonos(asignaciones);
        const porcentaje   = await obtenerRetencion();
        const datos        = calcularTotalesPorJurado(conBonos, porcentaje);
        await exportarResumenJurados(datos, porcentaje, req.query.formato || 'xlsx', res);
    } catch (err) {
        res.status(500).json({ error: 'Error al generar exportación: ' + err.message });
    }
});

// GET /api/admin/exportacion/detalle-jurado?usuario_pagado_id=&año=&mes=&formato=
router.get('/detalle-jurado', async (req, res) => {
    try {
        const supabase = require('../../config/supabase');
        const { queryAsignaciones, agregarBonos } = _buildReportHelpers(supabase);
        const { usuario_pagado_id, año, mes, fechaDesde, fechaHasta, formato } = req.query;
        if (!usuario_pagado_id) return res.status(400).json({ error: 'usuario_pagado_id requerido' });

        const asignaciones = await queryAsignaciones({ usuario_pagado_id, año, mes, fechaDesde, fechaHasta });
        const conBonos     = await agregarBonos(asignaciones);
        const porcentaje   = await obtenerRetencion();

        const filas = conBonos.map(a => {
            const bruto     = (a.pago_base_calculado || 0) + (a.bono_aprobado || 0);
            const retencion = Math.round(bruto * porcentaje / 100);
            return {
                fecha: a.rodeos?.fecha, club: a.rodeos?.club, asociacion: a.rodeos?.asociacion,
                tipo_rodeo: a.rodeos?.tipo_rodeo_nombre, duracion_dias: a.duracion_dias_aplicada,
                categoria: a.categoria_aplicada, pago_base: a.pago_base_calculado,
                bono_aprobado: a.bono_aprobado, estado_bono: a.ultimo_bono?.estado || null,
                bruto, retencion_monto: retencion, liquido: bruto - retencion,
            };
        });

        const { data: jurado } = await supabase
            .from('usuarios_pagados')
            .select('codigo_interno, nombre_completo, rut, categoria')
            .eq('id', usuario_pagado_id)
            .single();

        await exportarDetalleJurado(jurado, filas, porcentaje, formato || 'xlsx', res);
    } catch (err) {
        res.status(500).json({ error: 'Error al generar exportación: ' + err.message });
    }
});

// GET /api/admin/exportacion/agregado?tipo=asociacion|club|tipo-rodeo&...&formato=
router.get('/agregado', async (req, res) => {
    try {
        const supabase = require('../../config/supabase');
        const { queryAsignaciones, agregarBonos } = _buildReportHelpers(supabase);
        const { tipo, formato } = req.query;
        if (!['asociacion', 'club', 'tipo-rodeo'].includes(tipo)) {
            return res.status(400).json({ error: 'tipo debe ser asociacion, club o tipo-rodeo' });
        }

        const asignaciones = await queryAsignaciones(req.query);
        const conBonos     = await agregarBonos(asignaciones);
        let datos;

        if (tipo === 'asociacion') {
            const mapa = {};
            for (const a of conBonos) {
                const k = a.rodeos?.asociacion || 'Sin asociación';
                if (!mapa[k]) mapa[k] = { asociacion: k, cant_rodeos: new Set(), cant_jurados: 0, total_pago_base: 0, total_bono_aprobado: 0 };
                mapa[k].cant_rodeos.add(a.rodeos?.id);
                mapa[k].cant_jurados++;
                mapa[k].total_pago_base     += (a.pago_base_calculado || 0);
                mapa[k].total_bono_aprobado += (a.bono_aprobado || 0);
            }
            datos = Object.values(mapa).map(d => ({ ...d, cant_rodeos: d.cant_rodeos.size, total_bruto: d.total_pago_base + d.total_bono_aprobado }));
        } else if (tipo === 'club') {
            const mapa = {};
            for (const a of conBonos) {
                const k = (a.rodeos?.club || 'Sin club') + '|' + (a.rodeos?.asociacion || '');
                if (!mapa[k]) mapa[k] = { club: a.rodeos?.club || 'Sin club', asociacion: a.rodeos?.asociacion || '—', cant_rodeos: new Set(), cant_jurados: 0, total_pago_base: 0, total_bono_aprobado: 0 };
                mapa[k].cant_rodeos.add(a.rodeos?.id);
                mapa[k].cant_jurados++;
                mapa[k].total_pago_base     += (a.pago_base_calculado || 0);
                mapa[k].total_bono_aprobado += (a.bono_aprobado || 0);
            }
            datos = Object.values(mapa).map(d => ({ ...d, cant_rodeos: d.cant_rodeos.size, total_bruto: d.total_pago_base + d.total_bono_aprobado }));
        } else {
            const mapa = {};
            for (const a of conBonos) {
                const k = a.rodeos?.tipo_rodeo_nombre || '—';
                if (!mapa[k]) mapa[k] = { tipo_rodeo: k, cant_rodeos: new Set(), cant_jurados: 0, total_pago_base: 0, total_bono_aprobado: 0 };
                mapa[k].cant_rodeos.add(a.rodeos?.id);
                mapa[k].cant_jurados++;
                mapa[k].total_pago_base     += (a.pago_base_calculado || 0);
                mapa[k].total_bono_aprobado += (a.bono_aprobado || 0);
            }
            datos = Object.values(mapa).map(d => ({ ...d, cant_rodeos: d.cant_rodeos.size, total_bruto: d.total_pago_base + d.total_bono_aprobado }));
        }

        await exportarAgregado(tipo === 'tipo-rodeo' ? 'tipo' : tipo, datos, formato || 'xlsx', res);
    } catch (err) {
        res.status(500).json({ error: 'Error al generar exportación: ' + err.message });
    }
});

// ── Helper interno: reutiliza funciones de reportes sin circular dep ──
function _buildReportHelpers(supabase) {
    const { obtenerRetencion } = require('../../services/calculo');

    function buildRango(año, mes, fechaDesde, fechaHasta) {
        const añoNum = parseInt(año);
        const mesNum = parseInt(mes);
        if (fechaDesde && fechaHasta) return { inicio: fechaDesde, fin: fechaHasta };
        if (!isNaN(añoNum) && !isNaN(mesNum) && mesNum >= 1 && mesNum <= 12)
            return { inicio: `${añoNum}-${String(mesNum).padStart(2,'0')}-01`, fin: new Date(añoNum, mesNum, 0).toISOString().split('T')[0] };
        if (!isNaN(añoNum)) return { inicio: `${añoNum}-01-01`, fin: `${añoNum}-12-31` };
        return null;
    }

    async function queryAsignaciones(filtros) {
        const { año, mes, fechaDesde, fechaHasta, usuario_pagado_id, categoria, asociacion, club, tipo_rodeo_id } = filtros;
        let q = supabase.from('asignaciones').select(`
            id, tipo_persona, categoria_aplicada, valor_diario_aplicado,
            duracion_dias_aplicada, pago_base_calculado, estado, nombre_importado,
            usuarios_pagados(id, codigo_interno, nombre_completo, rut, categoria, tipo_persona),
            rodeos!inner(id, club, asociacion, fecha, tipo_rodeo_nombre, duracion_dias, tipo_rodeo_id)
        `).eq('estado', 'activo');
        const rango = buildRango(año, mes, fechaDesde, fechaHasta);
        if (rango) q = q.gte('rodeos.fecha', rango.inicio).lte('rodeos.fecha', rango.fin);
        if (usuario_pagado_id) q = q.eq('usuario_pagado_id', usuario_pagado_id);
        if (categoria)         q = q.eq('categoria_aplicada', categoria);
        if (asociacion)        q = q.ilike('rodeos.asociacion', `%${asociacion}%`);
        if (club)              q = q.ilike('rodeos.club', `%${club}%`);
        if (tipo_rodeo_id)     q = q.eq('rodeos.tipo_rodeo_id', tipo_rodeo_id);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        return data || [];
    }

    async function agregarBonos(asignaciones) {
        if (!asignaciones.length) return asignaciones;
        const ids = asignaciones.map(a => a.id);
        const { data: bonos } = await supabase.from('bonos_solicitados')
            .select('asignacion_id, estado, monto_aprobado, monto_solicitado, distancia_declarada')
            .in('asignacion_id', ids);
        const bonoMap = {};
        (bonos || []).forEach(b => {
            if (!bonoMap[b.asignacion_id]) bonoMap[b.asignacion_id] = [];
            bonoMap[b.asignacion_id].push(b);
        });
        return asignaciones.map(a => {
            const bs = bonoMap[a.id] || [];
            const bono_aprobado = bs.filter(b => ['aprobado','modificado'].includes(b.estado))
                .reduce((s, b) => s + (b.monto_aprobado || b.monto_solicitado || 0), 0);
            return { ...a, bonos: bs, ultimo_bono: bs[bs.length-1] || null, bono_aprobado };
        });
    }

    function calcularTotalesPorJurado(asignaciones, pct) {
        const mapa = {};
        for (const a of asignaciones) {
            const u = a.usuarios_pagados;
            if (!u) continue;
            if (!mapa[u.id]) mapa[u.id] = { id: u.id, codigo_interno: u.codigo_interno, nombre_completo: u.nombre_completo, rut: u.rut||'—', categoria: u.categoria||'—', tipo_persona: u.tipo_persona, cant_rodeos: 0, total_pago_base: 0, total_bono_aprobado: 0 };
            mapa[u.id].cant_rodeos++;
            mapa[u.id].total_pago_base     += (a.pago_base_calculado || 0);
            mapa[u.id].total_bono_aprobado += (a.bono_aprobado || 0);
        }
        return Object.values(mapa).map(j => {
            const bruto = j.total_pago_base + j.total_bono_aprobado;
            const ret   = Math.round(bruto * pct / 100);
            return { ...j, bruto, retencion_monto: ret, liquido: bruto - ret };
        }).sort((a, b) => a.nombre_completo.localeCompare(b.nombre_completo));
    }

    return { queryAsignaciones, agregarBonos, calcularTotalesPorJurado };
}

module.exports = router;
