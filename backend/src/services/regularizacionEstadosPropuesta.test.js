const { clasificarFilasRegularizacion, metricasRegularizadas, resumenClasificacion, evaluarBloqueoEscritura } = require('./regularizacionEstadosPropuesta');
const { clasificarDecisionFila } = require('./evidenciaDecisionPropuesta');

// Borrador NUNCA aplicado con el defecto del guardado (la propuesta real
// 27c6bc5d… ya fue aplicada: ver historialDesignaciones.propuestaAplicada.test.js).
const PROP = { id: 'p-borrador', estado: 'BORRADOR' };
const fila = (i, extra = {}) => ({
    id: `d${i}`, rodeo_id: `r${i}`, jurado_id_propuesto: `j${i}`, jurado_id_seleccionado: `j${i}`,
    estado_revision: i < 9 ? 'ACEPTADO' : 'MODIFICADO', origen_seleccion: i < 9 ? 'MOTOR' : 'MANUAL_CON_ADVERTENCIA',
    metricas_json: { orden_presentacion: i, advertencias_aceptadas: i < 9 ? undefined : [{ tipo: 'FINDE_CONSECUTIVO' }] }, ...extra,
});

describe('Evidencia de decisión individual (fuente única)', () => {
    test('aplicación colectiva, publicación y regularización NO son evidencia de confirmación', () => {
        const d = fila(0);
        const c = clasificarDecisionFila(d, {
            bitacora: [{ tipo_movimiento: 'aplicacion_propuesta' }],
            auditoria: [{ accion: 'regularizar', datos_nuevos: { estado_revision: 'PENDIENTE' } }],
            asignaciones: [{ estado: 'activo', publicado: true }, { estado: 'anulado', publicado: true }],
        });
        expect(c.decision).toBe('CLASIFICACION_AUTOMATICA');
        expect(c.comprobada).toBe(false);
        expect(c.aplicacion).toEqual({ aplicada: true, asignaciones: 2, activas: 1, anuladas: 1, publicadas: 1 });
    });

    test('evidencias válidas: auditoría de la fila, bitácora de modificación, marca de revisión', () => {
        expect(clasificarDecisionFila(fila(0), { auditoria: [{ accion: 'editar', datos_nuevos: { estado_revision: 'ACEPTADO' } }] }).decision).toBe('CONFIRMACION_COMPROBADA');
        expect(clasificarDecisionFila(fila(0, { metricas_json: { revision_administrativa: { accion: 'CONFIRMAR' } } })).decision).toBe('CONFIRMACION_COMPROBADA');
        const mod = fila(12, { jurado_id_seleccionado: 'otro', origen_seleccion: 'MANUAL' });
        expect(clasificarDecisionFila(mod, { bitacora: [{ tipo_movimiento: 'modificacion_manual_borrador' }] }).decision).toBe('MODIFICACION_COMPROBADA');
        expect(clasificarDecisionFila(mod, {}).decision).toBe('MODIFICACION_SIN_REGISTRO'); // cambio real, sin autor/motivo
        expect(clasificarDecisionFila(fila(0, { estado_revision: 'PENDIENTE', jurado_id_seleccionado: null }), {}).decision).toBe('PENDIENTE');
    });
});

describe('Regularización — borrador nunca aplicado', () => {
    const detalles = Array.from({ length: 25 }, (_, i) => fila(i));

    test('las 25 filas sin evidencia se proponen a PENDIENTE conservando los 25 jurados propuestos', () => {
        const filas = clasificarFilasRegularizacion({ propuesta: PROP, detalles, bitacora: [], auditoria: [], asignaciones: [] });
        expect(resumenClasificacion(filas, { propuesta: PROP, asignaciones: [] })).toMatchObject({
            total: 25, a_corregir: 25, aceptado_a_pendiente: 9, modificado_a_pendiente: 16, se_conservan: 0, jurados_sin_cambio: true,
            bloqueo: { bloqueada: false, motivos: [] },
        });
        filas.forEach((f, i) => {
            expect(f.antes.jurado_id_propuesto).toBe(`j${i}`);
            expect(f.despues).toEqual({ estado_revision: 'PENDIENTE', origen_seleccion: null, jurado_id_propuesto: `j${i}`, jurado_id_seleccionado: null });
        });
    });

    test('no fabrica nada: filas con evidencia real o cambio de jurado se conservan', () => {
        const d = [
            fila(0),                                                         // corregible
            fila(1),                                                         // auditoría individual de confirmación → conservar
            fila(2, { jurado_id_seleccionado: 'otro' }),                     // cambio real con bitácora
            fila(3, { jurado_id_seleccionado: 'otro2' }),                    // cambio real sin registro → conservar
            fila(5, { metricas_json: { revision_administrativa: { accion: 'CONFIRMAR' } } }),
            fila(6, { estado_revision: 'PENDIENTE', origen_seleccion: null, jurado_id_seleccionado: null }),
        ];
        const filas = clasificarFilasRegularizacion({
            propuesta: PROP, detalles: d,
            bitacora: [{ propuesta_detalle_id: 'd2', tipo_movimiento: 'modificacion_manual_borrador' }],
            auditoria: [{ tabla: 'propuestas_designacion_detalle', registro_id: 'd1', accion: 'editar', datos_nuevos: { estado_revision: 'ACEPTADO' } }, { tabla: 'propuestas_designacion', registro_id: PROP.id }],
            asignaciones: [],
        });
        expect(filas.map(f => f.corregir)).toEqual([true, false, false, false, false, false]);
        expect(filas.map(f => f.categoria)).toEqual(['CLASIFICACION_AUTOMATICA', 'CONFIRMACION_COMPROBADA', 'MODIFICACION_COMPROBADA', 'MODIFICACION_SIN_REGISTRO', 'CONFIRMACION_COMPROBADA', 'SIN_DECISION']);
        expect(filas.filter(f => !f.corregir).every(f => JSON.stringify(f.antes) === JSON.stringify(f.despues))).toBe(true);
    });

    test('metricas regularizadas conservan advertencias, métricas y orden, y registran el estado anterior', () => {
        const [f] = clasificarFilasRegularizacion({ propuesta: PROP, detalles: [fila(12)], bitacora: [], auditoria: [], asignaciones: [] });
        const m = metricasRegularizadas(fila(12).metricas_json, f, { actorId: 'adm', motivo: 'Regularización', fecha: '2026-11-11T15:00:00Z' });
        expect(m.orden_presentacion).toBe(12);
        expect(m.advertencias_aceptadas).toEqual([{ tipo: 'FINDE_CONSECUTIVO' }]);
        expect(m.regularizacion).toEqual({ fecha: '2026-11-11T15:00:00Z', actor_id: 'adm', motivo: 'Regularización', estado_anterior: 'MODIFICADO', origen_anterior: 'MANUAL_CON_ADVERTENCIA', jurado_seleccionado_anterior: 'j12' });
    });

    test('idempotente: una fila ya regularizada (PENDIENTE) no vuelve a corregirse', () => {
        const ya = fila(0, { estado_revision: 'PENDIENTE', origen_seleccion: null, jurado_id_seleccionado: null });
        const [f] = clasificarFilasRegularizacion({ propuesta: PROP, detalles: [ya], bitacora: [], auditoria: [{ tabla: 'propuestas_designacion_detalle', registro_id: 'd0', accion: 'regularizar' }], asignaciones: [] });
        expect(f.corregir).toBe(false);
    });
});

describe('Bloqueo de seguridad (sin parámetro para saltarlo)', () => {
    const detalles = Array.from({ length: 4 }, (_, i) => fila(i));

    test('UNA sola asignación real (aunque esté anulada) bloquea TODA la propuesta', () => {
        const asignaciones = [{ propuesta_detalle_id: 'd3', estado: 'anulado' }];
        const filas = clasificarFilasRegularizacion({ propuesta: PROP, detalles, bitacora: [], auditoria: [], asignaciones });
        expect(filas.every(f => !f.corregir)).toBe(true);
        expect(filas[0].tratamiento).toMatch(/sin modificar datos/);
        expect(evaluarBloqueoEscritura({ propuesta: PROP, asignaciones })).toMatchObject({ bloqueada: true });
    });

    test('propuesta no BORRADOR → bloqueada', () => {
        const filas = clasificarFilasRegularizacion({ propuesta: { ...PROP, estado: 'CONFIRMADA' }, detalles, bitacora: [], auditoria: [], asignaciones: [] });
        expect(filas.every(f => !f.corregir)).toBe(true);
    });

    test('el script 018 no ofrece ningún parámetro de omisión y revalida antes de escribir', () => {
        const fs = require('fs');
        const src = fs.readFileSync(require('path').join(__dirname, '..', '..', '..', 'database', 'maintenance', '018_regularizar_estados_falsos_propuesta_designacion.js'), 'utf8');
        const flags = [...src.matchAll(/arg\('([a-z-]+)'\)/g)].map(m => m[1]).sort();
        expect([...new Set(flags)]).toEqual(['actor-email', 'aplicar', 'motivo', 'propuesta-id']);
        // El rechazo por bloqueo ocurre ANTES de resolver actor/motivo y antes de cualquier update.
        const iRechazo = src.indexOf('--aplicar RECHAZADO: la propuesta está bloqueada');
        expect(iRechazo).toBeGreaterThan(0);
        expect(iRechazo).toBeLessThan(src.indexOf(".update({"));
        expect(src.indexOf('revalidación previa a escribir')).toBeLessThan(src.indexOf(".update({"));
    });
});
