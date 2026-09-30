// Matriz de Participación — zona fija (Persona → Prom. Delegado) con scroll horizontal propio para los
// rodeos. Guardas ESTÁTICAS sobre el HTML/JS real (no hay entorno de navegador en esta suite; el mismo
// patrón ya usado para evaluacion-detalle.html en casosWhatsapp.test.js). No valida píxeles ni layout
// renderizado: valida que la estructura/CSS que sostiene el comportamiento sticky sigue presente,
// internamente consistente y sin depender de una cantidad fija de rodeos.
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'matriz-participacion.html'), 'utf8').replace(/\r\n/g, '\n');
const styleCss = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8').replace(/\r\n/g, '\n');

// Las 7 columnas de la zona fija, en orden, con su clase de ancho/offset.
const COLUMNAS_FIJAS = ['persona', 'tipo', 'cat', 'salidas', 'casos', 'comision', 'delegado'];

describe('contenedor con scroll horizontal propio (no depende del scroll de la página)', () => {
    test('.mat-tabla-wrap tiene overflow-x:auto', () => {
        const bloque = html.slice(html.indexOf('.mat-tabla-wrap {'), html.indexOf('.mat-tabla-wrap {') + 300);
        expect(bloque).toMatch(/overflow-x:\s*auto/);
    });
    test('.main-content (style.css) tiene min-width:0 — evita que la tabla ancha empuje toda la página a desplazarse', () => {
        const bloque = styleCss.slice(styleCss.indexOf('.main-content {'), styleCss.indexOf('.main-content {') + 400);
        expect(bloque).toMatch(/min-width:\s*0/);
    });
});

describe('zona fija: 7 columnas sticky con anchos fijos y "left" acumulado consistente', () => {
    test('cada columna define left = width + min-width + max-width iguales (ancho realmente fijo, no auto)', () => {
        for (const col of COLUMNAS_FIJAS) {
            const m = new RegExp(`\\.mat-col-${col}\\s*\\{([^}]*)\\}`).exec(html);
            expect(m).not.toBeNull();
            const props = m[1];
            const left = /left:\s*(-?\d+)px/.exec(props);
            const width = /(?<!min-|max-)width:\s*(\d+)px/.exec(props);
            const minWidth = /min-width:\s*(\d+)px/.exec(props);
            const maxWidth = /max-width:\s*(\d+)px/.exec(props);
            expect(left).not.toBeNull();
            expect(width).not.toBeNull();
            expect(minWidth[1]).toBe(width[1]);
            expect(maxWidth[1]).toBe(width[1]);
        }
    });
    test('el "left" de cada columna es exactamente la suma de los anchos de las columnas anteriores (sin huecos ni superposición)', () => {
        let acumulado = 0;
        for (const col of COLUMNAS_FIJAS) {
            const props = new RegExp(`\\.mat-col-${col}\\s*\\{([^}]*)\\}`).exec(html)[1];
            const left = Number(/left:\s*(-?\d+)px/.exec(props)[1]);
            const width = Number(/(?<!min-|max-)width:\s*(\d+)px/.exec(props)[1]);
            expect(left).toBe(acumulado);
            acumulado += width;
        }
        expect(acumulado).toBeGreaterThan(0);   // fin de la zona fija, documentado en el comentario del CSS
    });
    test('.mat-th-fija / .mat-td-fija son position:sticky con fondo sólido (evita transparencias al hacer scroll)', () => {
        // Regla compartida: ".mat-th-fija, .mat-td-fija { position: sticky; ... }"
        const compartida = /\.mat-th-fija,\s*\.mat-td-fija\s*\{([^}]*)\}/.exec(html);
        expect(compartida).not.toBeNull();
        expect(compartida[1]).toMatch(/position:\s*sticky/);
        // Fondo sólido propio de cada una (regla separada, no compartida)
        const bgTh = /\.mat-th-fija\s*\{\s*background:\s*([^;]+);/.exec(html);
        const bgTd = /\.mat-td-fija\s*\{\s*background:\s*([^;]+);/.exec(html);
        expect(bgTh).not.toBeNull(); expect(bgTd).not.toBeNull();
        expect(bgTh[1].trim()).not.toBe('transparent');
        expect(bgTd[1].trim()).not.toBe('transparent');
    });
    test('el encabezado fijo (.mat-th-fija) tiene z-index mayor que la celda fija del cuerpo (.mat-td-fija)', () => {
        const zTh = Number(/\.mat-th-fija\s*\{[^}]*z-index:\s*(\d+)/.exec(html)[1]);
        const zTd = Number(/\.mat-td-fija\s*\{[^}]*z-index:\s*(\d+)/.exec(html)[1]);
        expect(zTh).toBeGreaterThan(zTd);
    });
    test('separación visual (borde) exactamente después de Prom. Delegado, no después de Persona', () => {
        expect(html).toMatch(/\.mat-th-fija\.mat-col-delegado\s*\{[^}]*border-right/);
        expect(html).toMatch(/\.mat-td-fija\.mat-col-delegado\s*\{[^}]*border-right/);
        // Persona ya no lleva su propio border-right/box-shadow de separación (se movió al final de la zona fija)
        const reglaPersonaTh = /\.mat-th-persona\s*\{([^}]*)\}/.exec(html)[1];
        const reglaPersonaTd = /\.mat-td-persona\s*\{([^}]*)\}/.exec(html)[1];
        expect(reglaPersonaTh).not.toMatch(/border-right/);
        expect(reglaPersonaTd).not.toMatch(/border-right|box-shadow/);
    });
    test('el hover de fila cubre TODAS las columnas fijas (una sola regla sobre .mat-td-fija, no solo Persona)', () => {
        expect(html).toMatch(/\.mat-tabla tbody tr:hover \.mat-td-fija\s*\{/);
    });
});

describe('el encabezado (thR1) y cada fila (filas) aplican las clases sticky a las 7 columnas, en orden', () => {
    const bloqueThR1 = html.slice(html.indexOf('let thR1'), html.indexOf('let thR2'));
    const bloqueFilas = html.slice(html.indexOf('const filas = personas.map'), html.indexOf('const nCon ='));

    test.each(COLUMNAS_FIJAS)('columna "%s": el <th> del encabezado tiene mat-th-fija + mat-col-%s', (col) => {
        const re = new RegExp(`class="[^"]*mat-th-fija[^"]*mat-col-${col}[^"]*"`);
        expect(bloqueThR1).toMatch(re);
    });
    test.each(COLUMNAS_FIJAS)('columna "%s": el <td> de cada fila tiene mat-td-fija + mat-col-%s', (col) => {
        const re = new RegExp(`class="[^"]*mat-td-fija[^"]*mat-col-${col}[^"]*"`);
        expect(bloqueFilas).toMatch(re);
    });
    test('el <th class="mat-th-persona"> también lleva mat-th-fija y mat-col-persona (no una regla aparte)', () => {
        expect(bloqueThR1).toMatch(/class="mat-th-fija mat-th-persona mat-col-persona"/);
    });
    test('el <td class="mat-td-persona"> también lleva mat-td-fija y mat-col-persona', () => {
        expect(bloqueFilas).toMatch(/class="mat-td-fija mat-td-persona mat-col-persona"/);
    });
});

describe('las columnas de "Rodeo N" (Detalle/Notas) NO son sticky — solo se desplazan con el scroll', () => {
    test('el <th colspan="2">Rodeo ${i}</th> no lleva ninguna clase mat-th-fija/mat-col-*', () => {
        const m = /thR1 \+= `<th colspan="2"[^`]*Rodeo \$\{i\}<\/th>`/.exec(html);
        expect(m).not.toBeNull();
        expect(m[0]).not.toMatch(/mat-th-fija|mat-col-/);
    });
    test('las celdas "Detalle" y "Notas" del cuerpo no llevan clases sticky ni position:sticky', () => {
        const bloqueCeldas = html.slice(html.indexOf('for (let i = 0; i < maxRodeos; i++) {'), html.indexOf('return `<tr>'));
        expect(bloqueCeldas).not.toMatch(/mat-th-fija|mat-td-fija|mat-col-|position:\s*sticky/);
    });
});

describe('sigue siendo dinámico: sin cantidad fija de rodeos', () => {
    test('maxRodeos se calcula desde los datos (Math.max sobre personas[].rodeos.length), no un literal', () => {
        expect(html).toMatch(/const maxRodeos = Math\.max\(\.\.\.personas\.map\(p => p\.rodeos\.length\), 0\);/);
    });
    test('los encabezados y celdas de rodeo se generan con un for hasta maxRodeos, no con un número fijo de columnas', () => {
        expect(html).toMatch(/for \(let i = 1; i <= maxRodeos; i\+\+\)/);
        expect(html).toMatch(/for \(let i = 0; i < maxRodeos; i\+\+\)/);
        expect(html).not.toMatch(/Rodeo (5|10|20|30)\b/);   // ningún tope hardcodeado tipo "Rodeo 20" literal
    });
});

describe('sin cambios en cálculos, colores ni comparaciones (regresión)', () => {
    test('los umbrales de color de nota (6 / 4.5) y la fuente del dato no cambiaron', () => {
        expect(html).toMatch(/function colorNota\(n\) \{\s*if \(n === null \|\| n === undefined\) return '#aaa';\s*return n >= 6 \? '#27ae60' : n >= 4\.5 \? '#e67e22' : '#c0392b';\s*\}/);
    });
    test('celdaPromedio sigue mostrando Cat./General con diferencia y flecha (misma lógica, sin tocar cálculo)', () => {
        expect(html).toMatch(/function celdaPromedio\(prom, categoriaLabel\)/);
        expect(html).toMatch(/prom\.promedio_categoria/);
        expect(html).toMatch(/prom\.diferencia_categoria/);
        expect(html).toMatch(/prom\.promedio_general/);
        expect(html).toMatch(/prom\.diferencia_general/);
    });
    test('el endpoint de datos de la matriz no cambió', () => {
        expect(html).toMatch(/api\.get\(`\/admin\/dashboard\/salidas-matriz\?\$\{_matrizParams\}`\)/);
    });
    test('los filtros y controles superiores siguen presentes con sus mismos id (año, mes, desde, hasta, tipo, cat, order, search, sin-salidas, limpiar)', () => {
        for (const id of ['mat-año', 'mat-mes', 'mat-desde', 'mat-hasta', 'mat-tipo', 'mat-cat', 'mat-order', 'mat-search', 'mat-sin-salidas']) {
            expect(html).toContain(`id="${id}"`);
        }
        expect(html).toMatch(/onclick="cargarMatriz\(\)">Cargar matriz</);
        expect(html).toMatch(/onclick="limpiarTodo\(\)">Limpiar</);
    });
});
