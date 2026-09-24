// ═════════════════════════════════════════════════════════════════════════
// Motor de SEÑALES — 100 % determinístico (sin IA generativa).
//
// Cada señal sale de una regla explícita sobre los datos ya calculados y de
// los umbrales de config.js. Lenguaje neutro: se describen hechos y cifras,
// nunca se califica a personas. Cada señal devuelve:
//   { codigo, nivel, titulo, detalle, valor_actual, referencia, evidencia }
// Niveles: INFO < ATENCION < PRIORIDAD.
// ═════════════════════════════════════════════════════════════════════════
const CONFIG = require('./config');

const ORDEN_NIVEL = { PRIORIDAD: 0, ATENCION: 1, INFO: 2 };

function senal(codigo, nivel, titulo, detalle, valor_actual, referencia, evidencia = null) {
    return { codigo, nivel, titulo, detalle, valor_actual, referencia, evidencia };
}

function nivelPorVariacionBaja(v, cfg) {
    if (v <= cfg.COMPARACION.BAJO_PRIORIDAD_PCT) return 'PRIORIDAD';
    if (v <= cfg.COMPARACION.BAJO_ATENCION_PCT) return 'ATENCION';
    return null;
}

// temporadas = { actual, referencia } (opcional): hace explícita la temporada de cada cifra en el texto de la señal.
function senalesComparacion(prefijo, nombre, comp, cfg, temporadas = null) {
    if (!comp || comp.variacion_pct === null || comp.variacion_pct === undefined) return [];
    const v = comp.variacion_pct;
    const ref = `${nombre} en ${temporadas && temporadas.referencia ? temporadas.referencia : 'la temporada anterior'} a fecha equivalente: ${comp.historico}`;
    const cifra = `${comp.actual}${temporadas && temporadas.actual ? ` (${temporadas.actual})` : ''} vs ${comp.historico}${temporadas && temporadas.referencia ? ` (${temporadas.referencia})` : ''}`;
    if (v >= cfg.COMPARACION.SOBRE_INFO_PCT) {
        return [senal(`${prefijo}_SOBRE_HISTORICO`, 'INFO', `${nombre} sobre el histórico`,
            `${nombre}: ${cifra} a fecha equivalente (${v > 0 ? '+' : ''}${v} %).`, comp.actual, ref, { variacion_pct: v })];
    }
    const nivel = nivelPorVariacionBaja(v, cfg);
    if (nivel) {
        return [senal(`${prefijo}_BAJO_HISTORICO`, nivel, `${nombre} bajo el histórico`,
            `${nombre}: ${cifra} a fecha equivalente (${v} %).`, comp.actual, ref, { variacion_pct: v })];
    }
    return [];
}

function generarSenales({ comparacionRodeos, comparacionColleras, asociaciones, alterados, jurados, cobertura, temporadas = null }, cfg = CONFIG) {
    const out = [];

    // Asociaciones sin rodeos / caída de actividad (solo alertables)
    if (asociaciones && asociaciones.catalogo_disponible) {
        const alertables = asociaciones.asociaciones.filter(a => a.alertable);
        const sin = alertables.filter(a => a.estado === 'SIN_ACTIVIDAD');
        if (sin.length) {
            const conHist = sin.filter(a => a.rodeos_historicos_equivalentes > 0).length;
            // 0 actual con histórico > 0 = alerta; 0 vs 0 = comportamiento históricamente similar (INFO).
            out.push(senal('ASOCIACIONES_SIN_RODEOS',
                conHist >= cfg.ASOCIACION.SIN_ACTIVIDAD_PRIORIDAD_DESDE ? 'PRIORIDAD' : (conHist > 0 ? 'ATENCION' : 'INFO'),
                `${sin.length} asociación(es) sin rodeos registrados en la temporada`,
                `${sin.length} asociación(es) activas no registran rodeos realizados a la fecha; ${conHist} de ellas sí tenían rodeos a esta altura de ${temporadas && temporadas.referencia ? temporadas.referencia : 'la temporada anterior'}${conHist === 0 ? ' (comportamiento históricamente similar)' : ''}.`,
                sin.length, `${conHist} con histórico equivalente > 0`,
                sin.map(a => ({ asociacion: a.asociacion, rodeos_actuales: a.rodeos_actuales, rodeos_historicos_equivalentes: a.rodeos_historicos_equivalentes }))));
        }
        const caidas = alertables.filter(a => a.estado === 'CAIDA_RELEVANTE');
        if (caidas.length) {
            out.push(senal('CAIDA_ACTIVIDAD_ASOCIACION', 'ATENCION',
                `${caidas.length} asociación(es) con menor actividad vs fecha equivalente`,
                `Variación igual o inferior a -${asociaciones.resumen.umbral_caida_relevante_pct} % respecto de ${temporadas && temporadas.referencia ? `${temporadas.referencia} (misma etapa de la temporada anterior)` : 'la misma etapa de la temporada anterior'}${temporadas && temporadas.actual ? ` para ${temporadas.actual}` : ''}.`,
                caidas.length, `umbral: -${asociaciones.resumen.umbral_caida_relevante_pct} %`,
                caidas.map(a => ({ asociacion: a.asociacion, actual: a.rodeos_actuales, historico: a.rodeos_historicos_equivalentes, variacion_pct: a.variacion_pct }))));
        }
    }

    out.push(...senalesComparacion('RODEOS', 'Rodeos realizados', comparacionRodeos, cfg, temporadas));
    out.push(...senalesComparacion('COLLERAS', 'Colleras completas', comparacionColleras, cfg, temporadas));

    // Resultados alterados: aumento de puntos porcentuales entre períodos consecutivos
    if (alterados && alterados.periodo && alterados.anterior) {
        const a = alterados.periodo, b = alterados.anterior;
        const min = cfg.ALTERADOS.DENOMINADOR_MINIMO;
        if (a.denominador >= min && b.denominador >= min && a.porcentaje !== null && b.porcentaje !== null) {
            const pp = Math.round((a.porcentaje - b.porcentaje) * 10) / 10;
            if (pp >= cfg.ALTERADOS.AUMENTO_PUNTOS_PORCENTUALES) {
                out.push(senal('AUMENTO_RESULTADOS_ALTERADOS', 'ATENCION', 'Aumento de resultados alterados respecto del período anterior',
                    `${a.cantidad}/${a.denominador} evaluaciones publicadas (${a.porcentaje} %) vs ${b.cantidad}/${b.denominador} (${b.porcentaje} %) en el período anterior.`,
                    a.porcentaje, b.porcentaje, { variacion_puntos_porcentuales: pp }));
            }
        }
    }

    // Jurados con racha reciente. Resultado alterado y situaciones son datos del RODEO
    // (no atribuibles a un jurado): la señal describe participación en rodeos, exige
    // muestra >= LIMITADA y no afirma autoría.
    if (jurados && Array.isArray(jurados.detalle)) {
        const rachas = jurados.detalle.filter(j => j.nivel_muestra !== 'INSUFICIENTE'
            && (j.racha_actual_rodeos_con_falta_reglamentaria >= cfg.JURADO.RACHA_FALTAS_REGLAMENTARIAS || j.racha_actual_rodeos_con_resultado_alterado >= cfg.JURADO.RACHA_ALTERADOS));
        if (rachas.length) {
            out.push(senal('JURADO_REINCIDENCIA', 'ATENCION',
                `${rachas.length} jurado(s) en seguimiento por actuaciones consecutivas recientes`,
                `Rachas de ${cfg.JURADO.RACHA_FALTAS_REGLAMENTARIAS}+ rodeos con caso reglamentario o ${cfg.JURADO.RACHA_ALTERADOS}+ con resultado alterado. Son datos del rodeo: no se atribuyen a la persona.`,
                rachas.length, `umbral reglamentarias: ${cfg.JURADO.RACHA_FALTAS_REGLAMENTARIAS} · alterados: ${cfg.JURADO.RACHA_ALTERADOS}`,
                rachas.map(j => ({
                    jurado: j.jurado, categoria: j.categoria, actuaciones: j.tamano_muestra, nivel_muestra: j.nivel_muestra,
                    racha_rodeos_con_falta_reglamentaria: j.racha_actual_rodeos_con_falta_reglamentaria,
                    racha_rodeos_con_resultado_alterado: j.racha_actual_rodeos_con_resultado_alterado,
                    // Motivo concreto de inclusión (los que superan el umbral); solo presentación, no cambia el criterio.
                    motivos: [
                        ...(j.racha_actual_rodeos_con_falta_reglamentaria >= cfg.JURADO.RACHA_FALTAS_REGLAMENTARIAS ? ['CASO_REGLAMENTARIO'] : []),
                        ...(j.racha_actual_rodeos_con_resultado_alterado >= cfg.JURADO.RACHA_ALTERADOS ? ['RESULTADO_ALTERADO'] : [])
                    ]
                }))));
        }
    }

    // Cobertura de datos
    if (cobertura) {
        const cob = (bloque, codigo, nombre) => {
            if (!bloque || bloque.denominador <= 0 || bloque.cobertura === null) return;
            const nivel = bloque.cobertura < cfg.COBERTURA.BAJA_PRIORIDAD ? 'PRIORIDAD' : bloque.cobertura < cfg.COBERTURA.BAJA_ATENCION ? 'ATENCION' : null;
            if (nivel) {
                out.push(senal(codigo, nivel, `Baja cobertura de ${nombre}`,
                    `${bloque.numerador}/${bloque.denominador} rodeos realizados (${bloque.porcentaje} %). Los indicadores que dependen de este dato no deben leerse como ausencia real.`,
                    bloque.cobertura, `mínimo para interpretar: ${cfg.COBERTURA.MINIMA_INTERPRETAR}`));
            }
        };
        cob(cobertura.evaluaciones_publicadas, 'BAJA_COBERTURA_EVALUACIONES', 'evaluaciones publicadas');
        cob(cobertura.cartillas_jurado, 'BAJA_COBERTURA_CARTILLAS', 'cartillas de jurado');
    }

    return out.sort((a, b) => ORDEN_NIVEL[a.nivel] - ORDEN_NIVEL[b.nivel] || a.codigo.localeCompare(b.codigo));
}

module.exports = { ORDEN_NIVEL, generarSenales };
