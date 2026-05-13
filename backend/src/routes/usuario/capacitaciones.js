/**
 * /api/usuario/capacitaciones
 *
 * Vista y rendición de pruebas para jurados/delegados.
 */

const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');

// ─── GET / — mis pruebas asignadas ────────────────────────────────────────────

router.get('/', async (req, res) => {
    const uid = req.usuario.id;

    const { data: asigs, error } = await supabase
        .from('capacitacion_asignaciones')
        .select(`
            id, fecha_limite, asignado_en,
            prueba:capacitacion_pruebas!capacitacion_asignaciones_prueba_id_fkey(
                id, titulo, descripcion, tiempo_limite_minutos,
                puntaje_minimo_aprobacion, intentos_maximos, activa
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
            .select('id, asignacion_id, estado, numero_intento, puntaje_obtenido, aprobado, iniciado_en, finalizado_en')
            .in('asignacion_id', asigIds)
            .order('numero_intento', { ascending: false });

        (intentos || []).forEach(i => {
            if (!intentosMap[i.asignacion_id]) intentosMap[i.asignacion_id] = [];
            intentosMap[i.asignacion_id].push(i);
        });
    }

    const result = (asigs || [])
        .filter(a => a.prueba && a.prueba.activa)
        .map(a => {
            const intentos  = intentosMap[a.id] || [];
            const ultimo    = intentos[0] || null;
            const completado = intentos.find(i => i.estado === 'completado');
            const validos    = intentos.filter(i => i.estado !== 'abandonado');

            let estado_jurado = 'pendiente';
            if (completado)                              estado_jurado = completado.aprobado ? 'aprobado' : 'reprobado';
            else if (ultimo && ultimo.estado === 'en_curso') estado_jurado = 'en_curso';

            const puede_rendir = !completado
                && (!a.prueba.intentos_maximos || validos.length < a.prueba.intentos_maximos)
                && a.prueba.activa;

            return {
                asignacion_id:  a.id,
                prueba:         a.prueba,
                fecha_limite:   a.fecha_limite,
                asignado_en:    a.asignado_en,
                estado_jurado,
                puede_rendir,
                intento_en_curso: (ultimo && ultimo.estado === 'en_curso') ? ultimo : null,
                ultimo_completado: completado || null,
                total_intentos: validos.length
            };
        });

    res.json(result);
});

// ─── GET /:asignacion_id/iniciar ─── obtiene/crea intento y devuelve preguntas

router.get('/:asignacion_id/iniciar', async (req, res) => {
    const uid = req.usuario.id;

    // Verificar que la asignación pertenece al usuario
    const { data: asig } = await supabase
        .from('capacitacion_asignaciones')
        .select(`
            id, prueba_id, fecha_limite,
            prueba:capacitacion_pruebas!capacitacion_asignaciones_prueba_id_fkey(
                id, titulo, instrucciones, tiempo_limite_minutos, intentos_maximos, activa
            )
        `)
        .eq('id', req.params.asignacion_id)
        .eq('usuario_pagado_id', uid)
        .single();

    if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });
    if (!asig.prueba?.activa) return res.status(403).json({ error: 'Esta prueba no está activa' });

    // Verificar intentos disponibles
    const { data: intentos } = await supabase
        .from('capacitacion_intentos')
        .select('id, estado, numero_intento')
        .eq('asignacion_id', asig.id)
        .order('numero_intento', { ascending: false });

    const validos = (intentos || []).filter(i => i.estado !== 'abandonado');
    const enCurso = validos.find(i => i.estado === 'en_curso');
    const completado = validos.find(i => i.estado === 'completado');

    if (completado) return res.status(403).json({ error: 'Ya completaste esta prueba' });

    const maxIntentos = asig.prueba.intentos_maximos;
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
                numero_intento: validos.length + 1,
                estado: 'en_curso'
            })
            .select()
            .single();

        if (errNew) return res.status(500).json({ error: errNew.message });
        intento = nuevo;
    }

    // Preguntas SIN marcar cuál es correcta
    const { data: preguntas } = await supabase
        .from('capacitacion_preguntas')
        .select('id, orden, enunciado')
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

    // Respuestas ya guardadas en este intento
    const { data: respYa } = await supabase
        .from('capacitacion_respuestas')
        .select('pregunta_id, alternativa_id')
        .eq('intento_id', intento.id);

    const respMap = {};
    (respYa || []).forEach(r => { respMap[r.pregunta_id] = r.alternativa_id; });

    const preguntasConAlts = (preguntas || []).map(p => ({
        id: p.id,
        orden: p.orden,
        enunciado: p.enunciado,
        alternativas: altsMap[p.id] || [],
        respuesta_guardada: respMap[p.id] || null
    }));

    res.json({
        intento_id: intento.id,
        prueba: {
            id: asig.prueba.id,
            titulo: asig.prueba.titulo,
            instrucciones: asig.prueba.instrucciones,
            tiempo_limite_minutos: asig.prueba.tiempo_limite_minutos
        },
        preguntas: preguntasConAlts,
        iniciado_en: intento.iniciado_en
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
                prueba:capacitacion_pruebas!capacitacion_asignaciones_prueba_id_fkey(puntaje_minimo_aprobacion)
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

    // Contar total de preguntas
    const { count: totalPregCount } = await supabase
        .from('capacitacion_preguntas')
        .select('id', { count: 'exact', head: true })
        .eq('prueba_id', intento.asignacion.prueba_id);

    // Contar respuestas correctas
    const { count: correctasCount } = await supabase
        .from('capacitacion_respuestas')
        .select('id', { count: 'exact', head: true })
        .eq('intento_id', intento.id)
        .eq('es_correcta', true);

    const total = totalPregCount || 0;
    const correctas = correctasCount || 0;
    const puntaje = total > 0 ? Math.round((correctas / total) * 100 * 10) / 10 : 0;
    const minimo = parseFloat(intento.asignacion.prueba?.puntaje_minimo_aprobacion || 60);
    const aprobado = puntaje >= minimo;

    const { data, error } = await supabase
        .from('capacitacion_intentos')
        .update({
            estado: 'completado',
            finalizado_en: new Date().toISOString(),
            puntaje_obtenido: puntaje,
            aprobado
        })
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ...data, correctas, total_preguntas: total });
});

// ─── GET /intentos/:id/resultado ─── ver resultado con correcciones ──────────

router.get('/intentos/:id/resultado', async (req, res) => {
    const { data: intento } = await supabase
        .from('capacitacion_intentos')
        .select(`
            id, estado, puntaje_obtenido, aprobado, finalizado_en, numero_intento,
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
        .select('id, orden, enunciado, explicacion')
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

    const detalle = (preguntas || []).map(p => {
        const resp = respMap[p.id];
        return {
            pregunta_id: p.id,
            orden: p.orden,
            enunciado: p.enunciado,
            explicacion: p.explicacion,
            alternativas: altsMap[p.id] || [],
            alternativa_elegida: resp?.alternativa_id || null,
            es_correcta: resp?.es_correcta ?? null
        };
    });

    res.json({
        intento_id: intento.id,
        prueba: intento.asignacion.prueba,
        puntaje_obtenido: intento.puntaje_obtenido,
        aprobado: intento.aprobado,
        finalizado_en: intento.finalizado_en,
        numero_intento: intento.numero_intento,
        detalle
    });
});

module.exports = router;
