// ═════════════════════════════════════════════════════════════════════════
// Importación de RODEOS HISTÓRICOS — FASE 2: CONFIRMACIÓN + ESCRITURA TRANSACCIONAL.
//
// El navegador NO es fuente de verdad: solo envía el archivo, la temporada y el SHA-256 que recibió en la vista previa.
// Aquí el backend vuelve a: (1) calcular el hash y compararlo, (2) leer y (3) validar el Excel, (4) hacer el matching
// contra la BD y (5) reconstruir el plan — con EXACTAMENTE el mismo código de la vista previa (generarPreview) — y
// recién entonces (6) ejecuta UNA función PostgreSQL transaccional (importar_rodeos_historicos, migración 060) que
// vuelve a consultar bajo lock antes de escribir. Todos los contadores del resultado salen de la base, no del cliente.
//
// Este es el ÚNICO módulo de la importación histórica que escribe (vía RPC). importacionHistorica.js sigue siendo solo lectura.
// ═════════════════════════════════════════════════════════════════════════
const { generarPreview, sha256Buffer, ErrorArchivo, TEMPORADAS_HISTORICAS } = require('./importacionHistorica');

// Casos por WhatsApp > 0 sin evaluación → evaluación histórica mínima: estado 'cerrado', es_historica_importacion = true, sin ciclos.
// Con el marcador, las consultas operativas (listados, dashboard, reportes, Informe de Gestión, portal del jurado) NO la cuentan como
// evaluación, y cuando alguien crea una evaluación normal para ese rodeo se CONVIERTE (services/evaluacionCreacion.js).
// Se mantiene como interruptor de seguridad (valor en producción: true): en false la RPC no crea evaluaciones y lo informa
// (los Casos por WhatsApp quedan sin cargar; el resto se importa igual). Permite desactivar la creación sin tocar la migración.
const CREAR_EVALUACIONES_HISTORICAS = true;

class ErrorEscritura extends Error {
    constructor(status, codigo, mensaje) { super(mensaje); this.status = status; this.codigo = codigo; }
}

function traducirErrorRpc(error) {
    const m = String(error && error.message || '');
    if (/HIST_SIN_PERMISO/.test(m)) return new ErrorEscritura(403, 'SIN_PERMISO', 'Solo un administrador pleno activo puede importar rodeos históricos.');
    if (/HIST_TEMPORADA_INEXISTENTE/.test(m)) return new ErrorEscritura(400, 'TEMPORADA_INEXISTENTE', 'La temporada seleccionada no existe. Las temporadas no se crean desde el importador.');
    if (/HIST_ARGUMENTOS_INVALIDOS|HIST_SIN_GRUPOS|HIST_GRUPO_INVALIDO/.test(m)) return new ErrorEscritura(400, 'ARGUMENTOS_INVALIDOS', 'La importación no tiene datos válidos para escribir.');
    return new ErrorEscritura(500, 'IMPORTACION_REVERTIDA', `La importación falló y fue revertida por completo: no se guardó ningún dato. Detalle técnico: ${m || 'error desconocido'}`);
}

function armarResultado(preview, rpc, adminIdNombre = null) {
    const rpcFilas = new Map((rpc.filas || []).map(f => [f.fila, f]));
    const rpcGrupos = new Map((rpc.grupos || []).map(g => [g.clave, g]));
    const filas = preview.filas.map(f => {
        const base = { fila: f.fila, fecha: f.fecha, club: f.club, asociacion: f.asociacion.canonica || f.asociacion.excel, tipo: f.tipo.nombre || f.tipo.excel, jurado: f.jurado.nombre || f.jurado.excel };
        const rf = rpcFilas.get(f.fila);
        if (rf) {
            const g = rpcGrupos.get(rf.clave) || { acciones: [], existentes: [], conflictos: [], errores: [] };
            const acciones = [...g.acciones, ...rf.acciones], existentes = [...g.existentes, ...rf.existentes], conflictos = [...g.conflictos, ...rf.conflictos], errores = [...g.errores, ...rf.errores];
            const estado_final = errores.length ? 'OMITIDA' : conflictos.length ? 'IMPORTADA CON CONFLICTOS' : acciones.length ? 'IMPORTADA' : 'SIN CAMBIOS (YA REGISTRADO)';
            return { ...base, acciones, existentes, conflictos, errores, estado_final };
        }
        const gSql = f.rodeo && rpcGrupos.get(f.rodeo.clave);
        const errores = gSql && gSql.errores.length ? gSql.errores : [...f.errores.map(e => `${e.codigo}: ${e.mensaje}`), ...(f.motivo_bloqueo && !f.errores.length ? [f.motivo_bloqueo] : [])];
        return { ...base, acciones: [], existentes: [], conflictos: [], errores: errores.length ? errores : ['Fila no importada.'], estado_final: 'OMITIDA' };
    });
    const omitidas = filas.filter(x => x.estado_final === 'OMITIDA').length;
    return {
        modo: 'IMPORTACION',
        escribe_base_de_datos: true,
        importacion_id: rpc.importacion_id,
        archivo: preview.resumen.archivo,
        sha256: preview.sha256,
        temporada: preview.temporada,
        resumen: {
            ...rpc.resumen,
            filas_excel: preview.filas.length,
            filas_importadas: filas.filter(x => x.estado_final === 'IMPORTADA' || x.estado_final === 'IMPORTADA CON CONFLICTOS').length,
            filas_sin_cambios: filas.filter(x => x.estado_final === 'SIN CAMBIOS (YA REGISTRADO)').length,
            filas_omitidas: omitidas,
            filas_con_error: preview.plan.filas_con_error
        },
        filas
    };
}

async function confirmarImportacion({ buffer, nombreArchivo, temporadaId, sha256Esperado, adminId, ip }, db) {
    if (!sha256Esperado || !/^[0-9a-f]{64}$/i.test(String(sha256Esperado))) {
        throw new ErrorArchivo('HASH_REQUERIDO', 'Falta el hash del archivo validado. Vuelva a validar el archivo antes de confirmar.');
    }
    // (1) Mismo archivo que se previsualizó
    if (sha256Buffer(buffer) !== String(sha256Esperado).toLowerCase()) {
        throw new ErrorArchivo('ARCHIVO_DISTINTO', 'El archivo seleccionado no coincide con el archivo validado previamente. Vuelva a validar.');
    }
    // (2)-(5) Relee, revalida y rehace el matching con el MISMO código de la vista previa (valida temporada y período)
    const preview = await generarPreview({ buffer, nombreArchivo, temporadaId }, db);
    if (!preview.plan.hay_acciones) {
        throw new ErrorArchivo('SIN_ACCIONES', 'No hay acciones importables en este archivo (todo está ya registrado o tiene errores). No se escribió nada.');
    }
    const rango = TEMPORADAS_HISTORICAS[preview.temporada.nombre];

    // (6) Escritura atómica en la base
    const { data, error } = await db.rpc('importar_rodeos_historicos', {
        p_admin_id: adminId,
        p_temporada_id: preview.temporada.id,
        p_fecha_desde: rango.desde,
        p_fecha_hasta: rango.hasta,
        p_nombre_archivo: nombreArchivo,
        p_sha256: preview.sha256,
        p_total_filas: preview.filas.length,
        p_grupos: preview._payload,
        p_filas_omitidas: preview.plan.filas_omitidas,
        p_filas_con_error: preview.plan.filas_con_error,
        p_crear_evaluaciones: CREAR_EVALUACIONES_HISTORICAS,
        p_ip: ip || null
    });
    if (error) throw traducirErrorRpc(error);
    return armarResultado(preview, data);
}

module.exports = { confirmarImportacion, armarResultado, traducirErrorRpc, ErrorEscritura, CREAR_EVALUACIONES_HISTORICAS };
