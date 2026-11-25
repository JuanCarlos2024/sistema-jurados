// ═════════════════════════════════════════════════════════════════════════
// consultaPorLotes.js — consultas Supabase con filtro `.in(columna, ids)`
// sobre listas de IDs que CRECEN durante la temporada.
//
// Incidente 2026-11-25 (simulación de Propuesta de Designación): PostgREST
// devuelve la consulta completa en la cabecera `Content-Location`. Con ~390
// UUIDs en un `.in()`, las cabeceras de la RESPUESTA superan los 16 KB que
// acepta Node (UND_ERR_HEADERS_OVERFLOW) y la consulta falla con "TypeError:
// fetch failed", aunque Supabase la haya respondido 200. La solución es
// acotar el tamaño de cada consulta (lotes), NO ampliar el límite de
// cabeceras de Node ni los tiempos de espera.
//
// Garantías:
//   · IDs normalizados: sin null/undefined/'' y sin duplicados (se conserva
//     el orden de primera aparición).
//   · Lista vacía → [] sin ninguna consulta.
//   · Lotes de como máximo `tamanoLote` IDs (150 por defecto: ~5,6 KB de
//     URL, lejos del límite), consultados en SECUENCIA (sin paralelismo).
//   · Paginación dentro de cada lote: dividir IDs no garantiza recuperar
//     todas las filas (una relación 1→N puede devolver más filas que IDs, y
//     PostgREST corta en `max_rows`). Cada lote se pide por páginas de
//     `tamanoPagina` (900, mismo tamaño que el resto del proyecto, por debajo
//     del max_rows=1000 de Supabase) hasta recibir una página incompleta.
//     `ordenarPor` (columna ÚNICA) hace la paginación determinista.
//   · Sin truncamiento silencioso: el límite efectivo de la API (max_rows)
//     se verificó en producción el 2026-11-25 = 1000 filas por respuesta
//     (pedir 5000 devuelve 1000). Si alguien lo bajara por debajo de 900,
//     una página recortada parecería "la última". Por eso la primera página
//     de cada lote pide count=exact y, al terminar el lote, se exige
//     filas recuperadas === total; si no, se lanza un error.
//   · Todo o nada: si falla cualquier lote o página se lanza un error y no
//     se devuelve ningún resultado parcial.
// ═════════════════════════════════════════════════════════════════════════

const TAMANO_LOTE_IDS = 150;
const TAMANO_PAGINA = 900;

function normalizarIds(ids) {
    const vistos = new Set();
    const salida = [];
    for (const id of (ids || [])) {
        if (id === null || id === undefined || id === '') continue;
        if (vistos.has(id)) continue;
        vistos.add(id);
        salida.push(id);
    }
    return salida;
}

function dividirEnLotes(ids, tamanoLote = TAMANO_LOTE_IDS) {
    if (!Number.isInteger(tamanoLote) || tamanoLote < 1) throw new Error('tamanoLote inválido');
    const lotes = [];
    for (let i = 0; i < ids.length; i += tamanoLote) lotes.push(ids.slice(i, i + tamanoLote));
    return lotes;
}

class ErrorConsultaPorLotes extends Error {
    constructor(mensaje, { lote, totalLotes, offset }) {
        super(mensaje);
        this.name = 'ErrorConsultaPorLotes';
        this.lote = lote;
        this.totalLotes = totalLotes;
        this.offset = offset;
    }
}

// @param opciones.construirConsulta  (opcionesSelect) => query builder NUEVO
//        de Supabase, con from/select y TODOS los filtros originales
//        (eq/neq/...), sin `.in()` ni `.range()` — se agregan acá para cada
//        lote/página. DEBE pasar `opcionesSelect` como segundo argumento de
//        `.select(columnas, opcionesSelect)` (count=exact en la 1.ª página).
// @param opciones.columna            columna del filtro `.in()`.
// @param opciones.ids                lista de IDs (puede tener duplicados/vacíos).
// @param opciones.ordenarPor         columna única para paginación determinista (opcional).
// @returns Promise<Array> todas las filas de todos los lotes.
// @throws  ErrorConsultaPorLotes con el mensaje original de Supabase.
async function seleccionarPorLotes({
    construirConsulta, columna, ids, ordenarPor = null,
    tamanoLote = TAMANO_LOTE_IDS, tamanoPagina = TAMANO_PAGINA
}) {
    if (typeof construirConsulta !== 'function') throw new Error('construirConsulta debe ser una función');
    if (!columna) throw new Error('columna es requerida');
    if (!Number.isInteger(tamanoPagina) || tamanoPagina < 1) throw new Error('tamanoPagina inválido');

    const unicos = normalizarIds(ids);
    if (unicos.length === 0) return [];

    const lotes = dividirEnLotes(unicos, tamanoLote);
    const filas = [];
    for (let i = 0; i < lotes.length; i++) {
        let offset = 0;
        let totalEsperado = null;
        let recuperadas = 0;
        while (true) {
            // Primera página: count=exact (total del filtro, sin el corte de
            // max_rows) para detectar truncamiento silencioso al final del lote.
            let q = construirConsulta(offset === 0 ? { count: 'exact' } : undefined).in(columna, lotes[i]);
            if (ordenarPor) q = q.order(ordenarPor, { ascending: true });
            const { data, error, count } = await q.range(offset, offset + tamanoPagina - 1);
            if (error) {
                throw new ErrorConsultaPorLotes(error.message || String(error), { lote: i + 1, totalLotes: lotes.length, offset });
            }
            if (offset === 0 && typeof count === 'number') totalEsperado = count;
            const pagina = data || [];
            for (const f of pagina) filas.push(f);
            recuperadas += pagina.length;
            if (pagina.length < tamanoPagina) break;
            offset += tamanoPagina;
        }
        // Defensa ante una futura baja de max_rows en la API de Supabase por
        // debajo de `tamanoPagina`: una página "incompleta" por recorte del
        // servidor cortaría el bucle sin error. Se compara con el total real.
        if (totalEsperado !== null && recuperadas !== totalEsperado) {
            throw new ErrorConsultaPorLotes(
                `Resultado incompleto: se recuperaron ${recuperadas} de ${totalEsperado} filas (posible límite de filas de la API menor a ${tamanoPagina})`,
                { lote: i + 1, totalLotes: lotes.length, offset }
            );
        }
    }
    return filas;
}

module.exports = {
    seleccionarPorLotes, normalizarIds, dividirEnLotes, ErrorConsultaPorLotes,
    TAMANO_LOTE_IDS, TAMANO_PAGINA
};
