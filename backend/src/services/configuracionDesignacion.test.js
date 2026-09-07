const fs = require('fs');
const path = require('path');
const {
    SCHEMA_VERSION_SOPORTADO, CRITERIOS_CONOCIDOS,
    validarDistancia, validarOrdenCriterios, validarMatrizClasificacion, validarMatrizCompleta,
    validarConfiguracion, configuracionRequiereDistancia,
    construirConfiguracionDefaultV1, clonarConfiguracion, compararConfiguraciones,
    reconstruirConfiguracionDesdeFilas
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

// TEST U
describe('TEST U: schema_version desconocido es inválido', () => {
    test('validarOrdenCriterios rechaza schema_version distinto de 1', () => {
        const r = validarOrdenCriterios([{ criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 }], 2);
        expect(r.valido).toBe(false);
    });
    test('validarConfiguracion rechaza schema_version distinto de 1', () => {
        const config = { ...defaultV1, schema_version: 2 };
        expect(validarConfiguracion(config).valido).toBe(false);
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
