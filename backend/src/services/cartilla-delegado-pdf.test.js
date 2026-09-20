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
