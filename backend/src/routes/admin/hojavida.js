const express   = require('express');
const router    = express.Router();
const supabase  = require('../../config/supabase');
const auditoria = require('../../services/auditoria');

// ─── GET /api/admin/hojavida/:id ────────────────────────────────────────────
router.get('/:id', async (req, res) => {
    const uid = req.params.id;

    // 1. Perfil
    const { data: perfil, error: errPerfil } = await supabase
        .from('usuarios_pagados')
        .select('id, codigo_interno, nombre_completo, rut, tipo_persona, categoria, email, telefono, ciudad, asociacion, activo, estado_usuario, suspension_desde, suspension_hasta, suspension_motivo, created_at')
        .eq('id', uid)
        .single();

    if (errPerfil || !perfil) return res.status(404).json({ error: 'Usuario no encontrado' });

    // 2. Asignaciones — sin inline join a notas_rodeo para evitar fallo por cache de schema
    const { data: asigs, error: errAsigs } = await supabase
        .from('asignaciones')
        .select(`
            id, estado, estado_designacion, categoria_aplicada,
            valor_diario_aplicado, duracion_dias_aplicada, pago_base_calculado,
            comentario_admin,
            rodeos(id, club, asociacion, fecha, tipo_rodeo_nombre, duracion_dias)
        `)
        .eq('usuario_pagado_id', uid)
        .order('created_at', { ascending: false });

    if (errAsigs) {
        console.error('[hojavida] error asignaciones:', errAsigs.message);
        return res.status(500).json({ error: 'Error al obtener historial: ' + errAsigs.message });
    }

    const todasAsigs = asigs || [];

    // 3. Notas — query separada para no romper la carga si la tabla es nueva o el cache no refrescó
    let notasMap = {};
    if (todasAsigs.length > 0) {
        const ids = todasAsigs.map(a => a.id);
        const { data: notas } = await supabase
            .from('notas_rodeo')
            .select('asignacion_id, nota, comentario, evaluado_en, updated_by')
            .in('asignacion_id', ids);
        (notas || []).forEach(n => { notasMap[n.asignacion_id] = n; });
    }

    // Merge notas en historial
    const historial = todasAsigs
        .filter(a => a.estado === 'activo')
        .map(a => ({ ...a, notas_rodeo: notasMap[a.id] || null }));

    // 4. Ficha interna
    const { data: ficha } = await supabase
        .from('fichas_internas')
        .select('*')
        .eq('usuario_pagado_id', uid)
        .single();

    // ── Indicadores ──────────────────────────────────────────────────────────
    const noEjecutadas = historial.filter(a => a.estado_designacion !== 'rechazado');
    const conNota      = noEjecutadas.filter(a => a.notas_rodeo?.nota != null);
    const notas        = conNota.map(a => parseFloat(a.notas_rodeo.nota));

    const promedioNota  = notas.length ? Math.round((notas.reduce((s, n) => s + n, 0) / notas.length) * 100) / 100 : null;
    const mejorNota     = notas.length ? Math.max(...notas) : null;
    const peorNota      = notas.length ? Math.min(...notas) : null;

    // Última nota = la del rodeo más reciente con nota registrada
    const ultimaNota = conNota
        .filter(a => a.rodeos?.fecha)
        .sort((a, b) => b.rodeos.fecha.localeCompare(a.rodeos.fecha))[0]?.notas_rodeo?.nota ?? null;

    const fechas = noEjecutadas
        .map(a => a.rodeos?.fecha)
        .filter(Boolean)
        .sort();

    const totalPagos = noEjecutadas.reduce((s, a) => s + (a.pago_base_calculado || 0), 0);

    const indicadores = {
        total_rodeos:      noEjecutadas.length,
        con_nota:          conNota.length,
        promedio_nota:     promedioNota,
        ultima_nota:       ultimaNota !== null ? parseFloat(ultimaNota) : null,
        mejor_nota:        mejorNota,
        peor_nota:         peorNota,
        ultima_asistencia: fechas.length ? fechas[fechas.length - 1] : null,
        total_pagos:       totalPagos
    };

    // ── Evolución de notas (orden cronológico) ────────────────────────────────
    const evolucion_notas = conNota
        .filter(a => a.rodeos?.fecha)
        .map(a => ({
            fecha: a.rodeos.fecha,
            club:  a.rodeos.club || '—',
            nota:  parseFloat(a.notas_rodeo.nota)
        }))
        .sort((a, b) => a.fecha.localeCompare(b.fecha));

    // ── Frecuencia mensual ────────────────────────────────────────────────────
    const frecMap = {};
    noEjecutadas.forEach(a => {
        const f = a.rodeos?.fecha;
        if (!f) return;
        const mes = f.slice(0, 7);
        frecMap[mes] = (frecMap[mes] || 0) + 1;
    });
    const frecuencia_propia = Object.entries(frecMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([mes, cantidad]) => ({ mes, cantidad }));

    // ── Distribución / frecuencia comparada ──────────────────────────────────
    // Cuántos rodeos ha hecho este jurado vs pares de su categoría y en general
    let pares_categoria    = [];
    let comparacion_frecuencia = null;
    try {
        const { data: todosDelTipo } = await supabase
            .from('usuarios_pagados')
            .select('id, nombre_completo, categoria')
            .eq('tipo_persona', perfil.tipo_persona)
            .eq('activo', true);

        if (todosDelTipo && todosDelTipo.length > 0) {
            const todosIds = todosDelTipo.map(u => u.id);

            const { data: asigsTodos } = await supabase
                .from('asignaciones')
                .select('usuario_pagado_id, estado_designacion')
                .eq('estado', 'activo')
                .in('usuario_pagado_id', todosIds);

            const countPorUsuario = {};
            todosIds.forEach(id => { countPorUsuario[id] = 0; });
            (asigsTodos || []).forEach(a => {
                if (a.estado_designacion !== 'rechazado') countPorUsuario[a.usuario_pagado_id]++;
            });

            const todosConCount = todosDelTipo.map(u => ({
                id:           u.id,
                nombre:       u.nombre_completo,
                categoria:    u.categoria,
                total_rodeos: countPorUsuario[u.id] || 0,
                es_actual:    u.id === uid
            }));

            // Promedio general (mismo tipo, todas las categorías)
            const promGeneral = Math.round(
                (todosConCount.reduce((s, u) => s + u.total_rodeos, 0) / todosConCount.length) * 10
            ) / 10;

            // Categoría específica
            const deLaCategoria = perfil.categoria
                ? todosConCount.filter(u => u.categoria === perfil.categoria)
                : todosConCount;

            const promCat = deLaCategoria.length
                ? Math.round((deLaCategoria.reduce((s, u) => s + u.total_rodeos, 0) / deLaCategoria.length) * 10) / 10
                : null;

            // Ranking 1 = más rodeos en la categoría
            const ordenados = [...deLaCategoria].sort((a, b) => b.total_rodeos - a.total_rodeos);
            const posicion   = ordenados.findIndex(u => u.es_actual) + 1;

            pares_categoria = ordenados;   // ya ordenado desc

            const propioRodeos = noEjecutadas.length;
            comparacion_frecuencia = {
                rodeos_propios:           propioRodeos,
                promedio_categoria:       promCat,
                promedio_general:         promGeneral,
                total_usuarios_categoria: deLaCategoria.length,
                total_usuarios_general:   todosConCount.length,
                diferencia_vs_categoria:  promCat !== null ? Math.round((propioRodeos - promCat) * 10) / 10 : null,
                diferencia_vs_general:    Math.round((propioRodeos - promGeneral) * 10) / 10,
                ranking_categoria:        posicion > 0 ? posicion : null
            };
        }
    } catch (e) {
        console.error('[hojavida] error frecuencia_comparada:', e.message);
    }

    // ── Comparación vs pares (notas) ─────────────────────────────────────────
    let comparacion = null;
    try {
        // a) IDs de usuarios del mismo tipo (excluyendo al actual)
        const { data: paresUsuarios } = await supabase
            .from('usuarios_pagados')
            .select('id')
            .eq('tipo_persona', perfil.tipo_persona)
            .neq('id', uid);

        const pareIds = (paresUsuarios || []).map(u => u.id);

        if (pareIds.length > 0) {
            // b) Asignaciones activas y no rechazadas de esos pares
            const { data: asigsPares } = await supabase
                .from('asignaciones')
                .select('id, usuario_pagado_id, estado_designacion')
                .eq('estado', 'activo')
                .in('usuario_pagado_id', pareIds);

            const asigsParesFiltradas = (asigsPares || []).filter(a => a.estado_designacion !== 'rechazado');
            const asigIdsPares = asigsParesFiltradas.map(a => a.id);
            // Mapa asignacion_id → usuario_pagado_id para agrupar
            const asigUserMap = {};
            asigsParesFiltradas.forEach(a => { asigUserMap[a.id] = a.usuario_pagado_id; });

            // c) Notas de esas asignaciones
            let notasPares = [];
            if (asigIdsPares.length > 0) {
                const { data: nps } = await supabase
                    .from('notas_rodeo')
                    .select('asignacion_id, nota')
                    .in('asignacion_id', asigIdsPares);
                notasPares = nps || [];
            }

            // Agrupar notas por usuario
            const notasPorUsuario = {};
            notasPares.forEach(n => {
                const userId = asigUserMap[n.asignacion_id];
                if (!userId) return;
                if (!notasPorUsuario[userId]) notasPorUsuario[userId] = [];
                notasPorUsuario[userId].push(parseFloat(n.nota));
            });

            const promediosPares = Object.values(notasPorUsuario)
                .map(ns => ns.reduce((s, n) => s + n, 0) / ns.length);

            const promGeneral = promediosPares.length
                ? Math.round((promediosPares.reduce((s, p) => s + p, 0) / promediosPares.length) * 100) / 100
                : null;

            const pctRank = promediosPares.length && promedioNota !== null
                ? Math.round((promediosPares.filter(p => p <= promedioNota).length / promediosPares.length) * 100)
                : null;

            // Promedio general (todas las categorías, mismo tipo)
            comparacion = {
                promedio_general_tipo: promGeneral,
                total_pares:           pareIds.length,
                pares_con_nota:        promediosPares.length,
                percentil:             pctRank
            };
        }
    } catch (e) {
        console.error('[hojavida] error comparacion:', e.message);
    }

    const { data: historial_cambios } = await supabase
        .from('usuario_historial_cambios')
        .select('id, tipo_cambio, valor_anterior, valor_nuevo, cambiado_por, cambiado_por_nombre, cambiado_en, observacion, fecha_desde, fecha_hasta')
        .eq('usuario_pagado_id', uid)
        .order('cambiado_en', { ascending: false });

    const hadm = (historial_cambios || []).map(c => ({
        id:                 c.id,
        fecha:              c.cambiado_en,
        tipo_cambio:        c.tipo_cambio,
        valor_anterior:     c.valor_anterior,
        valor_nuevo:        c.valor_nuevo,
        observacion:        c.observacion,
        fecha_desde:        c.fecha_desde,
        fecha_hasta:        c.fecha_hasta,
        cambiado_por:       c.cambiado_por,
        cambiado_por_nombre: c.cambiado_por_nombre
    }));

    res.json({
        perfil,
        historial,
        historial_cambios:        historial_cambios || [],
        historial_administrativo: hadm,
        ficha:               ficha || null,
        indicadores,
        evolucion_notas,
        frecuencia_propia,
        comparacion,
        pares_categoria,
        comparacion_frecuencia
    });
});

// ─── PATCH /api/admin/hojavida/:id/ficha ────────────────────────────────────
router.patch('/:id/ficha', async (req, res) => {
    const uid = req.params.id;

    const camposPermitidos = [
        'caracter', 'liderazgo', 'habilidades_blandas', 'puntualidad',
        'responsabilidad_admin', 'trabajo_equipo', 'comunicacion', 'manejo_presion',
        'disponibilidad_viajes', 'disponibilidad_reemplazos',
        'zona_preferente', 'restricciones_geograficas',
        'observaciones_tecnicas', 'observaciones_conductuales',
        'recomendacion', 'comentarios_admin'
    ];

    const payload = {
        usuario_pagado_id: uid,
        updated_at: new Date().toISOString(),
        updated_by: req.usuario.id
    };
    camposPermitidos.forEach(c => { if (req.body[c] !== undefined) payload[c] = req.body[c]; });

    const camposEval = ['caracter','liderazgo','habilidades_blandas','puntualidad',
        'responsabilidad_admin','trabajo_equipo','comunicacion','manejo_presion','recomendacion'];
    if (camposEval.some(c => payload[c] != null && payload[c] !== '')) {
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

// ─── POST /api/admin/hojavida/nota/:asignacion_id ────────────────────────────
router.post('/nota/:asignacion_id', async (req, res) => {
    const asig_id = req.params.asignacion_id;
    const { nota, comentario } = req.body;

    if (nota === undefined || nota === null || nota === '') {
        return res.status(400).json({ error: 'nota requerida' });
    }
    const n = parseFloat(nota);
    if (isNaN(n) || n < 1.0 || n > 7.0) {
        return res.status(400).json({ error: 'La nota debe estar entre 1.0 y 7.0' });
    }

    const { data: asig } = await supabase
        .from('asignaciones')
        .select('id, usuario_pagado_id')
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
        descripcion: `Nota ${existing ? 'actualizada' : 'registrada'}: ${n} para asignación ${asig_id}`,
        ip_address: req.ip
    });

    res.json({ mensaje: 'Nota guardada', nota: result.data });
});

module.exports = router;
