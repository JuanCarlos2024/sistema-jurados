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

    return { filasImportacion, filasSituaciones };
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
        if (!rodeo) return { estado: 'error', motivo: 'Rodeo ID no existe en el sistema.', rodeo: null };
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

// ─── PREVIEW — NO escribe nada. Devuelve una fila de previsualización por
// cada fila de "Importación sistema" (incluidas las omitidas por filtro,
// para que el usuario vea el conteo completo) ────────────────────────────
async function generarPreview(buffer) {
    const { filasImportacion, filasSituaciones } = parsearWorkbook(buffer);

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
            accion_sugerida: plan.estado === 'ok' ? (comentarioActual ? 'agregar' : 'reemplazar') : 'omitir'
        });
    }

    const resumen = {
        total_filas: filas.length,
        importables: filas.filter(f => f.estado === 'ok').length,
        omitidas_por_filtro: filas.filter(f => f.estado === 'omitida_por_filtro').length,
        con_advertencia: filas.filter(f => f.estado === 'advertencia').length,
        con_error: filas.filter(f => f.estado === 'error').length
    };

    return { filas, resumen };
}

// ─── CONFIRMAR — re-parsea el MISMO archivo desde cero (nunca confía en lo
// que el frontend devuelve salvo la decisión de acción por fila_index),
// revalida todo de nuevo, y aplica cada rodeo como unidad atómica vía la
// RPC confirmar_control_gestion_rodeo() ─────────────────────────────────
// @param decisiones [{ fila_index, accion: 'agregar'|'reemplazar'|'omitir' }]
async function confirmarImportacion(buffer, decisiones, nombreArchivo, actorId) {
    const { filasImportacion, filasSituaciones } = parsearWorkbook(buffer);
    const decisionPorIndex = new Map((decisiones || []).map(d => [d.fila_index, d.accion]));

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

    return { ...resultado, importacion_id: importacion.id, situaciones_insertadas: totalSituacionesInsertadas };
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
    construirPlanFila, generarPreview, confirmarImportacion, obtenerSituacionesDeRodeo
};
