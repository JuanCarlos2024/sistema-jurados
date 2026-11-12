const fs = require('fs');
const path = require('path');
const P = require('./propuestaRevisionUI');

// 25 filas en orden estable; mezcla de estados como un borrador real.
function filas() {
    return Array.from({ length: 25 }, (_, i) => ({
        id: `d${i + 1}`, posicion: i + 1, rodeo_id: `r${i + 1}`,
        rodeo: { club: i === 4 ? 'Peñaflor' : `Club ${i + 1}`, asociacion: i % 2 ? 'Talagante' : 'Cordillera', tipo_rodeo_nombre: i === 7 ? 'Clasificatorio' : 'Provincial', clasificacion_nombre: i === 7 ? 'Clasificatorio' : 'Provincial' },
        jurado_id_propuesto: `j${i + 1}`, nombre_propuesto: i === 2 ? 'José Ñúñez Ávila' : `Jurado ${i + 1}`,
        jurado_id_seleccionado: null, nombre_seleccionado: null, estado_revision: 'PENDIENTE',
        explicacion_json: i >= 9 ? { jurado_propuesto: { optimizacion_global_relajaciones: ['FINDE_CONSECUTIVO'] } } : {},
        metricas_json: {},
    }));
}

describe('Estado visual de revisión', () => {
    test('motor sin advertencias y con relajaciones → PENDIENTE; ninguna falsa modificación', () => {
        const f = filas();
        expect(f.every(d => P.prvEstadoVisual(d) === 'PENDIENTE')).toBe(true);
        expect(P.prvContadores(f)).toEqual({ total: 25, cubiertos: 25, pendientes: 25, confirmados: 0, modificados: 0, sin_evidencia: 0, aplicados: 0, sin_jurado: 0, con_advertencias: 16 });
    });

    test('confirmado / modificado / sin jurado / no evaluable', () => {
        expect(P.prvEstadoVisual({ estado_revision: 'ACEPTADO', jurado_id_seleccionado: 'j1' })).toBe('CONFIRMADO');
        expect(P.prvEstadoVisual({ estado_revision: 'MODIFICADO', jurado_id_seleccionado: 'j9' })).toBe('MODIFICADO');
        expect(P.prvEstadoVisual({ estado_revision: 'SIN_PROPUESTA' })).toBe('SIN_JURADO');
        expect(P.prvEstadoVisual({ estado_revision: 'SIN_JURADO_ACTUAL', jurado_id_propuesto: 'j1' })).toBe('SIN_JURADO');
        expect(P.prvEstadoVisual({ estado_revision: 'NO_EVALUABLE' })).toBe('NO_EVALUABLE');
    });

    test('propuesta aplicada con clasificación automática (caso 27c6…): 17 sin evidencia, 8 modificadas, 0 confirmadas en verde', () => {
        const f = filas().map((d, i) => {
            const auto = i < 17;
            return {
                ...d, estado_revision: i < 5 ? 'ACEPTADO' : 'MODIFICADO',
                jurado_id_seleccionado: auto ? d.jurado_id_propuesto : `jM${i}`,
                decision_evidencia: { decision: auto ? 'CLASIFICACION_AUTOMATICA' : 'MODIFICACION_COMPROBADA' },
                aplicacion_real: { aplicada: true, activas: [3, 20].includes(i) ? 0 : 1, anuladas: [3, 20].includes(i) ? 1 : 0, publicadas: 1 },
            };
        });
        expect(f.slice(0, 17).every(d => P.prvEstadoVisual(d) === 'SIN_EVIDENCIA')).toBe(true);
        expect(P.prvContadores(f)).toMatchObject({ confirmados: 0, modificados: 8, sin_evidencia: 17, pendientes: 0, aplicados: 25 });
        expect(P.prvFiltrar(f, { estado: 'sin_evidencia' }).visibles).toHaveLength(17);
        expect(P.prvFiltrar(f, { estado: 'confirmados' }).visibles).toHaveLength(0);
        expect(P.prvFiltrar(f, { estado: 'aplicados' }).visibles).toHaveLength(25);
    });

    test('cobertura completa no implica aprobación', () => {
        const f = filas();
        f[0] = { ...f[0], estado_revision: 'ACEPTADO', jurado_id_seleccionado: 'j1' };
        const c = P.prvContadores(f);
        expect(c.cubiertos).toBe(25);
        expect(c.confirmados).toBe(1);
        expect(c.pendientes).toBe(24);
    });
});

describe('Buscador y filtros', () => {
    const ids = r => r.visibles.map(v => v.fila.id);

    test('búsqueda por club, asociación, tipo y jurado, sin distinguir mayúsculas ni acentos', () => {
        const f = filas();
        expect(ids(P.prvFiltrar(f, { texto: 'PENAFLOR' }))).toEqual(['d5']);
        expect(ids(P.prvFiltrar(f, { texto: 'clasificatorio' }))).toEqual(['d8']);
        expect(ids(P.prvFiltrar(f, { texto: 'jose nunez' }))).toEqual(['d3']);
        expect(P.prvFiltrar(f, { texto: 'talagante' }).visibles).toHaveLength(12);
    });

    test('busca también por el jurado actualmente seleccionado (no solo el propuesto)', () => {
        const f = filas();
        f[10] = { ...f[10], estado_revision: 'MODIFICADO', jurado_id_seleccionado: 'jX', nombre_seleccionado: 'Óscar Reemplazante' };
        expect(ids(P.prvFiltrar(f, { texto: 'oscar' }))).toEqual(['d11']);
    });

    test('búsqueda combinada con filtro de estado; el orden estable se conserva', () => {
        const f = filas();
        f[3] = { ...f[3], estado_revision: 'ACEPTADO', jurado_id_seleccionado: 'j4' };
        f[1] = { ...f[1], estado_revision: 'ACEPTADO', jurado_id_seleccionado: 'j2' };
        const r = P.prvFiltrar(f, { texto: 'talagante', estado: 'confirmados' });
        expect(ids(r)).toEqual(['d2', 'd4']);
        expect(r.total).toBe(25);
        expect(ids(P.prvFiltrar(f, { estado: 'advertencias' }))).toEqual(f.slice(9).map(d => d.id));
    });

    test('una fila editada que deja de cumplir el filtro permanece visible y marcada (no desaparece sin aviso)', () => {
        const f = filas();
        f[4] = { ...f[4], estado_revision: 'ACEPTADO', jurado_id_seleccionado: 'j5' }; // ya no es "pendiente"
        const r = P.prvFiltrar(f, { estado: 'pendientes' }, new Set(['d5']));
        const v = r.visibles.find(x => x.fila.id === 'd5');
        expect(v).toEqual({ fila: f[4], fijada: true });
        expect(r.visibles.map(x => x.fila.posicion)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1)); // orden intacto
    });

    test('sin filtros → los 25 en el orden recibido', () => {
        expect(ids(P.prvFiltrar(filas(), {}))).toEqual(filas().map(d => d.id));
    });
});

// ── Pantalla real: se ejecutan las funciones REALES extraídas del HTML ──
describe('propuesta-designacion.html — contexto conservado tras editar', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'propuesta-designacion.html'), 'utf8');
    const bloque = html.slice(html.indexOf('const filtroRevision ='), html.indexOf('let propuestaAbierta = null;'));

    function montar(detalle) {
        const nodos = {};
        const document = { getElementById: id => (nodos[id] = nodos[id] || { innerHTML: '', textContent: '' }) };
        const window = { scrollY: 1840, scrollTo: jest.fn() };
        let rerenders = 0;
        const fn = new Function('document', 'window', 'sanitizar', 'prvFiltrar', 'prvContadores', 'PRV_FILTROS_ESTADO', 'renderFilaDetallePropuesta', 'rerenderModo', 'previewTemporal', 'propuestaAbierta',
            bloque + '; return { filtroRevision, fijadosRevision, fijarFilaEditada, conservandoScroll, renderListaRevision, cambiarBusquedaRevision, cambiarEstadoRevision, limpiarFiltrosRevision };');
        const api = fn(document, window, s => String(s), P.prvFiltrar, P.prvContadores, P.PRV_FILTROS_ESTADO,
            (d, modo, opts) => `[${d.posicion}${opts.fijada ? '*' : ''}]`, () => { rerenders++; }, null, { detalle });
        return { api, nodos, window, rerenders: () => rerenders };
    }

    test('el desplazamiento vertical se restaura después de re-renderizar', () => {
        const { api, window } = montar(filas());
        api.conservandoScroll(() => { window.scrollY = 0; });
        expect(window.scrollTo).toHaveBeenCalledWith(0, 1840);
    });

    test('búsqueda y filtro se mantienen entre re-renders; la lista respeta el orden y muestra "X de Y"', () => {
        const { api, nodos } = montar(filas());
        api.cambiarBusquedaRevision('borrador', 'talagante');
        expect(api.filtroRevision.borrador.texto).toBe('talagante');
        expect(nodos['rev-contador-borrador'].textContent).toBe('Mostrando 12 de 25 rodeos');
        expect(nodos['lista-filas-borrador'].innerHTML).toBe('[2][4][6][8][10][12][14][16][18][20][22][24]');
        api.renderListaRevision('borrador'); // re-render tras una operación
        expect(api.filtroRevision.borrador.texto).toBe('talagante');
    });

    test('fila editada con filtro activo queda fijada; "Limpiar filtros" recupera todo en orden estable', () => {
        const f = filas();
        const { api, nodos } = montar(f);
        api.cambiarEstadoRevision('borrador', 'pendientes');
        f[4].estado_revision = 'ACEPTADO'; f[4].jurado_id_seleccionado = 'j5';
        api.fijarFilaEditada('borrador', 'd5');
        api.renderListaRevision('borrador');
        expect(nodos['lista-filas-borrador'].innerHTML).toContain('[5*]');
        api.limpiarFiltrosRevision('borrador');
        expect(api.filtroRevision.borrador).toEqual({ texto: '', estado: 'todos' });
        expect(api.fijadosRevision.borrador.size).toBe(0);
        api.renderListaRevision('borrador');
        expect(nodos['lista-filas-borrador'].innerHTML).toBe(f.map(d => `[${d.posicion}]`).join(''));
    });

    test('recargar la propuesta tras una acción conserva el scroll y la tarjeta muestra "Rodeo N de M"', () => {
        expect(html).toMatch(/conservandoScroll\(\(\) => renderVistaPropuesta\(\)\)/);
        expect(html).toMatch(/Rodeo \$\{d\.posicion \|\| '—'\} de \$\{total\}/);
        expect(html).toMatch(/✓ Confirmar jurado propuesto/);
        expect(html).toMatch(/placeholder="Buscar club, asociación, tipo de rodeo o jurado\.\.\."/);
    });
});
