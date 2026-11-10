const {
    construirNombreArchivoCartillaDelegadoPdf,
    normalizarSegmentoNombreArchivo,
    normalizarFechaNombreArchivo
} = require('./cartillaDelegadoPdfNombreArchivo');

describe('construirNombreArchivoCartillaDelegadoPdf', () => {
    test('caso real EL BOSQUE PONIENTE / SANTIAGO PONIENTE / 2026-11-01 -> formato exacto pedido', () => {
        const nombre = construirNombreArchivoCartillaDelegadoPdf({
            asociacion: 'SANTIAGO PONIENTE', club: 'EL BOSQUE PONIENTE', fecha: '2026-11-01'
        });
        expect(nombre).toBe('SANTIAGO-PONIENTE_EL-BOSQUE-PONIENTE_2026-11-01.pdf');
    });

    test('versión histórica -> agrega sufijo _V{numero_version}', () => {
        const nombre = construirNombreArchivoCartillaDelegadoPdf({
            asociacion: 'SANTIAGO PONIENTE', club: 'EL BOSQUE PONIENTE', fecha: '2026-11-01', version: 2
        });
        expect(nombre).toBe('SANTIAGO-PONIENTE_EL-BOSQUE-PONIENTE_2026-11-01_V2.pdf');
    });

    test('version=0 nunca se confunde con "sin versión" (no debería ocurrir en la práctica, pero 0 es un valor, no ausencia)', () => {
        const nombre = construirNombreArchivoCartillaDelegadoPdf({ asociacion: 'A', club: 'B', fecha: '2026-01-01', version: 0 });
        expect(nombre).toBe('A_B_2026-01-01_V0.pdf');
    });

    test('fecha con timestamp completo (ISO) -> se queda solo con la parte de fecha', () => {
        const nombre = construirNombreArchivoCartillaDelegadoPdf({ asociacion: 'A', club: 'B', fecha: '2026-11-01T14:30:00.000Z' });
        expect(nombre).toBe('A_B_2026-11-01.pdf');
    });

    test('asociación/club con tildes y ñ -> se normalizan sin perder legibilidad (nunca se transliteran mal)', () => {
        const nombre = construirNombreArchivoCartillaDelegadoPdf({ asociacion: "Ñuble", club: 'Peñaflor Añañuca', fecha: '2026-01-01' });
        expect(nombre).toBe('NUBLE_PENAFLOR-ANANUCA_2026-01-01.pdf');
    });

    test("asociación/club con apóstrofe (ej. O'Higgins) -> se normaliza a guion, nunca rompe el nombre de archivo", () => {
        const nombre = construirNombreArchivoCartillaDelegadoPdf({ asociacion: "O'Higgins", club: 'Club Nº 5 (Rural)', fecha: '2026-01-01' });
        expect(nombre).toBe('O-HIGGINS_CLUB-N-5-RURAL_2026-01-01.pdf');
    });

    test('nombres completos nunca se truncan (pedido explícito: "conservar nombres completos")', () => {
        const clubLargo = 'ASOCIACION DE RODEO DE UNA PROVINCIA CON UN NOMBRE MUY LARGO Y COMPUESTO';
        const nombre = construirNombreArchivoCartillaDelegadoPdf({ asociacion: 'A', club: clubLargo, fecha: '2026-01-01' });
        expect(nombre).toContain(normalizarSegmentoNombreArchivo(clubLargo));
    });

    test('sin asociación/club/fecha (cartilla histórica incompleta) -> usa placeholders estables, nunca lanza excepción', () => {
        const nombre = construirNombreArchivoCartillaDelegadoPdf({});
        expect(nombre).toBe('ASOCIACION_CLUB_SIN-FECHA.pdf');
    });

    test('fecha con formato inválido -> SIN-FECHA, nunca un nombre de archivo corrupto', () => {
        const nombre = construirNombreArchivoCartillaDelegadoPdf({ asociacion: 'A', club: 'B', fecha: 'no-es-una-fecha' });
        expect(nombre).toBe('A_B_SIN-FECHA.pdf');
    });
});

describe('normalizarSegmentoNombreArchivo', () => {
    test('null/undefined/"" -> string vacío (el llamador decide el placeholder)', () => {
        expect(normalizarSegmentoNombreArchivo(null)).toBe('');
        expect(normalizarSegmentoNombreArchivo(undefined)).toBe('');
        expect(normalizarSegmentoNombreArchivo('   ')).toBe('');
    });

    test('colapsa espacios/guiones múltiples y recorta guiones en los extremos', () => {
        expect(normalizarSegmentoNombreArchivo('  Santiago   Poniente  ')).toBe('SANTIAGO-PONIENTE');
    });
});

describe('normalizarFechaNombreArchivo', () => {
    test('YYYY-MM-DD se mantiene igual', () => {
        expect(normalizarFechaNombreArchivo('2026-11-01')).toBe('2026-11-01');
    });
    test('vacío/null -> SIN-FECHA', () => {
        expect(normalizarFechaNombreArchivo(null)).toBe('SIN-FECHA');
        expect(normalizarFechaNombreArchivo('')).toBe('SIN-FECHA');
    });
});
