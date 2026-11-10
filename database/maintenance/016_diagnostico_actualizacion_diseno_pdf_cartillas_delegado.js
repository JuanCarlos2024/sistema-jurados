// ═════════════════════════════════════════════════════════════════════════
// 016_diagnostico_actualizacion_diseno_pdf_cartillas_delegado.js
//
// Diagnóstico — PRIMER PASO antes de evaluar actualizar el diseño visual
// (logo + portada en bloques, Nov-2026) de las Cartillas Digitales de
// Delegado YA ENVIADAS (cartillas_delegado_versiones). NO tiene ningún modo
// --aplicar: este script NUNCA escribe nada, bajo ninguna bandera — mismo
// patrón que 013/014 (diagnóstico puro, separado de la acción).
//
// REQUIERE que la migración 096_formato_visual_actualizado_pdf_cartilla_
// delegado.sql ya esté aplicada (agrega la columna storage_path_pdf_
// rediseno) — si no lo está, Supabase devuelve un error de columna
// inexistente al consultarla; el script no hace nada más, no corrompe nada.
//
// QUÉ REPORTA (ver database/maintenance/017_actualizar_diseno_pdf_cartillas_
// delegado_historicas.js para el script que SÍ puede escribir, aparte):
//   1. Total de versiones históricas (cartillas_delegado_versiones).
//   2. Cuántas tienen un PDF original (storage_path_pdf) — son las únicas
//      elegibles para actualizar el diseño.
//   3. EXCEPCIONES: versiones SIN storage_path_pdf — nunca se les puede
//      regenerar fielmente un PDF "con diseño nuevo" de algo que nunca se
//      generó; se listan aparte, nunca se inventa un PDF para ellas.
//   4. De las elegibles, cuántas YA tienen storage_path_pdf_rediseno
//      (ya actualizadas — un reintento de 017 las salta automáticamente)
//      vs. cuántas están pendientes.
//   5. Desglose de las pendientes por estado_version (enviada/reenviada) y
//      por modalidad del delegado (Asociación vs Rentado, vía
//      cartillas_delegado.delegado_asociacion_id).
//   6. Una muestra representativa (primeras N pendientes, por antigüedad)
//      para probar el modo --aplicar de 017 contra casos reales puntuales
//      antes de cualquier ejecución masiva — pedido explícito del usuario:
//      "comprobar los resultados con cartillas representativas" antes de
//      un proceso masivo.
//
// NUNCA toca: cartillas_jurado, rodeo_adjuntos, notas, evaluaciones, pagos,
// designaciones, permisos, historial de versiones — ninguna de esas tablas
// se consulta siquiera aquí.
// ═════════════════════════════════════════════════════════════════════════
const MUESTRA = 5;

async function main() {
    const supabase = require('../../backend/src/config/supabase');

    const { data: versiones, error } = await supabase
        .from('cartillas_delegado_versiones')
        .select('id, cartilla_delegado_id, numero_version, estado_version, storage_path_pdf, storage_path_pdf_rediseno, enviada_en')
        .order('enviada_en', { ascending: true });

    if (error) {
        if (/storage_path_pdf_rediseno/.test(error.message || '')) {
            console.error('ERROR: la columna storage_path_pdf_rediseno no existe todavía.');
            console.error('Debe aplicarse primero la migración 096_formato_visual_actualizado_pdf_cartilla_delegado.sql.');
            process.exitCode = 1;
            return;
        }
        throw new Error('Error leyendo cartillas_delegado_versiones: ' + error.message);
    }

    const total = (versiones || []).length;
    const sinOriginal = (versiones || []).filter(v => !v.storage_path_pdf);
    const elegibles = (versiones || []).filter(v => !!v.storage_path_pdf);
    const yaActualizadas = elegibles.filter(v => !!v.storage_path_pdf_rediseno);
    const pendientes = elegibles.filter(v => !v.storage_path_pdf_rediseno);

    console.log('\n=== Diagnóstico: actualización de diseño visual del PDF — Cartilla Digital de Delegado ===');
    console.log(`Total de versiones históricas: ${total}`);
    console.log(`Con PDF original (elegibles):  ${elegibles.length}`);
    console.log(`SIN PDF original (excepción, nunca se les puede regenerar): ${sinOriginal.length}`);
    console.log(`Ya actualizadas (storage_path_pdf_rediseno ya adjunto):     ${yaActualizadas.length}`);
    console.log(`Pendientes de actualizar:                                   ${pendientes.length}\n`);

    if (sinOriginal.length) {
        console.log('--- EXCEPCIONES: sin PDF original (no se puede regenerar fielmente) ---');
        sinOriginal.slice(0, 20).forEach(v => console.log(`  versión ${v.id} (cartilla ${v.cartilla_delegado_id}, v${v.numero_version}, ${v.estado_version})`));
        if (sinOriginal.length > 20) console.log(`  ... y ${sinOriginal.length - 20} más.`);
        console.log('');
    }

    if (pendientes.length) {
        const porEstado = {};
        pendientes.forEach(v => { porEstado[v.estado_version] = (porEstado[v.estado_version] || 0) + 1; });
        console.log('--- Pendientes, por estado_version ---');
        Object.entries(porEstado).forEach(([estado, n]) => console.log(`  ${estado}: ${n}`));

        // Modalidad del delegado (Asociación vs Rentado) — join liviano,
        // solo para el reporte; no se usa para decidir qué se actualiza.
        const idsCartillas = [...new Set(pendientes.map(v => v.cartilla_delegado_id))];
        const { data: cartillas } = await supabase
            .from('cartillas_delegado')
            .select('id, delegado_asociacion_id')
            .in('id', idsCartillas);
        const modalidadPorCartilla = new Map((cartillas || []).map(c => [c.id, c.delegado_asociacion_id ? 'Delegado de Asociación' : 'Delegado Rentado']));
        const porModalidad = {};
        pendientes.forEach(v => {
            const m = modalidadPorCartilla.get(v.cartilla_delegado_id) || 'Desconocida';
            porModalidad[m] = (porModalidad[m] || 0) + 1;
        });
        console.log('\n--- Pendientes, por modalidad ---');
        Object.entries(porModalidad).forEach(([modalidad, n]) => console.log(`  ${modalidad}: ${n}`));

        console.log(`\n--- Muestra representativa para probar 017 --aplicar --solo-ids=... (${Math.min(MUESTRA, pendientes.length)} de ${pendientes.length}) ---`);
        pendientes.slice(0, MUESTRA).forEach(v => console.log(`  ${v.id}  (cartilla ${v.cartilla_delegado_id}, v${v.numero_version}, ${v.estado_version}, enviada ${v.enviada_en})`));
    }

    console.log('\n(Diagnóstico de solo lectura — este script nunca escribe nada. Para actualizar el diseño, usar 017 con --aplicar, primero sobre la muestra representativa con --solo-ids.)');
}

if (require.main === module) {
    main().catch(err => { console.error(err); process.exitCode = 1; });
}
module.exports = { main };
