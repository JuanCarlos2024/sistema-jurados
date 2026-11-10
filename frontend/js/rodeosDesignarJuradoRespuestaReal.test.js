// CORRECCIÓN URGENTE — Designaciones que mostraban éxito pero no se
// guardaban (caso real: LO BARNECHEA / Felipe Ordóñez Saavedra). Causa raíz
// en el frontend: designarJurado()/guardarAsignacion() (rodeos.html) nunca
// inspeccionaban la respuesta de POST /admin/asignaciones — cualquier HTTP
// 2xx bastaba para mostrar "designado correctamente"/"Persona asignada
// correctamente", incluso con creadas=[] (ver el fix real del backend en
// asignaciones.js y asignaciones.contratoRespuesta.test.js).
//
// Este archivo ejecuta el código REAL extraído de rodeos.html (mismo patrón
// de esta sesión que rodeosColleraNuevaModal.test.js/
// rodeosVerDescargarPdfPrincipal.test.js) — nunca una reimplementación.
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

const CODIGO_COMPARTIDO = extraerFuncion('verificarAsignacionCreada');

function construirEntornoDesignar({ postImpl, juradoOverride, confirmarAdvertenciaImpl, pedirMotivoImpl } = {}) {
    const toasts = [];
    const modalesCerrados = [];
    const verDetalleLlamadas = [];
    // designarJurado() también llama a /admin/asignaciones/validar-historial
    // ANTES de crear la designación (verificación adicional de
    // asociación/fecha repetida) — se resuelve siempre "sin novedad" acá
    // para aislar el comportamiento bajo prueba (la respuesta de la
    // creación real), salvo que el propio endpoint de creación sea el que
    // se está mockeando.
    const postDesignar = postImpl || (() => Promise.resolve({ creadas: [{ id: 'asig-1', usuario_pagado_id: 'felipe-id' }], errores: [] }));
    const apiFalso = {
        post: (endpoint, body) => endpoint === '/admin/asignaciones/validar-historial'
            ? Promise.resolve({ repite_asociacion: false, fecha_consecutiva: false })
            : postDesignar(endpoint, body)
    };
    const mostrarToast = (msg, tipo) => toasts.push({ msg, tipo });
    const mostrarError = (err) => toasts.push({ msg: err?.message || String(err), tipo: 'error' });
    const cerrarModal = () => modalesCerrados.push(true);
    const verDetalle = (id) => verDetalleLlamadas.push(id);
    const confirmarDesignacionConAdvertencia = confirmarAdvertenciaImpl || (() => Promise.resolve(true));
    const construirContenidoAdvertenciaCausas = () => '<div>advertencia</div>';
    const construirContenidoAdvertenciaDesignacion = () => '<div>advertencia-designacion</div>';
    const pedirMotivoExcepcion = pedirMotivoImpl || (() => Promise.resolve({ motivo_codigo: 'jurado_no_disponible', motivo_detalle: 'detalle' }));
    const _juradosDesignacion = [juradoOverride || { id: 'felipe-id', nombre_completo: 'Felipe Ordóñez Saavedra', estado_elegibilidad: 'DISPONIBLE_Y_HABILITADO', causas_relajables: [] }];
    const _designarRodeoId = 'd913f26b-a30e-4245-bc70-5ba77a549e23';

    const codigo = CODIGO_COMPARTIDO + '\n' + extraerFuncion('designarJurado');
    // eslint-disable-next-line no-new-func
    const fabrica = new Function(
        '_juradosDesignacion', 'confirmarDesignacionConAdvertencia', 'construirContenidoAdvertenciaCausas', 'api',
        '_designarRodeoId', 'construirContenidoAdvertenciaDesignacion', 'pedirMotivoExcepcion', 'mostrarToast', 'cerrarModal', 'verDetalle', 'mostrarError',
        `${codigo}\nreturn { designarJurado, verificarAsignacionCreada };`
    );
    const { designarJurado } = fabrica(
        _juradosDesignacion, confirmarDesignacionConAdvertencia, construirContenidoAdvertenciaCausas, apiFalso,
        _designarRodeoId, construirContenidoAdvertenciaDesignacion, pedirMotivoExcepcion, mostrarToast, cerrarModal, verDetalle, mostrarError
    );
    return { designarJurado, toasts, modalesCerrados, verDetalleLlamadas };
}

describe('verificarAsignacionCreada() — defensa en profundidad (nunca confiar en un 2xx por sí solo)', () => {
    function fabricar() {
        const fabrica = new Function(`${CODIGO_COMPARTIDO}\nreturn verificarAsignacionCreada;`);
        return fabrica();
    }

    test('creadas vacío -> lanza con el mensaje real de errores, nunca en silencio', () => {
        const verificarAsignacionCreada = fabricar();
        expect(() => verificarAsignacionCreada({ creadas: [], errores: [{ usuario_pagado_id: 'felipe-id', error: 'El jurado ya está asignado a otro rodeo en fechas que se cruzan' }] }, 'felipe-id'))
            .toThrow('El jurado ya está asignado a otro rodeo en fechas que se cruzan');
    });

    test('creadas sin la persona pedida (otro usuario_pagado_id) -> lanza igual, nunca asume éxito por homonimia de posición', () => {
        const verificarAsignacionCreada = fabricar();
        expect(() => verificarAsignacionCreada({ creadas: [{ id: 'asig-otro', usuario_pagado_id: 'otro-id' }], errores: [] }, 'felipe-id'))
            .toThrow('No se pudo confirmar la creación de la asignación.');
    });

    test('creadas con la persona pero sin id válido -> lanza (defensa adicional ante una fila corrupta)', () => {
        const verificarAsignacionCreada = fabricar();
        expect(() => verificarAsignacionCreada({ creadas: [{ usuario_pagado_id: 'felipe-id' }], errores: [] }, 'felipe-id'))
            .toThrow();
    });

    test('creadas con la persona y un id real -> no lanza, retorna la fila', () => {
        const verificarAsignacionCreada = fabricar();
        expect(verificarAsignacionCreada({ creadas: [{ id: 'asig-1', usuario_pagado_id: 'felipe-id' }], errores: [] }, 'felipe-id'))
            .toEqual({ id: 'asig-1', usuario_pagado_id: 'felipe-id' });
    });
});

describe('designarJurado() — caso LO BARNECHEA (Felipe Ordóñez, FINDE_CONSECUTIVO confirmado)', () => {
    test('respuesta 2xx con creadas=[] (el bug real) -> NUNCA muestra "designado correctamente", nunca cierra el modal, nunca refresca el detalle', async () => {
        const { designarJurado, toasts, modalesCerrados, verDetalleLlamadas } = construirEntornoDesignar({
            postImpl: () => Promise.resolve({ creadas: [], errores: [{ usuario_pagado_id: 'felipe-id', error: 'esta excepción debe declarar al menos una causa relajable confirmada' }] })
        });

        await designarJurado('felipe-id');

        expect(toasts.find(t => /designado correctamente/i.test(t.msg))).toBeUndefined();
        expect(toasts).toEqual([{ msg: 'esta excepción debe declarar al menos una causa relajable confirmada', tipo: 'error' }]);
        expect(modalesCerrados).toHaveLength(0);
        expect(verDetalleLlamadas).toHaveLength(0);
    });

    test('la ruta ahora responde con error real (422) -> api.post rechaza la promesa -> mismo resultado: nunca éxito falso', async () => {
        const { designarJurado, toasts, modalesCerrados } = construirEntornoDesignar({
            postImpl: () => Promise.reject({ message: 'El jurado ya está asignado a otro rodeo en fechas que se cruzan' })
        });

        await designarJurado('felipe-id');

        expect(toasts).toEqual([{ msg: 'El jurado ya está asignado a otro rodeo en fechas que se cruzan', tipo: 'error' }]);
        expect(modalesCerrados).toHaveLength(0);
    });

    test('respuesta real con creadas=[{...felipe, id válido}] -> SÍ muestra éxito, cierra el modal y refresca el detalle del rodeo', async () => {
        const { designarJurado, toasts, modalesCerrados, verDetalleLlamadas } = construirEntornoDesignar({
            postImpl: () => Promise.resolve({ creadas: [{ id: 'asig-felipe', usuario_pagado_id: 'felipe-id' }], errores: [] })
        });

        await designarJurado('felipe-id');

        expect(toasts).toEqual([{ msg: 'Felipe Ordóñez Saavedra designado correctamente', tipo: 'success' }]);
        expect(modalesCerrados).toHaveLength(1);
        expect(verDetalleLlamadas).toEqual(['d913f26b-a30e-4245-bc70-5ba77a549e23']);
    });

    test('CON_ADVERTENCIAS (FINDE_CONSECUTIVO) confirmado, con motivo, pero el backend igual rechaza -> jamás éxito, el modal sigue disponible', async () => {
        const { designarJurado, toasts, modalesCerrados } = construirEntornoDesignar({
            juradoOverride: { id: 'felipe-id', nombre_completo: 'Felipe Ordóñez Saavedra', estado_elegibilidad: 'CON_ADVERTENCIAS', causas_relajables: ['FINDE_CONSECUTIVO'] },
            postImpl: () => Promise.resolve({ creadas: [], errores: [{ usuario_pagado_id: 'felipe-id', error: 'esta excepción debe declarar al menos una causa relajable confirmada' }] })
        });

        await designarJurado('felipe-id');

        expect(toasts.find(t => t.tipo === 'success')).toBeUndefined();
        expect(modalesCerrados).toHaveLength(0);
    });

    test('NO_HABILITADO sigue bloqueado antes de siquiera llamar a api.post (invariante de seguridad ya existente, sin regresión)', async () => {
        let postLlamado = false;
        const { designarJurado, toasts } = construirEntornoDesignar({
            juradoOverride: { id: 'felipe-id', nombre_completo: 'Felipe Ordóñez Saavedra', estado_elegibilidad: 'NO_HABILITADO', causas_relajables: [] },
            postImpl: () => { postLlamado = true; return Promise.resolve({ creadas: [{ id: 'x', usuario_pagado_id: 'felipe-id' }], errores: [] }); }
        });

        await designarJurado('felipe-id');

        expect(postLlamado).toBe(false);
        expect(toasts[0].tipo).toBe('error');
    });
});
