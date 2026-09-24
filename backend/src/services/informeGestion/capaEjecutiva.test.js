// Capa ejecutiva (Directorio): corte deportivo anterior, cambios, evolución de señales, concentración,
// utilización del cuerpo de jurados y lectura ejecutiva determinística.
jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../colleras-completas', () => ({ obtenerCollerasCompletas: jest.fn() }));

const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');
const { calcularCorteAnterior, SIN_CORTE_ANTERIOR } = require('./corteAnterior');
const { cambiosCorte, estadoSenales, evolucionAsociaciones, identidadesSenales } = require('./evolucion');
const { concentracionSituaciones } = require('./concentracion');
const { utilizacionJurados } = require('./utilizacion');
const { lecturaEjecutiva } = require('./lecturaEjecutiva');
const { calcularInforme } = require('./informe');

const T = { id: 't1', nombre: '2026-2027', inicio: '2026-04-01', fin: '2027-03-31', fuente: 'test' };
const cfgCon = over => ({ ...CONFIG, ...over });

describe('corte deportivo anterior = bloque de rodeo inmediatamente anterior', () => {
    test('corte en jueves 24/09: bloque actual 18–20 SEP (Fiestas Patrias) → anterior 12–13 SEP, corte anterior 13/09', () => {
        const r = calcularCorteAnterior({ corte: '2026-09-24', T });
        expect(r.disponible).toBe(true);
        expect(r.actual).toMatchObject({ corte: '2026-09-24', bloque: { inicio: '2026-09-18', fin: '2026-09-20', etiqueta: '18–20 SEP' } });
        expect(r.anterior).toMatchObject({ corte: '2026-09-13', bloque: { inicio: '2026-09-12', fin: '2026-09-13', etiqueta: '12–13 SEP' } });
        expect(r.definicion).toMatch(/no es el informe anterior/);
    });
    test('corte en el mismo domingo 20/09 da el mismo resultado', () => {
        expect(calcularCorteAnterior({ corte: '2026-09-20', T }).anterior.corte).toBe('2026-09-13');
    });
    test('fin de semana normal: 06/09 → anterior 29–30 AGO (cierre 30/08)', () => {
        const r = calcularCorteAnterior({ corte: '2026-09-06', T });
        expect(r.anterior).toMatchObject({ corte: '2026-08-30', bloque: { inicio: '2026-08-29', fin: '2026-08-30' } });
    });
    test('primer bloque de la temporada: SIN CORTE ANTERIOR COMPARABLE (no se inventan fechas)', () => {
        const r = calcularCorteAnterior({ corte: '2026-04-04', T: { ...T, inicio: '2026-04-04' } });
        expect(r).toMatchObject({ disponible: false, motivo: SIN_CORTE_ANTERIOR, anterior: null });
    });
    test('usa esDiaRodeo / calcularBloqueRodeo de feriados.js (inyectables): no hay otra definición', () => {
        const esDiaRodeo = jest.fn(f => f === '2026-09-13' || f === '2026-09-20');
        const calcularBloqueRodeo = jest.fn(f => ({ inicio: f, fin: f }));
        const r = calcularCorteAnterior({ corte: '2026-09-21', T, deps: { esDiaRodeo, calcularBloqueRodeo } });
        expect(r.anterior.corte).toBe('2026-09-13');
        expect(calcularBloqueRodeo).toHaveBeenCalledWith('2026-09-20', 1);
    });
});

describe('cambios desde el corte anterior', () => {
    const inf = ({ rodeos = 0, faltas = 0, alt = { cantidad: 0, denominador: 0 }, cobInterp = true, caidas = 0, seg = 0 } = {}) => ({
        acumulado_temporada: { rodeos: { realizados: rodeos } },
        evaluaciones: { acumulado_temporada: { faltas: { reglamentarias: { rodeos_con_falta: faltas } }, resultados_alterados: alt } },
        cobertura: { acumulado_temporada: { evaluaciones_publicadas: { porcentaje: cobInterp ? 80 : 40, interpretable: cobInterp } } },
        asociaciones: { catalogo_disponible: true, resumen: { caida_relevante_alertables: caidas } },
        senales: seg ? [{ codigo: 'JURADO_REINCIDENCIA', evidencia: Array.from({ length: seg }, (_, i) => ({ jurado: 'J' + i, categoria: 'A' })) }] : []
    });
    const por = (c, k) => c.find(x => x.clave === k);

    test('máximo 6 cambios, en el orden de prioridad pedido', () => {
        const c = cambiosCorte({ actual: inf(), anterior: inf() });
        expect(c.map(x => x.clave)).toEqual(['RODEOS_ACUMULADOS', 'COLLERAS_COMPLETAS', 'RODEOS_CON_FALTA_REGLAMENTARIA', 'RESULTADOS_ALTERADOS', 'ASOCIACIONES_MENOR_ACTIVIDAD', 'JURADOS_EN_SEGUIMIENTO']);
        expect(c.length).toBeLessThanOrEqual(CONFIG.EJECUTIVO.MAX_CAMBIOS);
    });
    test('cambios positivos, negativos y sin cambio', () => {
        const c = cambiosCorte({ actual: inf({ rodeos: 175, faltas: 32, caidas: 15, seg: 5 }), anterior: inf({ rodeos: 149, faltas: 32, caidas: 16, seg: 6 }), collerasActual: 35, collerasAnterior: 28 });
        expect(por(c, 'RODEOS_ACUMULADOS')).toMatchObject({ actual: 175, anterior: 149, delta: 26 });
        expect(por(c, 'COLLERAS_COMPLETAS')).toMatchObject({ delta: 7, disponible: true });
        expect(por(c, 'RODEOS_CON_FALTA_REGLAMENTARIA').delta).toBe(0);
        expect(por(c, 'ASOCIACIONES_MENOR_ACTIVIDAD').delta).toBe(-1);
        expect(por(c, 'JURADOS_EN_SEGUIMIENTO').delta).toBe(-1);
    });
    test('colleras sin medición anterior: SIN DATO (no 0, no inventa un cambio)', () => {
        const c = por(cambiosCorte({ actual: inf(), anterior: inf(), collerasActual: 35, collerasAnterior: null }), 'COLLERAS_COMPLETAS');
        expect(c).toMatchObject({ disponible: false, delta: null, anterior: null, motivo: 'SIN_MEDICION_ANTERIOR_O_ACTUAL' });
    });
    test('resultados alterados con cobertura insuficiente en un corte: muestra el cambio con advertencia de cobertura', () => {
        const c = por(cambiosCorte({ actual: inf({ alt: { cantidad: 40, denominador: 81 }, cobInterp: false }), anterior: inf({ alt: { cantidad: 30, denominador: 70 }, cobInterp: true }) }), 'RESULTADOS_ALTERADOS');
        expect(c).toMatchObject({ delta: 10, disponible: true, advertencia: 'COBERTURA_INSUFICIENTE', denominador_actual: 81, denominador_anterior: 70 });
    });
    test('sin evaluaciones publicadas en un corte: ausencia de publicaciones NO es cero real (sin dato)', () => {
        const c = por(cambiosCorte({ actual: inf({ alt: { cantidad: 4, denominador: 10 } }), anterior: inf({ alt: { cantidad: 0, denominador: 0 } }) }), 'RESULTADOS_ALTERADOS');
        expect(c).toMatchObject({ disponible: false, delta: null, motivo: 'SIN_EVALUACIONES_PUBLICADAS_EN_UN_CORTE' });
    });
    test('un catálogo de asociaciones no disponible no inventa el cambio de menor actividad', () => {
        const a = inf({ caidas: 3 }); a.asociaciones = { catalogo_disponible: false, resumen: null };
        expect(por(cambiosCorte({ actual: a, anterior: inf({ caidas: 1 }) }), 'ASOCIACIONES_MENOR_ACTIVIDAD')).toMatchObject({ disponible: false, delta: null });
    });
});

describe('evolución de señales: NUEVA / SE MANTIENE / RESUELTA con identidad estable', () => {
    const caida = (...asocs) => ({ codigo: 'CAIDA_ACTIVIDAD_ASOCIACION', nivel: 'ATENCION', titulo: 'menor actividad', evidencia: asocs.map(a => ({ asociacion: a })) });
    const cob = { codigo: 'BAJA_COBERTURA_EVALUACIONES', nivel: 'ATENCION', titulo: 'Baja cobertura' };
    const seg = (...js) => ({ codigo: 'JURADO_REINCIDENCIA', nivel: 'ATENCION', titulo: 'seguimiento', evidencia: js.map(j => ({ jurado: j, categoria: 'B' })) });

    test('identidad = código + entidad: caída de TALCA es distinta de caída de MAIPO', () => {
        const ids = identidadesSenales([caida('TALCA', 'MAIPO')]);
        expect([...ids.keys()]).toEqual(['CAIDA_ACTIVIDAD_ASOCIACION|TALCA', 'CAIDA_ACTIVIDAD_ASOCIACION|MAIPO']);
    });
    test('señal nueva, persistente y resuelta (por entidad)', () => {
        const e = estadoSenales([caida('TALCA', 'MAIPO'), cob], [caida('MAIPO', 'ATACAMA')]);
        expect(e.nuevas.map(x => x.clave)).toEqual(['BAJA_COBERTURA_EVALUACIONES', 'CAIDA_ACTIVIDAD_ASOCIACION|TALCA']);
        expect(e.persistentes.map(x => x.clave)).toEqual(['CAIDA_ACTIVIDAD_ASOCIACION|MAIPO']);
        expect(e.resueltas.map(x => x.clave)).toEqual(['CAIDA_ACTIVIDAD_ASOCIACION|ATACAMA']);
        expect(e.resumen).toEqual({ nuevas: 2, persistentes: 1, resueltas: 1 });
    });
    test('mismo texto y distinta entidad NO se confunden; misma entidad con otro texto sí se reconoce', () => {
        const a = caida('TALCA'); const b = { ...caida('TALCA'), titulo: 'otro texto', detalle: 'otro' };
        expect(estadoSenales([a], [b]).persistentes).toHaveLength(1);
        expect(estadoSenales([caida('TALCA')], [caida('MAIPO')])).toMatchObject({ resumen: { nuevas: 1, persistentes: 0, resueltas: 1 } });
    });
    test('estado por señal visible: NUEVA si ninguna de sus identidades existía; SE MANTIENE con entidades nuevas/resueltas', () => {
        const e = estadoSenales([caida('TALCA', 'MAIPO'), cob], [caida('MAIPO', 'ATACAMA')]);
        expect(e.por_senal.find(x => x.codigo === 'BAJA_COBERTURA_EVALUACIONES')).toMatchObject({ estado: 'NUEVA' });
        expect(e.por_senal.find(x => x.codigo === 'CAIDA_ACTIVIDAD_ASOCIACION')).toMatchObject({ estado: 'SE_MANTIENE', entidades_nuevas: 1, entidades_resueltas: 1 });
    });
    test('jurados en seguimiento se identifican por jurado + categoría', () => {
        const e = estadoSenales([seg('A', 'B')], [seg('B', 'C')]);
        expect(e.nuevas.map(x => x.clave)).toEqual(['JURADO_REINCIDENCIA|A|B']);
        expect(e.resueltas.map(x => x.clave)).toEqual(['JURADO_REINCIDENCIA|C|B']);
    });
});

describe('asociaciones: evolución de alertas', () => {
    const fila = (asociacion, actual, hist, estado, extra = {}) => ({ asociacion, rodeos_actuales: actual, rodeos_historicos_equivalentes: hist, variacion_pct: hist ? Math.round((actual - hist) / hist * 100) : null, estado, alertable: true, ...extra });
    const asoc = filas => ({ catalogo_disponible: true, asociaciones: filas });

    test('caídas nuevas / persistentes / resueltas', () => {
        const ant = asoc([fila('A', 1, 4, 'CAIDA_RELEVANTE'), fila('B', 1, 4, 'CAIDA_RELEVANTE'), fila('C', 3, 3, 'SIMILAR')]);
        const act = asoc([fila('A', 1, 4, 'CAIDA_RELEVANTE'), fila('B', 3, 3, 'SIMILAR'), fila('C', 1, 4, 'CAIDA_RELEVANTE')]);
        const e = evolucionAsociaciones(act, ant);
        expect(e.nuevas_caidas.map(x => x.asociacion)).toEqual(['C']);
        expect(e.caidas_persistentes.map(x => x.asociacion)).toEqual(['A']);
        expect(e.caidas_resueltas.map(x => x.asociacion)).toEqual(['B']);
    });
    test('sin actividad relevante = 0 actual y >0 histórico; 0/0 NO es alerta', () => {
        const ant = asoc([fila('X', 0, 3, 'SIN_ACTIVIDAD'), fila('Y', 0, 0, 'SIN_ACTIVIDAD')]);
        const act = asoc([fila('X', 0, 3, 'SIN_ACTIVIDAD'), fila('Y', 0, 0, 'SIN_ACTIVIDAD'), fila('Z', 0, 2, 'SIN_ACTIVIDAD')]);
        const e = evolucionAsociaciones(act, ant);
        expect(e.sin_actividad_persistentes.map(x => x.asociacion)).toEqual(['X']);
        expect(e.sin_actividad_nuevas.map(x => x.asociacion)).toEqual(['Z']);
        expect([...e.sin_actividad_nuevas, ...e.sin_actividad_persistentes, ...e.sin_actividad_resueltas].map(x => x.asociacion)).not.toContain('Y');
    });
    test('las no alertables (p. ej. institucionales) no figuran; catálogo no disponible → no disponible', () => {
        const act = asoc([fila('FED', 1, 4, 'CAIDA_RELEVANTE', { alertable: false })]);
        expect(evolucionAsociaciones(act, asoc([])).nuevas_caidas).toEqual([]);
        expect(evolucionAsociaciones({ catalogo_disponible: false }, act).disponible).toBe(false);
    });
});

describe('concentración de situaciones por asociación', () => {
    const rod = (id, asociacion) => ({ id, asociacion, fecha: '2026-06-06', estado: 'activo' });
    // 6 asociaciones: A(4 rodeos con falta), B(3), C(2), D(1), E(1), F(1) = 12 rodeos afectados
    function datos() {
        const realizados = [], evalPorRodeo = {}, casosPorEval = {};
        let n = 0;
        const agregar = (asoc, k, { falta = true, estado = 'publicado', alt = false } = {}) => { for (let i = 0; i < k; i++) { n++; realizados.push(rod('r' + n, asoc)); evalPorRodeo['r' + n] = { id: 'e' + n, rodeo_id: 'r' + n, estado, resultados_alterados: alt, anulada: false }; casosPorEval['e' + n] = falta ? [{ evaluacion_id: 'e' + n, tipo_caso: 'reglamentaria', anulado: false }] : []; } };
        agregar('A', 4, { alt: true }); agregar('B', 3, { alt: true }); agregar('C', 2, { alt: false }); agregar('D', 1); agregar('E', 1); agregar('F', 1);
        agregar('G', 5, { falta: false, alt: false });   // sin faltas
        return { realizados, evalPorRodeo, casosPorEval };
    }
    test('faltas reglamentarias: top 5 por asociación, denominador = todos los rodeos afectados, % en el top', () => {
        const c = concentracionSituaciones({ ...datos() });
        const f = c.faltas_reglamentarias;
        expect(f.total_rodeos_afectados).toBe(12);
        expect(f.asociaciones_con_rodeos_afectados).toBe(6);
        expect(f.top.map(x => [x.asociacion, x.rodeos_afectados])).toEqual([['A', 4], ['B', 3], ['C', 2], ['D', 1], ['E', 1]]);
        expect(f.top[0].porcentaje_del_total).toBe(33.3);
        expect(f.rodeos_en_top).toBe(11);
        expect(f.porcentaje_en_top).toBe(91.7);
        expect(f.top).toHaveLength(CONFIG.EJECUTIVO.TOP_CONCENTRACION);
    });
    test('casos anulados no cuentan como falta', () => {
        const d = datos(); d.casosPorEval.e1 = [{ evaluacion_id: 'e1', tipo_caso: 'reglamentaria', anulado: true }];
        expect(concentracionSituaciones({ ...d }).faltas_reglamentarias.total_rodeos_afectados).toBe(11);
    });
    test('resultados alterados: solo evaluaciones PUBLICADAS; X de Y y % por asociación; denominador de publicadas', () => {
        const d = datos();
        d.evalPorRodeo.r5.estado = 'borrador';   // un rodeo de B deja de estar publicado
        const c = concentracionSituaciones({ ...d, coberturaPublicadas: { numerador: 15, denominador: 20, porcentaje: 75, interpretable: true } }).resultados_alterados;
        expect(c.total_publicadas).toBe(16);   // 4+3+2+1+1+1+5 = 17 publicadas, menos 1 borrador
        expect(c.top.find(x => x.asociacion === 'B')).toMatchObject({ alterados: 2, publicadas: 2, porcentaje_de_publicadas: 100 });
        expect(c.top.map(x => x.asociacion)).toEqual(['A', 'B']);
        expect(c.total_alterados).toBe(6);
        expect(c.porcentaje_en_top).toBe(100);
        expect(c.lectura_referencial).toBe(false);
    });
    test('cobertura insuficiente: lectura referencial y cobertura visible', () => {
        const c = concentracionSituaciones({ ...datos(), coberturaPublicadas: { numerador: 17, denominador: 60, porcentaje: 28.3, interpretable: false } }).resultados_alterados;
        expect(c.lectura_referencial).toBe(true);
        expect(c.cobertura_publicadas).toEqual({ numerador: 17, denominador: 60, porcentaje: 28.3, interpretable: false });
    });
    test('sin evaluaciones publicadas: porcentaje null (SIN DATOS), no 0', () => {
        const d = datos(); Object.values(d.evalPorRodeo).forEach(e => { e.estado = 'borrador'; });
        const c = concentracionSituaciones({ ...d }).resultados_alterados;
        expect(c).toMatchObject({ total_publicadas: 0, total_alterados: 0, porcentaje_alterados: null, porcentaje_en_top: null, top: [] });
    });
    test('NO agrupa por jurado: el resultado no contiene jurados', () => {
        expect(JSON.stringify(concentracionSituaciones({ ...datos() }))).not.toMatch(/jurado"|usuario/);
    });
    test('usa el catálogo de asociaciones (alias) para el nombre canónico', () => {
        const catalogo = [{ id: 'a1', nombre: 'ARAUCO', nombre_normalizado: 'arauco', activa: true }];
        const d = datos(); d.realizados[0].asociacion = 'Arauco ';
        const nombres = concentracionSituaciones({ ...d, catalogo }).faltas_reglamentarias.top.map(x => x.asociacion);
        expect(nombres).toContain('ARAUCO');
    });
});

describe('utilización del cuerpo de jurados', () => {
    const j = (id, disp, desig, util, estado = 'CON_DECLARACION') => ({ usuario_id: id, jurado: id, estado, porcentaje_disponibilidad_declarada: disp, designaciones: desig, utilizacion_sobre_disponibilidad_declarada: util });
    const dispo = detalle => ({ bloques_posibles: 27, detalle });

    test('con disponibilidad declarada y 0 designaciones (no cuenta a quienes no declararon)', () => {
        const u = utilizacionJurados(dispo([j('a', 50, 0, 0), j('b', 50, 2, 40), j('c', 0, 0, null, 'SIN_DECLARACION_REGISTRADA')]));
        expect(u.disponibles_sin_designacion).toMatchObject({ cantidad: 1, sobre_con_declaracion: 2 });
    });
    test('alta disponibilidad / baja utilización: ≥75 % y ≤25 % (umbrales de config, inclusivos)', () => {
        const u = utilizacionJurados(dispo([j('a', 75, 1, 25), j('b', 80, 1, 26), j('c', 74, 0, 0), j('d', 90, 0, 0), j('e', 90, 2, null)]));
        expect(u.alta_disponibilidad_baja_utilizacion.cantidad).toBe(2);   // a (límites) y d
        expect(u.alta_disponibilidad_baja_utilizacion).toMatchObject({ umbral_disponibilidad_pct: 75, umbral_utilizacion_pct: 25, criterio: '≥75 % disponibilidad declarada y ≤25 % utilización' });
    });
    test('los umbrales son configurables (no fijos en el código)', () => {
        const cfg = cfgCon({ UTILIZACION: { ALTA_DISPONIBILIDAD_PCT: 50, BAJA_UTILIZACION_PCT: 50, CONCENTRACION_TOP_PCT: 50 } });
        const u = utilizacionJurados(dispo([j('a', 60, 1, 40), j('b', 60, 3, 60)]), cfg);
        expect(u.alta_disponibilidad_baja_utilizacion).toMatchObject({ cantidad: 1, criterio: '≥50 % disponibilidad declarada y ≤50 % utilización' });
        expect(u.concentracion_designaciones).toMatchObject({ porcentaje_jurados_top: 50, jurados_en_top: 1, designaciones_en_top: 3, porcentaje_designaciones_en_top: 75 });
    });
    test('concentración: el 20 % de los jurados con más designaciones', () => {
        // 10 jurados: 2 con 10 designaciones, 8 con 5 → total 60; top 20 % = 2 jurados = 20/60 = 33,3 %
        const det = [...Array.from({ length: 2 }, (_, i) => j('t' + i, 50, 10, 50)), ...Array.from({ length: 8 }, (_, i) => j('u' + i, 50, 5, 50))];
        const c = utilizacionJurados(dispo(det)).concentracion_designaciones;
        expect(c).toMatchObject({ jurados_considerados: 10, designaciones: 60, jurados_en_top: 2, designaciones_en_top: 20, porcentaje_designaciones_en_top: 33.3 });
    });
    test('sin designaciones efectivas: sin dato (null), no 0', () => {
        expect(utilizacionJurados(dispo([j('a', 50, 0, 0)])).concentracion_designaciones.porcentaje_designaciones_en_top).toBeNull();
        expect(utilizacionJurados(dispo([])).concentracion_designaciones.porcentaje_designaciones_en_top).toBeNull();
    });
    test('deja explícito que son indicadores de uso (no evaluación) y reutiliza la definición de designación efectiva', () => {
        const u = utilizacionJurados(dispo([]));
        expect(u.nota).toMatch(/no una evaluación/);
        expect(u.definicion_designacion_efectiva).toMatch(/rechazado/);
    });
});

describe('lectura ejecutiva determinística (sin IA generativa)', () => {
    const base = (over = {}) => ({
        comparacion: { rodeos: { disponible: true, diferencia: 0 }, referencia: { temporada: '2025-2026' } },
        colleras: { comparacion: { temporadas: [{ estado: 'OK', temporada: '2025-2026', variacion_pct: 25 }] } },
        asociaciones: { catalogo_disponible: true, resumen: { caida_relevante_alertables: 15, sin_actividad_con_historico_positivo: 0 } },
        cobertura: { acumulado_temporada: { evaluaciones_publicadas: { denominador: 175, porcentaje: 46.3, interpretable: false } } },
        senales: [{ codigo: 'JURADO_REINCIDENCIA', evidencia: [{}, {}, {}, {}, {}, {}] }],
        ...over
    });
    const textos = inf => lecturaEjecutiva(inf).map(f => f.texto);

    test('actividad: más / menos / igual (con singular)', () => {
        expect(textos(base({ comparacion: { rodeos: { disponible: true, diferencia: 3 }, referencia: { temporada: '2025-2026' } } }))[0]).toBe('La actividad acumulada registra 3 rodeos más que 2025-2026 a fecha equivalente.');
        expect(textos(base({ comparacion: { rodeos: { disponible: true, diferencia: -1 }, referencia: { temporada: '2025-2026' } } }))[0]).toBe('La actividad acumulada registra 1 rodeo menos que 2025-2026 a fecha equivalente.');
        expect(textos(base())[0]).toBe('La actividad acumulada se mantiene igual a 2025-2026 a fecha equivalente.');
    });
    test('colleras: sobre / bajo / sin referencia comparable', () => {
        expect(textos(base())[1]).toBe('Las colleras completas se encuentran 25,0 % sobre 2025-2026 a fecha equivalente.');
        expect(textos(base({ colleras: { comparacion: { temporadas: [{ estado: 'OK', temporada: '2025-2026', variacion_pct: -12.5 }] } } }))[1]).toBe('Las colleras completas se encuentran 12,5 % bajo 2025-2026 a fecha equivalente.');
        expect(textos(base({ colleras: { comparacion: { temporadas: [{ estado: 'SIN_DATO_HISTORICO_COMPARABLE' }] } } }))[1]).toBe('No existe referencia histórica comparable de colleras para esta fecha.');
    });
    test('asociaciones: menor actividad; y 0 actual / >0 histórico se destaca antes que 0/0', () => {
        expect(textos(base())[2]).toBe('15 asociaciones presentan menor actividad respecto de 2025-2026 a fecha equivalente.');
        const conSin = base({ asociaciones: { catalogo_disponible: true, resumen: { caida_relevante_alertables: 2, sin_actividad_con_historico_positivo: 1 } } });
        expect(textos(conSin)[2]).toBe('1 asociación sin rodeos registra rodeos en 2025-2026 a fecha equivalente; 2 presentan menor actividad.');
        const solo00 = base({ asociaciones: { catalogo_disponible: true, resumen: { caida_relevante_alertables: 0, sin_actividad_con_historico_positivo: 0 } } });
        expect(lecturaEjecutiva(solo00).some(f => f.codigo === 'ASOCIACIONES')).toBe(false);
    });
    test('cobertura: solo aparece cuando es insuficiente', () => {
        expect(textos(base())[3]).toBe('La cobertura de evaluaciones publicadas es 46,3 %, por lo que los indicadores derivados deben interpretarse con cautela.');
        const ok = base({ cobertura: { acumulado_temporada: { evaluaciones_publicadas: { denominador: 175, porcentaje: 80, interpretable: true } } } });
        expect(lecturaEjecutiva(ok).some(f => f.codigo === 'COBERTURA')).toBe(false);
    });
    test('máximo 4 frases por prioridad configurada (jurados queda fuera si ya hay 4)', () => {
        const f = lecturaEjecutiva(base());
        expect(f).toHaveLength(4);
        expect(f.map(x => x.codigo)).toEqual(['ACTIVIDAD', 'COLLERAS', 'ASOCIACIONES', 'COBERTURA']);
        expect(f.map(x => x.prioridad)).toEqual([1, 2, 3, 4]);
    });
    test('si hay espacio, la frase de jurados en seguimiento entra', () => {
        const f = lecturaEjecutiva(base({ cobertura: { acumulado_temporada: { evaluaciones_publicadas: { denominador: 175, porcentaje: 80, interpretable: true } } } }));
        expect(f.map(x => x.codigo)).toEqual(['ACTIVIDAD', 'COLLERAS', 'ASOCIACIONES', 'JURADOS']);
        expect(f[3].texto).toBe('6 jurados presentan señales objetivas de seguimiento.');
    });
    test('la prioridad y el máximo son configurables', () => {
        const f = lecturaEjecutiva(base(), cfgCon({ EJECUTIVO: { ...CONFIG.EJECUTIVO, MAX_FRASES: 2, PRIORIDAD_FRASES: ['COBERTURA', 'ACTIVIDAD'] } }));
        expect(f.map(x => x.codigo)).toEqual(['COBERTURA', 'ACTIVIDAD']);
    });
    test('determinística: mismos datos → exactamente el mismo resultado', () => {
        expect(JSON.stringify(lecturaEjecutiva(base()))).toBe(JSON.stringify(lecturaEjecutiva(base())));
    });
    test('lenguaje neutro: ninguna frase emite juicios ("mejor", "peor", "mal", "problema", "subutiliz")', () => {
        const todos = [base(), base({ comparacion: { rodeos: { disponible: true, diferencia: -9 }, referencia: { temporada: 'X' } } })].flatMap(textos).join(' ');
        expect(todos).not.toMatch(/mejor|peor|\bmal\b|problema|subutiliz|deficien|gesti[oó]n est/i);
    });
    test('ningún texto lo genera una IA: el módulo no usa red ni librerías de IA', () => {
        const fuente = ['lecturaEjecutiva.js', 'evolucion.js', 'concentracion.js', 'utilizacion.js', 'corteAnterior.js'].map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
        expect(fuente).not.toMatch(/require\('(https?|node-fetch|axios|openai|@anthropic-ai\/[^']*)'\)|fetch\(|Math\.random|Date\.now\(\)/);
    });
});

describe('integración con calcularInforme (mismo motor, datos en memoria)', () => {
    const rod = (id, fecha, asociacion, extra = {}) => ({ id, fecha, club: 'C' + id, asociacion, tipo_rodeo_id: 'T', tipo_rodeo_nombre: 'Provincial', categoria_rodeo_nombre: null, estado: 'activo', duracion_dias: 1, es_prueba: false, ...extra });
    function ds(extra = {}) {
        const rodeos = [rod('a1', '2026-09-05', 'ARAUCO'), rod('a2', '2026-09-06', 'OSORNO'), rod('b1', '2026-09-12', 'ARAUCO'), rod('b2', '2026-09-13', 'ARAUCO'), rod('c1', '2026-09-19', 'OSORNO'), rod('c2', '2026-09-20', 'ARAUCO')];
        const evaluaciones = rodeos.map(r => ({ id: 'e' + r.id, rodeo_id: r.id, estado: 'publicado', nota_final: 5, resultados_alterados: r.id.startsWith('c'), anulada: false }));
        return {
            temporada: T, rodeos, categoriaPorTipoId: { T: 'Segunda' }, evaluaciones,
            casos: [{ evaluacion_id: 'ec1', tipo_caso: 'reglamentaria', anulado: false }, { evaluacion_id: 'eb1', tipo_caso: 'reglamentaria', anulado: false }],
            cartillas: [], notasSecundarias: [], notasJurado: [], disponibilidad: [],
            asignaciones: rodeos.map((r, i) => ({ id: 'as' + i, rodeo_id: r.id, usuario_pagado_id: i < 4 ? 'J1' : 'J2', tipo_persona: 'jurado', categoria_aplicada: 'A', estado: 'activo', estado_designacion: 'aceptado' })),
            usuarios: [{ id: 'J1', nombre_completo: 'JURADO UNO', categoria: 'A', activo: true, estado_usuario: 'activo', tipo_persona: 'jurado', es_prueba: false }, { id: 'J2', nombre_completo: 'JURADO DOS', categoria: 'A', activo: true, estado_usuario: 'activo', tipo_persona: 'jurado', es_prueba: false }],
            catalogoAsociaciones: [{ id: 'A1', nombre: 'ARAUCO', nombre_normalizado: 'arauco', activa: true, es_especial: false, incluir_en_alertas: true }, { id: 'A2', nombre: 'OSORNO', nombre_normalizado: 'osorno', activa: true, es_prueba: false, es_especial: false, incluir_en_alertas: true }],
            aliasAsociaciones: [], historicoRodeos: null, historicoColleras: null, snapshotsColleras: [],
            fuentes: { asociaciones: { disponible: true }, historico_rodeos: { disponible: false }, historico_colleras: { disponible: false } },
            ...extra
        };
    }
    const COL = { total: 35, fechaDato: '2026-09-24T15:00:00.000Z', fuente: 'en_vivo', estado: 'actual', resumen: {}, detalle_error: null };
    const generar = (dataset, params = { desde: '2026-09-18', hasta: '2026-09-20', hoy: '2026-09-24' }, opts) => calcularInforme(params, dataset, COL, new Date('2026-09-24T15:00:00Z'), CONFIG, opts);

    test('agrega las secciones nuevas sin alterar las anteriores (compatibilidad con el payload previo)', () => {
        const nuevo = generar(ds());
        const previo = generar(ds(), undefined, { sinEvolucion: true });
        const { evolucion_corte, estado_senales, concentracion, utilizacion_jurados, lectura_ejecutiva, ...resto } = nuevo;
        expect(resto).toEqual(previo);
        expect(Object.keys(nuevo).slice(-5)).toEqual(['evolucion_corte', 'estado_senales', 'concentracion', 'utilizacion_jurados', 'lectura_ejecutiva']);
    });
    test('cambios reales del corte: 4 rodeos hasta el 13/09 → 6 al corte actual (+2), calculados con el mismo motor', () => {
        const e = generar(ds()).evolucion_corte;
        expect(e).toMatchObject({ disponible: true, actual: { bloque: { etiqueta: '18–20 SEP' } }, anterior: { corte: '2026-09-13' } });
        const r = e.cambios.find(c => c.clave === 'RODEOS_ACUMULADOS');
        expect(r).toMatchObject({ actual: 6, anterior: 4, delta: 2 });
        expect(e.cambios.find(c => c.clave === 'RODEOS_CON_FALTA_REGLAMENTARIA')).toMatchObject({ actual: 2, anterior: 1, delta: 1 });
        expect(e.nota_metodologica).toMatch(/no reconstruye/);
    });
    test('colleras del corte anterior: usa el último snapshot válido ≤ corte anterior; sin snapshot no inventa el cambio', () => {
        const conSnap = generar(ds({ snapshotsColleras: [{ fecha_snapshot: '2026-09-12T15:00:00Z', total_colleras: 28 }, { fecha_snapshot: '2026-09-15T15:00:00Z', total_colleras: 31 }] }));
        expect(conSnap.evolucion_corte.cambios.find(c => c.clave === 'COLLERAS_COMPLETAS')).toMatchObject({ actual: 35, anterior: 28, delta: 7 });
        expect(generar(ds()).evolucion_corte.cambios.find(c => c.clave === 'COLLERAS_COMPLETAS').disponible).toBe(false);
    });
    test('primer bloque de la temporada: SIN CORTE ANTERIOR COMPARABLE, sin cambios inventados y sin señales de evolución', () => {
        const d = ds({ rodeos: [rod('p1', '2026-04-04', 'ARAUCO')], evaluaciones: [], casos: [], asignaciones: [] });
        const inf = generar(d, { desde: '2026-04-01', hasta: '2026-04-05', hoy: '2026-09-24' });
        expect(inf.evolucion_corte).toMatchObject({ disponible: false, motivo: SIN_CORTE_ANTERIOR, etiqueta: 'SIN CORTE ANTERIOR COMPARABLE', cambios: [] });
        expect(inf.estado_senales).toMatchObject({ disponible: false, nuevas: [], persistentes: [], resueltas: [] });
    });
    test('cuentas de prueba y rodeos de prueba se excluyen también de utilización y concentración', () => {
        const d = ds();
        d.usuarios[1].es_prueba = true;                    // J2 (sus 2 designaciones)
        d.rodeos.find(r => r.id === 'c1').es_prueba = true;   // rodeo de prueba con falta reglamentaria
        const inf = generar(d);
        expect(inf.utilizacion_jurados.jurados_considerados).toBe(1);
        expect(inf.concentracion.faltas_reglamentarias.total_rodeos_afectados).toBe(1);   // solo b1 (c1 excluido)
        expect(inf.evolucion_corte.cambios.find(c => c.clave === 'RODEOS_ACUMULADOS').actual).toBe(5);
    });
    test('la lectura ejecutiva del payload es determinística y de máximo 4 frases', () => {
        const a = generar(ds()).lectura_ejecutiva, b = generar(ds()).lectura_ejecutiva;
        expect(a).toEqual(b);
        expect(a.length).toBeLessThanOrEqual(CONFIG.EJECUTIVO.MAX_FRASES);
    });
    test('utilización del payload usa la definición de designación efectiva de la disponibilidad (anuladas y rechazadas no cuentan)', () => {
        const d = ds();
        d.asignaciones[0].estado = 'anulado'; d.asignaciones[1].estado_designacion = 'rechazado';
        const u = generar(d).utilizacion_jurados;
        expect(u.concentracion_designaciones.designaciones).toBe(4);
    });
});
