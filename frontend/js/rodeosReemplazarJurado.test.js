// Protección estática + ejecución REAL del código extraído (mismo patrón
// que historialResponsablesAdmin.test.js: este proyecto no tiene entorno
// DOM para frontend — no hay Playwright/Puppeteer instalado ni navegador
// automatizado disponible en esta sesión; ver el informe de la ronda de
// validación final de Fase 1B). Se extrae el bloque REAL de
// "REEMPLAZAR JURADO" de admin/rodeos.html (abrirReemplazarJurado,
// buscarJuradoReemplazo, cargarCandidatosReemplazo, renderCandidatosReemplazo,
// seleccionarCandidatoReemplazo, seleccionarJuradoReemplazo,
// actualizarBotonConfirmarReemplazo, guardarReemplazoJurado) en un único
// scope compartido (comparten rjMotivosCache/rjAnteriorId/_rjRodeoId/
// _rjAsigId/_rjCandidatos por closure, tal como en el archivo real) y se
// ejecuta con un DOM y un `api` simulados — nunca se reimplementa la
// lógica, se corre la función real.
//
// Esto es la "alternativa local segura" indicada cuando no hay navegador
// automatizado disponible — no sustituye una prueba en navegador real, que
// sigue pendiente (ver informe).
//
// Buscador enriquecido (mejora sobre el pedido): reutiliza rdrHtmlResumen/
// rdrLineaHistorial/rdrFechaDDMMAAAA REALES (mismo módulo que ya usa
// "Designar jurado", nunca una reimplementación) y simula
// confirmarDesignacionConAdvertencia/construirContenidoAdvertenciaDesignacion
// (definidas más arriba en rodeos.html, fuera del bloque extraído — se
// pasan como helpers ya existentes, igual que sanitizar/mostrarToast/confirmar).
const fs = require('fs');
const path = require('path');
const R = require('./rodeoDesignarResumen');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'rodeos.html'), 'utf8').replace(/\r\n/g, '\n');

function extraerBloqueReemplazoJurado() {
    const inicio = html.indexOf('// ── REEMPLAZAR JURADO');
    const fin = html.indexOf('\n}', html.indexOf('async function guardarReemplazoJurado')) + 2;
    return html.slice(inicio, fin);
}
const BLOQUE = extraerBloqueReemplazoJurado();

// DOM simulado mínimo: suficiente para que el código real corra sin tocar
// un navegador. Cada elemento es un objeto con .value/.innerHTML/.disabled/
// .textContent y un classList simulado.
function crearDomFalso(valoresIniciales = {}) {
    const elementos = {};
    const crearElemento = (id) => ({
        id, value: valoresIniciales[id] ?? '', innerHTML: '', disabled: false, textContent: '',
        classList: { remove() {}, add() {}, toggle() {} }
    });
    return {
        getElementById(id) {
            if (!elementos[id]) elementos[id] = crearElemento(id);
            return elementos[id];
        },
        _elementos: elementos
    };
}

function crearEntorno({
    rodeoActual, apiGetMotivos, apiGetCandidatos, apiGetCandidatosError, apiPostResultado, apiPostValidarHistorial,
    confirmarResultado = true, confirmarAdvertenciaResultado = true
} = {}) {
    const llamadas = { apiGet: [], apiPost: [], toasts: [], errores: [], verDetalleCon: [] };
    const dom = crearDomFalso();
    const sandbox = {
        document: dom,
        rodeoActual: rodeoActual || { asignaciones: [] },
        // Helpers reales de rodeoDesignarResumen.js (mismo módulo que carga
        // <script src="/js/rodeoDesignarResumen.js"> en la página real).
        ...R,
        api: {
            get: async (url) => {
                llamadas.apiGet.push(url);
                if (url.includes('/jurados-candidatos-reemplazo')) {
                    if (apiGetCandidatosError) throw apiGetCandidatosError;
                    return apiGetCandidatos ?? { candidatos: [] };
                }
                if (url.includes('/motivos-designacion')) return apiGetMotivos ?? { motivos: [] };
                return {};
            },
            post: async (url, body) => {
                llamadas.apiPost.push({ url, body });
                if (url.includes('/validar-historial')) return apiPostValidarHistorial ?? { repite_asociacion: null, fecha_consecutiva: null };
                if (apiPostResultado?.error) throw apiPostResultado.error;
                return apiPostResultado ?? {};
            }
        },
        sanitizar: (s) => s,
        mostrarToast: (msg, tipo) => llamadas.toasts.push({ msg, tipo }),
        mostrarError: (err) => llamadas.errores.push(err),
        confirmar: async () => confirmarResultado,
        // Definidas fuera del bloque extraído (sección "Designar jurado" de
        // rodeos.html) — se simulan igual que cualquier otro helper ya
        // existente que el bloque consume sin redefinirlo.
        confirmarDesignacionConAdvertencia: async () => confirmarAdvertenciaResultado,
        construirContenidoAdvertenciaDesignacion: (nombre, val) => `<div>${nombre}</div>`,
        verDetalle: (rodeoId) => llamadas.verDetalleCon.push(rodeoId)
    };
    const fn = new Function(...Object.keys(sandbox), `${BLOQUE}
        return { abrirReemplazarJurado, buscarJuradoReemplazo, cargarCandidatosReemplazo, renderCandidatosReemplazo, seleccionarCandidatoReemplazo, seleccionarJuradoReemplazo, actualizarBotonConfirmarReemplazo, guardarReemplazoJurado };`);
    const api_ = fn(...Object.values(sandbox));
    return { ...api_, dom, llamadas, sandbox };
}

describe('rodeos.html (admin) — modal "Reemplazar jurado" (Fase 1B)', () => {
    test('abrirReemplazarJurado: carga los motivos del catálogo desde el endpoint correcto', async () => {
        const asig = { id: 'asig-1', usuarios_pagados: { id: 'jur-A', nombre_completo: 'Jurado A' }, categoria_aplicada: 'A' };
        const { abrirReemplazarJurado, llamadas, dom } = crearEntorno({
            rodeoActual: { asignaciones: [asig] },
            apiGetMotivos: { motivos: [{ id: 'm1', codigo: 'otro', etiqueta: 'Otro' }] }
        });
        await abrirReemplazarJurado('asig-1', 'rodeo-1');
        expect(llamadas.apiGet).toContain('/admin/asignaciones/motivos-designacion');
        expect(dom.getElementById('modal-titulo').textContent).toBe('Reemplazar jurado');
    });

    test('abrirReemplazarJurado: el modal muestra la identidad del jurado anterior', async () => {
        const asig = { id: 'asig-1', usuarios_pagados: { id: 'jur-A', nombre_completo: 'Juan Pérez' }, categoria_aplicada: 'A' };
        const { abrirReemplazarJurado, dom } = crearEntorno({ rodeoActual: { asignaciones: [asig] } });
        await abrirReemplazarJurado('asig-1', 'rodeo-1');
        expect(dom.getElementById('modal-body').innerHTML).toContain('Juan Pérez');
        expect(dom.getElementById('modal-body').innerHTML).toContain('Jurado actual');
    });

    test('el formulario incluye el selector de motivo (obligatorio) y el campo de comentario opcional', async () => {
        const asig = { id: 'asig-1', usuarios_pagados: { id: 'jur-A', nombre_completo: 'Juan Pérez' } };
        const { abrirReemplazarJurado, dom } = crearEntorno({
            rodeoActual: { asignaciones: [asig] },
            apiGetMotivos: { motivos: [{ id: 'm1', codigo: 'jurado_no_disponible', etiqueta: 'Indisponibilidad del jurado' }] }
        });
        await abrirReemplazarJurado('asig-1', 'rodeo-1');
        const body = dom.getElementById('modal-body').innerHTML;
        expect(body).toMatch(/id="rj-motivo"[^>]*required/);
        expect(body).toContain('Indisponibilidad del jurado');
        expect(body).toMatch(/id="rj-comentario"/);
        expect(body).not.toMatch(/id="rj-comentario"[^>]*required/);
    });

    test('el botón "Confirmar reemplazo" se renderiza deshabilitado por defecto en el HTML (atributo disabled literal)', async () => {
        const asig = { id: 'asig-1', usuarios_pagados: { id: 'jur-A', nombre_completo: 'Juan Pérez' } };
        const { abrirReemplazarJurado, dom } = crearEntorno({ rodeoActual: { asignaciones: [asig] } });
        await abrirReemplazarJurado('asig-1', 'rodeo-1');
        expect(dom.getElementById('modal-body').innerHTML).toMatch(/id="rj-btn-confirmar"[^>]*disabled/);
    });

    test('actualizarBotonConfirmarReemplazo: solo se habilita con jurado Y motivo elegidos (no permite confirmaciones ambiguas)', async () => {
        const asig = { id: 'asig-1', usuarios_pagados: { id: 'jur-A', nombre_completo: 'Juan Pérez' } };
        const { abrirReemplazarJurado, actualizarBotonConfirmarReemplazo, dom } = crearEntorno({ rodeoActual: { asignaciones: [asig] } });
        await abrirReemplazarJurado('asig-1', 'rodeo-1');

        // El fake DOM no interpreta el atributo HTML "disabled" (no es un parser
        // real) — se fija el estado inicial explícitamente, tal como lo deja el
        // navegador real al renderizar el <button ... disabled> de arriba, y se
        // prueba la lógica real de transición de actualizarBotonConfirmarReemplazo().
        const btn = dom.getElementById('rj-btn-confirmar');
        btn.disabled = true;

        dom.getElementById('rj-usr-id').value = 'jur-B';
        actualizarBotonConfirmarReemplazo();
        expect(btn.disabled).toBe(true); // falta el motivo

        dom.getElementById('rj-motivo').value = 'otro';
        actualizarBotonConfirmarReemplazo();
        expect(btn.disabled).toBe(false); // ambos presentes

        dom.getElementById('rj-usr-id').value = '';
        actualizarBotonConfirmarReemplazo();
        expect(btn.disabled).toBe(true); // se deshabilita de nuevo si se pierde la selección
    });

    test('seleccionarJuradoReemplazo: fija el id del nuevo jurado y muestra su identidad', async () => {
        const asig = { id: 'asig-1', usuarios_pagados: { id: 'jur-A', nombre_completo: 'Juan Pérez' } };
        const { abrirReemplazarJurado, seleccionarJuradoReemplazo, dom } = crearEntorno({ rodeoActual: { asignaciones: [asig] } });
        await abrirReemplazarJurado('asig-1', 'rodeo-1');
        seleccionarJuradoReemplazo('jur-B', 'Pedro Soto', 'A');
        expect(dom.getElementById('rj-usr-id').value).toBe('jur-B');
        expect(dom.getElementById('rj-persona-sel').textContent).toContain('Pedro Soto');
    });

    test('guardarReemplazoJurado: sin jurado seleccionado -> toast de error, nunca llama a la API', async () => {
        const { guardarReemplazoJurado, llamadas, dom } = crearEntorno();
        dom.getElementById('rj-usr-id').value = '';
        dom.getElementById('rj-motivo').value = 'otro';
        const ev = { preventDefault() {}, target: { querySelector: () => ({ disabled: false }) } };
        await guardarReemplazoJurado(ev, 'asig-1', 'rodeo-1');
        expect(llamadas.apiPost).toHaveLength(0);
        expect(llamadas.toasts[0].tipo).toBe('error');
    });

    test('guardarReemplazoJurado: pide confirmación antes de enviar — si se cancela, NUNCA llama a la API', async () => {
        const { guardarReemplazoJurado, llamadas, dom } = crearEntorno({ confirmarResultado: false });
        dom.getElementById('rj-usr-id').value = 'jur-B';
        dom.getElementById('rj-motivo').value = 'otro';
        const ev = { preventDefault() {}, target: { querySelector: () => ({ disabled: false }) } };
        await guardarReemplazoJurado(ev, 'asig-1', 'rodeo-1');
        expect(llamadas.apiPost).toHaveLength(0);
    });

    test('guardarReemplazoJurado: éxito -> POST al endpoint correcto con el cuerpo correcto, toast de éxito, refresca el detalle', async () => {
        const { guardarReemplazoJurado, llamadas, dom } = crearEntorno({
            apiPostResultado: { asignacion: { id: 'asig-1' }, bitacora_id: 'bit-1' }
        });
        dom.getElementById('rj-usr-id').value = 'jur-B';
        dom.getElementById('rj-motivo').value = 'jurado_no_disponible';
        dom.getElementById('rj-comentario').value = 'Viaje de urgencia';
        const ev = { preventDefault() {}, target: { querySelector: () => ({ disabled: false }) } };
        await guardarReemplazoJurado(ev, 'asig-1', 'rodeo-1');

        expect(llamadas.apiPost).toHaveLength(1);
        expect(llamadas.apiPost[0].url).toBe('/admin/asignaciones/asig-1/reemplazar');
        expect(llamadas.apiPost[0].body).toMatchObject({
            usuario_pagado_id_nuevo: 'jur-B', motivo_codigo: 'jurado_no_disponible', motivo_detalle: 'Viaje de urgencia'
        });
        expect(llamadas.toasts.some(t => t.tipo === 'success')).toBe(true);
        expect(llamadas.verDetalleCon).toContain('rodeo-1');
    });

    test('guardarReemplazoJurado: error por ANTECEDENTE_SENSIBLE_BONO -> mostrarError, NO se interpreta como conflicto de otro admin', async () => {
        const err = { message: 'Esta asignación tiene un bono de distancia aprobado con monto real...', data: { code: 'ANTECEDENTE_SENSIBLE_BONO' } };
        const { guardarReemplazoJurado, llamadas, dom } = crearEntorno({ apiPostResultado: { error: err } });
        dom.getElementById('rj-usr-id').value = 'jur-B';
        dom.getElementById('rj-motivo').value = 'otro';
        const ev = { preventDefault() {}, target: { querySelector: () => ({ disabled: false }) } };
        await guardarReemplazoJurado(ev, 'asig-1', 'rodeo-1');
        expect(llamadas.errores).toHaveLength(1);
        expect(llamadas.errores[0]).toBe(err);
        expect(llamadas.verDetalleCon).toHaveLength(0); // no se recarga automáticamente en este caso
    });

    test('guardarReemplazoJurado: error por CRUCE_DISPONIBILIDAD -> mostrarError con el mensaje del backend', async () => {
        const err = { message: 'El jurado nuevo ya está asignado a otro rodeo en fechas que se cruzan.', data: { code: 'CRUCE_DISPONIBILIDAD' } };
        const { guardarReemplazoJurado, llamadas, dom } = crearEntorno({ apiPostResultado: { error: err } });
        dom.getElementById('rj-usr-id').value = 'jur-B';
        dom.getElementById('rj-motivo').value = 'otro';
        const ev = { preventDefault() {}, target: { querySelector: () => ({ disabled: false }) } };
        await guardarReemplazoJurado(ev, 'asig-1', 'rodeo-1');
        expect(llamadas.errores).toHaveLength(1);
        expect(llamadas.errores[0].message).toMatch(/fechas que se cruzan/);
    });

    test('guardarReemplazoJurado: error por CONFLICTO_DESIGNACION_MODIFICADA -> aviso específico de "otro administrador" y refresca el detalle', async () => {
        const err = { message: 'conflicto', data: { code: 'CONFLICTO_DESIGNACION_MODIFICADA' } };
        const { guardarReemplazoJurado, llamadas, dom } = crearEntorno({ apiPostResultado: { error: err } });
        dom.getElementById('rj-usr-id').value = 'jur-B';
        dom.getElementById('rj-motivo').value = 'otro';
        const ev = { preventDefault() {}, target: { querySelector: () => ({ disabled: false }) } };
        await guardarReemplazoJurado(ev, 'asig-1', 'rodeo-1');
        expect(llamadas.toasts.some(t => /otro administrador/.test(t.msg))).toBe(true);
        expect(llamadas.verDetalleCon).toContain('rodeo-1');
        expect(llamadas.errores).toHaveLength(0); // este caso usa su propio mensaje, no el genérico
    });
});

describe('rodeos.html (admin) — buscador de reemplazo enriquecido (historial/disponibilidad/conflictos)', () => {
    const asig = { id: 'asig-1', usuarios_pagados: { id: 'jur-ANTERIOR', nombre_completo: 'Fernando Reyes' }, categoria_aplicada: 'A' };

    test('abrirReemplazarJurado: consulta el endpoint de candidatos con asignacion_id del slot a reemplazar', async () => {
        const { abrirReemplazarJurado, llamadas } = crearEntorno({ rodeoActual: { asignaciones: [asig] } });
        await abrirReemplazarJurado('asig-1', 'rodeo-huemul');
        const url = llamadas.apiGet.find(u => u.includes('jurados-candidatos-reemplazo'));
        expect(url).toContain('/admin/rodeos/rodeo-huemul/jurados-candidatos-reemplazo');
        expect(url).toContain('asignacion_id=asig-1');
    });

    test('candidato disponible: botón "Seleccionar" habilitado, sin avisos de bloqueo', async () => {
        const { abrirReemplazarJurado, dom } = crearEntorno({
            rodeoActual: { asignaciones: [asig] },
            apiGetCandidatos: { candidatos: [{ id: 'J1', nombre_completo: 'Jorge Morales', categoria: 'A', asociacion: 'X', comuna: 'Y', designaciones: 2, historial: [], repite_asociacion: false, disponibilidad_declarada: true, ya_asignado_en_rodeo: false, conflictos: [] }] }
        });
        await abrirReemplazarJurado('asig-1', 'rodeo-1');
        const body = dom.getElementById('rj-resultados').innerHTML;
        expect(body).toContain('Jorge Morales');
        expect(body).toMatch(/onclick="seleccionarCandidatoReemplazo\('J1','Jorge Morales','A',false\)"[^>]*>Seleccionar/);
        expect(body).not.toMatch(/disabled/);
    });

    test('candidato con conflicto de fechas: NUNCA se oculta, muestra club/asociación/fechas del rodeo en conflicto, botón deshabilitado', async () => {
        const { abrirReemplazarJurado, dom } = crearEntorno({
            rodeoActual: { id: 'rodeo-1', club: 'HUEMUL', asignaciones: [asig] },
            apiGetCandidatos: { candidatos: [{
                id: 'J-JORGE', nombre_completo: 'Jorge Patricio Morales González', categoria: 'A', asociacion: 'X', comuna: 'Y',
                designaciones: 5, historial: [], repite_asociacion: false, disponibilidad_declarada: true, ya_asignado_en_rodeo: false,
                conflictos: [{ rodeo_id: 'R-BULNES', club: 'BULNES', asociacion: 'ÑUBLE CORDILLERA', fecha_inicio: '2026-11-07', fecha_fin: '2026-11-08', tipo_rodeo: 'Provincial', estado_designacion: 'pendiente' }]
            }] }
        });
        await abrirReemplazarJurado('asig-1', 'rodeo-1');
        const body = dom.getElementById('rj-resultados').innerHTML;
        expect(body).toContain('Jorge Patricio Morales González'); // visible, nunca oculto
        expect(body).toMatch(/YA DESIGNADO EN OTRO RODEO/);
        expect(body).toContain('BULNES');
        expect(body).toContain('ÑUBLE CORDILLERA');
        expect(body).toContain('07-11-2026');
        expect(body).toContain('08-11-2026');
        expect(body).toMatch(/conflicto de fechas con HUEMUL/);
        expect(body).toMatch(/btn-outline" disabled>No disponible/);
    });

    test('candidato ya asignado en este mismo rodeo: visible, con aviso específico, botón deshabilitado', async () => {
        const { abrirReemplazarJurado, dom } = crearEntorno({
            rodeoActual: { asignaciones: [asig] },
            apiGetCandidatos: { candidatos: [{ id: 'J1', nombre_completo: 'Jurado Ocupado', categoria: 'A', designaciones: 0, historial: [], repite_asociacion: false, disponibilidad_declarada: true, ya_asignado_en_rodeo: true, conflictos: [] }] }
        });
        await abrirReemplazarJurado('asig-1', 'rodeo-1');
        const body = dom.getElementById('rj-resultados').innerHTML;
        expect(body).toContain('Jurado Ocupado');
        expect(body).toMatch(/Ya asignado en este rodeo/);
        expect(body).toMatch(/disabled/);
    });

    test('candidato sin disponibilidad declarada: visible, con aviso, botón deshabilitado', async () => {
        const { abrirReemplazarJurado, dom } = crearEntorno({
            rodeoActual: { asignaciones: [asig] },
            apiGetCandidatos: { candidatos: [{ id: 'J1', nombre_completo: 'Sin Disp', categoria: 'A', designaciones: 0, historial: [], repite_asociacion: false, disponibilidad_declarada: false, ya_asignado_en_rodeo: false, conflictos: [] }] }
        });
        await abrirReemplazarJurado('asig-1', 'rodeo-1');
        const body = dom.getElementById('rj-resultados').innerHTML;
        expect(body).toMatch(/Sin disponibilidad declarada/);
        expect(body).toMatch(/disabled/);
    });

    test('sin candidatos -> mensaje de "Sin resultados" (estado vacío, no un error)', async () => {
        const { abrirReemplazarJurado, dom } = crearEntorno({ rodeoActual: { asignaciones: [asig] }, apiGetCandidatos: { candidatos: [] } });
        await abrirReemplazarJurado('asig-1', 'rodeo-1');
        expect(dom.getElementById('rj-resultados').innerHTML).toMatch(/Sin resultados/);
    });

    test('error de consulta -> mensaje de error visible, no una pantalla rota', async () => {
        const { abrirReemplazarJurado, dom } = crearEntorno({
            rodeoActual: { asignaciones: [asig] },
            apiGetCandidatosError: new Error('fallo de red')
        });
        await abrirReemplazarJurado('asig-1', 'rodeo-1');
        expect(dom.getElementById('rj-resultados').innerHTML).toMatch(/fallo de red/);
    });

    test('historial "Últimos" del candidato usa rdrLineaHistorial real (fecha DD-MM-AAAA, nunca AAAA-MM-DD)', async () => {
        const { abrirReemplazarJurado, dom } = crearEntorno({
            rodeoActual: { asignaciones: [asig] },
            apiGetCandidatos: { candidatos: [{ id: 'J1', nombre_completo: 'Con Historial', categoria: 'A', designaciones: 1, historial: [{ club: 'HUINTIL', asociacion: 'CHOAPA', fecha: '2026-09-12', nota: 4 }], repite_asociacion: false, disponibilidad_declarada: true, ya_asignado_en_rodeo: false, conflictos: [] }] }
        });
        await abrirReemplazarJurado('asig-1', 'rodeo-1');
        const body = dom.getElementById('rj-resultados').innerHTML;
        expect(body).toContain('HUINTIL | CHOAPA | 12-09-2026 | Nota: 4');
        expect(body).not.toMatch(/2026-09-12/);
    });

    test('buscador y filtro de categoría disparan una nueva consulta (debounce), y limpian la selección previa', async () => {
        jest.useFakeTimers();
        const { abrirReemplazarJurado, buscarJuradoReemplazo, llamadas, dom } = crearEntorno({ rodeoActual: { asignaciones: [asig] } });
        await abrirReemplazarJurado('asig-1', 'rodeo-1');
        dom.getElementById('rj-usr-id').value = 'J-PREV';

        dom.getElementById('rj-buscar').value = 'More';
        buscarJuradoReemplazo();
        expect(dom.getElementById('rj-usr-id').value).toBe(''); // se limpia de inmediato, sin esperar el debounce
        const antes = llamadas.apiGet.filter(u => u.includes('jurados-candidatos-reemplazo')).length;

        jest.advanceTimersByTime(400);
        await Promise.resolve(); await Promise.resolve();
        const despues = llamadas.apiGet.filter(u => u.includes('jurados-candidatos-reemplazo')).length;
        expect(despues).toBeGreaterThan(antes);
        jest.useRealTimers();
    });

    test('seleccionarCandidatoReemplazo SIN repetición de asociación: selecciona directo, nunca llama a validar-historial', async () => {
        const { abrirReemplazarJurado, seleccionarCandidatoReemplazo, llamadas, dom } = crearEntorno({ rodeoActual: { asignaciones: [asig] } });
        await abrirReemplazarJurado('asig-1', 'rodeo-1');
        await seleccionarCandidatoReemplazo('J1', 'Nuevo Jurado', 'A', false);
        expect(llamadas.apiPost.some(c => c.url.includes('validar-historial'))).toBe(false);
        expect(dom.getElementById('rj-usr-id').value).toBe('J1');
    });

    test('seleccionarCandidatoReemplazo CON repetición de asociación: reutiliza /validar-historial y el diálogo de advertencia ya existente; confirmado -> selecciona', async () => {
        const { abrirReemplazarJurado, seleccionarCandidatoReemplazo, llamadas, dom } = crearEntorno({
            rodeoActual: { asignaciones: [asig] },
            apiPostValidarHistorial: { repite_asociacion: { club: 'RANCAGUA', asociacion: 'COLCHAGUA', fecha: '2026-05-01' }, fecha_consecutiva: null },
            confirmarAdvertenciaResultado: true
        });
        await abrirReemplazarJurado('asig-1', 'rodeo-1');
        await seleccionarCandidatoReemplazo('J1', 'Repite Asociación', 'A', true);
        expect(llamadas.apiPost.some(c => c.url === '/admin/asignaciones/validar-historial' && c.body.usuario_pagado_id === 'J1')).toBe(true);
        expect(dom.getElementById('rj-usr-id').value).toBe('J1');
    });

    test('seleccionarCandidatoReemplazo CON repetición de asociación: si se cancela la advertencia, NUNCA selecciona', async () => {
        const { abrirReemplazarJurado, seleccionarCandidatoReemplazo, dom } = crearEntorno({
            rodeoActual: { asignaciones: [asig] },
            apiPostValidarHistorial: { repite_asociacion: { club: 'RANCAGUA', asociacion: 'COLCHAGUA', fecha: '2026-05-01' }, fecha_consecutiva: null },
            confirmarAdvertenciaResultado: false
        });
        await abrirReemplazarJurado('asig-1', 'rodeo-1');
        await seleccionarCandidatoReemplazo('J1', 'Repite Asociación', 'A', true);
        expect(dom.getElementById('rj-usr-id').value).toBe('');
    });
});

describe('rodeos.html (admin) — compatibilidad con el botón/modal "Editar" existente', () => {
    test('el modal "Editar asignación" ya NO ofrece cambiar la persona asignada', () => {
        const inicio = html.indexOf('async function abrirEditarAsignacion');
        const fin = html.indexOf('\n}', inicio) + 2;
        const bloque = html.slice(inicio, fin);
        expect(bloque).not.toMatch(/Cambiar persona asignada/);
        expect(bloque).toContain('Reemplazar'); // referencia al nuevo flujo, en el texto de ayuda
    });

    test('guardarEdicionAsignacion ya no envía usuario_pagado_id en el PATCH', () => {
        const inicio = html.indexOf('async function guardarEdicionAsignacion');
        const fin = html.indexOf('\n}', inicio) + 2;
        const bloque = html.slice(inicio, fin);
        expect(bloque).not.toMatch(/usuario_pagado_id/);
        expect(bloque).toMatch(/api\.patch\('\/admin\/asignaciones\/' \+ asigId, body\)/);
    });

    test('el botón "Reemplazar" solo se renderiza para tipo_persona === jurado, junto al botón "Editar" existente', () => {
        const inicio = html.indexOf("onclick=\"abrirEditarAsignacion");
        const bloque = html.slice(inicio - 200, inicio + 600);
        expect(bloque).toMatch(/tipo_persona === 'jurado'[\s\S]{0,200}abrirReemplazarJurado/);
    });
});
