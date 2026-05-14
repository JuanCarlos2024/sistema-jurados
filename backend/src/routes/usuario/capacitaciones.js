/**
 * /api/usuario/capacitaciones
 *
 * Vista y rendición de pruebas para jurados/delegados.
 */

const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');

// ─── Helper: aleatorizar array (Fisher-Yates) ────────────────────────────────

function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// ─── Helper: nota chilena 1.0–7.0 ────────────────────────────────────────────

function calcularNota(porcentaje, notaMinima, notaMaxima, notaAprobacion, exigencia) {
    if (!exigencia || exigencia <= 0 || exigencia >= 100) return null;
    const p = Math.max(0, Math.min(100, porcentaje));
    let nota;
    if (p <= exigencia) {
        nota = notaMinima + (p / exigencia) * (notaAprobacion - notaMinima);
    } else {
        nota = notaAprobacion + ((p - exigencia) / (100 - exigencia)) * (notaMaxima - notaAprobacion);
    }
    return Math.round(nota * 10) / 10;
}

// ─── GET / — mis pruebas asignadas ────────────────────────────────────────────

router.get('/', async (req, res) => {
    const uid = req.usuario.id;
    const now = new Date().toISOString();

    const { data: asigs, error } = await supabase
        .from('capacitacion_asignaciones')
        .select(`
            id, fecha_limite, asignado_en,
            prueba:capacitacion_pruebas!capacitacion_asignaciones_prueba_id_fkey(
                id, titulo, descripcion, instrucciones,
                tiempo_por_pregunta_segundos, puntaje_minimo_aprobacion,
                intentos_maximos, estado, fecha_inicio, fecha_fin
            )
        `)
        .eq('usuario_pagado_id', uid)
        .order('asignado_en', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const asigIds = (asigs || []).map(a => a.id);
    let intentosMap = {};

    if (asigIds.length > 0) {
        const { data: intentos } = await supabase
            .from('capacitacion_intentos')
            .select('id, asignacion_id, estado, numero_intento, puntaje_obtenido, nota, aprobado, iniciado_en, finalizado_en')
            .in('asignacion_id', asigIds)
            .order('numero_intento', { ascending: false });

        (intentos || []).forEach(i => {
            if (!intentosMap[i.asignacion_id]) intentosMap[i.asignacion_id] = [];
            intentosMap[i.asignacion_id].push(i);
        });
    }

    const result = (asigs || [])
        .filter(a => a.prueba && a.prueba.estado === 'publicada')
        .map(a => {
            const intentos   = intentosMap[a.id] || [];
            const ultimo     = intentos[0] || null;
            const completado = intentos.find(i => i.estado === 'completado');
            const validos    = intentos.filter(i => i.estado !== 'abandonado');

            // Disponibilidad por fecha (no oculta — siempre se muestra al jurado)
            let disponibilidad = 'disponible';
            if (a.prueba.fecha_inicio && a.prueba.fecha_inicio > now) {
                disponibilidad = 'no_iniciada';
            } else if (a.prueba.fecha_fin && a.prueba.fecha_fin < now) {
                disponibilidad = 'vencida';
            }

            let estado_jurado = 'pendiente';
            if (completado)                                  estado_jurado = completado.aprobado ? 'aprobado' : 'reprobado';
            else if (ultimo && ultimo.estado === 'en_curso') estado_jurado = 'en_curso';

            const puede_rendir = disponibilidad === 'disponible'
                && !completado
                && (!a.prueba.intentos_maximos || validos.length < a.prueba.intentos_maximos);

            return {
                asignacion_id:    a.id,
                prueba:           a.prueba,
                fecha_limite:     a.fecha_limite,
                asignado_en:      a.asignado_en,
                estado_jurado,
                disponibilidad,
                puede_rendir,
                intento_en_curso: (ultimo && ultimo.estado === 'en_curso') ? ultimo : null,
                ultimo_completado: completado || null,
                total_intentos:   validos.length
            };
        });

    res.json(result);
});

// ─── GET /:asignacion_id/iniciar ─── obtiene/crea intento y devuelve preguntas

router.get('/:asignacion_id/iniciar', async (req, res) => {
    const uid = req.usuario.id;
    const now = new Date().toISOString();

    // Verificar que la asignación pertenece al usuario
    const { data: asig } = await supabase
        .from('capacitacion_asignaciones')
        .select(`
            id, prueba_id, fecha_limite,
            prueba:capacitacion_pruebas!capacitacion_asignaciones_prueba_id_fkey(
                id, titulo, descripcion, instrucciones,
                tiempo_por_pregunta_segundos, intentos_maximos,
                estado, fecha_inicio, fecha_fin,
                mezclar_preguntas, mezclar_alternativas
            )
        `)
        .eq('id', req.params.asignacion_id)
        .eq('usuario_pagado_id', uid)
        .single();

    if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });

    const prueba = asig.prueba;
    if (!prueba || prueba.estado !== 'publicada') {
        return res.status(403).json({ error: 'Esta prueba no está disponible' });
    }
    if (prueba.fecha_inicio && prueba.fecha_inicio > now) {
        return res.status(403).json({ error: 'Esta prueba aún no ha comenzado' });
    }
    if (prueba.fecha_fin && prueba.fecha_fin < now) {
        return res.status(403).json({ error: 'El plazo de esta prueba ha vencido' });
    }

    // Verificar intentos disponibles
    const { data: intentos } = await supabase
        .from('capacitacion_intentos')
        .select('id, estado, numero_intento, orden_preguntas_json, orden_alternativas_json')
        .eq('asignacion_id', asig.id)
        .order('numero_intento', { ascending: false });

    const validos    = (intentos || []).filter(i => i.estado !== 'abandonado');
    const enCurso    = validos.find(i => i.estado === 'en_curso');
    const completado = validos.find(i => i.estado === 'completado');

    if (completado) return res.status(403).json({ error: 'Ya completaste esta prueba' });

    const maxIntentos = prueba.intentos_maximos;
    if (maxIntentos && validos.length >= maxIntentos && !enCurso) {
        return res.status(403).json({ error: 'Has alcanzado el máximo de intentos permitidos' });
    }

    // Usar intento en curso o crear uno nuevo
    let intento = enCurso;
    if (!intento) {
        const { data: nuevo, error: errNew } = await supabase
            .from('capacitacion_intentos')
            .insert({
                asignacion_id: asig.id,
                numero_intento: (intentos || []).length + 1,
                estado: 'en_curso'
            })
            .select()
            .single();

        if (errNew) return res.status(500).json({ error: errNew.message });
        intento = nuevo;
    }

    // Preguntas con tipo y video_url — nunca se expone es_correcta
    const { data: preguntas } = await supabase
        .from('capacitacion_preguntas')
        .select('id, orden, enunciado, tipo, video_url, video_sin_audio')
        .eq('prueba_id', asig.prueba_id)
        .order('orden', { ascending: true });

    const pregIds = (preguntas || []).map(p => p.id);
    let altsMap = {};

    if (pregIds.length > 0) {
        const { data: alts } = await supabase
            .from('capacitacion_alternativas')
            .select('id, pregunta_id, texto, orden')
            .in('pregunta_id', pregIds)
            .order('orden', { ascending: true });

        (alts || []).forEach(a => {
            if (!altsMap[a.pregunta_id]) altsMap[a.pregunta_id] = [];
            altsMap[a.pregunta_id].push({ id: a.id, texto: a.texto, orden: a.orden });
        });
    }

    // Respuestas ya guardadas en este intento (para retomar)
    const { data: respYa } = await supabase
        .from('capacitacion_respuestas')
        .select('pregunta_id, alternativa_id')
        .eq('intento_id', intento.id);

    const respMap = {};
    (respYa || []).forEach(r => { respMap[r.pregunta_id] = r.alternativa_id; });

    // ── Orden de preguntas y alternativas ─────────────────────────────────────
    const mezclarPreg = prueba.mezclar_preguntas !== false;
    const mezclarAlts = prueba.mezclar_alternativas !== false;

    let ordenPregIds;
    let ordenAltsMap;

    const ordenGuardado = intento.orden_preguntas_json;
    if (ordenGuardado && Array.isArray(ordenGuardado) && ordenGuardado.length > 0) {
        // Intento existente: reutilizar el mismo orden sin volver a aleatorizar
        ordenPregIds = ordenGuardado;
        ordenAltsMap = intento.orden_alternativas_json || {};
    } else {
        // Intento nuevo: generar orden y persistirlo
        ordenPregIds = mezclarPreg ? shuffle(pregIds.slice()) : pregIds.slice();
        ordenAltsMap = {};
        pregIds.forEach(pid => {
            const altIds = (altsMap[pid] || []).map(a => a.id);
            ordenAltsMap[pid] = mezclarAlts ? shuffle(altIds.slice()) : altIds.slice();
        });
        await supabase
            .from('capacitacion_intentos')
            .update({
                orden_preguntas_json:    ordenPregIds,
                orden_alternativas_json: ordenAltsMap
            })
            .eq('id', intento.id);
    }

    // Índices para acceso rápido por id
    const pregByIdMap = {};
    (preguntas || []).forEach(p => { pregByIdMap[p.id] = p; });

    const altByIdMap = {};
    Object.values(altsMap).forEach(lista => lista.forEach(a => { altByIdMap[a.id] = a; }));

    const preguntasConAlts = ordenPregIds
        .map(pid => {
            const p = pregByIdMap[pid];
            if (!p) return null;
            const altIds = ordenAltsMap[pid] || (altsMap[pid] || []).map(a => a.id);
            const altsOrdenadas = altIds.map(aid => altByIdMap[aid]).filter(Boolean);
            return {
                id:                 p.id,
                enunciado:          p.enunciado,
                tipo:               p.tipo || 'alternativa_unica',
                video_url:          p.video_url || null,
                video_sin_audio:    p.video_sin_audio || false,
                alternativas:       altsOrdenadas,
                respuesta_guardada: respMap[p.id] || null
            };
        })
        .filter(Boolean);

    res.json({
        intento_id:      intento.id,
        prueba: {
            id:                           prueba.id,
            titulo:                       prueba.titulo,
            descripcion:                  prueba.descripcion || null,
            instrucciones:                prueba.instrucciones || null,
            tiempo_por_pregunta_segundos: prueba.tiempo_por_pregunta_segundos
        },
        total_preguntas: preguntasConAlts.length,
        preguntas:       preguntasConAlts,
        iniciado_en:     intento.iniciado_en
    });
});

// ─── POST /intentos/:id/responder ─── guardar una respuesta ──────────────────

router.post('/intentos/:id/responder', async (req, res) => {
    const { pregunta_id, alternativa_id } = req.body;

    if (!pregunta_id) return res.status(400).json({ error: 'pregunta_id es obligatorio' });

    // Verificar que el intento pertenece al usuario
    const { data: intento } = await supabase
        .from('capacitacion_intentos')
        .select(`
            id, estado, asignacion_id,
            asignacion:capacitacion_asignaciones!capacitacion_intentos_asignacion_id_fkey(usuario_pagado_id)
        `)
        .eq('id', req.params.id)
        .single();

    if (!intento || intento.asignacion?.usuario_pagado_id !== req.usuario.id) {
        return res.status(403).json({ error: 'No autorizado' });
    }
    if (intento.estado !== 'en_curso') {
        return res.status(400).json({ error: 'Este intento ya no está en curso' });
    }

    // Verificar si la alternativa es correcta
    let es_correcta = null;
    if (alternativa_id) {
        const { data: alt } = await supabase
            .from('capacitacion_alternativas')
            .select('es_correcta')
            .eq('id', alternativa_id)
            .single();
        es_correcta = alt ? alt.es_correcta : null;
    }

    // Upsert respuesta
    const { data, error } = await supabase
        .from('capacitacion_respuestas')
        .upsert({
            intento_id: intento.id,
            pregunta_id,
            alternativa_id: alternativa_id || null,
            es_correcta,
            respondida_en: new Date().toISOString()
        }, { onConflict: 'intento_id,pregunta_id' })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ─── POST /intentos/:id/finalizar ─── enviar y calcular puntaje ──────────────

router.post('/intentos/:id/finalizar', async (req, res) => {
    const { data: intento } = await supabase
        .from('capacitacion_intentos')
        .select(`
            id, estado, asignacion_id,
            asignacion:capacitacion_asignaciones!capacitacion_intentos_asignacion_id_fkey(
                usuario_pagado_id, prueba_id,
                prueba:capacitacion_pruebas!capacitacion_asignaciones_prueba_id_fkey(
                    puntaje_minimo_aprobacion, nota_minima, nota_maxima, nota_aprobacion
                )
            )
        `)
        .eq('id', req.params.id)
        .single();

    if (!intento || intento.asignacion?.usuario_pagado_id !== req.usuario.id) {
        return res.status(403).json({ error: 'No autorizado' });
    }
    if (intento.estado !== 'en_curso') {
        return res.status(400).json({ error: 'Este intento ya fue finalizado' });
    }

    // Total de preguntas de la prueba
    const { count: totalPregCount } = await supabase
        .from('capacitacion_preguntas')
        .select('id', { count: 'exact', head: true })
        .eq('prueba_id', intento.asignacion.prueba_id);

    // Respuestas correctas
    const { count: correctasCount } = await supabase
        .from('capacitacion_respuestas')
        .select('id', { count: 'exact', head: true })
        .eq('intento_id', intento.id)
        .eq('es_correcta', true);

    // Total de respuestas registradas (para deducir no_respondidas)
    const { count: respondidasCount } = await supabase
        .from('capacitacion_respuestas')
        .select('id', { count: 'exact', head: true })
        .eq('intento_id', intento.id);

    const total          = totalPregCount  || 0;
    const correctas      = correctasCount  || 0;
    const respondidas    = respondidasCount || 0;
    const incorrectas    = respondidas - correctas;
    const no_respondidas = total - respondidas;
    // Las no respondidas cuentan como incorrectas: denominador es total de preguntas
    const puntaje        = total > 0 ? Math.round((correctas / total) * 100 * 10) / 10 : 0;
    const exigencia      = parseFloat(intento.asignacion.prueba?.puntaje_minimo_aprobacion ?? 60);
    const notaMinima     = parseFloat(intento.asignacion.prueba?.nota_minima    ?? 1.0);
    const notaMaxima     = parseFloat(intento.asignacion.prueba?.nota_maxima    ?? 7.0);
    const notaAprobacion = parseFloat(intento.asignacion.prueba?.nota_aprobacion ?? 4.0);
    const nota           = calcularNota(puntaje, notaMinima, notaMaxima, notaAprobacion, exigencia);
    const aprobado       = nota != null ? nota >= notaAprobacion : puntaje >= exigencia;

    const { data, error } = await supabase
        .from('capacitacion_intentos')
        .update({
            estado: 'completado',
            finalizado_en: new Date().toISOString(),
            puntaje_obtenido: puntaje,
            nota,
            aprobado
        })
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ...data, correctas, incorrectas, no_respondidas, total_preguntas: total });
});

// ─── GET /intentos/:id/resultado ─── ver resultado con correcciones ──────────

router.get('/intentos/:id/resultado', async (req, res) => {
    const { data: intento } = await supabase
        .from('capacitacion_intentos')
        .select(`
            id, estado, puntaje_obtenido, nota, aprobado, finalizado_en, numero_intento,
            orden_preguntas_json, orden_alternativas_json,
            asignacion:capacitacion_asignaciones!capacitacion_intentos_asignacion_id_fkey(
                usuario_pagado_id, prueba_id,
                prueba:capacitacion_pruebas!capacitacion_asignaciones_prueba_id_fkey(
                    titulo, puntaje_minimo_aprobacion
                )
            )
        `)
        .eq('id', req.params.id)
        .single();

    if (!intento || intento.asignacion?.usuario_pagado_id !== req.usuario.id) {
        return res.status(403).json({ error: 'No autorizado' });
    }
    if (intento.estado !== 'completado') {
        return res.status(400).json({ error: 'El intento aún no está completado' });
    }

    const { data: preguntas } = await supabase
        .from('capacitacion_preguntas')
        .select('id, orden, enunciado')
        .eq('prueba_id', intento.asignacion.prueba_id)
        .order('orden', { ascending: true });

    const pregIds = (preguntas || []).map(p => p.id);
    let altsMap = {}, respMap = {};

    if (pregIds.length > 0) {
        const { data: alts } = await supabase
            .from('capacitacion_alternativas')
            .select('id, pregunta_id, texto, es_correcta, orden')
            .in('pregunta_id', pregIds)
            .order('orden', { ascending: true });

        (alts || []).forEach(a => {
            if (!altsMap[a.pregunta_id]) altsMap[a.pregunta_id] = [];
            altsMap[a.pregunta_id].push(a);
        });

        const { data: resps } = await supabase
            .from('capacitacion_respuestas')
            .select('pregunta_id, alternativa_id, es_correcta')
            .eq('intento_id', intento.id);

        (resps || []).forEach(r => { respMap[r.pregunta_id] = r; });
    }

    // Aplicar el orden del intento para mostrar al jurado las preguntas/alternativas
    // exactamente como las vio durante la prueba
    const ordenPregIdsRes = intento.orden_preguntas_json;
    const ordenAltsJsonRes = intento.orden_alternativas_json || {};

    const pregByIdMapRes = {};
    (preguntas || []).forEach(p => { pregByIdMapRes[p.id] = p; });

    let preguntasOrdenadas;
    if (ordenPregIdsRes && Array.isArray(ordenPregIdsRes) && ordenPregIdsRes.length > 0) {
        preguntasOrdenadas = ordenPregIdsRes.map(id => pregByIdMapRes[id]).filter(Boolean);
        const yaInc = new Set(ordenPregIdsRes);
        (preguntas || []).forEach(p => { if (!yaInc.has(p.id)) preguntasOrdenadas.push(p); });
    } else {
        preguntasOrdenadas = preguntas || [];
    }

    const detalle = preguntasOrdenadas.map(p => {
        const resp = respMap[p.id];
        const altsOriginales = altsMap[p.id] || [];
        const altIdsOrden = ordenAltsJsonRes[p.id];
        let altsOrdenadas;
        if (altIdsOrden && Array.isArray(altIdsOrden) && altIdsOrden.length > 0) {
            const altById = {};
            altsOriginales.forEach(a => { altById[a.id] = a; });
            altsOrdenadas = altIdsOrden.map(id => altById[id]).filter(Boolean);
            const yaInc2 = new Set(altIdsOrden);
            altsOriginales.forEach(a => { if (!yaInc2.has(a.id)) altsOrdenadas.push(a); });
        } else {
            altsOrdenadas = altsOriginales;
        }
        return {
            pregunta_id:         p.id,
            orden:               p.orden,
            enunciado:           p.enunciado,
            alternativas:        altsOrdenadas,
            alternativa_elegida: resp?.alternativa_id || null,
            es_correcta:         resp?.es_correcta ?? null
        };
    });

    res.json({
        intento_id: intento.id,
        prueba: intento.asignacion.prueba,
        puntaje_obtenido: intento.puntaje_obtenido,
        nota: intento.nota,
        aprobado: intento.aprobado,
        finalizado_en: intento.finalizado_en,
        numero_intento: intento.numero_intento,
        detalle
    });
});

module.exports = router;
