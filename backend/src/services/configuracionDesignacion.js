// ═════════════════════════════════════════════════════════════════════════
// Configuración administrable de Propuesta de Designación — Etapa 1.
//
// PURO — sin acceso a base de datos, testeable directamente con Jest. Este
// archivo NO conecta con motorPropuestaDesignacion.js todavía (eso es
// Etapa 2, después de tests de equivalencia). Solo define la forma de una
// "configuración", sus valores default (Versión 1, equivalentes exactos al
// motor actual) y sus validaciones — mismo patrón de separación pura ya
// usado en temporadas.js/propuestaDesignacion.js.
//
// EL CÓDIGO define qué reglas sabe ejecutar el motor (los 3 criterios de
// ranking y las reglas duras ya existentes). LA CONFIGURACIÓN define cuáles
// están activas, sus parámetros, su orden y la matriz de categorías — nunca
// código, expresiones ni SQL arbitrario (principio explícito del proyecto).
// ═════════════════════════════════════════════════════════════════════════

// ─── Constantes conocidas para schema_version = 1 ─────────────────────────
// Cualquier regla/criterio nuevo requiere evolucionar SCHEMA_VERSION_SOPORTADO
// y estas listas explícitamente — nunca aceptar un código desconocido.
const SCHEMA_VERSION_SOPORTADO = 1;

const CRITERIOS_CONOCIDOS = ['PRIORIDAD_CATEGORIA', 'MENOS_DESIGNACIONES_TEMPORADA', 'MENOR_DISTANCIA'];

// Nombres visuales — SOLO para UI futura. Nunca se usan en lógica/validación
// (la lógica compara siempre por código estable, nunca por este texto).
const CRITERIO_NOMBRE_VISUAL = {
    PRIORIDAD_CATEGORIA: 'Prioridad de categoría',
    MENOS_DESIGNACIONES_TEMPORADA: 'Menos designaciones',
    MENOR_DISTANCIA: 'Menor distancia'
};

const CLASIFICACIONES_CONOCIDAS = ['interclubes', 'provincial', 'interasociaciones', 'zonal', 'clasificatorio', 'nacional'];
const CATEGORIAS_CONOCIDAS = ['A', 'B', 'C'];

// Techo técnico anti-error-de-tipeo para distancia_maxima_km — NO es una
// regla de negocio, es una protección contra escribir "6000" en vez de
// "600" o dejar un cero de más. 5000 km supera ampliamente cualquier
// distancia real dentro de Chile (el país mide del orden de 4300 km de
// extremo a extremo en línea recta), dejando margen sin convertirse en una
// política de designación oculta. NO se impone un mínimo arbitrario (10 km,
// etc.) — el administrador puede legítimamente configurar un rango chico;
// solo se exige > 0.
const DISTANCIA_MAXIMA_TECNICA_KM = 5000;

// ─── Validación de distancia_maxima_km ────────────────────────────────────
// Solo se exige un valor válido cuando la REGLA DURA está activa. Si está
// inactiva, cualquier valor (incluido null/undefined) es aceptado — puede
// conservarse un valor "apagado" para cuando se reactive más adelante.
function validarDistancia(reglaActiva, distanciaMaximaKm) {
    if (!reglaActiva) return { valido: true };
    if (distanciaMaximaKm === null || distanciaMaximaKm === undefined || distanciaMaximaKm === '') {
        return { valido: false, error: 'distancia_maxima_km es requerida cuando la regla de distancia máxima está activa' };
    }
    const n = Number(distanciaMaximaKm);
    if (Number.isNaN(n)) return { valido: false, error: 'distancia_maxima_km debe ser numérica' };
    if (n <= 0) return { valido: false, error: 'distancia_maxima_km debe ser mayor que 0' };
    if (n > DISTANCIA_MAXIMA_TECNICA_KM) {
        return { valido: false, error: `distancia_maxima_km supera el máximo técnico permitido (${DISTANCIA_MAXIMA_TECNICA_KM} km) — probable error de tipeo` };
    }
    return { valido: true };
}

// ─── Validación del orden global de criterios (Nivel 1) ───────────────────
// `ordenCriterios`: array de { criterio_codigo, orden } — SOLO los criterios
// ACTIVOS de esta configuración (un código ausente = inactivo, igual que en
// la migración 050). Exige: schema soportado, códigos conocidos, sin
// duplicados de código, sin duplicados de orden, secuencia 1..N sin huecos,
// y mínimo 1 criterio activo (nunca 0 — el ganador jamás debe depender
// únicamente del desempate final por jurado_id de forma accidental).
function validarOrdenCriterios(ordenCriterios, schemaVersion = SCHEMA_VERSION_SOPORTADO) {
    if (schemaVersion !== SCHEMA_VERSION_SOPORTADO) {
        return { valido: false, error: `schema_version no soportado: ${schemaVersion}` };
    }
    const lista = ordenCriterios || [];
    if (lista.length === 0) {
        return { valido: false, error: 'Debe haber al menos 1 criterio de ranking activo' };
    }

    const codigosVistos = new Set();
    const ordenesVistos = new Set();
    for (const c of lista) {
        if (!CRITERIOS_CONOCIDOS.includes(c.criterio_codigo)) {
            return { valido: false, error: `Criterio de ranking desconocido: ${c.criterio_codigo}` };
        }
        if (codigosVistos.has(c.criterio_codigo)) {
            return { valido: false, error: `Criterio duplicado: ${c.criterio_codigo}` };
        }
        codigosVistos.add(c.criterio_codigo);
        if (!Number.isInteger(c.orden) || c.orden <= 0) {
            return { valido: false, error: `Orden inválido para ${c.criterio_codigo}: ${c.orden}` };
        }
        if (ordenesVistos.has(c.orden)) {
            return { valido: false, error: `Orden duplicado: ${c.orden}` };
        }
        ordenesVistos.add(c.orden);
    }
    // Secuencia 1..N sin huecos.
    for (let i = 1; i <= lista.length; i++) {
        if (!ordenesVistos.has(i)) {
            return { valido: false, error: `El orden de criterios tiene un hueco: falta la posición ${i}` };
        }
    }
    return { valido: true };
}

// ─── Validación de la matriz de UNA clasificación ─────────────────────────
// `filas`: array de { categoria, elegible, orden_preferencia }. MODELO
// COMPLETO (revisión final): cada clasificación debe traer EXACTAMENTE las
// 3 categorías conocidas (A, B, C), cada una exactamente una vez — nunca se
// acepta que una categoría simplemente "no exista" como fila; una categoría
// no habilitada debe estar presente explícitamente como
// { elegible:false, orden_preferencia:null }. Esto deja lista la futura UI
// (☑/☐ por categoría) sin tener que crear una fila nueva al habilitar una
// categoría hoy inactiva — la fila ya existe, solo cambia de versión.
function validarMatrizClasificacion(clasificacionCodigo, filas) {
    const lista = filas || [];
    const categoriasVistas = new Set();
    const elegibles = [];

    for (const f of lista) {
        if (!CATEGORIAS_CONOCIDAS.includes(f.categoria)) {
            return { valido: false, error: `[${clasificacionCodigo}] categoría desconocida: ${f.categoria}` };
        }
        if (categoriasVistas.has(f.categoria)) {
            return { valido: false, error: `[${clasificacionCodigo}] categoría duplicada: ${f.categoria}` };
        }
        categoriasVistas.add(f.categoria);

        if (f.elegible) {
            if (!Number.isInteger(f.orden_preferencia) || f.orden_preferencia <= 0) {
                return { valido: false, error: `[${clasificacionCodigo}] categoría elegible ${f.categoria} sin orden_preferencia válido` };
            }
            elegibles.push(f);
        } else if (f.orden_preferencia !== null && f.orden_preferencia !== undefined) {
            return { valido: false, error: `[${clasificacionCodigo}] categoría ${f.categoria} no elegible no debe tener orden_preferencia` };
        }
    }

    if (lista.length !== CATEGORIAS_CONOCIDAS.length) {
        return { valido: false, error: `[${clasificacionCodigo}] debe tener exactamente las ${CATEGORIAS_CONOCIDAS.length} categorías conocidas (A, B, C) — tiene ${lista.length}` };
    }
    for (const cat of CATEGORIAS_CONOCIDAS) {
        if (!categoriasVistas.has(cat)) {
            return { valido: false, error: `[${clasificacionCodigo}] falta la categoría ${cat} (debe existir explícitamente, elegible o no)` };
        }
    }

    if (elegibles.length === 0) {
        return { valido: false, error: `[${clasificacionCodigo}] debe haber al menos 1 categoría elegible` };
    }

    const ordenesVistos = new Set();
    for (const f of elegibles) {
        if (ordenesVistos.has(f.orden_preferencia)) {
            return { valido: false, error: `[${clasificacionCodigo}] orden_preferencia duplicado: ${f.orden_preferencia}` };
        }
        ordenesVistos.add(f.orden_preferencia);
    }
    for (let i = 1; i <= elegibles.length; i++) {
        if (!ordenesVistos.has(i)) {
            return { valido: false, error: `[${clasificacionCodigo}] el orden de categorías tiene un hueco: falta la posición ${i}` };
        }
    }
    return { valido: true };
}

// ─── Validación de la matriz COMPLETA (las 6 clasificaciones × 3 categorías
// = 18 combinaciones únicas, siempre) ──────────────────────────────────────
// `matrizPorClasificacion`: { [clasificacion_codigo]: [{categoria, elegible, orden_preferencia}, ...] }
function validarMatrizCompleta(matrizPorClasificacion) {
    const m = matrizPorClasificacion || {};
    const claves = Object.keys(m);

    for (const clave of claves) {
        if (!CLASIFICACIONES_CONOCIDAS.includes(clave)) {
            return { valido: false, error: `Clasificación desconocida en la matriz: ${clave}` };
        }
    }
    let totalFilas = 0;
    for (const codigo of CLASIFICACIONES_CONOCIDAS) {
        if (!m[codigo]) {
            return { valido: false, error: `Matriz incompleta: falta la clasificación "${codigo}"` };
        }
        const r = validarMatrizClasificacion(codigo, m[codigo]);
        if (!r.valido) return r;
        totalFilas += m[codigo].length;
    }
    // Redundante con las validaciones por clasificación de arriba (cada una
    // ya exige exactamente 3), pero se revalida en conjunto explícitamente:
    // 6 clasificaciones × 3 categorías = 18 combinaciones, siempre.
    const totalEsperado = CLASIFICACIONES_CONOCIDAS.length * CATEGORIAS_CONOCIDAS.length;
    if (totalFilas !== totalEsperado) {
        return { valido: false, error: `La matriz debe tener exactamente ${totalEsperado} combinaciones (6 clasificaciones × 3 categorías) — tiene ${totalFilas}` };
    }
    return { valido: true };
}

// ─── Validación de la configuración COMPLETA ──────────────────────────────
// Orquesta todas las validaciones anteriores sobre una configuración con
// forma { schema_version, regla_distancia_maxima_activa, distancia_maxima_km,
// regla_no_repetir_asociacion_activa, regla_un_rodeo_por_finde_activa,
// regla_finde_consecutivo_activa, regla_asociacion_organizadora_activa,
// ordenCriterios: [...], matriz: {...} }.
function validarConfiguracion(configuracion) {
    const c = configuracion || {};

    if (c.schema_version !== SCHEMA_VERSION_SOPORTADO) {
        return { valido: false, error: `schema_version no soportado: ${c.schema_version}` };
    }

    const camposBooleanos = [
        'regla_distancia_maxima_activa', 'regla_no_repetir_asociacion_activa',
        'regla_un_rodeo_por_finde_activa', 'regla_finde_consecutivo_activa',
        'regla_asociacion_organizadora_activa'
    ];
    for (const campo of camposBooleanos) {
        if (typeof c[campo] !== 'boolean') {
            return { valido: false, error: `${campo} debe ser booleano` };
        }
    }

    const rDist = validarDistancia(c.regla_distancia_maxima_activa, c.distancia_maxima_km);
    if (!rDist.valido) return rDist;

    const rOrden = validarOrdenCriterios(c.ordenCriterios, c.schema_version);
    if (!rOrden.valido) return rOrden;

    const rMatriz = validarMatrizCompleta(c.matriz);
    if (!rMatriz.valido) return rMatriz;

    return { valido: true };
}

// ─── ¿Esta configuración necesita que el jurado resuelva comuna? ──────────
// Etapa 2 (NO implementada todavía en el motor): la comuna del jurado solo
// es indispensable si algo en la configuración realmente usa distancia —
// la regla dura DISTANCIA_MAXIMA, el criterio de ranking MENOR_DISTANCIA, o
// ambos. Si ninguno de los dos está activo, JURADO_SIN_COMUNA_RESOLVIBLE ya
// no debería descartar exclusivamente por una regla de distancia que dejó
// de usarse — esa conexión se implementa en Etapa 2; acá solo se resuelve
// el booleano puro que la futura Etapa 2 consultará.
function configuracionRequiereDistancia(configuracion) {
    const c = configuracion || {};
    if (c.regla_distancia_maxima_activa) return true;
    const ordenCriterios = c.ordenCriterios || [];
    return ordenCriterios.some(o => o.criterio_codigo === 'MENOR_DISTANCIA');
}

// ─── Configuración DEFAULT — Versión 1, equivalente EXACTO al motor actual ─
// Fuente ÚNICA de los defaults: la usan el seed de la migración (documentado
// ahí, verificado contra BD), la futura función "Restaurar configuración
// predeterminada", y los tests de equivalencia. Nunca repartir estos valores
// en más de un lugar.
function construirConfiguracionDefaultV1() {
    return {
        schema_version: SCHEMA_VERSION_SOPORTADO,

        regla_distancia_maxima_activa: true,
        distancia_maxima_km: 600,

        regla_no_repetir_asociacion_activa: true,
        regla_un_rodeo_por_finde_activa: true,
        regla_finde_consecutivo_activa: true,
        regla_asociacion_organizadora_activa: true,

        // Orden real actual del motor (ver motorPropuestaDesignacion.js):
        // filtro/prioridad de categoría, luego equidad, luego distancia.
        ordenCriterios: [
            { criterio_codigo: 'PRIORIDAD_CATEGORIA', orden: 1 },
            { criterio_codigo: 'MENOS_DESIGNACIONES_TEMPORADA', orden: 2 },
            { criterio_codigo: 'MENOR_DISTANCIA', orden: 3 }
        ],

        // Matriz real actual (clasificacion_categoria_matriz, verificada en
        // vivo) — MODELO COMPLETO: las 3 categorías A/B/C siempre presentes
        // explícitamente por clasificación (18 filas en total), nunca
        // ausencia de fila para "no elegible". Provincial queda A/B con
        // B→A (C explícita como no elegible) — NO se adelanta a A/B/C.
        matriz: {
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
        },

        // Documentación de política de compatibilidad (sección 27/28 del
        // pedido) — metadata informativa, NUNCA usada como lógica: el motor
        // (Etapa 2) implementará estos comportamientos directamente en
        // código, esto solo deja constancia explícita de la decisión para
        // que la futura UI pueda mostrarla.
        metadata: {
            top_candidatos_paridad_v1:
                'Cuando PRIORIDAD_CATEGORIA es el criterio Nº1 y existen candidatos del ' +
                'mejor nivel de categoría disponible, top_candidatos del resultado del motor ' +
                'muestra SOLO esos candidatos (paridad exacta con el comportamiento actual). ' +
                'Esto aplica únicamente al resultado del motor/dry-run — el modal administrativo ' +
                'Designar/Modificar Jurado sigue mostrando todos los candidatos válidos y con ' +
                'advertencias según su diseño actual, sin relación con esta política.',
            menor_distancia_estricta:
                'MENOR_DISTANCIA compara el valor real calculado sin redondeo, tolerancia ni ' +
                'bandas de empate. Si ocupa la primera prioridad del orden global, una diferencia ' +
                'de distancia por mínima que sea decide ese nivel de comparación antes de evaluar ' +
                'equidad o categoría.'
        }
    };
}

// ─── Clonar una configuración aplicando cambios, sin mutar el origen ──────
// `cambios` reemplaza por completo las claves que provee (incluyendo arrays/
// objetos anidados como ordenCriterios/matriz) — nunca hace merge profundo
// de esos anidados, para que el resultado sea siempre una estructura
// explícita y completa, nunca una mezcla ambigua entre versión base y
// cambios parciales de un array.
function clonarConfiguracion(configBase, cambios = {}) {
    const clonBase = JSON.parse(JSON.stringify(configBase || {}));
    const clonCambios = JSON.parse(JSON.stringify(cambios || {}));
    return { ...clonBase, ...clonCambios };
}

// ─── Comparar dos configuraciones — diferencias campo a campo ─────────────
// Usado conceptualmente por la futura pantalla "Restaurar configuración
// predeterminada" (actual vs. predeterminada). Compara los campos
// escalares directamente y ordenCriterios/matriz como bloques serializados
// (si cambió algo dentro, se reporta el bloque completo — suficiente para
// esta etapa, sin sobrediseñar un diff campo-a-campo de la matriz).
function compararConfiguraciones(a, b) {
    const cambios = [];
    const camposEscalares = [
        'schema_version', 'regla_distancia_maxima_activa', 'distancia_maxima_km',
        'regla_no_repetir_asociacion_activa', 'regla_un_rodeo_por_finde_activa',
        'regla_finde_consecutivo_activa', 'regla_asociacion_organizadora_activa'
    ];
    for (const campo of camposEscalares) {
        if ((a || {})[campo] !== (b || {})[campo]) {
            cambios.push({ campo, anterior: (a || {})[campo], nuevo: (b || {})[campo] });
        }
    }
    if (JSON.stringify((a || {}).ordenCriterios) !== JSON.stringify((b || {}).ordenCriterios)) {
        cambios.push({ campo: 'ordenCriterios', anterior: (a || {}).ordenCriterios, nuevo: (b || {}).ordenCriterios });
    }
    if (JSON.stringify((a || {}).matriz) !== JSON.stringify((b || {}).matriz)) {
        cambios.push({ campo: 'matriz', anterior: (a || {}).matriz, nuevo: (b || {}).matriz });
    }
    return { hayDiferencias: cambios.length > 0, cambios };
}

// ─── Reconstrucción PURA: filas de BD → objeto de configuración tipado ────
// Etapa 3 — Conectar configuración versionada de BD. Transforma las filas
// crudas de las 3 tablas de la migración 050 (configuracion_designacion_
// versiones / _orden_criterios / _matriz) a EXACTAMENTE la misma forma que
// construirConfiguracionDefaultV1() y que validarConfiguracion()/el motor ya
// entienden — nunca una forma paralela. Sin acceso a BD (las filas ya
// vienen cargadas por quien llama, ver configuracionDesignacionRepositorio.js)
// para que sea testeable sin mocks de Supabase.
//
// distancia_maxima_km viene de una columna NUMERIC de Postgres — PostgREST
// puede devolverla como string (verificado en vivo: "600") — se normaliza
// explícitamente a Number para que coincida con el tipo que usan
// validarDistancia()/el comparador del motor; NULL/undefined se preserva
// como null (nunca se convierte a 0).
//
// @param versionRow fila de configuracion_designacion_versiones
// @param criteriosRows [{criterio_codigo, orden}, ...] — SOLO los activos (ausente = inactivo)
// @param matrizRows [{clasificacion_codigo, categoria, elegible, orden_preferencia}, ...] — 18 filas
// @returns objeto configuracion (sin validar todavía — ver validarConfiguracion())
function reconstruirConfiguracionDesdeFilas(versionRow, criteriosRows, matrizRows) {
    const matriz = {};
    for (const fila of (matrizRows || [])) {
        if (!matriz[fila.clasificacion_codigo]) matriz[fila.clasificacion_codigo] = [];
        matriz[fila.clasificacion_codigo].push({
            categoria: fila.categoria,
            elegible: fila.elegible,
            orden_preferencia: fila.orden_preferencia === null || fila.orden_preferencia === undefined
                ? null : Number(fila.orden_preferencia)
        });
    }

    const distanciaRaw = versionRow.distancia_maxima_km;
    const distancia_maxima_km = (distanciaRaw === null || distanciaRaw === undefined) ? null : Number(distanciaRaw);

    return {
        schema_version: Number(versionRow.schema_version),
        regla_distancia_maxima_activa: versionRow.regla_distancia_maxima_activa,
        distancia_maxima_km,
        regla_no_repetir_asociacion_activa: versionRow.regla_no_repetir_asociacion_activa,
        regla_un_rodeo_por_finde_activa: versionRow.regla_un_rodeo_por_finde_activa,
        regla_finde_consecutivo_activa: versionRow.regla_finde_consecutivo_activa,
        regla_asociacion_organizadora_activa: versionRow.regla_asociacion_organizadora_activa,
        ordenCriterios: (criteriosRows || []).map(c => ({ criterio_codigo: c.criterio_codigo, orden: Number(c.orden) })),
        matriz
    };
}

module.exports = {
    SCHEMA_VERSION_SOPORTADO,
    CRITERIOS_CONOCIDOS,
    CRITERIO_NOMBRE_VISUAL,
    CLASIFICACIONES_CONOCIDAS,
    CATEGORIAS_CONOCIDAS,
    DISTANCIA_MAXIMA_TECNICA_KM,
    validarDistancia,
    validarOrdenCriterios,
    validarMatrizClasificacion,
    validarMatrizCompleta,
    validarConfiguracion,
    configuracionRequiereDistancia,
    construirConfiguracionDefaultV1,
    clonarConfiguracion,
    compararConfiguraciones,
    reconstruirConfiguracionDesdeFilas
};
