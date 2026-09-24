// ═════════════════════════════════════════════════════════════════════════
// Informe Ejecutivo de Gestión Deportiva — configuración única.
//
// TODOS los umbrales del módulo viven aquí (ninguna regla de negocio lleva
// números "mágicos" dentro de los servicios). Cada función analítica recibe
// `cfg` como último parámetro (por defecto este objeto) para poder probar y,
// en el futuro, sobrescribir valores sin tocar la lógica.
// ═════════════════════════════════════════════════════════════════════════

function congelar(obj) {
    Object.values(obj).forEach(v => { if (v && typeof v === 'object') congelar(v); });
    return Object.freeze(obj);
}

const CONFIG = congelar({
    VERSION_MOTOR: 'informe-gestion-1.0',

    // Estados de negocio (definidos por el sistema actual)
    RODEO_ACTIVO: 'activo',
    EVALUACION_PUBLICADA: 'publicado',
    CARTILLA_ENVIADA: 'enviada',
    SIN_CATEGORIA: 'Sin categoría',

    // Fecha equivalente entre temporadas
    FECHAS: {
        DIAS_POR_ANIO_SEMANAL: 364,          // 52 semanas: conserva el día de la semana
        COLLERAS_TOLERANCIA_DIAS: 7          // ±7 días para medición histórica comparable
    },

    // Proyecciones (NO son certezas ni intervalos estadísticos)
    PROYECCION: {
        AVANCE_MINIMO: 0.25,                 // no proyectar si el histórico equivalente < 25 % del cierre
        CONSISTENCIA_MAX_DISPERSION: 0.25    // (máx-mín)/mediana para calificar "MAYOR_BASE_HISTORICA"
    },

    // Asociaciones
    ASOCIACION: {
        CAIDA_RELEVANTE_PCT: 30,             // variación <= -30 % => CAIDA_RELEVANTE
        AUMENTO_PCT: 30,                     // variación >= +30 % => AUMENTO
        SIN_ACTIVIDAD_PRIORIDAD_DESDE: 3     // >= 3 asociaciones alertables sin rodeos pero con histórico > 0 => PRIORIDAD
    },

    // Cobertura de datos
    COBERTURA: {
        MINIMA_INTERPRETAR: 0.5,             // bajo este valor un "0" no se interpreta como ausencia real
        BAJA_ATENCION: 0.5,
        BAJA_PRIORIDAD: 0.25
    },

    // Comparación contra histórico equivalente (variación %)
    COMPARACION: {
        SOBRE_INFO_PCT: 5,                   // >= +5 % => "sobre el histórico"
        BAJO_ATENCION_PCT: -5,               // <= -5 % => "bajo el histórico" (ATENCION)
        BAJO_PRIORIDAD_PCT: -15              // <= -15 % => PRIORIDAD
    },

    // Resultados alterados entre períodos consecutivos
    ALTERADOS: {
        AUMENTO_PUNTOS_PORCENTUALES: 10,     // aumento de pp entre período anterior y actual
        DENOMINADOR_MINIMO: 5                // evaluaciones publicadas mínimas en AMBOS períodos
    },

    // Jurados
    JURADO: {
        MUESTRA_LIMITADA_DESDE: 3,           // 1-2 INSUFICIENTE · 3-4 LIMITADA · 5+ SUFICIENTE
        MUESTRA_SUFICIENTE_DESDE: 5,
        RANKING_MUESTRA_MINIMA: 3,           // solo se rankean jurados con >= 3 actuaciones
        MIN_ELEGIBLES_TOP_BOTTOM: 6,         // < 6 jurados elegibles (muestra SUFICIENTE o LIMITADA): tabla única, sin Top/Bottom
        ULTIMAS_NOTAS: 5,
        TENDENCIA_ESTABLE_UMBRAL: 0.1,       // |pendiente| < 0.1 nota/actuación => ESTABLE
        // Validado con datos reales (Fase 3A): los casos de "apreciación" están en ~96 % de los rodeos, así que una racha
        // de "cualquier caso" marca a casi todos. La señal usa rachas de rodeos con caso REGLAMENTARIO y con resultado alterado.
        RACHA_FALTAS_REGLAMENTARIAS: 2,      // actuaciones consecutivas recientes en rodeos con caso reglamentario
        RACHA_ALTERADOS: 2                   // actuaciones consecutivas recientes en rodeos con resultado alterado
    },

    // Utilización del cuerpo de jurados (indicadores de USO, no evaluación de personas)
    UTILIZACION: {
        ALTA_DISPONIBILIDAD_PCT: 75,         // disponibilidad declarada >= 75 % de los bloques posibles
        BAJA_UTILIZACION_PCT: 25,            // Y utilización <= 25 %
        CONCENTRACION_TOP_PCT: 20            // % de designaciones que concentra el 20 % de jurados con más designaciones
    },

    // Capa ejecutiva (Directorio)
    EJECUTIVO: {
        MAX_CAMBIOS: 6,                      // cambios desde el corte deportivo anterior
        MAX_FRASES: 4,                       // "Situación general de temporada"
        TOP_CONCENTRACION: 5,                // asociaciones en las tablas de concentración
        MAX_RESUELTAS_VISIBLES: 3,
        // Prioridad de las frases de lectura general (se muestran las primeras MAX_FRASES que apliquen)
        PRIORIDAD_FRASES: ['ACTIVIDAD', 'COLLERAS', 'ASOCIACIONES', 'COBERTURA', 'JURADOS'],
        MAX_BUSQUEDA_DIAS_BLOQUE: 60
    },

    TOP_N: 5,
    COLLERAS_SNAPSHOT_TIMEOUT_MS: 8000
});

module.exports = CONFIG;
