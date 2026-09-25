// ═════════════════════════════════════════════════════════════════════════
// Importación de RODEOS HISTÓRICOS desde Excel — FASE 1: lectura + validación + matching + VISTA PREVIA.
//
// ⚠ SOLO LECTURA. Este módulo NUNCA escribe en la base de datos: no hay INSERT, UPDATE, DELETE ni RPC.
// Las únicas operaciones sobre `db` son SELECT (from().select()...). La escritura (confirmar importación)
// es una fase posterior y requiere autorización.
//
// Hoja: CARGA_HISTORICA. Una fila = 1 RODEO + 1 JURADO. Un rodeo con dos jurados ocupa dos filas y es UN rodeo.
// Encabezados: Temporada | Fecha | Club | Asociación | Tipo Rodeo | Categoría del Rodeo | Nombre Jurado |
//              Nota Delegado | Nota Comisión | Nota Deportiva | Casos por WhatsApp
//
// Dónde vive cada dato (auditado; ver reporte):
//   · Nota Delegado / Nota Comisión → rodeo_notas_secundarias (1 fila POR RODEO).
//   · Nota Deportiva                → notas_rodeo.nota (1 fila POR ASIGNACIÓN = por jurado). NO evaluaciones.nota_final.
//   · Casos por WhatsApp            → evaluaciones.casos_whatsapp (POR RODEO; requiere una evaluación).
//   · Asignación histórica futura: estado 'activo', estado_designacion 'aceptado', publicado false, pago 0.
//   · Categoría del jurado: la ACTUAL (no se reconstruye la histórica).
//
// Llave lógica del rodeo: fecha + club normalizado + asociación (canónica) + tipo de rodeo.
// ═════════════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const XLSX = require('xlsx');
const { normalizar } = require('./importacion');
const { normalizarAsociacion } = require('./asociaciones');
const { normalizarCasosWhatsapp } = require('./casosWhatsapp');
const { leerPaginado, leerPorLotes } = require('./informeGestion/cargaDatos');

const HOJA = 'CARGA_HISTORICA';
const ENCABEZADOS = ['Temporada', 'Fecha', 'Club', 'Asociación', 'Tipo Rodeo', 'Categoría del Rodeo', 'Nombre Jurado', 'Nota Delegado', 'Nota Comisión', 'Nota Deportiva', 'Casos por WhatsApp'];
const CLAVES = ['temporada', 'fecha', 'club', 'asociacion', 'tipo', 'categoria', 'jurado', 'nota_delegado', 'nota_comision', 'nota_deportiva', 'casos'];
const NOTA_MIN = 1.0, NOTA_MAX = 7.0;     // CHECK reales: notas_rodeo_nota_check y rns_nota_*_rango (1.0 a 7.0)
const TOLERANCIA_NOTA = 0.005;

// Temporadas habilitadas para importación histórica y su ventana de fechas permitida.
// Primera implementación: solo 2025-2026 (01-01-2026 a 31-03-2026). Diseñado para agregar otras sin tocar la lógica.
const TEMPORADAS_HISTORICAS = Object.freeze({
    '2025-2026': Object.freeze({ desde: '2026-01-01', hasta: '2026-03-31' })
});

const ESTADOS = Object.freeze({
    LISTO: 'LISTO PARA IMPORTAR',
    RODEO_YA_EXISTE: 'RODEO YA EXISTE',
    RODEO_EXISTE_FALTANTES: 'RODEO EXISTE / DATOS FALTANTES',
    JURADO_A_ASOCIAR: 'JURADO A ASOCIAR',
    JURADO_YA_ASOCIADO: 'JURADO YA ASOCIADO',
    ASOC_NO_ENCONTRADA: 'ASOCIACIÓN NO ENCONTRADA',
    ASOC_AMBIGUA: 'ASOCIACIÓN AMBIGUA',
    JURADO_NO_ENCONTRADO: 'JURADO NO ENCONTRADO',
    JURADO_AMBIGUO: 'JURADO AMBIGUO',
    TIPO_NO_ENCONTRADO: 'TIPO DE RODEO NO ENCONTRADO',
    TIPO_AMBIGUO: 'TIPO DE RODEO AMBIGUO',
    CATEGORIA_INVALIDA: 'CATEGORÍA INVÁLIDA',
    FECHA_INVALIDA: 'FECHA INVÁLIDA',
    FECHA_FUERA: 'FECHA FUERA DEL PERÍODO',
    TEMPORADA_NO_COINCIDE: 'TEMPORADA NO COINCIDE',
    NOTA_DELEGADO_INVALIDA: 'NOTA DELEGADO INVÁLIDA',
    NOTA_COMISION_INVALIDA: 'NOTA COMISIÓN INVÁLIDA',
    NOTA_DEPORTIVA_INVALIDA: 'NOTA DEPORTIVA INVÁLIDA',
    CASOS_INVALIDO: 'CASOS WHATSAPP INVÁLIDO',
    CONFLICTO_DELEGADO_ARCHIVO: 'CONFLICTO NOTA DELEGADO EN ARCHIVO',
    CONFLICTO_COMISION_ARCHIVO: 'CONFLICTO NOTA COMISIÓN EN ARCHIVO',
    CONFLICTO_CASOS_ARCHIVO: 'CONFLICTO CASOS POR WHATSAPP EN ARCHIVO',
    CONFLICTO_DELEGADO: 'CONFLICTO NOTA DELEGADO',
    CONFLICTO_COMISION: 'CONFLICTO NOTA COMISIÓN',
    CONFLICTO_DEPORTIVA: 'CONFLICTO NOTA DEPORTIVA',
    CONFLICTO_CASOS: 'CONFLICTO CASOS POR WHATSAPP',
    CONFLICTO_DATOS_RODEO: 'CONFLICTO DE DATOS DEL MISMO RODEO',
    DUPLICADO_ARCHIVO: 'DUPLICADO EN ARCHIVO',
    EVALUACION_EXISTENTE: 'EVALUACIÓN EXISTENTE',
    EVALUACION_REQUERIDA: 'EVALUACIÓN REQUERIDA PARA CASOS WHATSAPP',
    YA_REGISTRADO: 'YA REGISTRADO / SIN CAMBIOS',
    DATO_FALTANTE: 'DATO FALTANTE A COMPLETAR',
    ERROR: 'ERROR'
});

// Errores de archivo (se devuelven como 400 con código; no hay vista previa).
class ErrorArchivo extends Error {
    constructor(codigo, mensaje, detalle = null) { super(mensaje); this.codigo = codigo; this.detalle = detalle; this.status = 400; }
}

// ── Normalización ────────────────────────────────────────────────────────
const norm = normalizar;   // minúsculas, sin tildes, guiones→espacio, espacios colapsados
const vacio = v => v === null || v === undefined || String(v).trim() === '';
const texto = v => (v === null || v === undefined ? '' : String(v).trim().replace(/\s+/g, ' '));

// Fecha: serial de Excel (número), DD-MM-AAAA / DD/MM/AAAA / DD.MM.AAAA (formato chileno) o ISO AAAA-MM-DD.
// Sin Date/zonas horarias: aritmética de calendario pura.
function fechaValida(a, m, d) {
    if (m < 1 || m > 12 || d < 1) return false;
    const dias = [31, (a % 4 === 0 && a % 100 !== 0) || a % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return d <= dias[m - 1];
}
function parsearFecha(v) {
    if (vacio(v)) return { ok: false, motivo: 'vacía' };
    if (typeof v === 'number') {
        const f = XLSX.SSF.parse_date_code(v);
        if (!f || !fechaValida(f.y, f.m, f.d)) return { ok: false, motivo: 'inválida' };
        return { ok: true, iso: `${f.y}-${String(f.m).padStart(2, '0')}-${String(f.d).padStart(2, '0')}` };
    }
    const s = String(v).trim();
    let a, m, d, r;
    if ((r = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) { d = +r[1]; m = +r[2]; a = +r[3]; }
    else if ((r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) { a = +r[1]; m = +r[2]; d = +r[3]; }
    else return { ok: false, motivo: 'formato no reconocido' };
    if (!fechaValida(a, m, d)) return { ok: false, motivo: 'inválida' };
    return { ok: true, iso: `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

const fmtFecha = iso => (iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : null);

// Nota: número o texto con punto/coma decimal; vacío = sin nota (null); rango 1,0–7,0. '-', 'N/A', texto → inválida.
function parsearNota(v) {
    if (vacio(v)) return { ok: true, valor: null };
    let n;
    if (typeof v === 'number') n = v;
    else {
        const s = String(v).trim().replace(',', '.');
        if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, motivo: `valor no numérico "${String(v).trim()}"` };
        n = Number(s);
    }
    if (!Number.isFinite(n)) return { ok: false, motivo: 'valor no numérico' };
    if (n < NOTA_MIN || n > NOTA_MAX) return { ok: false, motivo: `fuera de rango (${NOTA_MIN.toFixed(1)}–${NOTA_MAX.toFixed(1)}): ${n}` };
    return { ok: true, valor: Math.round(n * 100) / 100 };
}
const notasIguales = (a, b) => a !== null && b !== null && Math.abs(Number(a) - Number(b)) < TOLERANCIA_NOTA;

// Casos por WhatsApp: vacío = 0; entero >= 0 (reutiliza la validación del backend de Casos por WhatsApp).
function parsearCasos(v) {
    if (vacio(v)) return { ok: true, valor: 0 };
    const entrada = typeof v === 'number' ? v : String(v).trim();
    const r = normalizarCasosWhatsapp(entrada);
    return r.ok ? { ok: true, valor: r.valor } : { ok: false, motivo: `valor inválido "${String(v).trim()}" (debe ser entero ≥ 0)` };
}

// ── Lectura del Excel ────────────────────────────────────────────────────
function leerExcel(buffer) {
    let wb;
    try {
        if (!buffer || !buffer.length) throw new Error('vacío');
        wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: true });
    } catch (e) {
        throw new ErrorArchivo('ARCHIVO_CORRUPTO', 'El archivo no es un Excel válido o está corrupto.');
    }
    if (!wb || !Array.isArray(wb.SheetNames) || wb.SheetNames.length === 0) throw new ErrorArchivo('ARCHIVO_CORRUPTO', 'El archivo no contiene hojas legibles.');
    if (!wb.SheetNames.includes(HOJA)) throw new ErrorArchivo('HOJA_NO_ENCONTRADA', `No existe la hoja "${HOJA}". Hojas encontradas: ${wb.SheetNames.join(', ') || '(ninguna)'}.`, { hojas: wb.SheetNames });
    const matriz = XLSX.utils.sheet_to_json(wb.Sheets[HOJA], { header: 1, defval: '', raw: true, blankrows: true });
    if (matriz.length === 0) throw new ErrorArchivo('ENCABEZADOS_INCORRECTOS', 'La hoja está vacía: faltan los encabezados.', { faltantes: ENCABEZADOS, inesperados: [] });

    const encabezados = (matriz[0] || []).map(texto);
    const esperados = ENCABEZADOS.map(norm), recibidos = encabezados.map(norm);
    const faltantes = ENCABEZADOS.filter((h, i) => !recibidos.includes(esperados[i]));
    const inesperados = encabezados.filter((h, i) => h !== '' && !esperados.includes(recibidos[i]));
    if (faltantes.length || inesperados.length) {
        throw new ErrorArchivo('ENCABEZADOS_INCORRECTOS', `Encabezados incorrectos. Faltan: ${faltantes.join(', ') || '—'}. No reconocidos: ${inesperados.join(', ') || '—'}.`, { faltantes, inesperados, esperados: ENCABEZADOS });
    }
    const idx = {};
    CLAVES.forEach((k, i) => { idx[k] = recibidos.indexOf(esperados[i]); });

    const filas = [];
    for (let r = 1; r < matriz.length; r++) {
        const celdas = matriz[r] || [];
        if (celdas.every(vacio)) continue;                          // filas vacías: se ignoran
        const fila = { numero: r + 1 };                             // número de fila real en Excel
        CLAVES.forEach(k => { fila[k] = celdas[idx[k]]; });
        filas.push(fila);
    }
    return { filas, encabezados };
}

// ── Catálogos y resolución (matching) ────────────────────────────────────
function indexarAsociaciones(asociaciones = [], alias = []) {
    const mapa = new Map();      // normalizado → Map(id → asociación)
    const agregar = (n, a) => { if (!n) return; if (!mapa.has(n)) mapa.set(n, new Map()); mapa.get(n).set(a.id, a); };
    const porId = new Map(asociaciones.map(a => [a.id, a]));
    asociaciones.forEach(a => { agregar(normalizarAsociacion(a.nombre), a); if (a.nombre_normalizado) agregar(a.nombre_normalizado, a); });
    alias.forEach(al => { const a = porId.get(al.asociacion_id); if (a) { agregar(normalizarAsociacion(al.alias), a); if (al.alias_normalizado) agregar(al.alias_normalizado, a); } });
    return mapa;
}
function resolverAsociacion(valor, indice) {
    const n = normalizarAsociacion(valor);
    if (!n) return { estado: 'NO_ENCONTRADA' };
    const c = indice.get(n);
    if (!c || c.size === 0) return { estado: 'NO_ENCONTRADA' };
    if (c.size > 1) return { estado: 'AMBIGUA', candidatas: [...c.values()].map(a => a.nombre) };
    return { estado: 'OK', asociacion: [...c.values()][0] };
}

// Tipo: coincidencia EXACTA (solo trim) única → OK; si no, normalizada; más de una coincidencia → ambiguo.
function resolverTipo(valor, tipos) {
    const t = texto(valor);
    if (!t) return { estado: 'NO_ENCONTRADO' };
    const exactos = tipos.filter(x => texto(x.nombre) === t);
    if (exactos.length === 1) return { estado: 'OK', tipo: exactos[0] };
    const n = norm(t);
    const cand = tipos.filter(x => norm(x.nombre) === n);
    if (cand.length === 1) return { estado: 'OK', tipo: cand[0] };
    if (cand.length > 1) return { estado: 'AMBIGUO', candidatos: cand.map(x => x.nombre) };
    return { estado: 'NO_ENCONTRADO' };
}

function resolverCategoria(valor, categorias) {
    const n = norm(valor);
    const cand = categorias.filter(c => norm(c.nombre) === n);
    return cand.length === 1 ? { estado: 'OK', categoria: cand[0] } : { estado: cand.length > 1 ? 'AMBIGUA' : 'NO_ENCONTRADA' };
}

function indexarJurados(jurados = []) {
    const mapa = new Map();
    jurados.filter(j => j.es_prueba !== true).forEach(j => { const n = norm(j.nombre_completo); if (!n) return; if (!mapa.has(n)) mapa.set(n, []); mapa.get(n).push(j); });
    return mapa;
}
function resolverJurado(valor, indice) {
    const n = norm(valor);
    if (!n) return { estado: 'VACIO' };
    const c = indice.get(n) || [];
    if (c.length === 0) return { estado: 'NO_ENCONTRADO' };
    if (c.length > 1) return { estado: 'AMBIGUO', candidatos: c.map(j => ({ id: j.id, nombre: j.nombre_completo, estado: j.estado_usuario })) };
    return { estado: 'OK', jurado: c[0] };
}

const estadoActualJurado = j => (j.estado_usuario || (j.activo === false ? 'inactivo' : 'activo'));

// ── Procesamiento fila a fila ────────────────────────────────────────────
// alcance: 'grupo' = problema estructural COMPARTIDO (bloquea todo el rodeo); 'fila' = solo esa fila/jurado; sin alcance = por código.
function issue(codigo, mensaje, alcance) { return alcance ? { codigo, mensaje, alcance } : { codigo, mensaje }; }

const CODIGOS_ALCANCE_GRUPO = new Set([
    ESTADOS.TEMPORADA_NO_COINCIDE, ESTADOS.FECHA_INVALIDA, ESTADOS.FECHA_FUERA, ESTADOS.ASOC_NO_ENCONTRADA, ESTADOS.ASOC_AMBIGUA,
    ESTADOS.TIPO_NO_ENCONTRADO, ESTADOS.TIPO_AMBIGUO, ESTADOS.CATEGORIA_INVALIDA,
    ESTADOS.NOTA_DELEGADO_INVALIDA, ESTADOS.NOTA_COMISION_INVALIDA, ESTADOS.CASOS_INVALIDO,
    ESTADOS.CONFLICTO_DELEGADO_ARCHIVO, ESTADOS.CONFLICTO_COMISION_ARCHIVO, ESTADOS.CONFLICTO_CASOS_ARCHIVO, ESTADOS.CONFLICTO_DATOS_RODEO
]);
// Los conflictos contra la BD (CONFLICTO_DELEGADO/COMISION/DEPORTIVA/CASOS) NO bloquean: se informan y se conserva el dato existente.
const alcanceDe = (i) => i.alcance || (CODIGOS_ALCANCE_GRUPO.has(i.codigo) ? 'grupo' : 'fila');

function procesarFila(f, ctx) {
    const { temporada, rango, indAsoc, tipos, categorias, indJur } = ctx;
    const errores = [], advertencias = [];
    const out = {
        fila: f.numero, fecha: null, club: null,
        asociacion: { excel: texto(f.asociacion), canonica: null, id: null },
        tipo: { excel: texto(f.tipo), nombre: null, id: null, duracion_dias: null, categoria_derivada: null },
        categoria: { excel: texto(f.categoria), nombre: null, id: null, derivada: false },
        jurado: { excel: texto(f.jurado), id: null, nombre: null, estado_actual: null, categoria_actual: null, categoria_aplicada_futura: null },
        notas: { delegado: null, comision: null, deportiva: null },
        casos_whatsapp: 0,
        pago_futuro: 0
    };

    // Temporada del Excel (opcional) debe coincidir con la seleccionada
    if (!vacio(f.temporada) && norm(f.temporada) !== norm(temporada.nombre)) {
        errores.push(issue(ESTADOS.TEMPORADA_NO_COINCIDE, `La temporada del Excel (${texto(f.temporada)}) no coincide con la seleccionada (${temporada.nombre}).`));
    }

    // Fecha
    const pf = parsearFecha(f.fecha);
    if (!pf.ok) errores.push(issue(ESTADOS.FECHA_INVALIDA, `Fecha ${pf.motivo === 'vacía' ? 'vacía' : `"${texto(f.fecha)}" ${pf.motivo}`}. Formato esperado: DD-MM-AAAA.`));
    else {
        out.fecha = pf.iso;
        if (pf.iso < rango.desde || pf.iso > rango.hasta) errores.push(issue(ESTADOS.FECHA_FUERA, `La fecha ${fmtFecha(pf.iso)} está fuera del período permitido (${fmtFecha(rango.desde)} a ${fmtFecha(rango.hasta)}).`));
    }

    // Club: texto libre; vacío se interpreta como "Sin club" (mismo criterio del importador actual)
    if (vacio(f.club)) { out.club = 'Sin club'; advertencias.push(issue('ADVERTENCIA', 'Club vacío: se interpretará como "Sin club".')); }
    else out.club = texto(f.club);

    // Asociación
    if (vacio(f.asociacion)) errores.push(issue(ESTADOS.ASOC_NO_ENCONTRADA, 'La asociación está vacía.'));
    else {
        const ra = resolverAsociacion(f.asociacion, indAsoc);
        if (ra.estado === 'OK') { out.asociacion.canonica = ra.asociacion.nombre; out.asociacion.id = ra.asociacion.id; }
        else if (ra.estado === 'AMBIGUA') errores.push(issue(ESTADOS.ASOC_AMBIGUA, `La asociación "${texto(f.asociacion)}" coincide con más de una: ${ra.candidatas.join(', ')}.`));
        else errores.push(issue(ESTADOS.ASOC_NO_ENCONTRADA, `No se encontró la asociación "${texto(f.asociacion)}" en el catálogo.`));
    }

    // Tipo de rodeo
    const rt = resolverTipo(f.tipo, tipos);
    if (rt.estado === 'OK') {
        Object.assign(out.tipo, { nombre: rt.tipo.nombre, id: rt.tipo.id, duracion_dias: rt.tipo.duracion_dias });
        const cd = rt.tipo.categoria_rodeo_id ? categorias.find(c => c.id === rt.tipo.categoria_rodeo_id) : null;
        out.tipo.categoria_derivada = cd ? cd.nombre : null;
    } else if (rt.estado === 'AMBIGUO') errores.push(issue(ESTADOS.TIPO_AMBIGUO, `El tipo "${texto(f.tipo)}" coincide con más de uno: ${rt.candidatos.join(' | ')}.`));
    else errores.push(issue(ESTADOS.TIPO_NO_ENCONTRADO, `No se encontró el tipo de rodeo "${texto(f.tipo)}".`));

    // Categoría del rodeo (valores reales de categorias_rodeo; vacía → derivada del tipo si es inequívoca)
    if (!vacio(f.categoria)) {
        const rc = resolverCategoria(f.categoria, categorias);
        if (rc.estado === 'OK') { out.categoria.nombre = rc.categoria.nombre; out.categoria.id = rc.categoria.id; }
        else errores.push(issue(ESTADOS.CATEGORIA_INVALIDA, `La categoría "${texto(f.categoria)}" no existe en categorias_rodeo (${categorias.map(c => c.nombre).join(', ')}).`));
    } else if (out.tipo.categoria_derivada) {
        const cd = categorias.find(c => c.nombre === out.tipo.categoria_derivada);
        out.categoria.nombre = out.tipo.categoria_derivada; out.categoria.id = cd ? cd.id : null; out.categoria.derivada = true;
    } else if (rt.estado === 'OK') advertencias.push(issue('ADVERTENCIA', 'Categoría vacía y el tipo de rodeo no define una categoría: el rodeo quedaría sin categoría explícita.'));
    if (out.categoria.nombre && !out.categoria.derivada && out.tipo.categoria_derivada && norm(out.categoria.nombre) !== norm(out.tipo.categoria_derivada)) {
        advertencias.push(issue('ADVERTENCIA', `La categoría del Excel (${out.categoria.nombre}) difiere de la categoría del tipo (${out.tipo.categoria_derivada}).`));
    }

    // Jurado
    const rj = resolverJurado(f.jurado, indJur);
    if (rj.estado === 'OK') {
        const j = rj.jurado;
        Object.assign(out.jurado, { id: j.id, nombre: j.nombre_completo, estado_actual: estadoActualJurado(j), categoria_actual: j.categoria || null, categoria_aplicada_futura: j.categoria || null });
        if (!j.categoria) advertencias.push(issue('ADVERTENCIA', `El jurado ${j.nombre_completo} no tiene categoría actual: la asignación quedaría sin categoría aplicada.`));
        if (out.jurado.estado_actual !== 'activo') advertencias.push(issue('ADVERTENCIA', `El jurado está actualmente en estado "${out.jurado.estado_actual}" (se acepta: son hechos históricos).`));
    } else if (rj.estado === 'AMBIGUO') errores.push(issue(ESTADOS.JURADO_AMBIGUO, `"${texto(f.jurado)}" coincide con más de un jurado (${rj.candidatos.map(c => `${c.nombre} [${c.estado}]`).join(' | ')}). No se elige automáticamente.`));
    else if (rj.estado === 'VACIO') errores.push(issue(ESTADOS.ERROR, 'El nombre del jurado está vacío.', 'fila'));
    else errores.push(issue(ESTADOS.JURADO_NO_ENCONTRADO, `No se encontró un jurado llamado ${texto(f.jurado)} en el sistema.`));

    // Notas y casos
    const pd = parsearNota(f.nota_delegado); if (pd.ok) out.notas.delegado = pd.valor; else errores.push(issue(ESTADOS.NOTA_DELEGADO_INVALIDA, `Nota Delegado ${pd.motivo}.`));
    const pc = parsearNota(f.nota_comision); if (pc.ok) out.notas.comision = pc.valor; else errores.push(issue(ESTADOS.NOTA_COMISION_INVALIDA, `Nota Comisión ${pc.motivo}.`));
    const pp = parsearNota(f.nota_deportiva); if (pp.ok) out.notas.deportiva = pp.valor; else errores.push(issue(ESTADOS.NOTA_DEPORTIVA_INVALIDA, `Nota Deportiva ${pp.motivo}.`));
    const pw = parsearCasos(f.casos); if (pw.ok) out.casos_whatsapp = pw.valor; else errores.push(issue(ESTADOS.CASOS_INVALIDO, `Casos por WhatsApp: ${pw.motivo}.`));

    out.errores = errores; out.advertencias = advertencias; out.conflictos = []; out.acciones_futuras = [];
    // Llave del rodeo: solo si están los tres componentes duros (fecha, asociación, tipo)
    out._clave = out.fecha && out.asociacion.id && out.tipo.id ? `${out.fecha}|${norm(out.club)}|${out.asociacion.id}|${out.tipo.id}` : null;
    return out;
}

// ── Agrupación por rodeo y consistencia dentro del archivo ───────────────
function agruparYValidarArchivo(filas) {
    const grupos = new Map();
    for (const f of filas) {
        if (!f._clave) continue;
        if (!grupos.has(f._clave)) grupos.set(f._clave, []);
        grupos.get(f._clave).push(f);
    }
    for (const [, miembros] of grupos) {
        // Duplicado exacto: mismo rodeo + mismo jurado
        const porJurado = new Map();
        miembros.forEach(m => { const k = m.jurado.id || `nombre:${norm(m.jurado.excel)}`; if (!porJurado.has(k)) porJurado.set(k, []); porJurado.get(k).push(m); });
        for (const [, rep] of porJurado) {
            if (rep.length > 1) rep.forEach(m => m.errores.push(issue(ESTADOS.DUPLICADO_ARCHIVO, `El jurado ${m.jurado.nombre || m.jurado.excel} aparece ${rep.length} veces para este mismo rodeo (filas ${rep.map(x => x.fila).join(', ')}).`)));
        }
        // Notas por rodeo (Delegado, Comisión): deben coincidir entre filas; vacío junto a un valor = complemento (advertencia)
        const revisarNota = (clave, codigo, etiqueta) => {
            const valores = [...new Set(miembros.map(m => m.notas[clave]).filter(v => v !== null).map(v => v.toFixed(2)))];
            if (valores.length > 1) miembros.forEach(m => m.conflictos.push(issue(codigo, `${etiqueta} distinta entre filas del mismo rodeo (${valores.join(' / ')}); es una nota por rodeo. Filas ${miembros.map(x => x.fila).join(', ')}.`)));
            else if (valores.length === 1 && miembros.some(m => m.notas[clave] === null)) miembros.filter(m => m.notas[clave] === null).forEach(m => m.advertencias.push(issue('ADVERTENCIA', `${etiqueta} informada en otra fila del mismo rodeo (${valores[0]}); esta fila la trae vacía.`)));
        };
        revisarNota('delegado', ESTADOS.CONFLICTO_DELEGADO_ARCHIVO, 'Nota Delegado');
        revisarNota('comision', ESTADOS.CONFLICTO_COMISION_ARCHIVO, 'Nota Comisión');
        // Casos por WhatsApp (por rodeo; vacío = 0)
        const casos = [...new Set(miembros.map(m => m.casos_whatsapp))];
        if (casos.length > 1) miembros.forEach(m => m.conflictos.push(issue(ESTADOS.CONFLICTO_CASOS_ARCHIVO, `Casos por WhatsApp distinto entre filas del mismo rodeo (${casos.join(' / ')}); es un dato por rodeo.`)));
        // Datos del mismo rodeo que deben coincidir (categoría)
        const cats = [...new Set(miembros.map(m => m.categoria.nombre).filter(Boolean).map(norm))];
        if (cats.length > 1) miembros.forEach(m => m.conflictos.push(issue(ESTADOS.CONFLICTO_DATOS_RODEO, `La categoría del rodeo difiere entre filas del mismo rodeo (${[...new Set(miembros.map(x => x.categoria.nombre))].join(' / ')}).`)));
    }
    return grupos;
}

// ── Comparación contra la base (rodeos existentes) ───────────────────────
function indexarExistentes(existentes, indAsoc, normClub = norm) {
    const rodeos = (existentes.rodeos || []).filter(r => r.estado !== 'anulado');
    const asignPorRodeo = new Map(), notaSecPorRodeo = new Map(), evalPorRodeo = new Map(), notaPorAsig = new Map();
    (existentes.asignaciones || []).forEach(a => { if (!asignPorRodeo.has(a.rodeo_id)) asignPorRodeo.set(a.rodeo_id, []); asignPorRodeo.get(a.rodeo_id).push(a); });
    (existentes.notasSecundarias || []).forEach(n => notaSecPorRodeo.set(n.rodeo_id, n));
    (existentes.evaluaciones || []).forEach(e => { const p = evalPorRodeo.get(e.rodeo_id); if (!p || (p.anulada && !e.anulada)) evalPorRodeo.set(e.rodeo_id, e); });
    (existentes.notasRodeo || []).forEach(n => notaPorAsig.set(n.asignacion_id, n));
    const buscar = (fecha, club, asociacionId, tipoId) => rodeos.filter(r => {
        if (r.fecha !== fecha || r.tipo_rodeo_id !== tipoId || normClub(r.club) !== normClub(club)) return false;
        const ra = resolverAsociacion(r.asociacion, indAsoc);
        return ra.estado === 'OK' && ra.asociacion.id === asociacionId;
    });
    return { buscar, asignPorRodeo, notaSecPorRodeo, evalPorRodeo, notaPorAsig };
}

function num(v) { return v === null || v === undefined ? null : Number(v); }

function compararConBase(grupos, ex) {
    const infoRodeos = [];
    for (const [clave, miembros] of grupos) {
        const p = miembros[0];
        const encontrados = ex.buscar(p.fecha, p.club, p.asociacion.id, p.tipo.id);
        const info = {
            clave, fecha: p.fecha, club: p.club, asociacion: p.asociacion.canonica, tipo: p.tipo.nombre, categoria: p.categoria.nombre,
            jurados: miembros.map(m => m.jurado.nombre || m.jurado.excel),
            estado: encontrados.length === 0 ? 'NUEVO' : encontrados.length === 1 ? 'EXISTENTE' : 'AMBIGUO',
            rodeo_id: encontrados.length === 1 ? encontrados[0].id : null,
            nota_delegado: null, nota_comision: null, casos_whatsapp: null, evaluacion: null, filas: miembros.map(m => m.fila)
        };
        info.nota_delegado = miembros.map(m => m.notas.delegado).find(v => v !== null) ?? null;
        info.nota_comision = miembros.map(m => m.notas.comision).find(v => v !== null) ?? null;
        info.casos_whatsapp = miembros[0].casos_whatsapp;
        const hayErrorFila = miembros.some(m => m.errores.length);

        if (info.estado === 'AMBIGUO') {
            miembros.forEach(m => m.errores.push(issue(ESTADOS.ERROR, `Más de un rodeo existente coincide con este rodeo (${encontrados.map(r => r.id).join(', ')}). No se elige automáticamente.`, 'grupo')));
        }
        const existente = encontrados.length === 1 ? encontrados[0] : null;
        const secundaria = existente ? ex.notaSecPorRodeo.get(existente.id) : null;
        const evExistente = existente ? ex.evalPorRodeo.get(existente.id) : null;

        // Categoría del rodeo existente distinta a la del Excel: solo advertencia
        if (existente && p.categoria.nombre && existente.categoria_rodeo_nombre && norm(existente.categoria_rodeo_nombre) !== norm(p.categoria.nombre)) {
            miembros.forEach(m => m.advertencias.push(issue('ADVERTENCIA', `El rodeo existente tiene categoría ${existente.categoria_rodeo_nombre}; el Excel indica ${p.categoria.nombre}.`)));
        }

        // Evaluación / Casos por WhatsApp (dato por rodeo)
        const casos = info.casos_whatsapp;
        if (info.estado === 'AMBIGUO') info.evaluacion = { estado: 'INDETERMINADA' };
        else if (evExistente) {
            info.evaluacion = { estado: 'EXISTENTE', id: evExistente.id, casos_whatsapp_actual: num(evExistente.casos_whatsapp), estado_evaluacion: evExistente.estado, anulada: !!evExistente.anulada };
            if (num(evExistente.casos_whatsapp) === casos) info.evaluacion.comparacion = ESTADOS.YA_REGISTRADO;
            else { info.evaluacion.comparacion = ESTADOS.CONFLICTO_CASOS; }
        } else if (casos > 0) info.evaluacion = { estado: 'REQUERIDA', casos_whatsapp_excel: casos };
        else info.evaluacion = { estado: 'NO_NECESARIA' };

        // Delegado / Comisión (rodeo_notas_secundarias)
        const cmp = (excel, existenteVal) => {
            if (excel === null) return 'SIN_DATO_EXCEL';
            if (!existente) return 'NUEVO';
            if (existenteVal === null || existenteVal === undefined) return 'FALTANTE';
            return notasIguales(excel, existenteVal) ? 'IGUAL' : 'CONFLICTO';
        };
        info.delegado_comparacion = cmp(info.nota_delegado, secundaria ? num(secundaria.nota_delegado) : null);
        info.comision_comparacion = cmp(info.nota_comision, secundaria ? num(secundaria.nota_comision) : null);
        info.delegado_actual = secundaria ? num(secundaria.nota_delegado) : null;
        info.comision_actual = secundaria ? num(secundaria.nota_comision) : null;

        // Por fila (jurado)
        for (const m of miembros) {
            m.rodeo = { clave, estado: info.estado, id: info.rodeo_id };
            m.evaluacion = { ...info.evaluacion };
            if (info.estado === 'NUEVO') {
                m.asignacion = { estado: 'NUEVA', id: null };
                m.acciones_futuras.push('CREAR RODEO (origen importado, temporada seleccionada)');
            } else if (info.estado === 'EXISTENTE') {
                const asigs = (ex.asignPorRodeo.get(existente.id) || []).filter(a => m.jurado.id && a.usuario_pagado_id === m.jurado.id);
                const vigente = asigs.find(a => a.estado !== 'anulado');
                if (vigente) {
                    m.asignacion = { estado: 'EXISTENTE', id: vigente.id, estado_designacion: vigente.estado_designacion };
                    if (vigente.estado_designacion === 'rechazado') m.advertencias.push(issue('ADVERTENCIA', 'La asignación existente figura como rechazada.'));
                } else {
                    m.asignacion = { estado: 'NUEVA', id: null };
                    if (asigs.length) m.advertencias.push(issue('ADVERTENCIA', 'Existe una asignación anulada de este jurado en el rodeo; se crearía una nueva.'));
                }
            } else m.asignacion = { estado: 'INDETERMINADA', id: null };

            if (m.asignacion.estado === 'NUEVA') m.acciones_futuras.push('CREAR ASIGNACIÓN (estado activo, designación aceptada, no publicada, pago $0)');

            // Nota deportiva (notas_rodeo por asignación)
            const notaEx = m.asignacion.estado === 'EXISTENTE' ? ex.notaPorAsig.get(m.asignacion.id) : null;
            m.nota_deportiva_comparacion = m.notas.deportiva === null ? 'SIN_DATO_EXCEL'
                : m.asignacion.estado !== 'EXISTENTE' ? 'NUEVA'
                : !notaEx ? 'FALTANTE' : notasIguales(m.notas.deportiva, notaEx.nota) ? 'IGUAL' : 'CONFLICTO';
            m.nota_deportiva_actual = notaEx ? num(notaEx.nota) : null;
            if (m.nota_deportiva_comparacion === 'CONFLICTO') m.conflictos.push(issue(ESTADOS.CONFLICTO_DEPORTIVA, `Nota Deportiva existente: ${notaEx.nota} / Excel: ${m.notas.deportiva}.`));
            if (['NUEVA', 'FALTANTE'].includes(m.nota_deportiva_comparacion)) m.acciones_futuras.push('CREAR NOTA DEPORTIVA (notas_rodeo, por asignación)');

            // Delegado / Comisión (por rodeo)
            for (const [campo, cod, etiq, comp, actual, excel] of [['delegado', ESTADOS.CONFLICTO_DELEGADO, 'Nota Delegado', info.delegado_comparacion, info.delegado_actual, info.nota_delegado], ['comision', ESTADOS.CONFLICTO_COMISION, 'Nota Comisión', info.comision_comparacion, info.comision_actual, info.nota_comision]]) {
                if (comp === 'CONFLICTO') m.conflictos.push(issue(cod, `${etiq} existente: ${actual} / Excel: ${excel}.`));
                if (['NUEVO', 'FALTANTE'].includes(comp) && !m.acciones_futuras.includes(`CARGAR ${etiq.toUpperCase()} (rodeo_notas_secundarias, por rodeo)`)) m.acciones_futuras.push(`CARGAR ${etiq.toUpperCase()} (rodeo_notas_secundarias, por rodeo)`);
            }

            // Evaluación / casos
            if (info.evaluacion.estado === 'EXISTENTE' && info.evaluacion.comparacion === ESTADOS.CONFLICTO_CASOS) {
                m.conflictos.push(issue(ESTADOS.CONFLICTO_CASOS, `Casos por WhatsApp existente: ${info.evaluacion.casos_whatsapp_actual}${info.evaluacion.casos_whatsapp_actual === 0 ? ' (valor por defecto)' : ''} / Excel: ${casos}. No se sobrescribe sin decisión.`));
            }
            if (info.evaluacion.estado === 'REQUERIDA') m.acciones_futuras.push('REGISTRAR CASOS POR WHATSAPP (requiere crear una evaluación histórica; decisión pendiente)');
        }
        info.hay_error = hayErrorFila || miembros.some(m => m.errores.length);
        infoRodeos.push(info);
    }
    return infoRodeos;
}

// ── Estado primario y etiquetas de cada fila ─────────────────────────────
const PRIORIDAD_ERRORES = [ESTADOS.TEMPORADA_NO_COINCIDE, ESTADOS.FECHA_INVALIDA, ESTADOS.FECHA_FUERA, ESTADOS.ASOC_NO_ENCONTRADA, ESTADOS.ASOC_AMBIGUA, ESTADOS.TIPO_NO_ENCONTRADO, ESTADOS.TIPO_AMBIGUO, ESTADOS.CATEGORIA_INVALIDA, ESTADOS.JURADO_NO_ENCONTRADO, ESTADOS.JURADO_AMBIGUO, ESTADOS.NOTA_DELEGADO_INVALIDA, ESTADOS.NOTA_COMISION_INVALIDA, ESTADOS.NOTA_DEPORTIVA_INVALIDA, ESTADOS.CASOS_INVALIDO, ESTADOS.DUPLICADO_ARCHIVO, ESTADOS.ERROR];

function cerrarFila(f) {
    const primero = (lista) => { for (const c of PRIORIDAD_ERRORES) if (lista.some(x => x.codigo === c)) return c; return lista[0].codigo; };
    const etiquetas = [];
    if (f.rodeo) etiquetas.push(f.rodeo.estado === 'EXISTENTE' ? ESTADOS.RODEO_YA_EXISTE : null);
    if (f.asignacion) etiquetas.push(f.asignacion.estado === 'NUEVA' ? ESTADOS.JURADO_A_ASOCIAR : f.asignacion.estado === 'EXISTENTE' ? ESTADOS.JURADO_YA_ASOCIADO : null);
    if (f.evaluacion) etiquetas.push(f.evaluacion.estado === 'EXISTENTE' ? ESTADOS.EVALUACION_EXISTENTE : f.evaluacion.estado === 'REQUERIDA' ? ESTADOS.EVALUACION_REQUERIDA : null);
    f.etiquetas = etiquetas.filter(Boolean);

    if (f.errores.length) { f.estado = primero(f.errores); f.severidad = 'ERROR'; }
    else if (f.conflictos.length) { f.estado = f.conflictos[0].codigo; f.severidad = 'CONFLICTO'; }
    else if (!f.rodeo) { f.estado = ESTADOS.ERROR; f.severidad = 'ERROR'; }
    else if (f.rodeo.estado === 'NUEVO') { f.estado = ESTADOS.LISTO; f.severidad = f.advertencias.length ? 'ADVERTENCIA' : 'LISTO'; }
    else if (f.acciones_futuras.length) { f.estado = ESTADOS.RODEO_EXISTE_FALTANTES; f.severidad = f.advertencias.length ? 'ADVERTENCIA' : 'LISTO'; }
    else { f.estado = ESTADOS.RODEO_YA_EXISTE; f.severidad = f.advertencias.length ? 'ADVERTENCIA' : 'SIN_CAMBIOS'; }
    if (f.severidad !== 'ERROR' && f.severidad !== 'CONFLICTO' && f.rodeo && f.rodeo.estado === 'EXISTENTE' && !f.acciones_futuras.length) f.etiquetas.push(ESTADOS.YA_REGISTRADO);
    return f;
}

// ── Bloqueos, plan de escritura y payload de la RPC (PUROS: no escriben) ─────────
// Regla: un problema estructural compartido bloquea TODO el rodeo (grupo); un problema del jurado bloquea solo esa fila.
// Los conflictos contra la BD no bloquean. La confirmación usa exactamente este mismo cálculo.
function clasificarBloqueos(procesadas, grupos) {
    const motivoGrupo = new Map();
    for (const [clave, miembros] of grupos) {
        const razones = [];
        for (const m of miembros) for (const i of [...m.errores, ...m.conflictos]) if (alcanceDe(i) === 'grupo' && i.codigo !== ESTADOS.CONFLICTO_DELEGADO && i.codigo !== ESTADOS.CONFLICTO_COMISION && i.codigo !== ESTADOS.CONFLICTO_DEPORTIVA && i.codigo !== ESTADOS.CONFLICTO_CASOS) razones.push(`fila ${m.fila}: ${i.codigo}`);
        if (razones.length) motivoGrupo.set(clave, razones);
    }
    for (const f of procesadas) {
        const erroresFila = f.errores.filter(i => alcanceDe(i) === 'fila');
        if (!f._clave) { f.bloqueo = 'FILA'; f.motivo_bloqueo = 'No se puede identificar el rodeo (fecha, asociación o tipo inválidos).'; }
        else if (motivoGrupo.has(f._clave)) { f.bloqueo = 'GRUPO'; f.motivo_bloqueo = `Rodeo bloqueado por un problema compartido (${motivoGrupo.get(f._clave).join('; ')}).`; }
        else if (erroresFila.length) { f.bloqueo = 'FILA'; f.motivo_bloqueo = 'Esta fila/jurado no se importará; el resto del rodeo sí.'; }
        else { f.bloqueo = null; f.motivo_bloqueo = null; }
        f.importable = f.bloqueo === null;
    }
    return motivoGrupo;
}

function variantesAsociacion(asocId, catalogos, rodeosExistentes, indAsoc) {
    const set = new Set();
    const a = (catalogos.asociaciones || []).find(x => x.id === asocId);
    if (a) set.add(a.nombre);
    (catalogos.alias || []).filter(al => al.asociacion_id === asocId).forEach(al => set.add(al.alias));
    for (const r of rodeosExistentes || []) {
        if (!r.asociacion || set.has(r.asociacion)) continue;
        const ra = resolverAsociacion(r.asociacion, indAsoc);
        if (ra.estado === 'OK' && ra.asociacion.id === asocId) set.add(r.asociacion);
    }
    return [...set];
}

function construirPlan(procesadas, grupos, rodeos, catalogos, existentes, indAsoc) {
    const gruposEscribibles = [];      // payload para la RPC
    const info = new Map(rodeos.map(r => [r.clave, r]));
    const plan = {
        rodeos_a_crear: 0, rodeos_a_reutilizar: 0, rodeos_omitidos: 0,
        asignaciones_a_crear: 0, asignaciones_existentes: 0,
        notas_delegado_a_cargar: 0, notas_comision_a_cargar: 0, notas_deportivas_a_cargar: 0,
        casos_whatsapp_a_cargar: 0, evaluaciones_historicas_a_crear: 0,
        conflictos_no_sobrescritos: 0, conflictos_detalle: { nota_delegado: 0, nota_comision: 0, nota_deportiva: 0, casos_whatsapp: 0 },
        filas_omitidas: 0, filas_con_error: 0, pagos_historicos: 0, hay_acciones: false
    };
    for (const [clave, miembros] of grupos) {
        const ri = info.get(clave);
        const importables = miembros.filter(m => m.importable);
        if (importables.length === 0) { plan.rodeos_omitidos++; continue; }
        const p = miembros[0];
        const club = p.club;
        gruposEscribibles.push({
            clave, fecha: p.fecha, club, club_norm: norm(club),
            asociacion_id: p.asociacion.id, asociacion_variantes: variantesAsociacion(p.asociacion.id, catalogos, existentes.rodeos, indAsoc),
            tipo_rodeo_id: p.tipo.id, categoria_rodeo_id: p.categoria.id || null,
            nota_delegado: ri.nota_delegado, nota_comision: ri.nota_comision, casos_whatsapp: ri.casos_whatsapp,
            filas: importables.map(m => ({ fila: m.fila, jurado: m.jurado.nombre, usuario_pagado_id: m.jurado.id, nota_deportiva: m.notas.deportiva }))
        });
        if (ri.estado === 'NUEVO') plan.rodeos_a_crear++; else plan.rodeos_a_reutilizar++;
        if (['NUEVO', 'FALTANTE'].includes(ri.delegado_comparacion) && ri.nota_delegado !== null) plan.notas_delegado_a_cargar++;
        if (['NUEVO', 'FALTANTE'].includes(ri.comision_comparacion) && ri.nota_comision !== null) plan.notas_comision_a_cargar++;
        if (ri.delegado_comparacion === 'CONFLICTO') plan.conflictos_detalle.nota_delegado++;
        if (ri.comision_comparacion === 'CONFLICTO') plan.conflictos_detalle.nota_comision++;
        if (ri.evaluacion && ri.evaluacion.estado === 'REQUERIDA') { plan.evaluaciones_historicas_a_crear++; plan.casos_whatsapp_a_cargar++; }
        if (ri.evaluacion && ri.evaluacion.comparacion === ESTADOS.CONFLICTO_CASOS) plan.conflictos_detalle.casos_whatsapp++;
        for (const m of importables) {
            if (m.asignacion && m.asignacion.estado === 'NUEVA') plan.asignaciones_a_crear++; else if (m.asignacion && m.asignacion.estado === 'EXISTENTE') plan.asignaciones_existentes++;
            if (m.notas.deportiva !== null && ['NUEVA', 'FALTANTE'].includes(m.nota_deportiva_comparacion)) plan.notas_deportivas_a_cargar++;
            if (m.nota_deportiva_comparacion === 'CONFLICTO') plan.conflictos_detalle.nota_deportiva++;
        }
    }
    plan.conflictos_no_sobrescritos = Object.values(plan.conflictos_detalle).reduce((a, b) => a + b, 0);
    plan.filas_omitidas = procesadas.filter(f => !f.importable).length;
    plan.filas_con_error = procesadas.filter(f => f.errores.length).length;
    plan.hay_acciones = plan.rodeos_a_crear + plan.asignaciones_a_crear + plan.notas_delegado_a_cargar + plan.notas_comision_a_cargar + plan.notas_deportivas_a_cargar + plan.evaluaciones_historicas_a_crear > 0;
    return { plan, gruposEscribibles };
}

// ── Preview completo (puro: recibe catálogos y existentes ya cargados) ───
function construirPreview({ filas, nombreArchivo, temporada, catalogos, existentes = {}, sha256 = null }) {
    const rango = { ...TEMPORADAS_HISTORICAS[temporada.nombre] };
    const indAsoc = indexarAsociaciones(catalogos.asociaciones, catalogos.alias);
    const indJur = indexarJurados(catalogos.jurados);
    const ctx = { temporada, rango, indAsoc, tipos: catalogos.tipos || [], categorias: catalogos.categorias || [], indJur };

    const procesadas = filas.map(f => procesarFila(f, ctx));
    const grupos = agruparYValidarArchivo(procesadas);
    const rodeos = compararConBase(grupos, indexarExistentes(existentes, indAsoc));
    procesadas.forEach(f => { if (!f._clave) { f.rodeo = null; f.asignacion = null; f.evaluacion = { estado: 'INDETERMINADA' }; } cerrarFila(f); });
    clasificarBloqueos(procesadas, grupos);
    const { plan, gruposEscribibles } = construirPlan(procesadas, grupos, rodeos, catalogos, existentes, indAsoc);

    const importable = f => f.errores.length === 0 && f.conflictos.length === 0;
    const filasImportables = procesadas.filter(importable);
    const gruposImportables = rodeos.filter(r => grupos.get(r.clave).every(importable));
    const uniq = (arr) => new Set(arr).size;
    const notasNuevas = (campo) => gruposImportables.filter(r => r[`nota_${campo}`] !== null && ['NUEVO', 'FALTANTE'].includes(r[`${campo}_comparacion`])).length;

    const resumen = {
        archivo: nombreArchivo,
        temporada_seleccionada: temporada.nombre,
        filas_excel: procesadas.length,
        rodeos_unicos: rodeos.length,
        rodeos_nuevos: rodeos.filter(r => r.estado === 'NUEVO').length,
        rodeos_existentes: rodeos.filter(r => r.estado === 'EXISTENTE').length,
        rodeos_no_identificables: procesadas.filter(f => !f._clave).length,
        jurados_encontrados: uniq(procesadas.filter(f => f.jurado.id).map(f => f.jurado.id)),
        jurados_a_relacionar: filasImportables.filter(f => f.asignacion && f.asignacion.estado === 'NUEVA').length,
        jurados_ya_relacionados: procesadas.filter(f => f.asignacion && f.asignacion.estado === 'EXISTENTE').length,
        jurados_no_encontrados: procesadas.filter(f => f.errores.some(e => e.codigo === ESTADOS.JURADO_NO_ENCONTRADO)).length,
        jurados_ambiguos: procesadas.filter(f => f.errores.some(e => e.codigo === ESTADOS.JURADO_AMBIGUO)).length,
        notas_delegado_nuevas: notasNuevas('delegado'),
        notas_comision_nuevas: notasNuevas('comision'),
        notas_deportivas_nuevas: filasImportables.filter(f => f.notas.deportiva !== null && ['NUEVA', 'FALTANTE'].includes(f.nota_deportiva_comparacion)).length,
        casos_whatsapp_informados: gruposImportables.filter(r => r.casos_whatsapp > 0).length,
        casos_whatsapp_total: gruposImportables.reduce((s, r) => s + r.casos_whatsapp, 0),
        evaluaciones_existentes: rodeos.filter(r => r.evaluacion && r.evaluacion.estado === 'EXISTENTE').length,
        evaluaciones_requeridas_casos_whatsapp: gruposImportables.filter(r => r.evaluacion && r.evaluacion.estado === 'REQUERIDA').length,
        filas_listas: procesadas.filter(f => f.severidad === 'LISTO' || (f.severidad === 'ADVERTENCIA' && importable(f) && f.estado !== ESTADOS.RODEO_YA_EXISTE)).length,
        filas_sin_cambios: procesadas.filter(f => importable(f) && f.estado === ESTADOS.RODEO_YA_EXISTE).length,
        filas_con_advertencias: procesadas.filter(f => f.advertencias.length).length,
        filas_con_errores: procesadas.filter(f => f.errores.length).length,
        filas_con_conflictos: procesadas.filter(f => f.conflictos.length && !f.errores.length).length,
        pago_futuro_historico: 0
    };

    const limpiar = ({ _clave, ...resto }) => resto;
    const preview = {
        modo: 'VISTA_PREVIA',
        escribe_base_de_datos: false,
        puede_confirmar: plan.hay_acciones,
        mensaje_confirmacion: plan.hay_acciones ? 'La vista previa no modificó la base de datos. Use CONFIRMAR IMPORTACIÓN para ejecutar la importación.' : 'No hay acciones importables en este archivo.',
        sha256,
        temporada: { id: temporada.id, nombre: temporada.nombre, fecha_inicio: temporada.fecha_inicio, fecha_fin: temporada.fecha_fin },
        periodo_permitido: rango,
        criterios: {
            nota_deportiva: 'Nota individual del jurado → notas_rodeo.nota (por asignación). No usa evaluaciones.nota_final.',
            nota_delegado_comision: 'Notas por rodeo → rodeo_notas_secundarias.',
            casos_whatsapp: 'Dato por rodeo → evaluaciones.casos_whatsapp. Con casos > 0 y sin evaluación se crearía una evaluación histórica mínima (marcada como histórica, estado cerrado, sin ciclos; no cuenta como evaluación deportiva y se convierte en normal si luego se crea una). Con 0 no se crea nada.',
            asignacion_historica_futura: { estado: 'activo', estado_designacion: 'aceptado', publicado: false, pago_base_calculado: 0 },
            categoria_jurado: 'Categoría actual del jurado (no se reconstruye la histórica).'
        },
        resumen,
        plan,
        rodeos,
        filas: procesadas.map(limpiar)
    };
    // Payload de la RPC: interno (no se serializa; el navegador nunca lo envía ni lo recibe).
    Object.defineProperty(preview, '_payload', { value: gruposEscribibles, enumerable: false });
    return preview;
}

// ── Carga desde la base (SOLO SELECT) ────────────────────────────────────
async function cargarTemporada(db, temporadaId) {
    const { data, error } = await db.from('temporadas').select('id, nombre, fecha_inicio, fecha_fin, activa').eq('id', temporadaId).maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
}

async function cargarCatalogos(db) {
    const [asociaciones, alias, tipos, categorias, jurados] = await Promise.all([
        leerPaginado((d, h) => db.from('asociaciones').select('id, nombre, nombre_normalizado, activa').range(d, h)),
        leerPaginado((d, h) => db.from('asociacion_alias').select('asociacion_id, alias, alias_normalizado').range(d, h)),
        leerPaginado((d, h) => db.from('tipos_rodeo').select('id, nombre, duracion_dias, categoria_rodeo_id, activo').eq('activo', true).range(d, h)),
        leerPaginado((d, h) => db.from('categorias_rodeo').select('id, nombre, activo').range(d, h)),
        leerPaginado((d, h) => db.from('usuarios_pagados').select('id, nombre_completo, categoria, activo, estado_usuario, es_prueba, tipo_persona').eq('tipo_persona', 'jurado').range(d, h))
    ]);
    return { asociaciones, alias, tipos, categorias, jurados };
}

async function cargarExistentes(db, filasProcesadas) {
    const fechas = filasProcesadas.map(f => f.fecha).filter(Boolean).sort();
    if (!fechas.length) return {};
    const desde = fechas[0], hasta = fechas[fechas.length - 1];
    const rodeos = await leerPaginado((d, h) => db.from('rodeos').select('id, club, asociacion, fecha, tipo_rodeo_id, categoria_rodeo_nombre, estado, temporada_id').gte('fecha', desde).lte('fecha', hasta).neq('estado', 'anulado').order('fecha', { ascending: true }).order('id', { ascending: true }).range(d, h));
    const ids = rodeos.map(r => r.id);
    const asignaciones = await leerPorLotes(ids, lote => db.from('asignaciones').select('id, rodeo_id, usuario_pagado_id, tipo_persona, estado, estado_designacion').in('rodeo_id', lote).eq('tipo_persona', 'jurado'));
    const [notasSecundarias, evaluaciones, notasRodeo] = await Promise.all([
        leerPorLotes(ids, lote => db.from('rodeo_notas_secundarias').select('rodeo_id, nota_comision, nota_delegado').in('rodeo_id', lote)),
        leerPorLotes(ids, lote => db.from('evaluaciones').select('id, rodeo_id, estado, casos_whatsapp, anulada').in('rodeo_id', lote)),
        leerPorLotes(asignaciones.map(a => a.id), lote => db.from('notas_rodeo').select('asignacion_id, nota').in('asignacion_id', lote))
    ]);
    return { rodeos, asignaciones, notasSecundarias, evaluaciones, notasRodeo };
}

function sha256Buffer(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

// Orquestador: SOLO lectura. Devuelve la vista previa o lanza ErrorArchivo (400).
async function generarPreview({ buffer, nombreArchivo, temporadaId }, db) {
    if (!temporadaId) throw new ErrorArchivo('TEMPORADA_REQUERIDA', 'Debe seleccionar la temporada a importar.');
    const temporada = await cargarTemporada(db, temporadaId);
    if (!temporada) throw new ErrorArchivo('TEMPORADA_INEXISTENTE', 'La temporada seleccionada no existe. Las temporadas no se crean automáticamente.');
    if (!TEMPORADAS_HISTORICAS[temporada.nombre]) throw new ErrorArchivo('TEMPORADA_NO_HABILITADA', `La temporada ${temporada.nombre} no está habilitada para importación histórica (habilitadas: ${Object.keys(TEMPORADAS_HISTORICAS).join(', ')}).`);

    const { filas } = leerExcel(buffer);
    if (filas.length === 0) throw new ErrorArchivo('SIN_FILAS', 'La hoja CARGA_HISTORICA no tiene filas de datos.');

    const catalogos = await cargarCatalogos(db);
    // Primera pasada solo para conocer las fechas y consultar los rodeos existentes del rango
    const rango = TEMPORADAS_HISTORICAS[temporada.nombre];
    const previas = filas.map(f => ({ fecha: (parsearFecha(f.fecha).iso) || null })).filter(f => f.fecha && f.fecha >= rango.desde && f.fecha <= rango.hasta);
    const existentes = await cargarExistentes(db, previas);
    return construirPreview({ filas, nombreArchivo, temporada, catalogos, existentes, sha256: sha256Buffer(buffer) });
}

// Temporadas existentes que están habilitadas para importación histórica (para el selector)
async function temporadasHabilitadas(db) {
    const { data, error } = await db.from('temporadas').select('id, nombre, fecha_inicio, fecha_fin, activa').order('fecha_inicio', { ascending: false });
    if (error) throw new Error(error.message);
    return {
        temporadas: (data || []).filter(t => TEMPORADAS_HISTORICAS[t.nombre]).map(t => ({ ...t, periodo_permitido: TEMPORADAS_HISTORICAS[t.nombre] })),
        habilitadas: Object.entries(TEMPORADAS_HISTORICAS).map(([nombre, r]) => ({ nombre, ...r })),
        existentes_sin_habilitar: (data || []).filter(t => !TEMPORADAS_HISTORICAS[t.nombre]).map(t => t.nombre)
    };
}

module.exports = {
    HOJA, ENCABEZADOS, ESTADOS, TEMPORADAS_HISTORICAS, ErrorArchivo,
    parsearFecha, parsearNota, parsearCasos, leerExcel,
    indexarAsociaciones, resolverAsociacion, resolverTipo, resolverCategoria, indexarJurados, resolverJurado,
    construirPreview, generarPreview, temporadasHabilitadas, sha256Buffer, norm
};
