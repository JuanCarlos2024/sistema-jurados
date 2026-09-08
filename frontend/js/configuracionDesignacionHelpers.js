// ═════════════════════════════════════════════════════════════════════════
// Configuración de Propuesta de Designación — Etapa 4. Helpers PUROS para el
// editor de configuracion-designacion.html — mover/activar/desactivar
// criterios, marcar/mover categorías de la matriz, construir el diff antes de
// guardar y validar el borrador en el navegador (misma UX que temporadas.js/
// candidatosFiltro.js: funciona como <script> global en el navegador y como
// módulo require()-able en Jest — ver el bloque final).
//
// Estos helpers NUNCA deciden reglas del motor ni tocan backend — solo
// manipulan el objeto `configuracion` en memoria mientras el administrador
// edita un borrador. El backend (validarConfiguracion() + la RPC
// crear_configuracion_designacion_version) vuelve a validar todo antes de
// persistir — esto es solo para feedback inmediato en la UI (sección 24 del
// pedido de Etapa 4: "backend vuelve a validar", nunca se confía solo en esto).
// ═════════════════════════════════════════════════════════════════════════

// Mejora "Equidad de Traslados" — schema_version=2 agrega EQUIDAD_TRASLADOS
// a los criterios conocidos, SIN tocar la lista de schema_version=1 (mismos
// 3 de siempre — nunca se reinterpreta schema1). Mismo patrón que
// CRITERIOS_CONOCIDOS_POR_SCHEMA del backend (configuracionDesignacion.js)
// — fuente de verdad duplicada intencionalmente en 2 lenguajes (JS puro sin
// build step, no hay forma de compartir un módulo entre frontend/backend en
// este proyecto), pero ambas listas deben mantenerse en sincronía manual.
const CRITERIOS_CONOCIDOS_UI = ['PRIORIDAD_CATEGORIA', 'MENOS_DESIGNACIONES_TEMPORADA', 'MENOR_DISTANCIA'];
const CRITERIOS_CONOCIDOS_UI_POR_SCHEMA = {
    1: CRITERIOS_CONOCIDOS_UI,
    2: [...CRITERIOS_CONOCIDOS_UI, 'EQUIDAD_TRASLADOS']
};
function criteriosConocidosUIParaSchema(schemaVersion) {
    return CRITERIOS_CONOCIDOS_UI_POR_SCHEMA[schemaVersion] || CRITERIOS_CONOCIDOS_UI;
}
const CLASIFICACIONES_CONOCIDAS_UI = ['interclubes', 'provincial', 'interasociaciones', 'zonal', 'clasificatorio', 'nacional'];
const CATEGORIAS_CONOCIDAS_UI = ['A', 'B', 'C'];
const DISTANCIA_MAXIMA_TECNICA_KM_UI = 5000;
const UMBRAL_LEJANIA_TECNICO_KM_UI = 5000; // mismo techo técnico que distancia_maxima_km — ver DISTANCIA_MAXIMA_TECNICA_KM_UI
const UMBRAL_LEJANIA_DEFAULT_KM_UI = 350;  // valor inicial sugerido al activar equidad (informativo — el administrador puede cambiarlo)

// ─── Renumera un array ya en el orden deseado como 1..N sin huecos ───────
function renumerar(lista, campoOrden) {
    return lista.map((item, i) => ({ ...item, [campoOrden]: i + 1 }));
}

// ═════════════════════════════════════════════════════════════════════════
// CRITERIOS DE PRIORIDAD (Nivel 1) — trabaja sobre `ordenCriterios`: array
// de { criterio_codigo, orden } — SOLO los criterios ACTIVOS (un código
// ausente = inactivo), misma forma que espera el backend.
// ═════════════════════════════════════════════════════════════════════════

// ─── Activa un criterio conocido — se agrega AL FINAL del orden actual ────
// (sección 12: activar/desactivar sin drag-and-drop obligatorio). Si ya
// estaba activo, no hace nada (idempotente).
function activarCriterio(ordenCriterios, criterioCodigo) {
    const lista = ordenCriterios || [];
    if (lista.some(c => c.criterio_codigo === criterioCodigo)) return lista;
    return [...lista, { criterio_codigo: criterioCodigo, orden: lista.length + 1 }];
}

// ─── Desactiva un criterio — se quita del orden y se renumeran los ────────
// restantes 1..N sin huecos. NUNCA deja 0 criterios activos (sección 13):
// si es el último, no hace nada y devuelve la lista intacta — el llamador
// (UI) debe avisar al administrador, nunca guardar en ese estado.
//
// EQUIDAD_TRASLADOS (mejora "Equidad de Traslados", revisión de cierre,
// sección 11): NUNCA se desactiva desde la lista genérica de criterios —
// mientras esté presente, está por definición ligado a
// regla_equidad_traslados_activa=true y fijo en orden=1 (ver
// validarConfiguracion() en el backend). La ÚNICA forma correcta de
// quitarlo es apagar el toggle dedicado "Aplicar equidad de traslados"
// (ver desactivarEquidadTraslados() más abajo), que además limpia
// regla_equidad_traslados_activa/umbral_lejania_km de forma coherente —
// algo que esta función genérica no sabe hacer. Evita el estado
// incoherente "criterio ausente pero regla todavía activa".
function desactivarCriterio(ordenCriterios, criterioCodigo) {
    if (criterioCodigo === 'EQUIDAD_TRASLADOS') return ordenCriterios || [];
    const lista = ordenCriterios || [];
    if (lista.length <= 1) return lista; // nunca deja 0 activos
    const restante = lista.filter(c => c.criterio_codigo !== criterioCodigo).sort((a, b) => a.orden - b.orden);
    return renumerar(restante, 'orden');
}

// ─── Mueve un criterio activo un lugar arriba/abajo — intercambia orden ───
// con su vecino inmediato. En los extremos no hace nada.
//
// EQUIDAD_TRASLADOS (revisión de cierre, sección 9/11): SIEMPRE bloqueado
// en orden=1 mientras esté presente — "no puede subir, no puede bajar".
// Tampoco se permite que otro criterio se mueva HACIA la posición 1
// desplazándolo (el intercambio de posiciones es simétrico: mover "B" hacia
// arriba cuando está en la posición 2 intercambiaría con EQUIDAD_TRASLADOS
// en la posición 1 — se bloquea desde ambos lados).
function moverCriterio(ordenCriterios, criterioCodigo, direccion) {
    if (criterioCodigo === 'EQUIDAD_TRASLADOS') return ordenCriterios || [];
    const lista = [...(ordenCriterios || [])].sort((a, b) => a.orden - b.orden);
    const idx = lista.findIndex(c => c.criterio_codigo === criterioCodigo);
    if (idx === -1) return lista;
    const destino = direccion === 'arriba' ? idx - 1 : idx + 1;
    if (destino < 0 || destino >= lista.length) return lista;
    if (lista[destino].criterio_codigo === 'EQUIDAD_TRASLADOS') return lista; // no desplazar al criterio bloqueado en Nº1
    [lista[idx], lista[destino]] = [lista[destino], lista[idx]];
    return renumerar(lista, 'orden');
}

// ═════════════════════════════════════════════════════════════════════════
// EQUIDAD DE TRASLADOS — activar/desactivar (revisión de cierre, secciones
// 6/7/8). Trabaja sobre la configuración COMPLETA (no solo ordenCriterios)
// porque promueve/gestiona schema_version + regla_equidad_traslados_activa
// + umbral_lejania_km + ordenCriterios juntos, de forma coherente.
// ═════════════════════════════════════════════════════════════════════════

// ─── Activa equidad de traslados — PROMUEVE el draft a schema_version=2 ───
// (sección 6/7): nunca modifica la versión base (V1 u otra), solo la copia
// en memoria (`configuracion` ya es esa copia, según el patrón ya usado por
// el resto del editor). Inserta EQUIDAD_TRASLADOS en orden=1 y desplaza los
// criterios existentes a 2..N+1, CONSERVANDO su orden relativo (sección 7).
// umbral_lejania_km: se conserva si ya tenía un valor válido (>0) — útil si
// el administrador la había activado antes en el mismo draft y la apagó —
// si no, usa UMBRAL_LEJANIA_DEFAULT_KM_UI (350).
function activarEquidadTraslados(configuracion) {
    const c = JSON.parse(JSON.stringify(configuracion || {}));
    c.schema_version = 2;
    c.regla_equidad_traslados_activa = true;
    if (!(Number(c.umbral_lejania_km) > 0)) c.umbral_lejania_km = UMBRAL_LEJANIA_DEFAULT_KM_UI;

    const restantes = (c.ordenCriterios || [])
        .filter(o => o.criterio_codigo !== 'EQUIDAD_TRASLADOS')
        .slice().sort((a, b) => a.orden - b.orden)
        .map((o, i) => ({ criterio_codigo: o.criterio_codigo, orden: i + 2 }));
    c.ordenCriterios = [{ criterio_codigo: 'EQUIDAD_TRASLADOS', orden: 1 }, ...restantes];
    return c;
}

// ─── Desactiva equidad de traslados (sección 8) ───────────────────────────
// Quita EQUIDAD_TRASLADOS del orden (renumerando 1..N el resto) y limpia
// regla_equidad_traslados_activa=false / umbral_lejania_km=null.
//
// DECISIÓN DOCUMENTADA (sección 8 del pedido): NO se revierte
// schema_version a 1 automáticamente — el draft queda en schema_version=2
// (sin equidad activa) hasta que el administrador lo guarde así o vuelva a
// activar equidad. Motivo: revertir "hacia atrás" el schema requeriría
// lógica reversible adicional (¿qué pasa si el administrador ya usó otro
// campo exclusivo de schema2 en el mismo draft?) sin ningún beneficio real
// — una configuración schema_version=2 con equidad desactivada es
// perfectamente válida y equivalente en efecto a schema_version=1 (el
// motor no la trata distinto), y deja la puerta abierta a futuras
// funciones de schema2 sin necesitar otra promoción.
function desactivarEquidadTraslados(configuracion) {
    const c = JSON.parse(JSON.stringify(configuracion || {}));
    c.regla_equidad_traslados_activa = false;
    c.umbral_lejania_km = null;
    const restantes = (c.ordenCriterios || [])
        .filter(o => o.criterio_codigo !== 'EQUIDAD_TRASLADOS')
        .slice().sort((a, b) => a.orden - b.orden)
        .map((o, i) => ({ criterio_codigo: o.criterio_codigo, orden: i + 1 }));
    c.ordenCriterios = restantes;
    return c;
}

// ═════════════════════════════════════════════════════════════════════════
// ZONAS EXTREMAS (schema_version=3, migración 053 preparada — NO aplicada)
// — activar/desactivar (mismo patrón exacto que EQUIDAD DE TRASLADOS arriba:
// promueve schema_version, nunca modifica la versión base, nunca "baja" el
// schema al desactivar). Trabaja sobre la configuración COMPLETA porque
// gestiona schema_version + regla_zonas_extremas_activa + zonas_extremas
// juntos, de forma coherente.
// ═════════════════════════════════════════════════════════════════════════

// ─── Activa Zonas Extremas — PROMUEVE el draft a schema_version=3 (sección
// 2 del pedido de UI): nunca modifica la versión base, solo la copia en
// memoria. Conserva TODAS las reglas que ya tenía el draft (distancia,
// EQUIDAD_TRASLADOS, orden de criterios, matriz normal) — no las toca.
//
// `defaultZonaExtrema` — { asociaciones, categorias } — SIEMPRE viene de
// `capacidades.zonas_extremas_default` (backend, GET /activa o /defaults),
// NUNCA hardcodeado acá (sección 4/5 del pedido: única fuente backend, no
// duplicar la lista en el HTML). Si el draft YA tenía datos propios de
// Zonas Extremas (copiado de una versión schema3 histórica, o el
// administrador ya los había cargado antes en este mismo draft), se
// CONSERVAN intactos — nunca se sobrescriben con el default (sección 8).
function activarZonasExtremas(configuracion, defaultZonaExtrema) {
    const c = JSON.parse(JSON.stringify(configuracion || {}));
    c.schema_version = 3;
    c.regla_zonas_extremas_activa = true;
    const yaTeniaDatos = c.zonas_extremas && Array.isArray(c.zonas_extremas.asociaciones) && c.zonas_extremas.asociaciones.length > 0;
    if (!yaTeniaDatos) {
        c.zonas_extremas = {
            asociaciones: [...((defaultZonaExtrema && defaultZonaExtrema.asociaciones) || [])],
            categorias: ((defaultZonaExtrema && defaultZonaExtrema.categorias) || []).map(f => ({ ...f }))
        };
    }
    return c;
}

// ─── Desactiva Zonas Extremas (sección 3/35/36 del pedido — GATE ya
// resuelto y confirmado compatible con la migración 053 preparada: la RPC
// v3 inserta asociaciones/categorías SIEMPRE que vengan en el payload,
// activa o no la regla, y la validación estructural solo exige mínimos
// cuando regla_zonas_extremas_activa=true).
//
// DECISIÓN DOCUMENTADA (mismo patrón que desactivarEquidadTraslados): NO se
// revierte schema_version a 2/1 automáticamente — el draft queda en
// schema_version=3 (sin la regla activa) hasta que el administrador la
// vuelva a activar o guarde así. Y — a diferencia de equidad de traslados —
// NO se limpian asociaciones/categorías: se CONSERVAN in-memory en el draft
// para que reactivar el toggle más tarde no pierda lo ya configurado
// (preferencia UX explícita del pedido, sección 36). El backend simplemente
// las ignora funcionalmente mientras la regla esté en false.
function desactivarZonasExtremas(configuracion) {
    const c = JSON.parse(JSON.stringify(configuracion || {}));
    c.regla_zonas_extremas_activa = false;
    return c;
}

// ─── Normalización de asociación PARA LA UI (feedback inmediato de ────────
// duplicados) — réplica del algoritmo de services/asociaciones.js
// (normalizarAsociacion: trim, minúsculas, sin tildes, guiones→espacio,
// espacios colapsados, sin el prefijo "asociación ") — el backend sigue
// siendo la autoridad final (sección 12 del pedido: "reutilizar
// normalizarAsociacion(); backend sigue siendo autoridad final").
function _normalizarAsociacionUI(str) {
    let n = (str || '').toString().trim().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // sin tildes (marcas diacríticas combinantes)
        .replace(/-/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    n = n.replace(/^asociacion\s+/, '');
    return n.trim();
}

// ─── Agrega una asociación al draft (sección 10) — idempotente/sin ────────
// duplicados (comparación NORMALIZADA, sección 12). NO modifica ningún
// rodeo ni el catálogo de asociaciones — solo el array en memoria.
// @returns { configuracion, agregada:boolean, error? }
function agregarAsociacionZonaExtrema(configuracion, asociacion) {
    const c = JSON.parse(JSON.stringify(configuracion || {}));
    const texto = (asociacion || '').trim();
    if (!texto) return { configuracion: c, agregada: false, error: 'Asociación vacía' };
    const actuales = (c.zonas_extremas && c.zonas_extremas.asociaciones) || [];
    const normTexto = _normalizarAsociacionUI(texto);
    if (actuales.some(a => _normalizarAsociacionUI(a) === normTexto)) {
        return { configuracion: c, agregada: false, error: 'Esa asociación ya está incluida' };
    }
    c.zonas_extremas = c.zonas_extremas || { asociaciones: [], categorias: [] };
    c.zonas_extremas.asociaciones = [...actuales, texto];
    return { configuracion: c, agregada: true };
}

// ─── Quita una asociación del draft (sección 11) — SOLO del array en ──────
// memoria de esta configuración; nunca borra la asociación real ni toca
// ningún rodeo.
function quitarAsociacionZonaExtrema(configuracion, asociacion) {
    const c = JSON.parse(JSON.stringify(configuracion || {}));
    const actuales = (c.zonas_extremas && c.zonas_extremas.asociaciones) || [];
    c.zonas_extremas = c.zonas_extremas || { asociaciones: [], categorias: [] };
    c.zonas_extremas.asociaciones = actuales.filter(a => a !== asociacion);
    return c;
}

// ═════════════════════════════════════════════════════════════════════════
// MATRIZ DE CATEGORÍAS (Nivel 2) — trabaja sobre `filasClasificacion`: array
// de EXACTAMENTE 3 filas { categoria, elegible, orden_preferencia } (A/B/C)
// para UNA clasificación.
// ═════════════════════════════════════════════════════════════════════════

// ─── Marca una categoría como ELEGIBLE — se agrega al final del orden de ──
// preferencia actual (sección 22: "la UI puede agregar C al final" — el
// administrador reordena después con moverCategoria si quiere).
function activarCategoria(filasClasificacion, categoria) {
    const maxOrdenActual = Math.max(0, ...filasClasificacion.filter(f => f.elegible).map(f => f.orden_preferencia));
    return filasClasificacion.map(f => f.categoria === categoria
        ? { ...f, elegible: true, orden_preferencia: maxOrdenActual + 1 }
        : f);
}

// ─── Desmarca una categoría — queda elegible:false/orden_preferencia:null ─
// y las categorías elegibles restantes se renumeran 1..N sin huecos
// (sección 23). NUNCA deja 0 categorías elegibles en esa clasificación: si
// es la última, no hace nada — la UI debe avisar, nunca guardar así.
function desactivarCategoria(filasClasificacion, categoria) {
    const elegiblesActuales = filasClasificacion.filter(f => f.elegible);
    if (elegiblesActuales.length <= 1 && elegiblesActuales.some(f => f.categoria === categoria)) {
        return filasClasificacion; // nunca deja 0 elegibles
    }
    const restantesOrdenadas = elegiblesActuales
        .filter(f => f.categoria !== categoria)
        .sort((a, b) => a.orden_preferencia - b.orden_preferencia);
    const nuevoOrdenPorCategoria = {};
    restantesOrdenadas.forEach((f, i) => { nuevoOrdenPorCategoria[f.categoria] = i + 1; });
    return filasClasificacion.map(f => f.categoria === categoria
        ? { ...f, elegible: false, orden_preferencia: null }
        : (f.elegible ? { ...f, orden_preferencia: nuevoOrdenPorCategoria[f.categoria] } : f));
}

// ─── Mueve una categoría ELEGIBLE un lugar arriba/abajo en su orden de ────
// preferencia — mismo mecanismo que moverCriterio, pero solo entre las
// categorías actualmente elegibles de esta clasificación.
function moverCategoria(filasClasificacion, categoria, direccion) {
    const elegibles = filasClasificacion.filter(f => f.elegible).sort((a, b) => a.orden_preferencia - b.orden_preferencia);
    const idx = elegibles.findIndex(f => f.categoria === categoria);
    if (idx === -1) return filasClasificacion;
    const destino = direccion === 'arriba' ? idx - 1 : idx + 1;
    if (destino < 0 || destino >= elegibles.length) return filasClasificacion;
    [elegibles[idx], elegibles[destino]] = [elegibles[destino], elegibles[idx]];
    const renumeradas = renumerar(elegibles, 'orden_preferencia');
    const ordenPorCategoria = {};
    renumeradas.forEach(f => { ordenPorCategoria[f.categoria] = f.orden_preferencia; });
    return filasClasificacion.map(f => f.elegible ? { ...f, orden_preferencia: ordenPorCategoria[f.categoria] } : f);
}

// ═════════════════════════════════════════════════════════════════════════
// VALIDACIÓN de borrador — feedback inmediato en el navegador (sección 24).
// Réplica DELIBERADAMENTE simplificada (mensajes menos detallados) de
// validarConfiguracion() en backend/src/services/configuracionDesignacion.js
// — el backend es la fuente de verdad, esto solo evita un viaje al servidor
// para errores obvios. Devuelve el PRIMER error encontrado (misma forma que
// el backend: { valido, error }).
// ═════════════════════════════════════════════════════════════════════════
function validarDraft(configuracion) {
    const c = configuracion || {};

    const ordenCriterios = c.ordenCriterios || [];
    if (ordenCriterios.length === 0) {
        return { valido: false, error: 'Debe haber al menos 1 criterio de prioridad activo' };
    }
    const codigosCriterios = new Set(ordenCriterios.map(o => o.criterio_codigo));
    if (codigosCriterios.size !== ordenCriterios.length) {
        return { valido: false, error: 'Hay un criterio de prioridad duplicado' };
    }

    if (c.regla_distancia_maxima_activa) {
        const n = Number(c.distancia_maxima_km);
        if (c.distancia_maxima_km === null || c.distancia_maxima_km === undefined || c.distancia_maxima_km === '' || Number.isNaN(n)) {
            return { valido: false, error: 'La distancia máxima es obligatoria mientras la regla esté activa' };
        }
        if (n <= 0) return { valido: false, error: 'La distancia máxima debe ser mayor que 0' };
        if (n > DISTANCIA_MAXIMA_TECNICA_KM_UI) {
            return { valido: false, error: `La distancia máxima no puede superar ${DISTANCIA_MAXIMA_TECNICA_KM_UI} km` };
        }
    }

    // ── Equidad de traslados (schema_version 2 o 3) — revisión de cierre,
    // sección 12: réplica de UX de la validación de autoridad en el backend
    // (configuracionDesignacion.js validarConfiguracion()). Casos A-G.
    // Mejora "Zonas Extremas": schema_version=3 admite TODO lo de schema
    // 2 (EQUIDAD_TRASLADOS incluida, ambas reglas ortogonales) — solo
    // schema_version=1 sigue rechazándola (significado histórico intacto).
    const reglaEquidadActiva = c.regla_equidad_traslados_activa === true;
    const criterioEquidad = ordenCriterios.find(o => o.criterio_codigo === 'EQUIDAD_TRASLADOS');
    const schemaAdmiteEquidad = c.schema_version === 2 || c.schema_version === 3;
    if (!schemaAdmiteEquidad && reglaEquidadActiva) {
        return { valido: false, error: 'La equidad de traslados solo es válida desde schema_version=2' }; // A
    }
    if (!schemaAdmiteEquidad && criterioEquidad) {
        return { valido: false, error: 'EQUIDAD_TRASLADOS solo es válido desde schema_version=2' }; // B
    }
    if (reglaEquidadActiva) {
        const n = Number(c.umbral_lejania_km);
        if (c.umbral_lejania_km === null || c.umbral_lejania_km === undefined || c.umbral_lejania_km === '' || Number.isNaN(n)) {
            return { valido: false, error: 'El umbral de lejanía es obligatorio mientras la equidad de traslados esté activa' }; // C
        }
        if (n <= 0) return { valido: false, error: 'El umbral de lejanía debe ser mayor que 0' }; // F
        if (n > UMBRAL_LEJANIA_TECNICO_KM_UI) {
            return { valido: false, error: `El umbral de lejanía no puede superar ${UMBRAL_LEJANIA_TECNICO_KM_UI} km` }; // G
        }
        if (!criterioEquidad) {
            return { valido: false, error: 'EQUIDAD_TRASLADOS debe estar en el orden de criterios mientras la equidad de traslados esté activa' };
        }
        if (criterioEquidad.orden !== 1) {
            return { valido: false, error: 'EQUIDAD_TRASLADOS debe ser el criterio Nº1 (orden=1) mientras la equidad de traslados esté activa' }; // D
        }
    } else if (criterioEquidad) {
        return { valido: false, error: 'EQUIDAD_TRASLADOS aparece en el orden de criterios pero la equidad de traslados no está activa' }; // E
    }

    const matriz = c.matriz || {};
    for (const codigo of CLASIFICACIONES_CONOCIDAS_UI) {
        const filas = matriz[codigo] || [];
        if (filas.length !== CATEGORIAS_CONOCIDAS_UI.length) {
            return { valido: false, error: `[${codigo}] debe tener las 3 categorías (A, B, C)` };
        }
        const elegibles = filas.filter(f => f.elegible);
        if (elegibles.length === 0) {
            return { valido: false, error: `[${codigo}] debe tener al menos 1 categoría elegible` };
        }
    }

    // ── Zonas Extremas (schema_version=3) — réplica de UX de validarZonas
    // Extremas() en el backend (configuracionDesignacion.js). SOLO se exige
    // algo cuando la regla está ACTIVA — apagar el toggle nunca obliga a
    // vaciar lo ya configurado (sección 16/26/36 del pedido de UI).
    const reglaZonasActiva = c.regla_zonas_extremas_activa === true;
    if (c.schema_version !== 3 && reglaZonasActiva) {
        return { valido: false, error: 'Zonas Extremas solo es válida en schema_version=3' };
    }
    if (reglaZonasActiva) {
        const ze = c.zonas_extremas || {};
        const asociaciones = ze.asociaciones || [];
        if (asociaciones.length === 0) {
            return { valido: false, error: 'Zonas Extremas está activa pero no hay ninguna asociación incluida' };
        }
        const categorias = ze.categorias || [];
        if (categorias.length !== CATEGORIAS_CONOCIDAS_UI.length) {
            return { valido: false, error: 'Zonas Extremas: debe haber las 3 categorías (A, B, C)' };
        }
        const elegiblesZE = categorias.filter(f => f.elegible);
        if (elegiblesZE.length === 0) {
            return { valido: false, error: 'Zonas Extremas está activa pero ninguna categoría está habilitada' };
        }
    }

    return { valido: true };
}

// ═════════════════════════════════════════════════════════════════════════
// DIFF antes de guardar (sección 10/27) — comparación legible para el modal
// de confirmación. Réplica orientada a UI de compararConfiguraciones() del
// backend (que sigue siendo la fuente de verdad para lo que efectivamente
// cambió) — acá se arma texto legible en vez de un bloque JSON crudo.
// ═════════════════════════════════════════════════════════════════════════
const NOMBRE_CRITERIO_UI = {
    PRIORIDAD_CATEGORIA: 'Prioridad de categoría',
    MENOS_DESIGNACIONES_TEMPORADA: 'Menos designaciones',
    MENOR_DISTANCIA: 'Menor distancia',
    EQUIDAD_TRASLADOS: 'Equidad de traslados'
};

function textoOrdenCriterios(ordenCriterios) {
    return (ordenCriterios || [])
        .slice().sort((a, b) => a.orden - b.orden)
        .map(o => NOMBRE_CRITERIO_UI[o.criterio_codigo] || o.criterio_codigo)
        .join(' → ');
}

function textoOrdenCategorias(filasClasificacion) {
    return (filasClasificacion || [])
        .filter(f => f.elegible)
        .sort((a, b) => a.orden_preferencia - b.orden_preferencia)
        .map(f => f.categoria)
        .join('→');
}

// @returns { hayDiferencias, cambios: [{ etiqueta, antes, despues }] }
function construirDiffParaUI(configBase, configNueva) {
    const a = configBase || {}, b = configNueva || {};
    const cambios = [];

    const textoOrdenA = textoOrdenCriterios(a.ordenCriterios), textoOrdenB = textoOrdenCriterios(b.ordenCriterios);
    if (textoOrdenA !== textoOrdenB) {
        cambios.push({ etiqueta: 'Prioridades', antes: textoOrdenA, despues: textoOrdenB });
    }

    const distA = a.regla_distancia_maxima_activa ? `${a.distancia_maxima_km} km` : 'Desactivada';
    const distB = b.regla_distancia_maxima_activa ? `${b.distancia_maxima_km} km` : 'Desactivada';
    if (distA !== distB) cambios.push({ etiqueta: 'Distancia máxima', antes: distA, despues: distB });

    // Equidad de traslados (schema_version=2) — revisión de cierre, sección
    // 19/31: schema, activación y umbral se muestran como líneas separadas
    // del diff, igual que el resto de las reglas.
    const schemaA = a.schema_version ?? 1, schemaB = b.schema_version ?? 1;
    if (schemaA !== schemaB) cambios.push({ etiqueta: 'Schema', antes: String(schemaA), despues: String(schemaB) });

    const eqActivaA = a.regla_equidad_traslados_activa === true, eqActivaB = b.regla_equidad_traslados_activa === true;
    if (eqActivaA !== eqActivaB) {
        cambios.push({ etiqueta: 'Equidad de traslados', antes: eqActivaA ? 'Activada' : 'Desactivada', despues: eqActivaB ? 'Activada' : 'Desactivada' });
    }
    const umbralA = a.umbral_lejania_km ?? null, umbralB = b.umbral_lejania_km ?? null;
    if (umbralA !== umbralB) {
        cambios.push({ etiqueta: 'Umbral de lejanía', antes: umbralA !== null ? `${umbralA} km` : '—', despues: umbralB !== null ? `${umbralB} km` : '—' });
    }

    const REGLAS_UI = [
        ['regla_no_repetir_asociacion_activa', 'No repetir asociación durante la temporada'],
        ['regla_un_rodeo_por_finde_activa', 'Máximo un rodeo por fin de semana'],
        ['regla_finde_consecutivo_activa', 'Evitar fin de semana consecutivo'],
        ['regla_asociacion_organizadora_activa', 'No designar jurado de la asociación organizadora']
    ];
    REGLAS_UI.forEach(([campo, etiqueta]) => {
        if (a[campo] !== b[campo]) {
            cambios.push({ etiqueta, antes: a[campo] ? 'Activada' : 'Desactivada', despues: b[campo] ? 'Activada' : 'Desactivada' });
        }
    });

    CLASIFICACIONES_CONOCIDAS_UI.forEach(codigo => {
        const filasA = (a.matriz || {})[codigo] || [], filasB = (b.matriz || {})[codigo] || [];
        const eleg_A = filasA.filter(f => f.elegible).map(f => f.categoria).sort().join(',');
        const eleg_B = filasB.filter(f => f.elegible).map(f => f.categoria).sort().join(',');
        const ordenA = textoOrdenCategorias(filasA), ordenB = textoOrdenCategorias(filasB);
        if (eleg_A !== eleg_B || ordenA !== ordenB) {
            cambios.push({ etiqueta: codigo, antes: `${eleg_A || '—'} (${ordenA || '—'})`, despues: `${eleg_B || '—'} (${ordenB || '—'})` });
        }
    });

    // Zonas Extremas (schema_version=3) — mismas 3 líneas conceptuales del
    // pedido (sección 21): activación, asociaciones incluidas, prioridad de
    // categorías. Mismo estilo antes/después PLANO (lista completa, no un
    // delta +/-) que ya usa el resto de esta función (Prioridades/matriz por
    // clasificación arriba) — consistencia con el patrón ya establecido.
    const zeActivaA = a.regla_zonas_extremas_activa === true, zeActivaB = b.regla_zonas_extremas_activa === true;
    if (zeActivaA !== zeActivaB) {
        cambios.push({ etiqueta: 'Zonas Extremas', antes: zeActivaA ? 'Activada' : 'Desactivada', despues: zeActivaB ? 'Activada' : 'Desactivada' });
    }
    const asocA = ((a.zonas_extremas && a.zonas_extremas.asociaciones) || []).slice().sort();
    const asocB = ((b.zonas_extremas && b.zonas_extremas.asociaciones) || []).slice().sort();
    if (asocA.join('|') !== asocB.join('|')) {
        cambios.push({ etiqueta: 'Asociaciones Zona Extrema', antes: asocA.join(', ') || '—', despues: asocB.join(', ') || '—' });
    }
    const prioridadZeA = textoOrdenCategorias((a.zonas_extremas && a.zonas_extremas.categorias) || []);
    const prioridadZeB = textoOrdenCategorias((b.zonas_extremas && b.zonas_extremas.categorias) || []);
    if (prioridadZeA !== prioridadZeB) {
        cambios.push({ etiqueta: 'Prioridad Zona Extrema', antes: prioridadZeA || '—', despues: prioridadZeB || '—' });
    }

    return { hayDiferencias: cambios.length > 0, cambios };
}

// Funciona como <script> global en el navegador y como módulo require()-able
// en Node/Jest — mismo patrón que candidatosFiltro.js.
const _configuracionDesignacionHelpersExports = {
    CRITERIOS_CONOCIDOS_UI, CRITERIOS_CONOCIDOS_UI_POR_SCHEMA, criteriosConocidosUIParaSchema,
    CLASIFICACIONES_CONOCIDAS_UI, CATEGORIAS_CONOCIDAS_UI, DISTANCIA_MAXIMA_TECNICA_KM_UI,
    UMBRAL_LEJANIA_TECNICO_KM_UI, UMBRAL_LEJANIA_DEFAULT_KM_UI,
    activarCriterio, desactivarCriterio, moverCriterio,
    activarEquidadTraslados, desactivarEquidadTraslados,
    activarCategoria, desactivarCategoria, moverCategoria,
    validarDraft, construirDiffParaUI,
    // Mejora "Zonas Extremas" (schema_version=3).
    activarZonasExtremas, desactivarZonasExtremas,
    agregarAsociacionZonaExtrema, quitarAsociacionZonaExtrema,
    _normalizarAsociacionUI
};
if (typeof module !== 'undefined' && module.exports) {
    module.exports = _configuracionDesignacionHelpersExports;
}
if (typeof window !== 'undefined') {
    Object.assign(window, _configuracionDesignacionHelpersExports);
}
