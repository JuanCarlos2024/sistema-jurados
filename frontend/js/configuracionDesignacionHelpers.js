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

const CRITERIOS_CONOCIDOS_UI = ['PRIORIDAD_CATEGORIA', 'MENOS_DESIGNACIONES_TEMPORADA', 'MENOR_DISTANCIA'];
const CLASIFICACIONES_CONOCIDAS_UI = ['interclubes', 'provincial', 'interasociaciones', 'zonal', 'clasificatorio', 'nacional'];
const CATEGORIAS_CONOCIDAS_UI = ['A', 'B', 'C'];
const DISTANCIA_MAXIMA_TECNICA_KM_UI = 5000;

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
function desactivarCriterio(ordenCriterios, criterioCodigo) {
    const lista = ordenCriterios || [];
    if (lista.length <= 1) return lista; // nunca deja 0 activos
    const restante = lista.filter(c => c.criterio_codigo !== criterioCodigo).sort((a, b) => a.orden - b.orden);
    return renumerar(restante, 'orden');
}

// ─── Mueve un criterio activo un lugar arriba/abajo — intercambia orden ───
// con su vecino inmediato. En los extremos no hace nada.
function moverCriterio(ordenCriterios, criterioCodigo, direccion) {
    const lista = [...(ordenCriterios || [])].sort((a, b) => a.orden - b.orden);
    const idx = lista.findIndex(c => c.criterio_codigo === criterioCodigo);
    if (idx === -1) return lista;
    const destino = direccion === 'arriba' ? idx - 1 : idx + 1;
    if (destino < 0 || destino >= lista.length) return lista;
    [lista[idx], lista[destino]] = [lista[destino], lista[idx]];
    return renumerar(lista, 'orden');
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
    MENOR_DISTANCIA: 'Menor distancia'
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

    return { hayDiferencias: cambios.length > 0, cambios };
}

// Funciona como <script> global en el navegador y como módulo require()-able
// en Node/Jest — mismo patrón que candidatosFiltro.js.
const _configuracionDesignacionHelpersExports = {
    CRITERIOS_CONOCIDOS_UI, CLASIFICACIONES_CONOCIDAS_UI, CATEGORIAS_CONOCIDAS_UI, DISTANCIA_MAXIMA_TECNICA_KM_UI,
    activarCriterio, desactivarCriterio, moverCriterio,
    activarCategoria, desactivarCategoria, moverCategoria,
    validarDraft, construirDiffParaUI
};
if (typeof module !== 'undefined' && module.exports) {
    module.exports = _configuracionDesignacionHelpersExports;
}
if (typeof window !== 'undefined') {
    Object.assign(window, _configuracionDesignacionHelpersExports);
}
