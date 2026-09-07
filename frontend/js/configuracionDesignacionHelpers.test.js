const {
    activarCriterio, desactivarCriterio, moverCriterio,
    activarCategoria, desactivarCategoria, moverCategoria,
    validarDraft, construirDiffParaUI
} = require('./configuracionDesignacionHelpers');

// ─── Fixture V1 real (Etapa 4, sección 56: "Test de V1") ───────────────────
const ORDEN_CRITERIOS_V1 = [
    { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 },
    { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 2 },
    { criterio_codigo: 'MENOR_DISTANCIA', orden: 3 }
];
const MATRIZ_V1 = {
    interclubes: [
        { categoria: 'A', elegible: false, orden_preferencia: null },
        { categoria: 'B', elegible: true, orden_preferencia: 2 },
        { categoria: 'C', elegible: true, orden_preferencia: 1 }
    ],
    provincial: [
        { categoria: 'A', elegible: true, orden_preferencia: 2 },
        { categoria: 'B', elegible: true, orden_preferencia: 1 },
        { categoria: 'C', elegible: false, orden_preferencia: null }
    ],
    interasociaciones: [
        { categoria: 'A', elegible: true, orden_preferencia: 1 },
        { categoria: 'B', elegible: true, orden_preferencia: 2 },
        { categoria: 'C', elegible: false, orden_preferencia: null }
    ],
    zonal: [
        { categoria: 'A', elegible: true, orden_preferencia: 1 },
        { categoria: 'B', elegible: true, orden_preferencia: 2 },
        { categoria: 'C', elegible: false, orden_preferencia: null }
    ],
    clasificatorio: [
        { categoria: 'A', elegible: true, orden_preferencia: 1 },
        { categoria: 'B', elegible: true, orden_preferencia: 2 },
        { categoria: 'C', elegible: false, orden_preferencia: null }
    ],
    nacional: [
        { categoria: 'A', elegible: true, orden_preferencia: 1 },
        { categoria: 'B', elegible: false, orden_preferencia: null },
        { categoria: 'C', elegible: false, orden_preferencia: null }
    ]
};
function configV1() {
    return {
        schema_version: 1,
        regla_distancia_maxima_activa: true, distancia_maxima_km: 600,
        regla_no_repetir_asociacion_activa: true, regla_un_rodeo_por_finde_activa: true,
        regla_finde_consecutivo_activa: true, regla_asociacion_organizadora_activa: true,
        ordenCriterios: ORDEN_CRITERIOS_V1.map(o => ({ ...o })),
        matriz: JSON.parse(JSON.stringify(MATRIZ_V1))
    };
}

// TEST 56 — representación de V1
describe('TEST 56: representación de V1 con los helpers', () => {
    test('textoOrdenCategorias (vía construirDiffParaUI) representa cada clasificación como en el pedido', () => {
        // Se usa construirDiffParaUI comparando V1 contra sí mismo (sin
        // diferencias) para extraer la representación textual real que la UI
        // mostraría — más fiel que reimplementar el formato acá.
        const igual = construirDiffParaUI(configV1(), configV1());
        expect(igual.hayDiferencias).toBe(false);

        // Se fuerza un cambio mínimo (descripcion no existe como campo
        // comparado) — en su lugar, se verifica directamente vía un diff
        // contra una config con la matriz vacía para each clasificación,
        // leyendo el "antes" (que es V1).
        const vacio = configV1();
        vacio.matriz.interclubes = vacio.matriz.interclubes.map(f => ({ ...f, elegible: false, orden_preferencia: null }));
        vacio.matriz.interclubes[0] = { categoria: 'A', elegible: true, orden_preferencia: 1 }; // evita "0 elegibles" en la fixture de comparación
        const diff = construirDiffParaUI(configV1(), vacio);
        const cambioInterclubes = diff.cambios.find(c => c.etiqueta === 'interclubes');
        expect(cambioInterclubes.antes).toBe('B,C (C→B)');
    });

    test('Provincial: B→A', () => {
        const vacio = configV1();
        vacio.matriz.provincial = [{ categoria: 'A', elegible: true, orden_preferencia: 1 }, { categoria: 'B', elegible: false, orden_preferencia: null }, { categoria: 'C', elegible: false, orden_preferencia: null }];
        const diff = construirDiffParaUI(configV1(), vacio);
        expect(diff.cambios.find(c => c.etiqueta === 'provincial').antes).toBe('A,B (B→A)');
    });

    test('Interasociaciones/Zonal/Clasificatorio: A→B', () => {
        for (const codigo of ['interasociaciones', 'zonal', 'clasificatorio']) {
            const vacio = configV1();
            vacio.matriz[codigo] = [{ categoria: 'A', elegible: false, orden_preferencia: null }, { categoria: 'B', elegible: true, orden_preferencia: 1 }, { categoria: 'C', elegible: false, orden_preferencia: null }];
            const diff = construirDiffParaUI(configV1(), vacio);
            expect(diff.cambios.find(c => c.etiqueta === codigo).antes).toBe('A,B (A→B)');
        }
    });

    test('Nacional: A', () => {
        const vacio = configV1();
        vacio.matriz.nacional = [{ categoria: 'A', elegible: false, orden_preferencia: null }, { categoria: 'B', elegible: true, orden_preferencia: 1 }, { categoria: 'C', elegible: false, orden_preferencia: null }];
        const diff = construirDiffParaUI(configV1(), vacio);
        expect(diff.cambios.find(c => c.etiqueta === 'nacional').antes).toBe('A (A)');
    });

    test('Prioridades V1: Categoría → Equidad → Distancia', () => {
        const otra = configV1();
        otra.ordenCriterios = [{ criterio_codigo: 'MENOR_DISTANCIA', orden: 1 }, { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 2 }, { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 3 }];
        const diff = construirDiffParaUI(configV1(), otra);
        const cambioPrioridad = diff.cambios.find(c => c.etiqueta === 'Prioridades');
        expect(cambioPrioridad.antes).toBe('Prioridad de categoría → Menos designaciones → Menor distancia');
    });

    test('validarDraft(V1) es válido', () => {
        expect(validarDraft(configV1())).toEqual({ valido: true });
    });
});

// ─── Criterios ──────────────────────────────────────────────────────────
describe('activarCriterio / desactivarCriterio / moverCriterio', () => {
    test('activar un criterio inactivo lo agrega al final', () => {
        const soloDos = [{ criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 }, { criterio_codigo: 'MENOR_DISTANCIA', orden: 2 }];
        const resultado = activarCriterio(soloDos, 'MENOS_DESIGNACIONES_TEMPORADA');
        expect(resultado).toEqual([
            { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 },
            { criterio_codigo: 'MENOR_DISTANCIA', orden: 2 },
            { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 3 }
        ]);
    });
    test('activar un criterio ya activo es idempotente (no lo duplica)', () => {
        const resultado = activarCriterio(ORDEN_CRITERIOS_V1, 'PRIORIDAD_CATEGORIA');
        expect(resultado).toEqual(ORDEN_CRITERIOS_V1);
    });
    test('desactivar un criterio lo quita y renumera 1..N sin huecos', () => {
        const resultado = desactivarCriterio(ORDEN_CRITERIOS_V1, 'MENOS_DESIGNACIONES_TEMPORADA');
        expect(resultado).toEqual([
            { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 },
            { criterio_codigo: 'MENOR_DISTANCIA', orden: 2 }
        ]);
    });
    test('desactivar el ÚLTIMO criterio activo no hace nada (nunca 0 activos, sección 13)', () => {
        const soloUno = [{ criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 }];
        expect(desactivarCriterio(soloUno, 'PRIORIDAD_CATEGORIA')).toEqual(soloUno);
    });
    test('mover un criterio arriba/abajo intercambia con el vecino', () => {
        const arriba = moverCriterio(ORDEN_CRITERIOS_V1, 'MENOR_DISTANCIA', 'arriba');
        expect(arriba.find(c => c.criterio_codigo === 'MENOR_DISTANCIA').orden).toBe(2);
        expect(arriba.find(c => c.criterio_codigo === 'MENOS_DESIGNACIONES_TEMPORADA').orden).toBe(3);
    });
    test('mover el primero hacia arriba (o el último hacia abajo) no hace nada', () => {
        expect(moverCriterio(ORDEN_CRITERIOS_V1, 'PRIORIDAD_CATEGORIA', 'arriba')).toEqual(
            [...ORDEN_CRITERIOS_V1].sort((a, b) => a.orden - b.orden)
        );
        expect(moverCriterio(ORDEN_CRITERIOS_V1, 'MENOR_DISTANCIA', 'abajo')).toEqual(
            [...ORDEN_CRITERIOS_V1].sort((a, b) => a.orden - b.orden)
        );
    });
});

// ─── Matriz — ejemplo Provincial A/B/C, B→A→C (sección 21/22/46) ──────────
describe('activarCategoria / desactivarCategoria / moverCategoria — Provincial A/B → A/B/C, orden B→A→C', () => {
    test('activar C en Provincial la agrega al final del orden (B→A→C)', () => {
        const provincialV1 = MATRIZ_V1.provincial.map(f => ({ ...f }));
        const conC = activarCategoria(provincialV1, 'C');
        const filaC = conC.find(f => f.categoria === 'C');
        expect(filaC).toEqual({ categoria: 'C', elegible: true, orden_preferencia: 3 });
        // B y A conservan su orden relativo (1 y 2) — el ejemplo del pedido
        // (sección 21/22): B→A→C.
        expect(conC.find(f => f.categoria === 'B').orden_preferencia).toBe(1);
        expect(conC.find(f => f.categoria === 'A').orden_preferencia).toBe(2);
    });
    test('mover C hacia arriba dos veces produce C→B→A', () => {
        const provincialV1 = MATRIZ_V1.provincial.map(f => ({ ...f }));
        let conC = activarCategoria(provincialV1, 'C'); // B(1) A(2) C(3)
        conC = moverCategoria(conC, 'C', 'arriba'); // B(1) C(2) A(3)
        conC = moverCategoria(conC, 'C', 'arriba'); // C(1) B(2) A(3)
        const ordenTexto = conC.filter(f => f.elegible).sort((a, b) => a.orden_preferencia - b.orden_preferencia).map(f => f.categoria).join('→');
        expect(ordenTexto).toBe('C→B→A');
    });
    test('desactivar una categoría elegible renumera las restantes sin huecos', () => {
        const provincialV1 = MATRIZ_V1.provincial.map(f => ({ ...f })); // A(2,elegible) B(1,elegible) C(no elegible)
        const sinB = desactivarCategoria(provincialV1, 'B');
        expect(sinB.find(f => f.categoria === 'B')).toEqual({ categoria: 'B', elegible: false, orden_preferencia: null });
        expect(sinB.find(f => f.categoria === 'A').orden_preferencia).toBe(1); // renumerada de 2 → 1
    });
    test('desactivar la ÚLTIMA categoría elegible no hace nada (nunca 0 elegibles, sección 23)', () => {
        const soloNacionalA = MATRIZ_V1.nacional.map(f => ({ ...f })); // solo A elegible
        expect(desactivarCategoria(soloNacionalA, 'A')).toEqual(soloNacionalA);
    });

    // Revisión final Etapa 4, sección 20: Provincial A/B/C con B→A→C debe
    // (a) quedar como estructura válida, (b) mostrar las 3 elegibles, (c)
    // mantener posiciones 1,2,3, y (d) generar el diff CORRECTO contra V1
    // (que es A/B con B→A, sin C).
    test('Provincial A/B/C, orden B→A→C: estructura válida + diff correcto contra V1', () => {
        // activarCategoria('C') agrega al FINAL del orden actual (B=1, A=2)
        // → C queda en 3 → resultado exacto B(1)→A(2)→C(3), sin necesitar
        // ningún moverCategoria() adicional (mismo mecanismo ya probado
        // arriba en "activar C en Provincial la agrega al final del orden").
        const provincial = activarCategoria(MATRIZ_V1.provincial.map(f => ({ ...f })), 'C');

        // (a)/(b)/(c) estructura válida: 3 categorías presentes, las 3 elegibles, posiciones 1,2,3 sin huecos.
        expect(provincial).toHaveLength(3);
        expect(provincial.every(f => f.elegible)).toBe(true);
        expect(provincial.map(f => f.orden_preferencia).sort()).toEqual([1, 2, 3]);

        const configConC = configV1();
        configConC.matriz.provincial = provincial;
        expect(validarDraft(configConC)).toEqual({ valido: true });

        // (d) diff correcto contra V1 (A/B, B→A, sin C) → (A/B/C, B→A→C).
        const diff = construirDiffParaUI(configV1(), configConC);
        const cambioProvincial = diff.cambios.find(c => c.etiqueta === 'provincial');
        expect(cambioProvincial.antes).toBe('A,B (B→A)');
        expect(cambioProvincial.despues).toBe('A,B,C (B→A→C)');
    });
});

// ─── validarDraft ───────────────────────────────────────────────────────
describe('validarDraft', () => {
    test('0 criterios → inválido', () => {
        const config = { ...configV1(), ordenCriterios: [] };
        expect(validarDraft(config).valido).toBe(false);
    });
    test('distancia activa sin valor → inválido', () => {
        const config = { ...configV1(), distancia_maxima_km: null };
        expect(validarDraft(config).valido).toBe(false);
    });
    test('distancia 5001 (regla activa) → inválido', () => {
        const config = { ...configV1(), distancia_maxima_km: 5001 };
        expect(validarDraft(config).valido).toBe(false);
    });
    test('distancia desactivada con null → válido (sección 15)', () => {
        const config = { ...configV1(), regla_distancia_maxima_activa: false, distancia_maxima_km: null };
        expect(validarDraft(config)).toEqual({ valido: true });
    });
    test('matriz con una clasificación sin categorías elegibles → inválido', () => {
        const config = configV1();
        config.matriz.nacional = config.matriz.nacional.map(f => ({ ...f, elegible: false, orden_preferencia: null }));
        expect(validarDraft(config).valido).toBe(false);
    });
});
