/**
 * Categoría de un jurado para mostrar junto a su nombre (SOLO presentación;
 * no participa en reglas, motor ni pagos). Fuente compartida por Propuesta de
 * Designación, Historial Unificado y su Excel.
 */
// ─── Categoría del jurado (solo presentación) ─────────────────────────────
// Prioriza el registro HISTÓRICO más cercano al hecho:
//   DESIGNACION — asignaciones.categoria_aplicada (fijada al crear/reemplazar
//                 la designación; es la que se usó para el pago),
//   MOTOR       — explicacion_json.jurado_propuesto.categoria (snapshot al
//                 generar la propuesta).
// Solo si no existe registro se usa la categoría ACTUAL del jurado, rotulada
// como tal (nunca se presenta como si fuera la histórica).
const FUENTE_CATEGORIA = { DESIGNACION: 'DESIGNACION', MOTOR: 'MOTOR', ACTUAL: 'ACTUAL' };
function categoriaJurado(fuentes, juradoId, { detalle = null, asignacion = null } = {}) {
    if (!juradoId) return { categoria: null, categoria_fuente: null, categoria_actual: null };
    const id = String(juradoId);
    const actual = fuentes?.categorias?.get(id) || null;
    if (asignacion && String(asignacion.usuario_pagado_id) === id && asignacion.categoria_aplicada) {
        return { categoria: asignacion.categoria_aplicada, categoria_fuente: FUENTE_CATEGORIA.DESIGNACION, categoria_actual: actual };
    }
    const jp = detalle?.explicacion_json?.jurado_propuesto;
    if (detalle && String(detalle.jurado_id_propuesto) === id && jp?.categoria) {
        return { categoria: jp.categoria, categoria_fuente: FUENTE_CATEGORIA.MOTOR, categoria_actual: actual };
    }
    return actual
        ? { categoria: actual, categoria_fuente: FUENTE_CATEGORIA.ACTUAL, categoria_actual: actual }
        : { categoria: null, categoria_fuente: null, categoria_actual: null };
}

module.exports = { FUENTE_CATEGORIA, categoriaJurado };
