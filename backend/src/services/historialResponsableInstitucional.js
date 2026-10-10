// ─────────────────────────────────────────────────────────────────────────
// Fase 3.5 — "Historial de Responsables de la Cartilla": servicio ÚNICO de
// lectura, reutilizado por el formulario institucional (institucional/
// cartilla.js), el detalle administrativo (admin/cartillas-delegado.js) y el
// PDF oficial (cartilla-delegado-pdf.js) — nunca se reimplementa en cada uno.
//
// Se construye EXCLUSIVAMENTE a partir de registros ya persistidos en
// `auditoria` (tabla real, usada en todo el sistema desde antes de esta
// fase) — NUNCA se fabrica un evento que no fue auditado. Si no hay
// registros, el historial viene vacío (el caller decide qué mostrar en ese
// caso, p.ej. "Sin historial disponible").
//
// Dos fuentes, fusionadas y ordenadas cronológicamente:
//   1. tabla='rodeos_delegado_institucional', registro_id=<id de esa fila>:
//      eventos 'confirmar_responsable_institucional' y
//      'reemplazar_responsable_institucional' (ver migración 069).
//   2. tabla='cartillas_delegado', registro_id=<id de la cartilla>, si ya
//      existe una: eventos 'crear'/'cambiar_responsable'/'guardar'/'enviar'
//      (los mismos que ya registran institucional/cartilla.js e
//      institucional/rodeos.js desde la Fase 3.3).
// ─────────────────────────────────────────────────────────────────────────

/**
 * @param {object} supabase - cliente de Supabase ya configurado
 * @param {{ designacionId?: string|null, cartillaId?: string|null }} ids
 * @returns {Promise<Array<object>>} eventos ordenados cronológicamente (ascendente)
 */
async function obtenerHistorialResponsables(supabase, { designacionId = null, cartillaId = null } = {}) {
    const consultas = [];
    if (designacionId) {
        consultas.push(
            supabase.from('auditoria').select('*')
                .eq('tabla', 'rodeos_delegado_institucional')
                .eq('registro_id', designacionId)
                .order('created_at', { ascending: true })
        );
    }
    if (cartillaId) {
        consultas.push(
            supabase.from('auditoria').select('*')
                .eq('tabla', 'cartillas_delegado')
                .eq('registro_id', cartillaId)
                .order('created_at', { ascending: true })
        );
    }
    if (consultas.length === 0) return [];

    const resultados = await Promise.all(consultas);
    const eventos = resultados.flatMap(r => r.data || []);
    // Se fusionan y se vuelven a ordenar entre sí (cada fuente ya viene
    // ordenada, pero combinadas no necesariamente lo están).
    eventos.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    // Fase 3.5.1 — sección 3 del pedido ("administrador autorizante"): se
    // resuelve el NOMBRE del administrador para los eventos de reemplazo
    // (actor_tipo='administrador'), en vez de mostrar solo su id (UUID). Una
    // sola consulta batched (nunca una por evento). Si el id no resuelve
    // (cuenta eliminada, etc.) se deja sin nombre — nunca se inventa uno.
    const idsAdmin = [...new Set(eventos.filter(e => e.actor_tipo === 'administrador').map(e => e.actor_id))];
    if (idsAdmin.length > 0) {
        const { data: admins } = await supabase.from('administradores').select('id, nombre_completo').in('id', idsAdmin);
        const nombrePorId = new Map((admins || []).map(a => [a.id, a.nombre_completo]));
        for (const ev of eventos) {
            if (ev.actor_tipo === 'administrador') ev.actor_nombre = nombrePorId.get(ev.actor_id) || null;
        }
    }

    return eventos;
}

module.exports = { obtenerHistorialResponsables };
