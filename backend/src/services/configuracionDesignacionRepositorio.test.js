// ═════════════════════════════════════════════════════════════════════════
// Tests de configuracionDesignacionRepositorio.js (Etapa 3).
//
// Este es el PRIMER archivo del proyecto que testea una capa de acceso a
// datos (todo lo demás testeado hasta ahora es puro, sin BD). Se usa
// jest.mock() sobre backend/src/config/supabase — el patrón estándar de
// Jest para aislar la unidad bajo prueba (el repositorio: qué consulta,
// cómo reconstruye, cómo falla) de una base de datos real, sin necesitar
// una conexión Supabase real ni escribir datos de prueba en producción
// (bloqueado explícitamente en este proyecto — ver memoria de sesiones
// anteriores). El mock simula fielmente la forma encadenable de
// supabase-js (.from().select().eq() → thenable) para que el código real
// del repositorio se ejecute sin cambios.
// ═════════════════════════════════════════════════════════════════════════
jest.mock('../config/supabase', () => ({ from: jest.fn() }));
const supabase = require('../config/supabase');
const { cargarConfiguracionDesignacionActiva, cargarConfiguracionDesignacionPorId } = require('./configuracionDesignacionRepositorio');

// ─── Fixtures — mismas filas reales verificadas en BD para V1 ─────────────
const VERSION_V1 = {
    id: 'v1-uuid', numero_version: 1, schema_version: 1,
    regla_distancia_maxima_activa: true, distancia_maxima_km: '600',
    regla_no_repetir_asociacion_activa: true, regla_un_rodeo_por_finde_activa: true,
    regla_finde_consecutivo_activa: true, regla_asociacion_organizadora_activa: true
};
const CRITERIOS_V1 = [
    { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 },
    { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 2 },
    { criterio_codigo: 'MENOR_DISTANCIA', orden: 3 }
];
function matrizV1Completa() {
    const clasif = { interclubes: ['C', 'B', 'A'], provincial: ['B', 'A', 'C'], interasociaciones: ['A', 'B', 'C'], zonal: ['A', 'B', 'C'], clasificatorio: ['A', 'B', 'C'], nacional: ['A', 'B', 'C'] };
    const elegibles = { interclubes: new Set(['B', 'C']), provincial: new Set(['A', 'B']), interasociaciones: new Set(['A', 'B']), zonal: new Set(['A', 'B']), clasificatorio: new Set(['A', 'B']), nacional: new Set(['A']) };
    const filas = [];
    for (const [codigo, categorias] of Object.entries(clasif)) {
        let orden = 1;
        // Orden estable: primero las elegibles en un orden razonable, luego las no elegibles.
        const elegiblesOrdenadas = categorias.filter(c => elegibles[codigo].has(c));
        const noElegibles = categorias.filter(c => !elegibles[codigo].has(c));
        for (const cat of elegiblesOrdenadas) filas.push({ clasificacion_codigo: codigo, categoria: cat, elegible: true, orden_preferencia: orden++ });
        for (const cat of noElegibles) filas.push({ clasificacion_codigo: codigo, categoria: cat, elegible: false, orden_preferencia: null });
    }
    return filas;
}
const MATRIZ_V1 = matrizV1Completa();

// ─── Mock de Supabase: simula .from(tabla).select(...).eq(...) → thenable ─
// `porTabla` mapea nombre de tabla → { data, error } que debe resolver ESA
// tabla en esta llamada. select()/eq() devuelven la misma cadena (siguen
// siendo encadenables); el await final dispara `.then`.
function mockSupabaseRespuestas(porTabla) {
    supabase.from.mockImplementation((tabla) => {
        const respuesta = porTabla[tabla] !== undefined ? porTabla[tabla] : { data: [], error: null };
        const chain = {
            select: () => chain,
            eq: () => chain,
            then: (resolve, reject) => Promise.resolve(respuesta).then(resolve, reject)
        };
        return chain;
    });
}

beforeEach(() => {
    supabase.from.mockReset();
});

// TEST A
describe('TEST A: cargarConfiguracionDesignacionActiva — carga activa válida', () => {
    test('reconstruye y valida correctamente la Versión 1 activa', async () => {
        mockSupabaseRespuestas({
            configuracion_designacion_versiones: { data: [VERSION_V1], error: null },
            configuracion_designacion_orden_criterios: { data: CRITERIOS_V1, error: null },
            configuracion_designacion_matriz: { data: MATRIZ_V1, error: null }
        });
        const resultado = await cargarConfiguracionDesignacionActiva();
        expect(resultado.error).toBeUndefined();
        expect(resultado.configuracion.regla_distancia_maxima_activa).toBe(true);
        expect(resultado.configuracion.distancia_maxima_km).toBe(600);
        expect(resultado.meta).toEqual({ id: 'v1-uuid', numero_version: 1, schema_version: 1 });
    });
});

// TEST B
describe('TEST B: cargarConfiguracionDesignacionPorId — carga por ID válida', () => {
    test('reconstruye y valida correctamente por id, sin exigir activa=true', async () => {
        mockSupabaseRespuestas({
            configuracion_designacion_versiones: { data: [{ ...VERSION_V1 }], error: null },
            configuracion_designacion_orden_criterios: { data: CRITERIOS_V1, error: null },
            configuracion_designacion_matriz: { data: MATRIZ_V1, error: null }
        });
        const resultado = await cargarConfiguracionDesignacionPorId('v1-uuid');
        expect(resultado.error).toBeUndefined();
        expect(resultado.meta.id).toBe('v1-uuid');
    });
});

// TEST C
describe('TEST C: versión INACTIVA por ID sigue siendo válida', () => {
    test('cargarConfiguracionDesignacionPorId no filtra por activa', async () => {
        const versionInactiva = { ...VERSION_V1, id: 'v-historica', numero_version: 3 };
        mockSupabaseRespuestas({
            configuracion_designacion_versiones: { data: [versionInactiva], error: null },
            configuracion_designacion_orden_criterios: { data: CRITERIOS_V1, error: null },
            configuracion_designacion_matriz: { data: MATRIZ_V1, error: null }
        });
        const resultado = await cargarConfiguracionDesignacionPorId('v-historica');
        expect(resultado.error).toBeUndefined();
        expect(resultado.meta.numero_version).toBe(3);
    });
});

// TEST D
describe('TEST D: 0 activas — falla cerrado, nunca ejecuta el motor', () => {
    test('cargarConfiguracionDesignacionActiva devuelve CONFIGURACION_DESIGNACION_NO_RESUELTA', async () => {
        mockSupabaseRespuestas({ configuracion_designacion_versiones: { data: [], error: null } });
        const resultado = await cargarConfiguracionDesignacionActiva();
        expect(resultado.error).toBe('CONFIGURACION_DESIGNACION_NO_RESUELTA');
        expect(resultado.configuracion).toBeUndefined();
    });
    test('más de 1 activa (corrupción hipotética) también falla cerrado, nunca elige arbitrariamente', async () => {
        mockSupabaseRespuestas({ configuracion_designacion_versiones: { data: [VERSION_V1, { ...VERSION_V1, id: 'otra' }], error: null } });
        const resultado = await cargarConfiguracionDesignacionActiva();
        expect(resultado.error).toBe('CONFIGURACION_DESIGNACION_NO_RESUELTA');
    });
});

// TEST E
describe('TEST E: versión inexistente por ID', () => {
    test('cargarConfiguracionDesignacionPorId devuelve CONFIGURACION_DESIGNACION_NO_RESUELTA', async () => {
        mockSupabaseRespuestas({ configuracion_designacion_versiones: { data: [], error: null } });
        const resultado = await cargarConfiguracionDesignacionPorId('id-que-no-existe');
        expect(resultado.error).toBe('CONFIGURACION_DESIGNACION_NO_RESUELTA');
    });
    test('versionId ausente o no-string se rechaza sin siquiera consultar BD', async () => {
        const resultado1 = await cargarConfiguracionDesignacionPorId(null);
        const resultado2 = await cargarConfiguracionDesignacionPorId(undefined);
        expect(resultado1.error).toBe('CONFIGURACION_DESIGNACION_NO_RESUELTA');
        expect(resultado2.error).toBe('CONFIGURACION_DESIGNACION_NO_RESUELTA');
        expect(supabase.from).not.toHaveBeenCalled();
    });
});

// TEST F
describe('TEST F: schema_version no soportado — inválida, nunca fallback silencioso', () => {
    test('CONFIGURACION_DESIGNACION_INVALIDA si schema_version no es 1', async () => {
        mockSupabaseRespuestas({
            configuracion_designacion_versiones: { data: [{ ...VERSION_V1, schema_version: 2 }], error: null },
            configuracion_designacion_orden_criterios: { data: CRITERIOS_V1, error: null },
            configuracion_designacion_matriz: { data: MATRIZ_V1, error: null }
        });
        const resultado = await cargarConfiguracionDesignacionActiva();
        expect(resultado.error).toBe('CONFIGURACION_DESIGNACION_INVALIDA');
        expect(resultado.configuracion).toBeUndefined();
    });
});

// TEST G
describe('TEST G: criterios incompletos (0 activos) — inválida', () => {
    test('CONFIGURACION_DESIGNACION_INVALIDA si no hay ningún criterio de ranking', async () => {
        mockSupabaseRespuestas({
            configuracion_designacion_versiones: { data: [VERSION_V1], error: null },
            configuracion_designacion_orden_criterios: { data: [], error: null },
            configuracion_designacion_matriz: { data: MATRIZ_V1, error: null }
        });
        const resultado = await cargarConfiguracionDesignacionActiva();
        expect(resultado.error).toBe('CONFIGURACION_DESIGNACION_INVALIDA');
    });
});

// TEST H
describe('TEST H: matriz incompleta — inválida', () => {
    test('CONFIGURACION_DESIGNACION_INVALIDA si falta una clasificación', async () => {
        const matrizIncompleta = MATRIZ_V1.filter(f => f.clasificacion_codigo !== 'nacional');
        mockSupabaseRespuestas({
            configuracion_designacion_versiones: { data: [VERSION_V1], error: null },
            configuracion_designacion_orden_criterios: { data: CRITERIOS_V1, error: null },
            configuracion_designacion_matriz: { data: matrizIncompleta, error: null }
        });
        const resultado = await cargarConfiguracionDesignacionActiva();
        expect(resultado.error).toBe('CONFIGURACION_DESIGNACION_INVALIDA');
    });
});

// TEST I
describe('TEST I: distancia inválida — inválida', () => {
    test('CONFIGURACION_DESIGNACION_INVALIDA si distancia_maxima_km <= 0 con la regla activa', async () => {
        mockSupabaseRespuestas({
            configuracion_designacion_versiones: { data: [{ ...VERSION_V1, distancia_maxima_km: '0' }], error: null },
            configuracion_designacion_orden_criterios: { data: CRITERIOS_V1, error: null },
            configuracion_designacion_matriz: { data: MATRIZ_V1, error: null }
        });
        const resultado = await cargarConfiguracionDesignacionActiva();
        expect(resultado.error).toBe('CONFIGURACION_DESIGNACION_INVALIDA');
    });
});

// TEST J
describe('TEST J: cantidad fija de consultas — sin N+1', () => {
    test('cargarConfiguracionDesignacionActiva hace exactamente 3 llamadas a supabase.from(), sin importar el tamaño de la matriz/criterios', async () => {
        mockSupabaseRespuestas({
            configuracion_designacion_versiones: { data: [VERSION_V1], error: null },
            configuracion_designacion_orden_criterios: { data: CRITERIOS_V1, error: null },
            configuracion_designacion_matriz: { data: MATRIZ_V1, error: null }
        });
        await cargarConfiguracionDesignacionActiva();
        expect(supabase.from).toHaveBeenCalledTimes(3);
        expect(supabase.from.mock.calls.map(c => c[0]).sort()).toEqual([
            'configuracion_designacion_matriz', 'configuracion_designacion_orden_criterios', 'configuracion_designacion_versiones'
        ]);
    });
    test('cargarConfiguracionDesignacionPorId también hace exactamente 3 llamadas', async () => {
        mockSupabaseRespuestas({
            configuracion_designacion_versiones: { data: [VERSION_V1], error: null },
            configuracion_designacion_orden_criterios: { data: CRITERIOS_V1, error: null },
            configuracion_designacion_matriz: { data: MATRIZ_V1, error: null }
        });
        await cargarConfiguracionDesignacionPorId('v1-uuid');
        expect(supabase.from).toHaveBeenCalledTimes(3);
    });
});

// ─── Mock con FILTRO real por columna — a diferencia de mockSupabaseRespuestas
// (que ignora los valores de .eq() y solo mira la tabla), este simula un
// escenario con MÁS DE UNA fila en configuracion_designacion_versiones,
// filtrando de verdad por 'id' o 'activa' como haría Postgres, y por
// 'version_id' en criterios/matriz — necesario para el escenario central de
// abajo (sección 21/38), donde deben coexistir una V1 histórica y una V2
// activa en el mismo mock.
function mockSupabaseConFiltro({ versiones, criteriosPorVersionId, matrizPorVersionId }) {
    supabase.from.mockImplementation((tabla) => {
        if (tabla === 'configuracion_designacion_versiones') {
            const filtro = {};
            const chain = {
                select: () => chain,
                eq: (campo, valor) => { filtro[campo] = valor; return chain; },
                then: (resolve, reject) => {
                    const data = versiones.filter(v => Object.entries(filtro).every(([k, val]) => v[k] === val));
                    return Promise.resolve({ data, error: null }).then(resolve, reject);
                }
            };
            return chain;
        }
        if (tabla === 'configuracion_designacion_orden_criterios' || tabla === 'configuracion_designacion_matriz') {
            const fuente = tabla === 'configuracion_designacion_orden_criterios' ? criteriosPorVersionId : matrizPorVersionId;
            let versionId;
            const chain = {
                select: () => chain,
                eq: (campo, valor) => { if (campo === 'version_id') versionId = valor; return chain; },
                then: (resolve, reject) => Promise.resolve({ data: fuente[versionId] || [], error: null }).then(resolve, reject)
            };
            return chain;
        }
        const chainVacio = { select: () => chainVacio, eq: () => chainVacio, then: (resolve) => Promise.resolve({ data: [], error: null }).then(resolve) };
        return chainVacio;
    });
}

// ═════════════════════════════════════════════════════════════════════════
// ESCENARIO CENTRAL DE ETAPA 3 (sección 21/38 del pedido): "V1 activa,
// se genera un preview/borrador con V1 (queda atado a V1 por su id); más
// tarde otro administrador activa V2; el preview/borrador YA GENERADO debe
// seguir usando V1 para siempre — nunca cambiar de reglas en silencio."
//
// Este test NUNCA crea una V2 real en Supabase (prohibido explícitamente) —
// V2 existe únicamente como fixture de este test, vía el mock. Se prueba en
// la capa de repositorio (el mecanismo real del que dependen las rutas
// /preview/candidatos, /preview/seleccionar y el borrador persistido: todas
// resuelven su configuración llamando a cargarConfiguracionDesignacionPorId
// con el id ya fijado — nunca a cargarConfiguracionDesignacionActiva) porque
// no existe infraestructura de tests de integración sobre las rutas en este
// proyecto (ningún archivo de rutas tiene tests directos hoy).
// ═════════════════════════════════════════════════════════════════════════
describe('ESCENARIO CENTRAL: V1 → V2 — un preview/borrador atado a V1 no se ve afectado cuando V2 se activa después', () => {
    test('cargarConfiguracionDesignacionPorId(v1) sigue devolviendo V1 aunque V2 ya sea la activa; cargarConfiguracionDesignacionActiva() ahora resuelve V2', async () => {
        const V1_YA_NO_ACTIVA = { ...VERSION_V1, activa: false };
        const V2_ACTIVA = { ...VERSION_V1, id: 'v2-uuid', numero_version: 2, activa: true };
        mockSupabaseConFiltro({
            versiones: [V1_YA_NO_ACTIVA, V2_ACTIVA],
            criteriosPorVersionId: { 'v1-uuid': CRITERIOS_V1, 'v2-uuid': CRITERIOS_V1 },
            matrizPorVersionId: { 'v1-uuid': MATRIZ_V1, 'v2-uuid': MATRIZ_V1 }
        });

        // El preview/borrador ya tiene su configuracion_version_id firmado/
        // persistido ('v1-uuid') — lo pide POR ID, nunca por "la activa".
        const resueltoPorPreview = await cargarConfiguracionDesignacionPorId('v1-uuid');
        expect(resueltoPorPreview.error).toBeUndefined();
        expect(resueltoPorPreview.meta.id).toBe('v1-uuid');
        expect(resueltoPorPreview.meta.numero_version).toBe(1);

        // Una simulación NUEVA (sin preview/borrador previo, ej. un dry-run
        // recién iniciado) resuelve la activa — que ahora es V2, nunca V1.
        const resueltoNuevaSimulacion = await cargarConfiguracionDesignacionActiva();
        expect(resueltoNuevaSimulacion.error).toBeUndefined();
        expect(resueltoNuevaSimulacion.meta.id).toBe('v2-uuid');
        expect(resueltoNuevaSimulacion.meta.numero_version).toBe(2);

        // Volver a pedir V1 por id una segunda vez (ej. el admin reabre el
        // mismo borrador) da exactamente el mismo resultado — nada cambió.
        const resueltoPorPreviewOtraVez = await cargarConfiguracionDesignacionPorId('v1-uuid');
        expect(resueltoPorPreviewOtraVez.meta.id).toBe('v1-uuid');
        expect(resueltoPorPreviewOtraVez.meta.numero_version).toBe(1);
    });
});

// ─── Errores de conexión/consulta propagan como excepción (no se ocultan) ─
describe('errores de la propia consulta se propagan (no se convierten en un CONFIGURACION_DESIGNACION_NO_RESUELTA engañoso)', () => {
    test('error en la consulta de versiones lanza excepción', async () => {
        mockSupabaseRespuestas({ configuracion_designacion_versiones: { data: null, error: { message: 'timeout' } } });
        await expect(cargarConfiguracionDesignacionActiva()).rejects.toThrow(/No se pudo cargar/);
    });
    test('error en la consulta de criterios lanza excepción', async () => {
        mockSupabaseRespuestas({
            configuracion_designacion_versiones: { data: [VERSION_V1], error: null },
            configuracion_designacion_orden_criterios: { data: null, error: { message: 'timeout' } },
            configuracion_designacion_matriz: { data: MATRIZ_V1, error: null }
        });
        await expect(cargarConfiguracionDesignacionActiva()).rejects.toThrow(/orden de criterios/);
    });
});
