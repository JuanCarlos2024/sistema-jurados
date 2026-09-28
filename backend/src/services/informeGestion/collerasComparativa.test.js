// construirComparativaColleras (PURA) y cargarComparativaColleras (loader delgado). Reutiliza el mismo
// motor de fechas equivalentes y serieCollerasAcumuladas del Informe de Gestión — se valida aquí que la
// comparativa queda ACOTADA a exactamente 2 temporadas (actual + inmediatamente anterior) en cualquier caso.
const F = require('./fechasEquivalentes');
const { construirComparativaColleras, cargarComparativaColleras } = require('./collerasComparativa');

const T = { nombre: '2026-2027', inicio: '2026-04-01', fin: '2027-03-31' };
const AHORA = new Date('2026-09-28T15:00:00Z');
const HOY = F.hoyChile(AHORA);
const OBJETIVO = F.desplazarFechaEquivalente(HOY, 1);

const hist = (temporada, offsetDias, valor) => ({ temporada, fecha_medicion: F.addDays(OBJETIVO, offsetDias), total_colleras: valor, fecha_confirmada: true });
const colleras = (total) => ({ resumen: { totalCompletas: total }, filas: [] });

describe('construirComparativaColleras (pura)', () => {
    test('actual vs anterior con medición exacta en la fecha equivalente: disponible, diferencia y variación correctas', () => {
        const r = construirComparativaColleras({ colleras: colleras(41), ahora: AHORA, T, historicoColleras: [hist('2025-2026', 0, 34)], snapshotsColleras: [] });
        expect(r).toMatchObject({ disponible: true, motivo: null, temporada_actual: '2026-2027', temporada_anterior: '2025-2026' });
        expect(r.resumen).toMatchObject({ actual: 41, historico: 34, diferencia: 7, variacion_pct: 20.6, tendencia: 'SUBE', simbolo: '↑' });
    });

    test('solo se comparan 2 temporadas: filas de otras temporadas se ignoran aunque estén en historicoColleras', () => {
        const historicoColleras = [hist('2025-2026', 0, 34), hist('2024-2025', 0, 999), hist('2023-2024', 0, 1)];
        const r = construirComparativaColleras({ colleras: colleras(41), ahora: AHORA, T, historicoColleras, snapshotsColleras: [] });
        expect(r.resumen.historico).toBe(34);   // nunca 999 ni 1
        expect(r.serie.actual.temporada).toBe('2026-2027');
        expect(r.serie.anterior.temporada).toBe('2025-2026');
        const nombresEnSerie = [r.serie.actual.temporada, r.serie.anterior.temporada];
        expect(nombresEnSerie).toEqual(['2026-2027', '2025-2026']);
        expect(nombresEnSerie).not.toContain('2024-2025');
        expect(nombresEnSerie).not.toContain('2023-2024');
    });

    test('sin medición histórica dentro de tolerancia: disponible=false, motivo SIN_DATO_HISTORICO_COMPARABLE, pero el actual se conserva', () => {
        const r = construirComparativaColleras({ colleras: colleras(41), ahora: AHORA, T, historicoColleras: [hist('2025-2026', -30, 10)], snapshotsColleras: [] });
        expect(r.disponible).toBe(false);
        expect(r.motivo).toBe(F.SIN_DATO_HISTORICO_COMPARABLE);
        expect(r.resumen.actual).toBe(41);
        expect(r.resumen.historico).toBeNull();
    });

    test('sin historicoColleras en absoluto: motivo SIN_DATO_HISTORICO_COMPARABLE, no lanza', () => {
        const r = construirComparativaColleras({ colleras: colleras(41), ahora: AHORA, T, historicoColleras: [], snapshotsColleras: [] });
        expect(r.disponible).toBe(false);
        expect(r.motivo).toBe(F.SIN_DATO_HISTORICO_COMPARABLE);
    });

    test('dato actual no disponible (totalCompletas null): motivo DATO_ACTUAL_NO_DISPONIBLE', () => {
        const r = construirComparativaColleras({ colleras: { resumen: { totalCompletas: null } }, ahora: AHORA, T, historicoColleras: [hist('2025-2026', 0, 34)], snapshotsColleras: [] });
        expect(r.disponible).toBe(false);
        expect(r.motivo).toBe('DATO_ACTUAL_NO_DISPONIBLE');
        expect(r.resumen.actual).toBeNull();
    });

    test('sin objeto colleras (undefined): no lanza, se trata igual que dato no disponible', () => {
        expect(() => construirComparativaColleras({ colleras: undefined, ahora: AHORA, T, historicoColleras: [], snapshotsColleras: [] })).not.toThrow();
    });

    test('sin temporada (T null): disponible=false, motivo SIN_TEMPORADA_ACTUAL, series vacías, no lanza', () => {
        const r = construirComparativaColleras({ colleras: colleras(41), ahora: AHORA, T: null, historicoColleras: [hist('2025-2026', 0, 34)], snapshotsColleras: [] });
        expect(r).toMatchObject({ disponible: false, motivo: 'SIN_TEMPORADA_ACTUAL', temporada_actual: null, temporada_anterior: null });
        expect(r.serie.actual.puntos).toEqual([]);
        expect(r.serie.anterior.puntos).toEqual([]);
    });

    test('empate de distancia entre dos mediciones: usa la ANTERIOR a la fecha objetivo (misma regla determinística de buscarMedicionEquivalente)', () => {
        const r = construirComparativaColleras({
            colleras: colleras(41), ahora: AHORA, T,
            historicoColleras: [hist('2025-2026', -3, 30), hist('2025-2026', 3, 40)],
            snapshotsColleras: []
        });
        expect(r.resumen.historico).toBe(30);
    });

    test('la serie "actual" incluye snapshots + el dato en vivo de hoy; la serie "anterior" solo mediciones confirmadas', () => {
        const r = construirComparativaColleras({
            colleras: colleras(41), ahora: AHORA, T,
            historicoColleras: [hist('2025-2026', -14, 20), hist('2025-2026', -7, 28), hist('2025-2026', 0, 34)],
            snapshotsColleras: [{ fecha_snapshot: F.addDays(HOY, -10) + 'T15:00:00Z', total_colleras: 33 }]
        });
        expect(r.serie.actual.puntos.map(p => p.valor)).toEqual([33, 41]);
        expect(r.serie.anterior.puntos.map(p => p.valor)).toEqual([20, 28, 34]);
    });

    test('mediciones no confirmadas (fecha_confirmada=false) se descartan de la serie histórica', () => {
        const r = construirComparativaColleras({
            colleras: colleras(41), ahora: AHORA, T,
            historicoColleras: [{ ...hist('2025-2026', 0, 34), fecha_confirmada: false }],
            snapshotsColleras: []
        });
        expect(r.serie.anterior.puntos).toEqual([]);
        expect(r.disponible).toBe(false);
    });
});

describe('cargarComparativaColleras (loader)', () => {
    // Chain thenable genérico (mismo patrón que los tests de rutas): cualquier método de filtro es un no-op
    // que devuelve la cadena; se resuelve al hacer await/then con la respuesta mockeada de esa tabla.
    function dbFake(respuestas) {
        let consultadas = [];
        const db = {
            from(tabla) {
                consultadas.push(tabla);
                const chain = {};
                ['select', 'eq', 'neq', 'gte', 'lte', 'order', 'range', 'limit'].forEach(m => { chain[m] = () => chain; });
                chain.then = (resolve, reject) => Promise.resolve(respuestas[tabla] || { data: [], error: null }).then(resolve, reject);
                return chain;
            }
        };
        return { db, consultadas };
    }
    test('resuelve la temporada (remapea fecha_inicio/fecha_fin → inicio/fin) y arma la comparativa completa', async () => {
        const { db } = dbFake({
            temporadas: { data: [{ id: 'T1', nombre: '2026-2027', fecha_inicio: '2026-04-01', fecha_fin: '2027-03-31', activa: true }], error: null },
            historico_colleras_medicion: { data: [hist('2025-2026', 0, 34)], error: null },
            colleras_completas_snapshots: { data: [], error: null }
        });
        const r = await cargarComparativaColleras({ db, colleras: colleras(41), ahora: AHORA });
        expect(r).toMatchObject({ disponible: true, temporada_actual: '2026-2027', temporada_anterior: '2025-2026' });
        expect(r.resumen).toMatchObject({ actual: 41, historico: 34 });
    });
    test('sin temporada resuelta: no lanza, motivo SIN_TEMPORADA_ACTUAL, y NO consulta las otras 2 tablas', async () => {
        const { db, consultadas } = dbFake({ temporadas: { data: [], error: null } });
        const r = await cargarComparativaColleras({ db, colleras: colleras(41), ahora: AHORA });
        expect(r.disponible).toBe(false);
        expect(r.motivo).toBe('SIN_TEMPORADA_ACTUAL');
        expect(consultadas).toEqual(['temporadas', 'temporadas']);   // resolverTemporada intenta 2 selects; ninguna tabla nueva
    });
    test('error del SELECT de historico_colleras_medicion (tabla inexistente): no lanza (leerOpcional), motivo SIN_DATO_HISTORICO_COMPARABLE', async () => {
        const { db } = dbFake({
            temporadas: { data: [{ id: 'T1', nombre: '2026-2027', fecha_inicio: '2026-04-01', fecha_fin: '2027-03-31', activa: true }], error: null },
            historico_colleras_medicion: { data: null, error: { message: 'relation "historico_colleras_medicion" does not exist' } },
            colleras_completas_snapshots: { data: [], error: null }
        });
        const r = await cargarComparativaColleras({ db, colleras: colleras(41), ahora: AHORA });
        expect(r.disponible).toBe(false);
        expect(r.motivo).toBe(F.SIN_DATO_HISTORICO_COMPARABLE);
        expect(r.resumen.actual).toBe(41);   // el resto de la comparativa sigue funcionando
    });
});
