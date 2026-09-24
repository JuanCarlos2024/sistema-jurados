const IG = require('./informeGestionHelpers');

describe('formatos (es-CL)', () => {
    test('porcentaje con coma; sin dato nunca es "0 %"', () => {
        expect(IG.fmtPct(45.5)).toBe('45,5 %');
        expect(IG.fmtPct(0)).toBe('0,0 %');
        expect(IG.fmtPct(null)).toBe('SIN DATOS');
        expect(IG.fmtPct(undefined)).toBe('SIN DATOS');
        expect(IG.fmtPct(NaN)).toBe('SIN DATOS');
    });
    test('notas, enteros, diferencias y variaciones', () => {
        expect(IG.fmtNota(5.48)).toBe('5,5');
        expect(IG.fmtNota(null)).toBe('—');
        expect(IG.fmtEntero(1234)).toMatch(/1.234|1234/);
        expect(IG.fmtDif(3)).toBe('+3');
        expect(IG.fmtDif(-2)).toBe('-2');
        expect(IG.fmtPctSigno(1.7)).toBe('+1,7 %');
        expect(IG.fmtPctSigno(null)).toBe('—');
    });
    test('fechas', () => {
        expect(IG.fmtFecha('2026-09-24')).toBe('24/09/2026');
        expect(IG.fmtFechaCorta('2026-09-24')).toBe('24/09');
        expect(IG.fmtFecha(null)).toBe('—');
    });
    test('esc evita inyección de HTML en nombres', () => {
        expect(IG.esc('<img src=x onerror=alert(1)>')).not.toContain('<');
        expect(IG.esc('A & "B"')).toBe('A &amp; &quot;B&quot;');
    });
});

describe('cobertura: regla visual', () => {
    test('81 / 178 = 45,5 % con interpretable=false → COBERTURA INSUFICIENTE (gris, sin color de conclusión)', () => {
        const b = { numerador: 81, denominador: 178, porcentaje: 45.5, interpretable: false };
        expect(IG.estadoCobertura(b)).toEqual({ estado: 'INSUFICIENTE', etiqueta: 'COBERTURA INSUFICIENTE', clase: 'gris' });
        expect(IG.textoNSobreTotal(b.numerador, b.denominador)).toBe('81 / 178');
    });
    test('denominador 0 → SIN DATOS (nunca 0 %)', () => {
        expect(IG.estadoCobertura({ numerador: 0, denominador: 0, porcentaje: null, interpretable: false })).toMatchObject({ estado: 'SIN_DATOS', etiqueta: 'SIN DATOS' });
        expect(IG.estadoCobertura(null).estado).toBe('SIN_DATOS');
        expect(IG.textoIndicador(0, 0, null)).toEqual({ fraccion: 'SIN DATOS', pct: 'SIN DATOS' });
    });
    test('cobertura suficiente no lleva advertencia', () => {
        expect(IG.estadoCobertura({ numerador: 151, denominador: 178, porcentaje: 84.8, interpretable: true })).toEqual({ estado: 'OK', etiqueta: '', clase: '' });
    });
    test('un indicador sin interpretable definido pero con denominador se muestra normal', () => {
        expect(IG.estadoCobertura({ numerador: 1, denominador: 2 }).estado).toBe('OK');
    });
    test('textoIndicador: X / N y porcentaje', () => {
        expect(IG.textoIndicador(40, 81, 49.4)).toEqual({ fraccion: '40 / 81', pct: '49,4 %' });
    });
});

describe('variación: flecha + color con significado consistente', () => {
    test('↑ verde, ↓ amarillo (atención, no rojo), = azul, sin dato gris', () => {
        expect([1.7, -5, 0, null].map(v => [IG.flechaVariacion(v), IG.claseVariacion(v)])).toEqual([['↑', 'verde'], ['↓', 'amarillo'], ['=', 'azul'], ['·', 'gris']]);
    });
    test('el rojo nunca sale de una variación simple', () => {
        [-90, -15, -1].forEach(v => expect(IG.claseVariacion(v)).not.toBe('rojo'));
    });
});

describe('agruparTiposOtros', () => {
    const tipos = Array.from({ length: 11 }, (_, i) => ({ clave: 'T' + i, actual: 20 - i, historico: 10 }));
    test('máximo 8 tipos + OTROS con la suma del resto', () => {
        const r = IG.agruparTiposOtros(tipos, 8);
        expect(r.length).toBe(9);
        expect(r[8]).toMatchObject({ clave: 'OTROS', agrupado: 3 });
        expect(r[8].actual).toBe(12 + 11 + 10);   // T8+T9+T10
        expect(r[8].historico).toBe(30);
    });
    test('con 8 o menos no agrega OTROS; el histórico ausente cuenta como 0 solo en la suma de OTROS', () => {
        expect(IG.agruparTiposOtros(tipos.slice(0, 8), 8).length).toBe(8);
        const r = IG.agruparTiposOtros([...tipos.slice(0, 8), { clave: 'X', actual: 1, historico: null }], 8);
        expect(r[8]).toMatchObject({ clave: 'OTROS', actual: 1, historico: 0 });
    });
});

describe('señales y lenguaje', () => {
    test('niveles INFO/ATENCIÓN/PRIORIDAD con clases; máximo 6', () => {
        expect(IG.nivelSenal('ATENCION')).toEqual({ etiqueta: 'ATENCIÓN', clase: 'amarillo' });
        expect(IG.nivelSenal('PRIORIDAD').clase).toBe('rojo');
        expect(IG.senalesParaPantalla(Array.from({ length: 9 }, (_, i) => ({ codigo: 'X' + i }))).length).toBe(6);
    });
    test('JURADO_REINCIDENCIA se presenta como SEÑAL DE SEGUIMIENTO (nunca reincidencia)', () => {
        expect(IG.etiquetaTipoSenal('JURADO_REINCIDENCIA')).toBe('SEÑAL DE SEGUIMIENTO');
        expect(IG.etiquetaTipoSenal('COLLERAS_SOBRE_HISTORICO')).toBeNull();
    });
    test('participación en rodeos con resultado alterado: nunca "alteró"', () => {
        const t = IG.textoParticipacionAlterados({ rodeos_con_resultado_alterado_en_que_participo: 2, denominador_rodeos_publicados: 8, porcentaje_rodeos_con_resultado_alterado_en_que_participo: 25 });
        expect(t).toBe('Rodeos evaluados: 8 · Participó en 2 rodeo(s) con resultado alterado (2 / 8 = 25 %)');
        expect(t.toLowerCase()).not.toMatch(/alter[óo] |alteraciones del jurado/);
        expect(IG.textoParticipacionAlterados({ denominador_rodeos_publicados: 0 })).toMatch(/SIN DATOS/);
        expect(IG.AVISO_ALTERADOS).toMatch(/no atribuye individualmente/);
    });
    test('etiquetas de muestra', () => {
        expect(IG.etiquetaMuestra('INSUFICIENTE')).toBe('Muestra insuficiente');
        expect(IG.etiquetaMuestra('SUFICIENTE')).toBe('Muestra suficiente');
    });
});

describe('valor de señales y promedios', () => {
    test('las señales de cobertura se muestran como porcentaje; enteros y decimales sin ruido', () => {
        expect(IG.valorSenal({ codigo: 'BAJA_COBERTURA_EVALUACIONES', valor_actual: 0.455 })).toBe('45,5 %');
        expect(IG.valorSenal({ codigo: 'CAIDA_ACTIVIDAD_ASOCIACION', valor_actual: 15 })).toBe('15');
        expect(IG.valorSenal({ codigo: 'AUMENTO_RESULTADOS_ALTERADOS', valor_actual: 50.5 })).toBe('50,50');
        expect(IG.valorSenal({ codigo: 'X', valor_actual: null })).toBe('—');
        expect(IG.fmtPromedio(28)).toBe('28');
        expect(IG.fmtPromedio(28.5)).toBe('28,5');
        expect(IG.fmtPromedio(null)).toBe('—');
    });
});

describe('proyección: nunca un 0 ni un número forzado', () => {
    test('PROYECCION_NO_DISPONIBLE → "Sin proyección aún" con el motivo en lenguaje claro', () => {
        expect(IG.estadoProyeccion({ estado: 'PROYECCION_NO_DISPONIBLE', motivo: 'SIN_TEMPORADA_COMPARABLE_CON_AVANCE_SUFICIENTE' }))
            .toEqual({ disponible: false, texto: 'Sin proyección aún', motivo: 'Avance histórico insuficiente' });
        expect(IG.estadoProyeccion(null).texto).toBe('Sin proyección aún');
        expect(IG.motivoProyeccion('SIN_HISTORICO')).toBe('Sin dato histórico comparable');
    });
    test('disponible y REFERENCIAL se rotula "PROYECCIÓN REFERENCIAL"', () => {
        expect(IG.estadoProyeccion({ estado: 'PROYECCION_DISPONIBLE', estimacion: 683, confianza: 'REFERENCIAL' })).toMatchObject({ disponible: true, texto: '683', etiqueta: 'PROYECCIÓN REFERENCIAL' });
        expect(IG.estadoProyeccion({ estado: 'PROYECCION_DISPONIBLE', estimacion: 451, confianza: 'MAYOR_BASE_HISTORICA' }).etiqueta).toMatch(/MAYOR BASE HISTORICA/);
    });
});

describe('datasets de gráficos: null se preserva y no se interpola', () => {
    test('rodeos acumulados: actual se corta en el corte (null), sin ceros inventados', () => {
        const d = IG.datasetsRodeosAcumulados({ temporada_referencia: '2025-2026', puntos: [
            { etiqueta: '13/09', actual: 150, historico: 140, calendario_cargado: null },
            { etiqueta: '20/09', actual: 178, historico: 175, calendario_cargado: null },
            { etiqueta: '27/09', actual: null, historico: 190, calendario_cargado: 195 }
        ] });
        expect(d.actual).toEqual([150, 178, null]);
        expect(d.calendario).toEqual([null, null, 195]);
        expect(d.historico).toEqual([140, 175, 190]);
        expect(d.labels).toEqual(['13/09', '20/09', '27/09']);
    });
    test('colleras: puntos reales por temporada con x = días; sin valores nulos', () => {
        const ds = IG.datasetsColleras({ temporadas: [
            { temporada: '2025-2026', actual: false, puntos: [{ x_dias: 180, valor: 28, fecha: '2025-09-28' }, { x_dias: 190, valor: null }] },
            { temporada: '2026-2027', actual: true, puntos: [] }
        ] });
        expect(ds[0].puntos).toEqual([{ x: 180, y: 28, fecha: '2025-09-28', fuente: undefined }]);
        expect(ds[1]).toMatchObject({ actual: true, puntos: [] });
    });
    test('situaciones semanales: semana sin publicadas = null (no 0) y bandera de interpretabilidad', () => {
        const d = IG.datasetsSituaciones({ puntos: [
            { etiqueta: '07/09', evaluaciones_publicadas: 2, rodeos_realizados: 2, rodeos_con_falta_reglamentaria: 1, rodeos_con_resultado_alterado: 1, interpretable_alterados: true },
            { etiqueta: '14/09', evaluaciones_publicadas: 0, rodeos_realizados: 25, rodeos_con_falta_reglamentaria: 8, rodeos_con_resultado_alterado: null, interpretable_alterados: false }
        ] });
        expect(d.alterados).toEqual([1, null]);
        expect(d.reglamentarias).toEqual([1, 8]);
        expect(d.alteradosInterpretables).toEqual([true, false]);
        expect(d.labels[1]).toEqual(['14/09', '0/25 pub.']);
    });
    test('entradas vacías no rompen', () => {
        expect(IG.datasetsRodeosAcumulados(null).actual).toEqual([]);
        expect(IG.datasetsColleras(undefined)).toEqual([]);
        expect(IG.datasetsSituaciones({}).labels).toEqual([]);
        expect(IG.sparkline([{ nota: 5 }, { nota: null }, { nota: 6 }])).toEqual([5, 6]);
    });
});
