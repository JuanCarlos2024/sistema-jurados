const fs = require('fs'), path = require('path');
const G = require('./propuestaDesignacionGlobalUI');

// Regresión — Fase 2C, corrección post-producción (2026-10-31), 3 casos
// reportados tras probar el motor global con 3 rodeos reales del 07/11/2026.

describe('CASO 1 — advertencias del motor global en español (nunca JSON técnico)', () => {
    const advertenciaLlanquihue = {
        rodeo_id: 'r-llanquihue', club: 'Llanquihue', fecha: '2026-11-07',
        jurado_id: 'j-hector', preferencias_cedidas: ['ASOCIACION_REPETIDA_TEMPORADA', 'FINDE_CONSECUTIVO']
    };
    const detalleList = [
        { rodeo_id: 'r-otro', nombre_propuesto: 'Otro Jurado' },
        { rodeo_id: 'r-llanquihue', nombre_propuesto: 'Héctor Ignacio Navarro Sepúlveda' }
    ];

    test('resuelve club, fecha, nombre del jurado (buscado por rodeo_id) y preferencias cedidas', () => {
        const datos = G.pdgDatosAdvertenciaGlobal(advertenciaLlanquihue, detalleList);
        expect(datos).toEqual({
            club: 'Llanquihue', fecha: '2026-11-07', jurado: 'Héctor Ignacio Navarro Sepúlveda',
            preferencias_cedidas: ['ASOCIACION_REPETIDA_TEMPORADA', 'FINDE_CONSECUTIVO']
        });
    });

    test('nunca expone el objeto crudo del motor (ni rodeo_id ni jurado_id como claves del resultado)', () => {
        const datos = G.pdgDatosAdvertenciaGlobal(advertenciaLlanquihue, detalleList);
        expect(datos).not.toHaveProperty('rodeo_id');
        expect(datos).not.toHaveProperty('jurado_id');
    });

    test('si ningún detalle coincide con el rodeo_id, el jurado queda null (sin inventar un nombre)', () => {
        const datos = G.pdgDatosAdvertenciaGlobal(advertenciaLlanquihue, [{ rodeo_id: 'otro-distinto', nombre_propuesto: 'X' }]);
        expect(datos.jurado).toBeNull();
    });

    test('resuelve el nombre también desde jurado_efectivo.nombre o nombre_seleccionado si no hay nombre_propuesto', () => {
        const porEfectivo = G.pdgDatosAdvertenciaGlobal(advertenciaLlanquihue, [{ rodeo_id: 'r-llanquihue', jurado_efectivo: { nombre: 'Por Efectivo' } }]);
        expect(porEfectivo.jurado).toBe('Por Efectivo');
        const porSeleccionado = G.pdgDatosAdvertenciaGlobal(advertenciaLlanquihue, [{ rodeo_id: 'r-llanquihue', nombre_seleccionado: 'Por Seleccionado' }]);
        expect(porSeleccionado.jurado).toBe('Por Seleccionado');
    });

    test('entrada no reconocible (null, string, sin preferencias_cedidas) no revienta: null o arreglo vacío', () => {
        expect(G.pdgDatosAdvertenciaGlobal(null, [])).toBeNull();
        expect(G.pdgDatosAdvertenciaGlobal('texto-legado', [])).toBeNull();
        expect(G.pdgDatosAdvertenciaGlobal({ rodeo_id: 'r1' }, []).preferencias_cedidas).toEqual([]);
    });
});

describe('CASO 2 — distinción entre excepción automática del motor y modificación manual', () => {
    test('el motor global selecciona automáticamente relajando reglas (Llanquihue): NUNCA es "excepción manual"', () => {
        // jurado_id_seleccionado === jurado_id_propuesto (nadie cambió nada) pero
        // metricas_json trae advertencias PRE-ACEPTADAS por el motor (ver
        // construirAdvertenciasPreaceptadas, propuesta-designacion.html).
        const filaLlanquihue = {
            jurado_id_propuesto: 'j-hector', jurado_id_seleccionado: 'j-hector',
            metricas_json: { advertencias_aceptadas: [{ tipo: 'ASOCIACION_REPETIDA_TEMPORADA' }, { tipo: 'FINDE_CONSECUTIVO' }] }
        };
        expect(G.pdgEsExcepcionManualConfirmada(filaLlanquihue)).toBe(false);
    });

    test('fila todavía PENDIENTE (jurado_id_seleccionado null, solo lo propuesto por el motor): tampoco es excepción manual', () => {
        const fila = {
            jurado_id_propuesto: 'j-hector', jurado_id_seleccionado: null,
            metricas_json: { advertencias_aceptadas: [{ tipo: 'DISTANCIA_EXCEDIDA' }] }
        };
        expect(G.pdgEsExcepcionManualConfirmada(fila)).toBe(false);
    });

    test('el administrador elige un jurado DISTINTO del propuesto, con advertencias: SÍ es excepción manual confirmada', () => {
        const fila = {
            jurado_id_propuesto: 'j-hector', jurado_id_seleccionado: 'j-otro-admin-elige',
            metricas_json: { advertencias_aceptadas: [{ tipo: 'DISTANCIA_EXCEDIDA' }] }
        };
        expect(G.pdgEsExcepcionManualConfirmada(fila)).toBe(true);
    });

    test('completar manualmente un rodeo que no tenía propuesta (jurado_id_propuesto null), con advertencias: es excepción manual', () => {
        const fila = { jurado_id_propuesto: null, jurado_id_seleccionado: 'j-cualquiera', metricas_json: { advertencias_aceptadas: [{ tipo: 'DISTANCIA_EXCEDIDA' }] } };
        expect(G.pdgEsExcepcionManualConfirmada(fila)).toBe(true);
    });

    test('sin advertencias guardadas, nunca es excepción manual (sin importar quién sea el jurado efectivo)', () => {
        expect(G.pdgEsExcepcionManualConfirmada({ jurado_id_propuesto: 'j1', jurado_id_seleccionado: 'j2', metricas_json: {} })).toBe(false);
        expect(G.pdgEsExcepcionManualConfirmada({ jurado_id_propuesto: 'j1', jurado_id_seleccionado: 'j2', metricas_json: { advertencias_aceptadas: [] } })).toBe(false);
    });

    test('fila/metricas_json ausentes no revientan: false por defecto', () => {
        expect(G.pdgEsExcepcionManualConfirmada(null)).toBe(false);
        expect(G.pdgEsExcepcionManualConfirmada({})).toBe(false);
    });
});

describe('CASO 3 — indicador "Con jurado propuesto" (antes "Con jurado actual")', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'propuesta-designacion.html'), 'utf8');

    test('el KPI de la simulación usa la etiqueta "Con jurado propuesto"', () => {
        expect(html).toMatch(/kpi\(r\.con_jurado_actual, 'Con jurado propuesto'/);
    });

    test('el resumen de confirmación antes de guardar usa la misma etiqueta corregida', () => {
        expect(html).toMatch(/Con jurado propuesto: <strong>\$\{r\.con_jurado_actual\}<\/strong>/);
    });

    test('la etiqueta anterior ("Con jurado actual"), que sugería designación preexistente, ya no aparece', () => {
        expect(html).not.toMatch(/Con jurado actual/);
    });
});
