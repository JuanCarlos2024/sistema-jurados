const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');

// ── Helper de auditoría ───────────────────────────────────────────────────────

async function auditarEval(evaluacion_id, accion, detalle, actor_id, actor_nombre, ip) {
    try {
        await supabase.from('evaluacion_auditoria').insert({
            evaluacion_id,
            accion,
            detalle,
            actor_id,
            actor_tipo:   'administrador',
            actor_nombre,
            ip_address:   ip || null
        });
    } catch (err) {
        console.warn('[EVAL AUDIT]', err.message);
    }
}

// ── Helper: tipos de caso válidos por número de ciclo ─────────────────────────
// Ciclo 1: solo interpretativa o reglamentaria (los casos del jurado ante la jugada)
// Ciclo 2: agrega informativo (casos sin descuento, de carácter orientador)
function tiposValidos(numero_ciclo) {
    if (numero_ciclo === 1) return ['interpretativa', 'reglamentaria'];
    return ['interpretativa', 'reglamentaria', 'informativo'];
}

// ── POST /api/admin/ciclos/:ciclo_id/casos ────────────────────────────────────
// Acceso: cualquier administrador (soloAdmin aplicado por index.js — intencional)
// Nota: ciclo 2 puede recibir casos aunque ciclo 1 siga en curso.
//       El bloqueo de ciclo 1 solo aplica para abrir ciclo 2 al jurado, no para cargar.
router.post('/:ciclo_id/casos', async (req, res) => {
    const { ciclo_id } = req.params;
    const { tipo_caso, descuento_puntos = 0, descripcion, video_url } = req.body;

    // 1. Cargar ciclo con su evaluación
    const { data: ciclo } = await supabase
        .from('evaluacion_ciclos')
        .select('id, numero_ciclo, estado, min_casos, max_casos, evaluacion_id, evaluaciones(id, estado)')
        .eq('id', ciclo_id)
        .single();

    if (!ciclo) return res.status(404).json({ error: 'Ciclo no encontrado' });

    const evalPadre = ciclo.evaluaciones;

    // 2. Estado del ciclo debe permitir carga
    if (!['pendiente_carga', 'cargado'].includes(ciclo.estado)) {
        return res.status(400).json({ error: `No se pueden agregar casos a un ciclo en estado ${ciclo.estado}` });
    }

    // 3. Evaluación no puede estar en estado terminal
    if (['publicado', 'cerrado'].includes(evalPadre.estado)) {
        return res.status(400).json({ error: `No se pueden agregar casos a una evaluación en estado ${evalPadre.estado}` });
    }

    // 4. tipo_caso requerido y válido para este número de ciclo
    if (!tipo_caso) return res.status(400).json({ error: 'tipo_caso requerido' });

    const validos = tiposValidos(ciclo.numero_ciclo);
    if (!validos.includes(tipo_caso)) {
        return res.status(400).json({
            error: ciclo.numero_ciclo === 1
                ? 'En ciclo 1 solo se permiten casos: interpretativa o reglamentaria'
                : 'tipo_caso debe ser: interpretativa, reglamentaria o informativo'
        });
    }

    // 5. descuento_puntos válido
    const descuento = parseInt(descuento_puntos);
    if (![0, 1, 2].includes(descuento)) {
        return res.status(400).json({ error: 'descuento_puntos debe ser 0, 1 o 2' });
    }

    // 6. Casos informativos nunca descuentan puntos
    if (tipo_caso === 'informativo' && descuento !== 0) {
        return res.status(400).json({ error: 'Los casos informativos no pueden tener descuento de puntos' });
    }

    // 7. Verificar límite de casos del ciclo
    const { count } = await supabase
        .from('evaluacion_casos')
        .select('id', { count: 'exact', head: true })
        .eq('ciclo_id', ciclo_id);

    if ((count ?? 0) >= ciclo.max_casos) {
        return res.status(400).json({ error: `El ciclo ya tiene el máximo de casos permitidos (${ciclo.max_casos})` });
    }

    // 8. Número de caso: MAX + 1 dentro del ciclo
    const { data: maxRow } = await supabase
        .from('evaluacion_casos')
        .select('numero_caso')
        .eq('ciclo_id', ciclo_id)
        .order('numero_caso', { ascending: false })
        .limit(1);

    const numero_caso = ((maxRow && maxRow[0]?.numero_caso) || 0) + 1;

    // 9. Insertar caso
    const { data: caso, error: casoErr } = await supabase
        .from('evaluacion_casos')
        .insert({
            ciclo_id,
            evaluacion_id:    ciclo.evaluacion_id,
            numero_caso,
            tipo_caso,
            descuento_puntos: descuento,
            descripcion:      descripcion?.trim() || null,
            video_url:        video_url?.trim()   || null,
            estado:           'cargado',
            cargado_por:      req.usuario.id
        })
        .select('id, ciclo_id, evaluacion_id, numero_caso, tipo_caso, descuento_puntos, descripcion, video_url, estado, created_at')
        .single();

    if (casoErr || !caso) {
        return res.status(500).json({ error: 'Error al crear caso: ' + (casoErr?.message || 'sin datos') });
    }

    // 10. Primer caso del ciclo → actualizar ciclo de 'pendiente_carga' a 'cargado'
    let cicloActualizadoACargado = false;
    if (ciclo.estado === 'pendiente_carga') {
        await supabase
            .from('evaluacion_ciclos')
            .update({ estado: 'cargado', updated_at: new Date().toISOString() })
            .eq('id', ciclo_id);
        cicloActualizadoACargado = true;
    }

    // 11. Auditoría (solo si el INSERT tuvo éxito)
    await auditarEval(
        ciclo.evaluacion_id,
        'cargar_caso',
        {
            ciclo_id,
            caso_id:                      caso.id,
            numero_caso,
            tipo_caso,
            descuento_puntos:             descuento,
            ciclo_actualizado_a_cargado:  cicloActualizadoACargado
        },
        req.usuario.id,
        req.usuario.nombre,
        req.ip
    );

    res.status(201).json({ caso });
});

// ── GET /api/admin/ciclos/:ciclo_id/casos ─────────────────────────────────────
router.get('/:ciclo_id/casos', async (req, res) => {
    const { ciclo_id } = req.params;

    const { data: ciclo } = await supabase
        .from('evaluacion_ciclos')
        .select('id, numero_ciclo, estado, min_casos, max_casos, evaluacion_id')
        .eq('id', ciclo_id)
        .single();

    if (!ciclo) return res.status(404).json({ error: 'Ciclo no encontrado' });

    const { data: casos, error } = await supabase
        .from('evaluacion_casos')
        .select('id, numero_caso, tipo_caso, descuento_puntos, descripcion, video_url, estado, created_at, updated_at')
        .eq('ciclo_id', ciclo_id)
        .order('numero_caso', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    res.json({
        ciclo_id,
        numero_ciclo: ciclo.numero_ciclo,
        estado:       ciclo.estado,
        min_casos:    ciclo.min_casos,
        max_casos:    ciclo.max_casos,
        casos:        casos || []
    });
});

// ── POST /api/admin/ciclos/:ciclo_id/abrir ────────────────────────────────────
// Acceso: cualquier administrador (soloAdmin aplicado por index.js — intencional)
router.post('/:ciclo_id/abrir', async (req, res) => {
    const { ciclo_id } = req.params;

    const { data: ciclo } = await supabase
        .from('evaluacion_ciclos')
        .select('id, numero_ciclo, estado, min_casos, max_casos, evaluacion_id, evaluaciones(id, estado)')
        .eq('id', ciclo_id)
        .single();

    if (!ciclo) return res.status(404).json({ error: 'Ciclo no encontrado' });

    const evalPadre = ciclo.evaluaciones;

    // Estado del ciclo debe ser pendiente_carga o cargado
    if (!['pendiente_carga', 'cargado'].includes(ciclo.estado)) {
        return res.status(400).json({ error: `No se puede abrir un ciclo en estado ${ciclo.estado}` });
    }

    // Evaluación no puede estar en estados donde la apertura ya no tiene sentido
    const estadosNoPermitidos = ['pendiente_aprobacion', 'aprobado', 'publicado', 'cerrado'];
    if (estadosNoPermitidos.includes(evalPadre.estado)) {
        return res.status(400).json({ error: `No se puede abrir un ciclo en una evaluación con estado ${evalPadre.estado}` });
    }

    // Contar casos actuales
    const { count: totalCasos } = await supabase
        .from('evaluacion_casos')
        .select('id', { count: 'exact', head: true })
        .eq('ciclo_id', ciclo_id);

    // Verificar mínimo de casos requeridos
    if ((totalCasos ?? 0) < ciclo.min_casos) {
        return res.status(400).json({
            error: `El ciclo requiere al menos ${ciclo.min_casos} casos para abrirse (tiene ${totalCasos ?? 0})`
        });
    }

    // Ciclo 2: debe esperarse a que ciclo 1 esté cerrado antes de abrirlo al jurado.
    // Los casos de ciclo 2 pueden cargarse mientras ciclo 1 sigue en curso (sin restricción).
    // Este bloqueo aplica exclusivamente a la apertura, no a la carga de casos.
    if (ciclo.numero_ciclo === 2) {
        const { data: ciclo1 } = await supabase
            .from('evaluacion_ciclos')
            .select('id, estado')
            .eq('evaluacion_id', ciclo.evaluacion_id)
            .eq('numero_ciclo', 1)
            .single();

        if (!ciclo1 || ciclo1.estado !== 'cerrado') {
            return res.status(400).json({ error: 'El ciclo 1 debe estar cerrado antes de abrir el ciclo 2' });
        }
    }

    const ahora = new Date().toISOString();

    // Actualizar ciclo
    const { data: cicloActualizado, error: updateErr } = await supabase
        .from('evaluacion_ciclos')
        .update({
            estado:         'abierto',
            fecha_apertura: ahora,
            abierto_por:    req.usuario.id,
            updated_at:     ahora
        })
        .eq('id', ciclo_id)
        .select('id, numero_ciclo, estado, fecha_apertura, min_casos, max_casos')
        .single();

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // Transición de casos 'cargado' → 'visible_jurado' al abrir el ciclo.
    // Incluye casos informativos — también son visibles al jurado aunque no requieran respuesta.
    await supabase
        .from('evaluacion_casos')
        .update({ estado: 'visible_jurado', updated_at: ahora })
        .eq('ciclo_id', ciclo_id)
        .eq('estado', 'cargado');

    // Si la evaluación está en 'borrador' → pasar a 'en_proceso'
    if (evalPadre.estado === 'borrador') {
        await supabase
            .from('evaluaciones')
            .update({ estado: 'en_proceso', updated_at: ahora })
            .eq('id', ciclo.evaluacion_id);
    }

    // Auditoría
    await auditarEval(
        ciclo.evaluacion_id,
        'abrir_ciclo',
        {
            ciclo_id,
            numero_ciclo:               ciclo.numero_ciclo,
            total_casos:                totalCasos ?? 0,
            evaluacion_estado_anterior: evalPadre.estado
        },
        req.usuario.id,
        req.usuario.nombre,
        req.ip
    );

    res.json({ mensaje: `Ciclo ${ciclo.numero_ciclo} abierto`, ciclo: cicloActualizado });
});

// ── POST /api/admin/ciclos/:ciclo_id/cerrar ───────────────────────────────────
// En este paso el cierre es solo administrativo/manual.
// No valida respuestas de jurados porque esa parte aún no está implementada (Paso 5).
// Acceso: cualquier administrador (soloAdmin aplicado por index.js — intencional)
router.post('/:ciclo_id/cerrar', async (req, res) => {
    const { ciclo_id } = req.params;
    const { motivo_cierre } = req.body;

    if (!motivo_cierre?.trim()) {
        return res.status(400).json({ error: 'motivo_cierre requerido para cerrar el ciclo' });
    }

    const { data: ciclo } = await supabase
        .from('evaluacion_ciclos')
        .select('id, numero_ciclo, estado, evaluacion_id, evaluaciones(id, estado)')
        .eq('id', ciclo_id)
        .single();

    if (!ciclo) return res.status(404).json({ error: 'Ciclo no encontrado' });

    if (!['abierto', 'en_revision'].includes(ciclo.estado)) {
        return res.status(400).json({
            error: `Solo se puede cerrar un ciclo en estado abierto o en_revision (actual: ${ciclo.estado})`
        });
    }

    const ahora = new Date().toISOString();

    const { data: cicloActualizado, error: updateErr } = await supabase
        .from('evaluacion_ciclos')
        .update({
            estado:        'cerrado',
            fecha_cierre:  ahora,
            cerrado_por:   req.usuario.id,
            motivo_cierre: motivo_cierre.trim(),
            updated_at:    ahora
        })
        .eq('id', ciclo_id)
        .select('id, numero_ciclo, estado, fecha_cierre, motivo_cierre')
        .single();

    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // Auditoría
    await auditarEval(
        ciclo.evaluacion_id,
        'cerrar_ciclo_manual',
        {
            ciclo_id,
            numero_ciclo:   ciclo.numero_ciclo,
            motivo_cierre:  motivo_cierre.trim(),
            estado_anterior: ciclo.estado
        },
        req.usuario.id,
        req.usuario.nombre,
        req.ip
    );

    res.json({ mensaje: `Ciclo ${ciclo.numero_ciclo} cerrado`, ciclo: cicloActualizado });
});

module.exports = router;
