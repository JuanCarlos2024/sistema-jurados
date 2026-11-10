// Sin jsdom en el proyecto: el HTML generado se analiza con cheerio
// (dependencia ya existente del backend).
const path = require('path');
const cheerio = require(path.join(__dirname, '../../backend/node_modules/cheerio'));
const RJ = require('./resumenJuradosTabla');

function fila(n, fecha, asociacion, club, pago_base, bono, extra = {}) {
    return { n, asignacion_id: 'A' + n, rodeo_id: 'R' + n, fecha, asociacion, club, categoria: 'B', tipo_rodeo: 'Rodeo Libre',
        duracion_dias: 1, pago_base, bono_aprobado: bono, bruto: pago_base + bono, retencion_monto: null, liquido: null, ...extra };
}

const DATA = {
    retencion_porcentaje: 15.25,
    data: [
        { id: 'U1', codigo_interno: 'USR-0001', nombre_completo: 'Agustín Correa Guzmán', rut: '11.111.111-1', tipo_persona: 'jurado',
          cant_rodeos: 1, total_pago_base: 245000, total_bono_aprobado: 0, bruto: 245000, retencion_monto: 37363, liquido: 207637,
          designaciones_rechazadas: 0, rodeos_detalle: [fila(1, '2026-10-03', 'Los Dominicos de Las Condes', 'Los Dominicos', 245000, 0)] },
        { id: 'U2', codigo_interno: 'USR-2850', nombre_completo: 'Alberto <b>Saravia</b>', rut: '22.222.222-2', tipo_persona: 'jurado',
          cant_rodeos: 4, total_pago_base: 1225000, total_bono_aprobado: 35000, bruto: 1260000, retencion_monto: 192150, liquido: 1067850,
          designaciones_rechazadas: 0, rodeos_detalle: [
            fila(1, '2026-10-03', 'Puente Alto', 'Puente Alto', 245000, 0),
            fila(2, '2026-10-10', 'Puente Alto', 'San Joaquín', 305000, 35000, { duracion_dias: 2 }),
            fila(3, '2026-10-18', 'San Joaquín', 'San Joaquín', 245000, 0),
            fila(4, '2026-10-24', 'Longotoro', 'Longotoro', 430000, 0),
        ] },
        { id: 'U4', codigo_interno: 'USR-0004', nombre_completo: 'Zoe Rechazos', rut: '44', tipo_persona: 'jurado',
          cant_rodeos: 0, total_pago_base: 0, total_bono_aprobado: 0, bruto: 0, retencion_monto: 0, liquido: 0,
          designaciones_rechazadas: 1, rodeos_detalle: [] },
    ],
    totales_global: { cant_jurados: 3, cant_rodeos: 5, total_pago_base: 1470000, total_bono_aprobado: 35000, bruto: 1505000, retencion_monto: 229513, liquido: 1275487 },
    conciliacion: { ok: true, errores: [], advertencias: [] },
};

const dom = html => cheerio.load(html);
const txt = ($, el) => $(el).text().replace(/\s+/g, ' ').trim();

describe('Resumen por jurado — tabla web agrupada', () => {
    test('una sola tabla, un bloque por jurado, una fila por rodeo (sin tarjetas)', () => {
        const $ = dom(RJ.renderTablaResumenJurados(DATA));
        expect($('table')).toHaveLength(1);
        expect($('tbody.rj-grupo')).toHaveLength(3);
        expect($('tr.rj-detalle')).toHaveLength(1 + 4 + 1);
        expect($('.card')).toHaveLength(0);
    });

    test('identificación del jurado agrupada con rowspan = cantidad de rodeos; nombre no se repite', () => {
        const $ = dom(RJ.renderTablaResumenJurados(DATA));
        const grupo = $('tbody.rj-grupo').eq(1);
        const ids = grupo.find('td.rj-id');
        expect(ids).toHaveLength(3);
        ids.each((_, td) => expect($(td).attr('rowspan')).toBe('4'));
        expect(grupo.text().match(/Saravia/g)).toHaveLength(2); // celda del jurado + fila de subtotal
        expect(grupo.find('tr.rj-detalle').eq(0).find('td')).toHaveLength(14);
        expect(grupo.find('tr.rj-detalle').eq(1).find('td')).toHaveLength(11);
    });

    test('columnas en el orden aprobado', () => {
        const $ = dom(RJ.renderTablaResumenJurados(DATA));
        expect($('thead th').map((_, th) => txt($, th)).get()).toEqual([
            'Código', 'Jurado', 'RUT', 'N.º', 'Fecha', 'Asociación organizadora', 'Club organizador', 'Cat.', 'Tipo de rodeo',
            'Pago base', 'Bono', 'Total bruto', 'Retención', 'Líquido',
        ]);
    });

    test('fila de rodeo: fecha DD/MM/AAAA sin desplazamiento, montos CLP, retención/líquido vacíos', () => {
        const $ = dom(RJ.renderTablaResumenJurados(DATA));
        const tds = $('tbody.rj-grupo').eq(1).find('tr.rj-detalle').eq(1).find('td').map((_, t) => txt($, t)).get();
        expect(tds).toEqual(['2', '10/10/2026', 'Puente Alto', 'San Joaquín', 'B', 'Rodeo Libre (2 días)', '$305.000', '$35.000', '$340.000', '', '']);
    });

    test('subtotal por jurado con N rodeos y montos del backend', () => {
        const $ = dom(RJ.renderTablaResumenJurados(DATA));
        const sub = $('tr.rj-subtotal').eq(1);
        const tds = sub.find('td').map((_, t) => txt($, t)).get();
        expect(tds[0]).toBe('TOTAL JURADO: Alberto <b>Saravia</b> (4 RODEOS)');
        expect(tds.slice(1)).toEqual(['$1.225.000', '$35.000', '$1.260.000', '-$192.150', '$1.067.850']);
        expect(sub.find('.rj-ret')).toHaveLength(1);
        expect(sub.find('.rj-liq')).toHaveLength(1);
        expect($('tr.rj-subtotal').eq(0).text()).toContain('(1 RODEO)');
    });

    test('jurado sin rodeos con pago: se indica y su subtotal queda en cero', () => {
        const $ = dom(RJ.renderTablaResumenJurados(DATA));
        const g = $('tbody.rj-grupo').eq(2);
        expect(g.text()).toContain('Sin rodeos con pago en el período.');
        expect(g.find('tr.rj-subtotal').text()).toContain('1 designación(es) rechazada(s), sin pago');
    });

    test('total general', () => {
        const $ = dom(RJ.renderTablaResumenJurados(DATA));
        const tds = $('tfoot tr.rj-total td').map((_, t) => txt($, t)).get();
        expect(tds).toEqual(['TOTAL GENERAL DEL REPORTE — 3 jurados · 5 asignaciones', '$1.470.000', '$35.000', '$1.505.000', '-$229.513', '$1.275.487']);
    });

    test('escapa HTML en nombres y conserva el botón Ver con datos del jurado', () => {
        const html = RJ.renderTablaResumenJurados(DATA);
        expect(html).not.toContain('<b>Saravia</b>');
        const $ = dom(html);
        const btn = $('button.rj-ver').eq(1);
        expect(btn.attr('data-jurado-id')).toBe('U2');
        expect(btn.attr('data-jurado-nombre')).toBe('Alberto <b>Saravia</b>');
    });

    test('indicadores superiores sin cambios de significado', () => {
        const $ = dom(RJ.renderStatsResumen(DATA));
        expect($('.stat-card').map((_, c) => `${txt($, $(c).find('.val'))} ${txt($, $(c).find('.lbl'))}`).get()).toEqual([
            '3 Jurados', '5 Asignaciones', '$1.470.000 Total pago base', '$35.000 Total bonos', '$1.505.000 Total bruto', '$1.275.487 Total líquido',
        ]);
    });

    test('muestra advertencias de conciliación cuando existen; sin datos → mensaje vacío', () => {
        const conAdv = { ...DATA, conciliacion: { ok: true, errores: [], advertencias: ['2 asignaciones vigentes en el mismo rodeo'] } };
        expect(RJ.renderTablaResumenJurados(conAdv)).toContain('alerta-advertencia');
        expect(RJ.renderTablaResumenJurados({ data: [] })).toContain('Sin datos para los filtros seleccionados');
    });

    test('fecha por texto: nunca se desplaza por zona horaria', () => {
        expect(RJ._fecha('2026-10-01')).toBe('01/10/2026');
        expect(RJ._fecha('2026-10-31T00:00:00Z')).toBe('31/10/2026');
    });
});
