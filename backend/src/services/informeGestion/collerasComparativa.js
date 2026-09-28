// ═════════════════════════════════════════════════════════════════════════
// Comparativa de Colleras Completas: temporada ACTUAL vs la temporada INMEDIATAMENTE
// ANTERIOR (F.temporadaAnterior(actual, 1) — hoy 2026-2027 vs 2025-2026; el cálculo
// no queda hardcodeado a esos nombres, se resuelve dinámicamente para no requerir un
// cambio de código en la temporada siguiente).
//
// NO reinventa lógica: reutiliza exactamente las mismas piezas que ya usa el Informe
// de Gestión Deportiva para "colleras completas a fecha equivalente":
//   · fechasEquivalentes.js  → desplazarFechaEquivalente / buscarMedicionEquivalente
//   · series.js              → serieCollerasAcumuladas (serie de puntos superpuestos
//                               por fecha equivalente, la misma que arma el gráfico
//                               Chart.js de la pantalla de Informe de Gestión)
//   · informe.js             → comparar() (diferencia + variación %, idéntico criterio)
//   · cargaDatos.js          → leerPaginado / leerOpcional / resolverTemporada
//
// Fuentes de datos (auditoría, ver informe final):
//   · Total ACTUAL: el mismo objeto `colleras` (resumen.totalCompletas) que ya obtiene
//     el endpoint /export-fin-semana vía obtenerCollerasCompletas() — NO se vuelve a
//     scrapear la fuente externa; se reutiliza el dato ya obtenido en esa misma request.
//   · Serie histórica de 2025-2026 y puntos de la temporada actual: tablas
//     historico_colleras_medicion (medición confirmada) y colleras_completas_snapshots,
//     las mismas que usa el Informe de Gestión — ninguna tabla ni fuente nueva.
//
// construirComparativaColleras() es PURA (recibe los datos ya cargados) — testeable con
// fixtures sin BD. cargarComparativaColleras() es el loader delgado que solo hace 2 SELECT.
// ═════════════════════════════════════════════════════════════════════════
const supabase = require('../../config/supabase');
const CONFIG = require('./config');
const F = require('./fechasEquivalentes');
const { leerPaginado, leerOpcional, resolverTemporada } = require('./cargaDatos');
const { serieCollerasAcumuladas } = require('./series');
const { comparar } = require('./informe');

function construirComparativaColleras({ colleras, ahora = new Date(), T, historicoColleras = [], snapshotsColleras = [] }, cfg = CONFIG) {
    const fechaColleras = F.hoyChile(ahora);
    const totalActual = colleras && colleras.resumen && typeof colleras.resumen.totalCompletas === 'number' && Number.isFinite(colleras.resumen.totalCompletas)
        ? colleras.resumen.totalCompletas : null;

    if (!T) {
        return {
            disponible: false, motivo: 'SIN_TEMPORADA_ACTUAL',
            temporada_actual: null, temporada_anterior: null, fecha_dato: null,
            resumen: comparar(null, null),
            serie: { actual: { temporada: null, actual: true, k: 0, puntos: [] }, anterior: { temporada: null, actual: false, k: null, puntos: [] } }
        };
    }

    const temporadaAnteriorNombre = F.temporadaAnterior(T.nombre, 1);
    const medicionesAnterior = temporadaAnteriorNombre ? historicoColleras.filter(m => m.temporada === temporadaAnteriorNombre) : [];

    const serie = serieCollerasAcumuladas({
        T,
        historicoColleras: medicionesAnterior,   // solo la temporada anterior: la serie resultante queda acotada a 2 (actual + esta)
        snapshots: snapshotsColleras,
        colleras: totalActual !== null ? { estado: 'actual', total: totalActual } : null,
        fechaColleras: totalActual !== null ? fechaColleras : null,
        cfg
    });
    const serieActual = serie.temporadas.find(t => t.actual) || { temporada: T.nombre, actual: true, k: 0, puntos: [] };
    const serieAnterior = temporadaAnteriorNombre
        ? (serie.temporadas.find(t => !t.actual && t.temporada === temporadaAnteriorNombre) || { temporada: temporadaAnteriorNombre, actual: false, k: 1, puntos: [] })
        : { temporada: null, actual: false, k: null, puntos: [] };

    const base = {
        temporada_actual: T.nombre,
        temporada_anterior: temporadaAnteriorNombre,
        fecha_dato: totalActual !== null ? fechaColleras : null,
        serie: { actual: serieActual, anterior: serieAnterior }
    };

    if (!temporadaAnteriorNombre) return { ...base, disponible: false, motivo: 'TEMPORADA_ANTERIOR_NO_RESUELTA', resumen: comparar(totalActual, null) };
    if (totalActual === null) return { ...base, disponible: false, motivo: 'DATO_ACTUAL_NO_DISPONIBLE', resumen: comparar(null, null) };

    // Valor puntual comparable "a fecha equivalente" (mismo cálculo que informe.js, sección "colleras completas")
    const fechaObjetivo = F.desplazarFechaEquivalente(fechaColleras, 1, cfg);
    const eq = F.buscarMedicionEquivalente(medicionesAnterior, fechaObjetivo, {}, cfg);
    const historico = eq.estado === 'OK' ? eq.medicion.total_colleras : null;

    return {
        ...base,
        disponible: eq.estado === 'OK',
        motivo: eq.estado === 'OK' ? null : eq.estado,   // p.ej. SIN_DATO_HISTORICO_COMPARABLE
        fecha_objetivo_historico: fechaObjetivo,
        medicion_historica: eq.medicion ? { fecha_medicion: eq.medicion.fecha_medicion, total_colleras: eq.medicion.total_colleras } : null,
        diferencia_dias: eq.diferencia_dias,
        tolerancia_dias: eq.tolerancia_dias,
        resumen: comparar(totalActual, historico)   // { actual, historico, diferencia, variacion_pct, tendencia, simbolo, disponible }
    };
}

// Loader delgado: SOLO 2 SELECT adicionales (el resto de los datos ya los tiene la request). Tolerante a que
// historico_colleras_medicion aún no exista o esté vacía (leerOpcional) — nunca hace fallar el reporte.
async function cargarComparativaColleras({ db = supabase, colleras, ahora = new Date() } = {}) {
    const hoy = F.hoyChile(ahora);
    let T = null;
    try {
        // resolverTemporada() devuelve fecha_inicio/fecha_fin (columnas reales); las funciones de serie
        // (series.js) esperan inicio/fin — mismo remapeo que hace cargarDataset() en cargaDatos.js.
        const raw = await resolverTemporada(db, hoy);
        T = raw ? { id: raw.id, nombre: raw.nombre, inicio: raw.fecha_inicio, fin: raw.fecha_fin } : null;
    } catch (e) { T = null; }
    if (!T) return construirComparativaColleras({ colleras, ahora, T: null });

    const temporadaAnteriorNombre = F.temporadaAnterior(T.nombre, 1);
    const [hist, snap] = await Promise.all([
        temporadaAnteriorNombre
            ? leerOpcional(() => leerPaginado((d, h) => db.from('historico_colleras_medicion')
                .select('temporada, fecha_medicion, total_colleras, fecha_confirmada')
                .eq('temporada', temporadaAnteriorNombre).range(d, h)))
            : Promise.resolve({ datos: [], motivo: null }),
        leerOpcional(() => leerPaginado((d, h) => db.from('colleras_completas_snapshots')
            .select('fecha_snapshot, total_colleras')
            .eq('estado_fuente', 'OK').gte('fecha_snapshot', T.inicio).order('fecha_snapshot', { ascending: true }).range(d, h)))
    ]);

    return construirComparativaColleras({ colleras, ahora, T, historicoColleras: hist.datos || [], snapshotsColleras: snap.datos || [] });
}

module.exports = { construirComparativaColleras, cargarComparativaColleras };
