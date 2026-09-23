// ═════════════════════════════════════════════════════════════════════════
// Tests de Importación de Control de Gestión.
//
// Dos capas:
//   1) Funciones PURAS (parsearWorkbook, extraerFilaImportacion,
//      cruzarSituacionesConFila, calcularFingerprint, construirComentario*)
//      — se prueban con buffers Excel REALES construidos en memoria con el
//      mismo paquete `xlsx` que usa el servicio (nunca mocks de Excel).
//   2) Funciones que acceden a datos reales (matchearRodeo, generarPreview,
//      confirmarImportacion, obtenerSituacionesDeRodeo) — `../config/
//      supabase` se mockea con el mismo patrón genérico por-tabla ya usado
//      en propuesta-designacion.orquestacion.test.js (jest.fn() + resolución
//      por tabla), sin supertest ni servidor HTTP real.
// ═════════════════════════════════════════════════════════════════════════
const XLSX = require('xlsx');

jest.mock('../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));
const supabase = require('../config/supabase');

const {
    VERSION_FORMATO_SOPORTADA,
    parsearWorkbook, extraerFilaImportacion, extraerFilaSituacion, cruzarSituacionesConFila,
    calcularFingerprint, construirComentarioFinal,
    matchearRodeo, generarPreview, confirmarImportacion, obtenerSituacionesDeRodeo
} = require('./controlGestion');

// ─── Helper: construye un buffer .xlsx real con las 2 hojas esperadas ────
function construirBuffer({ filasImportacion, filasSituaciones, nombreHoja1 = 'Importación sistema', nombreHoja2 = 'Situaciones detectadas' }) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filasImportacion), nombreHoja1);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filasSituaciones || []), nombreHoja2);
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const FILA_BASE = {
    'Versión formato': 'CG-1.0',
    'Rodeo ID': '',
    'Fecha rodeo': '18/09/2026',
    'Club': 'SAN CARLOS',
    'Asociación': 'ÑUBLE',
    'Jurado Oficial': 'JUAN PEREZ',
    'Clave de vinculación': 'CLV-1',
    'N° situaciones': 2,
    'Categorías': 'Servicios básicos / logística crítica\nAccidente de jinete',
    'Resumen breve monitor': '1.ª Libre suspendida por corte de energía y reanudada al día siguiente.',
    'Texto comentario monitor': 'Rodeo: SAN CARLOS - ÑUBLE; Fecha: 18/09/2026\nN° situaciones: 2\nCategorías:\n- Servicios básicos / logística crítica\n- Accidente de jinete\nComentario del monitor: 1.ª Libre suspendida por corte de energía y reanudada al día siguiente.',
    'IDs situaciones': 'SIT-001, SIT-002',
    'Estado vinculación': 'Vinculado al reporte',
    'Importar': 'Sí'
};

// Fixtures con las 20 columnas OFICIALES del Prompt Maestro V2 (Fase 2.1.1).
const SITUACION_1 = {
    'ID Situación': 'SIT-001', 'Fecha situación': '18/09/2026', 'Hora': '10:30',
    'Fecha rodeo': '18/09/2026', 'Club': 'SAN CARLOS', 'Asociación': 'ÑUBLE',
    'Jurado chat': 'Juan Perez', 'Jurado oficial': 'JUAN PEREZ',
    'Área': 'Servicios', 'Categoría principal': 'Servicios básicos / logística crítica', 'Subcategoría': 'Energía',
    'Impacto': 'Alto', 'Descripción unificada': 'Corte de energía en la 1.ª Libre.',
    'Estado / resultado': 'Reanudado al día siguiente',
    'Incluir en comentario': 'Sí', 'Vinculación': 'Vinculado al reporte', 'Confianza': 'Alta',
    'Líneas chat': '[10:30] Juan: se corto la luz', 'Clave de vinculación': 'CLV-1',
    'Evidencia textual': '[10:30] Juan: se corto la luz en la primera libre'
};
const SITUACION_2 = {
    'ID Situación': 'SIT-002', 'Fecha situación': '18/09/2026', 'Hora': '15:00',
    'Fecha rodeo': '18/09/2026', 'Club': 'SAN CARLOS', 'Asociación': 'ÑUBLE',
    'Jurado chat': 'Juan Perez', 'Jurado oficial': 'JUAN PEREZ',
    'Área': 'Seguridad', 'Categoría principal': 'Accidente de jinete', 'Subcategoría': 'Caída',
    'Impacto': 'Alto', 'Descripción unificada': 'Caída de Alfonso Placencia con traslado al hospital.',
    'Estado / resultado': 'Rodeo se reanudó',
    'Incluir en comentario': 'Sí', 'Vinculación': 'Vinculado al reporte', 'Confianza': 'Media',
    'Líneas chat': '[15:00] Juan: cayo el jinete', 'Clave de vinculación': 'CLV-1',
    'Evidencia textual': '[15:00] Juan: cayo el jinete, se traslada al hospital'
};

function mockSupabaseGenerico(porTabla) {
    const llamadas = {};
    const consumir = (tabla) => {
        const entrada = porTabla[tabla];
        if (entrada === undefined) return { data: [], error: null };
        if (Array.isArray(entrada)) return entrada.length > 1 ? entrada.shift() : entrada[0];
        return entrada;
    };
    supabase.from.mockImplementation((tabla) => {
        llamadas[tabla] = llamadas[tabla] || { inserts: [] };
        const chain = {
            select: () => chain, eq: () => chain, neq: () => chain, in: () => chain,
            order: () => chain, limit: () => chain,
            insert: (payload) => { llamadas[tabla].inserts.push(payload); return chain; },
            update: (payload) => { llamadas[tabla].updates = llamadas[tabla].updates || []; llamadas[tabla].updates.push(payload); return chain; },
            single: () => chain, maybeSingle: () => chain,
            then: (resolve, reject) => Promise.resolve(consumir(tabla)).then(resolve, reject)
        };
        return chain;
    });
    return llamadas;
}

beforeEach(() => { jest.clearAllMocks(); });

// ═════════════════════════════════════════════════════════════════════════
// Funciones puras
// ═════════════════════════════════════════════════════════════════════════
describe('parsearWorkbook — estructura del Excel', () => {
    test('O — Excel sin la hoja "Situaciones detectadas" -> error explícito', () => {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([FILA_BASE]), 'Importación sistema');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        expect(() => parsearWorkbook(buf)).toThrow(/Situaciones detectadas/);
    });

    test('O — Excel sin la hoja "Importación sistema" -> error explícito', () => {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([SITUACION_1]), 'Situaciones detectadas');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        expect(() => parsearWorkbook(buf)).toThrow(/Importación sistema/);
    });

    test('P — falta una columna obligatoria en "Importación sistema" -> error con el nombre exacto', () => {
        const filaIncompleta = { ...FILA_BASE };
        delete filaIncompleta['Clave de vinculación'];
        const buf = construirBuffer({ filasImportacion: [filaIncompleta], filasSituaciones: [SITUACION_1, SITUACION_2] });
        expect(() => parsearWorkbook(buf)).toThrow(/Clave de vinculación/);
    });

    test('archivo con ambas hojas y todos los encabezados -> parsea sin error', () => {
        const buf = construirBuffer({ filasImportacion: [FILA_BASE], filasSituaciones: [SITUACION_1, SITUACION_2] });
        const { filasImportacion, filasSituaciones } = parsearWorkbook(buf);
        expect(filasImportacion.length).toBe(1);
        expect(filasSituaciones.length).toBe(2);
    });
});

describe('extraerFilaImportacion', () => {
    test('Q — versión de formato no soportada -> error', () => {
        const { errores } = extraerFilaImportacion({ ...FILA_BASE, 'Versión formato': 'CG-0.9' });
        expect(errores.some(e => /no soportada/.test(e))).toBe(true);
    });

    test('fila válida -> sin errores, importar=true, idsSituaciones parseados', () => {
        const { valores, errores } = extraerFilaImportacion(FILA_BASE);
        expect(errores).toEqual([]);
        expect(valores.importar).toBe(true);
        expect(valores.idsSituaciones).toEqual(['SIT-001', 'SIT-002']);
        expect(valores.categorias.length).toBe(2);
        expect(valores.fecha_rodeo).toBe('2026-09-18');
    });

    test('D — Importar = "No" -> valores.importar = false (se filtra aguas arriba)', () => {
        const { valores } = extraerFilaImportacion({ ...FILA_BASE, 'Importar': 'No' });
        expect(valores.importar).toBe(false);
    });

    test('N° situaciones no numérico -> error', () => {
        const { errores } = extraerFilaImportacion({ ...FILA_BASE, 'N° situaciones': 'dos' });
        expect(errores.some(e => /N° situaciones/.test(e))).toBe(true);
    });
});

describe('cruzarSituacionesConFila', () => {
    test('B — varias situaciones del mismo rodeo, todo coincide -> sin errores', () => {
        const { valores } = extraerFilaImportacion(FILA_BASE);
        const { situaciones, errores } = cruzarSituacionesConFila(valores, [SITUACION_1, SITUACION_2]);
        expect(errores).toEqual([]);
        expect(situaciones.length).toBe(2);
    });

    test('H (parte 1 del pedido) — ID de situación declarado pero faltante en la hoja de detalle -> rechaza el rodeo', () => {
        const { valores } = extraerFilaImportacion(FILA_BASE);
        const { situaciones, errores } = cruzarSituacionesConFila(valores, [SITUACION_1]); // falta SIT-002
        expect(situaciones).toEqual([]);
        expect(errores.some(e => /SIT-002/.test(e))).toBe(true);
    });

    test('I (parte 2 del pedido) — N° situaciones distinto de la cantidad de IDs válidos -> rechaza el rodeo', () => {
        const { valores } = extraerFilaImportacion({ ...FILA_BASE, 'N° situaciones': 5 });
        const { situaciones, errores } = cruzarSituacionesConFila(valores, [SITUACION_1, SITUACION_2]);
        expect(situaciones).toEqual([]);
        expect(errores.some(e => /N° situaciones/.test(e))).toBe(true);
    });

    test('IDs duplicados dentro de la misma fila -> error', () => {
        const { valores } = extraerFilaImportacion({ ...FILA_BASE, 'IDs situaciones': 'SIT-001, SIT-001' });
        const { errores } = cruzarSituacionesConFila(valores, [SITUACION_1, SITUACION_2]);
        expect(errores.some(e => /duplicados/.test(e))).toBe(true);
    });

    test('clave de vinculación de la situación no coincide con la del rodeo -> error', () => {
        const { valores } = extraerFilaImportacion(FILA_BASE);
        const situacionAjena = { ...SITUACION_2, 'Clave de vinculación': 'CLV-OTRA' };
        const { errores } = cruzarSituacionesConFila(valores, [SITUACION_1, situacionAjena]);
        expect(errores.some(e => /clave de vinculación distinta/.test(e))).toBe(true);
    });

    // ─── Fase 2.1.1 — Punto 5: Vinculación por situación ───────────────────
    test('Punto 5 — situación con Vinculación="Pendiente de vincular" referenciada en IDs situaciones -> rechaza la fila, NUNCA se inserta', () => {
        const { valores } = extraerFilaImportacion(FILA_BASE);
        const situacionPendiente = { ...SITUACION_2, 'Vinculación': 'Pendiente de vincular' };
        const filaRaw = { ...FILA_BASE }; // SIT-001 ok, SIT-002 pendiente
        const { valores: v2 } = extraerFilaImportacion(filaRaw);
        const { situaciones, errores } = cruzarSituacionesConFila(v2, [SITUACION_1, situacionPendiente]);
        expect(situaciones).toEqual([]);
        expect(errores.some(e => /Pendiente de vincular/.test(e) && /SIT-002/.test(e))).toBe(true);
    });

    // ─── Fase 2.1.1 — Punto 3: campos obligatorios por situación ───────────
    test('Punto 3 — situación sin "Incluir en comentario" reconocible (Sí/No) -> rechaza la fila', () => {
        const { valores } = extraerFilaImportacion(FILA_BASE);
        const situacionInvalida = { ...SITUACION_2, 'Incluir en comentario': 'Tal vez' };
        const { situaciones, errores } = cruzarSituacionesConFila(valores, [SITUACION_1, situacionInvalida]);
        expect(situaciones).toEqual([]);
        expect(errores.some(e => /Incluir en comentario/.test(e))).toBe(true);
    });

    test('Punto 3 — situación sin "Evidencia textual" -> rechaza la fila (campo obligatorio)', () => {
        const { valores } = extraerFilaImportacion(FILA_BASE);
        const situacionSinEvidencia = { ...SITUACION_2, 'Evidencia textual': '' };
        const { situaciones, errores } = cruzarSituacionesConFila(valores, [SITUACION_1, situacionSinEvidencia]);
        expect(situaciones).toEqual([]);
        expect(errores.some(e => /Evidencia textual/.test(e))).toBe(true);
    });

    // ─── Fase 2.1.1 — Punto 8: cruce de metadatos entre las dos hojas ──────
    test('Punto 8 — situación indica un Club distinto al de su fila -> rechaza la fila (inconsistencia interna del Excel)', () => {
        const { valores } = extraerFilaImportacion(FILA_BASE);
        const situacionOtroClub = { ...SITUACION_1, 'Club': 'CLUB COMPLETAMENTE DISTINTO' };
        const { situaciones, errores } = cruzarSituacionesConFila(valores, [situacionOtroClub, SITUACION_2]);
        expect(situaciones).toEqual([]);
        expect(errores.some(e => /Club distinto/.test(e))).toBe(true);
    });

    test('Punto 8 — situación indica un Jurado oficial distinto al de su fila -> rechaza la fila', () => {
        const { valores } = extraerFilaImportacion(FILA_BASE);
        const situacionOtroJurado = { ...SITUACION_1, 'Jurado oficial': 'OTRO JURADO COMPLETAMENTE DISTINTO' };
        const { situaciones, errores } = cruzarSituacionesConFila(valores, [situacionOtroJurado, SITUACION_2]);
        expect(situaciones).toEqual([]);
        expect(errores.some(e => /Jurado oficial distinto/.test(e))).toBe(true);
    });

    // ─── Fase 2.1.1 — Punto 7: fecha_situacion puede diferir de fecha_rodeo ─
    test('Punto 7 — Fecha rodeo 18/09 y Fecha situación 19/09 (situación un día después del rodeo) -> válido, se conserva fecha_situacion real', () => {
        const { valores } = extraerFilaImportacion(FILA_BASE); // Fecha rodeo: 18/09/2026
        const situacionOtroDia = { ...SITUACION_1, 'Fecha situación': '19/09/2026' }; // Fecha rodeo interna sigue 18/09 (coincide con la fila)
        const { situaciones, errores } = cruzarSituacionesConFila(valores, [situacionOtroDia, SITUACION_2]);
        expect(errores).toEqual([]);
        const sit1 = situaciones.find(s => s.id_situacion_excel === 'SIT-001');
        expect(sit1.fecha_situacion).toBe('2026-09-19'); // NUNCA se reemplaza por fecha_rodeo
    });

    // ─── Fase 2.1.1 — Punto 4/6: Incluir en comentario y Confianza se
    // extraen y persisten, pero nunca deciden el texto compacto ───────────
    test('Punto 4/6 — incluir_en_comentario y confianza se extraen correctamente y no bloquean la importación por sí solos', () => {
        const { valores } = extraerFilaImportacion(FILA_BASE);
        const situacionNoIncluida = { ...SITUACION_2, 'Incluir en comentario': 'No', 'Confianza': 'Baja' };
        const { situaciones, errores } = cruzarSituacionesConFila(valores, [SITUACION_1, situacionNoIncluida]);
        expect(errores).toEqual([]);
        const sit2 = situaciones.find(s => s.id_situacion_excel === 'SIT-002');
        expect(sit2.incluir_en_comentario).toBe(false); // se conserva para auditoría
        expect(sit2.confianza).toBe('Baja');
    });
});

// ─── Fase 2.1.1 — Punto 14: compatibilidad de encabezados de "Situaciones
// detectadas" con el Prompt Maestro V2 ───────────────────────────────────
describe('Compatibilidad de encabezados — "Situaciones detectadas" (Punto 14 del pedido)', () => {
    const filaUnaSituacion = { ...FILA_BASE, 'N° situaciones': 1, 'IDs situaciones': 'SIT-001' };

    test('A — encabezados EXACTOS oficiales -> OK', () => {
        const { situaciones, errores } = cruzarSituacionesConFila(extraerFilaImportacion(filaUnaSituacion).valores, [SITUACION_1]);
        expect(errores).toEqual([]);
        expect(situaciones.length).toBe(1);
    });

    test('B — sin tildes ("Area", "Categoria principal", "Descripcion unificada", "Vinculacion") -> OK', () => {
        // Reemplaza (nunca duplica) cada columna con tilde por su variante sin
        // tilde — un Excel real trae UNA sola de las dos, nunca ambas a la vez.
        const situacionSinTildes = { ...SITUACION_1 };
        const renombrar = { 'Área': 'Area', 'Categoría principal': 'Categoria principal', 'Descripción unificada': 'Descripcion unificada', 'Vinculación': 'Vinculacion' };
        for (const [conTilde, sinTilde] of Object.entries(renombrar)) {
            situacionSinTildes[sinTilde] = situacionSinTildes[conTilde];
            delete situacionSinTildes[conTilde];
        }
        const { situaciones, errores } = cruzarSituacionesConFila(extraerFilaImportacion(filaUnaSituacion).valores, [situacionSinTildes]);
        expect(errores).toEqual([]);
        expect(situaciones.length).toBe(1);
    });

    test('C — mayúsculas distintas ("EVIDENCIA TEXTUAL", "clave de vinculación") -> OK', () => {
        const filaRaw = { ...SITUACION_1 };
        delete filaRaw['Evidencia textual'];
        filaRaw['EVIDENCIA TEXTUAL'] = SITUACION_1['Evidencia textual'];
        delete filaRaw['Clave de vinculación'];
        filaRaw['CLAVE DE VINCULACIÓN'] = SITUACION_1['Clave de vinculación'];
        const { situaciones, errores } = cruzarSituacionesConFila(extraerFilaImportacion(filaUnaSituacion).valores, [filaRaw]);
        expect(errores).toEqual([]);
        expect(situaciones.length).toBe(1);
    });

    test('D — espacios adicionales al inicio/final de los encabezados -> OK', () => {
        const filaRaw = { ...SITUACION_1 };
        delete filaRaw['Evidencia textual'];
        filaRaw['  Evidencia textual  '] = SITUACION_1['Evidencia textual'];
        const { situaciones, errores } = cruzarSituacionesConFila(extraerFilaImportacion(filaUnaSituacion).valores, [filaRaw]);
        expect(errores).toEqual([]);
        expect(situaciones.length).toBe(1);
    });

    test('E — falta la columna "Evidencia textual" por completo en la hoja -> rechazo', () => {
        const filaRaw = { ...SITUACION_1 };
        delete filaRaw['Evidencia textual'];
        const { situaciones, errores } = cruzarSituacionesConFila(extraerFilaImportacion(filaUnaSituacion).valores, [filaRaw]);
        expect(situaciones).toEqual([]);
        expect(errores.some(e => /Evidencia textual/.test(e))).toBe(true);
    });

    test('F — falta la columna "ID Situación" por completo -> rechazo (la situación no puede ni identificarse)', () => {
        const filaRaw = { ...SITUACION_1 };
        delete filaRaw['ID Situación'];
        const { situaciones, errores } = cruzarSituacionesConFila(extraerFilaImportacion(filaUnaSituacion).valores, [filaRaw]);
        expect(situaciones).toEqual([]);
        // Sin ID, la situación ni siquiera se encuentra en el mapa por id -> "declarado pero no encontrado"
        expect(errores.some(e => /SIT-001/.test(e) && /no encontrado/.test(e))).toBe(true);
    });

    test('G — falta la columna "Fecha situación" por completo -> rechazo', () => {
        const filaRaw = { ...SITUACION_1 };
        delete filaRaw['Fecha situación'];
        const { situaciones, errores } = cruzarSituacionesConFila(extraerFilaImportacion(filaUnaSituacion).valores, [filaRaw]);
        expect(situaciones).toEqual([]);
        expect(errores.some(e => /Fecha situación/.test(e))).toBe(true);
    });

    test('H — una columna genérica "Fecha" (no "Fecha situación") NUNCA se confunde con fecha_situacion', () => {
        const filaRaw = { ...SITUACION_1 };
        delete filaRaw['Fecha situación'];
        filaRaw['Fecha'] = '18/09/2026'; // columna ambigua, NO es alias válido de "Fecha situación"
        const extraida = extraerFilaSituacion(filaRaw);
        expect(extraida.fecha_situacion).toBeNull(); // no se adivina desde "Fecha"
        const { situaciones, errores } = cruzarSituacionesConFila(extraerFilaImportacion(filaUnaSituacion).valores, [filaRaw]);
        expect(situaciones).toEqual([]);
        expect(errores.some(e => /Fecha situación/.test(e))).toBe(true);
    });
});

// ─── Fase 2.1.1 — Punto 13: integración completa con el formato oficial ──
describe('Integración — Excel CG-1.0 completo con los encabezados oficiales del Prompt Maestro V2 (Punto 13 del pedido)', () => {
    test('RODEO SAN CARLOS con 2 situaciones (SIT-001, SIT-002) -> el parser devuelve correctamente todos los campos', () => {
        const buf = construirBuffer({ filasImportacion: [FILA_BASE], filasSituaciones: [SITUACION_1, SITUACION_2] });
        const { filasImportacion, filasSituaciones } = parsearWorkbook(buf);

        const { valores, errores: erroresForma } = extraerFilaImportacion(filasImportacion[0]);
        expect(erroresForma).toEqual([]);
        expect(valores.version_formato).toBe('CG-1.0');
        expect(valores.fecha_rodeo).toBe('2026-09-18');
        expect(valores.club).toBe('SAN CARLOS');
        expect(valores.asociacion).toBe('ÑUBLE');

        const { situaciones, errores: erroresCruce } = cruzarSituacionesConFila(valores, filasSituaciones);
        expect(erroresCruce).toEqual([]);
        expect(situaciones.length).toBe(2);

        const sit1 = situaciones.find(s => s.id_situacion_excel === 'SIT-001');
        const sit2 = situaciones.find(s => s.id_situacion_excel === 'SIT-002');

        expect(sit1.fecha_situacion).toBe('2026-09-18');
        expect(sit1.hora).toBe('10:30');
        expect(sit1.area).toBe('Servicios');
        expect(sit1.categoria_principal).toBe('Servicios básicos / logística crítica');
        expect(sit1.subcategoria).toBe('Energía');
        expect(sit1.impacto).toBe('Alto');
        expect(sit1.descripcion_unificada).toBe('Corte de energía en la 1.ª Libre.');
        expect(sit1.estado_resultado).toBe('Reanudado al día siguiente');
        expect(sit1.incluir_en_comentario).toBe(true);
        expect(sit1.vinculacion).toBe('Vinculado al reporte');
        expect(sit1.confianza).toBe('Alta');
        expect(sit1.clave_vinculacion).toBe('CLV-1');
        expect(sit1.evidencia_textual).toBe('[10:30] Juan: se corto la luz en la primera libre');
        expect(sit1.jurado_chat).toBe('Juan Perez');

        expect(sit2.categoria_principal).toBe('Accidente de jinete');
        expect(sit2.descripcion_unificada).toContain('traslado al hospital');
        expect(sit2.confianza).toBe('Media');
    });
});

describe('calcularFingerprint — revisión: prioriza evidencia CRUDA del chat sobre la descripción parafraseada por GPT', () => {
    // evidencia_textual/lineas_chat son "el dato que viene directamente del
    // chat" (cita o transcript literal) — cambian poco o nada si el MISMO
    // chat se reprocesa. descripcion_unificada es la redacción de GPT y
    // puede variar de una corrida a otra para el MISMO hecho real — por eso
    // ya NO es el componente principal del fingerprint.
    const base = {
        rodeo_id: 'r1', fecha_situacion: '2026-09-18', hora: '10:30',
        categoria_principal: 'Servicios básicos', subcategoria: 'Energía', jurado_chat: 'Juan Perez',
        evidencia_textual: '[10:30] Juan: se cayó la luz en la primera libre, quedamos sin sonido',
        lineas_chat: '[10:30] Juan: se cayo la luz\n[10:31] Juan: sin sonido',
        descripcion_unificada: 'Corte de energía en la 1.ª Libre.'
    };

    test('CASO A del pedido — mismo hecho + misma evidencia del chat + descripción PARAFRASEADA distinta -> MISMO fingerprint (duplicado)', () => {
        const reprocesado = { ...base, descripcion_unificada: 'Se produjo un corte eléctrico durante la 1.ª Libre, generando además pérdida de sonido.' };
        expect(calcularFingerprint(reprocesado)).toBe(calcularFingerprint(base));
    });

    test('CASO B del pedido — id_situacion_excel nunca es parámetro de la función (SIT-007 -> SIT-008 es indiferente por diseño) -> mismo fingerprint', () => {
        expect(calcularFingerprint(base)).toBe(calcularFingerprint({ ...base })); // ninguno de los dos recibe id_situacion_excel
    });

    test('CASO C del pedido — mismo hecho con variación de mayúsculas/espacios en la evidencia -> mismo fingerprint', () => {
        const variante = { ...base, evidencia_textual: '  [10:30] JUAN:   se CAYO la luz en la Primera Libre,   quedamos sin sonido  ' };
        expect(calcularFingerprint(variante)).toBe(calcularFingerprint(base));
    });

    test('CASO D del pedido — dos hechos DISTINTOS con la MISMA categoría (evidencia distinta) -> NO duplicado', () => {
        const otroHecho = { ...base, evidencia_textual: '[16:00] Pedro: se rompio un enchufe en la caseta de jurados' };
        expect(calcularFingerprint(otroHecho)).not.toBe(calcularFingerprint(base));
    });

    test('CASO E del pedido — dos hechos DISTINTOS con hora cercana (no igual) -> NO duplicado', () => {
        const otroHechoHoraCercana = { ...base, hora: '10:31', evidencia_textual: '[10:31] Juan: tambien se corto el generador auxiliar' };
        expect(calcularFingerprint(otroHechoHoraCercana)).not.toBe(calcularFingerprint(base));
    });

    test('CASO F del pedido — dos RODEOS distintos con evidencia similar/idéntica -> NO duplicado (rodeo_id participa)', () => {
        expect(calcularFingerprint({ ...base, rodeo_id: 'r2' })).not.toBe(calcularFingerprint(base));
    });

    test('fallback 1 — evidencia_textual vacía: usa lineas_chat (también crudo) en su lugar, sigue siendo estable ante reparafraseo de la descripción', () => {
        const sinEvidencia = { ...base, evidencia_textual: '' };
        const reprocesadoSinEvidencia = { ...sinEvidencia, descripcion_unificada: 'Redacción distinta del mismo hecho.' };
        expect(calcularFingerprint(reprocesadoSinEvidencia)).toBe(calcularFingerprint(sinEvidencia));
        // Y sigue siendo distinto de un hecho realmente distinto (lineas_chat distinto)
        expect(calcularFingerprint({ ...sinEvidencia, lineas_chat: '[12:00] Otro: hecho totalmente distinto' })).not.toBe(calcularFingerprint(sinEvidencia));
    });

    test('fallback 2 — evidencia_textual Y lineas_chat vacías: usa categoría+subcategoría+jurado+descripción como último recurso (documentado como más débil)', () => {
        const sinDatosCrudos = { ...base, evidencia_textual: '', lineas_chat: '' };
        // En este modo de respaldo, SÍ depende de la descripción — es la limitación documentada.
        const conOtraDescripcion = { ...sinDatosCrudos, descripcion_unificada: 'Texto completamente distinto.' };
        expect(calcularFingerprint(conOtraDescripcion)).not.toBe(calcularFingerprint(sinDatosCrudos));
        // Pero sigue siendo estable ante mayúsculas/espacios y ante renumeración SIT-XXX.
        const mismaDescripcionOtroFormato = { ...sinDatosCrudos, categoria_principal: '  SERVICIOS básicos ' };
        expect(calcularFingerprint(mismaDescripcionOtroFormato)).toBe(calcularFingerprint(sinDatosCrudos));
    });

    test('el núcleo "evidencia" y el núcleo "respaldo" nunca colisionan entre sí aunque el texto normalizado coincida (prefijos distintos)', () => {
        const viaEvidencia = { rodeo_id: 'r1', fecha_situacion: '2026-01-01', hora: '10:00', evidencia_textual: 'x' };
        const viaRespaldo = { rodeo_id: 'r1', fecha_situacion: '2026-01-01', hora: '10:00', categoria_principal: 'x' };
        expect(calcularFingerprint(viaEvidencia)).not.toBe(calcularFingerprint(viaRespaldo));
    });
});

describe('Punto 9 de la revisión — el comentario nuevo usa "Texto comentario monitor" TAL CUAL, nunca se reconstruye', () => {
    test('extraerFilaImportacion conserva el texto exactamente como viene en el Excel', () => {
        const { valores } = extraerFilaImportacion(FILA_BASE);
        expect(valores.texto_comentario).toBe(FILA_BASE['Texto comentario monitor']);
    });

    test('"Texto comentario monitor" ausente -> error de validación (nunca se reconstruye un texto de reemplazo)', () => {
        const { errores } = extraerFilaImportacion({ ...FILA_BASE, 'Texto comentario monitor': '' });
        expect(errores.some(e => /Texto comentario monitor/.test(e))).toBe(true);
    });
});

describe('construirComentarioFinal — Agregar / Reemplazar / Omitir (K/L/M del pedido)', () => {
    const nuevo = 'Rodeo: X - Y; Fecha: 01/01/2026\nN° situaciones: 1\nCategorías:\n- Cat\nComentario del monitor: resumen';

    test('K — Agregar con comentario existente: preserva el anterior y agrega el nuevo separado', () => {
        const resultado = construirComentarioFinal({ accion: 'agregar', comentarioActual: 'Comentario manual previo.', comentarioNuevo: nuevo });
        expect(resultado).toContain('Comentario manual previo.');
        expect(resultado).toContain(nuevo);
    });

    test('L — Reemplazar: el resultado es EXACTAMENTE el nuevo bloque, sin rastro del anterior', () => {
        const resultado = construirComentarioFinal({ accion: 'reemplazar', comentarioActual: 'Comentario manual previo.', comentarioNuevo: nuevo });
        expect(resultado).toBe(nuevo);
    });

    test('M — Omitir: retorna null (la RPC lo interpreta como "no tocar")', () => {
        const resultado = construirComentarioFinal({ accion: 'omitir', comentarioActual: 'Comentario manual previo.', comentarioNuevo: nuevo });
        expect(resultado).toBeNull();
    });

    test('N — reimportar el mismo Excel con "Agregar": NO duplica el mismo bloque ya presente', () => {
        const yaAgregado = 'Comentario manual previo.\n\n---\n\n' + nuevo;
        const resultado = construirComentarioFinal({ accion: 'agregar', comentarioActual: yaAgregado, comentarioNuevo: nuevo });
        expect(resultado).toBe(yaAgregado); // sin cambios, no se duplica
    });

    test('sin comentario actual, cualquier acción normal produce el bloque nuevo tal cual', () => {
        expect(construirComentarioFinal({ accion: 'agregar', comentarioActual: null, comentarioNuevo: nuevo })).toBe(nuevo);
    });

    // ─── Punto 4 de la revisión — caso "A+B -> A+B+C" ──────────────────────
    describe('reemplazo del ÚLTIMO bloque de Control de Gestión (evita ir acumulando bloques sobre los mismos hechos)', () => {
        const bloqueAB = 'Rodeo: X - Y; Fecha: 01/01/2026\nN° situaciones: 2\nCategorías:\n- Cat\nComentario del monitor: A y B';
        const bloqueABC = 'Rodeo: X - Y; Fecha: 01/01/2026\nN° situaciones: 3\nCategorías:\n- Cat\nComentario del monitor: A, B y C';

        test('el comentario actual contiene el último bloque de CG (A+B) -> se REEMPLAZA por el nuevo consolidado (A+B+C), preservando el texto manual alrededor', () => {
            const actual = 'Nota manual del jefe deportivo.\n\n---\n\n' + bloqueAB;
            const resultado = construirComentarioFinal({ accion: 'agregar', comentarioActual: actual, comentarioNuevo: bloqueABC, ultimoBloqueControlGestion: bloqueAB });

            expect(resultado).toContain('Nota manual del jefe deportivo.');
            expect(resultado).toContain(bloqueABC);
            expect(resultado).not.toContain(bloqueAB.split('\n')[1]); // "N° situaciones: 2" (del bloque viejo) ya no está
            // Nunca duplicado: el bloque viejo no convive con el nuevo.
            expect((resultado.match(/Rodeo: X - Y/g) || []).length).toBe(1);
        });

        test('sin ultimoBloqueControlGestion (primera importación) -> se comporta como antes: agrega al final', () => {
            const resultado = construirComentarioFinal({ accion: 'agregar', comentarioActual: 'Nota manual.', comentarioNuevo: bloqueABC, ultimoBloqueControlGestion: null });
            expect(resultado).toBe('Nota manual.\n\n---\n\n' + bloqueABC);
        });

        test('el administrador editó el bloque de CG a mano en el MEDIO del texto (ya no coincide exactamente como substring) -> vuelve al comportamiento seguro por defecto: agrega al final, no sobrescribe la edición manual', () => {
            // La edición cambia una línea intermedia (no solo agrega texto al
            // final) — así bloqueAB deja de ser substring literal de "actual".
            const actual = 'Nota manual del jefe deportivo.\n\n---\n\n' + bloqueAB.replace('N° situaciones: 2', 'N° situaciones: 2 (verificado por Jefe Deportivo)');
            const resultado = construirComentarioFinal({ accion: 'agregar', comentarioActual: actual, comentarioNuevo: bloqueABC, ultimoBloqueControlGestion: bloqueAB });
            expect(resultado).toBe(actual + '\n\n---\n\n' + bloqueABC); // agregado, la edición manual queda intacta
        });

        test('accion "reemplazar" ignora ultimoBloqueControlGestion — siempre sustituye TODO por el nuevo bloque (decisión explícita)', () => {
            const actual = 'Nota manual.\n\n---\n\n' + bloqueAB;
            const resultado = construirComentarioFinal({ accion: 'reemplazar', comentarioActual: actual, comentarioNuevo: bloqueABC, ultimoBloqueControlGestion: bloqueAB });
            expect(resultado).toBe(bloqueABC);
        });
    });
});

// ═════════════════════════════════════════════════════════════════════════
// Funciones con acceso a datos (supabase mockeado)
// ═════════════════════════════════════════════════════════════════════════
describe('matchearRodeo', () => {
    test('Rodeo ID válido y coherente -> ok', async () => {
        mockSupabaseGenerico({
            rodeos: { data: { id: 'r1', club: 'SAN CARLOS', asociacion: 'ÑUBLE', fecha: '2026-09-18', estado: 'activo' }, error: null }
        });
        const r = await matchearRodeo({ rodeoIdExcel: 'r1', fecha: '2026-09-18', club: 'SAN CARLOS', asociacion: 'ÑUBLE', juradoOficial: 'Juan' });
        expect(r.estado).toBe('ok');
        expect(r.rodeo.id).toBe('r1');
    });

    test('F — Rodeo ID inexistente -> error', async () => {
        mockSupabaseGenerico({ rodeos: { data: null, error: null } });
        const r = await matchearRodeo({ rodeoIdExcel: 'no-existe', fecha: '2026-09-18', club: 'X', asociacion: 'Y' });
        expect(r.estado).toBe('error');
    });

    test('G — Rodeo ID válido pero fecha/club/asociación no coinciden -> advertencia (no error, no ok)', async () => {
        mockSupabaseGenerico({
            rodeos: { data: { id: 'r1', club: 'OTRO CLUB', asociacion: 'ÑUBLE', fecha: '2026-09-18', estado: 'activo' }, error: null }
        });
        const r = await matchearRodeo({ rodeoIdExcel: 'r1', fecha: '2026-09-18', club: 'SAN CARLOS', asociacion: 'ÑUBLE' });
        expect(r.estado).toBe('advertencia');
    });

    test('H — fallback sin Rodeo ID, UNA coincidencia exacta -> ok', async () => {
        mockSupabaseGenerico({
            rodeos: {
                data: [{ id: 'r1', club: 'SAN CARLOS', asociacion: 'ÑUBLE', estado: 'activo', asignaciones: [{ tipo_persona: 'jurado', estado: 'activo', usuarios_pagados: { nombre_completo: 'JUAN PEREZ' } }] }],
                error: null
            }
        });
        const r = await matchearRodeo({ rodeoIdExcel: null, fecha: '2026-09-18', club: 'san carlos', asociacion: 'ñuble', juradoOficial: 'Juan Perez' });
        expect(r.estado).toBe('ok');
        expect(r.rodeo.id).toBe('r1');
    });

    test('I — fallback sin Rodeo ID, 0 coincidencias -> error, nunca inventa una', async () => {
        mockSupabaseGenerico({ rodeos: { data: [], error: null } });
        const r = await matchearRodeo({ rodeoIdExcel: null, fecha: '2026-09-18', club: 'X', asociacion: 'Y' });
        expect(r.estado).toBe('error');
    });

    test('J — fallback sin Rodeo ID, MÁS DE 1 coincidencia -> error, nunca elige arbitrariamente', async () => {
        mockSupabaseGenerico({
            rodeos: {
                data: [
                    { id: 'r1', club: 'SAN CARLOS', asociacion: 'ÑUBLE', estado: 'activo', asignaciones: [] },
                    { id: 'r2', club: 'SAN CARLOS', asociacion: 'ÑUBLE', estado: 'activo', asignaciones: [] }
                ], error: null
            }
        });
        const r = await matchearRodeo({ rodeoIdExcel: null, fecha: '2026-09-18', club: 'SAN CARLOS', asociacion: 'ÑUBLE' });
        expect(r.estado).toBe('error');
        expect(r.motivo).toMatch(/ambiguo/);
    });
});

describe('generarPreview — NO escribe nada (solo SELECT)', () => {
    test('A — 1 rodeo, 1 situación válida -> fila estado ok, comentario_nuevo construido, sin llamadas insert', async () => {
        const llamadas = mockSupabaseGenerico({
            rodeos: { data: { id: 'r1', club: 'SAN CARLOS', asociacion: 'ÑUBLE', fecha: '2026-09-18', estado: 'activo' }, error: null },
            datos_monitor_rodeo: { data: null, error: null }
        });
        const filaUnaSituacion = { ...FILA_BASE, 'Rodeo ID': 'r1', 'N° situaciones': 1, 'IDs situaciones': 'SIT-001' };
        const buf = construirBuffer({ filasImportacion: [filaUnaSituacion], filasSituaciones: [SITUACION_1] });

        const { filas, resumen } = await generarPreview(buf);

        expect(resumen.importables).toBe(1);
        expect(filas[0].estado).toBe('ok');
        // Punto 9: EXACTAMENTE el texto de "Texto comentario monitor", verbatim, nunca reconstruido.
        expect(filas[0].comentario_nuevo).toBe(filaUnaSituacion['Texto comentario monitor']);
        expect(filas[0].rodeo_id_resuelto).toBe('r1');
        expect(Object.values(llamadas).every(t => t.inserts.length === 0)).toBe(true);
    });

    test('C — varios rodeos en el mismo archivo: cada uno se resuelve independientemente', async () => {
        mockSupabaseGenerico({
            rodeos: [
                { data: { id: 'r1', club: 'SAN CARLOS', asociacion: 'ÑUBLE', fecha: '2026-09-18', estado: 'activo' }, error: null },
                { data: { id: 'r2', club: 'CURICO', asociacion: 'MAULE', fecha: '2026-09-19', estado: 'activo' }, error: null }
            ],
            datos_monitor_rodeo: { data: null, error: null }
        });
        // SIT-900 pertenece al SEGUNDO rodeo (Club/Asociación/Fecha propios,
        // distintos de SITUACION_1) — cada situación debe ser consistente con
        // SU fila (Punto 8), nunca compartida entre rodeos distintos.
        const SITUACION_OTRO_RODEO = { ...SITUACION_1, 'ID Situación': 'SIT-900', 'Club': 'CURICO', 'Asociación': 'MAULE', 'Fecha rodeo': '19/09/2026' };
        const filas = [
            { ...FILA_BASE, 'Rodeo ID': 'r1', 'N° situaciones': 1, 'IDs situaciones': 'SIT-001' },
            { ...FILA_BASE, 'Rodeo ID': 'r2', 'Club': 'CURICO', 'Asociación': 'MAULE', 'Fecha rodeo': '19/09/2026', 'N° situaciones': 1, 'IDs situaciones': 'SIT-900', 'Clave de vinculación': 'CLV-1' }
        ];
        const buf = construirBuffer({ filasImportacion: filas, filasSituaciones: [SITUACION_1, SITUACION_OTRO_RODEO] });

        const { filas: filasPreview } = await generarPreview(buf);
        expect(filasPreview.every(f => f.estado === 'ok')).toBe(true);
        expect(filasPreview.map(f => f.rodeo_id_resuelto)).toEqual(['r1', 'r2']);
    });

    test('D — Importar = "No" -> omitida_por_filtro, nunca intenta matchear rodeo', async () => {
        const llamadas = mockSupabaseGenerico({});
        const buf = construirBuffer({ filasImportacion: [{ ...FILA_BASE, 'Importar': 'No' }], filasSituaciones: [SITUACION_1, SITUACION_2] });
        const { filas } = await generarPreview(buf);
        expect(filas[0].estado).toBe('omitida_por_filtro');
        expect(llamadas.rodeos).toBeUndefined();
    });

    test('E — Estado vinculación distinto de "Vinculado al reporte" -> omitida_por_filtro', async () => {
        const buf = construirBuffer({ filasImportacion: [{ ...FILA_BASE, 'Estado vinculación': 'Pendiente de vincular' }], filasSituaciones: [SITUACION_1, SITUACION_2] });
        const { filas } = await generarPreview(buf);
        expect(filas[0].estado).toBe('omitida_por_filtro');
    });

    test('comentario actual se muestra en la previsualización (nunca se sobrescribe silenciosamente)', async () => {
        mockSupabaseGenerico({
            rodeos: { data: { id: 'r1', club: 'SAN CARLOS', asociacion: 'ÑUBLE', fecha: '2026-09-18', estado: 'activo' }, error: null },
            datos_monitor_rodeo: { data: { comentario_monitor: 'Comentario manual ya existente.' }, error: null }
        });
        const fila = { ...FILA_BASE, 'Rodeo ID': 'r1', 'N° situaciones': 1, 'IDs situaciones': 'SIT-001' };
        const buf = construirBuffer({ filasImportacion: [fila], filasSituaciones: [SITUACION_1] });
        const { filas } = await generarPreview(buf);
        expect(filas[0].comentario_actual).toBe('Comentario manual ya existente.');
        expect(filas[0].accion_sugerida).toBe('agregar'); // hay comentario previo -> nunca sugiere reemplazar por defecto
    });
});

describe('confirmarImportacion — revalida desde cero, escribe por RPC atómica por rodeo', () => {
    test('A — fila válida + decisión "reemplazar" -> registra importación, llama la RPC con comentario y situaciones con fingerprint', async () => {
        const llamadas = mockSupabaseGenerico({
            rodeos: { data: { id: 'r1', club: 'SAN CARLOS', asociacion: 'ÑUBLE', fecha: '2026-09-18', estado: 'activo' }, error: null },
            datos_monitor_rodeo: { data: null, error: null },
            importaciones: { data: { id: 'imp-1' }, error: null }
        });
        supabase.rpc.mockResolvedValue({ data: { comentario_actualizado: true, situaciones_insertadas: 1, situaciones_duplicadas: 0 }, error: null });

        const fila = { ...FILA_BASE, 'Rodeo ID': 'r1', 'N° situaciones': 1, 'IDs situaciones': 'SIT-001' };
        const buf = construirBuffer({ filasImportacion: [fila], filasSituaciones: [SITUACION_1] });

        const resultado = await confirmarImportacion(buf, [{ fila_index: 0, accion: 'reemplazar' }], 'cg.xlsx', 'admin-1');

        expect(resultado.exitosos).toBe(1);
        expect(resultado.errores).toBe(0);
        expect(supabase.rpc).toHaveBeenCalledWith('confirmar_control_gestion_rodeo', expect.objectContaining({
            p_rodeo_id: 'r1',
            p_es_agregar: false, // accion='reemplazar'
            p_bloque_cg: expect.stringContaining('Rodeo: SAN CARLOS - ÑUBLE'),
            p_situaciones: expect.arrayContaining([expect.objectContaining({ id_situacion_excel: 'SIT-001', fingerprint: expect.any(String) })])
        }));
        expect(llamadas.importaciones.inserts[0]).toMatchObject({ tipo: 'control_gestion', nombre_archivo: 'cg.xlsx' });
    });

    test('Punto 3 de la revisión — la RPC reporta sin_novedad (Agregar, todas las situaciones ya existían) -> se refleja en el detalle sin contarse como error', async () => {
        mockSupabaseGenerico({
            rodeos: { data: { id: 'r1', club: 'SAN CARLOS', asociacion: 'ÑUBLE', fecha: '2026-09-18', estado: 'activo' }, error: null },
            datos_monitor_rodeo: { data: { comentario_monitor: 'ya importado antes', control_gestion_ultimo_bloque: 'bloque anterior' }, error: null },
            importaciones: { data: { id: 'imp-1' }, error: null }
        });
        supabase.rpc.mockResolvedValue({ data: { comentario_actualizado: false, situaciones_insertadas: 0, situaciones_duplicadas: 1, sin_novedad: true }, error: null });

        const fila = { ...FILA_BASE, 'Rodeo ID': 'r1', 'N° situaciones': 1, 'IDs situaciones': 'SIT-001' };
        const buf = construirBuffer({ filasImportacion: [fila], filasSituaciones: [SITUACION_1] });

        const resultado = await confirmarImportacion(buf, [{ fila_index: 0, accion: 'agregar' }], 'cg.xlsx', 'admin-1');

        expect(resultado.errores).toBe(0);
        expect(resultado.exitosos).toBe(1); // procesada correctamente, solo que no había nada nuevo que agregar
        expect(resultado.detalle[0].resultado).toBe('sin_novedad');
        expect(resultado.detalle[0].comentario_actualizado).toBe(false);
    });

    test('Punto 4 de la revisión — usa el ULTIMO bloque de CG leído de datos_monitor_rodeo para construir el comentario final que se envía a la RPC', async () => {
        const bloqueAnterior = 'Rodeo: SAN CARLOS - ÑUBLE; Fecha: 18/09/2026\nN° situaciones: 1\nCategorías:\n- Cat vieja\nComentario del monitor: resumen viejo';
        mockSupabaseGenerico({
            rodeos: { data: { id: 'r1', club: 'SAN CARLOS', asociacion: 'ÑUBLE', fecha: '2026-09-18', estado: 'activo' }, error: null },
            datos_monitor_rodeo: { data: { comentario_monitor: 'Nota manual.\n\n---\n\n' + bloqueAnterior, control_gestion_ultimo_bloque: bloqueAnterior }, error: null },
            importaciones: { data: { id: 'imp-1' }, error: null }
        });
        supabase.rpc.mockResolvedValue({ data: { comentario_actualizado: true, situaciones_insertadas: 1, situaciones_duplicadas: 0, sin_novedad: false }, error: null });

        const fila = { ...FILA_BASE, 'Rodeo ID': 'r1', 'N° situaciones': 1, 'IDs situaciones': 'SIT-001' };
        const buf = construirBuffer({ filasImportacion: [fila], filasSituaciones: [SITUACION_1] });

        await confirmarImportacion(buf, [{ fila_index: 0, accion: 'agregar' }], 'cg.xlsx', 'admin-1');

        const llamadaRpc = supabase.rpc.mock.calls[0][1];
        expect(llamadaRpc.p_comentario_final).toContain('Nota manual.'); // texto manual preservado
        expect(llamadaRpc.p_comentario_final).not.toContain('resumen viejo'); // el bloque viejo fue reemplazado, no concatenado
        expect(llamadaRpc.p_comentario_final).toContain('Rodeo: SAN CARLOS - ÑUBLE'); // el bloque nuevo sí está
    });

    test('G del pedido — frontend intenta alterar rodeo_id en la decisión: el backend lo ignora (decisiones NUNCA traen rodeo_id, se reconstruye del Excel)', async () => {
        mockSupabaseGenerico({
            rodeos: { data: { id: 'r1', club: 'SAN CARLOS', asociacion: 'ÑUBLE', fecha: '2026-09-18', estado: 'activo' }, error: null },
            datos_monitor_rodeo: { data: null, error: null },
            importaciones: { data: { id: 'imp-1' }, error: null }
        });
        supabase.rpc.mockResolvedValue({ data: { comentario_actualizado: true, situaciones_insertadas: 1, situaciones_duplicadas: 0 }, error: null });

        const fila = { ...FILA_BASE, 'Rodeo ID': 'r1', 'N° situaciones': 1, 'IDs situaciones': 'SIT-001' };
        const buf = construirBuffer({ filasImportacion: [fila], filasSituaciones: [SITUACION_1] });

        // Decisión "envenenada" con un rodeo_id ajeno — la firma de confirmarImportacion
        // ni siquiera lee ese campo (solo fila_index + accion).
        await confirmarImportacion(buf, [{ fila_index: 0, accion: 'reemplazar', rodeo_id: 'rodeo-hackeado' }], 'cg.xlsx', 'admin-1');

        expect(supabase.rpc).toHaveBeenCalledWith('confirmar_control_gestion_rodeo', expect.objectContaining({ p_rodeo_id: 'r1' }));
    });

    test('F/error de matching — fila con error de validación/matching NO llama a la RPC, se cuenta como error', async () => {
        mockSupabaseGenerico({
            rodeos: { data: null, error: null },
            importaciones: { data: { id: 'imp-1' }, error: null }
        });
        const fila = { ...FILA_BASE, 'Rodeo ID': 'no-existe', 'N° situaciones': 1, 'IDs situaciones': 'SIT-001' };
        const buf = construirBuffer({ filasImportacion: [fila], filasSituaciones: [SITUACION_1] });

        const resultado = await confirmarImportacion(buf, [{ fila_index: 0, accion: 'reemplazar' }], 'cg.xlsx', 'admin-1');

        expect(resultado.errores).toBe(1);
        expect(resultado.exitosos).toBe(0);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('M — accion "omitir": no llama la RPC, se cuenta como omitido', async () => {
        mockSupabaseGenerico({
            rodeos: { data: { id: 'r1', club: 'SAN CARLOS', asociacion: 'ÑUBLE', fecha: '2026-09-18', estado: 'activo' }, error: null },
            importaciones: { data: { id: 'imp-1' }, error: null }
        });
        const fila = { ...FILA_BASE, 'Rodeo ID': 'r1', 'N° situaciones': 1, 'IDs situaciones': 'SIT-001' };
        const buf = construirBuffer({ filasImportacion: [fila], filasSituaciones: [SITUACION_1] });

        const resultado = await confirmarImportacion(buf, [{ fila_index: 0, accion: 'omitir' }], 'cg.xlsx', 'admin-1');

        expect(resultado.omitidos).toBe(1);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('sin decisión explícita para una fila -> se trata como "omitir" (seguro por defecto, nunca escribe sin decisión del usuario)', async () => {
        mockSupabaseGenerico({
            rodeos: { data: { id: 'r1', club: 'SAN CARLOS', asociacion: 'ÑUBLE', fecha: '2026-09-18', estado: 'activo' }, error: null },
            importaciones: { data: { id: 'imp-1' }, error: null }
        });
        const fila = { ...FILA_BASE, 'Rodeo ID': 'r1', 'N° situaciones': 1, 'IDs situaciones': 'SIT-001' };
        const buf = construirBuffer({ filasImportacion: [fila], filasSituaciones: [SITUACION_1] });

        const resultado = await confirmarImportacion(buf, [], 'cg.xlsx', 'admin-1');

        expect(resultado.omitidos).toBe(1);
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    test('error al invocar la RPC (simula fallo intermedio) -> se cuenta como error, no se marca exitoso', async () => {
        mockSupabaseGenerico({
            rodeos: { data: { id: 'r1', club: 'SAN CARLOS', asociacion: 'ÑUBLE', fecha: '2026-09-18', estado: 'activo' }, error: null },
            datos_monitor_rodeo: { data: null, error: null },
            importaciones: { data: { id: 'imp-1' }, error: null }
        });
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'fallo simulado' } });

        const fila = { ...FILA_BASE, 'Rodeo ID': 'r1', 'N° situaciones': 1, 'IDs situaciones': 'SIT-001' };
        const buf = construirBuffer({ filasImportacion: [fila], filasSituaciones: [SITUACION_1] });

        const resultado = await confirmarImportacion(buf, [{ fila_index: 0, accion: 'reemplazar' }], 'cg.xlsx', 'admin-1');

        expect(resultado.errores).toBe(1);
        expect(resultado.exitosos).toBe(0);
    });
});

describe('obtenerSituacionesDeRodeo — R/S del pedido (solo lectura, por rodeo)', () => {
    test('R — rodeo con situaciones -> las retorna', async () => {
        mockSupabaseGenerico({
            control_gestion_situaciones: { data: [{ id: 's1', id_situacion_excel: 'SIT-001' }], error: null }
        });
        const situaciones = await obtenerSituacionesDeRodeo('r1');
        expect(situaciones.length).toBe(1);
    });

    test('S — rodeo sin situaciones -> arreglo vacío (el frontend decide no mostrar "Ver detalle")', async () => {
        mockSupabaseGenerico({ control_gestion_situaciones: { data: [], error: null } });
        const situaciones = await obtenerSituacionesDeRodeo('r1');
        expect(situaciones).toEqual([]);
    });
});
