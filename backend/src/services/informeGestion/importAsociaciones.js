// ═════════════════════════════════════════════════════════════════════════
// Catálogo de asociaciones — PREVISUALIZACIÓN / importación controlada.
//
// Fuente: hoja "Resumen" de "RESUMEN DE RODEOS POR TEMPORADA 2025-2026.xlsx"
// (filas sin sangría = asociación; con sangría = club; termina en
// "RESUMEN POR CATEGORÍA").
//
// NUNCA se siembra en silencio: el preview clasifica cada nombre y el
// confirmar solo aplica decisiones explícitas sobre nombres presentes en el
// archivo (se re-lee el archivo; no se confía en el frontend).
//
// Clasificaciones: YA_EXISTE · ALIAS_EXISTENTE · POSIBLE_COINCIDENCIA ·
// CASO_ESPECIAL · NUEVA (más DUPLICADO_EN_ARCHIVO como marca adicional).
// Sin fuzzy matching: la "posible coincidencia" compara nombres tras quitar
// palabras genéricas (de, del, la, rodeo, chileno…) — así FEDERACION ~
// FEDERACION DEL RODEO CHILENO, pero SANTIAGO ≠ SANTIAGO ORIENTE ni
// MAIPO ≠ MAIPO NORTE (asociaciones distintas, ya documentado en
// services/asociaciones.js).
// ═════════════════════════════════════════════════════════════════════════
const XLSX = require('xlsx');
const supabase = require('../../config/supabase');
const { normalizarAsociacion } = require('../asociaciones');
const { construirIndiceCatalogo } = require('./asociaciones');

const PALABRAS_GENERICAS = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'rodeo', 'chileno', 'chilena', 'asociacion', 'asociaciones', 'club', 'clubes']);
const ACCIONES = new Set(['crear', 'alias', 'omitir']);

function canonico(normalizado) {
    return normalizado.split(' ').filter(t => t && !PALABRAS_GENERICAS.has(t)).join(' ');
}
function esNombreEspecial(normalizado) { return /^federacion\b/.test(normalizado); }

function parsearResumen(buffer) {
    let wb;
    try { wb = XLSX.read(buffer, { type: 'buffer' }); }
    catch (e) { throw new Error('No se pudo leer el archivo Excel: ' + e.message); }
    const nombreHoja = wb.SheetNames.find(n => n.trim().toLowerCase() === 'resumen');
    if (!nombreHoja) throw new Error('El archivo no contiene la hoja "Resumen"');
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[nombreHoja], { header: 1, raw: true, defval: '' });
    const items = [];
    let actual = null;
    for (let i = 1; i < rows.length; i++) {
        const celda = rows[i][0];
        if (celda === null || celda === undefined || String(celda).trim() === '') continue;
        const texto = String(celda);
        if (/^\s*resumen por /i.test(texto)) break;
        if (/^\s/.test(texto)) { if (actual) actual.clubes++; continue; }
        const rodeos = Number(rows[i][2]);
        actual = { fila: i + 1, nombre: texto.trim(), clubes: 0, rodeos_historicos: Number.isFinite(rodeos) ? rodeos : null };
        items.push(actual);
    }
    if (!items.length) throw new Error('La hoja "Resumen" no contiene asociaciones reconocibles');
    return items;
}

// catalogo: [{id,nombre,nombre_normalizado,...}] · alias: [{asociacion_id,alias,alias_normalizado}]
// nombresEnUso: nombres de asociación tal como aparecen hoy en rodeos.asociacion (texto libre).
function previewAsociaciones(buffer, { catalogo = [], alias = [], nombresEnUso = [] } = {}) {
    const items = parsearResumen(buffer);
    const indice = construirIndiceCatalogo(catalogo, alias);
    const nombresCatalogo = new Set((catalogo || []).map(a => a.nombre_normalizado || normalizarAsociacion(a.nombre)));
    const vistos = new Map();
    const canonArchivo = new Map();
    items.forEach(it => {
        it.normalizado = normalizarAsociacion(it.nombre);
        canonArchivo.set(canonico(it.normalizado), [...(canonArchivo.get(canonico(it.normalizado)) || []), it]);
    });

    const filas = items.map(it => {
        const coincidencias = [];
        let clasificacion;
        const enIndice = indice.get(it.normalizado);
        if (enIndice) clasificacion = nombresCatalogo.has(it.normalizado) ? 'YA_EXISTE' : 'ALIAS_EXISTENTE';
        else if (esNombreEspecial(it.normalizado)) clasificacion = 'CASO_ESPECIAL';
        else clasificacion = 'NUEVA';

        // posibles coincidencias: mismo nombre canónico en el catálogo o en otra fila del archivo
        if (!enIndice) {
            const c = canonico(it.normalizado);
            if (c) {
                for (const a of (catalogo || [])) {
                    const n = a.nombre_normalizado || normalizarAsociacion(a.nombre);
                    if (n !== it.normalizado && canonico(n) === c) coincidencias.push({ nombre: a.nombre, origen: 'catalogo' });
                }
                for (const o of (canonArchivo.get(c) || [])) {
                    if (o !== it) coincidencias.push({ nombre: o.nombre, origen: 'archivo' });
                }
                for (const uso of nombresEnUso) {
                    const n = normalizarAsociacion(uso);
                    if (n !== it.normalizado && canonico(n) === c) coincidencias.push({ nombre: uso, origen: 'rodeos_actuales' });
                }
            }
            if (coincidencias.length && clasificacion === 'NUEVA') clasificacion = 'POSIBLE_COINCIDENCIA';
        }
        const duplicado = vistos.has(it.normalizado);
        vistos.set(it.normalizado, true);
        const especial = clasificacion === 'CASO_ESPECIAL' || coincidencias.some(x => esNombreEspecial(normalizarAsociacion(x.nombre)));
        return {
            fila: it.fila,
            nombre_original: it.nombre,
            nombre_normalizado: it.normalizado,
            clasificacion,
            duplicado_en_archivo: duplicado,
            coincidencias,
            clubes: it.clubes,
            rodeos_historicos: it.rodeos_historicos,
            sugerencia: especial
                ? { accion: coincidencias.length ? 'alias' : 'crear', es_especial: true, incluir_en_alertas: false, nota: 'Entidad institucional: no debe figurar como "asociación sin rodeos".' }
                : { accion: clasificacion === 'YA_EXISTE' || clasificacion === 'ALIAS_EXISTENTE' ? 'omitir' : (clasificacion === 'POSIBLE_COINCIDENCIA' ? 'revisar' : 'crear'), es_especial: false, incluir_en_alertas: true }
        };
    });

    // Nombres usados hoy en rodeos que no calzan con nada del archivo/catálogo
    const normArchivo = new Set(items.map(i => i.normalizado));
    const enUsoSinCorrespondencia = [...new Set(nombresEnUso)].filter(n => {
        const nn = normalizarAsociacion(n);
        return !normArchivo.has(nn) && !indice.has(nn);
    }).map(n => {
        const c = canonico(normalizarAsociacion(n));
        const cand = items.filter(i => canonico(i.normalizado) === c).map(i => i.nombre);
        return { nombre: n, posibles_coincidencias_en_archivo: cand };
    });

    const cuenta = c => filas.filter(f => f.clasificacion === c).length;
    return {
        filas,
        resumen: {
            total: filas.length,
            ya_existen: cuenta('YA_EXISTE'),
            alias_existentes: cuenta('ALIAS_EXISTENTE'),
            posibles_coincidencias: cuenta('POSIBLE_COINCIDENCIA'),
            casos_especiales: cuenta('CASO_ESPECIAL'),
            nuevas: cuenta('NUEVA'),
            duplicados_en_archivo: filas.filter(f => f.duplicado_en_archivo).length,
            catalogo_actual: (catalogo || []).length
        },
        nombres_en_uso_sin_correspondencia: enUsoSinCorrespondencia,
        aviso: 'Vista previa: no se guardó nada. Ninguna asociación se marca inactiva automáticamente; toda decisión debe validarse.'
    };
}

// decisiones: [{ nombre_normalizado, accion:'crear'|'alias'|'omitir', zona?, es_especial?, incluir_en_alertas?, destino_normalizado? }]
// Re-lee el archivo: solo se aplican decisiones sobre nombres que EXISTEN en el archivo.
async function confirmarAsociaciones(buffer, decisiones, { db = supabase, nombreArchivo = 'catalogo_asociaciones.xlsx', actorId = null, nombresEnUso = [] } = {}) {
    const items = parsearResumen(buffer);
    const porNorm = new Map(items.map(i => [normalizarAsociacion(i.nombre), i]));
    // Nombres que existen HOY en rodeos.asociacion pero no en el archivo (p. ej. "FEDERACION"): solo pueden
    // registrarse como ALIAS de una asociación, nunca crearse como asociación propia.
    const externos = new Map();
    for (const n of nombresEnUso) {
        const nn = normalizarAsociacion(n);
        if (nn && !porNorm.has(nn) && !externos.has(nn)) externos.set(nn, { nombre: String(n).trim() });
    }
    const fuente = d => (d ? (porNorm.get(d.nombre_normalizado) || (d.accion === 'alias' ? externos.get(d.nombre_normalizado) : undefined)) : undefined);
    const resultado = { creadas: 0, alias: 0, omitidas: 0, rechazadas: [], importacion_id: null };

    const { data: imp, error: eImp } = await db.from('importaciones')
        .insert({ nombre_archivo: nombreArchivo, tipo: 'catalogo_asociaciones', total_filas: (decisiones || []).length, created_by: actorId }).select().single();
    if (eImp) throw new Error('No se pudo registrar la importación: ' + eImp.message);
    resultado.importacion_id = imp.id;

    const creadasPorNorm = new Map();
    const validas = (decisiones || []).filter(d => {
        if (!d || !ACCIONES.has(d.accion) || !fuente(d)) { resultado.rechazadas.push({ decision: d?.nombre_normalizado ?? null, motivo: 'DECISION_INVALIDA_O_NOMBRE_AUSENTE_EN_ARCHIVO' }); return false; }
        return true;
    });

    for (const d of validas.filter(x => x.accion === 'crear')) {
        const it = fuente(d);
        const especial = d.es_especial === true;
        const { data, error } = await db.from('asociaciones').upsert({
            nombre: it.nombre, nombre_normalizado: d.nombre_normalizado, zona: d.zona || null,
            activa: true, es_especial: especial, incluir_en_alertas: especial ? false : d.incluir_en_alertas !== false
        }, { onConflict: 'nombre_normalizado', ignoreDuplicates: true }).select();
        if (error) { resultado.rechazadas.push({ decision: d.nombre_normalizado, motivo: error.message }); continue; }
        if (data && data[0]) { resultado.creadas++; creadasPorNorm.set(d.nombre_normalizado, data[0].id); }
        else resultado.omitidas++;
    }
    for (const d of validas.filter(x => x.accion === 'alias')) {
        const it = fuente(d);
        let destinoId = creadasPorNorm.get(d.destino_normalizado);
        if (!destinoId && d.destino_normalizado) {
            const { data } = await db.from('asociaciones').select('id').eq('nombre_normalizado', d.destino_normalizado).limit(1);
            destinoId = data && data[0] ? data[0].id : null;
        }
        if (!destinoId) { resultado.rechazadas.push({ decision: d.nombre_normalizado, motivo: 'DESTINO_DE_ALIAS_NO_ENCONTRADO' }); continue; }
        const { data, error } = await db.from('asociacion_alias').upsert(
            { asociacion_id: destinoId, alias: it.nombre, alias_normalizado: d.nombre_normalizado },
            { onConflict: 'alias_normalizado', ignoreDuplicates: true }).select();
        if (error) { resultado.rechazadas.push({ decision: d.nombre_normalizado, motivo: error.message }); continue; }
        if (data && data[0]) resultado.alias++; else resultado.omitidas++;
    }
    resultado.omitidas += (decisiones || []).filter(d => d && d.accion === 'omitir').length;

    await db.from('importaciones').update({
        insertadas: resultado.creadas + resultado.alias, pendientes: 0, duplicadas: resultado.omitidas,
        rechazadas: resultado.rechazadas.length, errores: 0
    }).eq('id', imp.id);
    return resultado;
}

module.exports = { canonico, esNombreEspecial, parsearResumen, previewAsociaciones, confirmarAsociaciones };
