// Ronda final de interpretación: helpers de presentación (puros).
const IG = require('./informeGestionHelpers');

describe('numeración real de páginas', () => {
    test('textoPagina devuelve "Página N de 10" para cada página interior (2 a 10) y no repite el 1', () => {
        const textos = Array.from({ length: 9 }, (_, i) => IG.textoPagina(i + 2, 10));
        expect(textos).toEqual(['Página 2 de 10', 'Página 3 de 10', 'Página 4 de 10', 'Página 5 de 10', 'Página 6 de 10', 'Página 7 de 10', 'Página 8 de 10', 'Página 9 de 10', 'Página 10 de 10']);
        expect(new Set(textos).size).toBe(9);
    });
});

describe('temporadas explícitas (siempre desde los datos)', () => {
    test('toma la temporada actual y la de referencia del payload; nada escrito a mano', () => {
        const d = { metadata: { temporada: { nombre: '2031-2032' } }, comparacion: { referencia: { temporada: '2030-2031' } } };
        expect(IG.temporadasComparacion(d)).toEqual({ actual: '2031-2032', historica: '2030-2031', historicaEq: '2030-2031 (fecha equivalente)', hayHistorica: true });
    });
    test('sin referencia histórica: etiqueta neutra y hayHistorica=false', () => {
        const t = IG.temporadasComparacion({ metadata: { temporada: { nombre: '2026-2027' } }, comparacion: { referencia: null } });
        expect(t).toMatchObject({ actual: '2026-2027', historica: 'Temporada anterior', hayHistorica: false });
        expect(IG.temporadasComparacion(null).actual).toBe('Temporada actual');
    });
    test('textoRangoFechas: mismo mes, distinto mes, un día e inválido', () => {
        expect(IG.textoRangoFechas('2025-09-18', '2025-09-21')).toBe('18–21/09/2025');
        expect(IG.textoRangoFechas('2025-09-30', '2025-10-02')).toBe('30/09/2025–02/10/2025');
        expect(IG.textoRangoFechas('2025-09-18', '2025-09-18')).toBe('18/09/2025');
        expect(IG.textoRangoFechas(null, '2025-09-18')).toBe('—');
    });
});

describe('diferencia contra el histórico: lenguaje según el signo', () => {
    test('positiva: "X rodeos sobre el histórico equivalente"', () => {
        expect(IG.textoDiferencia(3)).toBe('3 rodeos sobre el histórico equivalente');
        expect(IG.textoDiferencia(1)).toBe('1 rodeo sobre el histórico equivalente');
    });
    test('negativa: "X rodeos bajo el histórico equivalente"', () => {
        expect(IG.textoDiferencia(-4)).toBe('4 rodeos bajo el histórico equivalente');
        expect(IG.textoDiferencia(-1)).toBe('1 rodeo bajo el histórico equivalente');
    });
    test('cero: "Igual al histórico equivalente"; NUNCA "adelantados" ni "atrasados"', () => {
        expect(IG.textoDiferencia(0)).toBe('Igual al histórico equivalente');
        for (const v of [-5, -1, 0, 1, 5]) expect(IG.textoDiferencia(v)).not.toMatch(/adelantad|atrasad/i);
    });
    test('otras unidades y sin dato', () => {
        expect(IG.textoDiferencia(7, { uno: 'collera', varios: 'colleras' })).toBe('7 colleras sobre el histórico equivalente');
        expect(IG.textoDiferencia(null)).toBe('');
        expect(IG.textoDiferencia(0, { referencia: 'histórico equivalente (2025-2026)' })).toBe('Igual al histórico equivalente (2025-2026)');
    });
});

describe('ranking de jurados: la muestra suficiente y la limitada son grupos separados', () => {
    const j = (jurado, nota, muestra, nivel) => ({ jurado, usuario_id: jurado, categoria: 'C', nota_promedio: nota, tamano_muestra: muestra, nivel_muestra: nivel });
    // Como lo entrega el motor: SUFICIENTE primero (ordenado por nota), luego LIMITADA
    const lista = [j('S1', 5.8, 5, 'SUFICIENTE'), j('S2', 5.7, 6, 'SUFICIENTE'), j('L1', 6.1, 3, 'LIMITADA'), j('L2', 5.9, 3, 'LIMITADA')];
    test('separa por nivel de muestra sin cambiar el orden interno de cada grupo', () => {
        const g = IG.agruparPorMuestra(lista);
        expect(g.suficiente.map(x => x.jurado)).toEqual(['S1', 'S2']);
        expect(g.limitada.map(x => x.jurado)).toEqual(['L1', 'L2']);
    });
    test('no duplica ni pierde personas; notas y promedios no cambian', () => {
        const g = IG.agruparPorMuestra(lista);
        const todos = [...g.suficiente, ...g.limitada];
        expect(todos).toHaveLength(lista.length);
        expect(new Set(todos.map(x => x.usuario_id)).size).toBe(lista.length);
        expect(todos.map(x => x.nota_promedio).sort()).toEqual(lista.map(x => x.nota_promedio).sort());
        expect(todos.find(x => x.jurado === 'L1').nota_promedio).toBe(6.1);
    });
    test('la numeración solo existe dentro del grupo suficiente; la limitada es otro nivel', () => {
        const g = IG.agruparPorMuestra(lista);
        expect(g.suficiente.map((_, i) => i + 1)).toEqual([1, 2]);
        expect(g.limitada.every(x => x.nivel_muestra === 'LIMITADA')).toBe(true);
        expect(g.suficiente.every(x => x.nivel_muestra === 'SUFICIENTE')).toBe(true);
    });
    test('sin suficientes: todo queda como referencia; listas vacías o nulas no fallan', () => {
        expect(IG.agruparPorMuestra([j('L1', 6, 3, 'LIMITADA')])).toEqual({ suficiente: [], limitada: [expect.objectContaining({ jurado: 'L1' })] });
        expect(IG.agruparPorMuestra(null)).toEqual({ suficiente: [], limitada: [] });
    });
});

describe('colleras: referencia histórica según temporadas comparables', () => {
    const t = (temporada, historico, estado = 'OK') => ({ temporada, estado, historico: estado === 'OK' ? historico : null });
    const SIN = 'SIN_DATO_HISTORICO_COMPARABLE';
    test('0 comparables: sin referencia (sin promedio ni máximo)', () => {
        const r = IG.referenciaHistoricaColleras({ temporadas: [t('2025-2026', null, SIN), t('2024-2025', null, SIN)] });
        expect(r).toMatchObject({ modo: 'SIN_REFERENCIA', comparables: 0, titulo: 'Sin referencia histórica comparable', valor: 'SIN DATOS' });
        expect(r.tituloMaximo).toBeUndefined();
        expect(IG.referenciaHistoricaColleras(null).modo).toBe('SIN_REFERENCIA');
    });
    test('1 comparable: "Referencia histórica disponible" con el dato y la temporada; NO promedio ni máximo', () => {
        const r = IG.referenciaHistoricaColleras({ promedio_historico: 28, maximo_historico: 28, temporadas: [t('2025-2026', 28), t('2024-2025', null, SIN), t('2023-2024', null, SIN)] });
        expect(r).toMatchObject({ modo: 'REFERENCIA_UNICA', comparables: 1, titulo: 'Referencia histórica disponible', valor: '28', subtexto: '1 temporada comparable · 2025-2026' });
        expect(JSON.stringify(r)).not.toMatch(/Promedio histórico|Máximo histórico|PROMEDIO|MÁXIMO/);
    });
    test('2 comparables: promedio y máximo sobre las temporadas con dato', () => {
        const r = IG.referenciaHistoricaColleras({ temporadas: [t('2025-2026', 28), t('2024-2025', 20), t('2023-2024', null, SIN)] });
        expect(r).toMatchObject({ modo: 'PROMEDIO_MAXIMO', comparables: 2, titulo: 'Promedio histórico', valor: '24', tituloMaximo: 'Máximo histórico', valorMaximo: '28' });
    });
    test('3 comparables; el sin dato no se toma como 0', () => {
        const r = IG.referenciaHistoricaColleras({ temporadas: [t('2025-2026', 28), t('2024-2025', 20), t('2023-2024', 12)] });
        expect(r).toMatchObject({ comparables: 3, valor: '20', valorMaximo: '28' });
        const conHueco = IG.referenciaHistoricaColleras({ temporadas: [t('2025-2026', 30), t('2024-2025', 20), t('2023-2024', null, SIN)] });
        expect(conHueco).toMatchObject({ comparables: 2, valor: '25' });   // (30+20)/2, no (30+20+0)/3
    });
});

describe('jurados en seguimiento: motivo concreto', () => {
    test('solo resultado alterado', () => expect(IG.motivoSeguimiento({ racha_rodeos_con_resultado_alterado: 3, racha_rodeos_con_falta_reglamentaria: 0 })).toBe('3 actuaciones consecutivas en rodeos con resultado alterado'));
    test('solo caso reglamentario', () => expect(IG.motivoSeguimiento({ racha_rodeos_con_resultado_alterado: 0, racha_rodeos_con_falta_reglamentaria: 2 })).toBe('2 actuaciones consecutivas en rodeos con caso reglamentario'));
    test('ambos', () => expect(IG.motivoSeguimiento({ racha_rodeos_con_resultado_alterado: 2, racha_rodeos_con_falta_reglamentaria: 3 })).toBe('Resultado alterado + caso reglamentario: 2 y 3 actuaciones consecutivas'));
    test('usa los motivos del motor cuando vienen; una racha de 1 no es motivo; sin evidencia no inventa texto', () => {
        expect(IG.motivoSeguimiento({ motivos: ['RESULTADO_ALTERADO'], racha_rodeos_con_resultado_alterado: 4, racha_rodeos_con_falta_reglamentaria: 1 })).toBe('4 actuaciones consecutivas en rodeos con resultado alterado');
        expect(IG.motivoSeguimiento({ racha_rodeos_con_resultado_alterado: 1, racha_rodeos_con_falta_reglamentaria: 1 })).toBeNull();
        expect(IG.motivoSeguimiento(null)).toBeNull();
    });
});

describe('resumen ejecutivo: cuerpo de jurados', () => {
    const d = { jurados: { resumen: { jurados_distintos_con_actuaciones: 58 }, por_categoria: { A: { cantidad_jurados: 5, nota_promedio: 5.51, actuaciones: 20 }, B: { cantidad_jurados: 18, nota_promedio: 5.51, actuaciones: 69 }, C: { cantidad_jurados: 37, nota_promedio: 5.33, actuaciones: 89 } } } };
    test('toma A/B/C y los jurados distintos de los datos (nada fijo)', () => {
        expect(IG.resumenCuerpoJurados(d)).toEqual({ categorias: [{ categoria: 'A', jurados: 5, promedio: 5.51, actuaciones: 20 }, { categoria: 'B', jurados: 18, promedio: 5.51, actuaciones: 69 }, { categoria: 'C', jurados: 37, promedio: 5.33, actuaciones: 89 }], distintos: 58 });
        const otro = JSON.parse(JSON.stringify(d)); otro.jurados.por_categoria.A.cantidad_jurados = 9; otro.jurados.resumen.jurados_distintos_con_actuaciones = 61;
        expect(IG.resumenCuerpoJurados(otro).categorias[0].jurados).toBe(9);
        expect(IG.resumenCuerpoJurados(otro).distintos).toBe(61);
    });
    test('sin datos: null, no 0 ni undefined', () => {
        const r = IG.resumenCuerpoJurados({});
        expect(r.distintos).toBeNull();
        expect(r.categorias.every(c => c.jurados === null && c.promedio === null)).toBe(true);
    });
});

describe('bloques de rodeo: datasets y lectura', () => {
    const bloque = (over = {}) => ({ etiqueta: '18–20 SEP', rodeos_realizados: 26, evaluaciones_existentes: 20, evaluaciones_publicadas: 10, cobertura_publicadas: 0.385, rodeos_con_falta_reglamentaria: 8, denominador_faltas: 20, porcentaje_faltas: 40, interpretable_faltas: true, rodeos_con_resultado_alterado: 4, denominador_alterados: 10, porcentaje_alterados: 40, interpretable_alterados: false, ...over });
    test('datasetsBloques: barra = total; faltas y alterados son series independientes (no apiladas)', () => {
        const ds = IG.datasetsBloques({ puntos: [bloque(), bloque({ etiqueta: '25–26 SEP', rodeos_realizados: 5, rodeos_con_falta_reglamentaria: null, interpretable_faltas: false, rodeos_con_resultado_alterado: null, denominador_alterados: 0 })] });
        expect(ds.labels).toEqual(['18–20 SEP', '25–26 SEP']);
        expect(ds.totales).toEqual([26, 5]);
        expect(ds.faltas).toEqual([8, null]);
        expect(ds.alterados).toEqual([4, null]);          // sin publicadas → null (SIN DATOS), nunca 0
        expect(ds.alteradosInterpretables).toEqual([false, false]);
        expect(ds.faltasInterpretables).toEqual([true, false]);
    });
    test('lecturaBloque: ejemplo completo con denominadores explícitos', () => {
        const l = IG.lecturaBloque(bloque());
        expect(l.total).toBe('26 rodeos realizados');
        expect(l.faltas).toBe('Falta reglamentaria: 8 de 20 rodeos con evaluación (40,0 %)');
        expect(l.cobertura).toBe('Cobertura de publicadas: 10 / 26 (38,5 %)');
        expect(l.alterados).toBe('Resultados alterados: 4 / 10 evaluaciones publicadas (40,0 %)');
    });
    test('lecturaBloque sin evaluaciones publicadas: SIN DATOS y publicadas 0 / total; nunca "0 %" en alterados', () => {
        const l = IG.lecturaBloque(bloque({ evaluaciones_publicadas: 0, cobertura_publicadas: 0, rodeos_con_resultado_alterado: null, denominador_alterados: 0, porcentaje_alterados: null }));
        expect(l.alterados).toBe('Resultados alterados: SIN DATOS (publicadas 0 / 26)');
        expect(l.alterados).not.toMatch(/0 %/);
    });
    test('lecturaBloque sin evaluaciones: la falta reglamentaria también es SIN DATOS', () => {
        expect(IG.lecturaBloque(bloque({ denominador_faltas: 0, rodeos_con_falta_reglamentaria: null })).faltas).toBe('Falta reglamentaria: SIN DATOS (0 evaluaciones)');
        expect(IG.lecturaBloque(null)).toBeNull();
    });
    test('datasetsColleras conserva la antigüedad (k) para colorear sin depender del nombre de la temporada', () => {
        const ds = IG.datasetsColleras({ temporadas: [{ temporada: '2099-2100', k: 1, actual: false, puntos: [{ x_dias: 1, valor: 2, fecha: '2099-01-01', fuente: 'historico' }] }] });
        expect(ds[0].k).toBe(1);
    });
});

// Guardas estáticas sobre la pantalla (no hay DOM en Jest): nada de temporadas escritas a mano ni numeración por contador CSS.
describe('pantalla: guardas estáticas', () => {
    const fs = require('fs'), path = require('path');
    const src = fs.readFileSync(path.join(__dirname, 'informeGestionPantalla.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'informe-gestion.html'), 'utf8');
    test('no hay temporadas escritas a mano (YYYY-YYYY) en la pantalla', () => {
        expect(src.match(/\b20\d\d-20\d\d\b/g)).toBeNull();
    });
    test('las columnas de comparación ya no dicen "Actual" / "Hist. eq." / "Histórico" a secas', () => {
        expect(src).not.toMatch(/<th class="n">(Actual|Hist\. eq\.|Histórico)<\/th>/);
    });
    test('la numeración de páginas sale del helper (texto), sin "de 10" fijo ni contador CSS', () => {
        expect(src).toMatch(/H\.textoPagina\(NUM_PAGINA, TOTAL_PAGINAS\)/);
        expect(src).not.toMatch(/de 10<\/span>/);
        expect(html).not.toMatch(/counter-increment|counter\(pagina\)/);
    });
    test('no usa "adelantados/atrasados" ni abreviaturas de disponibilidad', () => {
        expect(src).not.toMatch(/adelantados|atrasados/);
        expect(src).not.toMatch(/FdS disp\.|>Desig\.<|>Utiliz\.</);
    });
    test('el resumen incluye la franja de cuerpo de jurados con la aclaración de la nota', () => {
        expect(src).toMatch(/Cuerpo de jurados — actuaciones de temporada/);
        expect(src).toMatch(/Promedio = Nota Evaluación de Casos de las actuaciones/);
    });
    test('seguimiento: criterio de inclusión, motivo y últimas notas visibles', () => {
        expect(src).toMatch(/Criterio de inclusión:/);
        expect(src).toMatch(/Motivo de seguimiento/);
        expect(src).toMatch(/Últimas notas/);
        expect(src).toMatch(/no atribuye individualmente la causa al jurado/);
    });
    test('el gráfico de situaciones usa bloques de rodeo con leyenda explícita (sin barras apiladas)', () => {
        expect(src).toMatch(/situaciones_por_bloque/);
        expect(src).toMatch(/total de rodeos realizados del bloque/);
        expect(src).not.toMatch(/stacked:\s*true/);
    });
});
