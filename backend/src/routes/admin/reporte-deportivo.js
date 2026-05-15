const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const ExcelJS = require('exceljs');

const HEADER_STYLE = {
    font: { bold: true, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a5f' } },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }
};

function fmtFecha(f) {
    if (!f) return '';
    const [y, m, d] = f.split('T')[0].split('-');
    return `${d}/${m}/${y}`;
}

// resolucion_final que implican descuento efectivo real
const RESOL_EFECTIVAS = new Set(['interpretativa_confirmada', 'reglamentaria_confirmada', 'apelacion_rechazada']);

// ── Consulta principal ─────────────────────────────────────────────
async function obtenerDatos(q, paginar = true) {
    const {
        fecha_desde, fecha_hasta, club, asociacion, tipo_rodeo_id,
        estado_evaluacion, resultados_alterados, buscar, jurado_id, delegado_id,
        modo_flujo,
        page = 1, limit = 50
    } = q;

    // Pre-filtro por persona
    let rodeoIdsFiltro = null;
    if (jurado_id) {
        const { data } = await supabase.from('asignaciones').select('rodeo_id')
            .eq('usuario_pagado_id', jurado_id).eq('tipo_persona', 'jurado').eq('estado', 'activo');
        rodeoIdsFiltro = (data || []).map(r => r.rodeo_id);
        if (rodeoIdsFiltro.length === 0) return { data: [], total: 0 };
    }
    if (delegado_id) {
        const { data } = await supabase.from('asignaciones').select('rodeo_id')
            .eq('usuario_pagado_id', delegado_id).eq('tipo_persona', 'delegado_rentado').eq('estado', 'activo');
        const ids = (data || []).map(r => r.rodeo_id);
        rodeoIdsFiltro = rodeoIdsFiltro ? rodeoIdsFiltro.filter(id => ids.includes(id)) : ids;
        if (rodeoIdsFiltro.length === 0) return { data: [], total: 0 };
    }

    // Rodeos
    let rq = supabase.from('rodeos')
        .select('id, club, asociacion, fecha, tipo_rodeo_nombre, categoria_rodeo_nombre, observacion', { count: 'exact' })
        .eq('estado', 'activo')
        .order('fecha', { ascending: false });

    if (fecha_desde)     rq = rq.gte('fecha', fecha_desde);
    if (fecha_hasta)     rq = rq.lte('fecha', fecha_hasta);
    if (club)            rq = rq.ilike('club', `%${club}%`);
    if (asociacion)      rq = rq.ilike('asociacion', `%${asociacion}%`);
    if (tipo_rodeo_id)   rq = rq.eq('tipo_rodeo_id', tipo_rodeo_id);
    if (buscar)          rq = rq.or(`club.ilike.%${buscar}%,asociacion.ilike.%${buscar}%`);
    if (rodeoIdsFiltro)  rq = rq.in('id', rodeoIdsFiltro);

    if (paginar) {
        const offset = (parseInt(page) - 1) * parseInt(limit);
        rq = rq.range(offset, offset + parseInt(limit) - 1);
    } else {
        rq = rq.limit(5000);
    }

    const { data: rodeos, error: rErr, count } = await rq;
    if (rErr) throw new Error(rErr.message);
    if (!rodeos || rodeos.length === 0) return { data: [], total: count || 0 };

    const rodeoIds = rodeos.map(r => r.id);

    // Evaluaciones
    let eq = supabase.from('evaluaciones')
        .select(`
            id, rodeo_id, estado, nota_final, updated_at,
            puntaje_analista_1er, puntaje_analista_2do, puntaje_analista_3er,
            observacion_general, modo_flujo,
            resultados_alterados, comentario_resultados_alterados
        `)
        .in('rodeo_id', rodeoIds)
        .eq('anulada', false);

    if (estado_evaluacion)            eq = eq.eq('estado', estado_evaluacion);
    if (resultados_alterados === 'si') eq = eq.eq('resultados_alterados', true);
    if (resultados_alterados === 'no') eq = eq.eq('resultados_alterados', false);

    const { data: evaluaciones } = await eq;

    // Filtro modo_flujo en JS (null se trata como apelacion_jurado)
    let evsFiltradas = evaluaciones || [];
    if (modo_flujo === 'descuento_automatico') {
        evsFiltradas = evsFiltradas.filter(e => e.modo_flujo === 'descuento_automatico');
    } else if (modo_flujo === 'apelacion_jurado') {
        evsFiltradas = evsFiltradas.filter(e => !e.modo_flujo || e.modo_flujo === 'apelacion_jurado');
    }

    const evalPorRodeo = {};
    for (const ev of evsFiltradas) evalPorRodeo[ev.rodeo_id] = ev;
    const evalIds = evsFiltradas.map(e => e.id);

    // Datos del monitor
    const { data: datosMonitorList } = await supabase
        .from('datos_monitor_rodeo')
        .select('rodeo_id, puntaje_oficial_1er, puntaje_oficial_2do, puntaje_oficial_3er, comentario_monitor')
        .in('rodeo_id', rodeoIds);
    const monitorPorRodeo = {};
    for (const dm of (datosMonitorList || [])) monitorPorRodeo[dm.rodeo_id] = dm;

    // Asignaciones
    const { data: asigs } = await supabase.from('asignaciones')
        .select('rodeo_id, tipo_persona, estado_designacion, nombre_importado, usuarios_pagados(id, nombre_completo)')
        .in('rodeo_id', rodeoIds)
        .eq('estado', 'activo')
        .neq('estado_designacion', 'rechazado');

    const juradosPorRodeo = {}, delegadosPorRodeo = {};
    for (const a of (asigs || [])) {
        const nombre = a.usuarios_pagados?.nombre_completo || a.nombre_importado;
        if (!nombre) continue;
        if (a.tipo_persona === 'jurado') {
            if (!juradosPorRodeo[a.rodeo_id]) juradosPorRodeo[a.rodeo_id] = [];
            juradosPorRodeo[a.rodeo_id].push(nombre);
        } else if (a.tipo_persona === 'delegado_rentado') {
            if (!delegadosPorRodeo[a.rodeo_id]) delegadosPorRodeo[a.rodeo_id] = [];
            delegadosPorRodeo[a.rodeo_id].push(nombre);
        }
    }

    // Ciclos, casos y comentarios DA
    const statsPorEval = {};
    const cicloMap = {};
    const cicloPorEvalNum = {};
    const comentDAMap = {};

    if (evalIds.length > 0) {
        const { data: ciclos } = await supabase.from('evaluacion_ciclos')
            .select('id, evaluacion_id, numero_ciclo, estado, es_ciclo_sin_casos, comentario_sin_casos')
            .in('evaluacion_id', evalIds);

        const cicloIds = (ciclos || []).map(c => c.id);
        for (const c of (ciclos || [])) {
            cicloMap[c.id] = c;
            if (!cicloPorEvalNum[c.evaluacion_id]) cicloPorEvalNum[c.evaluacion_id] = {};
            cicloPorEvalNum[c.evaluacion_id][c.numero_ciclo] = c;
        }

        if (cicloIds.length > 0) {
            const { data: casos } = await supabase.from('evaluacion_casos')
                .select('ciclo_id, tipo_caso, descuento_puntos, resolucion_final, estado')
                .in('ciclo_id', cicloIds);

            for (const caso of (casos || [])) {
                const ciclo = cicloMap[caso.ciclo_id];
                if (!ciclo) continue;
                const eid = ciclo.evaluacion_id;
                const num = ciclo.numero_ciclo;
                if (!statsPorEval[eid]) statsPorEval[eid] = {
                    c1_total: 0, c1_desc_efectivo: 0, c1_revertidos: 0, c1_pendiente_comision: 0,
                    c2_total: 0, c2_desc_efectivo: 0, c2_revertidos: 0, c2_pendiente_comision: 0,
                    reglamentarias: 0, interpretativas: 0, informativos: 0,
                    apelaciones_acogidas: 0, apelaciones_rechazadas: 0, derivadas_comision: 0
                };
                const s = statsPorEval[eid];
                if (num === 1) {
                    s.c1_total++;
                    if (RESOL_EFECTIVAS.has(caso.resolucion_final)) s.c1_desc_efectivo += (caso.descuento_puntos || 0);
                    if (caso.resolucion_final === 'sin_descuento') s.c1_revertidos++;
                    if (caso.estado === 'derivado_comision') s.c1_pendiente_comision++;
                }
                if (num === 2) {
                    s.c2_total++;
                    if (RESOL_EFECTIVAS.has(caso.resolucion_final)) s.c2_desc_efectivo += (caso.descuento_puntos || 0);
                    if (caso.resolucion_final === 'sin_descuento') s.c2_revertidos++;
                    if (caso.estado === 'derivado_comision') s.c2_pendiente_comision++;
                }
                if (caso.tipo_caso === 'reglamentaria')  s.reglamentarias++;
                if (caso.tipo_caso === 'interpretativa') s.interpretativas++;
                if (caso.tipo_caso === 'informativo')    s.informativos++;
                if (caso.resolucion_final === 'apelacion_acogida')   s.apelaciones_acogidas++;
                if (caso.resolucion_final === 'apelacion_rechazada') s.apelaciones_rechazadas++;
                if (caso.estado === 'derivado_comision')             s.derivadas_comision++;
            }

            // Comentarios del jurado por ciclo (modo descuento_automatico)
            const { data: comentariosDA } = await supabase
                .from('evaluacion_comentarios_jurado_ciclo')
                .select('ciclo_id, comentario, asignacion_id')
                .in('ciclo_id', cicloIds)
                .eq('estado', 'enviado');

            if (comentariosDA?.length > 0) {
                const comentAsigIds = [...new Set(comentariosDA.map(c => c.asignacion_id))];
                const { data: asigNames } = await supabase
                    .from('asignaciones')
                    .select('id, nombre_importado, usuarios_pagados(nombre_completo)')
                    .in('id', comentAsigIds);
                const asigNombreMap = {};
                for (const a of (asigNames || [])) {
                    asigNombreMap[a.id] = a.usuarios_pagados?.nombre_completo || a.nombre_importado || 'Jurado';
                }
                for (const c of comentariosDA) {
                    if (!comentDAMap[c.ciclo_id]) comentDAMap[c.ciclo_id] = [];
                    comentDAMap[c.ciclo_id].push({
                        nombre: asigNombreMap[c.asignacion_id] || 'Jurado',
                        comentario: c.comentario
                    });
                }
            }
        }
    }

    // Cartillas
    const cartillasPorRodeo = {};
    if (rodeoIds.length > 0) {
        const { data: cartillas } = await supabase.from('cartillas_jurado')
            .select('id, rodeo_id, estado, datos, enviada_en, storage_path_pdf').in('rodeo_id', rodeoIds).eq('es_actual', true);
        for (const c of (cartillas || [])) {
            if (!cartillasPorRodeo[c.rodeo_id]) cartillasPorRodeo[c.rodeo_id] = [];
            cartillasPorRodeo[c.rodeo_id].push(c);
        }
    }

    // Construir filas
    const filas = rodeos.map(rodeo => {
        const ev    = evalPorRodeo[rodeo.id] || null;
        const dm    = monitorPorRodeo[rodeo.id] || null;
        const stats = ev ? (statsPorEval[ev.id] || null) : null;
        const carts = cartillasPorRodeo[rodeo.id] || [];
        const modoFlujo = ev?.modo_flujo || 'apelacion_jurado';

        const c1Obj = ev ? (cicloPorEvalNum[ev.id]?.[1] || null) : null;
        const c2Obj = ev ? (cicloPorEvalNum[ev.id]?.[2] || null) : null;
        const c1_sin_casos = !!(c1Obj?.es_ciclo_sin_casos);
        const c2_sin_casos = !!(c2Obj?.es_ciclo_sin_casos);

        // Obs jurado legacy (cartillas)
        const obsJuradoLegacy = carts
            .filter(c => c.estado === 'enviada' && c.datos?.observaciones_finales?.trim())
            .map(c => c.datos.observaciones_finales.trim()).join(' | ');

        // Obs jurado DA (comentarios generales por ciclo)
        let obsJuradoDA = '';
        if (modoFlujo === 'descuento_automatico') {
            const partes = [];
            for (const [num, cicloObj] of [[1, c1Obj], [2, c2Obj]]) {
                if (!cicloObj || cicloObj.estado === 'pendiente_carga') continue;
                const prefix = `C${num}`;
                if (cicloObj.es_ciclo_sin_casos) {
                    partes.push(`${prefix}: No requiere comentario - ciclo sin casos`);
                } else {
                    const coms = comentDAMap[cicloObj.id] || [];
                    if (coms.length === 0) {
                        partes.push(`${prefix}: Sin comentario del jurado`);
                    } else {
                        partes.push(...coms.map(c => `${prefix} - ${c.nombre}: ${c.comentario}`));
                    }
                }
            }
            obsJuradoDA = partes.join(' | ');
        }

        const estadoCartilla = carts.length > 0
            ? (carts.some(c => c.estado === 'enviada') ? 'enviada'
                : carts.some(c => c.estado === 'reabierta') ? 'reabierta' : 'borrador')
            : 'sin_cartilla';
        const fechaEnvioCartilla = carts.find(c => c.estado === 'enviada')?.enviada_en || null;
        const cartillaEnviada    = carts.find(c => c.estado === 'enviada') || null;
        const cartilla_id        = cartillaEnviada?.id || null;
        const cartilla_tiene_pdf = !!(cartillaEnviada?.storage_path_pdf);

        const po1 = dm?.puntaje_oficial_1er ?? null;
        const po2 = dm?.puntaje_oficial_2do ?? null;
        const po3 = dm?.puntaje_oficial_3er ?? null;

        const dif1 = po1 != null && ev?.puntaje_analista_1er != null
            ? parseFloat((po1 - ev.puntaje_analista_1er).toFixed(2)) : null;
        const dif2 = po2 != null && ev?.puntaje_analista_2do != null
            ? parseFloat((po2 - ev.puntaje_analista_2do).toFixed(2)) : null;
        const dif3 = po3 != null && ev?.puntaje_analista_3er != null
            ? parseFloat((po3 - ev.puntaje_analista_3er).toFixed(2)) : null;

        const c1_desc_efectivo      = stats?.c1_desc_efectivo      || 0;
        const c2_desc_efectivo      = stats?.c2_desc_efectivo      || 0;
        const c1_pendiente_comision = stats?.c1_pendiente_comision || 0;
        const c2_pendiente_comision = stats?.c2_pendiente_comision || 0;

        return {
            rodeo_id:   rodeo.id,
            eval_id:    ev?.id || null,
            fecha:      rodeo.fecha,
            club:       rodeo.club,
            asociacion: rodeo.asociacion,
            tipo_rodeo: rodeo.tipo_rodeo_nombre || '',
            categoria_rodeo: rodeo.categoria_rodeo_nombre || '',
            jurados:    (juradosPorRodeo[rodeo.id] || []).join(', '),
            delegados:  (delegadosPorRodeo[rodeo.id] || []).join(', '),
            estado_evaluacion: ev?.estado || null,
            modo_flujo:        modoFlujo,
            nota_final: ev?.nota_final != null ? parseFloat(ev.nota_final).toFixed(2) : null,
            puntaje_oficial_1er:  po1,
            puntaje_oficial_2do:  po2,
            puntaje_oficial_3er:  po3,
            puntaje_analista_1er: ev?.puntaje_analista_1er ?? null,
            puntaje_analista_2do: ev?.puntaje_analista_2do ?? null,
            puntaje_analista_3er: ev?.puntaje_analista_3er ?? null,
            diferencia_1er: dif1,
            diferencia_2do: dif2,
            diferencia_3er: dif3,
            resultados_alterados:            ev?.resultados_alterados || false,
            comentario_resultados_alterados: ev?.comentario_resultados_alterados || '',
            // C1
            c1_total:             stats?.c1_total || 0,
            c1_desc:              c1_desc_efectivo,
            c1_revertidos:        stats?.c1_revertidos        || 0,
            c1_pendiente_comision: c1_pendiente_comision,
            c1_sin_casos:         c1_sin_casos,
            c1_comentario_sin_casos: c1Obj?.comentario_sin_casos || '',
            // C2
            c2_total:             stats?.c2_total || 0,
            c2_desc:              c2_desc_efectivo,
            c2_revertidos:        stats?.c2_revertidos        || 0,
            c2_pendiente_comision: c2_pendiente_comision,
            c2_sin_casos:         c2_sin_casos,
            c2_comentario_sin_casos: c2Obj?.comentario_sin_casos || '',
            // Totales
            total_desc:              c1_desc_efectivo + c2_desc_efectivo,
            pendiente_comision_total: c1_pendiente_comision + c2_pendiente_comision,
            // Tipo
            reglamentarias:         stats?.reglamentarias || 0,
            interpretativas:        stats?.interpretativas || 0,
            informativos:           stats?.informativos    || 0,
            apelaciones_acogidas:   stats?.apelaciones_acogidas   || 0,
            apelaciones_rechazadas: stats?.apelaciones_rechazadas || 0,
            derivadas_comision:     stats?.derivadas_comision     || 0,
            // Observaciones
            obs_jurado:   modoFlujo === 'descuento_automatico' ? obsJuradoDA : obsJuradoLegacy,
            obs_admin:    rodeo.observacion || '',
            obs_monitor:  dm?.comentario_monitor || '',
            obs_analista: ev?.observacion_general || '',
            // Cartilla
            estado_cartilla:      estadoCartilla,
            cartilla_recibida:    estadoCartilla === 'enviada',
            cartilla_id:          cartilla_id,
            cartilla_tiene_pdf:   cartilla_tiene_pdf,
            fecha_envio_cartilla: fechaEnvioCartilla,
            eval_updated_at: ev?.updated_at || null
        };
    });

    return { data: filas, total: count || 0 };
}

// GET /api/admin/reporte-deportivo
router.get('/', async (req, res) => {
    try {
        const resultado = await obtenerDatos(req.query);
        res.json(resultado);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/admin/reporte-deportivo/export
router.get('/export', async (req, res) => {
    try {
        const { data: filas } = await obtenerDatos(req.query, false);

        const wb = new ExcelJS.Workbook();
        wb.creator = 'Sistema Jurados - Rodeo Chileno';
        wb.created = new Date();
        const ws = wb.addWorksheet('Reporte Deportivo');

        const MODO_LABEL = { descuento_automatico: 'Descuento automático', apelacion_jurado: 'Apelación jurado' };

        ws.columns = [
            // ── Columnas existentes (orden conservado) ──
            { header: 'Fecha',                      key: 'fecha',            width: 14 },
            { header: 'Club',                       key: 'club',             width: 28 },
            { header: 'Asociación',                 key: 'asociacion',       width: 22 },
            { header: 'Tipo Rodeo',                 key: 'tipo_rodeo',       width: 22 },
            { header: 'Categoría',                  key: 'categoria_rodeo',  width: 16 },
            { header: 'Jurado(s)',                  key: 'jurados',          width: 30 },
            { header: 'Delegado Rentado',           key: 'delegados',        width: 25 },
            { header: 'Estado Evaluación',          key: 'estado_evaluacion',width: 18 },
            { header: 'Nota Final',                 key: 'nota_final',       width: 10 },
            { header: 'Oficial 1er Lugar',          key: 'puntaje_oficial_1er',  width: 14 },
            { header: 'Oficial 2do Lugar',          key: 'puntaje_oficial_2do',  width: 14 },
            { header: 'Oficial 3er Lugar',          key: 'puntaje_oficial_3er',  width: 14 },
            { header: 'Revisado 1er Lugar',         key: 'puntaje_analista_1er', width: 14 },
            { header: 'Revisado 2do Lugar',         key: 'puntaje_analista_2do', width: 14 },
            { header: 'Revisado 3er Lugar',         key: 'puntaje_analista_3er', width: 14 },
            { header: 'Resultado Alterado',         key: 'resultados_alterados', width: 16 },
            { header: 'Com. Alteración',            key: 'comentario_resultados_alterados', width: 35 },
            { header: 'Total Situaciones',          key: 'total_sit',        width: 16 },
            { header: 'Sit. Ciclo 1 - Primeros 3', key: 'c1_total',         width: 20 },
            { header: 'Sit. Ciclo 2 - Campeones',  key: 'c2_total',         width: 20 },
            { header: 'Apreciación',                key: 'interpretativas',  width: 14 },
            { header: 'Reglamentaria',              key: 'reglamentarias',   width: 14 },
            { header: 'Conceptual',                 key: 'informativos',     width: 14 },
            { header: 'Estado Cartilla',            key: 'estado_cartilla',  width: 16 },
            { header: 'Cartilla Recibida',          key: 'cartilla_recibida', width: 16 },
            { header: 'Obs. Jurado',                key: 'obs_jurado',       width: 50 },
            { header: 'Obs. Jefe Deportivo',        key: 'obs_admin',        width: 40 },
            { header: 'Obs. Monitor',               key: 'obs_monitor',      width: 40 },
            { header: 'Obs. Análisis Técnico',      key: 'obs_analista',     width: 40 },
            // ── Nuevas columnas (agregadas al final) ──
            { header: 'Modo Evaluación',            key: 'modo_evaluacion',  width: 22 },
            { header: 'C1 Desc. Efectivo',          key: 'c1_desc',          width: 16 },
            { header: 'C1 Revertidos',              key: 'c1_revertidos',    width: 14 },
            { header: 'C1 Pend. Comisión',          key: 'c1_pendiente_comision', width: 16 },
            { header: 'C1 Sin Casos',               key: 'c1_sin_casos_txt', width: 12 },
            { header: 'C1 Comentario Sin Casos',    key: 'c1_comentario_sin_casos', width: 40 },
            { header: 'C2 Desc. Efectivo',          key: 'c2_desc',          width: 16 },
            { header: 'C2 Revertidos',              key: 'c2_revertidos',    width: 14 },
            { header: 'C2 Pend. Comisión',          key: 'c2_pendiente_comision', width: 16 },
            { header: 'C2 Sin Casos',               key: 'c2_sin_casos_txt', width: 12 },
            { header: 'C2 Comentario Sin Casos',    key: 'c2_comentario_sin_casos', width: 40 },
            { header: 'Total Desc. Efectivo',       key: 'total_desc',       width: 18 },
            { header: 'Pend. Comisión Total',       key: 'pendiente_comision_total', width: 18 },
            { header: 'Casos Derivados Comisión',   key: 'derivadas_comision', width: 20 },
            { header: 'Apelaciones Acogidas',       key: 'apelaciones_acogidas',   width: 20 },
            { header: 'Apelaciones Rechazadas',     key: 'apelaciones_rechazadas', width: 20 },
        ];

        ws.getRow(1).eachCell(cell => {
            cell.font      = HEADER_STYLE.font;
            cell.fill      = HEADER_STYLE.fill;
            cell.alignment = HEADER_STYLE.alignment;
            cell.border    = HEADER_STYLE.border;
        });
        ws.getRow(1).height = 22;
        ws.views = [{ state: 'frozen', ySplit: 1 }];

        const ROJO_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDEBD0' } };
        const VERDE_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9F7EF' } };

        for (const f of filas) {
            const row = ws.addRow({
                fecha:            fmtFecha(f.fecha),
                club:             f.club,
                asociacion:       f.asociacion,
                tipo_rodeo:       f.tipo_rodeo,
                categoria_rodeo:  f.categoria_rodeo,
                jurados:          f.jurados,
                delegados:        f.delegados,
                estado_evaluacion: f.estado_evaluacion || 'Sin evaluación',
                nota_final:       f.nota_final != null ? Number(f.nota_final) : '',
                puntaje_oficial_1er:  f.puntaje_oficial_1er  != null ? Number(f.puntaje_oficial_1er)  : '',
                puntaje_oficial_2do:  f.puntaje_oficial_2do  != null ? Number(f.puntaje_oficial_2do)  : '',
                puntaje_oficial_3er:  f.puntaje_oficial_3er  != null ? Number(f.puntaje_oficial_3er)  : '',
                puntaje_analista_1er: f.puntaje_analista_1er != null ? Number(f.puntaje_analista_1er) : '',
                puntaje_analista_2do: f.puntaje_analista_2do != null ? Number(f.puntaje_analista_2do) : '',
                puntaje_analista_3er: f.puntaje_analista_3er != null ? Number(f.puntaje_analista_3er) : '',
                resultados_alterados: f.resultados_alterados ? 'SÍ' : 'NO',
                comentario_resultados_alterados: f.comentario_resultados_alterados,
                total_sit:        f.c1_total + f.c2_total,
                c1_total:         f.c1_total,
                c2_total:         f.c2_total,
                interpretativas:  f.interpretativas,
                reglamentarias:   f.reglamentarias,
                informativos:     f.informativos,
                estado_cartilla:  f.estado_cartilla,
                cartilla_recibida: f.cartilla_recibida ? 'Sí' : 'No',
                obs_jurado:       f.obs_jurado,
                obs_admin:        f.obs_admin,
                obs_monitor:      f.obs_monitor,
                obs_analista:     f.obs_analista,
                // nuevos
                modo_evaluacion:  MODO_LABEL[f.modo_flujo] || f.modo_flujo,
                c1_desc:          f.c1_desc,
                c1_revertidos:    f.c1_revertidos,
                c1_pendiente_comision: f.c1_pendiente_comision,
                c1_sin_casos_txt: f.c1_sin_casos ? 'Sí' : 'No',
                c1_comentario_sin_casos: f.c1_comentario_sin_casos,
                c2_desc:          f.c2_desc,
                c2_revertidos:    f.c2_revertidos,
                c2_pendiente_comision: f.c2_pendiente_comision,
                c2_sin_casos_txt: f.c2_sin_casos ? 'Sí' : 'No',
                c2_comentario_sin_casos: f.c2_comentario_sin_casos,
                total_desc:       f.total_desc,
                pendiente_comision_total: f.pendiente_comision_total,
                derivadas_comision:     f.derivadas_comision,
                apelaciones_acogidas:   f.apelaciones_acogidas,
                apelaciones_rechazadas: f.apelaciones_rechazadas,
            });

            if (f.resultados_alterados) {
                row.eachCell(cell => { cell.fill = ROJO_FILL; });
            } else if (f.modo_flujo === 'descuento_automatico') {
                row.eachCell(cell => { cell.fill = VERDE_FILL; });
            }
        }

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="reporte_deportivo_${new Date().toISOString().slice(0,10)}.xlsx"`);
        await wb.xlsx.write(res);
        res.end();
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
