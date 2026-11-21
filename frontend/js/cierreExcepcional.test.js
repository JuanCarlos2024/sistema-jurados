// CIERRE EXCEPCIONAL — ADMINISTRADOR (frontend): lógica pura y verificaciones
// estáticas de la pantalla y del acceso desde el detalle de la evaluación.
const fs = require('fs');
const path = require('path');
const CE = require('./cierreExcepcional');
const CR = require('./comisionRevision');

const leer = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const pagina = leer('admin/evaluacion-cierre-excepcional.html');
const detalle = leer('admin/evaluacion-detalle.html');
const portal = leer('admin/comision-revision.html');

const DATOS = {
    evaluacion: { club: 'Club Uno', asociacion: 'Ñuble' },
    ciclos: [{ ciclo_id: 'C1', numero_ciclo: 1, estado: 'cerrado', puede_cerrarse: false }, { ciclo_id: 'C2', numero_ciclo: 2, estado: 'abierto', puede_cerrarse: true }],
    pendientes: {
        resultado_alterado: [{ revision_id: 'RA', comentario_alteracion: 'x', videos_ciclo_1: [] }],
        video_derivado: [{ caso_id: 'K2', numero_caso: 2, ciclo: 1, descuento_propuesto: 1 }, { caso_id: 'K3', numero_caso: 1, ciclo: 2, descuento_propuesto: 2 }]
    },
    total_pendientes: 3
};

describe('lógica', () => {
    test('solo el Administrador pleno puede usarlo', () => {
        expect(CE.puedeCierreExcepcional(null)).toBe(true);
        expect(CE.puedeCierreExcepcional(undefined)).toBe(true);
        for (const rol of ['analista', 'comision_tecnica', 'jefe_area', 'monitor', 'director', 'capacitador']) expect(CE.puedeCierreExcepcional(rol)).toBe(false);
    });
    test('cada video derivado exige decisión expresa; el motivo es obligatorio', () => {
        expect(CE.validarCierre(DATOS, {}, 'motivo')).toMatch(/Falta decidir ERROR o ACIERTO para el caso 2/);
        expect(CE.validarCierre(DATOS, { K2: 'error' }, 'motivo')).toMatch(/caso 1 \(Ciclo 2\)/);
        expect(CE.validarCierre(DATOS, { K2: 'error', K3: 'acierto' }, '   ')).toMatch(/obligatoria/);
        expect(CE.validarCierre(DATOS, { K2: 'error', K3: 'acierto' }, 'La Comisión no respondió')).toBeNull();
    });
    test('el cuerpo envía una decisión por caso, los ciclos elegidos y la confirmación', () => {
        expect(CE.cuerpoSolicitud(DATOS, { K2: 'error', K3: 'acierto' }, '  motivo  ', ['C2'])).toEqual({
            motivo: 'motivo', decisiones: [{ caso_id: 'K2', decision: 'error' }, { caso_id: 'K3', decision: 'acierto' }], ciclos_a_cerrar: ['C2'], confirmado: true
        });
    });
    test('descuento considerado: solo los ERROR suman', () => {
        expect(CE.descuentoConsiderado(DATOS, { K2: 'error', K3: 'acierto' })).toBe(1);
        expect(CE.descuentoConsiderado(DATOS, { K2: 'error', K3: 'error' })).toBe(3);
    });
    test('la confirmación detalla el tratamiento y advierte que puede publicar la nota definitiva', () => {
        const t = CE.textoConfirmacion(DATOS, { K2: 'error', K3: 'acierto' }, ['C2']);
        expect(t).toContain('CIERRE EXCEPCIONAL — ADMINISTRADOR');
        expect(t).toContain('Resultados alterados: 1 (se cierran sin resolución de Comisión; no generan descuento)');
        expect(t).toContain('Caso 2 (Ciclo 1): ERROR — se mantiene el descuento de 1');
        expect(t).toContain('Caso 1 (Ciclo 2): ACIERTO — el descuento no se aplica');
        expect(t).toContain('Se cerrará con el procedimiento normal: Ciclo 2.');
        expect(t).toMatch(/PUBLICARÁ la nota definitiva/);
    });
});

describe('recuperación ("Completar cierre excepcional")', () => {
    test('la confirmación aclara que no se repiten decisiones y advierte la posible publicación', () => {
        const t = CE.textoConfirmacionCompletar(DATOS, ['C2']);
        expect(t).toContain('COMPLETAR CIERRE EXCEPCIONAL');
        expect(t).toContain('no se repetirán');
        expect(t).toContain('Se cerrará con el procedimiento normal: Ciclo 2.');
        expect(t).toMatch(/PUBLICARÁ la nota definitiva/);
        expect(CE.textoConfirmacionCompletar(DATOS, [])).toContain('solo se volverá a intentar la publicación');
    });
    test('la pantalla ofrece completar cuando hay un cierre registrado sin publicar, con su propio endpoint', () => {
        expect(pagina).toContain('if (!d.puede_cerrar_excepcionalmente && d.cierre_por_completar)');
        expect(pagina).toContain('/cierre-excepcional/completar');
        expect(pagina).toContain('Completar cierre excepcional');
    });
});

describe('pantalla', () => {
    test('identificada como excepcional, con justificación obligatoria y advertencia de publicación', () => {
        expect(pagina).toContain('<h1>CIERRE EXCEPCIONAL — ADMINISTRADOR</h1>');
        expect(pagina).toMatch(/NO es el cierre normal/);
        expect(pagina).toContain('Justificación (obligatoria)');
        expect(pagina).toMatch(/publicación definitiva de la nota/);
        expect(pagina).toContain('await confirmar(');
    });
    test('los videos derivados NO traen ninguna opción preseleccionada', () => {
        expect(pagina).not.toMatch(/type="radio"[^>]*checked/);
    });
    test('redirige a quien no sea Administrador pleno', () => {
        expect(pagina).toMatch(/if \(!CE\.puedeCierreExcepcional\(u\?\.rol_evaluacion\)\) \{ window\.location\.href = '\/admin\/evaluaciones\.html'/);
    });
    test('el detalle muestra el acceso solo al Administrador pleno y en evaluaciones no publicadas', () => {
        expect(detalle).toMatch(/if \(rolEval === null && !\['aprobado', 'publicado', 'cerrado'\]\.includes\(ev\.estado\)\) \{\n\s+items\.push\(`<a href="\/admin\/evaluacion-cierre-excepcional\.html\?id=\$\{ev\.id\}"/);
    });
});

describe('portal de Comisión: distingue quién resolvió', () => {
    test('etiquetas de origen', () => {
        expect(CR.ETIQUETA_RESUELTO_POR).toEqual({
            comision: 'Resuelto por Comisión',
            administracion: 'Resuelto por Administración (cierre excepcional)',
            cierre_excepcional: 'Cierre excepcional del Administrador, sin resolución de Comisión'
        });
        expect(portal).toContain('decisión administrativa, no de la Comisión');
        expect(portal).toContain('Esta revisión ya no admite decisión de la Comisión.');
    });
});
