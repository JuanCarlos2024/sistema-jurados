const A = require('./agregados');

const CAT_TIPO = { T_SEG: 'Segunda', T_PRI: 'Primera', T_ESP: 'Especial' };
const rodeo = (id, fecha, extra = {}) => ({ id, fecha, club: 'CLUB ' + id, asociacion: 'ASOC ' + id, tipo_rodeo_id: 'T_SEG', tipo_rodeo_nombre: 'Provincial', categoria_rodeo_nombre: null, estado: 'activo', ...extra });
const ev = (id, rodeo_id, estado, extra = {}) => ({ id, rodeo_id, estado, nota_final: null, resultados_alterados: false, anulada: false, ...extra });

describe('categoría efectiva', () => {
    test('usa rodeos.categoria_rodeo_nombre cuando existe', () => {
        expect(A.categoriaEfectiva(rodeo('a', '2026-09-01', { categoria_rodeo_nombre: 'Primera' }), CAT_TIPO)).toEqual({ nombre: 'Primera', origen: 'rodeo' });
    });
    test('si es NULL o vacía, la deriva de tipos_rodeo.categoria_rodeo_id → categorias_rodeo (sin UPDATE)', () => {
        expect(A.categoriaEfectiva(rodeo('a', '2026-09-01'), CAT_TIPO)).toEqual({ nombre: 'Segunda', origen: 'tipo' });
        expect(A.categoriaEfectiva(rodeo('a', '2026-09-01', { categoria_rodeo_nombre: '  ', tipo_rodeo_id: 'T_PRI' }), CAT_TIPO)).toEqual({ nombre: 'Primera', origen: 'tipo' });
    });
    test('sin categoría propia ni derivable → "Sin categoría"', () => {
        expect(A.categoriaEfectiva(rodeo('a', '2026-09-01', { tipo_rodeo_id: 'T_X' }), CAT_TIPO)).toEqual({ nombre: 'Sin categoría', origen: null });
        expect(A.categoriaEfectiva(rodeo('a', '2026-09-01', { tipo_rodeo_id: null }), CAT_TIPO).nombre).toBe('Sin categoría');
    });
    test('donde ambas fuentes existen y coinciden, el resultado es el mismo', () => {
        const r = rodeo('a', '2026-09-01', { categoria_rodeo_nombre: 'Segunda', tipo_rodeo_id: 'T_SEG' });
        expect(A.categoriaEfectiva(r, CAT_TIPO).nombre).toBe(A.categoriaEfectiva({ ...r, categoria_rodeo_nombre: null }, CAT_TIPO).nombre);
    });
});

describe('rodeos realizados / programados / anulados', () => {
    const rodeos = [
        rodeo('r1', '2026-09-18'), rodeo('r2', '2026-09-19', { tipo_rodeo_id: 'T_PRI' }),
        rodeo('r3', '2026-09-19', { estado: 'anulado' }), rodeo('r4', '2026-09-26'), rodeo('r5', '2026-04-10')
    ];
    test('activo y fecha <= corte = realizado; posterior = programado; anulado excluido', () => {
        const s = A.seleccionarRodeos(rodeos, { desde: '2026-04-01', hasta: '2026-09-20', finVentana: '2027-03-31' });
        expect(s.realizados.map(r => r.id)).toEqual(['r1', 'r2', 'r5']);
        expect(s.programados.map(r => r.id)).toEqual(['r4']);
        expect(s.anulados.map(r => r.id)).toEqual(['r3']);
    });
    test('un rodeo futuro NUNCA aparece como realizado', () => {
        const s = A.seleccionarRodeos(rodeos, { desde: '2026-04-01', hasta: '2026-09-25', finVentana: '2027-03-31' });
        expect(s.realizados.map(r => r.id)).not.toContain('r4');
    });
    test('resumen: total = realizados + programados; anulados no cuentan; categorías derivadas', () => {
        const s = A.seleccionarRodeos(rodeos, { desde: '2026-04-01', hasta: '2026-09-20', finVentana: '2027-03-31' });
        const r = A.resumenRodeos(s, CAT_TIPO);
        expect(r).toMatchObject({ total: 4, realizados: 3, programados: 1, anulados_excluidos: 1, categoria_derivada_del_tipo: 3 });
        expect(r.por_categoria.find(c => c.clave === 'Segunda').cantidad).toBe(2);
        expect(r.por_categoria.find(c => c.clave === 'Primera').porcentaje).toBeCloseTo(33.3, 1);
    });
    test('período con solo fin de semana: 18–20/09', () => {
        const s = A.seleccionarRodeos(rodeos, { desde: '2026-09-18', hasta: '2026-09-20', finVentana: '2027-03-31' });
        expect(s.realizados.map(r => r.id)).toEqual(['r1', 'r2']);
    });
});

describe('evaluaciones: borrador / en proceso / publicado', () => {
    const rodeos = ['r1', 'r2', 'r3', 'r4'].map((id, i) => rodeo(id, `2026-09-0${i + 1}`));
    const evs = A.indexarEvaluaciones([
        ev('e1', 'r1', 'publicado', { nota_final: '6.00', resultados_alterados: true }),
        ev('e2', 'r2', 'borrador', { nota_final: 3, resultados_alterados: true }),
        ev('e3', 'r3', 'en_proceso'),
        ev('e0', 'r4', 'publicado', { nota_final: 1, anulada: true })
    ]);
    test('solo las PUBLICADAS cuentan para nota y cobertura; borrador/proceso no; anuladas ignoradas', () => {
        const r = A.agregarEvaluacion(rodeos, evs);
        expect(r).toMatchObject({ rodeos_realizados: 4, evaluaciones_existentes: 3, evaluaciones_publicadas: 1, cobertura_evaluacion: 0.25, nota_promedio_publicada: 6, publicadas_con_nota: 1 });
    });
    test('la nota de un borrador jamás entra al promedio', () => {
        expect(A.agregarEvaluacion(rodeos, evs).nota_promedio_publicada).toBe(6);
    });
});

describe('resultados alterados: numerador / denominador', () => {
    const rodeos = ['r1', 'r2', 'r3', 'r4'].map((id, i) => rodeo(id, `2026-09-0${i + 1}`));
    test('solo publicadas; borrador con alterado=true no cuenta; NULL no se toma como NO', () => {
        const evs = A.indexarEvaluaciones([
            ev('e1', 'r1', 'publicado', { resultados_alterados: true }),
            ev('e2', 'r2', 'publicado', { resultados_alterados: false }),
            ev('e3', 'r3', 'publicado', { resultados_alterados: null }),
            ev('e4', 'r4', 'borrador', { resultados_alterados: true })
        ]);
        expect(A.agregarAlterados(rodeos, evs)).toMatchObject({ cantidad: 1, denominador: 2, porcentaje: 50, publicadas_sin_dato: 1 });
    });
    test('sin publicadas: porcentaje null (no 0 %)', () => {
        expect(A.agregarAlterados(rodeos, A.indexarEvaluaciones([ev('e4', 'r4', 'borrador')]))).toMatchObject({ cantidad: 0, denominador: 0, porcentaje: null });
    });
});

describe('faltas: casos vs rodeos afectados; los anulados no inflan', () => {
    const rodeos = [rodeo('r1', '2026-09-01'), rodeo('r2', '2026-09-02'), rodeo('r3', '2026-09-03'), rodeo('r4', '2026-09-04')];
    const evs = A.indexarEvaluaciones([ev('e1', 'r1', 'publicado'), ev('e2', 'r2', 'publicado'), ev('e3', 'r3', 'borrador')]);   // r4 sin evaluación
    const casos = A.indexarPorClave([
        { evaluacion_id: 'e1', tipo_caso: 'reglamentaria', anulado: false },
        { evaluacion_id: 'e1', tipo_caso: 'reglamentaria', anulado: false },
        { evaluacion_id: 'e1', tipo_caso: 'reglamentaria', anulado: false },
        { evaluacion_id: 'e1', tipo_caso: 'reglamentaria', anulado: true },
        { evaluacion_id: 'e1', tipo_caso: 'informativo', anulado: true },
        { evaluacion_id: 'e2', tipo_caso: 'reglamentaria', anulado: false },
        { evaluacion_id: 'e2', tipo_caso: 'interpretativa', anulado: false },
        { evaluacion_id: 'e3', tipo_caso: 'interpretativa', anulado: true }
    ], 'evaluacion_id');

    test('un rodeo con 3 casos reglamentarios cuenta 3 casos pero 1 rodeo con falta reglamentaria', () => {
        const f = A.agregarFaltas(rodeos, evs, casos);
        expect(f.reglamentarias).toEqual({ casos_total: 4, rodeos_con_falta: 2, porcentaje_rodeos_evaluados: 66.7 });   // e1 (3) + e2 (1); 3 rodeos evaluados
        expect(f.apreciacion).toEqual({ casos_total: 1, rodeos_con_falta: 1, porcentaje_rodeos_evaluados: 33.3 });
    });
    test('los casos anulados no cuentan (ni casos ni rodeos) y se informan aparte', () => {
        const f = A.agregarFaltas(rodeos, evs, casos);
        expect(f.casos_anulados_excluidos).toBe(3);
        expect(f.informativos).toMatchObject({ casos_total: 0, rodeos_con_caso: 0 });
        expect(f).toMatchObject({ total_casos: 5, rodeos_con_algun_caso: 2, rodeos_con_evaluacion: 3 });
    });
    test('un rodeo cuyo único caso está anulado no cuenta como rodeo con falta', () => {
        const f = A.agregarFaltas([rodeos[2]], evs, casos);
        expect(f.apreciacion).toMatchObject({ casos_total: 0, rodeos_con_falta: 0 });
    });
    test('sin evaluaciones: porcentajes null (no 0 %)', () => {
        expect(A.agregarFaltas([rodeos[3]], evs, casos).reglamentarias).toEqual({ casos_total: 0, rodeos_con_falta: 0, porcentaje_rodeos_evaluados: null });
    });
    test('disciplinarias salen de la cartilla (rodeos con falta declarada / cartillas con dato) y no se confunden con los casos', () => {
        const f = A.agregarFaltas(rodeos, evs, casos, { cantidad_si: 2, denominador_cartillas_con_dato: 5 });
        expect(f.disciplinarias).toMatchObject({ rodeos_con_falta: 2, denominador_cartillas: 5, porcentaje: 40 });
        expect(A.agregarFaltas(rodeos, evs, casos).disciplinarias).toMatchObject({ rodeos_con_falta: 0, denominador_cartillas: 0, porcentaje: null });
    });
});

describe('cartillas: ganado, caseta y cobertura', () => {
    const rodeos = ['r1', 'r2', 'r3', 'r4'].map((id, i) => rodeo(id, `2026-09-0${i + 1}`));
    const cart = A.indexarPorClave([
        { rodeo_id: 'r1', estado: 'enviada', datos: { hubo_ganado_fuera_peso: 'si', caseta_adecuada: 'no', hubo_faltas: 'no' } },
        { rodeo_id: 'r2', estado: 'enviada', datos: { hubo_ganado_fuera_peso: 'no', caseta_adecuada: 'si', hubo_faltas: 'si' } },
        { rodeo_id: 'r3', estado: 'borrador', datos: { hubo_ganado_fuera_peso: 'si' } },
        { rodeo_id: 'r4', estado: 'enviada', datos: {} }
    ], 'rodeo_id');
    test('cuenta solo cartillas enviadas; borrador y datos vacíos no cuentan como "no"', () => {
        const r = A.agregarCartillas(rodeos, cart);
        expect(r.cartillas).toMatchObject({ rodeos_realizados: 4, cartillas_jurado_recibidas: 3, cobertura_cartillas: 0.75 });
        expect(r.ganado).toMatchObject({ cantidad_si: 1, denominador_cartillas_con_dato: 2, porcentaje: 50 });
        expect(r.caseta).toMatchObject({ cumple: 1, no_cumple: 1, sin_dato: 2, denominador: 2 });
        expect(r.faltas_declaradas_cartilla).toMatchObject({ cantidad_si: 1, denominador_cartillas_con_dato: 2 });
    });
    test('con varias cartillas en un rodeo: "si" si alguna lo declara; caseta "no" si alguna marca No', () => {
        const x = A.resumenCartillasRodeo([
            { estado: 'enviada', datos: { hubo_ganado_fuera_peso: 'no', caseta_adecuada: 'si' } },
            { estado: 'enviada', datos: { hubo_ganado_fuera_peso: 'si', caseta_adecuada: 'no' } }
        ]);
        expect(x).toMatchObject({ recibida: true, ganado: 'si', caseta: 'no' });
    });
});

describe('cobertura de datos', () => {
    test('baja cobertura marca interpretable=false y advierte que un 0 no es ausencia real', () => {
        const c = A.construirCobertura({
            evaluacion: { evaluaciones_publicadas: 2, evaluaciones_existentes: 4, rodeos_realizados: 10 },
            cartillas: { cartillas_jurado_recibidas: 9, rodeos_realizados: 10 },
            notasSec: { rodeos_elegibles: 2, nota_comision: { n: 0 }, nota_delegado: { n: 2 } }
        });
        expect(c.evaluaciones_publicadas).toMatchObject({ numerador: 2, denominador: 10, cobertura: 0.2, interpretable: false });
        expect(c.cartillas_jurado.interpretable).toBe(true);
        expect(c.nota_comision).toMatchObject({ numerador: 0, denominador: 2, interpretable: false });
        expect(c.indicadores_sujetos_a_cobertura.resultados_alterados.interpretable).toBe(false);
        expect(c.advertencias.join(' ')).toMatch(/evaluaciones publicadas/);
    });
    test('sin rodeos: cobertura null (no se advierte ni se interpreta)', () => {
        const b = A.bloqueCobertura(0, 0);
        expect(b).toMatchObject({ cobertura: null, interpretable: false });
    });
});

describe('TOP / BOTTOM de rodeos', () => {
    const rodeos = Array.from({ length: 8 }, (_, i) => rodeo('r' + i, `2026-09-0${i + 1}`, { tipo_rodeo_id: 'T_PRI' }));
    const evs = A.indexarEvaluaciones([
        ...rodeos.slice(0, 7).map((r, i) => ev('e' + i, r.id, 'publicado', { nota_final: 4 + i * 0.3 })),
        ev('e7', 'r7', 'borrador', { nota_final: 7 })
    ]);
    const ctx = { evalPorRodeo: evs, notasSecPorRodeo: { r6: { nota_comision: 5.5, nota_delegado: 6 } }, categoriaPorTipoId: CAT_TIPO, juradosPorRodeo: { r6: ['ANA'] } };
    test('solo publicadas con nota; 5 mejores y 5 peores; sin promedio inventado; incluye N elegibles', () => {
        const t = A.topBottomRodeos(rodeos, ctx);
        expect(t.n_elegibles).toBe(7);
        expect(t.top.map(x => x.rodeo_id)).toEqual(['r6', 'r5', 'r4', 'r3', 'r2']);
        expect(t.bottom.map(x => x.rodeo_id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
        expect(t.top[0]).toMatchObject({ nota_final: 5.8, nota_comision: 5.5, nota_delegado: 6, jurados: ['ANA'], categoria: 'Primera' });
        expect(t.top.every(x => x.rodeo_id !== 'r7')).toBe(true); // el borrador nunca entra
        expect(t.solapamiento).toBe(true);
    });
    test('nota_comision / nota_delegado faltantes quedan null (no se inventan)', () => {
        expect(A.topBottomRodeos(rodeos, ctx).top[1]).toMatchObject({ nota_comision: null, nota_delegado: null });
    });
});

describe('distribución de notas por bandas', () => {
    const rodeos = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => rodeo(id, '2026-09-0' + (i + 1)));
    const notas = [3.9, 4.0, 4.99, 5.0, 6.0, 7.0];
    const evs = A.indexarEvaluaciones([
        ...notas.map((n, i) => ev('e' + i, rodeos[i].id, 'publicado', { nota_final: n })),
        ev('eb', 'g', 'borrador', { nota_final: 6.5 })
    ]);
    test('bordes: 3,9 | 4,0 y 4,99 | 5,0 | 6,0 y 7,0; el borrador no entra', () => {
        const d = A.distribucionNotas(rodeos, evs);
        expect(d.n).toBe(6);
        expect(d.bandas.map(b => b.cantidad)).toEqual([1, 2, 1, 2]);
        expect(d.bandas.map(b => b.banda)).toEqual(['1,0–3,9', '4,0–4,9', '5,0–5,9', '6,0–7,0']);
        expect(d.bandas[3].porcentaje).toBeCloseTo(33.3, 1);
    });
    test('sin notas: n=0 y porcentajes null (no 0 %)', () => {
        const d = A.distribucionNotas(rodeos, {});
        expect(d.n).toBe(0);
        expect(d.bandas.every(b => b.cantidad === 0 && b.porcentaje === null)).toBe(true);
    });
});
