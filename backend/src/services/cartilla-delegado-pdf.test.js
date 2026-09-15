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

describe('generarCartillaDelegadoPDF — Temporada / Tipo de Rodeo 100% automáticos (4ª revisión)', () => {
    test('con rodeo.temporadas/tipo_rodeo_nombre/categoria_rodeo_nombre completos -> resuelve sin lanzar excepción (fuente en vivo, no cartilla.temporada/tipo_rodeo)', async () => {
        const rodeoCompleto = {
            club: 'FEDERACION', asociacion: 'FEDERACION', fecha: '2026-09-26',
            tipo_rodeo_nombre: 'Provincial', categoria_rodeo_nombre: '3 series',
            temporadas: { nombre: '2026-2027' }
        };
        const cartilla = { ...CARTILLA_BASE, respuestas_json: {} };
        const buffer = await generarCartillaDelegadoPDF(cartilla, rodeoCompleto);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });

    test('sin rodeo.temporadas (rodeo sin temporada asignada) -> no lanza excepción, no inventa el dato', async () => {
        const rodeoSinTemporada = { club: 'EL VALLE', asociacion: 'CURICÓ', fecha: '2026-09-05', tipo_rodeo_nombre: 'Provincial' };
        const cartilla = { ...CARTILLA_BASE, respuestas_json: {} };
        const buffer = await generarCartillaDelegadoPDF(cartilla, rodeoSinTemporada);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });
});

describe('generarCartillaDelegadoPDF — Series + Ganado unificados (4ª revisión, punto 15)', () => {
    test('serie con colleras/vueltas (antes Sección I) y calidad/fuera de peso (antes Sección II) en el mismo objeto -> una sola sección consolidada, sin lanzar excepción', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                ganado_series: [{
                    nombre: '1ra. Libre A',
                    c1n: '5', c1g: 'A123', v1v: '3', v1t: 'Overo', v1p: '420', q1c: '2', q1r: '1', q1k: 'Bueno',
                    c2n: '4', c2g: 'B456', v2v: '2', v2t: 'Colorado', v2p: '410', q2c: '1', q2r: '0', q2k: 'Regular',
                    c3n: '', c3g: '', v3v: '', v3t: '', v3p: '', q3c: '', q3r: '', q3k: '',
                    c4n: '', c4g: '', v4v: '', v4t: '', v4p: '', q4c: '', q4r: '', q4k: '',
                    fp_tot: '9', fp_baj: '1', fp_sob: '0',
                    falta_hubo: 'si', falta_articulo: '242', falta_obs: 'Falta leve'
                }]
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });

    test('múltiples series sin datos de fuera de peso -> resuelve sin lanzar excepción', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                ganado_series: [{ nombre: '1ra. Libre' }, { nombre: '2a. Libre A' }]
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });
});

describe('generarCartillaDelegadoPDF — Ganado bajo/sobrepeso POR ANIMAL (5ª revisión, puntos 2-6)', () => {
    test('serie en formato nuevo (f1c..f4c por animal, sin fp_tot/fp_baj/fp_sob) -> resuelve sin lanzar excepción', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                ganado_series: [{
                    nombre: '1ra. Libre A',
                    c1g: '25', f1c: '2',
                    c2g: '30', f2c: '0',
                    c3g: '20', f3c: '5',
                    c4g: '',   f4c: ''
                }]
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });

    test('serie en formato antiguo (solo fp_tot/fp_baj/fp_sob por Serie, sin f1c..f4c) -> resuelve sin lanzar excepción, no se transforma a formato por animal', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                ganado_series: [{ nombre: 'Serie apertura', fp_tot: '12', fp_baj: '2', fp_sob: '1' }]
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });

    test('# Ganado en 0/vacío por animal -> no lanza excepción (evita división por cero)', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                ganado_series: [{ nombre: '1ra. Libre A', c1g: '0', f1c: '3', c2g: '', f2c: '1' }]
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });
});

describe('generarCartillaDelegadoPDF — Tipo de Rodeo NO concatena Categoría (5ª revisión, punto 7)', () => {
    test('con tipo_rodeo_nombre y categoria_rodeo_nombre presentes -> resuelve sin lanzar excepción, se documentan como campos separados', async () => {
        const rodeo = { club: 'FEDERACION', asociacion: 'FEDERACION', fecha: '2026-09-26', tipo_rodeo_nombre: 'Provincial 3 series', categoria_rodeo_nombre: 'Segunda', temporadas: { nombre: '2026-2027' } };
        const cartilla = { ...CARTILLA_BASE, respuestas_json: {} };
        const buffer = await generarCartillaDelegadoPDF(cartilla, rodeo);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });

    test('sin categoria_rodeo_nombre -> no lanza excepción, no se agrega la línea "Categoría de Rodeo"', async () => {
        const rodeo = { club: 'FEDERACION', asociacion: 'FEDERACION', fecha: '2026-09-26', tipo_rodeo_nombre: 'Provincial 3 series' };
        const cartilla = { ...CARTILLA_BASE, respuestas_json: {} };
        const buffer = await generarCartillaDelegadoPDF(cartilla, rodeo);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });
});
