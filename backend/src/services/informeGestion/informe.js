// ═════════════════════════════════════════════════════════════════════════
// Orquestador del Informe Ejecutivo de Gestión Deportiva.
//
// generarInforme()  → carga (1 pasada) + colleras en paralelo (con fallback)
// calcularInforme() → PURA: dataset + colleras → JSON único para la
//                     previsualización (sin BD, testeable).
//
// Perspectivas: PERÍODO seleccionado · ACUMULADO de temporada · HISTÓRICO
// equivalente (fechas equivalentes de 52 semanas) · PROYECCIÓN.
// ═════════════════════════════════════════════════════════════════════════
const CONFIG = require('./config');
const { normalizarTexto } = require('../geografia');
const F = require('./fechasEquivalentes');
const A = require('./agregados');
const { excluirDatosPrueba } = require('./exclusionPrueba');
const { rangoHistoricoPeriodo } = require('./periodoEquivalente');
const { calcularCorteAnterior, SIN_CORTE_ANTERIOR } = require('./corteAnterior');
const { cambiosCorte, estadoSenales, ESTADO_SENALES_SIN_CORTE, evolucionAsociaciones } = require('./evolucion');
const { concentracionSituaciones } = require('./concentracion');
const { utilizacionJurados } = require('./utilizacion');
const { lecturaEjecutiva } = require('./lecturaEjecutiva');
const { analizarJurados } = require('./jurados');
const { analizarDisponibilidad } = require('./disponibilidad');
const { analizarActividadAsociaciones } = require('./asociaciones');
const P = require('./proyecciones');
const { generarSenales } = require('./senales');
const { cargarDataset } = require('./cargaDatos');
const { obtenerCollerasActuales, fechaDatoISO } = require('./collerasSnapshot');
const { serieRodeosAcumulados, serieCollerasAcumuladas, serieSituacionesSemanales, serieSituacionesPorBloque } = require('./series');

function errorParametro(msg) { const e = new Error(msg); e.status = 400; return e; }

function comparar(actual, historico) {
    if (actual === null || actual === undefined || historico === null || historico === undefined) {
        return { actual: actual ?? null, historico: historico ?? null, diferencia: null, variacion_pct: null, tendencia: null, simbolo: null, disponible: false };
    }
    const dif = actual - historico;
    return {
        actual, historico, diferencia: dif,
        variacion_pct: historico > 0 ? A.redondear(dif / historico * 100, 1) : null,
        tendencia: dif > 0 ? 'SUBE' : dif < 0 ? 'BAJA' : 'IGUAL',
        simbolo: dif > 0 ? '↑' : dif < 0 ? '↓' : '=',
        disponible: true
    };
}

function contarHistorico(filas, ini, fin) {
    const sel = filas.filter(r => r.fecha_rodeo >= ini && r.fecha_rodeo <= fin);
    const porCat = {}, porTipo = {};
    for (const r of sel) {
        const c = normalizarTexto(r.categoria || '') || 'sin categoria';
        porCat[c] = { nombre: r.categoria || CONFIG.SIN_CATEGORIA, cantidad: (porCat[c]?.cantidad || 0) + 1 };
        const t = normalizarTexto(r.tipo_rodeo || '') || 'sin tipo';
        porTipo[t] = { nombre: r.tipo_rodeo || 'Sin tipo', cantidad: (porTipo[t]?.cantidad || 0) + 1 };
    }
    return { total: sel.length, por_categoria: porCat, por_tipo: porTipo, filas: sel };
}

function compararGrupos(actualLista, histMapa) {
    const filas = new Map();
    for (const a of actualLista) filas.set(normalizarTexto(a.clave), { clave: a.clave, actual: a.cantidad, historico: 0 });
    for (const [k, v] of Object.entries(histMapa)) {
        const fila = filas.get(k) || { clave: v.nombre, actual: 0, historico: 0 };
        fila.historico = v.cantidad;
        filas.set(k, fila);
    }
    return [...filas.values()].map(f => ({ clave: f.clave, ...comparar(f.actual, f.historico) }))
        .sort((a, b) => (b.actual + b.historico) - (a.actual + a.historico) || a.clave.localeCompare(b.clave, 'es'));
}

function calcularInforme({ desde, hasta, hoy }, ds, colleras, generadoEn = new Date(), cfg = CONFIG, opts = {}) {
    ds = excluirDatosPrueba(ds);   // cuentas y rodeos marcados es_prueba (migración 058): fuera del informe ejecutivo
    const advertencias = [];
    const T = ds.temporada;
    const corte = hasta < hoy ? hasta : hoy;
    if (corte < hasta) advertencias.push(`La fecha "hasta" (${hasta}) es posterior a hoy (${hoy}); se usó ${corte} como corte para que ningún rodeo futuro figure como realizado.`);
    if (corte < T.inicio) throw errorParametro(`El corte (${corte}) es anterior al inicio de la temporada (${T.inicio})`);
    let desdeEf = desde > T.inicio ? desde : T.inicio;
    if (desde < T.inicio) advertencias.push(`La fecha "desde" (${desde}) es anterior al inicio de la temporada (${T.inicio}); el período parte del inicio de temporada.`);

    // ── contexto compartido (índices) ───────────────────────────────────
    const usuariosPorId = A.indexarUnico(ds.usuarios, 'id');
    const juradosPorRodeo = {};
    for (const a of ds.asignaciones) {
        if (a.tipo_persona !== 'jurado' || a.estado !== 'activo' || a.estado_designacion === 'rechazado') continue;
        const nom = usuariosPorId[a.usuario_pagado_id]?.nombre_completo;
        if (nom) (juradosPorRodeo[a.rodeo_id] ||= []).push(nom);
    }
    const notasPorAsignacion = A.indexarUnico(ds.notasJurado, 'asignacion_id');
    const ctx = {
        evalPorRodeo: A.indexarEvaluaciones(ds.evaluaciones),
        casosPorEval: A.indexarPorClave(ds.casos, 'evaluacion_id'),
        cartillasPorRodeo: A.indexarPorClave(ds.cartillas, 'rodeo_id'),
        notasSecPorRodeo: A.indexarUnico(ds.notasSecundarias, 'rodeo_id'),
        categoriaPorTipoId: ds.categoriaPorTipoId,
        juradosPorRodeo
    };

    // ── selecciones: período, acumulado y período anterior ─────────────
    const selPeriodo = A.seleccionarRodeos(ds.rodeos, { desde: desdeEf, hasta: corte, finVentana: T.fin }, cfg);
    const selAcum = A.seleccionarRodeos(ds.rodeos, { desde: T.inicio, hasta: corte, finVentana: T.fin }, cfg);
    const largo = F.diffDays(corte, desdeEf) + 1;
    const antHasta = F.addDays(desdeEf, -1);
    const antDesde = F.addDays(desdeEf, -largo);
    const hayAnterior = antHasta >= T.inicio;
    const selAnterior = hayAnterior ? A.seleccionarRodeos(ds.rodeos, { desde: antDesde < T.inicio ? T.inicio : antDesde, hasta: antHasta }, cfg) : null;

    const evPeriodo = A.bloqueEvaluativo(selPeriodo.realizados, ctx, cfg);
    const evAcum = A.bloqueEvaluativo(selAcum.realizados, ctx, cfg);
    const evAnterior = selAnterior ? A.bloqueEvaluativo(selAnterior.realizados, ctx, cfg) : null;
    const sinCob = b => { const { cobertura, ...resto } = b; return resto; };

    // ── histórico equivalente de rodeos ─────────────────────────────────
    const historicosRodeos = [];
    if (ds.historicoRodeos) {
        const temporadas = [...new Set(ds.historicoRodeos.map(r => r.temporada))];
        for (const nombre of temporadas) {
            const k = F.distanciaTemporadas(T.nombre, nombre);
            if (!k) continue;
            const v = F.ventanaEquivalente({ inicio: T.inicio, corte, fin: T.fin }, k, cfg);
            const filas = ds.historicoRodeos.filter(r => r.temporada === nombre);
            const eq = contarHistorico(filas, v.inicio, v.corte);
            const fin = contarHistorico(filas, v.inicio, v.fin);
            const rp = rangoHistoricoPeriodo({ desde: desdeEf, hasta: corte, k, cfg });   // un solo bloque de rodeo → bloque histórico completo
            const per = contarHistorico(filas, rp.desde, rp.hasta);
            historicosRodeos.push({ temporada: nombre, k, ventana: v, equivalente: eq, final: fin, periodo: per, periodo_rango: rp, avance_historico: A.redondear(A.ratio(eq.total, fin.total), 3) });
        }
        historicosRodeos.sort((a, b) => a.k - b.k);
    }
    const ref = historicosRodeos[0] || null;

    const rodeosAcum = A.resumenRodeos(selAcum, ds.categoriaPorTipoId, cfg);
    const rodeosPeriodo = A.resumenRodeos(selPeriodo, ds.categoriaPorTipoId, cfg);

    const comparacionRodeos = ref ? comparar(rodeosAcum.realizados, ref.equivalente.total) : comparar(null, null);
    const comparacion = {
        referencia: ref ? { temporada: ref.temporada, ventana: ref.ventana } : null,
        periodo_equivalente: ref ? { temporada: ref.temporada, modo: ref.periodo_rango.modo, desde: ref.periodo_rango.desde, hasta: ref.periodo_rango.hasta, rango_desplazado: ref.periodo_rango.rango_desplazado } : null,
        rodeos: comparacionRodeos,
        rodeos_periodo: ref ? comparar(rodeosPeriodo.realizados, ref.periodo.total) : comparar(null, null),
        por_categoria: ref ? compararGrupos(rodeosAcum.por_categoria, ref.equivalente.por_categoria) : [],
        por_tipo: ref ? compararGrupos(rodeosAcum.por_tipo, ref.equivalente.por_tipo) : [],
        periodo_anterior: selAnterior ? {
            rango: { desde: antDesde < T.inicio ? T.inicio : antDesde, hasta: antHasta },
            rodeos_realizados: selAnterior.realizados.length,
            evaluacion: evAnterior.evaluacion,
            resultados_alterados: evAnterior.resultados_alterados,
            variacion_rodeos: comparar(selPeriodo.realizados.length, selAnterior.realizados.length)
        } : null
    };

    // ── proyecciones de rodeos ──────────────────────────────────────────
    const histParaProyectar = historicosRodeos.map(h => ({ temporada: h.temporada, equivalente: h.equivalente.total, final: h.final.total }));
    const proyRodeos = P.proyectarRodeos({ actual: rodeosAcum.realizados, programados: rodeosAcum.programados, historicos: histParaProyectar }, cfg);
    const porCategoria = {};
    for (const c of rodeosAcum.por_categoria.filter(x => x.clave !== cfg.SIN_CATEGORIA)) {
        const key = normalizarTexto(c.clave);
        porCategoria[c.clave] = P.proyectarRodeos({
            actual: c.cantidad,
            historicos: historicosRodeos.map(h => ({ temporada: h.temporada, equivalente: h.equivalente.por_categoria[key]?.cantidad ?? 0, final: h.final.por_categoria[key]?.cantidad ?? 0 }))
        }, cfg);
    }

    // ── colleras completas ──────────────────────────────────────────────
    const fechaColleras = collerasActual_fecha(colleras);
    const collerasBloque = { actual: colleras, fecha_dato_iso: fechaColleras, comparacion: { disponible: false, motivo: null, temporadas: [] } };
    let comparacionColleras = null;
    let proyColleras = P.proyectarSerie({ actual: colleras && colleras.total, historicos: [], metodo: 'razon_ritmo_historico_colleras' }, cfg);
    if (colleras && colleras.total === null) collerasBloque.comparacion.motivo = 'DATO_ACTUAL_NO_DISPONIBLE';
    else if (!ds.historicoColleras) collerasBloque.comparacion.motivo = 'SIN_HISTORICO_IMPORTADO';
    else if (!fechaColleras) collerasBloque.comparacion.motivo = 'SIN_FECHA_DEL_DATO';
    else {
        const nombres = [...new Set(ds.historicoColleras.map(m => m.temporada))];
        const porTemporada = [];
        for (const nombre of nombres) {
            const k = F.distanciaTemporadas(T.nombre, nombre);
            if (!k) continue;
            porTemporada.push({ temporada: nombre, k, mediciones: ds.historicoColleras.filter(m => m.temporada === nombre), fechaObjetivo: F.desplazarFechaEquivalente(fechaColleras, k, cfg) });
        }
        porTemporada.sort((a, b) => a.k - b.k);
        const filas = porTemporada.map(h => {
            const eq = F.buscarMedicionEquivalente(h.mediciones, h.fechaObjetivo, {}, cfg);
            const conf = h.mediciones.filter(m => m.fecha_confirmada === true && typeof m.total_colleras === 'number').sort((a, b) => a.fecha_medicion.localeCompare(b.fecha_medicion));
            let ritmo = null;
            if (eq.estado === 'OK') {
                const previa = [...conf].reverse().find(m => m.fecha_medicion < eq.medicion.fecha_medicion);
                if (previa) {
                    const dias = F.diffDays(eq.medicion.fecha_medicion, previa.fecha_medicion);
                    ritmo = { desde: previa.fecha_medicion, hasta: eq.medicion.fecha_medicion, delta: eq.medicion.total_colleras - previa.total_colleras, dias, por_semana: A.redondear((eq.medicion.total_colleras - previa.total_colleras) / dias * 7, 1) };
                }
            }
            return {
                temporada: h.temporada, fecha_objetivo: h.fechaObjetivo, estado: eq.estado,
                medicion: eq.medicion ? { fecha_medicion: eq.medicion.fecha_medicion, total_colleras: eq.medicion.total_colleras } : null,
                diferencia_dias: eq.diferencia_dias, tolerancia_dias: eq.tolerancia_dias,
                ...(eq.estado === 'OK' ? comparar(colleras.total, eq.medicion.total_colleras) : { actual: colleras.total, historico: null, diferencia: null, variacion_pct: null, disponible: false }),
                ritmo_historico: ritmo
            };
        });
        const validas = filas.filter(f => f.estado === 'OK');
        collerasBloque.comparacion = {
            disponible: validas.length > 0,
            temporadas_comparables: validas.length,   // el promedio/máximo histórico solo se presenta con 2 o más
            motivo: validas.length ? null : 'SIN_DATO_HISTORICO_COMPARABLE',
            temporadas: filas,
            promedio_historico: A.promedio(validas.map(f => f.historico), 1),
            maximo_historico: validas.length ? Math.max(...validas.map(f => f.historico)) : null
        };
        if (validas.length) comparacionColleras = comparar(colleras.total, validas[0].historico);
        proyColleras = P.proyectarColleras({ actual: colleras.total, historicosPorTemporada: porTemporada }, cfg);
    }

    // ── jurados, disponibilidad, asociaciones ───────────────────────────
    const jurados = analizarJurados({
        realizados: selAcum.realizados, evalPorRodeo: ctx.evalPorRodeo, casosPorEval: ctx.casosPorEval,
        asignaciones: ds.asignaciones, usuariosPorId, notasPorAsignacion, notasSecPorRodeo: ctx.notasSecPorRodeo,
        periodo: { desde: desdeEf, hasta: corte }
    }, cfg);

    const juradosActivos = ds.usuarios.filter(u => u.activo !== false && u.estado_usuario !== 'inactivo');
    const dispo = rango => analizarDisponibilidad({ desde: rango.desde, hasta: rango.hasta, jurados: juradosActivos, disponibilidad: ds.disponibilidad, asignaciones: ds.asignaciones, rodeos: ds.rodeos });
    const disponibilidad = { periodo: dispo({ desde: desdeEf, hasta: corte }), acumulado_temporada: dispo({ desde: T.inicio, hasta: corte }) };

    const asociaciones = analizarActividadAsociaciones({
        catalogo: ds.catalogoAsociaciones, alias: ds.aliasAsociaciones, rodeosActuales: selAcum.realizados,
        historicoEquivalente: ref ? ref.equivalente.filas : null, hasta: corte
    }, cfg);

    // ── universos de jurados (se documentan; NO se fuerzan a coincidir) ──
    const idsAct = new Set(juradosActivos.map(u => u.id));
    const idsConActuaciones = new Set(jurados.detalle.map(d => d.usuario_id));
    const universosJurados = {
        con_actuaciones: { jurados_distintos: idsConActuaciones.size, filas_jurado_categoria: jurados.detalle.length, jurados_en_mas_de_una_categoria: jurados.resumen.jurados_en_mas_de_una_categoria, descripcion: jurados.resumen.universo },
        activos_para_disponibilidad: { jurados: idsAct.size, descripcion: "Jurados activos considerados para disponibilidad (usuarios_pagados tipo jurado con activo distinto de false y estado_usuario distinto de 'inactivo')" },
        con_actuaciones_no_activos: [...idsConActuaciones].filter(id => !idsAct.has(id)).length,
        activos_sin_actuaciones: [...idsAct].filter(id => !idsConActuaciones.has(id)).length,
        explicacion: 'Son universos distintos: el análisis cuenta una fila por jurado y categoría aplicada (quien actuó en 2 categorías aparece 2 veces) e incluye a quienes actuaron aunque hoy estén en receso; la disponibilidad considera solo a los jurados activos hoy.'
    };
    disponibilidad.universo = { criterio: universosJurados.activos_para_disponibilidad.descripcion, jurados_considerados: idsAct.size };

    // ── series para gráficos ─────────────────────────────────────────────
    const series = {
        rodeos_acumulados: serieRodeosAcumulados({ rodeos: ds.rodeos, T, corte, historicoRodeos: ds.historicoRodeos, referencia: ref ? ref.temporada : null, cfg }),
        colleras_acumuladas: serieCollerasAcumuladas({ T, historicoColleras: ds.historicoColleras, snapshots: ds.snapshotsColleras, colleras, fechaColleras, cfg }),
        situaciones_semanales: serieSituacionesSemanales({ rodeos: ds.rodeos, T, corte, ctx, cfg }),
        situaciones_por_bloque: serieSituacionesPorBloque({ rodeos: ds.rodeos, T, corte, ctx, cfg, periodo: { desde: desdeEf, hasta: corte } })
    };
    collerasBloque.ritmo_actual = series.colleras_acumuladas.ritmo_actual;

    // ── cobertura y señales ─────────────────────────────────────────────
    const cobertura = { periodo: evPeriodo.cobertura, acumulado_temporada: evAcum.cobertura };
    const senales = generarSenales({
        comparacionRodeos, comparacionColleras, asociaciones,
        alterados: evAnterior ? { periodo: evPeriodo.resultados_alterados, anterior: evAnterior.resultados_alterados } : null,
        jurados, cobertura: evAcum.cobertura,
        temporadas: { actual: T.nombre, referencia: ref ? ref.temporada : null }
    }, cfg);

    if (!ds.fuentes.asociaciones.disponible) advertencias.push('Catálogo de asociaciones no disponible: no se analizan asociaciones sin rodeos.');
    if (!ds.fuentes.historico_rodeos.disponible) advertencias.push('Histórico de rodeos no importado: sin comparación ni proyección de rodeos.');
    if (!ds.fuentes.historico_colleras.disponible) advertencias.push('Histórico de colleras no importado: sin comparación ni proyección de colleras.');
    if (colleras && colleras.estado === 'fallback') advertencias.push('Colleras completas: se usó el último snapshot válido (la fuente en vivo no respondió).');
    if (colleras && colleras.estado === 'no_disponible') advertencias.push('Colleras completas: dato actual no disponible.');
    advertencias.push(...evAcum.cobertura.advertencias);

    const resultado = {
        metadata: {
            version_motor: cfg.VERSION_MOTOR,
            generado_en: generadoEn.toISOString(),
            hasta_solicitado: hasta, desde_solicitado: desde,
            periodo: { desde: desdeEf, hasta: corte },
            temporada: { ...T, avance: A.redondear(F.avanceTemporada(corte, T.inicio, T.fin), 3) },
            definiciones: {
                rodeo_realizado: "estado = 'activo' AND fecha <= corte (corte = min(hasta, hoy))",
                rodeo_programado: "estado = 'activo' AND fecha > corte (dentro de la temporada)",
                categoria_efectiva: 'rodeos.categoria_rodeo_nombre; si es NULL, la del tipo (tipos_rodeo.categoria_rodeo_id → categorias_rodeo)',
                nota_oficial: "evaluaciones.nota_final solo con estado 'publicado'; Nota Comisión y Nota Delegado son indicadores separados",
                resultado_alterado: 'evaluaciones publicadas; NULL no cuenta como NO',
                disponibilidad: 'DISPONIBILIDAD DECLARADA (solo días positivos; sin registro = SIN_DECLARACION_REGISTRADA)',
                fechas_equivalentes: 'desplazamiento de 52 semanas (364 días) con corrección de deriva por semanas completas'
            },
            fuentes: ds.fuentes,
            universos_jurados: universosJurados,
            datos_excluidos: ds.datos_excluidos,   // solo conteos (sin nombres ni ids)
            advertencias
        },
        periodo: { rango: { desde: desdeEf, hasta: corte }, rodeos: rodeosPeriodo },
        acumulado_temporada: { rango: { desde: T.inicio, hasta: corte }, rodeos: rodeosAcum },
        historico_equivalente: {
            disponible: historicosRodeos.length > 0,
            temporadas: historicosRodeos.map(h => ({
                temporada: h.temporada, k: h.k, ventana: h.ventana,
                rodeos_a_fecha_equivalente: h.equivalente.total, rodeos_cierre_temporada: h.final.total,
                avance_historico: h.avance_historico, rodeos_periodo_equivalente: h.periodo.total, periodo_equivalente: { modo: h.periodo_rango.modo, desde: h.periodo_rango.desde, hasta: h.periodo_rango.hasta },
                por_categoria_equivalente: Object.values(h.equivalente.por_categoria).map(c => ({ clave: c.nombre, cantidad: c.cantidad }))
            }))
        },
        comparacion,
        proyecciones: { rodeos: proyRodeos, por_categoria: porCategoria, colleras: proyColleras },
        rodeos: { ranking: { periodo: A.topBottomRodeos(selPeriodo.realizados, ctx, cfg), acumulado_temporada: A.topBottomRodeos(selAcum.realizados, ctx, cfg) } },
        colleras: collerasBloque,
        evaluaciones: {
            periodo: sinCob(evPeriodo),
            acumulado_temporada: sinCob(evAcum),
            periodo_anterior: evAnterior ? sinCob(evAnterior) : null
        },
        jurados,
        asociaciones,
        disponibilidad,
        cobertura,
        series,
        senales
    };
    if (opts.sinEvolucion) return resultado;   // cálculo interno del corte anterior: no se anida

    // ── Capa ejecutiva (Directorio): se agregan secciones, las anteriores quedan intactas ──
    const ca = calcularCorteAnterior({ corte, T, cfg, deps: opts.deps });
    if (ca.disponible) {
        // Mismo motor, mismos datos en memoria (sin consultas adicionales): acumulado al cierre del bloque anterior.
        const anterior = calcularInforme({ desde: T.inicio, hasta: ca.anterior.corte, hoy: ca.anterior.corte },
            ds, { total: null, estado: 'no_disponible', resumen: {}, detalle_error: null }, generadoEn, cfg, { sinEvolucion: true });
        const totalActual = colleras && typeof colleras.total === 'number' ? colleras.total : null;
        const snap = (ds.snapshotsColleras || [])
            .filter(x => typeof x.total_colleras === 'number').map(x => ({ f: F.hoyChile(new Date(x.fecha_snapshot)), v: x.total_colleras }))
            .filter(x => x.f >= T.inicio && x.f <= ca.anterior.corte).sort((a, b) => b.f.localeCompare(a.f))[0];
        resultado.evolucion_corte = {
            disponible: true, motivo: null, definicion: ca.definicion, actual: ca.actual, anterior: ca.anterior,
            nota_metodologica: 'El acumulado del corte anterior se recalcula con los datos de hoy limitados a los rodeos hasta esa fecha (mismo motor): no reconstruye el estado histórico de publicación de las evaluaciones.',
            cambios: cambiosCorte({ actual: resultado, anterior, collerasActual: totalActual, collerasAnterior: snap ? snap.v : null }, cfg),
            asociaciones: evolucionAsociaciones(resultado.asociaciones, anterior.asociaciones)
        };
        resultado.estado_senales = estadoSenales(resultado.senales, anterior.senales);
    } else {
        resultado.evolucion_corte = { disponible: false, motivo: SIN_CORTE_ANTERIOR, etiqueta: 'SIN CORTE ANTERIOR COMPARABLE', actual: ca.actual, anterior: null, cambios: [], asociaciones: evolucionAsociaciones(null, null) };
        resultado.estado_senales = ESTADO_SENALES_SIN_CORTE;
    }
    resultado.concentracion = concentracionSituaciones({
        realizados: selAcum.realizados, evalPorRodeo: ctx.evalPorRodeo, casosPorEval: ctx.casosPorEval,
        catalogo: ds.catalogoAsociaciones, alias: ds.aliasAsociaciones, coberturaPublicadas: evAcum.cobertura.evaluaciones_publicadas
    }, cfg);
    resultado.utilizacion_jurados = utilizacionJurados(disponibilidad.acumulado_temporada, cfg);
    resultado.lectura_ejecutiva = lecturaEjecutiva(resultado, cfg);
    return resultado;
}

function collerasActual_fecha(colleras) {
    return colleras && colleras.total !== null ? fechaDatoISO(colleras) : null;
}

async function generarInforme({ desde, hasta }, deps = {}) {
    if (!F.esISO(desde) || !F.esISO(hasta)) throw errorParametro('Parámetros "desde" y "hasta" requeridos con formato YYYY-MM-DD');
    if (desde > hasta) throw errorParametro('"desde" no puede ser posterior a "hasta"');
    const cargar = deps.cargar || cargarDataset;
    const obtenerColleras = deps.colleras || obtenerCollerasActuales;
    const ahora = deps.ahora || (() => new Date());
    const [ds, colleras] = await Promise.all([cargar({ hasta }), obtenerColleras()]);
    return calcularInforme({ desde, hasta, hoy: F.hoyChile(ahora()) }, ds, colleras, ahora());
}

module.exports = { comparar, contarHistorico, calcularInforme, generarInforme };
