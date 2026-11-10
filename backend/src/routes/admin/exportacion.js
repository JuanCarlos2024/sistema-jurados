const express = require('express');
const router  = express.Router();
const {
    exportarResumenMensual, exportarBonos, exportarPendientes,
    exportarRodeos, exportarResumenJurados, exportarDetalleJurado, exportarAgregado
} = require('../../services/exportacion');

const { obtenerRetencion } = require('../../services/calculo');
const { obtenerResumenJurados } = require('../../services/resumenJurados');

// Texto legible de los filtros activos para el encabezado del Excel.
async function describirFiltrosResumen(q, resumen) {
    const partes = [];
    if (q.usuario_pagado_id) {
        const j = (resumen.jurados || []).find(x => x.id === q.usuario_pagado_id);
        partes.push(`Jurado: ${j ? j.nombre_completo : q.usuario_pagado_id}`);
    }
    if (q.categoria)  partes.push(`Categoría: ${q.categoria}`);
    if (q.asociacion) partes.push(`Asociación contiene: "${q.asociacion}"`);
    if (q.club)       partes.push(`Club contiene: "${q.club}"`);
    if (q.tipo_rodeo_id) {
        const f = (resumen.jurados || []).flatMap(j => j.rodeos_detalle)[0];
        partes.push(`Tipo de rodeo: ${f ? f.tipo_rodeo : q.tipo_rodeo_id}`);
    }
    if (q.categoria_rodeo_id) {
        let nombre = q.categoria_rodeo_id;
        try {
            const supabase = require('../../config/supabase');
            const { data } = await supabase.from('categorias_rodeo').select('nombre').eq('id', q.categoria_rodeo_id).maybeSingle();
            if (data && data.nombre) nombre = data.nombre;
        } catch (_) { /* se informa el id */ }
        partes.push(`Categoría de rodeo: ${nombre}`);
    }
    return partes.length ? partes.join(' · ') : 'Sin filtros adicionales';
}

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
// MISMA fuente que la pantalla (services/resumenJurados.js →
// GET /admin/reportes/resumen-mensual): mismos filtros, mismas reglas,
// mismos montos. Antes tenía una copia propia que sumaba designaciones
// rechazadas e ignoraba categoria_rodeo_id.
router.get('/resumen-jurados', async (req, res) => {
    try {
        const resumen = await obtenerResumenJurados(req.query);
        const filtrosTexto = await describirFiltrosResumen(req.query, resumen);
        await exportarResumenJurados(resumen, req.query.formato || 'xlsx', res, { filtrosTexto });
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

    return { queryAsignaciones, agregarBonos };
}

module.exports = router;
