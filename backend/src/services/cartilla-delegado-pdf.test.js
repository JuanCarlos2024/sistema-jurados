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
const fs = require('fs');
const path = require('path');
const { generarCartillaDelegadoPDF } = require('./cartilla-delegado-pdf');

// MEJORA 3 (revisión de legibilidad, validación con datos reales): "→" no
// existe en WinAnsiEncoding (la codificación de 1 byte de Helvetica/
// Helvetica-Bold, las únicas fuentes usadas en todo este PDF) — pdfkit no
// tiene glifo para ese carácter y lo corrompe en el PDF final (se ve como
// "!" seguido de un carácter inválido, confirmado generando y decodificando
// un PDF real). Nunca puede volver a aparecer un carácter fuera de ese
// rango en un `.text()` de este archivo — los acentos/ñ/° sí están en
// WinAnsiEncoding y se verifican por separado, no se incluyen aquí.
describe('generarCartillaDelegadoPDF — nunca usa caracteres fuera de WinAnsiEncoding (Helvetica, base14)', () => {
    test('el código fuente no contiene "→" (U+2192) — rompe el PDF, no tiene glifo en Helvetica', () => {
        const fuente = fs.readFileSync(path.join(__dirname, 'cartilla-delegado-pdf.js'), 'utf8');
        expect(fuente).not.toMatch(/→/);
    });
});

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

// ═════════════════════════════════════════════════════════════════════════
// VERSIÓN FINAL APROBADA 2026-2027 — secciones nuevas/unificadas
// ═════════════════════════════════════════════════════════════════════════
describe('generarCartillaDelegadoPDF — Secretario (nombre, rut, N° socio, teléfono, correo)', () => {
    test('respuestas_json.secretario completo -> resuelve sin lanzar excepción', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: { secretario: { nombre: 'José Salinas', rut: '9.492.569-K', n_socio: '123', telefono: '+56992737313', correo: 'j@x.cl' } }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });

    test('cartilla histórica SIN respuestas_json.secretario, solo columnas antiguas -> usa el respaldo, no lanza excepción', async () => {
        const cartilla = { ...CARTILLA_BASE, respuestas_json: {} };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });
});

describe('generarCartillaDelegadoPDF — Veterinario/Técnico (nombre y rut, encabezado)', () => {
    test('informe_veterinario con rut nuevo -> resuelve sin lanzar excepción', async () => {
        const cartilla = { ...CARTILLA_BASE, respuestas_json: { informe_veterinario: { nombre: 'Marcelo Vásquez', rut: '11.111.111-1' } } };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
    });
});

describe('generarCartillaDelegadoPDF — II. Reemplazo de Jinetes (campos reales nombre_reemplazado/nombre_reemplazante)', () => {
    test('items con la estructura real del formulario -> resuelve sin lanzar excepción', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                reemplazo_jinetes: {
                    hubo: 'si',
                    items: [{ nombre_reemplazado: 'Patricio Andrade', rut_reemplazado: '9.311.411-6', nombre_reemplazante: 'Eduardo Casado', rut_reemplazante: '15.978.339-1', motivo: 'Accidente', serie: 'Campeones', detalle: 'Dolor en pierna', observaciones: '' }]
                }
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });
});

describe('generarCartillaDelegadoPDF — III. Informe de accidentes (unificado, columnas nuevas + formato anterior)', () => {
    test('accidente con columnas nuevas (serie/animal/collera/accidentado) -> resuelve sin lanzar excepción', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                accidentes_informe: {
                    hubo_accidentes: 'si', medico_nombre: 'José Carrasco', medico_telefono: '+56961321576',
                    items: [{ serie: 'Criaderos', animal: '1er Animal', collera: '9', accidentado: 'Jose Pablo Molina', rut_socio: '23.088.073-5, N° 49699-5', asociacion_club: 'Asoc. Concepción, Club Florida', detalle_hechos: 'Accidente en tercera atajada', consecuencia: 'Sin consecuencias graves, sigue participando' }]
                }
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });

    test('accidente en formato anterior (tipo/persona/categoria/descripcion) -> resuelve sin lanzar excepción, no se pierde el registro histórico', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                accidentes_informe: {
                    hubo_accidentes: 'si',
                    items: [{ tipo: 'Leve', persona: 'Juan Pérez', rut: '11.111.111-1', categoria: 'Jinete', descripcion: 'Caída leve', atencion: 'Revisión en box', observaciones: 'Sin gravedad' }]
                }
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });

    test('solo relato general histórico (informe_accidentes_general), sin accidentes_informe -> resuelve sin lanzar excepción', async () => {
        const cartilla = { ...CARTILLA_BASE, respuestas_json: { informe_accidentes_general: 'Relato histórico de accidentes.' } };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
    });
});

describe('generarCartillaDelegadoPDF — IV. Desempeño del Jurado (aspecto 4 sin "cuarta carrera")', () => {
    test('4 aspectos completos -> resuelve sin lanzar excepción', async () => {
        const cartilla = { ...CARTILLA_BASE, respuestas_json: { desempeno_jurado: { aspecto_1: 6, aspecto_2: 5, aspecto_3: 7, aspecto_4: 6, nota_promedio: 6 } } };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
    });
});

describe('generarCartillaDelegadoPDF — V. Situaciones a revisar (máximo 3, nueva)', () => {
    test('3 situaciones con Serie/Animal/Collera -> resuelve sin lanzar excepción', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                situaciones_revisar: {
                    items: [
                        { serie: 'Criaderos', animal: '1º animal', collera: '8', detalle: 'No se computa corte de línea de sentencia.' },
                        { serie: '2ª Serie Libre', animal: '2º animal', collera: '11', detalle: 'Mala entrega en circunstancias que novillo había caído.' },
                        { serie: 'Campeones', animal: '4º animal', collera: '23', detalle: 'Se pagan 4 puntos por atajada no definida.' }
                    ]
                }
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });

    test('sin situaciones_revisar (cartilla histórica) -> resuelve sin lanzar excepción', async () => {
        const cartilla = { ...CARTILLA_BASE, respuestas_json: {} };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
    });
});

describe('generarCartillaDelegadoPDF — VI. Disciplina y antecedentes disciplinarios complementarios (unificado)', () => {
    test('situación disciplinaria con campos reales (nombre_infractor/rut/num_socio/tipo_falta/articulo) + antecedentes complementarios -> resuelve sin lanzar excepción', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                disciplina_informe: { hubo_informe: 'si', situaciones: [{ nombre_infractor: 'Juan Pérez', rut: '11.111.111-1', num_socio: '999', tipo_falta: 'Reglamentaria', articulo: '45', testigos: 'Pedro', detalle: 'Detalle de los hechos', observaciones: 'Obs' }] },
                antecedentes_disciplinarios: { texto: 'Antecedente complementario de prueba.' }
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });
});

// MEJORA 1 — "Serie en que ocurrió la situación" dentro del registro
// disciplinario del PDF oficial. Usa textoVisiblePDF (definido más abajo en
// este mismo archivo) para verificar el texto REAL renderizado, no solo
// "resuelve sin lanzar excepción".
describe('generarCartillaDelegadoPDF — VI. Disciplina: Serie en que ocurrió la situación (MEJORA 1)', () => {
    test('situación con serie informada -> el PDF muestra "Serie: <nombre>" en el registro', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                disciplina_informe: { hubo_informe: 'si', situaciones: [{ serie: 'Criaderos', nombre_infractor: 'Juan Pérez', rut: '1-9', num_socio: '1', tipo_falta: 'Reglamentaria', articulo: '45' }] }
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        const texto = textoVisiblePDF(buffer);
        expect(texto).toContain('1. Serie: Criaderos — Juan Pérez');
    });

    test('situación histórica sin el campo serie -> el PDF muestra "Serie: No informado" (nunca inventa una serie ni la omite)', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                disciplina_informe: { hubo_informe: 'si', situaciones: [{ nombre_infractor: 'Juan Pérez', rut: '1-9', num_socio: '1', tipo_falta: 'Reglamentaria', articulo: '45' }] }
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        const texto = textoVisiblePDF(buffer);
        expect(texto).toContain('1. Serie: No informado — Juan Pérez');
    });

    test('dos situaciones con series distintas -> cada una muestra su propia serie, nunca la misma para ambas', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                disciplina_informe: {
                    hubo_informe: 'si',
                    situaciones: [
                        { serie: 'Criaderos', nombre_infractor: 'Uno', rut: '1-9', num_socio: '1', tipo_falta: 'A', articulo: '1' },
                        { serie: 'Campeones', nombre_infractor: 'Dos', rut: '2-7', num_socio: '2', tipo_falta: 'B', articulo: '2' }
                    ]
                }
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        const texto = textoVisiblePDF(buffer);
        expect(texto).toContain('1. Serie: Criaderos — Uno');
        expect(texto).toContain('2. Serie: Campeones — Dos');
    });
});

describe('generarCartillaDelegadoPDF — VIII. Colleras invitadas (campos reales jinete1/jinete2/club/asociacion)', () => {
    test('items con la estructura real del formulario -> resuelve sin lanzar excepción', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: { colleras_invitadas: { no_hubo: false, items: [{ jinete1: 'Alberto Herrera', jinete2: 'Pablo Pino', club: 'Las Cabras', asociacion: "Asoc. O'Higgins", observaciones: '' }] } }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });
});

describe('generarCartillaDelegadoPDF — IX. Bienestar Animal unificado (delegado/veterinario)', () => {
    test('solo bienestar_animal (cartilla nueva, formato unificado) -> resuelve sin lanzar excepción', async () => {
        const cartilla = { ...CARTILLA_BASE, respuestas_json: { bienestar_animal: { sombra_ganado: 'si', agua_ganado: 'no', agua_ganado_obs: 'Sin agua' } } };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
    });

    test('bienestar_animal + informe_veterinario con respuesta propia (cartilla histórica dual) -> ambos se muestran, no lanza excepción', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                bienestar_animal: { sombra_ganado: 'si' },
                informe_veterinario: { nombre: 'Vet X', sombra_ganado: 'no', sombra_ganado_obs: 'Respuesta distinta del veterinario' }
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
    });
});

describe('generarCartillaDelegadoPDF — X. Reclamos (campos reales nombre/rut/detalle/respuesta)', () => {
    test('reclamo con la estructura real del formulario -> resuelve sin lanzar excepción', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: { reclamos_sugerencias: { hubo_reclamos: 'si', items: [{ nombre: 'Juan', rut: '1-9', tipo: 'Conducta', detalle: 'Detalle', respuesta: 'Respuesta', observaciones: 'Obs' }] } }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });
});

describe('generarCartillaDelegadoPDF — cartilla vacía (mínima) -> no lanza excepción', () => {
    test('respuestas_json = {} -> resuelve sin lanzar excepción', async () => {
        const cartilla = { ...CARTILLA_BASE, respuestas_json: {} };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// AUDITORÍA CONTRA LA VERSIÓN FINAL — "Calidad de ganado: Muy bueno" y
// campo "Público" (histórico vs. nuevas cartillas)
// ═════════════════════════════════════════════════════════════════════════
describe('generarCartillaDelegadoPDF — Calidad de ganado "Muy bueno"', () => {
    test('serie con q1k = "Muy bueno" -> resuelve sin lanzar excepción', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: { ganado_series: [{ nombre: 'Campeones', c1n: '5', c1g: '24', q1k: 'Muy bueno' }] }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });
});

describe('generarCartillaDelegadoPDF — campo Público (retirado de nuevas cartillas, preservado como histórico)', () => {
    test('publico_serie_campeones presente (cartilla histórica) -> se imprime como dato histórico, no lanza excepción', async () => {
        const cartilla = { ...CARTILLA_BASE, publico_serie_campeones: 300, respuestas_json: {} };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
    });

    test('publico_serie_campeones ausente (cartilla nueva) -> no lanza excepción, no se inventa el dato', async () => {
        const cartilla = { ...CARTILLA_BASE, publico_serie_campeones: null, respuestas_json: {} };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// FASE 3.5 — Historial de Responsables de la Cartilla (bloque final, solo
// institucional). El proyecto no cuenta con extracción de texto de PDF (ver
// cabecera de este archivo), así que estos tests son de humo: verifican que
// el nuevo parámetro opcional nunca rompe la generación, ni para cartillas
// institucionales (con o sin eventos) ni para las de Delegado Rentado
// (donde el bloque nunca debe aparecer — aquí se confirma al menos que
// pasar historialResponsables por error no lanza excepción, dado que no hay
// forma de inspeccionar el texto renderizado).
describe('generarCartillaDelegadoPDF — Historial de Responsables (Fase 3.5)', () => {
    const CARTILLA_INSTITUCIONAL = { ...CARTILLA_BASE, delegado_asociacion_id: 'del-1' };

    test('cartilla institucional CON historialResponsables -> resuelve sin lanzar excepción', async () => {
        const historialResponsables = [
            { accion: 'confirmar_responsable_institucional', descripcion: 'Delegado de Asociación confirmado como responsable: Juan Pérez', created_at: '2026-01-01T12:00:00Z' },
            { accion: 'reemplazar_responsable_institucional', descripcion: 'Reemplazo de responsable autorizado — motivo: Juan no puede continuar', created_at: '2026-01-10T09:00:00Z' }
        ];
        const buffer = await generarCartillaDelegadoPDF(CARTILLA_INSTITUCIONAL, RODEO, { historialResponsables });
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.length).toBeGreaterThan(0);
    });

    test('cartilla institucional SIN eventos (historialResponsables=[]) -> resuelve sin lanzar excepción, nunca fabrica un evento', async () => {
        const buffer = await generarCartillaDelegadoPDF(CARTILLA_INSTITUCIONAL, RODEO, { historialResponsables: [] });
        expect(Buffer.isBuffer(buffer)).toBe(true);
    });

    test('cartilla institucional sin pasar el parámetro opciones -> resuelve sin lanzar excepción (compatibilidad hacia atrás)', async () => {
        const buffer = await generarCartillaDelegadoPDF(CARTILLA_INSTITUCIONAL, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
    });

    test('cartilla de Delegado Rentado (delegado_asociacion_id null/ausente) -> resuelve sin lanzar excepción, igual que antes de la Fase 3.5', async () => {
        const cartillaRentado = { ...CARTILLA_BASE, delegado_asociacion_id: null };
        const buffer = await generarCartillaDelegadoPDF(cartillaRentado, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
    });

    test('evento con accion desconocida (fuera del mapa de etiquetas) -> no lanza excepción, nunca oculta el evento', async () => {
        const buffer = await generarCartillaDelegadoPDF(CARTILLA_INSTITUCIONAL, RODEO, {
            historialResponsables: [{ accion: 'accion_no_mapeada', created_at: '2026-01-01T12:00:00Z' }]
        });
        expect(Buffer.isBuffer(buffer)).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// TABLA DE GANADO — verificación de TEXTO REAL, no solo del Buffer (revisión
// del usuario, Nov-2026). El encabezado de este archivo explica por qué el
// resto de los tests son de humo (no hay librería de extracción de texto en
// el proyecto); para el requisito explícito de "cero real vs. ausencia de
// dato" eso no basta, así que estos tests decodifican el PDF real: inflan
// los content streams (FlateDecode) y leen los hex strings de los
// operadores Tj/TJ — para Helvetica/Helvetica-Bold (las únicas fuentes
// usadas en todo el documento) esa codificación es 1 byte = 1 carácter
// WinAnsi/Latin1, así que el texto decodificado es el texto real dibujado.
// No es una librería nueva ni una dependencia: es un decodificador mínimo,
// solo para este archivo de test.
const zlib = require('zlib');
// WinAnsiEncoding (== CP1252) difiere de Latin-1 solo en el rango 0x80-0x9F
// (comillas tipográficas, guiones en/em, etc.) — fuera de ese rango,
// codepoint = byte. Sin este mapa, el guion largo "—" (byte 0x97, usado en
// TODO el documento para los valores "sin dato") decodificaría como el
// carácter de control U+0097 en vez de U+2014, y los asserts de este
// archivo nunca encontrarían el '—' real que el PDF efectivamente dibuja.
const CP1252_0x80_0x9F = {
    0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…',
    0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8A: 'Š',
    0x8B: '‹', 0x8C: 'Œ', 0x8E: 'Ž', 0x91: '‘', 0x92: '’',
    0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
    0x98: '˜', 0x99: '™', 0x9A: 'š', 0x9B: '›', 0x9C: 'œ',
    0x9E: 'ž', 0x9F: 'Ÿ'
};
function textoVisiblePDF(buffer) {
    const txt = buffer.toString('latin1');
    const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let m, salida = '';
    while ((m = streamRe.exec(txt))) {
        let contenido;
        try { contenido = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); }
        catch (e) { continue; }
        const tokenRe = /<([0-9A-Fa-f]+)>/g;
        let t;
        while ((t = tokenRe.exec(contenido))) {
            const hex = t[1];
            for (let i = 0; i < hex.length; i += 2) {
                const byte = parseInt(hex.substr(i, 2), 16);
                salida += CP1252_0x80_0x9F[byte] || String.fromCharCode(byte);
            }
        }
        salida += '\n';
    }
    return salida;
}

// Nota sobre las aserciones: `textoVisiblePDF` concatena TODO el texto de
// cada celda sin separadores (así dibuja pdfkit: cada celda es un `.text()`
// independiente) — primero las 5 celdas del ENCABEZADO de la tabla
// seguidas, después las 5 celdas de la fila de VALORES seguidas. Por eso se
// compara el bloque exacto "encabezados + valores", no una cercanía
// aproximada entre una etiqueta y su valor.
describe('generarCartillaDelegadoPDF — resumen de Serie: cero real vs. ausencia de dato (revisión del usuario)', () => {
    test('un animal con # Ganado=0 y Bajo/sobrepeso=0 realmente ingresados -> el resumen muestra "0" (nunca "—"), aunque los otros 3 animales no tengan datos', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: { ganado_series: [{ nombre: 'Serie X', c1g: 0, f1c: 0, c2g: '', f2c: '', c3g: '', f3c: '', c4g: '', f4c: '' }] }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        const texto = textoVisiblePDF(buffer);
        // Total ganado utilizado=0, Total fuera de peso=0 (ambos datos reales,
        // c1g/f1c=0) — ganado total es 0 así que el % no se puede calcular -> '—'.
        expect(texto).toContain('Total ganado utilizadoTotal fuera de peso% fuera de peso00—');
    });

    test('ningún animal con # Ganado ni Bajo/sobrepeso ingresados -> el resumen muestra "—" en ambos (nunca un 0 inventado)', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: { ganado_series: [{ nombre: 'Serie Y', c1g: '', f1c: '', c2g: null, f2c: null, c3g: undefined, f3c: undefined, c4g: '', f4c: '' }] }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        const texto = textoVisiblePDF(buffer);
        expect(texto).toContain('Total ganado utilizadoTotal fuera de peso% fuera de peso———');
    });

    test('formato anterior — fp_baj=0 ingresado pero fp_sob nunca ingresado -> "Bajo peso"="0" (real), "Sobre peso"="—" (sin dato), "Total fuera de peso" usa el 0 real (no "—")', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: { ganado_series: [{ nombre: 'Serie Legacy', fp_tot: 20, fp_baj: 0 }] }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        const texto = textoVisiblePDF(buffer);
        // tot=20, baj=0 (real), sob='—' (sin dato), fuer=0 (real, porque baj SÍ
        // tiene dato), pct=0.0% (tot=20>0) -> "20" + "0" + "—" + "0" + "0.0%".
        expect(texto).toContain('Total ganado (Art. 242)Bajo pesoSobre pesoTotal fuera de peso% fuera de peso200—0');
    });
});

// ═════════════════════════════════════════════════════════════════════════
// MEJORA 1 (Nov-2026) — Colleras Invitadas como TABLA institucional (ya no
// registros de texto uno debajo del otro). Verificación de TEXTO REAL
// (textoVisiblePDF, ver más arriba) — ocho o más colleras, nombres largos,
// observaciones particulares, y que las tablas de ganado permanecen 100%
// intactas (no se tocó cartillaDelegadoPdfTabla.js).
// ═════════════════════════════════════════════════════════════════════════
describe('generarCartillaDelegadoPDF — MEJORA 1: tabla de Colleras Invitadas', () => {
    function collera(i) {
        return { jinete1: `Jinete Uno N${i}`, jinete2: `Jinete Dos N${i}`, club: `Club N${i}`, asociacion: `Asociación N${i}` };
    }

    test('encabezado de la tabla (N°, Jinete 1, Jinete 2, Club, Asociación) aparece en el PDF', async () => {
        const cartilla = { ...CARTILLA_BASE, respuestas_json: { colleras_invitadas: { no_hubo: false, items: [collera(1)] } } };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        const texto = textoVisiblePDF(buffer);
        expect(texto).toContain('N°Jinete 1Jinete 2ClubAsociación');
    });

    test('ocho colleras invitadas -> las ocho aparecen en el texto real del PDF, ninguna se pierde', async () => {
        const items = Array.from({ length: 8 }, (_, i) => collera(i + 1));
        const cartilla = { ...CARTILLA_BASE, respuestas_json: { colleras_invitadas: { no_hubo: false, items } } };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        const texto = textoVisiblePDF(buffer);
        for (let i = 1; i <= 8; i++) {
            expect(texto).toContain(`Jinete Uno N${i}`);
            expect(texto).toContain(`Club N${i}`);
            expect(texto).toContain(`Asociación N${i}`);
        }
    });

    test('nombre largo de club/asociación se conserva completo (ajuste automático, nunca se corta)', async () => {
        const nombreLargo = 'Asociación de Rodeo y Tradición Campesina de la Zona Centro Sur de Chile';
        const cartilla = { ...CARTILLA_BASE, respuestas_json: { colleras_invitadas: { no_hubo: false, items: [{ jinete1: 'Juan', jinete2: 'Pedro', club: 'Club X', asociacion: nombreLargo }] } } };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        const texto = textoVisiblePDF(buffer);
        expect(texto).toContain(nombreLargo);
    });

    test('observaciones particulares de una collera se conservan, asociadas a su número (fila adicional legible, nunca se pierden)', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                colleras_invitadas: {
                    no_hubo: false,
                    items: [
                        { jinete1: 'Juan', jinete2: 'Pedro', club: 'Club A', asociacion: 'Asoc A' },
                        { jinete1: 'Luis', jinete2: 'Ana', club: 'Club B', asociacion: 'Asoc B', observaciones: 'Collera invitada de otra región, con autorización especial.' }
                    ]
                }
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        const texto = textoVisiblePDF(buffer);
        expect(texto).toContain('Observaciones por collera');
        expect(texto).toContain('COLLERA N° 2');
        expect(texto).toContain('Collera invitada de otra región, con autorización especial.');
    });

    test('sin colleras invitadas (no_hubo=true) -> mantiene la indicación, nunca dibuja una tabla vacía', async () => {
        const cartilla = { ...CARTILLA_BASE, respuestas_json: { colleras_invitadas: { no_hubo: true, items: [] } } };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        const texto = textoVisiblePDF(buffer);
        expect(texto).toContain('SIN COLLERAS INVITADASSí');
        expect(texto).not.toContain('N°Jinete 1Jinete 2ClubAsociación');
    });

    test('las tablas de ganado permanecen intactas (mismo encabezado azul, sin cambios) junto con la nueva tabla de colleras', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                ganado_series: [{ nombre: 'Serie Única', c1n: 1, c1g: 25, v1v: 3, v1t: 'Overo', v1p: 420, q1c: 2, q1r: 0, q1k: 'Bueno', f1c: 2 }],
                colleras_invitadas: { no_hubo: false, items: [collera(1)] }
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        const texto = textoVisiblePDF(buffer);
        expect(texto).toContain('AnimalN° colleras# GanadoVueltasTipoPeso (kg)CorridoRepetidoCalidadBajo/sobrepesoPorcentaje');
        expect(texto).toContain('N°Jinete 1Jinete 2ClubAsociación');
    });
});

// ═════════════════════════════════════════════════════════════════════════
// MEJORA 4 (Nov-2026) — "Corre por los premios" / "Deja puntos para la
// próxima temporada": pregunta Sí/No/No informado + tabla de 9 campos,
// completamente independientes entre sí y de Colleras Invitadas.
// ═════════════════════════════════════════════════════════════════════════
describe('generarCartillaDelegadoPDF — MEJORA 4: Corre por los premios / Deja puntos temporada', () => {
    function collera9(sufijo) {
        return {
            rut1: '11.111.111-1', nombre1: `Jinete Uno ${sufijo}`,
            rut2: '7.654.321-6', nombre2: `Jinete Dos ${sufijo}`,
            num_caballo1: '12', nombre_caballo1: `Caballo Uno ${sufijo}`,
            num_caballo2: '7', nombre_caballo2: `Caballo Dos ${sufijo}`,
            lugar: '1°'
        };
    }

    test('cartilla histórica SIN estas preguntas -> "No informado" para ambas, nunca "No" asumido, nunca dibuja tabla', async () => {
        const cartilla = { ...CARTILLA_BASE, respuestas_json: {} };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        const texto = textoVisiblePDF(buffer);
        expect(texto).toContain('¿HAY COLLERAS QUE CORREN POR LOS PREMIOS?No informado');
        expect(texto).toContain('¿EL RODEO DEJA PUNTOS PARA LA PRÓXIMA TEMPORADA?No informado');
        expect(texto).not.toContain('CaballoLugar'); // ningún encabezado de tabla se dibuja
    });

    test('respuesta explícita "No" -> muestra "No" (nunca se confunde con "No informado")', async () => {
        const cartilla = { ...CARTILLA_BASE, respuestas_json: { corre_premios: { respuesta: 'no', items: [] } } };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        const texto = textoVisiblePDF(buffer);
        expect(texto).toContain('¿HAY COLLERAS QUE CORREN POR LOS PREMIOS?No');
        expect(texto).not.toContain('¿HAY COLLERAS QUE CORREN POR LOS PREMIOS?No informado');
    });

    test('"Sí" en Premios con colleras -> tabla con los 6 encabezados agrupados y el contenido real', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: { corre_premios: { respuesta: 'si', items: [collera9('P1')] } }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        const texto = textoVisiblePDF(buffer);
        expect(texto).toContain('N°Jinete 1Jinete 2Caballo 1Caballo 2Lugar');
        expect(texto).toContain('Jinete Uno P1');
        expect(texto).toContain('11.111.111-1');
        expect(texto).toContain('Caballo Uno P1');
    });

    test('INDEPENDENCIA TOTAL (Regla D): Premios con colleras A/B/C y Puntos con colleras D/E — nunca se mezclan ni se copian entre sí', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                corre_premios:         { respuesta: 'si', items: [collera9('PREMIO_A'), collera9('PREMIO_B'), collera9('PREMIO_C')] },
                deja_puntos_temporada: { respuesta: 'si', items: [collera9('PUNTOS_D'), collera9('PUNTOS_E')] }
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        const texto = textoVisiblePDF(buffer);
        // Las 3 de premios y las 2 de puntos están TODAS presentes.
        ['PREMIO_A', 'PREMIO_B', 'PREMIO_C'].forEach(s => expect(texto).toContain(`Jinete Uno ${s}`));
        ['PUNTOS_D', 'PUNTOS_E'].forEach(s => expect(texto).toContain(`Jinete Uno ${s}`));
        // Ninguna de premios aparece mezclada como si fuera de puntos (ni viceversa) —
        // cada colección tiene exactamente su propia cantidad de filas, nunca una copia cruzada.
        const vecesTotal = (texto.match(/Jinete Uno (PREMIO_[ABC]|PUNTOS_[DE])/g) || []).length;
        expect(vecesTotal).toBe(5); // 3 + 2, cada una UNA sola vez — ninguna duplicada entre secciones
    });

    test('una collera puede coincidir en ambas secciones (ejemplo del pedido) sin romper nada', async () => {
        const colleraCompartida = collera9('COMPARTIDA');
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                corre_premios:         { respuesta: 'si', items: [colleraCompartida] },
                deja_puntos_temporada: { respuesta: 'si', items: [colleraCompartida] }
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        const texto = textoVisiblePDF(buffer);
        const veces = (texto.match(/Jinete Uno COMPARTIDA/g) || []).length;
        expect(veces).toBe(2); // aparece una vez en cada sección, independientemente
    });

    test('Premios="Sí" pero Puntos="No" -> solo la tabla de Premios se dibuja (comportamiento condicional, caso Sí/No)', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                corre_premios:         { respuesta: 'si', items: [collera9('UNICA')] },
                deja_puntos_temporada: { respuesta: 'no', items: [] }
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        const texto = textoVisiblePDF(buffer);
        expect(texto).toContain('Jinete Uno UNICA');
        expect(texto).toContain('¿EL RODEO DEJA PUNTOS PARA LA PRÓXIMA TEMPORADA?No');
    });

    test('"Sí" sin colleras registradas (borrador incompleto) -> nunca lanza excepción, muestra aviso en vez de tabla vacía', async () => {
        const cartilla = { ...CARTILLA_BASE, respuestas_json: { corre_premios: { respuesta: 'si', items: [] } } };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        const texto = textoVisiblePDF(buffer);
        expect(texto).toContain('Sin colleras registradas.');
    });

    test('se mantiene el logo, el encabezado institucional y la paginación — el PDF sigue siendo válido y completo con las secciones nuevas', async () => {
        const cartilla = {
            ...CARTILLA_BASE,
            respuestas_json: {
                ganado_series: [{ nombre: 'Serie Única', c1n: 1, c1g: 25, v1v: 3, v1t: 'Overo', v1p: 420, q1c: 2, q1r: 0, q1k: 'Bueno', f1c: 2 }],
                corre_premios: { respuesta: 'si', items: [collera9('X')] },
                deja_puntos_temporada: { respuesta: 'si', items: [collera9('Y')] }
            }
        };
        const buffer = await generarCartillaDelegadoPDF(cartilla, RODEO);
        expect(Buffer.isBuffer(buffer)).toBe(true);
        const texto = textoVisiblePDF(buffer);
        expect(texto).toContain('Federación de Rodeo Chileno');
        expect(texto).toContain('COLLERAS QUE CORREN POR LOS PREMIOS');
        expect(texto).toContain('COLLERAS QUE DEJAN PUNTOS PARA LA PRÓXIMA TEMPORADA');
    });
});
