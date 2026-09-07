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
const ExcelJS  = require('exceljs');

// Mismo estilo de encabezado que reporte-deportivo.js — consistencia visual
// entre los reportes Excel del sistema.
const HEADER_STYLE = {
    font: { bold: true, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a5f' } },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }
};

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
        version:          cartilla.version || 1,
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
                // Revisión: se agregan rut_socio/nro_socio/nro_inscripcion —
                // ya existían en el formulario (cartilla.html) y en los datos
                // guardados, pero no se mostraban en este reporte. Mismos
                // campos reales, ningún dato nuevo inventado.
                filas.push({ ...base,
                    campo: `Registro rienda (${i + 1})`, campo_key: 'registro_rienda',
                    respuesta: [rr.nombre_socio, rr.rut_socio, rr.nombre_equino, rr.categoria].filter(Boolean).join(' / ') || '—',
                    comentario: [
                        rr.sistema,
                        rr.nro_socio ? `N° socio: ${rr.nro_socio}` : '',
                        rr.nro_inscripcion ? `N° inscripción: ${rr.nro_inscripcion}` : '',
                        rr.puntaje ? `Puntaje: ${rr.puntaje}` : ''
                    ].filter(Boolean).join(' — ') || '—' });
            });
        }
    }

    if (d.observaciones_finales) {
        filas.push({ ...base, campo: 'Observaciones finales', campo_key: 'observaciones_finales',
            respuesta: d.observaciones_finales, comentario: '—' });
    }

    return filas;
}

// ─── Fila RESUMEN (una por cartilla) — Mejora Reporte Deportivo ───────────────
// Para el Excel general: los 6 campos operativos del rodeo como columnas
// (nunca como filas separadas) — así una sola fila permite ver de un vistazo
// todo lo ocurrido en ESE rodeo. Mismos campos reales que expandirCartilla(),
// solo reorganizados en formato ancho. Tolerante a datos.* ausentes (cartillas
// antiguas o borradores incompletos) — nunca lanza, nunca inventa un valor.
function construirFilaResumen(cartilla) {
    const d      = cartilla.datos || {};
    const rodeo  = cartilla.rodeo  || {};
    const jurado = cartilla.jurado || {};

    return {
        asignacion_id:    cartilla.asignacion_id || cartilla.id,
        fecha_rodeo:      fmtF(rodeo.fecha),
        club:             clean(rodeo.club),
        asociacion:       clean(rodeo.asociacion),
        tipo_rodeo:       clean(rodeo.tipo_rodeo_nombre),
        jurado:           clean(jurado.nombre_completo),
        categoria_jurado: clean(jurado.categoria),
        estado_cartilla:  cartilla.estado || '—',
        hora_inicio:               d.hora_inicio || '—',
        serie_campeones_2_vueltas: siNo(d.serie_campeones_2_vueltas),
        caseta_adecuada:           siNo(d.caseta_adecuada),
        hubo_faltas:               siNo(d.hubo_faltas),
        hubo_ganado_fuera_peso:    siNo(d.hubo_ganado_fuera_peso),
        hubo_movimiento_rienda:    siNo(d.hubo_movimiento_rienda),
        observaciones_finales:     d.observaciones_finales?.trim() || '—',
        fecha_envio:      fmtDT(cartilla.enviada_en),
    };
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
            version,
            datos,
            enviada_en,
            created_at,
            rodeo:rodeos!cartillas_jurado_rodeo_id_fkey(id, club, asociacion, fecha, tipo_rodeo_nombre),
            jurado:usuarios_pagados!cartillas_jurado_usuario_pagado_id_fkey(id, nombre_completo, categoria)
        `)
        .eq('es_actual', true)
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

function aplicarFiltrosTexto(filas, tipo_respuesta, respuesta_valor, buscar) {
    let resultado = filas;
    if (tipo_respuesta) {
        resultado = resultado.filter(f => f.campo_key === tipo_respuesta);
    }
    if (respuesta_valor) {
        if (respuesta_valor === 'si') {
            resultado = resultado.filter(f => f.respuesta === 'Sí');
        } else if (respuesta_valor === 'no') {
            resultado = resultado.filter(f => f.respuesta === 'No');
        } else if (respuesta_valor === 'con_respuesta') {
            resultado = resultado.filter(f => f.respuesta && f.respuesta !== '—');
        } else if (respuesta_valor === 'sin_respuesta') {
            resultado = resultado.filter(f => !f.respuesta || f.respuesta === '—');
        }
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
        const resultado = aplicarFiltrosTexto(filas, req.query.tipo_respuesta, req.query.respuesta_valor, req.query.buscar);
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
        const resultado = aplicarFiltrosTexto(filas, req.query.tipo_respuesta, req.query.respuesta_valor, req.query.buscar);

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

// ─── GET /api/admin/reportes/cartillas-jurado/exportar-excel ──────────────────
// Excel RESUMEN — una fila por cartilla, los 6 campos operativos como
// columnas. Sirve para ver de un vistazo qué ocurrió en cada rodeo.
//
// El filtro "Campo / Tipo de respuesta" + "Respuesta" (tipo_respuesta/
// respuesta_valor) y la búsqueda libre (buscar) se aplican EXACTAMENTE igual
// que en la vista en pantalla y en el Excel Detallado — sección 4 del pedido
// ("no debe ocurrir que un campo aparezca en pantalla pero no en Excel"):
// se reutiliza aplicarFiltrosTexto() sobre las mismas filas expandidas para
// decidir qué cartillas quedan incluidas (una cartilla se incluye si al
// menos una de sus filas expandidas sobrevive el filtro) — así "Todos los
// campos" incluye todo, y filtrar por un campo específico (ej. "Hora de
// inicio" + "Con respuesta") filtra el resumen de forma consistente con lo
// que se ve en pantalla, sin tener que reconstruir columnas dinámicas.
router.get('/exportar-excel', async (req, res) => {
    try {
        const cartillas = await queryCartillas(req.query);

        const { tipo_respuesta, respuesta_valor, buscar } = req.query;
        const cartillasFiltradas = (tipo_respuesta || respuesta_valor || buscar)
            ? cartillas.filter(c => aplicarFiltrosTexto(expandirCartilla(c), tipo_respuesta, respuesta_valor, buscar).length > 0)
            : cartillas;

        if (cartillasFiltradas.length === 0) {
            return res.status(404).json({ error: 'No hay datos para exportar con los filtros indicados.' });
        }

        const filas = cartillasFiltradas.map(construirFilaResumen);

        const wb = new ExcelJS.Workbook();
        wb.creator = 'Sistema Jurados - Rodeo Chileno';
        wb.created = new Date();
        const ws = wb.addWorksheet('Reporte Cartillas - Resumen');

        ws.columns = [
            { header: 'Fecha Rodeo',                    key: 'fecha_rodeo',      width: 13 },
            { header: 'Club',                            key: 'club',             width: 28 },
            { header: 'Asociación',                      key: 'asociacion',       width: 22 },
            { header: 'Tipo Rodeo',                      key: 'tipo_rodeo',       width: 22 },
            { header: 'Jurado',                          key: 'jurado',           width: 26 },
            { header: 'Categoría Jurado',                key: 'categoria_jurado', width: 14 },
            { header: 'Estado Cartilla',                 key: 'estado_cartilla',  width: 14 },
            { header: 'Hora de Inicio',                  key: 'hora_inicio',      width: 14 },
            { header: 'Serie Campeones - 2 Vueltas',     key: 'serie_campeones_2_vueltas', width: 20 },
            { header: 'Caseta Adecuada',                 key: 'caseta_adecuada',  width: 16 },
            { header: 'Faltas Disciplinarias/Reglamentarias', key: 'hubo_faltas', width: 24 },
            { header: 'Ganado Fuera del Peso Reglamentario',  key: 'hubo_ganado_fuera_peso', width: 26 },
            { header: 'Movimiento a la Rienda',          key: 'hubo_movimiento_rienda', width: 20 },
            { header: 'Observaciones Finales',           key: 'observaciones_finales', width: 50 },
            { header: 'Fecha Envío',                     key: 'fecha_envio',      width: 18 },
        ];

        ws.getRow(1).eachCell(cell => {
            cell.font      = HEADER_STYLE.font;
            cell.fill      = HEADER_STYLE.fill;
            cell.alignment = HEADER_STYLE.alignment;
            cell.border    = HEADER_STYLE.border;
        });
        ws.getRow(1).height = 26;
        ws.views = [{ state: 'frozen', ySplit: 1 }];

        const CELL_BORDER = {
            top: { style: 'thin', color: { argb: 'FFD0D0D0' } }, bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
            left: { style: 'thin', color: { argb: 'FFD0D0D0' } }, right: { style: 'thin', color: { argb: 'FFD0D0D0' } }
        };
        for (const f of filas) {
            const row = ws.addRow(f);
            row.height = 16;
            row.eachCell({ includeEmpty: true }, cell => {
                cell.border    = CELL_BORDER;
                cell.alignment = { vertical: 'top', wrapText: true };
            });
        }

        const ts = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="reporte_cartillas_jurado_resumen_${ts}.xlsx"`);
        await wb.xlsx.write(res);
        res.end();
    } catch (e) {
        console.error('[reporte-cartillas] ERROR exportar-excel:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── GET /api/admin/reportes/cartillas-jurado/exportar-excel-detalle ──────────
// Excel DETALLADO — misma fuente exacta que GET / (una fila por campo/
// registro, vía expandirCartilla() + aplicarFiltrosTexto()) pero como .xlsx
// con estilo, en vez de JSON/CSV. Incluye las filas de "Registro ganado fuera
// de peso (N)" y "Registro rienda (N)" ya expandidas — el detalle de TODO lo
// ocurrido en el rodeo, no solo la respuesta general.
router.get('/exportar-excel-detalle', async (req, res) => {
    try {
        const cartillas = await queryCartillas(req.query);
        const filas     = cartillas.flatMap(expandirCartilla);
        const resultado = aplicarFiltrosTexto(filas, req.query.tipo_respuesta, req.query.respuesta_valor, req.query.buscar);

        if (resultado.length === 0) {
            return res.status(404).json({ error: 'No hay datos para exportar con los filtros indicados.' });
        }

        const wb = new ExcelJS.Workbook();
        wb.creator = 'Sistema Jurados - Rodeo Chileno';
        wb.created = new Date();
        const ws = wb.addWorksheet('Reporte Cartillas - Detalle');

        ws.columns = [
            { header: 'Fecha Rodeo',        key: 'fecha_rodeo',      width: 13 },
            { header: 'Club',                key: 'club',             width: 28 },
            { header: 'Asociación',          key: 'asociacion',       width: 22 },
            { header: 'Tipo Rodeo',          key: 'tipo_rodeo',       width: 22 },
            { header: 'Jurado',              key: 'jurado',           width: 26 },
            { header: 'Categoría Jurado',    key: 'categoria_jurado', width: 14 },
            { header: 'Estado Cartilla',     key: 'estado_cartilla',  width: 14 },
            { header: 'Campo / Pregunta',    key: 'campo',            width: 32 },
            { header: 'Respuesta',           key: 'respuesta',        width: 40 },
            { header: 'Comentario',          key: 'comentario',       width: 46 },
            { header: 'Fecha Envío',         key: 'fecha_envio',      width: 18 },
            { header: 'ID Asignación',       key: 'asignacion_id',    width: 38, style: { numFmt: '@' } },
        ];

        ws.getRow(1).eachCell(cell => {
            cell.font      = HEADER_STYLE.font;
            cell.fill      = HEADER_STYLE.fill;
            cell.alignment = HEADER_STYLE.alignment;
            cell.border    = HEADER_STYLE.border;
        });
        ws.getRow(1).height = 26;
        ws.views = [{ state: 'frozen', ySplit: 1 }];

        const CELL_BORDER = {
            top: { style: 'thin', color: { argb: 'FFD0D0D0' } }, bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
            left: { style: 'thin', color: { argb: 'FFD0D0D0' } }, right: { style: 'thin', color: { argb: 'FFD0D0D0' } }
        };
        for (const f of resultado) {
            const row = ws.addRow(f);
            row.height = 16;
            row.eachCell({ includeEmpty: true }, cell => {
                cell.border    = CELL_BORDER;
                cell.alignment = { vertical: 'top', wrapText: true };
            });
        }

        const ts = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="reporte_cartillas_jurado_detalle_${ts}.xlsx"`);
        await wb.xlsx.write(res);
        res.end();
    } catch (e) {
        console.error('[reporte-cartillas] ERROR exportar-excel-detalle:', e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
