const {
    activarCriterio, desactivarCriterio, moverCriterio,
    activarEquidadTraslados, desactivarEquidadTraslados,
    activarCategoria, desactivarCategoria, moverCategoria,
    validarDraft, construirDiffParaUI, criteriosConocidosUIParaSchema,
    activarZonasExtremas, desactivarZonasExtremas,
    agregarAsociacionZonaExtrema, quitarAsociacionZonaExtrema, _normalizarAsociacionUI
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

// ═════════════════════════════════════════════════════════════════════════
// ZONAS EXTREMAS (schema_version=3) — mismo patrón de tests que EQUIDAD DE
// TRASLADOS arriba: promoción de draft, no-retroceso al desactivar,
// agregar/quitar asociación sin duplicados, categorías reutilizando
// activarCategoria/desactivarCategoria/moverCategoria, validación, diff.
// ═════════════════════════════════════════════════════════════════════════
const ZE_DEFAULT = {
    asociaciones: ['ARICA Y TARAPACA', 'NORTE GRANDE', 'MAGALLANES', 'AYSEN', 'CUYO'],
    categorias: [
        { categoria: 'A', elegible: false, orden_preferencia: null },
        { categoria: 'B', elegible: true, orden_preferencia: 2 },
        { categoria: 'C', elegible: true, orden_preferencia: 1 }
    ]
};

// TEST 34 (pedido de UI): promoción schema2 -> schema3
describe('activarZonasExtremas — promueve el draft a schema_version=3', () => {
    test('draft schema2 sin datos previos -> schema3 + defaults inyectados (5 asociaciones, C1 B2 A off)', () => {
        const base = { schema_version: 2, regla_equidad_traslados_activa: true, umbral_lejania_km: 350, ordenCriterios: [{ criterio_codigo: 'EQUIDAD_TRASLADOS', orden: 1 }], distancia_maxima_km: 600 };
        const nuevo = activarZonasExtremas(base, ZE_DEFAULT);
        expect(nuevo.schema_version).toBe(3);
        expect(nuevo.regla_zonas_extremas_activa).toBe(true);
        expect(nuevo.zonas_extremas.asociaciones).toHaveLength(5);
        expect(nuevo.zonas_extremas.categorias.find(f => f.categoria === 'C')).toEqual({ categoria: 'C', elegible: true, orden_preferencia: 1 });
        expect(nuevo.zonas_extremas.categorias.find(f => f.categoria === 'B')).toEqual({ categoria: 'B', elegible: true, orden_preferencia: 2 });
        expect(nuevo.zonas_extremas.categorias.find(f => f.categoria === 'A').elegible).toBe(false);
        // Reglas previas del draft (distancia, equidad de traslados) conservadas intactas.
        expect(nuevo.regla_equidad_traslados_activa).toBe(true);
        expect(nuevo.umbral_lejania_km).toBe(350);
        expect(nuevo.distancia_maxima_km).toBe(600);
        expect(nuevo.ordenCriterios).toEqual(base.ordenCriterios);
    });
    test('nunca modifica el objeto configuracion original (versión base)', () => {
        const base = { schema_version: 2, ordenCriterios: [] };
        activarZonasExtremas(base, ZE_DEFAULT);
        expect(base.schema_version).toBe(2); // la base NUNCA se muta
        expect(base.regla_zonas_extremas_activa).toBeUndefined();
    });

    // TEST 19 explícito del pedido de revisión previa a 053: "Crear nueva
    // versión" desde la V2 REAL de producción (capturada en el precheck de
    // esta revisión: id 0ac4f340-968b-4076-9687-1b13cd358d6b, numero_
    // version=2, 1000 km, EQUIDAD_TRASLADOS orden=1, umbral 350km) y
    // activar Zonas Extremas — el draft debe CLONAR exactamente esa V2
    // (nunca partir de V1) y promover 2→3, conservando cada regla heredada.
    test('activar sobre un draft copiado de la V2 REAL de producción conserva EQUIDAD_TRASLADOS/350km/1000km/matriz y promueve 2→3', () => {
        const draftDesdeV2Real = JSON.parse(JSON.stringify({
            schema_version: 2,
            regla_distancia_maxima_activa: true, distancia_maxima_km: 1000, // V2 real: 1000, NO 600 (distinto de V1 a propósito)
            regla_no_repetir_asociacion_activa: true, regla_un_rodeo_por_finde_activa: true,
            regla_finde_consecutivo_activa: true, regla_asociacion_organizadora_activa: true,
            regla_equidad_traslados_activa: true, umbral_lejania_km: 350,
            ordenCriterios: [
                { criterio_codigo: 'EQUIDAD_TRASLADOS', orden: 1 },
                { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 2 },
                { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 3 },
                { criterio_codigo: 'MENOR_DISTANCIA', orden: 4 }
            ],
            matriz: MATRIZ_V1 // matriz normal — V2 real no la cambió respecto de V1
        }));

        const nuevo = activarZonasExtremas(draftDesdeV2Real, ZE_DEFAULT);

        expect(nuevo.schema_version).toBe(3); // promovido 2 -> 3
        // TODO lo heredado de V2 real, intacto:
        expect(nuevo.distancia_maxima_km).toBe(1000);
        expect(nuevo.regla_equidad_traslados_activa).toBe(true);
        expect(nuevo.umbral_lejania_km).toBe(350);
        expect(nuevo.ordenCriterios).toEqual(draftDesdeV2Real.ordenCriterios);
        expect(nuevo.matriz).toEqual(MATRIZ_V1);
        // Zonas Extremas recién agregado (draft no tenía datos previos -> defaults):
        expect(nuevo.regla_zonas_extremas_activa).toBe(true);
        expect(nuevo.zonas_extremas.asociaciones).toHaveLength(5);
    });
    test('sección 8: draft que YA tenía datos propios (copiado de una versión schema3 histórica) NO se sobrescribe con los defaults', () => {
        const draftHistorico = {
            schema_version: 3, regla_zonas_extremas_activa: false,
            zonas_extremas: { asociaciones: ['SOLO ESTA'], categorias: [
                { categoria: 'A', elegible: true, orden_preferencia: 1 },
                { categoria: 'B', elegible: false, orden_preferencia: null },
                { categoria: 'C', elegible: false, orden_preferencia: null }
            ] }
        };
        const nuevo = activarZonasExtremas(draftHistorico, ZE_DEFAULT);
        expect(nuevo.zonas_extremas.asociaciones).toEqual(['SOLO ESTA']); // NUNCA reemplazado por el default de 5
        expect(nuevo.zonas_extremas.categorias.find(f => f.categoria === 'A').elegible).toBe(true);
    });
});

// TEST 35 (pedido de UI): desactivar NUNCA baja el schema, y (GATE resuelto,
// sección 36) CONSERVA asociaciones/categorías en memoria.
describe('desactivarZonasExtremas — no retrocede el schema, conserva los datos (decisión documentada)', () => {
    test('regla=false, schema_version permanece 3, asociaciones/categorías intactas', () => {
        const draft3 = { schema_version: 3, regla_zonas_extremas_activa: true, zonas_extremas: ZE_DEFAULT };
        const nuevo = desactivarZonasExtremas(draft3);
        expect(nuevo.regla_zonas_extremas_activa).toBe(false);
        expect(nuevo.schema_version).toBe(3);
        expect(nuevo.zonas_extremas).toEqual(ZE_DEFAULT); // conservado, no vaciado
    });
});

// TEST 37 (pedido de UI): agregar/quitar asociación
describe('agregarAsociacionZonaExtrema / quitarAsociacionZonaExtrema', () => {
    test('agrega una asociación nueva', () => {
        const base = { zonas_extremas: { asociaciones: ['MAGALLANES'], categorias: [] } };
        const r = agregarAsociacionZonaExtrema(base, 'AYSEN');
        expect(r.agregada).toBe(true);
        expect(r.configuracion.zonas_extremas.asociaciones).toEqual(['MAGALLANES', 'AYSEN']);
    });
    test('evita duplicado EXACTO', () => {
        const base = { zonas_extremas: { asociaciones: ['MAGALLANES'], categorias: [] } };
        const r = agregarAsociacionZonaExtrema(base, 'MAGALLANES');
        expect(r.agregada).toBe(false);
        expect(r.configuracion.zonas_extremas.asociaciones).toEqual(['MAGALLANES']);
    });
    test('evita duplicado NORMALIZADO (mayúsculas/tildes/espacios distintos — sección 12)', () => {
        const base = { zonas_extremas: { asociaciones: ['MAGALLANES'], categorias: [] } };
        expect(agregarAsociacionZonaExtrema(base, 'magallanes').agregada).toBe(false);
        expect(agregarAsociacionZonaExtrema(base, '  Magallanes  ').agregada).toBe(false);
        const base2 = { zonas_extremas: { asociaciones: ['AYSEN'], categorias: [] } };
        expect(agregarAsociacionZonaExtrema(base2, 'Aysén').agregada).toBe(false);
    });
    test('quita una asociación — no toca las demás ni ningún otro campo', () => {
        const base = { zonas_extremas: { asociaciones: ['MAGALLANES', 'AYSEN', 'CUYO'], categorias: [{ categoria: 'C', elegible: true, orden_preferencia: 1 }] } };
        const nuevo = quitarAsociacionZonaExtrema(base, 'AYSEN');
        expect(nuevo.zonas_extremas.asociaciones).toEqual(['MAGALLANES', 'CUYO']);
        expect(nuevo.zonas_extremas.categorias).toEqual(base.zonas_extremas.categorias);
    });
    test('_normalizarAsociacionUI — mismo comportamiento conceptual que normalizarAsociacion() del backend', () => {
        expect(_normalizarAsociacionUI('MAGALLANES')).toBe(_normalizarAsociacionUI('magallanes'));
        expect(_normalizarAsociacionUI('Aysén')).toBe(_normalizarAsociacionUI('AYSEN'));
        expect(_normalizarAsociacionUI('Asociación Ñuble')).toBe(_normalizarAsociacionUI('  ñuble  '));
    });
});

// TEST 38 (pedido de UI): categorías — reutiliza activarCategoria/
// desactivarCategoria/moverCategoria (MISMAS funciones que la matriz normal,
// sección 15/16/17 del pedido de motor: mismo modelo, sin duplicar lógica).
describe('categorías de Zona Extrema — reutiliza activarCategoria/desactivarCategoria/moverCategoria', () => {
    test('C/B default -> habilitar A la agrega al FINAL del orden (1 C, 2 B, 3 A)', () => {
        const categorias = ZE_DEFAULT.categorias.map(f => ({ ...f }));
        const conA = activarCategoria(categorias, 'A');
        const porCat = Object.fromEntries(conA.map(f => [f.categoria, f]));
        expect(porCat.A).toEqual({ categoria: 'A', elegible: true, orden_preferencia: 3 });
        expect(porCat.C.orden_preferencia).toBe(1);
        expect(porCat.B.orden_preferencia).toBe(2);
    });
    test('mover A hacia arriba después de habilitarla la reordena', () => {
        const categorias = ZE_DEFAULT.categorias.map(f => ({ ...f }));
        let conA = activarCategoria(categorias, 'A'); // 1C 2B 3A
        conA = moverCategoria(conA, 'A', 'arriba');    // 1C 2A 3B
        const porCat = Object.fromEntries(conA.map(f => [f.categoria, f]));
        expect(porCat.A.orden_preferencia).toBe(2);
        expect(porCat.B.orden_preferencia).toBe(3);
    });
    test('deshabilitar B renumera correctamente (queda solo C=1)', () => {
        const categorias = ZE_DEFAULT.categorias.map(f => ({ ...f }));
        const sinB = desactivarCategoria(categorias, 'B');
        const porCat = Object.fromEntries(sinB.map(f => [f.categoria, f]));
        expect(porCat.B).toEqual({ categoria: 'B', elegible: false, orden_preferencia: null });
        expect(porCat.C.orden_preferencia).toBe(1);
    });
    test('nunca permite 0 categorías elegibles (última categoría no se puede desactivar)', () => {
        const soloC = [
            { categoria: 'A', elegible: false, orden_preferencia: null },
            { categoria: 'B', elegible: false, orden_preferencia: null },
            { categoria: 'C', elegible: true, orden_preferencia: 1 }
        ];
        const resultado = desactivarCategoria(soloC, 'C');
        expect(resultado).toEqual(soloC); // sin cambios — el llamador (UI) debe avisar, nunca queda en 0
    });
});

// TEST 39/40: validarDraft + construirDiffParaUI para Zonas Extremas
describe('validarDraft — Zonas Extremas', () => {
    test('schema_version=3 sin la regla activa es válido', () => {
        const c = configV1();
        c.schema_version = 3;
        expect(validarDraft(c)).toEqual({ valido: true });
    });
    test('regla activa + 0 asociaciones -> inválido', () => {
        const c = configV1();
        c.schema_version = 3; c.regla_zonas_extremas_activa = true;
        c.zonas_extremas = { asociaciones: [], categorias: ZE_DEFAULT.categorias };
        expect(validarDraft(c).valido).toBe(false);
    });
    test('regla activa + 0 categorías elegibles -> inválido', () => {
        const c = configV1();
        c.schema_version = 3; c.regla_zonas_extremas_activa = true;
        c.zonas_extremas = { asociaciones: ['MAGALLANES'], categorias: [
            { categoria: 'A', elegible: false, orden_preferencia: null },
            { categoria: 'B', elegible: false, orden_preferencia: null },
            { categoria: 'C', elegible: false, orden_preferencia: null }
        ] };
        expect(validarDraft(c).valido).toBe(false);
    });
    test('schema_version=1/2 con regla_zonas_extremas_activa=true -> inválido', () => {
        const c = configV1(); // schema_version=1
        c.regla_zonas_extremas_activa = true;
        c.zonas_extremas = ZE_DEFAULT;
        expect(validarDraft(c).valido).toBe(false);
    });
    test('schema_version=3 con EQUIDAD_TRASLADOS activa también es válido (ortogonales — corrección del bug de "!== 2")', () => {
        const c = configV1();
        c.schema_version = 3;
        c.regla_equidad_traslados_activa = true;
        c.umbral_lejania_km = 350;
        c.ordenCriterios = [{ criterio_codigo: 'EQUIDAD_TRASLADOS', orden: 1 }, ...ORDEN_CRITERIOS_V1.map(o => ({ ...o, orden: o.orden + 1 }))];
        expect(validarDraft(c)).toEqual({ valido: true });
    });
});

describe('construirDiffParaUI — Zonas Extremas (sección 21/40)', () => {
    test('schema2 -> schema3 con Zonas Extremas ON: Schema/Zonas Extremas/Asociaciones/Prioridad aparecen en el diff', () => {
        const base = configV1();
        base.schema_version = 2;
        const nueva = activarZonasExtremas(base, ZE_DEFAULT);
        const diff = construirDiffParaUI(base, nueva);
        const porEtiqueta = Object.fromEntries(diff.cambios.map(c => [c.etiqueta, c]));
        expect(porEtiqueta['Schema']).toEqual({ etiqueta: 'Schema', antes: '2', despues: '3' });
        expect(porEtiqueta['Zonas Extremas']).toEqual({ etiqueta: 'Zonas Extremas', antes: 'Desactivada', despues: 'Activada' });
        expect(porEtiqueta['Asociaciones Zona Extrema'].despues).toContain('MAGALLANES');
        expect(porEtiqueta['Prioridad Zona Extrema']).toEqual({ etiqueta: 'Prioridad Zona Extrema', antes: '—', despues: 'C→B' });
    });
    test('quitar CUYO produce un diff de Asociaciones Zona Extrema', () => {
        const base = { zonas_extremas: { asociaciones: ['MAGALLANES', 'AYSEN', 'CUYO'], categorias: ZE_DEFAULT.categorias } };
        const nueva = quitarAsociacionZonaExtrema(base, 'CUYO');
        const diff = construirDiffParaUI(base, nueva);
        const fila = diff.cambios.find(c => c.etiqueta === 'Asociaciones Zona Extrema');
        expect(fila.despues).not.toContain('CUYO');
    });
    test('habilitar A produce un diff de Prioridad Zona Extrema (C→B pasa a C→B→A)', () => {
        const base = { zonas_extremas: ZE_DEFAULT };
        const nueva = { zonas_extremas: { asociaciones: ZE_DEFAULT.asociaciones, categorias: activarCategoria(ZE_DEFAULT.categorias, 'A') } };
        const diff = construirDiffParaUI(base, nueva);
        const fila = diff.cambios.find(c => c.etiqueta === 'Prioridad Zona Extrema');
        expect(fila).toEqual({ etiqueta: 'Prioridad Zona Extrema', antes: 'C→B', despues: 'C→B→A' });
    });
});
