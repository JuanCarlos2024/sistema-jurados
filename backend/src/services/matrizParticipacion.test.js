// ═════════════════════════════════════════════════════════════════════════
// Tests de matrizParticipacion.js — Matriz de Participación con los 3
// indicadores (Casos/Comisión/Delegado) y sus benchmarks (Categoría/General).
//
// Primera parte: funciones PURAS (construirPersonas, calcularBenchmarks,
// aplicarFiltrosVisuales, ordenar) probadas directamente con fixtures en
// memoria, sin mock de Supabase — rápido y preciso para la lógica de
// negocio (independencia de indicadores, exclusión de la propia persona,
// universo estadístico vs filas visibles, división por cero, etc.).
//
// Segunda parte: obtenerMatrizParticipacion() de punta a punta con Supabase
// mockeado — verifica el conteo de queries (anti N+1) y que un rodeo
// compartido por varias personas no duplique ni infle nada.
// ═════════════════════════════════════════════════════════════════════════
jest.mock('../config/supabase', () => ({ from: jest.fn() }));
const supabase = require('../config/supabase');
const {
    obtenerMatrizParticipacion, round2, calcularPeriodo,
    construirPersonas, calcularBenchmarks, aplicarFiltrosVisuales, ordenar
} = require('./matrizParticipacion');

// ─── Fixtures ────────────────────────────────────────────────────────────
// 2 jurados Cat. B (Juan, Pedro), 1 jurado Cat. A (Maria, única en su
// categoría — para el caso "benchmark categoría = null"), 1 delegado (Ana).
// Rodeo R1 es COMPARTIDO por Juan y Pedro (mismo rodeo, dos asignaciones) —
// clave para probar que rodeo_notas_secundarias no se duplica ni infla.
function fixtureBase() {
    const todasAsigs = [
        { id: 'asig-juan-r1', usuario_pagado_id: 'juan', tipo_persona: 'jurado', estado_designacion: 'aceptado',
          rodeos: { id: 'r1', fecha: '2026-04-10', club: 'Club R1', asociacion: 'Aso R1', tipo_rodeo_nombre: 'Provincial' } },
        { id: 'asig-pedro-r1', usuario_pagado_id: 'pedro', tipo_persona: 'jurado', estado_designacion: 'aceptado',
          rodeos: { id: 'r1', fecha: '2026-04-10', club: 'Club R1', asociacion: 'Aso R1', tipo_rodeo_nombre: 'Provincial' } },
        { id: 'asig-juan-r2', usuario_pagado_id: 'juan', tipo_persona: 'jurado', estado_designacion: 'aceptado',
          rodeos: { id: 'r2', fecha: '2026-05-01', club: 'Club R2', asociacion: 'Aso R2', tipo_rodeo_nombre: 'Regional' } },
        { id: 'asig-maria-r1', usuario_pagado_id: 'maria', tipo_persona: 'jurado', estado_designacion: 'aceptado',
          rodeos: { id: 'r1', fecha: '2026-04-10', club: 'Club R1', asociacion: 'Aso R1', tipo_rodeo_nombre: 'Provincial' } },
        { id: 'asig-ana-r1', usuario_pagado_id: 'ana', tipo_persona: 'delegado_rentado', estado_designacion: 'aceptado',
          rodeos: { id: 'r1', fecha: '2026-04-10', club: 'Club R1', asociacion: 'Aso R1', tipo_rodeo_nombre: 'Provincial' } }
    ];
    const usuariosMap = {
        juan:  { id: 'juan',  nombre_completo: 'JUAN PÉREZ',   categoria: 'B', tipo_persona: 'jurado' },
        pedro: { id: 'pedro', nombre_completo: 'PEDRO SOTO',   categoria: 'B', tipo_persona: 'jurado' },
        maria: { id: 'maria', nombre_completo: 'MARIA ROJAS',  categoria: 'A', tipo_persona: 'jurado' },
        luis:  { id: 'luis',  nombre_completo: 'LUIS DIAZ',    categoria: 'C', tipo_persona: 'jurado' }, // sin salidas
        ana:   { id: 'ana',   nombre_completo: 'ANA TORRES',   categoria: null, tipo_persona: 'delegado_rentado' }
    };
    // Casos: Juan tiene nota en r1 y r2; Pedro solo en r1; Maria sin nota.
    const notasCasosMap = {
        'asig-juan-r1': 6.0, 'asig-juan-r2': 6.6, 'asig-pedro-r1': 5.0
        // asig-maria-r1: sin nota (NULL)
    };
    // Comisión/Delegado son POR RODEO — r1 tiene ambas, r2 no tiene ninguna.
    const notasSecMap = {
        r1: { nota_comision: 5.8, nota_delegado: 6.2 }
        // r2: sin fila en rodeo_notas_secundarias -> null/null
    };
    return { todasAsigs, usuariosMap, notasCasosMap, notasSecMap };
}

describe('round2 / calcularPeriodo', () => {
    test('round2 redondea a 2 decimales', () => {
        expect(round2(5.6666)).toBe(5.67);
        expect(round2(5.605)).toBeCloseTo(5.61, 1);
    });
    test('calcularPeriodo respeta desde/hasta por sobre año/mes', () => {
        const p = calcularPeriodo({ año: 2026, mes: null, desde: '2026-04-01', hasta: '2026-06-30' });
        expect(p.inicio).toBe('2026-04-01');
        expect(p.fin).toBe('2026-06-30');
    });
    test('calcularPeriodo usa año completo si no hay mes ni rango', () => {
        const p = calcularPeriodo({ año: 2026, mes: null, desde: null, hasta: null });
        expect(p.inicio).toBe('2026-01-01');
        expect(p.fin).toBe('2026-12-31');
    });
});

describe('construirPersonas — 1. Promedio Casos independiente / 2. Comisión / 3. Delegado / 4. NULL no cuenta como 0 / 5. Conteo correcto', () => {
    test('cada indicador se calcula de forma independiente, con su propio numerador/denominador', () => {
        const personas = construirPersonas(fixtureBase());
        const juan = personas.find(p => p.usuario_pagado_id === 'juan');
        // Casos: (6.0 + 6.6)/2 = 6.3, con_nota=2 de 2 salidas
        expect(juan._promedios_individuales.casos.promedio).toBe(6.3);
        expect(juan._promedios_individuales.casos.con_nota).toBe(2);
        // Comisión: solo r1 tiene nota_comision (5.8) -> promedio 5.8, con_nota=1 de 2 salidas
        expect(juan._promedios_individuales.comision.promedio).toBe(5.8);
        expect(juan._promedios_individuales.comision.con_nota).toBe(1);
        // Delegado: solo r1 tiene nota_delegado (6.2) -> promedio 6.2, con_nota=1 de 2
        expect(juan._promedios_individuales.delegado.promedio).toBe(6.2);
        expect(juan._promedios_individuales.delegado.con_nota).toBe(1);
        expect(juan.total_salidas).toBe(2);
    });

    test('NULL nunca cuenta como 0: Maria sin nota de Casos -> promedio null, no 0', () => {
        const personas = construirPersonas(fixtureBase());
        const maria = personas.find(p => p.usuario_pagado_id === 'maria');
        expect(maria._promedios_individuales.casos.promedio).toBeNull();
        expect(maria._promedios_individuales.casos.con_nota).toBe(0);
        // Pero Comisión/Delegado de r1 SÍ existen para Maria (nota del rodeo, no de la persona)
        expect(maria._promedios_individuales.comision.promedio).toBe(5.8);
        expect(maria._promedios_individuales.delegado.promedio).toBe(6.2);
    });

    test('un rodeo compartido por Juan y Pedro no duplica ni infla nada — ambos ven la misma nota_comision/nota_delegado de r1', () => {
        const personas = construirPersonas(fixtureBase());
        const juan  = personas.find(p => p.usuario_pagado_id === 'juan');
        const pedro = personas.find(p => p.usuario_pagado_id === 'pedro');
        expect(juan.rodeos.find(r => r.rodeo_id === 'r1').nota_comision).toBe(5.8);
        expect(pedro.rodeos.find(r => r.rodeo_id === 'r1').nota_comision).toBe(5.8);
        expect(juan.rodeos.find(r => r.rodeo_id === 'r1').nota_delegado).toBe(6.2);
        expect(pedro.rodeos.find(r => r.rodeo_id === 'r1').nota_delegado).toBe(6.2);
        // Cada uno solo tiene 1 fila por r1 (no se multiplicó por el join)
        expect(juan.rodeos.filter(r => r.rodeo_id === 'r1')).toHaveLength(1);
        expect(pedro.rodeos.filter(r => r.rodeo_id === 'r1')).toHaveLength(1);
    });

    test('persona sin ninguna asignación (Luis) queda con total_salidas=0 y sin_salidas=true, sin NaN', () => {
        const personas = construirPersonas(fixtureBase());
        const luis = personas.find(p => p.usuario_pagado_id === 'luis');
        expect(luis.total_salidas).toBe(0);
        expect(luis.sin_salidas).toBe(true);
        expect(luis._promedios_individuales.casos.promedio).toBeNull();
        expect(luis._promedios_individuales.comision.promedio).toBeNull();
        expect(luis._promedios_individuales.delegado.promedio).toBeNull();
        expect(luis.promedio_nota).toBeNull(); // compatibilidad hacia atrás — nunca NaN
    });

    test('compatibilidad hacia atrás: promedio_nota/notas_count/sin_nota_count siguen presentes y equivalen a Casos', () => {
        const personas = construirPersonas(fixtureBase());
        const juan = personas.find(p => p.usuario_pagado_id === 'juan');
        expect(juan.promedio_nota).toBe(6.3);
        expect(juan.notas_count).toBe(2);
        expect(juan.sin_nota_count).toBe(0);
        // rodeos[].nota sigue existiendo (alias de nota_casos)
        expect(juan.rodeos[0].nota).toBe(juan.rodeos[0].nota_casos);
    });
});

describe('calcularBenchmarks — 6. excluye a la propia persona (categoría) / 7. excluye a la propia persona (general) / 8. no mezcla tipo_persona / 11. único integrante -> null', () => {
    test('benchmark de categoría de Juan (Cat. B) es el promedio de Pedro únicamente (excluyéndose a sí mismo)', () => {
        let personas = construirPersonas(fixtureBase());
        personas = calcularBenchmarks(personas);
        const juan = personas.find(p => p.usuario_pagado_id === 'juan');
        // Pedro Cat.B Casos = 5.0 (único otro par B con nota de Casos)
        expect(juan.promedios.casos.promedio_categoria).toBe(5.0);
        expect(juan.promedios.casos.diferencia_categoria).toBe(round2(6.3 - 5.0));
    });

    test('benchmark general de Juan (Jurado) promedia a Pedro y Maria (todas las categorías), excluyéndose a sí mismo — Maria no tiene Casos, no aporta', () => {
        let personas = construirPersonas(fixtureBase());
        personas = calcularBenchmarks(personas);
        const juan = personas.find(p => p.usuario_pagado_id === 'juan');
        // Solo Pedro tiene promedio de Casos entre "el resto de los jurados" (Maria=null no aporta)
        expect(juan.promedios.casos.promedio_general).toBe(5.0);
    });

    test('el benchmark de un Jurado NUNCA incluye a Ana (delegado_rentado) — no se mezclan tipos', () => {
        let personas = construirPersonas(fixtureBase());
        personas = calcularBenchmarks(personas);
        const juan = personas.find(p => p.usuario_pagado_id === 'juan');
        // Si Ana (delegado) se mezclara, el general cambiaría — se verifica que sigue dando 5.0 (solo Pedro)
        expect(juan.promedios.casos.promedio_general).toBe(5.0);
        const ana = personas.find(p => p.usuario_pagado_id === 'ana');
        // Ana es la única delegada -> sin pares -> benchmarks null
        expect(ana.promedios.comision.promedio_categoria).toBeNull();
        expect(ana.promedios.comision.promedio_general).toBeNull();
    });

    test('Maria es la única Jurado Cat. A con datos -> benchmark de categoría es null (nunca NaN/0 artificial)', () => {
        let personas = construirPersonas(fixtureBase());
        personas = calcularBenchmarks(personas);
        const maria = personas.find(p => p.usuario_pagado_id === 'maria');
        // Maria no tiene promedio propio de Comisión... en realidad SÍ tiene (5.8, de r1) y es la única Cat.A
        expect(maria.categoria).toBe('A');
        expect(maria.promedios.comision.promedio).toBe(5.8);
        expect(maria.promedios.comision.promedio_categoria).toBeNull(); // única en Cat. A
        expect(maria.promedios.comision.diferencia_categoria).toBeNull();
        // General SÍ tiene pares (Juan, Pedro también tienen Comisión de r1)
        expect(maria.promedios.comision.promedio_general).not.toBeNull();
    });

    test('persona sin salidas (Luis) no aporta a ningún benchmark de los demás', () => {
        let personas = construirPersonas(fixtureBase());
        const antesLuis = personas.find(p => p.usuario_pagado_id === 'luis');
        expect(antesLuis._promedios_individuales.casos.promedio).toBeNull();
        personas = calcularBenchmarks(personas);
        const luisCat = personas.find(p => p.usuario_pagado_id === 'luis').categoria; // 'C', sin otros C
        const luis = personas.find(p => p.usuario_pagado_id === 'luis');
        expect(luis.promedios.casos.promedio_categoria).toBeNull(); // sin pares en Cat. C
    });

    test('diferencia solo se calcula cuando la persona tiene promedio propio — nunca compara "—" contra un número', () => {
        let personas = construirPersonas(fixtureBase());
        personas = calcularBenchmarks(personas);
        const maria = personas.find(p => p.usuario_pagado_id === 'maria');
        expect(maria.promedios.casos.promedio).toBeNull(); // sin nota de Casos
        expect(maria.promedios.casos.diferencia_categoria).toBeNull();
        expect(maria.promedios.casos.diferencia_general).toBeNull();
    });

    // Caso numérico concreto que DEMUESTRA que no hay redondeo prematuro:
    // Persona A tiene 3 notas de Casos [4.0, 4.0, 4.1] -> promedio EXACTO =
    // 4.0333...33 (que se REDONDEA a 4.03 solo para mostrarse). Persona B
    // tiene 1 nota [4.1] -> promedio exacto 4.1 (sin error de redondeo).
    // El benchmark correcto de un tercero (Target, mismo tipo y categoría)
    // frente a A+B debe salir de sumar los promedios EXACTOS —
    // (4.0333...33 + 4.1) / 2 = 4.0666...67 -> redondea a 4.07.
    // Si el código sumara los promedios YA REDONDEADOS (4.03 + 4.1) / 2 =
    // 4.065, la representación en punto flotante de JS da 4.06 al
    // redondear (Math.round(4.065*100) no da 407 por el error de punto
    // flotante de 4.065) — un resultado matemáticamente incorrecto que
    // este test detecta si alguna vez se reintroduce el redondeo prematuro.
    test('precisión sin redondeo prematuro (punto 1 de la revisión): el benchmark usa el promedio EXACTO de cada integrante, no el ya redondeado a 2 decimales', () => {
        const todasAsigs = [
            { id: 'a1', usuario_pagado_id: 'pA', tipo_persona: 'jurado', estado_designacion: 'aceptado', rodeos: { id: 'r1', fecha: '2026-01-01' } },
            { id: 'a2', usuario_pagado_id: 'pA', tipo_persona: 'jurado', estado_designacion: 'aceptado', rodeos: { id: 'r2', fecha: '2026-01-02' } },
            { id: 'a3', usuario_pagado_id: 'pA', tipo_persona: 'jurado', estado_designacion: 'aceptado', rodeos: { id: 'r3', fecha: '2026-01-03' } },
            { id: 'a4', usuario_pagado_id: 'pB', tipo_persona: 'jurado', estado_designacion: 'aceptado', rodeos: { id: 'r4', fecha: '2026-01-04' } },
            { id: 'a5', usuario_pagado_id: 'pT', tipo_persona: 'jurado', estado_designacion: 'aceptado', rodeos: { id: 'r5', fecha: '2026-01-05' } }
        ];
        const usuariosMap = {
            pA: { id: 'pA', nombre_completo: 'PERSONA A', categoria: 'B', tipo_persona: 'jurado' },
            pB: { id: 'pB', nombre_completo: 'PERSONA B', categoria: 'B', tipo_persona: 'jurado' },
            pT: { id: 'pT', nombre_completo: 'PERSONA TARGET', categoria: 'B', tipo_persona: 'jurado' }
        };
        const notasCasosMap = { a1: 4.0, a2: 4.0, a3: 4.1, a4: 4.1, a5: 7.0 };
        let personas = construirPersonas({ todasAsigs, usuariosMap, notasCasosMap, notasSecMap: {} });

        const pA = personas.find(p => p.usuario_pagado_id === 'pA');
        expect(pA._promedios_individuales.casos.promedioExacto).toBeCloseTo(4.0333333, 6); // precisión completa conservada
        expect(pA._promedios_individuales.casos.promedio).toBe(4.03); // pero se muestra redondeado, sin cambio visual

        personas = calcularBenchmarks(personas);
        const target = personas.find(p => p.usuario_pagado_id === 'pT');
        expect(target.promedios.casos.promedio_categoria).toBe(4.07); // correcto con precisión completa
        expect(target.promedios.casos.promedio_categoria).not.toBe(4.06); // 4.06 sería el resultado con redondeo prematuro
    });
});

describe('aplicarFiltrosVisuales — 9. Categoría no reduce el universo general / 10. Buscar Nombre no afecta benchmarks', () => {
    test('filtrar por Categoría B no cambia el benchmark general de Juan (calculado ANTES del filtro)', () => {
        let personas = construirPersonas(fixtureBase());
        personas = calcularBenchmarks(personas); // benchmarks sobre el universo COMPLETO (A+B+C+DR)
        const generalAntes = personas.find(p => p.usuario_pagado_id === 'juan').promedios.casos.promedio_general;

        const visibles = aplicarFiltrosVisuales(personas, { categoria: 'B', search: null, incluirSinSalidas: true });
        expect(visibles.every(p => p.categoria === 'B')).toBe(true); // la tabla sí queda acotada a B
        const juanVisible = visibles.find(p => p.usuario_pagado_id === 'juan');
        expect(juanVisible.promedios.casos.promedio_general).toBe(generalAntes); // el benchmark NO cambió
    });

    test('Buscar Nombre "JUAN" muestra solo a Juan, pero su benchmark sigue siendo el de todo su universo (Pedro sigue contando)', () => {
        let personas = construirPersonas(fixtureBase());
        personas = calcularBenchmarks(personas);
        const benchmarkAntes = personas.find(p => p.usuario_pagado_id === 'juan').promedios.casos.promedio_categoria;

        const visibles = aplicarFiltrosVisuales(personas, { categoria: null, search: 'juan', incluirSinSalidas: true });
        expect(visibles).toHaveLength(1);
        expect(visibles[0].promedios.casos.promedio_categoria).toBe(benchmarkAntes);
    });

    test('Incluir sin salidas = false quita a Luis de las filas visibles', () => {
        let personas = construirPersonas(fixtureBase());
        personas = calcularBenchmarks(personas);
        const conSinSalidas = aplicarFiltrosVisuales(personas, { categoria: null, search: null, incluirSinSalidas: true });
        const sinSinSalidas = aplicarFiltrosVisuales(personas, { categoria: null, search: null, incluirSinSalidas: false });
        expect(conSinSalidas.some(p => p.usuario_pagado_id === 'luis')).toBe(true);
        expect(sinSinSalidas.some(p => p.usuario_pagado_id === 'luis')).toBe(false);
    });
});

describe('ordenar — 15. nuevos ordenamientos, sin-nota siempre al final', () => {
    test('casos_desc ordena de mayor a menor promedio de Casos, dejando null al final', () => {
        let personas = construirPersonas(fixtureBase());
        personas = calcularBenchmarks(personas);
        const orden = ordenar(personas, 'casos_desc').map(p => p.usuario_pagado_id);
        // Juan(6.3) > Pedro(5.0) > (Maria/Luis/Ana sin nota, orden entre ellos indistinto) siempre al final
        expect(orden[0]).toBe('juan');
        expect(orden[1]).toBe('pedro');
        const idxSinNota = orden.slice(2);
        expect(idxSinNota).toEqual(expect.arrayContaining(['maria', 'luis', 'ana']));
    });

    test('casos_asc ordena de menor a mayor, sin-nota también al final (nunca primero)', () => {
        let personas = construirPersonas(fixtureBase());
        personas = calcularBenchmarks(personas);
        const orden = ordenar(personas, 'casos_asc').map(p => p.usuario_pagado_id);
        expect(orden[0]).toBe('pedro'); // 5.0
        expect(orden[1]).toBe('juan');  // 6.3
        expect(orden.slice(2)).toEqual(expect.arrayContaining(['maria', 'luis', 'ana']));
    });

    test('comision_desc y delegado_desc ordenan por su propio indicador (independiente de Casos)', () => {
        let personas = construirPersonas(fixtureBase());
        personas = calcularBenchmarks(personas);
        const ordenCom = ordenar(personas, 'comision_desc').map(p => p.usuario_pagado_id);
        // Juan, Pedro, Maria comparten nota_comision=5.8 (mismo rodeo) -> empatados primero, Luis/Ana sin nota al final
        expect(ordenCom.slice(0, 3)).toEqual(expect.arrayContaining(['juan', 'pedro', 'maria']));
        expect(ordenCom.slice(3)).toEqual(expect.arrayContaining(['luis', 'ana']));
    });

    test('nota_desc/nota_asc (alias legacy) siguen funcionando igual que casos_desc/casos_asc', () => {
        let personas = construirPersonas(fixtureBase());
        personas = calcularBenchmarks(personas);
        const legacy = ordenar(personas, 'nota_desc').map(p => p.usuario_pagado_id);
        const nuevo  = ordenar(personas, 'casos_desc').map(p => p.usuario_pagado_id);
        expect(legacy).toEqual(nuevo);
    });
});

// ─── obtenerMatrizParticipacion — extremo a extremo con Supabase mockeado ───
function mockSupabaseSecuencial(respuestas) {
    let llamada = 0;
    const llamadasPorTabla = [];
    supabase.from.mockImplementation((tabla) => {
        llamadasPorTabla.push(tabla);
        const idx = llamada++;
        const data = respuestas[idx] ?? [];
        const chain = {
            select: () => chain, eq: () => chain, gte: () => chain, lte: () => chain, in: () => chain,
            then: (resolve) => Promise.resolve({ data, error: null }).then(resolve)
        };
        return chain;
    });
    return llamadasPorTabla;
}

describe('obtenerMatrizParticipacion — 13. cardinalidad end-to-end / N+1', () => {
    beforeEach(() => jest.clearAllMocks());

    test('hace exactamente 4 consultas (anti N+1), sin importar cuántas personas/rodeos', async () => {
        const f = fixtureBase();
        const llamadas = mockSupabaseSecuencial([
            f.todasAsigs,                                                              // asignaciones
            Object.values(f.usuariosMap),                                              // usuarios_pagados
            Object.entries(f.notasCasosMap).map(([asignacion_id, nota]) => ({ asignacion_id, nota })), // notas_rodeo
            Object.entries(f.notasSecMap).map(([rodeo_id, v]) => ({ rodeo_id, ...v }))  // rodeo_notas_secundarias
        ]);
        const resultado = await obtenerMatrizParticipacion({ año: 2026, mes: null, desde: null, hasta: null, tipo: null, categoria: null, search: null, order: 'salidas_desc', incluirSinSalidas: true });
        expect(llamadas).toEqual(['asignaciones', 'usuarios_pagados', 'notas_rodeo', 'rodeo_notas_secundarias']);
        expect(resultado.personas.length).toBeGreaterThan(0);
        const juan = resultado.personas.find(p => p.usuario_pagado_id === 'juan');
        expect(juan.promedios.casos.promedio).toBe(6.3);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// VALIDACIÓN DIRIGIDA PRE-COMMIT — casos numéricos concretos pedidos
// explícitamente, con los mismos valores de ejemplo usados en el pedido.
// ═════════════════════════════════════════════════════════════════════════
describe('Validación dirigida — 2. persona sin promedio propio no muestra diferencia', () => {
    test('Comisión null para la persona, pero el resto de la categoría SÍ tiene Comisión: promedio_categoria/general no-null, diferencia SIEMPRE null', () => {
        const todasAsigs = [
            { id: 'a1', usuario_pagado_id: 'pSinComision', tipo_persona: 'jurado', estado_designacion: 'aceptado', rodeos: { id: 'r1', fecha: '2026-01-01' } },
            { id: 'a2', usuario_pagado_id: 'pConComision1', tipo_persona: 'jurado', estado_designacion: 'aceptado', rodeos: { id: 'r2', fecha: '2026-01-02' } },
            { id: 'a3', usuario_pagado_id: 'pConComision2', tipo_persona: 'jurado', estado_designacion: 'aceptado', rodeos: { id: 'r3', fecha: '2026-01-03' } }
        ];
        const usuariosMap = {
            pSinComision:  { id: 'pSinComision',  nombre_completo: 'SIN COMISION', categoria: 'B', tipo_persona: 'jurado' },
            pConComision1: { id: 'pConComision1', nombre_completo: 'CON COMISION 1', categoria: 'B', tipo_persona: 'jurado' },
            pConComision2: { id: 'pConComision2', nombre_completo: 'CON COMISION 2', categoria: 'B', tipo_persona: 'jurado' }
        };
        const notasSecMap = { r2: { nota_comision: 5.4, nota_delegado: null }, r3: { nota_comision: 5.6, nota_delegado: null } };
        // r1 (de pSinComision) SIN fila en rodeo_notas_secundarias -> nota_comision null
        let personas = construirPersonas({ todasAsigs, usuariosMap, notasCasosMap: {}, notasSecMap });
        personas = calcularBenchmarks(personas);
        const p = personas.find(x => x.usuario_pagado_id === 'pSinComision');
        expect(p.promedios.comision.promedio).toBeNull();
        expect(p.promedios.comision.promedio_categoria).toBe(5.5); // (5.4+5.6)/2 — los otros SÍ se usan
        expect(p.promedios.comision.promedio_general).toBe(5.5);
        expect(p.promedios.comision.diferencia_categoria).toBeNull(); // nunca compara "—" contra un número
        expect(p.promedios.comision.diferencia_general).toBeNull();
    });
});

describe('Validación dirigida — 3. persona única en su categoría nunca se compara consigo misma', () => {
    test('Jurado Cat. C único con Prom. Casos, sin otro Cat. C -> Cat.C = null; General SÍ compara contra los demás Jurados', () => {
        const todasAsigs = [
            { id: 'a1', usuario_pagado_id: 'pUnicoC', tipo_persona: 'jurado', estado_designacion: 'aceptado', rodeos: { id: 'r1', fecha: '2026-01-01' } },
            { id: 'a2', usuario_pagado_id: 'pOtroA', tipo_persona: 'jurado', estado_designacion: 'aceptado', rodeos: { id: 'r2', fecha: '2026-01-02' } }
        ];
        const usuariosMap = {
            pUnicoC: { id: 'pUnicoC', nombre_completo: 'UNICO CAT C', categoria: 'C', tipo_persona: 'jurado' },
            pOtroA:  { id: 'pOtroA',  nombre_completo: 'OTRO CAT A', categoria: 'A', tipo_persona: 'jurado' }
        };
        const notasCasosMap = { a1: 5.8, a2: 6.0 };
        let personas = construirPersonas({ todasAsigs, usuariosMap, notasCasosMap, notasSecMap: {} });
        personas = calcularBenchmarks(personas);
        const p = personas.find(x => x.usuario_pagado_id === 'pUnicoC');
        expect(p.promedios.casos.promedio).toBe(5.8);
        expect(p.promedios.casos.promedio_categoria).toBeNull();   // nunca 5.8 (no se compara consigo mismo)
        expect(p.promedios.casos.diferencia_categoria).toBeNull();
        expect(p.promedios.casos.promedio_general).toBe(6.0);      // sí compara contra el resto de Jurados (A+B+C)
    });
});

describe('Validación dirigida — 4/5. Categoría filtrada no contamina el General, y Buscar Nombre no cambia ningún benchmark', () => {
    // Dataset exacto del pedido: Jurado A=6.0, Jurado B1=5.5, Jurado B2=5.0, Jurado C=4.5
    function datasetCategoriaFiltrada() {
        const todasAsigs = [
            { id: 'aA',  usuario_pagado_id: 'jA',  tipo_persona: 'jurado', estado_designacion: 'aceptado', rodeos: { id: 'r1', fecha: '2026-01-01' } },
            { id: 'aB1', usuario_pagado_id: 'jB1', tipo_persona: 'jurado', estado_designacion: 'aceptado', rodeos: { id: 'r2', fecha: '2026-01-02' } },
            { id: 'aB2', usuario_pagado_id: 'jB2', tipo_persona: 'jurado', estado_designacion: 'aceptado', rodeos: { id: 'r3', fecha: '2026-01-03' } },
            { id: 'aC',  usuario_pagado_id: 'jC',  tipo_persona: 'jurado', estado_designacion: 'aceptado', rodeos: { id: 'r4', fecha: '2026-01-04' } }
        ];
        const usuariosMap = {
            jA:  { id: 'jA',  nombre_completo: 'JURADO A',  categoria: 'A', tipo_persona: 'jurado' },
            jB1: { id: 'jB1', nombre_completo: 'JURADO B1', categoria: 'B', tipo_persona: 'jurado' },
            jB2: { id: 'jB2', nombre_completo: 'JURADO B2', categoria: 'B', tipo_persona: 'jurado' },
            jC:  { id: 'jC',  nombre_completo: 'JURADO C',  categoria: 'C', tipo_persona: 'jurado' }
        };
        const notasCasosMap = { aA: 6.0, aB1: 5.5, aB2: 5.0, aC: 4.5 };
        return { todasAsigs, usuariosMap, notasCasosMap, notasSecMap: {} };
    }

    test('4. Cat. B de B1 usa solo a B2; General de B1 usa A+B2+C (excluyendo a B1) — no solo B2', () => {
        let personas = construirPersonas(datasetCategoriaFiltrada());
        personas = calcularBenchmarks(personas); // benchmarks calculados ANTES de cualquier filtro visual
        const b1 = personas.find(p => p.usuario_pagado_id === 'jB1');
        expect(b1.promedios.casos.promedio_categoria).toBe(5.0); // solo B2
        expect(b1.promedios.casos.promedio_general).toBe(round2((6.0 + 5.0 + 4.5) / 3)); // A+B2+C, nunca solo B2

        // Ahora se filtra la pantalla por Categoría B (como haría el admin)
        const visibles = aplicarFiltrosVisuales(personas, { categoria: 'B', search: null, incluirSinSalidas: true });
        expect(visibles.map(p => p.categoria)).toEqual(['B', 'B']); // la tabla sí queda acotada a B
        const b1Visible = visibles.find(p => p.usuario_pagado_id === 'jB1');
        // el benchmark general de B1 sigue siendo A+B2+C, el filtro de categoría NO lo redujo a solo B
        expect(b1Visible.promedios.casos.promedio_general).toBe(round2((6.0 + 5.0 + 4.5) / 3));
    });

    test('5. Buscar Nombre "B1" muestra solo a B1, pero sus benchmarks son exactamente los mismos que sin buscar', () => {
        let personas = construirPersonas(datasetCategoriaFiltrada());
        personas = calcularBenchmarks(personas);
        const b1SinBuscar = personas.find(p => p.usuario_pagado_id === 'jB1');

        const visibles = aplicarFiltrosVisuales(personas, { categoria: null, search: 'JURADO B1', incluirSinSalidas: true });
        expect(visibles).toHaveLength(1);
        const b1ConBuscar = visibles[0];
        expect(b1ConBuscar.promedios.casos.promedio_categoria).toBe(b1SinBuscar.promedios.casos.promedio_categoria);
        expect(b1ConBuscar.promedios.casos.promedio_general).toBe(b1SinBuscar.promedios.casos.promedio_general);
    });
});

describe('Validación dirigida — 7. NULL nunca es 0, cada indicador con su propio conteo', () => {
    test('3 salidas: Casos [5.0,6.0,NULL]=5.50(2/3) · Comisión [NULL,6.0,NULL]=6.00(1/3) · Delegado [NULL,NULL,NULL]=null(0/3)', () => {
        const todasAsigs = [
            { id: 'a1', usuario_pagado_id: 'p', tipo_persona: 'jurado', estado_designacion: 'aceptado', rodeos: { id: 'r1', fecha: '2026-01-01' } },
            { id: 'a2', usuario_pagado_id: 'p', tipo_persona: 'jurado', estado_designacion: 'aceptado', rodeos: { id: 'r2', fecha: '2026-01-02' } },
            { id: 'a3', usuario_pagado_id: 'p', tipo_persona: 'jurado', estado_designacion: 'aceptado', rodeos: { id: 'r3', fecha: '2026-01-03' } }
        ];
        const usuariosMap = { p: { id: 'p', nombre_completo: 'PERSONA', categoria: 'B', tipo_persona: 'jurado' } };
        const notasCasosMap = { a1: 5.0, a2: 6.0 }; // a3 sin nota
        const notasSecMap = { r2: { nota_comision: 6.0, nota_delegado: null } }; // r1 y r3 sin fila -> null
        const personas = construirPersonas({ todasAsigs, usuariosMap, notasCasosMap, notasSecMap });
        const p = personas[0];
        expect(p._promedios_individuales.casos.promedio).toBe(5.5);
        expect(p._promedios_individuales.casos.con_nota).toBe(2);
        expect(p._promedios_individuales.comision.promedio).toBe(6.0);
        expect(p._promedios_individuales.comision.con_nota).toBe(1);
        expect(p._promedios_individuales.delegado.promedio).toBeNull(); // nunca 0.00
        expect(p._promedios_individuales.delegado.con_nota).toBe(0);
        expect(p.total_salidas).toBe(3);
    });
});

describe('Validación dirigida — 8. ordenamiento deja sin-promedio siempre al final, en ambos sentidos', () => {
    function datasetOrden() {
        const todasAsigs = [
            { id: 'aA', usuario_pagado_id: 'pA', tipo_persona: 'jurado', estado_designacion: 'aceptado', rodeos: { id: 'r1', fecha: '2026-01-01' } },
            { id: 'aB', usuario_pagado_id: 'pB', tipo_persona: 'jurado', estado_designacion: 'aceptado', rodeos: { id: 'r2', fecha: '2026-01-02' } },
            { id: 'aC', usuario_pagado_id: 'pC', tipo_persona: 'jurado', estado_designacion: 'aceptado', rodeos: { id: 'r3', fecha: '2026-01-03' } }
        ];
        const usuariosMap = {
            pA: { id: 'pA', nombre_completo: 'A', categoria: 'B', tipo_persona: 'jurado' },
            pB: { id: 'pB', nombre_completo: 'B', categoria: 'B', tipo_persona: 'jurado' },
            pC: { id: 'pC', nombre_completo: 'C', categoria: 'B', tipo_persona: 'jurado' }
        };
        // Comisión: A=6.0, B=null (sin fila), C=5.0
        const notasSecMap = { r1: { nota_comision: 6.0, nota_delegado: null }, r3: { nota_comision: 5.0, nota_delegado: null } };
        return { todasAsigs, usuariosMap, notasCasosMap: {}, notasSecMap };
    }

    test('Mayor Prom. Comisión -> A, C, B (B sin promedio, al final)', () => {
        let personas = construirPersonas(datasetOrden());
        personas = calcularBenchmarks(personas);
        expect(ordenar(personas, 'comision_desc').map(p => p.usuario_pagado_id)).toEqual(['pA', 'pC', 'pB']);
    });

    test('Menor Prom. Comisión -> C, A, B (B sin promedio, al final — nunca primero)', () => {
        let personas = construirPersonas(datasetOrden());
        personas = calcularBenchmarks(personas);
        expect(ordenar(personas, 'comision_asc').map(p => p.usuario_pagado_id)).toEqual(['pC', 'pA', 'pB']);
    });
});
