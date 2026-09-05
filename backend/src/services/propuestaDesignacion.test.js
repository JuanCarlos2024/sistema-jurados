const {
    construirDetalleDesdeResultado, detectarConflictoInterno, decidirEstadoSeleccion, resumenPropuesta,
    resolverFilaALiberar, obtenerJuradoEfectivo
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

// ═════════════════════════════════════════════════════════════════════════
// obtenerJuradoEfectivo — fuente única de verdad de "quién está actualmente
// en uso en esta fila", separando explícitamente lo histórico (jurado_id_
// propuesto, nunca se borra) de lo efectivo (lo que realmente cuenta para
// conflictos/indicadores/resumen). Corrección post-revisión.
// ═════════════════════════════════════════════════════════════════════════
describe('obtenerJuradoEfectivo — histórico vs efectivo', () => {
    test('PENDIENTE → jurado_id_propuesto es el efectivo (sugerencia vigente del motor)', () => {
        expect(obtenerJuradoEfectivo({ estado_revision: 'PENDIENTE', jurado_id_propuesto: 'j1', jurado_id_seleccionado: null })).toBe('j1');
    });

    test('ACEPTADO/MODIFICADO → jurado_id_seleccionado es el efectivo', () => {
        expect(obtenerJuradoEfectivo({ estado_revision: 'ACEPTADO', jurado_id_propuesto: 'j1', jurado_id_seleccionado: 'j1' })).toBe('j1');
        expect(obtenerJuradoEfectivo({ estado_revision: 'MODIFICADO', jurado_id_propuesto: 'j1', jurado_id_seleccionado: 'j2' })).toBe('j2');
    });

    test('CASO 1/7: SIN_JURADO_ACTUAL → null, AUNQUE jurado_id_propuesto histórico siga apuntando a alguien', () => {
        const filaLiberada = { estado_revision: 'SIN_JURADO_ACTUAL', jurado_id_propuesto: 'j1', jurado_id_seleccionado: null };
        expect(obtenerJuradoEfectivo(filaLiberada)).toBeNull();
        // El histórico se conserva sin cambios — esta función solo lo ignora para "efectivo".
        expect(filaLiberada.jurado_id_propuesto).toBe('j1');
    });

    test('SIN_PROPUESTA/NO_EVALUABLE → null', () => {
        expect(obtenerJuradoEfectivo({ estado_revision: 'SIN_PROPUESTA', jurado_id_propuesto: null, jurado_id_seleccionado: null })).toBeNull();
        expect(obtenerJuradoEfectivo({ estado_revision: 'NO_EVALUABLE', jurado_id_propuesto: null, jurado_id_seleccionado: null })).toBeNull();
    });

    test('detalle null/undefined → null (sin lanzar error)', () => {
        expect(obtenerJuradoEfectivo(null)).toBeNull();
        expect(obtenerJuradoEfectivo(undefined)).toBeNull();
    });
});

describe('detectarConflictoInterno — CASO 6 (usa obtenerJuradoEfectivo, no un fallback ad-hoc)', () => {
    const fecha = '2026-09-05'; // sábado
    const bloqueA = calcularBloqueRodeo(fecha, 1);
    const bloqueB = calcularBloqueRodeo('2026-09-06', 1); // domingo, mismo finde que A
    const bloqueSiguiente = calcularBloqueRodeo('2026-09-12', 1); // sábado siguiente

    test('CASO 6: mismo jurado en dos rodeos del mismo fin de semana → conflicto MISMO_FINDE', () => {
        const rodeoActual = { id: 'rA', club: 'Club A', fecha, asociacion: 'AsocA', bloque: bloqueA };
        const otras = [{ estado_revision: 'ACEPTADO', jurado_id_seleccionado: 'j1', rodeo: { id: 'rB', club: 'Club B', fecha: '2026-09-06', asociacion: 'AsocB', bloque: bloqueB } }];
        const conflictos = detectarConflictoInterno(rodeoActual, 'j1', otras);
        expect(conflictos.some(c => c.tipo === 'MISMO_FINDE')).toBe(true);
    });

    test('fin de semana consecutivo (dentro de la misma propuesta) → conflicto FINDE_CONSECUTIVO', () => {
        const rodeoActual = { id: 'rA', club: 'Club A', fecha: '2026-09-12', asociacion: 'AsocA', bloque: bloqueSiguiente };
        const otras = [{ estado_revision: 'MODIFICADO', jurado_id_seleccionado: 'j1', rodeo: { id: 'rB', club: 'Club B', fecha, asociacion: 'AsocB', bloque: bloqueA } }];
        const conflictos = detectarConflictoInterno(rodeoActual, 'j1', otras);
        expect(conflictos.some(c => c.tipo === 'FINDE_CONSECUTIVO')).toBe(true);
    });

    test('misma asociación repetida dentro de la propuesta → conflicto ASOCIACION_REPETIDA_EN_PROPUESTA', () => {
        const rodeoActual = { id: 'rA', club: 'Club A', fecha: '2026-10-10', asociacion: 'Colchagua', bloque: calcularBloqueRodeo('2026-10-10', 1) };
        const otras = [{ estado_revision: 'ACEPTADO', jurado_id_seleccionado: 'j1', rodeo: { id: 'rB', club: 'Club B', fecha: '2026-11-14', asociacion: 'Colchagua', bloque: calcularBloqueRodeo('2026-11-14', 1) } }];
        const conflictos = detectarConflictoInterno(rodeoActual, 'j1', otras);
        expect(conflictos.some(c => c.tipo === 'ASOCIACION_REPETIDA_EN_PROPUESTA')).toBe(true);
    });

    test('distinto jurado en la otra fila → sin conflicto', () => {
        const rodeoActual = { id: 'rA', club: 'Club A', fecha, asociacion: 'AsocA', bloque: bloqueA };
        const otras = [{ estado_revision: 'ACEPTADO', jurado_id_seleccionado: 'j2', rodeo: { id: 'rB', club: 'Club B', fecha: '2026-09-06', asociacion: 'AsocB', bloque: bloqueB } }];
        expect(detectarConflictoInterno(rodeoActual, 'j1', otras)).toEqual([]);
    });

    test('no se compara la fila consigo misma', () => {
        const rodeoActual = { id: 'rA', club: 'Club A', fecha, asociacion: 'AsocA', bloque: bloqueA };
        const otras = [{ estado_revision: 'ACEPTADO', jurado_id_seleccionado: 'j1', rodeo: { id: 'rA', club: 'Club A', fecha, asociacion: 'AsocA', bloque: bloqueA } }];
        expect(detectarConflictoInterno(rodeoActual, 'j1', otras)).toEqual([]);
    });

    test('CASO 3/4: semanas alejadas y asociaciones distintas → YA_USADO_EN_PROPUESTA (informativo), con club/fecha/tipo de rodeo', () => {
        const rodeoActual = { id: 'rA', club: 'Club A', fecha: '2026-12-05', asociacion: 'AsocX', bloque: calcularBloqueRodeo('2026-12-05', 1) };
        const otras = [{ estado_revision: 'ACEPTADO', jurado_id_seleccionado: 'j1', rodeo: { id: 'rB', club: 'Club B', fecha, asociacion: 'AsocY', tipo_rodeo_nombre: 'Provincial 3 Series', bloque: bloqueA } }];
        const conflictos = detectarConflictoInterno(rodeoActual, 'j1', otras);
        expect(conflictos).toEqual([{ tipo: 'YA_USADO_EN_PROPUESTA', rodeo_id: 'rB', club: 'Club B', fecha, asociacion: 'AsocY', tipo_rodeo_nombre: 'Provincial 3 Series' }]);
    });

    test('CASO 3/7: jurado solo PROPUESTO (fila PENDIENTE, nunca seleccionado) → también cuenta como uso efectivo', () => {
        const rodeoActual = { id: 'rA', club: 'Club A', fecha: '2026-12-05', asociacion: 'AsocX', bloque: calcularBloqueRodeo('2026-12-05', 1) };
        const otras = [{ estado_revision: 'PENDIENTE', jurado_id_seleccionado: null, jurado_id_propuesto: 'j1', rodeo: { id: 'rB', club: 'Club B', fecha, asociacion: 'AsocY', tipo_rodeo_nombre: 'Interasociaciones', bloque: bloqueA } }];
        const conflictos = detectarConflictoInterno(rodeoActual, 'j1', otras);
        expect(conflictos.some(c => c.tipo === 'YA_USADO_EN_PROPUESTA' && c.club === 'Club B')).toBe(true);
    });

    test('jurado_id_seleccionado manda sobre jurado_id_propuesto cuando ambos existen en la otra fila', () => {
        // La fila B tuvo a j1 propuesto por el motor pero el administrador la modificó por j2 → j1 ya NO está en uso ahí.
        const rodeoActual = { id: 'rA', club: 'Club A', fecha, asociacion: 'AsocA', bloque: bloqueA };
        const otras = [{ estado_revision: 'MODIFICADO', jurado_id_seleccionado: 'j2', jurado_id_propuesto: 'j1', rodeo: { id: 'rB', club: 'Club B', fecha: '2026-09-06', asociacion: 'AsocB', bloque: bloqueB } }];
        expect(detectarConflictoInterno(rodeoActual, 'j1', otras)).toEqual([]);
    });

    test('CASO 2: después de mover (fila SIN_JURADO_ACTUAL) → ya NO cuenta como uso, aunque jurado_id_propuesto siga guardado', () => {
        const rodeoActual = { id: 'rA', club: 'Club A', fecha, asociacion: 'AsocA', bloque: bloqueA };
        const otras = [{ estado_revision: 'SIN_JURADO_ACTUAL', jurado_id_seleccionado: null, jurado_id_propuesto: 'j1', rodeo: { id: 'rB', club: 'Club B', fecha: '2026-09-06', asociacion: 'AsocB', bloque: bloqueB } }];
        expect(detectarConflictoInterno(rodeoActual, 'j1', otras)).toEqual([]);
    });
});

describe('resolverFilaALiberar — decide por jurado_id_propuesto vs el jurado que se mueve, no por estado_revision previo', () => {
    // TEST A — bug reportado: motor propuso PEDRO, admin aceptó PEDRO, se
    // mueve PEDRO. jurado_id_propuesto === juradoQueSeMueve → SIN_JURADO_ACTUAL
    // (antes de la corrección esto volvía mal a PENDIENTE, y como PENDIENTE
    // usa jurado_id_propuesto como efectivo, Pedro quedaba vigente en origen
    // Y destino a la vez).
    test('TEST A: propuesto=PEDRO, seleccionado=PEDRO, ACEPTADO, se mueve PEDRO → SIN_JURADO_ACTUAL / efectivo NULL', () => {
        const otras = [{ detalle_id: 'A', estado_revision: 'ACEPTADO', jurado_id_seleccionado: 'PEDRO', jurado_id_propuesto: 'PEDRO' }];
        const resultado = resolverFilaALiberar(otras, 'PEDRO');
        expect(resultado).toEqual({ detalle_id: 'A', nuevo_estado: 'SIN_JURADO_ACTUAL' });
        expect(obtenerJuradoEfectivo({ estado_revision: resultado.nuevo_estado, jurado_id_propuesto: 'PEDRO', jurado_id_seleccionado: null })).toBeNull();
    });

    // TEST B — motor propuso JUAN, admin modificó a PEDRO, se mueve PEDRO.
    // jurado_id_propuesto (JUAN) es DISTINTO del que se mueve → esa propuesta
    // original vuelve a quedar vigente → PENDIENTE / efectivo JUAN.
    test('TEST B: propuesto=JUAN, seleccionado=PEDRO, MODIFICADO, se mueve PEDRO → PENDIENTE / efectivo JUAN', () => {
        const otras = [{ detalle_id: 'A', estado_revision: 'MODIFICADO', jurado_id_seleccionado: 'PEDRO', jurado_id_propuesto: 'JUAN' }];
        const resultado = resolverFilaALiberar(otras, 'PEDRO');
        expect(resultado).toEqual({ detalle_id: 'A', nuevo_estado: 'PENDIENTE' });
        expect(obtenerJuradoEfectivo({ estado_revision: resultado.nuevo_estado, jurado_id_propuesto: 'JUAN', jurado_id_seleccionado: null })).toBe('JUAN');
    });

    // TEST C — solo propuesto PEDRO (PENDIENTE, nunca aceptado), se mueve PEDRO.
    test('TEST C: solo propuesto=PEDRO, PENDIENTE, se mueve PEDRO → SIN_JURADO_ACTUAL / efectivo NULL', () => {
        const otras = [{ detalle_id: 'A', estado_revision: 'PENDIENTE', jurado_id_seleccionado: null, jurado_id_propuesto: 'PEDRO' }];
        const resultado = resolverFilaALiberar(otras, 'PEDRO');
        expect(resultado).toEqual({ detalle_id: 'A', nuevo_estado: 'SIN_JURADO_ACTUAL' });
        expect(obtenerJuradoEfectivo({ estado_revision: resultado.nuevo_estado, jurado_id_propuesto: 'PEDRO', jurado_id_seleccionado: null })).toBeNull();
    });

    // CASO D del pedido: sin jurado_id_propuesto (100% manual) → SIN_PROPUESTA, igual que /revertir.
    test('CASO D: sin jurado_id_propuesto (selección 100% manual) → SIN_PROPUESTA', () => {
        const otras = [{ detalle_id: 'A', estado_revision: 'MODIFICADO', jurado_id_seleccionado: 'PEDRO', jurado_id_propuesto: null }];
        expect(resolverFilaALiberar(otras, 'PEDRO')).toEqual({ detalle_id: 'A', nuevo_estado: 'SIN_PROPUESTA' });
    });

    test('TEST G: jurado_id_propuesto histórico nunca aparece en el resultado — solo detalle_id/nuevo_estado', () => {
        const otras = [{ detalle_id: 'A', estado_revision: 'ACEPTADO', jurado_id_seleccionado: 'PEDRO', jurado_id_propuesto: 'PEDRO' }];
        const resultado = resolverFilaALiberar(otras, 'PEDRO');
        expect(Object.keys(resultado).sort()).toEqual(['detalle_id', 'nuevo_estado']);
    });

    test('jurado sin ningún uso previo en la propuesta → no hay nada que liberar', () => {
        expect(resolverFilaALiberar([], 'j1')).toBeNull();
        expect(resolverFilaALiberar([{ detalle_id: 'dOtra', estado_revision: 'ACEPTADO', jurado_id_seleccionado: 'j2', jurado_id_propuesto: 'j2' }], 'j1')).toBeNull();
    });

    test('una fila ya SIN_JURADO_ACTUAL nunca vuelve a matchear (obtenerJuradoEfectivo ya da null ahí)', () => {
        const otras = [{ detalle_id: 'dOtra', estado_revision: 'SIN_JURADO_ACTUAL', jurado_id_seleccionado: null, jurado_id_propuesto: 'j1' }];
        expect(resolverFilaALiberar(otras, 'j1')).toBeNull();
    });
});

// TEST D/E/F/H — propiedades combinadas después del movimiento, usando
// exactamente el resultado de resolverFilaALiberar (TEST A/B) + el efectivo
// de la fila destino, para verificar el estado final del par de filas.
describe('TEST D/E/F/H — estado final del par de filas tras el movimiento', () => {
    test('TEST D: después del TEST A (PEDRO movido desde una fila ACEPTADA) → PEDRO efectivo SOLO en el destino', () => {
        const filaA_despues = { estado_revision: 'SIN_JURADO_ACTUAL', jurado_id_propuesto: 'PEDRO', jurado_id_seleccionado: null };
        const filaB_despues = { estado_revision: 'ACEPTADO', jurado_id_propuesto: 'PEDRO', jurado_id_seleccionado: 'PEDRO' };
        expect(obtenerJuradoEfectivo(filaA_despues)).toBeNull();
        expect(obtenerJuradoEfectivo(filaB_despues)).toBe('PEDRO');
    });

    test('TEST E: después del TEST B (PEDRO movido desde una fila MODIFICADA que tenía a JUAN propuesto) → JUAN efectivo en origen, PEDRO efectivo en destino', () => {
        const filaA_despues = { estado_revision: 'PENDIENTE', jurado_id_propuesto: 'JUAN', jurado_id_seleccionado: null };
        const filaB_despues = { estado_revision: 'MODIFICADO', jurado_id_propuesto: null, jurado_id_seleccionado: 'PEDRO' };
        expect(obtenerJuradoEfectivo(filaA_despues)).toBe('JUAN');
        expect(obtenerJuradoEfectivo(filaB_despues)).toBe('PEDRO');
    });

    test('TEST F: nunca puede quedar PEDRO efectivo en origen Y en destino a la vez (TEST A y TEST C)', () => {
        for (const filaA_despues of [
            { estado_revision: 'SIN_JURADO_ACTUAL', jurado_id_propuesto: 'PEDRO', jurado_id_seleccionado: null }, // TEST A
            { estado_revision: 'SIN_JURADO_ACTUAL', jurado_id_propuesto: 'PEDRO', jurado_id_seleccionado: null }  // TEST C
        ]) {
            const filaB_despues = { estado_revision: 'MODIFICADO', jurado_id_propuesto: null, jurado_id_seleccionado: 'PEDRO' };
            const efectivos = [obtenerJuradoEfectivo(filaA_despues), obtenerJuradoEfectivo(filaB_despues)];
            expect(efectivos.filter(j => j === 'PEDRO').length).toBe(1);
        }
    });

    test('TEST H: SIN_JURADO_ACTUAL suma correctamente en resumenPropuesta (y no como pendiente/aceptado)', () => {
        const r = resumenPropuesta([
            { estado_revision: 'SIN_JURADO_ACTUAL' }, // TEST A / TEST C
            { estado_revision: 'PENDIENTE' }           // TEST B (JUAN vuelve a estar pendiente)
        ]);
        expect(r.sin_jurado_actual).toBe(1);
        expect(r.pendientes).toBe(1);
        expect(r.aceptados).toBe(0);
        expect(r.modificados).toBe(0);
    });
});

describe('resumenPropuesta', () => {
    test('cuenta correctamente cada estado_revision, incluido SIN_JURADO_ACTUAL', () => {
        const filas = [
            { estado_revision: 'ACEPTADO' }, { estado_revision: 'ACEPTADO' },
            { estado_revision: 'MODIFICADO' },
            { estado_revision: 'PENDIENTE' },
            { estado_revision: 'SIN_PROPUESTA' },
            { estado_revision: 'NO_EVALUABLE' },
            { estado_revision: 'SIN_JURADO_ACTUAL' }
        ];
        expect(resumenPropuesta(filas)).toEqual({
            total_rodeos: 7, aceptados: 2, modificados: 1, pendientes: 1, sin_propuesta: 1, no_evaluables: 1, sin_jurado_actual: 1
        });
    });

    test('propuesta vacía', () => {
        expect(resumenPropuesta([])).toEqual({
            total_rodeos: 0, aceptados: 0, modificados: 0, pendientes: 0, sin_propuesta: 0, no_evaluables: 0, sin_jurado_actual: 0
        });
    });

    test('sección 13: una fila liberada (SIN_JURADO_ACTUAL) no suma como pendiente ni aceptada', () => {
        const filas = [{ estado_revision: 'SIN_JURADO_ACTUAL' }];
        const r = resumenPropuesta(filas);
        expect(r.pendientes).toBe(0);
        expect(r.aceptados).toBe(0);
        expect(r.modificados).toBe(0);
        expect(r.sin_jurado_actual).toBe(1);
    });
});
