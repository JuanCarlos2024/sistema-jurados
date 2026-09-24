// ═════════════════════════════════════════════════════════════════════════
// Catálogo de asociaciones y análisis de actividad.
//
// El universo del análisis es el CATÁLOGO COMPLETO validado (tabla
// asociaciones), NUNCA un DISTINCT de rodeos (eliminaría justamente a las de
// cero actividad). Si el catálogo no está disponible (migración no aplicada o
// vacío) el análisis se informa como no disponible: no se improvisa un
// universo. Reutiliza normalizarAsociacion (services/asociaciones.js).
//
// Umbrales (caída relevante, aumento) → config.js.
// Excluidas de alertas: es_especial = true o incluir_en_alertas = false.
// ═════════════════════════════════════════════════════════════════════════
const CONFIG = require('./config');
const { normalizarAsociacion } = require('../asociaciones');
const { diffDays } = require('./fechasEquivalentes');
const { redondear } = require('./agregados');

const ESTADOS = Object.freeze({
    SIN_ACTIVIDAD: 'SIN_ACTIVIDAD',
    CAIDA_RELEVANTE: 'CAIDA_RELEVANTE',
    SIMILAR: 'SIMILAR',
    AUMENTO: 'AUMENTO',
    SIN_HISTORICO: 'SIN_HISTORICO'
});

// Índice { normalizado → asociación } con nombre canónico + alias.
function construirIndiceCatalogo(catalogo, alias = []) {
    const idx = new Map();
    const porId = new Map((catalogo || []).map(a => [a.id, a]));
    for (const a of (catalogo || [])) {
        const n = a.nombre_normalizado || normalizarAsociacion(a.nombre);
        if (n && !idx.has(n)) idx.set(n, a);
    }
    for (const al of (alias || [])) {
        const a = porId.get(al.asociacion_id);
        const n = al.alias_normalizado || normalizarAsociacion(al.alias);
        if (a && n && !idx.has(n)) idx.set(n, a);
    }
    return idx;
}

function resolverAsociacion(texto, indice) {
    const n = normalizarAsociacion(texto);
    return n ? (indice.get(n) || null) : null;
}

function etiquetarVariacion(actual, historico, cfg = CONFIG) {
    if (actual === 0) return { variacion_pct: historico > 0 ? -100 : null, estado: ESTADOS.SIN_ACTIVIDAD };
    if (historico === null || historico === undefined) return { variacion_pct: null, estado: ESTADOS.SIN_HISTORICO };
    if (historico === 0) return { variacion_pct: null, estado: ESTADOS.AUMENTO };
    const v = redondear((actual - historico) / historico * 100, 1);
    if (v <= -cfg.ASOCIACION.CAIDA_RELEVANTE_PCT) return { variacion_pct: v, estado: ESTADOS.CAIDA_RELEVANTE };
    if (v >= cfg.ASOCIACION.AUMENTO_PCT) return { variacion_pct: v, estado: ESTADOS.AUMENTO };
    return { variacion_pct: v, estado: ESTADOS.SIMILAR };
}

// rodeosActuales: rodeos REALIZADOS de la temporada hasta el corte.
// historicoEquivalente: filas de historico_rodeos_temporada dentro de la
// ventana equivalente (o null si no hay histórico cargado).
function analizarActividadAsociaciones({ catalogo, alias, rodeosActuales, historicoEquivalente, hasta }, cfg = CONFIG) {
    if (!Array.isArray(catalogo) || catalogo.length === 0) {
        return {
            catalogo_disponible: false,
            motivo: 'El catálogo de asociaciones no está disponible (tabla ausente o vacía). No se usa DISTINCT de rodeos como universo.',
            asociaciones: [],
            resumen: null,
            sin_correspondencia_catalogo: []
        };
    }
    const indice = construirIndiceCatalogo(catalogo, alias);
    const actuales = new Map();
    const ultima = new Map();
    const sinCorrespondencia = new Map();
    for (const r of (rodeosActuales || [])) {
        const a = resolverAsociacion(r.asociacion, indice);
        if (!a) { sinCorrespondencia.set(r.asociacion, (sinCorrespondencia.get(r.asociacion) || 0) + 1); continue; }
        actuales.set(a.id, (actuales.get(a.id) || 0) + 1);
        if (!ultima.get(a.id) || r.fecha > ultima.get(a.id)) ultima.set(a.id, r.fecha);
    }
    const historicoDisponible = Array.isArray(historicoEquivalente);
    const historicos = new Map();
    let historicoSinCorrespondencia = 0;
    if (historicoDisponible) {
        for (const h of historicoEquivalente) {
            const a = h.asociacion_id ? (catalogo.find(x => x.id === h.asociacion_id) || null) : resolverAsociacion(h.asociacion_normalizada || h.asociacion, indice);
            if (!a) { historicoSinCorrespondencia++; continue; }
            historicos.set(a.id, (historicos.get(a.id) || 0) + 1);
        }
    }

    const activas = catalogo.filter(a => a.activa !== false);
    const filas = activas.map(a => {
        const actual = actuales.get(a.id) || 0;
        const hist = historicoDisponible ? (historicos.get(a.id) || 0) : null;
        const { variacion_pct, estado } = etiquetarVariacion(actual, hist, cfg);
        const alertable = a.es_especial !== true && a.incluir_en_alertas !== false;
        return {
            asociacion_id: a.id,
            asociacion: a.nombre,
            zona: a.zona || null,
            rodeos_actuales: actual,
            rodeos_historicos_equivalentes: hist,
            diferencia: hist === null ? null : actual - hist,
            variacion_pct,
            estado,
            historicamente_similar: estado === ESTADOS.SIN_ACTIVIDAD && hist === 0,
            ultima_fecha_actividad: ultima.get(a.id) || null,
            dias_desde_ultimo_rodeo: ultima.get(a.id) && hasta ? diffDays(hasta, ultima.get(a.id)) : null,
            es_especial: a.es_especial === true,
            alertable
        };
    }).sort((a, b) => a.asociacion.localeCompare(b.asociacion, 'es'));

    const alertables = filas.filter(f => f.alertable);
    const cuenta = (lista, e) => lista.filter(f => f.estado === e).length;
    const resultado = {
        catalogo_disponible: true,
        historico_disponible: historicoDisponible,
        asociaciones: filas,
        resumen: {
            total_catalogo: catalogo.length,
            activas: activas.length,
            inactivas: catalogo.length - activas.length,
            especiales_excluidas_de_alertas: filas.filter(f => !f.alertable).length,
            sin_actividad: cuenta(filas, ESTADOS.SIN_ACTIVIDAD),
            sin_actividad_alertables: cuenta(alertables, ESTADOS.SIN_ACTIVIDAD),
            sin_actividad_con_historico_positivo: alertables.filter(f => f.estado === ESTADOS.SIN_ACTIVIDAD && f.rodeos_historicos_equivalentes > 0).length,
            caida_relevante_alertables: cuenta(alertables, ESTADOS.CAIDA_RELEVANTE),
            aumento_alertables: cuenta(alertables, ESTADOS.AUMENTO),
            similar_alertables: cuenta(alertables, ESTADOS.SIMILAR),
            umbral_caida_relevante_pct: cfg.ASOCIACION.CAIDA_RELEVANTE_PCT,
            umbral_aumento_pct: cfg.ASOCIACION.AUMENTO_PCT
        },
        // Solo las alertables: las especiales/excluidas (p. ej. la Federación) nunca figuran como "rezagadas".
        sin_rodeos: alertables.filter(f => f.estado === ESTADOS.SIN_ACTIVIDAD),
        menor_actividad: alertables.filter(f => f.estado === ESTADOS.CAIDA_RELEVANTE && f.variacion_pct !== null)
            .sort((a, b) => a.variacion_pct - b.variacion_pct
                || (b.rodeos_historicos_equivalentes - b.rodeos_actuales) - (a.rodeos_historicos_equivalentes - a.rodeos_actuales)
                || a.asociacion.localeCompare(b.asociacion, 'es'))
        ,
        sin_correspondencia_catalogo: [...sinCorrespondencia.entries()].map(([nombre, rodeos]) => ({ nombre, rodeos })),
        historico_sin_correspondencia: historicoSinCorrespondencia
    };
    resultado.mayores_caidas = resultado.menor_actividad.slice(0, 10);
    return resultado;
}

module.exports = { ESTADOS, construirIndiceCatalogo, resolverAsociacion, etiquetarVariacion, analizarActividadAsociaciones };
