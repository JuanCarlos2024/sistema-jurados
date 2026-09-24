// ═════════════════════════════════════════════════════════════════════════
// UTILIZACIÓN del cuerpo de jurados — indicadores de USO, no evaluación de calidad de las personas.
//
// Reutiliza el resultado de disponibilidad.analizarDisponibilidad (acumulado de temporada al corte), que ya
// define "designación efectiva": asignación de jurado con estado = 'activo' (no anulada) y
// estado_designacion distinto de 'rechazado', sobre rodeos activos dentro del rango. No hay otra definición.
// El universo son los jurados activos considerados para disponibilidad (los mismos de la tabla de la página).
// Los umbrales viven en config.js (UTILIZACION), no en el frontend.
// ═════════════════════════════════════════════════════════════════════════
const CONFIG = require('./config');
const { porcentaje, redondear } = require('./agregados');

function utilizacionJurados(disponibilidadAcumulada, cfg = CONFIG) {
    const detalle = (disponibilidadAcumulada && disponibilidadAcumulada.detalle) || [];
    const U = cfg.UTILIZACION;
    const conDecl = detalle.filter(d => d.estado === 'CON_DECLARACION');

    // 6.1 Con disponibilidad declarada y 0 designaciones efectivas en la temporada al corte
    const sinDesignacion = conDecl.filter(d => d.designaciones === 0);

    // 6.2 Alta disponibilidad / baja utilización. Utilización null (sin declaración) nunca cuenta como baja.
    const altaBaja = conDecl.filter(d => d.porcentaje_disponibilidad_declarada >= U.ALTA_DISPONIBILIDAD_PCT
        && d.utilizacion_sobre_disponibilidad_declarada !== null && d.utilizacion_sobre_disponibilidad_declarada <= U.BAJA_UTILIZACION_PCT);

    // 6.3 Concentración: % de las designaciones efectivas que reúne el 20 % de jurados con más designaciones
    const N = detalle.length;
    const totalDesignaciones = detalle.reduce((s, d) => s + d.designaciones, 0);
    const k = N ? Math.ceil(N * U.CONCENTRACION_TOP_PCT / 100) : 0;
    const topK = [...detalle].sort((a, b) => b.designaciones - a.designaciones || (a.jurado || '').localeCompare(b.jurado || '', 'es')).slice(0, k);
    const enTop = topK.reduce((s, d) => s + d.designaciones, 0);

    return {
        definicion_designacion_efectiva: "Asignación de jurado con estado 'activo' (no anulada) y estado_designacion distinto de 'rechazado', en rodeos activos hasta el corte (misma regla de la disponibilidad).",
        nota: 'Son indicadores de utilización del cuerpo de jurados, no una evaluación de la calidad de las personas.',
        jurados_considerados: N,
        bloques_posibles: disponibilidadAcumulada ? disponibilidadAcumulada.bloques_posibles : null,
        disponibles_sin_designacion: {
            cantidad: sinDesignacion.length,
            sobre_con_declaracion: conDecl.length,
            texto: 'Con disponibilidad declarada y sin designaciones'
        },
        alta_disponibilidad_baja_utilizacion: {
            cantidad: altaBaja.length,
            sobre_con_declaracion: conDecl.length,
            umbral_disponibilidad_pct: U.ALTA_DISPONIBILIDAD_PCT,
            umbral_utilizacion_pct: U.BAJA_UTILIZACION_PCT,
            criterio: `≥${U.ALTA_DISPONIBILIDAD_PCT} % disponibilidad declarada y ≤${U.BAJA_UTILIZACION_PCT} % utilización`
        },
        concentracion_designaciones: {
            jurados_considerados: N,
            designaciones: totalDesignaciones,
            porcentaje_jurados_top: U.CONCENTRACION_TOP_PCT,
            jurados_en_top: k,
            designaciones_en_top: enTop,
            porcentaje_designaciones_en_top: totalDesignaciones ? porcentaje(enTop, totalDesignaciones) : null,
            promedio_por_jurado: N ? redondear(totalDesignaciones / N, 1) : null
        }
    };
}

module.exports = { utilizacionJurados };
