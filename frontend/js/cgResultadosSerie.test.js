// Presentación de resultados Serie de Campeones en admin/importacion.html.
const fs = require('fs');
const path = require('path');
const m = require('./cgResultadosSerie');

const rsConflicto = {
    estado: 'conflicto', columnas_presentes: true, rodeo_id: 'r1', errores: [],
    lugares: [
        { lugar: 1, excel: '27+8', actual: '27+8', comparacion: 'igual' },
        { lugar: 2, excel: '26', actual: '25', comparacion: 'conflicto' },
        { lugar: 3, excel: null, actual: '20', comparacion: 'no_informado' }
    ]
};

describe('cgrsHtmlCelda', () => {
    test('muestra "N°: puntaje" de cada lugar informado y el valor registrado en conflicto', () => {
        const h = m.cgrsHtmlCelda(rsConflicto, 4);
        expect(h).toContain('1°: <strong>27+8</strong>');
        expect(h).toContain('2°: <strong>26</strong>');
        expect(h).toContain('registrado: 25');
        expect(h).not.toContain('3°:'); // no informado -> no se muestra
        expect(h).toContain('id="cg-res-accion-4"');
        // por defecto se CONSERVA lo registrado
        expect(h).toMatch(/<option value="completar" selected>Conservar existentes/);
    });
    test('sin columnas -> guion; estados no aplicables no ofrecen selector', () => {
        expect(m.cgrsHtmlCelda({ columnas_presentes: false }, 0)).not.toContain('select');
        const h = m.cgrsHtmlCelda({ estado: 'rodeo_no_encontrado', columnas_presentes: true, lugares: [{ lugar: 1, excel: '27', comparacion: 'pendiente' }], errores: ['Rodeo ID no existe en el sistema.'] }, 0);
        expect(h).toContain('Rodeo ID no encontrado');
        expect(h).not.toContain('<select');
    });
    test('escapa HTML de valores y errores', () => {
        const h = m.cgrsHtmlCelda({ estado: 'error', columnas_presentes: true, lugares: [], errores: ['<img src=x onerror=alert(1)>'] }, 0);
        expect(h).not.toContain('<img');
        expect(h).toContain('&lt;img');
    });
});

describe('cgrsDecision', () => {
    test('reemplazar adjunta exactamente los valores que se vieron', () => {
        expect(m.cgrsDecision(rsConflicto, 'reemplazar')).toEqual({ accion_resultados: 'reemplazar', resultados_actuales_vistos: ['27+8', '25', '20'] });
    });
    test('completar / omitir / sin_cambios / no aplicable', () => {
        expect(m.cgrsDecision(rsConflicto, 'completar')).toEqual({ accion_resultados: 'completar' });
        expect(m.cgrsDecision({ ...rsConflicto, estado: 'listo' }, 'omitir')).toEqual({ accion_resultados: 'omitir' });
        expect(m.cgrsDecision({ ...rsConflicto, estado: 'sin_cambios' }, null)).toEqual({ accion_resultados: 'completar' });
        expect(m.cgrsDecision({ estado: 'error' }, 'reemplazar')).toEqual({ accion_resultados: 'omitir' });
        expect(m.cgrsDecision(undefined, null)).toEqual({ accion_resultados: 'omitir' });
    });
});

test('confirmación de reemplazo lista registrado -> Excel; sin reemplazos no pide confirmación', () => {
    const filas = [{ fila_index: 0, club: 'SAN CARLOS', fecha: '2026-09-18', resultados_serie: rsConflicto }];
    const t = m.cgrsTextoConfirmacionReemplazo(filas, [{ fila_index: 0, accion_resultados: 'reemplazar' }]);
    expect(t).toContain('2°: 25 → 26');
    expect(t).toContain('1 puntaje(s)');
    expect(m.cgrsTextoConfirmacionReemplazo(filas, [{ fila_index: 0, accion_resultados: 'completar' }])).toBeNull();
});

test('informe final muestra los 7 indicadores del pedido', () => {
    const h = m.cgrsHtmlResultadoFinal({
        columnas_presentes: true, rodeos_procesados: 3, importados_1: 3, importados_2: 2, importados_3: 1,
        reemplazados: 0, iguales: 1, rodeos_sin_resultados: 4, conflictos: 1, conflictos_conservados: 1,
        rodeo_id_no_encontrados: 2, sin_rodeo_id: 0, con_error: 0, omitidos_por_usuario: 0,
        detalle: [{ fila_index: 1, lugares: [{ lugar: 2, estado: 'conflicto_conservado', anterior: '25', excel: '26' }] }]
    });
    for (const t of ['Rodeos procesados', 'Resultados 1° lugar importados', 'Resultados 2° lugar importados',
        'Resultados 3° lugar importados', 'Rodeos sin resultados informados', 'Conflictos con resultados existentes', 'Rodeo ID no encontrados']) {
        expect(h).toContain(t);
    }
    expect(h).toContain('2° registrado 25 / Excel 26 → se conservó el registrado');
    expect(m.cgrsHtmlResultadoFinal({ columnas_presentes: false })).toBe('');
});

test('importacion.html carga el módulo y usa sus funciones', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'importacion.html'), 'utf8');
    expect(html).toContain('<script src="/js/cgResultadosSerie.js"></script>');
    expect(html.indexOf('/js/utils.js')).toBeLessThan(html.indexOf('/js/cgResultadosSerie.js'));
    for (const fn of ['cgrsHtmlCelda(', 'cgrsDecision(', 'cgrsTextoConfirmacionReemplazo(', 'cgrsHtmlResumenPreview(', 'cgrsHtmlResultadoFinal(']) {
        expect(html).toContain(fn);
    }
});
