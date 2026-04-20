const supabase = require('../config/supabase');

/**
 * Obtiene tarifas vigentes de la base de datos.
 * Retorna objeto: { A: { valor_diario, valor_2_dias }, B: {...}, C: {...} }
 */
async function obtenerTarifas() {
    const { data, error } = await supabase
        .from('configuracion_tarifas')
        .select('*');

    if (error) throw new Error('Error al obtener tarifas: ' + error.message);

    const tarifas = {};
    data.forEach(t => { tarifas[t.categoria] = t; });
    return tarifas;
}

/**
 * Obtiene el porcentaje de retención vigente.
 */
async function obtenerRetencion() {
    const { data, error } = await supabase
        .from('configuracion_retencion')
        .select('porcentaje')
        .limit(1)
        .maybeSingle();

    if (error) throw new Error('Error al obtener retención: ' + error.message);
    return data ? parseFloat(data.porcentaje) : 0;
}

/**
 * Calcula el pago base para una asignación.
 *
 * @param {string} tipo_persona - 'jurado' | 'delegado_rentado'
 * @param {string|null} categoria - 'A' | 'B' | 'C' | null (delegado usa 'DR')
 * @param {number} duracion_dias
 * @param {object} tarifas - resultado de obtenerTarifas()
 * @returns {{ valor_diario_aplicado, pago_base_calculado, categoria_aplicada }}
 */
function calcularPagoBase(tipo_persona, categoria, duracion_dias, tarifas) {
    const cat = tipo_persona === 'delegado_rentado' ? 'DR' : categoria;

    if (!tarifas[cat]) {
        throw new Error(`Categoría ${cat} no tiene tarifa configurada`);
    }

    const valor_diario = tarifas[cat].valor_diario;
    const pago_base = valor_diario * duracion_dias;

    return {
        categoria_aplicada: cat,
        valor_diario_aplicado: valor_diario,
        pago_base_calculado: pago_base
    };
}

/**
 * Calcula el resumen financiero de un usuario en un período.
 *
 * @param {string} usuario_pagado_id
 * @param {string} año - 'YYYY'
 * @param {string} mes - 'MM'
 * @returns {{ bruto, retencion, liquido, asignaciones, bonos }}
 */
async function calcularResumenMensual(usuario_pagado_id, año, mes) {
    // Construir rango de fechas del mes
    const fechaInicio = `${año}-${mes.padStart(2, '0')}-01`;
    const fechaFin = new Date(parseInt(año), parseInt(mes), 0).toISOString().split('T')[0];

    // Obtener asignaciones activas del usuario en el período
    // Filtramos por fecha del rodeo usando inner join
    // Incluye rechazadas (estado_designacion='rechazado') para historial, pero se excluyen de los totales
    const { data: asignaciones, error: errA } = await supabase
        .from('asignaciones')
        .select(`
            *,
            rodeos!inner(club, asociacion, fecha, tipo_rodeo_nombre, duracion_dias)
        `)
        .eq('usuario_pagado_id', usuario_pagado_id)
        .eq('estado', 'activo')
        .gte('rodeos.fecha', fechaInicio)
        .lte('rodeos.fecha', fechaFin)
        .order('created_at', { ascending: true });

    if (errA) throw new Error('Error al obtener asignaciones: ' + errA.message);

    if (!asignaciones || asignaciones.length === 0) {
        return {
            asignaciones: [],
            total_pago_base: 0,
            total_bono_aprobado: 0,
            bruto: 0,
            retencion_porcentaje: await obtenerRetencion(),
            retencion_monto: 0,
            liquido: 0
        };
    }

    const ids_asignaciones = asignaciones.map(a => a.id);

    // Obtener bonos de esas asignaciones
    const { data: bonos, error: errB } = await supabase
        .from('bonos_solicitados')
        .select('*')
        .in('asignacion_id', ids_asignaciones);

    if (errB) throw new Error('Error al obtener bonos: ' + errB.message);

    // Construir mapa de bonos por asignación
    const bonosPorAsignacion = {};
    (bonos || []).forEach(b => {
        if (!bonosPorAsignacion[b.asignacion_id]) {
            bonosPorAsignacion[b.asignacion_id] = [];
        }
        bonosPorAsignacion[b.asignacion_id].push(b);
    });

    // Calcular totales
    // Las asignaciones con estado_designacion='rechazado' se incluyen en el array
    // para historial, pero NO se suman a los totales financieros
    let total_pago_base = 0;
    let total_bono_aprobado = 0;

    const asignacionesConBonos = asignaciones.map(a => {
        const bonosDeEsta = bonosPorAsignacion[a.id] || [];
        const esRechazada = a.estado_designacion === 'rechazado';

        const bono_pendiente = bonosDeEsta.filter(b => b.estado === 'pendiente')
            .reduce((s, b) => s + b.monto_solicitado, 0);
        // aprobado_auto tiene monto_aprobado=0, lo incluimos para consistencia (no suma)
        const bono_aprobado = bonosDeEsta.filter(b => ['aprobado', 'modificado', 'aprobado_auto'].includes(b.estado))
            .reduce((s, b) => s + (b.monto_aprobado || b.monto_solicitado), 0);
        const bono_rechazado = bonosDeEsta.filter(b => b.estado === 'rechazado')
            .reduce((s, b) => s + b.monto_solicitado, 0);

        if (!esRechazada) {
            total_pago_base += a.pago_base_calculado;
            total_bono_aprobado += bono_aprobado;
        }

        return {
            ...a,
            bonos: bonosDeEsta,
            bono_pendiente,
            bono_aprobado,
            bono_rechazado,
            excluido_de_totales: esRechazada
        };
    });

    const porcentaje = await obtenerRetencion();
    const bruto = total_pago_base + total_bono_aprobado;
    const retencion_monto = Math.round(bruto * porcentaje / 100);
    const liquido = bruto - retencion_monto;

    return {
        asignaciones: asignacionesConBonos,
        total_pago_base,
        total_bono_aprobado,
        bruto,
        retencion_porcentaje: porcentaje,
        retencion_monto,
        liquido
    };
}

/**
 * Función PURA: dado km y lista de configs, retorna el config aplicable o null.
 * No toca la BD — exportada para tests unitarios.
 *
 * Regla: km debe estar en [distancia_minima, distancia_maxima].
 * Si distancia_maxima es null → sin límite superior (tramo abierto).
 * Devuelve el config con distancia_minima más alta que aplique
 * (más específico primero).
 */
function _matchBonoConfig(km, configs) {
    if (!km || km <= 0) return null;
    const candidatos = (configs || []).filter(c =>
        c.activo !== false &&
        c.distancia_minima <= km &&
        (c.distancia_maxima === null || c.distancia_maxima === undefined || c.distancia_maxima >= km)
    );
    candidatos.sort((a, b) => b.distancia_minima - a.distancia_minima);
    return candidatos[0] || null;
}

/**
 * Obtiene el bono_config correspondiente a una distancia dada.
 * Retorna null si no hay bono configurado para esa distancia.
 *
 * Usa _matchBonoConfig() internamente para que la lógica de matching sea
 * testeable sin BD.
 */
async function obtenerBonoParaDistancia(distancia_km) {
    const km = parseInt(distancia_km);
    if (!km || km <= 0) return null;

    const { data, error } = await supabase
        .from('bonos_config')
        .select('*')
        .eq('activo', true)
        .order('distancia_minima', { ascending: false });

    if (error) throw new Error('Error al buscar bono: ' + error.message);
    return _matchBonoConfig(km, data || []);
}

module.exports = {
    obtenerTarifas,
    obtenerRetencion,
    calcularPagoBase,
    calcularResumenMensual,
    obtenerBonoParaDistancia,
    _matchBonoConfig  // exportada solo para tests
};
