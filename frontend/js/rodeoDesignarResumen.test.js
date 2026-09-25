const fs = require('fs'), path = require('path');
const R = require('./rodeoDesignarResumen');

const rodeoA = { id: 'A-1', club: 'Sin club', asociacion: 'LINARES', fecha: '2026-10-03', tipo_rodeo_nombre: 'Interasociaciones Limitado 25 colleras', categoria_rodeo_nombre: 'Primera', duracion_dias: 2 };
const rodeoB = { id: 'B-2', club: 'LOS ANGELES', asociacion: 'RIO BIO-BIO', fecha: '2026-10-10', tipo_rodeo_nombre: 'Provincial', categoria_rodeo_nombre: 'Segunda', duracion_dias: 1 };
const valores = html => Object.fromEntries(R.rdrCampos(html).map(c => [c.etiqueta, c.valor]));

describe('resumen del rodeo en "Designar jurado": campos', () => {
    test('CASO A: muestra club, asociación, fecha, tipo, categoría y duración del rodeo', () => {
        expect(valores(rodeoA)).toEqual({ Club: 'Sin club', 'Asociación': 'LINARES', Fecha: '03/10/2026', 'Categoría': 'Primera', 'Duración': '2 días', Tipo: 'Interasociaciones Limitado 25 colleras' });
    });
    test('prioridad visual: Club, Asociación y Fecha primero; el tipo (texto largo) ocupa el ancho completo', () => {
        const c = R.rdrCampos(rodeoA);
        expect(c.slice(0, 3).map(x => x.etiqueta)).toEqual(['Club', 'Asociación', 'Fecha']);
        expect(c.find(x => x.clave === 'tipo').completo).toBe(true);
    });
    test('CASO C: club "Sin club" se muestra tal cual (dato real del rodeo)', () => {
        expect(R.rdrHtmlResumen(rodeoA)).toContain('<strong>Sin club</strong>');
    });
    test('CASO E y F: duración con singular / plural', () => {
        expect(R.rdrTextoDuracion(1)).toBe('1 día');
        expect(R.rdrTextoDuracion(2)).toBe('2 días');
        expect(R.rdrTextoDuracion(3)).toBe('3 días');
        expect(R.rdrTextoDuracion('2')).toBe('2 días');
    });
    test('fecha DD/MM/AAAA; fechas con hora ISO; inválidas → null (nunca "Invalid Date")', () => {
        expect(R.rdrTextoFecha('2026-10-03')).toBe('03/10/2026');
        expect(R.rdrTextoFecha('2026-10-03T00:00:00.000Z')).toBe('03/10/2026');
        expect(R.rdrTextoFecha('2026-02-31')).toBeNull();
        expect(R.rdrTextoFecha('basura')).toBeNull();
        expect(R.rdrTextoFecha(null)).toBeNull();
    });
});

describe('datos faltantes: nunca "undefined", "null", "Invalid Date" ni "NaN"', () => {
    test('rodeo con todo null/undefined → "Sin información" (categoría: "Sin categoría")', () => {
        const html = R.rdrHtmlResumen({ id: 'X', club: null, asociacion: undefined, fecha: null, tipo_rodeo_nombre: '', categoria_rodeo_nombre: null, duracion_dias: null });
        expect(html).not.toMatch(/undefined|null|Invalid Date|NaN/);
        expect(valores({ id: 'X' })).toEqual({ Club: 'Sin información', 'Asociación': 'Sin información', Fecha: 'Sin información', 'Categoría': 'Sin categoría', 'Duración': 'Sin información', Tipo: 'Sin información' });
    });
    test('duración inválida (0, negativa, texto, NaN) → "Sin información"', () => {
        for (const d of [0, -2, 'abc', NaN, 1.5, '']) expect(R.rdrTextoDuracion(d)).toBeNull();
        expect(valores({ duracion_dias: 0 })['Duración']).toBe('Sin información');
    });
    test('sin objeto de rodeo: estado de carga (sin datos inventados)', () => {
        const html = R.rdrHtmlResumen(null);
        expect(html).toMatch(/Rodeo seleccionado/);
        expect(html).toMatch(/Cargando datos del rodeo/);
        expect(html).not.toMatch(/undefined|null|NaN/);
    });
});

describe('seguridad y textos largos', () => {
    test('escapa HTML de los datos del rodeo (sin inyección)', () => {
        const html = R.rdrHtmlResumen({ id: 'X', club: '<img src=x onerror=alert(1)>', asociacion: 'A&B' });
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
        expect(html).toContain('A&amp;B');
    });
    test('CASO D: los textos largos hacen wrap (overflow-wrap / word-break) y no fuerzan scroll horizontal', () => {
        const largo = 'Interasociaciones Especial Limitado a 25 Colleras con un nombre extremadamente largo que no cabe en una sola línea '.repeat(3);
        const html = R.rdrHtmlResumen({ ...rodeoA, tipo_rodeo_nombre: largo, club: 'C'.repeat(120), asociacion: 'ASOCIACION '.repeat(12) });
        expect(html).toMatch(/overflow-wrap:anywhere/);
        expect(html).toMatch(/word-break:break-word/);
        expect(html).toMatch(/min-width:0/);
        expect(html).toMatch(/max-width:100%/);
        expect(html).not.toMatch(/white-space:\s*nowrap/);
    });
    test('responsive: una columna en pantallas estrechas, dos en escritorio (auto-fit)', () => {
        expect(R.rdrHtmlResumen(rodeoA)).toMatch(/grid-template-columns:repeat\(auto-fit, minmax\(230px, 1fr\)\)/);
    });
});

describe('contexto correcto y sin información residual', () => {
    test('CASOS B y K: el resumen de un rodeo B no contiene ningún dato del rodeo A (y viceversa)', () => {
        const a = R.rdrHtmlResumen(rodeoA), b = R.rdrHtmlResumen(rodeoB);
        for (const dato of ['Sin club', 'LINARES', '03/10/2026', 'Interasociaciones Limitado 25 colleras', 'Primera', '2 días', 'A-1']) expect(b).not.toContain(dato);
        for (const dato of ['LOS ANGELES', 'RIO BIO-BIO', '10/10/2026', 'Provincial', 'Segunda', '1 día', 'B-2']) expect(a).not.toContain(dato);
    });
    test('el resumen lleva el id real del rodeo (data-rodeo-id) para no mezclar rodeos', () => {
        expect(R.rdrHtmlResumen(rodeoA)).toContain('data-rodeo-id="A-1"');
        expect(R.rdrHtmlResumen(rodeoB)).toContain('data-rodeo-id="B-2"');
    });
    test('es una función pura: llamarla dos veces con el mismo rodeo da lo mismo y no muta el objeto', () => {
        const copia = JSON.stringify(rodeoA);
        expect(R.rdrHtmlResumen(rodeoA)).toBe(R.rdrHtmlResumen(rodeoA));
        expect(JSON.stringify(rodeoA)).toBe(copia);
    });
});

describe('rodeos.html: integración (guardas estáticas; la lógica de designación no cambió)', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'rodeos.html'), 'utf8').replace(/\r\n/g, '\n');
    const inicio = html.indexOf('async function abrirDesignarJurado');
    const fin = html.indexOf('let _juradosDesignacion');
    const fn = html.slice(inicio, fin);

    test('carga el helper y lo usa dentro de abrirDesignarJurado', () => {
        expect(html).toMatch(/<script src="\/js\/rodeoDesignarResumen\.js"><\/script>/);
        expect(fn).toMatch(/rdrHtmlResumen\(rodeoCtx\)/);
    });
    test('usa el rodeo ya cargado solo si coincide el id; si no, el endpoint existente GET /admin/rodeos/:id', () => {
        expect(fn).toMatch(/rodeoActual && rodeoActual\.id === rodeoId\) \? rodeoActual : null/);
        expect(fn).toMatch(/api\.get\('\/admin\/rodeos\/' \+ rodeoId\)/);
        expect(fn).toMatch(/r\.id === rodeoId && _designarRodeoId === rodeoId/);   // respuesta tardía de otro rodeo no se pinta
    });
    test('el resumen va bajo el título y antes del buscador y los filtros; contexto fijo (sticky) sobre la lista con su propio scroll', () => {
        const iRes = fn.indexOf('rdrHtmlResumen'), iBuscar = fn.indexOf('id="dj-buscar"'), iLista = fn.indexOf('id="dj-lista"');
        expect(iRes).toBeGreaterThan(0);
        expect(iRes).toBeLessThan(iBuscar);
        expect(iBuscar).toBeLessThan(iLista);
        expect(fn).toMatch(/id="dj-contexto" style="position:sticky; top:0/);
        expect(fn).toMatch(/id="dj-lista" style="max-height:clamp\(160px, calc\(90vh - 350px\), 420px\); overflow-y:auto/);
    });
    test('buscador, filtro de categoría y "ocultar que repiten" conservan sus handlers originales', () => {
        expect(fn).toMatch(/id="dj-buscar"[^>]*oninput="filtrarJuradosDesignacion\(\)"/);
        expect(fn).toMatch(/id="dj-cat"[^>]*onchange="filtrarJuradosDesignacion\(\)"/);
        expect(fn).toMatch(/id="dj-ocultar-repite" onchange="renderJuradosDesignacion\(\)"/);
    });
    test('CASO J: designar sigue usando exactamente el mismo rodeo (_designarRodeoId) que se le muestra al usuario', () => {
        expect(fn).toMatch(/_designarRodeoId = rodeoId;/);
        expect(html).toMatch(/rodeo_id: _designarRodeoId/);
        expect(html.match(/_designarRodeoId = /g).length).toBe(2);   // declaración inicial + asignación al abrir (sin otros cambios)
    });
});
