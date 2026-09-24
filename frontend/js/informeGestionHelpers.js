// ═════════════════════════════════════════════════════════════════════════
// Informe de Gestión Deportiva — helpers de PRESENTACIÓN (puros, testeables con Jest).
//
// NO calculan indicadores: el backend (GET /admin/informe-gestion/datos) ya entrega
// todos los valores. Aquí solo se formatean, se decide cómo advertir la cobertura y
// se adaptan las series a datasets de Chart.js (preservando null: sin dato ≠ 0).
//
// Funciona igual cargado por <script src="/js/..."> (define globales) o por require()
// en Node (exporta module.exports, inerte en el navegador).
// ═════════════════════════════════════════════════════════════════════════

const IG_NUM = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 });
function _decimal(n, d) { return new Intl.NumberFormat('es-CL', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n); }
function esNulo(v) { return v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v)); }

function fmtEntero(n) { return esNulo(n) ? '—' : IG_NUM.format(n); }
function fmtDecimal(n, d = 1) { return esNulo(n) ? '—' : _decimal(n, d); }
function fmtNota(n) { return esNulo(n) ? '—' : _decimal(n, 1); }
// Porcentaje con coma decimal: 45,5 %. Sin dato → "SIN DATOS" (nunca "0 %").
function fmtPct(p, d = 1) { return esNulo(p) ? 'SIN DATOS' : `${_decimal(p, d)} %`; }
function fmtPctSigno(p, d = 1) { return esNulo(p) ? '—' : `${p > 0 ? '+' : ''}${_decimal(p, d)} %`; }
function fmtDif(n) { return esNulo(n) ? '—' : `${n > 0 ? '+' : ''}${IG_NUM.format(n)}`; }
function fmtFecha(iso) { return /^\d{4}-\d{2}-\d{2}/.test(iso || '') ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—'; }
function fmtFechaCorta(iso) { return /^\d{4}-\d{2}-\d{2}/.test(iso || '') ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '—'; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ── Cobertura ────────────────────────────────────────────────────────────
// bloque = { numerador, denominador, porcentaje, interpretable } (tal como lo entrega el backend)
// Sin denominador → SIN DATOS. interpretable=false → COBERTURA INSUFICIENTE (valor visible, sin
// color de conclusión: la clase 'gris' evita rojo/verde).
function estadoCobertura(b) {
    if (!b || esNulo(b.denominador) || b.denominador === 0) return { estado: 'SIN_DATOS', etiqueta: 'SIN DATOS', clase: 'gris' };
    if (b.interpretable === false) return { estado: 'INSUFICIENTE', etiqueta: 'COBERTURA INSUFICIENTE', clase: 'gris' };
    return { estado: 'OK', etiqueta: '', clase: '' };
}
function textoNSobreTotal(num, den) { return (esNulo(den) || den === 0) ? 'SIN DATOS' : `${fmtEntero(num)} / ${fmtEntero(den)}`; }
// Para indicadores con numerador/denominador propios (alterados, ganado…): "X / N" + "%"
function textoIndicador(num, den, pct) { return { fraccion: textoNSobreTotal(num, den), pct: (esNulo(den) || den === 0) ? 'SIN DATOS' : fmtPct(pct) }; }

// ── Variación ────────────────────────────────────────────────────────────
// Verde = sobre la referencia, amarillo = bajo la referencia (atención), azul = igual. El rojo se
// reserva a señales de PRIORIDAD (no se usa para variaciones simples). Siempre con flecha (no solo color).
function flechaVariacion(v) { if (esNulo(v)) return '·'; return v > 0 ? '↑' : v < 0 ? '↓' : '='; }
function claseVariacion(v) { if (esNulo(v)) return 'gris'; return v > 0 ? 'verde' : v < 0 ? 'amarillo' : 'azul'; }

// ── Tipos de rodeo: máx. N + OTROS ────────────────────────────────────────
function agruparTiposOtros(lista, max = 8) {
    const orden = [...(lista || [])].sort((a, b) => (b.actual + (b.historico || 0)) - (a.actual + (a.historico || 0)) || String(a.clave).localeCompare(String(b.clave), 'es'));
    if (orden.length <= max) return orden;
    const top = orden.slice(0, max);
    const resto = orden.slice(max);
    const suma = k => resto.reduce((s, x) => s + (esNulo(x[k]) ? 0 : x[k]), 0);
    return [...top, { clave: 'OTROS', actual: suma('actual'), historico: suma('historico'), agrupado: resto.length }];
}

// ── Señales ──────────────────────────────────────────────────────────────
const NIVEL_SENAL = { INFO: { etiqueta: 'INFO', clase: 'azul' }, ATENCION: { etiqueta: 'ATENCIÓN', clase: 'amarillo' }, PRIORIDAD: { etiqueta: 'PRIORIDAD', clase: 'rojo' } };
function nivelSenal(n) { return NIVEL_SENAL[n] || NIVEL_SENAL.INFO; }
// Lenguaje de presentación: el seguimiento de jurados nunca se rotula como reincidencia ni juicio personal.
function etiquetaTipoSenal(codigo) {
    if (codigo === 'JURADO_REINCIDENCIA') return 'SEÑAL DE SEGUIMIENTO';
    return null;
}
function senalesParaPantalla(senales, max = 6) { return (senales || []).slice(0, max); }
// Dato de una señal para mostrar: las de cobertura traen una fracción (0,455) que se muestra como porcentaje.
function valorSenal(s) {
    if (!s || esNulo(s.valor_actual)) return '—';
    if (typeof s.valor_actual !== 'number') return String(s.valor_actual);
    if (String(s.codigo || '').startsWith('BAJA_COBERTURA')) return fmtPct(s.valor_actual * 100);
    return Number.isInteger(s.valor_actual) ? fmtEntero(s.valor_actual) : _decimal(s.valor_actual, 2);
}
// Enteros sin decimales (28), no enteros con 1 decimal (28,5).
function fmtPromedio(n) { return esNulo(n) ? '—' : (Number.isInteger(n) ? IG_NUM.format(n) : _decimal(n, 1)); }

// ── Proyección ───────────────────────────────────────────────────────────
const MOTIVOS_PROYECCION = {
    SIN_TEMPORADA_COMPARABLE_CON_AVANCE_SUFICIENTE: 'Avance histórico insuficiente',
    SIN_HISTORICO: 'Sin dato histórico comparable',
    SIN_DATO_ACTUAL: 'Sin dato actual'
};
function motivoProyeccion(codigo) { return MOTIVOS_PROYECCION[codigo] || 'Proyección no disponible'; }
function estadoProyeccion(p) {
    if (!p || p.estado !== 'PROYECCION_DISPONIBLE') return { disponible: false, texto: 'Sin proyección aún', motivo: motivoProyeccion(p && p.motivo) };
    return { disponible: true, texto: fmtEntero(p.estimacion), confianza: p.confianza, etiqueta: p.confianza === 'REFERENCIAL' ? 'PROYECCIÓN REFERENCIAL' : `PROYECCIÓN · ${String(p.confianza || '').replace(/_/g, ' ')}` };
}

// ── Jurados (lenguaje obligatorio: participación en rodeos, no autoría) ───
const ETIQUETA_MUESTRA = { SUFICIENTE: 'Muestra suficiente', LIMITADA: 'Muestra limitada', INSUFICIENTE: 'Muestra insuficiente' };
function etiquetaMuestra(n) { return ETIQUETA_MUESTRA[n] || '—'; }
// Dos líneas: universo (rodeos evaluados con resultado publicado) y participación en rodeos con resultado alterado.
function textoParticipacionAlterados(j) {
    if (!j || esNulo(j.denominador_rodeos_publicados) || j.denominador_rodeos_publicados === 0) return 'Rodeos evaluados con resultado publicado: SIN DATOS';
    const n = j.rodeos_con_resultado_alterado_en_que_participo;
    const d = j.denominador_rodeos_publicados;
    return `Rodeos evaluados: ${fmtEntero(d)} · Participó en ${fmtEntero(n)} rodeo(s) con resultado alterado (${fmtEntero(n)} / ${fmtEntero(d)} = ${fmtPct(j.porcentaje_rodeos_con_resultado_alterado_en_que_participo, 0)})`;
}
const AVISO_ALTERADOS = 'El indicador corresponde al rodeo y no atribuye individualmente la alteración al jurado.';

// ── Datasets para Chart.js (preservan null; no interpolan) ────────────────
function datasetsRodeosAcumulados(serie) {
    const p = (serie && serie.puntos) || [];
    return {
        labels: p.map(x => x.etiqueta),
        actual: p.map(x => (esNulo(x.actual) ? null : x.actual)),
        historico: p.map(x => (esNulo(x.historico) ? null : x.historico)),
        calendario: p.map(x => (esNulo(x.calendario_cargado) ? null : x.calendario_cargado)),
        referencia: serie ? serie.temporada_referencia : null
    };
}
// Colleras: cada temporada como puntos {x: días desde el inicio de la temporada actual, y: valor}
function datasetsColleras(serie) {
    return ((serie && serie.temporadas) || []).map(t => ({
        temporada: t.temporada,
        k: t.k,
        actual: !!t.actual,
        puntos: (t.puntos || []).filter(q => !esNulo(q.valor)).map(q => ({ x: q.x_dias, y: q.valor, fecha: q.fecha, fuente: q.fuente }))
    }));
}
function datasetsSituaciones(serie) {
    const p = (serie && serie.puntos) || [];
    return {
        labels: p.map(x => [x.etiqueta, `${x.evaluaciones_publicadas}/${x.rodeos_realizados} pub.`]),
        reglamentarias: p.map(x => (esNulo(x.rodeos_con_falta_reglamentaria) ? null : x.rodeos_con_falta_reglamentaria)),
        alterados: p.map(x => (esNulo(x.rodeos_con_resultado_alterado) ? null : x.rodeos_con_resultado_alterado)),
        alteradosInterpretables: p.map(x => !!x.interpretable_alterados)
    };
}
function sparkline(ultimasNotas) { return (ultimasNotas || []).filter(x => !esNulo(x.nota)).map(x => x.nota); }

// ── Interpretación: numeración, temporadas explícitas, diferencias ────────
// La numeración se dibuja como texto (no con contadores CSS): así sale correcta en pantalla y en el PDF.
function textoPagina(n, total = 10) { return `Página ${n} de ${total}`; }

// Temporadas de las comparaciones: SIEMPRE desde los datos (nunca escritas a mano).
function temporadasComparacion(d) {
    const actual = (d && d.metadata && d.metadata.temporada && d.metadata.temporada.nombre) || 'Temporada actual';
    const h = d && d.comparacion && d.comparacion.referencia && d.comparacion.referencia.temporada;
    return { actual, historica: h || 'Temporada anterior', historicaEq: `${h || 'Temporada anterior'} (fecha equivalente)`, hayHistorica: !!h };
}

// Diferencia contra la referencia: el texto depende del signo. Con 0 NUNCA se dice "adelantados/atrasados".
function textoDiferencia(dif, { uno = 'rodeo', varios = 'rodeos', referencia = 'histórico equivalente' } = {}) {
    if (esNulo(dif)) return '';
    if (dif === 0) return `Igual al ${referencia}`;
    const n = Math.abs(dif);
    return `${fmtEntero(n)} ${n === 1 ? uno : varios} ${dif > 0 ? 'sobre' : 'bajo'} el ${referencia}`;
}

// "18–21/09/2025" o "30/09/2025–02/10/2025"
function textoRangoFechas(desde, hasta) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(desde || '') || !/^\d{4}-\d{2}-\d{2}/.test(hasta || '')) return '—';
    if (desde === hasta) return fmtFecha(desde);
    if (desde.slice(0, 7) === hasta.slice(0, 7)) return `${desde.slice(8, 10)}–${fmtFecha(hasta)}`;
    return `${fmtFecha(desde)}–${fmtFecha(hasta)}`;
}

// ── Ranking de jurados: la muestra suficiente y la limitada son NIVELES distintos ──
// No cambia notas, promedios ni el orden interno: solo separa los grupos para que la numeración no continúe.
function agruparPorMuestra(lista) {
    const suficiente = [], limitada = [];
    (lista || []).forEach(x => (x.nivel_muestra === 'SUFICIENTE' ? suficiente : limitada).push(x));
    return { suficiente, limitada };
}

// ── Colleras: referencia histórica según cuántas temporadas comparables hay ──
// 0 → sin referencia · 1 → "referencia histórica disponible" (sin promedio ni máximo) · 2+ → promedio y máximo.
// "Sin dato" nunca se toma como 0: solo cuentan las filas con estado OK.
function referenciaHistoricaColleras(comparacion) {
    const ok = ((comparacion && comparacion.temporadas) || []).filter(t => t.estado === 'OK' && !esNulo(t.historico));
    if (ok.length === 0) return { modo: 'SIN_REFERENCIA', comparables: 0, titulo: 'Sin referencia histórica comparable', valor: 'SIN DATOS', subtexto: 'Ninguna temporada con medición comparable', temporadas: [] };
    if (ok.length === 1) return { modo: 'REFERENCIA_UNICA', comparables: 1, titulo: 'Referencia histórica disponible', valor: fmtEntero(ok[0].historico), subtexto: `1 temporada comparable · ${ok[0].temporada}`, temporadas: [ok[0].temporada] };
    const vals = ok.map(t => t.historico);
    return {
        modo: 'PROMEDIO_MAXIMO', comparables: ok.length, titulo: 'Promedio histórico', valor: fmtPromedio(vals.reduce((a, b) => a + b, 0) / vals.length),
        tituloMaximo: 'Máximo histórico', valorMaximo: fmtEntero(Math.max(...vals)), subtexto: `${ok.length} temporadas comparables · ${ok.map(t => t.temporada).join(', ')}`, temporadas: ok.map(t => t.temporada)
    };
}

// ── Jurados en seguimiento: motivo concreto (evidencia del motor, sin texto genérico) ──
function motivoSeguimiento(e, umbrales = { reglamentarias: 2, alterados: 2 }) {
    if (!e) return null;
    const regl = e.racha_rodeos_con_falta_reglamentaria || 0, alt = e.racha_rodeos_con_resultado_alterado || 0;
    const m = Array.isArray(e.motivos) ? e.motivos : [...(regl >= umbrales.reglamentarias ? ['CASO_REGLAMENTARIO'] : []), ...(alt >= umbrales.alterados ? ['RESULTADO_ALTERADO'] : [])];
    const tieneR = m.includes('CASO_REGLAMENTARIO'), tieneA = m.includes('RESULTADO_ALTERADO');
    if (tieneR && tieneA) return `Resultado alterado + caso reglamentario: ${fmtEntero(alt)} y ${fmtEntero(regl)} actuaciones consecutivas`;
    if (tieneA) return `${fmtEntero(alt)} actuaciones consecutivas en rodeos con resultado alterado`;
    if (tieneR) return `${fmtEntero(regl)} actuaciones consecutivas en rodeos con caso reglamentario`;
    return null;
}

// ── Resumen ejecutivo: cuerpo de jurados (todo desde el motor) ──
function resumenCuerpoJurados(d) {
    const pc = (d && d.jurados && d.jurados.por_categoria) || {};
    const categorias = ['A', 'B', 'C'].map(k => ({ categoria: k, jurados: pc[k] ? pc[k].cantidad_jurados : null, promedio: pc[k] ? pc[k].nota_promedio : null, actuaciones: pc[k] ? pc[k].actuaciones : null }));
    const r = (d && d.jurados && d.jurados.resumen) || {};
    return { categorias, distintos: esNulo(r.jurados_distintos_con_actuaciones) ? null : r.jurados_distintos_con_actuaciones };
}

// ── Bloques de rodeo (serie situaciones_por_bloque) ──
// Total de rodeos = barra. Faltas y alterados son indicadores INDEPENDIENTES (no se apilan). null = sin dato (no 0).
function datasetsBloques(serie) {
    const p = (serie && serie.puntos) || [];
    return {
        labels: p.map(x => x.etiqueta),
        totales: p.map(x => x.rodeos_realizados),
        faltas: p.map(x => (esNulo(x.rodeos_con_falta_reglamentaria) ? null : x.rodeos_con_falta_reglamentaria)),
        faltasInterpretables: p.map(x => !!x.interpretable_faltas),
        alterados: p.map(x => (esNulo(x.rodeos_con_resultado_alterado) || !x.denominador_alterados ? null : x.rodeos_con_resultado_alterado)),
        alteradosInterpretables: p.map(x => !!x.interpretable_alterados),
        puntos: p
    };
}
// Líneas de lectura de un bloque (tooltip en pantalla y "lectura del último bloque" en el PDF).
function lecturaBloque(b) {
    if (!b) return null;
    const cobPct = esNulo(b.cobertura_publicadas) ? null : b.cobertura_publicadas * 100;
    return {
        titulo: b.etiqueta,
        total: `${fmtEntero(b.rodeos_realizados)} ${b.rodeos_realizados === 1 ? 'rodeo realizado' : 'rodeos realizados'}`,
        evaluaciones: `Evaluaciones existentes: ${textoNSobreTotal(b.evaluaciones_existentes, b.rodeos_realizados)} · publicadas: ${textoNSobreTotal(b.evaluaciones_publicadas, b.rodeos_realizados)}`,
        faltas: b.denominador_faltas ? `Falta reglamentaria: ${fmtEntero(b.rodeos_con_falta_reglamentaria)} de ${fmtEntero(b.denominador_faltas)} rodeos con evaluación (${fmtPct(b.porcentaje_faltas)})` : 'Falta reglamentaria: SIN DATOS (0 evaluaciones)',
        cobertura: `Cobertura de publicadas: ${textoNSobreTotal(b.evaluaciones_publicadas, b.rodeos_realizados)}${cobPct === null ? '' : ` (${fmtPct(cobPct)})`}`,
        alterados: b.denominador_alterados ? `Resultados alterados: ${fmtEntero(b.rodeos_con_resultado_alterado)} / ${fmtEntero(b.denominador_alterados)} evaluaciones publicadas (${fmtPct(b.porcentaje_alterados)})` : `Resultados alterados: SIN DATOS (publicadas ${textoNSobreTotal(b.evaluaciones_publicadas, b.rodeos_realizados)})`
    };
}

// ── Bloque de rodeo vs período seleccionado ──
// "18–20 SEP" (misma convención que la etiqueta del bloque, calculada en el backend).
const MESES_CORTOS = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
function etiquetaRangoCorto(desde, hasta) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(desde || '') || !/^\d{4}-\d{2}-\d{2}/.test(hasta || '')) return '—';
    const d = iso => iso.slice(8, 10), m = iso => MESES_CORTOS[Number(iso.slice(5, 7)) - 1];
    if (desde === hasta) return `${d(desde)} ${m(desde)}`;
    if (desde.slice(0, 7) === hasta.slice(0, 7)) return `${d(desde)}–${d(hasta)} ${m(desde)}`;
    return `${d(desde)} ${m(desde)}–${d(hasta)} ${m(hasta)}`;
}
// Aclaración "bloque ≠ período": solo existe cuando el período seleccionado corresponde a UN bloque de rodeo y
// (el total del bloque difiere del total del período O el bloque se sale del rango seleccionado). Todo dinámico.
// Devuelve null si no hay nada que aclarar (sin ruido visual en otros períodos).
function notaBloquePeriodo(d) {
    const puntos = (d && d.series && d.series.situaciones_por_bloque && d.series.situaciones_por_bloque.puntos) || [];
    const rango = d && d.periodo && d.periodo.rango;
    const totalPeriodo = d && d.periodo && d.periodo.rodeos ? d.periodo.rodeos.realizados : null;
    if (!rango || esNulo(totalPeriodo)) return null;
    const cruzan = puntos.filter(b => b.bloque_inicio <= rango.hasta && b.bloque_fin >= rango.desde);
    if (cruzan.length !== 1) return null;
    const b = cruzan[0];
    const excede = b.bloque_inicio < rango.desde || b.bloque_fin > rango.hasta;
    if (b.rodeos_realizados === totalPeriodo && !excede) return null;
    const ps = b.periodo_seleccionado || {};
    const antes = ps.rodeos_inicio_antes || 0, despues = ps.rodeos_inicio_despues || 0;
    const plural = (n, uno, varios) => (n === 1 ? uno : varios);
    const partes = [];
    if (antes > 0) partes.push(`${fmtEntero(antes)} ${plural(antes, 'rodeo comenzó', 'rodeos comenzaron')} antes del período seleccionado y ${plural(antes, 'termina', 'terminan')} dentro del bloque`);
    if (despues > 0) partes.push(`${fmtEntero(despues)} ${plural(despues, 'rodeo comienza', 'rodeos comienzan')} después del período seleccionado y ${plural(despues, 'pertenece', 'pertenecen')} al mismo bloque`);
    const motivo = partes.length ? `La diferencia se debe a que ${partes.join(' y ')}.` : 'La diferencia corresponde a rodeos del bloque cuya fecha de inicio está fuera del rango seleccionado.';
    const etqBloque = b.etiqueta, etqPeriodo = etiquetaRangoCorto(rango.desde, rango.hasta);
    return {
        bloque: { etiqueta: etqBloque, inicio: b.bloque_inicio, fin: b.bloque_fin, total: b.rodeos_realizados },
        periodo: { etiqueta: etqPeriodo, desde: rango.desde, hasta: rango.hasta, total: totalPeriodo },
        motivo,
        texto: `Nota de lectura: el bloque ${etqBloque} contiene ${fmtEntero(b.rodeos_realizados)} ${plural(b.rodeos_realizados, 'rodeo', 'rodeos')}, mientras el período seleccionado ${etqPeriodo} contiene ${fmtEntero(totalPeriodo)}. ${motivo}`
    };
}
const TEXTO_BLOQUE_VS_PERIODO = 'Bloque deportivo y período seleccionado pueden no coincidir exactamente cuando un rodeo se extiende o pertenece a un bloque que comienza fuera del rango seleccionado.';

// ═══ Capa ejecutiva (Directorio) — solo presentación de lo que entrega el backend ═══
// Cambios desde el CORTE DEPORTIVO ANTERIOR (bloque de rodeo anterior; no es "el informe anterior").
function resumenEvolucion(d) {
    const e = d && d.evolucion_corte;
    if (!e || e.disponible !== true) return { disponible: false, etiqueta: 'SIN CORTE ANTERIOR COMPARABLE', cambios: [] };
    const cambios = (e.cambios || []).map(c => {
        const base = { clave: c.clave, etiqueta: c.etiqueta, advertencia: c.advertencia || null };
        if (!c.disponible) return { ...base, valor: 'SIN DATO', detalle: c.clave === 'COLLERAS_COMPLETAS' ? 'Sin medición anterior' : 'Sin dato comparable', sinDato: true };
        const valor = c.delta === 0 ? '0' : fmtDif(c.delta);
        const detalle = c.clave === 'RESULTADOS_ALTERADOS'
            ? `${fmtEntero(c.actual)} / ${fmtEntero(c.denominador_actual)} vs ${fmtEntero(c.anterior)} / ${fmtEntero(c.denominador_anterior)} publicadas`
            : `${fmtEntero(c.actual)} vs ${fmtEntero(c.anterior)}${c.delta === 0 ? ' · sin cambio' : ''}`;
        return { ...base, valor, detalle, sinDato: false };
    });
    return {
        disponible: true, etiqueta: null,
        actual: `${fmtFecha(e.actual.corte)} · bloque ${e.actual.bloque.etiqueta}`,
        anterior: `${fmtFecha(e.anterior.corte)} · bloque ${e.anterior.bloque.etiqueta}`,
        cambios
    };
}

// Señales: NUEVA / SE MANTIENE / RESUELTA respecto del corte deportivo anterior (identidad = código + entidad).
const NOMBRE_SENAL = { CAIDA_ACTIVIDAD_ASOCIACION: 'Menor actividad', ASOCIACIONES_SIN_RODEOS: 'Sin rodeos', JURADO_REINCIDENCIA: 'Jurado en seguimiento', BAJA_COBERTURA_EVALUACIONES: 'Baja cobertura de evaluaciones', BAJA_COBERTURA_CARTILLAS: 'Baja cobertura de cartillas', COLLERAS_SOBRE_HISTORICO: 'Colleras sobre el histórico', COLLERAS_BAJO_HISTORICO: 'Colleras bajo el histórico', RODEOS_SOBRE_HISTORICO: 'Rodeos sobre el histórico', RODEOS_BAJO_HISTORICO: 'Rodeos bajo el histórico' };
function chipEstadoSenal(codigo, estadoSenales) {
    if (!estadoSenales || estadoSenales.disponible !== true) return null;
    const s = (estadoSenales.por_senal || []).find(x => x.codigo === codigo);
    if (!s) return null;
    const partes = [];
    if (s.entidades_nuevas > 0) partes.push(`+${fmtEntero(s.entidades_nuevas)} ${s.entidades_nuevas === 1 ? 'nueva' : 'nuevas'}`);
    if (s.entidades_resueltas > 0) partes.push(`−${fmtEntero(s.entidades_resueltas)} ${s.entidades_resueltas === 1 ? 'resuelta' : 'resueltas'}`);
    return { texto: s.estado === 'NUEVA' ? 'NUEVA' : 'SE MANTIENE', clase: s.estado === 'NUEVA' ? 'nueva' : 'mantiene', detalle: partes.join(' · ') };
}
function resumenEstadoSenales(estadoSenales, maxVisibles = 3) {
    if (!estadoSenales || estadoSenales.disponible !== true) return { disponible: false, etiqueta: 'SIN CORTE ANTERIOR COMPARABLE' };
    const r = estadoSenales.resumen || {};
    const etiqueta = x => `${NOMBRE_SENAL[x.codigo] || x.titulo}${x.entidad_etiqueta ? `: ${x.entidad_etiqueta}` : ''}`;
    const res = estadoSenales.resueltas || [];
    return { disponible: true, nuevas: r.nuevas, persistentes: r.persistentes, resueltas: r.resueltas, resueltasVisibles: res.slice(0, maxVisibles).map(etiqueta), resueltasExtra: Math.max(0, res.length - maxVisibles) };
}

// Concentración por asociación (no por jurado).
function textoConcentracionFaltas(f) {
    if (!f || !f.total_rodeos_afectados) return 'Sin rodeos con falta reglamentaria en el acumulado.';
    const n = (f.top || []).length;
    return `Las ${n} asociaciones con más rodeos afectados concentran el ${fmtPct(f.porcentaje_en_top)} de los rodeos con falta reglamentaria (${fmtEntero(f.rodeos_en_top)} de ${fmtEntero(f.total_rodeos_afectados)}).`;
}
function textoConcentracionAlterados(a) {
    if (!a || !a.total_publicadas) return 'SIN DATOS: no hay evaluaciones publicadas en el acumulado.';
    if (!a.total_alterados) return `Sin resultados alterados entre ${fmtEntero(a.total_publicadas)} evaluaciones publicadas.`;
    const n = (a.top || []).length;
    return `Las ${n} asociaciones con más rodeos con resultado alterado reúnen el ${fmtPct(a.porcentaje_en_top)} de los ${fmtEntero(a.total_alterados)} (de ${fmtEntero(a.total_publicadas)} evaluaciones publicadas).`;
}

// Utilización del cuerpo de jurados (indicadores de uso; no evaluación de las personas). Umbrales: vienen del backend.
function resumenUtilizacion(d) {
    const u = d && d.utilizacion_jurados;
    if (!u) return null;
    const c = u.concentracion_designaciones || {};
    return {
        sinDesignacion: { valor: fmtEntero(u.disponibles_sin_designacion.cantidad), sub: `de ${fmtEntero(u.disponibles_sin_designacion.sobre_con_declaracion)} con disponibilidad declarada` },
        altaBaja: { valor: fmtEntero(u.alta_disponibilidad_baja_utilizacion.cantidad), sub: `Criterio: ${u.alta_disponibilidad_baja_utilizacion.criterio}.` },
        concentracion: c.porcentaje_designaciones_en_top === null || c.porcentaje_designaciones_en_top === undefined
            ? { valor: 'SIN DATOS', sub: 'Sin designaciones efectivas' }
            : { valor: `${fmtPct(c.porcentaje_designaciones_en_top, 0)}`, sub: `El ${fmtEntero(c.porcentaje_jurados_top)} % de los jurados (${fmtEntero(c.jurados_en_top)} de ${fmtEntero(c.jurados_considerados)}) reúne ${fmtPct(c.porcentaje_designaciones_en_top, 0)} de ${fmtEntero(c.designaciones)} designaciones` }
    };
}

// Aclaración del corte anterior: se recalcula hoy con los datos disponibles hasta esa fecha (no es una fotografía histórica guardada).
const NOTA_METODOLOGICA_CORTE = 'Nota metodológica: el corte anterior se reconstruye con la información actualmente disponible; no corresponde a una fotografía histórica guardada en esa fecha.';

const _informeGestionExports = {
    esNulo, fmtEntero, fmtDecimal, fmtNota, fmtPct, fmtPctSigno, fmtDif, fmtFecha, fmtFechaCorta, esc,
    estadoCobertura, textoNSobreTotal, textoIndicador, flechaVariacion, claseVariacion, agruparTiposOtros,
    nivelSenal, etiquetaTipoSenal, senalesParaPantalla, valorSenal, fmtPromedio, motivoProyeccion, estadoProyeccion,
    etiquetaMuestra, textoParticipacionAlterados, AVISO_ALTERADOS,
    datasetsRodeosAcumulados, datasetsColleras, datasetsSituaciones, sparkline,
    textoPagina, temporadasComparacion, textoDiferencia, textoRangoFechas, agruparPorMuestra, referenciaHistoricaColleras,
    motivoSeguimiento, resumenCuerpoJurados, datasetsBloques, lecturaBloque, etiquetaRangoCorto, notaBloquePeriodo, TEXTO_BLOQUE_VS_PERIODO,
    NOTA_METODOLOGICA_CORTE, resumenEvolucion, chipEstadoSenal, resumenEstadoSenales, textoConcentracionFaltas, textoConcentracionAlterados, resumenUtilizacion
};
if (typeof module !== 'undefined' && module.exports) { module.exports = _informeGestionExports; }
if (typeof window !== 'undefined') { window.IG = _informeGestionExports; }
