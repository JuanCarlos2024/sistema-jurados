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

// ─── Constantes conocidas por schema_version ───────────────────────────────
// Mejora "Equidad de Traslados" (ver informe): schema_version evoluciona de
// forma ADITIVA y NUNCA retroactiva — schema_version=1 sigue significando
// EXACTAMENTE lo mismo que antes de esta mejora (mismos 3 criterios, sin
// campos de equidad de traslados); schema_version=2 agrega el criterio
// EQUIDAD_TRASLADOS y sus 2 parámetros nuevos. Cualquier regla/criterio
// nuevo futuro requiere evolucionar SCHEMA_VERSIONES_SOPORTADAS y estas
// listas explícitamente — nunca aceptar un código desconocido.
const SCHEMA_VERSION_SOPORTADO = 1; // se mantiene por compatibilidad — ver SCHEMA_VERSIONES_SOPORTADAS para la validación real
const SCHEMA_VERSIONES_SOPORTADAS = [1, 2];

const CRITERIOS_CONOCIDOS = ['PRIORIDAD_CATEGORIA', 'MENOS_DESIGNACIONES_TEMPORADA', 'MENOR_DISTANCIA'];
// schema_version=2 admite todos los de schema_version=1 MÁS EQUIDAD_TRASLADOS.
const CRITERIOS_CONOCIDOS_POR_SCHEMA = {
    1: CRITERIOS_CONOCIDOS,
    2: [...CRITERIOS_CONOCIDOS, 'EQUIDAD_TRASLADOS']
};
function criteriosConocidosParaSchema(schemaVersion) {
    return CRITERIOS_CONOCIDOS_POR_SCHEMA[schemaVersion] || [];
}

// Nombres visuales — SOLO para UI futura. Nunca se usan en lógica/validación
// (la lógica compara siempre por código estable, nunca por este texto).
const CRITERIO_NOMBRE_VISUAL = {
    PRIORIDAD_CATEGORIA: 'Prioridad de categoría',
    MENOS_DESIGNACIONES_TEMPORADA: 'Menos designaciones',
    MENOR_DISTANCIA: 'Menor distancia',
    EQUIDAD_TRASLADOS: 'Equidad de traslados'
};

// Techo técnico anti-error-de-tipeo para umbral_lejania_km — mismo criterio
// y mismo valor que DISTANCIA_MAXIMA_TECNICA_KM (ver más abajo): no es una
// regla de negocio, solo protege contra un error de tipeo evidente.
const UMBRAL_LEJANIA_TECNICO_KM = 5000;

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

// ─── Validación de umbral_lejania_km (CLASIFICACIÓN, no descarte) ─────────
// Mismo patrón exacto que validarDistancia() — pero es un concepto TOTALMENTE
// distinto: distancia_maxima_km descarta candidatos; umbral_lejania_km solo
// clasifica un candidato YA elegible como CERCA o LEJOS para el criterio
// EQUIDAD_TRASLADOS (ver informe, sección 3). Solo se exige un valor válido
// cuando regla_equidad_traslados_activa está activa.
function validarUmbralLejania(reglaActiva, umbralLejaniaKm) {
    if (!reglaActiva) return { valido: true };
    if (umbralLejaniaKm === null || umbralLejaniaKm === undefined || umbralLejaniaKm === '') {
        return { valido: false, error: 'umbral_lejania_km es requerido cuando la regla de equidad de traslados está activa' };
    }
    const n = Number(umbralLejaniaKm);
    if (Number.isNaN(n)) return { valido: false, error: 'umbral_lejania_km debe ser numérico' };
    if (n <= 0) return { valido: false, error: 'umbral_lejania_km debe ser mayor que 0' };
    if (n > UMBRAL_LEJANIA_TECNICO_KM) {
        return { valido: false, error: `umbral_lejania_km supera el máximo técnico permitido (${UMBRAL_LEJANIA_TECNICO_KM} km) — probable error de tipeo` };
    }
    return { valido: true };
}

// ─── Validación del orden global de criterios (Nivel 1) ───────────────────
// `ordenCriterios`: array de { criterio_codigo, orden } — SOLO los criterios
// ACTIVOS de esta configuración (un código ausente = inactivo, igual que en
// la migración 050). Exige: schema soportado, códigos conocidos PARA ESE
// SCHEMA (schema_version=1 sigue aceptando exactamente los mismos 3 de
// siempre — EQUIDAD_TRASLADOS solo es válido desde schema_version=2), sin
// duplicados de código, sin duplicados de orden, secuencia 1..N sin huecos,
// y mínimo 1 criterio activo (nunca 0 — el ganador jamás debe depender
// únicamente del desempate final por jurado_id de forma accidental).
function validarOrdenCriterios(ordenCriterios, schemaVersion = SCHEMA_VERSION_SOPORTADO) {
    if (!SCHEMA_VERSIONES_SOPORTADAS.includes(schemaVersion)) {
        return { valido: false, error: `schema_version no soportado: ${schemaVersion}` };
    }
    const criteriosConocidos = criteriosConocidosParaSchema(schemaVersion);
    const lista = ordenCriterios || [];
    if (lista.length === 0) {
        return { valido: false, error: 'Debe haber al menos 1 criterio de ranking activo' };
    }

    const codigosVistos = new Set();
    const ordenesVistos = new Set();
    for (const c of lista) {
        if (!criteriosConocidos.includes(c.criterio_codigo)) {
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

    if (!SCHEMA_VERSIONES_SOPORTADAS.includes(c.schema_version)) {
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

    // ── Equidad de traslados (schema_version=2) — ver informe sección 5/7 ──
    // schema_version=1 NUNCA acepta regla_equidad_traslados_activa=true: así
    // se garantiza que una configuración "vieja" (incluida V1) no pueda
    // activar esta regla por error/copy-paste y cambiar silenciosamente su
    // significado histórico. El campo puede estar ausente/false/null en
    // schema_version=1 (equivalente a "la regla no existe para este schema").
    const reglaEquidadActiva = c.regla_equidad_traslados_activa === true;
    if (c.schema_version === 1 && reglaEquidadActiva) {
        return { valido: false, error: 'regla_equidad_traslados_activa solo es válida desde schema_version=2 — schema_version=1 debe mantener su significado histórico exacto' };
    }
    if (c.regla_equidad_traslados_activa !== undefined && c.regla_equidad_traslados_activa !== null
        && typeof c.regla_equidad_traslados_activa !== 'boolean') {
        return { valido: false, error: 'regla_equidad_traslados_activa debe ser booleano' };
    }
    const rUmbral = validarUmbralLejania(reglaEquidadActiva, c.umbral_lejania_km);
    if (!rUmbral.valido) return rUmbral;

    const rOrden = validarOrdenCriterios(c.ordenCriterios, c.schema_version);
    if (!rOrden.valido) return rOrden;

    // ── Coherencia regla/criterio + "SIEMPRE preferir cercanía" ───────────
    // Decisión de negocio confirmada (revisión de cierre): cuando la regla
    // está activa, EQUIDAD_TRASLADOS DEBE ser el criterio Nº1 del orden — de
    // lo contrario un criterio anterior (categoría, equidad de designaciones,
    // etc.) podría decidir entre un candidato CERCA y uno LEJOS antes de que
    // la cercanía tenga oportunidad de pesar, contradiciendo el requisito de
    // negocio "un jurado lejano sigue siendo elegible, pero el sistema
    // SIEMPRE debe preferir cercanía". Con la regla INACTIVA, el criterio no
    // debe figurar en absoluto en el orden (mismo criterio que antes).
    const criterioEquidad = (c.ordenCriterios || []).find(o => o.criterio_codigo === 'EQUIDAD_TRASLADOS');
    if (reglaEquidadActiva) {
        if (!criterioEquidad) {
            return { valido: false, error: 'regla_equidad_traslados_activa está activa pero EQUIDAD_TRASLADOS no está en el orden de criterios' };
        }
        if (criterioEquidad.orden !== 1) {
            return { valido: false, error: 'EQUIDAD_TRASLADOS debe ser el criterio Nº1 (orden=1) mientras regla_equidad_traslados_activa esté activa — así se garantiza que la cercanía siempre se evalúe antes que cualquier otro criterio' };
        }
    } else if (criterioEquidad) {
        return { valido: false, error: 'EQUIDAD_TRASLADOS aparece en el orden de criterios pero regla_equidad_traslados_activa no está activa' };
    }

    const rMatriz = validarMatrizCompleta(c.matriz);
    if (!rMatriz.valido) return rMatriz;

    return { valido: true };
}

// ─── ¿Esta configuración necesita que el jurado resuelva comuna? ──────────
// Etapa 2 (NO implementada todavía en el motor): la comuna del jurado solo
// es indispensable si algo en la configuración realmente usa distancia —
// la regla dura DISTANCIA_MAXIMA, el criterio de ranking MENOR_DISTANCIA, o
// (mejora Equidad de Traslados) la regla_equidad_traslados_activa/criterio
// EQUIDAD_TRASLADOS, que también necesita distancia para clasificar
// CERCA/LEJOS (informe, sección 24: "reutilizar la lógica existente de
// comuna resoluble, no crear una segunda causa distinta"). Si nada de esto
// está activo, JURADO_SIN_COMUNA_RESOLVIBLE ya no debería descartar
// exclusivamente por una regla de distancia que dejó de usarse.
function configuracionRequiereDistancia(configuracion) {
    const c = configuracion || {};
    if (c.regla_distancia_maxima_activa) return true;
    if (c.regla_equidad_traslados_activa) return true;
    const ordenCriterios = c.ordenCriterios || [];
    return ordenCriterios.some(o => o.criterio_codigo === 'MENOR_DISTANCIA' || o.criterio_codigo === 'EQUIDAD_TRASLADOS');
}

// ─── Clasificación CERCA/LEJOS — criterio EQUIDAD_TRASLADOS ───────────────
// Pura, sin acceso a BD. umbral_lejania_km es SOLO un umbral de clasificación
// (informe, sección 2/3) — NUNCA una distancia máxima de descarte, ambos
// conceptos son independientes y pueden coexistir con valores distintos (ej.
// distancia_maxima_km desactivada + umbral_lejania_km=350 activo).
//   distancia <= umbral → 'CERCA'
//   distancia >  umbral → 'LEJOS'
//   distancia null (sin comuna resoluble) → null (ni CERCA ni LEJOS)
function clasificarTraslado(distanciaKm, umbralLejaniaKm) {
    if (distanciaKm === null || distanciaKm === undefined) return null;
    if (umbralLejaniaKm === null || umbralLejaniaKm === undefined) return null;
    return distanciaKm <= umbralLejaniaKm ? 'CERCA' : 'LEJOS';
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
        'regla_finde_consecutivo_activa', 'regla_asociacion_organizadora_activa',
        'regla_equidad_traslados_activa', 'umbral_lejania_km'
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

    const reconstruida = {
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

    // Equidad de traslados (schema_version=2, migración 052) — se agrega
    // SOLO si versionRow realmente trae estas columnas. Antes de aplicar la
    // migración 052, la fila de BD no las tiene en absoluto (columnas
    // inexistentes) — se omiten del objeto reconstruido en vez de forzar
    // false/null, para no fingir un dato que la BD todavía no tiene. Esto
    // también preserva byte a byte la forma reconstruida hoy de versiones
    // schema_version=1 ya existentes (tests de equivalencia V1, sin tocarlos).
    if (versionRow.regla_equidad_traslados_activa !== undefined) {
        reconstruida.regla_equidad_traslados_activa = versionRow.regla_equidad_traslados_activa;
        const umbralRaw = versionRow.umbral_lejania_km;
        reconstruida.umbral_lejania_km = (umbralRaw === null || umbralRaw === undefined) ? null : Number(umbralRaw);
    }

    return reconstruida;
}

// ─── Aplanar matriz objeto → filas planas (inverso de reconstruirConfigu- ──
// ─── racionDesdeFilas, para el otro sentido: JS → filas que la RPC de ─────
// ─── creación (Etapa 4) inserta) ───────────────────────────────────────────
// `matrizPorClasificacion`: { [clasificacion_codigo]: [{categoria, elegible, orden_preferencia}, ...] }
// @returns [{clasificacion_codigo, categoria, elegible, orden_preferencia}, ...] — 18 filas si la matriz está completa
function aplanarMatriz(matrizPorClasificacion) {
    const m = matrizPorClasificacion || {};
    const filas = [];
    for (const clasificacionCodigo of Object.keys(m)) {
        for (const fila of (m[clasificacionCodigo] || [])) {
            filas.push({
                clasificacion_codigo: clasificacionCodigo,
                categoria: fila.categoria,
                elegible: !!fila.elegible,
                orden_preferencia: fila.elegible ? fila.orden_preferencia : null
            });
        }
    }
    return filas;
}

// ─── Resumen liviano para UI (Etapa 4) ────────────────────────────────────
// Usado en las respuestas de dry-run/preview/candidatos — nunca el objeto de
// configuración completo (evita filtrar más de lo que la pantalla necesita
// mostrar en un check dinámico o un indicador de versión). Solo campos ya
// visibles en la propia respuesta del motor — nada nuevo ni sensible.
// @param configuracion objeto configuracion ya reconstruido/validado
// @param meta { id, numero_version, ... } — de cargarConfiguracionDesignacion*()
function construirResumenParaUI(configuracion, meta) {
    const c = configuracion || {};
    const resumen = {
        id: meta?.id ?? null,
        numero_version: meta?.numero_version ?? null,
        regla_distancia_maxima_activa: c.regla_distancia_maxima_activa ?? null,
        distancia_maxima_km: c.distancia_maxima_km ?? null,
        // Revisión final Etapa 4, sección 18: las 4 reglas booleanas también
        // se incluyen — sin esto, la UI no puede saber si "No repite
        // asociación"/"Sin mismo finde"/"Sin finde consecutivo"/"Asociación
        // diferente" (motorPropuestaDesignacion.js: checks.no_repite_asociacion/
        // sin_rodeo_mismo_finde/sin_finde_consecutivo/asociacion_diferente)
        // corresponden a una regla realmente ACTIVA en esta versión, y
        // terminaría mostrando un check cumplido como si fuera obligatorio
        // cuando en realidad esa regla está desactivada.
        regla_no_repetir_asociacion_activa: c.regla_no_repetir_asociacion_activa ?? null,
        regla_un_rodeo_por_finde_activa: c.regla_un_rodeo_por_finde_activa ?? null,
        regla_finde_consecutivo_activa: c.regla_finde_consecutivo_activa ?? null,
        regla_asociacion_organizadora_activa: c.regla_asociacion_organizadora_activa ?? null,
        orden_criterios_codigos: (c.ordenCriterios || [])
            .slice()
            .sort((a, b) => a.orden - b.orden)
            .map(o => o.criterio_codigo)
    };
    // Equidad de traslados — SOLO se agrega al resumen si la configuración
    // de origen realmente trae el campo (schema_version=2). Una config
    // schema_version=1 (incluida V1) no lo tiene definido — se omite del
    // resumen en vez de forzar false/null, preservando exactamente la forma
    // ya devuelta hoy para configuraciones existentes (tests de Etapa 4, sin
    // tocarlos).
    if (c.regla_equidad_traslados_activa !== undefined) {
        resumen.regla_equidad_traslados_activa = c.regla_equidad_traslados_activa ?? null;
        resumen.umbral_lejania_km = c.umbral_lejania_km ?? null;
    }
    return resumen;
}

// ─── Capacidades soportadas por este backend — "feature capability" ──────
// Mejora "Equidad de Traslados" (revisión de cierre, sección 3): el
// frontend NO debe inferir si el backend soporta schema_version=2 a partir
// de errores — debe leerlo explícitamente de acá. Se expone tal cual desde
// GET /defaults y GET /activa (configuracion-designacion.js) — pura, sin
// BD, siempre refleja lo que este código realmente sabe validar/ejecutar
// (nunca lo que la BD "debería" tener — antes de aplicar la migración 052
// esto ya declara soporte para schema 2 a nivel de código; la RPC v2 real
// solo existe después de aplicar esa migración, lo cual fallará controlado
// si se intenta antes, nunca silenciosamente).
function obtenerCapacidadesSoportadas() {
    return {
        schema_versions_soportadas: [...SCHEMA_VERSIONES_SOPORTADAS],
        criterios_soportados_por_schema: {
            1: [...CRITERIOS_CONOCIDOS_POR_SCHEMA[1]],
            2: [...CRITERIOS_CONOCIDOS_POR_SCHEMA[2]]
        },
        umbral_lejania_default_km: 350
    };
}

module.exports = {
    SCHEMA_VERSION_SOPORTADO,
    SCHEMA_VERSIONES_SOPORTADAS,
    CRITERIOS_CONOCIDOS,
    CRITERIOS_CONOCIDOS_POR_SCHEMA,
    criteriosConocidosParaSchema,
    CRITERIO_NOMBRE_VISUAL,
    CLASIFICACIONES_CONOCIDAS,
    CATEGORIAS_CONOCIDAS,
    DISTANCIA_MAXIMA_TECNICA_KM,
    UMBRAL_LEJANIA_TECNICO_KM,
    validarDistancia,
    validarUmbralLejania,
    validarOrdenCriterios,
    validarMatrizClasificacion,
    validarMatrizCompleta,
    validarConfiguracion,
    configuracionRequiereDistancia,
    clasificarTraslado,
    construirConfiguracionDefaultV1,
    clonarConfiguracion,
    compararConfiguraciones,
    reconstruirConfiguracionDesdeFilas,
    aplanarMatriz,
    construirResumenParaUI,
    obtenerCapacidadesSoportadas
};
