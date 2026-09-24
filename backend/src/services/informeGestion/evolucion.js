// ═════════════════════════════════════════════════════════════════════════
// Evolución entre el CORTE ACTUAL y el CORTE DEPORTIVO ANTERIOR (bloque de rodeo anterior).
//
// Funciones puras sobre dos informes calculados por el MISMO motor (calcularInforme, con datos en memoria):
//   · cambiosCorte:        hasta 6 cambios (acumulado actual vs acumulado al cierre del bloque anterior)
//   · estadoSenales:       NUEVA / SE MANTIENE / RESUELTA con identidad estable (código + entidad)
//   · evolucionAsociaciones: caídas y sin actividad relevante nuevas / persistentes / resueltas
// El sistema muestra evidencia (más / menos / se mantiene); no valora si un cambio es bueno o malo.
// ═════════════════════════════════════════════════════════════════════════
const CONFIG = require('./config');

const get = (o, ruta, def = null) => ruta.split('.').reduce((a, k) => (a === null || a === undefined ? a : a[k]), o) ?? def;
const esNum = v => typeof v === 'number' && Number.isFinite(v);

// ── Identidad estable de señales ─────────────────────────────────────────
// código + entidad (asociación / jurado y categoría). Las señales sin entidad se identifican solo por código.
const ENTIDAD_POR_CODIGO = {
    CAIDA_ACTIVIDAD_ASOCIACION: e => e.asociacion,
    ASOCIACIONES_SIN_RODEOS: e => e.asociacion,
    JURADO_REINCIDENCIA: e => `${e.jurado}|${e.categoria}`
};
function identidadesSenales(senales) {
    const out = new Map();
    for (const s of (senales || [])) {
        const extraer = ENTIDAD_POR_CODIGO[s.codigo];
        if (extraer && Array.isArray(s.evidencia) && s.evidencia.length) {
            for (const e of s.evidencia) {
                const entidad = extraer(e);
                const clave = `${s.codigo}|${entidad}`;
                out.set(clave, { clave, codigo: s.codigo, entidad, entidad_etiqueta: s.codigo === 'JURADO_REINCIDENCIA' ? e.jurado : entidad, titulo: s.titulo, nivel: s.nivel });
            }
        } else {
            out.set(s.codigo, { clave: s.codigo, codigo: s.codigo, entidad: null, entidad_etiqueta: null, titulo: s.titulo, nivel: s.nivel });
        }
    }
    return out;
}

function estadoSenales(senalesActual, senalesAnterior) {
    const act = identidadesSenales(senalesActual), ant = identidadesSenales(senalesAnterior);
    const nuevas = [], persistentes = [], resueltas = [];
    for (const [k, v] of act) (ant.has(k) ? persistentes : nuevas).push(v);
    for (const [k, v] of ant) if (!act.has(k)) resueltas.push(v);
    const porClave = (a, b) => a.clave.localeCompare(b.clave, 'es');
    nuevas.sort(porClave); persistentes.sort(porClave); resueltas.sort(porClave);

    // Estado por señal visible (código): NUEVA si no existía ninguna de sus identidades; SE MANTIENE si existía alguna.
    const porSenal = (senalesActual || []).map(s => {
        const suyas = [...act.values()].filter(v => v.codigo === s.codigo);
        const nSuyasNuevas = suyas.filter(v => !ant.has(v.clave)).length;
        const nSuyasPersistentes = suyas.length - nSuyasNuevas;
        const resueltasSuyas = resueltas.filter(v => v.codigo === s.codigo).length;
        return {
            codigo: s.codigo,
            estado: nSuyasPersistentes === 0 ? 'NUEVA' : 'SE_MANTIENE',
            entidades_nuevas: nSuyasNuevas && nSuyasPersistentes ? nSuyasNuevas : 0,
            entidades_resueltas: resueltasSuyas
        };
    });
    return { disponible: true, nuevas, persistentes, resueltas, por_senal: porSenal, resumen: { nuevas: nuevas.length, persistentes: persistentes.length, resueltas: resueltas.length } };
}
const ESTADO_SENALES_SIN_CORTE = Object.freeze({ disponible: false, motivo: 'SIN_CORTE_ANTERIOR_COMPARABLE', nuevas: [], persistentes: [], resueltas: [], por_senal: [], resumen: { nuevas: null, persistentes: null, resueltas: null } });

// ── Asociaciones: evolución de alertas ───────────────────────────────────
// Menor actividad = CAIDA_RELEVANTE (alertables). Sin actividad relevante = 0 actual y > 0 histórico (0/0 NO es alerta).
function conjuntos(asociaciones, filtro) {
    const m = new Map();
    for (const a of (asociaciones || [])) if (a.alertable && filtro(a)) m.set(a.asociacion, { asociacion: a.asociacion, rodeos_actuales: a.rodeos_actuales, rodeos_historicos_equivalentes: a.rodeos_historicos_equivalentes, variacion_pct: a.variacion_pct });
    return m;
}
function particion(actual, anterior) {
    const nuevas = [], persistentes = [], resueltas = [];
    for (const [k, v] of actual) (anterior.has(k) ? persistentes : nuevas).push(v);
    for (const [k, v] of anterior) if (!actual.has(k)) resueltas.push(v);
    const orden = (a, b) => a.asociacion.localeCompare(b.asociacion, 'es');
    return { nuevas: nuevas.sort(orden), persistentes: persistentes.sort(orden), resueltas: resueltas.sort(orden) };
}
function evolucionAsociaciones(asocActual, asocAnterior) {
    if (!asocActual || !asocAnterior || !asocActual.catalogo_disponible || !asocAnterior.catalogo_disponible) return { disponible: false, nuevas_caidas: [], caidas_persistentes: [], caidas_resueltas: [], sin_actividad_nuevas: [], sin_actividad_persistentes: [], sin_actividad_resueltas: [] };
    const caida = a => a.estado === 'CAIDA_RELEVANTE';
    const sinRel = a => a.estado === 'SIN_ACTIVIDAD' && a.rodeos_actuales === 0 && a.rodeos_historicos_equivalentes > 0;
    const c = particion(conjuntos(asocActual.asociaciones, caida), conjuntos(asocAnterior.asociaciones, caida));
    const s = particion(conjuntos(asocActual.asociaciones, sinRel), conjuntos(asocAnterior.asociaciones, sinRel));
    return {
        disponible: true,
        nuevas_caidas: c.nuevas, caidas_persistentes: c.persistentes, caidas_resueltas: c.resueltas,
        sin_actividad_nuevas: s.nuevas, sin_actividad_persistentes: s.persistentes, sin_actividad_resueltas: s.resueltas
    };
}

// ── Cambios desde el corte anterior (máx. cfg.EJECUTIVO.MAX_CAMBIOS, en orden de prioridad) ──
function contarSeguimiento(inf) {
    const s = (inf.senales || []).find(x => x.codigo === 'JURADO_REINCIDENCIA');
    return s && Array.isArray(s.evidencia) ? s.evidencia.length : 0;
}
function cambio(clave, etiqueta, actual, anterior, extra = {}) {
    const disponible = esNum(actual) && esNum(anterior);
    return { clave, etiqueta, actual: esNum(actual) ? actual : null, anterior: esNum(anterior) ? anterior : null, delta: disponible ? actual - anterior : null, disponible, advertencia: null, ...extra };
}
function cambiosCorte({ actual, anterior, collerasActual = null, collerasAnterior = null }, cfg = CONFIG) {
    const cob = inf => get(inf, 'cobertura.acumulado_temporada.evaluaciones_publicadas', null);
    const alt = inf => get(inf, 'evaluaciones.acumulado_temporada.resultados_alterados', null);
    const aA = alt(actual), aP = alt(anterior);
    const altDisponible = !!aA && !!aP && aA.denominador > 0 && aP.denominador > 0;
    const cobA = cob(actual), cobP = cob(anterior);
    const cobInsuf = (cobA && cobA.interpretable === false) || (cobP && cobP.interpretable === false);
    const cambioAlt = cambio('RESULTADOS_ALTERADOS', 'Resultados alterados', altDisponible ? aA.cantidad : null, altDisponible ? aP.cantidad : null, {
        denominador_actual: aA ? aA.denominador : null, denominador_anterior: aP ? aP.denominador : null,   // evaluaciones publicadas de cada corte
        cobertura_actual: cobA ? cobA.porcentaje : null, cobertura_anterior: cobP ? cobP.porcentaje : null
    });
    if (cobInsuf) cambioAlt.advertencia = 'COBERTURA_INSUFICIENTE';
    if (!altDisponible) cambioAlt.motivo = 'SIN_EVALUACIONES_PUBLICADAS_EN_UN_CORTE';   // ausencia de publicaciones ≠ 0 real

    const asocOk = get(actual, 'asociaciones.catalogo_disponible', false) && get(anterior, 'asociaciones.catalogo_disponible', false);
    const lista = [
        cambio('RODEOS_ACUMULADOS', 'Rodeos acumulados', get(actual, 'acumulado_temporada.rodeos.realizados'), get(anterior, 'acumulado_temporada.rodeos.realizados')),
        cambio('COLLERAS_COMPLETAS', 'Colleras completas', collerasActual, collerasAnterior),
        cambio('RODEOS_CON_FALTA_REGLAMENTARIA', 'Rodeos con falta reglamentaria', get(actual, 'evaluaciones.acumulado_temporada.faltas.reglamentarias.rodeos_con_falta'), get(anterior, 'evaluaciones.acumulado_temporada.faltas.reglamentarias.rodeos_con_falta')),
        cambioAlt,
        cambio('ASOCIACIONES_MENOR_ACTIVIDAD', 'Asociaciones con menor actividad', asocOk ? get(actual, 'asociaciones.resumen.caida_relevante_alertables') : null, asocOk ? get(anterior, 'asociaciones.resumen.caida_relevante_alertables') : null),
        cambio('JURADOS_EN_SEGUIMIENTO', 'Jurados en seguimiento', contarSeguimiento(actual), contarSeguimiento(anterior))
    ];
    if (!lista[1].disponible) lista[1].motivo = 'SIN_MEDICION_ANTERIOR_O_ACTUAL';   // no se inventa un cambio de colleras
    return lista.slice(0, cfg.EJECUTIVO.MAX_CAMBIOS);
}

module.exports = { identidadesSenales, estadoSenales, ESTADO_SENALES_SIN_CORTE, evolucionAsociaciones, cambiosCorte, contarSeguimiento };
