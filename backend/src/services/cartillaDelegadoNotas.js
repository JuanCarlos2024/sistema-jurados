// ═════════════════════════════════════════════════════════════════════════
// cartillaDelegadoNotas.js — "III. Informe sobre el desempeño del Jurado"
// (nuevo formato oficial 2026-2027 de la Cartilla de Delegado).
//
// Exactamente 4 aspectos de evaluación, cada uno con nota 1.0–7.0, más una
// Nota Promedio calculada automáticamente = (n1+n2+n3+n4)/4.
//
// CONEXIÓN CON "NOTA DELEGADO" YA EXISTENTE — gate explícito del pedido: la
// Nota Promedio de esta sección NO es una nota nueva independiente, alimenta
// la MISMA columna que ya usan los reportes/exportaciones del sistema:
// rodeo_notas_secundarias.nota_delegado (NUMERIC(3,1), 1 fila por rodeo,
// migración 028 — la misma fuente que ya lee/exporta el Excel de Rodeos y
// que hoy edita manualmente el administrador desde "Notas secundarias").
// Se sincroniza SOLO cuando las 4 notas están completas y válidas, y SOLO al
// enviar/reenviar la cartilla (nunca en cada guardado de borrador — evita
// que un promedio a medio completar pise el valor oficial mientras el
// delegado todavía está editando). No se crea ninguna tabla ni columna
// nueva para esta nota — es 100% aditivo dentro de respuestas_json.
// ═════════════════════════════════════════════════════════════════════════
const supabase = require('../config/supabase');

const ASPECTOS_DESEMPENO_JURADO = [
    { key: 'aspecto_1', label: 'Sanciona correctamente las faltas en el apiñadero.' },
    { key: 'aspecto_2', label: 'Sanciona correctamente las faltas en la cancha (incluye zona de postura).' },
    { key: 'aspecto_3', label: 'Identifica correctamente atajadas válidas (0-2-3-4). Justifica correctamente las atajadas no válidas. Sanciona correctamente las faltas que se producen en la atajada.' },
    { key: 'aspecto_4', label: 'Sanciona correctamente las faltas que se producen en la cuarta carrera (entrega del novillo).' }
];

const NOTA_MIN = 1.0;
const NOTA_MAX = 7.0;

// ─── Valida un único valor de nota (1.0–7.0) — chequeo EXPLÍCITO, nunca
// `if (!valor)` (un futuro valor válido no debe tratarse como ausente).
// @returns { ok, valor } — valor=null si el campo vino vacío/ausente (válido,
// significa "todavía no completado"); ok=false si vino algo pero fuera de rango.
function validarNotaAspecto(valorCrudo) {
    if (valorCrudo === undefined || valorCrudo === null || valorCrudo === '') {
        return { ok: true, valor: null };
    }
    const n = Number(valorCrudo);
    if (Number.isNaN(n) || n < NOTA_MIN || n > NOTA_MAX) {
        return { ok: false, valor: null };
    }
    return { ok: true, valor: Math.round(n * 10) / 10 };
}

// ─── Valida el objeto completo `desempeno_jurado` (o cualquier objeto con
// aspecto_1..4) — rechaza si ALGÚN aspecto presente está fuera de rango.
// Aspectos ausentes/vacíos son válidos (borrador incompleto permitido).
// @returns { valido, error, camposInvalidos: string[] }
function validarAspectosDesempeno(dj) {
    const obj = dj || {};
    const invalidos = [];
    ASPECTOS_DESEMPENO_JURADO.forEach(({ key }) => {
        const r = validarNotaAspecto(obj[key]);
        if (!r.ok) invalidos.push(key);
    });
    if (invalidos.length > 0) {
        return {
            valido: false,
            error: `Las notas del desempeño del jurado deben estar entre ${NOTA_MIN.toFixed(1)} y ${NOTA_MAX.toFixed(1)}.`,
            camposInvalidos: invalidos
        };
    }
    return { valido: true, error: null, camposInvalidos: [] };
}

// ─── Calcula la Nota Promedio SOLO si las 4 notas están presentes y son
// válidas (1.0–7.0). Si falta alguna o alguna es inválida, retorna null
// (equivalente a "Pendiente" — nunca 0). Redondeo a 1 decimal, mismo
// NUMERIC(3,1) que rodeo_notas_secundarias.nota_delegado.
function calcularPromedioDesempeno(dj) {
    const obj = dj || {};
    const valores = ASPECTOS_DESEMPENO_JURADO.map(({ key }) => validarNotaAspecto(obj[key]));
    if (valores.some(v => !v.ok || v.valor === null)) return null;
    const suma = valores.reduce((acc, v) => acc + v.valor, 0);
    return Math.round((suma / 4) * 10) / 10;
}

// ─── Sincroniza la Nota Promedio (ya calculada y validada) hacia
// rodeo_notas_secundarias.nota_delegado — UPSERT por rodeo_id (UNIQUE),
// preserva nota_comision intacta (no se incluye en el payload, así que el
// UPDATE del conflicto nunca la toca). No hace nada si notaPromedio es null
// (borrador incompleto) — nunca escribe 0 ni borra un valor previo por error.
async function sincronizarNotaDelegado(rodeoId, notaPromedio, actorId) {
    if (notaPromedio === null || notaPromedio === undefined) return { sincronizado: false };
    const ahora = new Date().toISOString();
    const { error } = await supabase
        .from('rodeo_notas_secundarias')
        .upsert({
            rodeo_id: rodeoId,
            nota_delegado: notaPromedio,
            actualizado_por: actorId ? String(actorId) : null,
            actualizado_en: ahora,
            updated_at: ahora
        }, { onConflict: 'rodeo_id' });
    if (error) throw new Error('No se pudo sincronizar la Nota Delegado: ' + error.message);
    return { sincronizado: true, nota_delegado: notaPromedio };
}

module.exports = {
    ASPECTOS_DESEMPENO_JURADO,
    NOTA_MIN,
    NOTA_MAX,
    validarNotaAspecto,
    validarAspectosDesempeno,
    calcularPromedioDesempeno,
    sincronizarNotaDelegado
};
