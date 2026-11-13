const { fechaHoyChile, ultimoDiaRodeo, designacionesBloqueantes, validarSolicitudCambioFuncion } = require('./cambioFuncionUsuario');

describe('fechaHoyChile (mismo criterio que la RPC: America/Santiago)', () => {
    test('23:30 en Chile sigue siendo el mismo día aunque en UTC ya sea el siguiente', () => {
        expect(fechaHoyChile(new Date('2026-11-14T02:30:00Z'))).toBe('2026-11-13');   // verano: UTC-3
        expect(fechaHoyChile(new Date('2026-06-15T03:30:00Z'))).toBe('2026-06-14');   // invierno: UTC-4
        expect(fechaHoyChile(new Date('2026-11-13T15:00:00Z'))).toBe('2026-11-13');
    });
});

describe('ultimoDiaRodeo / designacionesBloqueantes', () => {
    test('último día = fecha + duración - 1 (mínimo 1 día)', () => {
        expect(ultimoDiaRodeo({ fecha: '2026-11-30', duracion_dias: 3 })).toBe('2026-12-02');
        expect(ultimoDiaRodeo({ fecha: '2026-11-30', duracion_dias: null })).toBe('2026-11-30');
        expect(ultimoDiaRodeo({ fecha: '2026-11-30', duracion_dias: 0 })).toBe('2026-11-30');
    });
    const a = (fecha, extra = {}, rodeo = {}) => ({ estado: 'activo', estado_designacion: 'aceptado', ...extra, rodeos: { fecha, duracion_dias: 1, estado: 'activo', ...rodeo } });
    test('solo cuentan activas, no rechazadas, de rodeos no anulados, que terminan hoy o después', () => {
        const hoy = '2026-11-13';
        const lista = [
            a('2026-11-13'), a('2026-11-12', {}, { duracion_dias: 2 }), a('2026-12-01', { estado_designacion: 'pendiente' }),
            a('2026-11-12'), a('2026-12-01', { estado: 'anulado' }), a('2026-12-01', { estado_designacion: 'rechazado' }), a('2026-12-01', {}, { estado: 'anulado' })
        ];
        expect(designacionesBloqueantes(lista, hoy)).toHaveLength(3);
    });
});

describe('validarSolicitudCambioFuncion', () => {
    test('normaliza el motivo y fuerza categoría null para DR', () => {
        expect(validarSolicitudCambioFuncion({ tipo_persona: 'delegado_rentado', motivo: '  x  ' }))
            .toEqual({ ok: true, datos: { tipo_persona: 'delegado_rentado', categoria: null, motivo: 'x' } });
        expect(validarSolicitudCambioFuncion({ tipo_persona: 'delegado_rentado', categoria: '', motivo: 'x' }).ok).toBe(true);
        expect(validarSolicitudCambioFuncion({ tipo_persona: 'jurado', categoria: 'A', motivo: 'x' }).datos.categoria).toBe('A');
    });
    test.each([[undefined], [null], [{}], [{ tipo_persona: 'jurado', categoria: 'A', motivo: 5 }]])('rechaza %p', (b) => {
        expect(validarSolicitudCambioFuncion(b).ok).toBe(false);
    });
});
