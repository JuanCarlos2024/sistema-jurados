/**
 * /api/usuario/capacitaciones
 *
 * Vista y rendición de pruebas para jurados/delegados.
 */

const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');
const jwt      = require('jsonwebtoken');
const JWT_SECRET_CAP = process.env.JWT_SECRET || 'fallback_secret_change_in_prod';

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

// ─── Helper: consolidar intento (finalización atómica, función compartida) ───
// Calcula puntaje/nota y actualiza capacitacion_intentos con WHERE estado='en_curso'.
// Retorna { data, ya_completado, correctas, incorrectas, no_respondidas, total, puntaje, nota, aprobado }.
// ya_completado=true → 0 filas actualizadas: otra solicitud ganó la carrera (race condition).
// Usa .maybeSingle() en lugar de .single() para evitar dependencia del código PGRST116.
// Las 3 consultas a la BD corren en paralelo (Promise.all) para reducir latencia.

async function _consolidarIntento({ intentoId, porTiempo }) {
    const { data: rpc, error } = await supabase.rpc('rpc_finalizar_intento', {
        p_intento_id: intentoId,
        p_por_tiempo: !!porTiempo
    });

    if (error) throw error;
    if (!rpc) throw new Error('rpc_finalizar_intento devolvió resultado nulo');
    if (rpc.codigo === 'NOT_FOUND') throw new Error('Intento ' + intentoId + ' no encontrado');
    if (rpc.codigo === 'ESTADO_INVALIDO') return { ya_completado: true };

    return {
        data:           rpc,
        ya_completado:  rpc.ya_completado  || false,
        correctas:      rpc.correctas       ?? 0,
        incorrectas:    rpc.incorrectas     ?? 0,
        no_respondidas: rpc.no_respondidas  ?? 0,
        total:          rpc.total_preguntas ?? 0,
        puntaje:        rpc.puntaje_obtenido ?? 0,
        nota:           rpc.nota,
        aprobado:       rpc.aprobado
    };
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

// ─── GET /:asignacion_id/materiales ─── materiales de estudio de una prueba ───

router.get('/:asignacion_id/materiales', async (req, res) => {
    const uid  = req.usuario.id;
    const tipo = req.usuario.tipo_persona;

    let allowed;
    if (tipo === 'jurado')           allowed = ['jurados', 'ambos'];
    else if (tipo === 'delegado_rentado') allowed = ['delegados', 'ambos'];
    else return res.status(403).json({ error: 'Tipo de usuario no autorizado' });

    const { data: asig } = await supabase
        .from('capacitacion_asignaciones')
        .select('id, prueba_id')
        .eq('id', req.params.asignacion_id)
        .eq('usuario_pagado_id', uid)
        .single();

    if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });

    const { data, error } = await supabase
        .from('capacitacion_materiales')
        .select(`
            id, obligatorio, orden,
            material:material_complementario(
                id, titulo, descripcion, categoria, tipo_material,
                nombre_archivo, url_externa, audiencia, obligatorio, estado, deleted_at
            )
        `)
        .eq('capacitacion_id', asig.prueba_id)
        .order('orden', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    const filtrados = (data || []).filter(cm => {
        const m = cm.material;
        return m && m.estado === 'publicado' && !m.deleted_at && allowed.includes(m.audiencia);
    }).map(cm => ({
        vinculo_id:  cm.id,
        obligatorio: cm.obligatorio,
        orden:       cm.orden,
        material: (({ estado, deleted_at, ...rest }) => rest)(cm.material)
    }));

    res.json(filtrados);
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
                tiempo_por_pregunta_segundos, tiempo_limite_minutos, intentos_maximos,
                estado, fecha_inicio, fecha_fin,
                mezclar_preguntas, mezclar_alternativas,
                puntaje_minimo_aprobacion, nota_minima, nota_maxima, nota_aprobacion
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
        .select('id, estado, numero_intento, orden_preguntas_json, orden_alternativas_json, vence_en, snapshot_contenido_json')
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
        // Calcular vence_en si la prueba tiene tiempo límite
        const venceEn = prueba.tiempo_limite_minutos
            ? new Date(Date.now() + prueba.tiempo_limite_minutos * 60000).toISOString()
            : null;

        const insertData = {
            asignacion_id:  asig.id,
            numero_intento: (intentos || []).length + 1,
            estado:         'en_curso'
        };
        if (venceEn) {
            insertData.vence_en               = venceEn;
            insertData.tiempo_limite_aplicado = prueba.tiempo_limite_minutos;
        }

        const { data: nuevo, error: errNew } = await supabase
            .from('capacitacion_intentos')
            .insert(insertData)
            .select()
            .single();

        if (errNew) return res.status(500).json({ error: errNew.message });
        intento = nuevo;
    } else if (enCurso.vence_en && new Date() > new Date(enCurso.vence_en)) {
        // Tiempo agotado en un intento retomado: consolidar vía RPC transaccional
        await supabase.rpc('rpc_finalizar_intento', {
            p_intento_id: enCurso.id,
            p_por_tiempo: true
        }).catch(function (eConsolidar) {
            console.error('[cap/iniciar] rpc_finalizar_intento intento=' + enCurso.id, eConsolidar?.message || eConsolidar);
        });
        return res.json({ tiempo_expirado: true, intento_id: enCurso.id });
    }

    // Preguntas con tipo y video_url — nunca se expone es_correcta
    const { data: preguntas } = await supabase
        .from('capacitacion_preguntas')
        .select('id, orden, enunciado, tipo, video_url, video_sin_audio, imagen_url')
        .eq('prueba_id', asig.prueba_id)
        .eq('anulada', false)
        .order('orden', { ascending: true })
        .order('id',    { ascending: true });

    const pregIds = (preguntas || []).map(p => p.id);
    let altsMap = {};

    if (pregIds.length > 0) {
        const { data: alts } = await supabase
            .from('capacitacion_alternativas')
            .select('id, pregunta_id, texto, orden')
            .in('pregunta_id', pregIds)
            .order('orden', { ascending: true })
            .order('id',    { ascending: true });

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

    // Índices para acceso rápido por id (definidos aquí para usarse también en snapshot)
    const pregByIdMap = {};
    (preguntas || []).forEach(p => { pregByIdMap[p.id] = p; });

    const altByIdMap = {};
    Object.values(altsMap).forEach(lista => lista.forEach(a => { altByIdMap[a.id] = a; }));

    // ── Orden de preguntas y alternativas ─────────────────────────────────────
    const mezclarPreg = prueba.mezclar_preguntas !== false;
    const mezclarAlts = prueba.mezclar_alternativas !== false;

    let ordenPregIds;
    let ordenAltsMap;
    let snapshotConteudo = intento.snapshot_contenido_json || null;

    const ordenGuardado = intento.orden_preguntas_json;
    if (ordenGuardado && Array.isArray(ordenGuardado) && ordenGuardado.length > 0) {
        // Intento existente: reutilizar el mismo orden sin volver a aleatorizar
        ordenPregIds = ordenGuardado;
        ordenAltsMap = intento.orden_alternativas_json || {};
    } else {
        // Intento nuevo: generar orden, congelar snapshot de contenido y persistir
        ordenPregIds = mezclarPreg ? shuffle(pregIds.slice()) : pregIds.slice();
        ordenAltsMap = {};
        pregIds.forEach(pid => {
            const altIds = (altsMap[pid] || []).map(a => a.id);
            ordenAltsMap[pid] = mezclarAlts ? shuffle(altIds.slice()) : altIds.slice();
        });

        // Snapshot inmutable: congela enunciado, imagen, video y textos al iniciar
        const nuevoSnapshot = { preguntas: {}, alternativas: {} };
        ordenPregIds.forEach(pid => {
            const p = pregByIdMap[pid];
            if (!p) return;
            nuevoSnapshot.preguntas[pid] = {
                enunciado:       p.enunciado,
                tipo:            p.tipo || 'alternativa_unica',
                imagen_url:      p.imagen_url      || null,
                video_url:       p.video_url       || null,
                video_sin_audio: p.video_sin_audio || false
            };
            (ordenAltsMap[pid] || []).forEach(aid => {
                const a = altByIdMap[aid];
                if (a) nuevoSnapshot.alternativas[aid] = a.texto;
            });
        });
        snapshotConteudo = nuevoSnapshot;

        await supabase
            .from('capacitacion_intentos')
            .update({
                orden_preguntas_json:    ordenPregIds,
                orden_alternativas_json: ordenAltsMap,
                snapshot_contenido_json: nuevoSnapshot
            })
            .eq('id', intento.id);
    }

    // Índices de contenido del snapshot
    const snapPregs = snapshotConteudo && snapshotConteudo.preguntas   ? snapshotConteudo.preguntas   : {};
    const snapAlts  = snapshotConteudo && snapshotConteudo.alternativas ? snapshotConteudo.alternativas : {};

    const preguntasConAlts = ordenPregIds
        .map(pid => {
            const pDb = pregByIdMap[pid];
            if (!pDb) return null;   // anulada o eliminada — excluir del examen

            const snap   = snapPregs[pid] || null;
            const altIds = ordenAltsMap[pid] || (altsMap[pid] || []).map(a => a.id);
            const altsOrdenadas = altIds
                .map(aid => {
                    const texto = snapAlts[aid] !== undefined
                        ? snapAlts[aid]
                        : (altByIdMap[aid] ? altByIdMap[aid].texto : null);
                    return texto !== null && texto !== undefined ? { id: aid, texto } : null;
                })
                .filter(Boolean);

            return {
                id:                 pid,
                enunciado:          snap ? snap.enunciado        : pDb.enunciado,
                tipo:               snap ? snap.tipo             : (pDb.tipo || 'alternativa_unica'),
                video_url:          snap ? snap.video_url        : (pDb.video_url        || null),
                video_sin_audio:    snap ? snap.video_sin_audio  : (pDb.video_sin_audio  || false),
                imagen_url:         snap ? snap.imagen_url       : (pDb.imagen_url       || null),
                alternativas:       altsOrdenadas,
                respuesta_guardada: respMap[pid] || null
            };
        })
        .filter(Boolean);

    res.json({
        intento_id:  intento.id,
        vence_en:    intento.vence_en || null,
        server_now:  new Date().toISOString(),
        prueba: {
            id:                           prueba.id,
            titulo:                       prueba.titulo,
            descripcion:                  prueba.descripcion || null,
            instrucciones:                prueba.instrucciones || null,
            tiempo_por_pregunta_segundos: prueba.tiempo_por_pregunta_segundos,
            tiempo_limite_minutos:        prueba.tiempo_limite_minutos || null
        },
        total_preguntas: preguntasConAlts.length,
        preguntas:       preguntasConAlts,
        iniciado_en:     intento.iniciado_en
    });
});

// ─── POST /intentos/:id/responder ─── guardar una respuesta ──────────────────

router.post('/intentos/:id/responder', async (req, res) => {
    const _t0       = Date.now();
    const intentoId = req.params.id;
    const { pregunta_id, alternativa_id } = req.body;
    const _log = (msg) => console.log(`[cap/responder] ${msg} intento=${intentoId} preg=${pregunta_id} alt=${alternativa_id ?? 'null'} dur=${Date.now() - _t0}ms`);

    try {
        if (!pregunta_id) return res.status(400).json({ error: 'pregunta_id es obligatorio' });

        // Verificar ownership del intento (autenticación JWT — el resto lo maneja el RPC)
        const { data: asigCheck } = await supabase
            .from('capacitacion_intentos')
            .select(`
                id,
                asignacion:capacitacion_asignaciones!capacitacion_intentos_asignacion_id_fkey(
                    usuario_pagado_id
                )
            `)
            .eq('id', intentoId)
            .maybeSingle();

        if (!asigCheck || asigCheck.asignacion?.usuario_pagado_id !== req.usuario.id) {
            _log('403-no-autorizado');
            return res.status(403).json({ error: 'No autorizado' });
        }

        // Guardar respuesta vía RPC transaccional:
        // · Toma FOR UPDATE sobre el intento antes del upsert
        // · Si /finalizar ganó el lock primero → devuelve INTENTO_FINALIZADO sin persistir
        // · Verifica vence_en, fecha_fin, pregunta y alternativa en la misma transacción
        const { data: rpc, error: rpcErr } = await supabase.rpc('rpc_guardar_respuesta', {
            p_intento_id:     intentoId,
            p_pregunta_id:    pregunta_id,
            p_alternativa_id: alternativa_id || null
        });

        if (rpcErr) {
            _log(`500-rpc-error codigo=${rpcErr.code}`);
            return res.status(500).json({ error: rpcErr.message });
        }

        const codigo = rpc?.codigo;

        if (codigo === 'INTENTO_FINALIZADO') {
            _log('409-INTENTO_FINALIZADO');
            return res.status(409).json({ codigo: 'INTENTO_FINALIZADO', error: rpc.error, intento_id: intentoId });
        }
        if (codigo === 'TIEMPO_AGOTADO') {
            // Safety net: consolidar ahora (el frontend también llamará /finalizar)
            supabase.rpc('rpc_finalizar_intento', {
                p_intento_id: intentoId,
                p_por_tiempo: true
            }).catch(function (eC) {
                console.error('[cap/responder] rpc_finalizar_intento intento=' + intentoId, eC?.message || eC);
            });
            _log('409-TIEMPO_AGOTADO');
            return res.status(409).json({ codigo: 'TIEMPO_AGOTADO', error: rpc.error || 'Tiempo expirado', intento_id: intentoId });
        }
        if (codigo === 'ESTADO_INVALIDO') {
            _log('400-estado-invalido');
            return res.status(400).json({ error: rpc.error || 'Este intento ya no está en curso' });
        }
        if (codigo === 'PREGUNTA_INVALIDA') {
            _log('400-pregunta-invalida');
            return res.status(400).json({ error: rpc.error || 'Pregunta no válida para esta prueba' });
        }
        if (codigo === 'ALTERNATIVA_INVALIDA') {
            _log('400-alternativa-invalida');
            return res.status(400).json({ error: rpc.error || 'Alternativa no válida' });
        }
        if (codigo === 'NOT_FOUND') {
            _log('404-not-found');
            return res.status(404).json({ error: rpc.error || 'Intento no encontrado' });
        }

        _log(`200-ok ya_existia=${rpc?.ya_existia}`);
        res.json(rpc);

    } catch (err) {
        console.error(`[cap/responder] excepcion intento=${intentoId} dur=${Date.now() - _t0}ms`, err.message || err);
        if (!res.headersSent) res.status(500).json({ error: 'Error interno al guardar la respuesta' });
    }
});

// ─── GET /intentos/:id/respuestas/:preguntaId ─── verificar respuesta guardada ─

router.get('/intentos/:id/respuestas/:preguntaId', async (req, res) => {
    try {
        const { data: intento } = await supabase
            .from('capacitacion_intentos')
            .select(`
                id,
                asignacion:capacitacion_asignaciones!capacitacion_intentos_asignacion_id_fkey(
                    usuario_pagado_id
                )
            `)
            .eq('id', req.params.id)
            .single();

        if (!intento || intento.asignacion?.usuario_pagado_id !== req.usuario.id) {
            return res.status(403).json({ error: 'No autorizado' });
        }

        const { data: resp } = await supabase
            .from('capacitacion_respuestas')
            .select('id, pregunta_id, alternativa_id, respondida_en')
            .eq('intento_id', intento.id)
            .eq('pregunta_id', req.params.preguntaId)
            .maybeSingle();

        res.json(resp
            ? { guardada: true, id: resp.id, pregunta_id: resp.pregunta_id, alternativa_id: resp.alternativa_id, respondida_en: resp.respondida_en }
            : { guardada: false }
        );
    } catch (err) {
        console.error('[cap/verificar-resp] excepcion', err.message || err);
        if (!res.headersSent) res.status(500).json({ error: 'Error al verificar respuesta' });
    }
});

// ─── GET /intentos/:id/estado ─── consultar estado real del intento ──────────

router.get('/intentos/:id/estado', async (req, res) => {
    try {
        const { data: intento } = await supabase
            .from('capacitacion_intentos')
            .select(`
                id, estado, iniciado_en, finalizado_en, vence_en, finalizado_por_tiempo,
                asignacion:capacitacion_asignaciones!capacitacion_intentos_asignacion_id_fkey(
                    usuario_pagado_id
                )
            `)
            .eq('id', req.params.id)
            .single();

        if (!intento || intento.asignacion?.usuario_pagado_id !== req.usuario.id) {
            return res.status(403).json({ error: 'No autorizado' });
        }

        const venceMs = intento.vence_en ? new Date(intento.vence_en).getTime() : null;
        const tiempoRestanteSegundos = venceMs ? Math.max(0, Math.floor((venceMs - Date.now()) / 1000)) : null;

        res.json({
            id:                       intento.id,
            estado:                   intento.estado,
            iniciado_en:              intento.iniciado_en,
            finalizado_en:            intento.finalizado_en,
            finalizado_por_tiempo:    intento.finalizado_por_tiempo,
            vence_en:                 intento.vence_en,
            tiempo_restante_segundos: tiempoRestanteSegundos,
            server_now:               new Date().toISOString()
        });
    } catch (err) {
        console.error('[cap/estado] excepcion', err.message || err);
        if (!res.headersSent) res.status(500).json({ error: 'Error al obtener estado del intento' });
    }
});

// ─── POST /intentos/:id/finalizar ─── enviar y calcular puntaje ──────────────

router.post('/intentos/:id/finalizar', async (req, res) => {
    const _t0       = Date.now();
    const intentoId = req.params.id;
    const _log = (msg) => console.log(`[cap/finalizar] ${msg} intento=${intentoId} uid=${req.usuario?.id} dur=${Date.now() - _t0}ms`);

    try {
        const { por_tiempo = false } = req.body;

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
            .eq('id', intentoId)
            .single();

        if (!intento || intento.asignacion?.usuario_pagado_id !== req.usuario.id) {
            _log('403-no-autorizado');
            return res.status(403).json({ error: 'No autorizado' });
        }

        // Idempotente: si ya está completado, devolver OK sin recalcular nota
        if (intento.estado === 'completado') {
            _log('200-ya-completado idempotente');
            return res.json({ ok: true, ya_completado: true, intento_id: intento.id, estado: 'completado' });
        }

        if (intento.estado !== 'en_curso') {
            _log('400-estado-invalido estado=' + intento.estado);
            return res.status(400).json({ error: 'Este intento no está en curso' });
        }

        _log('inicio por_tiempo=' + por_tiempo);

        const result = await _consolidarIntento({
            intentoId: intentoId,
            porTiempo: por_tiempo
        });

        if (result.ya_completado) {
            // 0 filas actualizadas: otro proceso finalizó el intento primero (race condition)
            const { data: actual } = await supabase
                .from('capacitacion_intentos')
                .select('id, estado, puntaje_obtenido, nota, aprobado, finalizado_en, finalizado_por_tiempo')
                .eq('id', intentoId)
                .single();
            _log('200-ya-completado-concurrente');
            return res.json({ ok: true, ya_completado: true, intento_id: intentoId, estado: actual?.estado || 'completado' });
        }

        const { data, correctas, incorrectas, no_respondidas, total, puntaje } = result;
        _log(`200-ok puntaje=${puntaje} correctas=${correctas}/${total} no_resp=${no_respondidas}`);
        res.json({ ...data, correctas, incorrectas, no_respondidas, total_preguntas: total });

    } catch (err) {
        console.error(`[cap/finalizar] excepcion intento=${intentoId} dur=${Date.now() - _t0}ms`, err.message || err);
        if (!res.headersSent) res.status(500).json({ error: 'Error interno al finalizar la prueba' });
    }
});

// ─── POST /intentos/:id/abandonar ─── finalizar por salida/abandono ──────────
// Acepta token en Authorization header O en query ?t=TOKEN
// (sendBeacon no puede enviar headers custom, por eso también acepta query param).
// Idempotente: si el intento ya está completado devuelve 200 sin recalcular.

router.post('/intentos/:id/abandonar', async (req, res) => {
    const _t0       = Date.now();
    const intentoId = req.params.id;

    try {
        const authHeader = req.headers['authorization'];
        const rawToken   = authHeader
            ? authHeader.split(' ')[1]
            : (req.query.t || null);

        if (!rawToken) return res.status(401).json({ error: 'Token requerido' });

        let usuario;
        try {
            usuario = jwt.verify(rawToken, JWT_SECRET_CAP);
        } catch (e) {
            return res.status(401).json({ error: 'Token inválido o expirado' });
        }
        if (usuario.tipo !== 'usuario_pagado') {
            return res.status(403).json({ error: 'Sin permisos' });
        }

        const _log = (msg) => console.log(`[cap/abandonar] ${msg} intento=${intentoId} uid=${usuario.id} dur=${Date.now() - _t0}ms`);

        const { data: intento } = await supabase
            .from('capacitacion_intentos')
            .select(`
                id, estado, asignacion_id, finalizado_por_tiempo,
                asignacion:capacitacion_asignaciones!capacitacion_intentos_asignacion_id_fkey(
                    usuario_pagado_id, prueba_id,
                    prueba:capacitacion_pruebas!capacitacion_asignaciones_prueba_id_fkey(
                        puntaje_minimo_aprobacion, nota_minima, nota_maxima, nota_aprobacion
                    )
                )
            `)
            .eq('id', intentoId)
            .single();

        if (!intento || intento.asignacion?.usuario_pagado_id !== usuario.id) {
            return res.status(403).json({ error: 'No autorizado' });
        }

        // Idempotente: si ya fue finalizado (completado o abandonado) no recalcular
        if (intento.estado === 'completado' || intento.estado === 'abandonado') {
            _log('200-ya-finalizado idempotente estado=' + intento.estado + ' por_tiempo=' + (intento.finalizado_por_tiempo ? 'true' : 'false'));
            return res.json({ ok: true, ya_completado: true, intento_id: intento.id, estado: intento.estado, finalizado_por_tiempo: intento.finalizado_por_tiempo || false });
        }
        if (intento.estado !== 'en_curso') {
            _log('400-estado-invalido estado=' + intento.estado);
            return res.status(400).json({ error: 'El intento no está en curso' });
        }

        _log('inicio');

        const result = await _consolidarIntento({
            intentoId: intentoId,
            porTiempo: false
        });

        if (result.ya_completado) {
            _log('200-ya-completado-concurrente');
            return res.json({ ok: true, ya_completado: true, intento_id: intentoId });
        }

        const { puntaje, nota, aprobado, correctas, total } = result;
        _log(`200-ok puntaje=${puntaje} correctas=${correctas}/${total}`);
        res.json({ ok: true, intento_id: intento.id, puntaje, nota, aprobado });

    } catch (err) {
        console.error(`[cap/abandonar] excepcion intento=${intentoId} dur=${Date.now() - _t0}ms`, err.message || err);
        if (!res.headersSent) res.status(500).json({ error: 'Error interno al procesar el abandono' });
    }
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
        .select('id, orden, enunciado, tipo, imagen_url')
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
            tipo:                p.tipo || null,
            imagen_url:          p.imagen_url || null,
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
