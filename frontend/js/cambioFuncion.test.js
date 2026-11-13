// Cambio de función Jurado <-> Delegado Rentado — frontend compartido
// (frontend/js/cambioFuncion.js) ejecutado con un DOM simulado, más las
// integraciones en admin/usuarios.html y admin/hojavida.html.
const fs = require('fs');
const path = require('path');

const ADMIN = path.join(__dirname, '..', 'admin');
const leer = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const escapar = (s) => (s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;') : '');

function entorno({ verificacion, errorGet, respuestaPatch, confirma = true } = {}) {
    const el = (id) => ({ id, textContent: '', innerHTML: '', disabled: false, classList: { remove: jest.fn(), add: jest.fn() } });
    const nodos = { 'modal-titulo': el('modal-titulo'), 'modal-contenido': el('modal-contenido'), 'modal-overlay': el('modal-overlay'), 'cf-btn-guardar': el('cf-btn-guardar') };
    global.document = { getElementById: (id) => nodos[id] || null };
    global.api = {
        get: jest.fn(() => (errorGet ? Promise.reject(errorGet) : Promise.resolve(verificacion))),
        patch: jest.fn(() => Promise.resolve(respuestaPatch || { mensaje: 'Función actualizada' }))
    };
    global.sanitizar = escapar;
    global.formatFecha = (f) => `F(${f})`;
    global.mostrarToast = jest.fn();
    global.mostrarError = jest.fn();
    global.confirmar = jest.fn(() => Promise.resolve(confirma));
    global.cerrarModal = jest.fn();
    jest.isolateModules(() => { global.__cf = require('./cambioFuncion'); });
    return { nodos, cf: global.__cf };
}
afterEach(() => { for (const k of ['document', 'api', 'sanitizar', 'formatFecha', 'mostrarToast', 'mostrarError', 'confirmar', 'cerrarModal', '__cf']) delete global[k]; });

const V_LIBRE = {
    usuario: { id: 'U1', nombre_completo: 'ROBERTO RIVAS GONZALEZ', tipo_persona: 'jurado', categoria: 'C' },
    tipo_actual: 'jurado', tipo_destino: 'delegado_rentado', fecha_efectiva: '2026-11-13', puede_cambiar: true,
    bloqueos: { designaciones: [], cartillas_pendientes: [] },
    historico: { designaciones_como_jurado: 4, designaciones_como_delegado: 0 }
};
const evento = (campos) => ({ preventDefault: jest.fn(), target: { elements: Object.fromEntries(Object.entries(campos).map(([k, v]) => [k, { value: v }])) } });

describe('Modal de cambio de función', () => {
    test('muestra función actual, nueva función, fecha efectiva e historial que se conserva (Jurado -> DR, sin categoría)', async () => {
        const { nodos, cf } = entorno({ verificacion: V_LIBRE });
        await cf.abrirModalCambioFuncion('U1');
        expect(global.api.get).toHaveBeenCalledWith('/admin/usuarios/U1/tipo-persona/verificacion');
        const html = nodos['modal-contenido'].innerHTML;
        expect(nodos['modal-titulo'].textContent).toBe('Cambiar función — ROBERTO RIVAS GONZALEZ');
        expect(html).toMatch(/Función actual: <strong>Jurado \(categoría C\)<\/strong>/);
        expect(html).toMatch(/id="cf-destino">Delegado Rentado</);
        expect(html).toMatch(/Fecha efectiva: <strong>F\(2026-11-13\)<\/strong>/);
        expect(html).toMatch(/4 como Jurado, 0 como Delegado Rentado/);
        expect(html).toMatch(/id="cf-motivo"[^>]*required/);
        expect(html).not.toMatch(/cf-categoria/);
        expect(nodos['modal-overlay'].classList.remove).toHaveBeenCalledWith('oculto');
    });

    test('DR -> Jurado exige categoría A/B/C en el formulario', async () => {
        const { nodos, cf } = entorno({ verificacion: { ...V_LIBRE, tipo_actual: 'delegado_rentado', tipo_destino: 'jurado' } });
        await cf.abrirModalCambioFuncion('U1');
        expect(nodos['modal-contenido'].innerHTML).toMatch(/id="cf-categoria"[\s\S]*value="A"[\s\S]*value="B"[\s\S]*value="C"/);
    });

    test('5. con bloqueos: lista designaciones y cartillas, sin formulario ni botón de guardar; escapa HTML', async () => {
        const v = { ...V_LIBRE, puede_cambiar: false, bloqueos: {
            designaciones: [{ club: '<img src=x onerror=alert(1)>', asociacion: 'MALLECO', fecha: '2026-11-21', tipo_persona: 'jurado' }],
            cartillas_pendientes: [{ id: 'c1' }, { id: 'c2' }] } };
        const { nodos, cf } = entorno({ verificacion: v });
        await cf.abrirModalCambioFuncion('U1');
        const html = nodos['modal-contenido'].innerHTML;
        expect(html).toMatch(/No es posible cambiar la función todavía/);
        expect(html).toMatch(/&lt;img src=x onerror=alert\(1\)&gt; \| MALLECO — F\(2026-11-21\) \(Jurado\)/);
        expect(html).not.toMatch(/<img/);
        expect(html).toMatch(/Cartillas pendientes de su función actual: <strong>2<\/strong>/);
        expect(html).not.toMatch(/cf-form|cf-btn-guardar/);
    });

    test('error al verificar: muestra el mensaje escapado y no abre el formulario', async () => {
        const { nodos, cf } = entorno({ errorGet: new Error('<b>falló</b>') });
        await cf.abrirModalCambioFuncion('U1');
        expect(nodos['modal-contenido'].innerHTML).toBe('<p style="color:#943126;">&lt;b&gt;falló&lt;/b&gt;</p>');
    });
});

describe('Guardar', () => {
    async function abierto(v = V_LIBRE, opts = {}) {
        const ctx = entorno({ verificacion: v, ...opts });
        ctx.onExito = jest.fn();
        await ctx.cf.abrirModalCambioFuncion('U1', { onExito: ctx.onExito });
        return ctx;
    }

    test('3. sin motivo: no llama al backend', async () => {
        const { cf } = await abierto();
        await cf.cfGuardarCambioFuncion(evento({ motivo: '   ' }));
        expect(global.mostrarToast).toHaveBeenCalledWith(expect.stringMatching(/motivo/), 'error');
        expect(global.api.patch).not.toHaveBeenCalled();
    });

    test('4. a Jurado sin categoría: no llama al backend', async () => {
        const { cf } = await abierto({ ...V_LIBRE, tipo_actual: 'delegado_rentado', tipo_destino: 'jurado' });
        await cf.cfGuardarCambioFuncion(evento({ categoria: '', motivo: 'Vuelve' }));
        expect(global.mostrarToast).toHaveBeenCalledWith('Seleccione categoría A, B o C', 'error');
        expect(global.api.patch).not.toHaveBeenCalled();
    });

    test('cancelar la confirmación: no guarda', async () => {
        const { cf } = await abierto(V_LIBRE, { confirma: false });
        await cf.cfGuardarCambioFuncion(evento({ motivo: 'Pasa a DR' }));
        expect(global.confirmar).toHaveBeenCalled();
        expect(global.api.patch).not.toHaveBeenCalled();
    });

    test('1. confirmar Jurado -> DR: envía tipo, categoría null y motivo recortado; refresca y cierra', async () => {
        const { cf, onExito } = await abierto();
        await cf.cfGuardarCambioFuncion(evento({ motivo: '  Pasa a Delegado Rentado  ' }));
        expect(global.confirmar.mock.calls[0][0]).toMatch(/<strong>ROBERTO RIVAS GONZALEZ<\/strong> de Jurado a <strong>Delegado Rentado<\/strong>/);
        expect(global.api.patch).toHaveBeenCalledWith('/admin/usuarios/U1/tipo-persona', { tipo_persona: 'delegado_rentado', categoria: null, motivo: 'Pasa a Delegado Rentado' });
        expect(global.mostrarToast).toHaveBeenCalledWith('Función actualizada', 'success');
        expect(global.cerrarModal).toHaveBeenCalled();
        expect(onExito).toHaveBeenCalled();
    });

    test('2. confirmar DR -> Jurado B', async () => {
        const { cf } = await abierto({ ...V_LIBRE, tipo_actual: 'delegado_rentado', tipo_destino: 'jurado' });
        await cf.cfGuardarCambioFuncion(evento({ categoria: 'B', motivo: 'Vuelve a jurado' }));
        expect(global.confirmar.mock.calls[0][0]).toMatch(/a <strong>Jurado categoría B<\/strong>/);
        expect(global.api.patch.mock.calls[0][1]).toEqual({ tipo_persona: 'jurado', categoria: 'B', motivo: 'Vuelve a jurado' });
    });

    test('el nombre se escapa en la confirmación (confirmar() inserta HTML)', async () => {
        const { cf } = await abierto({ ...V_LIBRE, usuario: { ...V_LIBRE.usuario, nombre_completo: '<script>x</script>' } });
        await cf.cfGuardarCambioFuncion(evento({ motivo: 'm' }));
        expect(global.confirmar.mock.calls[0][0]).not.toMatch(/<script>/);
    });

    test('error del backend (p. ej. 409 designaciones): se informa y no se cierra el modal', async () => {
        const { cf } = await abierto();
        global.api.patch.mockRejectedValueOnce(Object.assign(new Error('La persona tiene designaciones vigentes o futuras.'), { status: 409 }));
        await cf.cfGuardarCambioFuncion(evento({ motivo: 'm' }));
        expect(global.mostrarError).toHaveBeenCalled();
        expect(global.cerrarModal).not.toHaveBeenCalled();
    });
});

describe('Integración en las páginas de administración', () => {
    const usuarios = leer(path.join(ADMIN, 'usuarios.html'));
    const hojavida = leer(path.join(ADMIN, 'hojavida.html'));

    test('ambas páginas cargan el módulo compartido después de utils.js y lo usan', () => {
        for (const html of [usuarios, hojavida]) {
            expect(html).toMatch(/<script src="\/js\/utils\.js"><\/script>\n<script src="\/js\/cambioFuncion\.js"><\/script>/);
            expect(html).toMatch(/abrirModalCambioFuncion\(/);
            expect(html).not.toMatch(/\/tipo-persona'?`?, \{ tipo_persona/);   // sin PATCH duplicados en la página
        }
    });

    test('Usuarios: el botón solo se ofrece a administrador pleno o Jefe Deportivo', () => {
        expect(usuarios).toMatch(/puedeCambiarFuncion = adminActual && \(adminActual\.rol_evaluacion === null \|\| adminActual\.rol_evaluacion === 'jefe_area'\)/);
        expect(usuarios).toMatch(/const btnCambioFuncion = puedeCambiarFuncion/);
    });

    test('11. Hoja de Vida: el historial administrativo muestra el cambio de función y la categoría DR', () => {
        const ini = hojavida.indexOf('function _badgeEvento');
        const fin = hojavida.indexOf('\n}\n', hojavida.indexOf('function _resumenEvento')) + 3;
        const ctx = {};
        new Function('sanitizar', 'ctx', hojavida.slice(ini, fin) + '\nctx.badge = _badgeEvento; ctx.resumen = _resumenEvento;')(escapar, ctx);
        expect(ctx.badge('tipo_persona', 'delegado_rentado')).toMatch(/Cambio de función/);
        expect(ctx.resumen({ tipo_cambio: 'tipo_persona', valor_anterior: 'jurado', valor_nuevo: 'delegado_rentado' }))
            .toBe('Función: Jurado → Delegado Rentado');
        expect(ctx.resumen({ tipo_cambio: 'categoria', valor_anterior: 'C', valor_nuevo: 'DR' })).toBe('Categoría: C → DR');
    });
});
