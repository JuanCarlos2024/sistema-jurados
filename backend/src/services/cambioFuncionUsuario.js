// Cambio de función Jurado <-> Delegado Rentado (migración 100).
//
// La RPC cambiar_tipo_persona_usuario_con_historial es la autoridad: valida,
// bloquea la fila y registra el historial en una transacción. Este módulo
// solo (1) valida la solicitud antes de llamarla, (2) arma la verificación
// previa que ve el administrador (qué bloquea el cambio y qué historial se
// conserva) y (3) traduce los errores de la RPC a respuestas HTTP.

const TIPOS = ['jurado', 'delegado_rentado'];
const CATEGORIAS = ['A', 'B', 'C'];
const MOTIVO_MAX = 1000;
const ETIQUETA_TIPO = { jurado: 'Jurado', delegado_rentado: 'Delegado Rentado' };

// Fecha de hoy en Chile (YYYY-MM-DD). La RPC usa el mismo criterio
// (now() AT TIME ZONE 'America/Santiago').
function fechaHoyChile(ahora = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(ahora);
}

function sumarDias(fechaISO, dias) {
    const d = new Date(fechaISO.slice(0, 10) + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
}

function validarSolicitudCambioFuncion(body) {
    const { tipo_persona, categoria, motivo } = body || {};
    if (!TIPOS.includes(tipo_persona)) {
        return { ok: false, error: 'La nueva función debe ser Jurado o Delegado Rentado' };
    }
    if (tipo_persona === 'jurado' && !CATEGORIAS.includes(categoria)) {
        return { ok: false, error: 'Para cambiar a Jurado debe elegir categoría A, B o C' };
    }
    if (tipo_persona === 'delegado_rentado' && categoria !== undefined && categoria !== null && categoria !== '') {
        return { ok: false, error: 'El Delegado Rentado no lleva categoría de jurado' };
    }
    if (typeof motivo !== 'string' || !motivo.trim()) {
        return { ok: false, error: 'Debe indicar el motivo del cambio de función' };
    }
    if (motivo.trim().length > MOTIVO_MAX) {
        return { ok: false, error: `El motivo no puede superar ${MOTIVO_MAX} caracteres` };
    }
    return {
        ok: true,
        datos: {
            tipo_persona,
            categoria: tipo_persona === 'jurado' ? categoria : null,
            motivo: motivo.trim()
        }
    };
}

// Último día del rodeo (fecha + duracion_dias - 1), igual que la RPC.
function ultimoDiaRodeo(rodeo) {
    if (!rodeo?.fecha) return null;
    const dur = Math.max(parseInt(rodeo.duracion_dias, 10) || 1, 1);
    return sumarDias(rodeo.fecha, dur - 1);
}

// Designaciones que impiden el cambio (mismo criterio que la RPC).
function designacionesBloqueantes(asignaciones, hoy) {
    return (asignaciones || []).filter(a => {
        if (a.estado !== 'activo') return false;
        if (a.estado_designacion === 'rechazado') return false;
        const r = a.rodeos;
        if (!r || r.estado === 'anulado') return false;
        const fin = ultimoDiaRodeo(r);
        return fin !== null && fin >= hoy;
    });
}

const ESTADOS_PENDIENTES_JURADO = ['borrador', 'reabierta'];
const ESTADOS_PENDIENTES_DELEGADO = ['borrador', 'observada', 'reabierta'];

async function obtenerVerificacionCambioFuncion(supabase, usuarioId, { hoy = fechaHoyChile() } = {}) {
    const { data: usuario, error: errU } = await supabase
        .from('usuarios_pagados')
        .select('id, codigo_interno, nombre_completo, tipo_persona, categoria, activo, estado_usuario')
        .eq('id', usuarioId)
        .maybeSingle();
    if (errU) throw new Error(errU.message);
    if (!usuario) return null;

    const tipoDestino = usuario.tipo_persona === 'jurado' ? 'delegado_rentado' : 'jurado';

    const { data: asigs, error: errA } = await supabase
        .from('asignaciones')
        .select('id, tipo_persona, categoria_aplicada, estado, estado_designacion, rodeos(id, club, asociacion, fecha, duracion_dias, estado)')
        .eq('usuario_pagado_id', usuarioId);
    if (errA) throw new Error(errA.message);

    let cartillasPendientes = [];
    if (usuario.tipo_persona === 'jurado') {
        const { data, error } = await supabase
            .from('cartillas_jurado')
            .select('id, rodeo_id, estado')
            .eq('usuario_pagado_id', usuarioId)
            .eq('es_actual', true)
            .in('estado', ESTADOS_PENDIENTES_JURADO);
        if (error) throw new Error(error.message);
        cartillasPendientes = (data || []).map(c => ({ ...c, tipo: 'cartilla_jurado' }));
    } else {
        const { data, error } = await supabase
            .from('cartillas_delegado')
            .select('id, rodeo_id, estado')
            .eq('delegado_id', usuarioId)
            .in('estado', ESTADOS_PENDIENTES_DELEGADO);
        if (error) throw new Error(error.message);
        cartillasPendientes = (data || []).map(c => ({ ...c, tipo: 'cartilla_delegado' }));
    }

    const bloqueantes = designacionesBloqueantes(asigs, hoy).map(a => ({
        asignacion_id: a.id,
        tipo_persona: a.tipo_persona,
        rodeo_id: a.rodeos?.id || null,
        club: a.rodeos?.club || null,
        asociacion: a.rodeos?.asociacion || null,
        fecha: a.rodeos?.fecha || null,
        ultimo_dia: ultimoDiaRodeo(a.rodeos),
        estado_designacion: a.estado_designacion || null
    })).sort((x, y) => (x.fecha || '').localeCompare(y.fecha || ''));

    const vigentes = (asigs || []).filter(a => a.estado === 'activo' && a.estado_designacion !== 'rechazado');
    const historico = {
        designaciones_como_jurado: vigentes.filter(a => a.tipo_persona === 'jurado').length,
        designaciones_como_delegado: vigentes.filter(a => a.tipo_persona === 'delegado_rentado').length
    };

    return {
        usuario,
        tipo_actual: usuario.tipo_persona,
        tipo_destino: tipoDestino,
        fecha_efectiva: hoy,
        bloqueos: { designaciones: bloqueantes, cartillas_pendientes: cartillasPendientes },
        historico,
        puede_cambiar: bloqueantes.length === 0 && cartillasPendientes.length === 0
    };
}

// Traduce errores de la RPC. Devuelve { status, body }.
function mapearErrorRpcCambioFuncion(error) {
    const msg = (error && error.message) || '';
    if (msg.includes('DESIGNACIONES_VIGENTES_O_FUTURAS')) {
        return { status: 409, body: { error: 'La persona tiene designaciones vigentes o futuras. Regularícelas (reemplazo o anulación) antes de cambiar su función.', code: 'DESIGNACIONES_VIGENTES_O_FUTURAS' } };
    }
    if (msg.includes('CARTILLAS_PENDIENTES')) {
        return { status: 409, body: { error: 'La persona tiene cartillas pendientes de su función actual. Deben enviarse o regularizarse antes del cambio.', code: 'CARTILLAS_PENDIENTES' } };
    }
    if (msg.includes('TIPO_PERSONA_SIN_CAMBIOS')) {
        return { status: 409, body: { error: 'La persona ya tiene esa función', code: 'TIPO_PERSONA_SIN_CAMBIOS' } };
    }
    if (msg.includes('USUARIO_INEXISTENTE')) {
        return { status: 404, body: { error: 'Usuario no encontrado' } };
    }
    if (/CATEGORIA_INVALIDA|TIPO_PERSONA_INVALIDO|MOTIVO_REQUERIDO|MOTIVO_DEMASIADO_LARGO|ACTOR_REQUERIDO/.test(msg)) {
        return { status: 400, body: { error: 'Datos de cambio de función inválidos', code: 'DATOS_INVALIDOS' } };
    }
    if (error && (error.code === 'PGRST202' || msg.includes('cambiar_tipo_persona_usuario_con_historial'))) {
        return { status: 503, body: { error: 'La funcionalidad aún no está habilitada en la base de datos (migración 100 pendiente).', code: 'MIGRACION_100_PENDIENTE' } };
    }
    return { status: 500, body: { error: 'No fue posible cambiar la función: ' + msg } };
}

module.exports = {
    ETIQUETA_TIPO,
    fechaHoyChile,
    ultimoDiaRodeo,
    designacionesBloqueantes,
    validarSolicitudCambioFuncion,
    obtenerVerificacionCambioFuncion,
    mapearErrorRpcCambioFuncion
};
