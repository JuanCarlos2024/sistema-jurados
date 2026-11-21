// ─────────────────────────────────────────────────────────────────────────
// Revisiones de la Comisión Técnica — fuente ÚNICA de lectura para el
// listado de Análisis de Casos (columna/filtros "Comisión"), el portal de
// Comisión y su detalle "Ver caso". Migración 103.
//
// Dos tipos, en tablas distintas (nunca se duplican entre sí):
//   · Tipo A 'resultado_alterado' → evaluacion_revisiones_comision
//       (una vigente por evaluación; sin efecto en puntos).
//   · Tipo B 'video_derivado'     → evaluacion_casos con
//       decision_analista='derivar_comision' (cada caso es una revisión;
//       pendiente mientras estado='derivado_comision').
// Decisión visible: 'error' / 'acierto'. En el Tipo B se lee desde las
// columnas existentes: rechaza_apelacion = error, aprueba_apelacion = acierto.
// Las RPC de escritura viven en la migración 103; aquí solo se lee.
// ─────────────────────────────────────────────────────────────────────────
const supabase = require('../config/supabase');

const TIPO_A = 'resultado_alterado';
const TIPO_B = 'video_derivado';
const DECISION_B = { rechaza_apelacion: 'error', aprueba_apelacion: 'acierto' };

const TIPO_CASO_LABEL = { interpretativa: 'Apreciación', reglamentaria: 'Reglamentaria', informativo: 'Conceptual' };

// ─── Lectura base ─────────────────────────────────────────────────────────
// Devuelve las revisiones (A y B) como filas homogéneas, opcionalmente
// acotadas a un conjunto de evaluaciones. Excluye revisiones anuladas y
// casos anulados (nunca se cuentan ni se muestran como pendientes).
async function cargarRevisiones({ evaluacionIds = null } = {}) {
    if (Array.isArray(evaluacionIds) && evaluacionIds.length === 0) return [];

    let qa = supabase.from('evaluacion_revisiones_comision')
        .select('id, evaluacion_id, ciclo_id, estado, decision, observacion_comision, resuelto_por, resuelto_en, created_at, comentario_alteracion, analista_id, cierre_excepcional_id, cierre_admin_por, cierre_admin_en, cierre_admin_motivo')
        .neq('estado', 'anulada');
    let qb = supabase.from('evaluacion_casos')
        .select('id, evaluacion_id, ciclo_id, numero_caso, tipo_caso, descuento_puntos, estado, decision_comision, comentario_comision, comision_miembro_id, comision_decidio_en, analista_decidio_en, anulado, decision_admin_excepcional, admin_excepcional_por, admin_excepcional_en, motivo_admin_excepcional, cierre_excepcional_id')
        .eq('decision_analista', 'derivar_comision');
    if (evaluacionIds) { qa = qa.in('evaluacion_id', evaluacionIds); qb = qb.in('evaluacion_id', evaluacionIds); }

    const [{ data: a, error: ea }, { data: b, error: eb }] = await Promise.all([qa, qb]);
    if (ea) throw new Error(ea.message);
    if (eb) throw new Error(eb.message);

    // resuelto_por_tipo distingue SIEMPRE quién cerró la revisión:
    //   'comision'           → decisión ERROR/ACIERTO de la Comisión
    //   'administracion'     → decisión administrativa expresa (cierre excepcional, Tipo B)
    //   'cierre_excepcional' → cerrada por el Administrador sin resolución (Tipo A, sin puntos)
    const filasA = (a || []).map(r => {
        const excepcional = r.estado === 'cierre_excepcional';
        return {
            tipo: TIPO_A, id: r.id, evaluacion_id: r.evaluacion_id, ciclo_id: r.ciclo_id,
            pendiente: r.estado === 'pendiente',
            decision: r.decision || null,
            resuelto_por_tipo: r.estado === 'resuelta' ? 'comision' : (excepcional ? 'cierre_excepcional' : null),
            observacion: excepcional ? (r.cierre_admin_motivo || null) : (r.observacion_comision || null),
            resuelto_por: excepcional ? r.cierre_admin_por : (r.resuelto_por || null),
            resuelto_en: excepcional ? r.cierre_admin_en : (r.resuelto_en || null),
            cierre_excepcional_id: r.cierre_excepcional_id || null,
            derivado_en: r.created_at
        };
    });
    const filasB = (b || []).filter(c => !c.anulado).map(c => {
        const admin = !!c.decision_admin_excepcional;
        return {
            tipo: TIPO_B, id: c.id, evaluacion_id: c.evaluacion_id, ciclo_id: c.ciclo_id,
            pendiente: c.estado === 'derivado_comision',
            decision: DECISION_B[c.decision_comision] || c.decision_admin_excepcional || null,
            resuelto_por_tipo: c.decision_comision ? 'comision' : (admin ? 'administracion' : null),
            observacion: admin ? (c.motivo_admin_excepcional || null) : (c.comentario_comision || null),
            resuelto_por: admin ? c.admin_excepcional_por : (c.comision_miembro_id || null),
            resuelto_en: admin ? c.admin_excepcional_en : (c.comision_decidio_en || null),
            cierre_excepcional_id: c.cierre_excepcional_id || null,
            derivado_en: c.analista_decidio_en || null,
            caso: { numero_caso: c.numero_caso, tipo_caso: c.tipo_caso, descuento_puntos: c.descuento_puntos }
        };
    });
    return [...filasA, ...filasB];
}

// ─── Resumen por evaluación (columna "Comisión") ──────────────────────────
function resumirPorEvaluacion(revisiones) {
    const mapa = {};
    for (const r of revisiones) {
        const s = mapa[r.evaluacion_id] || (mapa[r.evaluacion_id] = { total: 0, resueltas: 0, pendientes: 0, errores: 0, aciertos: 0, tipos: new Set() });
        s.total++;
        s.tipos.add(r.tipo);
        if (r.pendiente) s.pendientes++; else s.resueltas++;
        if (r.decision === 'error') s.errores++;
        if (r.decision === 'acierto') s.aciertos++;
    }
    for (const s of Object.values(mapa)) {
        s.estado = s.pendientes === 0 ? 'resuelto' : (s.resueltas === 0 ? 'pendiente' : 'en_revision');
        s.etiqueta = `${{ resuelto: 'Revisado', pendiente: 'Pendiente', en_revision: 'En revisión' }[s.estado]} ${s.resueltas}/${s.total}`;
        s.tipos = [...s.tipos];
    }
    return mapa;
}

const SIN_DERIVAR = Object.freeze({ total: 0, resueltas: 0, pendientes: 0, errores: 0, aciertos: 0, tipos: [], estado: 'no_derivado', etiqueta: 'No derivado' });

async function resumenComisionPorEvaluacion(evaluacionIds) {
    const mapa = resumirPorEvaluacion(await cargarRevisiones({ evaluacionIds }));
    const salida = {};
    for (const id of evaluacionIds) salida[id] = mapa[id] || SIN_DERIVAR;
    return salida;
}

// Filtros del listado administrativo. Devuelve { incluir: string[]|null,
// excluir: string[]|null } — null = sin restricción por ese lado.
async function filtroEvaluacionesPorComision({ derivado, estado_comision, resolucion } = {}) {
    if (!derivado && !estado_comision && !resolucion) return { incluir: null, excluir: null };
    const mapa = resumirPorEvaluacion(await cargarRevisiones());
    const conRevision = Object.keys(mapa);

    if (derivado === 'no') {
        // "No derivado" es incompatible con exigir estado/resolución de Comisión.
        if (estado_comision || resolucion) return { incluir: [], excluir: null };
        return { incluir: null, excluir: conRevision };
    }
    const incluir = conRevision.filter(id => {
        const s = mapa[id];
        if (estado_comision === 'pendiente' && s.estado !== 'pendiente') return false;
        if (estado_comision === 'en_revision' && s.estado !== 'en_revision') return false;
        if (estado_comision === 'resuelto' && s.estado !== 'resuelto') return false;
        if (resolucion === 'error' && s.errores === 0) return false;
        if (resolucion === 'acierto' && s.aciertos === 0) return false;
        return true;
    });
    return { incluir, excluir: null };
}

// ─── Contexto de rodeos/evaluaciones para mostrar revisiones ──────────────
async function cargarContexto(evaluacionIds) {
    if (evaluacionIds.length === 0) return { evals: {}, rodeos: {}, jurados: {}, analistas: {}, ciclos: {} };
    const { data: evs, error } = await supabase.from('evaluaciones')
        .select('id, rodeo_id, estado, analista_id, anulada, es_historica_importacion')
        .in('id', evaluacionIds);
    if (error) throw new Error(error.message);
    const evals = {};
    for (const e of (evs || [])) if (!e.anulada && !e.es_historica_importacion) evals[e.id] = e;

    const rodeoIds = [...new Set(Object.values(evals).map(e => e.rodeo_id))];
    const analistaIds = [...new Set(Object.values(evals).map(e => e.analista_id).filter(Boolean))];
    const [{ data: rods }, { data: asigs }, { data: ans }, { data: cics }] = await Promise.all([
        rodeoIds.length ? supabase.from('rodeos').select('id, club, asociacion, fecha, tipo_rodeo_nombre').in('id', rodeoIds) : { data: [] },
        rodeoIds.length ? supabase.from('asignaciones').select('rodeo_id, estado_designacion, nombre_importado, usuarios_pagados(nombre_completo)')
            .in('rodeo_id', rodeoIds).eq('tipo_persona', 'jurado').eq('estado', 'activo') : { data: [] },
        analistaIds.length ? supabase.from('administradores').select('id, nombre_completo').in('id', analistaIds) : { data: [] },
        supabase.from('evaluacion_ciclos').select('id, evaluacion_id, numero_ciclo, estado').in('evaluacion_id', Object.keys(evals))
    ]);
    const rodeos = Object.fromEntries((rods || []).map(r => [r.id, r]));
    const jurados = {};
    for (const a of (asigs || [])) {
        if (a.estado_designacion === 'rechazado') continue;
        const n = a.usuarios_pagados?.nombre_completo || a.nombre_importado;
        if (n) (jurados[a.rodeo_id] = jurados[a.rodeo_id] || []).push(n);
    }
    const analistas = Object.fromEntries((ans || []).map(a => [a.id, a.nombre_completo]));
    const ciclos = Object.fromEntries((cics || []).map(c => [c.id, c]));
    return { evals, rodeos, jurados, analistas, ciclos };
}

function aItem(r, ctx) {
    const ev = ctx.evals[r.evaluacion_id];
    const rodeo = ctx.rodeos[ev.rodeo_id] || {};
    return {
        tipo: r.tipo,
        id: r.id,
        evaluacion_id: r.evaluacion_id,
        club: rodeo.club || null,
        asociacion: rodeo.asociacion || null,
        fecha_rodeo: rodeo.fecha || null,
        jurados: ctx.jurados[ev.rodeo_id] || [],
        ciclo: ctx.ciclos[r.ciclo_id]?.numero_ciclo ?? (r.tipo === TIPO_A ? 1 : null),
        estado: r.pendiente ? 'pendiente' : 'resuelto',
        decision: r.decision,
        resuelto_por_tipo: r.resuelto_por_tipo || null,
        resuelto_en: r.resuelto_en,
        derivado_en: r.derivado_en
    };
}

// ─── Portal de Comisión: listado + contadores ─────────────────────────────
// filtros: { desde, hasta (fecha del rodeo), tipo ('todos'|'resultado_alterado'|
// 'video_derivado'), estado ('pendientes'|'resueltos'|'todos'), resolucion
// ('todas'|'error'|'acierto') }. Los filtros solo LEEN: nunca cambian estados.
async function listarParaComision(filtros = {}) {
    const { desde = null, hasta = null, tipo = 'todos', estado = 'pendientes', resolucion = 'todas' } = filtros;
    const revisiones = await cargarRevisiones();
    const ctx = await cargarContexto([...new Set(revisiones.map(r => r.evaluacion_id))]);
    const todas = revisiones.filter(r => ctx.evals[r.evaluacion_id]).map(r => aItem(r, ctx));

    const enPeriodo = todas.filter(i =>
        (!desde || (i.fecha_rodeo && i.fecha_rodeo >= desde)) &&
        (!hasta || (i.fecha_rodeo && i.fecha_rodeo <= hasta)));

    const contar = (lista, t) => {
        const del = lista.filter(i => i.tipo === t);
        return { total: del.length, resueltas: del.filter(i => i.estado === 'resuelto').length, pendientes: del.filter(i => i.estado === 'pendiente').length };
    };
    const pendientesTotales = todas.filter(i => i.estado === 'pendiente').length;
    const pendientesPeriodo = enPeriodo.filter(i => i.estado === 'pendiente').length;
    const contadores = {
        periodo: {
            resultado_alterado: contar(enPeriodo, TIPO_A),
            video_derivado: contar(enPeriodo, TIPO_B),
            pendientes: pendientesPeriodo,
            resueltas: enPeriodo.length - pendientesPeriodo,
            total: enPeriodo.length
        },
        // Pendientes de TODOS los períodos: nunca los esconde el filtro de fechas.
        pendientes_totales: pendientesTotales,
        pendientes_totales_por_tipo: {
            resultado_alterado: todas.filter(i => i.tipo === TIPO_A && i.estado === 'pendiente').length,
            video_derivado: todas.filter(i => i.tipo === TIPO_B && i.estado === 'pendiente').length
        },
        pendientes_fuera_del_periodo: pendientesTotales - pendientesPeriodo,
        // Pendientes ANTERIORES al período elegido (para la advertencia).
        pendientes_anteriores: desde ? todas.filter(i => i.estado === 'pendiente' && i.fecha_rodeo && i.fecha_rodeo < desde).length : 0
    };

    let items = enPeriodo;
    if (tipo === TIPO_A || tipo === TIPO_B) items = items.filter(i => i.tipo === tipo);
    if (estado === 'pendientes') items = items.filter(i => i.estado === 'pendiente');
    else if (estado === 'resueltos') items = items.filter(i => i.estado === 'resuelto');
    if (resolucion === 'error' || resolucion === 'acierto') items = items.filter(i => i.decision === resolucion);

    // Pendientes primero y los más antiguos arriba; luego resueltos, los últimos decididos arriba.
    items.sort((a, b) => {
        if (a.estado !== b.estado) return a.estado === 'pendiente' ? -1 : 1;
        if (a.estado === 'pendiente') return String(a.fecha_rodeo || '').localeCompare(String(b.fecha_rodeo || '')) || String(a.derivado_en || '').localeCompare(String(b.derivado_en || ''));
        return String(b.resuelto_en || '').localeCompare(String(a.resuelto_en || ''));
    });
    return { contadores, items };
}

// ─── Detalle "Ver caso" ───────────────────────────────────────────────────
function diferenciaPuntaje(oficial, revisado) {
    const o = oficial == null || oficial === '' ? null : String(oficial).trim();
    const r = revisado == null || revisado === '' ? null : String(revisado).trim();
    if (o === null || r === null) return null;
    if (o === r) return { igual: true, texto: 'Sin diferencia' };
    const num = (v) => /^\d+$/.test(v) ? Number(v) : null;
    if (num(o) !== null && num(r) !== null) {
        const d = num(r) - num(o);
        return { igual: false, texto: `${d > 0 ? '+' : ''}${d} puntos` };
    }
    return { igual: false, texto: 'Distinto' };
}

async function detalleRevision(tipo, id) {
    if (![TIPO_A, TIPO_B].includes(tipo)) return { error: { status: 400, mensaje: 'Tipo de revisión inválido.' } };

    let evaluacionId;
    if (tipo === TIPO_A) {
        const { data } = await supabase.from('evaluacion_revisiones_comision').select('evaluacion_id, estado').eq('id', id).maybeSingle();
        if (!data || data.estado === 'anulada') return { error: { status: 404, mensaje: 'Revisión no encontrada.' } };
        evaluacionId = data.evaluacion_id;
    } else {
        const { data } = await supabase.from('evaluacion_casos').select('evaluacion_id, decision_analista, anulado').eq('id', id).maybeSingle();
        if (!data || data.decision_analista !== 'derivar_comision' || data.anulado) return { error: { status: 404, mensaje: 'Revisión no encontrada.' } };
        evaluacionId = data.evaluacion_id;
    }

    const revsEval = await cargarRevisiones({ evaluacionIds: [evaluacionId] });
    const ctx = await cargarContexto([evaluacionId]);
    const ev0 = ctx.evals[evaluacionId];
    if (!ev0) return { error: { status: 404, mensaje: 'Revisión no encontrada.' } };
    const revision = revsEval.find(r => r.tipo === tipo && r.id === id);
    if (!revision) return { error: { status: 404, mensaje: 'Revisión no encontrada.' } };

    const [{ data: ev }, { data: dm }, { data: casos }, { data: sits }] = await Promise.all([
        supabase.from('evaluaciones').select('id, estado, puntaje_oficial_1er, puntaje_oficial_2do, puntaje_oficial_3er, puntaje_analista_1er, puntaje_analista_2do, puntaje_analista_3er, observacion_general, resultados_alterados, comentario_resultados_alterados, casos_whatsapp').eq('id', evaluacionId).single(),
        supabase.from('datos_monitor_rodeo').select('puntaje_oficial_1er, puntaje_oficial_2do, puntaje_oficial_3er, comentario_monitor').eq('rodeo_id', ev0.rodeo_id).maybeSingle(),
        supabase.from('evaluacion_casos').select('id, ciclo_id, numero_caso, tipo_caso, descripcion, video_url, descuento_puntos, estado, resolucion_final, decision_analista, comentario_analista, analista_decidio_en, anulado').eq('evaluacion_id', evaluacionId).order('numero_caso'),
        supabase.from('control_gestion_situaciones').select('categoria_principal, subcategoria, descripcion_unificada, impacto').eq('rodeo_id', ev0.rodeo_id)
    ]);

    const rodeo = ctx.rodeos[ev0.rodeo_id] || {};
    const oficial = (n) => dm?.[`puntaje_oficial_${n}`] ?? ev?.[`puntaje_oficial_${n}`] ?? null;
    const puntajes = ['1er', '2do', '3er'].map((n, i) => {
        const o = oficial(n); const r = ev?.[`puntaje_analista_${n}`] ?? null;
        return { lugar: i + 1, oficial: o, revisado: r, diferencia: diferenciaPuntaje(o, r) };
    });

    const numCiclo = (cid) => ctx.ciclos[cid]?.numero_ciclo ?? null;
    const derivadosB = new Set(revsEval.filter(r => r.tipo === TIPO_B).map(r => r.id));
    const casoVista = (c) => ({
        id: c.id, ciclo: numCiclo(c.ciclo_id), numero_caso: c.numero_caso,
        tipo_situacion: TIPO_CASO_LABEL[c.tipo_caso] || c.tipo_caso,
        descripcion: c.descripcion || null, video_url: c.video_url || null,
        descuento_propuesto: c.descuento_puntos ?? 0,
        comentario_analista: c.comentario_analista || null,
        derivado_a_comision: derivadosB.has(c.id)
    });
    const casosVivos = (casos || []).filter(c => !c.anulado);

    const pendientesEval = revsEval.filter(r => r.pendiente).length;
    const pendienteEsta = revision.pendiente;

    const salida = {
        tipo,
        id,
        evaluacion_id: evaluacionId,
        estado: revision.pendiente ? 'pendiente' : 'resuelto',
        encabezado: {
            club: rodeo.club || null, asociacion: rodeo.asociacion || null, fecha: rodeo.fecha || null,
            tipo_rodeo: rodeo.tipo_rodeo_nombre || null,
            analista: ctx.analistas[ev0.analista_id] || null,
            jurados: ctx.jurados[ev0.rodeo_id] || [],
            ciclo: tipo === TIPO_A ? 1 : numCiclo(revision.ciclo_id)
        },
        analisis: {
            puntajes,
            casos_whatsapp: ev?.casos_whatsapp ?? null,
            observacion_general: ev?.observacion_general || null,
            comentario_monitor: dm?.comentario_monitor || null,
            situaciones: (sits || []).map(s => ({ categoria: s.categoria_principal, subcategoria: s.subcategoria || null, descripcion: s.descripcion_unificada || null, impacto: s.impacto || null }))
        },
        resolucion: revision.pendiente ? null : {
            decision: revision.decision, observacion: revision.observacion, resuelto_en: revision.resuelto_en,
            resuelto_por: revision.resuelto_por, resuelto_por_tipo: revision.resuelto_por_tipo || null,
            cierre_excepcional_id: revision.cierre_excepcional_id || null
        },
        // Advertencia previa a confirmar: si es la última revisión pendiente del
        // rodeo, al resolverla la nota puede publicarse automáticamente (si el
        // análisis ya cumple los requisitos de cierre).
        es_ultima_pendiente: pendienteEsta && pendientesEval === 1,
        otras_pendientes_del_rodeo: Math.max(0, pendientesEval - (pendienteEsta ? 1 : 0))
    };

    if (tipo === TIPO_A) {
        salida.resultado_alterado = {
            indicador: !!ev?.resultados_alterados,
            comentario: ev?.comentario_resultados_alterados || null,
            // Todos los videos disponibles del Ciclo 1 — una sola vez cada uno.
            // Los que además están derivados como Tipo B se marcan (se
            // resuelven por separado, nunca dos veces).
            videos_ciclo_1: casosVivos.filter(c => numCiclo(c.ciclo_id) === 1).map(casoVista)
        };
    } else {
        const c = casosVivos.find(x => x.id === id);
        salida.video_derivado = { ...casoVista(c), derivado_en: c.analista_decidio_en || null };
    }

    if (salida.resolucion?.resuelto_por) {
        const { data: adm } = await supabase.from('administradores').select('nombre_completo').eq('id', salida.resolucion.resuelto_por).maybeSingle();
        salida.resolucion.resuelto_por_nombre = adm?.nombre_completo || null;
    }
    return { detalle: salida };
}

// ─── CIERRE EXCEPCIONAL — ADMINISTRADOR: datos de la pantalla ─────────────
// Todo lo que el Administrador debe ver ANTES de decidir: rodeo, jurados,
// ciclos (y cuáles puede cerrar con el procedimiento normal), revisiones
// pendientes con sus videos y comentarios, descuentos propuestos e historial
// de cierres excepcionales anteriores. Solo lectura.
async function datosCierreExcepcional(evaluacionId) {
    const ctx = await cargarContexto([evaluacionId]);
    const ev = ctx.evals[evaluacionId];
    if (!ev) return { error: { status: 404, mensaje: 'Evaluación no encontrada.' } };

    const [revs, { data: casos }, { data: cierres }, { data: evFull }] = await Promise.all([
        cargarRevisiones({ evaluacionIds: [evaluacionId] }),
        supabase.from('evaluacion_casos')
            .select('id, ciclo_id, numero_caso, tipo_caso, descripcion, video_url, descuento_puntos, estado, decision_analista, comentario_analista, analista_decidio_en, anulado')
            .eq('evaluacion_id', evaluacionId).order('numero_caso'),
        supabase.from('evaluacion_cierres_excepcionales')
            .select('id, administrador_id, motivo, pendientes, tratamiento, ciclos, resultado, created_at')
            .eq('evaluacion_id', evaluacionId).order('created_at', { ascending: false }),
        supabase.from('evaluaciones').select('id, estado, resultados_alterados, comentario_resultados_alterados').eq('id', evaluacionId).single()
    ]);
    const rodeo = ctx.rodeos[ev.rodeo_id] || {};
    const numCiclo = (cid) => ctx.ciclos[cid]?.numero_ciclo ?? null;
    const vivos = (casos || []).filter(c => !c.anulado);
    const vistaCaso = (c) => ({
        caso_id: c.id, ciclo: numCiclo(c.ciclo_id), numero_caso: c.numero_caso,
        tipo_situacion: TIPO_CASO_LABEL[c.tipo_caso] || c.tipo_caso, descripcion: c.descripcion || null,
        video_url: c.video_url || null, descuento_propuesto: c.descuento_puntos ?? 0,
        comentario_analista: c.comentario_analista || null, derivado_en: c.analista_decidio_en || null
    });
    const pendA = revs.filter(r => r.tipo === TIPO_A && r.pendiente).map(r => ({
        revision_id: r.id,
        comentario_alteracion: evFull?.comentario_resultados_alterados || null,
        videos_ciclo_1: vivos.filter(c => numCiclo(c.ciclo_id) === 1).map(vistaCaso)
    }));
    const idsB = new Set(revs.filter(r => r.tipo === TIPO_B && r.pendiente).map(r => r.id));
    const pendB = vivos.filter(c => idsB.has(c.id)).map(vistaCaso);

    const adminIds = [...new Set((cierres || []).map(c => c.administrador_id))];
    const { data: admins } = adminIds.length
        ? await supabase.from('administradores').select('id, nombre_completo').in('id', adminIds)
        : { data: [] };
    const nombreAdmin = Object.fromEntries((admins || []).map(a => [a.id, a.nombre_completo]));

    const ciclos = Object.values(ctx.ciclos)
        .filter(c => c.evaluacion_id === evaluacionId)
        .sort((x, y) => x.numero_ciclo - y.numero_ciclo)
        .map(c => ({ ciclo_id: c.id, numero_ciclo: c.numero_ciclo, estado: c.estado, puede_cerrarse: c.estado === 'abierto' }));

    const publicada = ['aprobado', 'publicado', 'cerrado'].includes(evFull?.estado);
    // Recuperación: el último cierre excepcional cuya nota aún no se publicó
    // (fallo intermedio u otro ciclo abierto) y sin pendientes nuevos → se
    // puede COMPLETAR desde la pantalla, sin repetir decisiones.
    const ultimo = (cierres || [])[0] || null;
    const totalPend = pendA.length + pendB.length;
    const cierrePorCompletar = (!publicada && ultimo && totalPend === 0)
        ? { cierre_id: ultimo.id, created_at: ultimo.created_at, motivo: ultimo.motivo, resultado: ultimo.resultado || null,
            administrador: nombreAdmin[ultimo.administrador_id] || null }
        : null;
    return {
        datos: {
            evaluacion: {
                id: evaluacionId, estado: evFull?.estado || ev.estado,
                club: rodeo.club || null, asociacion: rodeo.asociacion || null, fecha: rodeo.fecha || null,
                tipo_rodeo: rodeo.tipo_rodeo_nombre || null,
                analista: ctx.analistas[ev.analista_id] || null, jurados: ctx.jurados[ev.rodeo_id] || []
            },
            ciclos,
            pendientes: { resultado_alterado: pendA, video_derivado: pendB },
            total_pendientes: pendA.length + pendB.length,
            puede_cerrar_excepcionalmente: !publicada && totalPend > 0,
            cierre_por_completar: cierrePorCompletar,
            cierres_anteriores: (cierres || []).map(c => ({ ...c, administrador: nombreAdmin[c.administrador_id] || null }))
        }
    };
}

module.exports = {
    TIPO_A, TIPO_B,
    cargarRevisiones, resumirPorEvaluacion, resumenComisionPorEvaluacion, filtroEvaluacionesPorComision,
    listarParaComision, detalleRevision, diferenciaPuntaje, datosCierreExcepcional
};
