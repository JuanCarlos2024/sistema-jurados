// Corrección 2026-11-19 — "Designar jurado" con excepciones autorizadas.
//
// Ejecuta el código REAL extraído de admin/rodeos.html (designarJurado,
// confirmarDesignacionConAdvertencia, construirContenidoAdvertenciaCausas y
// sus helpers de detalle) con un DOM simulado — nunca una reimplementación.
// Datos ficticios; ninguna llamada real a la API.
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'rodeos.html'), 'utf8').replace(/\r\n/g, '\n');

function extraerFuncion(nombre) {
    let inicio = html.indexOf(`function ${nombre}(`);
    if (inicio === -1) throw new Error(`No se encontró function ${nombre}(...) en rodeos.html`);
    if (html.slice(Math.max(0, inicio - 6), inicio) === 'async ') inicio -= 6;
    let i = html.indexOf('{', inicio);
    let profundidad = 0;
    for (; i < html.length; i++) {
        if (html[i] === '{') profundidad++;
        else if (html[i] === '}') { profundidad--; if (profundidad === 0) { i++; break; } }
    }
    return html.slice(inicio, i);
}
const ETIQUETAS = html.slice(html.indexOf('const ETIQUETAS_CAUSA_JURADO'), html.indexOf('\n', html.indexOf('function _etiquetaCausaJurado')));
const CODIGO = [
    ETIQUETAS,
    ...['_lineasDetalleAdvertencia', '_detallePorCausa', '_filaRodeoAdvertencia', 'confirmarDesignacionConAdvertencia',
        'construirContenidoAdvertenciaCausas', 'verificarAsignacionCreada', 'designarJurado'].map(extraerFuncion)
].join('\n');

// DOM mínimo: cada diálogo se responde según `politica` ('aceptar' | 'cancelar' | 'clic-sin-marcar').
function crearDocumento(politica) {
    const dialogos = [];
    const crearOverlay = () => {
        const hijos = {};
        return {
            className: '', innerHTML: '', removido: false,
            remove() { this.removido = true; },
            querySelector(sel) {
                if (!hijos[sel]) {
                    hijos[sel] = { checked: false, disabled: false, onclick: null, _h: {}, addEventListener(ev, fn) { this._h[ev] = fn; } };
                }
                return hijos[sel];
            }
        };
    };
    return {
        createElement: () => crearOverlay(),
        body: {
            appendChild(overlay) {
                // El HTML real declara el botón "disabled": se refleja en el doble.
                overlay.querySelector('#btn-adv-confirmar').disabled = /id="btn-adv-confirmar" disabled/.test(overlay.innerHTML);
                const estadoInicial = overlay.querySelector('#btn-adv-confirmar').disabled;
                dialogos.push({ overlay, botonDeshabilitadoAlAbrir: estadoInicial });
                const accion = politica.shift() || 'cancelar';
                Promise.resolve().then(() => {
                    const chk = overlay.querySelector('#chk-adv-designacion');
                    const ok = overlay.querySelector('#btn-adv-confirmar');
                    if (accion === 'aceptar') {
                        chk.checked = true; chk._h.change && chk._h.change();
                        if (!ok.disabled) ok.onclick();
                    } else if (accion === 'clic-sin-marcar') {
                        if (!ok.disabled) ok.onclick(); // un botón deshabilitado nunca dispara
                        overlay.querySelector('#btn-adv-cancelar').onclick();
                    } else {
                        overlay.querySelector('#btn-adv-cancelar').onclick();
                    }
                });
            }
        },
        _dialogos: dialogos
    };
}

function entorno({ jurado, politica = ['aceptar'], motivo = { motivo_codigo: 'criterio_tecnico_area_deportiva', motivo_detalle: 'detalle' }, postImpl } = {}) {
    const llamadas = { post: [], toasts: [], errores: [], cerrar: 0, verDetalle: [], recargas: 0, motivos: 0 };
    const document = crearDocumento([...politica]);
    const api = {
        post: (endpoint, body) => {
            llamadas.post.push({ endpoint, body });
            return postImpl ? postImpl(endpoint, body) : Promise.resolve({ creadas: [{ id: 'asig-1', usuario_pagado_id: jurado.id }], errores: [] });
        }
    };
    const sanitizar = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const formatFecha = f => (f ? f.split('-').reverse().join('-') : '—');
    const fabrica = new Function(
        'document', 'sanitizar', 'formatFecha', 'rodeoActual', 'api', '_juradosDesignacion', '_designarRodeoId',
        'pedirMotivoExcepcion', 'mostrarToast', 'mostrarError', 'cerrarModal', 'verDetalle', 'cargarJuradosDesignacion',
        `${CODIGO}\nreturn { designarJurado, construirContenidoAdvertenciaCausas, _lineasDetalleAdvertencia };`
    );
    const f = fabrica(
        document, sanitizar, formatFecha, { club: 'ALBORADA DE LINARES', asociacion: 'LINARES', fecha: '2026-11-28' }, api, [jurado], 'R1',
        () => { llamadas.motivos++; return Promise.resolve(motivo); },
        (msg, tipo) => llamadas.toasts.push({ msg, tipo }),
        (err) => llamadas.errores.push(err?.message || String(err)),
        () => { llamadas.cerrar++; },
        (id) => llamadas.verDetalle.push(id),
        () => { llamadas.recargas++; }
    );
    return { ...f, llamadas, document };
}

// ── Aviso de repetición de asociación + filtro "Ocultar que repiten" ──────
function entornoLista(jurados, ocultar) {
    const elementos = { 'dj-lista': { innerHTML: '' }, 'dj-ocultar-repite': { checked: !!ocultar } };
    const sanitizar = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const formatFecha = f => (f ? f.split('-').reverse().join('-') : '—');
    const codigo = [ETIQUETAS, ...['_lineasDetalleAdvertencia', '_detallePorCausa', '_htmlRepeticionAsociacion', 'renderJuradosDesignacion'].map(extraerFuncion)].join('\n');
    const fabrica = new Function('document', 'sanitizar', 'formatFecha', '_juradosDesignacion', 'rdrLineaHistorial',
        `${codigo}\nreturn { renderJuradosDesignacion, _htmlRepeticionAsociacion };`);
    const f = fabrica({ getElementById: id => elementos[id] }, sanitizar, formatFecha, jurados, () => '');
    return { ...f, html: () => elementos['dj-lista'].innerHTML };
}
const base = (id, extra) => ({ id, nombre_completo: 'Jurado ' + id, categoria: 'C', designaciones: 0, historial: [], estado_elegibilidad: 'DISPONIBLE_Y_HABILITADO', causas_obligatorias: [], causas_relajables: [], detalle_advertencias: [], ...extra });
const REP_AUGUSTO = {
    asociacion: 'LINARES', intervalo_activo: true, meses: 2, desde: '2026-09-28', hasta: '2027-01-28', intervalo_cumplido: true,
    antecedentes: [{ fecha: '2026-05-01', club: 'YERBAS BUENAS', asociacion: 'LINARES', posterior: false, dentro_intervalo: false }]
};
const REP_INCUMPLIDO = {
    asociacion: 'LINARES', intervalo_activo: true, meses: 2, desde: '2026-09-28', hasta: '2027-01-28', intervalo_cumplido: false,
    antecedentes: [
        { fecha: '2027-01-09', club: 'FUTURO', asociacion: 'LINARES', posterior: true, dentro_intervalo: true },
        { fecha: '2026-05-01', club: 'YERBAS BUENAS', asociacion: 'LINARES', posterior: false, dentro_intervalo: false }
    ]
};

describe('Aviso de repetición de asociación en "Designar jurado"', () => {
    test('Augusto: Yerbas Buenas 01/05/2026 -> aviso INFORMATIVO con intervalo cumplido, botón Designar habilitado', () => {
        const e = entornoLista([base('AUG', { repite_asociacion: true, repeticion_asociacion: REP_AUGUSTO, estado_elegibilidad: 'CON_ADVERTENCIAS', causas_relajables: ['FINDE_CONSECUTIVO'] })]);
        e.renderJuradosDesignacion();
        const h = e.html();
        expect(h).toContain('data-repeticion="cumplido"');
        expect(h).toContain('ℹ Ya juzgó LINARES — última: 01-05-2026 (YERBAS BUENAS) · intervalo de 2 meses cumplido');
        expect(h).not.toContain('dentro del intervalo');
        expect(h).not.toContain('No habilitado');
        expect(h).toContain(`onclick="designarJurado('AUG')"`);
    });

    test('intervalo incumplido (incluye uno POSTERIOR) -> advertencia que requiere autorización manual, con fechas', () => {
        const e = entornoLista([base('J1', { repite_asociacion: true, repeticion_asociacion: REP_INCUMPLIDO })]);
        const h = e._htmlRepeticionAsociacion({ repite_asociacion: true, repeticion_asociacion: REP_INCUMPLIDO });
        expect(h).toContain('data-repeticion="incumplido"');
        expect(h).toContain('⚠ Repite LINARES dentro del intervalo de 2 meses: 09-01-2027 (FUTURO) — requiere autorización manual');
    });

    test('regla de intervalo desactivada -> solo informativo, sin juicio de plazo', () => {
        const e = entornoLista([]);
        const h = e._htmlRepeticionAsociacion({ repite_asociacion: true, repeticion_asociacion: { ...REP_AUGUSTO, intervalo_activo: false, intervalo_cumplido: null, meses: null } });
        expect(h).toContain('data-repeticion="informativo"');
        expect(h).not.toContain('cumplido');
    });

    test('sin antecedentes efectivos (p. ej. solo rechazadas/anuladas) -> ningún aviso', () => {
        const e = entornoLista([]);
        expect(e._htmlRepeticionAsociacion({ repite_asociacion: false, repeticion_asociacion: null })).toBe('');
    });

    test('sin datos evaluados (configuración no disponible) -> etiqueta previa como respaldo', () => {
        const e = entornoLista([]);
        expect(e._htmlRepeticionAsociacion({ repite_asociacion: true })).toContain('⚠ repite asociación');
    });

    test('filtro "Ocultar que repiten" oculta a quienes tienen antecedente (cumplido o no) y deja al resto', () => {
        const lista = [
            base('CUMPLE', { nombre_completo: 'Cumple', repite_asociacion: true, repeticion_asociacion: REP_AUGUSTO }),
            base('INCUMPLE', { nombre_completo: 'Incumple', repite_asociacion: true, repeticion_asociacion: REP_INCUMPLIDO }),
            base('LIMPIO', { nombre_completo: 'Limpio', repite_asociacion: false, repeticion_asociacion: null })
        ];
        const sinFiltro = entornoLista(lista, false); sinFiltro.renderJuradosDesignacion();
        // El nombre va seguido de la insignia de categoría (<span class="badge…">).
        for (const n of ['Cumple<span', 'Incumple<span', 'Limpio<span']) expect(sinFiltro.html()).toContain(n);
        const conFiltro = entornoLista(lista, true); conFiltro.renderJuradosDesignacion();
        expect(conFiltro.html()).toContain('Limpio<span');
        expect(conFiltro.html()).not.toContain('Cumple<span');
        expect(conFiltro.html()).not.toContain('Incumple<span');
    });
});

const DET_INTERVALO = { causa: 'ASOCIACION_REPETIDA_INTERVALO', meses: 2, asociacion: 'LINARES', origen: 'historial', rodeos: [{ club: 'YERBAS BUENAS', asociacion: 'LINARES', fecha: '2026-10-24' }] };
const DET_FINDE = { causa: 'FINDE_CONSECUTIVO', rodeos: [{ club: 'LONCOTORO', asociacion: 'LAGO LLANQUIHUE', fecha: '2026-11-21' }] };
const jur = (estado, causas = [], detalle = [], obligatorias = []) => ({
    id: 'J1', nombre_completo: 'Jurado Uno', estado_elegibilidad: estado, causas_relajables: causas, causas_obligatorias: obligatorias, detalle_advertencias: detalle
});
const postsCreacion = l => l.post.filter(p => p.endpoint === '/admin/asignaciones');

test('repetición fuera del intervalo (habilitado) -> sin diálogo, se designa sin excepción', async () => {
    const e = entorno({ jurado: jur('DISPONIBLE_Y_HABILITADO') });
    await e.designarJurado('J1');
    expect(e.document._dialogos).toHaveLength(0);
    expect(postsCreacion(e.llamadas)).toHaveLength(1);
    expect(postsCreacion(e.llamadas)[0].body.personas[0]).toEqual(expect.objectContaining({ confirmar_advertencias: false, causas_aceptadas: undefined }));
    expect(e.llamadas.toasts).toEqual([{ msg: 'Jurado Uno designado correctamente', tipo: 'success' }]);
});

test('repetición dentro del intervalo -> UN diálogo con fecha, club, asociación y meses; con checkbox + motivo se envían causas exactas', async () => {
    const e = entorno({ jurado: jur('CON_ADVERTENCIAS', ['ASOCIACION_REPETIDA_INTERVALO'], [DET_INTERVALO]) });
    await e.designarJurado('J1');
    expect(e.document._dialogos).toHaveLength(1);
    const contenido = e.document._dialogos[0].overlay.innerHTML;
    expect(contenido).toContain('YERBAS BUENAS (LINARES) — 24-10-2026');
    expect(contenido).toContain('Intervalo mínimo configurado: 2 meses');
    expect(contenido).toContain('excepción administrativa');
    expect(e.llamadas.motivos).toBe(1);
    expect(postsCreacion(e.llamadas)[0].body.personas[0]).toEqual(expect.objectContaining({
        confirmar_advertencias: true, causas_aceptadas: ['ASOCIACION_REPETIDA_INTERVALO'], motivo_codigo: 'criterio_tecnico_area_deportiva'
    }));
    // Nunca la segunda confirmación de /validar-historial.
    expect(e.llamadas.post.some(p => p.endpoint === '/admin/asignaciones/validar-historial')).toBe(false);
});

test('fin de semana consecutivo -> diálogo con el rodeo contiguo (Loncotoro) y confirmación con esa causa', async () => {
    const e = entorno({ jurado: jur('CON_ADVERTENCIAS', ['FINDE_CONSECUTIVO'], [DET_FINDE]) });
    await e.designarJurado('J1');
    expect(e.document._dialogos[0].overlay.innerHTML).toContain('Fin de semana contiguo: LONCOTORO (LAGO LLANQUIHUE) — 21-11-2026');
    expect(postsCreacion(e.llamadas)[0].body.personas[0].causas_aceptadas).toEqual(['FINDE_CONSECUTIVO']);
});

test('varias advertencias -> UNA sola confirmación que las lista todas (nunca dos diálogos)', async () => {
    const e = entorno({ jurado: jur('CON_ADVERTENCIAS', ['FINDE_CONSECUTIVO', 'ASOCIACION_REPETIDA_INTERVALO'], [DET_FINDE, DET_INTERVALO]) });
    await e.designarJurado('J1');
    expect(e.document._dialogos).toHaveLength(1);
    const contenido = e.document._dialogos[0].overlay.innerHTML;
    expect(contenido).toContain('data-causa="ASOCIACION_REPETIDA_INTERVALO"');
    expect(contenido).toContain('data-causa="FINDE_CONSECUTIVO"');
    expect(postsCreacion(e.llamadas)[0].body.personas[0].causas_aceptadas).toEqual(['ASOCIACION_REPETIDA_INTERVALO', 'FINDE_CONSECUTIVO']);
});

test('el botón de confirmar nace deshabilitado y un clic sin marcar el checkbox no designa', async () => {
    const e = entorno({ jurado: jur('CON_ADVERTENCIAS', ['ASOCIACION_REPETIDA_INTERVALO'], [DET_INTERVALO]), politica: ['clic-sin-marcar'] });
    await e.designarJurado('J1');
    expect(e.document._dialogos[0].botonDeshabilitadoAlAbrir).toBe(true);
    expect(e.llamadas.motivos).toBe(0);
    expect(postsCreacion(e.llamadas)).toHaveLength(0);
});

test('cancelación del diálogo -> no pide motivo y no crea designación', async () => {
    const e = entorno({ jurado: jur('CON_ADVERTENCIAS', ['ASOCIACION_REPETIDA_INTERVALO'], [DET_INTERVALO]), politica: ['cancelar'] });
    await e.designarJurado('J1');
    expect(e.llamadas.motivos).toBe(0);
    expect(postsCreacion(e.llamadas)).toHaveLength(0);
});

test('cancelación del motivo -> no crea designación', async () => {
    const e = entorno({ jurado: jur('CON_ADVERTENCIAS', ['ASOCIACION_REPETIDA_INTERVALO'], [DET_INTERVALO]), motivo: null });
    await e.designarJurado('J1');
    expect(postsCreacion(e.llamadas)).toHaveLength(0);
});

test('restricción estructural (NO_HABILITADO) -> ni diálogo ni llamada a la API', async () => {
    const e = entorno({ jurado: jur('NO_HABILITADO', [], [], ['DISPONIBILIDAD']) });
    await e.designarJurado('J1');
    expect(e.document._dialogos).toHaveLength(0);
    expect(e.llamadas.post).toHaveLength(0);
    expect(e.llamadas.toasts[0].tipo).toBe('error');
});

test('la elegibilidad cambió antes de guardar (ADVERTENCIAS_CAMBIARON) -> aviso claro, recarga la lista, nunca éxito', async () => {
    const e = entorno({
        jurado: jur('CON_ADVERTENCIAS', ['FINDE_CONSECUTIVO'], [DET_FINDE]),
        postImpl: () => Promise.reject({ status: 422, message: 'Las advertencias cambiaron', data: { creadas: [], errores: [{ usuario_pagado_id: 'J1', code: 'ADVERTENCIAS_CAMBIARON' }] } })
    });
    await e.designarJurado('J1');
    expect(e.llamadas.recargas).toBe(1);
    expect(e.llamadas.toasts).toEqual([expect.objectContaining({ tipo: 'error' })]);
    expect(e.llamadas.toasts.find(t => t.tipo === 'success')).toBeUndefined();
    expect(e.llamadas.cerrar).toBe(0);
});
