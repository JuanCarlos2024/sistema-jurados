// ═════════════════════════════════════════════════════════════════════════
// cartillaDelegadoGanado.js — fórmula ÚNICA y testeable para el porcentaje
// de "Ganado bajo/sobrepeso reglamentario" por Animal (5ª revisión, punto
// 6). El Delegado nunca calcula el porcentaje a mano: se obtiene siempre
// desde "# Ganado" (cantidad total del animal) y "Ganado bajo/sobrepeso
// reglamentario" (cantidad fuera de peso).
//
// Esta MISMA fórmula se replica manualmente en el formulario del Delegado
// (frontend/usuario/cartilla-delegado.html: calcularPctFueraPesoAnimal) y
// en el PDF (backend/src/services/cartilla-delegado-pdf.js) — ambos
// entornos no pueden compartir un módulo Node/navegador único en este
// proyecto (sin bundler), así que el backend fija acá el resultado
// esperado y este archivo queda como la referencia probada.
// ═════════════════════════════════════════════════════════════════════════

// Devuelve el porcentaje (número, 1 decimal) o `null` si no se puede
// calcular (ganado 0/vacío/no numérico) — NUNCA 0 falso por división por
// cero. `cantidadFueraPeso` inválida o negativa se trata como 0.
function calcularPorcentajeFueraPeso(cantidadGanado, cantidadFueraPeso) {
    const ganado = parseFloat(cantidadGanado);
    if (isNaN(ganado) || ganado <= 0) return null;
    const fuera = parseFloat(cantidadFueraPeso);
    const fueraValida = (!isNaN(fuera) && fuera >= 0) ? fuera : 0;
    return Math.round((fueraValida / ganado) * 1000) / 10;
}

module.exports = { calcularPorcentajeFueraPeso };
