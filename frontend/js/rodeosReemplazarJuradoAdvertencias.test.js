// Hotfix — modal "Reemplazar jurado" con advertencias flexibles (caso
// VICTORIA/MALLECO 14/11/2026, reproducido con datos FICTICIOS).
//
// Mismo patrón que rodeosReemplazarJurado.test.js: se extrae el bloque REAL
// de admin/rodeos.html y se ejecuta con un DOM simulado — nunca se
// reimplementa la lógica. Además se extraen las etiquetas REALES compartidas
// con "Designar jurado" (ETIQUETAS_CAUSA_JURADO/_etiquetaCausaJurado) y se
// simula document.createElement/body para operar el diálogo específico de
// advertencias (checkbox + botones) como lo haría el administrador.
const fs = require('fs');
const path = require('path');
const R = require('./rodeoDesignarResumen');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'rodeos.html'), 'utf8').replace(/\r\n/g, '\n');
const htmlPropuesta = fs.readFileSync(path.join(__dirname, '..', 'admin', 'propuesta-designacion.html'), 'utf8');

function extraer(desde, hastaFn) {
    const ini = html.indexOf(desde);
    const fin = html.indexOf('\n}', html.indexOf(hastaFn)) + 2;
    return html.slice(ini, fin);
}
const BLOQUE = extraer('// ── REEMPLAZAR JURADO', 'async function guardarReemplazoJurado');
const ETIQUETAS = extraer('const ETIQUETAS_CAUSA_JURADO', 'function _etiquetaCausaJurado');
const FILA_RODEO = extraer('function _filaRodeoAdvertencia', 'function _filaRodeoAdvertencia');

function crearDom() {
    const elementos = {};
    const dialogos = [];
    let politica = []; // cola de respuestas para diálogos: 'aceptar' | 'cancelar'
    const crearElemento = (id) => ({
        id, value: '', innerHTML: '', disabled: false, textContent: '',
        classList: { _c: new Set(), remove(c) { this._c.delete(c); }, add(c) { this._c.add(c); }, toggle() {}, contains(c) { return this._c.has(c); } }
    });
    const crearOverlay = () => {
        const hijos = {};
        const overlay = {
            className: '', innerHTML: '', removido: false,
            remove() { this.removido = true; },
            querySelector(sel) {
                if (!hijos[sel]) {
                    hijos[sel] = {
                        checked: false, disabled: sel.includes('aceptar') || sel.includes('confirmar'), onclick: null, value: '', _h: {},
                        addEventListener(ev, fn) { this._h[ev] = fn; }
                    };
                }
                return hijos[sel];
            }
        };
        return overlay;
    };
    return {
        getElementById(id) { if (!elementos[id]) elementos[id] = crearElemento(id); return elementos[id]; },
        createElement: () => crearOverlay(),
        body: {
            appendChild(overlay) {
                dialogos.push(overlay);
                const accion = politica.shift() || 'cancelar';
                Promise.resolve().then(() => {
                    const chk = overlay.querySelector('#chk-adv-reemplazo');
                    const ok = overlay.querySelector('#btn-adv-reemplazo-aceptar');
                    if (accion === 'aceptar') {
                        chk.checked = true; chk._h.change && chk._h.change();
                        if (!ok.disabled) ok.onclick(); // un botón deshabilitado nunca dispara
                    } else {
                        overlay.querySelector('#btn-adv-reemplazo-cancelar').onclick();
                    }
                });
            }
        },
        _elementos: elementos, _dialogos: dialogos,
        responderDialogos(...acciones) { politica = acciones; }
    };
}

function crearEntorno({ rodeoActual, candidatos = [], respuestasPost = [], confirmarGeneral = true } = {}) {
    const llamadas = { apiPost: [], toasts: [], errores: [], confirmaciones: [], verDetalleCon: [], advertenciaGenerica: 0 };
    const dom = crearDom();
    const sandbox = {
        document: dom,
        rodeoActual: rodeoActual || { asignaciones: [] },
        ...R,
        formatFecha: (f) => f,
        api: {
            get: async (url) => {
                if (url.includes('/jurados-candidatos-reemplazo')) return { candidatos };
                if (url.includes('/motivos-designacion')) return { motivos: [{ id: 'm1', codigo: 'jurado_no_disponible', etiqueta: 'Indisponibilidad del jurado' }] };
                return {};
            },
            post: async (url, body) => {
                llamadas.apiPost.push({ url, body });
                if (url.includes('/validar-historial')) return { repite_asociacion: null, fecha_consecutiva: null };
                const r = respuestasPost.shift();
                if (r && r.error) throw r.error;
                return r || { asignacion: { id: 'asig' }, bitacora_id: 'bit' };
            }
        },
        sanitizar: (s) => (s == null ? '' : String(s)),
        mostrarToast: (msg, tipo) => llamadas.toasts.push({ msg, tipo }),
        mostrarError: (err) => llamadas.errores.push(err),
        confirmar: async (msg) => { llamadas.confirmaciones.push(msg); return confirmarGeneral; },
        confirmarDesignacionConAdvertencia: async () => { llamadas.advertenciaGenerica++; return true; },
        construirContenidoAdvertenciaDesignacion: (nombre) => `<div>${nombre}</div>`,
        verDetalle: (id) => llamadas.verDetalleCon.push(id)
    };
    const fn = new Function(...Object.keys(sandbox), `${ETIQUETAS}\n${FILA_RODEO}\n${BLOQUE}
        return { abrirReemplazarJurado, buscarJuradoReemplazo, renderCandidatosReemplazo, seleccionarCandidatoReemplazo, guardarReemplazoJurado,
                 getSeleccion: () => _rjSeleccion };`);
    return { ...fn(...Object.values(sandbox)), dom, llamadas };
}

const evento = () => ({ preventDefault() {}, target: { querySelector: () => ({ disabled: false }) } });

// ── Datos FICTICIOS del caso Victoria ─────────────────────────────────────
const RODEO_VICTORIA = { id: 'rodeo-victoria', club: 'VICTORIA', asociacion: 'MALLECO', fecha: '2026-11-14', duracion_dias: 2, asignaciones: [
    { id: 'asig-victoria', usuarios_pagados: { id: 'jur-actual', nombre_completo: 'Jurado Actual Ficticio' }, categoria_aplicada: 'C' }
] };
const candidato = (extra = {}) => ({
    id: 'jur-reemp', nombre_completo: 'Jurado Reemplazante Ficticio', categoria: 'C', asociacion: 'OTRA', comuna: 'X',
    designaciones: 5, historial: [], repite_asociacion: false, disponibilidad_declarada: true, ya_asignado_en_rodeo: false, conflictos: [],
    estado_elegibilidad: 'DISPONIBLE_Y_HABILITADO', causas_obligatorias: [], causas_relajables: [], ...extra
});
const CAND_VICTORIA = candidato({ estado_elegibilidad: 'CON_ADVERTENCIAS', causas_relajables: ['FINDE_CONSECUTIVO'] });

async function abrir(env) {
    await env.abrirReemplazarJurado('asig-victoria', 'rodeo-victoria');
    env.dom.getElementById('rj-motivo').value = 'jurado_no_disponible';
    env.dom.getElementById('rj-comentario').value = 'El jurado titular tiene problemas personales y solicita el cambio.';
}

describe('listado de candidatos — elegibilidad visible', () => {
    test('CON_ADVERTENCIAS: muestra la causa con la etiqueta compartida corregida y deja seleccionar (botón naranja)', async () => {
        const env = crearEntorno({ rodeoActual: RODEO_VICTORIA, candidatos: [CAND_VICTORIA] });
        await abrir(env);
        const body = env.dom.getElementById('rj-resultados').innerHTML;
        expect(body).toMatch(/⚠ Advertencia \(requiere aceptación expresa\): Tiene otro rodeo el fin de semana inmediatamente anterior o siguiente/);
        expect(body).toMatch(/background:#f39c12;color:white;" onclick="seleccionarCandidatoReemplazo\('jur-reemp'/);
        expect(body).toMatch(/>Seleccionar</);
    });

    test('NO_HABILITADO: muestra la restricción obligatoria y el botón queda deshabilitado ("No habilitado", sin onclick)', async () => {
        const env = crearEntorno({ rodeoActual: RODEO_VICTORIA, candidatos: [candidato({ estado_elegibilidad: 'NO_HABILITADO', causas_obligatorias: ['MISMA_ASOCIACION'] })] });
        await abrir(env);
        const body = env.dom.getElementById('rj-resultados').innerHTML;
        expect(body).toMatch(/🚫 Restricción obligatoria: Es de la misma asociación organizadora del rodeo/);
        expect(body).toMatch(/btn-outline" disabled title="No cumple una restricción obligatoria[^"]*">No habilitado/);
        expect(body).not.toMatch(/onclick="seleccionarCandidatoReemplazo/);
    });

    test('sin evaluación de elegibilidad en la lista: se informa que se revalidará al guardar', async () => {
        const env = crearEntorno({ rodeoActual: RODEO_VICTORIA, candidatos: [candidato({ estado_elegibilidad: null })] });
        await abrir(env);
        expect(env.dom.getElementById('rj-resultados').innerHTML).toMatch(/se revalidará al guardar/);
    });

    test('la etiqueta corregida es la misma en Designar jurado (rodeos.html) y en Propuesta de Designación', () => {
        expect(html).toContain("FINDE_CONSECUTIVO: 'Tiene otro rodeo el fin de semana inmediatamente anterior o siguiente'");
        expect(htmlPropuesta).toContain("FINDE_CONSECUTIVO: 'Tiene otro rodeo el fin de semana inmediatamente anterior o siguiente'");
        expect(html).not.toContain('Trabajó el fin de semana inmediatamente anterior');
    });
});

describe('caso VICTORIA (ficticio) — selección, aceptación expresa y guardado', () => {
    test('el diálogo específico muestra jurado, rodeo y la causa; al aceptar se guarda la lista exacta y se envía con motivo y comentario', async () => {
        const env = crearEntorno({ rodeoActual: RODEO_VICTORIA, candidatos: [CAND_VICTORIA] });
        await abrir(env);
        env.dom.responderDialogos('aceptar');
        await env.seleccionarCandidatoReemplazo('jur-reemp', 'Jurado Reemplazante Ficticio', 'C', false);

        const dlg = env.dom._dialogos[0].innerHTML;
        expect(dlg).toContain('Jurado Reemplazante Ficticio');
        expect(dlg).toContain('VICTORIA | MALLECO');
        expect(dlg).toContain('Tiene otro rodeo el fin de semana inmediatamente anterior o siguiente');
        expect(dlg).toMatch(/acepto realizar el reemplazo como excepción administrativa/);
        expect(env.dom.getElementById('rj-usr-id').value).toBe('jur-reemp');
        expect(env.dom.getElementById('rj-persona-sel').textContent).toMatch(/Advertencias aceptadas: Tiene otro rodeo/);

        await env.guardarReemplazoJurado(evento(), 'asig-victoria', 'rodeo-victoria');
        expect(env.llamadas.confirmaciones[0]).toMatch(/excepción administrativa con las advertencias aceptadas/);
        const post = env.llamadas.apiPost.find(p => p.url.endsWith('/reemplazar'));
        expect(post.url).toBe('/admin/asignaciones/asig-victoria/reemplazar');
        expect(post.body).toEqual({
            usuario_pagado_id_nuevo: 'jur-reemp', motivo_codigo: 'jurado_no_disponible',
            motivo_detalle: 'El jurado titular tiene problemas personales y solicita el cambio.',
            usuario_pagado_id_anterior_esperado: 'jur-actual',
            confirmar_advertencias: true, causas_aceptadas: ['FINDE_CONSECUTIVO']
        });
        expect(env.llamadas.toasts.some(t => t.tipo === 'success')).toBe(true);
    });

    test('si el administrador RECHAZA el diálogo, no queda seleccionado y nada se envía', async () => {
        const env = crearEntorno({ rodeoActual: RODEO_VICTORIA, candidatos: [CAND_VICTORIA] });
        await abrir(env);
        env.dom.responderDialogos('cancelar');
        await env.seleccionarCandidatoReemplazo('jur-reemp', 'Jurado Reemplazante Ficticio', 'C', false);
        expect(env.dom.getElementById('rj-usr-id').value).toBe('');
        expect(env.getSeleccion()).toBeNull();
        await env.guardarReemplazoJurado(evento(), 'asig-victoria', 'rodeo-victoria');
        expect(env.llamadas.apiPost).toHaveLength(0);
    });

    test('si se cancela la confirmación GENERAL del reemplazo, no se envía nada (aunque las advertencias estén aceptadas)', async () => {
        const env = crearEntorno({ rodeoActual: RODEO_VICTORIA, candidatos: [CAND_VICTORIA], confirmarGeneral: false });
        await abrir(env);
        env.dom.responderDialogos('aceptar');
        await env.seleccionarCandidatoReemplazo('jur-reemp', 'Jurado Reemplazante Ficticio', 'C', false);
        await env.guardarReemplazoJurado(evento(), 'asig-victoria', 'rodeo-victoria');
        expect(env.llamadas.apiPost).toHaveLength(0);
    });

    test('NO_HABILITADO forzado (llamada directa) nunca se selecciona', async () => {
        const env = crearEntorno({ rodeoActual: RODEO_VICTORIA, candidatos: [candidato({ estado_elegibilidad: 'NO_HABILITADO', causas_obligatorias: ['CATEGORIA_INCOMPATIBLE'] })] });
        await abrir(env);
        await env.seleccionarCandidatoReemplazo('jur-reemp', 'X', 'C', false);
        expect(env.dom.getElementById('rj-usr-id').value).toBe('');
        expect(env.dom._dialogos).toHaveLength(0);
        expect(env.llamadas.toasts[0].tipo).toBe('error');
    });

    test('varias advertencias: se listan todas y se envían ordenadas como conjunto', async () => {
        const env = crearEntorno({ rodeoActual: RODEO_VICTORIA, candidatos: [candidato({ estado_elegibilidad: 'CON_ADVERTENCIAS', causas_relajables: ['FINDE_CONSECUTIVO', 'DISTANCIA_EXCEDIDA'] })] });
        await abrir(env);
        env.dom.responderDialogos('aceptar');
        await env.seleccionarCandidatoReemplazo('jur-reemp', 'R', 'C', false);
        expect(env.dom._dialogos[0].innerHTML).toMatch(/las siguientes advertencias/);
        expect(env.dom._dialogos[0].innerHTML).toContain('Distancia excedida');
        await env.guardarReemplazoJurado(evento(), 'asig-victoria', 'rodeo-victoria');
        expect(env.llamadas.apiPost[0].body.causas_aceptadas).toEqual(['DISTANCIA_EXCEDIDA', 'FINDE_CONSECUTIVO']);
    });

    test('sin advertencias: no hay diálogo específico y se envía confirmar_advertencias:false sin causas', async () => {
        const env = crearEntorno({ rodeoActual: RODEO_VICTORIA, candidatos: [candidato()] });
        await abrir(env);
        await env.seleccionarCandidatoReemplazo('jur-reemp', 'R', 'C', false);
        expect(env.dom._dialogos).toHaveLength(0);
        await env.guardarReemplazoJurado(evento(), 'asig-victoria', 'rodeo-victoria');
        expect(env.llamadas.apiPost[0].body.confirmar_advertencias).toBe(false);
        expect(env.llamadas.apiPost[0].body).not.toHaveProperty('causas_aceptadas', expect.anything());
    });
});

describe('la aceptación se limpia al cambiar candidato, búsqueda o rodeo', () => {
    test('escribir en el buscador descarta la aceptación anterior', async () => {
        const env = crearEntorno({ rodeoActual: RODEO_VICTORIA, candidatos: [CAND_VICTORIA] });
        await abrir(env);
        env.dom.responderDialogos('aceptar');
        await env.seleccionarCandidatoReemplazo('jur-reemp', 'R', 'C', false);
        expect(env.getSeleccion().causasAceptadas).toEqual(['FINDE_CONSECUTIVO']);
        jest.useFakeTimers(); // solo para el debounce del buscador
        try {
            env.buscarJuradoReemplazo();
            expect(env.getSeleccion()).toBeNull();
            expect(env.dom.getElementById('rj-usr-id').value).toBe('');
        } finally { jest.clearAllTimers(); jest.useRealTimers(); }
    });

    test('reabrir el modal (otro rodeo/asignación) descarta la aceptación; un id puesto a mano no hereda causas', async () => {
        const env = crearEntorno({ rodeoActual: RODEO_VICTORIA, candidatos: [CAND_VICTORIA] });
        await abrir(env);
        env.dom.responderDialogos('aceptar');
        await env.seleccionarCandidatoReemplazo('jur-reemp', 'R', 'C', false);
        await abrir(env);
        expect(env.getSeleccion()).toBeNull();
        env.dom.getElementById('rj-usr-id').value = 'jur-reemp';
        await env.guardarReemplazoJurado(evento(), 'asig-victoria', 'rodeo-victoria');
        expect(env.llamadas.apiPost[0].body.confirmar_advertencias).toBe(false);
    });
});

describe('advertencias detectadas por el backend al guardar — nueva aceptación, NUNCA reintento automático', () => {
    const err409 = (data) => ({ error: { message: 'x', data } });

    test('REQUIERE_CONFIRMACION_ADVERTENCIAS: muestra las causas, al aceptar NO reenvía solo; el siguiente guardado envía las causas', async () => {
        const env = crearEntorno({
            rodeoActual: RODEO_VICTORIA, candidatos: [candidato({ estado_elegibilidad: null })],
            respuestasPost: [err409({ code: 'REQUIERE_CONFIRMACION_ADVERTENCIAS', causas: ['FINDE_CONSECUTIVO'] })]
        });
        await abrir(env);
        await env.seleccionarCandidatoReemplazo('jur-reemp', 'Jurado Reemplazante Ficticio', 'C', false);
        env.dom.responderDialogos('aceptar');
        await env.guardarReemplazoJurado(evento(), 'asig-victoria', 'rodeo-victoria');

        expect(env.llamadas.apiPost.filter(p => p.url.endsWith('/reemplazar'))).toHaveLength(1); // sin reintento
        expect(env.dom._dialogos[0].innerHTML).toMatch(/requieren su aceptación expresa/);
        expect(env.llamadas.errores).toHaveLength(0);
        expect(env.llamadas.toasts.some(t => /Presione "Confirmar reemplazo"/.test(t.msg))).toBe(true);

        await env.guardarReemplazoJurado(evento(), 'asig-victoria', 'rodeo-victoria');
        const posts = env.llamadas.apiPost.filter(p => p.url.endsWith('/reemplazar'));
        expect(posts).toHaveLength(2);
        expect(posts[1].body).toMatchObject({ confirmar_advertencias: true, causas_aceptadas: ['FINDE_CONSECUTIVO'], motivo_codigo: 'jurado_no_disponible' });
    });

    test('ADVERTENCIAS_CAMBIARON (apareció DISTANCIA_EXCEDIDA): avisa qué cambió y exige aceptar el conjunto nuevo', async () => {
        const env = crearEntorno({
            rodeoActual: RODEO_VICTORIA, candidatos: [CAND_VICTORIA],
            respuestasPost: [err409({ code: 'ADVERTENCIAS_CAMBIARON', causas: ['DISTANCIA_EXCEDIDA', 'FINDE_CONSECUTIVO'], causas_nuevas: ['DISTANCIA_EXCEDIDA'], causas_ya_no_existen: [] })]
        });
        await abrir(env);
        env.dom.responderDialogos('aceptar', 'aceptar');
        await env.seleccionarCandidatoReemplazo('jur-reemp', 'R', 'C', false);
        await env.guardarReemplazoJurado(evento(), 'asig-victoria', 'rodeo-victoria');
        expect(env.dom._dialogos[1].innerHTML).toMatch(/Las advertencias cambiaron[\s\S]*Nuevas: Distancia excedida/);
        expect(env.getSeleccion().causasAceptadas).toEqual(['DISTANCIA_EXCEDIDA', 'FINDE_CONSECUTIVO']);
        expect(env.llamadas.apiPost.filter(p => p.url.endsWith('/reemplazar'))).toHaveLength(1);
    });

    test('ADVERTENCIAS_CAMBIARON y el administrador cancela: se limpia la selección', async () => {
        const env = crearEntorno({
            rodeoActual: RODEO_VICTORIA, candidatos: [CAND_VICTORIA],
            respuestasPost: [err409({ code: 'ADVERTENCIAS_CAMBIARON', causas: ['DISTANCIA_EXCEDIDA'], causas_nuevas: ['DISTANCIA_EXCEDIDA'], causas_ya_no_existen: ['FINDE_CONSECUTIVO'] })]
        });
        await abrir(env);
        env.dom.responderDialogos('aceptar', 'cancelar');
        await env.seleccionarCandidatoReemplazo('jur-reemp', 'R', 'C', false);
        await env.guardarReemplazoJurado(evento(), 'asig-victoria', 'rodeo-victoria');
        expect(env.dom._dialogos[1].innerHTML).toMatch(/Ya no aplican: Tiene otro rodeo/);
        expect(env.getSeleccion()).toBeNull();
        expect(env.dom.getElementById('rj-usr-id').value).toBe('');
    });

    test('ADVERTENCIAS_CAMBIARON sin causas actuales (desaparecieron): sin diálogo, aviso, y el siguiente guardado va sin causas', async () => {
        const env = crearEntorno({
            rodeoActual: RODEO_VICTORIA, candidatos: [CAND_VICTORIA],
            respuestasPost: [err409({ code: 'ADVERTENCIAS_CAMBIARON', causas: [], causas_nuevas: [], causas_ya_no_existen: ['FINDE_CONSECUTIVO'] })]
        });
        await abrir(env);
        env.dom.responderDialogos('aceptar');
        await env.seleccionarCandidatoReemplazo('jur-reemp', 'R', 'C', false);
        await env.guardarReemplazoJurado(evento(), 'asig-victoria', 'rodeo-victoria');
        expect(env.dom._dialogos).toHaveLength(1);
        expect(env.llamadas.toasts.some(t => t.tipo === 'warning')).toBe(true);
        await env.guardarReemplazoJurado(evento(), 'asig-victoria', 'rodeo-victoria');
        const posts = env.llamadas.apiPost.filter(p => p.url.endsWith('/reemplazar'));
        expect(posts[1].body.confirmar_advertencias).toBe(false);
    });

    test('RESTRICCION_OBLIGATORIA del backend: error visible, sin diálogo de aceptación', async () => {
        const env = crearEntorno({
            rodeoActual: RODEO_VICTORIA, candidatos: [candidato()],
            respuestasPost: [err409({ code: 'RESTRICCION_OBLIGATORIA', causas: ['MISMO_FINDE'] })]
        });
        await abrir(env);
        await env.seleccionarCandidatoReemplazo('jur-reemp', 'R', 'C', false);
        await env.guardarReemplazoJurado(evento(), 'asig-victoria', 'rodeo-victoria');
        expect(env.llamadas.errores).toHaveLength(1);
        expect(env.dom._dialogos).toHaveLength(0);
    });
});
