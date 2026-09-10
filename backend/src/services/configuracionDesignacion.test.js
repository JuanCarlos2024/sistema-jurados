const fs = require('fs');
const path = require('path');
const {
    SCHEMA_VERSION_SOPORTADO, SCHEMA_VERSIONES_SOPORTADAS, CRITERIOS_CONOCIDOS, CRITERIOS_CONOCIDOS_POR_SCHEMA,
    criteriosConocidosParaSchema,
    validarDistancia, validarUmbralLejania, validarOrdenCriterios, validarMatrizClasificacion, validarMatrizCompleta,
    validarConfiguracion, configuracionRequiereDistancia, clasificarTraslado,
    construirConfiguracionDefaultV1, clonarConfiguracion, compararConfiguraciones,
    reconstruirConfiguracionDesdeFilas, aplanarMatriz, construirResumenParaUI,
    validarZonasExtremas
} = require('./configuracionDesignacion');

const defaultV1 = construirConfiguracionDefaultV1();

// TEST A
describe('TEST A: Default V1 — orden de ranking', () => {
    test('PRIORIDAD_CATEGORIA → MENOS_DESIGNACIONES_TEMPORADA → MENOR_DISTANCIA', () => {
        expect(defaultV1.ordenCriterios).toEqual([
            { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 },
            { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 2 },
            { criterio_codigo: 'MENOR_DISTANCIA', orden: 3 }
        ]);
    });
});

// TEST B
describe('TEST B: Default distancia máxima', () => {
    test('activa=true, 600 km', () => {
        expect(defaultV1.regla_distancia_maxima_activa).toBe(true);
        expect(defaultV1.distancia_maxima_km).toBe(600);
    });
});

// TEST C-F
describe('TEST C-F: Defaults de reglas booleanas', () => {
    test('C: asociación organizadora activa', () => {
        expect(defaultV1.regla_asociacion_organizadora_activa).toBe(true);
    });
    test('D: repetición de asociación activa', () => {
        expect(defaultV1.regla_no_repetir_asociacion_activa).toBe(true);
    });
    test('E: un rodeo por fin de semana activa', () => {
        expect(defaultV1.regla_un_rodeo_por_finde_activa).toBe(true);
    });
    test('F: fin de semana consecutivo activa', () => {
        expect(defaultV1.regla_finde_consecutivo_activa).toBe(true);
    });
});

// TEST G/H/I
describe('TEST G/H/I: Matriz default coincide con la BD real (modelo de 18 filas)', () => {
    test('G: Provincial = A/B, B→A (C explícita como no elegible)', () => {
        expect(defaultV1.matriz.provincial).toEqual([
            { categoria: 'A', elegible: true, orden_preferencia: 2 },
            { categoria: 'B', elegible: true, orden_preferencia: 1 },
            { categoria: 'C', elegible: false, orden_preferencia: null }
        ]);
    });
    test('H: Interclubes = B/C, C→B (A explícita como no elegible)', () => {
        expect(defaultV1.matriz.interclubes).toEqual([
            { categoria: 'A', elegible: false, orden_preferencia: null },
            { categoria: 'B', elegible: true, orden_preferencia: 2 },
            { categoria: 'C', elegible: true, orden_preferencia: 1 }
        ]);
    });
    test('I: resto de clasificaciones coincide con el estado real verificado en BD', () => {
        expect(defaultV1.matriz.interasociaciones).toEqual([
            { categoria: 'A', elegible: true, orden_preferencia: 1 },
            { categoria: 'B', elegible: true, orden_preferencia: 2 },
            { categoria: 'C', elegible: false, orden_preferencia: null }
        ]);
        expect(defaultV1.matriz.zonal).toEqual([
            { categoria: 'A', elegible: true, orden_preferencia: 1 },
            { categoria: 'B', elegible: true, orden_preferencia: 2 },
            { categoria: 'C', elegible: false, orden_preferencia: null }
        ]);
        expect(defaultV1.matriz.clasificatorio).toEqual([
            { categoria: 'A', elegible: true, orden_preferencia: 1 },
            { categoria: 'B', elegible: true, orden_preferencia: 2 },
            { categoria: 'C', elegible: false, orden_preferencia: null }
        ]);
        expect(defaultV1.matriz.nacional).toEqual([
            { categoria: 'A', elegible: true, orden_preferencia: 1 },
            { categoria: 'B', elegible: false, orden_preferencia: null },
            { categoria: 'C', elegible: false, orden_preferencia: null }
        ]);
    });
    test('el default completo pasa validarConfiguracion()', () => {
        expect(validarConfiguracion(defaultV1)).toEqual({ valido: true });
    });
});

// ═══════════════════════════════════════════════════════════════════════
// REVISIÓN FINAL — modelo de matriz completo (18 filas) + activación
// ═══════════════════════════════════════════════════════════════════════

// TEST A (revisión final)
describe('TEST A (revisión): Default V1 contiene exactamente 18 filas de matriz', () => {
    test('6 clasificaciones × 3 categorías = 18', () => {
        const total = Object.values(defaultV1.matriz).reduce((acc, arr) => acc + arr.length, 0);
        expect(total).toBe(18);
    });
});

// TEST B (revisión final)
describe('TEST B (revisión): Default V1 contiene 11 elegibles', () => {
    test('cuenta de elegible=true en toda la matriz', () => {
        const elegibles = Object.values(defaultV1.matriz).flat().filter(f => f.elegible === true);
        expect(elegibles.length).toBe(11);
    });
});

// TEST C (revisión final)
describe('TEST C (revisión): Default V1 contiene 7 no elegibles', () => {
    test('cuenta de elegible=false en toda la matriz', () => {
        const noElegibles = Object.values(defaultV1.matriz).flat().filter(f => f.elegible === false);
        expect(noElegibles.length).toBe(7);
        noElegibles.forEach(f => expect(f.orden_preferencia).toBeNull());
    });
});

// TEST D (revisión final)
describe('TEST D (revisión): Provincial C existe como elegible=false / orden=NULL', () => {
    test('fila C presente y explícita', () => {
        const filaC = defaultV1.matriz.provincial.find(f => f.categoria === 'C');
        expect(filaC).toEqual({ categoria: 'C', elegible: false, orden_preferencia: null });
    });
});

// TEST E (revisión final)
describe('TEST E (revisión): Nacional B/C existen como false/NULL', () => {
    test('filas B y C presentes y explícitas', () => {
        const filaB = defaultV1.matriz.nacional.find(f => f.categoria === 'B');
        const filaC = defaultV1.matriz.nacional.find(f => f.categoria === 'C');
        expect(filaB).toEqual({ categoria: 'B', elegible: false, orden_preferencia: null });
        expect(filaC).toEqual({ categoria: 'C', elegible: false, orden_preferencia: null });
    });
});

// TEST F (revisión final)
describe('TEST F (revisión): falta una de las 18 combinaciones → configuración inválida', () => {
    test('quitar la fila C de Provincial (queda incompleta, no "no elegible")', () => {
        const matrizIncompleta = clonarConfiguracion(defaultV1, {}).matriz;
        matrizIncompleta.provincial = matrizIncompleta.provincial.filter(f => f.categoria !== 'C');
        const r = validarMatrizCompleta(matrizIncompleta);
        expect(r.valido).toBe(false);
    });
    test('validarConfiguracion también rechaza la matriz incompleta', () => {
        const config = clonarConfiguracion(defaultV1, {});
        config.matriz.provincial = config.matriz.provincial.filter(f => f.categoria !== 'C');
        expect(validarConfiguracion(config).valido).toBe(false);
    });
});

// TEST G/H/I (revisión final) — activación no implementada en JS (vive en la
// RPC SQL), documentamos aquí la EXPECTATIVA que la RPC debe cumplir, con la
// misma lógica de validación pura ya usada por el resto del servicio, para
// que quede una prueba ejecutable de la intención (no del SQL en sí, que se
// revisa en el describe de "migración 050" más abajo).
describe('TEST G/H/I (revisión): una versión incompleta nunca debe considerarse activable', () => {
    test('G: versión con matriz incompleta → validarConfiguracion la marca inválida', () => {
        const config = clonarConfiguracion(defaultV1, {});
        delete config.matriz.nacional;
        expect(validarConfiguracion(config).valido).toBe(false);
    });
    test('H: versión sin ningún criterio de ranking → validarConfiguracion la marca inválida', () => {
        const config = clonarConfiguracion(defaultV1, { ordenCriterios: [] });
        expect(validarConfiguracion(config).valido).toBe(false);
    });
    test('I: versión con una clasificación sin elegibles → inválida', () => {
        const config = clonarConfiguracion(defaultV1, {});
        config.matriz.nacional = [
            { categoria: 'A', elegible: false, orden_preferencia: null },
            { categoria: 'B', elegible: false, orden_preferencia: null },
            { categoria: 'C', elegible: false, orden_preferencia: null }
        ];
        expect(validarConfiguracion(config).valido).toBe(false);
    });
});

// TEST J (revisión final) — el diseño de la validación (JS completa vs. RPC
// mínima) se prueba a nivel de intención: la ausencia de UPDATE antes de
// cualquier RAISE EXCEPTION en el SQL (verificado abajo, describe de
// "migración 050") es la garantía real de que un fallo de validación del
// destino nunca desactiva la configuración actual.
describe('TEST J (revisión): fallo de validación de destino no debe desactivar la actual (verificado a nivel de SQL)', () => {
    const sqlPath = path.join(__dirname, '../../../database/migrations/050_configuracion_propuesta_designacion.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    test('todos los RAISE EXCEPTION de validación aparecen antes del primer UPDATE de activación', () => {
        const funcBody = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.activar_configuracion_designacion'), sql.indexOf('REVOKE ALL ON FUNCTION'));
        const idxPrimerUpdate = funcBody.indexOf('UPDATE public.configuracion_designacion_versiones');
        const excepciones = [...funcBody.matchAll(/RAISE EXCEPTION/g)].map(m => m.index);
        expect(idxPrimerUpdate).toBeGreaterThan(-1);
        expect(excepciones.length).toBeGreaterThan(0);
        excepciones.forEach(idx => expect(idx).toBeLessThan(idxPrimerUpdate));
    });
});

// TEST K/L/M/N/O (revisión final) — permisos y search_path de la función
describe('TEST K-O (revisión): seguridad de activar_configuracion_designacion', () => {
    const sqlPath = path.join(__dirname, '../../../database/migrations/050_configuracion_propuesta_designacion.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    test('K: la función usa SECURITY DEFINER con search_path fijo', () => {
        expect(sql).toMatch(/SECURITY DEFINER/);
        expect(sql).toMatch(/SET search_path = public, pg_temp/);
    });
    test('L: PUBLIC no tiene EXECUTE', () => {
        expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.activar_configuracion_designacion\(UUID\) FROM PUBLIC/);
    });
    test('M: anon no tiene EXECUTE', () => {
        expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.activar_configuracion_designacion\(UUID\) FROM anon/);
    });
    test('N: authenticated no tiene EXECUTE', () => {
        expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.activar_configuracion_designacion\(UUID\) FROM authenticated/);
    });
    test('O: service_role sí puede ejecutar la función (GRANT explícito)', () => {
        expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.activar_configuracion_designacion\(UUID\) TO service_role/);
    });
});

// TEST P/Q/R (revisión final) — techo técnico de distancia
describe('TEST P/Q/R (revisión): techo técnico de distancia = 5000 km', () => {
    test('P: 5 km es válida', () => {
        expect(validarDistancia(true, 5).valido).toBe(true);
    });
    test('Q: 5000 km (el techo exacto) es válida', () => {
        expect(validarDistancia(true, 5000).valido).toBe(true);
    });
    test('R: 5001 km es inválida', () => {
        expect(validarDistancia(true, 5001).valido).toBe(false);
    });
});

// TEST S (revisión final)
describe('TEST S (revisión): regla dura de distancia OFF + valor NULL es válido', () => {
    test('distancia_maxima_km=null con la regla inactiva es coherente', () => {
        expect(validarDistancia(false, null).valido).toBe(true);
    });
    test('la configuración completa con distancia OFF + NULL pasa validarConfiguracion()', () => {
        const config = clonarConfiguracion(defaultV1, { regla_distancia_maxima_activa: false, distancia_maxima_km: null });
        expect(validarConfiguracion(config)).toEqual({ valido: true });
    });
});

// TEST J
describe('TEST J: Provincial A/B/C con B→A→C es válido', () => {
    test('matriz futura hipotética con 3 categorías elegibles', () => {
        const r = validarMatrizClasificacion('provincial', [
            { categoria: 'B', elegible: true, orden_preferencia: 1 },
            { categoria: 'A', elegible: true, orden_preferencia: 2 },
            { categoria: 'C', elegible: true, orden_preferencia: 3 }
        ]);
        expect(r).toEqual({ valido: true });
    });
});

// TEST K
describe('TEST K: duplicado de categoría inválido', () => {
    test('la misma categoría aparece dos veces en la misma clasificación', () => {
        const r = validarMatrizClasificacion('provincial', [
            { categoria: 'A', elegible: true, orden_preferencia: 1 },
            { categoria: 'A', elegible: true, orden_preferencia: 2 }
        ]);
        expect(r.valido).toBe(false);
    });
});

// TEST L
describe('TEST L: categoría no elegible con orden es inválido', () => {
    test('elegible=false pero con orden_preferencia asignado', () => {
        const r = validarMatrizClasificacion('provincial', [
            { categoria: 'A', elegible: true, orden_preferencia: 1 },
            { categoria: 'C', elegible: false, orden_preferencia: 2 }
        ]);
        expect(r.valido).toBe(false);
    });
});

// TEST M
describe('TEST M: categoría elegible sin orden es inválida', () => {
    test('elegible=true sin orden_preferencia', () => {
        const r = validarMatrizClasificacion('provincial', [
            { categoria: 'A', elegible: true, orden_preferencia: null }
        ]);
        expect(r.valido).toBe(false);
    });
});

// TEST N
describe('TEST N: orden con hueco es inválido', () => {
    test('elegibles con posiciones 1 y 3 (falta la 2), con las 3 categorías presentes', () => {
        const r = validarMatrizClasificacion('provincial', [
            { categoria: 'A', elegible: true, orden_preferencia: 1 },
            { categoria: 'B', elegible: true, orden_preferencia: 3 },
            { categoria: 'C', elegible: false, orden_preferencia: null }
        ]);
        expect(r.valido).toBe(false);
    });
});

// TEST O
describe('TEST O: 0 criterios de ranking activos es inválido', () => {
    test('nunca permitir que el ganador dependa solo del desempate por jurado_id', () => {
        const r = validarOrdenCriterios([]);
        expect(r.valido).toBe(false);
    });
});

// TEST P
describe('TEST P: criterio de ranking desconocido es inválido', () => {
    test('código fuera de los 3 conocidos', () => {
        const r = validarOrdenCriterios([{ criterio_codigo: 'EQUIDAD_REGIONAL', orden: 1 }]);
        expect(r.valido).toBe(false);
    });
});

// TEST Q
describe('TEST Q: distancia <= 0 inválida cuando la regla está activa', () => {
    test('0 km', () => {
        expect(validarDistancia(true, 0).valido).toBe(false);
    });
    test('negativa', () => {
        expect(validarDistancia(true, -50).valido).toBe(false);
    });
    test('no numérica', () => {
        expect(validarDistancia(true, 'abc').valido).toBe(false);
    });
    test('sobre el techo técnico (5000 km) es inválida', () => {
        expect(validarDistancia(true, 6000).valido).toBe(false);
    });
    test('un valor pequeño y legítimo (5 km) es válido — no hay mínimo de negocio oculto', () => {
        expect(validarDistancia(true, 5).valido).toBe(true);
    });
});

// TEST R/S/T
describe('TEST R/S/T: configuracionRequiereDistancia', () => {
    test('R: regla dura OFF + ranking distancia ON → true', () => {
        const c = { regla_distancia_maxima_activa: false, ordenCriterios: [{ criterio_codigo: 'MENOR_DISTANCIA', orden: 1 }] };
        expect(configuracionRequiereDistancia(c)).toBe(true);
    });
    test('S: regla dura ON + ranking distancia OFF → true', () => {
        const c = { regla_distancia_maxima_activa: true, ordenCriterios: [{ criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 }] };
        expect(configuracionRequiereDistancia(c)).toBe(true);
    });
    test('T: ambos OFF → false', () => {
        const c = { regla_distancia_maxima_activa: false, ordenCriterios: [{ criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 }] };
        expect(configuracionRequiereDistancia(c)).toBe(false);
    });
});

// TEST U — actualizado por la mejora "Zonas Extremas": schema_version=3
// ahora también es un valor SOPORTADO (mismo patrón que schema_version=2 lo
// fue con "Equidad de Traslados") — ver SCHEMA_VERSIONES_SOPORTADAS y
// CRITERIOS_CONOCIDOS_POR_SCHEMA. Lo que sigue siendo inválido es cualquier
// schema_version FUERA de [1, 2, 3] (se usa 4 como ejemplo de "desconocido"
// — 3 dejó de serlo con esta mejora, exactamente el mismo tipo de
// actualización de expectativa que ya ocurrió acá cuando 2 se volvió válido).
describe('TEST U: schema_version desconocido (fuera de [1, 2, 3]) es inválido', () => {
    test('validarOrdenCriterios rechaza schema_version 4 (no soportado)', () => {
        const r = validarOrdenCriterios([{ criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 }], 4);
        expect(r.valido).toBe(false);
    });
    test('validarConfiguracion rechaza schema_version 4 (no soportado)', () => {
        const config = { ...defaultV1, schema_version: 4 };
        expect(validarConfiguracion(config).valido).toBe(false);
    });
    // Confirma explícitamente que schema_version=2 SÍ es válido desde la
    // mejora "Equidad de Traslados", incluso usando solo los 3 criterios de
    // siempre (sin activar equidad de traslados): schema_version=2 es un
    // SUPERCONJUNTO compatible de schema_version=1, nunca una ruptura.
    test('validarOrdenCriterios acepta schema_version=2 con los 3 criterios de siempre', () => {
        const r = validarOrdenCriterios([{ criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 }], 2);
        expect(r.valido).toBe(true);
    });
    test('validarConfiguracion acepta schema_version=2 sin equidad de traslados activa', () => {
        const config = { ...defaultV1, schema_version: 2 };
        expect(validarConfiguracion(config)).toEqual({ valido: true });
    });
    // Nuevo — confirma explícitamente que schema_version=3 SÍ es válido desde
    // la mejora "Zonas Extremas", incluso sin activar la regla especial:
    // schema_version=3 es un SUPERCONJUNTO compatible de schema_version=2
    // (incluye EQUIDAD_TRASLADOS), nunca una ruptura.
    test('validarOrdenCriterios acepta schema_version=3 con los 3 criterios de siempre', () => {
        const r = validarOrdenCriterios([{ criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 }], 3);
        expect(r.valido).toBe(true);
    });
    test('validarConfiguracion acepta schema_version=3 sin zonas extremas ni equidad de traslados activas', () => {
        const config = { ...defaultV1, schema_version: 3 };
        expect(validarConfiguracion(config)).toEqual({ valido: true });
    });
});

// TEST V
describe('TEST V: matriz incompleta es inválida', () => {
    test('falta una clasificación conocida', () => {
        const matrizIncompleta = { ...defaultV1.matriz };
        delete matrizIncompleta.nacional;
        const r = validarMatrizCompleta(matrizIncompleta);
        expect(r.valido).toBe(false);
    });
    test('clasificación desconocida en la matriz', () => {
        const matrizConExtra = { ...defaultV1.matriz, provincial_femenino: [{ categoria: 'A', elegible: true, orden_preferencia: 1 }] };
        const r = validarMatrizCompleta(matrizConExtra);
        expect(r.valido).toBe(false);
    });
});

// TEST W
describe('TEST W: clonar/versionar no muta el origen', () => {
    test('clonarConfiguracion no modifica configBase ni sus anidados', () => {
        const base = construirConfiguracionDefaultV1();
        const copiaJson = JSON.stringify(base);
        const clon = clonarConfiguracion(base, { distancia_maxima_km: 450 });

        expect(JSON.stringify(base)).toBe(copiaJson); // base intacta
        expect(clon.distancia_maxima_km).toBe(450);
        expect(base.distancia_maxima_km).toBe(600);
    });
    test('modificar el resultado clonado no afecta al original (sin referencias compartidas)', () => {
        const base = construirConfiguracionDefaultV1();
        const clon = clonarConfiguracion(base, {});
        clon.ordenCriterios.push({ criterio_codigo: 'MENOR_DISTANCIA', orden: 99 });
        expect(base.ordenCriterios.length).toBe(3);
    });
});

// TEST X
describe('TEST X: el default se serializa y reconstruye sin pérdida', () => {
    test('JSON.stringify → JSON.parse produce una estructura idéntica', () => {
        const base = construirConfiguracionDefaultV1();
        const reconstruido = JSON.parse(JSON.stringify(base));
        expect(reconstruido).toEqual(base);
    });
});

// ─── Cobertura adicional explícitamente pedida en el análisis previo ──────

describe('validarOrdenCriterios: duplicados de código y de orden', () => {
    test('criterio duplicado', () => {
        const r = validarOrdenCriterios([
            { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 },
            { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 2 }
        ]);
        expect(r.valido).toBe(false);
    });
    test('orden duplicado entre dos criterios distintos', () => {
        const r = validarOrdenCriterios([
            { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 },
            { criterio_codigo: 'MENOR_DISTANCIA', orden: 1 }
        ]);
        expect(r.valido).toBe(false);
    });
    test('1 solo criterio activo es válido (mínimo permitido)', () => {
        const r = validarOrdenCriterios([{ criterio_codigo: 'MENOR_DISTANCIA', orden: 1 }]);
        expect(r).toEqual({ valido: true });
    });
});

describe('compararConfiguraciones', () => {
    test('sin diferencias entre una configuración y sí misma', () => {
        const r = compararConfiguraciones(defaultV1, defaultV1);
        expect(r.hayDiferencias).toBe(false);
    });
    test('detecta un cambio escalar', () => {
        const otra = clonarConfiguracion(defaultV1, { distancia_maxima_km: 450 });
        const r = compararConfiguraciones(defaultV1, otra);
        expect(r.hayDiferencias).toBe(true);
        expect(r.cambios.find(c => c.campo === 'distancia_maxima_km')).toEqual({ campo: 'distancia_maxima_km', anterior: 600, nuevo: 450 });
    });
    test('detecta un cambio en el orden de criterios', () => {
        const otra = clonarConfiguracion(defaultV1, {
            ordenCriterios: [
                { criterio_codigo: 'MENOR_DISTANCIA', orden: 1 },
                { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 2 },
                { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 3 }
            ]
        });
        const r = compararConfiguraciones(defaultV1, otra);
        expect(r.cambios.some(c => c.campo === 'ordenCriterios')).toBe(true);
    });
});

describe('constantes conocidas', () => {
    test('SCHEMA_VERSION_SOPORTADO es 1', () => {
        expect(SCHEMA_VERSION_SOPORTADO).toBe(1);
    });
    test('CRITERIOS_CONOCIDOS tiene exactamente los 3 códigos', () => {
        expect(CRITERIOS_CONOCIDOS.sort()).toEqual(['MENOR_DISTANCIA', 'MENOS_DESIGNACIONES_TEMPORADA', 'PRIORIDAD_CATEGORIA'].sort());
    });
});

// ─── El SQL de la migración 050 refleja el mismo diseño que este servicio ──
describe('migración 050 — coherencia con el servicio puro', () => {
    const sqlPath = path.join(__dirname, '../../../database/migrations/050_configuracion_propuesta_designacion.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    test('contiene los 3 códigos de criterio conocidos en el CHECK', () => {
        CRITERIOS_CONOCIDOS.forEach(codigo => expect(sql).toContain(codigo));
    });
    test('no crea backfill de configuracion_version_id en propuestas_designacion', () => {
        expect(sql).not.toMatch(/UPDATE\s+propuestas_designacion\s+SET[^;]*configuracion_version_id/i);
    });
    test('el seed de la matriz se limita a una copia verificada de clasificacion_categoria_matriz (no inventa valores)', () => {
        expect(sql).toMatch(/RAISE EXCEPTION/);
        expect(sql).toMatch(/FROM clasificacion_categoria_matriz/);
    });
    test('la función de activación revoca el acceso público/anon/authenticated y lo otorga a service_role', () => {
        expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.activar_configuracion_designacion\(UUID\) FROM PUBLIC/);
        expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.activar_configuracion_designacion\(UUID\) FROM anon/);
        expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.activar_configuracion_designacion\(UUID\) FROM authenticated/);
        expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.activar_configuracion_designacion\(UUID\) TO service_role/);
    });
    test('la matriz versionada exige 18 filas (6 clasificaciones × 3 categorías) antes de activar', () => {
        expect(sql).toMatch(/v_count_matriz\s*<>\s*18/);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// ETAPA 3 — reconstruirConfiguracionDesdeFilas: filas de BD → configuración
// tipada. Fixture de filas EQUIVALENTES a las que produjo el seed de la
// migración 050 (verificadas en vivo) — reconstruida, debe ser
// funcionalmente idéntica a construirConfiguracionDefaultV1() (sección 31
// del pedido: "test de reconstrucción de V1").
// ═════════════════════════════════════════════════════════════════════════
describe('Etapa 3 — reconstruirConfiguracionDesdeFilas: equivalencia V1 BD vs Default V1', () => {
    // Fila de configuracion_designacion_versiones tal cual la devuelve
    // Supabase hoy para V1 — incluyendo distancia_maxima_km como STRING
    // ("600"), que es el tipo real observado en producción para una columna
    // NUMERIC servida por PostgREST.
    const versionRowV1 = {
        id: 'v1-uuid', numero_version: 1, schema_version: 1,
        regla_distancia_maxima_activa: true, distancia_maxima_km: '600',
        regla_no_repetir_asociacion_activa: true, regla_un_rodeo_por_finde_activa: true,
        regla_finde_consecutivo_activa: true, regla_asociacion_organizadora_activa: true
    };
    const criteriosRowsV1 = [
        { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 },
        { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 2 },
        { criterio_codigo: 'MENOR_DISTANCIA', orden: 3 }
    ];
    // 18 filas — mismo dato real verificado en BD (11 elegibles, 7 no elegibles).
    const matrizRowsV1 = [
        { clasificacion_codigo: 'interclubes', categoria: 'A', elegible: false, orden_preferencia: null },
        { clasificacion_codigo: 'interclubes', categoria: 'B', elegible: true, orden_preferencia: 2 },
        { clasificacion_codigo: 'interclubes', categoria: 'C', elegible: true, orden_preferencia: 1 },
        { clasificacion_codigo: 'provincial', categoria: 'A', elegible: true, orden_preferencia: 2 },
        { clasificacion_codigo: 'provincial', categoria: 'B', elegible: true, orden_preferencia: 1 },
        { clasificacion_codigo: 'provincial', categoria: 'C', elegible: false, orden_preferencia: null },
        { clasificacion_codigo: 'interasociaciones', categoria: 'A', elegible: true, orden_preferencia: 1 },
        { clasificacion_codigo: 'interasociaciones', categoria: 'B', elegible: true, orden_preferencia: 2 },
        { clasificacion_codigo: 'interasociaciones', categoria: 'C', elegible: false, orden_preferencia: null },
        { clasificacion_codigo: 'zonal', categoria: 'A', elegible: true, orden_preferencia: 1 },
        { clasificacion_codigo: 'zonal', categoria: 'B', elegible: true, orden_preferencia: 2 },
        { clasificacion_codigo: 'zonal', categoria: 'C', elegible: false, orden_preferencia: null },
        { clasificacion_codigo: 'clasificatorio', categoria: 'A', elegible: true, orden_preferencia: 1 },
        { clasificacion_codigo: 'clasificatorio', categoria: 'B', elegible: true, orden_preferencia: 2 },
        { clasificacion_codigo: 'clasificatorio', categoria: 'C', elegible: false, orden_preferencia: null },
        { clasificacion_codigo: 'nacional', categoria: 'A', elegible: true, orden_preferencia: 1 },
        { clasificacion_codigo: 'nacional', categoria: 'B', elegible: false, orden_preferencia: null },
        { clasificacion_codigo: 'nacional', categoria: 'C', elegible: false, orden_preferencia: null }
    ];

    test('la configuración reconstruida es funcionalmente idéntica a construirConfiguracionDefaultV1()', () => {
        const reconstruida = reconstruirConfiguracionDesdeFilas(versionRowV1, criteriosRowsV1, matrizRowsV1);
        const { schema_version, regla_distancia_maxima_activa, distancia_maxima_km,
            regla_no_repetir_asociacion_activa, regla_un_rodeo_por_finde_activa,
            regla_finde_consecutivo_activa, regla_asociacion_organizadora_activa,
            ordenCriterios, matriz } = defaultV1;
        expect(reconstruida).toEqual({
            schema_version, regla_distancia_maxima_activa, distancia_maxima_km,
            regla_no_repetir_asociacion_activa, regla_un_rodeo_por_finde_activa,
            regla_finde_consecutivo_activa, regla_asociacion_organizadora_activa,
            ordenCriterios, matriz
        });
    });
    test('distancia_maxima_km se normaliza de string ("600") a number (600)', () => {
        const reconstruida = reconstruirConfiguracionDesdeFilas(versionRowV1, criteriosRowsV1, matrizRowsV1);
        expect(reconstruida.distancia_maxima_km).toBe(600);
        expect(typeof reconstruida.distancia_maxima_km).toBe('number');
    });
    test('distancia_maxima_km NULL se preserva como null (nunca se convierte a 0)', () => {
        const versionSinDistancia = { ...versionRowV1, regla_distancia_maxima_activa: false, distancia_maxima_km: null };
        const reconstruida = reconstruirConfiguracionDesdeFilas(versionSinDistancia, criteriosRowsV1, matrizRowsV1);
        expect(reconstruida.distancia_maxima_km).toBeNull();
    });
    test('la reconstrucción pasa validarConfiguracion()', () => {
        const reconstruida = reconstruirConfiguracionDesdeFilas(versionRowV1, criteriosRowsV1, matrizRowsV1);
        expect(validarConfiguracion(reconstruida)).toEqual({ valido: true });
    });
});

// ═════════════════════════════════════════════════════════════════════════
// ETAPA 4 — aplanarMatriz (inverso de reconstruirConfiguracionDesdeFilas) y
// construirResumenParaUI.
// ═════════════════════════════════════════════════════════════════════════
describe('Etapa 4 — aplanarMatriz', () => {
    test('produce 18 filas a partir de la matriz de Default V1, ida y vuelta idéntica a reconstruirConfiguracionDesdeFilas', () => {
        const filas = aplanarMatriz(defaultV1.matriz);
        expect(filas).toHaveLength(18);
        const porClasifCategoria = {};
        filas.forEach(f => { porClasifCategoria[`${f.clasificacion_codigo}:${f.categoria}`] = f; });
        expect(porClasifCategoria['provincial:A']).toEqual({ clasificacion_codigo: 'provincial', categoria: 'A', elegible: true, orden_preferencia: 2 });
        expect(porClasifCategoria['provincial:B']).toEqual({ clasificacion_codigo: 'provincial', categoria: 'B', elegible: true, orden_preferencia: 1 });
        expect(porClasifCategoria['provincial:C']).toEqual({ clasificacion_codigo: 'provincial', categoria: 'C', elegible: false, orden_preferencia: null });
    });
    test('una categoría no elegible siempre aplana con orden_preferencia null, aunque el objeto de entrada traiga otra cosa por error', () => {
        const matriz = { ...defaultV1.matriz, nacional: [
            { categoria: 'A', elegible: true, orden_preferencia: 1 },
            { categoria: 'B', elegible: false, orden_preferencia: 99 }, // valor espurio — debe ignorarse
            { categoria: 'C', elegible: false, orden_preferencia: null }
        ] };
        const filas = aplanarMatriz(matriz);
        const filaB = filas.find(f => f.clasificacion_codigo === 'nacional' && f.categoria === 'B');
        expect(filaB.orden_preferencia).toBeNull();
    });
    test('objeto vacío/null → array vacío, sin lanzar error', () => {
        expect(aplanarMatriz(null)).toEqual([]);
        expect(aplanarMatriz({})).toEqual([]);
    });
    test('Provincial A/B/C con orden B→A→C se aplana preservando exactamente ese orden', () => {
        const matriz = { ...defaultV1.matriz, provincial: [
            { categoria: 'A', elegible: true, orden_preferencia: 2 },
            { categoria: 'B', elegible: true, orden_preferencia: 1 },
            { categoria: 'C', elegible: true, orden_preferencia: 3 }
        ] };
        const filas = aplanarMatriz(matriz).filter(f => f.clasificacion_codigo === 'provincial');
        expect(filas.sort((a, b) => a.orden_preferencia - b.orden_preferencia).map(f => f.categoria)).toEqual(['B', 'A', 'C']);
    });
});

describe('Etapa 4 — construirResumenParaUI', () => {
    test('extrae id/numero_version de meta y las 5 reglas booleanas + códigos de criterio en orden, de la configuración', () => {
        const resumen = construirResumenParaUI(defaultV1, { id: 'v1-uuid', numero_version: 1 });
        expect(resumen).toEqual({
            id: 'v1-uuid', numero_version: 1,
            regla_distancia_maxima_activa: true, distancia_maxima_km: 600,
            regla_no_repetir_asociacion_activa: true, regla_un_rodeo_por_finde_activa: true,
            regla_finde_consecutivo_activa: true, regla_asociacion_organizadora_activa: true,
            orden_criterios_codigos: ['PRIORIDAD_CATEGORIA', 'MENOS_DESIGNACIONES_TEMPORADA', 'MENOR_DISTANCIA']
        });
    });
    // Revisión final Etapa 4, sección 18: estas 4 reglas booleanas están acá
    // exactamente para que la UI sepa si checks.no_repite_asociacion/
    // sin_rodeo_mismo_finde/sin_finde_consecutivo/asociacion_diferente
    // (motorPropuestaDesignacion.js) corresponden a una regla realmente
    // activa — sin esto no hay forma de distinguir "cumplida" de "regla
    // desactivada, el dato no aplica".
    test('con las 4 reglas booleanas desactivadas, el resumen las refleja en false (nunca las omite ni las fuerza a true)', () => {
        const config = clonarConfiguracion(defaultV1, {
            regla_no_repetir_asociacion_activa: false, regla_un_rodeo_por_finde_activa: false,
            regla_finde_consecutivo_activa: false, regla_asociacion_organizadora_activa: false
        });
        const resumen = construirResumenParaUI(config, { id: 'v2-uuid', numero_version: 2 });
        expect(resumen.regla_no_repetir_asociacion_activa).toBe(false);
        expect(resumen.regla_un_rodeo_por_finde_activa).toBe(false);
        expect(resumen.regla_finde_consecutivo_activa).toBe(false);
        expect(resumen.regla_asociacion_organizadora_activa).toBe(false);
    });
    test('respeta el orden real aunque ordenCriterios venga desordenado en el objeto', () => {
        const config = clonarConfiguracion(defaultV1, {
            ordenCriterios: [
                { criterio_codigo: 'MENOR_DISTANCIA', orden: 1 },
                { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 2 }
            ]
        });
        const resumen = construirResumenParaUI(config, { id: 'x', numero_version: 9 });
        expect(resumen.orden_criterios_codigos).toEqual(['MENOR_DISTANCIA', 'PRIORIDAD_CATEGORIA']);
    });
    test('configuracion/meta ausentes → no lanza, campos en null/vacío', () => {
        expect(construirResumenParaUI(null, null)).toEqual({
            id: null, numero_version: null, regla_distancia_maxima_activa: null, distancia_maxima_km: null,
            regla_no_repetir_asociacion_activa: null, regla_un_rodeo_por_finde_activa: null,
            regla_finde_consecutivo_activa: null, regla_asociacion_organizadora_activa: null,
            orden_criterios_codigos: []
        });
    });
});

// ═════════════════════════════════════════════════════════════════════════
// Mejora "Equidad de Traslados" — schema_version=2, regla_equidad_traslados_
// activa, umbral_lejania_km, criterio EQUIDAD_TRASLADOS, clasificarTraslado().
// V1/schema_version=1 no se toca — estos tests cubren específicamente el
// comportamiento NUEVO y su convivencia con lo existente.
// ═════════════════════════════════════════════════════════════════════════

describe('Equidad de Traslados — clasificarTraslado (CERCA/LEJOS)', () => {
    test('350 km exactos = CERCA (umbral inclusivo)', () => {
        expect(clasificarTraslado(350, 350)).toBe('CERCA');
    });
    test('350.1 km = LEJOS', () => {
        expect(clasificarTraslado(350.1, 350)).toBe('LEJOS');
    });
    test('174 km = CERCA', () => {
        expect(clasificarTraslado(174, 350)).toBe('CERCA');
    });
    test('850 km = LEJOS', () => {
        expect(clasificarTraslado(850, 350)).toBe('LEJOS');
    });
    test('1200 km = LEJOS', () => {
        expect(clasificarTraslado(1200, 350)).toBe('LEJOS');
    });
    test('distancia null (sin comuna resoluble) -> null', () => {
        expect(clasificarTraslado(null, 350)).toBeNull();
    });
    test('umbral null/undefined -> null (no clasifica sin umbral configurado)', () => {
        expect(clasificarTraslado(100, null)).toBeNull();
        expect(clasificarTraslado(100, undefined)).toBeNull();
    });
});

describe('Equidad de Traslados — validarUmbralLejania', () => {
    test('regla inactiva -> siempre valido, cualquier valor (incluso ausente)', () => {
        expect(validarUmbralLejania(false, undefined)).toEqual({ valido: true });
        expect(validarUmbralLejania(false, null)).toEqual({ valido: true });
        expect(validarUmbralLejania(false, -5)).toEqual({ valido: true });
    });
    test('regla activa + umbral ausente -> invalido', () => {
        expect(validarUmbralLejania(true, null).valido).toBe(false);
        expect(validarUmbralLejania(true, undefined).valido).toBe(false);
    });
    test('regla activa + umbral <= 0 -> invalido', () => {
        expect(validarUmbralLejania(true, 0).valido).toBe(false);
        expect(validarUmbralLejania(true, -10).valido).toBe(false);
    });
    test('regla activa + umbral > techo tecnico -> invalido', () => {
        expect(validarUmbralLejania(true, 5001).valido).toBe(false);
    });
    test('regla activa + umbral valido (350) -> valido', () => {
        expect(validarUmbralLejania(true, 350)).toEqual({ valido: true });
    });
});

describe('Equidad de Traslados — criteriosConocidosParaSchema / CRITERIOS_CONOCIDOS_POR_SCHEMA', () => {
    test('schema_version=1 NO incluye EQUIDAD_TRASLADOS (significado historico intacto)', () => {
        expect(criteriosConocidosParaSchema(1)).toEqual(CRITERIOS_CONOCIDOS);
        expect(criteriosConocidosParaSchema(1)).not.toContain('EQUIDAD_TRASLADOS');
    });
    test('schema_version=2 incluye los 3 de siempre MAS EQUIDAD_TRASLADOS', () => {
        const c2 = criteriosConocidosParaSchema(2);
        expect(c2).toEqual(expect.arrayContaining(CRITERIOS_CONOCIDOS));
        expect(c2).toContain('EQUIDAD_TRASLADOS');
        expect(c2).toHaveLength(CRITERIOS_CONOCIDOS.length + 1);
    });
    test('SCHEMA_VERSIONES_SOPORTADAS = [1, 2, 3] (3 agregado por la mejora "Zonas Extremas")', () => {
        expect(SCHEMA_VERSIONES_SOPORTADAS).toEqual([1, 2, 3]);
    });
    test('schema_version=3 incluye los mismos criterios que schema_version=2 (Zonas Extremas no agrega ningun criterio de ranking)', () => {
        expect(criteriosConocidosParaSchema(3)).toEqual(criteriosConocidosParaSchema(2));
    });
});

describe('Equidad de Traslados — validarConfiguracion (compatibilidad V1 y reglas nuevas)', () => {
    test('schema_version=1 con regla_equidad_traslados_activa=true es RECHAZADO -- V1 no puede activar equidad', () => {
        const config = { ...defaultV1, schema_version: 1, regla_equidad_traslados_activa: true, umbral_lejania_km: 350 };
        const r = validarConfiguracion(config);
        expect(r.valido).toBe(false);
        expect(r.error).toMatch(/schema_version=2/);
    });
    test('schema_version=1 default V1 tal cual (sin tocar) sigue siendo valida', () => {
        expect(validarConfiguracion(defaultV1)).toEqual({ valido: true });
    });
    // Decisión de negocio (revisión de cierre): "SIEMPRE preferir cercanía"
    // exige que EQUIDAD_TRASLADOS sea SIEMPRE el criterio Nº1 mientras la
    // regla esté activa — nunca en una posición posterior.
    test('schema_version=2 con EQUIDAD_TRASLADOS activo, umbral y en orden=1 -> valido', () => {
        const config = {
            ...defaultV1,
            schema_version: 2,
            regla_equidad_traslados_activa: true,
            umbral_lejania_km: 350,
            ordenCriterios: [
                { criterio_codigo: 'EQUIDAD_TRASLADOS', orden: 1 },
                { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 2 },
                { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 3 },
                { criterio_codigo: 'MENOR_DISTANCIA', orden: 4 }
            ]
        };
        expect(validarConfiguracion(config)).toEqual({ valido: true });
    });
    // Regresión del bug "CONFIGURACION_DESIGNACION_INVALIDA" al guardar
    // Schema3 desde la V2 real (diagnóstico previo a la migración 054): a
    // nivel de validarConfiguracion() (JS) esta combinación YA era válida
    // desde que se agregó schema_version=3 en 053 — el bug real vivía
    // exclusivamente en un CHECK de la tabla en Postgres
    // (chk_config_designacion_equidad_requiere_schema2, migración 052, nunca
    // ampliado a schema3), invisible para este test porque valida solo la
    // capa de aplicación, nunca la base de datos real. Este test documenta
    // que la capa JS nunca tuvo el bug — la migración 054 corrige la capa SQL.
    test('schema_version=3 con EQUIDAD_TRASLADOS activo, umbral y en orden=1 -> valido (Zonas Extremas es ortogonal)', () => {
        const config = {
            ...defaultV1,
            schema_version: 3,
            regla_equidad_traslados_activa: true,
            umbral_lejania_km: 350,
            ordenCriterios: [
                { criterio_codigo: 'EQUIDAD_TRASLADOS', orden: 1 },
                { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 2 },
                { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 3 },
                { criterio_codigo: 'MENOR_DISTANCIA', orden: 4 }
            ]
        };
        expect(validarConfiguracion(config)).toEqual({ valido: true });
    });
    test('schema_version=2 con EQUIDAD_TRASLADOS activo pero en orden=2 (no Nº1) -> INVALIDO', () => {
        const config = {
            ...defaultV1,
            schema_version: 2,
            regla_equidad_traslados_activa: true,
            umbral_lejania_km: 350,
            ordenCriterios: [
                { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 },
                { criterio_codigo: 'EQUIDAD_TRASLADOS', orden: 2 },
                { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 3 },
                { criterio_codigo: 'MENOR_DISTANCIA', orden: 4 }
            ]
        };
        const r = validarConfiguracion(config);
        expect(r.valido).toBe(false);
        expect(r.error).toMatch(/Nº1/);
    });
    test('regla_equidad_traslados_activa=true pero EQUIDAD_TRASLADOS ausente del orden -> invalido', () => {
        const config = {
            ...defaultV1, schema_version: 2, regla_equidad_traslados_activa: true, umbral_lejania_km: 350,
            ordenCriterios: [{ criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 }]
        };
        const r = validarConfiguracion(config);
        expect(r.valido).toBe(false);
        expect(r.error).toMatch(/EQUIDAD_TRASLADOS/);
    });
    test('EQUIDAD_TRASLADOS en el orden de criterios SIN regla_equidad_traslados_activa -> invalido (estado inconsistente)', () => {
        const config = {
            ...defaultV1,
            schema_version: 2,
            regla_equidad_traslados_activa: false,
            ordenCriterios: [
                { criterio_codigo: 'EQUIDAD_TRASLADOS', orden: 1 },
                { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 2 }
            ]
        };
        const r = validarConfiguracion(config);
        expect(r.valido).toBe(false);
        expect(r.error).toMatch(/EQUIDAD_TRASLADOS/);
    });
    test('regla_equidad_traslados_activa=true sin umbral_lejania_km -> invalido', () => {
        const config = {
            ...defaultV1, schema_version: 2, regla_equidad_traslados_activa: true, umbral_lejania_km: null,
            ordenCriterios: [{ criterio_codigo: 'EQUIDAD_TRASLADOS', orden: 1 }, { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 2 }]
        };
        expect(validarConfiguracion(config).valido).toBe(false);
    });
    test('schema_version=2 SIN equidad de traslados (regla_equidad_traslados_activa ausente) sigue exactamente igual a V1 en efecto', () => {
        const config = { ...defaultV1, schema_version: 2 };
        expect(validarConfiguracion(config)).toEqual({ valido: true });
        expect(configuracionRequiereDistancia(config)).toBe(true); // sigue siendo true SOLO por regla_distancia_maxima_activa/MENOR_DISTANCIA, como hoy
    });
});

describe('Equidad de Traslados — configuracionRequiereDistancia', () => {
    test('regla_equidad_traslados_activa=true por si sola ya requiere distancia (aunque distancia_maxima/MENOR_DISTANCIA esten OFF)', () => {
        const c = {
            regla_distancia_maxima_activa: false, regla_equidad_traslados_activa: true,
            ordenCriterios: [{ criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 }, { criterio_codigo: 'EQUIDAD_TRASLADOS', orden: 2 }]
        };
        expect(configuracionRequiereDistancia(c)).toBe(true);
    });
    test('todas las fuentes de distancia OFF (incluida equidad) -> false', () => {
        const c = {
            regla_distancia_maxima_activa: false, regla_equidad_traslados_activa: false,
            ordenCriterios: [{ criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 }]
        };
        expect(configuracionRequiereDistancia(c)).toBe(false);
    });
});

describe('Equidad de Traslados — reconstruirConfiguracionDesdeFilas / construirResumenParaUI: compatibilidad de forma', () => {
    const versionRowV1SinEquidad = {
        id: 'v1-uuid', numero_version: 1, schema_version: 1,
        regla_distancia_maxima_activa: true, distancia_maxima_km: '600',
        regla_no_repetir_asociacion_activa: true, regla_un_rodeo_por_finde_activa: true,
        regla_finde_consecutivo_activa: true, regla_asociacion_organizadora_activa: true
        // sin regla_equidad_traslados_activa/umbral_lejania_km -- simula una fila de BD ANTES de aplicar la migracion 052.
    };
    test('una fila de BD sin columnas de equidad no agrega esas claves al objeto reconstruido', () => {
        const reconstruida = reconstruirConfiguracionDesdeFilas(versionRowV1SinEquidad, [], []);
        expect('regla_equidad_traslados_activa' in reconstruida).toBe(false);
        expect('umbral_lejania_km' in reconstruida).toBe(false);
    });
    test('una fila de BD CON columnas de equidad (schema_version=2) si las incluye, normalizando umbral a Number', () => {
        const versionRowV2 = { ...versionRowV1SinEquidad, schema_version: 2, regla_equidad_traslados_activa: true, umbral_lejania_km: '350' };
        const reconstruida = reconstruirConfiguracionDesdeFilas(versionRowV2, [], []);
        expect(reconstruida.regla_equidad_traslados_activa).toBe(true);
        expect(reconstruida.umbral_lejania_km).toBe(350);
        expect(typeof reconstruida.umbral_lejania_km).toBe('number');
    });
    test('construirResumenParaUI no agrega campos de equidad para una configuracion que no los trae (V1)', () => {
        const resumen = construirResumenParaUI(defaultV1, { id: 'v1-uuid', numero_version: 1 });
        expect('regla_equidad_traslados_activa' in resumen).toBe(false);
        expect('umbral_lejania_km' in resumen).toBe(false);
    });
    test('construirResumenParaUI incluye los campos de equidad cuando la configuracion los trae', () => {
        const config = { ...defaultV1, schema_version: 2, regla_equidad_traslados_activa: true, umbral_lejania_km: 350 };
        const resumen = construirResumenParaUI(config, { id: 'v2-uuid', numero_version: 2 });
        expect(resumen.regla_equidad_traslados_activa).toBe(true);
        expect(resumen.umbral_lejania_km).toBe(350);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// GATE final previa a 053: validarZonasExtremas() — separa ESTRUCTURAL
// (siempre, activa o no) de MÍNIMOS (solo si activa). Casos numerados según
// el pedido de este gate (secciones 7-24).
// ═════════════════════════════════════════════════════════════════════════
describe('validarZonasExtremas — datos latentes con regla OFF (ESTRUCTURAL siempre, MÍNIMOS solo si activa)', () => {
    const categoriasValidas = [
        { categoria: 'A', elegible: false, orden_preferencia: null },
        { categoria: 'B', elegible: true, orden_preferencia: 2 },
        { categoria: 'C', elegible: true, orden_preferencia: 1 }
    ];

    // TEST 17/7 — OFF con datos latentes ESTRUCTURALMENTE válidos -> válido.
    test('OFF + asociaciones/categorías latentes válidas (MAGALLANES, AYSÉN · C1 B2 Aoff) -> válido', () => {
        const r = validarZonasExtremas(false, { asociaciones: ['MAGALLANES', 'AYSÉN'], categorias: categoriasValidas });
        expect(r).toEqual({ valido: true });
    });

    // TEST 18/8 — OFF vacío -> válido (no exige contenido cuando está apagada).
    test('OFF + 0 asociaciones + 0 categorías -> válido', () => {
        expect(validarZonasExtremas(false, { asociaciones: [], categorias: [] })).toEqual({ valido: true });
        expect(validarZonasExtremas(false, {})).toEqual({ valido: true });
        expect(validarZonasExtremas(false, null)).toEqual({ valido: true });
    });

    // TEST 19/9 — OFF con orden duplicado -> rechazado (ESTRUCTURAL, no depende de la regla).
    test('OFF + categorías con orden_preferencia duplicado (C=1, B=1) -> rechazado', () => {
        const r = validarZonasExtremas(false, { asociaciones: [], categorias: [
            { categoria: 'A', elegible: false, orden_preferencia: null },
            { categoria: 'B', elegible: true, orden_preferencia: 1 },
            { categoria: 'C', elegible: true, orden_preferencia: 1 }
        ] });
        expect(r.valido).toBe(false);
    });

    // TEST 20/10 — OFF con hueco en el orden (1, 3 en vez de 1, 2) -> rechazado.
    // Este es el GAP REAL que existía: antes, con reglaActiva=false, la
    // función devolvía { valido: true } de inmediato sin llegar nunca a
    // revisar esto.
    test('OFF + categorías con hueco en el orden (C=1, B=3) -> rechazado', () => {
        const r = validarZonasExtremas(false, { asociaciones: [], categorias: [
            { categoria: 'A', elegible: false, orden_preferencia: null },
            { categoria: 'B', elegible: true, orden_preferencia: 3 },
            { categoria: 'C', elegible: true, orden_preferencia: 1 }
        ] });
        expect(r.valido).toBe(false);
    });

    // TEST 21/11 — OFF con categoría desconocida ('D') -> rechazado (ya lo
    // garantizaba validarMatrizClasificacion(), ahora también corre con OFF).
    test('OFF + categoría desconocida (D) -> rechazado', () => {
        const r = validarZonasExtremas(false, { asociaciones: [], categorias: [
            { categoria: 'A', elegible: false, orden_preferencia: null },
            { categoria: 'B', elegible: true, orden_preferencia: 2 },
            { categoria: 'D', elegible: true, orden_preferencia: 1 }
        ] });
        expect(r.valido).toBe(false);
    });

    // TEST 22/12 — OFF con categoría NO elegible pero con orden_preferencia
    // seteado -> rechazado.
    test('OFF + categoría no elegible con orden_preferencia distinto de null (A: elegible=false, orden=3) -> rechazado', () => {
        const r = validarZonasExtremas(false, { asociaciones: [], categorias: [
            { categoria: 'A', elegible: false, orden_preferencia: 3 },
            { categoria: 'B', elegible: true, orden_preferencia: 2 },
            { categoria: 'C', elegible: true, orden_preferencia: 1 }
        ] });
        expect(r.valido).toBe(false);
    });

    // TEST 23/13 — ON sin asociaciones -> rechazado (MÍNIMO, solo si activa).
    test('ON + 0 asociaciones -> rechazado', () => {
        const r = validarZonasExtremas(true, { asociaciones: [], categorias: categoriasValidas });
        expect(r.valido).toBe(false);
    });

    // TEST 24/14 — ON con asociaciones válidas pero 0 categorías elegibles -> rechazado.
    test('ON + asociaciones válidas + 0 categorías elegibles -> rechazado', () => {
        const r = validarZonasExtremas(true, { asociaciones: ['MAGALLANES'], categorias: [
            { categoria: 'A', elegible: false, orden_preferencia: null },
            { categoria: 'B', elegible: false, orden_preferencia: null },
            { categoria: 'C', elegible: false, orden_preferencia: null }
        ] });
        expect(r.valido).toBe(false);
    });

    // ON con datos completos y válidos -> válido (caso base, sección 6).
    test('ON + asociaciones válidas + categorías válidas -> válido', () => {
        const r = validarZonasExtremas(true, { asociaciones: ['MAGALLANES', 'AYSÉN'], categorias: categoriasValidas });
        expect(r).toEqual({ valido: true });
    });

    // Asociación duplicada NORMALIZADA con regla OFF -> rechazado (estructural,
    // sin depender de la regla — "AYSÉN"/"AYSEN" son la misma asociación).
    test('OFF + asociaciones duplicadas normalizadas (AYSÉN / AYSEN) -> rechazado', () => {
        const r = validarZonasExtremas(false, { asociaciones: ['AYSÉN', 'AYSEN'], categorias: [] });
        expect(r.valido).toBe(false);
    });

    // Gate final "normalización de asociaciones" — casos explícitos pedidos:
    // espacios, mayúsculas/minúsculas mezcladas, y con la regla ON (no solo OFF).
    test('"AYSÉN" vs " Aysén " (espacios alrededor) -> rechazado por duplicado normalizado', () => {
        const r = validarZonasExtremas(false, { asociaciones: ['AYSÉN', '  Aysén  '], categorias: [] });
        expect(r.valido).toBe(false);
    });
    test('mayúsculas/minúsculas mezcladas ("Magallanes" vs "MAGALLANES" vs "magallanes") -> rechazado', () => {
        const r = validarZonasExtremas(false, { asociaciones: ['Magallanes', 'MAGALLANES'], categorias: [] });
        expect(r.valido).toBe(false);
        const r2 = validarZonasExtremas(false, { asociaciones: ['Magallanes', 'magallanes'], categorias: [] });
        expect(r2.valido).toBe(false);
    });
    test('duplicado normalizado también se rechaza con la regla ON (no solo OFF)', () => {
        const r = validarZonasExtremas(true, { asociaciones: ['AYSÉN', 'AYSEN'], categorias: categoriasValidas });
        expect(r.valido).toBe(false);
    });
    test('asociación vacía o solo espacios -> rechazada (estructural, sin depender de la regla)', () => {
        expect(validarZonasExtremas(false, { asociaciones: [''], categorias: [] }).valido).toBe(false);
        expect(validarZonasExtremas(false, { asociaciones: ['   '], categorias: [] }).valido).toBe(false);
        expect(validarZonasExtremas(true, { asociaciones: ['   '], categorias: categoriasValidas }).valido).toBe(false);
    });
    // No-duplicado: asociaciones distintas de verdad (no solo variantes de
    // formato) nunca deben rechazarse por esto.
    test('asociaciones genuinamente distintas -> válido (no un falso positivo de duplicado)', () => {
        const r = validarZonasExtremas(false, { asociaciones: ['MAGALLANES', 'AYSÉN', 'CUYO'], categorias: [] });
        expect(r).toEqual({ valido: true });
    });
});

// TEST 25 — regresión explícita con snapshot de la V2 REAL de producción
// (id 0ac4f340-968b-4076-9687-1b13cd358d6b, numero_version=2): schema2,
// 1000km, EQUIDAD_TRASLADOS ON, 350km — sigue siendo válida sin exigir
// absolutamente ninguna fila de Zonas Extremas (el campo ni siquiera existe
// para schema2 en la forma reconstruida hoy, antes de aplicar 053).
describe('validarConfiguracion — regresión explícita con la V2 REAL de producción', () => {
    test('snapshot V2 real (schema2, 1000km, equidad 350km) sigue siendo válida, sin exigir Zonas Extremas', () => {
        const v2Real = clonarConfiguracion(construirConfiguracionDefaultV1(), {
            schema_version: 2,
            distancia_maxima_km: 1000,
            regla_equidad_traslados_activa: true,
            umbral_lejania_km: 350,
            ordenCriterios: [
                { criterio_codigo: 'EQUIDAD_TRASLADOS', orden: 1 },
                { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 2 },
                { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 3 },
                { criterio_codigo: 'MENOR_DISTANCIA', orden: 4 }
            ]
            // Sin regla_zonas_extremas_activa ni zonas_extremas — schema2 nunca los tiene.
        });
        expect(validarConfiguracion(v2Real)).toEqual({ valido: true });
    });
});
