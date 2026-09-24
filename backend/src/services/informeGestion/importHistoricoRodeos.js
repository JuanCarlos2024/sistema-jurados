// ═════════════════════════════════════════════════════════════════════════
// Histórico de rodeos por temporada — PREVIEW e importación idempotente.
//
// Fuente: hoja "Hoja1" de "RESUMEN DE RODEOS POR TEMPORADA 2025-2026.xlsx"
// (Club, Asociación, Temporada, Fecha Rodeo, Tipo Rodeo, CATEGORIA).
//
// Reglas:
//  · Fecha: serial de Excel o ISO. Texto "d/m/aa" es AMBIGUO (no se adivina)
//    → ERROR. (parsearFecha() del importador de rodeos está tuneado a M/D/Y y
//    NO se reutiliza.)
//  · Clave de unicidad (idempotencia, NO depende solo del club):
//    temporada | fecha_rodeo | club_normalizado | asociacion_normalizada |
//    tipo_normalizado  → índice UNIQUE en historico_rodeos_temporada.
//  · Estados de fila: OK · ADVERTENCIA (importable) · ERROR · DUPLICADO ·
//    YA_IMPORTADO. Solo OK y ADVERTENCIA se importan.
// ═════════════════════════════════════════════════════════════════════════
const XLSX = require('xlsx');
const supabase = require('../../config/supabase');
const { normalizarTexto } = require('../geografia');
const { normalizarAsociacion } = require('../asociaciones');
const { construirIndiceCatalogo, resolverAsociacion } = require('./asociaciones');
const { esISO, toISO } = require('./fechasEquivalentes');

const CATEGORIAS = { primera: 'Primera', segunda: 'Segunda', tercera: 'Tercera', cuarta: 'Cuarta', especial: 'Especial' };
const FUENTE = 'RESUMEN DE RODEOS POR TEMPORADA (Excel)';

function interpretarFecha(v) {
    if (typeof v === 'number' && Number.isFinite(v)) {
        if (v < 30000 || v > 70000) return { ok: false, motivo: 'FECHA_SERIAL_FUERA_DE_RANGO' };
        return { ok: true, iso: toISO(new Date(Math.round((v - 25569) * 86400000))) };
    }
    if (typeof v === 'string' && esISO(v.trim())) return { ok: true, iso: v.trim() };
    if (typeof v === 'string' && v.trim()) return { ok: false, motivo: 'FECHA_TEXTO_AMBIGUA' };
    return { ok: false, motivo: 'FECHA_VACIA' };
}

function leerFilas(buffer) {
    let wb;
    try { wb = XLSX.read(buffer, { type: 'buffer' }); }
    catch (e) { throw new Error('No se pudo leer el archivo Excel: ' + e.message); }
    const hoja = wb.SheetNames.find(n => n.trim().toLowerCase() === 'hoja1') || wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[hoja], { header: 1, raw: true, defval: null });
    if (!rows.length) throw new Error('La hoja está vacía');
    const enc = rows[0].map(h => normalizarTexto(String(h ?? '')));
    const col = nombre => enc.findIndex(h => h === nombre);
    const idx = { club: col('club'), asociacion: col('asociacion'), temporada: col('temporada'), fecha: col('fecha rodeo'), tipo: col('tipo rodeo'), categoria: col('categoria') };
    const faltan = Object.entries(idx).filter(([, i]) => i < 0).map(([k]) => k);
    if (faltan.length) throw new Error('Faltan columnas obligatorias: ' + faltan.join(', '));
    return rows.slice(1).map((r, i) => ({
        fila: i + 2, club: r[idx.club], asociacion: r[idx.asociacion], temporada: r[idx.temporada],
        fecha: r[idx.fecha], tipo: r[idx.tipo], categoria: r[idx.categoria]
    })).filter(f => [f.club, f.asociacion, f.fecha, f.tipo].some(x => x !== null && x !== ''));
}

const limpiar = v => String(v ?? '').replace(/\s+/g, ' ').trim();

// opciones: { catalogo, alias, tiposCatalogo:[nombres], ventana:{inicio,fin}, temporadaEsperada, clavesExistentes:Set }
function previewHistoricoRodeos(buffer, opciones = {}) {
    const { catalogo = [], alias = [], tiposCatalogo = [], ventana = null, temporadaEsperada = null, clavesExistentes = new Set() } = opciones;
    const indice = construirIndiceCatalogo(catalogo, alias);
    const catalogoDisponible = catalogo.length > 0;
    const tiposConocidos = new Set(tiposCatalogo.map(t => normalizarTexto(t)));
    const vistas = new Set();
    const filas = [];

    for (const f of leerFilas(buffer)) {
        const errores = [], advertencias = [];
        const club = limpiar(f.club), asociacion = limpiar(f.asociacion), temporada = limpiar(f.temporada);
        let tipo = limpiar(f.tipo);
        const fecha = interpretarFecha(f.fecha);
        if (!fecha.ok) errores.push(fecha.motivo);
        if (!club) errores.push('CLUB_VACIO');
        if (!asociacion) errores.push('ASOCIACION_VACIA');
        if (!tipo) errores.push('TIPO_VACIO');
        if (!/^\d{4}-\d{4}$/.test(temporada)) errores.push('TEMPORADA_INVALIDA');
        else if (temporadaEsperada && temporada !== temporadaEsperada) advertencias.push('TEMPORADA_DISTINTA_A_LA_ESPERADA');

        const catNorm = normalizarTexto(limpiar(f.categoria));
        const categoria = CATEGORIAS[catNorm] || null;
        if (!categoria) errores.push('CATEGORIA_NO_RECONOCIDA');

        // Sufijo "null": solo se normaliza si, sin él, existe UNA coincidencia inequívoca en el
        // catálogo real de tipos_rodeo. Si hay 0 o >1, se conserva el texto original y se informa.
        if (/\bnull$/i.test(tipo)) {
            const sinNull = normalizarTexto(tipo.replace(/\s*null$/i, ''));
            const coincidencias = tiposCatalogo.filter(t => normalizarTexto(t) === sinNull);
            if (coincidencias.length === 1) { advertencias.push('TIPO_CON_SUFIJO_NULL', 'TIPO_NORMALIZADO_POR_COINCIDENCIA_UNICA'); tipo = coincidencias[0]; }
            else advertencias.push('TIPO_CON_SUFIJO_NULL', coincidencias.length > 1 ? 'TIPO_SUFIJO_NULL_AMBIGUO' : 'TIPO_SUFIJO_NULL_SIN_COINCIDENCIA_UNICA');
        }
        const tipoNorm = normalizarTexto(tipo);
        if (tipo && tiposConocidos.size && !tiposConocidos.has(tipoNorm)) advertencias.push('TIPO_NO_RECONOCIDO');

        const asocNorm = normalizarAsociacion(asociacion);
        let asociacionId = null;
        if (catalogoDisponible && asociacion) {
            const a = resolverAsociacion(asociacion, indice);
            if (a) asociacionId = a.id; else advertencias.push('ASOCIACION_SIN_CORRESPONDENCIA');
        }
        if (fecha.ok && ventana && (fecha.iso < ventana.inicio || fecha.iso > ventana.fin)) advertencias.push('FUERA_DE_TEMPORADA');

        const clubNorm = normalizarTexto(club);
        const clave = fecha.ok ? [temporada, fecha.iso, clubNorm, asocNorm, tipoNorm].join('|') : null;
        let estado;
        if (errores.length) estado = 'ERROR';
        else if (clavesExistentes.has(clave)) estado = 'YA_IMPORTADO';
        else if (vistas.has(clave)) estado = 'DUPLICADO';
        else estado = advertencias.length ? 'ADVERTENCIA' : 'OK';
        if (clave && !errores.length) vistas.add(clave);

        filas.push({
            fila: f.fila, estado, errores, advertencias, clave_unicidad: clave,
            registro: errores.length ? null : {
                temporada, fecha_rodeo: fecha.iso, club, club_normalizado: clubNorm,
                asociacion, asociacion_normalizada: asocNorm, asociacion_id: asociacionId,
                tipo_rodeo: tipo, tipo_normalizado: tipoNorm, categoria
            }
        });
    }

    const cuenta = e => filas.filter(f => f.estado === e).length;
    const conAdv = a => filas.filter(f => f.advertencias.includes(a)).length;
    const importables = filas.filter(f => f.estado === 'OK' || f.estado === 'ADVERTENCIA');
    const porCategoria = {};
    importables.forEach(f => { porCategoria[f.registro.categoria] = (porCategoria[f.registro.categoria] || 0) + 1; });
    const fechas = importables.map(f => f.registro.fecha_rodeo).sort();
    return {
        filas,
        resumen: {
            total_filas: filas.length,
            importables: importables.length,
            ok: cuenta('OK'), advertencias: cuenta('ADVERTENCIA'), errores: cuenta('ERROR'),
            duplicados_en_archivo: cuenta('DUPLICADO'), ya_importados: cuenta('YA_IMPORTADO'),
            fuera_de_temporada: conAdv('FUERA_DE_TEMPORADA'),
            tipos_no_reconocidos: conAdv('TIPO_NO_RECONOCIDO'),
            tipos_con_sufijo_null: conAdv('TIPO_CON_SUFIJO_NULL'),
            tipos_sufijo_null_normalizados: conAdv('TIPO_NORMALIZADO_POR_COINCIDENCIA_UNICA'),
            tipos_sufijo_null_sin_decidir: conAdv('TIPO_SUFIJO_NULL_AMBIGUO') + conAdv('TIPO_SUFIJO_NULL_SIN_COINCIDENCIA_UNICA'),
            asociaciones_sin_correspondencia: conAdv('ASOCIACION_SIN_CORRESPONDENCIA'),
            catalogo_asociaciones_disponible: catalogoDisponible,
            por_categoria: porCategoria,
            rango_fechas: fechas.length ? { desde: fechas[0], hasta: fechas[fechas.length - 1] } : null
        },
        aviso: 'Vista previa: no se guardó nada. Solo se importan filas OK y ADVERTENCIA; la clave de unicidad hace la importación idempotente.'
    };
}

async function contextoDeImportacion(db = supabase) {
    const leer = async (tabla, cols) => { const { data, error } = await db.from(tabla).select(cols).limit(5000); return error ? [] : (data || []); };
    const [catalogo, alias, tipos, existentes] = await Promise.all([
        leer('asociaciones', 'id, nombre, nombre_normalizado'),
        leer('asociacion_alias', 'asociacion_id, alias, alias_normalizado'),
        leer('tipos_rodeo', 'nombre'),
        leer('historico_rodeos_temporada', 'temporada, fecha_rodeo, club_normalizado, asociacion_normalizada, tipo_normalizado')
    ]);
    return {
        catalogo, alias, tiposCatalogo: tipos.map(t => t.nombre),
        clavesExistentes: new Set(existentes.map(e => [e.temporada, e.fecha_rodeo, e.club_normalizado, e.asociacion_normalizada, e.tipo_normalizado].join('|')))
    };
}

// Re-lee y revalida el archivo; inserta solo OK/ADVERTENCIA con ON CONFLICT DO NOTHING.
async function confirmarHistoricoRodeos(buffer, opciones = {}, { db = supabase, nombreArchivo = 'historico_rodeos.xlsx', actorId = null } = {}) {
    const ctx = await contextoDeImportacion(db);
    const preview = previewHistoricoRodeos(buffer, { ...ctx, ...opciones });
    const aInsertar = preview.filas.filter(f => f.estado === 'OK' || f.estado === 'ADVERTENCIA');

    const { data: imp, error: eImp } = await db.from('importaciones')
        .insert({ nombre_archivo: nombreArchivo, tipo: 'historico_rodeos', total_filas: preview.resumen.total_filas, created_by: actorId }).select().single();
    if (eImp) throw new Error('No se pudo registrar la importación: ' + eImp.message);

    let insertadas = 0;
    for (let i = 0; i < aInsertar.length; i += 200) {
        const lote = aInsertar.slice(i, i + 200).map(f => ({ ...f.registro, fuente: FUENTE, importacion_id: imp.id }));
        const { data, error } = await db.from('historico_rodeos_temporada')
            .upsert(lote, { onConflict: 'temporada,fecha_rodeo,club_normalizado,asociacion_normalizada,tipo_normalizado', ignoreDuplicates: true }).select('id');
        if (error) throw new Error('Error insertando histórico de rodeos: ' + error.message);
        insertadas += (data || []).length;
    }
    await db.from('importaciones').update({
        insertadas, pendientes: 0,
        duplicadas: preview.resumen.duplicados_en_archivo + preview.resumen.ya_importados + (aInsertar.length - insertadas),
        rechazadas: preview.resumen.errores, errores: 0
    }).eq('id', imp.id);
    return { importacion_id: imp.id, insertadas, resumen: preview.resumen };
}

module.exports = { interpretarFecha, leerFilas, previewHistoricoRodeos, contextoDeImportacion, confirmarHistoricoRodeos };
