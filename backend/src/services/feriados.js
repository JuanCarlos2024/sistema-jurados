// ─── Feriados de Chile y "bloque de fin de semana de rodeo" ───────────────
// Centralizado aquí (extraído tal cual, sin cambiar el algoritmo, desde
// backend/src/routes/admin/asignaciones.js, que a su vez lo portó de
// frontend/usuario/dashboard.html — calcularFeriadosChile) para que
// cualquier módulo que necesite esta lógica (asignaciones.js, el motor de
// propuesta de designación) use la MISMA versión, sin duplicarla.
function calcularFeriadosChile(anio) {
    const f = new Set();
    const pad = n => String(n).padStart(2, '0');
    const add = (m, d) => f.add(`${anio}-${pad(m)}-${pad(d)}`);

    add(1,1);  add(5,1);  add(5,21); add(6,29); add(7,16);
    add(8,15); add(9,18); add(9,19); add(10,12); add(10,31);
    add(11,1); add(12,8); add(12,25);
    add(6,21); // Día Nacional de los Pueblos Indígenas (solsticio de invierno)

    // Semana Santa — algoritmo Meeus/Jones/Butcher para el Domingo de Pascua
    const a = anio % 19;
    const b = Math.floor(anio / 100), c = anio % 100;
    const d2 = Math.floor(b / 4), e = b % 4;
    const ff = Math.floor((b + 8) / 25);
    const g  = Math.floor((b - ff + 1) / 3);
    const h  = (19 * a + b - d2 - g + 15) % 30;
    const i  = Math.floor(c / 4), k = c % 4;
    const l  = (32 + 2 * e + 2 * i - h - k) % 7;
    const mm = Math.floor((a + 11 * h + 22 * l) / 451);
    const mesPascua = Math.floor((h + l - 7 * mm + 114) / 31);
    const diaPascua = ((h + l - 7 * mm + 114) % 31) + 1;
    const pascuaMs = Date.UTC(anio, mesPascua - 1, diaPascua);
    const toStr = ms => {
        const dt = new Date(ms);
        return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
    };
    f.add(toStr(pascuaMs - 2 * 86400000)); // Viernes Santo
    f.add(toStr(pascuaMs - 1 * 86400000)); // Sábado Santo

    return f;
}

const _feriadosCache = {};
function esDiaRodeo(fechaStr) {
    const d = new Date(fechaStr + 'T00:00:00Z');
    const dow = d.getUTCDay(); // 0=domingo, 6=sábado
    if (dow === 0 || dow === 6) return true;
    const anio = d.getUTCFullYear();
    if (!_feriadosCache[anio]) _feriadosCache[anio] = calcularFeriadosChile(anio);
    return _feriadosCache[anio].has(fechaStr);
}

function sumarDiasFecha(fechaStr, n) {
    const d = new Date(fechaStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

// Expande una fecha de rodeo (inicio + duración) hacia atrás/adelante mientras
// los días adyacentes sean sábado/domingo/feriado, formando el "bloque" completo
// de la jornada de rodeo (fin de semana, o fin de semana extendido por feriado).
function calcularBloqueRodeo(fechaInicio, duracionDias) {
    let inicio = fechaInicio;
    let fin    = sumarDiasFecha(fechaInicio, (duracionDias || 1) - 1);
    while (esDiaRodeo(sumarDiasFecha(inicio, -1))) inicio = sumarDiasFecha(inicio, -1);
    while (esDiaRodeo(sumarDiasFecha(fin, 1)))      fin    = sumarDiasFecha(fin, 1);
    return { inicio, fin };
}

// Cuenta los sábados estrictamente entre dos fechas (no inclusive). Si es 0,
// no hay ningún fin de semana "libre" saltado entre ambos bloques de rodeo.
function contarSabadosEntre(fechaDesdeExclusiva, fechaHastaExclusiva) {
    let count = 0;
    let cursor = sumarDiasFecha(fechaDesdeExclusiva, 1);
    while (cursor < fechaHastaExclusiva) {
        if (new Date(cursor + 'T00:00:00Z').getUTCDay() === 6) count++;
        cursor = sumarDiasFecha(cursor, 1);
    }
    return count;
}

// Lista de fechas (YYYY-MM-DD) que ocupa un rodeo: [fecha, fecha+1, ..., fecha+duracion-1].
// Mismo cálculo ya usado inline en rodeos.js (jurados-disponibles) y
// asignaciones.js (POST /) — centralizado aquí para el motor de propuesta.
function rangoFechas(fechaInicio, duracionDias) {
    const dias = duracionDias || 1;
    const out = [];
    for (let i = 0; i < dias; i++) out.push(sumarDiasFecha(fechaInicio, i));
    return out;
}

module.exports = { calcularFeriadosChile, esDiaRodeo, sumarDiasFecha, calcularBloqueRodeo, contarSabadosEntre, rangoFechas };
