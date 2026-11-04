// 092 — "Reabrir" Cartilla de Delegado: protección estática (regex sobre el
// código fuente, mismo patrón que cartillaDelegadoInstitucional.test.js —
// este proyecto no tiene entorno DOM para frontend) de los cambios en
// frontend/usuario/cartilla-delegado.html (compartida por ambas modalidades).
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'usuario', 'cartilla-delegado.html'), 'utf8').replace(/\r\n/g, '\n');

describe('esSoloLectura() — "reabierta" nunca es bloqueada, "cerrada" sí', () => {
    test('el CHECK de estados bloqueados incluye "cerrada" y NUNCA incluye "reabierta"', () => {
        const bloque = html.slice(html.indexOf('function esSoloLectura'), html.indexOf('function esSoloLectura') + 250);
        expect(bloque).toMatch(/\['enviada', 'reenviada', 'aprobada', 'cerrada'\]\.includes\(_estado\)/);
        expect(bloque).not.toMatch(/'reabierta'/);
    });
});

describe('Banner "Cartilla reabierta para corrección"', () => {
    function extraerBloqueBanners() {
        const inicio = html.indexOf("if (_estado === 'enviada' || _estado === 'reenviada')");
        const fin = html.indexOf('// ── Estado badges', inicio);
        return html.slice(inicio, fin);
    }
    const BLOQUE = extraerBloqueBanners();

    test('existe una rama explícita para _estado === "reabierta"', () => {
        expect(BLOQUE).toMatch(/else if \(_estado === 'reabierta'\)/);
    });

    test('muestra el motivo de la reapertura (cartilla.motivo_reapertura) y la fecha (cartilla.reabierta_en)', () => {
        expect(BLOQUE).toMatch(/cartilla\.motivo_reapertura/);
        expect(BLOQUE).toMatch(/cartilla\.reabierta_en/);
    });

    test('nunca reutiliza el texto del banner de "observada" (son flujos distintos, aunque visualmente similares)', () => {
        const banners = BLOQUE.split(/else if/);
        const bannerReabierta = banners.find(b => b.includes("_estado === 'reabierta'"));
        expect(bannerReabierta).toContain('Cartilla reabierta para corrección');
        expect(bannerReabierta).not.toContain('bajo revisión');
    });
});

describe('Botón "Reenviar informe" y confirmación — "reabierta" se trata igual que "observada"', () => {
    test('btnEnviarLabel incluye "reabierta" junto a "observada"', () => {
        expect(html).toMatch(/\['observada', 'reabierta'\]\.includes\(_estado\) \? 'Reenviar informe' : 'Enviar informe'/);
    });

    test('esReenvio (en enviarCartilla) incluye "reabierta" junto a "observada"', () => {
        expect(html).toMatch(/const esReenvio = \['observada', 'reabierta'\]\.includes\(_estado\);/);
    });
});

describe('Badges de estado — "reabierta" tiene su propia etiqueta, visualmente como "observada"', () => {
    test('_estadoBadgeMap mapea reabierta al mismo estilo que observada (estado-observada)', () => {
        expect(html).toMatch(/reabierta:\s*'estado-observada'/);
    });

    test('_estadoLabelMap da una etiqueta propia ("Pendiente corrección"), nunca el mismo texto que "observada" ("Observada")', () => {
        expect(html).toMatch(/reabierta:\s*'Pendiente corrección'/);
    });
});
