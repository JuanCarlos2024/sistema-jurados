// 092 — "Reabrir" Cartilla de Delegado, panel admin (frontend/admin/rodeos.html).
// Mismo patrón que rodeosCartillaDigitalBadge.test.js: se extrae el código
// REAL de renderAccionesCartillaDelegado() y se ejecuta con un `document`
// simulado mínimo (nunca se reimplementa la lógica).
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'rodeos.html'), 'utf8').replace(/\r\n/g, '\n');

function extraerFuncion(nombre) {
    const inicio = html.indexOf(`function ${nombre}(`);
    if (inicio === -1) throw new Error(`No se encontró function ${nombre}(...) en rodeos.html`);
    // Encuentra el cierre de la función contando llaves balanceadas.
    let i = html.indexOf('{', inicio);
    let profundidad = 0;
    for (; i < html.length; i++) {
        if (html[i] === '{') profundidad++;
        else if (html[i] === '}') { profundidad--; if (profundidad === 0) { i++; break; } }
    }
    return html.slice(inicio, i);
}

function construirCont(htmlInicial = '') {
    return { innerHTML: htmlInicial };
}

function ejecutarRenderAcciones(cartilla) {
    const FN = extraerFuncion('renderAccionesCartillaDelegado');
    const cont = construirCont();
    const documentFalso = { getElementById: (id) => (id === 'cd-admin-acciones' ? cont : null) };
    const sanitizar = (s) => s;
    const fn = new Function('document', 'sanitizar', `${FN}\nreturn renderAccionesCartillaDelegado(arguments[2]);`);
    fn(documentFalso, sanitizar, cartilla);
    return cont.innerHTML;
}

describe('renderAccionesCartillaDelegado() — botón "🔓 Reabrir" (092)', () => {
    test.each(['enviada', 'reenviada', 'aprobada', 'cerrada'])('estado "%s": muestra el botón Reabrir', (estado) => {
        const out = ejecutarRenderAcciones({ id: 'cart-1', estado });
        expect(out).toContain('🔓 Reabrir');
        expect(out).toContain("abrirModalReabrirCd('cart-1')");
    });

    test.each(['borrador', 'reabierta'])('estado "%s": NUNCA muestra el botón Reabrir', (estado) => {
        const out = ejecutarRenderAcciones({ id: 'cart-1', estado });
        expect(out).not.toContain('🔓 Reabrir');
    });

    test('estado "reabierta": el panel de acciones ya no queda vacío (antes de 092 no estaba en la lista de estados con acciones)', () => {
        const out = ejecutarRenderAcciones({ id: 'cart-1', estado: 'reabierta' });
        // Aunque no tenga botón propio, el contenedor debe renderizar algo
        // (al menos "Exportar PDF"/"Preparar correo"), nunca quedar vacío.
        expect(out).toContain('Exportar PDF');
    });

    test('estado "borrador": el panel sigue vacío (sin cambios de comportamiento)', () => {
        const out = ejecutarRenderAcciones({ id: 'cart-1', estado: 'borrador' });
        expect(out).toBe('');
    });

    test('estado "enviada": NUNCA muestra "Observar" (eso sigue siendo correcto, no se tocó)', () => {
        const out = ejecutarRenderAcciones({ id: 'cart-1', estado: 'enviada' });
        expect(out).toContain('👁 Observar');
    });
});

describe('abrirModalReabrirCd / confirmarReabrirCd — existen y apuntan al endpoint correcto', () => {
    test('abrirModalReabrirCd está definida', () => {
        expect(html).toMatch(/function abrirModalReabrirCd\(cartillaId\)/);
    });

    test('confirmarReabrirCd llama a POST /admin/cartillas-delegado/:id/reabrir con el motivo', () => {
        const FN = extraerFuncion('confirmarReabrirCd');
        expect(FN).toMatch(/api\.post\('\/admin\/cartillas-delegado\/' \+ m\._cartillaId \+ '\/reabrir', \{ motivo \}\)/);
    });

    test('confirmarReabrirCd exige motivo no vacío ANTES de llamar a la API', () => {
        const FN = extraerFuncion('confirmarReabrirCd');
        const idxIf = FN.indexOf('if (!motivo)');
        const idxApi = FN.indexOf('api.post');
        expect(idxIf).toBeGreaterThan(-1);
        expect(idxApi).toBeGreaterThan(idxIf);
    });
});

describe('Historial de versiones (092) — cargarVersionesCartillaDelegado / verPdfVersionCartillaDelegado', () => {
    test('cargarVersionesCartillaDelegado consulta GET /admin/cartillas-delegado/:id/versiones', () => {
        const FN = extraerFuncion('cargarVersionesCartillaDelegado');
        expect(FN).toMatch(/api\.get\('\/admin\/cartillas-delegado\/' \+ cartillaId \+ '\/versiones'\)/);
    });

    test('verPdfVersionCartillaDelegado consulta GET /admin/cartillas-delegado/version/:id/pdf', () => {
        const FN = extraerFuncion('verPdfVersionCartillaDelegado');
        expect(FN).toMatch(/api\.get\('\/admin\/cartillas-delegado\/version\/' \+ versionId \+ '\/pdf'\)/);
    });

    test('verCartillaDelegadoDigital() dispara la carga del historial al abrir el modal', () => {
        const FN = extraerFuncion('verCartillaDelegadoDigital');
        expect(FN).toMatch(/cargarVersionesCartillaDelegado\(c\.id\)/);
    });
});

describe('Punto B (revisión final) — recuperación de PDF: botón "Regenerar PDF" cuando storage_path_pdf es null', () => {
    test('cargarVersionesCartillaDelegado(): cuando NO hay storage_path_pdf, muestra el botón Regenerar en vez de "Sin PDF"', () => {
        const FN = extraerFuncion('cargarVersionesCartillaDelegado');
        expect(FN).toContain('⚠ Regenerar PDF');
        expect(FN).toMatch(/regenerarPdfVersionCartillaDelegado\(\\'' \+ v\.id \+ '\\'\)/);
    });

    test('regenerarPdfVersionCartillaDelegado() llama a POST /admin/cartillas-delegado/version/:id/regenerar-pdf', () => {
        const FN = extraerFuncion('regenerarPdfVersionCartillaDelegado');
        expect(FN).toMatch(/api\.post\('\/admin\/cartillas-delegado\/version\/' \+ versionId \+ '\/regenerar-pdf', \{\}\)/);
    });

    test('regenerarPdfVersionCartillaDelegado() refresca el historial de versiones tras regenerar (nunca deja la vista desactualizada)', () => {
        const FN = extraerFuncion('regenerarPdfVersionCartillaDelegado');
        expect(FN).toMatch(/cargarVersionesCartillaDelegado\(_cdActivaData\.id\)/);
    });
});

describe('Mapas de estado — "reenviada" (gap preexistente) y "reabierta" (092) con color/etiqueta propios', () => {
    test('verCartillaDelegadoDigital(): estadoColor y estadoLabel incluyen reenviada y reabierta', () => {
        const FN = extraerFuncion('verCartillaDelegadoDigital');
        expect(FN).toMatch(/reenviada:\s*'#1e8449'/);
        expect(FN).toMatch(/reabierta:\s*'#e67e22'/);
        expect(FN).toMatch(/reenviada:\s*'Reenviada'/);
        expect(FN).toMatch(/reabierta:\s*'Reabierta'/);
    });
});
