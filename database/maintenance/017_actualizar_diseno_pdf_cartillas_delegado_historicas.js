// ═════════════════════════════════════════════════════════════════════════
// 017_actualizar_diseno_pdf_cartillas_delegado_historicas.js
//
// Actualiza el PDF de versiones históricas de la Cartilla Digital de
// Delegado (cartillas_delegado_versiones) al diseño visual nuevo (logo +
// portada en bloques, Nov-2026) — SIN tocar nunca el PDF original
// (storage_path_pdf): usa la columna aparte storage_path_pdf_rediseno y la
// RPC actualizar_diseno_pdf_version_cartilla_delegado, ambas de la
// migración 096. Reutiliza exactamente la misma lógica que el endpoint
// administrativo POST /admin/cartillas-delegado/version/:id/actualizar-
// diseno-pdf (backend/src/routes/admin/cartillas-delegado.js) — no
// reimplementa un mecanismo paralelo.
//
// REQUIERE la migración 096 ya aplicada. Ejecutar primero el diagnóstico
// (016_diagnostico_actualizacion_diseno_pdf_cartillas_delegado.js) para ver
// cuántas versiones son elegibles, cuántas son excepción y una muestra
// representativa.
//
// MODO POR DEFECTO: SOLO LECTURA (reporta qué haría, no escribe nada). Para
// aplicar, se EXIGEN explícitamente --aplicar, --actor-email y --motivo:
//
//   node database/maintenance/017_actualizar_diseno_pdf_cartillas_delegado_historicas.js \
//     --aplicar --actor-email=jcreyes@ferochi.cl \
//     --motivo="Actualización del formato visual institucional (logo + rediseño Nov-2026)" \
//     --solo-ids=<id1>,<id2>
//
// --solo-ids=<id1>,<id2>,...   Limita la ejecución a esas versiones
//                              puntuales (ids de cartillas_delegado_
//                              versiones) — pedido explícito del usuario:
//                              probar con cartillas representativas ANTES
//                              de cualquier ejecución masiva. Sin este
//                              parámetro, --aplicar actúa sobre TODAS las
//                              pendientes — úsese con cautela y solo tras
//                              revisar el diagnóstico y la muestra.
//
// --actor-email=<email>  Se resuelve en vivo contra `administradores`
//                         (nunca se asume un UUID fijo — mismo criterio que
//                         database/maintenance/015) — aborta sin escribir
//                         nada si no resuelve a EXACTAMENTE un admin.
//
// QUÉ HACE, por cada versión objetivo:
//   1. Vuelve a verificar que tenga storage_path_pdf (PDF original) y que
//      NO tenga ya storage_path_pdf_rediseno (evita reprocesar — reintentar
//      el script es seguro, las ya actualizadas se saltan).
//   2. Lee el rodeo EN VIVO (igual que el endpoint) solo para nombrar/
//      tipificar el documento — nunca modifica rodeos.
//   3. Genera el PDF con generarCartillaDelegadoPDF(snapshot, rodeo) — el
//      MISMO snapshot inmutable de la versión, nunca datos de otra versión
//      ni datos en vivo de la cartilla actual.
//   4. Sube el PDF a una ruta NUEVA (nunca pisa storage_path_pdf).
//   5. Llama a actualizar_diseno_pdf_version_cartilla_delegado con el
//      motivo y el actor resuelto — la RPC deja su propia auditoría.
//   6. Si algo falla para una versión puntual (snapshot incompleto, error
//      de Storage, etc.), se reporta como EXCEPCIÓN y se continúa con las
//      demás — nunca se inventa información para completar un PDF.
//
// NUNCA toca: storage_path_pdf, snapshot, numero_version, estado_version,
// enviada_en/por, cartillas_jurado, rodeo_adjuntos, notas, evaluaciones,
// pagos, designaciones, permisos.
// ═════════════════════════════════════════════════════════════════════════
function leerArg(nombre) {
    const prefijo = `--${nombre}=`;
    const arg = process.argv.find(a => a.startsWith(prefijo));
    return arg ? arg.slice(prefijo.length) : null;
}

async function main() {
    const aplicar = process.argv.includes('--aplicar');
    const soloIds = leerArg('solo-ids');
    const idsFiltro = soloIds ? soloIds.split(',').map(s => s.trim()).filter(Boolean) : null;
    const actorEmail = leerArg('actor-email');
    const motivo = leerArg('motivo') || 'Actualización del formato visual institucional (logo + rediseño Nov-2026)';

    const supabase = require('../../backend/src/config/supabase');
    const { generarCartillaDelegadoPDF } = require('../../backend/src/services/cartilla-delegado-pdf');

    let query = supabase
        .from('cartillas_delegado_versiones')
        .select('id, cartilla_delegado_id, numero_version, snapshot, storage_path_pdf, storage_path_pdf_rediseno')
        .not('storage_path_pdf', 'is', null)
        .is('storage_path_pdf_rediseno', null);
    if (idsFiltro) query = query.in('id', idsFiltro);

    const { data: versiones, error } = await query;
    if (error) throw new Error('Error leyendo cartillas_delegado_versiones: ' + error.message);

    console.log(`\n=== Actualización de diseño del PDF — ${aplicar ? 'APLICANDO CAMBIOS' : 'SOLO LECTURA (dry-run)'} ===`);
    console.log(`Versiones objetivo (elegibles y pendientes${idsFiltro ? ', filtradas por --solo-ids' : ''}): ${(versiones || []).length}`);
    if (idsFiltro) console.log(`IDs solicitados: ${idsFiltro.join(', ')}`);
    if (!(versiones || []).length) {
        console.log('\nNada que hacer — ninguna versión objetivo (o ya están todas actualizadas).');
        return;
    }
    (versiones || []).forEach(v => console.log(`  ${v.id}  (cartilla ${v.cartilla_delegado_id}, v${v.numero_version})`));

    if (!aplicar) {
        console.log('\n(Modo solo lectura — no se generó ni subió ningún PDF. Ejecutar con --aplicar, --actor-email y --motivo para actualizar.)');
        return;
    }

    if (!actorEmail) throw new Error('--aplicar requiere --actor-email=<email> — no se asume ningún administrador por defecto.');
    const { data: admins, error: errAdmin } = await supabase.from('administradores').select('id, email').eq('email', actorEmail);
    if (errAdmin) throw new Error('Error resolviendo --actor-email: ' + errAdmin.message);
    if (!admins || admins.length !== 1) throw new Error(`--actor-email="${actorEmail}" resolvió a ${admins ? admins.length : 0} administrador(es) — se esperaba exactamente 1. Abortado sin escribir nada.`);
    const actorId = admins[0].id;

    console.log(`\nActor: ${actorEmail} (${actorId})`);
    console.log(`Motivo: ${motivo}\n`);

    let actualizadas = 0;
    const excepciones = [];
    const huerfanosStorage = []; // rutas que SÍ se subieron pero la RPC no llegó a adjuntar — nunca se borran automáticamente, solo se reportan.

    for (const v of versiones) {
        let subidaOk = false, storagePath = null;
        try {
            const rodeoId = v.snapshot?.rodeo_id;
            const { data: rodeo } = rodeoId
                ? await supabase.from('rodeos').select('id, club, asociacion, fecha, tipo_rodeo_nombre, categoria_rodeo_nombre, temporada_id, temporadas(nombre)').eq('id', rodeoId).maybeSingle()
                : { data: null };

            const buffer = await generarCartillaDelegadoPDF(v.snapshot, rodeo || {});
            storagePath = `${rodeoId}/cartillas-delegado-versiones/${v.cartilla_delegado_id}/v${v.numero_version}_rediseno_${Date.now()}.pdf`;

            const { error: errUpload } = await supabase.storage.from('rodeo-adjuntos').upload(storagePath, buffer, { contentType: 'application/pdf', upsert: false });
            if (errUpload) throw new Error('Error al subir el PDF: ' + errUpload.message);
            subidaOk = true; // a partir de aquí, si algo falla, el archivo YA existe en Storage sin que ninguna fila lo referencie.

            const { error: errRpc } = await supabase.rpc('actualizar_diseno_pdf_version_cartilla_delegado', {
                p_version_historica_id: v.id,
                p_storage_path_pdf_rediseno: storagePath,
                p_actor_id: actorId,
                p_motivo: motivo,
                p_actor_tipo: 'administrador'
            });
            if (errRpc) throw new Error('Error en la RPC: ' + errRpc.message);

            actualizadas++;
            console.log(`  OK   ${v.id}  ->  ${storagePath}`);
        } catch (errFila) {
            if (subidaOk) {
                huerfanosStorage.push({ id: v.id, storagePath });
                errFila.message += ` — ATENCIÓN: el PDF SÍ se subió a Storage en "${storagePath}" antes de fallar; ese archivo queda huérfano (no referenciado por ninguna fila) hasta que se reintente o se elimine manualmente.`;
            }
            excepciones.push({ id: v.id, motivo: errFila.message });
            console.log(`  EXCEPCIÓN  ${v.id}  ->  ${errFila.message}`);
        }
    }

    console.log(`\nActualizadas: ${actualizadas}  |  Excepciones: ${excepciones.length}  |  Archivos huérfanos detectados en Storage: ${huerfanosStorage.length}`);
    if (excepciones.length) {
        console.log('\n--- Detalle de excepciones (ninguna se reintenta automáticamente) ---');
        excepciones.forEach(e => console.log(`  ${e.id}: ${e.motivo}`));
    }
    if (huerfanosStorage.length) {
        console.log('\n--- Archivos subidos a Storage SIN quedar referenciados (revisar manualmente) ---');
        huerfanosStorage.forEach(h => console.log(`  versión ${h.id}: ${h.storagePath}`));
    }
}

if (require.main === module) {
    main().catch(err => { console.error(err); process.exitCode = 1; });
}
module.exports = { main };
