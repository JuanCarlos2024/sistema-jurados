// ═════════════════════════════════════════════════════════════════════════
// Histórico de colleras completas — PREVIEW e importación con confirmación.
//
// Fuente: "COLLERAS COMPLETAS DESDE 2023 AL 2026.xlsx" (Hoja1). Layout real:
//   fila 1: encabezado de fecha por columna ("27-28 SEPT", "16 Y 17 NOV"…)
//   fila 2: mes cuando el encabezado no lo trae ("OCT", "NOV", "DIC"…)
//   luego, por temporada, un par de filas: ["2025 /", v1, v2…] y [2026]
// Problemas conocidos (NO se adivina): encabezados dañados por Excel (serial
// "4-May" que en realidad es "4-5 OCT"), sin año, "XXXX", celdas vacías, y
// los mismos encabezados se comparten entre temporadas (la fecha real de cada
// medición en temporadas anteriores NO está en el archivo).
//
// Estados por celda: VALIDO · REQUIERE_CONFIRMACION · SIN_FECHA · VACIO ·
// INVALIDO. Solo VALIDO, o REQUIERE_CONFIRMACION con fecha confirmada
// explícitamente por una persona, se importan (fecha_confirmada = true).
// ═════════════════════════════════════════════════════════════════════════
const XLSX = require('xlsx');
const supabase = require('../../config/supabase');
const { normalizarTexto } = require('../geografia');
const { esISO, toISO } = require('./fechasEquivalentes');

const MESES = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12 };
const FUENTE = 'COLLERAS COMPLETAS DESDE 2023 AL 2026 (Excel)';

function mesDeTexto(t) {
    const n = normalizarTexto(String(t ?? '')).replace(/[^a-z]/g, '');
    return n.length >= 3 ? (MESES[n.slice(0, 3)] || null) : null;
}

// Año calendario del mes dentro de la temporada 'A-B' (regla definida por la Federación):
// abril–diciembre → A ; enero–marzo → B.
function anioDeMes(temporada, mes) {
    const [a, b] = temporada.split('-').map(Number);
    return mes >= 4 ? a : b;
}
function fechaISO(anio, mes, dia) {
    const d = new Date(Date.UTC(anio, mes - 1, dia));
    return (d.getUTCFullYear() === anio && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia) ? toISO(d) : null;
}

// Devuelve { estado, fecha_interpretada, fecha_sugerida, observacion } para el ENCABEZADO.
function interpretarEncabezado(raw, mesFila2, temporada) {
    if (raw === null || raw === undefined || String(raw).trim() === '') {
        return { estado: 'SIN_FECHA', fecha_interpretada: null, fecha_sugerida: null, observacion: 'Columna sin encabezado de fecha' };
    }
    const mesFila = mesDeTexto(mesFila2);
    let d1, d2, mes, obs = [];

    if (typeof raw === 'number') {
        const f = new Date(Math.round((raw - 25569) * 86400000));
        const iso = toISO(f);
        const dia = f.getUTCDate(), mesSerial = f.getUTCMonth() + 1;
        if (!mesFila) {
            return { estado: 'REQUIERE_CONFIRMACION', fecha_interpretada: null, fecha_sugerida: iso, observacion: `Encabezado numérico (serial de Excel ${iso}) sin fila 2 para validarlo: puede ser una fecha real o un rango dañado (p. ej. "4-5" convertido en 04/05)` };
        }
        if (mesSerial === mesFila) {
            // Fecha real: solo VALIDA si cae dentro de la temporada (abril(A)–marzo(B)).
            const [a, b] = temporada.split('-').map(Number);
            const dentro = iso >= `${a}-04-01` && iso <= `${b}-03-31`;
            return dentro
                ? { estado: 'VALIDO', fecha_interpretada: iso, fecha_sugerida: iso, observacion: 'Fecha de encabezado consistente con la fila 2 y dentro de la temporada' }
                : { estado: 'REQUIERE_CONFIRMACION', fecha_interpretada: null, fecha_sugerida: iso, observacion: `Fecha de encabezado (${iso}) fuera de la temporada ${temporada}` };
        }
        // El mes de la fila 2 contradice al serial: Excel convirtió "d1-d2" en fecha (día=d1, mes=d2).
        d1 = dia; d2 = mesSerial; mes = mesFila;
        obs.push(`Encabezado dañado: Excel lo convirtió en la fecha ${iso}; se reconstruye como "${d1}-${d2} ${Object.keys(MESES).find(k => MESES[k] === mes).toUpperCase()}" usando la fila 2`);
    } else {
        const m = /^\s*(\d{1,2})\s*(?:y|\s)\s*(\d{1,2})\s*(.*?)\s*$/i.exec(normalizarTexto(String(raw)));
        if (!m) return { estado: 'SIN_FECHA', fecha_interpretada: null, fecha_sugerida: null, observacion: `Encabezado no interpretable: "${raw}"` };
        d1 = Number(m[1]); d2 = Number(m[2]);
        mes = mesDeTexto(m[3]) || mesFila;
        if (!mes) return { estado: 'SIN_FECHA', fecha_interpretada: null, fecha_sugerida: null, observacion: `Encabezado "${raw}" sin mes identificable` };
    }
    // d2 < d1 => el rango cruza de mes (p. ej. 31-02 NOV = 31 oct → 2 nov).
    const mesFin = mes, mesIni = d2 < d1 ? (mes === 1 ? 12 : mes - 1) : mes;
    const anioFin = anioDeMes(temporada, mesFin);
    const anioIni = mesIni === 12 && mesFin === 1 ? anioFin - 1 : anioDeMes(temporada, mesIni);
    const ini = fechaISO(anioIni, mesIni, d1), fin = fechaISO(anioFin, mesFin, d2);
    if (!ini || !fin) return { estado: 'SIN_FECHA', fecha_interpretada: null, fecha_sugerida: null, observacion: `Encabezado "${raw}" produce una fecha inexistente` };

    // Decisión funcional: cada encabezado es un FIN DE SEMANA DE REFERENCIA y la fecha almacenada es el
    // ÚLTIMO DÍA del rango. Es una fecha de referencia histórica, no la hora exacta de extracción del dato.
    obs.push(`Fecha de referencia histórica = último día del fin de semana del encabezado (${ini}..${fin}); no indica la hora exacta en que se extrajo el dato`);
    return { estado: 'VALIDO', fecha_interpretada: fin, fecha_sugerida: fin, rango: { inicio: ini, fin }, reconstruido: typeof raw === 'number', observacion: obs.join('. ') };
}

function parsearHoja(buffer) {
    let wb;
    try { wb = XLSX.read(buffer, { type: 'buffer' }); }
    catch (e) { throw new Error('No se pudo leer el archivo Excel: ' + e.message); }
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws || !ws['!ref']) throw new Error('La hoja está vacía');
    const c0 = XLSX.utils.decode_range(ws['!ref']).s.c;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    const letra = j => XLSX.utils.encode_col(c0 + j);
    const entradas = [];
    const temporadasVistas = [];

    for (let i = 2; i < rows.length; i++) {
        const etiqueta = rows[i] && rows[i][0];
        const m = typeof etiqueta === 'string' ? /^\s*(\d{4})\s*\/?\s*$/.exec(etiqueta) : null;
        if (!m) continue;
        const a = Number(m[1]);
        const sig = rows[i + 1] && rows[i + 1][0];
        const b = sig !== null && sig !== undefined ? Number(String(sig).trim()) : NaN;
        if (b !== a + 1) throw new Error(`Fila ${i + 1}: no se pudo determinar la temporada (se esperaba ${a + 1} en la fila siguiente)`);
        const temporada = `${a}-${b}`;
        temporadasVistas.push(temporada);
        const fila = rows[i];
        for (let j = 1; j < (rows[0] || []).length; j++) {
            const valor = fila[j];
            const enc = interpretarEncabezado(rows[0][j], rows[1] ? rows[1][j] : null, temporada);
            let estado = enc.estado, observacion = enc.observacion;
            const valorVacio = valor === null || valor === undefined || String(valor).trim() === '';
            const valorValido = typeof valor === 'number' && Number.isFinite(valor) && Number.isInteger(valor) && valor >= 0;
            if (valorVacio) { if (rows[0][j] === null && enc.estado === 'SIN_FECHA') continue; estado = 'VACIO'; observacion = 'Celda sin valor'; }
            else if (!valorValido) { estado = 'INVALIDO'; observacion = `Valor no numérico o inválido: "${valor}"`; }
            entradas.push({
                clave: `${temporada}|${letra(j)}`, temporada, columna: letra(j),
                encabezado_original: rows[0][j] ?? null, mes_fila_2: rows[1] ? (rows[1][j] ?? null) : null,
                fecha_interpretada: estado === 'VALIDO' ? enc.fecha_interpretada : null, encabezado_reconstruido: !!enc.reconstruido,
                fecha_sugerida: enc.fecha_sugerida || null, rango: enc.rango || null,
                valor: valorValido ? valor : null, estado, observacion
            });
        }
    }
    if (!temporadasVistas.length) throw new Error('No se encontraron filas de temporada (formato esperado: "2025 /" seguido del año siguiente)');

    // Observación de coherencia: la serie es acumulativa; un descenso es sospechoso.
    for (const t of temporadasVistas) {
        let previo = null;
        for (const e of entradas.filter(x => x.temporada === t && x.valor !== null)) {
            if (previo !== null && e.valor < previo) e.observacion += '. Valor menor que la medición anterior (serie acumulativa): revisar';
            previo = e.valor;
        }
    }
    return { entradas, temporadas: temporadasVistas };
}

function previewHistoricoColleras(buffer, { confirmaciones = [] } = {}) {
    const { entradas, temporadas } = parsearHoja(buffer);
    const confMap = new Map((confirmaciones || []).filter(c => c && esISO(c.fecha_medicion)).map(c => [c.clave, c.fecha_medicion]));
    const cuenta = e => entradas.filter(x => x.estado === e).length;
    const filas = entradas.map(e => ({ ...e, fecha_confirmada_por_usuario: confMap.get(e.clave) || null }));
    const importables = filas.filter(f => f.estado === 'VALIDO' || (f.estado === 'REQUIERE_CONFIRMACION' && f.fecha_confirmada_por_usuario));
    return {
        filas,
        resumen: {
            temporadas, total_celdas: filas.length,
            validos: cuenta('VALIDO'), requieren_confirmacion: cuenta('REQUIERE_CONFIRMACION'),
            sin_fecha: cuenta('SIN_FECHA'), vacios: cuenta('VACIO'), invalidos: cuenta('INVALIDO'),
            importables_ahora: importables.length
        },
        aviso: 'Vista previa: no se guardó nada. Las filas REQUIERE_CONFIRMACION no se importan automáticamente: cada una necesita una fecha confirmada explícitamente (clave + fecha_medicion).'
    };
}

// confirmaciones: [{ clave:'2025-2026|C', fecha_medicion:'2025-09-28' }] — re-lee y revalida el archivo.
async function confirmarHistoricoColleras(buffer, confirmaciones, { db = supabase, nombreArchivo = 'historico_colleras.xlsx', actorId = null } = {}) {
    const preview = previewHistoricoColleras(buffer, { confirmaciones });
    const aInsertar = preview.filas.filter(f => f.estado === 'VALIDO' || (f.estado === 'REQUIERE_CONFIRMACION' && f.fecha_confirmada_por_usuario));
    const noImportadas = preview.filas.length - aInsertar.length;

    const { data: imp, error: eImp } = await db.from('importaciones')
        .insert({ nombre_archivo: nombreArchivo, tipo: 'historico_colleras', total_filas: preview.filas.length, created_by: actorId }).select().single();
    if (eImp) throw new Error('No se pudo registrar la importación: ' + eImp.message);

    const registros = aInsertar.map(f => ({
        temporada: f.temporada,
        fecha_medicion: f.estado === 'VALIDO' ? f.fecha_interpretada : f.fecha_confirmada_por_usuario,
        total_colleras: f.valor, fuente: FUENTE, importacion_id: imp.id, fecha_confirmada: true,
        observacion: `${f.observacion}. Celda ${f.columna}; encabezado original: ${f.encabezado_original ?? '(vacío)'}${f.mes_fila_2 ? ` (mes fila 2: ${f.mes_fila_2})` : ''}${f.estado === 'REQUIERE_CONFIRMACION' ? '; fecha confirmada manualmente' : ''}`
    }));
    let insertadas = 0;
    if (registros.length) {
        const { data, error } = await db.from('historico_colleras_medicion')
            .upsert(registros, { onConflict: 'temporada,fecha_medicion', ignoreDuplicates: true }).select('id');
        if (error) throw new Error('Error insertando histórico de colleras: ' + error.message);
        insertadas = (data || []).length;
    }
    await db.from('importaciones').update({
        insertadas, pendientes: noImportadas, duplicadas: registros.length - insertadas, rechazadas: 0, errores: 0
    }).eq('id', imp.id);
    return { importacion_id: imp.id, insertadas, no_importadas: noImportadas, resumen: preview.resumen };
}

module.exports = { mesDeTexto, interpretarEncabezado, parsearHoja, previewHistoricoColleras, confirmarHistoricoColleras };
