const express      = require('express');
const router       = express.Router();
const supabase     = require('../../config/supabase');
const multer       = require('multer');
const XLSX         = require('xlsx');
const emailService = require('../../services/emailService');

// Calcula el próximo día-de-semana a partir de una fecha, con hora específica
function calcFechaLimite(fechaApertura, diaLimiteStr, horaLimiteStr) {
    const DIAS = { lunes:1, martes:2, miercoles:3, jueves:4, viernes:5, sabado:6, domingo:0 };
    const key  = (diaLimiteStr || 'lunes').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const targetDay = DIAS[key];
    if (targetDay === undefined) return null;

    const apertura   = new Date(fechaApertura);
    let   daysAhead  = ((targetDay - apertura.getDay()) + 7) % 7;
    if (daysAhead === 0) daysAhead = 7; // mismo día → siguiente semana

    const limite = new Date(apertura);
    limite.setDate(limite.getDate() + daysAhead);
    const [h, m] = (horaLimiteStr || '23:59').split(':').map(Number);
    limite.setHours(h, m, 0, 0);
    return limite.toISOString();
}

// Obtiene jurados asignados activos con email para un rodeo
async function getJuradosConEmail(rodeoId) {
    const { data } = await supabase
        .from('asignaciones')
        .select('estado_designacion, usuario:usuarios_pagados!inner(id, nombre_completo, email)')
        .eq('rodeo_id', rodeoId)
        .eq('tipo_persona', 'jurado')
        .eq('estado', 'activo');

    return (data || [])
        .filter(a => a.estado_designacion !== 'rechazado')
        .map(a => a.usuario)
        .filter(Boolean);
}

const uploadExcel = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.originalname.match(/\.(xlsx|xls)$/i)) cb(null, true);
        else cb(new Error('Solo se permiten archivos Excel (.xlsx, .xls)'));
    }
});

// POST /:id/abrir — abrir ciclo al jurado
router.post('/:id/abrir', async (req, res) => {
    const { data: ciclo, error: cicloErr } = await supabase
        .from('evaluacion_ciclos')
        .select('*, evaluacion:evaluaciones(id, estado, rodeo_id, rodeo:rodeos(id, club, fecha, asociacion))')
        .eq('id', req.params.id)
        .single();

    if (cicloErr) return res.status(404).json({ error: 'Ciclo no encontrado' });

    const estadosAbribles = ['pendiente_carga', 'cargado', 'sin_casos'];
    if (!estadosAbribles.includes(ciclo.estado)) {
        return res.status(409).json({ error: `No se puede abrir el ciclo desde estado: ${ciclo.estado}` });
    }

    // Leer configuración para plazos
    const { data: cfg } = await supabase
        .from('evaluacion_configuracion')
        .select('usar_plazo_respuesta, ciclo1_dia_limite, ciclo1_hora_limite, ciclo2_dia_limite, ciclo2_hora_limite, usar_aceptacion_silencio')
        .eq('activo', true)
        .single();

    const now = new Date().toISOString();

    // Calcular fecha_limite_respuesta si está activado
    let fechaLimite = null;
    if (cfg?.usar_plazo_respuesta) {
        const diaKey  = ciclo.numero_ciclo === 1 ? cfg.ciclo1_dia_limite  : cfg.ciclo2_dia_limite;
        const horaKey = ciclo.numero_ciclo === 1 ? cfg.ciclo1_hora_limite : cfg.ciclo2_hora_limite;
        fechaLimite = calcFechaLimite(now, diaKey, horaKey);
    }

    const { data: cicloAct, error: updErr } = await supabase
        .from('evaluacion_ciclos')
        .update({
            estado:                 'abierto',
            fecha_apertura:         now,
            abierto_por:            req.usuario.id,
            fecha_limite_respuesta: fechaLimite,
            updated_at:             now
        })
        .eq('id', req.params.id)
        .select()
        .single();

    if (updErr) return res.status(500).json({ error: updErr.message });

    // Casos cargados → visible_jurado
    await supabase
        .from('evaluacion_casos')
        .update({ estado: 'visible_jurado', updated_at: now })
        .eq('ciclo_id', req.params.id)
        .eq('estado', 'cargado');

    // Evaluacion borrador → en_proceso
    const ev = ciclo.evaluacion;
    if (ev && ev.estado === 'borrador') {
        await supabase
            .from('evaluaciones')
            .update({ estado: 'en_proceso', updated_at: now })
            .eq('id', ev.id);
    }

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: ciclo.evaluacion_id,
        ciclo_id:      req.params.id,
        accion:        'abrir_ciclo',
        detalle:       { numero_ciclo: ciclo.numero_ciclo, fecha_limite_respuesta: fechaLimite },
        actor_id:      req.usuario.id,
        actor_tipo:    'administrador',
        actor_nombre:  req.usuario.nombre,
        ip_address:    req.ip
    });

    // Enviar correos a jurados (no bloquea si falla)
    try {
        const jurados = await getJuradosConEmail(ev.rodeo_id);
        if (jurados.length > 0) {
            await emailService.notificarJuradosCicloAbierto({
                ciclo:         { ...cicloAct, numero_ciclo: ciclo.numero_ciclo },
                rodeo:         ev.rodeo,
                jurados,
                configuracion: cfg
            });
            await supabase
                .from('evaluacion_ciclos')
                .update({ notificacion_enviada_at: new Date().toISOString() })
                .eq('id', req.params.id);
            cicloAct.notificacion_enviada_at = new Date().toISOString();
        }
    } catch (emailErr) {
        console.warn('[ciclos/abrir] Error al enviar notificaciones:', emailErr.message);
    }

    res.json({ ...cicloAct, mensaje: 'Ciclo abierto correctamente' });
});

// POST /:id/reenviar-notificacion — reenviar correo a jurados
router.post('/:id/reenviar-notificacion', async (req, res) => {
    const { data: ciclo, error: cicloErr } = await supabase
        .from('evaluacion_ciclos')
        .select('*, evaluacion:evaluaciones(id, rodeo_id, rodeo:rodeos(id, club, fecha, asociacion))')
        .eq('id', req.params.id)
        .single();

    if (cicloErr) return res.status(404).json({ error: 'Ciclo no encontrado' });
    if (!['abierto', 'en_revision'].includes(ciclo.estado)) {
        return res.status(409).json({ error: `No se puede reenviar notificación en estado: ${ciclo.estado}` });
    }

    const { data: cfg } = await supabase
        .from('evaluacion_configuracion')
        .select('usar_plazo_respuesta, usar_aceptacion_silencio')
        .eq('activo', true)
        .single();

    const ev     = ciclo.evaluacion;
    const jurados = await getJuradosConEmail(ev.rodeo_id);

    if (jurados.length === 0) {
        return res.status(409).json({ error: 'No hay jurados activos con correo para notificar' });
    }

    const resultados = await emailService.notificarJuradosCicloAbierto({
        ciclo:         ciclo,
        rodeo:         ev.rodeo,
        jurados,
        configuracion: cfg
    });

    const now = new Date().toISOString();
    await supabase
        .from('evaluacion_ciclos')
        .update({ notificacion_reenviada_at: now })
        .eq('id', req.params.id);

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: ciclo.evaluacion_id,
        ciclo_id:      req.params.id,
        accion:        'reenviar_notificacion',
        detalle:       { enviados: resultados.filter(r => r.ok).length, total: resultados.length },
        actor_id:      req.usuario.id,
        actor_tipo:    'administrador',
        actor_nombre:  req.usuario.nombre,
        ip_address:    req.ip
    });

    const enviados = resultados.filter(r => r.ok).length;
    res.json({
        mensaje:    `Notificación reenviada a ${enviados} de ${resultados.length} jurado(s)`,
        resultados
    });
});

// POST /:id/reabrir — reabrir ciclo cerrado/en_revision
router.post('/:id/reabrir', async (req, res) => {
    const { motivo } = req.body;

    if (!motivo || !motivo.trim()) {
        return res.status(400).json({ error: 'motivo es obligatorio para reabrir el ciclo' });
    }

    const { data: ciclo, error: cicloErr } = await supabase
        .from('evaluacion_ciclos')
        .select('*, evaluacion:evaluaciones(id, estado, rodeo_id)')
        .eq('id', req.params.id)
        .single();

    if (cicloErr) return res.status(404).json({ error: 'Ciclo no encontrado' });

    const ESTADOS_REABRIBLES = ['cerrado', 'en_revision'];
    if (!ESTADOS_REABRIBLES.includes(ciclo.estado)) {
        return res.status(409).json({
            error: `Solo se puede reabrir un ciclo cerrado o en revisión (actual: ${ciclo.estado})`
        });
    }

    const ev = ciclo.evaluacion;
    if (ev && ['publicado', 'cerrado'].includes(ev.estado)) {
        return res.status(409).json({
            error: `No se puede reabrir el ciclo porque la evaluación está ${ev.estado}`
        });
    }

    const now           = new Date().toISOString();
    const estadoAnterior = ciclo.estado;
    const nuevasReaperturas = (ciclo.cantidad_reaperturas || 0) + 1;

    const { data: cicloAct, error: updErr } = await supabase
        .from('evaluacion_ciclos')
        .update({
            estado:               'abierto',
            fecha_reapertura:     now,
            reabierto_por:        req.usuario.id,
            motivo_reapertura:    motivo.trim(),
            cantidad_reaperturas: nuevasReaperturas,
            updated_at:           now
        })
        .eq('id', req.params.id)
        .select()
        .single();

    if (updErr) return res.status(500).json({ error: updErr.message });

    // Si la evaluación estaba en estados bloqueantes, volver a en_proceso
    if (ev && ['pendiente_aprobacion', 'devuelto'].includes(ev.estado)) {
        await supabase
            .from('evaluaciones')
            .update({ estado: 'en_proceso', updated_at: now })
            .eq('id', ev.id);
    }

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: ciclo.evaluacion_id,
        ciclo_id:      req.params.id,
        accion:        'reabrir_ciclo',
        detalle: {
            numero_ciclo:    ciclo.numero_ciclo,
            estado_anterior: estadoAnterior,
            estado_nuevo:    'abierto',
            motivo:          motivo.trim(),
            reapertura_n:    nuevasReaperturas
        },
        actor_id:     req.usuario.id,
        actor_tipo:   'administrador',
        actor_nombre: req.usuario.nombre,
        ip_address:   req.ip
    });

    res.json({ ...cicloAct, mensaje: 'Ciclo reabierto correctamente' });
});

// POST /:id/cerrar — cerrar ciclo manualmente
router.post('/:id/cerrar', async (req, res) => {
    const { motivo_cierre } = req.body;

    const { data: ciclo, error: cicloErr } = await supabase
        .from('evaluacion_ciclos')
        .select('*, evaluacion:evaluaciones(id, rodeo_id)')
        .eq('id', req.params.id)
        .single();

    if (cicloErr) return res.status(404).json({ error: 'Ciclo no encontrado' });
    if (ciclo.estado !== 'abierto') {
        return res.status(409).json({ error: `El ciclo debe estar abierto para cerrarlo (actual: ${ciclo.estado})` });
    }

    const now = new Date().toISOString();

    // Contar total de casos del ciclo
    const { count: totalCasos } = await supabase
        .from('evaluacion_casos')
        .select('id', { count: 'exact', head: true })
        .eq('ciclo_id', req.params.id);

    // Obtener casos aún visible_jurado (incluye descuento_puntos para sin_respuesta)
    const { data: casosVisibles } = await supabase
        .from('evaluacion_casos')
        .select('id, tipo_caso, descuento_puntos')
        .eq('ciclo_id', req.params.id)
        .eq('estado', 'visible_jurado');

    if (casosVisibles && casosVisibles.length > 0) {
        // Jurados activos del rodeo
        const { data: juradoAsigs } = await supabase
            .from('asignaciones')
            .select('id, usuarios_pagados!inner(tipo_persona)')
            .eq('rodeo_id', ciclo.evaluacion.rodeo_id)
            .eq('estado', 'activo')
            .neq('estado_designacion', 'rechazado')
            .eq('usuarios_pagados.tipo_persona', 'jurado');

        const juradoIds    = (juradoAsigs || []).map(a => a.id);
        const totalJurados = juradoIds.length;
        const casoIds      = casosVisibles.map(c => c.id);

        // Batch: todas las respuestas existentes para estos casos
        const { data: todasRespuestas } = juradoIds.length > 0
            ? await supabase
                .from('evaluacion_respuestas_jurado')
                .select('caso_id, asignacion_id, decision')
                .in('caso_id', casoIds)
                .in('asignacion_id', juradoIds)
            : { data: [] };

        const respPorCaso = {};
        for (const r of (todasRespuestas || [])) {
            (respPorCaso[r.caso_id] = respPorCaso[r.caso_id] || []).push(r);
        }

        // Insertar sin_respuesta para jurados que no respondieron
        const sinRespInserts = [];
        for (const caso of casosVisibles) {
            const resps = respPorCaso[caso.id] || [];
            const yaRespondieron = new Set(resps.map(r => r.asignacion_id));
            for (const asig_id of juradoIds) {
                if (!yaRespondieron.has(asig_id)) {
                    sinRespInserts.push({
                        caso_id:         caso.id,
                        asignacion_id:   asig_id,
                        decision:        'sin_respuesta',
                        descuento_final: caso.descuento_puntos ?? 0,
                        created_at:      now
                    });
                }
            }
        }
        if (sinRespInserts.length > 0) {
            await supabase.from('evaluacion_respuestas_jurado').insert(sinRespInserts);
        }

        // Actualizar estado de cada caso
        for (const caso of casosVisibles) {
            const resps  = respPorCaso[caso.id] || [];
            const acepta  = resps.filter(x => x.decision === 'acepta').length;
            const rechaza = resps.filter(x => x.decision === 'rechaza').length;

            // Si no hubo ninguna respuesta real (todos sin_respuesta) → auto-resolver
            if (acepta === 0 && rechaza === 0 && totalJurados > 0) {
                let resolucion_final;
                if (caso.descuento_puntos === 0 || caso.tipo_caso === 'informativo') {
                    resolucion_final = 'sin_descuento';
                } else {
                    resolucion_final = caso.tipo_caso === 'interpretativa'
                        ? 'interpretativa_confirmada'
                        : 'reglamentaria_confirmada';
                }
                await supabase
                    .from('evaluacion_casos')
                    .update({ estado: 'resuelto', estado_consolidado: 'incompleto', resolucion_final, updated_at: now })
                    .eq('id', caso.id);
                continue;
            }

            // Caso con al menos una respuesta real → pendiente_analista
            let estado_consolidado = 'pendiente';
            if (totalJurados > 0) {
                if (acepta + rechaza < totalJurados) {
                    estado_consolidado = 'incompleto';
                } else if (rechaza > acepta) {
                    estado_consolidado = 'rechazado';
                } else {
                    estado_consolidado = 'aceptado';
                }
            }

            await supabase
                .from('evaluacion_casos')
                .update({ estado: 'pendiente_analista', estado_consolidado, updated_at: now })
                .eq('id', caso.id);
        }
    }

    // Cerrar directamente si no quedan casos en pendiente_analista
    const { count: pendientesAnalista } = await supabase
        .from('evaluacion_casos')
        .select('id', { count: 'exact', head: true })
        .eq('ciclo_id', req.params.id)
        .eq('estado', 'pendiente_analista');

    const estadoCiclo = (totalCasos === 0 || pendientesAnalista === 0) ? 'cerrado' : 'en_revision';

    const { data: cicloAct, error: updErr } = await supabase
        .from('evaluacion_ciclos')
        .update({
            estado:        estadoCiclo,
            fecha_cierre:  now,
            cerrado_por:   req.usuario.id,
            motivo_cierre: motivo_cierre || null,
            updated_at:    now
        })
        .eq('id', req.params.id)
        .select()
        .single();

    if (updErr) return res.status(500).json({ error: updErr.message });

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: ciclo.evaluacion_id,
        ciclo_id:      req.params.id,
        accion:        'cerrar_ciclo_manual',
        detalle:       { numero_ciclo: ciclo.numero_ciclo, motivo_cierre: motivo_cierre || null },
        actor_id:      req.usuario.id,
        actor_tipo:    'administrador',
        actor_nombre:  req.usuario.nombre,
        ip_address:    req.ip
    });

    res.json(cicloAct);
});

async function getDescuentos() {
    const { data } = await supabase
        .from('evaluacion_configuracion')
        .select('descuento_interpretativa, descuento_reglamentaria, descuento_informativo')
        .eq('activo', true)
        .single();
    return {
        interpretativa: data?.descuento_interpretativa ?? 1,
        reglamentaria:  data?.descuento_reglamentaria  ?? 2,
        informativo:    data?.descuento_informativo    ?? 0
    };
}

// POST /:id/casos — agregar caso al ciclo
router.post('/:id/casos', async (req, res) => {
    const { tipo_caso, descripcion, video_url } = req.body;

    if (!tipo_caso || !['interpretativa', 'reglamentaria', 'informativo'].includes(tipo_caso)) {
        return res.status(400).json({ error: 'tipo_caso inválido (interpretativa|reglamentaria|informativo)' });
    }

    const { data: ciclo, error: cicloErr } = await supabase
        .from('evaluacion_ciclos')
        .select('id, numero_ciclo, evaluacion_id, estado, max_casos')
        .eq('id', req.params.id)
        .single();

    if (cicloErr) return res.status(404).json({ error: 'Ciclo no encontrado' });

    if (tipo_caso === 'informativo' && ciclo.numero_ciclo !== 2) {
        return res.status(400).json({ error: 'Los casos informativos solo pueden agregarse al ciclo 2' });
    }

    const { count } = await supabase
        .from('evaluacion_casos')
        .select('id', { count: 'exact', head: true })
        .eq('ciclo_id', req.params.id);

    if (ciclo.max_casos && (count || 0) >= ciclo.max_casos) {
        return res.status(409).json({ error: `El ciclo ya tiene el máximo de casos permitidos (${ciclo.max_casos})` });
    }

    const numero_caso = (count || 0) + 1;
    const _desc = await getDescuentos();
    const descuento_puntos = _desc[tipo_caso] ?? 0;

    const { data: caso, error: casoErr } = await supabase
        .from('evaluacion_casos')
        .insert({
            ciclo_id:        req.params.id,
            evaluacion_id:   ciclo.evaluacion_id,
            numero_caso,
            tipo_caso,
            descuento_puntos,
            descripcion:     descripcion || null,
            video_url:       video_url || null,
            cargado_por:     req.usuario.id,
            estado:          ciclo.estado === 'abierto' ? 'visible_jurado' : 'cargado'
        })
        .select()
        .single();

    if (casoErr) return res.status(500).json({ error: casoErr.message });

    if (['pendiente_carga', 'sin_casos'].includes(ciclo.estado)) {
        await supabase
            .from('evaluacion_ciclos')
            .update({ estado: 'cargado', updated_at: new Date().toISOString() })
            .eq('id', req.params.id);
    }

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: ciclo.evaluacion_id,
        ciclo_id:      req.params.id,
        caso_id:       caso.id,
        accion:        'cargar_caso',
        detalle:       { tipo_caso, numero_caso },
        actor_id:      req.usuario.id,
        actor_tipo:    'administrador',
        actor_nombre:  req.usuario.nombre,
        ip_address:    req.ip
    });

    res.status(201).json(caso);
});

// GET /:id/plantilla — descargar plantilla Excel para carga masiva
router.get('/:id/plantilla', async (req, res) => {
    try {
        const ExcelJS = require('exceljs');
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Casos');

        ws.columns = [
            { header: 'ciclo',        key: 'ciclo',        width: 8  },
            { header: 'numero_caso',  key: 'numero_caso',  width: 14 },
            { header: 'tipo_caso',    key: 'tipo_caso',    width: 18 },
            { header: 'descripcion',  key: 'descripcion',  width: 40 },
            { header: 'url_video',    key: 'url_video',    width: 30 },
        ];

        ws.addRow({ ciclo: 1, numero_caso: 1, tipo_caso: 'interpretativa', descripcion: 'Ejemplo descripción', url_video: '' });
        ws.addRow({ ciclo: 1, numero_caso: 2, tipo_caso: 'reglamentaria',  descripcion: 'Ejemplo descripción', url_video: 'https://...' });
        ws.addRow({ ciclo: 2, numero_caso: 1, tipo_caso: 'informativo',    descripcion: 'Solo ciclo 2',        url_video: '' });

        res.setHeader('Content-Disposition', 'attachment; filename="plantilla_casos.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        await wb.xlsx.write(res);
        res.end();
    } catch (e) {
        console.error('[plantilla] error:', e);
        res.status(500).json({ error: 'Error al generar plantilla: ' + e.message });
    }
});

// POST /:id/importar — importar casos desde Excel (?preview=true para previsualizar sin insertar)
router.post('/:id/importar', uploadExcel.single('archivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

    const preview = req.query.preview === 'true';

    const { data: ciclo, error: cicloErr } = await supabase
        .from('evaluacion_ciclos')
        .select('id, numero_ciclo, evaluacion_id, estado, max_casos')
        .eq('id', req.params.id)
        .single();

    if (cicloErr) return res.status(404).json({ error: 'Ciclo no encontrado' });
    // Permite importar en estado abierto (casos se crean como visible_jurado)
    if (['cerrado', 'en_revision'].includes(ciclo.estado)) {
        return res.status(409).json({ error: `No se pueden cargar casos en estado: ${ciclo.estado}` });
    }

    // Parse Excel
    let filas;
    try {
        const wb  = XLSX.read(req.file.buffer, { type: 'buffer' });
        const ws  = wb.Sheets[wb.SheetNames[0]];
        filas = XLSX.utils.sheet_to_json(ws, { defval: '' });
    } catch (e) {
        return res.status(400).json({ error: 'No se pudo leer el archivo Excel: ' + e.message });
    }

    if (!filas || filas.length === 0) return res.status(400).json({ error: 'El archivo está vacío' });

    // Números de caso ya existentes
    const { data: existentes } = await supabase
        .from('evaluacion_casos')
        .select('numero_caso')
        .eq('ciclo_id', req.params.id);
    const numerosExistentes = new Set((existentes || []).map(c => Number(c.numero_caso)));

    const { count: totalActual } = await supabase
        .from('evaluacion_casos')
        .select('id', { count: 'exact', head: true })
        .eq('ciclo_id', req.params.id);

    const TIPOS_VALIDOS   = ['interpretativa', 'reglamentaria', 'informativo'];
    const DESCUENTO_EXCEL = await getDescuentos();
    const errores = [];
    const filasValidas = [];
    const numerosEnArchivo = new Set();

    for (let i = 0; i < filas.length; i++) {
        const f    = filas[i];
        const fila = i + 2;

        const tipo_caso   = String(f.tipo_caso   || '').trim().toLowerCase();
        const numero_caso = parseInt(f.numero_caso);
        const descripcion = String(f.descripcion || '').trim() || null;
        const url_video   = String(f.url_video   || '').trim() || null;

        if (!tipo_caso || !TIPOS_VALIDOS.includes(tipo_caso)) {
            errores.push({ fila, error: `tipo_caso inválido: "${f.tipo_caso}" (valores válidos: interpretativa, reglamentaria, informativo)` });
            continue;
        }
        if (isNaN(numero_caso) || numero_caso < 1) {
            errores.push({ fila, error: `numero_caso inválido: "${f.numero_caso}" (debe ser número >= 1)` });
            continue;
        }
        if (tipo_caso === 'informativo' && ciclo.numero_ciclo !== 2) {
            errores.push({ fila, error: `Casos informativos solo se permiten en Ciclo 2` });
            continue;
        }
        if (numerosExistentes.has(numero_caso)) {
            errores.push({ fila, error: `numero_caso ${numero_caso} ya existe en este ciclo` });
            continue;
        }
        if (numerosEnArchivo.has(numero_caso)) {
            errores.push({ fila, error: `numero_caso ${numero_caso} duplicado en el archivo` });
            continue;
        }

        numerosEnArchivo.add(numero_caso);
        filasValidas.push({
            numero_caso,
            tipo_caso,
            descuento_puntos: DESCUENTO_EXCEL[tipo_caso],
            descripcion,
            video_url: url_video
        });
    }

    if (ciclo.max_casos && ((totalActual || 0) + filasValidas.length) > ciclo.max_casos) {
        return res.status(409).json({
            error: `Se superaría el máximo de ${ciclo.max_casos} casos (actuales: ${totalActual || 0}, a importar: ${filasValidas.length})`,
            errores
        });
    }

    if (preview) {
        return res.json({ filas_validas: filasValidas, errores, total: filas.length });
    }

    if (filasValidas.length === 0) {
        return res.status(400).json({ error: 'No hay filas válidas para importar', errores });
    }

    const ahora   = new Date().toISOString();
    const inserts = filasValidas.map(v => ({
        ciclo_id:         req.params.id,
        evaluacion_id:    ciclo.evaluacion_id,
        numero_caso:      v.numero_caso,
        tipo_caso:        v.tipo_caso,
        descuento_puntos: v.descuento_puntos,
        descripcion:      v.descripcion,
        video_url:        v.video_url,
        cargado_por:      req.usuario.id,
        estado:           ciclo.estado === 'abierto' ? 'visible_jurado' : 'cargado'
    }));

    const { data: insertados, error: insErr } = await supabase
        .from('evaluacion_casos')
        .insert(inserts)
        .select();

    if (insErr) return res.status(500).json({ error: insErr.message });

    if (['pendiente_carga', 'sin_casos'].includes(ciclo.estado) && insertados.length > 0) {
        await supabase
            .from('evaluacion_ciclos')
            .update({ estado: 'cargado', updated_at: ahora })
            .eq('id', req.params.id);
    }

    await supabase.from('evaluacion_auditoria').insert({
        evaluacion_id: ciclo.evaluacion_id,
        ciclo_id:      req.params.id,
        accion:        'importar_casos_excel',
        detalle:       { insertados: insertados.length, errores_omitidos: errores.length },
        actor_id:      req.usuario.id,
        actor_tipo:    'administrador',
        actor_nombre:  req.usuario.nombre,
        ip_address:    req.ip
    });

    res.json({
        mensaje:    `${insertados.length} caso(s) importado(s) correctamente`,
        insertados: insertados.length,
        errores
    });
});

// Error handler multer
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Archivo demasiado grande (máximo 5 MB)' });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
});

module.exports = router;
