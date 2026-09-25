// ═════════════════════════════════════════════════════════════════════════
// Creación de una evaluación NORMAL (POST /admin/evaluaciones y POST /admin/evaluaciones/crear-masivo).
//
// Fuente ÚNICA de la definición de ciclos (ciclosIniciales) y del flujo "crear o convertir":
//   · Rodeo SIN evaluación            → crea la evaluación + 2 ciclos + auditoría (comportamiento de siempre).
//   · Rodeo con evaluación HISTÓRICA  → NO crea una segunda fila (evaluaciones.rodeo_id es UNIQUE): la convierte en normal
//     mediante la RPC atómica convertir_evaluacion_historica (migración 060): conserva casos_whatsapp, es_historica_importacion
//     pasa a false, estado inicial 'borrador', mismos ciclos y misma auditoría. Todo en una transacción.
//   · Rodeo con evaluación NORMAL (o histórica anulada) → 'existente' (409 en el endpoint, como siempre).
// ═════════════════════════════════════════════════════════════════════════

const CONFIGURACION_POR_DEFECTO = Object.freeze({ puntaje_base: 80, min_casos_ciclo1: 0, max_casos_ciclo1: 10, min_casos_ciclo2: 8, max_casos_ciclo2: 8 });

async function cargarConfiguracion(supabase) {
    const { data: config } = await supabase.from('evaluacion_configuracion').select('*').eq('activo', true).single();
    return config || { ...CONFIGURACION_POR_DEFECTO };
}

// Definición de los ciclos de una evaluación nueva (idéntica para creación normal y conversión).
function ciclosIniciales(cfg) {
    return [
        { numero_ciclo: 1, min_casos: cfg.min_casos_ciclo1, max_casos: cfg.max_casos_ciclo1 },
        { numero_ciclo: 2, min_casos: cfg.min_casos_ciclo2, max_casos: cfg.max_casos_ciclo2 }
    ];
}

const MENSAJES_CONVERSION = {
    EVAL_CONV_ANULADA: [409, 'La evaluación histórica de este rodeo está anulada'],
    EVAL_CONV_NO_HISTORICA: [409, 'Ya existe una evaluación para este rodeo'],
    EVAL_CONV_YA_TIENE_CICLOS: [409, 'La evaluación histórica ya tiene ciclos; no se puede convertir']
};
function estadoErrorConversion(error) {
    const m = String(error && error.message || '');
    for (const [codigo, [status, mensaje]] of Object.entries(MENSAJES_CONVERSION)) if (m.includes(codigo)) return { status, mensaje };
    return { status: 500, mensaje: 'No se pudo convertir la evaluación histórica (no se guardó ningún cambio): ' + m };
}

/**
 * @returns {Promise<{resultado: 'creada'|'convertida'|'existente'|'error', evaluacion?: object, error?: {status:number, mensaje:string}}>}
 */
async function crearEvaluacion({ supabase, cfg, rodeo_id, analista_id, actor, ip, detalleExtra = {} }) {
    const { data: ev, error: evErr } = await supabase
        .from('evaluaciones')
        .insert({ rodeo_id, analista_id, puntaje_base: cfg.puntaje_base, creado_por: actor.id })
        .select()
        .single();

    if (!evErr) {
        await supabase.from('evaluacion_ciclos').insert(ciclosIniciales(cfg).map(c => ({ evaluacion_id: ev.id, ...c })));
        await supabase.from('evaluacion_auditoria').insert({
            evaluacion_id: ev.id,
            accion: 'crear_evaluacion',
            detalle: { rodeo_id, analista_id, ...detalleExtra },
            actor_id: actor.id,
            actor_tipo: 'administrador',
            actor_nombre: actor.nombre,
            ip_address: ip
        });
        return { resultado: 'creada', evaluacion: ev };
    }
    if (evErr.code !== '23505') return { resultado: 'error', error: { status: 500, mensaje: evErr.message } };

    // Ya hay una evaluación para el rodeo: ¿es un registro histórico (solo Casos por WhatsApp)?
    const { data: existente } = await supabase
        .from('evaluaciones')
        .select('id, es_historica_importacion, anulada, casos_whatsapp')
        .eq('rodeo_id', rodeo_id)
        .maybeSingle();
    if (!existente || existente.es_historica_importacion !== true || existente.anulada) return { resultado: 'existente' };

    const { data: convertida, error: convErr } = await supabase.rpc('convertir_evaluacion_historica', {
        p_rodeo_id: rodeo_id,
        p_analista_id: analista_id,
        p_puntaje_base: cfg.puntaje_base,
        p_actor_id: actor.id,
        p_actor_nombre: actor.nombre || null,
        p_ciclos: ciclosIniciales(cfg),
        p_detalle: { rodeo_id, analista_id, ...detalleExtra, convertida_desde_historica: true, casos_whatsapp_conservado: existente.casos_whatsapp },
        p_ip: ip || null
    });
    if (convErr) return { resultado: 'error', error: estadoErrorConversion(convErr) };
    return { resultado: 'convertida', evaluacion: convertida };
}

module.exports = { CONFIGURACION_POR_DEFECTO, cargarConfiguracion, ciclosIniciales, crearEvaluacion, estadoErrorConversion };
