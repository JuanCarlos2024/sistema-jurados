jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../colleras-completas', () => ({ obtenerCollerasCompletas: jest.fn() }));

const { calcularInforme, generarInforme, comparar } = require('./informe');
const { cargarDataset, leerPaginado, leerOpcional, trocear } = require('./cargaDatos');

const T = { id: 't1', nombre: '2026-2027', inicio: '2026-04-01', fin: '2027-03-31', fuente: 'test' };
const CAT = { T_SEG: 'Segunda', T_PRI: 'Primera' };
const r = (id, fecha, asociacion, extra = {}) => ({ id, fecha, club: 'C' + id, asociacion, tipo_rodeo_id: 'T_SEG', tipo_rodeo_nombre: 'Provincial', categoria_rodeo_nombre: null, estado: 'activo', duracion_dias: 1, ...extra });
const h = (fecha, asociacion_id, categoria = 'Segunda', tipo = 'Provincial') => ({ temporada: '2025-2026', fecha_rodeo: fecha, asociacion_id, asociacion_normalizada: null, tipo_rodeo: tipo, categoria });

function dataset(extra = {}) {
    return {
        temporada: T,
        rodeos: [
            r('a2', '2026-07-04', 'COLCHAGUA'), r('a1', '2026-08-15', 'ARAUCO'),
            r('p1', '2026-09-18', 'ARAUCO'), r('p2', '2026-09-19', 'COLCHAGUA', { tipo_rodeo_id: 'T_PRI', categoria_rodeo_nombre: 'Primera' }), r('p3', '2026-09-20', 'OSORNO'),
            r('f1', '2026-09-26', 'OSORNO'), r('an1', '2026-09-19', 'OSORNO', { estado: 'anulado' })
        ],
        categoriaPorTipoId: CAT,
        evaluaciones: [
            { id: 'e1', rodeo_id: 'p1', estado: 'publicado', nota_final: 6, resultados_alterados: true, anulada: false },
            { id: 'e2', rodeo_id: 'p2', estado: 'publicado', nota_final: 5, resultados_alterados: false, anulada: false },
            { id: 'e3', rodeo_id: 'p3', estado: 'borrador', nota_final: 2, resultados_alterados: true, anulada: false },
            { id: 'e4', rodeo_id: 'a1', estado: 'publicado', nota_final: 4, resultados_alterados: false, anulada: false }
        ],
        casos: [{ evaluacion_id: 'e1', tipo_caso: 'reglamentaria', anulado: false }, { evaluacion_id: 'e1', tipo_caso: 'interpretativa', anulado: true }],
        cartillas: [{ rodeo_id: 'p1', estado: 'enviada', datos: { hubo_ganado_fuera_peso: 'si', caseta_adecuada: 'si' } }],
        asignaciones: [
            { id: 'as1', rodeo_id: 'p1', usuario_pagado_id: 'U1', tipo_persona: 'jurado', categoria_aplicada: 'B', estado: 'activo', estado_designacion: 'aceptado' },
            { id: 'as2', rodeo_id: 'p2', usuario_pagado_id: 'U1', tipo_persona: 'jurado', categoria_aplicada: 'B', estado: 'activo', estado_designacion: 'aceptado' }
        ],
        notasSecundarias: [{ rodeo_id: 'p1', nota_comision: 6.5, nota_delegado: null }],
        usuarios: [{ id: 'U1', nombre_completo: 'JUAN', categoria: 'B', activo: true, estado_usuario: 'activo', tipo_persona: 'jurado' }],
        disponibilidad: [{ usuario_pagado_id: 'U1', fecha: '2026-09-19' }],
        notasJurado: [{ asignacion_id: 'as1', nota: 6 }, { asignacion_id: 'as2', nota: 5 }],
        catalogoAsociaciones: [
            { id: 'A1', nombre: 'ARAUCO', nombre_normalizado: 'arauco', activa: true, es_especial: false, incluir_en_alertas: true },
            { id: 'A2', nombre: 'COLCHAGUA', nombre_normalizado: 'colchagua', activa: true, es_especial: false, incluir_en_alertas: true },
            { id: 'A3', nombre: 'OSORNO', nombre_normalizado: 'osorno', activa: true, es_especial: false, incluir_en_alertas: true },
            { id: 'A4', nombre: 'CHILOE', nombre_normalizado: 'chiloe', activa: true, es_especial: false, incluir_en_alertas: true },
            { id: 'A5', nombre: 'FEDERACION', nombre_normalizado: 'federacion', activa: true, es_especial: true, incluir_en_alertas: false }
        ],
        aliasAsociaciones: [],
        // 2025-2026: ventana equivalente 2025-04-02 .. 2025-09-21 (corte) .. 2026-04-01
        historicoRodeos: [
            h('2025-05-10', 'A1'), h('2025-06-14', 'A2'), h('2025-08-16', 'A4'), h('2025-08-30', 'A3', 'Primera'),
            h('2025-09-19', 'A1'), h('2025-09-20', 'A2', 'Primera'), h('2025-09-21', 'A3'),      // fin de semana equivalente (3)
            h('2025-10-04', 'A1'), h('2025-11-08', 'A2'), h('2025-12-13', 'A3'), h('2026-01-10', 'A1'), h('2026-02-14', 'A2'), h('2026-03-14', 'A3'), h('2026-03-28', 'A1')
        ],
        historicoColleras: [
            { temporada: '2025-2026', fecha_medicion: '2025-09-28', total_colleras: 28, fecha_confirmada: true },
            { temporada: '2025-2026', fecha_medicion: '2026-02-01', total_colleras: 340, fecha_confirmada: true },
            { temporada: '2025-2026', fecha_medicion: '2025-10-04', total_colleras: 37, fecha_confirmada: false }
        ],
        fuentes: { asociaciones: { disponible: true }, historico_rodeos: { disponible: true }, historico_colleras: { disponible: true } },
        ...extra
    };
}
const COLLERAS = { total: 35, fechaDato: '2026-09-24T15:00:00.000Z', fuente: 'en_vivo', estado: 'actual', resumen: {}, detalle_error: null };
const params = { desde: '2026-09-18', hasta: '2026-09-20', hoy: '2026-09-24' };
const generar = (ds = dataset(), col = COLLERAS, p = params) => calcularInforme(p, ds, col, new Date('2026-09-24T15:00:00Z'));

describe('calcularInforme: estructura de la respuesta única', () => {
    const inf = generar();
    test('contiene las secciones anteriores intactas (mismo orden) y las nuevas de la capa ejecutiva al final', () => {
        expect(Object.keys(inf)).toEqual(['metadata', 'periodo', 'acumulado_temporada', 'historico_equivalente', 'comparacion', 'proyecciones', 'rodeos', 'colleras', 'evaluaciones', 'jurados', 'asociaciones', 'disponibilidad', 'cobertura', 'series', 'senales', 'evolucion_corte', 'estado_senales', 'concentracion', 'utilizacion_jurados', 'lectura_ejecutiva']);
    });
    test('metadata: temporada de la tabla (01/04–31/03), definiciones y versión del motor', () => {
        expect(inf.metadata).toMatchObject({ periodo: { desde: '2026-09-18', hasta: '2026-09-20' }, temporada: { nombre: '2026-2027', inicio: '2026-04-01', fin: '2027-03-31' } });
        expect(inf.metadata.definiciones.rodeo_realizado).toMatch(/activo/);
        expect(inf.metadata.version_motor).toBe('informe-gestion-1.0');
    });
});

describe('calcularInforme: rodeos (período vs acumulado vs histórico)', () => {
    const inf = generar();
    test('período: solo realizados dentro del rango; acumulado desde inicio de temporada; anulados y futuros fuera', () => {
        expect(inf.periodo.rodeos).toMatchObject({ realizados: 3, programados: 1, anulados_excluidos: 1, total: 4 });
        expect(inf.acumulado_temporada.rodeos).toMatchObject({ realizados: 5, programados: 1, anulados_excluidos: 1 });
        expect(inf.acumulado_temporada.rango).toEqual({ desde: '2026-04-01', hasta: '2026-09-20' });
    });
    test('categoría efectiva derivada (Segunda) y propia (Primera)', () => {
        const c = Object.fromEntries(inf.acumulado_temporada.rodeos.por_categoria.map(x => [x.clave, x.cantidad]));
        expect(c).toEqual({ Segunda: 4, Primera: 1 });
    });
    test('histórico equivalente: ventana de 52 semanas y conteos a esa fecha', () => {
        const t = inf.historico_equivalente.temporadas[0];
        expect(t).toMatchObject({ temporada: '2025-2026', k: 1, ventana: { inicio: '2025-04-02', corte: '2025-09-21', fin: '2026-04-01' }, rodeos_a_fecha_equivalente: 7, rodeos_cierre_temporada: 14, rodeos_periodo_equivalente: 3 });
    });
    test('comparación: diferencia, variación % y tendencia', () => {
        expect(inf.comparacion.rodeos).toMatchObject({ actual: 5, historico: 7, diferencia: -2, variacion_pct: -28.6, tendencia: 'BAJA', simbolo: '↓' });
        expect(inf.comparacion.rodeos_periodo).toMatchObject({ actual: 3, historico: 3, tendencia: 'IGUAL' });
        expect(inf.comparacion.por_categoria.find(x => x.clave === 'Primera')).toMatchObject({ actual: 1, historico: 2 });
    });
    test('período anterior de igual largo dentro de la temporada', () => {
        expect(inf.comparacion.periodo_anterior.rango).toEqual({ desde: '2026-09-15', hasta: '2026-09-17' });
    });
    test('proyección de rodeos referencial con 1 temporada (avance histórico 7/14 = 50 %)', () => {
        expect(inf.proyecciones.rodeos).toMatchObject({ estado: 'PROYECCION_DISPONIBLE', estimacion: 10, temporadas_comparables: 1, confianza: 'REFERENCIAL' });
        expect(inf.proyecciones.rodeos.datos_base.piso_calendario_conocido).toBe(6);
    });
    test('comparar() sin dato no inventa cero', () => {
        expect(comparar(5, null)).toMatchObject({ disponible: false, variacion_pct: null, tendencia: null });
    });
});

describe('calcularInforme: fechas', () => {
    test('un rodeo futuro nunca es realizado aunque "hasta" sea posterior a hoy (se corta en hoy)', () => {
        const inf = generar(dataset(), COLLERAS, { desde: '2026-09-18', hasta: '2026-09-30', hoy: '2026-09-24' });
        expect(inf.metadata.periodo.hasta).toBe('2026-09-24');
        expect(inf.metadata.advertencias.join(' ')).toMatch(/posterior a hoy/);
        expect(inf.acumulado_temporada.rodeos.programados).toBe(1);   // f1 (26/09) sigue programado
    });
    test('"desde" anterior al inicio de temporada parte del inicio', () => {
        const inf = generar(dataset(), COLLERAS, { desde: '2026-01-01', hasta: '2026-09-20', hoy: '2026-09-24' });
        expect(inf.metadata.periodo.desde).toBe('2026-04-01');
    });
});

describe('calcularInforme: evaluación, alterados y cobertura', () => {
    const inf = generar();
    test('evaluación del período: 2 publicadas de 3 realizados; el borrador no cuenta', () => {
        expect(inf.evaluaciones.periodo.evaluacion).toMatchObject({ rodeos_realizados: 3, evaluaciones_publicadas: 2, cobertura_evaluacion: 0.667, nota_promedio_publicada: 5.5 });
    });
    test('resultados alterados: 1/2 publicadas = 50 % (el borrador con alterado=true no entra)', () => {
        expect(inf.evaluaciones.periodo.resultados_alterados).toMatchObject({ cantidad: 1, denominador: 2, porcentaje: 50, interpretable: true });
    });
    test('faltas: casos anulados excluidos; disciplinarias no disponibles', () => {
        expect(inf.evaluaciones.periodo.faltas).toMatchObject({
            reglamentarias: { casos_total: 1, rodeos_con_falta: 1 }, apreciacion: { casos_total: 0, rodeos_con_falta: 0 }, casos_anulados_excluidos: 1
        });
        expect(inf.evaluaciones.periodo.faltas.disciplinarias).toMatchObject({ rodeos_con_falta: 0, denominador_cartillas: 0 });   // la cartilla de p1 no trae hubo_faltas
    });
    test('cartillas y coberturas: nota comisión 1/2 elegibles, delegado 0/2 (baja cobertura informada)', () => {
        expect(inf.cobertura.periodo.cartillas_jurado).toMatchObject({ numerador: 1, denominador: 3 });
        expect(inf.cobertura.periodo.nota_comision).toMatchObject({ numerador: 1, denominador: 2 });
        expect(inf.cobertura.periodo.nota_delegado).toMatchObject({ numerador: 0, denominador: 2, interpretable: false });
        expect(inf.evaluaciones.periodo.cobertura).toBeUndefined();   // la cobertura vive solo en la sección `cobertura`
    });
    test('ranking Top/Bottom con N elegibles y notas separadas', () => {
        const t = inf.rodeos.ranking.acumulado_temporada;
        expect(t.n_elegibles).toBe(3);
        expect(t.top[0]).toMatchObject({ rodeo_id: 'p1', nota_final: 6, nota_comision: 6.5, nota_delegado: null, jurados: ['JUAN'] });
        expect(t.bottom[0]).toMatchObject({ rodeo_id: 'a1', nota_final: 4 });
    });
});

describe('calcularInforme: asociaciones, jurados, disponibilidad, colleras y señales', () => {
    const inf = generar();
    test('asociaciones: CHILOE sin actividad (alerta); FEDERACION especial excluida de alertas', () => {
        const chiloe = inf.asociaciones.asociaciones.find(a => a.asociacion === 'CHILOE');
        expect(chiloe).toMatchObject({ rodeos_actuales: 0, rodeos_historicos_equivalentes: 1, estado: 'SIN_ACTIVIDAD', alertable: true });
        expect(inf.asociaciones.asociaciones.find(a => a.asociacion === 'FEDERACION').alertable).toBe(false);
        const s = inf.senales.find(x => x.codigo === 'ASOCIACIONES_SIN_RODEOS');
        expect(s.evidencia.map(e => e.asociacion)).toEqual(['CHILOE']);
    });
    test('jurados por categoría con muestra y sin juicios personales', () => {
        expect(inf.jurados.detalle[0]).toMatchObject({ jurado: 'JUAN', categoria: 'B', rodeos: 2, nivel_muestra: 'INSUFICIENTE', nota_promedio: 5.5, resultados_alterados_atribuidos: null });
        expect(JSON.stringify(inf.jurados).toLowerCase()).not.toContain('mal jurado');
    });
    test('disponibilidad declarada, nunca "no disponible"', () => {
        expect(inf.disponibilidad.periodo.resumen).toMatchObject({ con_declaracion: 1, sin_declaracion_registrada: 0 });
        expect(JSON.stringify(inf.disponibilidad)).not.toMatch(/"estado":"NO_DISPONIBLE"/);
    });
    test('colleras: comparación con la medición confirmada más cercana (±7 días); las no confirmadas se ignoran', () => {
        expect(inf.colleras.fecha_dato_iso).toBe('2026-09-24');
        expect(inf.colleras.comparacion.temporadas[0]).toMatchObject({ temporada: '2025-2026', fecha_objetivo: '2025-09-25', estado: 'OK', historico: 28, actual: 35, variacion_pct: 25, diferencia_dias: 3 });
        expect(inf.proyecciones.colleras).toMatchObject({ estado: 'PROYECCION_NO_DISPONIBLE' });   // 28/340 < 25 %
        expect(inf.senales.find(x => x.codigo === 'COLLERAS_SOBRE_HISTORICO').nivel).toBe('INFO');
    });
    test('colleras sin histórico comparable: SIN_DATO_HISTORICO_COMPARABLE', () => {
        const ds = dataset({ historicoColleras: [{ temporada: '2025-2026', fecha_medicion: '2025-12-01', total_colleras: 150, fecha_confirmada: true }] });
        const x = generar(ds);
        expect(x.colleras.comparacion).toMatchObject({ disponible: false, motivo: 'SIN_DATO_HISTORICO_COMPARABLE' });
        expect(x.colleras.comparacion.temporadas[0].estado).toBe('SIN_DATO_HISTORICO_COMPARABLE');
    });
    test('colleras en fallback y no disponible se advierten; el informe se genera igual', () => {
        expect(generar(dataset(), { ...COLLERAS, fuente: 'snapshot', estado: 'fallback' }).metadata.advertencias.join(' ')).toMatch(/último snapshot válido/);
        const x = generar(dataset(), { total: null, fechaDato: null, fuente: 'ninguna', estado: 'no_disponible' });
        expect(x.colleras.comparacion.motivo).toBe('DATO_ACTUAL_NO_DISPONIBLE');
        expect(x.acumulado_temporada.rodeos.realizados).toBe(5);
    });
    test('sin catálogo ni históricos: el informe funciona y lo informa (no se usa DISTINCT como universo)', () => {
        const x = generar(dataset({
            catalogoAsociaciones: null, historicoRodeos: null, historicoColleras: null,
            fuentes: { asociaciones: { disponible: false, motivo: 'no existe' }, historico_rodeos: { disponible: false }, historico_colleras: { disponible: false } }
        }));
        expect(x.asociaciones.catalogo_disponible).toBe(false);
        expect(x.asociaciones.asociaciones).toEqual([]);
        expect(x.historico_equivalente.disponible).toBe(false);
        expect(x.proyecciones.rodeos).toMatchObject({ estado: 'PROYECCION_NO_DISPONIBLE', motivo: 'SIN_HISTORICO' });
        expect(x.metadata.advertencias.join(' ')).toMatch(/Catálogo de asociaciones no disponible/);
    });
    test('señales determinísticas: mismo dataset → mismas señales', () => {
        expect(generar().senales).toEqual(generar().senales);
    });
});

describe('generarInforme (parámetros y colleras en paralelo)', () => {
    test('valida fechas', async () => {
        await expect(generarInforme({ desde: '2026-09-18' })).rejects.toMatchObject({ status: 400 });
        await expect(generarInforme({ desde: '2026-09-20', hasta: '2026-09-18' })).rejects.toMatchObject({ status: 400 });
        await expect(generarInforme({ desde: 'x', hasta: 'y' })).rejects.toThrow(/YYYY-MM-DD/);
    });
    test('ensambla dataset + colleras y usa el reloj inyectado', async () => {
        const cargar = jest.fn().mockResolvedValue(dataset());
        const colleras = jest.fn().mockResolvedValue(COLLERAS);
        const inf = await generarInforme({ desde: '2026-09-18', hasta: '2026-09-20' }, { cargar, colleras, ahora: () => new Date('2026-09-24T15:00:00Z') });
        expect(cargar).toHaveBeenCalledWith({ hasta: '2026-09-20' });
        expect(colleras).toHaveBeenCalledTimes(1);
        expect(inf.periodo.rodeos.realizados).toBe(3);
    });
});

// ── carga de datos: sin N+1, paginada, tolerante a tablas nuevas ──────────
function dbMock(tablas) {
    const llamadas = [];
    const db = {
        llamadas,
        rpc: () => { throw new Error('rpc no permitido en el informe'); },
        from: jest.fn(nombre => {
            llamadas.push(nombre);
            const c = { _rango: null };
            ['select', 'gte', 'lte', 'eq', 'in', 'order', 'limit'].forEach(m => { c[m] = () => c; });
            ['insert', 'update', 'delete', 'upsert'].forEach(m => { c[m] = () => { throw new Error('escritura no permitida en el informe: ' + m); }; });
            c.range = (d, h) => { c._rango = [d, h]; return c; };
            c.then = res => {
                const t = tablas[nombre];
                if (t instanceof Error) return Promise.resolve({ data: null, error: { message: t.message } }).then(res);
                const filas = t || [];
                const data = c._rango ? filas.slice(c._rango[0], c._rango[1] + 1) : filas;
                return Promise.resolve({ data, error: null }).then(res);
            };
            return c;
        })
    };
    return db;
}

describe('cargaDatos', () => {
    test('paginación: recorre más de 1000 filas', async () => {
        const filas = Array.from({ length: 2500 }, (_, i) => ({ i }));
        const db = dbMock({ x: filas });
        const todo = await leerPaginado((d, h) => db.from('x').select('*').range(d, h));
        expect(todo.length).toBe(2500);
        expect(db.llamadas.length).toBe(3);
    });
    test('trocear', () => { expect(trocear([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]); });
    test('tabla opcional inexistente → null con motivo (no rompe)', async () => {
        const r2 = await leerOpcional(() => { throw new Error('relation does not exist'); });
        expect(r2).toEqual({ datos: null, motivo: 'relation does not exist' });
    });

    test('sin N+1: con 350 rodeos las consultas crecen por lotes de 100, no por rodeo', async () => {
        const rodeos = Array.from({ length: 350 }, (_, i) => ({ id: 'r' + i, fecha: '2026-05-01', estado: 'activo' }));
        const db = dbMock({
            temporadas: [{ id: 't1', nombre: '2026-2027', fecha_inicio: '2026-04-01', fecha_fin: '2027-03-31', activa: true }],
            rodeos, tipos_rodeo: [], categorias_rodeo: [], evaluaciones: [], usuarios_pagados: [], disponibilidad_usuarios: [],
            asociaciones: new Error('relation "asociaciones" does not exist'),
            asociacion_alias: new Error('does not exist'), historico_rodeos_temporada: new Error('does not exist'), historico_colleras_medicion: new Error('does not exist')
        });
        const ds = await cargarDataset({ hasta: '2026-09-20' }, db);
        expect(ds.rodeos.length).toBe(350);
        expect(db.llamadas.filter(n => n === 'evaluaciones').length).toBe(4);        // ceil(350/100)
        expect(db.llamadas.filter(n => n === 'asignaciones').length).toBe(4);
        expect(db.llamadas.length).toBeLessThan(40);                                  // ≈ constante, no ~350+
        expect(ds.fuentes.asociaciones).toMatchObject({ disponible: false });
        expect(ds.catalogoAsociaciones).toBeNull();
        expect(ds.historicoRodeos).toBeNull();
    });

    test('sin temporada que contenga la fecha → error claro', async () => {
        const db = dbMock({ temporadas: [] });
        await expect(cargarDataset({ hasta: '2030-01-01' }, db)).rejects.toThrow(/temporada/);
    });

    test('solo lectura: cualquier intento de escritura o rpc haría fallar la carga', async () => {
        const db = dbMock({ temporadas: [{ id: 't1', nombre: '2026-2027', fecha_inicio: '2026-04-01', fecha_fin: '2027-03-31' }] });
        await expect(cargarDataset({ hasta: '2026-09-20' }, db)).resolves.toBeDefined();
        expect(() => db.from('x').insert({})).toThrow(/escritura no permitida/);
    });
});

describe('comparación histórica de punta a punta (Excel → importador → informe)', () => {
    const XLSX = require('xlsx');
    const { previewHistoricoRodeos } = require('./importHistoricoRodeos');
    const serial = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000 + 25569;

    test('las filas históricas fuera de la ventana comparativa quedan almacenadas pero NO contaminan la comparación', () => {
        const fechas = ['2025-03-08', '2025-05-03', '2025-09-20', '2025-09-21', '2025-09-27', '2025-10-04', '2026-03-01', '2026-04-15'];
        const aoa = [['Club', 'Asociación', 'Temporada', 'Fecha Rodeo', 'Tipo Rodeo', 'CATEGORIA'],
            ...fechas.map((f, i) => ['CLUB' + i, 'ARAUCO', '2025-2026', serial(f), 'Libre', i % 2 ? 'PRIMERA' : 'SEGUNDA'])];
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Hoja1');
        const prev = previewHistoricoRodeos(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { ventana: { inicio: '2025-04-02', fin: '2026-04-01' } });
        expect(prev.resumen.importables).toBe(8);                     // todo se preserva tal como viene de la fuente
        expect(prev.resumen.fuera_de_temporada).toBe(2);              // 2025-03-08 y 2026-04-15

        const filas = prev.filas.filter(f => f.registro).map(f => ({ temporada: f.registro.temporada, fecha_rodeo: f.registro.fecha_rodeo, asociacion_id: null, asociacion_normalizada: f.registro.asociacion_normalizada, tipo_rodeo: f.registro.tipo_rodeo, categoria: f.registro.categoria }));
        const inf = generar(dataset({ historicoRodeos: filas }));
        const t = inf.historico_equivalente.temporadas[0];
        expect(t.ventana).toEqual({ k: 1, inicio: '2025-04-02', corte: '2025-09-21', fin: '2026-04-01' });
        expect(t.rodeos_a_fecha_equivalente).toBe(3);                 // 05-03, 09-20, 09-21 (no cuenta 2025-03-08)
        expect(t.rodeos_cierre_temporada).toBe(6);                    // hasta 2026-04-01 (no cuenta 2026-04-15)
        expect(t.rodeos_periodo_equivalente).toBe(2);                 // fin de semana equivalente 19–21/09
        expect(inf.proyecciones.rodeos.datos_base.comparables[0]).toMatchObject({ equivalente: 3, final: 6, avance_historico: 0.5 });
    });
});

describe('Fase 3B: series, universos de jurados, distribución de notas y extras de asociaciones', () => {
    const inf = generar(dataset({ snapshotsColleras: [{ fecha_snapshot: '2026-09-17T15:00:00Z', total_colleras: 30 }] }));

    test('series: cuatro series listas para Chart.js en la misma respuesta', () => {
        expect(Object.keys(inf.series)).toEqual(['rodeos_acumulados', 'colleras_acumuladas', 'situaciones_semanales', 'situaciones_por_bloque']);
        const rod = inf.series.rodeos_acumulados;
        expect(rod).toMatchObject({ temporada_actual: '2026-2027', temporada_referencia: '2025-2026', corte: '2026-09-20' });
        const pt = rod.puntos.find(p => p.fecha === '2026-09-20');
        expect(pt).toMatchObject({ actual: 5, fecha_historica: '2025-09-21', historico: 7 });   // coincide con comparacion.rodeos (5 vs 7)
        expect(inf.comparacion.rodeos.actual).toBe(pt.actual);
        expect(inf.comparacion.rodeos.historico).toBe(pt.historico);
    });

    test('colleras: puntos reales de la temporada actual (snapshot + en vivo) y ritmo con 2 mediciones', () => {
        const act = inf.series.colleras_acumuladas.temporadas.find(t => t.actual);
        expect(act.puntos.map(p => [p.fecha, p.valor, p.fuente])).toEqual([['2026-09-17', 30, 'snapshot'], ['2026-09-24', 35, 'en_vivo']]);
        expect(inf.colleras.ritmo_actual).toMatchObject({ disponible: true, por_semana: 5 });
        const hist = inf.series.colleras_acumuladas.temporadas.find(t => t.temporada === '2025-2026');
        expect(hist.puntos.map(p => p.valor)).toEqual([28, 340]);   // la medición NO confirmada no entra
    });

    test('sin snapshots y con una sola medición: ritmo no disponible con su motivo', () => {
        const x = generar();
        expect(x.colleras.ritmo_actual).toEqual({ disponible: false, mediciones_actuales: 1, motivo: 'Se requieren al menos 2 mediciones actuales' });
    });

    test('situaciones semanales presentes y sin representar "sin dato" como cero', () => {
        const s = inf.series.situaciones_semanales.puntos;
        expect(s.length).toBeGreaterThan(0);
        const semana = s.find(p => p.semana_inicio === '2026-09-14');
        expect(semana).toMatchObject({ rodeos_realizados: 3, evaluaciones_publicadas: 2 });
        expect(s.find(p => p.evaluaciones_publicadas === 0).rodeos_con_resultado_alterado).toBeNull();
    });

    test('distribución de notas por bandas (solo publicadas con nota_final)', () => {
        const d = inf.evaluaciones.acumulado_temporada.distribucion_notas;
        expect(d.n).toBe(3);
        expect(d.bandas.map(b => [b.banda, b.cantidad])).toEqual([['1,0–3,9', 0], ['4,0–4,9', 1], ['5,0–5,9', 1], ['6,0–7,0', 1]]);
    });

    test('universos de jurados: se documentan (no se fuerzan a coincidir)', () => {
        const u = inf.metadata.universos_jurados;
        expect(u.con_actuaciones).toMatchObject({ jurados_distintos: 1, filas_jurado_categoria: 1 });
        expect(u.activos_para_disponibilidad.jurados).toBe(1);
        expect(u.explicacion).toMatch(/universos distintos/);
        expect(inf.disponibilidad.universo.jurados_considerados).toBe(1);
        expect(inf.jurados.resumen).toMatchObject({ filas_jurado_categoria: 1, jurados_distintos_con_actuaciones: 1, jurados_en_mas_de_una_categoria: 0 });
    });

    test('61 vs 60: quien actuó en 2 categorías cuenta 2 filas; los que hoy no están activos se cuentan aparte', () => {
        const ds = dataset();
        ds.usuarios.push({ id: 'U2', nombre_completo: 'LUIS', categoria: 'C', activo: false, estado_usuario: 'receso', tipo_persona: 'jurado' }, { id: 'U3', nombre_completo: 'SIN ACT', categoria: 'C', activo: true, estado_usuario: 'activo', tipo_persona: 'jurado' });
        ds.asignaciones.push(
            { id: 'as3', rodeo_id: 'p3', usuario_pagado_id: 'U1', tipo_persona: 'jurado', categoria_aplicada: 'C', estado: 'activo', estado_designacion: 'aceptado' },
            { id: 'as4', rodeo_id: 'a1', usuario_pagado_id: 'U2', tipo_persona: 'jurado', categoria_aplicada: 'C', estado: 'activo', estado_designacion: 'aceptado' }
        );
        const x = generar(ds);
        expect(x.jurados.detalle.length).toBe(3);                                   // U1(B) + U1(C) + U2(C)
        expect(x.metadata.universos_jurados).toMatchObject({
            con_actuaciones: { jurados_distintos: 2, filas_jurado_categoria: 3, jurados_en_mas_de_una_categoria: 1 },
            activos_para_disponibilidad: { jurados: 2 },                            // U1 y U3 (U2 está en receso)
            con_actuaciones_no_activos: 1, activos_sin_actuaciones: 1
        });
        expect(x.jurados.detalle.find(d => d.usuario_id === 'U2')).toMatchObject({ activo_actualmente: false, estado_usuario: 'receso' });
    });

    test('asociaciones: listas y contadores para la pantalla (sin_rodeos, mayores caídas ordenadas, aumento)', () => {
        const a = inf.asociaciones;
        expect(a.sin_rodeos.map(x => x.asociacion)).toContain('CHILOE');
        expect(a.resumen).toHaveProperty('aumento_alertables');
        expect(a.resumen).toHaveProperty('similar_alertables');
        const v = a.mayores_caidas.map(x => x.variacion_pct);
        expect([...v].sort((p, q) => p - q)).toEqual(v);
        expect(a.mayores_caidas.every(x => x.alertable && x.estado === 'CAIDA_RELEVANTE')).toBe(true);
        expect(a.mayores_caidas).toEqual(a.menor_actividad.slice(0, 10));
        expect(a.menor_actividad.length).toBe(a.resumen.caida_relevante_alertables);
    });
});
