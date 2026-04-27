/**
 * GET /api/admin/reportes/cartillas-jurado
 * GET /api/admin/reportes/cartillas-jurado/exportar
 *
 * Reporte exclusivo de cartillas digitales de jurados.
 * Fuente: cartillas_jurado (JSONB datos) + rodeos + usuarios_pagados.
 * Una sola query PostgREST con FK constraint explícita para máxima fiabilidad.
 */

const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const siNo  = v  => v === 'si' ? 'Sí' : v === 'no' ? 'No' : (v || '—');
const fmtF  = iso => iso ? new Date(iso).toLocaleDateString('es-CL')  : '—';
const fmtDT = iso => iso ? new Date(iso).toLocaleString('es-CL')      : '—';
const clean = v  => String(v ?? '').trim() || '—';

// ─── Expansión JSONB → filas del reporte ──────────────────────────────────────

function expandirCartilla(cartilla) {
    const d      = cartilla.datos || {};
    const rodeo  = cartilla.rodeo  || {};
    const jurado = cartilla.jurado || {};

    const base = {
        asignacion_id:    cartilla.asignacion_id || cartilla.id,
        fecha_rodeo:      fmtF(rodeo.fecha),
        club:             clean(rodeo.club),
        asociacion:       clean(rodeo.asociacion),
        tipo_rodeo:       clean(rodeo.tipo_rodeo_nombre),
        jurado:           clean(jurado.nombre_completo),
        categoria_jurado: clean(jurado.categoria),
        estado_cartilla:  cartilla.estado || '—',
        fecha_envio:      fmtDT(cartilla.enviada_en),
    };

    const filas = [];

    if (d.hora_inicio !== undefined) {
        filas.push({ ...base, campo: 'Hora de inicio', campo_key: 'hora_inicio',
            respuesta: d.hora_inicio || '—', comentario: '—' });
    }

    if (d.serie_campeones_2_vueltas !== undefined) {
        filas.push({ ...base, campo: 'Serie campeones - 2 vueltas', campo_key: 'serie_campeones_2_vueltas',
            respuesta: siNo(d.serie_campeones_2_vueltas), comentario: '—' });
    }

    if (d.caseta_adecuada !== undefined) {
        filas.push({ ...base, campo: 'Caseta adecuada', campo_key: 'caseta_adecuada',
            respuesta: siNo(d.caseta_adecuada), comentario: '—' });
    }

    if (d.hubo_faltas !== undefined) {
        filas.push({ ...base, campo: 'Faltas disciplinarias/reglamentarias', campo_key: 'hubo_faltas',
            respuesta: siNo(d.hubo_faltas),
            comentario: d.hubo_faltas === 'si' ? (d.descripcion_faltas || '—') : '—' });
    }

    if (d.hubo_ganado_fuera_peso !== undefined) {
        filas.push({ ...base, campo: 'Ganado fuera del peso reglamentario', campo_key: 'hubo_ganado_fuera_peso',
            respuesta: siNo(d.hubo_ganado_fuera_peso),
            comentario: d.hubo_ganado_fuera_peso === 'si' ? (d.clasificacion_peso || '—') : '—' });

        if (d.hubo_ganado_fuera_peso === 'si' && Array.isArray(d.filas_ganado)) {
            d.filas_ganado.forEach((fg, i) => {
                filas.push({ ...base,
                    campo: `Registro ganado fuera de peso (${i + 1})`, campo_key: 'registro_ganado',
                    respuesta: [fg.serie, fg.cantidad, fg.porcentaje].filter(Boolean).join(' / ') || '—',
                    comentario: fg.observacion || '—' });
            });
        }
    }

    if (d.hubo_movimiento_rienda !== undefined) {
        filas.push({ ...base, campo: 'Movimiento a la rienda', campo_key: 'hubo_movimiento_rienda',
            respuesta: siNo(d.hubo_movimiento_rienda), comentario: '—' });

        if (d.hubo_movimiento_rienda === 'si' && Array.isArray(d.registros_rienda)) {
            d.registros_rienda.forEach((rr, i) => {
                filas.push({ ...base,
                    campo: `Registro rienda (${i + 1})`, campo_key: 'registro_rienda',
                    respuesta: [rr.nombre_socio, rr.nombre_equino, rr.categoria].filter(Boolean).join(' / ') || '—',
                    comentario: [rr.sistema, rr.puntaje ? `Puntaje: ${rr.puntaje}` : ''].filter(Boolean).join(' — ') || '—' });
            });
        }
    }

    if (d.observaciones_finales) {
        filas.push({ ...base, campo: 'Observaciones finales', campo_key: 'observaciones_finales',
            respuesta: d.observaciones_finales, comentario: '—' });
    }

    return filas;
}

// ─── Query principal: una sola consulta con FK explícitas ─────────────────────

async function queryCartillas(filtros) {
    const { fecha_desde, fecha_hasta, club, asociacion, jurado, tipo_rodeo, estado } = filtros;

    let q = supabase
        .from('cartillas_jurado')
        .select(`
            id,
            asignacion_id,
            rodeo_id,
            usuario_pagado_id,
            estado,
            datos,
            enviada_en,
            created_at,
            rodeo:rodeos!cartillas_jurado_rodeo_id_fkey(id, club, asociacion, fecha, tipo_rodeo_nombre),
            jurado:usuarios_pagados!cartillas_jurado_usuario_pagado_id_fkey(id, nombre_completo, categoria)
        `)
        .order('created_at', { ascending: false });

    if (estado) q = q.eq('estado', estado);

    const { data: cartillas, error } = await q;

    if (error) {
        console.error('[reporte-cartillas] Error en query:', error);
        throw new Error('Error consultando cartillas: ' + error.message);
    }

    console.log(`[reporte-cartillas] cartillas obtenidas: ${(cartillas || []).length}`);

    if (!cartillas || cartillas.length === 0) return [];

    // Filtros en JS sobre los datos ya unidos
    let resultado = cartillas;

    if (jurado) {
        const b = jurado.toLowerCase();
        resultado = resultado.filter(c =>
            (c.jurado?.nombre_completo || '').toLowerCase().includes(b)
        );
    }
    if (fecha_desde) {
        resultado = resultado.filter(c => c.rodeo?.fecha >= fecha_desde);
    }
    if (fecha_hasta) {
        resultado = resultado.filter(c => c.rodeo?.fecha <= fecha_hasta);
    }
    if (club) {
        const b = club.toLowerCase();
        resultado = resultado.filter(c =>
            (c.rodeo?.club || '').toLowerCase().includes(b)
        );
    }
    if (asociacion) {
        const b = asociacion.toLowerCase();
        resultado = resultado.filter(c =>
            (c.rodeo?.asociacion || '').toLowerCase().includes(b)
        );
    }
    if (tipo_rodeo) {
        const b = tipo_rodeo.toLowerCase();
        resultado = resultado.filter(c =>
            (c.rodeo?.tipo_rodeo_nombre || '').toLowerCase().includes(b)
        );
    }

    console.log(`[reporte-cartillas] tras filtros: ${resultado.length} cartillas`);
    return resultado;
}

function aplicarFiltrosTexto(filas, tipo_respuesta, buscar) {
    let resultado = filas;
    if (tipo_respuesta) {
        resultado = resultado.filter(f => f.campo_key === tipo_respuesta);
    }
    if (buscar) {
        const b = buscar.toLowerCase();
        resultado = resultado.filter(f =>
            f.respuesta.toLowerCase().includes(b)  ||
            f.comentario.toLowerCase().includes(b) ||
            f.club.toLowerCase().includes(b)       ||
            f.jurado.toLowerCase().includes(b)     ||
            f.asociacion.toLowerCase().includes(b)
        );
    }
    return resultado;
}

// ─── GET /api/admin/reportes/cartillas-jurado ─────────────────────────────────

router.get('/', async (req, res) => {
    try {
        const cartillas = await queryCartillas(req.query);
        const filas     = cartillas.flatMap(expandirCartilla);
        const resultado = aplicarFiltrosTexto(filas, req.query.tipo_respuesta, req.query.buscar);
        console.log(`[reporte-cartillas] GET / → filas: ${filas.length}, tras filtro texto: ${resultado.length}`);
        res.json(resultado);
    } catch (e) {
        console.error('[reporte-cartillas] ERROR:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── GET /api/admin/reportes/cartillas-jurado/exportar ────────────────────────

router.get('/exportar', async (req, res) => {
    try {
        const cartillas = await queryCartillas(req.query);
        const filas     = cartillas.flatMap(expandirCartilla);
        const resultado = aplicarFiltrosTexto(filas, req.query.tipo_respuesta, req.query.buscar);

        if (resultado.length === 0) {
            return res.status(404).json({ error: 'No hay datos para exportar con los filtros indicados.' });
        }

        const COLS = [
            'Fecha Rodeo', 'Club', 'Asociación', 'Tipo Rodeo',
            'Jurado', 'Categoría Jurado', 'Estado Cartilla',
            'Campo / Pregunta', 'Respuesta', 'Comentario',
            'Fecha Envío', 'ID Asignación'
        ];
        const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

        const lineas = [
            '\uFEFF' + COLS.map(esc).join(';'),
            ...resultado.map(f => [
                f.fecha_rodeo, f.club, f.asociacion, f.tipo_rodeo,
                f.jurado, f.categoria_jurado, f.estado_cartilla,
                f.campo, f.respuesta, f.comentario,
                f.fecha_envio, f.asignacion_id
            ].map(esc).join(';'))
        ];

        const ts = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="reporte_cartillas_jurado_${ts}.csv"`);
        res.send(lineas.join('\r\n'));
    } catch (e) {
        console.error('[reporte-cartillas] ERROR exportar:', e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
