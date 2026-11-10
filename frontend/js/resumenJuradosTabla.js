/**
 * Reportes → "Resumen por jurado": tabla única agrupada por jurado con una
 * fila por rodeo, subtotal por jurado y total general.
 *
 * Funciones PURAS (sin DOM): reciben la respuesta de GET /admin/reportes/
 * resumen-mensual y devuelven HTML. Los montos se muestran tal como los
 * entrega el backend (services/resumenJurados.js, misma fuente que el
 * Excel/CSV) — aquí no se suma ni se recalcula nada.
 *
 * Retención y líquido se calculan sobre el bruto total del jurado (cálculo
 * oficial), por eso solo aparecen en la fila de subtotal.
 */
(function () {
    function esc(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }
    function clp(monto) {
        if (monto === null || monto === undefined || monto === '') return '$0';
        return '$' + Math.round(Number(monto)).toLocaleString('es-CL');
    }
    // Fecha YYYY-MM-DD → DD/MM/YYYY por texto (sin Date: nunca se desplaza por zona horaria).
    function fecha(iso) {
        if (!iso) return '—';
        const [y, m, d] = String(iso).slice(0, 10).split('-');
        return `${d}/${m}/${y}`;
    }

    const COLS = 14; // Código, Jurado, RUT, N.º, Fecha, Asoc., Club, Cat., Tipo, Pago base, Bono, Bruto, Retención, Líquido

    function filaSubtotal(j) {
        const n = j.cant_rodeos;
        const extra = (n === 0 && j.designaciones_rechazadas > 0)
            ? ` <span class="rj-nota">— ${j.designaciones_rechazadas} designación(es) rechazada(s), sin pago</span>` : '';
        return `<tr class="rj-subtotal">
            <td colspan="9">TOTAL JURADO: ${esc(j.nombre_completo)} (${n} ${n === 1 ? 'RODEO' : 'RODEOS'})${extra}</td>
            <td class="monto">${clp(j.total_pago_base)}</td>
            <td class="monto">${clp(j.total_bono_aprobado)}</td>
            <td class="monto">${clp(j.bruto)}</td>
            <td class="monto rj-ret">-${clp(j.retencion_monto)}</td>
            <td class="monto rj-liq">${clp(j.liquido)}</td>
        </tr>`;
    }

    function celdasIdentidad(j, rowspan) {
        const rs = rowspan > 1 ? ` rowspan="${rowspan}"` : '';
        const tipo = j.tipo_persona && j.tipo_persona !== 'jurado'
            ? '<div class="rj-tipo">Delegado rentado</div>' : '';
        return `<td class="rj-id"${rs}>${esc(j.codigo_interno)}</td>
            <td class="rj-id rj-nombre"${rs}><strong>${esc(j.nombre_completo)}</strong>${tipo}
                <div><button class="btn btn-pequeño btn-outline rj-ver" data-jurado-id="${esc(j.id)}" data-jurado-nombre="${esc(j.nombre_completo)}">Ver</button></div></td>
            <td class="rj-id"${rs}>${esc(j.rut || '—')}</td>`;
    }

    function bloqueJurado(j) {
        const filas = j.rodeos_detalle || [];
        if (filas.length === 0) {
            return `<tbody class="rj-grupo"><tr class="rj-detalle">${celdasIdentidad(j, 1)}
                <td colspan="${COLS - 3}" class="rj-vacio">Sin rodeos con pago en el período.</td></tr>${filaSubtotal(j)}</tbody>`;
        }
        const detalle = filas.map((f, i) => `<tr class="rj-detalle${i % 2 === 1 ? ' rj-alt' : ''}">
            ${i === 0 ? celdasIdentidad(j, filas.length) : ''}
            <td class="centro">${f.n}</td>
            <td class="rj-fecha">${fecha(f.fecha)}</td>
            <td class="rj-texto">${esc(f.asociacion)}</td>
            <td class="rj-texto">${esc(f.club)}</td>
            <td class="centro">${esc(f.categoria || '—')}</td>
            <td class="rj-texto">${esc(f.tipo_rodeo)}${f.duracion_dias > 1 ? ` <span class="rj-nota">(${f.duracion_dias} días)</span>` : ''}</td>
            <td class="monto">${clp(f.pago_base)}</td>
            <td class="monto">${clp(f.bono_aprobado)}</td>
            <td class="monto"><strong>${clp(f.bruto)}</strong></td>
            <td class="monto rj-sin-monto" title="La retención se calcula sobre el total del jurado"></td>
            <td class="monto rj-sin-monto" title="El líquido se calcula sobre el total del jurado"></td>
        </tr>`).join('');
        return `<tbody class="rj-grupo">${detalle}${filaSubtotal(j)}</tbody>`;
    }

    function renderTablaResumenJurados(data) {
        const jurados = (data && data.data) || [];
        if (jurados.length === 0) return '<p class="tabla-vacia">Sin datos para los filtros seleccionados</p>';
        const t = data.totales_global || {};
        const nJur = jurados.length;
        const pct = data.retencion_porcentaje;
        const advert = ((data.conciliacion && data.conciliacion.advertencias) || [])
            .map(a => `<div>⚠ ${esc(a)}</div>`).join('');
        return `${advert ? `<div class="alerta alerta-advertencia rj-advert">${advert}</div>` : ''}
        <p class="rj-leyenda">Retención ${esc(String(pct).replace('.', ','))} %: se calcula sobre el bruto total de cada jurado en el período (cálculo oficial), por eso se informa en la fila de subtotal.</p>
        <table class="rj-tabla">
            <thead><tr>
                <th>Código</th><th>Jurado</th><th>RUT</th><th class="centro">N.º</th><th>Fecha</th>
                <th>Asociación organizadora</th><th>Club organizador</th><th class="centro">Cat.</th><th>Tipo de rodeo</th>
                <th class="monto">Pago base</th><th class="monto">Bono</th><th class="monto">Total bruto</th>
                <th class="monto">Retención</th><th class="monto">Líquido</th>
            </tr></thead>
            ${jurados.map(bloqueJurado).join('')}
            <tfoot><tr class="rj-total">
                <td colspan="9">TOTAL GENERAL DEL REPORTE — ${nJur} ${nJur === 1 ? 'jurado' : 'jurados'} · ${t.cant_rodeos || 0} ${t.cant_rodeos === 1 ? 'asignación' : 'asignaciones'}</td>
                <td class="monto">${clp(t.total_pago_base)}</td>
                <td class="monto">${clp(t.total_bono_aprobado)}</td>
                <td class="monto">${clp(t.bruto)}</td>
                <td class="monto">-${clp(t.retencion_monto)}</td>
                <td class="monto">${clp(t.liquido)}</td>
            </tr></tfoot>
        </table>`;
    }

    function renderStatsResumen(data) {
        const t = (data && data.totales_global) || {};
        const n = ((data && data.data) || []).length;
        return `
        <div class="stat-card"><div class="val">${n}</div><div class="lbl">Jurados</div></div>
        <div class="stat-card"><div class="val">${t.cant_rodeos || 0}</div><div class="lbl">Asignaciones</div></div>
        <div class="stat-card"><div class="val">${clp(t.total_pago_base || 0)}</div><div class="lbl">Total pago base</div></div>
        <div class="stat-card"><div class="val">${clp(t.total_bono_aprobado || 0)}</div><div class="lbl">Total bonos</div></div>
        <div class="stat-card"><div class="val">${clp(t.bruto || 0)}</div><div class="lbl">Total bruto</div></div>
        <div class="stat-card"><div class="val">${clp(t.liquido || 0)}</div><div class="lbl">Total líquido</div></div>`;
    }

    const api = { renderTablaResumenJurados, renderStatsResumen, _esc: esc, _clp: clp, _fecha: fecha };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.ResumenJuradosTabla = api;
})();
