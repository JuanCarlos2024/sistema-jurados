// Resultados de la Serie de Campeones en la Importación de Control de
// Gestión (admin/importacion.html). Solo presentación y armado de la
// decisión: el backend revalida todo desde el Excel y la base (migración
// 101) y nunca confía en los valores que muestra esta pantalla.
(function () {
    const esc = (s) => (s === null || s === undefined) ? '' : String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

    const ESTADO = {
        listo: ['badge-activo', 'Listo para importar'],
        conflicto: ['badge-pendiente', 'Conflicto con valores existentes'],
        sin_cambios: ['badge-activo', 'Ya registrados (sin cambios)'],
        sin_resultados: ['', 'No informados'],
        sin_rodeo_id: ['badge-anulado', 'Sin Rodeo ID'],
        rodeo_no_encontrado: ['badge-anulado', 'Rodeo ID no encontrado'],
        advertencia: ['badge-pendiente', 'Advertencia de vinculación'],
        duplicada: ['', 'Duplicada'],
        error: ['badge-anulado', 'Error']
    };
    const APLICABLES = ['listo', 'conflicto', 'sin_cambios'];

    // Celda de la previsualización: "1°: 27+8" por cada lugar informado,
    // con el valor ya registrado al lado cuando existe.
    function cgrsHtmlCelda(rs, idx) {
        if (!rs || !rs.columnas_presentes) return '<span style="color:var(--gris); font-size:11px;">—</span>';
        const [clase, etiqueta] = ESTADO[rs.estado] || ['', rs.estado];
        const lineas = (rs.lugares || []).filter(l => l.excel !== null).map(l => {
            let extra = '';
            if (l.comparacion === 'conflicto') extra = ` <span style="color:#c0392b;">⚠ registrado: ${esc(l.actual)}</span>`;
            else if (l.comparacion === 'igual') extra = ' <span style="color:var(--gris);">(ya registrado)</span>';
            else if (l.comparacion === 'nuevo') extra = ' <span style="color:#27ae60;">(nuevo)</span>';
            return `<div>${l.lugar}°: <strong>${esc(l.excel)}</strong>${extra}</div>`;
        }).join('');
        const errores = (rs.errores || []).length
            ? `<div style="color:#c0392b; margin-top:4px;">${rs.errores.map(esc).join('<br>')}</div>` : '';
        let control = '';
        if (rs.estado === 'listo') {
            control = `<select id="cg-res-accion-${idx}" class="form-control" style="font-size:12px; margin-top:4px;">
                <option value="completar" selected>Importar resultados</option>
                <option value="omitir">Omitir resultados</option>
            </select>`;
        } else if (rs.estado === 'conflicto') {
            control = `<select id="cg-res-accion-${idx}" class="form-control" style="font-size:12px; margin-top:4px;">
                <option value="completar" selected>Conservar existentes (solo completar vacíos)</option>
                <option value="reemplazar">Reemplazar con valores del Excel</option>
                <option value="omitir">Omitir resultados</option>
            </select>`;
        }
        return `<div style="font-size:11px; min-width:150px;">
            <span class="badge ${clase}">${esc(etiqueta)}</span>
            ${lineas ? `<div style="margin-top:4px;">${lineas}</div>` : ''}
            ${errores}${control}
        </div>`;
    }

    // Decisión que viaja al backend. 'reemplazar' adjunta los valores que el
    // administrador VIO: la RPC solo reemplaza si siguen siendo esos.
    function cgrsDecision(rs, valorSelect) {
        if (!rs || !APLICABLES.includes(rs.estado)) return { accion_resultados: 'omitir' };
        const accion = rs.estado === 'sin_cambios' ? 'completar' : (valorSelect || 'omitir');
        if (accion !== 'reemplazar') return { accion_resultados: accion };
        return {
            accion_resultados: 'reemplazar',
            resultados_actuales_vistos: [1, 2, 3].map(n => {
                const l = (rs.lugares || []).find(x => x.lugar === n);
                return l && l.actual !== null && l.actual !== undefined ? String(l.actual) : null;
            })
        };
    }

    // Texto de confirmación cuando se pidió reemplazar valores existentes.
    function cgrsTextoConfirmacionReemplazo(filas, decisiones) {
        const lineas = [];
        decisiones.forEach(d => {
            if (d.accion_resultados !== 'reemplazar') return;
            const f = filas.find(x => x.fila_index === d.fila_index);
            (f?.resultados_serie?.lugares || []).filter(l => l.comparacion === 'conflicto').forEach(l => {
                lineas.push(`${esc(f.club || 'Rodeo')} ${esc(f.fecha || '')} — ${l.lugar}°: ${esc(l.actual)} → ${esc(l.excel)}`);
            });
        });
        if (!lineas.length) return null;
        return `Se reemplazarán ${lineas.length} puntaje(s) ya registrados:<br><br>${lineas.join('<br>')}<br><br>¿Confirmar?`;
    }

    function cgrsHtmlResumenPreview(r) {
        if (!r || !r.columnas_presentes) {
            return '<div class="texto-gris" style="font-size:12px; margin-top:8px;">Resultados Serie de Campeones: el Excel no trae las columnas "1° / 2° / 3° lugar puntaje" (formato anterior) — se importa igual que siempre.</div>';
        }
        return `<div style="font-size:13px; margin-top:10px;"><strong>Resultados Serie de Campeones:</strong>
            ${r.filas_con_resultados} fila(s) con resultados · ${r.listos} listas · ${r.conflictos} con conflicto ·
            ${r.sin_cambios} sin cambios · ${r.sin_resultados} sin resultados · ${r.rodeo_id_no_encontrados} Rodeo ID no encontrado ·
            ${r.sin_rodeo_id} sin Rodeo ID · ${r.con_error} con error</div>`;
    }

    function cgrsHtmlResultadoFinal(r) {
        if (!r) return '';
        if (r.error_general) {
            return `<div class="alerta alerta-advertencia" style="margin-top:16px;">⚠️ Resultados Serie de Campeones: no se pudieron procesar (${esc(r.error_general)}). El resto de la importación no se vio afectado.</div>`;
        }
        if (!r.columnas_presentes) return '';
        const item = (n, t, c = '') => `<div class="res-item ${c}"><div class="numero">${n}</div><div class="texto">${t}</div></div>`;
        const problemas = (r.detalle || []).filter(d => d.errores && d.errores.length && d.resultado !== 'duplicada');
        const conflictos = (r.detalle || []).filter(d => (d.lugares || []).some(l => /^conflicto/.test(l.estado || '') || l.estado === 'reemplazado'));
        return `<h3 style="margin:20px 0 10px; font-size:15px;">🏆 Resultados Serie de Campeones</h3>
        <div class="resultado-importacion">
            ${item(r.rodeos_procesados, 'Rodeos procesados', 'azul')}
            ${item(r.importados_1, 'Resultados 1° lugar importados', 'verde')}
            ${item(r.importados_2, 'Resultados 2° lugar importados', 'verde')}
            ${item(r.importados_3, 'Resultados 3° lugar importados', 'verde')}
            ${item(r.rodeos_sin_resultados, 'Rodeos sin resultados informados')}
            ${item(r.conflictos, 'Conflictos con resultados existentes', 'naranja')}
            ${item(r.rodeo_id_no_encontrados, 'Rodeo ID no encontrados', 'rojo')}
        </div>
        <div style="font-size:12px; margin-top:8px;" class="texto-gris">
            Reemplazados: ${r.reemplazados} · Conflictos conservados: ${r.conflictos_conservados} · Ya registrados iguales: ${r.iguales} ·
            Sin Rodeo ID: ${r.sin_rodeo_id} · Con error: ${r.con_error} · Omitidos: ${r.omitidos_por_usuario}
        </div>
        ${conflictos.length ? `<div style="font-size:12px; margin-top:8px;"><strong>Conflictos:</strong><br>${conflictos.map(d =>
            `Fila ${d.fila_index + 1}: ${(d.lugares || []).filter(l => /^conflicto/.test(l.estado) || l.estado === 'reemplazado').map(l =>
                `${l.lugar}° registrado ${esc(l.anterior)} / Excel ${esc(l.excel)} → ${l.estado === 'reemplazado' ? 'reemplazado' : 'se conservó el registrado'}`).join('; ')}`).join('<br>')}</div>` : ''}
        ${problemas.length ? `<div style="font-size:12px; margin-top:8px; color:#c0392b;">${problemas.map(d =>
            `Fila ${d.fila_index + 1}: ${d.errores.map(esc).join(' ')}`).join('<br>')}</div>` : ''}`;
    }

    const exportar = { cgrsHtmlCelda, cgrsDecision, cgrsTextoConfirmacionReemplazo, cgrsHtmlResumenPreview, cgrsHtmlResultadoFinal };
    if (typeof window !== 'undefined') Object.assign(window, exportar);
    if (typeof module !== 'undefined' && module.exports) module.exports = exportar;
})();
