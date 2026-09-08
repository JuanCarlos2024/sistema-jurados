const {
    activarCriterio, desactivarCriterio, moverCriterio,
    activarEquidadTraslados, desactivarEquidadTraslados,
    activarCategoria, desactivarCategoria, moverCategoria,
    validarDraft, construirDiffParaUI, criteriosConocidosUIParaSchema
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

// ═════════════════════════════════════════════════════════════════════════
// Mejora "Equidad de Traslados" — revisión de cierre: promoción schema1→2,
// bloqueo del criterio Nº1, apagar equidad, distancia hard OFF + equidad ON,
// validarDraft A-G, diff V1→schema2.
// ═════════════════════════════════════════════════════════════════════════

// TEST UI — PROMOCIÓN (sección 23 del pedido)
describe('activarEquidadTraslados — promoción schema1 -> schema2', () => {
    test('draft V1 + activar equidad -> schema_version=2, regla=true, umbral=350, EQUIDAD_TRASLADOS en orden=1, resto desplazado', () => {
        const draft = activarEquidadTraslados(configV1());
        expect(draft.schema_version).toBe(2);
        expect(draft.regla_equidad_traslados_activa).toBe(true);
        expect(draft.umbral_lejania_km).toBe(350);
        expect(draft.ordenCriterios).toEqual([
            { criterio_codigo: 'EQUIDAD_TRASLADOS', orden: 1 },
            { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 2 },
            { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 3 },
            { criterio_codigo: 'MENOR_DISTANCIA', orden: 4 }
        ]);
    });
    test('NO modifica el objeto original (la versión base V1 queda intacta)', () => {
        const base = configV1();
        const baseClon = JSON.parse(JSON.stringify(base));
        activarEquidadTraslados(base);
        expect(base).toEqual(baseClon);
    });
    test('validarDraft() del resultado es válido', () => {
        expect(validarDraft(activarEquidadTraslados(configV1())).valido).toBe(true);
    });
});

// TEST UI — BLOQUEO Nº1 (sección 24 del pedido)
describe('EQUIDAD_TRASLADOS bloqueado en orden=1 — moverCriterio/desactivarCriterio', () => {
    test('intentar mover EQUIDAD_TRASLADOS hacia abajo -> no cambia', () => {
        const draft = activarEquidadTraslados(configV1());
        const resultado = moverCriterio(draft.ordenCriterios, 'EQUIDAD_TRASLADOS', 'abajo');
        expect(resultado).toEqual(draft.ordenCriterios);
    });
    test('intentar mover PRIORIDAD_CATEGORIA (posición 2) hacia arriba -> tampoco desplaza a EQUIDAD_TRASLADOS de la posición 1', () => {
        const draft = activarEquidadTraslados(configV1());
        const resultado = moverCriterio(draft.ordenCriterios, 'PRIORIDAD_CATEGORIA', 'arriba');
        expect(resultado).toEqual(draft.ordenCriterios); // sin cambios
    });
    test('mover el criterio 3 (MENOS_DESIGNACIONES) hacia arriba SÍ funciona (no involucra la posición 1)', () => {
        const draft = activarEquidadTraslados(configV1());
        const resultado = moverCriterio(draft.ordenCriterios, 'MENOS_DESIGNACIONES_TEMPORADA', 'arriba');
        expect(resultado.find(o => o.criterio_codigo === 'MENOS_DESIGNACIONES_TEMPORADA').orden).toBe(2);
        expect(resultado.find(o => o.criterio_codigo === 'PRIORIDAD_CATEGORIA').orden).toBe(3);
        expect(resultado.find(o => o.criterio_codigo === 'EQUIDAD_TRASLADOS').orden).toBe(1); // sigue Nº1
    });
    test('intentar desactivar EQUIDAD_TRASLADOS desde la lista de criterios -> no permitido', () => {
        const draft = activarEquidadTraslados(configV1());
        const resultado = desactivarCriterio(draft.ordenCriterios, 'EQUIDAD_TRASLADOS');
        expect(resultado).toEqual(draft.ordenCriterios); // sigue presente, nada cambia
    });
});

// TEST UI — APAGAR EQUIDAD (sección 25 del pedido)
describe('desactivarEquidadTraslados — apagar el toggle', () => {
    test('schema2 con equidad ON -> apagar: regla=false, umbral=null, EQUIDAD_TRASLADOS eliminado, resto renumerado 1..N, schema_version se MANTIENE en 2', () => {
        const conEquidad = activarEquidadTraslados(configV1());
        const draft = desactivarEquidadTraslados(conEquidad);
        expect(draft.regla_equidad_traslados_activa).toBe(false);
        expect(draft.umbral_lejania_km).toBeNull();
        expect(draft.ordenCriterios.some(o => o.criterio_codigo === 'EQUIDAD_TRASLADOS')).toBe(false);
        expect(draft.ordenCriterios).toEqual([
            { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 },
            { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 2 },
            { criterio_codigo: 'MENOR_DISTANCIA', orden: 3 }
        ]);
        // Decisión documentada (sección 8 del pedido): NO vuelve a schema_version=1.
        expect(draft.schema_version).toBe(2);
    });
    test('el resultado es válido según validarDraft()', () => {
        const draft = desactivarEquidadTraslados(activarEquidadTraslados(configV1()));
        expect(validarDraft(draft).valido).toBe(true);
    });
});

// TEST DISTANCIA HARD OFF + EQUIDAD ON (sección 26 del pedido)
describe('Distancia máxima desactivada + equidad de traslados activa — combinación válida (frontend y backend)', () => {
    test('draft válido: schema=2, hard distancia=false, distancia_maxima=NULL, equidad=true, umbral=350, EQUIDAD orden=1', () => {
        const draft = {
            ...activarEquidadTraslados(configV1()),
            regla_distancia_maxima_activa: false,
            distancia_maxima_km: null
        };
        expect(validarDraft(draft)).toEqual({ valido: true });
    });
});

// TESTS validarDraft A-G (sección 12 del pedido)
describe('validarDraft — Equidad de Traslados, casos A-G', () => {
    test('A: schema1 + regla_equidad_traslados_activa=true -> rechazado', () => {
        const draft = { ...configV1(), regla_equidad_traslados_activa: true, umbral_lejania_km: 350 };
        expect(validarDraft(draft).valido).toBe(false);
    });
    test('B: schema1 + EQUIDAD_TRASLADOS presente en el orden -> rechazado', () => {
        const draft = { ...configV1(), ordenCriterios: [{ criterio_codigo: 'EQUIDAD_TRASLADOS', orden: 1 }, ...ORDEN_CRITERIOS_V1.map(o => ({ ...o, orden: o.orden + 1 }))] };
        expect(validarDraft(draft).valido).toBe(false);
    });
    test('C: schema2 + equidad=true + sin umbral -> rechazado', () => {
        const draft = { ...activarEquidadTraslados(configV1()), umbral_lejania_km: null };
        expect(validarDraft(draft).valido).toBe(false);
    });
    test('D: schema2 + equidad=true + EQUIDAD no en orden=1 -> rechazado', () => {
        const draft = activarEquidadTraslados(configV1());
        draft.ordenCriterios = [
            { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 },
            { criterio_codigo: 'EQUIDAD_TRASLADOS', orden: 2 },
            { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 3 },
            { criterio_codigo: 'MENOR_DISTANCIA', orden: 4 }
        ];
        expect(validarDraft(draft).valido).toBe(false);
    });
    test('E: schema2 + equidad=false + EQUIDAD_TRASLADOS presente -> rechazado', () => {
        const draft = activarEquidadTraslados(configV1());
        draft.regla_equidad_traslados_activa = false;
        expect(validarDraft(draft).valido).toBe(false);
    });
    test('F: umbral <= 0 -> rechazado', () => {
        const draft = { ...activarEquidadTraslados(configV1()), umbral_lejania_km: 0 };
        expect(validarDraft(draft).valido).toBe(false);
    });
    test('G: umbral > 5000 -> rechazado', () => {
        const draft = { ...activarEquidadTraslados(configV1()), umbral_lejania_km: 5001 };
        expect(validarDraft(draft).valido).toBe(false);
    });
    test('caso válido de control: schema2 + equidad=true + umbral=350 + EQUIDAD orden=1 -> aceptado', () => {
        expect(validarDraft(activarEquidadTraslados(configV1())).valido).toBe(true);
    });
});

// TEST DIFF (sección 31 del pedido)
describe('construirDiffParaUI — V1 -> draft schema2 con equidad activa', () => {
    test('refleja distancia máxima, equidad y umbral como cambios distintos', () => {
        const v1 = configV1(); // hard 600, equidad OFF
        const draftSchema2 = {
            ...activarEquidadTraslados(configV1()),
            regla_distancia_maxima_activa: false,
            distancia_maxima_km: null
        }; // hard OFF, equidad ON, 350

        const diff = construirDiffParaUI(v1, draftSchema2);
        expect(diff.hayDiferencias).toBe(true);

        const porEtiqueta = {};
        diff.cambios.forEach(c => { porEtiqueta[c.etiqueta] = c; });

        expect(porEtiqueta['Distancia máxima']).toEqual({ etiqueta: 'Distancia máxima', antes: '600 km', despues: 'Desactivada' });
        expect(porEtiqueta['Equidad de traslados']).toEqual({ etiqueta: 'Equidad de traslados', antes: 'Desactivada', despues: 'Activada' });
        expect(porEtiqueta['Umbral de lejanía']).toEqual({ etiqueta: 'Umbral de lejanía', antes: '—', despues: '350 km' });
        expect(porEtiqueta['Schema']).toEqual({ etiqueta: 'Schema', antes: '1', despues: '2' });
        expect(porEtiqueta['Prioridades'].despues).toMatch(/^Equidad de traslados →/);
    });
});

// criteriosConocidosUIParaSchema — soporte de lista por schema
describe('criteriosConocidosUIParaSchema', () => {
    test('schema 1 no incluye EQUIDAD_TRASLADOS', () => {
        expect(criteriosConocidosUIParaSchema(1)).not.toContain('EQUIDAD_TRASLADOS');
    });
    test('schema 2 incluye EQUIDAD_TRASLADOS', () => {
        expect(criteriosConocidosUIParaSchema(2)).toContain('EQUIDAD_TRASLADOS');
    });
});
