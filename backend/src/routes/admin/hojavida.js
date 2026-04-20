const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');

// ─── GET /api/admin/hojavida/:id ────────────────────────────
// Devuelve: perfil, historial, ficha, indicadores, comparacion, frecuencia
router.get('/:id', async (req, res) => {
    const uid = req.params.id;

    // 1. Perfil del usuario
    const { data: perfil, error: errPerfil } = await supabase
        .from('usuarios_pagados')
        .select('id, codigo_interno, nombre_completo, rut, tipo_persona, categoria, email, telefono, ciudad, asociacion, activo, created_at')
        .eq('id', uid)
        .single();

    if (errPerfil || !perfil) return res.status(404).json({ error: 'Usuario no encontrado' });

    // 2. Historial de asignaciones + notas
    const { data: asigs } = await supabase
        .from('asignaciones')
        .select(`
            id, estado, estado_designacion, categoria_aplicada,
            pago_base_calculado, valor_diario_aplicado, dias,
            rodeos(id, club, fecha, comuna, region),
            notas_rodeo(nota, comentario, evaluado_en, updated_by)
        `)
        .eq('usuario_pagado_id', uid)
        .order('created_at', { ascending: false });

    // 3. Ficha interna
    const { data: ficha } = await supabase
        .from('fichas_internas')
        .select('*')
        .eq('usuario_pagado_id', uid)
        .single();

    // ── Indicadores ──────────────────────────────────────────
    const historial = (asigs || []).filter(a => a.estado === 'activo');
    const noEjecutadas = historial.filter(a => a.estado_designacion !== 'rechazado');
    const conNota = noEjecutadas.filter(a => a.notas_rodeo?.nota != null);

    const notas = conNota.map(a => parseFloat(a.notas_rodeo.nota));
    const promedioNota  = notas.length ? (notas.reduce((s, n) => s + n, 0) / notas.length) : null;
    const mejorNota     = notas.length ? Math.max(...notas) : null;
    const peorNota      = notas.length ? Math.min(...notas) : null;
    const ultimaNota    = conNota.length
        ? parseFloat(conNota[0].notas_rodeo.nota)   // ya ordenado desc por created_at
        : null;

    const fechas = noEjecutadas
        .map(a => a.rodeos?.fecha)
        .filter(Boolean)
        .sort();

    const ultimaAsistencia = fechas.length ? fechas[fechas.length - 1] : null;

    const totalPagos = noEjecutadas.reduce((s, a) => s + (a.pago_base_calculado || 0), 0);

    const indicadores = {
        total_rodeos:      noEjecutadas.length,
        con_nota:          conNota.length,
        promedio_nota:     promedioNota !== null ? Math.round(promedioNota * 100) / 100 : null,
        ultima_nota:       ultimaNota,
        mejor_nota:        mejorNota,
        peor_nota:         peorNota,
        ultima_asistencia: ultimaAsistencia,
        total_pagos:       totalPagos
    };

    // ── Frecuencia mensual propia ────────────────────────────
    const frecuencia = {};
    noEjecutadas.forEach(a => {
        const f = a.rodeos?.fecha;
        if (!f) return;
        const mes = f.slice(0, 7); // YYYY-MM
        frecuencia[mes] = (frecuencia[mes] || 0) + 1;
    });
    const frecuencia_propia = Object.entries(frecuencia)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([mes, cantidad]) => ({ mes, cantidad }));

    // ── Evolución de notas ───────────────────────────────────
    const evolucion_notas = conNota
        .filter(a => a.rodeos?.fecha)
        .map(a => ({
            fecha: a.rodeos.fecha,
            club:  a.rodeos.club || '—',
            nota:  parseFloat(a.notas_rodeo.nota)
        }))
        .sort((a, b) => a.fecha.localeCompare(b.fecha));

    // ── Comparación vs pares (misma categoría/tipo) ──────────
    let comparacion = null;
    try {
        const { data: pares } = await supabase
            .from('asignaciones')
            .select(`
                usuario_pagado_id,
                estado_designacion,
                notas_rodeo(nota),
                usuarios_pagados!inner(tipo_persona, categoria)
            `)
            .eq('estado', 'activo')
            .eq('usuarios_pagados.tipo_persona', perfil.tipo_persona)
            .neq('usuario_pagado_id', uid);

        const groupNotas = {};
        (pares || []).forEach(a => {
            if (a.estado_designacion === 'rechazado') return;
            if (!a.notas_rodeo?.nota) return;
            const pid = a.usuario_pagado_id;
            if (!groupNotas[pid]) groupNotas[pid] = [];
            groupNotas[pid].push(parseFloat(a.notas_rodeo.nota));
        });

        const promediosPares = Object.values(groupNotas)
            .map(ns => ns.reduce((s, n) => s + n, 0) / ns.length);

        const promGeneral = promediosPares.length
            ? promediosPares.reduce((s, p) => s + p, 0) / promediosPares.length
            : null;

        // Percentil: cuántos tienen promedio <= que el propio
        const pctRank = promediosPares.length && promedioNota !== null
            ? Math.round((promediosPares.filter(p => p <= promedioNota).length / promediosPares.length) * 100)
            : null;

        comparacion = {
            promedio_general_tipo: promGeneral !== null ? Math.round(promGeneral * 100) / 100 : null,
            total_pares:           promediosPares.length,
            percentil:             pctRank
        };
    } catch (_) { /* comparacion queda null */ }

    res.json({
        perfil,
        historial: asigs || [],
        ficha:     ficha || null,
        indicadores,
        evolucion_notas,
        frecuencia_propia,
        comparacion
    });
});

// ─── PATCH /api/admin/hojavida/:id/ficha ────────────────────
router.patch('/:id/ficha', async (req, res) => {
    const uid = req.params.id;

    const campos = [
        'caracter', 'liderazgo', 'habilidades_blandas', 'puntualidad',
        'responsabilidad_admin', 'trabajo_equipo', 'comunicacion', 'manejo_presion',
        'disponibilidad_viajes', 'disponibilidad_reemplazos',
        'zona_preferente', 'restricciones_geograficas',
        'observaciones_tecnicas', 'observaciones_conductuales',
        'recomendacion', 'comentarios_admin'
    ];

    const payload = { usuario_pagado_id: uid, updated_at: new Date().toISOString(), updated_by: req.usuario.id };
    campos.forEach(c => { if (req.body[c] !== undefined) payload[c] = req.body[c]; });

    // Si hay al menos un campo de evaluación real, marcar evaluado_en
    const camposEval = ['caracter','liderazgo','habilidades_blandas','puntualidad',
        'responsabilidad_admin','trabajo_equipo','comunicacion','manejo_presion','recomendacion'];
    if (camposEval.some(c => payload[c] !== undefined)) {
        payload.evaluado_en = new Date().toISOString();
    }

    const { data: existing } = await supabase
        .from('fichas_internas')
        .select('id')
        .eq('usuario_pagado_id', uid)
        .single();

    let result;
    if (existing) {
        result = await supabase
            .from('fichas_internas')
            .update(payload)
            .eq('usuario_pagado_id', uid)
            .select().single();
    } else {
        result = await supabase
            .from('fichas_internas')
            .insert(payload)
            .select().single();
    }

    if (result.error) return res.status(500).json({ error: result.error.message });

    await auditoria.registrar({
        tabla: 'fichas_internas',
        registro_id: result.data.id,
        accion: existing ? 'actualizar' : 'crear',
        datos_nuevos: payload,
        actor_id: req.usuario.id,
        actor_tipo: 'admin',
        descripcion: `Ficha interna ${existing ? 'actualizada' : 'creada'} para usuario ${uid}`,
        ip_address: req.ip
    });

    res.json({ mensaje: 'Ficha guardada', ficha: result.data });
});

// ─── POST /api/admin/hojavida/nota/:asignacion_id ────────────
router.post('/nota/:asignacion_id', async (req, res) => {
    const asig_id = req.params.asignacion_id;
    const { nota, comentario } = req.body;

    if (nota === undefined || nota === null) return res.status(400).json({ error: 'nota requerida' });
    const n = parseFloat(nota);
    if (isNaN(n) || n < 1.0 || n > 7.0) return res.status(400).json({ error: 'nota debe estar entre 1.0 y 7.0' });

    // Verificar que la asignación existe
    const { data: asig } = await supabase
        .from('asignaciones')
        .select('id')
        .eq('id', asig_id)
        .single();

    if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });

    const { data: existing } = await supabase
        .from('notas_rodeo')
        .select('id')
        .eq('asignacion_id', asig_id)
        .single();

    const payload = {
        asignacion_id: asig_id,
        nota:          n,
        comentario:    comentario?.trim() || null,
        evaluado_en:   new Date().toISOString(),
        updated_at:    new Date().toISOString(),
        updated_by:    req.usuario.id
    };

    let result;
    if (existing) {
        result = await supabase
            .from('notas_rodeo')
            .update(payload)
            .eq('asignacion_id', asig_id)
            .select().single();
    } else {
        result = await supabase
            .from('notas_rodeo')
            .insert(payload)
            .select().single();
    }

    if (result.error) return res.status(500).json({ error: result.error.message });

    await auditoria.registrar({
        tabla: 'notas_rodeo',
        registro_id: result.data.id,
        accion: existing ? 'actualizar' : 'crear',
        datos_nuevos: payload,
        actor_id: req.usuario.id,
        actor_tipo: 'admin',
        descripcion: `Nota de rodeo ${existing ? 'actualizada' : 'registrada'}: ${n} para asignación ${asig_id}`,
        ip_address: req.ip
    });

    res.json({ mensaje: 'Nota guardada', nota: result.data });
});

module.exports = router;
