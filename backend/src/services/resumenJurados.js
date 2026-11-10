/**
 * Resumen de pagos por jurado con detalle por rodeo — FUENTE ÚNICA de datos
 * para Administrador → Reportes → "Resumen por jurado" (GET /admin/reportes/
 * resumen-mensual) y su exportación Excel/CSV (GET /admin/exportacion/
 * resumen-jurados). Antes cada ruta tenía su propia copia de la consulta y
 * del agrupamiento, y no eran idénticas:
 *   - la copia de exportación no seleccionaba `estado_designacion`, así que
 *     el Excel sumaba designaciones RECHAZADAS que la pantalla excluía;
 *   - la exportación ignoraba `categoria_rodeo_id` y la pantalla ignoraba
 *     `usuario_pagado_id` (filtro "Jurado").
 * Ahora ambas llaman a obtenerResumenJurados() y nunca pueden volver a
 * divergir.
 *
 * REGLAS FINANCIERAS — idénticas a calcularResumenMensual() (calculo.js), que
 * es el cálculo oficial del pago mensual. Este módulo NO las redefine, solo
 * desglosa:
 *   - Solo asignaciones `estado='activo'`. Las anuladas no existen para pago.
 *   - `estado_designacion='rechazado'` no suma (se informa aparte).
 *   - Pago base = `asignaciones.pago_base_calculado` (valor histórico
 *     congelado; ya incorpora la duración aplicada — un rodeo de 2 días es
 *     UNA asignación con duración 2, nunca dos filas).
 *   - Bono = suma de bonos de la asignación en estado aprobado/modificado/
 *     aprobado_auto, monto = monto_aprobado || monto_solicitado (aprobado_auto
 *     siempre es $0). Pendientes, rechazados y desvinculados por reemplazo no
 *     suman.
 *   - Retención = Math.round(bruto_del_jurado × % / 100) sobre el bruto
 *     AGREGADO del jurado en el período. Por eso la retención y el líquido
 *     existen solo a nivel de jurado: repartirlos por rodeo exigiría un
 *     redondeo que el cálculo oficial no define. Las filas de rodeo llevan
 *     retencion_monto/liquido = null.
 *   - Un jurado reemplazado no aparece: el reemplazo (migración 084) reescribe
 *     `usuario_pagado_id` de la misma asignación hacia el reemplazante.
 */

const supabase = require('../config/supabase');
const { obtenerRetencion } = require('./calculo');

// Estados de bono que suman al bruto — misma allowlist que calculo.js.
const ESTADOS_BONO_QUE_SUMAN = ['aprobado', 'modificado', 'aprobado_auto'];

const TAMANO_PAGINA = 1000;   // = max-rows por defecto de PostgREST/Supabase
const TAMANO_LOTE_IN = 150;   // ids por `.in()` (evita URLs demasiado largas)

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio',
    'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// ─── Rango de fechas (mismas reglas que buildRango de reportes.js) ────────
// Último día del mes calculado en UTC: no depende de la zona horaria del
// servidor (con new Date(a, m, 0).toISOString() un servidor al este de UTC
// obtenía el día anterior).
function construirRango({ año, mes, fechaDesde, fechaHasta } = {}) {
    const añoNum = parseInt(año);
    const mesNum = parseInt(mes);
    if (fechaDesde && fechaHasta) return { inicio: fechaDesde, fin: fechaHasta, tipo: 'rango' };
    if (!isNaN(añoNum) && !isNaN(mesNum) && mesNum >= 1 && mesNum <= 12) {
        const ultimo = new Date(Date.UTC(añoNum, mesNum, 0)).getUTCDate();
        const mm = String(mesNum).padStart(2, '0');
        return { inicio: `${añoNum}-${mm}-01`, fin: `${añoNum}-${mm}-${String(ultimo).padStart(2, '0')}`, tipo: 'mes', año: añoNum, mes: mesNum };
    }
    if (!isNaN(añoNum)) return { inicio: `${añoNum}-01-01`, fin: `${añoNum}-12-31`, tipo: 'año', año: añoNum };
    return null;
}

function fechaDDMMAAAA(iso) {
    if (!iso) return '';
    const [y, m, d] = String(iso).slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
}

function describirPeriodo(rango) {
    if (!rango) return 'Todos los períodos';
    const tramo = `${fechaDDMMAAAA(rango.inicio)} al ${fechaDDMMAAAA(rango.fin)}`;
    if (rango.tipo === 'mes') return `${MESES[rango.mes - 1]} ${rango.año} (${tramo})`;
    if (rango.tipo === 'año') return `Año ${rango.año} (${tramo})`;
    return tramo;
}

// ─── Consulta de asignaciones (paginada, sin consultas por jurado/rodeo) ──
const SELECT_ASIGNACIONES = `
    id, rodeo_id, usuario_pagado_id, tipo_persona, categoria_aplicada, valor_diario_aplicado,
    duracion_dias_aplicada, pago_base_calculado, estado, estado_designacion, nombre_importado,
    usuarios_pagados(id, codigo_interno, nombre_completo, rut, categoria, tipo_persona),
    rodeos!inner(id, club, asociacion, fecha, tipo_rodeo_nombre, duracion_dias, tipo_rodeo_id, categoria_rodeo_id, categoria_rodeo_nombre)
`;

async function consultarAsignaciones(filtros = {}) {
    const { usuario_pagado_id, categoria, asociacion, club, tipo_rodeo_id, categoria_rodeo_id } = filtros;
    const rango = construirRango(filtros);
    const todas = [];

    for (let desde = 0; ; desde += TAMANO_PAGINA) {
        let q = supabase.from('asignaciones').select(SELECT_ASIGNACIONES).eq('estado', 'activo');
        if (rango)              q = q.gte('rodeos.fecha', rango.inicio).lte('rodeos.fecha', rango.fin);
        if (usuario_pagado_id)  q = q.eq('usuario_pagado_id', usuario_pagado_id);
        if (categoria)          q = q.eq('categoria_aplicada', categoria);
        if (asociacion)         q = q.ilike('rodeos.asociacion', `%${asociacion}%`);
        if (club)               q = q.ilike('rodeos.club', `%${club}%`);
        if (tipo_rodeo_id)      q = q.eq('rodeos.tipo_rodeo_id', tipo_rodeo_id);
        if (categoria_rodeo_id) q = q.eq('rodeos.categoria_rodeo_id', categoria_rodeo_id);

        const { data, error } = await q.order('id', { ascending: true }).range(desde, desde + TAMANO_PAGINA - 1);
        if (error) throw new Error('Error en query asignaciones: ' + error.message);
        const pagina = data || [];
        todas.push(...pagina);
        if (pagina.length < TAMANO_PAGINA) break;
    }

    // Defensa: una misma asignación nunca debe contarse dos veces aunque la
    // paginación devolviera un solapamiento.
    const vistas = new Set();
    return todas.filter(a => (vistas.has(a.id) ? false : (vistas.add(a.id), true)));
}

async function consultarBonosPorAsignacion(ids) {
    const mapa = {};
    for (let i = 0; i < ids.length; i += TAMANO_LOTE_IN) {
        const lote = ids.slice(i, i + TAMANO_LOTE_IN);
        const { data, error } = await supabase
            .from('bonos_solicitados')
            .select('id, asignacion_id, estado, monto_aprobado, monto_solicitado, distancia_declarada, created_at')
            .in('asignacion_id', lote);
        if (error) throw new Error('Error al obtener bonos: ' + error.message);
        (data || []).forEach(b => { (mapa[b.asignacion_id] = mapa[b.asignacion_id] || []).push(b); });
    }
    return mapa;
}

// Misma fórmula que calcularResumenMensual (calculo.js).
function calcularBonoAprobado(bonos) {
    return (bonos || [])
        .filter(b => ESTADOS_BONO_QUE_SUMAN.includes(b.estado))
        .reduce((s, b) => s + (b.monto_aprobado || b.monto_solicitado || 0), 0);
}

// ─── Agrupamiento puro (sin BD) ───────────────────────────────────────────
function compararFilas(a, b) {
    return (a.fecha || '').localeCompare(b.fecha || '')
        || (a.club || '').localeCompare(b.club || '', 'es')
        || String(a.asignacion_id).localeCompare(String(b.asignacion_id));
}

/**
 * @param {Array} asignaciones  filas de `asignaciones` con `rodeos` y
 *                              `usuarios_pagados` embebidos y `bonos` (array).
 * @param {number} porcentaje   retención vigente (obtenerRetencion()).
 */
function construirResumen(asignaciones, porcentaje) {
    const mapa = {};
    let asignacionesSinUsuario = 0;

    for (const a of asignaciones) {
        const u = a.usuarios_pagados;
        if (!u) { asignacionesSinUsuario++; continue; }
        if (!mapa[u.id]) {
            mapa[u.id] = {
                id: u.id,
                codigo_interno: u.codigo_interno,
                nombre_completo: u.nombre_completo,
                rut: u.rut || '—',
                categoria: u.categoria || '—',
                tipo_persona: u.tipo_persona,
                designaciones_rechazadas: 0,
                rodeos_detalle: [],
            };
        }
        const j = mapa[u.id];
        if (a.estado_designacion === 'rechazado') { j.designaciones_rechazadas++; continue; }

        const r = a.rodeos || {};
        const pago_base = a.pago_base_calculado || 0;
        const bono = calcularBonoAprobado(a.bonos);
        const ultimoBono = (a.bonos || []).slice().sort((x, y) => String(x.created_at || '').localeCompare(String(y.created_at || ''))).pop() || null;
        j.rodeos_detalle.push({
            asignacion_id:    a.id,
            rodeo_id:         r.id || a.rodeo_id || null,
            fecha:            r.fecha || '',
            asociacion:       r.asociacion || '—',
            club:             r.club || '—',
            tipo_rodeo:       r.tipo_rodeo_nombre || '—',
            categoria_rodeo:  r.categoria_rodeo_nombre || null,
            duracion_dias:    a.duracion_dias_aplicada ?? r.duracion_dias ?? null,
            categoria:        a.categoria_aplicada || '—',
            tipo_persona:     a.tipo_persona || u.tipo_persona,
            estado_designacion: a.estado_designacion || null,
            pago_base,
            bono_aprobado:    bono,
            estado_bono:      ultimoBono ? ultimoBono.estado : null,
            bruto:            pago_base + bono,
            // Retención/líquido son del jurado (agregado), nunca por rodeo.
            retencion_monto:  null,
            liquido:          null,
        });
    }

    const jurados = Object.values(mapa).map(j => {
        j.rodeos_detalle.sort(compararFilas);
        j.rodeos_detalle.forEach((f, i) => { f.n = i + 1; });
        const total_pago_base     = j.rodeos_detalle.reduce((s, f) => s + f.pago_base, 0);
        const total_bono_aprobado = j.rodeos_detalle.reduce((s, f) => s + f.bono_aprobado, 0);
        const bruto               = total_pago_base + total_bono_aprobado;
        const retencion_monto     = Math.round(bruto * porcentaje / 100);
        return {
            ...j,
            cant_rodeos: j.rodeos_detalle.length,
            total_pago_base,
            total_bono_aprobado,
            bruto,
            retencion_monto,
            liquido: bruto - retencion_monto,
        };
    }).sort((a, b) => (a.nombre_completo || '').localeCompare(b.nombre_completo || '', 'es'));

    const totales_global = jurados.reduce((acc, j) => ({
        cant_jurados:        acc.cant_jurados + 1,
        cant_rodeos:         acc.cant_rodeos + j.cant_rodeos,
        total_pago_base:     acc.total_pago_base + j.total_pago_base,
        total_bono_aprobado: acc.total_bono_aprobado + j.total_bono_aprobado,
        bruto:               acc.bruto + j.bruto,
        retencion_monto:     acc.retencion_monto + j.retencion_monto,
        liquido:             acc.liquido + j.liquido,
    }), { cant_jurados: 0, cant_rodeos: 0, total_pago_base: 0, total_bono_aprobado: 0, bruto: 0, retencion_monto: 0, liquido: 0 });

    return { jurados, totales_global, conciliacion: conciliar(jurados, totales_global, porcentaje, asignacionesSinUsuario) };
}

/**
 * Verifica las invariantes exigidas. No corrige nada: si algo no cuadra lo
 * informa en `errores` (y las pruebas fallan).
 */
function conciliar(jurados, totales, porcentaje, asignacionesSinUsuario = 0) {
    const errores = [];
    const advertencias = [];
    const sum = (arr, k) => arr.reduce((s, x) => s + (x[k] || 0), 0);

    for (const j of jurados) {
        const filas = j.rodeos_detalle;
        if (sum(filas, 'pago_base') !== j.total_pago_base) errores.push(`${j.codigo_interno}: suma de pagos base ≠ total`);
        if (sum(filas, 'bono_aprobado') !== j.total_bono_aprobado) errores.push(`${j.codigo_interno}: suma de bonos ≠ total`);
        if (filas.some(f => f.pago_base + f.bono_aprobado !== f.bruto)) errores.push(`${j.codigo_interno}: pago base + bono ≠ bruto en una fila`);
        if (sum(filas, 'bruto') !== j.bruto) errores.push(`${j.codigo_interno}: suma de brutos ≠ bruto total`);
        if (j.retencion_monto !== Math.round(j.bruto * porcentaje / 100)) errores.push(`${j.codigo_interno}: retención distinta del cálculo oficial`);
        if (j.bruto - j.retencion_monto !== j.liquido) errores.push(`${j.codigo_interno}: bruto − retención ≠ líquido`);

        const porRodeo = {};
        filas.forEach(f => { porRodeo[f.rodeo_id] = (porRodeo[f.rodeo_id] || 0) + 1; });
        Object.entries(porRodeo).filter(([, n]) => n > 1).forEach(([rid]) => {
            advertencias.push(`${j.codigo_interno} ${j.nombre_completo}: ${porRodeo[rid]} asignaciones vigentes en el mismo rodeo (${rid}); se muestran por separado, sin fusionar importes.`);
        });
    }
    const chequeos = [
        ['cant_rodeos', 'cant_rodeos'], ['total_pago_base', 'total_pago_base'], ['total_bono_aprobado', 'total_bono_aprobado'],
        ['bruto', 'bruto'], ['retencion_monto', 'retencion_monto'], ['liquido', 'liquido'],
    ];
    for (const [kt, kj] of chequeos) {
        if (totales[kt] !== sum(jurados, kj)) errores.push(`Total general ${kt} ≠ suma de subtotales`);
    }
    if (totales.bruto - totales.retencion_monto !== totales.liquido) errores.push('Total general: bruto − retención ≠ líquido');
    if (asignacionesSinUsuario > 0) {
        advertencias.push(`${asignacionesSinUsuario} asignación(es) sin persona vinculada (nombre importado sin usuario) no se incluyen, igual que en el cálculo anterior.`);
    }
    return { ok: errores.length === 0, errores, advertencias, asignaciones_sin_usuario: asignacionesSinUsuario };
}

// ─── Punto de entrada usado por la pantalla y por la exportación ──────────
async function obtenerResumenJurados(filtros = {}) {
    const asignaciones = await consultarAsignaciones(filtros);
    const bonosMap = await consultarBonosPorAsignacion(asignaciones.map(a => a.id));
    const conBonos = asignaciones.map(a => ({ ...a, bonos: bonosMap[a.id] || [] }));
    const porcentaje = await obtenerRetencion();
    const resumen = construirResumen(conBonos, porcentaje);
    const rango = construirRango(filtros);
    return {
        ...resumen,
        retencion_porcentaje: porcentaje,
        periodo: { ...(rango || {}), descripcion: describirPeriodo(rango) },
    };
}

module.exports = {
    obtenerResumenJurados,
    construirResumen,
    construirRango,
    describirPeriodo,
    calcularBonoAprobado,
    consultarAsignaciones,
    conciliar,
    fechaDDMMAAAA,
    ESTADOS_BONO_QUE_SUMAN,
};
