// ═════════════════════════════════════════════════════════════════════════
// Carga de datos — UNA pasada por tabla (sin N+1).
//
// Decisión de rendimiento: NO se reutiliza obtenerDatos() de
// reporte-deportivo.js (vive dentro de un router estable, no exportado, hace
// ~9 consultas encadenadas y trae el JSON completo de cada cartilla). Aquí se
// leen las tablas necesarias UNA vez para toda la temporada, con:
//   · paginación (Supabase entrega máx. 1000 filas por consulta);
//   · lotes en `.in()` (evita URLs demasiado largas);
//   · tablas NUEVAS opcionales (asociaciones, históricos): si la migración
//     aún no está aplicada el informe sigue funcionando y lo informa.
// Solo LECTURA. Los subconjuntos (período, acumulado, anterior) se calculan
// después en memoria (agregados.js).
// ═════════════════════════════════════════════════════════════════════════
const supabase = require('../../config/supabase');

const PAGINA = 1000;
const LOTE_IN = 100;
const MAX_PAGINAS = 50;

function trocear(arr, n = LOTE_IN) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}

// construir(desde, hasta) debe devolver el query con .range(desde, hasta) aplicado.
async function leerPaginado(construir) {
    const filas = [];
    for (let p = 0; p < MAX_PAGINAS; p++) {
        const { data, error } = await construir(p * PAGINA, p * PAGINA + PAGINA - 1);
        if (error) throw new Error(error.message);
        filas.push(...(data || []));
        if (!data || data.length < PAGINA) break;
    }
    return filas;
}

async function leerPorLotes(ids, construir) {
    const filas = [];
    for (const lote of trocear([...new Set(ids)])) {
        filas.push(...await leerPaginado((d, h) => construir(lote).range(d, h)));
    }
    return filas;
}

// Tabla opcional: si falla (p. ej. no existe todavía) devuelve { datos: null, motivo }.
async function leerOpcional(fn) {
    try { return { datos: await fn(), motivo: null }; }
    catch (e) { return { datos: null, motivo: e.message }; }
}

async function resolverTemporada(db, hasta) {
    const { data, error } = await db.from('temporadas').select('id, nombre, fecha_inicio, fecha_fin, activa')
        .lte('fecha_inicio', hasta).gte('fecha_fin', hasta).limit(1);
    if (error) throw new Error(error.message);
    if (data && data[0]) return { ...data[0], fuente: 'temporadas (contiene la fecha hasta)' };
    const { data: act } = await db.from('temporadas').select('id, nombre, fecha_inicio, fecha_fin, activa').eq('activa', true).limit(1);
    if (act && act[0]) return { ...act[0], fuente: 'temporadas (activa)' };
    return null;
}

async function cargarDataset({ hasta }, db = supabase) {
    const temporada = await resolverTemporada(db, hasta);
    if (!temporada) throw new Error('No existe una temporada registrada que contenga la fecha indicada');
    const { fecha_inicio: inicio, fecha_fin: fin } = temporada;

    const [rodeos, tipos, categorias] = await Promise.all([
        leerPaginado((d, h) => db.from('rodeos')
            .select('id, club, asociacion, fecha, tipo_rodeo_id, tipo_rodeo_nombre, categoria_rodeo_nombre, estado, duracion_dias, es_prueba')
            .gte('fecha', inicio).lte('fecha', fin).order('fecha', { ascending: true }).order('id', { ascending: true }).range(d, h)),
        leerPaginado((d, h) => db.from('tipos_rodeo').select('id, categoria_rodeo_id').range(d, h)),
        leerPaginado((d, h) => db.from('categorias_rodeo').select('id, nombre').range(d, h))
    ]);
    const nombreCat = {};
    categorias.forEach(c => { nombreCat[c.id] = c.nombre; });
    const categoriaPorTipoId = {};
    tipos.forEach(t => { if (t.categoria_rodeo_id && nombreCat[t.categoria_rodeo_id]) categoriaPorTipoId[t.id] = nombreCat[t.categoria_rodeo_id]; });

    const rodeoIds = rodeos.map(r => r.id);
    const evaluaciones = await leerPorLotes(rodeoIds, lote => db.from('evaluaciones')
        .select('id, rodeo_id, estado, nota_final, resultados_alterados, anulada').in('rodeo_id', lote).eq('anulada', false).eq('es_historica_importacion', false));   // los registros históricos (solo Casos por WhatsApp) no cuentan como evaluaciones
    const evalIds = evaluaciones.map(e => e.id);

    const [casos, cartillas, asignaciones, notasSecundarias, usuarios, disponibilidad] = await Promise.all([
        leerPorLotes(evalIds, lote => db.from('evaluacion_casos').select('id, evaluacion_id, tipo_caso, anulado').in('evaluacion_id', lote)),
        leerPorLotes(rodeoIds, lote => db.from('cartillas_jurado').select('rodeo_id, estado, datos').in('rodeo_id', lote).eq('es_actual', true)),
        leerPorLotes(rodeoIds, lote => db.from('asignaciones')
            .select('id, rodeo_id, usuario_pagado_id, tipo_persona, categoria_aplicada, estado, estado_designacion')
            .in('rodeo_id', lote).eq('tipo_persona', 'jurado')),
        leerPorLotes(rodeoIds, lote => db.from('rodeo_notas_secundarias').select('rodeo_id, nota_comision, nota_delegado').in('rodeo_id', lote)),
        leerPaginado((d, h) => db.from('usuarios_pagados').select('id, nombre_completo, categoria, activo, estado_usuario, tipo_persona, es_prueba').eq('tipo_persona', 'jurado').range(d, h)),
        leerPaginado((d, h) => db.from('disponibilidad_usuarios').select('usuario_pagado_id, fecha').gte('fecha', inicio).lte('fecha', hasta).order('fecha').order('usuario_pagado_id').range(d, h))
    ]);
    // Cuentas de prueba de cualquier tipo (incluye delegados): solo para excluirlas y contarlas.
    const cuentasPrueba = await leerPaginado((d, h) => db.from('usuarios_pagados').select('id').eq('es_prueba', true).range(d, h));
    const notasJurado = await leerPorLotes(asignaciones.map(a => a.id), lote => db.from('notas_rodeo').select('asignacion_id, nota, fuente').in('asignacion_id', lote));

    // Tablas nuevas (migración 057): opcionales hasta que se apliquen.
    const [cat, ali, histR, histC, snaps] = await Promise.all([
        leerOpcional(() => leerPaginado((d, h) => db.from('asociaciones').select('id, nombre, nombre_normalizado, zona, activa, es_especial, incluir_en_alertas').range(d, h))),
        leerOpcional(() => leerPaginado((d, h) => db.from('asociacion_alias').select('asociacion_id, alias, alias_normalizado').range(d, h))),
        leerOpcional(() => leerPaginado((d, h) => db.from('historico_rodeos_temporada')
            .select('temporada, fecha_rodeo, asociacion_id, asociacion_normalizada, tipo_rodeo, categoria').range(d, h))),
        leerOpcional(() => leerPaginado((d, h) => db.from('historico_colleras_medicion')
            .select('temporada, fecha_medicion, total_colleras, fecha_confirmada').range(d, h))),
        leerOpcional(() => leerPaginado((d, h) => db.from('colleras_completas_snapshots')
            .select('fecha_snapshot, total_colleras').eq('estado_fuente', 'OK').gte('fecha_snapshot', inicio).order('fecha_snapshot').range(d, h)))
    ]);

    return {
        temporada: { id: temporada.id, nombre: temporada.nombre, inicio, fin, fuente: temporada.fuente },
        rodeos, categoriaPorTipoId, evaluaciones, casos, cartillas, asignaciones,
        notasSecundarias, usuarios, disponibilidad, notasJurado,
        idsUsuariosPrueba: cuentasPrueba.map(u => u.id),
        catalogoAsociaciones: cat.datos && cat.datos.length ? cat.datos : null,
        aliasAsociaciones: ali.datos || [],
        historicoRodeos: histR.datos && histR.datos.length ? histR.datos : null,
        historicoColleras: histC.datos && histC.datos.length ? histC.datos : null,
        snapshotsColleras: snaps.datos || [],
        fuentes: {
            asociaciones: cat.datos && cat.datos.length ? { disponible: true } : { disponible: false, motivo: cat.motivo || 'Catálogo vacío' },
            historico_rodeos: histR.datos && histR.datos.length ? { disponible: true, filas: histR.datos.length } : { disponible: false, motivo: histR.motivo || 'Sin filas históricas importadas' },
            historico_colleras: histC.datos && histC.datos.length ? { disponible: true, filas: histC.datos.length } : { disponible: false, motivo: histC.motivo || 'Sin mediciones históricas importadas' }
        }
    };
}

module.exports = { trocear, leerPaginado, leerPorLotes, leerOpcional, resolverTemporada, cargarDataset };
