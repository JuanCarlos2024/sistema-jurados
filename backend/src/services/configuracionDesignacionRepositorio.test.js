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
jest.mock('../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
const supabase = require('../config/supabase');
const {
    cargarConfiguracionDesignacionActiva, cargarConfiguracionDesignacionPorId,
    listarVersionesDesignacion, obtenerVersionDesignacionDetalle,
    crearVersionDesignacion, activarVersionDesignacion
} = require('./configuracionDesignacionRepositorio');
const { construirConfiguracionDefaultV1, validarConfiguracion } = require('./configuracionDesignacion');

// ─── Fixtures — mismas filas reales verificadas en BD para V1 ─────────────
// Etapa 4: SELECT_VERSION ahora incluye también activa/descripcion/
// creado_por/created_at (metadata de display, nunca leída por el motor).
const VERSION_V1 = {
    id: 'v1-uuid', numero_version: 1, schema_version: 1, activa: true,
    regla_distancia_maxima_activa: true, distancia_maxima_km: '600',
    regla_no_repetir_asociacion_activa: true, regla_un_rodeo_por_finde_activa: true,
    regla_finde_consecutivo_activa: true, regla_asociacion_organizadora_activa: true,
    descripcion: 'Versión 1 — equivalente exacto al motor.', creado_por: null, created_at: '2026-04-01T00:00:00Z'
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
            order: () => chain,
            maybeSingle: () => chain,
            then: (resolve, reject) => Promise.resolve(respuesta).then(resolve, reject)
        };
        return chain;
    });
}

beforeEach(() => {
    supabase.from.mockReset();
    supabase.rpc.mockReset();
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
        expect(resultado.meta).toEqual({
            id: 'v1-uuid', numero_version: 1, schema_version: 1, activa: true,
            descripcion: 'Versión 1 — equivalente exacto al motor.', creado_por: null, created_at: '2026-04-01T00:00:00Z'
        });
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

// TEST F — actualizado por la mejora "Equidad de Traslados": schema_version=2
// ahora es un valor SOPORTADO (ver configuracionDesignacion.js,
// SCHEMA_VERSIONES_SOPORTADAS). Lo que sigue siendo inválido es cualquier
// schema_version FUERA de [1, 2] — ej. 3, todavía inexistente.
describe('TEST F: schema_version no soportado — inválida, nunca fallback silencioso', () => {
    // 4 (no 3): la mejora "Zonas Extremas" volvió a schema_version=3 un
    // valor SOPORTADO (mismo tipo de actualización que ya ocurrió acá
    // cuando 2 se volvió soportado con "Equidad de Traslados") — 4 sigue
    // siendo un ejemplo válido de "schema_version desconocido".
    test('CONFIGURACION_DESIGNACION_INVALIDA si schema_version es 4 (no soportado)', async () => {
        mockSupabaseRespuestas({
            configuracion_designacion_versiones: { data: [{ ...VERSION_V1, schema_version: 4 }], error: null },
            configuracion_designacion_orden_criterios: { data: CRITERIOS_V1, error: null },
            configuracion_designacion_matriz: { data: MATRIZ_V1, error: null }
        });
        const resultado = await cargarConfiguracionDesignacionActiva();
        expect(resultado.error).toBe('CONFIGURACION_DESIGNACION_INVALIDA');
        expect(resultado.configuracion).toBeUndefined();
    });
    // Nuevo — confirma explícitamente que una fila con schema_version=2 pero
    // SIN columnas de equidad de traslados (la forma real que devuelve
    // Supabase HOY, antes de aplicar la migración 052 — ver informe) se
    // reconstruye y valida igual que V1, funcionalmente. No es más una fila
    // "distinta de 1" rechazada — es la evolución compatible pedida.
    test('schema_version=2 con la misma forma de fila que V1 (sin columnas de equidad) es VÁLIDA', async () => {
        mockSupabaseRespuestas({
            configuracion_designacion_versiones: { data: [{ ...VERSION_V1, schema_version: 2 }], error: null },
            configuracion_designacion_orden_criterios: { data: CRITERIOS_V1, error: null },
            configuracion_designacion_matriz: { data: MATRIZ_V1, error: null }
        });
        const resultado = await cargarConfiguracionDesignacionActiva();
        expect(resultado.error).toBeUndefined();
        expect(resultado.configuracion.schema_version).toBe(2);
        expect('regla_equidad_traslados_activa' in resultado.configuracion).toBe(false);
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
    // 5 (no 3): la mejora "Zonas Extremas" agrega 2 queries fijas nuevas
    // (sus 2 tablas propias) — mismo tipo de actualización que ya ocurrió
    // acá cuando "Equidad de Traslados" no agregó ninguna consulta nueva
    // (reutilizó las columnas ya traídas por configuracion_designacion_
    // versiones), pero Zonas Extremas SÍ necesita 2 tablas hijas nuevas,
    // igual que orden_criterios/matriz — siguen siendo FIJAS, nunca por
    // criterio/categoría/asociación (sin importar su tamaño).
    test('cargarConfiguracionDesignacionActiva hace exactamente 5 llamadas a supabase.from(), sin importar el tamaño de la matriz/criterios/zonas extremas', async () => {
        mockSupabaseRespuestas({
            configuracion_designacion_versiones: { data: [VERSION_V1], error: null },
            configuracion_designacion_orden_criterios: { data: CRITERIOS_V1, error: null },
            configuracion_designacion_matriz: { data: MATRIZ_V1, error: null }
        });
        await cargarConfiguracionDesignacionActiva();
        expect(supabase.from).toHaveBeenCalledTimes(5);
        expect(supabase.from.mock.calls.map(c => c[0]).sort()).toEqual([
            'configuracion_designacion_matriz', 'configuracion_designacion_orden_criterios',
            'configuracion_designacion_versiones',
            'configuracion_designacion_zona_extrema_categorias', 'configuracion_designacion_zonas_extremas'
        ]);
    });
    test('cargarConfiguracionDesignacionPorId también hace exactamente 5 llamadas', async () => {
        mockSupabaseRespuestas({
            configuracion_designacion_versiones: { data: [VERSION_V1], error: null },
            configuracion_designacion_orden_criterios: { data: CRITERIOS_V1, error: null },
            configuracion_designacion_matriz: { data: MATRIZ_V1, error: null }
        });
        await cargarConfiguracionDesignacionPorId('v1-uuid');
        expect(supabase.from).toHaveBeenCalledTimes(5);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// ETAPA 4 — listar, ver detalle, crear y activar versiones desde la UI
// (sección 53 del pedido).
// ═════════════════════════════════════════════════════════════════════════

// TEST 53.A
describe('TEST 53.A: listarVersionesDesignacion — historial completo', () => {
    test('devuelve cabecera + nombre del creador, más reciente primero (según el orden que ya trae la fila del mock)', async () => {
        const v2 = { ...VERSION_V1, id: 'v2-uuid', numero_version: 2, activa: false, creado_por: 'admin-1', administradores: { nombre_completo: 'Ana Admin' } };
        const v1ConEmbed = { ...VERSION_V1, administradores: null };
        mockSupabaseRespuestas({ configuracion_designacion_versiones: { data: [v2, v1ConEmbed], error: null } });

        const lista = await listarVersionesDesignacion();
        expect(lista).toHaveLength(2);
        expect(lista[0]).toMatchObject({ id: 'v2-uuid', numero_version: 2, activa: false, creado_por_nombre: 'Ana Admin' });
        expect(lista[1]).toMatchObject({ id: 'v1-uuid', numero_version: 1, activa: true, creado_por_nombre: null });
    });
});

// TEST 53.C (histórica inactiva, con nombre de autor)
describe('TEST 53.C: obtenerVersionDesignacionDetalle — versión histórica + nombre del creador', () => {
    test('resuelve la versión aunque no sea la activa, y agrega creado_por_nombre', async () => {
        const historica = { ...VERSION_V1, id: 'v-historica', numero_version: 3, activa: false, creado_por: 'admin-1' };
        mockSupabaseRespuestas({
            configuracion_designacion_versiones: { data: [historica], error: null },
            configuracion_designacion_orden_criterios: { data: CRITERIOS_V1, error: null },
            configuracion_designacion_matriz: { data: MATRIZ_V1, error: null },
            administradores: { data: { nombre_completo: 'Ana Admin' }, error: null }
        });
        const resultado = await obtenerVersionDesignacionDetalle('v-historica');
        expect(resultado.error).toBeUndefined();
        expect(resultado.meta.numero_version).toBe(3);
        expect(resultado.meta.creado_por_nombre).toBe('Ana Admin');
    });
    test('sin creado_por (ej. seed de V1) → creado_por_nombre null, sin consultar administradores', async () => {
        mockSupabaseRespuestas({
            configuracion_designacion_versiones: { data: [VERSION_V1], error: null },
            configuracion_designacion_orden_criterios: { data: CRITERIOS_V1, error: null },
            configuracion_designacion_matriz: { data: MATRIZ_V1, error: null }
        });
        const resultado = await obtenerVersionDesignacionDetalle('v1-uuid');
        expect(resultado.meta.creado_por_nombre).toBeNull();
        expect(supabase.from).not.toHaveBeenCalledWith('administradores');
    });
});

// TEST 53.D/E/F
describe('TEST 53.D/E/F: crearVersionDesignacion — configuración válida', () => {
    test('llama a la RPC con los datos correctos y devuelve {id, numero_version}; nunca toca configuracion_designacion_versiones directamente (ni V1 ni ninguna otra fila)', async () => {
        supabase.rpc.mockResolvedValue({ data: [{ id: 'v2-uuid', numero_version: 2 }], error: null });
        const configuracion = construirConfiguracionDefaultV1();
        const resultado = await crearVersionDesignacion({ configuracion, descripcion: 'Prueba', creadoPor: 'admin-1' });

        expect(resultado.error).toBeUndefined();
        expect(resultado).toEqual({ id: 'v2-uuid', numero_version: 2 });
        expect(supabase.rpc).toHaveBeenCalledWith('crear_configuracion_designacion_version', expect.objectContaining({
            p_regla_distancia_maxima_activa: true, p_distancia_maxima_km: 600, p_descripcion: 'Prueba', p_creado_por: 'admin-1'
        }));
        // "V2 queda inactiva" y "V1 sigue activa" son responsabilidad EXCLUSIVA
        // de la RPC (activa=false hardcodeado ahí, migración 051) — el JS no
        // hace ningún INSERT/UPDATE propio que pudiera tocarlas.
        expect(supabase.from).not.toHaveBeenCalled();
    });
});

// Mejora "Equidad de Traslados" (revisión de cierre, sección 3/21/22/23):
// crearVersionDesignacion() elige EXPLÍCITAMENTE la RPC según schema_version
// — nunca una sobrecarga ambigua. Estos tests confirman el despacho, con la
// RPC igualmente mockeada (nunca contra Supabase real ni producción).
describe('ESTADO 2/3 — crearVersionDesignacion despacha a la RPC correcta según schema_version', () => {
    test('ESTADO 2 — schema_version=1 (config histórica de siempre) sigue llamando EXCLUSIVAMENTE a la RPC legacy, con los mismos 10 parámetros de siempre — comportamiento 100% igual al actual', async () => {
        supabase.rpc.mockResolvedValue({ data: [{ id: 'v-legacy', numero_version: 5 }], error: null });
        const configuracion = construirConfiguracionDefaultV1(); // schema_version: 1
        const resultado = await crearVersionDesignacion({ configuracion, descripcion: 'v1 nueva', creadoPor: 'admin-1' });

        expect(resultado).toEqual({ id: 'v-legacy', numero_version: 5 });
        expect(supabase.rpc).toHaveBeenCalledTimes(1);
        const [nombreRpc, params] = supabase.rpc.mock.calls[0];
        expect(nombreRpc).toBe('crear_configuracion_designacion_version'); // RPC LEGACY, nunca la v2
        // Exactamente los mismos 10 parámetros de siempre — sin ningún campo
        // de equidad de traslados (esos ni existen para esta RPC).
        expect(Object.keys(params).sort()).toEqual([
            'p_creado_por', 'p_descripcion', 'p_distancia_maxima_km', 'p_matriz', 'p_orden_criterios',
            'p_regla_asociacion_organizadora_activa', 'p_regla_distancia_maxima_activa',
            'p_regla_finde_consecutivo_activa', 'p_regla_no_repetir_asociacion_activa', 'p_regla_un_rodeo_por_finde_activa'
        ].sort());
    });

    test('ESTADO 3 — schema_version=2 con equidad activa llama EXCLUSIVAMENTE a la RPC v2, con los parámetros de equidad incluidos', async () => {
        supabase.rpc.mockResolvedValue({ data: [{ id: 'v-nueva-v2', numero_version: 6 }], error: null });
        const configuracion = {
            ...construirConfiguracionDefaultV1(),
            schema_version: 2, regla_equidad_traslados_activa: true, umbral_lejania_km: 350,
            ordenCriterios: [
                { criterio_codigo: 'EQUIDAD_TRASLADOS', orden: 1 },
                { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 2 },
                { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 3 },
                { criterio_codigo: 'MENOR_DISTANCIA', orden: 4 }
            ]
        };
        const resultado = await crearVersionDesignacion({ configuracion, descripcion: 'v2 equidad', creadoPor: 'admin-2' });

        expect(resultado).toEqual({ id: 'v-nueva-v2', numero_version: 6 });
        expect(supabase.rpc).toHaveBeenCalledTimes(1);
        const [nombreRpc, params] = supabase.rpc.mock.calls[0];
        expect(nombreRpc).toBe('crear_configuracion_designacion_version_v2'); // RPC NUEVA, nunca la legacy
        expect(params.p_regla_equidad_traslados_activa).toBe(true);
        expect(params.p_umbral_lejania_km).toBe(350);
        expect(params.p_orden_criterios[0]).toEqual({ criterio_codigo: 'EQUIDAD_TRASLADOS', orden: 1 });
    });

    test('schema_version=2 SIN equidad activa (config nueva pero sin usar la regla) también usa la RPC v2 — la elección es por schema_version, no por si equidad está activa', async () => {
        supabase.rpc.mockResolvedValue({ data: [{ id: 'v-schema2-sin-equidad', numero_version: 7 }], error: null });
        const configuracion = { ...construirConfiguracionDefaultV1(), schema_version: 2 };
        await crearVersionDesignacion({ configuracion, descripcion: null, creadoPor: null });
        expect(supabase.rpc.mock.calls[0][0]).toBe('crear_configuracion_designacion_version_v2');
        expect(supabase.rpc.mock.calls[0][1].p_regla_equidad_traslados_activa).toBe(false);
        expect(supabase.rpc.mock.calls[0][1].p_umbral_lejania_km).toBeNull();
    });

    // TEST 43 (pedido de UI "Zonas Extremas"): POST schema3 -> objeto
    // completo llega al repository -> RPC v3 con los 15 parámetros,
    // incluyendo asociaciones/categorías de Zonas Extremas.
    test('schema_version=3 con Zonas Extremas activa llama EXCLUSIVAMENTE a la RPC v3, con TODOS los parámetros (heredados de schema1/2 + zonas extremas)', async () => {
        supabase.rpc.mockResolvedValue({ data: [{ id: 'v-nueva-v3', numero_version: 8 }], error: null });
        const configuracion = {
            ...construirConfiguracionDefaultV1(),
            schema_version: 3,
            regla_equidad_traslados_activa: true, umbral_lejania_km: 350,
            regla_zonas_extremas_activa: true,
            zonas_extremas: {
                asociaciones: ['ARICA Y TARAPACA', 'NORTE GRANDE', 'MAGALLANES', 'AYSEN', 'CUYO'],
                categorias: [
                    { categoria: 'A', elegible: false, orden_preferencia: null },
                    { categoria: 'B', elegible: true, orden_preferencia: 2 },
                    { categoria: 'C', elegible: true, orden_preferencia: 1 }
                ]
            },
            ordenCriterios: [
                { criterio_codigo: 'EQUIDAD_TRASLADOS', orden: 1 },
                { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 2 },
                { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 3 },
                { criterio_codigo: 'MENOR_DISTANCIA', orden: 4 }
            ]
        };
        const resultado = await crearVersionDesignacion({ configuracion, descripcion: 'v3 zonas extremas', creadoPor: 'admin-3' });

        expect(resultado).toEqual({ id: 'v-nueva-v3', numero_version: 8 });
        expect(supabase.rpc).toHaveBeenCalledTimes(1);
        const [nombreRpc, params] = supabase.rpc.mock.calls[0];
        expect(nombreRpc).toBe('crear_configuracion_designacion_version_v3'); // RPC NUEVA, nunca legacy/v2
        expect(Object.keys(params).sort()).toEqual([
            'p_creado_por', 'p_descripcion', 'p_distancia_maxima_km', 'p_matriz', 'p_orden_criterios',
            'p_regla_asociacion_organizadora_activa', 'p_regla_distancia_maxima_activa',
            'p_regla_equidad_traslados_activa', 'p_regla_finde_consecutivo_activa',
            'p_regla_no_repetir_asociacion_activa', 'p_regla_un_rodeo_por_finde_activa',
            'p_regla_zonas_extremas_activa', 'p_umbral_lejania_km',
            'p_zonas_extremas_asociaciones', 'p_zonas_extremas_categorias'
        ].sort());
        expect(params.p_regla_zonas_extremas_activa).toBe(true);
        expect(params.p_zonas_extremas_asociaciones).toEqual(['ARICA Y TARAPACA', 'NORTE GRANDE', 'MAGALLANES', 'AYSEN', 'CUYO']);
        expect(params.p_zonas_extremas_categorias).toEqual([
            { categoria: 'A', elegible: false, orden_preferencia: null },
            { categoria: 'B', elegible: true, orden_preferencia: 2 },
            { categoria: 'C', elegible: true, orden_preferencia: 1 }
        ]);
        // Heredado de schema2 — EQUIDAD_TRASLADOS sigue viajando también.
        expect(params.p_regla_equidad_traslados_activa).toBe(true);
        expect(params.p_umbral_lejania_km).toBe(350);
    });

    test('schema_version=3 SIN Zonas Extremas activa también usa la RPC v3 — la elección es por schema_version, no por si la regla está activa', async () => {
        supabase.rpc.mockResolvedValue({ data: [{ id: 'v-schema3-sin-ze', numero_version: 9 }], error: null });
        const configuracion = { ...construirConfiguracionDefaultV1(), schema_version: 3 };
        await crearVersionDesignacion({ configuracion, descripcion: null, creadoPor: null });
        expect(supabase.rpc.mock.calls[0][0]).toBe('crear_configuracion_designacion_version_v3');
        expect(supabase.rpc.mock.calls[0][1].p_regla_zonas_extremas_activa).toBe(false);
        expect(supabase.rpc.mock.calls[0][1].p_zonas_extremas_asociaciones).toEqual([]);
        expect(supabase.rpc.mock.calls[0][1].p_zonas_extremas_categorias).toEqual([]);
    });
});

// TEST 43 (pedido de UI): GET versión schema3 -> asociaciones/categorías
// completas reconstruidas desde las 2 tablas nuevas.
describe('cargarConfiguracionDesignacionPorId — schema_version=3 reconstruye zonas_extremas completo', () => {
    test('versión schema3 con Zonas Extremas activa -> configuracion.zonas_extremas trae asociaciones y categorías reales de BD', async () => {
        const versionZE = {
            ...VERSION_V1, id: 'v3-uuid', schema_version: 3, regla_zonas_extremas_activa: true,
            regla_equidad_traslados_activa: false, umbral_lejania_km: null
        };
        mockSupabaseRespuestas({
            configuracion_designacion_versiones: { data: [versionZE], error: null },
            configuracion_designacion_orden_criterios: { data: CRITERIOS_V1, error: null },
            configuracion_designacion_matriz: { data: MATRIZ_V1, error: null },
            configuracion_designacion_zonas_extremas: {
                data: [{ asociacion: 'MAGALLANES' }, { asociacion: 'AYSEN' }, { asociacion: 'CUYO' }], error: null
            },
            configuracion_designacion_zona_extrema_categorias: {
                data: [
                    { categoria: 'A', elegible: false, orden_preferencia: null },
                    { categoria: 'B', elegible: true, orden_preferencia: 2 },
                    { categoria: 'C', elegible: true, orden_preferencia: 1 }
                ], error: null
            }
        });
        const resultado = await cargarConfiguracionDesignacionPorId('v3-uuid');
        expect(resultado.error).toBeUndefined();
        expect(resultado.configuracion.regla_zonas_extremas_activa).toBe(true);
        expect(resultado.configuracion.zonas_extremas.asociaciones).toEqual(['MAGALLANES', 'AYSEN', 'CUYO']);
        expect(resultado.configuracion.zonas_extremas.categorias).toHaveLength(3);
        expect(resultado.configuracion.zonas_extremas.categorias.find(f => f.categoria === 'C')).toEqual({ categoria: 'C', elegible: true, orden_preferencia: 1 });
    });
});

// TEST 53.G/H/I/K
describe('TEST 53.G/H/I/K: crearVersionDesignacion — configuración inválida rechazada ANTES de llamar a la RPC', () => {
    test('0 criterios de ranking → CONFIGURACION_DESIGNACION_INVALIDA, RPC nunca llamada', async () => {
        const configuracion = { ...construirConfiguracionDefaultV1(), ordenCriterios: [] };
        const resultado = await crearVersionDesignacion({ configuracion, descripcion: null, creadoPor: null });
        expect(resultado.error).toBe('CONFIGURACION_DESIGNACION_INVALIDA');
        expect(supabase.rpc).not.toHaveBeenCalled();
    });
    test('matriz incompleta (falta una clasificación) → CONFIGURACION_DESIGNACION_INVALIDA, RPC nunca llamada', async () => {
        const configuracion = construirConfiguracionDefaultV1();
        delete configuracion.matriz.nacional;
        const resultado = await crearVersionDesignacion({ configuracion, descripcion: null, creadoPor: null });
        expect(resultado.error).toBe('CONFIGURACION_DESIGNACION_INVALIDA');
        expect(supabase.rpc).not.toHaveBeenCalled();
    });
    test('distancia_maxima_km = 5001 con la regla activa → CONFIGURACION_DESIGNACION_INVALIDA, RPC nunca llamada', async () => {
        const configuracion = { ...construirConfiguracionDefaultV1(), distancia_maxima_km: 5001 };
        const resultado = await crearVersionDesignacion({ configuracion, descripcion: null, creadoPor: null });
        expect(resultado.error).toBe('CONFIGURACION_DESIGNACION_INVALIDA');
        expect(supabase.rpc).not.toHaveBeenCalled();
    });
});

// TEST 53.L
describe('TEST 53.L: crearVersionDesignacion — distancia máxima desactivada con NULL es válida', () => {
    test('regla_distancia_maxima_activa=false, distancia_maxima_km=null → pasa la validación y llega a la RPC', async () => {
        supabase.rpc.mockResolvedValue({ data: [{ id: 'v2-uuid', numero_version: 2 }], error: null });
        const configuracion = { ...construirConfiguracionDefaultV1(), regla_distancia_maxima_activa: false, distancia_maxima_km: null };
        const resultado = await crearVersionDesignacion({ configuracion, descripcion: null, creadoPor: null });
        expect(resultado.error).toBeUndefined();
        expect(supabase.rpc).toHaveBeenCalledWith('crear_configuracion_designacion_version', expect.objectContaining({
            p_regla_distancia_maxima_activa: false, p_distancia_maxima_km: null
        }));
    });
});

// TEST 53.J
describe('TEST 53.J: crearVersionDesignacion — Provincial A/B/C con orden B→A→C', () => {
    test('aplanarMatriz produce las 3 filas de Provincial con el orden esperado, y la RPC recibe esa matriz', async () => {
        supabase.rpc.mockResolvedValue({ data: [{ id: 'v2-uuid', numero_version: 2 }], error: null });
        const configuracion = construirConfiguracionDefaultV1();
        configuracion.matriz.provincial = [
            { categoria: 'A', elegible: true, orden_preferencia: 2 },
            { categoria: 'B', elegible: true, orden_preferencia: 1 },
            { categoria: 'C', elegible: true, orden_preferencia: 3 }
        ];
        await crearVersionDesignacion({ configuracion, descripcion: 'Provincial A/B/C', creadoPor: null });

        const llamada = supabase.rpc.mock.calls[0][1];
        const filasProvincial = llamada.p_matriz
            .filter(f => f.clasificacion_codigo === 'provincial')
            .sort((a, b) => a.orden_preferencia - b.orden_preferencia);
        expect(filasProvincial).toEqual([
            { clasificacion_codigo: 'provincial', categoria: 'B', elegible: true, orden_preferencia: 1 },
            { clasificacion_codigo: 'provincial', categoria: 'A', elegible: true, orden_preferencia: 2 },
            { clasificacion_codigo: 'provincial', categoria: 'C', elegible: true, orden_preferencia: 3 }
        ]);
    });
});

// TEST 54 — creación atómica: si la RPC (Postgres) rechaza la inserción
// (simula el caso real: un INSERT de criterios/matriz viola un CHECK, o la
// validación estructural final de la función falla) — crearVersionDesignacion
// JAMÁS reporta éxito ni devuelve un id parcial. La atomicidad real (que
// PostgreSQL revierte TODOS los INSERT de la función si esta termina en una
// excepción no capturada — no requiere BEGIN/COMMIT explícito porque una
// función que no confirma hereda la transacción de quien la llama) es una
// garantía del LENGUAJE, documentada en la migración 051 — no se simula acá
// una base de datos real (bloqueado: no se aplica 051 sin autorización), se
// prueba el contrato que le importa al resto del sistema: cuando la RPC
// informa error, NUNCA hay un {id, numero_version} de por medio.
describe('TEST 54: crearVersionDesignacion — si la RPC (Postgres) rechaza, nunca hay éxito parcial', () => {
    test('la RPC devuelve error (ej. la validación estructural final falló en Postgres) → {error}, nunca {id,...}', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'Versión: la matriz debe tener exactamente 18 filas; tiene 17 filas en 6 clasificaciones — no se activa.' } });
        const configuracion = construirConfiguracionDefaultV1();
        const resultado = await crearVersionDesignacion({ configuracion, descripcion: null, creadoPor: null });
        expect(resultado.id).toBeUndefined();
        expect(resultado.numero_version).toBeUndefined();
        expect(resultado.error).toBe('CONFIGURACION_DESIGNACION_INVALIDA');
        expect(resultado.detalle).toMatch(/matriz debe tener exactamente 18 filas/);
    });
});

// TEST 53.M
describe('TEST 53.M: activarVersionDesignacion — usa EXCLUSIVAMENTE la RPC activar_configuracion_designacion', () => {
    test('llama supabase.rpc con el id, nunca supabase.from (ningún UPDATE directo desde JS)', async () => {
        supabase.rpc.mockResolvedValue({ error: null });
        const resultado = await activarVersionDesignacion('v2-uuid');
        expect(resultado).toEqual({ ok: true });
        expect(supabase.rpc).toHaveBeenCalledWith('activar_configuracion_designacion', { p_version_id: 'v2-uuid' });
        expect(supabase.from).not.toHaveBeenCalled();
    });
    test('la RPC rechaza (versión estructuralmente inválida) → error controlado, nunca una excepción sin capturar', async () => {
        supabase.rpc.mockResolvedValue({ error: { message: 'Versión no tiene ningún criterio de ranking activo' } });
        const resultado = await activarVersionDesignacion('v-corrupta');
        expect(resultado.error).toBe('CONFIGURACION_DESIGNACION_INVALIDA');
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

// ═════════════════════════════════════════════════════════════════════════
// REGRESIÓN — diagnóstico "CONFIGURACION_DESIGNACION_INVALIDA" al guardar
// Schema3 desde la V2 REAL de producción (reporte de bug del administrador).
//
// Reproduce el flujo COMPLETO exactamente como lo hace la UI real, usando
// las filas EXACTAS de V2 activa extraídas de producción (solo lectura, ver
// diagnóstico de este mismo cierre): GET /activa (reconstrucción) →
// abrirCrearNuevaVersion (clonar) → activar Zonas Extremas (helper frontend
// real) → diff para UI (helper frontend real) → validarDraft (frontend) →
// validarConfiguracion (backend) → POST /versiones → repository → RPC v3.
//
// Resultado de la investigación: con los datos REALES, este flujo NO
// reproduce el error — el draft, el diff y ambas validaciones son correctos
// en cada paso. Este test queda como regresión permanente de ese hallazgo
// (si algo en el futuro rompe cualquiera de estos pasos, este test lo
// detecta) — no reemplaza la necesidad de que el administrador reintente
// tras un refresco duro del navegador (ver reporte).
// ═════════════════════════════════════════════════════════════════════════
describe('REGRESIÓN — V2 real de producción → activar Zonas Extremas → guardar (bug CONFIGURACION_DESIGNACION_INVALIDA)', () => {
    // Filas EXACTAS de la versión V2 activa real, extraídas solo-lectura de
    // producción en el diagnóstico de este bug (proyecto witynpyhuhbobrxevmcp,
    // version_id 0ac4f340-968b-4076-9687-1b13cd358d6b) — NUNCA sintéticas/
    // uniformes, a diferencia de construirConfiguracionDefaultV1().
    const VERSION_V2_REAL = {
        id: '0ac4f340-968b-4076-9687-1b13cd358d6b', numero_version: 2, schema_version: 2, activa: true,
        regla_distancia_maxima_activa: true, distancia_maxima_km: '1000',
        regla_no_repetir_asociacion_activa: true, regla_un_rodeo_por_finde_activa: true,
        regla_finde_consecutivo_activa: true, regla_asociacion_organizadora_activa: true,
        regla_equidad_traslados_activa: true, umbral_lejania_km: '350',
        regla_zonas_extremas_activa: false,
        descripcion: null, creado_por: null, created_at: '2026-09-01T00:00:00Z'
    };
    const CRITERIOS_V2_REAL = [
        { criterio_codigo: 'EQUIDAD_TRASLADOS', orden: 1 },
        { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 2 },
        { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 3 },
        { criterio_codigo: 'MENOR_DISTANCIA', orden: 4 }
    ];
    const MATRIZ_V2_REAL = [
        { clasificacion_codigo: 'clasificatorio', categoria: 'A', elegible: true, orden_preferencia: 1 },
        { clasificacion_codigo: 'clasificatorio', categoria: 'B', elegible: true, orden_preferencia: 2 },
        { clasificacion_codigo: 'clasificatorio', categoria: 'C', elegible: false, orden_preferencia: null },
        { clasificacion_codigo: 'interasociaciones', categoria: 'A', elegible: true, orden_preferencia: 1 },
        { clasificacion_codigo: 'interasociaciones', categoria: 'B', elegible: true, orden_preferencia: 2 },
        { clasificacion_codigo: 'interasociaciones', categoria: 'C', elegible: false, orden_preferencia: null },
        { clasificacion_codigo: 'interclubes', categoria: 'A', elegible: false, orden_preferencia: null },
        { clasificacion_codigo: 'interclubes', categoria: 'B', elegible: true, orden_preferencia: 2 },
        { clasificacion_codigo: 'interclubes', categoria: 'C', elegible: true, orden_preferencia: 1 },
        { clasificacion_codigo: 'nacional', categoria: 'A', elegible: true, orden_preferencia: 1 },
        { clasificacion_codigo: 'nacional', categoria: 'B', elegible: false, orden_preferencia: null },
        { clasificacion_codigo: 'nacional', categoria: 'C', elegible: false, orden_preferencia: null },
        { clasificacion_codigo: 'provincial', categoria: 'A', elegible: true, orden_preferencia: 2 },
        { clasificacion_codigo: 'provincial', categoria: 'B', elegible: true, orden_preferencia: 1 },
        { clasificacion_codigo: 'provincial', categoria: 'C', elegible: false, orden_preferencia: null },
        { clasificacion_codigo: 'zonal', categoria: 'A', elegible: true, orden_preferencia: 1 },
        { clasificacion_codigo: 'zonal', categoria: 'B', elegible: true, orden_preferencia: 2 },
        { clasificacion_codigo: 'zonal', categoria: 'C', elegible: false, orden_preferencia: null }
    ];

    const { obtenerCapacidadesSoportadas } = require('./configuracionDesignacion');
    // Módulo del FRONTEND real — mismo require cross-root que usa Jest para
    // frontend/js/*.test.js (jest.roots incluye <rootDir>/../frontend/js).
    const feHelpers = require('../../../frontend/js/configuracionDesignacionHelpers');

    test('paso 1 — GET /activa reconstruye V2 real como válida (línea base)', async () => {
        mockSupabaseRespuestas({
            configuracion_designacion_versiones: { data: [VERSION_V2_REAL], error: null },
            configuracion_designacion_orden_criterios: { data: CRITERIOS_V2_REAL, error: null },
            configuracion_designacion_matriz: { data: MATRIZ_V2_REAL, error: null }
            // zonas_extremas / zona_extrema_categorias: default {data:[],error:null} (0 filas reales en V2)
        });
        const activa = await cargarConfiguracionDesignacionActiva();
        expect(activa.error).toBeUndefined();
        expect(activa.configuracion.regla_zonas_extremas_activa).toBe(false);
        expect(activa.configuracion.zonas_extremas).toEqual({ asociaciones: [], categorias: [] });

        // paso 2 — activar Zonas Extremas sobre el draft clonado (helper FRONTEND real)
        const draftClonado = JSON.parse(JSON.stringify(activa.configuracion));
        const capacidades = obtenerCapacidadesSoportadas();
        const draftActivado = feHelpers.activarZonasExtremas(draftClonado, capacidades.zonas_extremas_default);

        expect(draftActivado.schema_version).toBe(3);
        expect(draftActivado.regla_zonas_extremas_activa).toBe(true);
        expect(draftActivado.zonas_extremas.asociaciones).toEqual(
            ['ARICA Y TARAPACA', 'NORTE GRANDE', 'MAGALLANES', 'AYSÉN', 'CUYO']
        );
        expect(draftActivado.zonas_extremas.categorias).toEqual([
            { categoria: 'A', elegible: false, orden_preferencia: null },
            { categoria: 'B', elegible: true, orden_preferencia: 2 },
            { categoria: 'C', elegible: true, orden_preferencia: 1 }
        ]);

        // paso 3 — V2 preservada íntegra dentro del draft promovido (sección 24 del pedido)
        expect(draftActivado.regla_distancia_maxima_activa).toBe(true);
        expect(draftActivado.distancia_maxima_km).toBe(1000);
        expect(draftActivado.regla_equidad_traslados_activa).toBe(true);
        expect(draftActivado.umbral_lejania_km).toBe(350);
        expect(draftActivado.ordenCriterios).toEqual(CRITERIOS_V2_REAL);
        expect(draftActivado.matriz).toEqual(activa.configuracion.matriz);

        // paso 4 — diff EXACTO que vería el administrador en "Cambios respecto
        // a la versión base" — DEBE mostrar "C→B", nunca solo "C" (sección 12/20).
        const diff = feHelpers.construirDiffParaUI(activa.configuracion, draftActivado);
        const filaPrioridad = diff.cambios.find(c => c.etiqueta === 'Prioridad Zona Extrema');
        expect(filaPrioridad).toBeDefined();
        expect(filaPrioridad.antes).toBe('—');
        expect(filaPrioridad.despues).toBe('C→B');
        const filaAsociaciones = diff.cambios.find(c => c.etiqueta === 'Asociaciones Zona Extrema');
        expect(filaAsociaciones.despues.split(', ').sort()).toEqual(
            ['ARICA Y TARAPACA', 'AYSÉN', 'CUYO', 'MAGALLANES', 'NORTE GRANDE']
        );

        // paso 5 — ambas validaciones (frontend liviana + backend fuente de verdad) pasan
        expect(feHelpers.validarDraft(draftActivado)).toEqual({ valido: true });
        expect(validarConfiguracion(draftActivado)).toEqual({ valido: true });

        // paso 6 — GUARDAR: POST /versiones -> repository -> RPC v3 EXCLUSIVAMENTE,
        // con el payload COMPLETO (18 filas de matriz, 3 categorías de zona
        // extrema, 5 asociaciones) — nada se filtra en el camino.
        supabase.rpc.mockResolvedValue({ data: [{ id: 'v-nueva-desde-v2-real', numero_version: 3 }], error: null });
        const resultado = await crearVersionDesignacion({
            configuracion: draftActivado, descripcion: 'Promoción real V2->V3 (regresión)', creadoPor: 'admin-real'
        });
        expect(resultado).toEqual({ id: 'v-nueva-desde-v2-real', numero_version: 3 });
        expect(supabase.rpc).toHaveBeenCalledTimes(1);
        const [nombreRpc, params] = supabase.rpc.mock.calls[0];
        expect(nombreRpc).toBe('crear_configuracion_designacion_version_v3');
        expect(params.p_matriz).toHaveLength(18);
        expect(params.p_zonas_extremas_categorias).toHaveLength(3);
        expect(params.p_zonas_extremas_asociaciones).toHaveLength(5);
        expect(params.p_zonas_extremas_categorias).toEqual([
            { categoria: 'A', elegible: false, orden_preferencia: null },
            { categoria: 'B', elegible: true, orden_preferencia: 2 },
            { categoria: 'C', elegible: true, orden_preferencia: 1 }
        ]);
        expect(params.p_regla_equidad_traslados_activa).toBe(true);
        expect(params.p_umbral_lejania_km).toBe(350);
        expect(params.p_distancia_maxima_km).toBe(1000);
    });

    test('toggle OFF conserva los datos latentes; toggle ON de nuevo los recupera intactos (sección 22)', () => {
        const capacidades = obtenerCapacidadesSoportadas();
        const base = { ...construirConfiguracionDefaultV1(), schema_version: 3 };
        const activado = feHelpers.activarZonasExtremas(base, capacidades.zonas_extremas_default);
        const desactivado = feHelpers.desactivarZonasExtremas(activado);
        expect(desactivado.regla_zonas_extremas_activa).toBe(false);
        expect(desactivado.zonas_extremas).toEqual(activado.zonas_extremas); // datos latentes conservados
        const reactivado = feHelpers.activarZonasExtremas(desactivado, capacidades.zonas_extremas_default);
        expect(reactivado.zonas_extremas).toEqual(activado.zonas_extremas); // recuperados intactos, no reemplazados por default
    });

    test('las 5 asociaciones default están presentes, sin duplicados, AYSÉN con nombre canónico (sección 23)', () => {
        const { asociaciones } = obtenerCapacidadesSoportadas().zonas_extremas_default;
        expect(asociaciones).toHaveLength(5);
        expect(new Set(asociaciones).size).toBe(5);
        expect(asociaciones).toContain('AYSÉN');
        expect(asociaciones).not.toContain('AYSEN');
    });
});
