// ═════════════════════════════════════════════════════════════════════════
// notaTecnicaJurados.js — fuente OFICIAL de "nota técnica" de un jurado para
// el motor de designación (pedido "Motor Global con Prioridad de Rodeos,
// Categorías y Calidad Técnica", Etapa B).
//
// Reutiliza EXACTAMENTE la misma fuente/filtro ya oficial que usa
// evaluacionDesempenoJurados.js para "Nota Área Deportiva" (nota_ad_promedio):
// notas_rodeo.nota con fuente='evaluacion_tecnica' EXCLUSIVAMENTE — se
// excluye fuente='manual' (valor histórico importado sin evaluación técnica
// real detrás, ver migración 060) — nunca una fuente paralela. Grano nativo
// por jurado vía asignacion_id (igual que AD) — nunca atribuido desde un
// valor de rodeo compartido (a diferencia de Nota Delegado).
//
// No se reutiliza el módulo completo evaluacionDesempenoJurados.js (calcula
// Nota Delegado/Comisión/WhatsApp/alteraciones — nada de eso hace falta
// acá) para no pagar ese costo de consultas en cada dry-run del motor; se
// extrae acá solo lo mínimo que el motor necesita, sobre la MISMA fuente.
//
// "Fecha de corte" (mismo concepto ya usado en routes/admin/propuesta-
// designacion.js: fechaCorteTecnica) — solo promedia evaluaciones de rodeos
// con fecha <= la fecha de corte, para que la nota técnica de un dry-run
// nunca dependa de datos "del futuro" respecto al momento simulado.
//
// Una nota AUSENTE (jurado sin ninguna evaluación técnica todavía) NUNCA se
// convierte en 0 — se devuelve `null` explícito. El comparador del motor
// (NOTA_TECNICA en motorPropuestaDesignacion.js) decide cómo tratar la
// ausencia: ordena al final, nunca como si fuera la peor nota numérica real.
// ═════════════════════════════════════════════════════════════════════════
const supabase = require('../config/supabase');

const PAGINA = 900; // mismo tamaño de página usado en el resto del proyecto

// Mismo criterio ÚNICO de "asignación efectiva" que motorPropuestaDesignacion
// .js (esAsignacionEfectiva, Etapa 3.1) — reproducido acá (nunca importado
// directamente desde ahí) para evitar una dependencia circular: motor
// PropuestaDesignacion.js importa cargarNotaTecnicaPorJurado() de este mismo
// archivo para alimentar el motor ANTES de rankear. Mismas 2 líneas exactas,
// nunca una regla distinta:
//   CUENTA:     estado != 'anulado'  Y  estado_designacion en {pendiente, aceptado, null(legacy)}
//   NO CUENTA:  estado = 'anulado'   O  estado_designacion = 'rechazado'
function esAsignacionEfectiva(asignacion) {
    if (asignacion.estado === 'anulado') return false;
    if (asignacion.estado_designacion === 'rechazado') return false;
    return true;
}

// ─── Carga, para cada jurado solicitado, su nota técnica oficial promedio
// hasta la fecha de corte (o null si nunca tuvo una evaluación técnica real). ─
// @param juradoIds        [uuid, ...]
// @param fechaCorteISO    string ISO (se usa solo la parte de fecha, 'YYYY-MM-DD') | null (sin corte)
// @returns Map(jurado_id -> { promedio: number|null, cantidad: number })
async function cargarNotaTecnicaPorJurado(juradoIds, fechaCorteISO) {
    const ids = [...new Set((juradoIds || []).filter(Boolean))];
    const resultado = new Map();
    if (ids.length === 0) return resultado;

    const fechaCorte = fechaCorteISO ? String(fechaCorteISO).slice(0, 10) : null;

    // Asignaciones de jurado para estos ids, con la fecha de su rodeo — se
    // excluyen las anuladas ya en la consulta (optimización); el filtro
    // completo (incluye rechazadas) se aplica con esAsignacionEfectiva(),
    // MISMO criterio único que ya usa el resto del motor — nunca uno paralelo.
    let asignacionesRaw = [];
    {
        let offset = 0;
        while (true) {
            let q = supabase
                .from('asignaciones')
                .select('id, usuario_pagado_id, estado, estado_designacion, rodeos!inner(fecha)')
                .in('usuario_pagado_id', ids)
                .eq('tipo_persona', 'jurado')
                .neq('estado', 'anulado');
            if (fechaCorte) q = q.lte('rodeos.fecha', fechaCorte);
            const { data, error } = await q.range(offset, offset + PAGINA - 1);
            if (error) throw new Error('No se pudo cargar asignaciones para nota técnica: ' + error.message);
            const filas = data || [];
            asignacionesRaw = asignacionesRaw.concat(filas);
            if (filas.length < PAGINA) break;
            offset += PAGINA;
        }
    }
    const asignacionIdsPorJurado = new Map(); // jurado_id -> [asignacion_id, ...]
    for (const a of asignacionesRaw) {
        if (!esAsignacionEfectiva(a)) continue;
        if (!asignacionIdsPorJurado.has(a.usuario_pagado_id)) asignacionIdsPorJurado.set(a.usuario_pagado_id, []);
        asignacionIdsPorJurado.get(a.usuario_pagado_id).push(a.id);
    }

    const todosLosAsignacionIds = [...asignacionIdsPorJurado.values()].flat();
    const notaPorAsignacion = new Map(); // asignacion_id -> number
    if (todosLosAsignacionIds.length > 0) {
        let offset = 0;
        while (true) {
            const { data, error } = await supabase
                .from('notas_rodeo')
                .select('asignacion_id, nota')
                .in('asignacion_id', todosLosAsignacionIds)
                .eq('fuente', 'evaluacion_tecnica')
                .range(offset, offset + PAGINA - 1);
            if (error) throw new Error('No se pudo cargar notas_rodeo para nota técnica: ' + error.message);
            const filas = data || [];
            filas.forEach(n => notaPorAsignacion.set(n.asignacion_id, parseFloat(n.nota)));
            if (filas.length < PAGINA) break;
            offset += PAGINA;
        }
    }

    for (const juradoId of ids) {
        const asigIds = asignacionIdsPorJurado.get(juradoId) || [];
        const notas = asigIds
            .map(id => notaPorAsignacion.get(id))
            .filter(n => n !== undefined && n !== null && !Number.isNaN(n));
        resultado.set(juradoId, {
            promedio: notas.length > 0 ? notas.reduce((s, n) => s + n, 0) / notas.length : null,
            cantidad: notas.length
        });
    }
    return resultado;
}

module.exports = { cargarNotaTecnicaPorJurado };
