const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const { soloRolEvaluacion } = require('../../middleware/auth');

// GET / — lista paginada con filtros, jurados y resumen de faltas
router.get('/', async (req, res) => {
    const { estado, analista_id, buscar, respuesta_estado, fecha_desde, fecha_hasta, page = 1, limit = 20 } = req.query;
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
        if (rodeoIdsFecha.length === 0) return res.json({ evaluaciones: [], total: 0 });
    }

    // Cuando hay filtro por respuesta_estado, cargamos un lote amplio y filtramos en memoria
    const hasRespFiltro = !!respuesta_estado;

    let query = supabase
        .from('evaluaciones')
        .select(`
            id, estado, created_at, analista_id, rodeo_id, nota_final,
            rodeo:rodeos(id, club, fecha, asociacion),
            analista:analista_id(id, nombre_completo)
        `, { count: 'exact' })
        .order('created_at', { ascending: false })
        .eq('anulada', false);

    if (!hasRespFiltro) {
        query = query.range(offset, offset + parseInt(limit) - 1);
    } else {
        query = query.limit(300);
    }

    if (estado)             query = query.eq('estado', estado);
    if (analista_id)        query = query.eq('analista_id', analista_id);
    if (rodeoIdsFecha !== null) query = query.in('rodeo_id', rodeoIdsFecha);

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
        if (orParts.length > 0) query = query.or(orParts.join(','));
        else return res.json({ evaluaciones: [], total: 0 });
    }

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const evaluaciones = data || [];
    if (evaluaciones.length === 0) {
        return res.json({ evaluaciones: [], total: count || 0 });
    }

    const evalIds  = evaluaciones.map(e => e.id);
    const rodeoIds = [...new Set(evaluaciones.map(e => e.rodeo_id))];

    const [{ data: casos }, { data: asigs }, { data: ciclosData }] = await Promise.all([
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
            .order('numero_ciclo')
    ]);

    const casosPorEval = {};
    for (const c of (casos || [])) {
        if (!casosPorEval[c.evaluacion_id]) casosPorEval[c.evaluacion_id] = { reglamentarias: 0, interpretativas: 0, informativos: 0 };
        if (c.tipo_caso === 'reglamentaria')  casosPorEval[c.evaluacion_id].reglamentarias++;
        if (c.tipo_caso === 'interpretativa') casosPorEval[c.evaluacion_id].interpretativas++;
        if (c.tipo_caso === 'informativo')    casosPorEval[c.evaluacion_id].informativos++;
    }
    for (const rf of Object.values(casosPorEval)) {
        rf.puntos_descontados = rf.reglamentarias * 2 + rf.interpretativas * 1;
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
            ciclo2: enrichCiclo(ciclosPorEval[ev.id]?.[2], jurados)
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

    const totalFinal = hasRespFiltro ? resultado.length : (count || 0);
    const pageData   = hasRespFiltro ? resultado.slice(offset, offset + parseInt(limit)) : resultado;

    res.json({ evaluaciones: pageData, total: totalFinal });
});

// POST / — crear evaluación (solo jefe_area o admin pleno)
router.post('/', soloRolEvaluacion('jefe_area'), async (req, res) => {
    const { rodeo_id, analista_id } = req.body;
    if (!rodeo_id)    return res.status(400).json({ error: 'rodeo_id requerido' });
    if (!analista_id) return res.status(400).json({ error: 'analista_id requerido' });

    const { data: config } = await supabase
        .from('evaluacion_configuracion')
        .select('*')
        .eq('activo', true)
        .single();

    const cfg = config || { puntaje_base: 80, min_casos_ciclo1: 0, max_casos_ciclo1: 10, min_casos_ciclo2: 8, max_casos_ciclo2: 8 };

    const { data: ev, error: evErr } = await supabase
        .from('evaluaciones')
        .insert({
            rodeo_id,
            analista_id,
            puntaje_base: cfg.puntaje_base,
            creado_por: req.usuario.id
        })
        .select()
        .single();

    if (evErr) {
        if (evErr.code === '23505') return res.status(409).json({ error: 'Ya existe una evaluación para este rodeo' });
        return res.status(500).json({ error: evErr.message });
    }

    await supabase.from('evaluacion_ciclos').insert([
        { evaluacion_id: ev.id, numero_ciclo: 1, min_casos: cfg.min_casos_ciclo1, max_casos: cfg.max_casos_ciclo1 },
        { evaluacion_id: ev.id, numero_ciclo: 2, min_casos: cfg.min_casos_ciclo2, max_casos: cfg.max_casos_ciclo2 }
    ]);

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: ev.id,
        accion: 'crear_evaluacion',
        detalle: { rodeo_id, analista_id },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        actor_nombre: req.usuario.nombre,
        ip_address: req.ip
    });

    res.status(201).json(ev);
});

// GET /rodeos-disponibles — rodeos activos + jurados + indicador tiene_evaluacion
router.get('/rodeos-disponibles', async (req, res) => {
    const { fecha_desde, fecha_hasta, asociacion, buscar } = req.query;

    let query = supabase
        .from('rodeos')
        .select('id, club, fecha, asociacion, tipo_rodeo_nombre')
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
        supabase.from('evaluaciones').select('rodeo_id').in('rodeo_id', rodeoIds),
        supabase
            .from('asignaciones')
            .select('rodeo_id, estado_designacion, nombre_importado, usuarios_pagados(nombre_completo)')
            .in('rodeo_id', rodeoIds)
            .eq('tipo_persona', 'jurado')
            .eq('estado', 'activo')
    ]);

    const evalSet = new Set((evals || []).map(e => e.rodeo_id));

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

    const { data: config } = await supabase
        .from('evaluacion_configuracion')
        .select('*')
        .eq('activo', true)
        .single();

    const cfg = config || { puntaje_base: 80, min_casos_ciclo1: 0, max_casos_ciclo1: 10, min_casos_ciclo2: 8, max_casos_ciclo2: 8 };

    const { data: existentes } = await supabase
        .from('evaluaciones')
        .select('rodeo_id')
        .in('rodeo_id', rodeo_ids);

    const existeSet = new Set((existentes || []).map(e => e.rodeo_id));

    let creadas = 0, omitidas = 0;
    const errores = [];

    for (const rodeo_id of rodeo_ids) {
        if (existeSet.has(rodeo_id)) { omitidas++; continue; }

        const { data: ev, error: evErr } = await supabase
            .from('evaluaciones')
            .insert({ rodeo_id, analista_id, puntaje_base: cfg.puntaje_base, creado_por: req.usuario.id })
            .select()
            .single();

        if (evErr) {
            if (evErr.code === '23505') { omitidas++; }
            else errores.push({ rodeo_id, error: evErr.message });
            continue;
        }

        await supabase.from('evaluacion_ciclos').insert([
            { evaluacion_id: ev.id, numero_ciclo: 1, min_casos: cfg.min_casos_ciclo1, max_casos: cfg.max_casos_ciclo1 },
            { evaluacion_id: ev.id, numero_ciclo: 2, min_casos: cfg.min_casos_ciclo2, max_casos: cfg.max_casos_ciclo2 }
        ]);

        await supabase.from('evaluacion_auditoria').insert({
            evaluacion_id: ev.id,
            accion:        'crear_evaluacion',
            detalle:       { rodeo_id, analista_id, origen: 'masivo' },
            actor_id:      req.usuario.id,
            actor_tipo:    'administrador',
            actor_nombre:  req.usuario.nombre,
            ip_address:    req.ip
        });

        creadas++;
    }

    res.json({ creadas, omitidas, errores });
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

    const { data: asigs } = await supabase
        .from('asignaciones')
        .select('estado_designacion, nombre_importado, usuarios_pagados(id, nombre_completo, categoria)')
        .eq('rodeo_id', ev.rodeo_id)
        .eq('tipo_persona', 'jurado')
        .eq('estado', 'activo');

    const jurados = (asigs || [])
        .filter(a => a.estado_designacion !== 'rechazado')
        .map(a => ({
            id:              a.usuarios_pagados?.id              || null,
            nombre_completo: a.usuarios_pagados?.nombre_completo || a.nombre_importado || null,
            categoria:       a.usuarios_pagados?.categoria       || null
        }))
        .filter(j => j.nombre_completo);

    res.json({ ...ev, jurados });
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
router.post('/:id/enviar-aprobacion', async (req, res) => {
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

// POST /:id/aprobar — publicar vía RPC (solo jefe_area o admin pleno)
router.post('/:id/aprobar', soloRolEvaluacion('jefe_area'), async (req, res) => {
    const { comentario_jefe } = req.body;

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

// PATCH /:id/datos-deportivos — guardar puntajes, comentarios deportivos y análisis
router.patch('/:id/datos-deportivos', async (req, res) => {
    const {
        comentario_monitor,
        puntaje_oficial_1er, puntaje_oficial_2do, puntaje_oficial_3er,
        puntaje_analista_1er, puntaje_analista_2do, puntaje_analista_3er,
        observacion_general,
        resultados_alterados,
        comentario_resultados_alterados
    } = req.body;

    if (resultados_alterados === true && !comentario_resultados_alterados?.trim()) {
        return res.status(400).json({ error: 'El comentario de alteración es obligatorio cuando resultados_alterados = sí' });
    }

    const toNum = (v) => (v === null || v === '' || v === undefined) ? null : (isNaN(Number(v)) ? null : Number(v));

    const cambios = { updated_at: new Date().toISOString() };

    if (comentario_monitor !== undefined)
        cambios.comentario_monitor = comentario_monitor || null;
    if (puntaje_oficial_1er !== undefined)
        cambios.puntaje_oficial_1er = toNum(puntaje_oficial_1er);
    if (puntaje_oficial_2do !== undefined)
        cambios.puntaje_oficial_2do = toNum(puntaje_oficial_2do);
    if (puntaje_oficial_3er !== undefined)
        cambios.puntaje_oficial_3er = toNum(puntaje_oficial_3er);
    if (puntaje_analista_1er !== undefined)
        cambios.puntaje_analista_1er = toNum(puntaje_analista_1er);
    if (puntaje_analista_2do !== undefined)
        cambios.puntaje_analista_2do = toNum(puntaje_analista_2do);
    if (puntaje_analista_3er !== undefined)
        cambios.puntaje_analista_3er = toNum(puntaje_analista_3er);
    if (observacion_general !== undefined)
        cambios.observacion_general = observacion_general || null;
    if (resultados_alterados !== undefined)
        cambios.resultados_alterados = !!resultados_alterados;
    if (comentario_resultados_alterados !== undefined)
        cambios.comentario_resultados_alterados = comentario_resultados_alterados || null;

    const { data, error } = await supabase
        .from('evaluaciones')
        .update(cambios)
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
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
router.patch('/:id/anular', async (req, res) => {
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

module.exports = router;
