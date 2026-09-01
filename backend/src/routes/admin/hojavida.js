const express   = require('express');
const router    = express.Router();
const supabase  = require('../../config/supabase');
const auditoria = require('../../services/auditoria');
const { exportarHistorialHojaVida } = require('../../services/exportacion');

const PAGINA_HV = 900; // paginación defensiva para no depender del tope implícito de Supabase/PostgREST

// Cantidad de "situaciones" = casos reales (evaluacion_casos) de la evaluación técnica
// de cada rodeo — no depende de si el jurado respondió ni del estado de la evaluación.
// Mismo criterio ya usado en reporte-deportivo.js (export-detalle) y en el listado de
// evaluaciones (evaluaciones.js): evaluacion_casos filtrado por anulado=false, agrupado
// por evaluacion_id → rodeo_id. 1 caso = 1 situación (sin pasar por evaluacion_respuestas_jurado,
// que evitaba duplicar por múltiples respuestas pero también causaba falsos "0").
// Devuelve { porRodeo: {rodeo_id: cantidad}, porTipoPorRodeo: {rodeo_id: {tipo_caso: cantidad}} }.
// El resumen acumulado (total y por tipo) se arma en el handler sumando sobre las
// filas de `historial` realmente mostradas, para que coincida matemáticamente con
// la columna "Situaciones" visible aunque exista más de una asignación al mismo rodeo.
async function calcularSituacionesPorRodeo(rodeoIds) {
    const resultado = { porRodeo: {}, porTipoPorRodeo: {} };
    if (!rodeoIds.length) return resultado;

    const { data: evals } = await supabase
        .from('evaluaciones')
        .select('id, rodeo_id')
        .in('rodeo_id', rodeoIds);
    if (!evals || evals.length === 0) return resultado;

    const evalToRodeo = {};
    evals.forEach(e => { evalToRodeo[e.id] = e.rodeo_id; });
    const evaluacionIds = evals.map(e => e.id);

    let casos = [];
    {
        let offset = 0;
        while (true) {
            const { data: pagina, error } = await supabase
                .from('evaluacion_casos')
                .select('evaluacion_id, tipo_caso')
                .in('evaluacion_id', evaluacionIds)
                .eq('anulado', false)
                .range(offset, offset + PAGINA_HV - 1);
            if (error) break;
            const filas = pagina || [];
            casos = casos.concat(filas);
            if (filas.length < PAGINA_HV) break;
            offset += PAGINA_HV;
        }
    }

    for (const c of casos) {
        const rodeoId = evalToRodeo[c.evaluacion_id];
        if (!rodeoId) continue;
        resultado.porRodeo[rodeoId] = (resultado.porRodeo[rodeoId] || 0) + 1;
        if (!resultado.porTipoPorRodeo[rodeoId]) resultado.porTipoPorRodeo[rodeoId] = {};
        resultado.porTipoPorRodeo[rodeoId][c.tipo_caso] = (resultado.porTipoPorRodeo[rodeoId][c.tipo_caso] || 0) + 1;
    }
    return resultado;
}

// Suma el desglose por tipo y el total sobre un conjunto de filas de historial
// (una por asignación), a partir de porTipoPorRodeo — así el total siempre coincide
// con la suma de la columna "Situaciones" realmente mostrada en pantalla/Excel.
function acumularResumenSituaciones(filasHistorial, porTipoPorRodeo, obtenerRodeoId) {
    const porTipo = {};
    let total = 0;
    for (const fila of filasHistorial) {
        const rodeoId = obtenerRodeoId(fila);
        const tipos = porTipoPorRodeo[rodeoId];
        if (!tipos) continue;
        for (const [tipo, cant] of Object.entries(tipos)) {
            porTipo[tipo] = (porTipo[tipo] || 0) + cant;
            total += cant;
        }
    }
    return { porTipo, total };
}

// ─── GET /api/admin/hojavida/:id ────────────────────────────────────────────
router.get('/:id', async (req, res) => {
    const uid = req.params.id;

    // 1. Perfil
    const { data: perfil, error: errPerfil } = await supabase
        .from('usuarios_pagados')
        .select('id, codigo_interno, nombre_completo, rut, tipo_persona, categoria, email, telefono, ciudad, comuna, asociacion, activo, estado_usuario, suspension_desde, suspension_hasta, suspension_motivo, created_at')
        .eq('id', uid)
        .single();

    if (errPerfil || !perfil) return res.status(404).json({ error: 'Usuario no encontrado' });

    // 2. Asignaciones — sin inline join a notas_rodeo para evitar fallo por cache de schema.
    // Paginada con .range() para no depender del tope implícito de filas de Supabase/PostgREST.
    let todasAsigs = [];
    {
        let offset = 0;
        while (true) {
            const { data: pagina, error: errAsigs } = await supabase
                .from('asignaciones')
                .select(`
                    id, estado, estado_designacion, categoria_aplicada,
                    valor_diario_aplicado, duracion_dias_aplicada, pago_base_calculado,
                    comentario_admin,
                    rodeos(id, club, asociacion, fecha, tipo_rodeo_nombre, duracion_dias)
                `)
                .eq('usuario_pagado_id', uid)
                .order('created_at', { ascending: false })
                .range(offset, offset + PAGINA_HV - 1);

            if (errAsigs) {
                console.error('[hojavida] error asignaciones:', errAsigs.message);
                return res.status(500).json({ error: 'Error al obtener historial: ' + errAsigs.message });
            }
            const filas = pagina || [];
            todasAsigs = todasAsigs.concat(filas);
            if (filas.length < PAGINA_HV) break;
            offset += PAGINA_HV;
        }
    }

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

    // 3.5 Evaluaciones — link por rodeo_id para botón "Ver evaluación" en hoja de vida
    let evalMap = {};
    if (todasAsigs.length > 0) {
        const rodeoIds = [...new Set(todasAsigs.map(a => a.rodeos?.id).filter(Boolean))];
        if (rodeoIds.length > 0) {
            const { data: evals } = await supabase
                .from('evaluaciones')
                .select('id, rodeo_id, estado')
                .in('rodeo_id', rodeoIds)
                .eq('anulada', false);
            (evals || []).forEach(e => { evalMap[e.rodeo_id] = e; });
        }
    }

    // 3.6 Cantidad de situaciones: casos reales (evaluacion_casos) de la evaluación
    // técnica de cada rodeo del historial de este jurado.
    let situaciones = { porRodeo: {}, porTipoPorRodeo: {} };
    if (todasAsigs.length > 0) {
        const rodeoIds = [...new Set(todasAsigs.map(a => a.rodeos?.id).filter(Boolean))];
        situaciones = await calcularSituacionesPorRodeo(rodeoIds);
    }

    // Merge notas, evaluaciones y situaciones en historial
    const historial = todasAsigs
        .filter(a => a.estado === 'activo')
        .map(a => ({
            ...a,
            notas_rodeo: notasMap[a.id] || null,
            eval_id:     evalMap[a.rodeos?.id]?.id     || null,
            eval_estado: evalMap[a.rodeos?.id]?.estado || null,
            situaciones: situaciones.porRodeo[a.rodeos?.id] || 0,
            situaciones_por_tipo: situaciones.porTipoPorRodeo[a.rodeos?.id] || {}
        }));

    // Resumen acumulado de situaciones por tipo, sobre las mismas filas del historial
    // (para que "Total" coincida exactamente con la suma de la columna visible).
    const resumen_situaciones = acumularResumenSituaciones(
        historial, situaciones.porTipoPorRodeo, a => a.rodeos?.id
    );

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
        comparacion_frecuencia,
        resumen_situaciones
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

// ─── GET /api/admin/hojavida/:id/exportar ───────────────────────────────────
// Exporta a Excel el historial COMPLETO de rodeos del jurado (independiente de
// lo que esté visible en pantalla). Handler autocontenido: re-consulta los
// mismos datos que GET /:id para no modificar ese endpoint ya en uso.
router.get('/:id/exportar', async (req, res) => {
    const uid = req.params.id;

    const { data: perfil, error: errPerfil } = await supabase
        .from('usuarios_pagados')
        .select('id, nombre_completo, categoria, asociacion, comuna')
        .eq('id', uid)
        .single();

    if (errPerfil || !perfil) return res.status(404).json({ error: 'Usuario no encontrado' });

    let todasAsigs = [];
    {
        let offset = 0;
        while (true) {
            const { data: pagina, error: errAsigs } = await supabase
                .from('asignaciones')
                .select(`
                    id, estado, estado_designacion, rodeo_id,
                    rodeos(club, asociacion, fecha, tipo_rodeo_nombre)
                `)
                .eq('usuario_pagado_id', uid)
                .order('created_at', { ascending: false })
                .range(offset, offset + PAGINA_HV - 1);

            if (errAsigs) return res.status(500).json({ error: 'Error al obtener historial: ' + errAsigs.message });
            const filas = pagina || [];
            todasAsigs = todasAsigs.concat(filas);
            if (filas.length < PAGINA_HV) break;
            offset += PAGINA_HV;
        }
    }

    const historial = todasAsigs.filter(a => a.estado === 'activo');

    let notasMap = {};
    if (historial.length > 0) {
        const ids = historial.map(a => a.id);
        const { data: notas } = await supabase
            .from('notas_rodeo')
            .select('asignacion_id, nota')
            .in('asignacion_id', ids);
        (notas || []).forEach(n => { notasMap[n.asignacion_id] = n.nota; });
    }

    const rodeoIds = [...new Set(historial.map(a => a.rodeo_id).filter(Boolean))];
    const situaciones = await calcularSituacionesPorRodeo(rodeoIds);
    const resumen_situaciones = acumularResumenSituaciones(
        historial, situaciones.porTipoPorRodeo, a => a.rodeo_id
    );

    // Promedio de nota: MISMA definición que el indicador "Promedio" de Hoja de Vida
    // (GET /:id) — excluye asignaciones rechazadas, promedia solo las que tienen nota.
    const noEjecutadas = historial.filter(a => a.estado_designacion !== 'rechazado');
    const notasValidas = noEjecutadas
        .map(a => notasMap[a.id])
        .filter(n => n != null)
        .map(n => parseFloat(n));
    const promedioNota = notasValidas.length
        ? Math.round((notasValidas.reduce((s, n) => s + n, 0) / notasValidas.length) * 100) / 100
        : null;

    const filas = historial
        .map(a => ({
            fecha:       a.rodeos?.fecha || null,
            asociacion:  a.rodeos?.asociacion || null,
            club:        a.rodeos?.club || null,
            tipo_rodeo:  a.rodeos?.tipo_rodeo_nombre || null,
            situaciones: situaciones.porRodeo[a.rodeo_id] || 0,
            nota:        notasMap[a.id] ?? null
        }))
        .sort((x, y) => (y.fecha || '').localeCompare(x.fecha || ''));

    const resumen = {
        totalSituaciones: resumen_situaciones.total,
        porTipo:          resumen_situaciones.porTipo,
        promedioNota
    };

    await exportarHistorialHojaVida(perfil, filas, resumen, res);
});

module.exports = router;
