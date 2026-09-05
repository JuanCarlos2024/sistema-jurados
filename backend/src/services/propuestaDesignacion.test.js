const {
    construirDetalleDesdeResultado, detectarConflictoInterno, decidirEstadoSeleccion, resumenPropuesta
} = require('./propuestaDesignacion');
const { calcularBloqueRodeo } = require('./feriados');

describe('construirDetalleDesdeResultado — mapea resultado del dry-run a fila de detalle', () => {
    test('CASO 1/PROPUESTO → PENDIENTE, jurado_id_propuesto seteado, jurado_id_seleccionado NULL', () => {
        const resultado = {
            rodeo_id: 'r1', estado: 'PROPUESTO',
            jurado_propuesto: { jurado_id: 'j1', nombre: 'Pedro' },
            top_candidatos: [{ jurado_id: 'j1' }, { jurado_id: 'j2' }],
            candidatos_evaluados: 61, candidatos_potenciales_bd: 5, descartes: { DISPONIBILIDAD: 3 }
        };
        const fila = construirDetalleDesdeResultado(resultado);
        expect(fila.estado_revision).toBe('PENDIENTE');
        expect(fila.jurado_id_propuesto).toBe('j1');
        expect(fila.jurado_id_seleccionado).toBeNull();
        expect(fila.origen_seleccion).toBeNull();
        expect(fila.explicacion_json.jurado_propuesto.jurado_id).toBe('j1');
    });

    test('CASO 11/SIN_PROPUESTA se conserva correctamente (sin jurado, con descartados)', () => {
        const resultado = {
            rodeo_id: 'r2', estado: 'SIN_PROPUESTA',
            descartados: [{ jurado_id: 'j3', causas: ['DISTANCIA_EXCEDIDA'] }],
            candidatos_evaluados: 61, candidatos_potenciales_bd: 0, descartes: {}
        };
        const fila = construirDetalleDesdeResultado(resultado);
        expect(fila.estado_revision).toBe('SIN_PROPUESTA');
        expect(fila.jurado_id_propuesto).toBeNull();
        expect(fila.jurado_id_seleccionado).toBeNull();
        expect(fila.explicacion_json.descartados.length).toBe(1);
    });

    test('CASO 12/NO_EVALUABLE se conserva correctamente (con causa)', () => {
        const resultado = { rodeo_id: 'r3', estado: 'NO_EVALUABLE', causa: 'RODEO_SIN_COMUNA' };
        const fila = construirDetalleDesdeResultado(resultado);
        expect(fila.estado_revision).toBe('NO_EVALUABLE');
        expect(fila.jurado_id_propuesto).toBeNull();
        expect(fila.explicacion_json.causa).toBe('RODEO_SIN_COMUNA');
    });
});

describe('decidirEstadoSeleccion — CASO 2, 3, 5', () => {
    test('CASO 2: aceptar el jurado propuesto, sin advertencias → ACEPTADO / MOTOR', () => {
        const r = decidirEstadoSeleccion('j1', 'j1', []);
        expect(r).toEqual({ estado_revision: 'ACEPTADO', origen_seleccion: 'MOTOR' });
    });

    test('CASO 3: elegir otro candidato válido (sin advertencias) → MODIFICADO / MANUAL', () => {
        const r = decidirEstadoSeleccion('j2', 'j1', []);
        expect(r).toEqual({ estado_revision: 'MODIFICADO', origen_seleccion: 'MANUAL' });
    });

    test('CASO 5: selección con advertencias (aunque sea el mismo propuesto) → MODIFICADO / MANUAL_CON_ADVERTENCIA', () => {
        const r = decidirEstadoSeleccion('j1', 'j1', [{ tipo: 'DISTANCIA_EXCEDIDA' }]);
        expect(r).toEqual({ estado_revision: 'MODIFICADO', origen_seleccion: 'MANUAL_CON_ADVERTENCIA' });
    });

    test('sin jurado propuesto original (rodeo era SIN_PROPUESTA) y sin advertencias → MODIFICADO / MANUAL', () => {
        const r = decidirEstadoSeleccion('j5', null, []);
        expect(r).toEqual({ estado_revision: 'MODIFICADO', origen_seleccion: 'MANUAL' });
    });
});

describe('detectarConflictoInterno — CASO 6', () => {
    const fecha = '2026-09-05'; // sábado
    const bloqueA = calcularBloqueRodeo(fecha, 1);
    const bloqueB = calcularBloqueRodeo('2026-09-06', 1); // domingo, mismo finde que A
    const bloqueSiguiente = calcularBloqueRodeo('2026-09-12', 1); // sábado siguiente

    test('CASO 6: mismo jurado en dos rodeos del mismo fin de semana → conflicto MISMO_FINDE', () => {
        const rodeoActual = { id: 'rA', club: 'Club A', fecha, asociacion: 'AsocA', bloque: bloqueA };
        const otras = [{ jurado_id_seleccionado: 'j1', rodeo: { id: 'rB', club: 'Club B', fecha: '2026-09-06', asociacion: 'AsocB', bloque: bloqueB } }];
        const conflictos = detectarConflictoInterno(rodeoActual, 'j1', otras);
        expect(conflictos.some(c => c.tipo === 'MISMO_FINDE')).toBe(true);
    });

    test('fin de semana consecutivo (dentro de la misma propuesta) → conflicto FINDE_CONSECUTIVO', () => {
        const rodeoActual = { id: 'rA', club: 'Club A', fecha: '2026-09-12', asociacion: 'AsocA', bloque: bloqueSiguiente };
        const otras = [{ jurado_id_seleccionado: 'j1', rodeo: { id: 'rB', club: 'Club B', fecha, asociacion: 'AsocB', bloque: bloqueA } }];
        const conflictos = detectarConflictoInterno(rodeoActual, 'j1', otras);
        expect(conflictos.some(c => c.tipo === 'FINDE_CONSECUTIVO')).toBe(true);
    });

    test('misma asociación repetida dentro de la propuesta → conflicto ASOCIACION_REPETIDA_EN_PROPUESTA', () => {
        const rodeoActual = { id: 'rA', club: 'Club A', fecha: '2026-10-10', asociacion: 'Colchagua', bloque: calcularBloqueRodeo('2026-10-10', 1) };
        const otras = [{ jurado_id_seleccionado: 'j1', rodeo: { id: 'rB', club: 'Club B', fecha: '2026-11-14', asociacion: 'Colchagua', bloque: calcularBloqueRodeo('2026-11-14', 1) } }];
        const conflictos = detectarConflictoInterno(rodeoActual, 'j1', otras);
        expect(conflictos.some(c => c.tipo === 'ASOCIACION_REPETIDA_EN_PROPUESTA')).toBe(true);
    });

    test('distinto jurado en la otra fila → sin conflicto', () => {
        const rodeoActual = { id: 'rA', club: 'Club A', fecha, asociacion: 'AsocA', bloque: bloqueA };
        const otras = [{ jurado_id_seleccionado: 'j2', rodeo: { id: 'rB', club: 'Club B', fecha: '2026-09-06', asociacion: 'AsocB', bloque: bloqueB } }];
        expect(detectarConflictoInterno(rodeoActual, 'j1', otras)).toEqual([]);
    });

    test('no se compara la fila consigo misma', () => {
        const rodeoActual = { id: 'rA', club: 'Club A', fecha, asociacion: 'AsocA', bloque: bloqueA };
        const otras = [{ jurado_id_seleccionado: 'j1', rodeo: { id: 'rA', club: 'Club A', fecha, asociacion: 'AsocA', bloque: bloqueA } }];
        expect(detectarConflictoInterno(rodeoActual, 'j1', otras)).toEqual([]);
    });

    test('semanas alejadas y asociaciones distintas → sin conflicto', () => {
        const rodeoActual = { id: 'rA', club: 'Club A', fecha: '2026-12-05', asociacion: 'AsocX', bloque: calcularBloqueRodeo('2026-12-05', 1) };
        const otras = [{ jurado_id_seleccionado: 'j1', rodeo: { id: 'rB', club: 'Club B', fecha, asociacion: 'AsocY', bloque: bloqueA } }];
        expect(detectarConflictoInterno(rodeoActual, 'j1', otras)).toEqual([]);
    });
});

describe('resumenPropuesta', () => {
    test('cuenta correctamente cada estado_revision', () => {
        const filas = [
            { estado_revision: 'ACEPTADO' }, { estado_revision: 'ACEPTADO' },
            { estado_revision: 'MODIFICADO' },
            { estado_revision: 'PENDIENTE' },
            { estado_revision: 'SIN_PROPUESTA' },
            { estado_revision: 'NO_EVALUABLE' }
        ];
        expect(resumenPropuesta(filas)).toEqual({
            total_rodeos: 6, aceptados: 2, modificados: 1, pendientes: 1, sin_propuesta: 1, no_evaluables: 1
        });
    });

    test('propuesta vacía', () => {
        expect(resumenPropuesta([])).toEqual({
            total_rodeos: 0, aceptados: 0, modificados: 0, pendientes: 0, sin_propuesta: 0, no_evaluables: 0
        });
    });
});
