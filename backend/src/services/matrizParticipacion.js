// ═════════════════════════════════════════════════════════════════════════
// matrizParticipacion.js — lógica compartida de "Matriz de Participación".
//
// Centraliza la obtención de datos y el cálculo de promedios/benchmarks
// para que el endpoint JSON (pantalla) y el endpoint Excel usen EXACTAMENTE
// la misma lógica — evita que la pantalla calcule una cosa y el Excel otra.
//
// TRES INDICADORES INDEPENDIENTES, cada uno con su propia fuente:
//   - Casos     -> notas_rodeo.nota           (asignacion_id = asignaciones.id, 1:1)
//   - Comisión  -> rodeo_notas_secundarias.nota_comision (rodeo_id = rodeos.id, 1:1 por rodeo)
//   - Delegado  -> rodeo_notas_secundarias.nota_delegado (idem)
//
// IMPORTANTE (confirmado y aceptado explícitamente por el usuario): Comisión
// y Delegado son una nota DEL RODEO, no de la persona — si tres jurados
// trabajaron el mismo rodeo, los tres comparten esos mismos dos valores.
// "Prom. Comisión"/"Prom. Delegado" de una persona es el promedio de las
// notas de los rodeos en los que participó, NO una evaluación individual.
//
// UNIVERSO ESTADÍSTICO vs FILAS VISIBLES (punto crítico del pedido):
//   Año/Mes/Desde/Hasta/Tipo Persona -> SÍ acotan el universo usado para
//   calcular promedios y benchmarks (se aplican en la consulta a la base).
//   Categoría/Buscar Nombre/Incluir sin salidas -> SOLO deciden qué filas
//   se muestran; se aplican DESPUÉS de calcular benchmarks sobre el
//   universo completo (mismo tipo_persona, mismo período, TODAS las
//   categorías). Por eso `construirPersonas` nunca filtra por categoría ni
//   nombre — esa selección ocurre recién en `aplicarFiltrosVisuales`.
//
// BENCHMARKS = promedio de PROMEDIOS INDIVIDUALES (cada persona pesa igual,
// nunca se pondera por cantidad de rodeos), excluyendo siempre a la propia
// persona, y SOLO entre pares de exactamente el mismo tipo_persona. Se
// precalculan sumas/conteos por grupo (tipo_persona+categoria y
// tipo_persona) para no recorrer el grupo completo por cada fila.
// ═════════════════════════════════════════════════════════════════════════
const supabase = require('../config/supabase');

function round2(n) {
    return Math.round(n * 100) / 100;
}

// ─── Período (idéntico al que ya usaban ambos endpoints) ────────────────────
function calcularPeriodo({ año, mes, desde, hasta }) {
    const inicio = desde || (mes
        ? `${año}-${String(mes).padStart(2, '0')}-01`
        : `${año}-01-01`);
    const fin = hasta || (mes
        ? new Date(año, mes, 0).toISOString().split('T')[0]
        : `${año}-12-31`);
    return { año, mes, inicio, fin };
}

// ─── Consultas batch (4 en total, nunca N+1) ─────────────────────────────────
async function obtenerDatosBase({ inicio, fin, tipo, incluirRut }) {
    let qAsigs = supabase
        .from('asignaciones')
        .select('id, usuario_pagado_id, tipo_persona, estado_designacion, rodeos!inner(id, fecha, club, asociacion, tipo_rodeo_nombre)')
        .eq('estado', 'activo')
        .gte('rodeos.fecha', inicio)
        .lte('rodeos.fecha', fin);
    if (tipo) qAsigs = qAsigs.eq('tipo_persona', tipo);
    const { data: asigs, error: errAsigs } = await qAsigs;
    if (errAsigs) throw new Error('asignaciones: ' + errAsigs.message);
    const todasAsigs = (asigs || []).filter(a => a.estado_designacion !== 'rechazado');

    const camposUsuario = incluirRut
        ? 'id, nombre_completo, rut, categoria, tipo_persona'
        : 'id, nombre_completo, categoria, tipo_persona';
    let qUsuarios = supabase.from('usuarios_pagados').select(camposUsuario).eq('activo', true);
    if (tipo) qUsuarios = qUsuarios.eq('tipo_persona', tipo);
    const { data: usuarios, error: errUsuarios } = await qUsuarios;
    if (errUsuarios) throw new Error('usuarios_pagados: ' + errUsuarios.message);

    const asigIds = todasAsigs.map(a => a.id);
    const notasCasosMap = {};
    if (asigIds.length > 0) {
        const { data: notas, error: errNotas } = await supabase
            .from('notas_rodeo')
            .select('asignacion_id, nota')
            .in('asignacion_id', asigIds);
        if (errNotas) throw new Error('notas_rodeo: ' + errNotas.message);
        (notas || []).forEach(n => { notasCasosMap[n.asignacion_id] = parseFloat(n.nota); });
    }

    // rodeo_notas_secundarias — 1 fila por rodeo (rodeo_id UNIQUE), lookup
    // por clave (no JOIN relacional): imposible que duplique asignaciones.
    const rodeoIds = [...new Set(todasAsigs.map(a => a.rodeos?.id).filter(Boolean))];
    const notasSecMap = {};
    if (rodeoIds.length > 0) {
        const { data: notasSec, error: errSec } = await supabase
            .from('rodeo_notas_secundarias')
            .select('rodeo_id, nota_comision, nota_delegado')
            .in('rodeo_id', rodeoIds);
        if (errSec) throw new Error('rodeo_notas_secundarias: ' + errSec.message);
        (notasSec || []).forEach(n => {
            notasSecMap[n.rodeo_id] = {
                nota_comision: n.nota_comision !== null && n.nota_comision !== undefined ? parseFloat(n.nota_comision) : null,
                nota_delegado: n.nota_delegado !== null && n.nota_delegado !== undefined ? parseFloat(n.nota_delegado) : null
            };
        });
    }

    const usuariosMap = {};
    (usuarios || []).forEach(u => { usuariosMap[u.id] = u; });

    return { todasAsigs, usuariosMap, notasCasosMap, notasSecMap };
}

// ─── Construir el universo COMPLETO de personas (todas las categorías,
// incluye sin-salidas) con sus 3 promedios individuales. NUNCA filtra por
// categoría ni nombre acá — eso es un filtro de filas visibles, no de
// universo estadístico. ────────────────────────────────────────────────────
function construirPersonas({ todasAsigs, usuariosMap, notasCasosMap, notasSecMap }) {
    const perUser = {};
    todasAsigs.forEach(a => {
        const u = usuariosMap[a.usuario_pagado_id];
        if (!u) return;
        const uid = a.usuario_pagado_id;
        const cat = u.tipo_persona === 'delegado_rentado' ? 'DR' : (u.categoria || '?');
        if (!perUser[uid]) {
            perUser[uid] = {
                usuario_pagado_id: uid, nombre: u.nombre_completo, rut: u.rut || '',
                tipo_persona: u.tipo_persona, categoria: cat,
                rodeos: [], _casos: [], _comision: [], _delegado: []
            };
        }
        const rodeo = a.rodeos || {};
        const notaCasos = notasCasosMap[a.id] ?? null;
        const sec = notasSecMap[rodeo.id] || { nota_comision: null, nota_delegado: null };
        perUser[uid].rodeos.push({
            rodeo_id: rodeo.id, asignacion_id: a.id, fecha: rodeo.fecha,
            club: rodeo.club, asociacion: rodeo.asociacion, tipo_rodeo: rodeo.tipo_rodeo_nombre,
            nota: notaCasos,                    // alias legacy — mismo valor que nota_casos
            nota_casos: notaCasos,
            nota_comision: sec.nota_comision,
            nota_delegado: sec.nota_delegado
        });
        if (notaCasos !== null)          perUser[uid]._casos.push(notaCasos);
        if (sec.nota_comision !== null)  perUser[uid]._comision.push(sec.nota_comision);
        if (sec.nota_delegado !== null)  perUser[uid]._delegado.push(sec.nota_delegado);
    });

    // Personas SIN ninguna salida en el período (siempre se calculan —
    // "Incluir sin salidas" solo decide si se MUESTRAN, ver aplicarFiltrosVisuales).
    Object.values(usuariosMap).forEach(u => {
        if (perUser[u.id]) return;
        const cat = u.tipo_persona === 'delegado_rentado' ? 'DR' : (u.categoria || '?');
        perUser[u.id] = {
            usuario_pagado_id: u.id, nombre: u.nombre_completo, rut: u.rut || '',
            tipo_persona: u.tipo_persona, categoria: cat,
            rodeos: [], _casos: [], _comision: [], _delegado: []
        };
    });

    // Promedio SIN redondear (precisión completa) — es el valor que debe
    // alimentar sumas/conteos de benchmarks (ver calcularBenchmarks). El
    // redondeo a 2 decimales ocurre SOLO al final, para presentación.
    const promedioExacto = (arr) => arr.length > 0 ? arr.reduce((s, n) => s + n, 0) / arr.length : null;

    return Object.values(perUser).map(p => {
        p.rodeos.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
        const total_salidas = p.rodeos.length;
        const ultima_salida = total_salidas > 0 ? p.rodeos[total_salidas - 1].fecha : null;

        const casosExacto    = promedioExacto(p._casos);
        const comisionExacto = promedioExacto(p._comision);
        const delegadoExacto = promedioExacto(p._delegado);
        // Valor redondeado — el que se muestra en pantalla/JSON (idéntico
        // al que ya se mostraba antes de este ajuste; el redondeo de un
        // valor ya exacto no cambia el número visible, solo lo que se usa
        // internamente para sumar dentro de los benchmarks).
        const promedio_casos    = casosExacto    !== null ? round2(casosExacto)    : null;
        const promedio_comision = comisionExacto !== null ? round2(comisionExacto) : null;
        const promedio_delegado = delegadoExacto !== null ? round2(delegadoExacto) : null;

        return {
            usuario_pagado_id: p.usuario_pagado_id,
            nombre: p.nombre,
            rut: p.rut,
            tipo_persona: p.tipo_persona,
            categoria: p.categoria,
            total_salidas,
            ultima_salida,
            rodeos: p.rodeos,
            sin_salidas: total_salidas === 0,

            // ── Compatibilidad hacia atrás (mismo valor, mismo significado
            // que antes de esta mejora — "Prom. Nota" = "Prom. Casos") ──
            promedio_nota: promedio_casos,
            notas_count: p._casos.length,
            sin_nota_count: total_salidas - p._casos.length,

            // ── Datos crudos para el cálculo de benchmarks (se completan
            // en calcularBenchmarks; no exponer estos campos en el JSON
            // final). `promedioExacto` SIN redondear alimenta las sumas de
            // grupo; `promedio` (redondeado) es lo único que se expone. ──
            _promedios_individuales: {
                casos:    { promedio: promedio_casos,    promedioExacto: casosExacto,    con_nota: p._casos.length },
                comision: { promedio: promedio_comision, promedioExacto: comisionExacto, con_nota: p._comision.length },
                delegado: { promedio: promedio_delegado, promedioExacto: delegadoExacto, con_nota: p._delegado.length }
            }
        };
    });
}

// ─── Benchmarks: promedio de PROMEDIOS INDIVIDUALES (cada persona pesa
// igual), excluyendo siempre a la propia persona, solo dentro del mismo
// tipo_persona (y, para el de categoría, también misma categoría). Se
// precalculan sumas/conteos por grupo para no recorrerlo por cada fila. ──
function calcularBenchmarks(personas) {
    const INDICADORES = ['casos', 'comision', 'delegado'];
    const gruposCat = {};  // `${tipo}::${categoria}` -> { casos:{sum,count}, comision:{...}, delegado:{...} }
    const gruposGen = {};  // `${tipo}` -> idem

    const acumular = (mapa, clave) => {
        if (!mapa[clave]) mapa[clave] = { casos: { sum: 0, count: 0 }, comision: { sum: 0, count: 0 }, delegado: { sum: 0, count: 0 } };
        return mapa[clave];
    };

    // Las sumas de grupo se acumulan con `promedioExacto` (SIN redondear) —
    // si se sumaran los promedios ya redondeados a 2 decimales, el
    // benchmark del grupo arrastraría el error de redondeo de cada
    // integrante. El redondeo ocurre recién al final, una sola vez.
    personas.forEach(p => {
        const claveCat = `${p.tipo_persona}::${p.categoria}`;
        const claveGen = p.tipo_persona;
        const gCat = acumular(gruposCat, claveCat);
        const gGen = acumular(gruposGen, claveGen);
        INDICADORES.forEach(ind => {
            const promExacto = p._promedios_individuales[ind].promedioExacto;
            if (promExacto === null) return; // NULL nunca participa del benchmark
            gCat[ind].sum += promExacto; gCat[ind].count += 1;
            gGen[ind].sum += promExacto; gGen[ind].count += 1;
        });
    });

    // Devuelve el benchmark SIN redondear (precisión completa) — el
    // redondeo a 2 decimales se aplica recién al armar `promedios[ind]`,
    // igual que la diferencia (propio - benchmark), nunca antes.
    const benchmarkExactoExcluyendo = (grupo, ind, propioExacto) => {
        const { sum, count } = grupo[ind];
        if (propioExacto !== null) {
            // La propia persona ya está sumada en el grupo -> restarla.
            return count - 1 > 0 ? (sum - propioExacto) / (count - 1) : null;
        }
        // La persona no aportó al grupo (no tiene promedio propio) -> no hay que restar nada.
        return count > 0 ? sum / count : null;
    };

    return personas.map(p => {
        const claveCat = `${p.tipo_persona}::${p.categoria}`;
        const claveGen = p.tipo_persona;
        const gCat = gruposCat[claveCat];
        const gGen = gruposGen[claveGen];

        const promedios = {};
        INDICADORES.forEach(ind => {
            const propio = p._promedios_individuales[ind].promedio;               // redondeado — para mostrar
            const propioExacto = p._promedios_individuales[ind].promedioExacto;   // precisión completa — para calcular
            const con_nota = p._promedios_individuales[ind].con_nota;
            const benchCatExacto = benchmarkExactoExcluyendo(gCat, ind, propioExacto);
            const benchGenExacto = benchmarkExactoExcluyendo(gGen, ind, propioExacto);
            // La diferencia solo tiene sentido si la persona tiene su propio
            // promedio — nunca se compara "—" contra un número. Se calcula
            // con los valores exactos y se redondea al final, una sola vez.
            const diferencia_categoria = (propioExacto !== null && benchCatExacto !== null) ? round2(propioExacto - benchCatExacto) : null;
            const diferencia_general   = (propioExacto !== null && benchGenExacto !== null) ? round2(propioExacto - benchGenExacto)   : null;
            promedios[ind] = {
                promedio: propio,
                con_nota,
                total_salidas: p.total_salidas,
                promedio_categoria: benchCatExacto !== null ? round2(benchCatExacto) : null,
                diferencia_categoria,
                promedio_general: benchGenExacto !== null ? round2(benchGenExacto) : null,
                diferencia_general
            };
        });

        const { _promedios_individuales, ...resto } = p;
        return { ...resto, promedios };
    });
}

// ─── Filtros visuales: Categoría, Buscar Nombre, Incluir sin salidas.
// Se aplican DESPUÉS de calcular benchmarks — nunca reducen el universo
// estadístico, solo deciden qué filas se devuelven/muestran. ────────────────
function aplicarFiltrosVisuales(personas, { categoria, search, incluirSinSalidas }) {
    let resultado = personas;
    if (categoria) {
        resultado = resultado.filter(p => p.categoria === categoria);
    }
    if (search) {
        const s = search.toLowerCase();
        resultado = resultado.filter(p => p.nombre.toLowerCase().includes(s));
    }
    if (!incluirSinSalidas) {
        resultado = resultado.filter(p => !p.sin_salidas);
    }
    return resultado;
}

// ─── Ordenamiento. Personas sin promedio siempre quedan al final, tanto en
// ascendente como en descendente (mismo patrón que ya usaba "nota_asc/desc"). ──
const ORDENES = {
    salidas_desc: (a, b) => b.total_salidas - a.total_salidas,
    salidas_asc:  (a, b) => a.total_salidas - b.total_salidas,
    // Alias legacy — "nota" siempre fue Casos.
    nota_desc:    (a, b) => (b.promedios.casos.promedio ?? -1)  - (a.promedios.casos.promedio ?? -1),
    nota_asc:     (a, b) => (a.promedios.casos.promedio ?? 999) - (b.promedios.casos.promedio ?? 999),
    casos_desc:    (a, b) => (b.promedios.casos.promedio ?? -1)  - (a.promedios.casos.promedio ?? -1),
    casos_asc:     (a, b) => (a.promedios.casos.promedio ?? 999) - (b.promedios.casos.promedio ?? 999),
    comision_desc: (a, b) => (b.promedios.comision.promedio ?? -1)  - (a.promedios.comision.promedio ?? -1),
    comision_asc:  (a, b) => (a.promedios.comision.promedio ?? 999) - (b.promedios.comision.promedio ?? 999),
    delegado_desc: (a, b) => (b.promedios.delegado.promedio ?? -1)  - (a.promedios.delegado.promedio ?? -1),
    delegado_asc:  (a, b) => (a.promedios.delegado.promedio ?? 999) - (b.promedios.delegado.promedio ?? 999),
    nombre_az:    (a, b) => a.nombre.localeCompare(b.nombre),
    cat_az:       (a, b) => a.categoria.localeCompare(b.categoria),
    ultima_desc:  (a, b) => (b.ultima_salida || '').localeCompare(a.ultima_salida || ''),
    ultima_asc:   (a, b) => (a.ultima_salida || '').localeCompare(b.ultima_salida || '')
};

function ordenar(personas, order) {
    return [...personas].sort(ORDENES[order] || ORDENES.salidas_desc);
}

// ─── Punto de entrada único — consumido por el endpoint JSON y por el Excel ──
async function obtenerMatrizParticipacion({ año, mes, desde, hasta, tipo, categoria, search, order, incluirSinSalidas, incluirRut }) {
    const periodo = calcularPeriodo({ año, mes, desde, hasta });
    const datos = await obtenerDatosBase({ inicio: periodo.inicio, fin: periodo.fin, tipo, incluirRut: !!incluirRut });

    let personas = construirPersonas(datos);          // universo completo (todas las categorías)
    personas = calcularBenchmarks(personas);           // benchmarks sobre el universo completo
    personas = aplicarFiltrosVisuales(personas, {       // recién acá se decide qué se muestra
        categoria, search, incluirSinSalidas: incluirSinSalidas !== false
    });
    personas = ordenar(personas, order || 'salidas_desc');

    return { periodo, personas };
}

module.exports = {
    obtenerMatrizParticipacion,
    // Exportados para tests unitarios de las piezas internas.
    round2,
    calcularPeriodo,
    construirPersonas,
    calcularBenchmarks,
    aplicarFiltrosVisuales,
    ordenar,
    ORDENES
};
