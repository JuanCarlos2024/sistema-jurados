// ═════════════════════════════════════════════════════════════════════════
// Tests de humo (smoke tests) — cartilla-delegado-pdf.js. El proyecto no
// cuenta con una librería de extracción de texto de PDF (pdfkit comprime
// los content streams con deflate por defecto), así que estos tests NO
// verifican el texto visible del documento — verifican que el generador
// nunca lance una excepción al procesar el nuevo campo "Informe general de
// accidentes" (3ª revisión), tanto cuando está presente como cuando falta
// (cartilla antigua), y que el detalle de la Sección VII se procese aparte
// sin necesidad del campo general.
// ═════════════════════════════════════════════════════════════════════════
const { generarCartillaDelegadoPDF } = require('./cartilla-delegado-pdf');

const CARTILLA_BASE = {
    id: 'cart-1', estado: 'enviada',
    temporada: '2026-2027', fecha_rodeo: '2026-09-05',
    delegado_nombre: 'DELEGADO X', delegado_telefono: '+56911111111',
    secretario_jurado: 'PEDRO', secretario_numero_socio: '123',
    club_asociacion_organizador: 'EL VALLE — CURICÓ', tipo_rodeo: 'Provincial',
    publico_serie_campeones: 300
};
const RODEO = { club: 'EL VALLE', asociacion: 'CURICÓ' };

describe('generarCartillaDelegadoPDF — Informe general de accidentes (3ª revisión)', () => {
    test('con informe_accidentes_general presente Y accidentes_informe (Sección VII) presente -> resuelve sin lanzar excepción', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                informe_accidentes_general: 'Un jinete sufrió una caída leve en la segunda serie.',
                accidentes_informe: { hubo_accidentes: 'si', medico_nombre: 'DR. PÉREZ', medico_telefono: '+56922223333', items: [] }
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });

    test('cartilla antigua SIN informe_accidentes_general (solo accidentes_informe de la Sección VII) -> resuelve sin lanzar excepción, no se inventa el texto general', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                accidentes_informe: { hubo_accidentes: 'si', medico_nombre: 'DR. GÓMEZ', items: [] }
                // sin informe_accidentes_general — cartilla previa al nuevo campo
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });

    test('sin ningún dato de accidentes (ni general ni Sección VII) -> resuelve sin lanzar excepción', async () => {
        const cartilla = { ...CARTILLA_BASE, respuestas_json: {} };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });
});
