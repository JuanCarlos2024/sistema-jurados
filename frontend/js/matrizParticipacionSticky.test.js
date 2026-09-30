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
    const bloqueWrap = html.slice(html.indexOf('.mat-tabla-wrap {'), html.indexOf('.mat-tabla-wrap {') + 400);
    test('.mat-tabla-wrap tiene overflow-x:auto', () => {
        expect(bloqueWrap).toMatch(/overflow-x:\s*auto/);
    });
    test('.mat-tabla-wrap NO tiene un segundo scroll vertical propio (sin max-height ni overflow-y:auto)', () => {
        expect(bloqueWrap).not.toMatch(/max-height/);
        expect(bloqueWrap).not.toMatch(/overflow-y:\s*auto/);
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

describe('barra de scroll horizontal SUPERIOR (accesible sin bajar hasta el final de la tabla)', () => {
    test('existe el elemento auxiliar .mat-scroll-top-fila, antes de .mat-tabla-wrap, con su espaciador y su interior', () => {
        const iScrollFila = html.indexOf('<div class="mat-scroll-top-fila">');
        const iWrap = html.indexOf('<div class="mat-tabla-wrap"');
        expect(iScrollFila).toBeGreaterThan(-1);
        expect(iWrap).toBeGreaterThan(iScrollFila);   // la barra superior va ANTES del contenedor real (visualmente arriba)
        const bloque = html.slice(iScrollFila, iWrap);
        expect(bloque).toMatch(/class="mat-scroll-top-espaciador"/);
        expect(bloque).toMatch(/id="mat-scroll-top"/);
        expect(bloque).toMatch(/id="mat-scroll-top-interior"/);
    });
    test('la barra superior empieza donde termina la zona fija: usa la MISMA variable --mat-zona-fija-ancho (no un número nuevo)', () => {
        expect(html).toMatch(/\.mat-scroll-top-espaciador\s*\{[^}]*flex:[^;]*var\(--mat-zona-fija-ancho/);
    });
    test('--mat-zona-fija-ancho es EXACTAMENTE la suma de los anchos de las 7 columnas fijas (una sola fuente de verdad)', () => {
        let suma = 0;
        for (const col of COLUMNAS_FIJAS) {
            const props = new RegExp(`\\.mat-col-${col}\\s*\\{([^}]*)\\}`).exec(html)[1];
            suma += Number(/(?<!min-|max-)width:\s*(\d+)px/.exec(props)[1]);
        }
        const declarada = Number(/--mat-zona-fija-ancho:\s*(\d+)px/.exec(html)[1]);
        expect(declarada).toBe(suma);
    });
    test('el espaciador puede achicarse en viewports angostos (no se pierde la barra) y la fila nunca desborda la página', () => {
        const bloqueFila = /\.mat-scroll-top-fila\s*\{([^}]*)\}/.exec(html)[1];
        expect(bloqueFila).toMatch(/overflow:\s*hidden/);
        const bloqueEspaciador = /\.mat-scroll-top-espaciador\s*\{([^}]*)\}/.exec(html)[1];
        expect(bloqueEspaciador).toMatch(/flex:\s*0\s+1\s+var/);   // flex-shrink 1, no 0: puede reducirse
        const bloqueTop = /\.mat-scroll-top\s*\{([^}]*)\}/.exec(html)[1];
        expect(bloqueTop).toMatch(/min-width:\s*\d+px/);            // pero la barra en sí nunca llega a 0px
    });
});

describe('sincronización bidireccional del scroll (sin loop de eventos)', () => {
    const bloqueJs = html.slice(html.indexOf('function configurarScrollSincronizado'), html.indexOf('function actualizarOffsetsMatriz'));
    test('mover la barra superior mueve .mat-tabla-wrap, y viceversa', () => {
        expect(bloqueJs).toMatch(/wrap\.addEventListener\('scroll'/);
        expect(bloqueJs).toMatch(/topBar\.addEventListener\('scroll'/);
        expect(bloqueJs).toMatch(/topBar\.scrollLeft = wrap\.scrollLeft/);
        expect(bloqueJs).toMatch(/wrap\.scrollLeft = topBar\.scrollLeft/);
    });
    test('usa una bandera de sincronización para evitar el loop scroll → scroll → scroll…', () => {
        expect(bloqueJs).toMatch(/_matSincronizando/);
        const listeners = bloqueJs.match(/addEventListener\('scroll', \(\) => \{[^}]*\}/g) || [];
        expect(listeners.length).toBe(2);
        for (const l of listeners) {
            expect(l).toMatch(/if \(_matSincronizando\) return;/);
            expect(l).toMatch(/_matSincronizando = true;/);
            expect(l).toMatch(/_matSincronizando = false;/);
        }
    });
    test('se vuelve a configurar/recalcular después de CADA render (el DOM de la matriz se reconstruye entero)', () => {
        const bloqueRender = html.slice(html.indexOf('function renderMatriz'), html.indexOf('// ─── Scroll horizontal'));
        expect(bloqueRender).toMatch(/configurarScrollSincronizado\(\);/);
    });
});

describe('el ancho desplazable se calcula dinámicamente (nunca hardcodeado a una cantidad de rodeos)', () => {
    test('recalcularAnchosScrollMatriz mide tabla.scrollWidth real (DOM), no una fórmula con maxRodeos', () => {
        const fn = /function recalcularAnchosScrollMatriz\(\) \{([\s\S]*?)\n\}/.exec(html)[1];
        expect(fn).toMatch(/tabla\.scrollWidth/);
        expect(fn).not.toMatch(/maxRodeos/);
        expect(fn).not.toMatch(/Rodeo (4|10|20|30)\b/);
    });
    test('el ancho del espaciador interior resta la zona fija de ambos lados (mismo rango de scroll que .mat-tabla-wrap)', () => {
        const fn = /function recalcularAnchosScrollMatriz\(\) \{([\s\S]*?)\n\}/.exec(html)[1];
        expect(fn).toMatch(/tabla\.scrollWidth - zonaFija/);
    });
    test('recalcularAnchosScrollMatriz también corre al cambiar el tamaño de la ventana (responsive)', () => {
        expect(html).toMatch(/window\.addEventListener\('resize', actualizarOffsetsMatriz\)/);
        const fnOffsets = /function actualizarOffsetsMatriz\(\) \{([\s\S]*?)\n\}/.exec(html)[1];
        expect(fnOffsets).toMatch(/recalcularAnchosScrollMatriz\(\);/);
    });
});

describe('encabezado sticky y barra superior conviven sin superponerse con la topbar fija', () => {
    test('la topbar se mide por JS (offsetHeight) y se guarda en --mat-topbar-h; no se asume un valor fijo', () => {
        const fn = /function actualizarOffsetsMatriz\(\) \{([\s\S]*?)\n\}/.exec(html)[1];
        expect(fn).toMatch(/document\.querySelector\('\.topbar'\)/);
        expect(fn).toMatch(/topbar\.offsetHeight/);
        expect(fn).toMatch(/setProperty\('--mat-topbar-h'/);
    });
    test('.mat-scroll-top-fila se fija justo debajo de la topbar (top: var(--mat-topbar-h))', () => {
        const bloque = /\.mat-scroll-top-fila\s*\{([^}]*)\}/.exec(html)[1];
        expect(bloque).toMatch(/position:\s*sticky/);
        expect(bloque).toMatch(/top:\s*var\(--mat-topbar-h/);
    });
    test('el thead se fija debajo de la topbar Y de la barra superior (suma de ambas alturas, no solo la topbar)', () => {
        const bloque = html.slice(html.indexOf('.mat-tabla thead {'), html.indexOf('.mat-tabla thead {') + 300);
        expect(bloque).toMatch(/top:\s*calc\(var\(--mat-topbar-h[^)]*\)\s*\+\s*var\(--mat-scroll-top-h/);
    });
});
