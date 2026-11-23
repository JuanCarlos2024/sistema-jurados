const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const { soloRolEvaluacion, soloNoComisionTecnica } = require('../../middleware/auth');
const { intentarAutoPublicar, generarRevisionResultadoAlterado, contarPendientesComision } = require('../../services/publicacion');
const { mensajeErrorComision } = require('../../services/erroresComision');
const { resumenComisionPorEvaluacion, filtroEvaluacionesPorComision } = require('../../services/revisionesComision');
const { normalizarCasosWhatsapp, normalizarDesgloseWhatsapp, validarSumaDesglose } = require('../../services/casosWhatsapp');
const { cargarConfiguracion, crearEvaluacion } = require('../../services/evaluacionCreacion');

// ─── Listado de Análisis de Casos (pantalla y exportación) ────────────────
// Una sola función para ambos: la exportación Excel respeta EXACTAMENTE los
// mismos filtros que la pantalla. Filtros nuevos (migración 103):
//   resultados_alterados = si|no          (evaluaciones.resultados_alterados real)
//   derivado_comision    = si|no          (tiene o no revisiones de Comisión)
//   estado_comision      = pendiente|en_revision|resuelto
//   resolucion           = error|acierto  (al menos una decisión con ese valor)
// paginar=false → todas las filas que cumplen (por lotes, sin el tope de 1000
// filas de PostgREST), sin paginar.
async function listarEvaluaciones(q, { paginar = true } = {}) {
    const {
        estado, analista_id, buscar, respuesta_estado, fecha_desde, fecha_hasta, page = 1, limit = 20,
        resultados_alterados, derivado_comision, estado_comision, resolucion
    } = q;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Pre-queries para búsqueda textual cruzada
    let rodeoIdsFiltro   = null;
    let analistaIdsFiltro = null;

    if (buscar) {
        const b = buscar.trim();
        const [{ data: rodeosMatch }, { data: analistasMatch }, { data: juraAsigs }] = await Promise.all([
            supabase.from('rodeos')
                .select('id')
                .or(`club.ilike.%${b}%,asociacion.ilike.%${b}%`),
            supabase.from('administradores')
                .select('id')
                .ilike('nombre_completo', `%${b}%`),
            supabase.from('asignaciones')
                .select('rodeo_id, usuarios_pagados!inner(nombre_completo)')
                .eq('tipo_persona', 'jurado')
                .eq('estado', 'activo')
                .ilike('usuarios_pagados.nombre_completo', `%${b}%`)
        ]);

        const rodeoIdsTexto    = (rodeosMatch   || []).map(r => r.id);
        const juradoRodeoIds   = (juraAsigs     || []).map(a => a.rodeo_id);
        rodeoIdsFiltro   = [...new Set([...rodeoIdsTexto, ...juradoRodeoIds])];
        analistaIdsFiltro = (analistasMatch || []).map(a => a.id);
    }

    // Filtro por rango de fecha del rodeo
    let rodeoIdsFecha = null;
    if (fecha_desde || fecha_hasta) {
        let fq = supabase.from('rodeos').select('id');
        if (fecha_desde) fq = fq.gte('fecha', fecha_desde);
        if (fecha_hasta) fq = fq.lte('fecha', fecha_hasta);
        const { data: rodeosF } = await fq;
        rodeoIdsFecha = (rodeosF || []).map(r => r.id);
        if (rodeoIdsFecha.length === 0) return { evaluaciones: [], total: 0 };
    }

    // Filtros de Comisión (migración 103) → ids a incluir/excluir.
    const filtroComision = await filtroEvaluacionesPorComision({
        derivado: derivado_comision === 'si' || derivado_comision === 'no' ? derivado_comision : null,
        estado_comision: ['pendiente', 'en_revision', 'resuelto'].includes(estado_comision) ? estado_comision : null,
        resolucion: ['error', 'acierto'].includes(resolucion) ? resolucion : null
    });
    if (filtroComision.incluir && filtroComision.incluir.length === 0) return { evaluaciones: [], total: 0 };

    // Búsqueda textual (OR) — se arma una vez y se reutiliza en cada lote.
    let orBuscar = null;
    if (buscar) {
        const b = buscar.trim();
        const orParts = [];
        if (rodeoIdsFiltro && rodeoIdsFiltro.length > 0)
            orParts.push(`rodeo_id.in.(${rodeoIdsFiltro.join(',')})`);
        if (analistaIdsFiltro && analistaIdsFiltro.length > 0)
            orParts.push(`analista_id.in.(${analistaIdsFiltro.join(',')})`);
        // estado exact match si el término coincide
        const estadoMatch = ['borrador','en_proceso','pendiente_comision','pendiente_aprobacion','devuelto','aprobado','publicado','cerrado']
            .find(e => e.includes(b.toLowerCase()));
        if (estadoMatch) orParts.push(`estado.eq.${estadoMatch}`);
        if (orParts.length > 0) orBuscar = orParts.join(',');
        else return { evaluaciones: [], total: 0 };
    }

    // Cuando hay filtro por respuesta_estado, cargamos un lote amplio y filtramos en memoria
    const hasRespFiltro = !!respuesta_estado;

    const construir = () => {
        let query = supabase
            .from('evaluaciones')
            .select(`
                id, estado, created_at, analista_id, rodeo_id, nota_final, resultados_alterados,
                rodeo:rodeos(id, club, fecha, asociacion),
                analista:analista_id(id, nombre_completo)
            `, { count: 'exact' })
            .order('created_at', { ascending: false })
            .eq('anulada', false)
            .eq('es_historica_importacion', false);       // el listado operativo no incluye los registros históricos (solo Casos por WhatsApp)

        if (estado)             query = query.eq('estado', estado);
        if (analista_id)        query = query.eq('analista_id', analista_id);
        if (rodeoIdsFecha !== null) query = query.in('rodeo_id', rodeoIdsFecha);
        if (resultados_alterados === 'si') query = query.eq('resultados_alterados', true);
        if (resultados_alterados === 'no') query = query.eq('resultados_alterados', false);
        if (filtroComision.incluir) query = query.in('id', filtroComision.incluir);
        if (filtroComision.excluir && filtroComision.excluir.length > 0)
            query = query.not('id', 'in', `(${filtroComision.excluir.join(',')})`);
        if (orBuscar) query = query.or(orBuscar);
        return query;
    };

    let data = [], count = 0;
    if (paginar) {
        const query = hasRespFiltro ? construir().limit(300) : construir().range(offset, offset + parseInt(limit) - 1);
        const r = await query;
        if (r.error) return { error: r.error };
        data = r.data || []; count = r.count || 0;
    } else {
        const LOTE = 1000;
        for (let desde = 0; ; desde += LOTE) {
            const r = await construir().range(desde, desde + LOTE - 1);
            if (r.error) return { error: r.error };
            data.push(...(r.data || []));
            count = r.count ?? data.length;
            if (!r.data || r.data.length < LOTE) break;
        }
    }

    const evaluaciones = data || [];
    if (evaluaciones.length === 0) {
        return { evaluaciones: [], total: count || 0 };
    }

    const evalIds  = evaluaciones.map(e => e.id);
    const rodeoIds = [...new Set(evaluaciones.map(e => e.rodeo_id))];

    const [{ data: casos }, { data: asigs }, { data: ciclosData }, comisionPorEval] = await Promise.all([
        supabase
            .from('evaluacion_casos')
            .select('evaluacion_id, tipo_caso')
            .in('evaluacion_id', evalIds),
        supabase
            .from('asignaciones')
            .select('id, rodeo_id, estado_designacion, nombre_importado, usuarios_pagados(id, nombre_completo, categoria)')
            .in('rodeo_id', rodeoIds)
            .eq('tipo_persona', 'jurado')
            .eq('estado', 'activo'),
        supabase
            .from('evaluacion_ciclos')
            .select('id, evaluacion_id, numero_ciclo, estado, fecha_limite_respuesta, notificacion_enviada_at')
            .in('evaluacion_id', evalIds)
            .order('numero_ciclo'),
        resumenComisionPorEvaluacion(evalIds)
    ]);

    const casosPorEval = {};
    for (const c of (casos || [])) {
        if (!casosPorEval[c.evaluacion_id]) casosPorEval[c.evaluacion_id] = { reglamentarias: 0, interpretativas: 0, informativos: 0 };
        if (c.tipo_caso === 'reglamentaria')  casosPorEval[c.evaluacion_id].reglamentarias++;
        if (c.tipo_caso === 'interpretativa') casosPorEval[c.evaluacion_id].interpretativas++;
        if (c.tipo_caso === 'informativo')    casosPorEval[c.evaluacion_id].informativos++;
    }
    for (const rf of Object.values(casosPorEval)) {
        rf.puntos_descontados = rf.reglamentarias * 1 + rf.interpretativas * 1;
    }

    const juradosPorRodeo = {};
    for (const a of (asigs || [])) {
        if (a.estado_designacion === 'rechazado') continue;
        if (!juradosPorRodeo[a.rodeo_id]) juradosPorRodeo[a.rodeo_id] = [];
        const nombre_completo = a.usuarios_pagados?.nombre_completo || a.nombre_importado;
        if (!nombre_completo) continue;
        juradosPorRodeo[a.rodeo_id].push({
            id:             a.usuarios_pagados?.id    || null,
            nombre_completo,
            categoria:      a.usuarios_pagados?.categoria || null,
            asignacion_id:  a.id
        });
    }

    const ciclosPorEval = {};
    for (const c of (ciclosData || [])) {
        if (!ciclosPorEval[c.evaluacion_id]) ciclosPorEval[c.evaluacion_id] = {};
        ciclosPorEval[c.evaluacion_id][c.numero_ciclo] = c;
    }

    // Batch: stats de respuestas por ciclo
    const cicloIds = (ciclosData || []).map(c => c.id);
    const respStatsPorCiclo = {};

    if (cicloIds.length > 0) {
        const { data: casosCiclos } = await supabase
            .from('evaluacion_casos')
            .select('id, ciclo_id')
            .in('ciclo_id', cicloIds);

        if (casosCiclos && casosCiclos.length > 0) {
            const casoIdsLista = casosCiclos.map(c => c.id);
            const casoToCiclo  = {};
            for (const c of casosCiclos) casoToCiclo[c.id] = c.ciclo_id;

            const { data: respList } = await supabase
                .from('evaluacion_respuestas_jurado')
                .select('caso_id, decision, asignacion_id')
                .in('caso_id', casoIdsLista);

            for (const c of casosCiclos) {
                if (!respStatsPorCiclo[c.ciclo_id])
                    respStatsPorCiclo[c.ciclo_id] = { asignaciones: new Set(), tiene_rechazos: false };
            }
            for (const r of (respList || [])) {
                const cid = casoToCiclo[r.caso_id];
                if (!cid) continue;
                if (!respStatsPorCiclo[cid]) respStatsPorCiclo[cid] = { asignaciones: new Set(), tiene_rechazos: false };
                respStatsPorCiclo[cid].asignaciones.add(r.asignacion_id);
                if (r.decision === 'rechaza') respStatsPorCiclo[cid].tiene_rechazos = true;
            }
        }
    }

    const enrichCiclo = (ciclo, juradosRodeo) => {
        if (!ciclo) return null;
        const stats = respStatsPorCiclo[ciclo.id] || {};
        return {
            ...ciclo,
            total_jurados:      (juradosRodeo || []).length,
            total_respondieron: stats.asignaciones ? stats.asignaciones.size : 0,
            tiene_rechazos:     stats.tiene_rechazos || false
        };
    };

    let resultado = evaluaciones.map(ev => {
        const jurados = juradosPorRodeo[ev.rodeo_id] || [];
        return {
            ...ev,
            jurados,
            resumen_faltas: casosPorEval[ev.id] || null,
            ciclo1: enrichCiclo(ciclosPorEval[ev.id]?.[1], jurados),
            ciclo2: enrichCiclo(ciclosPorEval[ev.id]?.[2], jurados),
            comision: comisionPorEval[ev.id]
        };
    });

    // Filtro en memoria por respuesta_estado
    if (hasRespFiltro) {
        resultado = resultado.filter(ev => {
            const ciclos       = [ev.ciclo1, ev.ciclo2].filter(Boolean);
            const activos      = ciclos.filter(c => ['abierto', 'en_revision', 'cerrado'].includes(c.estado));
            const totalResp    = ciclos.reduce((s, c) => s + (c.total_respondieron || 0), 0);
            const hasRechazos  = ciclos.some(c => c.tiene_rechazos);
            const totalJurados = (ev.jurados || []).length;
            const completa     = activos.length > 0 && activos.every(c => totalJurados > 0 && (c.total_respondieron || 0) >= totalJurados);

            switch (respuesta_estado) {
                case 'con_respuestas':       return totalResp > 0;
                case 'sin_respuestas':       return totalResp === 0;
                case 'respondida_completa':  return completa;
                case 'pendiente_respuesta':  return !completa && activos.length > 0;
                case 'con_rechazos':         return hasRechazos;
                default:                     return true;
            }
        });
    }

    if (!paginar) return { evaluaciones: resultado, total: resultado.length };

    const totalFinal = hasRespFiltro ? resultado.length : (count || 0);
    const pageData   = hasRespFiltro ? resultado.slice(offset, offset + parseInt(limit)) : resultado;

    return { evaluaciones: pageData, total: totalFinal };
}

// GET / — lista paginada con filtros, jurados y resumen de faltas
router.get('/', async (req, res) => {
    try {
        const r = await listarEvaluaciones(req.query, { paginar: true });
        if (r.error) return res.status(500).json({ error: r.error.message });
        res.json({ evaluaciones: r.evaluaciones, total: r.total });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /exportar — Excel del listado con los MISMOS filtros activos.
// Exactamente 9 columnas en este orden (encabezados repetidos a propósito):
//   A Club · B Asociación · C Fecha · D Analista (nombre si está designado) ·
//   E Estado (vacía) · F Asociación (repite B) · G Analista (vacía) ·
//   H Estado (vacía) · I N° de collera (vacía).
// Una fila por evaluación (la consulta base nunca se multiplica por casos,
// videos ni revisiones). Las celdas indicadas quedan realmente vacías.
const ENCABEZADOS_EXPORTACION_ANALISIS = ['Club', 'Asociación', 'Fecha', 'Analista', 'Estado', 'Asociación', 'Analista', 'Estado', 'N° de collera'];

function filasExportacionAnalisis(evaluaciones) {
    const fmtFecha = (f) => {
        if (!f) return null;
        const [y, m, d] = String(f).split('T')[0].split('-');
        return d && m && y ? `${d}/${m}/${y}` : null;
    };
    const vistos = new Set();
    const filas = [];
    for (const ev of evaluaciones) {
        if (vistos.has(ev.id)) continue;
        vistos.add(ev.id);
        filas.push([
            ev.rodeo?.club || null,
            ev.rodeo?.asociacion || null,
            fmtFecha(ev.rodeo?.fecha),
            ev.analista?.nombre_completo || null,
            null,
            ev.rodeo?.asociacion || null,
            null,
            null,
            null
        ]);
    }
    return filas;
}

router.get('/exportar', async (req, res) => {
    try {
        const r = await listarEvaluaciones(req.query, { paginar: false });
        if (r.error) return res.status(500).json({ error: r.error.message });

        const ExcelJS = require('exceljs');
        const wb = new ExcelJS.Workbook();
        wb.creator = 'Sistema Jurados - Rodeo Chileno';
        const ws = wb.addWorksheet('Análisis de Casos');
        ws.addRow(ENCABEZADOS_EXPORTACION_ANALISIS);
        ws.getRow(1).eachCell(c => {
            c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a5f' } };
            c.alignment = { horizontal: 'center', vertical: 'middle' };
        });
        for (const fila of filasExportacionAnalisis(r.evaluaciones)) {
            const row = ws.addRow(fila);
            // Columnas vacías por definición: sin valor alguno (ni '', ni guion).
            [5, 7, 8, 9].forEach(n => { row.getCell(n).value = null; });
            if (fila[3] === null) row.getCell(4).value = null;
        }
        [26, 22, 12, 28, 14, 22, 18, 14, 14].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
        ws.views = [{ state: 'frozen', ySplit: 1 }];

        const fecha = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="analisis_casos_${fecha}.xlsx"`);
        await wb.xlsx.write(res);
        res.end();
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST / — crear evaluación (solo jefe_area o admin pleno)
router.post('/', soloRolEvaluacion('jefe_area'), async (req, res) => {
    const { rodeo_id, analista_id } = req.body;
    if (!rodeo_id)    return res.status(400).json({ error: 'rodeo_id requerido' });
    if (!analista_id) return res.status(400).json({ error: 'analista_id requerido' });

    const cfg = await cargarConfiguracion(supabase);

    // Crea la evaluación normal (con sus ciclos y auditoría) o, si el rodeo tiene una evaluación HISTÓRICA importada
    // (solo Casos por WhatsApp), la convierte atómicamente en normal reutilizando la misma fila (rodeo_id es UNIQUE).
    const r = await crearEvaluacion({ supabase, cfg, rodeo_id, analista_id, actor: req.usuario, ip: req.ip });
    if (r.resultado === 'existente') return res.status(409).json({ error: 'Ya existe una evaluación para este rodeo' });
    if (r.resultado === 'error') return res.status(r.error.status).json({ error: r.error.mensaje });

    res.status(201).json(r.evaluacion);
});

// GET /rodeos-disponibles — rodeos activos + jurados + indicador tiene_evaluacion
router.get('/rodeos-disponibles', async (req, res) => {
    const { fecha_desde, fecha_hasta, asociacion, buscar } = req.query;

    let query = supabase
        .from('rodeos')
        .select('id, club, fecha, asociacion, tipo_rodeo_nombre')
        .eq('estado', 'activo')
        .order('fecha', { ascending: false })
        .limit(150);

    if (fecha_desde) query = query.gte('fecha', fecha_desde);
    if (fecha_hasta) query = query.lte('fecha', fecha_hasta);
    if (asociacion)  query = query.ilike('asociacion', `%${asociacion}%`);
    if (buscar)      query = query.or(`club.ilike.%${buscar}%,asociacion.ilike.%${buscar}%`);

    const { data: rodeos, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    if (!rodeos || rodeos.length === 0) return res.json({ rodeos: [] });

    const rodeoIds = rodeos.map(r => r.id);

    const [{ data: evals }, { data: asigs }] = await Promise.all([
        supabase.from('evaluaciones').select('rodeo_id, es_historica_importacion, anulada').in('rodeo_id', rodeoIds),
        supabase
            .from('asignaciones')
            .select('rodeo_id, estado_designacion, nombre_importado, usuarios_pagados(nombre_completo)')
            .in('rodeo_id', rodeoIds)
            .eq('tipo_persona', 'jurado')
            .eq('estado', 'activo')
    ]);

    // Una evaluación histórica vigente (solo Casos por WhatsApp) NO cuenta como evaluación realizada: el rodeo sigue disponible para evaluar.
    const evalSet = new Set((evals || []).filter(e => !(e.es_historica_importacion === true && !e.anulada)).map(e => e.rodeo_id));

    const juradosPorRodeo = {};
    for (const a of (asigs || [])) {
        if (a.estado_designacion === 'rechazado') continue;
        const nombre = a.usuarios_pagados?.nombre_completo || a.nombre_importado;
        if (!nombre) continue;
        if (!juradosPorRodeo[a.rodeo_id]) juradosPorRodeo[a.rodeo_id] = [];
        juradosPorRodeo[a.rodeo_id].push(nombre);
    }

    res.json({
        rodeos: rodeos.map(r => ({
            ...r,
            tiene_evaluacion: evalSet.has(r.id),
            jurados:          juradosPorRodeo[r.id] || []
        }))
    });
});

// POST /crear-masivo — crear evaluaciones en lote (una por rodeo_id)
router.post('/crear-masivo', soloRolEvaluacion('jefe_area'), async (req, res) => {
    const { rodeo_ids, analista_id } = req.body;

    if (!Array.isArray(rodeo_ids) || rodeo_ids.length === 0)
        return res.status(400).json({ error: 'rodeo_ids requerido (array no vacío)' });
    if (!analista_id)
        return res.status(400).json({ error: 'analista_id requerido' });

    const cfg = await cargarConfiguracion(supabase);

    const { data: existentes } = await supabase
        .from('evaluaciones')
        .select('rodeo_id, es_historica_importacion, anulada')
        .in('rodeo_id', rodeo_ids);

    // Una evaluación HISTÓRICA vigente (solo Casos por WhatsApp) no bloquea: se convierte en normal reutilizando la fila.
    const existeSet = new Set((existentes || []).filter(e => !(e.es_historica_importacion === true && !e.anulada)).map(e => e.rodeo_id));

    let creadas = 0, convertidas = 0, omitidas = 0;
    const errores = [];

    for (const rodeo_id of rodeo_ids) {
        if (existeSet.has(rodeo_id)) { omitidas++; continue; }

        const r = await crearEvaluacion({ supabase, cfg, rodeo_id, analista_id, actor: req.usuario, ip: req.ip, detalleExtra: { origen: 'masivo' } });
        if (r.resultado === 'existente') omitidas++;
        else if (r.resultado === 'error') errores.push({ rodeo_id, error: r.error.mensaje });
        else { creadas++; if (r.resultado === 'convertida') convertidas++; }
    }

    res.json({ creadas, convertidas, omitidas, errores });
});

// GET /:id — detalle con rodeo, analista, jefe, ciclos
router.get('/:id', async (req, res) => {
    const { data: ev, error } = await supabase
        .from('evaluaciones')
        .select(`
            *,
            rodeo:rodeos(id, club, fecha, asociacion, tipo_rodeo_nombre),
            analista:analista_id(id, nombre_completo),
            jefe:jefe_id(id, nombre_completo),
            ciclos:evaluacion_ciclos(*)
        `)
        .eq('id', req.params.id)
        .single();

    if (error) return res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message });

    const [{ data: asigs }, { data: datosMonitor }] = await Promise.all([
        supabase
            .from('asignaciones')
            .select('estado_designacion, nombre_importado, usuarios_pagados(id, nombre_completo, categoria)')
            .eq('rodeo_id', ev.rodeo_id)
            .eq('tipo_persona', 'jurado')
            .eq('estado', 'activo'),
        supabase
            .from('datos_monitor_rodeo')
            .select('puntaje_oficial_1er, puntaje_oficial_2do, puntaje_oficial_3er, comentario_monitor, updated_at')
            .eq('rodeo_id', ev.rodeo_id)
            .maybeSingle()
    ]);

    const jurados = (asigs || [])
        .filter(a => a.estado_designacion !== 'rechazado')
        .map(a => ({
            id:              a.usuarios_pagados?.id              || null,
            nombre_completo: a.usuarios_pagados?.nombre_completo || a.nombre_importado || null,
            categoria:       a.usuarios_pagados?.categoria       || null
        }))
        .filter(j => j.nombre_completo);

    res.json({ ...ev, jurados, datos_monitor: datosMonitor || null });
});

// PATCH /:id/analista — reasignar analista (solo jefe_area o admin pleno)
router.patch('/:id/analista', soloRolEvaluacion('jefe_area'), async (req, res) => {
    const { analista_id } = req.body;
    if (!analista_id) return res.status(400).json({ error: 'analista_id requerido' });

    const { data, error } = await supabase
        .from('evaluaciones')
        .update({ analista_id, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: req.params.id,
        accion: 'reasignar_analista',
        detalle: { analista_id },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        actor_nombre: req.usuario.nombre,
        ip_address: req.ip
    });

    res.json(data);
});

// POST /:id/enviar-aprobacion
router.post('/:id/enviar-aprobacion', soloNoComisionTecnica, async (req, res) => {
    const { data: ev, error: evErr } = await supabase
        .from('evaluaciones')
        .select('id, estado')
        .eq('id', req.params.id)
        .single();

    if (evErr) return res.status(404).json({ error: 'Evaluación no encontrada' });

    const estadosValidos = ['en_proceso', 'devuelto', 'pendiente_comision'];
    if (!estadosValidos.includes(ev.estado)) {
        return res.status(409).json({ error: `No se puede enviar desde estado: ${ev.estado}` });
    }

    const { data, error } = await supabase
        .from('evaluaciones')
        .update({ estado: 'pendiente_aprobacion', updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: req.params.id,
        accion: 'enviar_a_jefe',
        detalle: { estado_anterior: ev.estado },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        actor_nombre: req.usuario.nombre,
        ip_address: req.ip
    });

    res.json(data);
});

// Resuelve casos que ya tienen decisión en evaluacion_respuestas_jurado pero
// siguen en pendiente_analista/derivado_comision en evaluacion_casos (datos previos al fix).
async function _sincronizarCasosAntesDePublicar(evalId, now) {
    const { data: casosRaw } = await supabase
        .from('evaluacion_casos')
        .select('id, ciclo_id, tipo_caso, descuento_puntos, estado, decision_analista, decision_comision')
        .eq('evaluacion_id', evalId)
        .in('estado', ['pendiente_analista', 'derivado_comision']);

    // Migración 103: un caso que el ANALISTA derivó a la Comisión solo se
    // resuelve con la decisión de la Comisión — nunca aquí (antes se marcaba
    // como descuento confirmado sin pasar por ella).
    const casos = (casosRaw || []).filter(c => !(c.decision_analista === 'derivar_comision' && !c.decision_comision));
    if (casos.length === 0) return;

    const casoIds = casos.map(c => c.id);
    const { data: resps } = await supabase
        .from('evaluacion_respuestas_jurado')
        .select('caso_id, decision, decision_analista, decision_comite, descuento_final')
        .in('caso_id', casoIds);

    const respsPorCaso = {};
    for (const r of (resps || [])) {
        if (!respsPorCaso[r.caso_id]) respsPorCaso[r.caso_id] = [];
        respsPorCaso[r.caso_id].push(r);
    }

    const ciclosAfectados = new Set();

    for (const caso of casos) {
        const todasResps = respsPorCaso[caso.id] || [];
        const rechazas = todasResps.filter(r => r.decision === 'rechaza');

        // Si queda algún rechazo sin decisión final → no resolver este caso
        const hayPendiente = rechazas.some(r =>
            !r.decision_analista ||
            (r.decision_analista === 'derivada_comite' && !r.decision_comite)
        );
        if (hayPendiente) continue;

        // Calcular resolucion_final
        let resolucion_final;
        if (caso.tipo_caso === 'informativo' || (caso.descuento_puntos ?? 0) === 0) {
            resolucion_final = 'sin_descuento';
        } else if (rechazas.length > 0) {
            const maxDesc = Math.max(0, ...rechazas.map(r => r.descuento_final ?? 0));
            resolucion_final = maxDesc === 0
                ? 'sin_descuento'
                : (caso.tipo_caso === 'interpretativa' ? 'interpretativa_confirmada' : 'reglamentaria_confirmada');
        } else {
            // Solo acepta/sin_respuesta → fallo aceptado
            resolucion_final = caso.tipo_caso === 'interpretativa'
                ? 'interpretativa_confirmada'
                : 'reglamentaria_confirmada';
        }

        await supabase.from('evaluacion_casos').update({
            estado: 'resuelto',
            resolucion_final,
            updated_at: now
        }).eq('id', caso.id);

        ciclosAfectados.add(caso.ciclo_id);
    }

    // Cerrar ciclos donde ya no queden casos sin resolver
    for (const cicloId of ciclosAfectados) {
        const { data: noResueltos } = await supabase
            .from('evaluacion_casos')
            .select('id')
            .eq('ciclo_id', cicloId)
            .neq('estado', 'resuelto');

        if (!noResueltos || noResueltos.length === 0) {
            await supabase.from('evaluacion_ciclos')
                .update({ estado: 'cerrado', fecha_cierre: now, updated_at: now })
                .eq('id', cicloId)
                .neq('estado', 'cerrado');
        }
    }
}

// POST /:id/aprobar — publicar vía RPC (solo jefe_area o admin pleno)
router.post('/:id/aprobar', soloRolEvaluacion('jefe_area'), async (req, res) => {
    const { comentario_jefe } = req.body;
    const now = new Date().toISOString();

    // Sincronizar casos que tienen decisión en respuestas_jurado pero siguen como pendientes
    await _sincronizarCasosAntesDePublicar(req.params.id, now);

    const { data, error } = await supabase.rpc('publicar_evaluacion', {
        p_evaluacion_id: req.params.id,
        p_jefe_id:       req.usuario.id,
        p_comentario:    comentario_jefe || null,
        p_ip:            req.ip || null
    });

    if (error) {
        const msg = error.message || '';
        if (msg.includes('evaluacion_no_encontrada')) return res.status(404).json({ error: 'Evaluación no encontrada' });
        if (msg.includes('estado_invalido'))          return res.status(409).json({ error: 'La evaluación no está en estado pendiente_aprobacion' });
        if (msg.includes('casos_pendientes'))         return res.status(409).json({ error: 'Existen casos sin resolver' });
        if (msg.includes('revisiones_comision_pendientes')) return res.status(409).json({ error: 'Existen revisiones de la Comisión Técnica pendientes; la nota no puede publicarse todavía.', code: 'REVISIONES_COMISION_PENDIENTES' });
        if (msg.includes('revision_resultado_alterado_requerida')) return res.status(409).json({ error: 'Los resultados alterados deben ser revisados por la Comisión Técnica antes de publicar la nota.', code: 'REVISION_RESULTADO_ALTERADO_REQUERIDA' });
        if (msg.includes('sin_jurados'))              return res.status(409).json({ error: 'No hay jurados activos para este rodeo' });
        return res.status(500).json({ error: error.message });
    }

    res.json(data);
});

// POST /:id/devolver — devolver al analista (solo jefe_area o admin pleno)
router.post('/:id/devolver', soloRolEvaluacion('jefe_area'), async (req, res) => {
    const { comentario_jefe } = req.body;
    if (!comentario_jefe || !comentario_jefe.trim()) {
        return res.status(400).json({ error: 'comentario_jefe es obligatorio al devolver' });
    }

    const { data: ev } = await supabase
        .from('evaluaciones')
        .select('estado')
        .eq('id', req.params.id)
        .single();

    if (!ev || ev.estado !== 'pendiente_aprobacion') {
        return res.status(409).json({ error: 'Solo se puede devolver desde estado pendiente_aprobacion' });
    }

    const { data, error } = await supabase
        .from('evaluaciones')
        .update({
            estado:             'devuelto',
            decision_jefe:      'devuelto',
            comentario_jefe:    comentario_jefe.trim(),
            fecha_decision_jefe: new Date().toISOString(),
            jefe_id:            req.usuario.id,
            updated_at:         new Date().toISOString()
        })
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: req.params.id,
        accion: 'devolver_jefe',
        detalle: { comentario_jefe: comentario_jefe.trim() },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        actor_nombre: req.usuario.nombre,
        ip_address: req.ip
    });

    res.json(data);
});

// PATCH /:id/datos-deportivos — guardar análisis del analista
// Monitor usa PUT /rodeos/:id/datos-monitor para puntajes oficiales y comentario_monitor
// Este endpoint es solo para analista / jefe / admin pleno
router.patch('/:id/datos-deportivos', soloNoComisionTecnica, async (req, res) => {
    const rolEval = req.usuario.rol_evaluacion || null;
    const esMonitor = rolEval === 'monitor';

    if (esMonitor) {
        return res.status(403).json({ error: 'El Monitor guarda sus datos desde PUT /rodeos/:id/datos-monitor' });
    }

    const {
        puntaje_analista_1er, puntaje_analista_2do, puntaje_analista_3er,
        observacion_general,
        resultados_alterados,
        comentario_resultados_alterados,
        casos_whatsapp,
        casos_whatsapp_bien_jurado,
        casos_whatsapp_mal_jurado,
        fundamento_jurado,
        fundamento_jurado_publicado
    } = req.body;

    // Casos por WhatsApp: dato informativo del análisis (entero >= 0). No es notas_rodeo.nota ni entra en cálculos.
    const casosWs = normalizarCasosWhatsapp(casos_whatsapp);
    if (!casosWs.ok) return res.status(400).json({ error: casosWs.error });

    // Desglose Bien / Mal jurado (107): vacío = sin registrar; si se registra
    // debe sumar el total. Se valida contra los valores EFECTIVOS (lo que viene
    // en el PATCH o, si no viene, lo ya guardado), para que cambiar solo el
    // total nunca deje un desglose inconsistente.
    const desglose = normalizarDesgloseWhatsapp(casos_whatsapp_bien_jurado, casos_whatsapp_mal_jurado);
    if (!desglose.ok) return res.status(400).json({ error: desglose.error });
    if (casosWs.cambia || desglose.cambia) {
        const { data: wsActual, error: wsErr } = await supabase
            .from('evaluaciones')
            .select('casos_whatsapp, casos_whatsapp_bien_jurado, casos_whatsapp_mal_jurado')
            .eq('id', req.params.id)
            .single();
        if (wsErr || !wsActual) return res.status(404).json({ error: 'Evaluación no encontrada' });
        const total = casosWs.cambia ? casosWs.valor : (wsActual.casos_whatsapp || 0);
        const bien = desglose.cambia ? desglose.bien : (wsActual.casos_whatsapp_bien_jurado ?? null);
        const mal  = desglose.cambia ? desglose.mal  : (wsActual.casos_whatsapp_mal_jurado ?? null);
        const errSuma = validarSumaDesglose(bien, mal, total);
        if (errSuma) return res.status(400).json({ error: errSuma });
    }

    if (resultados_alterados === true && !comentario_resultados_alterados?.trim()) {
        return res.status(400).json({ error: 'El comentario de alteración es obligatorio cuando resultados_alterados = sí' });
    }

    // Fundamento visible para el jurado (migración 090) — separado e
    // independiente de comentario_resultados_alterados (análisis interno,
    // nunca expuesto al jurado — ver comentario de esa migración). Publicar
    // (fundamento_jurado_publicado=true) exige resultados_alterados=true y un
    // texto no vacío, considerando el valor vigente en la fila cuando el campo
    // correspondiente no viene en este PATCH puntual.
    let evActual = null;
    if (fundamento_jurado_publicado !== undefined) {
        const { data } = await supabase
            .from('evaluaciones')
            .select('resultados_alterados, fundamento_jurado')
            .eq('id', req.params.id)
            .single();
        evActual = data;
        if (fundamento_jurado_publicado) {
            const resultadosAlteradosEfectivo = resultados_alterados !== undefined ? !!resultados_alterados : !!evActual?.resultados_alterados;
            const fundamentoEfectivo = fundamento_jurado !== undefined ? fundamento_jurado : evActual?.fundamento_jurado;
            if (!resultadosAlteradosEfectivo) {
                return res.status(400).json({ error: 'Solo se puede publicar un fundamento al jurado cuando resultados_alterados = sí' });
            }
            if (!fundamentoEfectivo?.trim()) {
                return res.status(400).json({ error: 'El fundamento para el jurado no puede estar vacío si se va a publicar' });
            }
        }
    }

    const REGEX_PUNTAJE = /^\d+(\s*\+\s*\d+)?$/;
    const validarPuntaje = (v) => v === null || v === undefined || v === '' || REGEX_PUNTAJE.test(String(v).trim());
    const normalizarPuntaje = (v) => {
        if (v === null || v === undefined || v === '') return null;
        const s = String(v).trim();
        return s === '' ? null : s.replace(/\s*\+\s*/, '+');
    };

    const camposInvalidos = [
        ['1er lugar', puntaje_analista_1er],
        ['2do lugar', puntaje_analista_2do],
        ['3er lugar', puntaje_analista_3er]
    ].filter(([, v]) => v !== undefined && !validarPuntaje(v)).map(([label]) => label);

    if (camposInvalidos.length > 0) {
        return res.status(400).json({
            error: `El puntaje debe ser un número entero o un puntaje de desempate con formato 30+5 (campos inválidos: ${camposInvalidos.join(', ')})`
        });
    }

    const cambios = { updated_at: new Date().toISOString() };

    if (puntaje_analista_1er !== undefined) cambios.puntaje_analista_1er = normalizarPuntaje(puntaje_analista_1er);
    if (puntaje_analista_2do !== undefined) cambios.puntaje_analista_2do = normalizarPuntaje(puntaje_analista_2do);
    if (puntaje_analista_3er !== undefined) cambios.puntaje_analista_3er = normalizarPuntaje(puntaje_analista_3er);
    if (observacion_general !== undefined)  cambios.observacion_general  = observacion_general || null;
    if (resultados_alterados !== undefined) cambios.resultados_alterados = !!resultados_alterados;
    if (comentario_resultados_alterados !== undefined)
        cambios.comentario_resultados_alterados = comentario_resultados_alterados || null;
    if (fundamento_jurado !== undefined) cambios.fundamento_jurado = fundamento_jurado || null;
    if (fundamento_jurado_publicado !== undefined) cambios.fundamento_jurado_publicado = !!fundamento_jurado_publicado;
    if (casosWs.cambia) cambios.casos_whatsapp = casosWs.valor;
    if (desglose.cambia) {
        cambios.casos_whatsapp_bien_jurado = desglose.bien;
        cambios.casos_whatsapp_mal_jurado  = desglose.mal;
    }

    // Migración 103 — desmarcar los resultados alterados: si existe una
    // revisión de Comisión PENDIENTE se anula primero, con motivo y auditoría
    // (RPC transaccional). Si la Comisión YA resolvió, no se permite.
    if (resultados_alterados === false) {
        const { data: actual } = await supabase
            .from('evaluaciones').select('resultados_alterados').eq('id', req.params.id).single();
        if (actual?.resultados_alterados) {
            const { error: anErr } = await supabase.rpc('anular_revision_resultado_alterado', {
                p_evaluacion_id: req.params.id,
                p_actor_id:      req.usuario.id,
                p_motivo:        'El analista desmarcó los resultados alterados antes de la resolución de la Comisión'
            });
            if (anErr) {
                const m = mensajeErrorComision(anErr);
                if (m.code === 'REVISION_YA_RESUELTA') {
                    return res.status(409).json({ error: 'La Comisión ya revisó los resultados alterados de este rodeo: el indicador y su comentario no se pueden modificar.', code: 'ALTERACION_YA_REVISADA' });
                }
                if (m.code !== 'MIGRACION_103_PENDIENTE') return res.status(m.status).json({ error: m.mensaje, code: m.code });
            }
        }
    }

    const { data, error } = await supabase
        .from('evaluaciones')
        .update(cambios)
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) {
        const m = mensajeErrorComision(error);
        if (['ALTERACION_YA_REVISADA', 'REVISION_PENDIENTE_SIN_ANULAR'].includes(m.code)) {
            return res.status(m.status).json({ error: m.mensaje, code: m.code });
        }
        return res.status(500).json({ error: error.message });
    }

    // Migración 103 — marcar la alteración con el Ciclo 1 ya cerrado genera la
    // revisión de Comisión (idempotente; si el ciclo sigue abierto, nacerá al cerrarlo).
    if (data?.resultados_alterados) {
        await generarRevisionResultadoAlterado(req.params.id, req.usuario.id, 'datos_deportivos');
    }
    res.json(data);
});

// GET /:id/revision?estado= — bandeja de revisión del analista
router.get('/:id/revision', async (req, res) => {
    const { estado = 'pendiente_analista' } = req.query;

    const { data: ev, error: evErr } = await supabase
        .from('evaluaciones')
        .select('id, estado, rodeo:rodeos(id, club, fecha, asociacion, tipo_rodeo_nombre)')
        .eq('id', req.params.id)
        .single();

    if (evErr) return res.status(404).json({ error: 'Evaluación no encontrada' });

    const { data: ciclos } = await supabase
        .from('evaluacion_ciclos')
        .select('id, numero_ciclo, estado')
        .eq('evaluacion_id', req.params.id)
        .order('numero_ciclo');

    const ciclosConCasos = await Promise.all((ciclos || []).map(async (ciclo) => {
        const { data: casos } = await supabase
            .from('evaluacion_casos')
            .select('*')
            .eq('ciclo_id', ciclo.id)
            .eq('estado', estado)
            .order('numero_caso');
        return { ...ciclo, casos: casos || [] };
    }));

    const totalCasos = ciclosConCasos.reduce((s, c) => s + c.casos.length, 0);

    res.json({
        id:          ev.id,
        estado:      ev.estado,
        rodeo:       ev.rodeo,
        ciclos:      ciclosConCasos,
        total_casos: totalCasos
    });
});

// GET /:id/comision?estado= — bandeja de comisión técnica
router.get('/:id/comision', async (req, res) => {
    const { estado = 'derivado_comision' } = req.query;

    const { data: ev, error: evErr } = await supabase
        .from('evaluaciones')
        .select('id, estado, rodeo:rodeos(id, club, fecha, asociacion, tipo_rodeo_nombre)')
        .eq('id', req.params.id)
        .single();

    if (evErr) return res.status(404).json({ error: 'Evaluación no encontrada' });

    const { data: ciclos } = await supabase
        .from('evaluacion_ciclos')
        .select('id, numero_ciclo, estado')
        .eq('evaluacion_id', req.params.id)
        .order('numero_ciclo');

    const ciclosConCasos = await Promise.all((ciclos || []).map(async (ciclo) => {
        const { data: casos } = await supabase
            .from('evaluacion_casos')
            .select('*')
            .eq('ciclo_id', ciclo.id)
            .eq('estado', estado)
            .order('numero_caso');
        return { ...ciclo, casos: casos || [] };
    }));

    const totalCasos = ciclosConCasos.reduce((s, c) => s + c.casos.length, 0);

    res.json({
        id:          ev.id,
        estado:      ev.estado,
        rodeo:       ev.rodeo,
        ciclos:      ciclosConCasos,
        total_casos: totalCasos
    });
});

// PATCH /:id/anular — anulación lógica (cualquier admin)
router.patch('/:id/anular', soloNoComisionTecnica, async (req, res) => {
    const { motivo } = req.body;
    if (!motivo || !motivo.trim()) {
        return res.status(400).json({ error: 'El motivo de anulación es obligatorio' });
    }

    const { data: ev } = await supabase
        .from('evaluaciones')
        .select('id, anulada, rodeo:rodeos(club, asociacion, fecha)')
        .eq('id', req.params.id)
        .single();

    if (!ev) return res.status(404).json({ error: 'Evaluación no encontrada' });
    if (ev.anulada) return res.status(409).json({ error: 'La evaluación ya está anulada' });

    const { error } = await supabase
        .from('evaluaciones')
        .update({
            anulada:          true,
            anulada_en:       new Date().toISOString(),
            anulada_por:      req.usuario.id,
            motivo_anulacion: motivo.trim()
        })
        .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: req.params.id,
        accion:        'anular_evaluacion',
        detalle:       { motivo: motivo.trim(), rodeo: ev.rodeo },
        actor_id:      req.usuario.id,
        actor_tipo:    'administrador',
        ip_address:    req.ip || null
    });

    res.json({ mensaje: 'Evaluación anulada correctamente' });
});

// DELETE /:id/definitivo — eliminación física (solo Administrador Principal)
router.delete('/:id/definitivo', soloRolEvaluacion(), async (req, res) => {
    const { confirmacion, motivo } = req.body;

    if (confirmacion !== 'ELIMINAR') {
        return res.status(400).json({ error: 'Escribe ELIMINAR para confirmar la eliminación definitiva' });
    }
    if (!motivo || !motivo.trim()) {
        return res.status(400).json({ error: 'El motivo es obligatorio' });
    }

    const { data: ev } = await supabase
        .from('evaluaciones')
        .select('id, estado, rodeo:rodeos(club, asociacion, fecha)')
        .eq('id', req.params.id)
        .single();

    if (!ev) return res.status(404).json({ error: 'Evaluación no encontrada' });

    // Obtener ciclos y casos para cascade
    const { data: ciclos } = await supabase
        .from('evaluacion_ciclos')
        .select('id')
        .eq('evaluacion_id', req.params.id);
    const cicloIds = (ciclos || []).map(c => c.id);

    let casoIds = [];
    if (cicloIds.length > 0) {
        const { data: casos } = await supabase
            .from('evaluacion_casos')
            .select('id')
            .in('ciclo_id', cicloIds);
        casoIds = (casos || []).map(c => c.id);
    }

    // 1. Respuestas de jurado
    if (casoIds.length > 0) {
        await supabase.from('evaluacion_respuestas_jurado').delete().in('caso_id', casoIds);
    }

    // 2. Auditoría y comentarios ANTES de casos/ciclos (tienen FK a ambos)
    await supabase.from('evaluacion_auditoria').delete().eq('evaluacion_id', req.params.id);
    await supabase.from('evaluacion_comentarios_finales').delete().eq('evaluacion_id', req.params.id);

    // 3. Casos
    if (casoIds.length > 0) {
        await supabase.from('evaluacion_casos').delete().in('id', casoIds);
    }

    // 4. Ciclos
    if (cicloIds.length > 0) {
        await supabase.from('evaluacion_ciclos').delete().in('id', cicloIds);
    }

    // 5. Evaluación
    const { error } = await supabase.from('evaluaciones').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });

    res.json({ mensaje: 'Evaluación eliminada definitivamente' });
});

// ─── CIERRE EXCEPCIONAL — ADMINISTRADOR ───────────────────────────────────
// Salida excepcional, SOLO Administrador pleno (verificado aquí y dentro de
// la RPC), cuando la Comisión no responde. No publica por sí mismo ni salta
// controles: 1) la RPC transaccional trata formalmente los pendientes
// (Tipo A → cierre excepcional sin puntos; Tipo B → ERROR/ACIERTO expreso
// del Administrador por caso); 2) los ciclos elegidos se cierran con el
// procedimiento NORMAL (cerrarCicloInterno, mismas reglas); 3) corre la
// publicación automática habitual (publicar_evaluacion: mismo cálculo y
// mismos controles). El resultado queda en el historial del cierre.
const { datosCierreExcepcional } = require('../../services/revisionesComision');
const { cerrarCicloInterno } = require('./ciclos');

router.get('/:id/cierre-excepcional', soloRolEvaluacion(), async (req, res) => {
    try {
        const r = await datosCierreExcepcional(req.params.id);
        if (r.error) return res.status(r.error.status).json({ error: r.error.mensaje });
        res.json(r.datos);
    } catch (e) {
        res.status(500).json({ error: 'No fue posible cargar los datos del cierre excepcional.' });
    }
});

// Pasos 2–4 del cierre excepcional, compartidos por la ejecución inicial y
// por "Completar cierre excepcional" (reintento). NUNCA vuelve a aplicar
// decisiones (eso lo hizo la RPC una sola vez). Cada paso usa el mecanismo
// normal: cierre de ciclo = cerrarCicloInterno; publicación = intentarAuto-
// Publicar → publicar_evaluacion (transición condicional + RPC que exige
// pendiente_aprobacion: a lo sumo UNA publicación aunque se reintente o
// haya llamadas simultáneas). Cualquier error se captura y queda en el
// historial como intento incompleto, recuperable desde la pantalla.
async function completarPasosCierreExcepcional({ evalId, cierreId, ciclosACerrar, usuario, ip, motivo, tipoIntento }) {
    const ciclos = [];
    let error = null;
    try {
        const { data: ciclosEval } = await supabase.from('evaluacion_ciclos').select('id, numero_ciclo, estado').eq('evaluacion_id', evalId);
        for (const cicloId of ciclosACerrar) {
            const c = (ciclosEval || []).find(x => x.id === cicloId);
            if (c && c.estado === 'cerrado') { ciclos.push({ ciclo_id: cicloId, numero_ciclo: c.numero_ciclo, cerrado: true, estado: 'cerrado', error: null }); continue; }
            const r = await cerrarCicloInterno({ cicloId, usuario, motivo_cierre: `Cierre excepcional del Administrador: ${motivo}`, ip });
            ciclos.push({ ciclo_id: cicloId, numero_ciclo: c?.numero_ciclo ?? null, cerrado: r.status === 200 && r.body?.estado === 'cerrado',
                          estado: r.body?.estado || c?.estado || null, error: r.status === 200 ? null : (r.body?.error || 'No se pudo cerrar') });
        }
        // Publicación habitual (la RPC decide; nunca se fuerza). El cierre normal
        // del último ciclo ya puede haberla disparado: el resultado se lee del
        // estado REAL final.
        await intentarAutoPublicar(evalId, usuario.id, usuario.nombre, ip);
    } catch (e) {
        error = e.message || String(e);
        console.error(`[CIERRE-EXCEPCIONAL] Paso posterior incompleto evaluacion_id=${evalId}:`, error);
    }

    const { data: evFinal } = await supabase.from('evaluaciones').select('id, estado, nota_final, puntaje_final').eq('id', evalId).single();
    const publicado = evFinal?.estado === 'publicado';
    let auditoriaPublicacionId = null;
    if (publicado) {
        const { data: aud } = await supabase.from('evaluacion_auditoria').select('id').eq('evaluacion_id', evalId)
            .eq('accion', 'publicar_nota').order('created_at', { ascending: false }).limit(1);
        auditoriaPublicacionId = aud?.[0]?.id || null;
    }
    const { data: ciclosDespues } = await supabase.from('evaluacion_ciclos').select('numero_ciclo, estado').eq('evaluacion_id', evalId);

    const { data: cierreRow } = await supabase.from('evaluacion_cierres_excepcionales').select('resultado').eq('id', cierreId).maybeSingle();
    const intentos = Array.isArray(cierreRow?.resultado?.intentos) ? cierreRow.resultado.intentos : [];
    const intento = { n: intentos.length + 1, tipo: tipoIntento, en: new Date().toISOString(), por: usuario.id, ciclos_cerrados: ciclos, publicado, error };
    const resultado = {
        completo: publicado,
        publicado,
        estado_evaluacion: evFinal?.estado || null,
        nota_final: publicado ? (evFinal?.nota_final ?? null) : null,
        puntaje_final: publicado ? (evFinal?.puntaje_final ?? null) : null,
        auditoria_publicacion_id: auditoriaPublicacionId,
        ciclos_despues: (ciclosDespues || []).sort((a, b) => a.numero_ciclo - b.numero_ciclo),
        ultimo_error: error,
        intentos: [...intentos, intento]
    };
    await supabase.from('evaluacion_cierres_excepcionales').update({ resultado }).eq('id', cierreId);
    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: evalId,
        accion: tipoIntento === 'inicial' ? 'cierre_excepcional_resultado' : 'cierre_excepcional_reintento',
        detalle: { cierre_id: cierreId, intento: intento.n, ciclos_cerrados: ciclos, publicado, nota_final: resultado.nota_final, error },
        actor_id: usuario.id, actor_tipo: 'administrador', actor_nombre: usuario.nombre, ip_address: ip
    });
    return { ...resultado, ciclos_cerrados: ciclos };
}

// Revalida contra la BD que quien actúa sigue siendo Administrador pleno
// (rol_evaluacion NULL) y ACTIVO. El JWT dura hasta 8 h y pudo emitirse antes
// de una desactivación o de un cambio de rol: soloRolEvaluacion() solo mira
// el token. La RPC cierre_excepcional_comision_admin ya hace esta misma
// verificación dentro de su transacción; "completar" no pasa por esa RPC, así
// que la hace aquí antes de cualquier lectura o escritura. Falla cerrado: si
// no se puede consultar, no se actúa.
async function revalidarAdministradorPleno(adminId) {
    let data, error;
    try {
        ({ data, error } = await supabase.from('administradores').select('id, activo, rol_evaluacion').eq('id', adminId).maybeSingle());
    } catch (e) {
        error = e;
    }
    if (error) {
        console.error(`[CIERRE-EXCEPCIONAL] No se pudo revalidar al administrador id=${adminId}:`, error.message || error);
        return { status: 503, body: { error: 'No fue posible validar sus permisos. Intente nuevamente.', code: 'VALIDACION_ADMIN_NO_DISPONIBLE' } };
    }
    if (!data || data.activo !== true || (data.rol_evaluacion ?? null) !== null) {
        console.warn(`[CIERRE-EXCEPCIONAL] 403 administrador no pleno o inactivo en BD id=${adminId}`);
        return { status: 403, body: { error: 'Su cuenta ya no tiene permisos de Administrador pleno. Inicie sesión nuevamente.', code: 'ADMIN_NO_AUTORIZADO' } };
    }
    return null;
}

function mensajeResultadoCierre(r) {
    if (r.publicado) return 'Cierre excepcional completo. Se cumplieron todos los requisitos y la nota fue publicada.';
    if (r.ultimo_error) return 'Las revisiones quedaron tratadas, pero un paso posterior no se completó. Use "Completar cierre excepcional" para reintentarlo; no se repetirá ninguna decisión.';
    return 'Cierre excepcional registrado. La nota todavía no se publica: falta cumplir otros requisitos (por ejemplo, cerrar el otro ciclo). Puede completarlo después desde esta misma pantalla.';
}

router.post('/:id/cierre-excepcional', soloRolEvaluacion(), async (req, res) => {
    const evalId = req.params.id;
    const { motivo, decisiones = [], ciclos_a_cerrar = [], confirmado } = req.body || {};
    if (confirmado !== true) return res.status(400).json({ error: 'Debe confirmar expresamente el cierre excepcional.' });
    if (!motivo || !String(motivo).trim()) return res.status(400).json({ error: 'El motivo (justificación) es obligatorio.', code: 'MOTIVO_REQUERIDO' });
    if (!Array.isArray(decisiones) || !Array.isArray(ciclos_a_cerrar)) return res.status(400).json({ error: 'Formato inválido.' });

    // Los ciclos a cerrar deben pertenecer a esta evaluación (nunca otros).
    const { data: ciclosEval } = await supabase.from('evaluacion_ciclos').select('id').eq('evaluacion_id', evalId);
    const idsCiclos = new Set((ciclosEval || []).map(c => c.id));
    if (ciclos_a_cerrar.some(id => !idsCiclos.has(id))) return res.status(400).json({ error: 'Uno de los ciclos indicados no pertenece a esta evaluación.' });

    // 1. Tratamiento formal de los pendientes (transaccional, UNA sola vez).
    const { data, error } = await supabase.rpc('cierre_excepcional_comision_admin', {
        p_evaluacion_id: evalId,
        p_admin_id:      req.usuario.id,
        p_motivo:        String(motivo).trim(),
        p_decisiones:    decisiones.map(d => ({ caso_id: d?.caso_id, decision: String(d?.decision || '').toLowerCase() }))
    });
    if (error) {
        const m = mensajeErrorComision(error);
        return res.status(m.status).json({ error: m.mensaje, code: m.code });
    }
    const cierre = Array.isArray(data) ? data[0] : data;

    // 2–4. Cierre normal de ciclos, publicación habitual e historial (recuperable).
    const r = await completarPasosCierreExcepcional({
        evalId, cierreId: cierre.cierre_id, ciclosACerrar: ciclos_a_cerrar, usuario: req.usuario, ip: req.ip,
        motivo: String(motivo).trim(), tipoIntento: 'inicial'
    });
    res.json({
        ok: true, cierre_id: cierre.cierre_id, tratamiento: cierre.tratamiento,
        descuentos_considerados_total: cierre.descuentos_considerados_total,
        ...r, mensaje: mensajeResultadoCierre(r)
    });
});

// POST /:id/cierre-excepcional/completar — RECUPERACIÓN / reintento de un
// cierre excepcional ya registrado cuya nota aún no se publicó (fallo
// intermedio, o el otro ciclo todavía abierto). Idempotente: no aplica
// decisiones (ya están), cierra los ciclos elegidos con el procedimiento
// normal y deja que la publicación habitual decida; a lo sumo una
// publicación. Cada intento queda auditado. Solo Administrador pleno.
router.post('/:id/cierre-excepcional/completar', soloRolEvaluacion(), async (req, res) => {
    const evalId = req.params.id;
    const { ciclos_a_cerrar = [], confirmado } = req.body || {};
    if (confirmado !== true) return res.status(400).json({ error: 'Debe confirmar expresamente la acción.' });
    if (!Array.isArray(ciclos_a_cerrar)) return res.status(400).json({ error: 'Formato inválido.' });

    const rechazo = await revalidarAdministradorPleno(req.usuario.id);
    if (rechazo) return res.status(rechazo.status).json(rechazo.body);

    const { data: ev } = await supabase.from('evaluaciones').select('id, estado').eq('id', evalId).maybeSingle();
    if (!ev) return res.status(404).json({ error: 'Evaluación no encontrada.' });
    if (['aprobado', 'publicado', 'cerrado'].includes(ev.estado)) {
        return res.status(409).json({ error: 'La nota de esta evaluación ya fue publicada: no hay nada que completar.', code: 'EVALUACION_PUBLICADA' });
    }
    const { data: cierres } = await supabase.from('evaluacion_cierres_excepcionales').select('id, motivo, created_at')
        .eq('evaluacion_id', evalId).order('created_at', { ascending: false }).limit(1);
    const cierre = cierres?.[0];
    if (!cierre) return res.status(409).json({ error: 'Esta evaluación no tiene un cierre excepcional registrado.', code: 'SIN_CIERRE_EXCEPCIONAL' });

    // Si aparecieron NUEVAS revisiones pendientes después del cierre, no se
    // completan por esta vía: requieren la Comisión o un nuevo cierre excepcional.
    if (await contarPendientesComision(evalId) > 0) {
        return res.status(409).json({ error: 'Hay revisiones de Comisión pendientes posteriores al cierre excepcional. Deben resolverse (o tratarse con un nuevo cierre excepcional) antes de completar.', code: 'PENDIENTES_NUEVOS' });
    }
    const { data: ciclosEval } = await supabase.from('evaluacion_ciclos').select('id').eq('evaluacion_id', evalId);
    const idsCiclos = new Set((ciclosEval || []).map(c => c.id));
    if (ciclos_a_cerrar.some(id => !idsCiclos.has(id))) return res.status(400).json({ error: 'Uno de los ciclos indicados no pertenece a esta evaluación.' });

    const r = await completarPasosCierreExcepcional({
        evalId, cierreId: cierre.id, ciclosACerrar: ciclos_a_cerrar, usuario: req.usuario, ip: req.ip,
        motivo: cierre.motivo, tipoIntento: 'reintento'
    });
    res.json({ ok: true, cierre_id: cierre.id, ...r, mensaje: mensajeResultadoCierre(r) });
});

// POST /:id/finalizar — Jefe fuerza el cierre cuando hay casos trabados (fallback manual)
router.post('/:id/finalizar', soloRolEvaluacion('jefe_area'), async (req, res) => {
    const evalId = req.params.id;
    const now = new Date().toISOString();

    const { data: ev } = await supabase
        .from('evaluaciones')
        .select('id, estado')
        .eq('id', evalId)
        .single();

    if (!ev) return res.status(404).json({ error: 'Evaluación no encontrada' });
    if (['aprobado', 'publicado', 'cerrado'].includes(ev.estado)) {
        return res.status(409).json({ error: `La evaluación ya está en estado ${ev.estado}` });
    }

    // Obtener todos los casos no resueltos
    const { data: casosNoResueltos } = await supabase
        .from('evaluacion_casos')
        .select('id, ciclo_id, tipo_caso, descuento_puntos, estado, decision_analista, decision_comision')
        .eq('evaluacion_id', evalId)
        .neq('estado', 'resuelto');

    // Migración 103: los casos derivados por el analista esperan la decisión
    // de la Comisión — "Finalizar" no puede resolverlos por ella.
    const derivadosSinComision = (casosNoResueltos || []).filter(c => c.decision_analista === 'derivar_comision' && !c.decision_comision);
    if (derivadosSinComision.length > 0) {
        return res.status(409).json({
            error: `Hay ${derivadosSinComision.length} caso(s) derivado(s) a la Comisión Técnica pendientes de su decisión. No se puede finalizar hasta que la Comisión los resuelva.`
        });
    }
    const casos = casosNoResueltos;

    if (casos && casos.length > 0) {
        const casoIds = casos.map(c => c.id);

        // Buscar respuestas de rechaza sin decisión final
        const { data: respsPendientes } = await supabase
            .from('evaluacion_respuestas_jurado')
            .select('id, caso_id, decision_analista, decision_comite')
            .in('caso_id', casoIds)
            .eq('decision', 'rechaza');

        const sinDecision = (respsPendientes || []).filter(r =>
            !r.decision_analista ||
            (r.decision_analista === 'derivada_comite' && !r.decision_comite)
        );

        if (sinDecision.length > 0) {
            return res.status(409).json({
                error: `Hay ${sinDecision.length} respuesta(s) de jurado sin decisión. Resuelva todas las respuestas del analista antes de finalizar.`
            });
        }

        // Todas las respuestas están decididas — sincronizar casos
        const { data: respsConDesc } = await supabase
            .from('evaluacion_respuestas_jurado')
            .select('caso_id, descuento_final')
            .in('caso_id', casoIds)
            .eq('decision', 'rechaza');

        const descPorCaso = {};
        for (const r of (respsConDesc || [])) {
            if (!descPorCaso[r.caso_id]) descPorCaso[r.caso_id] = 0;
            if ((r.descuento_final ?? 0) > descPorCaso[r.caso_id]) {
                descPorCaso[r.caso_id] = r.descuento_final;
            }
        }

        for (const caso of casos) {
            const maxDesc = descPorCaso[caso.id] ?? 0;
            let resolucion_final;
            if (caso.tipo_caso === 'informativo' || maxDesc === 0) {
                resolucion_final = 'sin_descuento';
            } else {
                resolucion_final = caso.tipo_caso === 'interpretativa'
                    ? 'interpretativa_confirmada'
                    : 'reglamentaria_confirmada';
            }
            await supabase.from('evaluacion_casos').update({
                estado: 'resuelto',
                resolucion_final,
                updated_at: now
            }).eq('id', caso.id);
        }

        // Cerrar ciclos donde todos los casos quedaron resueltos
        const cicloIds = [...new Set(casos.map(c => c.ciclo_id))];
        for (const cicloId of cicloIds) {
            const { data: noResueltos } = await supabase
                .from('evaluacion_casos')
                .select('id')
                .eq('ciclo_id', cicloId)
                .neq('estado', 'resuelto');

            if (!noResueltos || noResueltos.length === 0) {
                await supabase.from('evaluacion_ciclos')
                    .update({ estado: 'cerrado', fecha_cierre: now, updated_at: now })
                    .eq('id', cicloId)
                    .neq('estado', 'cerrado');
            }
        }
    }

    // Intentar auto-publicar
    const rpcData = await intentarAutoPublicar(evalId, req.usuario.id, req.usuario.nombre, req.ip);

    if (!rpcData) {
        const { data: ciclosEv } = await supabase
            .from('evaluacion_ciclos')
            .select('numero_ciclo, estado')
            .eq('evaluacion_id', evalId);
        const abiertos = (ciclosEv || []).filter(c => c.estado !== 'cerrado');
        if (abiertos.length > 0) {
            return res.status(409).json({
                error: `Ciclo(s) ${abiertos.map(c => c.numero_ciclo).join(', ')} aún no están cerrados.`
            });
        }
        return res.status(409).json({ error: 'No se pudo publicar la evaluación. Verifique el estado de los ciclos y casos.' });
    }

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: evalId,
        accion:       'finalizar_manual',
        detalle:      { nota_final: rpcData?.nota_final, puntaje_final: rpcData?.puntaje_final },
        actor_id:     req.usuario.id,
        actor_tipo:   'administrador',
        actor_nombre: req.usuario.nombre,
        ip_address:   req.ip
    });

    const { data: evFinal } = await supabase
        .from('evaluaciones')
        .select('id, estado, nota_final, puntaje_final')
        .eq('id', evalId)
        .single();

    res.json({
        nota_final:    evFinal?.nota_final,
        puntaje_final: evFinal?.puntaje_final,
        evaluacion:    evFinal
    });
});

module.exports = router;
