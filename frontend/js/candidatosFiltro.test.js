const {
    normalizarBusquedaCandidato, obtenerAsociacionesCandidatos, compararCandidatos,
    esNoDisponible, esYaDesignado, esRepiteAsociacionTemporada, filtrarYOrdenarCandidatos
} = require('./candidatosFiltro');

// Fixtures — misma forma que devuelven GET/POST .../candidatos (backend)
const validoA = { jurado_id: 'a', nombre: 'Ana Soto', categoria: 'A', categoria_preferente: true, asociacion: 'Ñuble', comuna_nombre: 'Chillán', distancia_km: 40, designaciones_antes: 3, causas: [], uso_en_otra_fila: [] };
const validoB = { jurado_id: 'b', nombre: 'Bruno Reyes', categoria: 'B', categoria_preferente: false, asociacion: 'Bío-Bío', comuna_nombre: 'Los Ángeles', distancia_km: 80, designaciones_antes: 1, causas: [], uso_en_otra_fila: [] };
const validoC = { jurado_id: 'c', nombre: 'Carla Vidal', categoria: 'A', categoria_preferente: true, asociacion: 'Río Bío-Bío', comuna_nombre: 'Concepción', distancia_km: 40, designaciones_antes: 1, causas: [], uso_en_otra_fila: [] };

const descNoDisp = { jurado_id: 'd', nombre: 'Diego Muñoz', categoria: 'A', asociacion: 'Ñuble', comuna_nombre: 'Chillán', distancia_km: 20, designaciones_antes: 0, causas: ['DISPONIBILIDAD'], causa_principal: 'DISPONIBILIDAD', uso_en_otra_fila: [] };
const descMismoFinde = { jurado_id: 'e', nombre: 'Elena Paz', categoria: 'A', asociacion: 'Ñuble', comuna_nombre: 'Chillán', distancia_km: 10, designaciones_antes: 0, causas: ['MISMO_FINDE'], causa_principal: 'MISMO_FINDE', uso_en_otra_fila: [] };
const descRepiteAsoc = { jurado_id: 'f', nombre: 'Felipe Ruz', categoria: 'A', asociacion: 'Ñuble', comuna_nombre: 'Chillán', distancia_km: 15, designaciones_antes: 2, causas: ['ASOCIACION_REPETIDA_TEMPORADA'], causa_principal: 'ASOCIACION_REPETIDA_TEMPORADA', uso_en_otra_fila: [] };
const descMismaAsoc = { jurado_id: 'g', nombre: 'Gonzalo Ibáñez', categoria: 'A', asociacion: 'Ñuble', comuna_nombre: 'Chillán', distancia_km: 5, designaciones_antes: 0, causas: ['MISMA_ASOCIACION'], causa_principal: 'MISMA_ASOCIACION', uso_en_otra_fila: [] };
const validoUsadoEnOtraFila = { jurado_id: 'h', nombre: 'Hugo Peña', categoria: 'A', asociacion: 'Ñuble', comuna_nombre: 'Chillán', distancia_km: 25, designaciones_antes: 0, causas: [], uso_en_otra_fila: [{ tipo: 'YA_USADO_EN_PROPUESTA', club: 'Otro Club', fecha: '2026-10-01' }] };

describe('normalizarBusquedaCandidato', () => {
    test('minúsculas y sin tildes', () => {
        expect(normalizarBusquedaCandidato('FRANCISCO ÁÑEZ')).toBe('francisco anez');
    });
    test('valor vacío/null → cadena vacía', () => {
        expect(normalizarBusquedaCandidato(null)).toBe('');
        expect(normalizarBusquedaCandidato(undefined)).toBe('');
    });
});

describe('obtenerAsociacionesCandidatos — sin fusionar (sección 7)', () => {
    test('BÍO-BÍO y RÍO BÍO-BÍO quedan como valores distintos', () => {
        const asociaciones = obtenerAsociacionesCandidatos([validoA, validoB, validoC], []);
        expect(asociaciones).toContain('Bío-Bío');
        expect(asociaciones).toContain('Río Bío-Bío');
        expect(asociaciones.filter(a => a === 'Bío-Bío' || a === 'Río Bío-Bío').length).toBe(2);
    });
    test('sin duplicados, ordenadas alfabéticamente', () => {
        const otroConMismaAsociacionQueA = { ...validoB, jurado_id: 'z', asociacion: validoA.asociacion }; // repite 'Ñuble'
        const asociaciones = obtenerAsociacionesCandidatos([validoA, validoB, validoC, otroConMismaAsociacionQueA], []);
        expect(asociaciones).toEqual(['Bío-Bío', 'Ñuble', 'Río Bío-Bío'].sort((a, b) => a.localeCompare(b)));
        expect(asociaciones.length).toBe(3); // 'Ñuble' aparece una sola vez pese a repetirse en dos candidatos
    });
});

// TEST A/B del pedido
describe('compararCandidatos / orden por defecto', () => {
    test('TEST A: orden menor→mayor designaciones (por defecto)', () => {
        // a=3 designaciones, b=1, c=1 → b y c primero (empatados), a al final.
        // Entre b y c (empate en designaciones): desempate por distancia — b=80km, c=40km → c antes que b.
        const r = filtrarYOrdenarCandidatos([validoA, validoB, validoC], [], {});
        expect(r.validos.map(c => c.jurado_id)).toEqual(['c', 'b', 'a']);
    });

    test('TEST B: empate en designaciones → desempata por menor distancia', () => {
        const x = { jurado_id: 'x', nombre: 'X', designaciones_antes: 2, distancia_km: 100, causas: [] };
        const y = { jurado_id: 'y', nombre: 'Y', designaciones_antes: 2, distancia_km: 30, causas: [] };
        const r = filtrarYOrdenarCandidatos([x, y], [], {});
        expect(r.validos.map(c => c.jurado_id)).toEqual(['y', 'x']);
    });

    test('empate en designaciones y distancia → desempata por nombre', () => {
        const x = { jurado_id: 'x', nombre: 'Zorro', designaciones_antes: 1, distancia_km: 10, causas: [] };
        const y = { jurado_id: 'y', nombre: 'Andes', designaciones_antes: 1, distancia_km: 10, causas: [] };
        const r = filtrarYOrdenarCandidatos([x, y], [], {});
        expect(r.validos.map(c => c.jurado_id)).toEqual(['y', 'x']);
    });

    test('ordenarPor=distancia ordena por distancia primero', () => {
        const r = filtrarYOrdenarCandidatos([validoB, validoA], [], { ordenarPor: 'distancia' });
        expect(r.validos.map(c => c.jurado_id)).toEqual(['a', 'b']); // a=40km, b=80km
    });

    test('ordenarPor=nombre ordena alfabéticamente', () => {
        const r = filtrarYOrdenarCandidatos([validoB, validoA], [], { ordenarPor: 'nombre' });
        expect(r.validos.map(c => c.jurado_id)).toEqual(['a', 'b']); // Ana < Bruno
    });

    test('nunca usa random — dos llamadas con los mismos datos dan el mismo resultado', () => {
        const r1 = filtrarYOrdenarCandidatos([validoA, validoB, validoC], [], {});
        const r2 = filtrarYOrdenarCandidatos([validoA, validoB, validoC], [], {});
        expect(r1.validos.map(c => c.jurado_id)).toEqual(r2.validos.map(c => c.jurado_id));
    });
});

// TEST C/D
describe('filtro categoría y asociación', () => {
    test('TEST C: filtro categoría', () => {
        const r = filtrarYOrdenarCandidatos([validoA, validoB, validoC], [], { categoria: 'B' });
        expect(r.validos.map(c => c.jurado_id)).toEqual(['b']);
    });

    test('TEST D: filtro asociación — no fusiona Bío-Bío con Río Bío-Bío', () => {
        const r1 = filtrarYOrdenarCandidatos([validoB, validoC], [], { asociacion: 'Bío-Bío' });
        expect(r1.validos.map(c => c.jurado_id)).toEqual(['b']);
        const r2 = filtrarYOrdenarCandidatos([validoB, validoC], [], { asociacion: 'Río Bío-Bío' });
        expect(r2.validos.map(c => c.jurado_id)).toEqual(['c']);
    });
});

// TEST E/F/G
describe('filtros ocultar (E/F/G)', () => {
    test('TEST E: ocultar no disponibles — solo causa DISPONIBILIDAD', () => {
        const r = filtrarYOrdenarCandidatos([], [descNoDisp, descMismoFinde], { ocultarNoDisponibles: true });
        expect(r.descartados.map(c => c.jurado_id)).toEqual(['e']);
    });

    test('TEST F: ocultar ya designados — MISMO_FINDE/FINDE_CONSECUTIVO y uso_en_otra_fila', () => {
        const r = filtrarYOrdenarCandidatos([validoUsadoEnOtraFila], [descMismoFinde, descNoDisp], { ocultarYaDesignados: true });
        expect(r.validos).toEqual([]); // Hugo tenía uso_en_otra_fila → oculto
        expect(r.descartados.map(c => c.jurado_id)).toEqual(['d']); // Diego (sin disponibilidad) queda, Elena (mismo finde) se oculta
    });

    test('TEST F: no oculta por designaciones históricas de temporada (solo conflicto ACTUAL)', () => {
        const r = filtrarYOrdenarCandidatos([validoA], [], { ocultarYaDesignados: true }); // validoA tiene 3 designaciones_antes, sin causas ni uso_en_otra_fila
        expect(r.validos.map(c => c.jurado_id)).toEqual(['a']);
    });

    test('TEST G: ocultar repetición de asociación — solo ASOCIACION_REPETIDA_TEMPORADA, nunca MISMA_ASOCIACION', () => {
        const r = filtrarYOrdenarCandidatos([], [descRepiteAsoc, descMismaAsoc], { ocultarRepeticionAsociacion: true });
        expect(r.descartados.map(c => c.jurado_id)).toEqual(['g']); // Gonzalo (MISMA_ASOCIACION) permanece
    });
});

// TEST H
describe('TEST H: combinar múltiples filtros', () => {
    test('categoría + búsqueda + ocultar no disponibles combinados', () => {
        const r = filtrarYOrdenarCandidatos(
            [validoA, validoB, validoC],
            [descNoDisp],
            { categoria: 'A', busqueda: 'ana', ocultarNoDisponibles: true }
        );
        expect(r.validos.map(c => c.jurado_id)).toEqual(['a']); // Carla es cat A pero no matchea "ana"
        expect(r.descartados).toEqual([]); // Diego es cat A pero se oculta por DISPONIBILIDAD
    });
});

// TEST I
describe('TEST I: limpiar filtros vuelve a la lista completa', () => {
    test('opciones vacías (equivalente a "limpiar filtros") devuelve todos los candidatos, solo ordenados', () => {
        const validos = [validoA, validoB, validoC];
        const descartados = [descNoDisp, descMismoFinde, descRepiteAsoc];
        const r = filtrarYOrdenarCandidatos(validos, descartados, {});
        expect(r.validos.length).toBe(validos.length);
        expect(r.descartados.length).toBe(descartados.length);
    });
});

// TEST J
describe('TEST J: candidato con advertencias conserva sus datos para el botón de excepción', () => {
    test('causas y demás campos no se pierden ni se alteran al filtrar/ordenar', () => {
        const r = filtrarYOrdenarCandidatos([], [descNoDisp], {});
        expect(r.descartados[0]).toEqual(descNoDisp); // mismo objeto, sin mutar ni despojar campos
    });
});

describe('esNoDisponible / esYaDesignado / esRepiteAsociacionTemporada', () => {
    test('clasificación individual de causas', () => {
        expect(esNoDisponible(descNoDisp)).toBe(true);
        expect(esNoDisponible(descMismoFinde)).toBe(false);
        expect(esYaDesignado(descMismoFinde)).toBe(true);
        expect(esYaDesignado(validoUsadoEnOtraFila)).toBe(true);
        expect(esYaDesignado(validoA)).toBe(false);
        expect(esRepiteAsociacionTemporada(descRepiteAsoc)).toBe(true);
        expect(esRepiteAsociacionTemporada(descMismaAsoc)).toBe(false);
    });
});
