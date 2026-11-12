/**
 * Historial Unificado de Designaciones — FUENTE ÚNICA para:
 *   - el historial de un rodeo (Rodeos → detalle, y Propuesta de Designación),
 *   - el reporte "Historial de Designaciones" (pantalla y Excel).
 *
 * Responde, por rodeo: qué propuso el motor (y con qué configuración), si la
 * administración lo confirmó o lo cambió (quién, cuándo, por qué), qué se
 * aplicó, publicó, aceptó o rechazó, los reemplazos/anulaciones posteriores
 * y qué jurado está VIGENTE hoy (siempre según `asignaciones`, nunca según
 * el texto de una propuesta).
 *
 * Fuentes reales, sin tablas nuevas: propuestas_designacion(+_detalle),
 * configuracion_designacion_versiones, asignaciones, bitacora_designaciones
 * (+catalogo_motivos_designacion) y auditoria.
 *
 * Reglas:
 *   - Nunca se inventa un motivo, autor ni decisión: si falta evidencia se
 *     informa "Sin información registrada".
 *   - Deduplicación: bitácora es la fuente preferida para cambios de jurado;
 *     la auditoría solo aporta lo que la bitácora no registra (confirmación,
 *     reversión, publicación, aceptación/rechazo, anulación, designación
 *     manual simple). Las auditorías que remiten a una bitácora se omiten.
 *   - Un evento antiguo nunca se reescribe por uno posterior.
 */
const supabase = require('../config/supabase');
const { DECISION, ETIQUETA_DECISION, clasificarDecisionFila, indexarEvidencia } = require('./evidenciaDecisionPropuesta');
const { FUENTE_CATEGORIA, categoriaJurado } = require('./categoriaJurado');

const PAGINA = 900;
const LOTE_IN = 150;
const SIN_INFO = 'Sin información registrada';

const ORIGEN = { MOTOR: 'MOTOR', ADMIN: 'ADMINISTRADOR', JURADO: 'JURADO', SISTEMA: 'SISTEMA' };

const TIPOS = {
    MOTOR_PROPUESTA:       'Propuesta original del motor',
    RELAJACION_MOTOR:      'Relajación automática de preferencias',
    BORRADOR_GUARDADO:     'Propuesta guardada como borrador',
    CLASIFICACION_AUTOMATICA: 'Estado asignado automáticamente al guardar (sin decisión individual registrada)',
    CONFIRMACION_ADMIN:    'Confirmación administrativa del jurado propuesto',
    MODIFICACION_BORRADOR: 'Cambio manual de jurado en el borrador',
    REVERSION_BORRADOR:    'Reversión de una decisión en el borrador',
    JURADO_MOVIDO:         'Jurado movido a otro rodeo del borrador',
    REGULARIZACION_ESTADO: 'Regularización técnica del estado de revisión',
    APLICACION_PROPUESTA:  'Aplicación de la propuesta (designación creada)',
    DESIGNACION_MANUAL:    'Designación manual desde Rodeos',
    PUBLICACION:           'Publicación de la designación',
    ACEPTACION:            'Aceptación de la designación',
    RECHAZO:               'Rechazo de la designación',
    REAPERTURA:            'Designación reabierta a pendiente',
    REEMPLAZO:             'Reemplazo posterior de jurado',
    ANULACION:             'Anulación de la designación',
    ESTADO_FINAL:          'Estado final — jurado vigente',
};

const ETIQUETA_BITACORA_REEMPLAZO = {
    reemplazo: 'Reemplazo de jurado',
    cambio_emergencia: 'Cambio de emergencia',
    regularizacion_posterior: 'Regularización posterior',
    enroque: 'Enroque de jurados',
    rectificacion_administrativa: 'Rectificación administrativa',
};

// ─── Utilidades de carga (paginadas y por lotes, nunca N+1) ───────────────
async function traerPaginado(construir) {
    const filas = [];
    for (let desde = 0; ; desde += PAGINA) {
        const { data, error } = await construir().range(desde, desde + PAGINA - 1);
        if (error) throw new Error(error.message);
        filas.push(...(data || []));
        if (!data || data.length < PAGINA) break;
    }
    return filas;
}

async function traerPorLotes(ids, construir) {
    const unicos = [...new Set((ids || []).filter(Boolean).map(String))];
    const filas = [];
    for (let i = 0; i < unicos.length; i += LOTE_IN) {
        const lote = unicos.slice(i, i + LOTE_IN);
        filas.push(...await traerPaginado(() => construir(lote)));
    }
    return filas;
}

function porId(filas) { return new Map((filas || []).map(f => [String(f.id), f])); }
const ts = x => (x ? new Date(x).getTime() : NaN);

function sumarDias(fechaIso, dias) {
    const d = new Date(String(fechaIso).slice(0, 10) + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
}

// ─── Selección de rodeos por filtros (el período selecciona RODEOS; luego
// se recupera TODO su historial, sin importar la fecha de cada movimiento).
// Un rodeo de varios días se incluye si cualquiera de sus días cae en el
// período (solapamiento), no solo por su fecha de inicio.
async function seleccionarRodeos(filtros = {}) {
    const { temporada_id, fecha_desde, fecha_hasta, asociacion, club, rodeo_ids, propuesta_id } = filtros;
    let restringirA = rodeo_ids ? new Set([].concat(rodeo_ids).map(String)) : null;

    if (propuesta_id) {
        const det = await traerPaginado(() => supabase.from('propuestas_designacion_detalle')
            .select('rodeo_id').eq('propuesta_id', propuesta_id).order('id'));
        const ids = new Set(det.map(d => String(d.rodeo_id)));
        restringirA = restringirA ? new Set([...restringirA].filter(id => ids.has(id))) : ids;
        if (restringirA.size === 0) return [];
    }

    const SELECT = 'id, club, asociacion, fecha, duracion_dias, tipo_rodeo_nombre, temporada_id, estado, tipos_rodeo(clasificaciones_designacion(nombre))';
    const base = () => {
        let q = supabase.from('rodeos').select(SELECT);
        if (temporada_id) q = q.eq('temporada_id', temporada_id);
        // Margen de 10 días hacia atrás para alcanzar rodeos de varios días
        // que empiezan antes del período y lo cubren (se afina abajo).
        if (fecha_desde) q = q.gte('fecha', sumarDias(fecha_desde, -10));
        if (fecha_hasta) q = q.lte('fecha', fecha_hasta);
        if (asociacion) q = q.ilike('asociacion', `%${asociacion}%`);
        if (club) q = q.ilike('club', `%${club}%`);
        return q.order('fecha', { ascending: true }).order('id', { ascending: true });
    };
    const rodeos = restringirA
        ? await traerPorLotes([...restringirA], lote => base().in('id', lote))
        : await traerPaginado(base);

    return rodeos.filter(r => {
        if (!fecha_desde) return true;
        const fin = sumarDias(r.fecha, Math.max(1, r.duracion_dias || 1) - 1);
        return fin >= fecha_desde;
    }).sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || String(a.club || '').localeCompare(String(b.club || ''), 'es') || String(a.id).localeCompare(String(b.id)));
}

// ─── Carga de todas las fuentes para un conjunto de rodeos ────────────────
async function cargarFuentes(rodeoIds) {
    const ids = [...new Set((rodeoIds || []).map(String))];
    if (ids.length === 0) {
        return { detalles: [], propuestas: [], asignaciones: [], bitacora: [], auditoria: [], jurados: new Map(), categorias: new Map(), admins: new Map() };
    }

    const [detalles, asignaciones, bitacora] = await Promise.all([
        traerPorLotes(ids, lote => supabase.from('propuestas_designacion_detalle')
            .select('id, propuesta_id, rodeo_id, jurado_id_propuesto, jurado_id_seleccionado, estado_revision, origen_seleccion, explicacion_json, metricas_json, created_at, updated_at')
            .in('rodeo_id', lote).order('id')),
        traerPorLotes(ids, lote => supabase.from('asignaciones')
            .select('id, rodeo_id, usuario_pagado_id, tipo_persona, estado, estado_designacion, publicado, publicado_en, publicado_por, propuesta_detalle_id, nombre_importado, categoria_aplicada, created_at, updated_at, created_by, aceptado_en, observacion_designacion')
            .in('rodeo_id', lote).eq('tipo_persona', 'jurado').order('id')),
        traerPorLotes(ids, lote => supabase.from('bitacora_designaciones')
            .select('id, propuesta_detalle_id, asignacion_id, rodeo_id, usuario_pagado_id_anterior, nombre_anterior_snapshot, usuario_pagado_id_nuevo, nombre_nuevo_snapshot, tipo_movimiento, motivo_catalogo_id, motivo_detalle, actor_id, fecha_efectiva, created_at, operacion_id, catalogo_motivos_designacion(codigo, etiqueta)')
            .in('rodeo_id', lote).order('id')),
    ]);

    const propuestaIds = [...new Set(detalles.map(d => d.propuesta_id))];
    const propuestas = await traerPorLotes(propuestaIds, lote => supabase.from('propuestas_designacion')
        .select('id, estado, creado_por, created_at, configuracion_version_id, motor_usado, fecha_corte_tecnica, resultado_cobertura_json, configuracion_designacion_versiones(numero_version)')
        .in('id', lote).order('id'));

    const detalleIds = detalles.map(d => d.id);
    const asignacionIds = asignaciones.map(a => a.id);
    const [audDetalle, audAsig, audPublic] = await Promise.all([
        traerPorLotes(detalleIds, lote => supabase.from('auditoria')
            .select('id, tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion, created_at')
            .eq('tabla', 'propuestas_designacion_detalle').in('registro_id', lote).order('id')),
        traerPorLotes(asignacionIds, lote => supabase.from('auditoria')
            .select('id, tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion, created_at')
            .eq('tabla', 'asignaciones').in('registro_id', lote).order('id')),
        // La publicación se audita con registro_id = rodeo.
        traerPorLotes(ids, lote => supabase.from('auditoria')
            .select('id, tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion, created_at')
            .eq('tabla', 'asignaciones').eq('accion', 'publicar_designaciones').in('registro_id', lote).order('id')),
    ]);
    const auditoria = [...audDetalle, ...audAsig, ...audPublic];

    const juradoIds = new Set();
    detalles.forEach(d => { juradoIds.add(d.jurado_id_propuesto); juradoIds.add(d.jurado_id_seleccionado); });
    asignaciones.forEach(a => juradoIds.add(a.usuario_pagado_id));
    bitacora.forEach(b => { juradoIds.add(b.usuario_pagado_id_anterior); juradoIds.add(b.usuario_pagado_id_nuevo); });
    auditoria.forEach(a => {
        juradoIds.add(a.datos_nuevos?.usuario_pagado_id); juradoIds.add(a.datos_anteriores?.usuario_pagado_id);
        juradoIds.add(a.datos_nuevos?.jurado_id_seleccionado);
        if (a.actor_tipo === 'usuario_pagado') juradoIds.add(a.actor_id);
    });
    const adminIds = new Set();
    propuestas.forEach(p => adminIds.add(p.creado_por));
    bitacora.forEach(b => adminIds.add(b.actor_id));
    asignaciones.forEach(a => { adminIds.add(a.created_by); adminIds.add(a.publicado_por); });
    auditoria.forEach(a => { if (a.actor_tipo === 'administrador') adminIds.add(a.actor_id); });
    detalles.forEach(d => adminIds.add(d.metricas_json?.revision_administrativa?.actor_id));

    const [jurados, admins] = await Promise.all([
        traerPorLotes([...juradoIds], lote => supabase.from('usuarios_pagados').select('id, nombre_completo, categoria').in('id', lote).order('id')),
        traerPorLotes([...adminIds], lote => supabase.from('administradores').select('id, nombre_completo').in('id', lote).order('id')),
    ]);

    return {
        detalles, propuestas, asignaciones, bitacora, auditoria,
        jurados: new Map(jurados.map(j => [String(j.id), j.nombre_completo])),
        categorias: new Map(jurados.map(j => [String(j.id), j.categoria || null])),
        admins: new Map(admins.map(a => [String(a.id), a.nombre_completo])),
    };
}

// ─── Construcción PURA de la línea de tiempo de un rodeo ──────────────────
function construirLineaTiempo(rodeo, fuentes) {
    const rid = String(rodeo.id);
    const nombreJurado = id => (id ? (fuentes.jurados.get(String(id)) || null) : null);
    const nombreAdmin = id => (id ? (fuentes.admins.get(String(id)) || null) : null);
    // ctx = { detalle, asignacion } → categoría histórica si existe (ver categoriaJurado).
    const jur = (id, snapshot, ctx) => (id || snapshot ? { id: id || null, nombre: snapshot || nombreJurado(id) || null, ...categoriaJurado(fuentes, id, ctx) } : null);
    const propuestaPorId = porId(fuentes.propuestas);

    const detalles = fuentes.detalles.filter(d => String(d.rodeo_id) === rid);
    const detallePorId = porId(detalles);
    const asignaciones = fuentes.asignaciones.filter(a => String(a.rodeo_id) === rid);
    const asignacionPorId = porId(asignaciones);
    const asigDeDetalle = d => (d ? asignaciones.find(a => String(a.propuesta_detalle_id) === String(d.id)) || null : null);
    const bitacora = fuentes.bitacora.filter(b => String(b.rodeo_id) === rid)
        .sort((a, b) => ts(a.created_at) - ts(b.created_at) || String(a.id).localeCompare(String(b.id)));
    const audit = fuentes.auditoria.filter(a =>
        (a.tabla === 'propuestas_designacion_detalle' && detallePorId.has(String(a.registro_id))) ||
        (a.tabla === 'asignaciones' && (asignacionPorId.has(String(a.registro_id)) || (a.accion === 'publicar_designaciones' && String(a.registro_id) === rid)))
    );

    // Propuesta realmente aplicada = detalle referenciado por una asignación real.
    const detallesAplicados = new Set(asignaciones.map(a => a.propuesta_detalle_id).filter(Boolean).map(String));
    const infoPropuesta = d => {
        const p = propuestaPorId.get(String(d.propuesta_id)) || {};
        return {
            propuesta_id: d.propuesta_id,
            propuesta_aplicada: detallesAplicados.has(String(d.id)),
            configuracion_version: p.configuracion_designacion_versiones?.numero_version ?? null,
            motor: p.motor_usado || null,
        };
    };

    // Jurado de una asignación en un momento dado (cadena de reemplazos).
    const reemplazosPorAsig = new Map();
    bitacora.filter(b => b.asignacion_id && ETIQUETA_BITACORA_REEMPLAZO[b.tipo_movimiento]).forEach(b => {
        const k = String(b.asignacion_id);
        if (!reemplazosPorAsig.has(k)) reemplazosPorAsig.set(k, []);
        reemplazosPorAsig.get(k).push(b);
    });
    function juradoDeAsignacionEn(asigId, momento) {
        const a = asignacionPorId.get(String(asigId));
        const cadena = reemplazosPorAsig.get(String(asigId)) || [];
        let actual = cadena.length ? cadena[0].usuario_pagado_id_anterior : (a?.usuario_pagado_id || null);
        for (const r of cadena) if (!momento || ts(r.created_at) <= ts(momento)) actual = r.usuario_pagado_id_nuevo;
        return actual;
    }

    const eventos = [];
    const evento = e => eventos.push({
        rodeo_id: rid, jurado_anterior: null, jurado_nuevo: null, responsable: SIN_INFO,
        motivo: null, justificacion: null, estado_resultante: null, referencia: null,
        propuesta_id: null, propuesta_aplicada: null, configuracion_version: null, ...e,
        etiqueta: e.etiqueta || TIPOS[e.tipo],
    });

    // 1-3. Motor, relajaciones y borrador guardado (por cada propuesta).
    const bitacoraAutomatica = new Set(bitacora.filter(b => b.tipo_movimiento === 'propuesta_automatica').map(b => String(b.propuesta_detalle_id)));
    for (const d of detalles) {
        const p = propuestaPorId.get(String(d.propuesta_id)) || {};
        const info = infoPropuesta(d);
        const motorTxt = `Motor ${p.motor_usado === 'global' ? 'global optimizado' : 'local'}${info.configuracion_version != null ? ` · configuración v${info.configuracion_version}` : ''}`;
        const fechaMotor = p.fecha_corte_tecnica || p.created_at || d.created_at;
        if (!bitacoraAutomatica.has(String(d.id))) {
            evento({
                id: `motor:${d.id}`, fecha: fechaMotor, tipo: 'MOTOR_PROPUESTA', origen: ORIGEN.MOTOR,
                jurado_nuevo: d.jurado_id_propuesto ? jur(d.jurado_id_propuesto, null, { detalle: d }) : null,
                responsable: motorTxt,
                estado_resultante: d.jurado_id_propuesto ? 'Propuesto por el motor (pendiente de revisión)' : (d.estado_revision === 'NO_EVALUABLE' ? 'Rodeo no evaluable' : 'Sin candidato del motor'),
                referencia: { tabla: 'propuestas_designacion_detalle', id: d.id }, ...info,
            });
        }
        const relaj = d.explicacion_json?.jurado_propuesto?.optimizacion_global_relajaciones || [];
        if (relaj.length > 0) {
            evento({
                id: `relajacion:${d.id}`, fecha: fechaMotor, tipo: 'RELAJACION_MOTOR', origen: ORIGEN.MOTOR,
                jurado_nuevo: jur(d.jurado_id_propuesto, null, { detalle: d }), responsable: motorTxt,
                justificacion: `Preferencias relajadas por el optimizador: ${relaj.join(', ')}`,
                estado_resultante: 'Advertencia del motor (no es una decisión administrativa)',
                referencia: { tabla: 'propuestas_designacion_detalle', id: d.id }, ...info,
            });
        }
        if (p.created_at) {
            evento({
                id: `borrador:${d.id}`, fecha: p.created_at, tipo: 'BORRADOR_GUARDADO', origen: ORIGEN.ADMIN,
                responsable: nombreAdmin(p.creado_por) || SIN_INFO,
                estado_resultante: 'Borrador guardado — guardar no implica aprobación administrativa',
                referencia: { tabla: 'propuestas_designacion', id: d.propuesta_id }, ...info,
            });
        }
    }

    // 4. Bitácora (fuente preferida para cambios de identidad).
    const aplicacionesBitacora = new Set();
    const creacionesBitacora = new Set();
    for (const b of bitacora) {
        const d = b.propuesta_detalle_id ? detallePorId.get(String(b.propuesta_detalle_id)) : null;
        const info = d ? infoPropuesta(d) : {};
        const motivo = b.catalogo_motivos_designacion?.etiqueta || null;
        const asigB = b.asignacion_id ? (asignacionPorId.get(String(b.asignacion_id)) || null) : asigDeDetalle(d);
        const ctxB = { detalle: d || (asigB?.propuesta_detalle_id ? detallePorId.get(String(asigB.propuesta_detalle_id)) || null : null), asignacion: asigB };
        const base = {
            id: `bitacora:${b.id}`, fecha: b.fecha_efectiva || b.created_at, origen: ORIGEN.ADMIN,
            jurado_anterior: jur(b.usuario_pagado_id_anterior, b.nombre_anterior_snapshot, ctxB),
            jurado_nuevo: jur(b.usuario_pagado_id_nuevo, b.nombre_nuevo_snapshot, b.tipo_movimiento === 'propuesta_automatica' ? { detalle: d } : ctxB),
            responsable: nombreAdmin(b.actor_id) || SIN_INFO,
            motivo: motivo || (['modificacion_manual_borrador', 'designacion_manual_con_advertencia'].includes(b.tipo_movimiento) || ETIQUETA_BITACORA_REEMPLAZO[b.tipo_movimiento] ? SIN_INFO : null),
            justificacion: b.motivo_detalle || null,
            referencia: { tabla: 'bitacora_designaciones', id: b.id }, ...info,
        };
        switch (b.tipo_movimiento) {
            case 'propuesta_automatica':
                evento({ ...base, tipo: 'MOTOR_PROPUESTA', origen: ORIGEN.MOTOR, estado_resultante: 'Propuesto por el motor' }); break;
            case 'modificacion_manual_borrador':
                evento({ ...base, tipo: 'MODIFICACION_BORRADOR', estado_resultante: 'Modificado por administración (borrador)' }); break;
            case 'aplicacion_propuesta':
                if (b.asignacion_id) aplicacionesBitacora.add(String(b.asignacion_id));
                evento({ ...base, tipo: 'APLICACION_PROPUESTA', estado_resultante: 'Designación creada (no publicada)' }); break;
            case 'designacion_manual_con_advertencia':
                if (b.asignacion_id) creacionesBitacora.add(String(b.asignacion_id));
                evento({ ...base, tipo: 'DESIGNACION_MANUAL', etiqueta: 'Designación manual desde Rodeos (con advertencias confirmadas)', estado_resultante: 'Designación creada (no publicada)' }); break;
            case 'aceptacion':
                evento({ ...base, tipo: 'ACEPTACION', estado_resultante: 'Aceptada' }); break;
            case 'rechazo':
                evento({ ...base, tipo: 'RECHAZO', estado_resultante: 'Rechazada' }); break;
            default:
                if (ETIQUETA_BITACORA_REEMPLAZO[b.tipo_movimiento]) {
                    evento({ ...base, tipo: 'REEMPLAZO', etiqueta: `${TIPOS.REEMPLAZO} — ${ETIQUETA_BITACORA_REEMPLAZO[b.tipo_movimiento]}`, estado_resultante: 'Nuevo jurado designado (pendiente de aceptación)' });
                } else {
                    evento({ ...base, tipo: 'REEMPLAZO', etiqueta: `Movimiento registrado: ${b.tipo_movimiento}` });
                }
        }
    }
    // Una auditoría que cita "bitácora <uuid>" describe el MISMO movimiento
    // que ya aporta la bitácora → se omite para no duplicar el evento.
    const remiteABitacora = a => /bit[aá]cora\s+[0-9a-f-]{36}/i.test(String(a.descripcion || ''));

    // 5. Auditoría de filas de propuesta (confirmación, reversión, movidas).
    for (const a of audit.filter(x => x.tabla === 'propuestas_designacion_detalle')) {
        const d = detallePorId.get(String(a.registro_id));
        const info = infoPropuesta(d);
        const dn = a.datos_nuevos || {}, da = a.datos_anteriores || {};
        if (remiteABitacora(a)) continue;
        const ctxD = { detalle: d, asignacion: asigDeDetalle(d) };
        const base = {
            id: `auditoria:${a.id}`, fecha: a.created_at, origen: ORIGEN.ADMIN,
            responsable: nombreAdmin(a.actor_id) || SIN_INFO,
            referencia: { tabla: 'auditoria', id: a.id }, ...info,
        };
        const vistaPrevia = dn.en_vista_previa ? ' (en la vista previa, antes de guardar)' : '';
        if (a.accion === 'regularizar') {
            evento({
                ...base, tipo: 'REGULARIZACION_ESTADO', origen: ORIGEN.SISTEMA,
                motivo: dn.motivo || null, justificacion: a.descripcion || null,
                estado_resultante: `Estado corregido a ${dn.estado_revision || 'PENDIENTE'} (no fue una decisión administrativa)`,
            });
            continue;
        }
        if (dn.estado_revision === 'ACEPTADO' || (dn.estado_revision === 'MODIFICADO' && dn.jurado_id_seleccionado && dn.jurado_id_seleccionado === d.jurado_id_propuesto)) {
            const advs = dn.advertencias_confirmadas && dn.advertencias_confirmadas.length ? dn.advertencias_confirmadas : null;
            evento({
                ...base, tipo: 'CONFIRMACION_ADMIN', etiqueta: TIPOS.CONFIRMACION_ADMIN + vistaPrevia,
                jurado_nuevo: jur(dn.jurado_id_seleccionado || d.jurado_id_propuesto, null, ctxD),
                justificacion: advs ? `Advertencias confirmadas: ${advs.join(', ')}` : (dn.estado_revision === 'MODIFICADO' ? 'Registrado como MODIFICADO por la regla anterior; el jurado no cambió' : null),
                estado_resultante: 'Confirmado por administración',
            });
        } else if (dn.estado_revision === 'MODIFICADO') {
            evento({
                ...base, tipo: 'MODIFICACION_BORRADOR', etiqueta: TIPOS.MODIFICACION_BORRADOR + vistaPrevia,
                jurado_anterior: jur(d.jurado_id_propuesto, null, { detalle: d }), jurado_nuevo: jur(dn.jurado_id_seleccionado, null, ctxD),
                motivo: SIN_INFO, estado_resultante: 'Modificado por administración (borrador)',
            });
        } else if (Object.prototype.hasOwnProperty.call(dn, 'jurado_id_seleccionado') && dn.jurado_id_seleccionado == null) {
            const movido = /movido|retirado/i.test(a.descripcion || '');
            evento({
                ...base, tipo: movido ? 'JURADO_MOVIDO' : 'REVERSION_BORRADOR',
                jurado_anterior: jur(da.jurado_id_seleccionado || (da.estado_revision === 'PENDIENTE' ? d.jurado_id_propuesto : null), null, ctxD),
                justificacion: a.descripcion || null,
                estado_resultante: `Fila vuelve a ${dn.estado_revision || '—'}`,
            });
        }
    }

    // 5b. Interpretación por EVIDENCIA (evidenciaDecisionPropuesta.js): un
    // estado ACEPTADO/MODIFICADO sin evidencia individual NO se presenta como
    // decisión del administrador — se rotula como clasificación automática
    // del guardado (origen SISTEMA). Un cambio de jurado sin registro
    // individual sí es un hecho (el motor no elige otro jurado), pero sin
    // autor ni motivo conocidos.
    const evidenciaDe = indexarEvidencia({ bitacora, auditoria: audit, asignaciones });
    const decisionPorDetalle = new Map();
    for (const d of detalles) {
        const clas = clasificarDecisionFila(d, evidenciaDe(d.id));
        decisionPorDetalle.set(String(d.id), clas);
        const p = propuestaPorId.get(String(d.propuesta_id)) || {};
        const info = infoPropuesta(d);
        if (clas.decision === DECISION.CLASIFICACION_AUTOMATICA) {
            evento({
                id: `clasificacion-automatica:${d.id}`, fecha: p.created_at || d.created_at, tipo: 'CLASIFICACION_AUTOMATICA', origen: ORIGEN.SISTEMA,
                jurado_nuevo: jur(d.jurado_id_propuesto, null, { detalle: d }), responsable: 'Sistema (regla anterior al 11/11/2026)',
                justificacion: `El borrador registra ${d.estado_revision}/${d.origen_seleccion || '—'}, pero no existe confirmación individual del administrador (sin auditoría de la fila, sin bitácora de modificación, sin marca de revisión). El jurado es el propuesto por el motor.`,
                estado_resultante: 'Sin confirmación individual registrada — no es una decisión administrativa comprobada',
                referencia: { tabla: 'propuestas_designacion_detalle', id: d.id }, ...info,
            });
        } else if (clas.decision === DECISION.MODIFICACION_SIN_REGISTRO) {
            evento({
                id: `modificacion-sin-registro:${d.id}`, fecha: null, tipo: 'MODIFICACION_BORRADOR', origen: ORIGEN.ADMIN,
                etiqueta: `${TIPOS.MODIFICACION_BORRADOR} (sin registro individual)`,
                jurado_anterior: jur(d.jurado_id_propuesto, null, { detalle: d }), jurado_nuevo: jur(d.jurado_id_seleccionado, null, { detalle: d, asignacion: asigDeDetalle(d) }),
                responsable: SIN_INFO, motivo: SIN_INFO,
                justificacion: 'Derivado: el jurado seleccionado difiere del propuesto por el motor, pero no hay bitácora ni auditoría del cambio',
                estado_resultante: 'Modificado (sin evidencia de autor ni motivo)',
                referencia: { tabla: 'propuestas_designacion_detalle', id: d.id }, ...info,
            });
        }
    }

    // 6. Asignaciones reales: creación, publicación, respuesta, anulación.
    const audAsig = audit.filter(x => x.tabla === 'asignaciones');
    const asigConCreacion = new Set([...aplicacionesBitacora, ...creacionesBitacora]);
    const asigConRespuesta = new Set();
    const asigConAnulacion = new Set();
    const asigPublicadas = new Set();
    for (const a of audAsig) {
        const dn = a.datos_nuevos || {}, da = a.datos_anteriores || {};
        const asig = asignacionPorId.get(String(a.registro_id));
        const detAsig = asig?.propuesta_detalle_id ? detallePorId.get(String(asig.propuesta_detalle_id)) : null;
        const info = detAsig ? infoPropuesta(detAsig) : {};
        const esJurado = a.actor_tipo === 'usuario_pagado';
        const responsable = esJurado ? (nombreJurado(a.actor_id) || 'Jurado') : (nombreAdmin(a.actor_id) || SIN_INFO);
        const base = { id: `auditoria:${a.id}`, fecha: a.created_at, responsable, referencia: { tabla: 'auditoria', id: a.id }, ...info };

        if (a.accion === 'publicar_designaciones') {
            (dn.asignacion_ids || []).forEach(x => asigPublicadas.add(String(x)));
            const juradosPub = (dn.asignacion_ids || []).map(x => juradoDeAsignacionEn(x, a.created_at)).filter(Boolean);
            evento({
                ...base, tipo: 'PUBLICACION', origen: ORIGEN.ADMIN,
                jurado_nuevo: juradosPub.length === 1 ? jur(juradosPub[0], null, { asignacion: asignacionPorId.get(String((dn.asignacion_ids || [])[0])) || null }) : null,
                justificacion: a.descripcion || null, estado_resultante: 'Publicada (visible para el jurado)',
            });
            continue;
        }
        if (!asig) continue;
        const ctxA = { detalle: detAsig, asignacion: asig };
        if (a.accion === 'crear') {
            if (dn.origen === 'propuesta_designacion') {
                if (aplicacionesBitacora.has(String(asig.id))) continue;
                asigConCreacion.add(String(asig.id));
                // decision_individual (desde 2026-11-11) se basa en evidencia; el
                // revisado_por_admin antiguo se derivaba del estado y NO se usa
                // para afirmar una confirmación (solo su valor false es fiable).
                const justAplic = dn.decision_individual
                    ? `Aplicación colectiva — decisión individual previa: ${ETIQUETA_DECISION[dn.decision_individual] || 'no verificable al momento de aplicar'}`
                    : (dn.revisado_por_admin === false ? 'Aplicada como sugerencia del motor, sin confirmación administrativa previa' : null);
                evento({ ...base, tipo: 'APLICACION_PROPUESTA', origen: ORIGEN.ADMIN, jurado_nuevo: jur(dn.usuario_pagado_id, null, ctxA), estado_resultante: 'Designación creada (no publicada)', justificacion: justAplic });
                continue;
            }
            if (remiteABitacora(a)) { asigConCreacion.add(String(asig.id)); continue; }
            asigConCreacion.add(String(asig.id));
            evento({ ...base, tipo: 'DESIGNACION_MANUAL', origen: ORIGEN.ADMIN, jurado_nuevo: jur(dn.usuario_pagado_id, null, ctxA), estado_resultante: 'Designación creada (no publicada)' });
            continue;
        }
        if (a.accion === 'eliminar') {
            asigConAnulacion.add(String(asig.id));
            const anulado = da.usuario_pagado_id || juradoDeAsignacionEn(asig.id, a.created_at);
            evento({ ...base, tipo: 'ANULACION', origen: ORIGEN.ADMIN, jurado_anterior: jur(anulado, null, ctxA), motivo: dn.motivo || SIN_INFO, estado_resultante: 'Anulada' });
            continue;
        }
        if (a.accion === 'editar' && dn.estado_designacion && !remiteABitacora(a)) {
            asigConRespuesta.add(String(asig.id));
            const tipo = dn.estado_designacion === 'aceptado' ? 'ACEPTACION' : dn.estado_designacion === 'rechazado' ? 'RECHAZO' : 'REAPERTURA';
            evento({
                ...base, tipo, origen: esJurado ? ORIGEN.JURADO : ORIGEN.ADMIN,
                etiqueta: TIPOS[tipo] + (esJurado ? ' (por el jurado)' : ' (registrada por administración)'),
                jurado_nuevo: jur(juradoDeAsignacionEn(asig.id, a.created_at), null, ctxA),
                justificacion: a.descripcion || null,
                estado_resultante: { ACEPTACION: 'Aceptada', RECHAZO: 'Rechazada', REAPERTURA: 'Pendiente de respuesta' }[tipo],
            });
        }
    }

    // 7. Respaldo desde la propia asignación cuando no hay evidencia de evento
    // (registros antiguos o importados). Se rotulan como derivados, sin autor
    // inventado.
    for (const asig of asignaciones) {
        const k = String(asig.id);
        const detAsig = asig.propuesta_detalle_id ? detallePorId.get(String(asig.propuesta_detalle_id)) : null;
        const info = detAsig ? infoPropuesta(detAsig) : {};
        const juradoOriginal = juradoDeAsignacionEn(asig.id, asig.created_at);
        const ctxR = { detalle: detAsig, asignacion: asig };
        if (!asigConCreacion.has(k)) {
            evento({
                id: `asignacion-creada:${k}`, fecha: asig.created_at, tipo: asig.propuesta_detalle_id ? 'APLICACION_PROPUESTA' : 'DESIGNACION_MANUAL',
                etiqueta: asig.propuesta_detalle_id ? TIPOS.APLICACION_PROPUESTA : 'Designación registrada (origen sin detalle registrado)',
                origen: ORIGEN.ADMIN, jurado_nuevo: jur(juradoOriginal, reemplazosPorAsig.has(k) ? null : asig.nombre_importado, ctxR),
                responsable: nombreAdmin(asig.created_by) || SIN_INFO,
                justificacion: 'Evento reconstruido desde el registro de la asignación (sin auditoría específica)',
                estado_resultante: 'Designación creada', referencia: { tabla: 'asignaciones', id: asig.id }, ...info,
            });
        }
        if (asig.publicado && asig.publicado_en && !asigPublicadas.has(k) && !audAsig.some(a => a.accion === 'publicar_designaciones' && Math.abs(ts(a.created_at) - ts(asig.publicado_en)) < 120000)) {
            evento({
                id: `asignacion-publicada:${k}`, fecha: asig.publicado_en, tipo: 'PUBLICACION', origen: ORIGEN.ADMIN,
                jurado_nuevo: jur(juradoDeAsignacionEn(asig.id, asig.publicado_en), null, ctxR),
                responsable: nombreAdmin(asig.publicado_por) || SIN_INFO,
                estado_resultante: 'Publicada (visible para el jurado)', referencia: { tabla: 'asignaciones', id: asig.id }, ...info,
            });
        }
        if (!asigConRespuesta.has(k) && (asig.estado_designacion === 'aceptado' || asig.estado_designacion === 'rechazado')) {
            const tipo = asig.estado_designacion === 'aceptado' ? 'ACEPTACION' : 'RECHAZO';
            evento({
                id: `asignacion-respuesta:${k}`, fecha: tipo === 'ACEPTACION' ? (asig.aceptado_en || null) : null, tipo, origen: ORIGEN.SISTEMA,
                jurado_nuevo: jur(asig.usuario_pagado_id, null, ctxR), responsable: SIN_INFO,
                justificacion: `Derivado del estado actual de la asignación${asig.observacion_designacion ? ' — observación: ' + asig.observacion_designacion : ''}`,
                estado_resultante: tipo === 'ACEPTACION' ? 'Aceptada' : 'Rechazada', referencia: { tabla: 'asignaciones', id: asig.id }, ...info,
            });
        }
        if (asig.estado === 'anulado' && !asigConAnulacion.has(k)) {
            evento({
                id: `asignacion-anulada:${k}`, fecha: asig.updated_at, tipo: 'ANULACION', origen: ORIGEN.SISTEMA,
                jurado_anterior: jur(asig.usuario_pagado_id, null, ctxR), responsable: SIN_INFO, motivo: SIN_INFO,
                justificacion: 'Derivado del estado de la asignación; fecha = última actualización registrada',
                estado_resultante: 'Anulada', referencia: { tabla: 'asignaciones', id: asig.id }, ...info,
            });
        }
    }

    // Orden cronológico estable; eventos sin fecha al final.
    const ORDEN_TIPO = Object.keys(TIPOS);
    eventos.sort((a, b) => {
        const fa = ts(a.fecha), fb = ts(b.fecha);
        if (isNaN(fa) !== isNaN(fb)) return isNaN(fa) ? 1 : -1;
        return (fa - fb) || (ORDEN_TIPO.indexOf(a.tipo) - ORDEN_TIPO.indexOf(b.tipo)) || String(a.id).localeCompare(String(b.id));
    });

    // 8. Estado final — SIEMPRE desde asignaciones reales.
    const vigentes = asignaciones.filter(a => a.estado === 'activo' && a.estado_designacion !== 'rechazado');
    const rechazadasVivas = asignaciones.filter(a => a.estado === 'activo' && a.estado_designacion === 'rechazado');
    const estadoFinalTxt = vigentes.length > 0
        ? vigentes.map(a => `${a.estado_designacion === 'aceptado' ? 'Aceptada' : 'Pendiente de respuesta'}${a.publicado ? ', publicada' : ', no publicada'}`).join(' / ')
        : (rechazadasVivas.length > 0 ? 'Designación rechazada, sin reemplazo vigente' : 'Sin jurado designado');
    eventos.push({
        id: `estado-final:${rid}`, rodeo_id: rid, fecha: null, tipo: 'ESTADO_FINAL', etiqueta: TIPOS.ESTADO_FINAL, origen: ORIGEN.SISTEMA,
        jurado_anterior: null,
        jurado_nuevo: vigentes.length === 1 ? jur(vigentes[0].usuario_pagado_id, null, { asignacion: vigentes[0] }) : null,
        responsable: 'Sistema (según asignaciones vigentes)',
        motivo: null,
        justificacion: vigentes.length > 1 ? `Jurados vigentes: ${vigentes.map(a => nombreJurado(a.usuario_pagado_id) || a.usuario_pagado_id).join(', ')}` : null,
        estado_resultante: estadoFinalTxt, referencia: vigentes.length === 1 ? { tabla: 'asignaciones', id: vigentes[0].id } : null,
        propuesta_id: null, propuesta_aplicada: null, configuracion_version: null,
    });

    return { eventos, vigentes, detalles, asignaciones, decisionPorDetalle };
}

// ─── Resumen por rodeo (Hoja 1) ──────────────────────────────────────────
function resumirRodeo(rodeo, linea, fuentes) {
    const nombre = id => (id ? (fuentes.jurados.get(String(id)) || id) : null);
    const propuestaPorId = porId(fuentes.propuestas);
    const aplicada = linea.asignaciones.find(a => a.propuesta_detalle_id && linea.detalles.some(d => String(d.id) === String(a.propuesta_detalle_id)));
    const detAplicado = aplicada ? linea.detalles.find(d => String(d.id) === String(aplicada.propuesta_detalle_id)) : null;
    const detReferencia = detAplicado || linea.detalles.slice().sort((a, b) => ts(propuestaPorId.get(String(b.propuesta_id))?.created_at) - ts(propuestaPorId.get(String(a.propuesta_id))?.created_at))[0] || null;
    const prop = detReferencia ? propuestaPorId.get(String(detReferencia.propuesta_id)) : null;

    // Solo una decisión CON EVIDENCIA se informa como confirmación o
    // modificación administrativa (nunca el estado_revision por sí solo).
    let confirmado = null;
    let confirmadoJurado = null, confirmadoNota = null;
    const juradoConCat = (id, ctx) => (id ? { id, nombre: fuentes.jurados.get(String(id)) || String(id), ...categoriaJurado(fuentes, id, ctx) } : null);
    const ctxRef = detReferencia ? { detalle: detReferencia, asignacion: aplicada && String(aplicada.propuesta_detalle_id) === String(detReferencia.id) ? aplicada : null } : {};
    const decision = detReferencia ? (linea.decisionPorDetalle?.get(String(detReferencia.id)) || null) : null;
    if (detReferencia && decision) {
        switch (decision.decision) {
            case DECISION.CONFIRMACION_COMPROBADA:
                confirmado = nombre(detReferencia.jurado_id_seleccionado || detReferencia.jurado_id_propuesto);
                confirmadoJurado = juradoConCat(detReferencia.jurado_id_seleccionado || detReferencia.jurado_id_propuesto, ctxRef); break;
            case DECISION.MODIFICACION_COMPROBADA:
                confirmado = `${nombre(detReferencia.jurado_id_seleccionado)} (modificado)`;
                confirmadoJurado = juradoConCat(detReferencia.jurado_id_seleccionado, ctxRef); confirmadoNota = '(modificado)'; break;
            case DECISION.MODIFICACION_SIN_REGISTRO:
                confirmado = `${nombre(detReferencia.jurado_id_seleccionado)} (modificado, sin registro individual)`;
                confirmadoJurado = juradoConCat(detReferencia.jurado_id_seleccionado, ctxRef); confirmadoNota = '(modificado, sin registro individual)'; break;
            case DECISION.CLASIFICACION_AUTOMATICA: confirmado = detAplicado ? 'Sin confirmación individual registrada (aplicado en la aplicación colectiva de la propuesta)' : 'Sin confirmación individual registrada'; break;
            default: confirmado = detAplicado ? 'Sin confirmación administrativa (aplicado como sugerencia del motor)' : 'Sin confirmación administrativa';
        }
    }
    const vig = linea.vigentes;
    const eventosReales = linea.eventos.filter(e => e.tipo !== 'ESTADO_FINAL');
    const reemplazos = eventosReales.filter(e => e.tipo === 'REEMPLAZO');
    const conFecha = eventosReales.filter(e => e.fecha);
    const ultimo = conFecha.length ? conFecha[conFecha.length - 1] : null;

    return {
        rodeo_id: rodeo.id,
        fecha: rodeo.fecha,
        duracion_dias: rodeo.duracion_dias || 1,
        club: rodeo.club,
        asociacion: rodeo.asociacion,
        tipo_rodeo: rodeo.tipo_rodeo_nombre || null,
        clasificacion: rodeo.tipos_rodeo?.clasificaciones_designacion?.nombre || null,
        propuesta_aplicada_id: detAplicado ? detAplicado.propuesta_id : null,
        propuesta_referencia_id: detReferencia ? detReferencia.propuesta_id : null,
        propuestas_no_aplicadas: [...new Set(linea.detalles.filter(d => !detAplicado || d.propuesta_id !== detAplicado.propuesta_id).map(d => d.propuesta_id))].length,
        configuracion_version: prop?.configuracion_designacion_versiones?.numero_version ?? null,
        jurado_propuesto_original: detReferencia ? (nombre(detReferencia.jurado_id_propuesto) || 'Sin candidato del motor') : 'Sin propuesta del motor',
        jurado_confirmado_admin: confirmado || 'Sin propuesta del motor',
        decision_borrador: decision ? decision.etiqueta : 'Sin propuesta del motor',
        jurado_vigente: vig.length ? vig.map(a => nombre(a.usuario_pagado_id)).join(' / ') : 'Sin jurado vigente',
        // Mismos jurados que los textos de arriba, con su categoría y la fuente
        // de esa categoría (DESIGNACION / MOTOR / ACTUAL) — solo presentación.
        jurado_propuesto_original_jurado: detReferencia ? juradoConCat(detReferencia.jurado_id_propuesto, { detalle: detReferencia }) : null,
        jurado_confirmado_admin_jurado: confirmadoJurado,
        jurado_confirmado_admin_nota: confirmadoNota,
        jurado_vigente_jurados: vig.map(a => juradoConCat(a.usuario_pagado_id, { asignacion: a })),
        estado_actual: linea.eventos[linea.eventos.length - 1].estado_resultante,
        modificaciones_administrativas: eventosReales.filter(e => e.tipo === 'MODIFICACION_BORRADOR').length,
        reemplazos_posteriores: reemplazos.length,
        motivo_ultimo_reemplazo: reemplazos.length ? (reemplazos[reemplazos.length - 1].motivo || SIN_INFO) : null,
        fecha_ultimo_cambio: ultimo ? ultimo.fecha : null,
    };
}

// ─── Hoja 3: propuesta original del motor (snapshot real) ─────────────────
function filasPropuestaOriginal(rodeos, fuentes) {
    const rodeoPorId = porId(rodeos);
    const propuestaPorId = porId(fuentes.propuestas);
    const aplicados = new Set(fuentes.asignaciones.map(a => a.propuesta_detalle_id).filter(Boolean).map(String));
    const evidenciaDe = indexarEvidencia(fuentes);
    return fuentes.detalles
        .filter(d => rodeoPorId.has(String(d.rodeo_id)))
        .map(d => {
            const p = propuestaPorId.get(String(d.propuesta_id)) || {};
            const r = rodeoPorId.get(String(d.rodeo_id));
            const jp = d.explicacion_json?.jurado_propuesto || null;
            const checks = jp?.checks ? Object.entries(jp.checks).map(([k, v]) => `${k}: ${v ? 'sí' : 'no'}`).join('; ') : null;
            const advMotor = (d.metricas_json?.advertencias_aceptadas || []).map(a => a.tipo).filter(Boolean);
            const rend = jp?.rendimiento_temporada;
            return {
                fecha_generacion: p.fecha_corte_tecnica || p.created_at || null,
                propuesta_id: d.propuesta_id,
                propuesta_aplicada: aplicados.has(String(d.id)),
                configuracion_version: p.configuracion_designacion_versiones?.numero_version ?? null,
                motor: p.motor_usado || null,
                rodeo_id: d.rodeo_id,
                rodeo: r ? `${r.club} (${r.fecha})` : d.rodeo_id,
                jurado_propuesto: d.jurado_id_propuesto ? (fuentes.jurados.get(String(d.jurado_id_propuesto)) || jp?.nombre || d.jurado_id_propuesto) : 'Sin candidato del motor',
                categoria: jp?.categoria ?? null, // snapshot del motor (histórico)
                comuna: jp?.comuna_canonica ?? null,
                distancia_km: jp?.distancia_km ?? null,
                nota_tecnica: rend ? (rend.ultima_nota ?? rend.promedio_jurado ?? null) : null,
                criterios: checks,
                advertencias: advMotor.length ? advMotor.join(', ') : null,
                relajaciones: (jp?.optimizacion_global_relajaciones || []).join(', ') || null,
                cobertura: p.resultado_cobertura_json ? `${p.resultado_cobertura_json.cobertura_obtenida ?? '—'}/${p.resultado_cobertura_json.total_cupos ?? '—'} (${p.resultado_cobertura_json.estado_busqueda || '—'})` : null,
                estado_revision_actual: d.estado_revision,
                decision_administrativa: clasificarDecisionFila(d, evidenciaDe(d.id)).etiqueta,
            };
        })
        .sort((a, b) => String(a.fecha_generacion || '').localeCompare(String(b.fecha_generacion || '')) || String(a.rodeo).localeCompare(String(b.rodeo), 'es'));
}

function juradoEnEvento(e, juradoId) {
    const id = String(juradoId);
    return [e.jurado_anterior?.id, e.jurado_nuevo?.id].filter(Boolean).map(String).includes(id);
}

// ─── Punto de entrada: pantalla y Excel usan exactamente esto ─────────────
async function obtenerHistorialDesignaciones(filtros = {}) {
    const rodeos = await seleccionarRodeos(filtros);
    const fuentes = await cargarFuentes(rodeos.map(r => r.id));

    const resultado = [];
    for (const rodeo of rodeos) {
        const linea = construirLineaTiempo(rodeo, fuentes);
        let eventos = linea.eventos;
        if (filtros.jurado_id) {
            const participa = eventos.some(e => juradoEnEvento(e, filtros.jurado_id)) ||
                linea.detalles.some(d => [d.jurado_id_propuesto, d.jurado_id_seleccionado].map(String).includes(String(filtros.jurado_id)));
            if (!participa) continue;
        }
        const filtrarEventos = !!(filtros.tipo_movimiento || filtros.origen);
        if (filtrarEventos) {
            const filtrados = eventos.filter(e =>
                (!filtros.tipo_movimiento || e.tipo === filtros.tipo_movimiento) &&
                (!filtros.origen || e.origen === filtros.origen));
            if (filtrados.length === 0) continue;
            eventos = filtrados;
        }
        resultado.push({
            rodeo: { id: rodeo.id, fecha: rodeo.fecha, duracion_dias: rodeo.duracion_dias || 1, club: rodeo.club, asociacion: rodeo.asociacion, tipo_rodeo: rodeo.tipo_rodeo_nombre || null, clasificacion: rodeo.tipos_rodeo?.clasificaciones_designacion?.nombre || null },
            resumen: resumirRodeo(rodeo, linea, fuentes),
            eventos,
        });
    }
    const idsIncluidos = new Set(resultado.map(r => String(r.rodeo.id)));
    const propuestaOriginal = filasPropuestaOriginal(rodeos.filter(r => idsIncluidos.has(String(r.id))), fuentes)
        .filter(f => !filtros.propuesta_id || String(f.propuesta_id) === String(filtros.propuesta_id));

    return {
        filtros,
        rodeos: resultado,
        propuesta_original: propuestaOriginal,
        totales: {
            rodeos: resultado.length,
            eventos: resultado.reduce((s, r) => s + r.eventos.filter(e => e.tipo !== 'ESTADO_FINAL').length, 0),
        },
    };
}

module.exports = {
    obtenerHistorialDesignaciones,
    construirLineaTiempo,
    resumirRodeo,
    filasPropuestaOriginal,
    seleccionarRodeos,
    cargarFuentes,
    TIPOS,
    ORIGEN,
    SIN_INFO,
    FUENTE_CATEGORIA,
    categoriaJurado,
};
