// ═════════════════════════════════════════════════════════════════════════
// Series temporales listas para Chart.js (una sola respuesta, sin requests por semana).
//
// Reglas:
//   · Solo puntos REALES: no se interpola ni se rellenan huecos. Un valor ausente es null,
//     nunca 0 (una semana sin evaluaciones publicadas devuelve null, no "0 alterados").
//   · rodeos_acumulados: cortes semanales (domingos = cierre de cada fin de semana de
//     rodeos) de la temporada actual contra los cortes equivalentes (52 semanas) de la de
//     referencia. Son conteos acumulados exactos en cada corte, no estimaciones.
//   · colleras_acumuladas: mediciones históricas CONFIRMADAS + snapshots/dato en vivo de la
//     temporada actual. Cada punto histórico trae su fecha equivalente en la temporada
//     actual para superponerlas.
//   · situaciones_semanales: semanas lunes–domingo con al menos un rodeo realizado (se conserva por compatibilidad).
//   · situaciones_por_bloque: BLOQUES DE RODEO (feriados.js: sábado, domingo y feriados consecutivos = un solo
//     bloque); es la serie que usa el informe. La barra es el total de rodeos del bloque; faltas y alterados
//     son indicadores independientes (un mismo rodeo puede estar en ambos: NO se apilan ni se suman).
// ═════════════════════════════════════════════════════════════════════════
const CONFIG = require('./config');
const F = require('./fechasEquivalentes');
const { redondear, ratio, esPublicada } = require('./agregados');
const feriados = require('../feriados');

const etiqueta = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const MAX_PUNTOS = 80;

function domingosEntre(inicio, fin) {
    let d = inicio;
    while (F.diaSemana(d) !== 0) d = F.addDays(d, 1);
    const out = [];
    while (d <= fin && out.length < MAX_PUNTOS) { out.push(d); d = F.addDays(d, 7); }
    return out;
}

// ── 1. Rodeos acumulados: actual vs temporada de referencia ──────────────
function serieRodeosAcumulados({ rodeos, T, corte, historicoRodeos, referencia, cfg = CONFIG }) {
    const activos = rodeos.filter(r => r.estado === cfg.RODEO_ACTIVO).map(r => r.fecha).sort();
    const cuenta = (lista, hasta, desde = '0000-00-00') => lista.filter(f => f >= desde && f <= hasta).length;
    const fechas = [...new Set([...domingosEntre(T.inicio, T.fin), corte])].filter(f => f >= T.inicio && f <= T.fin).sort();

    let filasHist = null, inicioHist = null, k = null;
    if (referencia && historicoRodeos) {
        k = F.distanciaTemporadas(T.nombre, referencia);
        if (k) {
            filasHist = historicoRodeos.filter(h => h.temporada === referencia).map(h => h.fecha_rodeo).sort();
            inicioHist = F.desplazarFechaEquivalente(T.inicio, k, cfg);
        }
    }
    const puntos = fechas.map(d => {
        const fh = filasHist ? F.desplazarFechaEquivalente(d, k, cfg) : null;
        return {
            fecha: d,
            etiqueta: etiqueta(d),
            actual: d <= corte ? cuenta(activos, d) : null,
            calendario_cargado: d > corte ? cuenta(activos, d) : null,
            fecha_historica: fh,
            historico: filasHist ? cuenta(filasHist, fh, inicioHist) : null
        };
    });
    return {
        temporada_actual: T.nombre,
        temporada_referencia: filasHist ? referencia : null,
        corte,
        puntos,
        nota: 'Conteos acumulados exactos por cierre de fin de semana. "calendario_cargado" son rodeos activos ya programados posteriores al corte (no son realizados).'
    };
}

// ── 2. Colleras acumuladas por temporada ─────────────────────────────────
function serieCollerasAcumuladas({ T, historicoColleras, snapshots, colleras, fechaColleras, cfg = CONFIG }) {
    const porTemporada = new Map();
    for (const m of (historicoColleras || [])) {
        if (m.fecha_confirmada !== true || typeof m.total_colleras !== 'number') continue;
        if (!porTemporada.has(m.temporada)) porTemporada.set(m.temporada, []);
        porTemporada.get(m.temporada).push(m);
    }
    const temporadas = [];
    for (const [nombre, filas] of [...porTemporada.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const k = F.distanciaTemporadas(T.nombre, nombre);
        if (!k) continue;
        const puntos = filas.sort((a, b) => a.fecha_medicion.localeCompare(b.fecha_medicion)).map(m => {
            const eq = F.desplazarFechaHaciaAdelante(m.fecha_medicion, k, cfg);
            return { fecha: m.fecha_medicion, fecha_equivalente: eq, x_dias: F.diffDays(eq, T.inicio), etiqueta: etiqueta(eq), valor: m.total_colleras, fuente: 'historico' };
        });
        temporadas.push({ temporada: nombre, actual: false, k, puntos });
    }

    // Temporada actual: snapshots válidos + dato en vivo (si lo hubo). Puntos reales, sin inventar.
    const pts = new Map();
    for (const s of (snapshots || [])) {
        if (typeof s.total_colleras !== 'number') continue;
        const f = F.hoyChile(new Date(s.fecha_snapshot));
        pts.set(f, { fecha: f, valor: s.total_colleras, fuente: 'snapshot' });
    }
    if (colleras && colleras.estado === 'actual' && typeof colleras.total === 'number' && fechaColleras) {
        pts.set(fechaColleras, { fecha: fechaColleras, valor: colleras.total, fuente: 'en_vivo' });
    }
    const actuales = [...pts.values()].filter(p => p.fecha >= T.inicio).sort((a, b) => a.fecha.localeCompare(b.fecha))
        .map(p => ({ ...p, fecha_equivalente: p.fecha, x_dias: F.diffDays(p.fecha, T.inicio), etiqueta: etiqueta(p.fecha) }));
    temporadas.push({ temporada: T.nombre, actual: true, k: 0, puntos: actuales });

    // Ritmo de crecimiento actual: requiere al menos 2 mediciones actuales reales.
    let ritmo;
    if (actuales.length >= 2) {
        const a = actuales[actuales.length - 2], b = actuales[actuales.length - 1];
        const dias = F.diffDays(b.fecha, a.fecha);
        ritmo = { disponible: true, mediciones_actuales: actuales.length, desde: a.fecha, hasta: b.fecha, delta: b.valor - a.valor, dias, por_semana: dias > 0 ? redondear((b.valor - a.valor) / dias * 7, 1) : null };
    } else {
        ritmo = { disponible: false, mediciones_actuales: actuales.length, motivo: 'Se requieren al menos 2 mediciones actuales' };
    }
    return { temporadas, ritmo_actual: ritmo, nota: 'Solo puntos reales (mediciones históricas confirmadas, snapshots y dato en vivo). Sin interpolación.' };
}

// ── 3. Situaciones por semana (lunes–domingo) ────────────────────────────
function serieSituacionesSemanales({ rodeos, T, corte, ctx, cfg = CONFIG }) {
    const activos = rodeos.filter(r => r.estado === cfg.RODEO_ACTIVO && r.fecha >= T.inicio && r.fecha <= corte);
    let lunes = F.addDays(T.inicio, -((F.diaSemana(T.inicio) + 6) % 7));
    const puntos = [];
    while (lunes <= corte && puntos.length < MAX_PUNTOS) {
        const domingo = F.addDays(lunes, 6);
        const semana = activos.filter(r => r.fecha >= lunes && r.fecha <= domingo);
        if (semana.length) {
            const evs = semana.map(r => ({ r, ev: ctx.evalPorRodeo[r.id] })).filter(x => x.ev);
            const pubs = evs.filter(x => esPublicada(x.ev, cfg));
            const pubsConDato = pubs.filter(x => typeof x.ev.resultados_alterados === 'boolean');
            const conRegl = evs.filter(x => (ctx.casosPorEval[x.ev.id] || []).some(c => c.anulado !== true && c.tipo_caso === 'reglamentaria')).length;
            const cobPub = ratio(pubs.length, semana.length);
            puntos.push({
                semana_inicio: lunes,
                semana_fin: domingo > corte ? corte : domingo,
                etiqueta: etiqueta(lunes),
                rodeos_realizados: semana.length,
                evaluaciones_existentes: evs.length,
                evaluaciones_publicadas: pubs.length,
                rodeos_con_falta_reglamentaria: evs.length ? conRegl : null,
                denominador_evaluados: evs.length,
                rodeos_con_resultado_alterado: pubsConDato.length ? pubsConDato.filter(x => x.ev.resultados_alterados).length : null,
                denominador_publicadas: pubsConDato.length,
                cobertura_publicadas: redondear(cobPub, 3),
                interpretable_alterados: cobPub !== null && cobPub >= cfg.COBERTURA.MINIMA_INTERPRETAR
            });
        }
        lunes = F.addDays(lunes, 7);
    }
    return { puntos, nota: 'Semanas con al menos un rodeo realizado. null = sin dato (no es cero). Los alterados solo consideran evaluaciones publicadas de la semana.' };
}

// ── 4. Situaciones por BLOQUE de rodeo ─────────────────────────────────────
const MESES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
// '2026-09-18','2026-09-20' → '18–20 SEP'; '2026-09-30','2026-10-02' → '30 SEP–02 OCT'; un día → '05 SEP'.
function etiquetaBloque(inicio, fin) {
    const d = iso => iso.slice(8, 10), m = iso => MESES[Number(iso.slice(5, 7)) - 1];
    if (inicio === fin) return `${d(inicio)} ${m(inicio)}`;
    if (inicio.slice(0, 7) === fin.slice(0, 7)) return `${d(inicio)}–${d(fin)} ${m(inicio)}`;
    return `${d(inicio)} ${m(inicio)}–${d(fin)} ${m(fin)}`;
}

// Bloques de rodeo (inicio–fin) que contienen al menos un rodeo de la lista; los que se solapan se unen.
function bloquesDeRodeos(rodeos, deps = {}) {
    const bloqueDe = deps.calcularBloqueRodeo || feriados.calcularBloqueRodeo;
    const tramos = rodeos.map(r => ({ ...bloqueDe(r.fecha, r.duracion_dias || 1), r })).sort((a, b) => a.inicio.localeCompare(b.inicio) || a.fin.localeCompare(b.fin));
    const bloques = [];
    for (const t of tramos) {
        const ult = bloques[bloques.length - 1];
        if (ult && t.inicio <= ult.fin) { if (t.fin > ult.fin) ult.fin = t.fin; ult.rodeos.push(t.r); }
        else bloques.push({ inicio: t.inicio, fin: t.fin, rodeos: [t.r] });
    }
    return bloques;
}

// periodo (opcional) = rango seleccionado {desde, hasta}: solo agrega, por bloque, cuántos rodeos comienzan dentro / antes /
// después de ese rango (para explicar por qué el bloque puede tener más rodeos que el período). No altera ningún cálculo.
function serieSituacionesPorBloque({ rodeos, T, corte, ctx, cfg = CONFIG, deps = {}, periodo = null }) {
    const activos = rodeos.filter(r => r.estado === cfg.RODEO_ACTIVO && r.fecha >= T.inicio && r.fecha <= corte);
    const puntos = bloquesDeRodeos(activos, deps).slice(0, MAX_PUNTOS).map(b => {
        const evs = b.rodeos.map(r => ({ r, ev: ctx.evalPorRodeo[r.id] })).filter(x => x.ev);
        const pubs = evs.filter(x => esPublicada(x.ev, cfg));
        const pubsConDato = pubs.filter(x => typeof x.ev.resultados_alterados === 'boolean');
        const conRegl = evs.filter(x => (ctx.casosPorEval[x.ev.id] || []).some(c => c.anulado !== true && c.tipo_caso === 'reglamentaria')).length;
        const total = b.rodeos.length;
        const cobPub = ratio(pubs.length, total), cobEx = ratio(evs.length, total);
        const alt = pubsConDato.length ? pubsConDato.filter(x => x.ev.resultados_alterados).length : null;
        return {
            bloque_inicio: b.inicio,
            bloque_fin: b.fin,
            bloque_completo: b.fin <= corte,
            ...(periodo ? { periodo_seleccionado: {
                desde: periodo.desde, hasta: periodo.hasta,
                rodeos_inicio_dentro: b.rodeos.filter(r => r.fecha >= periodo.desde && r.fecha <= periodo.hasta).length,
                rodeos_inicio_antes: b.rodeos.filter(r => r.fecha < periodo.desde).length,
                rodeos_inicio_despues: b.rodeos.filter(r => r.fecha > periodo.hasta).length
            } } : {}),
            etiqueta: etiquetaBloque(b.inicio, b.fin),
            rodeos_realizados: total,
            evaluaciones_existentes: evs.length,
            evaluaciones_publicadas: pubs.length,
            cobertura_publicadas: redondear(cobPub, 3),
            // Faltas reglamentarias: denominador = rodeos CON evaluación (los casos solo existen dentro de una evaluación).
            rodeos_con_falta_reglamentaria: evs.length ? conRegl : null,
            denominador_faltas: evs.length,
            porcentaje_faltas: evs.length ? redondear(conRegl / evs.length * 100, 1) : null,
            interpretable_faltas: cobEx !== null && cobEx >= cfg.COBERTURA.MINIMA_INTERPRETAR,
            // Alterados: denominador = evaluaciones PUBLICADAS con dato (nunca el total de rodeos). Sin publicadas → null (SIN DATOS), no 0.
            rodeos_con_resultado_alterado: alt,
            denominador_alterados: pubsConDato.length,
            porcentaje_alterados: pubsConDato.length ? redondear(alt / pubsConDato.length * 100, 1) : null,
            interpretable_alterados: cobPub !== null && cobPub >= cfg.COBERTURA.MINIMA_INTERPRETAR
        };
    });
    return { puntos, nota: 'Bloques de rodeo (sábado, domingo y feriados consecutivos = un solo bloque). Barra = total de rodeos realizados del bloque. Faltas: sobre rodeos con evaluación. Alterados: sobre evaluaciones publicadas (null = SIN DATOS, no es cero).' };
}

module.exports = { etiquetaBloque, bloquesDeRodeos, serieSituacionesPorBloque, domingosEntre, serieRodeosAcumulados, serieCollerasAcumuladas, serieSituacionesSemanales };
