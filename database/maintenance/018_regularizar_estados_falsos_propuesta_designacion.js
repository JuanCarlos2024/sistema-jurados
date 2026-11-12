// ═════════════════════════════════════════════════════════════════════════
// 018_regularizar_estados_falsos_propuesta_designacion.js
//
// Diagnóstico de estados administrativos FALSOS en una Propuesta de
// Designación (causa: hasta el 11/11/2026, POST /propuestas reclasificaba
// filas PENDIENTE como ACEPTADO/MOTOR o MODIFICADO/MANUAL_CON_ADVERTENCIA al
// guardar, sin acción administrativa — corregido en el código con
// decidirEstadoAlGuardar).
//
// La clasificación vive en backend/src/services/regularizacionEstadosPropuesta.js
// + evidenciaDecisionPropuesta.js (puras, con pruebas). Separa, por fila:
//   1. clasificaciones automáticas potencialmente erróneas (sin evidencia);
//   2. modificaciones administrativas comprobadas (bitácora/auditoría);
//   3. aplicaciones reales posteriores (asignaciones vinculadas);
//   4. anulaciones y publicaciones de esas asignaciones.
//
// MODO POR DEFECTO: SOLO LECTURA (DRY-RUN). No escribe nada:
//
//   node database/maintenance/018_regularizar_estados_falsos_propuesta_designacion.js \
//     --propuesta-id=<uuid>
//
// BLOQUEO DE SEGURIDAD (sin parámetro para saltarlo): si la propuesta ya
// tiene CUALQUIER asignación real vinculada (activa o anulada) o no está en
// BORRADOR, --aplicar se rechaza siempre. Caso real: la propuesta
// 27c6bc5d-3333-4819-a0a1-80fe1cd9abe4 ya fue aplicada (25 asignaciones) —
// su interpretación se corrige en pantalla/Historial/Excel, sin tocar datos.
//
// Solo para un BORRADOR nunca aplicado, y con aprobación explícita:
//   ... --propuesta-id=<uuid> --aplicar --actor-email=<email admin> --motivo="..."
// Escritura: UPDATE condicional por fila (solo si sigue en el estado
// diagnosticado) + auditoría 'regularizar' por fila. Se revalida, justo antes
// de escribir, que la propuesta siga sin asignaciones. Idempotente.
//
// NUNCA toca: jurado_id_propuesto, explicacion_json, la propuesta,
// asignaciones, bitácora, otras propuestas.
// ═════════════════════════════════════════════════════════════════════════
const path = require('path');
const BACKEND = path.join(__dirname, '..', '..', 'backend');
process.chdir(BACKEND);
const supabase = require(path.join(BACKEND, 'src/config/supabase'));
const {
    CATEGORIA, evaluarBloqueoEscritura, clasificarFilasRegularizacion, metricasRegularizadas, resumenClasificacion,
} = require(path.join(BACKEND, 'src/services/regularizacionEstadosPropuesta'));

function arg(nombre) {
    const a = process.argv.find(x => x === `--${nombre}` || x.startsWith(`--${nombre}=`));
    if (!a) return null;
    return a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
}

async function leerTodo(construir) {
    const filas = [];
    for (let desde = 0; ; desde += 900) {
        const { data, error } = await construir().range(desde, desde + 899);
        if (error) throw new Error(error.message);
        filas.push(...(data || []));
        if (!data || data.length < 900) break;
    }
    return filas;
}

async function porLotes(ids, construir) {
    const out = [];
    for (let i = 0; i < ids.length; i += 150) out.push(...await leerTodo(() => construir(ids.slice(i, i + 150))));
    return out;
}

async function cargarAsignaciones(ids) {
    return ids.length ? porLotes(ids, lote => supabase.from('asignaciones')
        .select('id, propuesta_detalle_id, rodeo_id, usuario_pagado_id, estado, estado_designacion, publicado').in('propuesta_detalle_id', lote).order('id')) : [];
}

async function main() {
    const propuestaId = arg('propuesta-id');
    const aplicar = arg('aplicar') === true;
    if (!propuestaId || propuestaId === true) throw new Error('Falta --propuesta-id=<uuid>');

    const { data: propuesta, error: errP } = await supabase.from('propuestas_designacion')
        .select('id, estado, created_at, configuracion_version_id, motor_usado, fecha_corte_tecnica, resultado_cobertura_json')
        .eq('id', propuestaId).maybeSingle();
    if (errP) throw new Error(errP.message);
    if (!propuesta) throw new Error('La propuesta no existe');

    const detalles = await leerTodo(() => supabase.from('propuestas_designacion_detalle')
        .select('id, rodeo_id, jurado_id_propuesto, jurado_id_seleccionado, estado_revision, origen_seleccion, metricas_json, rodeos(club, fecha)')
        .eq('propuesta_id', propuestaId).order('id'));
    const ids = detalles.map(d => d.id);
    const bitacora = ids.length ? await porLotes(ids, l => supabase.from('bitacora_designaciones').select('id, propuesta_detalle_id, tipo_movimiento').in('propuesta_detalle_id', l).order('id')) : [];
    const auditoria = ids.length ? await porLotes(ids, l => supabase.from('auditoria').select('id, tabla, registro_id, accion, datos_nuevos').eq('tabla', 'propuestas_designacion_detalle').in('registro_id', l).order('id')) : [];
    const asignaciones = await cargarAsignaciones(ids);

    const juradoIds = [...new Set(detalles.flatMap(d => [d.jurado_id_propuesto, d.jurado_id_seleccionado]).filter(Boolean))];
    const jurados = juradoIds.length ? await porLotes(juradoIds, l => supabase.from('usuarios_pagados').select('id, nombre_completo').in('id', l).order('id')) : [];
    const nombre = new Map(jurados.map(j => [j.id, j.nombre_completo]));

    const filas = clasificarFilasRegularizacion({ propuesta, detalles, bitacora, auditoria, asignaciones });
    const resumen = resumenClasificacion(filas, { propuesta, asignaciones });
    const porDetalle = new Map(detalles.map(d => [d.id, d]));
    const tiposBitacora = bitacora.reduce((m, b) => { m[b.tipo_movimiento] = (m[b.tipo_movimiento] || 0) + 1; return m; }, {});

    console.log(`Propuesta ${propuesta.id} · estado ${propuesta.estado} · creada ${propuesta.created_at} · motor ${propuesta.motor_usado}`);
    console.log(`Filas: ${resumen.total} · bitácora: ${JSON.stringify(tiposBitacora)} · auditorías de fila: ${auditoria.length}`);
    console.log(`Asignaciones reales vinculadas: ${resumen.asignaciones.total} (activas ${resumen.asignaciones.activas}, publicadas ${resumen.asignaciones.publicadas}, anuladas ${resumen.asignaciones.anuladas}) · filas aplicadas: ${resumen.filas_aplicadas}`);
    console.log('\nClasificación de la decisión del borrador:');
    Object.entries(resumen.por_categoria).forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}  ${CATEGORIA[k]}`));
    console.log(`       (clasificación automática: ACEPTADO ${resumen.clasificacion_automatica_aceptado}, MODIFICADO mismo jurado ${resumen.clasificacion_automatica_modificado})`);

    const fila = f => {
        const d = porDetalle.get(f.detalle_id);
        return {
            rodeo: `${d.rodeos?.club || f.rodeo_id} (${d.rodeos?.fecha || '—'})`,
            estado: `${f.antes.estado_revision}/${f.antes.origen_seleccion || '—'}`,
            propuesto: nombre.get(f.antes.jurado_id_propuesto) || f.antes.jurado_id_propuesto || '—',
            seleccionado: nombre.get(f.antes.jurado_id_seleccionado) || f.antes.jurado_id_seleccionado || '—',
            evidencia: f.fuentes_evidencia.join('+') || '—',
            aplicada: f.aplicacion.aplicada ? `sí (${f.aplicacion.activas} activa, ${f.aplicacion.publicadas} publ., ${f.aplicacion.anuladas} anul.)` : 'no',
            tratamiento: f.tratamiento,
        };
    };
    for (const k of Object.keys(CATEGORIA)) {
        const grupo = filas.filter(f => f.categoria === k);
        if (!grupo.length) continue;
        console.log(`\n── ${CATEGORIA[k]} (${grupo.length})`);
        console.table(grupo.map(fila));
    }

    if (resumen.bloqueo.bloqueada) {
        console.log('\n⛔ ESCRITURA BLOQUEADA para esta propuesta:');
        resumen.bloqueo.motivos.forEach(m => console.log('   - ' + m));
    } else {
        console.log(`\nFilas que se corregirían con aprobación: ${resumen.a_corregir} (ACEPTADO→PENDIENTE ${resumen.aceptado_a_pendiente}, MODIFICADO→PENDIENTE ${resumen.modificado_a_pendiente}).`);
    }

    if (!aplicar) {
        console.log('\nDRY-RUN: no se escribió nada.');
        return;
    }
    if (resumen.bloqueo.bloqueada) {
        console.error('\n--aplicar RECHAZADO: la propuesta está bloqueada para escritura (ver motivos). No existe parámetro para omitir este control.');
        process.exitCode = 2;
        return;
    }

    const actorEmail = arg('actor-email');
    const motivo = arg('motivo');
    if (!actorEmail || actorEmail === true || !motivo || motivo === true) throw new Error('--aplicar exige --actor-email y --motivo');
    const { data: admins, error: errA } = await supabase.from('administradores').select('id, email').eq('email', actorEmail);
    if (errA) throw new Error(errA.message);
    if (!admins || admins.length !== 1) throw new Error(`--actor-email no resuelve a exactamente un administrador (encontrados: ${admins?.length || 0})`);
    const actorId = admins[0].id;

    // Revalidación inmediatamente antes de escribir: nadie aplicó la propuesta entretanto.
    const { data: propAhora } = await supabase.from('propuestas_designacion').select('id, estado').eq('id', propuestaId).maybeSingle();
    const revalidacion = evaluarBloqueoEscritura({ propuesta: propAhora, asignaciones: await cargarAsignaciones(ids) });
    if (revalidacion.bloqueada) {
        console.error('\n--aplicar RECHAZADO en la revalidación previa a escribir:', revalidacion.motivos.join(' | '));
        process.exitCode = 2;
        return;
    }

    let aplicadas = 0, omitidas = 0;
    for (const f of filas.filter(x => x.corregir)) {
        const d = porDetalle.get(f.detalle_id);
        const { data: upd, error } = await supabase.from('propuestas_designacion_detalle')
            .update({
                estado_revision: 'PENDIENTE', origen_seleccion: null, jurado_id_seleccionado: null,
                metricas_json: metricasRegularizadas(d.metricas_json, f, { actorId, motivo }), updated_at: new Date().toISOString(),
            })
            .eq('id', f.detalle_id)
            .eq('estado_revision', f.antes.estado_revision)
            .eq('jurado_id_seleccionado', f.antes.jurado_id_seleccionado)
            .select('id');
        if (error) throw new Error(`Fila ${f.detalle_id}: ${error.message}`);
        if (!upd || upd.length === 0) { omitidas++; console.log(`Omitida (cambió desde el diagnóstico): ${f.detalle_id}`); continue; }
        await supabase.from('auditoria').insert({
            tabla: 'propuestas_designacion_detalle', registro_id: f.detalle_id, accion: 'regularizar',
            datos_anteriores: f.antes, datos_nuevos: { ...f.despues, motivo },
            actor_id: String(actorId), actor_tipo: 'administrador',
            descripcion: `Regularización de estado falso: ${f.antes.estado_revision}/${f.antes.origen_seleccion || '—'} → PENDIENTE (no hubo acción administrativa). Jurado propuesto sin cambios.`,
        });
        aplicadas++;
    }
    console.log(`\nAplicadas: ${aplicadas} · omitidas: ${omitidas}`);
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
