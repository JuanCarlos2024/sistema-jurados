// Protección estática + ejecución REAL del código extraído (mismo patrón
// que historialResponsablesAdmin.test.js: este proyecto no tiene entorno
// DOM para frontend — no hay Playwright/Puppeteer instalado ni navegador
// automatizado disponible en esta sesión; ver el informe de la ronda de
// validación final de Fase 1B). Se extrae el bloque REAL de
// "REEMPLAZAR JURADO" de admin/rodeos.html (abrirReemplazarJurado,
// buscarJuradoReemplazo, seleccionarJuradoReemplazo,
// actualizarBotonConfirmarReemplazo, guardarReemplazoJurado) en un único
// scope compartido (comparten rjMotivosCache/rjAnteriorId por closure, tal
// como en el archivo real) y se ejecuta con un DOM y un `api` simulados —
// nunca se reimplementa la lógica, se corre la función real.
//
// Esto es la "alternativa local segura" indicada cuando no hay navegador
// automatizado disponible — no sustituye una prueba en navegador real, que
// sigue pendiente (ver informe).
const fs = require('fs');
const path = require('path');

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

function crearEntorno({ rodeoActual, apiGetMotivos, apiPostResultado, confirmarResultado = true } = {}) {
    const llamadas = { apiGet: [], apiPost: [], toasts: [], errores: [], verDetalleCon: [] };
    const dom = crearDomFalso();
    const sandbox = {
        document: dom,
        rodeoActual: rodeoActual || { asignaciones: [] },
        api: {
            get: async (url) => { llamadas.apiGet.push(url); return apiGetMotivos ?? { motivos: [] }; },
            post: async (url, body) => {
                llamadas.apiPost.push({ url, body });
                if (apiPostResultado?.error) throw apiPostResultado.error;
                return apiPostResultado ?? {};
            }
        },
        sanitizar: (s) => s,
        mostrarToast: (msg, tipo) => llamadas.toasts.push({ msg, tipo }),
        mostrarError: (err) => llamadas.errores.push(err),
        confirmar: async () => confirmarResultado,
        verDetalle: (rodeoId) => llamadas.verDetalleCon.push(rodeoId)
    };
    const fn = new Function(...Object.keys(sandbox), `${BLOQUE}
        return { abrirReemplazarJurado, buscarJuradoReemplazo, seleccionarJuradoReemplazo, actualizarBotonConfirmarReemplazo, guardarReemplazoJurado };`);
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
