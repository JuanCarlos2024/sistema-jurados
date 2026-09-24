// Aclaración "bloque de rodeo ≠ período seleccionado": el backend solo AGREGA datos explicativos; los cálculos no cambian.
jest.mock('../../config/supabase', () => ({ from: jest.fn() }));
jest.mock('../colleras-completas', () => ({ obtenerCollerasCompletas: jest.fn() }));

const { serieSituacionesPorBloque } = require('./series');
const { calcularInforme } = require('./informe');

const T = { id: 't1', nombre: '2026-2027', inicio: '2026-04-01', fin: '2027-03-31', fuente: 'test' };
const rod = (id, fecha, extra = {}) => ({ id, fecha, club: 'C' + id, asociacion: 'ARAUCO', tipo_rodeo_id: 'T_SEG', tipo_rodeo_nombre: 'Provincial', categoria_rodeo_nombre: null, estado: 'activo', duracion_dias: 1, es_prueba: false, ...extra });
const veces = (n, f) => Array.from({ length: n }, (_, i) => f(i));

// 25 rodeos con fecha 18–20/09 + 1 rodeo que comienza el 17/09 (2 días: 17–18) → el bloque 17–20 tiene 26
const fiestas = () => [rod('j17', '2026-09-17', { duracion_dias: 2 }), ...veces(18, i => rod('v' + i, '2026-09-18', { duracion_dias: 2 })), ...veces(6, i => rod('s' + i, '2026-09-19', { duracion_dias: 2 })), rod('d0', '2026-09-20')];
const ctx = { evalPorRodeo: {}, casosPorEval: {} };
const ds = rodeos => ({
    temporada: T, rodeos, categoriaPorTipoId: { T_SEG: 'Segunda' },
    evaluaciones: [], casos: [], cartillas: [], asignaciones: [], notasSecundarias: [], usuarios: [], disponibilidad: [], notasJurado: [],
    catalogoAsociaciones: null, aliasAsociaciones: [], historicoRodeos: null, historicoColleras: null,
    fuentes: { asociaciones: { disponible: false }, historico_rodeos: { disponible: false }, historico_colleras: { disponible: false } }
});
const COL = { total: null, estado: 'no_disponible', resumen: {}, detalle_error: null };
const generar = (rodeos, desde, hasta) => calcularInforme({ desde, hasta, hoy: '2026-09-24' }, ds(rodeos), COL, new Date('2026-09-24T15:00:00Z'));

describe('serie por bloque: datos que explican bloque vs período', () => {
    test('el rodeo iniciado antes del período y terminado dentro del bloque se cuenta en el bloque, no en el período', () => {
        const p = serieSituacionesPorBloque({ rodeos: fiestas(), T, corte: '2026-09-20', ctx, periodo: { desde: '2026-09-18', hasta: '2026-09-20' } }).puntos;
        expect(p).toHaveLength(1);
        expect(p[0]).toMatchObject({ bloque_inicio: '2026-09-17', bloque_fin: '2026-09-20', rodeos_realizados: 26 });
        expect(p[0].periodo_seleccionado).toEqual({ desde: '2026-09-18', hasta: '2026-09-20', rodeos_inicio_dentro: 25, rodeos_inicio_antes: 1, rodeos_inicio_despues: 0 });
    });
    test('D) los cálculos NO cambian: con y sin período los puntos son idénticos salvo el campo informativo', () => {
        const con = serieSituacionesPorBloque({ rodeos: fiestas(), T, corte: '2026-09-20', ctx, periodo: { desde: '2026-09-18', hasta: '2026-09-20' } }).puntos.map(({ periodo_seleccionado, ...resto }) => resto);
        const sin = serieSituacionesPorBloque({ rodeos: fiestas(), T, corte: '2026-09-20', ctx }).puntos;
        expect(con).toEqual(sin);
        expect(sin[0]).not.toHaveProperty('periodo_seleccionado');
    });
    test('D) el informe sigue entregando 25 rodeos en el período y 26 en el bloque (ambos correctos, no se hacen coincidir)', () => {
        const inf = generar(fiestas(), '2026-09-18', '2026-09-20');
        expect(inf.periodo.rodeos.realizados).toBe(25);
        expect(inf.series.situaciones_por_bloque.puntos[0].rodeos_realizados).toBe(26);
        expect(inf.series.situaciones_por_bloque.puntos[0].periodo_seleccionado).toMatchObject({ rodeos_inicio_dentro: 25, rodeos_inicio_antes: 1 });
    });
    test('rodeo que comienza después del período pero pertenece al mismo bloque', () => {
        const rodeos = [rod('a', '2026-09-19'), rod('b', '2026-09-20')];
        const p = serieSituacionesPorBloque({ rodeos, T, corte: '2026-09-20', ctx, periodo: { desde: '2026-09-19', hasta: '2026-09-19' } }).puntos;
        expect(p[0].periodo_seleccionado).toMatchObject({ rodeos_inicio_dentro: 1, rodeos_inicio_despues: 1, rodeos_inicio_antes: 0 });
    });
});
