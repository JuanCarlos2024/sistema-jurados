// Evaluación de Desempeño Jurados — endpoints de consulta (pantalla/Excel) y
// de escritura de los dos campos manuales (Mal jurado, Análisis técnico).
// Middleware de administrador y los guards de rol (Director solo lectura,
// Capacitador fuera de este módulo) ya se aplican globalmente en
// routes/admin/index.js — este archivo no necesita declararlos de nuevo.
const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const supabase = require('../../config/supabase');
const { obtenerEvaluacionDesempeno } = require('../../services/evaluacionDesempenoJurados');

function parseQuery(req) {
    return {
        desde: req.query.desde || null,
        hasta: req.query.hasta || null,
        categoria: req.query.categoria || null,
        search: req.query.search || null,
        order: req.query.order || 'total_rodeos_desc'
    };
}

// GET /api/admin/evaluacion-desempeno?desde=&hasta=&categoria=&search=&order=
router.get('/', async (req, res) => {
    try {
        const resultado = await obtenerEvaluacionDesempeno(parseQuery(req));
        res.json(resultado);
    } catch (err) {
        if (err.message === 'PERIODO_REQUERIDO' || err.message === 'PERIODO_INVALIDO') {
            return res.status(400).json({ error: err.message });
        }
        console.error('[EVALUACION-DESEMPENO]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/admin/evaluacion-desempeno/excel — misma fuente que la pantalla.
router.get('/excel', async (req, res) => {
    try {
        const { periodo, filas } = await obtenerEvaluacionDesempeno(parseQuery(req));

        const fmtFecha = f => f ? f.slice(8, 10) + '/' + f.slice(5, 7) + '/' + f.slice(0, 4) : '';
        const fmtNota  = v => v !== null && v !== undefined ? v : 'N.I.';
        const fmtWsp   = (total, rodeos) => `${total} (${rodeos} rodeo${rodeos === 1 ? '' : 's'})`;

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Sistema de Jurados';
        const ws = workbook.addWorksheet('Evaluación Desempeño');

        ws.addRow(['Evaluación de Desempeño Jurados']).font = { bold: true, size: 14 };
        ws.addRow([`Período: ${fmtFecha(periodo.desde)} al ${fmtFecha(periodo.hasta)}`]);
        ws.addRow([`Generado: ${fmtFecha(new Date().toISOString().slice(0, 10))}`]);
        ws.addRow([]);
        ws.addRow([
            'Nota metodológica: "Altera resultado" y "Consultas WSP" provienen de un registro POR RODEO '
            + '(no por jurado individual) y se atribuyen a cada jurado que participó en ese rodeo — no implican '
            + 'responsabilidad ni dirección personal. "Nota Delegado" también es una nota del rodeo completo, '
            + 'atribuida igual a cada participante. "Nota Comisión" y "Nota Área Deportiva" sí son evaluaciones '
            + 'individuales por jurado. "% alterado por categoría" se calcula según la metodología documentada '
            + 'en el pedido original, pendiente de verificación contra una fuente oficial externa.'
        ]).font = { italic: true, size: 9, color: { argb: 'FF666666' } };
        ws.addRow([]);

        const headerRowIdx = ws.rowCount + 1;
        ws.columns = [
            { header: 'N°',                         key: 'n',                width: 6 },
            { header: 'Jurado',                      key: 'jurado',           width: 32 },
            { header: 'Categoría',                   key: 'categoria',        width: 11 },
            { header: 'Altera resultado',            key: 'altera',           width: 15 },
            { header: 'Total rodeos período',        key: 'total_rodeos',     width: 17 },
            { header: '% rodeos alterados 1-3 L.',    key: 'pct_alterado',     width: 18 },
            { header: '% alterado por categoría',     key: 'pct_categoria',    width: 18 },
            { header: 'Total consultas WSP',          key: 'wsp',              width: 18 },
            { header: 'Mal jurado',                   key: 'mal_jurado',       width: 11 },
            { header: 'Nota prom. Delegado',          key: 'nota_delegado',    width: 16 },
            { header: 'Nota prom. Comisión',          key: 'nota_comision',    width: 16 },
            { header: 'Promedio D + Com.',            key: 'promedio_d_com',   width: 15 },
            { header: 'Nota prom. Área Deportiva',    key: 'nota_ad',          width: 18 },
            { header: 'Promedio categoría (AD)',      key: 'promedio_cat_ad',  width: 18 },
            { header: 'Análisis técnico',             key: 'analisis',         width: 50 }
        ];
        const headerRow = ws.getRow(headerRowIdx);
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A3C6E' } };
        headerRow.alignment = { vertical: 'middle' };
        headerRow.height = 18;

        filas.forEach((f, i) => {
            ws.addRow({
                n: i + 1,
                jurado: f.nombre,
                categoria: f.categoria || '—',
                altera: f.altera_resultado,
                total_rodeos: f.total_rodeos,
                pct_alterado: fmtNota(f.pct_alterado_individual),
                pct_categoria: fmtNota(f.pct_alterado_categoria),
                wsp: fmtWsp(f.consultas_wsp_total, f.consultas_wsp_rodeos),
                mal_jurado: f.mal_jurado ?? '—',
                nota_delegado: fmtNota(f.nota_delegado_promedio),
                nota_comision: fmtNota(f.nota_comision_promedio),
                promedio_d_com: fmtNota(f.promedio_d_com),
                nota_ad: fmtNota(f.nota_ad_promedio),
                promedio_cat_ad: fmtNota(f.promedio_categoria_ad),
                analisis: f.analisis_tecnico || ''
            });
        });

        ws.autoFilter = { from: { row: headerRowIdx, column: 1 }, to: { row: headerRowIdx, column: ws.columns.length } };
        ws.views = [{ state: 'frozen', xSplit: 3, ySplit: headerRowIdx }];

        const fechaHoy = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Evaluacion_Desempeno_Jurados_${fechaHoy}.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        if (err.message === 'PERIODO_REQUERIDO' || err.message === 'PERIODO_INVALIDO') {
            return res.status(400).json({ error: err.message });
        }
        console.error('[EVALUACION-DESEMPENO/EXCEL]', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// PUT /api/admin/evaluacion-desempeno/manual/:usuarioId
// Body: { periodo_desde, periodo_hasta, actualizar_mal_jurado, mal_jurado,
//         actualizar_analisis_tecnico, analisis_tecnico, actualizado_en_esperado }
// p_actualizar_* siempre explícitos desde el frontend según qué formulario
// se envió (mismo criterio que corrigió el bug de notas-secundarias: nunca
// se infiere intención desde la sola presencia de una clave en el body).
router.put('/manual/:usuarioId', async (req, res) => {
    const {
        periodo_desde, periodo_hasta,
        actualizar_mal_jurado, mal_jurado,
        actualizar_analisis_tecnico, analisis_tecnico,
        actualizado_en_esperado
    } = req.body || {};

    if (!periodo_desde || !periodo_hasta) {
        return res.status(400).json({ error: 'periodo_desde y periodo_hasta son obligatorios' });
    }
    if (!actualizar_mal_jurado && !actualizar_analisis_tecnico) {
        return res.status(400).json({ error: 'Debe indicar qué campo actualizar' });
    }
    if (actualizar_mal_jurado && mal_jurado !== null && mal_jurado !== undefined) {
        const n = Number(mal_jurado);
        if (!Number.isInteger(n) || n < 0) {
            return res.status(400).json({ error: 'Mal jurado debe ser un entero mayor o igual a cero' });
        }
    }

    const { data, error } = await supabase.rpc('guardar_evaluacion_desempeno_manual_con_auditoria', {
        p_usuario_pagado_id: req.params.usuarioId,
        p_periodo_desde: periodo_desde,
        p_periodo_hasta: periodo_hasta,
        p_actualizar_mal_jurado: !!actualizar_mal_jurado,
        p_mal_jurado: actualizar_mal_jurado && mal_jurado !== '' && mal_jurado !== undefined ? Number(mal_jurado) : null,
        p_actualizar_analisis_tecnico: !!actualizar_analisis_tecnico,
        p_analisis_tecnico: actualizar_analisis_tecnico ? (analisis_tecnico ?? null) : null,
        p_administrador_id: req.usuario.id,
        p_actualizado_en_esperado: actualizado_en_esperado || null
    });

    if (error) {
        const codigo = error.message;
        if (codigo === 'CONFLICTO_CONCURRENCIA') {
            return res.status(409).json({ error: 'Otro administrador modificó este registro mientras usted editaba. Recargue y vuelva a intentar.', code: codigo });
        }
        if (codigo === 'JURADO_NO_ENCONTRADO') return res.status(404).json({ error: 'Jurado no encontrado', code: codigo });
        if (codigo === 'PERIODO_INVALIDO' || codigo === 'MAL_JURADO_INVALIDO' || codigo === 'ANALISIS_TECNICO_DEMASIADO_LARGO' || codigo === 'NINGUN_CAMPO_A_ACTUALIZAR') {
            return res.status(400).json({ error: codigo, code: codigo });
        }
        console.error('[EVALUACION-DESEMPENO/MANUAL]', error.message);
        return res.status(500).json({ error: error.message });
    }

    res.json(data);
});

module.exports = router;
