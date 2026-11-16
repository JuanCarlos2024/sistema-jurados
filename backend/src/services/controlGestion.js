/**
 * Servicio de Importación de Control de Gestión (Excel generado por GPT a
 * partir del chat de WhatsApp de los jurados).
 *
 * Reutiliza deliberadamente `normalizar()` y el estilo de lectura de
 * services/importacion.js (mismo paquete `xlsx` ya instalado, mismo patrón
 * de matching tolerante a espacios/tildes/mayúsculas) — no se reimplementa
 * una segunda lógica de parseo Excel paralela.
 *
 * Todas las funciones que NO reciben `supabase` son PURAS (mismo input →
 * mismo output, sin tocar la base de datos) — así se pueden probar sin
 * mocks. Las que sí acceden a datos reales (matchear rodeo, leer comentario
 * actual, confirmar) están claramente separadas al final del archivo.
 *
 * CONTRATO CANÓNICO (Fase 2.1.1 — alineado con el Prompt Maestro V2 real,
 * reemplaza el supuesto inicial de la primera implementación): la hoja
 * "Situaciones detectadas" tiene 20 columnas oficiales (ver
 * ENCABEZADOS_SITUACIONES / ALIASES_SITUACION). El Prompt Maestro NO se
 * modifica para adaptarse al parser — es el parser el que se adaptó a él.
 */
const XLSX = require('xlsx');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const { normalizar } = require('./importacion');
// NOTA: se reutiliza normalizar() de services/importacion.js, pero
// DELIBERADAMENTE NO su parsearFecha() — esa función interpreta
// "18/09/2026" como M/D/Y (mes=18) porque está afinada al formato real del
// OTRO importador ("2/25/26", M/D/YY de EE.UU.). El Excel de Control de
// Gestión usa DD/MM/YYYY (formato chileno, ver el ejemplo "18/09/2026" del
// propio pedido) — reutilizar la función compartida habría corrompido
// silenciosamente cualquier fecha con día > 12. parsearFechaCG() de abajo
// es la versión correcta para ESTE formato.

const VERSION_FORMATO_SOPORTADA = 'CG-1.0';
const HOJA_IMPORTACION = 'Importación sistema';
const HOJA_SITUACIONES = 'Situaciones detectadas';

const ENCABEZADOS_IMPORTACION = [
    'Versión formato', 'Rodeo ID', 'Fecha rodeo', 'Club', 'Asociación',
    'Jurado Oficial', 'Clave de vinculación', 'N° situaciones', 'Categorías',
    'Resumen breve monitor', 'Texto comentario monitor', 'IDs situaciones',
    'Estado vinculación', 'Importar'
];

// Las 20 columnas OFICIALES de "Situaciones detectadas" (Prompt Maestro V2).
// Nombres canónicos tal como los define el Prompt Maestro — usados para
// mensajes de error y para la validación estructural de "¿existe al menos
// un alias de este campo en el archivo?".
const ENCABEZADOS_SITUACIONES = [
    'ID Situación', 'Fecha situación', 'Hora', 'Fecha rodeo', 'Club', 'Asociación',
    'Jurado chat', 'Jurado oficial', 'Área', 'Categoría principal', 'Subcategoría',
    'Impacto', 'Descripción unificada', 'Estado / resultado', 'Incluir en comentario',
    'Vinculación', 'Confianza', 'Líneas chat', 'Clave de vinculación', 'Evidencia textual'
];

// Alias tolerados POR CAMPO (Punto 2 de la revisión): variaciones reales de
// redacción del mismo concepto semántico (espacios distintos, "/" vs sin
// "/", "de" intercalado). Deliberadamente ACOTADOS a variantes conocidas del
// MISMO campo — nunca una normalización tan amplia que pudiera confundir
// columnas semánticamente distintas entre sí (ej. "Fecha" sola NUNCA es
// alias de "Fecha situación": ver parsearWorkbook/Punto 14-H). Cada alias
// individual sigue tolerando mayúsculas/tildes/espacios extra vía
// leerCampo() -> normalizar().
const ALIASES_SITUACION = {
    id_situacion_excel: ['ID Situación'],
    fecha_situacion: ['Fecha situación'],
    hora: ['Hora'],
    fecha_rodeo: ['Fecha rodeo'],
    club: ['Club'],
    asociacion: ['Asociación'],
    jurado_chat: ['Jurado chat', 'Jurado (chat)'],
    jurado_oficial: ['Jurado oficial'],
    area: ['Área'],
    categoria_principal: ['Categoría principal'],
    subcategoria: ['Subcategoría'],
    impacto: ['Impacto'],
    descripcion_unificada: ['Descripción unificada'],
    estado_resultado: ['Estado / resultado', 'Estado/Resultado', 'Estado resultado'],
    incluir_en_comentario: ['Incluir en comentario'],
    vinculacion: ['Vinculación'],
    confianza: ['Confianza'],
    lineas_chat: ['Líneas chat', 'Lineas chat', 'Líneas de chat', 'Lineas de chat'],
    clave_vinculacion: ['Clave de vinculación'],
    evidencia_textual: ['Evidencia textual']
};

// Campos INDISPENSABLES por situación (Punto 3) — si cualquiera de estos
// falta para una situación efectivamente referenciada por una fila, esa
// fila NO se importa. Fecha rodeo/Club/Asociación/Jurado oficial NO están
// aquí (son de contexto/cruce, ver cruzarSituacionesConFila) — Hora,
// Subcategoría, Jurado chat y Confianza tampoco (no bloquean por sí solos).
const CAMPOS_SITUACION_OBLIGATORIOS = [
    'id_situacion_excel', 'fecha_situacion', 'area', 'categoria_principal',
    'impacto', 'descripcion_unificada', 'estado_resultado', 'incluir_en_comentario',
    'vinculacion', 'clave_vinculacion', 'evidencia_textual'
];

const ESTADOS_VINCULACION_IMPORTABLES = ['Vinculado al reporte'];

// Límite técnico defensivo (Punto 11) para "Texto comentario monitor" — muy
// por encima de cualquier resumen compacto real; solo evita persistir una
// celda degenerada/corrupta. datos_monitor_rodeo.comentario_monitor es TEXT
// sin límite de Postgres, este tope es una salvaguarda de aplicación, no una
// restricción de columna.
const LIMITE_TEXTO_COMENTARIO = 20000;

// ─── Resultados de la Serie de Campeones (columnas OPCIONALES de
// "Importación sistema") ─────────────────────────────────────────────────
// No forman parte de ENCABEZADOS_IMPORTACION: un Excel CG-1.0 sin ellas se
// importa exactamente igual que antes. Se guardan en datos_monitor_rodeo.
// puntaje_oficial_1er/2do/3er (TEXT) vía la RPC de la migración 101 — nunca
// como situaciones de Control de Gestión.
const COLUMNAS_RESULTADOS_SERIE = [
    { lugar: 1, nombre: '1° lugar puntaje', aliases: ['1° lugar puntaje', '1er lugar puntaje', 'Puntaje 1° lugar'] },
    { lugar: 2, nombre: '2° lugar puntaje', aliases: ['2° lugar puntaje', '2do lugar puntaje', 'Puntaje 2° lugar'] },
    { lugar: 3, nombre: '3° lugar puntaje', aliases: ['3° lugar puntaje', '3er lugar puntaje', 'Puntaje 3° lugar'] }
];
// Entero con cero o más desempates: 27, 27+8, 27-1, 30+12, 22+5+3.
const REGEX_PUNTAJE_SERIE = /^\d+([+-]\d+)*$/;
const LIMITE_PUNTAJE_SERIE = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MOTIVO_RODEO_ID_INEXISTENTE = 'Rodeo ID no existe en el sistema.';

// ─── Parser de fecha PROPIO de Control de Gestión — DD/MM/YYYY (formato
// chileno) o YYYY-MM-DD (ISO), nunca M/D/Y ────────────────────────────────
function parsearFechaCG(valor) {
    if (!valor && valor !== 0) return null;

    if (valor instanceof Date) {
        if (isNaN(valor.getTime())) return null;
        const y = valor.getFullYear();
        const m = String(valor.getMonth() + 1).padStart(2, '0');
        const d = String(valor.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    if (typeof valor === 'number') {
        const fecha = XLSX.SSF.parse_date_code(valor);
        if (!fecha) return null;
        return `${fecha.y}-${String(fecha.m).padStart(2, '0')}-${String(fecha.d).padStart(2, '0')}`;
    }

    const s = String(valor).trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // ISO

    const matchDMY = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (matchDMY) {
        const dia = parseInt(matchDMY[1], 10);
        const mes = parseInt(matchDMY[2], 10);
        const año = parseInt(matchDMY[3], 10);
        if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
        const dt = new Date(año, mes - 1, dia);
        if (isNaN(dt.getTime()) || dt.getMonth() !== mes - 1) return null; // rechaza ej. 31/02
        return `${año}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    }

    return null;
}

// ─── Lectura tolerante de una fila (mismo patrón que importacion.js) ──────
// Busca un valor por nombre de columna exacto y, si no aparece, por su
// forma normalizada (sin tildes/mayúsculas/espacios extra) — tolera lo
// mismo que el importador de Rodeos ya tolera hoy.
function leerCampo(filaRaw, nombreColumna) {
    const fila = {};
    Object.keys(filaRaw).forEach(k => { fila[k.trim()] = filaRaw[k]; });

    if (fila[nombreColumna] !== undefined && fila[nombreColumna] !== '') {
        const v = fila[nombreColumna];
        return typeof v === 'string' ? v.trim() : v;
    }
    const normObjetivo = normalizar(nombreColumna);
    const keyEncontrada = Object.keys(fila).find(k => normalizar(k) === normObjetivo);
    if (keyEncontrada && fila[keyEncontrada] !== undefined && fila[keyEncontrada] !== '') {
        const v = fila[keyEncontrada];
        return typeof v === 'string' ? v.trim() : v;
    }
    return null;
}

// ─── Lee un campo probando una LISTA de nombres de columna alternativos
// (Punto 2 de la revisión) — retorna el primero que matchee, vía leerCampo()
// (que ya tolera mayúsculas/tildes/espacios para CADA alias individual).
function leerCampoAlias(filaRaw, aliases) {
    for (const alias of aliases) {
        const v = leerCampo(filaRaw, alias);
        if (v !== null) return v;
    }
    return null;
}

// ─── Encuentra el nombre real de una hoja tolerando espacios ──────────────
function encontrarHoja(workbook, nombreEsperado) {
    if (workbook.SheetNames.includes(nombreEsperado)) return nombreEsperado;
    const normObjetivo = normalizar(nombreEsperado);
    return workbook.SheetNames.find(n => normalizar(n) === normObjetivo) || null;
}

// ─── PASO 1 (PURO) — Parseo + validación estructural del workbook ────────
// Lanza un Error con mensaje claro si falta una hoja u encabezado — nunca
// intenta "adivinar" una estructura distinta a la documentada.
// @returns { filasImportacion: [...raw], filasSituaciones: [...raw] }
function parsearWorkbook(buffer) {
    let wb;
    try {
        wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    } catch (err) {
        throw new Error('El archivo no es un Excel válido: ' + err.message);
    }

    const nombreHojaImportacion = encontrarHoja(wb, HOJA_IMPORTACION);
    if (!nombreHojaImportacion) {
        throw new Error(`No se encontró la hoja requerida "${HOJA_IMPORTACION}".`);
    }
    const nombreHojaSituaciones = encontrarHoja(wb, HOJA_SITUACIONES);
    if (!nombreHojaSituaciones) {
        throw new Error(`No se encontró la hoja requerida "${HOJA_SITUACIONES}".`);
    }

    const filasImportacion = XLSX.utils.sheet_to_json(wb.Sheets[nombreHojaImportacion], { defval: '' });
    const filasSituaciones = XLSX.utils.sheet_to_json(wb.Sheets[nombreHojaSituaciones], { defval: '' });

    if (filasImportacion.length === 0) {
        throw new Error(`La hoja "${HOJA_IMPORTACION}" no tiene filas de datos.`);
    }

    // Encabezados obligatorios: se validan sobre la PRIMERA fila (todas
    // deberían compartir las mismas columnas) — se mira solo la EXISTENCIA
    // de la clave (no su valor, que puede venir vacío en esa fila puntual)
    // para no dar un falso positivo. Si falta alguno, error explícito con
    // el nombre exacto que falta, nunca una adivinanza.
    const clavesPresentes = new Set(
        Object.keys(filasImportacion[0]).map(k => normalizar(k.trim()))
    );
    const faltantes = ENCABEZADOS_IMPORTACION.filter(col => !clavesPresentes.has(normalizar(col)));
    if (faltantes.length > 0) {
        throw new Error(`Faltan columnas obligatorias en "${HOJA_IMPORTACION}": ${faltantes.join(', ')}.`);
    }

    // Columnas opcionales de resultados: se leen CELDA A CELDA (no desde
    // sheet_to_json) para detectar fórmulas y fechas que Excel haya
    // fabricado a partir de un desempate ("=27+8" -> 35, "27-1" -> 27/ene).
    const hojaImportacion = wb.Sheets[nombreHojaImportacion];
    const columnasResultados = localizarColumnasResultados(hojaImportacion);
    const resultadosSerie = filasImportacion.map(f =>
        extraerResultadosSerie(hojaImportacion, columnasResultados, f.__rowNum__));

    return { filasImportacion, filasSituaciones, columnasResultados, resultadosSerie };
}

// ─── Resultados Serie de Campeones (PURO) ────────────────────────────────
// Comparación de encabezados tolerante a mayúsculas/tildes/espacios y al
// ordinal "º" escrito en lugar del símbolo de grado "°".
function claveEncabezadoResultado(s) {
    return normalizar(String(s ?? '')).replace(/º/g, '°').replace(/\s+/g, '');
}

// Ubica las columnas de resultados en la fila de encabezados de la hoja.
// @returns { presentes, columnas: {1: col|null, 2, 3}, duplicadas: [nombre] }
function localizarColumnasResultados(hoja) {
    const info = { presentes: false, columnas: { 1: null, 2: null, 3: null }, duplicadas: [] };
    if (!hoja || !hoja['!ref']) return info;
    const rango = XLSX.utils.decode_range(hoja['!ref']);
    for (let c = rango.s.c; c <= rango.e.c; c++) {
        const celda = hoja[XLSX.utils.encode_cell({ r: rango.s.r, c })];
        if (!celda || celda.v === undefined || celda.v === null) continue;
        const clave = claveEncabezadoResultado(celda.v);
        for (const def of COLUMNAS_RESULTADOS_SERIE) {
            if (!def.aliases.some(a => claveEncabezadoResultado(a) === clave)) continue;
            if (info.columnas[def.lugar] !== null) info.duplicadas.push(def.nombre);
            else info.columnas[def.lugar] = c;
        }
    }
    info.presentes = Object.values(info.columnas).some(c => c !== null);
    return info;
}

// Valida un puntaje escrito como texto. Vacío = no informado (null), NUNCA 0.
// Los espacios se eliminan ("27 + 8" -> "27+8"); el valor sigue siendo texto.
function validarPuntajeSerie(texto) {
    const crudo = String(texto ?? '');
    const s = crudo.replace(/\s+/g, '');
    if (s === '') return { valor: null, error: null };
    if (s.length > LIMITE_PUNTAJE_SERIE || !REGEX_PUNTAJE_SERIE.test(s)) {
        return { valor: null, error: `"${crudo.trim().slice(0, 40)}" no tiene formato de puntaje (ej. 27, 27+8, 27-1, 22+5+3)` };
    }
    return { valor: s, error: null };
}

// Lee UNA celda de puntaje respetando su tipo real en el Excel.
function leerCeldaPuntajeSerie(celda) {
    if (!celda || celda.t === 'z') return { valor: null, error: null };
    if (celda.f) return { valor: null, error: 'la celda contiene una fórmula; el puntaje debe venir como texto (ej. 27+8)' };
    if (celda.t === 'd' || celda.v instanceof Date) {
        return { valor: null, error: 'Excel interpretó el valor como fecha; el puntaje debe venir como texto (ej. 27-1)' };
    }
    if (celda.t === 'n') {
        if (!Number.isInteger(celda.v) || celda.v < 0) return { valor: null, error: `"${celda.v}" no es un puntaje válido` };
        return { valor: String(celda.v), error: null };
    }
    if (celda.t === 's') return validarPuntajeSerie(celda.v);
    return { valor: null, error: 'tipo de celda no reconocido' };
}

// Extrae los 3 puntajes de una fila (rowNum = índice 0-based de la hoja).
// @returns { columnas_presentes, valores: [p1|null, p2|null, p3|null], errores }
function extraerResultadosSerie(hoja, info, rowNum) {
    const valores = [null, null, null];
    const errores = [];
    if (!info || !info.presentes) return { columnas_presentes: false, valores, errores };
    if (info.duplicadas.length > 0) {
        errores.push(`Columna de resultados duplicada en "${HOJA_IMPORTACION}": ${[...new Set(info.duplicadas)].join(', ')}.`);
        return { columnas_presentes: true, valores, errores };
    }
    for (const def of COLUMNAS_RESULTADOS_SERIE) {
        const col = info.columnas[def.lugar];
        if (col === null || rowNum === undefined) continue;
        const { valor, error } = leerCeldaPuntajeSerie(hoja[XLSX.utils.encode_cell({ r: rowNum, c: col })]);
        if (error) errores.push(`${def.nombre}: ${error}.`);
        else valores[def.lugar - 1] = valor;
    }
    return { columnas_presentes: true, valores, errores };
}

const normalizarPuntajeComparable = (v) => (v === null || v === undefined) ? '' : String(v).replace(/\s+/g, '');

// Compara lugar por lugar los valores del Excel con los registrados.
// comparacion: 'no_informado' | 'nuevo' | 'igual' | 'conflicto'
function compararResultadosSerie(valoresExcel, actuales) {
    return [1, 2, 3].map(lugar => {
        const excel = valoresExcel[lugar - 1];
        const actualCrudo = actuales ? actuales[lugar - 1] : null;
        const actual = normalizarPuntajeComparable(actualCrudo);
        let comparacion;
        if (excel === null) comparacion = 'no_informado';
        else if (actual === '') comparacion = 'nuevo';
        else if (actual === excel) comparacion = 'igual';
        else comparacion = 'conflicto';
        return { lugar, excel, actual: actual === '' ? null : actualCrudo, comparacion };
    });
}

// ─── PASO 2 (PURO) — Validación + extracción de una fila de "Importación
// sistema" ──────────────────────────────────────────────────────────────
// NO decide todavía si se importa (eso requiere matchear el rodeo contra la
// base real) — solo valida forma/tipos y extrae los campos.
// @returns { valores, errores: [] } — errores vacío = fila válida en forma.
function extraerFilaImportacion(filaRaw) {
    const errores = [];

    const version_formato = leerCampo(filaRaw, 'Versión formato');
    const rodeo_id_excel = leerCampo(filaRaw, 'Rodeo ID');
    const fecha_rodeo_raw = leerCampo(filaRaw, 'Fecha rodeo');
    const club = leerCampo(filaRaw, 'Club');
    const asociacion = leerCampo(filaRaw, 'Asociación');
    const jurado_oficial = leerCampo(filaRaw, 'Jurado Oficial');
    const clave_vinculacion = leerCampo(filaRaw, 'Clave de vinculación');
    const n_situaciones_raw = leerCampo(filaRaw, 'N° situaciones');
    const categorias_raw = leerCampo(filaRaw, 'Categorías');
    const resumen_breve = leerCampo(filaRaw, 'Resumen breve monitor');
    const texto_comentario = leerCampo(filaRaw, 'Texto comentario monitor');
    const ids_situaciones_raw = leerCampo(filaRaw, 'IDs situaciones');
    const estado_vinculacion = leerCampo(filaRaw, 'Estado vinculación');
    const importar_raw = leerCampo(filaRaw, 'Importar');

    if (version_formato !== VERSION_FORMATO_SOPORTADA) {
        errores.push(`Versión de formato no soportada: "${version_formato}" (se espera "${VERSION_FORMATO_SOPORTADA}").`);
    }

    const fecha_rodeo = fecha_rodeo_raw !== null ? parsearFechaCG(fecha_rodeo_raw) : null;
    if (!fecha_rodeo) errores.push('Fecha rodeo inválida o ausente.');
    if (!club) errores.push('Club ausente.');
    if (!asociacion) errores.push('Asociación ausente.');

    let n_situaciones = null;
    if (n_situaciones_raw === null || n_situaciones_raw === '') {
        errores.push('N° situaciones ausente.');
    } else {
        n_situaciones = Number(n_situaciones_raw);
        if (!Number.isInteger(n_situaciones) || n_situaciones < 0) {
            errores.push(`N° situaciones no es un entero válido: "${n_situaciones_raw}".`);
        }
    }

    const idsSituaciones = String(ids_situaciones_raw || '')
        .split(/[,;]+/)
        .map(s => s.trim())
        .filter(Boolean);

    const categorias = String(categorias_raw || '')
        .split(/[\n;]+/)
        .map(s => s.trim())
        .filter(Boolean);

    const importar = String(importar_raw || '').trim().toLowerCase() === 'sí' || String(importar_raw || '').trim().toLowerCase() === 'si';

    if (estado_vinculacion === null || estado_vinculacion === '') {
        errores.push('Estado vinculación ausente.');
    }

    // Punto 9 de la revisión: el texto que se guarda es el de "Texto
    // comentario monitor" TAL CUAL (GPT ya lo entrega pre-formateado, según
    // el Prompt Maestro) — nunca se reconstruye desde Club/Fecha/Categorías/
    // Resumen. Si viene vacío, es un error de esa fila (no se inventa un
    // formato de reemplazo).
    if (!texto_comentario) {
        errores.push('Texto comentario monitor ausente.');
    } else if (typeof texto_comentario !== 'string') {
        // sheet_to_json puede devolver un número/boolean si la celda no es
        // texto real (ej. Excel interpretó la celda como fecha/fórmula) —
        // nunca se acepta un valor no-textual para este campo (Punto 11).
        errores.push('Texto comentario monitor debe ser texto plano.');
    } else if (texto_comentario.length > LIMITE_TEXTO_COMENTARIO) {
        errores.push(`Texto comentario monitor excede el límite técnico de ${LIMITE_TEXTO_COMENTARIO} caracteres.`);
    }

    return {
        valores: {
            version_formato, rodeo_id_excel, fecha_rodeo, club, asociacion,
            jurado_oficial, clave_vinculacion, n_situaciones, categorias,
            resumen_breve, texto_comentario, idsSituaciones, estado_vinculacion,
            importar
        },
        errores
    };
}

// ─── PASO 3 (PURO) — Extrae una situación de "Situaciones detectadas" ────
// Lee las 20 columnas oficiales (vía ALIASES_SITUACION). fecha_rodeo/club/
// asociacion/jurado_oficial se leen para CRUCE (Punto 8) — nunca se guardan
// en la tabla SQL (son derivables por relación con `rodeos`, ver migración).
function extraerFilaSituacion(filaRaw) {
    const get = (campo) => leerCampoAlias(filaRaw, ALIASES_SITUACION[campo]);

    const incluirRaw = get('incluir_en_comentario');
    const incluirNorm = incluirRaw !== null ? String(incluirRaw).trim().toLowerCase() : null;
    const incluir_en_comentario = incluirNorm === null ? null
        : (incluirNorm === 'sí' || incluirNorm === 'si') ? true
        : (incluirNorm === 'no') ? false
        : null; // valor no reconocible -> null, se trata como ausente/error (ver validarSituacionObligatoria)

    return {
        id_situacion_excel: get('id_situacion_excel'),
        fecha_situacion: (() => { const v = get('fecha_situacion'); return v !== null ? parsearFechaCG(v) : null; })(),
        hora: get('hora'),
        fecha_rodeo: (() => { const v = get('fecha_rodeo'); return v !== null ? parsearFechaCG(v) : null; })(),
        club: get('club'),
        asociacion: get('asociacion'),
        jurado_chat: get('jurado_chat'),
        jurado_oficial: get('jurado_oficial'),
        area: get('area'),
        categoria_principal: get('categoria_principal'),
        subcategoria: get('subcategoria'),
        impacto: get('impacto'),
        descripcion_unificada: get('descripcion_unificada'),
        estado_resultado: get('estado_resultado'),
        incluir_en_comentario,
        vinculacion: get('vinculacion'),
        confianza: get('confianza'),
        lineas_chat: get('lineas_chat'),
        clave_vinculacion: get('clave_vinculacion'),
        evidencia_textual: get('evidencia_textual')
    };
}

// ─── Valida los campos INDISPENSABLES de una situación ya extraída ───────
// (Punto 3) — ninguno de estos se infiere ni se rellena con un valor por
// defecto; su ausencia rechaza la fila completa que la referencia.
function validarSituacionObligatoria(s) {
    const etiquetas = {
        id_situacion_excel: 'ID Situación', fecha_situacion: 'Fecha situación', area: 'Área',
        categoria_principal: 'Categoría principal', impacto: 'Impacto',
        descripcion_unificada: 'Descripción unificada', estado_resultado: 'Estado / resultado',
        incluir_en_comentario: 'Incluir en comentario (debe ser Sí/No)', vinculacion: 'Vinculación',
        clave_vinculacion: 'Clave de vinculación', evidencia_textual: 'Evidencia textual'
    };
    return CAMPOS_SITUACION_OBLIGATORIOS
        .filter(campo => s[campo] === null || s[campo] === '')
        .map(campo => `${etiquetas[campo]} ausente.`);
}

// ─── PASO 4 (PURO) — Cruza los IDs declarados en una fila de "Importación
// sistema" contra las situaciones realmente presentes en "Situaciones
// detectadas" ────────────────────────────────────────────────────────────
// Reglas (todas obligatorias, cualquier incumplimiento = rodeo NO importable):
//   - todos los IDs declarados deben existir en la hoja de situaciones;
//   - sin IDs duplicados dentro de la misma fila;
//   - cada situación referenciada debe tener sus campos obligatorios (Punto 3);
//   - cada situación referenciada debe estar Vinculación="Vinculado al
//     reporte" (Punto 5) — "Pendiente de vincular" rechaza la fila aunque
//     aparezca accidentalmente en IDs situaciones;
//   - todas deben compartir la misma clave_vinculacion que la fila padre
//     (cuando la fila padre trae una clave — si no trae, no se exige);
//   - si la situación trae su propio Club/Asociación/Fecha rodeo/Jurado
//     oficial, deben coincidir con los de su fila (Punto 8 — consistencia
//     INTERNA entre las dos hojas del mismo Excel; la coincidencia contra el
//     rodeo REAL de la base de datos la valida matchearRodeo() después);
//   - la cantidad encontrada debe coincidir EXACTAMENTE con N° situaciones
//     (N° situaciones = total de situaciones del rodeo, NO el subconjunto
//     con Incluir en comentario="Sí" — Punto 10).
// @returns { situaciones: [...extraídas], errores: [] }
function cruzarSituacionesConFila(filaImportacion, todasLasSituacionesRaw) {
    const errores = [];
    const { idsSituaciones, n_situaciones, clave_vinculacion, club: clubFila, asociacion: asociacionFila, fecha_rodeo: fechaRodeoFila, jurado_oficial: juradoFila } = filaImportacion;

    const idsUnicos = new Set(idsSituaciones);
    if (idsUnicos.size !== idsSituaciones.length) {
        errores.push('IDs situaciones duplicados dentro de la misma fila.');
    }

    const situacionesExtraidas = todasLasSituacionesRaw.map(extraerFilaSituacion);
    const porId = new Map(situacionesExtraidas.map(s => [s.id_situacion_excel, s]));

    const encontradas = [];
    for (const id of idsUnicos) {
        const s = porId.get(id);
        if (!s) {
            errores.push(`ID de situación "${id}" declarado pero no encontrado en "${HOJA_SITUACIONES}".`);
            continue;
        }

        const erroresCampos = validarSituacionObligatoria(s);
        if (erroresCampos.length > 0) {
            errores.push(`La situación "${id}" tiene campos obligatorios inválidos: ${erroresCampos.join(' ')}`);
            continue;
        }

        if (!ESTADOS_VINCULACION_IMPORTABLES.includes(s.vinculacion)) {
            errores.push(`La situación "${id}" no está "Vinculado al reporte" (Vinculación: "${s.vinculacion}") — no se importa.`);
            continue;
        }

        if (clave_vinculacion && s.clave_vinculacion !== clave_vinculacion) {
            errores.push(`La situación "${id}" tiene una clave de vinculación distinta a la de su rodeo.`);
            continue;
        }

        if (s.club && clubFila && normalizar(s.club) !== normalizar(clubFila)) {
            errores.push(`La situación "${id}" indica un Club distinto al de su fila en "${HOJA_IMPORTACION}".`);
            continue;
        }
        if (s.asociacion && asociacionFila && normalizar(s.asociacion) !== normalizar(asociacionFila)) {
            errores.push(`La situación "${id}" indica una Asociación distinta a la de su fila en "${HOJA_IMPORTACION}".`);
            continue;
        }
        if (s.fecha_rodeo && fechaRodeoFila && s.fecha_rodeo !== fechaRodeoFila) {
            errores.push(`La situación "${id}" indica una Fecha rodeo distinta a la de su fila en "${HOJA_IMPORTACION}".`);
            continue;
        }
        if (s.jurado_oficial && juradoFila && normalizar(s.jurado_oficial) !== normalizar(juradoFila)) {
            errores.push(`La situación "${id}" indica un Jurado oficial distinto al de su fila en "${HOJA_IMPORTACION}".`);
            continue;
        }

        encontradas.push(s);
    }

    if (n_situaciones !== null && encontradas.length === idsUnicos.size && encontradas.length !== n_situaciones) {
        errores.push(`N° situaciones (${n_situaciones}) no coincide con la cantidad de IDs válidos encontrados (${encontradas.length}).`);
    }

    return { situaciones: errores.length === 0 ? encontradas : [], errores };
}

// ─── Fingerprint — SIEMPRE calculada en backend, nunca recibida ──────────
// Estable ante una renumeración de SIT-XXX: usa rodeo_id + fecha + hora +
// categoría/descripción NORMALIZADAS (mismo normalizar() del resto del
// proyecto: sin tildes, minúsculas, espacios colapsados) — dos exportes del
// mismo hecho real producen el mismo hash aunque GPT lo haya numerado
// distinto o redactado con mayúsculas/espacios diferentes.
// DISEÑO (revisión post-implementación): la primera versión usaba
// categoria_principal + descripcion_unificada — ambos redactados por GPT en
// cada corrida, así que reprocesar el MISMO chat puede parafrasear la
// descripción de forma distinta y romper la deduplicación sin que el hecho
// real haya cambiado. Se prioriza en su lugar lo que viene MÁS CERCA del
// dato crudo del chat (cambia poco o nada entre corridas):
//   1) evidencia_textual (cita/extracto literal del chat) — preferida;
//   2) si viene vacía, lineas_chat (transcript crudo) — también literal;
//   3) SOLO si ambas vienen vacías, un núcleo de respaldo con categoría +
//      subcategoría + jurado + descripción — más débil ante parafraseo,
//      pero es el único dato disponible en ese caso. Documentado como
//      limitación conocida (ver README del servicio / informe de la tarea).
// id_situacion_excel NUNCA participa (por diseño desde la v1).
function calcularFingerprint({ rodeo_id, fecha_situacion, hora, categoria_principal, subcategoria, jurado_chat, evidencia_textual, lineas_chat, descripcion_unificada }) {
    const evidenciaNorm = normalizar(evidencia_textual || '');
    const chatNorm = normalizar(lineas_chat || '');

    let nucleo;
    if (evidenciaNorm) {
        nucleo = 'ev:' + evidenciaNorm;
    } else if (chatNorm) {
        nucleo = 'chat:' + chatNorm;
    } else {
        // Respaldo — solo cuando no hay NINGÚN dato crudo del chat disponible.
        nucleo = 'resumen:' + [
            normalizar(categoria_principal || ''),
            normalizar(subcategoria || ''),
            normalizar(jurado_chat || ''),
            normalizar(descripcion_unificada || '')
        ].join('|');
    }

    const base = [rodeo_id || '', fecha_situacion || '', normalizar(hora || ''), nucleo].join('|');
    return crypto.createHash('sha256').update(base, 'utf8').digest('hex');
}

// Utilidad de formato de fecha (DD/MM/YYYY) — usada por la previsualización.
// NO se usa para construir el comentario compacto: ese texto se toma TAL
// CUAL de "Texto comentario monitor" (ver Punto 9 de la revisión) — GPT lo
// entrega ya formateado, el backend nunca lo reconstruye.
function formatearFechaCL(fechaISO) {
    if (!fechaISO) return '';
    const [y, m, d] = fechaISO.split('-');
    return `${d}/${m}/${y}`;
}

// ═════════════════════════════════════════════════════════════════════════
// A PARTIR DE AQUÍ: funciones que SÍ acceden a datos reales (supabase).
// ═════════════════════════════════════════════════════════════════════════

// ─── Matching de rodeo — Prioridad 1: Rodeo ID; Prioridad 2 (fallback,
// solo si no hay Rodeo ID): Fecha + Asociación + Club + Jurado, únicamente
// si hay UNA coincidencia inequívoca ────────────────────────────────────
// @returns { estado: 'ok'|'advertencia'|'error', motivo, rodeo|null }
async function matchearRodeo({ rodeoIdExcel, fecha, club, asociacion, juradoOficial }) {
    if (rodeoIdExcel) {
        const { data: rodeo, error } = await supabase
            .from('rodeos')
            .select('id, club, asociacion, fecha, estado')
            .eq('id', rodeoIdExcel)
            .maybeSingle();

        if (error) return { estado: 'error', motivo: 'Error consultando el Rodeo ID: ' + error.message, rodeo: null };
        if (!rodeo) return { estado: 'error', motivo: MOTIVO_RODEO_ID_INEXISTENTE, rodeo: null };
        if (rodeo.estado !== 'activo') return { estado: 'error', motivo: 'El rodeo referenciado está anulado.', rodeo: null };

        const coincide = rodeo.fecha === fecha
            && normalizar(rodeo.club) === normalizar(club)
            && normalizar(rodeo.asociacion) === normalizar(asociacion);

        if (!coincide) {
            // Sección 3 del pedido: "mostrar advertencia y NO cargar
            // automáticamente hasta revisión" — en esta versión eso
            // significa que NO se escribe nada para esta fila aunque el
            // usuario elija Agregar/Reemplazar (no existe todavía una
            // acción de "forzar" en la UI); debe corregirse en el Excel de
            // origen y reimportarse.
            return { estado: 'advertencia', motivo: 'El Rodeo ID existe pero Fecha/Club/Asociación no coinciden exactamente con el Excel.', rodeo };
        }
        return { estado: 'ok', motivo: null, rodeo };
    }

    // Fallback SOLO para archivos antiguos sin Rodeo ID.
    const { data: candidatosFecha, error } = await supabase
        .from('rodeos')
        .select('id, club, asociacion, fecha, estado, asignaciones(tipo_persona, estado, nombre_importado, usuarios_pagados(nombre_completo))')
        .eq('fecha', fecha)
        .eq('estado', 'activo');

    if (error) return { estado: 'error', motivo: 'Error en la búsqueda de respaldo: ' + error.message, rodeo: null };

    const coincidencias = (candidatosFecha || []).filter(r => {
        const mismoClub = normalizar(r.club) === normalizar(club);
        const mismaAsociacion = normalizar(r.asociacion) === normalizar(asociacion);
        if (!mismoClub || !mismaAsociacion) return false;
        if (!juradoOficial) return true;
        return (r.asignaciones || []).some(a =>
            a.tipo_persona === 'jurado' && a.estado !== 'anulado' &&
            normalizar(a.usuarios_pagados?.nombre_completo || a.nombre_importado || '') === normalizar(juradoOficial)
        );
    });

    if (coincidencias.length === 0) {
        return { estado: 'error', motivo: 'Sin Rodeo ID: no se encontró ninguna coincidencia por Fecha + Asociación + Club + Jurado.', rodeo: null };
    }
    if (coincidencias.length > 1) {
        return { estado: 'error', motivo: `Sin Rodeo ID: se encontraron ${coincidencias.length} coincidencias por Fecha + Asociación + Club + Jurado — ambiguo, no se elige arbitrariamente.`, rodeo: null };
    }
    return { estado: 'ok', motivo: null, rodeo: coincidencias[0] };
}

// ─── Comentario actual del rodeo (para mostrarlo en la previsualización y
// decidir el merge) ───────────────────────────────────────────────────────
// @returns { comentario_actual, ultimo_bloque_cg } — ultimo_bloque_cg es el
// último bloque compacto que ESTA importación (o una anterior) escribió vía
// Control de Gestión (columna nueva, migración 056) — null si nunca se
// aplicó CG sobre este rodeo o si el guardado manual no la trae (siempre
// null en ese caso, esa columna es exclusiva de esta RPC).
async function obtenerComentarioActual(rodeoId) {
    const { data } = await supabase
        .from('datos_monitor_rodeo')
        .select('comentario_monitor, control_gestion_ultimo_bloque')
        .eq('rodeo_id', rodeoId)
        .maybeSingle();
    return {
        comentario_actual: data?.comentario_monitor || null,
        ultimo_bloque_cg: data?.control_gestion_ultimo_bloque || null
    };
}

// ─── Merge de comentario según la acción elegida por el usuario ──────────
// "Reemplazar": el nuevo bloque reemplaza por completo — decisión explícita
// del administrador, nunca condicionada.
// "Omitir": no se toca — retorna null (la RPC interpreta null como "no
// escribir comentario para este rodeo").
// "Agregar", en orden de prioridad:
//   1) el bloque nuevo ya está contenido exactamente en el actual -> sin
//      cambios (reimportación idéntica, evita duplicar literalmente).
//   2) el actual contiene el ÚLTIMO bloque que CG escribió antes
//      (ultimoBloqueControlGestion) -> se REEMPLAZA ese bloque puntual por
//      el nuevo consolidado, preservando intacto cualquier texto manual
//      alrededor (caso "A+B -> A+B+C": evita ir acumulando un bloque de CG
//      encima de otro sobre los mismos hechos).
//   3) ninguna de las anteriores (primera importación, o el administrador
//      editó/borró el bloque de CG a mano) -> agrega al final, separado.
function construirComentarioFinal({ accion, comentarioActual, comentarioNuevo, ultimoBloqueControlGestion }) {
    if (accion === 'omitir') return null;
    if (accion === 'reemplazar' || !comentarioActual) return comentarioNuevo;
    if (comentarioActual.includes(comentarioNuevo)) return comentarioActual;
    if (ultimoBloqueControlGestion && comentarioActual.includes(ultimoBloqueControlGestion)) {
        return comentarioActual.replace(ultimoBloqueControlGestion, comentarioNuevo);
    }
    return comentarioActual + '\n\n---\n\n' + comentarioNuevo;
}

// ─── Construye, para UNA fila válida en forma, su plan de importación
// (matching + comentario nuevo + situaciones con fingerprint) ────────────
// Reutilizado IDÉNTICO por preview y por confirmar — así ambos calculan
// EXACTAMENTE lo mismo a partir del mismo Excel, sin dos lógicas paralelas.
async function construirPlanFila(filaRaw, filasSituacionesRaw) {
    const { valores, errores: erroresForma } = extraerFilaImportacion(filaRaw);

    if (!valores.importar || !ESTADOS_VINCULACION_IMPORTABLES.includes(valores.estado_vinculacion)) {
        return { valores, estado: 'omitida_por_filtro', errores: [], matching: null, situaciones: [], comentarioNuevo: null };
    }
    if (erroresForma.length > 0) {
        return { valores, estado: 'error', errores: erroresForma, matching: null, situaciones: [], comentarioNuevo: null };
    }

    const { situaciones, errores: erroresCruce } = cruzarSituacionesConFila(valores, filasSituacionesRaw);
    if (erroresCruce.length > 0) {
        return { valores, estado: 'error', errores: erroresCruce, matching: null, situaciones: [], comentarioNuevo: null };
    }

    const matching = await matchearRodeo({
        rodeoIdExcel: valores.rodeo_id_excel, fecha: valores.fecha_rodeo,
        club: valores.club, asociacion: valores.asociacion, juradoOficial: valores.jurado_oficial
    });

    if (matching.estado !== 'ok') {
        return { valores, estado: matching.estado, errores: [matching.motivo], matching, situaciones: [], comentarioNuevo: null };
    }

    // Punto 9 de la revisión: se usa "Texto comentario monitor" TAL CUAL
    // viene en el Excel (ya validado no-vacío en extraerFilaImportacion) —
    // nunca se reconstruye un formato distinto. Club/Fecha/Categorías/
    // Resumen se siguen extrayendo y validando (matching, previsualización,
    // cruce de N° situaciones) pero YA NO se usan para componer este texto.
    const comentarioNuevo = valores.texto_comentario;

    const situacionesConFingerprint = situaciones.map(s => ({
        ...s,
        version_formato: valores.version_formato,
        fingerprint: calcularFingerprint({
            rodeo_id: matching.rodeo.id, fecha_situacion: s.fecha_situacion, hora: s.hora,
            categoria_principal: s.categoria_principal, subcategoria: s.subcategoria,
            jurado_chat: s.jurado_chat, evidencia_textual: s.evidencia_textual,
            lineas_chat: s.lineas_chat, descripcion_unificada: s.descripcion_unificada
        })
    }));

    return { valores, estado: 'ok', errores: [], matching, situaciones: situacionesConFingerprint, comentarioNuevo };
}

// ═════════════════════════════════════════════════════════════════════════
// Resultados de la Serie de Campeones — vinculación EXCLUSIVA por Rodeo ID.
// Independiente del flujo de comentario/situaciones: una fila con
// Importar="No" o con errores en sus situaciones puede igualmente traer
// resultados válidos; el flujo existente no cambia en nada.
// ═════════════════════════════════════════════════════════════════════════
async function obtenerPuntajesActuales(rodeoId) {
    const { data, error } = await supabase
        .from('datos_monitor_rodeo')
        .select('puntaje_oficial_1er, puntaje_oficial_2do, puntaje_oficial_3er')
        .eq('rodeo_id', rodeoId)
        .maybeSingle();
    if (error) throw new Error('No se pudieron leer los puntajes actuales del rodeo: ' + error.message);
    return [data?.puntaje_oficial_1er ?? null, data?.puntaje_oficial_2do ?? null, data?.puntaje_oficial_3er ?? null];
}

// estado: 'sin_columnas' | 'sin_resultados' | 'error' | 'advertencia' |
//         'sin_rodeo_id' | 'rodeo_no_encontrado' | 'duplicada' |
//         'listo' | 'conflicto' | 'sin_cambios'
// Solo 'listo' / 'conflicto' / 'sin_cambios' son aplicables.
const ESTADOS_RESULTADOS_APLICABLES = ['listo', 'conflicto', 'sin_cambios'];

async function construirPlanResultadosSerie(filasImportacion, resultadosSerie) {
    const planes = filasImportacion.map((filaRaw, i) => {
        const r = resultadosSerie[i];
        const rodeoIdCrudo = leerCampo(filaRaw, 'Rodeo ID');
        return {
            fila_index: i,
            columnas_presentes: r.columnas_presentes,
            valores: r.valores,
            rodeo_id_excel: rodeoIdCrudo === null ? null : String(rodeoIdCrudo).trim(),
            rodeo_id: null,
            lugares: compararResultadosSerie(r.valores, null).map(l => ({ ...l, comparacion: l.excel === null ? 'no_informado' : 'pendiente' })),
            errores: [...r.errores],
            estado: !r.columnas_presentes ? 'sin_columnas'
                : r.errores.length > 0 ? 'error'
                : r.valores.every(v => v === null) ? 'sin_resultados'
                : null
        };
    });

    // Rodeo ID repetido entre filas que traen resultados: si los valores son
    // idénticos se aplica una sola vez; si difieren no se aplica ninguno
    // (nunca se elige arbitrariamente cuál vale).
    const grupos = new Map();
    for (const p of planes) {
        if (p.estado !== null || !p.rodeo_id_excel) continue;
        const clave = p.rodeo_id_excel.toLowerCase();
        if (!grupos.has(clave)) grupos.set(clave, []);
        grupos.get(clave).push(p);
    }
    for (const grupo of grupos.values()) {
        if (grupo.length < 2) continue;
        const filasTxt = grupo.map(p => p.fila_index + 1).join(', '); // misma numeración que la previsualización
        const mismos = grupo.every(p => p.valores.every((v, k) => v === grupo[0].valores[k]));
        grupo.forEach((p, k) => {
            if (!mismos) {
                p.estado = 'error';
                p.errores.push(`El mismo Rodeo ID aparece en las filas ${filasTxt} con resultados distintos — no se importa ninguno.`);
            } else if (k > 0) {
                p.estado = 'duplicada';
                p.errores.push(`Resultados idénticos a la fila ${grupo[0].fila_index + 1} (mismo Rodeo ID) — se aplican una sola vez.`);
            }
        });
    }

    for (const p of planes) {
        if (p.estado !== null) continue;
        const filaRaw = filasImportacion[p.fila_index];
        try {
            const version = leerCampo(filaRaw, 'Versión formato');
            if (version !== VERSION_FORMATO_SOPORTADA) {
                p.estado = 'error';
                p.errores.push(`Versión de formato no soportada: "${version}" (se espera "${VERSION_FORMATO_SOPORTADA}").`);
                continue;
            }
            if (!p.rodeo_id_excel) {
                p.estado = 'sin_rodeo_id';
                p.errores.push('Sin Rodeo ID: los resultados solo se vinculan por Rodeo ID (no por Club, Asociación ni Jurado).');
                continue;
            }
            if (!UUID_RE.test(p.rodeo_id_excel)) {
                p.estado = 'rodeo_no_encontrado';
                p.errores.push(`Rodeo ID "${p.rodeo_id_excel.slice(0, 60)}" no existe en el sistema (formato inválido).`);
                continue;
            }
            const fechaRaw = leerCampo(filaRaw, 'Fecha rodeo');
            const matching = await matchearRodeo({
                rodeoIdExcel: p.rodeo_id_excel,
                fecha: fechaRaw !== null ? parsearFechaCG(fechaRaw) : null,
                club: leerCampo(filaRaw, 'Club'),
                asociacion: leerCampo(filaRaw, 'Asociación'),
                juradoOficial: leerCampo(filaRaw, 'Jurado Oficial')
            });
            if (matching.estado === 'error') {
                p.estado = matching.motivo === MOTIVO_RODEO_ID_INEXISTENTE ? 'rodeo_no_encontrado' : 'error';
                p.errores.push(matching.motivo);
                continue;
            }
            if (matching.estado === 'advertencia') {
                p.estado = 'advertencia';
                p.errores.push(matching.motivo + ' Los resultados no se cargan hasta corregir el Excel.');
                continue;
            }
            p.rodeo_id = matching.rodeo.id;
            p.lugares = compararResultadosSerie(p.valores, await obtenerPuntajesActuales(p.rodeo_id));
            const comps = p.lugares.map(l => l.comparacion);
            p.estado = comps.includes('conflicto') ? 'conflicto' : comps.includes('nuevo') ? 'listo' : 'sin_cambios';
        } catch (err) {
            p.estado = 'error';
            p.errores.push(err.message);
        }
    }
    return planes;
}

// Resumen de previsualización de resultados (sin escribir nada).
function resumirPlanesResultados(planes, columnasPresentes) {
    const cuenta = (e) => planes.filter(p => p.estado === e).length;
    return {
        columnas_presentes: columnasPresentes,
        filas_con_resultados: planes.filter(p => p.valores.some(v => v !== null)).length,
        listos: cuenta('listo'),
        conflictos: cuenta('conflicto'),
        sin_cambios: cuenta('sin_cambios'),
        sin_resultados: cuenta('sin_resultados'),
        rodeo_id_no_encontrados: cuenta('rodeo_no_encontrado'),
        sin_rodeo_id: cuenta('sin_rodeo_id'),
        con_error: cuenta('error') + cuenta('advertencia'),
        duplicadas: cuenta('duplicada')
    };
}

const MENSAJES_ERROR_RPC_RESULTADOS = {
    RODEO_NO_ENCONTRADO: 'Rodeo ID no existe en el sistema.',
    RODEO_ANULADO: 'El rodeo referenciado está anulado.',
    ESPERADOS_REQUERIDOS: 'Para reemplazar se requieren los valores vistos en la previsualización.',
    SIN_RESULTADOS: 'La fila no trae resultados.'
};
function mensajeErrorRpcResultados(error) {
    if (error?.code === 'PGRST202') return 'La migración 101 (resultados Serie de Campeones) aún no está aplicada en la base de datos.';
    const codigo = String(error?.message || '').split(':')[0].trim();
    return MENSAJES_ERROR_RPC_RESULTADOS[codigo] || ('No se pudieron guardar los resultados: ' + (error?.message || 'error desconocido'));
}

// Aplica los resultados de cada fila aplicable según la decisión del
// administrador: 'completar' (solo lugares vacíos; conflictos se conservan),
// 'reemplazar' (además reemplaza conflictos SOLO si el valor vigente sigue
// siendo el que se vio en la previsualización) u 'omitir'. Sin decisión
// explícita = omitir (seguro por defecto, igual que el flujo de comentario).
async function aplicarResultadosSerie(planes, decisionesPorIndex, columnasPresentes, importacionId, actorId) {
    const r = {
        columnas_presentes: columnasPresentes,
        rodeos_procesados: 0, importados_1: 0, importados_2: 0, importados_3: 0,
        reemplazados: 0, iguales: 0, rodeos_sin_resultados: 0,
        conflictos: 0, conflictos_conservados: 0,
        rodeo_id_no_encontrados: 0, sin_rodeo_id: 0, con_error: 0, omitidos_por_usuario: 0,
        detalle: []
    };
    for (const p of planes) {
        const base = { fila_index: p.fila_index, rodeo_id: p.rodeo_id, rodeo_id_excel: p.rodeo_id_excel };
        if (p.estado === 'sin_columnas') continue;
        if (p.estado === 'sin_resultados') { r.rodeos_sin_resultados++; continue; }
        if (p.estado === 'duplicada') { r.detalle.push({ ...base, resultado: 'duplicada', errores: p.errores }); continue; }
        if (p.estado === 'rodeo_no_encontrado') { r.rodeo_id_no_encontrados++; r.detalle.push({ ...base, resultado: 'rodeo_no_encontrado', errores: p.errores }); continue; }
        if (p.estado === 'sin_rodeo_id') { r.sin_rodeo_id++; r.detalle.push({ ...base, resultado: 'sin_rodeo_id', errores: p.errores }); continue; }
        if (!ESTADOS_RESULTADOS_APLICABLES.includes(p.estado)) { r.con_error++; r.detalle.push({ ...base, resultado: 'error', errores: p.errores }); continue; }

        if (p.estado === 'conflicto') r.conflictos++;
        const decision = decisionesPorIndex.get(p.fila_index);
        const accion = decision?.accion_resultados || 'omitir';
        if (accion === 'omitir') {
            r.omitidos_por_usuario++;
            r.detalle.push({ ...base, resultado: 'omitida_por_usuario', lugares: p.lugares });
            continue;
        }
        const reemplazar = accion === 'reemplazar';
        const { data, error } = await supabase.rpc('aplicar_resultados_serie_campeones_rodeo', {
            p_rodeo_id: p.rodeo_id,
            p_puntajes: p.valores,
            p_reemplazar: reemplazar,
            p_esperados: reemplazar ? decision.resultados_actuales_vistos : null,
            p_importacion_id: importacionId,
            p_actor_id: actorId
        });
        if (error) {
            const msg = mensajeErrorRpcResultados(error);
            if (String(error.message || '').startsWith('RODEO_NO_ENCONTRADO')) r.rodeo_id_no_encontrados++;
            else r.con_error++;
            r.detalle.push({ ...base, resultado: 'error', errores: [msg] });
            continue;
        }
        r.rodeos_procesados++;
        const lugares = data?.lugares || [];
        let huboConflictoNuevo = false;
        for (const l of lugares) {
            if (l.estado === 'importado' || l.estado === 'reemplazado') r[`importados_${l.lugar}`]++;
            if (l.estado === 'reemplazado') r.reemplazados++;
            if (l.estado === 'igual') r.iguales++;
            if (l.estado === 'conflicto_conservado' || l.estado === 'conflicto_cambio_concurrente') r.conflictos_conservados++;
            if (l.estado === 'conflicto_cambio_concurrente' && p.estado !== 'conflicto') huboConflictoNuevo = true;
        }
        if (huboConflictoNuevo) r.conflictos++;
        r.detalle.push({ ...base, resultado: data?.cambio ? 'importado' : 'sin_cambios', lugares });
    }
    return r;
}

// ─── PREVIEW — NO escribe nada. Devuelve una fila de previsualización por
// cada fila de "Importación sistema" (incluidas las omitidas por filtro,
// para que el usuario vea el conteo completo) ────────────────────────────
async function generarPreview(buffer) {
    const { filasImportacion, filasSituaciones, columnasResultados, resultadosSerie } = parsearWorkbook(buffer);
    // Sin columnas de resultados: cero consultas adicionales (CG-1.0 intacto).
    const planesResultados = await construirPlanResultadosSerie(filasImportacion, resultadosSerie);

    const filas = [];
    for (let i = 0; i < filasImportacion.length; i++) {
        const plan = await construirPlanFila(filasImportacion[i], filasSituaciones);
        const { comentario_actual: comentarioActual } = plan.matching?.rodeo
            ? await obtenerComentarioActual(plan.matching.rodeo.id)
            : { comentario_actual: null };

        filas.push({
            fila_index: i,
            fecha: plan.valores.fecha_rodeo,
            club: plan.valores.club,
            asociacion: plan.valores.asociacion,
            jurado: plan.valores.jurado_oficial,
            rodeo_id_excel: plan.valores.rodeo_id_excel,
            rodeo_id_resuelto: plan.matching?.rodeo?.id || null,
            n_situaciones: plan.valores.n_situaciones,
            categorias: plan.valores.categorias,
            resumen_breve: plan.valores.resumen_breve,
            comentario_actual: comentarioActual,
            comentario_nuevo: plan.comentarioNuevo,
            estado: plan.estado, // 'ok' | 'advertencia' | 'error' | 'omitida_por_filtro'
            errores: plan.errores,
            accion_sugerida: plan.estado === 'ok' ? (comentarioActual ? 'agregar' : 'reemplazar') : 'omitir',
            resultados_serie: (() => {
                const p = planesResultados[i];
                return {
                    estado: p.estado,
                    columnas_presentes: p.columnas_presentes,
                    rodeo_id: p.rodeo_id,
                    lugares: p.lugares,
                    errores: p.errores,
                    // Por defecto NUNCA se reemplaza: 'completar' solo llena lugares vacíos.
                    accion_sugerida: ESTADOS_RESULTADOS_APLICABLES.includes(p.estado) ? 'completar' : 'omitir'
                };
            })()
        });
    }

    const resumen = {
        total_filas: filas.length,
        importables: filas.filter(f => f.estado === 'ok').length,
        omitidas_por_filtro: filas.filter(f => f.estado === 'omitida_por_filtro').length,
        con_advertencia: filas.filter(f => f.estado === 'advertencia').length,
        con_error: filas.filter(f => f.estado === 'error').length,
        resultados_serie: resumirPlanesResultados(planesResultados, columnasResultados.presentes)
    };

    return { filas, resumen };
}

// ─── CONFIRMAR — re-parsea el MISMO archivo desde cero (nunca confía en lo
// que el frontend devuelve salvo la decisión de acción por fila_index),
// revalida todo de nuevo, y aplica cada rodeo como unidad atómica vía la
// RPC confirmar_control_gestion_rodeo() ─────────────────────────────────
// @param decisiones [{ fila_index, accion: 'agregar'|'reemplazar'|'omitir' }]
async function confirmarImportacion(buffer, decisiones, nombreArchivo, actorId) {
    const { filasImportacion, filasSituaciones, columnasResultados, resultadosSerie } = parsearWorkbook(buffer);
    const decisionPorIndex = new Map((decisiones || []).map(d => [d.fila_index, d.accion]));
    const decisionResultadosPorIndex = new Map((decisiones || []).map(d => [d.fila_index, d]));

    const resultado = { procesados: 0, exitosos: 0, omitidos: 0, duplicados: 0, errores: 0, detalle: [] };
    let totalSituacionesInsertadas = 0;
    let totalSituacionesDuplicadas = 0;

    // registro de trazabilidad primero (se actualizan los contadores al final)
    const { data: importacion, error: errImportacion } = await supabase
        .from('importaciones')
        .insert({ nombre_archivo: nombreArchivo, tipo: 'control_gestion', total_filas: filasImportacion.length, created_by: actorId })
        .select()
        .single();
    if (errImportacion) throw new Error('No se pudo registrar la importación: ' + errImportacion.message);

    for (let i = 0; i < filasImportacion.length; i++) {
        resultado.procesados++;
        const accion = decisionPorIndex.get(i) || 'omitir'; // sin decisión explícita = no se toca (seguro por defecto)
        const plan = await construirPlanFila(filasImportacion[i], filasSituaciones);

        if (plan.estado === 'omitida_por_filtro') {
            resultado.omitidos++;
            resultado.detalle.push({ fila_index: i, resultado: 'omitida_por_filtro' });
            continue;
        }
        if (plan.estado !== 'ok') {
            resultado.errores++;
            resultado.detalle.push({ fila_index: i, resultado: 'error', errores: plan.errores });
            continue;
        }
        if (accion === 'omitir') {
            resultado.omitidos++;
            resultado.detalle.push({ fila_index: i, resultado: 'omitida_por_usuario' });
            continue;
        }

        const { comentario_actual: comentarioActual, ultimo_bloque_cg: ultimoBloqueCG } = await obtenerComentarioActual(plan.matching.rodeo.id);
        const comentarioFinal = construirComentarioFinal({
            accion, comentarioActual, comentarioNuevo: plan.comentarioNuevo, ultimoBloqueControlGestion: ultimoBloqueCG
        });

        const { data: rpcData, error: errRpc } = await supabase.rpc('confirmar_control_gestion_rodeo', {
            p_rodeo_id: plan.matching.rodeo.id,
            p_comentario_final: comentarioFinal,
            p_bloque_cg: plan.comentarioNuevo,
            p_es_agregar: accion === 'agregar',
            p_situaciones: plan.situaciones,
            p_importacion_id: importacion.id,
            p_actor_id: actorId
        });

        if (errRpc) {
            resultado.errores++;
            resultado.detalle.push({ fila_index: i, resultado: 'error', errores: [errRpc.message] });
            continue;
        }

        resultado.exitosos++;
        totalSituacionesInsertadas += rpcData.situaciones_insertadas || 0;
        totalSituacionesDuplicadas += rpcData.situaciones_duplicadas || 0;
        resultado.detalle.push({
            fila_index: i,
            // "sin_novedad" (punto 3 de la revisión): se pidió Agregar pero
            // TODAS las situaciones ya existían por fingerprint -> el
            // comentario NO se tocó. Nunca se cuenta como error.
            resultado: rpcData.sin_novedad ? 'sin_novedad' : 'importado',
            rodeo_id: plan.matching.rodeo.id,
            comentario_actualizado: rpcData.comentario_actualizado,
            situaciones_insertadas: rpcData.situaciones_insertadas, situaciones_duplicadas: rpcData.situaciones_duplicadas
        });
    }

    resultado.duplicados = totalSituacionesDuplicadas;

    // SEMÁNTICA DE `importaciones` PARA tipo='control_gestion' (Punto 7 de
    // la revisión — documentada aquí para evitar confusión futura, sin
    // cambiar el schema, que ya define estos contadores como genéricos):
    //   total_filas = filas de "Importación sistema" en el Excel.
    //   insertadas  = RODEOS exitosamente procesados por la RPC — incluye
    //                 los que resultaron "sin_novedad" (Agregar sin
    //                 situaciones nuevas: se procesaron bien, solo que no
    //                 había nada que escribir). Unidad: fila/rodeo, NO
    //                 situación — consistente con el resto de contadores
    //                 de esta tabla, que son siempre por-registro.
    //   duplicadas  = SITUACIONES omitidas por fingerprint ya existente
    //                 (unidad distinta a las demás: situación, no fila).
    //   rechazadas  = filas omitidas (por filtro Importar/Estado o por
    //                 decisión explícita del usuario = "omitir").
    //   errores     = filas con error de validación/matching o fallo de RPC.
    // El registro de `importaciones` se crea SIEMPRE al iniciar la
    // confirmación (antes del loop) y se actualiza UNA vez al final con los
    // contadores ya consolidados — nunca queda a medio actualizar: si el
    // proceso completo lanzara una excepción no capturada, la fila de
    // auditoría simplemente quedaría con los contadores en 0 (su valor
    // inicial), nunca con datos parciales o inconsistentes.
    await supabase
        .from('importaciones')
        .update({
            insertadas: resultado.exitosos,
            pendientes: 0,
            duplicadas: totalSituacionesDuplicadas,
            rechazadas: resultado.omitidos,
            errores: resultado.errores
        })
        .eq('id', importacion.id);

    // Resultados Serie de Campeones: se revalidan desde cero contra la base
    // (igual que el comentario) y se aplican rodeo por rodeo. Un fallo aquí
    // nunca deshace ni altera lo ya importado del comentario/situaciones.
    let resultadosSerieAplicados;
    try {
        const planesResultados = await construirPlanResultadosSerie(filasImportacion, resultadosSerie);
        resultadosSerieAplicados = await aplicarResultadosSerie(
            planesResultados, decisionResultadosPorIndex, columnasResultados.presentes, importacion.id, actorId);
    } catch (err) {
        resultadosSerieAplicados = { columnas_presentes: columnasResultados.presentes, error_general: err.message };
    }

    return {
        ...resultado, importacion_id: importacion.id, situaciones_insertadas: totalSituacionesInsertadas,
        resultados_serie: resultadosSerieAplicados
    };
}

// ─── Lectura de detalle para "Ver detalle" (GET, solo lectura) ──────────
async function obtenerSituacionesDeRodeo(rodeoId) {
    const { data, error } = await supabase
        .from('control_gestion_situaciones')
        .select(`
            id, id_situacion_excel, fecha_situacion, hora, area, categoria_principal,
            subcategoria, impacto, descripcion_unificada, estado_resultado,
            incluir_en_comentario, confianza, jurado_chat,
            lineas_chat, evidencia_textual, clave_vinculacion, version_formato, created_at
        `)
        .eq('rodeo_id', rodeoId)
        .order('fecha_situacion', { ascending: true })
        .order('hora', { ascending: true }); // orden secundario dentro del mismo día
    if (error) throw new Error(error.message);
    return data || [];
}

module.exports = {
    VERSION_FORMATO_SOPORTADA, HOJA_IMPORTACION, HOJA_SITUACIONES,
    ENCABEZADOS_IMPORTACION, ENCABEZADOS_SITUACIONES,
    ESTADOS_VINCULACION_IMPORTABLES,
    parsearWorkbook, extraerFilaImportacion, extraerFilaSituacion,
    cruzarSituacionesConFila, calcularFingerprint,
    formatearFechaCL, leerCampo, parsearFechaCG,
    matchearRodeo, obtenerComentarioActual, construirComentarioFinal,
    construirPlanFila, generarPreview, confirmarImportacion, obtenerSituacionesDeRodeo,
    // Resultados Serie de Campeones (columnas opcionales)
    COLUMNAS_RESULTADOS_SERIE, REGEX_PUNTAJE_SERIE,
    localizarColumnasResultados, validarPuntajeSerie, leerCeldaPuntajeSerie,
    extraerResultadosSerie, compararResultadosSerie,
    construirPlanResultadosSerie, aplicarResultadosSerie, mensajeErrorRpcResultados
};
