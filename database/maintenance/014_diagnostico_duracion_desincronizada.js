// ═════════════════════════════════════════════════════════════════════════
// 014_diagnostico_duracion_desincronizada.js
//
// Diagnóstico de SOLO LECTURA para el bug "ANCUD/CHILOÉ" (jurado Augusto
// César González Álvarez): al editar un rodeo ya designado, `rodeos.
// duracion_dias` se actualizaba pero `asignaciones.duracion_dias_aplicada`
// (copia congelada al crear la designación, usada para calcular
// `pago_base_calculado`) nunca se volvía a sincronizar. La corrección
// transaccional (migración 091: actualizar_tipo_rodeo_y_sincronizar_
// asignaciones / reparar_sincronizacion_asignaciones_rodeo) ya soluciona
// esto para EDICIONES FUTURAS — este script detecta si el mismo problema
// (u otro que produzca el mismo síntoma) afectó registros YA existentes,
// antes de aplicar esa corrección.
//
// Solo hace SELECT — nunca INSERT, UPDATE, DELETE ni ALTER ni RPC
// (verificado en esta misma revisión: no existe ninguna llamada
// .update()/.insert()/.delete()/.rpc() en este archivo). No modifica nada
// en producción; solo imprime un listado para revisión manual del
// administrador.
//
// Criterio de detección (dos condiciones independientes, cualquiera de las
// dos marca el registro como desincronizado):
//   (a) duracion_dias_aplicada de la asignación ≠ duracion_dias vigente del
//       rodeo — el síntoma reportado originalmente (ANCUD).
//   (b) pago_base_calculado ≠ round(valor_diario_aplicado × duracion_dias
//       vigente del rodeo) — detecta además cualquier caso donde el pago
//       esté desalineado aunque la duración aplicada ya coincida (p. ej. si
//       algún otro camino de escritura tocó el pago sin tocar la duración).
// Nunca se consideran afectadas las asignaciones de IMPORTACIÓN HISTÓRICA
// (asignaciones.importacion_id → importaciones.tipo = 'historico_rodeos') —
// su pago es 0 intencionalmente, ya liquidado fuera del sistema. Ver nota de
// "protección de pagos históricos" en la migración 091: este es el ÚNICO
// mecanismo de protección que existe en el sistema hoy — no hay ningún otro
// concepto de "pago cerrado/liquidado" en el esquema actual.
const { TIPO_IMPORTACION_HISTORICA } = require('../../backend/src/services/asignacionHistorica');

function formatoCLP(n) {
    return '$' + Math.round(n || 0).toLocaleString('es-CL');
}

async function main() {
    const supabase = require('../../backend/src/config/supabase');

    const { data: asigs, error: errA } = await supabase
        .from('asignaciones')
        .select(`
            id, rodeo_id, usuario_pagado_id, tipo_persona, importacion_id,
            duracion_dias_aplicada, valor_diario_aplicado, pago_base_calculado, categoria_aplicada,
            rodeos!inner(club, asociacion, fecha, tipo_rodeo_nombre, duracion_dias),
            usuarios_pagados(nombre_completo, categoria)
        `)
        .eq('estado', 'activo');
    if (errA) throw new Error('Error leyendo asignaciones: ' + errA.message);

    const conDiagnostico = (asigs || [])
        .filter(a => a.rodeos)
        .map(a => {
            const duracionVigente = a.rodeos.duracion_dias;
            const pagoEsperado = Math.round((a.valor_diario_aplicado || 0) * duracionVigente);
            const duracionDesajustada = a.duracion_dias_aplicada !== duracionVigente;
            const pagoDesajustado = (a.pago_base_calculado || 0) !== pagoEsperado;
            return {
                asignacion: a,
                duracionVigente,
                pagoEsperado,
                diferencia: pagoEsperado - (a.pago_base_calculado || 0),
                desincronizada: duracionDesajustada || pagoDesajustado,
                duracionDesajustada,
                pagoDesajustado
            };
        });

    const desincronizadas = conDiagnostico.filter(d => d.desincronizada);

    if (desincronizadas.length === 0) {
        console.log('\n=== Diagnóstico duración/pago desincronizados — SOLO LECTURA ===');
        console.log('Total de asignaciones activas revisadas: ' + (asigs || []).length);
        console.log('No se encontraron asignaciones con duración o pago desincronizados respecto al rodeo vigente.');
        console.log('\n(Diagnóstico de solo lectura — no se escribió nada.)');
        return;
    }

    // Separar históricas importadas (pago 0 intencional, no es un desajuste
    // a corregir) del resto, en un único query por lote (nunca uno por fila).
    const idsImportacion = [...new Set(desincronizadas.map(d => d.asignacion.importacion_id).filter(Boolean))];
    let idsHistoricos = new Set();
    if (idsImportacion.length > 0) {
        const { data: imports, error: errI } = await supabase
            .from('importaciones')
            .select('id')
            .in('id', idsImportacion)
            .eq('tipo', TIPO_IMPORTACION_HISTORICA);
        if (errI) throw new Error('Error verificando importaciones históricas: ' + errI.message);
        idsHistoricos = new Set((imports || []).map(i => i.id));
    }

    const historicas = desincronizadas.filter(d => d.asignacion.importacion_id && idsHistoricos.has(d.asignacion.importacion_id));
    const porCorregir = desincronizadas.filter(d => !(d.asignacion.importacion_id && idsHistoricos.has(d.asignacion.importacion_id)));

    console.log('\n=== Diagnóstico duración/pago desincronizados — SOLO LECTURA ===');
    console.log('Total de asignaciones activas revisadas: ' + (asigs || []).length);
    console.log('Desincronizadas (duración y/o pago distinto del esperado): ' + desincronizadas.length);
    console.log('  De las cuales son importación histórica (pago 0 intencional, NO requieren corrección): ' + historicas.length);
    console.log('  Requieren revisión/corrección: ' + porCorregir.length);

    if (porCorregir.length > 0) {
        console.log('\n--- Asignaciones que requieren revisión manual ---');
        console.log('(Rodeo | Asociación | Fecha | Jurado/Delegado | Duración actual (rodeo) | Duración aplicada (asignación) | Monto registrado | Monto esperado | Diferencia)\n');
        const rodeosAfectados = new Set();
        for (const d of porCorregir) {
            const a = d.asignacion;
            const r = a.rodeos;
            const persona = a.usuarios_pagados?.nombre_completo || a.usuario_pagado_id;
            rodeosAfectados.add(a.rodeo_id);
            console.log(
                `  [asignacion=${a.id}] [rodeo=${a.rodeo_id}] ${r.club} (${r.asociacion}) ${r.fecha} — ${persona} (${a.tipo_persona}, cat. ${a.categoria_aplicada || '-'})\n` +
                `      Rodeo vigente: "${r.tipo_rodeo_nombre}", duración actual = ${d.duracionVigente} día(s)\n` +
                `      Asignación guardada: duración aplicada = ${a.duracion_dias_aplicada}${d.duracionDesajustada ? '  ⚠ DISTINTA de la vigente' : ''}, monto registrado = ${formatoCLP(a.pago_base_calculado)}\n` +
                `      Monto esperado (valor_diario_aplicado sin cambios × duración vigente) = ${formatoCLP(d.pagoEsperado)}${d.pagoDesajustado ? '  ⚠ DISTINTO del registrado' : ''}\n` +
                `      Diferencia (esperado − registrado) = ${formatoCLP(d.diferencia)}`
            );
        }
        console.log(`\nRodeos distintos afectados: ${rodeosAfectados.size}`);
        console.log('Procedimiento recomendado para corregir cada uno (con autorización explícita, uno por uno):');
        console.log('  supabase.rpc(\'reparar_sincronizacion_asignaciones_rodeo\', { p_rodeo_id, p_actor_id, p_actor_tipo: \'administrador\', p_ip_address: null })');
        console.log('  — o bien POST /api/admin/rodeos/:id/reparar-sincronizacion-asignaciones (requiere la migración 091 ya aplicada).');
    }

    console.log('\n(Diagnóstico de solo lectura — no se escribió nada. No se realizó ninguna corrección de datos.)');
}

if (require.main === module) {
    main().catch(err => { console.error('Error en el diagnóstico:', err.message); process.exit(1); });
}

module.exports = { main };
