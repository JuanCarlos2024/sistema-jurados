// Cambio de Delegado de Asociación — lógica pura del frontend
// (frontend/js/cambioDelegadoAsociacion.js) y su conexión con el Informe del
// Delegado Oficial del Rodeo (frontend/admin/rodeos.html).
const fs = require('fs');
const path = require('path');
const {
    cdaPuedeCambiar, cdaOpcionesElegibles, cdaValidar, cdaCuerpoSolicitud, cdaTextoConfirmacion
} = require('./cambioDelegadoAsociacion');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'rodeos.html'), 'utf8').replace(/\r\n/g, '\n');

const BORRADOR = {
    id: 'cart-1', rodeo_id: 'rodeo-1', estado: 'borrador', delegado_asociacion_id: 'del-pablo',
    delegado_nombre: 'Pablo Bijit', designacion_institucional: { id: 'desig-1', delegado_asociacion_id: 'del-pablo' }
};

describe('cdaPuedeCambiar — visibilidad del botón "Cambiar delegado"', () => {
    test('Administrador pleno + Delegado de Asociación + Borrador + designación confirmada -> visible', () => {
        expect(cdaPuedeCambiar(BORRADOR, null)).toBe(true);
    });
    test.each(['enviada', 'reenviada', 'observada', 'reabierta', 'aprobada', 'cerrada'])('estado "%s" -> oculto', (estado) => {
        expect(cdaPuedeCambiar({ ...BORRADOR, estado }, null)).toBe(false);
    });
    test('cartilla de Delegado Rentado (sin delegado_asociacion_id) -> oculto', () => {
        expect(cdaPuedeCambiar({ ...BORRADOR, delegado_asociacion_id: null, delegado_id: 'u1' }, null)).toBe(false);
    });
    test('sin designación institucional confirmada -> oculto', () => {
        expect(cdaPuedeCambiar({ ...BORRADOR, designacion_institucional: null }, null)).toBe(false);
    });
    test.each(['monitor', 'director', 'analista', 'comision_tecnica', 'jefe_area'])('rol "%s" -> oculto', (rol) => {
        expect(cdaPuedeCambiar(BORRADOR, rol)).toBe(false);
    });
});

describe('cdaOpcionesElegibles / cdaValidar / cdaCuerpoSolicitud / cdaTextoConfirmacion', () => {
    test('excluye al vigente, suspendidos y no certificados', () => {
        const r = cdaOpcionesElegibles([
            { id: 'del-pablo', nombre: 'Pablo' }, { id: 'a', nombre: 'A' },
            { id: 'b', nombre: 'B', activo: false }, { id: 'c', nombre: 'C', certificado: false }
        ], 'del-pablo');
        expect(r.map(d => d.id)).toEqual(['a']);
    });
    test('valida selección obligatoria, distinto del actual y motivo obligatorio', () => {
        expect(cdaValidar({ nuevoId: '', motivo: 'x', actualId: 'p' })).toMatch(/Seleccione/);
        expect(cdaValidar({ nuevoId: 'p', motivo: 'x', actualId: 'p' })).toMatch(/distinto/);
        expect(cdaValidar({ nuevoId: 'n', motivo: '   ', actualId: 'p' })).toMatch(/motivo/);
        expect(cdaValidar({ nuevoId: 'n', motivo: 'x'.repeat(1001), actualId: 'p' })).toMatch(/1000/);
        expect(cdaValidar({ nuevoId: 'n', motivo: 'Error de la asociación', actualId: 'p' })).toBeNull();
    });
    test('el cuerpo envía el responsable y la versión vistos (protección de concurrencia)', () => {
        const op = { designacion: { delegado_asociacion_id: 'del-pablo' }, cartilla: { version: 7 } };
        expect(cdaCuerpoSolicitud(op, 'del-nuevo', '  motivo  ')).toEqual({
            nuevo_delegado_asociacion_id: 'del-nuevo', motivo: 'motivo', delegado_actual_id: 'del-pablo', cartilla_version: 7
        });
    });
    test('la confirmación indica nombre anterior, nuevo responsable y rodeo', () => {
        const t = cdaTextoConfirmacion({ anterior: 'Pablo Bijit', nuevo: 'Pedro Soto', rodeo: { club: 'VALPARAÍSO', asociacion: 'VALPARAÍSO', fecha: '2026-11-14' } });
        expect(t).toContain('Pablo Bijit');
        expect(t).toContain('Pedro Soto');
        expect(t).toContain('VALPARAÍSO — VALPARAÍSO (2026-11-14)');
    });
});

describe('rodeos.html — conexión del flujo', () => {
    test('carga el script y muestra el botón junto al Delegado Oficial solo si cdaPuedeCambiar()', () => {
        expect(html).toContain('<script src="/js/cambioDelegadoAsociacion.js"></script>');
        expect(html).toMatch(/fila\('Delegado Oficial', fld\(c\.delegado_nombre\) \+ \(cdaPuedeCambiar\(c, _rolEvalRodeos\)/);
        expect(html).toContain('>Cambiar delegado</button>');
    });
    test('el modal tiene título, selector, motivo, Cancelar y Confirmar; usa el endpoint de opciones y el de reemplazo', () => {
        expect(html).toContain('CAMBIAR DELEGADO DE ASOCIACIÓN');
        expect(html).toContain('Nuevo Delegado Oficial');
        expect(html).toContain('Motivo del cambio');
        expect(html).toContain('Confirmar cambio de delegado');
        expect(html).toContain('/delegado-institucional/opciones');
        expect(html).toContain('/reemplazar-delegado-institucional`, cdaCuerpoSolicitud(op, nuevoId, motivo)');
    });
    test('tras confirmar refresca el informe (nuevo Delegado Oficial e historial) y el listado', () => {
        const i = html.indexOf('async function confirmarCambioDelegadoAsociacion');
        const bloque = html.slice(i, i + 3000);
        expect(bloque).toContain('await verCartillaDelegadoDigital(_cdaCartillaId)');
        expect(bloque).toContain('cargar(paginaActual)');
        expect(bloque).toContain('await confirmar(');
    });
});
