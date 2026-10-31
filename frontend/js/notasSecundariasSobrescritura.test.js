// Rodeos → Ver → Notas secundarias: corrección administrativa de una Nota
// Comisión protegida. El backend (actualizar_notas_secundarias_con_
// auditoria) ya existía y ya exigía confirma_sobrescritura_historica +
// motivo real — el bug era puramente de frontend: guardarNotasSecundarias
// nunca reaccionaba al 409, solo mostraba el error crudo. Este archivo
// prueba la lógica de decisión extraída (sin DOM) que ahora usa
// admin/rodeos.html.
const fs = require('fs');
const path = require('path');
const N = require('./notasSecundariasSobrescritura');

const RODEOS_HTML = fs.readFileSync(
    path.join(__dirname, '..', 'admin', 'rodeos.html'),
    'utf8'
);

describe('CASO 1 — nota vacía/sin protección: nunca pide confirmación', () => {
    test('un error que no sea el código de protección nunca dispara el modal', () => {
        expect(N.decidirAccionError({ codigo: undefined, esMonitor: false, esDirector: false })).toBe('error_generico');
        expect(N.decidirAccionError({ codigo: 'NOTA_FUERA_DE_RANGO', esMonitor: false, esDirector: false })).toBe('error_generico');
    });
    test('el primer intento de guardado nunca envía confirma_sobrescritura_historica', () => {
        const body = N.construirPayload({ notaComision: 5.8, notaDelegado: null, confirmaSobrescritura: false, motivo: null });
        expect(body).toEqual({ nota_comision: 5.8, nota_delegado: null });
        expect(body.confirma_sobrescritura_historica).toBeUndefined();
        expect(body.motivo).toBeUndefined();
    });
});

describe('CASO 2/3 — Nota Comisión (o Delegado, mismo mecanismo) protegida: pide confirmación', () => {
    test('admin pleno (sin rol_evaluacion) recibe la acción "pedir_confirmacion"', () => {
        const accion = N.decidirAccionError({ codigo: N.CODIGO_PROTEGIDA, esMonitor: false, esDirector: false });
        expect(accion).toBe('pedir_confirmacion');
    });
});

describe('CASO 4 — cancelar: no se reenvía nada', () => {
    test('construirPayload sin confirmaSobrescritura nunca incluye motivo, sin importar qué se le pase', () => {
        const body = N.construirPayload({ notaComision: 5.2, notaDelegado: 5.8, confirmaSobrescritura: false, motivo: 'un motivo que no debería usarse' });
        expect(body).toEqual({ nota_comision: 5.2, nota_delegado: 5.8 });
    });
});

describe('CASO 5 — Nota Delegado nunca exige esta confirmación', () => {
    test('el código de protección es EXCLUSIVO de Comisión — ningún otro código activa "pedir_confirmacion"', () => {
        // Simula que el backend alguna vez emitiera un código distinto para
        // Delegado: ESTE módulo nunca lo trataría como "pedir_confirmacion"
        // porque solo reconoce el código real y documentado de Comisión.
        expect(N.decidirAccionError({ codigo: 'NOTA_DELEGADO_PROTEGIDA_REQUIERE_CONFIRMACION', esMonitor: false, esDirector: false })).toBe('error_generico');
        expect(N.CODIGO_PROTEGIDA).toBe('NOTA_COMISION_PROTEGIDA_REQUIERE_CONFIRMACION');
    });
});

describe('CASO 6 — ambas notas cambian a la vez: un solo payload, con ambas', () => {
    test('al confirmar, el payload reenviado incluye nota_comision Y nota_delegado junto con confirma_sobrescritura_historica y motivo', () => {
        const body = N.construirPayload({ notaComision: 5.2, notaDelegado: 5.8, confirmaSobrescritura: true, motivo: 'corrección administrativa de prueba' });
        expect(body).toEqual({
            nota_comision: 5.2, nota_delegado: 5.8,
            confirma_sobrescritura_historica: true, motivo: 'corrección administrativa de prueba'
        });
    });

    test('cambioDelegado detecta correctamente si el valor de Delegado difiere del original', () => {
        expect(N.cambioDelegado({ delegadoAntes: 5.0, delegadoDespues: 5.8 })).toBe(true);
        expect(N.cambioDelegado({ delegadoAntes: 5.0, delegadoDespues: 5.0 })).toBe(false);
        expect(N.cambioDelegado({ delegadoAntes: null, delegadoDespues: null })).toBe(false);
    });
});

describe('CASO 7 — Monitor/Director no pueden usar el mecanismo de sobrescritura', () => {
    test('Monitor con nota protegida recibe "error_bloqueado_rol", nunca el modal de confirmación', () => {
        expect(N.decidirAccionError({ codigo: N.CODIGO_PROTEGIDA, esMonitor: true, esDirector: false })).toBe('error_bloqueado_rol');
    });
    test('Director con nota protegida recibe "error_bloqueado_rol", nunca el modal de confirmación', () => {
        expect(N.decidirAccionError({ codigo: N.CODIGO_PROTEGIDA, esMonitor: false, esDirector: true })).toBe('error_bloqueado_rol');
    });
});

describe('CASO 9 (no modifica el promedio simple / otros rodeos) — el payload es mínimo y específico', () => {
    test('construirPayload nunca incluye criterios de Comisión (apinadero/cancha/etc.), rodeo_id, ni ningún otro campo', () => {
        const body = N.construirPayload({ notaComision: 5.2, notaDelegado: 5.8, confirmaSobrescritura: true, motivo: 'motivo' });
        expect(Object.keys(body).sort()).toEqual(['confirma_sobrescritura_historica', 'motivo', 'nota_comision', 'nota_delegado'].sort());
    });
});

describe('Cableado real en admin/rodeos.html (sin DOM, verificación estructural del código fuente)', () => {
    test('carga el módulo de decisión antes que el resto de la lógica de la página', () => {
        expect(RODEOS_HTML).toContain('<script src="/js/notasSecundariasSobrescritura.js"></script>');
    });

    test('guardarNotasSecundarias delega la decisión en el módulo, nunca reimplementa el código de error a mano', () => {
        const cuerpo = RODEOS_HTML.match(/async function guardarNotasSecundarias\([\s\S]*?\n}/)[0];
        expect(cuerpo).toMatch(/NotasSecundariasSobrescritura\.decidirAccionError/);
        expect(cuerpo).toMatch(/NotasSecundariasSobrescritura\.construirPayload/);
        expect(cuerpo).not.toContain("'NOTA_COMISION_PROTEGIDA_REQUIERE_CONFIRMACION'"); // solo vive en el módulo (N.CODIGO_PROTEGIDA)
    });

    test('CASO 4/2/3: el valor "antes" se lee de defaultValue (el original cargado), nunca de .value (lo que el admin recién escribió)', () => {
        const cuerpo = RODEOS_HTML.match(/async function guardarNotasSecundarias\([\s\S]*?\n}/)[0];
        expect(cuerpo).toMatch(/inputComision\?\.defaultValue/);
        expect(cuerpo).toMatch(/inputDelegado\?\.defaultValue/);
    });

    test('al cancelar (motivo null) nunca se vuelve a llamar guardarNotasSecundarias', () => {
        const cuerpo = RODEOS_HTML.match(/async function guardarNotasSecundarias\([\s\S]*?\n}/)[0];
        expect(cuerpo).toMatch(/if \(motivoConfirmado === null\) return;/);
    });

    test('el modal de confirmación exige motivo real antes de resolver (usa N.motivoValido, nunca solo "if (!motivo)" ingenuo sobre espacios)', () => {
        expect(RODEOS_HTML).toContain('NotasSecundariasSobrescritura.motivoValido(motivo)');
    });
});

describe('motivoValido — exige texto real, nunca vacío ni solo espacios', () => {
    test.each([
        [null, false], [undefined, false], ['', false], ['   ', false],
        ['corrección real', true], ['  motivo con espacios alrededor  ', true]
    ])('motivoValido(%j) -> %s', (texto, esperado) => {
        expect(N.motivoValido(texto)).toBe(esperado);
    });
});

// ─── Protección Nota Delegado (088) — comentario obligatorio, mecanismo
// propio e independiente del de Nota Comisión (nunca usa CODIGO_PROTEGIDA).
describe('construirPayload — comentario_delegado (088)', () => {
    test('notaDelegado=null -> nunca incluye comentario_delegado, aunque se pase uno', () => {
        const body = N.construirPayload({ notaComision: 5.8, notaDelegado: null, confirmaSobrescritura: false, motivo: null, comentarioDelegado: 'no debería usarse' });
        expect(body).toEqual({ nota_comision: 5.8, nota_delegado: null });
        expect(body.comentario_delegado).toBeUndefined();
    });

    test('notaDelegado con valor y comentario real -> el body incluye comentario_delegado', () => {
        const body = N.construirPayload({ notaComision: null, notaDelegado: 6.3, confirmaSobrescritura: false, motivo: null, comentarioDelegado: 'cartilla digital revisada y corregida' });
        expect(body).toEqual({ nota_comision: null, nota_delegado: 6.3, comentario_delegado: 'cartilla digital revisada y corregida' });
    });

    test('sin comentarioDelegado (no se pasa el parámetro) -> el body no agrega la clave, compatible con llamadas anteriores', () => {
        const body = N.construirPayload({ notaComision: 5.2, notaDelegado: 5.8, confirmaSobrescritura: true, motivo: 'motivo' });
        expect(Object.keys(body).sort()).toEqual(['confirma_sobrescritura_historica', 'motivo', 'nota_comision', 'nota_delegado'].sort());
    });
});

describe('Cableado real de la protección de Nota Delegado en admin/rodeos.html', () => {
    test('existe el campo de comentario obligatorio para Nota Delegado', () => {
        expect(RODEOS_HTML).toContain('id="ns-comentario-delegado"');
    });

    test('guardarNotasSecundarias valida el comentario con NotasSecundariasSobrescritura.motivoValido (reutilizado, no reimplementado)', () => {
        const cuerpo = RODEOS_HTML.match(/async function guardarNotasSecundarias\([\s\S]*?\n}/)[0];
        expect(cuerpo).toMatch(/NotasSecundariasSobrescritura\.motivoValido\(comentarioDelegado\)/);
    });

    test('guardarNotasSecundarias muestra la nota anterior y la nueva antes de confirmar un cambio de Delegado', () => {
        const cuerpo = RODEOS_HTML.match(/async function guardarNotasSecundarias\([\s\S]*?\n}/)[0];
        expect(cuerpo).toMatch(/cambioDelegado/);
        expect(cuerpo).toMatch(/await confirmar\(/);
    });

    test('el payload reenviado incluye comentarioDelegado', () => {
        const cuerpo = RODEOS_HTML.match(/async function guardarNotasSecundarias\([\s\S]*?\n}/)[0];
        expect(cuerpo).toMatch(/comentarioDelegado/);
    });
});
