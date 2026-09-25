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

describe('historial "Últimos" del candidato: fecha DD-MM-AAAA (solo presentación)', () => {
    test('A, B, C: 2026-09-12 → 12-09-2026; 2026-10-03 → 03-10-2026; 2027-01-05 → 05-01-2027 (con ceros a la izquierda)', () => {
        expect(R.rdrFechaDDMMAAAA('2026-09-12')).toBe('12-09-2026');
        expect(R.rdrFechaDDMMAAAA('2026-10-03')).toBe('03-10-2026');
        expect(R.rdrFechaDDMMAAAA('2027-01-05')).toBe('05-01-2027');
        expect(R.rdrFechaDDMMAAAA('2026-09-01')).toBe('01-09-2026');
    });
    test('D: la línea completa queda "HUINTIL | CHOAPA | 12-09-2026 | Nota: 4"', () => {
        expect(R.rdrLineaHistorial({ club: 'HUINTIL', asociacion: 'CHOAPA', fecha: '2026-09-12', nota: 4 })).toBe('· HUINTIL | CHOAPA | 12-09-2026 | Nota: 4');
    });
    test('E: con varios registros, todas las fechas salen DD-MM-AAAA (ninguna AAAA-MM-DD)', () => {
        const hist = [{ club: 'A', asociacion: 'X', fecha: '2026-09-12', nota: 4 }, { club: 'B', asociacion: 'Y', fecha: '2026-08-29', nota: null }, { club: 'C', asociacion: 'Z', fecha: '2027-01-05' }];
        const lineas = hist.map(h => R.rdrLineaHistorial(h));
        expect(lineas).toEqual(['· A | X | 12-09-2026 | Nota: 4', '· B | Y | 29-08-2026 | Sin nota', '· C | Z | 05-01-2027 | Sin nota']);
        expect(lineas.join(' ')).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    });
    test('sin desfase de zona horaria: transformación de texto (nunca pasa por Date/UTC), estable en cualquier TZ', () => {
        const fuente = fs.readFileSync(path.join(__dirname, 'rodeoDesignarResumen.js'), 'utf8');
        const cuerpo = fuente.slice(fuente.indexOf('function rdrFechaDDMMAAAA'), fuente.indexOf('function rdrLineaHistorial'));
        expect(cuerpo).not.toMatch(/new Date|Date\.|toLocale|getTimezoneOffset/);
        const tz = process.env.TZ;
        for (const z of ['America/Santiago', 'UTC', 'Pacific/Auckland', 'America/Los_Angeles']) { process.env.TZ = z; expect(R.rdrFechaDDMMAAAA('2026-09-12')).toBe('12-09-2026'); }
        process.env.TZ = tz;
    });
    test('fecha con hora ISO también se convierte; vacía o inválida → "—" (nunca undefined/null/Invalid Date/NaN)', () => {
        expect(R.rdrFechaDDMMAAAA('2026-09-12T00:00:00.000Z')).toBe('12-09-2026');
        for (const v of [null, undefined, '', 'basura', '12/09/2026', '2026-9-1', NaN]) expect(R.rdrFechaDDMMAAAA(v)).toBe('—');
        expect(R.rdrLineaHistorial({ club: null, asociacion: undefined, fecha: null, nota: undefined })).not.toMatch(/undefined|null|Invalid Date|NaN/);
        expect(R.rdrLineaHistorial(null)).toBe('· — | — | — | Sin nota');
    });
    test('escapa HTML del club y la asociación (sin inyección)', () => {
        expect(R.rdrLineaHistorial({ club: '<b>x</b>', asociacion: 'A&B', fecha: '2026-09-12' })).toBe('· &lt;b&gt;x&lt;/b&gt; | A&amp;B | 12-09-2026 | Sin nota');
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
    test('el listado usa el helper de fecha del historial (sin AAAA-MM-DD crudo) y el resto del render del candidato no cambió', () => {
        const ren = html.slice(html.indexOf('function renderJuradosDesignacion'), html.indexOf('function confirmarDesignacionConAdvertencia') > 0 ? html.indexOf('// Modal de advertencia con checkbox') : undefined);
        expect(ren).toMatch(/rdrLineaHistorial\(h\)/);
        expect(ren).not.toMatch(/\$\{h\.fecha\}/);
        expect(ren).toMatch(/_juradosDesignacion\.filter\(j => !j\.repite_asociacion\)/);   // "ocultar que repiten" igual
        expect(ren).toMatch(/onclick="designarJurado\('\$\{j\.id\}','\$\{sanitizar\(j\.nombre_completo\)\}',false\)"/);   // Designar: mismo candidato
        expect(html).toMatch(/if \(q\.trim\(\)\.length >= 2\) qs\.set\('q', q\.trim\(\)\)/);   // búsqueda igual
        expect(html).toMatch(/if \(cat\) qs\.set\('categoria', cat\)/);   // filtro de categoría igual
    });
    test('mensaje de confirmación al asignar (historial en la asociación): usa rdrFechaDDMMAAAA y no imprime h.fecha crudo', () => {
        const ini = html.indexOf('valResult.historial.slice(0, 3)');
        const trozo = html.slice(ini, ini + 200);
        expect(trozo).toMatch(/\.map\(h => `• \$\{h\.club\} \(\$\{rdrFechaDDMMAAAA\(h\.fecha\)\}\)`\)/);
        expect(trozo).not.toMatch(/\(\$\{h\.fecha\}\)/);
        // mismo formato que produce el helper: 2026-09-12 → 12-09-2026
        expect(`• HUINTIL (${R.rdrFechaDDMMAAAA('2026-09-12')})`).toBe('• HUINTIL (12-09-2026)');
        // la lógica de la validación no cambió (misma llamada y mismo flujo de confirmación)
        expect(html).toMatch(/api\.post\('\/admin\/asignaciones\/validar-historial'/);
        expect(html).toMatch(/if \(!continuar\) return;/);
    });
    test('el popover de la tabla de rodeos NO se tocó: sigue usando formatFecha (DD/MM/AAAA)', () => {
        const ini = html.indexOf('function renderContenidoPopoverJurado');
        const fin = html.indexOf('\nfunction ', ini + 10);   // hasta la siguiente función
        expect(html.slice(ini, fin)).toMatch(/\$\{formatFecha\(h\.fecha\)\}/);
    });
    test('CASO J: designar sigue usando exactamente el mismo rodeo (_designarRodeoId) que se le muestra al usuario', () => {
        expect(fn).toMatch(/_designarRodeoId = rodeoId;/);
        expect(html).toMatch(/rodeo_id: _designarRodeoId/);
        expect(html.match(/_designarRodeoId = /g).length).toBe(2);   // declaración inicial + asignación al abrir (sin otros cambios)
    });
});
